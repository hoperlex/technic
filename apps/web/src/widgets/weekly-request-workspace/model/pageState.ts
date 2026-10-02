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

/**
 * Describe rejection, normal approval, backdated conduct and an idempotent retry distinctly.
 * For conduct, an empty `apply` means the previous request already completed the operation; it is
 * neither a zero-row failure nor a second application (ADR 0101 R31).
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

/** What the workspace needs to decide which actions remain available for this week. */
export interface WeeklyPageWeekState {
  /** Why composition and submission are blocked; `null` means the week is open. */
  weekBlocker: string | null;
  /** Nearest future week offered as the recovery path for an overdue draft. */
  nextWeek: string | undefined;
  overdue: boolean;
  approvesOwn: boolean;
  canApproveWeek: boolean;
  canReject: boolean;
}

/**
 * Derive every week-dependent action from contract predicates. A backdate-capable account may
 * conduct an overdue week within its correction depth; others may still cancel it. Auto-approval
 * remains limited to a future week and an object-scoped role, while rejection keeps the ordinary
 * site approval permission because it changes no historical work.
 */
export function weeklyPageWeekState(input: {
  weekStart: string;
  /** Applied and cancelled documents no longer have editable composition to block. */
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

/** Surface the last rejection in the document itself, not only in its history. */
export function lastRejectionComment(
  entries: WeeklyRequestHistoryEntryDto[] | undefined,
): string | null {
  return (
    (entries ?? [])
      .filter((e) => e.event === 'status' && e.toStatus === 'draft' && e.comment)
      .at(-1)?.comment ?? null
  );
}

/** Name the exact work lost when leaving an unsaved composition. */
export const WEEKLY_LEAVE_CONFIRM = {
  title: 'Уйти, не сохранив состав?',
  content: 'Решения по строкам и добавленная техника не сохранятся.',
  okText: 'Уйти',
  okButtonProps: { danger: true },
  cancelText: 'Остаться',
};

/** Rejection returns its reason to the author; cancellation records it only in history. */
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
