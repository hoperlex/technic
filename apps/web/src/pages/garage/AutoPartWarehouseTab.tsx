import { useState } from 'react';
import { App, Button, DatePicker, Input, Space, Switch, Table, Typography } from 'antd';
import { DownloadOutlined, ToolOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import type { AutoPartWarehouseLotDto } from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { useAuth } from '@entities/session';
import { errorMessage, formatMoney } from '@shared/lib';
import { AutoPartApplicationModal } from './AutoPartApplicationModal';

const PAGE_SIZE = 50;

/** Receipt-backed stock: every row is a lot with a paper source and a derived balance. */
export function AutoPartWarehouseTab() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState<string>();
  const [inStock, setInStock] = useState(true);
  const [month, setMonth] = useState<Dayjs>(dayjs().startOf('month'));
  const [exporting, setExporting] = useState(false);
  const [applicationLot, setApplicationLot] = useState<AutoPartWarehouseLotDto | null>(null);

  const query = {
    page,
    pageSize: PAGE_SIZE,
    sortBy: 'purchasedOn',
    sortOrder: 'desc',
    search,
    inStock,
  };
  const { data, isFetching } = useQuery({
    queryKey: autoPartReceiptKeys.warehouseList(query),
    queryFn: () => autoPartReceiptApi.warehouse(query),
  });

  const exportMonth = async () => {
    setExporting(true);
    try {
      await autoPartReceiptApi.exportWarehouse(month.format('YYYY-MM'));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<AutoPartWarehouseLotDto> = [
    {
      title: 'Поступило',
      dataIndex: 'purchasedOn',
      width: 120,
      render: (value: string) => dayjs(value).format('DD.MM.YYYY'),
    },
    { title: 'Артикул', dataIndex: 'article', width: 150, render: (value: string) => value || '—' },
    { title: 'Наименование', dataIndex: 'name' },
    {
      title: 'Остаток',
      width: 150,
      render: (_, lot) => (
        <Typography.Text strong>
          {lot.remainingQuantity} {lot.unit}
        </Typography.Text>
      ),
    },
    {
      title: 'Стоимость остатка',
      width: 170,
      render: (_, lot) => formatMoney(lot.remainingAmount),
    },
    {
      title: 'Источник',
      width: 230,
      render: (_, lot) =>
        `Чек № ${lot.receiptDocumentNumber} · ${lot.sellerName || 'продавец не указан'}`,
    },
    ...(can('autoParts.manage')
      ? [
          {
            title: '',
            key: 'actions',
            width: 210,
            render: (_: unknown, lot: AutoPartWarehouseLotDto) => (
              <Button
                icon={<ToolOutlined />}
                disabled={lot.remainingQuantity === 0}
                onClick={() => setApplicationLot(lot)}
              >
                Применить к технике
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="Наименование, артикул, чек"
            style={{ width: 320 }}
            onSearch={(value) => {
              setSearch(value.trim() || undefined);
              setPage(1);
            }}
          />
          <Switch
            checked={inStock}
            checkedChildren="Только в наличии"
            unCheckedChildren="Все партии"
            onChange={(checked) => {
              setInStock(checked);
              setPage(1);
            }}
          />
        </Space>
        <Space wrap>
          <DatePicker picker="month" value={month} onChange={(value) => value && setMonth(value)} />
          <Button
            icon={<DownloadOutlined />}
            loading={exporting}
            onClick={() => void exportMonth()}
          >
            Отчёт за месяц
          </Button>
        </Space>
      </Space>

      <Table<AutoPartWarehouseLotDto>
        rowKey="lineId"
        columns={columns}
        dataSource={data?.items ?? []}
        loading={isFetching}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{ emptyText: inStock ? 'На складе нет остатка' : 'Складских партий нет' }}
      />

      <AutoPartApplicationModal lot={applicationLot} onClose={() => setApplicationLot(null)} />
    </Space>
  );
}
