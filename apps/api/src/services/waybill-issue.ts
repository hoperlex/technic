import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  formatSnils,
  licenseNumberLabel,
  type WaybillFieldsInput,
  type WaybillFormCode,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
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
 * Выдача путевого листа при переводе заявки в работу (ADR 0037).
 *
 * Лист рождается в той же транзакции, что и смена статуса: состояния «в работе, а листа нет» не
 * существует — по той же причине, по которой ADR 0029 отказался от «выполнена, но чем и почём
 * узнаем потом».
 *
 * Один лист на машину и дату: если машина в этот день уже выехала по другой заявке, лист не
 * поднимается второй — заявка дописывается талоном заказчика (форма 4-П держит четыре).
 */

/** Серия по умолчанию, заведённая миграцией 0061. Пока серия в портале одна. */
const DEFAULT_SERIES_CODE = 'main';
const MAX_SLOTS = 4;

export interface WaybillContext {
  requestId: string;
  vehicleId: string;
  driverPersonId: string | null;
  fields: WaybillFieldsInput | null;
  actor: { id: string; name: string };
}

export interface WaybillRequirement {
  /** Бланк, по которому выписывается лист; `null` — на этот рейс лист не выписывается. */
  formCode: WaybillFormCode | null;
  /** Почему не выписывается — это показывают человеку вместо отсутствующей кнопки. */
  reason: string | null;
}

/**
 * Нужен ли на этот рейс путевой лист. Лист выписывает владелец транспорта, поэтому арендная
 * машина его не получает: на неё лист выдаёт арендодатель. Спецтехника и легковые не получают,
 * пока за их типом не закреплён бланк (ADR 0037, backlog).
 */
export async function waybillRequirementFor(
  tx: Reader,
  vehicleId: string,
): Promise<WaybillRequirement> {
  const [row] = await tx
    .select({
      ownership: vehicles.ownership,
      formCode: vehicleTypes.waybillFormCode,
      typeName: vehicleTypes.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, vehicleId));

  if (!row) return { formCode: null, reason: 'Машина не найдена' };
  if (row.ownership !== 'own') {
    return {
      formCode: null,
      reason: 'Путевой лист на арендную технику выписывает арендодатель',
    };
  }
  if (!row.formCode) {
    return {
      formCode: null,
      reason: `Для типа «${row.typeName}» бланк путевого листа не заведён`,
    };
  }
  return { formCode: row.formCode, reason: null };
}

/** Дата рейса: у грузоперевозки её несёт время подачи, у прочих заявок — день перевода в работу. */
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
 * Значения бланка снимком (ADR 0037 п. 10). Ключи — плейсхолдеры шаблона: лист печатается из
 * этого объекта, а не из справочников, поэтому переименование объекта или уточнение госномера
 * задним числом уже выданный документ не меняет.
 */
async function collectSnapshot(
  tx: Tx,
  params: {
    requestId: string;
    vehicleId: string;
    driverPersonId: string | null;
    organizationId: string;
    fields: WaybillFieldsInput | null;
    number: string;
    date: string;
    actorName: string;
  },
): Promise<Record<string, string>> {
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
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      loading: freightTransportRequestDetails.loadingLocation,
      unloading: freightTransportRequestDetails.unloadingLocation,
      volumeM3: freightTransportRequestDetails.volumeM3,
      weightTons: freightTransportRequestDetails.weightTons,
      scheduledAt: freightTransportRequestDetails.scheduledAt,
      timeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
    })
    .from(vehicleRequests)
    .innerJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
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

  const cargo = request?.volumeM3
    ? `${request.volumeM3} м³`
    : request?.weightTons
      ? `${request.weightTons} т`
      : '';
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

    customer_name: request?.objectName ?? '',
    customer_address: request?.objectAddress ?? '',
    task_from: request?.loading ?? '',
    task_to: request?.unloading ?? '',
    task_cargo: cargo,
    task_departure_time: departure,

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

/**
 * Выдаёт лист или дописывает заявку талоном в уже выданный. Возвращает `null`, если на этот рейс
 * лист не выписывается (аренда, тип без бланка) — это не ошибка, а нормальный ход для заявки,
 * которую портал ведёт без документа.
 */
export async function issueWaybill(tx: Tx, ctx: WaybillContext): Promise<IssuedWaybill | null> {
  const requirement = await waybillRequirementFor(tx, ctx.vehicleId);
  if (!requirement.formCode) return null;

  if (!ctx.driverPersonId) {
    throw err.unprocessable('Выберите водителя — на рейс выписывается путевой лист', {
      driverPersonId: 'Выберите водителя',
    });
  }

  const date = await tripDate(tx, ctx.requestId);

  // Тот же отбор, что показывает форма: второму набору правил разъехаться с первым негде.
  const selection = await selectDrivers({
    vehicleId: ctx.vehicleId,
    on: date,
    withTrailer: ctx.fields?.withTrailer ?? false,
    personId: ctx.driverPersonId,
  });
  if (!selection || selection.drivers.length === 0) {
    throw err.unprocessable(
      selection?.requiredCategoryName
        ? `У водителя нет действующей категории ${selection.requiredCategoryName} на ${date}`
        : 'У водителя нет действующего удостоверения на дату рейса',
      { driverPersonId: 'Водитель не допущен к этой машине' },
    );
  }

  // Один лист на машину и дату: аннулированные не в счёт — испорченный бланк заменяют новым.
  const [existing] = await tx
    .select({ id: waybills.id, number: waybills.number, driverPersonId: waybills.driverPersonId })
    .from(waybills)
    .where(
      and(
        eq(waybills.vehicleId, ctx.vehicleId),
        eq(waybills.issuedForDate, date),
        ne(waybills.status, 'cancelled'),
      ),
    );

  if (existing) {
    // Повторный перевод в работу (после отката администратором) не выписывает второй талон: та
    // же заявка в том же листе уже стоит, и лист остаётся тем, по которому машина вышла.
    const [already] = await tx
      .select({ slot: waybillRequests.slot })
      .from(waybillRequests)
      .where(
        and(
          eq(waybillRequests.waybillId, existing.id),
          eq(waybillRequests.requestId, ctx.requestId),
        ),
      );
    if (already) {
      return {
        id: existing.id,
        number: String(existing.number),
        slot: already.slot,
        reused: true,
      };
    }

    // Второй водитель на ту же машину и дату — это вторая смена, а не второй талон: такой лист
    // портал пока не выписывает (ADR 0037, backlog).
    if (existing.driverPersonId !== ctx.driverPersonId) {
      throw err.conflict(
        'На эту машину и дату уже выписан лист на другого водителя: вторая смена пока не поддерживается',
      );
    }
    const [slots] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(waybillRequests)
      .where(eq(waybillRequests.waybillId, existing.id));
    const used = slots?.used ?? 0;
    if (used >= MAX_SLOTS) {
      throw err.conflict(`В листе уже ${MAX_SLOTS} талона заказчиков — больше бланк не держит`);
    }
    await tx
      .insert(waybillRequests)
      .values({ waybillId: existing.id, requestId: ctx.requestId, slot: used + 1 });
    return {
      id: existing.id,
      number: String(existing.number),
      slot: used + 1,
      reused: true,
    };
  }

  const series = await findSeriesByCode(DEFAULT_SERIES_CODE);
  if (!series) throw err.conflict('Не заведена серия путевых листов');
  const number = await takeNextNumber(tx, series.id);
  const organizationId = await resolveOrganization(tx, ctx.vehicleId);

  const data = await collectSnapshot(tx, {
    requestId: ctx.requestId,
    vehicleId: ctx.vehicleId,
    driverPersonId: ctx.driverPersonId,
    organizationId,
    fields: ctx.fields,
    number: number.display,
    date,
    actorName: ctx.actor.name,
  });

  const [created] = await tx
    .insert(waybills)
    .values({
      seriesId: number.seriesId,
      number: number.number,
      formCode: requirement.formCode,
      organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.driverPersonId,
      issuedForDate: date,
      withTrailer: ctx.fields?.withTrailer ?? false,
      trailer1Model: ctx.fields?.trailer1Model ?? '',
      trailer1RegNumber: ctx.fields?.trailer1RegNumber ?? '',
      trailer2Model: ctx.fields?.trailer2Model ?? '',
      trailer2RegNumber: ctx.fields?.trailer2RegNumber ?? '',
      garageNumber: data.vehicle_garage_number ?? '',
      communicationKind: ctx.fields?.communicationKind ?? '',
      transportationKind: ctx.fields?.transportationKind ?? '',
      data,
      issuedBy: ctx.actor.id,
    })
    .returning({ id: waybills.id });

  await tx
    .insert(waybillRequests)
    .values({ waybillId: created!.id, requestId: ctx.requestId, slot: 1 });

  return { id: created!.id, number: number.display, slot: 1, reused: false };
}

/**
 * Реквизиты прошлого листа этой машины — ими форма подставляет графы шапки. Гаражный номер, вид
 * сообщения и прицепы от рейса к рейсу те же, и перенабирать их каждый раз незачем.
 */
export async function lastWaybillFields(vehicleId: string): Promise<WaybillFieldsInput | null> {
  const [row] = await db
    .select({
      withTrailer: waybills.withTrailer,
      trailer1Model: waybills.trailer1Model,
      trailer1RegNumber: waybills.trailer1RegNumber,
      trailer2Model: waybills.trailer2Model,
      trailer2RegNumber: waybills.trailer2RegNumber,
      garageNumber: waybills.garageNumber,
      communicationKind: waybills.communicationKind,
      transportationKind: waybills.transportationKind,
    })
    .from(waybills)
    .where(and(eq(waybills.vehicleId, vehicleId), isNull(waybills.cancelledAt)))
    .orderBy(desc(waybills.issuedForDate))
    .limit(1);
  return row ?? null;
}
