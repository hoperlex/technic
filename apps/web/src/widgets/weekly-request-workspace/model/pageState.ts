import {
  type BackdateAccess,
  isObjectScopedRole,
  isWeeklyWeekOverdue,
  type Permission,
  type Role,
  selectableWeeks,
  WEEKLY_SELECTABLE_WEEKS,
  weeklyApprovalPermission,
  weeklyWeekBlocker,
} from '@technic/contracts';
import type {
  WeeklyDecisionResultDto,
  WeeklyRequestHistoryEntryDto,
} from '@entities/weekly-request';
import { weeklyToday } from '@entities/weekly-request';

/*
 * How the weekly request page answers the week state and the approval outcome: derived predicates
 * and wordings, without a line of markup. Kept apart from the workspace hook because these are
 * rules with no state and no queries, computed from the date, the right and the server answer.
 *
 * No predicate is derived anew here. Past depth, this week's approval right and overdueness are
 * computed by contracts (weeklyWeekBlocker, weeklyApprovalPermission, isWeeklyWeekOverdue), the
 * same ones the server uses in its checks: a second rule list on the client would either lock what
 * the endpoint accepts or offer what it refuses.
 */

/**
 * What the screen says about a completed decision. A function rather than a ladder of conditions
 * in onSuccess: there are four cases now (rejection, regular approval, backdated conduct and its
 * retry).
 *
 * The retry must be told apart. For conduct an empty apply means not "no row applied" but "the
 * previous request already performed this operation" (ADR 0101 R31): the connection dropped, the
 * person clicked again, and nobody moved the terms a second time. A generic "Week applied" would
 * read as a second portion of work here, and "0 rows" as a refusal.
 */
export function decisionMessage(
  res: WeeklyDecisionResultDto,
  approved: boolean,
  conducted: boolean,
): string {
  if (!approved) return 'Заявка отклонена и возвращена в черновик';
  if (!res.apply) {
    return conducted
      ? 'Эта операция уже проведена: обрыв связи ничего не задвоил — неделя применена один раз'
      : 'Неделя согласована и применена';
  }
  const what = conducted ? 'Неделя проведена задним числом' : 'Неделя применена';
  return `${what}: строк ${res.apply.applied}, пропущено ${res.apply.skipped}`;
}

/** What the page knows about the request's week: open or not, overdue or not, who approves it. */
export interface WeeklyPageWeekState {
  /** Why composition and submission are blocked; `null` means the week is open. */
  weekBlocker: string | null;
  /** The nearest week a next request is created for (the way out of an overdue draft). */
  nextWeek: string | undefined;
  overdue: boolean;
  approvesOwn: boolean;
  canApproveWeek: boolean;
  canReject: boolean;
}

/**
 * The week state of this request in one computation, because all six values answer one question:
 * what can no longer be done with this week, and what still can.
 *
 * A week the draft outlived is closed, but not for everyone (ADR 0101): for a holder of the past
 * right it opens within that right's depth, with no refusal at all. Without the right it is the old
 * dead end, only with a way out in words: submitting and approving are impossible, cancelling is
 * always possible (section 8). Depth and bounds are computed by the same weeklyWeekBlocker with the
 * same access argument the server uses in all five of its checks.
 *
 * Auto-approval on submit is only for an object-scoped role (R12); an administrator does not get
 * it. An overdue week has it for nobody (approvesOwnWeeklyRequest): conducting needs a reason and
 * an operation key that the submit body does not carry, so such a request goes to approval, where
 * they are asked.
 *
 * The approval right for THIS week: weeklyRequests.approve for a future one, the past right for an
 * overdue one. The contract chooses (weeklyApprovalPermission), the same way the server does; our
 * own "if overdue then..." would drift from it on the first rule change.
 *
 * The rejection right ignores the week and stays as it was: rejection moves nothing in the past, it
 * returns the request to draft, and giving it to the dispatcher would hand them the decision
 * whether the site needs the equipment, exactly what they do not decide.
 */
export function weeklyPageWeekState(input: {
  weekStart: string;
  /** The composition is still assembled: an applied or cancelled request has no week to lock. */
  composable: boolean;
  isPending: boolean;
  backdate: BackdateAccess;
  role: Role | null | undefined;
  can: (permission: Permission) => boolean;
}): WeeklyPageWeekState {
  const { weekStart, composable, isPending, backdate, role, can } = input;
  const today = weeklyToday();
  /** A started or elapsed week turns approval into a backdated operation. */
  const overdue = isWeeklyWeekOverdue(weekStart, today);
  return {
    weekBlocker: composable
      ? weeklyWeekBlocker(weekStart, today, WEEKLY_SELECTABLE_WEEKS, backdate)
      : null,
    nextWeek: selectableWeeks(today)[0],
    overdue,
    approvesOwn: !overdue && isObjectScopedRole(role) && can('weeklyRequests.approve'),
    canApproveWeek: can(weeklyApprovalPermission(weekStart, today)) && isPending,
    canReject: can('weeklyRequests.approve') && isPending,
  };
}

/**
 * The rejection reason is shown on top of the request itself, not only in history (section 5 step
 * 5).
 */
export function lastRejectionComment(
  entries: WeeklyRequestHistoryEntryDto[] | undefined,
): string | null {
  return (
    (entries ?? [])
      .filter((e) => e.event === 'status' && e.toStatus === 'draft' && e.comment)
      .at(-1)?.comment ?? null
  );
}

/**
 * Leaving the page with an unsaved composition (section 9). Concrete text rather than a vague
 * "there are changes": exactly what the person just did by hand will be lost (row decisions and
 * added equipment), and they must be able to name it before pressing "Leave".
 */
export const WEEKLY_LEAVE_CONFIRM = {
  title: 'Уйти, не сохранив состав?',
  content: 'Решения по строкам и добавленная техника не сохранятся.',
  okText: 'Уйти',
  okButtonProps: { danger: true },
  cancelText: 'Остаться',
};

/**
 * Reason dialog labels: rejecting and cancelling are different actions and promise different
 * things. A rejection reason returns to the author in a visible place of the request, a
 * cancellation reason stays history; the person must understand whom they are writing to.
 */
export function weeklyReasonText(reject: boolean): {
  title: string;
  label: string;
  okText: string;
  placeholderHint: string;
} {
  return reject
    ? {
        title: 'Отклонить недельную заявку',
        label: 'Причина',
        okText: 'Отклонить',
        placeholderHint: 'Причина покажется составителю сверху в самой заявке',
      }
    : {
        title: 'Снять недельную заявку',
        label: 'Причина',
        okText: 'Снять',
        placeholderHint: 'Причина останется в истории заявки',
      };
}
