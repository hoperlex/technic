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
  isShiftFilled,
  isShiftTimeFromDriver,
  MAX_MACHINE_HOURS,
  requestCustomerName,
  SHIFT_IDLE_COMMENT_MESSAGE,
  shiftDayBlocker,
  shiftSpanHours,
  type SpecialEquipmentRequestDto,
  type VehicleRequestShiftDto,
  workedAmountLabel,
} from '@technic/contracts';
import {
  ShiftDriverNote,
  ShiftTimeNote,
  vehicleRequestKeys,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { ViewModal } from '@shared/ui';
import { TimeInput } from '@entities/request';
import { UserAvatar } from '@shared/ui';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';
import {
  approveBody,
  type Draft,
  draftOf,
  driverPrefill,
  isDriverDay,
  saveBody,
} from './shiftDraft';

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

const dash = <Typography.Text type="secondary">—</Typography.Text>;

export function VehicleShiftsModal({ request, canEdit, canApprove, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const { data, isFetching } = useQuery({
    queryKey: vehicleRequestKeys.shifts(request?.id),
    queryFn: () => vehicleRequestsApi.shifts(request!.id),
    enabled: !!request,
  });

  // Список берётся мемоизированным: он же вход итога по подтверждённым часам.
  const items = useMemo(() => data?.items ?? [], [data]);
  const onDate = data?.onDate;

  // The list row's summary changes with the shifts: the closing warning and the reassignment lock
  // depend on it — so both reads are refreshed, not only the table.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
  };

  const dropDraft = (date: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[date];
      return next;
    });

  /**
   * A 409 means the day the person saw is gone: a driver reading was edited, rebased or voided, or
   * a driver day now overlays the site's row. Nothing typed can be retried as is — the day is
   * reloaded and shown again (plan §6.4).
   */
  const onShiftError = (e: unknown, date: string) => {
    message.error(errorMessage(e));
    if (isApiError(e) && e.status === 409) {
      dropDraft(date);
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.shifts(request?.id) });
    }
  };

  const saveMut = useMutation({
    mutationFn: (v: { shift: VehicleRequestShiftDto; draft: Draft }) =>
      vehicleRequestsApi.saveShift(request!.id, v.shift.date, saveBody(v.shift, v.draft)),
    onSuccess: (res, v) => {
      message.success(`Смена за ${formatDateOnly(v.shift.date)} сохранена`);
      qc.setQueryData(vehicleRequestKeys.shifts(request!.id), res);
      dropDraft(v.shift.date);
      invalidate();
    },
    onError: (e, v) => onShiftError(e, v.shift.date),
  });

  const approveMut = useMutation({
    mutationFn: (v: { shift: VehicleRequestShiftDto; approved: boolean }) =>
      vehicleRequestsApi.approveShift(request!.id, v.shift.date, approveBody(v.shift, v.approved)),
    onSuccess: (res, v) => {
      message.success(v.approved ? 'Смена согласована' : 'Согласование снято');
      qc.setQueryData(vehicleRequestKeys.shifts(request!.id), res);
      invalidate();
    },
    onError: (e, v) => onShiftError(e, v.shift.date),
  });

  const deleteMut = useMutation({
    mutationFn: (date: string) => vehicleRequestsApi.deleteShift(request!.id, date),
    onSuccess: (res, date) => {
      message.success(`Смена за ${formatDateOnly(date)} удалена`);
      qc.setQueryData(vehicleRequestKeys.shifts(request!.id), res);
      dropDraft(date);
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const patch = (date: string, shift: VehicleRequestShiftDto, patchValue: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [date]: { ...draftOf(shift), ...d[date], ...patchValue } }));

  /** A field's value: the draft first, then what is saved (or what the form started from). */
  const valueOf = (shift: VehicleRequestShiftDto): Draft => drafts[shift.date] ?? draftOf(shift);

  /**
   * The row has something to save: typed values, or the driver's partial numbers the form started
   * from — those are signed only after an explicit save (D3).
   */
  const isDirty = (shift: VehicleRequestShiftDto) =>
    drafts[shift.date] !== undefined || driverPrefill(shift) !== null;

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
            {/* The driver's single interval is locked like the hours (plan §8): the door writes it
              from the readings whatever the body says. */}
            <Space size={4}>
              <TimeInput
                value={v.startedAt}
                disabled={!editableOn(s) || isShiftTimeFromDriver(s)}
                onChange={(value) => patch(s.date, s, { startedAt: value })}
              />
              <TimeInput
                value={v.endedAt}
                disabled={!editableOn(s) || isShiftTimeFromDriver(s)}
                onChange={(value) => patch(s.date, s, { endedAt: value })}
              />
            </Space>
            <ShiftTimeNote shift={s} />
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
      width: 140,
      render: (_v, s) => (
        <div style={{ lineHeight: 1.35 }}>
          <InputNumber
            min={0}
            max={MAX_MACHINE_HOURS}
            step={0.5}
            precision={2}
            style={{ width: '100%' }}
            // A driver day's hours come from the readings: they are corrected in the garage.
            disabled={!editableOn(s) || isDriverDay(s)}
            value={valueOf(s).machineHours}
            onChange={(value) => patch(s.date, s, { machineHours: value })}
          />
          {isDriverDay(s) && editableOn(s) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              по показаниям водителя — исправляют в гараже
            </Typography.Text>
          )}
          {driverPrefill(s) && editableOn(s) && !drafts[s.date] && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              неполные данные водителя — проверьте и сохраните
            </Typography.Text>
          )}
          <ShiftDriverNote shift={s} />
        </div>
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
          disabled={!editableOn(s) || isDriverDay(s)}
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
              disabled={!canApprove || dayBlocked || !isShiftFilled(s) || busy}
              onChange={(e) => approveMut.mutate({ shift: s, approved: e.target.checked })}
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
              disabled={!isDirty(s) || busy}
              onClick={() => saveMut.mutate({ shift: s, draft: valueOf(s) })}
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

  /** A row is edited while its day is open, it is unsigned and the account may edit. */
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
