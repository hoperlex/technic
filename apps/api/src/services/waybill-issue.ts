import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  canonicalWarningPayload,
  type CostTarget,
  costTargetOf,
  type DriverDocumentGap,
  formatNameWithInitials,
  formatPhone,
  formatWaybillDate,
  type IssueBlocker,
  licenseNumberLabel,
  routeCargoWithNote,
  routeContactsLabel,
  routeExtraTaskLine,
  routeIssueBlockers,
  type RoutePurpose,
  routeRequestCapacity,
  routeWaybillForm,
  taskAddressKey,
  type TaskRef,
  taskRefKey,
  taskRowLayout,
  taskRowLayoutKind,
  type TaskRowNotes,
  type VehicleRequestType,
  type VehicleRoutePointDto,
  WAYBILL_ACK_REQUIRED_CODE,
  type WaybillAckRequiredDetails,
  type WaybillFormCode,
  waybillIssueWarnings,
  waybillRequirement,
  type WaybillRequirement,
  type WaybillSnapshotKey,
  type WaybillTaskRow,
  waybillTaskRows,
  type WaybillWarning,
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
  waybillCustomer,
  waybillRequests,
  waybills,
  waybillTrips,
} from '../db/schema';
import { err } from '../lib/errors';
import { selectDrivers } from './drivers';
import { loadRoutePoints, routeTaskRefs } from './route-points';
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

/** Реквизиты заказчика, как их просит бланк: наименование, адрес офиса и телефон. */
export interface WaybillCustomer {
  name: string;
  address: string;
  phone: string;
}

/**
 * В чьё распоряжение выписан лист — настройка портала (миграция 0164), одна на все бланки.
 *
 * Графа «В чьё распоряжение (наименование и адрес заказчика)» у 4-П и графа «Заказчик» у ЭСМ-2
 * печатали прежде объект заявки: наименование стройки, её адрес и телефон встречающего. Это не
 * заказчик, а площадка, куда машину послали; заказчик у всех листов один — генподрядчик, в чьё
 * распоряжение техника и поступает. На какой объект выписан лист, помнит `object_line`.
 *
 * Функция живёт здесь и зовётся обоими сборщиками — второе её написание в ЭСМ-2 разошлось бы с
 * первым на первой же правке, и два бланка одного дня назвали бы разных заказчиков.
 *
 * Пустой настройки не бывает — её заводит сид миграции, — но отсутствие строки выписку не
 * останавливает: графа печатается пустой, как и всякий незаполненный реквизит (ADR 0064). Отказать
 * в листе из-за ненакатанной миграции значило бы остановить рейсы ради графы, которую дописывают
 * от руки. Телефон возвращается как записан: печатают его оба сборщика через `formatPhone`
 * (ADR 0066) — тем же ходом, что и телефон организации в шапке.
 */
export async function loadWaybillCustomer(tx: Reader): Promise<WaybillCustomer> {
  const [row] = await tx
    .select({
      name: waybillCustomer.name,
      address: waybillCustomer.address,
      phone: waybillCustomer.phone,
    })
    .from(waybillCustomer);
  return row ?? { name: '', address: '', phone: '' };
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
  /**
   * «Р-12» — им предупреждения выписки называют рейс человеку (Р21).
   *
   * Аргументом, а не чтением внутри: номер рейса уже есть у каждого из четырёх путей выпуска —
   * все они держат строку рейса под `FOR UPDATE`, — и второй `SELECT` за тем же числом означал бы
   * лишний запрос ради подписи в сообщении.
   */
  routeNumber: string;
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
  /**
   * Рукопожатие выписки (Р21): отпечаток набора предупреждений, который человек прочитал в окне.
   * `null` — подтверждения не присылали; набор при этом обязан быть пуст, иначе выписка отвечает
   * 409 `waybill_ack_required`.
   *
   * Полем контекста, а не аргументом ручки, ровно по Р21а: путей выпуска номера у листа по рейсу
   * четыре, и рукопожатие живёт в общей точке — пропущенный путь записал бы в свежий лист
   * `issue_warnings = not_checked`, то есть обошёл бы проверку, ради которой она заводилась.
   * Пятый путь — недельный ЭСМ-2 (`issueEsm2Waybill`), и у него своя общая точка и своё поле:
   * рейса, точек и строк задания у того бланка нет вовсе.
   */
  acknowledge: { fingerprint: string } | null;
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
  /**
   * «Наименование, адрес» объекта — тот самый адрес, который линейный день несёт **в самой строке
   * задания** (ADR 0100 §10). С ним и сверяется адрес точки дня (Р11б): расхождение поднимает
   * `address_mismatch`.
   *
   * Отдельно от `customerName`/`customerAddress`, хотя у линейного заказа это те же две колонки:
   * шапка «в чьё распоряжение» печатает заказчика и у заявки отдела, а объект затрат-отдел адреса
   * не имеет вовсе — сложив их в одно поле, мы получили бы «расхождение» с пустой строкой у
   * каждого заказа отдела. Собирается тем же правилом, что и в `route-points.ts` (`objectLocation`),
   * иначе сверка сравнивала бы две по-разному склеенные строки.
   */
  objectLocation: string;
  /** Объект затрат заявки (Р25): по ним считается `multiple_cost_targets` шапки (Р26). */
  costTarget: CostTarget | null;
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
 *     сообщения (приходит с вызывающим), адреса самих строк задания (`sourceAddresses`, из того же
 *     чтения ездок, что и комментарии) и объекты затрат заявок (`costTargets`, из того же чтения
 *     заявок, что и шапка) — второго чтения точек им не нужно;
 *   - **блокеры выписки** (`routeIssueBlockers`, Р11а) — те же точки плюс строки задания состава
 *     (`composition`): ёмкость бланка считается по ним, а не по разложенному.
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
  /**
   * В чьё распоряжение выписан лист (миграция 0164). Читается в контекст наравне с организацией и
   * по той же причине (Р22): снимок собирается из уже прочитанного, а не ходит в базу сам.
   */
  customer: WaybillCustomer;
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
  /** Адреса самих строк задания по `taskAddressKey`: с ними сверяются адреса точек (Р11б). */
  sourceAddresses: Map<string, string>;
  /**
   * Строки задания **состава** — все ездки живых заявок рейса и все дни линейных заказов, включая
   * те, что в маршруте ещё не разложены (Р11). Ими считается ёмкость бланка: считать разложенные
   * значило бы не заметить забытую ездку — ту самую, из-за которой лист и не выписать.
   */
  composition: TaskRef[];
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
      //
      // Идентификаторы и коды рядом с наименованиями — ради объекта затрат (Р25): решает его
      // `costTargetOf` по идентификатору, а код это то, чем цель называет бухгалтерия.
      objectId: vehicleRequests.objectId,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      departmentId: vehicleRequests.departmentId,
      departmentCode: departments.code,
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
        // Тем же склеиванием, что и в `route-points.ts`: «Наименование, адрес», пустое опущено.
        objectLocation: [row.objectName, row.objectAddress].filter(Boolean).join(', '),
        costTarget: costTargetOf(row),
        scheduledAt: row.scheduledAt,
        timeUnspecified: row.timeUnspecified ?? false,
        siteResponsibleName: row.siteResponsibleName ?? '',
        siteResponsiblePhone: row.siteResponsiblePhone ?? '',
      },
    ]),
  );
}

/** Что строки задания несут в себе самих — в отличие от того, что им дают точки маршрута. */
interface TaskRowFacts {
  notes: TaskRowNotes;
  /**
   * Адрес, записанный в самой строке задания, по ключу `taskAddressKey` (Р11б). С ним сверяется
   * печатаемый адрес точки: расхождение это `address_mismatch` — «печатаем не то, что в заявке».
   */
  sourceAddresses: Map<string, string>;
}

/**
 * Комментарии и собственные адреса строк задания — одним чтением ездок (Р22).
 *
 * Комментарий: у ездки — её собственное примечание, а нет его — комментарий заказа; у линейного дня
 * — комментарий заявки, он же характер работ (ADR 0100 §10). Падать на комментарий заказа
 * приходится потому, что примечание ездки завелось миграцией 0136 и бэкфил оставил его пустым
 * (Р24): взяв только его, печать молча уронила бы вторую строку графы «Груз» у каждой заявки, где
 * комментарий заполнен, — то есть изменила бы уже выданный документооборот. Заполненное примечание
 * ездки при этом сильнее: оно про эту поездку, а комментарий — про весь заказ.
 *
 * Адрес строки берётся здесь же, а не вторым запросом: `RoutePointAction` несёт о расхождении
 * только флаг (`addressMismatch`), а предупреждение обязано назвать **оба** текста — иначе человек
 * подтверждает «адреса разошлись», не видя, чем именно. У линейного дня своего адреса нет: его
 * строка задания печатает объект заявки, и сверяется точка с ним (`objectLocation`).
 */
async function loadTaskRowFacts(
  tx: Tx,
  points: readonly VehicleRoutePointDto[],
  requests: ReadonlyMap<string, IssueRequest>,
): Promise<TaskRowFacts> {
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
          .select({
            id: vehicleRequestTrips.id,
            comment: vehicleRequestTrips.comment,
            fromLocation: vehicleRequestTrips.fromLocation,
            toLocation: vehicleRequestTrips.toLocation,
          })
          .from(vehicleRequestTrips)
          .where(inArray(vehicleRequestTrips.id, tripIds))
      : [];
  const trips = new Map(tripRows.map((row) => [row.id, row]));

  const notes = new Map<string, string>();
  const sourceAddresses = new Map<string, string>();
  for (const point of points) {
    for (const action of point.actions) {
      const request = requests.get(action.ref.requestId);
      const trip = action.kind === 'freight' ? trips.get(action.ref.tripId) : undefined;
      const own = trip?.comment ?? '';
      notes.set(taskRefKey(action.ref), own.trim() === '' ? (request?.comment ?? '') : own);
      sourceAddresses.set(
        taskAddressKey(action.ref, action.role),
        trip
          ? ((action.role === 'load' ? trip.fromLocation : trip.toLocation) ?? '')
          : (request?.objectLocation ?? ''),
      );
    }
  }
  return { notes, sourceAddresses };
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

  const customer = await loadWaybillCustomer(tx);

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
  const { notes, sourceAddresses } = await loadTaskRowFacts(tx, points, requests);
  const rows = waybillTaskRows(points, notes);
  /*
   * Строки задания состава — то, что заказано, в отличие от того, что разложено по точкам. Ими
   * считаются ёмкость бланка и неразложенные строки (`rows_unplaced`), и взять их из точек нельзя
   * по определению: забытой ездки в точках нет вовсе.
   *
   * У перегона состава не бывает (миграция 0082), и запрос вернёт пустой список: задание ему даёт
   * сам рейс, а не строки.
   */
  const composition = await routeTaskRefs(tx, route.routeId);

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
    customer,
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
    sourceAddresses,
    composition,
    rows,
    requests,
    header: headerRequestId ? (requests.get(headerRequestId) ?? null) : null,
  };
}

// ── Блокеры, предупреждения и рукопожатие (Р21, Р21а) ──

/**
 * Что мешает выписать лист по этому рейсу; пусто — не мешает ничего (Р11а).
 *
 * Считается тем же правилом, что показывает портал при сборке маршрута (`routeIssueBlockers`), и
 * из того же контекста, из которого печатается бумага (Р22): показать одно, а напечатать другое
 * здесь хуже, чем не показать вовсе.
 *
 * Пересечение с `canIssueWaybill` (контракты) — ровно два места, и оба разрешены в пользу
 * существующей проверки:
 *
 *   - **водитель**: та спрашивает его первой и без всякого чтения, а сюда он приходит уже
 *     непустым (`RouteWaybillContext.driverPersonId` — `string`), поэтому `no_driver` тут
 *     недостижим. Убирать его из общего правила незачем — им пользуется портал, где водителя может
 *     не быть;
 *   - **ёмкость бланка**: та считает **заявки**, здесь считаются **строки задания** — ездки плюс
 *     линейные дни (Р11). Второй счёт строго сильнее первого (заявка занимает не меньше одной
 *     строки), и это единственный правильный счёт для смешанного дня: заявка с тремя ездками
 *     занимает в бланке три строки, а в составе одну.
 *
 * Всё остальное — статусы состава, коррекция, право на пустой бланк, действующий лист рейса — так и
 * остаётся за `canIssueWaybill`: точки об этом не знают.
 */
export function issueBlockersOf(context: WaybillIssueContext): IssueBlocker[] {
  return routeIssueBlockers({
    driverPersonId: context.route.driverPersonId,
    formCode: context.formCode,
    points: context.points,
    composition: context.composition,
    notes: context.notes,
  });
}

/** Отказ по блокерам — кодом, а не текстом: по коду портал ведёт человека туда, где чинят. */
function blockerMessage(blocker: IssueBlocker): string {
  switch (blocker.code) {
    case 'no_driver':
      return 'назначьте водителя — он обязательный реквизит листа';
    case 'trip_order_broken':
      return `разгрузка раньше погрузки: ${blocker.refs.length} ездк(и) — переставьте точки маршрута`;
    case 'rows_unplaced':
      return `не разложено строк задания: ${blocker.refs.length} — положите их точками маршрута`;
    case 'capacity_exceeded':
      return `строк задания ${blocker.rows}, а бланк держит ${blocker.capacity} — уберите лишнее или заведите второй рейс`;
    case 'required_fields_overflow':
      return `строка задания ${blocker.slot} не помещается в бланк: ${blocker.fields.join(', ')} — сократите адрес точки`;
  }
}

/**
 * Предупреждения выписки — то, о чём человек должен знать до расхода номера (Р21).
 *
 * `blank_task` у перегона снимается: задание ему даёт сам рейс двумя строками «откуда — куда»
 * (миграция 0082), строк задания у него нет ни одной **по устройству**, и «в маршруте нет заявок»
 * было бы неправдой о единственном документе, который у перегона и печатается.
 */
export function issueWarningsOf(context: WaybillIssueContext): WaybillWarning[] {
  const warnings = waybillIssueWarnings({
    routeId: context.route.routeId,
    routeNumber: context.route.routeNumber,
    formCode: context.formCode,
    driver: {
      personId: context.driver.personId,
      name: context.driver.fio,
      gaps: context.driver.gaps,
    },
    points: context.points,
    notes: context.notes,
    sourceAddresses: context.sourceAddresses,
    costTargets: new Map(
      [...context.requests].flatMap(([id, request]) =>
        request.costTarget ? [[id, request.costTarget] as const] : [],
      ),
    ),
  });
  if (!context.route.relocation) return warnings;
  return warnings.filter((warning) => warning.facts.code !== 'blank_task');
}

/**
 * Отпечаток набора предупреждений (Р21).
 *
 * `sha256` от каноникализованных **фактов**, а не от текста: подтверждает человек положение дел, а
 * не формулировку. Переписали сообщение — подтверждение остаётся в силе; сменился факт у того же
 * объекта или переставили порядок талонов так, что расхождение переехало на другую точку, —
 * рукопожатие расходится, и лист молча не выпишется.
 *
 * Хеш берёт сервер: в браузере он не нужен вовсе — там отпечаток только возвращается обратно.
 */
export function warningsFingerprint(warnings: readonly WaybillWarning[]): string {
  return createHash('sha256').update(canonicalWarningPayload(warnings)).digest('hex');
}

/** Под какими предупреждениями выдан лист — конверт колонки `waybills.issue_warnings` (Р21). */
export type IssueWarningsRecord =
  | { schemaVersion: 1; status: 'clean' }
  | {
      schemaVersion: 1;
      status: 'acknowledged';
      fingerprint: string;
      /** Список целиком, с сообщениями: через полгода разбираться будут по нему, а не по кодам. */
      warnings: WaybillWarning[];
    };

/**
 * Рукопожатие над готовым набором предупреждений (Р21): пусто — `clean`, подтверждено —
 * `acknowledged`, иначе 409 `waybill_ack_required` со свежим отпечатком и полным списком.
 *
 * Отдельной функцией — потому что путей выпуска номера оказалось не четыре, а пять. Пятый это
 * недельный лист ЭСМ-2 по требованию (`issueEsm2Waybill`): рейса у него нет вовсе, номер он берёт
 * своей серией, а предупреждение у него ровно одно — пробелы в документах машиниста (ADR 0064),
 * общие с прочими бланками. Считаются наборы в разных местах, потому что считаются из разного, но
 * решение «пускать, спрашивать или записать подтверждённое» обязано быть одним: разойдись эти два
 * места, один и тот же набор в одном отвечал бы 409, а в другом молча писал бы `clean`.
 *
 * Чем отказ называет бумагу человеку (`label`) и что уходит в `details` сверх отпечатка и списка,
 * знает только вызывающий: у рейса это `routeId` и его номер (`WaybillAckRequiredDetails`), у
 * ЭСМ-2 — заявка и неделя (`Esm2AckRequiredDetails`).
 */
export function acknowledgeOrThrow<D extends object>(params: {
  warnings: WaybillWarning[];
  /** Отпечаток, который человек прислал обратно; `null` — подтверждения не присылали. */
  acknowledge: { fingerprint: string } | null;
  label: string;
  details: D;
}): IssueWarningsRecord {
  const { warnings } = params;
  if (warnings.length === 0) return { schemaVersion: 1, status: 'clean' };

  const fingerprint = warningsFingerprint(warnings);
  if (params.acknowledge?.fingerprint !== fingerprint) {
    /*
     * 409, а не 422: отказано не запросу, а его устареванию — набор предупреждений с момента
     * показа окна изменился либо не показывался вовсе (повтор из истории, старая вкладка, `curl`).
     * Новый отпечаток уходит в том же ответе, и вторая попытка с ним проходит.
     */
    throw err.conflict(
      `Выписка требует подтверждения: ${warnings.length} предупрежд(ение/ения) ${params.label}`,
      {
        code: WAYBILL_ACK_REQUIRED_CODE,
        details: { ...params.details, fingerprint, warnings },
      },
    );
  }
  return { schemaVersion: 1, status: 'acknowledged', fingerprint, warnings };
}

/**
 * Проверка перед расходом номера: блокеры — 422, неподтверждённые предупреждения — 409 (Р21).
 *
 * Порядок именно такой. Блокер это документ, по которому нельзя ехать, и подтверждать его человеку
 * не предлагают; предупреждение — положение дел, о котором он должен знать, и решение остаётся за
 * ним. Спросив рукопожатие первым, мы просили бы подтвердить бумагу, которая всё равно не выпишется.
 *
 * Пустой набор рукопожатия не требует вовсе: лист без единого предупреждения выписывается одним
 * нажатием, как и до Р21, и в колонку уходит `clean` — «проверено, предупреждений не было».
 */
function checkIssueOrThrow(context: WaybillIssueContext): IssueWarningsRecord {
  const blockers = issueBlockersOf(context);
  if (blockers.length > 0) {
    throw err.unprocessable(
      `Лист по этому рейсу не выписать: ${blockers.map(blockerMessage).join('; ')}`,
      undefined,
      { blockers },
    );
  }

  return acknowledgeOrThrow({
    warnings: issueWarningsOf(context),
    acknowledge: context.route.acknowledge,
    label: `по рейсу ${context.route.routeNumber}`,
    // `satisfies`, а не приведение: тело отказа описано контрактом ручки, и поле, забытое здесь,
    // должно ловиться сборкой, а не пустым местом в окне подтверждения.
    details: {
      routeId: context.route.routeId,
      routeNumber: context.route.routeNumber,
    } satisfies Omit<WaybillAckRequiredDetails, 'fingerprint' | 'warnings'>,
  });
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
    // Дата дню выезда, а не хранению: «23.08.2026» вместо ключа «2026-08-23». Перекладывается
    // здесь, при выписке, а не при печати — снимок печатается как выдан (ADR 0037 п. 10), и листы,
    // выписанные до этой работы, выходят из принтера с той датой, которая в них напечатана.
    waybill_date: formatWaybillDate(route.routeDate),

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
    // Расшифровка подписи водителя: графа узкая, и её пишут «Дегтярь И.В.» (`formatNameWithInitials`).
    driver_short_name: formatNameWithInitials(context.driver.fio),
    driver_snils: context.driver.snils,
    driver_personnel_no: context.driver.personnelNo,
    driver_license_number: context.driver.license,
    driver_license_issued_on: formatWaybillDate(context.driver.licenseIssuedOn),

    communication_kind: fields.communicationKind,
    transportation_kind: fields.transportationKind,

    /*
     * «В чьё распоряжение (наименование и адрес заказчика)» — заказчик портала (миграция 0164), а
     * не заявка шапки. Прежде сюда шёл объект: наименование стройки и её адрес, — то есть графа
     * отвечала «куда поехали», хотя спрашивает «от чьего имени распоряжаются машиной». Кому машина
     * поехала, водитель читает в задании (`task_from`/`task_to`), а не в шапке.
     *
     * Телефон — единым видом (ADR 0066), тем же ходом, что и телефон организации выше. У 4-П графы
     * под него нет вовсе, но снимок его хранит: разметку правят отдельно от выписки, а выданный
     * лист не переписывается.
     */
    customer_name: context.customer.name,
    customer_address: context.customer.address,
    customer_phone: formatPhone(context.customer.phone),
    /*
     * Объект, ради которого выписан лист, — одной строкой «Наименование, адрес» (той же склейкой,
     * какой его собирают точки маршрута). В 4-П он на бумагу не идёт: объект живёт в задании
     * водителю, — но снимок обязан помнить, на какой объект лист выписан, иначе после смены смысла
     * граф заказчика об этом не помнил бы никто. Печатает `object_line` только ЭСМ-2.
     *
     * У заявки отдела строка пуста, и это правда о ней: площадки у отдела нет (ADR 0040), а
     * называть объектом сам отдел значило бы записать в графу объекта то, чем он не является.
     */
    object_line: header?.objectLocation ?? '',
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
   * Рукопожатие и блокеры — **до** номера (Р21, Р21а): всё, что способно отказать, спрашивается,
   * пока бланк ещё не израсходован. Счётчик серии живёт строкой и откатился бы с транзакцией, но
   * ответ «строка задания не влезла» после сожжённого номера человек прочитал бы как поломку.
   *
   * Стоит это здесь, в общей точке выпуска, а не в ручке, ровно по Р21а: путей к листу по рейсу
   * четыре — обычная выписка, задняя, коррекция рейса и перенос заявки между рейсами, — и
   * пропущенный записал бы в свежий лист `issue_warnings = not_checked`, то есть обошёл бы
   * проверку, ради которой она заводилась. Пятый путь ведёт к другому бланку и потому к другой
   * общей точке — недельному ЭСМ-2 (`issueEsm2Waybill`), где рукопожатие устроено так же.
   */
  const issueWarnings = checkIssueOrThrow(context);

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
      /*
       * Под какими предупреждениями выдан лист — **той же вставкой**, что и сам документ (Р21).
       * Не аудитом: `writeAudit` намеренно best-effort — пишет отдельным соединением и глотает
       * ошибку, — и хранилищем решения человека быть не может. Здесь же оно неотделимо от бумаги:
       * есть лист — есть и то, под чем его подписали.
       */
      issueWarnings,
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
