import { and, eq, inArray } from 'drizzle-orm';
import {
  type DriverDocumentGap,
  formatPhone,
  licenseNumberLabel,
  routeCargoWithNote,
  routeContactsLabel,
  routeExtraTaskLine,
  type RoutePurpose,
  routeRequestCapacity,
  routeWaybillForm,
  taskRefKey,
  taskRowLayout,
  taskRowLayoutKind,
  type TaskRowNotes,
  type VehicleRequestType,
  type VehicleRoutePointDto,
  type WaybillFormCode,
  waybillRequirement,
  type WaybillRequirement,
  type WaybillSnapshotKey,
  type WaybillTaskRow,
  waybillTaskRows,
  type RouteTripFields,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  departments,
  freightTransportRequestDetails,
  organizations,
  specialEquipmentRequestDetails,
  vehicleModels,
  vehicleRequests,
  vehicleRequestTrips,
  vehicles,
  vehicleTypes,
  waybillRequests,
  waybills,
  waybillTrips,
} from '../db/schema';
import { err } from '../lib/errors';
import { selectDrivers } from './drivers';
import { loadRoutePoints } from './route-points';
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
 *
 * Задание печатается **строками**, а не заявками (план `docs/route-trips-plan.md`, этап 5, Р11):
 * строка бланка — это ездка либо день линейного заказа, а адреса и ответственных ей дают **точки**
 * маршрута (Р11б) — то место, куда приедет машина, и тот человек, который её там встретит. Заявка
 * с тремя ездками занимает три строки и один талон (Р20).
 *
 * Читается всё это один раз — в неизменяемый контекст (`loadWaybillIssueContext`, Р22): из него
 * собирается и снимок бланка, и связи листа с заявками и ездками, и предупреждения выписки.
 * Второе чтение тех же данных означало бы, что подтверждают одно, а печатают другое.
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
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, params.vehicleId));

  if (!row) return { formCode: null, reason: 'Машина не найдена' };
  return waybillRequirement({
    requestType: params.requestType,
    ownership: row.ownership,
    formCode: row.formCode,
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
    .select({ formCode: vehicleTypes.waybillFormCode })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, params.vehicleTypeId));

  if (!row) return { formCode: null, reason: 'Тип техники не найден' };
  return waybillRequirement({
    requestType: params.requestType,
    ownership: 'own',
    formCode: row.formCode,
  });
}

/**
 * Бланк рейса. Правило чистое и живёт в контрактах (`routeWaybillForm`) — здесь только чтение
 * того, чего оно требует: принадлежности машины и бланка, закреплённого за её типом.
 *
 * У перегона тип не спрашивают вовсе: экскаватор идёт по дорогам общего пользования как
 * транспортное средство, и документ у этой поездки один — 4-П.
 */
export async function routeWaybillFormFor(
  tx: Reader,
  params: { purpose: RoutePurpose; vehicleId: string },
): Promise<WaybillRequirement> {
  const [row] = await tx
    .select({
      ownership: vehicles.ownership,
      formCode: vehicleTypes.waybillFormCode,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, params.vehicleId));

  if (!row) return { formCode: null, reason: 'Машина не найдена' };
  return routeWaybillForm({
    purpose: params.purpose,
    ownership: row.ownership,
    formCode: row.formCode,
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

// ── Задание бланка: строки, а не заявки ──

/**
 * Строка задания так, как её держит бланк: четыре графы таблицы 4-П.
 *
 * Строк в бумаге семь (ADR 0068), и каждая из них — ездка либо день линейного заказа (Р11), а не
 * заявка. Разница видна на заявке с ездками A→B и A→C: одной пары адресов у неё не существует, и
 * напечатанная одной строкой она промолчала бы о половине дня.
 */
interface TaskLine {
  from: string;
  to: string;
  cargo: string;
  contacts: string;
}

/** Незанятая строка бланка печатается пустым местом. */
const EMPTY_TASK: TaskLine = { from: '', to: '', cargo: '', contacts: '' };

/**
 * Строка задания целиком, без бюджета бумаги.
 *
 * Ветка линейного дня печатает ровно то, что печатала до перехода на строки (ADR 0100 §10):
 * «откуда» пусто — машина выходит из гаража, а места стоянки портал не ведёт, и подставленный туда
 * объект означал бы, что на площадку приехали с неё же; «куда» — наименование и адрес объекта, их
 * несёт точка дня; в графе груза — комментарий заявки: у такого заказа там стоит характер работ, и
 * другого места под него в бланке нет. Различает эти две ветки теперь сам тип строки (у
 * `LinearDayRow` поле `from` объявлено пустым), а не разбор вида заявки, — но напечатанное от
 * смены источника не изменилось ни на знак (Р24).
 */
function fullTaskLine(row: WaybillTaskRow): TaskLine {
  // Количество — только у ездки: линейная техника работает, а не возит, и выражать в этой графе ей
  // нечего. Комментарий у обеих строк идёт второй строкой графы «Груз» (ADR 0071).
  const amount = row.kind === 'freight' ? row.cargoLabel : '';
  const note = row.kind === 'freight' ? row.cargoNote : row.workNote;
  return {
    from: row.kind === 'freight' ? row.from : '',
    to: row.to,
    cargo: routeCargoWithNote(amount, note),
    // Ответственные обоих концов строки — по её **точкам** (Р11а): собрал их `waybillTaskRows`,
    // здесь остаётся подпись. Список полный; что из него влезет в графу, решает бюджет ниже.
    contacts: routeContactsLabel(row.contacts),
  };
}

/**
 * Строка задания в том виде, в каком её примет бумага (Р11а): бюджет считает `taskRowLayout`, а
 * вид раскладки задан номером строки — строки 1–4 это графы таблицы, у каждой свой предел, строки
 * 5–7 — одна объединённая ячейка блока «Дополнительное задание водителю», где адрес, груз и
 * контакты делят одну ширину.
 *
 * Два случая печатают строку целиком, без свёртывания:
 *
 *   - **бланк задания не печатает** (`taskRowLayoutKind` → `null`): у формы № 3 задания нет вовсе
 *     (ADR 0071), и мерить строку шириной граф, которых у неё в бумаге не существует, незачем.
 *     Набор ключей снимка при этом один на все бланки (`WAYBILL_SNAPSHOT_KEYS`), поэтому значения
 *     в него кладутся всё равно — ровно те же, что клались до перехода на строки;
 *   - **строка не помещается** (`ok: false`): это блокирующий отказ, и остановить выписку обязан
 *     вызывающий (`routeIssueBlockers`) — до того, как израсходован номер бланка. Если строка всё
 *     же доехала сюда, в бумагу идёт полное значение: обрезать хвост границей ячейки — дело Excel,
 *     а печатать вместо адреса пустое место портал не станет.
 */
function taskLineOf(row: WaybillTaskRow, formCode: WaybillFormCode): TaskLine {
  const kind = taskRowLayoutKind(formCode, row.slot);
  if (kind === null) return fullTaskLine(row);
  const layout = taskRowLayout(row, kind);
  if (!layout.ok) return fullTaskLine(row);
  return { from: layout.from, to: layout.to, cargo: layout.cargo, contacts: layout.contacts };
}

/**
 * Задание перегона: «откуда — куда» несёт сам рейс, а не строки маршрута — точек у перегона нет
 * вовсе (миграция 0082), и строк задания из них не собирается ни одной.
 *
 * Ответственный один — тот, кто встречает машину на площадке: перегон заводится только на заказ
 * техники на объект (`addRelocation` отвергает остальные виды), и второго конца у него не бывает.
 */
function relocationTaskLine(
  move: { from: string; to: string },
  source: IssueRequest | null,
): TaskLine {
  return {
    from: move.from,
    to: move.to,
    // Груза нет: машина едет своим ходом, она и есть транспортное средство листа, а не груз.
    cargo: '',
    contacts: routeContactsLabel([
      { name: source?.siteResponsibleName ?? '', phone: source?.siteResponsiblePhone ?? '' },
    ]),
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
  /** Состав рейса по порядку: его строки и раскладываются в строки задания листа. */
  requests: readonly { requestId: string; position: number }[];
  /**
   * Перегон техники: вместо состава у рейса одна заявка-основание и задание «откуда — куда»
   * (миграция 0082). `null` — обычный маршрут грузоперевозки.
   */
  relocation: { requestId: string; from: string; to: string } | null;
  /** Кто выписывает: попадёт в `issued_by` и в журнал аудита. На бланке его нет — подписи там свои. */
  actor: { id: string };
}

// ── Неизменяемый контекст выписки (Р22) ──

/** Реквизиты водителя снимком и пробелы его комплекта — всё, что о нём читается, читается разом. */
interface IssueDriver {
  personId: string;
  fio: string;
  snils: string;
  personnelNo: string;
  license: string;
  licenseIssuedOn: string;
  /**
   * Чего в документах не хватает (ADR 0064). Печати не мешает — графы останутся пустыми, — но из
   * этого же чтения считается предупреждение `driver_documents` (Р21): подтверждают и печатают
   * тогда одно и то же положение дел.
   */
  gaps: DriverDocumentGap[];
}

/** Заявка так, как её видит бланк: шапка «в чьё распоряжение», время подачи и контакт площадки. */
interface IssueRequest {
  /** Комментарий заказа: вторая строка графы «Груз» у ездок без своего примечания и у линейных дней. */
  comment: string;
  /** Заказчик — объект или отдел (ADR 0040): у заявки отдела площадки нет вовсе. */
  customerName: string;
  customerAddress: string;
  scheduledAt: Date | null;
  timeUnspecified: boolean;
  siteResponsibleName: string;
  siteResponsiblePhone: string;
}

/**
 * Всё, из чего рождается лист, — одним чтением под уже взятыми блокировками (Р22).
 *
 * Заведён потому, что читать дважды нельзя. Водителя, например, спрашивали дважды — проверкой
 * «такой человек есть» и снимком реквизитов, — и между двумя `SELECT`'ами одной транзакции лежит
 * чужая правка: подтверждали одно, печатали другое. С рукопожатием (Р21) чтений становится больше,
 * и расхождение из редкого делается системным.
 *
 * Что из контекста считается:
 *
 *   - **снимок бланка** (`collectSnapshot`) — то, что уходит в `waybills.data` и на бумагу;
 *   - **талоны и связь «лист ↔ ездка»** (`talonsOf`, `waybill_trips`) — по тем же строкам задания,
 *     что напечатаны, а не по составу рейса (Р20);
 *   - **предупреждения выписки и их отпечаток** (`waybillIssueWarnings`, Р21) — им нужны те же
 *     точки, строки и пробелы документов водителя. Своего они добирают немного: номер рейса для
 *     сообщения, адреса самих строк задания (`sourceAddresses`) и объекты затрат заявок
 *     (`costTargets`) — их место здесь же, рядом с `requests`, и второго чтения точек им не нужно.
 *
 * Контекст неизменяем по договорённости, а не по типу: `readonly` на всех полях сделал бы его
 * неудобным для сборки, а смысл у него один — собран один раз, дальше только читается.
 */
export interface WaybillIssueContext {
  /** Рейс так, как его передал вызывающий: состав, машина, водитель, перегон. */
  route: RouteWaybillContext;
  /** Бланк рейса: им заданы и ёмкость задания, и то, как печатается каждая строка (ADR 0068). */
  formCode: WaybillFormCode;
  /** От чьего имени выписан лист: организация машины, иначе основная. */
  organizationId: string;
  organization: {
    name: string;
    address: string;
    phone: string;
    okpo: string;
    ogrn: string;
  } | null;
  vehicle: {
    registrationNumber: string | null;
    garageNumber: string | null;
    inventoryNumber: string | null;
    modelName: string | null;
  } | null;
  driver: IssueDriver;
  /** Точки маршрута в порядке объезда: их адреса и их ответственных и печатает бланк (Р11б). */
  points: VehicleRoutePointDto[];
  /** Комментарии строк задания по `taskRefKey` — вторая строка графы «Груз». */
  notes: TaskRowNotes;
  /** Строки задания в порядке печати: ездки и линейные дни вперемешку, по порядку объезда (Р11). */
  rows: WaybillTaskRow[];
  /** Заявки листа по их идентификаторам: состав рейса плюс заявка-основание перегона. */
  requests: Map<string, IssueRequest>;
  /**
   * Заявка шапки «в чьё распоряжение» — та, чья строка задания напечатана первой (Р26). `null` —
   * рейс без задания (ADR 0071): шапка остаётся пустой под то, что впишут от руки.
   */
  header: IssueRequest | null;
}

/**
 * Заявки листа одним запросом: шапка, время подачи, комментарий и ответственный площадки.
 *
 * Вид заявки не спрашивается вовсе, и это отличие от прежней печати: та разбирала им, откуда брать
 * задание, — теперь его несут строки маршрута (Р11), а пустое поле деталей законно само по себе.
 * У заказа техники на объект нет времени подачи, у грузоперевозки — ответственного площадки, и оба
 * `LEFT JOIN` отдают NULL не от нехватки данных, а по устройству заявки.
 */
async function loadIssueRequests(tx: Tx, ids: string[]): Promise<Map<string, IssueRequest>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: vehicleRequests.id,
      comment: vehicleRequests.comment,
      // Заказчик в бланке — объект или отдел (ADR 0040): innerJoin по объекту оставил бы строку
      // «Заказчик» пустой у заявки отдела — вместе со всем листом.
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      departmentName: departments.name,
      scheduledAt: freightTransportRequestDetails.scheduledAt,
      timeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
      // Тот, кто встречает машину на площадке (миграция 0062): им печатается перегон.
      siteResponsibleName: specialEquipmentRequestDetails.responsibleName,
      siteResponsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .leftJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(inArray(vehicleRequests.id, ids));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        comment: row.comment,
        // У отдела адреса нет: он не площадка, и маршрут задан адресами точек.
        customerName: row.objectName ?? row.departmentName ?? '',
        customerAddress: row.objectAddress ?? '',
        scheduledAt: row.scheduledAt,
        timeUnspecified: row.timeUnspecified ?? false,
        siteResponsibleName: row.siteResponsibleName ?? '',
        siteResponsiblePhone: row.siteResponsiblePhone ?? '',
      },
    ]),
  );
}

/**
 * Комментарии строк задания (`TaskRowNotes`): у ездки — её собственное примечание, а нет его —
 * комментарий заказа; у линейного дня — комментарий заявки, он же характер работ (ADR 0100 §10).
 *
 * Падать на комментарий заказа приходится потому, что примечание ездки завелось миграцией 0136 и
 * бэкфил оставил его пустым (Р24): взяв только его, печать молча уронила бы вторую строку графы
 * «Груз» у каждой заявки, где комментарий заполнен, — то есть изменила бы уже выданный
 * документооборот. Заполненное примечание ездки при этом сильнее: оно про эту поездку, а
 * комментарий — про весь заказ.
 */
async function loadTaskRowNotes(
  tx: Tx,
  points: readonly VehicleRoutePointDto[],
  requests: ReadonlyMap<string, IssueRequest>,
): Promise<TaskRowNotes> {
  const tripIds = [
    ...new Set(
      points.flatMap((point) =>
        point.actions.flatMap((action) => (action.kind === 'freight' ? [action.ref.tripId] : [])),
      ),
    ),
  ];
  const tripRows =
    tripIds.length > 0
      ? await tx
          .select({ id: vehicleRequestTrips.id, comment: vehicleRequestTrips.comment })
          .from(vehicleRequestTrips)
          .where(inArray(vehicleRequestTrips.id, tripIds))
      : [];
  const tripNotes = new Map(tripRows.map((row) => [row.id, row.comment]));

  const notes = new Map<string, string>();
  for (const point of points) {
    for (const action of point.actions) {
      const requestNote = requests.get(action.ref.requestId)?.comment ?? '';
      const own = action.kind === 'freight' ? (tripNotes.get(action.ref.tripId) ?? '') : '';
      notes.set(taskRefKey(action.ref), own.trim() === '' ? requestNote : own);
    }
  }
  return notes;
}

/**
 * Контекст выписки: читает всё, что нужно бумаге и рукопожатию, и проверяет то, без чего листа не
 * существует, — бланк рейса и водителя.
 *
 * Обе проверки живут здесь, а не в вызывающем, ровно потому, что обе требуют чтения: бланк
 * приходит с типа машины, водитель — из справочника на дату рейса. Проверки состава и статусов
 * остаются снаружи (`canIssueWaybill`) — они делаются под блокировками до всякого чтения.
 */
export async function loadWaybillIssueContext(
  tx: Tx,
  route: RouteWaybillContext,
): Promise<WaybillIssueContext> {
  const requirement = await routeWaybillFormFor(tx, {
    purpose: route.purpose,
    vehicleId: route.vehicleId,
  });
  if (!requirement.formCode) {
    throw err.unprocessable(requirement.reason ?? 'На эту машину путевой лист не выписывается', {
      vehicleId: 'Бланк не выписывается',
    });
  }

  /*
   * Тот же список, что показывает форма: второму набору правил разъехаться с первым негде.
   *
   * Документ приходит выбранным по должности (`waybillDocumentOf` внутри `selectDrivers`, ADR
   * 0093): у водителя и машиниста автокрана это водительское удостоверение, у машиниста погрузчика
   * и экскаватора — тракториста-машиниста. Отбирать вид документа здесь нечем и незачем: выбор
   * один на весь портал, иначе лист выписался бы по одному документу, а предупреждение о пробелах
   * считалось бы по другому. Ключи бланка от вида не зависят — графа в 4-П и форме № 3 одна.
   */
  const selection = await selectDrivers({
    vehicleId: route.vehicleId,
    on: route.routeDate,
    withTrailer: route.trip.withTrailer,
    personId: route.driverPersonId,
  });
  /*
   * Пустой ответ означает единственное: такого водителя нет — запись удалена либо специализация
   * закрыта увольнением. Неполный комплект документов выписку не останавливает (ADR 0064): графы
   * СНИЛСа, номера удостоверения и даты выдачи останутся в бланке пустыми, о чём портал предупредил
   * дважды — при выборе водителя и в подтверждении выписки, — а решение печатать принял человек.
   *
   * Пустая графа от этого не перестала быть дефектом бумаги: лист без реквизитов водителя
   * недействителен. Портал этого не скрывает и не чинит — он ровно поэтому и говорит о ней до
   * печати, а не оставляет обнаруживать её тому, кто взял бланк в руки.
   */
  const found = selection?.drivers[0];
  if (!found) {
    throw err.unprocessable(
      'Водителя нет в справочнике: запись удалена или человек уволен. Назначьте на рейс другого.',
      { driverPersonId: 'Водитель не найден' },
    );
  }

  const organizationId = await resolveOrganization(tx, route.vehicleId);
  const [organization] = await tx
    .select({
      name: organizations.name,
      address: organizations.address,
      phone: organizations.phone,
      okpo: organizations.okpo,
      ogrn: organizations.ogrn,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const [vehicle] = await tx
    .select({
      registrationNumber: vehicles.registrationNumber,
      garageNumber: vehicles.garageNumber,
      inventoryNumber: vehicles.inventoryNumber,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(eq(vehicles.id, route.vehicleId));

  /*
   * Точки — источник печатаемых адресов и ответственных (Р11б). У перегона их нет вовсе: состава у
   * него не бывает, а задание несёт сам рейс, — и строк задания из пустого маршрута выйдет ноль.
   */
  const points = await loadRoutePoints(tx, route.routeId);
  const requests = await loadIssueRequests(tx, [
    ...route.requests.map((row) => row.requestId),
    ...(route.relocation ? [route.relocation.requestId] : []),
  ]);
  const notes = await loadTaskRowNotes(tx, points, requests);
  const rows = waybillTaskRows(points, notes);

  /*
   * Шапка «в чьё распоряжение» называет заказчика первой строки задания (Р26), а не первой строки
   * состава: порядок бумаги задают точки, и переставленный маршрут обязан переставить и шапку —
   * иначе она называла бы не того, чей талон напечатан первым.
   *
   * Запасной ход — первая строка состава: он отвечает за перегон (у него строк задания нет, а
   * заказчик есть) и за нераскладку, которую блокер `rows_unplaced` не должен пропускать, но
   * молчать о заказчике из-за неё бумага не обязана.
   */
  const headerRequestId =
    route.relocation?.requestId ??
    rows[0]?.ref.requestId ??
    [...route.requests].sort((a, b) => a.position - b.position)[0]?.requestId;

  return {
    route,
    formCode: requirement.formCode,
    organizationId,
    organization: organization ?? null,
    vehicle: vehicle ?? null,
    driver: {
      personId: found.personId,
      fio: found.fullName,
      snils: found.snilsFormatted,
      personnelNo: found.personnelNo,
      license: licenseNumberLabel({ series: found.licenseSeries, number: found.licenseNumber }),
      licenseIssuedOn: found.licenseIssuedOn ?? '',
      gaps: found.gaps,
    },
    points,
    notes,
    rows,
    requests,
    header: headerRequestId ? (requests.get(headerRequestId) ?? null) : null,
  };
}

/**
 * Талоны листа: связь «лист ↔ заявка», где `slot` — **первая** строка задания этой заявки (Р20).
 *
 * Первые строки двух заявок совпасть не могут — строка задания принадлежит одной заявке, — поэтому
 * `waybill_requests_slot_unique` остаётся в силе. Заявка с тремя ездками получает один талон с
 * номером своей первой строки: сами ездки лежат в `waybill_trips`, каждая со своей строкой.
 *
 * Строка состава, которой в маршруте не нашлось места, талон всё же получает — иначе журнал
 * показал бы лист без заявки, ради которой он выписан, — и её номер встаёт **за** напечатанными
 * строками: в бумаге такой строки нет, и занимать чужой номер ей нечем. Состояние это блокирующее
 * (`rows_unplaced`), и до выписки доходить не должно вовсе.
 */
function talonsOf(context: WaybillIssueContext): { requestId: string; slot: number }[] {
  const relocation = context.route.relocation;
  // У перегона талон один — заявка, ради которой едут: без него журнал показывал бы лист,
  // выписанный ни на что.
  if (relocation) return [{ requestId: relocation.requestId, slot: 1 }];

  const firstRow = new Map<string, number>();
  for (const row of context.rows) {
    if (!firstRow.has(row.ref.requestId)) firstRow.set(row.ref.requestId, row.slot);
  }
  let spare = context.rows.length;
  return [...context.route.requests]
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      requestId: row.requestId,
      slot: firstRow.get(row.requestId) ?? (spare += 1),
    }));
}

/**
 * Значения бланка снимком (ADR 0037 п. 10). Лист печатается из этого объекта, а не из
 * справочников, поэтому переименование объекта или уточнение госномера задним числом уже выданный
 * документ не меняет.
 *
 * Функция чистая: всё, что она печатает, уже прочитано в контекст (Р22), — и это не украшение, а
 * то самое свойство, ради которого контекст заводился. Номер идёт отдельным аргументом: он
 * выдаётся серией после всех проверок, и класть его в контекст значило бы сжигать номер до того,
 * как выяснилось, что лист выпишется.
 */
function collectSnapshot(
  context: WaybillIssueContext,
  number: { display: string; prefix: string },
): Record<WaybillSnapshotKey, string> {
  const { route, header } = context;
  const fields = route.trip;

  /*
   * Задание печатается **строками**, а не заявками (Р11): ездки и дни линейных заказов идут в том
   * порядке, в котором машина их объедет, и слот строки — это номер строки бланка. Строк в 4-П
   * семь (ADR 0068): четыре в таблице с талонами заказчиков и три в блоке доп. задания. Пустые
   * остаются пустыми — лист на одну заявку выглядит так же, как выглядел до маршрутов, а строки
   * сверх седьмой в бумагу не попадают вовсе: печатать их некуда, и отвечает за это блокер
   * `capacity_exceeded`, а не молчание снимка.
   *
   * У перегона строк нет: задание ему даёт сам рейс, и состав у него не спрашивают (миграция 0082).
   */
  const lines = new Map<number, TaskLine>(
    route.relocation
      ? []
      : context.rows.map((row) => [row.slot, taskLineOf(row, context.formCode)]),
  );
  const line = (slot: number): TaskLine => lines.get(slot) ?? EMPTY_TASK;
  const first = route.relocation ? relocationTaskLine(route.relocation, header) : line(1);

  /*
   * Время выезда: план прибытия первой точки маршрута (§8 плана), а его нет — время подачи заявки
   * шапки, как печаталось до точек.
   *
   * Запасной ход здесь не вежливость к старым данным, а единственный правдивый ответ: время
   * прибытия у точки необязательное (`arrivalTimeSchema`), бэкфил его не заполнял вовсе, и взяв
   * только его, бланк потерял бы час подачи на каждом листе, выписанном по собранному до точек
   * маршруту. Время подачи при этом остаётся у заявки (Р3) и отвечает на тот же вопрос — к
   * которому часу машина нужна.
   */
  const scheduled =
    header?.scheduledAt && !header.timeUnspecified
      ? new Date(header.scheduledAt.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(11, 16)
      : '';
  const departure = context.points[0]?.arrivalTime || scheduled;

  return {
    org_name: context.organization?.name ?? '',
    org_address: context.organization?.address ?? '',
    // Телефоны бланка — единым видом (ADR 0066). Реквизит организации при этом бывает и не одним
    // номером («(495) …, +7-985-…» у основной): такую запись `formatPhone` печатает как есть.
    org_phone: formatPhone(context.organization?.phone ?? ''),
    org_okpo: context.organization?.okpo ?? '',
    org_ogrn: context.organization?.ogrn ?? '',

    waybill_series: number.prefix,
    waybill_number: number.display,
    waybill_date: route.routeDate,

    // В графу «Автомобиль (марка)» идёт марка/модель из справочника (ADR 0007) — без изготовителя.
    // Завод-изготовитель числится за машиной как реквизит, маркой её не называет никто, а длина
    // названия съедает узкую графу целиком, не оставив места самой марке. Модель не проставлена —
    // графа остаётся пустой и заполняется от руки: гадать за справочник портал не берётся.
    vehicle_brand: context.vehicle?.modelName ?? '',
    vehicle_reg_number: context.vehicle?.registrationNumber ?? '',
    vehicle_garage_number: fields.garageNumber || (context.vehicle?.garageNumber ?? ''),
    vehicle_inventory_number: context.vehicle?.inventoryNumber ?? '',

    trailer1_brand: fields.trailer1Model,
    trailer1_reg_number: fields.trailer1RegNumber,
    trailer2_brand: fields.trailer2Model,
    trailer2_reg_number: fields.trailer2RegNumber,

    // Реквизиты водителя — снимком: удостоверение сменят, а лист остаётся с тем, по которому ехали.
    // Не внесённая графа остаётся пустой строкой (ADR 0064): бланк печатается с пустым местом, а не
    // с выдумкой, и предупреждали о ней до печати.
    driver_fio: context.driver.fio,
    driver_snils: context.driver.snils,
    driver_personnel_no: context.driver.personnelNo,
    driver_license_number: context.driver.license,
    driver_license_issued_on: context.driver.licenseIssuedOn,

    communication_kind: fields.communicationKind,
    transportation_kind: fields.transportationKind,

    customer_name: header?.customerName ?? '',
    customer_address: header?.customerAddress ?? '',
    // Телефон ответственного — графа ЭСМ-2: там машина стоит на объекте неделю, и звонят туда. У
    // рейса контакты свои на каждой точке, и в эту графу они не печатаются.
    customer_phone: '',
    task_from: first.from,
    task_to: first.to,
    task_cargo: first.cargo,
    task_contacts: first.contacts,
    task_departure_time: departure,

    task2_from: line(2).from,
    task2_to: line(2).to,
    task2_cargo: line(2).cargo,
    task2_contacts: line(2).contacts,
    task3_from: line(3).from,
    task3_to: line(3).to,
    task3_cargo: line(3).cargo,
    task3_contacts: line(3).contacts,
    task4_from: line(4).from,
    task4_to: line(4).to,
    task4_cargo: line(4).cargo,
    task4_contacts: line(4).contacts,

    /*
     * Строки 5–7. У 4-П это нижние строки блока «Дополнительное задание водителю» — по одной
     * объединённой ячейке без граф внутри, поэтому туда идёт собранная строка целиком. Бюджет их
     * посчитан по той же ячейке (`taskRowLayout`, раскладка `single-cell`), а не по графам таблицы.
     */
    task5_line: routeExtraTaskLine(line(5)),
    task6_line: routeExtraTaskLine(line(6)),
    task7_line: routeExtraTaskLine(line(7)),

    /*
     * Графы ЭСМ-2 (миграция 0087) в листе на рейс пустые — и это не заглушки, а разные документы.
     * Неделя работы машины на площадке не знает ни рейса, ни груза; лист на рейс не знает ни
     * периода, ни семи дней, ни кода объекта затрат. Набор ключей у снимка один на все бланки —
     * им тест сверяет разметку, — и «нет такой графы» выражается пустой строкой.
     */
    waybill_date_dd: '',
    waybill_date_mm: '',
    waybill_date_yyyy: '',
    object_code: '',
    period_from_day: '',
    period_to_day: '',
    period_month: '',
    period_year: '',
    day1_date: '',
    day2_date: '',
    day3_date: '',
    day4_date: '',
    day5_date: '',
    day6_date: '',
    day7_date: '',
    day1_object: '',
    day2_object: '',
    day3_object: '',
    day4_object: '',
    day5_object: '',
    day6_object: '',
    day7_object: '',
  };
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
 * Здесь остаётся то, что требует чтения справочников, — и читается оно один раз, в неизменяемый
 * контекст (Р22): бланк по машине, допуск водителя на дату рейса, точки маршрута и заявки листа.
 */
export async function issueWaybillForRoute(
  tx: Tx,
  ctx: RouteWaybillContext,
): Promise<IssuedWaybill> {
  const context = await loadWaybillIssueContext(tx, ctx);

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

  const data = collectSnapshot(context, number);

  const [created] = await tx
    .insert(waybills)
    .values({
      seriesId: number.seriesId,
      number: number.number,
      formCode: context.formCode,
      organizationId: context.organizationId,
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

  /*
   * Талоны — снимок состава на момент выдачи: рейс потом пересоберут, а бланк в журнале обязан
   * помнить своё. У пустого бланка талонов нет вовсе, и журнал показывает его без заявок — так он
   * и выдан (ADR 0071).
   */
  const talons = talonsOf(context);
  if (talons.length > 0) {
    await tx.insert(waybillRequests).values(
      talons.map((talon) => ({
        waybillId: created!.id,
        requestId: talon.requestId,
        slot: talon.slot,
      })),
    );
  }

  /*
   * Вторая связь — «лист ↔ ездка» (Р20): какая ездка какой строкой напечатана. По ней журнал
   * показывает состав задания, а карточка ездки — лист, в котором она уехала.
   *
   * Линейный день строки здесь не получает: ездки у него нет вовсе, а его строка задания опознаётся
   * парой «заявка + день», которая уже лежит в талоне и в составе рейса. Строки сверх ёмкости
   * бланка не пишутся тоже: напечатанными они не были, и связывать их с бумагой нечем — до такого
   * состояния выписку не должен допускать блокер `capacity_exceeded`. У перегона задание берётся из
   * самого рейса, а не из строк, — значит и связывать с листом нечего.
   */
  const capacity = routeRequestCapacity(context.formCode);
  const printedTrips = (ctx.relocation ? [] : context.rows).flatMap((row) =>
    row.kind === 'freight' && row.slot <= capacity
      ? [{ waybillId: created!.id, tripId: row.ref.tripId, slot: row.slot }]
      : [],
  );
  if (printedTrips.length > 0) await tx.insert(waybillTrips).values(printedTrips);

  return { id: created!.id, number: number.display };
}
