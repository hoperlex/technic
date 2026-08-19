import type { ReactNode } from 'react';
import type { TableColumnsType } from 'antd';

/**
 * Описания фильтров и сортировки списка для мобильного режима (ADR 0030).
 *
 * На десктопе фильтры стоят панелью над таблицей и живут произвольной разметкой; посчитать по
 * ней, сколько фильтров сейчас задано, и переложить их в шит нельзя — это набор React-элементов,
 * а не данные. Поэтому список описывает свои фильтры явно, а панель над таблицей на десктопе
 * по-прежнему собирается из тех же значений — руками страницы.
 */

export interface FilterOption {
  value: string;
  label: string;
}

/** Группа вариантов («Контейнеры», «Самосвалы») — тот же вид, что принимает Select antd. */
export interface FilterOptionGroup {
  label: string;
  options: FilterOption[];
}

export interface FilterBase {
  key: string;
  label: string;
  /** Считается ли фильтр заданным. По умолчанию — по непустому значению. */
  isActive?: boolean;
  /** Фильтр, зафиксированный ролью (объект у штаба): показывается, но не меняется. */
  disabled?: boolean;
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
      /** Границы в формате `YYYY-MM-DD`; любая может быть не задана. */
      from: string | undefined;
      to: string | undefined;
      onChange: (from: string | undefined, to: string | undefined) => void;
    })
  | (FilterBase & {
      /** Переключатель «да/нет»: показывать архив, только свои и т. п. */
      kind: 'toggle';
      value: boolean;
      onChange: (value: boolean) => void;
    });

/** Значение фильтра в черновике шита: до нажатия «Применить» в параметры списка оно не уходит. */
export type FilterDraftValue =
  | string
  | string[]
  | boolean
  | undefined
  | { from?: string; to?: string };

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
