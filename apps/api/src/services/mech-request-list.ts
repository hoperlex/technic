import { and, count, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  CLOSED_REQUEST_STATUSES,
  dateKeySpan,
  mechKindKey,
  type MechRequestHistoryQuery,
  type MechRequestHistorySummaryDto,
  type MechRequestListQuery,
  type MechRequestSummaryDto,
  parseMechRequesterFilter,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  mechRequests,
  users,
} from '../db/schema';
import { archiveWhere, placeObjectVisibilityWhere } from '../lib/access';
import { searchCondition } from '../lib/pagination';
import type { Principal } from '../auth/principal';

// Чтение реестра механизации: отбор списка, сводка над ним, журнал закрытых с итогом и подсказка
// видов (план `docs/mechanization-module-plan.md`, Р5, Р12, Р20, Э3). Все они обязаны считать
// область и присутствие ОДИНАКОВО — разойдись они, просрочка считалась бы по одному набору строк, а
// показывалась по другому, а итог журнала отвечал бы не про то, что человек видит в таблице, —
// поэтому и живут они рядом, а не в пяти обработчиках.

/**
 * ДЕЙСТВУЮЩАЯ АРЕНДА одним условием — то же, что `isMechRentalRunning` в контрактах и что частичный
 * индекс `mech_requests_active_rent_idx` в схеме (Р2). Все три части сразу: откат «Выполнена» → «В
 * работе» факт БЕРЕЖЁТ, и проверка по одному `actual_from` вернула бы возвращённую технику в
 * действующие аренды — во вкладку, в сводку и в расчёт просрочки.
 */
export const mechRunningRentalSql = sql`${mechRequests.status} = 'confirmed'
  AND ${mechRequests.actualFrom} is not null
  AND ${mechRequests.actualTo} is null`;

/** Область модуля — одна ось: площадка эксплуатации (Р10, Р17). */
export function mechScopeWhere(p: Principal): SQL | undefined {
  return placeObjectVisibilityWhere(p, mechRequests.objectId);
}

/**
 * Поля отбора, общие списку и журналу (Р20, Э3): площадка, заявитель, вид, арендодатель, номер,
 * период и поиск. Строку в журнале ищут теми же словами, что и в работающем списке, — разойдись
 * эти два места, одна и та же заявка находилась бы до закрытия и терялась после.
 *
 * Один набор условий на два отбора, а не два похожих: у списка и журнала расходятся ровно те
 * фильтры, которые спрашивают про состояние (`status`, `rental`, `overdue`, `archive`), и вынесены
 * они наружу именно поэтому.
 */
type MechCommonFilters = Pick<
  MechRequestListQuery,
  'placeObjectId' | 'requester' | 'kind' | 'lessorId' | 'num' | 'periodFrom' | 'periodTo' | 'search'
>;

function mechCommonFilters(q: MechCommonFilters): (SQL | undefined)[] {
  const requester = q.requester ? parseMechRequesterFilter(q.requester) : null;
  return [
    // Площадка и заявитель — два независимых фильтра над одной колонкой (Р20). Условие
    // заявителя-площадки это ПАРА: без `department_id IS NULL` фильтр вернул бы и заявку отдела,
    // заведённую на той же площадке, — то есть отнёс бы её расходы не на того.
    q.placeObjectId ? eq(mechRequests.objectId, q.placeObjectId) : undefined,
    requester?.kind === 'object'
      ? and(eq(mechRequests.objectId, requester.id), isNull(mechRequests.departmentId))
      : undefined,
    requester?.kind === 'department' ? eq(mechRequests.departmentId, requester.id) : undefined,
    // Вид сравнивается по нормализованному ключу той же формулой, что у генерируемой колонки (Р5):
    // иначе «Виброплита» и «виброплита» были бы разными позициями фильтра.
    q.kind ? eq(mechRequests.kindKey, mechKindKey(q.kind)) : undefined,
    q.lessorId ? eq(mechRequests.lessorId, q.lessorId) : undefined,
    q.num ? eq(mechRequests.num, q.num) : undefined,
    // Период — окно вопроса «что стояло на площадке в эти дни», поэтому ПЕРЕСЕЧЕНИЕ сроков, а не
    // попадание границ: аренда с 01.09 по 30.09 обязана найтись запросом про середину сентября.
    // В журнале спрашивается тот же плановый срок, что и в списке: у отменённой заявки фактических
    // дат нет вовсе, и отбор по ним потерял бы половину журнала молча.
    q.periodFrom ? gte(mechRequests.plannedTo, q.periodFrom) : undefined,
    q.periodTo ? lte(mechRequests.plannedFrom, q.periodTo) : undefined,
    searchCondition(q.search, [
      mechRequests.kindName,
      mechRequests.comment,
      mechRequests.responsibleName,
      constructionObjects.name,
      constructionObjects.code,
    ]),
  ];
}

/**
 * Отбор списка. «Сегодня» приходит параметром и вычисляется один раз на запрос по московскому
 * календарю (Р12): сервер живёт в UTC, а человек нет, и с 00:00 до 03:00 МСК эти два календаря
 * показывают разные дни — посчитай день дважды, и часть строк отобралась бы по вчерашнему.
 */
export function mechListWhere(
  p: Principal,
  q: MechRequestListQuery,
  today: string,
): SQL | undefined {
  return and(
    // Архив (ADR 0070): без права `archive.read` любое значение параметра означает «без архива» —
    // не 403 (Р15): подобранный в адресной строке параметр не должен ни отдавать чужое, ни
    // отвечать «такое бывает».
    archiveWhere(p, q.archive, mechRequests.deletedAt),
    mechScopeWhere(p),
    q.status ? eq(mechRequests.status, q.status) : undefined,
    ...mechCommonFilters(q),
    // «Параметра нет» и «выбрано „нет“» — разные вопросы к списку (`booleanFlagSchema`), поэтому
    // ветвление по `undefined`, а не по истинности: `rental=false` означает «всё, кроме
    // действующих аренд», и молча приравнять его к «не фильтровать» значило бы отдать список, в
    // котором отбор не сработал, — а по нему видно только то, что строк много.
    q.rental === undefined
      ? undefined
      : q.rental
        ? mechRunningRentalSql
        : sql`NOT (${mechRunningRentalSql})`,
    // Просрочка — производная, а не колонка: хранимый признак пришлось бы кому-то переводить, и он
    // разошёлся бы с датой в первую же ночь. Отрицание считается по всему условию целиком: «не
    // просрочено» это и вернувшаяся техника, и та, у которой срок ещё не вышел.
    q.overdue === undefined
      ? undefined
      : q.overdue
        ? and(mechRunningRentalSql, sql`${mechRequests.plannedTo} < ${today}::date`)
        : sql`NOT (${mechRunningRentalSql} AND ${mechRequests.plannedTo} < ${today}::date)`,
  );
}

/** Столбцы сортировки — ключ совпадает с ключом колонки таблицы (`MECH_REQUEST_SORT_FIELDS`). */
export const mechListSortColumns = {
  num: mechRequests.num,
  // Заявитель выводится, а не хранится (Р20): отдел, если он заполнен, иначе площадка. Сервер
  // сортирует по выведенному имени — иначе колонка экрана и порядок строк разошлись бы.
  requesterName: sql`coalesce(${departments.name}, ${constructionObjects.name})`,
  objectName: constructionObjects.name,
  kindName: mechRequests.kindName,
  plannedFrom: mechRequests.plannedFrom,
  plannedTo: mechRequests.plannedTo,
  status: mechRequests.status,
  lessorName: counterparties.name,
  rate: mechRequests.rate,
  responsibleName: mechRequests.responsibleName,
  comment: mechRequests.comment,
  createdByName: users.fullName,
  createdAt: mechRequests.createdAt,
  // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили — им архив и открывают.
  deletedAt: mechRequests.deletedAt,
};

// ── Журнал закрытых: вкладка «История» (§7 п. 3, Э3) ──

/**
 * Условия журнала. Область — **та же, что у списка** (`mechScopeWhere`): журнал не второй способ
 * читать заявки, а тот же реестр с другого конца, и площадка, увидевшая в нём чужую аренду,
 * означала бы, что область модуля держится в одном месте из двух.
 *
 * Удалённых в журнале нет вовсе: снесённая заявка живёт вкладкой «Архив» (ADR 0070), а журнал
 * отвечает про состоявшееся — параметра `archive` у него поэтому нет (ровно как у вывоза,
 * ADR 0135).
 *
 * Статусы — закрытые (`CLOSED_REQUEST_STATUSES`, «Выполнена» и «Отменена»). Перечень общий с
 * заказом техники и с барьером правки (`mechEditScope`), а не свой: у механизации «Завершена» не
 * бывает вовсе (`status <> 'completed'` в базе), и закрытыми у неё являются ровно эти два.
 * Открытый статус журнал ОТКЛОНЯЕТ — молчаливое расширение до обоих отдало бы выдачу, в которой
 * отбор не сработал (`assertMechHistoryStatus` в маршрутах).
 */
export function mechHistoryWhere(p: Principal, q: MechRequestHistoryQuery): SQL | undefined {
  return and(
    isNull(mechRequests.deletedAt),
    inArray(mechRequests.status, q.status ? [q.status] : [...CLOSED_REQUEST_STATUSES]),
    mechScopeWhere(p),
    ...mechCommonFilters(q),
  );
}

/**
 * Столбцы сортировки журнала: столбцы списка плюс факт аренды — те четыре, ради которых журнал и
 * открывают. Ключи совпадают с `MECH_HISTORY_SORT_FIELDS` в контрактах.
 */
export const mechHistorySortColumns = {
  ...mechListSortColumns,
  actualFrom: mechRequests.actualFrom,
  actualTo: mechRequests.actualTo,
  actualUnits: mechRequests.actualUnits,
  finalCost: mechRequests.finalCost,
};

/**
 * Итог журнала за выбранные фильтры (Э3). Считается по ТЕМ ЖЕ условиям, что и сам журнал: итог,
 * отвечающий не про то, что человек видит в таблице, вводит в заблуждение вернее, чем его
 * отсутствие.
 *
 * Три числа держатся на решениях плана, а не на удобстве запроса:
 *
 * 1. **часы и смены порознь**: ставка задаётся за час либо за смену (Р7), и `sum(actual_units)`
 *    одним числом отдало бы «120», которое не значит ничего. Отсюда два `FILTER` по `rate_unit`;
 * 2. **арендой была только выданная заявка**: `actual_from IS NOT NULL`. Отменённая до подачи
 *    закрыта (входит в `closed` и `cancelled`), но арендой не была, и в `rentals` ей не место;
 * 3. **сумма — строкой**: `numeric(14,2)` складывает база точно, а перевод в число с плавающей
 *    точкой по дороге к экрану даёт лишние знаки на ровном месте.
 */
export async function loadMechHistorySummary(
  p: Principal,
  q: MechRequestHistoryQuery,
): Promise<MechRequestHistorySummaryDto> {
  const where = mechHistoryWhere(p, q);
  const [totals] = await db
    .select({
      closed: count(),
      rentals: sql<string>`count(*) FILTER (WHERE ${mechRequests.actualFrom} is not null)`,
      cancelled: sql<string>`count(*) FILTER (WHERE ${mechRequests.status} = 'cancelled')`,
      hours: sql<string>`coalesce(
        sum(${mechRequests.actualUnits}) FILTER (WHERE ${mechRequests.rateUnit} = 'hour'), 0)`,
      shifts: sql<string>`coalesce(
        sum(${mechRequests.actualUnits}) FILTER (WHERE ${mechRequests.rateUnit} = 'shift'), 0)`,
      // Приведение к `numeric(20,2)` — ради ДВУХ знаков в ответе всегда: пустой отбор иначе отдал
      // бы «0» там, где соседняя строка отдаёт «9600.00», и портал показал бы две разные валюты.
      // Ширина взята с запасом от колонки (`numeric(14,2)`): сумма тысяч заявок в саму колонку не
      // помещается, и приведение к её точности упало бы переполнением на большом журнале.
      cost: sql<string>`coalesce(sum(${mechRequests.finalCost}), 0)::numeric(20,2)::text`,
    })
    .from(mechRequests)
    // Площадка присоединяется и здесь: по её наименованию и коду идёт поиск. Внутреннее соединение
    // строк не размножает — площадка у заявки одна и есть всегда (Р17).
    .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
    .where(where);

  return {
    closed: Number(totals?.closed ?? 0),
    rentals: Number(totals?.rentals ?? 0),
    cancelled: Number(totals?.cancelled ?? 0),
    days: await loadMechHistoryDays(where),
    hours: Number(totals?.hours ?? 0),
    shifts: Number(totals?.shifts ?? 0),
    cost: totals?.cost ?? '0.00',
  };
}

/**
 * Сумма календарных дней аренды — **готовой функцией `dateKeySpan`**, а не разностью дат в SQL.
 *
 * Считать день умеет ровно одно место в проекте, и оно же считает «осталось дней» в списке
 * (`mechDaysLeft`) и срок в карточке: аренда «с 1-го по 1-е» — это ОДИН день, а не ноль, и второй
 * реализации этого правила быть не должно — она разошлась бы с первой на включительности.
 *
 * Чтобы функция получила даты, а ответ остался ограниченным по объёму, строки группируются по паре
 * «выдана — возвращена»: групп столько, сколько в отборе различных сроков аренды, а не сколько
 * заявок, и полугодовой журнал не приезжает в память построчно.
 *
 * Отбор `actual_to IS NOT NULL` — это ровно завершённые аренды: у отменённой факта нет вовсе
 * (`cancelled_check` не даёт ей даже выдачи), а «выдана, но не возвращена» в журнал не попадает —
 * такая заявка ещё в работе.
 */
async function loadMechHistoryDays(where: SQL | undefined): Promise<number> {
  const spans = await db
    .select({
      from: mechRequests.actualFrom,
      to: mechRequests.actualTo,
      rows: count(),
    })
    .from(mechRequests)
    .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
    .where(and(where, isNotNull(mechRequests.actualTo)))
    .groupBy(mechRequests.actualFrom, mechRequests.actualTo);
  return spans.reduce(
    (sum, span) => sum + dateKeySpan(span.from!, span.to!) * Number(span.rows),
    0,
  );
}

/**
 * Сводка над списком (§7). Четыре числа, и все четыре про действие, а не про статус: «не
 * обработано» ждёт офиса, «ждут подачи» ждут арендодателя, «в аренде» стоит денег каждый день,
 * «просрочено» стоит денег и требует звонка.
 *
 * Из фильтров учитывается только площадка: фильтр по статусу свёл бы сводку к самой себе, а по
 * номеру — к одной заявке. Удалённые в счёт не идут — их нет и в списке.
 */
export async function loadMechSummary(
  p: Principal,
  placeObjectId: string | undefined,
  today: string,
): Promise<MechRequestSummaryDto> {
  const [row] = await db
    .select({
      pending: sql<string>`count(*) FILTER (WHERE ${mechRequests.status} = 'new')`,
      awaitingIssue: sql<string>`count(*) FILTER (
        WHERE ${mechRequests.status} = 'confirmed' AND ${mechRequests.actualFrom} is null)`,
      rental: sql<string>`count(*) FILTER (WHERE ${mechRunningRentalSql})`,
      overdue: sql<string>`count(*) FILTER (
        WHERE ${mechRunningRentalSql} AND ${mechRequests.plannedTo} < ${today}::date)`,
    })
    .from(mechRequests)
    .where(
      and(
        isNull(mechRequests.deletedAt),
        mechScopeWhere(p),
        placeObjectId ? eq(mechRequests.objectId, placeObjectId) : undefined,
      ),
    );
  return {
    pending: Number(row?.pending ?? 0),
    awaitingIssue: Number(row?.awaitingIssue ?? 0),
    rental: Number(row?.rental ?? 0),
    overdue: Number(row?.overdue ?? 0),
  };
}

/** Сколько написаний вида предлагать: подсказка, а не справочник — длинный список её обесценивает. */
const KIND_SUGGESTIONS_LIMIT = 20;

/**
 * Подсказка ранее вводившихся видов (Р5). Строится **по той же области**, что и список заявок, и
 * без сквозных счётчиков: иначе площадка читала бы по подсказке, что арендуют соседние объекты.
 *
 * Порядок — частота внутри собственной области, поэтому наружу идёт список строк, а не набор с
 * числами. Группировка по нормализованному ключу, а показывается последнее написание: «виброплита»
 * и «Виброплита» — одна позиция, и предлагать человеку обе значило бы своими руками плодить тот
 * разброс, ради которого подсказка и заведена.
 *
 * Ввод сужает подсказку вхождением, но сравнивается тоже по ключу — иначе набранное с заглавной не
 * нашло бы собственную позицию.
 */
export async function loadMechKinds(p: Principal, search: string | undefined): Promise<string[]> {
  const key = search ? mechKindKey(search) : '';
  const rows = await db
    .select({
      // Ключ группы человеку не показывается — он в нижнем регистре; наружу идёт последнее
      // введённое написание.
      kindName: sql<string>`(array_agg(${mechRequests.kindName} ORDER BY ${mechRequests.createdAt} DESC))[1]`,
    })
    .from(mechRequests)
    .where(
      and(
        isNull(mechRequests.deletedAt),
        mechScopeWhere(p),
        key ? sql`${mechRequests.kindKey} LIKE ${`%${key}%`}` : undefined,
      ),
    )
    .groupBy(mechRequests.kindKey)
    .orderBy(sql`count(*) DESC`, sql`max(${mechRequests.createdAt}) DESC`)
    .limit(KIND_SUGGESTIONS_LIMIT);
  return rows.map((row) => row.kindName);
}
