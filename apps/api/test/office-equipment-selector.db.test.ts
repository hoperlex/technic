import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEquipmentRequestOptionDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';

/**
 * ПРОЕКЦИЯ СПРАВОЧНИКА ДЛЯ ВЫБОРА ПРЕДМЕТА ЗАЯВКИ (план
 * `docs/office-equipment-request-subject-plan.md`, этап Э2: Р1–Р3, §9).
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ — шесть утверждений, ни одно из которых не проверить без базы:
 *
 *   1. дверь — два права сразу: без `serviceRequests.create` обе ручки отвечают 403, хотя
 *      справочник смотрящему открыт;
 *   2. меньше трёх символов — только своя область: выдача сужена тем же предикатом, что и список;
 *   3. от трёх символов — весь активный парк: аппарат чужой площадки находится, и приходит он
 *      честно помеченным «не ваш»;
 *   4. архив не отдаётся ни одной из двух ручек — ни в выдаче, ни по прямому идентификатору;
 *   5. погашенная карточка по идентификатору приходит с `isActive: false`, а не пропадает;
 *   6. `inOwnScope` и `objectInOwnScope` РАСХОДЯТСЯ на «чужой отдел, своя площадка» — ради этого
 *      случая второй признак и заведён (Р2).
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Все шесть — про то, какие СТРОКИ вернул запрос и какими признаками он их
 * пометил. Область считает предикат в SQL (`officeEquipmentScopeWhere`), вторую ось — площадки
 * отдела, которые принципал собирает подзапросом по `department_construction_objects`, а «не
 * отдаётся» доказывается отсутствием строки. Собранное на заглушках доказывало бы заглушки.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test` (образец — `service-request-candidate-intake.db.test.ts`):
 * половина утверждений здесь про ОТСУТСТВИЕ строки в выдаче («чужого не видно», «архива нет»), а по
 * общей базе идут параллельные прогоны и лежит копия боевого парка — любая чужая карточка с похожим
 * номером сделала бы такое утверждение ложным. База заводится, мигрируется с нуля и сносится в
 * `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/office-equipment-selector.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_selector_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-oe-selector-password-123';
const EQUIPMENT = '/api/v1/office-equipment';
const SELECTOR = '/api/v1/office-equipment/selector';

/**
 * Общее начало имени у всех карточек прогона: по нему идёт КОРОТКИЙ набор («Ky»), которым
 * проверяется сужение областью. Два символа — ровно то, что план называет «не поиск, а праздный
 * просмотр парка».
 */
const SHORT_TERM = 'Ky';

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
  closeDb: () => Promise<void>;
  /** Администратор: заводит карточки на всех площадках — своей объектной оси у роли нет. */
  admin: TestUser;
  /** Заявитель площадки A: у него есть и чтение справочника, и заведение заявок. */
  requester: TestUser;
  /**
   * Наблюдатель (ADR 0033): справочник ему открыт, а заявок он не заводит — `serviceRequests.create`
   * у роли нет вовсе. Единственный субъект, на котором видно, что дверь селектора закрыта ВТОРЫМ
   * правом, а не первым.
   */
  observer: TestUser;
  /**
   * Роль отдела: область справочника у неё по ВЛАДЕЛЬЦУ техники, а площадки — производные, от
   * отдела (ADR 0062). Ради неё и заведён случай «чужой отдел, своя площадка».
   */
  dept: TestUser;
  objectA: string;
  objectB: string;
  ownDepartmentId: string;
  otherDepartmentId: string;
  /** Своя карточка площадки A без владельца: попадает в область и штаба, и отдела. */
  ownId: string;
  /** Чужая целиком: площадка B, владелец — чужой отдел. */
  foreignId: string;
  /** «Чужой отдел, СВОЯ площадка»: стоит на A, числится за чужим отделом. */
  otherDeptOwnSiteId: string;
  /** Погашенная карточка площадки A: в выдаче её нет, а дочитка по id отдаёт. */
  inactiveId: string;
  /** Удалённая (мягко) карточка площадки A: не отдаётся вовсе. */
  archivedId: string;
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
  // S3 и почта тут не участвуют: предмет файла — выдача справочника, а не транспорт.
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

function inject(method: 'GET' | 'POST' | 'DELETE', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface SelectorPage {
  items: OfficeEquipmentRequestOptionDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Страница выдачи под заданным набором. `search` не передаётся вовсе, когда его нет. */
async function options(auth: Auth, search?: string): Promise<SelectorPage> {
  const query = search === undefined ? '' : `?search=${encodeURIComponent(search)}`;
  const res = await inject('GET', `${SELECTOR}${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SelectorPage;
}

/** Дочитка уже выбранного. Возвращается ответ целиком: половина случаев проверяет отказ. */
function picked(auth: Auth, id: string) {
  return inject('GET', `${SELECTOR}/${id}`, auth);
}

async function pickedOk(auth: Auth, id: string): Promise<OfficeEquipmentRequestOptionDto> {
  const res = await picked(auth, id);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentRequestOptionDto;
}

describe.skipIf(!DB_URL)('выдача справочника для выбора предмета заявки (Э2)', () => {
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

    const makeObject = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`SEL-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const objectA = await makeObject('A');
    const objectB = await makeObject('B');

    const makeDepartment = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name) VALUES (${`SELD-${tag}-${RUN}`}, ${`Отдел ${tag} ${RUN}`})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const ownDepartmentId = await makeDepartment('own');
    const otherDepartmentId = await makeDepartment('other');
    /*
     * Площадка своего отдела (ADR 0062, ADR 0144) — та же самая A. Это и есть условие случая 6: у
     * роли отдела площадка совпадает со штабной, а владелец техники — нет.
     */
    await db.execute(sql`
      INSERT INTO department_construction_objects (department_id, construction_object_id)
      VALUES (${ownDepartmentId}, ${objectA})`);

    /*
     * Учётки — прямым SQL: форма учётки предмет своего теста, а здесь она декорация, без которой не
     * разложить три стороны доступа. Наборов полномочий не заводится ни одного, и это существенно:
     * все три права, которыми файл оперирует, дают САМИ роли, и отказ наблюдателю — свойство
     * матрицы (ADR 0021), а не собранного здесь набора.
     */
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-sel-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const requesterUser = await makeUser('req', 'shtab');
    const observerUser = await makeUser('obs', 'observer');
    const deptUser = await makeUser('dept', 'department');

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${requesterUser.id}, ${objectA}), (${observerUser.id}, ${objectA})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${deptUser.id}, ${ownDepartmentId})`);

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
    // Администратор нужен раньше остальных: его руками заводятся все карточки прогона.
    const adminActor = await withAuth(adminUser);
    const adminAuth = adminActor.auth;

    /*
     * Карточки заводятся НАСТОЯЩЕЙ ручкой от лица администратора: у него есть `officeEquipment.write`
     * и нет объектной оси, поэтому одной рукой заводится и своя, и чужая площадка. Имена начинаются
     * одинаково («Kyocera …») — по ним идёт короткий набор; номера различают карточки в длинном.
     */
    async function makeEquipment(
      tag: string,
      opts: { objectId: string; departmentId?: string; isActive?: boolean },
    ): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: EQUIPMENT,
        headers: adminAuth,
        remoteAddress: nextAddress(),
        payload: {
          equipmentTypeId: typeId,
          name: `Kyocera ECOSYS ${tag} ${RUN}`,
          inventoryNumber: `SEL-${RUN}-${tag}`,
          objectId: opts.objectId,
          location: 'кабинет 214',
          ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
          ...(opts.isActive === undefined ? {} : { isActive: opts.isActive }),
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { id: string }).id;
    }

    const ownId = await makeEquipment('OWN', { objectId: objectA });
    const foreignId = await makeEquipment('FAR', {
      objectId: objectB,
      departmentId: otherDepartmentId,
    });
    const otherDeptOwnSiteId = await makeEquipment('MIX', {
      objectId: objectA,
      departmentId: otherDepartmentId,
    });
    const inactiveId = await makeEquipment('OFF', { objectId: objectA, isActive: false });
    const archivedId = await makeEquipment('DEL', { objectId: objectA });
    // Архив — настоящим мягким удалением (Р33), а не проставленной руками колонкой: проверяется то,
    // что увидит выдача от живого справочника.
    const removed = await app.inject({
      method: 'DELETE',
      url: `${EQUIPMENT}/${archivedId}`,
      headers: adminAuth,
      remoteAddress: nextAddress(),
    });
    expect(removed.statusCode, removed.body).toBe(200);

    ctx = {
      app,
      closeDb,
      admin: adminActor,
      requester: await withAuth(requesterUser),
      observer: await withAuth(observerUser),
      dept: await withAuth(deptUser),
      objectA,
      objectB,
      ownDepartmentId,
      otherDepartmentId,
      ownId,
      foreignId,
      otherDeptOwnSiteId,
      inactiveId,
      archivedId,
    };
  }, 300_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению.
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

  // ── 1. Дверь: два права сразу ──

  describe('дверь', () => {
    it('без `serviceRequests.create` обе ручки отвечают 403, хотя справочник открыт', async () => {
      /*
       * Наблюдатель читает весь справочник обычными ручками — и это здесь проверяется первым, иначе
       * отказ ниже нельзя было бы отличить от «модуль ему закрыт вообще». А по селектору он получил
       * бы модель, номера и место любого активного аппарата компании, ничего при этом не заказывая:
       * общекомпанейский поиск открыт тому, кто заводит заявки.
       */
      const card = await inject('GET', `${EQUIPMENT}/${ctx.ownId}`, ctx.observer.auth);
      expect(card.statusCode, card.body).toBe(200);

      const list = await inject('GET', SELECTOR, ctx.observer.auth);
      expect(list.statusCode, list.body).toBe(403);
      const one = await picked(ctx.observer.auth, ctx.ownId);
      expect(one.statusCode, one.body).toBe(403);
    });

    it('заказчику с обоими правами обе ручки открыты', async () => {
      const page = await options(ctx.requester.auth);
      expect(page.page).toBe(1);
      expect(page.total).toBeGreaterThan(0);
      expect((await pickedOk(ctx.requester.auth, ctx.ownId)).id).toBe(ctx.ownId);
    });
  });

  // ── 2–3. Порог в три символа ──

  describe('порог общего поиска', () => {
    it('пусто и короткий набор — только своя область', async () => {
      // Оба вопроса — один и тот же: «набрано меньше трёх символов», в том числе ноль.
      for (const search of [undefined, SHORT_TERM]) {
        const ids = (await options(ctx.requester.auth, search)).items.map((i) => i.id);
        expect(ids, `набор «${search ?? ''}»`).toContain(ctx.ownId);
        // Своя площадка — своя область целиком, даже если техника числится за чужим отделом:
        // у объектной роли ось одна, и она объектная.
        expect(ids, `набор «${search ?? ''}»`).toContain(ctx.otherDeptOwnSiteId);
        // Вот ради этой строки порог и заведён: чужая площадка коротким набором не показывается.
        expect(ids, `набор «${search ?? ''}»`).not.toContain(ctx.foreignId);
      }
    });

    it('от трёх символов находится аппарат чужой площадки — и помечен как чужой', async () => {
      const page = await options(ctx.requester.auth, `SEL-${RUN}-FAR`);
      expect(page.items.map((i) => i.id)).toEqual([ctx.foreignId]);
      const found = page.items[0]!;
      // Признаки честные: аппарат виден, но он не свой ни целиком, ни площадкой.
      expect(found.inOwnScope).toBe(false);
      expect(found.objectInOwnScope).toBe(false);
      // Плашке нужны место и владелец — оба приходят подписями, а не одними идентификаторами.
      expect(found.object.id).toBe(ctx.objectB);
      expect(found.object.code).toContain(`SEL-B-${RUN}`);
      expect(found.ownerDepartment?.id).toBe(ctx.otherDepartmentId);
    });

    it('роли без осей коротким набором отвечает весь парк, и всё в нём — «своё»', async () => {
      /*
       * Администратор — роль, которую область не сужает ничем (предикат отвечает «сужать нечем»).
       * Ветка эта отдельная и в коде, и в SQL: признак `inOwnScope` собирается там не из предиката,
       * а константой, и без этого случая она не проверялась бы ни разу. Заодно видно, что короткий
       * набор сужает выдачу ОБЛАСТЬЮ, а не «прячет чужое от всех подряд».
       */
      const ids = (await options(ctx.admin.auth, SHORT_TERM)).items.map((i) => i.id);
      expect(ids).toContain(ctx.ownId);
      expect(ids).toContain(ctx.foreignId);
      const far = (await options(ctx.admin.auth, `SEL-${RUN}-FAR`)).items[0]!;
      expect(far.inOwnScope).toBe(true);
      expect(far.objectInOwnScope).toBe(true);
    });

    it('своя карточка приходит с обоими признаками «своя»', async () => {
      const own = (await options(ctx.requester.auth, `SEL-${RUN}-OWN`)).items[0]!;
      expect(own.inOwnScope).toBe(true);
      expect(own.objectInOwnScope).toBe(true);
      // Неразмеченная техника — законное состояние справочника, а не пропущенное поле.
      expect(own.ownerDepartment).toBeNull();
    });
  });

  // ── 4–5. Что не отдаётся и что отдаётся помеченным ──

  describe('архив и погашенные', () => {
    it('архив не отдаётся ни выдачей, ни по идентификатору', async () => {
      // Ищется он ПОЛНЫМ номером, то есть длинным набором: короткий сузился бы областью, и
      // пустота ничего не доказывала бы.
      expect((await options(ctx.requester.auth, `SEL-${RUN}-DEL`)).items).toEqual([]);
      const one = await picked(ctx.requester.auth, ctx.archivedId);
      expect(one.statusCode, one.body).toBe(404);
    });

    it('администратору с доступом в архив он тоже не отдаётся: это не вопрос права', async () => {
      /*
       * У администратора есть `archive.read`, и обычная карточка удалённой единицы ему открыта.
       * Здесь другая причина отказа: предметом НОВОЙ заявки удалённая карточка быть не может ни при
       * каких правах, поэтому ручка и не спрашивает `archiveWhere`.
       */
      const card = await inject('GET', `${EQUIPMENT}/${ctx.archivedId}`, ctx.admin.auth);
      expect(card.statusCode, card.body).toBe(200);
      const one = await picked(ctx.admin.auth, ctx.archivedId);
      expect(one.statusCode, one.body).toBe(404);
    });

    it('погашенной нет в выдаче, а по идентификатору она приходит с `isActive: false`', async () => {
      expect((await options(ctx.requester.auth, `SEL-${RUN}-OFF`)).items).toEqual([]);
      const one = await pickedOk(ctx.requester.auth, ctx.inactiveId);
      expect(one.id).toBe(ctx.inactiveId);
      // Устаревший выбор должен быть виден как устаревший: исчезнув, он оставил бы в поле
      // идентификатор без подписи.
      expect(one.isActive).toBe(false);
      expect(one.name).toContain('OFF');
    });

    it('дочитка отдаёт и чужую карточку: выбранное уже выбрано', async () => {
      // Область здесь не спрашивается вовсе (Р3) — прятать от собственной формы то, что она сама и
      // нашла, бессмысленно. Признаки при этом отвечают честно.
      const one = await pickedOk(ctx.requester.auth, ctx.foreignId);
      expect(one.inOwnScope).toBe(false);
      expect(one.objectInOwnScope).toBe(false);
    });
  });

  // ── 6. Ради чего заведён второй признак ──

  describe('роль отдела: чужой отдел, своя площадка', () => {
    it('коротким набором отдел видит только свою технику — площадка его не открывает', async () => {
      const ids = (await options(ctx.dept.auth, SHORT_TERM)).items.map((i) => i.id);
      // Неразмеченная видна роли отдела намеренно: разметить её больше некому.
      expect(ids).toContain(ctx.ownId);
      // А эта стоит на площадке его отдела — и всё равно вне области: у отдельской роли ось по
      // ВЛАДЕЛЬЦУ. Именно поэтому «своя площадка» и потребовала второго признака, а не поблажки в
      // предикате.
      expect(ids).not.toContain(ctx.otherDeptOwnSiteId);
    });

    it('признаки расходятся: карточка не своя, а площадка своя', async () => {
      const found = (await options(ctx.dept.auth, `SEL-${RUN}-MIX`)).items[0]!;
      expect(found.id).toBe(ctx.otherDeptOwnSiteId);
      expect(found.inOwnScope).toBe(false);
      // Тот самый случай Р2: поправку «стоит на другом объекте» включать нельзя — объект тот самый.
      expect(found.objectInOwnScope).toBe(true);
      expect(found.object.id).toBe(ctx.objectA);
      expect(found.ownerDepartment?.id).toBe(ctx.otherDepartmentId);
    });

    it('чужая площадка чужого отдела расходиться не даёт: оба признака «нет»', async () => {
      // Пара признаков обязана различать два случая, а не подсвечивать один и тот же: без этой
      // строки «объект свой» могло бы означать просто «второй признак всегда true».
      const far = (await options(ctx.dept.auth, `SEL-${RUN}-FAR`)).items[0]!;
      expect(far.id).toBe(ctx.foreignId);
      expect(far.inOwnScope).toBe(false);
      expect(far.objectInOwnScope).toBe(false);
    });
  });
});
