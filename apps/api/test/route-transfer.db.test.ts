import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill, transferRequestWithAck } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Перенос заявки между рейсами прошедших дней (ADR 0101 п. 14, Р30) и закрытие дыры 1 — на живой
 * схеме и настоящими путями.
 *
 * Зачем база. Предмет здесь не предикат, а сцепка двух рейсов в одной транзакции: списываются два
 * действующих номера, талон переезжает, талоны источника уплотняются, назначение переписывается на
 * машину приёмника, и рождаются два новых листа — либо один, если источник опустел (Р22). Половину
 * правил держит сама схема: частичный `waybills_route_unique` (двух действующих листов на рейс не
 * бывает), `waybills_corrects_unique` (номер заменён не более одного раза), уникальность позиции
 * талона, CHECK о причине. Проверить это правилами невозможно — расходятся не правила, а порядок
 * шагов и база.
 *
 * Второй предмет — **дыра 1**: до ADR 0101 рейс на прошедшую дату заводился без единой проверки, а
 * выписка листа про день не спрашивала вовсе. Здесь проверяется, что обе двери спрашивают право и
 * причину, а лист, выписанный задним числом, объяснён операцией `issue` при пустом
 * `corrects_waybill_id` (Р35).
 *
 * Третий — линейные дни (ADR 0100). Их эта дверь не принимает: день равен дню своего рейса
 * физически (составной ключ), и «перенести» его значит распланировать другой день — вход у этого
 * свой, карточка заявки (ADR 0100 п. 8).
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/route-transfer.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-route-transfer-admin@example.invalid';
const DISPATCHER_EMAIL = 'db-route-transfer-dispatcher@example.invalid';
const MANAGER_EMAIL = 'db-route-transfer-manager@example.invalid';

/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды заведённых записей — с «яя»: половина db-тестов берёт объект из справочника выражением
 * `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую площадку.
 */
const OBJECT_CODE = `яя-transfer-${RUN}`;
const TYPE_PREFIX = `transfer_route_${RUN}`;
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: перенос между рейсами';

/** Контакты заказов: номера выдуманы и своими цифрами ни на кого не похожи — база общая. */
const SITE = { name: 'Переносов Пётр Сергеевич', phone: '9007770771' };
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770772' };
const UNLOADING = { name: 'Приёмов Валентин Тарасович', phone: '9007770773' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Три субъекта: у администратора глубина без предела, у диспетчера 30 дней, у менеджера прав нет. */
  admin: { authorization: string };
  dispatcher: { authorization: string };
  manager: { authorization: string };
  objectId: string;
  objectAddress: string;
  /** Две свои грузовые машины: у источника и приёмника они разные — иначе переезд назначения не виден. */
  vehicleId: string;
  otherVehicleId: string;
  driverId: string;
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
 * Водитель рейса: специализация действует задолго до дня рейса. Дата начала не украшение — отбор
 * исторический (ADR 0101 п. 15), и человек, заведённый сегодня, в лист за прошлую неделю не попал бы.
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
      middleName: 'Переносный',
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
  const address = 'г Москва, ул Переносная, д 7';
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка переноса ${RUN}`}, ${address})
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
      name: `Ямобуры переноса (${isLinear ? 'линейный' : 'обычный'} ${RUN})`,
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

/**
 * Грузоперевозка, взятая в работу: либо со своим новым рейсом, либо в уже заведённый.
 *
 * Машина спрашивается параметром: у источника и приёмника переноса они разные — иначе переезд
 * назначения на машину приёмника нечем было бы отличить от «ничего не изменилось».
 */
async function freightInProgress(params: {
  vehicleId: string;
  routeId?: string;
}): Promise<{ id: string; routeId: string; num: number }> {
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
        vehicleId: params.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        route: params.routeId
          ? { routeId: params.routeId }
          : { newRoute: { driverPersonId: ctx.driverId } },
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const dto = confirmed.json();
  expect(dto.route, confirmed.body).not.toBeNull();
  if (!params.routeId) createdRoutes.push(dto.route.id as string);
  return { id: request.id as string, routeId: dto.route.id as string, num: dto.num as number };
}

/** Линейный заказ в работе: его дни ставят в рейсы по одному из карточки заявки (ADR 0100 §8). */
async function linearInProgress(): Promise<{ id: string }> {
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
  return { id: request.id as string };
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

async function routeOf(routeId: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    version: number;
    requests: { requestId: string; displayNumber: string; position: number }[];
  };
}

/**
 * Действующий лист по рейсу — то состояние, в котором перенос застаёт прошедший день.
 *
 * Через помощника: рукопожатие (Р21) здесь обвязка — у тестового водителя нет документов, и
 * `driver_documents` поднимается на каждой выписке файла. Предмет проверки — сам перенос.
 */
async function issueWaybill(routeId: string): Promise<void> {
  await issueRouteWaybill({
    app: ctx.app,
    headers: ctx.admin,
    routeId,
    payload: { version: (await routeOf(routeId)).version },
  });
}

/**
 * Отправить рейс и его лист в прошлое.
 *
 * Прямым SQL, а не ручкой: заведение и выписка задним числом теперь спрашивают право и причину
 * (дыра 1, проверяется отдельным сценарием ниже), а здесь нужно не это, а **состояние**, в котором
 * коррекция застаёт рейс: день прошёл, бумага побывала на руках. Дни линейных заказов уезжают сами —
 * составной ключ с `ON UPDATE CASCADE` (ADR 0100 §3).
 */
async function movePast(routeId: string, daysAgo: number): Promise<string> {
  const day = shiftDateKey(ctx.today, -daysAgo);
  await ctx.db.execute(sql`UPDATE vehicle_routes SET route_date = ${day} WHERE id = ${routeId}`);
  await ctx.db.execute(
    sql`UPDATE waybills SET issued_for_date = ${day} WHERE route_id = ${routeId}`,
  );
  return day;
}

async function transfer(
  auth: { authorization: string },
  targetId: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-routes/${targetId}/correction/transfer`,
    headers: auth,
    payload,
  });
}

/** Листы рейса в порядке выдачи: коррекция оставляет их два — списанный и выписанный взамен. */
async function waybillsOf(routeId: string) {
  const rows = await ctx.db.execute<{
    id: string;
    status: string;
    number: string;
    vehicle_id: string;
    cancel_reason: string;
    cancel_correction_id: string | null;
    correction_id: string | null;
    correction_reason: string;
    corrects_waybill_id: string | null;
  }>(sql`
    SELECT id, status, number::text AS number, vehicle_id, cancel_reason, cancel_correction_id,
           correction_id, correction_reason, corrects_waybill_id
    -- Сортировка по колонке таблицы, а не по выходной: приведение к тексту переопределяет имя,
    -- и ORDER BY number взял бы текст — лексикографический порядок, в котором «9999» стоит после
    -- «10000». Пара «списанный / выписанный взамен» поменялась бы местами на границе разрядности,
    -- и проверка статусов упала бы ни с того ни с сего. Номера сейчас около 8600, до границы
    -- порядка полутора тысяч листов — мина отложенного действия.
    FROM waybills WHERE route_id = ${routeId} ORDER BY waybills.number`);
  return rows.rows;
}

/** Талоны листа: ими проверяется, что задание собрано новым составом, а не прежним. */
async function talonsOf(waybillId: string): Promise<{ request_id: string; slot: number }[]> {
  const rows = await ctx.db.execute<{ request_id: string; slot: number }>(
    sql`SELECT request_id, slot FROM waybill_requests WHERE waybill_id = ${waybillId} ORDER BY slot`,
  );
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

describe.skipIf(!DB_URL)('перенос заявки между рейсами задним числом (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    await seedUser(ADMIN_EMAIL, 'admin');
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
    const [first, second] = freight.rows;
    if (!first || !second) {
      throw new Error('в базе нет двух своих грузовых машин: миграции наполнения не применены');
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      dispatcher: await login(DISPATCHER_EMAIL),
      manager: await login(MANAGER_EMAIL),
      objectId: '',
      objectAddress: '',
      vehicleId: first.id,
      otherVehicleId: second.id,
      driverId: await seedDriver('Первый'),
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

  it('переносит талон между прошедшими днями: два номера списаны, два выписаны, назначение переехало', async () => {
    // Источник: две заявки одной машины. Приёмник: другая машина другого дня — именно на неё и
    // переедет назначение (ADR 0052 п. 4).
    const stay = await freightInProgress({ vehicleId: ctx.vehicleId });
    const moving = await freightInProgress({ vehicleId: ctx.vehicleId, routeId: stay.routeId });
    const arrived = await freightInProgress({ vehicleId: ctx.otherVehicleId });
    const sourceId = stay.routeId;
    const targetId = arrived.routeId;

    await issueWaybill(sourceId);
    await issueWaybill(targetId);
    const sourceDay = await movePast(sourceId, 3);
    const targetDay = await movePast(targetId, 2);
    const oldSheets = {
      source: (await waybillsOf(sourceId))[0]!,
      target: (await waybillsOf(targetId))[0]!,
    };

    const operationId = uuid();
    const reason = 'Заявку оформили средой, а ехала она вторничным рейсом';
    /*
     * Через помощника: листов здесь два, подтверждений тоже два (Р21а) — и обвязка вокруг них была
     * бы длиннее самой проверки, предмет которой ниже: два списанных номера, два выписанных и
     * переехавшее назначение.
     */
    const { res } = await transferRequestWithAck({
      app: ctx.app,
      headers: ctx.dispatcher,
      targetRouteId: targetId,
      payload: {
        operationId,
        version: (await routeOf(targetId)).version,
        source: { routeId: sourceId, version: (await routeOf(sourceId)).version },
        requestId: moving.id,
        reason,
      },
    });

    // Ответ несёт обе стороны: операция изменила два рейса, и показать один значило бы оставить
    // второй с прежним номером листа на экране.
    const body = res.json();
    expect(body.target.id).toBe(targetId);
    expect(body.source.id).toBe(sourceId);
    expect(body.target.routeDate).toBe(targetDay);
    expect(body.source.routeDate).toBe(sourceDay);
    // Талон встал последним у приёмника, а талоны источника уплотнились: дыра в нумерации означала
    // бы пустую графу в бланке.
    expect(body.target.requests.map((r: { requestId: string }) => r.requestId)).toEqual([
      arrived.id,
      moving.id,
    ]);
    expect(body.source.requests).toHaveLength(1);
    expect(body.source.requests[0].position).toBe(1);

    // Оба номера списаны, оба новых выписаны — и каждый ссылается на свой заменённый (Р10, Р32).
    const sourceSheets = await waybillsOf(sourceId);
    const targetSheets = await waybillsOf(targetId);
    expect(sourceSheets).toHaveLength(2);
    expect(targetSheets).toHaveLength(2);
    for (const [old, fresh] of [sourceSheets, targetSheets]) {
      expect(old!.status).toBe('cancelled');
      expect(old!.cancel_reason).toBe(reason);
      expect(fresh!.status).toBe('issued');
      expect(fresh!.correction_reason).toBe(reason);
      expect(fresh!.corrects_waybill_id).toBe(old!.id);
      // Ссылки две и они разные: операция, породившая номер, и операция, его списавшая (Р12).
      expect(fresh!.correction_id).toBe(old!.cancel_correction_id);
    }
    expect(oldSheets.source.id).toBe(sourceSheets[0]!.id);
    expect(oldSheets.target.id).toBe(targetSheets[0]!.id);

    // Задание новых листов собрано новым составом, а не прежним: талон уехал вместе с бумагой.
    expect((await talonsOf(targetSheets[1]!.id)).map((t) => t.request_id)).toEqual([
      arrived.id,
      moving.id,
    ]);
    expect((await talonsOf(sourceSheets[1]!.id)).map((t) => t.request_id)).toEqual([stay.id]);

    // Назначение переехало на машину приёмника, а версии заявок обоих рейсов выросли (Р24).
    const after = await assignmentOf(moving.id);
    expect(after.vehicle_id).toBe(ctx.otherVehicleId);
    expect((await assignmentOf(stay.id)).version).toBeGreaterThan(1);
    expect((await assignmentOf(arrived.id)).version).toBeGreaterThan(1);

    // Одна запись операции на оба рейса и оба листа (Р16, Р30).
    const corrections = await correctionsOf(operationId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.kind).toBe('transfer');
    const payload = corrections[0]!.payload as {
      routes: { source: { emptied: boolean } };
      requests: { requestId: string; vehicleId: { before: string; after: string } }[];
    };
    expect(payload.routes.source.emptied).toBe(false);
    expect(payload.requests).toEqual([
      expect.objectContaining({
        requestId: moving.id,
        vehicleId: { before: ctx.vehicleId, after: ctx.otherVehicleId },
      }),
    ]);

    // Связь с операцией — только у переехавшей заявки: «что делали с ней задним числом» вопрос
    // про неё одну (Р16, DDL §7 плана).
    const links = await ctx.db.execute<{ request_id: string }>(sql`
      SELECT request_id FROM vehicle_request_corrections
      WHERE correction_id = ${corrections[0]!.id}`);
    expect(links.rows.map((r) => r.request_id)).toEqual([moving.id]);

    // Версия рейса выросла у обоих: повтор со старой — 409, а не второй перенос (Р24).
    const stale = await transfer(ctx.dispatcher, targetId, {
      operationId: uuid(),
      version: 0,
      source: { routeId: sourceId, version: 0 },
      requestId: stay.id,
      reason: 'ещё раз',
    });
    expect(stale.statusCode, stale.body).toBe(409);
  }, 180_000);

  it('опустевший источник остаётся пустым: второго листа ему не выписывают (Р22)', async () => {
    const moving = await freightInProgress({ vehicleId: ctx.vehicleId });
    const arrived = await freightInProgress({ vehicleId: ctx.otherVehicleId });
    await issueWaybill(moving.routeId);
    await issueWaybill(arrived.routeId);
    await movePast(moving.routeId, 4);
    await movePast(arrived.routeId, 1);

    const operationId = uuid();
    // Подтверждение здесь одно: опустевшему источнику лист не выписывается вовсе (Р22) — и
    // помощник кладёт отпечаток в ту половину, которую назвал сам сервер.
    const { res } = await transferRequestWithAck({
      app: ctx.app,
      headers: ctx.admin,
      targetRouteId: arrived.routeId,
      payload: {
        operationId,
        version: (await routeOf(arrived.routeId)).version,
        source: { routeId: moving.routeId, version: (await routeOf(moving.routeId)).version },
        requestId: moving.id,
        reason: 'Ехала не своим днём',
      },
    });

    // У источника один лист — списанный. Перевыписка пустого бланка сожгла бы номер на бумагу с
    // пустым заданием, а сам рейс остаётся: на него ссылается аннулированный лист.
    const sourceSheets = await waybillsOf(moving.routeId);
    expect(sourceSheets).toHaveLength(1);
    expect(sourceSheets[0]!.status).toBe('cancelled');
    expect(res.json().source.requests).toHaveLength(0);
    expect(res.json().source.waybill.status).toBe('cancelled');
    expect(await waybillsOf(arrived.routeId)).toHaveLength(2);

    const payload = (await correctionsOf(operationId))[0]!.payload as {
      routes: { source: { emptied: boolean } };
    };
    expect(payload.routes.source.emptied).toBe(true);
  }, 180_000);

  it('день линейного заказа этой дверью не ходит — отказ отправляет в карточку заявки', async () => {
    const linear = await linearInProgress();
    const dayRouteId = await planDay(linear.id, ctx.today);
    const arrived = await freightInProgress({ vehicleId: ctx.otherVehicleId });

    const res = await transfer(ctx.admin, arrived.routeId, {
      operationId: uuid(),
      version: (await routeOf(arrived.routeId)).version,
      source: { routeId: dayRouteId, version: (await routeOf(dayRouteId)).version },
      requestId: linear.id,
      reason: 'Пробуем перетащить день',
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('карточке заявки');
    // Ничего не тронуто: день остался в своём рейсе.
    expect((await routeOf(dayRouteId)).requests.map((r) => r.requestId)).toEqual([linear.id]);
  }, 180_000);

  it('перенос в тот же рейс отклоняется до всякой блокировки', async () => {
    const request = await freightInProgress({ vehicleId: ctx.vehicleId });
    const version = (await routeOf(request.routeId)).version;
    const res = await transfer(ctx.admin, request.routeId, {
      operationId: uuid(),
      version,
      source: { routeId: request.routeId, version },
      requestId: request.id,
      reason: 'Никуда не переносим',
    });
    expect(res.statusCode, res.body).toBe(422);
  }, 180_000);

  /**
   * Дыра 1, первая половина: рейс на прошедшую дату заводился без единой проверки. Три исхода
   * `backdateGuard` — право, причина, успех (Р29): коды разные, потому что разные и поручения
   * человеку.
   */
  it('рейс задним числом заводится только с правом и причиной', async () => {
    const day = shiftDateKey(ctx.today, -2);
    const create = (auth: { authorization: string }, payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/vehicle-routes',
        headers: auth,
        payload: { vehicleId: ctx.vehicleId, driverPersonId: ctx.driverId, ...payload },
      });

    const denied = await create(ctx.manager, { routeDate: day, reason: 'Рейс был во вторник' });
    expect(denied.statusCode, denied.body).toBe(403);

    const noReason = await create(ctx.dispatcher, { routeDate: day });
    expect(noReason.statusCode, noReason.body).toBe(422);

    const created = await create(ctx.dispatcher, {
      routeDate: day,
      reason: 'Рейс состоялся во вторник, в портал заводим сегодня',
    });
    expect(created.statusCode, created.body).toBe(201);
    createdRoutes.push(created.json().id as string);

    // Сегодняшний и завтрашний рейс — обычная работа: ни права, ни причины (граница включительная).
    const today = await create(ctx.manager, { routeDate: ctx.today });
    expect(today.statusCode, today.body).toBe(201);
    createdRoutes.push(today.json().id as string);
  }, 180_000);

  /**
   * Дыра 1, вторая половина: границы на заведении рейса мало — вчерашний рейс уже существует, а
   * выписка про день не спрашивала вовсе (Р29). Лист, выписанный задним числом, объяснён операцией
   * `issue` при пустом `corrects_waybill_id`: заменять было нечего (Р35).
   */
  it('лист на прошедший день выписывается операцией, с причиной и без второго номера на повторе', async () => {
    const request = await freightInProgress({ vehicleId: ctx.vehicleId });
    await movePast(request.routeId, 3);
    const version = (await routeOf(request.routeId)).version;
    const issue = (auth: { authorization: string }, payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-routes/${request.routeId}/waybill`,
        headers: auth,
        payload: { version, ...payload },
      });

    const denied = await issue(ctx.manager, { reason: 'Лист выписывали в тот же день, на бумаге' });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(await waybillsOf(request.routeId)).toHaveLength(0);

    const noReason = await issue(ctx.dispatcher, {});
    expect(noReason.statusCode, noReason.body).toBe(422);

    // Право и причина есть, ключа операции нет: повтор после обрыва связи сжёг бы второй номер.
    const noKey = await issue(ctx.dispatcher, { reason: 'Бумагу выписали на месте, вносим позже' });
    expect(noKey.statusCode, noKey.body).toBe(422);
    expect(noKey.json().message).toContain('ключ');

    const operationId = uuid();
    const reason = 'Бумагу выписали в тот день на месте, в портал вносим сегодня';
    /*
     * Задняя выписка подтверждает ту же бумагу, что и дневная (Р21), и помощник проходит за неё
     * обе половины разговора. Тело, каким команда **прошла**, забирается наружу: повтор ниже идёт
     * ровно им — подтверждение лежит в том же теле, и отпечаток идемпотентности (Р31) считается со
     * всего тела целиком.
     */
    const { payload: accepted } = await issueRouteWaybill({
      app: ctx.app,
      headers: ctx.dispatcher,
      routeId: request.routeId,
      payload: { version, reason, operationId },
    });

    const sheets = await waybillsOf(request.routeId);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.correction_reason).toBe(reason);
    // Ссылки на заменённый номер нет: лист рождён не взамен другого — и в фильтр журнала он
    // попадает по ссылке на операцию, а не по `corrects_waybill_id` (Р28, Р35).
    expect(sheets[0]!.corrects_waybill_id).toBeNull();
    const corrections = await correctionsOf(operationId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.kind).toBe('issue');
    expect(sheets[0]!.correction_id).toBe(corrections[0]!.id);

    /*
     * Повтор той же командой целиком — вместе с версией рейса: отпечаток считается с
     * нормализованного тела (Р31). Номер не тратится, второй записи операции нет.
     */
    const repeat = await issue(ctx.dispatcher, accepted);
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(await waybillsOf(request.routeId)).toHaveLength(1);
    expect(await correctionsOf(operationId)).toHaveLength(1);
  }, 180_000);
});
