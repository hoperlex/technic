import type {
  AssignmentChangeOrigin,
  AssignmentDimension,
  AssignmentOperationOutcome,
  Esm2Period,
} from '@technic/contracts';
import { shiftDateKey } from '@technic/contracts';
import type {
  AssignmentChangeRow,
  AssignmentLogicalRange,
  AssignmentRange,
  AssignmentTerm,
} from './assignment-history';
import { assignmentEffectRange, plannedEffectRange } from './assignment-history';
import {
  type DateRangeSet,
  documentClosure,
  type Esm2ExistingSheet,
  normalizeRangeSet,
} from './esm2-plan';

/**
 * Проекции последствий команды и её исход
 * (`docs/assignment-periods-plan.md`, Р11, Р18, Р24, Р31, Р32).
 *
 * Одна команда порождает **разные по ширине** последствия, и мерить их одним диапазоном нельзя.
 * «Смени машиниста с 15 марта» переоформляет бумагу марта, но подписей объекта не касается вовсе:
 * фамилии машиниста в подписанных часах нет, и переподписывать их не за что. «Смени машину» —
 * наоборот: подписи снимает, а заполненные без подписи часы удаляет, потому что две машины в одном
 * дне при дневной дробности не представимы. Проекция, посчитанная на всё одна, либо снимет лишние
 * подписи, либо оставит непроверенной часть бумаги — и то и другое молча.
 *
 * Поэтому проекций шесть, и у каждой своя мера:
 *
 * | Проекция | Что ограничивает | Из чего считается |
 * | --- | --- | --- |
 * | `paperRange` | логический эффект: что команда изменила по дням | диапазоны **всех** изменённых строк обеих шкал |
 * | `paperScope` | план сверки, разблокировки, предупреждения, постусловие | документное замыкание `paperRange` (§7) |
 * | `approvalClearRange` | снятие подписей смен — единственная его граница | только vehicle-мутации |
 * | `workBlockRange` | подписанные дни (запирают) и заполненные (снимаются) — Р18 | только обычная смена машины |
 * | `correctionEffectiveDate` | глубина заднего числа, право, `authorizationScope` | самая ранняя дата **всех** мутаций |
 * | `payload` | снимок операции | все диапазоны по отдельности, а не общий |
 *
 * Считаются они одним проходом по мутациям и от одного входа: диапазон каждой мутации вычисляется
 * **до** команды — по истории, какой она вошла в транзакцию, — и дальше проекции только
 * по-разному отбирают уже посчитанное. Два независимых прохода разошлись бы на первой же
 * составной команде, а сойтись обязаны: их результаты попадают в один отпечаток предпросмотра.
 *
 * Модуль чистый: ни базы, ни часов. `asOf` приходит календарным ключом (Р32) — временная метка
 * сделала бы каждый apply отличным от своего предпросмотра.
 */

// ── Мутации команды ──

/**
 * Что мутация делает с историей. От этого зависят и её диапазон, и её вклад в исход (Р32):
 *
 * - `insert` — новая строка, ничего не переписывающая. Её диапазон считается по истории **без**
 *   неё: от своей даты до дня перед следующим изменением той же шкалы;
 * - `replace` — замена актуальной строки на той же дате (правка решения). Диапазон — диапазон
 *   заменяемой: дата и шкала те же, значит и следующий сосед тот же;
 * - `cancel` — гашение актуальной строки. Диапазон — её **прежний**, посчитанный пока она ещё
 *   актуальна: именно эти дни вернутся к состоянию, действовавшему до неё;
 * - `tail_decision` — решение хвоста **без строки** (первичный `history_wins`, Р31). Истории оно
 *   не пишет вовсе, но логическая дата у него есть, и она обязана лечь в глубину, отпечаток и
 *   `payload`: иначе `authorizationScope.effectiveDate` брать неоткуда.
 */
export type AssignmentMutationKind = 'insert' | 'replace' | 'cancel' | 'tail_decision';

/**
 * Логический эффект команды, перечисленный явно.
 *
 * Считать эффекты по строкам плана нельзя (Р32): у первичного `history_wins` их ноль — он меняет
 * только назначение и ставки, — и множество вышло бы пустым, а исход обязан быть `assignment_tail`.
 */
export type AssignmentMutation =
  | {
      kind: 'insert';
      dimension: AssignmentDimension;
      effectiveDate: string;
      /**
       * Происхождение будущей строки. Спрашивается здесь потому, что решение хвоста определяет
       * **провенанс, а не состав** (Р31, Ю2): vehicle-граница на `dateTo + 1` по составу
       * неотличима от обычной смены машины, а последствия у них разные.
       */
      origin: AssignmentChangeOrigin;
    }
  | { kind: 'replace'; changeId: string }
  | { kind: 'cancel'; changeId: string }
  | { kind: 'tail_decision'; effectiveDate: string };

/**
 * Логический эффект команды, у которого **нет строки истории вовсе** (Е3).
 *
 * Заведён ради правки срока: она двигает календарь заявки сама — продление в прошедшую неделю ничего
 * в истории не пишет, — а исход и глубина у такого движения есть, и по ним спрашиваются причина,
 * ключ операции и `waybills.correct`. Считать их второй раз в двери значило бы завести второй ответ
 * на вопрос «какой у команды исход», против которого прямо написан Р32: исход один и вычисляется
 * один раз.
 *
 * От безстрочного `tail_decision` отличается тем, что исход **приносится**, а не выводится: у
 * решения хвоста он всегда `assignment_tail`, а у правки срока зависит от того, куда переехал
 * календарь (Е3: `operationOutcome = max(исход правки срока, исход гашения каждой группы)`).
 */
export interface AssignmentExternalEffect {
  /** Логическая дата эффекта: она входит в глубину, отпечаток и `payload`. */
  effectiveDate: string;
  /** Исход, который эффект задаёт снизу; выше его поднимут мутации истории, ниже — нет. */
  outcome: AssignmentOperationOutcome;
}

/**
 * Мутация с посчитанными диапазонами — общий вход всех шести проекций.
 *
 * `dimension` и `origin` пусты только у безстрочного решения хвоста: строки нет, шкалы у него нет
 * тоже, и приписывать ему `vehicle` значило бы отдать ему снятие подписей за дни, которых он не
 * трогал.
 */
export interface ResolvedAssignmentMutation {
  kind: AssignmentMutationKind;
  /** Строка, которую мутация переписывает; у новой строки и у безстрочного решения — `null`. */
  changeId: string | null;
  dimension: AssignmentDimension | null;
  origin: AssignmentChangeOrigin | null;
  /** Логическая дата мутации: дата новой строки, переписываемой строки или решения хвоста. */
  effectiveDate: string;
  /** До какого дня эффект действует по своей шкале; `to: null` — следующего изменения нет. */
  logical: AssignmentLogicalRange;
  /** Пересечение со сроком. `null` — эффект дремлющий: бумаги, подписей и запретов не трогает. */
  inTerm: AssignmentRange | null;
}

// ── Общий вход ──

/** Всё, от чего зависят проекции: история до команды, срок, день расчёта и сами мутации. */
export interface AssignmentEffectsInput {
  /** Строки истории заявки **до** команды; погашенные отсеет свёртка. */
  changes: readonly AssignmentChangeRow[];
  term: AssignmentTerm;
  /** Календарный ключ дня расчёта `YYYY-MM-DD` — один на весь расчёт (Р32). */
  asOf: string;
  /** Логические эффекты команды. Пустой список — команда без последствий (Р12 её не допускает). */
  mutations: readonly AssignmentMutation[];
  /** Действующие листы заявки — их границы втягивают документы в `paperScope` целиком (§7). */
  sheets?: readonly Pick<Esm2ExistingSheet, 'periodFrom' | 'periodTo'>[];
  /** Отрезки `wanted` **до и после** команды: замена считается по обоим разрезам (§7). */
  wanted?: readonly Esm2Period[];
  /**
   * Эффект команды без строки истории (Е3) — сегодня его приносит одна дверь, правка срока.
   *
   * Влияет ровно на две проекции: поднимает **нижнюю границу** исхода и участвует в минимуме
   * `correctionEffectiveDate`. Ни бумажного диапазона, ни снятия подписей у него нет по
   * построению — строки, которую он переписал бы, не существует.
   */
  external?: AssignmentExternalEffect | null;
}

/** Посчитанное: день расчёта, срок, эффекты со своими диапазонами и пять проекций из них. */
export interface AssignmentEffectsCore {
  /** День расчёта — он входит в отпечаток, и снимок без него нечем сверить (Р32). */
  asOf: string;
  term: AssignmentTerm;
  /** По записи на каждый логический эффект: чем он был и какие дни задел. */
  mutations: ResolvedAssignmentMutation[];
  paperRange: DateRangeSet;
  paperScope: DateRangeSet;
  approvalClearRange: DateRangeSet;
  workBlockRange: DateRangeSet;
  correctionEffectiveDate: string | null;
  operationOutcome: AssignmentOperationOutcome;
  /** Эффект без строки истории, если он у команды был; `null` — команда описана одними мутациями. */
  external: AssignmentExternalEffect | null;
}

/**
 * `payload` — снимок операции: **все диапазоны по отдельности, а не общий**.
 *
 * Составная команда объединением диапазонов не описывается: январско-февральская коррекция машины
 * и мартовский якорь машиниста в сумме дают «январь–декабрь», и по такому снимку уже не сказать,
 * за какие дни снимались подписи, а за какие только переоформлялась бумага. Поэтому снимок
 * сохраняет и каждую проекцию, и диапазон каждой мутации.
 */
export type AssignmentEffectsPayload = AssignmentEffectsCore;

/** Шесть проекций, исход и производные от него признаки — всё, что команда знает о себе. */
export interface AssignmentEffects extends AssignmentEffectsCore {
  /** Нужна ли операция журнала: `outcome !== 'none'`. */
  needsOperation: boolean;
  /** Нужны ли коррекционные права и глубина: `outcome === 'crew'`. */
  needsCorrection: boolean;
  payload: AssignmentEffectsPayload;
}

/**
 * Все последствия команды разом — одним проходом и от одного входа.
 *
 * Порядок здесь не декоративный: сначала диапазоны мутаций (они общий вход), потом дневной
 * `paperRange`, и только из него — документный `paperScope`. Обратный порядок означал бы, что
 * область бумаги посчитана не из логического эффекта, а из чего-то ещё.
 */
export function assignmentCommandEffects(input: AssignmentEffectsInput): AssignmentEffects {
  const mutations = resolveAssignmentMutations(input);
  const paperRange = paperRangeOf(mutations);
  const paperScope = paperScopeOf(paperRange, input.sheets ?? [], input.wanted ?? []);
  const approvalClearRange = approvalClearRangeOf(mutations);
  const workBlockRange = workBlockRangeOf(mutations, input.asOf);
  const external = input.external ?? null;
  // Глубина — минимум по **всем** логическим датам команды, включая ту, у которой строки нет:
  // продление в позапрошлую неделю обязано спрашивать право по своей дате, а не по «сегодня».
  const correctionEffectiveDate = earliestDate(
    correctionEffectiveDateOf(mutations),
    external?.effectiveDate ?? null,
  );
  // Исход — максимум по тем же эффектам (Р32, Е3): гашение группы поднимает его до `crew`, но и
  // сама правка срока, переехавшая в прошлое, поднимает его не меньше.
  const operationOutcome = maxOutcome(
    assignmentOperationOutcome(mutations, input.asOf),
    external?.outcome ?? 'none',
  );

  const core: AssignmentEffectsCore = {
    asOf: input.asOf,
    term: { dateFrom: input.term.dateFrom, dateTo: input.term.dateTo },
    mutations,
    paperRange,
    paperScope,
    approvalClearRange,
    workBlockRange,
    correctionEffectiveDate,
    operationOutcome,
    external,
  };

  return {
    ...core,
    needsOperation: operationOutcome !== 'none',
    needsCorrection: operationOutcome === 'crew',
    payload: assignmentEffectsPayloadOf(core),
  };
}

// ── Диапазоны мутаций ──

/**
 * Диапазон каждой мутации — по истории, какой она вошла в команду.
 *
 * Новая строка считается на истории **плюс она сама**, а переписываемая — на истории **как есть**,
 * пока строка ещё актуальна. Иначе прежний `inTermRange` группы, по которому Р32 выбирает вид
 * операции, исчез бы вместе с гашением, и отмена исторического решения выглядела бы безобидной.
 *
 * Считается диапазон каждой мутации **независимо** от остальных: две строки одной команды,
 * посчитанные друг по другу, укоротили бы одна другую и выдали бы за диапазон команды меньше, чем
 * она задевает.
 */
export function resolveAssignmentMutations(
  input: AssignmentEffectsInput,
): ResolvedAssignmentMutation[] {
  return input.mutations.map((mutation) => resolveMutation(mutation, input));
}

/**
 * `paperRange` — логический эффект команды по дням: объединение диапазонов всех изменённых строк
 * **обеих** шкал, подрезанное сроком.
 *
 * Подрезка сроком — это Р24: у дремлющего изменения бумажного диапазона нет вовсе, и без неё
 * `paperRange` потащил бы в разблокировки и постусловие дни, которых у заявки ещё не существует.
 */
export function paperRangeOf(mutations: readonly ResolvedAssignmentMutation[]): DateRangeSet {
  return normalizeRangeSet(
    mutations.flatMap((mutation) => (mutation.inTerm ? [mutation.inTerm] : [])),
  );
}

/**
 * `paperScope` — документы, которых касается `paperRange`, целиком.
 *
 * Единица бумаги — документ, а не день: лист «A + Иван» выписан на пн–вс, с среды ставят Петра, и
 * операция обязана переоформить и пн–вт прежним составом. Постусловие по дневному диапазону
 * проверило бы только ср–вс и пропустило бы потерянный отрезок.
 *
 * Замыкание чужое (`documentClosure`, §7) и считается до неподвижной точки: втянутый лист тянет за
 * собой отрезки замены, те дотягиваются до соседнего документа, и один проход дал бы область
 * меньше правильной.
 */
export function paperScopeOf(
  paperRange: readonly AssignmentRange[],
  sheets: readonly Pick<Esm2ExistingSheet, 'periodFrom' | 'periodTo'>[],
  wanted: readonly Esm2Period[],
): DateRangeSet {
  return documentClosure(paperRange, sheets, wanted);
}

/**
 * `approvalClearRange` — единственная граница снятия подписей смен.
 *
 * Считается **только по vehicle-мутациям**: `paperRange` шире на смены машиниста и снял бы подписи
 * там, где бумага сменила фамилию, а работа осталась той же. Фамилии машиниста в
 * `vehicle_request_shifts` нет вовсе, и переподписывать часы объекту было бы не за что.
 *
 * Безстрочное решение хвоста (`history_wins`) сюда не входит: строки истории у него нет, ни одного
 * дня оно не переписывает — меняются назначение и ставки, а не состав дня.
 *
 * Обычная смена машины свой диапазон сюда отдаёт тоже, хотя снимать в нём, как правило, нечего:
 * подписанный день внутри него запирает команду ещё на шаге проверок (Р18), и до снятия дело не
 * доходит. Отдаёт намеренно — из двух ошибок «снять лишнюю подпись за день, у которого сменилась
 * машина» и «оставить подпись за день, у которого сменилась машина» вторая хуже: она оставляет
 * подписанными часы, отнесённые уже к другой технике.
 */
export function approvalClearRangeOf(
  mutations: readonly ResolvedAssignmentMutation[],
): DateRangeSet {
  return normalizeRangeSet(
    mutations.flatMap((mutation) =>
      mutation.dimension === 'vehicle' && mutation.inTerm ? [mutation.inTerm] : [],
    ),
  );
}

/**
 * `workBlockRange` — диапазон, в котором сервер под блокировкой считает два множества смен (Р18):
 * `blockedApprovedDays` (подписанные — запирают команду) и `clearableFilledDays` (заполненные без
 * подписи — снимаются с подтверждением).
 *
 * Только **обычная** смена машины, то есть vehicle-мутация датой `asOf` или позже. Прошлое этим
 * запретом не мерится: там подписанные дни не запирают команду, а разблокируются и снимаются
 * коррекцией, и приравнять одно к другому значило бы запретить всякий ремонт истории. Смены
 * машиниста запрет не касается вовсе — подписей они не снимают.
 *
 * Решение хвоста исключено по происхождению: его vehicle-граница стоит за концом срока и ни одного
 * рабочего дня не описывает (Р31), а после продления её диапазон перестанет быть пустым — и тогда
 * запирать дни она будет уже как обычное изменение, посчитанное по новому сроку.
 */
export function workBlockRangeOf(
  mutations: readonly ResolvedAssignmentMutation[],
  asOf: string,
): DateRangeSet {
  return normalizeRangeSet(
    mutations.flatMap((mutation) =>
      isOrdinaryVehicleChange(mutation, asOf) && mutation.inTerm ? [mutation.inTerm] : [],
    ),
  );
}

/**
 * `correctionEffectiveDate` — самая ранняя дата **всех** мутаций команды.
 *
 * Именно дата мутации, а не начало бумажного диапазона и не дата основного изменения: у смешанной
 * команды глубина считается по минимуму всех логических дат, включая `tailEffectiveDate`
 * безстрочного решения хвоста (Р32). Возьми она дату основного изменения — январский якорь
 * мартовской команды прошёл бы без права `correctBeyondLimit`.
 *
 * `null` — мутаций нет вовсе. Такой команды не бывает (Р12), но проекция обязана быть полной:
 * подставить сюда «сегодня» значило бы соврать журналу.
 */
export function correctionEffectiveDateOf(
  mutations: readonly ResolvedAssignmentMutation[],
): string | null {
  let earliest: string | null = null;
  for (const mutation of mutations) {
    if (earliest === null || mutation.effectiveDate < earliest) earliest = mutation.effectiveDate;
  }
  return earliest;
}

/**
 * `payload` — снимок операции, из которого через полгода читают, что именно она сделала.
 *
 * Снимок — это **копия**, а не ссылка на живой расчёт: диапазоны и разобранные мутации
 * копируются, чтобы последующая нормализация или дополнение результата не переписали задним
 * числом то, что уже объявлено записанным.
 */
export function assignmentEffectsPayloadOf(core: AssignmentEffectsCore): AssignmentEffectsPayload {
  return {
    asOf: core.asOf,
    term: { dateFrom: core.term.dateFrom, dateTo: core.term.dateTo },
    mutations: core.mutations.map((mutation) => ({
      ...mutation,
      logical: { ...mutation.logical },
      inTerm: mutation.inTerm ? { ...mutation.inTerm } : null,
    })),
    paperRange: copyRanges(core.paperRange),
    paperScope: copyRanges(core.paperScope),
    approvalClearRange: copyRanges(core.approvalClearRange),
    workBlockRange: copyRanges(core.workBlockRange),
    correctionEffectiveDate: core.correctionEffectiveDate,
    operationOutcome: core.operationOutcome,
    external: core.external ? { ...core.external } : null,
  };
}

// ── Исход ──

/**
 * `operationOutcome` — **максимум** по логическим эффектам команды, а не первое совпадение (Р32).
 *
 * Строки матрицы пересекаются: историческая замена актуальной строки подходит сразу под две
 * (задевает исторический диапазон **и** правит принятое решение), а составная команда — под три.
 * Реализация, взявшая первое подходящее условие, пропустила бы `waybills.correct` у команды, где
 * исторический якорь едет вместе с решением хвоста.
 */
export function assignmentOperationOutcome(
  mutations: readonly ResolvedAssignmentMutation[],
  asOf: string,
): AssignmentOperationOutcome {
  let outcome: AssignmentOperationOutcome = 'none';
  for (const mutation of mutations) {
    outcome = maxOutcome(outcome, mutationOutcome(mutation, asOf));
  }
  return outcome;
}

/**
 * Исход одного логического эффекта.
 *
 * Порядок проверок — от старшего к младшему, и он же порядок матрицы Р32:
 *
 * - задел непустой **исторический** диапазон (дни до `asOf`) — `crew`: причина, `waybills.correct`,
 *   глубже тридцати дней — `correctBeyondLimit`;
 * - решение хвоста любого вида, включая безстрочное, — `assignment_tail`: оно правит принятое
 *   решение и обязано быть объяснено, но прошлого не трогает;
 * - замена или гашение уже принятого решения — `assignment_tail` по той же причине: кто-то уже
 *   назначил человека на эту дату, и подмена без объяснения оставила бы вопрос «почему» без ответа;
 * - новая строка датой раньше `asOf` — `assignment_tail`: через полгода вопрос «почему запись
 *   появилась задним числом» должен иметь ответ, даже если рабочих дней она не задела;
 * - новая строка датой `asOf` или позже — `none`: причины у плановой смены нет и быть не должно.
 */
export function mutationOutcome(
  mutation: ResolvedAssignmentMutation,
  asOf: string,
): AssignmentOperationOutcome {
  if (touchesHistory(mutation, asOf)) return 'crew';
  if (mutation.kind === 'tail_decision' || mutation.origin === 'tail_resolution') {
    return 'assignment_tail';
  }
  if (mutation.kind === 'replace' || mutation.kind === 'cancel') return 'assignment_tail';
  return mutation.effectiveDate < asOf ? 'assignment_tail' : 'none';
}

/**
 * Задевает ли эффект прошлое — дни строго до `asOf`.
 *
 * Меряется по бумажному диапазону, а не по дате: изменение прошлой датой с пустым `inTermRange`
 * прошлого не трогает (Р24), а сегодняшняя смена машиниста переоформляет сегодняшний лист — и
 * прошлого всё равно не трогает, потому что исторических дней в её диапазоне нет. Требовать у неё
 * коррекционных прав значило бы спрашивать объяснение у обычного рабочего дня.
 */
export function touchesHistory(mutation: ResolvedAssignmentMutation, asOf: string): boolean {
  return mutation.inTerm !== null && mutation.inTerm.from < asOf;
}

/**
 * Логическая дата решения хвоста (Р31): день после конца срока.
 *
 * Она есть у обеих веток, даже у безстрочного `history_wins`: `authorizationScope.effectiveDate`
 * обязателен, а брать его больше неоткуда. Пустой `dateTo` читается как однодневный срок — тем же
 * правилом, каким его читают срез и свёртка.
 */
export function tailEffectiveDate(term: AssignmentTerm): string {
  return shiftDateKey(term.dateTo || term.dateFrom, 1);
}

// ── Внутреннее ──

/** Копия набора диапазонов: снимок не должен зависеть от того, что сделают с исходным массивом. */
function copyRanges(ranges: readonly AssignmentRange[]): DateRangeSet {
  return ranges.map((range) => ({ from: range.from, to: range.to }));
}

/** Ранняя из двух дат; `null` считается «даты нет», а не «раньше всех». */
function earliestDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

const OUTCOME_RANK: Record<AssignmentOperationOutcome, number> = {
  none: 0,
  assignment_tail: 1,
  crew: 2,
};

/** Старшинство `crew > assignment_tail > none` — нормативное (Р32), а не порядок перечисления. */
function maxOutcome(
  a: AssignmentOperationOutcome,
  b: AssignmentOperationOutcome,
): AssignmentOperationOutcome {
  return OUTCOME_RANK[b] > OUTCOME_RANK[a] ? b : a;
}

/**
 * Обычная смена машины — та, что действует с сегодняшнего дня или позже и не является решением
 * хвоста. Гашение сюда не попадает: `cancel` шкале `vehicle` разрешён только для группы хвоста.
 */
function isOrdinaryVehicleChange(mutation: ResolvedAssignmentMutation, asOf: string): boolean {
  if (mutation.dimension !== 'vehicle') return false;
  if (mutation.kind !== 'insert' && mutation.kind !== 'replace') return false;
  if (mutation.origin === 'tail_resolution') return false;
  return mutation.effectiveDate >= asOf;
}

/** Диапазон одной мутации: у новой строки — гипотетический, у прочих — диапазон её строки. */
function resolveMutation(
  mutation: AssignmentMutation,
  input: AssignmentEffectsInput,
): ResolvedAssignmentMutation {
  if (mutation.kind === 'tail_decision') {
    /*
     * Логическая дата у решения есть — она и уходит в глубину, отпечаток и `payload`, — а бумажного
     * диапазона нет вовсе, и не потому, что дата за сроком: строки истории оно не пишет (Р31,
     * Р17), значит не переписывает ни одного дня. Меняются назначение и ставки, а `paperRange`
     * считается по изменённым строкам (Р11).
     */
    return {
      kind: 'tail_decision',
      changeId: null,
      dimension: null,
      origin: null,
      effectiveDate: mutation.effectiveDate,
      logical: { from: mutation.effectiveDate, to: null },
      inTerm: null,
    };
  }

  if (mutation.kind === 'insert') {
    // Диапазон ещё не записанной строки считает свёртка (`plannedEffectRange`): тем же расчётом,
    // что и у существующих строк, — второй список правил разошёлся бы с ним на первой же тонкости.
    const effect = plannedEffectRange(
      input.changes,
      mutation.dimension,
      mutation.effectiveDate,
      input.term,
    );
    return {
      kind: 'insert',
      changeId: null,
      dimension: mutation.dimension,
      origin: mutation.origin,
      effectiveDate: mutation.effectiveDate,
      logical: effect.logical,
      inTerm: effect.inTerm,
    };
  }

  const target = input.changes.find((row) => row.id === mutation.changeId && !row.supersededAt);
  if (!target) {
    // Цель разрешена вызывающим до расчёта (Р10) и держится блокировкой заявки: не нашлась —
    // значит ей передали чужой или уже погашенный `changeId`, и молча считать команду без этой
    // мутации нельзя — последствия вышли бы уже, чем на самом деле.
    throw new Error(
      `Цель мутации ${mutation.changeId} не найдена среди актуальных строк истории заявки`,
    );
  }
  const effect = assignmentEffectRange(input.changes, target.id, input.term);
  if (!effect) {
    throw new Error(`Диапазон строки ${target.id} не посчитан: внутренняя ошибка расчёта`);
  }
  return {
    kind: mutation.kind,
    changeId: target.id,
    dimension: target.dimension,
    origin: target.origin,
    effectiveDate: target.effectiveDate,
    logical: effect.logical,
    inTerm: effect.inTerm,
  };
}
