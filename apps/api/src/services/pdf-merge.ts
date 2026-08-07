import { PDFDocument } from 'pdf-lib';
import { err } from '../lib/errors';
import { logger } from '../logger';

/**
 * Склейка готовых PDF в один документ — для печати пачки путевых листов одним окном.
 *
 * Почему склейка, а не «напечатать по очереди»: диалог печати браузера открывается на документ, и
 * десять листов десятью окнами это десять подтверждений и десять заданий в очереди принтера. У
 * пачки должен быть один документ — его и собираем.
 *
 * Почему после конвертера, а не вместо него: бланк переводит в PDF LibreOffice, и переверстать его
 * своими силами значит разойтись с утверждённой бумагой (см. `office-pdf`). Здесь страницы только
 * переносятся как есть — ни размеры, ни содержимое не трогаются.
 *
 * Порядок страниц — порядок входа: пачку разбирают по столу в том же виде, в каком её видели на
 * экране.
 */
export async function mergePdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 0) throw err.conflict('Нечего печатать: не выбрано ни одного листа');
  if (parts.length === 1) return parts[0]!;
  try {
    const merged = await PDFDocument.create();
    for (const part of parts) {
      const doc = await PDFDocument.load(part);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    return await merged.save();
  } catch (cause) {
    logger.error({ err: cause, parts: parts.length }, 'печать: склейка бланков в один документ');
    throw err.conflict(
      'Не удалось собрать листы в один документ — напечатайте их по одному из журнала',
    );
  }
}
