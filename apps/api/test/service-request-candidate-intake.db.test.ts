import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ПРИЁМ СООБЩЕНИЯ О ТЕХНИКЕ, КОТОРОЙ НЕТ В СПРАВОЧНИКЕ (план
 * `docs/office-equipment-candidate-plan.md`, Э2: Р2, Р5–Р7, Р10, §8).
 *
 * Проверяется ВХОД, а не жизнь кандидата: заведение пары «кандидат + заявка» одной транзакцией,
 * право `officeEquipment.propose`, ось объекта, два первых рубежа защиты от дублей и ключ
 * идемпотентности. Очередь проверки, правка и три решения — Э3 и Э4, и здесь их нет.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Все главные утверждения этого этапа — про СТРОКИ и их отсутствие, и
 * проверить их иначе нечем:
 *
 *   * «одной транзакцией» доказывается тем, что после отказа НЕТ ни кандидата, ни заявки. Мок
 *     ответил бы кодом, а строку оставил;
 *   * рубеж 2 — это уникальный частичный индекс, а не проверка маршрута: гонку двух заявителей
 *     отбивает база, и без базы этой ветки кода не существует вовсе;
 *   * идемпотентность держится вторым уникальным индексом по паре «автор + ключ», а её ответ —
 *     ПРЕЖНЯЯ строка, прочитанная заново;
 *   * рубеж 1 читает живой парк тремя разными способами (своя активная, своя выключенная, чужая),
 *     и «своя» здесь считается предикатом области, а не полем в объекте-заглушке.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: почти каждое утверждение здесь про ОТСУТСТВИЕ
 * строки («отказ не завёл кандидата», «повтор не завёл второго»), а по общей базе параллельно идут
 * другие прогоны, и чужая строка сделала бы такое утверждение ложным. База заводится, мигрируется
 * с нуля и сносится в `afterAll` (образец — `service-request-inactive-equipment.db.test.ts`).
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/service-request-candidate-intake.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_candidate_intake_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-candidate-intake-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

/** Отказ рубежа 1 дословно — по трём редакциям видно, какая именно ветвь ответила. */
const DUP_ACTIVE = 'Аппарат уже в справочнике';
const DUP_INACTIVE = 'снят с эксплуатации';
const DUP_FOREIGN = 'числится за другим подразделением';
const DUP_PENDING = 'уже отправлен на проверку';

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
  /** Администратор: словарь прав целиком — им заводятся и гасятся карточки парка. */
  admin: TestUser;
  /** Рядовой заявитель площадки с выданным `officeEquipment.propose`. */
  requester: TestUser;
  /** Второй такой же — им проверяется гонка двух заявителей (рубеж 2). */
  second: TestUser;
  /** Без права `propose`: та же роль и та же площадка, отличается только набор. */
  plain: TestUser;
  /** Роль отдела: у неё ось площадок отдела (ADR 0062), а заказчиком остаётся её отдел. */
  dept: TestUser;
  objectId: string;
  foreignObjectId: string;
  deptObjectId: string;
  departmentId: string;
  typeId: string;
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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
  headers?: Record<string, string>,
) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Обязательная часть тела заведения: контакт заявителя и описание. */
function body(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    description: 'Не печатает, зажёвывает бумагу',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  };
}

interface CandidateFields {
  serialNumber?: string;
  inventoryNumber?: string;
  objectId?: string;
  declaredModel?: string;
  location?: string;
  comment?: string;
}

/** Шесть заявленных реквизитов (Р7); номера — единственное, что различает случаи. */
function candidate(fields: CandidateFields): Record<string, unknown> {
  return {
    equipmentTypeId: ctx.typeId,
    declaredModel: fields.declaredModel ?? 'Kyocera ECOSYS M3145',
    objectId: fields.objectId ?? ctx.objectId,
    location: fields.location ?? 'каб. 214',
    ...(fields.serialNumber === undefined ? {} : { serialNumber: fields.serialNumber }),
    ...(fields.inventoryNumber === undefined ? {} : { inventoryNumber: fields.inventoryNumber }),
    ...(fields.comment === undefined ? {} : { comment: fields.comment }),
  };
}

/**
 * Отправка сообщения о технике. Ключ идемпотентности — обязательная часть вызова, а не
 * необязательный аргумент: у ветки кандидата без него ручка отвечает 400, и «забыли передать» в
 * тесте выглядело бы отказом по существу.
 */
function propose(
  auth: Auth,
  fields: CandidateFields,
  key: string,
  extra: Record<string, unknown> = {},
) {
  return inject('POST', REQUESTS, auth, body({ equipmentCandidate: candidate(fields), ...extra }), {
    'idempotency-key': key,
  });
}

async function counts(): Promise<{ requests: number; candidates: number }> {
  const res = await ctx.db.execute<{ requests: number; candidates: number }>(sql`
    SELECT (SELECT count(*) FROM service_requests)::int AS requests,
           (SELECT count(*) FROM office_equipment_candidates)::int AS candidates`);
  return res.rows[0]!;
}

/** Строка заявки как она легла в базу: снимки предмета и три колонки области (Р5, Р6). */
async function requestRow(id: string) {
  const res = await ctx.db.execute<{
    equipment_candidate_id: string | null;
    office_equipment_id: string | null;
    equipment_object_id: string | null;
    customer_department_id: string | null;
    equipment_name: string;
    equipment_serial_number: string;
    equipment_inventory_number: string;
    equipment_location: string;
  }>(sql`SELECT * FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

async function candidateRow(id: string) {
  const res = await ctx.db.execute<{
    id: string;
    status: string;
    content_version: number;
    declared_model: string;
    serial_number: string;
    inventory_number: string;
    object_id: string;
    location: string;
    comment: string;
    requester_department_id: string | null;
    created_by: string;
    idempotency_key: string;
    idempotency_fingerprint: string;
    decided_by: string | null;
    result_equipment_id: string | null;
  }>(sql`SELECT * FROM office_equipment_candidates WHERE id = ${id}`);
  return res.rows[0]!;
}

describe.skipIf(!DB_URL)('заявка с сообщением о технике: пара, право, рубежи и ключ', () => {
  /** Карточка парка. Заводит её администратор — у него есть и `write`, и вся область. */
  async function makeEquipment(
    tag: string,
    numbers: { serialNumber?: string; inventoryNumber?: string },
    objectId?: string,
  ): Promise<string> {
    const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
      equipmentTypeId: ctx.typeId,
      name: `МФУ ${tag} ${RUN}`,
      objectId: objectId ?? ctx.objectId,
      location: 'кабинет 214',
      ...numbers,
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

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

    const object = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`CI-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const objectId = await object('main');
    const foreignObjectId = await object('foreign');
    const deptObjectId = await object('dept');
    const departmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name) VALUES (${`CI-D-${RUN}`}, ${`Отдел ${RUN}`})
      RETURNING id`);
    const departmentId = departmentRow.rows[0]!.id;
    // Площадка отдела (ADR 0062) — вторая ось: по ней роль отдела и сообщает о технике.
    await db.execute(sql`
      INSERT INTO department_construction_objects (department_id, construction_object_id)
      VALUES (${departmentId}, ${deptObjectId})`);

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-ci-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const requester = await makeUser('requester', 'shtab');
    const second = await makeUser('second', 'shtab');
    const plain = await makeUser('plain', 'shtab');
    const dept = await makeUser('dept', 'department');

    const attachObject = (userId: string, id: string) =>
      db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${userId}, ${id})`);
    await attachObject(requester.id, objectId);
    await attachObject(second.id, objectId);
    await attachObject(plain.id, objectId);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id) VALUES (${dept.id}, ${departmentId})`);

    /*
     * НАБОР СОБИРАЕТСЯ ТЕСТОМ, а не берётся системным, и это вынужденно: составы наборов и ролей
     * едут ВЫПУСКОМ B (§14, M4), а выпуск A обязан работать до него. Собранный набор — законный
     * способ выдачи по ADR 0106, и ровно им право попадёт к пилотным учёткам раньше M4.
     *
     * Роли в `grant_roles` обязательны: права набора считаются соединением с ними
     * (`grantPermissionsExpr`), и набор без строки роли не даёт держателю ничего.
     */
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system) VALUES (${`ci_propose_${RUN}`}, 'Сообщение о технике', false)
      RETURNING id`);
    const grantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'), (${grantId}, 'department')`);
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'officeEquipment.propose')`);
    for (const holder of [requester.id, second.id, dept.id]) {
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${holder}, ${grantId}, ${adminUser.id}, 'manual')`);
    }

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

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
      requester: await withAuth(requester),
      second: await withAuth(second),
      plain: await withAuth(plain),
      dept: await withAuth(dept),
      objectId,
      foreignObjectId,
      deptObjectId,
      departmentId,
      typeId,
    };
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком, а не выковыриваем фикстуры по суффиксу: чужих строк в ней нет
    // по построению, и оставленная база помешала бы следующему прогону завести её заново.
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

  // ── 1. Пара «кандидат + заявка» (Р2, Р4, Р6) ──

  describe('заведение пары', () => {
    it('кандидат и заявка появляются вместе, со снимками заявленного', async () => {
      const res = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-PAIR-${RUN}`, comment: 'стоит у бухгалтерии, наклейки нет' },
        randomUUID(),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      // Аппарата у заявки нет: предмет описан сообщением, а не ссылкой на справочник.
      expect(dto.equipment).toBeNull();
      expect(dto.status).toBe('new');

      const row = await requestRow(dto.id);
      expect(row.equipment_candidate_id).not.toBeNull();
      expect(row.office_equipment_id).toBeNull();
      // Площадку заявки называет сам кандидат (Р5): объект заполнен всегда.
      expect(row.equipment_object_id).toBe(ctx.objectId);
      /*
       * СНИМКИ ЗАПОЛНЕНЫ ЗАЯВЛЕННЫМ (Р6), а не пусты, как у заявки без аппарата: предмет у заявки
       * есть, он просто не проверен, и сервис едет по этому адресу уже сегодня.
       */
      expect(row.equipment_name).toBe('Kyocera ECOSYS M3145');
      expect(row.equipment_inventory_number).toBe(`CI-PAIR-${RUN}`);
      expect(row.equipment_serial_number).toBe('');
      expect(row.equipment_location).toBe('каб. 214');

      const cand = await candidateRow(row.equipment_candidate_id!);
      expect(cand.status).toBe('pending');
      expect(cand.content_version).toBe(1);
      expect(cand.created_by).toBe(ctx.requester.id);
      expect(cand.object_id).toBe(ctx.objectId);
      expect(cand.comment).toBe('стоит у бухгалтерии, наклейки нет');
      // Решения ещё нет: обе колонки пусты, и это же держит `…_decision_check`.
      expect(cand.decided_by).toBeNull();
      expect(cand.result_equipment_id).toBeNull();
      // Ключ и отпечаток проставил сервер: без них строка не легла бы вовсе (`NOT NULL`).
      expect(cand.idempotency_fingerprint).not.toBe('');
      /*
       * Подразделение автора СНИМКОМ. У площадочной роли отделов нет вовсе, и пусто здесь —
       * законное состояние (Р9: такие сообщения видны по объекту), а не потерянные данные.
       */
      expect(cand.requester_department_id).toBeNull();
    });

    it('роль отдела сообщает с площадки своего отдела, а заказчиком остаётся отдел', async () => {
      /*
       * ДВЕ КОЛОНКИ ОБЛАСТИ СРАЗУ (Р7, последний абзац): `equipment_object_id` держит физическое
       * место аппарата, `customer_department_id` — заказчика. Запрети мы пару, сотрудник отдела
       * потерял бы собственную заявку сразу после отправки — она ушла бы в объектную область,
       * которой у него нет.
       */
      const res = await propose(
        ctx.dept.auth,
        { inventoryNumber: `CI-DEPT-${RUN}`, objectId: ctx.deptObjectId },
        randomUUID(),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      const row = await requestRow(dto.id);
      expect(row.equipment_object_id).toBe(ctx.deptObjectId);
      expect(row.customer_department_id).toBe(ctx.departmentId);
      const cand = await candidateRow(row.equipment_candidate_id!);
      expect(cand.requester_department_id).toBe(ctx.departmentId);
    });

    it('без заголовка Idempotency-Key ветка кандидата не принимается', async () => {
      // 400, а не 422: заголовка нет — команду нечем опознать при повторе, и разбирать тело
      // бессмысленно. Две старые ветви предмета заголовка не требуют (проверено ниже).
      const before = await counts();
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.requester.auth,
        body({ equipmentCandidate: candidate({ inventoryNumber: `CI-NOKEY-${RUN}` }) }),
      );
      expect(res.statusCode, res.body).toBe(400);
      expect(await counts()).toEqual(before);
    });
  });

  // ── 2. Право (Р8) ──

  describe('право сообщать о технике', () => {
    it('без officeEquipment.propose — 403, и ни одной новой строки', async () => {
      /*
       * 403, а не 422 по полю: сообщать о технике человеку не разрешено, и «заполните аппарат» в
       * ответ означало бы «вы ошиблись формой» там, где он не ошибся ничем. Право спрашивается в
       * ТЕЛЕ, а не стражем маршрута: дверь у ручки одна на все три способа назвать предмет.
       */
      const before = await counts();
      const res = await propose(ctx.plain.auth, { inventoryNumber: `CI-403-${RUN}` }, randomUUID());
      expect(res.statusCode, res.body).toBe(403);
      expect(await counts()).toEqual(before);
    });

    it('та же учётка заводит обычную заявку с аппаратом', async () => {
      // Отрицательный контроль: страж в теле не должен закрывать общую дверь модуля.
      const equipmentId = await makeEquipment('plain-ok', { inventoryNumber: `CI-OK-${RUN}` });
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.plain.auth,
        body({ officeEquipmentId: equipmentId }),
      );
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  // ── 3. Рубеж 1: дубль в парке, три редакции (Р10) ──

  describe('рубеж 1: аппарат уже в справочнике', () => {
    it('активная карточка в своей области — 409 с подписью и идентификатором', async () => {
      const inventory = `CI-DUP-ACT-${RUN}`;
      const equipmentId = await makeEquipment('dup-active', { inventoryNumber: inventory });
      const before = await counts();
      /*
       * Номер присылается ИНАЧЕ НАБРАННЫМ — с пробелами и в нижнем регистре: рубеж обязан
       * сравнивать так же, как уникальные индексы парка (`upper(btrim(…))`), иначе он обходился бы
       * опечаткой.
       */
      const res = await propose(
        ctx.requester.auth,
        { inventoryNumber: `  ${inventory.toLowerCase()}  ` },
        randomUUID(),
      );
      expect(res.statusCode, res.body).toBe(409);
      const answer = res.json() as {
        message: string;
        details?: { officeEquipmentId: string | null; title: string | null };
      };
      expect(answer.message).toContain(DUP_ACTIVE);
      // Идентификатор в теле отказа — то, чем портал подставляет единицу в поле и продолжает заявку.
      expect(answer.details?.officeEquipmentId).toBe(equipmentId);
      expect(answer.details?.title).toContain(inventory);
      expect(await counts()).toEqual(before);
    });

    it('выведенная из эксплуатации карточка — 409 без идентификатора', async () => {
      /*
       * ID НЕ ПОДСТАВЛЯЕТСЯ НАМЕРЕННО: активный селектор такую карточку не покажет, а сервер всё
       * равно отобьёт заявку на неё (фикс Ф2), — подставленный идентификатор обещал бы ход,
       * которого нет.
       */
      const serial = `CI-DUP-OFF-${RUN}`;
      const equipmentId = await makeEquipment('dup-inactive', { serialNumber: serial });
      const off = await inject('PATCH', `${EQUIPMENT}/${equipmentId}`, ctx.admin.auth, {
        isActive: false,
      });
      expect(off.statusCode, off.body).toBe(200);

      const res = await propose(ctx.requester.auth, { serialNumber: serial }, randomUUID());
      expect(res.statusCode, res.body).toBe(409);
      const answer = res.json() as {
        message: string;
        details?: { officeEquipmentId: string | null };
      };
      expect(answer.message).toContain(DUP_INACTIVE);
      expect(answer.details?.officeEquipmentId).toBeNull();
    });

    it('карточка чужой площадки — 409 без наименования и места', async () => {
      /*
       * Ищется дубль ПО ВСЕМУ ПАРКУ, мимо области, — ровно потому, что заявитель не нашёл аппарат
       * из-за неё. Но ответ скупой: раскрывается один факт «такой номер существует», а его человек
       * и так знает — он сам его и ввёл.
       */
      const inventory = `CI-DUP-FRN-${RUN}`;
      await makeEquipment('dup-foreign', { inventoryNumber: inventory }, ctx.foreignObjectId);
      const res = await propose(ctx.requester.auth, { inventoryNumber: inventory }, randomUUID());
      expect(res.statusCode, res.body).toBe(409);
      const answer = res.json() as { message: string; details?: { title: string | null } };
      expect(answer.message).toContain(DUP_FOREIGN);
      expect(answer.message).not.toContain(inventory);
      expect(answer.details?.title).toBeNull();
    });

    it('снесённая карточка номер не держит', async () => {
      // Условие рубежа — то же, что у уникальных индексов парка: `deleted_at IS NULL`. Иначе
      // удалённая карточка запирала бы номер навсегда, и сообщить о новом аппарате было бы нечем.
      const inventory = `CI-DUP-DEL-${RUN}`;
      const equipmentId = await makeEquipment('dup-deleted', { inventoryNumber: inventory });
      const removed = await inject('DELETE', `${EQUIPMENT}/${equipmentId}`, ctx.admin.auth);
      expect(removed.statusCode, removed.body).toBe(200);

      const res = await propose(ctx.requester.auth, { inventoryNumber: inventory }, randomUUID());
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  // ── 4. Рубеж 2: гонка двух заявителей (Р10) ──

  describe('рубеж 2: об аппарате уже сообщили', () => {
    it('второе сообщение о том же номере отбивается целиком', async () => {
      const inventory = `CI-RACE-SEQ-${RUN}`;
      const first = await propose(ctx.requester.auth, { inventoryNumber: inventory }, randomUUID());
      expect(first.statusCode, first.body).toBe(201);
      const firstDto = (first.json() as { request: ServiceRequestDto }).request;
      const before = await counts();

      const second = await propose(ctx.second.auth, { inventoryNumber: inventory }, randomUUID());
      expect(second.statusCode, second.body).toBe(409);
      const answer = second.json() as { message: string };
      expect(answer.message).toContain(DUP_PENDING);
      /*
       * Номер первой заявки называется, ПОТОМУ ЧТО она видима второму (та же площадка). Будь она
       * из чужой области, ответ остался бы безличным — это же правило держит основание `related`.
       */
      expect(answer.message).toContain(firstDto.displayNumber);
      /*
       * ВТОРАЯ ТРАНЗАКЦИЯ ОТКАТЫВАЕТСЯ ЦЕЛИКОМ: ни кандидата, ни заявки. Второе сообщение к чужому
       * кандидату НЕ подшивается — два наблюдения могут различаться местом, а общая строка
       * раскрыла бы второму автору чужой объект.
       */
      expect(await counts()).toEqual(before);
    });

    it('двое одновременно: ровно одна пара и один отказ', async () => {
      const inventory = `CI-RACE-PAR-${RUN}`;
      const before = await counts();
      const [a, b] = await Promise.all([
        propose(ctx.requester.auth, { inventoryNumber: inventory }, randomUUID()),
        propose(ctx.second.auth, { inventoryNumber: inventory }, randomUUID()),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      // Гонку ловит уникальный частичный индекс среди `pending`, а не проверка чтением: оба
      // запроса проходят её одновременно и оба ничего не находят.
      expect(codes, `${a.body} | ${b.body}`).toEqual([201, 409]);
      const after = await counts();
      expect(after.candidates).toBe(before.candidates + 1);
      expect(after.requests).toBe(before.requests + 1);
    });

    it('второй номер той же пары тоже сторожится', async () => {
      // Индекса два — по каждому номеру свой: совпадения ОДНОГО из них достаточно, чтобы сообщение
      // было о том же аппарате.
      const serial = `CI-RACE-SN-${RUN}`;
      const first = await propose(
        ctx.requester.auth,
        { serialNumber: serial, inventoryNumber: `CI-RACE-INV-A-${RUN}` },
        randomUUID(),
      );
      expect(first.statusCode, first.body).toBe(201);
      const second = await propose(
        ctx.second.auth,
        { serialNumber: serial.toLowerCase(), inventoryNumber: `CI-RACE-INV-B-${RUN}` },
        randomUUID(),
      );
      expect(second.statusCode, second.body).toBe(409);
      expect((second.json() as { message: string }).message).toContain(DUP_PENDING);
    });
  });

  // ── 5. Идемпотентность (§8) ──

  describe('ключ идемпотентности', () => {
    it('повтор с тем же ключом и телом возвращает прежнюю пару без второй строки', async () => {
      const key = randomUUID();
      const fields = { inventoryNumber: `CI-IDEM-${RUN}` };
      const first = await propose(ctx.requester.auth, fields, key);
      expect(first.statusCode, first.body).toBe(201);
      const firstDto = (first.json() as { request: ServiceRequestDto }).request;
      const after = await counts();

      const repeat = await propose(ctx.requester.auth, fields, key);
      /*
       * 200, А НЕ 201: ресурс этим запросом не создавался, и сказать «создано» значило бы соврать
       * клиенту, который как раз и выясняет, создавал он что-нибудь или нет.
       */
      expect(repeat.statusCode, repeat.body).toBe(200);
      const repeated = (repeat.json() as { request: ServiceRequestDto }).request;
      expect(repeated.id).toBe(firstDto.id);
      // Ни второй пары, ни второго отказа рубежа 2: ключ спрашивается ДО него.
      expect(await counts()).toEqual(after);
    });

    it('тот же ключ под другим телом — 409 идемпотентности', async () => {
      const key = randomUUID();
      const fields = { inventoryNumber: `CI-IDEM-OTHER-${RUN}` };
      const first = await propose(ctx.requester.auth, fields, key);
      expect(first.statusCode, first.body).toBe(201);
      const after = await counts();

      // Меняется поле САМОЙ ЗАЯВКИ, а не кандидата: отпечаток считается по всему телу, потому что
      // пара создаётся одной командой.
      const changed = await propose(ctx.requester.auth, fields, key, {
        description: 'Другое описание: не берёт бумагу из второго лотка',
      });
      expect(changed.statusCode, changed.body).toBe(409);
      expect((changed.json() as { code: string }).code).toBe(
        'office_equipment_candidate_idempotency',
      );
      expect(await counts()).toEqual(after);
    });

    it('перестановка вложений повтором быть не перестаёт', async () => {
      /*
       * Нормализация до отпечатка (§8): множества идентификаторов сортируются и дедуплицируются.
       * Без неё переставленные местами вложения ТОЙ ЖЕ заявки дали бы «другую команду под тем же
       * ключом», и честный повтор потерянного ответа получил бы 409.
       *
       * Файлов в этой базе нет, поэтому проверяется пустая пара «тот же ключ, иначе набранное
       * тело»: комментарий кандидата приходит с пробелами по краям, которые схема обрезает.
       */
      const key = randomUUID();
      const first = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-IDEM-NORM-${RUN}`, comment: 'у окна' },
        key,
      );
      expect(first.statusCode, first.body).toBe(201);
      const firstDto = (first.json() as { request: ServiceRequestDto }).request;

      const repeat = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-IDEM-NORM-${RUN}`, comment: '  у окна  ' },
        key,
      );
      expect(repeat.statusCode, repeat.body).toBe(200);
      expect((repeat.json() as { request: ServiceRequestDto }).request.id).toBe(firstDto.id);
    });

    it('чужой ключ повтором не становится', async () => {
      /*
       * Уникальность объявлена парой «автор + ключ»: ключ описывает попытку КОНКРЕТНОГО человека, и
       * совпадение UUID у двоих не должно превращать чужую заявку в «повтор».
       */
      const key = randomUUID();
      const first = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-IDEM-MINE-${RUN}` },
        key,
      );
      expect(first.statusCode, first.body).toBe(201);
      const second = await propose(
        ctx.second.auth,
        { inventoryNumber: `CI-IDEM-THEIRS-${RUN}` },
        key,
      );
      expect(second.statusCode, second.body).toBe(201);
      expect((second.json() as { request: ServiceRequestDto }).request.id).not.toBe(
        (first.json() as { request: ServiceRequestDto }).request.id,
      );
    });
  });

  // ── 6. Ось объекта (Р7) ──

  describe('площадка сообщения', () => {
    it('чужой объект — 422 с путём поля', async () => {
      const before = await counts();
      const res = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-FOREIGN-${RUN}`, objectId: ctx.foreignObjectId },
        randomUUID(),
      );
      // 422, а не 403: право сообщать у человека есть — не годится присланное значение.
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('equipmentCandidate.objectId');
      expect(await counts()).toEqual(before);
    });

    it('роль отдела не сообщает с площадки чужого отдела', async () => {
      // Отдельская ось — площадки СВОИХ отделов (`departmentObjectIds`, ADR 0062): иначе очередь
      // проверяющего чужой площадки наполнялась бы сообщениями, которых там никто не видел.
      const res = await propose(
        ctx.dept.auth,
        { inventoryNumber: `CI-DEPT-FRN-${RUN}`, objectId: ctx.foreignObjectId },
        randomUUID(),
      );
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('equipmentCandidate.objectId');
    });

    it('несуществующий объект — 422, а не отказ базы по ссылке', async () => {
      const res = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-NOOBJ-${RUN}`, objectId: randomUUID() },
        randomUUID(),
      );
      expect(res.statusCode, res.body).toBe(422);
    });
  });

  // ── 7. Две сегодняшние ветви предмета от третьей не пострадали ──

  describe('регресс двух старых ветвей', () => {
    it('заявка с аппаратом заводится по-прежнему и без всякого заголовка', async () => {
      const equipmentId = await makeEquipment('regress', { inventoryNumber: `CI-REG-${RUN}` });
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.requester.auth,
        body({ officeEquipmentId: equipmentId }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      expect(dto.equipment?.id).toBe(equipmentId);
      const row = await requestRow(dto.id);
      expect(row.equipment_candidate_id).toBeNull();
      // Снимки — из карточки, а не из заявленного: ветка кандидата их не тронула.
      expect(row.equipment_inventory_number).toBe(`CI-REG-${RUN}`);
    });

    it('заявка без аппарата заводится держателем своего права', async () => {
      // `serviceRequests.createWithoutEquipment` есть у администратора; заказчиком становится
      // площадка, кандидата у такой заявки нет.
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.admin.auth,
        body({ objectId: ctx.objectId, description: 'Настройте почту новому сотруднику' }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      const row = await requestRow(dto.id);
      expect(row.equipment_candidate_id).toBeNull();
      expect(row.office_equipment_id).toBeNull();
      expect(row.equipment_name).toBe('');
    });

    it('аппарат и сообщение сразу — отказ схемы, а не выбор одного из двух', async () => {
      /*
       * Три способа назвать предмет ВЗАИМОИСКЛЮЧАЮЩИ (Р2): «прислали два сразу» обязано читаться
       * отказом, а не молчаливым выбором по порядку разбора. Отбивает это схема — до всякой работы.
       */
      const equipmentId = await makeEquipment('both', { inventoryNumber: `CI-BOTH-${RUN}` });
      const res = await propose(
        ctx.requester.auth,
        { inventoryNumber: `CI-BOTH-CAND-${RUN}` },
        randomUUID(),
        { officeEquipmentId: equipmentId },
      );
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields).toHaveProperty('equipmentCandidate');
    });

    it('сообщение без обоих номеров не принимается', async () => {
      // Тот же инвариант, что у парка, и та же причина: по номеру ищется дубль на всех рубежах.
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.requester.auth,
        body({
          equipmentCandidate: {
            equipmentTypeId: ctx.typeId,
            declaredModel: 'Kyocera ECOSYS M3145',
            objectId: ctx.objectId,
            location: 'каб. 214',
          },
        }),
        { 'idempotency-key': randomUUID() },
      );
      expect(res.statusCode, res.body).toBe(400);
    });
  });
});
