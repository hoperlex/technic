import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_REQUEST_BULK_CONFLICT_CODES,
  SERVICE_REQUEST_BULK_LIMIT,
  type ServiceRequestBulkResultDto,
  type ServiceRequestBulkRowResultDto,
  type ServiceRequestBulkStatusDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * МАССОВЫЕ ДЕЙСТВИЯ НАД ЗАЯВКАМИ — §11.1 (протокол) и §11.2 (операции) плана
 * `docs/office-equipment-bulk-actions-plan.md` по УЖЕ РЕАЛИЗОВАННОМУ пакетному протоколу.
 *
 * ЗАЧЕМ ФАЙЛ. У пачки своего кода ровно столько, сколько нужно, чтобы ошибиться дорого: ключ
 * идемпотентности с отпечатком тела, аренда владельца, транзакция на строку с checkpoint'ом ВНУТРИ
 * неё, частичный результат и построчный отчёт. Ни одно из этих свойств не живёт в одной функции —
 * протокол в `services/service-request-bulk.ts`, разбор операции в маршруте, доменные предикаты в
 * восьми шагах, а инварианты состояния держит база отложенными триггерами. Собранное на моках
 * доказывало бы моки, поэтому здесь живая схема и настоящие ручки.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ §11.2 — «ПАЧКА РАВНА ОДИНОЧНОЙ РУЧКЕ» (Р2, Н9): у каждой операции заводятся
 * две одинаковые заявки-близнеца, над одной работает пачка, над другой — одиночная ручка, и
 * карточки после этого сравниваются целиком, с точностью до времени и номера. Так правило «пакет не
 * пускает того, чего не пустит одиночная ручка, и не делает того, чего она не делает» проверяется
 * состоянием, а не перечислением условий.
 *
 * ЧТО ЗАКРЕПЛЕНО ПО §11.1 (протокол): пятьдесят строк с одной разошедшейся версией; построчные
 * отказы области, стороны и архива; повтор ключа с тем же и с другим телом; гонка двух одинаковых
 * запросов; отказы на весь запрос (пустой список, 51 строка, повтор идентификатора, отсутствие
 * `Idempotency-Key`); читающая ручка состояния и её область.
 *
 * ЧТО ЗАКРЕПЛЕНО ПО §11.2 (операции): по случаю на каждый из девяти вариантов — успех, отказ по
 * предикату, побочный эффект; своя цель заморозки и возобновления у каждой строки; возврат
 * переназначенной из «В работе» в «Новую»; сужение массового `start` до назначенных; отказ на весь
 * запрос у срочности без причины; `403` заявителю с `serviceRequests.delete`; почтовая сводка Р10.
 *
 * ГДЕ ТЕСТ РАСХОДИТСЯ С ПЛАНОМ — сказано на месте, в комментарии случая, и записано под ФАКТИЧЕСКОЕ
 * поведение сервера, а не под желаемое. Такие места помечены словом НАХОДКА.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test` (образец — `service-request-warranty-transitions.db.test.ts`,
 * `office-equipment-move.db.test.ts`): файл СЧИТАЕТ письма, записи аудита и строки журнала пачек по
 * единице, а по общей базе идут параллельные прогоны. База заводится, мигрируется с нуля и сносится
 * в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     pnpm --filter @technic/api exec vitest run test/service-request-bulk.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_bulk_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-service-bulk-password-123';
const REQUESTS = '/api/v1/service-requests';
const BULK = `${REQUESTS}/bulk`;
/** Ящик службы: он и отправитель, и получатель писем модуля — им считается почта пачки. */
const SERVICE_MAILBOX = `repair-${RUN}@example.invalid`;

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
  /** Администратор: заводит строки на чужой площадке и надстройку оператору. */
  admin: TestUser;
  /** «Оргтехника: ведение» — субъект почти всех пачек: `status`, `assign`, `hold`, `urgency`, `delete`. */
  operator: TestUser;
  /** Сервисная компания A: её ход — «принять в работу». */
  service: TestUser;
  /** Сервисная компания B: ею и только ею проверяется чужая сторона в пачке исполнителя. */
  otherService: TestUser;
  /** Заявитель: роль площадки без надстроек — `serviceRequests.delete` есть, массовый режим закрыт. */
  requester: TestUser;
  counterpartyId: string;
  otherCounterpartyId: string;
  /** Площадка оператора. */
  objectId: string;
  /** Чужая площадка: оператор к ней не привязан — строка на ней вне его области. */
  otherObjectId: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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
  /*
   * ПОЧТА ВКЛЮЧЕНА, и это условие проверки, а не декорация: Р10 обещает вместо N писем один digest
   * на пару «адресат + аудитория». Погаси мы почту рубильником — «сводка собрана» и «писем нет
   * вовсе» выглядели бы одинаково, и обещание нельзя было бы ни подтвердить, ни опровергнуть.
   * Внешней доставки при этом нет: транспорт `log`, письма остаются очередью в `mail_messages`.
   */
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  process.env.MAIL_ACCOUNT_REPAIR_HOST = 'm.example.invalid';
  process.env.MAIL_ACCOUNT_REPAIR_FROM = `Ремонт <${SERVICE_MAILBOX}>`;
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Десятизначный ИНН с настоящей контрольной суммой: портал проверяет её при заведении. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Пакетная ручка: ключ идемпотентности — заголовком, как её и зовёт портал (Р7). */
function bulk(body: unknown, auth: Auth = ctx.operator.auth, key: string = randomUUID()) {
  return inject('POST', BULK, auth, body, { 'idempotency-key': key });
}

/** Успешная пачка: HTTP всегда `200`, исходы строк — в отчёте (Р3). */
async function bulkOk(
  body: unknown,
  auth: Auth = ctx.operator.auth,
  key: string = randomUUID(),
): Promise<ServiceRequestBulkResultDto> {
  const res = await bulk(body, auth, key);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestBulkResultDto;
}

async function card(id: string, auth: Auth = ctx.operator.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function version(id: string, auth: Auth = ctx.operator.auth): Promise<number> {
  return (await card(id, auth)).version;
}

/** Пары «идентификатор + версия» по текущему состоянию — то, что портал берёт из списка (Р4). */
async function rowsOf(ids: string[], auth: Auth = ctx.operator.auth) {
  const rows: { id: string; version: number }[] = [];
  for (const id of ids) rows.push({ id, version: await version(id, auth) });
  return rows;
}

/**
 * Заявка БЕЗ АППАРАТА, заведённая «Ведением» на своей площадке.
 *
 * Без аппарата — намеренно: по единице справочника разрешена одна открытая заявка на ремонт, и
 * пятьдесят строк одной пачки означали бы пятьдесят карточек техники, заведённых ради номера. Здесь
 * предмет проверки — протокол, а не справочник; описание у всех заявок одно и то же, чтобы карточки
 * близнецов сравнивались целиком.
 */
async function makeRequest(opts: { objectId?: string; auth?: Auth } = {}): Promise<string> {
  const res = await inject('POST', REQUESTS, opts.auth ?? ctx.operator.auth, {
    objectId: opts.objectId ?? ctx.objectId,
    description: 'Не печатает и мигает лампой',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request.id;
}

/** Назначение подрядчика одиночной ручкой — общий вход всех случаев, где нужен исполнитель. */
async function assignTo(id: string, counterpartyId: string): Promise<void> {
  const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
    userIds: [],
    serviceCounterpartyId: counterpartyId,
    version: await version(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** «Принять в работу» одиночной ручкой от лица назначенного подрядчика. */
async function startAs(id: string, auth: Auth = ctx.service.auth): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/start`, auth, {
    version: await version(id, auth),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * Статус «Решена» — прямым SQL, и это единственное место прямой записи в заявку.
 *
 * Штатный путь туда — согласованный объём работ, подшитый акт и закрытие работ по каждой строке
 * сметы: предмет своего файла (`service-request-warranty-transitions.db.test.ts`), а здесь —
 * декорация, без которой не проверить массовую приёмку. Отложенный
 * `service_requests_executor_present` при этом соблюдён: подрядчик у заявки уже назначен.
 */
async function forceDone(id: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests SET status = 'done', status_changed_at = now(), updated_at = now()
     WHERE id = ${id}`);
}

/** Строка заявки в объёме, которым сравнивается архивирование: карточка снесённой уже недоступна. */
async function rawRow(id: string) {
  const res = await ctx.db.execute<{
    status: string;
    version: number;
    archived: boolean;
    deleted_by: string | null;
  }>(sql`
    SELECT status::text AS status, version, deleted_at IS NOT NULL AS archived, deleted_by
      FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Сколько записей аудита по этим заявкам — счёт повтора пачки (§11.1, случай 5). */
async function auditCount(ids: string[]): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM audit_log
     WHERE entity_type = 'serviceRequest' AND entity_id = ANY(${sql.param(ids)}::text[])`);
  return Number(res.rows[0]?.count ?? '0');
}

/** Метаданные последней записи аудита по заявке — ими проверяется приписка пачки (Р8). */
async function lastAudit(
  id: string,
): Promise<{ action: string; metadata: Record<string, unknown> }> {
  const res = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
    SELECT action, metadata FROM audit_log
     WHERE entity_type = 'serviceRequest' AND entity_id = ${id}
     ORDER BY created_at DESC, action DESC LIMIT 1`);
  const row = res.rows[0];
  if (!row) throw new Error(`В аудите нет ни одной записи по заявке ${id}`);
  return row;
}

/** Письма очереди по этим заявкам: адресат и событие — по ним считается почта пачки (Р10). */
async function lettersOf(ids: string[]) {
  const res = await ctx.db.execute<{ kind: string; to_email: string; entity_id: string }>(sql`
    SELECT kind::text AS kind, to_email::text AS to_email, entity_id::text AS entity_id
      FROM mail_messages
     WHERE entity_type = 'serviceRequest' AND entity_id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY created_at`);
  return res.rows;
}

/** Почтовые НАМЕРЕНИЯ пачки: строки, которые сток строки складывает вместо письма (Р10). */
async function mailIntents(operationId: string) {
  const res = await ctx.db.execute<{
    row_index: number;
    audience: string;
    event: string;
    recipient_email: string;
  }>(sql`
    SELECT row_index, audience, event, recipient_email::text AS recipient_email
      FROM service_request_bulk_mail_items
     WHERE operation_id = ${operationId}
     ORDER BY row_index`);
  return res.rows;
}

/** Письма-сводки пачки в общей очереди: одно на пару «адресат + аудитория» (Р10). */
async function digestsOf(operationId: string) {
  const res = await ctx.db.execute<{ to_email: string; subject: string; body_text: string }>(sql`
    SELECT to_email::text AS to_email, subject, body_text FROM mail_messages
     WHERE kind = 'service_request_bulk_summary' AND entity_id = ${operationId}
     ORDER BY to_email`);
  return res.rows;
}

/**
 * Карточка без всего, что у близнецов различается по построению: адрес строки, её номер и время.
 *
 * «С точностью до времени» из §11.2 записано здесь буквально — и ничего, кроме времени и имени
 * строки, не выбрасывается: любое расхождение пачки с одиночной ручкой в статусе, исполнителях,
 * причинах, версии или флагах обязано уронить сравнение.
 */
function snapshot(dto: ServiceRequestDto): Record<string, unknown> {
  const copy = { ...dto } as Record<string, unknown>;
  for (const key of [
    'id',
    'num',
    'displayNumber',
    'statusChangedAt',
    'createdAt',
    'updatedAt',
    'acceptedAt',
  ]) {
    delete copy[key];
  }
  return copy;
}

/** Исход строки отчёта по её идентификатору: отчёт отсортирован по индексу, а искать удобнее так. */
function rowOf(result: ServiceRequestBulkResultDto, id: string): ServiceRequestBulkRowResultDto {
  const row = result.rows.find((r) => r.id === id);
  if (!row) throw new Error(`В отчёте нет строки ${id}`);
  return row;
}

describe.skipIf(!DB_URL)('массовые действия над заявками: протокол и операции', () => {
  /**
   * Умолчания vitest (5 с на случай, 10 с на хук) этому файлу не годятся: миграции с нуля, пачка из
   * пятидесяти строк с транзакцией на каждую и десятки заявок в фикстурах.
   */
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

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

    const objectRow = async (code: string, name: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${code}, ${name}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const objectId = await objectRow(`BULK-A-${RUN}`, `Площадка пачки A ${RUN}`);
    const otherObjectId = await objectRow(`BULK-B-${RUN}`, `Площадка пачки B ${RUN}`);

    const digitsBase = String(Date.now()).slice(-6);
    const counterparty = async (name: string, inn: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('service'::counterparty_type, ${name}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const counterpartyId = await counterparty(`Сервис-Пачка A ${RUN}`, innOf(`77${digitsBase}0`));
    const otherCounterpartyId = await counterparty(
      `Сервис-Пачка B ${RUN}`,
      innOf(`77${digitsBase}1`),
    );

    /*
     * Учётки — прямым SQL: форма учётки предмет своего теста, а здесь она декорация, без которой не
     * разложить четыре стороны цикла.
     */
    async function makeUser(
      tag: string,
      role: string,
      userCounterpartyId?: string,
    ): Promise<{ id: string; email: string }> {
      const email = `db-bulk-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${userCounterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const operatorUser = await makeUser('oper', 'shtab');
    const requesterUser = await makeUser('req', 'site');
    // Права подрядчика даёт ТИП КОНТРАГЕНТА (ADR 0038), а не роль и не набор.
    const serviceUser = await makeUser('serv', 'operator', counterpartyId);
    const otherServiceUser = await makeUser('serv2', 'operator', otherCounterpartyId);

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${operatorUser.id}, ${objectId}), (${requesterUser.id}, ${objectId})`);

    /*
     * Надстройка «Оргтехника: ведение» — сервисом, а не прямой вставкой: выдача пишет две таблицы
     * одной транзакцией, и половина оставила бы оператора без прав ровно там, где они читаются.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operatorUser.id, ['office_equipment_operator'], adminUser.id);
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
      admin: await withAuth(adminUser),
      operator: await withAuth(operatorUser),
      service: await withAuth(serviceUser),
      otherService: await withAuth(otherServiceUser),
      requester: await withAuth(requesterUser),
      counterpartyId,
      otherCounterpartyId,
      objectId,
      otherObjectId,
    };
  });

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная помешала бы
    // следующему прогону завести её заново.
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  });

  // ────────────────────────────── §11.1. Протокол ──────────────────────────────

  describe('§11.1. Протокол', () => {
    it('1. пятьдесят строк: одна с чужой версией отказывает, сорок девять изменены', async () => {
      /*
       * Базовый случай частичного результата (Р3): порядок отчёта — порядок запроса, HTTP `200`, и
       * одна разошедшаяся версия не отменяет сорока девяти проверенных строк. Операция взята самая
       * дешёвая по побочным эффектам — срочность: она не двигает статус и не требует исполнителей,
       * то есть меряется именно протокол.
       */
      const ids: string[] = [];
      for (let i = 0; i < SERVICE_REQUEST_BULK_LIMIT; i += 1) {
        ids.push(await makeRequest());
      }
      const rows = await rowsOf(ids);
      const staleIndex = 17;
      const staleId = rows[staleIndex]!.id;
      // «Заявка уехала между показом и нажатием» (Н3): версия из списка устарела ровно на один ход.
      rows[staleIndex] = { id: staleId, version: rows[staleIndex]!.version + 1 };

      const result = await bulkOk({
        operation: 'urgency_on',
        rows,
        urgencyReason: 'Приезд комиссии в понедельник',
      });

      expect(result.done).toBe(49);
      expect(result.failed).toBe(1);
      expect(result.rows).toHaveLength(50);
      expect(result.rows.map((r) => r.index)).toEqual([...Array(50).keys()]);
      const failed = rowOf(result, staleId);
      expect(failed).toMatchObject({ index: staleIndex, outcome: 'failed', code: 'version' });
      // Строка субъекту ПОКАЗАНА (отказ случился после общего входа), поэтому номер называется.
      expect(failed.displayNumber).toBe((await card(staleId)).displayNumber);

      // Соседи изменены на самом деле, а не только в отчёте, — и считаются ВСЕ сорок девять, а не
      // три выборочных: отчёт и состояние базы обязаны сойтись до строки.
      const urgent = await ctx.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM service_requests
         WHERE id = ANY(${sql.param(ids)}::uuid[])
           AND is_urgent AND urgency_reason = 'Приезд комиссии в понедельник'`);
      expect(Number(urgent.rows[0]!.count)).toBe(49);
      expect(await card(staleId)).toMatchObject({ isUrgent: false, urgencyReason: '' });
    });

    it('2. строка вне области субъекта отказывает построчно, соседи выполнены', async () => {
      /*
       * Н7 в чистом виде: область — свойство СТРОКИ, и одна чужая площадка не закрывает пачку. Код
       * общий (`forbidden`), номер чужой заявки не называется — иначе отчёт стал бы способом
       * перебирать чужие UUID (§6.2).
       */
      const mine = [await makeRequest(), await makeRequest()];
      const foreign = await makeRequest({
        objectId: ctx.otherObjectId,
        auth: ctx.admin.auth,
      });
      const rows = [
        ...(await rowsOf([mine[0]!])),
        { id: foreign, version: await version(foreign, ctx.admin.auth) },
        ...(await rowsOf([mine[1]!])),
      ];

      const result = await bulkOk({
        operation: 'urgency_on',
        rows,
        urgencyReason: 'Горит инвентаризация',
      });

      expect([result.done, result.failed]).toEqual([2, 1]);
      expect(rowOf(result, foreign)).toMatchObject({
        outcome: 'failed',
        code: 'forbidden',
        displayNumber: null,
      });
      expect((await card(mine[0]!)).isUrgent).toBe(true);
      expect((await card(mine[1]!)).isUrgent).toBe(true);
      expect((await card(foreign, ctx.admin.auth)).isUrgent).toBe(false);
    });

    it('3. чужая сторона отказывает построчно: подрядчик берёт в работу только свои заявки', async () => {
      /*
       * Вторая половина Н7. Сторона у пакетного `start` спрашивается по строке: две заявки назначены
       * компании A, третья — компании B, и она одна получает отказ. Закрой сторона пачку целиком —
       * подрядчик не смог бы принять ни одной из своих.
       */
      const mine = [await makeRequest(), await makeRequest()];
      const foreign = await makeRequest();
      for (const id of mine) await assignTo(id, ctx.counterpartyId);
      await assignTo(foreign, ctx.otherCounterpartyId);

      const rows = [
        ...(await rowsOf([mine[0]!], ctx.service.auth)),
        { id: foreign, version: await version(foreign, ctx.otherService.auth) },
        ...(await rowsOf([mine[1]!], ctx.service.auth)),
      ];
      const result = await bulkOk({ operation: 'start', rows }, ctx.service.auth);

      expect([result.done, result.failed]).toEqual([2, 1]);
      expect(rowOf(result, foreign)).toMatchObject({ outcome: 'failed', code: 'forbidden' });
      expect((await card(mine[0]!)).status).toBe('in_work');
      expect((await card(mine[1]!)).status).toBe('in_work');
      expect((await card(foreign)).status).toBe('new');
    });

    it('4. архивная строка отказывает кодом «нет и не найдена»', async () => {
      const alive = await makeRequest();
      const archived = await makeRequest();
      const archivedRow = { id: archived, version: await version(archived) };
      const removed = await inject('DELETE', `${REQUESTS}/${archived}`, ctx.operator.auth);
      expect(removed.statusCode, removed.body).toBe(200);

      const result = await bulkOk({
        operation: 'urgency_on',
        rows: [archivedRow, ...(await rowsOf([alive]))],
        urgencyReason: 'Разбираем вчерашние дубли',
      });

      expect([result.done, result.failed]).toEqual([1, 1]);
      // Отсутствие и архивность — один код и один текст: существование заявки не раскрывается.
      expect(rowOf(result, archived)).toMatchObject({
        outcome: 'failed',
        code: 'gone',
        displayNumber: null,
      });
      expect((await card(alive)).isUrgent).toBe(true);
    });

    it('5. повтор с тем же ключом и телом возвращает тот же отчёт и не пишет аудита', async () => {
      /*
       * Р7 целиком: повтор после успеха обязан вернуть УСПЕХ, а не пятьдесят отказов `version`.
       * Проверяется тройкой — тот же отчёт слово в слово, ни одной новой записи аудита и ни одного
       * второго применения (версия заявки не сдвинулась).
       */
      const ids = [await makeRequest(), await makeRequest()];
      const rows = await rowsOf(ids);
      const key = randomUUID();
      const body = { operation: 'hold', rows, reason: 'Ждём поставку до понедельника' };

      const first = await bulkOk(body, ctx.operator.auth, key);
      const auditAfterFirst = await auditCount(ids);
      const versionsAfterFirst = await rowsOf(ids);

      const second = await bulkOk(body, ctx.operator.auth, key);

      expect(second).toEqual(first);
      expect(await auditCount(ids)).toBe(auditAfterFirst);
      expect(await rowsOf(ids)).toEqual(versionsAfterFirst);
    });

    it('6. тот же ключ с другим телом — 409 с кодом идемпотентности', async () => {
      const ids = [await makeRequest(), await makeRequest()];
      const rows = await rowsOf(ids);
      const key = randomUUID();
      await bulkOk(
        { operation: 'urgency_on', rows, urgencyReason: 'Первая команда' },
        ctx.operator.auth,
        key,
      );

      const other = await bulk(
        { operation: 'urgency_off', rows: await rowsOf(ids) },
        ctx.operator.auth,
        key,
      );

      expect(other.statusCode, other.body).toBe(409);
      expect(other.json()).toMatchObject({ code: SERVICE_REQUEST_BULK_CONFLICT_CODES.idempotency });
      // Вторая команда не выполнилась ни одной строкой: срочность осталась поставленной.
      expect((await card(ids[0]!)).isUrgent).toBe(true);
    });

    it('7. одновременные одинаковые запросы: один выполняет, второй ждёт отчёта; двойного применения нет', async () => {
      const ids = [await makeRequest(), await makeRequest()];
      const rows = await rowsOf(ids);
      const before = rows.map((r) => r.version);
      const key = randomUUID();
      const body = { operation: 'urgency_on', rows, urgencyReason: 'Две вкладки, одна кнопка' };

      const [a, b] = await Promise.all([
        bulk(body, ctx.operator.auth, key),
        bulk(body, ctx.operator.auth, key),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      /*
       * Ждём любой из двух исходов, названных планом, — «живая аренда» (409 `bulk_in_progress`) и
       * «первый успел закрыть отчёт, второй получил ЕГО же». Оба означают одно применение, и
       * закреплять один было бы закреплением скорости машины: на сегодняшнем коде срабатывает
       * первый (проверено пробой), но исход второго — законный, а не поломка.
       */
      expect([
        [200, 200],
        [200, 409],
      ]).toContainEqual(codes);
      const conflict = [a, b].find((r) => r.statusCode === 409);
      if (conflict) {
        expect(conflict.json()).toMatchObject({
          code: SERVICE_REQUEST_BULK_CONFLICT_CODES.inProgress,
        });
      } else {
        expect(a.json()).toEqual(b.json());
      }

      // Главное: строка применена РОВНО ОДИН раз — версия сдвинулась на единицу.
      const after = (await rowsOf(ids)).map((r) => r.version);
      expect(after).toEqual(before.map((v) => v + 1));
    });

    it('8. пустой список, 51 строка и повтор идентификатора отбиваются запросом целиком', async () => {
      const ids = [await makeRequest(), await makeRequest()];
      const rows = await rowsOf(ids);
      const journalBefore = await ctx.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM service_request_bulk_operations`,
      );

      const empty = await bulk({ operation: 'urgency_off', rows: [] });
      expect(empty.statusCode, empty.body).toBe(400);

      const tooMany = await bulk({
        operation: 'urgency_off',
        rows: [...Array(SERVICE_REQUEST_BULK_LIMIT + 1).keys()].map((i) => ({
          id: randomUUID(),
          version: i,
        })),
      });
      expect(tooMany.statusCode, tooMany.body).toBe(400);

      const duplicated = await bulk({
        operation: 'urgency_on',
        rows: [rows[0]!, rows[1]!, { ...rows[0]! }],
        urgencyReason: 'Строка названа дважды',
      });
      expect(duplicated.statusCode, duplicated.body).toBe(400);

      // Ни одна строка не тронута и журнал пачек не пополнился: отказ запроса — это отказ ДО claim.
      expect(await rowsOf(ids)).toEqual(rows);
      expect((await card(ids[0]!)).isUrgent).toBe(false);
      const journalAfter = await ctx.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM service_request_bulk_operations`,
      );
      expect(journalAfter.rows[0]!.count).toBe(journalBefore.rows[0]!.count);
    });

    it('9. без заголовка Idempotency-Key пачка не принимается', async () => {
      const ids = [await makeRequest()];
      const res = await inject('POST', BULK, ctx.operator.auth, {
        operation: 'urgency_on',
        rows: await rowsOf(ids),
        urgencyReason: 'Ключа не будет',
      });
      expect(res.statusCode, res.body).toBe(400);
      expect((await card(ids[0]!)).isUrgent).toBe(false);

      // Мусор в заголовке отбивается тем же рубежом: ключ — `uuid`, а не свободная строка.
      const junk = await bulk(
        { operation: 'urgency_off', rows: await rowsOf(ids) },
        ctx.operator.auth,
        'не-uuid',
      );
      expect(junk.statusCode, junk.body).toBe(400);
    });

    it('10. GET /bulk/:key отдаёт состояние своей пачки, а на чужой ключ отвечает 404', async () => {
      const ids = [await makeRequest(), await makeRequest()];
      const key = randomUUID();
      const result = await bulkOk(
        { operation: 'urgency_on', rows: await rowsOf(ids), urgencyReason: 'Читаем состояние' },
        ctx.operator.auth,
        key,
      );

      const own = await inject('GET', `${BULK}/${key}`, ctx.operator.auth);
      expect(own.statusCode, own.body).toBe(200);
      const status = own.json() as ServiceRequestBulkStatusDto;
      expect(status).toMatchObject({
        operationId: result.operationId,
        state: 'finished',
        requested: 2,
        processed: 2,
      });
      // Сохранённый отчёт — тот же, что вернул `POST`: иначе «повтор вернул то же самое» было бы
      // правдой только про один из двух способов его прочитать.
      expect(status.result).toEqual(result);

      // Чужой ключ — `404`, а не `403`: существование чужой пачки по известному ключу не
      // показывается (и `admin` здесь не исключение — область у ручки одна, автор).
      const foreign = await inject('GET', `${BULK}/${key}`, ctx.admin.auth);
      expect(foreign.statusCode, foreign.body).toBe(404);
      const unknown = await inject('GET', `${BULK}/${randomUUID()}`, ctx.operator.auth);
      expect(unknown.statusCode, unknown.body).toBe(404);
    });
  });

  // ────────────────────────────── §11.2. Операции ──────────────────────────────

  describe('§11.2. Операции: пачка равна одиночной ручке', () => {
    it('cancel: отмена снимает исполнителей и равна одиночной ручке', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const already = await makeRequest();
      for (const id of [byBulk, bySingle, already]) await assignTo(id, ctx.counterpartyId);
      // Строка, которой ход уже не положен: её отменили заранее одиночной ручкой.
      const killed = await inject('PATCH', `${REQUESTS}/${already}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Отменили заранее',
        version: await version(already),
      });
      expect(killed.statusCode, killed.body).toBe(200);

      const result = await bulkOk({
        operation: 'cancel',
        rows: await rowsOf([byBulk, already]),
        reason: 'Сервис не выезжает до понедельника',
      });
      const single = await inject('PATCH', `${REQUESTS}/${bySingle}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Сервис не выезжает до понедельника',
        version: await version(bySingle),
      });
      expect(single.statusCode, single.body).toBe(200);

      expect([result.done, result.failed]).toEqual([1, 1]);
      /*
       * Отказ «этого хода из этого статуса нет» приезжает кодом `blocked` и С НОМЕРОМ — так и
       * должно быть по §6.2: заявка человеку видна, он сам её выбрал, и отчёт обязан назвать, какая
       * именно строка не пошла. Различает случаи причина отказа (`ServiceAccessDenied.reason`), а
       * не код HTTP: `side` — «эта заявка так не ходит», `scope` — «вам её не видно», и второй
       * по-прежнему остаётся глухим.
       */
      const alreadyRow = rowOf(result, already);
      expect(alreadyRow).toMatchObject({ outcome: 'failed', code: 'blocked' });
      expect(alreadyRow.displayNumber).toBeTruthy();

      const afterBulk = await card(byBulk);
      expect(snapshot(afterBulk)).toEqual(snapshot(await card(bySingle)));
      expect(afterBulk.status).toBe('cancelled');
      // Побочный эффект `reset.executor`: подрядчик снят, поимённых не осталось.
      expect(afterBulk.service).toBeNull();
      expect(afterBulk.executors).toEqual([]);
    });

    it('cancel: письмо каждой строки уходит в сводку пачки, а не отдельным письмом (Р10)', async () => {
      /*
       * Существующий потолок писем считается по тройке «заявка + адрес + час» и от пачки по РАЗНЫМ
       * заявкам не спасает: три отменённые заявки дали бы адресату три обычных письма. Проверяется
       * поэтому именно РАЗНИЦА с одиночной ручкой — единственное место, где пачка ведёт себя иначе,
       * и это разрешено Р10 прямо.
       */
      const ids = [await makeRequest(), await makeRequest(), await makeRequest()];
      const single = await makeRequest();
      for (const id of [...ids, single]) await assignTo(id, ctx.counterpartyId);

      const result = await bulkOk({
        operation: 'cancel',
        rows: await rowsOf(ids),
        reason: 'Площадку закрыли до понедельника',
      });
      expect(result.done).toBe(3);
      const singleRes = await inject('PATCH', `${REQUESTS}/${single}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Площадку закрыли до понедельника',
        version: await version(single),
      });
      expect(singleRes.statusCode, singleRes.body).toBe(200);

      // Намерение сложено по строке — своя запись у каждой пары «строка + адресат + аудитория».
      const intents = await mailIntents(result.operationId);
      expect(intents.length).toBeGreaterThan(0);
      expect([...new Set(intents.map((i) => i.row_index))].sort()).toEqual([0, 1, 2]);

      // Сводка — одна на пару «адресат + аудитория», и адресаты у неё те же, что у одиночного
      // письма: решение «кому и что можно сообщить» остаётся у построителя писем.
      const digests = await digestsOf(result.operationId);
      const singleLetters = (await lettersOf([single])).filter(
        (l) => l.kind === 'service_request_cancelled',
      );
      // Одиночное письмо ушло — иначе сравнение адресатов ниже сошлось бы на двух пустых списках.
      expect(singleLetters.length).toBeGreaterThan(0);
      // Сводок ровно столько, сколько пар «адресат + аудитория» в намерениях: одна на пару.
      const pairs = new Set(intents.map((i) => `${i.recipient_email}|${i.audience}`));
      expect(digests).toHaveLength(pairs.size);
      expect([...new Set(digests.map((d) => d.to_email))].sort()).toEqual(
        [...new Set(singleLetters.map((l) => l.to_email))].sort(),
      );
      // И в каждой сводке — все три заявки: тема называет их число, тело перечисляет номера.
      for (const digest of digests) {
        expect(digest.subject).toContain('— 3');
        for (const id of ids) expect(digest.body_text).toContain((await card(id)).displayNumber);
      }
      // Три заявки — одно письмо адресату вместо трёх: обычных писем по строкам пачки нет вовсе.
      expect((await lettersOf(ids)).filter((l) => l.kind === 'service_request_cancelled')).toEqual(
        [],
      );
    });

    it('hold: заморозка пишет каждой строке её собственный held_from_status', async () => {
      const fromNew = await makeRequest();
      const fromWork = await makeRequest();
      const single = await makeRequest();
      for (const id of [fromWork, single]) await assignTo(id, ctx.counterpartyId);
      await startAs(fromWork);
      await startAs(single);

      const result = await bulkOk({
        operation: 'hold',
        rows: await rowsOf([fromNew, fromWork]),
        reason: 'Нет доступа на объект до среды',
      });
      const held = await inject('PATCH', `${REQUESTS}/${single}/hold`, ctx.operator.auth, {
        reason: 'Нет доступа на объект до среды',
        version: await version(single),
      });
      expect(held.statusCode, held.body).toBe(200);

      expect([result.done, result.failed]).toEqual([2, 0]);
      // Цель возврата у каждой строки СВОЯ и берётся из неё самой, а не из пачки.
      expect(await card(fromNew)).toMatchObject({
        status: 'on_hold',
        heldFromStatus: 'new',
        holdReason: 'Нет доступа на объект до среды',
      });
      expect(await card(fromWork)).toMatchObject({ status: 'on_hold', heldFromStatus: 'in_work' });
      // Пачка равна одиночной ручке: близнец `fromWork` заморожен ею и совпадает целиком.
      expect(snapshot(await card(fromWork))).toEqual(snapshot(await card(single)));

      // Отказ по предикату: в себя заморозка не вкладывается.
      const again = await bulkOk({
        operation: 'hold',
        rows: await rowsOf([fromNew]),
        reason: 'Вторая причина поверх первой',
      });
      expect([again.done, again.failed]).toEqual([0, 1]);
      // Тот же случай, что у отмены: коридор закрыт статусом, а не областью, — значит `blocked`.
      expect(rowOf(again, fromNew).code).toBe('blocked');
    });

    it('resume: возобновление возвращает каждую строку в её собственный статус', async () => {
      const fromNew = await makeRequest();
      const fromWork = await makeRequest();
      const single = await makeRequest();
      const notHeld = await makeRequest();
      for (const id of [fromWork, single]) await assignTo(id, ctx.counterpartyId);
      await startAs(fromWork);
      await startAs(single);
      const holdResult = await bulkOk({
        operation: 'hold',
        rows: await rowsOf([fromNew, fromWork, single]),
        reason: 'Ждём поставку',
      });
      expect(holdResult.done).toBe(3);

      const result = await bulkOk({
        operation: 'resume',
        rows: await rowsOf([fromNew, fromWork, notHeld]),
        comment: 'Поставка пришла',
      });
      const resumed = await inject('PATCH', `${REQUESTS}/${single}/resume`, ctx.operator.auth, {
        comment: 'Поставка пришла',
        version: await version(single),
      });
      expect(resumed.statusCode, resumed.body).toBe(200);

      expect([result.done, result.failed]).toEqual([2, 1]);
      expect(await card(fromNew)).toMatchObject({
        status: 'new',
        heldFromStatus: null,
        holdReason: '',
      });
      expect(await card(fromWork)).toMatchObject({ status: 'in_work', heldFromStatus: null });
      expect(snapshot(await card(fromWork))).toEqual(snapshot(await card(single)));
      // Незамороженной возвращаться некуда — доменное 422 уходит своим текстом в `reason`.
      expect(rowOf(result, notHeld)).toMatchObject({ outcome: 'failed', code: 'blocked' });
      expect(rowOf(result, notHeld).reason).toContain('не отложена');
    });

    it('urgency_on: срочность равна одиночной, а причина спрашивается на весь запрос', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const held = await makeRequest();
      const holdRes = await inject('PATCH', `${REQUESTS}/${held}/hold`, ctx.operator.auth, {
        reason: 'Отложили до среды',
        version: await version(held),
      });
      expect(holdRes.statusCode, holdRes.body).toBe(200);

      // Причина обязательна ТЕЛОМ: валидность запроса не зависит от ещё не прочитанных строк (Р5).
      const noReason = await bulk({
        operation: 'urgency_on',
        rows: await rowsOf([byBulk]),
        urgencyReason: '',
      });
      expect(noReason.statusCode, noReason.body).toBe(400);
      expect((await card(byBulk)).isUrgent).toBe(false);

      const result = await bulkOk({
        operation: 'urgency_on',
        rows: await rowsOf([byBulk, held]),
        urgencyReason: 'Приезд комиссии',
      });
      const single = await inject('PATCH', `${REQUESTS}/${bySingle}/urgency`, ctx.operator.auth, {
        isUrgent: true,
        urgencyReason: 'Приезд комиссии',
        version: await version(bySingle),
      });
      expect(single.statusCode, single.body).toBe(200);

      expect([result.done, result.failed]).toEqual([1, 1]);
      expect(snapshot(await card(byBulk))).toEqual(snapshot(await card(bySingle)));
      // Отложенной срочность не меняют (Р119) — это состояние строки, а не свойство запроса.
      expect(rowOf(result, held)).toMatchObject({ outcome: 'failed', code: 'blocked' });
      expect(rowOf(result, held).displayNumber).toBe((await card(held)).displayNumber);
    });

    it('urgency_off: снятие причины не требует и равно одиночной ручке', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const on = await bulkOk({
        operation: 'urgency_on',
        rows: await rowsOf([byBulk, bySingle]),
        urgencyReason: 'Ставим, чтобы снять',
      });
      expect(on.done).toBe(2);

      const result = await bulkOk({ operation: 'urgency_off', rows: await rowsOf([byBulk]) });
      const single = await inject('PATCH', `${REQUESTS}/${bySingle}/urgency`, ctx.operator.auth, {
        isUrgent: false,
        urgencyReason: '',
        version: await version(bySingle),
      });
      expect(single.statusCode, single.body).toBe(200);

      expect([result.done, result.failed]).toEqual([1, 0]);
      const after = await card(byBulk);
      expect(after).toMatchObject({ isUrgent: false, urgencyReason: '' });
      expect(snapshot(after)).toEqual(snapshot(await card(bySingle)));
    });

    it('assign: переназначение из «В работе» возвращает каждую строку в «Новую»', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const cancelled = await makeRequest();
      for (const id of [byBulk, bySingle]) await assignTo(id, ctx.counterpartyId);
      await startAs(byBulk);
      await startAs(bySingle);
      const killed = await inject('PATCH', `${REQUESTS}/${cancelled}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Заявку отозвали',
        version: await version(cancelled),
      });
      expect(killed.statusCode, killed.body).toBe(200);

      const result = await bulkOk({
        operation: 'assign',
        rows: await rowsOf([byBulk, cancelled]),
        userIds: [],
        serviceCounterpartyId: ctx.otherCounterpartyId,
        reason: 'Раскидываем на второго подрядчика',
        comment: '',
      });
      const single = await inject('PUT', `${REQUESTS}/${bySingle}/executors`, ctx.operator.auth, {
        userIds: [],
        serviceCounterpartyId: ctx.otherCounterpartyId,
        reason: 'Раскидываем на второго подрядчика',
        comment: '',
        version: await version(bySingle),
      });
      expect(single.statusCode, single.body).toBe(200);

      expect([result.done, result.failed]).toEqual([1, 1]);
      const after = await card(byBulk);
      // Правило одиночной ручки, которое пачка не меняет: переназначенная возвращается в «Новую».
      expect(after.status).toBe('new');
      expect(after.service?.id).toBe(ctx.otherCounterpartyId);
      expect(snapshot(after)).toEqual(snapshot(await card(bySingle)));
      expect(rowOf(result, cancelled).outcome).toBe('failed');
    });

    it('start: назначенный сервис начинает только свои «Новые»', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const notAssigned = await makeRequest();
      for (const id of [byBulk, bySingle]) await assignTo(id, ctx.counterpartyId);

      const rows = [
        ...(await rowsOf([byBulk], ctx.service.auth)),
        { id: notAssigned, version: await version(notAssigned) },
      ];
      const result = await bulkOk({ operation: 'start', rows }, ctx.service.auth);
      await startAs(bySingle);

      expect([result.done, result.failed]).toEqual([1, 1]);
      const after = await card(byBulk);
      expect(after.status).toBe('in_work');
      expect(snapshot(after)).toEqual(snapshot(await card(bySingle)));
      // Нераспределённая подрядчику не видна вовсе: код общий, номер не называется.
      expect(rowOf(result, notAssigned)).toMatchObject({
        outcome: 'failed',
        code: 'forbidden',
        displayNumber: null,
      });
      expect((await card(notAssigned)).status).toBe('new');
    });

    it('accept: приёмка работы равна одиночной и не принимает не «Решённую»', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const notDone = await makeRequest();
      for (const id of [byBulk, bySingle]) {
        await assignTo(id, ctx.counterpartyId);
        await forceDone(id);
      }

      const result = await bulkOk({
        operation: 'accept',
        rows: await rowsOf([byBulk, notDone]),
        comment: 'Принимаем всё, что служба закрыла на прошлой неделе',
      });
      const single = await inject('PATCH', `${REQUESTS}/${bySingle}/accept`, ctx.operator.auth, {
        comment: 'Принимаем всё, что служба закрыла на прошлой неделе',
        version: await version(bySingle),
      });
      expect(single.statusCode, single.body).toBe(200);

      expect([result.done, result.failed]).toEqual([1, 1]);
      const after = await card(byBulk);
      expect(after).toMatchObject({ status: 'accepted', acceptanceSource: 'human' });
      expect(snapshot(after)).toEqual(snapshot(await card(bySingle)));
      expect(rowOf(result, notDone).outcome).toBe('failed');
      expect((await card(notDone)).status).toBe('new');
    });

    it('archive: версия у пачки обязательна и сверяется (закрывает Н6)', async () => {
      const byBulk = await makeRequest();
      const bySingle = await makeRequest();
      const stale = await makeRequest();
      const inWork = await makeRequest();
      await assignTo(inWork, ctx.counterpartyId);
      await startAs(inWork);

      const staleRow = { id: stale, version: (await version(stale)) + 3 };
      const result = await bulkOk({
        operation: 'archive',
        rows: [...(await rowsOf([byBulk])), staleRow, ...(await rowsOf([inWork]))],
      });
      const singleVersion = await version(bySingle);
      const single = await inject(
        'DELETE',
        `${REQUESTS}/${bySingle}?version=${singleVersion}`,
        ctx.operator.auth,
      );
      expect(single.statusCode, single.body).toBe(200);

      expect([result.done, result.failed]).toEqual([1, 2]);
      // Карточки снесённой нет — сравниваются строки: пачка сделала ровно то же, что ручка.
      const bulkRow = await rawRow(byBulk);
      expect(bulkRow).toMatchObject({ archived: true, deleted_by: ctx.operator.id });
      expect(bulkRow.version).toBe((await rawRow(bySingle)).version);
      // Присланная версия СВЕРЯЕТСЯ — у пачки всегда, в отличие от одиночной ручки (Н6).
      expect(rowOf(result, stale)).toMatchObject({ outcome: 'failed', code: 'version' });
      expect((await rawRow(stale)).archived).toBe(false);
      // «В работе» уже не сносят: работа по ней началась.
      expect(rowOf(result, inWork).outcome).toBe('failed');
      expect((await rawRow(inWork)).archived).toBe(false);
    });
  });

  describe('§11.2. Допуск к массовому режиму', () => {
    it('заявитель с serviceRequests.delete получает 403 на любую пачку, а не построчные отказы', async () => {
      /*
       * Н11 закрыт продуктовым допуском, а не правом маршрута: у заявителя `serviceRequests.delete`
       * есть (свою «Новую» он архивирует поодиночке), поэтому статический страж его пропускает, а
       * `canUseServiceBulk` отбивает — иначе прямой вызов API вернул бы возможность, которой продукт
       * не давал.
       *
       * Строка в теле — живая и заявителю ВИДНАЯ (его площадка): отказ обязан случиться до того, как
       * пачка прочитает хоть одну заявку, и «нечего было делать» его не объясняет. Завёл её оператор:
       * заявка без аппарата — право `serviceRequests.createWithoutEquipment`, которого у заявителя
       * нет и быть не должно.
       */
      const own = await makeRequest();
      const rows = [{ id: own, version: await version(own, ctx.requester.auth) }];

      const archive = await bulk({ operation: 'archive', rows }, ctx.requester.auth);
      expect(archive.statusCode, archive.body).toBe(403);
      const cancel = await bulk(
        { operation: 'cancel', rows, reason: 'Передумал' },
        ctx.requester.auth,
      );
      expect(cancel.statusCode, cancel.body).toBe(403);
      // Отказ — на весь запрос, ни одна строка не тронута.
      expect((await rawRow(own)).archived).toBe(false);
    });

    it('НАХОДКА: «Оргтехника: ведение» отбивается на start не запросом, а построчно', async () => {
      /*
       * §11.2 обещает: держатель набора «проходит `canUseServiceBulk`, но на `start` получает `403`
       * по точному праву операции». Фактически `canRunServiceBulkOperation('start')` спрашивает
       * `status ∨ execute` (так и записано в Р5 — «как у стража одиночной ручки»), а `status` у
       * «Ведения» есть. Значит второй рубеж он проходит, и отбивает его ТРЕТИЙ — построчный
       * `assertBulkStartAssignment`: «массово в работу берут только назначенные исполнители».
       *
       * Клетка «—» матрицы §4 при этом держится (взять чужую заявку в работу «Ведение» не может), но
       * держится она построчно, и человек, собравший пачку, получает не один понятный отказ, а
       * отчёт, целиком состоящий из отказов, — ровно то, чего §4 обещал избежать («обещать обратное
       * значило бы отправить „Ведение“ собирать пачку, которая целиком вернётся отказами»).
       */
      const assigned = await makeRequest();
      await assignTo(assigned, ctx.counterpartyId);

      const res = await bulk({ operation: 'start', rows: await rowsOf([assigned]) });
      expect(res.statusCode, res.body).toBe(200);
      const result = res.json() as ServiceRequestBulkResultDto;
      expect([result.done, result.failed]).toEqual([0, 1]);
      expect(rowOf(result, assigned)).toMatchObject({ outcome: 'failed', code: 'forbidden' });
      expect((await card(assigned)).status).toBe('new');
    });
  });

  describe('§11.2. Наблюдаемость пачки', () => {
    /**
     * Имя события — ОДНО на пачку и на одиночную ручку (Р6 плана аудита исполнителей). Держится оно
     * тем, что оба отбора ниже идут по этой константе: разъедься имена, один из двух окажется пуст.
     */
    const DENIED = 'serviceRequest.access_denied';

    /** Отказы доступа по этим заявкам — тем же событием, каким на них отвечает журнал портала. */
    async function denials(ids: string[]) {
      const res = await ctx.db.execute<{
        entity_id: string;
        entity_type: string;
        actor_user_id: string;
        metadata: Record<string, unknown>;
      }>(sql`
        SELECT entity_id, entity_type, actor_user_id, metadata FROM audit_log
         WHERE action = ${DENIED} AND entity_id = ANY(${sql.param(ids)}::text[])
         ORDER BY created_at`);
      return res.rows;
    }

    it('аудит построчный, и пачка в нём названа', async () => {
      /*
       * ЧТО ИЗМЕНИЛОСЬ ПРОТИВ ПРЕЖНЕЙ НАХОДКИ. Р8 требует двух вещей сразу: «своя запись у каждой
       * заявки с тем же `action`, что от одиночной ручки» и приписка `bulkOperationId` в её
       * метаданных. Работала только первая половина — `bulkOperationId` не встречался в коде
       * сервера ни разу, и по журналу нельзя было ответить «эти записи сделаны одним движением».
       * Теперь проверяются ОБЕ половины: запись у каждой строки своя, `action` тот же, что у
       * одиночной ручки, прежние метаданные целы, и в каждой названа одна и та же пачка. Отдельной
       * записи «выполнена пачка» по-прежнему нет — Р8 её запрещает прямо: про саму пачку отвечает
       * её таблица, а журнал отвечает на вопрос «что случилось с ЭТОЙ заявкой».
       *
       * ЧТО ОТ НАХОДКИ ОСТАЛОСЬ: `writeAudit` по-прежнему стоит ПОСЛЕ транзакции шага (`holdStep`,
       * `statusStep`, …), то есть окно «состояние зафиксировано, процесс умер до записи аудита»
       * открыто. Втягивание аудита внутрь транзакции строки меняет наблюдаемое поведение всех
       * восьми одиночных ручек и делается отдельно от приписки.
       */
      const first = await makeRequest();
      const second = await makeRequest();
      const single = await makeRequest();

      const result = await bulkOk({
        operation: 'hold',
        rows: await rowsOf([first, second]),
        reason: 'Смотрим, что попадёт в журнал',
      });
      expect(result.done).toBe(2);
      const held = await inject('PATCH', `${REQUESTS}/${single}/hold`, ctx.operator.auth, {
        reason: 'Смотрим, что попадёт в журнал',
        version: await version(single),
      });
      expect(held.statusCode, held.body).toBe(200);

      // Своя запись у КАЖДОЙ строки, и названа в них одна пачка — та, которую вернул отчёт.
      for (const id of [first, second]) {
        const audit = await lastAudit(id);
        expect(audit.action).toBe('serviceRequest.hold');
        expect(audit.metadata).toMatchObject({
          from: 'new',
          reason: 'Смотрим, что попадёт в журнал',
          bulkOperationId: result.operationId,
        });
      }

      /*
       * У одиночной ручки ключа НЕТ ВОВСЕ — и это не придирка к форме: `null` читался бы одинаково
       * и как «сделано поштучно», и как «эта запись написана до Р8», а отсутствие ключа не читается
       * никак, кроме как «пачки здесь не было». Метаданные одиночной ручки при этом прежние до
       * буквы: приписка — единственное, чем пачка от неё отличается.
       */
      const alone = await lastAudit(single);
      expect(alone.action).toBe('serviceRequest.hold');
      expect(Object.keys(alone.metadata)).not.toContain('bulkOperationId');
      expect(alone.metadata).toEqual({ from: 'new', reason: 'Смотрим, что попадёт в журнал' });
    });

    it('отказ доступа в пачке пишется на КАЖДУЮ строку и совпадает с записью одиночной ручки', async () => {
      /*
       * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ (Р6 и критерий К6 плана
       * `docs/office-equipment-executor-access-audit-plan.md`). Журнал отказов заведён ради одного
       * случая — перебора чужих идентификаторов прямым запросом, — и пачка была для него дверью без
       * камеры: отказ строки перехвачен исполнителем и стал строкой отчёта, наружу ушёл `200`, а
       * хук плагина, который пишет журнал остальным ручкам, срабатывает только на отказе, дошедшем
       * до ответа. Три чужих заявки, перебранные ОДНИМ обращением, обязаны оставить три записи.
       *
       * ПОЧЕМУ ТРИ, А НЕ ОДНА. Запись «на пачку» прошла бы случай из одной строки и провалила бы
       * замысел: журнал отвечает на вопрос «кто стучался в ЭТУ заявку», и сводная строка не
       * ответила бы на него ни по одной из трёх.
       *
       * ЧЕТВЁРТАЯ СТРОКА — СВОЯ И УСПЕШНАЯ, и её отсутствие в журнале отказов проверяется наравне с
       * записями: без неё случай зеленел бы и у реализации, пишущей отказ по каждой строке подряд.
       *
       * ОТЧЁТ ПРИ ЭТОМ ПРЕЖНИЙ. Наблюдаемость не имеет права стоить ни исхода строки, ни кода: пачка
       * по-прежнему выполняет свою строку и отчитывается по трём чужим, а не падает целиком.
       */
      const own = await makeRequest();
      const foreign: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        foreign.push(await makeRequest({ objectId: ctx.otherObjectId, auth: ctx.admin.auth }));
      }
      // Пятая заявка — для одиночной ручки: с ней сверяется состав записи, и своей она нужна, чтобы
      // отбор по её адресу не смешал запись пачки с записью ручки.
      const single = await makeRequest({ objectId: ctx.otherObjectId, auth: ctx.admin.auth });

      const rows = [...(await rowsOf([own]))];
      for (const id of foreign) rows.push({ id, version: await version(id, ctx.admin.auth) });

      const result = await bulkOk({
        operation: 'urgency_on',
        rows,
        urgencyReason: 'Перебор чужих номеров одним обращением',
      });
      expect([result.done, result.failed]).toEqual([1, 3]);
      for (const id of foreign) {
        expect(rowOf(result, id)).toMatchObject({ outcome: 'failed', code: 'forbidden' });
      }

      const written = await denials(foreign);
      expect(written.map((r) => r.entity_id).sort()).toEqual([...foreign].sort());
      for (const row of written) {
        expect(row.entity_type).toBe('serviceRequest');
        expect(row.actor_user_id).toBe(ctx.operator.id);
        /*
         * Сверяется ВЕСЬ состав, а не отдельные ключи: забытое поле — это вопрос, на который журнал
         * спустя месяцы не ответит («кем он тогда стучался»), и выборочной проверкой пропажу не
         * заметить. Адрес попытки — пакетная ручка, а не `PATCH /:id/urgency`: обращение было одно,
         * и разбирают его как одно; какой операцией шли строки, помнит `bulkOperationId`.
         */
        expect(row.metadata).toEqual({
          route: 'POST /api/v1/service-requests/bulk',
          reason: 'scope',
          role: 'shtab',
          counterpartyId: null,
          bulkOperationId: result.operationId,
        });
      }

      // Успешная строка журнал отказов не засоряет: событие пишется отказом, а не обходом строк.
      expect(await denials([own])).toEqual([]);

      /*
       * ТА ЖЕ ПОПЫТКА ОДИНОЧНОЙ РУЧКОЙ — эталон, с которым сверяется запись пачки. Страж один и тот
       * же (`requireEditable` внутри шага срочности), поэтому расходиться записям позволено ровно в
       * двух местах: адрес ручки и приписка пачки. Разъедься остальное — сравнение ниже упадёт.
       */
      const alone = await inject('PATCH', `${REQUESTS}/${single}/urgency`, ctx.operator.auth, {
        isUrgent: true,
        urgencyReason: 'Перебор чужих номеров по одному',
        version: await version(single, ctx.admin.auth),
      });
      expect(alone.statusCode, alone.body).toBe(403);

      const aloneRows = await denials([single]);
      expect(aloneRows, JSON.stringify(aloneRows)).toHaveLength(1);
      expect(aloneRows[0]!.actor_user_id).toBe(ctx.operator.id);
      expect(aloneRows[0]!.metadata).toEqual({
        route: 'PATCH /api/v1/service-requests/:id/urgency',
        reason: 'scope',
        role: 'shtab',
        counterpartyId: null,
      });
      // У одиночной ручки приписки НЕТ ВОВСЕ — той же формой, что у записей об успешных строках
      // выше: `null` читался бы и как «сделано поштучно», и как «запись написана до Р8».
      expect(Object.keys(aloneRows[0]!.metadata)).not.toContain('bulkOperationId');
      /*
       * И последнее, ради чего эталон здесь и стоит: одна запись пачки, лишённая своей приписки и
       * своего адреса, обязана совпасть с записью одиночной ручки ЦЕЛИКОМ. Так проверяется «такой
       * же след», а не «похожий»: новое поле, добавленное одному из двух путей, уронит случай.
       */
      const { bulkOperationId: _tag, route: _route, ...common } = written[0]!.metadata;
      const { route: _singleRoute, ...singleCommon } = aloneRows[0]!.metadata;
      expect(common).toEqual(singleCommon);
    });
  });
});
