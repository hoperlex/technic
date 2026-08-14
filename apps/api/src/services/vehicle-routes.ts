import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  type DriverDocumentGap,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  moscowDateKeyOf,
  moscowInstantOf,
  moscowTimeOf,
  requestCustomerName,
  type RoutePurpose,
  type RouteTripFields,
  routeCargoLabel,
  routeWaybillForm,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  type VehicleRouteSourceRequestDto,
  type VehicleRouteWaybillDto,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import { driverGapsKey, loadDriverGaps } from './drivers';
import { cleanupRoutePoints } from './route-points';
import { categorySpecsSql } from './vehicle-categories';
import {
  constructionObjects,
  departments,
  freightTransportRequestDetails,
  persons,
  specialEquipmentRequestDetails,
  users,
  vehicleModels,
  vehicleRequests,
  vehicleRequestTrips,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybillRequests,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';

/**
 * Рейс машины на дату (план `docs/vehicle-routes-plan.md`).
 *
 * Здесь всё, что читает и меняет сам рейс: блокировки, состав, позиции строк задания и его DTO.
 * Правила «годится ли заявка» и «можно ли выписать лист» живут в контрактах — их зовёт и форма,
 * и сервер.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающим функциям транзакция не нужна: список и карточку спрашивают вне её. */
type Reader = Tx | typeof db;

export interface RouteRow {
  id: string;
  num: number;
  /** Зачем рейс: грузоперевозка либо перегон техники (миграция 0082). */
  purpose: RoutePurpose;
  /** Заявка-основание перегона; у грузового рейса `null` — его основание это состав. */
  sourceRequestId: string | null;
  moveFrom: string;
  moveTo: string;
  vehicleId: string;
  routeDate: string;
  driverPersonId: string | null;
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  comment: string;
  version: number;
}

const routeColumns = {
  id: vehicleRoutes.id,
  num: vehicleRoutes.num,
  purpose: vehicleRoutes.purpose,
  sourceRequestId: vehicleRoutes.sourceRequestId,
  moveFrom: vehicleRoutes.moveFrom,
  moveTo: vehicleRoutes.moveTo,
  vehicleId: vehicleRoutes.vehicleId,
  routeDate: vehicleRoutes.routeDate,
  driverPersonId: vehicleRoutes.driverPersonId,
  withTrailer: vehicleRoutes.withTrailer,
  trailer1Model: vehicleRoutes.trailer1Model,
  trailer1RegNumber: vehicleRoutes.trailer1RegNumber,
  trailer2Model: vehicleRoutes.trailer2Model,
  trailer2RegNumber: vehicleRoutes.trailer2RegNumber,
  garageNumber: vehicleRoutes.garageNumber,
  communicationKind: vehicleRoutes.communicationKind,
  transportationKind: vehicleRoutes.transportationKind,
  comment: vehicleRoutes.comment,
  version: vehicleRoutes.version,
};

// ── Блокировки и версии ──

/**
 * Строка рейса под `FOR UPDATE`. Состав и выписку листа правят одновременно несколько
 * диспетчеров: без блокировки выписка успевает прочитать состав `[A, B]`, соседний запрос
 * добавляет `C`, и замороженный рейс расходится с напечатанным бланком.
 */
export async function lockRoute(tx: Tx, id: string): Promise<RouteRow> {
  const [row] = await tx
    .select(routeColumns)
    .from(vehicleRoutes)
    .where(eq(vehicleRoutes.id, id))
    .for('update');
  if (!row) throw err.notFound('Маршрут не найден');
  return row;
}

/**
 * Названные рейсы под `FOR UPDATE` — по возрастанию `id` и по одному разу.
 *
 * Порядок один на весь модуль (Р17): любые два рейса берутся в порядке идентификаторов, каким бы
 * ни было их значение для операции — приёмник и источник переноса, рейсы дней линейного заказа,
 * перегон и грузовой рейс одной заявки. Всякий второй порядок на тех же строках — это клинч на
 * первой же встречной команде.
 */
async function lockRouteIds(tx: Tx, ids: readonly string[]): Promise<Map<string, RouteRow>> {
  const locked = new Map<string, RouteRow>();
  for (const id of [...new Set(ids)].sort()) locked.set(id, await lockRoute(tx, id));
  return locked;
}

/**
 * Оба рейса переноса — в порядке возрастания `id`. Порядок стабильный и одинаковый у всех
 * операций: две встречные перестановки иначе встали бы во взаимную блокировку.
 */
export async function lockRoutePair(
  tx: Tx,
  targetId: string,
  sourceId: string | null,
): Promise<{ target: RouteRow; source: RouteRow | null }> {
  if (!sourceId || sourceId === targetId) {
    const target = await lockRoute(tx, targetId);
    return { target, source: sourceId ? target : null };
  }
  const locked = await lockRouteIds(tx, [targetId, sourceId]);
  return { target: locked.get(targetId)!, source: locked.get(sourceId)! };
}

/** Сколько раз связь перечитывается, прежде чем портал признаёт: её переписывают прямо сейчас. */
const LINK_LOCK_ATTEMPTS = 3;

/**
 * Приём Р17 целиком — «прочитать → взять → перечитать» — для всех, кто выясняет рейсы **из связи**.
 *
 * Порядок «маршруты → заявки» объявлен [ADR 0050](../../../../docs/adr/0050-vehicle-routes.md) п. 12,
 * но одного порядка мало: какие именно рейсы брать, известно из `vehicle_route_requests` (или из
 * `source_request_id` перегона), а связь читается **до** блокировки. Между чтением и `FOR UPDATE`
 * заявку успевают вынуть из рейса и положить в соседний — и операция, взявшая рейс по устаревшей
 * связи, правила бы чужой день, а тот, где заявка лежит на самом деле, не тронула бы вовсе.
 *
 * Поэтому: прочитать связь → взять рейсы по возрастанию `id` → **перечитать** связь уже под
 * блокировкой → разошлась, начать заново. Попыток ограниченное число: набор, изменившийся дважды
 * подряд, означает, что план пересобирают прямо сейчас, и третий заход услышал бы то же самое —
 * честнее 409 словами, чем цикл, который под непрерывным перекладыванием не кончится.
 *
 * Отпущенных блокировок между попытками не бывает — они живут до конца транзакции, — поэтому
 * повторный заход добирает только новые рейсы. Это и есть цена приёма: заявку, которую
 * перекладывают в третий раз, портал не догоняет, а останавливает.
 */
async function lockLinkedRoutes<T>(
  tx: Tx,
  link: () => Promise<{ routeIds: readonly string[]; value: T }>,
): Promise<{ locked: Map<string, RouteRow>; value: T }> {
  const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((id, index) => id === b[index]);
  const idsOf = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

  for (let attempt = 0; attempt < LINK_LOCK_ATTEMPTS; attempt += 1) {
    const before = await link();
    const locked = await lockRouteIds(tx, before.routeIds);
    const after = await link();
    if (sameIds(idsOf(before.routeIds), idsOf(after.routeIds))) {
      // Значение возвращается перечитанное: связь под блокировкой и есть настоящая, а первое
      // чтение было только догадкой о том, какие строки брать.
      return { locked, value: after.value };
    }
  }
  throw err.conflict('Маршруты заявки менялись, пока мы их брали, — повторите попытку');
}

/**
 * Строка заявки под `FOR UPDATE` — и только **после** её рейсов (Р17).
 *
 * Живёт рядом с блокировками рейсов, а не в каждой ручке: канонический порядок держится не тем,
 * что где-то написан, а тем, что обе его половины берут из одного места. Разложенные по дверям
 * `SELECT … FOR UPDATE` расходятся с ним при первой же правке — так и вышло у возврата заявки в
 * «Новую», бравшего заявку раньше рейса ([ADR 0050](../../../../docs/adr/0050-vehicle-routes.md)
 * п. 12).
 *
 * Взятая строка запирает и состав: положить заявку в рейс и вынуть её оттуда нельзя, не взяв эту
 * строку, — значит набор рейсов, добытый шагом раньше, до конца транзакции остаётся тем же.
 *
 * Снимок режима отдаётся вызывающему: он читается той же строкой, и второй запрос за ним прочитал
 * бы уже другое значение (Р5).
 */
export async function lockRequestRow(
  tx: Tx,
  requestId: string,
): Promise<{ isLinearFrozen: boolean | null }> {
  const [row] = await tx
    .select({ isLinearFrozen: vehicleRequests.isLinearFrozen })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId))
    .for('update', { of: vehicleRequests });
  if (!row) throw err.notFound('Заявка не найдена');
  return row;
}

/** Версия рейса — оптимистическая блокировка: разошлась, значит рейс уже пересобрали. */
export function assertRouteVersion(row: RouteRow, expected: number): void {
  if (row.version !== expected) {
    throw err.conflict('Маршрут изменился, пока вы его правили — откройте его заново');
  }
}

export async function bumpRouteVersion(tx: Tx, id: string, actorId: string): Promise<number> {
  const [updated] = await tx
    .update(vehicleRoutes)
    .set({
      version: sql`${vehicleRoutes.version} + 1`,
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    .where(eq(vehicleRoutes.id, id))
    .returning({ version: vehicleRoutes.version });
  return updated?.version ?? 0;
}

// ── Путевой лист рейса ──

/**
 * Лист рейса: действующий, а если его нет — последний аннулированный. Порядок задан явно
 * (`issued_for_date DESC, number DESC`), а не оставлен планировщику: по нему карточка решает,
 * заморожен ли рейс, и «какой-нибудь» ответ здесь означал бы то замороженный, то нет.
 */
export async function routeWaybill(
  reader: Reader,
  routeId: string,
): Promise<VehicleRouteWaybillDto | null> {
  const rows = await reader
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      status: waybills.status,
      issuedForDate: waybills.issuedForDate,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(eq(waybills.routeId, routeId))
    .orderBy(
      sql`(${waybills.status} = 'cancelled')`,
      desc(waybills.issuedForDate),
      desc(waybills.number),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
    status: row.status,
    issuedForDate: row.issuedForDate,
  };
}

/** Те же листы пачкой — для списка рейсов: по одному запросу на страницу, а не на строку. */
async function waybillsByRoute(
  reader: Reader,
  routeIds: string[],
): Promise<Map<string, VehicleRouteWaybillDto>> {
  const map = new Map<string, VehicleRouteWaybillDto>();
  if (routeIds.length === 0) return map;
  const rows = await reader
    .select({
      routeId: waybills.routeId,
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      status: waybills.status,
      issuedForDate: waybills.issuedForDate,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(inArray(waybills.routeId, routeIds))
    .orderBy(
      sql`(${waybills.status} = 'cancelled')`,
      desc(waybills.issuedForDate),
      desc(waybills.number),
    );

  for (const row of rows) {
    if (!row.routeId || map.has(row.routeId)) continue;
    map.set(row.routeId, {
      id: row.id,
      number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
      status: row.status,
      issuedForDate: row.issuedForDate,
    });
  }
  return map;
}

/**
 * Номер действующего путевого листа, в котором заявка так или иначе стоит, либо `null`.
 *
 * Спрашивает возврат заявки в «Новую» (`ROLLBACK_WAYBILL_MESSAGE`): такой откат стирает работу —
 * машину, рейс, перегоны, — а стирать её у заявки, попавшей в выданный бланк, нельзя. Заявка
 * снова пошла бы в чей-то рейс, и одна работа оказалась бы сразу в двух действующих документах;
 * ровно эту дыру закрывал ADR 0050.
 *
 * Считаются все три способа попасть в бланк: строкой задания в грузовом рейсе, основанием рейса-перегона
 * (ADR 0057) и листом, выписанным ещё вне маршрутов (`legacyWaybillOf`). Аннулированный лист не
 * держит: испорченный бланк списан, и работа заявки к нему больше не относится.
 *
 * ЭСМ-2 откату не мешает — и это не послабление, а другой документ (миграция 0087). Тот лист
 * привязан к самой заявке, а не к рейсу: второму документу на ту же работу взяться неоткуда, и
 * дыра, которую закрывал ADR 0050, здесь не открывается. Держать откат им значило бы запретить
 * его каждой работающей заявке спецтехники — то есть отменить ADR 0058 для половины заявок.
 * Вместо запрета откат зовёт сверку (`syncEsm2Waybills`): листы аннулируются вместе с работой.
 */
export async function activeWaybillOfRequest(
  reader: Reader,
  requestId: string,
): Promise<string | null> {
  const [row] = await reader
    .select({
      number: waybills.number,
      prefix: waybillSeries.prefix,
      width: waybillSeries.numberWidth,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .innerJoin(vehicleRoutes, eq(vehicleRoutes.id, waybills.routeId))
    .where(
      and(
        ne(waybills.status, 'cancelled'),
        sql`(${vehicleRoutes.sourceRequestId} = ${requestId} OR EXISTS (
          SELECT 1 FROM ${vehicleRouteRequests}
          WHERE ${vehicleRouteRequests.routeId} = ${vehicleRoutes.id}
            AND ${vehicleRouteRequests.requestId} = ${requestId}
        ))`,
      ),
    )
    .limit(1);
  if (row) return waybillDisplayNumber(row.prefix, row.number, row.width);
  return legacyWaybillOf(reader, requestId);
}

/**
 * Действующий лист заявки, выписанный ещё вне маршрутов (`route_id IS NULL`).
 *
 * Пока история не перенесена `backfill:routes`, у работающей заявки такой лист может быть, а
 * новый API его не видит и счёл бы заявку «без маршрута». Положив её в свежий рейс, портал
 * получил бы легаси-лист на отдельном пустом маршруте и заявку в другом — заморозка обходится,
 * бумага расходится с записью. Проверка снимается вместе с contract-миграцией: после неё листов
 * без рейса не существует.
 */
export async function legacyWaybillOf(reader: Reader, requestId: string): Promise<string | null> {
  const [row] = await reader
    .select({
      number: waybills.number,
      prefix: waybillSeries.prefix,
      width: waybillSeries.numberWidth,
    })
    .from(waybillRequests)
    .innerJoin(waybills, eq(waybills.id, waybillRequests.waybillId))
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(
      and(
        eq(waybillRequests.requestId, requestId),
        isNull(waybills.routeId),
        // ЭСМ-2 сюда не считается (миграция 0087). «Лист без рейса» перестало быть приметой
        // неперенесённой истории: у недели работы машины на площадке рейса нет и не бывает.
        // Легаси-листы всегда 4-П — они выписывались до маршрутов, когда других бланков не было.
        ne(waybills.formCode, 'esm2'),
        ne(waybills.status, 'cancelled'),
      ),
    )
    .limit(1);
  return row ? waybillDisplayNumber(row.prefix, row.number, row.width) : null;
}

// ── Состав рейса ──

/**
 * Условие join'а «первая живая ездка заявки» (план `docs/route-trips-plan.md`, Р13а; этап 2).
 *
 * Адреса, количество и контакты уехали с заявки на ездку (Р2), а места, которые показывают заявку
 * ОДНОЙ парой адресов, никуда не делись: строка состава рейса, строка сводки, задание водителю в
 * письме и в кабинете. Пока таких мест больше одного, ответ у них обязан быть один и тот же —
 * иначе карточка маршрута назовёт один адрес, а письмо второй.
 *
 * Бланка среди них больше нет: с этапом 5 задание печатается строками — ездками и линейными днями
 * в порядке объезда (`waybillTaskRows`, Р11), — и первая ездка перестала быть ответом на «что
 * напечатать». Мост держится ради оставшихся мест и уйдёт вместе с ними: карточка заявки получит
 * список ездок (этап 6), задание водителю — точки (этап 7). Поэтому правило и живёт здесь, рядом с
 * составом рейса, а не заводит собственный сервис.
 *
 * Первая живая — наименьший `num` среди неудалённых (Р13а: мягко удалённая ездка не печатается и
 * не показывается, но номер её не переиспользуется, поэтому «первая» это минимум, а не единица).
 * Пока заявка ровно одноездочная (бэкфил 1:1, Р24), это в точности прежнее поле заявки.
 *
 * Коррелированный подзапрос, а не `DISTINCT ON`: условие подставляется в уже существующие запросы
 * (состав, сводка, задание водителю) обычным `leftJoin`, ничего в них не переписывая. Минимум
 * берётся по уникальному `(request_id, num)` — своего индекса ему не нужно.
 */
export const firstLiveTripJoin = and(
  eq(vehicleRequestTrips.requestId, vehicleRequests.id),
  isNull(vehicleRequestTrips.deletedAt),
  sql`${vehicleRequestTrips.num} = (
    SELECT min(first_trip.num) FROM ${vehicleRequestTrips} first_trip
    WHERE first_trip.request_id = ${vehicleRequests.id} AND first_trip.deleted_at IS NULL
  )`,
);

/** Заявки рейсов пачкой, в порядке строк задания. */
export async function requestsByRoute(
  reader: Reader,
  routeIds: string[],
): Promise<Map<string, VehicleRouteRequestDto[]>> {
  const map = new Map<string, VehicleRouteRequestDto[]>();
  if (routeIds.length === 0) return map;
  const rows = await reader
    .select({
      routeId: vehicleRouteRequests.routeId,
      requestId: vehicleRouteRequests.requestId,
      position: vehicleRouteRequests.position,
      // День линейного заказа, ради которого строка стоит в рейсе (ADR 0100, миграция 0127);
      // NULL — грузоперевозка: день несёт сам рейс.
      workDate: vehicleRouteRequests.workDate,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
      // Заказчик — объектом затрат (Р25): решает идентификатор, а не заполненность имени, поэтому
      // из обеих пар выбираются и id, и код, и наименование.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      departmentId: vehicleRequests.departmentId,
      departmentCode: departments.code,
      departmentName: departments.name,
      // Адреса и количество — первой живой ездки (`firstLiveTripJoin`): у строки состава графы под
      // заявку одни, и заявку с двумя ездками она покажет первой из них, пока карточка не научится
      // списку (этап 7).
      tripFrom: vehicleRequestTrips.fromLocation,
      tripTo: vehicleRequestTrips.toLocation,
      // Время подачи осталось у заявки (Р3): им считается день рейса и по нему идут фильтры.
      scheduledAt: freightTransportRequestDetails.scheduledAt,
      timeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
      volumeM3: vehicleRequestTrips.volumeM3,
      weightTons: vehicleRequestTrips.weightTons,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    // Заказчик — объект или отдел (ADR 0040): innerJoin по объекту терял бы заявки отдела.
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .leftJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicleRequestTrips, firstLiveTripJoin)
    .where(inArray(vehicleRouteRequests.routeId, routeIds))
    .orderBy(asc(vehicleRouteRequests.position));

  for (const row of rows) {
    const list = map.get(row.routeId) ?? [];
    list.push({
      requestId: row.requestId,
      displayNumber: formatVehicleRequestNumber(row.num),
      position: row.position,
      workDate: row.workDate,
      status: row.status,
      customerName: requestCustomerName(row),
      // Погрузка, разгрузка и груз есть только у грузоперевозки: у линейного дня вместо них
      // заказчик и сам день — ездок у заказа на объект не существует, и join отдаёт NULL.
      loadingLocation: row.tripFrom ?? '',
      unloadingLocation: row.tripTo ?? '',
      scheduledAt: (row.scheduledAt ?? new Date()).toISOString(),
      scheduledTimeUnspecified: row.timeUnspecified ?? false,
      /*
       * Подпись груза — тем же правилом, которым он печатается в бланке (`routeCargoLabel`), и
       * количество идёт в неё **строкой из базы**, как шло до ездок. Обёртка `tripCargoLabel`
       * здесь не годится: её аргумент — количество ездки в DTO (`number`), а `numeric(12,3)`
       * приходит из базы как «12.000», и приведение к числу молча превратило бы «12.000 м³»
       * карточки в «12 м³». Правило от этого не раздваивается — обёртка и есть вызов
       * `routeCargoLabel`, разница только в форме аргумента.
       *
       * Итог по заявке (`requestCargoTotal`) здесь тоже не считается, и это не экономия: адреса в
       * строке — первой ездки, и «60 м³» рядом с парой адресов, по которой едет 12, было бы
       * враньём. Заявка целиком показывается в своей карточке (этап 6), где есть и список ездок.
       */
      cargoLabel: routeCargoLabel(row.volumeM3, row.weightTons),
    });
    map.set(row.routeId, list);
  }
  return map;
}

/**
 * Заявки-основания перегонов пачкой. У рейса перемещения она стоит вместо состава: талонов
 * заказчиков там не бывает, а знать, ради чего едут, карточке нужно так же.
 */
export async function sourceRequestsByRoute(
  reader: Reader,
  requestIds: string[],
): Promise<Map<string, VehicleRouteSourceRequestDto>> {
  const map = new Map<string, VehicleRouteSourceRequestDto>();
  if (requestIds.length === 0) return map;
  const rows = await reader
    .select({
      requestId: vehicleRequests.id,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
      // Заказчик — объектом затрат (Р25): ветвление идёт по идентификатору, поэтому в выборке обе
      // пары целиком.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      departmentId: vehicleRequests.departmentId,
      departmentCode: departments.code,
      departmentName: departments.name,
    })
    .from(vehicleRequests)
    // Заказчик — объект или отдел (ADR 0040): innerJoin по объекту терял бы заявки отдела.
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .where(inArray(vehicleRequests.id, requestIds));

  for (const row of rows) {
    map.set(row.requestId, {
      requestId: row.requestId,
      displayNumber: formatVehicleRequestNumber(row.num),
      status: row.status,
      customerName: requestCustomerName(row),
    });
  }
  return map;
}

/** Строка состава глазами заявки: в каком рейсе она лежит и каким днём (NULL — грузоперевозка). */
export interface RequestRouteRow {
  routeId: string;
  position: number;
  workDate: string | null;
}

/**
 * Все рейсы заявки — по одной строке состава на рейс.
 *
 * Прежний `routeOfRequest` отвечал одним рейсом и опирался на `UNIQUE (request_id)`, которого с
 * миграции 0127 больше нет: у грузоперевозки рейс по-прежнему один (день несёт сам рейс), а
 * линейный заказ стоит в стольких рейсах, сколько дней распланировано. Оставленная рядом со
 * здешними двумя, та функция молча возвращала бы «первый попавшийся день» — поэтому она удалена, а
 * не переименована.
 *
 * Порядок задан явно — по дню: у грузоперевозки строка одна и вопрос порядка не возникает вовсе, а
 * дни читаются от первого к последнему, как их и показывает карточка. Порядок блокировок отсюда не
 * берётся: рейсы берут по возрастанию `id` (`lockRoutePair`), и вызывающий сортирует сам.
 */
export async function routesOfRequest(tx: Tx, requestId: string): Promise<RequestRouteRow[]> {
  return tx
    .select({
      routeId: vehicleRouteRequests.routeId,
      position: vehicleRouteRequests.position,
      workDate: vehicleRouteRequests.workDate,
    })
    .from(vehicleRouteRequests)
    .where(eq(vehicleRouteRequests.requestId, requestId))
    .orderBy(asc(vehicleRouteRequests.workDate));
}

/**
 * Рейс конкретного дня заявки; `null` — этот день не распланирован.
 *
 * `workDate: null` спрашивает грузоперевозку — ту самую единственную строку без дня, которой
 * заявка и стоит в рейсе: у неё день несёт сам рейс. Оба случая держат свои частичные UNIQUE
 * (миграция 0127), поэтому ответ здесь ровно один и «какого-нибудь» рейса не бывает.
 */
export async function routeOfRequestDay(
  tx: Tx,
  requestId: string,
  workDate: string | null,
): Promise<RequestRouteRow | null> {
  const [row] = await tx
    .select({
      routeId: vehicleRouteRequests.routeId,
      position: vehicleRouteRequests.position,
      workDate: vehicleRouteRequests.workDate,
    })
    .from(vehicleRouteRequests)
    .where(
      and(
        eq(vehicleRouteRequests.requestId, requestId),
        workDate === null
          ? isNull(vehicleRouteRequests.workDate)
          : eq(vehicleRouteRequests.workDate, workDate),
      ),
    );
  return row ?? null;
}

/** Дни заявки, уже стоящие в рейсах, — ими правила отвечают «этот день ещё свободен». */
export async function plannedDaysOfRequest(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ workDate: vehicleRouteRequests.workDate })
    .from(vehicleRouteRequests)
    .where(
      and(eq(vehicleRouteRequests.requestId, requestId), isNotNull(vehicleRouteRequests.workDate)),
    )
    .orderBy(asc(vehicleRouteRequests.workDate));
  return rows.map((row) => row.workDate!);
}

/** Сколько заявок в рейсе — им же считается свободная строка задания. */
export async function routeRequestCount(tx: Tx, routeId: string): Promise<number> {
  const [row] = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(vehicleRouteRequests)
    .where(eq(vehicleRouteRequests.routeId, routeId));
  return row?.c ?? 0;
}

/**
 * Позиции пишутся одним заходом, поэтому их уникальность откладывается до конца транзакции:
 * при перестановке две заявки на мгновение делят номер, и построчная проверка упала бы на первой
 * же строке (ограничение объявлено `DEFERRABLE`, миграция 0072).
 */
async function deferPositions(tx: Tx): Promise<void> {
  await tx.execute(sql`SET CONSTRAINTS vehicle_route_requests_position_unique DEFERRED`);
}

/** Переписывает порядок строк задания целиком — ровно тем составом, который прислали. */
export async function setRouteOrder(tx: Tx, routeId: string, requestIds: string[]): Promise<void> {
  await deferPositions(tx);
  for (const [index, requestId] of requestIds.entries()) {
    const [updated] = await tx
      .update(vehicleRouteRequests)
      .set({ position: index + 1 })
      .where(
        and(
          eq(vehicleRouteRequests.routeId, routeId),
          eq(vehicleRouteRequests.requestId, requestId),
        ),
      )
      .returning({ requestId: vehicleRouteRequests.requestId });
    if (!updated) throw err.unprocessable('В присланном порядке есть заявка не из этого маршрута');
  }
}

/**
 * Уплотняет талоны в 1…N. Заявка выбывает из рейса не только перестановкой — её вынимают руками
 * и снимают отменой, — и дыра в нумерации талонов означала бы пустую графу в бланке.
 */
export async function compactRoutePositions(tx: Tx, routeId: string): Promise<void> {
  const rows = await tx
    .select({ requestId: vehicleRouteRequests.requestId, position: vehicleRouteRequests.position })
    .from(vehicleRouteRequests)
    .where(eq(vehicleRouteRequests.routeId, routeId))
    .orderBy(asc(vehicleRouteRequests.position));
  const misplaced = rows.some((row, index) => row.position !== index + 1);
  if (!misplaced) return;
  await setRouteOrder(
    tx,
    routeId,
    rows.map((row) => row.requestId),
  );
}

/**
 * Вынимает заявку из рейса, уплотняет талоны и убирает опустевшие точки; `null` — её там и не
 * было.
 *
 * Строка ищется парой «рейс + заявка», и второго ответа здесь не бывает даже у линейного заказа:
 * первичный ключ состава — та же пара, а значит в одном рейсе заявка стоит ровно одной строкой.
 * День возвращается ради вызывающего: снятая строка это либо грузовая заявка, либо день линейного
 * заказа, и в журнале эти два события читаются по-разному.
 *
 * Роли снимаются каскадом (`route_point_trips_composition_fk`), а опустевшие точки доудаляет
 * сервис точек (Р13) — здесь, а не в каждой из дверей: заявка выбывает из состава пятью разными
 * путями (изъятие руками, отмена, откат в «Новую», переезд на другую машину, перенос коррекцией), и
 * забытая чистка в любой из них оставила бы в порядке объезда остановку без задания.
 */
export async function detachRequest(
  tx: Tx,
  routeId: string,
  requestId: string,
): Promise<{ workDate: string | null } | null> {
  const [removed] = await tx
    .delete(vehicleRouteRequests)
    .where(
      and(eq(vehicleRouteRequests.routeId, routeId), eq(vehicleRouteRequests.requestId, requestId)),
    )
    .returning({ workDate: vehicleRouteRequests.workDate });
  if (!removed) return null;
  await compactRoutePositions(tx, routeId);
  await cleanupRoutePoints(tx, routeId);
  return { workDate: removed.workDate };
}

/**
 * Перегоны заявки — те же её рейсы, только привязанные колонкой, а не составом.
 *
 * Отдельным запросом, потому что связь у них другая (`source_request_id`, миграция 0082), а
 * блокировать их приходится в одном порядке с рейсами состава: смена статуса берёт и те, и другие
 * (`detachOnStatus`), и два прохода по двум подмножествам одной таблицы — это два порядка на одних
 * строках, ровно то, что Р17 запрещает.
 */
async function relocationRouteIds(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: vehicleRoutes.id })
    .from(vehicleRoutes)
    .where(eq(vehicleRoutes.sourceRequestId, requestId));
  return rows.map((row) => row.id);
}

/**
 * Все рейсы заявки под блокировкой — читая связь заново уже под ней (Р17, `lockLinkedRoutes`).
 *
 * Берутся **все**: строки состава (у грузоперевозки одна, у линейного заказа по одной на день) и
 * перегоны, а сверх них — рейс, названный в теле запроса (`extraRouteIds`): перевод в работу и
 * смена машины кладут заявку в готовый маршрут, и он обязан быть взят тем же проходом, иначе две
 * встречные перестановки «A→B» и «B→A» возьмут одну пару в разных порядках.
 *
 * Возвращаются только рейсы **состава** и в порядке возрастания `id`: правки, которые их зовут,
 * работают со строками задания, а перегону задание собирает своя заявка-основание. Порядок талонов
 * здесь чужой — два порядка на одних строках это клинч на первой же встречной правке.
 */
export async function lockRoutesOfRequest(
  tx: Tx,
  requestId: string,
  extraRouteIds: readonly string[] = [],
): Promise<RouteRow[]> {
  const { locked, value } = await lockLinkedRoutes(tx, async () => {
    const composition = (await routesOfRequest(tx, requestId)).map((row) => row.routeId);
    const relocations = await relocationRouteIds(tx, requestId);
    return {
      routeIds: [...composition, ...relocations, ...extraRouteIds],
      value: [...composition].sort(),
    };
  });
  return value.map((routeId) => locked.get(routeId)!);
}

/**
 * Рейс одного дня заявки под блокировкой — со сверкой связи под ней (Р17, `lockLinkedRoutes`).
 *
 * Тем же приёмом, но по одной строке: снятие дня с рейса знает свой день, а не заявку целиком, и
 * запирать ради него все тридцать дней месячного заказа незачем. `null` — этот день не стоит ни в
 * одном рейсе, и это законный ответ: строка могла исчезнуть, пока её читали.
 */
export async function lockRouteOfRequestDay(
  tx: Tx,
  requestId: string,
  workDate: string,
): Promise<RouteRow | null> {
  const { locked, value } = await lockLinkedRoutes(tx, async () => {
    const row = await routeOfRequestDay(tx, requestId, workDate);
    return { routeIds: row ? [row.routeId] : [], value: row };
  });
  return value ? (locked.get(value.routeId) ?? null) : null;
}

/**
 * Переносит рейс на другой день вместе с его заявками.
 *
 * Дата рейса и дата подачи заявки — одно и то же событие с двух сторон: заявка едет в тот день, в
 * который заведён рейс, и лист печатает задание на него (`canJoinRoute`). Поэтому «перенести
 * рейс» означает перенести и подачу его заявок — иначе рейс уехал бы на завтра, а бумага
 * напечатала бы работу, которой в этот день никто не заказывал, и портал сам себе отказал бы в
 * следующей же правке состава.
 *
 * Время суток остаётся прежним: переносят день, а не час подачи. Заявке «на дату» (без времени)
 * это ничего не меняет — в поле у неё полночь МСК, и она же остаётся.
 *
 * Линейные дни переезжают сами: их день физически равен дню рейса (составной FK с `ON UPDATE
 * CASCADE`, миграция 0127), и `UPDATE` даты рейса переписывает `work_date` за нас. Но каскад
 * способен унести день за срок его заказа или столкнуться с другим рейсом той же заявки на новой
 * дате — и то, и другое здесь спрашивается **до** переноса (`assertLinearDaysMovable`): человек
 * должен прочитать причину, а не 23505 из глубины транзакции.
 *
 * Возвращает номера переехавших заявок: их называют человеку до нажатия и записывают в аудит.
 * Линейные заказы попадают в тот же перечень — «какие заявки уехали вместе с рейсом» вопрос один,
 * и отвечать на него двумя списками незачем.
 */
export async function moveRouteToDate(
  tx: Tx,
  routeId: string,
  routeDate: string,
): Promise<string[]> {
  const movedDays = await assertLinearDaysMovable(tx, routeId, routeDate);
  await tx.update(vehicleRoutes).set({ routeDate }).where(eq(vehicleRoutes.id, routeId));

  const rows = await tx
    .select({
      requestId: vehicleRouteRequests.requestId,
      num: vehicleRequests.num,
      scheduledAt: freightTransportRequestDetails.scheduledAt,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    .innerJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRouteRequests.requestId),
    )
    .where(eq(vehicleRouteRequests.routeId, routeId))
    .orderBy(asc(vehicleRouteRequests.position));

  const moved: string[] = [...movedDays];
  for (const row of rows) {
    if (!row.scheduledAt) continue;
    if (moscowDateKeyOf(row.scheduledAt) === routeDate) continue;
    await tx
      .update(freightTransportRequestDetails)
      .set({ scheduledAt: moscowInstantOf(routeDate, moscowTimeOf(row.scheduledAt)) })
      .where(eq(freightTransportRequestDetails.requestId, row.requestId));
    moved.push(formatVehicleRequestNumber(row.num));
  }
  return moved;
}

/**
 * Уедут ли линейные дни рейса вместе с ним — до того, как рейс тронулся с места.
 *
 * Каскад по составному ключу перепишет `work_date` молча, и упереться он может в две разные вещи
 * (план У2): день уедет за срок своего заказа либо столкнётся с другим рейсом той же заявки на
 * новой дате — там сработает частичный `..._request_day_unique`, и человек получит 23505 вместо
 * ответа. Поэтому оба случая спрашиваются заранее и объясняются словами.
 *
 * Возвращает номера заявок, чьи дни переедут: их называют человеку и пишут в аудит наравне с
 * переехавшей подачей грузовых заявок.
 */
async function assertLinearDaysMovable(
  tx: Tx,
  routeId: string,
  routeDate: string,
): Promise<string[]> {
  const rows = await tx
    .select({
      requestId: vehicleRouteRequests.requestId,
      workDate: vehicleRouteRequests.workDate,
      num: vehicleRequests.num,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      // Рейс той же заявки на новой дате: пустой день там уже занят, и каскад упёрся бы в UNIQUE.
      clashNum: sql<number | null>`(
        SELECT r2.num FROM ${vehicleRouteRequests} rr2
        JOIN ${vehicleRoutes} r2 ON r2.id = rr2.route_id
        WHERE rr2.request_id = ${vehicleRouteRequests.requestId}
          AND rr2.work_date = ${routeDate}
          AND rr2.route_id <> ${routeId}
        LIMIT 1
      )`,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    // Срок заказа — у детали спецтехники; линейный день бывает только у неё (ADR 0100 §1).
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRouteRequests.requestId),
    )
    .where(and(eq(vehicleRouteRequests.routeId, routeId), isNotNull(vehicleRouteRequests.workDate)))
    .orderBy(asc(vehicleRouteRequests.position));

  const moved: string[] = [];
  for (const row of rows) {
    const number = formatVehicleRequestNumber(row.num);
    // Пустой `date_to` — однодневный срок: так его читают все отборы заказа техники на объект.
    const lastDay = row.dateTo || row.dateFrom;
    if (!row.dateFrom || !lastDay || routeDate < row.dateFrom || routeDate > lastDay) {
      throw err.unprocessable(
        `Перенос уводит день заявки ${number} за срок её заказа (${row.dateFrom ?? '—'} — ${lastDay ?? '—'}) — снимите день с рейса или перенесите рейс внутрь срока`,
        { routeDate: 'День уедет за срок заявки' },
      );
    }
    if (row.clashNum !== null) {
      throw err.unprocessable(
        `У заявки ${number} на ${routeDate} уже есть рейс ${formatVehicleRouteNumber(row.clashNum)} — в один день заявка стоит ровно в одном рейсе`,
        { routeDate: 'День заявки занят другим рейсом' },
      );
    }
    moved.push(number);
  }
  return moved;
}

/**
 * Кладёт заявку последним талоном рейса.
 *
 * `workDate` — день линейного заказа, ради которого строка встаёт в рейс (ADR 0100 §2); `null` —
 * грузоперевозка, у которой дня нет вовсе: его несёт сам рейс. Проверять равенство дня и даты
 * рейса здесь незачем — этого не даст база (составной FK, миграция 0127).
 */
export async function attachRequest(
  tx: Tx,
  routeId: string,
  requestId: string,
  workDate: string | null = null,
): Promise<number> {
  const position = (await routeRequestCount(tx, routeId)) + 1;
  await tx.insert(vehicleRouteRequests).values({ routeId, requestId, position, workDate });
  return position;
}

/**
 * Тип и вид машины — ими сверяется заказанное в заявке, когда её назначение переписывается на
 * машину рейса: при переносе в чужой рейс и при коррекции задним числом (ADR 0101, Р2).
 *
 * Вид, а не тип: заявку закрывают и машиной соседнего типа (ADR 0059), и рейс — то место, где это
 * происходит чаще всего: день машины собирают по объектам, а объекты заказывают разное. Тип из
 * ответа идёт в назначение — рейс остаётся источником истины о том, чем едут.
 */
export async function vehicleClassOf(
  reader: Reader,
  vehicleId: string,
): Promise<{ vehicleTypeId: string; kindId: string; typeName: string } | null> {
  const [row] = await reader
    .select({
      vehicleTypeId: vehicles.vehicleTypeId,
      kindId: vehicleTypes.kindId,
      typeName: vehicleTypes.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, vehicleId));
  return row ?? null;
}

// ── Перегон техники ──

/**
 * Завести рейс перемещения по заявке: доставку техники на объект или вывоз с него.
 *
 * Машина не спрашивается — её несёт назначение заявки: «перегнать одну, а работать другой» не
 * состояние, а расхождение. Уникальность «одна доставка и один вывоз на заявку» держит частичный
 * индекс `vehicle_routes_source_request_unique`; здесь она проверяется заранее, чтобы человек
 * получил ответ словами, а не ошибку целостности.
 */
export async function createRelocationRoute(
  tx: Tx,
  params: {
    requestId: string;
    vehicleId: string;
    purpose: Exclude<RoutePurpose, 'freight'>;
    routeDate: string;
    driverPersonId: string | null;
    moveFrom: string;
    moveTo: string;
    trip: RouteTripFields | undefined;
    comment: string;
    actorId: string;
  },
): Promise<{ id: string; num: number }> {
  const [existing] = await tx
    .select({ num: vehicleRoutes.num })
    .from(vehicleRoutes)
    .where(
      and(
        eq(vehicleRoutes.sourceRequestId, params.requestId),
        eq(vehicleRoutes.purpose, params.purpose),
      ),
    );
  if (existing) {
    throw err.conflict(
      `Перегон по этой заявке уже заведён — маршрут ${formatVehicleRouteNumber(existing.num)}`,
    );
  }

  const [created] = await tx
    .insert(vehicleRoutes)
    .values({
      vehicleId: params.vehicleId,
      routeDate: params.routeDate,
      purpose: params.purpose,
      sourceRequestId: params.requestId,
      moveFrom: params.moveFrom,
      moveTo: params.moveTo,
      driverPersonId: params.driverPersonId,
      withTrailer: params.trip?.withTrailer ?? false,
      trailer1Model: params.trip?.trailer1Model ?? '',
      trailer1RegNumber: params.trip?.trailer1RegNumber ?? '',
      trailer2Model: params.trip?.trailer2Model ?? '',
      trailer2RegNumber: params.trip?.trailer2RegNumber ?? '',
      garageNumber: params.trip?.garageNumber ?? '',
      communicationKind: params.trip?.communicationKind ?? '',
      transportationKind: params.trip?.transportationKind ?? '',
      comment: params.comment,
      createdBy: params.actorId,
    })
    .returning({ id: vehicleRoutes.id, num: vehicleRoutes.num });
  return created!;
}

/**
 * Перегоны заявки: доставка и вывоз. Ими карточка заявки решает, предлагать ли завести рейс, и
 * показывает выписанный по нему лист.
 */
export async function relocationRoutesOfRequest(
  reader: Reader,
  requestId: string,
): Promise<VehicleRouteDto[]> {
  const rows = await selectRoutes(reader)
    .where(eq(vehicleRoutes.sourceRequestId, requestId))
    .orderBy(asc(vehicleRoutes.routeDate), asc(vehicleRoutes.num));
  return loadRouteDtos(reader, rows);
}

/**
 * Запланированный перегон при отмене заявки: рейса не будет, и держать его в плане незачем — так
 * же, как отменённая заявка выбывает из состава грузового маршрута (`shouldDetachOnStatus`).
 *
 * Убирается только рейс, по которому не выписывали ни одного листа. Аннулированный лист рейс тоже
 * держит: он ссылается на него из журнала, а журнал помнит и списанные бланки — пропуск в
 * нумерации означал бы утраченный бланк, а не отменённый рейс (ADR 0037 п. 11).
 *
 * Возвращает номера убранных рейсов: они уходят в журнал аудита вместе со сменой статуса.
 */
export async function dropPlannedRelocations(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: vehicleRoutes.id, num: vehicleRoutes.num })
    .from(vehicleRoutes)
    .where(eq(vehicleRoutes.sourceRequestId, requestId))
    // Порядок захвата — по возрастанию `id`, как и у всех рейсов модуля (Р17): перегонов у заявки
    // два (доставка и вывоз), и оставленный планировщику порядок был бы вторым порядком на тех же
    // строках. `LockRows` в плане стоит над `Sort`, поэтому строки берутся именно в этом порядке.
    .orderBy(asc(vehicleRoutes.id))
    .for('update');

  const dropped: string[] = [];
  for (const row of rows) {
    const [documented] = await tx
      .select({ id: waybills.id })
      .from(waybills)
      .where(eq(waybills.routeId, row.id))
      .limit(1);
    if (documented) continue;
    await tx.delete(vehicleRoutes).where(eq(vehicleRoutes.id, row.id));
    dropped.push(formatVehicleRouteNumber(row.num));
  }
  return dropped;
}

// ── Реквизиты прошлого рейса ──

/**
 * Чем были заполнены графы шапки в прошлый раз: гаражный номер, вид сообщения, прицепы. От рейса
 * к рейсу они те же, и перенабирать их каждый раз незачем — форма подставляет их в новый рейс.
 */
export async function lastTripFields(vehicleId: string): Promise<RouteTripFields | null> {
  const [row] = await db
    .select({
      withTrailer: vehicleRoutes.withTrailer,
      trailer1Model: vehicleRoutes.trailer1Model,
      trailer1RegNumber: vehicleRoutes.trailer1RegNumber,
      trailer2Model: vehicleRoutes.trailer2Model,
      trailer2RegNumber: vehicleRoutes.trailer2RegNumber,
      garageNumber: vehicleRoutes.garageNumber,
      communicationKind: vehicleRoutes.communicationKind,
      transportationKind: vehicleRoutes.transportationKind,
    })
    .from(vehicleRoutes)
    .where(eq(vehicleRoutes.vehicleId, vehicleId))
    .orderBy(desc(vehicleRoutes.routeDate), desc(vehicleRoutes.num))
    .limit(1);
  return row ?? null;
}

// ── DTO ──

type ListRow = Awaited<ReturnType<typeof selectRoutes>>[number];

function selectRoutes(reader: Reader) {
  return reader
    .select({
      ...routeColumns,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
      // Бланк рейса считается правилом из контрактов (`routeWaybillForm`): у грузового его
      // выбирает тип машины, у перегона он всегда 4-П. Отсюда и принадлежность — на арендную
      // технику лист выписывает арендодатель.
      ownership: vehicles.ownership,
      typeFormCode: vehicleTypes.waybillFormCode,
      vehicleKindId: vehicleTypes.kindId,
      vehicleTypeId: vehicles.vehicleTypeId,
      typeName: vehicleTypes.name,
      // Вид, категория машины рейса и её ТТХ: ими карточка заявки сверяет заказ с тем, чем рейс
      // поедет (ADR 0059, ADR 0064) — подсказка рейсов не сужена ни типом, ни видом, она помечает
      // каждый рейс и этим же порядком стоит.
      vehicleCategoryId: vehicles.vehicleCategoryId,
      vehicleCategorySpecs: categorySpecsSql(vehicles.vehicleCategoryId),
      driverName: persons.fullName,
      driverSnils: persons.snils,
      createdByName: users.fullName,
      createdAt: vehicleRoutes.createdAt,
    })
    .from(vehicleRoutes)
    .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
    .innerJoin(users, eq(users.id, vehicleRoutes.createdBy));
}

export function routeQuery(reader: Reader) {
  return selectRoutes(reader);
}

export function toRouteDto(
  row: ListRow,
  requests: VehicleRouteRequestDto[],
  waybill: VehicleRouteWaybillDto | null,
  sourceRequest: VehicleRouteSourceRequestDto | null = null,
  /** Пробелы документов водителя на дату рейса (ADR 0064); считает их вызывающий — пачкой. */
  driverGaps: DriverDocumentGap[] = [],
): VehicleRouteDto {
  return {
    id: row.id,
    displayNumber: formatVehicleRouteNumber(row.num),
    purpose: row.purpose,
    formCode: routeWaybillForm({
      purpose: row.purpose,
      ownership: row.ownership,
      formCode: row.typeFormCode,
    }).formCode,
    routeDate: row.routeDate,
    vehicleId: row.vehicleId,
    vehicleLabel: [row.modelName, row.registrationNumber].filter(Boolean).join(' · '),
    vehicleKindId: row.vehicleKindId,
    vehicleTypeId: row.vehicleTypeId,
    vehicleTypeName: row.typeName,
    vehicleCategoryId: row.vehicleCategoryId,
    vehicleCategorySpecs: row.vehicleCategorySpecs,
    driverPersonId: row.driverPersonId,
    driverName: row.driverName ?? '',
    driverGaps,
    withTrailer: row.withTrailer,
    trailerLabel: [row.trailer1Model, row.trailer1RegNumber].filter(Boolean).join(' '),
    trailer1Model: row.trailer1Model,
    trailer1RegNumber: row.trailer1RegNumber,
    trailer2Model: row.trailer2Model,
    trailer2RegNumber: row.trailer2RegNumber,
    garageNumber: row.garageNumber,
    communicationKind: row.communicationKind,
    transportationKind: row.transportationKind,
    comment: row.comment,
    requests,
    sourceRequest,
    moveFrom: row.moveFrom,
    moveTo: row.moveTo,
    waybill,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

/**
 * Пробелы документов водителей этих рейсов — одним запросом на всю страницу (ADR 0064). Рейсы без
 * водителя в счёт не идут: предупреждать не о ком, а карточка и без того скажет «не назначен».
 */
function driverGapsOf(reader: Reader, rows: ListRow[]): Promise<Map<string, DriverDocumentGap[]>> {
  return loadDriverGaps(
    reader,
    rows.flatMap((row) =>
      row.driverPersonId
        ? [{ personId: row.driverPersonId, snils: row.driverSnils ?? '', on: row.routeDate }]
        : [],
    ),
  );
}

/** Пробелы этого рейса из общей карты: без водителя их нет. */
function gapsOfRow(gaps: Map<string, DriverDocumentGap[]>, row: ListRow): DriverDocumentGap[] {
  if (!row.driverPersonId) return [];
  return gaps.get(driverGapsKey(row.driverPersonId, row.routeDate)) ?? [];
}

/** Карточка рейса целиком: состав и лист добираются отдельными запросами, как в журнале листов. */
export async function loadRouteDto(reader: Reader, id: string): Promise<VehicleRouteDto | null> {
  const [row] = await selectRoutes(reader).where(eq(vehicleRoutes.id, id));
  if (!row) return null;
  const [requests, waybill, sources, gaps] = await Promise.all([
    requestsByRoute(reader, [id]),
    routeWaybill(reader, id),
    sourceRequestsByRoute(reader, row.sourceRequestId ? [row.sourceRequestId] : []),
    driverGapsOf(reader, [row]),
  ]);
  return toRouteDto(
    row,
    requests.get(id) ?? [],
    waybill,
    row.sourceRequestId ? (sources.get(row.sourceRequestId) ?? null) : null,
    gapsOfRow(gaps, row),
  );
}

export async function loadRouteDtos(reader: Reader, rows: ListRow[]): Promise<VehicleRouteDto[]> {
  const ids = rows.map((row) => row.id);
  const [requests, waybillMap, sources, gaps] = await Promise.all([
    requestsByRoute(reader, ids),
    waybillsByRoute(reader, ids),
    sourceRequestsByRoute(
      reader,
      rows.flatMap((row) => (row.sourceRequestId ? [row.sourceRequestId] : [])),
    ),
    driverGapsOf(reader, rows),
  ]);
  return rows.map((row) =>
    toRouteDto(
      row,
      requests.get(row.id) ?? [],
      waybillMap.get(row.id) ?? null,
      row.sourceRequestId ? (sources.get(row.sourceRequestId) ?? null) : null,
      gapsOfRow(gaps, row),
    ),
  );
}
