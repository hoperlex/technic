import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type AccessSubject,
  type AssignmentCommandInput,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentCrew from '../src/services/assignment-crew';
import type * as AssignmentWrite from '../src/services/assignment-write';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Здесь берётся управляющая строка модуля `FOR SHARE` (шаг 0 канона), а
 * соседние файлы модуля её же меняют и замораживают, — прогон по общей `TEST_DATABASE_URL` дал бы
 * падение, которое выглядит поломкой кода, а не гонкой файлов.
 */

/**
 * Соединение модуля периодов назначения с живыми данными — волна 3.5
 * (план `docs/assignment-periods-plan.md`, Ю48; Р20, Р26, Р28; §6 «Бэкфилл»).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ЭТОГО НЕ ВИДНО НИ В ОДНОМ СОСЕДНЕМ ФАЙЛЕ. Части модуля были
 * написаны и покрыты порознь: `assignment-ensure.db.test.ts` доказывает, что ленивый бэкфилл
 * восстанавливает историю правильно, а файлы дверей — что двери правильно её правят. Между ними
 * оставался стык: `ensureAssignmentHistory` не звал никто, колонка состояния заводилась миграцией
 * значением `empty`, и все три двери на `empty` отказывали — то есть на живых данных модуль был
 * инертен, а выхода из `empty` не существовало вовсе. Здесь предмет — именно стык:
 *
 * 1. **дверь работает по заявке в `empty`**, а не отказывает: историю ей восстанавливает шаг 5
 *    (расчёт) и записывает шаг 11, и после команды колонка состояния уже не `empty`;
 * 2. **предпросмотр по-прежнему не пишет ничего** (Р20) — ни строки истории, ни состояния, хотя
 *    считает он ровно ту же восстановленную историю, по которой пойдёт бой;
 * 3. **метка `assignment_history_dirty` снимается** тем, кто пересчитал состояние (К4, Р26): её
 *    ставят четыре ручки смен и ручная выписка, а снимает единственная revalidation внутри
 *    `ensure`, и до этой волны её никто не запускал;
 * 4. **восстановление из архива поднимает историю** (Р28) — через настоящий HTTP-путь, потому что
 *    предмет там как раз в порядке транзакции ручки: гейт, `lockRequestRow`, снятие архива и
 *    достройка одной транзакцией.
 *
 * ПОЧЕМУ ДЕНЬ РАСЧЁТА — СЕГОДНЯ, А СРОК НАЧИНАЕТСЯ ИМ ЖЕ. Ручка восстановления считает `asOf` по
 * часам и аргумента не принимает; чтобы оба пути мерили одним днём, его же берут и команды. Срок с
 * началом «сегодня» выбран не для удобства: он делает весь заказ изменяемой областью (Р21), и
 * команда проходит без коррекционных прав — то есть проверяется стык, а не матрица прав Р32,
 * которая разобрана своим файлом.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_wire \
 *     npx vitest run test/assignment-wire.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: учётка живёт вне откатываемой транзакции, а email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);
const ADMIN_EMAIL = `ap-wire-${RUN}@example.invalid`;
const ADMIN_PASSWORD = 'db-test-password-123';
/** Метка заявок файла: по ней же за собой и убирают — списком заведённого упавший прогон не помочь. */
const REQUEST_MARK = `ap-wire-${RUN}`;

/** День расчёта — сегодня по МСК: его же берёт ручка восстановления, аргумента у неё нет. */
const AS_OF = moscowDateKeyOf(new Date());
const TERM_FROM = AS_OF;
const TERM_TO = shiftDateKey(AS_OF, 13);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
  vehicleId: string;
  vehicleTypeId: string;
  personA: string;
  personB: string;
  command: typeof AssignmentCommand;
  crew: typeof AssignmentCrew;
}

let ctx: Ctx;

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/** Свой адрес на каждый запрос: вход ограничен попытками с одного IP. */
let requestNo = 0;
const nextAddress = (): string => {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
};

beforeAll(async () => {
  if (!DB_URL) return;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = DB_URL;
  process.env.NODE_ENV ??= 'test';
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

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }

  const { db, closeDb } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const one = async (query: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(query)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };

  const admin = await one(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active,
                       email_verified_at)
    VALUES (${ADMIN_EMAIL}, 'Связнов', 'Пров', '', ${await hashPassword(ADMIN_PASSWORD)}, 'admin',
            true, now())
    RETURNING id`);
  const object = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
  const vehicle = await one(sql`
    SELECT id, vehicle_type_id FROM vehicles
     WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 1`);
  const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
  // Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не зависит
  // (ADR 0164), но водителем справочника человек числится именно ею.
  const person = async (last: string): Promise<string> => {
    const row = await one(
      sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`,
    );
    await db.execute(sql`
      INSERT INTO person_specializations (person_id, specialization_id, started_on)
      VALUES (${row.id}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);
    return row.id!;
  };

  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);

  ctx = {
    app,
    db,
    closeDb,
    auth: { authorization: `Bearer ${login.json().accessToken}` },
    adminId: admin.id!,
    objectId: object.id!,
    vehicleId: vehicle.id!,
    vehicleTypeId: vehicle.vehicle_type_id!,
    personA: await person('Машинистов'),
    personB: await person('Сменщиков'),
    command: await import('../src/services/assignment-command'),
    crew: await import('../src/services/assignment-crew'),
  };
}, 180_000);

afterAll(async () => {
  if (ctx?.db) {
    /*
     * Файл убирает за собой сам: заявка ручки восстановления заводится вне транзакции (её порядок и
     * есть предмет случая), и за прогон в базе оседали бы заказы, бланки и события журнала. Уборка
     * идёт по метке, а не по списку заведённого: прибирать надо и за упавшим прогоном, который до
     * записи в список мог не дойти. Порядок обратен ссылкам — лист и рейс держат заказ `restrict`.
     */
    const ours = sql`SELECT id FROM vehicle_requests WHERE comment = ${REQUEST_MARK}`;
    await ctx.db.execute(sql`DELETE FROM waybills WHERE source_request_id IN (${ours})`);
    await ctx.db.execute(sql`DELETE FROM vehicle_route_requests WHERE request_id IN (${ours})`);
    await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE source_request_id IN (${ours})`);
    const ourCorrections = sql`
      SELECT id FROM waybill_corrections
       WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
    await ctx.db.execute(sql`
      DELETE FROM vehicle_request_corrections WHERE correction_id IN (${ourCorrections})`);
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ours})`);
    // Журнал коррекций держит учётку `restrict`: ремонт истории завёл в нём строку, и без неё
    // учётку файла не убрать. Строки истории на неё уже уехали каскадом вместе с заявкой.
    await ctx.db.execute(sql`DELETE FROM waybill_corrections WHERE id IN (${ourCorrections})`);
    await ctx.db.execute(sql`
      DELETE FROM audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    await ctx.db.execute(sql`
      DELETE FROM person_specializations
       WHERE person_id IN (${sql.raw(`'${ctx.personA}','${ctx.personB}'`)})`);
    await ctx.db.execute(sql`
      DELETE FROM persons WHERE id IN (${sql.raw(`'${ctx.personA}','${ctx.personB}'`)})`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
  }
  await ctx?.app.close();
  await ctx?.closeDb();
});

// ── Сцена ──

interface SceneOptions {
  /** Готовность истории в колонке заявки; по умолчанию — та, с какой заявка приезжает из миграции. */
  state?: 'empty' | 'materialized' | 'ready';
  /** Метка загрязнения внутри дня (К4). */
  dirty?: boolean;
  /** Строки истории; по умолчанию — ни одной: заявка заведена до модуля. */
  history?: {
    effectiveDate: string;
    dimension: 'vehicle' | 'driver';
    vehicleId?: string;
    driverPersonId?: string;
    driverState?: 'set' | 'cleared' | 'unknown';
    origin?: string;
  }[];
  archived?: boolean;
}

/** Заказ спецтехники в работе: собственная машина на весь срок и назначение — опора бэкфилла (§6). */
async function makeRequest(
  exec: { execute: SceneTx['execute'] },
  options: SceneOptions = {},
): Promise<string> {
  const state = options.state ?? 'empty';
  const [request] = (
    await exec.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                   created_by, assignment_history_state,
                                   assignment_history_validated_on, assignment_history_dirty,
                                   deleted_at, deleted_by)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleTypeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.adminId}, ${state},
              ${state === 'empty' ? null : AS_OF}, ${options.dirty ?? false},
              ${options.archived ? new Date().toISOString() : null},
              ${options.archived ? ctx.adminId : null})
      RETURNING id`)
  ).rows;
  const id = request!.id;
  await exec.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${id}, ${TERM_FROM}, ${TERM_TO})`);
  await exec.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${id}, ${ctx.vehicleId}, ${ctx.vehicleTypeId}, ${ctx.vehicleTypeId}, ${ctx.adminId})`);
  for (const row of options.history ?? []) {
    await exec.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES (${id}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
              ${row.driverPersonId ?? null}, ${row.driverState ?? null},
              ${row.origin ?? 'backfill'}, ${randomUUID()})`);
  }
  return id;
}

/** Сцена живёт в откатываемой транзакции, команда — в её `SAVEPOINT`: откат настоящий. */
async function inScene<T>(run: (tx: SceneTx) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      out = await run(tx);
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

/** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

const ADMIN: AccessSubject = { role: 'admin' };

function setBody(effectiveDate: string, driverPersonId: string): AssignmentCommandInput {
  return {
    kind: 'set',
    dimension: 'driver',
    version: 0,
    effectiveDate,
    driverPersonId,
  } as AssignmentCommandInput;
}

/** Предпросмотр — тем же колбэком `plan`, что и бой (§8). */
async function previewCrew(tx: SceneTx, requestId: string, input: AssignmentCommandInput) {
  const preview = await ctx.command.previewAssignmentCommand<AssignmentCrew.CrewPlan>(
    executorOf(tx),
    {
      requestId,
      actor: { id: ctx.adminId },
      asOf: AS_OF,
      plan: (planCtx) => ctx.crew.planCrewCommand(planCtx, input),
    },
  );
  return ctx.crew.crewPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
}

/** Провести команду через каркас — ровно тем же способом, каким её проводит боевая ручка. */
function runCrew(tx: SceneTx, requestId: string, input: AssignmentCommandInput) {
  return ctx.command.runAssignmentCommand<
    AssignmentCrew.CrewPlan,
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCrew.CrewPaper
  >(
    executorOf(tx),
    ctx.crew.crewCommandSpec({
      requestId,
      actor: { ...ADMIN, id: ctx.adminId },
      input,
      asOf: AS_OF,
    }),
  );
}

/** Тело боевой команды по посчитанному предпросмотру: отпечаток, разблокировки и envelope. */
function armed(
  body: AssignmentCommandInput,
  preview: { fingerprint: string; unlockFingerprint: string | null },
  reason: string,
): AssignmentCommandInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(preview.unlockFingerprint ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    operation: { operationId: randomUUID(), reason },
  } as AssignmentCommandInput;
}

interface Readiness {
  state: string;
  validated_on: string | null;
  dirty: boolean;
}

async function readinessOf(
  exec: { execute: SceneTx['execute'] },
  requestId: string,
): Promise<Readiness> {
  const [row] = (
    await exec.execute<Readiness>(sql`
      SELECT assignment_history_state AS state,
             assignment_history_validated_on AS validated_on,
             assignment_history_dirty AS dirty
        FROM vehicle_requests WHERE id = ${requestId}`)
  ).rows;
  return row!;
}

async function rowsOf(
  exec: { execute: SceneTx['execute'] },
  requestId: string,
): Promise<{ effective_date: string; dimension: string; origin: string }[]> {
  return (
    await exec.execute<{ effective_date: string; dimension: string; origin: string }>(sql`
      SELECT effective_date, dimension, origin FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} AND superseded_at IS NULL
       ORDER BY effective_date, dimension`)
  ).rows;
}

// ── 1. Дверь истории по заявке в `empty` (Ю48, Р20, Р26) ──

describe.skipIf(!DB_URL)('заявка в `empty` (Ю48)', () => {
  it('предпросмотр считает по восстановленной истории и не пишет ничего (Р20)', async () => {
    await inScene(async (tx) => {
      const requestId = await makeRequest(tx);

      const preview = await previewCrew(tx, requestId, setBody(AS_OF, ctx.personA));

      // Расчёт прошёл: значит дверь увидела историю, которой в базе нет вовсе.
      expect(preview.fingerprint).toBeTruthy();
      expect(preview.requiredAnchors).toEqual([]);
      // И не оставил ни строки, ни состояния — предпросмотр вызывается дважды подряд (Р16).
      expect(await rowsOf(tx, requestId)).toEqual([]);
      expect(await readinessOf(tx, requestId)).toMatchObject({
        state: 'empty',
        validated_on: null,
      });
    });
  });

  it('команда машиниста проходит, а не отказывает: история материализуется шагом 11', async () => {
    await inScene(async (tx) => {
      const requestId = await makeRequest(tx);
      const body = setBody(AS_OF, ctx.personA);
      const preview = await previewCrew(tx, requestId, body);

      const outcome = await runCrew(tx, requestId, armed(body, preview, 'назначен машинист'));

      expect(outcome.repeated).toBe(false);
      // Бэкфилл лёг вместе с командой: машина из назначения и решение о человеке — одной
      // транзакцией, и `origin` у них разный, потому что решения приняли разные стороны (§6).
      const rows = await rowsOf(tx, requestId);
      expect(rows.map((r) => `${r.dimension}:${r.origin}`)).toContain('vehicle:backfill');
      expect(rows.some((r) => r.origin === 'machinist_change')).toBe(true);
      // Выход из `empty` состоялся — ради него волна и затевалась.
      const readiness = await readinessOf(tx, requestId);
      expect(readiness.state).not.toBe('empty');
      expect(['ready', 'materialized']).toContain(readiness.state);
      expect(readiness.validated_on).toBe(AS_OF);
    });
  });

  it('невосстановимая история по-прежнему отказ, и отказ называет причину (§13)', async () => {
    await inScene(async (tx) => {
      const requestId = await makeRequest(tx);
      // Назначение — опора всех правил §6: из него берётся машина начала срока и хвоста. Без него
      // восстанавливать не от чего, и «как получится» здесь хуже, чем ничего.
      await tx.execute(sql`
        DELETE FROM vehicle_request_assignments WHERE request_id = ${requestId}`);

      const failure = await previewCrew(tx, requestId, setBody(AS_OF, ctx.personA)).then(
        () => null,
        (e: Error) => e,
      );

      expect(failure?.message).toMatch(/не восстановлена/);
      expect(failure?.message).toMatch(/не назначена техника/);
      expect(await readinessOf(tx, requestId)).toMatchObject({ state: 'empty' });
    });
  });
});

// ── 1a. Дверь ремонта: та же связка, но через настоящий HTTP-путь ──

describe.skipIf(!DB_URL)('ремонт истории по заявке в `empty` (Р25, Р29)', () => {
  it('предпросмотр показывает план, а команда чинит восстановленную историю', async () => {
    const requestId = await makeRequest(ctx.db);

    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair/preview`,
      headers: ctx.auth,
      payload: {
        mode: 'repair',
        version: 0,
        // Пробел ровно один и стоит на начале срока: бэкфилл не тянет человека назад — о тех днях
        // бумага молчит, и приписать им кого-нибудь значило бы уверенно утверждать неизвестное
        // (Р19, §6 п. 3).
        anchors: [{ effectiveDate: TERM_FROM, driverPersonId: ctx.personA }],
      },
    });

    expect(preview.statusCode, preview.body).toBe(200);
    const plan = preview.json<{
      fingerprint: string;
      unlockFingerprint: string | null;
      state: string;
      stateAfter: string;
      blockedDays: { from: string; to: string }[];
    }>();
    // Дверь увидела историю, которой в базе нет вовсе, — и назвала её состояние и её пробел.
    expect(plan.state).toBe('materialized');
    expect(plan.stateAfter).toBe('ready');
    expect(plan.blockedDays).not.toEqual([]);
    // ...и не записала ничего: ни строки истории, ни состояния (Р20).
    expect(await rowsOf(ctx.db, requestId)).toEqual([]);
    expect(await readinessOf(ctx.db, requestId)).toMatchObject({
      state: 'empty',
      validated_on: null,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/repair`,
      headers: ctx.auth,
      payload: {
        mode: 'repair',
        version: 0,
        anchors: [{ effectiveDate: TERM_FROM, driverPersonId: ctx.personA }],
        previewFingerprint: plan.fingerprint,
        ...(plan.unlockFingerprint ? { unlockFingerprint: plan.unlockFingerprint } : {}),
        operation: { operationId: randomUUID(), reason: 'история восстановлена и дополнена' },
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ state: string }>().state).toBe('ready');
    /*
     * Главное здесь — что якорь **заменил** строку бэкфилла, которой в момент расчёта не
     * существовало: `id` она получила тем же шагом 11 и на полшага раньше, а адресовалась логическим
     * ключом (Р10). Погашенная строка `unknown` и есть доказательство: не было бы её — якорь лёг бы
     * второй строкой на ту же дату и упёрся в частичный UNIQUE.
     */
    const [superseded] = (
      await ctx.db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM vehicle_request_assignment_changes
         WHERE request_id = ${requestId} AND origin = 'backfill' AND driver_state = 'unknown'
           AND superseded_kind = 'replaced'`)
    ).rows;
    expect(superseded!.n).toBe('1');
    expect(await readinessOf(ctx.db, requestId)).toEqual({
      state: 'ready',
      validated_on: AS_OF,
      dirty: false,
    });
  });
});

// ── 2. Метка загрязнения (К4, Р26) ──

describe.skipIf(!DB_URL)('метка `assignment_history_dirty` (К4)', () => {
  it('снимается пересчётом состояния, и снимает её тот, кто пересчитал', async () => {
    await inScene(async (tx) => {
      // История полна и валидна, но колонка про это «не знает»: внутри дня бумагу правили, и метку
      // подняла ручка смены, которая историю не пересчитывает.
      const requestId = await makeRequest(tx, {
        state: 'materialized',
        dirty: true,
        history: [
          { effectiveDate: TERM_FROM, dimension: 'vehicle', vehicleId: ctx.vehicleId },
          {
            effectiveDate: TERM_FROM,
            dimension: 'driver',
            driverState: 'set',
            driverPersonId: ctx.personA,
            origin: 'assignment',
          },
        ],
      });
      expect(await readinessOf(tx, requestId)).toMatchObject({ dirty: true });

      // Дата — начало срока, а не «через неделю»: до переключения чтения гейт этапа 3 требует,
      // чтобы старый недельный план совпал с новым отрезковым (Б1), и разрез внутри срока их
      // разводит. Здесь предмет другой — метка, — и лишний отказ гейта только мешал бы его видеть.
      const body = setBody(AS_OF, ctx.personB);
      const preview = await previewCrew(tx, requestId, body);
      // Предпросмотр метку не трогает: он не пересчитывал ничего, что стоило бы записать.
      expect(await readinessOf(tx, requestId)).toMatchObject({ dirty: true });

      await runCrew(tx, requestId, armed(body, preview, 'плановая смена машиниста'));

      // Пересчёт прошёл — и записался одной операцией: состояние, день проверки и снятая метка.
      expect(await readinessOf(tx, requestId)).toEqual({
        state: 'ready',
        validated_on: AS_OF,
        dirty: false,
      });
    });
  });
});

// ── 3. Восстановление из архива — дверь готовности (Р28) ──

describe.skipIf(!DB_URL)('восстановление из архива (Р28)', () => {
  it('снимает архив и достраивает историю одной транзакцией', async () => {
    const requestId = await makeRequest(ctx.db, { archived: true });
    expect(await readinessOf(ctx.db, requestId)).toMatchObject({ state: 'empty' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${requestId}/restore`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    // Архив снят — как и до волны.
    const [row] = (
      await ctx.db.execute<{ deleted_at: string | null }>(
        sql`SELECT deleted_at FROM vehicle_requests WHERE id = ${requestId}`,
      )
    ).rows;
    expect(row!.deleted_at).toBeNull();
    // ...и вернулась заявка уже с историей: архив сохраняет рабочий статус, и без достройки после
    // переключения чтения появилась бы живая «В работе» в состоянии `empty`.
    const readiness = await readinessOf(ctx.db, requestId);
    expect(readiness.state).not.toBe('empty');
    expect(readiness.validated_on).toBe(AS_OF);
    expect(await rowsOf(ctx.db, requestId)).not.toEqual([]);
  });

  it('невосстановимая история архив не запирает: заявка выходит, состояние остаётся `empty`', async () => {
    const requestId = await makeRequest(ctx.db, { archived: true });
    await ctx.db.execute(sql`
      DELETE FROM vehicle_request_assignments WHERE request_id = ${requestId}`);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${requestId}/restore`,
      headers: ctx.auth,
    });

    // Отказов эта дверь не добавляет: чинит такую историю ремонт, и держать заявку в архиве из-за
    // отсутствующего назначения значило бы запереть её без всякого способа выйти.
    expect(res.statusCode, res.body).toBe(200);
    expect(await readinessOf(ctx.db, requestId)).toMatchObject({ state: 'empty' });
  });

  it('грузоперевозку восстановление трогает как прежде: истории у неё нет вовсе (Р20)', async () => {
    const [request] = (
      await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                     created_by, deleted_at, deleted_by)
        VALUES ('freight_transport', ${ctx.objectId}, ${ctx.vehicleTypeId}, 'confirmed',
                ${REQUEST_MARK}, ${ctx.adminId}, ${new Date().toISOString()}, ${ctx.adminId})
        RETURNING id`)
    ).rows;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request!.id}/restore`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await readinessOf(ctx.db, request!.id)).toMatchObject({ state: 'empty' });
  });
});
