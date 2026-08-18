import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  WAYBILL_CORRECTION_DAYS,
  weekStartKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Даты заявок задним числом (ADR 0101, Р6 и Р15, этап 3 плана).
 *
 * Живой схемой и настоящим HTTP-путём, потому что предмет проверки — не предикат (его стерегут
 * `waybill-correction.test.ts` и `request-time.test.ts`), а сцепка предиката с правами субъекта,
 * транзакцией операции и уникальным индексом ключа идемпотентности.
 *
 * Проверяется ровно то, что легко сломать незаметно:
 *
 * - **кому открыто прошлое**: у менеджера прав нет вовсе (403), у диспетчера тридцать дней (за
 *   ними 422), у администратора границы нет. Ошибка здесь не роняет запрос, а тихо меняет, кому
 *   что позволено;
 * - **когда guard срабатывает** (Р29): правка комментария у вчерашней заявки права не требует, а
 *   правка её даты требует. Спутать эти два случая — значит либо запереть дневную работу, либо
 *   открыть прошедший день всем;
 * - **след операции** (Р16): причина, автор и вид `request_date` в `waybill_corrections`, связь с
 *   заявкой в `vehicle_request_corrections`. Без него у правки бланка нет обоснования;
 * - **идемпотентность** (Р31): повтор возвращает ту же заявку, а не заводит вторую;
 * - **отработанная неделя ЭСМ-2**: сдвиг начала срока в прошедшую неделю отклоняется с перечнем
 *   недель, а не выполняется молча (этап 6 плана — перевыписка такой недели).
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой человек у файла: база db-тестов общая, и работник ищется по СНИЛС — он его ключ. */
const DRIVER_SNILS = '44444444480';
const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-backdate-admin@example.invalid';
const DISPATCHER_EMAIL = 'db-backdate-dispatcher@example.invalid';
const MANAGER_EMAIL = 'db-backdate-manager@example.invalid';
const REVOKED_EMAIL = 'db-backdate-revoked@example.invalid';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  /** Три субъекта: у администратора глубина без предела, у диспетчера 30 дней, у менеджера прав нет. */
  admin: { authorization: string };
  dispatcher: { authorization: string };
  manager: { authorization: string };
  dispatcherId: string;
  /**
   * Четвёртый субъект — диспетчер, у которого право отбирают прямо посреди случая (Р31, ADR 0101
   * п. 9). Своя учётка, а не общий `dispatcher`: роль меняется в базе, и соседние случаи файла не
   * должны зависеть от того, успел ли этот вернуть её обратно.
   */
  revoked: { authorization: string };
  revokedId: string;
  vehicle: { id: string; typeId: string; categoryId: string | null };
  objectId: string;
  personId: string;
  today: string;
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
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Учётка с ролью: права у трёх субъектов разные, и в этом весь смысл файла. */
async function seedUser(email: string, role: 'admin' | 'dispatcher' | 'manager'): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${email}`);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: role,
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Машинист: на него выписываются недельные листы ЭСМ-2 при переводе заявки в работу. */
async function seedPerson(): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.snils} = ${DRIVER_SNILS}`);
  if (existing) return existing.id;

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: 'Задним',
        middleName: 'Числович',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест дат задним числом',
      })
      .returning({ id: schema.persons.id });
    const personId = created!.id;
    await tx.insert(schema.personSpecializations).values({
      personId,
      specializationId: specialization!.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });
    await tx.insert(schema.personEmployments).values({
      personId,
      employmentType: 'staff',
      personnelNo: 'Т-402',
      jobTitle: 'Машинист',
      startedOn: '2024-01-15',
    });
    return personId;
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Тело заказа техники на объект: своё здесь только срок и то, что относится к заднему числу. */
function specialBody(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    requestType: 'special_equipment',
    objectId: ctx.objectId,
    vehicleTypeId: ctx.vehicle.typeId,
    vehicleCategoryId: ctx.vehicle.categoryId,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  };
}

async function create(auth: { authorization: string }, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: auth,
    payload,
  });
}

async function patch(
  auth: { authorization: string },
  id: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: auth,
    payload,
  });
}

/** Заявка глазами карточки — ею проверяется, что отказ ничего не изменил. */
async function read(id: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${id}`,
    headers: ctx.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; version: number; dateFrom: string; comment: string };
}

/** Строки операций по ключу: их обязана быть ровно одна, сколько бы раз запрос ни повторили. */
async function correctionsOf(operationId: string) {
  const rows = await ctx.db.execute<{
    id: string;
    kind: string;
    reason: string;
    actor_user_id: string;
    payload: Record<string, unknown>;
  }>(
    sql`SELECT id, kind, reason, actor_user_id, payload FROM waybill_corrections
        WHERE operation_id = ${operationId}`,
  );
  return rows.rows;
}

/** Заявки, которых операция коснулась (Р16): по ним со стороны заявки читают «что с ней делали». */
async function linkedRequests(correctionId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ request_id: string }>(
    sql`SELECT request_id FROM vehicle_request_corrections WHERE correction_id = ${correctionId}`,
  );
  return rows.rows.map((r) => r.request_id);
}

describe.skipIf(!DB_URL)('даты заявок задним числом (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    await seedUser(ADMIN_EMAIL, 'admin');
    const dispatcherId = await seedUser(DISPATCHER_EMAIL, 'dispatcher');
    await seedUser(MANAGER_EMAIL, 'manager');
    // Прежний прогон мог оборваться посреди случая с отобранным правом — роль возвращается на
    // место при подготовке, а не только в `finally`: учётка переиспользуется между прогонами.
    const revokedId = await seedUser(REVOKED_EMAIL, 'dispatcher');
    const personId = await seedPerson();

    const { buildApp } = await import('../src/app');
    const { db } = await import('../src/db/client');
    const app = await buildApp();

    // Роль возвращается на место и здесь: `seedUser` заведённую учётку не переписывает, а прежний
    // прогон мог оборваться между двумя попытками случая с отобранным правом.
    await db.execute(sql`UPDATE users SET role = 'dispatcher' WHERE id = ${revokedId}`);

    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };

    // Порядок по `id` — чтобы соседний db-тест, берущий «первую попавшуюся» машину, не боролся с
    // этим за одну и ту же единицу: база у тестов общая.
    const vehicles = await db.execute<{ id: string; type_id: string; category_id: string | null }>(
      sql`
        SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
          AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
          AND vt.is_linear = false
        ORDER BY v.id DESC
        LIMIT 1`,
    );
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id DESC LIMIT 1`,
    );
    const vehicle = vehicles.rows[0];
    const object = objects.rows[0];
    if (!vehicle || !object) {
      throw new Error('В базе нет своей спецтехники или объекта: миграции наполнения не применены');
    }

    ctx = {
      app,
      db,
      admin: await login(ADMIN_EMAIL),
      dispatcher: await login(DISPATCHER_EMAIL),
      manager: await login(MANAGER_EMAIL),
      dispatcherId,
      revoked: await login(REVOKED_EMAIL),
      revokedId,
      vehicle: { id: vehicle.id, typeId: vehicle.type_id, categoryId: vehicle.category_id },
      objectId: object.id,
      personId,
      today: moscowDateKeyOf(new Date()),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    /*
     * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь каждый
     * случай заводит заказ — за прогон в ней оседало по десятку заказов и по десятку следов
     * операций.
     *
     * Метка — собственные учётки файла: всё, что тут заводится, заводят они, а чужого под ними не
     * бывает. Списком заведённого уборка не пользуется намеренно — прибирать надо и за упавшим
     * прогоном, который до записи в список мог не дойти. Сами учётки уборка не трогает: их
     * `beforeAll` ищет по адресам и заводит один раз на все прогоны — он же возвращает на место
     * роль той, у которой право отбирали.
     *
     * Порядок обратен ссылкам: лист держит заказ и рейс ключами `restrict`, состав рейса — заказ,
     * след операции — автора. Связь следа с заказом, детали и история заказа уходят каскадом со
     * своей головной строкой.
     *
     * Человек и его документы остаются: он ищется по СНИЛС и заводится один раз на все прогоны —
     * то есть не накапливается.
     */
    const ourUsers = sql`
      SELECT id FROM users
      WHERE email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL}, ${MANAGER_EMAIL}, ${REVOKED_EMAIL})`;
    const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
    await ctx.db.execute(sql`
      DELETE FROM waybills
      WHERE source_request_id IN (${ourRequests})
         OR id IN (SELECT waybill_id FROM waybill_requests WHERE request_id IN (${ourRequests}))
         OR route_id IN (SELECT id FROM vehicle_routes
                          WHERE source_request_id IN (${ourRequests}))`);
    await ctx.db.execute(sql`
      DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
    await ctx.db.execute(sql`
      DELETE FROM vehicle_routes WHERE source_request_id IN (${ourRequests})`);
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
    await ctx.db.execute(sql`
      DELETE FROM waybill_corrections WHERE actor_user_id IN (${ourUsers})`);
    // Журнал — по автору: писали в него только здешние учётки, а видов записей у них несколько.
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
  }, 60_000);

  describe('заведение задним числом (Р15)', () => {
    it('без права прошлое закрыто, даже с объяснением', async () => {
      const yesterday = shiftDateKey(ctx.today, -1);
      const res = await create(
        ctx.manager,
        specialBody({
          dateFrom: yesterday,
          dateTo: yesterday,
          backdateReason: 'техника вышла вчера, заявку оформили сегодня',
          operationId: uuid(),
        }),
      );
      // 403, а не 422: причина здесь есть, не хватает именно права — и это поручение другому
      // человеку, а не самому просителю (Р29, коды отказов).
      expect(res.statusCode, res.body).toBe(403);
    });

    it('с правом и причиной заявка заводится и оставляет запись операции', async () => {
      const yesterday = shiftDateKey(ctx.today, -1);
      const operationId = uuid();
      const res = await create(
        ctx.dispatcher,
        specialBody({
          dateFrom: yesterday,
          dateTo: yesterday,
          backdateReason: 'техника вышла вчера, заявку оформили сегодня',
          operationId,
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const request = res.json();
      expect(request.dateFrom).toBe(yesterday);

      const [correction] = await correctionsOf(operationId);
      expect(correction, 'заведение задним числом заводит строку операции').toBeDefined();
      expect(correction!.kind).toBe('request_date');
      expect(correction!.reason).toBe('техника вышла вчера, заявку оформили сегодня');
      expect(correction!.actor_user_id).toBe(ctx.dispatcherId);
      // Связь с заявкой — то единственное, чем «что делали с этой заявкой задним числом»
      // отвечается со стороны самой заявки.
      expect(await linkedRequests(correction!.id)).toEqual([request.id]);
    });

    it('сегодняшняя заявка операцией не является — ни ключа, ни записи', async () => {
      const res = await create(ctx.dispatcher, specialBody({ dateFrom: ctx.today }));
      expect(res.statusCode, res.body).toBe(201);
      const rows = await ctx.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM vehicle_request_corrections
            WHERE request_id = ${res.json().id}`,
      );
      expect(Number(rows.rows[0]!.n)).toBe(0);
    });

    it('без ключа операции задний день не заводится: повтор сжёг бы вторую заявку', async () => {
      const yesterday = shiftDateKey(ctx.today, -1);
      const res = await create(
        ctx.dispatcher,
        specialBody({ dateFrom: yesterday, dateTo: yesterday, backdateReason: 'вышли вчера' }),
      );
      expect(res.statusCode, res.body).toBe(422);
    });

    it('глубже тридцати дней — предел диспетчера, но не администратора (Р37)', async () => {
      const deep = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 10));
      const body = specialBody({
        dateFrom: deep,
        dateTo: deep,
        backdateReason: 'заявку нашли в тетради спустя полтора месяца',
      });

      const denied = await create(ctx.dispatcher, { ...body, operationId: uuid() });
      // 422, а не 403: право у диспетчера есть — не хватает глубины, и чинит это администратор.
      expect(denied.statusCode, denied.body).toBe(422);

      const allowed = await create(ctx.admin, { ...body, operationId: uuid() });
      expect(allowed.statusCode, allowed.body).toBe(201);
      expect(allowed.json().dateFrom).toBe(deep);
    });

    it('повтор с тем же ключом возвращает ту же заявку, а другое тело под ним — 409 (Р31)', async () => {
      const yesterday = shiftDateKey(ctx.today, -1);
      const operationId = uuid();
      const body = specialBody({
        dateFrom: yesterday,
        dateTo: yesterday,
        backdateReason: 'вышли вчера',
        operationId,
      });

      const first = await create(ctx.dispatcher, body);
      expect(first.statusCode, first.body).toBe(201);
      const repeat = await create(ctx.dispatcher, body);
      expect(repeat.statusCode, repeat.body).toBe(201);
      // Та же заявка, а не вторая с тем же содержанием: ответ пересобран из текущего состояния по
      // связи операции с заявкой.
      expect(repeat.json().id).toBe(first.json().id);
      expect(await correctionsOf(operationId)).toHaveLength(1);

      const другое = await create(ctx.dispatcher, { ...body, comment: 'другая команда' });
      expect(другое.statusCode, другое.body).toBe(409);
    });
  });

  describe('правка задним числом (Р6, Р29)', () => {
    /** Вчерашняя заявка — предмет всех проверок этого блока. */
    async function seedYesterday(): Promise<{ id: string; version: number; dateFrom: string }> {
      const yesterday = shiftDateKey(ctx.today, -1);
      const res = await create(
        ctx.dispatcher,
        specialBody({
          dateFrom: yesterday,
          dateTo: yesterday,
          backdateReason: 'вышли вчера',
          operationId: uuid(),
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const request = res.json();
      return { id: request.id, version: request.version, dateFrom: yesterday };
    }

    it('правка комментария у вчерашней заявки права на коррекцию не требует', async () => {
      const request = await seedYesterday();
      // Менеджер — без `waybills.correct`. Календарь тело не двигает вовсе: срок в нём тот же,
      // каким он и был. Иначе уточнение телефона у вчерашней заявки упиралось бы в право (Р29).
      const res = await patch(ctx.manager, request.id, {
        requestType: 'special_equipment',
        version: request.version,
        dateFrom: request.dateFrom,
        dateTo: request.dateFrom,
        comment: 'уточнили место работ',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().comment).toBe('уточнили место работ');
    });

    it('сдвиг срока в прошлое без права — 403, без причины — 422', async () => {
      const request = await seedYesterday();
      const twoDaysAgo = shiftDateKey(ctx.today, -2);

      const forbidden = await patch(ctx.manager, request.id, {
        requestType: 'special_equipment',
        version: request.version,
        dateFrom: twoDaysAgo,
        backdateReason: 'вышли позавчера',
        operationId: uuid(),
      });
      expect(forbidden.statusCode, forbidden.body).toBe(403);

      // У правки границы в схеме нет и не было (вчерашнюю заявку иначе нельзя было бы открыть), и
      // «не хватает причины» до сервера доходит именно здесь — в отличие от заведения, где такое
      // тело отклоняет схема.
      const noReason = await patch(ctx.dispatcher, request.id, {
        requestType: 'special_equipment',
        version: request.version,
        dateFrom: twoDaysAgo,
        operationId: uuid(),
      });
      expect(noReason.statusCode, noReason.body).toBe(422);
      // Отказ ничего не изменил: срок остался вчерашним.
      expect((await read(request.id)).dateFrom).toBe(request.dateFrom);
    });

    it('с правом, причиной и ключом срок уезжает в прошлое и оставляет след', async () => {
      const request = await seedYesterday();
      const twoDaysAgo = shiftDateKey(ctx.today, -2);
      const operationId = uuid();
      const body = {
        requestType: 'special_equipment',
        version: request.version,
        dateFrom: twoDaysAgo,
        dateTo: request.dateFrom,
        backdateReason: 'техника вышла позавчера',
        operationId,
      };

      const res = await patch(ctx.dispatcher, request.id, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().dateFrom).toBe(twoDaysAgo);

      const [correction] = await correctionsOf(operationId);
      expect(correction!.kind).toBe('request_date');
      expect(await linkedRequests(correction!.id)).toEqual([request.id]);
      // Снимок «было → стало» (Р16): через два месяца по журналу спросят не «какая дата стоит
      // сейчас», а «какой день эта правка объявила рабочим».
      const payload = correction!.payload as { request?: { calendar?: Record<string, unknown> } };
      expect(payload.request?.calendar).toMatchObject({
        before: { dateFrom: request.dateFrom },
        after: { dateFrom: twoDaysAgo },
      });

      // Повтор того же запроса — с устаревшей версией в теле — отвечает не конфликтом, а тем же
      // результатом: ради этого ключ и нужен (Р31).
      const repeat = await patch(ctx.dispatcher, request.id, body);
      expect(repeat.statusCode, repeat.body).toBe(200);
      expect(repeat.json().version).toBe(res.json().version);
      expect(await correctionsOf(operationId)).toHaveLength(1);
    });

    /**
     * Повтор перепроверяет доступ (Р31, ADR 0101 п. 9), и у правки это самое лёгкое место, чтобы
     * потерять проверку целиком: второй раз календарь никуда не двигается — он **уже** там, куда
     * его двинули, — `movedRequestDateKey` честно отвечает «сдвига нет», и `backdateGuard` без
     * эффективной даты не спрашивается вовсе. Молча отдать прежний результат тому, у кого право
     * успели отобрать между попытками, — та же утечка, что выполнить правку без права.
     */
    it('повтор с отобранным правом — отказ, а не прежний результат', async () => {
      const request = await seedYesterday();
      const twoDaysAgo = shiftDateKey(ctx.today, -2);
      const body = {
        requestType: 'special_equipment',
        version: request.version,
        dateFrom: twoDaysAgo,
        dateTo: request.dateFrom,
        backdateReason: 'техника вышла позавчера',
        operationId: uuid(),
      };

      const first = await patch(ctx.revoked, request.id, body);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().dateFrom).toBe(twoDaysAgo);

      // Право отбирают между попытками. Роль читается из БД на каждом запросе (`Principal`), и
      // выданный токен от этого не протухает — именно так отзыв и выглядит в жизни.
      await ctx.db.execute(sql`UPDATE users SET role = 'manager' WHERE id = ${ctx.revokedId}`);
      try {
        const repeat = await patch(ctx.revoked, request.id, body);
        expect(repeat.statusCode, repeat.body).toBe(403);
        // Отказ — про доступ к результату, а не про откат работы: правка первой попытки на месте,
        // и второй операции по тому же ключу не завелось.
        expect((await read(request.id)).dateFrom).toBe(twoDaysAgo);
        expect(await correctionsOf(body.operationId)).toHaveLength(1);
      } finally {
        await ctx.db.execute(sql`UPDATE users SET role = 'dispatcher' WHERE id = ${ctx.revokedId}`);
      }

      // Право вернули — повтор снова отвечает прежним результатом, а не конфликтом версий.
      const again = await patch(ctx.revoked, request.id, body);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().version).toBe(first.json().version);
    });

    it('продление срока вперёд задним числом не является', async () => {
      const request = await seedYesterday();
      // Начало осталось вчерашним, конец уехал вперёд: guard считает по **новым** границам, и
      // более ранняя из сдвинутых здесь — завтрашний день (Р29, §4).
      const res = await patch(ctx.dispatcher, request.id, {
        requestType: 'special_equipment',
        version: request.version,
        dateFrom: request.dateFrom,
        dateTo: shiftDateKey(ctx.today, 1),
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('отработанная неделя ЭСМ-2 (Р8, Р21)', () => {
    it('сдвиг начала срока в прошедшую неделю отклоняется с перечнем недель', async () => {
      const dateTo = shiftDateKey(ctx.today, 2);
      const created = await create(
        ctx.admin,
        specialBody({ dateFrom: ctx.today, dateTo, comment: 'ЭСМ-2 на текущую неделю' }),
      );
      expect(created.statusCode, created.body).toBe(201);
      const request = created.json();

      const approved = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${request.id}/approval`,
        headers: ctx.admin,
        payload: { approved: true, version: request.version },
      });
      expect(approved.statusCode, approved.body).toBe(200);

      // Перевод в работу выписывает недельный лист сам (ADR 0060): ручной выдачи у ЭСМ-2 нет.
      const confirmed = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${request.id}/status`,
        headers: ctx.admin,
        payload: {
          status: 'confirmed',
          comment: '',
          version: approved.json().version,
          assignment: {
            vehicleId: ctx.vehicle.id,
            pricePerHour: null,
            pricePerShift: null,
            shiftHours: null,
            driverPersonId: ctx.personId,
          },
          schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo },
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);

      // Воскресенье прошлой недели: неделя кончилась до сегодня при любом дне недели, и до предела
      // тридцати дней ей далеко.
      const lastWeekSunday = shiftDateKey(weekStartKey(ctx.today), -1);
      const moved = await patch(ctx.admin, request.id, {
        requestType: 'special_equipment',
        version: confirmed.json().version,
        dateFrom: lastWeekSunday,
        dateTo,
        backdateReason: 'техника вышла ещё на прошлой неделе',
        operationId: uuid(),
      });
      // 422 с перечнем недель, а не молчаливое согласие: лист за прошедшую неделю сверка не
      // выпишет (`esm2SyncPlan`), и заявка осталась бы без бумаги на эти дни (этап 6 плана).
      expect(moved.statusCode, moved.body).toBe(422);
      expect(moved.json().message).toContain('ЭСМ-2');
      // Ничего не поехало: отказ стоит до транзакции (Р36).
      expect((await read(request.id)).dateFrom).toBe(ctx.today);
    });
  });
});
