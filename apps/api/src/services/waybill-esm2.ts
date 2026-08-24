import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  driverDocumentGaps,
  driverDocumentGapsWarning,
  type Esm2AckRequiredDetails,
  type Esm2Period,
  esm2Mode,
  esm2Periods,
  esm2RequestedPeriods,
  esm2SyncPlan,
  esm2WeekDays,
  formatNameWithInitials,
  formatPhone,
  formatWaybillDate,
  licenseNumberLabel,
  moscowDateKeyOf,
  requiredCredentialType,
  requestStatusLabels,
  type VehicleOwnership,
  waybillDisplayNumber,
  waybillFormShortLabels,
  type WaybillSnapshotKey,
  type WaybillWarning,
  weekStartKey,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  organizations,
  persons,
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
import { requestIsLinearSql } from '../db/linear-mode';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { findMachinist, type MachinistOption } from './drivers';
// Рукопожатие выписки (Р21а) — общее с листом по рейсу: набор предупреждений у двух бланков разный,
// а решение «пускать, спрашивать или записать подтверждённое» одно, и второе его написание
// разошлось бы с первым на первой же правке.
// Заказчик путевых листов (миграция 0164) читается общей функцией: настройка одна на все бланки, и
// второе её чтение здесь разошлось бы с первым — два листа одного дня назвали бы разных заказчиков.
import { acknowledgeOrThrow, type IssueWarningsRecord, loadWaybillCustomer } from './waybill-issue';
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
      isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear),
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
     *
     * Читается при этом режим **заявки**, а не признак справочника: заявку могло застать
     * переключение (миграция 0137), и до конца работы она ведётся снимком. Живой признак сменил бы
     * недельной заявке режим на ходу — портал перестал бы выписывать ей листы и аннулировал бы уже
     * выданные.
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
  return (
    reader
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
      // Второй ключ порядка обязателен, хотя недели и так не повторяются у обычного заказа. У
      // линейного повторяются: неделю закрывают две машины, и каждой нужен свой лист (ADR 0100 §7).
      // Порядок между ними без `id` не определён, а этот набор целиком уходит в отпечаток
      // предпросмотра последствий — два расчёта одного состояния дали бы разные строки и ложный 409.
      .orderBy(waybills.periodFrom, waybills.id)
  );
}

/**
 * Машинист, которого унаследуют новые листы: тот, что стоит в последнем листе этой заявки —
 * действующем или аннулированном.
 *
 * Аннулированные читаются наравне с действующими намеренно: сверка сначала списывает лист, а
 * потом выписывает новый, и на второй половине этой работы «последний лист» уже аннулирован.
 * Человек при этом не менялся — менялся срок или машина.
 */
async function lastMachinistOf(reader: Reader, requestId: string): Promise<string | null> {
  const [row] = await reader
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
    /**
     * Машинист, уже прочитанный выпиской (Р22), а не идентификатор под второе чтение: из этой же
     * записи посчитаны предупреждения о его документах (Р21а), и второй `SELECT` за тем же
     * человеком означал бы, что подтверждают одно, а печатают другое. `null` — такого водителя в
     * справочнике нет: графа ФИО остаётся пустой, как и было до рукопожатия.
     */
    machinist: MachinistOption | null;
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

  /*
   * Объект заявки: наименование, адрес и код затрат. Заказчиком он больше не печатается — графа
   * «Заказчик» просит генподрядчика, и его даёт настройка портала, — а печатается шапкой графы
   * работ (`object_line`) на обеих сторонах бланка.
   *
   * Телефон ответственного за встречу машины отсюда ушёл вовсе: по решению заказчика (§4 плана) в
   * графе «Заказчик» стоит телефон заказчика, а не площадки. Контакт при этом никуда не делся —
   * он остаётся в заявке и в кабинете водителя (ADR 0122), где его и смотрят перед выездом; с
   * бумаги ушла только запись, которую всё равно читал не тот, кто звонит.
   *
   * Заказчик заявки здесь всегда объект: заказать технику на площадку отдел не может (ADR 0040).
   */
  const [request] = await tx
    .select({
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .where(eq(vehicleRequests.id, params.requestId));

  const customer = await loadWaybillCustomer(tx);

  // Машинист — снимком, как и всё остальное: человека переведут, а лист остаётся с тем, кто
  // работал. Документ выбран по должности и на начало недели: она и есть дата листа, а годность
  // проверяется на неё же — лист выписывается вперёд, и «годен сегодня» тут ничего не значит.
  const { machinist } = params;

  // «Наименование и адрес объекта» одной строкой — той же склейкой, какой её собирает лист на рейс.
  const objectLine = [request?.objectName, request?.objectAddress].filter(Boolean).join(', ');
  /*
   * Семь строк недели — одни числа месяца. Объект из них ушёл: он повторял один и тот же адрес
   * семь раз, а теперь печатается один раз в шапке графы (`object_line`). Числа остаются — ими
   * лист и ведут: заказчик проставляет напротив дня отработанные часы и расписывается.
   */
  const days = esm2WeekDays(params.period);
  const dayValues = Object.fromEntries(
    days.map((day, index) => [`day${index + 1}_date`, dayOf(day.date)]),
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
    // Дата составления — первый рабочий день недели: с него лист и начинают вести. Вид у неё
    // общий с 4-П (`formatWaybillDate`): второй расчёт того же «дд.мм.гггг» разошёлся бы с первым.
    // Три клетки бланка рядом — та же дата, разобранная по графам «дата составления».
    waybill_date: formatWaybillDate(params.period.from),
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
    /*
     * Расшифровка подписи машиниста в бланке ЭСМ-2 не размечена — её графы заполняет заказчик от
     * руки. Ключ всё равно собирается: набор ключей один на все бланки, а снимок обязан помнить
     * имя тем же видом, каким его печатают два соседних листа.
     */
    driver_short_name: formatNameWithInitials(machinist?.fullName ?? ''),
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
    driver_license_issued_on: formatWaybillDate(machinist?.license?.issuedOn ?? ''),

    // Вид сообщения и вид перевозки — графы рейса; у недели стояния на площадке их нет.
    communication_kind: '',
    transportation_kind: '',

    /*
     * Графа «Заказчик» — генподрядчик из настройки портала (миграция 0164), а не объект заявки.
     * Прежде сюда шли наименование стройки, её адрес и телефон ответственного за встречу машины:
     * графа отвечала «где стоит машина», хотя спрашивает «в чьё распоряжение она поступила». Где
     * машина стоит, лист говорит шапкой графы работ (`object_line`) и «Периодом работы».
     *
     * Телефон — единым видом (ADR 0066), тем же ходом, что и телефон организации в шапке.
     */
    customer_name: customer.name,
    customer_address: customer.address,
    customer_phone: formatPhone(customer.phone),
    object_line: objectLine,
    object_code: request?.objectCode ?? '',

    period_from_day: dayOf(params.period.from),
    period_to_day: dayOf(params.period.to),
    period_month: monthOf(params.period),
    period_year: params.period.from.slice(0, 4),

    // Задание, груз и время выезда — графы листа на рейс. В ЭСМ-2 задание выражено иначе: объектом
    // в шапке графы работ (`object_line`) и характером работ, который вписывает заказчик.
    task_from: '',
    task_to: '',
    task_cargo: '',
    // Контакты концов маршрута — графа рейса: у недели на площадке конца два не бывает. Человека
    // площадки бланк теперь не печатает вовсе — его смотрят в заявке и в кабинете водителя
    // (ADR 0122), а графа «Заказчик» занята телефоном самого заказчика.
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

// ── Рукопожатие выписки недельного листа (Р21, Р21а) ──

/**
 * Кто просит бланк — и, значит, с кого спрашивается рукопожатие.
 *
 * Различать пришлось потому, что к номеру ЭСМ-2 ведут две двери, и человек стоит только в одной:
 *
 *   - `human` — он сам нажал «выписать неделю» (`issueEsm2OnDemand`). Это и есть пятый путь выпуска
 *     номера, о котором Р21а говорит «пропусти любой — и он обойдёт проверку»: непустой набор
 *     предупреждений останавливает выписку 409-м, пока человек его не подтвердит;
 *   - `sync` — бумагу переписала сверка вслед за решением по заявке (`syncEsm2Waybills`). Здесь
 *     409 означал бы, что заявку нельзя перевести в работу, пока кадры не дозаполнят карточку
 *     машиниста, — а ADR 0064 говорит прямо обратное: неполный комплект документов выписку не
 *     останавливает. Спрашивать же рукопожатие у того, кто менял срок заявки, значило бы просить
 *     подтвердить бумагу, которую он не заказывал.
 *
 * Молчания это второй двери не оставляет. Лист сверки с полным комплектом получает `clean` —
 * «проверено, предупреждений не было», — а с пробелами остаётся при умолчании колонки
 * (`not_checked`), которое ровно это и означает: «выдан мимо рукопожатия». Записать туда `clean`
 * было бы неправдой, а третьего значения у колонки нет (миграция 0136).
 */
type Esm2Requester = { by: 'human'; acknowledge: { fingerprint: string } | null } | { by: 'sync' };

/**
 * Предупреждения выписки недельного листа (Р21) — у ЭСМ-2 их ровно одно возможное.
 *
 * Из пяти кодов (`WAYBILL_WARNING_CODES`) четыре про рейс: расхождение адреса точки со строкой
 * задания, непоместившаяся строка, два объекта затрат в одном листе и пустое задание. Ни точек, ни
 * ездок, ни строк задания у недели работы машины на площадке нет вовсе, а объект затрат у неё один
 * по устройству заявки (ADR 0060, `vehicle_requests_department_freight_check`) — считать эти четыре
 * здесь не из чего, и `waybillIssueWarnings` вернула бы вместо них `blank_task`: «в маршруте нет
 * заявок» о документе, у которого маршрута не бывает.
 *
 * Остаётся пятый — пробелы в документах машиниста (ADR 0064), и он общий со всеми бланками:
 * считается тем же правилом (`driverDocumentGaps`), называется тем же кодом и той же формулировкой
 * (`driverDocumentGapsWarning`), а отпечаток берётся с тех же фактов (`canonicalWarningPayload`).
 *
 * Вид документа спрашивается у должности (`requiredCredentialType`), а не назван водительским, как
 * в предупреждениях рейса: 4-П и форму № 3 возит водитель, а недельный лист ведёт машинист
 * экскаватора или погрузчика, допущенный удостоверением тракториста-машиниста (ADR 0095). Назвав
 * его «ВУ», портал отправил бы человека искать не ту бумагу.
 */
async function esm2IssueWarnings(
  tx: Tx,
  machinist: MachinistOption,
  /** Начало недели: на него выбран документ и на него же считается его годность. */
  on: string,
): Promise<WaybillWarning[]> {
  /*
   * СНИЛС — единственное, чего в прочитанном машинисте нет: графы под него в бланке ЭСМ-2 не
   * существует, и `findMachinist` его намеренно не читает (реквизит 4-П, приказ Минтранса № 390).
   * Здесь он спрашивается, потому что комплект документов у человека один на весь портал: свой,
   * «без СНИЛСа», счёт пробелов разошёлся бы с карточкой водителя и со списком выбора — там человек
   * числился бы неполным, а в выписке полным.
   *
   * Цена решения названа вслух: формулировка «эти графы останутся пустыми» для СНИЛСа в ЭСМ-2
   * неточна — пустой останется не графа бланка, а строка справочника. Чинится это правкой одного
   * текста в контрактах; вторая ветка правил о комплекте разъезжалась бы молча и навсегда.
   */
  const [person] = await tx
    .select({ snils: persons.snils })
    .from(persons)
    .where(eq(persons.id, machinist.personId));

  /*
   * Удостоверения перечитывать нечем и незачем: `findMachinist` уже выбрал то единственное, которым
   * человек допущен по должности и которое годно на начало недели (`waybillDocumentOf`), и
   * `driverDocumentGaps` над списком из него одного вернёт ровно то же, что над всем ящиком, — тем
   * же отбором она и начинается. Второе чтение означало бы предупреждение по одному документу и
   * печать по другому (Р22).
   */
  const gaps = driverDocumentGaps(
    {
      snils: person?.snils ?? '',
      jobTitle: machinist.jobTitle,
      licenses: machinist.license ? [machinist.license] : [],
    },
    on,
  );
  const message = driverDocumentGapsWarning(
    gaps,
    requiredCredentialType(machinist.jobTitle),
    waybillFormShortLabels[FORM_CODE],
  );
  if (!message) return [];
  return [
    {
      facts: { code: 'driver_documents', personId: machinist.personId, gaps },
      message,
      entities: [machinist.fullName],
    },
  ];
}

/**
 * Что записать в `issue_warnings` этого листа — и выписывать ли его вообще (Р21а).
 *
 * `null` означает «оставить умолчание колонки» и бывает ровно в одном случае: бумагу никто не
 * просил (её переписала сверка), а предупреждения при этом есть. Подробности — у `Esm2Requester`.
 */
async function esm2IssueWarningsRecord(
  tx: Tx,
  params: {
    requestId: string;
    period: Esm2Period;
    machinist: MachinistOption | null;
    requester: Esm2Requester;
  },
): Promise<IssueWarningsRecord | null> {
  /*
   * Машиниста нет в справочнике — предупреждать нечем: `driver_documents` говорит о пробелах в
   * комплекте человека, а здесь нет самого человека. Ручная выдача до этого места не доходит
   * (`issueEsm2OnDemand` отвечает словами и 422-м), а сверке лист с пустой графой ФИО достаётся и
   * сегодня — это её собственный давний дефект, и лечится он не рукопожатием.
   */
  const warnings = params.machinist
    ? await esm2IssueWarnings(tx, params.machinist, params.period.from)
    : [];

  if (params.requester.by === 'sync') {
    return warnings.length === 0 ? { schemaVersion: 1, status: 'clean' } : null;
  }
  return acknowledgeOrThrow({
    warnings,
    acknowledge: params.requester.acknowledge,
    // Неделя, а не номер: номера у этого листа ещё нет — он и не должен появиться, пока набор не
    // подтверждён, — и другого имени у бумаги, о которой спрашивают, не существует.
    label: `по листу ЭСМ-2 за неделю ${dateRu(params.period.from)} — ${dateRu(params.period.to)}`,
    // `satisfies`, а не приведение: тело отказа описано контрактом ручки, и поле, забытое здесь,
    // должно ловиться сборкой, а не пустым местом в окне подтверждения.
    details: {
      requestId: params.requestId,
      periodFrom: params.period.from,
      periodTo: params.period.to,
    } satisfies Omit<Esm2AckRequiredDetails, 'fingerprint' | 'warnings'>,
  });
}

/**
 * Выдача листа на одну неделю. Номер берётся из серии `esm2` — своей у этого бланка: заявка на
 * месяц забирает пять номеров разом, и в общей серии журнал 4-П получал бы дыры от документов,
 * которых в нём нет.
 *
 * Это общая точка выпуска номера ЭСМ-2 — обе двери к бланку ведут сюда, — и потому рукопожатие
 * (Р21а) стоит здесь, а не в ручке: пропущенный путь записал бы в свежий лист
 * `issue_warnings = not_checked`, то есть обошёл бы проверку, ради которой она заводилась.
 */
async function issueEsm2Waybill(
  tx: Tx,
  params: {
    requestId: string;
    vehicleId: string;
    driverPersonId: string;
    period: Esm2Period;
    actorId: string;
    /** Кто просит бланк: им решается, спрашивать ли рукопожатие. */
    requester: Esm2Requester;
  },
): Promise<IssuedEsm2> {
  /*
   * Машинист читается один раз и до номера (Р22): из этой записи считаются и предупреждения о его
   * документах, и графы бланка. Двумя чтениями одной транзакции подтверждали бы одно, а печатали
   * другое — между ними лежит чужая правка карточки.
   */
  const machinist = await findMachinist(tx, params.driverPersonId, params.period.from);

  /*
   * Рукопожатие — **до** номера: всё, что способно отказать, спрашивается, пока бланк ещё не
   * израсходован. Счётчик серии живёт строкой и откатился бы вместе с транзакцией
   * (`takeNextNumber`), но отказ после сожжённого номера человек прочитал бы как поломку, а журнал
   * учёта строгой отчётности — как утраченный бланк.
   */
  const issueWarnings = await esm2IssueWarningsRecord(tx, {
    requestId: params.requestId,
    period: params.period,
    machinist,
    requester: params.requester,
  });

  const series = await findSeriesByCode(seriesCodeOfForm(FORM_CODE));
  if (!series) throw err.conflict('Не заведена серия путевых листов ЭСМ-2');
  const number = await takeNextNumber(tx, series.id);
  const organizationId = await resolveOrganization(tx, params.vehicleId);

  const data = await collectSnapshot(tx, {
    requestId: params.requestId,
    vehicleId: params.vehicleId,
    machinist,
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
      /*
       * Под какими предупреждениями выдан лист — **той же вставкой**, что и сам документ (Р21). Не
       * аудитом: `writeAudit` намеренно best-effort — пишет отдельным соединением и глотает
       * ошибку, — и хранилищем решения человека быть не может. Здесь же оно неотделимо от бумаги:
       * есть лист — есть и то, под чем его подписали.
       *
       * `null` — колонка остаётся при своём умолчании (`not_checked`): подтверждать было некому,
       * и об этом лист обязан помнить сам.
       */
      ...(issueWarnings ? { issueWarnings } : {}),
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
 * Вход сверки — ровно тот, что принимает `esm2SyncPlan`.
 *
 * Выводится из самой функции, а не переписывается рядом: по нему предпросмотр отката считает
 * отпечаток входов плана (§5.4 плана переключения режима), и новый вход сверки обязан попадать в
 * отпечаток сам, не требуя правки второго места.
 */
export type Esm2SyncPlanInput = Parameters<typeof esm2SyncPlan>[0];

/**
 * Что сверка сделала бы с бумагой заявки: её вход и посчитанный по нему план — без единой правки.
 *
 * Заведено ради предпросмотра отката «Выполнена» → «В работе» (§5.4): диалог обещает человеку
 * точный результат — сколько листов выпишется и какие сгорят, — а обещание это верно ровно до тех
 * пор, пока считает его та же работа, что и исполняет. Поэтому сборка входа живёт здесь, а
 * `syncEsm2Waybills` зовёт эту же функцию, а не свою копию: два места, считающих план, разошлись бы
 * на первой же правке, и предпросмотр начал бы обещать не то.
 *
 * Ничего не пишет и транзакции не требует: `esm2SyncPlan` — чистая функция контрактов, а всё
 * остальное здесь чтение. `null` — заявки нет.
 */
export async function buildEsm2SyncPlan(
  reader: Reader,
  params: {
    requestId: string;
    /** Машинист, названный этим же действием; условия — в `syncEsm2Waybills`. */
    driverPersonId?: string | null;
    /**
     * Принадлежность машины, которую назначают этим же действием: ею считается режим, и заказ,
     * который вели арендной единицей, а продолжат своей, бумагу заводит. Не передана — нынешняя.
     */
    ownership?: VehicleOwnership;
    /**
     * Дата расчёта — ключ дня по МСК; не передана, значит сегодня.
     *
     * Захватывается вызывающим один раз на транзакцию (Р12): полночь между принятым отпечатком и
     * сверкой отдала бы другой план по уже подтверждённому обещанию — `esm2SyncPlan` отбирает
     * недели условием `p.to >= today`.
     */
    asOf?: string;
    /** Контекст проверенной операции коррекции; условия — в `syncEsm2Waybills`. */
    correction?: { id: string; unlockWaybillIds: readonly string[] };
  },
): Promise<{ input: Esm2SyncPlanInput; plan: ReturnType<typeof esm2SyncPlan> } | null> {
  const request = await loadRequest(reader, params.requestId);
  if (!request) return null;

  const mode = esm2Mode({
    requestType: request.requestType,
    status: request.status,
    ownership: params.ownership ?? request.ownership,
    deletedAt: request.deletedAt ? request.deletedAt.toISOString() : null,
    isLinear: request.isLinear,
  });
  const existing = await activeSheets(reader, params.requestId);
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
   *
   * Заявке, которой листов не положено и у которой их нет (самый частый случай — грузоперевозка),
   * человека не ищем вовсе: плану он не пригодится, а чтение стоит запроса на каждую правку.
   */
  const driverPersonId =
    mode === 'on_demand' || (mode === 'none' && sheets.length === 0)
      ? (params.driverPersonId ?? null)
      : (params.driverPersonId ?? (await lastMachinistOf(reader, params.requestId)));

  const input: Esm2SyncPlanInput = {
    mode,
    wanted,
    existing: sheets,
    vehicleId: request.vehicleId,
    driverPersonId,
    today: params.asOf ?? today(),
    // Оба ключа коррекции идут вместе и порознь не работают (Р11): разблокировав лист, но не
    // разрешив прошедшую неделю, сверка аннулировала бы номер и не выписала замены.
    unlockWaybillIds: params.correction?.unlockWaybillIds,
    correction: params.correction ? { allowed: true } : undefined,
  };
  return { input, plan: esm2SyncPlan(input) };
}

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
     * Дата расчёта — ключ дня по МСК; не передана, значит сегодня (Р12). Передаёт её только
     * статусная ручка: она захватывает дату один раз на транзакцию, кладёт в отпечаток входов
     * плана и отдаёт сюда, чтобы наступившая полночь не переписала уже подтверждённое обещание.
     */
    asOf?: string;
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
  // Вход и план считает та же работа, что показала их человеку в предпросмотре (§5.4): своей копии
  // сборки здесь нет намеренно — разойдись эти два места, диалог обещал бы одно, а сверка делала
  // бы другое.
  const built = await buildEsm2SyncPlan(tx, {
    requestId: params.requestId,
    driverPersonId: params.driverPersonId,
    asOf: params.asOf,
    correction: params.correction,
  });
  if (!built) return EMPTY;
  const { input, plan } = built;
  if (plan.cancel.length === 0 && plan.issue.length === 0) return EMPTY;

  const { mode, existing: sheets, driverPersonId } = input;

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
    input.vehicleId;

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

  /*
   * Напечатанные номера сгорающих листов — вторым чтением: в плане их нет и быть не должно.
   * Считает план чистая читающая работа (`buildEsm2SyncPlan`), которой заодно живёт предпросмотр, а
   * номер бланка строгой отчётности нужен здесь одному — журналу аудита: исчезнувшая бумага, не
   * названная номером, не объясняется ничем. Читается он только когда что-то и правда горит.
   */
  const numbersById = new Map<string, string>();
  if (plan.cancel.length > 0) {
    for (const s of await activeSheets(tx, params.requestId)) {
      numbersById.set(s.id, waybillDisplayNumber(s.prefix, s.number, s.numberWidth));
    }
  }
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
      // Рукопожатия у сверки нет и быть не может: бумага здесь — следствие решения по заявке, а не
      // просьба о бланке (`Esm2Requester`). Предупреждения при этом считаются наравне с ручной
      // выдачей — ими лист и получает свой `clean` вместо умолчания «не проверяли».
      requester: { by: 'sync' },
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
    /**
     * Принадлежность машины, которую назначают этой же операцией. Не передана — нынешняя: у
     * входов, которые технику не трогают (продление срока недельной заявкой), «будущей» машины
     * не существует вовсе, и требовать её значило бы заставить их читать назначение ради ответа,
     * который и так лежит в заявке.
     */
    ownership?: VehicleOwnership;
    /** Сегодня по МСК: им отделяются отработанные недели от предстоящих. */
    today: string;
    /**
     * Конец срока, каким он станет **после** операции. Не передан — нынешний.
     *
     * Нужен ровно тем входам, которые срок и двигают: продление недельной заявкой добавляет заказу
     * недели, которых у него сейчас нет, и часть их уже прошла. Посчитав `pastWeeks` по нынешнему
     * `date_to`, предпросмотр умолчал бы ровно о той бумаге, которую операция и выпишет, — а
     * исполнение сверяет уже записанный срок и выписало бы её всё равно.
     */
    dateTo?: string | null;
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
    ownership: params.ownership ?? request.ownership,
    deletedAt: request.deletedAt ? request.deletedAt.toISOString() : null,
    isLinear: request.isLinear,
  });
  // Своих недель `on_demand` не заводит (ADR 0100 §5): у линейного заказа бумагу называет человек,
  // и «недели без листа» у него не бывает по определению — есть недели, о которых не просили.
  const covered = new Set(sheets.map((s) => weekStartKey(s.periodFrom)));
  const dateTo = params.dateTo === undefined ? request.dateTo : params.dateTo;
  const pastWeeks =
    mode === 'auto' && request.dateFrom
      ? esm2Periods(request.dateFrom, dateTo).filter(
          (p) => p.to < params.today && !covered.has(weekStartKey(p.from)),
        )
      : [];
  return { sheets, pastWeeks };
}

/**
 * Действующие листы ЭСМ-2 сразу нескольких заказов — одним запросом.
 *
 * Заведено ради состава недельной заявки: проведение просроченной недели обязано проверить, что
 * каждый названный к перевыписке лист и правда принадлежит заказу **этой** недели, а заказов в
 * составе бывает два десятка. Спрашивать `esm2CorrectionScope` по одному на заказ значило бы
 * положить сорок чтений в транзакцию визы ради одного `IN`.
 *
 * Отбор тот же, что у `activeSheets`: лист заказа, не аннулированный, с заполненным периодом.
 * Второго определения «действующий лист заявки» в портале быть не должно — иначе проверка
 * принадлежности разошлась бы с тем, что сверка потом и правда тронет.
 */
export async function esm2SheetsOfRequests(
  reader: Reader,
  requestIds: readonly string[],
): Promise<(Esm2SheetRef & { requestId: string })[]> {
  if (requestIds.length === 0) return [];
  const rows = await reader
    .select({
      id: waybills.id,
      requestId: waybills.sourceRequestId,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      vehicleId: waybills.vehicleId,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    // Условие — дословно то же, что у `activeSheets`, и вида бланка среди него нет намеренно:
    // `source_request_id` заполняется только у ЭСМ-2 (миграция 0087), у листа на рейс основанием
    // служит сам рейс. Лишнее условие здесь означало бы второе определение того же отбора.
    .where(
      and(inArray(waybills.sourceRequestId, [...requestIds]), ne(waybills.status, 'cancelled')),
    )
    .orderBy(waybills.periodFrom, waybills.id);
  return rows.flatMap((s) =>
    s.requestId && s.periodFrom && s.periodTo
      ? [
          {
            id: s.id,
            requestId: s.requestId,
            number: waybillDisplayNumber(s.prefix, s.number, s.numberWidth),
            periodFrom: s.periodFrom,
            periodTo: s.periodTo,
            vehicleId: s.vehicleId,
          },
        ]
      : [],
  );
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
    esm2Periods(request.dateFrom!, request.dateTo).find(
      (p) => p.from <= weekOf && weekOf <= p.to,
    ) ?? null
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
     * рейсу. Строку заявки к этому моменту держит вызывающий (`lockRequestRow`, план Л3), но
     * неделю он считал до транзакции — поэтому расхождение и ловится здесь сверкой границы, а не
     * подразумевается блокировкой.
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
    /**
     * Рукопожатие выписки (Р21, Р21а): отпечаток набора предупреждений, который человек прочитал в
     * окне. `null` либо не передан — подтверждения не присылали; набор при этом обязан быть пуст,
     * иначе выписка отвечает 409 `waybill_ack_required` со свежим отпечатком и полным списком.
     *
     * Пятый путь выпуска номера закрывается именно здесь (Р21а называла четыре). Предупреждение у
     * недельного листа одно — пробелы в документах машиниста (ADR 0064), — и окно портала проверкой
     * не является: старая вкладка, повтор запроса из истории или `curl` выписали бы лист молча.
     */
    acknowledge?: { fingerprint: string } | null;
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
    // Бланк просит человек — значит с него и спрашивается рукопожатие (Р21а). Отпечаток проверяет
    // общая точка выпуска, а не эта ручка: пропущенный путь записал бы в свежий лист `not_checked`.
    requester: { by: 'human', acknowledge: params.acknowledge ?? null },
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
