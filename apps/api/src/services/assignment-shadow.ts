import { createHash } from 'node:crypto';
import { and, asc, count, eq, exists, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type Esm2Mode,
  esm2Mode,
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  type RequestStatus,
} from '@technic/contracts';
import type * as schema from '../db/schema';
import {
  assignmentShadowChecks,
  assignmentShadowRuns,
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleTypes,
  waybills,
} from '../db/schema';
import { requestIsLinearSql } from '../db/linear-mode';
import { AppError } from '../lib/errors';
import {
  computeAssignmentHistory,
  readAssignmentHistorySnapshot,
  type AssignmentHistoryBlocker,
  type AssignmentHistorySnapshot,
  type AssignmentHistoryUnrestorable,
} from './assignment-ensure';
import { assignmentSegments } from './assignment-history';
import { ASSIGNMENT_HISTORY_ALGO_VERSION } from './assignment-mode';
import type { AssignmentWriteTx } from './assignment-write';
import {
  esm2SheetPlan,
  legacyComparableKey,
  toLegacyComparable,
  type Esm2SheetPlan,
  type LegacyComparablePlan,
} from './esm2-plan';
import { buildEsm2SyncPlan } from './waybill-esm2';

/**
 * Теневое сравнение недельного расчёта бумаги с отрезковым — этап 4 плана
 * `docs/assignment-periods-plan.md` (решения З2, З4, З6, К1, К2, Л2, М1, Е1; миграция `0167`).
 *
 * ЗАЧЕМ. Этап 5 переключает чтение: бумагу перестаёт вести недельная сверка
 * ([waybill-esm2.ts](waybill-esm2.ts), `esm2SyncPlan`) и начинает вести отрезковый план
 * ([esm2-plan.ts](esm2-plan.ts), `esm2SheetPlan`). Переключение необратимо по существу (§10,
 * «точка невозврата»), и разрешать его «мы прогнали, вроде сошлось» нельзя. Разрешает его
 * **поколение сравнения**: перечень целей, заведённый заранее, и по каждой цели записанный вердикт.
 * Именно на такое поколение ссылается управляющая строка (`cutover_run_id`), и именно его проверяет
 * дверь активации ([assignment-mode.ts](assignment-mode.ts), `checkActivation`): `completed`,
 * сегодняшний `as_of`, полный manifest, ноль `pending`, ноль `mismatch`.
 *
 * ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ (Е1). Ничего не блокирует, ничего не чинит и в чужие двери не
 * вмешивается: он считает два плана и записывает вердикт. Дверная диагностика — другая половина
 * работы и живёт отдельно ([assignment-backstop.ts](assignment-backstop.ts)): она пишет в
 * `audit_log`, а не сюда, потому что здесь **manifest**, где строка заводится заранее по одной на
 * ожидаемую цель, и вставка «лишней» ломала бы полноту доказательства (Ю45).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЧТО ИМЕННО СРАВНИВАЕТСЯ
 *
 * Сравниваются **два плана бумаги одной заявки**, приведённые к общей проекции
 * (`LegacyComparablePlan`, Г4): какие листы сгорят (`cancel`) и какие документы выпишутся
 * (`issue` — границы, машина, человек). Той же проекцией работает гейт совместимости этапа 3
 * (`assignment-crew.ts`), и это не экономия: три независимых нормализатора разошлись бы молча.
 *
 * В сравнение **не входит** и не считается расхождением:
 *
 * - `waybillId`, серия, номер, `issueKey → waybillId` — всё, что рождается после расхода номера
 *   (§7). У плана их нет вовсе;
 * - `wanted`, `kept`, `locked`, `outOfScope` отрезкового плана — недельный расчёт их не возвращает,
 *   и сравнивать их было бы сравнением алгоритма с пустотой. На бумагу они влияют ровно через
 *   `cancel` и `issue`, а те сравниваются;
 * - `responsibility` ожидания — у обеих сторон он всегда `portal` (арендный отрезок в ожидания не
 *   попадает вовсе). Постоянное поле в сравнении — чистый шум;
 * - `sheetSnapshotDraft` и `warningSnapshot` — их недельная сторона считает только на записи
 *   (`collectSnapshot`, рукопожатие выписки), в пишущей транзакции и уже после взятия номера.
 *   Сверка теней ничего не пишет (Е1), поэтому у неё этих графов нет ни с одной стороны; вместо
 *   них сравниваются их входы — период, машина и человек, из которых снимок и собирается;
 * - `scope` — ни одна сторона область не сужает: у полного прогона нет команды, чью область надо
 *   замыкать. Область здесь не поле сравнения, а имя цели ({@link SHADOW_SCOPE_FULL}).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ПОЧЕМУ СРАВНЕНИЕ ЧЕСТНОЕ
 *
 * Сравнивать два расчёта имеет смысл, только если они считаются **от одного состояния и об одном
 * вопросе**. Здесь это обеспечено пятью вещами:
 *
 * 1. **Один день.** Обе стороны отделяют отработанное от предстоящего по `today`, и обеим он
 *    приходит один — `run.as_of`, а не часы процесса. Прогон, переживший полночь, к целям больше
 *    не допускается (О3): день сменился, изменяемая область поехала, и записанный после полуночи
 *    вердикт описывал бы уже другой мир.
 * 2. **Один снимок.** Оба расчёта идут в одной транзакции `repeatable read` / `read only`: у
 *    недельной стороны свои четыре запроса, у отрезковой — свои четыре, и в `read committed` между
 *    ними успела бы вклиниться чужая правка. `read only` здесь ещё и гарантия Е1: сверка физически
 *    не может ничего записать, кроме своей строки manifest'а (та пишется отдельной транзакцией).
 * 3. **Один вопрос — «что сделать с бумагой прямо сейчас».** Ни одна сторона не получает ни
 *    `correction`, ни `unlockWaybillIds`: это ключи операции человека, а операции здесь нет.
 * 4. **Один и тот же гейт бумаги.** Недельная сторона спрашивает `esm2Mode` (тип заявки, статус,
 *    удалённость, линейность, принадлежность). Отрезковая обязана спросить то же самое — **кроме
 *    принадлежности**: у разреза она принадлежит отрезку, а не заявке (Р4), и в этом и состоит
 *    одно из ожидаемых расхождений, ради поиска которого прогон затевается. Поэтому
 *    {@link portalKeepsPaper} — это `esm2Mode` с принудительной `own`, а принадлежность отрезковая
 *    сторона читает по машине каждого отрезка.
 * 5. **Ничего не подставляется руками.** Машиниста и машину недельная сторона читает сама, ровно
 *    как в бою у двери, которая человека не называет (смена статуса, правка срока): машина — из
 *    назначения, человек — с последнего листа. Подставь мы туда «правильные» значения из истории,
 *    сравнение доказывало бы совпадение нового алгоритма с самим собой.
 *
 * ЧТО СЧИТАЕТСЯ РАСХОЖДЕНИЕМ. Всё, что отличает бумагу: другой набор аннулируемых листов, другие
 * границы документов, другая машина, другой человек. Расхождение — всегда `mismatch`, и ни одно из
 * них не «прощается»: поколение с `mismatch` до cutover не допускается (Е1, К1). «Объяснено» здесь
 * значит **классифицировано**: у каждой строки расхождения записаны причина ({@link
 * ShadowMismatchReason}), обе проекции целиком и словесная сводка, — чтобы разбор шёл по группам, а
 * не по строкам. Ожидаемые расхождения (разрез недели Б1, смена принадлежности внутри срока Р4,
 * пробел машиниста Р16/Р19) от неожиданных отличаются именно причиной, а не статусом.
 *
 * ЧТО РАСХОЖДЕНИЕМ НЕ ЯВЛЯЕТСЯ. Расхождение машины назначения с хвостом истории (Р30) — это
 * предупреждение: история с бумагой сходится, расходится лишь денормализация. Оно записывается
 * заметкой в `details` строки, которая при этом остаётся `match`. Так же записываются пробелы
 * машиниста (`blockers` Р16): сами по себе они плана не меняют, но объясняют расхождение, если оно
 * есть, и молчать о них нельзя.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ЖИЗНЕННЫЙ ЦИКЛ ПОКОЛЕНИЯ: `building` → seal → `running` → finalize → `completed` | `failed`
 *
 * - {@link openShadowRun} объявляет **число целей** и заводит поколение в `building`;
 * - {@link buildShadowManifest} вставляет сами цели — по одной на заявку, `status = 'pending'`;
 * - {@link sealShadowRun} печатает поколение: под `FOR UPDATE` сверяет `count(checks) =
 *   expected_checks` и переводит в `running`. **После печати состав целей не меняется** — иначе
 *   доказательство ничего не стоит: manifest, построенный наполовину, объявлял бы себя завершённым
 *   (Л2). Объявление и построение идут разными транзакциями намеренно: только так печать способна
 *   заметить, что популяция между ними изменилась;
 * - {@link runShadowChecks} считает цели и переводит их строки в `match`/`mismatch` как CAS
 *   (`WHERE status = 'pending'`), взяв строку прогона `FOR SHARE` (М-узкое): `FOR UPDATE`
 *   сериализовал бы workers друг с другом без всякой нужды;
 * - {@link finalizeShadowRun} повторно сверяет покрытие, требует нуля `pending` и ставит
 *   `completed` при нуле расхождений либо `failed` при их наличии.
 *
 * ПОПУЛЯЦИЯ ЦЕЛЕЙ — {@link shadowPopulationWhere}: заказы спецтехники в работе (`confirmed`,
 * `done`), не удалённые, не линейные, у которых есть назначенная машина **или** действующий лист
 * ЭСМ-2. Граница выбрана так, чтобы в manifest не попало ни одной цели, совпадающей по построению:
 *
 * - **грузоперевозка, вывоз, новая/отменённая/удалённая заявка** — обе стороны отвечают «бумаги
 *   не ожидается» и гасят всё, что можно погасить, одинаково: сравнение таких целей доказывало бы
 *   лишь то, что два пустых списка равны, а число целей раздувало бы вдвое;
 * - **линейный заказ** — у него бумаги «по сроку» нет вовсе, недели называет человек (ADR 0100),
 *   а история из листов не восстанавливается (в неделе законно два листа разных машин). Отрезковый
 *   план на него не рассчитан, и его цели были бы гарантированным шумом;
 * - **заказ без машины и без бумаги** — восстанавливать историю не от чего и нечему сверяться
 *   (`no_assignment`); ни одна сторона такому заказу бумаги не заводит.
 *
 * Заказ с бумагой, но **без** назначения, в популяцию входит: это как раз опасный случай, и
 * молчать о нём нельзя.
 */

// ── Соединение ──

/**
 * Тип базы берётся у drizzle, а прикладной пул модуль **не** импортирует: sweep — путь
 * maintenance (З3), он ходит своими кредами и не должен требовать ни JWT, ни S3 одним фактом
 * загрузки. (Боевой расчёт бумаги, который модуль зовёт, прикладной конфиг всё же тянет — см.
 * заголовок команды `scripts/assignment-shadow.ts`.)
 */
type AppDatabase = NodePgDatabase<typeof schema>;
type Tx = AssignmentWriteTx;
/** Чтение отчётов блокировок не требует: сводку читают и вне транзакции. */
type Reader = Tx | AppDatabase;
/** Кто исполняет транзакции поколения: административная команда передаёт свой пул. */
export type ShadowExecutor = Pick<AppDatabase, 'transaction'>;

const CODE_REJECTED = 'assignment_shadow_rejected';

/** Отказ поколения: вход операторский, поэтому 422 и текст, по которому видно, что делать. */
const rejected = (message: string): AppError => new AppError(422, CODE_REJECTED, message);

// ── Цель и её область ──

/**
 * Имя области полного прогона.
 *
 * Ключ manifest'а — `(run_id, request_id, scope_fingerprint)`, и третья часть в нём затем, чтобы
 * успешная проверка узкой области не стирала расхождение другой области той же заявки (Ж2). У
 * полного прогона область одна и она вся заявка целиком — значение постоянное и от изменчивых
 * данных не зависящее. Отпечаток, посчитанный от срока, врал бы: срок мог поехать между печатью
 * manifest'а и проверкой цели, а ключ строки при этом остаётся прежним.
 */
export const SHADOW_SCOPE_FULL = 'full';

/** Заголовок поколения — то, чем cutover доказывается годы спустя. */
export interface ShadowRunHeader {
  runId: string;
  status: 'building' | 'running' | 'completed' | 'failed';
  asOf: string;
  algoVersion: string;
  buildVersion: string;
  expectedChecks: number;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Счёт по manifest'у: сколько целей и в каком они состоянии. */
export interface ShadowTally {
  total: number;
  pending: number;
  match: number;
  mismatch: number;
}

// ── Вердикт ──

/**
 * Почему стороны разошлись. Не украшение отчёта: разбор идёт **группами** — тридцать расхождений
 * одной причины это одна работа, а не тридцать, — и без классификации сводка была бы выгрузкой.
 *
 * Порядок перечисления и есть приоритет: причину выбирает первая подошедшая (см. {@link classify}).
 */
export type ShadowMismatchReason =
  /** Отрезковая сторона не считается вовсе: история заявки неоднозначна (`ambiguous_sheets` и т. п.). */
  | 'history_unrestorable'
  /** Стороны прочитали разный состав действующих листов: сравнивать при этом нечего. */
  | 'input_mismatch'
  /** История не называет машиниста (`unknown`), и отрезковый план листа не выписывает (Р16, Р19). */
  | 'driver_unknown'
  /** Те же дни, другие границы документов: разрез внутри недели (Б1, Р5). */
  | 'week_split'
  /** Те же границы, другая машина: смена техники внутри срока либо принадлежность отрезка (Р4). */
  | 'vehicle'
  /** Те же границы и машина, другой человек: машинист отрезка против машиниста заявки. */
  | 'driver'
  /** Стороны хотят бумагу на разные дни. */
  | 'coverage'
  /** Документы совпали, разошёлся состав аннулируемых листов. */
  | 'cancel';

const REASON_WORDS: Record<ShadowMismatchReason, string> = {
  history_unrestorable: 'история заявки не восстанавливается, отрезковый план не считается',
  input_mismatch: 'стороны читают разный состав действующих листов',
  driver_unknown: 'история не называет машиниста — отрезковый план лист не выписывает (Р16, Р19)',
  week_split: 'те же дни разрезаны на другие документы (Б1, Р5)',
  vehicle: 'на тех же днях разные машины (Р4)',
  driver: 'на тех же днях разные машинисты',
  coverage: 'стороны ожидают бумагу на разные дни',
  cancel: 'разошёлся состав аннулируемых листов',
};

/**
 * Результат теневого вычисления одной стороны (З4).
 *
 * `blocked` здесь ровно один — история, которую не восстановить. Дверных блокеров плана
 * (`requiredAnchors`, `requiredVehicleResolution`) в полном прогоне не бывает: двери нет, а
 * пробелы Р16 плана не останавливают — они уходят в заметки и объясняют расхождение, если оно есть.
 */
type ShadowEvaluation =
  | { kind: 'plan'; plan: LegacyComparablePlan }
  | { kind: 'blocked'; blockers: AssignmentHistoryUnrestorable[] };

/** Что записано в `details` строки manifest'а — и расхождения, и заметки при совпадении. */
export interface ShadowCheckDetails {
  /** Номер заказа человеку: строка доказательства обязана читаться без join'ов (`request_id` — значение). */
  requestNumber: string;
  asOf: string;
  reason?: ShadowMismatchReason;
  summary?: string;
  /** Проекция недельного расчёта; у заблокированной стороны её нет. */
  legacy?: LegacyComparablePlan;
  /** Проекция отрезкового расчёта. */
  fresh?: LegacyComparablePlan;
  /** Чем заблокирована сторона, если она заблокирована. */
  blocked?: AssignmentHistoryUnrestorable[];
  /** Что было только у одной стороны — с этого начинается разбор. */
  diff?: {
    cancelOnlyLegacy: string[];
    cancelOnlyFresh: string[];
    issueOnlyLegacy: string[];
    issueOnlyFresh: string[];
  };
  notes: ShadowNotes;
}

/** Обстоятельства сравнения: без них расхождение читается как «просто не сошлось». */
export interface ShadowNotes {
  /** Режим бумаги недельной стороны (`esm2Mode`). */
  legacyMode: Esm2Mode;
  /** Ведёт ли портал бумагу заказа по мнению отрезковой стороны (тот же вопрос минус принадлежность). */
  portalKeepsPaper: boolean;
  /** Откуда взялась история: записана в базе либо восстановлена в памяти этим же расчётом (Р20). */
  history: 'stored' | 'computed' | 'none';
  historyState: AssignmentHistorySnapshot['state'];
  /** Пробелы Р16 на изменяемой части: первые десять — остальные к разбору ничего не добавляют. */
  blockers?: AssignmentHistoryBlocker[];
  /** Расхождение хвоста (Р30): предупреждение, а не ошибка, и статус строки оно не меняет. */
  tailVehicleMismatch?: { historyVehicleId: string; assignmentVehicleId: string };
  /**
   * Сколько действий с бумагой у каждой стороны — `cancel` плюс `issue`.
   *
   * Пишется и при совпадении, и это не статистика ради статистики. «Обе стороны молчат» читается
   * по-разному в зависимости от того, есть ли бумага вообще:
   *
   * - **есть действующие листы, обе молчат** — сильнейшее из возможных совпадений: обе стороны
   *   подтвердили, что выписанная бумага верна, а значит переключение алгоритма не сдвинет ни
   *   одного листа. Чтобы отрезковая сторона промолчала, ей пришлось сойтись с каждым листом по
   *   границам, машине и человеку;
   * - **листов нет, обе молчат** — совпадение почти пустое: сравнивались два пустых списка.
   *
   * Без этих чисел отчёт «сошлись все 3007» невозможно отличить от «3007 раз сравнили ничего с
   * ничем», а доказательство, которое нельзя перепроверить, доказательством не является.
   */
  actions: { legacy: number; fresh: number };
  /** Сколько действующих листов у заказа на момент сравнения — ими и меряется вес совпадения. */
  sheets: number;
}

/** Итог одной цели — ровно то, что уходит в строку manifest'а. */
export interface ShadowCheckOutcome {
  requestId: string;
  scopeFingerprint: string;
  status: 'match' | 'mismatch';
  /**
   * Отпечаток вычисления (К2): им повтор после потерянного ответа узнаёт **свой** результат и не
   * перезаписывает чужой.
   */
  evaluationFingerprint: string;
  details: ShadowCheckDetails;
}

// ── Заведение поколения ──

/**
 * Завести поколение и объявить, сколько в нём будет целей.
 *
 * Число целей считается **здесь**, а сами цели вставляются {@link buildShadowManifest} — другой
 * транзакцией. Это и делает печать (`seal`) настоящей проверкой: между объявлением и построением
 * популяция может измениться, и поколение, чей manifest не сошёлся с объявленным числом, обязано
 * не запечататься, а не «досчитаться на ходу».
 *
 * `algo_version` берётся у сборки, а не у вызывающего: дверь активации сверяет три независимых
 * источника версии (Н3), и поколение, которому версию назвал оператор, доказывало бы совпадение
 * прогона с самим собой.
 */
export async function openShadowRun(
  executor: ShadowExecutor,
  params: { buildVersion: string; asOf?: string },
): Promise<ShadowRunHeader> {
  const buildVersion = params.buildVersion.trim();
  if (!buildVersion) {
    throw rejected(
      'Не названа сборка: поколение обязано помнить, каким кодом получен результат, — иначе оно ничего не доказывает',
    );
  }
  const asOf = params.asOf ?? moscowDateKeyOf(new Date());
  return executor.transaction(async (tx) => {
    const expected = await countShadowPopulation(tx);
    const [row] = await tx
      .insert(assignmentShadowRuns)
      .values({
        status: 'building',
        asOf,
        algoVersion: ASSIGNMENT_HISTORY_ALGO_VERSION,
        buildVersion,
        expectedChecks: expected,
      })
      .returning();
    if (!row) throw rejected('Поколение не создано');
    return headerOf(row);
  });
}

/**
 * Наполнить manifest целями: по строке `pending` на каждую заявку популяции.
 *
 * Идемпотентна (`ON CONFLICT DO NOTHING`): оборванное построение продолжается повтором, а не
 * начинается заново. Работает только с `building` — после печати состав целей неизменен, и это
 * проверяется под блокировкой строки прогона, а не «по договорённости с вызывающим».
 */
export async function buildShadowManifest(
  executor: ShadowExecutor,
  params: { runId: string; batch?: number },
): Promise<{ added: number; total: number; expected: number }> {
  const batch = params.batch ?? 500;
  return executor.transaction(async (tx) => {
    const run = await lockRun(tx, params.runId, 'update');
    if (run.status !== 'building') {
      throw rejected(
        `Поколение ${run.runId} уже запечатано (${run.status}): состав целей после печати не меняется — заведите новое поколение`,
      );
    }
    const ids = await selectShadowPopulation(tx);
    let added = 0;
    for (let at = 0; at < ids.length; at += batch) {
      const chunk = ids.slice(at, at + batch);
      const inserted = await tx
        .insert(assignmentShadowChecks)
        .values(
          chunk.map((requestId) => ({
            runId: run.runId,
            requestId,
            scopeFingerprint: SHADOW_SCOPE_FULL,
            status: 'pending' as const,
          })),
        )
        .onConflictDoNothing()
        .returning({ requestId: assignmentShadowChecks.requestId });
      added += inserted.length;
    }
    const total = await countChecks(tx, run.runId);
    return { added, total, expected: run.expectedChecks };
  });
}

/**
 * Печать поколения (Л2): состав целей закрывается, поколение переходит в `running`.
 *
 * Под `FOR UPDATE`, потому что печать соревнуется с построением: строитель держит ту же строку и
 * проверяет `building`, и без общей блокировки одна из двух проверок читала бы устаревший статус.
 */
export async function sealShadowRun(
  executor: ShadowExecutor,
  runId: string,
): Promise<ShadowRunHeader> {
  return executor.transaction(async (tx) => {
    const run = await lockRun(tx, runId, 'update');
    if (run.status !== 'building') {
      throw rejected(`Поколение ${runId} уже не строится (${run.status}): печатать нечего`);
    }
    const total = await countChecks(tx, runId);
    if (total !== run.expectedChecks) {
      throw rejected(
        `Manifest не сошёлся с объявленным: целей ${total}, объявлено ${run.expectedChecks}. ` +
          'Популяция изменилась между объявлением и построением — поколение заводится заново, ' +
          'а не досчитывается: наполовину построенный manifest объявил бы себя полным.',
      );
    }
    const [row] = await tx
      .update(assignmentShadowRuns)
      .set({ status: 'running' })
      .where(eq(assignmentShadowRuns.runId, runId))
      .returning();
    if (!row) throw rejected('Печать не записана');
    return headerOf(row);
  });
}

// ── Популяция ──

/**
 * Кого сравнивает полный прогон. Условие одно на счёт и на построение — второе его написание
 * разошлось бы с первым, и печать ловила бы собственную опечатку вместо изменения популяции.
 */
function shadowPopulationWhere(tx: Tx): ReturnType<typeof and> {
  return and(
    eq(vehicleRequests.requestType, 'special_equipment'),
    isNull(vehicleRequests.deletedAt),
    // Статус спрашивается так же, как его спрашивает `esm2Mode`: у заявки вне работы бумаги быть
    // не должно, и обе стороны отвечают на неё одинаково по построению.
    sql`${vehicleRequests.status} in ('confirmed', 'done')`,
    isNotNull(specialEquipmentRequestDetails.dateFrom),
    // Режим заказа, а не признак справочника (ADR 0107): заявку могло застать переключение.
    sql`not ${requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear)}`,
    or(
      isNotNull(vehicleRequestAssignments.vehicleId),
      exists(
        tx
          .select({ one: sql`1` })
          .from(waybills)
          .where(
            and(eq(waybills.sourceRequestId, vehicleRequests.id), ne(waybills.status, 'cancelled')),
          ),
      ),
    ),
  );
}

/** Тот же join у счёта и у выборки: разойдясь, они дали бы вечно непечатающееся поколение. */
function shadowPopulationQuery(tx: Tx) {
  return tx
    .select({ id: vehicleRequests.id })
    .from(vehicleRequests)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .where(shadowPopulationWhere(tx));
}

/** Сколько целей будет у поколения. */
async function countShadowPopulation(tx: Tx): Promise<number> {
  const rows = await shadowPopulationQuery(tx);
  return rows.length;
}

/** Сами цели, в устойчивом порядке: разбор отчёта не должен зависеть от плана запроса. */
async function selectShadowPopulation(tx: Tx): Promise<string[]> {
  const rows = await shadowPopulationQuery(tx).orderBy(asc(vehicleRequests.id));
  return rows.map((row) => row.id);
}

// ── Сравнение ──

/**
 * Ведёт ли портал бумагу этого заказа — тот же вопрос, что у `esm2Mode`, **минус принадлежность**.
 *
 * Принадлежность у разреза принадлежит отрезку (Р4): заказ, который вели арендной единицей, а
 * продолжают своей, бумагу заводит с того дня, а не с начала срока. Спроси отрезковая сторона
 * принадлежность заявки, она повторила бы недельное правило — и прогон не заметил бы ровно того
 * расхождения, ради которого разрез и делается.
 *
 * Всё остальное у режима общее и остаётся: не заказ спецтехники, не в работе, удалённая или
 * линейная заявка бумаги не ведёт ни при каком разрезе.
 */
function portalKeepsPaper(head: {
  requestType: 'special_equipment' | 'freight_transport';
  status: RequestStatus;
  deletedAt: Date | null;
  isLinear: boolean;
}): boolean {
  return (
    esm2Mode({
      requestType: head.requestType,
      status: head.status,
      ownership: 'own',
      deletedAt: head.deletedAt ? head.deletedAt.toISOString() : null,
      isLinear: head.isLinear,
    }) === 'auto'
  );
}

/**
 * Посчитать обе стороны по одной заявке и вынести вердикт. Не пишет ничего.
 *
 * Транзакция обязана быть общей на оба расчёта (см. заголовок, п. 2) — её открывает
 * {@link runShadowChecks}. Отдельно функция вызывается тестами и разбором одной заявки.
 */
export async function evaluateShadowTarget(
  tx: Tx,
  params: { requestId: string; asOf: string },
): Promise<ShadowCheckOutcome> {
  const { requestId, asOf } = params;
  const [head] = await tx
    .select({
      num: vehicleRequests.num,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
    })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId));
  if (!head) {
    // Цель заведена печатью, а заявки нет: доказательство обязано быть полным, поэтому не «пропуск»,
    // а отказ — строка останется `pending` и не даст завершить поколение.
    throw rejected(`Заявка ${requestId} исчезла между печатью manifest'а и проверкой цели`);
  }

  // ── недельная сторона: ровно то, что портал делает сегодня ──
  const legacyBuilt = await buildEsm2SyncPlan(tx, { requestId, asOf });
  if (!legacyBuilt) throw rejected(`Недельный расчёт не построен по заявке ${requestId}`);
  const legacyPlan = toLegacyComparable(
    legacyBuilt.plan.cancel,
    legacyBuilt.plan.issue.map((period) => ({
      from: period.from,
      to: period.to,
      // Машина у недельного расчёта одна на заявку — из назначения; человек — с последнего листа.
      vehicleId: legacyBuilt.input.vehicleId ?? '',
      driverPersonId: legacyBuilt.input.driverPersonId,
    })),
  );

  // ── отрезковая сторона: то, что портал будет делать после переключения чтения ──
  const snapshot = await readAssignmentHistorySnapshot(tx, requestId);
  const keepsPaper = portalKeepsPaper({ ...head, isLinear: snapshot.isLinear });
  const computed = keepsPaper ? computeAssignmentHistory(snapshot, asOf) : null;
  const unrestorable = computed?.unrestorable ?? [];

  let fresh: ShadowEvaluation;
  let freshPlan: Esm2SheetPlan | null = null;
  if (computed && unrestorable.length > 0) {
    fresh = { kind: 'blocked', blockers: [...unrestorable] };
  } else {
    // Бумаги не ожидается — отрезков нет: тогда план гасит всё, что можно погасить, тем же
    // `canCancelWaybill`, каким это делает недельная сторона. Это не «пустой план», а честный
    // ответ «портал этому заказу бумаги не ведёт».
    const segments = computed ? assignmentSegments(computed.changes, snapshot.term) : [];
    freshPlan = esm2SheetPlan(segments, snapshot.term, snapshot.sheets, {
      ownershipByVehicle: snapshot.ownershipByVehicle,
      today: asOf,
    });
    fresh = {
      kind: 'plan',
      plan: toLegacyComparable(
        freshPlan.cancel,
        freshPlan.issue.map((sheet) => ({
          from: sheet.from,
          to: sheet.to,
          vehicleId: sheet.vehicleId,
          driverPersonId: sheet.driver.personId,
        })),
      ),
    };
  }

  const notes: ShadowNotes = {
    actions: {
      legacy: legacyPlan.cancel.length + legacyPlan.issue.length,
      fresh: fresh.kind === 'plan' ? fresh.plan.cancel.length + fresh.plan.issue.length : 0,
    },
    sheets: snapshot.sheets.length,
    legacyMode: legacyBuilt.input.mode,
    portalKeepsPaper: keepsPaper,
    history:
      snapshot.changes.length > 0
        ? 'stored'
        : (computed?.changes.length ?? 0) > 0
          ? 'computed'
          : 'none',
    historyState: computed?.state ?? snapshot.state,
    ...(computed && computed.blockers.length > 0
      ? { blockers: computed.blockers.slice(0, 10) }
      : {}),
    ...(computed?.warnings[0]
      ? {
          tailVehicleMismatch: {
            historyVehicleId: computed.warnings[0].historyVehicleId,
            assignmentVehicleId: computed.warnings[0].assignmentVehicleId,
          },
        }
      : {}),
  };

  // Входы обеих сторон обязаны совпасть: недельная читает листы своим запросом, отрезковая —
  // своим, и разойдясь, они сравнивали бы разные заявки. Проверяется до вердикта, потому что при
  // разном входе любой вердикт бессмыслен.
  const legacySheetIds = [...legacyBuilt.input.existing.map((sheet) => sheet.id)].sort();
  const freshSheetIds = [...snapshot.sheets.map((sheet) => sheet.id)].sort();
  const sameInput = legacySheetIds.join('|') === freshSheetIds.join('|');

  const verdict = sameInput
    ? compareShadowEvaluations(
        { kind: 'plan', plan: legacyPlan },
        fresh,
        freshPlan,
        snapshot.sheets,
      )
    : ({ status: 'mismatch', reason: 'input_mismatch' } as const);

  const details: ShadowCheckDetails = {
    requestNumber: formatVehicleRequestNumber(head.num),
    asOf,
    notes,
    ...(verdict.status === 'mismatch'
      ? {
          reason: verdict.reason,
          summary: `заказ ${formatVehicleRequestNumber(head.num)}: ${REASON_WORDS[verdict.reason]}`,
          legacy: legacyPlan,
          ...(fresh.kind === 'plan' ? { fresh: fresh.plan } : { blocked: fresh.blockers }),
          ...(fresh.kind === 'plan' ? { diff: diffOf(legacyPlan, fresh.plan) } : {}),
        }
      : {}),
  };

  return {
    requestId,
    scopeFingerprint: SHADOW_SCOPE_FULL,
    status: verdict.status,
    evaluationFingerprint: fingerprintOf({
      asOf,
      algoVersion: ASSIGNMENT_HISTORY_ALGO_VERSION,
      scope: SHADOW_SCOPE_FULL,
      legacy: legacyPlan,
      fresh: fresh.kind === 'plan' ? fresh.plan : { blocked: fresh.blockers },
      status: verdict.status,
      reason: verdict.status === 'mismatch' ? verdict.reason : null,
    }),
    details,
  };
}

/** Вердикт по одной цели: совпало или нет, а если нет — почему. */
type ShadowVerdict = { status: 'match' } | { status: 'mismatch'; reason: ShadowMismatchReason };

/**
 * Сравнение двух вычислений (З4): `plan` с `plan` — по содержимому, разные `kind` — расхождение.
 *
 * `blocked` с `blocked` здесь не бывает: недельная сторона плана даёт всегда — у неё нет ни
 * истории, ни блокеров, — и случай оставлен полным ради самого правила, а не ради ветки.
 */
function compareShadowEvaluations(
  legacy: ShadowEvaluation,
  fresh: ShadowEvaluation,
  freshPlan: Esm2SheetPlan | null,
  sheets: readonly { id: string; periodFrom: string; periodTo: string }[],
): ShadowVerdict {
  if (legacy.kind !== fresh.kind) {
    return { status: 'mismatch', reason: 'history_unrestorable' };
  }
  if (legacy.kind === 'blocked' || fresh.kind === 'blocked') {
    const same =
      JSON.stringify(legacy.kind === 'blocked' ? legacy.blockers : []) ===
      JSON.stringify(fresh.kind === 'blocked' ? fresh.blockers : []);
    return same ? { status: 'match' } : { status: 'mismatch', reason: 'history_unrestorable' };
  }
  const options = { withDriver: true } as const;
  if (legacyComparableKey(legacy.plan, options) === legacyComparableKey(fresh.plan, options)) {
    return { status: 'match' };
  }
  return { status: 'mismatch', reason: classify(legacy.plan, fresh.plan, freshPlan, sheets) };
}

/**
 * Чем именно разошлись два плана — одна причина, названная по существу расхождения.
 *
 * Порядок проверок — от причины, объясняющей всё, к причине, объясняющей остаток:
 *
 * 1. документы совпали, а списки на аннулирование нет — расхождение только в гашении;
 * 2. пробел машиниста: отрезковая сторона ждёт лист, но человека не знает и потому не выписывает
 *    (Р16, Р19). Спрашивается раньше границ намеренно — иначе то же расхождение выглядело бы как
 *    «стороны хотят бумагу на разные дни» и увело бы разбор не туда;
 * 3. границы документов совпали — значит разошлись машина либо человек;
 * 4. **дни бумаги** совпали, а документы нет — это и есть разрез недели (Б1, Р5): одна сторона
 *    держит лист пн–вс, другая заменяет его на пн–вт и ср–вс. Дни бумаги считаются одинаково у
 *    обеих сторон: что она собирается выписать плюс листы, которых она не гасит;
 * 5. всё прочее — стороны ожидают бумагу на разные дни.
 */
function classify(
  legacy: LegacyComparablePlan,
  fresh: LegacyComparablePlan,
  freshPlan: Esm2SheetPlan | null,
  sheets: readonly { id: string; periodFrom: string; periodTo: string }[],
): ShadowMismatchReason {
  const key = (sheet: LegacyComparablePlan['issue'][number]): string =>
    `${sheet.from}|${sheet.to}|${sheet.vehicleId}|${sheet.driverPersonId ?? ''}`;
  const legacyKeys = new Set(legacy.issue.map(key));
  const freshKeys = new Set(fresh.issue.map(key));
  const onlyLegacy = legacy.issue.filter((sheet) => !freshKeys.has(key(sheet)));
  const onlyFresh = fresh.issue.filter((sheet) => !legacyKeys.has(key(sheet)));

  if (onlyLegacy.length === 0 && onlyFresh.length === 0) return 'cancel';

  // Пробел машиниста спрашивается у `wanted`, а не у `issue`: в `issue` такого ожидания нет по
  // определению — именно потому оно и не выписывается.
  const unknownWanted = (freshPlan?.wanted ?? []).filter((want) => want.driver.state === 'unknown');
  if (
    unknownWanted.some((want) =>
      onlyLegacy.some((sheet) => want.from <= sheet.to && sheet.from <= want.to),
    )
  ) {
    return 'driver_unknown';
  }

  const periodsOf = (plan: LegacyComparablePlan): string =>
    [...new Set(plan.issue.map((sheet) => `${sheet.from}|${sheet.to}`))].sort().join(';');
  if (periodsOf(legacy) === periodsOf(fresh)) {
    const byPeriod = new Map(fresh.issue.map((sheet) => [`${sheet.from}|${sheet.to}`, sheet]));
    const differentVehicle = legacy.issue.some(
      (sheet) => byPeriod.get(`${sheet.from}|${sheet.to}`)?.vehicleId !== sheet.vehicleId,
    );
    return differentVehicle ? 'vehicle' : 'driver';
  }

  /**
   * Дни, на которых сторона ожидает бумагу: что она выписывает плюс листы, которых она не гасит.
   * Мера одна на обе стороны — только так «тот же набор дней, другие границы» отличается от
   * «разные дни».
   */
  const paperDays = (plan: LegacyComparablePlan): string => {
    const days = new Set<string>();
    const cancelled = new Set(plan.cancel);
    const spans: { from: string; to: string }[] = [
      ...plan.issue.map((sheet) => ({ from: sheet.from, to: sheet.to })),
      ...sheets
        .filter((sheet) => !cancelled.has(sheet.id))
        .map((sheet) => ({ from: sheet.periodFrom, to: sheet.periodTo })),
    ];
    for (const span of spans) {
      for (let day = span.from; day <= span.to; day = nextDay(day)) days.add(day);
    }
    return [...days].sort().join(',');
  };
  return paperDays(legacy) === paperDays(fresh) ? 'week_split' : 'coverage';
}

/** Следующий календарный день: разрез считается по дням, а не по неделям (Р5). */
function nextDay(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Что было только у одной стороны: с этого разбор расхождения и начинается. */
function diffOf(
  legacy: LegacyComparablePlan,
  fresh: LegacyComparablePlan,
): NonNullable<ShadowCheckDetails['diff']> {
  const key = (sheet: LegacyComparablePlan['issue'][number]): string =>
    `${sheet.from}|${sheet.to}|${sheet.vehicleId}|${sheet.driverPersonId ?? ''}`;
  const legacyCancel = new Set(legacy.cancel);
  const freshCancel = new Set(fresh.cancel);
  const legacyIssue = new Set(legacy.issue.map(key));
  const freshIssue = new Set(fresh.issue.map(key));
  return {
    cancelOnlyLegacy: legacy.cancel.filter((id) => !freshCancel.has(id)),
    cancelOnlyFresh: fresh.cancel.filter((id) => !legacyCancel.has(id)),
    issueOnlyLegacy: [...legacyIssue].filter((k) => !freshIssue.has(k)),
    issueOnlyFresh: [...freshIssue].filter((k) => !legacyIssue.has(k)),
  };
}

/** Отпечаток вычисления: одно и то же состояние даёт один и тот же хеш, и наоборот. */
function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ── Прогон целей ──

/** Чем кончился заход worker'а: сколько разобрано, сколько осталось, что не далось. */
export interface ShadowProgress {
  checked: number;
  matched: number;
  mismatched: number;
  /** Повторы, узнавшие свой прежний результат по отпечатку (К2): работа не переделана. */
  repeated: number;
  remaining: number;
  failures: { requestId: string; message: string }[];
}

/**
 * Считать цели поколения и записать вердикты.
 *
 * Каждая цель — две транзакции. Читающая (`repeatable read`, `read only`) считает оба плана от
 * одного снимка; короткая пишущая берёт строку прогона `FOR SHARE` и обновляет свою строку как CAS
 * (М-узкое). Разделение не косметическое: держи мы всё в одной длинной пишущей транзакции, worker
 * блокировал бы половину портала на время прогона, а `read only` перестал бы быть гарантией того,
 * что сверка ничего не пишет.
 */
export async function runShadowChecks(
  executor: ShadowExecutor,
  params: {
    runId: string;
    /** Сколько целей взять за заход; не задано — все оставшиеся. */
    limit?: number;
    /** Прогресс наружу: команда печатает его построчно, тесты не подписываются вовсе. */
    onCheck?: (outcome: ShadowCheckOutcome, done: number, total: number) => void;
  },
): Promise<ShadowProgress> {
  const header = await readShadowRunOrThrow(executor, params.runId);
  if (header.status !== 'running') {
    throw rejected(
      `Поколение ${params.runId} не работает (${header.status}): цели считаются только у запечатанного поколения`,
    );
  }
  // Прогон, переживший полночь, начинается заново (О3). Проверка стоит здесь, а не только в двери
  // активации: вердикт, записанный на вчерашний `as_of`, — это вердикт о вчерашнем мире, и
  // поколение с такими строками не «слегка устарело», а недостоверно.
  const today = moscowDateKeyOf(new Date());
  if (header.asOf !== today) {
    throw rejected(
      `Поколение считалось на ${header.asOf}, сегодня ${today}: прогон, переживший полночь, начинается заново`,
    );
  }

  const progress: ShadowProgress = {
    checked: 0,
    matched: 0,
    mismatched: 0,
    repeated: 0,
    remaining: 0,
    failures: [],
  };
  const targets = await executor.transaction(
    async (tx) =>
      tx
        .select({
          requestId: assignmentShadowChecks.requestId,
          scopeFingerprint: assignmentShadowChecks.scopeFingerprint,
        })
        .from(assignmentShadowChecks)
        .where(
          and(
            eq(assignmentShadowChecks.runId, params.runId),
            eq(assignmentShadowChecks.status, 'pending'),
          ),
        )
        .orderBy(asc(assignmentShadowChecks.requestId))
        .limit(params.limit ?? Number.MAX_SAFE_INTEGER),
    { accessMode: 'read only' },
  );

  for (const target of targets) {
    let outcome: ShadowCheckOutcome;
    try {
      outcome = await executor.transaction(
        async (tx) => evaluateShadowTarget(tx, { requestId: target.requestId, asOf: header.asOf }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      progress.failures.push({
        requestId: target.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const written = await writeShadowCheck(executor, params.runId, outcome);
    if (written === 'repeated') progress.repeated += 1;
    progress.checked += 1;
    if (outcome.status === 'match') progress.matched += 1;
    else progress.mismatched += 1;
    params.onCheck?.(outcome, progress.checked, targets.length);
  }

  progress.remaining = await executor.transaction(
    async (tx) => (await shadowTally(tx, params.runId)).pending,
    { accessMode: 'read only' },
  );
  return progress;
}

/**
 * Записать вердикт одной цели — CAS по строке manifest'а (К2, М-узкое).
 *
 * Строка прогона берётся `FOR SHARE`, а не `FOR UPDATE`: два worker'а обязаны работать
 * параллельно, а сериализует их собственная строка проверки. Финализация при этом берёт ту же
 * строку `FOR UPDATE` и потому дожидается активных writer'ов — поздний писатель в завершённое
 * поколение не попадёт.
 */
async function writeShadowCheck(
  executor: ShadowExecutor,
  runId: string,
  outcome: ShadowCheckOutcome,
): Promise<'written' | 'repeated'> {
  return executor.transaction(async (tx) => {
    const run = await lockRun(tx, runId, 'share');
    if (run.status !== 'running') {
      throw rejected(
        `Поколение ${runId} не работает (${run.status}): записывать вердикт некуда — завершённое поколение неизменяемо`,
      );
    }
    const where = and(
      eq(assignmentShadowChecks.runId, runId),
      eq(assignmentShadowChecks.requestId, outcome.requestId),
      eq(assignmentShadowChecks.scopeFingerprint, outcome.scopeFingerprint),
    );
    const updated = await tx
      .update(assignmentShadowChecks)
      .set({
        status: outcome.status,
        evaluationFingerprint: outcome.evaluationFingerprint,
        details: outcome.details,
        checkedAt: new Date(),
      })
      .where(and(where, eq(assignmentShadowChecks.status, 'pending')))
      .returning({ requestId: assignmentShadowChecks.requestId });
    if (updated.length === 1) return 'written';

    const [existing] = await tx
      .select({
        status: assignmentShadowChecks.status,
        evaluationFingerprint: assignmentShadowChecks.evaluationFingerprint,
      })
      .from(assignmentShadowChecks)
      .where(where);
    if (!existing) {
      // Лишнюю цель записать некуда — строки нет (К1). Это не сбой worker'а, а свойство manifest'а.
      throw rejected(
        `Цели ${outcome.requestId}/${outcome.scopeFingerprint} нет в manifest'е поколения ${runId}: состав целей закрыт печатью`,
      );
    }
    // Повтор после потерянного ответа: тот же отпечаток — та же работа, и переписывать её незачем.
    if (existing.evaluationFingerprint === outcome.evaluationFingerprint) return 'repeated';
    throw rejected(
      `Цель ${outcome.requestId} уже проверена с другим результатом (${existing.status}): ` +
        'состояние заявки изменилось под прогоном — поколение заводится заново',
    );
  });
}

// ── Финализация ──

/**
 * Завершить поколение: повторно сверить покрытие и назвать исход.
 *
 * Три условия, и все три обязательны (З2, Л2, К1):
 *
 * - manifest полон: `count(*) = expected_checks` — **повторно**, а не «мы же печатали»;
 * - `pending` нет: неразобранная цель означает, что поколение не знает о заявке ничего, и
 *   объявить его доказательством нельзя;
 * - `mismatch` нет — иначе исход `failed`. Расхождение не «прощается» классификацией: причина
 *   объясняет, что чинить, а разрешает переключение только их отсутствие (Е1).
 */
export async function finalizeShadowRun(
  executor: ShadowExecutor,
  runId: string,
): Promise<{ header: ShadowRunHeader; tally: ShadowTally }> {
  return executor.transaction(async (tx) => {
    const run = await lockRun(tx, runId, 'update');
    if (run.status !== 'running') {
      throw rejected(
        `Поколение ${runId} не работает (${run.status}): завершать нечего — финализируется только запечатанное`,
      );
    }
    const tally = await shadowTally(tx, runId);
    if (tally.total !== run.expectedChecks) {
      throw rejected(
        `Manifest неполон: целей ${tally.total} из объявленных ${run.expectedChecks} — поколение не завершается`,
      );
    }
    if (tally.pending > 0) {
      throw rejected(
        `Поколение не досчитано: ${tally.pending} целей осталось непроверенными — доказательством оно не является`,
      );
    }
    const [row] = await tx
      .update(assignmentShadowRuns)
      .set({ status: tally.mismatch > 0 ? 'failed' : 'completed', finishedAt: new Date() })
      .where(eq(assignmentShadowRuns.runId, runId))
      .returning();
    if (!row) throw rejected('Завершение не записано');
    return { header: headerOf(row), tally };
  });
}

// ── Чтение и отчёт ──

/** Заголовок поколения; `null` — такого нет. */
export async function readShadowRun(
  reader: Reader,
  runId: string,
): Promise<ShadowRunHeader | null> {
  const [row] = await reader
    .select()
    .from(assignmentShadowRuns)
    .where(eq(assignmentShadowRuns.runId, runId));
  return row ? headerOf(row) : null;
}

/** Последние поколения — чтобы оператор нашёл своё, не помня uuid. */
export async function listShadowRuns(reader: Reader, limit = 10): Promise<ShadowRunHeader[]> {
  const rows = await reader
    .select()
    .from(assignmentShadowRuns)
    .orderBy(sql`${assignmentShadowRuns.startedAt} desc`)
    .limit(limit);
  return rows.map(headerOf);
}

/** Счёт по manifest'у одного поколения. */
export async function shadowTally(reader: Reader, runId: string): Promise<ShadowTally> {
  const [row] = await reader
    .select({
      total: count(),
      pending: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.status} = 'pending') as int)`,
      match: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.status} = 'match') as int)`,
      mismatch: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.status} = 'mismatch') as int)`,
    })
    .from(assignmentShadowChecks)
    .where(eq(assignmentShadowChecks.runId, runId));
  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    match: row?.match ?? 0,
    mismatch: row?.mismatch ?? 0,
  };
}

/** Группа расхождений одной причины: сколько их и на что посмотреть. */
export interface ShadowMismatchGroup {
  reason: ShadowMismatchReason | 'unknown';
  words: string;
  count: number;
  examples: { requestId: string; requestNumber: string; summary: string }[];
}

/**
 * Сводка расхождений — группами по причине, а не списком строк.
 *
 * Причина берётся из `details`, а не пересчитывается: вердикт вынесен на состоянии, которого
 * сейчас может уже не быть, и второй расчёт по живым данным показал бы не то, что записано в
 * доказательстве.
 */
export async function shadowMismatchSummary(
  reader: Reader,
  runId: string,
  examplesPerReason = 3,
): Promise<ShadowMismatchGroup[]> {
  const rows = await reader
    .select({
      requestId: assignmentShadowChecks.requestId,
      details: assignmentShadowChecks.details,
    })
    .from(assignmentShadowChecks)
    .where(
      and(eq(assignmentShadowChecks.runId, runId), eq(assignmentShadowChecks.status, 'mismatch')),
    )
    .orderBy(asc(assignmentShadowChecks.requestId));

  const groups = new Map<string, ShadowMismatchGroup>();
  for (const row of rows) {
    const details = (row.details ?? {}) as Partial<ShadowCheckDetails>;
    const reason = details.reason ?? 'unknown';
    const group = groups.get(reason) ?? {
      reason,
      words: reason === 'unknown' ? 'причина не записана' : REASON_WORDS[reason],
      count: 0,
      examples: [],
    };
    group.count += 1;
    if (group.examples.length < examplesPerReason) {
      group.examples.push({
        requestId: row.requestId,
        requestNumber: details.requestNumber ?? '—',
        summary: details.summary ?? '',
      });
    }
    groups.set(reason, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Заметки при совпадении: ожидаемые предупреждения, о которых доказательство обязано сказать. */
export interface ShadowNoteTally {
  /** Совпавшие цели с расхождением хвоста (Р30) — предупреждение, не блокер. */
  tailVehicleMismatch: number;
  /** Совпавшие цели с пробелом машиниста в изменяемой части (Р16). */
  driverGaps: number;
  /** Цели, чья история восстановлена в памяти, а не прочитана из базы (бэкфилл ещё не проходил). */
  historyComputed: number;
  /** Цели, где хотя бы одна сторона двинула бы бумагу: там стороны расходятся с нынешним состоянием. */
  paperTouched: number;
  /** Цели, где обе стороны подтвердили выписанную бумагу: переключение не сдвинет ни листа. */
  paperConfirmed: number;
  /** Цели без действующей бумаги: обе стороны молчат, и подтверждать нечего. */
  paperAbsent: number;
}

/** Сколько совпавших целей несут заметку — и какую. */
export async function shadowNoteTally(reader: Reader, runId: string): Promise<ShadowNoteTally> {
  const [row] = await reader
    .select({
      tail: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.details} -> 'notes' ? 'tailVehicleMismatch') as int)`,
      gaps: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.details} -> 'notes' ? 'blockers') as int)`,
      computed: sql<number>`cast(count(*) filter (where ${assignmentShadowChecks.details} -> 'notes' ->> 'history' = 'computed') as int)`,
      touched: sql<number>`cast(count(*) filter (where (${assignmentShadowChecks.details} -> 'notes' -> 'actions' ->> 'legacy')::int > 0 or (${assignmentShadowChecks.details} -> 'notes' -> 'actions' ->> 'fresh')::int > 0) as int)`,
      confirmed: sql<number>`cast(count(*) filter (where (${assignmentShadowChecks.details} -> 'notes' -> 'actions' ->> 'legacy')::int = 0 and (${assignmentShadowChecks.details} -> 'notes' -> 'actions' ->> 'fresh')::int = 0 and (${assignmentShadowChecks.details} -> 'notes' ->> 'sheets')::int > 0) as int)`,
      absent: sql<number>`cast(count(*) filter (where (${assignmentShadowChecks.details} -> 'notes' -> 'actions' ->> 'legacy')::int = 0 and (${assignmentShadowChecks.details} -> 'notes' -> 'actions' ->> 'fresh')::int = 0 and (${assignmentShadowChecks.details} -> 'notes' ->> 'sheets')::int = 0) as int)`,
    })
    .from(assignmentShadowChecks)
    .where(eq(assignmentShadowChecks.runId, runId));
  return {
    tailVehicleMismatch: row?.tail ?? 0,
    driverGaps: row?.gaps ?? 0,
    historyComputed: row?.computed ?? 0,
    paperTouched: row?.touched ?? 0,
    paperConfirmed: row?.confirmed ?? 0,
    paperAbsent: row?.absent ?? 0,
  };
}

// ── Внутреннее ──

function headerOf(row: typeof assignmentShadowRuns.$inferSelect): ShadowRunHeader {
  return {
    runId: row.runId,
    status: row.status,
    asOf: row.asOf,
    algoVersion: row.algoVersion,
    buildVersion: row.buildVersion,
    expectedChecks: row.expectedChecks,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Строка поколения под блокировкой: `share` у worker'а, `update` у печати и финализации. */
async function lockRun(tx: Tx, runId: string, mode: 'share' | 'update'): Promise<ShadowRunHeader> {
  const [row] = await tx
    .select()
    .from(assignmentShadowRuns)
    .where(eq(assignmentShadowRuns.runId, runId))
    .for(mode);
  if (!row) throw rejected(`Поколение ${runId} не найдено`);
  return headerOf(row);
}

async function readShadowRunOrThrow(
  executor: ShadowExecutor,
  runId: string,
): Promise<ShadowRunHeader> {
  const header = await executor.transaction(async (tx) => readShadowRun(tx, runId), {
    accessMode: 'read only',
  });
  if (!header) throw rejected(`Поколение ${runId} не найдено`);
  return header;
}

async function countChecks(tx: Tx, runId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(assignmentShadowChecks)
    .where(eq(assignmentShadowChecks.runId, runId));
  return row?.n ?? 0;
}
