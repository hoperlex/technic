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

function assertSameAttempt(
  row: { kind: string; actorUserId: string; fingerprint: string },
  kind: RequestCreateKind,
  actorUserId: string,
  fingerprint: string,
): void {
  if (row.kind !== kind || row.actorUserId !== actorUserId || row.fingerprint !== fingerprint)
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

/** Replay precedes mutable date and directory checks, but follows actor and scope guards. */
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
 * A committed null request ID is a tombstone. The create path never commits its reservation before
 * filling the ID, so competing INSERTs serialize every in-flight create against this barrier.
 * The replacement key is stored once: two restored tabs cannot mint two new create identities.
 */
export async function reconcileRequestCreate(args: {
  key: string;
  kind: RequestCreateKind;
  actorUserId: string;
  fingerprint: string;
}): Promise<CreateReconciliation> {
  return db.transaction(async (tx) => {
    const nextOperationId = randomUUID();
    const [claimed] = await tx
      .insert(requestCreateAttempts)
      .values({
        key: args.key,
        kind: args.kind,
        actorUserId: args.actorUserId,
        fingerprint: args.fingerprint,
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
    assertSameAttempt(prior, args.kind, args.actorUserId, args.fingerprint);
    if (prior.requestId) return { state: 'created', requestId: prior.requestId };
    if (prior.nextKey) return { state: 'not-created', nextOperationId: prior.nextKey };
    throw err.conflict('Исход попытки создания пока не установлен');
  });
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
