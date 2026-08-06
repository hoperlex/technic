import { Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { type WasteRequestDto } from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { DataTable, type CardConfig } from '@shared/ui';
import { EntityLink } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { textColumn } from '@shared/ui';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { useListParams } from '@shared/lib';
import { formatDate, formatDateTimeMaybe } from '../../utils/format';
import { wasteRequestLink } from '../../utils/links';
import { useAuth } from '../../auth/AuthContext';

/**
 * Контейнеры, присутствующие или планируемые на площадках — производный вид
 * по заявкам установки (container_install), кроме отменённых. Только чтение.
 */
export function OnSiteTab() {
  const { can } = useAuth();
  const { params, setSort, onTableChange } = useListParams<Record<string, never>>(
    {},
    { searchKeys: ['objectName'] },
  );

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', 'present', params],
    queryFn: () => wasteRequestsApi.present(params),
  });

  const columns = [
    textColumn<WasteRequestDto>({
      key: 'objectName',
      title: 'Площадка',
      dataIndex: 'objectName',
      width: OBJECT_COLUMN_WIDTH,
      render: (_v, r) => <ObjectCell name={r.objectName} address={r.objectAddress} />,
    }),
    textColumn<WasteRequestDto>({
      key: 'containerTypeName',
      title: 'Тип контейнера',
      dataIndex: 'containerTypeName',
      searchable: false,
    }),
    // Чей контейнер: оператор заявки установки и есть его владелец (ADR 0054). Без этой колонки
    // список отвечал на «что стоит», но не на «кому звонить, чтобы увезли».
    textColumn<WasteRequestDto>({
      key: 'operatorName',
      title: 'Оператор',
      dataIndex: 'operatorName',
      searchable: false,
      width: 200,
      render: (v) => (v as string | null) ?? 'не указан',
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
      // Номер ведёт к самой заявке установки: список площадок отвечает, что стоит и с какого
      // числа, а «чем и почему» — уже заявка. Копирование номера остаётся: его диктуют по
      // телефону оператору, и ради этого сюда заходят не реже.
      render: (_v: unknown, r: WasteRequestDto) => (
        <Typography.Text copyable={{ text: r.displayNumber }}>
          <EntityLink to={wasteRequestLink(can, { id: r.id })} title="Открыть заявку">
            {r.displayNumber}
          </EntityLink>
        </Typography.Text>
      ),
    },
  ];

  /**
   * Карточка площадки на телефоне (ADR 0030): что стоит, где и с какого времени. Действий у
   * списка нет — он только на чтение, поэтому нет и меню.
   */
  const card: CardConfig<WasteRequestDto> = {
    title: (r) => r.objectName,
    badge: (r) => <Tag>{r.displayNumber}</Tag>,
    primary: (r) => r.containerTypeName ?? '—',
    lines: [
      (r) => `Оператор: ${r.operatorName ?? 'не указан'}`,
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
