import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type DiscrepancyKind,
  type DriverReportState,
  formatVehicleRouteNumber,
  type ReadingAnomaly,
  type ReadingAnomalyDto,
  type ReadingKind,
  type ReadingSourceKind,
  vehicleLabel,
  vehicleReadingDayState,
  type VehicleReadingDayState,
  type VehicleReadingDto,
  type VehicleReadingStatsRow,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
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

/**
 * Показания глазами гаража и сводки (ADR 0103, Р27/Р28): состояние дня машины, её журнал и итог по
 * парку за период.
 *
 * Файл читающий целиком — ни одной записи. Своих таблиц у гаража нет (ADR 0076), и таблицы модуля
 * показаний он **показывает**, как показывает рейсы, листы и заявки. Отсюда три правила, из которых
 * следует всё остальное:
 *
 * 1. **День машины считается по строкам ожидания**, а не по текущему набору источников (Р27):
 *    только так колонка отвечает однозначно и при двух сменах, и после правки задания. Само
 *    состояние собирает функция контракта `vehicleReadingDayState` — она одна на портал и сервер,
 *    и второй формулы в SQL здесь нет намеренно.
 * 2. **Пробег и наработка — суммы разностей соседних снимков одного счётчика** по готовой цепочке
 *    (`previous_odometer_id` / `previous_engine_hours_id`). Цепочку строит модуль показаний при
 *    записи; пересчитывать её на чтении значило бы завести второй ответ на вопрос «кто чей
 *    предшественник».
 * 3. **Портал считает заправленное топливо, и только его** (Р28). Ни расхода, ни производных
 *    «на сто километров»: цифра, поделённая на пробег, читается как расход независимо от подписи
 *    в колонке, а фактический расход требует остатков в баке, которых портал не хранит. Пробег и
 *    наработка при этом складываются из разностей соседних звеньев цепочки: сброс счётчика свою
 *    пару из суммы убирает, а период, где не осталось ни одной пары, даёт прочерк, а не ноль —
 *    догадываться о пробеге портал не берётся. Сколько раз ряд рвался, говорит своя колонка.
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
 * Фильтр «не сданы» — главный вопрос к экрану следующего утра (Р27).
 *
 * Считается по числу ожидающих строк (`pending_count > 0`), теми же строками ожидания, что и сама
 * колонка: два разных ответа на «сдано ли» разъехались бы при первом изменении правила. Машина без
 * задания в отбор не попадает — ждать с неё нечего.
 *
 * Тег в отобранной строке иногда говорит «расхождение», а не «частично», и это не противоречие:
 * фильтр отвечает «по этой машине ещё ждут показания», а тег называет главное — то, с чем надо
 * что-то делать в первую очередь.
 */
export function pendingReadingsSql(on: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${driverDailyReportItems} pr_i
    JOIN ${driverDailyReports} pr_rep ON pr_rep.id = pr_i.report_id
    WHERE pr_i.vehicle_id = ${vehicles.id}
      AND pr_i.report_date = ${on}::date
      AND pr_rep.state <> 'voided'
      AND NOT EXISTS (
        SELECT 1 FROM ${vehicleReadings} pr_r WHERE pr_r.item_id = pr_i.id
      )
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
 */
const SUBMITTED_STATES: DriverReportState[] = ['submitted', 'accepted', 'needs_reacceptance'];

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
      .select({ vehicleId: vehicleRoutes.vehicleId })
      .from(vehicleRoutes)
      .innerJoin(
        driverDailyReports,
        and(
          eq(driverDailyReports.personId, vehicleRoutes.driverPersonId),
          eq(driverDailyReports.reportDate, vehicleRoutes.routeDate),
        ),
      )
      .where(
        and(
          inArray(vehicleRoutes.vehicleId, vehicleIds),
          eq(vehicleRoutes.routeDate, on),
          inArray(driverDailyReports.state, SUBMITTED_STATES),
          sql`NOT EXISTS (
            SELECT 1 FROM ${driverDailyReportItems} ms_i WHERE ms_i.route_id = ${vehicleRoutes.id}
          )`,
          sql`NOT ${missingSourceResolvedSql('route', sql`${vehicleRoutes.id}`)}`,
        ),
      ),
    db
      .select({ vehicleId: waybills.vehicleId })
      .from(waybills)
      .innerJoin(
        driverDailyReports,
        and(
          eq(driverDailyReports.personId, waybills.driverPersonId),
          eq(driverDailyReports.reportDate, on),
        ),
      )
      .where(
        and(
          inArray(waybills.vehicleId, vehicleIds),
          eq(waybills.formCode, 'esm2'),
          ne(waybills.status, 'cancelled'),
          sql`${waybills.periodFrom} <= ${on}::date AND ${waybills.periodTo} >= ${on}::date`,
          inArray(driverDailyReports.state, SUBMITTED_STATES),
          sql`NOT EXISTS (
            SELECT 1 FROM ${driverDailyReportItems} ms_i
            WHERE ms_i.waybill_id = ${waybills.id} AND ms_i.report_date = ${on}::date
          )`,
          sql`NOT ${missingSourceResolvedSql('waybill', sql`${waybills.id}`)}`,
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
 * Строка журнала: чей день, какая смена и что с показанием. Тип живёт здесь, а не в контрактах:
 * этап трогать `packages/contracts` не должен, а показание внутри — уже готовый `VehicleReadingDto`.
 */
export interface VehicleReadingJournalRow {
  itemId: string;
  reportId: string;
  reportDate: string;
  shiftOrder: number;
  reportState: DriverReportState;
  sourceKind: ReadingSourceKind;
  sourceId: string;
  /** «Р-142» либо номер бланка ЭСМ-2 — тем же правилом, каким источник зовут везде. */
  sourceLabel: string;
  personId: string;
  personName: string;
  reading: VehicleReadingDto | null;
  /**
   * Файлы показания с именами. Одних идентификаторов (`reading.fileIds`) журналу мало: фотографию
   * приборной панели открывают прямо из строки, а список без имён и типов показать нечем.
   */
  files: { id: string; filename: string; contentType: string; size: number }[];
  /** История правок показания: кто, когда и с какой причиной трогал чужие числа (Р19). */
  edits: { event: string; changedAt: string; changedByName: string; reason: string }[];
}

export interface VehicleReadingJournalDto {
  vehicleId: string;
  vehicleLabel: string;
  from: string;
  to: string;
  items: VehicleReadingJournalRow[];
  /** Хвост периода обрезан пределом: журнал открывают на месяц, а не на всю жизнь машины. */
  truncated: boolean;
}

const JOURNAL_LIMIT = 500;

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
 */
export async function loadVehicleReadingJournal(
  vehicleId: string,
  from: string,
  to: string,
): Promise<VehicleReadingJournalDto | null> {
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

  const rows = await db
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
      fuelFilledLiters: vehicleReadings.fuelFilledLiters,
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
    .where(
      and(
        eq(driverDailyReportItems.vehicleId, vehicleId),
        sql`${driverDailyReportItems.reportDate} BETWEEN ${from}::date AND ${to}::date`,
        ne(driverDailyReports.state, 'voided'),
      ),
    )
    // Свежее сверху: журнал открывают вопросом «что сдали вчера», а не «с чего всё началось».
    .orderBy(desc(driverDailyReportItems.reportDate), desc(driverDailyReportItems.shiftOrder))
    .limit(JOURNAL_LIMIT + 1);

  const page = rows.slice(0, JOURNAL_LIMIT);
  const readingIds = page.map((row) => row.readingId).filter((id): id is string => id !== null);
  const [readingFiles, edits] = await Promise.all([
    loadReadingFiles(readingIds),
    loadReadingEdits(readingIds),
  ]);

  /**
   * Показание строки, если оно есть. Проверяются все поля показания сразу, а не одно: строка без
   * показания приходит `leftJoin`'ом целиком пустой, и подставлять умолчания её полям значило бы
   * показать в журнале несданную смену как сданную неизвестно кем.
   */
  const readingOf = (row: (typeof page)[number]): VehicleReadingDto | null => {
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
      fuelFilledLiters: num(row.fuelFilledLiters),
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
    truncated: rows.length > JOURNAL_LIMIT,
    items: page.map((row) => ({
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

// ── Сводка по парку ──

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Точка ряда: строка ожидания вместе со своим показанием — та же пара, что и в журнале. */
interface ChainPoint {
  readingId: string | null;
  kind: ReadingKind | null;
  odometerKm: number | null;
  engineHours: number | null;
  fuelFilledLiters: number | null;
  previousOdometerId: string | null;
  previousEngineHoursId: string | null;
  odometerAnomaly: ReadingAnomaly | null;
  engineHoursAnomaly: ReadingAnomaly | null;
}

/**
 * Итог одного счётчика: сумма разностей соседних звеньев цепочки.
 *
 * Разность берётся у пары, **обе точки которой лежат в периоде**: у первого снимка периода
 * предшественник остался за его границей, и его разность отвечала бы за работу, сделанную до
 * начала периода. Строка со сбросом счётчика (`counter_reset`) в расчёт не идёт вовсе — ряд на ней
 * рвётся (Р20), и её пара сказала бы про пробег заведомую неправду.
 *
 * Пропущенная смена (`no_data`, несданная строка) пару не рвёт, и это осознанно: предшественником
 * такой строки цепочка назначает последний снимок с числом, поэтому разность накрывает пропуск
 * целиком. Машина эти километры проехала, и потерять их значило бы занизить пробег периода; чего
 * по ним не известно — так это распределения по дням, и об этом говорит счётчик разрывов рядом.
 *
 * Литры к разностям не приплетаются вовсе: портал считает заправленное топливо, и производных
 * показателей у него нет (Р28). Цифра, поделённая на пробег, читалась бы как расход независимо от
 * подписи в колонке, а фактический расход требует остатков в баке, которых портал не хранит.
 */
function counterTotal(
  points: ChainPoint[],
  pick: (point: ChainPoint) => {
    value: number | null;
    previousId: string | null;
    anomaly: ReadingAnomaly | null;
  },
): number | null {
  const byId = new Map<string, ChainPoint>();
  for (const point of points) if (point.readingId !== null) byId.set(point.readingId, point);

  let total: number | null = null;
  for (const point of points) {
    const current = pick(point);
    const previous = current.previousId === null ? undefined : byId.get(current.previousId);
    const previousValue = previous === undefined ? null : pick(previous).value;

    if (current.value !== null && previousValue !== null && current.anomaly !== 'counter_reset') {
      total = (total ?? 0) + (current.value - previousValue);
    }
  }
  return total;
}

/**
 * Разрыв ряда: строка ожидания, на которой ряд прервался, — без числового показания (несдана либо
 * `no_data`) или со сброшенным счётчиком. Число это в строке сводки стоит рядом с прочерком и
 * объясняет его: пустой пробег у работавшей машины — не ошибка отчёта, а разорванный ряд.
 */
function gapsOf(points: ChainPoint[]): number {
  return points.filter(
    (point) =>
      point.kind !== 'values' ||
      point.odometerAnomaly === 'counter_reset' ||
      point.engineHoursAnomaly === 'counter_reset',
  ).length;
}

/**
 * Сводка по парку за период (Р27): пробег, наработка и заправленное топливо по каждой
 * машине, работавшей в периоде.
 *
 * В списке стоят машины, у которых в периоде есть хотя бы одна строка ожидания: сводка отвечает про
 * работавшую технику, и полный парк с прочерками в каждой строке отвечал бы на другой вопрос.
 */
export async function loadFleetReadingStats(
  from: string,
  to: string,
): Promise<VehicleReadingStatsRow[]> {
  const rows = await db
    .select({
      vehicleId: driverDailyReportItems.vehicleId,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      modelName: vehicleModels.name,
      readingId: vehicleReadings.id,
      kind: vehicleReadings.kind,
      odometerKm: vehicleReadings.odometerKm,
      engineHours: vehicleReadings.engineHours,
      fuelFilledLiters: vehicleReadings.fuelFilledLiters,
      previousOdometerId: vehicleReadings.previousOdometerId,
      previousEngineHoursId: vehicleReadings.previousEngineHoursId,
      odometerAnomaly: vehicleReadings.odometerAnomaly,
      engineHoursAnomaly: vehicleReadings.engineHoursAnomaly,
    })
    .from(driverDailyReportItems)
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
    .innerJoin(vehicles, eq(vehicles.id, driverDailyReportItems.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(vehicleReadings, eq(vehicleReadings.itemId, driverDailyReportItems.id))
    .where(
      and(
        sql`${driverDailyReportItems.reportDate} BETWEEN ${from}::date AND ${to}::date`,
        ne(driverDailyReports.state, 'voided'),
      ),
    )
    // Порядок ряда — тот же, что у цепочки (Р15): день, затем позиция смены. Госномер третьим
    // ключом собирает строки одной машины подряд и задаёт порядок самой сводки.
    .orderBy(
      asc(vehicles.registrationNumberNormalized),
      asc(driverDailyReportItems.vehicleId),
      asc(driverDailyReportItems.reportDate),
      asc(driverDailyReportItems.shiftOrder),
    );

  const byVehicle = new Map<string, { label: string; points: ChainPoint[] }>();
  for (const row of rows) {
    const entry = byVehicle.get(row.vehicleId) ?? { label: vehicleLabel(row), points: [] };
    entry.points.push({
      readingId: row.readingId,
      kind: row.kind,
      odometerKm: row.odometerKm,
      engineHours: num(row.engineHours),
      fuelFilledLiters: num(row.fuelFilledLiters),
      previousOdometerId: row.previousOdometerId,
      previousEngineHoursId: row.previousEngineHoursId,
      odometerAnomaly: row.odometerAnomaly,
      engineHoursAnomaly: row.engineHoursAnomaly,
    });
    byVehicle.set(row.vehicleId, entry);
  }

  return [...byVehicle].map(([vehicleId, entry]) => {
    const odometer = counterTotal(entry.points, (point) => ({
      value: point.odometerKm,
      previousId: point.previousOdometerId,
      anomaly: point.odometerAnomaly,
    }));
    const engine = counterTotal(entry.points, (point) => ({
      value: point.engineHours,
      previousId: point.previousEngineHoursId,
      anomaly: point.engineHoursAnomaly,
    }));
    const fuel = entry.points.reduce((sum, point) => sum + (point.fuelFilledLiters ?? 0), 0);

    return {
      vehicleId,
      vehicleLabel: entry.label,
      distanceKm: odometer === null ? null : Math.round(odometer),
      engineHours: engine === null ? null : round(engine, 1),
      // Заправлено за период — сумма литров смен, и рядом с ней ничего не делится на пробег (Р28).
      fuelFilledLiters: round(fuel, 1),
      gaps: gapsOf(entry.points),
    };
  });
}

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
