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
 * СРОЧНОСТЬ ПРИ ЗАВЕДЕНИИ — ПРАВО, А НЕ УКРАШЕНИЕ ФОРМЫ (план
 * `docs/office-equipment-request-subject-plan.md`, Р9; этап Э1).
 *
 * До этой волны галочку «Срочная заявка» ставил кто угодно: «объявить срочность при подаче — просьба
 * заявителя» (Н1 плана профилей), и очередь наполнялась срочными ровно настолько, насколько бойко
 * жал галочку каждый. Теперь `POST /service-requests` с `isUrgent: true` без права
 * `serviceRequests.urgency` отвечает 403, а `false` принимается всегда и от всех.
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ, И ПОЧЕМУ ЭТО ТРИ СЛУЧАЯ, А НЕ ОДИН. Отказ без права — половина правила;
 * вторая половина в том, что `false` НЕ отбивается: у поля значение по умолчанию, то есть оно
 * приезжает в каждой обычной заявке — и от формы, и от старого клиента, который о срочности не
 * знает вовсе. Проверка «поле прислали» вместо «поле истинно» превратила бы право на срочность в
 * право заводить заявки, и заметил бы это только продакшен.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Утверждения здесь про СТРОКУ и её отсутствие: отказ обязан не оставить
 * заявки вовсе, а разрешённая срочная — лечь в базу срочной, с причиной. Право же берётся не из
 * роли, а из собранного набора (ADR 0106) — то есть из тех самых соединений, которых у мока нет.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: половина утверждений — про количество строк
 * («отказ не завёл заявки»), а по общей базе параллельно идут другие прогоны, и чужая строка сделала
 * бы такое утверждение ложным. База заводится, мигрируется с нуля и сносится в `afterAll` (образец —
 * `service-request-candidate-intake.db.test.ts`).
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/service-request-urgency.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_urgency_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-urgency-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';
/** Отказ дословно: у заведения отказов несколько, и без сверки текста тест зеленел бы на чужом. */
const DENIED = 'Срочность заявке назначает служба';

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
  /** Заводит карточки парка: у него словарь прав целиком. */
  admin: TestUser;
  /** Рядовой заявитель площадки: заявки заводит, срочность объявлять не вправе. */
  requester: TestUser;
  /**
   * Тот же `shtab` и та же площадка — отличается ОДНИМ собранным набором с `serviceRequests.urgency`.
   * Пара учёток нарочно различается только правом: разведи мы их ролями, файл доказывал бы, что
   * дверь открывает должность, а её открывает право.
   */
  manager: TestUser;
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

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, auth: Auth, payload?: unknown) {
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

async function requestCount(): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM service_requests`,
  );
  return res.rows[0]!.n;
}

/** Срочность так, как она легла в базу: DTO собирается из этих же двух колонок. */
async function urgencyRow(id: string) {
  const res = await ctx.db.execute<{ is_urgent: boolean; urgency_reason: string }>(
    sql`SELECT is_urgent, urgency_reason FROM service_requests WHERE id = ${id}`,
  );
  return res.rows[0]!;
}

describe.skipIf(!DB_URL)('срочность при заведении заявки: право, а не просьба', () => {
  /** Своя единица на случай: по одной технике незакрытая заявка бывает только одна (Р21). */
  let unitNo = 0;
  async function freshUnit(): Promise<string> {
    unitNo += 1;
    const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
      equipmentTypeId: ctx.typeId,
      name: `МФУ срочности ${unitNo} ${RUN}`,
      objectId: ctx.objectId,
      location: 'кабинет 214',
      inventoryNumber: `UR-${RUN}-${unitNo}`,
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

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`UR-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-ur-${tag}-${RUN}@example.invalid`;
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
    const manager = await makeUser('manager', 'shtab');
    for (const userId of [requester.id, manager.id]) {
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${userId}, ${objectId})`);
    }

    /*
     * ПРАВО ВЫДАЁТСЯ СОБРАННЫМ НАБОРОМ (ADR 0106), а не подменой роли: в матрице
     * `serviceRequests.urgency` живёт в системном наборе «Оргтехника: ведение», и брать его сюда
     * целиком значило бы притащить вместе с ним `status`, `hold` и деньги — то есть проверять
     * «Ведение», а не срочность. Состав самодостаточен по `PERMISSION_REQUIRES`: срочность требует
     * `serviceRequests.read`, и он в наборе.
     *
     * Строка в `grant_roles` обязательна: права набора считаются соединением с ролями держателя
     * (`grantPermissionsExpr`), и набор без неё не даёт ничего.
     */
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system) VALUES (${`ur_urgency_${RUN}`}, 'Срочность заявок', false)
      RETURNING id`);
    const grantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab')`);
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission) VALUES
        (${grantId}, 'serviceRequests.read'),
        (${grantId}, 'serviceRequests.urgency')`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${manager.id}, ${grantId}, ${adminUser.id}, 'manual')`);

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
      manager: await withAuth(manager),
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

  describe('без права серьёзности не объявляют', () => {
    it('isUrgent: true без права — 403, и ни одной новой строки', async () => {
      /*
       * 403, а не 422 по полю: человек не ошибся ничем — ему просто не положено назначать очередь.
       * Причина в теле есть: без неё схема ответила бы 400 раньше стража, и файл доказывал бы
       * работу схемы там, где проверяется право.
       */
      const before = await requestCount();
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.requester.auth,
        body(await freshUnit(), {
          isUrgent: true,
          urgencyReason: 'Единственный принтер на площадке',
        }),
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().message).toContain(DENIED);
      expect(await requestCount(), 'отказ не завёл заявки').toBe(before);
    });

    it('та же учётка заводит обычную заявку — и полем false, и без поля вовсе', async () => {
      /*
       * ГЛАВНЫЙ ОТРИЦАТЕЛЬНЫЙ КОНТРОЛЬ. `isUrgent: false` — не запрос срочности, а её отсутствие, и
       * приезжает он в КАЖДОЙ заявке формы. Отбей мы его — право на срочность стало бы правом
       * заводить заявки, а «поля нет вовсе» (старый клиент, интеграция) значит ровно то же самое:
       * у поля значение по умолчанию.
       */
      const explicit = await inject(
        'POST',
        REQUESTS,
        ctx.requester.auth,
        body(await freshUnit(), { isUrgent: false, urgencyReason: '' }),
      );
      expect(explicit.statusCode, explicit.body).toBe(201);
      const first = (explicit.json() as { request: ServiceRequestDto }).request;
      expect(first.isUrgent).toBe(false);

      const omitted = await inject('POST', REQUESTS, ctx.requester.auth, body(await freshUnit()));
      expect(omitted.statusCode, omitted.body).toBe(201);
      const second = (omitted.json() as { request: ServiceRequestDto }).request;
      expect(second.isUrgent).toBe(false);
      expect(await urgencyRow(second.id)).toEqual({ is_urgent: false, urgency_reason: '' });
    });
  });

  describe('держатель права', () => {
    it('заводит срочную заявку, и срочность ложится в базу вместе с причиной', async () => {
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.manager.auth,
        body(await freshUnit(), {
          isUrgent: true,
          urgencyReason: 'Единственный принтер на площадке',
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      expect(dto.isUrgent).toBe(true);
      expect(dto.urgencyReason).toBe('Единственный принтер на площадке');
      // Не только в ответе: право открывает запись, а не показ. Пара колонок — то, чем срочность
      // живёт в отборах и в подъёме очереди.
      expect(await urgencyRow(dto.id)).toEqual({
        is_urgent: true,
        urgency_reason: 'Единственный принтер на площадке',
      });
    });

    it('право не заменяет пару «флаг + причина»: срочная без причины — 400 схемы', async () => {
      /*
       * Порядок ответов здесь содержателен: схема отрабатывает РАНЬШЕ обработчика, поэтому
       * незаполненная причина отвечает 400 и держателю права, и всякому другому. Право спрашивается
       * у тела, которое схема уже приняла, — и подменить собой её проверку оно не может.
       */
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.manager.auth,
        body(await freshUnit(), { isUrgent: true }),
      );
      expect(res.statusCode, res.body).toBe(400);
    });
  });
});
