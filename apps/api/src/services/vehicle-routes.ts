import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  type DriverDocumentGap,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
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
import { categorySpecsSql } from './vehicle-categories';
import {
  constructionObjects,
  departments,
  freightTransportRequestDetails,
  persons,
  users,
  vehicleModels,
  vehicleRequests,
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
 * Здесь всё, что читает и меняет сам рейс: блокировки, состав, позиции талонов и его DTO.
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
  const [first, second] = [targetId, sourceId].sort();
  const locked = new Map<string, RouteRow>();
  locked.set(first!, await lockRoute(tx, first!));
  locked.set(second!, await lockRoute(tx, second!));
  return { target: locked.get(targetId)!, source: locked.get(sourceId)! };
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
 * Считаются все три способа попасть в бланк: талоном в грузовом рейсе, основанием рейса-перегона
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

/** Заявки рейсов пачкой, в порядке талонов. */
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
      num: vehicleRequests.num,
      status: vehicleRequests.status,
      objectName: constructionObjects.name,
      departmentName: departments.name,
      loadingLocation: freightTransportRequestDetails.loadingLocation,
      unloadingLocation: freightTransportRequestDetails.unloadingLocation,
      scheduledAt: freightTransportRequestDetails.scheduledAt,
      timeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
      volumeM3: freightTransportRequestDetails.volumeM3,
      weightTons: freightTransportRequestDetails.weightTons,
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
    .where(inArray(vehicleRouteRequests.routeId, routeIds))
    .orderBy(asc(vehicleRouteRequests.position));

  for (const row of rows) {
    const list = map.get(row.routeId) ?? [];
    list.push({
      requestId: row.requestId,
      displayNumber: formatVehicleRequestNumber(row.num),
      position: row.position,
      status: row.status,
      customerName: requestCustomerName(row),
      loadingLocation: row.loadingLocation ?? '',
      unloadingLocation: row.unloadingLocation ?? '',
      scheduledAt: (row.scheduledAt ?? new Date()).toISOString(),
      scheduledTimeUnspecified: row.timeUnspecified ?? false,
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
      objectName: constructionObjects.name,
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

/** В каком рейсе сейчас заявка; `null` — ни в каком (её вынули или ещё не клали). */
export async function routeOfRequest(
  tx: Tx,
  requestId: string,
): Promise<{ routeId: string; position: number } | null> {
  const [row] = await tx
    .select({ routeId: vehicleRouteRequests.routeId, position: vehicleRouteRequests.position })
    .from(vehicleRouteRequests)
    .where(eq(vehicleRouteRequests.requestId, requestId));
  return row ?? null;
}

/** Сколько заявок в рейсе — им же считается свободный талон. */
export async function routeRequestCount(tx: Tx, routeId: string): Promise<number> {
  const [row] = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(vehicleRouteRequests)
    .where(eq(vehicleRouteRequests.routeId, routeId));
  return row?.c ?? 0;
}

/**
 * Позиции пишутся одним заходом, поэтому уникальность талонов откладывается до конца транзакции:
 * при перестановке две заявки на мгновение делят номер, и построчная проверка упала бы на первой
 * же строке (ограничение объявлено `DEFERRABLE`, миграция 0072).
 */
async function deferPositions(tx: Tx): Promise<void> {
  await tx.execute(sql`SET CONSTRAINTS vehicle_route_requests_position_unique DEFERRED`);
}

/** Переписывает порядок талонов целиком — ровно тем составом, который прислали. */
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

/** Вынимает заявку из рейса и уплотняет талоны; `false` — её там и не было. */
export async function detachRequest(tx: Tx, routeId: string, requestId: string): Promise<boolean> {
  const [removed] = await tx
    .delete(vehicleRouteRequests)
    .where(
      and(eq(vehicleRouteRequests.routeId, routeId), eq(vehicleRouteRequests.requestId, requestId)),
    )
    .returning({ requestId: vehicleRouteRequests.requestId });
  if (!removed) return false;
  await compactRoutePositions(tx, routeId);
  return true;
}

/** Кладёт заявку последним талоном рейса. */
export async function attachRequest(tx: Tx, routeId: string, requestId: string): Promise<number> {
  const position = (await routeRequestCount(tx, routeId)) + 1;
  await tx.insert(vehicleRouteRequests).values({ routeId, requestId, position });
  return position;
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
      typeName: row.typeName,
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
