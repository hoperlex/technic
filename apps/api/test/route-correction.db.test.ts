import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, WAYBILL_CORRECTION_DAYS } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import {
  correctRouteWithAck,
  issueRouteWaybill,
  type AcknowledgedCall,
} from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Коррекция рейса задним числом (ADR 0101 п. 2, этап 4 плана) — на живой схеме и настоящими путями.
 *
 * Зачем база. Предмет проверки здесь не предикат, а сцепка: одна транзакция, в которой действующий
 * номер списывается, рейс переписывается, назначения едут за ним, подписи смен снимаются и
 * рождается новый бланк. Половину правил держит схема — частичный `waybills_route_unique` (двух
 * действующих листов на рейс не бывает), `waybills_corrects_unique` (номер заменён не более одного
 * раза), CHECK о причине у листа с операцией, уникальный ключ идемпотентности. Проверить это
 * правилами невозможно: расходятся не правила, а порядок шагов и база.
 *
 * Второй предмет — линейные дни (ADR 0100). Их назначение коррекция **не** переписывает: машина дня
 * это машина рейса, а `vehicle_request_assignments` отвечает за весь заказ. Перепутав это, коррекция
 * одного дня переставила бы машину у недель ЭСМ-2 и у расчёта закрытия — и заметно это только на
 * настоящих строках.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/route-correction.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-route-correction-admin@example.invalid';
const DISPATCHER_EMAIL = 'db-route-correction-dispatcher@example.invalid';
const MANAGER_EMAIL = 'db-route-correction-manager@example.invalid';

/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды заведённых записей — с «яя»: половина db-тестов берёт объект из справочника выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-corr-route-${RUN}`;
const TYPE_PREFIX = `corr_route_${RUN}`;
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: коррекция рейса';

/** Контакты заказов: номера выдуманы и своими цифрами ни на кого не похожи — база общая. */
const SITE = { name: 'Коррекциев Пётр Сергеевич', phone: '9007770761' };
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770762' };
const UNLOADING = { name: 'Приёмов Валентин Тарасович', phone: '9007770763' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Три субъекта: у администратора глубина без предела, у диспетчера 30 дней, у менеджера прав нет. */
  admin: { authorization: string };
  dispatcher: { authorization: string };
  manager: { authorization: string };
  adminId: string;
  objectId: string;
  objectAddress: string;
  /** Две свои грузовые машины: коррекция и есть «ехала не та, что записана». */
  vehicleId: string;
  otherVehicleId: string;
  /** Машина другого вида ТС: ею проверяется отказ назначению (ADR 0059). */
  alienVehicleId: string;
  driverId: string;
  otherDriverId: string;
  linearTypeId: string;
  plainTypeId: string;
  today: string;
}

let ctx: Ctx;

/** Что завёл этот файл: по этим спискам он за собой и убирает. */
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

/**
 * Водитель рейса: человек со специализацией «водитель», действующей задолго до дня рейса. Дата
 * начала здесь не украшение — отбор исторический (ADR 0101 п. 15), и человек, заведённый сегодня,
 * в лист за прошлую неделю не попал бы.
 */
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
      middleName: 'Коррекционный',
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
  const address = 'г Москва, ул Исправительная, д 5';
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка коррекции рейса ${RUN}`}, ${address})
    RETURNING id`);
  return { id: rows.rows[0]!.id, address };
}

async function createType(kindId: string, isLinear: boolean): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.admin,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
      name: `Ямобуры коррекции (${isLinear ? 'линейный' : 'обычный'} ${RUN})`,
      isLinear,
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

/** Грузоперевозка, взятая в работу вместе со своим рейсом: это и есть предмет коррекции. */
async function freightInProgress(): Promise<{ id: string; routeId: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.plainTypeId,
      scheduledAt: `${ctx.today}T10:00:00+03:00`,
      // Адреса, количество и контакты — у ездки, а не у заявки (Р2): у заявки с ездками `A→B` и
      // `A→C` «адрес разгрузки заявки» не существует. Одна ездка — то же, чем была пара полей.
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
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        route: { newRoute: { driverPersonId: ctx.driverId } },
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const dto = confirmed.json();
  expect(dto.route, confirmed.body).not.toBeNull();
  createdRoutes.push(dto.route.id as string);
  return { id: request.id as string, routeId: dto.route.id as string, version: dto.version };
}

/** Линейный заказ в работе: его дни ставят в рейсы по одному из карточки заявки (ADR 0100 §8). */
async function linearInProgress(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.linearTypeId,
      dateFrom: ctx.today,
      dateTo: shiftDateKey(ctx.today, 5),
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: 'Планировка площадки',
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
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.today,
        dateTo: shiftDateKey(ctx.today, 5),
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id as string, version: confirmed.json().version as number };
}

/** Поставить день заказа в новый рейс — единственная дверь линейного дня (ADR 0100 §8). */
async function planDay(requestId: string, date: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.admin,
    payload: { newRoute: { vehicleId: ctx.vehicleId, driverPersonId: ctx.driverId } },
  });
  expect(res.statusCode, res.body).toBe(200);
  const day = res.json().items.find((d: { date: string }) => d.date === date);
  expect(day?.route, res.body).toBeTruthy();
  createdRoutes.push(day.route.id as string);
  return day.route.id as string;
}

async function routeVersion(routeId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/**
 * Действующий лист по рейсу — то состояние, в котором коррекция застаёт прошедший день.
 *
 * Через помощника, потому что рукопожатие (Р21) здесь обвязка: у тестового водителя документов
 * нет, и предупреждение `driver_documents` поднимается на каждой выписке этого файла. Предмет
 * проверки — сама коррекция, а не подтверждение.
 */
async function issueWaybill(routeId: string): Promise<void> {
  await issueRouteWaybill({
    app: ctx.app,
    headers: ctx.admin,
    routeId,
    payload: { version: await routeVersion(routeId) },
  });
}

/**
 * Отправить рейс и его лист в прошлое.
 *
 * Заведение рейса задним числом сервер пока не спрашивает (дыра 1 плана закрывается этапом 7), а
 * заявку в прошлое не пускает схема — поэтому прошлое делается сдвигом самих дат. Это ровно то
 * состояние, в котором коррекция и застаёт рейс: день прошёл, бумага побывала на руках. Дни
 * линейных заказов уезжают сами — составной ключ с `ON UPDATE CASCADE` (ADR 0100 §3).
 */
async function movePast(routeId: string, daysAgo: number): Promise<string> {
  const day = shiftDateKey(ctx.today, -daysAgo);
  await ctx.db.execute(sql`UPDATE vehicle_routes SET route_date = ${day} WHERE id = ${routeId}`);
  await ctx.db.execute(
    sql`UPDATE waybills SET issued_for_date = ${day} WHERE route_id = ${routeId}`,
  );
  return day;
}

async function correct(
  auth: { authorization: string },
  routeId: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-routes/${routeId}/correction`,
    headers: auth,
    payload: { version: await routeVersion(routeId), ...payload },
  });
}

/**
 * Коррекция, которая обязана пройти, — с рукопожатием нового листа внутри (Р21а).
 *
 * Отдельно от `correct`, а не вместо него: половина сценариев ниже ждёт отказа — 403 без права,
 * 422 на пустом теле и на чужой машине, — а помощник настаивает на 200 намеренно. Он и заведён
 * ради того, чтобы подготовка не проглатывала чужой ответ.
 */
async function correctOk(
  auth: { authorization: string },
  routeId: string,
  payload: Record<string, unknown>,
): Promise<AcknowledgedCall> {
  return correctRouteWithAck({
    app: ctx.app,
    headers: auth,
    routeId,
    payload: { version: await routeVersion(routeId), ...payload },
  });
}

/** Обычная правка рейса — та самая соседняя ручка, у которой guard заднего числа тоже спрашивается. */
async function patchRoute(
  auth: { authorization: string },
  routeId: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: auth,
    payload: { version: await routeVersion(routeId), ...payload },
  });
}

/** День подачи грузовой заявки по МСК: за ним и едет перенос рейса (`moveRouteToDate`). */
async function scheduledDayOf(requestId: string): Promise<string> {
  const rows = await ctx.db.execute<{ scheduled_at: Date }>(sql`
    SELECT scheduled_at FROM freight_transport_request_details WHERE request_id = ${requestId}`);
  return moscowDateKeyOf(new Date(rows.rows[0]!.scheduled_at));
}

/** Листы рейса в порядке выдачи: коррекция оставляет их два — списанный и выписанный взамен. */
async function waybillsOf(routeId: string) {
  const rows = await ctx.db.execute<{
    id: string;
    status: string;
    number: string;
    vehicle_id: string;
    driver_person_id: string;
    cancel_reason: string;
    cancel_correction_id: string | null;
    correction_id: string | null;
    correction_reason: string;
    corrects_waybill_id: string | null;
  }>(sql`
    SELECT id, status, number::text AS number, vehicle_id, driver_person_id, cancel_reason,
           cancel_correction_id, correction_id, correction_reason, corrects_waybill_id
    FROM waybills WHERE route_id = ${routeId} ORDER BY number`);
  return rows.rows;
}

async function assignmentOf(requestId: string): Promise<{ vehicle_id: string; version: number }> {
  const rows = await ctx.db.execute<{ vehicle_id: string; version: number }>(sql`
    SELECT a.vehicle_id, r.version
    FROM vehicle_request_assignments a
    JOIN vehicle_requests r ON r.id = a.request_id
    WHERE a.request_id = ${requestId}`);
  return rows.rows[0]!;
}

async function correctionsOf(operationId: string) {
  const rows = await ctx.db.execute<{
    id: string;
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
  }>(
    sql`SELECT id, kind, reason, payload FROM waybill_corrections WHERE operation_id = ${operationId}`,
  );
  return rows.rows;
}

function uuid(): string {
  return crypto.randomUUID();
}

describe.skipIf(!DB_URL)('коррекция рейса задним числом (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const adminId = await seedUser(ADMIN_EMAIL, 'admin');
    await seedUser(DISPATCHER_EMAIL, 'dispatcher');
    await seedUser(MANAGER_EMAIL, 'manager');

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
    const alien = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.deleted_at IS NULL AND vk.code = 'special_equipment'
      ORDER BY v.registration_number
      LIMIT 1`);
    const [first, second] = freight.rows;
    if (!first || !second || !alien.rows[0]) {
      throw new Error('в базе нет своих машин двух видов: миграции наполнения не применены');
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      dispatcher: await login(DISPATCHER_EMAIL),
      manager: await login(MANAGER_EMAIL),
      adminId,
      objectId: '',
      objectAddress: '',
      vehicleId: first.id,
      otherVehicleId: second.id,
      alienVehicleId: alien.rows[0].id,
      driverId: await seedDriver('Первый'),
      otherDriverId: await seedDriver('Второй'),
      linearTypeId: '',
      plainTypeId: '',
      today: moscowDateKeyOf(new Date()),
    };

    const object = await createObject();
    ctx.objectId = object.id;
    ctx.objectAddress = object.address;
    ctx.linearTypeId = await createType(first.kind_id, true);
    ctx.plainTypeId = await createType(first.kind_id, false);
  }, 180_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая. Порядок обратный ссылкам — сначала листы (они
     * держат и рейс, и заявку, и операцию ключами `restrict`), потом рейсы, потом заявки, а следом
     * записи операций: `vehicle_request_corrections` уходит каскадом вместе с заявкой.
     */
    if (ctx?.db) {
      const requests = sql.param(createdRequests);
      const routes = sql.param(createdRoutes);
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE route_id = ANY(${routes}::uuid[]) OR source_request_id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM waybill_corrections
        WHERE actor_user_id IN (SELECT id FROM users WHERE email IN (
          ${ADMIN_EMAIL}, ${DISPATCHER_EMAIL}, ${MANAGER_EMAIL}))`);
      await ctx.db.execute(sql`
        DELETE FROM construction_objects
        WHERE code = ${OBJECT_CODE}
          AND id NOT IN (SELECT object_id FROM vehicle_requests WHERE object_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${PERSON_MARK}
          AND id NOT IN (SELECT driver_person_id FROM waybills)`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('исправляет прошедший рейс целиком: номер списан, новый выписан, назначение переехало', async () => {
    const request = await freightInProgress();
    await issueWaybill(request.routeId);
    const day = await movePast(request.routeId, 3);
    const before = await assignmentOf(request.id);
    expect(before.vehicle_id).toBe(ctx.vehicleId);

    const operationId = uuid();
    const reason = 'На рейс выехала другая машина с другим водителем';
    const { res } = await correctOk(ctx.dispatcher, request.routeId, {
      operationId,
      vehicleId: ctx.otherVehicleId,
      driverPersonId: ctx.otherDriverId,
      reason,
    });

    // Рейс приведён к тому, что было на самом деле.
    const route = res.json();
    expect(route.vehicleId).toBe(ctx.otherVehicleId);
    expect(route.driverPersonId).toBe(ctx.otherDriverId);
    expect(route.routeDate).toBe(day);

    const sheets = await waybillsOf(request.routeId);
    expect(sheets.length, 'коррекция это «аннулировать и выписать заново» (Р1)').toBe(2);
    const [old, fresh] = sheets;
    expect(old!.status).toBe('cancelled');
    // Причина операции уходит в `cancel_reason` списанного и в `correction_reason` нового (Р35).
    expect(old!.cancel_reason).toBe(reason);
    expect(old!.cancel_correction_id).toBeTruthy();
    expect(fresh!.status).toBe('issued');
    expect(fresh!.correction_reason).toBe(reason);
    expect(fresh!.corrects_waybill_id, 'разрыв нумерации объясняет ссылка (Р10)').toBe(old!.id);
    // Ссылки две и они разные: операция, породившая номер, и операция, его списавшая (Р12).
    expect(fresh!.correction_id).toBe(old!.cancel_correction_id);
    expect(fresh!.vehicle_id).toBe(ctx.otherVehicleId);
    expect(fresh!.driver_person_id).toBe(ctx.otherDriverId);

    // Назначение заявки поехало за рейсом, а её версия выросла (Р24): чужая открытая карточка
    // теперь не сохранит поверх коррекции старую машину.
    const after = await assignmentOf(request.id);
    expect(after.vehicle_id).toBe(ctx.otherVehicleId);
    expect(after.version).toBeGreaterThan(before.version);

    const corrections = await correctionsOf(operationId);
    expect(corrections.length).toBe(1);
    expect(corrections[0]!.kind).toBe('route');
    expect(corrections[0]!.reason).toBe(reason);
    // Снимок «было → стало»: через месяцы им объясняют, чем рейс был до правки.
    const payload = corrections[0]!.payload as {
      route: { vehicleId: { before: string; after: string } };
      requests: { requestId: string }[];
    };
    expect(payload.route.vehicleId).toEqual({ before: ctx.vehicleId, after: ctx.otherVehicleId });
    expect(payload.requests.map((r) => r.requestId)).toEqual([request.id]);

    // Заявка связана с операцией — «что делали с ней задним числом» спрашивают со стороны заявки.
    const links = await ctx.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM vehicle_request_corrections
      WHERE request_id = ${request.id} AND correction_id = ${corrections[0]!.id}`);
    expect(links.rows[0]!.c).toBe(1);
  }, 180_000);

  it('повтор ключа ничего не выполняет, другое тело под тем же ключом — 409', async () => {
    const request = await freightInProgress();
    await issueWaybill(request.routeId);
    await movePast(request.routeId, 2);

    const operationId = uuid();
    /*
     * Повтором считается **та же команда целиком**, вместе с версией рейса: отпечаток берётся с
     * нормализованного тела (Р31). Поэтому ретрай посылает ровно то, что послал в первый раз, — а
     * не пересобирает тело со свежей версией: пересобранное это уже другая команда, и молча выдать
     * ей чужой результат было бы хуже отказа.
     */
    const body = {
      operationId,
      version: await routeVersion(request.routeId),
      vehicleId: ctx.otherVehicleId,
      reason: 'Ехала другая машина',
    };
    const send = (auth: { authorization: string }, payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-routes/${request.routeId}/correction`,
        headers: auth,
        payload,
      });

    /*
     * Первая команда идёт через помощника, а повторы — тем телом, каким она **прошла**
     * (`accepted`): подтверждение предупреждений лежит в том же теле, а отпечаток идемпотентности
     * считается со всего тела целиком. Повторив исходное `body` без `acknowledge`, тест послал бы
     * серверу другую команду под занятым ключом — и получил бы 409 «ключ уже занят» там, где ждёт
     * «ничего не выполнено».
     */
    const first = await correctRouteWithAck({
      app: ctx.app,
      headers: ctx.admin,
      routeId: request.routeId,
      payload: body,
    });
    const accepted = first.payload;
    const issued = (await waybillsOf(request.routeId)).map((row) => row.id);

    const repeat = await send(ctx.admin, accepted);
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect((await waybillsOf(request.routeId)).map((row) => row.id)).toEqual(issued);
    expect((await correctionsOf(operationId)).length).toBe(1);

    // Тот же ключ с другой причиной — не повтор, а другая команда под чужим ключом.
    const other = await send(ctx.admin, { ...accepted, reason: 'Другая причина' });
    expect(other.statusCode, other.body).toBe(409);
    // Чужим пользователем — тоже 409, даже с тем же телом: ключ принадлежит автору.
    const foreign = await send(ctx.dispatcher, accepted);
    expect(foreign.statusCode, foreign.body).toBe(409);
  }, 180_000);

  it('тело, не меняющее ничего, отклоняется — номер цел', async () => {
    const request = await freightInProgress();
    await issueWaybill(request.routeId);
    await movePast(request.routeId, 1);
    const sheets = await waybillsOf(request.routeId);

    const res = await correct(ctx.admin, request.routeId, {
      operationId: uuid(),
      // Та же машина и тот же водитель: схема такое тело пропускает — «те же значения» видно
      // только серверу под блокировкой рейса (Р31).
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.driverId,
      reason: 'Ошиблись окном',
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(await waybillsOf(request.routeId)).toEqual(sheets);
  }, 180_000);

  it('заявка не в работе — отказ с её номером, лист не тронут', async () => {
    const request = await freightInProgress();
    await issueWaybill(request.routeId);
    await movePast(request.routeId, 4);
    /*
     * Прямым SQL, а не ручкой: настоящий откат заявки в «Новую» требует сперва аннулировать лист
     * (ADR 0050), то есть разрушает как раз то состояние, которое здесь и проверяется — заявка
     * не в работе внутри замороженного рейса (штатное последствие ADR 0058).
     */
    await ctx.db.execute(sql`UPDATE vehicle_requests SET status = 'new' WHERE id = ${request.id}`);

    const res = await correct(ctx.admin, request.routeId, {
      operationId: uuid(),
      vehicleId: ctx.otherVehicleId,
      reason: 'Ехала другая машина',
    });
    expect(res.statusCode, res.body).toBe(422);
    // Отказ называет номера и говорит, что делать (Р13, Р38).
    const number = (
      await ctx.db.execute<{ num: number }>(
        sql`SELECT num FROM vehicle_requests WHERE id = ${request.id}`,
      )
    ).rows[0]!.num;
    expect(res.json().message).toContain(`ТС-${number}`);
    expect((await waybillsOf(request.routeId)).every((row) => row.status === 'issued')).toBe(true);
  }, 180_000);

  it('машина другого вида отклоняется до аннулирования (Р36)', async () => {
    const request = await freightInProgress();
    await issueWaybill(request.routeId);
    await movePast(request.routeId, 5);

    const res = await correct(ctx.admin, request.routeId, {
      operationId: uuid(),
      vehicleId: ctx.alienVehicleId,
      reason: 'Ехала другая машина',
    });
    expect(res.statusCode, res.body).toBe(422);
    // Главное здесь — не сам отказ, а то, что он пришёл до первого изменения: действующий номер
    // остался действующим, второго листа не появилось.
    const sheets = await waybillsOf(request.routeId);
    expect(sheets.length).toBe(1);
    expect(sheets[0]!.status).toBe('issued');
    expect((await assignmentOf(request.id)).vehicle_id).toBe(ctx.vehicleId);
  }, 180_000);

  it('линейный день: назначение заказа не трогается, подпись смены снимается и попадает в снимок', async () => {
    const request = await linearInProgress();
    const routeId = await planDay(request.id, ctx.today);

    // Часы дня и подпись объекта под ними: ровно то, что коррекция обязана снять (Р5).
    const filled = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/vehicle-requests/${request.id}/shifts/${ctx.today}`,
      headers: ctx.admin,
      payload: { startedAt: '08:00', endedAt: '17:00', machineHours: 8, refuel: '', comment: '' },
    });
    expect(filled.statusCode, filled.body).toBe(200);
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request.id}/shifts/${ctx.today}/approval`,
      headers: ctx.admin,
      payload: { approved: true },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await issueWaybill(routeId);

    // Окно коррекции обязано назвать снимаемую подпись до нажатия (Р36, §10 плана).
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-routes/${routeId}/correction`,
      headers: ctx.admin,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().shifts).toHaveLength(1);
    expect(preview.json().requests[0].workDate).toBe(ctx.today);

    const operationId = uuid();
    const { res } = await correctOk(ctx.admin, routeId, {
      operationId,
      vehicleId: ctx.otherVehicleId,
      reason: 'В этот день на площадку вышла вторая машина',
    });

    // Машина дня сменилась вместе с рейсом, а назначение заказа осталось прежним (ADR 0100 п. 4):
    // оно отвечает за весь срок, и переписав его, коррекция одного дня переставила бы машину у
    // недель ЭСМ-2 и у расчёта закрытия.
    expect(res.json().vehicleId).toBe(ctx.otherVehicleId);
    expect((await assignmentOf(request.id)).vehicle_id).toBe(ctx.vehicleId);

    const shift = await ctx.db.execute<{ approved_at: string | null }>(sql`
      SELECT approved_at FROM vehicle_request_shifts
      WHERE request_id = ${request.id} AND shift_date = ${ctx.today}`);
    expect(shift.rows[0]!.approved_at, 'подпись под работой другой машины не стоит').toBeNull();

    const payload = (await correctionsOf(operationId))[0]!.payload as {
      shifts: { requestId: string; date: string; approvedBy: string }[];
      linearDays: { workDate: string }[];
      requests: unknown[];
    };
    // Прежний подписант сохранён: в самой таблице его после снятия уже нет (Р5).
    expect(payload.shifts).toEqual([
      expect.objectContaining({ requestId: request.id, date: ctx.today, approvedBy: ctx.adminId }),
    ]);
    expect(payload.linearDays).toEqual([expect.objectContaining({ workDate: ctx.today })]);
    expect(payload.requests, 'назначений коррекция не меняла').toEqual([]);
  }, 180_000);

  it('без права коррекции дверь закрыта, а глубже предела диспетчер не правит', async () => {
    const request = await freightInProgress();
    await issueWaybill(request.routeId);
    await movePast(request.routeId, WAYBILL_CORRECTION_DAYS + 5);

    const denied = await correct(ctx.manager, request.routeId, {
      operationId: uuid(),
      vehicleId: ctx.otherVehicleId,
      reason: 'Ехала другая машина',
    });
    expect(denied.statusCode, denied.body).toBe(403);

    // У диспетчера право есть, не хватает глубины: 422, и поручение отсюда другое — не «получите
    // право», а «попросите администратора» (Р37).
    const tooDeep = await correct(ctx.dispatcher, request.routeId, {
      operationId: uuid(),
      vehicleId: ctx.otherVehicleId,
      reason: 'Ехала другая машина',
    });
    expect(tooDeep.statusCode, tooDeep.body).toBe(422);
    expect(tooDeep.json().message).toContain(String(WAYBILL_CORRECTION_DAYS));

    await correctOk(ctx.admin, request.routeId, {
      operationId: uuid(),
      vehicleId: ctx.otherVehicleId,
      reason: 'Ехала другая машина',
    });
  }, 180_000);

  /*
   * Соседняя дверь в прошлое — обычная правка рейса (§12 плана, Р29).
   *
   * Проверяются оба утверждения сразу, потому что порознь каждое чинится неверно. Запретить всю
   * правку прошлого рейса — значит запереть подготовку к самой коррекции (водителя ставят как раз
   * перед ней, ADR 0101 п. 6). Не спрашивать ничего за дату — значит оставить обход защищённого
   * `PATCH /vehicle-requests/:id`: `moveRouteToDate` переписывает `scheduledAt` **всех** заявок
   * состава, то есть двигает календарь заказчика ручкой, у которой guard'а нет.
   *
   * Листа у рейса здесь нет намеренно: с действующим листом правка не проходит вовсе
   * (`assertRouteEditable`), и проверялась бы заморозка, а не задний ход.
   */
  it('правка прошлого рейса: водитель без права, дата — только с правом и причиной', async () => {
    const request = await freightInProgress();
    const day = await movePast(request.routeId, 3);
    const moveTo = shiftDateKey(day, 1);

    // Водитель прошлого рейса — без права и без причины: пока листа нет, рейс планировочная
    // запись, и водитель в ней ничего о прошедшем дне не утверждает.
    const driver = await patchRoute(ctx.manager, request.routeId, {
      driverPersonId: ctx.otherDriverId,
    });
    expect(driver.statusCode, driver.body).toBe(200);
    expect(driver.json().driverPersonId).toBe(ctx.otherDriverId);
    expect(await scheduledDayOf(request.id), 'подача заявки на месте').toBe(ctx.today);

    // Дата — уже задний ход: у менеджера права нет, и отказ несёт 403 (`permission`).
    const denied = await patchRoute(ctx.manager, request.routeId, { routeDate: moveTo });
    expect(denied.statusCode, denied.body).toBe(403);

    // Право есть, причины нет — 422 и другое поручение человеку: не «получите право», а
    // «объясните правку».
    const noReason = await patchRoute(ctx.dispatcher, request.routeId, { routeDate: moveTo });
    expect(noReason.statusCode, noReason.body).toBe(422);

    const moved = await patchRoute(ctx.dispatcher, request.routeId, {
      routeDate: moveTo,
      reason: 'Рейс состоялся днём позже, чем записали',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().routeDate).toBe(moveTo);
    // Подача заявки уехала вместе с рейсом — ровно то, ради чего guard здесь и стоит.
    expect(await scheduledDayOf(request.id)).toBe(moveTo);

    // Перенос прошлого рейса **вперёд** — тоже задний ход: более ранней из двух дат остаётся его
    // прошедший день, о котором перенос и утверждает (§4 плана). Иначе вчерашний календарь
    // открывался бы любому в два шага: сдвинуть рейс на завтра, а потом куда угодно.
    const toFuture = await patchRoute(ctx.manager, request.routeId, {
      routeDate: shiftDateKey(ctx.today, 1),
    });
    expect(toFuture.statusCode, toFuture.body).toBe(403);
  }, 180_000);
});
