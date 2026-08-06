import type { ReactNode } from 'react';
import { Button, Input, Space, Tag, Tooltip, type TableColumnType } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

/**
 * Класс ячейки, которая не отдаёт клик строке: по нему `DataTable` отличает активное содержимое
 * от читаемого (см. `opensRow`). Ставится колонкам, отданным нажатиям целиком, — кнопки и ссылки
 * внутри обычных ячеек отсекаются сами, по тегу элемента.
 */
export const NO_ROW_CLICK = 'no-row-click';

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
  /**
   * Значение поиска, заданное снаружи столбца: список открыли по ссылке, уже сузив его до одной
   * записи (журнал листов по номеру). Без него фильтр действует, но в заголовке его не видно —
   * отобранные строки выглядят отобранными неизвестно по чему и не сбрасываются.
   */
  filteredValue?: string[] | null;
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
    ...(opts.filteredValue === undefined ? {} : { filteredValue: opts.filteredValue }),
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
  /** Длинная подпись переносится внутри тега, а не растягивает колонку на одну строку. */
  multiline?: boolean;
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
      return (
        <Tag
          color={opts.colors?.[v]}
          style={
            opts.multiline
              ? {
                  whiteSpace: 'normal',
                  lineHeight: 1.25,
                  maxWidth: '100%',
                  wordBreak: 'break-word',
                }
              : undefined
          }
        >
          {opts.labels[v] ?? v}
        </Tag>
      );
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

/**
 * Действие строки на десктопе (ADR 0030): иконка с подсказкой, а не подпись словами — колонка
 * действий иначе съедает ширину, которой в списке заявок и так не хватает.
 *
 * Подпись обязана дублироваться в `aria-label`: подсказка antd попадает в разметку только после
 * наведения, и без него действие остаётся безымянным — и для чтения с экрана, и для теста.
 * Поэтому кнопка и собрана одним компонентом, а не связкой, переписываемой в каждом списке.
 *
 * Выключенная кнопка подсказку не показывает (antd гасит на ней события указателя) — там, где
 * запрет надо объяснить, оборачивайте её сами или ставьте `title` на обёртке.
 */
export function RowActionButton({
  title,
  icon,
  onClick,
  danger,
  disabled,
}: {
  title: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip title={title}>
      <Button
        size="small"
        icon={icon}
        danger={danger}
        disabled={disabled}
        aria-label={title}
        onClick={onClick}
      />
    </Tooltip>
  );
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
    // Колонка отдана нажатиям целиком: там, где строка открывается кликом, промах мимо кнопки
    // не должен открывать карточку — целятся здесь в действие, а не в запись.
    onCell: () => ({ className: NO_ROW_CLICK }),
    render: (_value: unknown, record: T) => render(record),
  };
}
