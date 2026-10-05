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
 * Backdating (ADR 0101, R6 and R15): the reason for the edit and its cost, in the same form where
 * the date was chosen. The block appears exactly when the operation goes into the past and does
 * two things.
 *
 * **Asks for the reason.** It is not a decoration or a comment field: the reason goes into the
 * operation record (`waybill_corrections`) and stays the only explanation of why the request was
 * dated yesterday — two months later accounting reads it, not the author.
 *
 * **Names the consequences before the click.** The request date drags the route, the paperwork and
 * the site's signatures along, and learning that from the journal the next day is too late. Every
 * line is computed with the same contract the server uses: the portal's promise and the handler's
 * behaviour must match word for word.
 */
interface Props {
  /** Edited request; `null` means create mode, where only an explanation is needed. */
  record: VehicleRequestDto | null;
  /** Calendar currently shown by the form. */
  next: RequestCalendar;
  /**
   * Effective operation date — the one the server checks the permission by (`movedRequestDateKey`
   * for an edit, the chosen day for a creation). This component is rendered only for a past date.
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
   * Shifts falling outside the new term (R23). The rows are not deleted — restoring the date brings
   * the hours back — but they vanish from the shift table together with the site's signatures on
   * them. Only the shift list itself knows which days go: the request summary answers with
   * "approved / pending" counts, not dates.
   *
   * Same query key as the shift dialog and the request card: it is the same table, and fetching it a
   * second time is pointless.
   */
  const { data: shifts } = useQuery({
    queryKey: vehicleRequestKeys.shifts(record?.id),
    queryFn: () => vehicleRequestsApi.shifts(record!.id),
    enabled: !!record && !!term && (record.status === 'confirmed' || record.status === 'done'),
  });

  const notes: string[] = [];

  /*
   * Route-day mismatch (ADR 0082 item 3). The portal does not forbid such an edit — request and
   * route are edited by different people at different times — but must say so before the click,
   * with the same text the dialog shows after saving.
   */
  if (record?.requestType === 'freight_transport' && record.route && next.scheduledDay) {
    const mismatch = routeDateMismatch(
      { tripDate: next.scheduledDay },
      { displayNumber: record.route.displayNumber, routeDate: record.route.routeDate },
    );
    if (mismatch) notes.push(mismatch);
  }

  /*
   * ESM-2 weeks the term edit touches in the past (R8, R21). This is not a warning but a predicted
   * refusal: reconciliation will neither issue a form for an elapsed week nor write off a worked
   * one, so the server rejects the whole edit (such weeks are reissued by correcting the weekly
   * form). The portal must say it before the click, or the person writes a reason and gets 422.
   *
   * Computed only for requests whose forms the portal maintains itself (`auto`). For a linear order
   * the set of weeks is defined by already issued forms (ADR 0100 §5), which the form does not have;
   * there the server supplies the line by refusing.
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

  // Days with entered hours that fall outside the new term: hours and signatures survive in the
  // database but vanish from the shift table — and the request would close without them.
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
        // Required by the server (`backdateGuard` answers 422 without it), hence required here: the
        // form must not send a body that is certain to be rejected.
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
