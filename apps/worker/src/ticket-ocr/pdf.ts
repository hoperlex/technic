import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenSubsystem, retryableFile, unsupportedFile } from './errors';
import { assertBinaryPresent, runLimited } from './subprocess';

/**
 * Растеризация PDF — единственное место модуля, где портал запускает чужую программу
 * (план `docs/waste-ticket-ocr-plan.md`, Р9).
 *
 * Почему не `sharp`: libvips PDF не открывает вовсе (нужен poppler-glib, которого в сборке нет),
 * и заменить растеризатор библиотекой не выйдет — приходится звать `pdftoppm` из poppler-utils.
 *
 * Почему это в принципе допустимо. PDF от бухгалтерии — это не картинка, а **программа**: дерево
 * объектов, потоки со своим сжатием, шрифты, вложенные файлы. Разбирать его в том же процессе,
 * который держит соединение с базой и арендованные задачи очереди, нельзя: разрыв в парсере
 * уносит воркер целиком, а бесконечный цикл в нём — заодно и все задачи, которые воркер держал.
 * Поэтому разбор идёт в **отдельном процессе**, у которого три поводка:
 *
 * 1. **срок** и 2. **память** — общие для всех внешних вызовов модуля и живут в `subprocess.ts`;
 * 3. **разрешение** — `-r`, посчитанное так, чтобы растр страницы не превысил `maxEdgePx`. Это не
 *    про качество, а про ту же память: A0-чертёж при 300 dpi — это 100 000 × 70 000 пикселей, и
 *    никакой `ulimit` тут не спасёт от получаса ожидания.
 *
 * Имя файла пользователя в командную строку **не попадает**: PDF пишется во временный каталог под
 * своим, нашим именем.
 */

/** Что делает страница PDF после растеризации: номер (с единицы) и PNG-растр. */
export interface PdfPageRaster {
  pageNo: number;
  buffer: Buffer;
}

export interface PdfRasterResult {
  /** Сколько страниц в файле всего — «в файле 6 страниц, обработано 5 (лимит)» (Р10). */
  totalPages: number;
  pages: PdfPageRaster[];
}

export interface PdfRasterOptions {
  /** Потолок страниц, `TICKET_OCR_MAX_PAGES` (по умолчанию 5, решение заказчика В7). */
  maxPages: number;
  /** Длинная сторона растра: во столько же упирается и ресайз перед отправкой в модель. */
  maxEdgePx: number;
  timeoutMs: number;
  memoryMb: number;
  /** Каталог для временных файлов; в тестах — свой, чтобы не зависеть от `/tmp`. */
  tmpDir?: string;
}

/** Разрешение растеризации зажато с двух сторон: ниже — нечитаемо, выше — незачем платить. */
const MIN_DPI = 72;
const MAX_DPI = 300;
/** Страница A4 в пунктах: запасной размер, когда `pdfinfo` про размер промолчал. */
const A4_LONG_EDGE_PT = 841.89;
/** Потолок суммарного растра: пять страниц по 20 МБ — это уже не талон, а попытка. */
const MAX_RASTER_BYTES = 120 * 1024 * 1024;

/** Число страниц и длинная сторона листа из вывода `pdfinfo`. */
function parsePdfInfo(stdout: string): { pages: number; longEdgePt: number } {
  const pages = Number(/^Pages:\s+(\d+)$/m.exec(stdout)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(stdout);
  const longEdgePt = size
    ? Math.max(Number(size[1]), Number(size[2]))
    : /* размер не назван — считаем по A4, ошибка тут стоит лишних пикселей, а не отказа */
      A4_LONG_EDGE_PT;
  return { pages, longEdgePt: longEdgePt > 0 ? longEdgePt : A4_LONG_EDGE_PT };
}

/**
 * PDF → PNG постранично, не больше `maxPages` страниц.
 *
 * Сначала `pdfinfo`, и не ради любопытства: без числа страниц нечего показать в «в файле 6 страниц,
 * обработано 5» (Р10), а без размера листа не посчитать разрешение. Заодно это дешёвая проверка,
 * что перед нами вообще PDF, который poppler берётся открыть, — до того, как мы дали ему рисовать.
 */
export async function rasterizePdf(
  input: Buffer,
  opts: PdfRasterOptions,
): Promise<PdfRasterResult> {
  const base = opts.tmpDir ?? tmpdir();
  let dir: string;
  try {
    dir = await mkdtemp(join(base, 'ticket-pdf-'));
  } catch (err) {
    // Нет временного каталога — сломана не бумага, а машина: чинится администратором, не повтором.
    throw brokenSubsystem('tmp_unavailable', 'Недоступен временный каталог воркера.', err);
  }

  try {
    const src = join(dir, 'source.pdf');
    await writeFile(src, input, { mode: 0o600 });

    const info = await runLimited('pdfinfo', [src], {
      timeoutMs: opts.timeoutMs,
      memoryMb: opts.memoryMb,
    });
    assertBinaryPresent('pdfinfo', info);
    if (info.timedOut) {
      throw retryableFile('pdf_timeout', 'PDF не удалось прочитать за отведённое время.');
    }
    if (info.code !== 0) {
      const encrypted = /password/i.test(info.stderr);
      throw unsupportedFile(
        encrypted ? 'pdf_encrypted' : 'pdf_unreadable',
        encrypted
          ? 'PDF защищён паролем — снимите защиту и приложите файл заново.'
          : 'PDF не открывается: файл повреждён.',
      );
    }

    const { pages: totalPages, longEdgePt } = parsePdfInfo(info.stdout);
    if (totalPages < 1) {
      throw unsupportedFile('pdf_no_pages', 'В PDF нет ни одной страницы.');
    }

    // Разрешение из требуемого размера растра, а не наоборот: платим ровно за те пиксели, которые
    // потом уедут в модель, и не рисуем 300 dpi, чтобы тут же ужать их до 2576 точек.
    const dpi = Math.min(
      MAX_DPI,
      Math.max(MIN_DPI, Math.round((opts.maxEdgePx * 72) / longEdgePt)),
    );
    const lastPage = Math.min(totalPages, Math.max(1, opts.maxPages));
    const prefix = join(dir, 'page');
    const render = await runLimited(
      'pdftoppm',
      ['-png', '-q', '-r', String(dpi), '-f', '1', '-l', String(lastPage), src, prefix],
      { timeoutMs: opts.timeoutMs, memoryMb: opts.memoryMb },
    );
    assertBinaryPresent('pdftoppm', render);
    if (render.timedOut) {
      throw retryableFile(
        'pdf_timeout',
        'PDF не удалось растеризовать за отведённое время — файл слишком тяжёлый.',
      );
    }

    // Имена файлов читаются с диска, а не собираются по шаблону: poppler дополняет номер нулями
    // по разрядности последней страницы, и «page-1.png» у него бывает и «page-01.png».
    const produced: PdfPageRaster[] = [];
    let bytes = 0;
    for (const name of (await readdir(dir)).sort()) {
      const match = /^page-(\d+)\.png$/.exec(name);
      if (!match) continue;
      const buffer = await readFile(join(dir, name));
      bytes += buffer.byteLength;
      if (bytes > MAX_RASTER_BYTES) {
        throw unsupportedFile(
          'pdf_too_heavy',
          'Страницы PDF разворачиваются в слишком большие изображения.',
        );
      }
      produced.push({ pageNo: Number(match[1]), buffer });
    }
    produced.sort((a, b) => a.pageNo - b.pageNo);

    if (produced.length === 0) {
      // Ненулевой код при пустом выводе — это отказ растеризатора, а не «пустой документ».
      throw unsupportedFile(
        'pdf_render_failed',
        render.code === 0
          ? 'PDF не содержит страниц, которые можно нарисовать.'
          : 'PDF не удалось растеризовать: файл повреждён.',
      );
    }
    return { totalPages, pages: produced };
  } finally {
    // Скан талона — персональные данные подрядчика: временный каталог убирается всегда, включая
    // путь через исключение, и вместе с содержимым.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
