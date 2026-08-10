import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { db } from '../db/client';
import { weeklyVehicleRequestItems, weeklyVehicleRequests } from '../db/schema';

/**
 * Чтения, которых предикатам годности строки не хватает у самого заказа (ADR 0085 §4, план «Отбор
 * состава» этап 2).
 *
 * Отдельным модулем здесь ровно одно чтение — и не из аккуратности, а потому что спрашивают его
 * **двое**: сборка состава (предложение и сохранение) и применение под блокировкой. Между сборкой
 * и визой проходят часы, и решение об отъезде вполне успевают принять в соседней неделе; правило
 * «из нескольких „уезжает“ считается последнее» обязано звучать в обеих точках одинаково — два
 * его описания разошлись бы молча, а ценой была бы разная причина отказа у одной и той же строки.
 *
 * Остальные два источника этого правила читаются на месте и по-разному, потому что у них разная
 * кратность: оформленный вывоз (`vehicle_routes.purpose = 'pickup'`) и ожидающий досрочный отъезд
 * берутся `leftJoin`'ом — их не больше одного на заказ (частичный
 * `vehicle_routes_source_request_unique` и первичный ключ `vehicle_request_early_endings` по
 * `request_id`).
 */

type Runner = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * По каким заказам решение «уезжает» уже принято **другой применённой** недельной заявкой.
 *
 * `leftJoin`'ом это брать нельзя: применённых недель с решением «уезжает» по одному заказу бывает
 * несколько — машина уехала по НЗ-15, потом заказ продлили обычной правкой и снова отпустили по
 * НЗ-19, — и join размножил бы кандидата, то есть строку в предложении и в составе.
 *
 * Из нескольких берётся одна и детерминированно: последняя по `week_start`, при равенстве — по
 * `num`. Выбор «какой-нибудь» строки давал бы разный текст причины («уезжает по НЗ-19» и «по
 * НЗ-15» — разные сообщения) между двумя одинаковыми запросами.
 *
 * `exceptWeeklyId` — заявка, которую сейчас собирают или применяют: её собственное решение об
 * отъезде не может быть поводом отказать ей же. Статус `applied` эту заявку и так отсекает, пока
 * она на визе, но проверка стоит явно — она о смысле, а не о совпадении состояний.
 */
export async function loadLeftBy(
  runner: Runner,
  orderIds: string[],
  exceptWeeklyId: string | null,
): Promise<Map<string, { num: number }>> {
  const found = new Map<string, { num: number }>();
  if (orderIds.length === 0) return found;

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
        inArray(weeklyVehicleRequestItems.sourceRequestId, orderIds),
        eq(weeklyVehicleRequests.status, 'applied'),
        // Именно результат строки, а не её вид: `leave`, не дошедшая до применения (`skipped`),
        // решением не стала — по такой единице неделя как раз ничего и не решила.
        eq(weeklyVehicleRequestItems.result, 'left'),
        exceptWeeklyId ? ne(weeklyVehicleRequests.id, exceptWeeklyId) : undefined,
      ),
    )
    .orderBy(desc(weeklyVehicleRequests.weekStart), desc(weeklyVehicleRequests.num));

  for (const row of rows) {
    if (!row.sourceRequestId || found.has(row.sourceRequestId)) continue;
    found.set(row.sourceRequestId, { num: row.num });
  }
  return found;
}
