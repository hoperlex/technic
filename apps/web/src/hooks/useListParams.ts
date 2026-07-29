import { useEffect, useRef, useState } from 'react';
import type { TableChange } from '../components/DataTable';
import { firstFilter } from '../utils/table';
import { useIsMobile } from './useIsMobile';

export interface BaseParams {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  // индекс-сигнатура: объект параметров пригоден как query для apiFetch
  [key: string]: unknown;
}

interface Options<E> {
  searchKeys: string[];
  mapFilters?: (filters: NonNullable<TableChange['filters']>) => Partial<E>;
}

const DESKTOP_PAGE_SIZE = 100;
/**
 * На телефоне страница меньше (ADR 0030): карточка занимает столько же места, сколько десяток
 * строк таблицы, и сотня записей — это метры прокрутки и лишний трафик. Размер задаётся здесь,
 * а не в таблице: иначе список показывал бы одно число, а запрос уходил бы с другим.
 */
const MOBILE_PAGE_SIZE = 50;

/** Управление параметрами server-side таблицы (страница/размер/сортировка/поиск/фильтры). */
export function useListParams<E extends object>(initialExtra: E, opts: Options<E>) {
  const isMobile = useIsMobile();
  const [params, setParams] = useState<BaseParams & E>({
    page: 1,
    pageSize: isMobile ? MOBILE_PAGE_SIZE : DESKTOP_PAGE_SIZE,
    sortOrder: 'desc',
    ...initialExtra,
  });

  // Размер страницы меняется только при смене режима: выбранный вручную (200, 500) переживает
  // любые перерисовки, а после поворота планшета список начинается с первой страницы — номер
  // страницы при другом размере означал бы уже другие записи.
  const wasMobile = useRef(isMobile);
  useEffect(() => {
    if (wasMobile.current === isMobile) return;
    wasMobile.current = isMobile;
    setParams((prev) => ({
      ...prev,
      page: 1,
      pageSize: isMobile ? MOBILE_PAGE_SIZE : DESKTOP_PAGE_SIZE,
    }));
  }, [isMobile]);

  /**
   * Смена сортировки из шита на телефоне (ADR 0030): список возвращается на первую страницу —
   * та же страница при другом порядке означала бы уже другие записи.
   */
  const setSort = (sortBy: string | undefined, sortOrder: 'asc' | 'desc') =>
    setParams((prev) => ({ ...prev, sortBy, sortOrder, page: 1 }) as BaseParams & E);

  const onTableChange = (c: TableChange) => {
    setParams((prev) => ({
      ...prev,
      page: c.page,
      pageSize: c.pageSize,
      sortBy: c.sortBy,
      sortOrder: c.sortOrder ?? 'desc',
      // Фильтры приходят от таблицы: их отсутствие означает «не менялись» (листание на телефоне),
      // а не «сброшены» — иначе следующая страница теряла бы поиск по столбцу.
      ...(c.filters
        ? {
            search: firstFilter(c.filters, opts.searchKeys),
            ...(opts.mapFilters ? opts.mapFilters(c.filters) : {}),
          }
        : {}),
    }));
  };

  return { params, setParams, setSort, onTableChange };
}
