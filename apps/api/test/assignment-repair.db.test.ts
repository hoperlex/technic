import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  esm2Periods,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type Role,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentEffects from '../src/services/assignment-effects';
import type * as AssignmentRepair from '../src/services/assignment-repair';
import type * as AssignmentWrite from '../src/services/assignment-write';
import type * as Esm2 from '../src/services/waybill-esm2';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Каждая команда здесь берёт управляющую строку модуля `FOR SHARE` (шаг 0
 * канона), а соседние файлы модуля эту же строку меняют и замораживают (план Ю27, Ю30). Мало того,
 * теперь файл её и **двигает** сам — блок бумаги идёт двумя режимами, — так что общая база топила
 * бы соседей не гонкой, а прямой записью. Заводит и сносит базу механика `useReadModeDatabase`
 * ([assignment-read-mode.ts](assignment-read-mode.ts)); вне блока бумаги режим остаётся тем, каким
 * его привозит миграция `0167`, — `legacy`.
 */

/**
 * Дверь ремонта истории назначения
 * ([assignment-repair.ts](../src/services/assignment-repair.ts),
 * [vehicle-request-assignment-repair.ts](../src/routes/vehicle-request-assignment-repair.ts);
 * план `docs/assignment-periods-plan.md`, Р16, Р21, Р26–Р31; решения Ц3, Ц4, Х1, Ф1, Щ2, Э1–Э3, Ю2).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Пять предметов, и ни один из них не виден в коде двери по чтению:
 *
 * 1. **условный контракт прав (Р29, Ц3)** — единственная часть, которую нельзя проверить иначе, чем
 *    по HTTP с настоящими ролями: `waybills.correct` спрашивается **по посчитанному исходу**, а не
 *    по составу тела; глубже тридцати дней добавляется `correctBeyondLimit`; архивная заявка
 *    открывается **по идентификатору без `archive.read`**, а `restore` остаётся администраторским;
 * 2. **готовность по Р27** — сравнение множеств, а не проверка инварианта: все блокеры сняты —
 *    `ready`, часть осталась — `materialized`, занесён новый — 422 и ни одной записи;
 * 3. **заполнение `unknown` и его отмена** (Ф1, Щ1, Щ2, Э1, Ю2) — четыре положения отрезка внутри
 *    дыры, отмена каждого и цикл «отменил → заполнил заново, начиная раньше». Эти тесты идут
 *    **мимо флага** {@link AssignmentRepair.KNOWN_FILLS_ENABLED}: логика готова целиком, и включение
 *    фичи обязано быть снятием одного флага, а не дописыванием кода;
 * 4. **механический запрет** (Х1) — тот же флаг со стороны HTTP: тело с `knownFills` проходит схему
 *    (Ц4 — иначе человек прочёл бы «лишнее поле» вместо объяснения) и упирается в `409
 *    backdated_issue_not_authorized` на обеих ручках;
 * 5. **решение хвоста** (Р31) — дремлющая граница значением назначения, её провенанс и группа, и
 *    переключение на `history_wins` одной транзакцией;
 * 6. **бумага починенной истории** (§10, этап 5) — единственный предмет файла, у которого поведение
 *    зависит от **режима чтения**, и потому единственный, что идёт двумя прогонами: в `legacy`
 *    дверь бумаги не трогает вовсе (её ведёт недельная сверка, знающая одного машиниста на заявку),
 *    в `history` тот же ремонт переоформляет листы по отрезкам истории.
 *
 * ПОЧЕМУ ДВУМЯ ПРОГОНАМИ ИДЁТ ТОЛЬКО ШЕСТОЙ. Остальные пять сцен бумаги не имеют вовсе
 * (`issueSheets` у них не стоит), и шаг 12 в них — пустой план в обоих режимах: две половины
 * ожиданий совпадали бы навсегда, а не до cutover. Оборачивать их значило бы удвоить прогон ради
 * одинаковых чисел и спрятать единственное настоящее расхождение среди двадцати восьми мнимых.
 *
 * ПОЧЕМУ ЧАСТЬ ТЕСТОВ ИДЁТ ПО HTTP, А ЧАСТЬ — ПО СЕРВИСУ. Права, отпечаток и идемпотентность живут
 * в ручке и проверяются только через неё. Правила заполнения живут в чистом планировщике, и гонять
 * их через HTTP значило бы проверять флаг вместо правил — а флаг сегодня закрыт. Бумага — снова по
 * HTTP: шаг 12 ремонта живёт в **ручке** (`syncPaper` её команды), и вызов сервиса напрямую прошёл
 * бы мимо предмета.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_repair \
 *     npx vitest run test/assignment-repair.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/** Своя база и режим чтения на ней; стоит до собственного `beforeAll` — см. шапку механики. */
const readMode = useReadModeDatabase('repair');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-ap-repair';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: ремонт истории назначения';
const REQUEST_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: ремонт истории назначения';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';

const TODAY = moscowDateKeyOf(new Date());
/** Ремонт «свежего» долга: 20 дней — коррекция, но в пределах тридцати. */
const NEAR_FROM = shiftDateKey(TODAY, -20);
/** Ремонт настоящего миграционного долга: глубже тридцати дней. */
const DEEP_FROM = shiftDateKey(TODAY, -60);
const TERM_TO = shiftDateKey(TODAY, 10);

/*
 * Календарь блока бумаги. Он **недельный**, и это не украшение: сцена кладёт листы прежней,
 * недельной сверкой, и её единица — календарная неделя. Если бы сцена считала границы сама,
 * проверять было бы нечего — она нарисовала бы ровно тот разрез, который ждёт от двери.
 */
/** Понедельник текущей недели. */
const MONDAY = weekStartKey(TODAY);
/** Понедельник прошлой недели: к сегодня её лист уже отработан и потому заперт (Р21). */
const PREV_MONDAY = shiftDateKey(MONDAY, -7);
/** Воскресенье текущей недели — конец срока бумажной сцены: две недели работы. */
const PAPER_TO = shiftDateKey(MONDAY, 6);
/** Понедельник следующей недели. */
const NEXT_MONDAY = shiftDateKey(MONDAY, 7);
/** Воскресенье следующей недели: срок сцены частичного ремонта — три недели. */
const PAPER_TO_LONG = shiftDateKey(NEXT_MONDAY, 6);
/** Завтра: день, с которого сцена частичного ремонта снимает машиниста. */
const TOMORROW = shiftDateKey(TODAY, 1);

interface Account {
  id: string;
  email: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  repair: typeof AssignmentRepair;
  write: typeof AssignmentWrite;
  effects: typeof AssignmentEffects;
  esm2: typeof Esm2;
  admin: Account;
  dispatcher: Account;
  manager: Account;
  objectId: string;
  ownVehicle: { id: string; typeId: string };
  ownVehicleB: { id: string; typeId: string };
  rentalVehicle: { id: string; typeId: string };
  personA: string;
  personB: string;
}

let ctx: Ctx;
let seq = 0;

beforeAll(async () => {
  if (!DB_URL) return;
  /*
   * Окружение и миграции своей базы — уже за механикой режима: её `beforeAll` зарегистрирован
   * раньше этого и успевает выставить `DATABASE_URL` до первого импорта сервиса. Здесь остаётся
   * только то, чего она не знает: почта у приложения выключена явно, чтобы прогон не ходил наружу.
   */
  process.env.MAIL_ENABLED = 'false';

  const { buildApp: build } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  const app = await build();
  ctx = {
    app,
    db,
    closeDb,
    repair: await import('../src/services/assignment-repair'),
    write: await import('../src/services/assignment-write'),
    effects: await import('../src/services/assignment-effects'),
    esm2: await import('../src/services/waybill-esm2'),
  } as Ctx;
  await cleanup();

  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
  const vehicle = async (ownership: string, offset: number) => {
    const row = await one(sql`
      SELECT id, vehicle_type_id FROM vehicles
       WHERE deleted_at IS NULL AND ownership = ${ownership}
       ORDER BY id OFFSET ${offset} LIMIT 1`);
    return { id: row.id!, typeId: row.vehicle_type_id! };
  };
  ctx.ownVehicle = await vehicle('own', 0);
  ctx.ownVehicleB = await vehicle('own', 1);
  ctx.rentalVehicle = await vehicle('rental', 0);
  ctx.personA = await newPerson('Машинистов');
  ctx.personB = await newPerson('Сменщиков');
  ctx.admin = await newAccount('admin', 'admin');
  ctx.dispatcher = await newAccount('dispatcher', 'disp');
  ctx.manager = await newAccount('manager', 'mgr');
}, 240_000);

afterAll(async () => {
  if (!DB_URL || !ctx) return;
  await cleanup();
  await ctx.app?.close();
  await ctx.closeDb?.();
});

/**
 * Уборка. База своя, но общая для прогонов файла: заявки уносят историю, назначение и связи
 * каскадом, операции журнала — своими ссылками, а работники и учётки идут последними.
 */
async function cleanup(): Promise<void> {
  const db = ctx.db;
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'vehicle_request' AND entity_id IN (
    SELECT id::text FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  /*
   * Листы ЭСМ-2 — раньше заявок: `waybills.source_request_id` стоит под RESTRICT, и заявка с
   * выписанной бумагой не удалилась бы вовсе. Одним запросом уносятся и заменённые, и заменяющие:
   * самоссылка `corrects_waybill_id` проверяется в конце запроса, а не построчно.
   */
  await db.execute(sql`
    DELETE FROM waybills WHERE source_request_id IN (
      SELECT id FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  // Заявки следом: строки истории ссылаются на операции под RESTRICT, и уносит их каскад заявки.
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${REQUEST_MARK}`);
  await db.execute(sql`
    DELETE FROM waybill_corrections WHERE actor_user_id IN (
      SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
}

/**
 * Работник со **действующей специализацией водителя**: без неё человек в лист не попадает вовсе
 * (`findMachinist`), и сцена блока бумаги получила бы «Выберите машиниста» вместо листов.
 */
async function newPerson(lastName: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, comment)
      VALUES (${lastName}, 'Пров', ${PERSON_MARK}) RETURNING id`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO person_specializations (person_id, specialization_id, started_on)
    SELECT ${row!.id}, id, ${shiftDateKey(DEEP_FROM, -400)} FROM specializations WHERE code = 'driver'`);
  return row!.id;
}

async function newAccount(role: Role, suffix: string): Promise<Account> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${suffix}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Ремонтов', 'Пров', '', ${await hashPassword(PASSWORD)}, ${role},
              true, now())
      RETURNING id`)
  ).rows;
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { id: row!.id, email, auth: { authorization: `Bearer ${accessToken}` } };
}

// ── Сцена ──

interface SceneOptions {
  dateFrom?: string;
  dateTo?: string;
  /** Машина назначения; по умолчанию собственная A. */
  assignment?: { id: string; typeId: string };
  archived?: boolean;
  state?: 'empty' | 'materialized' | 'ready';
  /** Строки истории: одной командой бэкфилла, каждая своей группой. */
  history?: {
    effectiveDate: string;
    dimension: 'vehicle' | 'driver';
    vehicleId?: string;
    driverState?: 'set' | 'cleared' | 'unknown';
    driverPersonId?: string;
    origin?: string;
    group?: string;
  }[];
  /**
   * Выписать бумагу **прежней, недельной сверкой** — на весь срок и расчётом от его начала.
   *
   * Именно ею, а не прямой вставкой: сцена обязана дать двери ту бумагу, какую заявка носит
   * сегодня в бою, — по листу на календарную неделю, все с одним машинистом. Расчёт от `dateFrom`
   * нужен затем, чтобы лист достался и уже отработанной неделе: без неё нечего было бы запирать
   * (Р21) и нечего разблокировать поимённо (Р11).
   */
  issueSheets?: { driverPersonId: string; asOf?: string };
}

interface Scene {
  requestId: string;
  version: number;
}

/** Заказ спецтехники с назначением и восстановленной бэкфиллом историей. */
async function makeScene(options: SceneOptions = {}): Promise<Scene> {
  const dateFrom = options.dateFrom ?? NEAR_FROM;
  const dateTo = options.dateTo ?? TERM_TO;
  const assignment = options.assignment ?? ctx.ownVehicle;
  const state = options.state ?? 'materialized';
  const [request] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, assignment_history_state,
                                    assignment_history_validated_on, deleted_at, deleted_by)
      VALUES ('special_equipment', ${ctx.objectId}, ${assignment.typeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.admin.id}, ${state},
              ${state === 'empty' ? null : TODAY},
              ${options.archived ? new Date().toISOString() : null},
              ${options.archived ? ctx.admin.id : null})
      RETURNING id`)
  ).rows;
  const requestId = request!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${dateFrom}, ${dateTo})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${assignment.id}, ${assignment.typeId}, ${assignment.typeId},
            ${ctx.admin.id})`);

  const history = options.history ?? [
    { effectiveDate: dateFrom, dimension: 'vehicle' as const, vehicleId: ctx.ownVehicle.id },
    { effectiveDate: dateFrom, dimension: 'driver' as const, driverState: 'unknown' as const },
  ];
  const groups = new Map<string, string>();
  for (const row of history) {
    const groupId = row.group
      ? (groups.get(row.group) ?? groups.set(row.group, randomUUID()).get(row.group)!)
      : randomUUID();
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
         origin, change_group_id)
      VALUES (${requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
              ${row.driverPersonId ?? null}, ${row.driverState ?? null},
              ${row.origin ?? 'backfill'}, ${groupId})`);
  }
  if (options.issueSheets) {
    const { driverPersonId } = options.issueSheets;
    const issueAsOf = options.issueSheets.asOf ?? dateFrom;
    await ctx.db.transaction(async (tx) => {
      await ctx.esm2.syncEsm2Waybills(tx, {
        requestId,
        actor: { id: ctx.admin.id },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId,
        asOf: issueAsOf,
      });
    });
    /*
     * След подготовки из журнала убирается: владелец события сверки один, и пишет он его в той же
     * транзакции, что и листы, — в том числе когда сверку зовёт сцена. Утверждения о журнале
     * говорят о **ремонте**, а не о декорациях.
     */
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${requestId}`);
  }
  return { requestId, version: 0 };
}

const previewRepair = (account: Account, requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair/preview`,
    headers: account.auth,
    payload: body,
  });

/** Осмотр (6a): «что чинить» без работы в теле — та же дверь, GET и без единой мутации. */
const inspectRepair = (account: Account, requestId: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair/state`,
    headers: account.auth,
  });

const postRepair = (account: Account, requestId: string, body: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair`,
    headers: account.auth,
    payload: body,
  });

const operation = (reason: string) => ({ operationId: randomUUID(), reason });

type Executor = typeof AppDb | Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

async function rowsOf(requestId: string, on: Executor = ctx.db) {
  return (
    await on.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      vehicle_id: string | null;
      driver_person_id: string | null;
      driver_state: string | null;
      origin: string;
      change_group_id: string;
      correction_id: string | null;
      superseded_at: string | null;
      superseded_kind: string | null;
    }>(sql`
      SELECT * FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} ORDER BY effective_date, created_at`)
  ).rows;
}

const actual = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
  rows.filter((row) => row.superseded_at === null);

async function requestState(requestId: string) {
  const [row] = (
    await ctx.db.execute<{
      version: number;
      state: string;
      validated_on: string | null;
      dirty: boolean;
      deleted_at: string | null;
    }>(sql`
      SELECT version, assignment_history_state AS state,
             assignment_history_validated_on AS validated_on,
             assignment_history_dirty AS dirty, deleted_at
        FROM vehicle_requests WHERE id = ${requestId}`)
  ).rows;
  return row!;
}

// ── 1. Условный контракт прав (Р29, Ц3) ──

describe('права двери ремонта — условный контракт (Р29)', () => {
  it('исторический якорь требует waybills.correct: менеджеру 403, диспетчеру и админу — да', async () => {
    if (!DB_URL) return;
    const scene = await makeScene();
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
      operation: operation('Восстанавливаем машиниста по табелю'),
    };

    // Предпросмотр считает те же последствия и права не спрашивает: 403 посреди операции хуже,
    // чем отказ до неё, — но и запрещать смотреть последствия праву не за что.
    const preview = await previewRepair(ctx.manager, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(
      preview.json<{ operationRequirement: { kind: string } | null }>().operationRequirement,
    ).toEqual({ kind: 'crew', reasonRequired: true, operationIdRequired: true });

    const denied = await postRepair(ctx.manager, scene.requestId, {
      ...body,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(await rowsOf(scene.requestId)).toHaveLength(2);

    const allowed = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      operation: operation('Восстанавливаем машиниста по табелю'),
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('глубже тридцати дней спрашивает correctBeyondLimit: диспетчеру 403, админу — да', async () => {
    if (!DB_URL) return;
    const scene = await makeScene({ dateFrom: DEEP_FROM });
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: DEEP_FROM, driverPersonId: ctx.personA }],
    };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const fingerprint = preview.json<{ fingerprint: string }>().fingerprint;

    const denied = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      previewFingerprint: fingerprint,
      operation: operation('Миграционный долг'),
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ message: string }>().message).toMatch(/администратор/i);

    const allowed = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: fingerprint,
      operation: operation('Миграционный долг'),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect((await requestState(scene.requestId)).state).toBe('ready');
  });

  it('архивная заявка открывается по идентификатору без archive.read (Ц3)', async () => {
    if (!DB_URL) return;
    const scene = await makeScene({ archived: true });
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
    };

    // Диспетчер `archive.read` не имеет и по решению п. 8 иметь не будет: дверь пускает его к
    // архивной заявке по идентификатору, не показывая архив ни в списках, ни в поиске.
    const preview = await previewRepair(ctx.dispatcher, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<{
      archived: boolean;
      restoreRequired: boolean;
      fingerprint: string;
    }>();
    expect(dto.archived).toBe(true);
    // Листы архивной заявки остаются действующими, и «paper-free» решает расчёт, а не архивный
    // статус: у этой заявки план непуст, и ремонт без восстановления отклоняется.
    expect(dto.restoreRequired).toBe(true);

    const withoutRestore = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      previewFingerprint: dto.fingerprint,
      operation: operation('Ремонт архива'),
    });
    expect(withoutRestore.statusCode, withoutRestore.body).toBe(422);
    expect(withoutRestore.json<{ message: string }>().message).toMatch(/восстановлен/i);

    // `restore` остаётся администраторским — это вторая половина отступления Ц3.
    // Отпечаток берётся у предпросмотра **того же** тела: `restore` входит в последствия, и
    // подставить сюда отпечаток предыдущего просмотра значило бы получить 409 вместо 403.
    const restorePreview = await previewRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      restore: true,
    });
    expect(restorePreview.statusCode, restorePreview.body).toBe(200);
    const dispatcherRestore = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      restore: true,
      previewFingerprint: restorePreview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Ремонт архива'),
    });
    expect(dispatcherRestore.statusCode, dispatcherRestore.body).toBe(403);
    expect((await requestState(scene.requestId)).deleted_at).not.toBeNull();

    const adminPreview = await previewRepair(ctx.admin, scene.requestId, {
      ...body,
      restore: true,
    });
    const adminRestore = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      restore: true,
      previewFingerprint: adminPreview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Ремонт архива'),
    });
    expect(adminRestore.statusCode, adminRestore.body).toBe(200);
    const after = await requestState(scene.requestId);
    // Одна транзакция: и архив снят, и история починена. Половинчатого исхода не бывает (Р29).
    expect(after.deleted_at).toBeNull();
    expect(after.state).toBe('ready');
  });
});

// ── 2. Готовность по Р27 ──

describe('готовность истории (Р26, Р27)', () => {
  it('снятый блокер даёт ready, оставшийся — materialized', async () => {
    if (!DB_URL) return;
    const mid = shiftDateKey(TODAY, 3);
    const scene = await makeScene({
      history: [
        { effectiveDate: NEAR_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: NEAR_FROM, dimension: 'driver', driverState: 'unknown' },
        // Второй, независимый блокер: собственный отрезок со снятым машинистом (Р16).
        { effectiveDate: mid, dimension: 'driver', driverState: 'cleared' },
      ],
    });
    const partial = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
    };
    const preview = await previewRepair(ctx.admin, scene.requestId, partial);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<{
      stateAfter: string;
      requiredAnchors: { effectiveDate: string }[];
      blockedDays: { from: string; to: string }[];
    }>();
    // Предпросмотр называет обе границы: чинят их по очереди, и вторая не запирает первую.
    expect(dto.requiredAnchors.map((a) => a.effectiveDate).sort()).toEqual([NEAR_FROM, mid].sort());
    expect(dto.stateAfter).toBe('materialized');
    expect(dto.blockedDays.length).toBeGreaterThan(0);

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...partial,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Первый из двух пробелов'),
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const half = await requestState(scene.requestId);
    // Частичный ремонт записан, а состояние осталось `materialized`: чужой блокер команда не
    // обязана ни чинить, ни ухудшать.
    expect(half.state).toBe('materialized');
    expect(half.validated_on).toBe(TODAY);
    expect(half.dirty).toBe(false);

    const second = {
      mode: 'repair',
      version: half.version,
      anchors: [{ effectiveDate: mid, driverPersonId: ctx.personB }],
    };
    const secondPreview = await previewRepair(ctx.admin, scene.requestId, second);
    const done = await postRepair(ctx.admin, scene.requestId, {
      ...second,
      previewFingerprint: secondPreview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Второй пробел'),
    });
    expect(done.statusCode, done.body).toBe(200);
    expect((await requestState(scene.requestId)).state).toBe('ready');
  });

  it('занесённый блокер — 422 и ни одной записи (Р27)', () => {
    if (!DB_URL) return;
    const before = [{ date: '2026-01-01', kind: 'unknown' as const }];
    const after = [
      { date: '2026-01-01', kind: 'unknown' as const },
      // Тот же день, другая причина: сравнение по одним дням выдало бы это за частичный ремонт.
      { date: '2026-01-01', kind: 'cleared' as const },
    ];
    expect(() => ctx.repair.repairHistoryState(before, after)).toThrowError(/новые пробелы/);
    expect(ctx.repair.repairHistoryState(before, before)).toBe('materialized');
    expect(ctx.repair.repairHistoryState(before, [])).toBe('ready');
    // Расширение блокера на соседний день даёт новую пару — ловится тем же сравнением.
    expect(() =>
      ctx.repair.repairHistoryState(before, [...before, { date: '2026-01-02', kind: 'unknown' }]),
    ).toThrowError(/новые пробелы/);
  });

  it('`unknown` в заблокированном прошлом блокером не является, а mismatch хвоста — тем более (Р30)', async () => {
    if (!DB_URL) return;
    // Срок кончился: изменяемых дней нет вовсе, значит нет и блокеров, — а хвост при этом
    // расходится с назначением. Р30: это предупреждение, а не блокер.
    const scene = await makeScene({
      dateFrom: DEEP_FROM,
      dateTo: shiftDateKey(TODAY, -10),
      assignment: ctx.ownVehicleB,
      history: [
        { effectiveDate: DEEP_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: DEEP_FROM, dimension: 'driver', driverState: 'unknown' },
      ],
    });
    const preview = await previewRepair(ctx.admin, scene.requestId, {
      mode: 'repair',
      version: 0,
      tailResolution: { kind: 'assignment_wins' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<{
      stateAfter: string;
      blockedDays: unknown[];
      requiredVehicleResolution: { tailVehicleId: string; assignmentVehicleId: string } | null;
      fillableGaps: { from: string; to: string }[];
    }>();
    expect(dto.blockedDays).toEqual([]);
    expect(dto.stateAfter).toBe('ready');
    expect(dto.requiredVehicleResolution).toEqual(
      expect.objectContaining({
        tailVehicleId: ctx.ownVehicle.id,
        assignmentVehicleId: ctx.ownVehicleB.id,
      }),
    );
    // Тот же `unknown` заблокированного прошлого — адрес заполнения, а не якоря (Ц4).
    expect(dto.fillableGaps).toEqual([{ from: DEEP_FROM, to: shiftDateKey(TODAY, -10) }]);
  });

  /*
   * Осмотр (подэтап 6a). Окно портала обязано спросить «что чинить» до того, как назовёт работу:
   * какие `unknown`-промежутки заблокированы и адресуются заполнением, а какие правятся якорями,
   * знает только сервер. Предпросмотром это не спросить — его тело нарочно одно с боевым и пустоты
   * не допускает.
   */
  it('осмотр называет адреса заполнения и не пишет ни строки', async () => {
    if (!DB_URL) return;
    const scene = await makeScene({
      dateFrom: DEEP_FROM,
      dateTo: shiftDateKey(TODAY, -10),
      history: [
        { effectiveDate: DEEP_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: DEEP_FROM, dimension: 'driver', driverState: 'unknown' },
      ],
    });
    const before = await rowsOf(scene.requestId);

    const seen = await inspectRepair(ctx.admin, scene.requestId);
    expect(seen.statusCode, seen.body).toBe(200);
    const dto = seen.json<{
      state: string;
      stateAfter: string;
      fillableGaps: { from: string; to: string }[];
      requiredAnchors: unknown[];
      plan: { cancel: unknown[]; issue: unknown[] };
    }>();

    expect(dto.fillableGaps).toEqual([{ from: DEEP_FROM, to: shiftDateKey(TODAY, -10) }]);
    // Осмотр ничего не обещает: состояние после равно состоянию до, план бумаги пуст.
    expect(dto.stateAfter).toBe(dto.state);
    expect(dto.plan.cancel).toEqual([]);
    expect(dto.plan.issue).toEqual([]);
    // И ничего не пишет: строки истории те же, что были до запроса.
    expect(await rowsOf(scene.requestId)).toEqual(before);
  });

  /*
   * Полная история — не отказ, а ответ. Прежде дверь на `ready` отвечала 422 «ремонтировать
   * нечего», и окно, открытое ради отмены заполнения, не смогло бы даже показать список сделанных
   * заполнений.
   */
  it('осмотр проходит и на полной истории, где ремонту отказано', async () => {
    if (!DB_URL) return;
    const scene = await makeScene({
      dateFrom: shiftDateKey(TODAY, -3),
      dateTo: shiftDateKey(TODAY, 10),
      history: [
        {
          effectiveDate: shiftDateKey(TODAY, -3),
          dimension: 'vehicle',
          vehicleId: ctx.ownVehicle.id,
        },
        {
          effectiveDate: shiftDateKey(TODAY, -3),
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: ctx.personA,
          origin: 'machinist_change',
        },
      ],
      state: 'ready',
    });

    const seen = await inspectRepair(ctx.admin, scene.requestId);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json<{ state: string }>().state).toBe('ready');

    // Тот же запрос телом ремонта — законный отказ: чинить в полной истории нечего.
    const refused = await previewRepair(ctx.admin, scene.requestId, {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: shiftDateKey(TODAY, -3), driverPersonId: ctx.personB }],
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ code: string }>().code).toBe('assignment_history_ready');
  });
});

// ── 3. Механический запрет заполнения (Х1, Ц4) ──

describe('заполнение `unknown` открыто (Х1, Ц4)', () => {
  /*
   * Бухгалтерия согласовала выписку бланков задним числом (§15 п. 16, решение владельца от
   * 24.08.2026), и рубильник переведён. Прежде здесь стояли два случая на отказ — они и были
   * проверкой флага; теперь проверяется работа.
   *
   * Рубильник при этом никуда не делся: свернуть фичу — то же одно значение. Второй случай ниже
   * стережёт именно это свойство, а не текущее состояние.
   */
  it('заполнение проходит обеими ручками и доводит историю до полной', async () => {
    if (!DB_URL) return;
    // Сцена с настоящей дырой: машина известна, человек — нет. Прежде здесь стояла сцена без
    // `unknown`, и это не замечалось: отказ по флагу срабатывал раньше расчёта.
    const scene = await makeScene({
      dateFrom: DEEP_FROM,
      dateTo: shiftDateKey(TODAY, -10),
      history: [
        { effectiveDate: DEEP_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: DEEP_FROM, dimension: 'driver', driverState: 'unknown' },
      ],
    });
    const body = {
      mode: 'repair',
      version: 0,
      knownFills: [{ from: DEEP_FROM, to: shiftDateKey(TODAY, -30), personId: ctx.personA }],
      operation: operation('Нашли табель'),
    };

    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    // Предпросмотр по-прежнему ничего не пишет: строк столько же, сколько было до него.
    expect(await rowsOf(scene.requestId)).toHaveLength(2);

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      version: preview.json<{ version?: number }>().version ?? 0,
    });
    expect([200, 409]).toContain(applied.statusCode);
    if (applied.statusCode === 409) {
      // Версия сцены разошлась — предмет случая не в ней; главное, что отказ уже не про флаг.
      expect(applied.json<{ code: string }>().code).not.toBe('backdated_issue_not_authorized');
      return;
    }
    // Записана пара заполнения: `set` на начале отрезка и граница `unknown` за его концом (Ш4).
    const rows = await rowsOf(scene.requestId);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.some((r) => r.origin === 'known_fill')).toBe(true);
  });

  it('рубильник остался единственным условием: пустой список отказа не образует', () => {
    if (!DB_URL) return;
    expect(ctx.repair.KNOWN_FILLS_ENABLED).toBe(true);
    // Пустой список поля не образует: отказывать «на всякий случай» дверь не должна — это верно
    // при любом положении рубильника.
    expect(() => ctx.repair.assertKnownFillsAllowed(undefined)).not.toThrow();
    expect(() => ctx.repair.assertKnownFillsAllowed([])).not.toThrow();
  });
});

// ── 4. Правила заполнения и отмены — мимо флага (Ф1, Щ1, Щ2, Э1, Ю2) ──

describe('заполнение отрезка и его отмена (Щ1, Щ2, Э1)', () => {
  /**
   * Дыра `unknown` на весь заблокированный срок и заполнение внутри неё.
   *
   * Сцена живёт в откатываемой транзакции: правила проверяются на живой схеме — половину их держат
   * частичные UNIQUE и двусторонние CHECK, — но соседним тестам файла эти строки не нужны.
   */
  const gapScene = async (
    fill: { from: string; to: string },
    run: (state: {
      tx: Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];
      requestId: string;
      fillGroupId: string;
      correctionId: string;
    }) => Promise<void>,
    options: {
      /** Своя история вместо простой дыры: нужна там, где важен состав групп бэкфилла. */
      history?: SceneOptions['history'];
      /** Ждём отказа планировщика вместо записи: `run` тогда не зовётся вовсе. */
      expectRefusal?: (e: Error) => void;
    } = {},
  ) => {
    const dateFrom = DEEP_FROM;
    const dateTo = shiftDateKey(TODAY, -10);
    await ctx.db
      .transaction(async (tx) => {
        const [request] = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                          created_by, assignment_history_state,
                                          assignment_history_validated_on)
            VALUES ('special_equipment', ${ctx.objectId}, ${ctx.ownVehicle.typeId}, 'confirmed',
                    ${REQUEST_MARK}, ${ctx.admin.id}, 'materialized', ${TODAY})
            RETURNING id`)
        ).rows;
        const requestId = request!.id;
        await tx.execute(sql`
          INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
          VALUES (${requestId}, ${dateFrom}, ${dateTo})`);
        await tx.execute(sql`
          INSERT INTO vehicle_request_assignments
            (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
          VALUES (${requestId}, ${ctx.ownVehicle.id}, ${ctx.ownVehicle.typeId},
                  ${ctx.ownVehicle.typeId}, ${ctx.admin.id})`);
        const history = options.history ?? [
          { effectiveDate: dateFrom, dimension: 'vehicle' as const, vehicleId: ctx.ownVehicle.id },
          {
            effectiveDate: dateFrom,
            dimension: 'driver' as const,
            driverState: 'unknown' as const,
          },
        ];
        const groupIds = new Map<string, string>();
        for (const row of history) {
          const groupId = row.group
            ? (groupIds.get(row.group) ?? groupIds.set(row.group, randomUUID()).get(row.group)!)
            : randomUUID();
          await tx.execute(sql`
            INSERT INTO vehicle_request_assignment_changes
              (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
               origin, change_group_id)
            VALUES (${requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
                    ${row.driverPersonId ?? null}, ${row.driverState ?? null},
                    ${row.origin ?? 'backfill'}, ${groupId})`);
        }
        const [correction] = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id,
                                             authorization_scope)
            VALUES (${randomUUID()}, ${randomUUID()}, 'crew', 'Нашли табель', ${ctx.admin.id},
                    ${JSON.stringify({
                      schemaVersion: 1,
                      requiresCorrect: true,
                      requiresCorrectBeyondLimit: true,
                      requiresArchiveRestore: false,
                      effectiveDate: DEEP_FROM,
                      authorizedAsOf: TODAY,
                    })}::jsonb)
            RETURNING id`)
        ).rows;

        const context = await ctx.repair.readRepairContext(tx, requestId);
        const planned = (): ReturnType<typeof ctx.repair.planRepair> =>
          ctx.repair.planRepair({
            context,
            term: { dateFrom, dateTo },
            asOf: TODAY,
            request: { id: requestId, num: 1 },
            body: { mode: 'repair', knownFills: [{ ...fill, personId: ctx.personA }] },
          });
        if (options.expectRefusal) {
          try {
            planned();
          } catch (e) {
            options.expectRefusal(e as Error);
            throw new Error('rollback');
          }
          throw new Error('ожидался отказ, а планировщик прошёл');
        }
        const plan = planned();
        /*
         * Исход заполнения — `crew`, а не `assignment_tail` (Р29): мутация задевает непустой
         * исторический `inTermRange`, и матрица Р32 других исходов для этого случая не знает.
         * Ослаблять её ради «бумага же не меняется» нельзя — под то же исключение попала бы всякая
         * правка прошлого, не трогающая листы.
         */
        expect(
          ctx.effects.assignmentCommandEffects({
            changes: context.changes,
            term: { dateFrom, dateTo },
            asOf: TODAY,
            mutations: plan.effectMutations,
          }).operationOutcome,
        ).toBe('crew');
        const write = await ctx.write.applyAssignmentMutations(tx, {
          requestId,
          actorUserId: ctx.admin.id,
          correctionId: correction!.id,
          mutations: plan.writeMutations,
          denormalization: plan.denormalization,
        });
        const head = write.inserted.find((row) => row.origin === 'known_fill')!;
        await run({ tx, requestId, fillGroupId: head.changeGroupId, correctionId: correction!.id });
        throw new Error('rollback');
      })
      .catch((e: unknown) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  };

  const foldDriver = async (
    tx: Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0],
    requestId: string,
    date: string,
  ) => {
    const { assignmentStateOn } = await import('../src/services/assignment-history');
    const changes = await ctx.write.readAssignmentChanges(tx, requestId, { actualOnly: true });
    return assignmentStateOn(changes, date).driver;
  };

  const MID = shiftDateKey(DEEP_FROM, 10);
  const MID_TO = shiftDateKey(DEEP_FROM, 20);
  const LAST = shiftDateKey(TODAY, -10);

  it('середина: две строки одной группой, а свёртка за отрезком снова unknown', async () => {
    if (!DB_URL) return;
    await gapScene({ from: MID, to: MID_TO }, async ({ tx, requestId, fillGroupId }) => {
      const rows = actual(await rowsOf(requestId, tx));
      const fill = rows.filter((row) => row.change_group_id === fillGroupId);
      expect(fill).toHaveLength(2);
      expect(fill.map((row) => row.origin).sort()).toEqual(['known_fill', 'unknown_remainder']);
      // Двусторонний CHECK (Щ3, Ю2): у обеих строк обязателен `correction_id`.
      expect(fill.every((row) => row.correction_id !== null)).toBe(true);

      expect(await foldDriver(tx, requestId, shiftDateKey(MID, -1))).toEqual({ state: 'unknown' });
      expect(await foldDriver(tx, requestId, MID)).toEqual({ state: 'set', personId: ctx.personA });
      expect(await foldDriver(tx, requestId, MID_TO)).toEqual({
        state: 'set',
        personId: ctx.personA,
      });
      // Не «до следующего изменения», а ровно до конца отрезка: за ним стоит граница остатка.
      expect(await foldDriver(tx, requestId, shiftDateKey(MID_TO, 1))).toEqual({
        state: 'unknown',
      });
    });
  });

  it('от начала промежутка: `set` ЗАМЕНЯЕТ строку бэкфилла и уходит в свою группу (Щ2)', async () => {
    if (!DB_URL) return;
    await gapScene({ from: DEEP_FROM, to: MID_TO }, async ({ tx, requestId, fillGroupId }) => {
      const rows = await rowsOf(requestId, tx);
      const backfill = rows.find((row) => row.origin === 'backfill' && row.dimension === 'driver')!;
      const head = rows.find((row) => row.origin === 'known_fill')!;
      // Замена, а не отмена: гашение групповое (В2), и на левой границе дыры оно унесло бы
      // спутников чужого решения. Вид погашения и обратная ссылка — то, чем эти два пути и
      // различаются в журнале.
      expect(backfill.superseded_kind).toBe('replaced');
      expect(head.supersedes_change_id).toBe(backfill.id);
      // При этом группа у заполнения **своя**: Ю2 описывает её как «одна `known_fill` плюс не
      // более одного остатка», а группа бэкфилла этому описанию не отвечает. Названная группа
      // сильнее унаследованной — это и есть то, чего каркасу не хватало.
      expect(head.change_group_id).toBe(fillGroupId);
      expect(backfill.change_group_id).not.toBe(fillGroupId);
      expect(actual(rows).filter((row) => row.change_group_id === fillGroupId)).toHaveLength(2);
      expect(await foldDriver(tx, requestId, DEEP_FROM)).toEqual({
        state: 'set',
        personId: ctx.personA,
      });
      expect(await foldDriver(tx, requestId, shiftDateKey(MID_TO, 1))).toEqual({
        state: 'unknown',
      });
    });
  });

  /**
   * Левая граница дыры на переходе принадлежности — тот самый случай, ради которого замена и
   * получила собственную группу.
   *
   * `rental → own` бэкфилл пишет **одной группой**: vehicle-строку собственной машины и
   * `driver = unknown` (человека у него нет). Дыра начинается ровно на этой дате, и заполнение с
   * неё обязано: заменить `unknown`, оставить vehicle-строку на месте и не утащить её в свою
   * группу. Пара `cancel` + `insert` погасила бы группу целиком — заполнение дыры стёрло бы
   * решение о машине.
   */
  it('дыра начинается на переходе принадлежности: vehicle-строка группы переживает заполнение', async () => {
    if (!DB_URL) return;
    const turn = shiftDateKey(DEEP_FROM, 10);
    const history = [
      { effectiveDate: DEEP_FROM, dimension: 'vehicle' as const, vehicleId: ctx.rentalVehicle.id },
      { effectiveDate: DEEP_FROM, dimension: 'driver' as const, driverState: 'cleared' as const },
      {
        effectiveDate: turn,
        dimension: 'vehicle' as const,
        vehicleId: ctx.ownVehicle.id,
        group: 'переход',
      },
      {
        effectiveDate: turn,
        dimension: 'driver' as const,
        driverState: 'unknown' as const,
        group: 'переход',
      },
    ];
    await gapScene(
      { from: turn, to: MID_TO },
      async ({ tx, requestId, fillGroupId, correctionId }) => {
        const rows = await rowsOf(requestId, tx);
        const border = rows.find(
          (row) => row.dimension === 'vehicle' && row.effective_date === turn,
        )!;
        const replaced = rows.find(
          (row) =>
            row.origin === 'backfill' && row.dimension === 'driver' && row.effective_date === turn,
        )!;
        const head = rows.find((row) => row.origin === 'known_fill')!;

        // Главное: граница принадлежности не тронута — она и осталась актуальной.
        expect(border.superseded_at).toBeNull();
        expect(border.change_group_id).toBe(replaced.change_group_id);
        // А `unknown` той же группы заменён, и замена ушла в группу заполнения, а не осталась в
        // группе перехода.
        expect(replaced.superseded_kind).toBe('replaced');
        expect(head.change_group_id).toBe(fillGroupId);
        expect(fillGroupId).not.toBe(replaced.change_group_id);
        expect(actual(rows).filter((row) => row.change_group_id === fillGroupId)).toHaveLength(2);

        expect(await foldDriver(tx, requestId, shiftDateKey(turn, -1))).toEqual({
          state: 'cleared',
        });
        expect(await foldDriver(tx, requestId, turn)).toEqual({
          state: 'set',
          personId: ctx.personA,
        });

        // Отмена находит свою пару по группе и границу принадлежности тоже не трогает (Ю2).
        await cancelFill(tx, requestId, fillGroupId, correctionId);
        const afterCancel = await rowsOf(requestId, tx);
        expect(afterCancel.find((row) => row.id === border.id)!.superseded_at).toBeNull();
        expect(
          actual(afterCancel).filter((row) => row.change_group_id === fillGroupId),
        ).toHaveLength(0);
        // Слева от `from` действует `cleared`, а не `unknown`, — значит на дате обязана остаться
        // строка `unknown`, иначе через дыру протянулось бы «машиниста сняли» (Щ2).
        expect(await foldDriver(tx, requestId, turn)).toEqual({ state: 'unknown' });
      },
      { history },
    );
  });

  /**
   * Остаток прежнего отказа, и он сузился до одного случая: составное решение **внутри** отрезка.
   *
   * На левой границе строка теперь заменяется, а вот лишние `unknown` внутри `(from, to]`
   * по-прежнему **гасятся** — и гашение групповое (В2). Нормативный бэкфилл такой строки не
   * создаёт: составную группу он заводит только переходу принадлежности, а переход делает эту дату
   * началом дыры, а не её серединой. Но данные, норматив не соблюдающие, бывают, и молчаливая
   * потеря vehicle-границы дороже понятного отказа.
   */
  it('составное решение внутри отрезка — отказ: гашение унесло бы чужую vehicle-границу', async () => {
    if (!DB_URL) return;
    const turn = shiftDateKey(DEEP_FROM, 10);
    const history = [
      { effectiveDate: DEEP_FROM, dimension: 'vehicle' as const, vehicleId: ctx.ownVehicle.id },
      { effectiveDate: DEEP_FROM, dimension: 'driver' as const, driverState: 'unknown' as const },
      // Ненормативная пара: смена собственной машины на собственную, сгруппированная с `unknown`.
      // Обе стороны отрезка остаются portal + unknown, промежутки сливаются в одну дыру — и
      // нормализация дотянулась бы до этой группы.
      {
        effectiveDate: turn,
        dimension: 'vehicle' as const,
        vehicleId: ctx.ownVehicleB.id,
        group: 'составное',
      },
      {
        effectiveDate: turn,
        dimension: 'driver' as const,
        driverState: 'unknown' as const,
        group: 'составное',
      },
    ];
    let message: string | null = null;
    await gapScene(
      { from: DEEP_FROM, to: MID_TO },
      async () => {
        throw new Error('ожидался отказ, а заполнение прошло');
      },
      { history, expectRefusal: (e) => (message = e.message) },
    );
    expect(message).toMatch(/составное решение/);
  });

  it('до конца промежутка: второй строки нет — за отрезком уже нет неизвестного', async () => {
    if (!DB_URL) return;
    await gapScene({ from: MID, to: LAST }, async ({ tx, requestId, fillGroupId }) => {
      const fill = actual(await rowsOf(requestId, tx)).filter(
        (row) => row.change_group_id === fillGroupId,
      );
      expect(fill).toHaveLength(1);
      expect(fill[0]!.origin).toBe('known_fill');
      expect(await foldDriver(tx, requestId, LAST)).toEqual({
        state: 'set',
        personId: ctx.personA,
      });
    });
  });

  it('весь промежуток целиком: границы нет, дыра закрыта', async () => {
    if (!DB_URL) return;
    await gapScene({ from: DEEP_FROM, to: LAST }, async ({ tx, requestId, fillGroupId }) => {
      const fill = actual(await rowsOf(requestId, tx)).filter(
        (row) => row.change_group_id === fillGroupId,
      );
      expect(fill).toHaveLength(1);
      expect(await foldDriver(tx, requestId, DEEP_FROM)).toEqual({
        state: 'set',
        personId: ctx.personA,
      });
      expect(await foldDriver(tx, requestId, LAST)).toEqual({
        state: 'set',
        personId: ctx.personA,
      });
    });
  });

  it('отмена середины: `set` гасится, слева уже `unknown` — свёртка сама тянет дыру (Э1)', async () => {
    if (!DB_URL) return;
    await gapScene(
      { from: MID, to: MID_TO },
      async ({ tx, requestId, fillGroupId, correctionId }) => {
        await cancelFill(tx, requestId, fillGroupId, correctionId);
        const rows = actual(await rowsOf(requestId, tx));
        expect(rows.filter((row) => row.change_group_id === fillGroupId)).toHaveLength(0);
        // Новых строк не появилось: слева от `from` действует `unknown`, и дыра восстановилась сама.
        expect(rows.filter((row) => row.dimension === 'driver')).toHaveLength(1);
        expect(await foldDriver(tx, requestId, MID)).toEqual({ state: 'unknown' });
        expect(await foldDriver(tx, requestId, LAST)).toEqual({ state: 'unknown' });
      },
    );
  });

  it('отмена от левой границы: на дате остаётся `unknown`, иначе протянулось бы прошлое (Щ2)', async () => {
    if (!DB_URL) return;
    await gapScene(
      { from: DEEP_FROM, to: MID_TO },
      async ({ tx, requestId, fillGroupId, correctionId }) => {
        await cancelFill(tx, requestId, fillGroupId, correctionId);
        const rows = actual(await rowsOf(requestId, tx));
        const driver = rows.filter((row) => row.dimension === 'driver');
        // Погашенное не оживает (Р3): исходная строка бэкфилла осталась погашенной, а на дате встала
        // новая — остаток коррекции.
        expect(driver).toHaveLength(1);
        expect(driver[0]!.origin).toBe('unknown_remainder');
        expect(driver[0]!.effective_date).toBe(DEEP_FROM);
        expect(await foldDriver(tx, requestId, DEEP_FROM)).toEqual({ state: 'unknown' });
      },
    );
  });

  it('отмена → заполнение раньше прежнего `from`: человек виден весь отрезок (Э1)', async () => {
    if (!DB_URL) return;
    const wider = shiftDateKey(DEEP_FROM, 5);
    const widerTo = shiftDateKey(DEEP_FROM, 30);
    await gapScene(
      { from: MID, to: MID_TO },
      async ({ tx, requestId, fillGroupId, correctionId }) => {
        await cancelFill(tx, requestId, fillGroupId, correctionId);
        // Второе заполнение начинается раньше прежнего и пересекает его: без нормализации отрезка
        // оставшаяся граница `unknown` перебила бы нового человека уже на одиннадцатый день.
        const context = await ctx.repair.readRepairContext(tx, requestId);
        const plan = ctx.repair.planRepair({
          context,
          term: { dateFrom: DEEP_FROM, dateTo: LAST },
          asOf: TODAY,
          request: { id: requestId, num: 1 },
          body: {
            mode: 'repair',
            knownFills: [{ from: wider, to: widerTo, personId: ctx.personB }],
          },
        });
        await ctx.write.applyAssignmentMutations(tx, {
          requestId,
          actorUserId: ctx.admin.id,
          correctionId,
          mutations: plan.writeMutations,
          denormalization: plan.denormalization,
        });
        for (const day of [wider, MID, MID_TO, widerTo]) {
          expect(await foldDriver(tx, requestId, day), day).toEqual({
            state: 'set',
            personId: ctx.personB,
          });
        }
        expect(await foldDriver(tx, requestId, shiftDateKey(widerTo, 1))).toEqual({
          state: 'unknown',
        });
      },
    );
  });

  it('чужая группа под отмену заполнения — 422 not_a_known_fill_group (Ю2)', async () => {
    if (!DB_URL) return;
    await gapScene({ from: MID, to: MID_TO }, async ({ tx, requestId }) => {
      // Обычная историческая смена машиниста одной строкой: по составу она неотличима от
      // заполнения, и отмена «по составу» превратила бы известного человека обратно в `unknown`.
      const foreign = randomUUID();
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignment_changes
          (request_id, effective_date, dimension, driver_person_id, driver_state, origin,
           change_group_id)
        VALUES (${requestId}, ${shiftDateKey(MID_TO, 3)}, 'driver', ${ctx.personB}, 'set',
                'machinist_change', ${foreign})`);
      const context = await ctx.repair.readRepairContext(tx, requestId);
      let code: string | null = null;
      try {
        ctx.repair.planRepair({
          context,
          term: { dateFrom: DEEP_FROM, dateTo: LAST },
          asOf: TODAY,
          request: { id: requestId, num: 1 },
          body: { mode: 'cancel_fill', target: { changeGroupId: foreign } },
        });
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      expect(code).toBe('not_a_known_fill_group');
    });
  });

  async function cancelFill(
    tx: Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0],
    requestId: string,
    changeGroupId: string,
    correctionId: string,
  ): Promise<void> {
    const context = await ctx.repair.readRepairContext(tx, requestId);
    const plan = ctx.repair.planRepair({
      context,
      term: { dateFrom: DEEP_FROM, dateTo: shiftDateKey(TODAY, -10) },
      asOf: TODAY,
      request: { id: requestId, num: 1 },
      body: { mode: 'cancel_fill', target: { changeGroupId } },
    });
    // Отмена снимает **утверждение о факте**, и исход у неё `crew`: мутация задевает непустой
    // исторический `inTermRange` (Р13, Э2).
    expect(plan.summary.cancelledFillGroup).toBe(changeGroupId);
    expect(
      ctx.effects.assignmentCommandEffects({
        changes: context.changes,
        term: { dateFrom: DEEP_FROM, dateTo: shiftDateKey(TODAY, -10) },
        asOf: TODAY,
        mutations: plan.effectMutations,
      }).operationOutcome,
    ).toBe('crew');
    await ctx.write.applyAssignmentMutations(tx, {
      requestId,
      actorUserId: ctx.admin.id,
      correctionId,
      mutations: plan.writeMutations,
      denormalization: plan.denormalization,
    });
  }
});

// ── 5. Решение хвоста (Р31) ──

describe('решение расхождения хвоста (Р31)', () => {
  const PAST_TO = shiftDateKey(TODAY, -10);
  const SINCE = shiftDateKey(PAST_TO, 1);

  const tailScene = (assignment: { id: string; typeId: string }) =>
    makeScene({
      dateFrom: DEEP_FROM,
      dateTo: PAST_TO,
      assignment,
      history: [
        { effectiveDate: DEEP_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        {
          effectiveDate: DEEP_FROM,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: ctx.personA,
          origin: 'machinist_change',
        },
      ],
      state: 'ready',
    });

  it('assignment_wins пишет дремлющую границу значением назначения и не трогает его', async () => {
    if (!DB_URL) return;
    const scene = await tailScene(ctx.ownVehicleB);
    const body = { mode: 'repair', version: 0, tailResolution: { kind: 'assignment_wins' } };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    // Дремлющее решение бумаги не трогает, но операцию журнала требует: оно правит принятое
    // решение и обязано быть объяснено (Р32).
    expect(
      preview.json<{ operationRequirement: { kind: string } }>().operationRequirement.kind,
    ).toBe('assignment_tail');

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Дальше работает машина назначения'),
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const border = actual(await rowsOf(scene.requestId)).find(
      (row) => row.origin === 'tail_resolution',
    )!;
    expect(border.effective_date).toBe(SINCE);
    expect(border.vehicle_id).toBe(ctx.ownVehicleB.id);
    const [assignment] = (
      await ctx.db.execute<{ vehicle_id: string }>(sql`
        SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`)
    ).rows;
    // Р17, исключение 1: назначение и ставки решение не трогает — они уже его.
    expect(assignment!.vehicle_id).toBe(ctx.ownVehicleB.id);
    // Заявка была `ready` и осталась: расхождение хвоста readiness не касается (Р30).
    expect((await requestState(scene.requestId)).state).toBe('ready');
  });

  it('арендная машина назначения тянет за собой спутника `cleared` одной группой (Р16, В2)', async () => {
    if (!DB_URL) return;
    const scene = await tailScene(ctx.rentalVehicle);
    const body = { mode: 'repair', version: 0, tailResolution: { kind: 'assignment_wins' } };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Дальше работает арендная'),
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const rows = actual(await rowsOf(scene.requestId)).filter(
      (row) => row.origin === 'tail_resolution',
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.change_group_id)).size).toBe(1);
    expect(rows.find((row) => row.dimension === 'driver')!.driver_state).toBe('cleared');
  });

  it('переключение на history_wins гасит группу и переводит назначение одной транзакцией', async () => {
    if (!DB_URL) return;
    const scene = await tailScene(ctx.ownVehicleB);
    const first = { mode: 'repair', version: 0, tailResolution: { kind: 'assignment_wins' } };
    const firstPreview = await previewRepair(ctx.admin, scene.requestId, first);
    const firstApply = await postRepair(ctx.admin, scene.requestId, {
      ...first,
      previewFingerprint: firstPreview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Сначала назначение'),
    });
    expect(firstApply.statusCode, firstApply.body).toBe(200);

    const second = {
      mode: 'repair',
      version: firstApply.json<{ version: number }>().version,
      tailResolution: { kind: 'history_wins' },
    };
    const secondPreview = await previewRepair(ctx.admin, scene.requestId, second);
    expect(secondPreview.statusCode, secondPreview.body).toBe(200);
    const switched = await postRepair(ctx.admin, scene.requestId, {
      ...second,
      previewFingerprint: secondPreview.json<{ fingerprint: string }>().fingerprint,
      operation: operation('Назначение было записано ошибочно'),
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(
      actual(await rowsOf(scene.requestId)).filter((row) => row.origin === 'tail_resolution'),
    ).toHaveLength(0);
    const [assignment] = (
      await ctx.db.execute<{ vehicle_id: string }>(sql`
        SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`)
    ).rows;
    // Р17 `follow`: назначение обязано показать хвост истории, и ядро сверило это по живому
    // состоянию.
    expect(assignment!.vehicle_id).toBe(ctx.ownVehicle.id);
  });

  /*
   * Ю51: отказ называет **состояние заявки**, а не термин плана. Слово «хвост» человеку в окне не
   * говорит ничего — у заявки есть конец срока и машина, которая за ней числится после него.
   */
  it('расхождения нет — отказ говорит, что история и назначение сошлись, а не «хвост согласован»', async () => {
    if (!DB_URL) return;
    // Назначение той же машины, что ведёт история: выбирать не из чего.
    const scene = await tailScene(ctx.ownVehicle);
    const res = await previewRepair(ctx.admin, scene.requestId, {
      mode: 'repair',
      version: 0,
      tailResolution: { kind: 'assignment_wins' },
    });
    expect(res.statusCode, res.body).toBe(422);
    const { message } = res.json<{ message: string }>();
    expect(message).toMatch(/сходятся на конце срока/);
    expect(message).not.toMatch(/хвост/i);
  });

  it('history_wins без принятого решения отклоняется: первый выбор — смена техники', async () => {
    if (!DB_URL) return;
    const scene = await tailScene(ctx.ownVehicleB);
    const res = await previewRepair(ctx.admin, scene.requestId, {
      mode: 'repair',
      version: 0,
      tailResolution: { kind: 'history_wins' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/сменой техники/);
  });
});

// ── 6. Допуск двери, рукопожатие и повтор ──

describe('допуск, отпечаток и повтор', () => {
  it('состояние `empty` дверь не пускает, `ready` — только ради хвоста (Р29)', async () => {
    if (!DB_URL) return;
    /*
     * Волна 3.5 подключила ленивый бэкфилл: заявку в `empty` с живым назначением дверь больше не
     * отвергает — расчёт восстанавливает историю и пускает ремонт (это проверяет
     * `assignment-wire.db.test.ts`). Отказ остался там, где восстанавливать **нечем**: без
     * назначения у бэкфилла нет опоры (Р20), и дверь называет причину.
     */
    const empty = await makeScene({ state: 'empty', history: [] });
    await ctx.db.execute(
      sql`DELETE FROM vehicle_request_assignments WHERE request_id = ${empty.requestId}`,
    );
    const emptyRes = await previewRepair(ctx.admin, empty.requestId, {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
    });
    expect(emptyRes.statusCode, emptyRes.body).toBe(422);
    expect(emptyRes.json<{ message: string }>().message).toMatch(/не восстанавливается/i);

    const ready = await makeScene({
      state: 'ready',
      history: [
        { effectiveDate: NEAR_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        {
          effectiveDate: NEAR_FROM,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: ctx.personA,
          origin: 'machinist_change',
        },
      ],
    });
    const readyRes = await previewRepair(ctx.admin, ready.requestId, {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personB }],
    });
    expect(readyRes.statusCode, readyRes.body).toBe(422);
    expect(readyRes.json<{ code: string }>().code).toBe('assignment_history_ready');
  });

  /*
   * Ю51: отказ сформулирован про **действие человека**, а не про поле запроса. «Разблокировок нет,
   * а тело их подтверждает» отвечало на вопрос, которого человек не задавал.
   */
  it('лишнее подтверждение разблокировок — отказ говорит, что переоформлять нечего', async () => {
    if (!DB_URL) return;
    const scene = await makeScene();
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
      operation: operation('Восстанавливаем машиниста по табелю'),
    };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const res = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
      unlockFingerprint: 'подтверждение, которого не просили',
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/подтверждать нечего/);
    // Команда не прошла: история осталась той, какой её собрала сцена.
    expect(await rowsOf(scene.requestId)).toHaveLength(2);
  });

  it('якорь на дату, которой предпросмотр не называл, — 422', async () => {
    if (!DB_URL) return;
    const scene = await makeScene();
    const res = await previewRepair(ctx.admin, scene.requestId, {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: shiftDateKey(NEAR_FROM, 3), driverPersonId: ctx.personA }],
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/предпросмотр этой границы не называл/);
  });

  it('устаревший отпечаток — 409, а повтор по ключу операции идемпотентен (Р9, Р20)', async () => {
    if (!DB_URL) return;
    const scene = await makeScene();
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
      operation: operation('Восстанавливаем по табелю'),
    };
    const stale = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: 'f'.repeat(64),
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('assignment_preview_stale');

    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    const payload = {
      ...body,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
    };
    const first = await postRepair(ctx.admin, scene.requestId, payload);
    expect(first.statusCode, first.body).toBe(200);
    const version = first.json<{ version: number }>().version;

    // Тот же ключ, то же тело: работы второй раз не происходит, версия не двигается (Р9).
    const repeat = await postRepair(ctx.admin, scene.requestId, payload);
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json<{ repeated: boolean; version: number }>()).toMatchObject({
      repeated: true,
      version,
    });
    expect((await requestState(scene.requestId)).version).toBe(version);
    expect(
      actual(await rowsOf(scene.requestId)).filter((row) => row.origin === 'machinist_change'),
    ).toHaveLength(1);
  });

  it('операция журнала связана с заявкой и несёт снимок авторизации (Р9, §8 шаг 13)', async () => {
    if (!DB_URL) return;
    const scene = await makeScene();
    const op = operation('Восстанавливаем по табелю');
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
      operation: op,
    };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    const res = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: preview.json<{ fingerprint: string }>().fingerprint,
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = (
      await ctx.db.execute<{
        id: string;
        kind: string;
        authorization_scope: { requiresCorrect: boolean; requiresArchiveRestore: boolean } | null;
        payload: { effects?: unknown; repair?: { anchors: unknown[] } } | null;
      }>(sql`
        SELECT id, kind, authorization_scope, payload FROM waybill_corrections
         WHERE operation_id = ${op.operationId}`)
    ).rows;
    expect(row!.kind).toBe('crew');
    expect(row!.authorization_scope?.requiresCorrect).toBe(true);
    expect(row!.authorization_scope?.requiresArchiveRestore).toBe(false);
    expect(row!.payload?.effects).toBeDefined();
    expect(row!.payload?.repair?.anchors).toHaveLength(1);
    const [link] = (
      await ctx.db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM vehicle_request_corrections
         WHERE correction_id = ${row!.id} AND request_id = ${scene.requestId}`)
    ).rows;
    expect(Number(link!.n)).toBe(1);
  });
});

// ── 6. Бумага починенной истории: режим решает, кто её ведёт (§10, шаг 12, этап 5) ──

interface SheetRow {
  id: string;
  period_from: string;
  period_to: string;
  vehicle_id: string;
  driver_person_id: string;
  status: string;
}

/** Все листы заявки — и действующие, и сгоревшие: номер бланка не исчезает вместе со статусом. */
async function sheetsOf(requestId: string): Promise<SheetRow[]> {
  return (
    await ctx.db.execute<SheetRow>(sql`
      SELECT id, period_from, period_to, vehicle_id, driver_person_id, status
        FROM waybills WHERE source_request_id = ${requestId}
       ORDER BY period_from, id`)
  ).rows;
}

/**
 * Действующий лист **составом**: границы, машина, человек — то, чем документы и различаются.
 *
 * Числом здесь не обойтись, и это не придирка: в первом случае блока листов до ремонта два и после
 * ремонта два. Счётчик сказал бы «ничего не изменилось» ровно там, где бумага переоформлена на
 * другого человека, — а это и есть та ошибка, ради которой разрез затеян.
 */
const compositionOf = (rows: readonly SheetRow[]): string[] =>
  rows
    .filter((row) => row.status !== 'cancelled')
    .map((row) => `${row.period_from}|${row.period_to}|${row.vehicle_id}|${row.driver_person_id}`);

/** Сгоревшие номера — их идентификаторы: переоформление это аннулирование, а не правка бланка. */
const burnedOf = (rows: readonly SheetRow[]): string[] =>
  rows
    .filter((row) => row.status === 'cancelled')
    .map((row) => row.id)
    .sort();

const esm2EventsOf = async (
  requestId: string,
): Promise<{ metadata: { reason?: string; cancelled?: string[]; issued?: string[] } }[]> =>
  (
    await ctx.db.execute<{
      metadata: { reason?: string; cancelled?: string[]; issued?: string[] };
    }>(sql`
      SELECT metadata FROM audit_log
       WHERE entity_id = ${requestId} AND action = 'waybill.esm2_sync'
       ORDER BY created_at, id`)
  ).rows;

/**
 * Шаг 12 двери ремонта — единственный её предмет, зависящий от режима чтения (§10).
 *
 * До cutover бумагу ведёт недельная сверка: она знает **одного** машиниста на заявку и, позови её
 * ремонт, переписала бы починенные отрезки одним человеком — то есть уничтожила бы ровно тот
 * результат, ради которого дверь и звали. Поэтому в `legacy` дверь бумаги не трогает вовсе, хотя
 * план листов считает: без него не выразить ни `paperFree` (Р29), ни предпросмотр. После
 * переключения тот же посчитанный план исполняет `applyEsm2SyncPlanAndAudit`.
 *
 * Обе половины ожиданий пишутся **до** cutover: в окно `all_frozen` чинить набор нечем.
 */
describeReadModes(readMode, 'бумага починенной истории (§10, шаг 12)', (mode) => {
  it('починенный машинист прошлой недели: в legacy бумага молчит, в history переоформляется', async () => {
    if (!DB_URL) return;
    /*
     * Сцена кладёт бумагу прямой недельной сверкой — тем же способом, каким её носит заявка
     * сегодня: по листу на календарную неделю, оба на одного человека. Режим на подготовку не
     * влияет и заворачивать её в `inLegacy` незачем: `syncEsm2Waybills` — не дверь портала, и
     * бэкстопа (Р22) на ней нет.
     */
    const scene = await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: PAPER_TO,
      history: [
        { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: PREV_MONDAY, dimension: 'driver', driverState: 'unknown' },
      ],
      issueSheets: { driverPersonId: ctx.personA },
    });
    const before = await sheetsOf(scene.requestId);
    expect(compositionOf(before)).toEqual([
      `${PREV_MONDAY}|${shiftDateKey(PREV_MONDAY, 6)}|${ctx.ownVehicle.id}|${ctx.personA}`,
      `${MONDAY}|${PAPER_TO}|${ctx.ownVehicle.id}|${ctx.personA}`,
    ]);

    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: PREV_MONDAY, driverPersonId: ctx.personB }],
      operation: operation('По табелю обе недели отработал сменщик'),
    };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<{
      fingerprint: string;
      unlockFingerprint: string | null;
      requiredUnlocks: { waybillId: string }[];
      paperFree: boolean;
      stateAfter: string;
    }>();
    /*
     * Предпросмотр в обоих режимах **одинаков**, и это утверждение, а не совпадение: план листов
     * дверь считает всегда — им отвечают на «paper-free ли ремонт» (Р29) и им же называют листы,
     * которые операция обязана разблокировать поимённо (Р11). Режим решает не «считать ли», а
     * «исполнять ли».
     */
    expect(dto.paperFree).toBe(false);
    expect(dto.stateAfter).toBe('ready');
    // Отработанная неделя заперта (Р21) и потому названа поимённо; текущая ещё не кончилась.
    expect(dto.requiredUnlocks.map((sheet) => sheet.waybillId)).toEqual([before[0]!.id]);
    expect(dto.unlockFingerprint).not.toBeNull();

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: dto.fingerprint,
      unlockFingerprint: dto.unlockFingerprint!,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await requestState(scene.requestId)).state).toBe('ready');

    const after = await sheetsOf(scene.requestId);
    const expected = byReadMode(mode, {
      /*
       * До переключения чтения бумага остаётся ровно той же — теми же строками с теми же номерами.
       * Это не «дверь забыла»: недельная сверка воспроизвести починенный состав не умеет, и
       * молчание здесь честнее выписки не тому человеку.
       */
      legacy: {
        composition: compositionOf(before),
        burned: [] as string[],
        events: 0,
      },
      /*
       * После переключения тот же ремонт переоформляет обе недели: история говорит, что работал
       * сменщик, — бумага обязана говорить то же. Листов при этом снова два, и потому проверяется
       * СОСТАВ: сменился человек, а не количество документов.
       *
       * Прошлая неделя выписывается заново законно: её лист гасит **эта же** сверка, названная
       * поимённо разблокировкой (Р11, Ю84), — дырой в прошлом такая выписка не является.
       */
      history: {
        composition: [
          `${PREV_MONDAY}|${shiftDateKey(PREV_MONDAY, 6)}|${ctx.ownVehicle.id}|${ctx.personB}`,
          `${MONDAY}|${PAPER_TO}|${ctx.ownVehicle.id}|${ctx.personB}`,
        ],
        burned: [before[0]!.id, before[1]!.id].sort(),
        events: 1,
      },
    });
    expect(compositionOf(after)).toEqual(expected.composition);
    expect(burnedOf(after)).toEqual(expected.burned);

    const events = await esm2EventsOf(scene.requestId);
    expect(events).toHaveLength(expected.events);
    if (events.length > 0) {
      // Причина события — причина операции: ею и объясняется разрыв нумерации бланков (Р35).
      expect(events[0]!.metadata.reason).toBe('По табелю обе недели отработал сменщик');
      expect(events[0]!.metadata.issued).toHaveLength(2);
      expect(events[0]!.metadata.cancelled).toHaveLength(2);
    }
  });

  it('починен один блокер из двух: неделя режется по отрезку, а остаток дней законно без бумаги', async () => {
    if (!DB_URL) return;
    /*
     * Ремонт по своей природе бывает **частичным** (Р27), и это то, чем он отличается от команды
     * машиниста: постусловия «бумага сошлась» у него нет. Здесь блокера два — неизвестный машинист
     * с прошлой недели и снятый машинист с завтрашнего дня, — а чинится один. Заявка остаётся
     * `materialized`, дни со снятым машинистом остаются без листа, и команда **не откатывается**.
     */
    const scene = await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: PAPER_TO_LONG,
      history: [
        { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: PREV_MONDAY, dimension: 'driver', driverState: 'unknown' },
        { effectiveDate: TOMORROW, dimension: 'driver', driverState: 'cleared' },
      ],
      issueSheets: { driverPersonId: ctx.personA },
    });
    const before = await sheetsOf(scene.requestId);
    // Три недели срока — три листа прежней сверки, а если месяц кончается в середине недели, то
    // четыре: единица бумаги — неделя, подрезанная концом месяца (ADR 0142).
    expect(compositionOf(before)).toEqual(
      esm2Periods(PREV_MONDAY, PAPER_TO_LONG).map(
        (period) => `${period.from}|${period.to}|${ctx.ownVehicle.id}|${ctx.personA}`,
      ),
    );

    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: PREV_MONDAY, driverPersonId: ctx.personB }],
      operation: operation('По табелю прошлую неделю отработал сменщик'),
    };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<{
      fingerprint: string;
      unlockFingerprint: string | null;
      stateAfter: string;
      requiredAnchors: { effectiveDate: string }[];
    }>();
    // Обе границы названы, чинится одна — потому и `materialized` (Р27).
    expect(dto.requiredAnchors.map((anchor) => anchor.effectiveDate)).toEqual([
      PREV_MONDAY,
      TOMORROW,
    ]);
    expect(dto.stateAfter).toBe('materialized');

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: dto.fingerprint,
      unlockFingerprint: dto.unlockFingerprint!,
    });
    /*
     * Главное утверждение случая: частичный ремонт **проходит**. Постусловия «бумага сошлась с
     * разрезом» у этой двери нет намеренно — в отличие от команды машиниста, которая им себя и
     * откатывает. Здесь откатывать нечего: половина блокеров осталась неснятой, дни без известного
     * машиниста законно остаются без листа, и постусловие пришлось бы писать так, чтобы этот исход
     * считался нормой, — то есть не писать вовсе.
     */
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await requestState(scene.requestId)).state).toBe('materialized');

    const after = await sheetsOf(scene.requestId);
    const expected = byReadMode(mode, {
      // Бумага не тронута: недельная сверка эту работу не делает, и делать вид, что сделала, нечем.
      legacy: {
        composition: compositionOf(before),
        burned: [] as string[],
        events: 0,
        // Бумага и на завтра, и на неделю вперёд по-прежнему выписана — на человека, которого
        // история этих дней не знает. Ровно от этого расхождения и уходит переключение.
        paperBeyondToday: true,
      },
      /*
       * А здесь видно, чем отрезок отличается от недели. Текущая неделя перестала быть единицей:
       * машинист известен по сегодня включительно, и лист выписан ровно на эти дни — от
       * понедельника до сегодня. Дни со снятым машинистом (с завтра и до конца срока) остаются без
       * бумаги вовсе, и лист следующей недели сгорает без замены: истории, которая назвала бы его
       * человека, нет.
       */
      history: {
        composition: [
          `${PREV_MONDAY}|${shiftDateKey(PREV_MONDAY, 6)}|${ctx.ownVehicle.id}|${ctx.personB}`,
          `${MONDAY}|${TODAY}|${ctx.ownVehicle.id}|${ctx.personB}`,
        ],
        burned: before.map((sheet) => sheet.id).sort(),
        events: 1,
        paperBeyondToday: false,
      },
    });
    expect(compositionOf(after)).toEqual(expected.composition);
    expect(burnedOf(after)).toEqual(expected.burned);
    expect(await esm2EventsOf(scene.requestId)).toHaveLength(expected.events);

    /*
     * И отдельно — то, ради чего случай и написан: в боевом режиме за починенным участком не
     * остаётся ни одного действующего листа, и заявка живёт с этим дальше — без отката, без
     * отказа и без выдуманного машиниста на завтра.
     */
    const live = after.filter((sheet) => sheet.status !== 'cancelled');
    expect(live.some((sheet) => sheet.period_to >= TOMORROW)).toBe(expected.paperBeyondToday);
  });
});
