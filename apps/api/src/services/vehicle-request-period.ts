import { and, eq } from 'drizzle-orm';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestEarlyEndings,
  vehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { type Esm2SyncResult, syncEsm2Waybills } from './waybill-esm2';

/**
 * Срок работ заказа спецтехники: его изменение и всё, что за ним следует.
 *
 * Менять `date_to` умеют три места — обычная правка заявки, согласованное досрочное завершение
 * (ADR 0044) и применение недельной заявки, — а последствия у изменения одни и те же: ожидающий
 * визы запрос на отъезд перестаёт иметь предмет, а недельные листы ЭСМ-2 расходятся с заявкой
 * (ADR 0060). Записанные по разу в каждом вызывающем, эти последствия разойдутся при первой же
 * правке правила, и заявка останется либо с чужим запросом на визу, либо с бумагой на дни, которых
 * не будет.
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

/** Чем кончилось изменение срока: снятый запрос на отъезд и переоформленные листы. */
export interface WorkPeriodChangeResult {
  earlyEndDropped: boolean;
  esm2: Esm2SyncResult;
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
  },
): Promise<WorkPeriodChangeResult> {
  const earlyEndDropped = params.dropPendingEarlyEnd
    ? await clearPendingEarlyEnd(tx, params.requestId)
    : false;
  const esm2 = await syncEsm2Waybills(tx, {
    requestId: params.requestId,
    actor: params.actor,
    reason: params.reason,
  });
  return { earlyEndDropped, esm2 };
}

/** Срок заказа, каким он записан сейчас. `dateTo` пуст у однодневного — читается `dateFrom`. */
export interface CurrentWorkPeriod {
  dateFrom: string;
  /** Эффективный последний день: `coalesce(date_to, date_from)` — так срок читают все отборы. */
  effectiveDateTo: string;
}

export async function loadWorkPeriod(
  tx: Tx,
  requestId: string,
): Promise<CurrentWorkPeriod | null> {
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
  });
  return { previousDateTo: period.effectiveDateTo, ...result };
}
