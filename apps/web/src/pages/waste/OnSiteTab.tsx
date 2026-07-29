import { Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { requestTypeShort, type WasteRequestDto } from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { DataTable, type CardConfig } from '../../components/DataTable';
import { PageTableLayout } from '../../components/PageTableLayout';
import { sortOptionsFrom } from '../../components/listControls';
import { textColumn } from '../../components/columns';
import { useListParams } from '../../hooks/useListParams';
import { formatDate, formatDateTimeMaybe } from '../../utils/format';

/**
 * Контейнеры, присутствующие или планируемые на площадках — производный вид
 * по заявкам установки (container_install), кроме отменённых. Только чтение.
 */
export function OnSiteTab() {
  const { params, setSort, onTableChange } = useListParams<Record<string, never>>(
    {},
    { searchKeys: ['objectName'] },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', 'present', params],
    queryFn: () => wasteRequestsApi.present(params),
  });

  const columns = [
    textColumn<WasteRequestDto>({ key: 'objectName', title: 'Площадка', dataIndex: 'objectName' }),
    textColumn<WasteRequestDto>({
      key: 'containerTypeName',
      title: 'Тип контейнера',
      dataIndex: 'containerTypeName',
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
      render: (v, r) => formatDateTimeMaybe(v as string, r.deliveryTimeUnspecified),
    }),
    {
      key: 'num',
      title: '№ заявки установки',
      dataIndex: 'num',
      width: 150,
      sorter: true,
      render: (_v: unknown, r: WasteRequestDto) => (
        <Typography.Text copyable>{`${r.num}-${requestTypeShort[r.requestType]}`}</Typography.Text>
      ),
    },
  ];

  /**
   * Карточка площадки на телефоне (ADR 0030): что стоит, где и с какого времени. Действий у
   * списка нет — он только на чтение, поэтому нет и меню.
   */
  const card: CardConfig<WasteRequestDto> = {
    title: (r) => r.objectName,
    badge: (r) => <Tag>{`${r.num}-${requestTypeShort[r.requestType]}`}</Tag>,
    primary: (r) => r.containerTypeName ?? '—',
    lines: [
      (r) => `Доставка: ${formatDateTimeMaybe(r.deliveryAt, r.deliveryTimeUnspecified)}`,
      (r) => `Заявка от ${formatDate(r.createdAt)}`,
    ],
  };

  return (
    <PageTableLayout
      mobile={{
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<WasteRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
    </PageTableLayout>
  );
}
