import { useState } from 'react';
import { Badge, Button, Space } from 'antd';
import { FilterOutlined, SearchOutlined, SortAscendingOutlined } from '@ant-design/icons';
import { DeferredSearchInput } from './DeferredSearchInput';
import { FilterSheet } from './FilterSheet';
import { SortSheet } from './SortSheet';
import { activeFilterCount, type MobileListControls } from './listControls';

/**
 * The phone list needs a visible search and entry points for filters and sorting (ADR 0030,
 * ADR 0042). Its card layout has no column headers, and the filter sheet hides active values;
 * the badge makes the narrowed list understandable without opening the sheet.
 */
export function ListToolbar({
  search,
  filters,
  filterDraftControls,
  sort,
  secondaryActions,
}: MobileListControls) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const count = activeFilterCount(filters);
  const actions = secondaryActions ?? [];

  // A secondary action must remain visible even when the list has no search, filters, or sort.
  if (!search && !filters?.length && !sort && !actions.length) return null;

  return (
    <div className="list-toolbar">
      {search && <SearchField {...search} />}
      {(!!filters?.length || sort || !!actions.length) && (
        // Wrapping keeps the last action within the phone viewport.
        <Space size={8} wrap>
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
          {actions.map((action) => (
            <Button key={action.label} icon={action.icon} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </Space>
      )}

      {!!filters?.length && (
        <FilterSheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          filters={filters}
          draftControls={filterDraftControls}
        />
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

function SearchField({ value, placeholder, onChange }: NonNullable<MobileListControls['search']>) {
  return (
    <DeferredSearchInput
      value={value}
      prefix={<SearchOutlined />}
      placeholder={placeholder ?? 'Поиск'}
      onChange={onChange}
    />
  );
}
