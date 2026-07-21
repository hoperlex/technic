import { useState } from 'react';
import type { TableChange } from '../components/DataTable';
import { firstFilter } from '../utils/table';

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
  mapFilters?: (filters: TableChange['filters']) => Partial<E>;
}

/** Управление параметрами server-side таблицы (страница/размер/сортировка/поиск/фильтры). */
export function useListParams<E extends object>(initialExtra: E, opts: Options<E>) {
  const [params, setParams] = useState<BaseParams & E>({
    page: 1,
    pageSize: 100,
    sortOrder: 'desc',
    ...initialExtra,
  });

  const onTableChange = (c: TableChange) => {
    setParams((prev) => ({
      ...prev,
      page: c.page,
      pageSize: c.pageSize,
      sortBy: c.sortBy,
      sortOrder: c.sortOrder ?? 'desc',
      search: firstFilter(c.filters, opts.searchKeys),
      ...(opts.mapFilters ? opts.mapFilters(c.filters) : {}),
    }));
  };

  return { params, setParams, onTableChange };
}
