import { z } from 'zod';
import { dateOnlySchema } from './common';
import { isDepartmentScopedRole, isObjectScopedRole } from './enums';
import { can, type Permission } from './permissions';
import {
  isMechRentalRunning,
  MECH_EXTEND_NOT_LATER_MESSAGE,
  type MechApprovalSubject,
  type MechRentalState,
} from './mech-requests';

/**
 * Rental extension with the site's visa (ADR 0171, stage 3; plan
 * `docs/mechanization-approval-and-grants-plan.md`, R10, R12).
 *
 * The dispatcher (`mechRequests.extend`) no longer moves the return date: he ASKS for a new one, and
 * the term moves when the site's visa holder (`mechRequests.approve`) signs, in the same transaction
 * as the signature. Between "asked" and "moved" stands someone else's decision, and it can be "no"
 * — the same shape as the vehicle request early end (ADR 0044) and for the same reason: an extension
 * is an agreement to keep paying, and the customer answered that the site signs it.
 *
 * Everything that decides availability lives here once, for the server's refusals and for the
 * portal's buttons: if they drifted apart, a person would press a button that ends in a refusal.
 */

// ── State of a request ──

export const MECH_EXTENSION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type MechExtensionStatus = (typeof MECH_EXTENSION_STATUSES)[number];

export const mechExtensionStatusLabels: Record<MechExtensionStatus, string> = {
  pending: 'ждёт визы',
  approved: 'согласовано',
  rejected: 'отклонено',
};

/**
 * The current extension request of a rental. One per request: a repeated request overwrites it, and
 * the chain of requests and decisions lives in the card history. A pending one disappears when it is
 * withdrawn or the rental ends; a decided one stays until the next request overwrites it.
 */
export interface MechRequestExtensionDto {
  status: MechExtensionStatus;
  /** The return date asked for. */
  newPlannedTo: string;
  /**
   * The planned return when the request was filed. Approval is refused unless the rental still has
   * exactly this date: the visa holder signs a move from this date, not from whatever is there now.
   */
  previousPlannedTo: string;
  reason: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  /** The reason of a refusal (required) or the visa holder's remark on an approval (optional). */
  decisionComment: string;
}

/** The part of a request the predicates below ask: its state and whose site it is. */
export type MechExtensionTarget = MechRentalState & {
  objectId: string;
  plannedTo: string;
  extension: Pick<MechRequestExtensionDto, 'status' | 'newPlannedTo' | 'previousPlannedTo'> | null;
};

/**
 * Why a pending request went away without a decision (R10). Two of the three are automatic: the
 * rental ended under the request — by completion or by the revoked issue mark, which makes the
 * rental not running. Cancellation is not among them: a request exists only on an issued rental,
 * and an issued rental cannot be cancelled (`mechTransitionBlocker`).
 */
export const MECH_EXTENSION_DROP_REASONS = ['withdrawn', 'completed', 'issue_revoked'] as const;
export type MechExtensionDropReason = (typeof MECH_EXTENSION_DROP_REASONS)[number];

/** The words the card history shows; the code itself goes to the audit metadata. */
export const mechExtensionDropReasonLabels: Record<MechExtensionDropReason, string> = {
  withdrawn: 'запрос отозван',
  completed: 'аренда завершена',
  issue_revoked: 'снята отметка выдачи',
};

export function isMechExtensionPending(
  extension: Pick<MechRequestExtensionDto, 'status'> | null | undefined,
): boolean {
  return extension?.status === 'pending';
}

// ── Bodies ──

const versionSchema = z.number().int().nonnegative();

/**
 * Request (or re-request) an extension: the new return date and the reason. The reason is required
 * for the same reason as before the visa — without it the history would keep a moved date and no
 * answer to "why are we paying more". That the date is later than the current one is checked by the
 * server: the schema does not have the current date.
 */
export const requestMechExtensionSchema = z
  .object({
    plannedTo: dateOnlySchema,
    reason: z
      .string()
      .trim()
      .min(1, 'Укажите причину продления')
      .max(500, 'Слишком длинная причина'),
    version: versionSchema,
  })
  .strict();
export type RequestMechExtensionInput = z.infer<typeof requestMechExtensionSchema>;

/**
 * The decision: approval or refusal in one body, because both have one permission, one scope and one
 * rule "only a pending request" — split into two routes, the checks would drift at the first edit
 * (the same choice as the request visa). A refusal requires its reason; an approval may carry a
 * remark.
 */
export const decideMechExtensionSchema = z
  .object({
    approved: z.boolean(),
    comment: z.string().trim().max(500, 'Слишком длинный комментарий').optional().default(''),
    version: versionSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.approved && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отказа' });
    }
  });
export type DecideMechExtensionInput = z.input<typeof decideMechExtensionSchema>;

// ── Refusals: one text for the server's answer and the portal's hint ──

export const MECH_EXTENSION_NOT_RUNNING_MESSAGE =
  'Продление запрашивают у действующей аренды: техника либо ещё не выдана, либо уже возвращена';

export const MECH_EXTENSION_NOT_PENDING_MESSAGE =
  'Ожидающего визы запроса продления нет: его уже решили или отозвали';

export const MECH_EXTENSION_SCOPE_MESSAGE =
  'Продление аренды визирует ответственное лицо этой площадки';

export const MECH_EXTENSION_ENDED_MESSAGE =
  'Аренда больше не идёт — продлевать нечего: запрос можно только отклонить или отозвать';

export const MECH_EXTENSION_TERM_CHANGED_MESSAGE =
  'Срок аренды изменился после запроса — нужен новый запрос продления';

// ── Who may decide ──

/**
 * May the subject decide this extension (R10): the visa permission, the OBJECT axis and the
 * request's own site. A department role never decides, an axis-less role (administrator) always
 * may.
 *
 * Deliberately narrower than `canApproveMechRequest`: there the department head may sign a request
 * his department filed on its site, because the customer answered "the site or the department head,
 * whoever is first". For an extension the answer was "the site signs it": it is the further cost of a
 * rental already running on the site, not the department's request. Hence no department branch.
 *
 * `has` answers the permission. The server leaves the default (the matrix over its own principal is
 * exactly what it builds the session list with); the portal passes its `can`, which reads the list
 * the server computed (ADR 0223) — the predicate keeps its scope rule, the permission comes from one
 * oracle.
 */
export function canApproveMechExtension(
  subject: MechApprovalSubject | null | undefined,
  row: { objectId: string },
  has: (permission: Permission) => boolean = (permission) => can(subject, permission),
): boolean {
  if (!has('mechRequests.approve')) return false;
  const role = subject?.role;
  if (isObjectScopedRole(role)) {
    return (subject?.constructionObjectIds ?? []).includes(row.objectId);
  }
  if (isDepartmentScopedRole(role)) return false;
  return true;
}

// ── What the state of the rental allows ──

/**
 * Why a request (or a changed request) is refused by the rental's state, or `null`. Only a running
 * rental is extended — the whole predicate of R2, not a filled issue date: a request not yet issued
 * has its term edited by the form while it is "Новая", and after a completion rollback the
 * equipment is already back. The new date must be strictly later than the current one: an earlier
 * one is a completion with the actual date.
 */
export function mechExtensionRequestBlocker(
  row: MechRentalState & { plannedTo: string },
  plannedTo: string,
): string | null {
  if (!isMechRentalRunning(row)) return MECH_EXTENSION_NOT_RUNNING_MESSAGE;
  // `YYYY-MM-DD` compares lexicographically exactly as it does chronologically.
  if (plannedTo <= row.plannedTo) return MECH_EXTEND_NOT_LATER_MESSAGE;
  return null;
}

/**
 * Why an approval is refused by the state, or `null`. The state is re-read at the moment of the
 * signature, not taken from the request's snapshot: a night passes between the request and the
 * visa, the equipment could have come back, the old door could have moved the term. A refusal, by
 * contrast, needs only a pending request — refusing an extension that is no longer relevant is
 * legitimate.
 */
export function mechExtensionApprovalBlocker(row: MechExtensionTarget): string | null {
  const extension = row.extension;
  if (!extension || extension.status !== 'pending') return MECH_EXTENSION_NOT_PENDING_MESSAGE;
  if (!isMechRentalRunning(row)) return MECH_EXTENSION_ENDED_MESSAGE;
  if (row.plannedTo !== extension.previousPlannedTo || extension.newPlannedTo <= row.plannedTo) {
    return MECH_EXTENSION_TERM_CHANGED_MESSAGE;
  }
  return null;
}

/**
 * What the subject may do with the rental's extension right now — the portal's buttons. Built from
 * the same blockers the server answers with, so a shown button never ends in a 422; the server still
 * checks each step on the locked row.
 *
 * - `request` — ask, or change the pending request (a repeated request overwrites it);
 * - `approve` / `reject` — the visa holder of this site, on a pending request; approval also needs
 *   the rental to be unchanged since the request (`approveBlocker` says why it is not);
 * - `withdraw` — any `.extend` holder, not only the author: the dispatch office keeps one queue,
 *   and a request must not hang while its author is on leave.
 */
export interface MechExtensionAccess {
  request: boolean;
  approve: boolean;
  reject: boolean;
  withdraw: boolean;
  /** Why approval is not possible although the subject may decide; `null` — it is possible. */
  approveBlocker: string | null;
}

export function mechExtensionAccess(
  subject: MechApprovalSubject | null | undefined,
  row: MechExtensionTarget & { deletedAt: string | null },
  has: (permission: Permission) => boolean,
): MechExtensionAccess {
  const live = row.deletedAt === null;
  const pending = live && isMechExtensionPending(row.extension);
  const decides = pending && canApproveMechExtension(subject, row, has);
  const approveBlocker = decides ? mechExtensionApprovalBlocker(row) : null;
  return {
    request: live && has('mechRequests.extend') && isMechRentalRunning(row),
    approve: decides && approveBlocker === null,
    reject: decides,
    withdraw: pending && has('mechRequests.extend'),
    approveBlocker,
  };
}
