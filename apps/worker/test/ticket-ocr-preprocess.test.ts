import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createStubEngine } from '../src/ticket-ocr/engine';
import { TicketFileError } from '../src/ticket-ocr/errors';
import { detectFileType, prepareTicketFile } from '../src/ticket-ocr/preprocess';
import { assertBinaryPresent, runLimited } from '../src/ticket-ocr/subprocess';

/**
 * Подготовка скана (план `docs/waste-ticket-ocr-plan.md`, Р9, Р10).
 *
 * Здесь проверяется то, ради чего Р9 называет файл **враждебным**. Не потому, что бухгалтерия
 * злонамеренна: разбирает приложенное тот же процесс, который держит арендованные задачи очереди,
 * и падение в декодере уносит не одну заявку, а всё, что воркер успел взять. Поэтому тесты идут
 * ровно по трём рубежам обороны: сигнатура вместо `content_type`, размеры до декодирования,
 * страницы поштучно.
 *
 * Настоящих сканов талонов здесь нет и быть не может — репозиторий публичный, а талон это
 * персональные данные подрядчика. Картинки рисуются на месте, PDF собирается байтами.
 */

/**
 * PNG, у которого в заголовке заявлены гигантские размеры, а данных нет вовсе, — архивная бомба в
 * чистом виде. Сорок килобайт на диске разворачиваются в десятки гигабайт в памяти, и заметить это
 * после декодирования уже некому: процесс к тому моменту убит ядром.
 *
 * Пиксельных данных в файле нарочно нет: если проверка размеров сработала **до** декодирования,
 * как того требует Р9, до битого потока дело не дойдёт и отказ будет именно про размер.
 */
function bombPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 0; // оттенки серого
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Кадр «лист на столе»: серый фон, белая бумага с текстовыми полосами внутри. */
async function photoOfSheet(width = 1200, height = 900): Promise<Buffer> {
  const data = Buffer.alloc(width * height, 90);
  const put = (x0: number, y0: number, x1: number, y1: number, value: number) => {
    for (let y = y0; y <= y1; y += 1) data.fill(value, y * width + x0, y * width + x1 + 1);
  };
  put(120, 80, width - 120, height - 80, 245);
  for (let line = 1; line * 40 < height - 160; line += 1) {
    put(200, 80 + line * 40, width - 200, 80 + line * 40 + 8, 25);
  }
  return await sharp(data, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/** Минимальный PDF из нескольких страниц: сборка по объектам, чтобы xref сошёлся до байта. */
function minimalPdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids: string[] = [];
  for (let i = 0; i < pages; i += 1) {
    const pageObj = 3 + i * 2;
    kids.push(`${pageObj} 0 R`);
  }
  objects.push('<</Type/Catalog/Pages 2 0 R>>');
  objects.push(`<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`);
  for (let i = 0; i < pages; i += 1) {
    const contentObj = 4 + i * 2;
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents ${contentObj} 0 R/Resources<<>>>>`,
    );
    // Каждая страница рисует прямоугольник в своём месте: иначе растры совпадут, а с ними и
    // `page_sha256`, и тест перестал бы отличать «две страницы» от «одна, посчитанная дважды».
    const stream = `0 0 0 rg 100 ${100 + i * 150} 400 120 re f`;
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const hasPoppler = spawnSync('/bin/sh', ['-c', 'command -v pdftoppm']).status === 0;

const OPTS = { maxPages: 5, maxEdgePx: 1000 };

async function expectFileError(promise: Promise<unknown>): Promise<TicketFileError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(TicketFileError);
  return error as TicketFileError;
}

describe('тип файла по сигнатуре', () => {
  it('узнаёт то, что мы читаем', async () => {
    expect(
      detectFileType(
        await sharp({
          create: { width: 8, height: 8, channels: 3, background: '#fff' },
        })
          .jpeg()
          .toBuffer(),
      ).kind,
    ).toBe('jpeg');
    expect(detectFileType(bombPng(4, 4)).kind).toBe('png');
    expect(
      detectFileType(
        await sharp({
          create: { width: 8, height: 8, channels: 3, background: '#fff' },
        })
          .webp()
          .toBuffer(),
      ).kind,
    ).toBe('webp');
    expect(detectFileType(minimalPdf(1)).kind).toBe('pdf');
  });

  it('узнаёт HEIC по бренду контейнера, а не по расширению', () => {
    const heic = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(detectFileType(heic).kind).toBe('heif');
  });

  it('называет знакомые, но негодные форматы поимённо', () => {
    expect(detectFileType(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0])).label).toBe('TIFF');
    expect(detectFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])).label).toContain('ZIP');
    expect(detectFileType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0, 0])).label).toBe('GIF');
  });

  it('не верит подписи «это JPEG», сделанной браузером', async () => {
    // Тот самый случай, ради которого сигнатура и читается: ZIP, названный photo.jpg. По
    // `content_type` из формы он ушёл бы прямиком в декодер.
    const zipNamedJpeg = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const error = await expectFileError(prepareTicketFile(zipNamedJpeg, OPTS));
    expect(error.code).toBe('unsupported_type');
    expect(error.errorClass).toBe('terminal');
    expect(error.errorScope).toBe('item');
  });

  it('пустой файл отвергает отдельной причиной', async () => {
    const error = await expectFileError(prepareTicketFile(Buffer.alloc(0), OPTS));
    expect(error.code).toBe('empty_file');
  });
});

describe('архивная бомба', () => {
  it('отвергается по заявленным размерам — до декодирования', async () => {
    const error = await expectFileError(prepareTicketFile(bombPng(60_000, 60_000), OPTS));
    // Не `broken_image`: до битого потока пикселей дело не дошло, отказ пришёл по заголовку.
    expect(error.code).toBe('image_too_large');
    expect(error.reason).toContain('60000');
    expect(error.errorScope).toBe('item');
  });

  it('файл больше допустимого не открывается вовсе', async () => {
    const error = await expectFileError(
      prepareTicketFile(Buffer.alloc(3 * 1024 * 1024, 1), { ...OPTS, maxBytes: 1024 }),
    );
    expect(error.code).toBe('file_too_large');
  });

  it('битую картинку отличает от большой', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x7f)]);
    const error = await expectFileError(prepareTicketFile(broken, OPTS));
    expect(error.code).toBe('broken_image');
  });
});

describe('страница для модели', () => {
  it('фотография листа превращается в один JPEG с хэшем растра', async () => {
    const prepared = await prepareTicketFile(await photoOfSheet(), OPTS);
    expect(prepared.sourceKind).toBe('png');
    expect(prepared.totalPages).toBe(1);
    expect(prepared.skippedPages).toBe(0);

    const [page] = prepared.pages;
    expect(page).toBeDefined();
    expect(page!.pageNo).toBe(1);
    expect(page!.mediaType).toBe('image/jpeg');
    expect(page!.buffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // Хэш считается от растра страницы, а не от файла (Р10): на нём стоят и кэш попыток, и
    // проверка «этот талон уже предъявляли».
    expect(page!.sha256).toBe(createHash('sha256').update(page!.buffer).digest('hex'));
    expect(Math.max(page!.width, page!.height)).toBeLessThanOrEqual(OPTS.maxEdgePx);
  });

  it('обрезает по контуру листа: стол в кадр модели не уезжает', async () => {
    const cropped = await prepareTicketFile(await photoOfSheet(), OPTS);
    const whole = await prepareTicketFile(await photoOfSheet(), { ...OPTS, crop: false });
    const ratio = (p: { width: number; height: number }) => p.width / p.height;
    // Лист на кадре 1200×900 занимает 960×740: он «квадратнее» кадра, и после обрезки отношение
    // сторон обязано это показать. Одинаковые пропорции означали бы, что стол уехал в модель.
    expect(ratio(cropped.pages[0]!)).toBeLessThan(ratio(whole.pages[0]!) - 0.01);
  });

  it('одинаковый файл даёт одинаковый хэш, разный — разный', async () => {
    const first = await prepareTicketFile(await photoOfSheet(), OPTS);
    const same = await prepareTicketFile(await photoOfSheet(), OPTS);
    const other = await prepareTicketFile(await photoOfSheet(1100, 850), OPTS);
    expect(first.pages[0]!.sha256).toBe(same.pages[0]!.sha256);
    expect(first.pages[0]!.sha256).not.toBe(other.pages[0]!.sha256);
  });
});

describe('HEIC', () => {
  it('читается, когда сборка libvips умеет его кодек', async () => {
    // AVIF — тот же контейнер HEIF, и его декодер в сборке есть. Так проверяется сама ветка:
    // контейнер узнан по бренду, преобразован и разобран как обычная страница.
    const avif = await sharp({
      create: { width: 320, height: 240, channels: 3, background: '#ffffff' },
    })
      .avif({ quality: 50 })
      .toBuffer();
    expect(detectFileType(avif).kind).toBe('heif');
    const prepared = await prepareTicketFile(avif, OPTS);
    expect(prepared.sourceKind).toBe('heif');
    expect(prepared.pages).toHaveLength(1);
  });

  it('снимок с айфона без конвертера отвергает с понятным действием', async () => {
    // Контейнер HEIF с кодеком HEVC: libheif в сборке `sharp` его не декодирует, а внешнего
    // конвертера в конфигурации нет. Человеку остаётся сохранить снимок как JPEG — так и написано.
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(64, 0x11),
    ]);
    const error = await expectFileError(prepareTicketFile(heic, OPTS));
    expect(error.code).toBe('heic_unsupported');
    expect(error.reason).toContain('JPEG');
  });
});

describe('внешние программы (Р9, Р29)', () => {
  it('отсутствие программы в образе — сбой подсистемы, а не файла', async () => {
    const res = await runLimited('technic-no-such-binary', [], { timeoutMs: 5_000, memoryMb: 512 });
    const error = await expectFileError(
      Promise.resolve().then(() => assertBinaryPresent('technic-no-such-binary', res)),
    );
    // Повторять такую задачу бессмысленно: чинится она сборкой образа, а не временем (Р29).
    expect(error.code).toBe('binary_missing');
    expect(error.errorClass).toBe('terminal');
    expect(error.errorScope).toBe('subsystem');
  });

  it('срок обрывает зависшую программу, а не ждёт её вечно', async () => {
    const res = await runLimited('sleep', ['30'], { timeoutMs: 150, memoryMb: 512 });
    expect(res.timedOut).toBe(true);
  });
});

describe('подготовка и движок стыкуются', () => {
  it('страница уезжает в движок как есть — хэш растра тот же', async () => {
    const prepared = await prepareTicketFile(await photoOfSheet(), OPTS);
    const page = prepared.pages[0]!;
    const outcome = await createStubEngine().recognize(page, { model: 'stub' });
    expect(outcome.status).toBe('done');
    expect(outcome.meta.preprocessingVersion).toBe(prepared.preprocessingVersion);
    expect(outcome.meta.requestId).toContain(page.sha256.slice(0, 12));
  });
});

describe.skipIf(!hasPoppler)('PDF постранично', () => {
  it('разбирает страницы и считает их отдельными', async () => {
    const prepared = await prepareTicketFile(minimalPdf(2), OPTS);
    expect(prepared.sourceKind).toBe('pdf');
    expect(prepared.totalPages).toBe(2);
    expect(prepared.pages.map((p) => p.pageNo)).toEqual([1, 2]);
    // Разные страницы — разный `page_sha256`: хэш файла обе назвал бы одинаково, и повторное
    // предъявление листа из пачки МФУ прошло бы незамеченным (Р10).
    expect(prepared.pages[0]!.sha256).not.toBe(prepared.pages[1]!.sha256);
  });

  it('что сверх лимита — считает, а не теряет молча', async () => {
    const prepared = await prepareTicketFile(minimalPdf(4), { ...OPTS, maxPages: 2 });
    expect(prepared.totalPages).toBe(4);
    expect(prepared.pages).toHaveLength(2);
    // «В файле 4 страницы, обработано 2 (лимит)» — это и есть строка на экране (Р10).
    expect(prepared.skippedPages).toBe(2);
  });

  it('обрывок PDF отвергает как непригодный файл, а не роняет воркер', async () => {
    const truncated = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer', 'latin1');
    const error = await expectFileError(prepareTicketFile(truncated, OPTS));
    expect(error.errorClass).toBe('terminal');
    expect(error.code).toMatch(/^pdf_/);
  });
});
