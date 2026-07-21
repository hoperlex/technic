import { Table, type TableColumnsType, type TableProps } from 'antd';
import type { FilterValue, SorterResult } from 'antd/es/table/interface';
import { useElementSize } from '../hooks/useElementSize';

export interface TableChange {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filters: Record<string, FilterValue | null>;
}

interface DataTableProps<T> {
  rowKey?: string;
  columns: TableColumnsType<T>;
  data: T[];
  total: number;
  loading?: boolean;
  page: number;
  pageSize: number;
  onChange: (change: TableChange) => void;
}

// Приблизительные высоты строки заголовка и блока пагинации (для расчёта scroll.y)
const THEAD_HEIGHT = 47;
const PAGINATION_HEIGHT = 64;

export function DataTable<T extends object>(props: DataTableProps<T>) {
  const { ref, height } = useElementSize<HTMLDivElement>();
  const scrollY = Math.max(160, height - THEAD_HEIGHT - PAGINATION_HEIGHT);

  const handleChange: TableProps<T>['onChange'] = (pagination, filters, sorter) => {
    const s = (Array.isArray(sorter) ? sorter[0] : sorter) as SorterResult<T> | undefined;
    const sortOrder =
      s?.order === 'ascend' ? 'asc' : s?.order === 'descend' ? 'desc' : undefined;
    const sortBy = sortOrder ? String(s?.columnKey ?? s?.field ?? '') : undefined;
    props.onChange({
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? props.pageSize,
      sortBy,
      sortOrder,
      filters,
    });
  };

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
        pagination={{
          current: props.page,
          pageSize: props.pageSize,
          total: props.total,
          showSizeChanger: true,
          pageSizeOptions: ['100', '200', '500'],
          showTotal: (t) => `Всего: ${t}`,
        }}
      />
    </div>
  );
}
