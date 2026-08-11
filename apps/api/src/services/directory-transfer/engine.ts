import {
  DIRECTORY_DATA_SHEET,
  DIRECTORY_HELP_SHEET,
  DIRECTORY_ID_COLUMN,
  DIRECTORY_IMPORT_MAX_ROWS,
  directoryTitles,
  type DirectoryCellChangeDto,
  type DirectoryImportReportDto,
  type DirectoryRowReportDto,
} from '@technic/contracts';
import { db } from '../../db/client';
import { readWorkbook, writeWorkbook, XlsxError } from '../../lib/xlsx';
import { pgErrorOf } from '../../lib/pg-error';
import type { AnyDirectory, DirectoryColumn, RowContext } from './types';

/**
 * Механика обмена справочником через файл Excel (ADR 0073) — одна на все справочники.
 *
 * Здесь нет ни одного знания о конкретном справочнике: движок читает описание (`types.ts`),
 * складывает из него книгу, разбирает присланную обратно и говорит, что изменится. Общий модуль,
 * а не восемнадцать похожих обработчиков — по той же причине, что и у окончательного удаления
 * (`directory-purge.ts`): правила «что считать изменением», «когда файл не применяется» и «как
 * называется ошибка» обязаны совпадать во всех справочниках дословно, иначе очередной из них
 * тихо разойдётся с остальными.
 */

/**
 * Файл не разобран: не книга, нет листа с данными, незнакомые колонки, слишком много строк.
 * Свой класс, а не голый Error: «прислали не тот файл» обязано отличаться от «сервер сломался» —
 * первое объясняют загрузившему дословно, второе прячут за 500 (приём ADR 0047 п. 6).
 */
export class DirectoryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryFileError';
  }
}

/** Ширина служебной колонки: в ней лежит UUID, и ужимать её незачем — её не читают. */
const ID_COLUMN_WIDTH = 38;

/** Ширина по умолчанию для колонки, которая своей не назвала. */
const DEFAULT_COLUMN_WIDTH = 22;

/**
 * Заголовок, приведённый к сравнимому виду. Человек в редакторе таблиц вправе поправить регистр
 * или поставить лишний пробел — файл от этого не перестаёт быть тем самым.
 */
function headerKey(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase();
}

interface Prepared {
  env: unknown;
  columns: DirectoryColumn<unknown>[];
  rows: unknown[];
}

async function prepare(def: AnyDirectory): Promise<Prepared> {
  const env = await def.env();
  return { env, columns: def.columns(env), rows: await def.load(env) };
}

/** Лист «Справка»: зачем справочник и чем заполняют колонки. Загрузка его не читает. */
function helpSheet(def: AnyDirectory, prepared: Prepared): string[][] {
  const rows: string[][] = [[directoryTitles[def.key]], []];
  for (const line of def.help(prepared.env)) rows.push([line]);
  rows.push([], ['Колонка', 'Чем заполняют']);
  rows.push([
    DIRECTORY_ID_COLUMN,
    'Служебная колонка портала. У выгруженных строк её не трогают, у дописанных оставляют пустой.',
  ]);
  for (const column of prepared.columns) {
    if (column.hint) rows.push([column.header, column.hint]);
  }
  return rows;
}

/** Справочник целиком книгой: лист «Данные» и лист «Справка». */
export async function exportDirectory(
  def: AnyDirectory,
): Promise<{ bytes: Uint8Array; rows: number }> {
  const prepared = await prepare(def);
  const header = [DIRECTORY_ID_COLUMN, ...prepared.columns.map((c) => c.header)];
  const data = prepared.rows.map((row) => {
    const model = def.model(row, prepared.env);
    return [def.id(row), ...prepared.columns.map((c) => c.get(model))];
  });

  const bytes = writeWorkbook([
    {
      name: DIRECTORY_DATA_SHEET,
      rows: [header, ...data],
      widths: [ID_COLUMN_WIDTH, ...prepared.columns.map((c) => c.width ?? DEFAULT_COLUMN_WIDTH)],
      freezeHeader: true,
    },
    { name: DIRECTORY_HELP_SHEET, rows: helpSheet(def, prepared), widths: [34, 96] },
  ]);
  return { bytes, rows: data.length };
}

/** Сколько строк в справочнике — столько же уедет в файл. */
export async function countDirectory(def: AnyDirectory): Promise<number> {
  const env = await def.env();
  return (await def.load(env)).length;
}

/** Лист с данными. Книга из одного листа принимается под любым именем: его мог дать редактор. */
function dataSheet(bytes: Uint8Array): string[][] {
  let sheets;
  try {
    sheets = readWorkbook(bytes);
  } catch (e) {
    if (e instanceof XlsxError) throw new DirectoryFileError(e.message);
    throw e;
  }
  const wanted = headerKey(DIRECTORY_DATA_SHEET);
  const found =
    sheets.find((s) => headerKey(s.name) === wanted) ??
    (sheets.length === 1 ? sheets[0] : undefined);
  if (!found) {
    throw new DirectoryFileError(
      `В книге нет листа «${DIRECTORY_DATA_SHEET}». Загружают тот файл, который выгрузил портал, — на этом листе он и хранит справочник.`,
    );
  }
  if (found.rows.length === 0) {
    throw new DirectoryFileError(`Лист «${found.name}» пуст: в нём нет даже строки заголовков.`);
  }
  return found.rows;
}

/**
 * Шапка файла: какая колонка описания где стоит. Незнакомая колонка — отказ, а не молчаливый
 * пропуск: она означает файл по другому шаблону, и завести по нему справочник значит завести не
 * то, что собирались (ADR 0047 п. 7). Отсутствие известной колонки отказом не считается — человек
 * вправе удалить то, чего не правит, а обязательность недостающего поймает разбор строки.
 *
 * Своим именем колонка отзывается и на прежние (`aliases`): иначе переименование колонки отвергало
 * бы файл, скачанный до него. На повтор это не влияет — прежнее имя рядом с нынешним остаётся
 * повтором колонки, и такой файл не принимается.
 */
function mapHeader(
  header: readonly string[],
  columns: DirectoryColumn<unknown>[],
): { idAt: number; at: Map<DirectoryColumn<unknown>, number> } {
  const known = new Map(columns.map((c) => [headerKey(c.header), c]));
  // Псевдонимы кладутся вторым проходом, поверх ничего не затирая: столкнись прежнее имя одной
  // колонки с нынешним именем другой — читается та, которая называется так сейчас, потому что
  // именно её человек в файле и видит.
  for (const column of columns) {
    for (const alias of column.aliases ?? []) {
      const key = headerKey(alias);
      if (!known.has(key)) known.set(key, column);
    }
  }
  const at = new Map<DirectoryColumn<unknown>, number>();
  const unknown: string[] = [];
  const duplicates: string[] = [];
  let idAt = -1;

  header.forEach((text, index) => {
    const key = headerKey(text);
    if (key === '') return;
    if (key === headerKey(DIRECTORY_ID_COLUMN)) {
      if (idAt >= 0) duplicates.push(text.trim());
      idAt = index;
      return;
    }
    const column = known.get(key);
    if (!column) {
      unknown.push(text.trim());
      return;
    }
    if (at.has(column)) duplicates.push(text.trim());
    at.set(column, index);
  });

  if (unknown.length > 0) {
    throw new DirectoryFileError(
      `Колонки, которых у этого справочника нет: ${unknown.join(', ')}. Похоже, файл от другого справочника или собран не выгрузкой портала.`,
    );
  }
  if (duplicates.length > 0) {
    throw new DirectoryFileError(
      `Колонка повторяется в шапке: ${[...new Set(duplicates)].join(', ')}. Какую из них читать — неизвестно.`,
    );
  }
  if (at.size === 0) {
    throw new DirectoryFileError('В шапке нет ни одной колонки этого справочника: читать нечего.');
  }
  return { idAt, at };
}

/** Копилка замечаний одной строки. Пустая — строка разобрана. */
function rowContext(row: number, problems: string[], warnings: string[]): RowContext {
  return {
    row,
    fail: (message) => problems.push(`строка ${row}: ${message}`),
    warn: (message) => warnings.push(`строка ${row}: ${message}`),
  };
}

/** Замечания, которые никто не увидит: разбор ради ключа делается дважды, ошибки нужны от второго. */
function silentContext(row: number): RowContext {
  return { row, fail: () => {}, warn: () => {} };
}

interface PlannedRow {
  report: DirectoryRowReportDto;
  model: unknown;
  /** Строка справочника, которую строка файла обновляет; `undefined` — заводится новая. */
  existing?: unknown;
}

/**
 * Что сделает загрузка. Разбор строки идёт дважды: первый раз — начисто, только чтобы собрать
 * ключ и найти заведённую запись; второй — поверх найденной. Из-за этого «пустая ячейка ничего не
 * меняет» работает само собой: колонка, которая при пустом значении ничего не делает, оставляет
 * то, что уже заведено, — и в отчёте не появляется правки, которой никто не делал.
 */
function planRows(
  def: AnyDirectory,
  prepared: Prepared,
  sheet: string[][],
): { plan: PlannedRow[]; report: Omit<DirectoryImportReportDto, 'dryRun'> } {
  const { idAt, at } = mapHeader(sheet[0] ?? [], prepared.columns);
  const body = sheet.slice(1);
  if (body.length > DIRECTORY_IMPORT_MAX_ROWS) {
    throw new DirectoryFileError(
      `В файле строк: ${body.length}, а принимается не больше ${DIRECTORY_IMPORT_MAX_ROWS}. Справочник портала столько строк не содержит — проверьте, тот ли это файл.`,
    );
  }

  const byId = new Map<string, unknown>();
  const byKey = new Map<string, unknown>();
  for (const row of prepared.rows) {
    byId.set(def.id(row), row);
    const key = def.keyOf(def.model(row, prepared.env));
    if (key !== '' && !byKey.has(key)) byKey.set(key, row);
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  const created: DirectoryRowReportDto[] = [];
  const updated: DirectoryRowReportDto[] = [];
  const plan: PlannedRow[] = [];
  const seenKeys = new Map<string, number>();
  let unchanged = 0;
  let totalRows = 0;

  body.forEach((cells, index) => {
    // Номер строки на листе: заголовок занял первую, отсчёт данных идёт со второй.
    const rowNo = index + 2;
    if (cells.every((c) => c.trim() === '')) return;
    totalRows += 1;

    const at2 = (column: DirectoryColumn<unknown>): string | undefined => {
      const columnIndex = at.get(column);
      return columnIndex === undefined ? undefined : (cells[columnIndex] ?? '').trim();
    };

    const apply = (model: unknown, ctx: RowContext): void => {
      for (const column of prepared.columns) {
        const text = at2(column);
        if (text === undefined || !column.set) continue;
        column.set(model, text, ctx);
      }
    };

    // Первый проход — тихий: он нужен ради ключа, а его ошибки повторит второй.
    const probe = def.blank();
    apply(probe, silentContext(rowNo));

    const idText = idAt >= 0 ? (cells[idAt] ?? '').trim() : '';
    const existing = idText !== '' ? byId.get(idText) : byKey.get(def.keyOf(probe));
    const ctx = rowContext(rowNo, problems, warnings);
    if (idText !== '' && !existing) {
      ctx.fail(
        `запись с идентификатором ${idText} в справочнике не найдена. Если это новая строка, очистите колонку «${DIRECTORY_ID_COLUMN}»`,
      );
      return;
    }

    const before = existing === undefined ? undefined : def.model(existing, prepared.env);
    const model = existing === undefined ? def.blank() : def.model(existing, prepared.env);
    apply(model, ctx);
    def.check?.(model, ctx, prepared.env);

    const key = def.keyOf(model);
    if (key !== '') {
      const twin = seenKeys.get(key);
      if (twin !== undefined) {
        ctx.fail(`та же запись уже описана строкой ${twin} — в файле она может быть только одна`);
      } else {
        seenKeys.set(key, rowNo);
      }
    }

    const title = def.titleOf(model);
    if (before === undefined) {
      const report = { row: rowNo, title };
      created.push(report);
      plan.push({ report, model });
      return;
    }

    const changes: DirectoryCellChangeDto[] = [];
    for (const column of prepared.columns) {
      if (!column.set || at2(column) === undefined) continue;
      const from = column.get(before);
      const to = column.get(model);
      if (from !== to) changes.push({ column: column.header, from, to });
    }
    if (changes.length === 0) {
      unchanged += 1;
      return;
    }
    const report = { row: rowNo, title, changes };
    updated.push(report);
    plan.push({ report, model, existing });
  });

  return {
    plan,
    report: {
      key: def.key,
      title: directoryTitles[def.key],
      totalRows,
      created,
      updated,
      unchanged,
      problems,
      warnings,
    },
  };
}

/**
 * Отказ базы при записи. Уникальность здесь означает не поломку, а строку, которая столкнулась с
 * уже заведённой не по тому ключу, по которому её искали: один и тот же тип мусора под двумя
 * кодами, тот же госномер у другой машины. Человеку нужно знать это, а не текст ограничения.
 */
function asImportConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505') {
    return new DirectoryFileError(
      'Загрузка отменена: одна из строк совпала с уже заведённой записью по другому признаку — наименованию, номеру или коду. Ничего не изменено.',
    );
  }
  if (pg?.code === '23503') {
    return new DirectoryFileError(
      'Загрузка отменена: строка ссылается на запись, которой в портале нет. Ничего не изменено.',
    );
  }
  return e;
}

/**
 * Разобрать файл, сверить со справочником и — если это не предпросмотр — применить.
 *
 * Применяется либо весь файл, либо ничего: одной транзакцией и только при пустом списке ошибок.
 * Половина заведённого справочника хуже невыполненной загрузки — её придётся сверять построчно.
 */
export async function importDirectory(
  def: AnyDirectory,
  bytes: Uint8Array,
  opts: { dryRun: boolean; actorUserId: string },
): Promise<DirectoryImportReportDto> {
  const prepared = await prepare(def);
  const { plan, report } = planRows(def, prepared, dataSheet(bytes));

  if (opts.dryRun) return { dryRun: true, ...report };

  if (report.problems.length > 0) {
    const head =
      report.problems.length === 1
        ? 'Файл не загружен:'
        : `Файл не загружен, строк с ошибками — ${report.problems.length}:`;
    throw new DirectoryFileError([head, ...report.problems.map((p) => `· ${p}`)].join('\n'));
  }

  try {
    await db.transaction(async (tx) => {
      for (const item of plan) {
        if (item.existing === undefined) {
          await def.create(tx, item.model, prepared.env, opts.actorUserId);
        } else {
          await def.update(tx, item.existing, item.model, prepared.env, opts.actorUserId);
        }
      }
    });
  } catch (e) {
    throw asImportConflict(e);
  }

  return { dryRun: false, ...report };
}
