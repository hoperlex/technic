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
 * Встречные блокировки (план `docs/route-trips-plan.md`, Р17) — двумя параллельными транзакциями.
 *
 * Порядок «маршруты → заявки» объявлен [ADR 0050](../../../docs/adr/0050-vehicle-routes.md) п. 12,
 * но объявленного порядка мало: пока он держится тем, что «так написано», всякая новая дверь,
 * взявшая заявку раньше рейса, вводит клинч — и вводит молча. Взаимная блокировка не падает в
 * тестах и не видна в коде: она случается у двух диспетчеров, нажавших одновременно, а Postgres
 * разрывает её, убивая чью-то транзакцию, — человек получает 500 там, где ждал «сохранено».
 *
 * Поэтому файл проверяет не «сейчас зелено», а то, что нарушение канона **будет замечено**.
 * Устройство у всех случаев одно:
 *
 *   1. третья сессия (держатель) берёт `FOR UPDATE` те самые строки, за которые спорят пути, —
 *      обе двери паркуются на первом же захвате, и окно между их захватами перестаёт быть
 *      случайным. Без держателя оно короче миллисекунды, и тест проходил бы по удаче;
 *   2. барьер ждёт, пока обе двери **действительно** встанут в очередь (`pg_blocking_pids`), —
 *      этим задан и порядок очереди, а не только факт ожидания;
 *   3. держатель отпускает всё разом. Дальше решает **код**: берут ли обе двери спорные строки в
 *      одном порядке (тогда они выстраиваются в очередь и отвечают по очереди) или во встречных
 *      (тогда каждая держит то, чего ждёт другая, — взаимная блокировка).
 *
 * Ответ обеих дверей обязан быть **честным**: 200, либо конфликт версий словами, либо отказ по
 * делу. 500 из глубины транзакции ответом не является, и `deadlocks` в `pg_stat_database` при
 * каноническом порядке не растёт. Последний случай файла проверяет сам инструмент: те же два рейса,
 * взятые во встречном порядке нарочно, дают и `40P01`, и рост счётчика — то есть измерять он умеет,
 * и ноль в остальных случаях означает «клинча не было», а не «мы его не увидели бы».
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-route-locks-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: порядок блокировок';
/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/** Коды с «яя»: соседние файлы берут объект и тип «первым попавшимся» (`ORDER BY … LIMIT 1`). */
const OBJECT_CODE = `яя-route-locks-${RUN}`;
const TYPE_PREFIX = `route_locks_${RUN}`;
const OBJECT_ADDRESS = 'г Москва, ул Блокировочная, д 1';

/** Контакты: номера выдуманы и своими цифрами ни на кого не похожи — база общая. */
const SITE = { name: 'Площадкин Семён Артёмович', phone: '9007770781' };
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770782' };
const UNLOADING = { name: 'Приёмов Валентин Тарасович', phone: '9007770783' };

/** Сколько ждать, пока дверь встанет в очередь за строкой: барьер, а не пауза «на глазок». */
const BLOCK_TIMEOUT_MS = 15_000;
/**
 * Пауза перед чтением `pg_stat_database`: счётчики бэкенд сбрасывает в общую статистику не
 * мгновенно, а по концу транзакции и не чаще раза в секунду. Без неё «ноль» означал бы «ещё не
 * доехало», а не «клинча не было».
 */
const STATS_SETTLE_MS = 1500;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
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

/** Водитель рейса: человек со специализацией «водитель» — большего отбор водителя не спрашивает. */
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
      lastName: 'Блокировкин',
      firstName: 'Тест',
      middleName: 'Петрович',
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
async function createObject(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка блокировок ${RUN}`}, ${OBJECT_ADDRESS})
    RETURNING id`);
  return rows.rows[0]!.id;
}

async function createType(app: Ctx['app'], auth: Ctx['auth'], kindId: string, isLinear: boolean) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
      name: `Ямобуры тестовые (блокировки, ${isLinear ? 'линейный' : 'обычный'} ${RUN})`,
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

/** Грузоперевозка в работе: со своим рейсом либо в уже заведённый. */
async function freightInProgress(params: {
  vehicleId: string;
  routeId?: string;
}): Promise<{ id: string; routeId: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.plainTypeId,
      scheduledAt: `${ctx.today}T10:00:00+03:00`,
      trips: [
        {
          fromLocation: OBJECT_ADDRESS,
          toLocation: OBJECT_ADDRESS,
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
  createdRoutes.push(dto.route.id as string);
  return { id: request.id as string, routeId: dto.route.id as string };
}

/** Линейный заказ в работе: дни он получает отдельно, по одному на рейс (Р7). */
async function linearInProgress(dateTo: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.linearTypeId,
      dateFrom: ctx.today,
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
      schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return request.id as string;
}

/** Поставить день заказа в новый рейс. */
async function planDay(requestId: string, date: string, vehicleId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload: { newRoute: { vehicleId, driverPersonId: ctx.driverId } },
  });
  expect(res.statusCode, res.body).toBe(200);
  const day = res.json().items.find((d: { date: string }) => d.date === date);
  expect(day?.route, res.body).toBeTruthy();
  createdRoutes.push(day.route.id as string);
  return day.route.id as string;
}

/** Пустой рейс на дату: им проверяется переезд дня в соседний рейс. */
async function createRoute(routeDate: string, vehicleId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.auth,
    payload: {
      vehicleId,
      routeDate,
      driverPersonId: ctx.driverId,
      trip: { communicationKind: 'городское' },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  createdRoutes.push(res.json().id as string);
  return res.json().id as string;
}

async function routeVersion(routeId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

async function requestVersion(requestId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

// ── Инструмент: держатель строк, барьер и счётчик клинчей ──

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Третья сессия, которая держит спорные строки, пока обе двери встают в очередь.
 *
 * Своим соединением, а не транзакцией пула: пул отдаёт соединения приложению, и держатель,
 * занявший одно из них, спорил бы сам с собой. `pid` нужен барьеру — по нему видно, кого именно
 * ждут двери, и соседний файл, работающий с той же базой параллельно, барьер не обманет.
 */
async function openHolder(): Promise<{
  pid: number;
  hold: (query: string, params?: unknown[]) => Promise<void>;
  release: () => Promise<void>;
}> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const pid = Number(
    (await client.query<{ pid: string }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
  );
  await client.query('BEGIN');
  let closed = false;
  return {
    pid,
    hold: async (query, params = []) => {
      await client.query(query, params);
    },
    release: async () => {
      if (closed) return;
      closed = true;
      await client.query('COMMIT');
      await client.end();
    },
  };
}

/**
 * Ждёт, пока за строками держателя выстроится ровно столько сессий, сколько ожидается.
 *
 * `pg_blocking_pids` вместо `wait_event_type = 'Lock'` намеренно: считаются только те, кого держит
 * **этот** держатель. Иначе барьер снимала бы чужая блокировка соседнего db-теста, и двери
 * стартовали бы вразнобой — то есть тест мерил бы удачу.
 *
 * Обход рекурсивный, и это не украшение: второй ждущий за той же строкой ждёт не держателя, а
 * **первого ждущего** — блокировку кортежа (`tuple`) отдают по очереди, и `pg_blocking_pids`
 * называет ему только соседа. Без обхода барьер вечно видел бы одного, а очередь из двух — ровно
 * то, ради чего он и заведён.
 */
async function waitBlockedBy(pid: number, expected: number): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  for (;;) {
    const rows = await ctx.db.execute<{ n: number }>(sql`
      WITH RECURSIVE waiters AS (
        SELECT a.pid
        FROM pg_stat_activity a
        WHERE a.datname = current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid
        FROM pg_stat_activity a
        JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
        WHERE a.datname = current_database()
      )
      SELECT count(*)::int AS n FROM waiters`);
    if (Number(rows.rows[0]!.n) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `дверь не встала в очередь за строками держателя (ждали ${expected}, дождались ${rows.rows[0]!.n}): ` +
          'либо путь берёт не те строки, либо ответил раньше, чем дошёл до захвата',
      );
    }
    await wait(25);
  }
}

/** Сколько взаимных блокировок Postgres разорвал в этой базе. */
async function deadlocks(): Promise<number> {
  const rows = await ctx.db.execute<{ deadlocks: string }>(
    sql`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`,
  );
  return Number(rows.rows[0]!.deadlocks);
}

/** Счётчик после того, как статистика доехала: см. `STATS_SETTLE_MS`. */
async function deadlocksSettled(): Promise<number> {
  await wait(STATS_SETTLE_MS);
  return deadlocks();
}

/**
 * Ответ двери, который человек в состоянии прочитать: сделано, либо конфликт версий, либо отказ по
 * делу. 500 сюда не входит — так выглядит разорванная взаимная блокировка (`40P01`), пришедшая в
 * ручку из глубины транзакции: команда не выполнена, а сказать об этом человеку нечего.
 */
function expectHonest(label: string, res: { statusCode: number; body: string }): void {
  expect([200, 201, 409, 422], `${label}: ${res.body}`).toContain(res.statusCode);
}

describe.skipIf(!DB_URL)('встречные блокировки: канон «маршруты → заявки» (Р17)', () => {
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

    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: await createObject(),
      vehicleId: first.id,
      otherVehicleId: second.id,
      driverId: await seedDriver(),
      linearTypeId: await createType(app, auth, first.kind_id, true),
      plainTypeId: await createType(app, auth, first.kind_id, false),
      today: moscowDateKeyOf(new Date()),
    };
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с рейсами иначе видны
     * соседним файлам. Порядок обратный ссылкам: сначала листы (они держат и рейс, и заявку
     * ключами `restrict`), потом рейсы, потом заявки, площадка, типы и люди.
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
          AND id NOT IN (SELECT driver_person_id FROM waybills)
          AND id NOT IN (
            SELECT driver_person_id FROM vehicle_routes WHERE driver_person_id IS NOT NULL)`);
    }
    /*
     * Журнал уборка сносит по автору: писали в него только здешние учётки, а видов записей у них
     * несколько — отбор по одному виду сущности оставлял бы остальные. `audit_log` — самая большая
     * таблица общей базы db-тестов, и набирается она как раз такими остатками.
     */
    await ctx?.db.execute(sql`
      DELETE FROM audit_log
       WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  /**
   * Первая пара — та, ради которой `lockRoutePair` и сортирует рейсы по `id`: два диспетчера
   * меняют машину навстречу друг другу, заявка `X` едет из рейса `A` в `B`, заявка `Y` — из `B` в
   * `A`. Каждой двери нужны **оба** рейса, и «свой сначала, чужой потом» здесь самый естественный
   * порядок из возможных — и ровно он даёт клинч.
   *
   * Держатель занимает оба рейса, поэтому обе двери паркуются на первом же захвате: при
   * каноническом порядке — на одной и той же строке (меньший `id`), и вторая уходит в очередь за
   * первой. Отпустив держателя, мы получаем не гонку, а очередь.
   */
  it('перенос A→B против B→A не встаёт в взаимную блокировку', async () => {
    const x = await freightInProgress({ vehicleId: ctx.vehicleId });
    const y = await freightInProgress({ vehicleId: ctx.otherVehicleId });
    const before = await deadlocks();

    const holder = await openHolder();
    try {
      // Строки берутся по возрастанию `id` — тем же порядком, что и в коде: держатель, взявший их
      // иначе, спорил бы за них с дверями сам.
      await holder.hold(
        'SELECT id FROM vehicle_routes WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [[x.routeId, y.routeId]],
      );

      const move = async (requestId: string, vehicleId: string, routeId: string) =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/vehicle-requests/${requestId}/assignment`,
          headers: ctx.auth,
          payload: { vehicleId, route: { routeId }, version: await requestVersion(requestId) },
        });

      const first = move(x.id, ctx.otherVehicleId, y.routeId);
      await waitBlockedBy(holder.pid, 1);
      const second = move(y.id, ctx.vehicleId, x.routeId);
      await waitBlockedBy(holder.pid, 2);
      await holder.release();

      const [xRes, yRes] = await Promise.all([first, second]);
      expectHonest('X: A→B', xRes);
      expectHonest('Y: B→A', yRes);
    } finally {
      await holder.release();
    }

    expect(await deadlocksSettled()).toBe(before);
  }, 60_000);

  /**
   * Вторая пара — та, с которой Р17 и начался: выписка листа берёт рейс, потом заявки состава
   * ([`vehicle-routes.ts`](../src/routes/vehicle-routes.ts)), а возврат заявки в «Новую» шёл
   * прежде наоборот — сначала заявку, потом её рейсы. Встречная блокировка была не гипотезой, а
   * фактом уже выкаченного кода.
   *
   * Держатель занимает и рейс, и заявку: под каноном обе двери встают за рейсом и отвечают по
   * очереди, а взявшая заявку первой оказалась бы в клинче с выпиской, которая рейс уже держит.
   */
  it('выписка листа против отката статуса не встаёт в взаимную блокировку', async () => {
    const x = await freightInProgress({ vehicleId: ctx.vehicleId });
    const before = await deadlocks();

    const holder = await openHolder();
    try {
      await holder.hold('SELECT id FROM vehicle_routes WHERE id = $1 FOR UPDATE', [x.routeId]);
      await holder.hold('SELECT id FROM vehicle_requests WHERE id = $1 FOR UPDATE', [x.id]);

      const issue = ctx.app.inject({
        method: 'POST',
        url: `/api/v1/vehicle-routes/${x.routeId}/waybill`,
        headers: ctx.auth,
        payload: { version: await routeVersion(x.routeId) },
      });
      await waitBlockedBy(holder.pid, 1);
      const rollback = ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${x.id}/status`,
        headers: ctx.auth,
        payload: {
          status: 'new',
          comment: 'Заявку взяли в работу по ошибке',
          version: await requestVersion(x.id),
        },
      });
      await waitBlockedBy(holder.pid, 2);
      await holder.release();

      const [issued, rolled] = await Promise.all([issue, rollback]);
      // Выписка отвечает либо листом, либо 409 рукопожатия (Р21) — у тестового водителя нет
      // документов, и предупреждение о них законно; ни то, ни другое не 500.
      expectHonest('выписка листа', issued);
      expectHonest('откат в «Новую»', rolled);
    } finally {
      await holder.release();
    }

    expect(await deadlocksSettled()).toBe(before);
  }, 60_000);

  /**
   * Третья пара — обе двери правят **одну** заявку, и обеим нужны её рейсы: виза досрочного
   * завершения снимает дни за новым сроком (ADR 0044), а обычная правка поднимает версию всем
   * незамороженным (Р18). Порядок здесь легче всего перепутать: у обеих предмет — заявка, и взять
   * её строку первой кажется естественным.
   */
  it('виза досрочного завершения против правки заявки не встаёт в взаимную блокировку', async () => {
    const requestId = await linearInProgress(shiftDateKey(ctx.today, 5));
    const routeId = await planDay(requestId, shiftDateKey(ctx.today, 4), ctx.vehicleId);
    const asked = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${requestId}/early-end`,
      headers: ctx.auth,
      payload: {
        newDateTo: shiftDateKey(ctx.today, 1),
        reason: 'Техника освободилась раньше',
        version: await requestVersion(requestId),
      },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const before = await deadlocks();

    const holder = await openHolder();
    try {
      await holder.hold('SELECT id FROM vehicle_routes WHERE id = $1 FOR UPDATE', [routeId]);
      await holder.hold('SELECT id FROM vehicle_requests WHERE id = $1 FOR UPDATE', [requestId]);

      // Виза сокращения — тот путь, что правит срок и снимает дни: сам запрос ничего не двигает.
      const decide = ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${requestId}/early-end`,
        headers: ctx.auth,
        payload: { approved: true, comment: '', version: await requestVersion(requestId) },
      });
      await waitBlockedBy(holder.pid, 1);
      const edit = ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicle-requests/${requestId}`,
        headers: ctx.auth,
        payload: {
          requestType: 'special_equipment',
          comment: 'Правка под встречное сокращение срока',
          version: await requestVersion(requestId),
        },
      });
      await waitBlockedBy(holder.pid, 2);
      await holder.release();

      const [decided, edited] = await Promise.all([decide, edit]);
      // Одна из двух увидит чужую правку и ответит конфликтом версий — это и есть честный ответ:
      // «данные изменились, откройте заново», а не 500 из разорванной транзакции.
      expectHonest('виза сокращения', decided);
      expectHonest('правка заявки', edited);
      expect([decided.statusCode, edited.statusCode]).toContain(200);
    } finally {
      await holder.release();
    }

    expect(await deadlocksSettled()).toBe(before);
  }, 60_000);

  /**
   * Четвёртый случай — не про порядок, а про вторую половину Р17: где рейс выясняется **из связи**,
   * связь читается до блокировки и обязана быть перечитана под ней.
   *
   * Здесь снятие дня узнаёт из связи рейс `A`, встаёт за ним в очередь, а сосед тем временем
   * переставляет день в рейс `B` и отпускает `A`. Дверь, поверившая первому чтению, сняла бы день
   * с рейса, где его уже нет, и ответила бы «снято» — соврав дважды: день остался бы стоять, а
   * человек об этом не узнал бы.
   *
   * Законных исходов два, и оба честны: либо день снят там, где он на самом деле лежит, либо
   * отказ «маршруты менялись, повторите» и день на месте. Незаконен ровно один — «снято» при
   * стоящем дне, и именно его случай и ловит.
   */
  it('снятие дня не обманывает, когда день переехал в соседний рейс', async () => {
    const date = shiftDateKey(ctx.today, 2);
    const requestId = await linearInProgress(shiftDateKey(ctx.today, 5));
    const routeA = await planDay(requestId, date, ctx.vehicleId);
    const routeB = await createRoute(date, ctx.otherVehicleId);
    const before = await deadlocks();

    const holder = await openHolder();
    try {
      await holder.hold('SELECT id FROM vehicle_routes WHERE id = $1 FOR UPDATE', [routeA]);

      const drop = ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
        headers: ctx.auth,
      });
      await waitBlockedBy(holder.pid, 1);
      // Пока снятие ждёт рейс `A`, день переезжает в рейс `B` — ровно то, что делает соседний
      // диспетчер. Прямым запросом, а не дверью: дверь встала бы в ту же очередь за рейсом `A`.
      await holder.hold(
        'DELETE FROM vehicle_route_requests WHERE route_id = $1 AND request_id = $2',
        [routeA, requestId],
      );
      await holder.hold(
        `INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
         VALUES ($1, $2, 1, $3)`,
        [routeB, requestId, date],
      );
      await holder.release();

      const res = await drop;
      expectHonest('снятие дня', res);
      const left = await ctx.db.execute<{ route_id: string }>(sql`
        SELECT route_id FROM vehicle_route_requests
        WHERE request_id = ${requestId} AND work_date = ${date}`);
      if (res.statusCode === 200) {
        expect(left.rows, 'ответили «снято», а день остался стоять в рейсе').toHaveLength(0);
      } else {
        expect(left.rows[0]?.route_id, 'отказали, а день всё-таки сняли').toBe(routeB);
      }
    } finally {
      await holder.release();
    }

    expect(await deadlocksSettled()).toBe(before);
  }, 60_000);

  /**
   * Проверка самого инструмента, и без неё все случаи выше стоили бы немного: ноль в счётчике
   * означает «клинча не было» только если этот счётчик умеет расти.
   *
   * Здесь те же два рейса берутся двумя сессиями во встречном порядке — так выглядела бы любая
   * дверь, взявшая рейсы «свой сначала, чужой потом» вместо возрастания `id`. Postgres разрывает
   * пару сам: одной транзакции приходит `40P01`, счётчик базы растёт на единицу. Ровно это и
   * увидел бы прогон, если бы канон нарушили в коде, — с той разницей, что там `40P01` дошёл бы до
   * человека пятисоткой.
   */
  it('встречный порядок на тех же рейсах даёт взаимную блокировку — инструмент её видит', async () => {
    const x = await freightInProgress({ vehicleId: ctx.vehicleId });
    const y = await freightInProgress({ vehicleId: ctx.otherVehicleId });
    const [low, high] = [x.routeId, y.routeId].sort();
    const before = await deadlocks();

    const lock = (client: pg.Client, id: string) =>
      client.query('SELECT id FROM vehicle_routes WHERE id = $1 FOR UPDATE', [id]);
    const a = new pg.Client({ connectionString: DB_URL });
    const b = new pg.Client({ connectionString: DB_URL });
    await Promise.all([a.connect(), b.connect()]);
    const outcome: string[] = [];
    try {
      await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
      // Каждая сессия берёт «свой» рейс первым — тот самый встречный порядок.
      await Promise.all([lock(a, low!), lock(b, high!)]);
      const race = [
        lock(a, high!).then(
          () => outcome.push('a: взяла'),
          (e: { code?: string }) => outcome.push(`a: ${e.code}`),
        ),
        lock(b, low!).then(
          () => outcome.push('b: взяла'),
          (e: { code?: string }) => outcome.push(`b: ${e.code}`),
        ),
      ];
      await Promise.all(race);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
    }

    // `40P01` — «deadlock detected»: одну из двух Postgres убил, вторая договорилась.
    expect(outcome.filter((o) => o.endsWith('40P01'))).toHaveLength(1);
    expect(await deadlocksSettled()).toBe(before + 1);
  }, 60_000);
});
