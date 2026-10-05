import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  type WeeklyAnnulItem,
  type WeeklyAnnulOrder,
  type WeeklyAnnulReversal,
  type WeeklyAnnulState,
  weeklyAnnulItemState,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestEarlyEndings,
  vehicleRequests,
  vehicleRoutes,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';

/**
 * Состояние обратного хода строк применённой недели (ADR 0218 решение 4) — чтения, которых
 * предикату контрактов не хватает у самой строки.
 *
 * Отдельным модулем, потому что спрашивают его **двое**: чек-лист недели (`GET /:id/documents`,
 * подпись «чем развернуть эту строку») и сама команда аннулирования под блокировкой. Между
 * открытием карточки и нажатием проходят часы, и ответ обязан звучать в обеих точках одинаково —
 * два его описания разошлись бы молча, а ценой была бы кнопка, обещающая ход, которым команда
 * откажет.
 *
 * Сам разбор живёт в контрактах (`weeklyAnnulItemState`): правило одно на портал и сервер, здесь
 * только то, что лежит в таблицах и чего строка о себе не знает — сегодняшнее состояние заказа,
 * оформленный вывоз и недели, решившие по тому же заказу позже.
 */

type Runner = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * Недели, применённые **позже** нашей и тронувшие тот же заказ.
 *
 * Ключ — `applied_at`, а не `week_start`: порядок применения свободен (ADR 0085 «Последствия» —
 * дальнюю неделю применяют первой), и решение, принятое поверх нашего, узнаётся моментом
 * применения, а не календарём. Разворачивать своё, не тронув стоящее поверх, значило бы отменить
 * чужое решение молча.
 *
 * Строки `new` соседних недель сюда не идут: порождённый заказ принадлежит ровно одной неделе
 * (частичный `weekly_items_created_uniq`), и «тронуть его позже» другая неделя может только как
 * `extend` или `leave` — то есть по `source_request_id`.
 */
export async function loadLaterWeekRefs(
  runner: Runner,
  params: { weeklyId: string; appliedAt: Date; orderIds: string[] },
): Promise<Map<string, { num: number }[]>> {
  const found = new Map<string, { num: number }[]>();
  if (params.orderIds.length === 0) return found;

  const rows = await runner
    .select({
      sourceRequestId: weeklyVehicleRequestItems.sourceRequestId,
      num: weeklyVehicleRequests.num,
    })
    .from(weeklyVehicleRequestItems)
    .innerJoin(
      weeklyVehicleRequests,
      eq(weeklyVehicleRequestItems.weeklyRequestId, weeklyVehicleRequests.id),
    )
    .where(
      and(
        inArray(weeklyVehicleRequestItems.sourceRequestId, params.orderIds),
        eq(weeklyVehicleRequests.status, 'applied'),
        ne(weeklyVehicleRequests.id, params.weeklyId),
        // Именно результат строки, а не её вид: строка, не дошедшая до применения (`skipped`),
        // решением не стала — по такой единице соседняя неделя как раз ничего и не решила.
        or(
          eq(weeklyVehicleRequestItems.result, 'extended'),
          eq(weeklyVehicleRequestItems.result, 'left'),
        ),
        isNotNull(weeklyVehicleRequests.appliedAt),
        sql`${weeklyVehicleRequests.appliedAt} > ${params.appliedAt.toISOString()}`,
      ),
    )
    .orderBy(desc(weeklyVehicleRequests.appliedAt), asc(weeklyVehicleRequests.num));

  for (const row of rows) {
    if (!row.sourceRequestId) continue;
    const list = found.get(row.sourceRequestId) ?? [];
    list.push({ num: row.num });
    found.set(row.sourceRequestId, list);
  }
  return found;
}

/**
 * Оформленный вывоз по заказу — рейс-перегон `purpose = 'pickup'`.
 *
 * Берётся отдельным чтением, а не `leftJoin`'ом к составу, по той же причине, по какой так делает
 * сборка состава: на заказ он один (частичный `vehicle_routes_source_request_unique`), и список
 * идентификаторов читается одним запросом вместо размножения строк состава.
 */
export async function loadPickupRoutes(
  runner: Runner,
  orderIds: string[],
): Promise<Map<string, { num: number; routeDate: string }>> {
  const found = new Map<string, { num: number; routeDate: string }>();
  if (orderIds.length === 0) return found;

  const rows = await runner
    .select({
      sourceRequestId: vehicleRoutes.sourceRequestId,
      num: vehicleRoutes.num,
      routeDate: vehicleRoutes.routeDate,
    })
    .from(vehicleRoutes)
    .where(
      and(inArray(vehicleRoutes.sourceRequestId, orderIds), eq(vehicleRoutes.purpose, 'pickup')),
    );

  for (const row of rows) {
    if (!row.sourceRequestId) continue;
    found.set(row.sourceRequestId, { num: row.num, routeDate: row.routeDate });
  }
  return found;
}

/** Сегодняшнее состояние заказа — та сторона разбора, которой строка о себе не знает. */
export async function loadAnnulOrders(
  runner: Runner,
  orderIds: string[],
): Promise<Map<string, WeeklyAnnulOrder>> {
  const found = new Map<string, WeeklyAnnulOrder>();
  if (orderIds.length === 0) return found;

  const [heads, pickups] = await Promise.all([
    runner
      .select({
        id: vehicleRequests.id,
        status: vehicleRequests.status,
        deletedAt: vehicleRequests.deletedAt,
        dateFrom: specialEquipmentRequestDetails.dateFrom,
        dateTo: specialEquipmentRequestDetails.dateTo,
        pendingEarlyEndDate: vehicleRequestEarlyEndings.newDateTo,
      })
      .from(vehicleRequests)
      .leftJoin(
        specialEquipmentRequestDetails,
        eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
      )
      .leftJoin(
        vehicleRequestEarlyEndings,
        and(
          eq(vehicleRequestEarlyEndings.requestId, vehicleRequests.id),
          eq(vehicleRequestEarlyEndings.status, 'pending'),
        ),
      )
      .where(inArray(vehicleRequests.id, orderIds)),
    loadPickupRoutes(runner, orderIds),
  ]);

  for (const head of heads) {
    found.set(head.id, {
      status: head.status,
      deletedAt: head.deletedAt ? head.deletedAt.toISOString() : null,
      // Заказа без детали срока у спецтехники не бывает; у грузоперевозки её нет вовсе, и такой
      // заказ в состав недели не попадает (`sourceItemBlocker` отбивает его по типу заявки).
      dateFrom: head.dateFrom ?? '',
      dateTo: head.dateTo ?? null,
      pickupRoute: pickups.get(head.id) ?? null,
      pendingEarlyEndDate: head.pendingEarlyEndDate,
    });
  }
  return found;
}

/** Строка состава, какой её видит разбор: то же, что хранится, плюс заказ по обе стороны. */
export interface AnnulStateInput {
  id: string;
  kind: WeeklyAnnulItem['kind'];
  result: WeeklyAnnulItem['result'];
  dateTo: string | null;
  previousDateTo: string | null;
  /** Заказ строки: `source_request_id` у `extend`/`leave`, `created_request_id` у `new`. */
  orderId: string | null;
}

export interface AnnulStateRow {
  itemId: string;
  state: WeeklyAnnulState;
  reason: string;
  reverse: WeeklyAnnulReversal;
  /** Дата, к которой вернётся срок; `null` у остальных ходов. */
  shortenTo: string | null;
  previousDateTo: string | null;
  orderId: string | null;
}

/**
 * Разобрать состав применённой недели: по строке — что с ней сделает аннулирование.
 *
 * Чтения идут пачкой на весь состав, а не по строке: у недели их до десяти, и запрос на строку
 * превратил бы открытие карточки в двадцать обращений к базе.
 */
export async function annulStates(
  runner: Runner,
  params: { weeklyId: string; appliedAt: Date; items: AnnulStateInput[] },
): Promise<AnnulStateRow[]> {
  const orderIds = [
    ...new Set(params.items.map((item) => item.orderId).filter((v): v is string => v !== null)),
  ];
  const sourceIds = [
    ...new Set(
      params.items
        .filter((item) => item.kind !== 'new')
        .map((item) => item.orderId)
        .filter((v): v is string => v !== null),
    ),
  ];
  const [orders, laterWeeks] = await Promise.all([
    loadAnnulOrders(runner, orderIds),
    loadLaterWeekRefs(runner, {
      weeklyId: params.weeklyId,
      appliedAt: params.appliedAt,
      orderIds: sourceIds,
    }),
  ]);

  return params.items.map((item) => {
    const order = item.orderId ? (orders.get(item.orderId) ?? null) : null;
    const verdict = weeklyAnnulItemState(
      {
        id: item.id,
        kind: item.kind,
        result: item.result,
        dateTo: item.dateTo,
        previousDateTo: item.previousDateTo,
        laterWeekRefs: item.orderId ? (laterWeeks.get(item.orderId) ?? []) : [],
      },
      order,
    );
    return {
      itemId: item.id,
      state: verdict.state,
      reason: verdict.reason,
      reverse: verdict.reverse,
      // Дата хода называется только там, где ход есть: у прочих она была бы снимком, который
      // прочитают как обещание сократить срок.
      shortenTo: verdict.reverse === 'shorten_to' ? item.previousDateTo : null,
      previousDateTo: item.previousDateTo,
      orderId: item.orderId,
    };
  });
}
