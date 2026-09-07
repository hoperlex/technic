import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as sqlRaw } from 'drizzle-orm';
import {
  type WasteTicketCheckDto,
  type WasteTicketDto,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';

/**
 * Исправление года кнопкой подсказки (ADR 0166, п. 6 и п. 7; Р11 и Р12 плана
 * `docs/waste-ticket-date-escalation-plan.md`).
 *
 * ЗАЧЕМ ЧЕРЕЗ `inject`, А НЕ ВЫЗОВОМ СВЕРКИ. Проверяется здесь не правило подсказки — оно чистое и
 * проверено на таблице случаев в `waste-ticket-date-anchor.test.ts`, — а решение маршрута: маркер
 * `editSource` не даёт ничего сам по себе, потому что под замком заявки сервер строит подсказку
 * заново и сверяет с ней присланное значение. Проверить это вызовом сверки нельзя: сверка ответит
 * то же самое и тогда, когда маршрут её вовсе не спросил.
 *
 * ПОЧЕМУ КАЖДЫЙ СЛУЧАЙ ЗАВОДИТ СВОЮ ЗАЯВКУ. Правка меняет талон и гасит замечание, то есть
 * уничтожает условие следующей проверки. Общая заготовка связала бы случаи порядком выполнения —
 * и первый же переставленный `it` красил бы соседние.
 *
 * Фикстуры синтетические: репозиторий публичный, настоящих номеров талонов и площадок здесь нет.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/waste-ticket-year-suggestion.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const MARK = `year-suggestion-${RUN}`;
const PASSWORD = 'Year-Suggestion-1234';

/** Плановая дата заявки: якорь мягкой ветки сверки, допуск к ней — трое суток. */
const DELIVERY_AT = '2026-08-17T09:00:00.000Z';
/** Фактический день вывоза, введённый человеком: с ним дата талона сверяется точно. */
const REMOVED_ON = '2026-08-17';
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
  // Слепая перепроверка здесь ни при чём, а жребий при подтверждении сделал бы часть прогонов
  // непохожей на другую: подтверждение нужно только ради принятия расхождения.
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
      lastName: 'Годов',
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
 * Выполненная заявка с одним машинным талоном — то, на чём и появляется подсказка.
 *
 * `removedOn` задаёт ветку сверки: введённый человеком день вывоза сверяется точно, его отсутствие
 * уводит сверку на плановую дату с допуском в трое суток (Р19). Обе ветки строят подсказку своим
 * окном, и обе должны доехать до маршрута одинаково.
 */
async function seedTicket(
  suffix: string,
  opts: { issuedOn: string; issuedOnRaw?: string; removedOn?: string },
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
  if (opts.removedOn) {
    await db.insert(schema.wasteRequestCompletions).values({
      requestId: request!.id,
      volumeM3: VOLUME,
      completedBy: ctx.owner.id,
      removedOn: opts.removedOn,
      removedOnSource: 'entered',
    });
  }
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
      issuedOnRaw: opts.issuedOnRaw ?? '',
      volumeM3: VOLUME,
      workKind: 'removal',
      addressRaw: '',
      createdBy: ctx.owner.id,
    })
    .returning({ id: schema.wasteTickets.id });
  return { requestId: request!.id, ticketId: ticket!.id, number };
}

/** Карточка разбора — то же чтение, которым живёт экран: талоны и посчитанные замечания. */
async function card(
  ticket: Ticket,
): Promise<{ dto: WasteTicketDto; checks: WasteTicketCheckDto[] }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/${ticket.requestId}/tickets`,
    headers: ctx.owner.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { tickets: WasteTicketDto[]; checks: WasteTicketCheckDto[] };
  const dto = body.tickets.find((t) => t.id === ticket.ticketId);
  expect(dto, 'талон пропал из карточки').toBeDefined();
  return { dto: dto!, checks: body.checks };
}

/** Замечание о дате по этому талону; `undefined` — сверка молчит. */
function dateMismatch(
  checks: WasteTicketCheckDto[],
  ticket: Ticket,
): WasteTicketCheckDto | undefined {
  return checks.find((c) => c.code === 'date_mismatch' && c.subjectKey === ticket.ticketId);
}

async function patch(
  ticket: Ticket,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}`,
    headers: ctx.owner.auth,
    payload,
  });
  return { statusCode: res.statusCode, body: res.body };
}

/** Дата в строке талона: единственный ответ на вопрос «изменилось ли что-нибудь на самом деле». */
async function storedIssuedOn(ticket: Ticket): Promise<string | null> {
  const rows = await ctx.db.execute<{ issued_on: string | null }>(sqlRaw`
    SELECT issued_on FROM waste_tickets WHERE id = ${ticket.ticketId}::uuid`);
  return rows.rows[0]!.issued_on;
}

/** Записи журнала аудита по этой заявке — в порядке появления. */
async function auditOf(
  ticket: Ticket,
): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
  const rows = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sqlRaw`
    SELECT action, metadata FROM audit_log
     WHERE entity_type = 'waste_request' AND entity_id = ${ticket.requestId}
     ORDER BY created_at`);
  return rows.rows;
}

/** События журнала наблюдений по полю даты: чем правка отчиталась о себе (ADR 0137). */
async function dateEvents(
  ticket: Ticket,
): Promise<{ event: string; old_value: string | null; new_value: string | null }[]> {
  const rows = await ctx.db.execute<{
    event: string;
    old_value: string | null;
    new_value: string | null;
  }>(sqlRaw`
    SELECT event, old_value, new_value FROM waste_ticket_field_events
     WHERE ticket_id = ${ticket.ticketId}::uuid AND field = 'issuedOn'
     ORDER BY created_at`);
  return rows.rows;
}

describe.skipIf(!DB_URL)('исправление года талона по подсказке', () => {
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
      .values({ code: `YS-${RUN}`, name: `Площадка ${RUN}`, address: 'Волоколамское ш., 71к14' })
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
    // `audit_log.entity_id` — текст, а не `uuid`: журнал пишут все модули, и не у каждой
    // сущности ключ является идентификатором.
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
    await ctx.db.execute(sqlRaw`DELETE FROM construction_objects WHERE code = ${`YS-${RUN}`}`);
    await ctx.app.close();
    await ctx.closeDb();
  }, 60_000);

  it('клик по живой подсказке правит год, гасит замечание и называет себя в аудите', async () => {
    const ticket = await seedTicket('YSA', {
      issuedOn: '2025-08-17',
      issuedOnRaw: '17.08.25',
      removedOn: REMOVED_ON,
    });

    const before = await card(ticket);
    // Транскрипция доезжает до карточки (ADR 0166, п. 7): по ней человек и видит, что модель
    // прочитала двузначный год, а век выбрала сама.
    expect(before.dto.issuedOnRaw).toBe('17.08.25');
    expect(dateMismatch(before.checks, ticket)?.suggestedIssuedOn).toBe('2026-08-17');

    const res = await patch(ticket, { issuedOn: '2026-08-17', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(200);

    const after = await card(ticket);
    expect(after.dto.issuedOn).toBe('2026-08-17');
    // Замечание уходит: подсказка обещала ровно это, и невыполненное обещание стоило бы доверия ко
    // всем следующим подсказкам.
    expect(dateMismatch(after.checks, ticket)).toBeUndefined();
    // Написание правкой не меняется: оно относится к скану, а не к решению человека (Р12).
    expect(after.dto.issuedOnRaw).toBe('17.08.25');

    const audit = await auditOf(ticket);
    const edits = audit.filter((row) => row.action === 'waste_request.ticket_edit');
    expect(edits).toHaveLength(1);
    // Отдельного действия под клик не заводится (ADR 0166, п. 6) — источник различает `source`, и
    // рядом с ним лежат оба значения даты: отчёту нужно не только «сколько», но и «что на что».
    expect(edits[0]!.metadata).toMatchObject({
      ticketId: ticket.ticketId,
      fields: ['issuedOn'],
      source: 'year_suggestion',
      issuedOnFrom: '2025-08-17',
      issuedOnTo: '2026-08-17',
    });

    // В журнале наблюдений клик остаётся обычной правкой поля (Р13): нового вида события нет, и
    // доля правок даты после выката считается по `audit_log.metadata.source`.
    expect(await dateEvents(ticket)).toEqual([
      { event: 'edited', old_value: '2025-08-17', new_value: '2026-08-17' },
    ]);
  });

  it('плановая дата: подсказка живёт в том же окне, по которому возникло замечание', async () => {
    // Дня вывоза человек не вводил — сверка ушла на плановую дату с допуском в трое суток, и
    // подсказка обязана попадать в это же окно, иначе она не гасила бы замечание.
    const ticket = await seedTicket('YSB', { issuedOn: '2025-08-18', issuedOnRaw: '18.08.25' });

    const before = await card(ticket);
    expect(dateMismatch(before.checks, ticket)?.suggestedIssuedOn).toBe('2026-08-18');

    const res = await patch(ticket, { issuedOn: '2026-08-18', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(200);

    const after = await card(ticket);
    expect(after.dto.issuedOn).toBe('2026-08-18');
    expect(dateMismatch(after.checks, ticket)).toBeUndefined();
  });

  it('присланное значение мимо подсказки отвергается конфликтом, талон не меняется', async () => {
    const ticket = await seedTicket('YSC', {
      issuedOn: '2025-08-17',
      issuedOnRaw: '17.08.25',
      removedOn: REMOVED_ON,
    });

    // Маркер не полномочие, а повод перепроверить: сервер построил «2026-08-17», а в теле стоит
    // другое число — значит правка приехала не от той подсказки, за которую себя выдаёт.
    const res = await patch(ticket, { issuedOn: '2024-08-17', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('Подсказка изменилась');

    expect(await storedIssuedOn(ticket)).toBe('2025-08-17');
    expect(await dateEvents(ticket)).toEqual([]);
    expect((await auditOf(ticket)).filter((r) => r.action === 'waste_request.ticket_edit')).toEqual(
      [],
    );
  });

  it('дата уже сходится с якорем — конфликт, а не молчаливая правка', async () => {
    const ticket = await seedTicket('YSD', { issuedOn: REMOVED_ON, removedOn: REMOVED_ON });
    expect(dateMismatch((await card(ticket)).checks, ticket)).toBeUndefined();

    const res = await patch(ticket, { issuedOn: '2025-08-17', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('уже сходится');
    expect(await storedIssuedOn(ticket)).toBe(REMOVED_ON);
  });

  it('замечание есть, а безопасной замены года нет — конфликт', async () => {
    // Расходятся и год, и день: замена одного года в окно якоря не приводит, подсказки не будет
    // вовсе (граница §8 плана), и кнопке не на что опереться.
    const ticket = await seedTicket('YSE', { issuedOn: '2025-03-05', removedOn: REMOVED_ON });
    expect(dateMismatch((await card(ticket)).checks, ticket)?.suggestedIssuedOn).toBeNull();

    const res = await patch(ticket, { issuedOn: '2026-03-05', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('больше не предлагается');
    expect(await storedIssuedOn(ticket)).toBe('2025-03-05');
  });

  it('отклонённый талон — конфликт: правят бумагу, а не снятую строку', async () => {
    const ticket = await seedTicket('YSF', {
      issuedOn: '2025-08-17',
      issuedOnRaw: '17.08.25',
      removedOn: REMOVED_ON,
    });
    const dismissed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/dismiss`,
      headers: ctx.owner.auth,
      payload: {},
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);

    const res = await patch(ticket, { issuedOn: '2026-08-17', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('не талон');
    expect(await storedIssuedOn(ticket)).toBe('2025-08-17');
  });

  it('принятое расхождение по дате — конфликт: кнопки на таком замечании нет', async () => {
    const ticket = await seedTicket('YSG', {
      issuedOn: '2025-08-17',
      issuedOnRaw: '17.08.25',
      removedOn: REMOVED_ON,
    });
    // Принять расхождение можно только у разобранной заявки (Р15) — сперва подтверждение талона.
    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/confirm`,
      headers: ctx.owner.auth,
      payload: {},
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/checks/date_mismatch/accept?subjectKey=${ticket.ticketId}`,
      headers: ctx.owner.auth,
      payload: { comment: 'Вывозили позже, дата верна' },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const res = await patch(ticket, { issuedOn: '2026-08-17', editSource: 'year_suggestion' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('уже принято');
    expect(await storedIssuedOn(ticket)).toBe('2025-08-17');
  });

  it('обычная правка маркера не шлёт и пишет аудит без источника', async () => {
    const ticket = await seedTicket('YSH', { issuedOn: '2025-08-17', removedOn: REMOVED_ON });

    // Ручной ввод не обязан совпадать ни с какой подсказкой: человек смотрит на бумагу, а не на
    // кнопку, и перепроверка подсказки на его пути не появляется вовсе.
    const res = await patch(ticket, { issuedOn: '2026-08-19' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedIssuedOn(ticket)).toBe('2026-08-19');

    const edits = (await auditOf(ticket)).filter((r) => r.action === 'waste_request.ticket_edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.metadata).toMatchObject({ ticketId: ticket.ticketId, fields: ['issuedOn'] });
    expect(edits[0]!.metadata.source).toBeUndefined();
  });
});
