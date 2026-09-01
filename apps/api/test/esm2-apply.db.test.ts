import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  esm2Periods,
  moscowDateKeyOf,
  shiftDateKey,
  waybillDisplayNumber,
  weekStartKey,
  type AccessSubject,
  type AssignmentCommandInput,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentCrew from '../src/services/assignment-crew';
import type * as AssignmentWrite from '../src/services/assignment-write';
import type * as Esm2 from '../src/services/waybill-esm2';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * Исполнитель плана ЭСМ-2 — `applyEsm2SyncPlanAndAudit`
 * ([waybill-esm2.ts](../src/services/waybill-esm2.ts); план `docs/assignment-periods-plan.md`, Р5,
 * Р11, Р32, §7, §8 шаг 12, §10).
 *
 * ЭСМ2-РАЗРЕЗ. ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, ЕСЛИ ДВЕРИ УЖЕ ЗЕЛЁНЫЕ. Двери проверяют **свой предмет** —
 * человека, срок, цель коррекции, — и бумагу трогают попутно. У исполнителя предмет свой, и
 * главное его утверждение ни одна дверь не формулирует: **одна и та же команда в двух режимах
 * обязана дать разную бумагу, и обе верны**. В `legacy` бумагу ведёт недельная сверка, в `history`
 * — отрезковый план, и переключение между ними обратимо (§10). Файл, гоняющий один режим, о второй
 * половине этого обещания не знает вовсе.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ — И ПОЧЕМУ СОСТАВОМ, А НЕ ЧИСЛОМ.
 *
 * 1. **Разрез недели**: смена машиниста в среду при выписанной неделе. В `legacy` команда
 *    отвергается гейтом совместимости — недельная сверка такой границы не воспроизводит; в
 *    `history` неделя законно становится двумя документами: пн–вт прежним человеком, ср–вс новым.
 *    Утверждается **состав** каждого листа (границы, машина, человек): счётчик листов совпал бы и
 *    у бумаги, выписанной не на того, — а это ровно та ошибка, ради которой разрез и делается.
 * 2. **Строгое событие**: `waybill.esm2_sync` пишется **в той же транзакции** и **ровно один раз**,
 *    несёт соответствие `issueKey → waybillId` и граф замен. Прежде его писали шесть внешних
 *    вызовов после коммита и через best-effort `writeAudit`.
 * 3. **Откат по сбою события**: искусственный сбой на записи события откатывает и бумагу. Он же
 *    доказывает, что событие вообще пишется этой транзакцией: пишись оно чужим соединением, триггер
 *    сработал бы на нём, ошибку проглотил бы `writeAudit`, и листы остались бы жить.
 * 4. **Номера бланков**: строгая отчётность тратится по одному номеру на выписанный лист — ни
 *    дважды, ни мимо. Сгоревшие номера не переиспользуются.
 *
 * ПОЧЕМУ ДЕНЬ РАСЧЁТА ФИКСИРОВАН. `asOf` уходит в команду аргументом — среда текущей недели: от
 * него считаются граница отменяемости листа и исход (Р32), и прогон, взявший «сегодня» из часов,
 * менял бы смысл половины случаев в зависимости от дня недели.
 *
 * ПОЧЕМУ СЦЕНА ЖИВЁТ В ОТКАТЫВАЕМОЙ ТРАНЗАКЦИИ, А КОМАНДА — В ЕЁ SAVEPOINT. Сожжённые номера
 * бланков и оставленные заявки испортили бы соседние случаи, а каркас обязан идти в **настоящей**
 * транзакции — иначе проверять откат было бы нечем.
 *
 * Запуск (база из переменной может быть любой — своя всё равно заводится рядом и сносится следом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_apply \
 *     npx vitest run test/esm2-apply.db.test.ts
 */

/** Своя база и режим чтения на ней; стоит до собственного `beforeAll` — см. шапку механики. */
const readMode = useReadModeDatabase('esm2apply');

/** Хвост прогона: учётка живёт внутри откатываемой транзакции, но email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

// ── Календарь сцены ──

const MONDAY = weekStartKey(moscowDateKeyOf(new Date()));
/** Понедельник прошлой недели: с него идёт срок, и её лист ко дню расчёта уже отработан. */
const PREV = shiftDateKey(MONDAY, -7);
/** Понедельник следующей недели. */
const NEXT = shiftDateKey(MONDAY, 7);
const TERM_FROM = PREV;
const TERM_TO = shiftDateKey(NEXT, 6);
/**
 * Периоды бумаги срока — тем же расчётом, каким их режет портал (`esm2Periods`).
 *
 * Считаются, а не перечисляются тремя понедельниками: кроме воскресенья лист режет ещё и конец
 * месяца (ADR 0142), и в последнюю неделю месяца тот же срок даёт четыре документа вместо трёх.
 * Перечень дат зеленел бы три недели из четырёх — то есть врал бы ровно тогда, когда его читают.
 */
const TERM_PERIODS = esm2Periods(TERM_FROM, TERM_TO);
/**
 * День расчёта команды — среда текущей недели, а если среда не годится, ближайший следующий день,
 * который годится. Годность одна: период листа, внутрь которого попал день, обязан **начинаться
 * строго раньше** него самого.
 *
 * ЗАЧЕМ ЭТО УСЛОВИЕ. На нём стоит предмет главного случая файла — «смена машиниста в среду режет
 * неделю надвое». Резать можно только то, у чего есть обе половины: дни периода до даты команды и
 * дни с неё. Совпади начало периода с датой — резать нечего, оба плана дают один и тот же
 * документ, гейт совместимости пропускает команду, и `legacy` вместо ожидаемого отказа «режет уже
 * выписанную неделю» отвечает согласием. Портал при этом прав: неисполнима сама посылка сцены.
 *
 * ПОЧЕМУ ДЕНЬ СЧИТАЕТСЯ, А НЕ ПИШЕТСЯ ЦИФРОЙ. Пока лист был всегда недельным, «понедельник + 2»
 * условию удовлетворял всегда. Месячный разрез (ADR 0142) это сломал: когда первое число месяца
 * попадает ровно на среду, неделя даёт «пн–вт» и «ср–вс», и второй кусок открывается тем же днём,
 * что и расчёт. Перебором по трёхлетию таких дней 40 из 1095 — примерно две недели в году, и
 * краснели бы они не за дело. Пропуском их закрывать нельзя: покрытие не должно теряться ни в один
 * день года (решение приёмки 01.09.2026), — поэтому двигается день расчёта, а не набор. Тем же
 * приёмом и по той же причине подобран `AS_OF` в
 * [assignment-crew.db.test.ts](assignment-crew.db.test.ts), где на нём стоит половина файла.
 *
 * Дальше четверга перебор не уходит никогда: месячная граница внутри недели бывает только одна,
 * поэтому годным оказывается либо первый кандидат, либо следующий за ним. Воскресенье записано
 * как предел: день расчёта обязан остаться внутри текущей недели, иначе он сравнялся бы с `NEXT`.
 */
const AS_OF = ((): string => {
  for (let offset = 2; offset <= 6; offset += 1) {
    const day = shiftDateKey(MONDAY, offset);
    const period = TERM_PERIODS.find((p) => p.from <= day && day <= p.to);
    if (period && period.from < day) return day;
  }
  throw new Error('в текущей неделе не нашлось дня, у которого период листа начался бы раньше');
})();
/**
 * Периоды, которые сверка на день расчёта ещё **может** переоформить: их последний день не раньше
 * `AS_OF`. Прочие отработаны и неприкосновенны (ADR 0101, Р21) — их листов сверка не гасит, а на их
 * дни второго документа не выписывает.
 *
 * Пока лист был всегда недельным, эту границу можно было спрашивать у понедельника: периодов до
 * текущей недели ровно один — прошлая, и её последний день всегда раньше дня расчёта. С месячным
 * разрезом (ADR 0142) в текущей неделе появляется второй период — августовский кусок «31–31», — и
 * ко дню расчёта он тоже прошлое. Отбор по понедельнику назвал бы его переоформляемым, а портал
 * прав, что его не трогает.
 */
const REISSUABLE = TERM_PERIODS.filter((period) => period.to >= AS_OF);
/**
 * Первый день бумаги, до которой сверка дотягивается.
 *
 * Им и отбирается ожидаемая выписка, а не концом каждой строки: период, попавший под разрез даты,
 * даёт **две** строки, и первая из них кончается вчера. Дырой в прошлом она при этом не является —
 * дни держал лист, который эта же сверка и гасит, — и требовать от неё «конец не раньше `AS_OF`»
 * значило бы отнять у портала законную половину разреза.
 */
const REISSUABLE_FROM = REISSUABLE[0]!.from;

/**
 * Ожидаемый состав бумаги: `границы|машина|человек` по каждому периоду срока.
 *
 * `after` — день смены машиниста: период, внутрь которого он попал, разрезается надвое, и дни до
 * него остаются за прежним человеком. Не передан — вся бумага на нём одном.
 */
function compositionFor(
  vehicleId: string,
  before: string,
  after?: { from: string; personId: string },
): string[] {
  const line = (from: string, to: string, personId: string): string =>
    `${from}|${to}|${vehicleId}|${personId}`;
  return TERM_PERIODS.flatMap((period) => {
    if (!after || period.to < after.from) return [line(period.from, period.to, before)];
    if (period.from >= after.from) return [line(period.from, period.to, after.personId)];
    return [
      line(period.from, shiftDateKey(after.from, -1), before),
      line(after.from, period.to, after.personId),
    ];
  });
}

/** Диспетчер: `waybills.correct` есть, предел тридцати дней остаётся. */
const DISPATCHER: AccessSubject = { role: 'dispatcher' };

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  crew: typeof AssignmentCrew;
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
    crew: await import('../src/services/assignment-crew'),
    command: await import('../src/services/assignment-command'),
    esm2: await import('../src/services/waybill-esm2'),
  };
}, 180_000);

afterAll(async () => {
  await ctx?.closeDb();
});

// ── Сцена ──

interface Scene {
  requestId: string;
  userId: string;
  vehicleA: string;
  personA: string;
  personB: string;
}

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/**
 * Заказ спецтехники в работе: собственная машина на весь срок, история материализована, бумага
 * выписана на все три недели срока.
 *
 * Бумага выписывается **расчётом от начала срока**, а не от дня команды: иначе прошедшая неделя
 * листа не получила бы вовсе (`esm2SyncPlan` её не заводит), и проверять «прошлое не тронуто» было
 * бы не на чем.
 */
async function inScene<T>(run: (tx: SceneTx, scene: Scene) => Promise<T>): Promise<T> {
  let out: T;
  await ctx.db
    .transaction(async (tx) => {
      const one = async (q: Parameters<typeof tx.execute>[0]): Promise<Record<string, string>> => {
        const [row] = (await tx.execute<Record<string, string>>(q)).rows;
        if (!row) throw new Error('в справочнике пусто: сцену не собрать');
        return row;
      };
      const obj = await one(sql`SELECT id FROM construction_objects LIMIT 1`);
      const vehicle = await one(sql`
        SELECT id, vehicle_type_id FROM vehicles
         WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 1`);
      const user = await one(sql`
        INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
        VALUES (${`ap-apply-${RUN}@example.invalid`}, 'Историев', 'Пров', 'x', 'admin', false)
        RETURNING id`);
      const spec = await one(sql`SELECT id FROM specializations WHERE code = 'driver'`);
      // Человек без действующей специализации водителя в лист не попадает вовсе (`findMachinist`),
      // и сверка ответила бы «укажите машиниста» вместо бумаги.
      const person = async (last: string): Promise<string> => {
        const row = await one(
          sql`INSERT INTO persons (last_name, first_name) VALUES (${last}, 'Пров') RETURNING id`,
        );
        await tx.execute(sql`
          INSERT INTO person_specializations (person_id, specialization_id, started_on)
          VALUES (${row.id}, ${spec.id}, ${shiftDateKey(TERM_FROM, -400)})`);
        return row.id!;
      };
      const personA = await person('Машинистов');
      const personB = await person('Сменщиков');

      const request = await one(sql`
        INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by,
                                      assignment_history_state, assignment_history_validated_on)
        VALUES ('special_equipment', ${obj.id}, ${vehicle.vehicle_type_id}, 'confirmed',
                ${user.id}, 'materialized', ${AS_OF})
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${request.id}, ${TERM_FROM}, ${TERM_TO})`);
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        VALUES (${request.id}, ${vehicle.id}, ${vehicle.vehicle_type_id},
                ${vehicle.vehicle_type_id}, ${user.id})`);

      // История, какой её оставил бы бэкфилл: машина и человек с начала срока.
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'vehicle',
        vehicleId: vehicle.id!,
      });
      await insertChange(tx, {
        requestId: request.id!,
        effectiveDate: TERM_FROM,
        dimension: 'driver',
        driverPersonId: personA,
      });

      await ctx.esm2.syncEsm2Waybills(tx, {
        requestId: request.id!,
        actor: { id: user.id! },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId: personA,
        asOf: TERM_FROM,
      });
      /*
       * Событие сверки, записанное подготовкой сцены, из журнала убирается: владелец события один,
       * и пишет он его в той же транзакции, что и листы, — в том числе когда сверку зовёт сцена.
       * Утверждения файла о журнале говорят о **команде**, а не о декорациях.
       */
      await tx.execute(sql`DELETE FROM audit_log WHERE entity_id = ${request.id!}`);

      out = await run(tx, {
        requestId: request.id!,
        userId: user.id!,
        vehicleA: vehicle.id!,
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
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverPersonId ? 'set' : null}, 'assignment',
            ${randomUUID()})`);
}

/** Исполнитель команды — вложенная транзакция сцены: настоящая транзакция с настоящим откатом. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

function setBody(overrides: {
  driverPersonId: string;
  effectiveDate: string;
}): AssignmentCommandInput {
  return { kind: 'set', dimension: 'driver', version: 0, ...overrides } as AssignmentCommandInput;
}

async function previewCrew(tx: SceneTx, scene: Scene, input: AssignmentCommandInput) {
  const preview = await ctx.command.previewAssignmentCommand<AssignmentCrew.CrewPlan>(
    executorOf(tx),
    {
      requestId: scene.requestId,
      actor: { id: scene.userId },
      asOf: AS_OF,
      plan: (planCtx) => ctx.crew.planCrewCommand(planCtx, input),
    },
  );
  return ctx.crew.crewPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
}

function runCrew(
  tx: SceneTx,
  scene: Scene,
  input: AssignmentCommandInput,
): Promise<
  AssignmentCommand.AssignmentCommandOutcome<
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCrew.CrewPaper
  >
> {
  return ctx.command.runAssignmentCommand<
    AssignmentCrew.CrewPlan,
    AssignmentWrite.AssignmentWriteResult,
    AssignmentCrew.CrewPaper
  >(
    executorOf(tx),
    ctx.crew.crewCommandSpec({
      requestId: scene.requestId,
      actor: { ...DISPATCHER, id: scene.userId },
      input,
      asOf: AS_OF,
    }),
  );
}

/** Тело боевой команды по посчитанному предпросмотру: отпечаток, разблокировки и envelope. */
function armed(
  body: AssignmentCommandInput,
  preview: { fingerprint: string; unlockFingerprint: string | null },
  reason?: string,
): AssignmentCommandInput {
  return {
    ...body,
    previewFingerprint: preview.fingerprint,
    ...(preview.unlockFingerprint ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    ...(reason ? { operation: { operationId: randomUUID(), reason } } : {}),
  } as AssignmentCommandInput;
}

const errorOf = async (run: () => Promise<unknown>): Promise<Error & { statusCode?: number }> => {
  try {
    await run();
  } catch (e) {
    return e as Error & { statusCode?: number };
  }
  throw new Error('ожидался отказ, а команда прошла');
};

/**
 * Текст отказа по **всей цепочке причин**: слова триггера живут в ошибке драйвера, а верхняя
 * обёртка драйвера пересказывает только сам запрос.
 */
function fullMessageOf(error: unknown): string {
  let text = '';
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { message?: string; cause?: unknown };
    if (typeof candidate.message === 'string') text += `${candidate.message}\n`;
    current = candidate.cause;
  }
  return text;
}

// ── Чтение состояния ──

interface SheetRow {
  id: string;
  period_from: string;
  period_to: string;
  vehicle_id: string;
  driver_person_id: string;
  status: string;
  number: string;
  prefix: string;
  number_width: number;
}

/** Печатный вид номера — тем же правилом, каким его печатает бланк и называет журнал. */
const displayNumberOf = (row: SheetRow): string =>
  waybillDisplayNumber(row.prefix, Number(row.number), row.number_width);

/** Все листы заявки — и действующие, и сгоревшие: номер бланка не исчезает вместе со статусом. */
async function sheetsOf(tx: SceneTx, requestId: string): Promise<SheetRow[]> {
  return (
    await tx.execute<SheetRow>(sql`
      SELECT w.id, w.period_from, w.period_to, w.vehicle_id, w.driver_person_id, w.status,
             w.number::text AS number, s.prefix, s.number_width
        FROM waybills w JOIN waybill_series s ON s.id = w.series_id
       WHERE w.source_request_id = ${requestId}
       ORDER BY w.period_from, w.id`)
  ).rows;
}

/** Действующий лист составом: границы, машина, человек — то, чем документы и различаются. */
const compositionOf = (rows: readonly SheetRow[]): string[] =>
  rows
    .filter((row) => row.status !== 'cancelled')
    .map((row) => `${row.period_from}|${row.period_to}|${row.vehicle_id}|${row.driver_person_id}`);

interface Esm2Event {
  action: string;
  metadata: {
    reason?: string;
    cancelled?: string[];
    issued?: string[];
    issuedKeys?: { issueKey: number; waybillId: string; displayNumber: string }[];
    replacements?: { waybillId: string; displayNumber: string; issueKey: number }[];
  };
}

async function esm2EventsOf(tx: SceneTx, requestId: string): Promise<Esm2Event[]> {
  return (
    await tx.execute<Esm2Event>(sql`
      SELECT action, metadata FROM audit_log
       WHERE entity_id = ${requestId} AND action = 'waybill.esm2_sync'
       ORDER BY created_at, id`)
  ).rows;
}

/** Следующий свободный номер серии ЭСМ-2 — им и меряется расход строгой отчётности. */
async function nextNumberOf(tx: SceneTx): Promise<number> {
  const [row] = (
    await tx.execute<{ next_number: string }>(
      sql`SELECT next_number::text AS next_number FROM waybill_series WHERE code = 'esm2'`,
    )
  ).rows;
  if (!row) throw new Error('серии ЭСМ-2 нет: миграции наполнения не применены');
  return Number(row.next_number);
}

// ── Разрез недели: одна команда, два режима, разная бумага ──

describeReadModes(readMode, 'исполнитель плана ЭСМ-2 (§7, §8 шаг 12)', (mode) => {
  it('смена машиниста в среду: неделя режется надвое только после переключения чтения', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      const before = await sheetsOf(tx, scene.requestId);
      expect(compositionOf(before)).toEqual(compositionFor(scene.vehicleA, scene.personA));

      const body = setBody({ effectiveDate: AS_OF, driverPersonId: scene.personB });
      const expected = byReadMode(mode, { legacy: 'refused' as const, history: 'split' as const });

      if (expected === 'refused') {
        /*
         * Недельная сверка знает **одну** пару «машина + машинист» на заявку и печатает её во всех
         * листах, которые выписывает: границу «со среды» она не воспроизводит вовсе — переписала бы
         * неделю целиком одним человеком. Гейт совместимости отвергает такую команду до единой
         * записи (Б1, В3).
         */
        const failure = await errorOf(() => previewCrew(tx, scene, body));
        expect(failure.statusCode).toBe(422);
        expect(failure.message).toMatch(/режет уже выписанную неделю/);
        // Ни один номер не сгорел и ни один не выписан: до шага 12 команда не доходит.
        expect(await sheetsOf(tx, scene.requestId)).toEqual(before);
        return;
      }

      /*
       * ЭСМ2-РАЗРЕЗ. После переключения чтения тот же разрез — обычная работа: единица
       * ответственности за бланк стала отрезком постоянного состава (Р5). Лист пн–вс горит, и
       * вместо него выходят **два** документа: пн–вт прежним человеком и ср–вс новым.
       *
       * Пн–вт при этом уже прошли, и выписываются они **не** как дыра в прошлом (Р21 её запрещает),
       * а как замена документу, который эта же сверка и гасит: дни держал сгоревший лист.
       */
      const preview = await previewCrew(tx, scene, body);
      // Выписывается всё, кроме отработанных периодов: они неприкосновенны (Р11). В переходную
      // неделю таких периодов не один, а два — прошлая неделя и августовский кусок текущей.
      expect(preview.plan.issue.map((i) => `${i.from}|${i.to}|${i.driverPersonId}`)).toEqual(
        compositionFor(scene.vehicleA, scene.personA, { from: AS_OF, personId: scene.personB })
          .filter((composed) => (composed.split('|')[0] as string) >= REISSUABLE_FROM)
          .map((composed) => {
            const [from, to, , personId] = composed.split('|');
            return `${from}|${to}|${personId}`;
          }),
      );

      const outcome = await runCrew(tx, scene, armed(body, preview));
      expect(outcome.repeated).toBe(false);
      // Исход `none` (Р32, строка 4): дата — сегодня, отработанного прошлого команда не задевает.
      expect(outcome.effects?.operationOutcome).toBe('none');

      const after = await sheetsOf(tx, scene.requestId);
      // Утверждается СОСТАВ, а не число: бумага, выписанная не на того человека, дала бы то же
      // количество листов — и это ровно та ошибка, ради которой разрез и заведён.
      expect(compositionOf(after)).toEqual(
        compositionFor(scene.vehicleA, scene.personA, { from: AS_OF, personId: scene.personB }),
      );
      // Отработанная неделя не тронута вовсе — тот же лист с тем же номером (Р11).
      expect(after[0]!.id).toBe(before[0]!.id);
      // Переоформление — это аннулирование номера и выписка нового, а не правка бланка: сгорело
      // всё, кроме отработанного. Отработанное отделяется тем же правилом, каким его отделяет
      // портал (`canCancelWaybill`): лист жив, пока его последний день не раньше дня расчёта.
      // Понедельник этой границей быть перестал — в переходную неделю он сам лежит внутри уже
      // отработанного куска «31–31 августа» (ADR 0142).
      const burned = after.filter((row) => row.status === 'cancelled').map((row) => row.id);
      expect(burned.sort()).toEqual(
        before
          .filter((row) => row.period_to >= AS_OF)
          .map((row) => row.id)
          .sort(),
      );
    });
  });

  it('событие сверки — одно, транзакционное, с соответствием issueKey → waybillId и графом замен', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      // Дата — граница недели: такую команду воспроизводят **оба** исполнителя, и случай меряет
      // событие, а не разрез. Дата в прошлом, значит исход `crew` — с причиной и правом (Р32).
      const before = await sheetsOf(tx, scene.requestId);
      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      const outcome = await runCrew(
        tx,
        scene,
        armed(body, preview, 'с понедельника вышел другой машинист'),
      );
      expect(outcome.effects?.operationOutcome).toBe('crew');

      const events = await esm2EventsOf(tx, scene.requestId);
      // Ровно одно, и записано оно **этой** транзакцией: сцена свой след стёрла, а внешних вызовов
      // после коммита больше не существует.
      expect(events).toHaveLength(1);
      const metadata = events[0]!.metadata;
      expect(metadata.reason).toBe('с понедельника вышел другой машинист');

      const sheets = await sheetsOf(tx, scene.requestId);
      const live = sheets.filter((row) => row.status !== 'cancelled');
      const burned = sheets.filter((row) => row.status === 'cancelled');

      /*
       * Номера в событии — печатные, те же, что на бланках: журнал читают глазами, а не джойном.
       * Собираются они тем же правилом, каким их печатает лист (`waybillDisplayNumber`), — своё
       * написание разошлось бы с бланком на первой же смене ширины номера в серии.
       *
       * Сгоревшие сверяются со **всеми** аннулированными листами заявки: до команды их не было.
       * Выписанные — с листами, родившимися этой командой; действующая бумага шире, в ней стоит и
       * нетронутая отработанная неделя, которую команда не выписывала.
       */
      const fresh = live.filter((row) => !before.some((old) => old.id === row.id));
      expect([...(metadata.cancelled ?? [])].sort()).toEqual(burned.map(displayNumberOf).sort());
      expect([...(metadata.issued ?? [])].sort()).toEqual(fresh.map(displayNumberOf).sort());
      // И ровно те же, что дверь вернула вызывающему: второго ответа о сгоревшей бумаге нет.
      expect([...(metadata.issued ?? [])].sort()).toEqual(
        outcome.paper!.esm2.issued.slice().sort(),
      );
      expect([...(metadata.cancelled ?? [])].sort()).toEqual(
        outcome.paper!.esm2.cancelled.slice().sort(),
      );

      /*
       * Соответствие `issueKey → waybillId`. Из двух массивов строк его не собрать — порядок
       * массива связью не является, — а при исходе `none` граф замен не хранится больше нигде.
       */
      const issuedKeys = metadata.issuedKeys ?? [];
      expect(issuedKeys).toHaveLength(outcome.paper!.esm2.issued.length);
      expect([...new Set(issuedKeys.map((k) => k.issueKey))]).toHaveLength(issuedKeys.length);
      for (const key of issuedKeys) {
        expect(fresh.some((row) => row.id === key.waybillId)).toBe(true);
      }

      // Граф замен: каждое ребро называет сгоревший лист и наследника по его ключу.
      const replacements = metadata.replacements ?? [];
      expect(replacements.length).toBeGreaterThan(0);
      for (const edge of replacements) {
        expect(burned.some((row) => row.id === edge.waybillId)).toBe(true);
        expect(issuedKeys.some((key) => key.issueKey === edge.issueKey)).toBe(true);
      }
    });
  });

  it('сбой на записи события откатывает и бумагу: события нет — нет и выписки', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      const before = await sheetsOf(tx, scene.requestId);
      const numbersBefore = await nextNumberOf(tx);

      /*
       * Триггер на `audit_log` — единственный способ упасть ровно на записи события. Он же и
       * доказывает, что событие пишется **этой** транзакцией: пишись оно чужим соединением (общий
       * `writeAudit` берёт своё и глушит ошибку), команда прошла бы насквозь, а листы остались бы
       * жить. Создаётся внутри сцены и откатывается вместе с ней.
       */
      const fn = `zz_esm2_sync_boom_${RUN}`;
      await tx.execute(
        sql.raw(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'ИСКУССТВЕННЫЙ СБОЙ НА СОБЫТИИ СВЕРКИ' USING ERRCODE = 'check_violation';
        END
        $fn$`),
      );
      await tx.execute(
        sql.raw(`
        CREATE TRIGGER ${fn} AFTER INSERT ON audit_log
          FOR EACH ROW WHEN (NEW.action = 'waybill.esm2_sync')
          EXECUTE FUNCTION ${fn}()`),
      );

      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      const failure = await errorOf(() =>
        runCrew(tx, scene, armed(body, preview, 'смена машиниста с понедельника')),
      );
      expect(
        fullMessageOf(failure),
        'событие не писалось вовсе — триггер не сработал, и команда прошла бы насквозь',
      ).toContain('ИСКУССТВЕННЫЙ СБОЙ НА СОБЫТИИ СВЕРКИ');

      await tx.execute(sql.raw(`DROP TRIGGER ${fn} ON audit_log`));
      await tx.execute(sql.raw(`DROP FUNCTION ${fn}()`));

      // Ни бумаги, ни события, ни расхода бланков: сбой откатил всю команду целиком.
      expect(await sheetsOf(tx, scene.requestId)).toEqual(before);
      expect(await esm2EventsOf(tx, scene.requestId)).toEqual([]);
      expect(await nextNumberOf(tx)).toBe(numbersBefore);
    });
  });

  it('номера бланков: по одному на выписанный лист, сгоревшие не переиспользуются', async () => {
    if (!readMode.enabled) return;
    await inScene(async (tx, scene) => {
      const before = await sheetsOf(tx, scene.requestId);
      const numbersBefore = await nextNumberOf(tx);

      const body = setBody({ effectiveDate: MONDAY, driverPersonId: scene.personB });
      const preview = await previewCrew(tx, scene, body);
      const outcome = await runCrew(
        tx,
        scene,
        armed(body, preview, 'с понедельника вышел другой машинист'),
      );

      const issued = outcome.paper!.esm2.issued;
      const cancelled = outcome.paper!.esm2.cancelled;
      expect(issued.length).toBeGreaterThan(0);
      expect(cancelled.length).toBe(issued.length);

      /*
       * Счётчик серии двигается ровно на число выписанных листов. Меньше — значит номер выдан
       * дважды и два бланка строгой отчётности носят одну цифру; больше — значит номер сгорел
       * впустую, а в журнале учёта это утраченный бланк, а не откат.
       */
      expect(await nextNumberOf(tx)).toBe(numbersBefore + issued.length);

      const after = await sheetsOf(tx, scene.requestId);
      // Номера уникальны по всей заявке — и у живых, и у сгоревших.
      const numbers = after.map((row) => row.number);
      expect([...new Set(numbers)]).toHaveLength(numbers.length);
      // Сгоревшие номера остались за своими листами: аннулирование их не освобождает.
      const burnedNumbers = new Set(
        after.filter((row) => row.status === 'cancelled').map((row) => row.number),
      );
      for (const row of after.filter((r) => r.status !== 'cancelled')) {
        expect(burnedNumbers.has(row.number)).toBe(false);
      }
      // Прежние листы никуда не делись — они аннулированы, а не переписаны (ADR 0037).
      for (const row of before) {
        expect(after.some((r) => r.id === row.id && r.number === row.number)).toBe(true);
      }
    });
  });
});
