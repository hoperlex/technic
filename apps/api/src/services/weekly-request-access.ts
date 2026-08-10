import { and, eq, exists, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import {
  vehicleRequestAssignments,
  vehicles,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { weeklyRequestReadScope } from '../lib/access';
import { err } from '../lib/errors';
import type { Principal } from '../auth/principal';

/**
 * Видимость недельной заявки на чтение — переводом области (`weeklyRequestReadScope`) в SQL.
 *
 * Отдельным модулем, а не в `lib/access.ts`, по той же причине, по которой там нет и
 * `assignedLessorWhere` заказов: ветка арендодателя выражается не колонкой заявки, а её составом,
 * то есть требует таблиц и подзапроса, а `access.ts` намеренно живёт без зависимости от схемы —
 * он принимает колонки аргументами и решает про роли.
 *
 * Главное свойство этого файла: перевод один. Им фильтруется список (лента «Заказ автотехники»),
 * им же проверяется доступ к карточке, истории и чек-листу документов. Два похожих условия в двух
 * местах разошлись бы при первой правке — и разошлись бы молча, в сторону «в списке видно, а по
 * ссылке 404» либо, что хуже, наоборот.
 */

const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

/**
 * Заказ, к которому привязана строка состава: у `extend` и `leave` — исходный, у применённой
 * `new` — порождённый. `coalesce` здесь не «на всякий случай»: строка живёт с одной из двух
 * ссылок, и ровно эта пара отвечает на вопрос «чья техника стоит за строкой».
 */
const itemRequestId = sql`coalesce(${weeklyVehicleRequestItems.sourceRequestId}, ${weeklyVehicleRequestItems.createdRequestId})`;

/**
 * Есть ли в составе названной заявки техника этого арендодателя (ADR 0038). Машина приходит из
 * назначения заказа (ADR 0027), а арендодатель — из самой машины: своего поля исполнителя у
 * заявки ТС нет, и роль арендодателя появляется вместе с назначением.
 *
 * Следствие, то же самое, что у заказов: строка «нужна дополнительно» до применения машины не
 * имеет и недели ему не открывает — до назначения она ничья.
 */
function lessorItemExists(counterpartyId: string, idColumn: SQL | ReturnType<typeof sql>): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(weeklyVehicleRequestItems)
      .innerJoin(vehicleRequestAssignments, eq(vehicleRequestAssignments.requestId, itemRequestId))
      .innerJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
      .where(
        and(
          eq(weeklyVehicleRequestItems.weeklyRequestId, idColumn),
          eq(vehicles.lessorId, counterpartyId),
        ),
      ),
  );
}

/**
 * Условие видимости для выборки недельных заявок. `undefined` — ограничений нет; иначе — предикат,
 * который сравнивает **колонки переданной выборки**, поэтому годится и для основного запроса
 * списка, и для проверки одной строки по идентификатору.
 *
 * Обе колонки обязательны: без объекта не выразить площадку, без идентификатора — состав. Ветка,
 * которой не хватило бы данных, отвечала бы «видит всё» — направление отказа здесь только одно.
 */
export function weeklyRequestReadWhere(
  p: Principal,
  objectColumn: SQL | ReturnType<typeof sql>,
  idColumn: SQL | ReturnType<typeof sql>,
): SQL | undefined {
  const scope = weeklyRequestReadScope(p);
  switch (scope.kind) {
    case 'all':
      return undefined;
    case 'objects':
      // Пустой набор — «не видит ничего», а не «видит всё»: у роли отдела без площадки это
      // рабочее состояние (ПТО, АХО), у объектной роли — состояние, которого API не допускает,
      // но выборка не должна зависеть от того, удержалась ли та проверка.
      return scope.objectIds.length > 0
        ? inArray(objectColumn, [...scope.objectIds])
        : eq(objectColumn, NEVER_MATCH);
    case 'lessor':
      return lessorItemExists(scope.counterpartyId, idColumn);
    case 'none':
      return eq(objectColumn, NEVER_MATCH);
  }
}

/** То же условие для собственной таблицы заявок — им фильтруются список и карточка. */
export function weeklyRequestReadWhereOnTable(p: Principal): SQL | undefined {
  return weeklyRequestReadWhere(
    p,
    sql`${weeklyVehicleRequests.objectId}`,
    sql`${weeklyVehicleRequests.id}`,
  );
}

/**
 * Доступ к чтению одной заявки: карточка, история, чек-лист документов.
 *
 * Проверяется выборкой под тем же предикатом, а не разбором ролей заново, — иначе карточка
 * разошлась бы с лентой. Нет строки — **404**, а не 403: для наблюдателя, отдела и арендодателя
 * сам факт существования недели у площадки, которой они не касаются, тоже не их дело. Внятный
 * отказ «работает только со своими объектами» остаётся там, где человек ошибается адресом
 * осмысленно, — на правке и визе (`assertWeeklyRequestScope`).
 */
export async function assertWeeklyRequestReadable(p: Principal, id: string): Promise<void> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(weeklyVehicleRequests)
    .where(and(eq(weeklyVehicleRequests.id, id), weeklyRequestReadWhereOnTable(p)))
    .limit(1);
  if (!row) throw err.notFound('Недельная заявка не найдена');
}

/**
 * Условие видимости **строк состава** — им сужается документ для арендодателя: он видит свои
 * строки и только их. Это не отдельное правило, а тот же перенос, что открыл ему заявку: в
 * одномашинном заказе «его техника» и «вся заявка» совпадают, а в недельном документе совпадают
 * с его строками — но не с чужими заказами, машинами и сроками соседей по площадке.
 *
 * `undefined` — состав виден целиком (все прочие субъекты).
 */
export function weeklyItemsReadWhere(p: Principal): SQL | undefined {
  const scope = weeklyRequestReadScope(p);
  if (scope.kind !== 'lessor') return undefined;
  return exists(
    db
      .select({ one: sql`1` })
      .from(vehicleRequestAssignments)
      .innerJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
      .where(
        and(
          eq(vehicleRequestAssignments.requestId, itemRequestId),
          eq(vehicles.lessorId, scope.counterpartyId),
        ),
      ),
  );
}

/**
 * Заявки, доступные учётке, из названного списка — пакетной проверкой для ленты, где недельные
 * строки догружаются по идентификаторам. Ответ множеством, а не массивом: вызывающему нужен
 * вопрос «эта видна?», а не порядок.
 */
export async function readableWeeklyRequestIds(
  p: Principal,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: weeklyVehicleRequests.id })
    .from(weeklyVehicleRequests)
    .where(and(inArray(weeklyVehicleRequests.id, [...ids]), weeklyRequestReadWhereOnTable(p)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Заявки площадок, доступных учётке, — вспомогательное условие для мест, где нужен только объект
 * (например, счётчик «ждут визы» по площадкам). Арендодателю счётчики визы не показываются вовсе:
 * визу он не ставит, а «сколько недель ждёт подписи» — цифра площадки, не его.
 */
export function weeklyRequestObjectScopeWhere(p: Principal): SQL | undefined {
  const scope = weeklyRequestReadScope(p);
  if (scope.kind === 'all') return undefined;
  if (scope.kind === 'objects' && scope.objectIds.length > 0) {
    return inArray(weeklyVehicleRequests.objectId, [...scope.objectIds]);
  }
  return eq(weeklyVehicleRequests.objectId, NEVER_MATCH);
}
