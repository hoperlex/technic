import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * **ОБЪЁМ РАБОТ ДОКУМЕНТОМ И ОСВОБОЖДЕНИЕ ОТ ПОДПИСИ** — серверная половина этапа Э4 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md` (решения Р2, Р3, Р4, Р7, Р11; два
 * рубильника §7, миграции 0306 и 0307).
 *
 * ЧТО ДОКАЗЫВАЕТ ФАЙЛ.
 *
 *   Д1. Документная подача при ВКЛЮЧЁННОМ рубильнике: строка ревизии формата `document` без строк
 *       объёма работ и без суммы (`NULL`, а не ноль — ноль читался бы как «работы бесплатны»),
 *       страницы счёта с ролью `estimate_basis` и порядком с единицы, и всё это одной транзакцией.
 *   Д2. Тот же запрос при ВЫКЛЮЧЕННОМ рубильнике — 422 и ни одной записи: ключ гасит ВХОД, потому
 *       что старый читатель `purpose` не знает и для него счёт-основание снова закрывающая бумага.
 *   Д3. Освобождение при включённом ключе: подпись БЕЗ АВТОРА, источник `auto`, ожидание подписи НЕ
 *       открыто, строка следа с исходом `applied`, письмо офису ОДНО и называет исход.
 *   Д4. Оно же при выключенном ключе: исход `observed` — предъявление проходит, ожидание подписи
 *       открыто с происхождением `submit`, след записан. Выключенный рубильник не отказ, а
 *       наблюдение (Р3), и именно этим служба узнаёт, сколько заявлений приходит.
 *   Д5. Недогруженный (`pending`) файл основанием не принимается (Н13, Р7), и заявка остаётся без
 *       ревизии: у такого файла объекта в хранилище может не быть вовсе.
 *   Д6. Заявление от чужой стороны — отказ: освобождение заявляет только оператор назначенного
 *       контрагента-сервиса (ответ В1), а не свой поимённый исполнитель, который предъявлять вправе.
 *   Д7. Полный сброс сметы у заявки с поданным счётом — понятный 422, а не ошибка БД: составной
 *       внешний ключ страниц `ON DELETE RESTRICT` иначе уронил бы переназначение пятисоткой.
 *   Д8. Страница-основание не снимается ни автором, ни распорядителем чужими файлами (Р6 п. 1).
 *
 * ПОЧЕМУ БАЗА. Предмет — ровно то, чего на моках не бывает: `CHECK` роли файла и пары «подпись ⇔
 * автор», составные внешние ключи на строку ревизии, частичный уникальный индекс «одна активная
 * ревизия» и порядок вставок, который эти ключи задают. Плюс оба рубильника — строки таблицы
 * `feature_flags`, которые читает сама ручка без кэша.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл переключает ГЛОБАЛЬНЫЕ рубильники и считает
 * письма по заявке, а в общей базе рядом работают соседи — и переключённый ключ менял бы поведение
 * их ручек посреди прогона. Механизм тот же, что у `service-estimate-breakdown`.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5455/postgres \
 *     npx vitest run test/service-estimate-document-submit.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_estimate_document_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-document-password-123';
const REQUESTS = '/api/v1/service-requests';
/** Ящик канала «Ремонт»: он и отправитель писем модуля, и адресат стороны «офис» (§5.2). */
const OFFICE_MAILBOX = `repair-${RUN}@example.invalid`;

type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: TestUser;
  customer: TestUser;
  /** «Ведение» модуля: назначает подрядчика и согласует объём работ. */
  operator: TestUser;
  /** Оператор назначенного контрагента-сервиса: предъявляет объём работ и заявляет освобождение. */
  service: TestUser;
  /** Свой поимённый исполнитель: предъявлять вправе, освобождение заявлять — нет (Д6). */
  executor: TestUser;
  /** Второй контрагент: им проверяется сброс сметы переназначением (Д7). */
  otherCounterpartyId: string;
  objectId: string;
  counterpartyId: string;
  typeId: string;
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
  // S3 здесь не участвует: страницы счёта подшиваются уже загруженными строками `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  /*
   * ПОЧТА ВКЛЮЧЕНА, и это предмет Д3: применённое освобождение адресовано офису, и без включённого
   * контура «письмо ушло одно и называет исход» проверить нечем. Транспорт — журнальный: письма
   * ложатся строками `mail_messages`, никуда не уезжая.
   */
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  process.env.MAIL_ACCOUNT_REPAIR_HOST = 'm.example.invalid';
  process.env.MAIL_ACCOUNT_REPAIR_FROM = `Ремонт <${OFFICE_MAILBOX}>`;
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы по адресу (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function messageOf(res: LightMyRequestResponse): string {
  try {
    return (res.json() as { message?: string }).message ?? '';
  } catch {
    return res.body;
  }
}

async function card(id: string, auth: Auth = ctx.admin.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

/** Рубильник волны: значение читается ручкой без кэша, поэтому `UPDATE` действует сразу. */
async function setFlag(key: string, enabled: boolean): Promise<void> {
  const res = await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${enabled} WHERE key = ${key}`,
  );
  // Ноль обновлённых строк означал бы, что миграция 0307 не накачена, — и весь файл проверял бы
  // тогда выключенное состояние, считая его включённым.
  expect(res.rowCount, `рубильник ${key} не найден`).toBe(1);
}

function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

let unitNo = 0;

/** Своя единица под каждую заявку: по технике разрешена одна открытая заявка. */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `RICOH MP C2011 ${RUN}`,
    inventoryNumber: `DOC-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заявка заказчика, назначенная подрядчику и взятая им в работу. */
async function requestInWork(description: string): Promise<string> {
  const created = await inject('POST', REQUESTS, ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;

  const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.counterpartyId,
    version: await versionOf(id),
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  const started = await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.service.auth, {
    version: await versionOf(id),
  });
  expect(started.statusCode, started.body).toBe(200);
  return id;
}

/**
 * Загруженный файл строкой в `files`: настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — состояние заявки, а не транспорт. Статус — аргумент: им и отличается
 * годное основание от недогруженного (Д5).
 */
async function uploadedFile(
  userId: string,
  filename: string,
  status: 'active' | 'pending' = 'active',
): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`doc/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            ${status}, ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Предъявление объёма работ документом. Ответ возвращается сырым — его разбирают случаи. */
function submitDocument(
  id: string,
  fileIds: string[],
  options: { auth?: Auth; exemption?: { note?: string }; version: number },
): Promise<LightMyRequestResponse> {
  return inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, options.auth ?? ctx.service.auth, {
    mode: 'document',
    fileIds,
    ...(options.exemption ? { exemption: options.exemption } : {}),
    version: options.version,
  });
}

/** Строки объёма работ от лица подрядчика — фикстура построчных случаев. */
async function putEstimate(id: string, total: number): Promise<void> {
  const res = await inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.service.auth, {
    items: [{ kind: 'service', name: 'Ремонт МФУ по месту', quantity: 1, unitPrice: total }],
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

interface RevisionRow {
  revision: number;
  format: string;
  state: string;
  submitted_by: string | null;
  total_amount: string | null;
}

async function revisionsOf(id: string): Promise<RevisionRow[]> {
  const res = await ctx.db.execute<RevisionRow>(sql`
    SELECT revision, format, state, submitted_by, total_amount
      FROM service_request_estimate_revisions
     WHERE request_id = ${id}
     ORDER BY revision`);
  return res.rows;
}

interface BasisRow {
  file_id: string;
  kind: string;
  purpose: string;
  estimate_revision: number | null;
  page_no: number | null;
}

async function filesOf(id: string): Promise<BasisRow[]> {
  const res = await ctx.db.execute<BasisRow>(sql`
    SELECT file_id, kind, purpose, estimate_revision, page_no
      FROM service_request_files
     WHERE request_id = ${id}
     ORDER BY page_no NULLS LAST, attached_at`);
  return res.rows;
}

interface ExemptionRow {
  revision: number;
  declared_by: string | null;
  note: string;
  outcome: string;
}

async function exemptionsOf(id: string): Promise<ExemptionRow[]> {
  const res = await ctx.db.execute<ExemptionRow>(sql`
    SELECT revision, declared_by, note, outcome
      FROM service_request_estimate_exemptions
     WHERE request_id = ${id}
     ORDER BY revision`);
  return res.rows;
}

/** Колонки снимка подписи и ожидания — сырыми: предмет Д3 и Д4 именно в них. */
async function stateOf(id: string): Promise<{
  estimate_revision: number;
  estimate_pending_revision: number | null;
  estimate_pending_source: string | null;
  approved_estimate_revision: number | null;
  estimate_approved_by: string | null;
  estimate_approved_at: string | null;
  estimate_approval_source: string | null;
  estimated_total_amount: string | null;
}> {
  const res = await ctx.db.execute<{
    estimate_revision: number;
    estimate_pending_revision: number | null;
    estimate_pending_source: string | null;
    approved_estimate_revision: number | null;
    estimate_approved_by: string | null;
    estimate_approved_at: string | null;
    estimate_approval_source: string | null;
    estimated_total_amount: string | null;
  }>(sql`
    SELECT estimate_revision, estimate_pending_revision, estimate_pending_source,
           approved_estimate_revision, estimate_approved_by, estimate_approved_at,
           estimate_approval_source, estimated_total_amount
      FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Письма о объёме работ по заявке: своя база, поэтому чужих подписок в выборке нет. */
async function estimateMailsOf(id: string): Promise<{ to_email: string; body_text: string }[]> {
  const res = await ctx.db.execute<{ to_email: string; body_text: string }>(sql`
    SELECT to_email, body_text FROM mail_messages
     WHERE entity_type = 'serviceRequest' AND entity_id = ${id}
       AND kind = 'service_request_estimate'
     ORDER BY created_at`);
  return res.rows;
}

describe.skipIf(!DB_URL)('объём работ документом и освобождение от подписи (Э4)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    await migrate(OWN_DB!);

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-doc-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-DOC ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const otherRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-DOC-2 ${RUN}`},
              ${innOf(`78${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const otherCounterpartyId = otherRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`DOC-${RUN}`}, ${`Тестовая площадка DOC ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const adminUser = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const executor = await makeUser({ tag: 'exec', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${executor.id}, ${objectId})`);

    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], adminUser.id);
    });

    // Набор исполнителя — КАТАЛОЖНЫЙ: Д6 утверждает про право в том виде, в каком оно приезжает
    // держателю в проде.
    const executorGrant = await db.execute<{ id: string }>(
      sql`SELECT id FROM grants WHERE code = 'office_equipment_executor' AND deleted_at IS NULL`,
    );
    const executorGrantId = executorGrant.rows[0]?.id;
    if (!executorGrantId) throw new Error('в базе нет набора «office_equipment_executor»');
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${executor.id}, ${executorGrantId}, ${adminUser.id}, 'manual')`);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    // Событие объёма работ выключено умолчанием (0258): без него письма Д3 не было бы вовсе, и
    // «письмо одно» читалось бы как «писем ноль».
    await db.execute(sql`
      UPDATE module_mail_event_settings SET is_enabled = true WHERE event = 'service_request_estimate'`);

    const app = await buildApp();
    await app.ready();

    const login = async (user: { id: string; email: string }): Promise<TestUser> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextAddress(),
        payload: { email: user.email, password: PASSWORD },
      });
      if (res.statusCode !== 200) throw new Error(`вход ${user.email}: ${res.body}`);
      const token = (res.json() as { accessToken: string }).accessToken;
      return { ...user, auth: { authorization: `Bearer ${token}` } };
    };

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminUser),
      customer: await login(customer),
      operator: await login(operator),
      service: await login(service),
      executor: await login(executor),
      otherCounterpartyId,
      objectId,
      counterpartyId,
      typeId,
    };
  }, 300_000);

  afterAll(async () => {
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
  }, 60_000);

  // ── Д2. Выключенный рубильник гасит вход ──

  describe('Д2. рубильник документного режима выключен', () => {
    it('предъявление документом — 422 и ни одной записи', async () => {
      await setFlag('service_estimate_document_mode', false);
      const id = await requestInWork('Документная подача при выключенном рубильнике');
      const fileId = await uploadedFile(ctx.service.id, `schet-${randomUUID()}.pdf`);

      const res = await submitDocument(id, [fileId], { version: await versionOf(id) });
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('Подача объёма работ документом пока выключена');

      /*
       * НИЧЕГО НЕ ЗАПИСАНО — и это половина утверждения: отказ, оставивший подшитый счёт или
       * поднятую ревизию, был бы хуже пропуска. Файл обязан остаться свободным: его ещё подошьют,
       * когда ключ включат.
       */
      expect(await revisionsOf(id)).toHaveLength(0);
      expect(await filesOf(id)).toHaveLength(0);
      const state = await stateOf(id);
      expect(state.estimate_revision).toBe(0);
      expect(state.estimate_pending_revision).toBeNull();
    });
  });

  // ── Д1. Документная подача при включённом рубильнике ──

  describe('Д1. документная подача пишет ревизию без строк и без суммы', () => {
    let id: string;
    let pages: string[];

    beforeAll(async () => {
      await setFlag('service_estimate_document_mode', true);
      // Освобождение при этом ВЫКЛЮЧЕНО и не заявляется вовсе: данные документа не зависят от
      // способа согласования (блокер 1 третьего ревью) — счёт подают и с обычной подписью.
      await setFlag('service_estimate_exemption', false);
      id = await requestInWork('Объём работ предъявлен счётом');
      pages = [
        await uploadedFile(ctx.service.id, `schet-list-1-${randomUUID()}.pdf`),
        await uploadedFile(ctx.service.id, `schet-list-2-${randomUUID()}.pdf`),
      ];
      const res = await submitDocument(id, pages, { version: await versionOf(id) });
      expect(res.statusCode, res.body).toBe(200);
    });

    it('строка ревизии — формата document, со автором и без суммы', async () => {
      const rows = await revisionsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        revision: 1,
        format: 'document',
        state: 'active',
        submitted_by: ctx.service.id,
      });
      /*
       * СУММЫ НЕТ, И ЭТО `NULL`, А НЕ НОЛЬ (Р2, ответ В5): содержимое счёта системе неизвестно до
       * разбора документа, а записанный ноль читался бы как «работы бесплатны» — ровно та ошибка,
       * которую независимая сверка нашла у прежней редакции плана.
       */
      expect(rows[0]!.total_amount).toBeNull();
    });

    it('строк объёма работ нет, снимок суммы в заявке пуст, ожидание подписи открыто', async () => {
      const state = await stateOf(id);
      expect(state.estimate_revision).toBe(1);
      expect(state.estimated_total_amount).toBeNull();
      // Подпись собирают обычным порядком: освобождения не заявляли.
      expect(state.estimate_pending_revision).toBe(1);
      expect(state.estimate_pending_source).toBe('submit');
      expect(state.approved_estimate_revision).toBeNull();

      const dto = await card(id);
      expect(dto.items).toHaveLength(0);
      expect(dto.estimatedTotalAmount).toBeNull();
      // Формат — поле карточки: портал скрывает им лишние поля окна и показывает «сумма не
      // разобрана» вместо «0 ₽».
      expect(dto.estimateFormat).toBe('document');
      expect(dto.estimatePendingSource).toBe('submit');
      expect(dto.exemption).toBeNull();
    });

    it('страницы счёта подшиты ролью основания и пронумерованы по порядку списка', async () => {
      const rows = await filesOf(id);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.file_id)).toEqual(pages);
      for (const row of rows) {
        // Роль назначает сервер, и только виду `invoice`: `CHECK` базы других сочетаний не примет.
        expect(row.kind).toBe('invoice');
        expect(row.purpose).toBe('estimate_basis');
        expect(row.estimate_revision).toBe(1);
      }
      expect(rows.map((r) => r.page_no)).toEqual([1, 2]);

      // Файлы отмечены активными той же транзакцией: `pending`-строка через сутки уехала бы в
      // уборку вместе с основанием денежного решения.
      const statuses = await ctx.db.execute<{ status: string }>(sql`
        SELECT status FROM files WHERE id = ANY(${sql.param(pages)}::uuid[])`);
      expect(statuses.rows.map((r) => r.status)).toEqual(['active', 'active']);
    });

    it('счёт-основание не снимается ни автором, ни распорядителем чужими файлами (Д8)', async () => {
      for (const auth of [ctx.service.auth, ctx.admin.auth]) {
        const res = await inject('DELETE', `${REQUESTS}/${id}/files/${pages[0]}`, auth);
        expect(res.statusCode, res.body).toBe(422);
        expect(messageOf(res)).toContain('основание денежного решения');
      }
      expect(await filesOf(id)).toHaveLength(2);
    });

    it('письмо о предъявлении ушло офису одно', async () => {
      const letters = await estimateMailsOf(id);
      expect(letters).toHaveLength(1);
      expect(letters[0]!.to_email).toBe(OFFICE_MAILBOX);
      expect(letters[0]!.body_text).toContain('Объём работ: предъявлен');
    });
  });

  // ── Д7. Полный сброс сметы у заявки с поданным счётом ──

  describe('Д7. сброс сметы против RESTRICT', () => {
    it('переназначение другому подрядчику — 422, а не ошибка БД', async () => {
      await setFlag('service_estimate_document_mode', true);
      const id = await requestInWork('Счёт подан, заявку пробуют передать другому');
      const fileId = await uploadedFile(ctx.service.id, `schet-${randomUUID()}.pdf`);
      const submitted = await submitDocument(id, [fileId], { version: await versionOf(id) });
      expect(submitted.statusCode, submitted.body).toBe(200);

      // Висящее предъявление переназначение не пускает само по себе — сперва возвращаем объём
      // работ в правку: предмет случая именно сброс ревизий, а не замок предъявления.
      const reopened = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/reopen`,
        ctx.service.auth,
        {
          reason: 'Счёт подан не тот',
          version: await versionOf(id),
        },
      );
      expect(reopened.statusCode, reopened.body).toBe(200);

      const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
        userIds: [],
        serviceCounterpartyId: ctx.otherCounterpartyId,
        reason: 'Подрядчик не справляется',
        version: await versionOf(id),
      });
      /*
       * 422 С ПОНЯТНЫМ ТЕКСТОМ, А НЕ 500 ОТ ВНЕШНЕГО КЛЮЧА. Цена решения названа вслух: у заявки,
       * по которой объём работ предъявлен счётом, подрядчика больше не меняют — страницы счёта
       * остаются основанием денежного решения, переносить их некуда (сброс обнуляет нумерацию), а
       * снятие роли означало бы обход замка Р6 тем же кодом, ради которого стоит `RESTRICT`.
       */
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('предъявлен счётом');

      // Заявка цела: ни ревизия, ни страницы, ни подрядчик не сдвинулись.
      expect(await revisionsOf(id)).toHaveLength(1);
      expect(await filesOf(id)).toHaveLength(1);
      expect((await card(id)).service?.id).toBe(ctx.counterpartyId);
    });
  });

  // ── Д5. Недогруженный файл основанием не принимается ──

  describe('Д5. pending-файл не бывает основанием', () => {
    it('отказ приходит от общего помощника подшивки, и заявка остаётся без ревизии', async () => {
      await setFlag('service_estimate_document_mode', true);
      const id = await requestInWork('Основанием подсунут недогруженный файл');
      const fileId = await uploadedFile(ctx.service.id, `nedogruz-${randomUUID()}.pdf`, 'pending');

      const res = await submitDocument(id, [fileId], { version: await versionOf(id) });
      /*
       * КОД ОТВЕТА — ТОТ, ЧТО ДАЁТ ОБЩИЙ ПОМОЩНИК (`assertFilesAttachable` с `requireActive`), и
       * своей проверки статуса файла ручка не заводит: второй читатель `files.status` разошёлся бы
       * с первым молча. План называл здесь 422 — это его намерение, а не требование: цена
       * собственной копии правила выше разницы между 400 и 422.
       */
      expect(res.statusCode, res.body).toBe(400);
      expect(messageOf(res)).toContain('Загрузка файла не завершена');
      expect(await revisionsOf(id)).toHaveLength(0);
      expect(await filesOf(id)).toHaveLength(0);
    });
  });

  // ── Д3/Д4. Освобождение от подписи ──

  describe('Д3. освобождение при включённом рубильнике', () => {
    let id: string;

    beforeAll(async () => {
      await setFlag('service_estimate_exemption', true);
      id = await requestInWork('Мелкий ремонт на месте, согласование не требуется');
      // Строками, а не документом: `items` + освобождение — главный сценарий разбора (ответ
      // заказчика 11.09.2026), и документная подача для него не обязательна.
      await putEstimate(id, 7_400);
      const res = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
        mode: 'items',
        exemption: { note: 'Мелкий ремонт на месте при диагностике' },
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it('подпись стоит БЕЗ АВТОРА, источник — auto, ожидание не открыто', async () => {
      const state = await stateOf(id);
      expect(state.estimate_revision).toBe(1);
      expect(state.approved_estimate_revision).toBe(1);
      expect(state.estimate_approved_at).not.toBeNull();
      /*
       * АВТОРА НЕТ И БЫТЬ НЕ МОЖЕТ (Р11): за автопринятие не отвечает ни один человек, а
       * подставленный сюда заявитель освобождения означал бы, что оператор сервиса согласовал смету
       * сам себе. Пару «источник auto ⇔ автора нет» держит `CHECK` базы.
       */
      expect(state.estimate_approved_by).toBeNull();
      expect(state.estimate_approval_source).toBe('auto');
      // Ожидание НЕ открывается: подпись собирать не у кого, а открытое ожидание держало бы заявку
      // в очереди согласования.
      expect(state.estimate_pending_revision).toBeNull();
      expect(state.estimate_pending_source).toBeNull();
      // Снимок суммы у построчной подачи на месте: освобождение отменяет подпись, а не деньги.
      expect(Number(state.estimated_total_amount)).toBe(7_400);
    });

    it('строка следа записана с исходом applied и пояснением', async () => {
      const rows = await exemptionsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        revision: 1,
        declared_by: ctx.service.id,
        note: 'Мелкий ремонт на месте при диагностике',
        outcome: 'applied',
      });
    });

    it('карточка называет исход словами, а журнал — действием', async () => {
      const dto = await card(id);
      expect(dto.exemption).toMatchObject({
        revision: 1,
        by: ctx.service.id,
        outcome: 'applied',
        note: 'Мелкий ремонт на месте при диагностике',
      });
      expect(dto.approval).toMatchObject({ revision: 1, by: null });

      const audit = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
        SELECT metadata FROM audit_log
         WHERE entity_id = ${id} AND action = 'serviceRequest.estimate_submit'`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata).toMatchObject({
        revision: 1,
        format: 'items',
        exemption: { outcome: 'applied' },
      });
    });

    it('письмо одно, адресовано офису и называет исход', async () => {
      /*
       * ПИСЬМО — ОДИН ИЗ ЧЕТЫРЁХ МЕХАНИЗМОВ КОНТРОЛЯ ПОСТФАКТУМ (Р13): подписи не будет вовсе, и
       * служба обязана узнать о деньгах, прошедших мимо неё. Одно, а не два: обычное предъявление
       * ушло бы тому же адресату и обещало бы решение, которого никто не примет.
       */
      const letters = await estimateMailsOf(id);
      expect(letters).toHaveLength(1);
      expect(letters[0]!.to_email).toBe(OFFICE_MAILBOX);
      expect(letters[0]!.body_text).toContain('принят без согласования');
    });
  });

  describe('Д4. освобождение при выключенном рубильнике — наблюдение, а не отказ', () => {
    it('предъявление проходит, ожидание подписи открыто, след записан с исходом observed', async () => {
      await setFlag('service_estimate_exemption', false);
      const id = await requestInWork('Заявление об освобождении до включения рубильника');
      await putEstimate(id, 12_000);

      const res = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
        mode: 'items',
        exemption: {},
        version: await versionOf(id),
      });
      // НЕ отказ: иначе служба не узнала бы, сколько заявлений приходит до включения ключа (Р3).
      expect(res.statusCode, res.body).toBe(200);

      const state = await stateOf(id);
      expect(state.estimate_pending_revision).toBe(1);
      expect(state.estimate_pending_source).toBe('submit');
      expect(state.approved_estimate_revision).toBeNull();
      expect(state.estimate_approval_source).toBeNull();

      const rows = await exemptionsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ revision: 1, outcome: 'observed', note: '' });

      // Письмо — обычное предъявление: подпись по этой заявке собирают как всегда.
      const letters = await estimateMailsOf(id);
      expect(letters).toHaveLength(1);
      expect(letters[0]!.body_text).toContain('Объём работ: предъявлен');
      expect(letters[0]!.body_text).not.toContain('принят без согласования');
    });
  });

  // ── Д6. Заявление от чужой стороны ──

  describe('Д6. освобождение заявляет только оператор сервисной компании', () => {
    it('свой поимённый исполнитель предъявляет, но освобождения не заявляет — 403', async () => {
      await setFlag('service_estimate_exemption', true);
      const created = await inject('POST', REQUESTS, ctx.customer.auth, {
        officeEquipmentId: await makeEquipment(),
        description: 'Подрядчик назначен, ведёт заявку свой сисадмин поимённо',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as { request: ServiceRequestDto }).request.id;

      /*
       * ПОДРЯДЧИК НА ЗАЯВКЕ ЕСТЬ, И ОН ЗДЕСЬ ОБЯЗАТЕЛЕН: без него объём работ не составляют вовсе
       * (`serviceRequestNeedsEstimate` — за работу своего сотрудника не платят), и отказ пришёл бы
       * раньше заявления, ничего про него не доказав. Поимённый исполнитель стоит рядом с
       * подрядчиком — законное сочетание (§5.2 почтовой части): заявку ведёт свой сисадмин, а
       * деньги идут через сервисную компанию.
       */
      const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
        userIds: [ctx.executor.id],
        serviceCounterpartyId: ctx.counterpartyId,
        version: await versionOf(id),
      });
      expect(assigned.statusCode, assigned.body).toBe(200);
      const started = await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.executor.auth, {
        version: await versionOf(id),
      });
      expect(started.statusCode, started.body).toBe(200);

      const put = await inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.executor.auth, {
        items: [{ kind: 'service', name: 'Работа своими силами', quantity: 1, unitPrice: 3_000 }],
        version: await versionOf(id),
      });
      expect(put.statusCode, put.body).toBe(200);

      /*
       * ОТКАЗ ИМЕННО НА ЗАЯВЛЕНИЕ, А НЕ НА ПРЕДЪЯВЛЕНИЕ: тот же человек тем же телом БЕЗ
       * освобождения проходит (ниже). Иначе случай доказывал бы только то, что у него нет права
       * предъявлять, — а он как раз есть.
       */
      const denied = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.executor.auth, {
        mode: 'items',
        exemption: { note: 'Тоже мелкий ремонт' },
        version: await versionOf(id),
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(messageOf(denied)).toContain('оператор назначенной сервисной компании');
      expect(await exemptionsOf(id)).toHaveLength(0);
      expect(await revisionsOf(id)).toHaveLength(0);

      const allowed = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/submit`,
        ctx.executor.auth,
        {
          mode: 'items',
          version: await versionOf(id),
        },
      );
      expect(allowed.statusCode, allowed.body).toBe(200);
      const state = await stateOf(id);
      expect(state.estimate_pending_revision).toBe(1);
      expect(state.estimate_approval_source).toBeNull();
    });
  });
});
