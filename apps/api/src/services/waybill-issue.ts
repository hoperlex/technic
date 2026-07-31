import { and, eq, ne } from 'drizzle-orm';
import {
  formatSnils,
  licenseNumberLabel,
  routeCargoLabel,
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
    actorName: string;
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
    task_from: request?.loading ?? '',
    task_to: request?.unloading ?? '',
    task_cargo: cargo,
    task_departure_time: departure,

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

    dispatcher_fio: params.actorName,
  };
}

export interface IssuedWaybill {
  id: string;
  number: string;
  /** Талон заказчика, в который попала заявка: 1–4 (ADR 0037 п. 3). */
  slot: number;
  /** Лист уже был выписан на эту машину и дату — заявка дописана талоном. */
  reused: boolean;
}

export interface RouteWaybillContext {
  routeId: string;
  vehicleId: string;
  /** День рейса: он же дата листа и дата, на которую проверяется допуск водителя. */
  routeDate: string;
  driverPersonId: string;
  trip: RouteTripFields;
  /** Состав рейса в порядке талонов: позиция становится `slot` талона заказчика. */
  requests: readonly { requestId: string; position: number }[];
  actor: { id: string; name: string };
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
  const requirement = await waybillRequirementFor(tx, {
    requestType: 'freight_transport',
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
  if (!selection || selection.drivers.length === 0) {
    throw err.unprocessable(
      selection?.requiredCategoryName
        ? `У водителя нет действующей категории ${selection.requiredCategoryName} на ${ctx.routeDate}`
        : 'У водителя нет действующего удостоверения на дату рейса',
      { driverPersonId: 'Водитель не допущен к этой машине' },
    );
  }

  /*
   * Пока история не перенесена `backfill:routes`, в базе живёт прежний UNIQUE
   * (vehicle_id, issued_for_date) среди неаннулированных: вторая смена включается только
   * contract-миграцией. Проверяем это сами и объясняем словами — иначе диспетчер получил бы
   * ошибку уникального индекса вместо ответа.
   */
  const [sameDay] = await tx
    .select({ id: waybills.id })
    .from(waybills)
    .where(
      and(
        eq(waybills.vehicleId, ctx.vehicleId),
        eq(waybills.issuedForDate, ctx.routeDate),
        ne(waybills.status, 'cancelled'),
      ),
    );
  if (sameDay) {
    throw err.conflict(
      'На эту машину и дату уже выписан действующий путевой лист: вторая смена станет возможна после переноса истории маршрутов',
    );
  }

  const series = await findSeriesByCode(DEFAULT_SERIES_CODE);
  if (!series) throw err.conflict('Не заведена серия путевых листов');
  const number = await takeNextNumber(tx, series.id);
  const organizationId = await resolveOrganization(tx, ctx.vehicleId);

  /*
   * Задание печатается всем рейсом: шапка («в чьё распоряжение») — по первому талону, а нижняя
   * таблица держит четыре строки — ровно столько заявок, сколько бывает в рейсе. Пустые строки
   * остаются пустыми: лист на одну заявку выглядит так же, как выглядел до маршрутов.
   */
  const ordered = [...ctx.requests].sort((a, b) => a.position - b.position);
  const first = ordered[0]!;
  const data = await collectSnapshot(tx, {
    requestId: first.requestId,
    restRequestIds: ordered.slice(1).map((r) => r.requestId),
    vehicleId: ctx.vehicleId,
    driverPersonId: ctx.driverPersonId,
    organizationId,
    fields: ctx.trip,
    number: number.display,
    seriesPrefix: number.prefix,
    date: ctx.routeDate,
    actorName: ctx.actor.name,
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
  // помнить своё.
  await tx.insert(waybillRequests).values(
    ctx.requests.map((r) => ({
      waybillId: created!.id,
      requestId: r.requestId,
      slot: r.position,
    })),
  );

  return { id: created!.id, number: number.display, slot: first.position, reused: false };
}
