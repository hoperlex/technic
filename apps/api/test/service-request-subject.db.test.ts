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
 * ЗАЯВКА НА АППАРАТ ВНЕ СВОЕЙ ОБЛАСТИ: ПОРЯДОК ПРОВЕРОК ПЕРЕВЁРНУТ (план
 * `docs/office-equipment-request-subject-plan.md`, Р4–Р8; этап Э3).
 *
 * Было: заказчик → область по объекту КАРТОЧКИ → поправка «не тот объект». Стало: заказчик →
 * поправка (итоговый объект заявки) → область по ИТОГОВОМУ объекту. Перемена нужна ради просьбы
 * заказчика: качественной базы по оргтехнике нет, аппарат сплошь и рядом числится не там, где стоит,
 * — и заявку на найденный аппарат сервер отбивал 403 после заполнения всей формы, ещё до того, как
 * поправка успевала сказать, что аппарат стоит как раз у нас.
 *
 * ВМЕСТЕ С ПЕРЕВОРОТОМ ЗАКРЫВАЕТСЯ ДЫРА, КОТОРУЮ ОН ОТКРЫВАЕТ, и она здесь — половина файла.
 * Поправка проверяла только объектную ось: роль отдела выбирала любой объект портала безнаказанно,
 * потому что область считалась по карточке, а в своей области заявку держал отдел-заказчик. После
 * переворота «любой объект» означал бы заявку на чужой стройке, которую там никто не ждёт, — и
 * отдельская ось сузилась до площадок своих отделов (`departmentObjectIds`, ADR 0062).
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Три колонки области (`equipment_object_id`, `customer_department_id`,
 * `equipment_department_id`) проверяются тем, что в них ЛЕГЛО, а главное утверждение Р4 — «автор
 * увидит собственную заявку» — считается предикатом видимости в запросе списка. Мок ответил бы
 * кодом, ничего не сказав ни о строке, ни о её видимости.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: часть утверждений — про отсутствие строки после
 * отказа, и чужой параллельный прогон сделал бы их ложными. База заводится, мигрируется с нуля и
 * сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/service-request-subject.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_subject_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-subject-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

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
  /** Заводит карточки парка по всем площадкам: у него словарь прав и область целиком. */
  admin: TestUser;
  /** Объектная роль: область считается её площадками (`site`). */
  site: TestUser;
  /** Роль отдела: область считается её отделами, а поправка объекта — площадками этих отделов. */
  dept: TestUser;
  /** Площадка `site` — и та, на которую он поправляет объект аппарата. */
  siteObjectId: string;
  /** Площадка отдела `dept` (ADR 0062). */
  deptObjectId: string;
  /** Чужая всем: на ней ЧИСЛИТСЯ техника, и она же — негодный выбор поправки. */
  foreignObjectId: string;
  ownDepartmentId: string;
  /** Отдел-владелец техники: чужой обоим заявителям. */
  ownerDepartmentId: string;
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

function inject(method: 'GET' | 'POST', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Обязательная часть тела заведения: предмет, описание и контакт заявителя. */
function body(officeEquipmentId: string, extra: Record<string, unknown> = {}) {
  return {
    officeEquipmentId,
    description: 'Не печатает, зажёвывает бумагу',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  };
}

/** Три колонки области так, как они легли в базу: именно ими считается видимость заявки. */
async function scopeRow(id: string) {
  const res = await ctx.db.execute<{
    equipment_object_id: string | null;
    customer_department_id: string | null;
    equipment_department_id: string | null;
    object_overridden: boolean;
  }>(sql`
    SELECT equipment_object_id, customer_department_id, equipment_department_id, object_overridden
      FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

async function requestCount(): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM service_requests`,
  );
  return res.rows[0]!.n;
}

/** Видит ли субъект свою заявку в списке: тот же предикат области, что и у отбора. */
async function seesInList(auth: Auth, id: string): Promise<boolean> {
  const res = await inject('GET', `${REQUESTS}?pageSize=200`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).some((row) => row.id === id);
}

describe.skipIf(!DB_URL)('предмет заявки: область считается по итоговому объекту', () => {
  /**
   * Своя единица на случай (по одной технике незакрытая заявка бывает только одна, Р21). Карточка
   * ЧИСЛИТСЯ на чужой площадке и за чужим отделом — то самое положение, из которого просьба
   * заказчика и выросла: справочник говорит одно, человек рядом с аппаратом видит другое.
   */
  let unitNo = 0;
  async function foreignUnit(): Promise<string> {
    unitNo += 1;
    const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
      equipmentTypeId: ctx.typeId,
      name: `МФУ чужой площадки ${unitNo} ${RUN}`,
      objectId: ctx.foreignObjectId,
      departmentId: ctx.ownerDepartmentId,
      location: 'кабинет 214',
      inventoryNumber: `SB-${RUN}-${unitNo}`,
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
        VALUES (${`SB-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const siteObjectId = await object('site');
    const deptObjectId = await object('dept');
    const foreignObjectId = await object('foreign');

    const department = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name) VALUES (${`SB-${tag}-${RUN}`}, ${`Отдел ${tag} ${RUN}`})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const ownDepartmentId = await department('own');
    const ownerDepartmentId = await department('owner');
    // Площадка отдела — связь, а не поле: у отдела их бывает несколько (ADR 0144). Именно ею и
    // считается отдельская ось поправки объекта.
    await db.execute(sql`
      INSERT INTO department_construction_objects (department_id, construction_object_id)
      VALUES (${ownDepartmentId}, ${deptObjectId})`);

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-sb-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const site = await makeUser('site', 'site');
    const dept = await makeUser('dept', 'department');
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${site.id}, ${siteObjectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id) VALUES (${dept.id}, ${ownDepartmentId})`);

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
      site: await withAuth(site),
      dept: await withAuth(dept),
      siteObjectId,
      deptObjectId,
      foreignObjectId,
      ownDepartmentId,
      ownerDepartmentId,
      typeId,
    };
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная база
    // помешала бы следующему прогону завести её заново.
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

  // ── Объектная ось (Р4, Р5, Р8) ──

  describe('объектная роль', () => {
    it('аппарат чужой площадки записывается на площадку автора — и автор её видит', async () => {
      /*
       * ГЛАВНЫЙ СЛУЧАЙ ФАЙЛА. До переворота этот запрос отвечал 403: область спрашивалась по объекту
       * КАРТОЧКИ, то есть по чужой площадке, и поправка «аппарат стоит у нас» не успевала прозвучать.
       */
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.site.auth,
        body(await foreignUnit(), { objectId: ctx.siteObjectId, objectOverridden: true }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;

      const row = await scopeRow(dto.id);
      // Заявка записана на площадку АВТОРА (Р4): иначе он отправил бы её и не увидел — видимость
      // объектной роли считается именно этой колонкой.
      expect(row.equipment_object_id).toBe(ctx.siteObjectId);
      expect(row.object_overridden).toBe(true);
      /*
       * Отдел-владелец остаётся СНИМКОМ КАРТОЧКИ (Р8, последний абзац): чужой отдел области не даёт
       * — её дала своя площадка, — но и не отнимает. Обнули мы его «на всякий случай», отдел, за
       * которым аппарат числится, не узнал бы о заявке на собственную технику (Р12).
       */
      expect(row.equipment_department_id).toBe(ctx.ownerDepartmentId);
      // Отделов у площадочной роли нет вовсе: `NULL` здесь означает «к отделам не относится».
      expect(row.customer_department_id).toBeNull();

      // Проверка того же утверждения с другого конца: предикат видимости в запросе списка.
      // Совпадение колонки и видимости — не одно и то же, и расходились они уже не раз.
      expect(await seesInList(ctx.site.auth, dto.id), 'автор видит свою заявку').toBe(true);
      // Расхождение с карточкой при этом никуда не делось и считается соединением: аппарат
      // по-прежнему ЧИСЛИТСЯ на чужой площадке, пока ИТ-служба не перенесёт его в справочнике.
      expect(dto.objectMismatch).toBe(true);
    });

    it('без поправки чужая площадка остаётся чужой — 403, и заявки нет', async () => {
      /*
       * Вторая половина переворота: итоговый объект без пометки — это объект карточки, и область по
       * нему отвечает тем же 403, что и прежде. Перевёрнутый порядок не открыл дверь всем подряд —
       * он лишь спрашивает область о том объекте, который заявка получит.
       */
      const before = await requestCount();
      const res = await inject('POST', REQUESTS, ctx.site.auth, body(await foreignUnit()));
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().message).toContain('только со своими объектами');
      expect(await requestCount(), 'отказ не завёл заявки').toBe(before);
    });

    it('поправка на чужую площадку — 422 по полю, а не запись в чужую область', async () => {
      const before = await requestCount();
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.site.auth,
        body(await foreignUnit(), { objectId: ctx.foreignObjectId, objectOverridden: true }),
      );
      // 422, а не 403: право заводить заявку у него есть — негодно присланное значение.
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('только на свой объект');
      expect(await requestCount(), 'отказ не завёл заявки').toBe(before);
    });
  });

  // ── Отдельская ось: дыра, которую открывает переворот (Р8) ──

  describe('роль отдела', () => {
    it('записывает аппарат на площадку своего отдела', async () => {
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.dept.auth,
        body(await foreignUnit(), {
          customerDepartmentId: ctx.ownDepartmentId,
          objectId: ctx.deptObjectId,
          objectOverridden: true,
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;

      const row = await scopeRow(dto.id);
      // ОБЕ КОЛОНКИ ОБЛАСТИ ЗАПОЛНЕНЫ, и это законно (Р6): объект держит физическое место аппарата,
      // отдел-заказчик — того, от чьего имени заявка заведена и кто её увидит.
      expect(row.equipment_object_id).toBe(ctx.deptObjectId);
      expect(row.customer_department_id).toBe(ctx.ownDepartmentId);
      expect(row.equipment_department_id).toBe(ctx.ownerDepartmentId);
      expect(await seesInList(ctx.dept.auth, dto.id), 'автор видит свою заявку').toBe(true);
    });

    it('площадка вне своего отдела — 422, и заявки нет', async () => {
      /*
       * ТА САМАЯ ДЫРА. До Э3 этот запрос отвечал 201 и записывал заявку на чужую стройку: поправка
       * спрашивала одну объектную ось, у роли отдела её нет, а область считалась по карточке — то
       * есть присланный объект не проверял никто. Читать заявку было бы некому: площадка её не
       * ждала, а свой отдел о чужой стройке не знает.
       */
      const before = await requestCount();
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.dept.auth,
        body(await foreignUnit(), {
          customerDepartmentId: ctx.ownDepartmentId,
          objectId: ctx.foreignObjectId,
          objectOverridden: true,
        }),
      );
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('площадки своего отдела');
      expect(res.json().fields).toMatchObject({ objectId: 'Чужая площадка' });
      expect(await requestCount(), 'отказ не завёл заявки').toBe(before);
    });

    it('без поправки заявка держится отделом-заказчиком, а не площадкой', async () => {
      /*
       * Отрицательный контроль к обоим случаям выше: новая ось спрашивается только у ПОПРАВКИ.
       * Заявка на аппарат чужой площадки без пометки у роли отдела проходит — её область считается
       * отделами, и заказчиком стоит свой отдел. Запрети мы и это, роль отдела лишилась бы заявок
       * по всей технике, стоящей вне площадок её отдела, — то есть по большей части парка.
       */
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.dept.auth,
        body(await foreignUnit(), { customerDepartmentId: ctx.ownDepartmentId }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      const row = await scopeRow(dto.id);
      expect(row.equipment_object_id).toBe(ctx.foreignObjectId);
      expect(row.object_overridden).toBe(false);
      expect(row.customer_department_id).toBe(ctx.ownDepartmentId);
      expect(await seesInList(ctx.dept.auth, dto.id), 'автор видит свою заявку').toBe(true);
    });
  });
});
