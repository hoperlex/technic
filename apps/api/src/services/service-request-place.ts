import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { officeEquipmentMovements, serviceRequests, users } from '../db/schema';

/**
 * Заявленное место аппарата: когда расхождение считается РАЗОБРАННЫМ (план перемещения из карточки
 * заявки, Р8; находка Н6 того же плана).
 *
 * Признак расхождения складывается из трёх частей, и ни одна не лишняя:
 *
 * 1. **заявлено** — `object_overridden`: без этого в очередь попало бы всё, у чего снимок разошёлся
 *    с карточкой сам собой, а таких большинство — технику возят;
 * 2. **не устранено переносом** — снимок заявки ≠ объект карточки: перенос единицы гасит очередь
 *    сам, без второго действия и без человека, который обязан не забыть;
 * 3. **не разобрано подтверждением** — по заявке нет перемещения с флагом «подтверждаю заявленное
 *    место». Третья часть и есть ответ на Н6: заявитель сказал «стоит на B», ответственный приехал
 *    и нашёл аппарат на C, перенёс карточку в C — снимок `B` по-прежнему не равен карточке `C`, и
 *    без этого условия заявка висела бы в очереди ИТ-службы до самого закрытия, хотя разобрана.
 *
 * Почему флагом на перемещении, а не отметкой в заявке: заявка — рассказ о том, что заявили, и
 * гасить её поля задним числом значило бы править свидетельство. Перемещение же — событие со своим
 * автором и датой, и «разобрано вот этим действием» читается прямо.
 *
 * Почему служебное перемещение не годится: «увезли в сервис» по той же заявке — тоже строка журнала,
 * но она не отвечает на вопрос «где аппарат стоит на самом деле». Поэтому смотрим не на факт
 * перемещения по заявке, а на флаг, который ответственный ставит осознанно.
 */

/**
 * Условие «расхождение ещё не разобрано подтверждением» — для `WHERE` очереди ИТ-службы.
 *
 * Коррелированный `NOT EXISTS` здесь законен и безопасен: он стоит в `WHERE`, а не в списке колонок
 * выборки. Коррелированный подзапрос в `SELECT` односоставного запроса drizzle собирает молча
 * неверно — на этом модуль уже обжигался, — поэтому признак для строк считается пакетно
 * (`confirmedPlaceByRequest`), а условием отбора служит вот это.
 *
 * Покрывается частичным индексом `office_equipment_movements_confirms_idx` (миграция `0277`).
 */
export function placeNotConfirmedWhere(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${officeEquipmentMovements} m
     WHERE m.service_request_id = ${serviceRequests.id}
       AND m.confirms_declared_place
  )`;
}

/** Кто и когда разобрал расхождение — снимок последнего подтверждающего перемещения. */
export interface PlaceConfirmation {
  movementId: string;
  at: string;
  actorName: string | null;
}

/**
 * Подтверждения места по странице заявок — ОДНИМ запросом, а не строкой на заявку.
 *
 * Тот же приём, что у исполнителей и гарантий в сборке списка: страница отдаёт до полусотни строк, и
 * поход в базу на каждую стоил бы столько же запросов. Берётся ПОСЛЕДНЕЕ подтверждение: их может
 * быть несколько (аппарат искали дважды), а карточка отвечает на вопрос «кем разобрано», то есть
 * последним словом.
 */
export async function confirmedPlaceByRequest(
  requestIds: readonly string[],
): Promise<Map<string, PlaceConfirmation>> {
  const result = new Map<string, PlaceConfirmation>();
  if (requestIds.length === 0) return result;

  const rows = await db
    .select({
      requestId: officeEquipmentMovements.serviceRequestId,
      movementId: officeEquipmentMovements.id,
      at: officeEquipmentMovements.createdAt,
      actorName: users.fullName,
    })
    .from(officeEquipmentMovements)
    // Автор объявлен `restrict`, но соединение левое: подтверждение остаётся фактом и после того,
    // как учётку выключат, — «кем разобрано» тогда честнее показать пустым, чем потерять событие.
    .leftJoin(users, eq(officeEquipmentMovements.movedBy, users.id))
    .where(
      and(
        isNotNull(officeEquipmentMovements.serviceRequestId),
        inArray(officeEquipmentMovements.serviceRequestId, [...requestIds]),
        eq(officeEquipmentMovements.confirmsDeclaredPlace, true),
      ),
    )
    .orderBy(desc(officeEquipmentMovements.createdAt));

  for (const row of rows) {
    if (!row.requestId || result.has(row.requestId)) continue; // порядок убывающий — первое и есть последнее
    result.set(row.requestId, {
      movementId: row.movementId,
      at: row.at.toISOString(),
      actorName: row.actorName,
    });
  }
  return result;
}
