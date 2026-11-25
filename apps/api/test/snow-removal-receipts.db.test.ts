import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestHistoryEntryDto, WasteRequestDto } from '@technic/contracts';
import {
  buildScene,
  card,
  current,
  inject,
  insertRequest,
  newFile,
  nextAddress,
  REQUESTS,
  type Scene,
  scalar,
  SNOW,
  snowBody,
  type TestUser,
} from './snow-removal-harness';

/**
 * One authorized snapshot per response, and live file masking before emission (snow-removal plan,
 * §3.2; §4 «Requests and permissions»).
 *
 * The windows under test — «after commit, before the response» — are opened by DEFERRED
 * constraint triggers installed in this file's own database: they run at the commit of the
 * request's own transaction, after its last statement. A response read through the pool after the
 * commit would see what the trigger wrote; a response built inside the transaction cannot. That is
 * the mechanism the plan asks to prove, without guessing at timings.
 *
 * The replay after an insert conflict is reached deterministically: a test transaction holds an
 * uncommitted receipt row under the key, so the route's early lookup misses it and its INSERT waits
 * on the key; the test then changes the request and commits.
 */

const RUN_DB = !!process.env.TEST_DATABASE_URL;
let s: Scene;
let dbUrl = '';

beforeAll(async () => {
  const built = await buildScene('receipts');
  if (!built) return;
  s = built;
  dbUrl = process.env.DATABASE_URL!;
  // At the commit of a request whose comment asks for it, the row is moved to another site and
  // marked: a response built after the commit would carry both.
  await s.db.execute(
    sql.raw(`
    CREATE FUNCTION snow_test_late_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.comment LIKE 'late-move:%' AND NEW.operator_comment <> 'written after commit' THEN
        UPDATE waste_requests
           SET object_id = '${s.otherObjectId}', operator_comment = 'written after commit'
         WHERE id = NEW.id;
      ELSIF NEW.comment LIKE 'late-write:%' AND NEW.operator_comment <> 'written after commit' THEN
        UPDATE waste_requests SET operator_comment = 'written after commit' WHERE id = NEW.id;
      ELSIF NEW.comment LIKE 'late-quarantine:%' THEN
        UPDATE files SET quarantined_at = now()
         WHERE id IN (SELECT file_id FROM request_files WHERE request_id = NEW.id)
           AND quarantined_at IS NULL;
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER snow_test_late_write_ins AFTER INSERT ON waste_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION snow_test_late_write();
    CREATE CONSTRAINT TRIGGER snow_test_late_write_upd AFTER UPDATE ON waste_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION snow_test_late_write();
  `),
  );
}, 300_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

function keyed(user: TestUser, key: string, body: Record<string, unknown>) {
  return current().app.inject({
    method: 'POST',
    url: `${REQUESTS}/_create-with-receipt`,
    headers: { ...user.auth, ...SNOW, 'idempotency-key': key },
    payload: body,
    remoteAddress: nextAddress(),
  });
}

async function quarantine(fileId: string): Promise<void> {
  await current().db.execute(sql`UPDATE files SET quarantined_at = now() WHERE id = ${fileId}`);
}

/** The same key replayed while a test transaction holds the receipt row uncommitted. */
async function replayThroughInsertConflict(
  user: TestUser,
  body: Record<string, unknown>,
  source: { key: string; requestId: string },
  between: () => Promise<void>,
) {
  const key = randomUUID();
  const holder = new pg.Client({ connectionString: dbUrl });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO request_create_attempts (key, kind, actor_user_id, fingerprint, request_id, response)
       SELECT $1, kind, actor_user_id, fingerprint, request_id, response
         FROM request_create_attempts WHERE key = $2`,
      [key, source.key],
    );
    const pending = keyed(user, key, body);
    // Wait until the route's INSERT queues behind the uncommitted key.
    for (let i = 0; i < 100; i++) {
      const waiting = await scalar<number>(sql`
        SELECT count(*)::int AS v FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%request_create_attempts%'`);
      if ((waiting ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await between();
    await holder.query('COMMIT');
    return await pending;
  } finally {
    await holder.end();
  }
}

describe.skipIf(!RUN_DB)('the creation answer is the creation snapshot', () => {
  it('keyed: a move committed with the insert never reaches the first answer', async () => {
    const key = randomUUID();
    const body = snowBody({ comment: `late-move:${key}` });
    const first = await keyed(s.users.site, key, body);
    expect(first.statusCode, first.body).toBe(201);
    const dto = first.json() as WasteRequestDto;
    expect(dto.objectId).toBe(s.objectId);
    expect(dto.operatorComment).toBe('');
    // The row did move: the dispatcher sees it on the other site.
    const now = await card(dto.id, s.users.dispatcher.auth);
    expect(now.objectId).toBe(s.otherObjectId);
    // The frozen receipt is the same snapshot.
    const frozen = await scalar<WasteRequestDto>(
      sql`SELECT response AS v FROM request_create_attempts WHERE key = ${key}`,
    );
    expect(frozen?.objectId).toBe(s.objectId);
    expect(frozen?.operatorComment).toBe('');
    // And the early replay asks the CURRENT row: moved out of the site user's area — refused.
    const replay = await keyed(s.users.site, key, body);
    expect(replay.statusCode, replay.body).toBe(403);
  });

  it('unkeyed: the same creation snapshot', async () => {
    const res = await inject(
      'POST',
      REQUESTS,
      s.users.site.auth,
      snowBody({ comment: `late-move:${randomUUID()}` }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as WasteRequestDto;
    expect(dto.objectId).toBe(s.objectId);
    expect(dto.operatorComment).toBe('');
    expect((await card(dto.id, s.users.dispatcher.auth)).objectId).toBe(s.otherObjectId);
  });

  it('a mutation answer is built before its commit, not read after it', async () => {
    const id = await insertRequest({ status: 'new' });
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      comment: `late-write:${randomUUID()}`,
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as WasteRequestDto).operatorComment).toBe('');
    expect((await card(id, s.users.dispatcher.auth)).operatorComment).toBe('written after commit');
  });
});

describe.skipIf(!RUN_DB)('receipt replay checks the current row', () => {
  it('early lookup: archived since the first send — 404 for an account without the archive', async () => {
    const key = randomUUID();
    const body = snowBody();
    const first = await keyed(s.users.site, key, body);
    expect(first.statusCode, first.body).toBe(201);
    const { id } = first.json() as WasteRequestDto;
    await current().db.execute(
      sql`UPDATE waste_requests SET deleted_at = now(), deleted_by = ${s.adminId} WHERE id = ${id}`,
    );
    const replay = await keyed(s.users.site, key, body);
    expect(replay.statusCode, replay.body).toBe(404);
  });

  it('insert-conflict branch: moved out of scope between send and replay — 403', async () => {
    const key = randomUUID();
    const body = snowBody();
    const first = await keyed(s.users.site, key, body);
    expect(first.statusCode, first.body).toBe(201);
    const { id } = first.json() as WasteRequestDto;
    const replay = await replayThroughInsertConflict(
      s.users.site,
      body,
      { key, requestId: id },
      async () => {
        await current().db.execute(
          sql`UPDATE waste_requests SET object_id = ${s.otherObjectId} WHERE id = ${id}`,
        );
      },
    );
    expect(replay.statusCode, replay.body).toBe(403);
  });

  it('insert-conflict branch: archived between send and replay — 404', async () => {
    const key = randomUUID();
    const body = snowBody();
    const first = await keyed(s.users.site, key, body);
    const { id } = first.json() as WasteRequestDto;
    const replay = await replayThroughInsertConflict(
      s.users.site,
      body,
      { key, requestId: id },
      async () => {
        await current().db.execute(
          sql`UPDATE waste_requests SET deleted_at = now(), deleted_by = ${s.adminId}
               WHERE id = ${id}`,
        );
      },
    );
    expect(replay.statusCode, replay.body).toBe(404);
  });
});

describe.skipIf(!RUN_DB)('live file masking before every emission', () => {
  it('first send: an attachment quarantined at the commit is masked in the answer', async () => {
    const file = await newFile(s.users.site, { name: 'Паспорт-первый.pdf' });
    const res = await keyed(
      s.users.site,
      randomUUID(),
      snowBody({ comment: `late-quarantine:${randomUUID()}`, fileIds: [file.id] }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as WasteRequestDto;
    expect(dto.files).toEqual([
      expect.objectContaining({ id: file.id, filename: '', quarantined: true }),
    ]);
    expect(res.body).not.toContain('Паспорт-первый');
  });

  it('early replay: quarantined after the snapshot — masked; released — named again', async () => {
    const file = await newFile(s.users.site, { name: 'Паспорт-повтор.pdf' });
    const key = randomUUID();
    const body = snowBody({ fileIds: [file.id] });
    const first = await keyed(s.users.site, key, body);
    expect(first.statusCode, first.body).toBe(201);
    expect((first.json() as WasteRequestDto).files[0]?.filename).toBe('Паспорт-повтор.pdf');
    await quarantine(file.id);
    const replay = await keyed(s.users.site, key, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).not.toContain('Паспорт-повтор');
    expect((replay.json() as WasteRequestDto).files[0]).toMatchObject({
      filename: '',
      quarantined: true,
    });
    // Other frozen fields stay frozen: the receipt itself was not rewritten.
    const frozen = await scalar<WasteRequestDto>(
      sql`SELECT response AS v FROM request_create_attempts WHERE key = ${key}`,
    );
    expect(frozen?.files[0]?.filename).toBe('Паспорт-повтор.pdf');
    await current().db.execute(sql`UPDATE files SET quarantined_at = NULL WHERE id = ${file.id}`);
    const released = await keyed(s.users.site, key, body);
    expect((released.json() as WasteRequestDto).files[0]).toEqual(
      expect.not.objectContaining({ quarantined: true }),
    );
    expect((released.json() as WasteRequestDto).files[0]?.filename).toBe('Паспорт-повтор.pdf');
  });

  it('insert-conflict replay: quarantined meanwhile — masked', async () => {
    const file = await newFile(s.users.site, { name: 'Паспорт-конфликт.pdf' });
    const key = randomUUID();
    const body = snowBody({ fileIds: [file.id] });
    const first = await keyed(s.users.site, key, body);
    const { id } = first.json() as WasteRequestDto;
    const replay = await replayThroughInsertConflict(
      s.users.site,
      body,
      { key, requestId: id },
      () => quarantine(file.id),
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).not.toContain('Паспорт-конфликт');
  });

  it('a legacy receipt without a frozen answer is completed from one snapshot, masked', async () => {
    const file = await newFile(s.users.site, { name: 'Паспорт-старый.pdf' });
    const key = randomUUID();
    const body = snowBody({ fileIds: [file.id] });
    await keyed(s.users.site, key, body);
    await current().db.execute(
      sql`UPDATE request_create_attempts SET response = NULL WHERE key = ${key}`,
    );
    await quarantine(file.id);
    const replay = await keyed(s.users.site, key, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).not.toContain('Паспорт-старый');
    expect(
      await scalar<boolean>(
        sql`SELECT response IS NOT NULL AS v FROM request_create_attempts WHERE key = ${key}`,
      ),
    ).toBe(true);
  });

  it('a stored legacy answer naming a file whose row is gone withholds the name', async () => {
    const file = await newFile(s.users.site, { name: 'Исчезнувший.pdf' });
    const key = randomUUID();
    const body = snowBody({ fileIds: [file.id] });
    const first = await keyed(s.users.site, key, body);
    const { id } = first.json() as WasteRequestDto;
    await current().db.execute(sql`DELETE FROM request_files WHERE request_id = ${id}`);
    await current().db.execute(sql`DELETE FROM files WHERE id = ${file.id}`);
    const replay = await keyed(s.users.site, key, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).not.toContain('Исчезнувший');
    expect((replay.json() as WasteRequestDto).files).toEqual([
      expect.objectContaining({ id: file.id, filename: '' }),
    ]);
  });

  it('history masks a late ticket quarantined after its audit event', async () => {
    const id = await insertRequest({ status: 'done' });
    const dto = await card(id, s.users.dispatcher.auth);
    const ticket = await newFile(s.users.dispatcher, { name: 'Талон-поздний.pdf' });
    const res = await inject('POST', `${REQUESTS}/${id}/ticket-files`, s.users.dispatcher.auth, {
      ticketFileIds: [ticket.id],
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    await quarantine(ticket.id);
    const history = await inject('GET', `${REQUESTS}/${id}/history`, s.users.dispatcher.auth);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).not.toContain('Талон-поздний');
    const entry = (history.json() as RequestHistoryEntryDto[]).find(
      (e) => e.kind === 'ticketsAdded',
    );
    expect(entry?.changes[0]?.files?.[0]).toMatchObject({ id: ticket.id, quarantined: true });
  });
});
