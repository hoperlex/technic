import { and, eq } from 'drizzle-orm';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestEarlyEndings,
  vehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { type LinearDaysSyncResult, syncLinearRouteDays } from './vehicle-request-days';
import { type Esm2SyncResult, syncEsm2Waybills } from './waybill-esm2';

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
    /** Контекст операции коррекции; не передан — правка обычная, прошлое остаётся закрытым. */
    correction?: WorkPeriodCorrection;
  },
): Promise<WorkPeriodChangeResult> {
  const earlyEndDropped = params.dropPendingEarlyEnd
    ? await clearPendingEarlyEnd(tx, params.requestId)
    : false;
  const esm2 = await syncEsm2Waybills(tx, {
    requestId: params.requestId,
    actor: params.actor,
    reason: params.reason,
    // Ключ передаётся только когда он есть: `correction: undefined` сверка читает как «контекста
    // нет», но писать это условием здесь честнее — видно, что прошлое открывает вызывающий.
    ...(params.correction ? { correction: params.correction } : {}),
  });
  // План по дням сверяется той же транзакцией и по той же причине, что и бумага: сокращённый срок
  // оставил бы рейсы на дни, которых у заказа больше нет. Продление дней не трогает — их просто
  // становится больше, и распланировать новые день за днём предстоит человеку (ADR 0100 §8).
  const days = await syncLinearRouteDays(tx, {
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

/** Что изменило продление: прежний последний день и последствия для запроса и бумаги. */
export interface ExtendResult extends WorkPeriodChangeResult {
  previousDateTo: string;
}

/**
 * Продлить срок заказа спецтехники до `newDateTo` — вход недельной заявки (ADR о недельной заявке,
 * решение «виза применяет заявку той же транзакцией»).
 *
 * Отличается от обычной правки тремя вещами, и каждая здесь обязательна:
 *
 * 1. **Только вперёд.** Сокращение срока работающей заявки идёт через досрочное завершение с визой
 *    (ADR 0044), и продление, принявшее дату раньше нынешнего конца, обошло бы визу в один шаг.
 *    Вызывающий обязан проверить это заранее (предикат контрактов), но проверка стоит и здесь:
 *    место, меняющее чужой срок, не полагается на вежливость вызывающего.
 * 2. **Версия двигается своим условным `UPDATE`.** Заявку правят и мимо недельной, поэтому запись
 *    идёт по прочитанной под блокировкой версии: разошлась — конфликт, а не тихая перезапись.
 * 3. **Запрос на отъезд снимается только с явного согласия** (`dropPendingEarlyEnd`).
 */
export async function extendSpecialEquipmentPeriod(
  tx: Tx,
  params: {
    requestId: string;
    /** Версия заявки, прочитанная под `FOR UPDATE` в этой же транзакции. */
    expectedVersion: number;
    newDateTo: string;
    actor: { id: string };
    reason: string;
    dropPendingEarlyEnd: boolean;
    /**
     * Контекст операции коррекции (ADR 0101). Продление в **прошедшую** неделю без него оставило бы
     * заказ с новым сроком и без бумаги за уже отработанные дни: сверка кончившуюся неделю не
     * выписывает вовсе. Проверять его здесь нечем и не нужно — признак приходит от сервера, уже
     * спросившего право, причину и глубину.
     */
    correction?: WorkPeriodCorrection;
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

  const result = await afterWorkPeriodChanged(tx, {
    requestId: params.requestId,
    actor: params.actor,
    reason: params.reason,
    dropPendingEarlyEnd: params.dropPendingEarlyEnd,
    correction: params.correction,
  });
  return { previousDateTo: period.effectiveDateTo, ...result };
}
