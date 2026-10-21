import type { ReactNode } from 'react';
import type { TableColumnsType } from 'antd';

/**
 * Phone filter and sort descriptors (ADR 0030). Desktop controls are arbitrary React elements,
 * so the phone sheet needs explicit values to count and present active filters.
 */

export interface FilterOption {
  value: string;
  label: string;
}

/** An option group in the shape accepted by Ant Design Select. */
export interface FilterOptionGroup {
  label: string;
  options: FilterOption[];
}

export interface FilterBase {
  key: string;
  label: string;
  /** Override the default rule that a nonempty value makes a filter active. */
  isActive?: boolean;
  /** A role-locked filter stays visible but cannot be changed. */
  disabled?: boolean;
  /** A phone sheet opens all of its visible directory selectors together. */
  onOpen?: () => void;
}

export type FilterDefinition =
  | (FilterBase & {
      kind: 'select';
      value: string | undefined;
      options: (FilterOption | FilterOptionGroup)[];
      placeholder?: string;
      loading?: boolean;
      onChange: (value: string | undefined) => void;
    })
  | (FilterBase & {
      /**
       * Набор позиций одного справочника, объединяемых по ИЛИ («покажи автокраны и самосвалы»
       * одной выдачей). Отдельного «не выбрано» у него нет: пустой набор и есть незаданный
       * фильтр, иначе каждому списку пришлось бы различать «сбросили» и «не выбирали».
       */
      kind: 'multiSelect';
      value: string[];
      options: (FilterOption | FilterOptionGroup)[];
      placeholder?: string;
      loading?: boolean;
      /** Сколько тегов видно до «+N». */
      maxTagCount?: number;
      /** Потолок набора: строка запроса конечна, и упереться в предел лучше в поле, чем в 400. */
      maxCount?: number;
      onChange: (value: string[]) => void;
    })
  | (FilterBase & {
      kind: 'text';
      value: string | undefined;
      placeholder?: string;
      onChange: (value: string | undefined) => void;
    })
  | (FilterBase & {
      kind: 'dateRange';
      /** Boundaries use `YYYY-MM-DD`; either may be absent unless the period is required. */
      from: string | undefined;
      to: string | undefined;
      /** Mandatory periods survive Reset and cannot be cleared in the sheet. */
      required?: boolean;
      onChange: (from: string | undefined, to: string | undefined) => void;
    })
  | (FilterBase & {
      /** Переключатель «да/нет»: показывать архив, только свои и т. п. */
      kind: 'toggle';
      value: boolean;
      onChange: (value: boolean) => void;
    });

/** A sheet draft stays outside list parameters until Apply. */
export type FilterDraftValue =
  string | string[] | boolean | undefined | { from?: string; to?: string };

export type FilterDraft = Record<string, FilterDraftValue>;

export interface FilterDraftControls {
  /** Dependent fields must be described from the unsubmitted phone choices. */
  deriveFilters?: (draft: FilterDraft) => FilterDefinition[];
  onDraftChange?: (draft: FilterDraft, key: string) => FilterDraft;
  /** Apply related parameters in one state update; other filters keep their own callbacks. */
  onApplyDraft?: (draft: FilterDraft) => void;
  managedKeys?: readonly string[];
}

export interface SortOption {
  /** Ключ колонки — он же поле сортировки на сервере. */
  key: string;
  label: string;
}

export interface MobilePrimaryAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

/**
 * Строка поиска в панели списка. Стоит на виду, а не в шите фильтров: в справочнике «найти по
 * названию» — самое частое действие, и прятать его за двумя касаниями значит прятать сам
 * справочник. На десктопе поиск живёт лупой в заголовке столбца — до неё там дотягиваются мышью.
 */
export interface MobileSearchControl {
  value: string | undefined;
  placeholder?: string;
  onChange: (value: string | undefined) => void;
}

export interface MobileListControls {
  search?: MobileSearchControl;
  filters?: FilterDefinition[];
  filterDraftControls?: FilterDraftControls;
  sort?: {
    options: SortOption[];
    sortBy: string | undefined;
    sortOrder: 'asc' | 'desc';
    onChange: (sortBy: string | undefined, sortOrder: 'asc' | 'desc') => void;
  };
  /** Кнопка создания: на телефоне живёт круглой кнопкой над нижней навигацией. */
  primaryAction?: MobilePrimaryAction;
  /**
   * Прочие действия списка («Маршруты» в заказе автотехники). Главное действие одно и занято
   * созданием, а десктопный слот `extra` на телефоне не рисуется вовсе — иначе такой кнопке негде
   * жить. Второй круглой кнопки не заводим: Fab читается как «создать», и двух сразу у списка быть
   * не может, поэтому место второстепенных — панель рядом с фильтрами.
   */
  secondaryActions?: MobilePrimaryAction[];
}

/** Задан ли фильтр — от этого зависит счётчик на кнопке «Фильтры». */
export function isFilterActive(filter: FilterDefinition): boolean {
  if (filter.isActive != null) return filter.isActive;
  if (filter.kind === 'dateRange') return !!filter.from || !!filter.to;
  // Выключенный переключатель — это состояние по умолчанию, а не заданный фильтр.
  if (filter.kind === 'toggle') return filter.value;
  // Пустой набор — тоже «не задан»: сам массив непустое значение, и без этой ветки счётчик на
  // кнопке «Фильтры» считал бы мультиселект заданным всегда.
  if (filter.kind === 'multiSelect') return filter.value.length > 0;
  return filter.value != null && filter.value !== '';
}

export function activeFilterCount(filters: FilterDefinition[] | undefined): number {
  return (filters ?? []).filter(isFilterActive).length;
}

/**
 * Поля сортировки берутся из самих колонок: их ключи и есть поля сортировки на сервере, а
 * заголовок колонки — уже готовая подпись. Отдельный список разошёлся бы с таблицей при первой
 * же правке колонок.
 *
 * `labels` задаёт подпись там, где заголовок колонки — разметка (две строки, значок): такую в
 * шит не поставишь, а поле сортировки при этом нужное. Ключ без подписи в список не попадает —
 * пункт «[object Object]» хуже отсутствующего.
 */
export function sortOptionsFrom<T>(
  columns: TableColumnsType<T>,
  labels: Record<string, string> = {},
): SortOption[] {
  const options: SortOption[] = [];
  for (const column of columns) {
    const key = column.key != null ? String(column.key) : '';
    const label = labels[key] ?? (typeof column.title === 'string' ? column.title : '');
    if (!key || !label || !('sorter' in column) || !column.sorter) continue;
    options.push({ key, label });
  }
  return options;
}
