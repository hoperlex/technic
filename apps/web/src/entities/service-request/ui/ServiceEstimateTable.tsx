import { Table, Tag, Typography, type TableColumnsType } from 'antd';
import {
  serviceItemKindLabels,
  type ServiceRequestItemDto,
  warrantyLabel,
  warrantyState,
  warrantyStateColors,
  warrantyToday,
} from '@technic/contracts';

/** Деньги одним видом на все экраны сметы: «4 200,00 ₽». */
function money(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Смета на чтение: строки плана и, если работы закрыты, факт по каждой из них.
 *
 * Компонент один на согласование, карточку заявки и разбор спора — по той же причине, по какой
 * один тег гарантии: смета — это то, о чём договорились, и выглядеть в окне согласования иначе,
 * чем в карточке, она не может. Считать здесь нечего: суммы приходят с сервера (их считает БД),
 * таблица только показывает.
 *
 * Факт показывается отдельными колонками, а не подменяет план (Р12): «согласовали три, поставили
 * две» — главный факт закрытой заявки, и увидеть его нужно рядом, а не вместо.
 */
export function ServiceEstimateTable({
  items,
  showFact,
}: {
  items: readonly ServiceRequestItemDto[];
  /** Работы закрыты: у строк есть отметки выполнения, фактические суммы и даты гарантий. */
  showFact?: boolean;
}) {
  const today = warrantyToday();

  const columns: TableColumnsType<ServiceRequestItemDto> = [
    {
      key: 'kind',
      title: 'Вид',
      dataIndex: 'kind',
      width: 110,
      render: (_v, item) => (
        <Tag color={item.kind === 'part' ? 'blue' : 'geekblue'}>
          {serviceItemKindLabels[item.kind]}
        </Tag>
      ),
    },
    { key: 'name', title: 'Наименование', dataIndex: 'name' },
    { key: 'quantity', title: 'Кол-во', dataIndex: 'quantity', width: 80, align: 'right' },
    {
      key: 'unitPrice',
      title: 'Цена',
      dataIndex: 'unitPrice',
      width: 120,
      align: 'right',
      render: (_v, item) => money(item.unitPrice),
    },
    {
      key: 'amount',
      title: 'Сумма',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (_v, item) => money(item.amount),
    },
    ...(showFact
      ? ([
          {
            key: 'performed',
            title: 'Выполнено',
            width: 110,
            render: (_v: unknown, item: ServiceRequestItemDto) =>
              item.performed == null ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : item.performed ? (
                <Tag color="green">да</Tag>
              ) : (
                // Не выполненная строка — не ошибка, а решение: деталь не понадобилась, и
                // гарантии на неё не появится. Поэтому она остаётся в смете видимой.
                <Tag>нет</Tag>
              ),
          },
          {
            key: 'actualQuantity',
            title: 'Факт, кол-во',
            width: 110,
            align: 'right' as const,
            render: (_v: unknown, item: ServiceRequestItemDto) => item.actualQuantity ?? '—',
          },
          {
            key: 'actualAmount',
            title: 'Факт, сумма',
            width: 130,
            align: 'right' as const,
            render: (_v: unknown, item: ServiceRequestItemDto) => money(item.actualAmount),
          },
        ] as TableColumnsType<ServiceRequestItemDto>)
      : []),
    {
      key: 'warranty',
      title: 'Гарантия',
      width: 170,
      render: (_v, item) => {
        // До закрытия работ у гарантии есть только обещанный срок: дату считать не от чего.
        if (!item.warrantyUntil) {
          return item.warrantyMonths ? (
            <Typography.Text type="secondary">{item.warrantyMonths} мес.</Typography.Text>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          );
        }
        const state = warrantyState(item.warrantyUntil, today);
        return (
          <Tag color={warrantyStateColors[state]}>{warrantyLabel(item.warrantyUntil, today)}</Tag>
        );
      },
    },
  ];

  return (
    <Table<ServiceRequestItemDto>
      size="small"
      rowKey="id"
      pagination={false}
      columns={columns}
      dataSource={[...items]}
      // Смета в модальном окне: на телефоне колонки не сжимаются до нечитаемого, а уезжают
      // под горизонтальную прокрутку — сравнивают строки именно по числам.
      scroll={{ x: showFact ? 1000 : 700 }}
      locale={{ emptyText: 'Смета пуста' }}
    />
  );
}
