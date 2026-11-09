import { z } from 'zod';
import { baseListQuery, dateOnlySchema, sortOrderSchema, uuidSchema } from './common';
import type { MechRateUnit, RequestStatus } from './enums';
import type { AttachedFileDto } from './files';
import {
  canApproveMechRequest,
  type MechApprovalSubject,
  type MechApprovalTarget,
} from './mech-approval';
import { actsForCounterparty, type AccessSubject, type Permission } from './permissions';

/**
 * The lessor's receipt of a mechanization rental (plan `docs/mechanization-lessor-receipt-plan.md`).
 *
 * After «Взять в работу» the lessor or the office attaches one PDF or JPG file; a holder of the
 * request visa approves or rejects it, or allows completion «без чека» with a reason; completion
 * waits for an approved or waived receipt. Every version stays openable (O8): one table keeps a row
 * per version, the current one is the row not retired (P1).
 *
 * Everything that decides availability lives here once, for the server's refusals and the portal's
 * buttons: if they drifted apart, a person would press a button that ends in a refusal.
 *
 * **This file never imports `mech-requests.ts` at runtime.** `mechTransitionBlocker` there asks the
 * completion gate below, and a reverse import would close a cycle and drag the module's whole rule
 * set after the receipt into every chunk that asks the gate. The visa circle comes from the leaf
 * `mech-approval.ts` for the same reason. Type-only imports are erased and cost nothing.
 *
 * The name is always «lessor receipt» (P2): a bare `receipt` already means the create receipt of
 * ADR 0231, garage auto-part receipts and warehouse receipt lines.
 */

// ── Statuses and words ──

/**
 * - `pending` — a file waits for the visa;
 * - `approved` / `rejected` — the visa holder's decision on a file;
 * - `waived` — the «без чека» visa (O10): a row without a file, created by the visa holder in its
 *   final state.
 *
 * Retiring a version never changes its status (P1): "approved, replaced on …" and "not decided,
 * replaced" are two facts, and one status column could hold only one of them.
 */
export const MECH_LESSOR_RECEIPT_STATUSES = ['pending', 'approved', 'rejected', 'waived'] as const;
export type MechLessorReceiptStatus = (typeof MECH_LESSOR_RECEIPT_STATUSES)[number];

export const mechLessorReceiptStatusLabels: Record<MechLessorReceiptStatus, string> = {
  pending: 'ждёт визы',
  approved: 'утверждён',
  rejected: 'отклонён',
  waived: 'без чека',
};

/**
 * Why a version is no longer current (P1, P8):
 *
 * - `replaced` — a newer version or a waiver took its place;
 * - `deal_changed` — the lessor, the unit or the rate changed: the receipt was issued under other
 *   terms;
 * - `rolled_back` — the request entered «Новая» and its deal was erased;
 * - `revoked` — a waiver withdrawn by the visa holder (a file version goes back to `pending`
 *   instead, P5).
 */
export const MECH_LESSOR_RECEIPT_RETIRE_REASONS = [
  'replaced',
  'deal_changed',
  'rolled_back',
  'revoked',
] as const;
export type MechLessorReceiptRetireReason = (typeof MECH_LESSOR_RECEIPT_RETIRE_REASONS)[number];

export const mechLessorReceiptRetireReasonLabels: Record<MechLessorReceiptRetireReason, string> = {
  replaced: 'заменён',
  deal_changed: 'изменилась договорённость',
  rolled_back: 'заявка возвращена в «Новую»',
  revoked: '«без чека» отменено',
};

/**
 * Who attached a version, fixed at insert (P1). The lessor's view shows this word instead of a name
 * (P12); deriving it later from the author's account would relabel old versions after an account
 * changes.
 */
export const MECH_LESSOR_RECEIPT_AUTHORS = ['lessor', 'office'] as const;
export type MechLessorReceiptAuthor = (typeof MECH_LESSOR_RECEIPT_AUTHORS)[number];

export const mechLessorReceiptAuthorLabels: Record<MechLessorReceiptAuthor, string> = {
  lessor: 'арендодатель',
  office: 'офис',
};

/**
 * The types a receipt file may have (O4, P7). The server compares the content type the browser
 * declared at upload; the plan does not sniff bytes — a mislabelled file fails to render in the
 * preview and gets rejected.
 */
export const MECH_LESSOR_RECEIPT_CONTENT_TYPES = ['application/pdf', 'image/jpeg'] as const;

/** The `accept` of the upload input; iOS Safari converts a library photo to JPEG under it. */
export const MECH_LESSOR_RECEIPT_ACCEPT = '.pdf,.jpg,.jpeg';

export function isMechLessorReceiptContentType(contentType: string): boolean {
  return (MECH_LESSOR_RECEIPT_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * How many versions one lessor account may attach within one deal (P7). The cap is the lessor's
 * only: it guards against an external loop, and capping the office too would let a lessor's loop
 * lock the office out of attaching the real receipt.
 */
export const MECH_LESSOR_RECEIPT_LESSOR_CAP = 20;

// ── Refusals: one text for the server's answer and the portal's hint ──

export const MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE = 'Чек прикрепляют к аренде в работе';
export const MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE = 'Утверждённый чек меняет диспетчер';
export const MECH_LESSOR_RECEIPT_CAP_MESSAGE = 'Слишком много замен чека — обратитесь к диспетчеру';
export const MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE = 'Чек принимается в PDF или JPG';
export const MECH_LESSOR_RECEIPT_NOT_PENDING_MESSAGE =
  'Решать нечего: чек не ждёт визы — его уже решили или заменили';
export const MECH_LESSOR_RECEIPT_REVOKE_NOT_IN_WORK_MESSAGE =
  'Решение по чеку отзывают, пока аренда в работе';
export const MECH_LESSOR_RECEIPT_NOTHING_TO_REVOKE_MESSAGE =
  'Отзывать нечего: чек не утверждён и «без чека» не разрешено';
export const MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE =
  'Завершение без чека разрешают аренде в работе';
export const MECH_LESSOR_RECEIPT_WAIVER_APPROVED_MESSAGE =
  'Чек уже утверждён — разрешать завершение без него не нужно';
export const MECH_LESSOR_RECEIPT_WAIVER_REPEATED_MESSAGE = 'Завершение без чека уже разрешено';
/** The version 409 when the window's version is no longer current (P5). */
export const MECH_LESSOR_RECEIPT_STALE_MESSAGE =
  'Чек заменили, пока окно было открыто — откройте его заново';
export const MECH_LESSOR_RECEIPT_SCOPE_MESSAGE =
  'Чек арендодателя визирует ответственное лицо площадки или отдела-заявителя этой аренды';
/** The lessor's 403 on every mechanization door not marked for him (P11). */
export const MECH_LESSOR_DOOR_MESSAGE = 'Арендодателю доступен только список его аренд';

// ── Bodies ──

const versionSchema = z.number().int().nonnegative();
const reasonSchema = z.string().trim().max(500, 'Слишком длинная причина');

/** Attach or replace (P7): the uploaded file and the request version the person saw. */
export const attachMechLessorReceiptSchema = z
  .object({
    fileId: uuidSchema,
    version: versionSchema,
  })
  .strict();
export type AttachMechLessorReceiptInput = z.infer<typeof attachMechLessorReceiptSchema>;

export const MECH_LESSOR_RECEIPT_DECISIONS = ['approve', 'reject', 'revoke'] as const;
export type MechLessorReceiptDecision = (typeof MECH_LESSOR_RECEIPT_DECISIONS)[number];

/**
 * A decision of the visa holder (P5). `receiptId` is the version shown in the window: the server
 * binds the write to it, so a signature never lands on a version the holder did not see. A
 * rejection and a revocation need their reason; an approval may carry a remark.
 */
export const decideMechLessorReceiptSchema = z
  .object({
    receiptId: uuidSchema,
    decision: z.enum(MECH_LESSOR_RECEIPT_DECISIONS),
    comment: reasonSchema.optional().default(''),
    version: versionSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.decision !== 'approve' && !v.comment) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: v.decision === 'reject' ? 'Укажите причину отказа' : 'Укажите причину отзыва',
      });
    }
  });
export type DecideMechLessorReceiptInput = z.input<typeof decideMechLessorReceiptSchema>;

/** The «без чека» visa (P6): the reason is required — it is the only record of why. */
export const waiveMechLessorReceiptSchema = z
  .object({
    comment: reasonSchema.min(1, 'Укажите, почему аренду завершают без чека'),
    version: versionSchema,
  })
  .strict();
export type WaiveMechLessorReceiptInput = z.infer<typeof waiveMechLessorReceiptSchema>;

// ── DTO ──

/**
 * A version as the office sees it: names and every reason. `file` is `null` for a waiver.
 */
export interface MechLessorReceiptVersionDto {
  id: string;
  versionNo: number;
  status: MechLessorReceiptStatus;
  file: AttachedFileDto | null;
  createdBy: string;
  createdByName: string;
  createdAs: MechLessorReceiptAuthor;
  createdAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  /** The rejection or waiver reason, the revocation's is in the history; a remark on approval. */
  decisionComment: string;
  retiredAt: string | null;
  retiredByName: string | null;
  retiredReason: MechLessorReceiptRetireReason | null;
}

/**
 * A version as the lessor sees it (P12): an allow-list, not the office DTO with blanks. No staff
 * names — who attached it is the word of `createdAs`; the only reason shown is a rejection's,
 * because the lessor has to fix something. A waiver and a revocation show their status and date:
 * their reasons are internal notes of the office.
 */
export interface MechLessorReceiptVersionView {
  id: string;
  versionNo: number;
  status: MechLessorReceiptStatus;
  file: AttachedFileDto | null;
  createdAs: MechLessorReceiptAuthor;
  createdAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  retiredAt: string | null;
  retiredReason: MechLessorReceiptRetireReason | null;
}

/**
 * The receipt block of a rental for one audience: whether completion waits for a receipt, the
 * current version and the retired ones, newest first. The office sees every version of the
 * request; the lessor only those of the current deal (`mechLessorVisibleVersions`).
 *
 * The audience is a discriminant, not a flag next to one shape: the lessor's reply is built by its
 * own function from the allow-list, and a union makes a caller that mixes the two fail to compile.
 */
export type MechLessorReceiptStateDto =
  | {
      audience: 'office';
      required: boolean;
      current: MechLessorReceiptVersionDto | null;
      retired: MechLessorReceiptVersionDto[];
    }
  | {
      audience: 'lessor';
      required: boolean;
      current: MechLessorReceiptVersionView | null;
      retired: MechLessorReceiptVersionView[];
      /**
       * Versions this account attached within the current deal — what the cap of P7 counts. Sent
       * by the server so that the portal hides «Заменить чек» exactly when the server would refuse.
       */
      ownVersionCount: number;
    };

/** The reply of every receipt door (P5–P7): the request's new version and the block. */
export interface MechLessorReceiptReplyDto {
  version: number;
  lessorReceipt: MechLessorReceiptStateDto;
}

/**
 * One rental as the lessor sees it (P12, O7). Built field by field on the server
 * (`toMechLessorRentalDto`), never by blanking `MechRequestDto`: a field added there tomorrow must
 * not reach the lessor by default. Not shown: the department, the requester, the comment and
 * files, the request visa, the cancel reason, worked units, the final cost, the extension, the card
 * history and the versions of earlier deals.
 */
export interface MechLessorRentalDto {
  id: string;
  num: number;
  displayNumber: string;
  version: number;
  status: RequestStatus;
  mechModelName: string | null;
  objectName: string;
  objectAddress: string;
  plannedFrom: string;
  plannedTo: string;
  actualFrom: string | null;
  actualTo: string | null;
  rate: number | null;
  rateUnit: MechRateUnit | null;
  /** Who meets the machine on the site. */
  responsibleName: string;
  responsiblePhone: string;
  lessorReceipt: Extract<MechLessorReceiptStateDto, { audience: 'lessor' }>;
}

// ── The current version and the rental, as the predicates ask them ──

/** The current version as the predicates need it: its status only. `null` — no current row. */
export type MechLessorReceiptCurrent = { status: MechLessorReceiptStatus } | null;

/**
 * The rental's side of the receipt rules. Narrow on purpose, like `MechRentalState`: a locked row
 * of the server, a list row and the portal's DTO all fit it without loading more.
 */
export interface MechLessorReceiptTarget {
  status: RequestStatus;
  deletedAt: string | null;
  /** Completion waits for a receipt (P3): set at take-in-work and by attaching, never cleared. */
  lessorReceiptRequired: boolean;
  lessorReceipt: MechLessorReceiptCurrent;
}

// ── Who is the lessor ──

/**
 * The subject of the lessor rules: an access subject plus its counterparty. On the server the
 * principal fits as is; in the portal the current user does.
 */
export type MechLessorSubject = AccessSubject & { counterpartyId?: string | null };

/** An account of a mechanization lessor (ADR 0038 shape: the executor role plus the type). */
export function isMechLessorSubject(subject: AccessSubject | null | undefined): boolean {
  return actsForCounterparty(subject, 'mech_lessor');
}

/**
 * **The one predicate for everything the lessor may touch** (P11): his counterparty's rental, «В
 * работе» (O12), not archived. The lessor doors, the attach door for a lessor and his receipt-file
 * flag all ask it, so a rental that closed is gone from all three at once. Its SQL twin
 * (`mechLessorRentalVisibleWhere`, server) is pinned against it over a grid of rows.
 *
 * A subject who is not a mechanization lessor sees no rental through this predicate: it answers
 * "is it the lessor's", not "may anyone see it".
 */
export function isMechLessorRentalVisible(
  subject: MechLessorSubject | null | undefined,
  row: { lessorId: string | null; status: RequestStatus; deletedAt: string | null },
): boolean {
  if (!isMechLessorSubject(subject)) return false;
  const counterpartyId = subject?.counterpartyId;
  return (
    !!counterpartyId &&
    row.lessorId === counterpartyId &&
    row.status === 'confirmed' &&
    row.deletedAt === null
  );
}

/**
 * The versions of the **current deal** (P12): back to, not including, the last version retired
 * because the deal changed or the request went back to «Новая». Older versions were issued under
 * other terms and may belong to another lessor. One function for the lessor's DTO, the replies of
 * P5–P7, the cap of P7 and the lessor's file flag, so the four cannot disagree on where a deal
 * starts. Returns the versions in ascending `versionNo` order whatever the input order.
 */
export function mechLessorVisibleVersions<
  T extends { versionNo: number; retiredReason: MechLessorReceiptRetireReason | null },
>(versions: readonly T[]): T[] {
  const sorted = [...versions].sort((a, b) => a.versionNo - b.versionNo);
  let start = 0;
  sorted.forEach((version, index) => {
    if (version.retiredReason === 'deal_changed' || version.retiredReason === 'rolled_back') {
      start = index + 1;
    }
  });
  return sorted.slice(start);
}

// ── What the state allows ──

/**
 * Why attaching (or replacing) is refused by the state, or `null` (P7). The module's protocol comes
 * first on the server — the lock, existence and scope, the version 409, the archive — and the file
 * checks after; this answers only what the rental and the current version say:
 *
 * - only «В работе» (O1): before the deal there is nothing to pay, after completion the receipt is
 *   the basis of a closed rental and is replaced through «Вернуть в работу»;
 * - the lessor replaces only a pending or rejected version (O13): an approval or a waiver closes
 *   the question, and reopening it is the office's call;
 * - the lessor's cap per account within the deal; `lessorVersionCount` is that count.
 */
export function mechLessorReceiptAttachBlocker(input: {
  row: Pick<MechLessorReceiptTarget, 'status'>;
  current: MechLessorReceiptCurrent;
  lessorVersionCount: number;
  actsAsLessor: boolean;
}): string | null {
  const { row, current, lessorVersionCount, actsAsLessor } = input;
  if (row.status !== 'confirmed') return MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE;
  if (!actsAsLessor) return null;
  if (current && (current.status === 'approved' || current.status === 'waived')) {
    return MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE;
  }
  if (lessorVersionCount >= MECH_LESSOR_RECEIPT_LESSOR_CAP) return MECH_LESSOR_RECEIPT_CAP_MESSAGE;
  return null;
}

/**
 * Why a decision is refused by the state, or `null` (P5):
 *
 * - `approve` / `reject` — the current version is pending. The request's status is not asked: a
 *   pending receipt can exist on a rental cancelled after it was attached, and deciding it is still
 *   useful (a prepayment); a done rental never holds one (the completion gate), and a return to
 *   «Новая» retires it;
 * - `revoke` — the current version is approved or waived, and the rental is «В работе» (O15): after
 *   completion the approval is the basis of a closed rental.
 */
export function mechLessorReceiptDecisionBlocker(
  row: Pick<MechLessorReceiptTarget, 'status'>,
  current: MechLessorReceiptCurrent,
  decision: MechLessorReceiptDecision,
): string | null {
  if (decision === 'revoke') {
    if (!current || (current.status !== 'approved' && current.status !== 'waived')) {
      return MECH_LESSOR_RECEIPT_NOTHING_TO_REVOKE_MESSAGE;
    }
    if (row.status !== 'confirmed') return MECH_LESSOR_RECEIPT_REVOKE_NOT_IN_WORK_MESSAGE;
    return null;
  }
  return current?.status === 'pending' ? null : MECH_LESSOR_RECEIPT_NOT_PENDING_MESSAGE;
}

/**
 * Why the «без чека» visa is refused by the state, or `null` (P6): the rental is «В работе», and
 * the current version is absent, pending or rejected — not approved (nothing to allow) and not
 * already waived (a second one is noise). Over a pending file it replaces the file: the holder saw
 * it in the window and decided the rental is closed without it.
 */
export function mechLessorReceiptWaiverBlocker(
  row: Pick<MechLessorReceiptTarget, 'status'>,
  current: MechLessorReceiptCurrent,
): string | null {
  if (row.status !== 'confirmed') return MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE;
  if (current?.status === 'approved') return MECH_LESSOR_RECEIPT_WAIVER_APPROVED_MESSAGE;
  if (current?.status === 'waived') return MECH_LESSOR_RECEIPT_WAIVER_REPEATED_MESSAGE;
  return null;
}

/**
 * **The completion gate** (P3), asked by `mechTransitionBlocker` for `to === 'done'`. A state
 * barrier: nobody bypasses it, the administrator included (ADR 0152 decision 7) — a stuck rental is
 * closed by the «без чека» visa with a reason. It applies to every completion, the repeat after
 * «Вернуть в работу» included: the approval survives that rollback, so the repeat passes unless the
 * receipt was replaced or the approval revoked in between.
 *
 * `lessorReceiptRequired = false` is a rental taken into work before the release, and it is not
 * gated (accepted by the owner); one that later got a receipt is gated like a new one.
 */
export function mechLessorReceiptCompletionBlocker(
  row: Pick<MechLessorReceiptTarget, 'lessorReceiptRequired' | 'lessorReceipt'>,
): string | null {
  if (!row.lessorReceiptRequired) return null;
  switch (row.lessorReceipt?.status) {
    case 'approved':
    case 'waived':
      return null;
    case 'pending':
      return 'Чек арендодателя ждёт визы — аренду завершают после неё';
    case 'rejected':
      return 'Чек арендодателя отклонён — прикрепите исправленный';
    default:
      return 'Прикрепите чек арендодателя или получите визу «без чека»';
  }
}

// ── The mark ──

/**
 * A second mark next to the state tag (P16), not a fifth value of it: the state tag is the
 * rental's single state (ADR 0171 decision 13), and a receipt can wait for a visa in any of them.
 * Archived rows show no mark. A rejected or missing receipt is a call to act only while the rental
 * is «В работе»; a pending one stays visible on a cancelled rental, which may still be decided.
 */
export type MechLessorReceiptMark = 'pending' | 'rejected' | 'missing';

export const mechLessorReceiptMarkLabels: Record<MechLessorReceiptMark, string> = {
  pending: 'чек ждёт визы',
  rejected: 'чек отклонён',
  missing: 'нет чека',
};

/**
 * The filter «Чек» of the list and the history (P16), asked of the current version: `missing` is a
 * rental that requires a receipt and has no current version; a rental that does not require one
 * matches no value. The server serves it by `EXISTS` / `NOT EXISTS` over the current row, never by
 * a join — the count query of the list joins only the site and the model.
 */
export const MECH_LESSOR_RECEIPT_FILTERS = [
  'pending',
  'rejected',
  'missing',
  'approved',
  'waived',
] as const;
export type MechLessorReceiptFilter = (typeof MECH_LESSOR_RECEIPT_FILTERS)[number];

export const mechLessorReceiptFilterLabels: Record<MechLessorReceiptFilter, string> = {
  pending: 'ждёт визы',
  rejected: 'отклонён',
  missing: 'нет',
  approved: 'утверждён',
  waived: 'без чека',
};

// ── The lessor's list (P12) ──

/**
 * The lessor sorts his rentals by the planned return — when the machine leaves the site is the one
 * date he plans by. One field on purpose: a sort by a column he is not shown would leak its order.
 */
export const MECH_LESSOR_RENTAL_SORT_FIELDS = ['plannedTo'] as const;

/**
 * The query of `GET /mech-requests/lessor-rentals` (P12): the module's list envelope with paging,
 * the period (rentals whose term crosses these days, as in the office list) and the receipt state
 * of the current version. The search looks only at what the lessor's card shows: a search over a
 * hidden column would answer "is this word in the comment" one rental at a time.
 *
 * Soonest return first by default, unlike the office lists (newest first): the lessor reads the
 * list as "what comes back next".
 */
export const mechLessorRentalListQuerySchema = baseListQuery(MECH_LESSOR_RENTAL_SORT_FIELDS).extend(
  {
    periodFrom: dateOnlySchema.optional(),
    periodTo: dateOnlySchema.optional(),
    lessorReceipt: z.enum(MECH_LESSOR_RECEIPT_FILTERS).optional(),
    sortOrder: sortOrderSchema.default('asc'),
  },
);
export type MechLessorRentalListQuery = z.infer<typeof mechLessorRentalListQuerySchema>;

export function mechLessorReceiptMark(row: MechLessorReceiptTarget): MechLessorReceiptMark | null {
  if (row.deletedAt !== null) return null;
  const status = row.lessorReceipt?.status;
  if (status === 'pending') return 'pending';
  if (row.status !== 'confirmed') return null;
  if (status === 'rejected') return 'rejected';
  if (!row.lessorReceipt && row.lessorReceiptRequired) return 'missing';
  return null;
}

// ── The portal's buttons ──

/**
 * What the subject may do with the rental's receipt right now (P15) — built from the same blockers
 * the server answers with, so a shown button never ends in a 422; the server still checks each step
 * on the locked row.
 *
 * - `attach` — «Прикрепить чек», or «Заменить чек» when `replace` says a current version exists;
 * - `review` — «Проверить чек»: the visa window over a pending version, with «Утвердить» and
 *   «Отклонить»; `waive` is then offered inside the window too;
 * - `waive` — «Без чека»: in the window over a pending file, otherwise its own item with a reason
 *   dialog (no current version, or a rejected one);
 * - `revokeApproval` — «Отозвать утверждение»; `revokeWaiver` — «Отменить „без чека“».
 */
export interface MechLessorReceiptAccess {
  attach: boolean;
  replace: boolean;
  review: boolean;
  waive: boolean;
  revokeApproval: boolean;
  revokeWaiver: boolean;
}

/**
 * `row.lessorVersionCount` is the subject's own versions within the current deal — the cap of P7,
 * asked only for a lessor; the office passes anything (`0`). `has` answers the permission from the
 * server's list (ADR 0223), the rules stay here.
 *
 * A lessor attaches only to a rental `isMechLessorRentalVisible` gives him; he never decides — the
 * visa circle refuses every counterparty-scoped role (`canApproveMechRequest`, P5).
 */
export function mechLessorReceiptAccess(
  subject: (MechApprovalSubject & MechLessorSubject) | null | undefined,
  row: MechLessorReceiptTarget &
    MechApprovalTarget & { lessorId: string | null; lessorVersionCount: number },
  has: (permission: Permission) => boolean,
): MechLessorReceiptAccess {
  const live = row.deletedAt === null;
  const current = row.lessorReceipt;
  const actsAsLessor = isMechLessorSubject(subject);
  const attach =
    live &&
    has('mechRequests.lessorReceipt') &&
    (!actsAsLessor || isMechLessorRentalVisible(subject, row)) &&
    mechLessorReceiptAttachBlocker({
      row,
      current,
      lessorVersionCount: row.lessorVersionCount,
      actsAsLessor,
    }) === null;
  const decides = live && canApproveMechRequest(subject, row, has);
  const revokes = decides && mechLessorReceiptDecisionBlocker(row, current, 'revoke') === null;
  return {
    attach,
    replace: attach && current !== null,
    review: decides && mechLessorReceiptDecisionBlocker(row, current, 'approve') === null,
    waive: decides && mechLessorReceiptWaiverBlocker(row, current) === null,
    revokeApproval: revokes && current?.status === 'approved',
    revokeWaiver: revokes && current?.status === 'waived',
  };
}
