import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { retryableFile, unsupportedFile } from './errors';
import { detectQuarterTurn, detectSheetBox, detectSkew, type GreyImage } from './layout';
import { rasterizePdf } from './pdf';
import { assertBinaryPresent, runLimited } from './subprocess';

/**
 * Подготовка скана: из файла, приложенного к заявке, — страницы, годные для модели
 * (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р9, Р10).
 *
 * Два правила задают здесь всё.
 *
 * **Файл — враждебный** (Р9). Не потому, что бухгалтерия злонамеренна, а потому, что приложить к
 * заявке можно что угодно, и разбирает это тот же процесс, который держит арендованные задачи
 * очереди. Поэтому: тип определяется по **сигнатуре**, а не по `content_type` из формы (его пишет
 * браузер, и он же первым врёт); заявленные размеры проверяются **до** декодирования, иначе
 * PNG на сорок килобайт разворачивается в двадцать гигабайт памяти; PDF растеризуется отдельным
 * процессом (`pdf.ts`). Непрошедшее получает `unsupported` с причиной и уходит человеку, **не
 * потратив ни копейки** на модель.
 *
 * **Файл отвечает за обработку, страница — за распознавание** (Р10). Поэтому на выходе не «одна
 * картинка», а массив страниц, и у каждой свой `sha256` — хэш **растра страницы**, не файла.
 * Разница не формальная: хэш всего PDF не узнает страницу, вложенную в другой PDF, а именно так
 * выглядит повторное предъявление бумаги, когда бухгалтерия сканирует пачкой на МФУ. На этом хэше
 * стоят и кэш попыток (Р12), и проверка «этот талон уже предъявляли» (Р17), — то есть деньги и
 * первая из четырёх проверок сверки.
 *
 * Порядок операций — из Р9 и он же зафиксирован `PREPROCESSING_VERSION`: автоповорот (EXIF, иначе
 * по ориентации строк), deskew, обрезка по контуру листа без шаблонов, ресайз до `maxEdgePx`.
 * Сначала геометрия, потом размер: обрезать после ресайза значит выбросить пиксели, за которые
 * уже заплачено разрешением.
 */

/**
 * Версия предобработки — часть ключа кэша попыток (Р12: `page_sha256 + engine + model +
 * prompt_version + preprocessing_version`).
 *
 * Число меняется при **любом** изменении, после которого из того же файла получится другой растр:
 * другой порядок шагов, другое качество JPEG, другой порог обрезки, другое направление поворота.
 * Не поменять его — значит склеить в кэше ответы, полученные по разным картинкам, и получить
 * «перераспознали, а результат прежний» (Р13). Поменять лишний раз — это оплаченный заново проход
 * по всем страницам, не более того; ошибка в эту сторону дешевле.
 */
export const PREPROCESSING_VERSION = 1;

/** Что нам приложили. `heif` — это и HEIC с телефона, и AVIF: контейнер один, кодеки разные. */
export type TicketSourceKind = 'jpeg' | 'png' | 'webp' | 'heif' | 'pdf';

export interface DetectedFileType {
  kind: TicketSourceKind | 'unsupported';
  /** Как называть найденное человеку: «GIF», «архив ZIP», «неизвестный формат». */
  label: string;
}

/** Страница, готовая к отправке в модель. */
export interface PreparedPage {
  /** Номер страницы в файле, с единицы: он же `waste_ticket_pages.page_no`. */
  pageNo: number;
  buffer: Buffer;
  mediaType: 'image/jpeg';
  /** `page_sha256` — хэш **этого растра**, а не исходного файла (Р10). */
  sha256: string;
  width: number;
  height: number;
}

export interface PreparedFile {
  sourceKind: TicketSourceKind;
  /** Сколько страниц в файле всего. */
  totalPages: number;
  /** Разобранные страницы — не больше `maxPages`. */
  pages: PreparedPage[];
  /**
   * Сколько страниц осталось за лимитом: «в файле 6 страниц, обработано 5 (лимит)» (Р10).
   * Что сверх лимита — **помечается в интерфейсе, а не теряется молча**.
   */
  skippedPages: number;
  preprocessingVersion: number;
}

export interface PreprocessOptions {
  /** `TICKET_OCR_MAX_PAGES`, по умолчанию 5 (решение заказчика В7). */
  maxPages: number;
  /** `TICKET_OCR_MAX_EDGE_PX`: длинная сторона растра, уезжающего в модель. */
  maxEdgePx: number;
  /** Потолок размера файла; по умолчанию тот же, что у вложения заявки (ADR 0024) — 50 МБ. */
  maxBytes?: number;
  /** Потолок **заявленных** пикселей: проверяется до декодирования (архивная бомба). */
  maxPixels?: number;
  pdfTimeoutMs?: number;
  pdfMemoryMb?: number;
  /** Конвертер HEIC на случай, когда сборка libvips без декодера HEVC (см. `decodeHeif`). */
  heifConvertBin?: string;
  tmpDir?: string;
  /** Шаги геометрии выключаются поштучно — тестам нужен предсказуемый растр, а не «как красивее». */
  autoOrient?: boolean;
  deskew?: boolean;
  crop?: boolean;
  jpegQuality?: number;
}

interface ResolvedOptions extends Required<Omit<PreprocessOptions, 'tmpDir' | 'heifConvertBin'>> {
  tmpDir: string | undefined;
  heifConvertBin: string | undefined;
}

/** Вложение заявки ограничено 50 МБ (ADR 0024) — больше сюда не приезжает и приезжать не должно. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/**
 * Потолок заявленных пикселей. Сорок мегапикселей — это A4 при 600 dpi с запасом, то есть заведомо
 * больше всего, что делает сканер бухгалтерии; в памяти это ~120 МБ на канал-в-три-байта, что
 * процесс переживает. Всё, что больше, — либо чертёж, либо бомба, и разбирать оба не нужно.
 */
const DEFAULT_MAX_PIXELS = 40_000_000;
const DEFAULT_PDF_TIMEOUT_MS = 60_000;
const DEFAULT_PDF_MEMORY_MB = 2048;
/**
 * Качество JPEG. За пиксели платят токенами, но экономить на них нечем: рукописная цифра объёма и
 * так на грани читаемости, а `4:4:4` без прореживания цветности оставляет тонкие штрихи штрихами.
 */
const DEFAULT_JPEG_QUALITY = 82;
/**
 * Размер картинки, на которой считается геометрия. Восемьсот точек по длинной стороне — это уже
 * различимые строки текста и в тридцать раз меньше работы, чем анализ полного растра; точность
 * угла от полного разрешения не растёт, потому что профиль проекции всё равно усредняет.
 */
const ANALYSIS_EDGE = 800;

function resolveOptions(opts: PreprocessOptions): ResolvedOptions {
  return {
    maxPages: Math.max(1, Math.floor(opts.maxPages)),
    maxEdgePx: Math.max(256, Math.floor(opts.maxEdgePx)),
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxPixels: opts.maxPixels ?? DEFAULT_MAX_PIXELS,
    pdfTimeoutMs: opts.pdfTimeoutMs ?? DEFAULT_PDF_TIMEOUT_MS,
    pdfMemoryMb: opts.pdfMemoryMb ?? DEFAULT_PDF_MEMORY_MB,
    heifConvertBin: opts.heifConvertBin,
    tmpDir: opts.tmpDir,
    autoOrient: opts.autoOrient ?? true,
    deskew: opts.deskew ?? true,
    crop: opts.crop ?? true,
    jpegQuality: opts.jpegQuality ?? DEFAULT_JPEG_QUALITY,
  };
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('latin1');
}

/**
 * Тип файла по сигнатуре (Р9). **Не** по `content_type`: его присылает браузер по расширению, и
 * `photo.jpg`, внутри которого ZIP, приехал бы к декодеру как изображение.
 *
 * Знакомые, но негодные форматы названы поимённо не для полноты, а ради текста на экране: «это
 * файл TIFF, приложите JPEG или PDF» — действие, а «формат не поддерживается» — тупик. TIFF в этом
 * списке потому, что им по умолчанию сохраняет добрая половина сканеров, и увидим мы его первым.
 */
export function detectFileType(buf: Buffer): DetectedFileType {
  if (buf.length === 0) return { kind: 'unsupported', label: 'пустой файл' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kind: 'jpeg', label: 'JPEG' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'png', label: 'PNG' };
  }
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') {
    return { kind: 'webp', label: 'WebP' };
  }
  // HEIF/HEIC/AVIF: контейнер ISO-BMFF, тип лежит в боксе `ftyp` со смещения 4.
  if (ascii(buf, 4, 4) === 'ftyp') {
    const brand = ascii(buf, 8, 4);
    const heifBrands = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif'];
    if (heifBrands.includes(brand))
      return { kind: 'heif', label: brand === 'avif' ? 'AVIF' : 'HEIC' };
    return { kind: 'unsupported', label: 'видео или иной контейнер MP4' };
  }
  /*
   * PDF ищется не строго с нулевого байта: спецификация требует заголовка в начале, но почта и
   * МФУ приписывают перед ним свой мусор, а poppler такие файлы открывает. Отвергнуть их значило
   * бы отправить человека на ручной ввод из-за лишнего байта, которого он не видит.
   */
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return { kind: 'pdf', label: 'PDF' };

  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { kind: 'unsupported', label: 'GIF' };
  if (startsWith(buf, [0x42, 0x4d])) return { kind: 'unsupported', label: 'BMP' };
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: 'unsupported', label: 'TIFF' };
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    return { kind: 'unsupported', label: 'архив ZIP или документ Office' };
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0])) {
    return { kind: 'unsupported', label: 'документ Word или Excel' };
  }
  if (startsWith(buf, [0x52, 0x61, 0x72, 0x21])) return { kind: 'unsupported', label: 'архив RAR' };
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf])) return { kind: 'unsupported', label: 'архив 7z' };
  return { kind: 'unsupported', label: 'неизвестный формат' };
}

/** Общие для всех вызовов `sharp` настройки чтения — и первая линия защиты от бомбы. */
function sourceOptions(opts: ResolvedOptions) {
  return {
    // Второй рубеж после явной проверки метаданных: сюда упрётся файл, совравший в заголовке.
    limitInputPixels: opts.maxPixels,
    sequentialRead: true,
    // `failOn: 'error'` вместо строгого умолчания: настоящие сканы полны предупреждений
    // (обрезанный EXIF, нестандартный ICC), и отвергать их — это отвергать нормальную работу.
    failOn: 'error' as const,
  };
}

/** Серая матрица уменьшенной копии — то, на чём считается геометрия. */
/** Сырой растр в том виде, в каком его принимает `sharp`: число каналов там перечислением. */
interface RawImage {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

async function analysisMatrix(data: Buffer, raw: RawImage): Promise<GreyImage> {
  const out = await sharp(data, { raw })
    .resize({
      width: ANALYSIS_EDGE,
      height: ANALYSIS_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(out.data), width: out.info.width, height: out.info.height };
}

/** Поворот серой матрицы на четверть — в JS, потому что матрица уже крошечная. */
function rotateGrey90(img: GreyImage): GreyImage {
  const { data, width, height } = img;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // по часовой: столбец становится строкой, отсчёт слева направо — снизу вверх
      out[x * height + (height - 1 - y)] = data[y * width + x]!;
    }
  }
  return { data: out, width: height, height: width };
}

/**
 * HEIC → JPEG.
 *
 * Отдельной функцией потому, что путь тут не один. Сборка libvips, с которой приезжает `sharp`,
 * контейнер HEIF читает, но декодер в ней только AV1: снимок с айфона (кодек HEVC) она открыть не
 * может и честно отвечает «no decoder for this image format». Поэтому сначала пробуем `sharp` —
 * им читается AVIF и HEIF, собранные не Apple, — а при отказе зовём внешний конвертер, если он
 * назван в конфигурации (`heif-convert` из libheif-examples в образе воркера).
 *
 * Когда не вышло ни то ни другое, файл получает `unsupported` с внятным действием: снимок с
 * телефона переснять нечем, зато «поделиться как JPEG» умеет любой телефон.
 */
async function decodeHeif(input: Buffer, opts: ResolvedOptions): Promise<Buffer> {
  try {
    return await sharp(input, sourceOptions(opts)).jpeg({ quality: 95 }).toBuffer();
  } catch {
    // молчим намеренно: отказ ожидаем и обрабатывается ниже, а причина одна и та же на все случаи
  }
  const bin = opts.heifConvertBin;
  if (!bin) {
    throw unsupportedFile(
      'heic_unsupported',
      'Формат HEIC не поддерживается — сохраните снимок как JPEG или PDF и приложите заново.',
    );
  }
  const dir = await mkdtemp(join(opts.tmpDir ?? tmpdir(), 'ticket-heif-'));
  try {
    const src = join(dir, 'source.heic');
    const dst = join(dir, 'page.jpg');
    await writeFile(src, input, { mode: 0o600 });
    const res = await runLimited(bin, [src, dst], {
      timeoutMs: opts.pdfTimeoutMs,
      memoryMb: opts.pdfMemoryMb,
    });
    assertBinaryPresent(bin, res);
    if (res.timedOut) throw retryableFile('heic_timeout', 'HEIC не удалось преобразовать за срок.');
    if (res.code !== 0) {
      throw unsupportedFile(
        'heic_unsupported',
        'Формат HEIC не поддерживается — сохраните снимок как JPEG или PDF и приложите заново.',
      );
    }
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Один растр — в страницу для модели: EXIF-поворот, ориентация, deskew, обрезка, ресайз, хэш.
 *
 * Проходов по картинке три, и это не расточительность, а вынужденная развязка. `sharp` держит один
 * поворот на конвейер: вызов `rotate()` без аргумента (EXIF) и `rotate(угол)` затирают друг друга,
 * а обрезать надо **после** поворота — рамка листа до и после доворота это разные прямоугольники.
 * Поэтому: первый проход применяет EXIF и приводит картинку к рабочему размеру, второй доворачивает
 * на четверть плюс наклон **одним** вращением, третий режет и ужимает. Между проходами картинка
 * живёт сырыми пикселями, без перекодирования, — иначе каждый шаг подъедал бы качество JPEG.
 */
async function renderPage(
  raster: Buffer,
  pageNo: number,
  opts: ResolvedOptions,
): Promise<PreparedPage> {
  const src = sourceOptions(opts);

  let meta;
  try {
    /*
     * Метаданные читаются БЕЗ потолка пикселей — намеренно. Чтение заголовка ничего не декодирует,
     * а с потолком `sharp` отвечал бы на бомбу общей ошибкой «не читается», и отказ приезжал бы
     * человеку как «файл повреждён» вместо «изображение 60000×60000». Потолок остаётся там, где он
     * что-то значит, — на декодировании ниже.
     */
    meta = await sharp(raster, { ...src, limitInputPixels: false }).metadata();
  } catch (err) {
    throw unsupportedFile('broken_image', 'Изображение повреждено и не читается.', err);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1 || height < 1) {
    throw unsupportedFile('broken_image', 'Изображение повреждено и не читается.');
  }
  /*
   * Проверка ДО декодирования — тот самый пункт Р9 про архивную бомбу. Заголовок PNG на сорок
   * килобайт вправе объявить 60 000 × 60 000: это 3,6 миллиарда пикселей и десять с лишним
   * гигабайт в памяти. Заметить это после `toBuffer()` уже некому — процесс к тому моменту убит
   * ядром вместе со всеми арендованными задачами.
   */
  if (width * height > opts.maxPixels) {
    throw unsupportedFile(
      'image_too_large',
      `Изображение слишком большое: ${width}×${height} точек.`,
    );
  }

  /*
   * Рабочий размер — вдвое больше конечного. Полный растр держать незачем (страница всё равно
   * уедет ужатой до `maxEdgePx`), но и ужимать сразу нельзя: обрезка по контуру выбросит часть
   * кадра, и оставшемуся листу нужен запас разрешения, чтобы после неё дотянуть до `maxEdgePx`
   * без растягивания.
   */
  const workEdge = Math.min(Math.max(width, height), opts.maxEdgePx * 2);
  const base = await sharp(raster, src)
    .rotate() // только EXIF: съёмка телефоном пишет ориентацию в тег, а не в пиксели
    .resize({ width: workEdge, height: workEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // прозрачность PNG иначе станет чёрным полем
    .raw()
    .toBuffer({ resolveWithObject: true });
  const baseRaw: RawImage = {
    width: base.info.width,
    height: base.info.height,
    channels: base.info.channels as RawImage['channels'],
  };

  let quarterTurn: 0 | 90 = 0;
  let skew = 0;
  if (opts.autoOrient || opts.deskew) {
    const matrix = await analysisMatrix(base.data, baseRaw);
    if (opts.autoOrient) quarterTurn = detectQuarterTurn(matrix);
    // Наклон ищется уже в той ориентации, в которой страница уедет в модель: иначе завал в
    // полтора градуса у лежащего на боку кадра был бы найден по вертикали и применён по горизонтали.
    if (opts.deskew) skew = detectSkew(quarterTurn === 90 ? rotateGrey90(matrix) : matrix);
  }

  const angle = quarterTurn + skew;
  const rotated =
    angle === 0
      ? base
      : await sharp(base.data, { raw: baseRaw })
          .rotate(angle, { background: '#ffffff' })
          .raw()
          .toBuffer({ resolveWithObject: true });
  const rotatedRaw: RawImage = {
    width: rotated.info.width,
    height: rotated.info.height,
    channels: rotated.info.channels as RawImage['channels'],
  };

  let pipeline = sharp(rotated.data, { raw: rotatedRaw });
  if (opts.crop) {
    const matrix = await analysisMatrix(rotated.data, rotatedRaw);
    const box = detectSheetBox(matrix);
    if (box) {
      // Рамка найдена на уменьшенной копии — возвращаем её в координаты рабочего растра.
      const kx = rotatedRaw.width / matrix.width;
      const ky = rotatedRaw.height / matrix.height;
      const left = Math.max(0, Math.floor(box.left * kx));
      const top = Math.max(0, Math.floor(box.top * ky));
      pipeline = pipeline.extract({
        left,
        top,
        width: Math.max(1, Math.min(rotatedRaw.width - left, Math.round(box.width * kx))),
        height: Math.max(1, Math.min(rotatedRaw.height - top, Math.round(box.height * ky))),
      });
    }
  }

  const out = await pipeline
    .resize({
      width: opts.maxEdgePx,
      height: opts.maxEdgePx,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: opts.jpegQuality, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    pageNo,
    buffer: out.data,
    mediaType: 'image/jpeg',
    // Хэш растра, а не файла (Р10): по нему живут кэш попыток и проверка повторного предъявления.
    sha256: createHash('sha256').update(out.data).digest('hex'),
    width: out.info.width,
    height: out.info.height,
  };
}

/**
 * Файл заявки → страницы для модели.
 *
 * Единственная точка входа подготовки: задача очереди отдаёт сюда скачанный из S3 буфер и получает
 * либо страницы, либо `TicketFileError` с причиной и двумя осями классификации (Р29) — то есть
 * ровно то, что пишется в строку `waste_ticket_files`. Никаких сетевых вызовов и никаких обращений
 * к базе здесь нет: подготовка идёт **вне** транзакции (Р11, шаг «растеризация»), потому что
 * держать блокировку заявки на время растеризации PDF недопустимо.
 */
export async function prepareTicketFile(
  input: Buffer,
  options: PreprocessOptions,
): Promise<PreparedFile> {
  const opts = resolveOptions(options);
  if (input.length === 0) {
    throw unsupportedFile('empty_file', 'Файл пустой.');
  }
  if (input.length > opts.maxBytes) {
    throw unsupportedFile(
      'file_too_large',
      `Файл больше допустимого: ${Math.round(input.length / 1024 / 1024)} МБ.`,
    );
  }

  const detected = detectFileType(input);
  if (detected.kind === 'unsupported') {
    throw unsupportedFile(
      'unsupported_type',
      `Это не изображение и не PDF: ${detected.label}. Приложите JPEG, PNG или PDF.`,
    );
  }

  let rasters: { pageNo: number; buffer: Buffer }[];
  let totalPages: number;
  if (detected.kind === 'pdf') {
    const rendered = await rasterizePdf(input, {
      maxPages: opts.maxPages,
      maxEdgePx: opts.maxEdgePx,
      timeoutMs: opts.pdfTimeoutMs,
      memoryMb: opts.pdfMemoryMb,
      tmpDir: opts.tmpDir,
    });
    rasters = rendered.pages;
    totalPages = rendered.totalPages;
  } else {
    const raster = detected.kind === 'heif' ? await decodeHeif(input, opts) : input;
    rasters = [{ pageNo: 1, buffer: raster }];
    totalPages = 1;
  }

  const pages: PreparedPage[] = [];
  for (const raster of rasters.slice(0, opts.maxPages)) {
    pages.push(await renderPage(raster.buffer, raster.pageNo, opts));
  }

  return {
    sourceKind: detected.kind,
    totalPages,
    pages,
    // Не «потеряли», а «показываем»: что сверх лимита, помечается в интерфейсе (Р10).
    skippedPages: Math.max(0, totalPages - pages.length),
    preprocessingVersion: PREPROCESSING_VERSION,
  };
}
