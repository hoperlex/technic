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
  // A copy does not reopen a cancelled request: a new request with its own number is created and
  // the old refusal stays a refusal. It must be said in words — "create the same" reads as
  // "restore".
  cancelled: ' — копия не возобновляет отменённую',
};

/**
 * Copy-form notice describing what stays with the source and which term is proposed (ADR 0206).
 *
 * Copying is allowed from every status, and this notice is the only place that says so before
 * saving. It answers two real fears at once: "I am about to spoil a completed request" and "why
 * are the dates in the fields not the ones in the card". Unexplained, the second reads as a form
 * bug, and the person edits the proposed term back into the past, where creation rejects it.
 *
 * Text branches on data rather than status: the calendar chooses the proposed term (a cancelled
 * request may have a future term, a "new" one an elapsed term) and populated fields determine what
 * remains attached to the source. Only the heading names the status, repeating the card.
 */
export function copyNotice(r: VehicleRequestDto, minDate: Dayjs, today: string): ReactNode {
  const num = r.displayNumber;
  const extension =
    r.requestType === 'special_equipment' && r.status === 'confirmed'
      ? // Extending an order by copying is usually a mistake: the second request for the same
        // vehicle stands next to the first and collides with its occupancy. The right door is
        // different, so name it directly.
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
 * Human-readable proposed term. A missing end date is a one-day order (the server reads it the
 * same way) and is shown as one date: "23.09.2026 – 23.09.2026" reads as a filling bug.
 *
 * The number of days is omitted on purpose: the day counter already stands under the "end date"
 * field, and a second one would eventually disagree because different rules would count them.
 */
function termText(from: Dayjs, to: Dayjs | null): string {
  return to ? `${dayText(from)} – ${dayText(to)}` : dayText(from);
}

/**
 * Term line selected by request dates rather than status (`copyTermPlan`, `copyScheduledPlan`).
 *
 * A shift has two reasons, named separately. Not only the past moves dates: a term entirely ahead
 * that does not reach the first available day moves by the same shift — for a requester that day
 * is tomorrow, and after 15:00 the day after tomorrow (ADR 0104). Telling them about an "elapsed
 * term" for an order starting tomorrow would be false exactly where the proposed dates are
 * explained.
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
  // No hour when the request has none (`scheduledTimeUnspecified`): "00:00" would read as an agreed
  // midnight delivery that nobody asked for.
  const time = plan.scheduledTime ? `, ${plan.scheduledTime}` : '';
  if (plan.kind === 'ahead')
    return `Состав перенесён из неё, подача предложена прежняя: ${day}${time}.`;
  // The delivery day is a Moscow day key, the same key the term branches on: comparing the moment
  // with browser-zone midnight would name the reason by someone else's calendar.
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
 * Vehicle, route and completion fact are named only when the request has them: promising that
 * "the vehicle stays with T-42" when none was assigned would lie exactly where the person decides
 * whether to copy. Attachments never carry over (`assertFilesAttachable`), and this is said before
 * saving — learning about it afterwards means discovering the loss after the request has gone.
 */
function legacyLine(r: VehicleRequestDto): string {
  const attachments = 'вложения не переносятся — приложите их заново.';
  // Built from what is filled, not printed whole: for an order with an assigned vehicle but no
  // route and no fact, "vehicle, route and fact stay" would name two things the request lacks, and
  // the next line about attachments would be read with the same (misplaced) trust.
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
