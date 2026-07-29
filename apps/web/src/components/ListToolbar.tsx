import { useState } from 'react';
import { Badge, Button, Space } from 'antd';
import { FilterOutlined, SortAscendingOutlined } from '@ant-design/icons';
import { FilterSheet } from './FilterSheet';
import { SortSheet } from './SortSheet';
import { activeFilterCount, type MobileListControls } from './listControls';

/**
 * Панель списка на телефоне (ADR 0030): вход в фильтры и сортировку. Заменяет собой полосу
 * фильтров десктопа — шесть выпадающих списков фиксированной ширины на 360 px занимают экран
 * целиком, а заголовков колонок, по которым сортируют, в карточном списке нет вовсе.
 *
 * Счётчик на кнопке отвечает на «а не фильтром ли я себе список сузил»: сами значения скрыты в
 * шите, и без числа пустой список выглядел бы поломкой.
 */
export function ListToolbar({ filters, sort }: MobileListControls) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const count = activeFilterCount(filters);

  if (!filters?.length && !sort) return null;

  return (
    <div className="list-toolbar">
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
