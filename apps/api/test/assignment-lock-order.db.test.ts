import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { issueRequestEsm2 } from './waybill-issue-helper';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/*
 * ЭСМ2-РАЗРЕЗ. Предмет файла — **порядок захвата блокировок**: заявка берётся первой, дверь встаёт
 * в очередь за ней, встречный порядок даёт клинч. К режиму чтения это не относится ни сейчас, ни
 * после этапа 5: блокировки берутся одни и те же, чем бы ни была нарезана бумага, и две половины
 * ожиданий совпадали бы навсегда. Поэтому файл закрыт с `readModeIrrelevant`, а не обёрнут.
 *
 * Что разрез всё же задевает: `weekOf` в теле ручной выписки (`POST /:id/esm2`) — это **ключ
 * недели**, а не начало листа, и таким останется: недельный бланк выписывается на неделю, в которую
 * попадает названный день. Проверено прогоном: случай ручной выписки зелёный и от длины листа не
 * зависит — он про то, кто первым взял строку заявки.
 */

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА, И ОН ОПАСНЕЕ СОСЕДЕЙ ПО МОДУЛЮ. Управляющая строка режима одна на базу, а
 * последний случай её **замораживает** — то есть на несколько секунд закрывает пишущие двери всему,
 * что ходит в эту же базу. Запущенный вместе с другими `*.db.test.ts` по одной `TEST_DATABASE_URL`
 * он уронит соседей ответом `503`, и падение будет выглядеть их поломкой. Проверено: те же шесть
 * файлов, зелёные по отдельности, дают четыре падения, если гонять их одним прогоном с этим.
 *
 * Вторая причина та же, что у `assignment-mode.db.test.ts` и `assignment-periods-schema.db.test.ts`
 * (план Ю27): один файл строку меняет, другой проверяет её исходное состояние.
 *
 * Третья — сами блокировки: случаи держат строку заявки открытой транзакцией и ждут, пока в неё
 * упрётся дверь. Чужая нагрузка на ту же заявку сделала бы ожидание неотличимым от ошибки порядка.
 */

/**
 * Порядок захвата блокировок в дверях смен и ручной выписки — предварительный релиз, подэтап 2a
 * (план `docs/assignment-periods-plan.md`, решения Л3 и В5).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ЭТОГО НЕ ВИДНО ИЗ КОДА. Порядок захвата — свойство пары
 * транзакций, а не одной: файл, прочитанный сверху вниз, показывает, что дверь берёт заявку первой,
 * но не показывает, что этого достаточно. Достаточность доказывается встречей: команда истории
 * этапов 3–4 идёт `заявка → смена`, и если дверь смены пойдёт `смена → заявка`, Postgres разорвёт
 * одну из транзакций как взаимную блокировку (`40P01`). Такого падения не бывает в тесте одной
 * двери и не бывает на одном соединении — нужны два, и нужна настоящая очередь.
 *
 * Отсюда три предмета файла:
 *
 * 1. **пять дверей против команды истории** — сохранение смены, её удаление, подпись, снятие
 *    подписи и ручная выписка `on_demand`. Каждая проверяется одинаково: команда истории держит
 *    строку заявки, дверь встаёт в очередь **за ней** (а не за строкой смены или листа), команда
 *    свободно берёт всё, что ниже заявки, коммитит — и дверь доводит работу до конца;
 * 2. **контрольный клинч** — тот же сюжет с прежним порядком, изображённым сырым SQL: он обязан
 *    кончиться `40P01`. Без него первый предмет ничего не стоит: тест, в котором клинч невозможен
 *    в принципе, зелен и на сломанном коде;
 * 3. **метка `dirty` и гейт режима** — два механизма, приехавшие тем же релизом. Метку ставят все
 *    пять дверей, а гейт различает классы: `history_frozen` закрывает историю и оставляет смены,
 *    `all_frozen` закрывает и их (решение И1).
 *
 * ПОЧЕМУ `lock_timeout`. Ошибка порядка проявляется ожиданием, а ожидание без предела — это
 * зависший прогон, который читается как «тест сломался», а не «код сломался». Все соединения файла
 * ждут ограниченно и падают текстом.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_lock \
 *     npx vitest run test/assignment-lock-order.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-lock-order-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: порядок блокировок';
const TYPE_PREFIX = 'lock_order_';
/**
 * Имя типа с «Ямобуры…» по той же причине, что и у соседних файлов: половина db-тестов берёт тип
 * своего вида выражением `ORDER BY vt.name LIMIT 1`, и тип на «А» увёл бы их заявки к нам.
 */
const TYPE_NAME = 'Ямобуры тестовые (порядок блокировок, линейные)';

/** Сколько соединение файла готово ждать чужую блокировку, прежде чем упасть текстом. */
const LOCK_TIMEOUT_MS = 8_000;
/** Сколько ждём, пока дверь встанет в очередь: барьер, а не пауза «на глазок». */
const QUEUE_TIMEOUT_MS = 15_000;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  vehicleId: string;
  driverId: string;
  typeId: string;
  requestId: string;
  /** Версия заявки: двери, двигающие её, требуют актуальную. */
  version: number;
  /** День, за который ведутся смены: сегодняшний — он и внутри срока, и уже наступил. */
  today: string;
  pastFrom: string;
}

let ctx: Ctx;

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

/** Машинист: человек со специализацией «водитель» — без него ручная выписка не проходит. */
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
      lastName: 'Очередев',
      firstName: 'Пётр',
      middleName: 'Тестович',
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

// ── Сцена: линейный заказ в работе ──
// Линейный, потому что ручная выписка `on_demand` заведена ровно для него (ADR 0100 §6), а смены
// ведутся у любого заказа техники на объект в работе — то есть одна заявка обслуживает все пять
// дверей файла.

async function createType(kindId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}${Date.now()}`,
      name: TYPE_NAME,
      isLinear: true,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/**
 * Заказ, заведённый задним числом и сразу переведённый в работу.
 *
 * Задним числом — чтобы срок начинался на прошлой неделе: тогда сегодняшний день заведомо внутри
 * срока при любом дне запуска, а неделя ручной выписки обрезается сроком и кончается сегодня, то
 * есть выписка идёт обычной дверью, а не операцией коррекции.
 */
async function seedRequest(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      dateFrom: ctx.pastFrom,
      dateTo: ctx.today,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      backdateReason: 'Техника вышла раньше, чем оформили заявку',
      operationId: crypto.randomUUID(),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
      },
      schedule: { requestType: 'special_equipment', dateFrom: ctx.pastFrom, dateTo: ctx.today },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id, version: confirmed.json().version };
}

// ── Двери, которые проверяются ──

type Door = () => Promise<{ statusCode: number; body: string }>;

function saveShift(): Door {
  return () =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/vehicle-requests/${ctx.requestId}/shifts/${ctx.today}`,
      headers: ctx.auth,
      payload: { machineHours: 8, refuel: '', comment: '' },
    });
}

function deleteShift(): Door {
  return () =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/vehicle-requests/${ctx.requestId}/shifts/${ctx.today}`,
      headers: ctx.auth,
    });
}

function approveShift(approved: boolean): Door {
  return () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${ctx.requestId}/shifts/${ctx.today}/approval`,
      headers: ctx.auth,
      payload: { approved },
    });
}

/**
 * Ручная выписка недельного листа. Рукопожатие (Р21а) снимается помощником: предмет случая —
 * порядок захвата, а не набор предупреждений, и двухходовка утопила бы его в обвязке.
 */
function issueEsm2(): Door {
  return async () => {
    const { res } = await issueRequestEsm2({
      app: ctx.app,
      headers: ctx.auth,
      requestId: ctx.requestId,
      expectIssued: false,
      payload: {
        weekOf: ctx.today,
        vehicleId: ctx.vehicleId,
        driverPersonId: ctx.driverId,
        version: ctx.version,
      },
    });
    return res;
  };
}

// ── Соединение, изображающее команду истории ──

/**
 * Команда истории этапов 3–4, какой её задаёт канонический порядок (план §8): управляющая строка
 * `FOR SHARE`, затем строка заявки `FOR UPDATE`, затем всё остальное. Транзакция остаётся открытой:
 * очередь за ней и есть предмет проверки.
 */
async function openHistoryCommand(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM assignment_periods_control WHERE id = true FOR SHARE');
  await client.query('SELECT 1 FROM vehicle_requests WHERE id = $1 FOR UPDATE', [ctx.requestId]);
  return client;
}

/**
 * Запрос, вставший в очередь за этим бэкендом. Ждём появления, а не спим наугад.
 *
 * Наблюдатель — ОТДЕЛЬНОЕ соединение и обязательно вне транзакции: снимок `pg_stat_activity`
 * кешируется на всю транзакцию читателя, и опрос изнутри держателя блокировки возвращал бы текст
 * запроса, снятый первым же чтением. Проверено на живой базе: там, где дверь ждала заявку, такой
 * опрос показывал `begin` и предыдущий `update`. `pg_blocking_pids` при этом всегда свежий — он
 * читает менеджер блокировок, а не статистику, — и расхождение этих двух источников как раз и даёт
 * самое неприятное: правдивое условие с ложным текстом.
 */
async function queuedBehind(probe: pg.Client, pid: number): Promise<string> {
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await probe.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
      [pid],
    );
    if (rows[0]) return rows[0].query;
    if (Date.now() > deadline) {
      throw new Error(
        'дверь так и не встала в очередь за строкой заявки: значит она её не берёт — порядок захвата потерян',
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Соединение-наблюдатель: только опрос очередей, ни одной блокировки за собой. */
async function openProbe(): Promise<pg.Client> {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  return probe;
}

/**
 * Один случай на дверь: команда истории держит заявку, дверь идёт следом.
 *
 * Проверяется три вещи разом:
 *
 * - дверь ждёт **строку заявки**, а не строку смены и не лист. Это и есть «заявка первой»;
 * - пока дверь ждёт, команда истории свободно берёт всё, что ниже заявки, — смены и листы этого
 *   заказа. Держи дверь хоть одну из этих строк, встречный захват дал бы клинч, а с
 *   `lock_timeout` — быстрый отказ;
 * - после коммита команды дверь доводит работу до конца и отвечает успехом.
 */
async function raceAgainstHistory(door: Door): Promise<{ statusCode: number; body: string }> {
  const history = await openHistoryCommand();
  const probe = await openProbe();
  try {
    const { rows } = await history.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]!.pid;

    // Дверь не ждётся здесь намеренно: она обязана встать в очередь, и очередь — предмет проверки.
    const inFlight = door();
    const blocked = await queuedBehind(probe, pid);
    expect(blocked).toMatch(/vehicle_requests/);
    expect(blocked.toLowerCase()).toContain('for update');

    // Всё, что ниже заявки, свободно: дверь до этих строк ещё не дошла и дойти не могла.
    await history.query('SELECT 1 FROM vehicle_request_shifts WHERE request_id = $1 FOR UPDATE', [
      ctx.requestId,
    ]);
    await history.query('SELECT 1 FROM waybills WHERE source_request_id = $1 FOR UPDATE', [
      ctx.requestId,
    ]);
    await history.query('COMMIT');
    return await inFlight;
  } finally {
    await history.end();
    await probe.end();
  }
}

/** Метка загрязнения истории у заявки — её ставят все пять дверей (К4). */
async function dirtyFlag(): Promise<boolean> {
  const { rows } = await ctx.db.execute<{ dirty: boolean }>(sql`
    SELECT assignment_history_dirty AS dirty FROM vehicle_requests WHERE id = ${ctx.requestId}`);
  return rows[0]!.dirty;
}

async function clearDirty(): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE vehicle_requests SET assignment_history_dirty = false WHERE id = ${ctx.requestId}`);
}

/** Режим модуля ставится напрямую: предмет случая — двери, а не сама дверь переключения. */
async function forceMode(writeMode: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE assignment_periods_control SET write_mode = ${writeMode} WHERE id = true`);
}

describe.skipIf(!DB_URL)('порядок блокировок дверей смен и ручной выписки', () => {
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

    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vk.code = 'special_equipment'
      ORDER BY v.registration_number
      LIMIT 1`);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const vehicle = vehicles.rows[0];
    const object = objects.rows[0];
    if (!vehicle || !object) {
      throw new Error('в базе нет своей спецмашины или объекта: миграции не применены');
    }

    const today = moscowDateKeyOf(new Date());
    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      objectId: object.id,
      vehicleId: vehicle.id,
      driverId: await seedDriver(),
      typeId: '',
      requestId: '',
      version: 0,
      today,
      // Понедельник прошлой недели: срок заведомо накрывает сегодня при любом дне запуска.
      pastFrom: shiftDateKey(weekStartKey(today), -7),
    };
    ctx.typeId = await createType(vehicle.kind_id);
    const request = await seedRequest();
    ctx.requestId = request.id;
    ctx.version = request.version;
  }, 180_000);

  afterAll(async () => {
    if (ctx?.db) {
      // Режим возвращается в исходный: строка одна на базу, и оставить её замороженной значило бы
      // сломать соседей молча.
      await forceMode('normal');
      await ctx.db.execute(
        sql`DELETE FROM waybills WHERE source_request_id = ${ctx.requestId ?? null}`,
      );
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ${ctx.requestId ?? null}`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${PERSON_MARK}
          AND id NOT IN (SELECT driver_person_id FROM waybills)`);
      await ctx.db.execute(sql`
        DELETE FROM audit_log
         WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  // ── 1. Пять дверей против команды истории ──

  it('сохранение смены встаёт за заявкой и не клинчит с командой истории', async () => {
    await clearDirty();
    const res = await raceAgainstHistory(saveShift());
    expect(res.statusCode, res.body).toBe(200);
    expect(await dirtyFlag()).toBe(true);
  });

  it('подпись дня встаёт за заявкой и не клинчит с командой истории', async () => {
    await clearDirty();
    const res = await raceAgainstHistory(approveShift(true));
    expect(res.statusCode, res.body).toBe(200);
    expect(await dirtyFlag()).toBe(true);
  });

  it('снятие подписи встаёт за заявкой и не клинчит с командой истории', async () => {
    await clearDirty();
    const res = await raceAgainstHistory(approveShift(false));
    expect(res.statusCode, res.body).toBe(200);
    expect(await dirtyFlag()).toBe(true);
  });

  it('ручная выписка ЭСМ-2 встаёт за заявкой и не клинчит с командой истории', async () => {
    await clearDirty();
    const res = await raceAgainstHistory(issueEsm2());
    expect(res.statusCode, res.body).toBe(200);
    expect(await dirtyFlag()).toBe(true);
    // Версия заявки двигается той же транзакцией — следующая дверь должна знать новую.
    ctx.version = JSON.parse(res.body).version as number;
  });

  it('удаление смены встаёт за заявкой и не клинчит с командой истории', async () => {
    await clearDirty();
    const res = await raceAgainstHistory(deleteShift());
    expect(res.statusCode, res.body).toBe(200);
    expect(await dirtyFlag()).toBe(true);
  });

  // ── 2. Контрольный клинч ──

  /**
   * Прежний порядок, изображённый сырым SQL: ручка смены правит смену и только потом трогает
   * заявку (именно это и делала бы старая сборка, получив метку `dirty`), а команда истории идёт
   * каноном. Ожидание встречное, и Postgres обязан разорвать одну из транзакций.
   *
   * Случай нужен ровно затем, чтобы предыдущие пять что-то значили: он показывает, что клинч в
   * этой сцене достижим, и зелёные выше — свойство порядка, а не удачи.
   */
  it('встречный порядок «смена → заявка» даёт клинч — тем и доказаны предыдущие случаи', async () => {
    // Строка смены нужна обеим сторонам: удаление выше её унесло.
    const filled = await saveShift()();
    expect(filled.statusCode, filled.body).toBe(200);

    const oldDoor = new pg.Client({ connectionString: DB_URL });
    const history = new pg.Client({ connectionString: DB_URL });
    await oldDoor.connect();
    await history.connect();
    const probe = await openProbe();
    try {
      // Предел ожидания больше `deadlock_timeout` (по умолчанию секунда): иначе первым сработал бы
      // он, и вместо клинча тест увидел бы обычный таймаут.
      await oldDoor.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await history.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await oldDoor.query('BEGIN');
      await history.query('BEGIN');

      // Старая дверь: сначала смена.
      await oldDoor.query(
        `UPDATE vehicle_request_shifts SET updated_at = now()
          WHERE request_id = $1 AND shift_date = $2`,
        [ctx.requestId, ctx.today],
      );
      // Команда истории: сначала заявка.
      await history.query('SELECT 1 FROM vehicle_requests WHERE id = $1 FOR UPDATE', [
        ctx.requestId,
      ]);

      // Старая дверь идёт за заявкой и встаёт в очередь за командой истории.
      const oldWaits = oldDoor.query(
        'UPDATE vehicle_requests SET assignment_history_dirty = true WHERE id = $1',
        [ctx.requestId],
      );
      const {
        rows: [me],
      } = await history.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await queuedBehind(probe, me!.pid);

      // Команда истории идёт за сменой — кольцо замкнулось.
      const historyWaits = history.query(
        `UPDATE vehicle_request_shifts SET updated_at = now()
          WHERE request_id = $1 AND shift_date = $2`,
        [ctx.requestId, ctx.today],
      );

      const outcome = await Promise.allSettled([oldWaits, historyWaits]);
      const codes = outcome
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as { code?: string }).code);
      expect(codes).toContain('40P01');
    } finally {
      await oldDoor.query('ROLLBACK').catch(() => undefined);
      await history.query('ROLLBACK').catch(() => undefined);
      await oldDoor.end();
      await history.end();
      await probe.end();
    }
  });

  // ── 3. Гейт режима: классы дверей (И1) ──

  /**
   * Двери зовут `requireOpenDoor` — и зовут с правильным классом. Проверяется поведением, а не
   * чтением кода: в `history_frozen` смены работают, а дверь, читающая историю ради бумаги, уже
   * закрыта; в `all_frozen` закрыты обе.
   *
   * Сегодня режим всегда `normal`, поэтому пользователь разницы не видит — в этом и смысл
   * предварительного релиза (В5): механизм обязан приехать в ту сборку, на которую откатываются,
   * раньше, чем им начнут пользоваться.
   */
  /*
   * Случай включается явным `AP_GATE_TEST=1`, а не идёт всегда: он единственный здесь замораживает
   * управляющую строку — одну на базу, — и на эти секунды закрывает пишущие двери всему, что ходит
   * в ту же базу. Проверено: шесть db-файлов, зелёных по отдельности, дают два падения, если
   * гонять их одним прогоном с этим случаем. Падение при этом выглядит поломкой соседа, а не
   * миной, и стоило бы часа поисков не там.
   *
   * Запуск:
   *   AP_GATE_TEST=1 TEST_DATABASE_URL=…/своя_база npx vitest run test/assignment-lock-order.db.test.ts
   */
  it.skipIf(!process.env.AP_GATE_TEST)(
    'history_frozen закрывает историю и оставляет смены, all_frozen закрывает и их',
    async () => {
      try {
        await forceMode('history_frozen');

        const frozenHistoryDoor = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/vehicle-requests/${ctx.requestId}/early-end`,
          headers: ctx.auth,
        });
        expect(frozenHistoryDoor.statusCode, frozenHistoryDoor.body).toBe(503);
        expect(frozenHistoryDoor.json().code).toBe('assignment_mode_frozen');

        const shiftStillOpen = await saveShift()();
        expect(shiftStillOpen.statusCode, shiftStillOpen.body).toBe(200);

        await forceMode('all_frozen');
        const shiftClosed = await saveShift()();
        expect(shiftClosed.statusCode, shiftClosed.body).toBe(503);
        expect(JSON.parse(shiftClosed.body).code).toBe('assignment_mode_frozen');

        const issueClosed = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/vehicle-requests/${ctx.requestId}/esm2`,
          headers: ctx.auth,
          payload: {
            weekOf: ctx.today,
            vehicleId: ctx.vehicleId,
            driverPersonId: ctx.driverId,
            version: ctx.version,
          },
        });
        expect(issueClosed.statusCode, issueClosed.body).toBe(503);
      } finally {
        await forceMode('normal');
      }
    },
  );
});
