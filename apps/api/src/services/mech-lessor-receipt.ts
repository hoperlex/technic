import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type AttachedFileDto,
  isMechLessorSubject,
  type MechLessorReceiptAuthor,
  type MechLessorReceiptRetireReason,
  type MechLessorReceiptStateDto,
  type MechLessorReceiptStatus,
  type MechLessorReceiptVersionDto,
  type MechLessorReceiptVersionView,
  mechLessorVisibleVersions,
} from '@technic/contracts';
import { db } from '../db/client';
import { files, mechRequestLessorReceipts, users } from '../db/schema';
import { err } from '../lib/errors';
import type { Principal } from '../auth/principal';
import { attachedFileView } from './file-view';
import type { MechReader, MechTx } from './mech-request-dto';

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

/**
 * Every version of a request, oldest first. Under a write door the caller already holds the
 * request's lock; the card reads it without one.
 */
export async function loadMechLessorReceipts(
  reader: MechReader,
  requestId: string,
): Promise<MechLessorReceiptRow[]> {
  const rows = await reader
    .select({
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
    .leftJoin(retirers, eq(receipts.retiredBy, retirers.id))
    .where(eq(receipts.requestId, requestId))
    .orderBy(asc(receipts.versionNo));
  return rows.map(({ fileId, fileName, fileContentType, fileSize, fileQuarantinedAt, ...row }) => ({
    ...row,
    file: mechLessorReceiptFileOf({
      fileId,
      fileName,
      fileContentType,
      fileSize,
      fileQuarantinedAt,
    }),
  }));
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
 */
export const mechLessorReceiptVersionCounts = db
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

function newestFirst<T extends { versionNo: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.versionNo - a.versionNo);
}

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
  if (isMechLessorSubject(p)) {
    const visible = mechLessorVisibleVersions(rows);
    const current = currentMechLessorReceipt(visible);
    return {
      audience: 'lessor',
      required,
      current: current ? toMechLessorReceiptVersionView(current) : null,
      retired: newestFirst(visible.filter((row) => row.retiredAt !== null)).map(
        toMechLessorReceiptVersionView,
      ),
      ownVersionCount: visible.filter((row) => row.createdBy === p.id).length,
    };
  }
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
