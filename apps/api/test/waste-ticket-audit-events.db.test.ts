import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as sqlRaw } from 'drizzle-orm';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';
import type * as Events from '../src/services/waste-ticket-events';

/**
 * Адресация человеческого решения к наблюдению (миграция 0210, план §1.1).
 *
 * Сервис проверяется напрямую, а не через маршруты, по одной причине: адресация — это утверждение
 * о том, ЧТО именно оценил человек, и оно должно держаться независимо от того, какой маршрут его
 * позвал. Маршруты проверяются своими тестами; здесь — что «текущее чтение» находится, «явное»
 * берётся как названо, а контекст (модель, версии, попытки) копируется из наблюдения, а не из
 * талона: талон помнит последнюю попытку, а судят о той, что прочитала эту цифру.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_audit_test \
 *     pnpm --filter @technic/api test waste-ticket-audit-events.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

interface Ctx {
  db: typeof AppDb;
  events: typeof Events;
  closeDb: () => Promise<void>;
  requestId: string;
  ticketId: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

/** Машинное чтение поля: то самое наблюдение, к которому потом адресуются решения. */
async function seedObservation(
  field: string,
  value: string | null,
  extra: { model?: string; promptVersion?: number; readState?: string } = {},
): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sqlRaw`
    INSERT INTO waste_ticket_field_events
      (ticket_id, request_id, event, field, new_value, read_state, model, model_reported,
       prompt_version, preprocessing_version, primary_model_reported, collection_version)
    VALUES (${ctx.ticketId}::uuid, ${ctx.requestId}::uuid, 'recognized', ${field}, ${value},
            ${extra.readState ?? 'read'}, ${extra.model ?? 'proxy'}, ${extra.model ?? 'gemini'},
            ${extra.promptVersion ?? 3}, 1, ${extra.model ?? 'gemini'}, 2)
    RETURNING id
  `);
  return rows.rows[0]!.id;
}

async function eventsOf(field: string): Promise<
  {
    event: string;
    observation_id: string | null;
    model_reported: string;
    prompt_version: number | null;
  }[]
> {
  const rows = await ctx.db.execute(sqlRaw`
    SELECT event, observation_id, model_reported, prompt_version
      FROM waste_ticket_field_events
     WHERE ticket_id = ${ctx.ticketId}::uuid AND field = ${field}
     ORDER BY created_at
  `);
  return rows.rows;
}

describe.skipIf(!DB_URL)('адресация решений к наблюдениям', () => {
  beforeAll(async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await applyMigrations(client);
    } finally {
      await client.end();
    }
    prepareEnv(DB_URL!);
    const dbModule = await import('../src/db/client');
    const events = await import('../src/services/waste-ticket-events');

    const object = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO construction_objects (code, name) VALUES (${`AUE-${RUN}`}, ${`Аудит ${RUN}`})
      RETURNING id`);
    const user = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO users (email, password_hash, last_name, first_name)
      VALUES (${`audit-events-${RUN}@example.test`}, 'x', 'Аудит', 'События') RETURNING id`);
    const objectId = object.rows[0]!.id;
    const userId = user.rows[0]!.id;
    const request = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status, comment)
      VALUES (${objectId}::uuid, 'waste_removal', now(), ${userId}::uuid, 'done', ${`audit-events-${RUN}`})
      RETURNING id`);
    const requestId = request.rows[0]!.id;
    const ticket = await dbModule.db.execute<{ id: string }>(sqlRaw`
      INSERT INTO waste_tickets (request_id, origin, status, number_raw, number_key, volume_m3, work_kind)
      VALUES (${requestId}::uuid, 'ocr', 'unconfirmed', ${`AUE${RUN}`}, ${`AUE${RUN}`}, '20', 'removal')
      RETURNING id`);

    ctx = {
      db: dbModule.db,
      events,
      closeDb: dbModule.closeDb,
      requestId,
      ticketId: ticket.rows[0]!.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.db.execute(
      sqlRaw`DELETE FROM waste_requests WHERE comment = ${`audit-events-${RUN}`}`,
    );
    await ctx.db.execute(
      sqlRaw`DELETE FROM users WHERE email = ${`audit-events-${RUN}@example.test`}`,
    );
    await ctx.db.execute(sqlRaw`DELETE FROM construction_objects WHERE code = ${`AUE-${RUN}`}`);
    await ctx.closeDb();
  });

  it('правка адресуется последнему чтению поля и берёт его модель, а не талона', async () => {
    await seedObservation('volumeM3', '3', { model: 'flash-lite', promptVersion: 3 });
    const second = await seedObservation('volumeM3', '4', { model: 'flash-2.5', promptVersion: 4 });

    await ctx.db.transaction(async (tx) => {
      await ctx.events.recordTicketFieldEvents(tx, {
        ticketId: ctx.ticketId,
        requestId: ctx.requestId,
        event: 'edited',
        actorId: null,
        changes: [{ field: 'volumeM3', oldValue: '4', newValue: '38' }],
      });
    });

    const rows = await eventsOf('volumeM3');
    const edited = rows.find((r) => r.event === 'edited');
    expect(edited?.observation_id).toBe(second);
    // Последнее чтение читала другая модель другой версией промпта — и правка судит о ней.
    expect(edited?.model_reported).toBe('flash-2.5');
    expect(edited?.prompt_version).toBe(4);
  });

  it('решение по предложению адресуется названному чтению, а не последнему', async () => {
    const older = await seedObservation('number', '262', { model: 'flash-lite' });
    await seedObservation('number', '26213', { model: 'flash-2.5' });

    await ctx.db.transaction(async (tx) => {
      await ctx.events.recordTicketFieldEvents(tx, {
        ticketId: ctx.ticketId,
        requestId: ctx.requestId,
        event: 'proposal_dismissed',
        actorId: null,
        changes: [{ field: 'number', oldValue: '26213', newValue: '262' }],
        target: { kind: 'explicit', byField: { number: older } },
        proposalDiffers: { number: true },
      });
    });

    const dismissed = (await eventsOf('number')).find((r) => r.event === 'proposal_dismissed');
    expect(dismissed?.observation_id).toBe(older);
    expect(dismissed?.model_reported).toBe('flash-lite');
  });

  it('живое предложение не перебивает чтение, которое человек видит в карточке', async () => {
    // Чтения предложения — тоже `recognized` этого талона, и они свежее того, чьи значения стоят
    // в карточке. Возьми ветка «текущее» просто последнее — правка легла бы на модель, чьё чтение
    // никто не принимал, а прежнее чтение осталось бы без исхода. Ровно ошибка, ради которой
    // адресация и разводилась.
    const inCard = await seedObservation('addressRaw', 'ул. Ленина 5', { model: 'flash-lite' });
    const proposed = await seedObservation('addressRaw', 'ул. Ленина, д. 5', {
      model: 'flash-2.5',
    });
    await ctx.db.execute(sqlRaw`
      INSERT INTO waste_ticket_proposals (ticket_id, number_raw, address_raw)
      VALUES (${ctx.ticketId}::uuid, 'PROP', 'ул. Ленина, д. 5')
      ON CONFLICT (ticket_id) DO UPDATE SET address_raw = EXCLUDED.address_raw
    `);
    await ctx.db.execute(sqlRaw`
      INSERT INTO waste_ticket_proposal_observations (proposal_ticket_id, field, observation_id, differs)
      VALUES (${ctx.ticketId}::uuid, 'addressRaw', ${proposed}::uuid, true)
      ON CONFLICT (proposal_ticket_id, field) DO UPDATE SET observation_id = EXCLUDED.observation_id
    `);

    await ctx.db.transaction(async (tx) => {
      await ctx.events.recordTicketFieldEvents(tx, {
        ticketId: ctx.ticketId,
        requestId: ctx.requestId,
        event: 'edited',
        actorId: null,
        changes: [
          { field: 'addressRaw', oldValue: 'ул. Ленина 5', newValue: 'ул. Ленина, д. 5, корп. 2' },
        ],
      });
    });

    const edited = (await eventsOf('addressRaw')).find((r) => r.event === 'edited');
    expect(edited?.observation_id).toBe(inCard);
    expect(edited?.model_reported).toBe('flash-lite');
  });

  it('правка ручного талона остаётся без наблюдения и без модели', async () => {
    await ctx.db.transaction(async (tx) => {
      await ctx.events.recordTicketFieldEvents(tx, {
        ticketId: ctx.ticketId,
        requestId: ctx.requestId,
        event: 'edited',
        actorId: null,
        changes: [{ field: 'workKind', oldValue: 'removal', newValue: 'idle' }],
      });
    });

    const edited = (await eventsOf('workKind')).find((r) => r.event === 'edited');
    expect(edited?.observation_id).toBeNull();
    expect(edited?.model_reported).toBe('');
  });

  it('currentTicketObservations отдаёт по последнему чтению на поле', async () => {
    const latest = await seedObservation('issuedOn', '2026-08-17');
    const byField = await ctx.db.transaction((tx) =>
      ctx.events.currentTicketObservations(tx, ctx.ticketId),
    );
    expect(byField.issuedOn).toBe(latest);
    // По каждому читанному полю ровно одна запись — последняя: связь заводится вперёд решения, и
    // указать она должна на то чтение, которое человек увидит. Проверяем сверкой с базой, а не
    // списком имён: список зависел бы от того, какие тесты отработали раньше.
    const expected = await ctx.db.execute<{ field: string; id: string }>(sqlRaw`
      SELECT DISTINCT ON (field) field, id
        FROM waste_ticket_field_events
       WHERE ticket_id = ${ctx.ticketId}::uuid
         AND event IN ('recognized', 'disputed')
         AND collection_version >= 2
       ORDER BY field, created_at DESC
    `);
    expect(byField).toEqual(Object.fromEntries(expected.rows.map((r) => [r.field, r.id])));
  });
});
