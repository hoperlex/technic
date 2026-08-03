import type { ListResult } from '@technic/contracts';

/**
 * Ответ списочной ручки. Портал читает `items` и `total`, а `page`/`pageSize` показывает
 * пагинацией, поэтому в фабрике они выводятся из самого списка, а не задаются вручную.
 */
export function list<T>(items: T[], overrides: Partial<ListResult<T>> = {}): ListResult<T> {
  return { items, total: items.length, page: 1, pageSize: 100, ...overrides };
}

/** Пустой список — им отвечают справочники, которые экрану не важны. */
export function emptyList<T>(): ListResult<T> {
  return list<T>([]);
}
