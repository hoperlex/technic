import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AccessSubject,
  type AssignmentVehicleCorrectionInput,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentCorrection from '../src/services/assignment-correction';
import type * as AssignmentWrite from '../src/services/assignment-write';
import type * as Esm2 from '../src/services/waybill-esm2';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Каждая команда здесь берёт управляющую строку модуля `FOR SHARE` (шаг 0
 * канона), а соседние файлы модуля эту же строку меняют и замораживают (план Ю27, Ю30). Прогон по
 * общей `TEST_DATABASE_URL` даёт падение, которое выглядит поломкой кода, а не гонкой файлов.
 */

/**
 * Периодная коррекция — правка прошлого решения о машине, адресуемая целью
 * ([assignment-correction.ts](../src/services/assignment-correction.ts); план
 * `docs/assignment-periods-plan.md`, Р7, Р9–Р13, Р32; §8, волна 3.3).
 *
 * ЗАЧЕМ БАЗА. Предмет здесь — сцепка четырёх таблиц, и ни одна из связей не воспроизводится на
 * объектах в памяти:
 *
 * 1. **история** — неизменяемые строки `vehicle_request_assignment_changes` с частичным UNIQUE по
 *    актуальным и составным FK цепочки замен (миграция `0166`): цель разрешается по ним двумя
 *    адресами (Р10), и «актуальная строка» — свойство базы, а не расчёта;
 * 2. **подписи смен** — `vehicle_request_shifts.approved_at`: снимаются они **ровно** в границах
 *    `approvalClearRange` (Р11), и проверить это можно только на живых строках соседних дней;
 * 3. **журнал коррекций** — `waybill_corrections` с ключом идемпотентности, снимком авторизации
 *    (`authorization_scope`, CHECK миграции `0166`) и `payload`;
 * 4. **денормализация** `vehicle_request_assignments` — Р17 проверяется каркасом по живому
 *    состоянию: коррекция прошлого не вправе сдвинуть то, чем заявка закрыта сейчас.
 *
 * ПОЧЕМУ ДЕНЬ РАСЧЁТА ФИКСИРОВАН. `asOf` уходит в команду аргументом — среда текущей недели: исход
 * (Р32) и граница «историческое/будущее» считаются по нему, и прогон, взявший «сегодня» из часов,
 * менял бы смысл половины случаев в зависимости от дня недели.
 *
 * ПОЧЕМУ СЦЕНА ЖИВЁТ В ОТКАТЫВАЕМОЙ ТРАНЗАКЦИИ, А КОМАНДА — В ЕЁ SAVEPOINT. Оставленные заявка,
 * люди и подписи испортили бы соседние файлы, а каркас обязан идти в **настоящей** транзакции —
 * иначе проверять откат было бы нечем. Исполнителем ему отдаётся вложенная транзакция сцены:
 * drizzle разворачивает её в `SAVEPOINT`.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_corr \
 *     npx vitest run test/assignment-correction.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/*
 * ЭСМ2-РАЗРЕЗ. Файл заводит **свою** базу через механику двух режимов: режим чтения живёт в
 * управляющей строке, одной на базу, и файл, который его переключает, обязан быть один на неё.
 */
const readMode = useReadModeDatabase('correction');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

// ── Календарь сцены ──
//
// Всё считается от понедельника текущей недели, а день расчёта — её среда: так у сцены есть и
// отработанная неделя (прошлая), и текущая, и предстоящая.

const MONDAY = weekStartKey(moscowDateKeyOf(new Date()));
/** День расчёта команды — среда текущей недели. */
const AS_OF = shiftDateKey(MONDAY, 2);
/** Понедельник прошлой недели: с него идёт срок. */
const PREV = shiftDateKey(MONDAY, -7);
/** Понедельник следующей недели. */
const NEXT = shiftDateKey(MONDAY, 7);
const TERM_FROM = PREV;
const TERM_TO = shiftDateKey(NEXT, 6);
/** Третье решение о машине в сцене `future`: им хвост истории уезжает за правимый отрезок. */
const TAIL_AT = shiftDateKey(NEXT, 3);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  correction: typeof AssignmentCorrection;
  command: typeof AssignmentCommand;
  esm2: typeof Esm2;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  // Окружение и своя база готовы хуком механики (`useReadModeDatabase`) — остаётся забрать клиента
  // и сервисы. Своя база нужна не ради изоляции сцен, а потому что режим чтения живёт в
  // управляющей строке, одной на базу: переключая его, файл иначе задел бы соседей.
  const { db, closeDb } = await import('../src/db/client');
  ctx = {
    db,
    closeDb,
    correction: await import('../src/services/assignment-correction'),
    command: await import('../src/services/assignment-command'),
    esm2: await import('../src/services/waybill-esm2'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Субъекты ──
//
// Права спрашиваются по посчитанному исходу (Р32), поэтому сцене нужны два субъекта: без
// коррекционного права и с ним.

/** Менеджер: коррекции задним числом у него нет вовсе (ADR 0101, Р4). */
const MANAGER: AccessSubject = { role: 'manager' };
/** Диспетчер: `waybills.correct` есть, предел тридцати дней остаётся. */
const DISPATCHER: AccessSubject = { role: 'dispatcher' };

// ── Сцена ──

interface SceneOptions {
  /**
   * Где стоит вторая машина. `past` — с понедельника текущей недели: тогда первый отрезок
   * (прошлая неделя) историчен и правится коррекцией с исходом `crew`. `future` — со следующего
   * понедельника, и правится уже **будущий** отрезок: исход `assignment_tail`, коррекционных прав
   * не требующий.
   */
  split: 'past' | 'future';
  /** Выписать бумагу на весь срок: сцена отказа «коррекция задевает действующие листы». */
  issueSheets?: boolean;
  /** Подписанные дни объекта: день из первого отрезка, его последний день и день второго. */
  approvals?: boolean;
}

interface Scene {
  requestId: string;
  userId: string;
  /** Машина первого отрезка — цель коррекции в сценах `past`. */
  vehicleA: string;
  /** Машина второго отрезка. */
  vehicleB: string;
  /** Машина, которой коррекция заменяет первую: «на самом деле работала эта». */
  vehicleC: string;
  personA: string;
  /** Дата второго vehicle-изменения. */
  splitAt: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники в работе с **разрезом**: машина A с начала срока, машина B со `splitAt`.
 *
 * Денормализация стоит на машине хвоста (B либо A — смотря где разрез): именно её проверяет Р17,
 * и сцена, оставившая назначение на первой машине, ловила бы не коррекцию, а собственную ошибку.
 */
async function inScene<T>(
  options: SceneOptions,
  run: (tx: SceneTx, scene: Scene) => Promise<T>,
): Promise<T> {
  const splitAt = options.split === 'past' ? MONDAY : NEXT;
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
          sql`SELECT id, vehicle_type_id FROM vehicles
               WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 3`,
        )
      ).rows;
      const [vehicleA, vehicleB, vehicleC] = fleet;
      if (!vehicleA || !vehicleB || !vehicleC) throw new Error('в парке меньше трёх своих машин');
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-corr-${RUN}@example.invalid`}, 'Историев', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      // Человек без действующей специализации водителя в лист не попадает вовсе (`findMachinist`),
      // и сверка сцены ответила бы «укажите машиниста» вместо бумаги.
      const personA = (
        await one(sql`INSERT INTO persons (last_name, first_name) VALUES ('Машинистов', 'Пров')
                      RETURNING id`)
      ).id!;
      await tx.execute(sql`
        INSERT INTO person_specializations (person_id, specialization_id, started_on)
        VALUES (${personA}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);

      /*
       * Хвост истории — **последнее** активное vehicle-изменение, и денормализация обязана его
       * повторять (Р17). В сцене `future` за разрезом стоит ещё одно решение — «с четверга
       * следующей недели снова A»: без него правился бы сам хвост, а его правит окно смены техники.
       */
      const tailVehicle = options.split === 'future' ? vehicleA : vehicleB;
      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicleA.vehicle_type_id}, 'confirmed',
                ${user.id}, 'materialized', ${AS_OF})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${TERM_FROM}, ${TERM_TO})`);
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${tailVehicle.id}, ${tailVehicle.vehicle_type_id},
                ${vehicleA.vehicle_type_id}, ${user.id})`);

      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'vehicle',
        vehicleId: vehicleA.id,
        origin: 'assignment',
      });
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'driver',
        driverState: 'set',
        driverPersonId: personA,
        origin: 'assignment',
      });
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: splitAt,
        dimension: 'vehicle',
        vehicleId: vehicleB.id,
        origin: 'reassignment',
      });

      if (options.split === 'future') {
        await insertChange(tx, {
          requestId: request.id!,
          effectiveDate: TAIL_AT,
          dimension: 'vehicle',
          vehicleId: vehicleA.id,
          origin: 'reassignment',
        });
      }

      if (options.approvals) {
        // Три дня: два в первом отрезке (его начало и последний день) и один во втором. Ровно на
        // них и видно, что снятие идёт по `approvalClearRange`, а не «по всей заявке».
        for (const date of [TERM_FROM, shiftDateKey(splitAt, -1), splitAt]) {
          await tx.execute(sql`
            INSERT INTO vehicle_request_shifts
              (request_id, shift_date, machine_hours, comment, filled_by, approved_by, approved_at)
            VALUES (${request.id}, ${date}, 8, '', ${user.id}, ${user.id}, now())`);
        }
      }

      if (options.issueSheets) {
        await ctx.esm2.syncEsm2Waybills(tx, {
          requestId: request.id!,
          actor: { id: user.id! },
          reason: 'сцена теста: бумага на весь срок',
          driverPersonId: personA,
          // Расчёт от начала срока: тогда лист получает и та неделя, что к среде уже отработана.
          asOf: TERM_FROM,
        });
        /*
         * ЭСМ2-РАЗРЕЗ. Событие сверки, записанное **подготовкой сцены**, из журнала убирается: с
         * этапа 5 `waybill.esm2_sync` пишет исполнитель плана и в той же транзакции, что и листы,
         * — в том числе когда сверку зовёт сцена. Утверждения файла о журнале говорят о команде.
         */
        await tx.execute(sql`DELETE FROM audit_log WHERE entity_id = ${request.id!}`);
      }

      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleA: vehicleA.id,
        vehicleB: vehicleB.id,
        vehicleC: vehicleC.id,
        personA,
        splitAt,
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
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${randomUUID()})`);
}

/** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

/** Предпросмотр — тем же колбэком `plan`, что и бой (§8). */
async function previewCorrection(
  tx: SceneTx,
  scene: Scene,
  input: AssignmentVehicleCorrectionInput,
) {
  const preview =
    await ctx.command.previewAssignmentCommand<AssignmentCorrection.VehicleCorrectionPlan>(
      executorOf(tx),
      {
        requestId: scene.requestId,
        actor: { id: scene.userId },
        asOf: AS_OF,
        plan: (planCtx) => ctx.correction.planVehicleCorrection(planCtx, input),
      },
    );
  return ctx.correction.correctionPreviewDto(
    preview.effects,
    preview.plan,
    preview.fingerprint,
    preview.asOf,
  );
}

/** Провести команду через каркас — ровно тем же способом, каким её проводит боевая ручка. */
function runCorrection(
  tx: SceneTx,
  scene: Scene,
  actor: AccessSubject,
  input: AssignmentVehicleCorrectionInput,
): Promise<
  AssignmentCommand.AssignmentCommandOutcome<
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCorrection.CorrectionPaper
  >
> {
  return ctx.command.runAssignmentCommand<
    AssignmentCorrection.VehicleCorrectionPlan,
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCorrection.CorrectionPaper
  >(
    executorOf(tx),
    ctx.correction.vehicleCorrectionSpec({
      requestId: scene.requestId,
      actor: { ...actor, id: scene.userId },
      input,
      asOf: AS_OF,
    }),
  );
}

/** Тело боевой команды по посчитанному предпросмотру: отпечаток и envelope журнала. */
function armed(
  body: AssignmentVehicleCorrectionInput,
  preview: { fingerprint: string },
  operation?: { operationId: string; reason: string },
): AssignmentVehicleCorrectionInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(operation ? { operation } : {}),
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

async function rowsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      vehicle_id: string | null;
      origin: string;
      correction_id: string | null;
      superseded_kind: string | null;
      superseded_at: string | null;
      supersedes_change_id: string | null;
    }>(sql`
      SELECT * FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} ORDER BY effective_date, created_at`)
  ).rows;
}

/** Актуальная vehicle-строка на эту дату — то, что видит свёртка. */
const vehicleOn = (rows: Awaited<ReturnType<typeof rowsOf>>, date: string): string | null => {
  const row = rows
    .filter(
      (r) => r.dimension === 'vehicle' && r.superseded_at === null && r.effective_date <= date,
    )
    .at(-1);
  return row?.vehicle_id ?? null;
};

async function shiftsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      shift_date: string;
      machine_hours: string;
      approved_by: string | null;
      approved_at: string | null;
    }>(sql`
      SELECT shift_date, machine_hours, approved_by, approved_at FROM vehicle_request_shifts
       WHERE request_id = ${requestId} ORDER BY shift_date`)
  ).rows;
}

async function journalOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      operation_id: string;
      kind: string;
      reason: string;
      authorization_scope: Record<string, unknown> | null;
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

/** Тело коррекции первого отрезка: цель — идентификатором либо логическим ключом (Р10). */
const correctionBody = (
  target: AssignmentVehicleCorrectionInput['target'],
  vehicleId: string,
): AssignmentVehicleCorrectionInput => ({ target, vehicleId, version: 0 });

// ── Р10: два адреса цели ──

describe('цель коррекции (Р10)', () => {
  it('идентификатор изменения: правится названная строка, соседний отрезок цел', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const before = await rowsOf(tx, scene.requestId);
      const targetId = before.find(
        (r) => r.dimension === 'vehicle' && r.effective_date === TERM_FROM,
      )!.id;

      const body = correctionBody({ changeId: targetId }, scene.vehicleC);
      const preview = await previewCorrection(tx, scene, body);
      // Исход исторический: первый отрезок кончился в воскресенье, а команда идёт средой (Р32).
      expect(preview.operationRequirement).toMatchObject({ kind: 'crew', reasonRequired: true });

      const outcome = await runCorrection(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, { operationId: randomUUID(), reason: 'в наряде была другая машина' }),
      );
      expect(outcome.repeated).toBe(false);

      const after = await rowsOf(tx, scene.requestId);
      const replaced = after.find((r) => r.id === targetId)!;
      // Строки истории неизменяемы (Р3): прежняя гаснет как `replaced`, новая ссылается на неё
      // обратной ссылкой — видно, что решение **уточнили**, а не отменили.
      expect(replaced.superseded_kind).toBe('replaced');
      const inserted = after.find((r) => r.supersedes_change_id === targetId)!;
      expect(inserted.vehicle_id).toBe(scene.vehicleC);
      expect(inserted.effective_date).toBe(TERM_FROM);
      expect(inserted.origin).toBe('reassignment');
      // Строка несёт операцию журнала: «почему в прошлой неделе вдруг другая машина» отвечается
      // ею, а не догадкой по `origin`.
      expect(inserted.correction_id).toBe(outcome.operation!.id);

      // Соседний отрезок не тронут: с понедельника по-прежнему машина хвоста.
      expect(vehicleOn(after, TERM_FROM)).toBe(scene.vehicleC);
      expect(vehicleOn(after, MONDAY)).toBe(scene.vehicleB);
      // Р17: денормализация — «чем заявка закрыта сейчас» — коррекцией прошлого не двигается.
      const assignment = (
        await tx.execute<{ vehicle_id: string }>(
          sql`SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${scene.requestId}`,
        )
      ).rows[0]!;
      expect(assignment.vehicle_id).toBe(scene.vehicleB);
      expect(await versionOf(tx, scene.requestId)).toBe(1);
    });
  });

  it('логический ключ «шкала + дата» правит ту же строку и даёт тот же отпечаток', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const before = await rowsOf(tx, scene.requestId);
      const targetId = before.find(
        (r) => r.dimension === 'vehicle' && r.effective_date === TERM_FROM,
      )!.id;

      const byKey = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const byId = correctionBody({ changeId: targetId }, scene.vehicleC);
      const previewKey = await previewCorrection(tx, scene, byKey);
      const previewId = await previewCorrection(tx, scene, byId);
      /*
       * Отпечаток считается по **содержанию** (Р20): один и тот же предпросмотр, показанный
       * порталу с идентификатором и повторённый логическим ключом, обязан сойтись. Иначе окно,
       * прочитавшее историю до нажатия, получало бы 409 на ровном месте.
       */
      expect(previewKey.fingerprint).toBe(previewId.fingerprint);

      await runCorrection(
        tx,
        scene,
        DISPATCHER,
        armed(byKey, previewKey, { operationId: randomUUID(), reason: 'по ключу' }),
      );
      const after = await rowsOf(tx, scene.requestId);
      expect(after.find((r) => r.id === targetId)!.superseded_kind).toBe('replaced');
      expect(after.find((r) => r.supersedes_change_id === targetId)!.vehicle_id).toBe(
        scene.vehicleC,
      );
    });
  });

  it('погашенная строка целью не бывает: логический ключ находит только актуальную', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const preview = await previewCorrection(tx, scene, body);
      await runCorrection(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, { operationId: randomUUID(), reason: 'первая коррекция' }),
      );
      const after = await rowsOf(tx, scene.requestId);
      const dead = after.find((r) => r.superseded_kind === 'replaced')!;
      // Прежняя строка описывает уже отменённое решение, и правка её была бы второй веткой той же
      // цепочки — а цепочка замен не ветвится по построению (Р10).
      const error = await errorOf(() =>
        previewCorrection(tx, scene, correctionBody({ changeId: dead.id }, scene.vehicleB)),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('уже заменено');
    });
  });
});

// ── Р11: подписи снимаются ровно в `approvalClearRange` ──

describe('подписи объекта (Р11)', () => {
  it('снимаются только в границах изменённого отрезка, а часы остаются', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past', approvals: true }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const preview = await previewCorrection(tx, scene, body);
      /*
       * Граница снятия — только диапазоны **vehicle**-изменений (Р11). У этой команды он один:
       * первый отрезок, от начала срока до дня перед разрезом. `paperRange` был бы шире на смены
       * машиниста, и подписи снимались бы там, где сменилась фамилия, а работа осталась той же.
       */
      expect(preview.approvalClearRange).toEqual([
        { from: TERM_FROM, to: shiftDateKey(MONDAY, -1) },
      ]);
      expect(preview.clearedApprovals.map((a) => a.date)).toEqual([
        TERM_FROM,
        shiftDateKey(MONDAY, -1),
      ]);

      const outcome = await runCorrection(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, { operationId: randomUUID(), reason: 'работала другая машина' }),
      );
      expect(outcome.paper!.clearedApprovals).toEqual([TERM_FROM, shiftDateKey(MONDAY, -1)]);

      const shifts = await shiftsOf(tx, scene.requestId);
      expect(shifts.map((s) => [s.shift_date, s.approved_at === null])).toEqual([
        [TERM_FROM, true],
        [shiftDateKey(MONDAY, -1), true],
        // День второго отрезка подписан по делу: в нём работала другая машина, и коррекция
        // первого отрезка эту подпись не опровергает.
        [MONDAY, false],
      ]);
      // Часы вносил объект, и коррекция машины их не опровергает: снимается подпись, а не работа.
      expect(shifts.every((s) => Number(s.machine_hours) === 8)).toBe(true);

      // Снимок операции хранит прежних подписантов: в таблице смен их больше нет, а «кто принял
      // эти часы» спрашивают через два месяца.
      const [journal] = await journalOf(tx, scene.requestId);
      const cleared = journal!.payload.clearedShiftApprovals as { date: string }[];
      expect(cleared.map((a) => a.date)).toEqual([TERM_FROM, shiftDateKey(MONDAY, -1)]);
    });
  });
});

// ── Р9: журнал коррекций один, повтор ничего не делает дважды ──

describe('операция журнала (Р9, Р32)', () => {
  it('исторической коррекции — вид `crew` со снимком авторизации', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const preview = await previewCorrection(tx, scene, body);
      const operationId = randomUUID();
      await runCorrection(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, { operationId, reason: 'ошибка наряда' }),
      );

      const journal = await journalOf(tx, scene.requestId);
      expect(journal).toHaveLength(1);
      expect(journal[0]!.kind).toBe('crew');
      expect(journal[0]!.operation_id).toBe(operationId);
      expect(journal[0]!.reason).toBe('ошибка наряда');
      /*
       * Снимок авторизации обязателен у видов истории (CHECK `waybill_corrections`): повтор спустя
       * недели проверяет **сохранённые требования**, а не пересчитывает глубину — операция, бывшая
       * моложе тридцати дней при первом вызове, к повтору успевает состариться.
       */
      expect(journal[0]!.authorization_scope).toMatchObject({
        schemaVersion: 1,
        requiresCorrect: true,
        requiresCorrectBeyondLimit: false,
        effectiveDate: TERM_FROM,
        authorizedAsOf: AS_OF,
      });
    });
  });

  it('будущий отрезок — вид `assignment_tail`: правка принятого решения без коррекционных прав', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'future' }, async (tx, scene) => {
      // Правится решение, вступающее в силу со следующего понедельника: прошлого оно не трогает,
      // но кто-то его уже принял — и подмена без объяснения оставила бы вопрос «почему» (Р32).
      const body = correctionBody({ dimension: 'vehicle', effectiveDate: NEXT }, scene.vehicleC);
      const preview = await previewCorrection(tx, scene, body);
      expect(preview.operationRequirement).toMatchObject({ kind: 'assignment_tail' });
      // Диапазон кончается днём перед следующим решением той же шкалы, а не концом срока (Р11).
      expect(preview.approvalClearRange).toEqual([{ from: NEXT, to: shiftDateKey(TAIL_AT, -1) }]);

      // Менеджер — субъект без `waybills.correct`: исход `assignment_tail` его не спрашивает.
      const outcome = await runCorrection(
        tx,
        scene,
        MANAGER,
        armed(body, preview, { operationId: randomUUID(), reason: 'перепутали единицу' }),
      );
      expect(outcome.operation!.kind).toBe('assignment_tail');

      const journal = await journalOf(tx, scene.requestId);
      expect(journal[0]!.authorization_scope).toMatchObject({
        requiresCorrect: false,
        requiresCorrectBeyondLimit: false,
        effectiveDate: NEXT,
      });
    });
  });

  it('исторической коррекции без права коррекции — 403, и ни одной записи', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past', approvals: true }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const preview = await previewCorrection(tx, scene, body);
      const error = await errorOf(() =>
        runCorrection(
          tx,
          scene,
          MANAGER,
          armed(body, preview, { operationId: randomUUID(), reason: 'без права' }),
        ),
      );
      expect(error.statusCode).toBe(403);
      // Авторизация стоит **до** первой записи (§8, шаг 9): ни строки журнала, ни снятой подписи.
      expect(await journalOf(tx, scene.requestId)).toEqual([]);
      expect((await shiftsOf(tx, scene.requestId)).every((s) => s.approved_at !== null)).toBe(true);
    });
  });

  it('повтор по `operationId`: работы нет, второй строки журнала нет, версия на месте', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past', approvals: true }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const preview = await previewCorrection(tx, scene, body);
      const operation = { operationId: randomUUID(), reason: 'ретрай той же кнопки' };
      const first = await runCorrection(tx, scene, DISPATCHER, armed(body, preview, operation));
      expect(first.repeated).toBe(false);
      const rowsAfterFirst = await rowsOf(tx, scene.requestId);
      const versionAfterFirst = await versionOf(tx, scene.requestId);

      /*
       * Повтор идёт **тем же телом и тем же ключом**: цель заново не разрешается и план не
       * считается — первая попытка предмет уже переписала, и пересчёт упёрся бы в погашенную цель
       * (Р9 п. 4). Отпечаток при этом сверяется: чужая команда с тем же ключом — 409.
       */
      const second = await runCorrection(tx, scene, DISPATCHER, armed(body, preview, operation));
      expect(second.repeated).toBe(true);
      expect(second.operation!.id).toBe(first.operation!.id);
      expect(second.applied).toBeNull();

      expect(await journalOf(tx, scene.requestId)).toHaveLength(1);
      expect(await rowsOf(tx, scene.requestId)).toEqual(rowsAfterFirst);
      expect(await versionOf(tx, scene.requestId)).toBe(versionAfterFirst);
      // Подпись второго отрезка не сняли ни первой попыткой, ни повтором.
      const shifts = await shiftsOf(tx, scene.requestId);
      expect(shifts.find((s) => s.shift_date === MONDAY)!.approved_at).not.toBeNull();
    });
  });

  it('тот же ключ с другой командой — 409, и это отказ общего журнала', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      const preview = await previewCorrection(tx, scene, body);
      const operationId = randomUUID();
      await runCorrection(
        tx,
        scene,
        DISPATCHER,
        armed(body, preview, { operationId, reason: 'первая команда' }),
      );

      const other = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleB,
      );
      const error = await errorOf(() =>
        runCorrection(
          tx,
          scene,
          DISPATCHER,
          armed(other, preview, { operationId, reason: 'другая команда тем же ключом' }),
        ),
      );
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain('Ключ операции уже занят другой командой');
    });
  });
});

// ── Границы двери (Р7, Р12) ──

/*
 * ЭСМ2-РАЗРЕЗ. Блок гоняется в **обоих** режимах чтения, и расходится в нём последний случай —
 * «действующий лист в области». В `legacy` бумагу пишет недельная `syncEsm2Waybills`: она знает
 * одну машину на заявку и переписала бы задетые недели машиной **назначения**, то есть вопреки
 * коррекции, — поэтому такая команда отвергается до единой записи. В `history` шаг 12 исполняет
 * отрезковый план, и та же команда проходит: лист прежней машины горит, взамен выходит лист
 * исправленной, а отработанный номер человек подтверждает отпечатком разблокировок (Р11).
 *
 * Обе половины остаются написанными: режим двигается в обе стороны (§10).
 */
describeReadModes(readMode, 'границы коррекции (Р7, Р12)', (mode) => {
  it('последнее решение о машине правит окно смены техники, а не коррекция', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const error = await errorOf(() =>
        previewCorrection(
          tx,
          scene,
          correctionBody({ dimension: 'vehicle', effectiveDate: MONDAY }, scene.vehicleC),
        ),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('окном смены техники');
    });
  });

  it('решение о машинисте этой дверью не правится', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const error = await errorOf(() =>
        previewCorrection(
          tx,
          scene,
          correctionBody({ dimension: 'driver', effectiveDate: TERM_FROM }, scene.vehicleC),
        ),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('машиниста');
    });
  });

  it('та же машина — пустое изменение (Р12)', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past' }, async (tx, scene) => {
      const error = await errorOf(() =>
        previewCorrection(
          tx,
          scene,
          correctionBody({ dimension: 'vehicle', effectiveDate: TERM_FROM }, scene.vehicleA),
        ),
      );
      expect(error.statusCode).toBe(422);
      expect(error.message).toContain('та же машина');
    });
  });

  it('действующий лист в области: до переключения чтения отказ, после — переоформление по отрезкам', async () => {
    if (!DB_URL) return;
    await inScene({ split: 'past', issueSheets: true, approvals: true }, async (tx, scene) => {
      const body = correctionBody(
        { dimension: 'vehicle', effectiveDate: TERM_FROM },
        scene.vehicleC,
      );
      /*
       * Предпросмотр обязан **показать**, что мешает, а не ответить отказом вместо плана: человек
       * должен увидеть номера, которые предстоит списать. Тем же порядком устроен отказ двери
       * ремонта «нужен режим восстановления».
       */
      const preview = await previewCorrection(tx, scene, body);
      expect(preview.blockingSheets.length).toBeGreaterThan(0);
      expect(preview.blockingSheets.every((sheet) => sheet.from <= shiftDateKey(MONDAY, -1))).toBe(
        true,
      );

      const expected = byReadMode(mode, {
        legacy: 'refused' as const,
        history: 'reissued' as const,
      });
      if (expected === 'refused') {
        /*
         * Недельная сверка — единственный исполнитель бумаги в `legacy`, и знает она одну машину
         * на заявку: переписала бы задетые недели машиной назначения, то есть вопреки коррекции.
         * Такая команда отвергается **до** записи истории.
         */
        const error = await errorOf(() =>
          runCorrection(
            tx,
            scene,
            DISPATCHER,
            armed(body, preview, { operationId: randomUUID(), reason: 'бумага мешает' }),
          ),
        );
        expect(error.statusCode).toBe(422);
        expect(error.message).toContain('ЭСМ-2');
        // Ю51: совета «выпишите листы по требованию» в отказе больше нет — ручная выписка ЭСМ-2
        // заведена только для линейной техники (`onDemandRefusal`), а линейный заказ эта дверь
        // отвергает выше. Взамен отказ называет срок: переоформление по отрезкам приедет с
        // переключением чтения.
        expect(error.message).not.toMatch(/по требованию/);
        expect(error.message).toMatch(/переключением чтения истории/);
        expect(await journalOf(tx, scene.requestId)).toEqual([]);
        expect((await shiftsOf(tx, scene.requestId)).every((s) => s.approved_at !== null)).toBe(
          true,
        );
        return;
      }

      /*
       * ЭСМ2-РАЗРЕЗ. Исполнитель отрезкового плана переоформляет прошлое: отрезок `TERM_FROM …
       * воскресенье` был отработан и его лист неприкосновенен, — значит операция обязана назвать
       * его поимённо, и подтверждается это отпечатком серверного множества, а не списком (Р11).
       */
      expect(preview.operationRequirement).toMatchObject({ kind: 'crew' });
      expect(preview.unlockFingerprint).not.toBeNull();
      expect(preview.requiredUnlocks.length).toBeGreaterThan(0);
      expect(preview.plan.cancel.map((c) => c.waybillId).sort()).toEqual(
        preview.requiredUnlocks.map((u) => u.waybillId).sort(),
      );
      // Выписывается тот же отрезок, но исправленной машиной: это и есть предмет коррекции.
      expect(preview.plan.issue.length).toBeGreaterThan(0);
      expect(preview.plan.issue.every((i) => i.vehicleId === scene.vehicleC)).toBe(true);

      const outcome = await runCorrection(tx, scene, DISPATCHER, {
        ...armed(body, preview, {
          operationId: randomUUID(),
          reason: 'по табелю в эти дни работала другая машина',
        }),
        unlockFingerprint: preview.unlockFingerprint ?? undefined,
      });
      expect(outcome.repeated).toBe(false);
      expect(outcome.paper?.esm2.cancelled).toHaveLength(preview.plan.cancel.length);
      expect(outcome.paper?.esm2.issued).toHaveLength(preview.plan.issue.length);

      // Бумага исправленного отрезка стоит на новой машине, а её сгоревший номер объяснён
      // операцией: и списание, и выпуск ссылаются на одну строку журнала (Р35).
      const sheets = await sheetsOf(tx, scene.requestId);
      const fresh = sheets.filter((sheet) => sheet.status !== 'cancelled');
      expect(fresh.some((sheet) => sheet.vehicle_id === scene.vehicleC)).toBe(true);
      const burned = sheets.filter((sheet) => sheet.status === 'cancelled');
      expect(burned.length).toBeGreaterThan(0);
      expect(burned.every((sheet) => sheet.cancel_correction_id !== null)).toBe(true);

      // Событие сверки — ровно одно и в той же транзакции: владелец у него один (§7).
      const events = (
        await tx.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
          SELECT action, metadata FROM audit_log
           WHERE entity_id = ${scene.requestId} AND action = 'waybill.esm2_sync'`)
      ).rows;
      expect(events).toHaveLength(1);
      expect(Array.isArray(events[0]!.metadata.replacements)).toBe(true);

      // Подписи снимаются по `approvalClearRange`, а не по всей заявке, — как и в `legacy`.
      const shifts = await shiftsOf(tx, scene.requestId);
      expect(shifts.filter((s) => s.approved_at === null).length).toBeGreaterThan(0);
      expect(shifts.some((s) => s.approved_at !== null)).toBe(true);
    });
  });
});

/** Листы заявки со статусом и ссылками операции: ими проверяется переоформление по отрезкам. */
async function sheetsOf(tx: SceneTx, requestId: string) {
  return (
    await tx.execute<{
      id: string;
      period_from: string;
      period_to: string;
      vehicle_id: string;
      status: string;
      cancel_correction_id: string | null;
      correction_id: string | null;
      corrects_waybill_id: string | null;
    }>(sql`
      SELECT id, period_from, period_to, vehicle_id, status, cancel_correction_id, correction_id,
             corrects_waybill_id
        FROM waybills WHERE source_request_id = ${requestId} ORDER BY period_from, id`)
  ).rows;
}
