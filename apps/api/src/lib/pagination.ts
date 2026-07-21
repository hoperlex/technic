import { asc, desc, ilike, or, type AnyColumn, type SQL } from 'drizzle-orm';

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
