import { eq, inArray, ne, and } from 'drizzle-orm';
import {
  shiftDateKey,
  waybillDisplayNumber,
  type AssignmentIssueWarningsDto,
  type AssignmentPlanCancelDto,
  type AssignmentPlanIssueDto,
  type AssignmentUnlockDto,
  type CancelledAssignmentGroupDto,
  type DriverState,
  type Esm2Mode,
  type Esm2Period,
  type LinearDaySubject,
  type VehicleOwnership,
} from '@technic/contracts';
import { err } from '../lib/errors';
import {
  persons,
  vehicleModels,
  vehicleRequestAssignments,
  vehicles,
  waybills,
  waybillSeries,
} from '../db/schema';
import type { AssignmentCommandTx } from './assignment-command';
import {
  assignmentCommandEffects,
  type AssignmentEffects,
  type AssignmentExternalEffect,
  type AssignmentMutation,
} from './assignment-effects';
import { assignmentChangeTargetOf, planAssignmentHistory } from './assignment-ensure';
import {
  assignmentSegments,
  type AssignmentSegment,
  type AssignmentTerm,
} from './assignment-history';
import type { AssignmentChangeRecord, AssignmentWriteMutation } from './assignment-write';
// Отпечаток — тот же, что у всех дверей истории: одна функция хеширования на волну, иначе два
// отпечатка одного и того же содержания разошлись бы на первой же смене алгоритма.
import { fingerprintOf } from './assignment-crew';
import {
  documentClosure,
  esm2RequestedSheetPlan,
  esm2RequestedSheets,
  esm2SheetPlan,
  normalizeRangeSet,
  type DateRangeSet,
  type Esm2ExistingSheet,
  type Esm2SheetPlan,
} from './esm2-plan';
import { buildEsm2SyncPlan, type Esm2IssuePreparations } from './waybill-esm2';
// Предупреждения и снимок бланка по выпускаемым листам — общим расчётом шага 6 (§7): считать их
// здесь своей копией значило бы завести пятое место, где решают, что такое пробел в документах.
import { assignmentPlanIssues } from './assignment-paper';
import { planLinearRouteDays, type LinearDaysPlan } from './vehicle-request-days';

/**
 * Изменение срока работ — **общий расчёт на четыре применяющие ветви**
 * (`docs/vehicle-request-actual-end-date-plan.md`, Р18, Р11).
 *
 * ЗАЧЕМ ОН ОТДЕЛЬНЫЙ. Сокращение срока — не арифметика над двумя датами. Оно выносит за срок
 * решения истории и обязано их погасить (Д2 плана `assignment-periods-plan.md`), меняет набор дней
 * заказа и потому переписывает бумагу, требует разблокировать отработанные листы и снимает дни
 * линейного заказа с рейсов. Сегодня всё это посчитано ровно один раз — внутри двери правки срока,
 * — а завтра тем же расчётом пользуются ещё три ветви: дверь закрытия фактической датой и обе
 * применяющие ветви досрочного завершения (Р19). Четыре копии одного предмета разошлись бы молча и
 * ровно там, где расхождение дороже всего: одна дверь погасила бы группу, вторая оставила бы её
 * дремать до следующего продления — вопреки Р14.
 *
 * ЧТО ОН СЧИТАЕТ. Всё, что зависит **только** от пары «прежний срок → новый срок» и состояния
 * заявки: гасимые группы истории и их отпечаток, логические эффекты команды, область бумаги и план
 * листов на ней, перечень разблокировок с отпечатком, а также — **данными** — план линейных дней.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ И ПОЧЕМУ. Он **не принимает решений двери**:
 *
 * - **не решает, законна ли команда**: «сокращать работающий заказ правкой нельзя», «срок обязан
 *   измениться», заблаговременность, отказ архивной заявке — предметные правила конкретной двери, и
 *   у закрытия фактической датой они другие (Р28). Расчёт зовут уже после них;
 * - **не решает, что делать с `frozen`** (Р11): правка срока оставляет замороженный день
 *   предупреждением и отказывает только при коррекции, закрытие отказывает всегда и до первой
 *   записи, досрочное завершение предупреждает. Реши это расчёт — извлечение изменило бы поведение
 *   двери срока, которое ему запрещено менять;
 * - **не считает исход самой команды над сроком**: «правка задним числом — операция `crew`»
 *   выражено внешним эффектом (`external`), и приносит его дверь. У закрытия он свой;
 * - **не обещает ничего про денормализацию** (`AssignmentDenormalizationIntent`): это обещание
 *   двери ядру записи о том, что станет с `vehicle_request_assignments`, а не свойство срока;
 * - **не считает свой отпечаток последствий**: измерения у дверей разные (Р17), и общий отпечаток
 *   был бы либо неполным у закрытия, либо изменившимся у правки срока. Общее здесь одно —
 *   {@link cancelGroupsShape}, содержание гасимых групп: его хеширует и дверь в своём отпечатке, и
 *   сам расчёт в `cancelGroupsFingerprint`.
 *
 * ИМЯ. «Сокращение» в имени — по самому трудному случаю, а не по единственному: продление проходит
 * тем же расчётом и просто не находит ни одной гасимой группы. Второй функции «на продление» нет
 * намеренно: область бумаги считается симметрической разностью сроков, и обе стороны нужны обеим.
 */

// ── Что расчёт посчитал ──

/** Группа истории, которую выносит за срок сокращение (Д2): состав целиком и адрес для ядра. */
export interface TermCancelGroup {
  changeGroupId: string;
  /** Актуальные строки группы — все, обеих шкал: гашение групповое, и показывать его надо целиком. */
  rows: AssignmentChangeRecord[];
  /** Строка, которой группа адресуется ядру записи; погашена будет вся группа (В2). */
  target: AssignmentWriteMutation & { kind: 'cancel' };
}

/**
 * Что дверь получает от общего расчёта — и дальше только читает.
 *
 * Один объект на предпросмотр и на исполнение: предпросмотр обязан обещать ровно то, что
 * произойдёт, а вторая копия расчёта разошлась бы с первой на первом же новом правиле.
 */
export interface ShortenTermPlan {
  /**
   * Восстановима ли история заявки. `false` — назначения у заказа нет вовсе (`no_assignment`), и
   * это **не отказ**: срок правят и у заявки без техники, у неё же нет и бумаги. Гасить и
   * материализовать в этом случае нечего.
   */
  historyPresent: boolean;
  /**
   * Дни, которые команда открывает или закрывает, — симметрическая разность сроков (§8, таблица
   * областей). Это и есть бумажный эффект самого срока: строк истории у продления нет вовсе, а
   * недели появляются и исчезают.
   */
  termDiff: DateRangeSet;
  /** Логические последствия команды: исход, вид операции, диапазоны — вход авторизации и отпечатка. */
  effects: AssignmentEffects;
  cancelGroups: TermCancelGroup[];
  /** Те же группы глазами окна: даты, шкалы, состав и имена машин (Д2). */
  cancelGroupsPreview: CancelledAssignmentGroupDto[];
  /** Отпечаток перечня погашаемых групп; `null` — гасить нечего, и подтверждать нечего. */
  cancelGroupsFingerprint: string | null;
  /** Область бумаги (Р11, §7): документное замыкание дневного эффекта команды. */
  paperScope: DateRangeSet;
  esm2Mode: Esm2Mode;
  /**
   * План листов — предмет предпросмотра, отпечатка и шага 12 в режиме `history`.
   *
   * Считается **по режиму** заказа: у `auto` ожидания даёт разрез состава, у `on_demand` — уже
   * выписанное, подрезанное сроком (ADR 0100 §5). У `none` план пуст: бумаги у заказа нет вовсе.
   */
  sheetPlan: Esm2SheetPlan;
  /** Аннулируемые и выписываемые листы — так, как их показывает окно. */
  preview: { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] };
  /**
   * Предупреждения по каждому выпускаемому листу и их отпечатки — предмет рукопожатий (Б4).
   *
   * Считаются здесь, вместе с планом, а не при выписке: иначе окно показывало бы пустой список, а
   * подтверждать человеку было бы нечего — ровно тот пробел, из-за которого `acknowledgements` и
   * не работали.
   */
  issues: AssignmentIssueWarningsDto[];
  /** Те же листы для шага 12: снимок бланка и предупреждения, которые исполнение не пересчитывает. */
  issuePreparations: Esm2IssuePreparations;
  /**
   * Разблокировки идентификаторами и в отсортированном виде — так они входят в отпечаток двери.
   * Пусто при исходе не-`crew`: там разблокировок не спрашивают вовсе (Д4).
   */
  requiredUnlockIds: string[];
  /** Те же листы для окна — номером и неделей. */
  requiredUnlocks: AssignmentUnlockDto[];
  /** Отпечаток множества разблокировок; `null` — исход не `crew`, подтверждать нечего (Д4). */
  unlockFingerprint: string | null;
  /**
   * Действующие листы заявки и их напечатанные номера — прочитанные один раз.
   *
   * Нужны шагу 12: исполнитель отрезкового плана называет сгоревшую бумагу номером, а прочитать
   * его после аннулирования уже поздно.
   */
  sheets: Esm2ExistingSheet[];
  sheetNumbers: Map<string, string>;
  /**
   * Дни линейного заказа, которые новый срок выносит за границу, — **данными** (Р11): что рейс
   * отдаст (`detachable`) и чего не отдаст, потому что по нему выписан действующий лист (`frozen`).
   * Политику по `frozen` решает дверь, а не расчёт. Пусто, когда дверь дней не спрашивала.
   */
  linearDays: LinearDaysPlan;
}

/** Пустой план дней: его получает дверь, которая линейных дней у расчёта не спрашивала. */
const EMPTY_LINEAR_DAYS: LinearDaysPlan = { detachable: [], frozen: [] };

/** Пустой план листов: у заявки без автоматической бумаги по нему считается всё остальное. */
const EMPTY_SHEET_PLAN: Esm2SheetPlan = {
  wanted: [],
  cancel: [],
  issue: [],
  trim: [],
  kept: [],
  locked: [],
  outOfScope: [],
};

/**
 * Посчитать изменение срока целиком: гасимые группы, последствия, бумагу, разблокировки и дни.
 *
 * Транзакция приходит читающей (`readOnlyTx` каркаса): до сверки отпечатка и авторизации команда
 * ничего не записывает (Р20). Единственный отказ здесь — исчезнувшая заявка: она читается тем же
 * запросом, который приносит режим бумаги и действующие листы.
 *
 * Порядок чтений значим ровно в одном месте: история считается **до** бумаги, потому что режим и
 * листы читает работа, которая сама решает, что такое действующий лист заявки, и своя копия этого
 * правила разошлась бы со сверкой при первой же её правке.
 */
export async function shortenTermPlan(
  tx: AssignmentCommandTx,
  params: {
    requestId: string;
    /** День расчёта — один на команду и её предпросмотр (Р32). */
    asOf: string;
    /** Срок, прочитанный под блокировкой: по нему считаются диапазоны гасимых групп. */
    termBefore: AssignmentTerm;
    /** Срок, каким его сделает команда. */
    termAfter: AssignmentTerm;
    /**
     * Исход самой команды над сроком — эффектом, а не строкой истории (Е3): календарь двигает
     * колонка заявки, и вывести исход из мутаций нельзя. Что именно сюда положить, решает дверь:
     * у правки срока это «сегодня и вперёд — обычная работа, раньше — операция», у закрытия своё.
     */
    external: AssignmentExternalEffect | null;
    /**
     * Спросить ли план линейных дней, и по какому субъекту (Р11, Р27).
     *
     * Поле обязательное и обнуляемое намеренно: собрать субъект допустимости за дверь расчёт не
     * вправе — закрытие подставляет туда **прежний** статус «В работе», хотя после команды заявка
     * станет «Выполненной», и подстановка настоящего статуса обрекла бы все дни заказа разом.
     * Значит выбор всегда за вызывающим, и `null` обязан быть написан рукой, а не получиться
     * умолчанием у двери, которая про дни забыла.
     *
     * `null` у правки срока — не пробел: её политику по `frozen` исполняет шаг 12, перечитывая
     * заморозку из-под блокировки рейса (`syncLinearRouteDays`), и предварительный, более старый
     * ответ про те же дни лежал бы в плане приманкой для следующего рефакторинга.
     */
    linearDays: { eligibilitySubject: LinearDaySubject; retainCompletedDays: boolean } | null;
  },
): Promise<ShortenTermPlan> {
  const { requestId, asOf, termBefore, termAfter, external } = params;

  /*
   * История **считается**, а не пишется (шаг 5 канона в расчётной половине, Р20). Отказа по
   * невосстановимой истории здесь нет по существу: срок правят и у заявки, которой техника ещё не
   * назначена, — у неё нет ни истории, ни бумаги, и гасить тоже нечего.
   */
  const history = await planAssignmentHistory(tx, { requestId, asOf });
  const changes: readonly AssignmentChangeRecord[] =
    history.state === 'empty' ? [] : history.changes;

  // Режим бумаги и действующие листы — у той работы, которая их и считает: своя копия «что такое
  // действующий лист заявки» разошлась бы со сверкой при первой же правке.
  const base = await buildEsm2SyncPlan(tx, { requestId, asOf });
  if (!base) throw err.notFound('Заявка не найдена');
  const esm2Mode = base.input.mode;
  const sheets: Esm2ExistingSheet[] = [...base.input.existing];

  const cancelGroups = cancelGroupsOf(changes, termBefore, termAfter);
  const cancelledIds = new Set(cancelGroups.flatMap((g) => g.rows.map((row) => row.id)));
  const changesAfter = changes.filter((row) => !cancelledIds.has(row.id));

  /*
   * Логические эффекты команды — по строке на каждую строку гасимых групп, тем же приёмом, каким их
   * перечисляет отмена у двери машиниста: ядру мутация нужна одна на группу (гашение групповое), а
   * проекциям — диапазон каждой строки, иначе прежний `inTermRange` спутника пропал бы из счёта.
   *
   * Диапазоны считаются по **прежнему** сроку (Р11, Е3): именно он отвечает на вопрос «какие дни
   * группа занимала, пока была актуальной», и от этого зависит исход. Посчитай мы их по новому
   * сроку — гашение группы, вынесенной за срок, оказалось бы безобидным по построению.
   */
  const effectMutations: AssignmentMutation[] = cancelGroups.flatMap((group) =>
    group.rows.map((row): AssignmentMutation => ({ kind: 'cancel', changeId: row.id })),
  );

  const ownershipByVehicle = await readOwnership(tx, requestId, changes);
  const segmentsBefore = assignmentSegments(changes, termBefore);
  const segmentsAfter = assignmentSegments(changesAfter, termAfter);
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
  /**
   * Ожидания бумаги при этом сроке — **по режиму заказа**, а не одним способом на всех.
   *
   * В `auto` их задаёт разрез состава, подрезанный сроком: портал сам решает, сколько бумаги нужно
   * заявке. В `on_demand` (линейный заказ, Р14) решения такого у портала нет — недели называет
   * человек при выписке, — и ожидания берутся из **уже выписанного**, подрезанного тем же сроком
   * (ADR 0100 §5). Именно так их считает и недельная сверка (`esm2RequestedPeriods`), и второй,
   * своей редакции правила здесь нет: разница между режимами ровно одна — откуда взялся набор.
   *
   * `none` — бумаги у заказа нет вовсе (грузоперевозка, аренда, «Новая», архив): ожиданий нет, и
   * выданного портал не ведёт. Сокращение срока такому заказу бумагу не трогает, и это его
   * прежнее поведение, а не пробел, — недельная сверка у него тоже не зовётся ни одной дверью.
   */
  const wantedOf = (segments: readonly AssignmentSegment[], term: AssignmentTerm) =>
    esm2Mode === 'auto'
      ? esm2SheetPlan(segments, term, [], planContextOf({})).wanted
      : esm2Mode === 'on_demand'
        ? esm2RequestedSheets(sheets, term)
        : [];
  /*
   * Отрезки `wanted` до и после команды: замыкание области считается по обоим разрезам (§7).
   */
  const wanted: Esm2Period[] = [
    ...wantedOf(segmentsBefore, termBefore),
    ...wantedOf(segmentsAfter, termAfter),
  ];

  const effects = assignmentCommandEffects({
    changes,
    term: termBefore,
    asOf,
    mutations: effectMutations,
    sheets,
    wanted,
    external,
  });

  /*
   * Область бумаги (§8, таблица): `documentClosure(старый срок △ новый срок)` плюс дневной эффект
   * гашений. Обе половины нужны: изменение срока меняет **набор дней** заявки, а гашение — состав
   * внутри дней, которые оно же и выносит за срок.
   */
  const termDiff = symmetricDifference(termRange(termBefore), termRange(termAfter));
  const paperScope = documentClosure(
    normalizeRangeSet([...effects.paperRange, ...termDiff]),
    sheets,
    wanted,
  );

  /*
   * Разблокировки считаются по плану **без** них: `locked` первого прохода и есть то множество,
   * которое операция обязана назвать, чтобы переоформить отработанную бумагу (Р11). Отпечаток
   * возвращается тогда и только тогда, когда исход `crew`, — в том числе для пустого множества
   * (Д4): у прошедшей недели без листа разблокировать нечего, но `allowPast` ей нужен, и
   * подтверждать человек должен именно пустоту, а не её отсутствие.
   */
  /**
   * План листов после команды — тем же выбором режима, что и ожидания.
   *
   * Ветвей три, и `on_demand` среди них не «поблажка», а предмет: план из ожиданий, вырезанных из
   * выданных бланков, сокращает лист **на месте** (Р6) и гасит неделю, целиком ушедшую за новый
   * конец. Пустой план на его месте (как было до починки дыры Э10) означал бы выданный на неделю
   * бланк, стоящий по дни, которых у заказа больше нет, — и заметить это было бы не по чему.
   */
  const planAfter = (options: {
    scope?: DateRangeSet;
    unlockWaybillIds?: readonly string[];
    correction?: boolean;
  }): Esm2SheetPlan =>
    esm2Mode === 'auto'
      ? esm2SheetPlan(segmentsAfter, termAfter, sheets, planContextOf(options))
      : esm2Mode === 'on_demand'
        ? esm2RequestedSheetPlan(sheets, termAfter, planContextOf(options))
        : EMPTY_SHEET_PLAN;
  const probe = planAfter({ scope: paperScope });
  const requiredUnlockIds = effects.needsCorrection ? [...probe.locked].sort() : [];
  const sheetPlan = planAfter({
    scope: paperScope,
    unlockWaybillIds: requiredUnlockIds,
    correction: effects.needsCorrection,
  });

  const numbers = await readSheetNumbers(tx, requestId);
  const names = await readNames(tx, sheetPlan, cancelGroups);
  const preview = previewPlanOf(sheetPlan, sheets, numbers, names);
  /*
   * Предупреждения считаются по **показанному** списку выписок, а не по плану заново: ключ
   * `issueKey` — индекс в нём, и по этому ключу человек подтверждает бумагу. Второй проход по
   * канону сортировки дал бы окну один порядок, а рукопожатиям другой.
   */
  const planIssues = await assignmentPlanIssues(tx, { requestId, issue: preview.issue });
  /*
   * Дни линейного заказа — последними и только по просьбе двери: чтение это лишнее у заказа,
   * который дней не ведёт вовсе, а порядок остальных чтений от него не зависит.
   */
  const linearDays = params.linearDays
    ? await planLinearRouteDays(tx, {
        requestId,
        eligibilitySubject: params.linearDays.eligibilitySubject,
        retainCompletedDays: params.linearDays.retainCompletedDays,
      })
    : EMPTY_LINEAR_DAYS;

  return {
    historyPresent: history.state !== 'empty',
    termDiff,
    effects,
    cancelGroups,
    cancelGroupsPreview: cancelGroupsPreviewOf(cancelGroups, names.vehicles),
    cancelGroupsFingerprint:
      cancelGroups.length > 0 ? fingerprintOf(cancelGroupsShape(cancelGroups)) : null,
    paperScope,
    esm2Mode,
    sheetPlan,
    preview,
    issues: planIssues.issues,
    issuePreparations: planIssues.prepared,
    requiredUnlockIds,
    requiredUnlocks: requiredUnlockIds.map((id) => unlockDtoOf(id, sheets, numbers)),
    unlockFingerprint: effects.needsCorrection ? fingerprintOf({ requiredUnlockIds }) : null,
    sheets,
    sheetNumbers: numbers,
    linearDays,
  };
}

// ── Границы срока ──

/** Последний день срока: `coalesce(date_to, date_from)` — так его читает весь портал. */
export function lastDayOf(term: AssignmentTerm): string {
  return term.dateTo || term.dateFrom;
}

/** Срок одним отрезком календаря. */
function termRange(term: AssignmentTerm): { from: string; to: string } {
  return { from: term.dateFrom, to: lastDayOf(term) };
}

/**
 * Симметрическая разность двух сроков — дни, которые команда открывает или закрывает (§8).
 *
 * Считается на отрезках, а не поштучно: срок бывает многолетним, а различий у двух отрезков не
 * больше двух — по краю с каждой стороны.
 */
function symmetricDifference(
  before: { from: string; to: string },
  after: { from: string; to: string },
): DateRangeSet {
  const parts: { from: string; to: string }[] = [];
  const edge = (a: { from: string; to: string }, b: { from: string; to: string }): void => {
    if (a.from < b.from) parts.push({ from: a.from, to: min(shiftDateKey(b.from, -1), a.to) });
    if (a.to > b.to) parts.push({ from: max(shiftDateKey(b.to, 1), a.from), to: a.to });
  };
  edge(before, after);
  edge(after, before);
  return normalizeRangeSet(parts);
}

const min = (a: string, b: string): string => (a < b ? a : b);
const max = (a: string, b: string): string => (a > b ? a : b);

// ── Гашение групп при сокращении (Д2) ──

/**
 * Группы, которые сокращение выносит за срок, — и только они.
 *
 * Критерий: **актуальная строка любой шкалы, стоявшая внутри прежнего срока и оказавшаяся за новым
 * концом**. Обе половины условия по дате по делу:
 *
 * - **`effectiveDate <= прежний конец`**, потому что то, что уже лежало за сроком, сокращению не
 *   мешает: дремлющая группа решения хвоста стоит на `dateTo + 1` и была дремлющей до команды —
 *   гасить её правкой срока не за что (§13, «дремлющая группа хвоста за старым `dateTo` сокращению
 *   не мешает»);
 * - **`effectiveDate > новый конец`** — собственно предмет: эти дни из срока ушли.
 *
 * ПОЧЕМУ ШКАЛА БОЛЬШЕ НЕ УСЛОВИЕ. Прежняя редакция брала в счёт только строки `dimension ===
 * 'vehicle'`, ссылаясь на послабление Р24 плана `assignment-periods-plan.md` («изменение за сроком
 * дремлет») — оно и правда ограничено шкалой `driver`. Но послабление отвечает на другой вопрос: оно
 * разрешает **поставить** машиниста за концом срока и не выписывать под него бумагу. Здесь же
 * решается судьба решения, которое человек ставил **внутри** срока и которое команда только что
 * вынесла наружу, — и довод Р18 к нему применим целиком: непогашенная строка переживёт сокращение и
 * оживёт при первом же продлении после отката, прямо вопреки Р14 («откат ничего не возвращает»).
 * У машины это назначало бы технику в обход Р7; у машиниста цена меньше, но природа та же — в
 * работу возвращается состав, которого никто заново не называл, а человек, сокративший срок,
 * решение о субботнем сменщике видел последним и считал снятым. Поэтому решение заказчика: **гасить
 * любые решения за новым концом срока, независимо от шкалы**, и условие по `dimension` снято.
 *
 * Цена названа вслух: у двери срока (Р18, Э6 обещали извлечение без изменения поведения) правило
 * теперь строже прежнего — группа из одной `driver`-строки за новым концом стала гасимой, попадает в
 * перечень предпросмотра и требует отпечатка. Это осознанное расширение, а не побочный эффект.
 *
 * Сдвиг начала срока вперёд сюда не входит намеренно: строка левее нового начала продолжает
 * задавать состав первого дня (свёртка читает последнее изменение **до** даты), и гасить её значило
 * бы стереть состав, который заявка как раз и показывает.
 *
 * Состав каждой группы читается целиком и обеих шкал: гашение групповое (В2), и человек, сокращающий
 * срок, должен увидеть, что вместе с майской машиной уходит её майский машинист.
 */
export function cancelGroupsOf(
  changes: readonly AssignmentChangeRecord[],
  termBefore: AssignmentTerm,
  termAfter: AssignmentTerm,
): TermCancelGroup[] {
  const oldLast = lastDayOf(termBefore);
  const newLast = lastDayOf(termAfter);
  if (newLast >= oldLast) return [];

  const actual = changes.filter((row) => !row.supersededAt);
  const groupIds = new Set(
    actual
      .filter((row) => row.effectiveDate <= oldLast && row.effectiveDate > newLast)
      .map((row) => row.changeGroupId),
  );

  return [...groupIds]
    .map((changeGroupId): TermCancelGroup => {
      const rows = actual
        .filter((row) => row.changeGroupId === changeGroupId)
        .sort((a, b) =>
          a.effectiveDate < b.effectiveDate
            ? -1
            : a.effectiveDate > b.effectiveDate
              ? 1
              : a.dimension < b.dimension
                ? -1
                : 1,
        );
      const anchor = rows.find((row) => row.dimension === 'vehicle') ?? rows[0]!;
      return {
        changeGroupId,
        rows,
        target: { kind: 'cancel', target: assignmentChangeTargetOf(anchor) },
      };
    })
    .sort((a, b) =>
      a.rows[0]!.effectiveDate < b.rows[0]!.effectiveDate
        ? -1
        : a.rows[0]!.effectiveDate > b.rows[0]!.effectiveDate
          ? 1
          : 0,
    );
}

/**
 * Содержание погашаемых групп для отпечатка — **значениями, а не идентификаторами** (Р20).
 *
 * У истории, которую материализует та же транзакция, идентификаторов ещё нет вовсе, а состав группы
 * человек подтверждает по составу: смена члена группы между предпросмотром и командой обязана дать
 * 422 «список изменился», а не пройти молча (Р31, «состав группы читается под блокировкой»).
 *
 * Экспортируется, потому что хешируется дважды и обязана считаться одинаково: `cancelGroupsFingerprint`
 * этого расчёта и общий отпечаток последствий двери — про одно и то же содержание, и разъехавшись,
 * они дали бы 422 «подтвердите» на подтверждение, которое человек только что и прислал.
 */
export function cancelGroupsShape(groups: readonly TermCancelGroup[]): unknown {
  return groups.map((group) =>
    group.rows.map((row) => ({
      effectiveDate: row.effectiveDate,
      dimension: row.dimension,
      vehicleId: row.vehicleId,
      driverPersonId: row.driverPersonId,
      driverState: row.driverState,
      origin: row.origin,
    })),
  );
}

/** Те же группы глазами окна: состав целиком, машины — с именами (Д2). */
function cancelGroupsPreviewOf(
  groups: readonly TermCancelGroup[],
  vehicleNames: ReadonlyMap<string, string>,
): CancelledAssignmentGroupDto[] {
  return groups.map((group) => ({
    changeGroupId: group.changeGroupId,
    rows: group.rows.map((row) => ({
      effectiveDate: row.effectiveDate,
      dimension: row.dimension,
      vehicle: row.vehicleId
        ? { vehicleId: row.vehicleId, name: vehicleNames.get(row.vehicleId) ?? row.vehicleId }
        : null,
      driver: driverStateOf(row),
      origin: row.origin,
    })),
  }));
}

/** Состояние машиниста строки; `null` — строка шкалы `vehicle` (Р19). */
function driverStateOf(row: AssignmentChangeRecord): DriverState | null {
  if (row.dimension !== 'driver' || !row.driverState) return null;
  if (row.driverState === 'set') {
    return row.driverPersonId ? { state: 'set', personId: row.driverPersonId } : null;
  }
  return { state: row.driverState };
}

// ── Чтение справочников ──

/**
 * Принадлежность машин разреза (Р4) — вход плана листов.
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
 * Имена машин и людей — и выпускаемых листов, и гасимых групп: идентификатор нужен команде, имя
 * человеку. Обе выборки одним заходом: два запроса за теми же строками стоили бы вдвое, а окно
 * показывает их рядом.
 */
async function readNames(
  tx: AssignmentCommandTx,
  plan: Esm2SheetPlan,
  groups: readonly TermCancelGroup[],
): Promise<PreviewNames> {
  const vehicleIds = new Set(plan.issue.map((i) => i.vehicleId));
  const personIds = new Set(plan.issue.map((i) => i.driver.personId));
  for (const group of groups) {
    for (const row of group.rows) if (row.vehicleId) vehicleIds.add(row.vehicleId);
  }
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

/** Лист под разблокировку — номером и неделей: ими окно называет бумагу, о которой спрашивает. */
function unlockDtoOf(
  waybillId: string,
  sheets: readonly Esm2ExistingSheet[],
  numbers: ReadonlyMap<string, string>,
): AssignmentUnlockDto {
  const sheet = sheets.find((s) => s.id === waybillId);
  return {
    waybillId,
    displayNumber: numbers.get(waybillId) ?? waybillId,
    from: sheet?.periodFrom ?? '',
    to: sheet?.periodTo ?? '',
  };
}

/**
 * План глазами окна: что сгорит и что выпишется.
 *
 * `issueKey` — индекс в плане, отсортированном по `(from, to, vehicleId, driverPersonId)`.
 * Сортировать по идентификатору нельзя вовсе: он появится только после расхода номера, а
 * сгенерированные идентификаторы в отпечаток предпросмотра не входят.
 */
function previewPlanOf(
  plan: Esm2SheetPlan,
  sheets: readonly Esm2ExistingSheet[],
  numbers: ReadonlyMap<string, string>,
  names: PreviewNames,
): { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] } {
  const cancel = plan.cancel.map((id) => {
    const sheet = sheets.find((s) => s.id === id);
    return {
      waybillId: id,
      displayNumber: numbers.get(id) ?? id,
      from: sheet?.periodFrom ?? '',
      to: sheet?.periodTo ?? '',
    };
  });
  const issue = [...plan.issue]
    .sort((a, b) =>
      `${a.from}|${a.to}|${a.vehicleId}|${a.driver.personId}` <
      `${b.from}|${b.to}|${b.vehicleId}|${b.driver.personId}`
        ? -1
        : 1,
    )
    .map((want, index) => ({
      issueKey: index,
      from: want.from,
      to: want.to,
      vehicleId: want.vehicleId,
      vehicleName: names.vehicles.get(want.vehicleId) ?? want.vehicleId,
      driverPersonId: want.driver.personId,
      driverName: names.persons.get(want.driver.personId) ?? want.driver.personId,
    }));
  return { cancel, issue };
}
