import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatVehicleRequestNumber, formatVehicleRouteNumber } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Сборка тела письма из блоков — чистая функция без конфига, поэтому импортируется обычным путём.
import { renderMail } from '../src/services/mail-templates';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type {
  buildDriverRoutesMail as BuildDriverRoutesMail,
  driversWithRoutes as DriversWithRoutes,
} from '../src/services/mailings/driver-routes';

/**
 * Письмо-задание водителю на живой схеме.
 *
 * Зачем база. Письмо не собирается из того, что ему передали: оно само ходит за рейсами водителя,
 * за составом каждого рейса и за контактами заявок в двух detail-таблицах — то есть состоит почти
 * целиком из запросов. Проверить на правилах тут нечего: разойтись могут не правила, а запрос и
 * схема, и цена расхождения — не пустой экран, а водитель, который поехал не туда. Отдельно
 * поэтому проверяется отбор строк состава: отменённая и удалённая заявка остаются в рейсе как его
 * история (лист уже выписан), но в задание попасть не должны — напечатать их значит послать
 * человека на работу, которой не будет.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test driver-routes-mail
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Даты рейсов — заведомо будущие и у каждого сценария свои. База общая: на «сегодня» рейсы заводят
 * соседние тесты, и письмо водителя собралось бы вместе с ними, а список получателей на дату
 * зависел бы от того, кто прогонялся раньше.
 */
const DATES = {
  single: '2099-03-02',
  contacts: '2099-03-03',
  cancelled: '2099-03-04',
  deleted: '2099-03-05',
  comment: '2099-03-06',
  twoRoutes: '2099-03-07',
  recipients: '2099-03-08',
  emptyRoute: '2099-03-09',
};

/** Марка и госномер своей машины: их водитель ищет в письме глазами, их же ищет проверка. */
const MODEL_NAME = `Тестовый самосвал ${randomUUID().slice(0, 8)}`;
const REG_NUMBER = `Т${randomUUID().slice(0, 6).toUpperCase()}ЕС799`;

/**
 * СНИЛС генерируется, а не берётся готовым: база общая, и номера сида в ней заняты живыми
 * карточками. Контрольное число считается правилами ПФР — иначе запись не пройдёт CHECK формата
 * и уникальность ключа человека (ADR 0037).
 */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  buildDriverRoutesMail: typeof BuildDriverRoutesMail;
  driversWithRoutes: typeof DriversWithRoutes;
  /** Автор рейсов и заявок: `created_by` обязателен, и список рейсов джойнит его innerJoin'ом. */
  userId: string;
  objectId: string;
  vehicleTypeId: string;
  modelId: string;
  vehicleId: string;
  /** Водитель, которому шлётся задание, и его ящик — тот самый, куда пойдёт письмо. */
  driverId: string;
  driverName: string;
  driverEmail: string;
  /** Водитель без единого рейса: им проверяется и пустое письмо, и отбор получателей. */
  idleDriverId: string;
}

let ctx: Ctx;

/** Что за собой убирать: заявки и рейсы копятся по ходу сценариев. */
const createdRequestIds: string[] = [];
const createdRouteIds: string[] = [];

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

interface RequestFixture {
  loading: string;
  unloading: string;
  /** «08:30» письма считается отсюда: время подачи хранится в UTC, а печатается по МСК. */
  scheduledAt: Date;
  status?: 'new' | 'confirmed' | 'cancelled';
  deleted?: boolean;
  comment?: string;
  loadingName?: string;
  loadingPhone?: string;
  unloadingName?: string;
  unloadingPhone?: string;
}

/** Заявка на грузоперевозку с ездкой: письмо берёт время у заявки, а адреса и контакты — у ездки. */
async function makeRequest(
  fixture: RequestFixture,
): Promise<{ id: string; displayNumber: string }> {
  const { schema } = ctx;
  const [request] = await ctx.db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      status: fixture.status ?? 'confirmed',
      comment: fixture.comment ?? '',
      createdBy: ctx.userId,
      ...(fixture.deleted ? { deletedAt: new Date(), deletedBy: ctx.userId } : {}),
    })
    .returning({ id: schema.vehicleRequests.id, num: schema.vehicleRequests.num });
  createdRequestIds.push(request!.id);

  await ctx.db.insert(schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: fixture.scheduledAt,
  });

  // Адреса, количество и контакты — у ездки, а не у заявки (план `docs/route-trips-plan.md`, Р2):
  // у заявки с ездками `A→B` и `A→C` «адрес разгрузки заявки» не существует. Одна ездка — то же,
  // чем была пара полей детали; комментарий остаётся у заявки, он её.
  await ctx.db.insert(schema.vehicleRequestTrips).values({
    requestId: request!.id,
    num: 1,
    fromLocation: fixture.loading,
    toLocation: fixture.unloading,
    volumeM3: '10.000',
    fromResponsibleName: fixture.loadingName ?? '',
    fromResponsiblePhone: fixture.loadingPhone ?? '',
    toResponsibleName: fixture.unloadingName ?? '',
    toResponsiblePhone: fixture.unloadingPhone ?? '',
  });

  return { id: request!.id, displayNumber: formatVehicleRequestNumber(request!.num) };
}

/** Грузовой рейс тестового водителя с заданным составом; позиции — порядок строк задания. */
async function makeRoute(opts: {
  date: string;
  requestIds: string[];
  comment?: string;
}): Promise<{ id: string; displayNumber: string }> {
  const { schema } = ctx;
  const [route] = await ctx.db
    .insert(schema.vehicleRoutes)
    .values({
      vehicleId: ctx.vehicleId,
      routeDate: opts.date,
      purpose: 'freight',
      driverPersonId: ctx.driverId,
      comment: opts.comment ?? '',
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRoutes.id, num: schema.vehicleRoutes.num });
  createdRouteIds.push(route!.id);

  if (opts.requestIds.length > 0) {
    await ctx.db.insert(schema.vehicleRouteRequests).values(
      opts.requestIds.map((requestId, index) => ({
        routeId: route!.id,
        requestId,
        position: index + 1,
      })),
    );
    /*
     * Раскладка точками — часть состояния рейса, а не отдельное действие. Письмо водителю
     * собирается из **точек** тем же слоем, что и кабинет (§8 плана), и строка состава без них
     * дала бы письмо без единого адреса: заявка в рейсе есть, а ехать некуда.
     */
    const { placeRequestTrips } = await import('../src/services/route-points');
    for (const requestId of opts.requestIds) {
      await placeRequestTrips(ctx.db, route!.id, requestId);
    }
  }
  return { id: route!.id, displayNumber: formatVehicleRouteNumber(route!.num) };
}

/** Тип ТС берётся из наполнения: своя машина обязана быть типа, который умеет возить груз. */
async function freightTypeId(db: typeof AppDb): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    SELECT vt.id FROM vehicle_types vt
    JOIN vehicle_kinds vk ON vk.id = vt.kind_id
    WHERE vk.code = 'freight_transport'
    ORDER BY vt.name
    LIMIT 1`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error('В базе нет типа ТС грузового вида: миграции наполнения не применены');
  return id;
}

/** Письмо тестовому водителю за один день — так его собирает и настоящая рассылка. */
function mailFor(date: string, personId = ctx.driverId) {
  return ctx.buildDriverRoutesMail({
    personId,
    driverName: ctx.driverName,
    dateFrom: date,
    dateTo: date,
  });
}

/** Текстовая версия письма: её читают в почтовых клиентах без HTML, и в ней видно всё тело. */
async function mailText(date: string): Promise<string> {
  const mail = await mailFor(date);
  expect(mail).not.toBeNull();
  return renderMail(mail!.content).text;
}

describe.skipIf(!DB_URL)('письмо-задание водителю (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildDriverRoutesMail, driversWithRoutes } =
      await import('../src/services/mailings/driver-routes');

    const suffix = randomUUID().slice(0, 8);
    const driverEmail = `driver-${suffix}@example.invalid`;

    // Свои справочные записи, а не чужие из наполнения: письмо проверяется по названиям и номерам,
    // а править чужие тест не вправе — на них опираются соседние сценарии.
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `db-routes-mail-${suffix}@example.invalid`,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: '',
        // Входа в этом тесте нет: письмо собирается сервисом, а не через HTTP.
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `MAIL-${suffix}`,
        name: `Тестовая площадка (задание) ${suffix}`,
        address: 'г Москва, ул Объектная, д 1',
      })
      .returning({ id: schema.constructionObjects.id });

    const typeId = await freightTypeId(db);
    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId: typeId, name: MODEL_NAME })
      .returning({ id: schema.vehicleModels.id });
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: typeId,
        vehicleModelId: model!.id,
        registrationNumber: REG_NUMBER,
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });

    const [driver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Заданкин${suffix}`,
        firstName: 'Иван',
        middleName: 'Петрович',
        snils: makeSnils(),
        email: driverEmail,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: письмо-задание водителю',
      })
      .returning({ id: schema.persons.id, fullName: schema.persons.fullName });
    const [idleDriver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Порожняков${suffix}`,
        firstName: 'Пётр',
        middleName: 'Сергеевич',
        snils: makeSnils(),
        email: `idle-${suffix}@example.invalid`,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: водитель без рейсов',
      })
      .returning({ id: schema.persons.id });

    ctx = {
      db,
      closeDb,
      schema,
      buildDriverRoutesMail,
      driversWithRoutes,
      userId: user!.id,
      objectId: object!.id,
      vehicleTypeId: typeId,
      modelId: model!.id,
      vehicleId: vehicle!.id,
      driverId: driver!.id,
      driverName: driver!.fullName,
      driverEmail,
      idleDriverId: idleDriver!.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { schema } = ctx;
    // Убирается только своё и в порядке ссылок: состав уходит каскадом за рейсом, но заявку
    // держит RESTRICT — пока рейс жив, удалить её нельзя.
    if (createdRouteIds.length > 0) {
      await ctx.db
        .delete(schema.vehicleRoutes)
        .where(inArray(schema.vehicleRoutes.id, createdRouteIds));
    }
    if (createdRequestIds.length > 0) {
      await ctx.db
        .delete(schema.vehicleRequests)
        .where(inArray(schema.vehicleRequests.id, createdRequestIds));
    }
    await ctx.db.delete(schema.vehicles).where(inArray(schema.vehicles.id, [ctx.vehicleId]));
    await ctx.db
      .delete(schema.vehicleModels)
      .where(inArray(schema.vehicleModels.id, [ctx.modelId]));
    await ctx.db
      .delete(schema.constructionObjects)
      .where(inArray(schema.constructionObjects.id, [ctx.objectId]));
    await ctx.db
      .delete(schema.persons)
      .where(inArray(schema.persons.id, [ctx.driverId, ctx.idleDriverId]));
    await ctx.db.delete(schema.users).where(inArray(schema.users.id, [ctx.userId]));
    await ctx.closeDb();
  });

  it('без рейсов письма нет вовсе: «сегодня заданий нет» говорит диспетчер, а не рассылка', async () => {
    const mail = await mailFor(DATES.single, ctx.idleDriverId);

    expect(mail).toBeNull();
  });

  it('в задании есть всё, по чему водитель едет: рейс, машина, заявка, адреса и груз', async () => {
    const request = await makeRequest({
      loading: 'г Москва, ул Погрузочная, д 1',
      unloading: 'г Москва, ул Разгрузочная, д 2',
      // 05:30 UTC — это 08:30 по МСК: время подачи в письме печатается так, как его называют.
      scheduledAt: new Date(`${DATES.single}T05:30:00Z`),
    });
    const route = await makeRoute({ date: DATES.single, requestIds: [request.id] });

    const mail = await mailFor(DATES.single);
    expect(mail).not.toBeNull();
    expect(mail!.routeCount).toBe(1);
    const text = renderMail(mail!.content).text;

    // Номер рейса — то, чем водитель называет задание диспетчеру по телефону.
    expect(text).toContain(route.displayNumber);
    expect(text).toContain(MODEL_NAME);
    expect(text).toContain(REG_NUMBER);
    expect(text).toContain(request.displayNumber);
    expect(text).toContain('г Москва, ул Погрузочная, д 1');
    expect(text).toContain('г Москва, ул Разгрузочная, д 2');
    expect(text).toContain('08:30');
    // Груз назван рядом со своей ролью на остановке, а не отдельной строкой заявки: «Грузим:
    // ТС-40/1 · заказчик · 12 м³». Так письмо читается в порядке движения — приехал, сделал (§8).
    expect(text).toMatch(/Грузим:.*10(\.000)? м³/u);
    // Дата — в теме: письмо ищут в ящике по ней, а не по номеру рейса.
    expect(mail!.subject).toContain('2 марта');
    expect(mail!.content.title).toContain(ctx.driverName);
  });

  it('контакты заявки едут в письмо телефоном, по которому можно позвонить', async () => {
    const request = await makeRequest({
      loading: 'г Москва, ул Погрузочная, д 3',
      unloading: 'г Москва, ул Разгрузочная, д 4',
      scheduledAt: new Date(`${DATES.contacts}T06:00:00Z`),
      loadingName: 'Иванов Иван',
      // В базе номер лежит десятью цифрами (ADR 0066): в письмо он обязан выйти набираемым видом.
      loadingPhone: '9001234567',
      unloadingName: 'Петров Пётр',
      unloadingPhone: '9017654321',
    });
    await makeRoute({ date: DATES.contacts, requestIds: [request.id] });

    const text = await mailText(DATES.contacts);

    expect(text).toContain('Иванов Иван, +7 (900) 123 45 67');
    expect(text).toContain('Петров Пётр, +7 (901) 765 43 21');
  });

  it('отменённая заявка в задание не попадает, хотя из состава рейса не выбывает', async () => {
    const live = await makeRequest({
      loading: 'г Москва, ул Живая, д 5',
      unloading: 'г Москва, ул Разгрузочная, д 6',
      scheduledAt: new Date(`${DATES.cancelled}T06:00:00Z`),
    });
    const cancelled = await makeRequest({
      loading: 'г Москва, ул Отменённая, д 7',
      unloading: 'г Москва, ул Разгрузочная, д 8',
      scheduledAt: new Date(`${DATES.cancelled}T07:00:00Z`),
      status: 'cancelled',
    });
    const route = await makeRoute({
      date: DATES.cancelled,
      requestIds: [live.id, cancelled.id],
    });

    const text = await mailText(DATES.cancelled);

    expect(text).toContain(live.displayNumber);
    // Ехать по отменённой не надо, и печатать её — отправлять человека на работу, которой нет.
    expect(text).not.toContain(cancelled.displayNumber);
    expect(text).not.toContain('ул Отменённая');

    // Из состава она при этом не выбывает: рейс помнит, что талон был выписан именно на неё.
    const rows = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM vehicle_route_requests WHERE route_id = ${route.id}`,
    );
    expect(rows.rows[0]?.count).toBe('2');
  });

  it('рейс, где живых заявок не осталось, в письмо не идёт: ехать по нему некуда', async () => {
    const cancelled = await makeRequest({
      loading: 'г Москва, ул Пустая, д 13',
      unloading: 'г Москва, ул Разгрузочная, д 14',
      scheduledAt: new Date(`${DATES.emptyRoute}T06:00:00Z`),
      status: 'cancelled',
    });
    await makeRoute({ date: DATES.emptyRoute, requestIds: [cancelled.id] });

    // Заголовок «Рейс Р-12 · Грузоперевозка» и строка «Машина: …» без единой строки задания
    // сообщают водителю ровно ничего — такой рейс не печатается, а письмо остаётся пустым.
    expect(await mailFor(DATES.emptyRoute)).toBeNull();
  });

  it('удалённая заявка в задание не попадает', async () => {
    const live = await makeRequest({
      loading: 'г Москва, ул Живая, д 9',
      unloading: 'г Москва, ул Разгрузочная, д 10',
      scheduledAt: new Date(`${DATES.deleted}T06:00:00Z`),
    });
    const removed = await makeRequest({
      loading: 'г Москва, ул Удалённая, д 11',
      unloading: 'г Москва, ул Разгрузочная, д 12',
      scheduledAt: new Date(`${DATES.deleted}T07:00:00Z`),
      deleted: true,
    });
    await makeRoute({ date: DATES.deleted, requestIds: [live.id, removed.id] });

    const text = await mailText(DATES.deleted);

    expect(text).toContain(live.displayNumber);
    expect(text).not.toContain(removed.displayNumber);
    expect(text).not.toContain('ул Удалённая');
  });

  it('комментарий рейса печатается целиком: в письме его резать нечем и незачем', async () => {
    const comment = 'Позвонить диспетчеру за час до выезда и уточнить пропуск на площадку у охраны';
    const request = await makeRequest({
      loading: 'г Москва, ул Погрузочная, д 13',
      unloading: 'г Москва, ул Разгрузочная, д 14',
      scheduledAt: new Date(`${DATES.comment}T06:00:00Z`),
    });
    await makeRoute({ date: DATES.comment, requestIds: [request.id], comment });

    const text = await mailText(DATES.comment);

    // Именно целиком: в бланке та же запись режется по ширине графы, и обрезанное «уточнить
    // пропуск…» означало бы, что водитель не знает, у кого его брать.
    expect(comment.length).toBeGreaterThan(40);
    expect(text).toContain(comment);
  });

  it('два рейса за день — одно письмо с обоими: раскладывать три письма по порядку водителю нечем', async () => {
    const first = await makeRequest({
      loading: 'г Москва, ул Первая, д 15',
      unloading: 'г Москва, ул Разгрузочная, д 16',
      scheduledAt: new Date(`${DATES.twoRoutes}T05:00:00Z`),
    });
    const second = await makeRequest({
      loading: 'г Москва, ул Вторая, д 17',
      unloading: 'г Москва, ул Разгрузочная, д 18',
      scheduledAt: new Date(`${DATES.twoRoutes}T11:00:00Z`),
    });
    const morning = await makeRoute({ date: DATES.twoRoutes, requestIds: [first.id] });
    const evening = await makeRoute({ date: DATES.twoRoutes, requestIds: [second.id] });

    const mail = await mailFor(DATES.twoRoutes);
    expect(mail).not.toBeNull();
    // Счётчик уходит в статистику запуска рассылки: по нему видно, сколько заданий разослано.
    expect(mail!.routeCount).toBe(2);

    const text = renderMail(mail!.content).text;
    expect(text).toContain(morning.displayNumber);
    expect(text).toContain(evening.displayNumber);
    expect(text).toContain('ул Первая, д 15');
    expect(text).toContain('ул Вторая, д 17');
    expect(mail!.subject).toContain('2 рейса');
  });

  it('получателей рассылки задают рейсы: водитель без рейса в список не входит', async () => {
    const request = await makeRequest({
      loading: 'г Москва, ул Погрузочная, д 19',
      unloading: 'г Москва, ул Разгрузочная, д 20',
      scheduledAt: new Date(`${DATES.recipients}T06:00:00Z`),
    });
    await makeRoute({ date: DATES.recipients, requestIds: [request.id] });

    const drivers = await ctx.driversWithRoutes(DATES.recipients, DATES.recipients);

    const mine = drivers.find((d) => d.personId === ctx.driverId);
    expect(mine).toBeDefined();
    // Адрес берётся из карточки человека: слать задание больше некуда — учётки у водителя может
    // не быть вовсе.
    expect(mine!.email).toBe(ctx.driverEmail);
    expect(mine!.fullName).toBe(ctx.driverName);
    // Тот, у кого рейсов нет, получателем не становится: иначе ему ушло бы пустое письмо.
    expect(drivers.some((d) => d.personId === ctx.idleDriverId)).toBe(false);
  });
});
