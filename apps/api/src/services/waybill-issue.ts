import { and, eq } from 'drizzle-orm';
import {
  formatSnils,
  licenseNumberLabel,
  routeCargoLabel,
  type RoutePurpose,
  routeWaybillForm,
  type VehicleRequestType,
  waybillRequirement,
  type WaybillRequirement,
  type WaybillSnapshotKey,
  type RouteTripFields,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  departments,
  freightTransportRequestDetails,
  organizations,
  vehicleModels,
  vehicleRequests,
  vehicles,
  vehicleTypes,
  waybillRequests,
  waybills,
} from '../db/schema';
import { err } from '../lib/errors';
import { selectDrivers } from './drivers';
import { findSeriesByCode, takeNextNumber } from './waybill-numbers';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающие функции годятся и вне транзакции: форма спрашивает их до перевода в работу. */
type Reader = Tx | typeof db;

/**
 * Выдача путевого листа по рейсу (ADR 0037, маршруты).
 *
 * Лист выписывается с маршрута отдельным действием — когда состав рейса собран, а не на первой
 * же заявке: номер бланка не сгорает на каждой перестановке, а талоны заказчиков заполняются в
 * том порядке, в котором машина поедет. «Один лист на машину и дату» уступило место «одному
 * действующему листу на рейс»: день и ночь на одной машине — это два рейса и два бланка.
 */

/** Серия по умолчанию, заведённая миграцией 0061. Пока серия в портале одна. */
const DEFAULT_SERIES_CODE = 'main';

/**
 * Нужен ли на этот рейс путевой лист. Правило само по себе чистое и живёт в контрактах
 * (`waybillRequirement`) — здесь только чтение того, чего оно требует: принадлежности машины и
 * бланка, закреплённого за её типом.
 *
 * Тип заявки спрашивается наравне с машиной: ограничение идёт и по нему, и по виду ТС, и это не
 * тавтология — заявку на технику для работы на объекте можно завести и на самосвал, а рейса,
 * маршрута и груза у неё нет (ADR 0037 п. 1, ADR 0041).
 */
export async function waybillRequirementFor(
  tx: Reader,
  params: { requestType: VehicleRequestType; vehicleId: string },
): Promise<WaybillRequirement> {
  // Вида заявки достаточно, чтобы ответить: справочник спрашивать незачем.
  if (params.requestType !== 'freight_transport') return { formCode: null, reason: null };

  const [row] = await tx
    .select({
      ownership: vehicles.ownership,
      formCode: vehicleTypes.waybillFormCode,
      typeName: vehicleTypes.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, params.vehicleId));

  if (!row) return { formCode: null, reason: 'Машина не найдена' };
  return waybillRequirement({
    requestType: params.requestType,
    ownership: row.ownership,
    formCode: row.formCode,
    typeName: row.typeName,
  });
}

/**
 * То же, но по одному типу ТС — машина ещё не выбрана (ADR 0052). Этим ответом форма перевода в
 * работу решает, спрашивать ли рейс до выбора техники: бланк закреплён за типом, и заявка на тип
 * без бланка рейса не знает независимо от того, какую единицу возьмут.
 *
 * Принадлежность здесь не спрашивается: её несёт машина, а не тип. Отбор рейсов сужен ею и без
 * того — рейс заводится только на собственную технику (`assertRouteVehicle`), и подсказка по типу
 * чужих машин не покажет.
 */
export async function waybillRequirementByType(
  tx: Reader,
  params: { requestType: VehicleRequestType; vehicleTypeId: string },
): Promise<WaybillRequirement> {
  if (params.requestType !== 'freight_transport') return { formCode: null, reason: null };

  const [row] = await tx
    .select({ formCode: vehicleTypes.waybillFormCode, typeName: vehicleTypes.name })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, params.vehicleTypeId));

  if (!row) return { formCode: null, reason: 'Тип техники не найден' };
  return waybillRequirement({
    requestType: params.requestType,
    ownership: 'own',
    formCode: row.formCode,
    typeName: row.typeName,
  });
}

/**
 * Бланк рейса. Правило чистое и живёт в контрактах (`routeWaybillForm`) — здесь только чтение
 * того, чего оно требует: принадлежности машины и бланка, закреплённого за её типом.
 *
 * У перегона тип не спрашивают вовсе: экскаватор идёт по дорогам общего пользования как
 * транспортное средство, и документ у этой поездки один — 4-П. Проставить бланк типам
 * спецтехники нельзя: тогда они попали бы в подсказки грузовых рейсов.
 */
export async function routeWaybillFormFor(
  tx: Reader,
  params: { purpose: RoutePurpose; vehicleId: string },
): Promise<WaybillRequirement> {
  const [row] = await tx
    .select({
      ownership: vehicles.ownership,
      formCode: vehicleTypes.waybillFormCode,
      typeName: vehicleTypes.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, params.vehicleId));

  if (!row) return { formCode: null, reason: 'Машина не найдена' };
  return routeWaybillForm({
    purpose: params.purpose,
    ownership: row.ownership,
    formCode: row.formCode,
    typeName: row.typeName,
  });
}

/**
 * Дата рейса: её несёт время подачи. Заявок другого вида здесь не бывает — лист выписывается
 * только на грузоперевозку (ADR 0041), — но `now()` оставлен ответом на случай заявки без
 * заполненных деталей: лист без даты не выписать вовсе.
 */
export async function tripDate(tx: Reader, requestId: string): Promise<string> {
  const [row] = await tx
    .select({ scheduledAt: freightTransportRequestDetails.scheduledAt })
    .from(freightTransportRequestDetails)
    .where(eq(freightTransportRequestDetails.requestId, requestId));

  // Дата берётся по московскому времени: рейс на 23:30 по МСК — это сегодняшний лист, а не
  // завтрашний, каким его увидел бы UTC.
  const at = row?.scheduledAt ?? new Date();
  return new Date(at.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Организация, от чьего имени выписывается лист: та, за которой числится машина, иначе основная. */
async function resolveOrganization(tx: Tx, vehicleId: string): Promise<string> {
  const [own] = await tx
    .select({ id: organizations.id })
    .from(vehicles)
    .innerJoin(organizations, eq(organizations.id, vehicles.ownerOrganizationId))
    .where(eq(vehicles.id, vehicleId));
  if (own) return own.id;

  const [primary] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.isPrimary, true), eq(organizations.isActive, true)));
  if (!primary) {
    throw err.conflict(
      'Не заведена организация-владелец транспорта: путевой лист выписывать не от кого',
    );
  }
  return primary.id;
}

/**
 * Значения бланка снимком (ADR 0037 п. 10). Лист печатается из этого объекта, а не из
 * справочников, поэтому переименование объекта или уточнение госномера задним числом уже выданный
 * документ не меняет.
 */
async function collectSnapshot(
  tx: Tx,
  params: {
    /** Заявка первого талона: она же стоит в шапке задания «в чьё распоряжение». */
    requestId: string;
    /** Остальные заявки рейса в порядке талонов — строки 2–4 нижней таблицы задания. */
    restRequestIds: string[];
    vehicleId: string;
    driverPersonId: string | null;
    organizationId: string;
    fields: RouteTripFields | null;
    number: string;
    seriesPrefix: string;
    date: string;
    /**
     * Перегон техники: задание берётся не из заявки, а из самого рейса — «откуда — куда». Груза
     * нет: машина едет своим ходом, она и есть транспортное средство листа, а не груз.
     */
    relocation: { from: string; to: string } | null;
  },
): Promise<Record<WaybillSnapshotKey, string>> {
  const [org] = await tx
    .select({
      name: organizations.name,
      address: organizations.address,
      phone: organizations.phone,
      okpo: organizations.okpo,
      ogrn: organizations.ogrn,
    })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId));

  const [vehicle] = await tx
    .select({
      registrationNumber: vehicles.registrationNumber,
      garageNumber: vehicles.garageNumber,
      inventoryNumber: vehicles.inventoryNumber,
      modelName: vehicleModels.name,
      manufacturer: vehicles.manufacturerName,
    })
    .from(vehicles)
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(eq(vehicles.id, params.vehicleId));

  const [request] = await tx
    .select({
      // Заказчик в бланке — объект или отдел (ADR 0040): у заявки отдела площадки нет вовсе, и
      // строка «Заказчик» осталась бы пустой при innerJoin по объекту — вместе со всем листом.
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      departmentName: departments.name,
      loading: freightTransportRequestDetails.loadingLocation,
      unloading: freightTransportRequestDetails.unloadingLocation,
      volumeM3: freightTransportRequestDetails.volumeM3,
      weightTons: freightTransportRequestDetails.weightTons,
      scheduledAt: freightTransportRequestDetails.scheduledAt,
      timeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .leftJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, params.requestId));

  // Реквизиты водителя — снимком: удостоверение сменят, а лист остаётся с тем, по которому ехали.
  let driver = { fio: '', snils: '', personnelNo: '', license: '', licenseIssuedOn: '' };
  if (params.driverPersonId) {
    const selection = await selectDrivers({
      vehicleId: params.vehicleId,
      on: params.date,
      withTrailer: params.fields?.withTrailer ?? false,
      personId: params.driverPersonId,
    });
    const found = selection?.drivers[0];
    if (found) {
      driver = {
        fio: found.fullName,
        snils: formatSnils(found.snils),
        personnelNo: found.personnelNo,
        license: licenseNumberLabel({
          series: found.licenseSeries,
          number: found.licenseNumber,
        }),
        licenseIssuedOn: found.licenseIssuedOn ?? '',
      };
    }
  }

  const cargo = routeCargoLabel(request?.volumeM3 ?? null, request?.weightTons ?? null);

  /*
   * Талоны 2–4: в таблице задания четыре строки, и рейс печатается целиком. Пустые строки
   * остаются пустыми — лист на одну заявку выглядит так же, как выглядел до маршрутов.
   */
  const rest = await Promise.all(
    params.restRequestIds.slice(0, 3).map(async (id) => {
      const [row] = await tx
        .select({
          objectName: constructionObjects.name,
          departmentName: departments.name,
          loading: freightTransportRequestDetails.loadingLocation,
          unloading: freightTransportRequestDetails.unloadingLocation,
          volumeM3: freightTransportRequestDetails.volumeM3,
          weightTons: freightTransportRequestDetails.weightTons,
        })
        .from(vehicleRequests)
        .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
        .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
        .leftJoin(
          freightTransportRequestDetails,
          eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
        )
        .where(eq(vehicleRequests.id, id));
      return {
        customer: row?.objectName ?? row?.departmentName ?? '',
        from: row?.loading ?? '',
        to: row?.unloading ?? '',
        cargo: routeCargoLabel(row?.volumeM3 ?? null, row?.weightTons ?? null),
      };
    }),
  );
  const slot = (index: number) => rest[index] ?? { customer: '', from: '', to: '', cargo: '' };
  const departure =
    request?.scheduledAt && !request.timeUnspecified
      ? new Date(request.scheduledAt.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(11, 16)
      : '';
  // Форма № 3 держит часы и минуты в разных клетках шириной в две цифры: «08:30» туда не встаёт.
  const [departureHours = '', departureMinutes = ''] = departure ? departure.split(':') : [];

  return {
    org_name: org?.name ?? '',
    org_address: org?.address ?? '',
    org_phone: org?.phone ?? '',
    org_okpo: org?.okpo ?? '',
    org_ogrn: org?.ogrn ?? '',

    waybill_series: params.seriesPrefix,
    waybill_number: params.number,
    waybill_date: params.date,

    vehicle_brand: [vehicle?.manufacturer, vehicle?.modelName].filter(Boolean).join(' ').trim(),
    vehicle_reg_number: vehicle?.registrationNumber ?? '',
    vehicle_garage_number: params.fields?.garageNumber || (vehicle?.garageNumber ?? ''),
    vehicle_inventory_number: vehicle?.inventoryNumber ?? '',

    trailer1_brand: params.fields?.trailer1Model ?? '',
    trailer1_reg_number: params.fields?.trailer1RegNumber ?? '',
    trailer2_brand: params.fields?.trailer2Model ?? '',
    trailer2_reg_number: params.fields?.trailer2RegNumber ?? '',

    driver_fio: driver.fio,
    driver_snils: driver.snils,
    driver_personnel_no: driver.personnelNo,
    driver_license_number: driver.license,
    driver_license_issued_on: driver.licenseIssuedOn,

    communication_kind: params.fields?.communicationKind ?? '',
    transportation_kind: params.fields?.transportationKind ?? '',

    // У отдела адреса нет: он не площадка, и маршрут задан адресами погрузки и разгрузки.
    customer_name: request?.objectName ?? request?.departmentName ?? '',
    customer_address: request?.objectAddress ?? '',
    task_from: params.relocation ? params.relocation.from : (request?.loading ?? ''),
    task_to: params.relocation ? params.relocation.to : (request?.unloading ?? ''),
    // У перегона груза нет — графа остаётся пустой, как одометр и движение горючего.
    task_cargo: params.relocation ? '' : cargo,
    task_departure_time: departure,
    task_departure_hh: departureHours,
    task_departure_mm: departureMinutes,

    task2_customer: slot(0).customer,
    task2_from: slot(0).from,
    task2_to: slot(0).to,
    task2_cargo: slot(0).cargo,
    task3_customer: slot(1).customer,
    task3_from: slot(1).from,
    task3_to: slot(1).to,
    task3_cargo: slot(1).cargo,
    task4_customer: slot(2).customer,
    task4_from: slot(2).from,
    task4_to: slot(2).to,
    task4_cargo: slot(2).cargo,
  };
}

/** Выданный лист: его номер уходит в журнал аудита, а идентификатор — ссылкой на документ. */
export interface IssuedWaybill {
  id: string;
  number: string;
}

export interface RouteWaybillContext {
  routeId: string;
  /** Зачем рейс: им выбирается бланк — перегон печатается 4-П независимо от типа машины. */
  purpose: RoutePurpose;
  vehicleId: string;
  /** День рейса: он же дата листа и дата, на которую проверяется допуск водителя. */
  routeDate: string;
  driverPersonId: string;
  trip: RouteTripFields;
  /** Состав рейса в порядке талонов: позиция становится `slot` талона заказчика. */
  requests: readonly { requestId: string; position: number }[];
  /**
   * Перегон техники: вместо состава у рейса одна заявка-основание и задание «откуда — куда»
   * (миграция 0082). `null` — обычный маршрут грузоперевозки.
   */
  relocation: { requestId: string; from: string; to: string } | null;
  /** Кто выписывает: попадёт в `issued_by` и в журнал аудита. На бланке его нет — подписи там свои. */
  actor: { id: string };
}

/**
 * Выдача листа по рейсу (маршруты, план `docs/vehicle-routes-plan.md`).
 *
 * Отличие от прежней выдачи «в транзакции перевода заявки в работу» не только в источнике данных.
 * Лист теперь рождается тогда, когда состав рейса собран, а не на первой заявке: номер бланка не
 * сгорает на каждой перестановке, и талоны заполняются в том порядке, в котором машина поедет.
 *
 * Проверки «водитель назначен, состав непуст, все заявки в работе» и «действующего листа ещё нет»
 * делает вызывающий (`canIssueWaybill` в контрактах) — под блокировкой рейса и строк заявок.
 * Здесь остаётся то, что требует чтения справочников: бланк по машине, допуск водителя на дату
 * рейса и снимок значений.
 */
export async function issueWaybillForRoute(
  tx: Tx,
  ctx: RouteWaybillContext,
): Promise<IssuedWaybill> {
  const requirement = await routeWaybillFormFor(tx, {
    purpose: ctx.purpose,
    vehicleId: ctx.vehicleId,
  });
  if (!requirement.formCode) {
    throw err.unprocessable(requirement.reason ?? 'На эту машину путевой лист не выписывается', {
      vehicleId: 'Бланк не выписывается',
    });
  }

  // Тот же отбор, что показывает форма: второму набору правил разъехаться с первым негде.
  const selection = await selectDrivers({
    vehicleId: ctx.vehicleId,
    on: ctx.routeDate,
    withTrailer: ctx.trip.withTrailer,
    personId: ctx.driverPersonId,
  });
  // Пустой ответ означает неполный комплект документов, а не чужую категорию (ADR 0055): категория
  // выписку не останавливает. Сообщение перечисляет графы бланка — иначе останется гадать, чего
  // именно не хватает человеку, который в справочнике выглядит заведённым.
  if (!selection || selection.drivers.length === 0) {
    throw err.unprocessable(
      `У водителя неполный комплект документов на ${ctx.routeDate}: путевой лист печатает СНИЛС, ` +
        'серию с номером удостоверения и дату его выдачи, и действовать документ должен на день ' +
        'рейса. Недостающее вносит администратор в справочнике водителей.',
      { driverPersonId: 'Документов не хватает для листа' },
    );
  }

  /*
   * Проверки «на эту машину и дату лист уже есть» здесь нет намеренно (ADR 0052). Прежнее
   * ограничение снято миграцией `0074` вместе с UNIQUE (vehicle_id, issued_for_date): один
   * действующий лист приходится на рейс, а не на день машины, — день и ночь на одной машине это
   * два рейса с двумя водителями и двумя бланками. Уникальность рейса держит частичный индекс
   * `waybills_route_unique`, а состав и статусы проверил вызывающий под блокировками.
   *
   * Занятость водителя не проверяется тоже: один человек может стоять в двух действующих листах
   * одного дня на разных машинах. Портал не ведёт табель и не знает ни смен, ни времени в пути —
   * решает диспетчер.
   */
  const series = await findSeriesByCode(DEFAULT_SERIES_CODE);
  if (!series) throw err.conflict('Не заведена серия путевых листов');
  const number = await takeNextNumber(tx, series.id);
  const organizationId = await resolveOrganization(tx, ctx.vehicleId);

  /*
   * Задание печатается всем рейсом: шапка («в чьё распоряжение») — по первому талону, а нижняя
   * таблица держит четыре строки — ровно столько заявок, сколько бывает в рейсе. Пустые строки
   * остаются пустыми: лист на одну заявку выглядит так же, как выглядел до маршрутов.
   *
   * У перегона талон один: заказчик — объект заявки, а «откуда — куда» несёт сам рейс.
   */
  const ordered = [...ctx.requests].sort((a, b) => a.position - b.position);
  const talons = ctx.relocation ? [{ requestId: ctx.relocation.requestId, position: 1 }] : ordered;
  const first = talons[0]!;
  const data = await collectSnapshot(tx, {
    requestId: first.requestId,
    restRequestIds: talons.slice(1).map((r) => r.requestId),
    vehicleId: ctx.vehicleId,
    driverPersonId: ctx.driverPersonId,
    organizationId,
    fields: ctx.trip,
    number: number.display,
    seriesPrefix: number.prefix,
    date: ctx.routeDate,
    relocation: ctx.relocation ? { from: ctx.relocation.from, to: ctx.relocation.to } : null,
  });

  const [created] = await tx
    .insert(waybills)
    .values({
      seriesId: number.seriesId,
      number: number.number,
      formCode: requirement.formCode,
      organizationId,
      routeId: ctx.routeId,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.driverPersonId,
      issuedForDate: ctx.routeDate,
      withTrailer: ctx.trip.withTrailer,
      trailer1Model: ctx.trip.trailer1Model,
      trailer1RegNumber: ctx.trip.trailer1RegNumber,
      trailer2Model: ctx.trip.trailer2Model,
      trailer2RegNumber: ctx.trip.trailer2RegNumber,
      garageNumber: data.vehicle_garage_number ?? '',
      communicationKind: ctx.trip.communicationKind,
      transportationKind: ctx.trip.transportationKind,
      data,
      issuedBy: ctx.actor.id,
    })
    .returning({ id: waybills.id });

  // Талоны — снимок состава на момент выдачи: рейс потом пересоберут, а бланк в журнале обязан
  // помнить своё. У перегона талон один — заявка, ради которой едут: без него журнал показывал бы
  // лист, выписанный ни на что.
  await tx.insert(waybillRequests).values(
    talons.map((r) => ({
      waybillId: created!.id,
      requestId: r.requestId,
      slot: r.position,
    })),
  );

  return { id: created!.id, number: number.display };
}
