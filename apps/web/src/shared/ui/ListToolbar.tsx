import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Input, Space } from 'antd';
import { FilterOutlined, SearchOutlined, SortAscendingOutlined } from '@ant-design/icons';
import { FilterSheet } from './FilterSheet';
import { SortSheet } from './SortSheet';
import { activeFilterCount, type MobileListControls } from './listControls';

/** Пауза перед запросом: список не дёргается на каждую букву, но и жать «Найти» не приходится. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Панель списка на телефоне (ADR 0030, ADR 0042): строка поиска плюс вход в фильтры и сортировку.
 * Заменяет собой полосу фильтров десктопа — шесть выпадающих списков фиксированной ширины на
 * 360 px занимают экран целиком, а заголовков колонок, по которым сортируют и ищут, в карточном
 * списке нет вовсе.
 *
 * Счётчик на кнопке отвечает на «а не фильтром ли я себе список сузил»: сами значения скрыты в
 * шите, и без числа пустой список выглядел бы поломкой.
 */
export function ListToolbar({ search, filters, sort }: MobileListControls) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const count = activeFilterCount(filters);

  if (!search && !filters?.length && !sort) return null;

  return (
    <div className="list-toolbar">
      {search && <SearchField {...search} />}
      {(!!filters?.length || sort) && (
        <Space size={8}>
          {!!filters?.length && (
            <Badge count={count} size="small" offset={[-4, 2]}>
              <Button icon={<FilterOutlined />} onClick={() => setFiltersOpen(true)}>
                Фильтры
              </Button>
            </Badge>
          )}
          {sort && (
            <Button icon={<SortAscendingOutlined />} onClick={() => setSortOpen(true)}>
              Сортировка
            </Button>
          )}
        </Space>
      )}

      {!!filters?.length && (
        <FilterSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} filters={filters} />
      )}
      {sort && (
        <SortSheet
          open={sortOpen}
          onClose={() => setSortOpen(false)}
          options={sort.options}
          sortBy={sort.sortBy}
          sortOrder={sort.sortOrder}
          onApply={sort.onChange}
        />
      )}
    </div>
  );
}

/**
 * Поле поиска с собственным текстом: буквы появляются сразу, а список перезапрашивается с
 * задержкой. Без локального состояния каждый набранный знак ждал бы ответа сервера, и курсор
 * прыгал бы на перерисовке.
 */
function SearchField({ value, placeholder, onChange }: NonNullable<MobileListControls['search']>) {
  const [text, setText] = useState(value ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Внешний сброс (например, возврат к пустому фильтру) перебивает набранное.
  useEffect(() => setText(value ?? ''), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (next: string) => onChange(next.trim() || undefined);

  return (
    <Input
      allowClear
      value={text}
      prefix={<SearchOutlined />}
      placeholder={placeholder ?? 'Поиск'}
      onChange={(e) => {
        setText(e.target.value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => send(e.target.value), SEARCH_DEBOUNCE_MS);
      }}
      // Enter отправляет набранное сразу: ждать паузу после явного действия незачем.
      onPressEnter={() => {
        clearTimeout(timer.current);
        send(text);
      }}
    />
  );
}
