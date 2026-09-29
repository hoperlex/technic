import { sql } from 'drizzle-orm';
import {
  analyticsCountsAsFact,
  type AnalyticsQualityEntry,
  countsInWasteVolumeSum,
  formatWasteRequestNumber,
  isPricedRequestType,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
  usesContainerType,
  WASTE_TICKET_WORK_KINDS,
  wasteFactUnit,
} from '@technic/contracts';
import { db } from '../../db/client';
import type { AnalyticsAtom, AnalyticsFacts, AnalyticsFactsScope, AnalyticsRange } from './types';

/**
 * Waste-removal atoms for the analytics layer (plan `docs/analytics-summary-export-plan.md`, R13).
 *
 * This module answers "how much was removed and at what cost" exactly once: the Excel book and the
 * waste statistics tab both take their numbers here instead of counting their own (R14). The
 * closest relative is the waste history summary (`GET /waste-requests/history/summary`), and the
 * removed-quantity rule is inherited from it: **volume and weight never add up** (R17) — debris is
 * measured in cubic metres, scrap metal is accepted in tonnes, and there is no common "how much"
 * column with a unit in its caption (ADR 0067).
 *
 * Four decisions, each of which would otherwise produce a different number:
 *
 * 1. **The customer is always a construction object.** `waste_requests.object_id` is mandatory and
 *    waste requests never belong to a department, so `customerKind` is a constant here rather than
 *    the two-way split vehicle requests need.
 * 2. **REQUESTS are counted, not trucks** (R21, the customer's own words: "the number of trucks is
 *    the contractor's problem"). The atom has no truck column at all. `waste_request_vehicles` rows
 *    are read for two things only — the estimate of a request that is not done yet and the ordered
 *    volume of the statistics tab — and both take the same branch, so the ordered volume and its
 *    money always describe the same set of trucks.
 * 3. **"Removed" is decided by the request STATUS, not by the presence of a completion row**
 *    (waste stats three-volumes decision Z5). A request counts as removed — volume, weight, one
 *    removal, tickets — only while its status is a fact status ("done" / "completed",
 *    `analyticsCountsAsFact`). The rollback "done -> in progress" keeps the completion row so that
 *    re-closing does not ask for the same figures again; counting that row would report a removal
 *    the administrator has just withdrawn, while the money column (always status-based) already
 *    treated the request as not done. Volume, weight and the removal counter therefore move to the
 *    status together: switching only one of them would put a volume into one cell and zero removals
 *    into the next.
 *
 *    The ordered volume is never mixed into the removed one inside this layer: the atom carries
 *    `volumeOrderedM3` (not done yet) and `volumePlannedM3` (ordered, for every request) as separate
 *    fields, so "removed 620 m3" stays distinguishable from "ordered 620 m3". A container operation
 *    follows the same status rule for its own counter: it never has a completion row at all.
 * 4. **One atom per request, not per working day.** A waste request has a single attribution day
 *    (R11): the actual removal day, or the Moscow delivery day while there is none. That day is taken
 *    from the completion row regardless of status, so a rolled-back request stays in the same month
 *    and only stops being "removed". Spreading money over days (R28) is only needed where a request
 *    lives for weeks: mechanization and vehicle requests.
 */

/** Московские сутки: сервер живёт в UTC, а календарный день портала — МСК (`moscowDateKeyOf`). */
const MOSCOW = 'Europe/Moscow';

/**
 * Списки типов и статусов приходят в запрос ПАРАМЕТРАМИ, а не вписаны в его текст: единственное
 * место, где сказано «этот статус — факт» и «этот тип везёт», — контракты (`analyticsCountsAsFact`,
 * `wasteFactUnit`, `usesContainerType`, `isPricedRequestType`). Перепиши их словами внутри SQL, и
 * появится вторая копия правила, которая разойдётся с первой молча (правило одного места).
 */
const FACT_STATUSES = REQUEST_STATUSES.filter(analyticsCountsAsFact);
const REMOVAL_TYPES = REQUEST_TYPES.filter((t) => wasteFactUnit(t) !== null);
/**
 * Request types whose fact is measured in cubic metres — the only ones that have an ordered volume.
 * Exported because the statistics tab narrows the loader by exactly this list: a second copy of the
 * filter there would drift from this one the first time a new volume type appears.
 */
export const VOLUME_REQUEST_TYPES: RequestType[] = REQUEST_TYPES.filter(
  (t) => wasteFactUnit(t) === 'volume_m3',
);
const CONTAINER_OP_TYPES = REQUEST_TYPES.filter(usesContainerType);
const PRICED_TYPES = REQUEST_TYPES.filter(isPricedRequestType);
/**
 * Виды работ талона, которые складываются в объём (Р18 ADR 0114). Список считается из контракта
 * `countsInWasteVolumeSum` и уходит в запрос параметром — тем же приёмом и по той же причине, что
 * статусы и типы выше: написанное словами внутри SQL `work_kind <> 'idle'` стало бы вторым
 * определением правила, и разошлось бы оно молча — в ту сторону, где человек видит в карточке
 * одну сумму, а в статистике другую.
 */
const SUMMABLE_KINDS = WASTE_TICKET_WORK_KINDS.filter(countsInWasteVolumeSum);

/**
 * Строка ответа. Все поля атома необязательны, потому что последняя строка набора — не атом, а
 * качество (см. хвост запроса); `db.execute` требует от типа результата индексной сигнатуры,
 * поэтому псевдоним, а не `interface`.
 */
type WasteRow = {
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  customer_is_active: boolean | null;
  day: string | null;
  waste_type_id: string | null;
  waste_type_name: string | null;
  container_type_id: string | null;
  container_type_name: string | null;
  request_id: string | null;
  request_num: number | null;
  legacy_num_format: boolean | null;
  request_type: RequestType | null;
  request_status: RequestStatus | null;
  removals: number | null;
  container_ops: number | null;
  /** `numeric` драйвер отдаёт строкой — числом его делает `num`. */
  volume_m3: string | null;
  volume_ordered_m3: string | null;
  volume_tickets_m3: string | null;
  volume_tickets_unpriced_m3: string | null;
  volume_tickets_unconfirmed_m3: string | null;
  volume_planned_m3: string | null;
  money_planned: string | null;
  volume_planned_unpriced_m3: string | null;
  volume_fact_unpriced_m3: string | null;
  money_tickets: string | null;
  /**
   * `count(*)` — это `bigint`, и драйвер отдаёт его СТРОКОЙ, как и `numeric`. Тип назван честно
   * именно поэтому: объявленный `number` молча превратил бы сложение счётчиков в склейку текста
   * («0» + «1» = «01»), а заметить это можно только на живом ответе.
   */
  tickets_without_volume: string | number | null;
  tickets_unconfirmed: string | number | null;
  ticket_files_unread: string | number | null;
  ticket_files_without_tickets: string | number | null;
  weight_tons: string | null;
  money_fact: string | null;
  money_estimate: string | null;
  priced: boolean | null;
  /** Заполнено ровно на одной строке набора; у атомов пусто. */
  quality: AnalyticsQualityEntry[] | null;
};

/** `numeric` из драйвера: пустое значение здесь означает ноль — все поля атома суммируемые. */
function num(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Позиция строки детализации: «вид отхода · тип контейнера» (§3, лист 2).
 *
 * Ключ — не пара идентификаторов, а ТРОЙКА «семейство + вид отхода + тип контейнера», и третья
 * часть заведена не для красоты: у вывоза металлолома предмета нет вовсе (ADR 0067, CHECK
 * `waste_requests_metal_no_subject_check`), у контейнерной операции нет вида отхода, — и обе
 * пары идентификаторов вырождаются в «пусто · пусто». Без семейства лом, контейнерная операция и
 * вывоз с незаполненным справочником слиплись бы в одну строку с тремя разными подписями, а
 * группировка детализации взяла бы из них случайную.
 */
const FAMILY_LABELS = {
  removal: 'Без вида отхода',
  metal: 'Металлолом',
  ops: 'Контейнерная операция',
} as const;

function positionOf(row: WasteRow): { key: string; label: string } {
  const type = row.request_type!;
  const family = usesContainerType(type)
    ? 'ops'
    : wasteFactUnit(type) === 'weight_tons'
      ? 'metal'
      : 'removal';
  const key = `${family}|${row.waste_type_id ?? '-'}|${row.container_type_id ?? '-'}`;
  const parts = [row.waste_type_name ?? FAMILY_LABELS[family], row.container_type_name];
  return { key, label: parts.filter((part): part is string => Boolean(part)).join(' · ') };
}

/**
 * Вывоз мусора за период — одной выборкой (Р15).
 *
 * Запросов в цикле по объектам здесь нет и быть не может: период, статусы, удаление и день
 * отнесения живут условиями внутри, а качество приезжает последней строкой того же набора —
 * отдельной выборкой оно стало бы вторым обходом тех же заявок ради трёх чисел.
 */
export async function loadWasteFacts(
  range: AnalyticsRange,
  scope: AnalyticsFactsScope = {},
): Promise<AnalyticsFacts> {
  /*
   * СУЖЕНИЕ ВСТАЁТ УСЛОВИЕМ ВНУТРЬ ЗАПРОСА, а не отбором поверх загруженного набора: иначе экран
   * площадки читал бы заявки всей компании, чтобы выбросить чужие, и потолок атомов считался бы по
   * тому, чего человек не увидит. Книга зовёт загрузчик без сужения, и её текст запроса остаётся
   * прежним — обе вставки пусты (`sql.empty()`).
   *
   * Пустой список объектов и его отсутствие — РАЗНЫЕ вещи (см. `AnalyticsFactsScope`): `[]` даёт
   * заведомо ложное условие, `null`/`undefined` не даёт условия вовсе.
   */
  const objectFilter =
    scope.objectIds == null
      ? sql.empty()
      : sql` AND r.object_id = ANY(${sql.param([...scope.objectIds])}::uuid[])`;
  const typeFilter = scope.requestTypes
    ? sql` AND r.request_type::text = ANY(${sql.param([...scope.requestTypes])}::text[])`
    : sql.empty();
  const result = await db.execute<WasteRow>(sql`
WITH scope AS (
    /*
     * ДЕНЬ ОТНЕСЕНИЯ (Р11) — фактический день вывоза, а при его отсутствии календарный день
     * доставки по МСК. Пусто removed_on бывает у закрытий старше колонки (removed_on_source =
     * 'unknown', ADR 0114): backfill не делался сознательно — подстановка плановой даты выдала бы
     * предположение за факт, — и книга повторяет тот же выбор, сообщая о подмене на листе
     * «Качество». У незакрытой заявки факта нет вовсе, и день у неё тоже плановый.
     *
     * AT TIME ZONE обязателен и не украшение: сессии приложения живут в UTC, и с 00:00 до 03:00
     * МСК доставка уехала бы во вчерашний день — а по этому же дню идёт отбор периода, то есть
     * заявка первого числа выпала бы из месяца целиком.
     *
     * Отмена не считается нигде (Р10): ни количествами, ни деньгами. Мягко удалённые — тоже.
     */
    SELECT r.id,
           r.num,
           r.legacy_num_format,
           r.request_type::text                       AS request_type,
           r.status::text                             AS status,
           r.object_id,
           r.waste_type_id,
           r.container_type_id,
           r.amount,
           c.request_id IS NOT NULL                   AS is_closed,
           c.volume_m3                                AS fact_volume,
           c.weight_tons                              AS fact_weight,
           /*
            * Объём САМОЙ ЗАЯВКИ — и под своим именем: рядом уже стоит c.volume_m3 AS fact_volume,
            * и две колонки с одинаковым исходным именем, одна переименованная, другая нет, — это
            * заготовленная опечатка. Колонка integer и законно пуста: заявку заводят и без объёма.
            */
           r.volume_m3                                AS requested_volume,
           c.price_per_m3,
           c.total_cost,
           c.removed_on,
           coalesce(c.removed_on, (r.delivery_at AT TIME ZONE ${MOSCOW})::date) AS day,
           r.status::text = ANY(${sql.param(FACT_STATUSES)}::text[])       AS is_fact,
           r.request_type::text = ANY(${sql.param(REMOVAL_TYPES)}::text[]) AS is_removal,
           r.request_type::text = ANY(${sql.param(VOLUME_REQUEST_TYPES)}::text[]) AS is_volume_removal,
           r.request_type::text = ANY(${sql.param(CONTAINER_OP_TYPES)}::text[]) AS is_container_op,
           r.request_type::text = ANY(${sql.param(PRICED_TYPES)}::text[])  AS is_priced_type
      FROM waste_requests r
      LEFT JOIN waste_request_completions c ON c.request_id = r.id
     WHERE r.deleted_at IS NULL
       AND r.status <> 'cancelled'
       AND coalesce(c.removed_on, (r.delivery_at AT TIME ZONE ${MOSCOW})::date)
             BETWEEN ${range.from}::date AND ${range.to}::date${objectFilter}${typeFilter}
),
graded AS (
    /*
     * ДЕНЬГИ (Р9). Факт — сумма закрытия у заявки, чей статус контракт считает фактом. Оценка
     * незакрытой — одна-единственная, поэтому нижняя и верхняя у вывоза совпадают: вилка заведена
     * ради заказа ТС, где смены заполняют не всегда, а здесь второму способу счёта взяться неоткуда.
     *
     * Строки самосвалов побеждают waste_requests.amount: колонка считает «объём × цена» по одной
     * паре справочника, а строки описывают ТО, ЧЕМ И ПОЧЁМ реально договорились везти (ADR 0011),
     * и там, где они заведены, сумма заявки их не повторяет. Удалённые строки не в счёт — пометка
     * ровно для этого и заводилась.
     *
     * Цена у строки законно пуста (CHECK waste_request_vehicles_price_snapshot_check разрешает
     * пару NULL), а с ней пуста и сумма строки. Поэтому оценка по строкам считается, только когда
     * цена есть у ВСЕХ живых строк: sum() бесценную строку молча пропускает, и заявка с двумя
     * машинами оценилась бы по одной, оставшись «с ценой»; а падение на amount заявки подставило
     * бы ровно ту величину, которую строки должны были победить. Хотя бы одна строка без цены —
     * оценить заявку нечем, и она идёт в счётчик «без цены»: ноль в денежной клетке обязан
     * означать бесплатную работу и ничего больше.
     */
    SELECT s.*,
           CASE WHEN s.is_fact THEN s.total_cost END                            AS money_fact,
           CASE WHEN s.is_fact THEN NULL ELSE v.amount END                      AS money_estimate,
           /*
            * ЗАЯВКА БЕЗ ЦЕНЫ — это заявка, которую НЕ УДАЛОСЬ оценить, а не заявка без денег.
            * У металлолома и контейнерных операций денег нет ВОВСЕ и по построению: лом принимают
            * весом, а прайс задан в ₽/м³ (ADR 0067, CHECK weight_no_pricing), контейнерная
            * операция не тарифицируется (ADR 0019). Пометь их «без цены» — и счётчик, заведённый
            * ради вопроса «чего мы не знаем», начал бы отвечать на вопрос «что бесплатно», а
            * площадка с десятью законными вывозами лома выглядела бы хуже всех в книге.
            * Поэтому признак спрашивает контракт: тарифицируется тип или нет.
            */
           (NOT s.is_priced_type
            OR (CASE WHEN s.is_fact THEN s.total_cost
                     ELSE v.amount END) IS NOT NULL)                            AS priced,
           /*
            * "Has a ticket" for the quality row still means an ACCEPTED one (status = 'confirmed'):
            * the row answers "is the volume backed by a document a person accepted", and a machine
            * reading is not that yet (see the waste_tickets header). The ticket volume below is a
            * different question and counts unconfirmed readings too (ADR 0213).
            *
            * The flag comes from the same lateral join as the volume, not from an EXISTS of its own:
            * two reads of the request's tickets would drift apart the day the ticket rule changes in
            * one of them.
            */
           tk.confirmed_count > 0                                              AS has_ticket,
           tk.ticket_volume,
           tk.tickets_unread,
           tk.tickets_unconfirmed,
           tk.unconfirmed_volume,
           tf.files_unread,
           tf.files_without_tickets,
           v.ordered_volume,
           /*
            * ORDERED ("planned") VOLUME AND ITS MONEY — for every request of a volume type, closed
            * or not (waste stats three-volumes decision Z3). The ordered volume comes from the
            * truck rows or from the request itself; an old request that was filed without any
            * volume falls back to the removed volume of its completion.
            *
            * Both columns take the branch on ONE condition. The request amount is GENERATED from
            * waste_requests.volume_m3, so a request without an ordered volume has no amount either:
            * taking the volume from the completion and the money from the request would put cubic
            * metres into the planned column without their roubles. The fallback therefore moves the
            * money to the same completion (its total_cost).
            *
            * money_estimate above is left untouched and is not derived from these: the book reads
            * it as the estimate of requests that are not done yet, while this pair describes the
            * plan of every request.
            */
           CASE WHEN s.is_volume_removal
                THEN CASE WHEN v.ordered_volume IS NOT NULL THEN v.ordered_volume
                          ELSE s.fact_volume END
           END                                                                 AS planned_volume,
           CASE WHEN s.is_volume_removal
                THEN CASE WHEN v.ordered_volume IS NOT NULL THEN v.amount
                          ELSE s.total_cost END
           END                                                                 AS planned_money,
           /*
            * TICKET VOLUME THAT CANNOT BE PRICED (R5 of the stats plan). A value of its own and not a
            * conclusion from zero money: once atoms are summed, "there was no price" can no longer
            * be told from "there was nothing to price", and the cost cell could not choose between
            * a dash and a number.
            */
           CASE WHEN s.price_per_m3 IS NULL THEN coalesce(tk.ticket_volume, 0) ELSE 0 END
                                                                               AS ticket_unpriced,
           /*
            * TICKET VOLUME IN MONEY (R5): ticket volume × completion price — the price list snapshot
            * the request itself was priced with. NULL is legal: a completion may have no price (no
            * price list position for the pair, ADR 0046), and zero here would mean a free removal.
            */
           coalesce(tk.ticket_volume, 0) * s.price_per_m3                       AS money_tickets
      FROM scope s
      /* Оценка незакрытой заявки одним выражением: строк нет — сумма заявки, строки есть и все с
         ценой — их сумма, хоть одна без цены — оценки нет вовсе (NULL, а не ноль). */
      LEFT JOIN LATERAL (SELECT CASE
                                  WHEN count(*) = 0 THEN s.amount
                                  WHEN count(*) FILTER (WHERE wv.price_per_m3 IS NULL) = 0
                                    THEN sum(wv.amount)
                                END AS amount,
                                /*
                                 * ORDERED VOLUME COMES FROM THE SAME PLACE AS THE ESTIMATE.
                                 * Where truck rows exist they describe what was agreed to be
                                 * carried and at what price (ADR 0011), and the request amount
                                 * does not repeat them. Taking the volume from the request alone
                                 * would make the volume and the money of one request describe
                                 * different removals.
                                 *
                                 * The branch "rows exist but one has no price" is NOT repeated
                                 * here: for money it means "cannot be estimated" (NULL), while a
                                 * row volume is NOT NULL and always known — a request without an
                                 * estimate is still a request with an ordered volume.
                                 */
                                CASE
                                  WHEN count(*) = 0 THEN s.requested_volume
                                  ELSE sum(wv.volume_m3 * wv.vehicle_count)
                                END AS ordered_volume
                           FROM waste_request_vehicles wv
                          WHERE wv.request_id = s.id
                            AND wv.deleted_at IS NULL) v ON true
      /*
       * The request's tickets in one pass (ADR 0213). The ticket volume counts every ticket that is
       * not dismissed — accepted AND recognised-but-unreviewed: most of the paper sits unreviewed,
       * and a column of accepted tickets only read as "nothing was brought" when it was. The
       * unconfirmed share is counted beside it, so the portal can say how much of the figure is
       * still a machine reading. A dismissed ticket ("this is not a ticket") is out: a person
       * decided it carries no volume.
       *
       * An idle ticket stays out of the sum (R18 of ADR 0114): its volume means "there was no
       * removal", not "zero was removed"; the kinds come from the contract (SUMMABLE_KINDS).
       *
       * An unread volume does NOT become zero: sum() skips NULL by itself, and the neighbouring
       * counter says how many such tickets there are. Put a zero in and a site with one smudged
       * field would look under-delivered — the more so, the more carefully it collects paper.
       */
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE t.status = 'confirmed')    AS confirmed_count,
                                sum(t.volume_m3) FILTER (
                                  WHERE t.work_kind = ANY(${sql.param(SUMMABLE_KINDS)}::text[])
                                )                                               AS ticket_volume,
                                count(*) FILTER (
                                  WHERE t.work_kind = ANY(${sql.param(SUMMABLE_KINDS)}::text[])
                                    AND t.volume_m3 IS NULL
                                )                                               AS tickets_unread,
                                count(*) FILTER (
                                  WHERE t.work_kind = ANY(${sql.param(SUMMABLE_KINDS)}::text[])
                                    AND t.status = 'unconfirmed'
                                )                                               AS tickets_unconfirmed,
                                sum(t.volume_m3) FILTER (
                                  WHERE t.work_kind = ANY(${sql.param(SUMMABLE_KINDS)}::text[])
                                    AND t.status = 'unconfirmed'
                                )                                               AS unconfirmed_volume
                           FROM waste_tickets t
                          WHERE t.request_id = s.id
                            AND t.status <> 'dismissed') tk ON true
      /*
       * Ticket scans the ticket volume cannot contain (ADR 0213): a file the recognition could not
       * read (rejected or out of attempts) and a file it read without finding a single ticket.
       * Counted by FILES — how many tickets such a scan holds is exactly what is unknown.
       *
       * "No tickets found" asks for any ticket row of the file, dismissed ones included: a file
       * whose readings a person dismissed has been reviewed, and calling it unrecognised would send
       * people to look at it again. A file still in the queue is neither: it is not late yet. A
       * scan that never entered recognition (the module was off) has no row here and is not counted
       * either — it was never an attempt to read.
       */
      LEFT JOIN LATERAL (SELECT count(*) FILTER (
                                  WHERE f.status IN ('failed', 'unsupported')
                                )                                               AS files_unread,
                                count(*) FILTER (
                                  WHERE f.status = 'done'
                                    AND NOT EXISTS (SELECT 1
                                                      FROM waste_ticket_pages p
                                                      JOIN waste_tickets t ON t.page_id = p.id
                                                     WHERE p.file_id = f.file_id)
                                )                                               AS files_without_tickets
                           FROM waste_ticket_files f
                          WHERE f.request_id = s.id) tf ON true
),
atoms AS (
    SELECT o.id                                       AS customer_id,
           o.code                                     AS customer_code,
           o.name                                     AS customer_name,
           o.is_active                                AS customer_is_active,
           g.day::text                                AS day,
           g.waste_type_id,
           wt.name                                    AS waste_type_name,
           g.container_type_id,
           ct.name                                    AS container_type_name,
           g.id                                       AS request_id,
           g.num                                      AS request_num,
           g.legacy_num_format,
           g.request_type,
           g.status                                   AS request_status,
           /*
            * Both counters count REQUESTS (R21), container operations included: removing three
            * containers is one agreement and one trip, while containers_count answers another
            * question (how many units left the site) and lives in its own module.
            *
            * Both counters also count what HAPPENED, and "happened" is the fact status for both
            * (header, decision 3): a completion row alone is not a removal, because the rollback
            * "done -> in progress" keeps that row. Volume, weight and the tickets below
            * use the same condition, so the removal counter and its volume always agree in
            * neighbouring cells. A request that is only planned gives zero here and stays in the
            * book as an estimate.
            */
           CASE WHEN g.is_removal AND g.is_fact THEN 1 ELSE 0 END       AS removals,
           CASE WHEN g.is_container_op AND g.is_fact THEN 1 ELSE 0 END  AS container_ops,
           CASE WHEN g.is_fact THEN coalesce(g.fact_volume, 0) ELSE 0 END::text
                                                      AS volume_m3,
           /*
            * The ordered volume of a request that is not done yet, in a column of its own: it is
            * never mixed into the removed volume inside this layer. Zero once the request is done —
            * its ordered volume then answers an old question (how much was asked before the truck
            * came), and adding it to the removed one would count an under-delivered request twice.
            * The switch is the fact status, like everything above, so a rolled-back request
            * returns to "ordered".
            */
           CASE WHEN g.is_fact THEN 0 ELSE coalesce(g.ordered_volume, 0) END::text
                                                      AS volume_ordered_m3,
           /*
            * Tickets belong to removed requests only: a rolled-back request keeps its tickets, but
            * backing a removal that no longer counts would make the ticket column larger than the
            * removed one for no real reason. The counters of unconfirmed tickets and unrecognised
            * scans follow the same switch, so the portal never warns about paper of a request the
            * column does not include.
            */
           CASE WHEN g.is_fact THEN coalesce(g.ticket_volume, 0) ELSE 0 END::text
                                                      AS volume_tickets_m3,
           CASE WHEN g.is_fact THEN g.ticket_unpriced ELSE 0 END::text
                                                      AS volume_tickets_unpriced_m3,
           CASE WHEN g.is_fact THEN coalesce(g.money_tickets, 0) ELSE 0 END::text
                                                      AS money_tickets,
           CASE WHEN g.is_fact THEN coalesce(g.tickets_unread, 0) ELSE 0 END
                                                      AS tickets_without_volume,
           CASE WHEN g.is_fact THEN coalesce(g.tickets_unconfirmed, 0) ELSE 0 END
                                                      AS tickets_unconfirmed,
           CASE WHEN g.is_fact THEN coalesce(g.unconfirmed_volume, 0) ELSE 0 END::text
                                                      AS volume_tickets_unconfirmed_m3,
           CASE WHEN g.is_fact THEN coalesce(g.files_unread, 0) ELSE 0 END
                                                      AS ticket_files_unread,
           CASE WHEN g.is_fact THEN coalesce(g.files_without_tickets, 0) ELSE 0 END
                                                      AS ticket_files_without_tickets,
           /*
            * Planned volume and money of the statistics tab (see graded). The unpriced share is a
            * separate field and not a conclusion from zero money: after atoms are summed, "there
            * was no price" and "there was nothing to price" can no longer be told apart, and the
            * tab could not decide between a dash and a number.
            */
           coalesce(g.planned_volume, 0)::text        AS volume_planned_m3,
           coalesce(g.planned_money, 0)::text         AS money_planned,
           CASE WHEN g.planned_money IS NULL THEN coalesce(g.planned_volume, 0) ELSE 0 END::text
                                                      AS volume_planned_unpriced_m3,
           /*
            * Removed volume whose completion has no amount: the same dash rule for the main cost
            * of the statistics tab. A completion may legally be saved without a sum.
            */
           CASE WHEN g.is_volume_removal AND g.is_fact AND g.total_cost IS NULL
                THEN coalesce(g.fact_volume, 0) ELSE 0 END::text
                                                      AS volume_fact_unpriced_m3,
           CASE WHEN g.is_fact THEN coalesce(g.fact_weight, 0) ELSE 0 END::text
                                                      AS weight_tons,
           coalesce(g.money_fact, 0)::text            AS money_fact,
           coalesce(g.money_estimate, 0)::text        AS money_estimate,
           g.priced
      FROM graded g
      JOIN construction_objects o ON o.id = g.object_id
      LEFT JOIN waste_types wt     ON wt.id = g.waste_type_id
      LEFT JOIN container_types ct ON ct.id = g.container_type_id
),
quality AS (
    /* The "Data quality" sheet (R20): how far the numbers of this module can be trusted. */
    SELECT jsonb_build_array(
             jsonb_build_object(
               'key',   'waste.completions_without_removed_on',
               'label', 'Закрытий вывоза без фактической даты',
               'value', count(*) FILTER (WHERE g.is_closed AND g.removed_on IS NULL),
               'outOf', count(*) FILTER (WHERE g.is_closed),
               'note',  'Такие вывозы отнесены к дню доставки, а не к дню вывоза'),
             /*
              * The denominator is the same set of removals as the "Removals" column — requests of
              * a removal type in a fact status. Counting unfinished requests here would give a
              * "5 of 6" that matches no cell of the book, and a request that is not done has no
              * ticket by the order of work anyway.
              */
             jsonb_build_object(
               'key',   'waste.removals_without_ticket',
               'label', 'Вывозов без принятого талона',
               'value', count(*) FILTER (WHERE g.is_removal AND g.is_fact AND NOT g.has_ticket),
               'outOf', count(*) FILTER (WHERE g.is_removal AND g.is_fact),
               'note',  'Объём и вес не подтверждены документом'),
             jsonb_build_object(
               'key',   'waste.requests_without_price',
               'label', 'Заявок вывоза без цены',
               'value', count(*) FILTER (WHERE NOT g.priced),
               'outOf', count(*),
               'note',  'В деньги не вошли ни фактом, ни оценкой'),
             /*
              * Volume-type requests filed without an ordered volume (old data). The statistics tab
              * takes their plan from the completion; while they are not closed, their plan is zero.
              * The note avoids the tab's column name on purpose: the same row is printed on the
              * quality sheet of the book, which has no such column.
              */
             jsonb_build_object(
               'key',   'waste.requests_without_ordered_volume',
               'label', 'Заявок вывоза без заказанного объёма',
               'value', count(*) FILTER (WHERE g.is_volume_removal AND g.ordered_volume IS NULL),
               'outOf', count(*) FILTER (WHERE g.is_volume_removal),
               'note',  'Заказанный объём не указан: статистика вывоза берёт плановым объём закрытия, а у незакрытой заявки — ноль'),
             /*
              * A removal in a fact status without a completion counts as one removal with no volume,
              * weight or money (header, decision 3). Status changes cannot create such a request
              * any more ("done" requires a completion), but old data and a done container operation
              * whose type was later edited to a removal can: the edit checks units only when a
              * completion exists. The row is unconditional — zero is harmless, silence is not.
              */
             jsonb_build_object(
               'key',   'waste.done_without_completion',
               'label', 'Выполненных заявок вывоза без закрытия',
               'value', count(*) FILTER (WHERE g.is_removal AND g.is_fact AND NOT g.is_closed),
               'outOf', count(*) FILTER (WHERE g.is_removal AND g.is_fact),
               'note',  'Вывоз засчитан, но объёма, веса и суммы у него нет')
           ) AS entries
      FROM graded g
)
/*
 * Качество приезжает ХВОСТОВОЙ СТРОКОЙ того же набора, а не вторым запросом: Р15 требует одной
 * выборки на модуль, и три счётчика не повод обойти те же заявки ещё раз.
 *
 * LEFT JOIN atoms ON false — способ получить строку, где все колонки атома пусты, не выписывая
 * два десятка NULL:: с типами: типы колонок берутся из самого CTE, и добавленное завтра поле
 * атома не потребует править вторую ветвь объединения. Пустой набор атомов строку качества не
 * съедает — внешнее соединение оставляет её и без правой стороны, а лист «Качество» обязан
 * отвечать нулями и по периоду без единой заявки.
 */
SELECT a.*, NULL::jsonb AS quality FROM atoms a
UNION ALL
SELECT a.*, q.entries FROM quality q LEFT JOIN atoms a ON false`);

  const atoms: AnalyticsAtom[] = [];
  let quality: AnalyticsQualityEntry[] = [];
  for (const row of result.rows) {
    if (row.quality) {
      quality = row.quality;
      continue;
    }
    const position = positionOf(row);
    atoms.push({
      module: 'waste',
      customerKind: 'object',
      customerId: row.customer_id!,
      customerCode: row.customer_code!,
      customerName: row.customer_name!,
      customerIsActive: row.customer_is_active!,
      // Отдела-плательщика у вывоза не бывает: заказчик здесь сам объект (Р22 — про механизацию).
      payerDepartmentId: null,
      payerDepartmentName: null,
      date: row.day!,
      positionKey: position.key,
      positionLabel: position.label,
      // Позиция вывоза — справочная пара, а не машина парка: чем именно увезли, портал не знает.
      registrationNumber: null,
      requestId: row.request_id!,
      requestLabel: formatWasteRequestNumber(
        row.request_num!,
        row.request_type!,
        row.legacy_num_format!,
      ),
      requestStatus: row.request_status!,
      shifts: 0,
      // Плана у вывоза нет вовсе: срока, который можно было бы сравнить с фактом, у заявки нет —
      // есть день доставки, и он не план работы, а время подачи машины (Р7).
      planShifts: 0,
      trips: 0,
      volumeM3: num(row.volume_m3),
      volumeOrderedM3: num(row.volume_ordered_m3),
      volumeTicketsM3: num(row.volume_tickets_m3),
      volumeTicketsUnpricedM3: num(row.volume_tickets_unpriced_m3),
      volumeTicketsUnconfirmedM3: num(row.volume_tickets_unconfirmed_m3),
      volumePlannedM3: num(row.volume_planned_m3),
      moneyPlanned: num(row.money_planned),
      volumePlannedUnpricedM3: num(row.volume_planned_unpriced_m3),
      volumeFactUnpricedM3: num(row.volume_fact_unpriced_m3),
      ticketsWithoutVolume: Number(row.tickets_without_volume ?? 0),
      ticketsUnconfirmed: Number(row.tickets_unconfirmed ?? 0),
      ticketFilesUnread: Number(row.ticket_files_unread ?? 0),
      ticketFilesWithoutTickets: Number(row.ticket_files_without_tickets ?? 0),
      weightTons: num(row.weight_tons),
      engineHours: 0,
      mechHours: 0,
      mechDays: 0,
      removals: row.removals!,
      containerOps: row.container_ops!,
      relocations: 0,
      moneyFact: num(row.money_fact),
      // Оценка у вывоза одна (Р9), поэтому нижняя и верхняя — одно и то же число.
      moneyLow: num(row.money_estimate),
      moneyHigh: num(row.money_estimate),
      moneyTickets: num(row.money_tickets),
      priced: row.priced!,
    });
  }
  return { atoms, quality };
}
