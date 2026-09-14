import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestHistoryEntryDto, RequestStatus, WasteRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` после того, как выставлено окружение —
// конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type { buildApp } from '../src/app';

/**
 * Догрузка талонов к выполненной заявке вывоза (ADR 0189): `POST /waste-requests/:id/ticket-files`.
 *
 * Зачем база. Проверяется не форма тела, а то, кому и в каком состоянии заявки ручка отвечает, —
 * а это область (объектная и операторская), статус заявки и живая связь `request_files`. Всё три
 * держатся на настоящих строках: подмены показали бы ровно то, что им велели.
 *
 * Главный случай здесь — внешний исполнитель: ради него решение и принято. У него нет ни права
 * правки заявки, ни права разбора талонов, а бумага, не поспевшая к закрытию, до ADR 0189 стоила
 * ему отката заявки в «Новую» со стиранием факта и всех прежних талонов.
 *
 * Запуск (своя база, поднимается с нуля):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     pnpm --filter @technic/api exec vitest run test/waste-tickets-add.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 *
 * Сканов в фикстурах нет и быть не может: репозиторий публичный, а талон — бумага с адресом
 * площадки. Файлы здесь строки в `files` с тестовым ключом объекта; распознавание выключено
 * (`TICKET_OCR_ENABLED` не выставлен) — постановка задач предмет своего файла.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_waste_tickets_add_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-waste-add-password-123';
const REQUESTS = '/api/v1/waste-requests';
const KEY_PREFIX = 'db-waste-tickets-add/';

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Диспетчер: ведёт заявки, право статуса есть, область не сужена. */
  dispatcher: TestUser;
  /** Внешний исполнитель заявки — тот, ради кого решение и принято. */
  operator: TestUser;
  /** Исполнитель СОСЕДНЕГО контрагента: его операторская область до этой заявки не достаёт. */
  stranger: TestUser;
  objectId: string;
  operatorCounterpartyId: string;
  strangerCounterpartyId: string;
}

let ctx: Ctx;
let fileNo = 0;

/** Контрольная цифра ИНН: справочник проверяет её и на вставке. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

/**
 * Заявка нужного статуса с назначенным исполнителем — прямой вставкой: цикл статусов предмет
 * своих тестов, а здесь важно лишь состояние, в котором ручку спрашивают.
 */
async function newRequest(
  status: RequestStatus,
  opts: { counterpartyId?: string } = {},
): Promise<string> {
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_requests (object_id, request_type, delivery_at, status, created_by,
                                operator_counterparty_id, responsible_name, responsible_phone)
    VALUES (${ctx.objectId}, 'waste_removal', now(), ${sql.raw(`'${status}'::request_status`)},
            ${ctx.dispatcher.id},
            ${opts.counterpartyId ?? ctx.operatorCounterpartyId},
            'Иванов Иван Иванович', '+79990000000')
    RETURNING id`);
  return row.rows[0]!.id;
}

/** Свободный файл того, кто его будет подшивать: чужой ручка не примет (`assertFilesAttachable`). */
async function newFile(owner: TestUser): Promise<string> {
  fileNo += 1;
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`${KEY_PREFIX}${randomUUID()}`}, ${`талон-${fileNo}.pdf`},
            'application/pdf', 1024, 'active', ${owner.id})
    RETURNING id`);
  return row.rows[0]!.id;
}

/** Талон, уже числящийся за заявкой: пул считается по состоянию заявки, а не по телу запроса. */
async function attachTicket(requestId: string, owner: TestUser): Promise<string> {
  const fileId = await newFile(owner);
  await ctx.db.execute(sql`
    INSERT INTO request_files (request_id, file_id, kind)
    VALUES (${requestId}, ${fileId}, 'ticket')`);
  return fileId;
}

async function card(id: string, auth: Auth): Promise<WasteRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as WasteRequestDto;
}

function addTickets(
  id: string,
  ticketFileIds: string[],
  version: number,
  auth: Auth,
): Promise<LightMyRequestResponse> {
  return inject('POST', `${REQUESTS}/${id}/ticket-files`, auth, { ticketFileIds, version });
}

describe.skipIf(!DB_URL)('догрузка талонов к выполненной заявке (ADR 0189)', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
     * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска).
     */
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`WTA-${RUN}`}, ${`Площадка ВМ ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const digits = String(Date.now()).slice(-6);
    const makeCounterparty = async (tag: string, tail: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('operator'::counterparty_type, ${`Оператор ${tag} ${RUN}`},
                ${innOf(`${tail}${digits}`)})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const operatorCounterpartyId = await makeCounterparty('A', '771');
    const strangerCounterpartyId = await makeCounterparty('B', '772');

    // Учётки прямым SQL: форма учётки предмет своего теста, здесь она декорация.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-wta-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const dispatcherUser = await makeUser({ tag: 'disp', role: 'dispatcher' });
    const operatorUser = await makeUser({
      tag: 'oper',
      role: 'operator',
      counterpartyId: operatorCounterpartyId,
    });
    const strangerUser = await makeUser({
      tag: 'strg',
      role: 'operator',
      counterpartyId: strangerCounterpartyId,
    });

    const app = await buildApp();
    await app.ready();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    ctx = {
      app,
      db,
      closeDb,
      dispatcher: await withAuth(dispatcherUser),
      operator: await withAuth(operatorUser),
      stranger: await withAuth(strangerUser),
      objectId,
      operatorCounterpartyId,
      strangerCounterpartyId,
    };
  }, 180_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
  });

  it('исполнитель докладывает талон к своей выполненной заявке', async () => {
    const id = await newRequest('done');
    const first = await attachTicket(id, ctx.operator);
    const before = await card(id, ctx.operator.auth);
    expect(before.tickets).toHaveLength(1);

    const fileId = await newFile(ctx.operator);
    const res = await addTickets(id, [fileId], before.version, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(200);

    const after = res.json() as WasteRequestDto;
    // Бумага пополнилась, а не заменилась: пул общий на заявку (ADR 0024).
    expect(after.tickets.map((t) => t.id).sort()).toEqual([first, fileId].sort());
    // Версия двигается: карточка изменилась, и открытая у соседа вкладка обязана это узнать.
    expect(after.version).toBe(before.version + 1);
    // Статус и факт операция не трогает — она про бумагу.
    expect(after.status).toBe('done');
    expect(after.completion).toBeNull();
  });

  it('догрузка читается в истории заявки своим событием', async () => {
    const id = await newRequest('done');
    const fileId = await newFile(ctx.operator);
    const before = await card(id, ctx.operator.auth);
    expect((await addTickets(id, [fileId], before.version, ctx.operator.auth)).statusCode).toBe(200);

    const res = await inject('GET', `${REQUESTS}/${id}/history`, ctx.dispatcher.auth);
    expect(res.statusCode, res.body).toBe(200);
    const entries = res.json() as RequestHistoryEntryDto[];
    const entry = entries.find((e) => e.kind === 'ticketsAdded');
    expect(entry, 'событие догрузки обязано быть в ленте').toBeTruthy();
    // Имена файлов едут строкой изменения — по ней в ленте видно, ЧТО именно доложили.
    const change = entry!.changes.find((c) => c.field === 'ticketsAdded');
    expect(change?.to).toContain('талон-');
    expect(change?.files?.map((f) => f.id)).toEqual([fileId]);
  });

  it('заявку ведёт не только исполнитель: диспетчер прикладывает бумагу тем же правом', async () => {
    const id = await newRequest('done');
    const fileId = await newFile(ctx.dispatcher);
    const before = await card(id, ctx.dispatcher.auth);
    const res = await addTickets(id, [fileId], before.version, ctx.dispatcher.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as WasteRequestDto).tickets).toHaveLength(1);
  });

  it('до выполнения талон не принимают: он едет вместе с закрытием', async () => {
    const id = await newRequest('confirmed');
    const fileId = await newFile(ctx.operator);
    const before = await card(id, ctx.operator.auth);
    const res = await addTickets(id, [fileId], before.version, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('выполненной заявке');
  });

  it('завершённая заявка бумагу не принимает — сперва возврат в «Выполнена»', async () => {
    const id = await newRequest('completed');
    const fileId = await newFile(ctx.dispatcher);
    const before = await card(id, ctx.dispatcher.auth);
    const res = await addTickets(id, [fileId], before.version, ctx.dispatcher.auth);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('Выполнена');
  });

  it('чужая заявка исполнителю закрыта: операторская область та же, что у всего модуля', async () => {
    const id = await newRequest('done', { counterpartyId: ctx.strangerCounterpartyId });
    const fileId = await newFile(ctx.operator);
    // Версия берётся у того, кому заявка видна: своей карточки у постороннего нет вовсе.
    const before = await card(id, ctx.dispatcher.auth);
    const res = await addTickets(id, [fileId], before.version, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('предел талонов считается по заявке, а не по телу запроса', async () => {
    const id = await newRequest('done');
    // Двадцать — потолок пачки (`MAX_TICKETS_PER_REQUEST`); двадцать первый несут по одному, и
    // схема тела его пропустила бы.
    for (let i = 0; i < 20; i += 1) await attachTicket(id, ctx.operator);
    const fileId = await newFile(ctx.operator);
    const before = await card(id, ctx.operator.auth);
    const res = await addTickets(id, [fileId], before.version, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('Не более');
  });

  it('устаревшая версия карточки уходит в конфликт, а не дописывает бумагу молча', async () => {
    const id = await newRequest('done');
    const before = await card(id, ctx.operator.auth);
    const first = await newFile(ctx.operator);
    expect((await addTickets(id, [first], before.version, ctx.operator.auth)).statusCode).toBe(200);

    const second = await newFile(ctx.operator);
    const res = await addTickets(id, [second], before.version, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(409);
  });

  it('чужой файл не подшивается: подшить можно только своё', async () => {
    const id = await newRequest('done');
    const alien = await newFile(ctx.dispatcher);
    const before = await card(id, ctx.operator.auth);
    const res = await addTickets(id, [alien], before.version, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(400);
  });
});
