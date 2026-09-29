import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  isServiceRequestClosed,
  type ServiceRequestCurrentPlaceDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  officeEquipment,
  officeEquipmentMovements,
  serviceRequests,
  users,
} from '../db/schema';

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
    /*
     * Ничья по времени разрешается идентификатором, а не порядком чтения. Два подтверждения одной
     * заявки в одну миллисекунду — случай редкий (двойное нажатие, перенос данных), но при равном
     * `created_at` порядок без второго ключа зависит от плана запроса: список показал бы одного
     * разобравшего, карточка после перезапроса — другого, и объяснить это человеку было бы нечем.
     * Пара совпадает с ключом частичного индекса `office_equipment_movements_confirms_idx`, так что
     * досортировки она не стоит.
     */
    .orderBy(desc(officeEquipmentMovements.createdAt), desc(officeEquipmentMovements.id));

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

type Reader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The request fields the current place depends on — a page row or a mail row alike. */
export interface CurrentPlaceSubject {
  id: string;
  officeEquipmentId: string | null;
  status: ServiceRequestStatus;
  createdAt: Date;
}

/**
 * Where each request's unit stands now (ADR 0215) — ONE query per page, the same batching as the
 * place confirmations above: the block is shown in every list row, and a query per row would cost
 * fifty round trips.
 *
 * The gate is "the unit moved AFTER the request was filed", and ANY movement counts — recorded from
 * this request, from another one, or straight from the directory (owner's decision 29.09.2026).
 * Narrowing it to movements linked to this request would leave the executor with a stale header
 * whenever IT fixed the directory from the fleet screen, which is the common path.
 *
 * Without a movement the snapshot stays the answer even if the card differs: that difference is
 * either the declared-but-unchecked place (showing the card would contradict the requester before
 * anyone looked) or an ordinary directory edit, which is not a move.
 *
 * The place itself is read from the live card, not from the movement's target side: the room and
 * the state note are also editable on the card without a movement, and "stands now" must follow
 * those edits. Archived cards give nothing — there is no "now" for a unit taken out of the fleet.
 */
export async function currentPlaceByRequest(
  requests: readonly CurrentPlaceSubject[],
  // A mail is assembled inside the transaction that sends it; reading through the pool there would
  // take a second connection while the first one is held.
  reader: Reader = db,
): Promise<Map<string, ServiceRequestCurrentPlaceDto>> {
  const result = new Map<string, ServiceRequestCurrentPlaceDto>();
  const open = requests.filter(
    (r): r is CurrentPlaceSubject & { officeEquipmentId: string } =>
      r.officeEquipmentId !== null && !isServiceRequestClosed(r.status),
  );
  if (open.length === 0) return result;
  const equipmentIds = [...new Set(open.map((r) => r.officeEquipmentId))];

  const rows = await reader
    .selectDistinctOn([officeEquipmentMovements.equipmentId], {
      equipmentId: officeEquipmentMovements.equipmentId,
      recordedAt: officeEquipmentMovements.createdAt,
      movedOn: officeEquipmentMovements.movedOn,
      objectId: constructionObjects.id,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      location: officeEquipment.location,
      state: officeEquipment.state,
      stateNote: officeEquipment.stateNote,
    })
    .from(officeEquipmentMovements)
    .innerJoin(officeEquipment, eq(officeEquipmentMovements.equipmentId, officeEquipment.id))
    .innerJoin(constructionObjects, eq(officeEquipment.objectId, constructionObjects.id))
    .where(
      and(
        inArray(officeEquipmentMovements.equipmentId, equipmentIds),
        isNull(officeEquipment.deletedAt),
      ),
    )
    // Latest by RECORDING time, id as the tie-break: the gate asks "did the snapshot miss this
    // movement", and the snapshot was taken at the request's recording time. Comparing the
    // backdatable move day instead would drop a Friday move entered on Monday for a request filed
    // on Saturday — although the Saturday snapshot never saw it.
    .orderBy(
      officeEquipmentMovements.equipmentId,
      desc(officeEquipmentMovements.createdAt),
      desc(officeEquipmentMovements.id),
    );
  const latest = new Map(rows.map((row) => [row.equipmentId, row]));

  for (const request of open) {
    const row = latest.get(request.officeEquipmentId);
    if (!row || row.recordedAt <= request.createdAt) continue;
    result.set(request.id, {
      object: { id: row.objectId, code: row.objectCode, name: row.objectName },
      location: row.location,
      state: row.state,
      stateNote: row.stateNote,
      movedOn: row.movedOn,
    });
  }
  return result;
}

/**
 * The room copied into a new request's snapshot (ADR 0215): the card's room only when the request
 * is filed on the card's own site.
 *
 * When the requester names another site (or the form writes the request onto the customer's site
 * for a unit listed elsewhere), the card's room belongs to the site the unit is NOT on, and the
 * header used to read "declared site · room from the old site" — a place that does not exist.
 * Empty is honest: nobody has said where on the new site the unit stands, and IT fills it in with
 * the movement that confirms the place.
 */
export function snapshotLocationFor(
  card: { objectId: string; location: string },
  requestObjectId: string | null,
): string {
  return requestObjectId === card.objectId ? card.location : '';
}
