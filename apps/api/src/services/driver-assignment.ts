import { and, asc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import {
  type DriverAssignmentContact,
  type DriverAssignmentDto,
  type DriverAssignmentEntry,
  type DriverAssignmentRequest,
  formatMoscowDateTime,
  isRelocationPurpose,
  vehicleLabel,
  type VehicleOwnership,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  freightTransportRequestDetails,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleModels,
  vehicleRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../db/schema';
import { loadRouteDtos, routeQuery } from './vehicle-routes';

/**
 * Задание работника: чем он занят в этот день — своими рейсами и своими недельными листами
 * (ADR 0102).
 *
 * Слой общий на двух потребителей, и общий он не ради обобщения: письмо-задание
 * (`mailings/driver-routes.ts`) и кабинет водителя показывают одному человеку один и тот же день, и
 * разойдись они запросом — водитель, прочитавший письмо с вечера, нашёл бы утром в кабинете другое
 * задание. Общая здесь сборка **рейсов**; недельные листы добавляет только кабинет (план Р12):
 * расширить аудиторию рассылки на машинистов — отдельное решение с отдельной ценой, и этот слой его
 * за рассылку не принимает.
 *
 * Второе свойство слоя следует из прав кабинета (Р4, Р13): у роли `driver` нет `directories.read`,
 * поэтому строка задания состоит из готовых подписей, а идентификаторов справочников — типов ТС,
 * контрагентов, объектов — в ней нет вовсе. Единственные идентификаторы здесь свои: рейса и листа,
 * ими сервер потом находит источник показаний.
 *
 * Чего в задании не бывает: листов 4-П и формы № 3 (Р16). Их выезд уже представлен рейсом —
 * `waybills_form_source_check` требует у этих форм заполненный `route_id`, — и своей строкой такой
 * лист задвоил бы одну и ту же смену.
 */

/** Зачем выезд. Слов ровно три: рейс едет за грузом или перегоном, лист — работать на площадке. */
const PURPOSE_FREIGHT = 'Грузоперевозка';
const PURPOSE_RELOCATION = 'Перегон техники';
const PURPOSE_SITE = 'Работа на объекте';

// ── Подпись машины ──

/**
 * Подпись машины в задании — марка и госномер вместе: «КамАЗ 65115 · А123ВС45».
 *
 * Пара, а не один госномер, которым машину называет гараж (`vehicleLabel`): гараж читает диспетчер,
 * держащий перед глазами весь парк, а водитель сверяет строку с машиной во дворе и узнаёт её по
 * марке раньше, чем по номеру. Той же парой рейс назван в карточке маршрута (`toRouteDto`) и в
 * письме, и разойтись заданию с ними нельзя — письмо и кабинет читает один человек.
 *
 * Пустой пара бывает у аренды: своего госномера у неё нет вовсе (ADR 0018), а модель заводят не
 * всегда. Тогда подпись собирается общим правилом портала — описанием, категорией, типом: строка
 * «Машина: » без машины хуже любого из них.
 */
function assignmentVehicleLabel(v: {
  ownership: VehicleOwnership;
  description: string;
  categoryName: string | null;
  typeName: string;
  registrationNumber: string | null;
  modelName: string | null;
}): string {
  return [v.modelName, v.registrationNumber].filter(Boolean).join(' · ') || vehicleLabel(v);
}

/** Подписи машин пачкой: ключ — идентификатор машины, наружу он не выходит. */
async function vehicleLabels(vehicleIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (vehicleIds.length === 0) return map;

  const rows = await db
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      description: vehicles.description,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(inArray(vehicles.id, vehicleIds));

  for (const row of rows) map.set(row.id, assignmentVehicleLabel(row));
  return map;
}

// ── Состав рейса ──

/** Контакты и комментарий заявки: в DTO состава рейса их нет, а водителю звонить именно им. */
interface RequestExtra {
  comment: string;
  /** Кого набирать: у грузоперевозки — на погрузке и на выгрузке, у объекта — встречающий. */
  contacts: DriverAssignmentContact[];
}

async function requestExtras(requestIds: string[]): Promise<Map<string, RequestExtra>> {
  const map = new Map<string, RequestExtra>();
  if (requestIds.length === 0) return map;

  // Обе detail-таблицы разом: тип заявки заранее неизвестен, а join'ы левые — у заявки заполнена
  // ровно одна из них.
  const rows = await db
    .select({
      id: vehicleRequests.id,
      comment: vehicleRequests.comment,
      loadingName: freightTransportRequestDetails.loadingResponsibleName,
      loadingPhone: freightTransportRequestDetails.loadingResponsiblePhone,
      unloadingName: freightTransportRequestDetails.unloadingResponsibleName,
      unloadingPhone: freightTransportRequestDetails.unloadingResponsiblePhone,
      siteName: specialEquipmentRequestDetails.responsibleName,
      sitePhone: specialEquipmentRequestDetails.responsiblePhone,
    })
    .from(vehicleRequests)
    .leftJoin(
      freightTransportRequestDetails,
      eq(freightTransportRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(inArray(vehicleRequests.id, requestIds));

  for (const row of rows) {
    // Телефон едет цифрами, как лежит в базе (ADR 0066): набираемый вид — правило контрактов
    // (`formatPhone`), одно на письмо и на кабинет, а ссылку «позвонить» портал собирает как раз из
    // цифр. Правило Р13 этому не противоречит: оно закрывает справочники, а не формат числа.
    const contacts = [
      { label: 'Погрузка', name: row.loadingName ?? '', phone: row.loadingPhone ?? '' },
      { label: 'Выгрузка', name: row.unloadingName ?? '', phone: row.unloadingPhone ?? '' },
      { label: 'На месте', name: row.siteName ?? '', phone: row.sitePhone ?? '' },
      // Контакт без имени и без телефона печатать нечем: у заявок, заведённых до появления этих
      // полей, они пустые.
    ].filter((c) => c.name !== '' || c.phone !== '');
    map.set(row.id, { comment: row.comment, contacts });
  }
  return map;
}

/** «08:30» или пусто, если у заявки время не задано: тогда значима только дата. */
function timeOf(request: VehicleRouteRequestDto): string {
  if (request.scheduledTimeUnspecified) return '';
  return formatMoscowDateTime(new Date(request.scheduledAt)).slice(-5);
}

function assignmentRequest(
  request: VehicleRouteRequestDto,
  extra: RequestExtra | undefined,
): DriverAssignmentRequest {
  return {
    displayNumber: request.displayNumber,
    customerName: request.customerName,
    loadingLocation: request.loadingLocation,
    unloadingLocation: request.unloadingLocation,
    time: timeOf(request),
    cargoLabel: request.cargoLabel,
    comment: extra?.comment ?? '',
    contacts: extra?.contacts ?? [],
  };
}

// ── Рейсы ──

/**
 * Строка задания глазами письма: то же, что видит кабинет, плюс два поля перегона.
 *
 * Живут они здесь, а не в контракте кабинета, потому что нужны одному письму: «Основание: ТС-501 ·
 * ООО …» печатается ради бумаги, по которой едут, а водитель в кабинете читает перегон как
 * «откуда/куда» — номер чужой заявки ему не работа. Данные всё равно приходят вместе с рейсом, и
 * отдельный запрос ради одной строки письма был бы платой за формальную чистоту типа.
 */
export interface DriverRouteEntry extends DriverAssignmentEntry {
  /** Перегон: письмо печатает ему задание «откуда/куда» вместо состава. */
  relocation: boolean;
  /** «ТС-501 · ООО „Ромашка“» — заявка, ради которой едет перегон; пусто, если её нет. */
  basisLabel: string;
}

function routeEntry(
  route: VehicleRouteDto,
  vehicle: string,
  extras: Map<string, RequestExtra>,
): DriverRouteEntry {
  const relocation = isRelocationPurpose(route.purpose);
  return {
    sourceKind: 'route',
    sourceId: route.id,
    sourceLabel: route.displayNumber,
    purposeLabel: relocation ? PURPOSE_RELOCATION : PURPOSE_FREIGHT,
    vehicleLabel: vehicle,
    garageNumber: route.garageNumber,
    // Прицеп называется, только когда рейс идёт с прицепом: его реквизиты остаются в рейсе и после
    // снятия галки — они наследуются от прошлого листа машины, и «Прицеп: …» у рейса без прицепа
    // отправил бы водителя цеплять то, что сегодня не везут.
    trailerLabel: route.withTrailer ? route.trailerLabel : '',
    // Строка ожидания показаний и место смены в дне машины появляются при открытии отчёта (Р17):
    // здесь задание, и записывать в него пока нечего.
    itemId: null,
    shiftOrder: null,
    requests: route.requests.map((q) => assignmentRequest(q, extras.get(q.requestId))),
    moveFrom: route.moveFrom,
    moveTo: route.moveTo,
    comment: route.comment,
    relocation,
    basisLabel: route.sourceRequest
      ? `${route.sourceRequest.displayNumber} · ${route.sourceRequest.customerName}`
      : '',
  };
}

/**
 * Задание за окно дат — только рейсы, ключ карты — дата рейса. Даты идут по возрастанию: карта
 * помнит порядок вставки, а рейсы приходят отсортированными.
 *
 * Отменённые и удалённые заявки в задание не попадают: они остаются в маршруте историей рейса (лист
 * уже выписан), но ехать по ним не надо, и показать их — ввести водителя в заблуждение. Рейс,
 * оставшийся без единой живой заявки, не показывается вовсе: строка «Машина: …» без задания
 * сообщает ровно ничего. Перегон остаётся всегда — у него задание не в составе, а в «откуда/куда».
 */
export async function loadRouteEntries(
  personId: string,
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, DriverRouteEntry[]>> {
  const byDate = new Map<string, DriverRouteEntry[]>();

  const rows = await routeQuery(db)
    .where(
      and(
        eq(vehicleRoutes.driverPersonId, personId),
        gte(vehicleRoutes.routeDate, dateFrom),
        lte(vehicleRoutes.routeDate, dateTo),
      ),
    )
    .orderBy(asc(vehicleRoutes.routeDate), asc(vehicleRoutes.num));
  if (rows.length === 0) return byDate;

  const routes = await loadRouteDtos(db, rows);
  // Живые заявки состава: `requestsByRoute` их не фильтрует — там состав как история рейса.
  const requestIds = routes.flatMap((r) => r.requests.map((q) => q.requestId));
  const alive = new Set(
    requestIds.length === 0
      ? []
      : (
          await db
            .select({ id: vehicleRequests.id })
            .from(vehicleRequests)
            .where(and(inArray(vehicleRequests.id, requestIds), isNull(vehicleRequests.deletedAt)))
        ).map((r) => r.id),
  );
  const visible = routes
    .map((route) => ({
      ...route,
      requests: route.requests.filter((q) => alive.has(q.requestId) && q.status !== 'cancelled'),
    }))
    .filter((route) => isRelocationPurpose(route.purpose) || route.requests.length > 0);
  if (visible.length === 0) return byDate;

  const [extras, labels] = await Promise.all([
    requestExtras([...alive]),
    vehicleLabels([...new Set(visible.map((route) => route.vehicleId))]),
  ]);

  for (const route of visible) {
    const list = byDate.get(route.routeDate) ?? [];
    // Машина у рейса своя всегда (innerJoin в `routeQuery`), и подпись из карточки маршрута здесь
    // запасной вариант, а не второе правило.
    list.push(routeEntry(route, labels.get(route.vehicleId) ?? route.vehicleLabel, extras));
    byDate.set(route.routeDate, list);
  }
  return byDate;
}

// ── Недельные листы ──

/**
 * Действующие листы ЭСМ-2, накрывающие день, — тем же условием, каким гараж считает машиниста
 * занятым (`driverWaybillExists`). Спрашивается лист, а не заявка: заявку могли закрыть или
 * откатить, а бланк недели остался у машиниста на руках — по документу он работает, и день у него
 * не пустой.
 *
 * Прочие формы сюда не попадают по правилу Р16, а не по недосмотру: у 4-П и формы № 3 заполнен
 * `route_id`, их выезд уже показан рейсом.
 */
async function esm2Entries(personId: string, date: string): Promise<DriverAssignmentEntry[]> {
  const rows = await db
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      vehicleId: waybills.vehicleId,
      garageNumber: waybills.garageNumber,
      withTrailer: waybills.withTrailer,
      trailer1Model: waybills.trailer1Model,
      trailer1RegNumber: waybills.trailer1RegNumber,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(
      and(
        eq(waybills.driverPersonId, personId),
        eq(waybills.formCode, 'esm2'),
        ne(waybills.status, 'cancelled'),
        lte(waybills.periodFrom, date),
        gte(waybills.periodTo, date),
      ),
    )
    // Номер уникален только внутри серии (`waybills_series_number_unique`), поэтому порядок
    // доопределён идентификатором: у машиниста законно бывает два действующих листа разных серий
    // (Р15), и без второго ключа они менялись бы местами от запроса к запросу.
    .orderBy(asc(waybills.number), asc(waybills.id));
  if (rows.length === 0) return [];

  const labels = await vehicleLabels([...new Set(rows.map((row) => row.vehicleId))]);

  return rows.map((row) => ({
    sourceKind: 'esm2',
    sourceId: row.id,
    sourceLabel: `ЭСМ-2 № ${waybillDisplayNumber(row.prefix, row.number, row.numberWidth)}`,
    purposeLabel: PURPOSE_SITE,
    vehicleLabel: labels.get(row.vehicleId) ?? '',
    garageNumber: row.garageNumber,
    trailerLabel: row.withTrailer
      ? [row.trailer1Model, row.trailer1RegNumber].filter(Boolean).join(' ')
      : '',
    itemId: null,
    shiftOrder: null,
    // Состава у листа не бывает: неделю работы задаёт заявка-основание, а талонов заказчиков на
    // площадке нет. Нет и «откуда/куда» — машина всю неделю там же, куда её привезли.
    requests: [],
    moveFrom: '',
    moveTo: '',
    // Комментарий пишут рейсу: у листа графы для слов диспетчера нет.
    comment: '',
  }));
}

// ── Задание ──

/**
 * Строки задания работника на дату: рейсы и действующие недельные листы. Пустой список — законное
 * состояние экрана, а не ошибка: заданий на день может не быть.
 *
 * Порядок тот же, каким день машины читает гараж: сначала рейсы, следом документ недели. Два экрана
 * не разойдутся, а водитель читает строку сверху вниз от того, куда сегодня ехать.
 */
export async function loadDayEntries(
  personId: string,
  date: string,
): Promise<DriverAssignmentEntry[]> {
  const [byDate, weekly] = await Promise.all([
    loadRouteEntries(personId, date, date),
    esm2Entries(personId, date),
  ]);
  const routes = (byDate.get(date) ?? []).map(cabinetEntry);
  return [...routes, ...weekly];
}

/**
 * Строка кабинета из строки письма: поля перегона, заведённые ради «Основания», отбрасываются
 * явно. В кабинете перегон читается как «откуда/куда», и отдавать туда номер чужой заявки только
 * потому, что он уже загружен, — тот же лишний реквизит, каких кабинет не получает по праву (Р13).
 */
function cabinetEntry({
  relocation: _relocation,
  basisLabel: _basisLabel,
  ...entry
}: DriverRouteEntry): DriverAssignmentEntry {
  return entry;
}

/**
 * Задание на дату целиком. `canSubmit` приходит готовым, а не считается здесь: окно записи у
 * водителя уже, чем у персонала (Р11), и знает об этом маршрут, у которого есть принципал.
 */
export async function buildAssignment(
  personId: string,
  date: string,
  canSubmit: boolean,
): Promise<DriverAssignmentDto> {
  return { date, canSubmit, entries: await loadDayEntries(personId, date) };
}
