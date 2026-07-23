import { Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { requestTypeShort, type WasteRequestDto } from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { PageTableLayout } from '../../components/PageTableLayout';
import { textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { formatDate, formatDateTime } from '../../utils/format';

/**
 * Контейнеры, присутствующие или планируемые на площадках — производный вид
 * по заявкам установки (container_install), кроме отменённых. Только чтение.
 */
export function OnSiteTab() {
  const { params, onTableChange } = useListParams<Record<string, never>>(
    {},
    { searchKeys: ['objectName'] },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', 'on-site', params],
    queryFn: () =>
      wasteRequestsApi.list({
        ...params,
        requestType: 'container_install',
        excludeCancelled: 'true',
      }),
  });

  const columns = [
    textColumn<WasteRequestDto>({ key: 'objectName', title: 'Площадка', dataIndex: 'objectName' }),
    textColumn<WasteRequestDto>({
      key: 'containerTypeName',
      title: 'Тип контейнера',
      dataIndex: 'containerTypeName',
      sortable: false,
      searchable: false,
    }),
    textColumn<WasteRequestDto>({
      key: 'createdAt',
      title: 'Дата создания',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (v) => formatDate(v as string),
    }),
    textColumn<WasteRequestDto>({
      key: 'deliveryAt',
      title: 'Дата и время доставки',
      dataIndex: 'deliveryAt',
      searchable: false,
      width: 190,
      render: (v) => formatDateTime(v as string),
    }),
    {
      key: 'no',
      title: '№ заявки установки',
      dataIndex: 'id',
      width: 300,
      render: (_v: unknown, r: WasteRequestDto) => (
        <Typography.Text copyable style={{ fontSize: 12 }}>
          {`${r.id}/${requestTypeShort[r.requestType]}`}
        </Typography.Text>
      ),
    },
  ];

  return (
    <PageTableLayout>
      <DataTable<WasteRequestDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
    </PageTableLayout>
  );
}
