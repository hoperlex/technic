import { Space, Spin, Table, Tag, Typography, type TableColumnType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  approvedMachineHours,
  type VehicleRequestShiftDto,
  workedAmountLabel,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { formatDateOnly, formatDateTime } from '@shared/lib';
import { UserAvatar } from '@shared/ui';

const dash = <Typography.Text type="secondary">—</Typography.Text>;
const columns: TableColumnType<VehicleRequestShiftDto>[] = [
  { key: 'date', title: 'День', width: 120, render: (_value, shift) => formatDateOnly(shift.date) },
  {
    key: 'time',
    title: 'Смена',
    width: 130,
    render: (_value, shift) =>
      shift.startedAt && shift.endedAt ? `${shift.startedAt} – ${shift.endedAt}` : dash,
  },
  {
    key: 'machineHours',
    title: 'Моточасы',
    width: 110,
    // An unfilled day and an idle day read differently: the first has no hours at all, the second
    // has an honest zero with an explanation next to it.
    render: (_value, shift) =>
      shift.filledAt ? workedAmountLabel('hours', shift.machineHours) : dash,
  },
  { key: 'refuel', title: 'Заправка', width: 150, render: (_value, shift) => shift.refuel || dash },
  {
    key: 'comment',
    title: 'Комментарий',
    width: 220,
    render: (_value, shift) => shift.comment || dash,
  },
  {
    key: 'approval',
    title: 'Согласование',
    width: 210,
    render: (_value, shift) =>
      shift.approvedAt ? (
        <div style={{ lineHeight: 1.35 }}>
          <Space size={6}>
            <UserAvatar name={shift.approvedByName ?? ''} size={18} />
            <span>{shift.approvedByName}</span>
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDateTime(shift.approvedAt)}
            </Typography.Text>
          </div>
        </div>
      ) : (
        <Tag color={shift.filledAt ? 'orange' : 'default'} style={{ marginInlineEnd: 0 }}>
          {shift.filledAt ? 'ждёт согласования' : 'не заполнена'}
        </Tag>
      ),
  },
];

/**
 * Shifts of an on-site equipment order, read-only, as the request card shows them.
 *
 * Shifts are kept on the "On site" tab (ADR 0036), which shows what stands on the site today; people
 * without a link to the site come here for them: the dispatcher checking an invoice and the lessor
 * in a dispute about hours. Hence the same table without input fields.
 */
export function VehicleShiftsView({ requestId }: { requestId: string }) {
  // Same key as the shift confirmation window: it is the same table, no need to fetch it twice.
  const { data, isPending } = useQuery({
    queryKey: vehicleRequestKeys.shifts(requestId),
    queryFn: () => vehicleRequestsApi.shifts(requestId),
  });
  if (isPending) return <Spin size="small" />;

  const items = data?.items ?? [];
  if (items.length === 0) {
    return <Typography.Text type="secondary">Срок заявки не задан — смен нет</Typography.Text>;
  }
  const approvedCount = items.filter((shift) => shift.approvedAt).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Space size={[12, 4]} wrap>
        <Tag color={approvedCount === items.length ? 'green' : 'orange'}>
          согласовано {approvedCount} из {items.length}
        </Tag>
        <Typography.Text type="secondary">
          принято {workedAmountLabel('hours', approvedMachineHours(items))}
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
