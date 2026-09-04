import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type DiscrepancyKind,
  type DriverReportState,
  formatVehicleRouteNumber,
  type ReadingAnomaly,
  type ReadingAnomalyDto,
  vehicleLabel,
  vehicleReadingDayState,
  type VehicleReadingDayState,
  type VehicleReadingDto,
  type VehicleReadingJournalDto,
  type VehicleReadingJournalRow,
  type VehicleReadingStatsRow,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import { pageParams } from '../lib/pagination';
import {
  driverDailyReportItems,
  driverDailyReports,
  driverReportDiscrepancyResolutions,
  files,
  persons,
  users,
  vehicleCategories,
  vehicleModels,
  vehicleReadingFiles,
  vehicleReadingHistory,
  vehicleReadings,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../db/schema';
import { EXPECTED_ESM2_FILTER, EXPECTED_ROUTE_FILTER } from './readings-aggregate';

/**
 * Показания глазами гаража (ADR 0103, Р27/Р28): состояние дня машины, её журнал и лист выгрузки для
 * сводки по парку.
 *
 * Файл читающий целиком — ни одной записи. Своих таблиц у гаража нет (ADR 0076), и таблицы модуля
 * показаний он **показывает**, как показывает рейсы, листы и заявки. Отсюда три правила, из которых
 * следует всё остальное:
 *
 * 1. **День машины считается по строкам ожидания**, а не по текущему набору источников (Р27):
 *    только так колонка отвечает однозначно и при двух сменах, и после правки задания. Само
 *    состояние собирает функция контракта `vehicleReadingDayState` — она одна на портал и сервер,
 *    и второй формулы в SQL здесь нет намеренно.
 * 2. **Приросты журнала берутся по готовой цепочке** (`previous_odometer_id` /
 *    `previous_engine_hours_id`). Цепочку строит модуль показаний при записи; пересчитывать её на
 *    чтении значило бы завести второй ответ на вопрос «кто чей предшественник».
 * 3. **Портал считает заправленное топливо, и только его** (Р28). Ни расхода, ни производных
 *    «на сто километров»: цифра, поделённая на пробег, читается как расход независимо от подписи
 *    в колонке, а фактический расход требует остатков в баке, которых портал не хранит. Поэтому
 *    колонок в листе выгрузки ровно столько же, сколько на экране.
 *
 * Итогов по парку здесь больше нет: пробег, наработку и разрывы считает агрегат
 * `services/readings-aggregate.ts` (план «Показания техники», §5). Он считает их по ожидаемым
 * сменам, а не по строкам отчёта (Р26в), и держать рядом вторую формулу значило бы иметь два ответа
 * на вопрос «сколько проехала машина». `readingStatsSheet` при этом остался здесь: он рисует
 * готовые строки, а не считает их.
 */

// ── Состояние дня машины ──

/**
 * Разрешающее решение по расхождению этой строки — последнее в журнале (Р21).
 *
 * Последнее по `report_version_after`, а не по времени: журнал append-only, диспетчер вправе
 * передумать (`accepted_as_is → revoked → source_added`), и действует третья строка. Отбор ложится
 * на индекс `discrepancy_resolutions_item_idx`.
 *
 * Отпечаток здесь **не сверяется**: его канонизация принадлежит модулю показаний (Р21), и второй
 * её реализации в портале быть не должно — разойдись они на один пробел, и два экрана отвечали бы
 * про один день по-разному. Точную сверку делает карточка отчёта, где разбор и ведут.
 *
 * Вместо отпечатка колонка требует, чтобы решение было принято **при нынешней версии отчёта**
 * (`report_version_after >= version`). Запись решения сама двигает версию, поэтому сразу после
 * разбора условие выполняется; но всякая последующая правка отчёта — в том числе та, что могла
 * сменить отпечаток, — снова красит день. Это осознанный выбор стороны ошибки: колонка скорее
 * покажет расхождение там, где его уже разобрали, чем промолчит о неразобранном. Ложно-зелёная
 * колонка означала бы, что диспетчер узнаёт о проблеме только упёршись в отказ приёмки.
 */
function resolvedSql(kind: DiscrepancyKind): SQL {
  return sql`coalesce((
    SELECT rs_d.resolution FROM ${driverReportDiscrepancyResolutions} rs_d
    WHERE rs_d.item_id = ${driverDailyReportItems.id}
      AND rs_d.report_id = ${driverDailyReportItems.reportId}
      AND rs_d.kind = ${kind}
      AND rs_d.report_version_after >= ${driverDailyReports.version}
    ORDER BY rs_d.report_version_after DESC
    LIMIT 1
  ) IN ('accepted_as_is', 'source_added'), false)`;
}

/**
 * Признак расхождения строки со своим живым источником (Р21). Вид источника решает, у кого
 * спрашивать: у рейса или у недельного листа — третьего не бывает (Р16).
 *
 * `source_state` у рейса недостижим намеренно: удалить рейс, на который ссылается строка ожидания,
 * не даёт `ON DELETE RESTRICT`, — а лист аннулируют не удаляя, и это его состояние.
 */
const DISCREPANCY_SIGNS: Record<Exclude<DiscrepancyKind, 'missing_source'>, SQL> = {
  driver: sql`CASE ${driverDailyReportItems.sourceKind}
    WHEN 'route' THEN ${vehicleRoutes.driverPersonId} IS DISTINCT FROM ${driverDailyReports.personId}
    ELSE ${waybills.driverPersonId} IS DISTINCT FROM ${driverDailyReports.personId} END`,
  vehicle: sql`CASE ${driverDailyReportItems.sourceKind}
    WHEN 'route' THEN ${vehicleRoutes.vehicleId} <> ${driverDailyReportItems.vehicleId}
    ELSE ${waybills.vehicleId} <> ${driverDailyReportItems.vehicleId} END`,
  date: sql`CASE ${driverDailyReportItems.sourceKind}
    WHEN 'route' THEN ${vehicleRoutes.routeDate} <> ${driverDailyReportItems.reportDate}
    ELSE NOT (${waybills.periodFrom} <= ${driverDailyReportItems.reportDate}
              AND ${waybills.periodTo} >= ${driverDailyReportItems.reportDate}) END`,
  source_state: sql`CASE ${driverDailyReportItems.sourceKind}
    WHEN 'route' THEN false
    ELSE ${waybills.status} = 'cancelled' END`,
};

/** Аномалия счётчика, которую никто не подтвердил (Р20): по каждому счётчику своя. */
const UNCONFIRMED_ANOMALY = sql`(
  (${vehicleReadings.odometerAnomaly} IS NOT NULL
    AND ${vehicleReadings.odometerAnomalyConfirmedAt} IS NULL)
  OR (${vehicleReadings.engineHoursAnomaly} IS NOT NULL
    AND ${vehicleReadings.engineHoursAnomalyConfirmedAt} IS NULL))`;

/**
 * С этой строкой надо что-то делать: неподтверждённая аномалия либо неразобранное расхождение.
 * Каждый признак оборачивается `coalesce(..., false)` — у строки без показания и у пустого
 * `leftJoin` сравнение даёт NULL, а «неизвестно» в колонке читалось бы как «всё хорошо».
 */
const ITEM_NEEDS_ATTENTION = sql`(
  coalesce(${UNCONFIRMED_ANOMALY}, false)
  OR (coalesce(${DISCREPANCY_SIGNS.driver}, false) AND NOT ${resolvedSql('driver')})
  OR (coalesce(${DISCREPANCY_SIGNS.vehicle}, false) AND NOT ${resolvedSql('vehicle')})
  OR (coalesce(${DISCREPANCY_SIGNS.date}, false) AND NOT ${resolvedSql('date')})
  OR (coalesce(${DISCREPANCY_SIGNS.source_state}, false) AND NOT ${resolvedSql('source_state')}))`;

/**
 * Показание источника уже передано: у него есть строка ожидания в неаннулированном отчёте, и на
 * этой строке стоит показание любого вида — включая `no_data` («счётчик не работает» это ответ, а
 * не пропуск). Отбор по состоянию отчёта тот же, что у колонки дня: показание аннулированного
 * отчёта уехало вместе со строками в другой день и закрывает смену там.
 *
 * Соединение однозначно ключом самого источника — `report_items_route_key` у рейса,
 * `report_items_waybill_key` у недельного листа, — поэтому «сдано ли» здесь считается наличием, а
 * не счётчиком.
 */
function sourceClosedSql(match: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${driverDailyReportItems} pr_i
    JOIN ${driverDailyReports} pr_rep ON pr_rep.id = pr_i.report_id AND pr_rep.state <> 'voided'
    JOIN ${vehicleReadings} pr_r ON pr_r.item_id = pr_i.id
    WHERE ${match}
  )`;
}

/**
 * Фильтр «не сданы» — главный вопрос к экрану следующего утра (Р27).
 *
 * Считается **от ожидаемых смен дня, а не от строк ожидания** (Р26б). Строка ожидания появляется
 * только после `openReport`, поэтому день, который никто не открывал, прежний фильтр не видел
 * вовсе: у водителя без учётки показаний нет и не ждут — хотя рейс с выписанным листом есть, и
 * ввести за него показания диспетчер обязан. Ровно ради таких дней фильтр и открывают.
 *
 * Что считается ожидаемой сменой, решают общие фрагменты `EXPECTED_ROUTE_FILTER` и
 * `EXPECTED_ESM2_FILTER` (`readings-aggregate.ts`) — те же самые, которыми считает статистика и
 * которые повторяют кабинет водителя (Р26а). Копии здесь нет намеренно: разойдись правило, гараж
 * требовал бы показаний по сменам, которых водитель у себя в задании не видит. Дневные границы к
 * фрагментам не относятся и стоят рядом с ними: у рейса это его день, у недельного листа — каждый
 * календарный день действия (Р34).
 *
 * Машина без ожидаемой смены в отбор не попадает — ждать с неё нечего; машина, у которой все
 * ожидаемые смены закрыты, — тоже.
 *
 * Тег в отобранной строке иногда говорит «расхождение», а не «частично», и это не противоречие:
 * фильтр отвечает «по этой машине ещё ждут показания», а тег называет главное — то, с чем надо
 * что-то делать в первую очередь. Обратное тоже бывает: у рейса, переназначенного без перевыписки
 * листа, тег красный, а ждать показание не с кого (§14 п. 5 плана) — такой день разбирают, а не
 * досдают.
 *
 * Отбор идёт до страницы (`routes/garage.ts`): посчитанный по загруженной странице, он врал бы и в
 * счётчике, и в листании. Поэтому он обязан оставаться **коррелированным по машине** — и половины
 * сложены одним `EXISTS` над `UNION ALL`, а не двумя `EXISTS` через `OR`. Разница не косметическая:
 * два отдельных `EXISTS` планировщик расцепляет в `hashed SubPlan` и считает ответ сразу по всему
 * году — один раз, но целиком: полный проход по составу рейсов и по всем листам с
 * `period_from <= день`. Замер на годовом объёме (200 машин × 365 дней, 146 тыс. строк ожидания):
 * расцепленная форма 45 мс, `UNION ALL` — 5 мс, потому что обе ветки остаются на ключах своей
 * машины и дня (`vehicle_routes_vehicle_date_idx`, `waybills_vehicle_issued_idx`) и упираются в
 * `report_items_route_key` / `report_items_waybill_key`. Сверху к обеим формам PostgreSQL
 * добавляет ~22 мс компиляции JIT — оценка плана перекрывает `jit_above_cost`, как и у агрегата
 * (`readings-aggregate.ts`); там её снимают `SET LOCAL jit = off`, здесь снимать нечем: фильтр
 * приходит условием чужого запроса, а не своей транзакцией.
 *
 * По строкам ожидания здесь не ищут вовсе: их индекс по `(report_date, vehicle_id)` этому запросу
 * больше не нужен — в строку он приходит от найденного источника, а не наоборот.
 */
export function pendingReadingsSql(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM (
      SELECT 1 FROM ${vehicleRoutes} vr
      WHERE vr.vehicle_id = ${vehicles.id}
        AND vr.route_date = ${on}::date
        AND ${EXPECTED_ROUTE_FILTER}
        AND NOT ${sourceClosedSql(sql`pr_i.route_id = vr.id`)}
      UNION ALL
      SELECT 1 FROM ${waybills} w
      WHERE w.vehicle_id = ${vehicles.id}
        AND ${EXPECTED_ESM2_FILTER}
        AND w.period_from <= ${on}::date AND w.period_to >= ${on}::date
        AND NOT ${sourceClosedSql(sql`pr_i.waybill_id = w.id AND pr_i.report_date = ${on}::date`)}
    ) pending_shift
  )`;
}

/**
 * Источник дня, которого нет в отправленном отчёте (`missing_source`, Р21) — по машинам страницы.
 *
 * Спрашивается только у отчёта в отправленном состоянии, и это существенно: пока отчёт в `draft`,
 * состав пересобирается при каждом открытии кабинета (Р17 п. 2), и «строки ещё нет» означает лишь
 * то, что водитель не открывал приложение. Расхождением это становится с отправкой, которая состав
 * замораживает.
 *
 * Машина берётся у самого источника, а не у отчёта: несданным остался конкретный выезд, и красным
 * обязана быть строка той машины, которая в этот день ездила.
 *
 * Источник спрашивается **ожидаемый** — теми же фрагментами, что и фильтр «не сданы» (Р26а, Р26б).
 * Раньше ветка рейсов действующего листа не требовала вовсе, и гараж красил рейс, которого водитель
 * у себя в кабинете не видел: спросить показание было не с кого, а день горел. Побочный эффект
 * приведения назван в плане (§14 п. 4): сигнала «рейс есть, лист не выписали» в гараже больше нет —
 * его показывает журнал маршрутов фильтром «Без листа».
 */
const SUBMITTED_STATES: DriverReportState[] = ['submitted', 'accepted', 'needs_reacceptance'];

/**
 * Алиасы источников под общие фрагменты ожидаемой смены: `EXPECTED_ROUTE_FILTER` ждёт строку рейса
 * под именем `vr`, `EXPECTED_ESM2_FILTER` — строку листа под именем `w`. Имена заданы фрагментом, а
 * не выбраны здесь: он один на три читателя, и подстраиваться под него — цена того, что правило
 * «с кого спрашивают показание» записано ровно один раз.
 */
const expectedRoute = alias(vehicleRoutes, 'vr');
const expectedEsm2 = alias(waybills, 'w');

function missingSourceResolvedSql(source: 'route' | 'waybill', sourceId: SQL): SQL {
  const column = source === 'route' ? sql`ms_d.route_id` : sql`ms_d.waybill_id`;
  return sql`coalesce((
    SELECT ms_d.resolution FROM ${driverReportDiscrepancyResolutions} ms_d
    WHERE ms_d.report_id = ${driverDailyReports.id}
      AND ms_d.item_id IS NULL
      AND ${column} = ${sourceId}
    ORDER BY ms_d.report_version_after DESC
    LIMIT 1
  ) IN ('accepted_as_is', 'source_added'), false)`;
}

async function loadMissingSourceVehicles(on: string, vehicleIds: string[]): Promise<Set<string>> {
  const [routes, sheets] = await Promise.all([
    db
      .select({ vehicleId: expectedRoute.vehicleId })
      .from(expectedRoute)
      .innerJoin(
        driverDailyReports,
        and(
          eq(driverDailyReports.personId, expectedRoute.driverPersonId),
          eq(driverDailyReports.reportDate, expectedRoute.routeDate),
        ),
      )
      .where(
        and(
          inArray(expectedRoute.vehicleId, vehicleIds),
          eq(expectedRoute.routeDate, on),
          sql`(${EXPECTED_ROUTE_FILTER})`,
          inArray(driverDailyReports.state, SUBMITTED_STATES),
          sql`NOT EXISTS (
            SELECT 1 FROM ${driverDailyReportItems} ms_i WHERE ms_i.route_id = ${expectedRoute.id}
          )`,
          sql`NOT ${missingSourceResolvedSql('route', sql`${expectedRoute.id}`)}`,
        ),
      ),
    db
      .select({ vehicleId: expectedEsm2.vehicleId })
      .from(expectedEsm2)
      .innerJoin(
        driverDailyReports,
        and(
          eq(driverDailyReports.personId, expectedEsm2.driverPersonId),
          eq(driverDailyReports.reportDate, on),
        ),
      )
      .where(
        and(
          inArray(expectedEsm2.vehicleId, vehicleIds),
          sql`(${EXPECTED_ESM2_FILTER})`,
          sql`${expectedEsm2.periodFrom} <= ${on}::date AND ${expectedEsm2.periodTo} >= ${on}::date`,
          inArray(driverDailyReports.state, SUBMITTED_STATES),
          sql`NOT EXISTS (
            SELECT 1 FROM ${driverDailyReportItems} ms_i
            WHERE ms_i.waybill_id = ${expectedEsm2.id} AND ms_i.report_date = ${on}::date
          )`,
          sql`NOT ${missingSourceResolvedSql('waybill', sql`${expectedEsm2.id}`)}`,
        ),
      ),
  ]);

  return new Set([...routes, ...sheets].map((row) => row.vehicleId));
}

/**
 * Состояние показаний за день по машинам найденной страницы — тем же приёмом, каким гараж
 * добирает занятости (`loadVehicleBusy`): отдельными запросами со склейкой в памяти, а не join'ом
 * к списку. Join размножил бы строку машины по числу её смен.
 *
 * Отчёты в состоянии `voided` не считаются вовсе (Р27): строк в них нет, а прежние показания уехали
 * вместе со строками в другой отчёт и считаются там.
 */
export async function loadVehicleReadingStates(
  on: string,
  vehicleIds: string[],
): Promise<Map<string, VehicleReadingDayState>> {
  const states = new Map<string, VehicleReadingDayState>();
  if (vehicleIds.length === 0) return states;

  const [counts, missing] = await Promise.all([
    db
      .select({
        vehicleId: driverDailyReportItems.vehicleId,
        itemCount: sql<number>`count(*)::int`,
        // Показание любого вида, включая `no_data`: «счётчик не работает» — это ответ, а не пропуск.
        closedCount: sql<number>`count(${vehicleReadings.id})::int`,
        needsReacceptance: sql<boolean>`coalesce(bool_or(${driverDailyReports.state} = 'needs_reacceptance'), false)`,
        attention: sql<boolean>`coalesce(bool_or(${ITEM_NEEDS_ATTENTION}), false)`,
      })
      .from(driverDailyReportItems)
      .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
      .leftJoin(vehicleReadings, eq(vehicleReadings.itemId, driverDailyReportItems.id))
      .leftJoin(vehicleRoutes, eq(vehicleRoutes.id, driverDailyReportItems.routeId))
      .leftJoin(waybills, eq(waybills.id, driverDailyReportItems.waybillId))
      .where(
        and(
          inArray(driverDailyReportItems.vehicleId, vehicleIds),
          eq(driverDailyReportItems.reportDate, on),
          ne(driverDailyReports.state, 'voided'),
        ),
      )
      .groupBy(driverDailyReportItems.vehicleId),
    loadMissingSourceVehicles(on, vehicleIds),
  ]);

  for (const row of counts) {
    states.set(
      row.vehicleId,
      vehicleReadingDayState({
        itemCount: Number(row.itemCount),
        closedCount: Number(row.closedCount),
        hasDiscrepancy: row.attention || missing.has(row.vehicleId),
        hasNeedsReacceptance: row.needsReacceptance,
      }),
    );
  }

  // Машина, у которой строк ожидания нет вовсе, а источник дня в отчёт не вошёл: своей строки в
  // счётчике у неё не было, и без этого прохода несданный выезд остался бы незамеченным.
  for (const vehicleId of missing) {
    if (!states.has(vehicleId)) states.set(vehicleId, 'discrepancy');
  }
  return states;
}

// ── Журнал машины ──

/**
 * Предшественник каждого счётчика — своим алиасом той же таблицы: у одометра и моточасов цепочки
 * разные, и строка с одними моточасами ряда одометра не разрывает (Р20).
 */
const previousOdometer = alias(vehicleReadings, 'prev_odometer');
const previousEngineHours = alias(vehicleReadings, 'prev_engine_hours');

/** Число из `numeric`: драйвер отдаёт его строкой, и `null` обязан остаться `null`, а не нулём. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Моточасы в журнале — с десятой долей: разность двух `numeric` даёт хвост двоичного округления. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Аномалия счётчика вместе с тем, с чем сравнивали: без предшественника её не прочитать. */
function anomalyOf(
  kind: ReadingAnomaly | null,
  confirmedAt: Date | null,
  previousValue: number | null,
  previousDate: string | null,
): ReadingAnomalyDto | null {
  if (kind === null) return null;
  return { kind, confirmed: confirmedAt !== null, previousValue, previousDate };
}

/**
 * Журнал машины (Р27): день, смена, кто передал, три числа, разности по каждому счётчику со своим
 * предшественником, аномалии, фотографии и история правок.
 *
 * Разности берутся по **готовой цепочке**: предшественник каждого счётчика уже записан в
 * `previous_*_id`, и его значение достаётся своим алиасом той же таблицы. Считать «ближайшую
 * предыдущую строку» здесь заново значило бы завести второй ответ на вопрос, на который модуль
 * показаний уже ответил при записи.
 *
 * Страницы обычные, серверные (Р25): строка страницы и общее число строк периода. Прежнего предела
 * в 500 строк с флагом «хвост обрезан» здесь нет — он отвечал на вопрос «сколько сервер согласен
 * отдать», а спрашивают у журнала другое.
 */
export async function loadVehicleReadingJournal(
  vehicleId: string,
  query: { from: string; to: string; page: number; pageSize: number },
): Promise<VehicleReadingJournalDto | null> {
  const { from, to } = query;
  const [vehicle] = await db
    .select({
      id: vehicles.id,
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

  /**
   * Отбор один на страницу и на счётчик: два разных условия отвечали бы на «сколько всего строк» и
   * «какие строки показать» по-разному, и листание разъехалось бы с итогом на первом же отличии.
   */
  const where = and(
    eq(driverDailyReportItems.vehicleId, vehicleId),
    sql`${driverDailyReportItems.reportDate} BETWEEN ${from}::date AND ${to}::date`,
    ne(driverDailyReports.state, 'voided'),
  );
  const pg = pageParams(query);

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        itemId: driverDailyReportItems.id,
        reportId: driverDailyReportItems.reportId,
        reportDate: driverDailyReportItems.reportDate,
        shiftOrder: driverDailyReportItems.shiftOrder,
        reportState: driverDailyReports.state,
        sourceKind: driverDailyReportItems.sourceKind,
        routeId: driverDailyReportItems.routeId,
        routeNum: vehicleRoutes.num,
        waybillId: driverDailyReportItems.waybillId,
        waybillNumber: waybills.number,
        waybillPrefix: waybillSeries.prefix,
        waybillNumberWidth: waybillSeries.numberWidth,
        personId: driverDailyReports.personId,
        personName: persons.fullName,
        readingId: vehicleReadings.id,
        kind: vehicleReadings.kind,
        odometerKm: vehicleReadings.odometerKm,
        engineHours: vehicleReadings.engineHours,
        fuelStartLiters: vehicleReadings.fuelStartLiters,
        fuelFilledLiters: vehicleReadings.fuelFilledLiters,
        fuelEndLiters: vehicleReadings.fuelEndLiters,
        noDataReason: vehicleReadings.noDataReason,
        comment: vehicleReadings.comment,
        source: vehicleReadings.source,
        recordedAt: vehicleReadings.recordedAt,
        odometerAnomaly: vehicleReadings.odometerAnomaly,
        odometerAnomalyConfirmedAt: vehicleReadings.odometerAnomalyConfirmedAt,
        engineHoursAnomaly: vehicleReadings.engineHoursAnomaly,
        engineHoursAnomalyConfirmedAt: vehicleReadings.engineHoursAnomalyConfirmedAt,
        previousOdometerKm: previousOdometer.odometerKm,
        previousOdometerDate: previousOdometer.reportDate,
        previousEngineHours: previousEngineHours.engineHours,
        previousEngineHoursDate: previousEngineHours.reportDate,
      })
      .from(driverDailyReportItems)
      .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
      .innerJoin(persons, eq(persons.id, driverDailyReports.personId))
      .leftJoin(vehicleRoutes, eq(vehicleRoutes.id, driverDailyReportItems.routeId))
      .leftJoin(waybills, eq(waybills.id, driverDailyReportItems.waybillId))
      .leftJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
      .leftJoin(vehicleReadings, eq(vehicleReadings.itemId, driverDailyReportItems.id))
      .leftJoin(previousOdometer, eq(previousOdometer.id, vehicleReadings.previousOdometerId))
      .leftJoin(
        previousEngineHours,
        eq(previousEngineHours.id, vehicleReadings.previousEngineHoursId),
      )
      .where(where)
      /*
       * Свежее сверху: журнал открывают вопросом «что сдали вчера», а не «с чего всё началось».
       * Третьего ключа сортировки нет и не нужно: пара «день + позиция смены» у одной машины
       * уникальна (`report_items_chain_key`), то есть порядок уже полный, и страницы между
       * запросами не разъезжаются.
       */
      .orderBy(desc(driverDailyReportItems.reportDate), desc(driverDailyReportItems.shiftOrder))
      .limit(pg.limit)
      .offset(pg.offset),
    db
      .select({ total: count() })
      .from(driverDailyReportItems)
      .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
      .where(where),
  ]);

  const readingIds = rows.map((row) => row.readingId).filter((id): id is string => id !== null);
  const [readingFiles, edits] = await Promise.all([
    loadReadingFiles(readingIds),
    loadReadingEdits(readingIds),
  ]);

  /**
   * Показание строки, если оно есть. Проверяются все поля показания сразу, а не одно: строка без
   * показания приходит `leftJoin`'ом целиком пустой, и подставлять умолчания её полям значило бы
   * показать в журнале несданную смену как сданную неизвестно кем.
   */
  const readingOf = (row: (typeof rows)[number]): VehicleReadingDto | null => {
    if (row.readingId === null || row.kind === null || row.source === null) return null;
    if (row.recordedAt === null) return null;

    const previousKm = row.previousOdometerKm;
    const previousHours = num(row.previousEngineHours);
    const engineHours = num(row.engineHours);
    return {
      id: row.readingId,
      itemId: row.itemId,
      kind: row.kind,
      odometerKm: row.odometerKm,
      engineHours,
      /*
       * Три числа топлива живут только здесь, в построчном журнале, и ниже по файлу в сводку
       * периода не попадают: складывать за месяц можно лишь «Заправлено» — это поток, а остатки
       * на начало и конец смены — уровень в баке, и их сумма отвечает на несуществующий вопрос
       * (Р1). Строку же читают целиком, и без обоих концов по ней не видно, куда ушла заправка.
       */
      fuelStartLiters: num(row.fuelStartLiters),
      fuelFilledLiters: num(row.fuelFilledLiters),
      fuelEndLiters: num(row.fuelEndLiters),
      noDataReason: row.noDataReason ?? '',
      comment: row.comment ?? '',
      source: row.source,
      recordedAt: row.recordedAt.toISOString(),
      odometerAnomaly: anomalyOf(
        row.odometerAnomaly,
        row.odometerAnomalyConfirmedAt,
        previousKm,
        row.previousOdometerDate,
      ),
      engineHoursAnomaly: anomalyOf(
        row.engineHoursAnomaly,
        row.engineHoursAnomalyConfirmedAt,
        previousHours,
        row.previousEngineHoursDate,
      ),
      // Разность — только там, где есть оба конца: у первой строки ряда предшественника нет, и
      // прочерк здесь честнее нуля.
      odometerDelta:
        row.odometerKm === null || previousKm === null ? null : row.odometerKm - previousKm,
      engineHoursDelta:
        engineHours === null || previousHours === null
          ? null
          : round(engineHours - previousHours, 1),
      fileIds: (readingFiles.get(row.readingId) ?? []).map((file) => file.id),
    };
  };

  return {
    vehicleId,
    vehicleLabel: vehicleLabel(vehicle),
    from,
    to,
    total: Number(totalRows[0]?.total ?? 0),
    page: pg.page,
    pageSize: pg.pageSize,
    items: rows.map((row) => ({
      itemId: row.itemId,
      reportId: row.reportId,
      reportDate: row.reportDate,
      shiftOrder: row.shiftOrder,
      reportState: row.reportState,
      sourceKind: row.sourceKind,
      sourceId: row.routeId ?? row.waybillId ?? '',
      // Источник зовут его номером: рейс — «Р-142», недельный лист — номером бланка, как он
      // напечатан. Пустая подпись достижима только у листа без серии, которого не бывает.
      sourceLabel:
        row.sourceKind === 'route'
          ? row.routeNum === null
            ? ''
            : formatVehicleRouteNumber(row.routeNum)
          : row.waybillNumber === null || row.waybillPrefix === null
            ? ''
            : waybillDisplayNumber(
                row.waybillPrefix,
                row.waybillNumber,
                row.waybillNumberWidth ?? 0,
              ),
      personId: row.personId,
      personName: row.personName,
      files: row.readingId === null ? [] : (readingFiles.get(row.readingId) ?? []),
      edits: row.readingId === null ? [] : (edits.get(row.readingId) ?? []),
      reading: readingOf(row),
    })),
  };
}

async function loadReadingFiles(
  readingIds: string[],
): Promise<Map<string, VehicleReadingJournalRow['files']>> {
  const map = new Map<string, VehicleReadingJournalRow['files']>();
  if (readingIds.length === 0) return map;

  const rows = await db
    .select({
      readingId: vehicleReadingFiles.readingId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
    })
    .from(vehicleReadingFiles)
    .innerJoin(files, eq(files.id, vehicleReadingFiles.fileId))
    .where(inArray(vehicleReadingFiles.readingId, readingIds))
    .orderBy(asc(vehicleReadingFiles.addedAt));

  for (const row of rows) {
    const list = map.get(row.readingId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
    });
    map.set(row.readingId, list);
  }
  return map;
}

async function loadReadingEdits(
  readingIds: string[],
): Promise<Map<string, VehicleReadingJournalRow['edits']>> {
  const map = new Map<string, VehicleReadingJournalRow['edits']>();
  if (readingIds.length === 0) return map;

  const rows = await db
    .select({
      readingId: vehicleReadingHistory.readingId,
      event: vehicleReadingHistory.event,
      reason: vehicleReadingHistory.reason,
      changedAt: vehicleReadingHistory.changedAt,
      changedByName: users.fullName,
    })
    .from(vehicleReadingHistory)
    .innerJoin(users, eq(users.id, vehicleReadingHistory.changedBy))
    .where(inArray(vehicleReadingHistory.readingId, readingIds))
    .orderBy(asc(vehicleReadingHistory.changedAt));

  for (const row of rows) {
    const list = map.get(row.readingId) ?? [];
    list.push({
      event: row.event,
      changedAt: row.changedAt.toISOString(),
      changedByName: row.changedByName,
      reason: row.reason,
    });
    map.set(row.readingId, list);
  }
  return map;
}

// ── Лист сводки по парку ──

/** Прочерк в выгрузке — тот же, что на экране: неизвестное значение не притворяется нулём. */
function cell(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits).replace('.', ',');
}

/**
 * Лист сводки для книги Excel. Заголовки — те же слова, что в колонках экрана: файл читают рядом с
 * порталом, и лишняя колонка «на 100 км» в нём завела бы тот самый расход, которого портал не
 * считает (Р28), — только уже вне его контроля, в чужой книге с формулами.
 */
export function readingStatsSheet(rows: readonly VehicleReadingStatsRow[], period: string) {
  return {
    name: `Показания ${period}`,
    freezeHeader: true,
    widths: [38, 14, 16, 18, 12],
    rows: [
      ['Техника', 'Пробег, км', 'Наработка, м/ч', 'Заправлено топлива, л', 'Разрывов ряда'],
      ...rows.map((row) => [
        row.vehicleLabel,
        cell(row.distanceKm, 0),
        cell(row.engineHours, 1),
        cell(row.fuelFilledLiters, 1),
        String(row.gaps),
      ]),
    ],
  };
}
