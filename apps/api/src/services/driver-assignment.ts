import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne } from 'drizzle-orm';
import {
  type DriverAssignmentAction,
  type DriverAssignmentDto,
  type DriverAssignmentEntry,
  type DriverAssignmentPoint,
  type DriverPreviousReading,
  formatMoscowDateTime,
  isRelocationPurpose,
  pointContacts,
  type RoutePointAction,
  trailerLabelOf,
  vehicleLabel,
  type VehicleOwnership,
  type VehicleRoutePointDto,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  vehicleCategories,
  vehicleModels,
  vehicleReadings,
  vehicleRequests,
  vehicleRequestTrips,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../db/schema';
import { daysBetween } from './readings-chain';
import { loadRoutePoints } from './route-points';
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
 *
 * Третье свойство появилось после первого показа и разводит двух потребителей: **кабинет строго
 * документален** (`docs/driver-cabinet-ux-plan.md`, Р5) — рейс входит в задание, только если по
 * нему выписан действительный путевой лист, потому что показания некуда переносить, пока бланка
 * нет. Письмо-рассылка этого условия не получает намеренно: оно уходит вечером накануне, когда
 * листа обычно ещё нет, и лишить водителя адресов накануне выезда хуже расхождения каналов.
 * Поэтому фильтр стоит на пути кабинета (`loadDayEntries`), а не в общей сборке рейсов.
 *
 * Четвёртое свойство — с этапа 8 плана `docs/route-trips-plan.md`: **задание собирается по точкам, а
 * не по заявкам**. Блок здесь — остановка порядка объезда (адрес, время, что грузим и что
 * выгружаем, все её ответственные, записка о ней), а не заявка одной парой адресов, как было до
 * ездок. Иначе и нельзя: у заявки с ездками `A→B` и `A→C` «адреса разгрузки» не существует вовсе, а
 * два заезда в один карьер — одна остановка, а не две (Р4, Р5). Порядок тот же, каким его показывает
 * карточка маршрута, — по позициям точек, и разойтись каналам негде: сборщик один.
 *
 * И то, чего в бумаге нет: **свёрнутого здесь не бывает**. Всё, что бланк спрятал в «+N» или обрезал
 * по ширине графы (Р11а), письмо и кабинет показывают целиком — ширины графы у них нет, а
 * свёртывание в бланке ровно тем и оплачено, что полный текст доедет до водителя этим каналом
 * (§8 плана).
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

// ── Порядок объезда ──

/**
 * Подпись роли — словами водителя, а не модели: он читает задание как последовательность действий
 * («приехал — грузим», «приехал — выгружаем»), а не как перечень ролей. У линейного дня действие
 * одно и то же слово, каким назван весь такой выезд (`PURPOSE_SITE`): работать на объекте — это и
 * есть его задание, других глаголов у него нет (Р5а).
 *
 * Собирается здесь, а не в каждом канале: письмо и кабинет читает один человек, и разные слова на
 * одно действие он прочтёт как разное задание.
 */
const ROLE_LABELS: Record<RoutePointAction['role'], string> = {
  load: 'Грузим',
  unload: 'Выгружаем',
  work: PURPOSE_SITE,
};

/** «08:30» или пусто, если у заявки время не задано: тогда значима только дата. */
function timeOf(request: VehicleRouteRequestDto): string {
  if (request.scheduledTimeUnspecified) return '';
  return formatMoscowDateTime(new Date(request.scheduledAt)).slice(-5);
}

/**
 * Час подачи по заявкам рейсов — запасной ход для точки, у которой своего времени нет.
 *
 * Берутся только грузовые строки состава (`workDate` пуст): у заказа техники на объект времени
 * подачи не существует, а `scheduledAt` строки состава заполняется у него текущим моментом
 * (`requestsByRoute`) — подставить его значило бы напечатать водителю час, который значит «когда
 * собрали письмо».
 */
function requestTimes(requests: readonly VehicleRouteRequestDto[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const request of requests) {
    if (request.workDate) continue;
    const time = timeOf(request);
    if (time !== '') map.set(request.requestId, time);
  }
  return map;
}

/**
 * Время прибытия на остановку: своё, а нет его — час подачи самой ранней заявки, которую здесь
 * **грузят**.
 *
 * Запасной ход нужен не для красоты. Время точки необязательно, и бэкфил маршрутов, собранных до
 * релиза, не заполнил его ни у одной (§5.6 плана); заявка же час подачи несёт всегда. Возьми
 * задание только время точки — водитель разом потерял бы «08:30», которое получает сегодня.
 *
 * Только погрузка: подача — это «во сколько быть под загрузкой», и час разгрузки из неё не следует.
 * Минимум, а не первое вхождение: на совмещённой остановке грузят две ездки, и приехать надо к
 * ранней из них. Сравнение строк «ЧЧ:ММ» лексикографически и есть сравнение времени.
 */
function pointArrivalTime(
  point: VehicleRoutePointDto,
  actions: readonly RoutePointAction[],
  times: ReadonlyMap<string, string>,
): string {
  if (point.arrivalTime !== '') return point.arrivalTime;
  const scheduled = actions
    .filter((action) => action.role === 'load')
    .flatMap((action) => {
      const time = times.get(action.ref.requestId);
      return time ? [time] : [];
    });
  return scheduled.length === 0 ? '' : scheduled.reduce((min, time) => (time < min ? time : min));
}

/**
 * Комментарий строки задания — тем же правилом, каким его печатает бланк (`loadTaskRowFacts` в
 * `waybill-issue.ts`): у ездки её собственное примечание, а нет его — комментарий заказа; у
 * линейного дня — комментарий заявки, он же характер работ (ADR 0100 §10).
 *
 * Правило повторено, а не разделено с выпиской, потому что делить нечего: там оно считается под
 * блокировкой рейса вместе с адресами строк, здесь — на чтении задания. Существенно другое —
 * **значение обязано совпасть**: бланк комментарий при нехватке места выбрасывает первым (Р11а), и
 * задание водителю есть то самое место, где он показывается целиком. Возьми оно другое значение —
 * водитель сверял бы с бумагой не тот текст.
 *
 * Падение на комментарий заказа — та же плата за бэкфил, что и в бланке: примечание ездки завелось
 * миграцией `0136` и у прежних заявок пусто (Р24), а комментарий заказа у них заполнен.
 */
function actionComment(
  action: RoutePointAction,
  tripNotes: ReadonlyMap<string, string>,
  requestComments: ReadonlyMap<string, string>,
): string {
  const request = requestComments.get(action.ref.requestId) ?? '';
  if (action.kind === 'linear') return request;
  const own = tripNotes.get(action.ref.tripId) ?? '';
  return own.trim() === '' ? request : own;
}

function assignmentAction(
  action: RoutePointAction,
  tripNotes: ReadonlyMap<string, string>,
  requestComments: ReadonlyMap<string, string>,
): DriverAssignmentAction {
  return {
    role: action.role,
    roleLabel: ROLE_LABELS[action.role],
    displayNumber: action.displayNumber,
    customerName: action.customerName,
    // Количество несёт только ездка: у линейного дня его не бывает вовсе, а работу описывает
    // комментарий заявки — он и стоит в графе груза бланка (ADR 0100 §10).
    cargoLabel: action.kind === 'freight' ? action.cargoLabel : '',
    comment: actionComment(action, tripNotes, requestComments),
  };
}

/**
 * Остановка задания. `null` — на ней не осталось ни одной строки, которую надо ехать: заявку
 * отменили или удалили, а точка её ролей осталась в маршруте историей рейса.
 *
 * Ответственные пересчитываются, а не берутся у точки: `loadRoutePoints` считает их по **всем**
 * ролям, включая роли отменённых заявок, и оставить готовый список значило бы отправить водителя
 * звонить тому, к кому он сегодня не едет. Правило то же самое (`pointContacts`) — меняется только
 * то, из чего оно считает.
 */
function assignmentPoint(
  point: VehicleRoutePointDto,
  visible: ReadonlySet<string>,
  tripNotes: ReadonlyMap<string, string>,
  requestComments: ReadonlyMap<string, string>,
  times: ReadonlyMap<string, string>,
): DriverAssignmentPoint | null {
  const actions = point.actions.filter((action) => visible.has(action.ref.requestId));
  if (actions.length === 0) return null;
  return {
    position: point.position,
    location: point.location,
    arrivalTime: pointArrivalTime(point, actions, times),
    actions: actions.map((action) => assignmentAction(action, tripNotes, requestComments)),
    contacts: pointContacts(actions),
    comment: point.comment,
  };
}

/**
 * Комментарии живых заявок рейсов. Ключи карты — они же и ответ на «жива ли заявка»: удалённая
 * (`deleted_at`) остаётся в маршруте историей рейса, но ехать по ней не надо, и в задание она не
 * входит ни строкой, ни адресом.
 *
 * Один запрос на оба вопроса, потому что вопрос один: заявка, которой нет, комментария не имеет.
 */
async function liveRequestComments(requestIds: string[]): Promise<Map<string, string>> {
  if (requestIds.length === 0) return new Map();
  const rows = await db
    .select({ id: vehicleRequests.id, comment: vehicleRequests.comment })
    .from(vehicleRequests)
    .where(and(inArray(vehicleRequests.id, requestIds), isNull(vehicleRequests.deletedAt)));
  return new Map(rows.map((row) => [row.id, row.comment]));
}

/**
 * Примечания ездок по их идентификаторам. Мягко удалённых среди них не бывает: точка удалённой
 * ездки роли не отдаёт вовсе (`loadRoutePoints`), и спрашивать здесь `deleted_at` было бы вторым
 * местом, где решается, какая ездка едет.
 */
async function tripComments(tripIds: string[]): Promise<Map<string, string>> {
  if (tripIds.length === 0) return new Map();
  const rows = await db
    .select({ id: vehicleRequestTrips.id, comment: vehicleRequestTrips.comment })
    .from(vehicleRequestTrips)
    .where(inArray(vehicleRequestTrips.id, tripIds));
  return new Map(rows.map((row) => [row.id, row.comment]));
}

/**
 * Точки рейсов пачкой — по запросу на рейс, а не одним на все.
 *
 * Собственная выборка была бы вторым описанием того, что такое точка: `loadRoutePoints` знает и
 * порядок ролей, и `pairPosition`, и расхождение адреса, и правило контактов, — а рейсов у водителя
 * на день один-два, у письма на неделю вперёд единицы. Запросы идут разом, и цена этой честности —
 * несколько параллельных чтений вместо одного.
 */
async function routePoints(routeIds: string[]): Promise<Map<string, VehicleRoutePointDto[]>> {
  const loaded = await Promise.all(
    routeIds.map(async (id) => [id, await loadRoutePoints(db, id)] as const),
  );
  return new Map(loaded);
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
  points: DriverAssignmentPoint[],
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
    points,
    moveFrom: route.moveFrom,
    moveTo: route.moveTo,
    comment: route.comment,
    // Прошлый снимок счётчиков заполняет кабинет, и только он: письму сравнивать нечего — оно
    // ничего не вводит, и лишний запрос ради непечатаемого поля был бы платой ни за что.
    previous: null,
    relocation,
    basisLabel: route.sourceRequest
      ? `${route.sourceRequest.displayNumber} · ${route.sourceRequest.customerName}`
      : '',
  };
}

/**
 * Строка задания вместе с машиной, на которой её едут. Машина наружу не выходит вовсе (Р13), но
 * внутри слоя без неё не обойтись: прошлый снимок счётчиков ищется именно по машине, а искать его
 * по подписи «КамАЗ 65115 · А123ВС45» значило бы держать вторым ключом строку для человека.
 */
interface EntrySource<E extends DriverAssignmentEntry> {
  entry: E;
  vehicleId: string;
}

/**
 * Задание за окно дат — только рейсы, ключ карты — дата рейса. Даты идут по возрастанию: карта
 * помнит порядок вставки, а рейсы приходят отсортированными.
 *
 * Отменённые и удалённые заявки в задание не попадают: они остаются в маршруте историей рейса (лист
 * уже выписан), но ехать по ним не надо, и показать их — ввести водителя в заблуждение. Отбор один
 * на оба слоя рейса: строка состава решает, показывается ли рейс вообще, тот же список — какие роли
 * остаются на точках. Разойдись они, водитель получил бы остановку отменённой заявки в маршруте,
 * которого по ней нет.
 *
 * Рейс, оставшийся без единой живой заявки, не показывается вовсе: строка «Машина: …» без задания
 * сообщает ровно ничего. Перегон остаётся всегда — у него задание не в составе, а в «откуда/куда»,
 * и точек ему не заводится.
 *
 * Действительного листа этот отбор не спрашивает: условие Р5 принадлежит кабинету, а не общей
 * сборке, — см. `loadDayEntries`.
 */
async function routeSources(
  personId: string,
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, EntrySource<DriverRouteEntry>[]>> {
  const byDate = new Map<string, EntrySource<DriverRouteEntry>[]>();

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
  const comments = await liveRequestComments(
    routes.flatMap((r) => r.requests.map((q) => q.requestId)),
  );
  // Заявки, по которым сегодня едут: живые и не отменённые. Статус — свойство самой заявки, а не
  // её строки в рейсе, поэтому список один на все рейсы окна.
  const visibleRequests = new Set(
    routes
      .flatMap((route) => route.requests)
      .filter((q) => comments.has(q.requestId) && q.status !== 'cancelled')
      .map((q) => q.requestId),
  );
  const visible = routes
    .map((route) => ({
      ...route,
      requests: route.requests.filter((q) => visibleRequests.has(q.requestId)),
    }))
    .filter((route) => isRelocationPurpose(route.purpose) || route.requests.length > 0);
  if (visible.length === 0) return byDate;

  const [points, labels] = await Promise.all([
    // Точки нужны только там, где есть порядок объезда: у перегона его нет вовсе (миграция 0082), и
    // спрашивать их значило бы читать пустоту на каждый перегон дня.
    routePoints(visible.flatMap((route) => (isRelocationPurpose(route.purpose) ? [] : [route.id]))),
    vehicleLabels([...new Set(visible.map((route) => route.vehicleId))]),
  ]);
  const notes = await tripComments([
    ...new Set(
      [...points.values()].flatMap((list) =>
        list.flatMap((point) =>
          point.actions.flatMap((action) =>
            action.kind === 'freight' && visibleRequests.has(action.ref.requestId)
              ? [action.ref.tripId]
              : [],
          ),
        ),
      ),
    ),
  ]);

  for (const route of visible) {
    const list = byDate.get(route.routeDate) ?? [];
    const times = requestTimes(route.requests);
    const ordered = (points.get(route.id) ?? []).flatMap((point) => {
      const block = assignmentPoint(point, visibleRequests, notes, comments, times);
      return block ? [block] : [];
    });
    // Машина у рейса своя всегда (innerJoin в `routeQuery`), и подпись из карточки маршрута здесь
    // запасной вариант, а не второе правило.
    list.push({
      entry: routeEntry(route, labels.get(route.vehicleId) ?? route.vehicleLabel, ordered),
      vehicleId: route.vehicleId,
    });
    byDate.set(route.routeDate, list);
  }
  return byDate;
}

/**
 * Рейсы окна для письма-рассылки — те же, что собирает кабинет, но **без условия о листе** (Р5) и
 * без прошлого снимка счётчиков: письмо адресует водителя к месту работы, а не принимает у него
 * числа. Расхождение каналов названо в плане прямо и является решением, а не побочным следствием.
 */
export async function loadRouteEntries(
  personId: string,
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, DriverRouteEntry[]>> {
  const byDate = await routeSources(personId, dateFrom, dateTo);
  return new Map([...byDate].map(([date, list]) => [date, list.map((source) => source.entry)]));
}

/**
 * Рейсы, по которым выписан действительный лист: строка в `waybills` с этим `route_id` и статусом,
 * отличным от `cancelled`. Спрашивается наличие документа, а не его форма: у рейса это 4-П или
 * форма № 3 (`waybills_form_source_check`), и перечислять их здесь значило бы завести второе место,
 * где записано, какими формами закрывается рейс.
 *
 * Аннулированный лист не считается выписанным намеренно: его номер списан, переносить показания
 * некуда, и до перевыписки рейса для кабинета нет.
 *
 * Лист спрашивается **этого работника**, а не любой. Кабинет показывает то, на что у водителя есть
 * бумага (ADR 0105), а бумага именная: `waybills.driver_person_id` заполнен всегда. Переназначили
 * рейс, не перевыписав лист, — новый водитель рейса не увидит, и это верно: ехать ему не по чему,
 * а прежний лист по-прежнему обязывает того, на кого выписан. Чинится это коррекцией листа
 * (ADR 0101), а не показом чужого документа.
 */
async function documentedRoutes(routeIds: string[], personId: string): Promise<Set<string>> {
  if (routeIds.length === 0) return new Set();
  const rows = await db
    .select({ routeId: waybills.routeId })
    .from(waybills)
    .where(
      and(
        inArray(waybills.routeId, routeIds),
        ne(waybills.status, 'cancelled'),
        eq(waybills.driverPersonId, personId),
      ),
    );
  return new Set(rows.map((row) => row.routeId).filter((id): id is string => id !== null));
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
async function esm2Sources(
  personId: string,
  date: string,
): Promise<EntrySource<DriverAssignmentEntry>[]> {
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
      // Обе пары, хотя у ЭСМ-2 прицепов не бывает по устройству (`waybill-esm2.ts` пишет графы
      // пустыми): подпись здесь считается той же функцией, что у рейса и журнала, и кормить её
      // усечённой строкой значило бы завести четвёртый ответ на вопрос, у которого он один.
      trailer2Model: waybills.trailer2Model,
      trailer2RegNumber: waybills.trailer2RegNumber,
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
    vehicleId: row.vehicleId,
    entry: {
      sourceKind: 'esm2',
      sourceId: row.id,
      sourceLabel: `ЭСМ-2 № ${waybillDisplayNumber(row.prefix, row.number, row.numberWidth)}`,
      purposeLabel: PURPOSE_SITE,
      vehicleLabel: labels.get(row.vehicleId) ?? '',
      garageNumber: row.garageNumber,
      trailerLabel: row.withTrailer ? trailerLabelOf(row) : '',
      itemId: null,
      shiftOrder: null,
      // Порядка объезда у листа не бывает: неделю работы задаёт заявка-основание, точек ей не
      // заводится, и заезд у машины один — на площадку, куда её привезли. Нет по той же причине и
      // «откуда/куда»: всю неделю она там же.
      points: [],
      moveFrom: '',
      moveTo: '',
      // Комментарий пишут рейсу: у листа графы для слов диспетчера нет.
      comment: '',
      // Снимок счётчиков подставляет сборка дня — одним запросом на все машины сразу.
      previous: null,
    },
  }));
}

// ── Прошлый снимок счётчиков ──

/**
 * Последнее показание каждой машины **строго раньше** дня задания: по нему кабинет подписывает поле
 * («предыдущее: 145 320 (10.08)») и предупреждает о падении счётчика ещё до отправки (план правок,
 * Р6).
 *
 * Строгость границы существенна: показание того же дня водитель как раз и вводит — сравнивать его с
 * самим собой значило бы объявить нормой любую цифру, лишь бы её однажды сохранили. Порядок —
 * `(report_date, shift_order)`, тот же, каким идёт учётная цепочка (`readings-chain`): день без
 * позиции смены не различает две смены одной машины.
 *
 * Берётся именно строка, а не два счётчика по отдельности: это подсказка «что было в прошлый раз», а
 * не звено учёта. Цепочку по каждому счётчику отдельно ведёт `readings-chain`, и повторять её здесь
 * значило бы завести второй источник правды о том, с чем сравнивают показание.
 *
 * `no_data` пропускается: в такой строке чисел нет по определению (`vehicle_readings_values_check`).
 */
async function previousReadings(
  vehicleIds: string[],
  date: string,
): Promise<Map<string, DriverPreviousReading>> {
  const map = new Map<string, DriverPreviousReading>();
  if (vehicleIds.length === 0) return map;

  // Один запрос на все машины дня, а не по запросу на строку: у машиниста с двумя листами и рейсом
  // строк три, а машин обычно одна, и `DISTINCT ON` снимает ровно верхнюю строку каждой машины.
  const rows = await db
    .selectDistinctOn([vehicleReadings.vehicleId], {
      vehicleId: vehicleReadings.vehicleId,
      odometerKm: vehicleReadings.odometerKm,
      engineHours: vehicleReadings.engineHours,
      reportDate: vehicleReadings.reportDate,
    })
    .from(vehicleReadings)
    .where(
      and(
        inArray(vehicleReadings.vehicleId, vehicleIds),
        eq(vehicleReadings.kind, 'values'),
        lt(vehicleReadings.reportDate, date),
      ),
    )
    .orderBy(
      asc(vehicleReadings.vehicleId),
      desc(vehicleReadings.reportDate),
      desc(vehicleReadings.shiftOrder),
    );

  for (const row of rows) {
    map.set(row.vehicleId, {
      odometerKm: row.odometerKm,
      // Моточасы лежат `numeric(9,1)` и приходят строкой: портал сравнивает их числом, и оставить
      // «9812.5» в поле числа значило бы отдать сравнение первому же `<` в браузере.
      engineHours: row.engineHours === null ? null : Number(row.engineHours),
      measuredOn: row.reportDate,
      daysAgo: daysBetween(row.reportDate, date),
    });
  }
  return map;
}

// ── Задание ──

/**
 * Строки задания работника на дату: рейсы и действующие недельные листы. Пустой список — законное
 * состояние экрана, а не ошибка: заданий на день может не быть.
 *
 * Порядок тот же, каким день машины читает гараж: сначала рейсы, следом документ недели. Два экрана
 * не разойдутся, а водитель читает строку сверху вниз от того, куда сегодня ехать.
 *
 * Здесь же стоит условие Р5: рейс без действительного листа не входит в задание вовсе — ни карточкой
 * ввода, ни адресами. Кабинет строго документален, потому что показание некуда переносить, пока
 * бланка нет; цена решения — выехавший до выписки водитель не увидит адресов, и она названа в плане
 * прямо. Недельный ЭСМ-2 фильтра не проходит: он сам себе лист, и в задание входит по своему
 * периоду.
 */
export async function loadDayEntries(
  personId: string,
  date: string,
): Promise<DriverAssignmentEntry[]> {
  const [byDate, weekly] = await Promise.all([
    routeSources(personId, date, date),
    esm2Sources(personId, date),
  ]);
  const routes = byDate.get(date) ?? [];
  const documented = await documentedRoutes(
    routes.map((source) => source.entry.sourceId),
    personId,
  );
  const sources: EntrySource<DriverAssignmentEntry>[] = [
    ...routes
      .filter((source) => documented.has(source.entry.sourceId))
      .map((source) => ({ vehicleId: source.vehicleId, entry: cabinetEntry(source.entry) })),
    ...weekly,
  ];
  if (sources.length === 0) return [];

  const previous = await previousReadings(
    [...new Set(sources.map((source) => source.vehicleId))],
    date,
  );
  return sources.map(({ entry, vehicleId }) => ({
    ...entry,
    previous: previous.get(vehicleId) ?? null,
  }));
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
