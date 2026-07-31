import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';
import { err } from '../lib/errors';
import { logger } from '../logger';

/**
 * Перевод готового бланка в PDF (ADR 0040).
 *
 * Печатать надо тот же бланк, который выгружают: он пришёл из бухгалтерии, и портал не имеет
 * права перерисовывать его своей вёрсткой ради экрана — иначе на бумаге окажутся два разных
 * документа под одним номером. Поэтому печать — это тот же `renderOfficeTemplate`, только
 * доведённый до PDF, а не второй генератор.
 *
 * Переводит LibreOffice, поставленный в образ API. Своего движка здесь нет намеренно: бланк
 * держится на слитых ячейках, рамках, областях печати и подгонке по ширине, и любой самописный
 * рендер начал бы расходиться с оригиналом на первой же правке бухгалтерии.
 */

/**
 * Профиль пользователя — свой на каждый запуск, во временном каталоге. Общий профиль LibreOffice
 * держит под блокировкой: два одновременных запуска встали бы в очередь, а второй мог бы
 * завершиться молча, ничего не сконвертировав.
 */
function convertArgs(dir: string, input: string): string[] {
  return [
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    `-env:UserInstallation=file://${join(dir, 'profile')}`,
    '--convert-to',
    'pdf:calc_pdf_Export',
    '--outdir',
    dir,
    input,
  ];
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
      if (!error) return resolve();
      reject(error);
    });
  });
}

/**
 * Возвращает PDF, собранный из xlsx/ods. Ошибку конвертера наружу не пропускает: человеку нужен
 * ответ «печать не удалась», а причина — в логе, вместе с кодом выхода и stderr.
 */
export async function renderPdf(office: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'technic-print-'));
  const input = join(dir, 'blank.xlsx');
  try {
    await writeFile(input, office);
    await run(config.soffice.bin, convertArgs(dir, input), config.soffice.timeoutMs);
    return new Uint8Array(await readFile(join(dir, 'blank.pdf')));
  } catch (cause) {
    logger.error({ err: cause, bin: config.soffice.bin }, 'печать: конвертация бланка в PDF');
    throw err.conflict(
      'Не удалось подготовить бланк к печати — выгрузите его файлом и напечатайте из редактора',
    );
  } finally {
    // Каталог уносит с собой и профиль LibreOffice: во временном каталоге ему жить один запуск.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
