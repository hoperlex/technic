import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Дни линейного заказа в рейсах (ADR 0100, миграция 0127) — на живой схеме и настоящими путями.
 *
 * Зачем база. Половину поведения здесь держит не сервер, а схема: «в один день — ровно один рейс»
 * это частичный UNIQUE, «день строки равен дню рейса» — составной внешний ключ с `ON UPDATE
 * CASCADE`, и перенос рейса уносит день **сам**, без единой строки кода. Проверить это на правилах
 * невозможно: расходятся не правила, а код и база. Ровно там же живут отказы, которые обязаны быть
 * словами, а не 23505 из глубины транзакции, — перенос рейса в занятый день и на дату за сроком.
 *
 * Вторая половина — соседи: грузоперевозка обязана вести себя ровно как прежде (её строка состава
 * дня не несёт), а линейный заказ не должен получить ни перегона, ни второй двери со стороны рейса.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_days \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-linear-days-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: дни линейного заказа';
/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды заведённых записей — с «яя», и это не шутка, а требование соседства: половина db-тестов
 * берёт объект и тип из справочника выражением `ORDER BY … LIMIT 1`, и запись, ставшая первой,
 * молча увела бы их заявки на тестовую площадку. У типа тем же приёмом начинается наименование:
 * код у него только латиницей.
 */
const OBJECT_CODE = `яя-lin-days-${RUN}`;
const TYPE_PREFIX = `linear_days_${RUN}`;
const TYPE_NAME_PREFIX = 'Ямобуры тестовые (дни';

/** Контакты заказа: номера выдуманы и своими цифрами ни на кого не похожи — база общая. */
const SITE = { name: 'Дневалов Пётр Сергеевич', phone: '9007770751' };
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770752' };
const UNLOADING = { name: 'Приёмов Валентин Тарасович', phone: '9007770753' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  objectAddress: string;
  /** Две свои грузовые машины с бланком 4-П: день выходит то одной, то другой (ADR 0100 §4). */
  vehicleId: string;
  otherVehicleId: string;
  driverId: string;
  /** Тип линейный и тип обычный — оба грузового вида: на объект вызывают технику любого вида. */
  linearTypeId: string;
  plainTypeId: string;
  /** Срок заказа: сегодня плюс неделя — дней с запасом на перенос рейса вперёд. */
  dateFrom: string;
  dateTo: string;
  /** Дни, которые планирует тест: оба внутри срока и не крайние. */
  dayA: string;
  dayB: string;
}

let ctx: Ctx;

/** Что завёл этот файл: по этим спискам он за собой и убирает. */
const createdRequests: string[] = [];
const createdRoutes: string[] = [];

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/**
 * Водитель рейса: человек со специализацией «водитель». Удостоверения не заводим — отбор водителя
 * ставит одно условие, «человек есть и он водитель» (ADR 0064), а графы документов проверяет
 * соседний файл (`waybill-blank.db.test.ts`).
 */
async function seedDriver(): Promise<string> {
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
      lastName: 'Дневников',
      firstName: 'Тест',
      middleName: 'Линейный',
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

/** Своя площадка: чужую запись справочника тест не трогает, а свою убирает за собой. */
async function createObject(): Promise<{ id: string; address: string }> {
  const { db } = await import('../src/db/client');
  const address = 'г Москва, ул Дневная, д 3';
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка дней линейного заказа ${RUN}`}, ${address})
    RETURNING id`);
  return { id: rows.rows[0]!.id, address };
}

/**
 * Тип ТС для заказов теста. Линейным бывает тип любого вида (ADR 0100 §11) — здесь оба грузового:
 * на этих же машинах едут рейсы дней, а грузоперевозку выполняет только грузовой вид.
 */
async function createType(app: Ctx['app'], auth: Ctx['auth'], kindId: string, isLinear: boolean) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
      name: `${TYPE_NAME_PREFIX}, ${isLinear ? 'линейный' : 'обычный'} ${RUN})`,
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
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/**
 * Заказ техники на объект, доведённый до работы. Машинист не передаётся: у линейного заказа листы
 * ЭСМ-2 сам портал не выписывает (ADR 0100 §5), а обычному он не нужен — этот файл про дни.
 */
async function requestInProgress(
  typeId: string,
  options: { dateTo?: string } = {},
): Promise<{ id: string; version: number }> {
  const dateTo = options.dateTo ?? ctx.dateTo;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.dateFrom,
      dateTo,
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
    headers: ctx.auth,
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
      schedule: { requestType: 'special_equipment', dateFrom: ctx.dateFrom, dateTo },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id as string, version: confirmed.json().version as number };
}

/** Линейный заказ в работе — начало почти каждого случая. */
const linearInProgress = (options: { dateTo?: string } = {}) =>
  requestInProgress(ctx.linearTypeId, options);

/**
 * Грузоперевозка, взятая в работу вместе со своим рейсом: перевод в работу кладёт её в маршрут, и
 * этим случай и ценен — линейные дни не должны были ничего сломать в прежнем пути.
 */
async function freightInProgress(): Promise<{ id: string; version: number; routeId: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.plainTypeId,
      // Подача — сегодня в рабочем окне: рейс её заявки заводится на тот же день.
      scheduledAt: `${ctx.dateFrom}T10:00:00+03:00`,
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
    headers: ctx.auth,
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
  return { id: request.id as string, version: dto.version as number, routeId: dto.route.id };
}

/** Пустой рейс на дату: им проверяются и укладка дня в готовый рейс, и переносы. */
async function createRoute(routeDate: string, vehicleId?: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.auth,
    payload: {
      vehicleId: vehicleId ?? ctx.vehicleId,
      routeDate,
      driverPersonId: ctx.driverId,
      trip: { communicationKind: 'городское' },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const route = created.json();
  createdRoutes.push(route.id as string);
  return route.id as string;
}

/** Поставить день в рейс — в названный либо в новый, заведённый тут же. */
async function planDay(
  requestId: string,
  date: string,
  target: { routeId: string } | { vehicleId?: string },
): ReturnType<typeof ctx.app.inject> {
  const payload =
    'routeId' in target
      ? { routeId: target.routeId }
      : {
          newRoute: {
            vehicleId: target.vehicleId ?? ctx.vehicleId,
            driverPersonId: ctx.driverId,
          },
        };
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload,
  });
  // Рейс, заведённый ручкой планирования, тоже надо убрать за собой.
  if (res.statusCode === 200) {
    const day = res.json().items.find((d: { date: string }) => d.date === date);
    if (day?.route) createdRoutes.push(day.route.id as string);
  }
  return res;
}

/** План по дням: то же, что видит карточка заявки. */
async function daysOf(requestId: string): Promise<{
  items: {
    date: string;
    outOfTerm: boolean;
    otherVehicle: boolean;
    route: { id: string; displayNumber: string; vehicleId: string } | null;
  }[];
  blocker: string | null;
}> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}/days`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Один день плана — по нему и проверяется, куда он встал. */
async function dayOf(requestId: string, date: string) {
  return (await daysOf(requestId)).items.find((d) => d.date === date);
}

/** Версия рейса на сейчас: её спрашивают правка и выписка листа. */
async function routeVersion(routeId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/** Перенести рейс на другую дату — то самое действие, которое тянет за собой дни (ADR 0082). */
async function moveRoute(routeId: string, routeDate: string): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.auth,
    payload: { routeDate, version: await routeVersion(routeId) },
  });
}

/**
 * Выписать лист по рейсу: им рейс замораживается — день из выданного бланка не исчезает.
 *
 * Через помощника: предмет теста — судьба дня под выданной бумагой, а не сама выписка, и
 * рукопожатие (Р21) здесь срабатывает всегда — документов тестовому водителю не заводят.
 */
async function issueWaybill(routeId: string): Promise<void> {
  await issueRouteWaybill({
    app: ctx.app,
    headers: ctx.auth,
    routeId,
    payload: { version: await routeVersion(routeId) },
  });
}

/** Сократить срок заказа: запрос и виза — обоими шагами, как это делает человек (ADR 0044). */
async function shortenTo(
  request: { id: string; version: number },
  newDateTo: string,
): Promise<void> {
  const asked = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/early-end`,
    headers: ctx.auth,
    payload: { newDateTo, reason: 'работы закончены раньше', version: request.version },
  });
  expect(asked.statusCode, asked.body).toBe(200);
  const decided = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/early-end`,
    headers: ctx.auth,
    payload: { approved: true, comment: '', version: asked.json().version },
  });
  expect(decided.statusCode, decided.body).toBe(200);
}

describe.skipIf(!DB_URL)('дни линейного заказа в рейсах (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    // Машины — из справочника: их наполняют миграции, и рейс заводится только на собственную
    // активную технику. Грузовой вид с бланком 4-П — тот самый документ, который печатает день.
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
      ORDER BY v.registration_number
      LIMIT 2`);
    const [first, second] = vehicles.rows;
    if (!first || !second) {
      throw new Error('в базе нет двух своих грузовых машин с бланком 4-П: миграции не применены');
    }

    const today = moscowDateKeyOf(new Date());
    const object = await createObject();
    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: object.id,
      objectAddress: object.address,
      vehicleId: first.id,
      otherVehicleId: second.id,
      driverId: await seedDriver(),
      linearTypeId: await createType(app, auth, first.kind_id, true),
      plainTypeId: await createType(app, auth, first.kind_id, false),
      dateFrom: today,
      dateTo: shiftDateKey(today, 7),
      dayA: shiftDateKey(today, 1),
      dayB: shiftDateKey(today, 2),
    };
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с рейсами иначе видны
     * соседним файлам — журналу листов, отборам списка заявок, срезам и сводкам рассылок. Порядок
     * обратный ссылкам: сначала листы (они держат и рейс, и заявку ключами `restrict`), потом
     * рейсы (состав уходит каскадом), потом заявки, площадка, типы и люди. Учётка теста остаётся
     * намеренно — на неё ссылается журнал аудита, а `seedAdmin` переиспользует её при следующем
     * прогоне.
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

  it('день встаёт в рейс и виден и в плане заказа, и в составе рейса', async () => {
    const request = await linearInProgress();

    const res = await planDay(request.id, ctx.dayA, {});
    expect(res.statusCode, res.body).toBe(200);

    const day = (await dayOf(request.id, ctx.dayA))!;
    expect(day.route).not.toBeNull();
    expect(day.route!.vehicleId).toBe(ctx.vehicleId);
    // Машина дня совпала с назначением — пометки «другая машина» нет (ADR 0100 §4).
    expect(day.otherVehicle).toBe(false);
    expect(day.outOfTerm).toBe(false);
    // Остальные дни срока — строки таблицы без плана: перечень выводится из срока, а не из базы.
    const plan = await daysOf(request.id);
    expect(plan.blocker).toBeNull();
    expect(plan.items).toHaveLength(8);
    expect(plan.items.filter((d) => d.route !== null)).toHaveLength(1);

    // Со стороны рейса день читается строкой состава со своим днём.
    const route = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-routes/${day.route!.id}`,
      headers: ctx.auth,
    });
    expect(route.statusCode, route.body).toBe(200);
    expect(route.json().requests).toHaveLength(1);
    expect(route.json().requests[0].workDate).toBe(ctx.dayA);
    expect(route.json().routeDate).toBe(ctx.dayA);
  });

  it('второй день той же заявки идёт в свой рейс — ради этого признак и заведён', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    // Второй день — другой машиной: у линейного заказа так и работают (ADR 0100 §4).
    const second = await planDay(request.id, ctx.dayB, { vehicleId: ctx.otherVehicleId });
    expect(second.statusCode, second.body).toBe(200);

    const plan = await daysOf(request.id);
    const planned = plan.items.filter((d) => d.route !== null);
    expect(planned.map((d) => d.date)).toEqual([ctx.dayA, ctx.dayB]);
    // Машина второго дня не та, что в назначении, — законное состояние, и оно помечено.
    expect(planned[1]!.otherVehicle).toBe(true);
  });

  it('второй рейс на тот же день — отказ словами, а не 23505 из индекса', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);

    const other = await createRoute(ctx.dayA, ctx.otherVehicleId);
    const res = await planDay(request.id, ctx.dayA, { routeId: other });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('уже стоит в рейсе этой заявки');
  });

  it('день вне срока и рейс другого дня объясняются каждый по-своему', async () => {
    const request = await linearInProgress();

    const outside = await planDay(request.id, shiftDateKey(ctx.dateTo, 1), {});
    expect(outside.statusCode, outside.body).toBe(422);
    expect(outside.json().message).toBe('День вне срока заявки');

    // Рейс соседнего дня день не примет: день строки состава равен дню рейса физически (0127).
    const tomorrow = await createRoute(ctx.dayB);
    const mismatch = await planDay(request.id, ctx.dayA, { routeId: tomorrow });
    expect(mismatch.statusCode, mismatch.body).toBe(422);
    expect(mismatch.json().message).toContain('это один и тот же день');
  });

  it('перенос рейса на другую дату уносит день вместе с собой', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    const routeId = (await dayOf(request.id, ctx.dayA))!.route!.id;

    const moved = await moveRoute(routeId, ctx.dayB);
    expect(moved.statusCode, moved.body).toBe(200);

    // Каскад по составному ключу переписал `work_date` сам: день уехал за рейсом (ADR 0100 §3).
    const plan = await daysOf(request.id);
    expect(plan.items.find((d) => d.date === ctx.dayA)!.route).toBeNull();
    expect(plan.items.find((d) => d.date === ctx.dayB)!.route!.id).toBe(routeId);
  });

  it('перенос в день, где у заявки уже есть рейс, отбивается до переноса', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    expect(
      (await planDay(request.id, ctx.dayB, { vehicleId: ctx.otherVehicleId })).statusCode,
    ).toBe(200);
    const routeB = (await dayOf(request.id, ctx.dayB))!.route!.id;

    const moved = await moveRoute(routeB, ctx.dayA);
    expect(moved.statusCode, moved.body).toBe(422);
    expect(moved.json().message).toContain('уже есть рейс');

    // Ничего не поехало: оба дня остались там, где стояли.
    const plan = await daysOf(request.id);
    expect(plan.items.find((d) => d.date === ctx.dayB)!.route!.id).toBe(routeB);
  });

  it('перенос за срок заказа отбивается тоже — и называет срок', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    const routeId = (await dayOf(request.id, ctx.dayA))!.route!.id;

    const moved = await moveRoute(routeId, shiftDateKey(ctx.dateTo, 3));
    expect(moved.statusCode, moved.body).toBe(422);
    expect(moved.json().message).toContain('за срок её заказа');
    expect(moved.json().message).toContain(ctx.dateTo);
  });

  it('сокращение срока снимает дни, оставшиеся за ним', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    expect(
      (await planDay(request.id, ctx.dayB, { vehicleId: ctx.otherVehicleId })).statusCode,
    ).toBe(200);

    // Срок ужимается до первого дня — оба распланированных дня оказываются за ним.
    await shortenTo(request, ctx.dateFrom);

    const plan = await daysOf(request.id);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.date).toBe(ctx.dateFrom);
    expect(plan.items[0]!.route).toBeNull();

    // Событие о снятых днях — своё: иначе исчезнувший план не объясняется ничем.
    const audit = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'vehicle_request.days_sync' AND entity_id = ${request.id}
      ORDER BY created_at DESC LIMIT 1`);
    expect(String(audit.rows[0]?.metadata.detached)).toContain(ctx.dayA);
  });

  it('замороженный выписанным листом рейс день не отдаёт', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    const routeId = (await dayOf(request.id, ctx.dayA))!.route!.id;

    await issueWaybill(routeId);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/vehicle-requests/${request.id}/days/${ctx.dayA}/route`,
      headers: ctx.auth,
    });
    expect(removed.statusCode, removed.body).toBe(409);
    expect(removed.json().message).toContain('аннулируйте его');
    expect((await dayOf(request.id, ctx.dayA))!.route).not.toBeNull();

    // И сверка его не снимает: сокращённый срок оставляет день в плане с пометкой «вне срока» —
    // бумага на него уже у водителя (ADR 0100 §11).
    const version = (
      await ctx.app
        .inject({
          method: 'GET',
          url: `/api/v1/vehicle-requests/${request.id}`,
          headers: ctx.auth,
        })
        .then((r) => r.json())
    ).version as number;
    await shortenTo({ id: request.id, version }, ctx.dateFrom);
    const plan = await daysOf(request.id);
    const day = plan.items.find((d) => d.date === ctx.dayA)!;
    expect(day.outOfTerm).toBe(true);
    expect(day.route).not.toBeNull();
  });

  it('снятый день освобождает свой день заново', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/vehicle-requests/${request.id}/days/${ctx.dayA}/route`,
      headers: ctx.auth,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      removed.json().items.find((d: { date: string }) => d.date === ctx.dayA).route,
    ).toBeNull();

    // Освободившийся день кладётся заново — уже другой машиной.
    const again = await planDay(request.id, ctx.dayA, { vehicleId: ctx.otherVehicleId });
    expect(again.statusCode, again.body).toBe(200);
  });

  it('отмена заявки снимает все её дни разом', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    expect(
      (await planDay(request.id, ctx.dayB, { vehicleId: ctx.otherVehicleId })).statusCode,
    ).toBe(200);

    const cancelled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'cancelled',
        comment: 'техника не понадобилась',
        version: request.version,
      },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const rows = await ctx.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM vehicle_route_requests WHERE request_id = ${request.id}`);
    expect(rows.rows[0]!.c).toBe(0);
  });

  it('смена машины заявки распланированные дни не двигает', async () => {
    const request = await linearInProgress();
    expect((await planDay(request.id, ctx.dayA, {})).statusCode).toBe(200);
    const routeId = (await dayOf(request.id, ctx.dayA))!.route!.id;

    const changed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/assignment`,
      headers: ctx.auth,
      payload: { vehicleId: ctx.otherVehicleId, version: request.version },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    // День остался в своём рейсе на прежней машине: назначение — машина по умолчанию, не более
    // (ADR 0100 §4). А пометка «другая машина» появилась: теперь назначение указывает на вторую.
    const day = (await dayOf(request.id, ctx.dayA))!;
    expect(day.route!.id).toBe(routeId);
    expect(day.route!.vehicleId).toBe(ctx.vehicleId);
    expect(day.otherVehicle).toBe(true);
  });

  it('перегона у линейного заказа нет: его выезд это обычный рейс дня', async () => {
    const request = await linearInProgress();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request.id}/relocations`,
      headers: ctx.auth,
      payload: {
        purpose: 'delivery',
        routeDate: ctx.dayA,
        moveFrom: 'База',
        moveTo: 'Площадка',
      },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('возвращается на базу');
  });

  it('в чужой перегон день тоже не кладут', async () => {
    // Перегон бывает у обычного заказа техники: его и заводим, чтобы было куда не положить день.
    const plain = await requestInProgress(ctx.plainTypeId);
    const relocation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${plain.id}/relocations`,
      headers: ctx.auth,
      payload: {
        purpose: 'delivery',
        routeDate: ctx.dayA,
        moveFrom: 'База',
        moveTo: 'Площадка',
      },
    });
    expect(relocation.statusCode, relocation.body).toBe(201);
    createdRoutes.push(relocation.json().id as string);

    const linear = await linearInProgress();
    const res = await planDay(linear.id, ctx.dayA, { routeId: relocation.json().id });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('перегон техники');
  });

  it('дверь одна: со стороны рейса линейную заявку не кладут', async () => {
    const request = await linearInProgress();
    const routeId = await createRoute(ctx.dayA);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-routes/${routeId}/requests`,
      headers: ctx.auth,
      payload: { requestId: request.id, version: await routeVersion(routeId) },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('из карточки заявки');
  });

  it('у нелинейного заказа дней нет вовсе — и блок говорит почему', async () => {
    const plain = await requestInProgress(ctx.plainTypeId);
    const plan = await daysOf(plain.id);
    expect(plan.items).toEqual([]);
    expect(plan.blocker).toContain('неделями стояния');

    const res = await planDay(plain.id, ctx.dayA, {});
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('неделями стояния');
  });

  it('грузоперевозка ведёт себя как прежде: один рейс, дня у строки нет', async () => {
    const freight = await freightInProgress();

    // Заявка стоит ровно в одном рейсе, и колонка «Маршрут» в карточке показывает его.
    const dto = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${freight.id}`,
      headers: ctx.auth,
    });
    expect(dto.statusCode, dto.body).toBe(200);
    expect(dto.json().route.id).toBe(freight.routeId);

    const route = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-routes/${freight.routeId}`,
      headers: ctx.auth,
    });
    expect(route.json().requests).toHaveLength(1);
    expect(route.json().requests[0].workDate).toBeNull();

    // Дней у неё не бывает: таблица пустая, причина названа.
    const plan = await daysOf(freight.id);
    expect(plan.items).toEqual([]);
    expect(plan.blocker).toContain('грузоперевозки');
  });
});
