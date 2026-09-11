import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hasServiceClosingDocument,
  isServiceClosingFile,
  moscowDateKeyOf,
  SERVICE_FILE_KINDS,
  SERVICE_FILE_PURPOSES,
  type ServiceEstimateFormat,
  type ServiceFileKind,
  type ServiceFilePurpose,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type {
  serviceClosingFileMatchSql,
  serviceHasClosingDocumentSql,
} from '../src/services/service-estimate-revision';

/**
 * ФОРМАТ РЕВИЗИИ ОБЪЁМА РАБОТ СТАЛ НАСТОЯЩИМ — и снаружи от этого не изменилось ничего (Э3 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, решения Р4, Р5).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ЧЕРЕЗ РУЧКИ. Соседний файл
 * (`service-estimate-revision-records.db`) проверяет саму таблицу — ключи, индекс, сброс, — а этот
 * ведёт заявку настоящими путями портала и спрашивает у системы то, что видит снаружи человек:
 * пишется ли строка ревизии каждым предъявлением, отдаёт ли карточка формат, и — главное — какая
 * бумага заявку закрывает. Правило «какая бумага закрывает» живёт в ЧЕТЫРЁХ реализациях: предикат
 * контрактов, запрос перехода в «Решена», SQL-условие очереди «Ожидаются документы» и то же условие
 * в отборе пачки автозакрытия (другой файл, другой процесс). Ни одна из четырёх на моках не
 * существует: расходятся здесь не правила, а SQL, схема и порядок шагов в транзакции.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ВОЛНЫ — ОТРИЦАТЕЛЬНОЕ: планка наследия не тронута. Счёт по построчной заявке
 * закрывает её, как закрывал, очередь ведёт себя как прежде, и ни один сценарий не начал требовать
 * бумагу, которой не требовал. Поэтому половина случаев здесь — про то, что НЕ изменилось.
 *
 * ДОКУМЕНТНАЯ РЕВИЗИЯ СТАВИТСЯ ПРЯМЫМ SQL, И ЭТО НЕ СОКРАЩЕНИЕ ПУТИ. Ручка предъявления документный
 * формат не принимает вовсе — отвечает 422 (§7 плана, шаг 1; отдельный случай ниже это и
 * подтверждает), — а читатели формата выкачены уже сейчас и обязаны быть проверены ДО того, как
 * затвор снимет Э4: иначе первая же документная подача поедет в прод по непроверенному правилу.
 * Строка ревизии — единственное, что подделывается; всё остальное заявка проходит своими ручками.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл гоняет автозакрытие, которое берёт заявки
 * ВСЕЙ базы пачкой, и в общей базе он закрывал бы чужие заявки, а соседи — его. Механизм тот же,
 * что у `service-estimate-revision-records.db`.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/service-estimate-revision.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_estimate_format_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

/** Свой суффикс на прогон: файл переживает повторный запуск на том же кластере. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const INTERNAL_TOKEN = `estimate-format-${RUN}`;
/** День закрытия работ — сегодня по Москве: эту дату проверяет сервер у факта. */
const TODAY = moscowDateKeyOf(new Date());

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
  /** Администратор: заводит то, чего не заводит никто другой. */
  admin: TestUser;
  /** Заказчик — штаб площадки: заводит заявку и видит её аудиторией заявителя. */
  customer: TestUser;
  /** Оператор оргтехники: ведёт справочник, согласует объём работ, смотрит очереди (`finance`). */
  operator: TestUser;
  /** Исполнитель — учётка сервисной компании: объём работ, закрытие работ, документы. */
  service: TestUser;
  objectId: string;
  typeId: string;
  serviceCounterpartyId: string;
  /** Предмет заявок матрицы: они заводятся SQL и аппарата им не нужно (годится отдел). */
  departmentId: string;
  matchSql: typeof serviceClosingFileMatchSql;
  hasSql: typeof serviceHasClosingDocumentSql;
}

let ctx: Ctx;

/**
 * Состояние, которое переживает несколько случаев: документная заявка собирается в одном, а
 * очередь, автозакрытие и срок по ней спрашиваются в следующих. Файл идёт шагами одного сценария —
 * тот же порядок, что у соседей.
 */
const state = {
  /** Построчная заявка, закрытая счётом: ею и проверяется, что планка наследия цела. */
  legacyDone: '',
  /** Документная заявка, доведённая до «Решена»: про неё спрашивают очередь и автозакрытие. */
  documentDone: '',
  /** Её счёт-основание и акт — по ним считается срок автозакрытия. */
  documentActFileId: '',
};

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в сценарии не участвует: документы подшиваются уже загруженными строками `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Внутренний контур: у автозакрытия нет человека, и дверь ему открывает общий секрет.
  process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
}

async function withAdmin(action: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_DB });
  await client.connect();
  try {
    await action(client);
  } finally {
    await client.end();
  }
}

/** Свой адрес на каждый запрос: общий ограничитель считает обращения с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.77.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

/** Карточка заявки; по умолчанию глазами оператора — он видит заявки своей площадки целиком. */
async function card(id: string, auth: Auth = ctx.operator.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function version(id: string, auth: Auth = ctx.operator.auth): Promise<number> {
  return (await card(id, auth)).version;
}

/** Строки ревизий заявки — то, что и есть предмет первого случая. */
async function revisions(
  id: string,
): Promise<{ revision: number; format: string; state: string; total: string | null }[]> {
  const res = await ctx.db.execute<{
    revision: number;
    format: string;
    state: string;
    total: string | null;
  }>(sql`SELECT revision, format, state, total_amount AS total
           FROM service_request_estimate_revisions
          WHERE request_id = ${id}
          ORDER BY revision`);
  return res.rows;
}

async function statusOf(id: string): Promise<string> {
  const res = await ctx.db.execute<{ status: string }>(
    sql`SELECT status::text AS status FROM service_requests WHERE id = ${id}`,
  );
  return res.rows[0]!.status;
}

/** Единица справочника — ручкой оператора: справочник ведёт он. */
let unitNo = 0;
async function makeEquipment(warrantyUntil: string | null = null): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.operator.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS M3145 ${RUN}`,
    inventoryNumber: `ЭФ-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
    warrantyUntil,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/**
 * Заявка, взятая сервисной компанией в работу. Своя единица под каждую заявку: по технике
 * разрешена одна открытая заявка.
 */
async function requestInWork(
  description: string,
  extra: Record<string, unknown> = {},
  warrantyUntil: string | null = null,
): Promise<string> {
  const created = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(warrantyUntil),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  });
  expect(created.statusCode, created.body).toBe(201);
  const dto = (created.json() as { request: ServiceRequestDto }).request;
  const assigned = await inject(
    'PUT',
    `/api/v1/service-requests/${dto.id}/executors`,
    ctx.operator.auth,
    { userIds: [], serviceCounterpartyId: ctx.serviceCounterpartyId, version: dto.version },
  );
  expect(assigned.statusCode, assigned.body).toBe(200);
  const started = await inject(
    'PATCH',
    `/api/v1/service-requests/${dto.id}/start`,
    ctx.service.auth,
    { version: (assigned.json() as { request: ServiceRequestDto }).request.version },
  );
  expect(started.statusCode, started.body).toBe(200);
  return dto.id;
}

/** Построчный объём работ и его предъявление: состав правит своя ручка, тело подачи его не несёт. */
async function submitItems(id: string, unitPrice = 1200): Promise<ServiceRequestDto> {
  const put = await inject('PUT', `/api/v1/service-requests/${id}/estimate`, ctx.service.auth, {
    items: [{ kind: 'service', name: 'Замена ролика', quantity: 1, unitPrice }],
    version: await version(id),
  });
  expect(put.statusCode, put.body).toBe(200);
  const submitted = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/submit`,
    ctx.service.auth,
    { mode: 'items', version: (put.json() as ServiceRequestDto).version },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);
  return submitted.json() as ServiceRequestDto;
}

/** Подпись оператора: статуса она не меняет, а гасит предъявление. */
async function approve(id: string): Promise<void> {
  const res = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/approval`,
    ctx.operator.auth,
    { approved: true, version: await version(id) },
  );
  expect(res.statusCode, res.body).toBe(200);
}

/** Строка загруженного файла: настоящая загрузка идёт в S3, которого в тесте нет. */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`ef/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Закрывающий документ — ручкой исполнителя: роль связи сервер ставит сам (умолчание). */
async function attach(id: string, kind: 'act' | 'invoice' | 'warranty_card'): Promise<string> {
  const fileId = await uploadedFile(ctx.service.id, `${kind}.pdf`);
  const res = await inject('POST', `/api/v1/service-requests/${id}/files`, ctx.service.auth, {
    fileIds: [fileId],
    kind,
  });
  expect(res.statusCode, res.body).toBe(200);
  return fileId;
}

/**
 * Подшивка со заданным возрастом — прямым SQL, и в двух случаях иначе нельзя: роль
 * `estimate_basis` ручки этого выпуска не ставят вовсе (её ставит предъявление документом, то есть
 * Э4), а состарить бумагу на сутки ручкой невозможно в принципе — а срок автозакрытия считается
 * именно от времени подшивки.
 */
async function attachRaw(
  id: string,
  params: {
    kind: ServiceFileKind;
    purpose?: ServiceFilePurpose;
    estimateRevision?: number;
    agedBy?: string;
  },
): Promise<string> {
  const fileId = await uploadedFile(ctx.service.id, `${params.kind}.pdf`);
  await ctx.db.execute(sql`
    INSERT INTO service_request_files (request_id, file_id, kind, purpose, estimate_revision,
                                      attached_by, attached_at)
    VALUES (${id}, ${fileId}, ${params.kind}, ${params.purpose ?? 'closing_evidence'},
            ${params.estimateRevision ?? null}, ${ctx.service.id},
            now() - ${params.agedBy ?? '0 minutes'}::interval)`);
  return fileId;
}

/** Закрытие работ по всему составу: исполнитель предъявляет то, что и было согласовано. */
async function completeWork(id: string) {
  const before = await card(id);
  return inject('PATCH', `/api/v1/service-requests/${id}/complete`, ctx.service.auth, {
    completedOn: TODAY,
    items: before.items.map((item) => ({ id: item.id, performed: true })),
    version: before.version,
  });
}

/**
 * Заявка, поставленная в «Решена» прямым SQL и состаренная. Ручкой такого состояния не собрать
 * намеренно: документная заявка без акта в «Решена» не пускается вовсе (это и проверяет соседний
 * случай), а спросить про неё очередь и отбор пачки нужно именно в «Решена» — оба читают только
 * этот статус. Возраст задаётся здесь же: сутки ожидания ручкой не проживёшь.
 */
async function forceDone(id: string, completedAgo: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests
       SET status = 'done', completed_at = now() - ${completedAgo}::interval,
           status_changed_at = now() - ${completedAgo}::interval
     WHERE id = ${id}`);
}

/** Очередь «Ожидаются документы» — глазами того, кто отвечает за деньги модуля. */
async function awaitingDocumentIds(): Promise<string[]> {
  const res = await inject(
    'GET',
    '/api/v1/service-requests?pageSize=200&awaitingDocuments=true',
    ctx.operator.auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).map((row) => row.id);
}

/** Прогон автозакрытия — той же ручкой, которой его будит worker. */
async function autoClose(): Promise<{ taken: number; closed: number; failed: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/internal/service-requests/auto-close',
    headers: { 'x-internal-token': INTERNAL_TOKEN },
    remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { taken: number; closed: number; failed: number };
}

describe.skipIf(!DB_URL)('формат ревизии объёма работ сквозь ручки (живая схема)', () => {
  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    });
    const own = new pg.Client({ connectionString: OWN_DB });
    await own.connect();
    try {
      // Без расширений миграции не идут: их ставит владелец базы, а не миграция.
      for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
        await own.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
      }
      await applyMigrations(own);
    } finally {
      await own.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    const service = await import('../src/services/service-estimate-revision');

    const passwordHash = await hashPassword(PASSWORD);
    // Учётки, контрагент, площадка и отдел — прямым SQL: форма учётки и справочники предмет своих
    // тестов, здесь они декорации, без которых не разложить три стороны цикла.
    async function makeUser(
      tag: string,
      role: string,
      counterpartyId?: string,
    ): Promise<{ id: string; email: string }> {
      const email = `db-ef-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис формата ${RUN}`}, '7712345678')
      RETURNING id`);
    const serviceCounterpartyId = counterparty.rows[0]!.id;
    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`EF-${RUN}`}, ${`Площадка формата ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const departmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name)
      VALUES (${`EF-${RUN}`}, ${`Отдел формата ${RUN}`})
      RETURNING id`);

    const admin = await makeUser('admin', 'admin');
    const customer = await makeUser('cust', 'shtab');
    const operator = await makeUser('oper', 'shtab');
    const serviceUser = await makeUser('serv', 'operator', serviceCounterpartyId);
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectRow.rows[0]!.id}), (${operator.id}, ${objectRow.rows[0]!.id})`);
    /*
     * Надстройка роли — сервисом, а не вставкой в таблицу: с шагом 1a реформы доступа выдача пишет
     * две таблицы одной транзакцией (`user_role_addons` и `user_grants`), и половина оставила бы
     * оператора без прав там, где права читаются из назначений.
     */
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
    });

    const app = await buildApp();
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

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      customer: await withAuth(customer),
      operator: await withAuth(operator),
      service: await withAuth(serviceUser),
      objectId: objectRow.rows[0]!.id,
      typeId: typeRow.rows[0]!.id,
      serviceCounterpartyId,
      departmentId: departmentRow.rows[0]!.id,
      matchSql: service.serviceClosingFileMatchSql,
      hasSql: service.serviceHasClosingDocumentSql,
    };
  }, 300_000);

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.closeDb();
    if (!DB_URL) return;
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    });
  });

  it('каждое предъявление пишет свою ревизию: прежняя гаснет, активная ровно одна', async () => {
    const id = await requestInWork('Ревизии построчного предъявления');
    await submitItems(id, 1200);
    expect(await revisions(id)).toEqual([
      { revision: 1, format: 'items', state: 'active', total: '1200.00' },
    ]);

    // Возврат в правку ревизию НЕ гасит намеренно (Р5): номер остаётся в заявке, строки на месте.
    const reopened = await inject(
      'PATCH',
      `/api/v1/service-requests/${id}/estimate/reopen`,
      ctx.service.auth,
      { reason: 'Пересчитываем состав', version: await version(id) },
    );
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(await revisions(id)).toEqual([
      { revision: 1, format: 'items', state: 'active', total: '1200.00' },
    ]);

    await submitItems(id, 2500);
    expect(await revisions(id)).toEqual([
      { revision: 1, format: 'items', state: 'superseded', total: '1200.00' },
      { revision: 2, format: 'items', state: 'active', total: '2500.00' },
    ]);
    // Номер действующей ревизии — тот же, что в самой заявке: на этом инварианте стоят все
    // читатели формата, и разойдись он — предикат читал бы формат чужого предъявления.
    expect((await card(id)).estimateRevision).toBe(2);
    /*
     * Действующая ревизия ровно одна — вопросом к базе, а не выводом из списка выше. Все читатели
     * формата берут её запросом «та, что active», и вторая такая строка означала бы, что правило
     * «какая бумага закрывает заявку» отвечает по той ревизии, которую вернёт план запроса.
     */
    const active = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM service_request_estimate_revisions
       WHERE request_id = ${id} AND state = 'active'`);
    expect(active.rows[0]!.n).toBe(1);
  });

  it('гарантийное предъявление пишет формат warranty, и ноль у него — цена, а не незнание', async () => {
    const id = await requestInWork(
      'Гарантийный ремонт',
      { warrantyClaim: { source: 'equipment' } },
      '2099-12-31',
    );
    const submitted = await inject(
      'PATCH',
      `/api/v1/service-requests/${id}/estimate/submit`,
      ctx.service.auth,
      { mode: 'warranty', version: await version(id) },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    // Ноль в снимке — настоящая цена гарантийного ремонта; `null` зарезервирован за документной
    // подачей, где содержимое счёта системе ещё неизвестно (Р2).
    expect(await revisions(id)).toEqual([
      { revision: 1, format: 'warranty', state: 'active', total: '0.00' },
    ]);
  });

  it('карточка и список отдают формат действующей ревизии, а заявителю он не виден', async () => {
    const withRevision = await requestInWork('Формат в карточке');
    await submitItems(withRevision);
    const legacy = await requestInWork('Заявка без ревизий');

    expect((await card(withRevision)).estimateFormat).toBe('items');
    // Заявка, которой объём работ не предъявляли, — это и есть «планка наследия»: формата нет, и
    // читается он как сегодняшний перечень бумаг, а не как «не посчитали».
    expect((await card(legacy)).estimateFormat).toBeNull();

    const list = await inject('GET', '/api/v1/service-requests?pageSize=200', ctx.operator.auth);
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json().items as ServiceRequestDto[];
    expect(rows.find((row) => row.id === withRevision)?.estimateFormat).toBe('items');
    expect(rows.find((row) => row.id === legacy)?.estimateFormat).toBeNull();

    /*
     * Заявителю формат вычтен проекцией аудиторий: он не видит ни строк, ни итога, и слово
     * «Документом (счёт)» означало бы для него только одно — что счёт существует и скрыт.
     */
    expect((await card(withRevision, ctx.customer.auth)).estimateFormat).toBeNull();
  });

  /**
   * ЗАТВОР СМЕНИЛСЯ РУБИЛЬНИКОМ (Э4 снял временный отказ и поставил на его место чтение ключа
   * `service_estimate_document_mode`). Случай оставлен и переписан, а не удалён: он отвечает на
   * вопрос «что видит сервис, когда подача счётом ещё не включена», и ответ обязан быть отказом с
   * объяснением, а не молчаливым приёмом пустой ревизии.
   *
   * Заявление об освобождении при выключенном рубильнике отказом НЕ отвечает — в этом и смысл
   * режима наблюдения: заявление записывается, а подпись собирается обычным путём (исход
   * `observed`). Проверяется это в своём файле волны Э4; здесь важно лишь то, что ревизия от такого
   * предъявления рождается построчной, а не документной.
   */
  it('подача счётом при выключенном рубильнике: 422 и ни одной записанной ревизии', async () => {
    const id = await requestInWork('Затвор документной подачи');
    const fileId = await uploadedFile(ctx.service.id, 'invoice.pdf');

    const document = await inject(
      'PATCH',
      `/api/v1/service-requests/${id}/estimate/submit`,
      ctx.service.auth,
      { mode: 'document', fileIds: [fileId], version: await version(id) },
    );
    expect(document.statusCode, document.body).toBe(422);
    expect(document.json().message).toContain('документом');

    // Отказ вслух, а не молчаливое отбрасывание поля: ни ревизии, ни номера, ни подшитой страницы.
    expect(await revisions(id)).toEqual([]);
    expect((await card(id)).estimateRevision).toBe(0);
  });

  it('планка наследия цела: счёт закрывает построчную заявку, и она уходит из очереди', async () => {
    const id = await requestInWork('Построчная заявка со счётом');
    await submitItems(id);
    await approve(id);

    // Ни акта, ни талона — только счёт, как и до волны.
    await attach(id, 'invoice');
    const completed = await completeWork(id);
    expect(completed.statusCode, completed.body).toBe(200);
    expect((completed.json() as ServiceRequestDto).status).toBe('done');
    expect((await card(id)).estimateFormat).toBe('items');
    // Счёт признан закрывающим и очередью: заявка в «Решена» из неё ушла.
    expect(await awaitingDocumentIds()).not.toContain(id);
    state.legacyDone = id;
  });

  it('очередь ведёт себя как прежде: заявка в «Решена» без бумаг в ней стоит', async () => {
    const id = await requestInWork('Построчная заявка без бумаг');
    await submitItems(id);
    await approve(id);
    /*
     * Заявка-наследие: до планки Н8 внешний ремонт уезжал в «Решена» без бумаги, и ровно такие
     * строки очередь и собирает. Ручкой её сегодня не собрать — переход требует документа, — а
     * предмет проверки именно в том, что отбор очереди от волны не изменился.
     */
    await forceDone(id, '1 hour');
    expect(await awaitingDocumentIds()).toContain(id);

    // Подшитый счёт гасит очередь — у построчной ревизии он закрывающий (В10).
    await attach(id, 'invoice');
    expect(await awaitingDocumentIds()).not.toContain(id);
  });

  it('документную ревизию счёт-основание не закрывает: переход в «Решена» отбит', async () => {
    const id = await requestInWork('Документная подача: счёт не закрывает');
    await submitItems(id);
    await approve(id);
    /*
     * Подделывается ровно одно: формат действующей ревизии. Номер, автор, сумма и подпись остаются
     * теми, что проставили ручки, — иначе отказ пришёл бы от сверки ревизий, а не от планки бумаг,
     * и случай доказывал бы не то, о чём написан.
     */
    await ctx.db.execute(sql`
      UPDATE service_request_estimate_revisions SET format = 'document'
       WHERE request_id = ${id} AND state = 'active'`);
    expect((await card(id)).estimateFormat).toBe('document');
    // Счёт, которым объём работ предъявлен: роль `estimate_basis` и ссылка на свою ревизию.
    await attachRaw(id, {
      kind: 'invoice',
      purpose: 'estimate_basis',
      estimateRevision: 1,
      agedBy: '40 hours',
    });

    const refused = await completeWork(id);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toContain('акта о выполненных работах');
    expect(await statusOf(id)).toBe('in_work');

    state.documentDone = id;
  });

  it('документная заявка в «Решена» держится очередью, и автозакрытие её не берёт', async () => {
    const id = state.documentDone;
    // Та же подделка, что и у очереди наследия, и по той же причине: в «Решена» такую заявку
    // сегодня не пустит ничто, а оба SQL-отбора читают только этот статус.
    await forceDone(id, '25 hours');

    expect(await awaitingDocumentIds()).toContain(id);
    const stats = await autoClose();
    expect(stats.failed).toBe(0);
    /*
     * САМОЕ ДОРОГОЕ МЕСТО ВОЛНЫ. Автозакрытие действует без человека: сочти оно счёт-основание
     * закрывающим, заявка закрылась бы сама — и сразу, потому что счёт подшит ДО работ и срок
     * считался бы от него.
     */
    expect(await statusOf(id)).toBe('done');
  });

  it('срок автозакрытия идёт от акта, а не от счёта-основания, подшитого до работ', async () => {
    const id = state.documentDone;
    // Акт только что. Заявка предъявлена сутки с лишним назад, счёт-основание подшит ещё раньше:
    // считай срок от него — заявка закрылась бы этим же прогоном, не дав суток на возражение.
    state.documentActFileId = await attachRaw(id, { kind: 'act', agedBy: '0 minutes' });
    expect(await awaitingDocumentIds()).not.toContain(id);
    await autoClose();
    expect(await statusOf(id)).toBe('done');

    // Состарили акт — заявка созрела и закрылась сама.
    await ctx.db.execute(sql`
      UPDATE service_request_files SET attached_at = now() - interval '25 hours'
       WHERE request_id = ${id} AND file_id = ${state.documentActFileId}`);
    await autoClose();
    expect(await statusOf(id)).toBe('accepted');

    /*
     * Контроль наследия тем же прогоном: построчная заявка с тем же счётом, подшитым так же до
     * работ, закрывается — и это ровно то, что волна не должна была менять. Разница между двумя
     * заявками одна: формат действующей ревизии.
     */
    const legacy = await requestInWork('Построчная заявка: счёт задаёт срок');
    await submitItems(legacy);
    await approve(legacy);
    await attachRaw(legacy, { kind: 'invoice', agedBy: '40 hours' });
    await forceDone(legacy, '25 hours');
    await autoClose();
    expect(await statusOf(legacy)).toBe('accepted');
  });

  it('подшитый акт закрывает документную заявку переходом в «Решена»', async () => {
    const id = await requestInWork('Документная подача: акт закрывает');
    await submitItems(id);
    await approve(id);
    await ctx.db.execute(sql`
      UPDATE service_request_estimate_revisions SET format = 'document'
       WHERE request_id = ${id} AND state = 'active'`);
    await attachRaw(id, { kind: 'invoice', purpose: 'estimate_basis', estimateRevision: 1 });
    await attachRaw(id, { kind: 'act' });

    /*
     * ЗАКРЫТИЕ БЕЗ ПОСТРОЧНОГО ФАКТА, и отметки здесь не «необязательны», а ЗАПРЕЩЕНЫ (Р8, ветвь Э4):
     * у документной ревизии суммы нет, и присланные строки означали бы итог, которого система не
     * знает. Фикстура держит строки прошлой построчной ревизии — их и нельзя отправлять, иначе
     * ручка ответит 422. Прежняя редакция случая звала общий помощник `completeWork`, который шлёт
     * отметки по всем строкам, и покраснела ровно на этом.
     */
    const completed = await inject(
      'PATCH',
      `/api/v1/service-requests/${id}/complete`,
      ctx.service.auth,
      { completedOn: TODAY, items: [], version: (await card(id)).version },
    );
    expect(completed.statusCode, completed.body).toBe(200);
    expect((completed.json() as ServiceRequestDto).status).toBe('done');
    // Итог по акту у документной заявки не считается: ноль читался бы как «работы бесплатны».
    expect((completed.json() as ServiceRequestDto).completion?.totalAmount).toBeNull();
    expect(await awaitingDocumentIds()).not.toContain(id);
  });

  /**
   * МАТРИЦА ЭКВИВАЛЕНТНОСТИ (§6 плана) — единственное, что держит в согласии две реализации одного
   * правила: предикат контрактов (`isServiceClosingFile` / `hasServiceClosingDocument`) и SQL-условие
   * помощника, которым живут очередь и отбор пачки автозакрытия. Позвать TS-предикат из `WHERE`
   * нечем — оба отбора выбирают МНОЖЕСТВО заявок, у каждой свой формат, — значит копия неизбежна, и
   * разойтись может форма правила. Перечни видов при этом приходят из одних и тех же констант: ловит
   * матрица именно форму.
   *
   * КЛЕТКИ, КОТОРЫХ БАЗА НЕ ХРАНИТ, — тоже ответ, а не пробел: роль `estimate_basis` разрешена только
   * счёту и только со ссылкой на существующую ревизию (`service_request_files_basis_check` и
   * составной ключ). Такая клетка обязана быть «не закрывает» и у предиката — иначе правило
   * опиралось бы на состояние, которое существует лишь в одной из двух редакций.
   */
  it('матрица эквивалентности: TS-предикат и SQL-условие совпадают во всех клетках', async () => {
    const formats: (ServiceEstimateFormat | null)[] = [null, 'items', 'warranty', 'document'];
    const label = (
      format: ServiceEstimateFormat | null,
      kind: ServiceFileKind,
      purpose: ServiceFilePurpose,
    ): string => `формат ${format ?? 'нет'} × ${kind} × ${purpose}`;
    /** Расхождения двух редакций правила — единственное, чему в конце быть запрещено. */
    const mismatches: string[] = [];
    /** Клетки, которые база приняла: их состав сверяется отдельно — см. ниже про роль основания. */
    const stored: string[] = [];
    /** Ответ SQL-редакции по каждой принятой клетке: им же проверяется, что матрица не вырождена. */
    const sqlVerdict = new Map<string, boolean>();

    for (const format of formats) {
      // Заявка матрицы — прямым SQL: предмет здесь не цикл, а одна строка связи файла, и гонять
      // ради каждого формата весь цикл значило бы проверять ручки четыре раза заново.
      const request = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO service_requests (equipment_name, description, created_by,
                                      customer_department_id)
        VALUES (${`Матрица ${RUN}`}, ${`Матрица формата ${format ?? 'нет'}`}, ${ctx.admin.id},
                ${ctx.departmentId})
        RETURNING id`);
      const requestId = request.rows[0]!.id;
      if (format) {
        await ctx.db.execute(sql`
          INSERT INTO service_request_estimate_revisions (request_id, revision, format, state,
                                                          submitted_by)
          VALUES (${requestId}, 1, ${format}, 'active', ${ctx.service.id})`);
      }

      // Пустая заявка: закрывающего документа нет ни при одном формате, и у обеих редакций тоже.
      const empty = await ctx.db.execute<{ has: boolean }>(sql`
        SELECT ${ctx.hasSql(sql`r.id`)} AS has FROM service_requests r WHERE r.id = ${requestId}`);
      expect(empty.rows[0]!.has).toBe(
        hasServiceClosingDocument({ files: [] } as Pick<ServiceRequestDto, 'files'>, format),
      );

      for (const kind of SERVICE_FILE_KINDS) {
        for (const purpose of SERVICE_FILE_PURPOSES) {
          const cell = label(format, kind, purpose);
          const file = { kind, purpose };
          const ts = isServiceClosingFile(file, format);
          const tsExists = hasServiceClosingDocument(
            { files: [file] } as unknown as Pick<ServiceRequestDto, 'files'>,
            format,
          );
          const fileId = await uploadedFile(ctx.admin.id, `${kind}.pdf`);
          try {
            await ctx.db.execute(sql`
              INSERT INTO service_request_files (request_id, file_id, kind, purpose,
                                                estimate_revision, attached_by)
              VALUES (${requestId}, ${fileId}, ${kind}, ${purpose},
                      ${purpose === 'estimate_basis' ? 1 : null}, ${ctx.admin.id})`);
          } catch {
            // Клетки в базе нет — и предикат обязан отвечать «не закрывает»: иначе правило
            // опиралось бы на состояние, которого одна из двух редакций не знает.
            if (ts || tsExists) mismatches.push(`${cell}: нет в базе, а предикат закрывает`);
            continue;
          }
          const answer = await ctx.db.execute<{ match: boolean; has: boolean }>(sql`
            SELECT ${ctx.matchSql({ kind: sql`f.kind`, purpose: sql`f.purpose` }, sql`f.request_id`)}
                     AS match,
                   ${ctx.hasSql(sql`f.request_id`)} AS has
              FROM service_request_files f
             WHERE f.request_id = ${requestId} AND f.file_id = ${fileId}`);
          const row = answer.rows[0]!;
          if (row.match !== ts) {
            mismatches.push(`${cell}: TS ${ts}, SQL ${row.match} (условие на одну связь)`);
          }
          if (row.has !== tsExists) {
            mismatches.push(`${cell}: TS ${tsExists}, SQL ${row.has} (наличие документа)`);
          }
          stored.push(cell);
          sqlVerdict.set(cell, row.has);
          await ctx.db.execute(sql`
            DELETE FROM service_request_files
             WHERE request_id = ${requestId} AND file_id = ${fileId}`);
        }
      }
    }

    expect(mismatches).toEqual([]);

    /*
     * СОСТАВ ПРОЙДЕННЫХ КЛЕТОК СВЕРЯЕТСЯ ТОЧНО, а не «их было много». Клетка, которую база не
     * приняла, уходит из матрицы по ветке `catch` — и без этой сверки матрица прошла бы и в том
     * случае, когда САМАЯ ВАЖНАЯ клетка (счёт в роли основания — то, что и создаст Э4) не
     * материализовалась вовсе: предикат отвечает по ней «не закрывает», то есть отсутствие было бы
     * не отличить от согласия. Правило базы здесь повторено намеренно: роль основания разрешена
     * только счёту и только со ссылкой на существующую ревизию, поэтому у заявки без ревизий таких
     * клеток нет совсем.
     */
    const expectedStored = formats.flatMap((format) =>
      SERVICE_FILE_KINDS.flatMap((kind) =>
        SERVICE_FILE_PURPOSES.filter(
          (purpose) => purpose === 'closing_evidence' || (kind === 'invoice' && format !== null),
        ).map((purpose) => label(format, kind, purpose)),
      ),
    );
    expect(stored).toEqual(expectedStored);

    /*
     * МАТРИЦА НЕ ВЫРОЖДЕНА, и проверяется это ответами SQL-редакции, а не повторением TS-предиката:
     * сойдись обе на «никогда не закрывает», они совпали бы тоже — и матрица ни о чём бы не сказала.
     * Счёт закрывает построчную заявку и не закрывает документную, акт закрывает обе — в этих трёх
     * клетках и состоит вся волна.
     */
    expect(sqlVerdict.get(label('items', 'invoice', 'closing_evidence'))).toBe(true);
    expect(sqlVerdict.get(label('document', 'invoice', 'closing_evidence'))).toBe(false);
    expect(sqlVerdict.get(label('document', 'act', 'closing_evidence'))).toBe(true);
    expect(sqlVerdict.get(label(null, 'invoice', 'closing_evidence'))).toBe(true);
    // Счёт-основание не закрывает заявку ни при каком формате: роль — вторая половина правила.
    expect(sqlVerdict.get(label('items', 'invoice', 'estimate_basis'))).toBe(false);
  });
});
