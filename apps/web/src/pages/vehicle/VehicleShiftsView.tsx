import { Space, Spin, Table, Tag, Typography, type TableColumnType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  approvedMachineHours,
  type VehicleRequestShiftDto,
  workedAmountLabel,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { UserAvatar } from '../../components/UserAvatar';
import { formatDateTime } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Смены заказа спецтехники — только чтение: так их видят в карточке заявки.
 *
 * Ведут смены на вкладке «На объекте» (ADR 0036), где видно, что стоит на площадке сегодня; сюда
 * же за ними приходят те, кто к площадке отношения не имеет — диспетчер при разборе счёта и
 * арендодатель при споре о часах. Поэтому таблица та же, а полей ввода в ней нет.
 */
interface Props {
  requestId: string;
}

const dash = <Typography.Text type="secondary">—</Typography.Text>;

const columns: TableColumnType<VehicleRequestShiftDto>[] = [
  {
    key: 'date',
    title: 'День',
    width: 120,
    render: (_v, s) => formatDateOnly(s.date),
  },
  {
    key: 'time',
    title: 'Смена',
    width: 130,
    render: (_v, s) => (s.startedAt && s.endedAt ? `${s.startedAt} – ${s.endedAt}` : dash),
  },
  {
    key: 'machineHours',
    title: 'Машиночасы',
    width: 110,
    // Незаполненный день и день простоя читаются по-разному: у первого часов нет вовсе, у
    // второго они честно нулевые, и рядом стоит объяснение.
    render: (_v, s) => (s.filledAt ? workedAmountLabel('hours', s.machineHours) : dash),
  },
  {
    key: 'refuel',
    title: 'Заправка',
    width: 150,
    render: (_v, s) => s.refuel || dash,
  },
  {
    key: 'comment',
    title: 'Комментарий',
    width: 220,
    render: (_v, s) => s.comment || dash,
  },
  {
    key: 'approval',
    title: 'Согласование',
    width: 210,
    render: (_v, s) =>
      s.approvedAt ? (
        <div style={{ lineHeight: 1.35 }}>
          <Space size={6}>
            <UserAvatar name={s.approvedByName ?? ''} size={18} />
            <span>{s.approvedByName}</span>
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDateTime(s.approvedAt)}
            </Typography.Text>
          </div>
        </div>
      ) : (
        <Tag color={s.filledAt ? 'orange' : 'default'} style={{ marginInlineEnd: 0 }}>
          {s.filledAt ? 'ждёт согласования' : 'не заполнена'}
        </Tag>
      ),
  },
];

export function VehicleShiftsView({ requestId }: Props) {
  // Ключ тот же, что у окна подтверждения смен: таблица одна и та же, и второй раз её тянуть с
  // сервера незачем.
  const { data, isPending } = useQuery({
    queryKey: ['vehicle-requests', 'shifts', requestId],
    queryFn: () => vehicleRequestsApi.shifts(requestId),
  });

  if (isPending) return <Spin size="small" />;

  const items = data?.items ?? [];
  if (items.length === 0) {
    return <Typography.Text type="secondary">Срок заявки не задан — смен нет</Typography.Text>;
  }

  const approvedCount = items.filter((s) => s.approvedAt).length;
  const approvedHours = approvedMachineHours(items);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Space size={[12, 4]} wrap>
        <Tag color={approvedCount === items.length ? 'green' : 'orange'}>
          согласовано {approvedCount} из {items.length}
        </Tag>
        <Typography.Text type="secondary">
          принято {workedAmountLabel('hours', approvedHours)}
        </Typography.Text>
      </Space>
      <Table
        rowKey="date"
        size="small"
        dataSource={items}
        columns={columns}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Смены подтверждают на вкладке «На объекте» — здесь их только читают.
      </Typography.Text>
    </div>
  );
}
