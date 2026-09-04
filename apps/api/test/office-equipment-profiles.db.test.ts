import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantImpactDto, ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Разделение набора ИТ-службы на координацию и работу исполнителем — на живой схеме
 * (план `docs/office-equipment-access-profiles-plan.md`, Р2 и Р4, этап Э6, тесты Т7–Т9;
 * план `docs/office-equipment-executor-access-audit-plan.md`, находка Н1 и этап Э8;
 * миграция `0262_office_equipment_executor_grant.sql`).
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ — три утверждения, ни одно из которых не проверить без базы.
 *
 *   Т7. Ход исполнителя открывает НАЗНАЧЕНИЕ, а не право: держатель настоящего каталожного набора
 *       `office_equipment_executor`, не назначенный на заявку, получает 403 на `start`, `estimate`
 *       и `complete`. Соседний файл (`service-request-flow.db.test.ts`) проверяет то же на
 *       прогонном наборе, собранном руками; здесь предмет другой — что каталог после разделения
 *       собран так, что этот отказ вообще воспроизводится.
 *   Т8. Снятие набора закрывает ход НЕМЕДЛЕННО и **избирательно**: сняли исполнителя — умерли ходы,
 *       сняли ИТ-набор — умерла сквозная область, и одно не тянет за собой другое. История
 *       назначений при этом цела: строка `service_request_executors` — факт заявки, а не
 *       производное от прав.
 *   Т9 (db-часть). Backfill миграции покрывает МНОЖЕСТВО держателей ИТ-набора, а не их количество,
 *       не трогает ручных строк и не выдаёт набор никому сверх этого множества; караул «ИТ ⊆
 *       исполнитель» действительно срывает накат, когда покрытие не сошлось.
 *
 * ПОЧЕМУ БАЗА. Права держателя считает сервер по строкам `grant_permissions` и `grant_roles`
 * (`grantPermissionsExpr`), область — предикаты по строкам заявки, а backfill — SQL миграции.
 * Собранное на моках доказывало бы моки.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ СЛУЧАЙ В `service-request-flow.db`. Тот файл ведёт цикл заявки от
 * лица четырёх сторон и намеренно собирает набор исполнителя ПРОГОННЫМ кодом: состав каталожного
 * набора — не его предмет, и завязка на него сделала бы падение каталога падением цикла. Здесь
 * наоборот: предмет — каталог и выдача, а заявка нужна ровно настолько, чтобы ход было куда делать.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db office-equipment-profiles
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база у db-тестов общая и переживает повторный запуск. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

const EXECUTOR_CODE = 'office_equipment_executor';
const IT_CODE = 'office_equipment_it_approver';
/** Наборы этапа Э7: «Заявитель» заводит миграция D, роли «Ведению» открывает миграция B. */
const REQUESTER_CODE = 'office_equipment_requester';
const OPERATOR_CODE = 'office_equipment_operator';

/**
 * Снимок держателей, backfill и караул — ТЕМ САМЫМ SQL, который поедет в прод.
 *
 * Метки — часть договора с миграцией (см. её комментарий у `>>> BACKFILL`): переименуют их, и
 * `slice` вернул бы мусор либо пустоту, а файл продолжил бы зеленеть, ничего не проверяя. Поэтому
 * их отсутствие — падение с объяснением, а не тихий пропуск.
 *
 * Пересказать те же три шага рядом с тестом нельзя: пересказ зеленел бы ровно до первой правки
 * оригинала, а предмет проверки — именно оригинал. Тот же приём у
 * `auto-parts-stock-grant-cleanup.db.test.ts`, и по той же причине: миграция одноразовая, к моменту
 * прогона она уже накатана, и журнал её второй раз не пустит.
 */
const BACKFILL_SQL = ((): string => {
  const file = readFileSync(
    new URL('../drizzle/0262_office_equipment_executor_grant.sql', import.meta.url),
    'utf8',
  );
  const open = file.indexOf('-- >>> BACKFILL');
  const close = file.indexOf('-- <<< BACKFILL');
  if (open < 0 || close <= open) {
    throw new Error(
      'в миграции 0262 не найден блок между метками «>>> BACKFILL» и «<<< BACKFILL» — ' +
        'тест прогонял бы пустоту вместо снимка, backfill и караула',
    );
  }
  return file.slice(open, close);
})();

/**
 * Десятизначный ИНН по девяти цифрам основы: контрольная считается по весам приказа ФНС, и портал
 * проверяет её на каждом заведении контрагента (`isValidInn`). Выдуманный «77…01» роняет обмен
 * справочниками, который выгружает общую базу целиком, — падением в чужом модуле.
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

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
  /** Отдельное соединение под сцену backfill: она живёт в транзакции, которую тест откатывает. */
  raw: pg.Client;
  /** Администратор: выдаёт и отзывает наборы настоящими ручками. */
  admin: TestUser;
  /** Заказчик — штаб площадки: заводит заявки, вокруг которых всё и вертится. */
  customer: TestUser;
  /** «Ведение» модуля: единственный, кто здесь назначает исполнителей. */
  operator: TestUser;
  /**
   * Внутренний исполнитель НОВОГО ОБРАЗЦА: штаб той же площадки с одним лишь набором
   * `office_equipment_executor`. До этапа Э6 такой учётки не бывало вовсе — право исполнителя
   * выдавалось только вместе со сквозной областью ИТ-набора, и ровно ради него всё делалось.
   */
  executor: TestUser;
  /**
   * Системный администратор целиком: роль отдела, отдел ЗАВЕДОМО ЧУЖОЙ для заявок этого файла, и
   * оба кода профиля. Чужой отдел — не декорация: только на нём видно, что заявки он видит
   * сквозной областью ИТ-набора, а не своей осью.
   */
  itAdmin: TestUser;
  /**
   * Роль БЕЗ СВОЕЙ ОСИ с набором «Заявитель» (Т17, этап Э7): менеджер, у которого нет ни площадки,
   * ни отдела. Ради него набор и заведён (Р6) — он сидит в офисе рядом с принтером, а завести
   * заявку до Э7 не мог вовсе.
   */
  office: TestUser;
  /** Второй заказчик на ВТОРОЙ площадке: без него «видит заявки двух площадок» проверить нечем. */
  customerB: TestUser;
  /**
   * ЧЕТВЁРТЫЙ ПРОФИЛЬ — сервисный центр (Т16): роль `operator` плюс тип контрагента `service`.
   * Наборами он не выдаётся вовсе (Р11), поэтому в фикстуре он выражен ровно тем, чем выражен в
   * модели, — парой «роль + контрагент». Без него «архив закрыт всем ЧЕТЫРЁМ» проверялось бы по
   * трём, а четвёртый — единственный, у кого видимость держится назначением, а не областью.
   */
  serviceUser: TestUser;
  serviceCounterpartyId: string;
  objectId: string;
  objectBId: string;
  itDepartmentId: string;
  executorGrantId: string;
  itGrantId: string;
  requesterGrantId: string;
  operatorGrantId: string;
  /** Своя единица на сценарий: по одной технике незакрытая заявка бывает только одна. */
  newEquipment: (tag: string, objectId?: string) => Promise<string>;
  /** Свежая заявка от заказчика на своей единице. */
  newRequest: (tag: string) => Promise<ServiceRequestDto>;
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
  // S3 и почта тут не участвуют: предмет — каталог и область, а не транспорт.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а входов здесь много. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.62.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

async function login(email: string): Promise<Auth> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/** Предпросмотр последствий: им подтверждается именно этот расчёт — так работает и форма. */
async function preview(
  userId: string,
  operation: 'assign' | 'revoke',
  grantId: string,
): Promise<GrantImpactDto> {
  const res = await inject('POST', `/api/v1/users/${userId}/grants/preview`, ctx.admin.auth, {
    operation,
    grantId,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<GrantImpactDto>();
}

/** Выдача набора настоящей ручкой — с барьерами, журналом и гашением сессий. */
async function assignGrant(userId: string, grantId: string): Promise<void> {
  const { expectedImpactHash } = await preview(userId, 'assign', grantId);
  const res = await inject('POST', `/api/v1/users/${userId}/grants`, ctx.admin.auth, {
    grantId,
    expectedImpactHash,
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Отзыв набора той же дверью — «реестр выдач», а не форма учётки. */
async function revokeGrant(userId: string, grantId: string): Promise<void> {
  const { expectedImpactHash } = await preview(userId, 'revoke', grantId);
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/users/${userId}/grants/${grantId}?expectedImpactHash=${expectedImpactHash}`,
    headers: ctx.admin.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function card(id: string, auth: Auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function version(id: string): Promise<number> {
  return (await card(id, ctx.admin.auth)).version;
}

/** Назначение поимённого исполнителя — рукой «Ведения», как и в жизни. */
async function assignExecutor(requestId: string, userId: string): Promise<void> {
  const res = await inject(
    'PUT',
    `/api/v1/service-requests/${requestId}/executors`,
    ctx.operator.auth,
    { userIds: [userId], serviceCounterpartyId: null, version: await version(requestId) },
  );
  expect(res.statusCode, res.body).toBe(200);
}

/** Строки назначения прямо из таблицы: DTO их показывает, но проверять надо записанное. */
async function executorRows(requestId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM service_request_executors WHERE request_id = ${requestId}`,
  );
  return res.rows.map((r) => r.user_id).sort();
}

/**
 * Загруженный файл строкой в `files`: настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — правила подшивки, а не транспорт. Приём тот же, что в
 * `service-executor-access.db.test.ts`.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`oep/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

const ESTIMATE_ITEMS = [
  { kind: 'service', name: 'Чистка узла подачи', quantity: 1, unitPrice: 900 },
];

describe.skipIf(!DB_URL)('профили модуля «Орг.техника»: разделение набора ИТ-службы', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    const migrator = new pg.Client({ connectionString: DB_URL });
    await migrator.connect();
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OEP-${RUN}`}, ${`Площадка профилей ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;
    // Вторая площадка — ради Т17: «роль без оси видит заявки ДВУХ площадок» проверяется только
    // так, а на одной площадке глобальность чтения неотличима от совпадения области.
    const objectBRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OEP-B-${RUN}`}, ${`Площадка профилей Б ${RUN}`}, 'г Москва, ул Тестовая, д 2')
      RETURNING id`);
    const objectBId = objectBRow.rows[0]!.id;
    const departmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name)
      VALUES (${`OEP-IT-${RUN}`}, ${`Отдел ИТ ${RUN}`})
      RETURNING id`);
    const itDepartmentId = departmentRow.rows[0]!.id;

    async function makeUser(
      tag: string,
      role: string,
      counterpartyId: string | null = null,
    ): Promise<{ id: string; email: string }> {
      const email = `db-oep-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Профиль', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${counterpartyId})
        RETURNING id`);
      return { id: row.rows[0]!.id, email };
    }

    // Подрядчик: контрагент типа `service` и учётка при нём. Прав модуля без контрагента у роли
    // `operator` нет вовсе (§4), поэтому заводятся они только парой.
    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис профилей ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-6)}0`)})
      RETURNING id`);
    const serviceCounterpartyId = counterpartyRow.rows[0]!.id;

    const admin = await makeUser('admin', 'admin');
    const customer = await makeUser('cust', 'shtab');
    const operator = await makeUser('oper', 'shtab');
    const executor = await makeUser('exec', 'shtab');
    const itAdmin = await makeUser('it', 'department');
    const customerB = await makeUser('custb', 'shtab');
    /*
     * Менеджер БЕЗ площадок и без отделов — не упрощение сцены, а условие Т17: своей оси у роли
     * нет, и предикат видимости ей ничего не сужает. Привяжи мы его к площадке, глобальность
     * чтения стала бы неотличима от совпадения области, а страж авторства — от обычного отказа.
     */
    const office = await makeUser('office', 'manager');
    const serviceUser = await makeUser('serv', 'operator', serviceCounterpartyId);

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${executor.id}, ${objectId}), (${customerB.id}, ${objectBId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${itAdmin.id}, ${itDepartmentId})`);

    // «Ведение» — надстройкой через сервис, а не прямой вставкой: с шага 1a реформы (ADR 0106)
    // выдача пишет и `user_role_addons`, и `user_grants` одной транзакцией, а половина записи
    // означала бы права, которых сервер не увидит.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
    });

    const grantIdOf = async (code: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(
        sql`SELECT id FROM grants WHERE code = ${code} AND deleted_at IS NULL`,
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error(`в базе нет набора «${code}»: миграция 0262 не накатана?`);
      return id;
    };
    const executorGrantId = await grantIdOf(EXECUTOR_CODE);
    const itGrantId = await grantIdOf(IT_CODE);
    const requesterGrantId = await grantIdOf(REQUESTER_CODE);
    const operatorGrantId = await grantIdOf(OPERATOR_CODE);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const newEquipment = async (tag: string, atObject = objectId): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
        VALUES (${typeId}, ${`МФУ ${tag} ${RUN}`}, ${`ПР-${RUN}-${tag}`}, ${atObject}, 'кабинет 12')
        RETURNING id`);
      return row.rows[0]!.id;
    };

    const app = await buildApp();
    const raw = new pg.Client({ connectionString: DB_URL });
    await raw.connect();

    ctx = {
      app,
      db,
      closeDb,
      raw,
      admin: { ...admin, auth: { authorization: '' } },
      customer: { ...customer, auth: { authorization: '' } },
      operator: { ...operator, auth: { authorization: '' } },
      executor: { ...executor, auth: { authorization: '' } },
      itAdmin: { ...itAdmin, auth: { authorization: '' } },
      office: { ...office, auth: { authorization: '' } },
      customerB: { ...customerB, auth: { authorization: '' } },
      serviceUser: { ...serviceUser, auth: { authorization: '' } },
      serviceCounterpartyId,
      objectId,
      objectBId,
      itDepartmentId,
      executorGrantId,
      itGrantId,
      requesterGrantId,
      operatorGrantId,
      newEquipment,
      newRequest: async (tag: string) => {
        const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
          officeEquipmentId: await newEquipment(tag),
          description: 'Не печатает',
          responsibleName: 'Иванов Иван Иванович',
          responsiblePhone: '+79990000000',
        });
        expect(res.statusCode, res.body).toBe(201);
        return (res.json() as { request: ServiceRequestDto }).request;
      },
    };

    ctx.admin.auth = await login(admin.email);
    ctx.customer.auth = await login(customer.email);
    ctx.customerB.auth = await login(customerB.email);
    ctx.operator.auth = await login(operator.email);
    ctx.serviceUser.auth = await login(serviceUser.email);

    // Наборы выдаются настоящими ручками — с барьерами и записью в журнал. Профиль ИТ выдаётся
    // ДВУМЯ кодами (Р2): координация плюс работа руками.
    await assignGrant(executor.id, executorGrantId);
    await assignGrant(itAdmin.id, itGrantId);
    await assignGrant(itAdmin.id, executorGrantId);
    // «Заявитель» менеджеру — сама по себе эта выдача и есть половина Т17: до миграции D барьер
    // ответил бы `roleNotAllowed`, потому что строки `grant_roles` под ролью без оси не было.
    await assignGrant(office.id, requesterGrantId);

    // Входы — после выдачи: выдача гасит сессии держателя, и токен, взятый раньше, всё равно умер бы.
    ctx.executor.auth = await login(executor.email);
    ctx.itAdmin.auth = await login(itAdmin.email);
    ctx.office.auth = await login(office.email);
  }, 240_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`ПР-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-oep-%-${RUN}@example.invalid`}`;
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`,
      );
      // Файлы Т17 — за заявками: `files.uploaded_by` ссылается на учётку, и не убери мы их, удаление
      // пользователей ниже упёрлось бы в внешний ключ.
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`oep/${RUN}/%`}`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`ПР-${RUN}-%`}`,
      );
      // Модели заводятся вставкой карточки без `model_id` (миграция 0171) и за карточкой не уходят.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(sql`
        DELETE FROM audit_log
         WHERE entity_type = 'user'
           AND entity_id IN (SELECT id::text FROM users
                              WHERE email LIKE ${`db-oep-%-${RUN}@example.invalid`})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-oep-%-${RUN}@example.invalid`}`,
      );
      // Контрагент — после учёток: `users.counterparty_id` держит его внешним ключом.
      await ctx.db.execute(
        sql`DELETE FROM counterparties WHERE name = ${`Сервис профилей ${RUN}`}`,
      );
      await ctx.db.execute(sql`DELETE FROM departments WHERE code = ${`OEP-IT-${RUN}`}`);
      await ctx.db.execute(
        sql`DELETE FROM construction_objects WHERE code IN (${`OEP-${RUN}`}, ${`OEP-B-${RUN}`})`,
      );
    }
    await ctx?.raw.end();
    await ctx?.closeDb();
  });

  /**
   * Т7 ПЛАНА. Ход исполнителя открывает НАЗНАЧЕНИЕ, а право лишь пускает к ручке.
   *
   * Учётка здесь — та самая, которой до Э6 не бывало: настоящий каталожный набор
   * `office_equipment_executor` и ничего больше сверх роли. Заявку она видит (штаб своей площадки),
   * то есть отказ приходит от коридора, а не от области, — и это ровно та пара, которую разделение
   * обязано было сохранить: «вижу» и «могу ходить» — разные вопросы.
   */
  it('держатель набора исполнителя без назначения не делает ни одного хода (Т7)', async () => {
    const request = await ctx.newRequest('t7');
    // Видит: отказы ниже — не «404, потому что заявка чужая».
    expect((await card(request.id, ctx.executor.auth)).id).toBe(request.id);

    /*
     * Заявка РАСПРЕДЕЛЕНА — на другого человека. Без этого шага отказы читались бы неоднозначно:
     * у нераспределённой заявки сервер отвечает про ЗАЯВКУ («сначала распределяют», 422), а не про
     * субъекта, и 403 про сторону здесь не показать вовсе.
     */
    await assignExecutor(request.id, ctx.itAdmin.id);

    const start = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/start`,
      ctx.executor.auth,
      { version: await version(request.id) },
    );
    expect(start.statusCode, start.body).toBe(403);

    // А назначенный тем же ходом проходит: отказ выше — про назначение, а не про закрытую ручку.
    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/start`,
      ctx.itAdmin.auth,
      { version: await version(request.id) },
    );
    expect(started.statusCode, started.body).toBe(200);

    const estimate = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/estimate`,
      ctx.executor.auth,
      { items: ESTIMATE_ITEMS, version: await version(request.id) },
    );
    expect(estimate.statusCode, estimate.body).toBe(403);

    const complete = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/complete`,
      ctx.executor.auth,
      {
        completedOn: new Date().toISOString().slice(0, 10),
        items: [],
        version: await version(request.id),
      },
    );
    expect(complete.statusCode, complete.body).toBe(403);

    // И заявка осталась там, куда её довёл назначенный: ни один чужой ход не прошёл наполовину.
    expect((await card(request.id, ctx.admin.auth)).status).toBe('in_work');
    expect(await executorRows(request.id)).toEqual([ctx.itAdmin.id]);
  });

  /**
   * Т8, ПЕРВАЯ ПОЛОВИНА: снятие набора исполнителя закрывает ход НЕМЕДЛЕННО, а история назначений
   * остаётся.
   *
   * Порядок важен: сначала назначенный держатель ходит успешно (иначе последующий 403 доказывал бы
   * лишь то, что он и не мог), потом набор снимается — и следующая же ручка отвечает отказом.
   * Сессии гасятся отзывом, поэтому вход повторяется: «немедленно» здесь означает «не дожидаясь
   * ничего, кроме нового токена», а не «старый токен продолжает работать».
   *
   * СТРОКА НАЗНАЧЕНИЯ ПРИ ЭТОМ ЦЕЛА, и это не мелочь: назначение — факт заявки («его позвали
   * чинить»), а не производное от прав. Снеси его отзыв набора — заявка потеряла бы исполнителя
   * молча, а в карточке и в письме-задании осталась бы дыра, которую нечем объяснить.
   */
  it('снятие набора исполнителя закрывает ход, назначение остаётся (Т8)', async () => {
    const request = await ctx.newRequest('t8a');
    await assignExecutor(request.id, ctx.executor.id);
    expect(await executorRows(request.id)).toEqual([ctx.executor.id]);

    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/start`,
      ctx.executor.auth,
      { version: await version(request.id) },
    );
    expect(started.statusCode, started.body).toBe(200);
    expect((started.json() as ServiceRequestDto).status).toBe('in_work');

    await revokeGrant(ctx.executor.id, ctx.executorGrantId);
    ctx.executor.auth = await login(ctx.executor.email);

    const complete = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/complete`,
      ctx.executor.auth,
      {
        completedOn: new Date().toISOString().slice(0, 10),
        items: [],
        version: await version(request.id),
      },
    );
    expect(complete.statusCode, complete.body).toBe(403);

    // Назначение цело — и в таблице, и в карточке.
    expect(await executorRows(request.id)).toEqual([ctx.executor.id]);
    expect((await card(request.id, ctx.admin.auth)).executors.map((e) => e.userId)).toEqual([
      ctx.executor.id,
    ]);
    // Заявку он по-прежнему видит: чтение у него от роли, а не от набора.
    expect((await card(request.id, ctx.executor.auth)).id).toBe(request.id);

    // Возвращаем набор — сцена файла общая, а следующий случай снимает уже ДРУГУЮ половину профиля.
    await assignGrant(ctx.executor.id, ctx.executorGrantId);
    ctx.executor.auth = await login(ctx.executor.email);
  });

  /**
   * Т8, ВТОРАЯ ПОЛОВИНА: снятие ИТ-набора убирает СКВОЗНУЮ ОБЛАСТЬ — и только её.
   *
   * Ради этого случая системный администратор и приписан к чужому отделу: заявка заведена на
   * площадке, к которой он отношения не имеет, и видит он её единственным способом — сквозной
   * областью ИТ-набора (`GRANT_MODULE_WIDE_SCOPE`). Снимаем ИТ-набор — заявка пропадает; второй код
   * профиля при этом остаётся при нём, и ходов он не теряет: их закрывает назначение, а не область.
   *
   * ИМЕННО ЭТА ПАРА И ЕСТЬ РАЗДЕЛЕНИЕ. До Э6 снять одно, оставив другое, было нельзя вовсе: и
   * область, и ходы приходили одним набором.
   */
  it('снятие ИТ-набора убирает сквозную область, набор исполнителя остаётся (Т8)', async () => {
    const request = await ctx.newRequest('t8b');
    // Сквозной областью видит чужую площадку.
    expect((await card(request.id, ctx.itAdmin.auth)).id).toBe(request.id);

    await revokeGrant(ctx.itAdmin.id, ctx.itGrantId);
    ctx.itAdmin.auth = await login(ctx.itAdmin.email);

    /*
     * Отказ приходит ОБЛАСТЬЮ, а не отсутствием записи: `assertServiceRequestVisible` отвечает
     * 403 со словами про отдел. Проверяется и текст — 403 бывает и от прав, а здесь важно, что
     * сработала именно ось: право читать заявки у него никто не отбирал, оно есть и во втором
     * наборе.
     */
    const gone = await inject('GET', `/api/v1/service-requests/${request.id}`, ctx.itAdmin.auth);
    expect(gone.statusCode, gone.body).toBe(403);
    expect(gone.json().message).toContain('заявками своих отделов');

    // А назначение открывает ему ту же заявку обратно — третьей осью видимости (план аудита, Р1),
    // и делает это НАБОР ИСПОЛНИТЕЛЯ, который у него остался.
    await assignExecutor(request.id, ctx.itAdmin.id);
    expect((await card(request.id, ctx.itAdmin.auth)).id).toBe(request.id);
    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/start`,
      ctx.itAdmin.auth,
      { version: await version(request.id) },
    );
    expect(started.statusCode, started.body).toBe(200);

    // Возвращаем профиль целиком: сцена файла общая.
    await assignGrant(ctx.itAdmin.id, ctx.itGrantId);
    ctx.itAdmin.auth = await login(ctx.itAdmin.email);
  });

  /**
   * Т9, DB-ЧАСТЬ: backfill миграции покрывает МНОЖЕСТВО держателей ИТ-набора.
   *
   * Сцена и прогон — внутри транзакции, которую тест ОТКАТЫВАЕТ. Причина не в аккуратности:
   * backfill безусловен по построению — он идёт по всем держателям ИТ-набора в базе, а не по
   * учёткам сцены, — и оставленный закоммиченным, он выдал бы набор чужим фикстурам соседних
   * файлов. Откат делает прогон невидимым снаружи; временная таблица снимка уходит вместе с ним
   * (`ON COMMIT DROP`).
   *
   * Проверяются три обещания миграции разом: каждый держатель ИТ получил исполнителя (множествами,
   * а не счётчиками); ручная строка, выданная раньше, не переписана (`ON CONFLICT DO NOTHING`
   * бережёт её автора); сверх множества держателей ИТ набор не достался никому.
   */
  it('backfill выдаёт исполнителя каждому держателю ИТ-набора и не трогает ручных строк (Т9)', async () => {
    const client = ctx.raw;
    await client.query('BEGIN');
    try {
      const passwordHash = 'x'.repeat(60);
      const made: string[] = [];
      for (const tag of ['a', 'b', 'c']) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
           VALUES ($1, 'Фикстура', 'Backfill', $2, 'shtab'::role, true) RETURNING id`,
          [`db-oep-bf-${tag}-${RUN}@example.invalid`, passwordHash],
        );
        made.push(rows[0]!.id);
      }
      const itGrantId = ctx.itGrantId;
      const executorGrantId = ctx.executorGrantId;
      for (const id of made) {
        await client.query(
          `INSERT INTO user_grants (user_id, grant_id, granted_by, origin) VALUES ($1, $2, $3, 'manual')`,
          [id, itGrantId, ctx.admin.id],
        );
      }
      // Третьему набор исполнителя уже выдан РУКАМИ, и автор у выдачи свой: backfill обязан
      // пройти мимо неё, а не переписать её собой.
      const [, , handmade] = made as [string, string, string];
      await client.query(
        `INSERT INTO user_grants (user_id, grant_id, granted_by, origin) VALUES ($1, $2, $3, 'manual')`,
        [handmade, executorGrantId, ctx.customer.id],
      );

      /** Держатели исполнителя, у которых ИТ-набора нет вовсе, — снимок ДО прогона. */
      const holdersWithoutIt = `SELECT count(*)::text AS count
           FROM user_grants ug
           JOIN grants g ON g.id = ug.grant_id AND g.code = $1
          WHERE NOT EXISTS (
                  SELECT 1 FROM user_grants it JOIN grants gi ON gi.id = it.grant_id
                   WHERE gi.code = $2 AND it.user_id = ug.user_id)`;
      const { rows: before } = await client.query<{ count: string }>(holdersWithoutIt, [
        EXECUTOR_CODE,
        IT_CODE,
      ]);

      await client.query(BACKFILL_SQL);

      const { rows: after } = await client.query<{ count: string }>(holdersWithoutIt, [
        EXECUTOR_CODE,
        IT_CODE,
      ]);
      const { rows: covered } = await client.query<{ user_id: string; granted_by: string | null }>(
        `SELECT ug.user_id, ug.granted_by
           FROM user_grants ug JOIN grants g ON g.id = ug.grant_id
          WHERE g.code = $1 AND ug.user_id = ANY($2)`,
        [EXECUTOR_CODE, made],
      );
      expect(covered.map((r) => r.user_id).sort()).toEqual([...made].sort());
      // Ручная строка цела: автор у неё прежний, а не тот, кто выдавал ИТ-набор.
      expect(covered.find((r) => r.user_id === handmade)!.granted_by).toBe(ctx.customer.id);

      /*
       * Обратная сторона обещания: сверх держателей ИТ backfill не выдал набор НИКОМУ.
       *
       * Считается разницей «до и после», а не нулём. Ноль здесь и не должен получиться: держатели
       * исполнителя без ИТ-набора — законный случай, ради которого разделение и делалось, и сам
       * этот файл такую учётку завёл (`executor`). Проверяется поэтому прибавка: backfill обязан
       * добавить строки только тем, у кого ИТ-набор есть.
       */
      expect(Number(after[0]!.count) - Number(before[0]!.count)).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  /**
   * ВТОРАЯ ПОЛОВИНА Т9: **караул действительно срывает накат**, когда backfill не покрыл держателей.
   *
   * Без этого случая первый доказывал бы только счастливый путь: караул, написанный с ошибкой в
   * условии, молчал бы ровно так же, как сошедшийся. Промах здесь моделируется мягким удалением
   * набора исполнителя — тогда `INSERT` не находит его строки и не вставляет ничего, а держатели
   * ИТ-набора остаются непокрытыми. Реальная причина на проде была бы другой (набор переименовали
   * руками, миграцию порезали пополам), но караулу она безразлична: он смотрит на результат.
   *
   * Транзакция откатывается целиком — мягкое удаление каталожного набора наружу не выходит.
   */
  it('караул срывает накат, если backfill не покрыл держателей ИТ (Т9)', async () => {
    const client = ctx.raw;
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
         VALUES ($1, 'Фикстура', 'Караул', $2, 'shtab'::role, true) RETURNING id`,
        [`db-oep-guard-${RUN}@example.invalid`, 'x'.repeat(60)],
      );
      await client.query(
        `INSERT INTO user_grants (user_id, grant_id, granted_by, origin) VALUES ($1, $2, $3, 'manual')`,
        [rows[0]!.id, ctx.itGrantId, ctx.admin.id],
      );
      await client.query(`UPDATE grants SET deleted_at = now() WHERE code = $1`, [EXECUTOR_CODE]);

      await expect(client.query(BACKFILL_SQL)).rejects.toThrow(
        /Backfill не покрыл держателей ИТ-набора/u,
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  /**
   * Т6 ПЛАНА (§5.1, строки «Принять работу» и «Отменить»; §10): **системный администратор не
   * принимает работу и не отменяет заявку**, и отказывает ему ПРАВО, а не коридор.
   *
   * Профиль здесь настоящий — оба каталожных кода (`office_equipment_it_approver` +
   * `office_equipment_executor`), то есть весь его сегодняшний набор из восьми плюс трёх прав. Ни
   * в одной из двух половин нет `serviceRequests.status`, и это решение, а не пропуск: право
   * открывает ВЕСЬ операторский коридор — приёмку из «Решена» и отмену из любого статуса, — то
   * есть ровно то, что матрица оставляет «Ведению».
   *
   * ПОЛОЖИТЕЛЬНЫЕ КОНТРОЛИ ОБЯЗАТЕЛЬНЫ И СТОЯТ ПЕРВЫМИ: назначение (в том числе себя), ход
   * исполнителя по назначению и заморозка проходят у того же субъекта на той же заявке. Без них
   * два отказа ниже доказывали бы что угодно — вплоть до того, что учётка вообще не работает.
   *
   * Проверяется и ПРИРОДА отказа, а не только код: сообщение не про «шаг другой стороны». Приди
   * отказ от коридора, приёмка открылась бы, стоило кому-нибудь выдать профилю `status` «заодно с
   * заморозкой», — а так падение случится в тот же день.
   */
  it('сисадмин назначает, ходит и откладывает, но не принимает и не отменяет (Т6)', async () => {
    const request = await ctx.newRequest('t6');

    // — Контроль 1: назначает, и назначает СЕБЯ. Право `assign` у координации есть.
    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.itAdmin.auth,
      {
        userIds: [ctx.itAdmin.id],
        serviceCounterpartyId: null,
        version: await version(request.id),
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(await executorRows(request.id)).toEqual([ctx.itAdmin.id]);

    // — Контроль 2: работает исполнителем по назначению — второй код профиля.
    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/start`,
      ctx.itAdmin.auth,
      { version: await version(request.id) },
    );
    expect(started.statusCode, started.body).toBe(200);
    expect((started.json() as ServiceRequestDto).status).toBe('in_work');

    // — Отказ 1: приёмка. Право статуса профилю не выдано ни одной из двух половин.
    const accept = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/accept`,
      ctx.itAdmin.auth,
      { version: await version(request.id) },
    );
    expect(accept.statusCode, accept.body).toBe(403);
    expect(accept.json<{ message: string }>().message).not.toContain('шаг другой стороны');

    // — Отказ 2: отмена. Та же дверь `serviceRequests.status`, и «с причиной» её не открывает.
    const cancel = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.itAdmin.auth,
      {
        status: 'cancelled',
        reason: 'Решили не чинить',
        version: await version(request.id),
      },
    );
    expect(cancel.statusCode, cancel.body).toBe(403);
    expect(cancel.json<{ message: string }>().message).not.toContain('шаг другой стороны');

    // — Контроль 3: заморозка проходит. Отказы выше — про два конкретных хода, а не про статусы
    // вообще: `hold` — своё право, и оно у профиля есть.
    const held = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/hold`,
      ctx.itAdmin.auth,
      { reason: 'Ждём картридж', version: await version(request.id) },
    );
    expect(held.statusCode, held.body).toBe(200);
    expect((held.json() as ServiceRequestDto).status).toBe('on_hold');
    // Заявка не отменена и не принята: ни один из двух отказов не прошёл наполовину.
    expect((await card(request.id, ctx.admin.auth)).status).toBe('on_hold');
  });

  /**
   * Т16 ПЛАНА (§5.1 и §5.2, строки «Архив: смотреть удалённые», «Архив: восстановить»,
   * «Уничтожить насовсем»; §10): **архив закрыт всем четырём профилям**.
   *
   * Четыре профиля здесь настоящие и выражены каждый своим способом (Р2): «Заявитель» — кодом
   * набора у роли без оси, «Ведение» — кодом набора, «Системный администратор» — парой кодов,
   * «Сервисный центр» — парой «роль `operator` + тип контрагента `service`». Пятого способа в
   * модели нет, и потому перебор полон.
   *
   * ПРОВЕРЯЕТСЯ ИМЕННО ПОТЕРЯ ВИДИМОСТИ, а не её отсутствие: до удаления заявку видят все четверо
   * (подрядчик — по назначению, остальные — областью либо её отсутствием), и только удаление
   * закрывает её всем. Без этого шага 404 читался бы как «заявка и так была чужой».
   *
   * ОТВЕТ РАЗНЫЙ, И РАЗНИЦА ОСМЫСЛЕННА. Удалённая заявка — 404 (`assertArchiveVisible`): о
   * существовании архивной записи под известным id знать не нужно. Удалённая единица справочника —
   * 404 тем, у кого право справочника есть, и 403 подрядчику: у него закрыт весь модуль (Т5), и
   * ответить ему 404 значило бы сообщить, что такая карточка бывает.
   *
   * `restore` и `purge` закрыты не областью, а правами `archive.restore` и `records.purge`:
   * первого нет ни у одного профиля, второе невыдаваемо вовсе (`NON_GRANTABLE_PERMISSIONS`).
   */
  it('архив закрыт всем четырём профилям: 404 на запись, 403 на возврат и уничтожение (Т16)', async () => {
    const request = await ctx.newRequest('t16');
    // Назначение подрядчику — единственный способ сделать заявку видимой четвёртому профилю:
    // область у него считается по контрагенту, а не по площадке (§6.3).
    const assigned = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/executors`,
      ctx.operator.auth,
      {
        userIds: [],
        serviceCounterpartyId: ctx.serviceCounterpartyId,
        version: await version(request.id),
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);

    const four: [string, Auth][] = [
      ['заявитель', ctx.office.auth],
      ['ведение', ctx.operator.auth],
      ['сисадмин', ctx.itAdmin.auth],
      ['сервис', ctx.serviceUser.auth],
    ];

    // — До удаления заявку видят все четверо: иначе 404 ниже ничего не доказывал бы.
    for (const [who, auth] of four) {
      const res = await inject('GET', `/api/v1/service-requests/${request.id}`, auth);
      expect(res.statusCode, `${who} до удаления: ${res.body}`).toBe(200);
    }

    // Удаляет «Ведение» — своим правом и по своей области; заявка ещё «Новая» (Р14).
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/service-requests/${request.id}`,
      headers: ctx.operator.auth,
    });
    expect(removed.statusCode, removed.body).toBe(200);

    for (const [who, auth] of four) {
      const res = await inject('GET', `/api/v1/service-requests/${request.id}`, auth);
      expect(res.statusCode, `${who} после удаления: ${res.body}`).toBe(404);
      // История — вторая дверь к той же записи, и закрыта она тем же ответом: иначе лента
      // рассказала бы про заявку, карточка которой отвечает «не найдена».
      const history = await inject('GET', `/api/v1/service-requests/${request.id}/history`, auth);
      expect(history.statusCode, `${who}, история: ${history.body}`).toBe(404);

      const restore = await inject('POST', `/api/v1/service-requests/${request.id}/restore`, auth);
      expect(restore.statusCode, `${who}, возврат: ${restore.body}`).toBe(403);

      const purge = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/service-requests/${request.id}/purge`,
        headers: auth,
      });
      expect(purge.statusCode, `${who}, уничтожение: ${purge.body}`).toBe(403);
    }
    // И запись на месте: четыре пары отказов ничего не тронули — вернуть её сможет администратор.
    const stillThere = await inject(
      'GET',
      `/api/v1/service-requests/${request.id}`,
      ctx.admin.auth,
    );
    expect(stillThere.statusCode, stillThere.body).toBe(200);

    // — Вторая половина: справочник. Единица берётся своя и без заявок — иначе её удаление
    // упёрлось бы в незакрытую заявку (Р33), то есть в чужое правило.
    const unitId = await ctx.newEquipment('t16u');
    const unitGone = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/office-equipment/${unitId}`,
      headers: ctx.operator.auth,
    });
    expect(unitGone.statusCode, unitGone.body).toBe(200);

    for (const [who, auth] of four) {
      const res = await inject('GET', `/api/v1/office-equipment/${unitId}`, auth);
      // Подрядчику — 403: у него закрыт весь модуль справочника (Т5), и архив тут ни при чём.
      const expected = who === 'сервис' ? 403 : 404;
      expect(res.statusCode, `${who}, карточка единицы: ${res.body}`).toBe(expected);

      const restore = await inject('POST', `/api/v1/office-equipment/${unitId}/restore`, auth);
      expect(restore.statusCode, `${who}, возврат единицы: ${restore.body}`).toBe(403);

      const purge = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/office-equipment/${unitId}/purge`,
        headers: auth,
      });
      expect(purge.statusCode, `${who}, уничтожение единицы: ${purge.body}`).toBe(403);
    }
  });

  /**
   * Т17 ПЛАНА, ГЛАВНОЕ УТВЕРЖДЕНИЕ ЭТАПА Э7: **роль без своей оси получает глобальное ЧТЕНИЕ, но не
   * чужие действия** (план `docs/office-equipment-access-profiles-plan.md`, Р6 и §10, Т17; страж
   * `actsAsRequestCustomer`; миграции B и D).
   *
   * Сцена: менеджер без площадок и без отделов с одним набором «Оргтехника: заявитель». Такой
   * учётки до Э7 не бывало вовсе — набора не существовало, а без него у менеджера нет ни одного
   * права модуля заявок.
   *
   * Проверяются ТРИ РАЗНЫЕ ВЕЩИ, и разводить их обязательно:
   *
   *   1. ЧТЕНИЕ ГЛОБАЛЬНО, и это действующая модель, а не дыра: у роли без оси предикат видимости
   *      не сужает ничего — так работает всякое её право во всяком модуле. Проверяется на ДВУХ
   *      площадках сразу: на одной глобальность неотличима от совпадения области;
   *   2. ИЗМЕНЯЮЩИЕ ДЕЙСТВИЯ СУЖЕНЫ ДО СВОИХ СТРОК. Правка, удаление, подшивка и письмо от лица
   *      заказчика на ЧУЖОЙ, глобально видимой заявке дают 403; на своей — проходят. Отказ приходит
   *      не от области (заявка видна) и не от права (право есть) — от стража авторства;
   *   3. ДВА НАБОРА НЕ СМЕШИВАЮТСЯ. Тот же человек с «Ведением» получает полные операторские
   *      действия на чужой заявке: правило автора «Ведения» не касается вовсе (Р6), иначе
   *      централизованное ведение перестало бы работать в тот же день, когда его разрешили.
   *
   * Порядок внутри теста поэтому жёсткий: сперва всё, что доказывается ОДНИМ набором, и только
   * потом выдача второго — обратно её в этом файле не отматывают.
   */
  it('роль без оси: чтение глобально, чужие действия закрыты, свои — нет (Т17)', async () => {
    const foreign = await ctx.newRequest('t17a');
    // Чужая заявка ВТОРОЙ площадки, заведённая другим человеком: обе оси мимо менеджера.
    const foreignBRes = await inject('POST', '/api/v1/service-requests', ctx.customerB.auth, {
      officeEquipmentId: await ctx.newEquipment('t17b', ctx.objectBId),
      description: 'Мнёт бумагу',
      responsibleName: 'Петров Пётр Петрович',
      responsiblePhone: '+79990000001',
    });
    expect(foreignBRes.statusCode, foreignBRes.body).toBe(201);
    const foreignB = (foreignBRes.json() as { request: ServiceRequestDto }).request;

    // — 1. Чтение: обе площадки видны, и карточка отдаётся по каждой.
    const list = await inject('GET', '/api/v1/service-requests?limit=100', ctx.office.auth);
    expect(list.statusCode, list.body).toBe(200);
    const seen = new Set((list.json() as { items: ServiceRequestDto[] }).items.map((r) => r.id));
    expect(seen.has(foreign.id), 'заявка своей площадки заказчика не видна роли без оси').toBe(
      true,
    );
    expect(seen.has(foreignB.id), 'заявка второй площадки не видна роли без оси').toBe(true);
    expect((await card(foreignB.id, ctx.office.auth)).id).toBe(foreignB.id);

    // — 2. Чужие изменяющие действия: 403 стражем авторства, а не областью и не правом.
    const foreignVersion = await version(foreignB.id);
    const patchForeign = await inject(
      'PATCH',
      `/api/v1/service-requests/${foreignB.id}`,
      ctx.office.auth,
      { description: 'Правка чужой заявки', version: foreignVersion },
    );
    expect(patchForeign.statusCode, patchForeign.body).toBe(403);
    expect(patchForeign.json<{ message: string }>().message).toMatch(/завёл сам/u);

    const deleteForeign = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/service-requests/${foreignB.id}`,
      headers: ctx.office.auth,
    });
    expect(deleteForeign.statusCode, deleteForeign.body).toBe(403);

    /*
     * Подшивка. Файл загружен ЗАРАНЕЕ и от имени менеджера: страж авторства стоит на общем входе
     * изменяющих ручек, то есть ДО разбора файла, — и не будь его, ручка дошла бы до вставки.
     * Проверяется именно 403, а не «какая-нибудь ошибка».
     */
    const fileForForeign = await uploadedFile(ctx.office.id, 'чужая-заявка.pdf');
    const attachForeign = await inject(
      'POST',
      `/api/v1/service-requests/${foreignB.id}/files`,
      ctx.office.auth,
      { fileIds: [fileForForeign], kind: 'attachment' },
    );
    expect(attachForeign.statusCode, attachForeign.body).toBe(403);

    // Письмо от лица заказчика по чужой заявке: участником разговора менеджер там не является.
    const chatForeign = await inject(
      'POST',
      `/api/v1/service-requests/${foreignB.id}/messages`,
      ctx.office.auth,
      { body: 'Пишу по чужой заявке', addressees: { sides: ['all'], users: [] } },
    );
    expect(chatForeign.statusCode, chatForeign.body).toBe(403);

    // — 3. Свои действия проходят целиком: набор выдан ради них.
    const mineRes = await inject('POST', '/api/v1/service-requests', ctx.office.auth, {
      officeEquipmentId: await ctx.newEquipment('t17c'),
      description: 'Принтер в приёмной не печатает',
      responsibleName: 'Сидоров Сидор Сидорович',
      responsiblePhone: '+79990000002',
    });
    expect(mineRes.statusCode, mineRes.body).toBe(201);
    const mine = (mineRes.json() as { request: ServiceRequestDto }).request;

    const patchMine = await inject(
      'PATCH',
      `/api/v1/service-requests/${mine.id}`,
      ctx.office.auth,
      { description: 'Принтер в приёмной не печатает совсем', version: mine.version },
    );
    expect(patchMine.statusCode, patchMine.body).toBe(200);

    const fileMine = await uploadedFile(ctx.office.id, 'своя-заявка.pdf');
    const attachMine = await inject(
      'POST',
      `/api/v1/service-requests/${mine.id}/files`,
      ctx.office.auth,
      { fileIds: [fileMine], kind: 'attachment' },
    );
    expect(attachMine.statusCode, attachMine.body).toBe(200);

    const detachMine = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/service-requests/${mine.id}/files/${fileMine}`,
      headers: ctx.office.auth,
    });
    expect(detachMine.statusCode, detachMine.body).toBe(200);

    const chatMine = await inject(
      'POST',
      `/api/v1/service-requests/${mine.id}/messages`,
      ctx.office.auth,
      { body: 'Аппарат в приёмной, второй этаж', addressees: { sides: ['all'], users: [] } },
    );
    expect(chatMine.statusCode, chatMine.body).toBe(200);

    /*
     * И то, чем портал узнаёт ответ: сводка обсуждения отдаёт сторону `customer` на СВОЕЙ заявке и
     * не отдаёт на чужой. `ServiceRequestDto` не раскрывает `createdBy` (решение плана карточки), и
     * авторства портал вывести не может — он берёт его отсюда и зовёт тот же контрактный предикат.
     */
    expect((await card(mine.id, ctx.office.auth)).chat.participantSides).toContain('customer');
    expect((await card(foreignB.id, ctx.office.auth)).chat.participantSides).not.toContain(
      'customer',
    );

    const deleteMine = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/service-requests/${mine.id}`,
      headers: ctx.office.auth,
    });
    expect(deleteMine.statusCode, deleteMine.body).toBe(200);
  });

  /**
   * Т17, ВТОРАЯ ПОЛОВИНА: **«Ведение» и «Заявитель» не смешиваются** (Р6). Тому же менеджеру
   * выдаётся набор «Оргтехника: ведение» (миграция B открыла ему эту выдачу), и правило автора
   * перестаёт его касаться вовсе: он ведёт ЧУЖИЕ заявки — ради этого профиль и существует.
   *
   * Стоит отдельным случаем и после первого намеренно: выдача второго набора в этом файле обратно
   * не отматывается, а первый случай обязан идти при одном наборе.
   */
  it('тот же человек с «Ведением» получает полные операторские действия (Т17)', async () => {
    const foreign = await ctx.newRequest('t17d');

    await assignGrant(ctx.office.id, ctx.operatorGrantId);
    // Выдача гасит сессии держателя — токен, взятый раньше, уже мёртв.
    ctx.office.auth = await login(ctx.office.email);

    // Правка чужой «Новой» — та самая, что минуту назад отвечала 403.
    const patch = await inject('PATCH', `/api/v1/service-requests/${foreign.id}`, ctx.office.auth, {
      description: 'Уточнение от того, кто ведёт модуль',
      version: await version(foreign.id),
    });
    expect(patch.statusCode, patch.body).toBe(200);

    // Срочность — право «Ведения», и заявителю оно не выдано ни одной строкой каталога.
    const urgency = await inject(
      'PATCH',
      `/api/v1/service-requests/${foreign.id}/urgency`,
      ctx.office.auth,
      { isUrgent: true, urgencyReason: 'Стоит приёмная', version: await version(foreign.id) },
    );
    expect(urgency.statusCode, urgency.body).toBe(200);

    // Назначение исполнителя — второе операторское решение, и оно тоже про чужую заявку.
    const assign = await inject(
      'PUT',
      `/api/v1/service-requests/${foreign.id}/executors`,
      ctx.office.auth,
      {
        userIds: [ctx.executor.id],
        serviceCounterpartyId: null,
        version: await version(foreign.id),
      },
    );
    expect(assign.statusCode, assign.body).toBe(200);
    expect(await executorRows(foreign.id)).toEqual([ctx.executor.id]);

    /*
     * И сторона обсуждения: с кодом «Ведения» тот же человек стал `operator` — на ЧУЖОЙ заявке,
     * где стороной заказчика он не был и не станет. Два слоя видны здесь рядом: сторону даёт код
     * набора (Р9), а не роль, область или авторство.
     */
    const sides = (await card(foreign.id, ctx.office.auth)).chat.participantSides;
    expect(sides).toContain('operator');
    expect(sides).not.toContain('customer');
  });
});
