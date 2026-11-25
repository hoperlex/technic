import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WasteRequestDto } from '@technic/contracts';
import {
  addUser,
  buildScene,
  card,
  current,
  inject,
  insertRequest,
  newFile,
  REQUESTS,
  type Scene,
  scalar,
} from './snow-removal-harness';

/**
 * Delete, archive, restore and purge of a waste request (snow-removal plan, §3.2; §4 «Close and
 * review»: «Race archive and purge against restore, scope change and work start. Confirm a stale
 * archive after rollback to «Новая» and verify the request and files survive»).
 *
 * Races are made deterministic with a test transaction that holds the request row lock: the route
 * queues behind it, the test changes the row and commits, and the route must decide from the row
 * it locked — not from what it would have read before waiting.
 */

const RUN_DB = !!process.env.TEST_DATABASE_URL;
let s: Scene;
let dbUrl = '';

beforeAll(async () => {
  const built = await buildScene('lifecycle');
  if (!built) return;
  s = built;
  dbUrl = process.env.DATABASE_URL!;
}, 300_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

async function attach(id: string): Promise<string> {
  const file = await newFile(s.users.dispatcher);
  await current().db.execute(sql`
    INSERT INTO request_files (request_id, file_id, kind) VALUES (${id}, ${file.id}, 'attachment')`);
  return file.id;
}

async function exists(id: string): Promise<boolean> {
  return (
    (await scalar<number>(sql`SELECT count(*)::int AS v FROM waste_requests WHERE id = ${id}`)) ===
    1
  );
}

async function fileAlive(fileId: string): Promise<boolean> {
  return (
    (await scalar<string>(sql`SELECT status::text AS v FROM files WHERE id = ${fileId}`)) ===
    'active'
  );
}

/** Run `request` while a test transaction holds the row lock and applies `change` first. */
async function underLock<T>(id: string, change: string, request: () => Promise<T>): Promise<T> {
  const holder = new pg.Client({ connectionString: dbUrl });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM waste_requests WHERE id = $1 FOR UPDATE', [id]);
    const pending = request();
    for (let i = 0; i < 100; i++) {
      const waiting = await scalar<number>(sql`
        SELECT count(*)::int AS v FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%waste_requests%'`);
      if ((waiting ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await holder.query(change, [id]);
    await holder.query('COMMIT');
    return await pending;
  } finally {
    await holder.end();
  }
}

const del = (id: string, query: string, who = () => s.users.dispatcher) =>
  inject('DELETE', `${REQUESTS}/${id}${query ? `?${query}` : ''}`, who().auth);

describe.skipIf(!RUN_DB)('delete with a confirmed version and mode', () => {
  it('a snow delete without the confirmation is refused', async () => {
    const id = await insertRequest({ status: 'new' });
    const res = await del(id, '');
    expect(res.statusCode, res.body).toBe(400);
    expect(await exists(id)).toBe(true);
  });

  it('a stale version is 409 and nothing changes', async () => {
    const id = await insertRequest({ status: 'confirmed' });
    const file = await attach(id);
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await del(id, `version=${dto.version + 1}&mode=soft`);
    expect(res.statusCode, res.body).toBe(409);
    const after = await card(id, s.users.dispatcher.auth);
    expect(after.deletedAt).toBeNull();
    expect(after.version).toBe(dto.version);
    expect(await fileAlive(file)).toBe(true);
  });

  it('a stale mode is 409: an archive confirmation never becomes a hard delete', async () => {
    const id = await insertRequest({ status: 'confirmed' });
    const file = await attach(id);
    let dto = await card(id, s.users.dispatcher.auth);
    // The person confirmed «to the archive» on the confirmed card; then the request is rolled back.
    const confirmedVersion = dto.version;
    const back = await inject('PATCH', `${REQUESTS}/${id}/status`, s.users.dispatcher.auth, {
      status: 'new',
      comment: 'откат перед удалением',
      version: dto.version,
    });
    expect(back.statusCode, back.body).toBe(200);
    dto = back.json() as WasteRequestDto;
    for (const query of [
      `version=${confirmedVersion}&mode=soft`,
      `version=${dto.version}&mode=soft`,
    ]) {
      const res = await del(id, query);
      expect(res.statusCode, res.body).toBe(409);
    }
    expect(await exists(id)).toBe(true);
    expect(await fileAlive(file)).toBe(true);
  });

  it('a rollback to «Новая» committed while the delete waits for the lock is still caught', async () => {
    const id = await insertRequest({ status: 'confirmed' });
    const file = await attach(id);
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await underLock(id, `UPDATE waste_requests SET status = 'new' WHERE id = $1`, () =>
      del(id, `version=${dto.version}&mode=soft`),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(await exists(id)).toBe(true);
    expect(await fileAlive(file)).toBe(true);
  });

  it('a confirmed archive advances the version; a confirmed hard delete removes the request', async () => {
    const live = await insertRequest({ status: 'confirmed' });
    const dto = await card(live, s.users.dispatcher.auth);
    const archived = await del(live, `version=${dto.version}&mode=soft`);
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toEqual({ ok: true, mode: 'soft' });
    expect(
      await scalar<number>(sql`SELECT version AS v FROM waste_requests WHERE id = ${live}`),
    ).toBe(dto.version + 1);

    const fresh = await insertRequest({ status: 'new' });
    const freshDto = await card(fresh, s.users.dispatcher.auth);
    const gone = await del(fresh, `version=${freshDto.version}&mode=hard`);
    expect(gone.statusCode, gone.body).toBe(200);
    expect(await exists(fresh)).toBe(false);
  });

  it('older types delete without the confirmation, and a sent one is still checked', async () => {
    const id = await insertRequest({ type: 'metal_removal', status: 'new' });
    const stale = await del(id, 'mode=soft');
    expect(stale.statusCode, stale.body).toBe(409);
    const res = await del(id, '');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: 'hard' });
  });

  it('delete keeps the operator scope', async () => {
    const opDeleter = await addUser({
      tag: 'odel',
      role: 'operator',
      counterpartyId: s.operatorA,
      grant: ['wasteRequests.delete'],
    });
    const foreign = await insertRequest({ status: 'new', operator: s.operatorB });
    const dto = await card(foreign, s.users.dispatcher.auth);
    const res = await del(foreign, `version=${dto.version}&mode=hard`, () => opDeleter);
    expect(res.statusCode, res.body).toBe(403);
    expect(await exists(foreign)).toBe(true);
  });
});

describe.skipIf(!RUN_DB)('restore and purge', () => {
  it('restore advances the version and keeps its scope check', async () => {
    const id = await insertRequest({ status: 'confirmed', deleted: true });
    const before = await scalar<number>(
      sql`SELECT version AS v FROM waste_requests WHERE id = ${id}`,
    );
    const res = await inject('POST', `${REQUESTS}/${id}/restore`, s.users.admin.auth);
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as WasteRequestDto;
    expect(dto.deletedAt).toBeNull();
    expect(dto.version).toBe(before! + 1);

    const siteRestorer = await addUser({
      tag: 'srst',
      role: 'shtab',
      objects: [s.objectId],
      grant: ['archive.read', 'archive.restore'],
    });
    const foreign = await insertRequest({
      status: 'confirmed',
      deleted: true,
      objectId: current().otherObjectId,
    });
    const refused = await inject('POST', `${REQUESTS}/${foreign}/restore`, siteRestorer.auth);
    expect(refused.statusCode, refused.body).toBe(403);
  });

  it('a snow purge needs the confirmed archived version; a stale one is 409', async () => {
    const id = await insertRequest({ status: 'confirmed', deleted: true });
    const version = await scalar<number>(
      sql`SELECT version AS v FROM waste_requests WHERE id = ${id}`,
    );
    const missing = await inject('DELETE', `${REQUESTS}/${id}/purge`, s.users.admin.auth);
    expect(missing.statusCode, missing.body).toBe(400);
    const stale = await inject(
      'DELETE',
      `${REQUESTS}/${id}/purge?version=${version! + 1}`,
      s.users.admin.auth,
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await exists(id)).toBe(true);
    const ok = await inject(
      'DELETE',
      `${REQUESTS}/${id}/purge?version=${version}`,
      s.users.admin.auth,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await exists(id)).toBe(false);
    const audit = await scalar<{ num?: number; requestType?: string }>(
      sql`SELECT metadata AS v FROM audit_log WHERE action = 'waste_request.purge' AND entity_id = ${id}`,
    );
    expect(audit?.requestType).toBe('snow_removal');
  });

  it('purge checks the site scope that the shared purge route never asked', async () => {
    const sitePurger = await addUser({
      tag: 'sprg',
      role: 'shtab',
      objects: [s.objectId],
      grant: ['archive.read', 'records.purge'],
    });
    const foreign = await insertRequest({
      status: 'confirmed',
      deleted: true,
      objectId: current().otherObjectId,
    });
    const version = await scalar<number>(
      sql`SELECT version AS v FROM waste_requests WHERE id = ${foreign}`,
    );
    const res = await inject(
      'DELETE',
      `${REQUESTS}/${foreign}/purge?version=${version}`,
      sitePurger.auth,
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(await exists(foreign)).toBe(true);
  });

  it('a restore committed while the purge waits for the lock wins: nothing is purged', async () => {
    const id = await insertRequest({ status: 'confirmed', deleted: true });
    const file = await attach(id);
    const version = await scalar<number>(
      sql`SELECT version AS v FROM waste_requests WHERE id = ${id}`,
    );
    const res = await underLock(
      id,
      `UPDATE waste_requests SET deleted_at = NULL, deleted_by = NULL, version = version + 1
        WHERE id = $1`,
      () => inject('DELETE', `${REQUESTS}/${id}/purge?version=${version}`, s.users.admin.auth),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(await exists(id)).toBe(true);
    expect(await fileAlive(file)).toBe(true);
  });

  it('a scope change committed while the archive waits for the lock is decided on the locked row', async () => {
    const id = await insertRequest({ status: 'new' });
    const dto = await card(id, s.users.site.auth);
    const res = await underLock(
      id,
      `UPDATE waste_requests SET object_id = '${current().otherObjectId}' WHERE id = $1`,
      () => del(id, `version=${dto.version}&mode=hard`, () => s.users.site),
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it('work started while the archive waits for the lock turns the confirmation stale', async () => {
    const id = await insertRequest({ status: 'new' });
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await underLock(
      id,
      `UPDATE waste_requests SET status = 'confirmed', version = version + 1 WHERE id = $1`,
      () => del(id, `version=${dto.version}&mode=hard`),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(await exists(id)).toBe(true);
  });
});
