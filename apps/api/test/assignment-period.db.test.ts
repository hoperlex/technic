import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useReadModeDatabase } from './assignment-read-mode';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
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
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Каждая команда здесь берёт управляющую строку модуля `FOR SHARE` (шаг 0
 * канона), а соседние файлы модуля эту же строку меняют и замораживают (план Ю27, Ю30). Заводит и
 * сносит базу механика `useReadModeDatabase`; режим чтения при этом остаётся тем, каким его
 * привозит миграция `0167`, — `legacy`.
 *
 * ПОЧЕМУ ФАЙЛ НЕ ХОДИТ ДВУМЯ РЕЖИМАМИ. Своего поведения по режиму у этой двери нет: дремлющих
 * записей она не заводит (Р24 гасит, а не пишет), а весь разговор с режимом ведёт бэкстоп чужой
 * двери — он же и проверяется двумя прогонами в `assignment-backstop.db.test.ts`. Заводить здесь
 * второй набор ожиданий значило бы проверять чужой предмет: в `history` сокращение с гашением
 * упирается в расхождение хвоста (Р31), которое оно само же и создаёт, — и это поведение бэкстопа,
 * а не правки срока.
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
      // Человек без действующей специализации водителя в лист не попадает вовсе (`findMachinist`),
      // и сверка сцены ответила бы «укажите машиниста» вместо бумаги.
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

/** Тело боевой команды по посчитанному предпросмотру: отпечатки и envelope журнала. */
function armed(
  body: PeriodCommand,
  preview: { fingerprint: string; cancelGroupsFingerprint: string | null },
  extra: { operation?: { operationId: string; reason: string }; confirmGroups?: boolean } = {},
): PeriodApplyInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(extra.confirmGroups && preview.cancelGroupsFingerprint
      ? { cancelGroupsFingerprint: preview.cancelGroupsFingerprint }
      : {}),
    ...(extra.operation ? { operation: extra.operation } : {}),
  };
}

const errorOf = async (run: () => Promise<unknown>): Promise<Error & { statusCode?: number }> => {
  try {
    await run();
  } catch (e) {
    return e as Error & { statusCode?: number };
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
    await tx.execute<{ id: string; period_from: string; period_to: string; status: string }>(sql`
      SELECT id, period_from, period_to, status FROM waybills
       WHERE source_request_id = ${requestId} ORDER BY period_from`)
  ).rows;
}

const activeSheets = (rows: Awaited<ReturnType<typeof sheetsOf>>) =>
  rows.filter((row) => row.status !== 'cancelled');

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

describe.skipIf(!DB_URL)('правка срока: продление и сокращение (Д2, Е3)', () => {
  it('продление добавляет неделю бумаги, истории не трогает и журнала не заводит', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const before = await sheetsOf(tx, scene.requestId);
      expect(activeSheets(before)).toHaveLength(2);

      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const preview = await previewPeriod(tx, scene, DISPATCHER, command);
      // Исход `none`: продление вперёд ничего о прошлом не утверждает (Р32).
      expect(preview.operationRequirement).toBeNull();
      expect(preview.unlockFingerprint).toBeNull();
      expect(preview.plan.issue.map((i) => `${i.from}—${i.to}`)).toEqual([
        `${NEXT}—${EXTENDED_TO}`,
      ]);

      const outcome = await runPeriod(tx, scene, DISPATCHER, armed(command, preview));
      expect(outcome.repeated).toBe(false);
      expect(outcome.operation).toBeNull();
      expect(outcome.paper?.esm2.issued).toHaveLength(1);

      expect(await termOf(tx, scene.requestId)).toMatchObject({ date_to: EXTENDED_TO });
      expect(activeSheets(await sheetsOf(tx, scene.requestId))).toHaveLength(3);
      // История не тронута: продление её не пишет вовсе — оно лишь открывает дни.
      expect((await rowsOf(tx, scene.requestId)).every((r) => r.superseded_at === null)).toBe(true);
      expect(await journalOf(tx, scene.requestId)).toHaveLength(0);
      // Версия поднимается **любым** успешным выполнением, включая исход `none` (§8, шаг 14).
      expect(await versionOf(tx, scene.requestId)).toBe(1);
    });
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
        // Бумага следующей недели сгорела вместе с днями, которых у заказа больше нет.
        expect(activeSheets(await sheetsOf(tx, scene.requestId))).toHaveLength(2);
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

// ── Д2: подтверждение перечня гасимых групп ──

describe.skipIf(!DB_URL)('правка срока: подтверждение гашения (Д2)', () => {
  it('без подтверждения — 422 с перечнем, и срок остаётся прежним', async () => {
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt: NEXT, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: TERM_TO };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);

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

        // Ничего не записано: ни срока, ни гашения, ни версии.
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

      const error = await errorOf(() =>
        runPeriod(tx, scene, DISPATCHER, {
          ...armed(command, preview),
          cancelGroupsFingerprint: 'лишнее',
        }),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('ничего не гасит в истории назначения');
    });
  });

  it('устаревший предпросмотр — 409, даже когда история команды пуста', async () => {
    await inScene({ status: 'confirmed', issueSheets: true }, async (tx, scene) => {
      const command: PeriodCommand = { version: 0, dateTo: EXTENDED_TO };
      const error = await errorOf(() =>
        runPeriod(tx, scene, DISPATCHER, { ...command, previewFingerprint: 'вчерашний' }),
      );
      expect(error.statusCode).toBe(409);
      expect(await versionOf(tx, scene.requestId)).toBe(0);
    });
  });
});

// ── Р9: идемпотентность по ключу операции ──

describe.skipIf(!DB_URL)('правка срока: повтор по ключу операции (Р9)', () => {
  it('второй запрос с тем же ключом возвращает прежний результат и не гасит второй раз', async () => {
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt: NEXT, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: TERM_TO };
        const preview = await previewPeriod(tx, scene, DISPATCHER, command);
        const operation = { operationId: randomUUID(), reason: 'техника уехала раньше' };
        const body = armed(command, preview, { confirmGroups: true, operation });

        const first = await runPeriod(tx, scene, DISPATCHER, body);
        expect(first.repeated).toBe(false);
        const versionAfter = await versionOf(tx, scene.requestId);
        const rowsAfter = await rowsOf(tx, scene.requestId);

        // Повтор идёт **тем же телом**: клиент потерял ответ и прислал запрос заново. Версия к
        // этому моменту уже другая, и именно поэтому повтор ищется до её сверки (§8, шаг 2).
        const second = await runPeriod(tx, scene, DISPATCHER, body);
        expect(second.repeated).toBe(true);
        expect(second.operation?.operationId).toBe(operation.operationId);
        expect(await versionOf(tx, scene.requestId)).toBe(versionAfter);
        expect(await rowsOf(tx, scene.requestId)).toEqual(rowsAfter);
        expect(await journalOf(tx, scene.requestId)).toHaveLength(1);
      },
    );
  });
});

// ── Р32, Е3: права по посчитанному исходу ──

describe.skipIf(!DB_URL)('правка срока: права по исходу (Р32, Е3)', () => {
  it('сокращение, гасящее отработанную группу, спрашивает право коррекции', async () => {
    const splitAt = shiftDateKey(PREV, 2);
    await inScene(
      { status: 'done', dateTo: EXTENDED_TO, splitAt, issueSheets: true },
      async (tx, scene) => {
        const command: PeriodCommand = { version: 0, dateTo: shiftDateKey(splitAt, -1) };
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
        // Бумага сошлась с новым сроком: на укороченную первую неделю выписан новый номер, всё
        // остальное сгорело.
        expect(
          activeSheets(await sheetsOf(tx, scene.requestId)).map(
            (s) => `${s.period_from}—${s.period_to}`,
          ),
        ).toEqual([`${PREV}—${shiftDateKey(splitAt, -1)}`]);
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
