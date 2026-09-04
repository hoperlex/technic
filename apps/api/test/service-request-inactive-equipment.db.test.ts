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
 * ЗАЯВКУ НА ВЫВЕДЕННУЮ ИЗ ЭКСПЛУАТАЦИИ КАРТОЧКУ ЗАВЕСТИ НЕЛЬЗЯ (Н1 и фикс Ф2 плана
 * `docs/office-equipment-candidate-plan.md`, §13).
 *
 * До фикса признак `is_active` при заведении не смотрел никто: сервер брал единицу по `id` и живой
 * строке, а неактивные прятал ПОРТАЛ — параметром `isActive: 'true'` у селектора формы. Запрет
 * держался клиентом, и обходили его двое: прямой запрос мимо портала и устаревший список опций в
 * уже открытой форме.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Проверяемое утверждение — не «маршрут ответил 422», а ГРАНИЦА фикса, и обе
 * её стороны живут в живых данных:
 *
 *   * вход закрывается по строке справочника, которую гасит соседняя ручка модуля
 *     (`PATCH /office-equipment/:id`), а не по значению, подсунутому тесту. Гаси мы признак моком,
 *     тест зеленел бы и в том случае, если бы ручка справочника перестала его писать;
 *   * цикл уже заведённой заявки — это правка, отмена и откат, то есть три РАЗНЫХ ручки поверх
 *     одной строки. «Фикс закрывает только вход» проверяется тем, что все три продолжают работать
 *     на заявке, чью карточку выключили после заведения;
 *   * обращение по гарантии разбирает `resolveWarrantyClaim` — он читает ту же карточку своим
 *     запросом, и «фикс его не задел» доказывается только походом в базу.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: по общей параллельно идут другие прогоны, а здесь
 * есть утверждение про ОТСУТСТВИЕ строки («отказ не завёл заявку»), и чужая строка в тех же
 * таблицах сделала бы его ложным. База заводится, мигрируется с нуля и сносится в `afterAll`
 * (образец — `service-request-without-equipment.db.test.ts`).
 *
 * КОДЫ ОТКАЗОВ РАЗНЫЕ, И РАЗНИЦА СОДЕРЖАТЕЛЬНА:
 *
 *   * **422** — присланное значение не годится по состоянию карточки. Именно оно и проверяется:
 *     403 означало бы «вам не положено» тому, кому положено, а 409 — гонку версий, которой нет;
 *   * **400** — карточки нет вовсе (`Единица оргтехники не найдена`). Соседний код, и он ДОЛЖЕН
 *     оставаться другим: «нет такой» и «есть, но списана» человек лечит по-разному.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/service-request-inactive-equipment.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_inactive_equipment_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-inactive-equipment-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

/** Отказ Ф2 дословно: по тексту видно, что 422 пришёл именно от него, а не от области или пометки. */
const RETIRED_DENIED =
  'Аппарат выведен из эксплуатации: включите карточку в справочнике или выберите другой';

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
  /** Администратор: словарь прав целиком — им гасятся карточки и двигаются статусы. */
  admin: TestUser;
  /** Рядовой заявитель: роль площадки, `serviceRequests.create` от роли. Он и заводит заявки. */
  requester: TestUser;
  objectId: string;
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
    description: 'Не печатает, зажёвывает бумагу',
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

/** Карточка заявки; версию у изменяющих ручек спрашивают именно отсюда (Р30). */
async function card(id: string, auth: Auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function version(id: string, auth: Auth): Promise<number> {
  return (await card(id, auth)).version;
}

/** Смена статуса отменой/откатом: единственная ручка, у которой из данных только причина. */
async function changeStatus(id: string, status: string, reason: string) {
  return inject('PATCH', `${REQUESTS}/${id}/status`, ctx.admin.auth, {
    status,
    reason,
    version: await version(id, ctx.admin.auth),
  });
}

/**
 * Выключение и включение карточки — РУЧКОЙ СПРАВОЧНИКА, а не `UPDATE` в обход маршрута: фикс
 * читает ту самую колонку, которую пишет эта ручка, и подмена её прямым SQL оставила бы связь
 * между ними непроверенной.
 */
async function setActive(equipmentId: string, isActive: boolean): Promise<void> {
  const res = await inject('PATCH', `${EQUIPMENT}/${equipmentId}`, ctx.admin.auth, { isActive });
  expect(res.statusCode, res.body).toBe(200);
  expect((res.json() as { isActive: boolean }).isActive).toBe(isActive);
}

async function requestCount(): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM service_requests`,
  );
  return res.rows[0]!.n;
}

describe.skipIf(!DB_URL)('заявка на неактивную карточку: закрыт вход, а не цикл', () => {
  /**
   * Своя единица на каждый случай. Замок «одна открытая заявка на аппарат» (Р21) общей карточкой
   * связал бы случаи между собой: второй из них получал бы 409 вместо проверяемого ответа, и
   * порядок `it`-блоков стал бы частью утверждения.
   */
  async function makeEquipment(tag: string, warrantyUntil?: string): Promise<string> {
    const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
      equipmentTypeId: ctx.typeId,
      name: `МФУ ${tag} ${RUN}`,
      inventoryNumber: `IA-${tag}-${RUN}`,
      objectId: ctx.objectId,
      location: 'кабинет 214',
      ...(warrantyUntil === undefined ? {} : { warrantyUntil }),
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  /** Карточка, выведенная из эксплуатации: заведена как обычная и выключена ручкой справочника. */
  async function makeRetiredEquipment(tag: string): Promise<string> {
    const id = await makeEquipment(tag);
    await setActive(id, false);
    return id;
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

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`IA-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-ia-${tag}-${RUN}@example.invalid`;
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
    // Площадка нужна обоим по разным причинам: заявителю — как его область, администратору —
    // чтобы карточка справочника заводилась и правилась им же без разговора об области.
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${requester.id}, ${objectId})`);

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
      objectId,
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

  // ── 1. Вход (Ф2) ──

  describe('заведение', () => {
    it('на выведенную из эксплуатации карточку — 422 с путём officeEquipmentId', async () => {
      const retiredId = await makeRetiredEquipment('retired');
      const before = await requestCount();

      const res = await post(ctx.requester.auth, { officeEquipmentId: retiredId });

      // 422, а не 403: право заводить заявку у человека есть — не годится присланное значение.
      expect(res.statusCode, res.body).toBe(422);
      const answer = res.json() as { message: string; fields?: Record<string, string> };
      expect(answer.message).toBe(RETIRED_DENIED);
      // Путь поля обязателен: форма подсвечивает выбор аппарата, а не показывает отказ «вообще».
      expect(answer.fields).toHaveProperty('officeEquipmentId');
      // Ни одной новой строки: отказ стоит до транзакции заведения.
      expect(await requestCount()).toBe(before);
    });

    it('на активную карточку заводится как раньше', async () => {
      // Отрицательный контроль: проверка не должна закрывать обычную дверь модуля.
      const activeId = await makeEquipment('active');
      const dto = await create(ctx.requester.auth, { officeEquipmentId: activeId });
      expect(dto.equipment?.id).toBe(activeId);
      expect(dto.object?.id).toBe(ctx.objectId);
      expect(dto.status).toBe('new');
    });

    it('несуществующая карточка отвечает по-прежнему 400, а не новым 422', async () => {
      /*
       * Два отказа рядом не должны слиться. «Нет такой» человек лечит выбором из справочника, а
       * «есть, но списана» — включением карточки, и один общий ответ отправлял бы половину людей
       * не туда. Заодно это доказывает, что активность проверяется чтением колонки, а не дописана
       * условием в `WHERE`: иначе списанная карточка отвечала бы здешним 400.
       */
      const res = await post(ctx.requester.auth, { officeEquipmentId: randomUUID() });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().fields).toHaveProperty('officeEquipmentId');
    });

    it('включённая обратно карточка снова принимает заявку', async () => {
      // Разблокировка — включением карточки в справочнике (тем же правом `officeEquipment.write`,
      // которым её и выключили), и другого способа фикс не заводит.
      const id = await makeRetiredEquipment('revived');
      const denied = await post(ctx.requester.auth, { officeEquipmentId: id });
      expect(denied.statusCode, denied.body).toBe(422);

      await setActive(id, true);
      const dto = await create(ctx.requester.auth, { officeEquipmentId: id });
      expect(dto.equipment?.id).toBe(id);
    });

    it('заявка на расходники отбивается тем же отказом', async () => {
      /*
       * Вид заявки проверку не различает, и это осознанно: разбор предмета у обоих видов один
       * (`resolveRequestSubject`), а картридж списанному аппарату не возят по той же причине, по
       * которой его не чинят. Случай зафиксирован тестом затем, что план (§13) говорит о заявке
       * вообще, а расходники — вторая дверь в ту же функцию.
       */
      const retiredId = await makeRetiredEquipment('consumable');
      const res = await post(ctx.requester.auth, {
        officeEquipmentId: retiredId,
        kind: 'consumable',
      });
      expect(res.statusCode, res.body).toBe(422);
      expect((res.json() as { message: string }).message).toBe(RETIRED_DENIED);
    });
  });

  // ── 2. Цикл уже заведённой заявки: фикс его не трогает ──

  describe('заявка, заведённая до выключения карточки', () => {
    it('правится, отменяется и откатывается, как если бы карточка была активной', async () => {
      const equipmentId = await makeEquipment('living');
      const dto = await create(ctx.requester.auth, { officeEquipmentId: equipmentId });
      // Карточку гасят как раз тогда, когда аппарат уже уехал по живой заявке: это не выдуманный
      // порядок событий, а тот самый, ради которого граница фикса и проведена.
      await setActive(equipmentId, false);

      // Карточка читается: заявку не прячет ни список, ни прямой заход.
      const seen = await card(dto.id, ctx.requester.auth);
      expect(seen.equipment?.id).toBe(equipmentId);

      // ПРАВКА (`PATCH /:id`) — единицу в ней не меняют вовсе, и активность она не спрашивает.
      const edited = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.requester.auth, {
        description: 'Не печатает; добавили, что мигает лампочка',
        version: await version(dto.id, ctx.requester.auth),
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect((edited.json() as ServiceRequestDto).description).toContain('лампочка');

      // СТАТУСЫ: отмена и откат назад — две разные дуги одной ручки. Заявка ходит по ним обеим.
      const cancelled = await changeStatus(dto.id, 'cancelled', 'Аппарат списали, чинить нечего');
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect((cancelled.json() as { request: ServiceRequestDto }).request.status).toBe('cancelled');

      const back = await changeStatus(dto.id, 'new', 'Вернули: списание отменили');
      expect(back.statusCode, back.body).toBe(200);
      expect((back.json() as { request: ServiceRequestDto }).request.status).toBe('new');
    });

    it('обращение по гарантии правится по-прежнему', async () => {
      /*
       * `resolveWarrantyClaim` читает ту же карточку СВОИМ запросом, и активность он не смотрит ни
       * при заведении, ни при правке. Трогать его фикс не должен: гарантия поставщика переживает
       * вывод аппарата из эксплуатации — списывают как раз сломанное, а спор с поставщиком по уже
       * заведённой заявке ведут после этого.
       */
      const equipmentId = await makeEquipment('warranty', '2099-12-31');
      const dto = await create(ctx.requester.auth, { officeEquipmentId: equipmentId });
      await setActive(equipmentId, false);

      const claimed = await inject('PATCH', `${REQUESTS}/${dto.id}`, ctx.requester.auth, {
        warrantyClaim: { source: 'equipment' },
        version: await version(dto.id, ctx.requester.auth),
      });
      expect(claimed.statusCode, claimed.body).toBe(200);
      expect((claimed.json() as ServiceRequestDto).warrantyClaim?.source).toBe('equipment');
    });
  });
});
