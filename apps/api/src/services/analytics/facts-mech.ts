import { sql, type SQL } from 'drizzle-orm';
import {
  analyticsCountsAsFact,
  type AnalyticsQualityEntry,
  formatMechRequestNumber,
  REQUEST_STATUSES,
  type RequestStatus,
} from '@technic/contracts';
import { db } from '../../db/client';
import type { AnalyticsAtom, AnalyticsFacts, AnalyticsRange } from './types';

/**
 * Атомы механизации для сводной аналитики (план `docs/analytics-summary-export-plan.md`, Р13).
 *
 * Аренда малой механизации — единственный из трёх модулей, у которого **одна заявка живёт много
 * дней подряд**, и из этого следует всё остальное в файле:
 *
 * 1. **Атом — день присутствия техники на площадке**, а не заявка. Иначе двухнедельная аренда,
 *    начатая в июле и закрытая в августе, целиком попала бы в один месяц, и лист «Динамика»
 *    разошёлся бы со «Сводом» — а они обязаны сходиться, потому что это одна и та же выборка
 *    (Р13, Р28).
 * 2. **Деньги и `actual_units` раскладываются по дням присутствия равномерно** (Р28). Знаменатель
 *    — дни ВСЕЙ аренды, а не её куска внутри периода: дели на дни куска — и аренда, пересекающая
 *    границу, показала бы полную стоимость в каждом из двух месяцев, то есть деньги удвоились бы
 *    ровно там, где их труднее всего заметить. Остаток округления кладётся на последний день
 *    аренды — тем же правилом, что у заказа техники (`spread`): раскладка обязана сходиться к
 *    исходной сумме, а не к ней «примерно».
 * 3. **Заказчик — объект-МЕСТО, отдел едет отдельным полем** (Р5, Р22). У механизации, в отличие
 *    от заказа ТС, объект и отдел не исключают друг друга: объект отвечает «где стоит техника»
 *    (и на нём же держится вся видимость модуля), отдел — «на кого расходы». Разнеси одну аренду
 *    по двум строкам свода, и деньги удвоятся; разрез по плательщику собирается сводной мышью с
 *    листа «Данные».
 * 4. **Часы и смены не складываются** (Р17). `actual_units` — итог аренды в единицах ставки, и
 *    какое из двух полей атома он наполняет, решает `rate_unit`. Одной колонки «отработано» с
 *    единицей в подписи здесь нет намеренно.
 * 5. **Часовая ставка без отработанных часов оценки не даёт вовсе** (Р29). Это тот же ответ, что
 *    у заказа техники (`facts-vehicle.ts`, `dayPrice`), и разойтись двум модулям одной книги
 *    нельзя: домножить рубли-за-час на календарные дни, не зная часов в дне, значит выдумать
 *    число — правдоподобное и потому неопровержимое.
 *
 * Отменённые и мягко удалённые не считаются нигде (Р10).
 */

/**
 * Статусы-факты спрашиваются у контракта, а не переписываются словами в текст запроса: у
 * механизации коридор свой (`completed` ей запрещён CHECK-ом), и вторая копия списка разошлась бы
 * с `analyticsCountsAsFact` молча.
 */
const FACT_STATUSES = REQUEST_STATUSES.filter(analyticsCountsAsFact);

/**
 * Позиция аренды без модели. Состояние ЗАКОННОЕ и постоянное: заявки старше миграции 0251, чьё
 * написание в справочнике не нашлось, остались без предмета вовсе (см. комментарий к
 * `mech_requests.mech_model_id`), и заводить им модели заказчик отказался. Ключ поэтому свой и
 * устойчивый — сваливать такие аренды в пустую строку нельзя: группировка детализации потеряла бы
 * их вместе с деньгами.
 */
const NO_MODEL_KEY = 'mech|no-model';
const NO_MODEL_LABEL = 'Без модели';

/** Строка ответа; последняя строка набора — не атом, а качество (см. хвост запроса). */
type MechRow = {
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  customer_is_active: boolean | null;
  payer_department_id: string | null;
  payer_department_name: string | null;
  day: string | null;
  model_id: string | null;
  model_name: string | null;
  request_id: string | null;
  request_num: number | null;
  request_status: RequestStatus | null;
  /** `numeric` драйвер отдаёт строкой — числом его делает `num`. */
  shifts: string | null;
  mech_hours: string | null;
  money_fact: string | null;
  money_estimate: string | null;
  priced: boolean | null;
  /** Заполнено ровно на одной строке набора; у атомов пусто. */
  quality: AnalyticsQualityEntry[] | null;
};

function num(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Доля ОДНОГО дня присутствия от итога аренды (Р28), с остатком округления на последнем дне.
 *
 * Ровный `итог / дни` теряет копейки: 100 ₽ на три дня дают три раза по 33,33, и сумма атомов
 * расходится с суммой заявки — на листе «Свод» это выглядит опечаткой, а происходит на каждой
 * аренде, которая не делится нацело. Остаток кладётся на последний день ВСЕЙ аренды; лежит он за
 * границей периода — периоду просто не достаётся, ровно как у заказа техники (`spread`).
 *
 * Кусок вставляется внутрь `atoms` и знает его псевдонимы (`g` — аренда, `gs.day` — день серии):
 * разложить один и тот же итог двумя разными способами в одном запросе нельзя, и общий множитель
 * здесь дешевле четырёх копий формулы.
 */
function perDay(total: SQL): SQL {
  return sql`CASE WHEN gs.day::date = g.present_to
                  THEN round((${total}), 2) - round((${total}) / g.total_days, 2) * (g.total_days - 1)
                  ELSE round((${total}) / g.total_days, 2) END`;
}

/**
 * Механизация за период — одной выборкой (Р15).
 *
 * Разложение по дням сделано в SQL через `generate_series`, а не в памяти после выборки, и это не
 * вкусовщина: тем же приёмом разложен недельный ЭСМ-2 в `readings-aggregate.ts`
 * (`expectedRelationCte`), а главное — в памяти пришлось бы повторить обрезку по периоду и деление
 * на дни, то есть завести второе место, где записано, что такое «день присутствия». Заодно
 * `LIMIT`, когда он понадобится потолку атомов (Р15), ляжет на готовый набор, а не на полуфабрикат.
 */
export async function loadMechFacts(range: AnalyticsRange): Promise<AnalyticsFacts> {
  const result = await db.execute<MechRow>(sql`
WITH scope AS (
    /*
     * Отбор: отменённые и мягко удалённые не считаются нигде (Р10). Даты заявки едут дальше как
     * есть — присутствие из них считает следующий шаг, которому нужен ещё и признак факта.
     */
    SELECT m.id,
           m.num,
           m.status::text                          AS status,
           m.object_id,
           m.department_id,
           m.mech_model_id,
           m.rate,
           m.rate_unit::text                       AS rate_unit,
           m.actual_units,
           m.final_cost,
           m.planned_from,
           m.planned_to,
           m.actual_from,
           m.actual_to,
           m.status::text = ANY(${sql.param(FACT_STATUSES)}::text[]) AS is_fact
      FROM mech_requests m
     WHERE m.deleted_at IS NULL
       AND m.status <> 'cancelled'
),
present AS (
    /*
     * ПРИСУТСТВИЕ ТЕХНИКИ НА ПЛОЩАДКЕ (Р11): факт, а пока факта нет — план. actual_from IS NULL
     * означает «технику ещё не выдали», и у такой аренды единственное, что известно о днях, — срок
     * договорённости.
     *
     * Конец присутствия у выданной и НЕ ВОЗВРАЩЁННОЙ техники — плановый день, а если он уже
     * прошёл — конец запрошенного периода: техника стоит на площадке, пока её не забрали. Возьми
     * один planned_to — и аренда, выданная 01.07 с планом до 31.07 и не возвращённая, выпала бы
     * из августовской книги ЦЕЛИКОМ: ни дней, ни денег, ни строки на листе «Качество», потому что
     * и он считается по тем же пересекающимся с периодом арендам. Просрочку поэтому и называет
     * отдельный счётчик — потерять её из виду второй раз нельзя.
     *
     * Конец периода, а не current_date: книга за прошлый месяц обязана давать одно и то же число
     * при каждом запуске, а с «сегодня» в формуле она бы тихо росла день ото дня. Плата за это —
     * знаменатель раскладки у невозвращённой аренды зависит от периода; при ставке за смену доля
     * дня от этого не меняется (она равна самой ставке), и сумма двух соседних периодов сходится
     * с периодом целиком. План здесь не догадка — продление аренды двигает именно planned_to
     * (см. шапку mech_requests).
     *
     * Ветка is_fact — страховка, и сегодня она недостижима: закрыть аренду, не записав день
     * возврата, база не даёт (mech_requests_done_check требует все четыре факта, а «Завершена» у
     * механизации запрещена вовсе). Стоит она затем, что ослабление того CHECK иначе двинуло бы
     * знаменатель раскладки ФАКТА: дотянутое до конца периода присутствие сделало бы долю дня
     * зависящей от периода, и две половины месяца перестали бы сходиться с месяцем — на заявке с
     * уже введённой суммой. Невозможность состояния закреплена тестом: упадёт он — сюда и придут.
     *
     * greatest с actual_from страхует строку, где технику выдали уже после планового конца:
     * пустой интервал дал бы деление на ноль в раскладке.
     */
    SELECT s.*,
           CASE WHEN s.actual_from IS NULL THEN s.planned_from ELSE s.actual_from END
                                                   AS present_from,
           CASE WHEN s.actual_from IS NULL   THEN s.planned_to
                WHEN s.actual_to IS NOT NULL THEN greatest(s.actual_to, s.actual_from)
                WHEN s.is_fact               THEN greatest(s.planned_to, s.actual_from)
                ELSE greatest(s.planned_to, ${range.to}::date, s.actual_from) END
                                                   AS present_to,
           /*
            * «В работе» и «просрочена» считаются НА КОНЕЦ ПЕРИОДА, а не на момент запроса: книга
            * за июль обязана отвечать про июль и при перепечатке в сентябре. Поэтому спрашиваются
            * ДАТЫ, а не статус: статус у заявки один, сегодняшний, и аренда, возвращённая уже в
            * сентябре, по нему выпала бы из августовской книги — а на 31 августа техника стояла
            * на площадке. Выдачу не позже конца периода гарантирует отбор span ниже.
            *
            * Расходиться со статусом даты при этом не могут: закрытая аренда обязана нести день
            * возврата (mech_requests_done_check), поэтому «не возвращена к концу периода» и «не
            * закрыта» — про одни и те же строки. Ослабят тот CHECK — и закрытая аренда без дня
            * возврата попадёт в оба счётчика, а книге понадобится строка «Аренд закрыто без даты
            * возврата»: без неё читатель решит, что техники на площадках вдвое больше.
            */
           (s.actual_from IS NOT NULL
            AND (s.actual_to IS NULL OR s.actual_to > ${range.to}::date)) AS in_progress,
           (s.actual_from IS NOT NULL AND s.actual_to IS NULL
            AND s.planned_to < ${range.to}::date)  AS overdue
      FROM scope s
),
span AS (
    /*
     * Аренды, пересекающиеся с периодом. total_days — дни ВСЕЙ аренды: это знаменатель раскладки,
     * и период на него не влияет (иначе сумма месяцев не равнялась бы сумме года).
     */
    SELECT s.*, (s.present_to - s.present_from + 1) AS total_days
      FROM present s
     WHERE s.present_from <= ${range.to}::date
       AND s.present_to >= ${range.from}::date
),
graded AS (
    /*
     * ДЕНЬГИ (Р9) — итогом аренды; по дням их делит следующий шаг. Факт — final_cost у заявки,
     * чей статус контракт считает фактом. Оценка незакрытой одна: rate × actual_units, а без
     * отработанных единиц — rate × дни присутствия, и ТОЛЬКО при ставке за смену: смена и день
     * сопоставимы, а сколько часов в дне — не знает никто. Часовая ставка без actual_units не
     * даёт оценки вовсе (Р29): «500 ₽/ч, 5 дней» превратились бы в 2 500 ₽ вместо примерно
     * 20 000 — число правдоподобное и потому неопровержимое. Такая аренда идёт в счётчик «без
     * цены»: ноль в денежной клетке обязан означать бесплатную работу и ничего больше, и ровно
     * так же на этот случай отвечает заказ техники (facts-vehicle.ts, dayPrice).
     * Вторая оценка у механизации взяться неоткуда, поэтому нижняя и верхняя совпадают.
     *
     * Подмены факта оценкой у завершённой аренды НЕТ намеренно: аренда, закрытая без суммы, обязана
     * остаться видимой дырой — её считает лист «Качество», и заткни её расчётом, вопрос «почему
     * сумма не введена» никто бы уже не задал.
     */
    SELECT s.*,
           CASE WHEN s.is_fact THEN s.final_cost END AS money_fact_total,
           CASE WHEN s.is_fact THEN NULL ELSE e.total END
                                                    AS money_estimate_total,
           /* Оценка спрашивается ровно там же, где считается: два её описания разошлись бы молча. */
           CASE WHEN s.is_fact THEN s.final_cost IS NOT NULL ELSE e.total IS NOT NULL END
                                                    AS priced
      FROM span s
      CROSS JOIN LATERAL (SELECT CASE WHEN s.actual_units IS NOT NULL THEN s.rate * s.actual_units
                                      WHEN s.rate_unit = 'shift'      THEN s.rate * s.total_days
                                 END AS total) e
),
atoms AS (
    /*
     * День присутствия внутри периода. ::date обязателен: generate_series над датами отдаёт
     * временные метки, и без приведения день ушёл бы в группировку меткой. Вход приводится к
     * timestamp без пояса — иначе шаг в сутки поехал бы на переводе часов в зоне сессии.
     */
    SELECT o.id                                     AS customer_id,
           o.code                                   AS customer_code,
           o.name                                   AS customer_name,
           o.is_active                              AS customer_is_active,
           d.id                                     AS payer_department_id,
           d.name                                   AS payer_department_name,
           gs.day::date::text                       AS day,
           g.mech_model_id                          AS model_id,
           mm.name                                  AS model_name,
           g.id                                     AS request_id,
           g.num                                    AS request_num,
           g.status                                 AS request_status,
           /* Единица ставки решает, какое поле наполняется; складывать их между собой нельзя. */
           (${perDay(sql`CASE WHEN g.rate_unit = 'shift' THEN coalesce(g.actual_units, 0)::numeric
                              ELSE 0::numeric END`)})::text           AS shifts,
           (${perDay(sql`CASE WHEN g.rate_unit = 'hour' THEN coalesce(g.actual_units, 0)::numeric
                              ELSE 0::numeric END`)})::text           AS mech_hours,
           (${perDay(sql`coalesce(g.money_fact_total, 0)`)})::text     AS money_fact,
           (${perDay(sql`coalesce(g.money_estimate_total, 0)`)})::text AS money_estimate,
           g.priced
      FROM graded g
      JOIN construction_objects o ON o.id = g.object_id
      LEFT JOIN departments d     ON d.id = g.department_id
      LEFT JOIN mech_models mm    ON mm.id = g.mech_model_id
      CROSS JOIN LATERAL generate_series(greatest(g.present_from, ${range.from}::date)::timestamp,
                                         least(g.present_to, ${range.to}::date)::timestamp,
                                         interval '1 day') AS gs(day)
),
quality AS (
    /* Лист «Качество данных» (Р20). Знаменатель у всех четырёх один — аренды периода. */
    SELECT jsonb_build_array(
             jsonb_build_object(
               'key',   'mech.rentals_without_final_cost',
               'label', 'Аренд без итоговой суммы',
               'value', count(*) FILTER (WHERE g.final_cost IS NULL),
               'outOf', count(*),
               'note',  'Деньги по ним — оценка по ставке, а у часовой без часов их нет вовсе'),
             jsonb_build_object(
               'key',   'mech.rentals_without_model',
               'label', 'Аренд без модели',
               'value', count(*) FILTER (WHERE g.mech_model_id IS NULL),
               'outOf', count(*),
               'note',  'Предмет аренды не назван: в детализации они сведены в одну позицию'),
             jsonb_build_object(
               'key',   'mech.rentals_in_progress',
               'label', 'Аренд в работе на конец периода',
               'value', count(*) FILTER (WHERE g.in_progress),
               'outOf', count(*),
               'note',  'Техника не возвращена к концу периода; деньги незакрытых — оценка'),
             jsonb_build_object(
               'key',   'mech.rentals_overdue',
               'label', 'Аренд просрочено: техника не возвращена после планового дня',
               'value', count(*) FILTER (WHERE g.overdue),
               'outOf', count(*),
               'note',  'Дни присутствия им дотянуты до конца периода, деньги по ним — оценка')
           ) AS entries
      FROM graded g
)
/*
 * Качество — хвостовая строка того же набора (Р15: одна выборка на модуль). LEFT JOIN atoms ON
 * false даёт строку с пустыми колонками атома, не выписывая два десятка NULL:: с типами, и
 * оставляет её даже тогда, когда атомов нет вовсе: лист «Качество» обязан отвечать нулями и по
 * периоду без единой аренды.
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
    const estimate = num(row.money_estimate);
    atoms.push({
      module: 'mech',
      // Строка свода — объект-МЕСТО (Р22); отдел-плательщик едет полем и разрезом сводной.
      customerKind: 'object',
      customerId: row.customer_id!,
      customerCode: row.customer_code!,
      customerName: row.customer_name!,
      customerIsActive: row.customer_is_active!,
      payerDepartmentId: row.payer_department_id,
      payerDepartmentName: row.payer_department_name,
      date: row.day!,
      positionKey: row.model_id ?? NO_MODEL_KEY,
      positionLabel: row.model_name ?? NO_MODEL_LABEL,
      // Позиция механизации — модель справочника: своего парка и гос. номеров у аренды нет.
      registrationNumber: null,
      requestId: row.request_id!,
      requestLabel: formatMechRequestNumber(row.request_num!),
      requestStatus: row.request_status!,
      shifts: num(row.shifts),
      // У механизации дни присутствия и есть её план: отдельного «плана смен» здесь не бывает, а
      // расхождение плана с фактом видно парой `planned_*` против `actual_*` внутри модуля (Р7).
      planShifts: 0,
      trips: 0,
      volumeM3: 0,
      weightTons: 0,
      engineHours: 0,
      mechHours: num(row.mech_hours),
      // День присутствия — сам атом, поэтому единица, а не расчёт.
      mechDays: 1,
      removals: 0,
      containerOps: 0,
      relocations: 0,
      moneyFact: num(row.money_fact),
      // Оценка у механизации одна (Р9), поэтому нижняя и верхняя — одно и то же число.
      moneyLow: estimate,
      moneyHigh: estimate,
      priced: row.priced!,
    });
  }
  return { atoms, quality };
}
