import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Empty,
  Pagination,
  Skeleton,
  Table,
  Typography,
  type TableColumnsType,
  type TableProps,
} from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import { PAGE_SIZE_OPTIONS } from '@shared/config';
import type { TableChange } from '@shared/lib';
import { useElementSize } from '@shared/lib';
import { useIsMobile } from '@shared/lib';
import { ListCard, opensRow, type CardConfig } from './ListCard';
import { useScopedSelection, withSelectionColumn, type SelectionConfig } from './tableSelection';

/**
 * Выбор строк живёт своим модулем, но входом в сегмент остаётся `@shared/ui`: контракт и помощник
 * отпечатка списки берут оттуда же, откуда сам `DataTable`.
 */
export { listScopeKey, type SelectionConfig } from './tableSelection';

export type { CardConfig } from './ListCard';

interface DataTableProps<T> {
  rowKey?: string;
  columns: TableColumnsType<T>;
  data: T[];
  total: number;
  loading?: boolean;
  /** Rows still belong to the preceding query while the next page or filter loads. */
  isPlaceholderData?: boolean;
  page: number;
  pageSize: number;
  /** Выбор строк для действия над несколькими сразу; нет — списку он не нужен. */
  selection?: SelectionConfig<T>;
  /** Текущая сортировка: нужна, чтобы листание на телефоне её не сбрасывало. */
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Есть — на телефоне список показывается карточками; нет — таблицей с прокруткой вбок. */
  card?: CardConfig<T>;
  /**
   * Нижняя граница ширины таблицы в пикселях: сумма заданных `width` плюс минимум той колонке,
   * у которой ширины нет. Число уходит в `scroll.x`, и таблица получает от rc-table стиль
   * `width: <n>px; min-width: 100%` (`scrollTableStyle` в `@rc-component/table/es/Table.js`),
   * то есть ведёт себя по-разному с двух сторон от этого числа.
   *
   * Контейнер шире числа — побеждает `min-width`: таблица занимает контейнер целиком, колонки с
   * `width` берут своё, а колонка без `width` забирает остаток. Ради этого проп и появился:
   * список, который читают целиком, лучше видеть без прокрутки вбок — колонку, уехавшую за правый
   * край, в нём просто не находят.
   *
   * Контейнер уже числа — побеждает `width`, и прокрутка вбок возвращается. Это не отказ, а
   * осознанный размен: узкое окно на десктопе не экзотика (1366 при масштабе Windows 125 % — это
   * 1092 CSS-px, окно на половину FHD — 960, а `useIsMobile` смотрит на устройство, а не на
   * ширину), и прокрутка с читаемыми колонками честнее, чем графа без `width`, схлопнутая на
   * такой ширине в полоску из паддингов.
   *
   * Нет пропа — `x: 'max-content'`: ширину диктует содержимое, как у остальных списков.
   */
  fitWidth?: number;
  /**
   * Клик по строке таблицы — обычно открыть карточку записи. Ячейки с активным содержимым его
   * не отдают (см. `opensRow`): нажатие на визу, статус или действие делает своё дело, а не
   * открывает карточку заодно. На телефоне то же самое и по тому же правилу делает `card.onOpen`:
   * список для человека один, и открываться он должен одинаково с любого экрана.
   */
  onRowClick?: (record: T) => void;
  onChange: (change: TableChange) => void;
  /**
   * A summary row under the list: a ready `Table.Summary` element from the page, not a function of
   * the data. rc-table would pass such a function only the rows of the current page, while a total
   * must come from the server — the page prints it, the table adds nothing up. Give `Table.Summary`
   * with `fixed` to pin it under the scrolling body; the table then measures its height and leaves
   * room for it. Not combined with `selection`: the selection column shifts cell indexes.
   */
  summary?: ReactNode;
}

// Approximate heights of the header row and the pagination block, for `scroll.y`.
const THEAD_HEIGHT = 47;
const PAGINATION_HEIGHT = 64;

/**
 * Height of the scrolling body: the container minus the header, the pagination and a pinned
 * summary, never below 160 px. A pure function because the heights cannot be observed in jsdom
 * (`ResizeObserver` is a stub there), and the formula still needs a test.
 */
export function tableScrollY(height: number, summaryHeight: number): number {
  return Math.max(160, height - THEAD_HEIGHT - PAGINATION_HEIGHT - summaryHeight);
}

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

/** Протокол перерисовки списка живёт в `shared/lib`; здесь он переэкспортируется для удобства. */
export type { TableChange };

export function DataTable<T extends object>(props: DataTableProps<T>) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const isMobile = useIsMobile();
  const rowKey = props.rowKey ?? 'id';
  /** Выбор гасится при смене того, что видно: правило общее для портала, см. `scopeKey`. */
  const scopedSelection = useScopedSelection(props.selection);
  // A placeholder row belongs to the old query. Keeping checkboxes usable could send its IDs to
  // a bulk command for the new filter, even when the selection scope has already been cleared.
  const selection =
    scopedSelection && props.isPlaceholderData
      ? {
          ...scopedSelection,
          keys: [],
          onChange: () => {},
          disabled: () => 'Дождитесь обновления списка',
        }
      : scopedSelection;
  const mobileListRef = useRef<HTMLDivElement>(null);
  const previousPage = useRef(props.page);
  useLayoutEffect(() => {
    if (previousPage.current !== props.page && isMobile) {
      const body = mobileListRef.current?.closest<HTMLElement>('.mobile-page__body');
      if (body) body.scrollTop = 0;
    }
    previousPage.current = props.page;
  }, [props.page, isMobile]);
  // An explicit check rather than a type: a summary beside the selection column would misalign.
  const summary = selection ? undefined : props.summary;
  /*
   * Height of the pinned summary, measured from the DOM. `useElementSize` cannot do it — it
   * subscribes once on mount, while the summary holder is an inner node of rc-table that appears
   * only after the data — and a constant from the page cannot either: the page does not know how its
   * captions wrap. The effect runs before the `isMobile` branch (rules of hooks) and re-reads the
   * height on every change of the summary or of the container size; the state changes only when the
   * number does, and the summary height does not depend on `scrollY`, so there is no loop. Without a
   * summary nothing is read, and every other list gets the same number as before.
   */
  const [summaryHeight, setSummaryHeight] = useState(0);
  useLayoutEffect(() => {
    const next =
      summary && !isMobile
        ? (ref.current?.querySelector<HTMLElement>('div.ant-table-summary')?.offsetHeight ?? 0)
        : 0;
    setSummaryHeight((prev) => (prev === next ? prev : next));
  }, [summary, isMobile, ref, width, height]);
  const scrollY = tableScrollY(height, summaryHeight);
  const columns = selection
    ? withSelectionColumn(props.columns, selection, props.data, rowKey)
    : props.columns;
  /** Полоса выбора: появляется, только когда выбрана хотя бы одна строка. */
  const selectionBar =
    selection && selection.keys.length > 0 ? selection.bar(selection.keys) : null;

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
    /*
     * Полоса выбора показывается только там, где есть чем выбирать. Карточка списка чекбокса не
     * имеет вовсе, и «Выбрано 3» над карточками — управление тем, чего на этом экране ни снять,
     * ни добавить: выбор туда попадает с десктопа того же сеанса. Справочник, который на телефоне
     * остаётся таблицей, колонку выбора сохраняет — там полоса при деле.
     */
    const bar = props.card ? null : selectionBar;
    const pager = (
      <>
        {bar && <div className="list-pager list-pager--selection">{bar}</div>}
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
      </>
    );

    if (props.card) {
      const card = props.card;
      return (
        <div
          ref={mobileListRef}
          className={`list-cards${props.loading && props.data.length > 0 ? ' list-cards--loading' : ''}`}
          aria-busy={props.loading}
        >
          {props.loading && props.data.length > 0 && (
            <div className="list-cards__loading" role="status">
              Загрузка…
            </div>
          )}
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
          rowKey={rowKey}
          columns={compactColumns(columns)}
          dataSource={props.data}
          loading={props.loading}
          size="small"
          scroll={{ x: 'max-content' }}
          summary={summary ? () => summary : undefined}
          onChange={handleChange}
          pagination={false}
          // Подсказка сортировки выключена, как и в таблице ниже.
          showSorterTooltip={false}
          {...rowProps}
        />
        {props.total > 0 && pager}
      </div>
    );
  }

  /**
   * Со списком, где выбирают строки, пагинацию рисуем сами: полоса выбора обязана стоять на том же
   * уровне, что и управление страницами, — выбор относится ко всему списку, а не к одной строке.
   * Встроенная пагинация antd соседа рядом с собой не пускает.
   */
  const pagination = {
    current: props.page,
    pageSize: props.pageSize,
    total: props.total,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS.map(String),
    showTotal: (t: number) => `Всего: ${t}`,
  };

  return (
    <div ref={ref} style={{ height: '100%' }}>
      <Table<T>
        rowKey={rowKey}
        columns={columns}
        dataSource={props.data}
        loading={props.loading}
        size="middle"
        sticky
        scroll={{ y: scrollY, x: props.fitWidth ?? 'max-content' }}
        summary={summary ? () => summary : undefined}
        onChange={handleChange}
        /* Подсказка «Нажмите для сортировки по возрастанию» убрана совсем, а не спрятана стилями:
           с `false` antd не оборачивает заголовок в `Tooltip` вовсе, и всплывать нечему. Она
           пересказывала словами то, что уже сказано стрелкой у названия графы, а раскрывалась
           вверх — накрывая строку фильтров над шапкой ровно тогда, когда до неё тянутся мышью. */
        showSorterTooltip={false}
        {...rowProps}
        pagination={selection ? false : pagination}
      />
      {selection && (
        <div className="table-footer">
          <div className="table-footer__bar">{selectionBar}</div>
          <Pagination
            {...pagination}
            align="end"
            onChange={changePage}
            onShowSizeChange={changePage}
          />
        </div>
      )}
    </div>
  );
}
