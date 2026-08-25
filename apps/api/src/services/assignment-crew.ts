import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  assignmentDimensionLabels,
  can,
  canCancelWaybill,
  correctionFloorDateKey,
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  waybillDisplayNumber,
  type AccessSubject,
  type AssignmentChangeDto,
  type AssignmentCommandInput,
  type AssignmentPlanCancelDto,
  type AssignmentPlanIssueDto,
  type AssignmentPreviewDto,
  type DriverState,
  type Esm2Mode,
  type Esm2Period,
  type MachinistAnchor,
  type OperationRequirement,
  type RequestAssignmentHistoryDto,
  type RequiredAnchor,
  type VehicleOwnership,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import { err } from '../lib/errors';
import {
  persons,
  users,
  vehicleModels,
  vehicleRequestAssignmentChanges,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicles,
  waybills,
  waybillSeries,
} from '../db/schema';
import {
  assignmentCommandEffects,
  type AssignmentEffects,
  type AssignmentMutation,
} from './assignment-effects';
import {
  assignmentEffectRange,
  assignmentSegments,
  assignmentStateOn,
  plannedEffectRange,
  sameDriverState,
  type AssignmentRange,
  type AssignmentSegment,
  type AssignmentTerm,
} from './assignment-history';
import {
  assignmentChangeTargetOf,
  assignmentHistoryUnrestorableReason,
  ensureCommandHistory,
  planAssignmentHistory,
} from './assignment-ensure';
import { historyIsAuthoritative, type AssignmentModeSnapshot } from './assignment-mode';
// Шаг 12 у всех дверей истории один: режим решает, кто исполняет бумагу, а исход — с каким
// провенансом. Своя копия этого решения в каждой двери разошлась бы молча — и разошлась бы там,
// где тратятся номера бланков строгой отчётности.
import {
  applyAssignmentPaper,
  assertAssignmentPaperConverged,
  paperFollowsHistory,
} from './assignment-paper';
import {
  applyAssignmentMutations,
  readAssignmentChanges,
  resolveChangeTarget,
  type AssignmentChangeRecord,
  type AssignmentDenormalizationIntent,
  type AssignmentWriteMutation,
  type AssignmentWriteResult,
} from './assignment-write';
import {
  esm2ScopedPlanOfSheetPlan,
  esm2SheetPlan,
  legacyComparableKey,
  normalizeRangeSet,
  rangeSetCovers,
  toLegacyComparable,
  type DateRangeSet,
  type Esm2ExistingSheet,
  type Esm2SheetPlan,
} from './esm2-plan';
import { correctionFingerprint } from './waybill-correction';
import { buildEsm2SyncPlan, syncEsm2Waybills, type Esm2SyncResult } from './waybill-esm2';
import type {
  AssignmentAuditContext,
  AssignmentCommandSpec,
  AssignmentCommandTx,
  AssignmentPlanContext,
} from './assignment-command';
import type { AuditEntry } from '../lib/audit';
import type { db as AppDb } from '../db/client';

/**
 * Команда машиниста — первая боевая дверь истории назначения
 * (`docs/assignment-periods-plan.md`, Р7, Р11–Р13, Р16, Р19, Р24, Р32; §8).
 *
 * ЧТО ЭТА ДВЕРЬ ДЕЛАЕТ. Назначает и снимает машиниста **внутри срока** заказа спецтехники, оставляя
 * прошлое документально нетронутым. До неё машинист был один на весь срок и жил в последнем
 * выписанном листе; теперь у заявки есть история, а «кто работал в марте» отвечает свёртка, а не
 * бумага.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ И ПОЧЕМУ. Машину она не меняет вовсе (Р7): у смены техники свои ставки, аренда,
 * рейс и занятость, и вторая дорога к ним через эту дверь означала бы два расходящихся набора
 * правил. Поэтому `cancel` группы, в которой стоит vehicle-строка, отвергается — с одним
 * исключением, и оно предписано §8: **дремлющая группа решения хвоста** (`origin =
 * 'tail_resolution'`, Р31) отменяется именно здесь. Гасится она с намерением `tail_release`:
 * назначение и ставки не трогаются, а хвост истории после снятия границы **законно** расходится с
 * назначением — вопрос «чем заявка закрыта после срока» снова открыт. Ожившее решение хвоста
 * (`inTermRange` перестал быть пустым после продления срока) эта дверь уже не снимает: там ставки и
 * занятость, и переигрывает его дверь ремонта. Линейный заказ этой дверью не ходит (Р14): машиниста
 * там называют при выписке каждого листа.
 *
 * ПОЧЕМУ РЯДОМ С НОВЫМ ПЛАНОМ ЛИСТОВ ЖИВЁТ СТАРАЯ СВЕРКА — И ДО КАКОГО МОМЕНТА. Ответ даёт **режим
 * чтения**, а не календарь и не дверь (§10).
 *
 * При `read_mode = legacy` идёт dual-write **с паритетом старой бумаги** (§10 п. 2, решения Б1, В3,
 * Д1): история пишется по-новому, а листы по-прежнему ведёт недельная `syncEsm2Waybills`, и
 * допускаются только те команды, которые она способна исполнить. Критерий вычисляемый и считается
 * под той же блокировкой: документы обязаны совпасть (`legacyComparable(старый план) ==
 * legacyComparable(новый план)`), а человек в них — быть тем единственным, которого сверка умеет
 * напечатать. Отсюда три отказа, которые иначе выглядели бы произволом:
 *
 * - **дремлющая команда (Р24) отвергается** — дата обязана лежать внутри срока. Именно дремлющие
 *   изменения и есть единственный источник «сегодня планы совпали, а завтра, после продления
 *   срока, разойдутся» (Д1);
 * - **дата в середине уже выписанной недели отвергается** — старый алгоритм такой границы не
 *   воспроизводит: он переписал бы неделю целиком одним человеком, а новый режет её надвое (Б1).
 *   Якорь на среду при сроке со среды при этом **проходит**: там оба плана дают тот же документ;
 * - **плановая смена машиниста будущей датой отвергается** — «машинист заявки» у недельной сверки
 *   один, и берётся он на день расчёта: команда, после которой листы будущих недель ждут другого
 *   человека, исполнена быть не может. Гейт сравнивает планы без человека (иначе он отвергал бы
 *   саму работу двери), поэтому кого напечатает исполнитель, спрашивается отдельной проверкой —
 *   и спрашивается **до** сравнения документов, чтобы причина отказа была настоящей (Ю49).
 *
 * При `read_mode = history` гейта нет вовсе, и все три отказа исчезают вместе с ним: шаг 12
 * исполняет сам отрезковый план (`syncCrewPaper` → `applyAssignmentPaper`), а он несёт машину и
 * человека в каждом элементе `issue` — то есть умеет и разрез посреди недели, и разных людей в
 * соседних листах. Именно это делает достижимой плановую смену будущей датой (Ю49).
 *
 * Гейт при этом **снимается режимом, а не удаляется**: переключение обратимо (§10), и после отката
 * недельная сверка снова остаётся единственным исполнителем — вместе с её границами.
 *
 * ГДЕ ГРАНИЦА С КАРКАСОМ. Порядок транзакции, блокировки, отпечаток, журнал коррекций, версия и
 * аудит принадлежат `assignment-command.ts`; запись строк — `assignment-write.ts`; проекции
 * последствий — `assignment-effects.ts`; план листов — `esm2-plan.ts`. Здесь только предметные
 * правила команды машиниста и расчёт того, что она обязана назвать человеку.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Двух вещей, и обе принадлежат соседям:
 *
 * - **готовность истории** (`assignment_history_state`, Р26) команда не считает сама. Состояние —
 *   вывод автомата, который живёт в `ensureAssignmentHistory` вместе с ленивым бэкфиллом и
 *   revalidation; подняв его здесь «раз уж проверили инвариант», дверь завела бы второй ответ на
 *   вопрос «когда заявка стала `ready`». Дверь зовёт автомат дважды и в двух разных ролях: шагом 5
 *   — расчётом (`planAssignmentHistory`, ни одной записи), шагом 11 — записью, и только там;
 * - **предупреждения выпускаемых листов** (`issues`, рукопожатие Б4) предпросмотр не считает: их
 *   считает `esm2IssueWarnings` внутри барьерного `waybill-esm2.ts` и только в момент выписки. У
 *   недельной сверки просителя нет (`requester: { by: 'sync' }`), подтверждать ей нечего, и пустой
 *   список здесь — правда о сегодняшнем исполнителе, а не заглушка. Наполнится он вместе с
 *   исполнителем отрезкового плана (§8, шаг 12).
 */

// ── Что дверь посчитала ──

/** Вид команды, каким его видит журнал и портал. */
export type CrewCommandKind = AssignmentCommandInput['kind'];

/**
 * Предметный план команды: всё, что посчитано до первой записи и дальше только читается.
 *
 * Один объект на предпросмотр и на исполнение намеренно (§8): предпросмотр обязан обещать ровно то,
 * что произойдёт, а вторая копия расчёта разошлась бы с первой на первом же новом правиле.
 */
export interface CrewPlan {
  kind: CrewCommandKind;
  /** Мутации истории для ядра записи — в том порядке, в каком их считали последствия. */
  mutations: AssignmentWriteMutation[];
  /**
   * Что команда обещает сделать с денормализацией (Р17). У этой двери значений два: обычное
   * `keep` — «решение о человеке назначения не касается» — и `tail_release` у отмены дремлющего
   * решения хвоста, где хвост истории **законно** расходится с назначением.
   */
  denormalization: AssignmentDenormalizationIntent;
  /** Якоря, которых команде ещё не хватает (Р16). Непусты — предпросмотр первой фазы. */
  requiredAnchors: RequiredAnchor[];
  /** Якоря, названные телом и принятые: они же уходят в снимок операции. */
  anchors: MachinistAnchor[];
  /** Отрезки постоянного состава **после** команды — по ним считаются бумага и постусловие. */
  segmentsAfter: AssignmentSegment[];
  /** Область сверки: документное замыкание дневного диапазона (Р11, §7). */
  paperScope: DateRangeSet;
  /** План листов на отрезках — предмет предпросмотра и постусловия. */
  sheetPlan: Esm2SheetPlan;
  /** Листы под разблокировку, названные сервером (Р11); подтверждается отпечатком, а не списком. */
  requiredUnlocks: { waybillId: string; displayNumber: string; from: string; to: string }[];
  /** Отпечаток множества разблокировок; `null` — исход не `crew`, разблокировок не спрашивают. */
  unlockFingerprint: string | null;
  /** Аннулируемые и выписываемые листы — так, как их показывает окно. */
  preview: { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] };
  /**
   * Машинист, действующий на день расчёта **после** команды. Им идёт недельная сверка шага 12 в
   * режиме `legacy`: «машинист заявки» у неё один, и другого значения, совместимого со старой
   * бумагой, нет. В `history` поле не читается вовсе — там человека несёт каждый отрезок плана.
   */
  legacyDriverPersonId: string | null;
  /** Режим ведения листов (`esm2Mode`): `none` — бумаги у заявки нет вовсе. */
  esm2Mode: Esm2Mode;
  /** Принадлежность машин разреза — вход плана листов и постусловия. */
  ownershipByVehicle: Map<string, VehicleOwnership>;
  /** Срок заявки, каким его прочитал каркас. */
  term: AssignmentTerm;
  /**
   * Действующие листы заявки и их напечатанные номера — прочитанные шагом 6 и **один раз**.
   *
   * Нужны шагу 12: исполнитель отрезкового плана называет сгоревшую бумагу номером, а прочитать
   * его после аннулирования уже поздно. Второе чтение здесь означало бы, что предпросмотр обещал
   * одни номера, а журнал назвал другие.
   */
  sheets: Esm2ExistingSheet[];
  sheetNumbers: Map<string, string>;
}

/** Что дверь пронесла через шаг 12 в аудит. */
export interface CrewPaper {
  esm2: Esm2SyncResult;
}

// ── Расчёт (шаги 4–6 канона) ──

const DOOR = 'assignment-changes';

/** Происхождение строк этой двери — и основной, и якорей (Р16). */
const CREW_ORIGIN = 'machinist_change' as const;

/**
 * Посчитать команду машиниста целиком: цель, якоря, последствия, бумагу и отпечаток.
 *
 * Транзакция приходит читающей (`readOnlyTx` каркаса): до сверки отпечатка и авторизации команда
 * ничего не записывает (Р20). Все отказы этой функции — предметные, и потому они здесь, а не в
 * схеме: пуста команда или нет, историческая она или плановая, видно только под блокировкой.
 */
export async function planCrewCommand(
  ctx: AssignmentPlanContext,
  input: AssignmentCommandInput,
): Promise<{ effects: AssignmentEffects; fingerprint: string; plan: CrewPlan }> {
  const { tx, request, asOf, mode } = ctx;
  const term = request.term;

  // Архивная заявка этой дверью не открывается: её выводит из архива своя ручка, а ремонт истории
  // адресуется идентификатором намеренно и живёт в другой двери (Ц3).
  if (request.deletedAt) throw err.notFound('Заявка не найдена');
  /*
   * Шаг 5 канона в его расчётной половине (Р20): готовность истории **считается**, а не пишется.
   * У заказа, заведённого до модуля, строк нет вовсе, и `readAssignmentChanges` вернул бы пустоту —
   * то есть команда переписала бы весь срок одним составом. Поэтому история берётся у автомата
   * готовности, который умеет восстановить её по бумаге и назначению (§6, Р26), и берётся в режиме
   * расчёта: те же входы, тот же результат, ни одной записи. Запись этих же строк идёт шагом 11 —
   * там же, где записывает команда, — и до неё транзакция ничего о заявке не утверждает.
   *
   * Не восстановилась — отказ, и он остался единственным: чинить неоднозначную бумагу командой
   * машиниста нечем (§13, «неудачный ленивый бэкфилл не оставляет ни строк, ни состояния»).
   */
  const history = await planAssignmentHistory(tx, { requestId: request.id, asOf });
  if (history.state === 'empty') {
    throw err.unprocessable(
      `История назначения этой заявки не восстановлена: ${assignmentHistoryUnrestorableReason(history.unrestorable)}`,
      { requestId: 'История не материализована' },
    );
  }

  const changes = history.changes;

  // Режим бумаги и действующие листы — одним чтением у той работы, которая их и считает: своя
  // копия «что такое действующий лист заявки» разошлась бы со сверкой при первой же правке.
  const base = await buildEsm2SyncPlan(tx, { requestId: request.id, asOf });
  if (!base) throw err.notFound('Заявка не найдена');
  const esm2Mode = base.input.mode;
  const sheets: Esm2ExistingSheet[] = [...base.input.existing];
  // Р14: у линейного заказа машиниста заявки не существует вовсе (ADR 0100 §6) — его называют при
  // выписке каждого листа, и история человека там ничего не решает.
  if (esm2Mode === 'on_demand') {
    throw err.unprocessable(
      'У линейного заказа машиниста называют при выписке листа, а не на заявке — история состава здесь не ведётся',
      { requestId: 'Линейный заказ' },
    );
  }

  const target = input.kind === 'cancel' ? resolveChangeTarget(changes, input.target) : null;
  const group = target ? changes.filter((row) => row.changeGroupId === target.changeGroupId) : [];
  const main =
    input.kind === 'set'
      ? planSet(changes, input, term)
      : planCancel(group, target!, changes, term, asOf);

  const ownershipByVehicle = await readOwnership(tx, request.id, changes);

  // Первая фаза Р16: свёртка **без** якорей тела — по ней и называются границы, на которых
  // портал спрашивает имена. Считать её после наложения якорей нельзя: чужая дата тогда прошла бы
  // проверку «названа предпросмотром» сама на себя.
  const bare = foldOf(changes, main.rows, main.removed, term);
  const mutable = mutableRegion(asOf, term, sheets, main.inTermOfMain);
  const bareAnchors = requiredAnchorsOf(bare, mutable, ownershipByVehicle, request);

  const anchors = [...(input.anchors ?? [])].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0,
  );
  assertAnchorDates(anchors, bareAnchors);
  const anchorPlans = anchors.map((anchor) => planAnchor(changes, anchor));

  const rows = [...main.rows, ...anchorPlans.flatMap((a) => a.rows)];
  const removed = [...main.removed, ...anchorPlans.flatMap((a) => a.removed)];
  const segmentsAfter = foldOf(changes, rows, removed, term);
  const requiredAnchors = requiredAnchorsOf(
    segmentsAfter,
    mutable,
    ownershipByVehicle,
    request,
  ).filter((gap) => !anchors.some((a) => a.effectiveDate === gap.effectiveDate));

  const mutations = [...main.mutations, ...anchorPlans.flatMap((a) => a.mutations)];
  const effectMutations = [...main.effects, ...anchorPlans.flatMap((a) => a.effects)];

  const segmentsBefore = assignmentSegments(changes, term);
  const planContextOf = (options: {
    scope?: DateRangeSet;
    unlockWaybillIds?: readonly string[];
    correction?: boolean;
  }) => ({
    ownershipByVehicle,
    today: asOf,
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.unlockWaybillIds ? { unlockWaybillIds: options.unlockWaybillIds } : {}),
    ...(options.correction ? { correction: { allowed: true as const } } : {}),
  });
  /** Отрезки `wanted` до и после команды: замыкание считается по обоим разрезам (§7). */
  const wanted: Esm2Period[] =
    esm2Mode === 'none'
      ? []
      : [
          ...esm2SheetPlan(segmentsBefore, term, [], planContextOf({})).wanted,
          ...esm2SheetPlan(segmentsAfter, term, [], planContextOf({})).wanted,
        ];

  const effects = assignmentCommandEffects({
    changes,
    term,
    asOf,
    mutations: effectMutations,
    sheets,
    wanted,
  });

  /*
   * Д1: до переключения чтения дремлющая запись **не заводится**. Правило смотрит на `insert` и
   * `replace`, а не на любую дремлющую мутацию, и разница здесь смысловая, а не техническая.
   * Опасность Д1 в том, что запись за концом срока оживёт при продлении и разведёт старый расчёт с
   * новым: старый возьмёт машиниста с последнего листа, новый — из истории. Заведение такой записи
   * эту мину закладывает, а **отмена** — снимает. Запрети мы и отмену, дремлющее решение стало бы
   * неудаляемым ровно в том виде, ради устранения которого Р24 и написан.
   */
  if (
    !historyIsAuthoritative(mode) &&
    effects.mutations.some((m) => m.inTerm === null && m.kind !== 'cancel')
  ) {
    throw err.unprocessable(
      'Дата за пределами срока работ: запись, которая ждёт продления срока, включается вместе с переключением чтения истории — пока назначайте машиниста датой внутри срока',
      { effectiveDate: 'Дата вне срока' },
    );
  }

  const paperScope = effects.paperScope;
  // Разблокировки считаются по плану **без** них: `locked` первого прохода и есть то множество,
  // которое операция обязана назвать, чтобы переоформить отработанную бумагу (Р11).
  const probe =
    esm2Mode === 'none'
      ? EMPTY_SHEET_PLAN
      : esm2SheetPlan(segmentsAfter, term, sheets, planContextOf({ scope: paperScope }));
  const requiredUnlockIds = effects.needsCorrection ? [...probe.locked].sort() : [];
  const sheetPlan =
    esm2Mode === 'none'
      ? EMPTY_SHEET_PLAN
      : esm2SheetPlan(
          segmentsAfter,
          term,
          sheets,
          planContextOf({
            scope: paperScope,
            unlockWaybillIds: requiredUnlockIds,
            correction: effects.needsCorrection,
          }),
        );

  const legacyDriverPersonId = driverOn(segmentsAfter, clampToTerm(asOf, term));
  /*
   * В3: гейт совместимости — под той же блокировкой и по гипотетическому состоянию. Старый план
   * считается ровно теми входами, с какими шаг 12 его и исполнит.
   *
   * **Спрашивается он только в `legacy`** (§10). Гейт существует ради одного: доказать, что работу
   * отрезкового плана способна исполнить недельная сверка, — а в `history` её исполняет сам
   * отрезковый план (`syncCrewPaper`), и доказывать нечего. Оставь мы гейт включённым после
   * переключения — он запретил бы ровно то, ради чего переключение и делалось: разрез посреди
   * недели и плановую смену машиниста будущей датой (Ю49). Снимается он вместе с чтением, а не
   * удаляется: режим двигается в обе стороны, и после отката недельная сверка снова единственный
   * исполнитель.
   *
   * Проверок две, и порядок между ними смысловой. Первая — **кто** будет напечатан
   * (`assertLegacyDriverReachable`): сверка знает одного машиниста заявки, и команда, оставляющая
   * бумагу области другому человеку, ей неисполнима вовсе. Вторая — **какие документы** выйдут
   * (`assertLegacyComparable`): границы и машина. Спроси мы их наоборот, плановая смена машиниста
   * будущей датой получала бы отказ про границу недели — на дате, которая является точной
   * границей недели (Ю49).
   *
   * Спрашиваются они у **завершённой команды с непустой областью бумаги**, и оба условия по делу:
   *
   * - пока предпросмотр первой фазы ждёт имена (Р16), гипотетического состояния ещё не существует —
   *   сравнивать нечего, а человеку в этот момент нужен ответ «назовите машиниста», а не «дата
   *   режет неделю»;
   * - пустая область бумаги означает дремлющую команду (Р24): она бумаги не трогает вовсе, шаг 12
   *   у неё не работает, и сравнивать её пустой план с **несуженным** старым значило бы отвергать
   *   отмену дремлющего решения из-за расхождения бумаги, к которому она отношения не имеет.
   */
  if (!historyIsAuthoritative(mode) && requiredAnchors.length === 0 && paperScope.length > 0) {
    assertLegacyDriverReachable(sheetPlan, paperScope, base.input.wanted, legacyDriverPersonId);
    const legacy = await buildEsm2SyncPlan(tx, {
      requestId: request.id,
      asOf,
      driverPersonId: legacyDriverPersonId,
      ...(effects.needsCorrection
        ? { correction: { id: LEGACY_GATE_PROBE, unlockWaybillIds: requiredUnlockIds } }
        : {}),
    });
    assertLegacyComparable(
      legacy?.plan ?? { cancel: [], issue: [] },
      sheetPlan,
      base.input.vehicleId,
    );
  }

  const numbers = await readSheetNumbers(tx, request.id);
  const names = await readNames(tx, sheetPlan);
  const preview = previewPlanOf(sheetPlan, sheets, numbers, names);
  const requiredUnlocks = requiredUnlockIds.map((id) => {
    const sheet = sheets.find((s) => s.id === id);
    return {
      waybillId: id,
      displayNumber: numbers.get(id) ?? id,
      from: sheet?.periodFrom ?? '',
      to: sheet?.periodTo ?? '',
    };
  });

  const plan: CrewPlan = {
    kind: input.kind,
    mutations,
    denormalization: main.denormalization,
    requiredAnchors,
    anchors,
    segmentsAfter,
    paperScope,
    sheetPlan,
    requiredUnlocks,
    unlockFingerprint: effects.needsCorrection ? fingerprintOf({ requiredUnlockIds }) : null,
    preview,
    legacyDriverPersonId,
    esm2Mode,
    ownershipByVehicle,
    term,
    sheets,
    sheetNumbers: numbers,
  };

  return {
    effects,
    fingerprint: previewFingerprintOf(request.id, asOf, input, effects, plan),
    plan,
  };
}

/** Пустой план листов: заявка без бумаги (`esm2Mode = 'none'`) считает по нему всё остальное. */
const EMPTY_SHEET_PLAN: Esm2SheetPlan = {
  wanted: [],
  cancel: [],
  issue: [],
  kept: [],
  locked: [],
  outOfScope: [],
};

/**
 * Идентификатор операции для **пробного** старого плана: `buildEsm2SyncPlan` ничего не пишет и в
 * `correction.id` не заглядывает вовсе — ему важно лишь, что контекст операции есть. Настоящая
 * строка журнала к моменту расчёта ещё не заведена (шаг 10 идёт после шага 6).
 */
const LEGACY_GATE_PROBE = 'legacy-gate-probe';

// ── Формы команды (Р13) ──

interface MainPlan {
  /** Строки, какими они станут: свёртка гипотетического состояния считается по ним. */
  rows: AssignmentChangeRecord[];
  mutations: AssignmentWriteMutation[];
  effects: AssignmentMutation[];
  /**
   * Диапазон основного решения внутри срока — им команда **открывает** изменяемую область (Р16,
   * Р21). Якоря сюда не входят: они как раз и закрывают пробелы внутри открытого отрезка, и считать
   * область по ним значило бы спрашивать имена там, куда команда не дотягивается.
   */
  inTermOfMain: AssignmentRange | null;
  /** Строки, которые команда гасит: свёртка считается без них. */
  removed: string[];
  /** Обещание по денормализации (Р17): его проверит ядро в конце шага 11. */
  denormalization: AssignmentDenormalizationIntent;
}

/**
 * `set` — заведение или правка решения о машинисте (Р13).
 *
 * Форм записи две, и выбирает между ними не тело, а история: свободная дата — новая строка, занятая
 * — замена. Переносом даты это не бывает (перенос — `cancel` + `set`): цепочка замен физически
 * привязана к дате составным FK.
 */
function planSet(
  changes: readonly AssignmentChangeRecord[],
  input: Extract<AssignmentCommandInput, { kind: 'set' }>,
  term: AssignmentTerm,
): MainPlan {
  const date = input.effectiveDate;
  // Раньше начала срока — 422: там нет работы (Р13). Позже `dateTo` допускается — такое изменение
  // дремлет (Р24), и отвергает его до переключения чтения гейт совместимости, а не это правило.
  if (date < term.dateFrom) {
    throw err.unprocessable(
      `Дата раньше начала работ (${term.dateFrom}): до срока заявки машинист не работает`,
      { effectiveDate: 'Раньше начала срока' },
    );
  }

  const next: DriverState = { state: 'set', personId: input.driverPersonId };
  // Р12: пустых изменений не бывает — сверка со **свёрткой** на дату, а не с соседней строкой.
  if (sameDriverState(assignmentStateOn(changes, date).driver, next)) {
    throw err.unprocessable('На эту дату уже назначен тот же машинист — изменения не будет', {
      driverPersonId: 'Тот же машинист',
    });
  }

  const existing = changes.find((row) => row.dimension === 'driver' && row.effectiveDate === date);
  const row = syntheticRow(date, next, existing?.changeGroupId);
  const inTermOfMain = plannedEffectRange(changes, 'driver', date, term).inTerm;
  if (!existing) {
    return {
      rows: [row],
      mutations: [
        { kind: 'insert', effectiveDate: date, origin: CREW_ORIGIN, value: driverValue(next) },
      ],
      effects: [{ kind: 'insert', dimension: 'driver', effectiveDate: date, origin: CREW_ORIGIN }],
      inTermOfMain,
      removed: [],
      denormalization: { kind: 'keep' },
    };
  }
  assertReplaceable(existing);
  return {
    rows: [row],
    mutations: [
      {
        kind: 'replace',
        // Адресуется логическим ключом, если строка восстановлена расчётом и `id` у неё ещё нет
        // (Р10): её саму запишет `ensureAssignmentHistory` тем же шагом 11, но раньше замены.
        target: assignmentChangeTargetOf(existing),
        origin: CREW_ORIGIN,
        value: driverValue(next),
      },
    ],
    effects: [{ kind: 'replace', changeId: existing.id }],
    inTermOfMain,
    removed: [existing.id],
    denormalization: { kind: 'keep' },
  };
}

/**
 * `cancel` — снятие решения (Р13). Гасится всегда вся группа, а не одна строка (В2).
 *
 * Границы у отмены три, и все три здесь:
 *
 * - шкала `driver` с датой строго позже дня расчёта — обычная отмена планового решения;
 * - **дремлющее** изменение с пустым `inTermRange` — независимо от того, наступила ли дата (Р24):
 *   иначе получилась бы неудаляемая запись, которая оживёт при любом будущем продлении срока;
 * - прошлое отменой не правится (Р10): его правит `set` исторической датой, то есть коррекция.
 */
function planCancel(
  group: readonly AssignmentChangeRecord[],
  target: AssignmentChangeRecord,
  changes: readonly AssignmentChangeRecord[],
  term: AssignmentTerm,
  asOf: string,
): MainPlan {
  const denormalization = assertCancellable(group, target);
  const inTerm = groupInTerm(group, changes, term);
  if (denormalization.kind === 'tail_release') {
    /*
     * Р31 дословно: группа решения хвоста отменяется, **пока её `inTermRange` пуст**, — и
     * календарная дата здесь условием не является, а вот наступивший срок является. Продлили срок
     * — дремлющая граница ожила и стала обычным решением о технике внутри работы: снимать её этой
     * дверью нельзя, потому что вместе с ней уедут ставки и занятость (Р7). Переигрывает её та же
     * дверь ремонта, которая её и приняла.
     */
    if (inTerm !== null) {
      throw err.unprocessable(
        'Запись о машине после конца срока попала внутрь срока работ: срок продлили, и она стала обычным решением о технике. Снять его этой дверью нельзя — вместе с ним уедут ставки и занятость. Переиграйте решение ремонтом истории',
        { target: 'Запись действует внутри срока работ' },
      );
    }
  } else if (target.effectiveDate <= asOf && inTerm !== null) {
    throw err.unprocessable(
      'Прошедшие дни отменой не правятся — назначьте на эту дату другого машиниста: так у правки останутся причина и автор',
      { target: 'Прошлое правится коррекцией' },
    );
  }
  return {
    rows: [],
    mutations: [{ kind: 'cancel', target: assignmentChangeTargetOf(target) }],
    effects: group.map((row) => ({ kind: 'cancel', changeId: row.id })),
    inTermOfMain: inTerm,
    removed: group.map((row) => row.id),
    denormalization,
  };
}

/**
 * Что этой дверью **правится**.
 *
 * Замена не трогает ни даты, ни шкалы, ни группы: она переписывает значение одной driver-строки, и
 * vehicle-спутник рядом с ней остаётся на месте. Поэтому правка начального решения (`origin =
 * 'assignment'`) здесь законна и нужна — это и есть коррекция «в марте работал не тот человек».
 *
 * Не правятся только строки заполнения неизвестного прошлого: у них своя дверь и свой смысл (Р29,
 * Ю2) — там снимается утверждение о факте, а не меняется решение.
 */
function assertReplaceable(row: AssignmentChangeRecord): void {
  if (row.origin === 'known_fill' || row.origin === 'unknown_remainder') {
    throw err.unprocessable(
      'Это заполнение неизвестного прошлого — правит и снимает его та же дверь, что заполняла (ремонт истории)',
      { target: 'Заполнение прошлого' },
    );
  }
}

/**
 * Что этой дверью **отменяется** и что при этом обещано денормализации (Р17).
 *
 * Отмена гасит всю `change_group_id` (В2), и отсюда все её запреты. Vehicle-строка в группе значит,
 * что решение принимала другая дверь, — но дверей этих две, и разбираются они по-разному:
 *
 * - **обычная смена техники** (её `cleared`-спутник живёт в той же группе, Р16): погасив группу,
 *   команда увела бы вместе со спутником машину, а с ней ставки, аренду и рейс (Р7). Отказ;
 * - **решение хвоста** (`origin = 'tail_resolution'`, Р31): его дремлющая группа отменяется именно
 *   здесь — §8 отправляет её в эту ручку, — и обещание по денормализации у неё своё,
 *   `tail_release`. Граница снята, назначение и ставки не тронуты, а хвост истории **законно**
 *   разошёлся с назначением: вопрос «чем заявка закрыта после срока» снова открыт, и отвечает на
 *   него следующее решение хвоста. `keep` здесь падает по построению, и это не придирка ядра —
 *   сдвинувшийся хвост при `keep` означает дверь, забывшую перевести назначение.
 *
 * Начальное решение не отменяется никогда (Р13): его задаёт перевод заявки в работу, и снять его
 * значило бы объявить, что заявку в работу не переводили.
 */
function assertCancellable(
  group: readonly AssignmentChangeRecord[],
  row: AssignmentChangeRecord,
): AssignmentDenormalizationIntent {
  if (group.some((r) => r.dimension === 'vehicle')) {
    // Провенанс, а не состав (Ю2): по строкам группу решения хвоста не отличить от обычной смены
    // техники — граница на `dateTo + 1` по составу это та же vehicle-строка со спутником.
    if (group.every((r) => r.origin === 'tail_resolution')) return { kind: 'tail_release' };
    throw err.unprocessable(
      `Это решение о технике, а не о машинисте (${assignmentDimensionLabels.vehicle}): отменить его можно только вместе с машиной — окном смены техники или ремонтом истории`,
      { target: 'Решение о технике' },
    );
  }
  if (row.origin === 'assignment') {
    throw err.unprocessable(
      'Начальное назначение не отменяется: его задаёт перевод заявки в работу — назначьте на эту дату другого машиниста',
      { target: 'Начальное назначение' },
    );
  }
  assertReplaceable(row);
  return { kind: 'keep' };
}

/**
 * Диапазон группы внутри срока: пусто у всех её строк — группа дремлет (Р24, Р31).
 *
 * Считается **до** гашения, пока строки ещё актуальны: прежний `inTermRange`, по которому Р32
 * выбирает вид операции, исчез бы вместе с ними, и отмена исторического решения выглядела бы
 * безобидной.
 */
function groupInTerm(
  group: readonly AssignmentChangeRecord[],
  changes: readonly AssignmentChangeRecord[],
  term: AssignmentTerm,
): AssignmentRange | null {
  const ranges = normalizeRangeSet(
    group.flatMap((row) => {
      const effect = assignmentEffectRange(changes, row.id, term);
      return effect?.inTerm ? [effect.inTerm] : [];
    }),
  );
  return ranges[0] ?? null;
}

// ── Якоря (Р16) ──

interface AnchorPlan {
  rows: AssignmentChangeRecord[];
  mutations: AssignmentWriteMutation[];
  effects: AssignmentMutation[];
  /** Строка, которую якорь заменяет: свёртка гипотетического состояния считается без неё. */
  removed: string[];
}

/**
 * Якорь — обычное driver-изменение на названной границе, и записывается он теми же двумя формами,
 * что и основное решение: свободная дата — вставка, занятая — замена.
 *
 * `origin` у него `machinist_change`, а группа своя, одиночная (Р16, Г2): якорь — самостоятельное
 * решение человека, и гаснуть вместе с основным изменением он не должен.
 */
function planAnchor(
  changes: readonly AssignmentChangeRecord[],
  anchor: MachinistAnchor,
): AnchorPlan {
  const value: DriverState = { state: 'set', personId: anchor.driverPersonId };
  const existing = changes.find(
    (row) => row.dimension === 'driver' && row.effectiveDate === anchor.effectiveDate,
  );
  if (!existing) {
    return {
      rows: [syntheticRow(anchor.effectiveDate, value)],
      mutations: [
        {
          kind: 'insert',
          effectiveDate: anchor.effectiveDate,
          origin: CREW_ORIGIN,
          value: driverValue(value),
        },
      ],
      effects: [
        {
          kind: 'insert',
          dimension: 'driver',
          effectiveDate: anchor.effectiveDate,
          origin: CREW_ORIGIN,
        },
      ],
      removed: [],
    };
  }
  assertReplaceable(existing);
  return {
    rows: [syntheticRow(anchor.effectiveDate, value, existing.changeGroupId)],
    mutations: [
      {
        kind: 'replace',
        target: { changeId: existing.id },
        origin: CREW_ORIGIN,
        value: driverValue(value),
      },
    ],
    effects: [{ kind: 'replace', changeId: existing.id }],
    removed: [existing.id],
  };
}

/**
 * Изменяемая область команды (Р21):
 *
 * ```
 * mutable = отменяемые дни ∪ будущее ∪ исторический диапазон, открытый коррекцией этой команды
 * ```
 *
 * «Отменяемые дни» считаются по самим листам, а не по календарю: неделя, чей лист ещё можно
 * аннулировать, изменяема целиком, включая её начало в прошлом. Ради этого граница и берётся у
 * `canCancelWaybill` — второй расчёт «когда неделя кончилась» разошёлся бы с первым на шесть дней.
 *
 * Исторический диапазон приносит **основное** изменение, а не якоря: якоря как раз и закрывают
 * пробелы внутри открытого им отрезка, и считать область по ним значило бы спрашивать имена там,
 * куда команда не дотягивается.
 */
function mutableRegion(
  asOf: string,
  term: AssignmentTerm,
  sheets: readonly Esm2ExistingSheet[],
  openedByCommand: AssignmentRange | null,
): DateRangeSet {
  const last = term.dateTo || term.dateFrom;
  const ranges: AssignmentRange[] = [];
  if (last >= asOf) ranges.push({ from: asOf, to: last });
  for (const sheet of sheets) {
    if (canCancelWaybill({ issuedForDate: sheet.periodFrom, periodTo: sheet.periodTo }, asOf)) {
      ranges.push({ from: sheet.periodFrom, to: sheet.periodTo });
    }
  }
  if (openedByCommand) ranges.push(openedByCommand);
  return normalizeRangeSet(ranges);
}

/**
 * Пробелы машиниста на изменяемых днях — то, что человек обязан закрыть якорями (Р16).
 *
 * Спрашивается у **`portal`-отрезка**: у арендного бланк ведёт арендодатель, у отрезка без машины
 * печатать нечего. Три состояния шкалы различаются здесь до конца (Р19): `set` — выполнено,
 * `cleared` и `unknown` — нарушение наравне с незаданной шкалой, потому что на изменяемых днях
 * «машиниста нет» и «истории не знаем» одинаково не годятся для бланка.
 *
 * Дата якоря подрезается изменяемой областью: отрезок, начавшийся в заблокированном прошлом,
 * спрашивает имя с первого **изменяемого** своего дня — назвав его началом, портал потребовал бы
 * коррекционных прав там, где команда прошлого не трогает.
 */
function requiredAnchorsOf(
  segments: readonly AssignmentSegment[],
  mutable: DateRangeSet,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
  request: { id: string; num: number },
): RequiredAnchor[] {
  const anchors: RequiredAnchor[] = [];
  for (const segment of segments) {
    if (!segment.vehicle) continue;
    if (ownershipByVehicle.get(segment.vehicle.vehicleId) !== 'own') continue;
    if (segment.driver?.state === 'set') continue;
    const overlap = mutable.find((part) => part.from <= segment.to && segment.from <= part.to);
    if (!overlap) continue;
    anchors.push({
      requestId: request.id,
      requestNumber: formatVehicleRequestNumber(request.num),
      effectiveDate: overlap.from > segment.from ? overlap.from : segment.from,
      from: segment.from,
      to: segment.to,
    });
  }
  return anchors;
}

/**
 * Якорь принимается только на дату, названную предпросмотром (Р16). Чужая — 422.
 *
 * Правило это и делает поле якорей полем **ответа на вопрос**, а не второй дверью в историю: без
 * него одним и тем же телом можно было бы вписать человека на любую дату срока, минуя и Р12, и
 * матрицу исходов Р32.
 */
function assertAnchorDates(anchors: readonly MachinistAnchor[], required: RequiredAnchor[]): void {
  const allowed = new Set(required.map((a) => a.effectiveDate));
  const foreign = anchors.filter((a) => !allowed.has(a.effectiveDate));
  if (foreign.length === 0) return;
  throw err.unprocessable(
    `Якорь на дату ${foreign.map((a) => a.effectiveDate).join(', ')} не требуется: назначить машиниста на эту дату можно отдельной командой`,
    { anchors: 'Дата не названа предпросмотром' },
  );
}

// ── Гейт совместимости со старой бумагой (Б1, В3, Д1) ──

/**
 * Сравнимая форма плана: **какие номера сгорят и какие документы выпишутся**, названные границами
 * и машиной.
 *
 * Человек в сравнение не входит, и это не упрощение. Старый алгоритм печатает во всех своих
 * документах одного машиниста заявки по построению, новый — машиниста отрезка; требуй сравнение
 * совпадения людей, оно отвергало бы саму работу двери. А вот **границы и машина** — ровно то,
 * чем разрез отличается от недели (Б1): смена в середине выписанной недели даёт у старого один
 * документ пн–вс, а у нового два — пн–вт и ср–вс, — и это расхождение видно здесь.
 */
function legacyComparable(
  cancel: readonly string[],
  issue: readonly { from: string; to: string; vehicleId: string }[],
): string {
  // Нормализатор один на гейт, теневое сравнение и тесты (Г4): три копии этой проекции разошлись
  // бы молча, каждая на своей правке. Человек из ключа исключён — см. комментарий выше.
  return legacyComparableKey(
    toLegacyComparable(
      cancel,
      issue.map((i) => ({ ...i, driverPersonId: null })),
    ),
    { withDriver: false },
  );
}

/**
 * Вторая половина гейта: **кого** напечатает исполнитель (Б1, Д1, Ю49).
 *
 * `legacyComparable` сравнивает планы без человека намеренно — иначе гейт отвергал бы саму работу
 * двери, — и потому не видит единственного, чем этап 3 ограничен по существу: недельная сверка
 * шага 12 знает **одного** машиниста заявки и печатает его во всех листах, которые выписывает.
 * Машинист этот — тот, что работает на день расчёта (`legacyDriverPersonId`): другого значения,
 * совместимого со старой бумагой, у неё нет. Значит команда, после которой бумага области ждёт
 * другого человека, шагом 12 неисполнима — и отвергать её обязан гейт, а не постусловие Р11 после
 * проведённой команды.
 *
 * Отсюда граница исполнимого: **вся бумага, которую команда трогает, обязана принадлежать
 * машинисту дня расчёта**. У плановой смены это и значит «датой не позже сегодняшней»: тогда
 * «машинист заявки» и «машинист отрезка» — один человек, и старый исполнитель делает ровно то, что
 * обещал новый план. Дата позже дня расчёта оставляет прежнего человека на сегодняшнем отрезке, а
 * листам будущих недель нужен новый — такого сверке не выразить. Тем же условием отсекается и
 * редкая правка прошлого, чья область кончается **до** следующего решения о машинисте (Р11): листы
 * отрезка ждут одного человека, а сверка напечатает того, кто работает сегодня.
 *
 * Спрашивается только у листов, чьи границы старый алгоритм **воспроизводит** (`legacyPeriods` —
 * недели срока, каким их считает сверка). Разрез в середине недели даёт отрезок, недели не
 * равный, и виноват там не человек, а граница: у такой команды свой отказ и свой выход — выбрать
 * границу недели (`assertLegacyComparable`). Не раздели мы эти два случая, разрез посреди недели
 * получал бы совет «меняйте машиниста датой не позже сегодняшней», уже им выполненный.
 */
function assertLegacyDriverReachable(
  fresh: Esm2SheetPlan,
  scope: DateRangeSet,
  legacyPeriods: readonly Esm2Period[],
  legacyDriverPersonId: string | null,
): void {
  const foreign = fresh.wanted
    .filter(
      (want) =>
        want.driver.state === 'set' &&
        want.driver.personId !== legacyDriverPersonId &&
        rangeSetCovers(scope, { from: want.from, to: want.to }) &&
        legacyPeriods.some((period) => period.from === want.from && period.to === want.to),
    )
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const first = foreign[0];
  if (!first) return;
  throw err.unprocessable(
    `Исполнить эту команду нечем: до переключения чтения истории портал печатает во всех листах, которые выписывает, одного машиниста — того, кто работает на день расчёта, — а листам с ${first.from} нужен другой. Смена машиниста отрезком включится вместе с переключением чтения; сейчас машиниста меняют датой не позже сегодняшней, и работает он до конца срока`,
    { effectiveDate: 'Смена этой датой пока недоступна' },
  );
}

/**
 * Гейт этапа 3 (Б1, В3, Д1): команда проходит тогда и только тогда, когда старый и новый планы
 * совпадают — на гипотетическом состоянии и под той же блокировкой.
 *
 * Это и есть то, что делает шаг 12 законным: исполняет недельная сверка, а обещал предпросмотр
 * отрезковый план, — и равенство планов доказано ровно перед исполнением. Отказ здесь не «так
 * нельзя никогда», а «пока читается старая бумага», поэтому текст называет и причину, и путь:
 * граница недели или граница существующего листа.
 */
function assertLegacyComparable(
  legacy: { cancel: string[]; issue: readonly Esm2Period[] },
  fresh: Esm2SheetPlan,
  legacyVehicleId: string | null,
): void {
  const legacyKey = legacyComparable(
    legacy.cancel,
    legacy.issue.map((p) => ({ from: p.from, to: p.to, vehicleId: legacyVehicleId ?? '' })),
  );
  const freshKey = legacyComparable(
    fresh.cancel,
    fresh.issue.map((i) => ({ from: i.from, to: i.to, vehicleId: i.vehicleId })),
  );
  if (legacyKey === freshKey) return;
  throw err.unprocessable(
    'Такая дата режет уже выписанную неделю надвое, а до переключения чтения истории портал ведёт бумагу неделями: выберите границу недели или границу существующего листа',
    { effectiveDate: 'Дата не совпадает с границей недели' },
    { legacyPlan: legacy, historyPlan: { cancel: fresh.cancel, issue: fresh.issue } },
  );
}

// ── Свёртка гипотетического состояния ──

/**
 * Отрезки состава **после** команды, посчитанные на строках, которых ещё нет.
 *
 * Гипотетическая свёртка — единственный способ проверить Р16 до записи: инвариант глобален (он про
 * весь срок, а не про дату команды), и посчитать его по одной мутации нечем.
 *
 * Гашение выражается списком идентификаторов, а не «строкой той же даты»: отмена гасит **всю
 * группу** (В2), и её строки стоят на своих датах — вычитать их по дате значило бы потерять
 * половину отмены и посчитать свёртку по состоянию, которого после команды не будет.
 */
function foldOf(
  changes: readonly AssignmentChangeRecord[],
  added: readonly AssignmentChangeRecord[],
  removed: readonly string[],
  term: AssignmentTerm,
): AssignmentSegment[] {
  const dropped = new Set(removed);
  const kept = changes.filter((row) => !dropped.has(row.id));
  return assignmentSegments([...kept, ...added], term);
}

/** Машинист, действующий на названный день: им идёт недельная сверка шага 12. */
function driverOn(segments: readonly AssignmentSegment[], date: string): string | null {
  const segment = segments.find((s) => s.from <= date && date <= s.to);
  return segment?.driver?.state === 'set' ? segment.driver.personId : null;
}

/**
 * День расчёта, прижатый к сроку.
 *
 * «Машинист заявки» у недельной сверки один, и берётся он свёрткой на день расчёта. У заказа,
 * который весь лежит в прошлом (ремонт истории — обычный случай этапа 3), сегодняшний день в срок
 * не попадает вовсе, и свёртка на него не отвечает ничем: сверка получила бы `null` и отказала бы
 * «укажите машиниста» на работе, которую сама же и планировала.
 */
function clampToTerm(date: string, term: AssignmentTerm): string {
  const last = term.dateTo || term.dateFrom;
  if (date < term.dateFrom) return term.dateFrom;
  return date > last ? last : date;
}

let syntheticSeq = 0;

/** Строка, которой ещё нет: у неё есть всё, что читает свёртка, и ничего сверх того. */
function syntheticRow(
  effectiveDate: string,
  driver: DriverState,
  changeGroupId?: string,
): AssignmentChangeRecord {
  syntheticSeq += 1;
  return {
    id: `planned-${syntheticSeq}`,
    requestId: '',
    effectiveDate,
    dimension: 'driver',
    vehicleId: null,
    driverPersonId: driver.state === 'set' ? driver.personId : null,
    driverState: driver.state,
    origin: CREW_ORIGIN,
    changeGroupId: changeGroupId ?? `planned-group-${syntheticSeq}`,
    correctionId: null,
    createdBy: null,
    createdAt: new Date(0),
    supersedesChangeId: null,
    supersededAt: null,
    supersededKind: null,
  };
}

function driverValue(driver: DriverState) {
  return { dimension: 'driver' as const, driver };
}

// ── Отпечаток предпросмотра (Р20, Р32) ──

/** Отпечаток любого серверного множества — один способ на все четыре (§7). */
export function fingerprintOf(value: unknown): string {
  return correctionFingerprint(value);
}

/**
 * Отпечаток последствий: **содержание**, а не идентификаторы (Р20).
 *
 * Входит сюда семантическая команда (что и с какой даты меняем), день расчёта, исход и все
 * рассчитанные последствия. Не входят рукопожатия — версия, причина, ключ операции, входные
 * отпечатки и подтверждения: они появляются в теле **после** предпросмотра, и хеш всего боевого
 * тела не сошёлся бы никогда.
 *
 * Идентификаторы строк истории вычищены намеренно: у расчётной истории их нет вовсе, и отпечаток,
 * посчитанный по ним, перестал бы сходиться в тот день, когда команда пойдёт по невыписанной ещё
 * истории.
 */
function previewFingerprintOf(
  requestId: string,
  asOf: string,
  input: AssignmentCommandInput,
  effects: AssignmentEffects,
  plan: CrewPlan,
): string {
  const command =
    input.kind === 'set'
      ? {
          kind: 'set',
          dimension: input.dimension,
          effectiveDate: input.effectiveDate,
          driverPersonId: input.driverPersonId,
        }
      : { kind: 'cancel', target: plan.mutations.find((m) => m.kind === 'cancel') ?? null };
  return correctionFingerprint({
    door: DOOR,
    requestId,
    asOf,
    command,
    anchors: plan.anchors.map((a) => ({ ...a })),
    outcome: effects.operationOutcome,
    effects: {
      ...effects.payload,
      mutations: effects.payload.mutations.map(({ changeId: _id, ...rest }) => rest),
    },
    requiredAnchors: plan.requiredAnchors.map((a) => ({
      effectiveDate: a.effectiveDate,
      from: a.from,
      to: a.to,
    })),
    requiredUnlockIds: plan.requiredUnlocks.map((u) => u.waybillId),
    plan: {
      cancel: plan.preview.cancel.map((c) => c.waybillId).sort(),
      issue: plan.preview.issue.map((i) => `${i.from}|${i.to}|${i.vehicleId}|${i.driverPersonId}`),
    },
  });
}

// ── Рукопожатия (шаг 8) ──

/**
 * Что тело обязано подтвердить против **рассчитанного** плана (§8, Д4).
 *
 * Разблокировки: присутствие поля определяется исходом, а не желанием клиента. Лишний отпечаток при
 * исходе, который прошлого не трогает, — не «лишнее поле», а заявка на право сжечь чужие номера.
 *
 * Якоря: остаток `requiredAnchors` обязан быть пуст. Иначе команда записала бы историю, в которой
 * `portal`-отрезок остался без человека, — и сверка отказалась бы выписать на него лист уже после
 * того, как строки легли.
 */
export function assertCrewHandshake(
  effects: AssignmentEffects,
  plan: CrewPlan,
  input: AssignmentCommandInput,
): void {
  if (plan.requiredAnchors.length > 0) {
    throw err.unprocessable(
      `Назовите машиниста на отрезках без человека: ${plan.requiredAnchors
        .map((a) => `${a.effectiveDate} (${a.from} — ${a.to})`)
        .join('; ')}`,
      { anchors: 'Нужны якоря' },
      { requiredAnchors: plan.requiredAnchors },
    );
  }
  if (!effects.needsCorrection) {
    if (input.unlockFingerprint !== undefined) {
      throw err.unprocessable(
        'Эта команда прошлого не трогает — подтверждать разблокировку отработанных листов нечем',
        { unlockFingerprint: 'Лишнее подтверждение' },
      );
    }
    return;
  }
  if (input.unlockFingerprint !== plan.unlockFingerprint) {
    throw err.unprocessable(
      'Список отработанных листов, которые переоформит операция, изменился — посмотрите последствия заново',
      { unlockFingerprint: 'Подтверждение не совпало' },
      { requiredUnlocks: plan.requiredUnlocks },
    );
  }
}

// ── Условная авторизация (шаг 9, Р32) ──

/**
 * Права спрашиваются по **посчитанному исходу**, а не по телу и не по календарю (Р32).
 *
 * Глубину меряет только `crew`: у `assignment_tail` оба требования ложны, сколько бы лет ни было
 * его дате, — прошлого он не трогает, и мерить глубину не по чему.
 */
export function authorizeCrewCommand(
  subject: AccessSubject,
  effects: AssignmentEffects,
  asOf: string,
): WaybillCorrectionAuthorizationScope {
  const effectiveDate = effects.correctionEffectiveDate ?? asOf;
  const requiresCorrect = effects.needsCorrection;
  const requiresBeyond = requiresCorrect && effectiveDate < correctionFloorDateKey(asOf);
  assertCorrectionRights(subject, requiresCorrect, requiresBeyond);
  return {
    schemaVersion: 1,
    requiresCorrect,
    requiresCorrectBeyondLimit: requiresBeyond,
    requiresArchiveRestore: false,
    effectiveDate,
    authorizedAsOf: asOf,
  };
}

/**
 * Повтор (Р9 п. 4): цель заново не разрешается, а права перепроверяются по **сохранённому** снимку.
 *
 * Пересчитать их нельзя — операция, бывшая моложе тридцати дней при первом вызове, к повтору
 * успевает состариться, — но молча отдать прежний результат тому, у кого право успели отобрать, та
 * же утечка, что выполнить операцию без права.
 */
export function authorizeCrewRepeat(
  subject: AccessSubject,
  scope: WaybillCorrectionAuthorizationScope,
): void {
  assertCorrectionRights(subject, scope.requiresCorrect, scope.requiresCorrectBeyondLimit);
}

function assertCorrectionRights(
  subject: AccessSubject,
  requiresCorrect: boolean,
  requiresBeyond: boolean,
): void {
  if (requiresCorrect && !can(subject, 'waybills.correct')) {
    throw err.forbidden(
      'Изменение задевает прошедшие дни — правит их тот, у кого есть право коррекции задним числом',
    );
  }
  if (requiresBeyond && !can(subject, 'waybills.correctBeyondLimit')) {
    throw err.forbidden('Изменение глубже тридцати дней — такую коррекцию проводит администратор');
  }
}

// ── Спецификация команды для каркаса (§8) ──

/** Кто исполняет команду: идентификатор для журнала и права — для условной авторизации (Р32). */
export type CrewActor = AccessSubject & { id: string };

/**
 * Спецификация команды машиниста для `runAssignmentCommand` — **один** источник на боевую ручку и
 * на тесты двери.
 *
 * Собрана здесь, а не в роут-модуле, по той же причине, по какой предпросмотр зовёт тот же колбэк
 * `plan`, что и бой: место, где предметные места канона заполняются, должно быть одно. Роут-модуль
 * от этого остаётся тем, чем и должен быть, — HTTP: область видимости, разбор тела, ответ.
 */
export function crewCommandSpec(params: {
  requestId: string;
  actor: CrewActor;
  input: AssignmentCommandInput;
  asOf: string;
}): AssignmentCommandSpec<CrewPlan, AssignmentWriteResult, CrewPaper> {
  const { requestId, actor, input, asOf } = params;
  const reason = syncReasonOf(input);
  return {
    door: 'history',
    journalDoor: DOOR,
    requestId,
    actor: { id: actor.id },
    expectedVersion: input.version,
    body: normalizedCrewBody(input),
    operation: input.operation ?? null,
    previewFingerprint: input.previewFingerprint,
    asOf,
    plan: (ctx) => planCrewCommand(ctx, input),
    handshake: (ctx) => assertCrewHandshake(ctx.effects, ctx.plan, input),
    authorize: (ctx) => authorizeCrewCommand(actor, ctx.effects, ctx.asOf),
    authorizeRepeat: (scope) => authorizeCrewRepeat(actor, scope),
    mutate: async (ctx) => {
      /*
       * Шаг 11 начинается материализацией истории (Р20, Р26): расчёт шага 5 уже показал, во что
       * она превратится, — здесь эти же строки ложатся в базу, и происходит это **до** мутаций
       * команды. Порядок обязателен: команда планировала по восстановленной истории, и её замена
       * либо отмена адресуется строке, которую вписывает именно этот вызов.
       *
       * Той же операцией пишется готовность и снимается метка `assignment_history_dirty` (К4):
       * состояние — вывод автомата, который живёт в `ensureAssignmentHistory`, и второго ответа на
       * вопрос «когда заявка стала `ready`» у портала быть не должно.
       */
      await ensureCommandHistory(ctx.tx, { requestId, asOf: ctx.asOf });
      /*
       * Денормализацию команда не пишет никогда, но обещает ядру разное (Р17), и обещание считает
       * расчёт, а не это место. Обычная смена машиниста — `keep`: решение о человеке назначения не
       * касается, и сдвинувшийся хвост vehicle-истории означал бы ошибку двери. Отмена дремлющего
       * решения хвоста — `tail_release`: назначение так же нетронуто, а хвост расходится с ним
       * законно, потому что граница снята.
       */
      const write = await applyAssignmentMutations(ctx.tx, {
        requestId,
        actorUserId: actor.id,
        correctionId: ctx.operation?.id ?? null,
        mutations: ctx.plan.mutations,
        denormalization: ctx.plan.denormalization,
      });
      return { write, applied: write };
    },
    syncPaper: (ctx) =>
      syncCrewPaper(ctx.tx, {
        requestId,
        actor: { id: actor.id },
        reason,
        asOf: ctx.asOf,
        mode: ctx.mode,
        plan: ctx.plan,
        effects: ctx.effects,
        correctionId: ctx.operation?.id ?? null,
      }),
    payload: (ctx) => ({
      kind: ctx.plan.kind,
      anchors: ctx.plan.anchors,
      requiredUnlockIds: ctx.plan.requiredUnlocks.map((u) => u.waybillId),
      esm2: ctx.paper.esm2,
      history: historySnapshotOf(ctx.write),
    }),
    audit: (ctx) => crewAuditOf(ctx),
  };
}

/**
 * Нормализованное боевое тело для отпечатка операции (Р9, Р32).
 *
 * Сортируются поля-множества: у якорей порядок не значим, и перестановка тех же значений дала бы
 * ложный `CORRECTION_KEY_REUSED` на честном повторе. Ключи объектов сортирует сам
 * `correctionFingerprint`, поэтому `acknowledgements` трогать не нужно.
 */
function normalizedCrewBody(input: AssignmentCommandInput): unknown {
  if (!input.anchors) return input;
  return {
    ...input,
    anchors: [...input.anchors].sort((a, b) =>
      a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0,
    ),
  };
}

/** Причина, с которой идёт сверка бумаги: у операции — её собственная, у плановой смены — своя. */
function syncReasonOf(input: AssignmentCommandInput): string {
  return input.operation?.reason ?? 'Заявке назначен другой машинист — путевые листы переоформлены';
}

/**
 * Снимок «было → стало» по истории (Р9): что легло и что погасло, целиком.
 *
 * Погашенные строки записываются значениями, а не идентификаторами: через полгода прежнее значение
 * будет лежать в таблице рядом с десятком других, и искать его там придётся тем же запросом,
 * который ядро уже сделало.
 */
function historySnapshotOf(write: AssignmentWriteResult): Record<string, unknown> {
  const value = (row: AssignmentChangeRecord) => ({
    effectiveDate: row.effectiveDate,
    dimension: row.dimension,
    driverPersonId: row.driverPersonId,
    driverState: row.driverState,
    vehicleId: row.vehicleId,
    origin: row.origin,
    changeGroupId: row.changeGroupId,
  });
  return {
    inserted: write.inserted.map(value),
    superseded: write.superseded.map((s) => ({ kind: s.kind, row: value(s.row) })),
    cancelledGroups: write.cancelledGroups,
  };
}

/**
 * Событие команды — **данными**: пишет его каркас и в транзакции (§8, шаг 13).
 *
 * Событие здесь **одно**, и это не потеря. Переписанную бумагу объясняет `waybill.esm2_sync`, а
 * пишет его единственный владелец — исполнитель плана (`applyEsm2SyncPlanAndAudit`), той же
 * транзакцией и шагом раньше. Второе его написание здесь дало бы два события подряд об одной
 * работе, а вернуть его сюда «на всякий случай» значило бы завести второго владельца строгого
 * аудита — то самое состояние, из которого шесть внешних вызовов и вывели.
 */
function crewAuditOf(
  ctx: AssignmentAuditContext<CrewPlan, AssignmentWriteResult, CrewPaper>,
): AuditEntry[] {
  return [
    {
      action: 'vehicle_request.assignment_change',
      metadata: {
        kind: ctx.plan.kind,
        outcome: ctx.effects.operationOutcome,
        asOf: ctx.asOf,
        anchors: ctx.plan.anchors,
        operationId: ctx.operation?.operationId ?? null,
        ...(ctx.operation ? { reason: ctx.operation.reason } : {}),
        inserted: ctx.write.inserted.map((row) => ({
          effectiveDate: row.effectiveDate,
          driverPersonId: row.driverPersonId,
          driverState: row.driverState,
        })),
        cancelledGroups: ctx.write.cancelledGroups,
      },
    },
  ];
}

// ── Шаг 12: бумага ──

/**
 * Сверка ЭСМ-2 и постусловие Р11 — **исполнителя выбирает режим** (§10).
 *
 * В `legacy` бумагу по-прежнему ведёт недельная сверка, а отрезковый план остаётся предметом
 * предпросмотра и постусловия: гейт совместимости уже доказал под этой же блокировкой, что оба
 * плана совпадают, поэтому исполнение старым путём и есть исполнение нового плана.
 *
 * В `history` тот же шаг исполняет сам отрезковый план (`applyAssignmentPaper`) — тот, который
 * дверь посчитала шагом 6 и захешировала в отпечаток. Ничего не пересчитывается: пересчёт означал
 * бы исполнение не того, что человек подтвердил. И только здесь становится достижимой плановая
 * смена машиниста будущей датой (Ю49): недельная сверка знает **одного** машиниста заявки и
 * печатает его во всех листах, а отрезковый план несёт человека в каждом элементе `issue`.
 *
 * Постусловие остаётся общим и проверяет результат, а не намерение: в области сверки каждый
 * ожидаемый документ обязан существовать, и ни один действующий лист не должен остаться
 * расходящимся. Оно же и есть страховка на обеих сторонах переключения.
 *
 * Подписи смен здесь не снимаются, и это правило, а не упущение (Р11): фамилии машиниста в
 * `vehicle_request_shifts` нет вовсе, и переподписывать часы объекту из-за смены человека не за что.
 */
export async function syncCrewPaper(
  tx: AssignmentCommandTx,
  params: {
    requestId: string;
    actor: { id: string };
    reason: string;
    asOf: string;
    mode: AssignmentModeSnapshot;
    plan: CrewPlan;
    effects: AssignmentEffects;
    correctionId: string | null;
  },
): Promise<CrewPaper> {
  /*
   * Бумаги нет вовсе (`none`) либо команда её не трогает — область сверки пуста (Р24). Второе не
   * оптимизация: недельная сверка **не знает области**, и позвать её ради дремлющего изменения
   * значило бы разрешить ей попутно переписать бумагу, которой человек в предпросмотре не видел.
   */
  if (params.plan.esm2Mode === 'none' || params.plan.paperScope.length === 0) {
    return { esm2: { cancelled: [], issued: [] } };
  }

  const unlockWaybillIds = params.plan.requiredUnlocks.map((u) => u.waybillId);
  const esm2 = paperFollowsHistory(params.mode)
    ? await applyAssignmentPaper(tx, {
        requestId: params.requestId,
        actor: params.actor,
        reason: params.reason,
        mode: params.mode,
        effects: params.effects,
        operationId: params.correctionId,
        sheetPlan: params.plan.sheetPlan,
        paperScope: params.plan.paperScope,
        sheets: params.plan.sheets,
        displayNumbers: params.plan.sheetNumbers,
        unlockWaybillIds,
      })
    : await syncEsm2Waybills(tx, {
        requestId: params.requestId,
        actor: params.actor,
        reason: params.reason,
        driverPersonId: params.plan.legacyDriverPersonId,
        asOf: params.asOf,
        ...(params.effects.needsCorrection && params.correctionId
          ? { correction: { id: params.correctionId, unlockWaybillIds } }
          : {}),
      });

  await assertAssignmentPaperConverged(tx, {
    requestId: params.requestId,
    asOf: params.asOf,
    segmentsAfter: params.plan.segmentsAfter,
    term: params.plan.term,
    ownershipByVehicle: params.plan.ownershipByVehicle,
    paperScope: params.plan.paperScope,
    unlockWaybillIds,
    needsCorrection: params.effects.needsCorrection,
  });
  return { esm2 };
}

// ── Чтение справочников ──

/**
 * Принадлежность машин разреза (Р4). Карта обязана быть полной: машину, которой в ней нет, план
 * бумаги не угадывает — молча приписать её порталу значит выписать бланк на чужую единицу.
 *
 * Читаются и машины истории, и машина назначения: у заявки, история которой ещё не знает ни одной
 * vehicle-строки, разрез опирается на денормализацию.
 */
async function readOwnership(
  tx: AssignmentCommandTx,
  requestId: string,
  changes: readonly AssignmentChangeRecord[],
): Promise<Map<string, VehicleOwnership>> {
  const ids = new Set(
    changes.flatMap((row) => (row.dimension === 'vehicle' && row.vehicleId ? [row.vehicleId] : [])),
  );
  const [assignment] = await tx
    .select({ vehicleId: vehicleRequestAssignments.vehicleId })
    .from(vehicleRequestAssignments)
    .where(eq(vehicleRequestAssignments.requestId, requestId));
  if (assignment) ids.add(assignment.vehicleId);
  if (ids.size === 0) return new Map();
  const rows = await tx
    .select({ id: vehicles.id, ownership: vehicles.ownership })
    .from(vehicles)
    .where(inArray(vehicles.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.ownership]));
}

/** Напечатанные номера действующих листов: ими окно называет человеку бумагу, о которой говорит. */
async function readSheetNumbers(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(and(eq(waybills.sourceRequestId, requestId), ne(waybills.status, 'cancelled')));
  return new Map(
    rows.map((row) => [row.id, waybillDisplayNumber(row.prefix, row.number, row.numberWidth)]),
  );
}

interface PreviewNames {
  vehicles: Map<string, string>;
  persons: Map<string, string>;
}

/**
 * План бумаги глазами окна — **одной функцией на двери истории**.
 *
 * Заведена ради периодной коррекции: после переключения чтения она переоформляет задетые листы
 * сама, и показать их человеку обязана тем же способом, каким их называет исполнитель. Своя копия
 * этого показа разошлась бы с `issueKey`, а по `issueKey` строятся и рукопожатия, и граф замен.
 */
export async function assignmentPaperPreviewOf(
  tx: AssignmentCommandTx,
  plan: Esm2SheetPlan,
  sheets: readonly Esm2ExistingSheet[],
  numbers: ReadonlyMap<string, string>,
): Promise<{ cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] }> {
  return previewPlanOf(plan, sheets, numbers, await readNames(tx, plan));
}

/** Имена машин и людей выпускаемых листов: идентификатор нужен команде, имя — человеку. */
async function readNames(tx: AssignmentCommandTx, plan: Esm2SheetPlan): Promise<PreviewNames> {
  const vehicleIds = new Set(plan.issue.map((i) => i.vehicleId));
  const personIds = new Set(plan.issue.map((i) => i.driver.personId));
  const names: PreviewNames = { vehicles: new Map(), persons: new Map() };
  if (vehicleIds.size > 0) {
    const rows = await tx
      .select({
        id: vehicles.id,
        registrationNumber: vehicles.registrationNumber,
        modelName: vehicleModels.name,
      })
      .from(vehicles)
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
      .where(inArray(vehicles.id, [...vehicleIds]));
    for (const row of rows) {
      names.vehicles.set(
        row.id,
        [row.modelName, row.registrationNumber].filter(Boolean).join(' · ') || row.id,
      );
    }
  }
  if (personIds.size > 0) {
    const rows = await tx
      .select({ id: persons.id, fullName: persons.fullName })
      .from(persons)
      .where(inArray(persons.id, [...personIds]));
    for (const row of rows) names.persons.set(row.id, row.fullName);
  }
  return names;
}

/**
 * План глазами окна: что сгорит и что выпишется.
 *
 * Считается **той же сборкой**, какой его исполнит шаг 12 (`esm2ScopedPlanOfSheetPlan`), а не
 * своим проходом по `plan.issue`. Причина простая: `issueKey` — это индекс в плане, отсортированном
 * по `(from, to, vehicleId, driverPersonId)`, и по нему строятся и рукопожатия, и граф замен. Два
 * места, считающих этот порядок, разошлись бы молча — и человек подтверждал бы один лист, а
 * исполнитель выписывал другой.
 */
function previewPlanOf(
  plan: Esm2SheetPlan,
  sheets: readonly Esm2ExistingSheet[],
  numbers: ReadonlyMap<string, string>,
  names: PreviewNames,
): { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] } {
  const scoped = esm2ScopedPlanOfSheetPlan({
    plan,
    // Область предпросмотру не нужна: он показывает, что сгорит и что выпишется, а не сверяет
    // границы — их уже проверил сам план.
    scope: [],
    sheets,
    displayNumbers: numbers,
    // Связей замены у показа нет: они рождаются вместе со строкой журнала, которой при просмотре
    // ещё не существует.
    withCorrectionLinks: false,
  });
  return {
    cancel: scoped.cancel.map((item) => ({
      waybillId: item.waybillId,
      displayNumber: item.displayNumber,
      from: item.period.from,
      to: item.period.to,
    })),
    issue: scoped.issue.map((item) => ({
      issueKey: item.issueKey,
      from: item.period.from,
      to: item.period.to,
      vehicleId: item.vehicleId,
      vehicleName: names.vehicles.get(item.vehicleId) ?? item.vehicleId,
      driverPersonId: item.driverPersonId,
      driverName: names.persons.get(item.driverPersonId) ?? item.driverPersonId,
    })),
  };
}

// ── Предпросмотр (§7) ──

/**
 * Ответ предпросмотра — общий DTO модуля (§7).
 *
 * Пустые списки часов здесь не заглушка: смена машиниста подписей не снимает и часов не удаляет
 * (Р11), и заполнять эти поля было бы прямой неправдой о последствиях.
 */
export function crewPreviewDto(
  effects: AssignmentEffects,
  plan: CrewPlan,
  fingerprint: string,
  asOf: string,
): AssignmentPreviewDto {
  return {
    plan: plan.preview,
    requiredAnchors: plan.requiredAnchors,
    requiredVehicleResolution: null,
    blockedShiftDays: [],
    clearedShiftDays: [],
    clearedShiftsFingerprint: null,
    requiredUnlocks: plan.requiredUnlocks,
    unlockFingerprint: plan.unlockFingerprint,
    issues: [],
    operationRequirement: operationRequirementOf(effects),
    asOf,
    fingerprint,
  };
}

/** Нужна ли операция журнала и что для неё спросить (Р32); `null` — исход `none`. */
function operationRequirementOf(effects: AssignmentEffects): OperationRequirement | null {
  if (!effects.needsOperation) return null;
  return {
    kind: effects.operationOutcome === 'crew' ? 'crew' : 'assignment_tail',
    reasonRequired: true,
    operationIdRequired: true,
  };
}

// ── История заявки (`GET /:id/assignment-changes`) ──

/**
 * История назначения целиком — то, из чего портал строит «Состав по датам».
 *
 * Погашенные строки показываются наравне с актуальными: журнал заявки читают, чтобы понять, **что**
 * правили, а не только чем дело кончилось. Состояние готовности отдаётся вместе с изменениями, а не
 * отдельной ручкой: окно обязано отличить «истории нет» от «история есть, но невалидна», и второй
 * запрос за этим означал бы, что между ними состояние успевает измениться.
 */
export async function readAssignmentHistoryDto(
  reader: HistoryReader,
  requestId: string,
): Promise<RequestAssignmentHistoryDto | null> {
  const tx = reader as AssignmentCommandTx;
  const [request] = await tx
    .select({
      state: vehicleRequests.assignmentHistoryState,
      validatedOn: vehicleRequests.assignmentHistoryValidatedOn,
      dirty: vehicleRequests.assignmentHistoryDirty,
    })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId));
  if (!request) return null;

  const rows = await readAssignmentChanges(tx, requestId);
  const vehicleIds = new Set(rows.flatMap((row) => (row.vehicleId ? [row.vehicleId] : [])));
  const userIds = new Set(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])));
  const supersededBy = await readSupersededBy(tx, requestId);
  for (const id of supersededBy.values()) userIds.add(id);

  const vehicleNames = new Map<string, string>();
  if (vehicleIds.size > 0) {
    const found = await tx
      .select({
        id: vehicles.id,
        registrationNumber: vehicles.registrationNumber,
        modelName: vehicleModels.name,
      })
      .from(vehicles)
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
      .where(inArray(vehicles.id, [...vehicleIds]));
    for (const row of found) {
      vehicleNames.set(
        row.id,
        [row.modelName, row.registrationNumber].filter(Boolean).join(' · ') || row.id,
      );
    }
  }
  const userNames = new Map<string, string>();
  if (userIds.size > 0) {
    const found = await tx
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const row of found) userNames.set(row.id, row.fullName);
  }

  const changes: AssignmentChangeDto[] = rows.map((row) => ({
    id: row.id,
    effectiveDate: row.effectiveDate,
    dimension: row.dimension,
    vehicle: row.vehicleId
      ? { vehicleId: row.vehicleId, name: vehicleNames.get(row.vehicleId) ?? row.vehicleId }
      : null,
    driver: driverStateOf(row),
    origin: row.origin,
    changeGroupId: row.changeGroupId,
    correctionId: row.correctionId,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy ? (userNames.get(row.createdBy) ?? null) : null,
    supersededKind: row.supersededKind,
    supersededAt: supersededAtOf(row.supersededAt),
    supersededByName: supersededNameOf(supersededBy.get(row.id), userNames),
  }));

  return {
    state: request.state,
    validatedOn: request.validatedOn,
    dirty: request.dirty,
    changes,
  };
}

/**
 * Кто читает историю: и транзакция команды, и прикладной пул.
 *
 * Журнал заявки спрашивают снаружи всякой транзакции — это обычное чтение карточки, — а ответ
 * боевой ручки пересобирается из текущего состояния уже после коммита (Р9). Оба входа обязаны
 * получать один и тот же DTO, поэтому тип здесь шире транзакции, а не уже.
 */
export type HistoryReader = AssignmentCommandTx | typeof AppDb;

/**
 * Кто погасил строку.
 *
 * Отдельным чтением, а не расширением набора ядра записи: `superseded_by_user` нужен одному
 * журналу заявки, а ядро тем же набором колонок считает свёртку и отдаёт результат мутаций —
 * добавлять туда поле ради одного читателя значило бы возить его во всех остальных.
 */
async function readSupersededBy(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      id: vehicleRequestAssignmentChanges.id,
      userId: vehicleRequestAssignmentChanges.supersededByUser,
    })
    .from(vehicleRequestAssignmentChanges)
    .where(eq(vehicleRequestAssignmentChanges.requestId, requestId));
  return new Map(rows.flatMap((row) => (row.userId ? [[row.id, row.userId] as const] : [])));
}

function driverStateOf(row: AssignmentChangeRecord): DriverState | null {
  if (row.dimension !== 'driver' || !row.driverState) return null;
  if (row.driverState === 'set') {
    return row.driverPersonId ? { state: 'set', personId: row.driverPersonId } : null;
  }
  return { state: row.driverState };
}

function supersededAtOf(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function supersededNameOf(
  userId: string | undefined,
  names: ReadonlyMap<string, string>,
): string | null {
  if (!userId) return null;
  return names.get(userId) ?? null;
}

// ── Мелочи, общие с дверью ──

/** День расчёта по МСК — один на команду и на её предпросмотр (Р32). */
export function crewAsOf(): string {
  return moscowDateKeyOf(new Date());
}
