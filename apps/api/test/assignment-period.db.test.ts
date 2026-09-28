import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';
import {
  esm2Periods,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  WAYBILL_ACK_REQUIRED_CODE,
  type PeriodApplyInput,
  type PeriodCommand,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type { Principal } from '../src/auth/principal';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentPeriod from '../src/services/assignment-period';
import type * as AssignmentWrite from '../src/services/assignment-write';
import type * as Esm2 from '../src/services/waybill-esm2';

/*
 * THE FILE NEEDS ITS OWN DATABASE. Every command here takes the module's control row `FOR SHARE`
 * (step 0 of the canon), and the neighbouring files of the module change and freeze that same row
 * (plan Yu27, Yu30). The database is created and dropped by `useReadModeDatabase`, which also moves
 * the read mode on it: four blocks of the file run twice, and outside them the mode stays what
 * migration `0167` brings, `legacy`.
 *
 * WHAT DEPENDS ON THE READ MODE. Step 8 and step 12. Step 12 is executed BY MODE (§10, stage 5):
 * before cutover the weekly sync owns the paper of a term edit — it knows ONE vehicle-and-machinist
 * pair, the one in the request's denormalization, and prints it on every sheet; after the switch
 * the same step executes the segment plan, taking the pair from the history of each segment. They
 * part where those two sources disagree: after the tail group is cancelled the denormalization still
 * shows the tail vehicle (R17 does not move it), while the history within the term already shows
 * the starting one. Step 8 depends on the mode through the per-sheet signatures (B4): required only
 * where this plan issues the blanks, i.e. in `history`, and checked FIRST among the handshakes.
 *
 * Hence the two-run blocks: "продление и сокращение" and "права по исходу" (step 12 diverges),
 * "подтверждение гашения" (step 8 order; the halves coincide only because `armed()` signs what the
 * preview asked for, and one case drops the signatures to show the order) and "повтор по ключу"
 * (the first run does mode-specific paper work, and the replay must not repeat it in either mode).
 *
 * Both sets of expectations are written BEFORE cutover: the `all_frozen` window has no time to fix
 * the suite (U1).
 *
 * WHAT THESE RUNS DO NOT COVER. The backstop: that conversation belongs to another door and is
 * checked in two runs in `assignment-backstop.db.test.ts`. A shortening with cancellation runs into
 * the tail mismatch (R31) by the backstop's rule, not the term edit's — and since Yu86 not at all:
 * the door names the direction of the edit explicitly (`opensTerm`).
 *
 * WHAT RUNS ONCE, AND WHY. The preview writes nothing and is the same computation in both modes —
 * the mode is read by the preview, but consulted only by steps 8 and 12, which a preview never
 * reaches. An order without a vehicle has neither history nor paper, so its step 12 executes an
 * empty plan in both modes and it issues nothing to sign. Two runs there would give identical
 * halves by construction.
 */

/**
 * Правка срока — своя дверь ([assignment-period.ts](../src/services/assignment-period.ts); план
 * `docs/assignment-periods-plan.md`, Ж4, З5, Д2, Е3, Л1; §7, §8, этап 3).
 *
 * ЗАЧЕМ БАЗА. Предмет здесь — сцепка пяти таблиц, и ни одна из связей не воспроизводится в памяти:
 *
 * 1. **срок** — `special_equipment_request_details.date_from/date_to`: его правит дверь, и по
 *    записанному сроку считают последствия сверка и бэкстоп;
 * 2. **история** — `vehicle_request_assignment_changes` с частичным UNIQUE и группами (В2):
 *    гашение групповое, и «вся группа» — свойство базы, а не расчёта;
 * 3. **бумага** — `waybills`: продление добавляет недели, сокращение сжигает их номера;
 * 4. **журнал коррекций** — `waybill_corrections` с ключом идемпотентности и снимком авторизации;
 * 5. **денормализация** `vehicle_request_assignments` — Р17 проверяется каркасом по живому
 *    состоянию: правка срока назначения не трогает, даже погасив хвостовую группу.
 *
 * ПОЧЕМУ ДЕНЬ РАСЧЁТА — НАСТОЯЩЕЕ СЕГОДНЯ. У соседних файлов `asOf` фиксирован средой недели, и
 * там это верно: команда идёт целиком через каркас. Здесь же шаг 12 зовёт **сегодняшнюю** сверку
 * ЭСМ-2, которая границу отработанного считает по своим часам, — и разъехавшиеся «сегодня» дали бы
 * сцену, в которой прошлое у команды одно, а у бумаги другое. Календарь сцены при этом
 * относительный: прошлая неделя, текущая и следующая — от понедельника сегодняшней.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_period \
 *     npx vitest run test/assignment-period.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const readMode = useReadModeDatabase('period');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

// ── Календарь сцены ──

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
/** День расчёта команды — сегодня: им же считает бумагу шаг 12. */
const AS_OF = TODAY;
/** Понедельник прошлой недели: с него идёт срок. */
const PREV = shiftDateKey(MONDAY, -7);
/** Понедельник следующей недели. */
const NEXT = shiftDateKey(MONDAY, 7);
const TERM_FROM = PREV;
/** Базовый конец срока — воскресенье текущей недели: две недели работы. */
const TERM_TO = shiftDateKey(MONDAY, 6);
/** Конец срока после продления — воскресенье следующей недели. */
const EXTENDED_TO = shiftDateKey(NEXT, 6);
/**
 * Периоды бумаги базового срока — тем же расчётом, каким режет портал (`esm2Periods`).
 *
 * Границы срока остаются понедельниками — сцена обязана задавать их сама, иначе проверять было бы
 * нечего, — а вот **сколько документов** из этих границ выходит, решает портал: лист режет не
 * только воскресенье, но и конец месяца (ADR 0142). Две недели срока дают два листа, а если месяц
 * кончается в середине — три. Число, записанное цифрой, и состав, записанный парой строк, зеленели
 * бы три недели из четырёх и краснели бы в последнюю без всякой правки кода.
 */
const TERM_PERIODS = esm2Periods(TERM_FROM, TERM_TO);
/**
 * Периоды бумаги, которые добавляет продление, — тем же расчётом, каким режет портал.
 *
 * Считаются, а не пишутся одной неделей: лист режет и конец месяца (ADR 0142), и продление на
 * переходную неделю добавляет два документа вместо одного.
 */
const ADDED_PERIODS = esm2Periods(NEXT, EXTENDED_TO);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  period: typeof AssignmentPeriod;
  command: typeof AssignmentCommand;
  esm2: typeof Esm2;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  const { db, closeDb } = await import('../src/db/client');
  ctx = {
    db,
    closeDb,
    period: await import('../src/services/assignment-period'),
    command: await import('../src/services/assignment-command'),
    esm2: await import('../src/services/waybill-esm2'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Субъекты ──
//
// Права спрашиваются по посчитанному исходу (Р32, Е3), поэтому сцене нужны два субъекта: без
// коррекционного права и с ним. Область у обоих пустая: боевая ручка спрашивает её до транзакции,
// а сюда команда приходит уже разрешённой.

const subject = (role: string): Principal =>
  ({ id: '', role, constructionObjectIds: [], departmentIds: [] }) as unknown as Principal;

/** Менеджер: коррекции задним числом у него нет вовсе (ADR 0101). */
const MANAGER = subject('manager');
/** Диспетчер: `waybills.correct` есть, предел тридцати дней остаётся. */
const DISPATCHER = subject('dispatcher');

// ── Сцена ──

interface SceneOptions {
  /** Статус заказа: сокращать срок правкой можно всюду, кроме «В работе» (ADR 0044). */
  status: 'confirmed' | 'done';
  /** Конец срока сцены; по умолчанию — воскресенье текущей недели. */
  dateTo?: string;
  /**
   * Дата второго решения о машине. Оно попадает в свою группу вместе с машинистом — ровно та
   * пара, которую сокращение гасит целиком (Д2, В2).
   */
  splitAt?: string;
  /** Выписать бумагу на весь срок: без неё сверка не знает машиниста заявки и выписывать не станет. */
  issueSheets?: boolean;
  /**
   * Заказ без назначенной техники: ни истории, ни бумаги. Самый частый случай правки срока — у
   * заявки, которую ещё не вывели на объект, — и дверь обязана его обслуживать, а не отказывать
   * «история не восстановлена», как это делают соседние двери.
   */
  bare?: boolean;
}

interface Scene {
  requestId: string;
  userId: string;
  /** Машина начала срока. */
  vehicleA: string;
  /** Машина второго решения — та, чью группу гасит сокращение. */
  vehicleB: string;
  personA: string;
  personB: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники со сроком в две недели: машина A с начала, при `splitAt` — машина B со своей
 * датой и своим машинистом в **одной** группе.
 *
 * Денормализация стоит на машине хвоста: именно её проверяет Р17, и сцена, оставившая назначение на
 * первой машине, ловила бы не дверь, а собственную ошибку.
 */
async function inScene<T>(
  options: SceneOptions,
  run: (tx: SceneTx, scene: Scene) => Promise<T>,
): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<Record<string, string>> => {
        const [row] = (await tx.execute<Record<string, string>>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const fleet = (
        await tx.execute<{ id: string; vehicle_type_id: string }>(
          sql`SELECT v.id, v.vehicle_type_id FROM vehicles v
                JOIN vehicle_types t ON t.id = v.vehicle_type_id
               WHERE v.deleted_at IS NULL AND v.ownership = 'own' AND t.is_linear = false
               ORDER BY v.id LIMIT 2`,
        )
      ).rows;
      const [vehicleA, vehicleB] = fleet;
      if (!vehicleA || !vehicleB) throw new Error('в парке меньше двух своих нелинейных машин');
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-period-${RUN}@example.invalid`}, 'Сроков', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      // Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не
      // зависит (ADR 0164), но водителем справочника человек числится именно ею.
      const personOf = async (last: string): Promise<string> => {
        const person = (
          await one(sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров')
                        RETURNING id`)
        ).id!;
        await tx.execute(sql`
          INSERT INTO person_specializations (person_id, specialization_id, started_on)
          VALUES (${person}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);
        return person;
      };
      const personA = await personOf('Машинистов');
      const personB = await personOf('Сменщиков');

      const dateTo = options.dateTo ?? TERM_TO;
      const tailVehicle = options.splitAt ? vehicleB : vehicleA;
      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicleA.vehicle_type_id}, ${options.status},
                ${user.id}, ${options.bare ? 'empty' : 'materialized'},
                ${options.bare ? null : AS_OF})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${TERM_FROM}, ${dateTo})`);
      if (options.bare) {
        out = await run(tx, {
          requestId: request.id!,
          userId: user.id!,
          vehicleA: vehicleA.id,
          vehicleB: vehicleB.id,
          personA,
          personB,
        });
        throw new Error('rollback');
      }
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${tailVehicle.id}, ${tailVehicle.vehicle_type_id},
                ${vehicleA.vehicle_type_id}, ${user.id})`);

      const startGroup = randomUUID();
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'vehicle',
        vehicleId: vehicleA.id,
        origin: 'assignment',
        changeGroupId: startGroup,
      });
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'driver',
        driverState: 'set',
        driverPersonId: personA,
        origin: 'assignment',
        changeGroupId: startGroup,
      });
      if (options.splitAt) {
        // Машина и её машинист — **одна** группа (В2): гашение групповое, и сцена обязана дать
        // двери именно ту пару, которую она уводит целиком.
        const splitGroup = randomUUID();
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: options.splitAt,
          dimension: 'vehicle',
          vehicleId: vehicleB.id,
          origin: 'reassignment',
          changeGroupId: splitGroup,
        });
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: options.splitAt,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: personB,
          origin: 'reassignment',
          changeGroupId: splitGroup,
        });
      }

      if (options.issueSheets) {
        await ctx.esm2.syncEsm2Waybills(tx, {
          requestId: request.id!,
          actor: { id: user.id! },
          reason: 'сцена теста: бумага на весь срок',
          driverPersonId: personA,
          // Расчёт от начала срока: тогда лист получает и та неделя, что к сегодня уже отработана.
          asOf: TERM_FROM,
        });
      }

      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleA: vehicleA.id,
        vehicleB: vehicleB.id,
        personA,
        personB,
      });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
  return out!;
}

async function insertChange(
  tx: SceneTx,
  row: {
    requestId: string;
    effectiveDate: string;
    dimension: 'vehicle' | 'driver';
    vehicleId?: string;
    driverPersonId?: string;
    driverState?: string;
    origin: string;
    changeGroupId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${row.changeGroupId})`);
}

/** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

/** Предпросмотр — тем же колбэком `plan`, что и бой (§8, Л1). */
async function previewPeriod(tx: SceneTx, scene: Scene, actor: Principal, input: PeriodCommand) {
  const preview = await ctx.command.previewAssignmentCommand<AssignmentPeriod.PeriodPlan>(
    executorOf(tx),
    {
      requestId: scene.requestId,
      actor: { id: scene.userId },
      asOf: AS_OF,
      plan: (planCtx) => ctx.period.planPeriodCommand(planCtx, input, withId(actor, scene.userId)),
    },
  );
  return ctx.period.periodPreviewDto(
    preview.effects,
    preview.plan,
    preview.fingerprint,
    preview.asOf,
  );
}

/** Провести команду через каркас — ровно тем же способом, каким её проводит боевая ручка. */
function runPeriod(
  tx: SceneTx,
  scene: Scene,
  actor: Principal,
  input: PeriodApplyInput,
): Promise<
  AssignmentCommand.AssignmentCommandOutcome<
    AssignmentWrite.AssignmentWriteResult,
    AssignmentPeriod.PeriodPaper
  >
> {
  return ctx.command.runAssignmentCommand<
    AssignmentPeriod.PeriodPlan,
    AssignmentWrite.AssignmentWriteResult,
    AssignmentPeriod.PeriodPaper
  >(
    executorOf(tx),
    ctx.period.periodCommandSpec({
      requestId: scene.requestId,
      actor: withId(actor, scene.userId),
      input,
      asOf: AS_OF,
    }),
  );
}

const withId = (actor: Principal, id: string): Principal => ({ ...actor, id });

/**
 * Рукопожатия по всем листам, которым есть что подтверждать (Б4): так их собирает и окно.
 *
 * Обязательны с тех пор, как предупреждения считаются вместе с планом (§7): команда, выпускающая
 * бланк с пробелами в документах машиниста, без подписи человека отвечает 409. Сцены заводят людей
 * без СНИЛСа и без удостоверения, поэтому подпись нужна почти каждой команде здесь — и собирается
 * она из **показанного** предпросмотра, а не выдумывается: подтверждают ровно то, что видели.
 */
const acknowledgementsOf = (
  issues: readonly { issueKey: number; warnings: readonly unknown[]; warningFingerprint: string }[],
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => issue.warnings.length > 0)
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

/** Тело боевой команды по посчитанному предпросмотру: отпечатки и envelope журнала. */
function armed(
  body: PeriodCommand,
  preview: {
    fingerprint: string;
    cancelGroupsFingerprint: string | null;
    issues: readonly {
      issueKey: number;
      warnings: readonly unknown[];
      warningFingerprint: string;
    }[];
  },
  extra: { operation?: { operationId: string; reason: string }; confirmGroups?: boolean } = {},
): PeriodApplyInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    // Рукопожатия по листам с предупреждениями (Б4): без них команда отвечает 409.
    ...(Object.keys(acknowledgementsOf(preview.issues)).length > 0
      ? { acknowledgements: acknowledgementsOf(preview.issues) }
      : {}),
    ...(extra.confirmGroups && preview.cancelGroupsFingerprint
      ? { cancelGroupsFingerprint: preview.cancelGroupsFingerprint }
      : {}),
    ...(extra.operation ? { operation: extra.operation } : {}),
  };
}

const errorOf = async (
  run: () => Promise<unknown>,
): Promise<Error & { statusCode?: number; code?: string }> => {
  try {
    await run();
  } catch (e) {
    return e as Error & { statusCode?: number; code?: string };
  }
  throw new Error('ожидался отказ, а команда прошла');
};

// ── Чтение состояния ──

async function termOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{ date_from: string; date_to: string | null }>(
      sql`SELECT date_from, date_to FROM special_equipment_request_details
           WHERE request_id = ${requestId}`,
    )
  ).rows[0]!;
}

async function rowsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      vehicle_id: string | null;
      driver_person_id: string | null;
      origin: string;
      change_group_id: string;
      correction_id: string | null;
      superseded_kind: string | null;
      superseded_at: string | null;
    }>(sql`
      SELECT * FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} ORDER BY effective_date, created_at`)
  ).rows;
}

async function sheetsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      period_from: string;
      period_to: string;
      vehicle_id: string;
      driver_person_id: string;
      status: string;
      /**
       * Версия и след сокращения (Р12 плана `docs/vehicle-request-actual-end-date-plan.md`).
       *
       * Ими и различаются два способа привести лист к новому сроку: перевыписка даёт новую строку
       * с новым номером, правка — ту же строку с поднятой версией и заполненным следом. Состав
       * (`compositionOf`) обе картины показывает одинаково, и без этих колонок тест, ждавший пары
       * «аннулирован плюс выписан», молча зеленел бы на правке.
       */
      version: number;
      period_to_original: string | null;
      period_trimmed_at: string | null;
      period_trim_reason: string;
      period_trim_correction_id: string | null;
    }>(sql`
      SELECT id, period_from, period_to, vehicle_id, driver_person_id, status,
             version, period_to_original::text, period_trimmed_at::text,
             period_trim_reason, period_trim_correction_id
        FROM waybills
       WHERE source_request_id = ${requestId} ORDER BY period_from, id`)
  ).rows;
}

const activeSheets = (rows: Awaited<ReturnType<typeof sheetsOf>>) =>
  rows.filter((row) => row.status !== 'cancelled');

/**
 * Действующая бумага **составом**: границы, машина, человек.
 *
 * Числом и границами здесь не обойтись. Прежняя, недельная сверка печатает во всех листах одну
 * пару «машина + машинист» — ту, что стоит в денормализации заявки, — а отрезковый план берёт её
 * из истории на каждый отрезок. У сокращения, погасившего хвостовую группу, это разные машины:
 * денормализация правкой срока не двигается (Р17), а история за концом срока уже погашена. Тест,
 * сверяющий только `period_from—period_to`, обе картины считает одинаковыми.
 */
const compositionOf = (rows: Awaited<ReturnType<typeof sheetsOf>>) =>
  activeSheets(rows).map(
    (row) => `${row.period_from}—${row.period_to}|${row.vehicle_id}|${row.driver_person_id}`,
  );

async function journalOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      operation_id: string;
      kind: string;
      reason: string;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT c.* FROM waybill_corrections c
        JOIN vehicle_request_corrections l ON l.correction_id = c.id
       WHERE l.request_id = ${requestId} ORDER BY c.created_at`)
  ).rows;
}

const versionOf = async (tx: SceneTx, requestId: string): Promise<number> =>
  Number(
    (
      await tx.execute<{ version: string }>(
        sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
      )
    ).rows[0]!.version,
  );

const assignmentOf = async (tx: SceneTx, requestId: string): Promise<string> =>
  (
    await tx.execute<{ vehicle_id: string }>(
      sql`SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${requestId}`,
    )
  ).rows[0]!.vehicle_id;

// ── Р20: предпросмотр ничего не пишет ──

describe.skipIf(!DB_URL)('правка срока: предпросмотр (Р20, Л1)', () => {
  it('ни строки в базе: ни срока, ни истории, ни бумаги, ни журнала, ни версии', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const sheetsBefore = await sheetsOf(tx, scene.requestId);
      const rowsBefore = await rowsOf(tx, scene.requestId);

      const preview = await previewPeriod(tx, scene, DISPATCHER, {
        version: 0,
        dateTo: EXTENDED_TO,
      });
      // Продление ничего не гасит, и подтверждать перечень нечего (Д2).
      expect(preview.cancelGroups).toEqual([]);
      expect(preview.cancelGroupsFingerprint).toBeNull();
      expect(preview.fingerprint).not.toBe('');
      expect(preview.asOf).toBe(AS_OF);

      expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: TERM_TO });
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(rowsBefore.length);
      expect(await sheetsOf(tx, scene.requestId)).toHaveLength(sheetsBefore.length);
      expect(await journalOf(tx, scene.requestId)).toHaveLength(0);
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });

  it('второй предпросмотр той же команды даёт тот же отпечаток', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const first = await previewPeriod(tx, scene, DISPATCHER, command);
      const second = await previewPeriod(tx, scene, DISPATCHER, command);
      expect(second.fingerprint).toBe(first.fingerprint);
      // Та же правка, названная полным сроком, а не одной границей, — та же команда (§7).
      const spelled = await previewPeriod(tx, scene, DISPATCHER, {
        version: 0,
        dateFrom: TERM_FROM,
        dateTo: EXTENDED_TO,
      });
      expect(spelled.fingerprint).toBe(first.fingerprint);
    });
  });
});

// ── Продление против сокращения: последствия разные ──

describeReadModes(readMode, 'правка срока: продление и сокращение (Д2, Е3)', (mode) => {
  it('продление добавляет неделю бумаги, истории не трогает и журнала не заводит', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const before = await sheetsOf(tx, scene.requestId);
      // Сколько бумаги у нетронутого срока — считает портал, а не цифра: см. `TERM_PERIODS`.
      expect(activeSheets(before)).toHaveLength(TERM_PERIODS.length);

      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const preview = await previewPeriod(tx, scene, DISPATCHER, command);
      // Исход `none`: продление вперёд ничего о прошлом не утверждает (Р32).
      expect(preview.operationRequirement).toBeNull();
      expect(preview.unlockFingerprint).toBeNull();
      expect(preview.plan.issue.map((i) => `${i.from}—${i.to}`)).toEqual(
        ADDED_PERIODS.map((p) => `${p.from}—${p.to}`),
      );

      const outcome = await runPeriod(tx, scene, DISPATCHER, armed(command, preview));
      expect(outcome.repeated).toBe(false);
      expect(outcome.operation).toBeNull();
      expect(outcome.paper?.esm2.issued).toHaveLength(ADDED_PERIODS.length);

      expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: EXTENDED_TO });
      /*
       * Состав, а не число, — и здесь обе половины совпадают намеренно. Продление вперёд ничего не
       * режет: у заявки одна машина и один машинист на весь срок, и недельный разрез с отрезковым
       * дают один и тот же документ. Это и есть паритет, которого гейт совместимости требует до
       * переключения (Б1): расходиться исполнители обязаны только там, где недельная единица врёт.
       */
      expect(compositionOf(await sheetsOf(tx, scene.requestId))).toEqual([
        ...TERM_PERIODS.map((p) => `${p.from}—${p.to}|${scene.vehicleA}|${scene.personA}`),
        ...ADDED_PERIODS.map((p) => `${p.from}—${p.to}|${scene.vehicleA}|${scene.personA}`),
      ]);
      // История не тронута: продление её не пишет вовсе — оно лишь открывает дни.
      expect((await rowsOf(tx, scene.requestId)).every((r) => r.superseded_at === null)).toBe(true);
      expect(await journalOf(tx, scene.requestId)).toHaveLength(0);
      // Версия поднимается **любым** успешным выполнением, включая исход `none` (§8, шаг 14).
      expect(await versionOf(tx, scene.requestId)).toBe(1);
    });
  });

  it('продление задним числом: лист выходит на отрезок состава, а недельная сверка молчит', async () => {
    /*
     * Продление в **прошедшую** неделю. Срок кончился в прошлый вторник, и его двигают на прошлую
     * же пятницу: исход `crew` (Р32, Е3) — правка утверждает что-то о днях, которые уже прошли, и
     * потому спрашивает причину, право и глубину.
     *
     * Со среды прошлой недели по истории работает другая машина с другим машинистом. Это и есть
     * то, чего недельная сверка выразить не может: единица у неё — календарная неделя, а неделя
     * уже занята запертым листом за вторник (Р21). Отрезковый план единицей считает отрезок
     * постоянного состава, и открытые продлением дни получают **свой** документ.
     */
    const splitAt = shiftDateKey(PREV, 3);
    const extendedTo = shiftDateKey(PREV, 4);
    /**
     * Бумага двухдневного срока сцены и бумага открытых продлением дней — обе считаются порталом.
     *
     * Границы называет сцена (понедельник–вторник прошлой недели и четверг–пятница той же), а
     * сколько документов из этих границ выходит — ответ ADR 0142: месяц режет и двухдневный
     * отрезок. Прошлый понедельник бывает последним числом месяца, четверг — тоже, и тогда каждый
     * из отрезков становится двумя листами. Записанные одной строкой, оба ожидания краснели бы 35
     * и 28 дней из 1095 соответственно — без единой правки кода.
     */
    const scenePeriods = esm2Periods(PREV, shiftDateKey(PREV, 1));
    const openedPeriods = esm2Periods(splitAt, extendedTo);
    await inScene(
      { status: 'done', dateTo: shiftDateKey(PREV, 1), splitAt, issueSheets: true },
      async (tx, scene) => {
        const before = compositionOf(await sheetsOf(tx, scene.requestId));
        expect(before).toEqual(
          scenePeriods.map((p) => `${p.from}—${p.to}|${scene.vehicleB}|${scene.personA}`),
        );

        const command: PeriodCommand = { version: 0, dateTo: extendedTo };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        expect(preview.operationRequirement).toMatchObject({ kind: 'crew' });
        /*
         * Предпросмотр в **обоих** режимах показывает один и тот же отрезковый план: дверь считает
         * его всегда, режим решает не «считать ли», а «исполнять ли». До переключения обещание
         * шире исполнения — недельная сверка этот отрезок не выпишет, — и ровно это расхождение
         * cutover и закрывает.
         */
        expect(preview.plan.issue.map((i) => `${i.from}—${i.to}`)).toEqual(
          openedPeriods.map((p) => `${p.from}—${p.to}`),
        );
        // Подтверждать надо и пустое множество разблокировок (Д4): лист за вторник в область
        // сверки не попал — область продления это только открытые им дни (Р11).
        expect(preview.unlockFingerprint).not.toBeNull();
        expect(preview.requiredUnlocks).toEqual([]);

        const outcome = await runPeriod(tx, scene, DISPATCHER, {
          ...armed(command, preview, {
            operation: {
              operationId: randomUUID(),
              reason: 'заказчик задержал технику до пятницы',
            },
          }),
          unlockFingerprint: preview.unlockFingerprint!,
        });
        expect(outcome.repeated).toBe(false);
        expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: extendedTo });

        expect(compositionOf(await sheetsOf(tx, scene.requestId))).toEqual(
          byReadMode(mode, {
            /*
             * Недельная сверка не выписала ничего. Не «забыла»: неделю она считает занятой —
             * действующий лист за вторник в ней уже есть, а переоформить его нельзя, он отработан
             * и в область сверки не назван. Заказ живёт с новым сроком и без бумаги за открытые
             * дни: тот самый исход, ради устранения которого шаг 12 и переводят на отрезки.
             */
            legacy: before,
            /*
             * Отрезковый план выписывает документ ровно на новый отрезок — со среды по пятницу, на
             * машину и человека, которых история этих дней и называет. Лист за вторник при этом не
             * тронут: он вне области, и переоформлять его никто не просил.
             *
             * «Документ» здесь единственного числа по обыкновению, а не по расчёту: если четверг
             * окажется последним числом месяца, тот же отрезок выйдет двумя бланками (ADR 0142), и
             * предмет случая — что открытые дни получили СВОЮ бумагу, а не долепились к запертому
             * листу за вторник — от этого не меняется.
             */
            history: [
              ...before,
              ...openedPeriods.map((p) => `${p.from}—${p.to}|${scene.vehicleB}|${scene.personB}`),
            ],
          }),
        );
        expect(outcome.paper?.esm2.issued).toHaveLength(
          byReadMode(mode, { legacy: 0, history: openedPeriods.length }),
        );

        /*
         * Среда остаётся без бумаги в обоих режимах, и это не пропуск: её накрыл бы только
         * переоформленный лист за вторник, а он вне области сверки. Р11 запрещает трогать
         * документы, которых человек в предпросмотре не видел, — и запрет здесь сильнее удобства.
         */
        const middle = shiftDateKey(PREV, 2);
        expect(
          activeSheets(await sheetsOf(tx, scene.requestId)).some(
            (row) => row.period_from <= middle && row.period_to >= middle,
          ),
        ).toBe(false);
      },
    );
  });

  it('сокращение гасит группу за новым концом срока — машину вместе с её машинистом', async () => {
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt: NEXT, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: TERM_TO };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);

        // Перечень гасимых групп — состав целиком: человек должен увидеть, что вместе с машиной
        // уходит назначенный на неё машинист (Д2).
        expect(preview.cancelGroups).toHaveLength(1);
        expect(preview.cancelGroups[0]!.rows.map((r) => r.dimension).sort()).toEqual([
          'driver',
          'vehicle',
        ]);
        expect(preview.cancelGroups[0]!.rows.find((r) => r.vehicle)?.vehicle?.vehicleId).toBe(
          scene.vehicleB,
        );
        expect(preview.cancelGroupsFingerprint).not.toBeNull();
        // Прежний диапазон группы лежит в будущем — исход `assignment_tail`: причина нужна,
        // коррекционного права нет (Р32, Е3).
        expect(preview.operationRequirement).toMatchObject({ kind: 'assignment_tail' });
        expect(preview.unlockFingerprint).toBeNull();

        const outcome = await runPeriod(
          tx,
          scene,
          MANAGER,
          armed(command, preview, {
            confirmGroups: true,
            operation: { operationId: randomUUID(), reason: 'заказчик отпустил технику раньше' },
          }),
        );
        expect(outcome.repeated).toBe(false);

        const rows = await rowsOf(tx, scene.requestId);
        const cancelled = rows.filter((r) => r.superseded_kind === 'cancelled');
        expect(cancelled).toHaveLength(2);
        expect(cancelled.every((r) => r.effective_date === NEXT)).toBe(true);
        // Строки гаснут операцией журнала — «почему машины вдруг не стало» отвечается ею.
        expect((await journalOf(tx, scene.requestId))[0]).toMatchObject({
          kind: 'assignment_tail',
          reason: 'заказчик отпустил технику раньше',
        });
        expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: TERM_TO });
        /*
         * Бумага следующей недели сгорела вместе с днями, которых у заказа больше нет, — и обе
         * оставшиеся недели остались как были, **включая машину хвоста в них**. Область сверки
         * (Р11) накрывает только вынесенные за срок дни, и переписывать соседние документы дверь
         * не имеет права: человек их в предпросмотре не видел. Поэтому половины и совпадают —
         * расхождение исполнителей начинается там, где документ попадает в область (см. блок
         * «права по исходу»).
         */
        expect(compositionOf(await sheetsOf(tx, scene.requestId))).toEqual(
          // Перечень считается, а не пишется двумя строками: у нового конца срока ровно та бумага,
          // какую портал из него и режет, — в переходную неделю на лист больше (ADR 0142).
          TERM_PERIODS.map((p) => `${p.from}—${p.to}|${scene.vehicleB}|${scene.personA}`),
        );
        // Р17: назначение — «чем заявка закрыта сейчас» — правкой срока не двигается, и хвост
        // истории после гашения **законно** расходится с ним (Р30, Р31).
        expect(await assignmentOf(tx, scene.requestId)).toBe(scene.vehicleB);
      },
    );
  });

  it('сокращение срока работающей заявки идёт визой, а не правкой (ADR 0044)', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const error = await errorOf(() =>
        previewPeriod(tx, scene, DISPATCHER, { version: 0, dateTo: shiftDateKey(TERM_TO, -2) }),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('досрочным завершением');
    });
  });

  it('срок, не изменившийся ни одной границей, отвергается до всякой записи', async () => {
    await inScene({ status: 'confirmed' }, async (tx, scene) => {
      const error = await errorOf(() =>
        previewPeriod(tx, scene, DISPATCHER, { version: 0, dateTo: TERM_TO }),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('Срок работ не изменился');
    });
  });
});

// ── D2: confirming the list of cancelled groups ──

/*
 * Two runs, and the claim is that the halves coincide — which is not automatic here. Step 8 of this
 * door checks the per-sheet signatures FIRST (B4, required only in `history`) and the group
 * confirmation second, so a body without signatures would get 409 `waybill_ack_required` in
 * `history` where `legacy` answers the 422 under test. `armed()` sends the signatures the preview
 * asked for, as the portal window does, and that is what makes the halves equal; the last case of
 * the block drops them on purpose to pin the order down.
 */
describeReadModes(readMode, 'правка срока: подтверждение гашения (Д2)', (mode) => {
  it('без подтверждения — 422 с перечнем, и срок остаётся прежним', async () => {
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt: NEXT, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: TERM_TO };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        // Nothing is issued by this shortening, so there is nothing to sign: the only handshake in
        // play is the group confirmation itself.
        expect(preview.issues).toEqual([]);

        const error = await errorOf(() =>
          runPeriod(
            tx,
            scene,
            DISPATCHER,
            armed(command, preview, {
              operation: { operationId: randomUUID(), reason: 'без подтверждения' },
            }),
          ),
        );
        expect(error.statusCode).toBe(422);
        expect(error.message).toContain('Подтвердите перечень');

        // Nothing written: no term, no cancellation, no version.
        expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: EXTENDED_TO });
        expect((await rowsOf(tx, scene.requestId)).every((r) => r.superseded_at === null)).toBe(
          true,
        );
        expect(await versionOf(tx, scene.requestId)).toBe(0);
      },
    );
  });

  it('подтверждение, посчитанное по другому состоянию, не проходит', async () => {
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt: NEXT, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: TERM_TO };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);

        const error = await errorOf(() =>
          runPeriod(tx, scene, DISPATCHER, {
            ...armed(command, preview, {
              operation: { operationId: randomUUID(), reason: 'чужое подтверждение' },
            }),
            cancelGroupsFingerprint: 'чужой отпечаток',
          }),
        );
        expect(error.statusCode).toBe(422);
        expect(await versionOf(tx, scene.requestId)).toBe(0);
      },
    );
  });

  it('лишнее подтверждение у продления отвергается симметрично', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const preview = await previewPeriod(tx, scene, DISPATCHER, command);
      // The extension issues warned sheets, so `armed()` really does sign them here: this is the
      // case where the signatures, checked first, have to pass for the 422 below to be reached.
      expect(preview.issues.some((issue) => issue.warnings.length > 0)).toBe(true);

      const error = await errorOf(() =>
        runPeriod(tx, scene, DISPATCHER, {
          ...armed(command, preview),
          cancelGroupsFingerprint: 'лишнее',
        }),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('ничего не гасит в истории назначения');
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });

  /*
   * The order of step 8, pinned down. A shortening that re-issues a worked-out sheet needs three
   * handshakes at once: signatures (B4), the group confirmation (D2) and the unlock fingerprint
   * (D4). This door checks the signatures first, so with none of the three supplied `history`
   * answers 409 `waybill_ack_required` and `legacy`, where signatures are not required, answers the
   * D2 422.
   *
   * DIVERGENCE (order, not outcome): the repair door checks unlocks before signatures and says why
   * ("sign only sheets the command will actually get"), and plan §8 step 8 lists the unlock
   * fingerprint before the acknowledgements too; this door does the opposite. Nothing is written
   * either way — the difference is which refusal the person reads first.
   */
  it('[DIVERGENCE: history paper defects card] порядок рукопожатий: без подписей history отвечает 409 раньше, чем 422 за перечень групп', async () => {
    const splitAt = shiftDateKey(PREV, 2);
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: shiftDateKey(splitAt, -1) };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        expect(preview.cancelGroupsFingerprint).not.toBeNull();
        expect(preview.unlockFingerprint).not.toBeNull();
        // The preview is mode-independent: the re-issued sheet and its warnings are shown in both.
        expect(preview.issues.some((issue) => issue.warnings.length > 0)).toBe(true);
        const operation = { operationId: randomUUID(), reason: 'машина ушла с объекта раньше' };

        const bare = await errorOf(() =>
          runPeriod(tx, scene, DISPATCHER, {
            ...command,
            previewFingerprint: preview.fingerprint,
            operation,
          }),
        );
        expect({ status: bare.statusCode, code: bare.code }).toEqual(
          byReadMode(mode, {
            legacy: { status: 422, code: 'unprocessable_entity' },
            history: { status: 409, code: WAYBILL_ACK_REQUIRED_CODE },
          }),
        );
        if (mode === 'legacy') expect(bare.message).toContain('Подтвердите перечень');

        // Signed and confirmed, but the unlock fingerprint is still missing: 422 in both modes.
        const unlockMissing = await errorOf(() =>
          runPeriod(
            tx,
            scene,
            DISPATCHER,
            armed(command, preview, { confirmGroups: true, operation }),
          ),
        );
        expect(unlockMissing.statusCode).toBe(422);
        expect(unlockMissing.message).toContain('Список отработанных листов');
        expect(await versionOf(tx, scene.requestId)).toBe(0);
        expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: EXTENDED_TO });
      },
    );
  });

  /*
   * The fingerprint is asked UNCONDITIONALLY by this door — also after the check moved from its own
   * handshake into step 7 of the framework (R17, E4a). The scene sits exactly where the framework
   * default ("non-empty `effects.mutations`") would let the door through: an extension writes no
   * history row while its paper is non-empty. The door's `requiresPreview` is what holds the scene.
   *
   * Code and text are checked by name: the portal dispatches the 409 on `assignment_preview_stale`,
   * and moving the check had to leave it the same error in the same place.
   */
  it('устаревший предпросмотр — 409, даже когда история команды пуста', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const error = await errorOf(() =>
        runPeriod(tx, scene, DISPATCHER, { ...command, previewFingerprint: 'вчерашний' }),
      );
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('assignment_preview_stale');
      expect(error.message).toBe(
        'Последствия изменились с момента предпросмотра — посмотрите их заново и подтвердите',
      );
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });

  /*
   * A missing fingerprint is the same 409, not "body without a field": before E4a the door's own
   * handshake answered it (`undefined !== plan.fingerprint`), now step 7 does by the door's flag.
   * The difference shows only here: an extension has empty history, and the framework default
   * would apply this command with no confirmation at all.
   */
  it('вовсе не присланный отпечаток у продления — тот же отказ, а не тихое применение', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const error = await errorOf(() => runPeriod(tx, scene, DISPATCHER, { ...command }));
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('assignment_preview_stale');
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });
});

// ── R9: idempotency by the operation key ──

/** Strict sync events of the request: one per paper-touching run, written by the plan executor. */
async function esm2EventsOf(tx: SceneTx, requestId: string): Promise<number> {
  return (
    await tx.execute<{ id: string }>(sql`
      SELECT id FROM audit_log WHERE entity_id = ${requestId} AND action = 'waybill.esm2_sync'`)
  ).rows.length;
}

/*
 * Two runs, because the first command does paper work at step 12 and that work differs by mode:
 * `legacy` has the weekly sync burn (or trim) sheets, `history` executes the segment plan, which
 * may burn AND re-issue. A replay that reached step 12 again would do that work twice — burn the
 * fresh numbers and mint a third set — so each case compares the paper after the replay with the
 * paper after the first run row for row, versions and trim trail included.
 */
describeReadModes(readMode, 'правка срока: повтор по ключу операции (Р9)', (mode) => {
  it('второй запрос с тем же ключом возвращает прежний результат и не гасит второй раз', async () => {
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt: NEXT, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: TERM_TO };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        const operation = { operationId: randomUUID(), reason: 'техника уехала раньше' };
        const body = armed(command, preview, { confirmGroups: true, operation });
        const before = await sheetsOf(tx, scene.requestId);
        // The scene issued its paper through the weekly sync, which already wrote one event.
        const eventsBefore = await esm2EventsOf(tx, scene.requestId);

        const first = await runPeriod(tx, scene, DISPATCHER, body);
        expect(first.repeated).toBe(false);
        const versionAfter = await versionOf(tx, scene.requestId);
        const rowsAfter = await rowsOf(tx, scene.requestId);
        const sheetsAfter = await sheetsOf(tx, scene.requestId);
        // The first run did burn paper: every sheet beyond the new end of term, in both modes.
        const beyond = before.filter((sheet) => sheet.period_from > TERM_TO).map((s) => s.id);
        expect(beyond.length).toBeGreaterThan(0);
        expect(
          sheetsAfter.filter((sheet) => sheet.status === 'cancelled').map((s) => s.id),
        ).toEqual(beyond);
        expect(first.paper?.esm2.cancelled).toHaveLength(beyond.length);
        expect(await esm2EventsOf(tx, scene.requestId)).toBe(eventsBefore + 1);

        // The replay comes with the SAME body: the client lost the answer and resent the request.
        // The version has moved by now, which is why the replay is looked up before the version
        // check (§8, step 2).
        const second = await runPeriod(tx, scene, DISPATCHER, body);
        expect(second.repeated).toBe(true);
        expect(second.operation?.operationId).toBe(operation.operationId);
        expect(second.paper).toBeNull();
        expect(await versionOf(tx, scene.requestId)).toBe(versionAfter);
        expect(await rowsOf(tx, scene.requestId)).toEqual(rowsAfter);
        expect(await journalOf(tx, scene.requestId)).toHaveLength(1);
        expect(await sheetsOf(tx, scene.requestId)).toEqual(sheetsAfter);
        expect(await esm2EventsOf(tx, scene.requestId)).toBe(eventsBefore + 1);
      },
    );
  });

  it('повтор сокращения, переоформившего отработанный лист, не трогает бумагу второй раз', async () => {
    /*
     * The scene where the two executors part ways on the first run (see "права по исходу"): the
     * sheet covering the new last day is trimmed in place in `legacy` and burned and re-issued in
     * `history`. That is the state a replay must leave untouched — a second trim would bump the
     * version again, a second re-issue would burn the replacement.
     */
    const splitAt = shiftDateKey(PREV, 2);
    const lastDay = shiftDateKey(splitAt, -1);
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: lastDay };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        const operation = { operationId: randomUUID(), reason: 'машина ушла с объекта раньше' };
        const body = {
          ...armed(command, preview, { confirmGroups: true, operation }),
          unlockFingerprint: preview.unlockFingerprint!,
        };
        const before = await sheetsOf(tx, scene.requestId);
        const eventsBefore = await esm2EventsOf(tx, scene.requestId);
        const covering = before.find(
          (row) => row.period_from <= lastDay && row.period_to >= lastDay,
        )!;

        const first = await runPeriod(tx, scene, DISPATCHER, body);
        expect(first.repeated).toBe(false);
        const sheetsAfter = await sheetsOf(tx, scene.requestId);
        const coveringAfter = sheetsAfter.find((row) => row.id === covering.id)!;
        expect({ status: coveringAfter.status, version: coveringAfter.version }).toEqual(
          byReadMode(mode, {
            legacy: { status: 'issued', version: covering.version + 1 },
            history: { status: 'cancelled', version: covering.version },
          }),
        );
        // `history` minted a replacement for it; `legacy` kept the same number.
        expect(sheetsAfter.length - before.length).toBe(
          byReadMode(mode, { legacy: 0, history: first.paper?.esm2.issued.length ?? -1 }),
        );
        if (mode === 'history') expect(first.paper?.esm2.issued.length).toBeGreaterThan(0);
        expect(await esm2EventsOf(tx, scene.requestId)).toBe(eventsBefore + 1);

        const second = await runPeriod(tx, scene, DISPATCHER, body);
        expect(second.repeated).toBe(true);
        expect(second.paper).toBeNull();
        expect(await sheetsOf(tx, scene.requestId)).toEqual(sheetsAfter);
        expect(await esm2EventsOf(tx, scene.requestId)).toBe(eventsBefore + 1);
        expect(await journalOf(tx, scene.requestId)).toHaveLength(1);
      },
    );
  });
});

// ── Р32, Е3: права по посчитанному исходу ──

describeReadModes(readMode, 'правка срока: права по исходу (Р32, Е3)', (mode) => {
  it('сокращение, гасящее отработанную группу, спрашивает право коррекции', async () => {
    const splitAt = shiftDateKey(PREV, 2);
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: shiftDateKey(splitAt, -1) };
        const before = await sheetsOf(tx, scene.requestId);
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        // Прежний диапазон группы начинался в прошлой неделе — исход `crew` (Р32, Е3), и вместе с
        // ним появляется отпечаток разблокировок: подтверждать надо и пустое множество (Д4).
        expect(preview.operationRequirement).toMatchObject({ kind: 'crew' });
        expect(preview.unlockFingerprint).not.toBeNull();

        const body = armed(command, preview, {
          confirmGroups: true,
          operation: { operationId: randomUUID(), reason: 'машина ушла с объекта раньше' },
        });
        const refused = await errorOf(() =>
          runPeriod(tx, scene, MANAGER, { ...body, unlockFingerprint: preview.unlockFingerprint! }),
        );
        expect(refused.statusCode).toBe(403);
        expect(await versionOf(tx, scene.requestId)).toBe(0);

        // Тот же запрос от диспетчера проходит целиком: операция журнала заводится видом `crew`,
        // отработанная неделя переоформляется по названному серверным списком листу, а группа
        // гаснет. Это и есть та половина Е3, ради которой исход считается, а не назначается.
        const done = await runPeriod(tx, scene, DISPATCHER, {
          ...body,
          unlockFingerprint: preview.unlockFingerprint!,
        });
        expect(done.repeated).toBe(false);
        expect((await journalOf(tx, scene.requestId))[0]).toMatchObject({ kind: 'crew' });
        expect(await termOf(tx, scene.requestId)).toMatchObject({
          date_to: shiftDateKey(splitAt, -1),
        });
        const cancelled = (await rowsOf(tx, scene.requestId)).filter(
          (row) => row.superseded_kind === 'cancelled',
        );
        expect(cancelled.map((row) => row.effective_date)).toEqual([splitAt, splitAt]);
        /*
         * Бумага сошлась с новым сроком: затронутая часть укороченной первой недели переоформлена,
         * всё после срока сгорело. На затронутых днях границы у обоих исполнителей одни и те же —
         * а вот **машина в листе** разная, и это расхождение, ради которого разрез и затеян.
         *
         * Недельная сверка печатает пару из денормализации заявки, а та после гашения хвостовой
         * группы всё ещё показывает машину хвоста: правка срока назначения не двигает (Р17). То
         * есть затронутый лист за отработанные дни выписывается на машину, которой в эти дни у
         * заказа по истории не было. Отрезковый план берёт машину из истории отрезка — и печатает
         * ту, которая эти дни и работала.
         *
         * Тест, сверяющий только `period_from—period_to`, обе картины считает одинаковыми: границы
         * совпадают до дня. Поэтому здесь и стоит состав.
         *
         * А вот ЧИСЛО документов у укороченного срока — снова ответ портала, а не сцены: месяц
         * режет и два дня (ADR 0142), и если прошлый понедельник окажется последним числом, листов
         * станет два. Первый из них — отдельный строгий документ до области команды: замыкание его
         * не втягивает и попутно не чинит. Поэтому состав выбирается для каждого периода, а сам
         * перечень выведен из `esm2Periods`; одной строкой тест краснел бы на границе месяца.
         */
        expect(compositionOf(await sheetsOf(tx, scene.requestId))).toEqual(
          esm2Periods(PREV, shiftDateKey(splitAt, -1)).map((p) => {
            /*
             * Если конец месяца отделил прежний день в самостоятельный строгий документ, он
             * не пересекается с областью команды, начинающейся у гасимой группы, и остаётся на
             * денормализованной машине хвоста. Документ, содержащий последний день перед
             * группой, уже входит в замыкание и в history переоформляется на машину истории.
             */
            const vehicleInSheet = byReadMode(mode, {
              legacy: scene.vehicleB,
              history: p.to < shiftDateKey(splitAt, -1) ? scene.vehicleB : scene.vehicleA,
            });
            return `${p.from}—${p.to}|${vehicleInSheet}|${scene.personA}`;
          }),
        );

        /*
         * Чем именно бумага приведена к новому сроку — и здесь два исполнителя расходятся, а
         * состав выше этого не показывает: границы у обеих картин одни и те же.
         *
         * Смотрим на лист, накрывавший последний день нового срока. В `legacy` его состав совпал с
         * ожиданием (недельная сверка печатает пару из денормализации — ту же, что и при выписке),
         * начало не сдвинулось, а отнятый хвост не нужен никакому другому ожиданию: все пять
         * условий Р6 сошлись, и лист **правится на месте**. Номер не сгорел, строка та же, версия
         * поднята (без этого сторож печати Р21 стоит вхолостую), след правки записан, и ссылка на
         * операцию стоит — исход `crew` неординарен (Р12).
         *
         * В `history` машина листа разошлась с историей этих дней, а правка чинить состав не умеет
         * ни при каких входных данных: номер горит и выписывается новый. След сокращения у
         * сгоревшего листа обязан остаться пустым — иначе журнал объявил бы сокращённым бланк,
         * который изъят из оборота целиком.
         */
        const lastDay = shiftDateKey(splitAt, -1);
        const covering = before.find(
          (row) => row.period_from <= lastDay && row.period_to >= lastDay,
        )!;
        const after = (await sheetsOf(tx, scene.requestId)).find((row) => row.id === covering.id)!;
        if (mode === 'legacy') {
          expect(after.status).toBe('issued');
          expect(after.period_from).toBe(covering.period_from);
          expect(after.period_to).toBe(lastDay);
          expect(after.version).toBe(covering.version + 1);
          expect(after.period_to_original).toBe(covering.period_to);
          expect(after.period_trimmed_at).not.toBeNull();
          expect(after.period_trim_reason).toBe('машина ушла с объекта раньше');
          expect(after.period_trim_correction_id).toBe(
            (await journalOf(tx, scene.requestId))[0]!.id,
          );
        } else {
          expect(after.status).toBe('cancelled');
          expect(after.period_to).toBe(covering.period_to);
          expect(after.period_trimmed_at).toBeNull();
          expect(after.period_trim_correction_id).toBeNull();
        }
      },
    );
  });
});

// ── Заявка без техники: срок правят и у неё ──

describe.skipIf(!DB_URL)('правка срока: заказ без назначенной техники', () => {
  it('история не восстановима — дверь всё равно двигает срок и ничего не гасит', async () => {
    await inScene({ status: 'confirmed', bare: true }, async (tx, scene) => {
      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const preview = await previewPeriod(tx, scene, DISPATCHER, command);
      // Ни истории, ни бумаги: восстанавливать нечего, выписывать не на что.
      expect(preview.cancelGroups).toEqual([]);
      expect(preview.plan).toEqual({ cancel: [], issue: [] });
      expect(preview.operationRequirement).toBeNull();

      const outcome = await runPeriod(tx, scene, DISPATCHER, armed(command, preview));
      expect(outcome.repeated).toBe(false);
      expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: EXTENDED_TO });
      expect(await rowsOf(tx, scene.requestId)).toHaveLength(0);
      expect(await versionOf(tx, scene.requestId)).toBe(1);
    });
  });
});
