import type { Dayjs } from 'dayjs';
import type { ReactNode } from 'react';
import type { RequestStatus, VehicleRequestDto } from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { copyScheduledPlan, copyTermPlan, scheduledMoment } from '../model/requestFormValues';

/**
 * Source-status suffix. A complete dictionary makes a newly added status a compile-time concern
 * instead of rendering `undefined` in a user-facing reassurance.
 *
 * `completed` belongs to waste requests (ADR 0135), so vehicle requests need no suffix for it.
 */
const HEAD_TAIL: Record<RequestStatus, string> = {
  new: '',
  confirmed: ' — она остаётся в работе',
  done: ' — она остаётся выполненной',
  completed: '',
  // Copying creates a new request and never reopens the cancelled source; state that explicitly.
  cancelled: ' — копия не возобновляет отменённую',
};

/**
 * Copy-form notice describing what stays with the source and which term is proposed (ADR 0206).
 *
 * Copying is allowed from every status. The notice explains before saving that the source is not
 * changed and why proposed dates can differ from the source dates.
 *
 * Text branches on data rather than status: the calendar chooses the proposed term and populated
 * fields determine what remains attached to the source.
 *
 * This is a pure presentation helper so the editor host can use it without page ownership.
 */
export function copyNotice(r: VehicleRequestDto, minDate: Dayjs, today: string): ReactNode {
  const num = r.displayNumber;
  const extension =
    r.requestType === 'special_equipment' && r.status === 'confirmed'
      ? // A copy cannot extend an active assignment; point users to the edit or weekly-order flow.
        `Нужна та же машина дольше — копия не поможет: срок ${num} продлевают правкой даты окончания, а площадка — «Заявкой на неделю».`
      : null;
  return (
    <>
      <div>
        <strong>{`Заявка ${num} не меняется${HEAD_TAIL[r.status]}.`}</strong>
      </div>
      <div>{termLine(r, minDate, today)}</div>
      <div>{legacyLine(r)}</div>
      {extension ? <div>{extension}</div> : null}
    </>
  );
}

/** Format dates exactly as request rows and cards do (`termLabel`). */
function dayText(d: Dayjs): string {
  return formatDateOnly(d.format('YYYY-MM-DD'));
}

/**
 * Human-readable proposed term. A missing end date is a one-day order and is shown once, matching
 * the server model.
 *
 * Duration is intentionally omitted because the date field already owns that calculation.
 */
function termText(from: Dayjs, to: Dayjs | null): string {
  return to ? `${dayText(from)} – ${dayText(to)}` : dayText(from);
}

/**
 * Term line selected by request dates rather than status.
 *
 * A shift can mean either an elapsed date or the role-specific lead-time cutoff (ADR 0104), so the
 * notice distinguishes those reasons instead of always claiming the source is in the past.
 */
function termLine(r: VehicleRequestDto, minDate: Dayjs, today: string): string {
  if (r.requestType === 'special_equipment') {
    const term = copyTermPlan(r, minDate, today);
    const proposed = termText(term.dateFrom, term.dateTo);
    if (term.kind === 'ahead')
      return `Состав перенесён из неё, срок предложен прежний: ${proposed}.`;
    if (term.kind === 'remainder')
      return `Состав перенесён из неё; прежний срок идёт до ${formatDateOnly(r.dateTo || r.dateFrom)} — копии предложен остаток: ${proposed}.`;
    const why =
      (r.dateTo || r.dateFrom) < today ? 'прежний срок прошёл' : 'технику заказывают заранее';
    return `Состав перенесён из неё; ${why} — копии предложены те же дни вперёд: ${proposed}.`;
  }
  const plan = copyScheduledPlan(r, minDate);
  const day = dayText(plan.scheduledDate);
  // Do not present the midnight storage sentinel as an explicitly requested delivery time.
  const time = plan.scheduledTime ? `, ${plan.scheduledTime}` : '';
  if (plan.kind === 'ahead')
    return `Состав перенесён из неё, подача предложена прежняя: ${day}${time}.`;
  // Classify the date in Moscow time; a browser-zone midnight could describe the wrong reason.
  const why =
    scheduledMoment(r).format('YYYY-MM-DD') < today
      ? 'день подачи прошёл'
      : 'технику заказывают заранее';
  const kept = plan.scheduledTime ? `, время ${plan.scheduledTime} сохранено` : '';
  return `Состав перенесён из неё; ${why} — предложен ближайший день: ${day}${kept}.`;
}

/**
 * Describe what stays with the source and what the copy omits.
 *
 * Mention assignment, route, and completion only when present. Attachments never carry over
 * (`assertFilesAttachable`), which must be clear before the new request is saved.
 */
function legacyLine(r: VehicleRequestDto): string {
  const attachments = 'вложения не переносятся — приложите их заново.';
  // Build the list from actual relations so the notice never promises nonexistent retained data.
  const kept = [
    r.assignment ? 'техника' : null,
    r.route ? 'рейс' : null,
    r.completion ? 'факт' : null,
  ].filter((s): s is string => !!s);
  if (kept.length === 0) return `В${attachments.slice(1)}`;
  const last = kept[kept.length - 1]!;
  const listed = kept.length > 1 ? `${kept.slice(0, -1).join(', ')} и ${last}` : last;
  const verb = kept.length > 1 ? 'остаются' : 'остаётся';
  return `${listed[0]!.toUpperCase()}${listed.slice(1)} ${verb} у ${r.displayNumber}; ${attachments}`;
}
