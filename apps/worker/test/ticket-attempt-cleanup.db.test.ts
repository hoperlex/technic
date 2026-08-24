import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Уборка попыток по сроку (ADR 0114, Р31) — на живой схеме.
 *
 * Проверяется предикат отбора, а не обвязка: он весь состоит из `NOT EXISTS` и сравнения даты, и
 * ошибиться в нём можно молча в обе стороны. Забудь исключение — и подтверждённый талон потеряет
 * единственное объяснение, откуда взялась его цифра; забудь срок — и ответы моделей будут лежать
 * вечно, хотя разбирать по ним давно нечего.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/worker test ticket-attempt-cleanup
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const MARK = 'attempt-cleanup';

let client: pg.Client;
let ctx: { objectId: string; userId: string };

/** Копия предиката из воркера: строка уходит целиком — «похудевшая» осталась бы ключом кэша. */
const CLEANUP_SQL = `
  DELETE FROM waste_ticket_recognition_attempts a
   WHERE a.id IN (
     SELECT c.id FROM waste_ticket_recognition_attempts c
      WHERE c.created_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM waste_tickets wt
           WHERE wt.primary_attempt_id = c.id OR wt.escalation_attempt_id = c.id
        )
      ORDER BY c.created_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
   )
   RETURNING a.id`;

async function newAttempt(opts: { ageDays: number; sha?: string }): Promise<string> {
  const sha = opts.sha ?? Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64);
  const res = await client.query<{ id: string }>(
    `INSERT INTO waste_ticket_recognition_attempts
       (page_sha256, engine, model, model_reported, prompt_version, preprocessing_version,
        status, raw, created_at)
     VALUES ($1, 'stub', 'test/model', 'test/model', 1, 1, 'done',
             '{"tickets":[{"number":"30476"}]}'::jsonb, now() - ($2 || ' days')::interval)
     RETURNING id`,
    [sha, opts.ageDays],
  );
  return res.rows[0]!.id;
}

async function exists(id: string): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM waste_ticket_recognition_attempts WHERE id = $1`, [
    id,
  ]);
  return res.rows.length > 0;
}

async function cleanup(ttlDays: number): Promise<number> {
  const res = await client.query(CLEANUP_SQL, [ttlDays]);
  return res.rows.length;
}

/** Талон, ссылающийся на попытку: он и защищает её сырьё от уборки. */
async function newTicketWith(attemptId: string, column: 'primary' | 'escalation'): Promise<void> {
  const request = await client.query<{ id: string }>(
    `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status, comment)
     VALUES ($1, 'waste_removal', now(), $2, 'done', $3) RETURNING id`,
    [ctx.objectId, ctx.userId, MARK],
  );
  await client.query(
    `INSERT INTO waste_tickets (request_id, seq, number_raw, number_key, number_fuzzy, work_kind,
                                origin, status, ${column}_attempt_id)
     VALUES ($1, 1, '30476', '30476', '30476', 'removal', 'ocr', 'unconfirmed', $2)`,
    [request.rows[0]!.id, attemptId],
  );
}

describe.skipIf(!DB_URL)('уборка сырья попыток', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const obj = await client.query<{ id: string }>(
      `INSERT INTO construction_objects (code, name) VALUES ($1, $1) RETURNING id`,
      [`attempt-cleanup-${Date.now()}`],
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, last_name, first_name)
       VALUES ($1, 'x', 'Уборкин', 'Тест') RETURNING id`,
      [`attempt-cleanup-${Date.now()}@example.invalid`],
    );
    ctx = { objectId: obj.rows[0]!.id, userId: user.rows[0]!.id };
  });

  afterAll(async () => {
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(`DELETE FROM construction_objects WHERE code LIKE 'attempt-cleanup-%'`);
    await client.query(`DELETE FROM users WHERE email LIKE 'attempt-cleanup-%@example.invalid'`);
    await client?.end();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(
      `DELETE FROM waste_ticket_recognition_attempts WHERE engine = 'stub' AND model = 'test/model'`,
    );
  });

  it('старая несвязанная попытка уходит целиком', async () => {
    // Целиком, а не очисткой ответа: попытка со статусом `done` и пустым ответом осталась бы живым
    // ключом кэша, и тот же лист, приложенный заново, вернул бы страницу без единого талона.
    const id = await newAttempt({ ageDays: 200 });
    expect(await cleanup(180)).toBe(1);
    expect(await exists(id)).toBe(false);
  });

  it('свежая попытка не трогается', async () => {
    const id = await newAttempt({ ageDays: 10 });
    expect(await cleanup(180)).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('попытка живого талона переживает срок — она объясняет его цифру', async () => {
    const id = await newAttempt({ ageDays: 400 });
    await newTicketWith(id, 'primary');

    expect(await cleanup(180)).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('эскалационная ссылка защищает так же, как основная', async () => {
    const id = await newAttempt({ ageDays: 400 });
    await newTicketWith(id, 'escalation');

    expect(await cleanup(180)).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it('предложение попытку не держит, но переживает её уборку', async () => {
    // Снимок значений лежит в самом предложении, обе ссылки объявлены `ON DELETE SET NULL`: после
    // уборки оно читается по-прежнему, теряя лишь возможность заглянуть в исходный ответ. Иначе
    // непринятое предложение держало бы попытки вечно.
    const id = await newAttempt({ ageDays: 400 });
    const request = await client.query<{ id: string }>(
      `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status, comment)
       VALUES ($1, 'waste_removal', now(), $2, 'done', $3) RETURNING id`,
      [ctx.objectId, ctx.userId, MARK],
    );
    const ticket = await client.query<{ id: string }>(
      `INSERT INTO waste_tickets (request_id, seq, number_raw, number_key, number_fuzzy, work_kind,
                                  origin, status)
       VALUES ($1, 1, '30476', '30476', '30476', 'removal', 'ocr', 'unconfirmed') RETURNING id`,
      [request.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO waste_ticket_proposals (ticket_id, number_raw, primary_attempt_id)
       VALUES ($1, '30999', $2)`,
      [ticket.rows[0]!.id, id],
    );

    expect(await cleanup(180)).toBe(1);
    const left = await client.query<{ number_raw: string; primary_attempt_id: string | null }>(
      `SELECT number_raw, primary_attempt_id FROM waste_ticket_proposals WHERE ticket_id = $1`,
      [ticket.rows[0]!.id],
    );
    expect(left.rows[0]).toMatchObject({ number_raw: '30999', primary_attempt_id: null });
  });
});
