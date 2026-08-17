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
 * Срезы и отборы по линейному заказу (ADR 0100 §12) — на живой схеме и настоящими путями.
 *
 * Проверяются три места, где заказ линейной техники перестал означать «машина стоит на площадке
 * весь срок»:
 *
 * - **гараж**: назначенная машина линейного заказа свободна, пока её день не поставлен в рейс, а
 *   занятость дня приходит рейсом и подписана заказом, ради которого машина выехала;
 * - **срез «На объекте»**: строка остаётся (заказ идёт, площадка машину ждёт), но машина у неё
 *   дневная — из рейса этого дня, — а нераспланированный день так и говорит, что машины нет;
 * - **отбор по машине** (ADR 0098): заявка находится по машине, которой на ней не назначено, во
 *   всех пяти выдачах сразу — список, лента, архив, «История» и сводка над таблицей.
 *
 * Зачем база. Всё три ответа складывает SQL: занятость — выражение состояния гаража, машина дня —
 * добор по странице, отбор — общее выражение с `EXISTS` по дням. Ни одно из этого не выражается
 * правилами контрактов и не ловится ничем, кроме живой схемы: расходятся не правила, а код и база.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_slices \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-linear-slices-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: срезы линейного заказа';
/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды заведённых записей — с «яя», и это не шутка, а требование соседства: половина db-тестов
 * берёт объект и тип из справочника выражением `ORDER BY … LIMIT 1`, и запись, ставшая первой,
 * молча увела бы их заявки на тестовую площадку. У типа тем же приёмом начинается наименование:
 * код у него только латиницей.
 */
const OBJECT_CODE = `яя-lin-slices-${RUN}`;
const TYPE_PREFIX = `linear_slices_${RUN}`;
const TYPE_NAME_PREFIX = 'Автовышки тестовые (срезы';

/** Контакт заказа: номер выдуман и своими цифрами ни на кого не похож — база общая. */
const SITE = { name: 'Срезов Аркадий Никитич', phone: '9007790761' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  /** Машина назначения линейных заказов: та самая, что «занята весь срок» больше не бывает. */
  assignedVehicle: Vehicle;
  /** Машина дня: она поедет по линейному заказу, не будучи на него назначенной (ADR 0100 §4). */
  dayVehicle: Vehicle;
  /** Машина обычного заказа — контрольная: у неё всё осталось как было (ADR 0036). */
  plainVehicle: Vehicle;
  driverId: string;
  /** Тип линейный и тип обычный — оба грузового вида: на объект вызывают технику любого вида. */
  linearTypeId: string;
  plainTypeId: string;
  today: string;
  /** Срок заказов: сегодня плюс три дня — сегодняшний день срез и спрашивает. */
  dateTo: string;
}

interface Vehicle {
  id: string;
  registrationNumber: string;
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
 * ставит одно условие, «человек есть и он водитель» (ADR 0064), а листы этот файл не выписывает.
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
      lastName: 'Срезчиков',
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
async function createObject(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка срезов линейного заказа ${RUN}`}, 'г Москва, ул Срезовая, д 7')
    RETURNING id`);
  return rows.rows[0]!.id;
}

/**
 * Тип ТС для заказов теста. Линейным бывает тип любого вида (ADR 0100 §1) — здесь оба грузового:
 * тем же видом заведены машины, которыми заказы берут в работу.
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

interface Request {
  id: string;
  num: number;
  version: number;
}

/**
 * Заказ техники на объект, доведённый до работы. Срок — сегодня плюс три дня: срез спрашивает про
 * сегодня, и заявка обязана в него попадать.
 */
async function requestInProgress(typeId: string, vehicleId: string): Promise<Request> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: ctx.today,
      dateTo: ctx.dateTo,
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: 'Обрезка деревьев вдоль проезда',
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
        vehicleId,
        pricePerHour: 1000,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.today,
        dateTo: ctx.dateTo,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return {
    id: request.id as string,
    num: request.num as number,
    version: confirmed.json().version as number,
  };
}

/** Линейный заказ в работе на машине назначения — начало почти каждого случая. */
const linearInProgress = () => requestInProgress(ctx.linearTypeId, ctx.assignedVehicle.id);

/**
 * Поставить день заказа в рейс машины дня. Рейс заводится тут же — тем же действием, каким его
 * заводит диспетчер из карточки заявки (ADR 0100 §8).
 */
async function planDay(requestId: string, date: string, vehicleId?: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload: {
      newRoute: { vehicleId: vehicleId ?? ctx.dayVehicle.id, driverPersonId: ctx.driverId },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  // Рейс, заведённый ручкой планирования, тоже надо убрать за собой.
  const day = res.json().items.find((d: { date: string }) => d.date === date);
  expect(day?.route, res.body).toBeTruthy();
  createdRoutes.push(day.route.id as string);
  return day.route.id as string;
}

/**
 * Выписать лист по рейсу: им рейс замораживается — день из выданного бланка уже не исчезает.
 *
 * Через помощника, потому что здесь бумага — декорация: предмет проверки ниже, а рукопожатие
 * выписки (Р21) у тестового водителя срабатывает всегда — документов ему не заводят.
 */
async function issueWaybill(routeId: string): Promise<void> {
  const route = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.auth,
  });
  expect(route.statusCode, route.body).toBe(200);
  await issueRouteWaybill({
    app: ctx.app,
    headers: ctx.auth,
    routeId,
    payload: { version: route.json().version as number },
  });
}

/** Линейный заказ в работе, чей сегодняшний день уже стоит в рейсе машины дня. */
async function linearWithDayToday(): Promise<Request & { routeId: string }> {
  const request = await linearInProgress();
  return { ...request, routeId: await planDay(request.id, ctx.today) };
}

interface GarageRow {
  id: string;
  state: string;
  busy: {
    kind: string;
    displayNumber: string;
    requests?: { displayNumber: string; workDate: string | null }[];
  }[];
}

/** Строка гаража на сегодня по конкретной машине: госномером её и ищут в самом портале. */
async function garageRow(vehicle: Vehicle): Promise<GarageRow> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/vehicles?on=${ctx.today}&pageSize=500&search=${encodeURIComponent(vehicle.registrationNumber)}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const row = (res.json().items as GarageRow[]).find((v) => v.id === vehicle.id);
  expect(row, res.body).toBeTruthy();
  return row!;
}

interface OnSiteRow {
  num: number;
  isLinear: boolean;
  assignment: { vehicleId: string } | null;
  dayVehicle?: {
    routeId: string;
    routeDisplayNumber: string;
    vehicleId: string;
    vehicleLabel: string;
    driverPersonId: string | null;
    driverName: string;
  } | null;
}

/** Строка среза «На объекте» по номеру заявки: номером срез и сужают до одной строки. */
async function onSiteRow(request: Request): Promise<OnSiteRow> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/on-site?num=${request.num}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const items = res.json().items as OnSiteRow[];
  expect(items, res.body).toHaveLength(1);
  return items[0]!;
}

interface FoundRow {
  num: number;
  matchedDays?: string[];
}

/**
 * Отбор по машине в одной из выдач, суженный до одной заявки её номером: база у db-тестов общая, и
 * «нашлось N» отвечало бы про соседние файлы, а не про этот случай.
 */
async function findByVehicle(
  path: string,
  vehicleId: string,
  request: Request,
  extra = '',
): Promise<FoundRow[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests${path}?vehicleId=${vehicleId}&num=${request.num}${extra}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const items = res.json().items as ({ kind?: string; order?: FoundRow } & FoundRow)[];
  // Лента отдаёт размеченное объединение («заказ» либо «неделя»), список и журнал — сами заявки.
  return items.map((item) => item.order ?? item);
}

/** Сводка над таблицей по машине: цифры статусов, которыми виджет и подписан. */
async function summaryByVehicle(vehicleId: string): Promise<Record<string, number>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/summary?vehicleId=${vehicleId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Record<string, number>;
}

describe.skipIf(!DB_URL)('срезы и отборы линейного заказа (живая схема)', () => {
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

    const today = moscowDateKeyOf(new Date());

    /*
     * Три машины, у которых на сегодня нет ничего: ни рейса, ни заказа, ни недельного листа. Тест
     * читает состояние дня целиком, и «первая попавшаяся своя машина» показала бы занятость,
     * заведённую соседним файлом. Порядок обратный (`DESC`) по той же причине: три соседних
     * db-теста берут ту же выборку с начала, и брать её с конца дешевле, чем сговариваться.
     */
    const vehicles = await db.execute<{
      id: string;
      registration_number: string;
      kind_id: string;
    }>(sql`
      SELECT v.id, v.registration_number, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND v.registration_number IS NOT NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_routes r
          WHERE r.vehicle_id = v.id AND r.route_date = ${today}::date
        )
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_request_assignments a
          JOIN vehicle_requests vr ON vr.id = a.request_id
          JOIN special_equipment_request_details d ON d.request_id = vr.id
          WHERE a.vehicle_id = v.id AND vr.status = 'confirmed' AND vr.deleted_at IS NULL
            AND d.date_from <= ${today}::date
            AND coalesce(d.date_to, d.date_from) >= ${today}::date
        )
        AND NOT EXISTS (
          SELECT 1 FROM waybills w
          WHERE w.vehicle_id = v.id AND w.form_code = 'esm2' AND w.status <> 'cancelled'
            AND w.period_from <= ${today}::date AND w.period_to >= ${today}::date
        )
      ORDER BY v.registration_number DESC
      LIMIT 3`);
    const [assigned, day, plain] = vehicles.rows;
    if (!assigned || !day || !plain) {
      throw new Error('свободных на сегодня своих грузовых машин с бланком 4-П меньше трёх');
    }
    const vehicleOf = (row: { id: string; registration_number: string }): Vehicle => ({
      id: row.id,
      registrationNumber: row.registration_number,
    });

    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: await createObject(),
      assignedVehicle: vehicleOf(assigned),
      dayVehicle: vehicleOf(day),
      plainVehicle: vehicleOf(plain),
      driverId: await seedDriver(),
      linearTypeId: await createType(app, auth, assigned.kind_id, true),
      plainTypeId: await createType(app, auth, assigned.kind_id, false),
      today,
      dateTo: shiftDateKey(today, 3),
    };
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с рейсами иначе видны
     * соседним файлам — гаражу, срезам, отборам списка и сводкам рассылок. Порядок обратный
     * ссылкам: сначала листы (они держат и рейс, и заявку ключами `restrict`), потом рейсы (состав
     * уходит каскадом), потом заявки, площадка, типы и люди. Учётка теста остаётся намеренно — на
     * неё ссылается журнал аудита, а `seedAdmin` переиспользует её при следующем прогоне.
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

  it('линейный заказ не занимает назначенную машину, а обычный занимает', async () => {
    const linear = await linearInProgress();
    const plain = await requestInProgress(ctx.plainTypeId, ctx.plainVehicle.id);

    // Машина назначения линейного заказа свободна: срок идёт, а сегодня она никуда не выехала.
    const assigned = await garageRow(ctx.assignedVehicle);
    expect(assigned.state).toBe('free');
    expect(assigned.busy).toHaveLength(0);

    // Обычный заказ ведёт себя ровно как прежде (ADR 0036): машина стоит на площадке весь срок.
    const plainRow = await garageRow(ctx.plainVehicle);
    expect(plainRow.state).toBe('on_site');
    const special = plainRow.busy.find((b) => b.kind === 'special');
    expect(special?.displayNumber).toBe(`ТС-${plain.num}`);
    // И линейный заказ не подмешался к нему второй строкой стоянки.
    expect(plainRow.busy.filter((b) => b.kind === 'special')).toHaveLength(1);
    expect(`ТС-${linear.num}`).not.toBe(special?.displayNumber);
  });

  it('занятость линейного дня приходит рейсом и названа своим заказом', async () => {
    const request = await linearWithDayToday();

    // Машина дня — «в рейсе»: она уехала утром и вечером вернётся на базу (ADR 0100 §12).
    const row = await garageRow(ctx.dayVehicle);
    expect(row.state).toBe('on_route');
    const route = row.busy.find((b) => b.kind === 'route');
    expect(route, JSON.stringify(row.busy)).toBeTruthy();
    // В составе рейса стоит сам заказ со своим днём: по нему и видно, что машина работает на
    // объекте по ТС-N, а не «просто едет».
    const inRoute = route!.requests!.find((r) => r.displayNumber === `ТС-${request.num}`);
    expect(inRoute, JSON.stringify(route)).toBeTruthy();
    expect(inRoute!.workDate).toBe(ctx.today);

    // Машина назначения при этом так и осталась свободной: работал не она.
    expect((await garageRow(ctx.assignedVehicle)).state).toBe('free');
  });

  it('срез «На объекте» показывает машину дня, а не машину назначения', async () => {
    const request = await linearWithDayToday();

    const row = await onSiteRow(request);
    expect(row.isLinear).toBe(true);
    // Назначение осталось прежним — оно отвечает «чем и почём взяли заявку» (ADR 0100 §4).
    expect(row.assignment?.vehicleId).toBe(ctx.assignedVehicle.id);
    // А машина строки — дневная, из рейса этого дня.
    expect(row.dayVehicle?.vehicleId).toBe(ctx.dayVehicle.id);
    expect(row.dayVehicle?.routeDisplayNumber).toMatch(/^Р-\d+$/);
    expect(row.dayVehicle?.vehicleLabel).toContain(ctx.dayVehicle.registrationNumber);
    expect(row.dayVehicle?.driverPersonId).toBe(ctx.driverId);
  });

  it('нераспланированный день среза машину не выдумывает, а обычный заказ вопроса не получает', async () => {
    const linear = await linearInProgress();
    const plain = await requestInProgress(ctx.plainTypeId, ctx.plainVehicle.id);

    // Заказ идёт, площадка машину ждёт — строка остаётся, но машины дня у неё нет.
    const linearRow = await onSiteRow(linear);
    expect(linearRow.assignment?.vehicleId).toBe(ctx.assignedVehicle.id);
    expect(linearRow.dayVehicle).toBeNull();

    // У обычного заказа поля нет вовсе: там машина строки — назначенная, и второго ответа на этот
    // вопрос не существует.
    const plainRow = await onSiteRow(plain);
    expect(plainRow.isLinear).toBe(false);
    expect(plainRow.dayVehicle).toBeUndefined();
  });

  it('заявка находится по машине дня в списке и в ленте — и называет совпавшие дни', async () => {
    const request = await linearWithDayToday();

    for (const path of ['', '/feed']) {
      const found = await findByVehicle(path, ctx.dayVehicle.id, request);
      expect(
        found.map((r) => r.num),
        `выдача ${path || '/'}`,
      ).toEqual([request.num]);
      // Совпало не назначение, а день: без этого строка выглядела бы ошибкой отбора — в колонке
      // техники стоит другой госномер (ADR 0100 §12).
      expect(found[0]!.matchedDays).toEqual([ctx.today]);
    }

    // По машине назначения заявка находится по-прежнему, и днями она не совпадала.
    const byAssigned = await findByVehicle('', ctx.assignedVehicle.id, request);
    expect(byAssigned.map((r) => r.num)).toEqual([request.num]);
    expect(byAssigned[0]!.matchedDays).toEqual([]);

    // Обычный заказ на машину дня не назначен и дней не имеет — по ней и не находится.
    const plain = await requestInProgress(ctx.plainTypeId, ctx.plainVehicle.id);
    expect(await findByVehicle('', ctx.dayVehicle.id, plain)).toEqual([]);
  });

  it('заявка находится по машине дня и в архиве', async () => {
    const request = await linearWithDayToday();
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/vehicle-requests/${request.id}`,
      headers: ctx.auth,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    // Обычный список архивную заявку не показывает, вкладка «Архив» — только её (ADR 0070).
    expect(await findByVehicle('', ctx.dayVehicle.id, request)).toEqual([]);
    const found = await findByVehicle('', ctx.dayVehicle.id, request, '&archive=only');
    expect(found.map((r) => r.num)).toEqual([request.num]);
    expect(found[0]!.matchedDays).toEqual([ctx.today]);
  });

  it('заявка находится по машине дня и в «Истории»', async () => {
    const request = await linearWithDayToday();
    // Лист за отработанный день — им день и остаётся при заявке после закрытия: сверка
    // (`syncLinearRouteDays`) снимает с закрытой заявки весь неподкреплённый бумагой план, а
    // выданный бланк рейс не отдаёт (ADR 0100 §11). Это и есть случай журнала: машина отработала,
    // 4-П выписан, заказ закрыт — и «где ходила эта машина» обязано его находить.
    await issueWaybill(request.routeId);
    const done = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'done',
        comment: '',
        version: request.version,
        completion: { workedUnit: 'hours', workedAmount: 8 },
      },
    });
    expect(done.statusCode, done.body).toBe(200);

    // «Выполнена» состав рейса не трогает: рейс состоялся, и день остался при нём — журнал по
    // машине обязан этот заказ находить, иначе вопрос «где ходила ТС-341» теряет закрытые заявки.
    const found = await findByVehicle('/history', ctx.dayVehicle.id, request);
    expect(found.map((r) => r.num)).toEqual([request.num]);
    expect(found[0]!.matchedDays).toEqual([ctx.today]);
  });

  it('сводка над таблицей считает заявку по машине дня наравне со списком', async () => {
    const before = await summaryByVehicle(ctx.dayVehicle.id);
    const request = await linearWithDayToday();
    const after = await summaryByVehicle(ctx.dayVehicle.id);

    // Цифра над таблицей обязана сходиться с числом строк под ней: заявка нашлась днём, значит и
    // сводка выросла на неё одну.
    expect(after.confirmed).toBe((before.confirmed ?? 0) + 1);
    expect(request.num).toBeGreaterThan(0);
  });
});
