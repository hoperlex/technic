import type { VehicleOwnership } from '@technic/contracts';
import { err } from '../lib/errors';
import type { AssignmentCommandTx } from './assignment-command';
import type { AssignmentEffects } from './assignment-effects';
import type { AssignmentSegment, AssignmentTerm } from './assignment-history';
import { historyIsAuthoritative, type AssignmentModeSnapshot } from './assignment-mode';
import {
  esm2ScopedPlanOfSheetPlan,
  esm2SheetPlan,
  rangeSetCovers,
  sheetMatchesWanted,
  type DateRangeSet,
  type Esm2ExistingSheet,
  type Esm2ScopedPlan,
  type Esm2SheetPlan,
  type Esm2WantedSheet,
} from './esm2-plan';
import {
  applyEsm2SyncPlanAndAudit,
  buildEsm2SyncPlan,
  esm2SyncResultOf,
  type Esm2ExecutionContext,
  type Esm2ExecutionMode,
  type Esm2SyncResult,
} from './waybill-esm2';

/**
 * Шаг 12 канона — бумага дверей истории
 * (`docs/assignment-periods-plan.md`, Р5, Р11, Р32; §7, §8 шаг 12; §10).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Дверей истории четыре — команда машиниста, ремонт, периодная коррекция и
 * правка срока, — и у каждой свой предмет: одна меняет человека, вторая чинит прошлое, третья
 * правит решение о машине, четвёртая двигает календарь. А вопрос «кто исполняет бумагу и с каким
 * провенансом» у всех четырёх один и тот же, и ответ на него зависит не от двери, а от **режима
 * чтения**. Четыре копии этого ответа разошлись бы молча — каждая на своей правке, — и разошлись бы
 * в самом дорогом месте: там, где тратятся номера бланков строгой отчётности.
 *
 * РЕЖИМ РЕШАЕТ, КТО ИСПОЛНЯЕТ (§10). До cutover бумагу по-прежнему ведёт недельная сверка
 * (`syncEsm2Waybills`): она знает одну машину и одного машиниста на заявку и режет срок по
 * календарным неделям. С `read_mode = history` тот же шаг исполняет **отрезковый** план — тот
 * самый, который дверь уже посчитала шагом 6, показала человеку предпросмотром и захешировала в
 * отпечаток. Оба пути обязаны работать до самого переключения и после отката: режим двигается
 * туда и обратно одной строкой (`assignment_periods_control`), и код, умеющий только одну сторону,
 * сделал бы откат невыполнимым.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Записи листов и расхода номеров: их владелец — `waybill-esm2.ts`, и второго
 * механизма выпуска бланка в портале нет и быть не должно. Событие `waybill.esm2_sync` этот модуль
 * тоже не пишет: его владелец — `applyEsm2SyncPlanAndAudit`, и здесь только собирается план и
 * контекст, с которыми исполнитель зовётся.
 */

/** Всё, что нужно шагу 12, чтобы собрать исполняемый план по посчитанному разрезу. */
export interface AssignmentPaperInput {
  requestId: string;
  actor: { id: string };
  /** Причина сверки: ложится в `cancel_reason`, `correction_reason` и в текст события. */
  reason: string;
  /** Снимок режима, прочитанный шагом 0: второй запрос дал бы другое значение. */
  mode: AssignmentModeSnapshot;
  /** Последствия команды: из них берётся исход, и только из него — ветвь исполнения (Р32). */
  effects: AssignmentEffects;
  /** Строка журнала коррекций; `null` — исход `none`, объяснять нечего. */
  operationId: string | null;
  /** План листов на отрезках — тот же, что показан предпросмотром и вошёл в отпечаток. */
  sheetPlan: Esm2SheetPlan;
  /** Область сверки (Р11): вне неё не выписывается и не гасится ничего. */
  paperScope: DateRangeSet;
  /** Действующие листы заявки, прочитанные шагом 6. */
  sheets: readonly Esm2ExistingSheet[];
  /** Напечатанные номера действующих листов: ими журнал называет сгоревшую бумагу. */
  displayNumbers: ReadonlyMap<string, string>;
  /** Листы, названные операцией поимённо (Р11); пусто — прошлое не открывалось. */
  unlockWaybillIds: readonly string[];
}

/**
 * Ветвь исполнения по исходу последствий — **и только по нему** (Р32).
 *
 * `none → ordinary`, `assignment_tail → operation`, `crew → backdate`. Календарь здесь ни при чём:
 * «задним числом» и «нужна операция» — это выводы `operationOutcome`, посчитанного один раз под
 * блокировкой, а не догадка по датам. Разложи мы этот выбор по дверям — и первая же из них выдала
 * бы `backdate` без строки журнала, то есть открыла бы прошлое без provenance.
 */
export function esm2ExecutionModeOf(params: {
  effects: AssignmentEffects;
  operationId: string | null;
  unlockWaybillIds: readonly string[];
}): Esm2ExecutionMode {
  if (params.effects.operationOutcome === 'none' || !params.operationId) {
    return { kind: 'ordinary' };
  }
  if (params.effects.operationOutcome === 'crew') {
    return {
      kind: 'backdate',
      operation: { id: params.operationId },
      backdate: { unlockWaybillIds: params.unlockWaybillIds },
    };
  }
  return { kind: 'operation', operation: { id: params.operationId } };
}

/**
 * Исполняет ли шаг 12 отрезковый план — или бумагу ведёт прежняя недельная сверка (§10).
 *
 * Вопрос задаётся снимку режима, а не календарю и не двери: переключение обратимо, и обе стороны
 * обязаны работать до самого cutover.
 */
export function paperFollowsHistory(mode: AssignmentModeSnapshot): boolean {
  return historyIsAuthoritative(mode);
}

/**
 * Исполнить бумагу по **отрезковому** плану и записать строгое событие (§8, шаг 12).
 *
 * Зовётся только в режиме `history`: в `legacy` дверь идёт прежним путём — недельной сверкой,
 * равенство которой отрезковому плану доказывает гейт совместимости под той же блокировкой.
 *
 * Ничего не пересчитывает и не восстанавливает: план построен шагом 6, показан человеку и вошёл в
 * отпечаток. Пересчёт здесь означал бы исполнение не того, что было подтверждено.
 */
export async function applyAssignmentPaper(
  tx: AssignmentCommandTx,
  params: AssignmentPaperInput,
): Promise<Esm2SyncResult> {
  const { plan, context } = assignmentPaperExecution(params);
  return esm2SyncResultOf(await applyEsm2SyncPlanAndAudit(tx, plan, context));
}

/**
 * Собрать план и контекст исполнения, не исполняя, — вход для дверей, у которых шаг 12 сложнее
 * одной сверки.
 *
 * Такая дверь пока одна: правка срока. Её шаг 12 — это порядок из пяти работ (снятый запрос на
 * отъезд, бэкстоп, бумага, дни линейного заказа, проверка `frozen`), и порядок этот принадлежит
 * общему сервису правки срока, а не двери. Ему и передаётся готовая пара: сервис ведёт порядок,
 * этот модуль — «что исполнять и с каким провенансом».
 */
export function assignmentPaperExecution(params: AssignmentPaperInput): {
  plan: Esm2ScopedPlan;
  context: Esm2ExecutionContext;
} {
  const plan = esm2ScopedPlanOfSheetPlan({
    plan: params.sheetPlan,
    scope: params.paperScope,
    sheets: params.sheets,
    displayNumbers: params.displayNumbers,
    // Связь замены заполняется только под операцией: база запрещает `corrects_waybill_id` без
    // `correction_id`, а обычная сегодняшняя смена машиниста строки журнала не имеет и при этом
    // законно разрезает действующий лист. У таких команд граф замен живёт в событии сверки.
    withCorrectionLinks: params.effects.operationOutcome !== 'none' && params.operationId !== null,
  });
  const context: Esm2ExecutionContext = {
    requestId: params.requestId,
    actorUserId: params.actor.id,
    syncReason: params.reason,
    ...esm2ExecutionModeOf({
      effects: params.effects,
      operationId: params.operationId,
      unlockWaybillIds: params.unlockWaybillIds,
    }),
  };
  return { plan, context };
}

/**
 * Постусловие шага 12 по `paperScope` (Р11): в области сверки бумага обязана сойтись с разрезом.
 *
 * Проверяется именно **область**, а не весь срок: чинить чужой участок попутно значит менять
 * бумагу, которой человек в предпросмотре не видел. И проверяется по ожиданиям, а не по пустоте
 * плана: пустой план прячет расхождение за `locked`.
 *
 * Одно на все двери: постусловие — это утверждение о **результате**, и второе его написание
 * разошлось бы с первым ровно там, где расхождение и надо ловить. Читает оно живое состояние, а не
 * посчитанное, — иначе проверяло бы намерение.
 */
export async function assertAssignmentPaperConverged(
  tx: AssignmentCommandTx,
  params: {
    requestId: string;
    asOf: string;
    /** Отрезки состава **после** команды: по ним и считается, чего в области не хватает. */
    segmentsAfter: readonly AssignmentSegment[];
    term: AssignmentTerm;
    ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>;
    paperScope: DateRangeSet;
    unlockWaybillIds: readonly string[];
    needsCorrection: boolean;
  },
): Promise<void> {
  const after = await buildEsm2SyncPlan(tx, { requestId: params.requestId, asOf: params.asOf });
  if (!after) return;
  const sheets: Esm2ExistingSheet[] = [...after.input.existing];
  const plan = esm2SheetPlan(params.segmentsAfter, params.term, sheets, {
    ownershipByVehicle: params.ownershipByVehicle,
    today: params.asOf,
    scope: params.paperScope,
    unlockWaybillIds: params.unlockWaybillIds,
    ...(params.needsCorrection ? { correction: { allowed: true as const } } : {}),
  });
  const missing = plan.wanted.filter(
    (want: Esm2WantedSheet) =>
      want.driver.state === 'set' &&
      rangeSetCovers(params.paperScope, { from: want.from, to: want.to }) &&
      !sheets.some((sheet) => sheetMatchesWanted(sheet, want)),
  );
  if (plan.cancel.length === 0 && missing.length === 0) return;
  throw err.conflict(
    'Бумага заявки не сошлась с составом по датам — операция отменена, посмотрите последствия заново',
    { code: 'assignment_paper_diverged' },
  );
}
