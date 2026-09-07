import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as sqlRaw } from 'drizzle-orm';
import {
  type WasteTicketDto,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';

/**
 * Написание графы «Дата» и предложение перераспознавания (Р12 плана
 * `docs/waste-ticket-date-escalation-plan.md`; ADR 0166, п. 7; Р13 ADR 0114).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Дата и её написание — ОДНА ПАРА. Перераспознавание тронутого талона в
 * саму строку не пишет: новое чтение ложится рядом предложением, — и если бы принятие переносило
 * из него только дату, подпись «OCR в графе» осталась бы от ПРОШЛОГО прохода и начала бы объяснять
 * дату, которой в талоне больше нет. Ровно этим дефектом волна и открылась.
 *
 * ПОЧЕМУ ЧЕРЕЗ `inject`, А НЕ ЗАПРОСОМ К ТАБЛИЦЕ. Вопрос здесь к маршруту: что именно он переносит
 * из снимка предложения в талон. Проверка `UPDATE` запросом к базе осталась бы зелёной и тогда,
 * когда карточка человека показывает старую подпись, — а видит человек именно карточку.
 *
 * Пара «пустое написание дописывается новым проходом, непустое не трогается» живёт не здесь: её
 * решает воркер, и проверена она в `apps/worker/test/ticket-ocr-job.db.test.ts`.
 *
 * Фикстуры синтетические: репозиторий публичный, настоящих номеров талонов и площадок здесь нет.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/waste-ticket-proposal-raw.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const MARK = `proposal-raw-${RUN}`;
const PASSWORD = 'Proposal-Raw-1234';

/** Плановая дата заявки — она же якорь даты талона (ADR 0166, п. 2). */
const DELIVERY_AT = '2026-08-17T09:00:00.000Z';
const VOLUME = '20';

interface Person {
  id: string;
  auth: { authorization: string };
}

interface Ticket {
  requestId: string;
  ticketId: string;
  number: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof DbSchema;
  closeDb: () => Promise<void>;
  owner: Person;
  objectId: string;
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
  // Слепая перепроверка к предмету проверки отношения не имеет, а жребий при подтверждении сделал
  // бы часть прогонов непохожей на другую.
  process.env.TICKET_OCR_BLIND_CHECK_RATE = '0';
}

/** Свой адрес на запрос: вход ограничен десятью попытками в минуту с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function newPerson(tag: string): Promise<Person> {
  const { hashPassword } = await import('../src/auth/password');
  const email = `${MARK}-${tag}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Предложенцев',
      firstName: 'Тест',
      middleName: tag,
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return {
    id: created!.id,
    auth: { authorization: `Bearer ${login.json().accessToken as string}` },
  };
}

/**
 * Выполненная заявка с одним машинным талоном, которого КОСНУЛСЯ человек: только такую строку
 * новый проход не переписывает, а кладёт предложение рядом (Р13 ADR 0114). Написание задаётся
 * явно — им и отличаются случаи.
 */
async function seedTicket(
  suffix: string,
  opts: { issuedOn: string; issuedOnRaw: string },
): Promise<Ticket> {
  const { db, schema } = ctx;
  const number = `${suffix}${RUN}`.toUpperCase();
  const [request] = await db
    .insert(schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date(DELIVERY_AT),
      createdBy: ctx.owner.id,
      status: 'done',
      comment: MARK,
      volumeM3: VOLUME,
    })
    .returning({ id: schema.wasteRequests.id });
  const [ticket] = await db
    .insert(schema.wasteTickets)
    .values({
      requestId: request!.id,
      seq: 1,
      origin: 'ocr',
      status: 'unconfirmed',
      numberRaw: number,
      numberKey: wasteTicketNumberKey(number),
      numberFuzzy: wasteTicketNumberFuzzy(number),
      issuedOn: opts.issuedOn,
      issuedOnRaw: opts.issuedOnRaw,
      volumeM3: VOLUME,
      workKind: 'removal',
      addressRaw: '',
      createdBy: ctx.owner.id,
      // Строку правил человек: без этого новый проход переписал бы её целиком и предложения не
      // возникло бы вовсе.
      editedAt: new Date(),
      editedBy: ctx.owner.id,
    })
    .returning({ id: schema.wasteTickets.id });
  return { requestId: request!.id, ticketId: ticket!.id, number };
}

/**
 * Предложение перераспознавания — снимок нового чтения рядом с талоном. Связей с наблюдениями
 * здесь нет намеренно: адресация исхода проверяется отдельным набором
 * (`waste-ticket-audit-routes.db.test.ts`), а тянуть её сюда значило бы мерить две работы разом.
 */
async function seedProposal(
  ticket: Ticket,
  values: { issuedOn: string; issuedOnRaw: string },
): Promise<void> {
  await ctx.db.insert(ctx.schema.wasteTicketProposals).values({
    ticketId: ticket.ticketId,
    numberRaw: ticket.number,
    issuedOn: values.issuedOn,
    issuedOnRaw: values.issuedOnRaw,
    volumeM3: VOLUME,
    workKind: 'removal',
    addressRaw: '',
  });
}

/** Карточка разбора — то же чтение, которым живёт экран. */
async function card(ticket: Ticket): Promise<WasteTicketDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/${ticket.requestId}/tickets`,
    headers: ctx.owner.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { tickets: WasteTicketDto[] };
  const dto = body.tickets.find((t) => t.id === ticket.ticketId);
  expect(dto, 'талон пропал из карточки').toBeDefined();
  return dto!;
}

async function decide(
  ticket: Ticket,
  action: 'accept' | 'dismiss',
): Promise<{ statusCode: number; body: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/proposal/${action}`,
    headers: ctx.owner.auth,
    payload: {},
  });
  return { statusCode: res.statusCode, body: res.body };
}

describe.skipIf(!DB_URL)('предложение перераспознавания несёт написание даты', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await applyMigrations(client);
    } finally {
      await client.end();
    }
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({ code: `PR-${RUN}`, name: `Площадка ${RUN}`, address: 'Волоколамское ш., 71к14' })
      .returning({ id: schema.constructionObjects.id });

    ctx = {
      app,
      db,
      schema,
      closeDb,
      objectId: object!.id,
      owner: null as never,
    };
    ctx.owner = await newPerson('owner');
  }, 240_000);

  afterAll(async () => {
    if (!ctx) return;
    const mine = sqlRaw`SELECT id FROM waste_requests WHERE comment = ${MARK}`;
    // `audit_log.entity_id` — текст, а не `uuid`: журнал пишут все модули, и не у каждой сущности
    // ключ является идентификатором.
    const mineText = sqlRaw`SELECT id::text FROM waste_requests WHERE comment = ${MARK}`;
    // Порядок обязателен: событие журнала теряет талон по `SET NULL`, а не по каскаду, и уборка
    // «одним `DELETE` по заявкам» оставила бы в общей базе строки без хозяина.
    await ctx.db.execute(
      sqlRaw`DELETE FROM waste_ticket_field_events WHERE request_id IN (${mine})`,
    );
    await ctx.db.execute(
      sqlRaw`DELETE FROM audit_log WHERE entity_type = 'waste_request' AND entity_id IN (${mineText})`,
    );
    await ctx.db.execute(sqlRaw`DELETE FROM waste_requests WHERE comment = ${MARK}`);
    await ctx.db.execute(sqlRaw`DELETE FROM users WHERE email LIKE ${`${MARK}-%`}`);
    await ctx.db.execute(sqlRaw`DELETE FROM construction_objects WHERE code = ${`PR-${RUN}`}`);
    await ctx.app.close();
    await ctx.closeDb();
  }, 60_000);

  it('принятие переносит в талон и дату, и написание графы', async () => {
    // Написание у талона НЕ пустое, а от прошлого прохода: пустое не отличило бы перенос от
    // простого «заполнили дырку», а дефект был именно в том, что рядом с новой датой оставалась
    // старая подпись.
    const ticket = await seedTicket('PRA', { issuedOn: '2026-08-17', issuedOnRaw: '17.08.26' });
    await seedProposal(ticket, { issuedOn: '2026-08-19', issuedOnRaw: '19.08.26' });

    const before = await card(ticket);
    expect(before.issuedOn).toBe('2026-08-17');
    expect(before.issuedOnRaw).toBe('17.08.26');
    expect(before.proposal?.issuedOn).toBe('2026-08-19');

    const res = await decide(ticket, 'accept');
    expect(res.statusCode, res.body).toBe(200);

    const after = await card(ticket);
    expect(after.issuedOn).toBe('2026-08-19');
    // Главное утверждение всего набора: подпись «OCR в графе» объясняет ТУ дату, что стоит в
    // талоне. Останься здесь «17.08.26» — человек читал бы объяснение к дате, которой нет.
    expect(after.issuedOnRaw).toBe('19.08.26');
    expect(after.proposal).toBeNull();
  });

  it('отклонение не трогает ни дату, ни написание', async () => {
    // Обратная сторона той же пары: талон остаётся целиком тем, что сказал человек, — и подпись
    // под датой тоже. Иначе отказ от чтения машины частично его бы и применил.
    const ticket = await seedTicket('PRB', { issuedOn: '2026-08-17', issuedOnRaw: '17.08.26' });
    await seedProposal(ticket, { issuedOn: '2026-08-19', issuedOnRaw: '19.08.26' });

    const res = await decide(ticket, 'dismiss');
    expect(res.statusCode, res.body).toBe(200);

    const after = await card(ticket);
    expect(after.issuedOn).toBe('2026-08-17');
    expect(after.issuedOnRaw).toBe('17.08.26');
    expect(after.proposal).toBeNull();
  });
});
