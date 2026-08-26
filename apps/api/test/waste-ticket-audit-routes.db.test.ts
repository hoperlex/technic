import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as sqlRaw } from 'drizzle-orm';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';

/**
 * Адресация наблюдений на живых маршрутах разбора талонов (миграция 0210, план
 * `docs/waste-ticket-audit-plan.md` §1.1, §1.2, §1.2.1, §1.2.2, §2.1).
 *
 * Зачем через `inject`, а не вызовом сервиса. Сервис умеет записать событие с любой адресацией —
 * вопрос в том, КАКУЮ адресацию выберет маршрут, и ответ на него живёт только в маршруте. Три
 * решения принимаются там и нигде больше: правка адресуется текущему чтению под замком, принятие и
 * отклонение предложения — чтениям предложения из таблицы связей, арбитраж — `baseline`-чтениям
 * отбора. Проверь их вызовом сервиса — и проверка осталась бы зелёной ровно тогда, когда маршрут
 * перестал бы передавать `target`.
 *
 * Наблюдения и связи предложения сеются здесь РУКАМИ, прямым `INSERT`: их пишет воркер, а он
 * переписывается отдельно. Тест, зовущий воркер, мерил бы две работы разом и падал бы на чужой
 * половине.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_audit_routes_test \
 *     npx vitest run test/waste-ticket-audit-routes.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const MARK = `audit-routes-${RUN}`;
const PASSWORD = 'Audit-Routes-1234';

/** Пять полей бланка. Порядок устойчивый: журналу нужен обход, а не случайность. */
const FIELDS = ['number', 'issuedOn', 'volumeM3', 'workKind', 'addressRaw'] as const;
type Field = (typeof FIELDS)[number];

/** Значения талона-заготовки: их же читает «модель» в наблюдениях. */
const ISSUED_ON = '2026-08-17';
const VOLUME = '20';
const WORK_KIND = 'removal';

interface Person {
  id: string;
  auth: { authorization: string };
}

interface Ticket {
  requestId: string;
  ticketId: string;
  number: string;
}

interface EventRow {
  id: string;
  event: string;
  field: Field;
  old_value: string | null;
  new_value: string | null;
  observation_id: string | null;
  model: string;
  model_reported: string;
  prompt_version: number | null;
  proposal_differs: boolean | null;
  collection_version: number;
  actor_id: string | null;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof DbSchema;
  closeDb: () => Promise<void>;
  /** Подтверждает и правит талоны. */
  owner: Person;
  /** Читает бумагу вторым: подтвердившему слепая проверка запрещена. */
  checker: Person;
  /** Третий: разбирает расхождение. */
  arbiter: Person;
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
  // Каждый подтверждённый машинный талон уходит в перепроверку: жребий в тесте проверял бы
  // `Math.random`, а не правило отбора и не связи, которые отбор заводит.
  process.env.TICKET_OCR_BLIND_CHECK_RATE = '1';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
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
      lastName: 'Аудитов',
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
 * Выполненная заявка с талоном — то, с чего начинается разбор.
 *
 * Ручной талон заводится сразу подтверждённым: `CHECK` в базе не знает неподтверждённых ручных
 * строк, потому что подтверждает их тот же человек, который их и написал.
 */
async function seedTicket(
  suffix: string,
  opts: { origin?: 'ocr' | 'manual' } = {},
): Promise<Ticket> {
  const { db, schema } = ctx;
  const { wasteTicketNumberFuzzy, wasteTicketNumberKey } = await import('@technic/contracts');
  const origin = opts.origin ?? 'ocr';
  // Ключ нормализуется так же, как его пишет воркер: талон с ненормализованным ключом разошёлся бы
  // с любым чтением из-за одного регистра.
  const number = `${suffix}${RUN}`.toUpperCase();
  const [request] = await db
    .insert(schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date('2026-08-17T09:00:00.000Z'),
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
      origin,
      status: origin === 'manual' ? 'confirmed' : 'unconfirmed',
      ...(origin === 'manual' ? { confirmedBy: ctx.owner.id, confirmedAt: new Date() } : {}),
      numberRaw: number,
      numberKey: wasteTicketNumberKey(number),
      numberFuzzy: wasteTicketNumberFuzzy(number),
      issuedOn: ISSUED_ON,
      volumeM3: VOLUME,
      workKind: WORK_KIND,
      addressRaw: '',
      createdBy: ctx.owner.id,
    })
    .returning({ id: schema.wasteTickets.id });
  return { requestId: request!.id, ticketId: ticket!.id, number };
}

/**
 * Машинное чтение одного поля — то самое наблюдение, к которому адресуются решения человека.
 *
 * Модель кладётся в наблюдение, а не в талон, намеренно: человек исправляет работу той модели,
 * которая эту цифру прочитала, и подмена её «последней попыткой талона» записала бы ошибку не той
 * модели (план §1.1). Время задаётся явно: «текущее чтение» выбирается по `created_at`, и два
 * наблюдения с одинаковой отметкой сделали бы выбор жребием.
 */
async function seedReading(
  ticket: Ticket,
  field: Field,
  value: string | null,
  opts: { model: string; promptVersion: number; at: string },
): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sqlRaw`
    INSERT INTO waste_ticket_field_events
      (ticket_id, request_id, event, field, new_value, read_state, source_stage,
       model, model_reported, prompt_version, preprocessing_version,
       primary_model_reported, collection_version, created_at)
    VALUES (${ticket.ticketId}::uuid, ${ticket.requestId}::uuid, 'recognized', ${field},
            ${value}, ${value === null ? 'unreadable' : 'read'}, 'primary',
            ${`proxy/${opts.model}`}, ${opts.model}, ${opts.promptVersion}, 1,
            ${opts.model}, 2, ${opts.at}::timestamptz)
    RETURNING id
  `);
  return rows.rows[0]!.id;
}

/** Разбор целиком: пять чтений одной попытки. */
async function seedReadings(
  ticket: Ticket,
  values: Record<Field, string | null>,
  opts: { model: string; promptVersion?: number; at: string },
): Promise<Record<Field, string>> {
  const one = (field: Field): Promise<string> =>
    seedReading(ticket, field, values[field], {
      model: opts.model,
      promptVersion: opts.promptVersion ?? 3,
      at: opts.at,
    });
  return {
    number: await one('number'),
    issuedOn: await one('issuedOn'),
    volumeM3: await one('volumeM3'),
    workKind: await one('workKind'),
    addressRaw: await one('addressRaw'),
  };
}

/** Чтения талона-заготовки: модель прочитала ровно то, что в нём стоит. */
function seedTicketReadings(
  ticket: Ticket,
  opts: { model: string; at: string },
): Promise<Record<Field, string>> {
  return seedReadings(
    ticket,
    {
      number: ticket.number,
      issuedOn: ISSUED_ON,
      volumeM3: VOLUME,
      workKind: WORK_KIND,
      addressRaw: null,
    },
    opts,
  );
}

interface ProposalValues {
  number: string;
  issuedOn: string | null;
  volumeM3: string | null;
  workKind: 'removal' | 'idle' | 'other';
  addressRaw: string;
}

/**
 * Предложение перераспознавания и связи его чтений.
 *
 * Связь заводится по ВСЕМ пяти полям, а не только по отличавшимся (план §1.2.2): без строки на
 * совпавшее поле его нечем будет назвать `uninformative`, а строка предложения удаляется физически.
 */
async function seedProposal(
  ticket: Ticket,
  values: ProposalValues,
  observations: Record<Field, string>,
  differs: Record<Field, boolean>,
): Promise<void> {
  await ctx.db.insert(ctx.schema.wasteTicketProposals).values({
    ticketId: ticket.ticketId,
    numberRaw: values.number,
    issuedOn: values.issuedOn,
    volumeM3: values.volumeM3,
    workKind: values.workKind,
    addressRaw: values.addressRaw,
  });
  await ctx.db.insert(ctx.schema.wasteTicketProposalObservations).values(
    FIELDS.map((field) => ({
      proposalTicketId: ticket.ticketId,
      field,
      observationId: observations[field],
      differs: differs[field],
    })),
  );
}

/** Журнал талона целиком, в порядке записи. */
async function eventsOf(ticket: Ticket): Promise<EventRow[]> {
  const rows = await ctx.db.execute<EventRow>(sqlRaw`
    SELECT id, event, field, old_value, new_value, observation_id, model, model_reported,
           prompt_version, proposal_differs, collection_version, actor_id
      FROM waste_ticket_field_events
     WHERE ticket_id = ${ticket.ticketId}::uuid
     ORDER BY created_at, field
  `);
  return rows.rows;
}

/** События одного вида, разложенные по полю: у каждого поля событие ровно одно. */
function byField(events: EventRow[], event: string): Record<string, EventRow> {
  const picked: Record<string, EventRow> = {};
  for (const row of events.filter((e) => e.event === event)) {
    expect(picked[row.field], `два события ${event} по полю ${row.field}`).toBeUndefined();
    picked[row.field] = row;
  }
  return picked;
}

/** Человеческие события: всё, что не машинное чтение. */
function humanEvents(events: EventRow[]): EventRow[] {
  return events.filter((e) => e.event !== 'recognized' && e.event !== 'disputed');
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

/** Подтверждение владельцем: оно же отбирает талон в слепую проверку (доля равна единице). */
async function confirm(ticket: Ticket): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/confirm`,
    headers: ctx.owner.auth,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Связи отбора: чем снят `baseline` слепой проверки. */
async function blindLinks(
  ticket: Ticket,
): Promise<{ blind_check_id: string; field: Field; observation_id: string }[]> {
  const rows = await ctx.db.execute<{
    blind_check_id: string;
    field: Field;
    observation_id: string;
  }>(sqlRaw`
    SELECT l.blind_check_id, l.field, l.observation_id
      FROM waste_ticket_blind_check_observations l
      JOIN waste_ticket_blind_checks c ON c.id = l.blind_check_id
     WHERE c.ticket_id = ${ticket.ticketId}::uuid
     ORDER BY l.field
  `);
  return rows.rows;
}

describe.skipIf(!DB_URL)('маршруты разбора талонов: адресация наблюдений', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({ code: MARK, name: `Площадка ${RUN}`, address: 'Волоколамское ш., 71к14' })
      .returning({ id: schema.constructionObjects.id });

    ctx = {
      app,
      db,
      schema,
      closeDb,
      objectId: object!.id,
      owner: null as never,
      checker: null as never,
      arbiter: null as never,
    };
    ctx.owner = await newPerson('owner');
    ctx.checker = await newPerson('checker');
    ctx.arbiter = await newPerson('arbiter');
  }, 240_000);

  afterAll(async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const mine = `SELECT id FROM waste_requests WHERE comment = $1`;
    const myTickets = `SELECT id FROM waste_tickets WHERE request_id IN (${mine})`;
    // Порядок обязателен: ссылка на наблюдение объявлена `RESTRICT`, и один общий `DELETE` снёс бы
    // основание метрики раньше адресованных ему событий. Сначала человеческие события, затем
    // владельцы связей, и только потом сами наблюдения.
    await client.query(
      `DELETE FROM waste_ticket_field_events
        WHERE request_id IN (${mine}) AND observation_id IS NOT NULL`,
      [MARK],
    );
    await client.query(`DELETE FROM waste_ticket_proposals WHERE ticket_id IN (${myTickets})`, [
      MARK,
    ]);
    await client.query(`DELETE FROM waste_ticket_blind_checks WHERE ticket_id IN (${myTickets})`, [
      MARK,
    ]);
    await client.query(`DELETE FROM waste_ticket_field_events WHERE request_id IN (${mine})`, [
      MARK,
    ]);
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [MARK]);
    await client.query(`DELETE FROM construction_objects WHERE code = $1`, [MARK]);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${MARK}-%`]);
    await client.end();
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('сохранение формы без фактических изменений не пишет ни одного события', async () => {
    // Форма талона шлёт все пять полей всегда. Считай маршрут правкой присутствие ключа в теле —
    // и каждое открытие карточки с нажатием «Сохранить» давало бы пять исправлений, из которых
    // настоящих ноль: знаменатель доли исправлений мерил бы работу формы, а не работу человека.
    const ticket = await seedTicket('A');
    await seedTicketReadings(ticket, {
      model: 'gemini-3.1-flash-lite',
      at: '2026-08-18T10:00:00Z',
    });

    const res = await patch(ticket, {
      number: ticket.number,
      issuedOn: ISSUED_ON,
      // Объём приезжает из формы числом, а в базе лежит `numeric` строкой «20.000»: сравнение
      // текстом объявило бы исправлением повторное сохранение того же числа.
      volumeM3: 20,
      workKind: WORK_KIND,
      // Пустой адрес хранится как '', а журналу показывается как `null`. Разница между ними —
      // свойство хранения, а не решение человека.
      addressRaw: '',
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(humanEvents(await eventsOf(ticket))).toHaveLength(0);
  });

  it('правка одного поля пишет одно событие, адресованное последнему чтению этого поля', async () => {
    const ticket = await seedTicket('B');
    // Две попытки по одному полю: страницу перечитали новой конфигурацией конвейера. Исправляют
    // работу той модели, чью цифру человек видел в карточке, — то есть последней.
    await seedReading(ticket, 'volumeM3', VOLUME, {
      model: 'gemini-2.5-flash',
      promptVersion: 2,
      at: '2026-08-18T10:00:00Z',
    });
    const latest = await seedReading(ticket, 'volumeM3', VOLUME, {
      model: 'gemini-3.1-flash-lite',
      promptVersion: 3,
      at: '2026-08-18T12:00:00Z',
    });

    const res = await patch(ticket, { volumeM3: 38 });
    expect(res.statusCode, res.body).toBe(200);

    const edits = humanEvents(await eventsOf(ticket));
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    expect(edit.event).toBe('edited');
    expect(edit.field).toBe('volumeM3');
    expect(edit.old_value).toBe('20.000');
    expect(edit.new_value).toBe('38');
    expect(edit.observation_id).toBe(latest);
    // Модель и версия промпта — снимки ИЗ НАБЛЮДЕНИЯ. Возьми их маршрут из талона (тот помнит
    // только последнюю попытку) или из настроек — журнал приписал бы ошибку конфигурации, которая
    // эту цифру не читала, и когорты в отчёте разъехались бы молча.
    expect(edit.model_reported).toBe('gemini-3.1-flash-lite');
    expect(edit.model).toBe('proxy/gemini-3.1-flash-lite');
    expect(edit.prompt_version).toBe(3);
    expect(edit.actor_id).toBe(ctx.owner.id);
    expect(edit.collection_version).toBe(2);
  });

  it('две правки одного поля подряд адресованы одному наблюдению', async () => {
    // Три правки одного поля — одна ошибка машины, а не три (план §1.1). Считай метрика по
    // событиям, а не по наблюдениям, — человек, дважды поправивший объём, удвоил бы долю ошибок
    // модели, ничего про модель не сообщив.
    const ticket = await seedTicket('C');
    const reading = await seedReading(ticket, 'volumeM3', VOLUME, {
      model: 'gemini-3.1-flash-lite',
      promptVersion: 3,
      at: '2026-08-18T10:00:00Z',
    });

    expect((await patch(ticket, { volumeM3: 30 })).statusCode).toBe(200);
    expect((await patch(ticket, { volumeM3: 31 })).statusCode).toBe(200);

    const edits = humanEvents(await eventsOf(ticket));
    expect(edits).toHaveLength(2);
    expect(edits.map((e) => e.observation_id)).toEqual([reading, reading]);
    // Вторая правка отталкивается от первой: «было» берётся из талона, а не из чтения модели.
    expect(edits.map((e) => [e.old_value, e.new_value])).toEqual([
      ['20.000', '30'],
      ['30.000', '31'],
    ]);
  });

  it('принятие предложения пишет пять событий, адресованных чтениям предложения', async () => {
    const ticket = await seedTicket('D');
    // Чтения предложения сделаны РАНЬШЕ, чем последнее чтение талона: между разбором и решением
    // человека страницу успели перечитать. Именно на этом расходятся «последнее наблюдение» и
    // «наблюдение предложения» — и адресоваться маршрут обязан второму (план §1.1).
    const proposalReadings = await seedTicketReadings(ticket, {
      model: 'proposal-model',
      at: '2026-08-18T10:00:00Z',
    });
    await seedTicketReadings(ticket, { model: 'later-model', at: '2026-08-19T10:00:00Z' });
    await seedProposal(
      ticket,
      {
        number: `${ticket.number}NEW`,
        issuedOn: '2026-08-19',
        volumeM3: '25',
        workKind: WORK_KIND,
        addressRaw: '',
      },
      proposalReadings,
      { number: true, issuedOn: true, volumeM3: true, workKind: false, addressRaw: false },
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/proposal/accept`,
      headers: ctx.owner.auth,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);

    const events = await eventsOf(ticket);
    const accepted = byField(events, 'proposal');
    // Пять, а не три: поле, где предложение повторило талон, — тоже исход наблюдения
    // (`uninformative`), и без своего события он умрёт вместе со строкой предложения (§1.2.2).
    expect(Object.keys(accepted).sort()).toEqual([...FIELDS].sort());
    expect(humanEvents(events)).toHaveLength(5);

    for (const field of FIELDS) {
      const row = accepted[field]!;
      expect(row.observation_id, field).toBe(proposalReadings[field]);
      expect(row.model_reported, field).toBe('proposal-model');
    }
    // Признак отличия копируется из связи в событие: по нему выгрузка разложит принятие на
    // `proposal_accepted` и `uninformative`, когда связей уже не будет.
    expect(accepted.number!.proposal_differs).toBe(true);
    expect(accepted.issuedOn!.proposal_differs).toBe(true);
    expect(accepted.volumeM3!.proposal_differs).toBe(true);
    expect(accepted.workKind!.proposal_differs).toBe(false);
    expect(accepted.addressRaw!.proposal_differs).toBe(false);
    expect([accepted.number!.old_value, accepted.number!.new_value]).toEqual([
      ticket.number,
      `${ticket.number}NEW`,
    ]);
    expect([accepted.workKind!.old_value, accepted.workKind!.new_value]).toEqual([
      WORK_KIND,
      WORK_KIND,
    ]);
  });

  it('исход предложения читается после физического удаления его строки', async () => {
    // Строка предложения удаляется при любом исходе, и связи уходят с ней каскадом. Пиши маршрут
    // событие после удаления — исход унесло бы то самое удаление, ради которого решение и
    // принималось (план §1.2.2).
    const ticket = await seedTicket('E');
    const readings = await seedTicketReadings(ticket, {
      model: 'proposal-model',
      at: '2026-08-18T10:00:00Z',
    });
    await seedProposal(
      ticket,
      {
        number: `${ticket.number}NEW`,
        issuedOn: '2026-08-19',
        volumeM3: '25',
        workKind: WORK_KIND,
        addressRaw: '',
      },
      readings,
      { number: true, issuedOn: true, volumeM3: true, workKind: false, addressRaw: false },
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/proposal/accept`,
      headers: ctx.owner.auth,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);

    const left = await ctx.db.execute<{ n: string }>(sqlRaw`
      SELECT count(*)::text AS n FROM waste_ticket_proposals
       WHERE ticket_id = ${ticket.ticketId}::uuid
    `);
    expect(left.rows[0]!.n).toBe('0');
    const links = await ctx.db.execute<{ n: string }>(sqlRaw`
      SELECT count(*)::text AS n FROM waste_ticket_proposal_observations
       WHERE proposal_ticket_id = ${ticket.ticketId}::uuid
    `);
    expect(links.rows[0]!.n).toBe('0');

    // Исход пережил удаление: пара «тип события + `proposal_differs`» даёт его без связи.
    const accepted = byField(await eventsOf(ticket), 'proposal');
    expect(FIELDS.map((f) => accepted[f]?.proposal_differs)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    // Наблюдения на месте: ссылка объявлена `RESTRICT`, и каскад предложения их не задел.
    const alive = await ctx.db.execute<{ id: string }>(sqlRaw`
      SELECT id FROM waste_ticket_field_events
       WHERE ticket_id = ${ticket.ticketId}::uuid AND event = 'recognized'
    `);
    expect(alive.rows.map((r) => r.id).sort()).toEqual(FIELDS.map((f) => readings[f]).sort());
    expect(FIELDS.map((f) => accepted[f]?.observation_id)).toEqual(FIELDS.map((f) => readings[f]));
  });

  it('отклонение предложения пишет пять событий и уносит строку', async () => {
    // «Человек посмотрел новое чтение и отказался от него» — самый сильный отрицательный сигнал о
    // модели, и до миграции 0210 маршрут не писал о нём ничего: уходила только строка.
    const ticket = await seedTicket('F');
    const readings = await seedTicketReadings(ticket, {
      model: 'proposal-model',
      at: '2026-08-18T10:00:00Z',
    });
    await seedProposal(
      ticket,
      {
        number: `${ticket.number}NEW`,
        issuedOn: '2026-08-19',
        volumeM3: '25',
        workKind: WORK_KIND,
        addressRaw: '',
      },
      readings,
      { number: true, issuedOn: true, volumeM3: true, workKind: false, addressRaw: false },
    );
    // Между чтением и решением человек правит талон ровно до того значения, которое предложила
    // машина: на момент решения они совпадают, но в момент ЧТЕНИЯ поле отличалось. Именно поэтому
    // `differs` хранится связью, а не выводится сравнением значений события (план §1.2.2).
    expect((await patch(ticket, { volumeM3: 25 })).statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/proposal/dismiss`,
      headers: ctx.owner.auth,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);

    const dismissed = byField(await eventsOf(ticket), 'proposal_dismissed');
    expect(Object.keys(dismissed).sort()).toEqual([...FIELDS].sort());
    // «Было» — то, что стоит в талоне, «стало» — то, что предложила машина: талон не меняется, но
    // показать, от чего человек отказался, журнал обязан.
    expect([dismissed.number!.old_value, dismissed.number!.new_value]).toEqual([
      ticket.number,
      `${ticket.number}NEW`,
    ]);
    expect([dismissed.issuedOn!.old_value, dismissed.issuedOn!.new_value]).toEqual([
      ISSUED_ON,
      '2026-08-19',
    ]);
    expect([dismissed.volumeM3!.old_value, dismissed.volumeM3!.new_value]).toEqual([
      '25.000',
      '25.000',
    ]);
    expect(dismissed.volumeM3!.proposal_differs).toBe(true);
    expect(dismissed.workKind!.proposal_differs).toBe(false);
    for (const field of FIELDS)
      expect(dismissed[field]!.observation_id, field).toBe(readings[field]);

    const left = await ctx.db.execute<{ n: string }>(sqlRaw`
      SELECT count(*)::text AS n FROM waste_ticket_proposals
       WHERE ticket_id = ${ticket.ticketId}::uuid
    `);
    expect(left.rows[0]!.n).toBe('0');
  });

  it('отклонение несуществующего предложения не оставляет следа в журнале', async () => {
    // Проверка «предложения нет» перенесена ВНУТРЬ транзакции. Стой она после — маршрут успел бы
    // записать пять событий об отказе от чтения, которого не было, и отчёт получил бы отрицательный
    // сигнал о модели из ничего.
    const ticket = await seedTicket('G');
    await seedTicketReadings(ticket, {
      model: 'gemini-3.1-flash-lite',
      at: '2026-08-18T10:00:00Z',
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/proposal/dismiss`,
      headers: ctx.owner.auth,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(400);

    expect(humanEvents(await eventsOf(ticket))).toHaveLength(0);
  });

  it('подтверждение заводит слепую проверку и связи ровно по трём полям', async () => {
    const ticket = await seedTicket('H');
    const readings = await seedTicketReadings(ticket, {
      model: 'gemini-3.1-flash-lite',
      at: '2026-08-18T10:00:00Z',
    });

    await confirm(ticket);

    const checks = await ctx.db.execute<{ n: string }>(sqlRaw`
      SELECT count(*)::text AS n FROM waste_ticket_blind_checks
       WHERE ticket_id = ${ticket.ticketId}::uuid
    `);
    expect(checks.rows[0]!.n).toBe('1');

    // Три поля, а не пять: перепроверка меряет чтение рукописи, а не разметку бланка. Заведи отбор
    // связь по виду работ и адресу — арбитраж вынес бы вердикт полям, которых проверяющий не видел.
    const links = await blindLinks(ticket);
    expect(links.map((l) => l.field)).toEqual(['issuedOn', 'number', 'volumeM3']);
    expect(links.map((l) => l.observation_id)).toEqual([
      readings.issuedOn,
      readings.number,
      readings.volumeM3,
    ]);
  });

  it('арбитраж адресован baseline-чтению отбора, а не более позднему перераспознаванию', async () => {
    const ticket = await seedTicket('I');
    const baseline = await seedTicketReadings(ticket, {
      model: 'baseline-model',
      at: '2026-08-18T10:00:00Z',
    });
    await confirm(ticket);
    // Между отбором и арбитражем страницу перечитали. «Последнее наблюдение» приписало бы вердикт
    // третьего человека модели, которая сравниваемой цифры не читала (план §1.1).
    const reread = await seedReading(ticket, 'volumeM3', '28', {
      model: 'reread-model',
      promptVersion: 4,
      at: '2026-08-19T10:00:00Z',
    });

    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/blind-check`,
      headers: ctx.checker.auth,
      payload: { number: ticket.number, issuedOn: ISSUED_ON, volumeM3: 28 },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().status).toBe('mismatch');

    const arbitrated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/blind-checks/${read.json().id as string}/arbitrate`,
      headers: ctx.arbiter.auth,
      payload: { resolvedFields: ['volumeM3'], volumeM3: 20 },
    });
    expect(arbitrated.statusCode, arbitrated.body).toBe(200);

    const verdicts = byField(await eventsOf(ticket), 'arbitrated');
    expect(Object.keys(verdicts)).toEqual(['volumeM3']);
    expect(verdicts.volumeM3!.observation_id).toBe(baseline.volumeM3);
    expect(verdicts.volumeM3!.observation_id).not.toBe(reread);
    expect(verdicts.volumeM3!.model_reported).toBe('baseline-model');
    const links = await blindLinks(ticket);
    expect(links.find((l) => l.field === 'volumeM3')!.observation_id).toBe(baseline.volumeM3);
  });

  it('арбитраж с третьим значением пишет baseline против значения арбитра', async () => {
    // Исходов три, а не два: правой бывает машина, правым бывает проверяющий, и бывает, что
    // ошиблись оба (план §3). Третий исход выразим только если в журнале лежат обе величины —
    // снимок машины и то, что назвал арбитр.
    const ticket = await seedTicket('J');
    const baseline = await seedTicketReadings(ticket, {
      model: 'baseline-model',
      at: '2026-08-18T10:00:00Z',
    });
    await confirm(ticket);

    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/tickets/${ticket.ticketId}/blind-check`,
      headers: ctx.checker.auth,
      payload: { number: ticket.number, issuedOn: ISSUED_ON, volumeM3: 28 },
    });
    expect(read.json().status).toBe('mismatch');

    const arbitrated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${ticket.requestId}/blind-checks/${read.json().id as string}/arbitrate`,
      headers: ctx.arbiter.auth,
      // Ни 20 машины, ни 28 проверяющего: на бумаге стоит 33.
      payload: { resolvedFields: ['volumeM3'], volumeM3: 33 },
    });
    expect(arbitrated.statusCode, arbitrated.body).toBe(200);

    const verdict = byField(await eventsOf(ticket), 'arbitrated').volumeM3!;
    // «Было» — снимок машины на момент отбора, а не текущее состояние талона: талон после
    // подтверждения правят, и сравнение с поехавшей величиной меряло бы не то.
    expect(verdict.old_value).toBe('20.000');
    expect(verdict.new_value).toBe('33');
    expect(verdict.observation_id).toBe(baseline.volumeM3);
  });

  it('правка ручного талона пишется без наблюдения и без модели', async () => {
    // Машинного чтения не было вовсе, и в метрики качества модели такая правка не идёт НИКОГДА
    // (план §1.1). Подставь маршрут сюда «последнее чтение по талону» или модель из настроек —
    // ручной ввод считался бы ошибкой модели, которой этой бумаги не показывали.
    const ticket = await seedTicket('K', { origin: 'manual' });

    const res = await patch(ticket, { volumeM3: 38 });
    expect(res.statusCode, res.body).toBe(200);

    const edits = humanEvents(await eventsOf(ticket));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.event).toBe('edited');
    expect(edits[0]!.observation_id).toBeNull();
    expect(edits[0]!.model).toBe('');
    expect(edits[0]!.model_reported).toBe('');
    expect(edits[0]!.prompt_version).toBeNull();
    // Актор при этом назван: кто правил — вопрос к журналу, а не к модели.
    expect(edits[0]!.actor_id).toBe(ctx.owner.id);
  });
});
