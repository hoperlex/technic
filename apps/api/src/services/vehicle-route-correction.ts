import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  canIssueWaybill,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  type RequestStatus,
  type RoutePurpose,
  type VehicleRequestType,
  type VehicleStatus,
  type WaybillFormCode,
  type WaybillStatus,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  users,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleRequestShifts,
  vehicleRouteRequests,
  vehicles,
  vehicleTypes,
  waybills,
} from '../db/schema';
import { err } from '../lib/errors';
import { selectDrivers } from './drivers';
import { issueWaybillForRoute, routeWaybillFormFor } from './waybill-issue';
import { type RouteRow, routeWaybill, vehicleClassOf } from './vehicle-routes';
import { cancelWaybillForCorrection } from './waybill-correction';
import { requestIdsOfRouteWaybills } from './waybill-locks';

/**
 * Коррекция рейса задним числом (ADR 0101 п. 2, Р2) — то, что она делает с данными.
 *
 * Общее с прочими входами заднего числа — право, причина, идемпотентность, запись операции —
 * живёт в `waybill-correction.ts` и здесь не повторяется. Здесь работа с самим рейсом: чтение
 * состава под блокировками, проверка будущего состояния до первого аннулирования (Р36),
 * переписывание назначений, снятие подписей смен и пометка нового листа.
 *
 * Отдельным файлом, а не внутри маршрута, по двум причинам. Во-первых, то же самое нужно переносу
 * заявки между рейсами (Р30): у него два рейса, два номера и одна операция, но каждый шаг тот же —
 * и вторая копия шагов разошлась бы с первой на первой же правке. Во-вторых, порядок здесь и есть
 * предмет: сперва все проверки, и только потом первое изменение. Разбросанный по обработчику, он
 * читается как последовательность строк, а не как правило.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающим функциям транзакция не нужна: окно коррекции спрашивает их до всякой правки. */
type Reader = Tx | typeof db;

/**
 * Строка состава глазами коррекции: талон, его заявка и то, чем эта заявка взята в работу.
 *
 * `workDate` здесь не украшение, а развилка (ADR 0100 §2): `null` — грузоперевозка, и назначение
 * заявки коррекция переписывает; заполнен — день линейного заказа, и назначение остаётся прежним
 * (см. `planReassignment`).
 */
export interface RouteCompositionRow {
  requestId: string;
  /** «ТС-123» — им называются и отказы, и последствия в окне. */
  displayNumber: string;
  position: number;
  workDate: string | null;
  status: RequestStatus;
  requestType: VehicleRequestType;
  /** Вид заказанного типа — граница замены машины (ADR 0059). */
  orderedKindId: string;
  orderedTypeName: string;
  /** Чем заявка взята в работу; `null` — назначения нет вовсе (в рейсе такого не бывает). */
  assignedVehicleId: string | null;
}

const compositionColumns = {
  requestId: vehicleRouteRequests.requestId,
  position: vehicleRouteRequests.position,
  workDate: vehicleRouteRequests.workDate,
  num: vehicleRequests.num,
  status: vehicleRequests.status,
  requestType: vehicleRequests.requestType,
  orderedKindId: vehicleTypes.kindId,
  orderedTypeName: vehicleTypes.name,
  assignedVehicleId: vehicleRequestAssignments.vehicleId,
};

function toCompositionRow(row: {
  requestId: string;
  position: number;
  workDate: string | null;
  num: number;
  status: RequestStatus;
  requestType: VehicleRequestType;
  orderedKindId: string;
  orderedTypeName: string;
  assignedVehicleId: string | null;
}): RouteCompositionRow {
  return {
    requestId: row.requestId,
    displayNumber: formatVehicleRequestNumber(row.num),
    position: row.position,
    workDate: row.workDate,
    status: row.status,
    requestType: row.requestType,
    orderedKindId: row.orderedKindId,
    orderedTypeName: row.orderedTypeName,
    assignedVehicleId: row.assignedVehicleId,
  };
}

/**
 * Состав рейса в порядке талонов — без блокировок: им окно коррекции показывает последствия до
 * нажатия. Правке этого мало (Р24), и для неё есть `lockRouteComposition`.
 */
export async function loadRouteComposition(
  reader: Reader,
  routeId: string,
): Promise<RouteCompositionRow[]> {
  const rows = await reader
    .select(compositionColumns)
    .from(vehicleRouteRequests)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRouteRequests.routeId, routeId))
    .orderBy(asc(vehicleRouteRequests.position));
  return rows.map(toCompositionRow);
}

/**
 * Тот же состав, но под блокировками строк заявок (Р24).
 *
 * Одной версии рейса недостаточно: она не защищает от параллельного закрытия или переназначения
 * заявки — состав лежит в одной таблице, а статусы и назначения в других, и без `FOR UPDATE`
 * соседний запрос успевает закрыть заявку между проверкой состава и выпиской нового листа.
 *
 * Тем же проходом берутся заявки листов рейса (Р11): коррекция кончается аннулированием
 * действующего номера и выпиской нового, а сверка ЭСМ-2 соседней транзакции уже могла пообещать
 * человеку набор листов по этим заявкам. Состава для этого мало — заявку, ушедшую из рейса
 * переносом, действующий лист всё ещё называет в задании, и перечитает сверка именно его.
 *
 * Порядок блокировок фиксирован и одинаков у всех операций модуля: сначала рейсы (`lockRoute`,
 * `lockRoutePair`), затем заявки по возрастанию `id` — **все разом**. Вторым вызовом
 * (`lockRequestsOfWaybill` вслед за составом) заявки листов брать нельзя: два отсортированных
 * запроса подряд дают не общий порядок, а два своих. Позиция талона порядком блокировок быть не
 * может по той же причине: у переноса (Р30) заявки приходят из двух рейсов, и две встречные
 * коррекции, взявшие их «каждая в своём порядке талонов», встали бы в клинч.
 *
 * Возвращается состав в порядке талонов — читать его в порядке блокировок незачем, а собирать
 * задание листа приходится строками бланка.
 */
export async function lockRouteComposition(
  tx: Tx,
  routeId: string,
): Promise<RouteCompositionRow[]> {
  const planned = await loadRouteComposition(tx, routeId);
  const sheets = await requestIdsOfRouteWaybills(tx, [routeId]);
  // Состав пуст, а лист у рейса есть: коррекция опустевшего рейса списывает его номер, и заявки
  // того листа блокировать всё равно надо.
  if (planned.length === 0 && sheets.length === 0) return planned;
  const locked = await lockRequestRows(tx, [...planned.map((row) => row.requestId), ...sheets]);
  /*
   * Статус перечитывается уже под блокировкой: между первым чтением состава и `FOR UPDATE` заявку
   * успевают закрыть, и решать «весь ли состав в работе» (Р3) по добытому до блокировки значению
   * означало бы проверять прошлое.
   */
  return planned.map((row) => ({ ...row, status: locked.get(row.requestId) ?? row.status }));
}

/**
 * Заблокировать строки заявок по возрастанию `id` и вернуть их свежие статусы.
 *
 * Отдельной функцией ради переноса между рейсами (Р30): там заявки двух рейсов обязаны браться
 * одним проходом по общему порядку, а не двумя вызовами по рейсу — иначе порядок блокировок задаёт
 * не `id`, а то, какой рейс назвали приёмником.
 */
export async function lockRequestRows(
  tx: Tx,
  requestIds: readonly string[],
): Promise<Map<string, RequestStatus>> {
  const ids = [...new Set(requestIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: vehicleRequests.id, status: vehicleRequests.status })
    .from(vehicleRequests)
    .where(inArray(vehicleRequests.id, ids))
    .orderBy(asc(vehicleRequests.id))
    .for('update');
  return new Map(rows.map((row) => [row.id, row.status]));
}

/**
 * Составы обоих рейсов переноса — под блокировками и одним проходом по заявкам (Р24, Р30).
 *
 * Двух вызовов `lockRouteComposition` здесь мало, и дело не в числе запросов: тот берёт строки в
 * порядке `id` **внутри своего рейса**, а два вызова подряд дают порядок «сначала заявки приёмника,
 * потом источника» — то есть порядок блокировок задаёт не `id`, а то, какой рейс назвали
 * приёмником. Две встречные команды (перенести ТС-1 из Р-7 в Р-9 и ТС-2 из Р-9 в Р-7) взяли бы
 * строки в противоположных порядках и встали в клинч. Общий проход по объединённому списку
 * возвращает единственный порядок, одинаковый для обеих сторон.
 *
 * Заявки листов обоих рейсов (Р11) идут этим же списком и по той же причине: перенос списывает оба
 * действующих номера, а отдельным проходом они снова легли бы в свой порядок.
 *
 * Рейсы к этому моменту уже заблокированы (`lockRoutePair`): порядок «сначала рейсы, потом заявки»
 * один на весь модуль.
 */
export async function lockCompositionPair(
  tx: Tx,
  targetId: string,
  sourceId: string,
): Promise<{ target: RouteCompositionRow[]; source: RouteCompositionRow[] }> {
  const target = await loadRouteComposition(tx, targetId);
  const source = await loadRouteComposition(tx, sourceId);
  const sheets = await requestIdsOfRouteWaybills(tx, [targetId, sourceId]);
  const locked = await lockRequestRows(tx, [
    ...[...target, ...source].map((row) => row.requestId),
    ...sheets,
  ]);
  // Статусы перечитываются уже под блокировкой: между чтением состава и `FOR UPDATE` заявку
  // успевают закрыть, и решать «весь ли состав в работе» (Р3) по добытому раньше значению означало
  // бы проверять прошлое.
  const fresh = (rows: RouteCompositionRow[]): RouteCompositionRow[] =>
    rows.map((row) => ({ ...row, status: locked.get(row.requestId) ?? row.status }));
  return { target: fresh(target), source: fresh(source) };
}

/** Будущее состояние рейса: то, каким он станет, если коррекцию выполнить (Р36). */
export interface ProspectiveRoute {
  purpose: RoutePurpose;
  vehicleId: string;
  routeDate: string;
  driverPersonId: string | null;
  withTrailer: boolean;
  /** Заявка-основание перегона; у грузового рейса `null` — его основание это состав. */
  sourceRequest: { displayNumber: string; status: RequestStatus } | null;
  /** Действующий лист рейса: коррекция аннулирует его этой же транзакцией. */
  waybillStatus: WaybillStatus | null;
  /** Право `waybills.issueBlank` у субъекта (ADR 0071): рейс без заявок бывает и законным. */
  blankAllowed: boolean;
}

/**
 * Проверки будущего состояния — до первого аннулирования (Р36, ADR 0101 п. 11).
 *
 * Смена машины меняет больше, чем строку в шапке: у нового типа бывает другой бланк (4-П против
 * формы № 3, а с ним ёмкость семь против десяти — ADR 0068), другая организация-владелец и другие
 * требования к водителю (категория, прицеп — ADR 0037 п. 7 и 8). Узнать об этом после того, как
 * действующий номер уже списан, — худший из возможных порядков: номер, положим, не сгорит (счётчик
 * серии живёт строкой и откатывается с транзакцией), но человек получит поздний и невнятный отказ
 * вместо названной причины.
 *
 * Проверки те же самые, что у обычной выписки, и это главное здесь: коррекция кончается настоящим
 * листом, и второй набор правил для него разошёлся бы с первым. Снимается ровно одна — «по
 * маршруту уже есть действующий лист» (`correction: { allowed: true }`): его и аннулируют.
 *
 * Возвращает бланк будущего листа: им же считается вместимость задания, и считать её потом заново
 * значило бы задать тот же вопрос дважды.
 */
export async function preflightCorrection(
  tx: Tx,
  route: ProspectiveRoute,
  composition: readonly RouteCompositionRow[],
): Promise<{ formCode: WaybillFormCode }> {
  const requirement = await routeWaybillFormFor(tx, {
    purpose: route.purpose,
    vehicleId: route.vehicleId,
  });
  if (!requirement.formCode) {
    throw err.unprocessable(requirement.reason ?? 'На эту машину путевой лист не выписывается', {
      vehicleId: 'Бланк не выписывается',
    });
  }

  const check = canIssueWaybill({
    purpose: route.purpose,
    driverPersonId: route.driverPersonId,
    correction: { allowed: true },
    blankAllowed: route.blankAllowed,
    formCode: requirement.formCode,
    requests: composition,
    sourceRequest: route.sourceRequest,
    waybillStatus: route.waybillStatus,
  });
  if (!check.ok) {
    throw err.unprocessable(
      check.blocking.length > 0 ? `${check.reason}: ${check.blocking.join(', ')}` : check.reason,
    );
  }

  /*
   * Водитель — тем же отбором, каким его выпишет лист (`selectDrivers` внутри
   * `issueWaybillForRoute`). Спрашивается он и здесь, потому что там спрашивается уже после
   * аннулирования: отбор исторический (ADR 0101 п. 15), и человек, годный на сегодня, на день
   * рейса мог ещё не работать в компании.
   */
  if (route.driverPersonId) {
    const selection = await selectDrivers({
      vehicleId: route.vehicleId,
      on: route.routeDate,
      withTrailer: route.withTrailer,
      personId: route.driverPersonId,
    });
    if (!selection || selection.drivers.length === 0) {
      throw err.unprocessable(
        `На ${route.routeDate} этот человек в справочнике водителей не числится: запись удалена, либо специализация и трудовое отношение в этот день не действовали. Выберите того, кто работал в день рейса.`,
        { driverPersonId: 'Водитель не найден на дату рейса' },
      );
    }
  }

  return { formCode: requirement.formCode };
}

/** Что стало с назначением заявки: им окно и журнал объясняют, чем заявка поехала на самом деле. */
export interface ReassignedRequest {
  requestId: string;
  displayNumber: string;
  vehicleId: { before: string | null; after: string };
}

/** Что коррекция сделает с назначениями: посчитано до первого аннулирования, применяется после. */
export interface ReassignmentPlan {
  vehicle: { id: string; vehicleTypeId: string; typeName: string };
  moving: readonly RouteCompositionRow[];
}

/**
 * Кому из состава коррекция перепишет назначение — и можно ли вообще (Р2, Р36).
 *
 * Рейс — источник истины о том, чем едут (ADR 0052 п. 4), и в прошедшем дне это буквально так:
 * машина была одна на все талоны. Ставки не трогаются — о них договариваются по заявке (ADR 0052
 * п. 4), — а заказанный тип не трогается никогда (ADR 0059): он говорит, что просили, а не чем
 * закрыли.
 *
 * **Линейный день назначения не меняет** (ADR 0100 п. 4), и это не пропуск, а его устройство.
 * `vehicle_request_assignments` у заказа на объект отвечает «чем и почём взяли заявку в работу» —
 * ставки, арендодатель, принадлежность, — и по нему считаются закрытие и область видимости. Машина
 * **конкретного дня** — это машина рейса этого дня, и она сменилась вместе с рейсом сама: строка
 * состава ссылается на рейс, а не на назначение. Переписав здесь назначение, коррекция одного дня
 * переставила бы машину у всего заказа — у недель ЭСМ-2 (ADR 0100 п. 7), у прочих дней и у расчёта
 * закрытия, — то есть исправила бы один день ценой порчи остальных. Смена машины у самого заказа —
 * другой вход, со своей разблокировкой листов (Р8, Р11).
 *
 * Вид машины сверяется (ADR 0059): заявку закрывают и единицей соседнего типа, но не другого вида —
 * «заказывали самосвал, поехал автобус» это не замена, а другая работа. Проверка стоит в плане, а
 * не в применении, потому что отказать ею надо до того, как списан действующий номер (Р36).
 */
export async function planReassignment(
  reader: Reader,
  composition: readonly RouteCompositionRow[],
  vehicleId: string,
): Promise<ReassignmentPlan> {
  const vehicle = await vehicleClassOf(reader, vehicleId);
  if (!vehicle) throw err.unprocessable('У маршрута не найдена машина');
  const moving = composition.filter(
    (row) => row.workDate === null && row.assignedVehicleId !== vehicleId,
  );

  const alien = moving.filter((row) => row.orderedKindId !== vehicle.kindId);
  if (alien.length > 0) {
    throw err.unprocessable(
      `Заявки ${alien.map((row) => row.displayNumber).join(', ')} заказаны другим видом техники, а рейс поедет «${vehicle.typeName}» — назначение на неё не переписывается`,
      { vehicleId: 'Другой вид ТС' },
    );
  }
  return { vehicle: { id: vehicleId, ...vehicle }, moving };
}

/** Применить план: назначения состава едут за машиной рейса. */
export async function applyReassignment(
  tx: Tx,
  plan: ReassignmentPlan,
): Promise<ReassignedRequest[]> {
  const changed: ReassignedRequest[] = [];
  for (const row of plan.moving) {
    await tx
      .update(vehicleRequestAssignments)
      .set({
        vehicleId: plan.vehicle.id,
        // Тип машины рейса, а не заказанный: копия существует ради составного FK на технику и
        // обязана называть ту единицу, которая записана рядом (миграция 0083).
        vehicleTypeId: plan.vehicle.vehicleTypeId,
        updatedAt: new Date(),
      })
      .where(eq(vehicleRequestAssignments.requestId, row.requestId));
    changed.push({
      requestId: row.requestId,
      displayNumber: row.displayNumber,
      vehicleId: { before: row.assignedVehicleId, after: plan.vehicle.id },
    });
  }
  return changed;
}

// ── Перенос заявки между рейсами прошедших дней (Р30, ADR 0101 п. 14) ──

export const TRANSFER_SAME_ROUTE_MESSAGE =
  'Источник и приёмник — один и тот же рейс: переносить нечего, а два номера сгорели бы впустую';

export const TRANSFER_RELOCATION_MESSAGE =
  'Перенос бывает только между грузовыми рейсами: у перегона техники талонов заказчиков нет вовсе — там едет одна заявка-основание, и меняют её в карточке заявки';

/**
 * Линейный день этой дверью не ходит (ADR 0100 п. 8). Причина та же, по которой его не принимает и
 * обычная укладка в рейс: день знает свой срок и свою заявку, а рейс — нет.
 */
export const TRANSFER_LINEAR_DAY_MESSAGE =
  'Это день линейного заказа, а не грузовая заявка: день равен дню своего рейса, и «перенести» его значит распланировать другой день — делают это в карточке заявки, где виден срок заказа';

/** Что перенос сделает с составами обоих рейсов — посчитано до первого аннулирования (Р36). */
export interface TransferPlan {
  /** Переносимая строка, какой она была в источнике. */
  moved: RouteCompositionRow;
  /** Будущий состав приёмника в порядке талонов: 1…N. */
  target: RouteCompositionRow[];
  /** Будущий состав источника, уплотнённый; пустой — рейс останется без задания (Р22). */
  source: RouteCompositionRow[];
}

/**
 * Куда встанет заявка и что останется в источнике (Р30).
 *
 * Чистая функция, и это не аккуратность ради аккуратности: будущие составы нужны дважды — сперва
 * preflight'у (Р36), который прогоняет их через правила выписки **до** того, как списан первый
 * номер, и потом самой правке, которая эти же позиции и запишет. Посчитанные дважды, они разошлись
 * бы ровно в том месте, где расхождение стоит сгоревшего бланка.
 *
 * **День линейного заказа отклоняется** (ADR 0100 п. 8, п. 3). Строка состава с `work_date` физически
 * равна дню своего рейса — их держит вместе составной ключ, — поэтому «перенести день в рейс другого
 * дня» это не исправление документа, а перепланирование: день уезжает на другую дату, проверяется
 * на срок заказа и на занятость соседним рейсом. Дверь у этого одна — карточка заявки, где виден
 * срок. Тем же решением коррекция рейса не трогает назначение линейного заказа (ADR 0100 п. 4):
 * заказ отвечает за весь срок, а машину дня задаёт рейс.
 *
 * Позиция в приёмнике проверяется по существующим талонам, а не только схемой: `position: 5` в
 * рейсе с двумя строками означало бы дыру в задании — пустую графу посреди бланка.
 */
export function planTransfer(input: {
  requestId: string;
  position?: number;
  target: readonly RouteCompositionRow[];
  source: readonly RouteCompositionRow[];
}): TransferPlan {
  const moved = input.source.find((row) => row.requestId === input.requestId);
  // Не отказ правила, а устаревшая карточка: заявку успели вынуть или перенести, пока окно было
  // открыто. Поэтому 409 и «обновите», а не 422 и «нельзя».
  if (!moved) {
    throw err.conflict(
      'Этой заявки в исходном рейсе уже нет — обновите карточку: её успели перенести или вынуть',
    );
  }
  if (moved.workDate !== null) throw err.unprocessable(TRANSFER_LINEAR_DAY_MESSAGE);

  const slot = input.position ?? input.target.length + 1;
  if (slot > input.target.length + 1) {
    throw err.unprocessable(
      `В приёмнике ${input.target.length} талон(ов): заявка встаёт с первого по ${input.target.length + 1}-й, иначе в задании осталась бы пустая строка`,
      { position: 'Такого талона в рейсе нет' },
    );
  }

  const rest = [...input.target];
  rest.splice(slot - 1, 0, moved);
  const renumber = (rows: RouteCompositionRow[]): RouteCompositionRow[] =>
    rows.map((row, index) => ({ ...row, position: index + 1 }));
  return {
    moved,
    target: renumber(rest),
    // Талоны источника уплотняются: дыра в нумерации означала бы пустую графу в его бланке.
    source: renumber(input.source.filter((row) => row.requestId !== input.requestId)),
  };
}

/**
 * Списать действующий лист рейса в рамках операции; `null` — списывать было нечего.
 *
 * Половина правила «коррекция это аннулировать и выписать заново» (Р1). Отдельно от выписки,
 * потому что у переноса между этими двумя шагами стоит сама правка: сперва **оба** номера списаны,
 * потом заявка переезжает, и только потом рождаются оба новых листа (Р30). Слепив шаги в одну
 * функцию, мы получили бы порядок «списали и выписали приёмник, а источник ещё со старым бланком» —
 * то есть мгновение, в котором одна и та же заявка стоит в двух действующих документах.
 */
export async function cancelRouteWaybillForCorrection(
  tx: Tx,
  input: { routeId: string; correctionId: string; reason: string; actorUserId: string },
): Promise<{ id: string; number: string } | null> {
  const existing = await routeWaybill(tx, input.routeId);
  if (!existing || existing.status === 'cancelled') return null;
  const cancelled = await cancelWaybillForCorrection(tx, {
    waybillId: existing.id,
    correctionId: input.correctionId,
    reason: input.reason,
    actorUserId: input.actorUserId,
  });
  // Соседняя вкладка успела списать этот номер раньше: продолжать нечем — рейс уже не тот, о
  // котором человек принимал решение.
  if (!cancelled) throw err.conflict('Лист уже аннулирован — откройте рейс заново');
  return { id: existing.id, number: existing.number };
}

/**
 * Новый лист рейса с меткой операции; `null` — рейс остался без задания и бланка не получает.
 *
 * Р22: опустевший источник переноса остаётся пустым. Перевыписка пустого бланка сожгла бы номер на
 * бумагу с пустым заданием — а право `waybills.issueBlank` (ADR 0071) здесь ни при чём: оно про
 * осознанное решение человека выписать бланк «на машину и водителя», а не про побочный результат
 * переноса, о котором никто не просил. Сам рейс не удаляется: на него ссылается аннулированный лист.
 *
 * Водитель к этому моменту заведомо есть — его спросил preflight (`canIssueWaybill`) до первого
 * аннулирования (Р36).
 *
 * Рукопожатие (Р21а) идёт своим полем на **каждую** сторону переноса: листов здесь два, наборы
 * предупреждений у них разные — заявка уехала из одного задания в другое, — и отпечаток считается
 * по каждому рейсу отдельно. Первый же неподтверждённый останавливает операцию целиком: транзакция
 * откатывается, оба номера остаются непотраченными, а окно получает список и свежий отпечаток
 * того рейса, о котором отказ.
 */
export async function issueCorrectionWaybill(
  tx: Tx,
  input: {
    route: RouteRow;
    composition: readonly RouteCompositionRow[];
    correctionId: string;
    reason: string;
    /** Заменяемый номер; `null` — заменять было нечего (Р35). */
    correctsWaybillId: string | null;
    /** Подтверждение предупреждений **этого** рейса (Р21); `null` — не присылали. */
    acknowledge: { fingerprint: string } | null;
    actorUserId: string;
  },
): Promise<{ id: string; number: string } | null> {
  const { route } = input;
  if (input.composition.length === 0 && !route.sourceRequestId) return null;
  const issued = await issueWaybillForRoute(tx, {
    routeId: route.id,
    routeNumber: formatVehicleRouteNumber(route.num),
    purpose: route.purpose,
    vehicleId: route.vehicleId,
    routeDate: route.routeDate,
    driverPersonId: route.driverPersonId!,
    trip: routeTripOf(route),
    requests: input.composition.map((row) => ({
      requestId: row.requestId,
      position: row.position,
    })),
    relocation: route.sourceRequestId
      ? { requestId: route.sourceRequestId, from: route.moveFrom, to: route.moveTo }
      : null,
    acknowledge: input.acknowledge,
    actor: { id: input.actorUserId },
  });
  await markCorrectionWaybill(tx, {
    waybillId: issued.id,
    correctionId: input.correctionId,
    reason: input.reason,
    correctsWaybillId: input.correctsWaybillId,
  });
  return { id: issued.id, number: issued.number };
}

/** Подпись объекта под днём работы: кто принял часы и когда. */
export interface ShiftApproval {
  requestId: string;
  displayNumber: string;
  date: string;
  approvedBy: string;
  approvedByName: string;
  approvedAt: string;
}

/**
 * Дни состава, под которыми стоит подпись объекта, — те самые, которые коррекция снимет (Р5).
 *
 * Смены есть только у заказа техники на объект: у грузоперевозки работа считается рейсом, а не
 * днями, и таблицы часов у неё нет вовсе. Значит и снимать коррекция будет подписи ровно за
 * линейные дни состава (ADR 0100 §2) — у обычного грузового рейса этот список пуст, и это не
 * оплошность, а отсутствие предмета.
 *
 * День берётся из строки состава, а не из даты рейса: они равны физически (составной FK, миграция
 * 0127), и второй ответ на «какой это день» разошёлся бы с первым при переносе рейса.
 */
export async function approvedShiftsOfComposition(
  reader: Reader,
  composition: readonly RouteCompositionRow[],
): Promise<ShiftApproval[]> {
  const days = composition.filter(
    (row): row is RouteCompositionRow & { workDate: string } => row.workDate !== null,
  );
  if (days.length === 0) return [];

  const rows = await reader
    .select({
      requestId: vehicleRequestShifts.requestId,
      shiftDate: vehicleRequestShifts.shiftDate,
      approvedBy: vehicleRequestShifts.approvedBy,
      approvedByName: users.fullName,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .innerJoin(users, eq(users.id, vehicleRequestShifts.approvedBy))
    .where(
      and(
        inArray(
          vehicleRequestShifts.requestId,
          days.map((row) => row.requestId),
        ),
        inArray(
          vehicleRequestShifts.shiftDate,
          days.map((row) => row.workDate),
        ),
        isNotNull(vehicleRequestShifts.approvedAt),
      ),
    );

  const numbers = new Map(
    days.map((row) => [`${row.requestId}@${row.workDate}`, row.displayNumber]),
  );
  return rows.flatMap((row) => {
    // Пара «заявка + день» из запроса шире перечня дней: два условия `IN` перемножаются, и у
    // заказа с двумя днями в разных рейсах сюда попал бы день соседнего рейса.
    const displayNumber = numbers.get(`${row.requestId}@${row.shiftDate}`);
    if (!displayNumber || !row.approvedBy || !row.approvedAt) return [];
    return [
      {
        requestId: row.requestId,
        displayNumber,
        date: row.shiftDate,
        approvedBy: row.approvedBy,
        approvedByName: row.approvedByName,
        approvedAt: row.approvedAt.toISOString(),
      },
    ];
  });
}

/**
 * Снять подпись объекта с этих дней (Р5, ADR 0101 п. 16).
 *
 * Подпись стоит под работой конкретной техники, а после коррекции — под машиной, которой в этот
 * день не было. Прежние `approvedBy`/`approvedAt` сохраняет вызывающий в снимке операции: в самой
 * таблице их после снятия уже нет, а «кто принял 11,5 машиночаса за 12 августа» спрашивают через
 * два месяца.
 *
 * Снимается только подпись — сами часы остаются: их вносил объект, коррекция машины их не
 * опровергает, и стерев их, портал заставил бы вносить работу заново.
 *
 * Отдельно от `setShiftApproval` (`vehicle-request-shifts.ts`) ради одного: там подпись ставят и
 * снимают по одному дню и без прежних значений, а здесь нужны и пачка, и то, что было до.
 */
export async function clearShiftApprovals(
  tx: Tx,
  approvals: readonly ShiftApproval[],
): Promise<void> {
  for (const approval of approvals) {
    await tx
      .update(vehicleRequestShifts)
      .set({ approvedBy: null, approvedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(vehicleRequestShifts.requestId, approval.requestId),
          eq(vehicleRequestShifts.shiftDate, approval.date),
        ),
      );
  }
}

/**
 * Пометить выписанный лист операцией коррекции (Р35).
 *
 * Отдельным `UPDATE` сразу после выписки, а не полем `issueWaybillForRoute`: выписка одна на все
 * входы — обычный рейс, перегон, коррекция, перенос, — и её сигнатура не должна знать о том, чего
 * в обычном случае не существует. Проверки схемы это выдерживают: у вставленной строки
 * `correction_id` пуст (CHECK о причине к ней не относится), а `UPDATE` ставит ссылку и причину
 * одним заявлением.
 *
 * `correctsWaybillId` пуст, когда заменять было нечего: рейс прошедшего дня без действующего листа
 * коррекция тоже кончает новым номером, и такой лист объяснён `correction_reason` при пустой ссылке
 * (Р35, `waybills_correction_issue_reason_check`).
 */
export async function markCorrectionWaybill(
  tx: Tx,
  input: {
    waybillId: string;
    correctionId: string;
    reason: string;
    correctsWaybillId: string | null;
  },
): Promise<void> {
  await tx
    .update(waybills)
    .set({
      correctionId: input.correctionId,
      correctionReason: input.reason,
      correctsWaybillId: input.correctsWaybillId,
      updatedAt: new Date(),
    })
    .where(eq(waybills.id, input.waybillId));
}

/**
 * Поднять версии заявок, которых коснулась операция (Р24).
 *
 * Версии заявок в теле коррекции не спрашиваются — у клиента их нет, он правит рейс, — но растут:
 * иначе чужая открытая карточка заявки сохранила бы поверх коррекции старую машину, и та же ошибка
 * вернулась бы в портал через минуту после исправления.
 *
 * Считается от текущей строки, а не от прочитанной: сверять здесь нечего, коррекция и так идёт под
 * блокировкой этих строк.
 */
export async function bumpRequestVersions(
  tx: Tx,
  requestIds: readonly string[],
  actorId: string,
): Promise<void> {
  const ids = [...new Set(requestIds)];
  if (ids.length === 0) return;
  await tx
    .update(vehicleRequests)
    .set({
      updatedBy: actorId,
      version: sql`${vehicleRequests.version} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(vehicleRequests.id, ids));
}

/**
 * Машина рейса глазами коррекции: жива ли, своя ли и в каком она сейчас состоянии.
 *
 * Статус не проверяется намеренно (Р17, ADR 0101 п. 15): типичная коррекция за прошлую неделю
 * касается как раз той машины, которую с тех пор списали или отправили в ремонт, а истории статусов
 * у техники нет — проверить «была ли она активна тогда» нечем. Заведение нового рейса ограничение
 * сохраняет (`assertRouteVehicle`): там речь о будущем, и списанную машину в план ставить незачем.
 *
 * Два отказа остаются. Удалённая запись — это не «машина в ремонте», а «такой машины в портале нет»
 * (её и в справочнике не видно). Арендная — потому что лист на неё выписывает арендодатель, и
 * коррекция кончилась бы отказом бланка уже после аннулирования действующего.
 */
export async function correctionVehicle(
  reader: Reader,
  vehicleId: string,
): Promise<{ id: string; status: VehicleStatus }> {
  const [row] = await reader
    .select({
      id: vehicles.id,
      status: vehicles.status,
      ownership: vehicles.ownership,
      deletedAt: vehicles.deletedAt,
    })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId));
  if (!row || row.deletedAt) throw err.badRequest('Техника не найдена');
  if (row.ownership !== 'own') {
    throw err.unprocessable(
      'Маршрут ведётся только для собственной техники: путевой лист на арендную выписывает арендодатель',
      { vehicleId: 'Арендная техника' },
    );
  }
  return { id: row.id, status: row.status };
}

/** Реквизиты рейса, какими их держит его строка, — ими сверяется «а меняет ли коррекция хоть что-то». */
export function routeTripOf(route: RouteRow) {
  return {
    withTrailer: route.withTrailer,
    trailer1Model: route.trailer1Model,
    trailer1RegNumber: route.trailer1RegNumber,
    trailer2Model: route.trailer2Model,
    trailer2RegNumber: route.trailer2RegNumber,
    garageNumber: route.garageNumber,
    communicationKind: route.communicationKind,
    transportationKind: route.transportationKind,
  };
}

export const CORRECTION_EMPTY_MESSAGE =
  'Коррекция ничего не меняет: машина, водитель, реквизиты и порядок талонов совпадают с рейсом. Номер бланка сгорел бы впустую';
