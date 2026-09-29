import { Alert } from 'antd';
import type { OperationRequirement, RepairPreviewDto, RepairResultDto } from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { listStyle } from './consequencesList';

/**
 * What the "History repair" window says about itself, apart from the consequences list: why a
 * repair will also restore an archived request, and what is still left after a repair went through.
 *
 * A file of its own because the window is a conversation (inspect, preview, refusals, confirmation)
 * and these are two of its replies; keeping them there would push the window past the length budget
 * of the portal, and neither reply is input (`RepairFields.tsx`).
 */

/**
 * The shown consequences were computed with `restore` (R29): the repair touches paper that is
 * still valid for an archived request, so it only goes through together with taking the request
 * out of the archive — in the same operation.
 *
 * Whether the person may do that is not checked here: the right is the server's, and a refusal
 * comes back as the same in-window "not enough rights" text as any other.
 */
export function RepairRestoreAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      title="Заявка в архиве — починка восстановит её"
      description="Ремонт затрагивает бумагу, которая по архивной заявке осталась действующей, поэтому пройдёт только вместе с выводом заявки из архива — той же операцией. Для этого нужно право на восстановление из архива."
    />
  );
}

/**
 * The step back after a 422 on `restore`: the server found at the command that this archived
 * repair needs restoring (the undecided tail of an archived request is refused this way without
 * being flagged by `restoreRequired`). The window recomputes the preview with `restore` and says why.
 */
export const RESTORE_RECHECK =
  'Ремонт этой архивной заявки проходит только вместе с её восстановлением — последствия пересчитаны с ним. Прочитайте и подтвердите заново.';

/**
 * Why the repair asks for a reason, by the outcome the server computed (R32) — not by the calendar.
 *
 * The two outcomes read differently to the person. `crew` rewrites worked days and their paper;
 * `assignment_tail` touches no worked day but still goes to the journal — the typical case is the
 * anchor offered after a fill, from today to the end of the term. Telling that person "the repair
 * touches worked days" would be false and would make them look for paper that is not there.
 */
export function repairReasonHint(requirement: OperationRequirement): string {
  return requirement.kind === 'crew'
    ? 'Ремонт задевает уже отработанные дни: он пойдёт записью в журнал коррекций, и без объяснения её там быть не может.'
    : 'Ремонт меняет уже принятое решение о машинисте: он пойдёт записью в журнал коррекций, и без объяснения её там быть не может.';
}

/**
 * The toast after a repair, chosen by the fresh inspection: "history fixed" only when nothing is
 * left; otherwise the toast says there is more, and the window lists it.
 */
export function repairDoneMessage(res: RepairResultDto, after: RepairPreviewDto | undefined) {
  if (res.repeated) return 'Этот ремонт уже был проведён';
  return after && repairLeftoverLines(after).length > 0
    ? 'Ремонт записан — в истории осталось, что чинить'
    : 'История заявки исправлена';
}

/**
 * What the fresh inspection still finds after a repair — shown instead of a bare "history fixed".
 *
 * WHY. Filling unknown days is allowed only on locked days, and the server stops the named person
 * at the last locked day: from the first day that can still be changed the driver stays unknown
 * (decision R5, "two operations"). The request then needs an anchor as a separate command, and a
 * window that just said "fixed" would hide exactly that. The list below is the server's inspection,
 * not a portal guess: the same `requiredAnchors`, `fillableGaps` and tail the window asks about.
 *
 * Renders nothing when there is nothing left; the window then says the history is complete.
 */
export function RepairLeftoverAlert({ state }: { state: RepairPreviewDto }) {
  const lines = repairLeftoverLines(state);
  if (lines.length === 0) return null;
  return (
    <Alert
      type="info"
      showIcon
      title="Ремонт записан, но история ещё не полна"
      description={
        <ul style={listStyle}>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      }
    />
  );
}

/** What is left, one line per piece of work; empty — the history is complete. */
export function repairLeftoverLines(state: RepairPreviewDto): string[] {
  return [
    ...state.requiredAnchors.map(
      (gap) =>
        `${formatDateOnly(gap.from)} — ${formatDateOnly(gap.to)}: машинист неизвестен. Эти дни ещё изменяемые, заполнением их не закрыть — назовите машиниста ниже, это отдельная операция.`,
    ),
    ...state.fillableGaps.map(
      (gap) =>
        `${formatDateOnly(gap.from)} — ${formatDateOnly(gap.to)}: закрытые дни, машинист по-прежнему неизвестен.`,
    ),
    ...(state.requiredVehicleResolution
      ? ['Не решено, чем заявка закрыта после конца срока.']
      : []),
  ];
}
