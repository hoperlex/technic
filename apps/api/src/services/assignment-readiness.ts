import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { formatVehicleRequestNumber, moscowDateKeyOf } from '@technic/contracts';
import type * as schema from '../db/schema';
import {
  ASSIGNMENT_HISTORY_ALGO_VERSION,
  ATTESTATION_MAX_AGE_MS,
  type AssignmentReadMode,
  type AssignmentWriteMode,
} from './assignment-mode';

/**
 * Готовность модуля истории назначения к переключению чтения — **предикат, а не рассуждение**
 * (план `docs/assignment-periods-plan.md`, этап 4, волна 4.2; Р20, Р26, Р27, Р28, М1, Ж2, З1).
 *
 * ЗАЧЕМ ОН ЗДЕСЬ ОТДЕЛЬНЫМ МОДУЛЕМ. К этапу 5 вопрос «готовы ли мы» задают числами: сколько заявок
 * в каком состоянии, сколько невосстановимо и почему, что с метками загрязнения, чем обосновано
 * переключение. Ответы на них лежали в четырёх местах — колонки заявок, manifest поколения,
 * управляющая строка, отчёт прогона в файле, — и человек собирал их глазами. Собранные глазами,
 * они и расходились: `ready` у всех, но поколение вчерашнее; поколение сегодняшнее, но у трёхсот
 * заявок истории нет вовсе. Здесь предикат выражен один раз и машинно: {@link
 * assignmentCutoverReadiness} возвращает перечень **препятствий** с числами, а не «да/нет» без
 * объяснения.
 *
 * ДВА ЯРУСА, И ЭТО РЕШЕНИЕ, А НЕ ОФОРМЛЕНИЕ. Вопросов на самом деле два, и смешивать их нельзя:
 *
 * - **данные** (`data`) — готова ли история: предикат Р20 с расширением Р28, метки загрязнения,
 *   пересчёт на сегодняшний день, расхождения последнего поколения. Ответ на него имеет смысл в
 *   любой день, и он же — мера того, сколько работы осталось;
 * - **окно** (`window`) — можно ли нажимать **прямо сейчас**: полная заморозка записи, поколение
 *   сегодняшнего дня, свежая непотреблённая аттестация, сошедшиеся версии. Вне окна cutover он
 *   красный по построению — портал работает, запись открыта, аттестации нет.
 *
 * Слей мы их в один флаг — отчёт был бы красным всегда и его перестали бы читать. Разведённые, они
 * отвечают на разные вопросы: первый — «сколько ещё чинить», второй — «сейчас или нет».
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Он ничего не разрешает и ничего не пишет. Единственная дверь
 * переключения — `setModuleMode`/`checkActivation` ([assignment-mode.ts](assignment-mode.ts)), и
 * решает она сама, по своим блокировкам и в своей транзакции. Этот модуль — **предполётная
 * проверка**: он читает то же состояние без блокировок и заранее, чтобы человек не узнавал о
 * трёхстах неготовых заявках из отказа двери в окне выката.
 *
 * ГДЕ ОН СТРОЖЕ ДВЕРИ, И ЭТО НАМЕРЕННО. Дверь активации проверяет метку загрязнения и день
 * пересчёта, но **не** проверяет сам предикат Р20: заявка в состоянии `empty` её проверки проходит
 * (в запросе устаревания состояние `empty` исключено явно — у него и `validated_on` нет по
 * ограничению схемы). Плана это не отменяет: «предикат cutover такие заявки не пропускает» —
 * прямая формулировка Р20/Р28, и раз в двери её нет, отвечать на неё обязан отчёт. Расхождение
 * одностороннее: отчёт может сказать «не готов» там, где дверь пропустит, но не наоборот. Обратное
 * расхождение было бы ложным зелёным, и держит его тест
 * ([assignment-report.db.test.ts](../../test/assignment-report.db.test.ts)).
 *
 * ЧЕМ ЧИТАЕТ. Своим соединением: модуль не импортирует ни прикладной пул, ни конфиг — его грузит
 * административная команда `scripts/assignment-report.ts` на maintenance-кредах (П7, З3), которой
 * ни JWT, ни S3, ни почта не нужны. Отсюда же запрет на импорт [assignment-shadow.ts](assignment-shadow.ts):
 * тот через боевой расчёт бумаги тянет весь env приложения. Поколение здесь читается **счётом по
 * manifest'у**, без правил сравнения: разбор расхождений по причинам — работа команды
 * `assignment:shadow mismatches`, и второй классификации причин быть не должно.
 */

type AppDatabase = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
/** Читателю блокировки не нужны: предполётная проверка смотрит на состояние, а не держит его. */
export type ReadinessReader = Tx | AppDatabase;

// ───────────────────────────────── предикат популяции ─────────────────────────────────

/**
 * Предикат готовности Р20 с расширением Р28 — дословно и в одном месте на весь портал.
 *
 * Готовность требуется от заказа спецтехники в статусе «В работе» или «Выполнена», **включая
 * архивные** (архив сохраняет статус, а восстановление возвращает заявку в бумагообразующий
 * режим), — поэтому `deleted_at` здесь не спрашивается вовсе. Заявка без срока в предикат не
 * входит: срок — это то, по чему считаются отрезки, и без него история не строится ни у кого.
 *
 * Псевдонимы фиксированы: `r` — `vehicle_requests`, `d` — `special_equipment_request_details`.
 * Фрагмент годится и под `JOIN`, и под `LEFT JOIN`: у заявки без деталей `d.date_from` пуст, и
 * условие отсекает её само. Отсюда же требование к вызывающему — не переименовывать псевдонимы.
 *
 * Копия этого предиката жила в прогоне бэкфилла ([scripts/assignment-backfill.ts](../../scripts/assignment-backfill.ts));
 * теперь он берёт её отсюда. Две копии предиката cutover означали бы, что «готово» у прогона и
 * «готово» у отчёта считаются по разным множествам заявок, — а различить это по числам нельзя.
 */
export const ASSIGNMENT_READINESS_POPULATION = sql`
  r.request_type = 'special_equipment'
  AND r.status IN ('confirmed', 'done')
  AND d.date_from IS NOT NULL`;

// ───────────────────────────────── числа состояния ─────────────────────────────────

/** Сколько заявок в каком состоянии — и сколько из них мешают переключению. */
export interface AssignmentPopulationCounts {
  /** День, на который считалась валидность: устаревание меряется им, а не часами процесса. */
  asOf: string;
  /** Заявок в предикате Р20 + Р28. */
  total: number;
  empty: number;
  materialized: number;
  ready: number;
  /** Архивные внутри популяции: они в предикате, и это первое, что спрашивают, увидев число. */
  archived: number;
  /**
   * Заявки в `empty`, у которых нет назначенной машины (Ю64).
   *
   * Восстанавливать историю такой заявке не от чего: прогон её пропустит и в следующий раз, а
   * чинит её диспетчер — назначением техники либо закрытием заказа. Отдельное число потому, что у
   * него другой адресат: остальные `empty` доводит прогон, эти — человек.
   */
  emptyWithoutAssignment: number;
  /**
   * Метка загрязнения — по **всей** таблице, а не по популяции.
   *
   * Так её считает дверь разморозки и активации (`requireNoDirtyRequests`): метка означает, что
   * внутри дня история разошлась с бумагой, и календарное правило устаревания об этом молчит (К4).
   * Считай мы её по популяции — число расходилось бы с тем, по которому дверь откажет.
   */
  dirty: number;
  /**
   * Состояние считалось не на `asOf` — тоже по всей таблице и той же формулой, что у двери:
   * состояние не `empty` и `validated_on` пуст либо отличается от дня.
   *
   * Вне окна cutover ненулевое значение — норма: границу изменяемого двигает календарь, и заявка
   * пересчитывается лениво, при первом же обращении (З1). Ноль здесь требуется только к
   * переключению, и добивается он прогоном ревалидации.
   */
  stale: number;
}

export async function readAssignmentPopulation(
  reader: ReadinessReader,
  asOf: string,
): Promise<AssignmentPopulationCounts> {
  /*
   * Один проход по `vehicle_requests` на все восемь чисел. Раздельными запросами это стоило бы
   * восьми сканов ради согласованности, которой у них всё равно нет: между запросами база живёт.
   * `LEFT JOIN` — чтобы метки загрязнения и устаревания считались по всей таблице (так их считает
   * дверь), а состояния — только по популяции.
   */
  const [row] = (
    await reader.execute<Record<string, number>>(sql`
      SELECT count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION})::int AS total,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'empty')::int AS empty,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'materialized')::int AS materialized,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'ready')::int AS ready,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.deleted_at IS NOT NULL)::int AS archived,
             count(*) FILTER (WHERE ${ASSIGNMENT_READINESS_POPULATION}
                                AND r.assignment_history_state = 'empty'
                                AND a.request_id IS NULL)::int AS empty_without_assignment,
             count(*) FILTER (WHERE r.assignment_history_dirty)::int AS dirty,
             count(*) FILTER (WHERE r.assignment_history_state <> 'empty'
                                AND (r.assignment_history_validated_on IS NULL
                                     OR r.assignment_history_validated_on <> ${asOf}::date))::int AS stale
        FROM vehicle_requests r
        LEFT JOIN special_equipment_request_details d ON d.request_id = r.id
        LEFT JOIN vehicle_request_assignments a ON a.request_id = r.id`)
  ).rows;
  if (!row) throw new Error('База не ответила на подсчёт популяции готовности');
  return {
    asOf,
    total: Number(row.total ?? 0),
    empty: Number(row.empty ?? 0),
    materialized: Number(row.materialized ?? 0),
    ready: Number(row.ready ?? 0),
    archived: Number(row.archived ?? 0),
    emptyWithoutAssignment: Number(row.empty_without_assignment ?? 0),
    dirty: Number(row.dirty ?? 0),
    stale: Number(row.stale ?? 0),
  };
}

/** Какие заявки стоят за числом: человеку разбирать их по номерам, а не по счётчику. */
export type ReadinessSample =
  'empty_with_assignment' | 'empty_without_assignment' | 'materialized' | 'dirty' | 'stale';

/**
 * Номера заявок для отчёта — не больше `limit`.
 *
 * Порядок по номеру, а не по идентификатору: список читает человек, и «ТС-118, ТС-231, ТС-274»
 * находится в портале, а `uuid` — нигде.
 */
export async function sampleReadinessRequests(
  reader: ReadinessReader,
  kind: ReadinessSample,
  asOf: string,
  limit = 10,
): Promise<string[]> {
  /*
   * Перечень обязан совпадать с числом, рядом с которым он напечатан: «мешает одна заявка, вот
   * две» читается как ошибка счёта, и правы будут читающие. Поэтому `empty` разведён на две
   * выборки — ровно по двум препятствиям, у которых разные адресаты.
   */
  const filter = {
    empty_with_assignment: sql`${ASSIGNMENT_READINESS_POPULATION}
      AND r.assignment_history_state = 'empty'
      AND EXISTS (SELECT 1 FROM vehicle_request_assignments a WHERE a.request_id = r.id)`,
    empty_without_assignment: sql`${ASSIGNMENT_READINESS_POPULATION}
      AND r.assignment_history_state = 'empty'
      AND NOT EXISTS (SELECT 1 FROM vehicle_request_assignments a WHERE a.request_id = r.id)`,
    materialized: sql`${ASSIGNMENT_READINESS_POPULATION} AND r.assignment_history_state = 'materialized'`,
    dirty: sql`r.assignment_history_dirty`,
    stale: sql`r.assignment_history_state <> 'empty'
      AND (r.assignment_history_validated_on IS NULL
           OR r.assignment_history_validated_on <> ${asOf}::date)`,
  }[kind];

  const rows = await reader.execute<{ num: number }>(sql`
    SELECT r.num
      FROM vehicle_requests r
      LEFT JOIN special_equipment_request_details d ON d.request_id = r.id
     WHERE ${filter}
     ORDER BY r.num
     LIMIT ${limit}`);
  return [...rows.rows].map((row) => formatVehicleRequestNumber(Number(row.num)));
}

// ───────────────────────────────── управляющий контур ─────────────────────────────────

/** Режим модуля вместе со временем последней перемены: «сколько уже заморожено» — тоже число. */
export interface AssignmentModeState {
  writeMode: AssignmentWriteMode;
  readMode: AssignmentReadMode;
  cutoverRunId: string | null;
  updatedAt: Date;
}

export async function readAssignmentModeState(
  reader: ReadinessReader,
): Promise<AssignmentModeState | null> {
  const [row] = (
    await reader.execute<{
      write_mode: AssignmentWriteMode;
      read_mode: AssignmentReadMode;
      cutover_run_id: string | null;
      updated_at: Date;
    }>(sql`
      SELECT write_mode, read_mode, cutover_run_id, updated_at
        FROM assignment_periods_control
       WHERE id = true`)
  ).rows;
  if (!row) return null;
  return {
    writeMode: row.write_mode,
    readMode: row.read_mode,
    cutoverRunId: row.cutover_run_id,
    updatedAt: new Date(row.updated_at),
  };
}

/** Поколение теневого сравнения — заголовок и счёт по manifest'у, без правил сравнения. */
export interface ShadowRunState {
  runId: string;
  status: 'building' | 'running' | 'completed' | 'failed';
  asOf: string;
  algoVersion: string;
  buildVersion: string;
  expectedChecks: number;
  startedAt: Date;
  finishedAt: Date | null;
  total: number;
  pending: number;
  match: number;
  mismatch: number;
}

/**
 * Поколение по идентификатору либо последнее заведённое.
 *
 * «Последнее» — по времени начала: оператор помнит, что запускал прогон час назад, а не его `uuid`.
 * Для отчёта этого достаточно, а переключение всё равно требует явного `--run` у двери.
 */
export async function readShadowRunState(
  reader: ReadinessReader,
  runId?: string,
): Promise<ShadowRunState | null> {
  const [row] = (
    await reader.execute<{
      run_id: string;
      status: ShadowRunState['status'];
      as_of: string;
      algo_version: string;
      build_version: string;
      expected_checks: number;
      started_at: Date;
      finished_at: Date | null;
      total: number;
      pending: number;
      matched: number;
      mismatch: number;
    }>(sql`
      SELECT run.run_id, run.status, run.as_of::text AS as_of, run.algo_version, run.build_version,
             run.expected_checks, run.started_at, run.finished_at,
             coalesce(c.total, 0)::int AS total,
             coalesce(c.pending, 0)::int AS pending,
             coalesce(c.matched, 0)::int AS matched,
             coalesce(c.mismatch, 0)::int AS mismatch
        FROM assignment_shadow_runs run
        LEFT JOIN LATERAL (
               SELECT count(*) AS total,
                      count(*) FILTER (WHERE status = 'pending') AS pending,
                      count(*) FILTER (WHERE status = 'match') AS matched,
                      count(*) FILTER (WHERE status = 'mismatch') AS mismatch
                 FROM assignment_shadow_checks
                WHERE run_id = run.run_id) c ON true
       ${runId ? sql`WHERE run.run_id = ${runId}::uuid` : sql``}
       ORDER BY run.started_at DESC
       LIMIT 1`)
  ).rows;
  if (!row) return null;
  return {
    runId: row.run_id,
    status: row.status,
    asOf: row.as_of,
    algoVersion: row.algo_version,
    buildVersion: row.build_version,
    expectedChecks: Number(row.expected_checks),
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    total: Number(row.total),
    pending: Number(row.pending),
    match: Number(row.matched),
    mismatch: Number(row.mismatch),
  };
}

/** Аттестация деплоя (О4): чем доказан раскат, которым переключают. */
export interface AttestationState {
  id: string;
  attestedAt: Date;
  ageMs: number;
  activeBuildShas: string[];
  algoVersion: string;
  legacyClientCalls: number;
}

/**
 * Последняя **непотреблённая** аттестация.
 *
 * Потреблённые не показываются: они принадлежат состоявшемуся переходу, и предлагать их человеку
 * значило бы предлагать бумагу, по которой дверь уже отказала («одна аттестация — одно
 * переключение»).
 */
export async function readAttestationState(
  reader: ReadinessReader,
  now: Date,
): Promise<AttestationState | null> {
  const [row] = (
    await reader.execute<{
      id: string;
      attested_at: Date;
      active_build_shas: string[];
      algo_version: string;
      legacy_client_calls: number;
    }>(sql`
      SELECT id, attested_at, active_build_shas, algo_version, legacy_client_calls
        FROM assignment_deploy_attestations
       WHERE consumed_at IS NULL
       ORDER BY attested_at DESC
       LIMIT 1`)
  ).rows;
  if (!row) return null;
  const attestedAt = new Date(row.attested_at);
  return {
    id: row.id,
    attestedAt,
    ageMs: now.getTime() - attestedAt.getTime(),
    activeBuildShas: row.active_build_shas,
    algoVersion: row.algo_version,
    legacyClientCalls: Number(row.legacy_client_calls),
  };
}

// ───────────────────────────────── препятствия и вердикт ─────────────────────────────────

/** К какому вопросу относится препятствие: «сколько ещё чинить» или «сейчас или нет». */
export type CutoverTier = 'data' | 'window';

/**
 * Вид препятствия. Строка, а не число: её печатает отчёт, её же читает `--json`, и в обоих случаях
 * человеку важнее «что именно», чем «сколько всего».
 */
export type CutoverObstacleKind =
  | 'history_empty'
  | 'history_empty_without_assignment'
  | 'history_materialized'
  | 'history_dirty'
  | 'history_stale'
  | 'shadow_mismatch'
  | 'shadow_run_missing'
  | 'shadow_run_unfinished'
  | 'shadow_run_failed'
  | 'shadow_run_pending'
  | 'shadow_manifest_incomplete'
  | 'shadow_run_not_today'
  | 'shadow_algo_mismatch'
  | 'write_not_frozen'
  | 'attestation_missing'
  | 'attestation_stale'
  | 'attestation_legacy_calls'
  | 'attestation_algo_mismatch'
  | 'attestation_build_mismatch'
  | 'control_row_missing';

export interface CutoverObstacle {
  kind: CutoverObstacleKind;
  tier: CutoverTier;
  /**
   * Сколько заявок либо целей за этим стоит; `0` — препятствие не количественное.
   *
   * Печатается перед `what` через двоеточие, поэтому `what` пишется в именительном падеже: «324:
   * заявки в работе…». Согласовывать число с существительным пришлось бы правилом на три формы
   * («заявка/заявки/заявок»), а ошибка в нём заметна ровно там, где отчёт читают вслух.
   */
  count: number;
  /** Что не так — словами, которыми это скажут на планёрке. */
  what: string;
  /** Куда идти. Отказ без адреса заставляет искать дверь, и её ищут не там. */
  fix: string;
  /** Номера заявок — не больше десятка: перечень нужен, чтобы начать, а не чтобы закрыть. */
  samples: string[];
}

export interface AssignmentCutoverReadiness {
  asOf: string;
  checkedAt: Date;
  mode: AssignmentModeState | null;
  population: AssignmentPopulationCounts;
  shadow: ShadowRunState | null;
  attestation: AttestationState | null;
  obstacles: CutoverObstacle[];
  /** История готова: предикат Р20 выполнен, меток нет, пересчёт сегодняшний, расхождений нет. */
  dataReady: boolean;
  /** Переключать можно **сейчас**: заморозка, поколение сегодняшнего дня, свежая аттестация. */
  switchable: boolean;
  /** Чтение уже переведено на историю — вопрос закрыт, и отчёт отвечает про сегодняшний режим. */
  alreadySwitched: boolean;
}

export interface ReadinessOptions {
  /** День расчёта; по умолчанию — сегодняшний московский, как у всех дверей модуля. */
  asOf?: string;
  /** Момент, которым меряется свежесть аттестации. Аргументом — ради воспроизводимых тестов. */
  now?: Date;
  /** Поколение, которым собираются переключать; не задано — последнее заведённое. */
  runId?: string;
  /** Сборка, которой собираются переключать: её сверяют с инвентарём раската (О4). */
  buildSha?: string;
  /** Сколько номеров заявок класть в каждый перечень. */
  sampleLimit?: number;
}

/**
 * Собрать всё и вынести вердикт.
 *
 * Порядок препятствий в перечне — порядок разбора, а не важности: сначала то, что чинится прогоном
 * и дверьми (данные), потом то, что делается в окне выката. Человек, читающий сверху вниз, идёт по
 * работе в том порядке, в каком она делается.
 */
export async function assignmentCutoverReadiness(
  reader: ReadinessReader,
  options: ReadinessOptions = {},
): Promise<AssignmentCutoverReadiness> {
  const now = options.now ?? new Date();
  const asOf = options.asOf ?? moscowDateKeyOf(now);
  const limit = options.sampleLimit ?? 10;

  const [mode, population, shadow, attestation] = await Promise.all([
    readAssignmentModeState(reader),
    readAssignmentPopulation(reader, asOf),
    readShadowRunState(reader, options.runId),
    readAttestationState(reader, now),
  ]);

  const obstacles: CutoverObstacle[] = [];
  const add = async (
    kind: CutoverObstacleKind,
    tier: CutoverTier,
    count: number,
    what: string,
    fix: string,
    sample?: ReadinessSample,
  ): Promise<void> => {
    const samples =
      sample && count > 0 ? await sampleReadinessRequests(reader, sample, asOf, limit) : [];
    obstacles.push({ kind, tier, count, what, fix, samples });
  };

  if (!mode) {
    obstacles.push({
      kind: 'control_row_missing',
      tier: 'window',
      count: 0,
      what: 'управляющей строки модуля нет: `assignment_periods_control` пуста',
      fix: 'строка заводится миграцией 0167 и удалению не подлежит — разбирает человек',
      samples: [],
    });
  }

  // ── Ярус данных ──

  // `empty` без назначения назван отдельно и первым: прогон его не починит ни в первый раз, ни в
  // десятый, а адресат у него другой — диспетчер, а не оператор выката (Ю64).
  if (population.emptyWithoutAssignment > 0) {
    await add(
      'history_empty_without_assignment',
      'data',
      population.emptyWithoutAssignment,
      'заявки в работе без назначенной машины — истории не из чего строить',
      'диспетчеру — назначить технику либо закрыть заказ; прогон бэкфилла такую заявку пропустит',
      'empty_without_assignment',
    );
  }
  const emptyRest = population.empty - population.emptyWithoutAssignment;
  if (emptyRest > 0) {
    await add(
      'history_empty',
      'data',
      emptyRest,
      'заявки без истории назначения — прогон бэкфилла по ним не проходил либо не смог',
      'pnpm --filter @technic/api assignment:backfill --apply (сначала dry-run с --report=…)',
      'empty_with_assignment',
    );
  }
  if (population.materialized > 0) {
    await add(
      'history_materialized',
      'data',
      population.materialized,
      'заявки с историей, но без валидности — в изменяемой части остался пробел машиниста либо снятый собственный отрезок',
      'дверь ремонта истории (POST /vehicle-requests/:id/assignment-changes/repair) — по одной заявке',
      'materialized',
    );
  }
  if (population.dirty > 0) {
    await add(
      'history_dirty',
      'data',
      population.dirty,
      'заявки с меткой загрязнения — внутри дня история разошлась с бумагой, и календарное правило устаревания об этом молчит',
      'ревалидация: метка снимается тем же пересчётом, что и состояние',
      'dirty',
    );
  }
  if (population.stale > 0) {
    await add(
      'history_stale',
      'data',
      population.stale,
      `заявки, чьё состояние считалось не на ${asOf} — граница изменяемого уехала календарём`,
      'ревалидация под единым asOf (Ж2) — вне окна выката ненулевое значение нормально',
      'stale',
    );
  }
  if (shadow && shadow.mismatch > 0) {
    obstacles.push({
      kind: 'shadow_mismatch',
      tier: 'data',
      count: shadow.mismatch,
      what: `поколение ${shadow.runId} зафиксировало расхождения планов бумаги`,
      fix: `pnpm --filter @technic/api assignment:shadow mismatches --run=${shadow.runId} — разбор группами по причине`,
      samples: [],
    });
  }

  // ── Ярус окна ──

  if (!shadow) {
    obstacles.push({
      kind: 'shadow_run_missing',
      tier: 'window',
      count: 0,
      // Названное поколение и «ни одного не заводили» — разные беды: в первом случае человек
      // ошибся идентификатором, во втором работа не начата, и советовать ему одно и то же значит
      // отправить его заводить второе поколение вместо первого.
      what: options.runId
        ? `поколение ${options.runId} не найдено`
        : 'поколения теневого сравнения нет вовсе: переключение нечем обосновать',
      fix: options.runId
        ? 'проверьте --run=<uuid>: список поколений — assignment:shadow status'
        : 'assignment:shadow start --build=<sha> под полной заморозкой записи',
      samples: [],
    });
  } else {
    if (shadow.status === 'building' || shadow.status === 'running') {
      obstacles.push({
        kind: 'shadow_run_unfinished',
        tier: 'window',
        count: shadow.pending,
        what: `поколение ${shadow.runId} не объявляло исхода (${shadow.status})`,
        fix: `assignment:shadow run --run=${shadow.runId}, затем finalize`,
        samples: [],
      });
    }
    if (shadow.status === 'failed') {
      obstacles.push({
        kind: 'shadow_run_failed',
        tier: 'window',
        count: shadow.mismatch,
        what: `поколение ${shadow.runId} объявлено неудачным`,
        fix: 'разобрать расхождения, починить и завести новое поколение — поколение не переигрывается',
        samples: [],
      });
    }
    if (shadow.pending > 0 && shadow.status !== 'building') {
      obstacles.push({
        kind: 'shadow_run_pending',
        tier: 'window',
        count: shadow.pending,
        what: `у поколения ${shadow.runId} осталось непроверенных целей`,
        fix: `assignment:shadow run --run=${shadow.runId}`,
        samples: [],
      });
    }
    if (shadow.status !== 'building' && shadow.total !== shadow.expectedChecks) {
      obstacles.push({
        kind: 'shadow_manifest_incomplete',
        tier: 'window',
        count: Math.abs(shadow.expectedChecks - shadow.total),
        what: `manifest поколения неполон: целей ${shadow.total} из объявленных ${shadow.expectedChecks}`,
        fix: 'поколение с неполным manifest`ом доказательством не является — заведите новое',
        samples: [],
      });
    }
    if (shadow.asOf !== asOf) {
      obstacles.push({
        kind: 'shadow_run_not_today',
        tier: 'window',
        count: 0,
        what: `поколение считалось на ${shadow.asOf}, а сегодня ${asOf}: прогон, переживший полночь, начинается заново`,
        fix: 'assignment:shadow start — новое поколение сегодняшним днём',
        samples: [],
      });
    }
    if (shadow.algoVersion !== ASSIGNMENT_HISTORY_ALGO_VERSION) {
      obstacles.push({
        kind: 'shadow_algo_mismatch',
        tier: 'window',
        count: 0,
        what: `поколение получено алгоритмом ${shadow.algoVersion}, а дверь работает алгоритмом ${ASSIGNMENT_HISTORY_ALGO_VERSION}`,
        fix: 'поколение доказывает другой алгоритм — заведите новое на раскатанной сборке',
        samples: [],
      });
    }
  }

  if (mode && mode.readMode !== 'history' && mode.writeMode !== 'all_frozen') {
    obstacles.push({
      kind: 'write_not_frozen',
      tier: 'window',
      count: 0,
      what: `запись в режиме «${mode.writeMode}»: переключение чтения идёт только под полной заморозкой`,
      fix: 'assignment:mode set --write=all_frozen --actor=… --reason=… --build=…',
      samples: [],
    });
  }

  if (!attestation) {
    obstacles.push({
      kind: 'attestation_missing',
      tier: 'window',
      count: 0,
      what: 'непотреблённой аттестации деплоя нет: инвентарь раската приносит job деплоя, а не оператор',
      fix: 'снять аттестацию непосредственно перед дверью — она живёт 30 минут',
      samples: [],
    });
  } else {
    if (attestation.ageMs > ATTESTATION_MAX_AGE_MS) {
      obstacles.push({
        kind: 'attestation_stale',
        tier: 'window',
        count: Math.round(attestation.ageMs / 60000),
        what: `аттестация снята ${Math.round(attestation.ageMs / 60000)} мин назад и описывает уже не сегодняшний раскат`,
        fix: 'снять аттестацию заново',
        samples: [],
      });
    }
    if (attestation.legacyClientCalls !== 0) {
      obstacles.push({
        kind: 'attestation_legacy_calls',
        tier: 'window',
        count: attestation.legacyClientCalls,
        what: 'метрика насчитала вызовы старого широкого маршрута с датами: живой клиент разреза не знает (И5)',
        fix: 'дождаться, пока старые клиенты уйдут, и снять аттестацию заново',
        samples: [],
      });
    }
    if (attestation.algoVersion !== ASSIGNMENT_HISTORY_ALGO_VERSION) {
      obstacles.push({
        kind: 'attestation_algo_mismatch',
        tier: 'window',
        count: 0,
        what: `раскат аттестован алгоритмом ${attestation.algoVersion}, а дверь работает алгоритмом ${ASSIGNMENT_HISTORY_ALGO_VERSION}`,
        fix: 'аттестация относится к другому алгоритму — снимите её на раскатанной сборке',
        samples: [],
      });
    }
    // Сборки сверяются только если названы: чей `BUILD_SHA` переключает, знает не процесс, а
    // оператор, и требовать его от каждого запуска отчёта значило бы требовать его от вопроса
    // «сколько ещё чинить».
    const wanted = [
      ...(options.buildSha ? [options.buildSha] : []),
      ...(shadow ? [shadow.buildVersion] : []),
    ].filter((sha, index, all) => all.indexOf(sha) === index);
    const missing = wanted.filter((sha) => !attestation.activeBuildShas.includes(sha));
    if (missing.length > 0) {
      obstacles.push({
        kind: 'attestation_build_mismatch',
        tier: 'window',
        count: missing.length,
        what: `сборок нет среди раскатанных (${attestation.activeBuildShas.join(', ')}): ${missing.join(', ')}`,
        fix: 'сверка доказывает не ту площадку — переключайте той сборкой, которой получено поколение',
        samples: [],
      });
    }
  }

  const alreadySwitched = mode?.readMode === 'history';
  const dataReady = !obstacles.some((o) => o.tier === 'data');
  const switchable = alreadySwitched || (dataReady && !obstacles.some((o) => o.tier === 'window'));

  return {
    asOf,
    checkedAt: now,
    mode,
    population,
    shadow,
    attestation,
    obstacles,
    dataReady,
    switchable,
    alreadySwitched,
  };
}
