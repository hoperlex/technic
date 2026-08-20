import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRequestEsm2 } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Отбор среза «На объекте» по бланку работы дня (Р21) — на живой схеме и настоящими путями.
 *
 * Бланк строки считает не портал и не постраничная выборка, а условие `EXISTS` в `onSiteWhere`:
 * фильтр обязан работать до страницы, иначе он соврал бы и в счётчике, и в листании. Проверять
 * это нечем, кроме живой базы — правила здесь нет вовсе, есть три ветки SQL по видам работы дня.
 *
 * Что проверяется, по строкам таблицы Р21:
 *
 * - нелинейный заказ своей машиной — `esm2` и только он: заказ ведётся недельными листами, даже
 *   если лист на эту неделю ещё не выписан;
 * - линейный день — бланк машины **рейса**, а не назначения: у назначенной машины бланк 4-П, у
 *   машины дня — форма № 3, и находится строка именно формой № 3;
 * - линейный день с листом по требованию — два бланка сразу, и строка стоит в выдаче один раз;
 * - линейный заказ без распланированного дня, арендная машина и долговая строка (срок кончился,
 *   смены не подписаны) — набор пуст, и под любым фильтром такие строки выпадают;
 * - сводка над таблицей сужается тем же условием, что и сама таблица.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-on-site-forms-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: бланк работы дня «На объекте»';
/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды заведённых записей — с «яя»: половина db-тестов берёт объект и тип из справочника
 * выражением `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую
 * площадку. У типа тем же приёмом начинается наименование: код у него только латиницей.
 */
const OBJECT_CODE = `яя-onsite-forms-${RUN}`;
const TYPE_PREFIX = `on_site_forms_${RUN}`;
const TYPE_NAME_PREFIX = 'Автовышки тестовые (бланки';

/** Контакт заказа: номер выдуман и своими цифрами ни на кого не похож — база общая. */
const SITE = { name: 'Бланков Игорь Петрович', phone: '9007790762' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  /** Машина обычного заказа: он ведётся недельными листами весь срок. */
  plainVehicleId: string;
  /** Машина назначения линейного заказа — бланк её типа 4-П. */
  assignedVehicleId: string;
  /** Машина дня с бланком 4-П: ею проверяется пара «рейс + лист по требованию». */
  dayVehicleId: string;
  /** Машина дня с формой № 3: ею видно, что бланк считается по машине рейса, а не назначения. */
  dayVehicleLeg3Id: string;
  /** Арендная машина: лист на неё выписывает арендодатель, и бланка у работы нет. */
  rentalVehicleId: string;
  driverId: string;
  linearTypeId: string;
  plainTypeId: string;
  today: string;
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
 * Водитель рейса и машинист листа: человек со специализацией «водитель». Удостоверения не заводим
 * — рейс планируется и без него (ADR 0064), а рукопожатие выписки помощник снимает с дороги сам.
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
      lastName: 'Бланков',
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

/** Своя площадка: чужую запись справочника тест не трогает, а свою убирает за собой. */
async function createObject(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${`Площадка бланков дня ${RUN}`}, 'г Москва, ул Бланковая, д 3')
    RETURNING id`);
  return rows.rows[0]!.id;
}

/** Тип ТС для заказов теста: линейным бывает тип любого вида (ADR 0100 §1). */
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

/** Заказ техники на объект, доведённый до работы: срок — сегодня плюс три дня. */
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

/** Линейный заказ в работе на машине назначения — начало каждого линейного случая. */
const linearInProgress = () => requestInProgress(ctx.linearTypeId, ctx.assignedVehicleId);

/** Поставить сегодняшний день заказа в рейс названной машины — тем же действием, что и диспетчер. */
async function planToday(requestId: string, vehicleId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${ctx.today}/route`,
    headers: ctx.auth,
    payload: { newRoute: { vehicleId, driverPersonId: ctx.driverId } },
  });
  expect(res.statusCode, res.body).toBe(200);
  const day = res.json().items.find((d: { date: string }) => d.date === ctx.today);
  expect(day?.route, res.body).toBeTruthy();
  createdRoutes.push(day.route.id as string);
  return day.route.id as string;
}

/** Версия заявки на этот момент: планирование дня и выписка бланка сверяются с ней. */
async function versionOf(requestId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/** Лист ЭСМ-2 по требованию на неделю сегодняшнего дня (ADR 0100 §5): его называет человек. */
async function issueEsm2OnDemand(requestId: string, vehicleId: string): Promise<void> {
  const { res } = await issueRequestEsm2({
    app: ctx.app,
    headers: ctx.auth,
    requestId,
    payload: {
      weekOf: ctx.today,
      vehicleId,
      driverPersonId: ctx.driverId,
      version: await versionOf(requestId),
    },
    expectIssued: false,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * Строки среза по номеру заявки: база у db-тестов общая, и «нашлось N» отвечало бы про соседние
 * файлы, а не про этот случай. Ключ `forms` уходит как есть — строкой через запятую.
 */
async function onSiteNums(request: Request, forms?: string): Promise<number[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/on-site?num=${request.num}${forms ? `&forms=${forms}` : ''}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { items: { num: number }[]; total: number };
  // Счётчик считается своим запросом с теми же условиями — разъедься они, пагинация обещала бы
  // страницы, которых нет.
  expect(body.total, res.body).toBe(body.items.length);
  return body.items.map((r) => r.num);
}

/** Сводка над таблицей тем же отбором: она обязана отвечать про то, что человек видит перед собой. */
async function onSiteSummaryTotal(request: Request, forms?: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/on-site/summary?num=${request.num}${forms ? `&forms=${forms}` : ''}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().total as number;
}

describe.skipIf(!DB_URL)('отбор среза «На объекте» по бланку работы дня (живая схема)', () => {
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
     * Машины, у которых на сегодня нет ничего: ни рейса, ни заказа, ни недельного листа. Тест
     * читает набор бланков дня целиком, и «первая попавшаяся своя машина» принесла бы работу,
     * заведённую соседним файлом.
     *
     * Порядок выборки — по идентификатору: соседние db-тесты берут ту же выборку с начала и с
     * конца списка госномеров, и третий порядок дешевле, чем сговариваться о четвёртом.
     */
    const freeToday = sql`
      NOT EXISTS (
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
      )`;

    const own = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
        AND ${freeToday}
      ORDER BY v.id
      LIMIT 3`);
    // Машина дня с формой № 3: ею и видно, что бланк строки считается по машине рейса — у
    // назначенной машины бланк 4-П, и один и тот же заказ находится разными значениями фильтра.
    const leg3 = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = 'leg3'
        AND ${freeToday}
      ORDER BY v.id
      LIMIT 1`);
    const rental = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM vehicles v
      WHERE v.ownership = 'rental' AND v.status = 'active' AND v.deleted_at IS NULL
        AND ${freeToday}
      ORDER BY v.id
      LIMIT 1`);

    const [plain, assigned, day] = own.rows;
    if (!plain || !assigned || !day || !leg3.rows[0] || !rental.rows[0]) {
      throw new Error(
        'в базе не хватает свободных на сегодня машин: трёх своих грузовых 4-П, одной с формой № 3 и одной арендной',
      );
    }

    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: await createObject(),
      plainVehicleId: plain.id,
      assignedVehicleId: assigned.id,
      dayVehicleId: day.id,
      dayVehicleLeg3Id: leg3.rows[0].id,
      rentalVehicleId: rental.rows[0].id,
      driverId: await seedDriver(),
      linearTypeId: await createType(app, auth, assigned.kind_id, true),
      plainTypeId: await createType(app, auth, assigned.kind_id, false),
      today,
      dateTo: shiftDateKey(today, 3),
    };
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с рейсами и бланками
     * иначе видны соседним файлам — гаражу, срезам, отборам списка и сводкам рассылок. Порядок
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
          AND id NOT IN (SELECT driver_person_id FROM waybills WHERE driver_person_id IS NOT NULL)`);
      /*
       * Журнал уборка сносит по автору: писали в него только здешние учётки, а видов записей у них
       * несколько — отбор по одному виду сущности оставлял бы остальные.
       */
      await ctx.db.execute(sql`
        DELETE FROM audit_log
         WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('нелинейный заказ своей машиной ищется как ЭСМ-2 и только им', async () => {
    const request = await requestInProgress(ctx.plainTypeId, ctx.plainVehicleId);

    // Без фильтра строка в срезе есть — заказ идёт, машина стоит на площадке (ADR 0036).
    expect(await onSiteNums(request)).toEqual([request.num]);
    // Заказ ведётся недельными листами (`esm2Mode = 'auto'`), и бланк у его дня один — ЭСМ-2.
    // Лист на эту неделю может быть ещё не выписан: спрашивают не про выданную бумагу, а про ту,
    // которой работу закроют.
    expect(await onSiteNums(request, 'esm2')).toEqual([request.num]);
    expect(await onSiteNums(request, '4p')).toEqual([]);
    expect(await onSiteNums(request, 'leg3')).toEqual([]);
  });

  it('линейный день ищется бланком машины рейса, а не машины назначения', async () => {
    const request = await linearInProgress();
    await planToday(request.id, ctx.dayVehicleLeg3Id);

    // Машина рейса — легковая, и бланк дня её: форма № 3. У назначенной машины бланк 4-П, и
    // считай отбор по ней — фильтр и колонка отвечали бы про разные машины (Р16).
    expect(await onSiteNums(request, 'leg3')).toEqual([request.num]);
    expect(await onSiteNums(request, '4p')).toEqual([]);
    // Недельным листом линейный день не закрывается сам собой: его выписывают по требованию, и
    // пока не выписали — бланка ЭСМ-2 у дня нет (ADR 0100 §5).
    expect(await onSiteNums(request, 'esm2')).toEqual([]);
  });

  it('линейный день с листом по требованию находится обоими бланками и стоит один раз', async () => {
    const request = await linearInProgress();
    await planToday(request.id, ctx.dayVehicleId);
    await issueEsm2OnDemand(request.id, ctx.dayVehicleId);

    // Две работы одного дня — рейс и недельный лист, — и строка находится каждой из них.
    expect(await onSiteNums(request, '4p')).toEqual([request.num]);
    expect(await onSiteNums(request, 'esm2')).toEqual([request.num]);
    // А обоими сразу — по-прежнему одной строкой: отбор идёт условием `EXISTS`, а не join'ом к
    // работам дня, иначе заказ стоял бы в выдаче дважды (Р6).
    expect(await onSiteNums(request, '4p,esm2')).toEqual([request.num]);
  });

  it('линейный заказ без распланированного дня выпадает из любого бланка', async () => {
    const request = await linearInProgress();

    // Строка из среза не уходит — заказ идёт, площадка машину ждёт (ADR 0100 §12).
    expect(await onSiteNums(request)).toEqual([request.num]);
    // Но работы в этот день у неё нет: ни рейса, ни листа, — и бланка нет тоже. Показывать такую
    // строку в ответе «покажи всех на 4-П» значило бы отвечать не на вопрос (Р7).
    for (const forms of ['4p', 'leg3', 'esm2', '4p,leg3,esm2']) {
      expect(await onSiteNums(request, forms), forms).toEqual([]);
    }
  });

  it('арендная машина бланка не имеет: лист на неё выписывает арендодатель', async () => {
    const request = await requestInProgress(ctx.plainTypeId, ctx.rentalVehicleId);

    expect(await onSiteNums(request)).toEqual([request.num]);
    for (const forms of ['4p', 'leg3', 'esm2', '4p,leg3,esm2']) {
      expect(await onSiteNums(request, forms), forms).toEqual([]);
    }
  });

  it('долговая строка работы в день среза не имеет и под фильтром выпадает', async () => {
    const request = await requestInProgress(ctx.plainTypeId, ctx.plainVehicleId);
    /*
     * Срок уводится в прошлое прямо в базе: задним числом заявку не заводят (`isAllowedRequestDate`),
     * а нужна она именно такой — отработавшей свой срок без подписи площадки под днями. Держит
     * такую строку в срезе `hasUnapprovedPastShiftsSql`: работа не принята, закрыть заявку нельзя,
     * и исчезать с экрана, куда смотрят каждое утро, она не должна.
     */
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details
      SET date_from = ${shiftDateKey(ctx.today, -5)}::date, date_to = ${shiftDateKey(ctx.today, -3)}::date
      WHERE request_id = ${request.id}`);

    expect(await onSiteNums(request)).toEqual([request.num]);
    // Недели давно кончились, и притворяться, будто сегодня по этой заявке выписывается ЭСМ-2,
    // нельзя (Р21). Долг при этом виден без фильтра и в сводке «Ждут согласования смен».
    for (const forms of ['4p', 'leg3', 'esm2', '4p,leg3,esm2']) {
      expect(await onSiteNums(request, forms), forms).toEqual([]);
    }
  });

  it('сводка среза сужается тем же фильтром, что и таблица', async () => {
    const request = await requestInProgress(ctx.plainTypeId, ctx.plainVehicleId);

    // Площадка и бланк — фильтры, **определяющие** список, а не одна из его цифр: в сводку они
    // уходят как есть, и цифра над таблицей обязана сходиться с числом строк под ней (Р7).
    expect(await onSiteSummaryTotal(request)).toBe(1);
    expect(await onSiteSummaryTotal(request, 'esm2')).toBe(1);
    expect(await onSiteSummaryTotal(request, '4p')).toBe(0);

    const linear = await linearInProgress();
    await planToday(linear.id, ctx.dayVehicleId);
    expect(await onSiteSummaryTotal(linear, '4p')).toBe(1);
    expect(await onSiteSummaryTotal(linear, 'esm2')).toBe(0);
  });
});
