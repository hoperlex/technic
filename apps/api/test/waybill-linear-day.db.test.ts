import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Задание 4-П для дня линейного заказа (ADR 0100 §10, миграция 0127).
 *
 * День линейной техники стоит в рейсе строкой состава с заполненным `work_date` и печатается той
 * же строкой задания, какой печатается заявка-грузоперевозка. Собирался снимок листа при этом
 * только из `freight_transport_request_details` — деталей, которых у заказа техники на объект нет
 * вовсе: все `LEFT JOIN` отдавали NULL, и день выходил из принтера **пустой строкой**. Молча:
 * ключи снимка на месте, разметка бланка сходится, все прочие проверки довольны, а на бумаге у
 * водителя нет ни адреса площадки, ни телефона того, кто его там встретит.
 *
 * Отсюда и живая схема. Проверяется здесь не правило — правил в этой сборке нет ни одного, — а то,
 * что запрос снимка читает те таблицы, в которых у заказа на объект лежат объект, комментарий и
 * ответственный. Ни на моках, ни на чистых функциях такая ошибка не воспроизводится: разъезжаются
 * код и база.
 *
 * **Снимок читает точки, а не состав** (план `docs/route-trips-plan.md`, Р11б). Прежняя редакция
 * этого файла утверждала обратное и клала строки в рейс одним `INSERT` в `vehicle_route_requests` —
 * с переездом на ездки и точки это стало неправдой ровно того же рода, какую тест и заводился
 * ловить: строка состава без своей точки не печатается никак, а выписка отвечает блокирующим
 * `rows_unplaced`. Поэтому каждая строка получает здесь свою точку теми же функциями, какими её
 * ставят рабочие ручки: линейный день — `placeLinearDay` (одна точка `work`, Р5а), грузоперевозка
 * — `placeRequestTrips` (погрузка и разгрузка на ездку, Р8).
 *
 * Состав по-прежнему заводится прямым `INSERT`: дверь со стороны карточки заявки (ADR 0100 §8)
 * заводится соседней частью работы, а печать от того, чьими руками строка туда попала, не зависит.
 * Раскладка же — не «действие пользователя», а часть самого состояния маршрута, и подменять её
 * выдумкой значило бы печатать бумагу по данным, которых сервер не собрал бы.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_snapshot \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-linear-day-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестового водителя: по ней его и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: задание линейного дня';
/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Код заведённой площадки — с «яя», и это не шутка, а требование соседства. Половина db-тестов
 * берёт объект из справочника выражением `ORDER BY code LIMIT 1`; запись с кодом на латинице
 * стала бы для них первой, и заявки соседних файлов уехали бы на тестовую площадку, а уборка
 * этого файла упёрлась бы в чужие ссылки. Код, стоящий в справочнике последним, эту дверь
 * закрывает. У типа ТС тот же приём — в наименовании: код у него только латиницей (`createType`).
 */
const OBJECT_PREFIX = `яя-lin-day-${RUN}`;
const TYPE_PREFIX = `linear_day_${RUN}`;

/**
 * Ответственные за встречу машины: у каждого дня свой. Имена и номера выдуманы и своими цифрами
 * ни на кого не похожи — база у db-тестов общая, а справочник водителей ищет людей по подстроке
 * номера и проверяет, что номер находит ровно одного (`drivers-search`).
 */
const SITE_A = { name: 'Линейный Пётр Сергеевич', phone: '9007770741' };
const SITE_B = { name: 'Дневной Игорь Львович', phone: '9007770742' };
const SITE_C = { name: 'Вечерний Семён Ильич', phone: '9007770743' };
/** Контакты грузового рейса — им проверяется, что строка грузоперевозки печатается как прежде. */
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770744' };
const UNLOADING = { name: 'Приёмов Валентин Тарасович', phone: '9007770745' };

/** Комментарий заказа: у линейной техники в графе груза стоит характер работ, а не тонны. */
const WORK_A = 'Планировка площадки';
const WORK_B = 'Уборка снега';
const WORK_C = 'Мойка проездов';

interface TestObject {
  id: string;
  name: string;
  address: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Раскладка строк состава точками: ею живёт бумага (Р11б), и подменять её тесту нечем. */
  placeLinearDay: (typeof import('../src/services/route-points'))['placeLinearDay'];
  placeRequestTrips: (typeof import('../src/services/route-points'))['placeRequestTrips'];
  auth: { authorization: string };
  /** Своя грузовая машина с бланком 4-П: рейс заводится только на собственную технику. */
  vehicleId: string;
  personId: string;
  linearTypeId: string;
  freightTypeId: string;
  objectA: TestObject;
  objectB: TestObject;
  /** День рейса, он же `work_date` линейных дней: составной FK требует их совпадения. */
  routeDate: string;
  dateTo: string;
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
 * Водитель рейса: человек со специализацией «водитель». Удостоверения ему не заводим — отбор
 * водителей ставит одно условие, «человек есть и он водитель» (ADR 0064), а графы документов
 * проверяет соседний файл (`waybill-blank.db.test.ts`): здесь проверяется задание, а не реквизиты.
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
      lastName: 'Линейнов',
      firstName: 'Тест',
      middleName: 'Дневной',
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

/**
 * Своя площадка с известными наименованием и адресом: графа «Куда» линейного дня печатает их
 * обоих, и сверять её с чужой записью справочника (у которой адрес может оказаться пустым)
 * значило бы проверять сложение на нуле.
 */
async function createObject(suffix: string, name: string, address: string): Promise<TestObject> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${`${OBJECT_PREFIX}-${suffix}`}, ${name}, ${address})
    RETURNING id`);
  return { id: rows.rows[0]!.id, name, address };
}

/**
 * Тип ТС для заказов теста. Линейным бывает тип любого вида (ADR 0100 §11) — здесь оба типа
 * грузового вида: на этой же машине едет рейс, и грузоперевозку выполняет только грузовой вид.
 *
 * Наименование начинается с «Ямобуры…» по той же причине, по какой коды начинаются с «яя»:
 * соседние файлы берут тип из справочника первым по имени.
 */
async function createType(kindId: string, isLinear: boolean): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'frt'}`,
      name: `Ямобуры тестовые (${isLinear ? 'линейный день' : 'грузовой рейс'} ${RUN})`,
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
 * Заказ линейной техники на объект, доведённый до работы: заявка, виза, перевод в работу.
 * Машинист не передаётся — листов ЭСМ-2 у линейного заказа сам портал не выписывает (ADR 0100 §5).
 */
async function linearRequest(
  object: TestObject,
  comment: string,
  site: { name: string; phone: string },
): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: object.id,
      vehicleTypeId: ctx.linearTypeId,
      dateFrom: ctx.routeDate,
      dateTo: ctx.dateTo,
      responsibleName: site.name,
      responsiblePhone: site.phone,
      comment,
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
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.routeDate,
        dateTo: ctx.dateTo,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return request.id as string;
}

/**
 * Грузоперевозка со всеми деталями, доведённая до работы. Ею проверяется, что разбор по виду
 * заявки не сломал того, что печаталось до линейных дней: в рейсе она стоит рядом с днём.
 *
 * Детали заводятся запросом — их-то снимок и печатает, и выдумывать их прямой вставкой значило бы
 * проверять бумагу по данным, которых сервер бы не принял. А вот в работу заявка переводится
 * `UPDATE`: настоящий перевод грузоперевозки требует назначения с рейсом, то есть той самой сборки
 * состава, которую этот файл и так собирает руками (см. `putRow`). Выписке от заявки нужен только
 * статус — состав и бланк она читает сама.
 */
async function freightRequest(): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectA.id,
      vehicleTypeId: ctx.freightTypeId,
      // Подача — сегодня в рабочем окне: рейс собран на сегодня, а задним числом заявку не завести.
      scheduledAt: `${ctx.routeDate}T10:00:00+03:00`,
      // Адреса, количество и контакты — у ездки, а не у заявки (Р2): у заявки с ездками `A→B` и
      // `A→C` «адрес разгрузки заявки» не существует. Одна ездка — то же, чем была пара полей.
      //
      // Оба конца маршрута — свои площадки из справочника: сервер сверяет адрес ездки с записью,
      // на которую та ссылается, и выдуманной строки при `source: 'object'` не примет.
      trips: [
        {
          fromLocation: ctx.objectB.address,
          toLocation: ctx.objectA.address,
          fromAddress: { source: 'object', refId: ctx.objectB.id },
          toAddress: { source: 'object', refId: ctx.objectA.id },
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

  await approve(request);
  await ctx.db.execute(sql`
    UPDATE vehicle_requests
    SET status = 'confirmed', version = version + 1
    WHERE id = ${request.id}`);
  return request.id as string;
}

/** Рейс дня: машина, дата и водитель — всё, чего лист требует помимо задания. */
async function createRoute(): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.auth,
    payload: {
      vehicleId: ctx.vehicleId,
      routeDate: ctx.routeDate,
      driverPersonId: ctx.personId,
      trip: { communicationKind: 'городское' },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const route = created.json();
  createdRoutes.push(route.id as string);
  return route.id as string;
}

/**
 * Строка состава рейса **вместе с её раскладкой**. `work_date` заполнен — день линейного заказа,
 * NULL — грузоперевозка, как было (миграция 0127). День равен дню рейса физически: составной
 * внешний ключ `(route_id, work_date) → vehicle_routes (id, route_date)` другой пары не пропустит.
 *
 * Точки ставятся тут же и теми же функциями, что и у рабочих ручек: задание печатается из точек
 * (Р11б), и строка состава без точки не печатается вовсе — выписка отвечает `rows_unplaced`.
 * Одной транзакцией, потому что `placeLinearDay` и `placeRequestTrips` её и требуют: раскладка
 * читает уже вставленную строку состава (роль заводится только там, где заявка в составе, §5.3).
 */
async function putRow(
  routeId: string,
  requestId: string,
  position: number,
  workDate: string | null,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
      VALUES (${routeId}, ${requestId}, ${position}, ${workDate})`);
    if (workDate === null) await ctx.placeRequestTrips(tx, routeId, requestId);
    else await ctx.placeLinearDay(tx, routeId, requestId, workDate);
  });
}

/** День линейного заказа: он ходит в рейс только своей датой — датой самого рейса. */
const putDay = (routeId: string, requestId: string, position: number): Promise<void> =>
  putRow(routeId, requestId, position, ctx.routeDate);

/** Версия рейса на сейчас: состав меняли и запросом, и напрямую, а выписка спрашивает свежую. */
async function routeVersion(routeId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

interface IssuedSheet {
  data: Record<string, string>;
  /** Талоны заказчиков: строка состава и её место в бланке. */
  talons: { slot: number; requestId: string }[];
}

/** Выписать лист по рейсу и прочитать его снимок из журнала — им и проверяется бумага. */
async function issue(routeId: string): Promise<IssuedSheet> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-routes/${routeId}/waybill`,
    headers: ctx.auth,
    payload: { version: await routeVersion(routeId) },
  });
  expect(res.statusCode, res.body).toBe(200);
  const waybillId = res.json().waybill.id as string;

  const sheets = await ctx.db.execute<{ data: Record<string, string> }>(
    sql`SELECT data FROM waybills WHERE id = ${waybillId}`,
  );
  const talons = await ctx.db.execute<{ slot: number; request_id: string }>(
    sql`SELECT slot, request_id FROM waybill_requests WHERE waybill_id = ${waybillId} ORDER BY slot`,
  );
  return {
    data: sheets.rows[0]!.data,
    talons: talons.rows.map((r) => ({ slot: Number(r.slot), requestId: r.request_id })),
  };
}

/** Площадка так, как её печатает графа «Куда»: наименование и адрес. */
const siteLine = (object: TestObject): string => `${object.name}, ${object.address}`;

describe.skipIf(!DB_URL)('задание 4-П для дня линейного заказа (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const { placeLinearDay, placeRequestTrips } = await import('../src/services/route-points');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    // Машина — из справочника, а не своя: её наполняют миграции, и рейс заводится только на
    // собственную активную технику. Грузовой вид с бланком 4-П: на этой же машине едет
    // грузоперевозка смешанного рейса.
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
      ORDER BY v.registration_number
      LIMIT 1`);
    const vehicle = vehicles.rows[0];
    if (!vehicle)
      throw new Error('в базе нет своей грузовой машины с бланком 4-П: миграции не применены');

    const today = moscowDateKeyOf(new Date());
    ctx = {
      app,
      db,
      closeDb,
      placeLinearDay,
      placeRequestTrips,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      vehicleId: vehicle.id,
      personId: await seedDriver(),
      linearTypeId: undefined as never,
      freightTypeId: undefined as never,
      objectA: await createObject(
        'a',
        `Площадка линейного дня А ${RUN}`,
        'г Москва, ул Линейная, д 1',
      ),
      objectB: await createObject(
        'b',
        `Площадка линейного дня Б ${RUN}`,
        'г Москва, ул Дневная, д 2',
      ),
      routeDate: today,
      // Срок с запасом: день рейса обязан лежать внутри него, а прогон бывает и в 23:59.
      dateTo: shiftDateKey(today, 7),
    };
    ctx.linearTypeId = await createType(vehicle.kind_id, true);
    ctx.freightTypeId = await createType(vehicle.kind_id, false);
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь листы, рейсы и площадки иначе
     * видны соседним файлам — журналу листов, отборам списка заявок, срезам и сводкам рассылок.
     * Порядок обратный ссылкам: листы (талоны уходят каскадом), рейсы (состав каскадом), заказы
     * (детали и назначения каскадом), потом справочники и человек. Учётка остаётся намеренно — на
     * неё ссылается журнал аудита, а `seedAdmin` переиспользует её при следующем прогоне.
     *
     * Справочники сносятся с оглядкой на чужие ссылки: файлы идут параллельно, и заявку на здешнем
     * типе или площадке успевает завести сосед, берущий их из справочника запросом. Остались
     * ссылки — запись переживает прогон, и это лучше упавшей уборки или испорченного соседа.
     */
    if (ctx?.db) {
      const routes = sql.param(createdRoutes);
      const requests = sql.param(createdRequests);
      await ctx.db.execute(sql`DELETE FROM waybills WHERE route_id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(
        sql`DELETE FROM waybills WHERE source_request_id = ANY(${requests}::uuid[])`,
      );
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM construction_objects
        WHERE code LIKE ${`${OBJECT_PREFIX}%`}
          AND id NOT IN (SELECT object_id FROM vehicle_requests WHERE object_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${PERSON_MARK}
          AND id NOT IN (SELECT driver_person_id FROM waybills)
          AND id NOT IN (SELECT driver_person_id FROM vehicle_routes WHERE driver_person_id IS NOT NULL)`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('день печатается объектом заявки: «Куда» с адресом, контакт встречающего, талон', async () => {
    const route = await createRoute();
    const first = await linearRequest(ctx.objectA, WORK_A, SITE_A);
    const second = await linearRequest(ctx.objectB, WORK_B, SITE_B);
    await putDay(route, first, 1);
    await putDay(route, second, 2);

    const sheet = await issue(route);

    // Строка задания шапки — день, стоящий в рейсе первым.
    expect(sheet.data.task_to).toBe(siteLine(ctx.objectA));
    // Ответственный за встречу машины — фамилией с инициалами и номером единого вида: тем же
    // правилом, каким печатаются контакты грузового рейса.
    expect(sheet.data.task_contacts).toBe('Линейный П.С., +7 (900) 777 07 41');
    // «Откуда» пусто намеренно: машина выходит из гаража, а места стоянки портал не ведёт —
    // его вписывают от руки (ADR 0100 §10).
    expect(sheet.data.task_from).toBe('');
    // Количества у линейного дня нет — в графе груза остаётся характер работ из комментария.
    expect(sheet.data.task_cargo).toBe(WORK_A);
    // Время выезда назначает диспетчер утром: в заказе на объект его нет вовсе.
    expect(sheet.data.task_departure_time).toBe('');
    // Шапка «в чьё распоряжение» — заказчик первого талона.
    expect(sheet.data.customer_name).toBe(ctx.objectA.name);
    expect(sheet.data.customer_address).toBe(ctx.objectA.address);

    // Тот же день, стоящий в рейсе вторым: строки 2–7 собираются отдельным запросом, и
    // разъехаться с первой им негде — линейный день бывает в рейсе и первым, и пятым.
    expect(sheet.data.task2_to).toBe(siteLine(ctx.objectB));
    expect(sheet.data.task2_contacts).toBe('Дневной И.Л., +7 (900) 777 07 42');
    expect(sheet.data.task2_from).toBe('');
    expect(sheet.data.task2_cargo).toBe(WORK_B);

    // Талон заказчика день получает наравне с грузовой заявкой: подпись объекта за день работы —
    // ровно то, ради чего талон и оторвут (ADR 0100 §10).
    expect(sheet.talons).toEqual([
      { slot: 1, requestId: first },
      { slot: 2, requestId: second },
    ]);
  });

  it('в смешанном рейсе грузоперевозка печатается по-прежнему, а день — по-своему', async () => {
    const route = await createRoute();
    // Грузоперевозка стоит в рейсе первой, день линейного заказа — вторым: машина везёт груз, а
    // потом уходит работать на площадку, и обе работы дня печатает один лист.
    const freight = await freightRequest();
    const day = await linearRequest(ctx.objectA, WORK_C, SITE_C);
    await putRow(route, freight, 1, null);
    await putDay(route, day, 2);

    const sheet = await issue(route);

    // Строка грузоперевозки: маршрут её деталей и два контакта — по одному на каждый конец.
    expect(sheet.data.task_from).toBe(ctx.objectB.address);
    expect(sheet.data.task_to).toBe(ctx.objectA.address);
    // Объём печатается так, как хранится, — `numeric(12,3)` из базы приходит строкой «12.000».
    expect(sheet.data.task_cargo).toBe('12.000 м³\nПесок сеяный');
    expect(sheet.data.task_contacts).toBe(
      'Складов А.Ю., +7 (900) 777 07 44\nПриёмов В.Т., +7 (900) 777 07 45',
    );
    expect(sheet.data.task_departure_time).toBe('10:00');

    // Строка линейного дня в том же листе: собрана из заказа на объект, а не из деталей, которых
    // у него нет.
    expect(sheet.data.task2_to).toBe(siteLine(ctx.objectA));
    expect(sheet.data.task2_from).toBe('');
    expect(sheet.data.task2_cargo).toBe(WORK_C);
    expect(sheet.data.task2_contacts).toBe('Вечерний С.И., +7 (900) 777 07 43');

    expect(sheet.talons).toEqual([
      { slot: 1, requestId: freight },
      { slot: 2, requestId: day },
    ]);
  });
});
