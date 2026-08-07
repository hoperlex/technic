import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';
import { err } from '../lib/errors';
import { logger } from '../logger';

/**
 * Перевод готового бланка в PDF (ADR 0041).
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
function convertArgs(dir: string, inputs: string[]): string[] {
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
    ...inputs,
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
  const [pdf] = await renderPdfBatch([office]);
  return pdf!;
}

/**
 * Те же бланки, но пачкой — одним запуском конвертера.
 *
 * Запуск LibreOffice стоит дороже самой конвертации: он поднимает офисный пакет с нуля, и на
 * десяти листах последовательные запуски дали бы десятикратное ожидание там, где хватает одного.
 * Поэтому файлы кладутся в общий каталог и передаются конвертеру списком.
 *
 * Порядок ответа — порядок входа: пачку печатают одним документом, и лист, уехавший на чужое
 * место, разошёлся бы с тем, что человек видел на экране. Имена файлов поэтому нумерованные, а
 * не по номеру бланка: сортировка каталога портала не касается.
 *
 * Время ждём соразмерно пачке: тайм-аут одного бланка на десяти листах срубил бы работу на
 * середине.
 */
export async function renderPdfBatch(files: readonly Uint8Array[]): Promise<Uint8Array[]> {
  if (files.length === 0) return [];
  const dir = await mkdtemp(join(tmpdir(), 'technic-print-'));
  const names = files.map((_, index) => `blank-${String(index).padStart(3, '0')}`);
  try {
    await Promise.all(
      files.map((bytes, index) => writeFile(join(dir, `${names[index]!}.xlsx`), bytes)),
    );
    await run(
      config.soffice.bin,
      convertArgs(
        dir,
        names.map((name) => join(dir, `${name}.xlsx`)),
      ),
      config.soffice.timeoutMs * files.length,
    );
    return await Promise.all(
      names.map(async (name) => new Uint8Array(await readFile(join(dir, `${name}.pdf`)))),
    );
  } catch (cause) {
    logger.error(
      { err: cause, bin: config.soffice.bin, count: files.length },
      'печать: конвертация бланков в PDF',
    );
    throw err.conflict(
      'Не удалось подготовить бланк к печати — выгрузите его файлом и напечатайте из редактора',
    );
  } finally {
    // Каталог уносит с собой и профиль LibreOffice: во временном каталоге ему жить один запуск.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
