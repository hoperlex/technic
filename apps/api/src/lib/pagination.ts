import { asc, desc, ilike, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { phoneSearchDigits } from '@technic/contracts';

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
  limit: number;
}

export function pageParams(q: { page: number; pageSize: number }): PageParams {
  return {
    page: q.page,
    pageSize: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    limit: q.pageSize,
  };
}

/**
 * Возвращает выражение ORDER BY по allowlist-карте колонок.
 * `sortBy` уже провалидирован zod-схемой (baseListQuery).
 */
export function orderByFrom(
  columns: Record<string, AnyColumn | SQL>,
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc',
  fallbackKey: string,
): SQL {
  const col = (sortBy && columns[sortBy]) || columns[fallbackKey]!;
  return (sortOrder === 'asc' ? asc(col) : desc(col)) as SQL;
}

/** Условие поиска: ILIKE %term% по любому из столбцов. */
export function searchCondition(term: string | undefined, cols: AnyColumn[]): SQL | undefined {
  if (!term) return undefined;
  const like = `%${term}%`;
  return or(...cols.map((c) => ilike(c, like)));
}

/**
 * Условие поиска по телефону, записанному свободно: цифры запроса ищутся в цифрах колонки, и
 * написание — скобки, пробелы, «+7» против «8» — перестаёт иметь значение (`phoneSearchDigits`).
 * `undefined` — в запросе нет номера (меньше трёх цифр), и по телефону не отбираем: иначе
 * поиск по фамилии совпал бы со всеми, у кого номер вообще заполнен.
 *
 * Класс `[^0-9]`, а не `\D`: обратный слеш в шаблонной строке JS съедается (`\D` даёт `D`), и
 * выражение молча превратилось бы в «вырезать буквы D».
 *
 * Индекса под это нет намеренно: поиск подстрокой его всё равно не использует без trgm, а учёток
 * и водителей в портале сотни — полный проход по ним дешевле, чем индекс, который надо
 * поддерживать.
 */
export function phoneSearchCondition(term: string | undefined, col: AnyColumn): SQL | undefined {
  const digits = phoneSearchDigits(term ?? '');
  if (!digits) return undefined;
  return sql`regexp_replace(${col}, '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`;
}
