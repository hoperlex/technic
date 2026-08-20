import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type CostTargetSource,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  type GarageBusyEntry,
  type GarageBusyRequest,
  type GarageBusyVehicle,
  type GarageDriverState,
  type GarageEsm2Busy,
  type GarageRouteBusy,
  type GarageSpecialBusy,
  type GarageVehicleState,
  requestCustomerName,
  type RequestStatus,
  vehicleLabel,
  type VehicleOwnership,
  waybillDisplayNumber,
  type WaybillFormCode,
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
import { requestIsLinearRawSql, requestIsLinearSql } from '../db/linear-mode';

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
 * Отбор по площадке (план «Гараж: правки интерфейса», Р8–Р9): набор площадок приезжает в **те же**
 * условия занятости, из которых собран день, а не в отдельный запрос рядом.
 *
 * Отдельным запросом фильтр однажды показал бы строку, в занятости которой этой площадки нет:
 * условия срока и статуса пришлось бы переписать вторым разом, и разойтись им негде, кроме как на
 * первой же правке. Поэтому у каждого условия занятости появился необязательный набор площадок:
 * не задан — условие прежнее до буквы, задан — то же условие плюс площадка его заявки.
 */
type ObjectFilter = readonly string[] | undefined;

/** Список идентификаторов для сырого `IN (...)`: приведение к uuid обязательно — колонка uuid. */
function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** Набор задан и непуст: пустой фильтром не является — «выбраны все» и «не выбрано» один вопрос. */
function hasObjects(objects: ObjectFilter): objects is readonly string[] {
  return objects !== undefined && objects.length > 0;
}

/**
 * Площадка рейса: заявка **состава** (`vehicle_route_requests`) либо заявка-основание перегона
 * (`vehicle_routes.source_request_id`) — по ИЛИ, потому что рейс отвечает про свою работу и той и
 * другой.
 *
 * Заявка отдела сюда не попадает сама собой (Р10): площадки у неё нет вовсе, и `object_id IN (…)`
 * ложен на NULL — второго условия под это не нужно.
 */
function routeObjectCondition(route: string, objects: ObjectFilter): SQL {
  if (!hasObjects(objects)) return sql.empty();
  const rt = sql.raw(route);
  const list = idList(objects);
  return sql` AND (
        EXISTS (SELECT 1 FROM ${vehicleRouteRequests} ga_rr
                  JOIN ${vehicleRequests} ga_rq ON ga_rq.id = ga_rr.request_id
                 WHERE ga_rr.route_id = ${rt}.id AND ga_rq.object_id IN (${list}))
        OR EXISTS (SELECT 1 FROM ${vehicleRequests} ga_sq
                    WHERE ga_sq.id = ${rt}.source_request_id AND ga_sq.object_id IN (${list}))
      )`;
}

/**
 * Площадка недельного листа — у его заявки-основания. Листа без заявки это касается ровно так, как
 * должно: заявку могли удалить, а бланк остался, и площадки у такой занятости больше нет — в отбор
 * она не проходит.
 */
function esm2ObjectCondition(waybill: string, objects: ObjectFilter): SQL {
  if (!hasObjects(objects)) return sql.empty();
  return sql` AND EXISTS (SELECT 1 FROM ${vehicleRequests} ga_wq
        WHERE ga_wq.id = ${sql.raw(waybill)}.source_request_id
          AND ga_wq.object_id IN (${idList(objects)}))`;
}

/**
 * Действующий недельный лист, накрывающий день, — одним куском на все места, где о нём
 * спрашивают: занятость машины, назначенность человека, отбор по площадке и бланк работы дня.
 * Разложи эти четыре строки по четырём запросам, и аннулированный лист однажды займёт машину в
 * одном из них.
 */
function esm2CoversDay(waybill: string, on: string): SQL {
  const w = sql.raw(waybill);
  return sql`${w}.form_code = 'esm2'
      AND ${w}.status <> 'cancelled'
      AND ${w}.period_from <= ${on}::date
      AND ${w}.period_to >= ${on}::date`;
}

/**
 * Рейс, по которому есть куда ехать (ADR 0131), — одним куском на все пять мест, где о нём
 * спрашивают: занятость машины, занятость водителя, набор занятостей страницы, бланк работы дня и
 * счёт рейсов без водителя в сводке. Разложи эти пять строк по пяти запросам, и заготовка однажды
 * займёт машину в одном из них.
 *
 * Работа у рейса это одно из трёх:
 *
 * - **перегон** — состава у него нет по устройству (ADR 0082), а задание даёт пара «откуда — куда»;
 * - **непустой состав живыми заявками** — линейный день попадает сюда сам собой, он материализован
 *   строкой состава с `work_date` (ADR 0100 §12). Живыми, потому что мягкое удаление заявки строку
 *   состава не трогает вовсе (`DELETE /vehicle-requests/:id` пишет только `deleted_at` и не зовёт
 *   `detachRequest` ни при каком статусе): без этого условия архивная заявка держала бы машину и
 *   человека вечно. Статус при этом не спрашивается — отменённая заявка уходит из рейса сама
 *   (`detachOnStatus`), а где не уходит, там рейс заморожен листом и виден третьей веткой;
 * - **действующий лист** — пустой бланк выписывается осознанно и под подтверждение (ADR 0071):
 *   номер израсходован, бумага именная и лежит у водителя в кабине. Аннулировали единственный лист
 *   — рейс снова становится заготовкой и уходит из среза, и это то же правило, а не особый случай.
 *
 * Что остаётся за правилом — грузовой рейс без состава и без листа: запись заведена, ехать по ней
 * некуда. В срезе дня её нет вовсе.
 *
 * Рейс с составом, но неразложенным по точкам заданием, работу имеет: заявки и адреса в нём
 * названы, а собрана ли бумага — другой вопрос, и отвечают на него блокеры выписки.
 *
 * Алиас строкой, как у `esm2CoversDay`: в условиях `EXISTS` это `ga_rt`, в двух запросах-билдерах
 * — `vehicle_routes`, у которых своего алиаса нет. Подзапросы взяли собственные имена (`ga_rw`,
 * `ga_rq2`, `ga_rq3`) — ради чтения, а не корректности: области видимости соседних `EXISTS`
 * независимы, но два разных `ga_rr` в одном запросе разбирались бы глазами при каждой правке
 * площадки.
 */
export function routeHasWork(route: string): SQL {
  const rt = sql.raw(route);
  return sql`(
    ${rt}.purpose <> 'freight'
    OR EXISTS (SELECT 1 FROM ${vehicleRouteRequests} ga_rq2
                 JOIN ${vehicleRequests} ga_rq3 ON ga_rq3.id = ga_rq2.request_id
                WHERE ga_rq2.route_id = ${rt}.id AND ga_rq3.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM ${waybills} ga_rw
                WHERE ga_rw.route_id = ${rt}.id AND ga_rw.status <> 'cancelled')
  )`;
}

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
 *
 * Спрашивается при этом режим самой заявки, а не признак справочника: заявку могло застать
 * переключение (миграция 0137), и живой признак вернул бы её на новый режим — то есть снял бы с
 * машины занятость, которой заказ держит площадку, и пустил бы на те же дни второй заказ.
 */
function specialBusyExists(on: string, objects?: ObjectFilter): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${vehicleRequestAssignments} ga_a
    JOIN ${vehicleRequests} ga_r ON ga_r.id = ga_a.request_id
    JOIN ${vehicleTypes} ga_vt ON ga_vt.id = ga_r.vehicle_type_id
    JOIN ${specialEquipmentRequestDetails} ga_d ON ga_d.request_id = ga_r.id
    WHERE ga_a.vehicle_id = ${vehicles.id}
      AND ga_r.status = 'confirmed'
      AND ga_r.deleted_at IS NULL
      AND NOT ${requestIsLinearRawSql('ga_r', 'ga_vt')}
      AND ga_d.date_from <= ${on}::date
      AND coalesce(ga_d.date_to, ga_d.date_from) >= ${on}::date${
        hasObjects(objects) ? sql` AND ga_r.object_id IN (${idList(objects)})` : sql.empty()
      }
  )`;
}

/**
 * Действующий недельный лист ЭСМ-2 на этот день (ADR 0060).
 *
 * Считается наравне с заказом, а не как приписка к нему: заявку могли закрыть или откатить, а
 * бланк недели остаётся у машиниста — по документу машина занята, и портал обязан это показывать.
 */
function esm2BusyExists(on: string, objects?: ObjectFilter): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${waybills} ga_w
    WHERE ga_w.vehicle_id = ${vehicles.id}
      AND ${esm2CoversDay('ga_w', on)}${esm2ObjectCondition('ga_w', objects)}
  )`;
}

/**
 * Рейс этой машины в этот день — включая перегон: техника всё равно в пути. Заготовка не считается
 * (ADR 0131): запись без состава и без листа никуда не едет, и «в рейсе» о ней было бы неправдой.
 */
function routeBusyExists(on: string, objects?: ObjectFilter): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${vehicleRoutes} ga_rt
    WHERE ga_rt.vehicle_id = ${vehicles.id}
      AND ga_rt.route_date = ${on}::date
      AND ${routeHasWork('ga_rt')}${routeObjectCondition('ga_rt', objects)}
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

/**
 * Рейс, в котором человек стоит водителем на этот день, — и по которому есть куда ехать (ADR 0131).
 * Заготовка человека не занимает: ставить тег «назначен» тому, кому ехать некуда, значит прятать за
 * ним настоящую работу дня.
 */
function driverRouteExists(on: string, objects?: ObjectFilter): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${vehicleRoutes} ga_rt
    WHERE ga_rt.driver_person_id = ${persons.id}
      AND ga_rt.route_date = ${on}::date
      AND ${routeHasWork('ga_rt')}${routeObjectCondition('ga_rt', objects)}
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
  return sql`(${driverEsm2Exists(on)} OR ${driverDayWaybillExists(on)})`;
}

/**
 * Недельный лист, выписанный на этого человека и накрывающий день, — тем же куском условий, каким
 * он спрашивается у машины (`esm2CoversDay`). Отдельной функцией, потому что о нём спрашивают
 * трижды: состояние дня, отбор по площадке и бланк работы.
 */
function driverEsm2Exists(on: string, objects?: ObjectFilter): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${waybills} ga_w
    WHERE ga_w.driver_person_id = ${persons.id}
      AND ${esm2CoversDay('ga_w', on)}${esm2ObjectCondition('ga_w', objects)}
  )`;
}

/** Лист дня — 4-П или форма № 3: у них день листа один, `issued_for_date`. */
function driverDayWaybillExists(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${waybills} ga_w
    WHERE ga_w.driver_person_id = ${persons.id}
      AND ga_w.status <> 'cancelled'
      AND ga_w.form_code <> 'esm2'
      AND ga_w.issued_for_date = ${on}::date
  )`;
}

export function driverStateSql(on: string) {
  return sql<GarageDriverState>`CASE
    WHEN ${driverRouteExists(on)} OR ${driverWaybillExists(on)} THEN 'assigned'
    ELSE 'free'
  END`;
}

// ── Отбор по площадке и по бланку ──

/**
 * Площадка работы дня машины — три источника по ИЛИ (Р9): рейс дня, заказ спецтехники, накрывающий
 * день, и недельный лист, накрывающий его же.
 *
 * Каждая ветка — то самое условие занятости, которым собран день, плюс площадка её заявки: строка
 * проходит фильтр ровно тогда, когда в её `busy` стоит работа на отобранной площадке. Свободная
 * машина не проходит ни одной ветки, и это верно — у дня без работы площадки нет (Р7).
 */
export function vehicleObjectFilterSql(on: string, objects: readonly string[]): SQL {
  return sql`(${specialBusyExists(on, objects)}
    OR ${esm2BusyExists(on, objects)}
    OR ${routeBusyExists(on, objects)})`;
}

/**
 * Площадка работы дня водителя — две ветки: рейс дня и недельный лист на этого человека.
 *
 * Заказа спецтехники здесь нет намеренно, и это не пропуск третьей ветки: заявка называет машину,
 * а не человека (водитель переехал в рейс миграцией 0074), и занятости такого вида у водителя не
 * бывает вовсе — приписать ему площадку заказа было бы нечем.
 */
export function driverObjectFilterSql(on: string, objects: readonly string[]): SQL {
  return sql`(${driverRouteExists(on, objects)} OR ${driverEsm2Exists(on, objects)})`;
}

/**
 * Бланки работ дня водителя — по строке на работу, тем же правилом, что и чистая функция
 * `busyWaybillForms` в контрактах.
 *
 * Две записи одного правила — плата за отбор до страницы: посчитанный по загруженной странице
 * фильтр врал бы и в счётчике, и в листании. Сверка у них одна и настоящая — тест паритета
 * (`garage.db.test.ts`) спрашивает обе на общем наборе занятостей.
 *
 * Ветки повторяют `busyWaybillForm` буква в букву:
 *
 * - рейс дня — `routeWaybillForm`: перегон (`purpose <> 'freight'`) идёт по 4-П независимо от типа
 *   машины, грузовой — по бланку её типа;
 * - недельный лист на человека — `esm2`;
 * - арендная машина не даёт строки ни в одной ветке: лист на неё выписывает арендодатель, и бланка
 *   у работы нет вовсе.
 *
 * Возвращается **тело** подзапроса со столбцом `form`, а не готовое условие: им пользуются оба
 * читателя — отбор (`driverFormFilterSql`) и сверка, собирающая из него набор строки.
 */
export function driverDayFormsSql(on: string): SQL {
  return sql`
    SELECT CASE WHEN ga_rt.purpose <> 'freight' THEN '4p' ELSE ga_vt.waybill_form_code END AS form
      FROM ${vehicleRoutes} ga_rt
      JOIN ${vehicles} ga_v ON ga_v.id = ga_rt.vehicle_id
      JOIN ${vehicleTypes} ga_vt ON ga_vt.id = ga_v.vehicle_type_id
     WHERE ga_rt.driver_person_id = ${persons.id}
       AND ga_rt.route_date = ${on}::date
       AND ga_v.ownership = 'own'
       AND ${routeHasWork('ga_rt')}
    UNION ALL
    SELECT 'esm2'
      FROM ${waybills} ga_w
      JOIN ${vehicles} ga_wv ON ga_wv.id = ga_w.vehicle_id
     WHERE ga_w.driver_person_id = ${persons.id}
       AND ga_wv.ownership = 'own'
       AND ${esm2CoversDay('ga_w', on)}`;
}

/**
 * Отбор по бланку: строка проходит, если пересечение её набора бланков с набором фильтра непусто
 * (Р6).
 *
 * Условием `EXISTS`, а не join'ом к работам дня: у человека бывает две работы разных бланков сразу,
 * и join показал бы его в выдаче дважды. Пустой набор строки не проходит никакой фильтр — у
 * свободного дня и у арендной машины бланка нет.
 */
export function driverFormFilterSql(on: string, forms: readonly WaybillFormCode[]): SQL {
  const list = sql.join(
    forms.map((code) => sql`${code}`),
    sql`, `,
  );
  return sql`EXISTS (
    SELECT 1 FROM (${driverDayFormsSql(on)}) ga_f WHERE ga_f.form IN (${list})
  )`;
}

// ── Добор занятостей ──

/**
 * Реквизиты машины, которыми занятость отвечает о ней сама: подпись (`vehicleLabel`), марка второй
 * строкой и то, чем эта работа закрывается (`busyWaybillForm`). Правило одно на портал и сервер, и
 * каждый запрос занятости выбирает их одним и тем же набором колонок.
 *
 * Бланк типа и принадлежность едут здесь же, а не добираются отдельно: все три запроса занятости
 * уже соединяют `vehicles` с `vehicle_types`, и join'ов от этого не прибавляется.
 */
const vehicleLabelColumns = {
  ownership: vehicles.ownership,
  description: vehicles.description,
  categoryName: vehicleCategories.name,
  typeName: vehicleTypes.name,
  registrationNumber: vehicles.registrationNumber,
  modelName: vehicleModels.name,
  waybillFormCode: vehicleTypes.waybillFormCode,
};

/**
 * Как занятость называет свою машину: подпись, марка и то, чем работа дня закрывается. Одной
 * сборкой на все три вида занятости — разложи её по трём мапперам, и рейс однажды ответит про
 * бланк не то же, что заказ на той же машине.
 */
function busyVehicleOf(r: {
  ownership: VehicleOwnership;
  description: string;
  categoryName: string | null;
  typeName: string;
  registrationNumber: string | null;
  modelName: string | null;
  waybillFormCode: WaybillFormCode;
}): Omit<GarageBusyVehicle, 'vehicleId'> {
  return {
    vehicleLabel: vehicleLabel(r),
    vehicleModelName: r.modelName,
    vehicleOwnership: r.ownership,
    vehicleWaybillFormCode: r.waybillFormCode,
  };
}

/**
 * Заявка глазами гаража: номер, состояние и заказчик — по ним отсюда и переходят в заявку.
 *
 * Заказчик приходит объектом затрат целиком (`CostTargetSource`, Р25): решает его идентификатор, а
 * не то, чьё наименование оказалось заполнено, — поэтому каждый запрос занятости обязан выбрать
 * обе пары справочников, а не одни подписи.
 */
function busyRequest(
  row: CostTargetSource & {
    requestId: string;
    num: number;
    status: RequestStatus;
    /**
     * День линейного заказа, ради которого строка стоит в рейсе (ADR 0100 §2). Заполнен он только
     * у состава — заявка-основание перегона и недельного листа дня не несёт, и `null` там честный
     * ответ, а не пробел.
     */
    workDate?: string | null;
  },
): GarageBusyRequest {
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
  sourceObjectId: string | null;
  sourceObjectCode: string | null;
  sourceObjectName: string | null;
  sourceDepartmentId: string | null;
  sourceDepartmentCode: string | null;
  sourceDepartmentName: string | null;
}): GarageBusyRequest | null {
  if (!row.sourceRequestId || row.sourceNum == null || !row.sourceStatus) return null;
  return busyRequest({
    requestId: row.sourceRequestId,
    num: row.sourceNum,
    status: row.sourceStatus,
    objectId: row.sourceObjectId,
    objectCode: row.sourceObjectCode,
    objectName: row.sourceObjectName,
    departmentId: row.sourceDepartmentId,
    departmentCode: row.sourceDepartmentCode,
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
      // Заказчик — объектом затрат (Р25): ветвление по идентификатору, поэтому обе пары целиком.
      sourceObjectId: vehicleRequests.objectId,
      sourceObjectCode: constructionObjects.code,
      sourceObjectName: constructionObjects.name,
      sourceDepartmentId: vehicleRequests.departmentId,
      sourceDepartmentCode: departments.code,
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
    // Заготовки в срез не едут (ADR 0131) — тем же куском, каким их не считают состояния дня:
    // отбери их здесь, но забудь там, и колонка занятости разошлась бы с тегом состояния строки.
    .where(and(eq(vehicleRoutes.routeDate, on), routeHasWork('vehicle_routes'), where))
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
    ...busyVehicleOf(r),
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
      // Заказчик — объектом затрат (Р25): ветвление по идентификатору, поэтому обе пары целиком.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      departmentId: vehicleRequests.departmentId,
      departmentCode: departments.code,
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
      // Заказчик — объектом затрат (Р25). Отдела у заказа техники на объект не бывает вовсе
      // (CHECK `vehicle_requests_department_freight_check`), но пара выбирается целиком: это одно
      // правило на все запросы гаража, и запоминать, где половина из них лишняя, незачем.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      departmentId: vehicleRequests.departmentId,
      departmentCode: departments.code,
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
        // Тем же выражением, что и в состоянии дня: режим заявки, а не признак справочника —
        // заявку могло застать переключение (миграция 0137).
        eq(requestIsLinearSql(vehicleRequests.isLinearFrozen, orderedTypes.isLinear), false),
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
    ...busyVehicleOf(r),
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
      // Заказчик — объектом затрат (Р25): ветвление по идентификатору, поэтому обе пары целиком.
      sourceObjectId: vehicleRequests.objectId,
      sourceObjectCode: constructionObjects.code,
      sourceObjectName: constructionObjects.name,
      sourceDepartmentId: vehicleRequests.departmentId,
      sourceDepartmentCode: departments.code,
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
    ...busyVehicleOf(r),
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
