import { and, desc, eq, gte, inArray, isNotNull, ne, type SQL, sql } from 'drizzle-orm';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type VehicleOwnership,
  weekStartKey,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  departments,
  persons,
  specialEquipmentRequestDetails,
  vehicleRequestAssignmentChanges,
  vehicleRequests,
  vehicleRoutes,
  vehicles,
  waybills,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { readAssignmentMode, historyIsAuthoritative } from './assignment-mode';
import { assignmentSegments, assignmentStateOn } from './assignment-history';
import { readAssignmentChanges } from './assignment-write';
import { esm2SheetPlan } from './esm2-plan';
import { buildEsm2SyncPlan } from './waybill-esm2';
import { correctionFingerprint } from './waybill-correction';

/**
 * Считается только в транзакции, и это не строгость ради строгости: расчёт складывает бумагу из
 * истории назначений, действующих листов и недельных заявок, и в `READ COMMITTED` три этих чтения
 * могли бы прийти из трёх разных состояний — перечень тогда обещал бы то, чего не было ни в один
 * момент. Тем же снимком дверь удаления и подтверждает свой отпечаток.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Заказ, который человек ведёт машинистом, и бумага, которая на него ещё выпишется. */
export interface MachinistCommitmentOrder {
  requestId: string;
  /** Сквозной номер заказа: им его называют человеку («ТС-198»). */
  num: number;
  /** Площадка или отдел — заказчик заявки (ADR 0040); пусто не бывает по устройству таблицы. */
  customer: string;
  dateFrom: string;
  /** Срок, каким он записан: `coalesce(date_to, date_from)`. */
  dateTo: string;
  /** Срок, каким он станет после визы по ожидающей недельной заявке; равен `dateTo`, если её нет. */
  assumedDateTo: string;
  /** Номер недельной заявки, которая продлевает этот заказ и ещё не применена; `null` — такой нет. */
  pendingWeeklyNum: number | null;
  /** Сколько листов ЭСМ-2 выпишется **на этого человека** при таком сроке (Р7). */
  futureSheets: number;
}

/** Что стоит за спиной у человека, чью карточку собираются снять. */
export interface MachinistCommitments {
  personId: string;
  /** Пусто — связей нет, и удаление проходит молча. */
  orders: MachinistCommitmentOrder[];
  /** Рейсы 4-П будущих дней, где он за рулём: бумага не ЭСМ-2, но работа тоже назначенная. */
  futureRouteDays: number;
  /** Сумма по заказам — ею диалог и говорит «выпишется ещё N листов». */
  totalFutureSheets: number;
  /**
   * Отпечаток перечня: им дверь удаления отличает подтверждение **этого** списка от подтверждения
   * того, что человек видел минуту назад. За время диалога заказ могли продлить, сменить машиниста
   * или завизировать недельную заявку — и подтверждали тогда не то, что произойдёт.
   */
  fingerprint: string;
}

/**
 * Чем человек занят как машинист — **один расчёт на две двери** (план `machinist-card-removal`, Э1).
 *
 * Им считается и предупреждение удаления карточки, и плашка «машинист снят» в карточке заявки.
 * Второй расчёт того же ответа разошёлся бы с первым — ровно тот порок, который эта волна и лечит:
 * удаление молчало о последствиях, потому что о них никто не спрашивал.
 *
 * ЧТО СЧИТАЕТСЯ ЗАТРОНУТЫМ. Не только «срок ещё идёт»: недельная заявка продлевает и заказ,
 * кончившийся до неё (`sourceItemBlocker` контрактов — не раньше чем за неделю до начала недели),
 * а решение о машинисте бывает дремлющим — отрезок с датой в будущем, за концом нынешнего срока
 * (ADR 0126, Р24). Узкое условие «срок не кончился» теряло бы самый частый случай продления —
 * заказ, закончившийся вчера.
 *
 * КТО СЧИТАЕТСЯ МАШИНИСТОМ. По авторитетности источника, а не «что нашлось первым»: свёртка
 * назначений, если история авторитетна; последний лист — только там, где истории нет вовсе.
 * `cleared` и `unknown` — ответы сами по себе: человека там нет, и подставлять вместо них прежнего
 * нельзя (арендный отрезок и «история не знает» заведены ровно затем, чтобы догадка не выдавалась
 * за факт).
 *
 * СКОЛЬКО БУМАГИ. Планом, а не неделями (Р7): в неделе законно живут два листа — разрез отрезком и
 * месячный разрез, — а у арендной единицы и линейного заказа бумаги может не быть вовсе. Считается
 * по **предполагаемому** сроку и **действующему режиму**: недельный план до cutover, отрезковый
 * после. И только листы этого человека: в разрезе у соседних листов недели бывают разные люди.
 */
export async function machinistCommitmentsOf(
  reader: Tx,
  personId: string,
  asOf: string = moscowDateKeyOf(new Date()),
): Promise<MachinistCommitments> {
  const candidates = await candidateRequestIds(reader, personId);
  const orders: MachinistCommitmentOrder[] = [];

  if (candidates.length > 0) {
    const rows = await loadOrders(reader, candidates, asOf);
    const extensions = await pendingExtensions(reader, candidates);
    const mode = await readAssignmentMode(reader);
    const byHistory = historyIsAuthoritative(mode);

    for (const row of rows) {
      const assumedDateTo = laterOf(row.dateTo, extensions.get(row.requestId)?.dateTo ?? null);
      const paper = await futurePaperOf(reader, {
        row,
        personId,
        assumedDateTo,
        asOf,
        byHistory,
      });
      if (!paper.isMachinist && paper.sheets === 0) continue;
      orders.push({
        requestId: row.requestId,
        num: row.num,
        customer: row.customer,
        dateFrom: row.dateFrom,
        dateTo: row.dateTo,
        assumedDateTo,
        pendingWeeklyNum: extensions.get(row.requestId)?.weeklyNum ?? null,
        futureSheets: paper.sheets,
      });
    }
    orders.sort((a, b) => a.num - b.num);
  }

  const [routes] = await reader
    .select({ n: sql<number>`count(*)::int` })
    .from(vehicleRoutes)
    .where(and(eq(vehicleRoutes.driverPersonId, personId), gte(vehicleRoutes.routeDate, asOf)));

  return {
    personId,
    orders,
    futureRouteDays: routes?.n ?? 0,
    totalFutureSheets: orders.reduce((sum, order) => sum + order.futureSheets, 0),
    // В отпечаток идёт то, что человек **видит**: номера заказов, сроки и число листов. День
    // расчёта в него не входит намеренно — иначе подтверждение протухало бы в полночь само по себе,
    // ничего не изменившись по существу.
    fingerprint: correctionFingerprint({
      personId,
      orders: orders.map((order) => ({
        num: order.num,
        assumedDateTo: order.assumedDateTo,
        futureSheets: order.futureSheets,
      })),
      futureRouteDays: routes?.n ?? 0,
    }),
  };
}

/**
 * Заказы, где человек вообще может стоять машинистом: из выданной бумаги и из истории назначений.
 *
 * Двух источников достаточно и меньше нельзя. Легаси-назначение (`vehicle_request_assignments`)
 * человека не хранит вовсе — там только машина, — и единственный его след у старого заказа это
 * выписанный лист. У заказа с историей человек живёт в отрезках, и лист может ещё не существовать:
 * дремлющее решение бумаги пока не родило.
 */
async function candidateRequestIds(reader: Tx, personId: string): Promise<string[]> {
  const [fromPaper, fromHistory] = await Promise.all([
    reader
      .selectDistinct({ requestId: waybills.sourceRequestId })
      .from(waybills)
      .where(
        and(
          eq(waybills.driverPersonId, personId),
          ne(waybills.status, 'cancelled'),
          isNotNull(waybills.sourceRequestId),
        ),
      ),
    reader
      .selectDistinct({ requestId: vehicleRequestAssignmentChanges.requestId })
      .from(vehicleRequestAssignmentChanges)
      .where(eq(vehicleRequestAssignmentChanges.driverPersonId, personId)),
  ]);
  return [
    ...new Set(
      [...fromPaper, ...fromHistory]
        .map((row) => row.requestId)
        .filter((id): id is string => id !== null),
    ),
  ];
}

interface OrderRow {
  requestId: string;
  num: number;
  customer: string;
  dateFrom: string;
  dateTo: string;
}

/**
 * Заказы в работе, которых удаление ещё может коснуться.
 *
 * Нижняя граница срока — не «сегодня», а начало прошлой недели относительно текущей: недельная
 * заявка продлевает заказ, кончившийся не раньше чем за неделю до начала своей недели
 * (`sourceItemBlocker`). Здесь взята та же арифметика, а не своя: разойдись они — перечень удаления
 * терял бы ровно те заказы, которые продление ещё поднимет.
 */
async function loadOrders(
  reader: Tx,
  requestIds: readonly string[],
  asOf: string,
): Promise<OrderRow[]> {
  const floor = shiftDateKey(weekStartKey(asOf), -7);
  const rows = await reader
    .select({
      requestId: vehicleRequests.id,
      num: vehicleRequests.num,
      objectName: constructionObjects.name,
      departmentName: departments.name,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
    })
    .from(vehicleRequests)
    .innerJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(constructionObjects, eq(constructionObjects.id, vehicleRequests.objectId))
    .leftJoin(departments, eq(departments.id, vehicleRequests.departmentId))
    .where(
      and(
        inArray(vehicleRequests.id, [...requestIds]),
        eq(vehicleRequests.status, 'confirmed'),
        sql`${vehicleRequests.deletedAt} IS NULL`,
        sql`coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom}) >= ${floor}`,
      ),
    );
  return rows.map((row) => ({
    requestId: row.requestId,
    num: row.num,
    customer: row.objectName ?? row.departmentName ?? '',
    dateFrom: row.dateFrom,
    dateTo: row.dateTo ?? row.dateFrom,
  }));
}

/** Продление, которое ещё не применено: заказ, стоящий в неделе с решением «остаётся». */
async function pendingExtensions(
  reader: Tx,
  requestIds: readonly string[],
): Promise<Map<string, { dateTo: string; weeklyNum: number }>> {
  const rows = await reader
    .select({
      requestId: weeklyVehicleRequestItems.sourceRequestId,
      dateTo: weeklyVehicleRequestItems.dateTo,
      weeklyNum: weeklyVehicleRequests.num,
    })
    .from(weeklyVehicleRequestItems)
    .innerJoin(
      weeklyVehicleRequests,
      eq(weeklyVehicleRequests.id, weeklyVehicleRequestItems.weeklyRequestId),
    )
    .where(
      and(
        inArray(weeklyVehicleRequestItems.sourceRequestId, [...requestIds]),
        eq(weeklyVehicleRequestItems.kind, 'extend'),
        isNotNull(weeklyVehicleRequestItems.dateTo),
        inArray(weeklyVehicleRequests.status, ['draft', 'pending']),
      ),
    )
    .orderBy(desc(weeklyVehicleRequestItems.dateTo));
  const map = new Map<string, { dateTo: string; weeklyNum: number }>();
  for (const row of rows) {
    if (!row.requestId || !row.dateTo || map.has(row.requestId)) continue;
    map.set(row.requestId, { dateTo: row.dateTo, weeklyNum: row.weeklyNum });
  }
  return map;
}

/**
 * Машинист заказа и его будущая бумага — по действующему режиму чтения (Р7).
 *
 * Оба ответа считаются вместе, потому что считаются из одного и того же: до cutover — недельный
 * план заявки, после — разрез отрезков. Порознь они разошлись бы в окне переключения, а окно это
 * двигается туда и обратно одной строкой.
 */
async function futurePaperOf(
  reader: Tx,
  params: {
    row: OrderRow;
    personId: string;
    assumedDateTo: string;
    asOf: string;
    byHistory: boolean;
  },
): Promise<{ isMachinist: boolean; sheets: number }> {
  const { row, personId, assumedDateTo, asOf, byHistory } = params;

  if (byHistory) {
    const changes = await readAssignmentChanges(reader, row.requestId);
    if (changes.length > 0) {
      const term = { dateFrom: row.dateFrom, dateTo: assumedDateTo };
      const segments = assignmentSegments(changes, term);
      const ownershipByVehicle = await ownershipOf(reader, segments);
      const sheets = await activeSheetsOf(reader, row.requestId);
      const plan = esm2SheetPlan(segments, term, sheets, { ownershipByVehicle, today: asOf });
      const state = assignmentStateOn(changes, asOf);
      return {
        // `cleared` и `unknown` человека не называют, и прежним его тут не заменяют.
        isMachinist: state.driver?.state === 'set' && state.driver.personId === personId,
        sheets: plan.issue.filter((issue) => issue.driver.personId === personId).length,
      };
    }
  }

  const built = await buildEsm2SyncPlan(reader, {
    requestId: row.requestId,
    assumeDateTo: assumedDateTo,
    asOf,
  });
  if (!built) return { isMachinist: false, sheets: 0 };
  return {
    isMachinist: built.input.driverPersonId === personId,
    sheets: built.plan.issue.filter(() => built.input.driverPersonId === personId).length,
  };
}

/** Действующие листы заявки в том виде, в каком их сверяет разрез. */
async function activeSheetsOf(
  reader: Tx,
  requestId: string,
): Promise<
  { id: string; periodFrom: string; periodTo: string; vehicleId: string; driverPersonId: string }[]
> {
  const rows = await reader
    .select({
      id: waybills.id,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      vehicleId: waybills.vehicleId,
      driverPersonId: waybills.driverPersonId,
    })
    .from(waybills)
    .where(and(eq(waybills.sourceRequestId, requestId), ne(waybills.status, 'cancelled')));
  return rows
    .filter((row) => row.periodFrom !== null && row.periodTo !== null)
    .map((row) => ({
      id: row.id,
      periodFrom: row.periodFrom!,
      periodTo: row.periodTo!,
      vehicleId: row.vehicleId,
      driverPersonId: row.driverPersonId,
    }));
}

/**
 * Принадлежность машин разреза: карта обязана быть полной, иначе план молча припишет бланк не той
 * стороне (`Esm2PlanContext`).
 */
async function ownershipOf(
  reader: Tx,
  segments: readonly { vehicle: { vehicleId: string } | null }[],
): Promise<Map<string, VehicleOwnership>> {
  const ids = [
    ...new Set(segments.map((s) => s.vehicle?.vehicleId).filter((id): id is string => !!id)),
  ];
  const map = new Map<string, VehicleOwnership>();
  if (ids.length === 0) return map;
  const rows = await reader
    .select({ id: vehicles.id, ownership: vehicles.ownership })
    .from(vehicles)
    .where(inArray(vehicles.id, ids));
  for (const row of rows) map.set(row.id, row.ownership);
  return map;
}

/** Позднейшая из двух дат; `null` справа — левая. */
function laterOf(current: string, pending: string | null): string {
  if (!pending) return current;
  return pending > current ? pending : current;
}

/** ФИО и дата снятия карточки — ими диалог и плашка называют человека. */
export async function personRemovalOf(
  reader: Tx,
  personId: string,
): Promise<{ fullName: string; removedOn: string | null } | null> {
  const [row] = await reader
    .select({ fullName: persons.fullName, deletedAt: persons.deletedAt })
    .from(persons)
    .where(eq(persons.id, personId));
  if (!row) return null;
  return {
    fullName: row.fullName,
    removedOn: row.deletedAt ? moscowDateKeyOf(row.deletedAt) : null,
  };
}

/**
 * Выписан ли последний действующий лист заказа на **снятую** карточку машиниста (Э4).
 *
 * Ссылку на заявку принимает параметром: одна и та же таблица приходит в запросы под разными
 * псевдонимами (`weekly_source_requests` у строки недельной заявки), и зашитое имя ломало бы
 * запрос целиком.
 *
 * Тем же источником, каким бумагу наследует сверка (`lastMachinistOf`): вопрос у признака ровно
 * один — «на кого выпишется следующий бланк», и второй ответ на него разошёлся бы с первым.
 *
 * Корреляция вынесена отдельным `sql`-чанком намеренно. В списке столбцов односоставного запроса
 * drizzle переписывает колонки голыми идентификаторами и внутрь вложенного `sql` не заходит; здесь
 * подзапрос двухтабличный, и без выноса неоднозначными стали бы и соединение, и условие — Postgres
 * ответил бы `42702` на каждой странице (см. `office-equipment-sql-correlation.test.ts`).
 */
export function machinistCardRemovedSql(requestIdRef: SQL): SQL<boolean> {
  return sql<boolean>`coalesce((
  SELECT p.deleted_at IS NOT NULL
    FROM waybills w
    JOIN persons p ON p.id = w.driver_person_id
   WHERE w.source_request_id = ${requestIdRef}
     AND w.status <> 'cancelled'
   ORDER BY w.issued_at DESC
   LIMIT 1
), false)`;
}
