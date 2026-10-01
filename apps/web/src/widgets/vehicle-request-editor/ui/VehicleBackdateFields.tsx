import { useQuery } from '@tanstack/react-query';
import { Form, Input, Typography } from 'antd';
import {
  esm2Mode,
  esm2Periods,
  isShiftDayInTerm,
  moscowDateKeyOf,
  type RequestCalendar,
  routeDateMismatch,
  type VehicleRequestDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';

/**
 * Backdating (ADR 0101): collect the reason and expose consequences beside the chosen date.
 *
 * The reason becomes the durable audit explanation in `waybill_corrections`. Consequences are
 * calculated before submission with the same contracts the server enforces, so users do not
 * discover affected routes, forms, or approvals only after saving.
 */
/**
 * Standalone backdate reason for operations that have no request-term consequences (ADR 0101):
 * past ESM-2 issue, relocation, and past order-day flows.
 *
 * It stays separate from `VehicleBackdateFields` because those operations do not need its term,
 * shift, ESM-2-week, or route-mismatch queries.
 *
 * The field is named `reason` to match all three request bodies; request editing uses
 * `backdateReason` to distinguish it from the request comment.
 */
export function BackdateReasonField({
  effectiveDate,
  /** Concise operation-specific consequence shown below the reason. */
  consequence,
  placeholder,
}: {
  effectiveDate: string;
  consequence: string;
  placeholder: string;
}) {
  return (
    <Form.Item
      name="reason"
      label="Причина заднего числа"
      // `backdateGuard` rejects an empty reason, so the form must not submit one.
      rules={[{ required: true, message: 'Укажите причину' }]}
      extra={`Дата ${formatDateOnly(effectiveDate)} уже прошла: ${consequence}`}
    >
      <Input.TextArea rows={2} maxLength={2000} showCount placeholder={placeholder} />
    </Form.Item>
  );
}

interface Props {
  /** Edited request; `null` means create mode, where only an explanation is needed. */
  record: VehicleRequestDto | null;
  /** Calendar currently shown by the form. */
  next: RequestCalendar;
  /**
   * Effective operation date used by the server's permission check. This component is rendered
   * only for a past date.
   */
  effectiveDate: string;
}

export function VehicleBackdateFields({ record, next, effectiveDate }: Props) {
  const today = moscowDateKeyOf(new Date());
  const term =
    record?.requestType === 'special_equipment'
      ? {
          dateFrom: next.dateFrom ?? record.dateFrom,
          dateTo: next.dateTo === undefined ? record.dateTo : next.dateTo,
        }
      : null;

  /*
   * Load shifts to identify filled days falling outside the new term. They remain stored and
   * reappear if the term is restored, but disappear from the current shift table with approvals.
   *
   * Reuse the same query key as the shift dialog and request card.
   */
  const { data: shifts } = useQuery({
    queryKey: vehicleRequestKeys.shifts(record?.id),
    queryFn: () => vehicleRequestsApi.shifts(record!.id),
    enabled: !!record && !!term && (record.status === 'confirmed' || record.status === 'done'),
  });

  const notes: string[] = [];

  /*
   * A route-date mismatch is allowed because request and route may be edited independently, but
   * users must see the same warning before and after saving (ADR 0082).
   */
  if (record?.requestType === 'freight_transport' && record.route && next.scheduledDay) {
    const mismatch = routeDateMismatch(
      { tripDate: next.scheduledDay },
      { displayNumber: record.route.displayNumber, routeDate: record.route.routeDate },
    );
    if (mismatch) notes.push(mismatch);
  }

  /*
   * Touching elapsed ESM-2 weeks predicts a server rejection, not merely a warning: an elapsed or
   * worked weekly form cannot be silently replaced by term editing.
   *
   * Only `auto` mode can derive weeks from the term. Linear requests derive them from issued forms
   * that are not available in this editor, so the server remains authoritative there.
   */
  if (record?.requestType === 'special_equipment' && term) {
    const mode = esm2Mode({
      requestType: record.requestType,
      status: record.status,
      ownership: record.assignment?.ownership ?? null,
      deletedAt: record.deletedAt,
      isLinear: record.isLinear,
    });
    if (mode === 'auto') {
      const key = (p: { from: string; to: string }): string => `${p.from}|${p.to}`;
      const was = esm2Periods(record.dateFrom, record.dateTo);
      const now = esm2Periods(term.dateFrom, term.dateTo);
      const wasKeys = new Set(was.map(key));
      const nowKeys = new Set(now.map(key));
      const touched = [
        ...was.filter((p) => !nowKeys.has(key(p))),
        ...now.filter((p) => !wasKeys.has(key(p))),
      ].filter((p) => p.to < today);
      if (touched.length > 0) {
        notes.push(
          `Задевает недельные листы ЭСМ-2 за прошедшие недели (${touched
            .map((w) => `${formatDateOnly(w.from)} – ${formatDateOnly(w.to)}`)
            .join(
              ', ',
            )}) — такую правку сервер отклонит: бумагу отработанной недели переоформляют коррекцией недельного бланка`,
        );
      }
    }
  }

  // Filled days outside the new term remain stored but disappear from the active shift table.
  if (term && shifts) {
    const lost = shifts.items.filter((s) => s.filledAt && !isShiftDayInTerm(term, s.date));
    if (lost.length > 0) {
      const approved = lost.filter((s) => s.approvedAt).length;
      notes.push(
        `За новым сроком остаётся ${lost.length} дн. с внесёнными часами${
          approved > 0 ? ` (из них согласовано объектом: ${approved})` : ''
        }: часы сохранятся, но из таблицы смен уйдут — вернув дату, вернёте и их`,
      );
    }
  }

  return (
    <>
      <Form.Item
        name="backdateReason"
        label="Причина заднего числа"
        // `backdateGuard` rejects an empty reason, so the form must not submit one.
        rules={[{ required: true, message: 'Укажите причину' }]}
        extra={`Дата ${formatDateOnly(effectiveDate)} уже прошла: правка уйдёт в журнал коррекций с вашим именем и этой причиной`}
      >
        <Input.TextArea
          rows={2}
          maxLength={2000}
          showCount
          placeholder="Например: техника вышла во вторник, заявку оформили в среду"
        />
      </Form.Item>
      {notes.length > 0 && (
        <div style={{ marginTop: -8, marginBottom: 8, lineHeight: 1.5 }}>
          {notes.map((note) => (
            <div key={note}>
              <Typography.Text type="warning">{note}</Typography.Text>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
