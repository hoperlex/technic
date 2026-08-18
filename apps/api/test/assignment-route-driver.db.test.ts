import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Водитель готового рейса при смене назначенной техники (ADR 0048).
 *
 * Рейс заведён на конкретную машину, поэтому смена техники — всегда переезд: заявка вынимается из
 * прежнего маршрута и кладётся в маршрут новой единицы. За другой машиной приходит и другой
 * человек, но сменить его этим же действием было нечем: оставалось либо второе окно правки рейса
 * (ADR 0082), либо заведение лишнего маршрута «с нужным водителем» — тот и оставался пустой
 * записью в плане дня. Теперь водителя называет тот же блок `route`, что и сам рейс.
 *
 * Зачем база. Проверяется не правило, а сцепка одной транзакции: заявка снимается с прежнего
 * рейса, встаёт в целевой, целевому меняется водитель, поднимается его версия и пишется след. Ни
 * заморозка листом, ни общий состав рейса, ни порядок блокировок (Р17) моками не воспроизводятся,
 * а цена расхождения — рейс, в котором за рулём один человек, а в выданной бумаге другой.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-route-driver.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-assign-route-driver-admin@example.invalid';

/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Код площадки с «яя»: половина db-тестов берёт объект выражением `ORDER BY … LIMIT 1`, и запись,
 * ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-assign-driver-${RUN}`;
const TYPE_CODE = `assign_driver_${RUN}`;
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: водитель целевого рейса';

/** Контакты ездки: номера выдуманы и своими цифрами ни на кого не похожи — база общая. */
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770861' };
const UNLOADING = { name: 'Приёмов Кирилл Данилович', phone: '9007770862' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { authorization: string };
  objectId: string;
  objectAddress: string;
  /** Две свои грузовые машины: смена техники — это переезд между их рейсами. */
  vehicleId: string;
  otherVehicleId: string;
  /** Три водителя: прежний за рулём, новый и тот, кого уволили между делом. */
  driverId: string;
  otherDriverId: string;
  firedDriverId: string;
  typeId: string;
  today: string;
}

let ctx: Ctx;

const createdRequests: string[] = [];
const createdRoutes: string[] = [];

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
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

async function seedAdmin(): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'admin',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Водитель рейса: человек со специализацией «водитель», действующей задолго до дня рейса. */
async function seedDriver(name: string): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');

  const [person] = await db
    .insert(schema.persons)
    .values({
      lastName: name,
      firstName: 'Тест',
      middleName: 'Рейсовый',
      comment: PERSON_MARK,
    })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
  });
  return person!.id;
}

async function createObject(): Promise<{ id: string; address: string }> {
  const { db } = await import('../src/db/client');
  const address = 'г Москва, ул Рейсовая, д 7';
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка водителя рейса ${RUN}`}, ${address})
    RETURNING id`);
  return { id: rows.rows[0]!.id, address };
}

async function createType(kindId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.admin,
    payload: {
      kindId,
      code: TYPE_CODE,
      name: `Самосвалы рейсовые (${RUN})`,
      isLinear: false,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Виза руководителя: без неё заявку в работу не берут. */
async function approve(request: { id: string; version: number }): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.admin,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/**
 * Грузоперевозка, взятая в работу вместе со своим рейсом. Машина и водитель называются явно: тест
 * и состоит в том, кто из них где остался после переезда.
 */
async function freightInProgress(
  vehicleId: string,
  driverPersonId: string,
): Promise<{ id: string; routeId: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      scheduledAt: `${ctx.today}T10:00:00+03:00`,
      trips: [
        {
          fromLocation: ctx.objectAddress,
          toLocation: ctx.objectAddress,
          fromAddress: { source: 'object', refId: ctx.objectId },
          toAddress: { source: 'object', refId: ctx.objectId },
          volumeM3: 12,
          fromResponsibleName: LOADING.name,
          fromResponsiblePhone: LOADING.phone,
          toResponsibleName: UNLOADING.name,
          toResponsiblePhone: UNLOADING.phone,
        },
      ],
      comment: 'Песок сеяный',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();
  createdRequests.push(request.id as string);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.admin,
    payload: {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        route: { newRoute: { driverPersonId } },
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const dto = confirmed.json();
  expect(dto.route, confirmed.body).not.toBeNull();
  createdRoutes.push(dto.route.id as string);
  return { id: request.id as string, routeId: dto.route.id as string, version: dto.version };
}

/** Смена техники: тот же блок `route`, которым заявку кладут в рейс при переводе в работу. */
async function changeAssignment(
  requestId: string,
  payload: { vehicleId: string; route?: Record<string, unknown>; version: number },
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}/assignment`,
    headers: ctx.admin,
    payload: {
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      ...payload,
    },
  });
}

async function routeRow(routeId: string): Promise<{
  driver_person_id: string | null;
  version: number;
  requests: number;
}> {
  const rows = await ctx.db.execute<{
    driver_person_id: string | null;
    version: number;
    requests: number;
  }>(sql`
    SELECT r.driver_person_id, r.version,
           (SELECT count(*)::int FROM vehicle_route_requests rr WHERE rr.route_id = r.id) AS requests
    FROM vehicle_routes r WHERE r.id = ${routeId}`);
  return rows.rows[0]!;
}

async function requestVersion(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
  );
  return rows.rows[0]!.version;
}

/** След смены водителя — то же событие, что пишет обычная правка рейса: второго вида не заводят. */
async function driverAuditOf(routeId: string) {
  const rows = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
    WHERE entity_type = 'vehicle_route' AND entity_id = ${routeId}
      AND action = 'vehicle_route.update' AND metadata ? 'driverPersonId'
    ORDER BY created_at`);
  return rows.rows.map((r) => r.metadata);
}

describe.skipIf(!DB_URL)('водитель целевого рейса при смене техники (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };

    const freight = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
      ORDER BY v.registration_number
      LIMIT 2`);
    const [first, second] = freight.rows;
    if (!first || !second) {
      throw new Error('в базе нет двух своих грузовых машин: миграции наполнения не применены');
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      objectId: '',
      objectAddress: '',
      vehicleId: first.id,
      otherVehicleId: second.id,
      driverId: await seedDriver('Прежний'),
      otherDriverId: await seedDriver('Сменный'),
      firedDriverId: await seedDriver('Уволенный'),
      typeId: '',
      today: moscowDateKeyOf(new Date()),
    };

    const object = await createObject();
    ctx.objectId = object.id;
    ctx.objectAddress = object.address;
    ctx.typeId = await createType(first.kind_id);
    // Уволенный — уже после заведения: отбор годных смотрит на `deleted_at`, и человек, которого
    // нет в справочнике, за руль вставать не должен даже по прямому идентификатору.
    await db.execute(sql`UPDATE persons SET deleted_at = now() WHERE id = ${ctx.firedDriverId}`);
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    /*
     * Убирается файл не по спискам заведённого, а **по своим меткам** — коду площадки и метке
     * людей. Списки помнят только удавшийся прогон, а прибирать надо и за упавшим: база у
     * db-тестов общая, и рейс, оставшийся от вчерашней ошибки, держит своего водителя внешним
     * ключом — следующий прогон падал бы уже на уборке, не добравшись до проверок.
     *
     * Порядок обратен порядку рождения: бумага, состав рейса, рейсы, заявки, площадка, люди.
     * Каскада здесь ждать нельзя — связь состава живёт дольше обеих сторон намеренно, по ней
     * читают историю дня.
     */
    const ourPersons = sql`SELECT id FROM persons WHERE comment = ${PERSON_MARK}`;
    const ourObjects = sql`SELECT id FROM construction_objects WHERE code LIKE 'яя-assign-driver-%'`;
    const ourRequests = sql`SELECT id FROM vehicle_requests WHERE object_id IN (${ourObjects})`;
    // Список рейсов забирается **до** первого удаления: половина из них опознаётся только через
    // состав, и, сняв состав, тот же запрос вернул бы уже не всё — в базе остался бы пустой рейс,
    // держащий водителя внешним ключом.
    const routeRows = await ctx.db.execute<{ id: string }>(sql`
      SELECT id FROM vehicle_routes WHERE driver_person_id IN (${ourPersons})
      UNION
      SELECT route_id FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
    const routeIds = routeRows.rows.map((r) => r.id);
    const ourRoutes =
      routeIds.length > 0
        ? sql.join(
            routeIds.map((id) => sql`${id}`),
            sql`, `,
          )
        : null;

    if (ourRoutes) {
      await ctx.db.execute(sql`DELETE FROM waybills WHERE route_id IN (${ourRoutes})`);
      await ctx.db.execute(
        sql`DELETE FROM vehicle_route_requests WHERE route_id IN (${ourRoutes})`,
      );
      await ctx.db.execute(sql`
        DELETE FROM audit_log WHERE entity_type = 'vehicle_route'
          AND entity_id IN (${sql.join(
            routeIds.map((id) => sql`${id}::text`),
            sql`, `,
          )})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id IN (${ourRoutes})`);
    }
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE id IN (${ourObjects})`);
    await ctx.db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
    // Тип ТС файл заводит ручкой справочника, и он переживал уборку: заявки его держали ключом
    // `restrict`, поэтому идёт он после них. Метка шире одного прогона — добираются и хвосты
    // прежних падений.
    await ctx.db.execute(sql`
      DELETE FROM vehicle_types
       WHERE code LIKE 'assign\\_driver\\_%'
         AND id NOT IN (SELECT vehicle_type_id FROM vehicles)
         AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)`);
    /*
     * Журнал — по автору, а не по видам сущностей: писала в него только здешняя учётка, а видов
     * записей у неё несколько, и отбор по одному `vehicle_route` оставлял в общей базе полсотни
     * строк за прогон — больше, чем весь остальной мусор этого файла.
     */
    await ctx.db.execute(sql`
      DELETE FROM audit_log
      WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    await ctx.app.close();
    await ctx.closeDb();
  }, 60_000);

  it('заявка переезжает в готовый рейс и меняет ему водителя одним запросом', async () => {
    const moving = await freightInProgress(ctx.vehicleId, ctx.driverId);
    const target = await freightInProgress(ctx.otherVehicleId, ctx.driverId);
    const before = await routeRow(target.routeId);

    const res = await changeAssignment(moving.id, {
      vehicleId: ctx.otherVehicleId,
      route: { routeId: target.routeId, driverPersonId: ctx.otherDriverId },
      version: moving.version,
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await routeRow(target.routeId);
    // Переезд состоялся: в целевом рейсе теперь две заявки, и за рулём названный человек.
    expect(after.requests).toBe(before.requests + 1);
    expect(after.driver_person_id).toBe(ctx.otherDriverId);
    expect(after.version).toBeGreaterThan(before.version);
    // Прежний рейс заявку отдал — иначе она стояла бы в двух рейсах разом.
    expect((await routeRow(moving.routeId)).requests).toBe(0);

    const audit = await driverAuditOf(target.routeId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.driverPersonId).toBe(ctx.otherDriverId);
    expect(audit[0]!.previousDriverPersonId).toBe(ctx.driverId);
  }, 120_000);

  it('без названного водителя рейс не трогают: он общий, и молчание — это «не менять»', async () => {
    const moving = await freightInProgress(ctx.vehicleId, ctx.driverId);
    const target = await freightInProgress(ctx.otherVehicleId, ctx.otherDriverId);

    const res = await changeAssignment(moving.id, {
      vehicleId: ctx.otherVehicleId,
      route: { routeId: target.routeId },
      version: moving.version,
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await routeRow(target.routeId);
    expect(after.driver_person_id).toBe(ctx.otherDriverId);
    expect(await driverAuditOf(target.routeId)).toHaveLength(0);
  }, 120_000);

  it('тот же водитель, что уже стоит, — не событие: правки не было', async () => {
    const moving = await freightInProgress(ctx.vehicleId, ctx.driverId);
    const target = await freightInProgress(ctx.otherVehicleId, ctx.otherDriverId);

    const res = await changeAssignment(moving.id, {
      vehicleId: ctx.otherVehicleId,
      route: { routeId: target.routeId, driverPersonId: ctx.otherDriverId },
      version: moving.version,
    });
    expect(res.statusCode, res.body).toBe(200);

    expect((await routeRow(target.routeId)).driver_person_id).toBe(ctx.otherDriverId);
    expect(await driverAuditOf(target.routeId)).toHaveLength(0);
  }, 120_000);

  it('уволенного за руль не сажают: отказ и ни одной правки', async () => {
    const moving = await freightInProgress(ctx.vehicleId, ctx.driverId);
    const target = await freightInProgress(ctx.otherVehicleId, ctx.driverId);
    const before = await routeRow(target.routeId);

    const res = await changeAssignment(moving.id, {
      vehicleId: ctx.otherVehicleId,
      route: { routeId: target.routeId, driverPersonId: ctx.firedDriverId },
      version: moving.version,
    });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, res.body).toBeLessThan(500);

    // Транзакция откатилась целиком: заявка осталась в прежнем рейсе, целевой не тронут.
    const after = await routeRow(target.routeId);
    expect(after.requests).toBe(before.requests);
    expect(after.driver_person_id).toBe(ctx.driverId);
    expect((await routeRow(moving.routeId)).requests).toBe(1);
  }, 120_000);

  it('замороженный листом рейс водителя не отдаёт: бумага уже у человека', async () => {
    const moving = await freightInProgress(ctx.vehicleId, ctx.driverId);
    const target = await freightInProgress(ctx.otherVehicleId, ctx.driverId);
    // Лист выписан — рейс замер: расходиться с выданной бумагой смена водителя не вправе.
    await issueRouteWaybill({
      app: ctx.app,
      headers: ctx.admin,
      routeId: target.routeId,
      payload: { version: (await routeRow(target.routeId)).version },
    });

    const res = await changeAssignment(moving.id, {
      vehicleId: ctx.otherVehicleId,
      route: { routeId: target.routeId, driverPersonId: ctx.otherDriverId },
      version: moving.version,
    });
    expect(res.statusCode, res.body).toBe(409);

    expect((await routeRow(target.routeId)).driver_person_id).toBe(ctx.driverId);
    expect(await driverAuditOf(target.routeId)).toHaveLength(0);
  }, 120_000);

  it('заявка уже в этом рейсе: водитель меняется без переезда', async () => {
    const standing = await freightInProgress(ctx.vehicleId, ctx.driverId);
    const before = await routeRow(standing.routeId);

    const res = await changeAssignment(standing.id, {
      // Машина та же: меняют только человека — ради этого и не нужен больше лишний маршрут.
      vehicleId: ctx.vehicleId,
      route: { routeId: standing.routeId, driverPersonId: ctx.otherDriverId },
      version: await requestVersion(standing.id),
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await routeRow(standing.routeId);
    expect(after.driver_person_id).toBe(ctx.otherDriverId);
    expect(after.requests).toBe(before.requests);
    expect(after.version).toBeGreaterThan(before.version);
  }, 120_000);

  it('водителя можно снять: рейс остаётся, за рулём пока никого', async () => {
    const standing = await freightInProgress(ctx.vehicleId, ctx.driverId);

    const res = await changeAssignment(standing.id, {
      vehicleId: ctx.vehicleId,
      route: { routeId: standing.routeId, driverPersonId: null },
      version: await requestVersion(standing.id),
    });
    expect(res.statusCode, res.body).toBe(200);

    expect((await routeRow(standing.routeId)).driver_person_id).toBeNull();
    const audit = await driverAuditOf(standing.routeId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.driverPersonId).toBeNull();
  }, 120_000);
});
