import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnType,
} from 'antd';
import { DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approvedMachineHours,
  MAX_MACHINE_HOURS,
  requestCustomerName,
  SHIFT_IDLE_COMMENT_MESSAGE,
  shiftDayBlocker,
  shiftSpanHours,
  type SpecialEquipmentRequestDto,
  type VehicleRequestShiftDto,
  workedAmountLabel,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { ViewModal } from '@shared/ui';
import { TimeInput } from '../../components/TimeInput';
import { UserAvatar } from '../../components/UserAvatar';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Подтверждение смен по заказу спецтехники: день работы, его показатели и подпись объекта.
 *
 * Таблица идёт по всем дням заказа, включая те, за которые ещё ничего не внесли. Будущие дни
 * показаны, но неактивны: смену пишут по факту, и подпись под днём, который ещё не наступил, —
 * это подпись под тем, чего не было. День среза считает сервер (`onDate`) — часы браузера тут
 * не годятся, как и на вкладке «На объекте» (ADR 0036).
 *
 * Подтверждает тот, кто мог бы эту заявку завести: решение принимает заказчик — он один видит,
 * во сколько машина вышла и сколько простояла. Снятие подписи — то же действие наоборот: им
 * распирают заявку, у которой нужно сменить машину или откатить статус.
 */
interface Props {
  /** null — окно закрыто. Только заказ спецтехники: у грузоперевозки срока работ нет. */
  request: SpecialEquipmentRequestDto | null;
  /** Может ли учётка вносить часы (право правки заявки). */
  canEdit: boolean;
  /** Может ли учётка ставить и снимать подпись (круг «кто мог бы завести эту заявку»). */
  canApprove: boolean;
  onClose: () => void;
}

/** Черновик строки: то, что человек набрал, но ещё не сохранил. */
interface Draft {
  startedAt?: string;
  endedAt?: string;
  machineHours?: number | null;
  refuel?: string;
  comment?: string;
}

const dash = <Typography.Text type="secondary">—</Typography.Text>;

function draftOf(shift: VehicleRequestShiftDto): Draft {
  return {
    startedAt: shift.startedAt ?? undefined,
    endedAt: shift.endedAt ?? undefined,
    machineHours: shift.filledAt ? shift.machineHours : null,
    refuel: shift.refuel,
    comment: shift.comment,
  };
}

export function VehicleShiftsModal({ request, canEdit, canApprove, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'shifts', request?.id],
    queryFn: () => vehicleRequestsApi.shifts(request!.id),
    enabled: !!request,
  });

  // Список берётся мемоизированным: он же вход итога по подтверждённым часам.
  const items = useMemo(() => data?.items ?? [], [data]);
  const onDate = data?.onDate;

  // Сводка в строке списка меняется вместе со сменами: от неё зависят и запрет закрытия, и
  // доступность смены машины — поэтому обновляются оба запроса, а не только таблица.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
  };

  const saveMut = useMutation({
    mutationFn: (v: { date: string; draft: Draft }) =>
      vehicleRequestsApi.saveShift(request!.id, v.date, {
        startedAt: v.draft.startedAt ?? null,
        endedAt: v.draft.endedAt ?? null,
        machineHours: v.draft.machineHours ?? 0,
        refuel: v.draft.refuel ?? '',
        comment: v.draft.comment ?? '',
      }),
    onSuccess: (res, v) => {
      message.success(`Смена за ${formatDateOnly(v.date)} сохранена`);
      qc.setQueryData(['vehicle-requests', 'shifts', request!.id], res);
      setDrafts((d) => {
        const next = { ...d };
        delete next[v.date];
        return next;
      });
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const approveMut = useMutation({
    mutationFn: (v: { date: string; approved: boolean }) =>
      vehicleRequestsApi.approveShift(request!.id, v.date, v.approved),
    onSuccess: (res, v) => {
      message.success(v.approved ? 'Смена согласована' : 'Согласование снято');
      qc.setQueryData(['vehicle-requests', 'shifts', request!.id], res);
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (date: string) => vehicleRequestsApi.deleteShift(request!.id, date),
    onSuccess: (res, date) => {
      message.success(`Смена за ${formatDateOnly(date)} удалена`);
      qc.setQueryData(['vehicle-requests', 'shifts', request!.id], res);
      setDrafts((d) => {
        const next = { ...d };
        delete next[date];
        return next;
      });
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const patch = (date: string, shift: VehicleRequestShiftDto, patchValue: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [date]: { ...draftOf(shift), ...d[date], ...patchValue } }));

  /** Значение поля: сначала черновик, затем сохранённое. */
  const valueOf = (shift: VehicleRequestShiftDto): Draft => drafts[shift.date] ?? draftOf(shift);

  /** Строка изменена и её есть смысл сохранять. */
  const isDirty = (date: string) => drafts[date] !== undefined;

  const busy = saveMut.isPending || approveMut.isPending || deleteMut.isPending;

  const approvedHours = useMemo(() => approvedMachineHours(items), [items]);
  const approvedCount = items.filter((s) => s.approvedAt).length;

  const columns: TableColumnType<VehicleRequestShiftDto>[] = [
    {
      key: 'date',
      title: 'День',
      width: 130,
      render: (_v, s) => {
        // Причина неактивности — та же строка, которой откажет сервер: правило одно на портал и
        // API, и «день ещё не наступил» портал обязан объяснять теми же словами.
        const blocker = request && onDate ? shiftDayBlocker(request, s.date, onDate) : null;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{formatDateOnly(s.date)}</div>
            {blocker && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {blocker}
              </Typography.Text>
            )}
          </div>
        );
      },
    },
    {
      key: 'time',
      title: 'Смена',
      width: 190,
      render: (_v, s) => {
        const v = valueOf(s);
        const span = shiftSpanHours(v.startedAt ?? null, v.endedAt ?? null);
        return (
          <div style={{ lineHeight: 1.35 }}>
            <Space size={4}>
              <TimeInput
                value={v.startedAt}
                disabled={!editableOn(s)}
                onChange={(value) => patch(s.date, s, { startedAt: value })}
              />
              <TimeInput
                value={v.endedAt}
                disabled={!editableOn(s)}
                onChange={(value) => patch(s.date, s, { endedAt: value })}
              />
            </Space>
            {span != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {workedAmountLabel('hours', span)} по времени
              </Typography.Text>
            )}
          </div>
        );
      },
    },
    {
      key: 'machineHours',
      title: 'Машиночасы',
      width: 120,
      render: (_v, s) => (
        <InputNumber
          min={0}
          max={MAX_MACHINE_HOURS}
          step={0.5}
          precision={2}
          style={{ width: '100%' }}
          disabled={!editableOn(s)}
          value={valueOf(s).machineHours}
          onChange={(value) => patch(s.date, s, { machineHours: value })}
        />
      ),
    },
    {
      key: 'refuel',
      title: 'Заправка',
      width: 160,
      render: (_v, s) => (
        <Input
          placeholder="120 л"
          maxLength={200}
          disabled={!editableOn(s)}
          value={valueOf(s).refuel}
          onChange={(e) => patch(s.date, s, { refuel: e.target.value })}
        />
      ),
    },
    {
      key: 'comment',
      title: 'Комментарий',
      width: 200,
      render: (_v, s) => (
        <Input
          // Нулевые машиночасы объясняются: простой — часть учёта, а не пропуск в нём.
          placeholder={valueOf(s).machineHours === 0 ? SHIFT_IDLE_COMMENT_MESSAGE : ''}
          maxLength={2000}
          disabled={!editableOn(s)}
          value={valueOf(s).comment}
          onChange={(e) => patch(s.date, s, { comment: e.target.value })}
        />
      ),
    },
    {
      key: 'approval',
      title: 'Согласование',
      width: 200,
      render: (_v, s) => {
        const dayBlocked = !request || !onDate || !!shiftDayBlocker(request, s.date, onDate);
        return (
          <div style={{ lineHeight: 1.35 }}>
            <Checkbox
              checked={!!s.approvedAt}
              disabled={!canApprove || dayBlocked || !s.filledAt || busy}
              onChange={(e) => approveMut.mutate({ date: s.date, approved: e.target.checked })}
            >
              {s.approvedAt ? 'Согласовано' : 'Согласовать'}
            </Checkbox>
            {s.approvedByName && (
              <Space size={6} style={{ marginTop: 2 }}>
                <UserAvatar name={s.approvedByName} size={18} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.approvedByName}
                </Typography.Text>
              </Space>
            )}
          </div>
        );
      },
    },
    {
      key: 'actions',
      title: '',
      width: 80,
      render: (_v, s) =>
        editableOn(s) ? (
          <Space size={4}>
            <Button
              type="text"
              icon={<SaveOutlined />}
              title="Сохранить смену"
              disabled={!isDirty(s.date) || busy}
              onClick={() => saveMut.mutate({ date: s.date, draft: valueOf(s) })}
            />
            {s.filledAt && (
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                title="Удалить смену"
                disabled={busy}
                onClick={() => deleteMut.mutate(s.date)}
              />
            )}
          </Space>
        ) : (
          dash
        ),
    },
  ];

  /** Строку правят, пока день доступен, подписи под ним нет и есть право на правку. */
  function editableOn(s: VehicleRequestShiftDto): boolean {
    if (!canEdit || !request || !onDate) return false;
    if (s.approvedAt) return false;
    return !shiftDayBlocker(request, s.date, onDate);
  }

  return (
    <ViewModal
      title={request ? `Смены заявки ${request.displayNumber}` : 'Смены'}
      open={!!request}
      onClose={onClose}
      width={1100}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Space size={[12, 4]} wrap>
            <Typography.Text strong>{requestCustomerName(request)}</Typography.Text>
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
            loading={isFetching}
            dataSource={items}
            columns={columns}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Пока наступившие смены не согласованы, заявка остаётся в срезе, а её закрытие
            предупреждает, что работа не принята объектом. Будущие дни подтверждают по факту — когда
            они наступят.
          </Typography.Text>
        </div>
      )}
    </ViewModal>
  );
}
