import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { formatWeeklyRequestNumber } from '@technic/contracts';
import type { db } from '../db/client';
import {
  weeklyVehicleRequestHistory,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';

/**
 * Уборка следов недельной заявки при удалении насовсем (ADR 0085 Р15, план §6).
 *
 * Правило одно — **намерение уступает, факт держит**. `source_request_id` и `created_request_id`
 * объявлены `ON DELETE RESTRICT`: применённая заявка не должна терять свои следствия, а
 * `SET NULL` именно это и сделал бы. Голый `RESTRICT`, однако, даёт обратную беду — брошенный
 * черновик держал бы заказ, тип ТС или площадку вечно, и снести их стало бы нечем: своего `purge`
 * у недельной заявки нет. Поэтому `purge` сначала убирает следы из **неприменённых** заявок
 * (`draft`, `pending`, `cancelled`) и только затем упирается в применённые, объясняясь словами
 * (`REFERENCING_TABLE_LABELS`, `directory-purge.ts`).
 *
 * Ветки две, и путать их нельзя — у них разный ответ старому клиенту:
 *
 *   - **уборка строк** (заказ, тип ТС, категория ТС) поднимает `version` шапки, и человек,
 *     открывший состав до `purge`, получает на применении **409**, а не визирует строку, которой
 *     уже нет;
 *   - **удаление заявок целиком** (площадка) версией не занимается вовсе: поднимать её у строки,
 *     которую тут же удаляют, бессмысленно, а клиент получает **404** — документа больше нет.
 *
 * Всё идёт в транзакции самого `purge`: снять строки и не снести запись (или наоборот) значит
 * оставить портал в состоянии, которого политика ссылок не описывает.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Кто убирает. Событий без автора у недельной заявки не бывает: состав меняет человек, и уборку
 * при `purge` тоже делает администратор осознанным действием — `changed_by` объявлен `NOT NULL`.
 */
export interface WeeklyCleanupActor {
  id: string;
}

/** Снятая строка — тем составом, каким её называют в истории документа. */
interface DroppedItem {
  itemId: string;
  kind: string;
  position: number;
}

/**
 * Что уборка сделала — в метаданные аудита самого `purge`. `undefined` означает «трогать было
 * нечего»: тогда в журнале остаются только реквизиты снесённой строки.
 */
type CleanupMeta = Record<string, unknown> | undefined;

/**
 * Общее место всех трёх уборок строк: заблокировать затронутые шапки, перепроверить их статус,
 * снять строки, поднять версию и записать событие.
 *
 * Порядок блокировки задаётся `ORDER BY id` — тем же, которым берёт заказы применение
 * (`weekly-request-apply.ts`): общий для всех порядок исключает взаимный клинч двух транзакций,
 * взявших пересекающиеся документы.
 *
 * Статус перечитывается **после** блокировки, а не в отборе кандидатов: заявка могла стать
 * `applied`, пока `purge` ждал на блокировке, — и тогда её строку не трогают вовсе, а отказ по
 * ссылке приходит от самой БД. Ровно в этом смысл слова «факт держит».
 */
async function dropItems(
  tx: Tx,
  actor: WeeklyCleanupActor,
  params: { where: SQL; reason: string },
): Promise<CleanupMeta> {
  const candidates = await tx
    .select({ weeklyRequestId: weeklyVehicleRequestItems.weeklyRequestId })
    .from(weeklyVehicleRequestItems)
    .where(params.where);
  if (candidates.length === 0) return undefined;

  const headerIds = [...new Set(candidates.map((c) => c.weeklyRequestId))];
  const headers = await tx
    .select({
      id: weeklyVehicleRequests.id,
      num: weeklyVehicleRequests.num,
      status: weeklyVehicleRequests.status,
      version: weeklyVehicleRequests.version,
    })
    .from(weeklyVehicleRequests)
    .where(inArray(weeklyVehicleRequests.id, headerIds))
    .orderBy(asc(weeklyVehicleRequests.id))
    .for('update');

  const unapplied = headers.filter((h) => h.status !== 'applied');
  // Все затронутые заявки применены — убирать нечего, и удаление честно упрётся в `RESTRICT`.
  if (unapplied.length === 0) return undefined;

  // Условие прогоняется заново, а не по снятым до блокировки идентификаторам: состав неприменённой
  // заявки правится и параллельно, и снять надо ровно то, что ссылается на исчезающую запись
  // сейчас.
  const dropped = await tx
    .delete(weeklyVehicleRequestItems)
    .where(
      and(
        inArray(
          weeklyVehicleRequestItems.weeklyRequestId,
          unapplied.map((h) => h.id),
        ),
        params.where,
      ),
    )
    .returning({
      id: weeklyVehicleRequestItems.id,
      weeklyRequestId: weeklyVehicleRequestItems.weeklyRequestId,
      kind: weeklyVehicleRequestItems.kind,
      position: weeklyVehicleRequestItems.position,
    });
  if (dropped.length === 0) return undefined;

  const byRequest = new Map<string, DroppedItem[]>();
  for (const row of dropped) {
    const list = byRequest.get(row.weeklyRequestId) ?? [];
    list.push({ itemId: row.id, kind: row.kind, position: row.position });
    byRequest.set(row.weeklyRequestId, list);
  }

  const changedAt = new Date();
  const touched: string[] = [];
  for (const header of unapplied) {
    const items = byRequest.get(header.id);
    if (!items) continue;
    // Поднятие версии здесь принципиально: без него руководитель, открывший состав до `purge`,
    // применил бы его, не получив 409, — то есть завизировал бы строку, которой уже нет.
    await tx
      .update(weeklyVehicleRequests)
      .set({ version: header.version + 1, updatedBy: actor.id, updatedAt: changedAt })
      .where(eq(weeklyVehicleRequests.id, header.id));
    // История — той же транзакцией, а не только аудитом (ADR 0085 Р16): `writeAudit` намеренно не
    // роняет операцию при сбое записи, и тогда состав документа изменился бы молча, а объяснения
    // ему не нашлось бы нигде.
    await tx.insert(weeklyVehicleRequestHistory).values({
      weeklyRequestId: header.id,
      event: 'item_dropped',
      changedBy: actor.id,
      changedAt,
      comment: params.reason,
      payload: { dropped: items.length, items },
    });
    touched.push(formatWeeklyRequestNumber(header.num));
  }
  return { weeklyItemsDropped: dropped.length, weeklyRequestsTouched: touched };
}

/**
 * `purge` заказа ТС: снимаются строки «остаётся» и «уезжает» неприменённых заявок — обе ссылаются
 * на заказ, и обе после его исчезновения говорят о том, чего нет.
 *
 * Строку `created_request_id` уборка не трогает намеренно: она бывает только у применённой строки
 * `new` и объясняет, откуда заказ взялся, — снести такой заказ насовсем нельзя вовсе.
 */
export function dropWeeklyItemsOfRequest(
  tx: Tx,
  actor: WeeklyCleanupActor,
  request: { id: string; displayNumber: string },
): Promise<CleanupMeta> {
  return dropItems(tx, actor, {
    where: eq(weeklyVehicleRequestItems.sourceRequestId, request.id),
    reason: `Строка снята: заказ ${request.displayNumber} удалён насовсем`,
  });
}

/** `purge` типа ТС: снимаются строки «нужна дополнительно» — заказать погашенную позицию нечем. */
export function dropWeeklyItemsOfVehicleType(
  tx: Tx,
  actor: WeeklyCleanupActor,
  type: { id: string; name: string },
): Promise<CleanupMeta> {
  return dropItems(tx, actor, {
    where: eq(weeklyVehicleRequestItems.vehicleTypeId, type.id),
    reason: `Строка снята: тип ТС «${type.name}» удалён насовсем`,
  });
}

/**
 * Удаление категории ТС: те же строки `new`, но отобранные категорией. Отдельно от типа, потому
 * что категорию сносят и саму по себе, а строка без своей категории — уже не та позиция
 * классификатора, которую заказывали (ADR 0028).
 */
export function dropWeeklyItemsOfVehicleCategory(
  tx: Tx,
  actor: WeeklyCleanupActor,
  category: { id: string; name: string },
): Promise<CleanupMeta> {
  return dropItems(tx, actor, {
    where: eq(weeklyVehicleRequestItems.vehicleCategoryId, category.id),
    reason: `Строка снята: категория ТС «${category.name}» удалена насовсем`,
  });
}

/**
 * `purge` площадки: неприменённые заявки удаляются **целиком** — заявка на снесённую площадку
 * документ ни о чём, и снимать у неё строки по одной означало бы оставить пустой документ.
 *
 * Версией эта ветка не занимается вовсе, и события `item_dropped` здесь не пишется: история уходит
 * каскадом вместе с шапкой, и запись, сделанная за секунду до этого, не пережила бы собственного
 * родителя. Клиенту, державшему страницу открытой, достаётся 404 — правильный ответ: документа
 * больше нет, обновлять нечего. След остаётся в аудите самого `purge` — номерами снесённых заявок.
 *
 * Автора эта ветка не спрашивает по той же причине: писать событие некуда, а кто снёс площадку,
 * знает журнал самого `purge`.
 */
export async function purgeWeeklyRequestsOfObject(
  tx: Tx,
  object: { id: string },
): Promise<CleanupMeta> {
  const headers = await tx
    .select({
      id: weeklyVehicleRequests.id,
      num: weeklyVehicleRequests.num,
      status: weeklyVehicleRequests.status,
    })
    .from(weeklyVehicleRequests)
    .where(eq(weeklyVehicleRequests.objectId, object.id))
    .orderBy(asc(weeklyVehicleRequests.id))
    .for('update');
  // Статус читается под блокировкой по той же причине, что и при уборке строк: заявка могла стать
  // применённой, пока `purge` ждал, — и тогда площадку не удалить, о чём скажет отказ по ссылке.
  const unapplied = headers.filter((h) => h.status !== 'applied');
  if (unapplied.length === 0) return undefined;
  await tx.delete(weeklyVehicleRequests).where(
    inArray(
      weeklyVehicleRequests.id,
      unapplied.map((h) => h.id),
    ),
  );
  return { weeklyRequestsPurged: unapplied.map((h) => formatWeeklyRequestNumber(h.num)) };
}
