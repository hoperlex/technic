import { sql } from 'drizzle-orm';
import type * as S3Module from '../src/lib/s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FileDto, WasteRequestDto } from '@technic/contracts';
import {
  type Auth,
  buildScene,
  card,
  current,
  inject,
  insertRequest,
  linkTicket,
  newFile,
  REQUESTS,
  type Scene,
  scalar,
} from './snow-removal-harness';

/**
 * Closing a snow removal request (snow-removal plan, §1, §2, §3.2, §4 «Close and review»): the
 * manual cost and removal day on first completion and on re-close, the 409 for a second completion
 * against «Выполнена», the version check under the request lock, and the storage verification
 * that both ticket doors require.
 *
 * The object storage is a map: `headObject` answers from it, so «the completion route saw the
 * object» is exactly «the key is in the map when the route asked».
 */

const storage = vi.hoisted(() => new Map<string, number>());
vi.mock('../src/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Module>()),
  headObject: async (key: string) =>
    storage.has(key) ? { size: storage.get(key)!, contentType: 'application/pdf' } : null,
  deleteObject: async () => {},
}));

const RUN_DB = !!process.env.TEST_DATABASE_URL;
let s: Scene;

beforeAll(async () => {
  const built = await buildScene('close');
  if (built) s = built;
}, 300_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

function setStatus(id: string, auth: Auth, body: Record<string, unknown>) {
  return inject('PATCH', `${REQUESTS}/${id}/status`, auth, body);
}

async function completionRow(id: string) {
  const res = await current().db.execute<{
    total_cost: string | null;
    price_per_m3: string | null;
    waste_tariff_id: string | null;
    removed_on: string | null;
    volume_m3: string | null;
  }>(sql`SELECT total_cost, price_per_m3, waste_tariff_id, removed_on::text, volume_m3
           FROM waste_request_completions WHERE request_id = ${id}`);
  return res.rows[0];
}

/** A snow request in «В работе» plus a verified ticket upload of the dispatcher. */
async function confirmedSnow(): Promise<{ id: string; version: number; ticket: string }> {
  const id = await insertRequest({ status: 'confirmed' });
  const ticket = await newFile(s.users.dispatcher);
  const dto = await card(id, s.users.dispatcher.auth);
  return { id, version: dto.version, ticket: ticket.id };
}

async function close(
  id: string,
  version: number,
  completion: Record<string, unknown>,
  ticketFileIds: string[] = [],
) {
  return setStatus(id, s.users.dispatcher.auth, {
    status: 'done',
    completion,
    ticketFileIds,
    version,
  });
}

/** done → confirmed by rollback: the saved completion and tickets stay for the re-close. */
async function reopen(id: string): Promise<number> {
  const dto = await card(id, s.users.dispatcher.auth);
  const res = await setStatus(id, s.users.dispatcher.auth, {
    status: 'confirmed',
    version: dto.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as WasteRequestDto).version;
}

describe.skipIf(!RUN_DB)('snow completion: manual cost and removal day', () => {
  it('first completion without a cost stores NULL, never a computed sum', async () => {
    const { id, version, ticket } = await confirmedSnow();
    const res = await close(id, version, { volumeM3: 12 }, [ticket]);
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as WasteRequestDto;
    expect(dto.status).toBe('done');
    expect(dto.completion).toMatchObject({
      unit: 'volume_m3',
      volumeM3: 12,
      pricePerM3: null,
      totalCost: null,
      removedOn: null,
    });
    expect(await completionRow(id)).toMatchObject({
      total_cost: null,
      price_per_m3: null,
      waste_tariff_id: null,
    });
  });

  it.each([
    ['explicit null', null, null],
    ['nonzero', 15400.5, 15400.5],
    ['zero is a known amount', 0, 0],
    ['numeric string', '1200.10', 1200.1],
  ])('first completion with %s', async (_label, sent, expected) => {
    const { id, version, ticket } = await confirmedSnow();
    const res = await close(
      id,
      version,
      { volumeM3: 9, totalCost: sent, removedOn: '2026-11-20' },
      [ticket],
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as WasteRequestDto;
    expect(dto.completion?.totalCost).toBe(expected);
    expect(dto.completion?.removedOn).toBe('2026-11-20');
    expect(dto.completion?.pricePerM3).toBeNull();
  });

  it.each([
    ['blank string', ''],
    ['boolean', true],
    ['array', []],
    ['underflow to a false zero', '1e-400'],
    ['three decimals', '1.234'],
  ])('malformed cost (%s) is refused before anything is written', async (_label, sent) => {
    const { id, version, ticket } = await confirmedSnow();
    const res = await close(id, version, { volumeM3: 9, totalCost: sent }, [ticket]);
    expect(res.statusCode, res.body).toBe(400);
    expect(await completionRow(id)).toBeUndefined();
    const dto = await card(id, s.users.dispatcher.auth);
    expect(dto.status).toBe('confirmed');
    expect(dto.tickets).toHaveLength(0);
  });

  it('re-close keeps the saved cost and day when omitted, clears them on explicit null', async () => {
    const { id, version, ticket } = await confirmedSnow();
    let res = await close(id, version, { volumeM3: 10, totalCost: 0, removedOn: '2026-10-31' }, [
      ticket,
    ]);
    expect(res.statusCode, res.body).toBe(200);

    // Omitted cost and day: the late correction changes only the volume.
    let v = await reopen(id);
    res = await close(id, v, { volumeM3: 11 });
    expect(res.statusCode, res.body).toBe(200);
    let dto = res.json() as WasteRequestDto;
    expect(dto.completion).toMatchObject({ volumeM3: 11, totalCost: 0, removedOn: '2026-10-31' });
    // The original tickets stay: the re-close needed no new paper.
    expect(dto.tickets.map((t: FileDto) => t.id)).toEqual([ticket]);

    // A late invoice: only the amount changes, the removal day (and month) stays.
    v = await reopen(id);
    res = await close(id, v, { volumeM3: 11, totalCost: 21000 });
    dto = res.json() as WasteRequestDto;
    expect(dto.completion).toMatchObject({ totalCost: 21000, removedOn: '2026-10-31' });

    // Explicit nulls clear.
    v = await reopen(id);
    res = await close(id, v, { volumeM3: 11, totalCost: null, removedOn: null });
    expect(res.statusCode, res.body).toBe(200);
    dto = res.json() as WasteRequestDto;
    expect(dto.completion).toMatchObject({ totalCost: null, removedOn: null });
    expect(await completionRow(id)).toMatchObject({ total_cost: null, removed_on: null });
  });

  it('a transition that reuses the previous completion preserves it in full', async () => {
    const { id, version, ticket } = await confirmedSnow();
    await close(id, version, { volumeM3: 14, totalCost: 700, removedOn: '2026-11-01' }, [ticket]);
    const v = await reopen(id);
    const res = await setStatus(id, s.users.dispatcher.auth, { status: 'done', version: v });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as WasteRequestDto).completion).toMatchObject({
      volumeM3: 14,
      totalCost: 700,
      removedOn: '2026-11-01',
    });
  });

  it('a second completion with fact or tickets against «Выполнена» is 409, not a silent no-op', async () => {
    const { id, version, ticket } = await confirmedSnow();
    const first = await close(id, version, { volumeM3: 10, totalCost: 500 }, [ticket]);
    const after = first.json() as WasteRequestDto;
    const extra = await newFile(s.users.dispatcher);

    const withFact = await close(id, after.version, { volumeM3: 99, totalCost: 1 });
    expect(withFact.statusCode, withFact.body).toBe(409);
    const withTicket = await setStatus(id, s.users.dispatcher.auth, {
      status: 'done',
      ticketFileIds: [extra.id],
      version: after.version,
    });
    expect(withTicket.statusCode, withTicket.body).toBe(409);
    const dto = await card(id, s.users.dispatcher.auth);
    expect(dto.completion).toMatchObject({ volumeM3: 10, totalCost: 500 });
    expect(dto.tickets.map((t) => t.id)).toEqual([ticket]);
    // The same status without data stays the idempotent answer.
    const bare = await setStatus(id, s.users.dispatcher.auth, {
      status: 'done',
      version: after.version,
    });
    expect(bare.statusCode, bare.body).toBe(200);
  });

  it('a stale version loses under the lock before the fact or files are written', async () => {
    const { id, version, ticket } = await confirmedSnow();
    // Someone else edits the request first.
    await current().db.execute(
      sql`UPDATE waste_requests SET version = version + 1 WHERE id = ${id}`,
    );
    const res = await close(id, version, { volumeM3: 10, totalCost: 100 }, [ticket]);
    expect(res.statusCode, res.body).toBe(409);
    expect(await completionRow(id)).toBeUndefined();
    const linked = await scalar<number>(
      sql`SELECT count(*)::int AS v FROM request_files WHERE file_id = ${ticket}`,
    );
    expect(linked).toBe(0);
  });

  it('weight is refused for snow: snow closes in cubic metres only', async () => {
    const { id, version, ticket } = await confirmedSnow();
    const res = await close(id, version, { weightTons: 3 }, [ticket]);
    expect(res.statusCode, res.body).toBe(400);
  });
});

describe.skipIf(!RUN_DB)('tickets require storage verification on both doors', () => {
  it('closing refuses an active ticket the completion route never verified', async () => {
    const { id, version } = await confirmedSnow();
    const promoted = await newFile(s.users.dispatcher, { status: 'active', verified: false });
    const pending = await newFile(s.users.dispatcher, { status: 'pending', verified: false });
    for (const f of [promoted, pending]) {
      const res = await close(id, version, { volumeM3: 10 }, [f.id]);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields?.ticketFileIds).toBeTruthy();
    }
    expect(await completionRow(id)).toBeUndefined();
  });

  it('late attachment refuses an unverified ticket and accepts a verified one', async () => {
    const id = await insertRequest({ status: 'done' });
    await linkTicket(id, s.users.dispatcher);
    const dto = await card(id, s.users.dispatcher.auth);
    const unverified = await newFile(s.users.dispatcher, { status: 'active', verified: false });
    const refused = await inject(
      'POST',
      `${REQUESTS}/${id}/ticket-files`,
      s.users.dispatcher.auth,
      {
        ticketFileIds: [unverified.id],
        version: dto.version,
      },
    );
    expect(refused.statusCode, refused.body).toBe(400);
    const verified = await newFile(s.users.dispatcher);
    const accepted = await inject(
      'POST',
      `${REQUESTS}/${id}/ticket-files`,
      s.users.dispatcher.auth,
      {
        ticketFileIds: [verified.id],
        version: dto.version,
      },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as WasteRequestDto).tickets.map((t) => t.id)).toContain(verified.id);
  });

  it('late attachment with a stale version links nothing', async () => {
    const id = await insertRequest({ status: 'done' });
    await linkTicket(id, s.users.dispatcher);
    const dto = await card(id, s.users.dispatcher.auth);
    const file = await newFile(s.users.dispatcher);
    const res = await inject('POST', `${REQUESTS}/${id}/ticket-files`, s.users.dispatcher.auth, {
      ticketFileIds: [file.id],
      version: dto.version + 5,
    });
    expect(res.statusCode, res.body).toBe(409);
    const linked = await scalar<number>(
      sql`SELECT count(*)::int AS v FROM request_files WHERE file_id = ${file.id}`,
    );
    expect(linked).toBe(0);
  });

  it('the completion route verifies a pending upload and marks it', async () => {
    const file = await newFile(s.users.dispatcher, { status: 'pending', verified: false });
    storage.set(file.objectKey, 2048);
    const res = await inject('POST', `/api/v1/files/${file.id}/complete`, s.users.dispatcher.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      await scalar<boolean>(
        sql`SELECT storage_verified_at IS NOT NULL AS v FROM files WHERE id = ${file.id}`,
      ),
    ).toBe(true);
    // Now it closes a request.
    const { id, version } = await confirmedSnow();
    const closed = await close(id, version, { volumeM3: 10 }, [file.id]);
    expect(closed.statusCode, closed.body).toBe(200);
  });

  it('an active row without the mark goes through the storage check instead of returning early', async () => {
    const file = await newFile(s.users.dispatcher, { status: 'active', verified: false });
    // The object is missing: the route must ask the storage and refuse, not echo the row.
    const missing = await inject(
      'POST',
      `/api/v1/files/${file.id}/complete`,
      s.users.dispatcher.auth,
    );
    expect(missing.statusCode, missing.body).toBe(400);
    expect(
      await scalar<boolean>(
        sql`SELECT storage_verified_at IS NULL AS v FROM files WHERE id = ${file.id}`,
      ),
    ).toBe(true);
    storage.set(file.objectKey, 1024);
    const found = await inject(
      'POST',
      `/api/v1/files/${file.id}/complete`,
      s.users.dispatcher.auth,
    );
    expect(found.statusCode, found.body).toBe(200);
    expect(
      await scalar<boolean>(
        sql`SELECT storage_verified_at IS NOT NULL AS v FROM files WHERE id = ${file.id}`,
      ),
    ).toBe(true);
    // A verified active row returns early: the storage is not asked again.
    storage.delete(file.objectKey);
    const again = await inject(
      'POST',
      `/api/v1/files/${file.id}/complete`,
      s.users.dispatcher.auth,
    );
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a generic attachment promotes a file to active without the storage mark', async () => {
    const id = await insertRequest({ status: 'new' });
    const dto = await card(id, s.users.dispatcher.auth);
    const file = await newFile(s.users.dispatcher, { status: 'pending', verified: false });
    const res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      addFileIds: [file.id],
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await current().db.execute<{ status: string; verified: boolean }>(
      sql`SELECT status, storage_verified_at IS NOT NULL AS verified FROM files WHERE id = ${file.id}`,
    );
    expect(row.rows[0]).toEqual({ status: 'active', verified: false });
  });
});
