import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type VehicleRequestDto,
  type SpecialEquipmentRequestDto,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * Четыре читателя денормализации на живой схеме и через настоящий HTTP-путь
 * (`docs/assignment-periods-plan.md`, Ф3 и С1, этап 5;
 * [assignment-read.ts](../src/services/assignment-read.ts)).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Четыре места портала отвечают на вопрос «что стояло на заявке в такой-то
 * день», и до разреза срока ответ у всех четырёх лежал в денормализации:
 *
 * 1. отбор «где ходила эта машина» — во **всех** четырёх местах применения (список, лента, журнал
 *    закрытых, сводка над таблицей): цифра над таблицей обязана сходиться со строками под ней;
 * 2. срез «Техника на площадке» — машина дня у обычного заказа;
 * 3. занятость гаража — `on_site` на день, а не на весь срок;
 * 4. контакт водителя у заказчика (`GET /vehicle-requests/:id/driver`, ADR 0122).
 *
 * ГЛАВНЫЙ СЛУЧАЙ, РАДИ КОТОРОГО ВСЁ И ДЕЛАЕТСЯ. Заявка, где машина A отработала первую половину
 * срока, а B — вторую. Денормализация повторяет **последнее** vehicle-изменение (Р17), то есть
 * знает только B, — и в `legacy` фильтр «где ходила A» такую заявку не находит вовсе, срез
 * показывает мартовскую машину на январской дате, а гараж ставит на площадку ту, которой там не
 * было. В `history` все четыре отвечают по свёртке.
 *
 * ПОЧЕМУ ОБА ПРОГОНА. Оба пути обязаны работать до самого cutover и переключаться обратимо. Прогон
 * `legacy` здесь не формальность: он и есть доказательство того, что старый ответ не сломан, — а
 * заодно ловит случай, когда «история» отвечает верно просто потому, что отвечает всегда.
 *
 * ПОЧЕМУ БАЗА, А НЕ ПРАВИЛА. Три читателя из четырёх — куски `WHERE`: их предмет живёт в
 * планировщике, а не в объектах. Свёртка на SQL, пересечение отрезка со сроком, `LEFT JOIN`
 * денормализации и режим, спрошенный подзапросом, — всё это либо работает на живой схеме, либо не
 * работает нигде.
 *
 * ИСТОРИЯ ПИШЕТСЯ ПРЯМОЙ ВСТАВКОЙ, а не дверьми модуля: предмет здесь — **чтение**. Сцена, собранная
 * командами, потребовала бы бумаги, отпечатков и открытых дверей, то есть проверяла бы запись перед
 * тем, как проверить чтение.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_readers \
 *     npx vitest run test/assignment-readers.db.test.ts
 */

/*
 * ЭСМ2-РАЗРЕЗ. Два недельных листа файл кладёт себе сам — календарной неделей, потому что восьмого
 * дня в бланке нет (`waybills_period_check`). Разрез их не задевает: границы листа ни в одно
 * утверждение не идут, а сами листы нужны здесь ровно за одним — дать ручке `/driver` её
 * `legacy`-ответ «человек последнего выписанного бланка», с которым и сравнивается ответ свёртки.
 * После переключения чтения этот же файл проверяет, что бумагу ручка больше не спрашивает.
 */

/** Своя база и режим на ней — до собственного `beforeAll`, чтобы окружение встало первым. */
const readMode = useReadModeDatabase('readers');

/** Хвост прогона: учётка живёт в базе прогона, но адрес и госномера удобнее держать уникальными. */
const RUN = Date.now().toString(36).slice(-6);

const ADMIN_EMAIL = `db-readers-admin-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';

// ── Календарь сцены ──
//
// Срок накрывает сегодня, а смена машины и машиниста стоит **в будущем**: так «сегодня» попадает в
// первый отрезок, а денормализация — по Р17 повторяющая последнее изменение — держит машину
// второго. Это и есть январь с мартом, сведённые к одной сцене: разница между «кто сейчас» и «чей
// след последний» видна без ожидания.

const TODAY = moscowDateKeyOf(new Date());
const TERM_FROM = shiftDateKey(TODAY, -10);
const TERM_TO = shiftDateKey(TODAY, 10);
/** День смены состава: с него работает вторая машина и второй машинист. */
const SWITCH = shiftDateKey(TODAY, 3);
/** День внутри первого отрезка и день внутри второго — ими спрашивают гараж и контакт. */
const IN_FIRST = shiftDateKey(TODAY, -5);
const IN_SECOND = shiftDateKey(TODAY, 5);
/** День за концом срока: ответа про людей у него быть не должно. */
const AFTER_TERM = shiftDateKey(TERM_TO, 3);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  /** Заявка с разрезом: A до `SWITCH`, B с него; в назначении — B. */
  splitRequestId: string;
  /** Она же, но закрытая: журнал закрытых спрашивают тем же фильтром. */
  closedRequestId: string;
  /** Заявка без истории (`empty`): отвечать ей нечем, кроме назначения. */
  emptyRequestId: string;
  /** Заявка под контакт водителя: машина одна, машинист меняется, листов два. */
  driverRequestId: string;
  vehicleA: string;
  vehicleB: string;
  vehicleC: string;
  /** Машина погашенного изменения: отбор её находить не должен. */
  vehicleD: string;
  regA: string;
  regB: string;
  regC: string;
  personFirst: string;
  personSecond: string;
  nameFirst: string;
  nameSecond: string;
}

let ctx: Ctx;

// ── Сцена ──

async function login(app: Ctx['app']): Promise<{ authorization: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/**
 * Строка истории — прямой вставкой. `origin` берётся по смыслу строки, а не одним значением на
 * всё: `assignment` открывает срок, `reassignment` меняет машину внутри него, `machinist_change` —
 * человека. CHECK'и таблицы разбирают состав строки по шкале, и «универсального» origin у них нет.
 */
async function addChange(input: {
  requestId: string;
  effectiveDate: string;
  vehicleId?: string;
  personId?: string;
  origin: string;
  superseded?: boolean;
}): Promise<void> {
  const { db } = ctx;
  const dimension = input.vehicleId ? 'vehicle' : 'driver';
  await db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id, created_by, superseded_at, superseded_by_user, superseded_kind)
    VALUES (${input.requestId}::uuid, ${input.effectiveDate}::date, ${dimension},
            ${input.vehicleId ?? null}::uuid, ${input.personId ?? null}::uuid,
            ${input.personId ? 'set' : null}, ${input.origin},
            ${randomUUID()}::uuid, ${ctx.adminId}::uuid,
            ${input.superseded ? sql`now()` : sql`NULL`},
            ${input.superseded ? sql`${ctx.adminId}::uuid` : sql`NULL`},
            ${input.superseded ? 'cancelled' : null})`);
}

/**
 * Заказ спецтехники со сроком и назначением. Назначение — обязательный спутник: без него ни один из
 * четырёх читателей не отвечает вовсе (карточка водителя выходит на первом же `if`), и проверялась
 * бы не ветвь режима, а отсутствие машины.
 */
async function makeRequest(input: {
  status: 'confirmed' | 'done';
  vehicleId: string;
  comment: string;
}): Promise<string> {
  const { db } = ctx;
  const [type] = (
    await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
       JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'special_equipment' AND vt.is_active AND NOT vt.is_linear
      ORDER BY vt.sort_order LIMIT 1`)
  ).rows;
  const [object] = (
    await db.execute<{ id: string }>(sql`SELECT id FROM construction_objects ORDER BY code LIMIT 1`)
  ).rows;
  if (!type || !object) throw new Error('В базе нет нелинейного типа спецтехники или площадки');

  const [request] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment, created_by)
      VALUES ('special_equipment', ${object.id}::uuid, ${type.id}::uuid, ${input.status},
              ${input.comment}, ${ctx.adminId}::uuid)
      RETURNING id`)
  ).rows;
  await db.execute(sql`
    INSERT INTO special_equipment_request_details
      (request_id, date_from, date_to, responsible_name, responsible_phone)
    VALUES (${request!.id}::uuid, ${TERM_FROM}::date, ${TERM_TO}::date, 'Петров Пётр Петрович',
            '9001234567')`);
  await db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    SELECT ${request!.id}::uuid, v.id, v.vehicle_type_id, ${type.id}::uuid, ${ctx.adminId}::uuid
      FROM vehicles v WHERE v.id = ${input.vehicleId}::uuid`);
  return request!.id;
}

/** Недельный лист ЭСМ-2 — тот самый «последний выписанный», которым отвечала ручка контакта. */
async function makeEsm2(input: {
  requestId: string;
  vehicleId: string;
  personId: string;
  from: string;
  to: string;
  number: number;
  issuedAt: string;
}): Promise<void> {
  const { db } = ctx;
  await db.execute(sql`
    INSERT INTO waybills
      (series_id, number, form_code, organization_id, vehicle_id, driver_person_id, issued_for_date,
       source_request_id, period_from, period_to, issued_by, issued_at)
    SELECT (SELECT id FROM waybill_series ORDER BY code LIMIT 1), ${input.number},
           'esm2', (SELECT id FROM organizations ORDER BY id LIMIT 1),
           ${input.vehicleId}::uuid, ${input.personId}::uuid, ${input.from}::date,
           ${input.requestId}::uuid, ${input.from}::date, ${input.to}::date,
           ${ctx.adminId}::uuid, ${input.issuedAt}::timestamptz`);
  await db.execute(sql`
    INSERT INTO waybill_requests (waybill_id, request_id, slot)
    SELECT id, ${input.requestId}::uuid, 1 FROM waybills WHERE number = ${input.number}`);
}

beforeAll(async () => {
  if (!readMode.enabled) return;
  // Окружение и база готовы хуком механики — остаётся забрать клиента, приложение и справочники.
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

  ctx = {
    app,
    db,
    closeDb,
    auth: { authorization: '' },
    adminId: admin!.id,
    splitRequestId: '',
    closedRequestId: '',
    emptyRequestId: '',
    driverRequestId: '',
    vehicleA: '',
    vehicleB: '',
    vehicleC: '',
    vehicleD: '',
    regA: '',
    regB: '',
    regC: '',
    personFirst: '',
    personSecond: '',
    nameFirst: 'Первый Машинист Отрезкович',
    nameSecond: 'Второй Машинист Отрезкович',
  };
  ctx.auth = await login(app);

  // Машины: своя серия госномеров, чтобы поиск гаража находил ровно нашу единицу.
  const regs = ['A', 'B', 'C', 'D', 'E'].map((tag) => `Т${tag}${RUN.slice(-3).toUpperCase()}77`);
  const vehicleIds: string[] = [];
  for (const reg of regs) {
    const [row] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO vehicles (ownership, vehicle_type_id, registration_number, status)
        SELECT 'own', vt.id, ${reg}, 'active'
          FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
         WHERE vk.code = 'special_equipment' AND vt.is_active AND NOT vt.is_linear
         ORDER BY vt.sort_order LIMIT 1
        RETURNING id`)
    ).rows;
    vehicleIds.push(row!.id);
  }
  [ctx.vehicleA, ctx.vehicleB, ctx.vehicleC, ctx.vehicleD] = vehicleIds as [
    string,
    string,
    string,
    string,
  ];
  const vehicleE = vehicleIds[4]!;
  [ctx.regA, ctx.regB, ctx.regC] = regs as [string, string, string];

  for (const [key, fullName] of [
    ['personFirst', ctx.nameFirst],
    ['personSecond', ctx.nameSecond],
  ] as const) {
    const [person] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO persons (last_name, first_name, middle_name, phone)
        VALUES (${fullName.split(' ')[0]}, ${fullName.split(' ')[1]}, ${fullName.split(' ')[2]},
                '+79990000001')
        RETURNING id`)
    ).rows;
    ctx[key] = person!.id;
  }

  // Заявка с разрезом. Назначение — B: денормализация повторяет последнее vehicle-изменение (Р17).
  ctx.splitRequestId = await makeRequest({
    status: 'confirmed',
    vehicleId: ctx.vehicleB,
    comment: 'Разрез срока: A, затем B',
  });
  ctx.closedRequestId = await makeRequest({
    status: 'done',
    vehicleId: ctx.vehicleB,
    comment: 'Разрез срока, работа закрыта',
  });
  for (const requestId of [ctx.splitRequestId, ctx.closedRequestId]) {
    await addChange({ requestId, effectiveDate: TERM_FROM, vehicleId: ctx.vehicleA, origin: 'assignment' });
    await addChange({ requestId, effectiveDate: SWITCH, vehicleId: ctx.vehicleB, origin: 'reassignment' });
    // Погашенная строка: свёртка её не читает, и отбор по этой машине заявку находить не должен.
    await addChange({
      requestId,
      effectiveDate: IN_FIRST,
      vehicleId: ctx.vehicleD,
      origin: 'reassignment',
      superseded: true,
    });
  }
  await addChange({
    requestId: ctx.splitRequestId,
    effectiveDate: TERM_FROM,
    personId: ctx.personFirst,
    origin: 'machinist_change',
  });

  // Заявка без истории: `empty` — то самое состояние, в котором свёртке отвечать нечем.
  ctx.emptyRequestId = await makeRequest({
    status: 'confirmed',
    vehicleId: ctx.vehicleC,
    comment: 'История не восстановлена',
  });

  // Заявка под контакт: машина одна (гараж её не путает с A и B), человек меняется, листов два —
  // и второй выписан позже первого. Именно этим «последний лист» и отвечал не тем человеком.
  ctx.driverRequestId = await makeRequest({
    status: 'confirmed',
    vehicleId: vehicleE,
    comment: 'Смена машиниста внутри срока',
  });
  await addChange({
    requestId: ctx.driverRequestId,
    effectiveDate: TERM_FROM,
    vehicleId: vehicleE,
    origin: 'assignment',
  });
  await addChange({
    requestId: ctx.driverRequestId,
    effectiveDate: TERM_FROM,
    personId: ctx.personFirst,
    origin: 'machinist_change',
  });
  await addChange({
    requestId: ctx.driverRequestId,
    effectiveDate: SWITCH,
    personId: ctx.personSecond,
    origin: 'machinist_change',
  });
  // Недели листов — календарные: в бланке семь строк, пн…вс, и восьмого дня в нём нет
  // (`waybills_period_check`). Первая неделя достаётся первому машинисту, вторая — второму, и
  // выписана она позже: ровно этим «последний лист» и отвечал не тем человеком.
  await makeEsm2({
    requestId: ctx.driverRequestId,
    vehicleId: vehicleE,
    personId: ctx.personFirst,
    from: weekStartKey(IN_FIRST),
    to: shiftDateKey(weekStartKey(IN_FIRST), 6),
    number: 900001,
    issuedAt: `${TERM_FROM}T09:00:00+03:00`,
  });
  await makeEsm2({
    requestId: ctx.driverRequestId,
    vehicleId: vehicleE,
    personId: ctx.personSecond,
    from: weekStartKey(IN_SECOND),
    to: shiftDateKey(weekStartKey(IN_SECOND), 6),
    number: 900002,
    issuedAt: `${TODAY}T09:00:00+03:00`,
  });

  // Метка состояния истории ставится вслед за строками: колонку ведёт бэкфилл, и оставленный
  // `empty` при живой истории — состояние, которого в базе не бывает.
  await db.execute(sql`
    UPDATE vehicle_requests
       SET assignment_history_state = 'materialized', assignment_history_validated_on = current_date
     WHERE id IN (${ctx.splitRequestId}::uuid, ${ctx.closedRequestId}::uuid,
                  ${ctx.driverRequestId}::uuid)`);
}, 180_000);

afterAll(async () => {
  await ctx?.app?.close();
  await ctx?.closeDb();
});

// ── Запросы портала ──

async function getJson<T>(url: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: ctx.auth });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

/** Нашёлся ли заказ отбором по машине — во всех четырёх местах применения сразу. */
async function foundByVehicle(vehicleId: string): Promise<{
  list: boolean;
  feed: boolean;
  history: boolean;
  summaryConfirmed: number;
  summaryDone: number;
}> {
  const [list, feed, history, summary] = await Promise.all([
    getJson<{ items: { id: string }[] }>(
      `/api/v1/vehicle-requests?vehicleId=${vehicleId}&pageSize=100`,
    ),
    getJson<{ items: { kind: string; order?: VehicleRequestDto }[] }>(
      `/api/v1/vehicle-requests/feed?vehicleId=${vehicleId}&pageSize=100`,
    ),
    getJson<{ items: { id: string }[] }>(
      `/api/v1/vehicle-requests/history?vehicleId=${vehicleId}&pageSize=100`,
    ),
    getJson<Record<string, number>>(`/api/v1/vehicle-requests/summary?vehicleId=${vehicleId}`),
  ]);
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  return {
    list: ids(list.items).includes(ctx.splitRequestId),
    feed: feed.items
      .filter((row) => row.kind === 'order')
      .map((row) => row.order!.id)
      .includes(ctx.splitRequestId),
    history: ids(history.items).includes(ctx.closedRequestId),
    summaryConfirmed: summary.confirmed!,
    summaryDone: summary.done!,
  };
}

/** Строка среза «Техника на площадке» по заявке; `undefined` — заявки в срезе нет вовсе. */
async function onSiteRow(requestId: string): Promise<SpecialEquipmentRequestDto | undefined> {
  const slice = await getJson<{ items: SpecialEquipmentRequestDto[] }>(
    '/api/v1/vehicle-requests/on-site?pageSize=100',
  );
  return slice.items.find((row) => row.id === requestId);
}

/** Состояние машины в гараже на день и номера заявок её занятости. */
async function garageState(
  reg: string,
  on: string,
): Promise<{ state: string; specials: string[] } | undefined> {
  const page = await getJson<{
    items: {
      registrationNumber: string;
      state: string;
      busy: { kind: string; displayNumber?: string }[];
    }[];
  }>(`/api/v1/garage/vehicles?on=${on}&search=${reg}&pageSize=50`);
  const row = page.items.find((item) => item.registrationNumber === reg);
  if (!row) return undefined;
  return {
    state: row.state,
    specials: row.busy.filter((entry) => entry.kind === 'special').map((e) => e.displayNumber!),
  };
}

describeReadModes(readMode, 'четыре читателя денормализации', (mode) => {
  it('отбор «где ходила эта машина»: заявка находится машиной первого отрезка', async () => {
    // Главный случай Ф3. Машина A отработала первую половину срока, но в назначении её нет — там
    // B (Р17). В `legacy` спросить про A нечем, и заявка теряется во всех четырёх местах сразу.
    const byFirst = await foundByVehicle(ctx.vehicleA);
    const expectedFirst = byReadMode(mode, { legacy: false, history: true });
    expect(byFirst.list).toBe(expectedFirst);
    expect(byFirst.feed).toBe(expectedFirst);
    expect(byFirst.history).toBe(expectedFirst);
    // Цифра над таблицей обязана сходиться со строками под ней — иначе разошлись бы два места
    // одного и того же отбора, и заметить это можно было бы только глазами.
    expect(byFirst.summaryConfirmed).toBe(expectedFirst ? 1 : 0);
    expect(byFirst.summaryDone).toBe(expectedFirst ? 1 : 0);
  });

  it('машина второго отрезка находится в обоих режимах', async () => {
    // B стоит и в назначении, и в истории: перевод читателя не должен ничего отнимать.
    const bySecond = await foundByVehicle(ctx.vehicleB);
    expect(bySecond.list).toBe(true);
    expect(bySecond.feed).toBe(true);
    expect(bySecond.history).toBe(true);
    expect(bySecond.summaryConfirmed).toBe(1);
    expect(bySecond.summaryDone).toBe(1);
  });

  it('машина погашенного изменения не находится ни в одном режиме', async () => {
    // Отменённое решение не действовало ни дня, и «где ходила эта машина» обязано отвечать про
    // работу, а не про следы в журнале.
    const byCancelled = await foundByVehicle(ctx.vehicleD);
    expect(byCancelled.list).toBe(false);
    expect(byCancelled.feed).toBe(false);
    expect(byCancelled.history).toBe(false);
    expect(byCancelled.summaryConfirmed).toBe(0);
  });

  it('заявка без истории (`empty`) находится своим назначением в обоих режимах', async () => {
    // То самое «что отвечать, когда свёртка пуста»: молчание убрало бы заявку из выдачи вовсе.
    const list = await getJson<{ items: { id: string }[] }>(
      `/api/v1/vehicle-requests?vehicleId=${ctx.vehicleC}&pageSize=100`,
    );
    expect(list.items.map((row) => row.id)).toContain(ctx.emptyRequestId);
    const summary = await getJson<Record<string, number>>(
      `/api/v1/vehicle-requests/summary?vehicleId=${ctx.vehicleC}`,
    );
    expect(summary.confirmed).toBe(1);
  });

  it('срез «Техника на площадке» называет машину дня, а не последнюю назначенную', async () => {
    const row = await onSiteRow(ctx.splitRequestId);
    expect(row, 'заявка обязана быть в срезе: её срок накрывает сегодня').toBeTruthy();
    // Назначение в обоих режимах остаётся прежним — читателя переводили, а не денормализацию.
    expect(row!.assignment?.vehicleId).toBe(ctx.vehicleB);
    if (mode === 'legacy') {
      // Поля нет вовсе: у обычного заказа день машину не выбирал, и колонка показывала назначение.
      expect(row!.dayVehicle).toBeUndefined();
      return;
    }
    expect(row!.dayVehicle?.vehicleId).toBe(ctx.vehicleA);
    expect(row!.dayVehicle?.driverPersonId).toBe(ctx.personFirst);
    // Рейса у стоянки на площадке нет: машину держит срок заказа, а не выезд.
    expect(row!.dayVehicle?.routeId).toBeNull();
  });

  it('срез не выдумывает машину дня заявке без истории', async () => {
    const row = await onSiteRow(ctx.emptyRequestId);
    expect(row).toBeTruthy();
    expect(row!.dayVehicle).toBeUndefined();
    expect(row!.assignment?.vehicleId).toBe(ctx.vehicleC);
  });

  it('гараж: на площадке стоит машина этого дня', async () => {
    const [firstA, firstB] = await Promise.all([
      garageState(ctx.regA, IN_FIRST),
      garageState(ctx.regB, IN_FIRST),
    ]);
    const number = formatVehicleRequestNumber(
      (
        await ctx.db.execute<{ num: number }>(
          sql`SELECT num FROM vehicle_requests WHERE id = ${ctx.splitRequestId}::uuid`,
        )
      ).rows[0]!.num,
    );
    expect(firstA!.state).toBe(byReadMode(mode, { legacy: 'free', history: 'on_site' }));
    expect(firstB!.state).toBe(byReadMode(mode, { legacy: 'on_site', history: 'free' }));
    // Расшифровка строки обязана совпасть с колонкой: разойдись они — колонка сказала бы «занята»,
    // а список занятостей под ней был бы пуст.
    expect(firstA!.specials).toEqual(byReadMode(mode, { legacy: [], history: [number] }));
    expect(firstB!.specials).toEqual(byReadMode(mode, { legacy: [number], history: [] }));

    // Тот же вопрос на дне второго отрезка: в `history` машины меняются местами, в `legacy` ответ
    // от дня не зависит вовсе — и это ровно та неправда, которую фича убирает.
    const [secondA, secondB] = await Promise.all([
      garageState(ctx.regA, IN_SECOND),
      garageState(ctx.regB, IN_SECOND),
    ]);
    expect(secondA!.state).toBe('free');
    expect(secondB!.state).toBe('on_site');
  });

  it('гараж: заявка без истории держит площадку своим назначением', async () => {
    const row = await garageState(ctx.regC, IN_FIRST);
    expect(row!.state).toBe('on_site');
  });

  it('контакт водителя: человек сегодняшнего отрезка, а не последнего бланка', async () => {
    const today = await getJson<{ personId: string }>(
      `/api/v1/vehicle-requests/${ctx.driverRequestId}/driver`,
    );
    // В `legacy` ручка отвечает последним выписанным листом — а он выписан на второго машиниста,
    // хотя работает сегодня первый. Это и есть С1.
    expect(today.personId).toBe(
      byReadMode(mode, { legacy: ctx.personSecond, history: ctx.personFirst }),
    );
  });

  it('контакт водителя: `on` спрашивает конкретный день, а вне срока ответ пуст', async () => {
    const [second, outside] = await Promise.all([
      getJson<{ personId: string } | null>(
        `/api/v1/vehicle-requests/${ctx.driverRequestId}/driver?on=${IN_SECOND}`,
      ),
      getJson<{ personId: string } | null>(
        `/api/v1/vehicle-requests/${ctx.driverRequestId}/driver?on=${AFTER_TERM}`,
      ),
    ]);
    expect(second?.personId).toBe(ctx.personSecond);
    // Вне срока — пусто, а не «последний известный»: заказчик спрашивает, кто у него работает.
    expect(outside?.personId ?? null).toBe(
      byReadMode(mode, { legacy: ctx.personSecond, history: null }),
    );
  });

  it('контакт водителя у заявки без истории отвечает прежним путём', async () => {
    // Ни листа, ни маршрута, ни истории — ответить нечем, и это одинаково верно в обоих режимах.
    const answer = await getJson<unknown>(
      `/api/v1/vehicle-requests/${ctx.emptyRequestId}/driver`,
    );
    expect(answer).toBeNull();
  });
});
