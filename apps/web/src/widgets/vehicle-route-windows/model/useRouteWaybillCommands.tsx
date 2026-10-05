import { App, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BLANK_WAYBILL_CONFIRM, type VehicleRouteDto } from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { vehicleRoutesApi, vehicleRouteKeys } from '@entities/vehicle-route';
import { waybillKeys, waybillsApi } from '@entities/waybill';
import { ackRequiredDetails, confirmWaybillWarnings } from '@features/waybill-issue';
import { formatDateOnly } from '@shared/lib';

/*
 * One issue attempt: the backdate and the warning acknowledgement live in it together (R21 of
 * docs/route-trips-plan.md).
 *
 * Together because the attempt is repeated WHOLE: after 409 waybill_ack_required the portal sends the
 * same request with the same operation key plus the fingerprint. Split them into two mutations and
 * the confirmation of a backdated issue would lose either the reason or the key, and a second key
 * would burn a second form number.
 */
type IssueAttempt = {
  backdate?: { reason: string; operationId: string };
  acknowledge?: { fingerprint: string };
};

interface Args {
  route: VehicleRouteDto | undefined;
  /** The route has no requests: its waybill is issued as an empty form (ADR 0071). */
  blank: boolean;
  /** Driver document gaps (ADR 0064) that would leave a waybill column empty; null when none. */
  driverGaps: string | null;
  /** The route day has passed (Moscow date), so issuing is a correction (ADR 0101). */
  past: boolean;
  afterChange: (updated: VehicleRouteDto) => void;
  fail: (error: unknown) => void;
  onChanged: () => void;
}

/**
 * Waybill commands of the route card: issue (today, backdated, with confirmations) and cancel.
 * Every path spends a form number forever, which is why each asks before sending and why a retry
 * must reuse the attempt instead of building a new one.
 */
export function useRouteWaybillCommands({
  route,
  blank,
  driverGaps,
  past,
  afterChange,
  fail,
  onChanged,
}: Args) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const issue = useMutation({
    mutationFn: (attempt: IssueAttempt) =>
      vehicleRoutesApi.issueWaybill(route!.id, {
        version: route!.version,
        ...(attempt.backdate ?? {}),
        ...(attempt.acknowledge ? { acknowledge: attempt.acknowledge } : {}),
      }),
    onSuccess: (updated) => {
      message.success(`Путевой лист ${updated.waybill?.number ?? ''} выписан`);
      afterChange(updated);
    },
    /*
     * 409 waybill_ack_required is not an error but a question: the server computed the warnings
     * under its lock and expects a person to read them. The list is shown and the same attempt is
     * retried with the received fingerprint. The retry may again get this 409, meaning the set
     * changed between showing and clicking, and the person reads the new list; there is no loop,
     * because every round needs a click.
     */
    onError: (error, attempt) => {
      const details = ackRequiredDetails(error);
      // The SAME attempt is repeated with the acknowledgement added, not rebuilt: the operation key
      // of a backdated issue is checked against the whole body, and a different body would be met
      // by the server with "this is not a retry" instead of a waybill.
      if (details) {
        confirmWaybillWarnings(modal, details, (acknowledge) =>
          issue.mutateAsync({ ...attempt, acknowledge }),
        );
      } else fail(error);
    },
  });

  /*
   * Issue on a past day (ADR 0101 item 4, plan gap 1).
   *
   * The portal used to issue such a waybill silently: same button, same request. Now it is an
   * operation: the reason is mandatory (the server asks for it and writes it into the correction log
   * and the waybill itself, R35), and the idempotency key is generated BEFORE sending and does not
   * change while the dialog is open, so a retry after a dropped connection returns the same number
   * instead of burning the next one (R31).
   *
   * A separate dialog rather than a field in the card: it is asked rarely, and a permanent "reason"
   * field next to a regular same-day issue would read as mandatory.
   */
  const confirmBackdatedIssue = () => {
    let reason = '';
    const operationId = crypto.randomUUID();
    modal.confirm({
      title: `Выписать лист за ${route ? formatDateOnly(route.routeDate) : 'прошедший день'}?`,
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            День уже прошёл: лист уйдёт в журнал с меткой коррекции, вашим именем и этой причиной.
            {blank ? ` ${BLANK_WAYBILL_CONFIRM}` : ''}
            {driverGaps ? ` ${driverGaps}` : ''}
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            aria-label="Причина выписки задним числом"
            placeholder="Например: бумагу выписали в тот день на месте, в портал вносим сегодня"
            onChange={(event) => {
              reason = event.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Выписать задним числом',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await issue.mutateAsync({ backdate: { reason, operationId } });
      },
    });
  };

  /*
   * Empty columns are asked by a confirmation rather than just a warning above the button: the form
   * number is spent forever, and "issued without looking" costs more here than an extra click. When
   * the documents are complete there is no extra dialog and the waybill is issued at once.
   *
   * An empty form is always asked by the same dialog: no task is printed on it at all, and only a
   * person can tell "forgot to add requests" from "issuing empty on purpose".
   */
  const confirmIssue = () => {
    // A past day has its own dialog and price (ADR 0101, gap 1): the waybill is born by a correction
    // operation, and the server will not issue it without a reason.
    if (past) return confirmBackdatedIssue();
    if (!driverGaps && !blank) return issue.mutate({});
    modal.confirm({
      title: blank ? 'Выписать пустой лист?' : 'Выписать лист с незаполненными графами?',
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {blank ? BLANK_WAYBILL_CONFIRM : driverGaps} {blank && driverGaps ? `${driverGaps} ` : ''}
          Номер бланка израсходуется: чтобы переписать лист, его придётся аннулировать.
        </Typography.Paragraph>
      ),
      okText: 'Всё равно выписать',
      cancelText: 'Отмена',
      onOk: () => issue.mutateAsync({}),
    });
  };

  const cancelWaybill = useMutation({
    mutationFn: (reason: string) => waybillsApi.cancel(route!.waybill!.id, { reason }),
    onSuccess: async () => {
      message.success('Лист аннулирован — маршрут снова можно править');
      await qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      // A cancelled waybill stays in the journal with its state: that is where people look to learn
      // why the form number was spent.
      await qc.invalidateQueries({ queryKey: waybillKeys.root });
      await qc.invalidateQueries({ queryKey: garageKeys.root });
      onChanged();
    },
    onError: fail,
  });
  const confirmCancelWaybill = () => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать лист ${route?.waybill?.number}?`,
      content: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит: после правки рейса выпишется новый.
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            placeholder="Причина: испорчен при печати, сменился водитель…"
            onChange={(event) => {
              reason = event.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await cancelWaybill.mutateAsync(reason);
      },
    });
  };

  return { issue, confirmIssue, confirmCancelWaybill };
}
