import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import {
  type Esm2Period,
  esm2Mode,
  esm2Periods,
  esm2RequestedPeriods,
  esm2SyncPlan,
  esm2WeekDays,
  formatPhone,
  licenseNumberLabel,
  moscowDateKeyOf,
  requestStatusLabels,
  type VehicleOwnership,
  waybillDisplayNumber,
  type WaybillSnapshotKey,
  weekStartKey,
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
  vehicleTypes,
  waybillRequests,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { findMachinist } from './drivers';
// Что операция коррекции делает с листом (ADR 0101): списание ссылкой на операцию и пометка
// рождённого ею номера. Своего кода на это у сверки нет намеренно — правило «лист помнит, какой
// операцией он рождён и какой списан» одно на все входы, и второе его написание разошлось бы.
import { cancelWaybillForCorrection } from './waybill-correction';
import { markCorrectionWaybill } from './vehicle-route-correction';
import { findSeriesByCode, seriesCodeOfForm, takeNextNumber } from './waybill-numbers';

/**
 * Путевой лист ЭСМ-2: неделя работы строительной машины на площадке (миграция 0087).
 *
 * Отличие от 4-П не в графах, а в том, кто ведёт документ. Лист на рейс выписывает человек —
 * отдельным действием, когда состав рейса собран. ЭСМ-2 ведёт портал: заявку берут в работу, и
 * листы на все недели её срока рождаются сами; срок меняется — листы переписываются; заявку
 * отменяют — аннулируются.
 *
 * Отсюда главный вход наружу — `syncEsm2Waybills`: сверка «что должно быть» с «что есть». Пять
 * мест зовут её по одному поводу — «состояние заявки изменилось», — и ни одно из них не решает
 * само, что делать с бумагой.
 *
 * Второй вход появился вместе с линейной техникой (ADR 0100): у заказа линейного типа недели
 * стояния на площадке нет вовсе — машина вечером возвращается на базу, — и портал недельных
 * листов ему не выписывает. Нужен лист — человек просит его сам, неделю за неделей
 * (`issueEsm2OnDemand`). Сверка при этом не выключается: выданный бланк строгой отчётности не
 * вправе разойтись с заявкой, и уже выписанное она ведёт наравне с автоматическим.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/**
 * Читающим функциям транзакция не нужна: окно коррекции спрашивает «что операция сделает с
 * бумагой» до того, как открыта хоть одна транзакция (Р36).
 */
type Reader = Tx | typeof db;

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
  /** Линейный ли заказанный тип (ADR 0100 §1) и как он называется — им объясняется отказ. */
  isLinear: boolean;
  vehicleTypeName: string;
}

async function loadRequest(reader: Reader, requestId: string): Promise<RequestState | null> {
  const [row] = await reader
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
      isLinear: vehicleTypes.isLinear,
      vehicleTypeName: vehicleTypes.name,
    })
    .from(vehicleRequests)
    /*
     * Признак линейности — у **заказанного** типа, а не у типа назначенной машины (ADR 0100 §1).
     * Разница видна ровно там, где заявку закрыли машиной соседнего типа (ADR 0059): режим
     * документооборота задаёт заказ, и меняться от подбора единицы он не вправе — иначе замена
     * машины на ходу превратила бы недельную заявку в дневную.
     *
     * Join обычный, а не левый: `vehicle_type_id` у заявки NOT NULL, и заявки без типа не бывает.
     * Снимка признака в заявке нет намеренно — справочник и есть то место, где на этот вопрос
     * отвечают, а сменить признак под работающими заказами портал не даёт (`vehicle-types.ts`).
     */
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
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
async function activeSheets(reader: Reader, requestId: string) {
  return reader
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
 * рейса), ни единица (неделя против дня), ни набор граф — здесь нет ни груза, ни задания, ни граф
 * СНИЛС и удостоверения, зато есть семь строк недели и код объекта затрат.
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
  // работал. Документ берётся по должности и на начало недели: она и есть дата листа, а годность
  // проверяется на неё же — лист выписывается вперёд, и «годен сегодня» тут ничего не значит.
  const machinist = await findMachinist(tx, params.driverPersonId, params.period.from);

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
    // Телефоны бланка — единым видом (ADR 0066). Реквизит организации при этом бывает и не одним
    // номером («(495) …, +7-985-…» у основной): такую запись `formatPhone` печатает как есть.
    org_phone: formatPhone(org?.phone ?? ''),
    org_okpo: org?.okpo ?? '',
    org_ogrn: org?.ogrn ?? '',

    waybill_series: params.seriesPrefix,
    waybill_number: params.number,
    // Дата составления — первый рабочий день недели: с него лист и начинают вести.
    waybill_date: `${dd}.${mm}.${yyyy}`,
    waybill_date_dd: dd,
    waybill_date_mm: mm,
    waybill_date_yyyy: yyyy,

    // «Машина (наименование, марка)» — запись справочника марок/моделей (ADR 0007), и только она.
    // Изготовитель («Клинцовский автокрановый завод») — реквизит машины, а не её марка: в графу
    // шириной в пару сантиметров он не влезает и вытесняет из неё то, ради чего она заведена.
    // Модели у машины нет — печатается пусто: допишут от руки, придумывать марку портал не станет.
    vehicle_brand: vehicle?.modelName ?? '',
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
    // СНИЛС здесь пуст: графы под него в бланке ЭСМ-2 нет, и реквизит этот — 4-П (приказ Минтранса
    // № 390), а не недельного листа работы машины. `findMachinist` его и не читает.
    driver_snils: '',
    /*
     * Удостоверение портал теперь ведёт: по должности машинисту требуется либо водительское, либо
     * тракториста-машиниста (миграция 0123, ADR 0095), и `findMachinist` отдаёт то из них, которым
     * человек допущен и которое годно на начало недели. Годного нет — графы пусты, как и у 4-П
     * (ADR 0064): выписку это не останавливает.
     *
     * Печатать эти значения бланк всё равно не будет: форма Госкомстата граф под удостоверение не
     * содержит, и клетки в шаблоне не размечены намеренно (`mark-waybill-templates.ts`) — это
     * решение, а не недоделка. В ключи они кладутся потому, что снимок листа обязан помнить, по
     * какому документу работали, независимо от того, какие клетки размечены в шаблоне: разметку
     * правят отдельно от выписки, а выданный лист не переписывается.
     */
    driver_license_number: machinist?.license ? licenseNumberLabel(machinist.license) : '',
    driver_license_issued_on: machinist?.license?.issuedOn ?? '',

    // Вид сообщения и вид перевозки — графы рейса; у недели стояния на площадке их нет.
    communication_kind: '',
    transportation_kind: '',

    customer_name: request?.objectName ?? '',
    customer_address: request?.objectAddress ?? '',
    customer_phone: formatPhone(request?.responsiblePhone ?? ''),
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
    // Контакты концов маршрута — графа рейса: у недели на площадке конец один, и его человек
    // печатается графой «Заказчик» вместе с адресом объекта (`customer_phone` выше).
    task_contacts: '',
    task_departure_time: '',
    task2_from: '',
    task2_to: '',
    task2_cargo: '',
    task2_contacts: '',
    task3_from: '',
    task3_to: '',
    task3_cargo: '',
    task3_contacts: '',
    task4_from: '',
    task4_to: '',
    task4_cargo: '',
    task4_contacts: '',

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
    /**
     * Контекст проверенной операции коррекции (ADR 0101, Р8, Р11, Р21). Приходит только оттуда,
     * где право `waybills.correct`, причина и глубина уже спрошены — из тела запроса он не
     * собирается никогда: тело перечисляет намерение, а не разрешение.
     *
     * Меняет у сверки ровно три вещи, и каждая — снятие неприкосновенности прошлого:
     *
     * - названные листы отработанных недель перестают быть неприкасаемыми (`unlockWaybillIds`);
     * - прошедшая неделя, листа не имевшая, становится выписываемой (дыра 3 из §1 плана);
     * - и списанный, и выписанный номер получают ссылку на операцию, а причина операции ложится
     *   в оба листа (Р35) — иначе разрыв нумерации за прошедший день не объясняется ничем.
     *
     * Без контекста сверка ведёт себя ровно как прежде: отработанная неделя не трогается, а
     * прошедшая без листа не выписывается вовсе.
     */
    correction?: {
      /** Строка `waybill_corrections` этой операции: на неё ссылаются оба листа. */
      id: string;
      /** Листы, которые операция назвала поимённо; принадлежность их заявке проверил вызывающий. */
      unlockWaybillIds: readonly string[];
    };
  },
): Promise<Esm2SyncResult> {
  const request = await loadRequest(tx, params.requestId);
  if (!request) return EMPTY;

  const mode = esm2Mode({
    requestType: request.requestType,
    status: request.status,
    ownership: request.ownership,
    deletedAt: request.deletedAt ? request.deletedAt.toISOString() : null,
    isLinear: request.isLinear,
  });
  const existing = await activeSheets(tx, params.requestId);
  // Заявке листов не положено, а их и нет: самый частый случай — грузоперевозка. Выходим до
  // единственного оставшегося чтения.
  if (mode === 'none' && existing.length === 0) return EMPTY;

  const sheets = existing.map((s) => ({
    id: s.id,
    periodFrom: s.periodFrom!,
    periodTo: s.periodTo!,
    vehicleId: s.vehicleId,
    driverPersonId: s.driverPersonId,
  }));
  /*
   * Набор нужных недель. В `auto` его задаёт срок заявки — портал сам решает, сколько бумаги ей
   * нужно. В `on_demand` решения у портала нет вовсе: недели называет человек, и единственный
   * след его просьбы — сами выписанные листы, подрезанные сроком (ADR 0100 §5).
   */
  const wanted =
    mode === 'none' || !request.dateFrom
      ? []
      : mode === 'auto'
        ? esm2Periods(request.dateFrom, request.dateTo)
        : esm2RequestedPeriods(sheets, request.dateFrom, request.dateTo);
  /*
   * Машинист заявки. В `auto` он один на все её недели: не назван этим действием — берётся с
   * прежнего листа (меняли срок или машину, а не человека).
   *
   * В `on_demand` «машиниста заявки» не существует: его называют на каждую неделю отдельно
   * (ADR 0100 §6), и наследование с последнего листа пересадило бы на все недели того, кто
   * отработал одну. Поэтому там человек берётся только из самого действия, а сверка, получив
   * `null`, оставляет каждой неделе своего (`esm2SyncPlan`).
   */
  const driverPersonId =
    mode === 'on_demand'
      ? (params.driverPersonId ?? null)
      : (params.driverPersonId ?? (await lastMachinistOf(tx, params.requestId)));

  const plan = esm2SyncPlan({
    mode,
    wanted,
    existing: sheets,
    vehicleId: request.vehicleId,
    driverPersonId,
    today: today(),
    // Оба ключа коррекции идут вместе и порознь не работают (Р11): разблокировав лист, но не
    // разрешив прошедшую неделю, сверка аннулировала бы номер и не выписала замены.
    unlockWaybillIds: params.correction?.unlockWaybillIds,
    correction: params.correction ? { allowed: true } : undefined,
  });
  if (plan.cancel.length === 0 && plan.issue.length === 0) return EMPTY;

  /*
   * Кем выписывать замену сгоревшему номеру.
   *
   * Названный действием машинист старше всего: человек только что сказал, кем теперь ведут
   * заявку. Не назван — замена печатает того же, кто стоял в аннулированном листе этой недели:
   * в `auto` это тот же человек, что и на всей заявке, а в `on_demand` — единственный ответ,
   * какой у портала есть (ADR 0083 — своей волей людей он не подставляет).
   */
  const burning = new Set(plan.cancel);
  const burnedOfWeek = new Map<string, { id: string; driverPersonId: string; vehicleId: string }>();
  for (const sheet of sheets) {
    if (burning.has(sheet.id)) {
      burnedOfWeek.set(weekStartKey(sheet.periodFrom), {
        // Идентификатор сгоревшего листа нужен коррекции: новый номер объявляет себя заменой
        // именно ему (`corrects_waybill_id`, Р32), и без этой ссылки разрыв нумерации за
        // прошедшую неделю в журнале не читается.
        id: sheet.id,
        driverPersonId: sheet.driverPersonId,
        vehicleId: sheet.vehicleId,
      });
    }
  }
  const machinistFor = (period: Esm2Period): string | null =>
    driverPersonId ?? burnedOfWeek.get(weekStartKey(period.from))?.driverPersonId ?? null;

  /*
   * На какой машине выписывать замену.
   *
   * В `auto` это машина заявки: она одна, и переоформление как раз ею и вызвано — назначили
   * другую технику, значит и бумага переписывается на неё.
   *
   * В `on_demand` — та, что стояла в сгоревшем листе этой недели. Машину такого листа выбрал
   * человек (ADR 0100 §7), и подмена её машиной назначения означала бы, что портал переписал
   * недельный отчёт второй единицы на первую: моточасы, объект и подпись заказчика на обороте
   * относятся к той машине, которая там работала. Своих недель режим не заводит, поэтому лист
   * без предшественника здесь невозможен, а `??` оставлен на случай, если он появится.
   */
  const vehicleFor = (period: Esm2Period): string | null =>
    (mode === 'on_demand' ? burnedOfWeek.get(weekStartKey(period.from))?.vehicleId : null) ??
    request.vehicleId;

  // Машинист нужен до первой же выписки: лист без него бухгалтерия не примет, а графа в бланке
  // одна на всю неделю. Проверка здесь, а не только в форме, — сверку зовут пять мест.
  //
  // У линейного заказа она не срабатывает никогда, и это не случайность: своих недель `on_demand`
  // не заводит, а у каждой переоформляемой машинист уже напечатан в сгоревшем листе. Требование
  // «укажите машиниста» осталось ровно там, где листы рождаются сами.
  if (plan.issue.some((period) => !machinistFor(period))) {
    throw err.unprocessable(
      'Укажите машиниста — на него выписываются путевые листы ЭСМ-2 за каждую неделю работ',
      { driverPersonId: 'Выберите машиниста' },
    );
  }
  // Машина нужна тем же порядком, что и машинист: у линейного заказа её несёт переоформляемый
  // лист, у обычного — назначение, и пустой ответ означает, что выписывать не на что.
  if (plan.issue.some((period) => !vehicleFor(period))) {
    throw err.unprocessable('На заявке нет техники — путевой лист выписывать не на что');
  }

  const numbersById = new Map(
    existing.map((s) => [s.id, waybillDisplayNumber(s.prefix, s.number, s.numberWidth)]),
  );
  const cancelled: string[] = [];
  for (const id of plan.cancel) {
    if (params.correction) {
      // Списание в рамках операции: причина ложится в `cancel_reason`, а ссылка на операцию — в
      // свою колонку (`cancel_correction_id`), рядом с «кем и когда». В `correction_id` её писать
      // нельзя: там стоит операция, **породившая** номер, и у листа бывают обе сразу (Р12).
      await cancelWaybillForCorrection(tx, {
        waybillId: id,
        correctionId: params.correction.id,
        reason: params.reason,
        actorUserId: params.actor.id,
      });
    } else {
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
    }
    cancelled.push(numbersById.get(id) ?? id);
  }

  const issued: string[] = [];
  /** Сгоревшие номера, у которых замена уже нашлась: связь «заменил» одна на номер (Р32). */
  const replacedBy = new Set<string>();
  for (const period of plan.issue) {
    const created = await issueEsm2Waybill(tx, {
      requestId: params.requestId,
      vehicleId: vehicleFor(period)!,
      driverPersonId: machinistFor(period)!,
      period,
      actorId: params.actor.id,
    });
    if (params.correction) {
      /*
       * Номер, рождённый операцией, объяснён и связан (Р35): причина операции — в
       * `correction_reason`, ссылка на операцию — в `correction_id`, заменённый номер — в
       * `corrects_waybill_id`. Последнего может и не быть: неделя, у которой листа не было вовсе
       * (дыра 3), заменяет пустоту, и `waybills_correction_issue_reason_check` этого не требует.
       *
       * Предшественник достаётся ровно одному наследнику: `waybills_corrects_unique` держит
       * «каждый номер заменён не более одного раза», а в одну календарную неделю попадают и два
       * выписываемых отрезка сразу (лист «пн–ср» и лист «чт–вс» после подрезки срока). Второй из
       * них объявил бы себя заменой тому же листу — и операция упала бы уже после сгоревших
       * номеров. Карта при этом не трогается: из неё же берутся машина и машинист замены.
       */
      const replaced = burnedOfWeek.get(weekStartKey(period.from));
      const correctsWaybillId = replaced && !replacedBy.has(replaced.id) ? replaced.id : null;
      if (correctsWaybillId) replacedBy.add(correctsWaybillId);
      await markCorrectionWaybill(tx, {
        waybillId: created.id,
        correctionId: params.correction.id,
        reason: params.reason,
        correctsWaybillId,
      });
    }
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

/** Календарный ключ `YYYY-MM-DD` человеку: «24.07.2026». Через JS Date он бы поехал на день. */
function dateRu(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

// ── Что коррекция назначения сделает с бумагой (ADR 0101, Р8, Р36) ──

/** Действующий лист заявки глазами коррекции: номером его называет и окно, и отказ. */
export interface Esm2SheetRef {
  id: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке. */
  number: string;
  periodFrom: string;
  periodTo: string;
  vehicleId: string;
}

export interface Esm2CorrectionScope {
  /** Все действующие листы ЭСМ-2 заявки: из них выбирают разблокируемые и ими объясняют отказ. */
  sheets: Esm2SheetRef[];
  /**
   * Прошедшие недели срока, у которых действующего листа нет вовсе, — те, что операция выпишет
   * сама, получив контекст (дыра 3 из §1 плана). Считаются по **будущему** состоянию заявки:
   * заказ, который вели арендной техникой, а закрывают своей, обязан получить бумагу за уже
   * отработанные недели, и её глубину нужно знать до операции, а не после.
   */
  pastWeeks: Esm2Period[];
}

/**
 * Что коррекция назначения задним числом задела бы в прошлом — посчитанное **до** первой правки
 * (Р36) и без единой транзакции.
 *
 * Нужна она ради одного вопроса: какая у операции эффективная дата. По таблице §4 плана у листа
 * ЭСМ-2 это `periodTo` — и у существующего, который переписывают, и у прошедшей недели, которой
 * листа не было. Ошибиться в ней значит сдвинуть границу глубины (Р9) целиком, поэтому обе
 * половины ответа собираются здесь, а не считаются заново на каждом входе.
 *
 * Режим (`esm2Mode`) считается с **будущей** принадлежностью машины, а не с нынешней: смена
 * арендной единицы на собственную переводит заявку из `none` в `auto`, то есть заводит бумагу
 * там, где её не было вовсе, — и не спросить о глубине этих недель значило бы выписать бланк
 * трёхмесячной давности без единой проверки.
 *
 * Прошедшая неделя, у которой лист есть (хоть названный, хоть нет), в `pastWeeks` не попадает
 * намеренно: названный приходит в счёт своим `periodTo`, а неназванный неделю запирает — сверка её
 * не тронет вовсе (`esm2SyncPlan`, `locked`).
 */
export async function esm2CorrectionScope(
  reader: Reader,
  params: {
    requestId: string;
    /** Принадлежность машины, которую назначают этой же операцией. */
    ownership: VehicleOwnership;
    /** Сегодня по МСК: им отделяются отработанные недели от предстоящих. */
    today: string;
  },
): Promise<Esm2CorrectionScope> {
  const request = await loadRequest(reader, params.requestId);
  if (!request) return { sheets: [], pastWeeks: [] };

  const rows = await activeSheets(reader, params.requestId);
  const sheets = rows
    .filter((s) => s.periodFrom && s.periodTo)
    .map((s) => ({
      id: s.id,
      number: waybillDisplayNumber(s.prefix, s.number, s.numberWidth),
      periodFrom: s.periodFrom!,
      periodTo: s.periodTo!,
      vehicleId: s.vehicleId,
    }));

  const mode = esm2Mode({
    requestType: request.requestType,
    status: request.status,
    ownership: params.ownership,
    deletedAt: request.deletedAt ? request.deletedAt.toISOString() : null,
    isLinear: request.isLinear,
  });
  // Своих недель `on_demand` не заводит (ADR 0100 §5): у линейного заказа бумагу называет человек,
  // и «недели без листа» у него не бывает по определению — есть недели, о которых не просили.
  const covered = new Set(sheets.map((s) => weekStartKey(s.periodFrom)));
  const pastWeeks =
    mode === 'auto' && request.dateFrom
      ? esm2Periods(request.dateFrom, request.dateTo).filter(
          (p) => p.to < params.today && !covered.has(weekStartKey(p.from)),
        )
      : [];
  return { sheets, pastWeeks };
}

// ── Выписка по требованию: линейный заказ (ADR 0100 §6) ──

/**
 * Почему по этой заявке нельзя выписать ЭСМ-2 руками; `null` — можно.
 *
 * Причины называются словами и по одной: человек нажал кнопку в карточке заявки, и «нельзя»
 * без объяснения он прочтёт как поломку портала.
 *
 * Строже `esm2Mode` ровно в одном месте — закрытая заявка. Сверка её листы ведёт (работа
 * состоялась, выданная бумага остаётся выданной), но выписывать по ней **новые** бланки уже
 * нечего: неделя, за которую никто не попросил лист, прошла вместе с заявкой.
 */
function onDemandRefusal(request: RequestState): string | null {
  if (request.requestType !== 'special_equipment') {
    return 'Лист ЭСМ-2 выписывают по заказу техники на объект: у грузоперевозки лист выписывается с рейса';
  }
  if (request.deletedAt) {
    return 'Заявка в архиве — бланки строгой отчётности по ней не выписывают';
  }
  if (request.status !== 'confirmed') {
    return `Заявка в статусе «${requestStatusLabels[request.status]}» — лист ЭСМ-2 выписывают по заявке в работе`;
  }
  if (!request.isLinear) {
    return `Тип «${request.vehicleTypeName}» не линейный: листы ЭСМ-2 по такому заказу портал выписывает сам, на каждую неделю срока — просить их не нужно`;
  }
  if (!request.vehicleId) {
    return 'На заявку не назначена техника — путевой лист выписывать не на что';
  }
  if (request.ownership !== 'own') {
    return 'Заявку ведут арендной техникой — путевой лист на неё выписывает арендодатель';
  }
  if (!request.dateFrom) {
    return 'У заказа не заполнен срок работ — неделю листа считать не от чего';
  }
  return null;
}

/**
 * Неделя, которую выписала бы ручная выдача, — посчитанная **до** транзакции и без единой правки.
 *
 * Нужна ради одного вопроса, и вопрос этот тот же, что у коррекции назначения: какая у операции
 * эффективная дата. По таблице §4 плана у листа ЭСМ-2 это `periodTo` — и у существующего, который
 * переписывают, и у прошедшей недели, которой листа не было. Понедельник как ключ отвергнут там же
 * и по той же причине: `canCancelWaybill` считает конец недели по `periodTo`, и второй расчёт
 * разошёлся бы с первым на шесть дней.
 *
 * `null` означает «выписывать по этой заявке нечего» — не та заявка, не в работе, арендная, без
 * срока или названный день лежит вне срока. Заднего числа у такой просьбы нет: бланк не родится
 * вовсе, а причину отказа назовёт словами сама выписка (`onDemandRefusal`). Спрашивать право
 * раньше этих слов значило бы отвечать «нет права на прошлое» там, где верный ответ — «по этой
 * заявке листы выписывает портал сам».
 */
export async function esm2OnDemandPeriod(
  reader: Reader,
  params: { requestId: string; weekOf: string },
): Promise<Esm2Period | null> {
  const request = await loadRequest(reader, params.requestId);
  return request ? onDemandPeriodOf(request, params.weekOf) : null;
}

/** Неделя просьбы: календарная неделя названного дня, обрезанная сроком заявки (ADR 0100 §5). */
function onDemandPeriodOf(request: RequestState, weekOf: string): Esm2Period | null {
  if (onDemandRefusal(request)) return null;
  return (
    esm2Periods(request.dateFrom!, request.dateTo).find((p) => p.from <= weekOf && weekOf <= p.to) ??
    null
  );
}

/**
 * Выписать недельный лист ЭСМ-2 по требованию — одна неделя линейного заказа (ADR 0100 §6).
 *
 * Второй и единственный, кроме сверки, вход к этому бланку. Появился он потому, что у линейной
 * техники недели стояния на площадке нет вовсе: машина вечером возвращается на базу, за день
 * успевает поработать на нескольких объектах, и выписанный наперёд недельный лист утверждал бы
 * работу, которой не было. Нужен ли бланк за эту неделю, знает только человек.
 *
 * Границы недели считает сервер — тем же `esm2Periods`, которым выписывает автомат: неделя
 * обрезается сроком заявки с обоих концов, и присланная клиентом пара границ разошлась бы с
 * выпиской на первом же сроке, начавшемся посреди недели. От человека приходит **день**, а не
 * период: он выбирает строку недели, а не заполняет графу «Период работы».
 *
 * Дальше лист живёт наравне с выписанным автоматом: сменят машину — сверка его переоформит,
 * сократят срок — подрежет, отменят заявку — аннулирует (`syncEsm2Waybills`). Ручная выдача
 * добавила бланку одну дверь, а не вывела его из документооборота.
 *
 * Прошедшая неделя (ADR 0101 п. 4, дыра 3 плана) выписывается здесь же и той же работой — но уже
 * операцией: право, глубину и причину спрашивает ручка (`backdateGuard`), а сюда приходит готовый
 * контекст. Своей проверки заднего числа у сервиса нет намеренно — субъекта он не знает, а второе
 * правило границы разошлось бы с первым; из тела запроса контекст не собирается никогда: тело
 * перечисляет намерение, а не разрешение (тем же порядком устроена сверка).
 */
export async function issueEsm2OnDemand(
  tx: Tx,
  params: {
    requestId: string;
    /** День, которым человек назвал неделю; границы считает сервер. */
    weekOf: string;
    vehicleId: string;
    driverPersonId: string;
    actor: { id: string };
    /**
     * Конец недели, по которому вызывающий спросил право (`esm2OnDemandPeriod`); `null` — он
     * насчитал, что выписывать нечего.
     *
     * Сверяется с неделей, посчитанной здесь: между чтением и транзакцией срок заявки успевают
     * подрезать или продлить, а от конца недели зависит, обычная это выдача или операция. Вердикт
     * по устаревшей неделе выписал бы прошедший бланк без права и без причины — то есть ровно ту
     * дыру, которую закрывает ADR 0101. Тем же приёмом перечитывает дату рейса выписка листа по
     * рейсу, только там граница берётся под блокировкой, а здесь расхождение ловится сверкой:
     * заявку под блокировку эта ручка не берёт, а версию заявки двигает сама.
     */
    guardedPeriodTo: string | null;
    /**
     * Контекст проверенной операции коррекции (ADR 0101, Р35): строка `waybill_corrections` и её
     * причина. Приходит только оттуда, где право, причина и глубина уже спрошены. Лист получает
     * `correction_reason` при **пустом** `corrects_waybill_id` — заменять было нечего, номер рождён
     * не взамен другого, — а признак коррекции для фильтра журнала (Р28) считается по ссылке на
     * операцию, иначе такой лист в фильтр не попал бы вовсе.
     */
    correction?: { id: string; reason: string };
  },
): Promise<IssuedEsm2> {
  const request = await loadRequest(tx, params.requestId);
  if (!request) throw err.notFound('Заявка не найдена');
  const refusal = onDemandRefusal(request);
  if (refusal) throw err.unprocessable(refusal);

  // Неделя — ровно та, какую выписал бы автомат: календарная неделя дня, обрезанная сроком.
  const period = onDemandPeriodOf(request, params.weekOf);
  if (!period) {
    const last = request.dateTo || request.dateFrom!;
    throw err.unprocessable(
      `День ${dateRu(params.weekOf)} вне срока заявки (${dateRu(request.dateFrom!)} — ${dateRu(last)}) — выберите день внутри срока`,
      { weekOf: 'День вне срока заявки' },
    );
  }
  if (params.guardedPeriodTo !== period.to) {
    throw err.conflict(
      'Срок заявки изменился, пока выписывался лист, — неделя стала другой: откройте карточку заново',
    );
  }

  // Машина спрашивается, а не берётся из назначения: за неделю на объекте могли отработать две
  // разных, и у каждой свои моточасы (ADR 0100 §7). Проверяется она тем же правилом, что и всюду:
  // в рейсы и в бланки портала ходит только собственная техника.
  const [vehicle] = await tx
    .select({ ownership: vehicles.ownership, deletedAt: vehicles.deletedAt })
    .from(vehicles)
    .where(eq(vehicles.id, params.vehicleId));
  if (!vehicle || vehicle.deletedAt) throw err.badRequest('Техника не найдена');
  if (vehicle.ownership !== 'own') {
    throw err.unprocessable(
      'Машина арендная — путевой лист на неё выписывает арендодатель: выберите собственную технику',
      { vehicleId: 'Арендная техника' },
    );
  }

  /*
   * «Одна неделя — один действующий лист» теперь считается на машину, а не на заявку (миграция
   * 0127): у линейного заказа неделю закрывают две единицы, и каждой нужен свой бланк. Проверка
   * повторяет частичный UNIQUE в базе, но словами: 23505 из индекса человек прочесть не может.
   */
  const existing = await activeSheets(tx, params.requestId);
  const clash = existing.find(
    (s) =>
      s.periodFrom &&
      weekStartKey(s.periodFrom) === weekStartKey(period.from) &&
      s.vehicleId === params.vehicleId,
  );
  if (clash) {
    const number = waybillDisplayNumber(clash.prefix, clash.number, clash.numberWidth);
    throw err.conflict(
      `На эту неделю у выбранной машины уже выписан действующий лист ЭСМ-2 № ${number} (${dateRu(clash.periodFrom!)} — ${dateRu(clash.periodTo!)}) — аннулируйте его, если бланк нужно переоформить`,
    );
  }

  // Машинист — действующий водитель справочника: отбор у ЭСМ-2 свой и никакой (в бланке нет ни
  // СНИЛС, ни граф удостоверения), но человек, которого в справочнике нет, напечатался бы пустой
  // графой ФИО — то есть недействительным бланком.
  const machinist = await findMachinist(tx, params.driverPersonId, period.from);
  if (!machinist) {
    throw err.unprocessable(
      'Выбранный человек не числится водителем в справочнике — на него нельзя выписать путевой лист',
      { driverPersonId: 'Выберите машиниста' },
    );
  }

  const issued = await issueEsm2Waybill(tx, {
    requestId: params.requestId,
    vehicleId: params.vehicleId,
    driverPersonId: params.driverPersonId,
    period,
    actorId: params.actor.id,
  });
  /*
   * Метка коррекции (Р35) — тем же кодом, что и у листа, рождённого сверкой: правило «лист помнит,
   * какой операцией он рождён» одно на все входы, и второе его написание разошлось бы. Заменяемого
   * номера у прошедшей недели нет: листа за неё не было вовсе, и `waybills_correction_issue_reason_check`
   * этого не требует — причина при пустом `corrects_waybill_id` и есть предусмотренная форма.
   */
  if (params.correction) {
    await markCorrectionWaybill(tx, {
      waybillId: issued.id,
      correctionId: params.correction.id,
      reason: params.correction.reason,
      correctsWaybillId: null,
    });
  }
  return issued;
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
