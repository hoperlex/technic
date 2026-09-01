import { and, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  mechKindKey,
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

// Чтение реестра механизации: отбор списка, сводка над ним и подсказка видов (план
// `docs/mechanization-module-plan.md`, Р5, Р12, Р20). Все трое обязаны считать область и присутствие
// ОДИНАКОВО — разойдись они, просрочка считалась бы по одному набору строк, а показывалась по
// другому, — поэтому и живут они рядом, а не в трёх обработчиках.

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
 * Отбор списка. «Сегодня» приходит параметром и вычисляется один раз на запрос по московскому
 * календарю (Р12): сервер живёт в UTC, а человек нет, и с 00:00 до 03:00 МСК эти два календаря
 * показывают разные дни — посчитай день дважды, и часть строк отобралась бы по вчерашнему.
 */
export function mechListWhere(
  p: Principal,
  q: MechRequestListQuery,
  today: string,
): SQL | undefined {
  const requester = q.requester ? parseMechRequesterFilter(q.requester) : null;
  return and(
    // Архив (ADR 0070): без права `archive.read` любое значение параметра означает «без архива» —
    // не 403 (Р15): подобранный в адресной строке параметр не должен ни отдавать чужое, ни
    // отвечать «такое бывает».
    archiveWhere(p, q.archive, mechRequests.deletedAt),
    mechScopeWhere(p),
    q.status ? eq(mechRequests.status, q.status) : undefined,
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
    q.periodFrom ? gte(mechRequests.plannedTo, q.periodFrom) : undefined,
    q.periodTo ? lte(mechRequests.plannedFrom, q.periodTo) : undefined,
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
    searchCondition(q.search, [
      mechRequests.kindName,
      mechRequests.comment,
      mechRequests.responsibleName,
      constructionObjects.name,
      constructionObjects.code,
    ]),
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
