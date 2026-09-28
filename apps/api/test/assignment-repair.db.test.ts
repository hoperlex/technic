import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  esm2Periods,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  WAYBILL_ACK_REQUIRED_CODE,
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
 * THE FILE NEEDS ITS OWN DATABASE. Every command here takes the module's control row `FOR SHARE`
 * (step 0 of the canon), and the neighbouring files of the module change and freeze that same row
 * (plan Yu27, Yu30). On top of that, this file MOVES the row itself — most blocks run in both read
 * modes — so a shared database would sink the neighbours by a direct write, not merely by a race.
 * The database is created and dropped by `useReadModeDatabase`
 * ([assignment-read-mode.ts](assignment-read-mode.ts)); outside the two-mode blocks the mode stays
 * what migration `0167` brings, `legacy`.
 */

/**
 * The assignment-history repair door
 * ([assignment-repair.ts](../src/services/assignment-repair.ts),
 * [vehicle-request-assignment-repair.ts](../src/routes/vehicle-request-assignment-repair.ts);
 * plan `docs/assignment-periods-plan.md`, R16, R21, R26–R31; decisions C3, C4, X1, F1, Shch2,
 * E1–E3, Yu2).
 *
 * WHAT IS CHECKED HERE. None of these subjects is visible by reading the door's code:
 *
 * 1. **the conditional rights contract (R29, C3)** — the one part that can only be checked over
 *    HTTP with real roles: `waybills.correct` is asked by the COMPUTED outcome, not by the body's
 *    shape; deeper than thirty days adds `correctBeyondLimit`; an archived request opens BY ID
 *    WITHOUT `archive.read`, while `restore` stays an administrator's action;
 * 2. **readiness by R27** — a set comparison, not an invariant check: all blockers gone — `ready`,
 *    some left — `materialized`, a new one introduced — 422 and not a single write;
 * 3. **the known-fill planner and its cancellation** (F1, Shch1, Shch2, E1, Yu2) — four positions
 *    of a fill inside a gap, cancelling each, and the "cancel, then fill again starting earlier"
 *    cycle. These go through the pure planner, past the switch
 *    {@link AssignmentRepair.KNOWN_FILLS_ENABLED}: the logic is complete, and turning the feature
 *    off or on must remain one value, not a code change;
 * 4. **the switch itself** (X1) — it is the only condition, and an empty list never trips it;
 * 5. **the tail decision** (R31) — the dormant boundary valued by the assignment, its provenance
 *    and group, and the switch to `history_wins` in one transaction;
 * 6. **paper of a repaired history** (§10, stage 5) — `legacy` leaves paper to the weekly sync,
 *    which knows one machinist per request; `history` re-issues sheets by history segments;
 * 7. **the door against paper** — a fill and its cancellation, the tail decision, an archived
 *    request with `restore`, the per-sheet handshake (B4) and the keyed replay (R9), each asserting
 *    what happens to the strict-reporting blanks in both read modes. Cases marked DIVERGENCE there
 *    record where the code, as of this commit, does not do what the plan says.
 *
 * WHY ALMOST EVERYTHING RUNS IN BOTH READ MODES. The door always computes its paper plan and the
 * mode decides only whether step 12 executes it, so any case that reaches step 12 can differ
 * between the modes — and the earlier assumption that paperless scenes make the two halves
 * identical forever did not hold: in `history` the plan also MINTS blanks for repaired days that
 * never had paper, each under warnings that demand a signature (B4). The rights, readiness, tail
 * and replay cases of blocks 1, 2, 5 and 6 therefore run twice, sending the signatures the preview
 * asked for exactly as the portal window does (see `handshakeOf`); what the paper then looks like
 * is asserted in block 7, not there.
 *
 * WHAT STILL RUNS ONCE, AND WHY. Block 3 calls the planner and the write core inside a rolled-back
 * transaction and never reaches step 12, so the read mode cannot reach it either; block 4 is a
 * constant. Both would produce identical halves by construction, not by coincidence.
 *
 * WHY SOME CASES GO OVER HTTP AND SOME THROUGH THE SERVICE. Rights, fingerprint, idempotency and
 * step 12 live in the route (`syncPaper` of its command) and are checked only through it. The fill
 * rules live in a pure planner, and driving them through HTTP would test the plumbing around them
 * instead of the rules.
 *
 * Running (the database in the variable can be any — the file creates its own next to it and drops
 * it afterwards):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_repair \
 *     npx vitest run test/assignment-repair.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like every other `*.db.test.ts`.
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
/**
 * Периоды бумаги этого срока — тем же расчётом, каким режет портал (`esm2Periods`).
 *
 * Оговорка выше про «недельный календарь» остаётся в силе и этим не нарушается: границы сцены
 * по-прежнему заданы понедельниками руками, и разрез, которого ждут от двери, сцена себе не рисует.
 * Здесь считается другое — **сколько документов** прежняя сверка кладёт из этих границ, а это её
 * собственный ответ: лист режет не только воскресенье, но и конец месяца (ADR 0142), и две недели
 * дают то два листа, то три. Записанные цифрой, они краснели бы в последнюю неделю месяца без
 * всякой правки кода. Ровно так же считает свой состав соседний случай частичного ремонта.
 */
const PAPER_PERIODS = esm2Periods(PREV_MONDAY, PAPER_TO);
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
 * Работник с действующей специализацией водителя. Листу она больше не нужна (ADR 0164) — фамилию
 * в бланк печатает карточка человека, — но водителем справочника человек числится именно ею.
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
  /**
   * Линейный заказ (ADR 0100): бумагу неделями он не ведёт вовсе — недели называет человек.
   *
   * Ставится снимком (`is_linear_frozen`, миграция 0137), а не заведением своего типа техники:
   * режим заявки и так читается формулой `coalesce(is_linear_frozen, vehicle_types.is_linear)`
   * ([linear-mode.ts](../src/db/linear-mode.ts)), одной на весь портал, и снимок — её законная
   * половина. Заводить ради этого линейный тип значило бы трогать общий справочник, из которого
   * этот файл берёт машины по первому попавшемуся `ownership`.
   */
  linear?: boolean;
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
                                    assignment_history_validated_on, deleted_at, deleted_by,
                                    is_linear_frozen, linear_frozen_at)
      VALUES ('special_equipment', ${ctx.objectId}, ${assignment.typeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.admin.id}, ${state},
              ${state === 'empty' ? null : TODAY},
              ${options.archived ? new Date().toISOString() : null},
              ${options.archived ? ctx.admin.id : null},
              ${options.linear ? true : null}, ${options.linear ? sql`now()` : null})
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

/**
 * Лист ЭСМ-2 **по просьбе** — единственный способ, каким бумага заводится у линейного заказа
 * (ADR 0100 §5, §6): недели у него называет человек, а не срок заявки.
 *
 * Дверь зовётся сервисом, а не HTTP: предмет случая — что ремонт делает с **уже выписанным**
 * бланком, а путь, которым его выписали, к делу не относится. Рукопожатие (Р21а) при этом
 * повторено ровно то, что делает окно портала, — первый вызов без подтверждения, отказ со свежим
 * отпечатком, второй с ним: оно стоит в общей точке выпуска номера и спрашивается независимо от
 * двери, а у машиниста сцены комплект документов пуст.
 *
 * Возвращает выписанные листы: их бывает два, если неделю режет конец месяца (ADR 0142).
 */
async function issueOnDemand(
  requestId: string,
  weekOf: string,
  vehicleId: string,
  driverPersonId: string,
): Promise<Esm2.IssuedEsm2[]> {
  const guardedPeriods = await ctx.esm2.esm2OnDemandPeriods(ctx.db, { requestId, weekOf });
  const issue = (acknowledge: { fingerprint: string } | null): Promise<Esm2.IssuedEsm2[]> =>
    ctx.db.transaction(async (tx) =>
      ctx.esm2.issueEsm2OnDemand(tx, {
        requestId,
        weekOf,
        vehicleId,
        driverPersonId,
        actor: { id: ctx.admin.id },
        guardedPeriods,
        acknowledge,
      }),
    );
  let issued: Esm2.IssuedEsm2[];
  try {
    issued = await issue(null);
  } catch (error) {
    const fingerprint = (error as { details?: { fingerprint?: string } }).details?.fingerprint;
    if (!fingerprint) throw error;
    issued = await issue({ fingerprint });
  }
  // След подготовки из журнала — прочь, по той же причине, что и у недельной сверки сцены.
  await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${requestId}`);
  return issued;
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

/**
 * Подписи по листам с непустыми предупреждениями (Б4) — так их собирает и окно.
 *
 * Нужны там, где бумагу выпускает сам план (`read_mode = history`): у машинистов сцены документов
 * нет вовсе, и каждый выписываемый бланк уходит с предупреждением. В `legacy` дверь их не требует,
 * но присланные проверяет — набор один и тот же, и команда проходит в обоих режимах.
 */
const acknowledgementsOf = (
  issues: readonly { issueKey: number; warnings: unknown[]; warningFingerprint: string }[],
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => issue.warnings.length > 0)
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

/** Предупреждения предпросмотра — общая часть ответа двери (§7). */
type PreviewIssues = { issueKey: number; warnings: unknown[]; warningFingerprint: string }[];

/** The repair preview fields the cases read. */
interface RepairPreview {
  fingerprint: string;
  unlockFingerprint: string | null;
  requiredUnlocks: { waybillId: string }[];
  paperFree: boolean;
  restoreRequired: boolean;
  archived: boolean;
  state: string;
  stateAfter: string;
  operationRequirement: { kind: string; reasonRequired: boolean } | null;
  fillableGaps: { from: string; to: string }[];
  requiredAnchors: { effectiveDate: string; from: string; to: string }[];
  blockedDays: { from: string; to: string }[];
  plan: {
    cancel: { waybillId: string }[];
    issue: { from: string; to: string; vehicleId: string; driverPersonId: string }[];
  };
  issues: PreviewIssues;
}

/**
 * Handshake part of a command body, built from the preview the way the portal window builds it:
 * the fingerprint of the consequences, the unlock fingerprint when the server asked for one, and a
 * signature per warned sheet (B4).
 *
 * Signatures are sent in both read modes on purpose. In `history` the door issues the blanks from
 * this very plan and demands them; in `legacy` it does not demand them but still checks the ones
 * it gets — so one body passes in both worlds, and a case whose subject is rights or readiness is
 * not silently turned into a case about signatures. An unrequested `unlockFingerprint`, on the
 * other hand, is a 422 of its own (see "лишнее подтверждение разблокировок").
 */
const handshakeOf = (dto: RepairPreview) => ({
  previewFingerprint: dto.fingerprint,
  ...(dto.unlockFingerprint ? { unlockFingerprint: dto.unlockFingerprint } : {}),
  acknowledgements: acknowledgementsOf(dto.issues),
});

/** A preview's planned blanks by composition — the same shape as `compositionOf` below. */
const planIssueOf = (dto: RepairPreview): string[] =>
  dto.plan.issue.map(
    (sheet) => `${sheet.from}|${sheet.to}|${sheet.vehicleId}|${sheet.driverPersonId}`,
  );

/**
 * Expected composition of a range: the portal's own cut of it (weeks and month ends, ADR 0142),
 * one vehicle, one person. Counted by `esm2Periods`, never written out by hand, for the reason
 * `PAPER_PERIODS` gives.
 */
const periodsOf = (from: string, to: string, vehicleId: string, personId: string): string[] =>
  esm2Periods(from, to).map((period) => `${period.from}|${period.to}|${vehicleId}|${personId}`);

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

// ── 1. The conditional rights contract (R29, C3) ──

describeReadModes(readMode, 'права двери ремонта — условный контракт (Р29)', () => {
  it('исторический якорь требует waybills.correct: менеджеру 403, диспетчеру и админу — да', async () => {
    if (!DB_URL) return;
    const scene = await makeScene();
    const body = {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
      operation: operation('Восстанавливаем машиниста по табелю'),
    };

    // The preview computes the same consequences and asks no rights: a 403 in the middle of an
    // operation is worse than a refusal before it, and there is no right to forbid looking.
    const preview = await previewRepair(ctx.manager, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<RepairPreview>();
    expect(dto.operationRequirement).toEqual({
      kind: 'crew',
      reasonRequired: true,
      operationIdRequired: true,
    });

    const denied = await postRepair(ctx.manager, scene.requestId, { ...body, ...handshakeOf(dto) });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(await rowsOf(scene.requestId)).toHaveLength(2);

    const allowed = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      operation: operation('Восстанавливаем машиниста по табелю'),
      ...handshakeOf(dto),
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
    const dto = preview.json<RepairPreview>();

    const denied = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      ...handshakeOf(dto),
      operation: operation('Миграционный долг'),
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ message: string }>().message).toMatch(/администратор/i);

    const allowed = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      ...handshakeOf(dto),
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

    // The dispatcher has no `archive.read` and by decision 8 never will: the door lets them reach
    // an archived request by id, without showing the archive in lists or search.
    const preview = await previewRepair(ctx.dispatcher, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<RepairPreview>();
    expect(dto.archived).toBe(true);
    // Paper-free is decided by the computed plan, not by the archive flag: this request's plan is
    // non-empty (the repaired days still want blanks), so a repair without restore is refused.
    expect(dto.restoreRequired).toBe(true);

    const withoutRestore = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      ...handshakeOf(dto),
      operation: operation('Ремонт архива'),
    });
    expect(withoutRestore.statusCode, withoutRestore.body).toBe(422);
    expect(withoutRestore.json<{ message: string }>().message).toMatch(/восстановлен/i);

    // `restore` stays an administrator's action — the other half of the C3 deviation. The
    // fingerprint comes from a preview of the SAME body: `restore` is part of the consequences, and
    // reusing the previous preview's fingerprint would yield a 409 instead of the 403 under test.
    const restorePreview = await previewRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      restore: true,
    });
    expect(restorePreview.statusCode, restorePreview.body).toBe(200);
    const dispatcherRestore = await postRepair(ctx.dispatcher, scene.requestId, {
      ...body,
      restore: true,
      ...handshakeOf(restorePreview.json<RepairPreview>()),
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
      ...handshakeOf(adminPreview.json<RepairPreview>()),
      operation: operation('Ремонт архива'),
    });
    expect(adminRestore.statusCode, adminRestore.body).toBe(200);
    const after = await requestState(scene.requestId);
    // One transaction: the archive is lifted and the history repaired together; a half outcome
    // does not exist (R29).
    expect(after.deleted_at).toBeNull();
    expect(after.state).toBe('ready');
  });
});

// ── 2. Readiness by R27 ──

describeReadModes(readMode, 'готовность истории (Р26, Р27)', () => {
  it('снятый блокер даёт ready, оставшийся — materialized', async () => {
    if (!DB_URL) return;
    const mid = shiftDateKey(TODAY, 3);
    const scene = await makeScene({
      history: [
        { effectiveDate: NEAR_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        { effectiveDate: NEAR_FROM, dimension: 'driver', driverState: 'unknown' },
        // A second, independent blocker: an own-vehicle segment with the machinist cleared (R16).
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
    const dto = preview.json<RepairPreview>();
    // The preview names both boundaries: they are repaired one at a time, and the second does not
    // lock the first.
    expect(dto.requiredAnchors.map((a) => a.effectiveDate).sort()).toEqual([NEAR_FROM, mid].sort());
    expect(dto.stateAfter).toBe('materialized');
    expect(dto.blockedDays.length).toBeGreaterThan(0);

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...partial,
      ...handshakeOf(dto),
      operation: operation('Первый из двух пробелов'),
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const half = await requestState(scene.requestId);
    // The partial repair is written and the state stays `materialized`: a command is obliged
    // neither to fix nor to worsen somebody else's blocker.
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
      ...handshakeOf(secondPreview.json<RepairPreview>()),
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
      // Same day, different cause: comparing by days alone would pass this off as a partial repair.
      { date: '2026-01-01', kind: 'cleared' as const },
    ];
    expect(() => ctx.repair.repairHistoryState(before, after)).toThrowError(/новые пробелы/);
    expect(ctx.repair.repairHistoryState(before, before)).toBe('materialized');
    expect(ctx.repair.repairHistoryState(before, [])).toBe('ready');
    // A blocker spreading to a neighbouring day is a new pair and is caught by the same comparison.
    expect(() =>
      ctx.repair.repairHistoryState(before, [...before, { date: '2026-01-02', kind: 'unknown' }]),
    ).toThrowError(/новые пробелы/);
  });

  it('`unknown` в заблокированном прошлом блокером не является, а mismatch хвоста — тем более (Р30)', async () => {
    if (!DB_URL) return;
    // The term is over: no mutable days, hence no blockers — while the tail disagrees with the
    // assignment. R30: that is a warning, not a blocker.
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
    // The same `unknown` of locked past is a fill address, not an anchor's (C4).
    expect(dto.fillableGaps).toEqual([{ from: DEEP_FROM, to: shiftDateKey(TODAY, -10) }]);
  });

  /*
   * Inspection (sub-stage 6a). The portal window has to ask "what to repair" before naming any
   * work: which `unknown` gaps are locked and addressed by a fill, and which are fixed by anchors,
   * only the server knows. The preview cannot answer it — its body is deliberately the command's
   * body and admits no emptiness.
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
    // Inspection promises nothing: the state after equals the state before, the paper plan is empty.
    expect(dto.stateAfter).toBe(dto.state);
    expect(dto.plan.cancel).toEqual([]);
    expect(dto.plan.issue).toEqual([]);
    // And writes nothing: the history rows are the ones there were before the request.
    expect(await rowsOf(scene.requestId)).toEqual(before);
  });

  /*
   * A complete history is an answer, not a refusal. The door used to answer `ready` with 422
   * "nothing to repair", and a window opened to cancel a fill could not even list the fills made.
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

    // The same request with a repair body is a lawful refusal: a complete history has nothing to fix.
    const refused = await previewRepair(ctx.admin, scene.requestId, {
      mode: 'repair',
      version: 0,
      anchors: [{ effectiveDate: shiftDateKey(TODAY, -3), driverPersonId: ctx.personB }],
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ code: string }>().code).toBe('assignment_history_ready');
  });
});

// ── 3. The mechanical switch of known fills (X1, C4) ──

describe('заполнение `unknown` открыто (Х1, Ц4)', () => {
  /*
   * Accounting approved issuing blanks retroactively (§15 item 16, owner's decision of
   * 24.08.2026), and the switch was flipped. The cases that used to stand here were refusals and
   * thus checks of the flag; the work itself is now checked in both read modes by the block
   * "заполнение unknown и его отмена против бумаги" below, since what a fill does to paper is
   * exactly what the read mode decides.
   *
   * The switch has not gone anywhere: rolling the feature back is still one value. The case below
   * guards that property, not the current position of the switch.
   */
  it('рубильник остался единственным условием: пустой список отказа не образует', () => {
    if (!DB_URL) return;
    expect(ctx.repair.KNOWN_FILLS_ENABLED).toBe(true);
    // An empty list is not a fill: refusing it "just in case" would be wrong in either position
    // of the switch.
    expect(() => ctx.repair.assertKnownFillsAllowed(undefined)).not.toThrow();
    expect(() => ctx.repair.assertKnownFillsAllowed([])).not.toThrow();
  });
});

// ── 4. Fill and cancel rules — past the switch (F1, Shch1, Shch2, E1, Yu2) ──

/*
 * One run on purpose: these cases call the planner and the write core directly and stop before
 * step 12, which is the only place the read mode is consulted. What the same fill and cancel do to
 * paper through the door is block 7's subject, in both modes.
 */
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

// ── 5. The tail decision (R31) ──

describeReadModes(readMode, 'решение расхождения хвоста (Р31)', () => {
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
    // A dormant decision leaves paper alone yet requires a journal operation: it amends a decision
    // already taken and has to be explained (R32).
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
    // R17, exception 1: the decision leaves the assignment and the rates alone — they are already
    // its own.
    expect(assignment!.vehicle_id).toBe(ctx.ownVehicleB.id);
    // The request was `ready` and stays so: a tail mismatch does not touch readiness (R30).
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
    // R17 `follow`: the assignment must show the history's tail, and the core checked that against
    // the live state.
    expect(assignment!.vehicle_id).toBe(ctx.ownVehicle.id);
  });

  /*
   * Yu51: the refusal names the STATE OF THE REQUEST, not a term of the plan. The word "tail" means
   * nothing to a person at the window — a request has an end of term and the machine it is booked
   * to after it.
   */
  it('расхождения нет — отказ говорит, что история и назначение сошлись, а не «хвост согласован»', async () => {
    if (!DB_URL) return;
    // The assignment names the very machine the history runs: there is nothing to choose from.
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

// ── 6. Admission, fingerprint and replay ──

describeReadModes(readMode, 'допуск, отпечаток и повтор', () => {
  it('состояние `empty` дверь не пускает, `ready` — только ради хвоста (Р29)', async () => {
    if (!DB_URL) return;
    /*
     * Wave 3.5 wired the lazy backfill: the door no longer refuses an `empty` request with a live
     * assignment — the computation restores the history and admits the repair (checked by
     * `assignment-wire.db.test.ts`). The refusal remains where there is NOTHING to restore from:
     * without an assignment the backfill has no footing (R20), and the door names the reason.
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
   * Yu51: the refusal speaks of the PERSON'S ACTION, not of a request field. "There are no unlocks,
   * yet the body confirms some" answered a question the person never asked.
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
      ...handshakeOf(preview.json<RepairPreview>()),
      unlockFingerprint: 'подтверждение, которого не просили',
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/подтверждать нечего/);
    // The command did not go through: the history is the one the scene built.
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
    const payload = { ...body, ...handshakeOf(preview.json<RepairPreview>()) };
    const first = await postRepair(ctx.admin, scene.requestId, payload);
    expect(first.statusCode, first.body).toBe(200);
    const version = first.json<{ version: number }>().version;

    // Same key, same body: no work happens the second time and the version does not move (R9).
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
      ...handshakeOf(preview.json<RepairPreview>()),
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
    expect(compositionOf(before)).toEqual(
      PAPER_PERIODS.map(
        (period) => `${period.from}|${period.to}|${ctx.ownVehicle.id}|${ctx.personA}`,
      ),
    );

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
      issues: PreviewIssues;
    }>();
    /*
     * Предпросмотр в обоих режимах **одинаков**, и это утверждение, а не совпадение: план листов
     * дверь считает всегда — им отвечают на «paper-free ли ремонт» (Р29) и им же называют листы,
     * которые операция обязана разблокировать поимённо (Р11). Режим решает не «считать ли», а
     * «исполнять ли».
     */
    expect(dto.paperFree).toBe(false);
    expect(dto.stateAfter).toBe('ready');
    // Отработанное заперто (Р21) и потому названо поимённо; неоконченное — нет. Перечень выводится
    // тем же правилом, каким его считает портал (`canCancelWaybill`): в переходную неделю
    // отработанным успевает стать и августовский кусок текущей (ADR 0142), а не только прошлая.
    expect(dto.requiredUnlocks.map((sheet) => sheet.waybillId)).toEqual(
      before.filter((sheet) => sheet.period_to < TODAY).map((sheet) => sheet.id),
    );
    expect(dto.unlockFingerprint).not.toBeNull();

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: dto.fingerprint,
      unlockFingerprint: dto.unlockFingerprint!,
      acknowledgements: acknowledgementsOf(dto.issues),
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
       * После переключения тот же ремонт переоформляет весь срок: история говорит, что работал
       * сменщик, — бумага обязана говорить то же. Границы документов при этом те же самые, что и
       * были, и потому проверяется СОСТАВ: сменился человек, а не количество документов.
       *
       * Прошлая неделя выписывается заново законно: её лист гасит **эта же** сверка, названная
       * поимённо разблокировкой (Р11, Ю84), — дырой в прошлом такая выписка не является.
       */
      history: {
        composition: PAPER_PERIODS.map(
          (period) => `${period.from}|${period.to}|${ctx.ownVehicle.id}|${ctx.personB}`,
        ),
        burned: before.map((sheet) => sheet.id).sort(),
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
      // Сгорело и выписалось столько документов, сколько портал режет из срока, — не «два».
      expect(events[0]!.metadata.issued).toHaveLength(PAPER_PERIODS.length);
      expect(events[0]!.metadata.cancelled).toHaveLength(PAPER_PERIODS.length);
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
      issues: PreviewIssues;
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
      acknowledgements: acknowledgementsOf(dto.issues),
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
       *
       * ПОЧЕМУ СОСТАВ СЧИТАЕТСЯ, А НЕ ПИШЕТСЯ ДВУМЯ СТРОКАМИ. Предмет случая — **границы отрезка**:
       * бумага начинается там же, где починенная история (`PREV_MONDAY`), и обрывается последним
       * днём, у которого машинист известен (`TODAY`). Эти две даты сцена по-прежнему называет
       * сама, и проверять было бы нечего, считай она их из ответа портала. А вот сколько
       * документов выходит из отрезка — ответ портала, и он же ADR 0142: месяц режет отрезок так
       * же, как воскресенье. Пара строк «прошлая неделя целиком + понедельник…сегодня» это молча
       * отрицала и была верна ровно до того дня, когда отрезок наехал на первое число: 31 августа
       * он был однодневным и совпадал, 1 сентября разошёлся на «31–31 августа» и «1–1 сентября».
       * Перебором по трёхлетию таких дней 317 из 1095 — почти каждый третий.
       */
      history: {
        composition: esm2Periods(PREV_MONDAY, TODAY).map(
          (period) => `${period.from}|${period.to}|${ctx.ownVehicle.id}|${ctx.personB}`,
        ),
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
  it('линейный заказ: ремонт истории не трогает бланк, выписанный по просьбе', async () => {
    if (!DB_URL) return;
    /*
     * ДЫРА ТРЕТЬЕЙ ДВЕРИ (класс Э10 плана `docs/vehicle-request-actual-end-date-plan.md`, раздел 7).
     *
     * Отрезковый план листов выводит ожидания **из разреза состава**, и для линейного заказа это
     * неверно: недели у него называет человек при выписке (ADR 0100 §5), а разрез о них не знает
     * ничего. Хуже того, разреза с человеком у линейного заказа не бывает вовсе — машиниста
     * называют на каждый лист отдельно (ADR 0100 §6), и бэкфилл честно оставляет ему **одну**
     * строку истории: машину с начала срока и ни слова о человеке
     * ([assignment-ensure.ts](../src/services/assignment-ensure.ts), правило 1). Отрезок без
     * человека бумаги не ожидает (`wantedSheets`) — значит ожиданий не остаётся ни на один день, и
     * план получается «погасить всё выписанное». То есть сжечь номера строгой отчётности за
     * недели, которые человек просил сам.
     *
     * Сцена сталкивает это в самой безобидной команде двери: решение о машине после конца срока
     * (Р31) пишет **дремлющую** границу — строку за концом срока, не трогающую внутри него ни
     * одного дня. Бумаге здесь меняться не от чего ни при каком режиме, и если она всё-таки
     * гаснет, то не от команды, а от того, что план посчитан чужим правилом.
     *
     * ОЖИДАНИЕ ОДНО НА ОБА РЕЖИМА, и это утверждение, а не сэкономленный `byReadMode`. У `on_demand`
     * бумага не зависит от истории вовсе: набор недель задан просьбой человека и хранится в самих
     * листах. Значит и переключение чтения (§10) здесь ничего не переключает — ремонт истории
     * линейного заказа обязан быть бумажно пустым и до cutover, и после. Красным без починки
     * случай при этом бывает по-разному: в `legacy` врёт предпросмотр (`paperFree`, список
     * гашений), в `history` к нему добавляется исполненное шагом 12 аннулирование.
     */
    const scene = await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: PAPER_TO,
      linear: true,
      // Назначение — машина B, история ведёт машину A: расхождение хвоста (Р31), которое дверь и
      // чинит. Дремлющая граница ляжет за концом срока значением назначения.
      assignment: ctx.ownVehicleB,
      // История ровно та, какую линейному заказу оставляет бэкфилл: одна vehicle-строка и ни одной
      // driver-строки. Дописать сюда машиниста значило бы собрать заказ, которого не бывает.
      history: [{ effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id }],
      state: 'ready',
    });
    // Бланк на текущую неделю — тот самый, который человек попросил сам. Он ещё не отработан
    // (`period_to >= сегодня`), то есть отменяем: неприкосновенность прошлого его не защищает, и
    // остановить гашение может только верно посчитанный план.
    const requested = await issueOnDemand(scene.requestId, TODAY, ctx.ownVehicle.id, ctx.personA);
    expect(requested.length).toBeGreaterThan(0);
    const before = await sheetsOf(scene.requestId);
    expect(compositionOf(before)).toHaveLength(before.length);

    const body = { mode: 'repair', version: 0, tailResolution: { kind: 'assignment_wins' } };
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<{
      fingerprint: string;
      paperFree: boolean;
      plan: { cancel: { waybillId: string }[]; issue: unknown[] };
    }>();
    /*
     * Предпросмотр — половина предмета: он показывается человеку, хешируется отпечатком и им же
     * решается, спрашивать ли право и причину за переоформление бумаги (Р29). Пустой план здесь
     * означает ровно то, что должен: ремонт истории линейного заказа бумаги не касается.
     */
    expect(dto.plan.cancel).toEqual([]);
    expect(dto.plan.issue).toEqual([]);
    expect(dto.paperFree).toBe(true);

    const applied = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      previewFingerprint: dto.fingerprint,
      operation: operation('Дальше за заявкой числится машина назначения'),
    });
    expect(applied.statusCode, applied.body).toBe(200);
    // Граница написана — команда действительно исполнилась, и пустота бумаги ниже не от того, что
    // дверь отказала.
    expect(
      actual(await rowsOf(scene.requestId)).some((row) => row.origin === 'tail_resolution'),
    ).toBe(true);

    /*
     * Вторая половина предмета: шаг 12. Бланк остался собой — тем же номером, теми же границами,
     * той же машиной и тем же человеком, — сгоревших нет, и события сверки не случилось вовсе.
     */
    const after = await sheetsOf(scene.requestId);
    expect(compositionOf(after)).toEqual(compositionOf(before));
    expect(burnedOf(after)).toEqual([]);
    expect(await esm2EventsOf(scene.requestId)).toHaveLength(0);
  });
});

// ── 7. The repair door against paper, in both read modes (X1, F1, E1, R29, R31, B4, R9) ──
//
// Everything below runs twice. The door always COMPUTES the paper plan (it answers "is this repair
// paper-free", R29, and names the sheets the operation must unlock, R11); the read mode decides
// only whether step 12 EXECUTES it. So every case asserts the same command in both worlds and
// states, per mode, what happened to the strict-reporting blanks.
//
// Cases marked DIVERGENCE document where the code, as of this commit, does not do what the plan
// (`docs/assignment-periods-plan.md`) says. They assert what the code does, not what the plan
// wants, so the suite stays a faithful record rather than a wish list; the comment names the plan
// rule, and whoever fixes the code must flip the marked assertions together with it.

/**
 * Provenance of every sheet of the request: which journal operation minted it, which one burned
 * it, and why. The composition helpers above answer "what the paper says"; these columns answer
 * "who is accountable for it", which is the whole point of issuing strict-reporting blanks
 * retroactively through the correction journal (F1, R21).
 */
async function provenanceOf(requestId: string) {
  return (
    await ctx.db.execute<{
      id: string;
      period_from: string;
      period_to: string;
      vehicle_id: string;
      driver_person_id: string;
      status: string;
      correction_id: string | null;
      correction_reason: string;
      cancel_correction_id: string | null;
    }>(sql`
      SELECT id, period_from, period_to, vehicle_id, driver_person_id, status, correction_id,
             correction_reason, cancel_correction_id
        FROM waybills WHERE source_request_id = ${requestId}
       ORDER BY period_from, id`)
  ).rows;
}

/** The journal row of an operation, looked up by the idempotency key the body carried. */
async function journalRowOf(operationId: string) {
  const rows = (
    await ctx.db.execute<{
      id: string;
      kind: string;
      reason: string;
      authorization_scope: { requiresCorrect: boolean; requiresCorrectBeyondLimit: boolean };
    }>(sql`
      SELECT id, kind, reason, authorization_scope FROM waybill_corrections
       WHERE operation_id = ${operationId}`)
  ).rows;
  // One key, one row: a second row would mean the replay did the work twice (R9).
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Portal events of the request by action, oldest first. */
async function auditActionsOf(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log WHERE entity_id = ${requestId} ORDER BY created_at, id`)
  ).rows.map((row) => row.action);
}

/*
 * The fill scene: a term lying wholly in locked past, the machine known, the person not, and no
 * paper at all — the normal backfill outcome where no blank was ever issued (F1). The fill covers
 * the head of the gap and leaves a tail, so both rows of a fill group get written (Sh4).
 */
const GAP_TO = shiftDateKey(TODAY, -10);
const FILL_TO = shiftDateKey(TODAY, -30);

const gapHistory = (): NonNullable<SceneOptions['history']> => [
  { effectiveDate: DEEP_FROM, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
  { effectiveDate: DEEP_FROM, dimension: 'driver', driverState: 'unknown' },
];

const fillBody = (reason: string) => ({
  mode: 'repair',
  version: 0,
  knownFills: [{ from: DEEP_FROM, to: FILL_TO, personId: ctx.personA }],
  operation: operation(reason),
});

/*
 * The paper scene shared by the handshake, replay and archive cases: two weeks of weekly paper
 * on one person, and a repair that names somebody else from the first day. In `history` it
 * re-issues every sheet of the term, each with warnings (the scene's people carry no documents),
 * which is exactly what makes the per-sheet handshake load-bearing.
 */
const paperScene = (options: Pick<SceneOptions, 'archived'> = {}) =>
  makeScene({
    dateFrom: PREV_MONDAY,
    dateTo: PAPER_TO,
    history: [
      { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
      { effectiveDate: PREV_MONDAY, dimension: 'driver', driverState: 'unknown' },
    ],
    issueSheets: { driverPersonId: ctx.personA },
    ...options,
  });

const anchorBody = (reason: string) => ({
  mode: 'repair',
  version: 0,
  anchors: [{ effectiveDate: PREV_MONDAY, driverPersonId: ctx.personB }],
  operation: operation(reason),
});

describeReadModes(
  readMode,
  'заполнение unknown и его отмена против бумаги (Х1, Ф1, Э1)',
  (mode) => {
    it('заполнение дыры без бумаги: отпечаток обязателен, в history бланки выписываются задним числом', async () => {
      if (!DB_URL) return;
      const scene = await makeScene({ dateFrom: DEEP_FROM, dateTo: GAP_TO, history: gapHistory() });
      const body = fillBody('Нашли табель');

      /*
       * The fill used to be posted blind (no preview fingerprint) and the case accepted `[200, 409]`,
       * returning early on 409 — which is what it always got, so the write path of a fill was never
       * asserted. The repair door declares no `requiresPreview`, so step 7 falls back to the
       * framework default: any command with history mutations must carry the fingerprint.
       */
      const blind = await postRepair(ctx.admin, scene.requestId, body);
      expect(blind.statusCode, blind.body).toBe(409);
      expect(blind.json<{ code: string }>().code).toBe('assignment_preview_stale');
      expect(await rowsOf(scene.requestId)).toHaveLength(2);

      const preview = await previewRepair(ctx.admin, scene.requestId, body);
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<RepairPreview>();
      // A fill touches locked history, so its outcome is `crew` (R29, R32) in both modes.
      expect(dto.operationRequirement).toMatchObject({ kind: 'crew' });
      expect(dto.stateAfter).toBe('ready');
      expect(dto.unlockFingerprint).toBeNull();
      expect(dto.plan.cancel).toEqual([]);
      // The preview is mode-independent: it promises one blank per portal period of the filled days.
      const filled = periodsOf(DEEP_FROM, FILL_TO, ctx.ownVehicle.id, ctx.personA);
      expect(planIssueOf(dto)).toEqual(filled);
      expect(dto.issues.some((issue) => issue.warnings.length > 0)).toBe(true);
      /*
       * DIVERGENCE (R29, contract `RepairPreviewDto.paperFree`: "is the paper plan empty"): the
       * preview reports `paperFree: true` while its own plan issues blanks. `paperFree` is taken from
       * the probe plan, which has neither unlocks nor the correction permit, and a probe cannot see
       * work that lies wholly in the locked past. The archive case below shows what this costs.
       */
      expect(dto.paperFree).toBe(true);

      const applied = await postRepair(ctx.admin, scene.requestId, {
        ...body,
        ...handshakeOf(dto),
      });
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json<{ state: string; version: number }>()).toMatchObject({
        state: 'ready',
        version: 1,
      });

      // History is written the same way in both modes: `set` replaces the backfill row on `from`
      // (Shch2) and the remainder boundary lands on `to + 1`; both carry the operation (Shch3).
      const journal = await journalRowOf(body.operation.operationId);
      expect(journal).toMatchObject({ kind: 'crew', reason: 'Нашли табель' });
      expect(journal.authorization_scope).toMatchObject({
        requiresCorrect: true,
        requiresCorrectBeyondLimit: true,
      });
      const rows = await rowsOf(scene.requestId);
      const replaced = rows.find((row) => row.origin === 'backfill' && row.dimension === 'driver')!;
      expect(replaced.superseded_kind).toBe('replaced');
      const fill = actual(rows).filter((row) => row.correction_id === journal.id);
      expect(fill.map((row) => [row.effective_date, row.origin, row.driver_person_id])).toEqual([
        [DEEP_FROM, 'known_fill', ctx.personA],
        [shiftDateKey(FILL_TO, 1), 'unknown_remainder', null],
      ]);

      const sheets = await provenanceOf(scene.requestId);
      const events = await esm2EventsOf(scene.requestId);
      if (mode === 'legacy') {
        // The weekly sync owns legacy paper and knows nothing of fills: no blank, no event.
        expect(sheets).toEqual([]);
        expect(events).toHaveLength(0);
        return;
      }
      // History: every missing blank is minted retroactively, under the fill's own operation and
      // reason, and one strict sync event names all the new numbers (F1, R35).
      expect(compositionOf(await sheetsOf(scene.requestId))).toEqual(filled);
      expect(sheets.every((sheet) => sheet.status === 'issued')).toBe(true);
      expect(sheets.every((sheet) => sheet.correction_id === journal.id)).toBe(true);
      expect(sheets.every((sheet) => sheet.correction_reason === 'Нашли табель')).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata.reason).toBe('Нашли табель');
      expect(events[0]!.metadata.cancelled).toEqual([]);
      expect(new Set(events[0]!.metadata.issued).size).toBe(filled.length);
    });

    it('отмена заполнения: в history гаснут только бланки, не совпавшие с неделей дыры (Э2)', async () => {
      if (!DB_URL) return;
      const scene = await makeScene({ dateFrom: DEEP_FROM, dateTo: GAP_TO, history: gapHistory() });
      const fill = fillBody('Нашли табель');
      const fillPreview = (
        await previewRepair(ctx.admin, scene.requestId, fill)
      ).json<RepairPreview>();
      const filled = await postRepair(ctx.admin, scene.requestId, {
        ...fill,
        ...handshakeOf(fillPreview),
      });
      expect(filled.statusCode, filled.body).toBe(200);
      const minted = await provenanceOf(scene.requestId);
      expect(minted).toHaveLength(
        byReadMode(mode, { legacy: 0, history: fillPreview.plan.issue.length }),
      );

      const group = actual(await rowsOf(scene.requestId)).find(
        (row) => row.origin === 'known_fill',
      )!.change_group_id;
      const body = {
        mode: 'cancel_fill',
        version: filled.json<{ version: number }>().version,
        target: { changeGroupId: group },
        operation: operation('Табель оказался от другой машины'),
      };
      const preview = await previewRepair(ctx.admin, scene.requestId, body);
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<RepairPreview>();
      // Retracting a claim about the past is a correction of the past (R13, E2).
      expect(dto.operationRequirement).toMatchObject({ kind: 'crew' });
      expect(dto.plan.issue).toEqual([]);

      /*
       * After the cancel the gap is `unknown` again, and an `unknown` day accepts any printed person
       * (R19, `sheetMatchesWanted`). So a minted blank survives whenever its period coincides with a
       * portal period of the restored gap, and burns only when the fill's own end cut it short.
       */
      const gapPeriods = esm2Periods(DEEP_FROM, GAP_TO);
      const cutShort = minted
        .filter(
          (sheet) =>
            !gapPeriods.some((p) => p.from === sheet.period_from && p.to === sheet.period_to),
        )
        .map((sheet) => sheet.id);
      expect(dto.plan.cancel.map((sheet) => sheet.waybillId)).toEqual(cutShort);
      // Every minted blank is locked past and lies in the command's paper scope, so all of them must
      // be unlocked by name — even the ones the plan then keeps.
      expect(dto.requiredUnlocks.map((sheet) => sheet.waybillId)).toEqual(
        minted.map((sheet) => sheet.id),
      );

      const res = await postRepair(ctx.admin, scene.requestId, { ...body, ...handshakeOf(dto) });
      expect(res.statusCode, res.body).toBe(200);
      // The fill group is gone and the left edge keeps an `unknown` row: nothing on the left of the
      // term was `unknown`, so without it the fold would carry no claim at all (Shch2).
      const driverRows = actual(await rowsOf(scene.requestId)).filter(
        (row) => row.dimension === 'driver',
      );
      expect(driverRows.map((row) => [row.effective_date, row.driver_state, row.origin])).toEqual([
        [DEEP_FROM, 'unknown', 'unknown_remainder'],
      ]);

      const after = await provenanceOf(scene.requestId);
      const events = await esm2EventsOf(scene.requestId);
      if (mode === 'legacy') {
        expect(after).toEqual([]);
        expect(events).toHaveLength(0);
        return;
      }
      const cancelJournal = await journalRowOf(body.operation.operationId);
      const burned = after.filter((sheet) => sheet.status === 'cancelled');
      expect(burned.map((sheet) => sheet.id)).toEqual(cutShort);
      expect(burned.every((sheet) => sheet.cancel_correction_id === cancelJournal.id)).toBe(true);
      /*
       * DIVERGENCE (plan R13, E2: "the blanks issued under the fill are annulled, as with any
       * correction of the past"): the blanks the fill minted outlive its cancellation. They keep
       * naming the person the history no longer claims, because R19 treats an `unknown` day as a
       * match for any printed name — a rule written for blanks issued before the history existed,
       * not for blanks minted by the very claim being withdrawn.
       */
      const survivors = after.filter((sheet) => sheet.status === 'issued');
      // Never empty: the first minted period starts where the gap does and ends on the same
      // Sunday or month end, so it always coincides with a period of the restored gap.
      expect(survivors.length).toBeGreaterThan(0);
      expect(survivors.map((sheet) => sheet.id)).toEqual(
        minted.filter((sheet) => !cutShort.includes(sheet.id)).map((sheet) => sheet.id),
      );
      expect(survivors.every((sheet) => sheet.driver_person_id === ctx.personA)).toBe(true);
      // One event per paper-touching command: the fill's, plus the cancel's only if it burned.
      expect(events).toHaveLength(cutShort.length > 0 ? 2 : 1);
    });

    it('заполнение поверх отработанного листа с другим человеком: план ждёт 422, дверь переоформляет бланк (Ф1)', async () => {
      if (!DB_URL) return;
      const scene = await paperScene();
      const before = await sheetsOf(scene.requestId);
      const fillTo = shiftDateKey(PREV_MONDAY, 2);
      // The prior week's blank is worked-out, hence locked (R21): its days are a fill address (C4).
      const seen = (await inspectRepair(ctx.admin, scene.requestId)).json<RepairPreview>();
      expect(seen.fillableGaps[0]).toMatchObject({ from: PREV_MONDAY });
      expect(seen.fillableGaps[0]!.to >= fillTo).toBe(true);
      const touched = before.filter(
        (sheet) => sheet.period_to < TODAY && sheet.period_from <= fillTo,
      );
      expect(touched.length).toBeGreaterThan(0);

      const body = {
        mode: 'repair',
        version: 0,
        knownFills: [{ from: PREV_MONDAY, to: fillTo, personId: ctx.personB }],
        operation: operation('По табелю начало прошлой недели отработал сменщик'),
      };
      const preview = await previewRepair(ctx.admin, scene.requestId, body);
      /*
       * DIVERGENCE (plan R29/F1, section 13 "known fills": "a day already covered by a live sheet
       * requires the named person to match the printed one — otherwise 422 with the number"): no
       * such check exists. The door instead asks to unlock the locked blank by name and plans to
       * burn it, re-issuing only the filled days — the rest of the burned week is left with no blank.
       */
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<RepairPreview>();
      expect(dto.requiredUnlocks.map((sheet) => sheet.waybillId)).toEqual(
        touched.map((sheet) => sheet.id),
      );
      expect(dto.plan.cancel.map((sheet) => sheet.waybillId)).toEqual(
        touched.map((sheet) => sheet.id),
      );
      expect(planIssueOf(dto)).toEqual(
        periodsOf(PREV_MONDAY, fillTo, ctx.ownVehicle.id, ctx.personB),
      );

      const res = await postRepair(ctx.admin, scene.requestId, { ...body, ...handshakeOf(dto) });
      expect(res.statusCode, res.body).toBe(200);

      const after = await sheetsOf(scene.requestId);
      if (mode === 'legacy') {
        // Legacy leaves the blank alone, so the live sheet now contradicts the history it covers.
        expect(compositionOf(after)).toEqual(compositionOf(before));
        expect(burnedOf(after)).toEqual([]);
        return;
      }
      expect(burnedOf(after)).toEqual(touched.map((sheet) => sheet.id).sort());
      const live = after.filter((sheet) => sheet.status !== 'cancelled');
      // The day after the fill used to be covered by the burned blank and is covered by nothing now.
      const orphan = shiftDateKey(fillTo, 1);
      if (touched.some((sheet) => sheet.period_to >= orphan)) {
        expect(live.some((sheet) => sheet.period_from <= orphan && sheet.period_to >= orphan)).toBe(
          false,
        );
      }
    });

    it('заполнение до конца заблокированной части называет человека и в изменяемых днях (Ц4)', async () => {
      if (!DB_URL) return;
      /*
       * The gap starts in locked past and runs on into mutable days (today to the end of term).
       * Only its locked part is a fill address; the mutable part is a blocker that an anchor closes
       * (C4: "on mutable days the same hole is repaired by anchors, and no second way to name a
       * person is introduced there").
       */
      const scene = await makeScene({
        dateFrom: DEEP_FROM,
        dateTo: TERM_TO,
        history: gapHistory(),
      });
      const seen = (await inspectRepair(ctx.admin, scene.requestId)).json<RepairPreview>();
      const lockedEnd = shiftDateKey(TODAY, -1);
      expect(seen.fillableGaps).toEqual([{ from: DEEP_FROM, to: lockedEnd }]);
      expect(seen.requiredAnchors.map((anchor) => anchor.effectiveDate)).toEqual([DEEP_FROM]);
      expect(seen.state).toBe('materialized');

      const body = {
        mode: 'repair',
        version: 0,
        knownFills: [{ from: DEEP_FROM, to: lockedEnd, personId: ctx.personA }],
        operation: operation('Табель по вчерашний день'),
      };
      const preview = await previewRepair(ctx.admin, scene.requestId, body);
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<RepairPreview>();
      /*
       * DIVERGENCE (C4): the fill writes no `unknown_remainder` when it ends on the last locked day,
       * because `planFills` bounds the remainder by the fill address (`boundary <= gap.to`) rather
       * than by the `unknown` segment. The `set` therefore runs on through today and the future,
       * the mutable blocker disappears without an anchor, and the history reports `ready`.
       */
      expect(dto.stateAfter).toBe('ready');
      expect(planIssueOf(dto)).toEqual(
        periodsOf(DEEP_FROM, TERM_TO, ctx.ownVehicle.id, ctx.personA),
      );

      const res = await postRepair(ctx.admin, scene.requestId, { ...body, ...handshakeOf(dto) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ state: string }>().state).toBe('ready');
      const driverRows = actual(await rowsOf(scene.requestId)).filter(
        (row) => row.dimension === 'driver',
      );
      expect(driverRows.map((row) => [row.effective_date, row.origin])).toEqual([
        [DEEP_FROM, 'known_fill'],
      ]);
      // In `history` the leak reaches paper: blanks are minted for today and the days ahead as well.
      expect(compositionOf(await sheetsOf(scene.requestId))).toEqual(
        byReadMode(mode, {
          legacy: [] as string[],
          history: periodsOf(DEEP_FROM, TERM_TO, ctx.ownVehicle.id, ctx.personA),
        }),
      );
    });
  },
);

describeReadModes(readMode, 'решение хвоста не трогает бумагу срока (Р31)', () => {
  it('assignment_wins и переключение на history_wins не жгут ни одного листа', async () => {
    if (!DB_URL) return;
    /*
     * The R30 case as backfill leaves it: history and paper agree on machine A for the whole term,
     * and only the denormalization drifted to B. The term runs through this week, so the current
     * sheet is still cancellable — a tail decision that disturbed in-term paper would show here.
     */
    const scene = await makeScene({
      dateFrom: PREV_MONDAY,
      dateTo: PAPER_TO,
      history: [
        { effectiveDate: PREV_MONDAY, dimension: 'vehicle', vehicleId: ctx.ownVehicle.id },
        {
          effectiveDate: PREV_MONDAY,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: ctx.personA,
          origin: 'machinist_change',
        },
      ],
      state: 'ready',
      issueSheets: { driverPersonId: ctx.personA },
    });
    await ctx.db.execute(sql`
      UPDATE vehicle_request_assignments
         SET vehicle_id = ${ctx.ownVehicleB.id}, vehicle_type_id = ${ctx.ownVehicleB.typeId}
       WHERE request_id = ${scene.requestId}`);
    const before = await sheetsOf(scene.requestId);
    expect(compositionOf(before)).toEqual(
      periodsOf(PREV_MONDAY, PAPER_TO, ctx.ownVehicle.id, ctx.personA),
    );
    expect(before.some((sheet) => sheet.period_to >= TODAY)).toBe(true);

    const first = { mode: 'repair', version: 0, tailResolution: { kind: 'assignment_wins' } };
    const firstPreview = await previewRepair(ctx.admin, scene.requestId, first);
    expect(firstPreview.statusCode, firstPreview.body).toBe(200);
    const firstDto = firstPreview.json<RepairPreview>();
    expect(firstDto.operationRequirement).toMatchObject({ kind: 'assignment_tail' });
    expect(firstDto.plan).toEqual({ cancel: [], issue: [] });
    expect(firstDto.unlockFingerprint).toBeNull();
    expect(firstDto.paperFree).toBe(true);
    const firstApply = await postRepair(ctx.admin, scene.requestId, {
      ...first,
      ...handshakeOf(firstDto),
      operation: operation('Дальше работает машина назначения'),
    });
    expect(firstApply.statusCode, firstApply.body).toBe(200);
    const border = actual(await rowsOf(scene.requestId)).find(
      (row) => row.origin === 'tail_resolution',
    )!;
    // The dormant boundary lies past the term: it describes no working day yet (R24, R31).
    expect(border.effective_date).toBe(NEXT_MONDAY);
    expect(await sheetsOf(scene.requestId)).toEqual(before);

    const second = {
      mode: 'repair',
      version: firstApply.json<{ version: number }>().version,
      tailResolution: { kind: 'history_wins' },
    };
    const secondPreview = await previewRepair(ctx.admin, scene.requestId, second);
    expect(secondPreview.statusCode, secondPreview.body).toBe(200);
    const secondDto = secondPreview.json<RepairPreview>();
    expect(secondDto.plan).toEqual({ cancel: [], issue: [] });
    const switched = await postRepair(ctx.admin, scene.requestId, {
      ...second,
      ...handshakeOf(secondDto),
      operation: operation('Назначение было записано ошибочно'),
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const [assignment] = (
      await ctx.db.execute<{ vehicle_id: string }>(sql`
        SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`)
    ).rows;
    expect(assignment!.vehicle_id).toBe(ctx.ownVehicle.id);

    /*
     * One expectation for both modes, and that is the claim rather than a shortcut: neither
     * decision changes who worked on any day inside the term, so there is nothing for either paper
     * executor to do — the same rows, the same numbers, no sync event.
     */
    expect(await sheetsOf(scene.requestId)).toEqual(before);
    expect(await esm2EventsOf(scene.requestId)).toHaveLength(0);
  });
});

describeReadModes(readMode, 'ремонт архивной заявки против бумаги (Р29)', (mode) => {
  it('restore: true — архив снят той же транзакцией, в history бланк переоформлен', async () => {
    if (!DB_URL) return;
    /*
     * Paper first, archive second — the order R29 is about: soft deletion never calls the sync, so
     * blanks issued before the request was archived stay live, and the archive says nothing about
     * paper. Archiving the scene at insert would give the sync nothing to issue at all.
     */
    const scene = await paperScene();
    await ctx.db.execute(sql`
      UPDATE vehicle_requests SET deleted_at = now(), deleted_by = ${ctx.admin.id}
       WHERE id = ${scene.requestId}`);
    const before = await sheetsOf(scene.requestId);
    const body = anchorBody('Вернули заявку из архива: работал сменщик');

    const plain = (await previewRepair(ctx.admin, scene.requestId, body)).json<RepairPreview>();
    expect(plain.archived).toBe(true);
    expect(plain.paperFree).toBe(false);
    expect(plain.restoreRequired).toBe(true);

    const preview = await previewRepair(ctx.admin, scene.requestId, { ...body, restore: true });
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<RepairPreview>();
    expect(planIssueOf(dto)).toEqual(
      periodsOf(PREV_MONDAY, PAPER_TO, ctx.ownVehicle.id, ctx.personB),
    );

    const res = await postRepair(ctx.admin, scene.requestId, {
      ...body,
      restore: true,
      ...handshakeOf(dto),
    });
    expect(res.statusCode, res.body).toBe(200);
    const state = await requestState(scene.requestId);
    expect(state.deleted_at).toBeNull();
    expect(state.state).toBe('ready');
    // Two facts, two events: the history repair and the way back from the archive.
    const actions = await auditActionsOf(scene.requestId);
    expect(actions).toContain('vehicle_request.assignment_repair');
    expect(actions).toContain('vehicle_request.restore');

    const after = await sheetsOf(scene.requestId);
    const expected = byReadMode(mode, {
      // The archive is lifted and the history repaired, but the weekly sync is not called: the
      // restored request goes on living with blanks that name the person history no longer does.
      legacy: { composition: compositionOf(before), burned: [] as string[], events: 0 },
      history: {
        composition: periodsOf(PREV_MONDAY, PAPER_TO, ctx.ownVehicle.id, ctx.personB),
        burned: before.map((sheet) => sheet.id).sort(),
        events: 1,
      },
    });
    expect(compositionOf(after)).toEqual(expected.composition);
    expect(burnedOf(after)).toEqual(expected.burned);
    expect(await esm2EventsOf(scene.requestId)).toHaveLength(expected.events);
  });

  it('заполнение архивной заявки не просит восстановления, а в history выписывает ей бланки (Р29)', async () => {
    if (!DB_URL) return;
    const scene = await makeScene({
      dateFrom: DEEP_FROM,
      dateTo: GAP_TO,
      history: gapHistory(),
      archived: true,
    });
    const body = fillBody('Табель архивной заявки');
    const preview = await previewRepair(ctx.admin, scene.requestId, body);
    expect(preview.statusCode, preview.body).toBe(200);
    const dto = preview.json<RepairPreview>();
    expect(dto.archived).toBe(true);
    expect(dto.plan.issue.length).toBeGreaterThan(0);
    /*
     * DIVERGENCE (R29: "a non-empty plan rejects the repair and demands `restore: true`; one
     * transaction lifts the archive, writes history and calls the sync"): the same probe-plan
     * blind spot as in the paperless fill above. The plan issues blanks, yet `paperFree` is true
     * and `restoreRequired` false, so the repair goes through with the archive left in place.
     */
    expect(dto.paperFree).toBe(true);
    expect(dto.restoreRequired).toBe(false);

    const res = await postRepair(ctx.admin, scene.requestId, { ...body, ...handshakeOf(dto) });
    expect(res.statusCode, res.body).toBe(200);
    expect((await requestState(scene.requestId)).deleted_at).not.toBeNull();
    // In `history` the blanks are really minted — for a request that stays in the archive.
    expect(compositionOf(await sheetsOf(scene.requestId))).toEqual(
      byReadMode(mode, { legacy: [] as string[], history: planIssueOf(dto) }),
    );
  });
});

describeReadModes(readMode, 'рукопожатие и повтор двери ремонта против бумаги (Б4, Р9)', (mode) => {
  it('подписи по листам: без них history отвечает 409, legacy проходит; чужая подпись — 409 в обоих', async () => {
    if (!DB_URL) return;
    const scene = await paperScene();
    const before = await sheetsOf(scene.requestId);
    const body = anchorBody('По табелю обе недели отработал сменщик');
    const dto = (await previewRepair(ctx.admin, scene.requestId, body)).json<RepairPreview>();
    // The preview names the sheets to sign in both modes: the plan is computed regardless (§10).
    const warned = dto.issues.filter((issue) => issue.warnings.length > 0);
    expect(warned.length).toBeGreaterThan(0);
    const armed = (acknowledgements?: Record<string, string>) => ({
      ...body,
      operation: operation(body.operation.reason),
      previewFingerprint: dto.fingerprint,
      unlockFingerprint: dto.unlockFingerprint!,
      ...(acknowledgements ? { acknowledgements } : {}),
    });
    const untouched = async () => {
      expect(await sheetsOf(scene.requestId)).toEqual(before);
      expect(await rowsOf(scene.requestId)).toHaveLength(2);
      expect((await requestState(scene.requestId)).version).toBe(0);
    };

    // A signature under a different warning set is stale, not merely extra: 409 with the fresh list
    // in both modes, because a supplied signature is checked even where it is not required.
    const forged = await postRepair(
      ctx.admin,
      scene.requestId,
      armed({
        ...acknowledgementsOf(dto.issues),
        [String(warned[0]!.issueKey)]: 'чужой отпечаток',
      }),
    );
    expect(forged.statusCode, forged.body).toBe(409);
    expect(forged.json<{ code: string }>().code).toBe(WAYBILL_ACK_REQUIRED_CODE);
    await untouched();

    // A signature for a sheet the plan does not warn about is the other refusal: 422 in both modes.
    const stray = await postRepair(
      ctx.admin,
      scene.requestId,
      armed({ ...acknowledgementsOf(dto.issues), '9999': 'подпись без листа' }),
    );
    expect(stray.statusCode, stray.body).toBe(422);
    await untouched();

    /*
     * No signatures at all: `history` issues the blanks from this plan and demands one per warned
     * sheet; `legacy` leaves paper to the weekly sync, which has no requester to ask (ADR 0064).
     */
    const unsigned = await postRepair(ctx.admin, scene.requestId, armed());
    expect(unsigned.statusCode, unsigned.body).toBe(
      byReadMode(mode, { legacy: 200, history: 409 }),
    );
    if (mode === 'history') {
      expect(unsigned.json<{ code: string }>().code).toBe(WAYBILL_ACK_REQUIRED_CODE);
      await untouched();
      // The refusal was about the signatures and nothing else: with them the same command passes.
      const signed = await postRepair(
        ctx.admin,
        scene.requestId,
        armed(acknowledgementsOf(dto.issues)),
      );
      expect(signed.statusCode, signed.body).toBe(200);
    }
    expect(compositionOf(await sheetsOf(scene.requestId))).toEqual(
      byReadMode(mode, {
        legacy: compositionOf(before),
        history: periodsOf(PREV_MONDAY, PAPER_TO, ctx.ownVehicle.id, ctx.personB),
      }),
    );
  });

  it('повтор по ключу с бумагой: номера не горят второй раз, событие сверки одно', async () => {
    if (!DB_URL) return;
    const scene = await paperScene();
    const before = await sheetsOf(scene.requestId);
    const body = anchorBody('По табелю обе недели отработал сменщик');
    const dto = (await previewRepair(ctx.admin, scene.requestId, body)).json<RepairPreview>();
    const payload = { ...body, ...handshakeOf(dto) };

    const first = await postRepair(ctx.admin, scene.requestId, payload);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ repeated: boolean }>().repeated).toBe(false);
    const version = first.json<{ version: number }>().version;
    const afterFirst = await sheetsOf(scene.requestId);
    const rowsAfterFirst = await rowsOf(scene.requestId);

    // The client lost the answer and sent the very same request again (R9).
    const repeat = await postRepair(ctx.admin, scene.requestId, payload);
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json<{ repeated: boolean; version: number }>()).toMatchObject({
      repeated: true,
      version,
    });
    expect((await requestState(scene.requestId)).version).toBe(version);
    expect(await rowsOf(scene.requestId)).toEqual(rowsAfterFirst);
    await journalRowOf(body.operation.operationId);

    /*
     * The replay branch returns before planning, so step 12 never runs twice: the same rows, the
     * same numbers, and — in `history` — exactly the one sync event of the first run. A replay
     * that re-executed the plan would burn the fresh blanks and mint a third set.
     */
    const afterRepeat = await sheetsOf(scene.requestId);
    expect(afterRepeat).toEqual(afterFirst);
    expect(burnedOf(afterRepeat)).toEqual(
      byReadMode(mode, { legacy: [] as string[], history: before.map((sheet) => sheet.id).sort() }),
    );
    expect(afterRepeat).toHaveLength(
      byReadMode(mode, { legacy: before.length, history: before.length + PAPER_PERIODS.length }),
    );
    expect(await esm2EventsOf(scene.requestId)).toHaveLength(
      byReadMode(mode, { legacy: 0, history: 1 }),
    );
  });
});
