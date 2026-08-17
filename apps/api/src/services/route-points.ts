import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  type AddressedLocation,
  type AddressMeta,
  addressKeyOf,
  brokenTripOrder,
  formatVehicleRequestNumber,
  MAX_ROUTE_POINTS,
  type PointIdentitySource,
  type PointRoleInput,
  pointContacts,
  requestCustomerName,
  type RoutePointAction,
  type RoutePointInput,
  routeCargoLabel,
  routeRequestCapacity,
  sameRouteAddress,
  samePointIdentity,
  type TaskRef,
  taskRefKey,
  type VehicleRoutePointDto,
  type WaybillFormCode,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  specialEquipmentRequestDetails,
  vehicleRequests,
  vehicleRequestTrips,
  vehicleRoutePoints,
  vehicleRoutePointTrips,
  vehicleRouteRequests,
} from '../db/schema';
import { err } from '../lib/errors';

/**
 * Точки маршрута — движение машины (план `docs/route-trips-plan.md`, этап 3).
 *
 * Состав рейса (`vehicle-routes.ts`) отвечает на «чью работу везём», а здесь — «куда и в каком
 * порядке машина заезжает». Разводятся эти две вещи потому, что совпадают они только у заявки с
 * одной поездкой: у заявки с ездками `A→B` и `A→C` «адрес разгрузки заявки» не существует, а две
 * строки задания, начинающиеся в `A`, — это один заезд, а не два (Р4, Р5).
 *
 * Файл держит ровно то, что знает о точках: их чтение в DTO, автосборку при укладке заявки (Р8),
 * правки порядка и состава ролей, порядок ролей **внутри** точки, чистку опустевших остановок
 * (Р13) и проверки, которые нельзя выразить в базе, — инвариант «погрузка раньше разгрузки» (Р6) и
 * ёмкость бланка строками задания (Р11).
 *
 * Порядков здесь два, и они про разное. Позиция **точки** — порядок объезда: куда машина едет
 * дальше. Позиция **роли** внутри точки (миграция 0146) — порядок работ на одной остановке: чью
 * ездку грузим первой. Второй заведён потому, что первого не хватает: две строки задания законно
 * стоят на одной и той же паре точек — автосборка переиспользовала точку (Р8), — и объезд их не
 * различает, а порядок строк задания это порядок талонов заказчиков (Р12, Р20), и решать его
 * номером записи в базе нельзя.
 *
 * Блокировок здесь нет намеренно: рейс берёт `FOR UPDATE` вызывающий (Р16, Р17) — он же знает,
 * один это рейс или два, — а сервис работает под уже взятой блокировкой. Обратный порядок означал
 * бы вторую точку, где решается порядок захвата, и первую же встречную правку в клинче.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающим функциям транзакция не нужна: карточку рейса спрашивают и вне её. */
type Reader = Tx | typeof db;

// ── Подписи ──

/**
 * «ТС-40/2» — номер заявки и номер ездки в ней. Собирает сервер, а не портал: подпись заявки
 * задана одной функцией на весь портал (`formatVehicleRequestNumber`), и вторая её склейка на
 * клиенте разошлась бы с бланком при первой же смене формата.
 */
export function tripDisplayNumber(requestNum: number, tripNum: number): string {
  return `${formatVehicleRequestNumber(requestNum)}/${tripNum}`;
}

/**
 * «ТС-77 · 12.08» — день линейного заказа. Год не печатается: рейс собирают на день, и год в
 * подписи строки задания только отнимал бы место, ничего не различая — все дни одного рейса
 * лежат в одном дне.
 */
export function linearDayDisplayNumber(requestNum: number, workDate: string): string {
  const [, month, day] = workDate.split('-');
  const label = month && day ? `${day}.${month}` : workDate;
  return `${formatVehicleRequestNumber(requestNum)} · ${label}`;
}

// ── Конец строки задания: адрес и ответственный ──

/**
 * Чем строка задания опознаёт свою точку (Р9, Р9б): адрес и тот, кто встречает.
 *
 * Одна структура на все три роли, и это не обобщение ради обобщения: правило «садись на точку того
 * же тождества» одно и то же у погрузки, разгрузки и линейного дня, а разница только в том, откуда
 * берутся значения — у ездки со своего конца, у дня из заявки спецтехники.
 */
interface TaskEndpoint extends AddressedLocation {
  contactName: string;
  contactPhone: string;
}

/** Тождество точки, которой обслуживается этот конец: адрес плюс ключ ответственного (Р9). */
function endpointIdentity(endpoint: TaskEndpoint): PointIdentitySource {
  return {
    location: endpoint.location,
    address: endpoint.address,
    contacts: [{ phone: endpoint.contactPhone }],
  };
}

/**
 * Адрес объекта так, как его печатает бланк линейного дня (ADR 0100 §10, `waybill-issue.ts`):
 * наименование и адрес через запятую.
 *
 * Склейка повторена, а не выведена: у дня в бланке «куда» это именно эта строка, и точка обязана
 * нести её же — иначе собранное задание разошлось бы с напечатанным, а `address_mismatch` (Р10)
 * загорался бы на ровном месте у каждого линейного дня.
 */
function objectLocation(row: { objectName: string | null; objectAddress: string | null }): string {
  return [row.objectName, row.objectAddress].filter(Boolean).join(', ');
}

/**
 * Адрес объекта метаданными справочника: `{ source: 'object', refId }` — тем же видом, каким его
 * записывает заявка, выбравшая адрес из справочника объектов (`assertDirectoryAddress`).
 *
 * Ради тождества (Р9): семантический ключ `ref:<uuid>` опознаёт объект раньше строки, и линейный
 * день садится на точку той же площадки, даже если ездка написала её адрес иначе. Без метаданных
 * тождество считалось бы по тексту «Наименование, адрес» — а его не совпасть ни с чем.
 */
function objectAddressMeta(objectId: string | null): AddressMeta | null {
  return objectId ? { source: 'object', refId: objectId } : null;
}

/**
 * Расхождение печатаемых адресов (Р9г): сравниваются нормализованные **строки**, а не
 * семантические ключи.
 *
 * У объекта справочника `ref:<uuid>` не меняется, когда правят текст адреса, — а печатается именно
 * текст, и взяв ключ, портал промолчал бы ровно в том случае, ради которого предупреждение и
 * заведено. Нормализация — та же, что у уровня `text:` (`addressKeyOf`): регистр, пробелы и «ё» —
 * оформление записи, а не её содержание.
 */
function samePrintedAddress(a: string, b: string): boolean {
  return (
    addressKeyOf({ location: a, address: null }) === addressKeyOf({ location: b, address: null })
  );
}

// ── Чтение точек ──

const pointColumns = {
  id: vehicleRoutePoints.id,
  position: vehicleRoutePoints.position,
  location: vehicleRoutePoints.location,
  address: vehicleRoutePoints.address,
  arrivalTime: vehicleRoutePoints.arrivalTime,
  comment: vehicleRoutePoints.comment,
};

/**
 * Точки рейса со всем, что нужно их ролям: строкой состава (день линейного заказа), ездкой,
 * заказчиком и контактами обоих видов.
 *
 * `leftJoin` на связку, а не `innerJoin`: точка без ролей не должна существовать (Р13), но если
 * она осталась после сбоя, карточка обязана её показать — иначе позиции в портале разойдутся с
 * позициями в базе, и человек не поймёт, откуда дыра в нумерации. Чистит такие `cleanupRoutePoints`.
 */
function selectPointRows(reader: Reader, routeId: string) {
  return (
    reader
      .select({
        ...pointColumns,
        role: vehicleRoutePointTrips.role,
        // Порядок роли на своей точке: им же различаются строки задания, стоящие на одной паре
        // точек (Р11, третий ключ сортировки), и упорядочены ответственные внутри вида роли (Р11а).
        rolePosition: vehicleRoutePointTrips.position,
        tripId: vehicleRoutePointTrips.tripId,
        requestId: vehicleRoutePointTrips.requestId,
        requestNum: vehicleRequests.num,
        // Заказчик — объектом затрат (Р25): решает идентификатор, а не заполненность имени, поэтому
        // из обеих пар выбираются и id, и код, и наименование.
        objectId: vehicleRequests.objectId,
        objectCode: constructionObjects.code,
        objectName: constructionObjects.name,
        objectAddress: constructionObjects.address,
        departmentId: vehicleRequests.departmentId,
        departmentCode: departments.code,
        departmentName: departments.name,
        // День строки состава: он же ключ линейной строки задания (`work_date`, ADR 0100).
        workDate: vehicleRouteRequests.workDate,
        tripNum: vehicleRequestTrips.num,
        tripDeletedAt: vehicleRequestTrips.deletedAt,
        tripFrom: vehicleRequestTrips.fromLocation,
        tripTo: vehicleRequestTrips.toLocation,
        volumeM3: vehicleRequestTrips.volumeM3,
        weightTons: vehicleRequestTrips.weightTons,
        fromResponsibleName: vehicleRequestTrips.fromResponsibleName,
        fromResponsiblePhone: vehicleRequestTrips.fromResponsiblePhone,
        toResponsibleName: vehicleRequestTrips.toResponsibleName,
        toResponsiblePhone: vehicleRequestTrips.toResponsiblePhone,
        // Ответственный заявки спецтехники — контакт роли `work` (Р9б): тот, кто встречает машину
        // на площадке. Живым значением, а не снимком (Р9в): печатать вчерашний телефон, потому что
        // «так было при сборке», — ровно та беда, от которой снимок должен защищать.
        siteResponsibleName: specialEquipmentRequestDetails.responsibleName,
        siteResponsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
      })
      .from(vehicleRoutePoints)
      .leftJoin(vehicleRoutePointTrips, eq(vehicleRoutePointTrips.pointId, vehicleRoutePoints.id))
      .leftJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRoutePointTrips.requestId))
      .leftJoin(vehicleRequestTrips, eq(vehicleRequestTrips.id, vehicleRoutePointTrips.tripId))
      // Строка состава той же пары «рейс + заявка»: она несёт день линейного заказа. Составной FK
      // связки (`route_point_trips_composition_fk`) гарантирует, что строка есть.
      .leftJoin(
        vehicleRouteRequests,
        and(
          eq(vehicleRouteRequests.routeId, vehicleRoutePointTrips.routeId),
          eq(vehicleRouteRequests.requestId, vehicleRoutePointTrips.requestId),
        ),
      )
      // Заказчик — объект или отдел (ADR 0040): innerJoin по объекту терял бы заявки отдела.
      .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
      .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
      .leftJoin(
        specialEquipmentRequestDetails,
        eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
      )
      .where(eq(vehicleRoutePoints.routeId, routeId))
      // Порядок выборки — порядок карточки и бумаги целиком: точки по объезду, роли внутри точки по
      // своей позиции. «Как вернул SQL» здесь не годится дважды: по ролям читают, что на остановке
      // делают первым, и по ним же различаются строки задания одной пары точек (Р11).
      .orderBy(asc(vehicleRoutePoints.position), asc(vehicleRoutePointTrips.position))
  );
}

type PointRow = Awaited<ReturnType<typeof selectPointRows>>[number];

/** План прибытия человеку: в базе `time` («08:30:00»), в карточке и бланке — «08:30». */
function arrivalTimeLabel(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}

/**
 * Что строка задания делает на этой точке. `null` — строки нет вовсе: ездка мягко удалена (Р13а)
 * либо роль осиротела от сбоя, и показывать её нельзя — она не печатается и не считается.
 */
function actionOf(
  row: PointRow,
  /** Позиции обоих концов каждой ездки: из них берётся `pairPosition`. */
  pairs: ReadonlyMap<string, { load: number | null; unload: number | null }>,
): RoutePointAction | null {
  if (row.requestId === null || row.requestNum === null) return null;
  const customerName = requestCustomerName({
    objectId: row.objectId,
    objectCode: row.objectCode,
    objectName: row.objectName,
    departmentId: row.departmentId,
    departmentCode: row.departmentCode,
    departmentName: row.departmentName,
  });

  if (row.role === 'work') {
    // Роль `work` у грузовой строки состава база принять способна (§5.3 плана), и такая строка
    // задания не существует: дня у неё нет, а `LinearTaskRef` без дня не собрать.
    if (!row.workDate) return null;
    return {
      kind: 'linear',
      ref: { kind: 'linear', requestId: row.requestId, workDate: row.workDate },
      role: 'work',
      displayNumber: linearDayDisplayNumber(row.requestNum, row.workDate),
      // Ноль недостижим: позиция NOT NULL, а `null` приходит только от `leftJoin` точки без ролей —
      // у неё и роли-то нет, и до сюда такая строка не доходит (`requestId` пуст).
      position: row.rolePosition ?? 0,
      requestNum: row.requestNum,
      // У линейного дня номера ездки нет вовсе — ноль здесь не «первая», а «ездок не бывает»
      // (Р11): им же он упорядочен среди строк задания.
      tripNum: 0,
      customerName,
      contactName: row.siteResponsibleName ?? '',
      contactPhone: row.siteResponsiblePhone ?? '',
      addressMismatch: !samePrintedAddress(row.location, objectLocation(row)),
    };
  }

  if (!row.tripId || row.tripNum === null || row.tripDeletedAt) return null;
  const isLoad = row.role === 'load';
  const pair = pairs.get(row.tripId);
  return {
    kind: 'freight',
    ref: { kind: 'freight', requestId: row.requestId, tripId: row.tripId },
    role: isLoad ? 'load' : 'unload',
    displayNumber: tripDisplayNumber(row.requestNum, row.tripNum),
    position: row.rolePosition ?? 0,
    requestNum: row.requestNum,
    tripNum: row.tripNum,
    customerName,
    contactName: (isLoad ? row.fromResponsibleName : row.toResponsibleName) ?? '',
    contactPhone: (isLoad ? row.fromResponsiblePhone : row.toResponsiblePhone) ?? '',
    addressMismatch: !samePrintedAddress(row.location, (isLoad ? row.tripFrom : row.tripTo) ?? ''),
    cargoLabel: routeCargoLabel(row.volumeM3, row.weightTons),
    // Ноль — «пары нет»: ездка разложена наполовину, и это не порядок, а другой отказ
    // (`rows_unplaced`). Позиций с нуля в маршруте не бывает (CHECK 1..20), поэтому значение
    // отличимо от настоящей позиции.
    pairPosition: (isLoad ? pair?.unload : pair?.load) ?? 0,
  };
}

/**
 * Точки маршрута в порядке объезда со всем, что на них происходит.
 *
 * Два прохода по одной выборке, а не два запроса: `pairPosition` роли — позиция второго конца её
 * ездки, и узнать её можно только обойдя маршрут целиком. Первый проход собирает пары, второй —
 * сами роли.
 */
export async function loadRoutePoints(
  reader: Reader,
  routeId: string,
): Promise<VehicleRoutePointDto[]> {
  const rows = await selectPointRows(reader, routeId);

  const pairs = new Map<string, { load: number | null; unload: number | null }>();
  for (const row of rows) {
    if (!row.tripId || row.tripDeletedAt) continue;
    const pair = pairs.get(row.tripId) ?? { load: null, unload: null };
    // Роль у ездки одна на конец (`route_point_trips_trip_role_unique`); если данные пришли
    // битыми, значима самая ранняя точка — тем же правилом считается инвариант Р6.
    if (row.role === 'load') pair.load ??= row.position;
    else if (row.role === 'unload') pair.unload ??= row.position;
    pairs.set(row.tripId, pair);
  }

  const points = new Map<string, VehicleRoutePointDto>();
  for (const row of rows) {
    const point = points.get(row.id) ?? {
      id: row.id,
      position: row.position,
      location: row.location,
      address: row.address ?? null,
      arrivalTime: arrivalTimeLabel(row.arrivalTime),
      comment: row.comment,
      actions: [],
      contacts: [],
    };
    const action = actionOf(row, pairs);
    if (action) point.actions.push(action);
    points.set(row.id, point);
  }

  return [...points.values()].map((point) => ({
    ...point,
    // Ответственные точки считаются из ролей, а не хранятся (§5.2): копия разошлась бы с заявкой
    // при первой же правке контакта (Р9в). Порядок задан правилом, а не выборкой (Р11а).
    contacts: pointContacts(point.actions),
  }));
}

// ── Строки задания состава ──

/**
 * Строки задания рейса (Р11): ездки живых заявок **плюс** дни линейных заказов.
 *
 * Ими считается ёмкость бланка, и считать вместо них строки состава нельзя: заявка с тремя
 * ездками занимает в бланке три строки, а в составе одну — у смешанного дня такой счёт не заметил
 * бы половину задания.
 *
 * Мягко удалённые ездки не в счёт (Р13а): они не печатаются и не раскладываются, а помнить, что
 * именно ушло в выданный лист, — дело журнала бланков.
 *
 * Порядок — состава, а внутри заявки по номеру ездки: в нём же вернутся неразложенные строки
 * (`rows_unplaced`), у которых своей позиции в маршруте нет.
 */
export async function routeTaskRefs(reader: Reader, routeId: string): Promise<TaskRef[]> {
  const rows = await reader
    .select({
      requestId: vehicleRouteRequests.requestId,
      workDate: vehicleRouteRequests.workDate,
      position: vehicleRouteRequests.position,
      tripId: vehicleRequestTrips.id,
      tripNum: vehicleRequestTrips.num,
    })
    .from(vehicleRouteRequests)
    // Ездки — только у грузовой строки: у линейного дня их не бывает вовсе (Р7), и join по дню
    // отдаёт NULL, а не чужие ездки соседней строки той же заявки.
    .leftJoin(
      vehicleRequestTrips,
      and(
        eq(vehicleRequestTrips.requestId, vehicleRouteRequests.requestId),
        isNull(vehicleRequestTrips.deletedAt),
        isNull(vehicleRouteRequests.workDate),
      ),
    )
    .where(eq(vehicleRouteRequests.routeId, routeId))
    .orderBy(asc(vehicleRouteRequests.position), asc(vehicleRequestTrips.num));

  const refs: TaskRef[] = [];
  for (const row of rows) {
    if (row.workDate)
      refs.push({ kind: 'linear', requestId: row.requestId, workDate: row.workDate });
    else if (row.tripId)
      refs.push({ kind: 'freight', requestId: row.requestId, tripId: row.tripId });
  }
  return refs;
}

/**
 * Ёмкость бланка (Р11, ADR 0068): строк задания в маршруте не больше, чем строк в бумаге.
 *
 * Спрашивается при всякой правке, добавляющей работу, — укладке заявки, постановке дня, правке
 * состава ездок, — потому что переполнение рождается не в точках, а в составе: точки лишь
 * показывают то, что уже заказано.
 */
export async function assertRouteCapacity(
  tx: Tx,
  routeId: string,
  formCode: WaybillFormCode | null,
): Promise<void> {
  const rows = (await routeTaskRefs(tx, routeId)).length;
  const capacity = routeRequestCapacity(formCode);
  if (rows <= capacity) return;
  throw err.unprocessable(
    `В бланке ${capacity} строк задания, а в маршруте их ${rows} — выньте заявку, снимите день или заведите второй маршрут`,
    { requestId: 'Не хватает строк задания' },
  );
}

/**
 * Инвариант Р6 — погрузка строго раньше разгрузки — и ёмкость бланка: обе проверки после всякой
 * правки порядка и состава.
 *
 * Сервером, а не базой: сравнение двух строк CHECK'ом не выражается, — и **после** правки, а не
 * до: порядок собирают перестановками, и промежуточное состояние «разгрузка выше погрузки»
 * законно ровно до конца транзакции.
 */
export async function assertRoutePlacement(
  tx: Tx,
  params: { routeId: string; formCode: WaybillFormCode | null },
): Promise<VehicleRoutePointDto[]> {
  await assertRouteCapacity(tx, params.routeId, params.formCode);
  const points = await loadRoutePoints(tx, params.routeId);
  const broken = brokenTripOrder(points);
  if (broken.length === 0) return points;

  // Ездка называется тем же номером, каким её видит человек в карточке: сообщение «ездка
  // 8f3c-… разгружается раньше» искать в маршруте нечем.
  const labels = new Map<string, string>();
  for (const point of points) {
    for (const action of point.actions) labels.set(taskRefKey(action.ref), action.displayNumber);
  }
  const names = broken.map((ref) => labels.get(taskRefKey(ref)) ?? '').filter(Boolean);
  throw err.unprocessable(
    `Разгрузка раньше погрузки: ${names.join(', ')} — переставьте точки так, чтобы груз сначала грузили`,
    { pointIds: 'Нарушен порядок ездки' },
  );
}

// ── Позиции ──

/**
 * Позиции пишутся одним запросом, поэтому их уникальность откладывается до конца транзакции: при
 * перестановке две точки на мгновение делят номер, и построчная проверка упала бы на первой же
 * строке. Ограничение объявлено `DEFERRABLE INITIALLY IMMEDIATE` (миграция 0136) — тем же приёмом,
 * что порядок строк состава (0072).
 */
async function deferPositions(tx: Tx): Promise<void> {
  await tx.execute(sql`SET CONSTRAINTS vehicle_route_points_position_unique DEFERRED`);
}

/**
 * То же самое для порядка ролей внутри точки (миграция 0146): уплотнение и перестановка переписывают
 * позиции одним запросом, и на середине такого запроса две роли делят номер.
 *
 * Отдельной функцией, а не одним `SET CONSTRAINTS` на оба ограничения: правки ролей и правки
 * объезда ходят разными дверьми, и откладывать чужое ограничение там, где его никто не трогает,
 * значит отложить проверку, которая как раз должна была сработать немедленно.
 */
async function deferRolePositions(tx: Tx): Promise<void> {
  await tx.execute(sql`SET CONSTRAINTS route_point_trips_position_unique DEFERRED`);
}

/**
 * Позиция новой роли на точке — следующая за последней.
 *
 * Подзапросом в самой вставке, а не отдельным чтением: между «спросить максимум» и «вставить» в
 * одной транзакции ничего не происходит, но два обращения к базе на каждую роль автосборки — это
 * лишний круг на каждую ездку, а порядок и без того задан: новая работа встаёт последней в очередь
 * этой остановки, ровно как новая точка встаёт последней в объезд.
 */
function nextRolePosition(pointId: string) {
  return sql<number>`(
    SELECT COALESCE(MAX(rp.position), 0) + 1
    FROM ${vehicleRoutePointTrips} rp
    WHERE rp.point_id = ${pointId}::uuid
  )`;
}

/**
 * Уплотняет порядок ролей в 1…N внутри каждой точки маршрута, сохраняя их нынешний порядок.
 *
 * Роль уходит с точки не только перестановкой — её уносят правка состава точки, разнесение, мягкое
 * удаление ездки и каскад изъятия заявки, — и дыра в порядке ничего бы не сломала сама по себе, но
 * позиции обязаны оставаться связными: на них смотрит человек («грузим первой, потом второй»), и
 * счёт с пропуском читается как потерянная работа. Тем же правилом уплотняются точки (Р13).
 *
 * Одним запросом на весь маршрут: ролей в нём не больше двадцати, а обходить точки по одной значило
 * бы двадцать запросов ради перестановки двух строк.
 */
async function compactRolePositions(tx: Tx, routeId: string): Promise<void> {
  await deferRolePositions(tx);
  await tx.execute(sql`
    UPDATE ${vehicleRoutePointTrips} AS t
    SET position = v.position
    FROM (
      SELECT id, row_number() OVER (PARTITION BY point_id ORDER BY position, id) AS position
      FROM ${vehicleRoutePointTrips}
      WHERE route_id = ${routeId}::uuid
    ) AS v
    WHERE t.id = v.id AND t.position <> v.position
  `);
}

/**
 * Переписывает позиции точек целиком — ровно тем порядком, который прислали.
 *
 * Одним `UPDATE … FROM (VALUES …)`, а не циклом по строкам: точек до двадцати, и двадцать запросов
 * туда-обратно ради одной перестановки — это двадцать шансов оставить порядок наполовину
 * переписанным, если соединение оборвётся посередине. Число обновлённых строк сверяется с длиной
 * списка: точка не из этого маршрута просто не найдётся, и это отказ, а не молчание.
 */
async function writePositions(tx: Tx, routeId: string, ordered: readonly string[]): Promise<void> {
  if (ordered.length === 0) return;
  await deferPositions(tx);
  const values = sql.join(
    ordered.map((id, index) => sql`(${id}::uuid, ${index + 1}::smallint)`),
    sql`, `,
  );
  const updated = await tx.execute(sql`
    UPDATE ${vehicleRoutePoints} AS p
    SET position = v.position
    FROM (VALUES ${values}) AS v(id, position)
    WHERE p.id = v.id AND p.route_id = ${routeId}::uuid
  `);
  if ((updated.rowCount ?? 0) !== ordered.length) {
    throw err.unprocessable('В присланном порядке есть точка не из этого маршрута');
  }
}

/** Точки маршрута по позициям — минимумом колонок: им считаются порядок и потолок. */
async function pointOrderOf(tx: Tx, routeId: string): Promise<{ id: string; position: number }[]> {
  return tx
    .select({ id: vehicleRoutePoints.id, position: vehicleRoutePoints.position })
    .from(vehicleRoutePoints)
    .where(eq(vehicleRoutePoints.routeId, routeId))
    .orderBy(asc(vehicleRoutePoints.position));
}

/**
 * Уплотняет позиции в 1…N. Точка выбывает из маршрута не только перестановкой — её снимает
 * изъятие заявки и совмещение, — и дыра в порядке объезда означала бы пропущенную остановку там,
 * где её нет.
 */
async function compactPositions(tx: Tx, routeId: string): Promise<void> {
  const rows = await pointOrderOf(tx, routeId);
  if (rows.every((row, index) => row.position === index + 1)) return;
  await writePositions(
    tx,
    routeId,
    rows.map((row) => row.id),
  );
}

/**
 * Точка без единой роли не заводится и не остаётся (Р13): считается **любая** роль, включая
 * одинокий `work` — точка с ним совершенно законна, это и есть день линейного заказа.
 *
 * Зовётся после всего, что способно снять роль: изъятия заявки из состава (каскадом по
 * `route_point_trips_composition_fk`), правки состава ролей, совмещения, разнесения, мягкого
 * удаления ездки. «Просто заехать» задания не несёт и в бланке не печатается.
 */
export async function cleanupRoutePoints(tx: Tx, routeId: string): Promise<void> {
  await tx.delete(vehicleRoutePoints).where(
    and(
      eq(vehicleRoutePoints.routeId, routeId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${vehicleRoutePointTrips}
        WHERE ${vehicleRoutePointTrips.pointId} = ${vehicleRoutePoints.id}
      )`,
    ),
  );
  await compactPositions(tx, routeId);
  // Точка, потерявшая одну роль из трёх, остаётся — а дыра в её порядке работ остаться не должна:
  // уплотнение стоит здесь по той же причине, по какой здесь стоит уплотнение объезда.
  await compactRolePositions(tx, routeId);
}

// ── Роли: сверка с составом ──

/** Ключ роли: им сверяются присланный список и то, что лежит на точках. */
function roleKey(role: { tripId: string | null; requestId: string; role: string }): string {
  return role.role === 'work' ? `linear:${role.requestId}` : `freight:${role.tripId}:${role.role}`;
}

/** Ключ присланной роли — тем же правилом, что и у сохранённой. */
function inputRoleKey(role: PointRoleInput): string {
  return role.kind === 'linear'
    ? `linear:${role.requestId}`
    : `freight:${role.tripId}:${role.role}`;
}

/** Строки задания маршрута по ключу ссылки: ими сверяется, что роль вообще существует. */
async function taskIndexOf(tx: Tx, routeId: string): Promise<Set<string>> {
  return new Set((await routeTaskRefs(tx, routeId)).map(taskRefKey));
}

/**
 * Роль называет строку задания **этого** маршрута — и ту, которой она бывает.
 *
 * База держит не всё: составные ключи ловят ездку чужой заявки и заявку вне состава, а вот
 * соответствие роли виду строки (`work` у грузовой заявки, `load` у линейного дня) третьему ключу
 * не видно — он смотрит только на пару «маршрут + заявка» (§5.3). Значит это правило серверное, и
 * стоит оно здесь, в единственной двери, через которую роли заводятся.
 */
function assertRoleKnown(index: Set<string>, role: PointRoleInput): void {
  const ref: TaskRef =
    role.kind === 'freight'
      ? { kind: 'freight', requestId: role.requestId, tripId: role.tripId }
      : { kind: 'linear', requestId: role.requestId, workDate: role.workDate };
  if (index.has(taskRefKey(ref))) return;
  throw err.unprocessable(
    role.kind === 'freight'
      ? 'Ездка не из этого маршрута: её заявка не стоит в составе либо ездка удалена'
      : 'День заказа не стоит в этом маршруте — сначала поставьте день в рейс',
    { roles: 'Строка задания не найдена' },
  );
}

/**
 * Кладёт роли на точку, снимая их с прежних мест **этого** маршрута.
 *
 * Перенос, а не отказ: у ездки ровно одна погрузка и одна разгрузка
 * (`route_point_trips_trip_role_unique`), и «назовите роль на другой точке» — это и есть способ
 * перенести её руками, без разнесения и совмещения. Оставь мы здесь вставку — человек получал бы
 * ошибку целостности вместо перестановки.
 *
 * В порядке работ новой точки роли встают последними и в том порядке, в каком названы: переезд —
 * это появление работы на остановке, а появившаяся работа встаёт в очередь последней. Дыру, которая
 * остаётся на прежней точке, закрывает уплотнение (`cleanupRoutePoints`).
 */
async function moveRolesTo(
  tx: Tx,
  routeId: string,
  pointId: string,
  roles: readonly PointRoleInput[],
): Promise<void> {
  for (const role of roles) {
    if (role.kind === 'freight') {
      await tx
        .delete(vehicleRoutePointTrips)
        .where(
          and(
            eq(vehicleRoutePointTrips.routeId, routeId),
            eq(vehicleRoutePointTrips.tripId, role.tripId),
            eq(vehicleRoutePointTrips.role, role.role),
          ),
        );
      await tx.insert(vehicleRoutePointTrips).values({
        pointId,
        routeId,
        requestId: role.requestId,
        tripId: role.tripId,
        role: role.role,
        position: nextRolePosition(pointId),
      });
      continue;
    }
    // День занимает ровно одну точку своего маршрута (`route_point_trips_linear_unique`), поэтому
    // прежняя роль снимается парой «маршрут + заявка», а день в связке не хранится вовсе.
    await tx
      .delete(vehicleRoutePointTrips)
      .where(
        and(
          eq(vehicleRoutePointTrips.routeId, routeId),
          eq(vehicleRoutePointTrips.requestId, role.requestId),
          eq(vehicleRoutePointTrips.role, 'work'),
        ),
      );
    await tx.insert(vehicleRoutePointTrips).values({
      pointId,
      routeId,
      requestId: role.requestId,
      tripId: null,
      role: 'work',
      position: nextRolePosition(pointId),
    });
  }
}

// ── Заведение точек ──

/** Точка в маршруте, какой её видит автосборка: тождество (Р9) плюс место в порядке объезда. */
interface PlacedPoint extends PointIdentitySource {
  id: string;
  position: number;
}

/** Потолок точек — CHECK позиции 1..20 (§5.2): две точки на строку задания и ни одной сверх. */
function assertPointRoom(count: number): void {
  if (count < MAX_ROUTE_POINTS) return;
  throw err.unprocessable(
    `В маршруте не больше ${MAX_ROUTE_POINTS} точек — совместите остановки одного адреса или выньте заявку`,
    { points: 'Точек больше некуда' },
  );
}

/** Заводит точку последней в порядке объезда и возвращает её глазами автосборки. */
async function appendPoint(
  tx: Tx,
  routeId: string,
  placed: PlacedPoint[],
  endpoint: TaskEndpoint,
): Promise<PlacedPoint> {
  assertPointRoom(placed.length);
  const position = placed.reduce((max, point) => Math.max(max, point.position), 0) + 1;
  const [created] = await tx
    .insert(vehicleRoutePoints)
    .values({
      routeId,
      position,
      location: endpoint.location,
      address: endpoint.address,
    })
    .returning({ id: vehicleRoutePoints.id });
  const point: PlacedPoint = {
    id: created!.id,
    position,
    location: endpoint.location,
    address: endpoint.address,
    contacts: [{ phone: endpoint.contactPhone }],
  };
  placed.push(point);
  return point;
}

/** Точки маршрута для автосборки: DTO и есть тождество — у него уже посчитаны ответственные. */
async function placedPointsOf(tx: Tx, routeId: string): Promise<PlacedPoint[]> {
  const points = await loadRoutePoints(tx, routeId);
  return points.map((point) => ({
    id: point.id,
    position: point.position,
    location: point.location,
    address: point.address,
    contacts: point.contacts,
  }));
}

// ── Автосборка (Р8) ──

/** Живые ездки заявки по порядку номеров: раскладываются они тем же порядком, каким заведены. */
async function liveTripsOf(tx: Tx, requestId: string) {
  return tx
    .select({
      id: vehicleRequestTrips.id,
      num: vehicleRequestTrips.num,
      fromLocation: vehicleRequestTrips.fromLocation,
      toLocation: vehicleRequestTrips.toLocation,
      fromAddress: vehicleRequestTrips.fromAddress,
      toAddress: vehicleRequestTrips.toAddress,
      fromResponsibleName: vehicleRequestTrips.fromResponsibleName,
      fromResponsiblePhone: vehicleRequestTrips.fromResponsiblePhone,
      toResponsibleName: vehicleRequestTrips.toResponsibleName,
      toResponsiblePhone: vehicleRequestTrips.toResponsiblePhone,
    })
    .from(vehicleRequestTrips)
    .where(and(eq(vehicleRequestTrips.requestId, requestId), isNull(vehicleRequestTrips.deletedAt)))
    .orderBy(asc(vehicleRequestTrips.num));
}

type TripRow = Awaited<ReturnType<typeof liveTripsOf>>[number];

/** Концы ездки: с них берутся адрес и ответственный погрузки и разгрузки. */
function tripEndpoint(trip: TripRow, role: 'load' | 'unload'): TaskEndpoint {
  return role === 'load'
    ? {
        location: trip.fromLocation,
        address: trip.fromAddress ?? null,
        contactName: trip.fromResponsibleName,
        contactPhone: trip.fromResponsiblePhone,
      }
    : {
        location: trip.toLocation,
        address: trip.toAddress ?? null,
        contactName: trip.toResponsibleName,
        contactPhone: trip.toResponsiblePhone,
      };
}

/** Какие роли этих ездок уже стоят в маршруте: по ним автосборка отличает новое от разложенного. */
async function placedRolesOf(tx: Tx, routeId: string, requestId: string): Promise<Set<string>> {
  const rows = await tx
    .select({
      tripId: vehicleRoutePointTrips.tripId,
      requestId: vehicleRoutePointTrips.requestId,
      role: vehicleRoutePointTrips.role,
    })
    .from(vehicleRoutePointTrips)
    .where(
      and(
        eq(vehicleRoutePointTrips.routeId, routeId),
        eq(vehicleRoutePointTrips.requestId, requestId),
      ),
    );
  return new Set(rows.map(roleKey));
}

/**
 * Раскладывает ездки заявки точками — тем самым алгоритмом, что выписан в плане (Р8).
 *
 * ```text
 * область поиска — ВЕСЬ маршрут, включая точки, собранные прежними заявками
 * для каждой ездки заявки по порядку:
 *   погрузка:  взять самую раннюю точку маршрута того же тождества (Р9);
 *              нет такой — завести новую в конец
 *   разгрузка: взять самую раннюю точку того же тождества ПОСЛЕ точки погрузки этой ездки;
 *              нет такой — завести новую в конец
 * ```
 *
 * «Склеивать подряд идущие» здесь не годится: у заявки с ездками `A→B` и `A→C` последовательное
 * добавление даёт `A B A C`, где две `A` не соседние. Повторное использование даёт `A B C` с одной
 * погрузкой — то самое «грузимся в A один раз для двух ездок», ради которого всё и затевалось.
 *
 * Область — весь маршрут, а не точки этой заявки: если в дне уже стоит «карьер Сычёво» с тем же
 * ответственным, новая заявка грузится на нём. Порядок уже собранного дня при этом не меняется —
 * к существующей точке лишь добавляется роль, а новые встают в конец.
 *
 * Инвариант Р6 цел по построению: разгрузка либо находится позже своей погрузки, либо заводится
 * последней. Тождество полное (адрес **и** набор ответственных): тот же адрес с другим прорабом —
 * другое место работы, и свести их вправе только человек (Р9а).
 */
export async function placeRequestTrips(tx: Tx, routeId: string, requestId: string): Promise<void> {
  const trips = await liveTripsOf(tx, requestId);
  if (trips.length === 0) return;
  const placed = await placedPointsOf(tx, routeId);
  const roles = await placedRolesOf(tx, routeId, requestId);

  for (const trip of trips) {
    /*
     * Ездка, у которой в маршруте есть хоть одна роль, автосборкой не трогается вовсе — ни целая,
     * ни разложенная наполовину. Целую перекладывать незачем, а половину нельзя: второй конец
     * ищется относительно первого, и «дособрав» ездку, у которой диспетчер снял погрузку руками,
     * автосборка переписала бы его сборку. Неполнота при этом не замалчивается — о ней говорит
     * отказ выписки (`rows_unplaced`).
     */
    if (roles.has(`freight:${trip.id}:load`) || roles.has(`freight:${trip.id}:unload`)) continue;

    const loadEnd = tripEndpoint(trip, 'load');
    const loadIdentity = endpointIdentity(loadEnd);
    const loadPoint =
      placed.find((point) => samePointIdentity(point, loadIdentity)) ??
      (await appendPoint(tx, routeId, placed, loadEnd));
    await tx.insert(vehicleRoutePointTrips).values({
      pointId: loadPoint.id,
      routeId,
      requestId,
      tripId: trip.id,
      role: 'load',
      // Ездки раскладываются по порядку номеров, и в очередь работ каждой точки они встают тем же
      // порядком: «сначала грузим первую ездку, потом вторую» — умолчание, которое диспетчер
      // переставит, если на карьере удобнее иначе.
      position: nextRolePosition(loadPoint.id),
    });

    const unloadEnd = tripEndpoint(trip, 'unload');
    const unloadIdentity = endpointIdentity(unloadEnd);
    const unloadPoint =
      placed.find(
        (point) => point.position > loadPoint.position && samePointIdentity(point, unloadIdentity),
      ) ?? (await appendPoint(tx, routeId, placed, unloadEnd));
    await tx.insert(vehicleRoutePointTrips).values({
      pointId: unloadPoint.id,
      routeId,
      requestId,
      tripId: trip.id,
      role: 'unload',
      position: nextRolePosition(unloadPoint.id),
    });
  }
}

/**
 * Ставит день линейного заказа точкой `work` — по тому же правилу переиспользования, что и ездки
 * (Р5а, Р9б).
 *
 * У дня нет «откуда — куда»: машина приезжает на объект и работает там, — поэтому он и есть одна
 * точка, встающая в общий порядок объезда. Адрес берётся у объекта заявки той же склейкой, какой
 * его печатает бланк (ADR 0100 §10), ответственный — контакт заявки спецтехники; тождество
 * считается одинаково с ездками, и день садится на уже существующую точку того же объекта с тем же
 * ответственным — машина заехала один раз.
 */
export async function placeLinearDay(
  tx: Tx,
  routeId: string,
  requestId: string,
  workDate: string,
): Promise<void> {
  const [row] = await tx
    .select({
      objectId: vehicleRequests.objectId,
      objectName: constructionObjects.name,
      objectAddress: constructionObjects.address,
      responsibleName: specialEquipmentRequestDetails.responsibleName,
      responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
      // День строки состава: им сверяется, что роль `work` заводится именно линейному дню. База
      // этого не держит — третий составной ключ смотрит только на пару «маршрут + заявка» (§5.3).
      compositionDay: vehicleRouteRequests.workDate,
    })
    .from(vehicleRequests)
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      vehicleRouteRequests,
      and(
        eq(vehicleRouteRequests.routeId, routeId),
        eq(vehicleRouteRequests.requestId, vehicleRequests.id),
      ),
    )
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  if (row.compositionDay !== workDate) {
    throw err.unprocessable(
      `День ${workDate} не стоит в этом маршруте строкой состава — сначала поставьте день в рейс`,
      { routeId: 'День не в составе рейса' },
    );
  }

  const location = objectLocation(row);
  if (location.trim() === '') {
    // Точка без адреса не заводится (CHECK `location_not_blank`), и подставлять сюда номер заявки
    // нельзя: по такому «адресу» водитель никуда не приедет. Заказ техники на объект без объекта —
    // испорченная запись, и человек должен узнать об этом здесь, а не у принтера.
    throw err.unprocessable(
      'У заявки не выбран объект — дню линейного заказа неоткуда взять адрес площадки',
      { routeId: 'Нет объекта заявки' },
    );
  }

  const day = await placedRolesOf(tx, routeId, requestId);
  if (day.has(`linear:${requestId}`)) return;

  const placed = await placedPointsOf(tx, routeId);
  const endpoint: TaskEndpoint = {
    location,
    address: objectAddressMeta(row.objectId),
    contactName: row.responsibleName ?? '',
    contactPhone: row.responsiblePhone ?? '',
  };
  const identity = endpointIdentity(endpoint);
  const point =
    placed.find((candidate) => samePointIdentity(candidate, identity)) ??
    (await appendPoint(tx, routeId, placed, endpoint));
  await tx.insert(vehicleRoutePointTrips).values({
    pointId: point.id,
    routeId,
    requestId,
    tripId: null,
    role: 'work',
    position: nextRolePosition(point.id),
  });
}

/**
 * Сводит раскладку с правленым составом ездок заявки (долг этапа 2, Р18).
 *
 * Правка заявки полным списком делает с ездками две вещи, и обе задевают собранный день: новая
 * ездка появляется **неразложенной** (её никто не клал в маршрут), а мягко удалённая (Р13а)
 * оставляет за собой строки `vehicle_route_point_trips` — каскада у мягкого удаления нет и быть не
 * может, `deleted_at` для базы обычная колонка.
 *
 * Поэтому: снять роли умерших ездок, разложить те живые, у которых ролей нет вовсе, и убрать
 * опустевшие точки. Ездку, разложенную наполовину, автосборка не трогает (`placeRequestTrips`).
 *
 * Зовётся под уже взятой блокировкой рейса (Р17): её берёт правка заявки — рейсы первыми, заявка
 * следом.
 */
export async function syncRequestTripPlacement(
  tx: Tx,
  routeId: string,
  requestId: string,
): Promise<void> {
  // Роли мягко удалённых ездок: `RESTRICT` в ключе связки не даст снести саму ездку, но связку
  // снять обязаны мы — иначе удалённая ездка осталась бы точкой в порядке объезда.
  await tx.delete(vehicleRoutePointTrips).where(
    and(
      eq(vehicleRoutePointTrips.routeId, routeId),
      eq(vehicleRoutePointTrips.requestId, requestId),
      sql`EXISTS (
        SELECT 1 FROM ${vehicleRequestTrips}
        WHERE ${vehicleRequestTrips.id} = ${vehicleRoutePointTrips.tripId}
          AND ${vehicleRequestTrips.deletedAt} IS NOT NULL
      )`,
    ),
  );
  await placeRequestTrips(tx, routeId, requestId);
  await cleanupRoutePoints(tx, routeId);
}

// ── Правки точек ──

/** Значения точки из тела запроса: пустое время — «план не задан», а не полночь. */
function pointValues(input: RoutePointInput) {
  return {
    location: input.location,
    address: input.address,
    arrivalTime: input.arrivalTime === '' ? null : input.arrivalTime,
    comment: input.comment,
  };
}

/** Точка этого маршрута под рукой; чужая — `notFound`, а не «нет ролей». */
async function requirePoint(
  tx: Tx,
  routeId: string,
  pointId: string,
): Promise<{ id: string; position: number; location: string; address: AddressMeta | null }> {
  const [row] = await tx
    .select({
      id: vehicleRoutePoints.id,
      position: vehicleRoutePoints.position,
      location: vehicleRoutePoints.location,
      address: vehicleRoutePoints.address,
    })
    .from(vehicleRoutePoints)
    .where(and(eq(vehicleRoutePoints.id, pointId), eq(vehicleRoutePoints.routeId, routeId)));
  if (!row) throw err.notFound('Точка не найдена в этом маршруте');
  return { ...row, address: row.address ?? null };
}

/**
 * Заводит точку с её ролями. Роли переезжают с прежних мест маршрута (`moveRolesTo`): «завести
 * точку и положить на неё погрузку» — обычный способ развести две ездки по разным заездам.
 */
export async function createRoutePoint(
  tx: Tx,
  routeId: string,
  input: RoutePointInput,
): Promise<string> {
  const index = await taskIndexOf(tx, routeId);
  for (const role of input.roles) assertRoleKnown(index, role);

  const existing = await pointOrderOf(tx, routeId);
  assertPointRoom(existing.length);
  const position = existing.reduce((max, row) => Math.max(max, row.position), 0) + 1;
  const [created] = await tx
    .insert(vehicleRoutePoints)
    .values({ routeId, position, ...pointValues(input) })
    .returning({ id: vehicleRoutePoints.id });

  await moveRolesTo(tx, routeId, created!.id, input.roles);
  // Точка, с которой ушла последняя роль, остаётся пустой — и не остаётся (Р13).
  await cleanupRoutePoints(tx, routeId);
  return created!.id;
}

/**
 * Правит адрес, время, комментарий и состав ролей **целиком**.
 *
 * Роли списком, а не по одной: состав точки человек видит в карточке одним блоком, и частичная
 * правка потребовала бы отдельного языка команд там, где хватает списка. Роль, названная здесь, но
 * лежащая на другой точке, переезжает сюда — это и есть ручной перенос погрузки.
 */
export async function updateRoutePoint(
  tx: Tx,
  routeId: string,
  pointId: string,
  input: RoutePointInput,
): Promise<void> {
  await requirePoint(tx, routeId, pointId);
  const index = await taskIndexOf(tx, routeId);
  for (const role of input.roles) assertRoleKnown(index, role);

  await tx
    .update(vehicleRoutePoints)
    .set(pointValues(input))
    .where(eq(vehicleRoutePoints.id, pointId));

  // Роли, которых в присланном списке не оказалось, с точки уходят: список — полный состав.
  const kept = new Set(input.roles.map(inputRoleKey));
  const current = await tx
    .select({
      id: vehicleRoutePointTrips.id,
      tripId: vehicleRoutePointTrips.tripId,
      requestId: vehicleRoutePointTrips.requestId,
      role: vehicleRoutePointTrips.role,
    })
    .from(vehicleRoutePointTrips)
    .where(eq(vehicleRoutePointTrips.pointId, pointId));
  const dropped = current.filter((row) => !kept.has(roleKey(row))).map((row) => row.id);
  if (dropped.length > 0) {
    await tx.delete(vehicleRoutePointTrips).where(inArray(vehicleRoutePointTrips.id, dropped));
  }
  const stays = new Set(current.map(roleKey));
  await moveRolesTo(
    tx,
    routeId,
    pointId,
    input.roles.filter((role) => !stays.has(inputRoleKey(role))),
  );
  await cleanupRoutePoints(tx, routeId);
}

/**
 * Убирает точку вместе с её ролями.
 *
 * Отказ ровно один: роль, которая у своей строки задания последняя (§7). Строка, потерявшая все
 * роли, из маршрута исчезает молча — а исчезнуть она вправе только вместе с заявкой или днём, у
 * которых свои двери и свои проверки. Ездку, разложенную половиной, точка увести за собой может:
 * это законное промежуточное состояние сборки, и о нём скажет отказ выписки (`rows_unplaced`).
 */
export async function deleteRoutePoint(tx: Tx, routeId: string, pointId: string): Promise<void> {
  await requirePoint(tx, routeId, pointId);
  const rows = await tx
    .select({
      pointId: vehicleRoutePointTrips.pointId,
      tripId: vehicleRoutePointTrips.tripId,
      requestId: vehicleRoutePointTrips.requestId,
      role: vehicleRoutePointTrips.role,
      requestNum: vehicleRequests.num,
      tripNum: vehicleRequestTrips.num,
      workDate: vehicleRouteRequests.workDate,
    })
    .from(vehicleRoutePointTrips)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRoutePointTrips.requestId))
    .leftJoin(vehicleRequestTrips, eq(vehicleRequestTrips.id, vehicleRoutePointTrips.tripId))
    .leftJoin(
      vehicleRouteRequests,
      and(
        eq(vehicleRouteRequests.routeId, vehicleRoutePointTrips.routeId),
        eq(vehicleRouteRequests.requestId, vehicleRoutePointTrips.requestId),
      ),
    )
    .where(eq(vehicleRoutePointTrips.routeId, routeId));

  const elsewhere = new Set(
    rows.filter((row) => row.pointId !== pointId).map((row) => taskRefKeyOfRow(row)),
  );
  const orphaned = rows.filter(
    (row) => row.pointId === pointId && !elsewhere.has(taskRefKeyOfRow(row)),
  );
  const linear = orphaned.some((row) => row.role === 'work');
  if (orphaned.length > 0) {
    const names = orphaned.map((row) =>
      row.role === 'work'
        ? linearDayDisplayNumber(row.requestNum, row.workDate ?? '')
        : tripDisplayNumber(row.requestNum, row.tripNum ?? 0),
    );
    throw err.unprocessable(
      `На точке последняя роль строки задания: ${names.join(', ')} — ${
        linear ? 'снимите день с рейса' : 'выньте заявку из маршрута'
      }, точка уйдёт вместе с ней`,
      { pointId: 'Последняя роль строки' },
    );
  }

  await tx.delete(vehicleRoutePoints).where(eq(vehicleRoutePoints.id, pointId));
  await compactPositions(tx, routeId);
}

/** Ключ строки задания у строки связки: тем же правилом, что `taskRefKey` у ссылки. */
function taskRefKeyOfRow(row: {
  tripId: string | null;
  requestId: string;
  workDate: string | null;
}): string {
  return row.tripId
    ? taskRefKey({ kind: 'freight', requestId: row.requestId, tripId: row.tripId })
    : taskRefKey({ kind: 'linear', requestId: row.requestId, workDate: row.workDate ?? '' });
}

/**
 * Новый порядок объезда — полным списком (Р14): сервер переписывает позиции целиком, и две
 * одновременные перестановки не соберут дыр в нумерации.
 *
 * Что список это ровно все точки маршрута, проверяется здесь: удалять и заводить точки
 * перестановкой нельзя, у того и другого своя дверь со своими правилами (Р13).
 */
/**
 * Переставляет точки вслед за порядком состава — мост между старой дверью и новой моделью.
 *
 * **Зачем он нужен.** До перехода на точки порядок печати задавала позиция строки состава, и
 * стрелки в карточке рейса переставляли именно её. Теперь задание печатается по позициям **точек**
 * (Р11, Р11б), а стрелки как переписывали состав, так и переписывают, — то есть перестали влиять
 * на документ. Молча: экран показывает новый порядок, а лист печатается в старом, и это касается
 * даже старых одноездочных заявок, у которых ничего не менялось. Пока карточка не переведена на
 * точки целиком (этап 7 плана), дверь обязана делать то, что обещает.
 *
 * **Когда порядок точек выводится из порядка состава, а когда нет.** Однозначно — пока каждая
 * точка принадлежит ровно одной заявке: тогда точки просто раскладываются группами в порядке
 * заявок, а внутри группы сохраняют свой прежний порядок (погрузка раньше разгрузки, Р6, — она и
 * так стоит раньше). Как только автосборка посадила на одну остановку ездки **разных** заявок
 * (Р8: «в двух заявках одно и то же место погрузки, ехать дважды незачем»), ответа не существует:
 * общая точка не может стоять одновременно и там, где велит первая заявка, и там, где вторая.
 *
 * Догадываться в этом случае нельзя — угадав, мы переставим машине маршрут не тем порядком, каким
 * просил человек, и он об этом не узнает. Поэтому возвращается `null`, а ручка отвечает словами и
 * указывает на дверь порядка объезда, где тот же вопрос задаётся точками и имеет ответ.
 */
export async function pointOrderByComposition(
  tx: Tx,
  routeId: string,
  requestIds: readonly string[],
): Promise<string[] | null> {
  const points = await loadRoutePoints(tx, routeId);
  const rank = new Map(requestIds.map((id, index) => [id, index]));

  const groups: { pointId: string; position: number; requestRank: number }[] = [];
  for (const point of points) {
    const owners = new Set(point.actions.map((action) => action.ref.requestId));
    // Точка без ролей не заводится и не остаётся (Р13); если такая всё же есть — данные битые, и
    // переставлять их вслепую хуже, чем отказать.
    if (owners.size !== 1) return null;
    const [owner] = owners;
    const requestRank = rank.get(owner!);
    if (requestRank === undefined) return null;
    groups.push({ pointId: point.id, position: point.position, requestRank });
  }

  return groups
    .sort((a, b) => a.requestRank - b.requestRank || a.position - b.position)
    .map((row) => row.pointId);
}

export async function setRoutePointOrder(
  tx: Tx,
  routeId: string,
  pointIds: readonly string[],
): Promise<void> {
  const current = await pointOrderOf(tx, routeId);
  const sent = new Set(pointIds);
  if (current.length !== pointIds.length || current.some((row) => !sent.has(row.id))) {
    throw err.unprocessable(
      'Порядок присылается полным списком точек маршрута — обновите его и попробуйте снова',
      { pointIds: 'Не все точки маршрута' },
    );
  }
  await writePositions(tx, routeId, pointIds);
}

/**
 * Совмещает точки в одну остановку (Р9а): роли переезжают в **первую по позиции**.
 *
 * Цель не спрашивается телом: «первая по позиции» — свойство маршрута, а не выбор клиента, и
 * разойтись эти два ответа не должны. Адрес обязан совпасть (`sameRouteAddress`): машина не может
 * приехать в два места сразу. Разные ответственные совмещению не помеха — точка выйдет с обоими, и
 * бланк напечатает обоих (Р11а): машина действительно приезжает в одно место, а встречают её двое.
 */
export async function mergeRoutePoints(
  tx: Tx,
  routeId: string,
  pointIds: readonly string[],
): Promise<string> {
  const rows = await tx
    .select({
      id: vehicleRoutePoints.id,
      position: vehicleRoutePoints.position,
      location: vehicleRoutePoints.location,
      address: vehicleRoutePoints.address,
    })
    .from(vehicleRoutePoints)
    .where(
      and(eq(vehicleRoutePoints.routeId, routeId), inArray(vehicleRoutePoints.id, [...pointIds])),
    )
    .orderBy(asc(vehicleRoutePoints.position));
  if (rows.length !== new Set(pointIds).size) {
    throw err.notFound('Одна из точек не найдена в этом маршруте');
  }

  const target = rows[0]!;
  const others = rows.slice(1);
  const differs = others.find(
    (row) =>
      !sameRouteAddress(
        { location: row.location, address: row.address ?? null },
        { location: target.location, address: target.address ?? null },
      ),
  );
  if (differs) {
    throw err.unprocessable(
      `Совмещаются точки одного адреса: «${target.location}» и «${differs.location}» — это разные места`,
      { pointIds: 'Разные адреса' },
    );
  }

  /*
   * Роли переезжают вместе со своим порядком работ: сначала те, что уже стояли на цели, затем —
   * группами в порядке объезда, из которого их сняли. Иначе порядок пришлось бы выдумывать: у
   * совмещаемых точек позиции начинаются с единицы у каждой, и «оставить как есть» означало бы две
   * первых роли на одной остановке — состояние, которого уникальность не допускает вовсе.
   *
   * Одним запросом, а не переносом с последующим уплотнением: уплотнение упорядочивает по самим
   * позициям и переплело бы роли разных точек между собой (первая с первой, вторая со второй),
   * потеряв ровно то, что человек на этих точках выстроил.
   */
  const merged = [target, ...others].map((row) => row.id);
  await deferRolePositions(tx);
  await tx.execute(sql`
    UPDATE ${vehicleRoutePointTrips} AS t
    SET point_id = ${target.id}::uuid, position = v.position
    FROM (
      SELECT rp.id, row_number() OVER (ORDER BY p.position, rp.position, rp.id) AS position
      FROM ${vehicleRoutePointTrips} rp
      JOIN ${vehicleRoutePoints} p ON p.id = rp.point_id
      WHERE rp.point_id IN (${sql.join(
        merged.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    ) AS v
    WHERE t.id = v.id
  `);
  await tx.delete(vehicleRoutePoints).where(
    inArray(
      vehicleRoutePoints.id,
      others.map((row) => row.id),
    ),
  );
  await compactPositions(tx, routeId);
  return target.id;
}

/**
 * Разносит точку надвое (Р9а): названные роли уходят в новую точку **сразу за** исходной.
 *
 * Сразу за, а не в конец: разносят один заезд на два подряд («этих грузим на первом корпусе, тех
 * на третьем»), и отправив вторую половину в конец дня, портал переписал бы маршрут за человека.
 * Адрес новая точка берёт у исходной — разносят не место, а работу; время и комментарий у неё свои
 * и пустые: они описывают заезд, а заездов теперь два.
 *
 * Исходная точка не должна опустеть (Р13) — её полный состав знает только сервер, поэтому
 * проверяет он.
 */
export async function splitRoutePoint(
  tx: Tx,
  routeId: string,
  pointId: string,
  roles: readonly PointRoleInput[],
): Promise<string> {
  const source = await requirePoint(tx, routeId, pointId);
  const current = await tx
    .select({
      tripId: vehicleRoutePointTrips.tripId,
      requestId: vehicleRoutePointTrips.requestId,
      role: vehicleRoutePointTrips.role,
    })
    .from(vehicleRoutePointTrips)
    .where(eq(vehicleRoutePointTrips.pointId, pointId));
  const here = new Set(current.map(roleKey));
  const moving = roles.map(inputRoleKey);
  const alien = moving.find((key) => !here.has(key));
  if (alien) throw err.unprocessable('Эта роль стоит не на разносимой точке — обновите карточку');
  if (moving.length >= current.length) {
    throw err.unprocessable(
      'В новую точку уходит весь состав исходной — тогда это не разнесение, а правка адреса',
      { roles: 'Исходная точка опустеет' },
    );
  }

  const existing = await pointOrderOf(tx, routeId);
  assertPointRoom(existing.length);
  // Место освобождается сдвигом хвоста: новая точка встаёт сразу за исходной, а не в конец, и
  // позиции за ней уезжают на единицу. Уникальность отложена — иначе сдвиг упал бы на первой строке.
  await deferPositions(tx);
  await tx
    .update(vehicleRoutePoints)
    .set({ position: sql`${vehicleRoutePoints.position} + 1` })
    .where(
      and(
        eq(vehicleRoutePoints.routeId, routeId),
        gt(vehicleRoutePoints.position, source.position),
      ),
    );
  const [created] = await tx
    .insert(vehicleRoutePoints)
    .values({
      routeId,
      position: source.position + 1,
      location: source.location,
      address: source.address,
    })
    .returning({ id: vehicleRoutePoints.id });

  await moveRolesTo(tx, routeId, created!.id, roles);
  // Ушедшие роли оставили в порядке работ исходной точки дыры: 1, 3, 5 читалось бы как «две работы
  // потерялись». Новая точка получает 1..N сама — роли легли на неё в присланном порядке.
  await compactRolePositions(tx, routeId);
  return created!.id;
}

/**
 * Новый порядок работ **внутри одной точки** — полным списком её ролей.
 *
 * Зачем эта дверь. Порядок строк задания — порядок талонов заказчиков (Р12, Р20), и задаёт его
 * объезд; но две строки, стоящие на одной и той же паре точек, объезд не различает (Р8
 * переиспользует точку), и прежде их разводил номер заявки — то есть никто. Здесь тот же вопрос
 * задаётся человеку в осмысленном виде: какую из ездок на этой остановке грузят первой.
 *
 * Полным списком, а не парой «поднять роль»: тем же приёмом переставляются точки (Р14) и строки
 * состава — сервер переписывает позиции целиком, и две одновременные перестановки не соберут дыр в
 * нумерации. Что список — это ровно роли этой точки, проверяется здесь: заводить и снимать роли
 * перестановкой нельзя, у того и другого свои двери со своими правилами.
 */
export async function setPointRoleOrder(
  tx: Tx,
  routeId: string,
  pointId: string,
  roles: readonly PointRoleInput[],
): Promise<void> {
  await requirePoint(tx, routeId, pointId);
  const current = await tx
    .select({
      id: vehicleRoutePointTrips.id,
      tripId: vehicleRoutePointTrips.tripId,
      requestId: vehicleRoutePointTrips.requestId,
      role: vehicleRoutePointTrips.role,
    })
    .from(vehicleRoutePointTrips)
    .where(eq(vehicleRoutePointTrips.pointId, pointId));

  const idByKey = new Map(current.map((row) => [roleKey(row), row.id]));
  const ordered = roles.map((role) => idByKey.get(inputRoleKey(role)));
  if (ordered.length !== current.length || ordered.some((id) => id === undefined)) {
    throw err.unprocessable(
      'Порядок присылается полным списком ролей точки — обновите карточку и попробуйте снова',
      { roles: 'Не все роли точки' },
    );
  }

  // Позиции переписываются целиком одним запросом — тем же приёмом, что и позиции точек
  // (`writePositions`): по строке за раз это столько же шансов оставить порядок наполовину
  // переписанным, сколько ролей на остановке.
  await deferRolePositions(tx);
  const values = sql.join(
    ordered.map((id, index) => sql`(${id!}::uuid, ${index + 1}::smallint)`),
    sql`, `,
  );
  await tx.execute(sql`
    UPDATE ${vehicleRoutePointTrips} AS t
    SET position = v.position
    FROM (VALUES ${values}) AS v(id, position)
    WHERE t.id = v.id
  `);
}
