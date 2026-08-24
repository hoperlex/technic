import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Реестр «требуют разбора» (ADR 0114, Р24) — на живой схеме.
 *
 * Отбор шире, чем «есть замечания», и это его главное свойство: корректно распознанный талон без
 * единого расхождения иначе никогда не попал бы к проверяющему и остался бы неподтверждённым
 * навсегда — а неподтверждённый талон не занимает номер и в сверку не входит. Проверять такой
 * предикат моками бессмысленно: он целиком написан на `EXISTS`.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const MARK = 'registry-probe';

let client: pg.Client;
/** Второй человек нужен арбитражу: `CHECK` запрещает арбитру совпадать с проверяющим. */
let ctx: { objectId: string; userId: string; arbiterId: string };

/** Предикат реестра — копия условия из маршрута; проверяется именно SQL, а не его обвязка. */
const REGISTRY_SQL = `
  SELECT wr.id FROM waste_requests wr
   WHERE wr.id = $1 AND (
     EXISTS (SELECT 1 FROM waste_tickets wt
              WHERE wt.request_id = wr.id
                AND (wt.status = 'unconfirmed' OR array_length(wt.needs_review_fields, 1) > 0))
     OR EXISTS (SELECT 1 FROM waste_ticket_files wf
                 WHERE wf.request_id = wr.id AND wf.status IN ('unsupported', 'failed'))
     OR EXISTS (SELECT 1 FROM waste_ticket_pages wp
                 WHERE wp.request_id = wr.id AND wp.status = 'failed')
     OR EXISTS (SELECT 1 FROM waste_ticket_blind_checks bc
                 JOIN waste_tickets wt2 ON wt2.id = bc.ticket_id
                WHERE wt2.request_id = wr.id AND bc.status IN ('pending', 'mismatch'))
   )`;

async function needsReview(requestId: string): Promise<boolean> {
  const res = await client.query(REGISTRY_SQL, [requestId]);
  return res.rows.length > 0;
}

async function newRequest(): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status, comment)
     VALUES ($1, 'waste_removal', now(), $2, 'done', $3) RETURNING id`,
    [ctx.objectId, ctx.userId, MARK],
  );
  return res.rows[0]!.id;
}

async function addTicket(
  requestId: string,
  opts: { status: string; needsReview?: string[]; number?: string },
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO waste_tickets (request_id, seq, number_raw, number_key, number_fuzzy,
                                work_kind, origin, status, needs_review_fields, confirmed_by,
                                confirmed_at)
     VALUES ($1, 1, $2, $2, $2, 'removal', 'ocr', $3, $4::text[],
             CASE WHEN $3 = 'confirmed' THEN $5::uuid END,
             CASE WHEN $3 = 'confirmed' THEN now() END)
     RETURNING id`,
    [requestId, opts.number ?? '30476', opts.status, opts.needsReview ?? [], ctx.userId],
  );
  return res.rows[0]!.id;
}

describe.skipIf(!DB_URL)('реестр «требуют разбора»', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const obj = await client.query<{ id: string }>(
      `INSERT INTO construction_objects (code, name) VALUES ($1, $1) RETURNING id`,
      [`registry-${Date.now()}`],
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, last_name, first_name)
       VALUES ($1, 'x', 'Реестров', 'Тест') RETURNING id`,
      [`registry-${Date.now()}@example.invalid`],
    );
    const arbiter = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, last_name, first_name)
       VALUES ($1, 'x', 'Арбитров', 'Тест') RETURNING id`,
      [`registry-arb-${Date.now()}@example.invalid`],
    );
    ctx = {
      objectId: obj.rows[0]!.id,
      userId: user.rows[0]!.id,
      arbiterId: arbiter.rows[0]!.id,
    };
  });

  afterAll(async () => {
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(`DELETE FROM construction_objects WHERE code LIKE 'registry-%'`);
    await client.query(`DELETE FROM users WHERE email LIKE 'registry-%@example.invalid'`);
    await client.query(`DELETE FROM files WHERE object_key LIKE 'registry/%'`);
    await client?.end();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
  });

  it('заявка с подтверждённым талоном и без замечаний в реестр не попадает', async () => {
    const id = await newRequest();
    await addTicket(id, { status: 'confirmed' });
    expect(await needsReview(id)).toBe(false);
  });

  it('корректно распознанный, но неподтверждённый талон — попадает', async () => {
    const id = await newRequest();
    await addTicket(id, { status: 'unconfirmed' });
    expect(await needsReview(id)).toBe(true);
  });

  it('спорное поле у подтверждаемого талона — попадает', async () => {
    const id = await newRequest();
    await addTicket(id, { status: 'unconfirmed', needsReview: ['volumeM3'] });
    expect(await needsReview(id)).toBe(true);
  });

  it('отвергнутый файл — попадает даже без единого талона', async () => {
    const id = await newRequest();
    const file = await client.query<{ id: string }>(
      `INSERT INTO files (bucket, object_key, filename, content_type, size, status)
       VALUES ('t', $1, 'f.jpg', 'image/jpeg', 1, 'active') RETURNING id`,
      [`registry/${id}.jpg`],
    );
    // Файловая строка держится составным ключом на связь талона с заявкой: без `request_files`
    // она существовать не может, и это ровно та защита от рассинхрона, ради которой ключ заведён.
    await client.query(
      `INSERT INTO request_files (request_id, file_id, kind) VALUES ($1, $2, 'ticket')`,
      [id, file.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO waste_ticket_files (file_id, request_id, status, reason, error_class, error_scope)
       VALUES ($1, $2, 'unsupported', 'не изображение', 'terminal', 'item')`,
      [file.rows[0]!.id, id],
    );
    expect(await needsReview(id)).toBe(true);
    await client.query(`DELETE FROM files WHERE id = $1`, [file.rows[0]!.id]);
  });

  it('невыполненная слепая перепроверка держит заявку в реестре', async () => {
    const id = await newRequest();
    const ticketId = await addTicket(id, { status: 'confirmed' });
    await client.query(
      `INSERT INTO waste_ticket_blind_checks (ticket_id, baseline_fingerprint, status)
       VALUES ($1, $2, 'pending')`,
      [ticketId, 'c'.repeat(64)],
    );
    expect(await needsReview(id)).toBe(true);
  });

  it('разобранная перепроверка заявку отпускает', async () => {
    const id = await newRequest();
    const ticketId = await addTicket(id, { status: 'confirmed' });
    await client.query(
      `INSERT INTO waste_ticket_blind_checks
         (ticket_id, checker_id, baseline_fingerprint, baseline_number_key, review_number_key,
          status, resolved_fields, final_number_raw, final_number_key, arbiter_id, arbitrated_at)
       VALUES ($1, $2, $3, '30476', '30478', 'arbitrated', ARRAY['number']::text[],
               '30476', '30476', $4, now())`,
      [ticketId, ctx.userId, 'c'.repeat(64), ctx.arbiterId],
    );
    expect(await needsReview(id)).toBe(false);
  });
});
