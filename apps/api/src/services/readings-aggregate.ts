import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import {
  type ReadingMonthRow,
  type ReadingTotals,
  vehicleLabel,
  type VehicleOwnership,
  type VehicleReadingCardDto,
  type VehicleReadingStatsRow,
} from '@technic/contracts';
import { db } from '../db/client';
import { loadFuelNormSeason, loadVehiclesWithNorm, type FuelNormSeason } from './fuel-norms';
import {
  driverDailyReports,
  vehicleCategories,
  vehicleModels,
  vehicleReadings,
  vehicles,
  vehicleTypes,
} from '../db/schema';

/**
 * Агрегат показаний за период (план «Показания техники», §5): пробег, наработка, заправленное и
 * качество данных — по машине и месяцу.
 *
 * Считается он **не по строкам отчёта, а по ожидаемым сменам** (Р26в), и это главное отличие от
 * сегодняшней сводки: строка ожидания появляется только после `openReport`, поэтому у водителя,
 * чей день никто не открывал, строк нет вовсе — а смены были. Сводка по строкам отчёта уверяла бы,
 * что данные полные, ровно там, где не сдано ничего.
 *
 * Отсюда четыре свойства, каждое — следствие принятого решения:
 *
 * 1. **Ожидаемый источник один на кабинет и на статистику** (Р26а): рейс с действующим листом
 *    именно на своего водителя и живым составом, недельный ЭСМ-2 — на каждый календарный день
 *    действия (Р34). Разойдись правило с кабинетом — портал требовал бы показаний по сменам,
 *    которых водитель у себя не видит. День, закрытый сразу двумя бумагами — недельным листом и
 *    дневным 4-П той же заявки на ту же машину, — даёт всё равно одну ожидаемую смену, по листу:
 *    подавление живёт в `EXPECTED_ROUTE_FILTER`.
 * 2. **У смены две координаты, и они не сворачиваются в одну** (Р32): снимочная — машина и день,
 *    к которым привязано показание, живая — машина и день источника сегодня. Числа считаются по
 *    снимочной, качество ожидания — по живой; сходятся они только в итоговой группировке. Рейс,
 *    перенесённый на другой день после передачи показания, при свёртке потерял бы требование сдать
 *    показание на новую дату — число осталось бы, а ожидание исчезло.
 * 3. **Пара разностей засчитывается в месяц текущего снимка** (Р4), поэтому сумма месяцев равна
 *    итогу периода, и `loadFleetStats` — свёртка `loadFleetMonths`, а не второй запрос.
 * 4. **Статистика оперативная** (Р27): считаются все неаннулированные показания, а не только
 *    принятые. Чтобы «оперативная» не читалась как «сырая», рядом с итогом идёт качество данных —
 *    `shifts`, `missingReadings`, `unacceptedShifts`.
 *
 * Запрос — один сырой текст через `db.execute` (Р33). Пять CTE через `db.$with` читались бы хуже
 * одного текста; цена приёма известна и уже оплачена в модуле: `numeric` приходит строками, и
 * разбирает их та же функция `num`, что и в `readings-stats.ts`.
 */

// ── Ядро: месяцы машин ──

/**
 * Сентинел-дата для соединения по рейсу.
 *
 * `FULL JOIN` в PostgreSQL 16 принимает только merge/hash-joinable условия, поэтому дизъюнкцию
 * «по рейсу ИЛИ по листу с датой» соединить нельзя (проверено на живой базе: `FULL JOIN is only
 * supported with merge-joinable or hash-joinable join conditions`, Р32б). Обе стороны приводятся к
 * одной паре равенств `(join_id, join_date)`: у листа день в ключе участвует, у рейса — нет, и
 * вместо него с обеих сторон ставится заведомо невозможная дата. `-infinity` выбран именно за
 * невозможность: любой календарный сентинел рано или поздно оказался бы чьим-то днём отчёта.
 *
 * Семантика от этого не меняется: соединение и так один к одному —
 * `report_items_route_key` уникален по `route_id`, `report_items_waybill_key` — по
 * `(waybill_id, report_date)`.
 */
const ROUTE_JOIN_DATE = sql`DATE '-infinity'`;

/**
 * Что делает рейс ожидаемой сменой (Р26а). Фрагмент общий у всех, кто спрашивает ожидаемые смены, —
 * месяцев парка и реестра приёма (через `expectedRelationCte`), хвостовой выборки ТО
 * (`loadLastExpectedShiftDays`), фильтра «не сданы» и поиска несданного источника
 * (`readings-stats.ts`), — и общий он намеренно: правило «с кого спрашивают показание» обязано быть
 * записано ровно один раз. Разойдись эти места, и подсветка «пробег с ТО известен лишь снизу»
 * зажигалась бы по сменам, которых статистика не ждёт.
 *
 * Фрагмент ждёт **строку `vehicle_routes` целиком** под алиасом `vr`: кроме ключа ему нужны машина
 * и день рейса. Все читатели так её и называют — в том числе `readings-stats.ts`, где алиас задан
 * `alias(vehicleRoutes, 'vr')` ради этого фрагмента.
 */
export const EXPECTED_ROUTE_FILTER = sql`
       vr.driver_person_id IS NOT NULL
       /*
        * Действующий лист обязателен и спрашивается на ЭТОГО же водителя: бумага именная, и
        * переназначенный без перевыписки листа рейс заданием не является. Форма листа не
        * проверяется — рейс закрывается 4-П или формой № 3, и перечислять их здесь значило бы
        * завести второе место, где записано, чем закрывается рейс.
        */
       AND EXISTS (SELECT 1
                     FROM waybills w
                    WHERE w.route_id = vr.id
                      AND w.status <> 'cancelled'
                      AND w.driver_person_id = vr.driver_person_id)
       /*
        * Живой состав: рейс, оставшийся без единой неудалённой и неотменённой заявки, заданием не
        * является — ехать по нему не надо. Перегон остаётся всегда: у него задание не в составе, а
        * в «откуда/куда».
        */
       AND (vr.purpose <> 'freight'
            OR EXISTS (SELECT 1
                         FROM vehicle_route_requests rr
                         JOIN vehicle_requests q ON q.id = rr.request_id
                        WHERE rr.route_id = vr.id
                          AND q.deleted_at IS NULL
                          AND q.status <> 'cancelled'))
       /*
        * Бумаги за день бывает две, а смена одна. У заказа техники на объект портал выписывает и
        * недельный ЭСМ-2, и дневной 4-П на тот же день той же машины
        * (docs/vehicle-request-day-batch-plan.md, Р2 и Р3): двойная бумага принята заказчиком
        * осознанно, двойной учёт — нет. Машина отработала одну смену, показание за неё одно, и
        * спрашивают его по недельному листу; рейс этого дня ожидаемой сменой не считается.
        *
        * Подавляется рейс, а не лист: недельный ЭСМ-2 и есть рапорт о работе машины на площадке —
        * им эта неделя закрывается в учёте, — а дневной бланк диспетчер волен аннулировать и
        * выписать заново (Р2), и ожидание смены не должно ездить вслед за перевыписываемой
        * бумагой. Не подави портал одну из двух, вторую закрыть было бы нечем: строка отчёта
        * привязана ровно к одному источнику — либо к рейсу, либо к листу с днём, — и одна
        * физически сданная смена закрывает ровно одно ожидание. Второе висело бы несданным весь
        * срок заказа: гараж красный каждый день, качество данных вдвое хуже, а служебная книга
        * показаний с задвоенными строками.
        *
        * Условие узкое: та же заявка, та же машина, тот же день. День берётся у строки состава —
        * work_date физически равен дню рейса (vehicle_route_requests_route_date_fk), а у
        * грузовой строки он пуст. Поэтому грузовой рейс и перегон внутри недели ЭСМ-2 остаются
        * ожидаемыми сменами, как и были: их выезд неделя на площадке не покрывает.
        *
        * Водитель в условии не участвует: считается смена машины, а не человека. Неделю переписали
        * на подменного машиниста, дневные 4-П остались на прежнем — показание сдаёт тот, на кого
        * выписан недельный лист. Ровно так же подавляет карточку кабинет водителя
        * (driver-assignment.ts), и разойтись им нельзя: состав отчёта собирается там.
        */
       AND NOT EXISTS (SELECT 1
                         FROM waybills ew
                         JOIN vehicle_route_requests err ON err.request_id = ew.source_request_id
                        WHERE ew.form_code = 'esm2'
                          AND ew.status <> 'cancelled'
                          AND ew.vehicle_id = vr.vehicle_id
                          AND ew.period_from <= vr.route_date
                          AND ew.period_to >= vr.route_date
                          AND err.route_id = vr.id
                          AND err.work_date = vr.route_date)`;

/**
 * Что делает недельный лист источником ожидаемых смен (Р26а, Р34). Границы периода к фрагменту не
 * относятся: у месяцев парка и у хвоста ТО они разные, а вот «какой лист вообще спрашивает
 * показания» — одно и то же. Фрагмент ждёт алиас `w` у строки листа.
 */
export const EXPECTED_ESM2_FILTER = sql`
       w.form_code = 'esm2'
       AND w.status <> 'cancelled'
       AND w.period_from IS NOT NULL
       AND w.period_to IS NOT NULL`;

/**
 * Расход смены: `остаток на начало + заправлено − остаток на конец` (план
 * `docs/fuel-norms-plan.md`, Р9) — **одна формула на портал и на служебную книгу**.
 *
 * Функция, а не константа, и это не вкусовщина: показание подшито разными алиасами у разных
 * читателей — `p` в наборе агрегата, `vr` в выборке приёма, — а `vr` в агрегате занят рейсом.
 * Константа заставила бы переименовывать чужие алиасы ради общего фрагмента.
 *
 * Считается только там, где известны **оба** остатка: заправленное без остатков — поток за смену, а
 * не убыль в баке. `coalesce` у заправленного обязателен: пустая заправка означает «не заправляли»,
 * а не «неизвестно», и без него расход обращался бы в NULL у каждой незаправленной смены.
 */
export function fuelSpentSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`CASE WHEN ${a}.fuel_start_liters IS NOT NULL AND ${a}.fuel_end_liters IS NOT NULL
                  THEN round(${a}.fuel_start_liters + coalesce(${a}.fuel_filled_liters, 0::numeric)
                             - ${a}.fuel_end_liters, 1) END`;
}

/**
 * База сверяемой смены — величина, которую единица нормы превращает в литры (план §3.3).
 *
 * У машины с нормой счётчик задаёт единица, у машины без норм — приоритет: одометр, а если он базы
 * не дал, моточасы (Р9в). Приоритет, а не «любой из двух», потому что от выбора зависят и число в
 * колонке, и то, по какой цепочке проверяется непрерывность.
 */
const BASE_SQL = sql`CASE
    WHEN c.norm_unit = 'l_per_100km' THEN c.distance_km::numeric
    WHEN c.norm_unit = 'l_per_hour'  THEN c.engine_hours
    WHEN NOT c.has_any_norm AND c.distance_km IS NOT NULL AND c.distance_km > 0
         THEN c.distance_km::numeric
    WHEN NOT c.has_any_norm THEN c.engine_hours
  END`;

/** Непрерывность и аномалия — того же счётчика, что дал базу: цепочки независимы (Р13а). */
const COUNTER_OK_SQL = sql`CASE
    WHEN c.norm_unit = 'l_per_100km' THEN c.odometer_continuous AND c.odometer_anomaly_ok
    WHEN c.norm_unit = 'l_per_hour'  THEN c.engine_continuous AND c.engine_anomaly_ok
    WHEN NOT c.has_any_norm AND c.distance_km IS NOT NULL AND c.distance_km > 0
         THEN c.odometer_continuous AND c.odometer_anomaly_ok
    WHEN NOT c.has_any_norm THEN c.engine_continuous AND c.engine_anomaly_ok
  END`;

/**
 * Сверяемая смена (§3.4) — пять условий, и каждое куплено ошибкой разбора:
 *
 * 1. расход посчитан и не отрицателен (отрицательный — незаписанная заправка, а не экономия, Р10а);
 * 2. на дату смены действует версия нормы — либо у машины норм нет вовсе (Р9г, Р9в);
 * 3. база положительна: смена, простоявшая на месте, норму имела бы нулевую (Р14);
 * 4. аномалия счётчика базы отсутствует или подтверждена (Р10б);
 * 5. пара снимков непрерывна (Р13а).
 *
 * `coalesce` вокруг сравнений обязателен: у смены без базы оба выражения дают NULL, а трёхзначная
 * логика увела бы строку не в ту ветвь `CASE`.
 */
const VERIFIED_SQL = sql`c.fuel_spent IS NOT NULL
    AND c.fuel_spent >= 0
    AND (c.norm_id IS NOT NULL OR NOT c.has_any_norm)
    AND coalesce(${BASE_SQL} > 0, false)
    AND coalesce(${COUNTER_OK_SQL}, false)`;

/**
 * Дата в зимнем сезоне. Предикат повторяет `isWinterMonthDay` контрактов знак в знак — по нему окно
 * объясняет человеку, какая ставка действует, а db-тест сверяет обе записи на одних датах.
 *
 * Сравнение текстовое: `MM-DD` лексикографически совпадает с календарным порядком. Период через
 * Новый год (`from > to`) — обычное его состояние, а не особый случай.
 */
function winterSql(season: { winterFromMd: string; winterToMd: string }): SQL {
  return sql`CASE WHEN ${season.winterFromMd}::text > ${season.winterToMd}::text
                  THEN to_char(c.d, 'MM-DD') >= ${season.winterFromMd}
                    OR to_char(c.d, 'MM-DD') <= ${season.winterToMd}
                  ELSE to_char(c.d, 'MM-DD') BETWEEN ${season.winterFromMd}
                                                 AND ${season.winterToMd} END`;
}

/**
 * Общая часть запросов, которым нужны **ожидаемые смены периода вместе с их строками ожидания**:
 * три CTE — `expected`, `observed` и `relation`. Второго правила «что такое ожидаемая смена» в
 * проекте быть не должно, поэтому фрагмент вынесен, а не скопирован: его спрашивают и месяцы парка
 * (ниже), и реестр приёма (`readings-intake.ts`), и разойдись они хоть в одном условии — экран
 * приёма требовал бы показаний по сменам, которых статистика не ждёт.
 *
 * Возвращается **без** ведущего `WITH`: читатель приписывает свои CTE через запятую.
 *
 * Колонки — объединение нужд обоих читателей, и это дешевле, чем два похожих фрагмента: всё, что
 * добавлено сверх месяцев парка (вид источника, работник, версия отчёта, позиция смены), берётся из
 * уже соединённых таблиц и ни одного join не добавляет.
 *
 * Три свойства, каждое — принятое решение:
 *
 * 1. **Полное внешнее объединение без свёртки координат** (Р26в, Р32): ожидание без строки — это
 *    несданная смена, строка без ожидания — уже собранное показание источника, который
 *    переназначили или чей лист аннулировали. Терять нельзя ни то, ни другое.
 * 2. **Соединение — пара равенств `(join_id, join_date)`**, а не дизъюнкция (Р32б): `FULL JOIN` в
 *    PostgreSQL принимает только merge/hash-joinable условия.
 * 3. **`aligned` обёрнут `coalesce(..., false)`** (Р32а): у неоткрытого дня сравнение даёт `NULL`, и
 *    трёхзначная логика проглотила бы ровно тот случай, ради которого признак заводится.
 */
export function expectedRelationCte(from: string, to: string): SQL {
  return sql`
expected AS (
    /*
     * Ожидаемый источник — рейс дня (Р26а). Правило повторяет кабинет водителя
     * (driver-assignment.ts), и повторяет намеренно: расхождение означало бы, что с водителя
     * спрашивают показания по сменам, которых он у себя в задании не видит. Сам отбор вынесен в
     * EXPECTED_ROUTE_FILTER: его же спрашивает хвостовая выборка ТО.
     */
    SELECT vr.id                     AS join_id,
           ${ROUTE_JOIN_DATE}        AS join_date,
           'route'::text             AS source_kind,
           vr.vehicle_id             AS exp_vehicle,
           vr.route_date             AS exp_date,
           vr.driver_person_id       AS exp_person,
           rep.id                    AS exp_report_id,
           rep.state::text           AS exp_state,
           rep.version               AS exp_report_version
      FROM vehicle_routes vr
      /*
       * Отчёт ОЖИДАЕМОГО работника за этот день, если он вообще существует. Именно его состояние
       * отвечает за качество: после переназначения рейса ждут показание от нового водителя, и
       * принятый день прежнего к этому вопросу отношения не имеет.
       *
       * Аннулированный отчёт (Р27) отчётом дня не считается: строк в нём нет — перенос унёс их
       * вместе с показаниями, — и день ждёт показания так же, как если бы его не открывали. На
       * качество данных условие не влияет (у 'voided' и у пустого состояния
       * IS DISTINCT FROM 'accepted' одинаково истинно), а реестру приёма оно не даёт приписать
       * строку отчёту, принять который нельзя.
       */
      LEFT JOIN driver_daily_reports rep
             ON rep.person_id = vr.driver_person_id
            AND rep.report_date = vr.route_date
            AND rep.state <> 'voided'
     WHERE vr.route_date BETWEEN ${from}::date AND ${to}::date
       AND ${EXPECTED_ROUTE_FILTER}
    UNION ALL
    /*
     * Ожидаемый источник — недельный ЭСМ-2, разложенный по КАЖДОМУ календарному дню действия
     * (Р34). Смены считаются днями действия документа, а не выездами: в неделю с двумя простоями
     * ожидаемых смен всё равно семь. Это не выбор статистики, а поведение модуля — кабинет
     * показывает задание по тому же правилу.
     *
     * Границы среза берутся по пересечению с периодом, а ::date обязательно: generate_series
     * над датами возвращает временные метки, и без приведения день ушёл бы в группировку меткой.
     * Вход приводится к timestamp без пояса, чтобы день не зависел от TimeZone сессии.
     */
    SELECT w.id, gs.day::date, 'esm2'::text, w.vehicle_id, gs.day::date, w.driver_person_id,
           rep.id, rep.state::text, rep.version
      FROM waybills w
      CROSS JOIN LATERAL generate_series(greatest(w.period_from, ${from}::date)::timestamp,
                                         least(w.period_to, ${to}::date)::timestamp,
                                         interval '1 day') AS gs(day)
      LEFT JOIN driver_daily_reports rep
             ON rep.person_id = w.driver_person_id
            AND rep.report_date = gs.day::date
            AND rep.state <> 'voided'
     WHERE ${EXPECTED_ESM2_FILTER}
       AND w.period_from <= ${to}::date
       AND w.period_to >= ${from}::date
),
observed AS (
    /*
     * Строки ожидания только неаннулированных отчётов (Р27). Отбор — INNER JOIN, а не условие в
     * LEFT JOIN: во втором случае строка осталась бы в наборе с пустым состоянием, и показание
     * аннулированного отчёта попало бы и в суммы, и в качество.
     *
     * Период спрашивается у дня снимка: число живёт в своём месяце (Р4). Строка, чей источник
     * перенесли за границу периода, останется здесь и посчитается — терять уже собранные данные
     * нельзя.
     */
    SELECT i.id                               AS item_id,
           coalesce(i.route_id, i.waybill_id) AS join_id,
           CASE WHEN i.route_id IS NOT NULL THEN ${ROUTE_JOIN_DATE} ELSE i.report_date END
                                              AS join_date,
           i.source_kind::text                AS source_kind,
           i.vehicle_id                       AS obs_vehicle,
           i.report_date                      AS obs_date,
           i.shift_order                      AS obs_shift_order,
           i.report_id                        AS obs_report_id,
           rep.person_id                      AS obs_person,
           rep.state::text                    AS obs_state,
           rep.version                        AS obs_report_version
      FROM driver_daily_report_items i
      JOIN driver_daily_reports rep ON rep.id = i.report_id AND rep.state <> 'voided'
     WHERE i.report_date BETWEEN ${from}::date AND ${to}::date
),
relation AS (
    /*
     * Полное объединение БЕЗ свёртки координат (Р26в, Р32): ожидание без строки — несданная смена,
     * строка без ожидания — уже собранное показание источника, который переназначили или чей лист
     * аннулировали. Терять нельзя ни то, ни другое; расхождение между ними и есть то, что разбирают
     * в приёме.
     */
    SELECT join_id AS source_id,
           coalesce(e.source_kind, o.source_kind) AS source_kind,
           e.exp_vehicle,
           e.exp_date,
           e.exp_person,
           e.exp_report_id,
           e.exp_state,
           e.exp_report_version,
           o.item_id,
           o.obs_vehicle,
           o.obs_date,
           o.obs_shift_order,
           o.obs_report_id,
           o.obs_person,
           o.obs_state,
           o.obs_report_version,
           /*
            * Сошлись ли координаты (Р32а). Само существование строки по этому источнику ничего не
            * значит: у рейса, перенесённого с 10.08 на 11.08, item_id есть, а числа на живой
            * координате 11.08 нет, — и без признака соответствия старое показание подавило бы
            * требование сдать показание на новой дате.
            *
            * coalesce(..., false) обязателен и не украшение: у неоткрытого дня exp_report_id
            * пуст, сравнение даёт NULL, NOT NULL — снова NULL, и в count(*) FILTER (WHERE
            * missing) такая строка НЕ посчиталась бы — трёхзначная логика проглотила бы ровно тот
            * случай, ради которого признак и заводится. Тем же приёмом обёрнут ITEM_NEEDS_ATTENTION
            * в readings-stats.ts.
            */
           coalesce(o.obs_report_id = e.exp_report_id
                    AND o.obs_vehicle = e.exp_vehicle
                    AND o.obs_date = e.exp_date, false) AS aligned
      FROM expected e
      FULL OUTER JOIN observed o USING (join_id, join_date)
)`;
}

/**
 * Строка ответа ядра: месяц одной машины плюс её реквизиты для подписи.
 *
 * Псевдоним, а не `interface`: `db.execute` требует от параметра типа индексную сигнатуру, а её
 * TypeScript выводит только у объектных псевдонимов.
 */
type AggregateRow = {
  vehicle_id: string;
  month: string;
  /** Суммы приходят строками: `bigint` и `numeric` драйвер числами не отдаёт. */
  distance_km: string | null;
  engine_hours: string | null;
  fuel_filled_liters: string | null;
  odometer_gaps: number;
  engine_hours_gaps: number;
  /** Сводный счётчик разрывов (Р28а): строк, на которых ряд прервался. См. `row_gap` в запросе. */
  row_gaps: number;
  missing_readings: number;
  shifts: number;
  unaccepted_shifts: number;
  /** Сверка: суммы приходят строками (`numeric`), счётчики — числами. */
  fuel_spent_liters: string | null;
  fuel_norm_liters: string | null;
  verified_shifts: number;
  shifts_with_fuel: number;
  ownership: VehicleOwnership;
  description: string;
  registration_number: string | null;
  category_name: string | null;
  type_name: string;
  model_name: string | null;
};

/**
 * Месяцы всех машин периода одним запросом.
 *
 * `vehicleId` фильтрует **после** разделения на проекции, а не внутри `expected`/`observed`, и это
 * не лень: у строки две координаты, и обрезать набор по любой из них раньше времени значило бы
 * потерять либо число (снимок уехал на другую машину), либо ожидание (машину источника подменили).
 * После проекций у каждой строки координата ровно одна — своя, и фильтр по ней однозначен.
 */
async function loadMonthRows(
  from: string,
  to: string,
  vehicleId: string | null,
  season: FuelNormSeason,
): Promise<AggregateRow[]> {
  return db.transaction(async (tx) => {
    /*
     * JIT выключается на время этого запроса — и это не микрооптимизация, а самая крупная правка
     * времени во всём агрегате (замер Р22 на годовом объёме: парк за месяц 1210 → 378 мс).
     *
     * Причина в оценке, а не в самом JIT. Самоджойн `points ⋈ points` идёт по CTE, статистики у
     * которого нет, и планировщик оценивает Append в сотни миллиардов строк — пороги
     * `jit_above_cost` и `jit_optimize_above_cost` перекрыты в миллион раз. LLVM честно компилирует
     * полторы сотни функций с полной оптимизацией на КАЖДЫЙ вызов, и эта компиляция стоит втрое
     * дороже самого счёта.
     *
     * `SET LOCAL`, а не настройка кластера: выключение живёт до конца транзакции и не касается
     * соседних запросов, которым JIT полезен. Отсюда же транзакция вокруг единственного SELECT —
     * без неё `SET LOCAL` не к чему привязать, а `SET` без `LOCAL` осел бы в соединении пула и
     * уехал бы к следующему, ничего не подозревающему запросу.
     */
    await tx.execute(sql`SET LOCAL jit = off`);
    const result = await tx.execute<AggregateRow>(sql`
WITH ${expectedRelationCte(from, to)},
points AS (
    /*
     * Показание подшивается ДО разделения на проекции (Р32в): числа берёт проекция чисел, а
     * reading_id и kind нужны ещё и качеству — признак «смена без числа» смотрит на них же.
     * Оставь этот join внутри проекции чисел, и качество показаний просто не увидело бы.
     */
    SELECT r.*,
           v.id                            AS reading_id,
           v.kind::text                    AS kind,
           v.odometer_km,
           v.engine_hours,
           v.fuel_filled_liters,
           /*
            * Остатки в баке (ADR 0163) — уровень, а не поток: за период они не суммируются, и
            * попадают сюда ровно ради расхода смены (начало + заправлено − конец), который без
            * обоих концов не считается вовсе.
            */
           v.fuel_start_liters,
           v.fuel_end_liters,
           v.previous_odometer_id,
           v.previous_engine_hours_id,
           v.odometer_anomaly::text        AS odometer_anomaly,
           v.engine_hours_anomaly::text    AS engine_hours_anomaly,
           /*
            * Подтверждение аномалии нужно сверке (план docs/fuel-norms-plan.md, Р10б):
            * неподтверждённый скачок одометра даёт базу в тысячи километров и «экономию» под сто
            * процентов, а подтверждённый — это уже принятое гаражом число.
            */
           v.odometer_anomaly_confirmed_at,
           v.engine_hours_anomaly_confirmed_at
      FROM relation r
      LEFT JOIN vehicle_readings v ON v.item_id = r.item_id
),
shift_facts AS (
    /*
     * Числа — по СНИМОЧНОЙ координате: пробег принадлежит той машине и тому дню, к которым привязано
     * показание, а не источнику в его сегодняшнем виде.
     *
     * Предшественник ищется В НАБОРЕ points, а не в таблице vehicle_readings, и это не
     * стилистика (Р32г): именно самоджойн по набору даёт правило «обе точки пары внутри периода»
     * (Р4). Предшественник, оставшийся за границей, в набор не попал, join пуст, разность не
     * считается. Соединение с таблицей молча притянуло бы его и завысило пробег первого дня периода.
     * Саму цепочку при этом строит модуль показаний при записи (previous_*_id) — второго ответа на
     * вопрос «кто чей предшественник» здесь нет.
     */
    SELECT p.obs_vehicle AS vehicle_id,
           p.obs_date    AS d,
           /*
            * Строка со сбросом счётчика в сумму не идёт: ряд на ней рвётся, и её разность сказала бы
            * про пробег заведомую неправду. Разрывом своего счётчика она при этом считается ниже.
            */
           CASE WHEN p.odometer_anomaly IS DISTINCT FROM 'counter_reset'
                     AND p.odometer_km IS NOT NULL AND po.odometer_km IS NOT NULL
                THEN p.odometer_km - po.odometer_km END       AS distance_km,
           CASE WHEN p.engine_hours_anomaly IS DISTINCT FROM 'counter_reset'
                     AND p.engine_hours IS NOT NULL AND pe.engine_hours IS NOT NULL
                THEN p.engine_hours - pe.engine_hours END     AS engine_hours,
           /* Заправлено — сумма литров смен, и рядом с ней ничего не делится на пробег: производных портал не печатает и после ADR 0194. */
           coalesce(p.fuel_filled_liters, 0::numeric)         AS fuel_filled_liters,
           /*
            * Разрыв ряда — сброс СВОЕГО счётчика (Р28): цепочки одометра и моточасов независимы.
            * Пропущенная смена сюда не входит намеренно — цепочка назначает такой строке
            * предшественником последний снимок с числом, и следующее показание накрывает пропуск
            * целиком; про несданные смены отвечает missing_readings своим числом.
            */
           coalesce(p.odometer_anomaly = 'counter_reset', false)     AS odometer_gap,
           coalesce(p.engine_hours_anomaly = 'counter_reset', false) AS engine_hours_gap,
           /*
            * Сводный разрыв (Р28а) — СВОЙ счётчик, а не сумма двух предыдущих: строка, на которой ряд
            * прервался, считается ОДИН раз, и считается она по отсутствию чисел (несданная смена либо
            * no_data) либо по сбросу любого из счётчиков.
            *
            * Сумма odometer_gaps + engine_hours_gaps этому не равна с двух сторон: она теряет
            * строки без чисел и дважды считает строку, где сброшены оба счётчика. Колонка живёт на
            * экране с подписью «Сброшенный счётчик или смена без показания: на них ряд рвётся», и
            * менять её смысл под видом переезда на агрегат нельзя. Место расчёта тоже прежнее —
            * проекция чисел по снимочной координате: разрыв принадлежит той строке, в которой он
            * случился, а не сегодняшнему виду её источника.
            */
           (p.kind IS DISTINCT FROM 'values'
            OR coalesce(p.odometer_anomaly = 'counter_reset', false)
            OR coalesce(p.engine_hours_anomaly = 'counter_reset', false)) AS row_gap,
           /*
            * Расход смены (план docs/fuel-norms-plan.md, Р9): одна формула на портал и на
            * служебную книгу — та же, что печатает книга, и живёт она теперь здесь. Считается
            * только там, где известны ОБА остатка: заправленное без остатков — это поток за смену,
            * а не убыль в баке.
            */
           ${fuelSpentSql('p')} AS fuel_spent,
           /*
            * Даты снимков-предшественников: по ним проверяется непрерывность пары (Р13а). Дата, а
            * не идентификатор, потому что сравнивать её приходится с ожидаемыми сменами, а у
            * ожидания идентификатора показания нет вовсе.
            */
           po.obs_date AS prev_odometer_date,
           pe.obs_date AS prev_engine_date,
           /*
            * Аномалия своего счётчика годна, если её нет или её подтвердили (Р10б). Сброс счётчика
            * сюда не входит: его разность обнуляется выше по самому факту сброса, и базы у такой
            * смены не будет независимо от подтверждения.
            */
           NOT coalesce(p.odometer_anomaly = 'implausible_jump'
                        AND p.odometer_anomaly_confirmed_at IS NULL, false) AS odometer_anomaly_ok,
           NOT coalesce(p.engine_hours_anomaly = 'implausible_jump'
                        AND p.engine_hours_anomaly_confirmed_at IS NULL, false)
                                                                     AS engine_anomaly_ok
      FROM points p
      LEFT JOIN points po ON po.reading_id = p.previous_odometer_id
      LEFT JOIN points pe ON pe.reading_id = p.previous_engine_hours_id
     WHERE p.item_id IS NOT NULL
),
shift_checks AS (
    /*
     * Второй уровень фактов смены: норма, действующая на её дату, и непрерывность пары снимков.
     * Отдельным уровнем, а не колонками выше, потому что оба вычисления опираются на разности и
     * даты предшественников, а сослаться на алиас собственного SELECT в PostgreSQL нельзя.
     */
    SELECT f.*,
           nm.id          AS norm_id,
           nm.unit        AS norm_unit,
           nm.winter_rate AS norm_winter_rate,
           nm.summer_rate AS norm_summer_rate,
           /*
            * У машины есть хоть одна живая версия нормы. Признак нужен ровно для того, чтобы
            * отличить «нормы не заводили» от «смена раньше первого приказа» (Р9в против Р9г): в
            * первом случае смена сверяется без нормы и её расход виден, во втором — не сверяется
            * вовсе, иначе расход копил бы то, чего норма не копит, и отклонение врало бы на всю
            * досидовую историю.
            */
           EXISTS (SELECT 1
                     FROM vehicle_fuel_norms n
                    WHERE n.vehicle_id = f.vehicle_id
                      AND n.deleted_at IS NULL)                        AS has_any_norm,
           /*
            * НЕПРЕРЫВНОСТЬ ПАРЫ (Р13а) — главное расчётное правило волны.
            *
            * Разность счётчика назначается по цепочке показаний: предшественником становится
            * последний снимок С ЧИСЛОМ, а не предыдущая смена. Поэтому одна разность накрывает все
            * несданные перед ней смены, и 400 км против одного бака дали бы ложную экономию в 60%.
            *
            * Проверять это по снимочной проекции нельзя: у смены, чей день никто не открывал,
            * строки в наборе нет вовсе — «соседняя строка» и «предшественник цепочки» у неё
            * совпадают, и разрыв выглядит непрерывностью. Поэтому здесь — осознанное исключение из
            * правила «числа по снимочной координате»: пропуски ищутся среди ОЖИДАЕМЫХ смен.
            *
            * Интервал полуоткрыт: дата предшественника исключительно, дата смены включительно.
            * Отсюда несимметричность, названная в плане: несданная вторая смена того же дня разрыв
            * даёт, а вторая смена дня предшественника — нет; позиции смены у ожидания не существует.
            *
            * Строгость зависит от документа (Р13б): у рейса день ожидания означает работу, а у
            * недельного ЭСМ-2 — только действие листа, поэтому у него рвёт лишь день, за который
            * отчёт открывали, а чисел не дали. Иначе вся техника на недельных листах — то есть всё,
            * что нормируется в л/час, — осталась бы без сверки вовсе.
            *
            * CASE снаружи не украшение: у смены без расхода сверять нечего, и подзапрос по
            * материализованному CTE для неё не выполняется вовсе.
            */
           CASE WHEN f.fuel_spent IS NULL THEN false ELSE NOT EXISTS (
               SELECT 1 FROM points q
                WHERE q.exp_vehicle = f.vehicle_id
                  AND q.exp_date > f.prev_odometer_date
                  AND q.exp_date <= f.d
                  AND (NOT q.aligned OR q.reading_id IS NULL OR q.kind = 'no_data'
                       OR q.odometer_km IS NULL)
                  AND (q.source_kind = 'route' OR q.exp_report_id IS NOT NULL)
           ) END AS odometer_continuous,
           CASE WHEN f.fuel_spent IS NULL THEN false ELSE NOT EXISTS (
               SELECT 1 FROM points q
                WHERE q.exp_vehicle = f.vehicle_id
                  AND q.exp_date > f.prev_engine_date
                  AND q.exp_date <= f.d
                  AND (NOT q.aligned OR q.reading_id IS NULL OR q.kind = 'no_data'
                       OR q.engine_hours IS NULL)
                  AND (q.source_kind = 'route' OR q.exp_report_id IS NOT NULL)
           ) END AS engine_continuous
      FROM shift_facts f
      LEFT JOIN LATERAL (
          SELECT n.id, n.unit, n.winter_rate, n.summer_rate
            FROM vehicle_fuel_norms n
           WHERE n.vehicle_id = f.vehicle_id
             AND n.deleted_at IS NULL
             AND n.effective_from <= f.d
           ORDER BY n.effective_from DESC
           LIMIT 1
      ) nm ON true
),
observed_metrics AS (
    /*
     * Сверка смены с нормой. Четыре числа наружу — и все аддитивные (Р12а): отклонение, процент и
     * признак превышения считаются из них на каждом уровне отдельно, потому что процент, сложенный
     * по месяцам, не значит ничего.
     */
    SELECT c.vehicle_id,
           c.d,
           c.distance_km,
           c.engine_hours,
           c.fuel_filled_liters,
           c.odometer_gap,
           c.engine_hours_gap,
           c.row_gap,
           false AS missing,
           false AS shift,
           false AS unaccepted,
           /*
            * Расход сверяемых смен — ровно то, из чего посчитана норма рядом (Р9а). Смена, не
            * прошедшая сверку, не попадает ни в одну из трёх колонок экрана: иначе человек,
            * вычитая соседние колонки, получал бы не то, что напечатано в третьей.
            */
           CASE WHEN ${VERIFIED_SQL} THEN c.fuel_spent ELSE 0::numeric END AS fuel_spent_verified,
           /*
            * Норма смены: база, помноженная на ставку сезона. Сезон выбирается датой снимка (Р11а),
            * а зимний период переходит через Новый год — это его обычное состояние, а не особый
            * случай, и предикат написан под него.
            */
           CASE WHEN ${VERIFIED_SQL} AND c.norm_id IS NOT NULL THEN
               round(${BASE_SQL} * (CASE WHEN ${winterSql(season)}
                                         THEN c.norm_winter_rate ELSE c.norm_summer_rate END)
                     / (CASE WHEN c.norm_unit = 'l_per_100km' THEN 100 ELSE 1 END), 1)
           ELSE 0::numeric END AS fuel_norm_liters,
           (CASE WHEN ${VERIFIED_SQL} THEN 1 ELSE 0 END)            AS verified_shift,
           (CASE WHEN c.fuel_spent IS NOT NULL THEN 1 ELSE 0 END)   AS shift_with_fuel
      FROM shift_checks c
),
expected_quality AS (
    /*
     * Качество — по ЖИВОЙ координате: ожидаемых смен столько, сколько их сегодня у машины, и
     * требование сдать показание стоит на той дате, на которую источник перенесён.
     */
    SELECT p.exp_vehicle AS vehicle_id,
           p.exp_date    AS d,
           NULL::integer AS distance_km,
           NULL::numeric AS engine_hours,
           0::numeric    AS fuel_filled_liters,
           false         AS odometer_gap,
           false         AS engine_hours_gap,
           /*
            * Сводный разрыв здесь всегда false: он считается по снимочной координате (Р28а), и
            * посчитай его обе проекции — несданная смена, у которой строка ожидания всё-таки есть,
            * попала бы в колонку дважды.
            */
           false         AS row_gap,
           /* Смена без числа: координаты разошлись, показания нет вовсе либо оно no_data. */
           (NOT p.aligned OR p.reading_id IS NULL OR p.kind = 'no_data') AS missing,
           true          AS shift,
           /*
            * Непринятая смена (Р27). IS DISTINCT FROM ловит и неоткрытый день: отчёта нет вовсе,
            * состояние пустое — ровно та строка, которую сводка по строкам отчёта теряла.
            */
           (p.exp_state IS DISTINCT FROM 'accepted') AS unaccepted,
           /*
            * Зеркальные колонки сверки: проекции склеиваются UNION ALL, и порядок с типом обязаны
            * совпадать. Нули, а не NULL, потому что это счётчики и суммы — у ожидаемой смены без
            * показания сверять нечего, и «ноль сверяемых» здесь означает ровно это.
            */
           0::numeric AS fuel_spent_verified,
           0::numeric AS fuel_norm_liters,
           0          AS verified_shift,
           0          AS shift_with_fuel
      FROM points p
     WHERE p.exp_vehicle IS NOT NULL
),
totals AS (
    /* Месяц берётся у ТЕКУЩЕГО снимка (Р4) — поэтому сумма месяцев равна итогу периода. */
    SELECT u.vehicle_id,
           to_char(u.d, 'YYYY-MM')                              AS month,
           sum(u.distance_km)                                   AS distance_km,
           sum(u.engine_hours)                                  AS engine_hours,
           sum(u.fuel_filled_liters)                            AS fuel_filled_liters,
           (count(*) FILTER (WHERE u.odometer_gap))::int        AS odometer_gaps,
           (count(*) FILTER (WHERE u.engine_hours_gap))::int    AS engine_hours_gaps,
           (count(*) FILTER (WHERE u.row_gap))::int             AS row_gaps,
           (count(*) FILTER (WHERE u.missing))::int             AS missing_readings,
           (count(*) FILTER (WHERE u.shift))::int               AS shifts,
           (count(*) FILTER (WHERE u.unaccepted))::int          AS unaccepted_shifts,
           /* Сверка с нормой — четыре аддитивных числа (Р12а), из которых считается отклонение. */
           sum(u.fuel_spent_verified)                           AS fuel_spent_liters,
           sum(u.fuel_norm_liters)                              AS fuel_norm_liters,
           (sum(u.verified_shift))::int                         AS verified_shifts,
           (sum(u.shift_with_fuel))::int                        AS shifts_with_fuel
      FROM (SELECT * FROM observed_metrics UNION ALL SELECT * FROM expected_quality) u
     WHERE ${vehicleId}::uuid IS NULL OR u.vehicle_id = ${vehicleId}::uuid
     GROUP BY u.vehicle_id, to_char(u.d, 'YYYY-MM')
)
SELECT t.*,
       v.ownership::text        AS ownership,
       v.description,
       v.registration_number,
       c.name                   AS category_name,
       vt.name                  AS type_name,
       m.name                   AS model_name
  FROM totals t
  JOIN vehicles v        ON v.id = t.vehicle_id
  JOIN vehicle_types vt  ON vt.id = v.vehicle_type_id
  LEFT JOIN vehicle_categories c ON c.id = v.vehicle_category_id
  LEFT JOIN vehicle_models m     ON m.id = v.vehicle_model_id
 /* Порядок сводки — тот же, что у сегодняшней (госномер), месяцы внутри машины по возрастанию. */
 ORDER BY v.registration_number_normalized ASC NULLS LAST, t.vehicle_id, t.month`);

    return [...result.rows];
  });
}

// ── Разбор чисел ──

/** Число из `numeric`/`bigint`: драйвер отдаёт их строкой, и `null` обязан остаться `null`. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Месяц из строки ответа. Прочерк, а не ноль (Р4): месяц, где не осталось ни одной пары снимков, о
 * пробеге не говорит, и ноль в этой клетке читался бы как «машина стояла».
 */
function monthOf(row: AggregateRow): ReadingMonthRow {
  const distance = num(row.distance_km);
  const engine = num(row.engine_hours);
  return {
    month: row.month,
    distanceKm: distance === null ? null : Math.round(distance),
    engineHours: engine === null ? null : round(engine, 1),
    fuelFilledLiters: round(num(row.fuel_filled_liters) ?? 0, 1),
    /*
     * Сверка с нормой. Нули хранятся, а печатаются прочерком: месяц без сверяемых смен о расходе
     * не говорит, и ноль в этой клетке читался бы как «машина не жгла топливо». Правило печати
     * живёт у портала и у книг — числам же нужно складываться.
     */
    fuelSpentLiters: round(num(row.fuel_spent_liters) ?? 0, 1),
    fuelNormLiters: round(num(row.fuel_norm_liters) ?? 0, 1),
    verifiedShifts: row.verified_shifts,
    shiftsWithFuel: row.shifts_with_fuel,
    odometerGaps: row.odometer_gaps,
    engineHoursGaps: row.engine_hours_gaps,
    missingReadings: row.missing_readings,
    shifts: row.shifts,
    unacceptedShifts: row.unaccepted_shifts,
  };
}

/**
 * Итог периода — сумма месяцев (Р4), а не отдельный запрос: правило «пара засчитывается в месяц
 * текущего снимка» ровно для того и принято, чтобы эти два числа не расходились.
 *
 * Прочерк складывается с прочерком в прочерк, но с числом — в число: месяц без единой пары
 * снимков молчит о пробеге, а не утверждает, что он нулевой.
 */
function sumMonths(months: readonly ReadingMonthRow[]): ReadingTotals {
  const total: ReadingTotals = {
    distanceKm: null,
    engineHours: null,
    fuelFilledLiters: 0,
    fuelSpentLiters: 0,
    fuelNormLiters: 0,
    verifiedShifts: 0,
    shiftsWithFuel: 0,
    odometerGaps: 0,
    engineHoursGaps: 0,
    missingReadings: 0,
    shifts: 0,
    unacceptedShifts: 0,
  };
  for (const month of months) {
    if (month.distanceKm !== null) total.distanceKm = (total.distanceKm ?? 0) + month.distanceKm;
    if (month.engineHours !== null) {
      total.engineHours = (total.engineHours ?? 0) + month.engineHours;
    }
    total.fuelFilledLiters += month.fuelFilledLiters;
    total.fuelSpentLiters += month.fuelSpentLiters;
    total.fuelNormLiters += month.fuelNormLiters;
    total.verifiedShifts += month.verifiedShifts;
    total.shiftsWithFuel += month.shiftsWithFuel;
    total.odometerGaps += month.odometerGaps;
    total.engineHoursGaps += month.engineHoursGaps;
    total.missingReadings += month.missingReadings;
    total.shifts += month.shifts;
    total.unacceptedShifts += month.unacceptedShifts;
  }
  total.engineHours = total.engineHours === null ? null : round(total.engineHours, 1);
  total.fuelFilledLiters = round(total.fuelFilledLiters, 1);
  total.fuelSpentLiters = round(total.fuelSpentLiters, 1);
  total.fuelNormLiters = round(total.fuelNormLiters, 1);
  return total;
}

/** Машина со своими месяцами: подпись строится один раз на машину, а не на каждый месяц. */
interface VehicleMonths {
  vehicleId: string;
  typeName: string;
  modelName: string | null;
  ownership: VehicleOwnership;
  vehicleLabel: string;
  months: ReadingMonthRow[];
  /**
   * Сводный счётчик разрывов за период (Р28а). В месяцах его нет намеренно: карточка и диаграмма
   * спрашивают три раздельных числа (Р28), а одну колонку списка описывает `ReadingTotals` ровно
   * теми полями, что в нём объявлены, — и класть в них четвёртое, никем из них не читаемое, значило
   * бы отдавать порталу поле, которого он не просил.
   */
  gaps: number;
}

function groupByVehicle(rows: readonly AggregateRow[]): VehicleMonths[] {
  const byVehicle = new Map<string, VehicleMonths>();
  for (const row of rows) {
    const entry = byVehicle.get(row.vehicle_id) ?? {
      vehicleId: row.vehicle_id,
      gaps: 0,
      typeName: row.type_name,
      modelName: row.model_name,
      ownership: row.ownership,
      vehicleLabel: vehicleLabel({
        ownership: row.ownership,
        description: row.description,
        registrationNumber: row.registration_number,
        categoryName: row.category_name,
        typeName: row.type_name,
        modelName: row.model_name,
      }),
      months: [],
    };
    entry.months.push(monthOf(row));
    entry.gaps += row.row_gaps;
    byVehicle.set(row.vehicle_id, entry);
  }
  return [...byVehicle.values()];
}

// ── Наружу ──

/**
 * Машина → её месяцы за период. Порядок машин — тот же, каким идёт сводка (госномер), месяцы внутри
 * машины по возрастанию: `Map` помнит порядок вставки, и помесячная выгрузка получает готовый.
 *
 * `vehicleId` сужает ответ до одной машины — тем же запросом, а не вторым: карточка и список
 * обязаны отвечать одинаково, а два запроса с одинаковыми на вид условиями расходятся при первой
 * же правке одного из них.
 */
export async function loadFleetMonths(
  from: string,
  to: string,
  vehicleId?: string,
): Promise<Map<string, ReadingMonthRow[]>> {
  const rows = await loadMonthRows(from, to, vehicleId ?? null, await loadFuelNormSeason());
  return new Map(groupByVehicle(rows).map((entry) => [entry.vehicleId, entry.months]));
}

/**
 * Сводка по парку за период — строка на машину, свёрткой её месяцев (Р4).
 *
 * `gaps` берётся своим счётчиком (Р28а), а не суммой `odometerGaps + engineHoursGaps`: колонка
 * считает СТРОКИ, на которых ряд прервался, а те два числа — счётчики. Сумма разошлась бы с
 * подписью колонки с двух сторон сразу: потеряла бы смены, по которым чисел нет вовсе, и дважды
 * посчитала бы строку со сбросом обоих счётчиков.
 *
 * В списке стоят машины, у которых в периоде есть ожидаемая смена **или** собранное показание:
 * машина с ожидаемым источником попадает в сводку, даже если отчёта у неё никто не открывал
 * (Р26в), — иначе экран уверял бы, что данных нет, там, где их не сдали.
 *
 * Рядом с суммами идут два снимка счётчиков за тот же отрезок (Р17) — тем же `loadLastReadings`,
 * которым отвечают гараж и карточка, но с нижней границей: сводка за июль не смеет показывать
 * июньское число под подписью «Одометр». Выборок на них ровно две — по одной на счётчик на весь
 * список; запрос на строку означал бы полсотни запросов на сводку парка.
 */
export async function loadFleetStats(from: string, to: string): Promise<VehicleReadingStatsRow[]> {
  const rows = await loadMonthRows(from, to, null, await loadFuelNormSeason());
  const entries = groupByVehicle(rows);
  const ids = entries.map((entry) => entry.vehicleId);
  const [odometers, engineHours, withNorm] = await Promise.all([
    loadLastReadings(ids, to, 'odometer', from),
    loadLastReadings(ids, to, 'engineHours', from),
    /*
     * «У машины есть норма» спрашивается отдельным запросом по машинам ответа (Р15а), а не внутри
     * расчёта: у машины, попавшей в сводку одними ожидаемыми сменами, строк показаний нет вовсе, и
     * боковое соединение внутри проекции чисел сказало бы «нормы не заведено» там, где она есть.
     */
    loadVehiclesWithNorm(ids, to),
  ]);
  return entries.map((entry) => {
    const total = sumMonths(entry.months);
    return {
      vehicleId: entry.vehicleId,
      vehicleLabel: entry.vehicleLabel,
      distanceKm: total.distanceKm,
      engineHours: total.engineHours,
      // Машины без снимка в ответе просто нет — прочерк на экране значит «числового показания в
      // периоде не было», и подставлять сюда ноль значило бы объявить счётчик обнулённым.
      lastOdometer: odometers.get(entry.vehicleId) ?? null,
      lastEngineHours: engineHours.get(entry.vehicleId) ?? null,
      fuelFilledLiters: total.fuelFilledLiters,
      gaps: entry.gaps,
      typeName: entry.typeName,
      modelName: entry.modelName,
      ownership: entry.ownership,
      // Три числа приходят из того же `sumMonths`, что и пробег: своего счёта смен у сводки нет.
      shifts: total.shifts,
      missingReadings: total.missingReadings,
      unacceptedShifts: total.unacceptedShifts,
      // Сверка с нормой — из той же свёртки месяцев: своего счёта у сводки нет и здесь.
      fuelSpentLiters: total.fuelSpentLiters,
      fuelNormLiters: total.fuelNormLiters,
      verifiedShifts: total.verifiedShifts,
      shiftsWithFuel: total.shiftsWithFuel,
      hasNorm: withNorm.has(entry.vehicleId),
    };
  });
}

/**
 * Последнее числовое показание счётчика **не позже дня среза** (Р16) — по списку машин сразу.
 *
 * Граница верхняя и она существенна: карточка марта не должна показывать майский снимок, а гараж
 * отвечает про день, который у него выбран. После коррекции задним числом (ADR 0101) «последнее
 * вообще» и «последнее на этот день» — разные числа, и спрашивать надо именно второе.
 *
 * Нижняя граница (`from`) необязательна, и по умолчанию её нет: «последнее известное» тем и ценно,
 * что могло быть снято хоть месяц назад, — потому дата снятия и возвращается рядом с числом. Так
 * спрашивают гараж, карточка ТО и книги выгрузки, и ответ им обязан остаться прежним. Названная же
 * граница превращает вопрос в другой — «что показывал счётчик в этом отрезке» (Р17): сводке за
 * период снимок из-за его начала не годится, там прочерк честнее чужого числа.
 *
 * Порядок — `(report_date, shift_order)`, тот же, каким идёт учётная цепочка: день без позиции
 * смены не различает две смены одной машины. Аннулированные отчёты пропускаются (Р27).
 *
 * Выборка **одна на весь список**: `DISTINCT ON (vehicle_id)` снимает верхнюю строку каждой
 * машины по индексу `vehicle_readings_chain_idx` — тем же приёмом, каким гараж уже добирает
 * состояния дня и кабинет водителя прошлый снимок счётчиков. Запрос на строку списка означал бы
 * полсотни запросов на страницу гаража.
 *
 * Функция одна и на карточку машины, и на колонку гаража: вопрос у них общий («что показывал
 * счётчик на этот день»), а два ответа на один вопрос расходятся при первой же правке одного из
 * них — например при появлении второго условия на аннулированные отчёты.
 *
 * Наружу она отдана целиком, обоими счётчиками: одометровую обёртку (`loadLastOdometers`) зовут
 * гараж, карточка ТО и подсказка ввода акта, а моточасы спрашивает срез выгрузок
 * (`readings-export.ts`) — и спрашивал он их своей копией этого запроса, пока отдан был один
 * счётчик из двух.
 */
export async function loadLastReadings(
  vehicleIds: readonly string[],
  on: string,
  counter: 'odometer' | 'engineHours',
  from?: string,
): Promise<Map<string, { value: number; measuredOn: string }>> {
  const found = new Map<string, { value: number; measuredOn: string }>();
  if (vehicleIds.length === 0) return found;

  const column = counter === 'odometer' ? vehicleReadings.odometerKm : vehicleReadings.engineHours;
  const rows = await db
    .selectDistinctOn([vehicleReadings.vehicleId], {
      vehicleId: vehicleReadings.vehicleId,
      value: column,
      measuredOn: vehicleReadings.reportDate,
    })
    .from(vehicleReadings)
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, vehicleReadings.reportId))
    .where(
      and(
        inArray(vehicleReadings.vehicleId, [...vehicleIds]),
        lte(vehicleReadings.reportDate, on),
        // Нижняя граница — условие того же запроса, а не своя выборка для сводки: отбор
        // аннулированных и порядок цепочки обязаны остаться общими, иначе снимок в сводке и
        // снимок в гараже разойдутся при первой же правке одного из них.
        ...(from === undefined ? [] : [gte(vehicleReadings.reportDate, from)]),
        eq(vehicleReadings.kind, 'values'),
        // Показание своего счётчика: смена с одними моточасами про одометр не говорит ничего, и
        // считать её последним снимком пробега значило бы прятать за ней предыдущее число.
        isNotNull(column),
        ne(driverDailyReports.state, 'voided'),
      ),
    )
    .orderBy(
      asc(vehicleReadings.vehicleId),
      desc(vehicleReadings.reportDate),
      desc(vehicleReadings.shiftOrder),
    );

  for (const row of rows) {
    if (row.value === null) continue;
    // `odometer_km` приходит числом, `engine_hours` — строкой `numeric`: разбор один на оба случая.
    found.set(row.vehicleId, { value: Number(row.value), measuredOn: row.measuredOn });
  }
  return found;
}

/**
 * Последний одометр машин страницы на день среза — для колонки гаража (Р16, §7).
 *
 * Отдельного расчёта здесь нет: это тот же `loadLastReadings`, переложенный в поле `km`, которым
 * одометр называется во всех DTO плана (`VehicleReadingCardDto.lastOdometer`). Машина без
 * числового показания в ответе просто отсутствует — «показаний не было» и «нуль на приборе» портал
 * обязан различать.
 */
export async function loadLastOdometers(
  vehicleIds: readonly string[],
  on: string,
): Promise<Map<string, { km: number; measuredOn: string }>> {
  const readings = await loadLastReadings(vehicleIds, on, 'odometer');
  return new Map(
    [...readings].map(([vehicleId, reading]) => [
      vehicleId,
      { km: reading.value, measuredOn: reading.measuredOn },
    ]),
  );
}

/**
 * Последний день периода, на который машину **ждали** с показаниями (Р26а), — по списку машин сразу.
 *
 * Зовёт это ТО: `lowerBound` поднимается, когда между последним числовым снимком одометра и днём
 * среза есть ожидаемые смены без чисел (Р11, Р11в). Вопрос «есть ли такие смены» здесь сведён к
 * одному числу, и сведение это точное, а не приблизительное: после последнего числового снимка
 * чисел по определению больше нет, поэтому ЛЮБАЯ ожидаемая смена правее него — смена без числа.
 * Достаточно, стало быть, знать самую правую из ожидаемых: больше она дня снимка — хвост не закрыт.
 *
 * Отсюда и дешевизна выборки: по строке на машину, без `generate_series` по дням недельного листа —
 * последний ожидаемый день такого листа это `least(period_to, to)`, раскладывать его в семь дней,
 * чтобы взять максимум, незачем. Правило же «что вообще считается ожидаемой сменой» общее с
 * месяцами парка: оба читателя спрашивают `EXPECTED_ROUTE_FILTER` и `EXPECTED_ESM2_FILTER`.
 *
 * Машина без единой ожидаемой смены в периоде в ответе отсутствует — это не ноль, а «не ждали».
 */
export async function loadLastExpectedShiftDays(
  vehicleIds: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const ids = [...new Set(vehicleIds)];
  // Пустой период законен: у машины, чей последний снимок снят днём среза, хвоста нет по построению.
  if (ids.length === 0 || from > to) return found;

  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db.execute<{ vehicle_id: string; last_day: string }>(sql`
    SELECT vehicle_id, max(day)::text AS last_day
      FROM (SELECT vr.vehicle_id, vr.route_date AS day
              FROM vehicle_routes vr
             WHERE vr.vehicle_id IN (${list})
               AND vr.route_date BETWEEN ${from}::date AND ${to}::date
               AND ${EXPECTED_ROUTE_FILTER}
            UNION ALL
            /* День действия листа, а не выезда (Р34): в неделю с двумя простоями ждут всю неделю. */
            SELECT w.vehicle_id, least(w.period_to, ${to}::date)
              FROM waybills w
             WHERE w.vehicle_id IN (${list})
               AND ${EXPECTED_ESM2_FILTER}
               AND w.period_from <= ${to}::date
               AND w.period_to >= ${from}::date) t
     GROUP BY vehicle_id`);
  for (const row of result.rows) found.set(row.vehicle_id, row.last_day);
  return found;
}

/**
 * Карточка машины: итог периода, его месяцы и последние показания счётчиков на конец периода.
 * `null` — машины нет вовсе; машина без единой смены за период — это законная карточка с пустыми
 * месяцами, а не отсутствие ответа.
 *
 * Блока ТО здесь нет (Р14а): сводка обслуживания приходит своей ручкой под своим правом, а поле,
 * исчезающее по чужому праву, — то же смешение прав, только спрятанное в сериализатор.
 */
export async function loadVehicleCard(
  vehicleId: string,
  from: string,
  to: string,
): Promise<VehicleReadingCardDto | null> {
  const [vehicle] = await db
    .select({
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(eq(vehicles.id, vehicleId));
  if (!vehicle) return null;

  const season = await loadFuelNormSeason();
  const [rows, odometers, engineHours, withNorm] = await Promise.all([
    loadMonthRows(from, to, vehicleId, season),
    loadLastReadings([vehicleId], to, 'odometer'),
    loadLastReadings([vehicleId], to, 'engineHours'),
    loadVehiclesWithNorm([vehicleId], to),
  ]);
  const months = groupByVehicle(rows)[0]?.months ?? [];
  const odometer = odometers.get(vehicleId) ?? null;
  const engine = engineHours.get(vehicleId) ?? null;

  return {
    vehicleId,
    vehicleLabel: vehicleLabel(vehicle),
    from,
    to,
    total: sumMonths(months),
    months,
    lastOdometer:
      odometer === null ? null : { km: odometer.value, measuredOn: odometer.measuredOn },
    lastEngineHours:
      engine === null ? null : { value: engine.value, measuredOn: engine.measuredOn },
    hasNorm: withNorm.has(vehicleId),
    /*
     * Допуск едет вместе с числами (Р12б): карточку открывает право показаний, а настройки закрыты
     * правом справочников — без этого числа она не смогла бы ни покрасить превышение, ни объяснить,
     * из чего оно вышло.
     */
    tolerancePercent: season.tolerancePercent,
  };
}
