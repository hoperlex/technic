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
 * ЗАЯВКУ МОЖНО ЗАВЕСТИ БЕЗ АППАРАТА (Р5, Р6, Р7 плана
 * `docs/office-equipment-consumables-and-purchase-plan.md`; ADR 0146, решение 6; выпуск 2б,
 * этап Э18). Соседний файл `service-request-empty-subject.db.test.ts` проверяет ЧТЕНИЕ такой
 * заявки (выпуск 2а) и вставляет её прямым SQL, потому что завести её тогда было нечем; здесь она
 * заводится ручкой, и предмет проверки — сам вход.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Три из четырёх утверждений файла не живут ни в одной строке маршрута по
 * отдельности:
 *
 *   * **ось роли** (Р6) проверяется не тем, что маршрут ответил 422, а тем, что заявка, заведённая
 *     по своей оси, ПОТОМ ВИДНА автору, а по чужой — не была бы видна никому. Второе половина
 *     утверждения — это предикат области в живом `SELECT`, а не ветка `if`;
 *   * **`CHECK` предмета** — это база и только база: `service_requests_subject_check` двусоставный,
 *     и на моках проверялись бы моки;
 *   * **замок «одна открытая заявка на аппарат»** обязан не сработать без аппарата, и держат его
 *     частичные уникальные индексы, где `NULL` не равен `NULL`.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: по общей параллельно идут другие прогоны, а здесь
 * половина утверждений — про ОТСУТСТВИЕ строки («заявка не завелась», «в списке её нет»), и чужая
 * строка в тех же таблицах сделала бы их ложными либо, наоборот, зелёными по чужой причине. База
 * заводится, мигрируется с нуля и сносится в `afterAll` (образец — `office-equipment-purchases`).
 *
 * КОДЫ ОТКАЗОВ РАЗНЫЕ, И РАЗНИЦА СОДЕРЖАТЕЛЬНА:
 *
 *   * **403** — «аппарат не прислали, а права на это нет» (Р5). Человек не ошибся полем, ему просто
 *     не положено, и 422 по полю «заполните аппарат» отправил бы его искать несуществующую ошибку;
 *   * **400** — отказ СХЕМЫ (`createServiceRequestSchema` + общий разбор `fastify-type-provider-zod`):
 *     закрытые двери Р7 и «заказчик ровно один»;
 *   * **422** — отказ МАРШРУТА по присланному значению: ось роли и чужой объект.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/service-request-without-equipment.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_no_equipment_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-no-equipment-password-123';
const REQUESTS = '/api/v1/service-requests';

/** Отказ стража права Р5: по нему видно, что 403 пришёл именно от него, а не от области. */
const WITHOUT_EQUIPMENT_DENIED =
  'Заявку без аппарата заводит тот, кому это разрешено отдельно — выберите аппарат из справочника';

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
  /** Администратор: словарь прав целиком — им заводятся декорации. */
  admin: TestUser;
  /**
   * Рядовой заявитель: роль площадки, `serviceRequests.create` от роли и НИ ОДНОГО набора. Ровно
   * тот человек, которому заявка без аппарата не положена.
   */
  plain: TestUser;
  /** Роль площадки + «Оргтехника: ведение»: ось объектная, право Р5 есть. */
  site: TestUser;
  /** Роль отдела + «Оргтехника: ведение»: ось отдельская, право Р5 есть. */
  dept: TestUser;
  /** Роль площадки + «Оргтехника: ИТ-служба»: сквозная область модуля, обе оси открыты. */
  it: TestUser;
  /** Площадка `site` и `plain`. */
  objectId: string;
  /** Площадка ИТ-службы: НЕ та, на которую заводят заявки, — иначе её видимость объяснялась бы осью. */
  itObjectId: string;
  departmentId: string;
  /** Чужой отдел: в нём не числится никто из учёток файла. */
  foreignDepartmentId: string;
  equipmentId: string;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Обязательная часть тела заведения: контакт заявителя и описание. */
function body(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    description: 'Поставьте розетку в кабинете 214',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  };
}

function post(auth: Auth, extra: Record<string, unknown>) {
  return inject('POST', REQUESTS, auth, body(extra));
}

async function create(auth: Auth, extra: Record<string, unknown>): Promise<ServiceRequestDto> {
  const res = await post(auth, extra);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request;
}

interface ListAnswer {
  items: ServiceRequestDto[];
  total: number;
}

async function list(auth: Auth): Promise<string[]> {
  const res = await inject('GET', `${REQUESTS}?pageSize=100`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ListAnswer).items.map((item) => item.id);
}

/** Строка заявки в базе — прямым SQL: снимки предмета проверяются там, где они лежат. */
async function rowOf(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute<Record<string, unknown>>(
    sql`SELECT * FROM service_requests WHERE id = ${id}`,
  );
  const row = res.rows[0];
  if (!row) throw new Error(`заявки ${id} нет в базе`);
  return row;
}

async function requestCount(): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM service_requests`,
  );
  return res.rows[0]!.n;
}

describe.skipIf(!DB_URL)('заявка без аппарата: право, ось роли и предмет', () => {
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
        VALUES (${`NE-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const department = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`NE-D-${tag}-${RUN}`}, ${`Отдел ${tag} ${RUN}`})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const objectId = await object('main');
    const itObjectId = await object('it');
    const departmentId = await department('main');
    const foreignDepartmentId = await department('foreign');

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-ne-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const plain = await makeUser('plain', 'shtab');
    const site = await makeUser('site', 'shtab');
    const dept = await makeUser('dept', 'department');
    const it = await makeUser('it', 'shtab');

    const attachObject = (userId: string, id: string) =>
      db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${userId}, ${id})`);
    await attachObject(plain.id, objectId);
    await attachObject(site.id, objectId);
    await attachObject(it.id, itObjectId);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id) VALUES (${dept.id}, ${departmentId})`);

    /*
     * Наборы — СИСТЕМНЫЕ, те самые, что раздаёт администратор (миграция 0231), а не собранные
     * тестом из одного права. Собранный набор проверял бы стража маршрута и молчал бы о том, уехало
     * ли право `serviceRequests.createWithoutEquipment` из состава наборов.
     */
    async function grantByCode(userId: string, code: string): Promise<void> {
      const res = await db.execute<{ id: string }>(
        sql`SELECT id FROM grants WHERE code = ${code} AND deleted_at IS NULL`,
      );
      const grantId = res.rows[0]?.id;
      if (!grantId) throw new Error(`в базе нет системного набора «${code}»`);
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${userId}, ${grantId}, ${adminUser.id}, 'manual')`);
    }
    await grantByCode(site.id, 'office_equipment_operator');
    await grantByCode(dept.id, 'office_equipment_operator');
    await grantByCode(it.id, 'office_equipment_it_approver');

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');
    const equipmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
      VALUES (${typeId}, ${`МФУ без аппарата ${RUN}`}, ${`НЕ-${RUN}`}, ${objectId}, 'кабинет 214')
      RETURNING id`);

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
      plain: await withAuth(plain),
      site: await withAuth(site),
      dept: await withAuth(dept),
      it: await withAuth(it),
      objectId,
      itObjectId,
      departmentId,
      foreignDepartmentId,
      equipmentId: equipmentRow.rows[0]!.id,
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

  // ── 1. Право (Р5) ──

  describe('право «завести заявку без аппарата»', () => {
    it('рядовой заявитель получает 403, а не отказ по полю', async () => {
      const res = await post(ctx.plain.auth, { objectId: ctx.objectId });
      // Именно 403: «вы ошиблись полем» в ответ человеку, который ничем не ошибся, отправило бы его
      // искать несуществующую ошибку в форме.
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().message).toBe(WITHOUT_EQUIPMENT_DENIED);
    });

    it('заявку С аппаратом тот же заявитель заводит по-прежнему', async () => {
      // Отрицательный контроль к предыдущему случаю: страж права не должен закрывать обычную дверь.
      const dto = await create(ctx.plain.auth, { officeEquipmentId: ctx.equipmentId });
      expect(dto.equipment?.id).toBe(ctx.equipmentId);
      expect(dto.object?.id).toBe(ctx.objectId);
    });

    it('держатель набора заводит её, и снимки предмета пусты', async () => {
      const dto = await create(ctx.site.auth, { objectId: ctx.objectId });
      expect(dto.equipment).toBeNull();
      // Площадка-заказчик в карточке видна: колонка та же, что у «где стоит аппарат» (Р6).
      expect(dto.object?.id).toBe(ctx.objectId);

      const row = await rowOf(dto.id);
      expect(row.office_equipment_id).toBeNull();
      expect(row.equipment_object_id).toBe(ctx.objectId);
      expect(row.customer_department_id).toBeNull();
      // Отдел-ВЛАДЕЛЕЦ пуст всегда: владельца у несуществующей единицы нет.
      expect(row.equipment_department_id).toBeNull();
      // Снимки предмета — пустые строки, а не «Без аппарата» словами: иначе поиск по названию
      // техники находил бы заявку, у которой техники нет.
      expect(row.equipment_name).toBe('');
      expect(row.equipment_serial_number).toBe('');
      expect(row.equipment_inventory_number).toBe('');
      expect(row.equipment_location).toBe('');

      // Та же заявка от отдела: заказчик лёг во вторую колонку, а отдел-ВЛАДЕЛЕЦ пуст и здесь.
      // Подставь сюда кто-нибудь отдел-заказчик — роль отдела видела бы заявку сразу по двум
      // основаниям, и правка заказчика оставила бы её видимой по второму.
      const fromDepartment = await create(ctx.dept.auth, {
        customerDepartmentId: ctx.departmentId,
      });
      const departmentRow = await rowOf(fromDepartment.id);
      expect(departmentRow.equipment_object_id).toBeNull();
      expect(departmentRow.customer_department_id).toBe(ctx.departmentId);
      expect(departmentRow.equipment_department_id).toBeNull();
    });

    it('замок «одна открытая заявка» без аппарата не запирает ничего', async () => {
      // Две открытые заявки без аппарата подряд — законны: запирается ЕДИНИЦА, а её здесь нет.
      await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });
      await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });

      // А на аппарате замок стоит там же, где стоял: отрицательный контроль к строке выше.
      const again = await post(ctx.site.auth, { officeEquipmentId: ctx.equipmentId });
      expect(again.statusCode, again.body).toBe(409);
    });
  });

  // ── 2. Ось роли (Р6) ──

  describe('заказчик выбирается по оси своей роли', () => {
    it('роль площадки, приславшая отдел, получает 422 с именем поля', async () => {
      const res = await post(ctx.site.auth, { customerDepartmentId: ctx.departmentId });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('customerDepartmentId');
    });

    it('роль отдела, приславшая объект, получает 422 с именем поля', async () => {
      const res = await post(ctx.dept.auth, { objectId: ctx.objectId });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('objectId');
    });

    it('роль площадки не заводит заявку и от ЧУЖОГО объекта', async () => {
      const res = await post(ctx.site.auth, { objectId: ctx.itObjectId });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('objectId');
    });

    it('роль отдела не заводит заявку от чужого отдела', async () => {
      const res = await post(ctx.dept.auth, { customerDepartmentId: ctx.foreignDepartmentId });
      expect(res.statusCode, res.body).toBe(403);
    });

    it('ИТ-служба проходит обеими осями: сквозная область — это и есть её ось', async () => {
      const byObject = await create(ctx.it.auth, { objectId: ctx.objectId });
      expect(byObject.object?.id).toBe(ctx.objectId);
      const byDepartment = await create(ctx.it.auth, {
        customerDepartmentId: ctx.foreignDepartmentId,
      });
      expect(byDepartment.object).toBeNull();
      expect(byDepartment.customerDepartment?.id).toBe(ctx.foreignDepartmentId);
    });
  });

  // ── 3. Область: заявка остаётся у автора и не уходит к чужой оси ──

  describe('область заведённой заявки', () => {
    it('«от площадки» видна роли этой площадки и не видна роли отдела', async () => {
      const dto = await create(ctx.site.auth, { objectId: ctx.objectId });

      expect(await list(ctx.site.auth)).toContain(dto.id);
      expect(await list(ctx.dept.auth)).not.toContain(dto.id);
      // Прямой заход по известному id — тот же ответ, что у списка: иначе список прятал бы то, что
      // карточка отдаёт любому, кто знает id.
      const mine = await inject('GET', `${REQUESTS}/${dto.id}`, ctx.site.auth);
      expect(mine.statusCode, mine.body).toBe(200);
      const alien = await inject('GET', `${REQUESTS}/${dto.id}`, ctx.dept.auth);
      expect(alien.statusCode, alien.body).toBe(403);
    });

    it('«от отдела» видна роли этого отдела и не видна роли площадки', async () => {
      const dto = await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });

      expect(await list(ctx.dept.auth)).toContain(dto.id);
      expect(await list(ctx.site.auth)).not.toContain(dto.id);
      const mine = await inject('GET', `${REQUESTS}/${dto.id}`, ctx.dept.auth);
      expect(mine.statusCode, mine.body).toBe(200);
      const alien = await inject('GET', `${REQUESTS}/${dto.id}`, ctx.site.auth);
      expect(alien.statusCode, alien.body).toBe(403);
    });

    it('ИТ-служба видит обе, и не потому, что они на её площадке', async () => {
      const fromSite = await create(ctx.site.auth, { objectId: ctx.objectId });
      const fromDept = await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });
      const seen = await list(ctx.it.auth);
      expect(seen).toContain(fromSite.id);
      expect(seen).toContain(fromDept.id);
      // Площадка ИТ-службы другая, отделов у неё нет вовсе: обе заявки видны сквозной областью.
      expect(ctx.itObjectId).not.toBe(ctx.objectId);
    });
  });

  // ── 4. Предмет назван: схема первым рубежом, `CHECK` вторым (Р7) ──

  describe('заказчик у заявки без аппарата ровно один', () => {
    it('двух заказчиков сразу схема не пропускает', async () => {
      const res = await post(ctx.it.auth, {
        objectId: ctx.objectId,
        customerDepartmentId: ctx.departmentId,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields).toHaveProperty('objectId');
    });

    it('нуля заказчиков схема не пропускает, и до базы это не доходит', async () => {
      const before = await requestCount();
      const res = await post(ctx.it.auth, {});
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields).toHaveProperty('objectId');
      // Ни одной новой строки: отказ схемы стоит ДО транзакции, и `CHECK` в этом случае молчит не
      // потому, что разрешает, а потому, что до него не дошли.
      expect(await requestCount()).toBe(before);
    });

    it('`CHECK` стоит вторым рубежом и ловит все три негодные строки', async () => {
      /**
       * Отказ спрашивается ИМЕНЕМ ограничения, а не «упало ли»: drizzle заворачивает ошибку базы в
       * свою («Failed query: …»), и `toThrow(/…/)` по её тексту зеленел бы на ЛЮБОМ отказе вставки
       * — на опечатке в колонке, на внешнем ключе, на `NOT NULL` соседнего поля. Имя ограничения
       * лежит в `cause`, и вместе с кодом `23514` оно отвечает ровно на тот вопрос, который задан.
       */
      async function insertRefusal(columns: {
        equipment?: string | null;
        object?: string | null;
        department?: string | null;
      }): Promise<string> {
        try {
          await ctx.db.execute(sql`
            INSERT INTO service_requests (office_equipment_id, equipment_object_id,
                                          customer_department_id, equipment_name, description,
                                          responsible_name, responsible_phone, created_by)
            VALUES (${columns.equipment ?? null}, ${columns.object ?? null},
                    ${columns.department ?? null}, '', 'мимо схемы', 'Иванов Иван Иванович',
                    '9990000000', ${ctx.admin.id})`);
        } catch (error) {
          const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
          return `${cause?.code ?? '?'}:${cause?.constraint ?? '?'}`;
        }
        return 'строка легла в таблицу';
      }
      const REFUSED = '23514:service_requests_subject_check';

      // Аппарат без объекта — заявка, которой не бывало ни разу за всю жизнь модуля. Снятие
      // `NOT NULL` с аппарата не должно было утащить за собой это правило.
      expect(await insertRefusal({ equipment: ctx.equipmentId })).toBe(REFUSED);
      // Два заказчика сразу: такую строку роль площадки и роль отдела считали бы своей каждая.
      expect(await insertRefusal({ object: ctx.objectId, department: ctx.departmentId })).toBe(
        REFUSED,
      );
      // Ноль заказчиков: заявка вне области любой роли — её не увидит никто.
      expect(await insertRefusal({})).toBe(REFUSED);
    });
  });

  // ── 5. Закрытые двери Р7 ──

  describe('гарантии и пометки объекта у заявки без аппарата не бывает', () => {
    it('гарантийное обращение отвергается схемой', async () => {
      const res = await post(ctx.site.auth, {
        objectId: ctx.objectId,
        warrantyClaim: { source: 'equipment' },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields).toHaveProperty('warrantyClaim');
    });

    it('пометка «не тот объект» отвергается схемой', async () => {
      const res = await post(ctx.site.auth, {
        objectId: ctx.objectId,
        objectOverridden: true,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields).toHaveProperty('objectOverridden');
    });

    it('правка отвечает про отсутствие аппарата, а не «другая единица техники»', async () => {
      const dto = await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });
      const res = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.dept.auth, {
        version: dto.version,
        warrantyClaim: { source: 'equipment' },
      });
      expect(res.statusCode, res.body).toBe(422);
      // Ответ по существу: до выпуска 2б сюда доходил текст «Позиция относится к другой единице
      // техники» — про единицу, которой у заявки нет вовсе.
      expect(res.json().message).toBe(
        'Обращаются по гарантии конкретного аппарата, а у этой заявки аппарата нет',
      );
    });
  });

  // ── 6. Правка (этап Э18, пункт 3) ──

  describe('правка заявки без аппарата', () => {
    it('описание правится, и заявка от этого не разваливается', async () => {
      const dto = await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });
      const res = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.dept.auth, {
        version: dto.version,
        description: 'Настройте почту новому сотруднику',
        // Форма шлёт заказчика всегда (Р12б): неизменившееся значение не должно считаться сменой.
        customerDepartmentId: ctx.departmentId,
      });
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json() as ServiceRequestDto;
      expect(after.description).toBe('Настройте почту новому сотруднику');
      expect(after.equipment).toBeNull();
      expect(after.customerDepartment?.id).toBe(ctx.departmentId);
    });

    it('заказчика «от отдела» нельзя обнулить: заявку не увидел бы никто', async () => {
      const dto = await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });
      const res = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.dept.auth, {
        version: dto.version,
        customerDepartmentId: null,
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('customerDepartmentId');
      // Строка на месте и по-прежнему с одним заказчиком.
      expect((await rowOf(dto.id)).customer_department_id).toBe(ctx.departmentId);
    });

    it('заявке «от площадки» отдел-заказчик не назначается: их стало бы двое', async () => {
      const dto = await create(ctx.site.auth, { objectId: ctx.objectId });
      const res = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.site.auth, {
        version: dto.version,
        customerDepartmentId: ctx.departmentId,
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields).toHaveProperty('customerDepartmentId');
      const row = await rowOf(dto.id);
      expect(row.customer_department_id).toBeNull();
      expect(row.equipment_object_id).toBe(ctx.objectId);
    });

    it('внутри своей оси заказчик меняется по-прежнему', async () => {
      // Отрицательный контроль к двум случаям выше: запрет обязан касаться перехода МЕЖДУ осями, а
      // не правки заказчика вообще. Отделы меняет администратор — у него обе оси открыты.
      const dto = await create(ctx.dept.auth, { customerDepartmentId: ctx.departmentId });
      const res = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.admin.auth, {
        version: dto.version,
        customerDepartmentId: ctx.foreignDepartmentId,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await rowOf(dto.id)).customer_department_id).toBe(ctx.foreignDepartmentId);
    });
  });
});
