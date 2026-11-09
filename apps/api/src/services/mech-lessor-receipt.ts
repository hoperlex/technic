import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import {
  type AttachedFileDto,
  type AttachMechLessorReceiptInput,
  canApproveMechRequest,
  type decideMechLessorReceiptSchema,
  isMechLessorReceiptContentType,
  isMechLessorRentalVisible,
  isMechLessorSubject,
  MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE,
  MECH_LESSOR_RECEIPT_SCOPE_MESSAGE,
  MECH_LESSOR_RECEIPT_STALE_MESSAGE,
  type MechLessorReceiptAuthor,
  mechLessorReceiptAttachBlocker,
  type MechLessorReceiptDecision,
  mechLessorReceiptDecisionBlocker,
  type MechLessorReceiptReplyDto,
  type MechLessorReceiptRetireReason,
  type MechLessorReceiptStateDto,
  type MechLessorReceiptStatus,
  type MechLessorReceiptVersionDto,
  type MechLessorReceiptVersionView,
  mechLessorReceiptWaiverBlocker,
  mechLessorVisibleVersions,
  type WaiveMechLessorReceiptInput,
} from '@technic/contracts';
import { files, mechRequestLessorReceipts, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAuditTx } from '../lib/audit';
import type { Principal } from '../auth/principal';
import { attachedFileView } from './file-view';
import type { MechReader, MechTx } from './mech-request-dto';
import {
  mechLessorReceiptAttachChanges,
  mechLessorReceiptDecisionChanges,
  mechLessorReceiptRetireChanges,
  mechLessorReceiptWaiveChanges,
} from './mech-request-diff';
import {
  assertMechRequestLive,
  assertMechRequestOpenable,
  bumpRequest,
  lockMechRequest,
} from './mech-request-guards';
import { assertFilesAttachable } from './request-files';

/*
 * The lessor's receipt of a mechanization rental (plan `docs/mechanization-lessor-receipt-plan.md`,
 * P1, P5–P8, P12): how the versions are read, how each audience sees them, and how a version stops
 * being current.
 *
 * The table is read and written only under the lock of its request (`lockMechRequest` first), in
 * the order "request → receipt", as the extension row is: the request's version is the one etag of
 * the card, and a door that took the receipt row first could deadlock with a status change that
 * holds the request and retires the receipt.
 *
 * The rules — who may attach, decide or waive, and when — live in
 * `packages/contracts/src/mech-lessor-receipts.ts`; nothing here repeats them.
 */

const receipts = mechRequestLessorReceipts;

/*
 * Who attached, decided and retired a version — three joins on `users`, each under its own alias:
 * unnamed, the joins would overwrite each other's columns and the card would show the author's
 * name as the visa holder's.
 */
const creators = alias(users, 'mech_lessor_receipt_creators');
const deciders = alias(users, 'mech_lessor_receipt_deciders');
const retirers = alias(users, 'mech_lessor_receipt_retirers');

/** A version as the server reads it: everything both audiences are built from. */
export interface MechLessorReceiptRow {
  id: string;
  versionNo: number;
  status: MechLessorReceiptStatus;
  file: AttachedFileDto | null;
  createdBy: string;
  createdByName: string | null;
  createdAs: MechLessorReceiptAuthor;
  createdAt: Date;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionComment: string;
  retiredAt: Date | null;
  retiredByName: string | null;
  retiredReason: MechLessorReceiptRetireReason | null;
}

/** The columns of the version's file; empty for a waiver. */
export interface MechLessorReceiptFileColumns {
  fileId: string | null;
  fileName: string | null;
  fileContentType: string | null;
  fileSize: number | null;
  fileQuarantinedAt: Date | null;
}

/**
 * The file of a version through the portal's one rule for names (`attachedFileView`): a
 * quarantined file's name never leaves the server, in the receipt block as anywhere else.
 */
export function mechLessorReceiptFileOf(c: MechLessorReceiptFileColumns): AttachedFileDto | null {
  if (!c.fileId) return null;
  return attachedFileView({
    id: c.fileId,
    filename: c.fileName,
    quarantinedAt: c.fileQuarantinedAt,
    contentType: c.fileContentType,
    size: c.fileSize ?? 0,
  });
}

/** The versions with their file and the three names, under the aliases above. */
function receiptRowsQuery(reader: MechReader) {
  return reader
    .select({
      requestId: receipts.requestId,
      id: receipts.id,
      versionNo: receipts.versionNo,
      status: receipts.status,
      fileId: receipts.fileId,
      fileName: files.filename,
      fileContentType: files.contentType,
      fileSize: files.size,
      fileQuarantinedAt: files.quarantinedAt,
      createdBy: receipts.createdBy,
      createdByName: creators.fullName,
      createdAs: receipts.createdAs,
      createdAt: receipts.createdAt,
      decidedBy: receipts.decidedBy,
      decidedByName: deciders.fullName,
      decidedAt: receipts.decidedAt,
      decisionComment: receipts.decisionComment,
      retiredAt: receipts.retiredAt,
      retiredByName: retirers.fullName,
      retiredReason: receipts.retiredReason,
    })
    .from(receipts)
    .leftJoin(files, eq(receipts.fileId, files.id))
    .leftJoin(creators, eq(receipts.createdBy, creators.id))
    .leftJoin(deciders, eq(receipts.decidedBy, deciders.id))
    .leftJoin(retirers, eq(receipts.retiredBy, retirers.id));
}

type ReceiptQueryRow = Awaited<ReturnType<typeof receiptRowsQuery>>[number];

function toReceiptRow({
  requestId: _requestId,
  fileId,
  fileName,
  fileContentType,
  fileSize,
  fileQuarantinedAt,
  ...row
}: ReceiptQueryRow): MechLessorReceiptRow {
  return {
    ...row,
    file: mechLessorReceiptFileOf({
      fileId,
      fileName,
      fileContentType,
      fileSize,
      fileQuarantinedAt,
    }),
  };
}

/**
 * Every version of a request, oldest first. Under a write door the caller already holds the
 * request's lock; the card reads it without one.
 */
export async function loadMechLessorReceipts(
  reader: MechReader,
  requestId: string,
): Promise<MechLessorReceiptRow[]> {
  const rows = await receiptRowsQuery(reader)
    .where(eq(receipts.requestId, requestId))
    .orderBy(asc(receipts.versionNo));
  return rows.map(toReceiptRow);
}

/**
 * The versions of a page of rentals in one query, by request, oldest first — the lessor's list
 * builds every row's block from them without a query per row.
 */
export async function loadMechLessorReceiptsByRequestIds(
  reader: MechReader,
  requestIds: readonly string[],
): Promise<Map<string, MechLessorReceiptRow[]>> {
  const map = new Map<string, MechLessorReceiptRow[]>();
  if (requestIds.length === 0) return map;
  const rows = await receiptRowsQuery(reader)
    .where(inArray(receipts.requestId, [...requestIds]))
    .orderBy(asc(receipts.requestId), asc(receipts.versionNo));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push(toReceiptRow(row));
    map.set(row.requestId, list);
  }
  return map;
}

/** The current version among the rows: the one not retired (at most one, by the partial index). */
export function currentMechLessorReceipt<T extends { retiredAt: Date | null }>(
  rows: readonly T[],
): T | null {
  return rows.find((row) => row.retiredAt === null) ?? null;
}

/**
 * The current version alone, for a door that needs only its status: the completion gate, the deal
 * and the return to «Новая». The caller holds the request's lock.
 */
export async function loadCurrentMechLessorReceipt(
  reader: MechReader,
  requestId: string,
): Promise<{ id: string; versionNo: number; status: MechLessorReceiptStatus } | null> {
  const [row] = await reader
    .select({ id: receipts.id, versionNo: receipts.versionNo, status: receipts.status })
    .from(receipts)
    .where(and(eq(receipts.requestId, requestId), isNull(receipts.retiredAt)));
  return row ?? null;
}

/**
 * How many versions the request has, the current one included — what `mechDeleteScope` asks: a
 * «Новая» with versions is archived, not hard-deleted (P8). A plain filter by `request_id`, not a
 * correlated subquery, so it cannot fall into the single-table column rewrite of drizzle.
 */
export async function countMechLessorReceiptVersions(
  reader: MechReader,
  requestId: string,
): Promise<number> {
  const [row] = await reader
    .select({ n: count() })
    .from(receipts)
    .where(eq(receipts.requestId, requestId));
  return Number(row?.n ?? 0);
}

/**
 * The version count of every request as a grouped subquery, joined by `mechBaseQuery` under its own
 * alias (P16). Not a correlated subquery in the select list: in a single-table drizzle select the
 * column references of such a subquery are rewritten to bare names, and `request_id = id` would
 * then compare the receipt table with itself — a count that is silently wrong
 * (`apps/api/test/mech-lessor-receipt.db.test.ts` pins it on a single-table query).
 *
 * Built by the standalone `QueryBuilder`, not `db.select`: it is only SQL to join, and a module that
 * called the client at import would make every importer of the card's DTO depend on the client
 * there — a suite that mocks `db.select` fails on import.
 */
export const mechLessorReceiptVersionCounts = new QueryBuilder()
  .select({
    requestId: receipts.requestId,
    versionCount: sql<number>`count(*)::int`.as('lessor_receipt_version_count'),
  })
  .from(receipts)
  .groupBy(receipts.requestId)
  .as('mech_lessor_receipt_counts');

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** A version as the office sees it: names and every reason. */
export function toMechLessorReceiptVersionDto(
  row: MechLessorReceiptRow,
): MechLessorReceiptVersionDto {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status,
    file: row.file,
    createdBy: row.createdBy,
    // `RESTRICT` on the author keeps the account; the fallback is only the shape of the type.
    createdByName: row.createdByName ?? '—',
    createdAs: row.createdAs,
    createdAt: row.createdAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedByName: row.decidedByName,
    decidedAt: iso(row.decidedAt),
    decisionComment: row.decisionComment,
    retiredAt: iso(row.retiredAt),
    retiredByName: row.retiredByName,
    retiredReason: row.retiredReason,
  };
}

/**
 * A version as the lessor sees it (P12), built field by field from the allow-list of
 * `MechLessorReceiptVersionView`, never by blanking the office DTO: a field added there tomorrow
 * must not reach the lessor by default. The only reason shown is a rejection's — he has something
 * to fix; a waiver's reason and an approval's remark are internal notes of the office.
 */
export function toMechLessorReceiptVersionView(
  row: MechLessorReceiptRow,
): MechLessorReceiptVersionView {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status,
    file: row.file,
    createdAs: row.createdAs,
    createdAt: row.createdAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    rejectionReason: row.status === 'rejected' ? row.decisionComment : null,
    retiredAt: iso(row.retiredAt),
    retiredReason: row.retiredReason,
  };
}

/**
 * Versions this account attached within the current deal — what the lessor's cap of P7 counts.
 * Per account and per deal: a new lessor does not inherit his predecessor's count, and the versions
 * of an earlier deal are not his to count.
 */
function ownVersionsInDeal(p: Principal, rows: readonly MechLessorReceiptRow[]): number {
  return mechLessorVisibleVersions(rows).filter((row) => row.createdBy === p.id).length;
}

function newestFirst<T extends { versionNo: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.versionNo - a.versionNo);
}

/**
 * The lessor's receipt block (P12): only the versions of the current deal — older ones were issued
 * under other terms and may belong to another lessor — as `MechLessorReceiptVersionView`, and his
 * own count within the deal, which is exactly what the cap of P7 compares. One function for the
 * replies of the doors and for his rental DTO, so the two cannot show him different versions.
 */
export function mechLessorReceiptLessorState(
  p: Principal,
  required: boolean,
  rows: readonly MechLessorReceiptRow[],
): MechLessorReceiptLessorStateDto {
  const visible = mechLessorVisibleVersions(rows);
  const current = currentMechLessorReceipt(visible);
  return {
    audience: 'lessor',
    required,
    current: current ? toMechLessorReceiptVersionView(current) : null,
    retired: newestFirst(visible.filter((row) => row.retiredAt !== null)).map(
      toMechLessorReceiptVersionView,
    ),
    ownVersionCount: ownVersionsInDeal(p, rows),
  };
}

/** The lessor's branch of the block, as his rental DTO carries it. */
export type MechLessorReceiptLessorStateDto = Extract<
  MechLessorReceiptStateDto,
  { audience: 'lessor' }
>;

/**
 * The receipt block for the caller's audience — the reply of every receipt door (P5–P7).
 *
 * The office gets every version with names. The lessor gets only the versions of the current deal
 * (`mechLessorVisibleVersions`: older ones were issued under other terms and may belong to another
 * lessor) and his own count within it, which is exactly what the cap of P7 compares — so the portal
 * hides «Заменить чек» exactly when the server would refuse.
 */
export function mechLessorReceiptStateFor(
  p: Principal,
  required: boolean,
  rows: readonly MechLessorReceiptRow[],
): MechLessorReceiptStateDto {
  if (isMechLessorSubject(p)) return mechLessorReceiptLessorState(p, required, rows);
  const current = currentMechLessorReceipt(rows);
  return {
    audience: 'office',
    required,
    current: current ? toMechLessorReceiptVersionDto(current) : null,
    retired: newestFirst(rows.filter((row) => row.retiredAt !== null)).map(
      toMechLessorReceiptVersionDto,
    ),
  };
}

/**
 * Stamps the retire columns of the current version (P1): who, when and why it stopped being
 * current. The status is never touched — "approved, then replaced" stays approved, and a pending
 * version replaced before any decision reads "not decided, replaced".
 *
 * Binds `retired_at IS NULL`: under the request's lock a second retire cannot race this one, so
 * zero rows means the caller passed a version that is not current — a 409, never a silent success.
 */
export async function retireMechLessorReceipt(
  tx: MechTx,
  current: { id: string },
  reason: MechLessorReceiptRetireReason,
  actorUserId: string,
): Promise<void> {
  const [retired] = await tx
    .update(receipts)
    .set({ retiredAt: new Date(), retiredBy: actorUserId, retiredReason: reason })
    .where(and(eq(receipts.id, current.id), isNull(receipts.retiredAt)))
    .returning({ id: receipts.id });
  if (!retired) throw err.conflict();
}

/**
 * The current version stops counting because the deal it was issued under is gone (P8): the deal
 * changed its lessor, unit or rate (`deal_changed`), or the request entered «Новая» and the deal was
 * erased (`rolled_back`). Returns whether a version was retired.
 *
 * Called inside the deal and status doors, under the request's lock and before their CAS; the strict
 * event goes in the same transaction — the card's history must not disagree with the block above it,
 * and after the retire nothing but this event says why an approved receipt stopped counting.
 */
export async function retireMechLessorReceiptForDeal(
  tx: MechTx,
  actorUserId: string,
  requestId: string,
  reason: Extract<MechLessorReceiptRetireReason, 'deal_changed' | 'rolled_back'>,
): Promise<boolean> {
  const current = await loadCurrentMechLessorReceipt(tx, requestId);
  if (!current) return false;
  await retireMechLessorReceipt(tx, current, reason, actorUserId);
  await writeAuditTx(tx, {
    actorUserId,
    action: 'mech_request.lessor_receipt_retire',
    entityType: 'mech_request',
    entityId: requestId,
    metadata: {
      receiptId: current.id,
      versionNo: current.versionNo,
      status: current.status,
      reason,
      changes: mechLessorReceiptRetireChanges(current.versionNo, reason),
    },
  });
  return true;
}

// ── The doors (P5–P7) ──
//
// Every door keeps the module's protocol (`mech-request-guards.ts`): the request's lock first →
// existence, archive and scope → the client's version (409 "reread") BEFORE any rule (422 "the rule
// forbids") → the receipt rows read and written under that lock → CAS on the request with
// `version + 1` → the strict event in the same transaction → the reply for the caller's audience.

/** The next version number, computed under the request's lock; the unique pair is the backstop. */
function nextVersionNo(rows: readonly MechLessorReceiptRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.versionNo), 0) + 1;
}

async function replyFor(
  reader: MechReader,
  p: Principal,
  requestId: string,
  version: number,
  required: boolean,
): Promise<MechLessorReceiptReplyDto> {
  return {
    version,
    lessorReceipt: mechLessorReceiptStateFor(
      p,
      required,
      await loadMechLessorReceipts(reader, requestId),
    ),
  };
}

/**
 * Attach a receipt or replace the current version (P7) — the office's door and the lessor's.
 *
 * The lessor is asked his one predicate before anything else (`isMechLessorRentalVisible`: his
 * counterparty, «В работе», not archived) and gets **404** for a rental that is not his or no
 * longer in work: which request ids exist is not his business. The office goes through the module's
 * scope as everywhere.
 *
 * The order of refusals is the plan's: the state (`mechLessorReceiptAttachBlocker` — not in work,
 * the lessor over an approval or a waiver, his cap), then the file (own, finished, unlinked, not
 * quarantined — `requireActive`, the evidence option of the readings path), then its declared type.
 * The type is the one the browser declared at upload; bytes are not sniffed (P7).
 */
export async function attachMechLessorReceipt(
  tx: MechTx,
  p: Principal,
  id: string,
  input: AttachMechLessorReceiptInput,
): Promise<MechLessorReceiptReplyDto> {
  const actsAsLessor = isMechLessorSubject(p);
  const locked = await lockMechRequest(tx, id);
  if (
    actsAsLessor &&
    !(
      locked &&
      isMechLessorRentalVisible(p, {
        lessorId: locked.lessorId,
        status: locked.status,
        deletedAt: locked.deletedAt ? locked.deletedAt.toISOString() : null,
      })
    )
  ) {
    throw err.notFound('Заявка не найдена');
  }
  const row = assertMechRequestOpenable(p, locked, input.version);
  assertMechRequestLive(row, 'прикрепить чек арендодателя');

  const versions = await loadMechLessorReceipts(tx, id);
  const current = currentMechLessorReceipt(versions);
  const blocker = mechLessorReceiptAttachBlocker({
    row,
    current: current && { status: current.status },
    lessorVersionCount: actsAsLessor ? ownVersionsInDeal(p, versions) : 0,
    actsAsLessor,
  });
  if (blocker) throw err.unprocessable(blocker);

  await assertFilesAttachable(tx, [input.fileId], p.id, { requireActive: true });
  const [file] = await tx
    .select({ filename: files.filename, contentType: files.contentType })
    .from(files)
    .where(eq(files.id, input.fileId));
  if (!file || !isMechLessorReceiptContentType(file.contentType ?? '')) {
    throw err.unprocessable(MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE, {
      fileId: 'Нужен PDF или JPG',
    });
  }

  if (current) await retireMechLessorReceipt(tx, current, 'replaced', p.id);
  const versionNo = nextVersionNo(versions);
  const [inserted] = await tx
    .insert(receipts)
    .values({
      requestId: id,
      versionNo,
      fileId: input.fileId,
      status: 'pending',
      createdBy: p.id,
      createdAs: actsAsLessor ? 'lessor' : 'office',
    })
    .returning({ id: receipts.id });
  // Attaching gates the rental (P3): an old rental that got a receipt is gated like a new one — a
  // receipt that was shown must be decided.
  await bumpRequest(tx, p, row, input.version, { lessorReceiptRequired: true });
  const replaced = current && { versionNo: current.versionNo, status: current.status };
  await writeAuditTx(tx, {
    actorUserId: p.id,
    action: 'mech_request.lessor_receipt_attach',
    entityType: 'mech_request',
    entityId: id,
    metadata: {
      receiptId: inserted!.id,
      versionNo,
      fileId: input.fileId,
      createdAs: actsAsLessor ? 'lessor' : 'office',
      replaced: current ? { receiptId: current.id, ...replaced } : null,
      changes: mechLessorReceiptAttachChanges(
        versionNo,
        { id: input.fileId, filename: file.filename },
        replaced,
      ),
    },
  });
  return replyFor(tx, p, id, row.version + 1, true);
}

export type DecideMechLessorReceiptBody = z.output<typeof decideMechLessorReceiptSchema>;

const DECISION_ACTIONS: Record<MechLessorReceiptDecision, string> = {
  approve: 'mech_request.lessor_receipt_approve',
  reject: 'mech_request.lessor_receipt_reject',
  revoke: 'mech_request.lessor_receipt_revoke',
};

/**
 * Approve, reject or revoke the version the holder saw (P5).
 *
 * **The signature is bound to the version seen.** The current row is read under the lock first
 * only to choose the words of a version 409 — «Чек заменили, пока окно было открыто» when the
 * window's `receiptId` is no longer current; the existence, archive and scope checks still come
 * before it is used. A matching request version with a `receiptId` that is not current (another
 * request's version, say) is the same 409. The write itself then binds
 * `id = receiptId AND request_id = id AND retired_at IS NULL AND status = <expected>`: the
 * `request_id` term keeps a visa holder of one site from signing another site's receipt through his
 * own rental's id and version, and zero rows is the same 409 again.
 *
 * `approve` and `reject` do not ask the request's status — a pending receipt of a rental cancelled
 * after it was attached is still worth deciding (a prepayment); `revoke` is limited to «В работе»
 * (O15). Who attached the version does not matter (O14): the permission and the circle decide.
 */
export async function decideMechLessorReceipt(
  tx: MechTx,
  p: Principal,
  id: string,
  input: DecideMechLessorReceiptBody,
): Promise<MechLessorReceiptReplyDto> {
  const locked = await lockMechRequest(tx, id);
  const current = locked ? await loadCurrentMechLessorReceipt(tx, id) : null;
  const seenIsCurrent = current?.id === input.receiptId;
  const row = assertMechRequestOpenable(
    p,
    locked,
    input.version,
    seenIsCurrent ? undefined : MECH_LESSOR_RECEIPT_STALE_MESSAGE,
  );
  if (!seenIsCurrent) throw err.conflict(MECH_LESSOR_RECEIPT_STALE_MESSAGE);
  assertMechRequestLive(row, 'решить чек арендодателя');
  if (!canApproveMechRequest(p, row)) throw err.forbidden(MECH_LESSOR_RECEIPT_SCOPE_MESSAGE);
  const seen = current!;
  const blocker = mechLessorReceiptDecisionBlocker(row, { status: seen.status }, input.decision);
  if (blocker) throw err.unprocessable(blocker);

  const now = new Date();
  // A revoked approval goes back to `pending` with its decision cleared; a revoked waiver is
  // retired instead (P5) — a waiver without its decision would be a row without a meaning.
  const write =
    input.decision === 'approve'
      ? {
          status: 'approved' as const,
          decidedBy: p.id,
          decidedAt: now,
          decisionComment: input.comment,
        }
      : input.decision === 'reject'
        ? {
            status: 'rejected' as const,
            decidedBy: p.id,
            decidedAt: now,
            decisionComment: input.comment,
          }
        : seen.status === 'waived'
          ? { retiredAt: now, retiredBy: p.id, retiredReason: 'revoked' as const }
          : { status: 'pending' as const, decidedBy: null, decidedAt: null, decisionComment: '' };
  const expected: MechLessorReceiptStatus = input.decision === 'revoke' ? seen.status : 'pending';
  const [written] = await tx
    .update(receipts)
    .set(write)
    .where(
      and(
        eq(receipts.id, input.receiptId),
        eq(receipts.requestId, id),
        isNull(receipts.retiredAt),
        eq(receipts.status, expected),
      ),
    )
    .returning({ versionNo: receipts.versionNo });
  if (!written) throw err.conflict(MECH_LESSOR_RECEIPT_STALE_MESSAGE);

  await bumpRequest(tx, p, row, input.version);
  await writeAuditTx(tx, {
    actorUserId: p.id,
    action: DECISION_ACTIONS[input.decision],
    entityType: 'mech_request',
    entityId: id,
    metadata: {
      receiptId: input.receiptId,
      versionNo: written.versionNo,
      ...(input.decision === 'revoke' ? { revoked: seen.status } : {}),
      changes: mechLessorReceiptDecisionChanges(
        input.decision,
        written.versionNo,
        input.comment,
        seen.status,
      ),
    },
  });
  return replyFor(tx, p, id, row.version + 1, row.lessorReceiptRequired);
}

/**
 * The «без чека» visa (P6, O10): a current row without a file, born decided by the visa holder with
 * his reason, retiring the previous current version as `replaced`. Allowed while the rental is in
 * work and the current version is absent, pending or rejected (`mechLessorReceiptWaiverBlocker`).
 * Over a pending file it replaces the file: the holder saw it and decided the rental closes without
 * it.
 */
export async function waiveMechLessorReceipt(
  tx: MechTx,
  p: Principal,
  id: string,
  input: WaiveMechLessorReceiptInput,
): Promise<MechLessorReceiptReplyDto> {
  const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), input.version);
  assertMechRequestLive(row, 'разрешить завершение без чека');
  if (!canApproveMechRequest(p, row)) throw err.forbidden(MECH_LESSOR_RECEIPT_SCOPE_MESSAGE);
  const versions = await loadMechLessorReceipts(tx, id);
  const current = currentMechLessorReceipt(versions);
  const blocker = mechLessorReceiptWaiverBlocker(row, current && { status: current.status });
  if (blocker) throw err.unprocessable(blocker);

  if (current) await retireMechLessorReceipt(tx, current, 'replaced', p.id);
  const now = new Date();
  const versionNo = nextVersionNo(versions);
  const [inserted] = await tx
    .insert(receipts)
    .values({
      requestId: id,
      versionNo,
      fileId: null,
      status: 'waived',
      createdBy: p.id,
      createdAs: 'office',
      createdAt: now,
      decidedBy: p.id,
      decidedAt: now,
      decisionComment: input.comment,
    })
    .returning({ id: receipts.id });
  await bumpRequest(tx, p, row, input.version);
  const replaced = current && { versionNo: current.versionNo, status: current.status };
  await writeAuditTx(tx, {
    actorUserId: p.id,
    action: 'mech_request.lessor_receipt_waive',
    entityType: 'mech_request',
    entityId: id,
    metadata: {
      receiptId: inserted!.id,
      versionNo,
      replaced: current ? { receiptId: current.id, ...replaced } : null,
      changes: mechLessorReceiptWaiveChanges(versionNo, input.comment, replaced),
    },
  });
  return replyFor(tx, p, id, row.version + 1, row.lessorReceiptRequired);
}
