import { and, eq } from 'drizzle-orm';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestEarlyEndings,
  vehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { assertAssignmentBackstop, type AssignmentBackstopDoor } from './assignment-backstop';
import type { AssignmentCommandTx } from './assignment-command';
import { ensureAssignmentHistory, ensureCommandHistory } from './assignment-ensure';
import type { Esm2ScopedPlan } from './esm2-plan';
import {
  applyLinearRouteDaysPlan,
  type LinearDayPlanItem,
  type LinearDaysSyncResult,
  syncLinearRouteDays,
} from './vehicle-request-days';
import {
  applyEsm2SyncPlanAndAudit,
  esm2SyncResultOf,
  syncEsm2Waybills,
  type Esm2ExecutionContext,
  type Esm2SyncResult,
} from './waybill-esm2';

/**
 * Срок работ заказа спецтехники: его изменение и всё, что за ним следует.
 *
 * Менять `date_to` умеют три места — обычная правка заявки, согласованное досрочное завершение
 * (ADR 0044) и применение недельной заявки, — а последствия у изменения одни и те же: ожидающий
 * визы запрос на отъезд перестаёт иметь предмет, недельные листы ЭСМ-2 расходятся с заявкой
 * (ADR 0060), а распланированные дни линейного заказа оказываются за сроком (ADR 0100). Записанные
 * по разу в каждом вызывающем, эти последствия разойдутся при первой же правке правила, и заявка
 * останется либо с чужим запросом на визу, либо с бумагой и рейсами на дни, которых не будет.
 *
 * Поэтому здесь живут именно последствия, а не «обновление полей»: сам срок правка заявки пишет
 * вместе с контактами одним `UPDATE`, и разрезать его ради общего хелпера значило бы усложнить
 * рабочий код ради формы.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Снимает ожидающий визы запрос на досрочное завершение (ADR 0044) и отвечает, был ли он.
 *
 * Запрос перестаёт иметь смысл сам по себе в двух случаях: заявку закрыли (сокращать срок больше
 * нечего) и срок поправили обычной правкой (снимок `previous_date_to` разошёлся с заявкой, и виза
 * решала бы про другой период). Оба раза строка снимается молча для визирующего, но событием для
 * истории: иначе «ждёт визы» висело бы на закрытой заявке и считалось в сводке среза.
 *
 * Решённые запросы не трогаются: согласованный уже сократил срок, отклонённый объясняет, почему
 * этого не случилось, — и оба остаются ответом на вопрос «что было с этой заявкой».
 */
export async function clearPendingEarlyEnd(tx: Tx, requestId: string): Promise<boolean> {
  const removed = await tx
    .delete(vehicleRequestEarlyEndings)
    .where(
      and(
        eq(vehicleRequestEarlyEndings.requestId, requestId),
        eq(vehicleRequestEarlyEndings.status, 'pending'),
      ),
    )
    .returning({ requestId: vehicleRequestEarlyEndings.requestId });
  return removed.length > 0;
}

/**
 * The early-end request still waiting for approval, if any — what `clearPendingEarlyEnd` would
 * delete. Read by the rollback plan (ADR 0211): the rollback drops it silently for the approver,
 * and the human who rolls back must hear about it before, not find it gone from the queue after.
 */
export async function pendingEarlyEndOf(
  reader: Tx | typeof db,
  requestId: string,
): Promise<{ newDateTo: string } | null> {
  const [row] = await reader
    .select({ newDateTo: vehicleRequestEarlyEndings.newDateTo })
    .from(vehicleRequestEarlyEndings)
    .where(
      and(
        eq(vehicleRequestEarlyEndings.requestId, requestId),
        eq(vehicleRequestEarlyEndings.status, 'pending'),
      ),
    );
  return row ?? null;
}

/**
 * Контекст проверенной операции коррекции (ADR 0101) — тот же, что принимает сверка ЭСМ-2.
 *
 * Проезжает через правку срока насквозь и без единой проверки: право `waybills.correct`, причину и
 * границу глубины спросил тот, кто операцию завёл, а здесь остаётся довезти признак до сверки —
 * иначе прошедшие недели, которые правка срока как раз и добавила, остались бы без бумаги
 * (`esm2SyncPlan`: без контекста кончившаяся неделя не выписывается вовсе).
 *
 * Необязателен у всех трёх вызывающих: обычная правка заявки и досрочное завершение о прошлом
 * ничего не утверждают, и требовать от них пустой объект значило бы менять их ради чужой ветки.
 */
export interface WorkPeriodCorrection {
  /** Строка `waybill_corrections` этой операции: на неё сошлются оба листа. */
  id: string;
  /** Листы, которые операция назвала поимённо; принадлежность их заказу проверил вызывающий. */
  unlockWaybillIds: readonly string[];
}

/**
 * Кто считает бэкстоп чужой двери (Р21, Р22) — сервис или вызывающий.
 *
 * Умолчания нет намеренно, как и у `dropPendingEarlyEnd`: правку срока зовут две двери с разными
 * ответами на этот вопрос, и «забыли передать» не должно означать «проверки не было». Недельная
 * операция считает бэкстоп сама и **до первой записи** — по всем применимым строкам разом (Р23),
 * чтобы неделю чинили одним заходом, — и здесь ей проверять уже нечего.
 */
export type WorkPeriodBackstop =
  Extract<AssignmentBackstopDoor, 'work_period' | 'completion'> | 'checked_by_caller';

/**
 * Who leads the ESM-2 paper of this change — the weekly sweep or a **ready segment plan** (§10).
 *
 * There is a default, and it is `weekly`: the status handle and the wide edit compute no segment
 * plan at all. The segment plan comes only in `history`, from the doors that computed it before
 * their first write — the `/period` door (shown to the person and hashed into the fingerprint),
 * the early end, the completion by the actual date, the weekly reversal and the weekly visa
 * (ADR 0220) — and recomputing it here would execute something other than what was computed
 * under the locks.
 *
 * The `waybill.esm2_sync` event is written by the same owner in both branches — the executor.
 */
export type WorkPeriodPaper =
  { kind: 'weekly' } | { kind: 'plan'; plan: Esm2ScopedPlan; context: Esm2ExecutionContext };

/**
 * Кто ведёт дни линейного заказа — прежняя сверка или **готовый план** (Р11, Р27 плана
 * `docs/vehicle-request-actual-end-date-plan.md`).
 *
 * Умолчание есть, и оно `sync`: четыре сегодняшних вызывающих плана дней не считают вовсе, и
 * сверка сама читает субъект из базы — уже после записи нового срока и уже с новым статусом.
 *
 * Дверь закрытия фактической датой так не может, и это не оптимизация: сверка, прочитавшая заявку
 * «Выполненной», обрекает **все** дни заказа разом (общий запрет `linearDaysBlocker` сильнее
 * подённой границы) — то есть подметает и отработанные. Р27 это поведение отменяет, поэтому дверь
 * считает план до смены статуса, по укороченному сроку и с явной политикой, показывает его
 * человеку, хеширует в отпечаток — и сюда приходит **исполнять подтверждённое**, а не считать
 * заново.
 */
export type WorkPeriodDays = { kind: 'sync' } | { kind: 'plan'; plan: LinearDayPlanItem[] };

/** Чем кончилось изменение срока: снятый запрос на отъезд, переоформленные листы и снятые дни. */
export interface WorkPeriodChangeResult {
  earlyEndDropped: boolean;
  esm2: Esm2SyncResult;
  /** Дни линейного заказа, ушедшие за новый срок (ADR 0100 §11); у прочих заявок пусто. */
  days: LinearDaysSyncResult;
}

/**
 * Последствия изменившегося срока работ. Зовётся **после** записи нового периода и в той же
 * транзакции: сверка листов читает заявку из базы, и вызванная раньше записи она свела бы бумагу
 * со старым сроком.
 *
 * `dropPendingEarlyEnd` не имеет умолчания намеренно. Обычная правка снимает ожидающий запрос
 * молча — правит один заказ один человек, глядя на него. Недельная заявка так поступать не вправе:
 * состав в ней предвыбран целиком, и молчаливое снятие десятка чужих решений об отъезде — не то,
 * на что подписывался визирующий; там снятие требует явного согласия по строке.
 */
export async function afterWorkPeriodChanged(
  tx: Tx,
  params: {
    requestId: string;
    actor: { id: string };
    /** Попадёт в причину аннулирования листов и в журнал аудита. */
    reason: string;
    dropPendingEarlyEnd: boolean;
    /** Кто считает бэкстоп истории: `'work_period'` — этот сервис, иначе вызывающий уже посчитал. */
    backstop: WorkPeriodBackstop;
    /** Контекст операции коррекции; не передан — правка обычная, прошлое остаётся закрытым. */
    correction?: WorkPeriodCorrection;
    /** Кто ведёт бумагу (§10); не передан — недельная сверка, как и было до модуля. */
    paper?: WorkPeriodPaper;
    /**
     * Кто ведёт дни линейного заказа; не передан — прежняя сверка, читающая заявку из базы.
     * Готовый план приносит дверь закрытия фактической датой: её план посчитан **до** смены
     * статуса, и пересчитанный здесь он снял бы с рейсов и отработанные дни (Р27).
     */
    days?: WorkPeriodDays;
    /**
     * Открывает ли команда новые дни (Ю78). Знает это только вызывающий: сюда он приходит уже
     * после записи срока, и прежнего конца в базе больше нет.
     *
     * Не передан — считается по умолчанию двери, то есть «открывает». Это прежнее поведение и
     * верно для продления; сокращение обязано сказать `false`, иначе спросит решение по хвосту,
     * которое само же и сломало гашением хвостовой группы.
     */
    opensTerm?: boolean;
  },
): Promise<WorkPeriodChangeResult> {
  const earlyEndDropped = params.dropPendingEarlyEnd
    ? await clearPendingEarlyEnd(tx, params.requestId)
    : false;
  /*
   * Бэкстоп чужой двери (Р21, Р22) — перед бумагой и по уже записанному сроку.
   *
   * Срок к этому моменту записан, и это здесь правильный порядок расчёта: Р31 требует проверять
   * **весь вновь открываемый диапазон**, а он и есть новый `date_to`. Записи бэкстоп при этом не
   * оставляет: в режиме `legacy` он молча кладёт диагностику, а в `history` бросает 422, и вся
   * транзакция двери — вместе с только что записанным сроком — откатывается.
   *
   * Якорей эта дверь не принимает и принимать не должна (Р22): правка заявки защищена правом
   * площадки `vehicleRequests.update`, а называть людей в бланки строгой отчётности — не её дело.
   */
  if (params.backstop !== 'checked_by_caller') {
    await assertAssignmentBackstop(tx, {
      door: params.backstop,
      requestId: params.requestId,
      actor: params.actor,
      reason: params.reason,
      /*
       * Направление говорится явно (Ю78): решение по хвосту спрашивают у **расширения** срока, а
       * сокращение его само же и ломает — гасит хвостовую группу и тут же получает вердикт
       * «хвост разошёлся». Сравниваются прежний и новый конец срока, а не намерение вызывающего.
       */
      opensTerm: params.opensTerm,
    });
  }
  /*
   * Бумага: недельная сверка либо готовый отрезковый план — выбор сделан вызывающим по режиму
   * чтения (§10), а не здесь. Своего решения у этого сервиса быть не должно: он ведёт **порядок**
   * последствий правки срока, а «кто исполняет бумагу» — вопрос режима модуля, и второй ответ на
   * него разошёлся бы с первым ровно в окне переключения.
   */
  const esm2 =
    params.paper?.kind === 'plan'
      ? esm2SyncResultOf(
          await applyEsm2SyncPlanAndAudit(tx, params.paper.plan, params.paper.context),
        )
      : await syncEsm2Waybills(tx, {
          requestId: params.requestId,
          actor: params.actor,
          reason: params.reason,
          // Ключ передаётся только когда он есть: `correction: undefined` сверка читает как
          // «контекста нет», но писать это условием здесь честнее — видно, что прошлое открывает
          // вызывающий.
          ...(params.correction ? { correction: params.correction } : {}),
        });
  // План по дням исполняется той же транзакцией и по той же причине, что и бумага: сокращённый
  // срок оставил бы рейсы на дни, которых у заказа больше нет. Продление дней не трогает — их
  // просто становится больше, и распланировать новые день за днём предстоит человеку (ADR 0100 §8).
  //
  // Готовый план исполняется как есть: заморозку `applyLinearRouteDaysPlan` всё равно перечитает
  // из-под блокировки рейса, а вот **какие** дни обречены, решено до записи статуса и подтверждено
  // человеком.
  const days =
    params.days?.kind === 'plan'
      ? await applyLinearRouteDaysPlan(tx, params.days.plan, {
          requestId: params.requestId,
          actor: params.actor,
        })
      : await syncLinearRouteDays(tx, {
          requestId: params.requestId,
          actor: params.actor,
          reason: params.reason,
        });
  return { earlyEndDropped, esm2, days };
}

/** Срок заказа, каким он записан сейчас. `dateTo` пуст у однодневного — читается `dateFrom`. */
export interface CurrentWorkPeriod {
  dateFrom: string;
  /** Эффективный последний день: `coalesce(date_to, date_from)` — так срок читают все отборы. */
  effectiveDateTo: string;
}

export async function loadWorkPeriod(tx: Tx, requestId: string): Promise<CurrentWorkPeriod | null> {
  const [row] = await tx
    .select({
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
    })
    .from(specialEquipmentRequestDetails)
    .where(eq(specialEquipmentRequestDetails.requestId, requestId));
  if (!row) return null;
  return { dateFrom: row.dateFrom, effectiveDateTo: row.dateTo ?? row.dateFrom };
}

/** What the extension changed: the previous last day and the consequences for requests and paper. */
export interface ExtendResult extends WorkPeriodChangeResult {
  previousDateTo: string;
}

/**
 * The segment plan of an extension when history leads the paper (ADR 0220), and what its
 * execution needs besides the plan itself.
 */
export interface ExtendHistoryPaper {
  /** The calculation day the plan was computed for; readiness is recomputed for the same day. */
  asOf: string;
  /**
   * Whether the order's history could be restored. `false` — it could not (no assignment, or
   * sheets that contradict each other): there is nothing to materialize, as at the `/period` door.
   */
  historyPresent: boolean;
  plan: Esm2ScopedPlan;
  context: Esm2ExecutionContext;
}

/**
 * Extend the term of a special-equipment order to `newDateTo` — the entry of the weekly request
 * (the weekly-request ADR, decision "the approval applies the request in the same transaction").
 *
 * It differs from an ordinary edit in three things, and each is mandatory here:
 *
 * 1. **Forward only.** Shortening the term of a working order goes through the early end with an
 *    approval (ADR 0044), and an extension accepting a date before the current end would bypass
 *    that approval in one step. The caller must check it beforehand (a contracts predicate), but
 *    the check stands here too: a place that changes someone else's term does not rely on the
 *    caller's courtesy.
 * 2. **The version moves by its own conditional `UPDATE`.** The order is edited outside the weekly
 *    request too, so the write goes by the version read under the lock: a mismatch is a conflict,
 *    not a silent overwrite.
 * 3. **A pending early-end request is dropped only with explicit consent** (`dropPendingEarlyEnd`).
 *
 * In `history` the paper is not the weekly sweep's (ADR 0220): the sweep knows one vehicle and one
 * machinist per order and wants one sheet per week, so on a week cut by a mid-week change it burns
 * the second half and cannot reissue it over the worked first one. The caller then brings the
 * segment plan in `history`, and this service keeps step 11 of the history doors around the term
 * write in the order of the `/period` door: history materialized by the OLD term first (the plan
 * was computed over it), readiness recomputed by the NEW term after (Ж1), paper last.
 */
export async function extendSpecialEquipmentPeriod(
  tx: Tx,
  params: {
    requestId: string;
    /** The order version read under `FOR UPDATE` in this same transaction. */
    expectedVersion: number;
    newDateTo: string;
    actor: { id: string };
    reason: string;
    dropPendingEarlyEnd: boolean;
    /**
     * Who computes the history backstop (Р21–Р23). Passed through with no default: the extension is
     * called by the weekly operation, which must compute it as a preflight over all rows at once —
     * otherwise the first problematic order would stop the week in the middle of applying it.
     */
    backstop: WorkPeriodBackstop;
    /**
     * Context of the correction operation (ADR 0101). An extension into a **past** week without it
     * would leave the order with a new term and no paper for the worked days: the weekly sweep does
     * not issue an ended week at all. There is nothing to check it with here, and no need: the
     * marker comes from the server that already asked the right, the reason and the depth.
     */
    correction?: WorkPeriodCorrection;
    /**
     * The segment plan, when history leads the paper (ADR 0220). Not passed — the weekly sweep,
     * as before (`legacy`).
     */
    history?: ExtendHistoryPaper;
  },
): Promise<ExtendResult> {
  const period = await loadWorkPeriod(tx, params.requestId);
  if (!period) throw err.notFound('Заказ техники не найден');
  if (params.newDateTo <= period.effectiveDateTo) {
    throw err.unprocessable(
      `Продление не удлиняет срок: заказ уже идёт по ${period.effectiveDateTo}`,
      { dateTo: 'Дата не позже нынешнего конца срока' },
    );
  }

  // Materialized by the old term: the plan's targets were computed over the history restored in
  // memory, and a backfill run after the term write would restore a different one.
  if (params.history?.historyPresent) {
    await ensureCommandHistory(tx as AssignmentCommandTx, {
      requestId: params.requestId,
      asOf: params.history.asOf,
    });
  }

  await tx
    .update(specialEquipmentRequestDetails)
    .set({ dateTo: params.newDateTo })
    .where(eq(specialEquipmentRequestDetails.requestId, params.requestId));

  const [bumped] = await tx
    .update(vehicleRequests)
    .set({ updatedBy: params.actor.id, version: params.expectedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(vehicleRequests.id, params.requestId),
        eq(vehicleRequests.version, params.expectedVersion),
      ),
    )
    .returning({ id: vehicleRequests.id });
  if (!bumped) throw err.conflict();

  // A door that widened the validity range of the history recomputes its readiness (Ж1): the
  // added days were not part of yesterday's verdict.
  if (params.history) {
    await ensureAssignmentHistory(tx as AssignmentCommandTx, {
      requestId: params.requestId,
      asOf: params.history.asOf,
    });
  }

  const result = await afterWorkPeriodChanged(tx, {
    requestId: params.requestId,
    actor: params.actor,
    reason: params.reason,
    dropPendingEarlyEnd: params.dropPendingEarlyEnd,
    backstop: params.backstop,
    correction: params.correction,
    ...(params.history
      ? {
          paper: {
            kind: 'plan' as const,
            plan: params.history.plan,
            context: params.history.context,
          },
        }
      : {}),
  });
  return { previousDateTo: period.effectiveDateTo, ...result };
}
