import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * Фильтр «Принадлежность» заказа ТС — своя техника или аренда — на живой схеме и настоящим HTTP-
 * путём, во всех шести выдачах: список, лента, сводка над лентой, журнал закрытых, его итог и срез
 * «На объекте» с его сводкой.
 *
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ. Принадлежность — признак машины, а на заявке машин бывает несколько, и
 * ответ зависит от того, какую из них спрашивают:
 *
 * - **список, лента, сводка, журнал** — машина, назначенная **сейчас** (то, что лежит в назначении);
 *   так же отвечает «Арендодатель» журнала и вопрос часов и доставки при закрытии аренды;
 * - **«На объекте»** — машина **сегодняшнего дня**, та, что называет сама строка: рейс дня, иначе
 *   история назначения на день среза, иначе назначение. У линейного заказа без рейса дня машины нет.
 *
 * Поэтому главный случай — заявка со сменой машины по ходу срока: в назначении аренда (последнее
 * изменение, Р17), а сегодня на площадке стоит своя. В `legacy` срез отвечает назначением, в
 * `history` — свёрткой, и тест идёт двумя прогонами. Остальные случаи (назначение без истории,
 * рейс дня поверх арендного назначения, линейный без рейса, заявка без машины) от режима не
 * зависят и проверяются в обоих режимах для надёжности.
 *
 * Зачем база. Условия — подзапросы `EXISTS` и `coalesce` над пятью таблицами; правила контрактов их
 * не выражают, и расходятся здесь не правила, а код и схема. Сводки сверяются со строками под
 * ними: цифра над таблицей обязана сходиться со списком.
 *
 * Запуск (своя база заводится рядом с указанной и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/postgres \
 *     npx vitest run test/vehicle-request-ownership-filter.db.test.ts
 */

/** Своя база и режим на ней — до собственного `beforeAll`, чтобы окружение встало первым. */
const readMode = useReadModeDatabase('ownership');

const RUN = Date.now().toString(36).slice(-6);
const ADMIN_EMAIL = `db-ownership-admin-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';

// Срок накрывает сегодня; смена машины в истории стоит в будущем, поэтому «сегодня» попадает в
// первый отрезок, а назначение — по Р17 повторяющее последнее изменение — держит машину второго.
const TODAY = moscowDateKeyOf(new Date());
const TERM_FROM = shiftDateKey(TODAY, -10);
const TERM_TO = shiftDateKey(TODAY, 10);
const SWITCH = shiftDateKey(TODAY, 3);

type Scene = Record<
  'own' | 'rent' | 'fresh' | 'split' | 'routeDay' | 'linear' | 'closedOwn' | 'closedRent',
  string
>;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
  typeId: string;
  lessorId: string;
  ownVehicle: string;
  /** Машина рейса дня: своя, чтобы рейс стоял под арендным назначением (так бывает в базе). */
  routeVehicle: string;
  rentalVehicle: string;
  scene: Scene;
}

let ctx: Ctx;

/** ИНН с верной контрольной цифрой: обмен справочниками выгружает контрагентов целиком. */
function testInn(nineDigits: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(nineDigits[i]), 0);
  return `${nineDigits}${((sum % 11) % 10).toString()}`;
}

async function insertRequest(input: {
  status: 'new' | 'confirmed' | 'done';
  vehicleId: string | null;
  comment: string;
  linearFrozen?: boolean;
}): Promise<string> {
  const { db } = ctx;
  const [request] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests
        (request_type, object_id, vehicle_type_id, status, comment, created_by,
         is_linear_frozen, linear_frozen_at)
      VALUES ('special_equipment', ${ctx.objectId}::uuid, ${ctx.typeId}::uuid, ${input.status},
              ${input.comment}, ${ctx.adminId}::uuid,
              ${input.linearFrozen ? sql`true` : sql`NULL`},
              ${input.linearFrozen ? sql`now()` : sql`NULL`})
      RETURNING id`)
  ).rows;
  await db.execute(sql`
    INSERT INTO special_equipment_request_details
      (request_id, date_from, date_to, responsible_name, responsible_phone)
    VALUES (${request!.id}::uuid, ${TERM_FROM}::date, ${TERM_TO}::date, 'Петров Пётр Петрович',
            '9001234567')`);
  // У новой заявки машины нет — это и есть случай «без назначения».
  if (input.vehicleId) {
    await db.execute(sql`
      INSERT INTO vehicle_request_assignments
        (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
      SELECT ${request!.id}::uuid, v.id, v.vehicle_type_id, ${ctx.typeId}::uuid, ${ctx.adminId}::uuid
        FROM vehicles v WHERE v.id = ${input.vehicleId}::uuid`);
  }
  return request!.id;
}

async function addVehicleChange(
  requestId: string,
  effectiveDate: string,
  vehicleId: string,
  origin: 'assignment' | 'reassignment',
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, origin, change_group_id, created_by)
    VALUES (${requestId}::uuid, ${effectiveDate}::date, 'vehicle', ${vehicleId}::uuid, ${origin},
            ${randomUUID()}::uuid, ${ctx.adminId}::uuid)`);
}

/** День заказа, поставленный в рейс машины рейса, — тем, что сегодня и спрашивает срез. */
async function planDayOnRoute(requestId: string, vehicleId: string): Promise<void> {
  const [route] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_routes (vehicle_id, route_date, created_by)
      VALUES (${vehicleId}::uuid, ${TODAY}::date, ${ctx.adminId}::uuid)
      RETURNING id`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
    VALUES (${route!.id}::uuid, ${requestId}::uuid, 1, ${TODAY}::date)`);
}

beforeAll(async () => {
  if (!readMode.enabled) return;
  const { db, closeDb } = await import('../src/db/client');
  const { buildApp } = await import('../src/app');
  const { hashPassword } = await import('../src/auth/password');
  const app = await buildApp();

  const [admin] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
      VALUES (${ADMIN_EMAIL}, 'Тестовый', 'Администратор', '', ${await hashPassword(PASSWORD)},
              'admin', true)
      RETURNING id`)
  ).rows;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);

  const [type] = (
    await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE vk.code = 'special_equipment' AND vt.is_active AND NOT vt.is_linear
       ORDER BY vt.sort_order LIMIT 1`)
  ).rows;
  if (!type) throw new Error('В базе нет нелинейного типа спецтехники');
  // Площадка своя: все запросы файла сужены ею, и заявки соседних случаев в выдачу не попадают.
  const [object] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`own-filter-${RUN}`}, ${`Площадка фильтра принадлежности ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`)
  ).rows;
  // Арендодатель нужен машине аренды (`vehicles_rental_fields_check`) и фильтру «Арендодатель».
  const [lessor] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('vehicle_lessor'::counterparty_type, ${`Арендодатель фильтра ${RUN}`},
              ${testInn(`77${String(Date.now()).slice(-7)}`)})
      RETURNING id`)
  ).rows;

  const vehicle = async (ownership: 'own' | 'rental', tag: string): Promise<string> => {
    const [row] = (
      ownership === 'own'
        ? await db.execute<{ id: string }>(sql`
            INSERT INTO vehicles (ownership, vehicle_type_id, registration_number, status)
            VALUES ('own', ${type.id}::uuid, ${`О${tag}${RUN.slice(-3).toUpperCase()}77`}, 'active')
            RETURNING id`)
        : await db.execute<{ id: string }>(sql`
            INSERT INTO vehicles (ownership, vehicle_type_id, lessor_id, lessor_type,
                                  lessor_is_active, price_per_hour, description, status)
            VALUES ('rental', ${type.id}::uuid, ${lessor!.id}::uuid, 'vehicle_lessor', true, 1500,
                    ${`Аренда фильтра ${tag} ${RUN}`}, 'active')
            RETURNING id`)
    ).rows;
    return row!.id;
  };

  ctx = {
    app,
    db,
    closeDb,
    auth: { authorization: `Bearer ${login.json().accessToken}` },
    adminId: admin!.id,
    objectId: object!.id,
    typeId: type.id,
    lessorId: lessor!.id,
    ownVehicle: await vehicle('own', 'A'),
    routeVehicle: await vehicle('own', 'B'),
    rentalVehicle: await vehicle('rental', 'R'),
    scene: {} as Scene,
  };

  const scene = ctx.scene;
  scene.own = await insertRequest({
    status: 'confirmed',
    vehicleId: ctx.ownVehicle,
    comment: 'своя',
  });
  scene.rent = await insertRequest({
    status: 'confirmed',
    vehicleId: ctx.rentalVehicle,
    comment: 'аренда',
  });
  // Новая заявка: ни назначения, ни принадлежности — не проходит ни «Собственную», ни «Аренду».
  scene.fresh = await insertRequest({ status: 'new', vehicleId: null, comment: 'без машины' });

  // Главный случай: в назначении аренда (последнее изменение, Р17), а сегодня стоит своя машина.
  scene.split = await insertRequest({
    status: 'confirmed',
    vehicleId: ctx.rentalVehicle,
    comment: 'смена машины по ходу срока',
  });
  await addVehicleChange(scene.split, TERM_FROM, ctx.ownVehicle, 'assignment');
  await addVehicleChange(scene.split, SWITCH, ctx.rentalVehicle, 'reassignment');
  await ctx.db.execute(sql`
    UPDATE vehicle_requests
       SET assignment_history_state = 'materialized', assignment_history_validated_on = current_date
     WHERE id = ${scene.split}::uuid`);

  // Рейс дня поверх арендного назначения: лист выписан на машину рейса, и срез называет её.
  scene.routeDay = await insertRequest({
    status: 'confirmed',
    vehicleId: ctx.rentalVehicle,
    comment: 'рейс дня на своей машине',
  });
  await planDayOnRoute(scene.routeDay, ctx.routeVehicle);

  // Линейный режим без рейса дня: машина уехала на базу, и срез сегодняшней машины не называет.
  scene.linear = await insertRequest({
    status: 'confirmed',
    vehicleId: ctx.rentalVehicle,
    comment: 'линейный без рейса',
    linearFrozen: true,
  });

  scene.closedOwn = await insertRequest({
    status: 'done',
    vehicleId: ctx.ownVehicle,
    comment: 'закрыта своей',
  });
  scene.closedRent = await insertRequest({
    status: 'done',
    vehicleId: ctx.rentalVehicle,
    comment: 'закрыта арендой',
  });
}, 180_000);

afterAll(async () => {
  await ctx?.app?.close();
  await ctx?.closeDb();
});

// ── Запросы портала ──

type Ownership = 'own' | 'rental' | undefined;

/** Общая строка запроса: площадка своя, и фильтр дописывается, только когда он выбран. */
function query(ownership: Ownership, extra = ''): string {
  return `objectId=${ctx.objectId}&pageSize=100${ownership ? `&ownership=${ownership}` : ''}${extra}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: ctx.auth });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

/** Номера заявок сцены, нашедшиеся выдачей: по ним таблица ожиданий и читается. */
function named(foundIds: string[]): string[] {
  const byId = new Map(Object.entries(ctx.scene).map(([name, id]) => [id, name]));
  return foundIds
    .map((id) => byId.get(id))
    .filter((name): name is string => !!name)
    .sort();
}

const list = async (ownership: Ownership) =>
  named(
    (
      await getJson<{ items: { id: string }[] }>(`/api/v1/vehicle-requests?${query(ownership)}`)
    ).items.map((row) => row.id),
  );

const feed = async (ownership: Ownership) =>
  named(
    (
      await getJson<{ items: { kind: string; order?: { id: string } }[] }>(
        `/api/v1/vehicle-requests/feed?${query(ownership)}`,
      )
    ).items
      .filter((row) => row.kind === 'order')
      .map((row) => row.order!.id),
  );

const history = async (ownership: Ownership, extra = '') =>
  named(
    (
      await getJson<{ items: { id: string }[] }>(
        `/api/v1/vehicle-requests/history?${query(ownership, extra)}`,
      )
    ).items.map((row) => row.id),
  );

const onSite = async (ownership: Ownership) =>
  named(
    (
      await getJson<{ items: { id: string }[] }>(
        `/api/v1/vehicle-requests/on-site?${query(ownership)}`,
      )
    ).items.map((row) => row.id),
  );

/** Что назначено сейчас: «смена машины», «рейс дня» и «линейный» держат в назначении аренду. */
const BY_ASSIGNMENT: Record<'none' | 'own' | 'rental', string[]> = {
  none: ['closedOwn', 'closedRent', 'fresh', 'linear', 'own', 'rent', 'routeDay', 'split'],
  own: ['closedOwn', 'own'],
  rental: ['closedRent', 'linear', 'rent', 'routeDay', 'split'],
};

describeReadModes(readMode, 'фильтр «Принадлежность»', (mode) => {
  it('список и лента отбирают по назначенной машине; новая заявка не проходит ни одно значение', async () => {
    for (const [feedName, found] of [
      ['список', list],
      ['лента', feed],
    ] as const) {
      expect(await found(undefined), `${feedName}: без фильтра`).toEqual(BY_ASSIGNMENT.none);
      expect(await found('own'), `${feedName}: «Собственная»`).toEqual(BY_ASSIGNMENT.own);
      expect(await found('rental'), `${feedName}: «Аренда»`).toEqual(BY_ASSIGNMENT.rental);
    }
  });

  it('сводка над лентой сходится со строками под ней', async () => {
    const counts = (rows: string[]) => {
      const status = (name: string) =>
        name.startsWith('closed') ? 'done' : name === 'fresh' ? 'new' : 'confirmed';
      const result: Record<string, number> = { new: 0, confirmed: 0, done: 0, cancelled: 0 };
      for (const name of rows) result[status(name)]! += 1;
      return result;
    };
    for (const [ownership, rows] of [
      [undefined, BY_ASSIGNMENT.none],
      ['own', BY_ASSIGNMENT.own],
      ['rental', BY_ASSIGNMENT.rental],
    ] as const) {
      const summary = await getJson<Record<string, number>>(
        `/api/v1/vehicle-requests/summary?objectId=${ctx.objectId}${ownership ? `&ownership=${ownership}` : ''}`,
      );
      expect(
        { new: summary.new, confirmed: summary.confirmed, done: summary.done },
        `сводка: ${ownership ?? 'без фильтра'}`,
      ).toMatchObject({
        new: counts(rows).new,
        confirmed: counts(rows).confirmed,
        done: counts(rows).done,
      });
    }
  });

  it('журнал и его итог отбирают по назначенной машине', async () => {
    expect(await history(undefined)).toEqual(['closedOwn', 'closedRent']);
    expect(await history('own')).toEqual(['closedOwn']);
    expect(await history('rental')).toEqual(['closedRent']);

    const total = async (ownership: Ownership, extra = '') =>
      (
        await getJson<{ total: number }>(
          `/api/v1/vehicle-requests/history/summary?${query(ownership, extra)}`,
        )
      ).total;
    expect(await total(undefined)).toBe(2);
    expect(await total('own')).toBe(1);
    expect(await total('rental')).toBe(1);
  });

  it('«Арендодатель» и «Собственная» вместе дают пустой журнал, а с «Арендой» — прежний ответ', async () => {
    // Арендодатель есть только у арендной машины: такая пара честно ничего не находит, а не
    // возвращает своё «вопреки» выбранному арендодателю.
    expect(await history('own', `&lessorId=${ctx.lessorId}`)).toEqual([]);
    expect(await history('rental', `&lessorId=${ctx.lessorId}`)).toEqual(['closedRent']);
    expect(await history(undefined, `&lessorId=${ctx.lessorId}`)).toEqual(['closedRent']);
  });

  it('«На объекте» отбирает по машине сегодняшнего дня, а не по последнему назначению', async () => {
    // Назначение без истории, рейс дня и линейный режим от режима чтения не зависят:
    // - «рейс дня»: лист выписан на машину рейса (своя), хотя в назначении аренда;
    // - «линейный» без рейса: машины на день нет вовсе, ни одно значение его не находит.
    const split = byReadMode(mode, {
      // legacy: срез отвечает назначением — аренда, как и у остальных читателей.
      legacy: { own: false, rental: true },
      // history: свёртка на сегодня — первый отрезок, своя машина.
      history: { own: true, rental: false },
    });
    const expectedOwn = ['own', 'routeDay', ...(split.own ? ['split'] : [])].sort();
    const expectedRental = ['rent', ...(split.rental ? ['split'] : [])].sort();

    expect(await onSite('own')).toEqual(expectedOwn);
    expect(await onSite('rental')).toEqual(expectedRental);
    // Без фильтра срез держит все пять строк сцены: «линейный» остаётся в нём, просто без машины дня.
    expect(await onSite(undefined)).toEqual(['linear', 'own', 'rent', 'routeDay', 'split'].sort());

    // Сводка среза считается по тем же строкам, что и список под ней.
    const total = async (ownership: Ownership) =>
      (
        await getJson<{ total: number }>(
          `/api/v1/vehicle-requests/on-site/summary?objectId=${ctx.objectId}${ownership ? `&ownership=${ownership}` : ''}`,
        )
      ).total;
    expect(await total('own')).toBe(expectedOwn.length);
    expect(await total('rental')).toBe(expectedRental.length);
    expect(await total(undefined)).toBe(5);
  });
});
