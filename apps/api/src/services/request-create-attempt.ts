import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { requestCreateAttempts } from '../db/schema';
import { err } from '../lib/errors';

export type CreateTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RequestCreateKind = 'vehicle' | 'waste' | 'mech' | 'service';

const KEY_ERROR = 'Некорректный ключ повтора создания заявки';
const REUSE_ERROR = 'Ключ создания заявки уже использован с другим составом или учёткой';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  // Zod turns Waste Removal deliveryAt into a Date; enumerating it would erase the date from the key.
  if (value instanceof Date) return value.toJSON();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function createAttemptFingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
}

export function createAttemptKey(raw: unknown): string | null {
  if (raw === undefined) return null;
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) throw err.unprocessable(KEY_ERROR, { 'Idempotency-Key': KEY_ERROR });
  return parsed.data;
}

/** A receipt key is bound to the actor and the request kind that first used it. */
function assertSameOwner(
  row: { kind: string; actorUserId: string },
  kind: RequestCreateKind,
  actorUserId: string,
): void {
  if (row.kind !== kind || row.actorUserId !== actorUserId)
    throw err.conflict(REUSE_ERROR, { code: 'request_create_key_conflict' });
}

function assertSameAttempt(
  row: { kind: string; actorUserId: string; fingerprint: string },
  kind: RequestCreateKind,
  actorUserId: string,
  fingerprint: string,
): void {
  assertSameOwner(row, kind, actorUserId);
  if (row.fingerprint !== fingerprint)
    throw err.conflict(REUSE_ERROR, { code: 'request_create_key_conflict' });
}

/** The response is frozen before HTTP success; a retry can finish a committed but unfinished row. */
async function finishReceipt<Response, Metadata>(
  key: string,
  load: (id: string, metadata: Metadata | null) => Promise<Response | null>,
): Promise<Response> {
  const [row] = await db
    .select()
    .from(requestCreateAttempts)
    .where(eq(requestCreateAttempts.key, key));
  if (!row?.requestId) throw err.conflict('Создание заявки с этим ключом не завершено');
  if (row.response !== null) return row.response as Response;
  // A conditional update freezes one answer without holding a lock across a separate pool read.
  const response = await load(row.requestId, (row.metadata ?? null) as Metadata | null);
  if (response === null) throw err.conflict('Заявка по ключу была удалена до получения ответа');
  const [won] = await db
    .update(requestCreateAttempts)
    .set({ response })
    .where(and(eq(requestCreateAttempts.key, key), isNull(requestCreateAttempts.response)))
    .returning({ response: requestCreateAttempts.response });
  if (won) return won.response as Response;
  const [saved] = await db
    .select({ response: requestCreateAttempts.response })
    .from(requestCreateAttempts)
    .where(eq(requestCreateAttempts.key, key));
  if (!saved || saved.response === null) throw err.conflict('Ответ по ключу не зафиксирован');
  return saved.response as Response;
}

/** Replay precedes mutable domain checks; each route decides its current access and response projection. */
export async function replayRequestCreate<Response, Metadata = never>(
  key: string,
  kind: RequestCreateKind,
  actorUserId: string,
  fingerprint: string,
  load: (id: string, metadata: Metadata | null) => Promise<Response | null>,
): Promise<Response | null> {
  const [row] = await db
    .select()
    .from(requestCreateAttempts)
    .where(eq(requestCreateAttempts.key, key));
  if (!row) return null;
  assertSameAttempt(row, kind, actorUserId, fingerprint);
  return finishReceipt(key, load);
}

export type CreateReconciliation =
  { state: 'created'; requestId: string } | { state: 'not-created'; nextOperationId: string };

/**
 * Fingerprint of a tombstone written without a validated body. It is a constant on purpose: the
 * body of such an attempt failed the create schema, so hashing it would canonicalize unvalidated
 * input. No create can ever carry it (real fingerprints are SHA-256 hex), so the tombstone still
 * refuses a late create with 409.
 */
export const KEY_MODE_FINGERPRINT = 'key-mode-v1';

/**
 * How reconciliation recognizes the attempt behind a key.
 *
 * - `fingerprint`: the original body passed the create schema, so the receipt must also carry its
 *   fingerprint; a different body under the same key is a reuse and is refused.
 * - `key`: the original body no longer passes the schema (a create route that refused it with a
 *   400 never reserved the key, but an older API with a looser schema may have accepted it). A body
 *   cannot be fingerprinted then, so the key, request kind and actor alone identify the attempt.
 *   This is exact rather than lenient: a receipt row is committed together with its request, or as
 *   a tombstone, and nothing else, so the row answers whatever the body was.
 */
export type CreateReconcileMatch = { mode: 'fingerprint'; fingerprint: string } | { mode: 'key' };

/**
 * A committed null request ID is a tombstone. The create path never commits its reservation before
 * filling the ID, so competing INSERTs serialize every in-flight create against this barrier.
 * The replacement key is stored once: two restored tabs cannot mint two new create identities.
 *
 * A tombstone written in one mode is read in the other without a conflict: the user-visible
 * outcome of a key is one replacement key, whichever way the second tab reached the server.
 */
export async function reconcileRequestCreate(
  args: {
    key: string;
    kind: RequestCreateKind;
    actorUserId: string;
  } & CreateReconcileMatch,
): Promise<CreateReconciliation> {
  return db.transaction(async (tx) => {
    const nextOperationId = randomUUID();
    const [claimed] = await tx
      .insert(requestCreateAttempts)
      .values({
        key: args.key,
        kind: args.kind,
        actorUserId: args.actorUserId,
        fingerprint: args.mode === 'key' ? KEY_MODE_FINGERPRINT : args.fingerprint,
        nextKey: nextOperationId,
      })
      .onConflictDoNothing({ target: requestCreateAttempts.key })
      .returning({ key: requestCreateAttempts.key });
    if (claimed) return { state: 'not-created', nextOperationId };
    const [prior] = await tx
      .select()
      .from(requestCreateAttempts)
      .where(eq(requestCreateAttempts.key, args.key));
    if (!prior) throw err.conflict('Ключ занят незавершённой операцией');
    if (args.mode === 'key' || prior.fingerprint === KEY_MODE_FINGERPRINT)
      assertSameOwner(prior, args.kind, args.actorUserId);
    else assertSameAttempt(prior, args.kind, args.actorUserId, args.fingerprint);
    if (prior.requestId) return { state: 'created', requestId: prior.requestId };
    if (prior.nextKey) return { state: 'not-created', nextOperationId: prior.nextKey };
    throw err.conflict('Исход попытки создания пока не установлен');
  });
}

/** What reconciliation learned from the original body of an attempt. */
export type OriginalAttempt<Body> =
  { parsed: true; body: Body } | { parsed: false; issuePaths: string[] };

/**
 * The reconcile routes validate against the schema of their paired create route, but a failure must
 * not refuse the reconciliation: a body that create refused with a 400 would otherwise lock its
 * form forever, because the frozen attempt could never be released. Only the paths of the failing
 * issues are kept, for the log; messages and values may carry user input.
 */
export function parseOriginalAttempt<Body>(
  schema: z.ZodType<Body>,
  rawBody: Record<string, unknown>,
): OriginalAttempt<Body> {
  const parsed = schema.safeParse(rawBody);
  if (parsed.success) return { parsed: true, body: parsed.data };
  const paths = new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'));
  return { parsed: false, issuePaths: [...paths].slice(0, 20) };
}

/** Reservation, request and response metadata commit as one transaction. */
export async function createRequestOnce<Response, Metadata = null>(args: {
  key: string;
  kind: RequestCreateKind;
  actorUserId: string;
  fingerprint: string;
  create: (tx: CreateTx) => Promise<{ id: string; metadata: Metadata }>;
  load: (id: string, metadata: Metadata | null) => Promise<Response | null>;
}): Promise<{ id: string; response: Response; repeated: boolean; metadata: Metadata | null }> {
  const result = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(requestCreateAttempts)
      .values({
        key: args.key,
        kind: args.kind,
        actorUserId: args.actorUserId,
        fingerprint: args.fingerprint,
      })
      .onConflictDoNothing({ target: requestCreateAttempts.key })
      .returning({ key: requestCreateAttempts.key });
    if (!claimed) {
      const [prior] = await tx
        .select()
        .from(requestCreateAttempts)
        .where(eq(requestCreateAttempts.key, args.key));
      if (!prior) throw err.conflict('Ключ создания заявки занят незавершённой операцией');
      assertSameAttempt(prior, args.kind, args.actorUserId, args.fingerprint);
      if (!prior.requestId) throw err.conflict('Создание заявки с этим ключом не завершено');
      return { id: prior.requestId, repeated: true, metadata: prior.metadata as Metadata | null };
    }
    const created = await args.create(tx);
    await tx
      .update(requestCreateAttempts)
      .set({ requestId: created.id, metadata: created.metadata })
      .where(eq(requestCreateAttempts.key, args.key));
    return { id: created.id, repeated: false, metadata: created.metadata };
  });
  return { ...result, response: await finishReceipt(args.key, args.load) };
}
