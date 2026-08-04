import type { FilterValue } from 'antd/es/table/interface';

/**
 * Что список сообщает о своей перерисовке: страница, размер, порядок и фильтры столбцов.
 *
 * Протокол живёт здесь, а не в самой таблице: им пользуется и хук параметров списка, а «хук
 * смотрит в компонент» — направление, которого в нижнем слое быть не должно. Правило границ его и
 * запрещает, поэтому общее знание вынесено вниз, к обоим потребителям.
 */
export interface TableChange {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Не задано — фильтры не менялись (листание на телефоне), а не «сброшены». */
  filters?: Record<string, FilterValue | null>;
}

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
