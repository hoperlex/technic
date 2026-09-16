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
 * Атомы вывоза мусора для сводной аналитики (план `docs/analytics-summary-export-plan.md`, Р13).
 *
 * Модуль отвечает на «сколько вывезли и за сколько» ровно один раз: и книга, и будущий экран
 * берут числа здесь, а не считают свои (Р14). Ближайший родственник — итог журнала вывоза
 * (`GET /waste-requests/history/summary`), и правило вывезенного унаследовано от него целиком:
 * **объём и вес не складываются** (Р17) — мусор меряют кубами, лом принимают тоннами, и общей
 * колонки «сколько» с единицей в подписи здесь нет (ADR 0067).
 *
 * Четыре решения, каждое из которых иначе даёт другое число:
 *
 * 1. **Заказчик — всегда объект.** `waste_requests.object_id` обязателен, отделов у вывоза не
 *    бывает вовсе, поэтому `customerKind` здесь константа, а не разбор двух случаев, как у
 *    заказа ТС.
 * 2. **Считаем ЗАЯВКИ, а не самосвалы** (Р21, дословное решение заказчика: «количество машин —
 *    это проблема контрагента»). Колонки машин в атоме нет вовсе, и строки
 *    `waste_request_vehicles` читаются только ради денег незакрытой заявки.
 * 3. **Количество считает СОСТОЯВШЕЕСЯ, а не заказанное; оценкой бывают лишь деньги.** У
 *    незакрытой заявки нет ни объёма (`volumeM3 = 0`), ни самого вывоза (`removals = 0`): и то и
 *    другое берётся у закрытия, а заявленный объём и плановый день — это план (ADR 0035). Поставь сюда заявленный
 *    объём — и «вывезли 620 м³» перестало бы отличаться от «заказали 620 м³» ровно там, где это
 *    важнее всего. Посчитай вывозом плановый день — и заявка с доставкой 30.08, закрытая 02.09,
 *    окажется вывозом августа в книге, напечатанной 31.08, и вывозом сентября во всякой
 *    следующей: два соседних отчёта дадут два вывоза на один, и ни один из них не соврёт
 *    заметно. Деньги-оценка у незакрытой заявки при этом остаются — атом никуда не девается,
 *    нулём становится только счётчик количества.
 *
 *    Контейнерная операция считается тем же правилом, но признак у неё ДРУГОЙ, потому что
 *    предъявлять ей нечего: факта вывезенного у неё нет вовсе (`wasteFactUnit` пуст, сервер
 *    отвечает «вывезенное предъявляют только заявки на вывоз»), строки закрытия не бывает
 *    никогда, и «сделали» у неё означает статус-факт. Спроси у неё закрытие — и колонка
 *    «Конт. опер.» обнулилась бы целиком; спроси у вывоза статус вместо закрытия — и вывоз с
 *    закрытием, но откаченным статусом дал бы объём в одной клетке и ноль вывозов в соседней.
 * 4. **Атом на заявку, а не на день работы.** У вывоза день отнесения один на всю заявку (Р11),
 *    поэтому деньги раскладывать не по чему — заявка целиком лежит в своём дне. Раскладка по
 *    дням (Р28) нужна там, где заявка живёт неделями: у механизации и у заказа ТС.
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
  volume_confirmed_m3: string | null;
  volume_confirmed_unpriced_m3: string | null;
  money_confirmed: string | null;
  /**
   * `count(*)` — это `bigint`, и драйвер отдаёт его СТРОКОЙ, как и `numeric`. Тип назван честно
   * именно поэтому: объявленный `number` молча превратил бы сложение счётчиков в склейку текста
   * («0» + «1» = «01»), а заметить это можно только на живом ответе.
   */
  tickets_without_volume: string | number | null;
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
            * Принятый талон — подтверждённый (status = 'confirmed'): распознанное и неразобранное
            * остаётся предложением, и объём им не подтверждён (см. шапку waste_tickets).
            *
            * Признак считается из того же бокового соединения, что и сумма объёма, а не своим
            * EXISTS: два обращения к талонам заявки разошлись бы ровно в тот день, когда правило
            * «какой талон принят» поменяется в одном месте из двух.
            */
           tk.confirmed_count > 0                                              AS has_ticket,
           tk.confirmed_volume,
           tk.tickets_unread,
           v.ordered_volume,
           /*
            * ПОДТВЕРЖДЁННЫЙ ОБЪЁМ, КОТОРЫЙ НЕЧЕМ ОЦЕНИТЬ (Р5). Отдельная величина, а не вывод из
            * нулевых денег: сложив атомы, свёртка уже не отличит «цены не было» от «подтверждать
            * было нечего», и прочерк в стоимости ставить стало бы не из чего.
            */
           CASE WHEN s.price_per_m3 IS NULL THEN coalesce(tk.confirmed_volume, 0) ELSE 0 END
                                                                               AS confirmed_unpriced,
           /*
            * ПОДТВЕРЖДЁННОЕ В ДЕНЬГАХ (план статистики, Р5): объём талонов × цена закрытия —
            * снимок прайса, которым посчитана сама заявка. NULL законен: цена у закрытия
            * необязательна (прайса на пару могло не быть, ADR 0046), и тогда подтверждённому
            * объёму нечем назначить цену — ноль здесь означал бы бесплатный вывоз.
            */
           coalesce(tk.confirmed_volume, 0) * s.price_per_m3                    AS money_confirmed
      FROM scope s
      /* Оценка незакрытой заявки одним выражением: строк нет — сумма заявки, строки есть и все с
         ценой — их сумма, хоть одна без цены — оценки нет вовсе (NULL, а не ноль). */
      LEFT JOIN LATERAL (SELECT CASE
                                  WHEN count(*) = 0 THEN s.amount
                                  WHEN count(*) FILTER (WHERE wv.price_per_m3 IS NULL) = 0
                                    THEN sum(wv.amount)
                                END AS amount,
                                /*
                                 * ЗАКАЗАННЫЙ ОБЪЁМ — ИЗ ТОГО ЖЕ МЕСТА, ЧТО И ДЕНЬГИ-ОЦЕНКА (план
                                 * статистики, Р3). Там, где строки самосвалов заведены, они и
                                 * описывают, чем и почём договорились везти (ADR 0011), а сумма
                                 * заявки их не повторяет. Возьми объём только у заявки — и на
                                 * заявке со строками колонка объёма и колонка денег считали бы
                                 * разное, то есть ровно ту беду, ради которой Р3 и принято.
                                 *
                                 * Ветвь «строки есть, но хотя бы одна без цены» здесь НЕ
                                 * повторяется: у денег она означает «оценить нечем» (NULL), а
                                 * объём у строки NOT NULL и известен всегда — заявка без оценки
                                 * остаётся заявкой с заказанным объёмом.
                                 */
                                CASE
                                  WHEN count(*) = 0 THEN s.requested_volume
                                  ELSE sum(wv.volume_m3 * wv.vehicle_count)
                                END AS ordered_volume
                           FROM waste_request_vehicles wv
                          WHERE wv.request_id = s.id
                            AND wv.deleted_at IS NULL) v ON true
      /*
       * Талоны заявки одним проходом: сколько принято, сколько кубов они предъявляют и у скольких
       * объём не прочитан. Талон простоя в сумму не идёт (Р18 ADR 0114) — его объём означает «вывоза
       * не было», а не «вывезли ноль»; виды приходят параметром из контракта (SUMMABLE_KINDS).
       *
       * Непрочитанный объём НЕ становится нулём: sum() пропускает NULL сам, а сколько таких талонов —
       * считает соседний счётчик. Подставь ноль — и площадка с одной смазанной графой выглядела бы
       * недовывезшей, причём тем сильнее, чем аккуратнее она собирает бумагу.
       */
      LEFT JOIN LATERAL (SELECT count(*)                                        AS confirmed_count,
                                sum(t.volume_m3) FILTER (
                                  WHERE t.work_kind = ANY(${sql.param(SUMMABLE_KINDS)}::text[])
                                )                                               AS confirmed_volume,
                                count(*) FILTER (
                                  WHERE t.work_kind = ANY(${sql.param(SUMMABLE_KINDS)}::text[])
                                    AND t.volume_m3 IS NULL
                                )                                               AS tickets_unread
                           FROM waste_tickets t
                          WHERE t.request_id = s.id
                            AND t.status = 'confirmed') tk ON true
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
            * Счётчик считает ЗАЯВКИ (Р21), в том числе у контейнерных операций: заявка на снятие
            * трёх контейнеров — одна договорённость и один выезд, а containers_count отвечает на
            * другой вопрос (сколько единиц погашено на площадке) и живёт в своём модуле.
            *
            * Оба счётчика считают СОСТОЯВШЕЕСЯ: колонка отвечает на «сколько сделали», а не
            * «сколько заказали». У вывоза это закрытие — оно же источник объёма и дня отнесения,
            * поэтому количество и объём в соседних клетках сходятся всегда. У контейнерной
            * операции закрытия не бывает по построению (предъявлять ей нечего), и «сделали» у неё
            * означает статус-факт. Заявка, чей день ещё только запланирован, даёт по своему
            * счётчику ноль и остаётся в книге деньгами-оценкой.
            */
           CASE WHEN g.is_removal AND g.is_closed THEN 1 ELSE 0 END     AS removals,
           CASE WHEN g.is_container_op AND g.is_fact THEN 1 ELSE 0 END  AS container_ops,
           coalesce(g.fact_volume, 0)::text           AS volume_m3,
           /*
            * Заказанное идёт СВОЕЙ колонкой и никогда не смешивается с вывезенным внутри слоя
            * (см. решение 3 в шапке файла). Кто их складывает — складывает осознанно и подписывает
            * обе доли; здесь они различимы всегда.
            */
           /*
            * Обнуляется у ЗАКРЫТОЙ заявки: её заказанный объём отвечает на прошлый вопрос —
            * сколько просили, прежде чем приехала машина. Сложи его с вывезенным — и заявка,
            * закрытая недовозом, посчиталась бы дважды.
            */
           CASE WHEN g.is_closed THEN 0 ELSE coalesce(g.ordered_volume, 0) END::text
                                                      AS volume_ordered_m3,
           coalesce(g.confirmed_volume, 0)::text      AS volume_confirmed_m3,
           g.confirmed_unpriced::text                 AS volume_confirmed_unpriced_m3,
           coalesce(g.money_confirmed, 0)::text       AS money_confirmed,
           coalesce(g.tickets_unread, 0)              AS tickets_without_volume,
           coalesce(g.fact_weight, 0)::text           AS weight_tons,
           coalesce(g.money_fact, 0)::text            AS money_fact,
           coalesce(g.money_estimate, 0)::text        AS money_estimate,
           g.priced
      FROM graded g
      JOIN construction_objects o ON o.id = g.object_id
      LEFT JOIN waste_types wt     ON wt.id = g.waste_type_id
      LEFT JOIN container_types ct ON ct.id = g.container_type_id
),
quality AS (
    /* Лист «Качество данных» (Р20): три числа о том, насколько цифрам модуля можно верить. */
    SELECT jsonb_build_array(
             jsonb_build_object(
               'key',   'waste.completions_without_removed_on',
               'label', 'Закрытий вывоза без фактической даты',
               'value', count(*) FILTER (WHERE g.is_closed AND g.removed_on IS NULL),
               'outOf', count(*) FILTER (WHERE g.is_closed),
               'note',  'Такие вывозы отнесены к дню доставки, а не к дню вывоза'),
             /*
              * Знаменатель — те же состоявшиеся вывозы, что стоят в колонке «Вывозов»: считай
              * здесь и незакрытые заявки, и «5 из 6» не сошлось бы ни с одной клеткой книги, а
              * талона у заявки, которую ещё не закрыли, не бывает и по порядку работы.
              */
             jsonb_build_object(
               'key',   'waste.removals_without_ticket',
               'label', 'Вывозов без принятого талона',
               'value', count(*) FILTER (WHERE g.is_removal AND g.is_closed AND NOT g.has_ticket),
               'outOf', count(*) FILTER (WHERE g.is_removal AND g.is_closed),
               'note',  'Объём и вес не подтверждены документом'),
             jsonb_build_object(
               'key',   'waste.requests_without_price',
               'label', 'Заявок вывоза без цены',
               'value', count(*) FILTER (WHERE NOT g.priced),
               'outOf', count(*),
               'note',  'В деньги не вошли ни фактом, ни оценкой')
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
      volumeConfirmedM3: num(row.volume_confirmed_m3),
      volumeConfirmedUnpricedM3: num(row.volume_confirmed_unpriced_m3),
      ticketsWithoutVolume: Number(row.tickets_without_volume ?? 0),
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
      moneyConfirmed: num(row.money_confirmed),
      priced: row.priced!,
    });
  }
  return { atoms, quality };
}
