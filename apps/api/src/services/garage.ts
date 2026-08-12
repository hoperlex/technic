import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  type GarageBusyEntry,
  type GarageBusyRequest,
  type GarageDriverState,
  type GarageEsm2Busy,
  type GarageRouteBusy,
  type GarageSpecialBusy,
  type GarageVehicleState,
  requestCustomerName,
  type RequestStatus,
  vehicleLabel,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  persons,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequestEarlyEndings,
  vehicleRequests,
  vehicleRequestShifts,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../db/schema';

/**
 * Занятость дня: чем заняты машина и человек на выбранную дату (ADR 0076).
 *
 * Своих таблиц у гаража нет — он собирает день из четырёх источников, каждый из которых уже
 * отвечает на свой вопрос в своём модуле. Здесь они сведены к общей форме `GarageBusyEntry`, и вся
 * работа сервиса — два вида запросов:
 *
 * - **выражения состояния** (`vehicleStateSql`, `driverStateSql`) — по ним идут колонка, фильтр,
 *   сортировка и сводка. Одно выражение на четыре применения: разложи его по четырём местам, и
 *   фильтр «свободна» однажды покажет строку, в колонке которой написано «в рейсе»;
 * - **добор занятостей** по найденной странице — отдельными запросами со склейкой в памяти,
 *   приёмом `licensesByPerson` и `loadRouteDtos`. Join'ить их к списку значило бы размножить
 *   строки: у машины бывает и два рейса за день, и рейс вместе с заказом.
 */

// Заказанный тип заявки (ADR 0100 §1) — своим алиасом: в запросах гаража `vehicle_types` уже
// присоединён как тип **машины**, которым собирается её подпись, а линейность спрашивают у заказа.
const orderedTypes = alias(vehicleTypes, 'ordered_types');

// ── Условия занятости ──

/**
 * Заказ спецтехники, накрывающий день: машина стоит на площадке, пока идёт срок заявки.
 *
 * Условия те же, что у вкладки «На объекте» (ADR 0036): взятая в работу живая заявка, чей период
 * накрывает день, а пустая дата окончания читается как однодневный срок — `coalesce(date_to,
 * date_from)`. Разойдись эти два места, гараж и «На объекте» отвечали бы про разные дни одной
 * машины.
 *
 * Линейный заказ (ADR 0100 §12) сюда не попадает вовсе, и это не сужение, а исправление неправды:
 * его машина вечером возвращается на базу, и «занята весь срок» было бы враньём дважды — за
 * назначенную единицу, которая свободна двадцать девять дней из тридцати, и за ту, что реально
 * поехала во вторник и занятости не получала. Занятость дня линейного заказа говорит его рейс
 * (`routeBusyExists`), и говорит он правду про обе машины сразу. Признак читается у **заказанного**
 * типа (ADR 0100 §1): режим заявки решает заказ, а не то, какую единицу под него нашли.
 */
function specialBusyExists(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${vehicleRequestAssignments} ga_a
    JOIN ${vehicleRequests} ga_r ON ga_r.id = ga_a.request_id
    JOIN ${vehicleTypes} ga_vt ON ga_vt.id = ga_r.vehicle_type_id
    JOIN ${specialEquipmentRequestDetails} ga_d ON ga_d.request_id = ga_r.id
    WHERE ga_a.vehicle_id = ${vehicles.id}
      AND ga_r.status = 'confirmed'
      AND ga_r.deleted_at IS NULL
      AND NOT ga_vt.is_linear
      AND ga_d.date_from <= ${on}::date
      AND coalesce(ga_d.date_to, ga_d.date_from) >= ${on}::date
  )`;
}

/**
 * Действующий недельный лист ЭСМ-2 на этот день (ADR 0060).
 *
 * Считается наравне с заказом, а не как приписка к нему: заявку могли закрыть или откатить, а
 * бланк недели остаётся у машиниста — по документу машина занята, и портал обязан это показывать.
 */
function esm2BusyExists(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${waybills} ga_w
    WHERE ga_w.vehicle_id = ${vehicles.id}
      AND ga_w.form_code = 'esm2'
      AND ga_w.status <> 'cancelled'
      AND ga_w.period_from <= ${on}::date
      AND ga_w.period_to >= ${on}::date
  )`;
}

/** Рейс этой машины в этот день — любой, включая перегон: техника всё равно в пути. */
function routeBusyExists(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${vehicleRoutes} ga_rt
    WHERE ga_rt.vehicle_id = ${vehicles.id} AND ga_rt.route_date = ${on}::date
  )`;
}

/**
 * Состояние машины на день — старшинством сверху вниз (ADR 0076).
 *
 * Недоступность идёт первой и перекрывает работу: рейс на машину в ремонте завести можно (его
 * заводят заранее, а ломается машина потом), и такая строка обязана называть главное — что машина
 * не поедет. Объект старше рейса: заказ спецтехники держит машину весь срок, а перегон в тот же
 * день лишь довозит её туда и обратно.
 *
 * У линейного заказа старшинство не спорит с этим правилом, а следует из него: его машина на
 * площадке не стоит, и день у неё именно рейсовый — «в рейсе» (ADR 0100 §12). Что за этим рейсом
 * стоит заказ на объект, а не груз, видно в самой занятости — днём в строке состава
 * (`GarageBusyRequest.workDate`).
 */
export function vehicleStateSql(on: string) {
  return sql<GarageVehicleState>`CASE
    WHEN ${vehicles.status} <> 'active' THEN 'unavailable'
    WHEN ${specialBusyExists(on)} OR ${esm2BusyExists(on)} THEN 'on_site'
    WHEN ${routeBusyExists(on)} THEN 'on_route'
    ELSE 'free'
  END`;
}

/** Рейс, в котором человек стоит водителем на этот день. */
function driverRouteExists(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${vehicleRoutes} ga_rt
    WHERE ga_rt.driver_person_id = ${persons.id} AND ga_rt.route_date = ${on}::date
  )`;
}

/**
 * Действующий лист, выписанный на этого человека в этот день: у 4-П и формы № 3 день листа —
 * `issued_for_date`, у ЭСМ-2 — вся неделя работы (`period_from..period_to`).
 *
 * Лист спрашивается отдельно от рейса, хотя обычно едет вместе с ним: у ЭСМ-2 рейса нет вовсе
 * (миграция 0087), и без этого условия машинист на недельном листе числился бы свободным.
 */
function driverWaybillExists(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${waybills} ga_w
    WHERE ga_w.driver_person_id = ${persons.id}
      AND ga_w.status <> 'cancelled'
      AND (
        (ga_w.form_code = 'esm2'
          AND ga_w.period_from <= ${on}::date AND ga_w.period_to >= ${on}::date)
        OR (ga_w.form_code <> 'esm2' AND ga_w.issued_for_date = ${on}::date)
      )
  )`;
}

export function driverStateSql(on: string) {
  return sql<GarageDriverState>`CASE
    WHEN ${driverRouteExists(on)} OR ${driverWaybillExists(on)} THEN 'assigned'
    ELSE 'free'
  END`;
}

// ── Добор занятостей ──

/**
 * Реквизиты, из которых складывается подпись машины (`vehicleLabel`): правило одно на портал и
 * сервер, и каждый запрос занятости выбирает их одним и тем же набором колонок.
 */
const vehicleLabelColumns = {
  ownership: vehicles.ownership,
  description: vehicles.description,
  categoryName: vehicleCategories.name,
  typeName: vehicleTypes.name,
  registrationNumber: vehicles.registrationNumber,
  modelName: vehicleModels.name,
};

/** Заявка глазами гаража: номер, состояние и заказчик — по ним отсюда и переходят в заявку. */
function busyRequest(row: {
  requestId: string;
  num: number;
  status: RequestStatus;
  objectName: string | null;
  departmentName: string | null;
  /**
   * День линейного заказа, ради которого строка стоит в рейсе (ADR 0100 §2). Заполнен он только у
   * состава — заявка-основание перегона и недельного листа дня не несёт, и `null` там честный
   * ответ, а не пробел.
   */
  workDate?: string | null;
}): GarageBusyRequest {
  return {
    requestId: row.requestId,
    displayNumber: formatVehicleRequestNumber(row.num),
    status: row.status,
    customerName: requestCustomerName(row),
    workDate: row.workDate ?? null,
  };
}

/** Заявка-основание рейса-перегона и недельного листа: её может не быть — тогда `null`. */
function sourceRequestOf(row: {
  sourceRequestId: string | null;
  sourceNum: number | null;
  sourceStatus: RequestStatus | null;
  sourceObjectName: string | null;
  sourceDepartmentName: string | null;
}): GarageBusyRequest | null {
  if (!row.sourceRequestId || row.sourceNum == null || !row.sourceStatus) return null;
  return busyRequest({
    requestId: row.sourceRequestId,
    num: row.sourceNum,
    status: row.sourceStatus,
    objectName: row.sourceObjectName,
    departmentName: row.sourceDepartmentName,
  });
}

/**
 * Чьи занятости спрашивают: машин страницы «Техники» либо людей страницы «Водителей». Ровно один
 * из наборов непуст — вкладки спрашивают одни и те же рейсы, различаясь только отбором.
 */
interface BusyScope {
  vehicleIds: string[];
  driverIds: string[];
}

async function loadRoutes(on: string, scope: BusyScope): Promise<GarageRouteBusy[]> {
  const where = or(
    scope.vehicleIds.length > 0 ? inArray(vehicleRoutes.vehicleId, scope.vehicleIds) : undefined,
    scope.driverIds.length > 0 ? inArray(vehicleRoutes.driverPersonId, scope.driverIds) : undefined,
  );
  if (!where) return [];

  const rows = await db
    .select({
      id: vehicleRoutes.id,
      num: vehicleRoutes.num,
      purpose: vehicleRoutes.purpose,
      moveFrom: vehicleRoutes.moveFrom,
      moveTo: vehicleRoutes.moveTo,
      vehicleId: vehicleRoutes.vehicleId,
      driverPersonId: vehicleRoutes.driverPersonId,
      driverName: persons.fullName,
      sourceRequestId: vehicleRoutes.sourceRequestId,
      sourceNum: vehicleRequests.num,
      sourceStatus: vehicleRequests.status,
      sourceObjectName: constructionObjects.name,
      sourceDepartmentName: departments.name,
      ...vehicleLabelColumns,
    })
    .from(vehicleRoutes)
    .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
    .leftJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRoutes.sourceRequestId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .where(and(eq(vehicleRoutes.routeDate, on), where))
    .orderBy(vehicleRoutes.num);

  const routeIds = rows.map((r) => r.id);
  const [requests, routeWaybills] = await Promise.all([
    loadRouteRequests(routeIds),
    loadRouteWaybills(routeIds),
  ]);

  return rows.map((r) => ({
    kind: 'route' as const,
    routeId: r.id,
    displayNumber: formatVehicleRouteNumber(r.num),
    purpose: r.purpose,
    vehicleId: r.vehicleId,
    vehicleLabel: vehicleLabel(r),
    driverPersonId: r.driverPersonId,
    driverName: r.driverName ?? '',
    requests: requests.get(r.id) ?? [],
    moveFrom: r.moveFrom,
    moveTo: r.moveTo,
    sourceRequest: sourceRequestOf(r),
    waybill: routeWaybills.get(r.id) ?? null,
  }));
}

/**
 * Состав рейсов страницы — одним запросом на всех, в порядке строк задания.
 *
 * Строки линейных дней отбираются наравне с грузовыми и без всякого условия: день линейного заказа
 * и есть работа машины в этот день (ADR 0100 §2), и убрать его из состава значило бы показать
 * пустой рейс там, где машина отработала смену на площадке. Отличает его в выдаче свой день
 * (`workDate`) — по нему строка и читается как «работа на объекте по ТС-N», а не как перевозка.
 */
async function loadRouteRequests(routeIds: string[]): Promise<Map<string, GarageBusyRequest[]>> {
  const map = new Map<string, GarageBusyRequest[]>();
  if (routeIds.length === 0) return map;

  const rows = await db
    .select({
      routeId: vehicleRouteRequests.routeId,
      requestId: vehicleRouteRequests.requestId,
      workDate: vehicleRouteRequests.workDate,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
      objectName: constructionObjects.name,
      departmentName: departments.name,
    })
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .where(inArray(vehicleRouteRequests.routeId, routeIds))
    .orderBy(vehicleRouteRequests.position);

  for (const row of rows) {
    const list = map.get(row.routeId) ?? [];
    list.push(busyRequest(row));
    map.set(row.routeId, list);
  }
  return map;
}

/**
 * Действующие листы рейсов. Аннулированный не показывается: бланк списан, и для дня машины это то
 * же самое, что лист не выписывали, — а строка «аннулирован» читалась бы как «документ есть».
 */
async function loadRouteWaybills(
  routeIds: string[],
): Promise<Map<string, GarageRouteBusy['waybill']>> {
  const map = new Map<string, GarageRouteBusy['waybill']>();
  if (routeIds.length === 0) return map;

  const rows = await db
    .select({
      routeId: waybills.routeId,
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      status: waybills.status,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(and(inArray(waybills.routeId, routeIds), ne(waybills.status, 'cancelled')));

  for (const row of rows) {
    if (!row.routeId) continue;
    map.set(row.routeId, {
      waybillId: row.id,
      number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
      status: row.status,
    });
  }
  return map;
}

/**
 * Заказы спецтехники, накрывающие день. Вместе с ними — смена этого дня и запрошенный досрочный
 * отъезд: и то и другое относится к сегодняшнему состоянию машины на площадке, а не к заявке
 * вообще, и вторым заходом из портала это был бы запрос на каждую строку.
 *
 * Линейные заказы отсюда исключены тем же условием, каким они исключены из состояния дня
 * (`specialBusyExists`): два места считают одну и ту же занятость, и разойдись они — колонка
 * сказала бы «в рейсе», а строка под ней показала бы стоянку на площадке до конца месяца.
 */
async function loadSpecials(on: string, vehicleIds: string[]): Promise<GarageSpecialBusy[]> {
  if (vehicleIds.length === 0) return [];

  const rows = await db
    .select({
      requestId: vehicleRequests.id,
      num: vehicleRequests.num,
      status: vehicleRequests.status,
      objectName: constructionObjects.name,
      departmentName: departments.name,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      vehicleId: vehicleRequestAssignments.vehicleId,
      // Строка смены появляется при первом заполнении, а не заготавливается на весь срок
      // (миграция 0086): её наличие и означает «день заполнен».
      shiftFilled: sql<boolean>`${vehicleRequestShifts.requestId} IS NOT NULL`,
      shiftApproved: sql<boolean>`${vehicleRequestShifts.approvedAt} IS NOT NULL`,
      earlyEndPending: sql<boolean>`coalesce(${vehicleRequestEarlyEndings.status} = 'pending', false)`,
      ...vehicleLabelColumns,
    })
    .from(vehicleRequestAssignments)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRequestAssignments.requestId))
    // Заказанный тип — своим алиасом: `vehicleTypes` в этом запросе уже занят типом назначенной
    // машины (подпись строки), а признак линейности спрашивают у заказа (ADR 0100 §1).
    .innerJoin(orderedTypes, eq(orderedTypes.id, vehicleRequests.vehicleTypeId))
    .innerJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .innerJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .leftJoin(
      vehicleRequestShifts,
      and(
        eq(vehicleRequestShifts.requestId, vehicleRequests.id),
        eq(vehicleRequestShifts.shiftDate, on),
      ),
    )
    .leftJoin(
      vehicleRequestEarlyEndings,
      eq(vehicleRequestEarlyEndings.requestId, vehicleRequests.id),
    )
    .where(
      and(
        inArray(vehicleRequestAssignments.vehicleId, vehicleIds),
        eq(vehicleRequests.status, 'confirmed'),
        isNull(vehicleRequests.deletedAt),
        eq(orderedTypes.isLinear, false),
        sql`${specialEquipmentRequestDetails.dateFrom} <= ${on}::date`,
        sql`coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom}) >= ${on}::date`,
      ),
    )
    .orderBy(vehicleRequests.num);

  return rows.map((r) => ({
    kind: 'special' as const,
    requestId: r.requestId,
    displayNumber: formatVehicleRequestNumber(r.num),
    status: r.status,
    customerName: requestCustomerName(r),
    dateFrom: r.dateFrom,
    dateTo: r.dateTo,
    vehicleId: r.vehicleId,
    vehicleLabel: vehicleLabel(r),
    shift: r.shiftFilled ? { filled: true, approved: r.shiftApproved } : null,
    earlyEndPending: r.earlyEndPending,
  }));
}

/** Действующие недельные листы ЭСМ-2, накрывающие день, — по машинам и по машинистам. */
async function loadEsm2(on: string, scope: BusyScope): Promise<GarageEsm2Busy[]> {
  const where = or(
    scope.vehicleIds.length > 0 ? inArray(waybills.vehicleId, scope.vehicleIds) : undefined,
    scope.driverIds.length > 0 ? inArray(waybills.driverPersonId, scope.driverIds) : undefined,
  );
  if (!where) return [];

  const rows = await db
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      status: waybills.status,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      vehicleId: waybills.vehicleId,
      driverPersonId: waybills.driverPersonId,
      driverName: persons.fullName,
      sourceRequestId: waybills.sourceRequestId,
      sourceNum: vehicleRequests.num,
      sourceStatus: vehicleRequests.status,
      sourceObjectName: constructionObjects.name,
      sourceDepartmentName: departments.name,
      ...vehicleLabelColumns,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .innerJoin(vehicles, eq(vehicles.id, waybills.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(persons, eq(persons.id, waybills.driverPersonId))
    .leftJoin(vehicleRequests, eq(vehicleRequests.id, waybills.sourceRequestId))
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .where(
      and(
        eq(waybills.formCode, 'esm2'),
        ne(waybills.status, 'cancelled'),
        sql`${waybills.periodFrom} <= ${on}::date`,
        sql`${waybills.periodTo} >= ${on}::date`,
        where,
      ),
    )
    .orderBy(waybills.number);

  return rows.map((r) => ({
    kind: 'esm2' as const,
    waybillId: r.id,
    number: waybillDisplayNumber(r.prefix, r.number, r.numberWidth),
    status: r.status,
    // Период у листа ЭСМ-2 заполнен всегда (`waybills_form_source_check`) — пустая строка здесь
    // недостижима и стоит только ради типа.
    periodFrom: r.periodFrom ?? '',
    periodTo: r.periodTo ?? '',
    vehicleId: r.vehicleId,
    vehicleLabel: vehicleLabel(r),
    driverPersonId: r.driverPersonId,
    driverName: r.driverName ?? '',
    sourceRequest: sourceRequestOf(r),
  }));
}

/**
 * Занятости машин страницы: заказы, рейсы и недельные листы — в одной корзине на машину.
 *
 * Порядок внутри строки задан сборкой: сначала работа на площадке, потом рейсы, потом документ
 * недели. Так строка читается сверху вниз от главного — того же, что назвало состояние.
 */
export async function loadVehicleBusy(
  on: string,
  vehicleIds: string[],
): Promise<Map<string, GarageBusyEntry[]>> {
  const map = new Map<string, GarageBusyEntry[]>();
  if (vehicleIds.length === 0) return map;

  const scope: BusyScope = { vehicleIds, driverIds: [] };
  const [specials, routes, esm2] = await Promise.all([
    loadSpecials(on, vehicleIds),
    loadRoutes(on, scope),
    loadEsm2(on, scope),
  ]);

  for (const entry of [...specials, ...routes, ...esm2] as GarageBusyEntry[]) {
    const list = map.get(entry.vehicleId) ?? [];
    list.push(entry);
    map.set(entry.vehicleId, list);
  }
  return map;
}

/**
 * Занятости водителей страницы: рейс, в котором человек за рулём, и недельный лист, выписанный на
 * него. Заказ спецтехники сюда не попадает намеренно — заявка называет машину, а не человека
 * (водитель переехал в рейс миграцией 0074), и приписывать людям чужую занятость нечем.
 */
export async function loadDriverBusy(
  on: string,
  driverIds: string[],
): Promise<Map<string, GarageBusyEntry[]>> {
  const map = new Map<string, GarageBusyEntry[]>();
  if (driverIds.length === 0) return map;

  const scope: BusyScope = { vehicleIds: [], driverIds };
  const [routes, esm2] = await Promise.all([loadRoutes(on, scope), loadEsm2(on, scope)]);

  for (const entry of [...routes, ...esm2]) {
    if (!entry.driverPersonId) continue;
    const list = map.get(entry.driverPersonId) ?? [];
    list.push(entry);
    map.set(entry.driverPersonId, list);
  }
  return map;
}

/**
 * Кто сегодня за рулём этой машины — из её же занятостей, без повторного запроса. Один человек
 * может стоять и в рейсе, и в недельном листе: строка называет его один раз.
 */
export function driversOfBusy(
  entries: readonly GarageBusyEntry[],
): { personId: string; fullName: string }[] {
  const byId = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === 'special') continue;
    if (entry.driverPersonId) byId.set(entry.driverPersonId, entry.driverName);
  }
  return [...byId].map(([personId, fullName]) => ({ personId, fullName }));
}
