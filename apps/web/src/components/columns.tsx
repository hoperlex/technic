import type { ReactNode } from 'react';
import { Button, Input, Space, Tag, type TableColumnType } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

/** Поисковый filterDropdown в заголовке столбца (server-side поиск). */
function searchableHeader<T>(placeholder = 'Поиск'): Partial<TableColumnType<T>> {
  return {
    filterIcon: (filtered: boolean) => (
      <SearchOutlined style={{ color: filtered ? '#1677ff' : undefined }} />
    ),
    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => (
      <div style={{ padding: 8 }} onKeyDown={(e) => e.stopPropagation()}>
        <Input
          autoFocus
          placeholder={placeholder}
          value={selectedKeys[0] as string}
          onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
          onPressEnter={() => confirm()}
          style={{ marginBottom: 8, display: 'block', width: 220 }}
        />
        <Space>
          <Button type="primary" size="small" icon={<SearchOutlined />} onClick={() => confirm()}>
            Найти
          </Button>
          <Button
            size="small"
            onClick={() => {
              clearFilters?.();
              confirm();
            }}
          >
            Сброс
          </Button>
        </Space>
      </div>
    ),
  };
}

export function textColumn<T>(opts: {
  key: string;
  title: string;
  dataIndex: string;
  sortable?: boolean;
  searchable?: boolean;
  width?: number;
  ellipsis?: boolean;
  render?: (value: unknown, record: T) => ReactNode;
}): TableColumnType<T> {
  return {
    key: opts.key,
    title: opts.title,
    dataIndex: opts.dataIndex,
    sorter: opts.sortable === false ? undefined : true,
    ...(opts.searchable === false ? {} : searchableHeader<T>()),
    width: opts.width,
    ellipsis: opts.ellipsis,
    render: opts.render,
  };
}

export function badgeColumn<T>(opts: {
  key: string;
  title: string;
  dataIndex: string;
  labels: Record<string, string>;
  colors?: Record<string, string>;
  filters?: boolean;
  sortable?: boolean;
  width?: number;
}): TableColumnType<T> {
  const filterList = opts.filters
    ? Object.entries(opts.labels).map(([value, text]) => ({ text, value }))
    : undefined;
  return {
    key: opts.key,
    title: opts.title,
    dataIndex: opts.dataIndex,
    sorter: opts.sortable === false ? undefined : true,
    filters: filterList,
    filterMultiple: false,
    width: opts.width,
    render: (value: unknown) => {
      const v = value as string | null;
      if (v == null) return '—';
      return <Tag color={opts.colors?.[v]}>{opts.labels[v] ?? v}</Tag>;
    },
  };
}

export function boolBadgeColumn<T>(opts: {
  key: string;
  title: string;
  dataIndex: string;
  trueText: string;
  falseText: string;
  filters?: boolean;
  width?: number;
}): TableColumnType<T> {
  return {
    key: opts.key,
    title: opts.title,
    dataIndex: opts.dataIndex,
    sorter: true,
    width: opts.width,
    filters: opts.filters
      ? [
          { text: opts.trueText, value: 'true' },
          { text: opts.falseText, value: 'false' },
        ]
      : undefined,
    filterMultiple: false,
    render: (value: unknown) => (
      <Tag color={value ? 'green' : 'default'}>{value ? opts.trueText : opts.falseText}</Tag>
    ),
  };
}

export function actionsColumn<T>(
  render: (record: T) => ReactNode,
  width = 130,
): TableColumnType<T> {
  return {
    key: 'actions',
    title: 'Действия',
    fixed: 'right',
    width,
    render: (_value: unknown, record: T) => render(record),
  };
}
