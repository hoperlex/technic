import type { FilterValue } from 'antd/es/table/interface';

/** Достаёт первое значение фильтра столбца (server-side single-select). */
export function filterValue(
  filters: Record<string, FilterValue | null> | undefined,
  key: string,
): string | undefined {
  const v = filters?.[key];
  return v && v.length > 0 ? String(v[0]) : undefined;
}

/** Первое непустое значение из нескольких ключей (для объединённого поиска). */
export function firstFilter(
  filters: Record<string, FilterValue | null> | undefined,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = filterValue(filters, k);
    if (v) return v;
  }
  return undefined;
}
