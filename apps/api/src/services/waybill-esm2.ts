import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import {
  type Esm2Period,
  esm2Periods,
  esm2Required,
  esm2SyncPlan,
  esm2WeekDays,
  moscowDateKeyOf,
  type VehicleOwnership,
  waybillDisplayNumber,
  type WaybillSnapshotKey,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  organizations,
  specialEquipmentRequestDetails,
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicles,
  waybillRequests,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { findMachinist } from './drivers';
import { findSeriesByCode, seriesCodeOfForm, takeNextNumber } from './waybill-numbers';

/**
 * Путевой лист ЭСМ-2: неделя работы строительной машины на площадке (миграция 0087).
 *
 * Отличие от 4-П не в графах, а в том, кто ведёт документ. Лист на рейс выписывает человек —
 * отдельным действием, когда состав рейса собран. ЭСМ-2 ведёт портал: заявку берут в работу, и
 * листы на все недели её срока рождаются сами; срок меняется — листы переписываются; заявку
 * отменяют — аннулируются. Ручной выдачи у этого бланка нет вовсе.
 *
 * Отсюда единственный вход наружу — `syncEsm2Waybills`: сверка «что должно быть» с «что есть».
 * Пять мест зовут её по одному поводу — «состояние заявки изменилось», — и ни одно из них не
 * решает само, что делать с бумагой.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const FORM_CODE = 'esm2' as const;

/** Сегодня по МСК: им отделяются отработанные недели от предстоящих. */
function today(): string {
  return moscowDateKeyOf(new Date());
}

/** Состояние заявки, по которому считается нужный набор листов. */
interface RequestState {
  id: string;
  requestType: 'special_equipment' | 'freight_transport';
  status: 'new' | 'confirmed' | 'done' | 'cancelled';
  deletedAt: Date | null;
  objectId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  vehicleId: string | null;
  ownership: VehicleOwnership | null;
}

async function loadRequest(tx: Tx, requestId: string): Promise<RequestState | null> {
  const [row] = await tx
    .select({
      id: vehicleRequests.id,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      objectId: vehicleRequests.objectId,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      vehicleId: vehicleRequestAssignments.vehicleId,
      ownership: vehicles.ownership,
    })
    .from(vehicleRequests)
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  return row ?? null;
}

/** Действующие листы заявки — то, с чем сверяется нужный набор недель. */
async function activeSheets(tx: Tx, requestId: string) {
  return tx
    .select({
      id: waybills.id,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      vehicleId: waybills.vehicleId,
      driverPersonId: waybills.driverPersonId,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(and(eq(waybills.sourceRequestId, requestId), ne(waybills.status, 'cancelled')))
    .orderBy(waybills.periodFrom);
}

/**
 * Машинист, которого унаследуют новые листы: тот, что стоит в последнем листе этой заявки —
 * действующем или аннулированном.
 *
 * Аннулированные читаются наравне с действующими намеренно: сверка сначала списывает лист, а
 * потом выписывает новый, и на второй половине этой работы «последний лист» уже аннулирован.
 * Человек при этом не менялся — менялся срок или машина.
 */
async function lastMachinistOf(tx: Tx, requestId: string): Promise<string | null> {
  const [row] = await tx
    .select({ driverPersonId: waybills.driverPersonId })
    .from(waybills)
    .where(eq(waybills.sourceRequestId, requestId))
    .orderBy(desc(waybills.issuedAt))
    .limit(1);
  return row?.driverPersonId ?? null;
}

/** Двузначный день месяца из календарного ключа: «2026-08-31» → «31». */
function dayOf(dateKey: string): string {
  return dateKey.slice(8, 10);
}

/**
 * Номер месяца для графы «Период работы: … месяца __».
 *
 * Клетка в бланке одна, а неделя по границе месяца не дробится (лист остаётся одним документом,
 * потому что бланк — это календарная неделя). У недели, перешедшей в следующий месяц, печатаются
 * оба номера: «08–09». Ширина графы это держит — объединение BK11:BO11 в 13 знаков.
 */
function monthOf(period: Esm2Period): string {
  const from = period.from.slice(5, 7);
  const to = period.to.slice(5, 7);
  return from === to ? from : `${from}–${to}`;
}

/**
 * Значения бланка снимком (ADR 0037 п. 10): лист печатается из этого объекта, а не из
 * справочников, поэтому переименование объекта задним числом уже выданный документ не меняет.
 *
 * Собирается своим сбором, а не общим с 4-П: у листов не совпадает ни источник (заявка против
 * рейса), ни единица (неделя против дня), ни набор граф — здесь нет ни груза, ни задания, ни
 * СНИЛС с удостоверением, зато есть семь строк недели и код объекта затрат.
 */
async function collectSnapshot(
  tx: Tx,
  params: {
    requestId: string;
    vehicleId: string;
    driverPersonId: string;
    organizationId: string;
    period: Esm2Period;
    number: string;
    seriesPrefix: string;
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

  // Заказчик здесь всегда объект: заказать технику на площадку отдел не может (ADR 0040), и
  // телефон в графе — ответственного за встречу машины, а не организации.
  const [request] = await tx
    .select({
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, params.requestId));

  // Машинист — снимком, как и всё остальное: человека переведут, а лист остаётся с тем, кто
  // работал. Документов от него не требуется вовсе (в бланке нет ни СНИЛС, ни удостоверения).
  const machinist = await findMachinist(tx, params.driverPersonId);

  const objectLine = [request?.objectName, request?.objectAddress].filter(Boolean).join(', ');
  // Семь строк недели: числа месяца — все, объект — только в дни срока заявки. Пустая графа
  // означает «портал не знает, работала ли машина в этот день», и утверждать этого он не станет.
  const days = esm2WeekDays(params.period);
  const dayValues = Object.fromEntries(
    days.flatMap((day, index) => [
      [`day${index + 1}_date`, dayOf(day.date)],
      [`day${index + 1}_object`, day.inPeriod ? objectLine : ''],
    ]),
  ) as Record<string, string>;

  const [yyyy, mm, dd] = params.period.from.split('-') as [string, string, string];

  return {
    org_name: org?.name ?? '',
    org_address: org?.address ?? '',
    org_phone: org?.phone ?? '',
    org_okpo: org?.okpo ?? '',
    org_ogrn: org?.ogrn ?? '',

    waybill_series: params.seriesPrefix,
    waybill_number: params.number,
    // Дата составления — первый рабочий день недели: с него лист и начинают вести.
    waybill_date: `${dd}.${mm}.${yyyy}`,
    waybill_date_dd: dd,
    waybill_date_mm: mm,
    waybill_date_yyyy: yyyy,

    vehicle_brand: [vehicle?.manufacturer, vehicle?.modelName].filter(Boolean).join(' ').trim(),
    vehicle_reg_number: vehicle?.registrationNumber ?? '',
    vehicle_garage_number: vehicle?.garageNumber ?? '',
    vehicle_inventory_number: vehicle?.inventoryNumber ?? '',

    // Прицепов у строительной машины на площадке не бывает: она не едет, она работает.
    trailer1_brand: '',
    trailer1_reg_number: '',
    trailer2_brand: '',
    trailer2_reg_number: '',

    driver_fio: machinist?.fullName ?? '',
    driver_personnel_no: machinist?.personnelNo ?? '',
    // Граф СНИЛС, удостоверения и даты его выдачи в бланке ЭСМ-2 нет — машинист работает по
    // удостоверению тракториста-машиниста, которого портал не ведёт (ADR 0055).
    driver_snils: '',
    driver_license_number: '',
    driver_license_issued_on: '',

    // Вид сообщения и вид перевозки — графы рейса; у недели стояния на площадке их нет.
    communication_kind: '',
    transportation_kind: '',

    customer_name: request?.objectName ?? '',
    customer_address: request?.objectAddress ?? '',
    customer_phone: request?.responsiblePhone ?? '',
    object_code: request?.objectCode ?? '',

    period_from_day: dayOf(params.period.from),
    period_to_day: dayOf(params.period.to),
    period_month: monthOf(params.period),
    period_year: params.period.from.slice(0, 4),

    // Задание, груз и время выезда — графы листа на рейс. В ЭСМ-2 задание выражено иначе: строкой
    // «Наименование и адрес объекта» в каждом дне недели.
    task_from: '',
    task_to: '',
    task_cargo: '',
    task_departure_time: '',
    task_departure_hh: '',
    task_departure_mm: '',
    task2_customer: '',
    task2_from: '',
    task2_to: '',
    task2_cargo: '',
    task3_customer: '',
    task3_from: '',
    task3_to: '',
    task3_cargo: '',
    task4_customer: '',
    task4_from: '',
    task4_to: '',
    task4_cargo: '',

    ...dayValues,
  } as Record<WaybillSnapshotKey, string>;
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

/** Выписанный лист: номер уходит в журнал аудита, идентификатор — ссылкой на документ. */
export interface IssuedEsm2 {
  id: string;
  number: string;
  period: Esm2Period;
}

/**
 * Выдача листа на одну неделю. Номер берётся из серии `esm2` — своей у этого бланка: заявка на
 * месяц забирает пять номеров разом, и в общей серии журнал 4-П получал бы дыры от документов,
 * которых в нём нет.
 */
async function issueEsm2Waybill(
  tx: Tx,
  params: {
    requestId: string;
    vehicleId: string;
    driverPersonId: string;
    period: Esm2Period;
    actorId: string;
  },
): Promise<IssuedEsm2> {
  const series = await findSeriesByCode(seriesCodeOfForm(FORM_CODE));
  if (!series) throw err.conflict('Не заведена серия путевых листов ЭСМ-2');
  const number = await takeNextNumber(tx, series.id);
  const organizationId = await resolveOrganization(tx, params.vehicleId);

  const data = await collectSnapshot(tx, {
    requestId: params.requestId,
    vehicleId: params.vehicleId,
    driverPersonId: params.driverPersonId,
    organizationId,
    period: params.period,
    number: number.display,
    seriesPrefix: number.prefix,
  });

  const [created] = await tx
    .insert(waybills)
    .values({
      seriesId: number.seriesId,
      number: number.number,
      formCode: FORM_CODE,
      organizationId,
      // Рейса у недели работы на площадке нет — есть заявка и период (миграция 0087).
      routeId: null,
      sourceRequestId: params.requestId,
      periodFrom: params.period.from,
      periodTo: params.period.to,
      // Дата листа — первый рабочий день недели: журнал, индексы и сортировки работают без правок.
      issuedForDate: params.period.from,
      vehicleId: params.vehicleId,
      driverPersonId: params.driverPersonId,
      garageNumber: data.vehicle_garage_number,
      data,
      issuedBy: params.actorId,
    })
    .returning({ id: waybills.id });

  // Талон заказчика пишется как и раньше: им карточка заявки и журнал находят свои листы.
  // `source_request_id` существует не вместо него, а ради «одна неделя — один действующий лист».
  await tx
    .insert(waybillRequests)
    .values({ waybillId: created!.id, requestId: params.requestId, slot: 1 });

  return { id: created!.id, number: number.display, period: params.period };
}

/** Чем кончилась сверка — этим объясняются исчезнувшие и появившиеся номера в журнале. */
export interface Esm2SyncResult {
  cancelled: string[];
  issued: string[];
}

const EMPTY: Esm2SyncResult = { cancelled: [], issued: [] };

/**
 * Привести листы ЭСМ-2 заявки в соответствие с самой заявкой.
 *
 * Идемпотентна: сошлось — не делает ничего, не жжёт номеров и не пишет событий. Это не украшение,
 * а условие — её зовут и события, которые срока не меняют вовсе (повторный перевод в работу после
 * отката, правка комментария рядом с датами).
 *
 * Выданный лист не правится: изменить содержание можно только аннулированием номера и выпиской
 * нового. Отработанные недели не трогаются вовсе — машина эти дни отстояла, заказчик заполнил
 * оборот, и переписывать это задним числом нельзя.
 *
 * Право на аннулирование здесь не спрашивается (`waybills.cancel`): это не действие человека, а
 * следствие его решения по заявке — право проверено на самом решении. В аудит уходит своё
 * событие: иначе исчезнувшая бумага не объясняется ничем.
 */
export async function syncEsm2Waybills(
  tx: Tx,
  params: {
    requestId: string;
    actor: { id: string };
    /** Почему сверка: попадёт в причину аннулирования и в журнал аудита. */
    reason: string;
    /**
     * Машинист, назначенный этим же действием. Не передан — берётся с прежнего листа заявки:
     * меняли срок или машину, а не человека.
     */
    driverPersonId?: string | null;
  },
): Promise<Esm2SyncResult> {
  const request = await loadRequest(tx, params.requestId);
  if (!request) return EMPTY;

  const required = esm2Required({
    requestType: request.requestType,
    status: request.status,
    ownership: request.ownership,
    deletedAt: request.deletedAt ? request.deletedAt.toISOString() : null,
  });
  const existing = await activeSheets(tx, params.requestId);
  // Заявка листов не требует, а их и нет: самый частый случай — грузоперевозка. Выходим до
  // единственного оставшегося чтения.
  if (!required && existing.length === 0) return EMPTY;

  const wanted = required && request.dateFrom ? esm2Periods(request.dateFrom, request.dateTo) : [];
  const driverPersonId = params.driverPersonId ?? (await lastMachinistOf(tx, params.requestId));

  const plan = esm2SyncPlan({
    wanted,
    existing: existing.map((s) => ({
      id: s.id,
      periodFrom: s.periodFrom!,
      periodTo: s.periodTo!,
      vehicleId: s.vehicleId,
      driverPersonId: s.driverPersonId,
    })),
    vehicleId: request.vehicleId,
    driverPersonId,
    today: today(),
  });
  if (plan.cancel.length === 0 && plan.issue.length === 0) return EMPTY;

  // Машинист нужен до первой же выписки: лист без него бухгалтерия не примет, а графа в бланке
  // одна на всю неделю. Проверка здесь, а не только в форме, — сверку зовут пять мест.
  if (plan.issue.length > 0 && !driverPersonId) {
    throw err.unprocessable(
      'Укажите машиниста — на него выписываются путевые листы ЭСМ-2 за каждую неделю работ',
      { driverPersonId: 'Выберите машиниста' },
    );
  }
  if (plan.issue.length > 0 && !request.vehicleId) {
    throw err.unprocessable('На заявке нет техники — путевой лист выписывать не на что');
  }

  const numbersById = new Map(
    existing.map((s) => [s.id, waybillDisplayNumber(s.prefix, s.number, s.numberWidth)]),
  );
  const cancelled: string[] = [];
  for (const id of plan.cancel) {
    await tx
      .update(waybills)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: params.actor.id,
        cancelReason: params.reason,
        updatedAt: new Date(),
      })
      .where(and(eq(waybills.id, id), ne(waybills.status, 'cancelled')));
    cancelled.push(numbersById.get(id) ?? id);
  }

  const issued: string[] = [];
  for (const period of plan.issue) {
    const created = await issueEsm2Waybill(tx, {
      requestId: params.requestId,
      vehicleId: request.vehicleId!,
      driverPersonId: driverPersonId!,
      period,
      actorId: params.actor.id,
    });
    issued.push(created.number);
  }

  return { cancelled, issued };
}

/**
 * Событие аудита о переписанной бумаге. Пишется после транзакции — как и все прочие события
 * заявки, — и только если что-то действительно изменилось: молчаливая сверка событием не является.
 */
export async function auditEsm2Sync(params: {
  actorUserId: string;
  requestId: string;
  reason: string;
  result: Esm2SyncResult;
}): Promise<void> {
  if (params.result.cancelled.length === 0 && params.result.issued.length === 0) return;
  await writeAudit({
    actorUserId: params.actorUserId,
    action: 'waybill.esm2_sync',
    entityType: 'vehicle_request',
    entityId: params.requestId,
    metadata: {
      reason: params.reason,
      cancelled: params.result.cancelled,
      issued: params.result.issued,
    },
  });
}

/**
 * Есть ли у заявки хоть один лист ЭСМ-2 — действующий или аннулированный.
 *
 * Спрашивает перевод заявки в работу: машинист обязателен ровно тогда, когда листы будут
 * выписываться, а брать его неоткуда — прежних листов нет.
 */
export async function hasEsm2Waybills(tx: Tx, requestId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: waybills.id })
    .from(waybills)
    .where(and(eq(waybills.sourceRequestId, requestId), isNotNull(waybills.periodFrom)))
    .limit(1);
  return !!row;
}
