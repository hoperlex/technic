import { Table, Tag, Typography, type TableColumnsType } from 'antd';
import {
  serviceItemKindLabels,
  type ServiceRequestItemDto,
  warrantyLabel,
  warrantyState,
  warrantyStateColors,
  warrantyToday,
} from '@technic/contracts';

/** Деньги одним видом на все экраны объёма работ: «4 200,00 ₽». */
function money(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Объём работ на чтение: строки плана и, если работы закрыты, факт по каждой из них.
 *
 * Компонент один на согласование, карточку заявки и разбор спора — по той же причине, по какой
 * один тег гарантии: объём работ — это то, о чём договорились, и выглядеть в окне согласования
 * иначе, чем в карточке, он не может. Считать здесь нечего: суммы приходят с сервера (их считает
 * БД), таблица только показывает.
 *
 * Слово переименовано сплошняком (Р17), имена в коде — нет: `estimate` стоит в схеме базы и в
 * матрице прав, и переименование ради подписи стоило бы миграции прав.
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
                // гарантии на неё не появится. Поэтому она остаётся в объёме работ видимой.
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
      // Таблица живёт в модальном окне: на телефоне колонки не сжимаются до нечитаемого, а
      // уезжают под горизонтальную прокрутку — сравнивают строки именно по числам.
      scroll={{ x: showFact ? 1000 : 700 }}
      // Пусто — это «исполнитель ещё не набрал строк», а не сбой: в окне согласования такого не
      // бывает вовсе (предъявить нечего), а в карточке до предъявления это нормальный вид.
      locale={{ emptyText: 'Объём работ пока не заполнен' }}
    />
  );
}
