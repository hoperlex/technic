import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  Empty,
  Pagination,
  Skeleton,
  Table,
  Typography,
  type TableColumnsType,
  type TableProps,
} from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import type { SorterResult } from 'antd/es/table/interface';
import { PAGE_SIZE_OPTIONS } from '@shared/config';
import type { TableChange } from '@shared/lib';
import { useElementSize } from '@shared/lib';
import { useIsMobile } from '@shared/lib';
import { ActionSheet, type ActionSheetItem } from './ActionSheet';
import { NO_ROW_CLICK } from './columns';

/**
 * Карточное представление строки на телефоне (ADR 0030). Объявляется рядом с колонками и из тех
 * же полей записи: данные у списка одни, меняется только способ их показать.
 */
export interface CardConfig<T> {
  /** Первая строка слева — обычно номер записи. */
  title: (record: T) => ReactNode;
  /** Первая строка справа: статус или другой бейдж. */
  badge?: (record: T) => ReactNode;
  /** Главная строка карточки: объект, наименование. */
  primary?: (record: T) => ReactNode;
  /** Дополнительные строки; пустые пропускаются. */
  lines?: ((record: T) => ReactNode)[];
  /** Действия строки списком с подписями: подсказка на иконке по касанию не открывается. */
  actions?: (record: T) => ActionSheetItem[];
  /** Касание по карточке — обычно открыть карточку записи. */
  onOpen?: (record: T) => void;
}

interface DataTableProps<T> {
  rowKey?: string;
  columns: TableColumnsType<T>;
  data: T[];
  total: number;
  loading?: boolean;
  page: number;
  pageSize: number;
  /** Текущая сортировка: нужна, чтобы листание на телефоне её не сбрасывало. */
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Есть — на телефоне список показывается карточками; нет — таблицей с прокруткой вбок. */
  card?: CardConfig<T>;
  /**
   * Клик по строке таблицы — обычно открыть карточку записи. Ячейки с активным содержимым его
   * не отдают (см. `opensRow`): нажатие на визу, статус или действие делает своё дело, а не
   * открывает карточку заодно. На телефоне то же самое делает `card.onOpen`.
   */
  onRowClick?: (record: T) => void;
  onChange: (change: TableChange) => void;
}

// Приблизительные высоты строки заголовка и блока пагинации (для расчёта scroll.y)
const THEAD_HEIGHT = 47;
const PAGINATION_HEIGHT = 64;

/**
 * Справочник на телефоне остаётся таблицей (ADR 0030): его читают сравнением строк, и прокрутка
 * вбок честнее карточки, в которой сравнивать нечего. Но колонка действий, закреплённая справа,
 * съедала бы там треть экрана, поэтому она уезжает в конец строки, а якорем становится первая
 * колонка — по ней и видно, чья это строка.
 */
function compactColumns<T>(columns: TableColumnsType<T>): TableColumnsType<T> {
  return columns.map((column, index) => {
    const next = { ...column };
    if (next.fixed === 'right') next.fixed = undefined;
    // Колонку без ширины antd закрепить не может — она и не закрепляется.
    if (index === 0 && next.width != null) next.fixed = 'left';
    return next;
  });
}

/**
 * Отдаёт ли этот клик строку тому, кто её открывает. Карточку записи открывают кликом по строке —
 * это короче, чем целиться в кнопку колонки «Действия», — но строка полна активного содержимого,
 * и открывать её поверх каждого нажатия нельзя.
 *
 * Отсекаются три случая:
 *
 * — клик из портала. Меню статуса и поповер файлов antd рисует в конце `body`, но в дереве React
 *   они остались детьми ячейки, и событие всплывает до строки, хотя в DOM лежит вне её. Без
 *   проверки принадлежности выбор пункта меню открывал бы заодно карточку;
 * — клик по управляющему элементу (кнопка, ссылка, поле) и по ячейке, помеченной `NO_ROW_CLICK`:
 *   колонка действий целиком отдана нажатиям, и промах мимо кнопки открытием карточки не считают;
 * — клик, которым кончилось выделение текста: адрес или комментарий копировали, а не открывали.
 */
function opensRow(e: MouseEvent<HTMLElement>): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || !e.currentTarget.contains(target)) return false;
  if (target.closest(`button, a, input, textarea, label, .ant-select, .${NO_ROW_CLICK}`)) {
    return false;
  }
  return !window.getSelection()?.toString();
}

function ListCard<T>({ record, card }: { record: T; card: CardConfig<T> }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actions = card.actions?.(record) ?? [];
  const lines = (card.lines ?? []).map((line) => line(record)).filter(Boolean);
  const openable = !!card.onOpen;

  return (
    <div
      className={`list-card${openable ? ' list-card--openable' : ''}`}
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={openable ? () => card.onOpen?.(record) : undefined}
      onKeyDown={
        openable
          ? (e) => {
              if (e.key === 'Enter') card.onOpen?.(record);
            }
          : undefined
      }
    >
      <div className="list-card__head">
        <Typography.Text strong>{card.title(record)}</Typography.Text>
        <div className="list-card__badge">{card.badge?.(record)}</div>
      </div>
      {card.primary && <div className="list-card__primary">{card.primary(record)}</div>}
      {lines.map((line, index) => (
        <div key={index} className="list-card__line">
          {line}
        </div>
      ))}
      {actions.length > 0 && (
        <>
          <button
            type="button"
            className="list-card__more"
            aria-label="Действия"
            // Касание по меню не должно заодно открывать саму карточку.
            onClick={(e) => {
              e.stopPropagation();
              setActionsOpen(true);
            }}
          >
            <MoreOutlined />
          </button>
          <ActionSheet open={actionsOpen} onClose={() => setActionsOpen(false)} items={actions} />
        </>
      )}
    </div>
  );
}

/** Протокол перерисовки списка живёт в `shared/lib`; здесь он переэкспортируется для удобства. */
export type { TableChange };

export function DataTable<T extends object>(props: DataTableProps<T>) {
  const { ref, height } = useElementSize<HTMLDivElement>();
  const isMobile = useIsMobile();
  const scrollY = Math.max(160, height - THEAD_HEIGHT - PAGINATION_HEIGHT);

  const handleChange: TableProps<T>['onChange'] = (pagination, filters, sorter) => {
    const s = (Array.isArray(sorter) ? sorter[0] : sorter) as SorterResult<T> | undefined;
    const sortOrder = s?.order === 'ascend' ? 'asc' : s?.order === 'descend' ? 'desc' : undefined;
    const sortBy = sortOrder ? String(s?.columnKey ?? s?.field ?? '') : undefined;
    props.onChange({
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? props.pageSize,
      sortBy,
      sortOrder,
      filters,
    });
  };

  /** Листание на телефоне не трогает ни сортировку, ни фильтры — их меняют своими шитами. */
  const changePage = (page: number, pageSize: number) =>
    props.onChange({ page, pageSize, sortBy: props.sortBy, sortOrder: props.sortOrder });

  const onRowClick = props.onRowClick;
  const rowProps: Pick<TableProps<T>, 'onRow' | 'rowClassName'> = onRowClick
    ? {
        onRow: (record) => ({
          onClick: (e) => {
            if (opensRow(e)) onRowClick(record);
          },
        }),
        rowClassName: 'data-row--clickable',
      }
    : {};

  if (isMobile) {
    const pager = (
      <div className="list-pager">
        <Typography.Text type="secondary">Всего: {props.total}</Typography.Text>
        <Pagination
          simple
          size="small"
          current={props.page}
          pageSize={props.pageSize}
          total={props.total}
          onChange={changePage}
        />
      </div>
    );

    if (props.card) {
      const card = props.card;
      const rowKey = props.rowKey ?? 'id';
      return (
        <div className="list-cards">
          {props.loading && props.data.length === 0 ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : props.data.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Ничего не найдено" />
          ) : (
            props.data.map((record) => (
              <ListCard
                key={String((record as Record<string, unknown>)[rowKey])}
                record={record}
                card={card}
              />
            ))
          )}
          {props.total > 0 && pager}
        </div>
      );
    }

    return (
      <div className="list-scroll-table">
        <Table<T>
          rowKey={props.rowKey ?? 'id'}
          columns={compactColumns(props.columns)}
          dataSource={props.data}
          loading={props.loading}
          size="small"
          scroll={{ x: 'max-content' }}
          onChange={handleChange}
          pagination={false}
          {...rowProps}
        />
        {props.total > 0 && pager}
      </div>
    );
  }

  return (
    <div ref={ref} style={{ height: '100%' }}>
      <Table<T>
        rowKey={props.rowKey ?? 'id'}
        columns={props.columns}
        dataSource={props.data}
        loading={props.loading}
        size="middle"
        sticky
        scroll={{ y: scrollY, x: 'max-content' }}
        onChange={handleChange}
        {...rowProps}
        pagination={{
          current: props.page,
          pageSize: props.pageSize,
          total: props.total,
          showSizeChanger: true,
          pageSizeOptions: PAGE_SIZE_OPTIONS.map(String),
          showTotal: (t) => `Всего: ${t}`,
        }}
      />
    </div>
  );
}
