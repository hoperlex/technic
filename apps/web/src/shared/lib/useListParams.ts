import { useEffect, useRef, useState } from 'react';
import type { TableChange } from './table';
import { DESKTOP_PAGE_SIZE, MOBILE_PAGE_SIZE } from '@shared/config';
import { firstFilter } from './table';
import { useIsMobile } from './useIsMobile';
import {
  readListParams,
  writeListParams,
  type ListMode,
  type ListParamsScope,
} from './listParamsStore';

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
  /**
   * Ключи, которые список считает отборами. Из них строится «Сбросить» и признак «отбор задан», их
   * же запоминает `persist`.
   *
   * Перечислять приходится явно: `initialExtra` у таких списков пуст — отборы заводятся не
   * умолчанием, а первым выбором человека, — и сам хук не знает, что у него за поля.
   */
  filterKeys?: readonly Extract<keyof E, string>[];
  /**
   * Набор переживает перезагрузку и повторный вход (ADR 0139). Имя набора обязано быть
   * постоянным: это ключ в хранилище, а не заголовок вкладки.
   *
   * Учётка приходит извне: `shared` не знает ни о правах, ни о том, кто смотрит, — а ключ без
   * учётки подставлял бы сменщику за общим компьютером чужой срез.
   */
  persist?: { scope: string; userId: string | undefined };
}

/** Управление параметрами server-side таблицы (страница/размер/сортировка/поиск/фильтры). */
export function useListParams<E extends object>(initialExtra: E, opts: Options<E>) {
  const isMobile = useIsMobile();
  const mode: ListMode = isMobile ? 'mobile' : 'desktop';
  const defaultPageSize = isMobile ? MOBILE_PAGE_SIZE : DESKTOP_PAGE_SIZE;

  /**
   * Настройки читаются через ref, а не из замыкания эффекта: `opts` пересобирается на каждом
   * рендере страницы, и в зависимостях эффекта он означал бы запись в хранилище на каждый рендер.
   */
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const storeOf = (): ListParamsScope | null =>
    optsRef.current.persist
      ? { ...optsRef.current.persist, fields: optsRef.current.filterKeys ?? [] }
      : null;

  const [params, setParams] = useState<BaseParams & E>(() => {
    const base = {
      page: 1,
      pageSize: defaultPageSize,
      sortOrder: 'desc',
      ...initialExtra,
    } as BaseParams & E;
    const store = storeOf();
    const saved = store ? readListParams(store, mode) : null;
    if (!saved) return base;
    // Страница не восстанавливается никогда: вчерашняя третья страница сегодня — уже другие
    // записи, и открывать список с её середины значило бы соврать про «вот ваш срез».
    return {
      ...base,
      ...saved.filters,
      ...(saved.sortBy ? { sortBy: saved.sortBy, sortOrder: saved.sortOrder ?? 'desc' } : {}),
      ...(saved.pageSize ? { pageSize: saved.pageSize } : {}),
    };
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
   * Запись набора. Сравнение с записанным — не бережливость: параметры меняются и от листания, а
   * страница с поиском в набор не входят, и без сравнения каждый шаг по страницам переписывал бы
   * ту же самую запись, обновляя ей срок жизни.
   *
   * Поиск не сохраняется намеренно: «где этот аппарат» — разовый вопрос, и строка, встретившая
   * человека утром, читалась бы как поломка списка, а не как его собственный вчерашний ввод.
   */
  const written = useRef<string | null>(null);
  useEffect(() => {
    const store = storeOf();
    if (!store) return;
    const filters: Record<string, string> = {};
    for (const field of store.fields) {
      const value = params[field];
      if (typeof value === 'string' && value) filters[field] = value;
    }
    const snapshot = {
      mode,
      filters,
      sortBy: params.sortBy,
      sortOrder: params.sortBy ? params.sortOrder : undefined,
      pageSize: params.pageSize === defaultPageSize ? undefined : params.pageSize,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === written.current) return;
    written.current = serialized;
    writeListParams(store, snapshot);
  }, [params, mode, defaultPageSize]);

  /**
   * Смена сортировки из шита на телефоне (ADR 0030): список возвращается на первую страницу —
   * та же страница при другом порядке означала бы уже другие записи.
   */
  const setSort = (sortBy: string | undefined, sortOrder: 'asc' | 'desc') =>
    setParams((prev) => ({ ...prev, sortBy, sortOrder, page: 1 }) as BaseParams & E);

  /**
   * Задан ли хоть один отбор. Считается по тем же ключам, что снимает «Сбросить»: кнопка,
   * появляющаяся когда сбрасывать нечего, — обещание без содержания.
   */
  const filtersActive = (opts.filterKeys ?? []).some((key) => {
    const value = params[key];
    return value !== undefined && value !== '' && value !== false;
  });

  /**
   * Выход из набора одним движением. Снимает отборы, но не сортировку, не размер страницы и не
   * поиск: сброс здесь означает «покажи всё», а не «забудь, как я смотрю на список», — и ровно
   * это же делает «Сбросить» в шите фильтров на телефоне.
   */
  const resetFilters = () =>
    setParams((prev) => {
      const next: BaseParams & E = { ...prev, page: 1 };
      for (const key of optsRef.current.filterKeys ?? []) {
        (next as Record<string, unknown>)[key] = undefined;
      }
      return next;
    });

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
            // Поиск трогаем, только если он и правда живёт в заголовке столбца: таблица шлёт
            // объект фильтров даже когда искать в ней негде, и без этой проверки любая сортировка
            // сбрасывала бы строку поиска, набранную в панели над таблицей.
            ...(opts.searchKeys.length > 0
              ? { search: firstFilter(c.filters, opts.searchKeys) }
              : {}),
            ...(opts.mapFilters ? opts.mapFilters(c.filters) : {}),
          }
        : {}),
    }));
  };

  return { params, setParams, setSort, onTableChange, filtersActive, resetFilters };
}
