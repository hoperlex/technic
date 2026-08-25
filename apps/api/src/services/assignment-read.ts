import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import {
  assignmentPeriodsControl,
  specialEquipmentRequestDetails,
  vehicleRequestAssignmentChanges,
} from '../db/schema';
import {
  assignmentStateOn,
  type AssignmentChangeRow,
  type AssignmentState,
} from './assignment-history';
import { historyIsAuthoritativeSql } from './assignment-mode';

/**
 * Четыре читателя денормализации: «какая машина работала» и «кто её водитель» — по истории, а не
 * по строке `vehicle_request_assignments` (`docs/assignment-periods-plan.md`, Ф3 и С1, этап 5).
 *
 * ЧТО ЗДЕСЬ ЛЕЖИТ И ПОЧЕМУ ОДНИМ МОДУЛЕМ. Четыре места портала отвечают на один и тот же вопрос —
 * «что стояло на этой заявке в такой-то день»:
 *
 * - отбор «где ходила эта машина» (`requestVehicleWhere`, четыре применения: список, лента, архив,
 *   сводка над таблицей);
 * - срез «Техника на площадке» (`dayVehicle`);
 * - занятость гаража (`specialBusyExists` и её же расшифровка строкой, `loadSpecials`);
 * - контакт водителя для заказчика (`GET /vehicle-requests/:id/driver`, ADR 0122).
 *
 * Пока машина стояла на заказе весь срок, ответ у всех четырёх был один и лежал в денормализации.
 * С разрезом срока (Р3, Р24) он стал разным по дням, и каждое из четырёх мест, оставшись при
 * назначении, начало отвечать неверно **на прошедших датах**: январская машина не находится
 * фильтром, срез января показывает мартовскую, гараж ставит на площадку ту, которой там не было.
 * Собраны они здесь, а не расписаны по местам, ровно по той причине, по какой в гараже собран
 * `routeHasWork`, а здесь рядом — `requestIsLinearSql`: расхождение четырёх копий одного правила
 * не видно вслух. Оно видно тем, что цифра над таблицей не сходится со строками под ней.
 *
 * ОБА ПУТИ ЖИВУТ ДО САМОГО CUTOVER. Ни один из читателей не переписан на историю «совсем»:
 * каждый — это `CASE` с двумя ветвями, и выбирает между ними режим модуля. При `read_mode = legacy`
 * все четыре отвечают ровно тем, чем отвечали вчера; при `history` — свёрткой. Переключение
 * обратимо в обе стороны одной строкой в `assignment_periods_control`, и откат не требует ни
 * выката, ни правки кода (§10, решение И1).
 *
 * ЧТО ОТВЕЧАЕТСЯ ЗАЯВКЕ БЕЗ ИСТОРИИ (состояние `empty`). Свёртка пуста, а ответ нужен — и молчание
 * здесь не нейтрально: машина пропала бы из фильтра, площадка опустела бы в срезе, гараж объявил
 * бы свободной занятую единицу. Поэтому правило у всех четырёх одно и одинаково выражено:
 *
 *     история отвечает там, где у заявки есть действующая строка нужной шкалы;
 *     где её нет — отвечает денормализация, ровно как в `legacy`.
 *
 * Это не поблажка и не «мягкий режим»: `empty` означает «история молчит», а не «никто не работал»,
 * и денормализация в этот момент — единственное, что о заявке вообще известно. Заявок, которым
 * история не положена, при этом больше, чем непочиненных: популяция бэкфилла — заказы спецтехники
 * в работе и выполненные (`ASSIGNMENT_READINESS_POPULATION`), а читатели обслуживают и
 * грузоперевозки, и новые, и отменённые заказы. Для них ветвь денормализации не временная, а
 * единственно верная. Предикат готовности cutover при этом не ослаблен: он по-прежнему не
 * пропускает `empty` внутри своей популяции ([assignment-readiness.ts](./assignment-readiness.ts)),
 * и «мы всё равно ответим по назначению» — не повод его не чинить.
 *
 * ПОЧЕМУ ПРАВИЛО ВЫРАЖЕНО СТРОКАМИ, А НЕ КОЛОНКОЙ `assignment_history_state`. Колонка отвечает на
 * вопрос «доведена ли заявка прогоном», и её ведёт третий код. Читателю нужен другой вопрос — «есть
 * ли чем ответить **на этот** вопрос», — и отвечать на него обязаны те же строки, которые читает
 * свёртка. Опирайся читатель на колонку, он однажды промолчал бы при живой истории или, наоборот,
 * ушёл бы в пустую свёртку по бодрой метке.
 *
 * ДВЕ ФОРМЫ ОДНОГО ПРАВИЛА, И ЭТО ВЫНУЖДЕННО. Отбор и занятость — куски `WHERE`, и свёртку им
 * приходится выражать на SQL: «последняя действующая строка шкалы `vehicle` не позже дня». Срез и
 * контакт водителя читают строки и зовут настоящую свёртку
 * ([assignment-history.ts](./assignment-history.ts)) — там, где это возможно, второй реализации не
 * заводится. SQL-форма поэтому намеренно **минимальна**: она проецирует только шкалу машины и
 * только «что действует на день», без отрезков, схлопывания и шкалы машиниста. Всё, что сложнее
 * этой проекции, обязано ехать через свёртку, а не дописываться сюда.
 */

// ── Режим: TS-сторона ──

/**
 * Режим чтения для читателей Ф3 — тем же смыслом, что у SQL-близнеца `historyIsAuthoritativeSql`.
 *
 * Отдельно от `readAssignmentMode` ровно из-за пропавшей управляющей строки: та отвечает на неё
 * отказом 503, и для писателя это верно. Читателю ронять портал нечем и незачем — он отвечает
 * `legacy`, то есть тем же, чем ответит его SQL-близнец, у которого исключения нет в принципе.
 * Разойдись эти двое, срез и гараж на одной странице показали бы разные миры.
 */
export async function readHistoryIsAuthoritative(): Promise<boolean> {
  const [row] = await db
    .select({ readMode: assignmentPeriodsControl.readMode })
    .from(assignmentPeriodsControl)
    .where(eq(assignmentPeriodsControl.id, true));
  return row?.readMode === 'history';
}

// ── Свёртка: TS-сторона ──

/**
 * Действующая история заявок страницы — тем же добором, что файлы и смены: один запрос на список,
 * а не запрос на строку.
 *
 * Погашенные строки не берутся вовсе (`superseded_at IS NULL`): свёртка их всё равно отбросит, а
 * тащить их через сеть ради этого незачем. Порядок задан явно — свёртка сортирует сама, но
 * детерминированный порядок нужен разбору «что тут вообще было».
 */
export async function readActualChanges(
  requestIds: readonly string[],
): Promise<Map<string, AssignmentChangeRow[]>> {
  const map = new Map<string, AssignmentChangeRow[]>();
  if (requestIds.length === 0) return map;
  const rows = await db
    .select({
      requestId: vehicleRequestAssignmentChanges.requestId,
      id: vehicleRequestAssignmentChanges.id,
      effectiveDate: vehicleRequestAssignmentChanges.effectiveDate,
      dimension: vehicleRequestAssignmentChanges.dimension,
      vehicleId: vehicleRequestAssignmentChanges.vehicleId,
      driverPersonId: vehicleRequestAssignmentChanges.driverPersonId,
      driverState: vehicleRequestAssignmentChanges.driverState,
      origin: vehicleRequestAssignmentChanges.origin,
      changeGroupId: vehicleRequestAssignmentChanges.changeGroupId,
      supersededAt: vehicleRequestAssignmentChanges.supersededAt,
    })
    .from(vehicleRequestAssignmentChanges)
    .where(
      and(
        inArray(vehicleRequestAssignmentChanges.requestId, [...requestIds]),
        isNull(vehicleRequestAssignmentChanges.supersededAt),
      ),
    )
    .orderBy(
      asc(vehicleRequestAssignmentChanges.effectiveDate),
      asc(vehicleRequestAssignmentChanges.createdAt),
      asc(vehicleRequestAssignmentChanges.id),
    );
  for (const { requestId, ...row } of rows) {
    const list = map.get(requestId) ?? [];
    list.push(row);
    map.set(requestId, list);
  }
  return map;
}

/**
 * Состав заявок страницы на день: та же `assignmentStateOn`, приложенная к каждой заявке.
 *
 * Заявки без действующих строк в карту не попадают вовсе, и это не потеря, а тот самый ответ
 * «истории нет» — вызывающий отличает его от «история есть, а машина на этот день не названа»
 * (`vehicle: null`) и отвечает на них по-разному.
 */
export async function readAssignmentStatesOn(
  requestIds: readonly string[],
  date: string,
): Promise<Map<string, AssignmentState>> {
  const states = new Map<string, AssignmentState>();
  const changes = await readActualChanges(requestIds);
  for (const [requestId, rows] of changes) {
    states.set(requestId, assignmentStateOn(rows, date));
  }
  return states;
}

// ── Свёртка: SQL-сторона ──

/**
 * Машина заявки на день — выражение, годное и в `SELECT`, и в условии соединения, и в `WHERE`.
 *
 * `request` и `assigned` приходят ссылками, а не колонками drizzle, потому что запросы разные: у
 * гаража таблицы названы алиасами и собираются строкой (`ga_r.id`, `ga_a.vehicle_id`), у заявок —
 * обычные колонки. Тем же приёмом и по той же причине устроен `requestIsLinearRawSql`.
 *
 * `coalesce` вместо второй проверки «а есть ли история»: подзапрос вернёт `NULL` и когда строк нет
 * вовсе, и когда все они позже спрошенного дня, — и оба случая отвечаются одинаково, назначением.
 * Второй случай в жизни означает заявку, чья история начинается позже своего же срока, то есть
 * недовосстановленную; отвечать ей пустотой было бы хуже, чем ответить тем, что известно.
 */
export function requestDayVehicleSql(request: SQL, assigned: SQL, on: string): SQL {
  return sql`CASE WHEN ${historyIsAuthoritativeSql()}
      THEN coalesce((SELECT arv.vehicle_id
                       FROM ${vehicleRequestAssignmentChanges} arv
                      WHERE arv.request_id = ${request}
                        AND arv.dimension = 'vehicle'
                        AND arv.superseded_at IS NULL
                        AND arv.effective_date <= ${on}::date
                      ORDER BY arv.effective_date DESC
                      LIMIT 1), ${assigned})
      ELSE ${assigned}
    END`;
}

/** Есть ли у заявки действующая история машины — тем ли ей отвечать или денормализацией. */
export function hasVehicleHistorySql(request: SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${vehicleRequestAssignmentChanges} arh
       WHERE arh.request_id = ${request}
         AND arh.dimension = 'vehicle'
         AND arh.superseded_at IS NULL)`;
}

/**
 * Отработала ли машина хотя бы день срока заявки — пересечение отрезка истории со сроком.
 *
 * Это и есть отбор «где ходила эта машина», перенесённый на историю: у машины, стоявшей январь и
 * февраль, действующей строки в назначении нет — там мартовская (Р17: денормализация повторяет
 * **последнее** vehicle-изменение), — и вопрос «где она ходила» обязан задаваться отрезкам.
 *
 * Отрезок строки — от её даты до дня перед следующей строкой той же шкалы, а у последней конца нет
 * (Р24); срок — от `date_from` до `coalesce(date_to, date_from)`, где пустая дата окончания
 * читается однодневным сроком тем же правилом, что и везде. Пересечение двух полуинтервалов
 * записано без арифметики над днями: строка начинается не позже конца срока и кончается не раньше
 * его начала, то есть следующая строка приходит **позже** начала срока (`> date_from`, а не `>=`:
 * пришедшая в тот же день сменила бы машину ещё до первого рабочего дня).
 *
 * Срок берётся внутри подзапроса своим join'ом, а не колонкой снаружи, намеренно: из четырёх мест
 * применения деталей заказа нет в сводке над таблицей, и условие, сославшееся на них, развалило бы
 * ровно тот запрос, который обязан сходиться со списком.
 *
 * Дремлющие строки (заведённые за концом срока — Р13, Р24) пересечения не дают и заявку не находят:
 * они бумаги не касались и днями работы не были.
 */
export function vehicleWorkedByHistorySql(request: SQL, vehicleId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
      SELECT 1
        FROM ${vehicleRequestAssignmentChanges} awc
        JOIN ${specialEquipmentRequestDetails} awd ON awd.request_id = awc.request_id
       WHERE awc.request_id = ${request}
         AND awc.dimension = 'vehicle'
         AND awc.superseded_at IS NULL
         AND awc.vehicle_id = ${vehicleId}::uuid
         AND awc.effective_date <= coalesce(awd.date_to, awd.date_from)
         AND coalesce((SELECT min(awn.effective_date)
                         FROM ${vehicleRequestAssignmentChanges} awn
                        WHERE awn.request_id = awc.request_id
                          AND awn.dimension = 'vehicle'
                          AND awn.superseded_at IS NULL
                          AND awn.effective_date > awc.effective_date),
                      'infinity'::date) > awd.date_from)`;
}
