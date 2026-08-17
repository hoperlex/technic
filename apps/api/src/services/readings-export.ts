import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  driverReportStateLabels,
  formatVehicleRouteNumber,
  maintenanceStateLabels,
  type ReadingAnomaly,
  readingAnomalyLabels,
  type ReadingExportKind,
  readingExportKindLabels,
  type ReadingMonthRow,
  vehicleLabel,
  type VehicleMaintenanceSummaryDto,
  type VehicleReadingStatsRow,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  driverDailyReportItems,
  driverDailyReports,
  persons,
  vehicleCategories,
  vehicleModels,
  vehicleReadings,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeWorkbook, type SheetInput } from '../lib/xlsx';
import {
  loadFleetMonths,
  loadFleetStats,
  loadLastOdometers,
  loadLastReadings,
} from './readings-aggregate';
import { readingStatsSheet } from './readings-stats';
import { loadMaintenanceSnapshot } from './vehicle-maintenance';

/**
 * Выгрузки показаний — один сборщик, вариант параметром (план «Показания техники», Р18, §8).
 *
 * Собирает он шесть книг: сводку по парку (её портал выгружает и сегодня), помесячную матрицу,
 * журнал одной машины сплошняком и по месяцам-листам, срез счётчиков на дату и журнал всего парка.
 * Развилка одна и она здесь — `buildReadingsExport`; ручка ничего про состав книг не знает и
 * второй сборки ни одной из них в проекте нет.
 *
 * Четыре правила, из которых следует всё остальное:
 *
 * 1. **Ни одного производного показателя** (Р28, §8). Ни «на 100 км», ни «на моточас»: расхода
 *    портал не считает — фактический требует остатков в баке, которых он не хранит, — а цифра,
 *    поделённая на пробег, читается как расход независимо от подписи. В книге с формулами, которую
 *    правят у себя, такая колонка завела бы расход окончательно вне контроля портала.
 * 2. **Прочерк вместо нуля** там, где значение неизвестно: пустой месяц, оборванный ряд, машина
 *    без единого снимка счётчика. Ноль в такой ячейке читался бы как «стояла».
 * 3. **Заголовки — те же слова, что в колонках экрана**: файл читают рядом с порталом, и колонка,
 *    названная в книге иначе, заставляет сверять два словаря вместо чисел.
 * 4. **Данные ТО живут под своим правом** (Р14а, Р14б): колонки среза про обслуживание приходят
 *    только тому, у кого есть `vehicleMaintenance.read`, и приходят они целиком либо не приходят
 *    вовсе. Пустая колонка «Дата ТО» соврала бы про парк («обслуживания не было»), тогда как
 *    отсутствие колонки не говорит про ТО ничего — тем же приёмом гараж отдаёт свой одометр
 *    ([routes/garage.ts:296](../routes/garage.ts)).
 *
 * Считает при этом не этот файл: пробег, наработку, месяцы и последние показания обоих счётчиков
 * даёт агрегат (`readings-aggregate.ts`), состояние обслуживания — `vehicle-maintenance.ts`,
 * сводный лист рисует `readingStatsSheet` там же, где он рисовался до появления этой ручки. Свой
 * SQL здесь ровно один: строки журнала — постранично их отдаёт `loadVehicleReadingJournal`, а
 * книге нужен весь период целиком и по всему парку.
 */

// ── Ячейки ──

/**
 * Прочерк в выгрузке — тот же, что на экране: неизвестное значение не притворяется нулём. Правило
 * повторяет `cell` сводного листа (`readings-stats.ts`) намеренно — это форматирование ячейки, а
 * не расчёт, и делить его на два файла ради одной строки дороже, чем повторить.
 */
function cell(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits).replace('.', ',');
}

/** Дата в ячейке — как её показывает портал: `14.08.2026`. Через `Date` она уехала бы на день. */
function ru(date: string | null): string {
  if (date === null || date === '') return '—';
  const [y, m, d] = date.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : date;
}

/** Период в подписи листа и в имени файла — тем же видом, каким его выбирали на экране. */
function periodLabel(from: string, to: string): string {
  return from === to ? from : `${from} – ${to}`;
}

/** `2026-08` → `08.2026`: месяц в шапке колонки и в имени листа. */
function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  return year && m ? `${m}.${year}` : month;
}

/**
 * Все месяцы периода, включая те, в которых у машины не было ни одной смены. Колонка пустого
 * месяца — прочерк, а не пропуск: месяц, исчезнувший из шапки, читается как потерянный, и книгу
 * за первое полугодие пришлось бы сверять с календарём.
 */
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let guard = 0; guard < 400; guard += 1) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

// ── Помесячная матрица по парку ──

/**
 * Счётчики помесячной книги: лист на каждый. Одним листом «месяц × три числа» книга дала бы
 * тридцать шесть колонок на годовом периоде, и сводную таблицу по ней уже не построить — а строят
 * её ровно ради одного числа за месяц.
 *
 * Наработка на листе названа моточасами словом: косую черту Excel в имени листа не принимает
 * вовсе, и «м/ч» превратилось бы в «м ч» — сокращение, которого нет ни на одном экране. В шапках
 * колонок единица остаётся прежней.
 */
const MONTH_COUNTERS: {
  name: string;
  digits: number;
  pick: (month: ReadingMonthRow) => number | null;
  total: (row: VehicleReadingStatsRow) => number | null;
  /** Разрывы объясняют прочерк там, где число — разность снимков. Заправленное их не знает. */
  withGaps: boolean;
}[] = [
  {
    name: 'Пробег, км',
    digits: 0,
    pick: (m) => m.distanceKm,
    total: (row) => row.distanceKm,
    withGaps: true,
  },
  {
    name: 'Наработка, моточасы',
    digits: 1,
    pick: (m) => m.engineHours,
    total: (row) => row.engineHours,
    withGaps: true,
  },
  {
    name: 'Заправлено топлива, л',
    digits: 1,
    pick: (m) => m.fuelFilledLiters,
    total: (row) => row.fuelFilledLiters,
    withGaps: false,
  },
];

/**
 * Помесячная книга: строка — машина, колонка — месяц. Итог за период берётся у сводки, а не
 * складывается здесь: сумма месяцев равна итогу по построению (Р4), и второе сложение рядом с
 * первым — это второй ответ на вопрос «сколько за период».
 */
function fleetMonthsSheets(
  stats: readonly VehicleReadingStatsRow[],
  monthsByVehicle: Map<string, ReadingMonthRow[]>,
  from: string,
  to: string,
): SheetInput[] {
  const months = monthsBetween(from, to);
  return MONTH_COUNTERS.map((counter) => ({
    name: counter.name,
    freezeHeader: true,
    widths: [38, ...months.map(() => 12), 16, 14],
    rows: [
      [
        'Техника',
        ...months.map(monthLabel),
        'Итого за период',
        ...(counter.withGaps ? ['Разрывов ряда'] : []),
      ],
      ...stats.map((row) => {
        const byMonth = new Map(
          (monthsByVehicle.get(row.vehicleId) ?? []).map((month) => [month.month, month]),
        );
        return [
          row.vehicleLabel,
          ...months.map((month) => {
            const found = byMonth.get(month);
            return found === undefined ? '—' : cell(counter.pick(found), counter.digits);
          }),
          cell(counter.total(row), counter.digits),
          ...(counter.withGaps ? [String(row.gaps)] : []),
        ];
      }),
    ],
  }));
}

// ── Журнал ──

/** Предшественник каждого счётчика — своим алиасом: цепочки одометра и моточасов независимы. */
const previousOdometer = alias(vehicleReadings, 'exp_prev_odometer');
const previousEngineHours = alias(vehicleReadings, 'exp_prev_engine_hours');

/**
 * Отбор строк журнала: смены периода, машина — вся или одна, аннулированные отчёты не в счёт
 * (Р27). Он один на счётчик строк и на сами строки: два условия отвечали бы на «сколько строк» и
 * «какие строки» по-разному, и предел срабатывал бы не на той книге, которую собирают.
 */
function journalWhere(from: string, to: string, vehicleId: string | null) {
  return and(
    vehicleId === null ? undefined : eq(driverDailyReportItems.vehicleId, vehicleId),
    sql`${driverDailyReportItems.reportDate} BETWEEN ${from}::date AND ${to}::date`,
    ne(driverDailyReports.state, 'voided'),
  );
}

async function countJournalRows(
  from: string,
  to: string,
  vehicleId: string | null,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(driverDailyReportItems)
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
    .where(journalWhere(from, to, vehicleId));
  return Number(row?.total ?? 0);
}

/**
 * Строки журнала за период целиком — по одной машине либо по всему парку.
 *
 * Своя выборка, а не `loadVehicleReadingJournal`, и причин две. Экранный журнал отдаёт **страницу**
 * одной машины с фотографиями и историей правок — книге не нужно ни первого (страницу пришлось бы
 * листать запросами), ни второго (снимок в ячейку не положишь). А журнал всего парка он не умеет
 * вовсе: адресован он машиной. Общее у них — правило разностей, и оно не дублируется: прирост
 * обоим даёт готовая цепочка `previous_*_id`, которую модуль показаний строит при записи.
 *
 * Порядок — хронологический (машина, день, смена), а не «свежее сверху», как на экране: книгу
 * читают лентой и подшивают, а вопрос «что сдали вчера» задают порталу, а не файлу.
 */
async function loadJournalRows(from: string, to: string, vehicleId: string | null) {
  return db
    .select({
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      modelName: vehicleModels.name,
      reportDate: driverDailyReportItems.reportDate,
      shiftOrder: driverDailyReportItems.shiftOrder,
      reportState: driverDailyReports.state,
      sourceKind: driverDailyReportItems.sourceKind,
      routeNum: vehicleRoutes.num,
      waybillNumber: waybills.number,
      waybillPrefix: waybillSeries.prefix,
      waybillNumberWidth: waybillSeries.numberWidth,
      personName: persons.fullName,
      readingId: vehicleReadings.id,
      kind: vehicleReadings.kind,
      odometerKm: vehicleReadings.odometerKm,
      engineHours: vehicleReadings.engineHours,
      fuelFilledLiters: vehicleReadings.fuelFilledLiters,
      noDataReason: vehicleReadings.noDataReason,
      comment: vehicleReadings.comment,
      source: vehicleReadings.source,
      odometerAnomaly: vehicleReadings.odometerAnomaly,
      odometerAnomalyConfirmedAt: vehicleReadings.odometerAnomalyConfirmedAt,
      engineHoursAnomaly: vehicleReadings.engineHoursAnomaly,
      engineHoursAnomalyConfirmedAt: vehicleReadings.engineHoursAnomalyConfirmedAt,
      previousOdometerKm: previousOdometer.odometerKm,
      previousEngineHours: previousEngineHours.engineHours,
    })
    .from(driverDailyReportItems)
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
    .innerJoin(persons, eq(persons.id, driverDailyReports.personId))
    .innerJoin(vehicles, eq(vehicles.id, driverDailyReportItems.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(vehicleRoutes, eq(vehicleRoutes.id, driverDailyReportItems.routeId))
    .leftJoin(waybills, eq(waybills.id, driverDailyReportItems.waybillId))
    .leftJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .leftJoin(vehicleReadings, eq(vehicleReadings.itemId, driverDailyReportItems.id))
    .leftJoin(previousOdometer, eq(previousOdometer.id, vehicleReadings.previousOdometerId))
    .leftJoin(
      previousEngineHours,
      eq(previousEngineHours.id, vehicleReadings.previousEngineHoursId),
    )
    .where(journalWhere(from, to, vehicleId))
    .orderBy(
      asc(vehicles.registrationNumberNormalized),
      asc(driverDailyReportItems.reportDate),
      asc(driverDailyReportItems.shiftOrder),
    );
}

type JournalRow = Awaited<ReturnType<typeof loadJournalRows>>[number];

/** Число из `numeric`: драйвер отдаёт его строкой, и `null` обязан остаться `null`, а не нулём. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Моточасы — с десятой долей: разность двух `numeric` даёт хвост двоичного округления. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Источник зовут его номером — тем же правилом, каким его зовёт журнал на экране. */
function sourceLabelOf(row: JournalRow): string {
  if (row.sourceKind === 'route') {
    return row.routeNum === null ? '—' : formatVehicleRouteNumber(row.routeNum);
  }
  return row.waybillNumber === null || row.waybillPrefix === null
    ? '—'
    : `${waybillDisplayNumber(row.waybillPrefix, row.waybillNumber, row.waybillNumberWidth ?? 0)} (ЭСМ-2)`;
}

function anomalyText(
  kind: ReadingAnomaly | null,
  confirmedAt: Date | null,
  counter: string,
): string {
  if (kind === null) return '';
  return `${counter}: ${readingAnomalyLabels[kind]}${confirmedAt === null ? '' : ' · подтверждена'}`;
}

/**
 * Что со строкой — теми же словами, какими её называет окно журнала: «не сдано», «нет данных» с
 * причиной, иначе — кем показание внесено и с каким комментарием. Строка без показания из книги не
 * выпадает: «смена была, цифр нет» и есть то, ради чего журнал открывают.
 */
function readingStateText(row: JournalRow): string {
  if (row.readingId === null || row.kind === null || row.source === null) return 'не сдано';
  if (row.kind === 'no_data') {
    return `нет данных${row.noDataReason ? `: ${row.noDataReason}` : ''}`;
  }
  const who = row.source === 'staff' ? 'внесено персоналом' : 'передано водителем';
  return row.comment ? `${who} · ${row.comment}` : who;
}

const JOURNAL_HEADER = [
  'День',
  'Смена',
  'Источник',
  'Кто передал',
  'Состояние отчёта',
  'Одометр, км',
  'Прирост, км',
  'Моточасы, м/ч',
  'Прирост, м/ч',
  'Заправлено, л',
  'Аномалии',
  'Показание',
];
const JOURNAL_WIDTHS = [12, 8, 18, 28, 18, 14, 12, 14, 12, 12, 34, 40];
const VEHICLE_COLUMN = { header: 'Техника', width: 38 };

/**
 * Строка книги из строки журнала. Приросты — только там, где есть оба конца: у начала ряда и после
 * разрыва предшественника нет, и прочерк здесь честнее нуля.
 *
 * Колонки «Файлы» в книге нет намеренно: фотографию приборной панели в ячейку не положишь, а
 * колонка со счётчиком снимков обещала бы файл, которого в книге не окажется. Их смотрят в журнале
 * портала, куда книга и отсылает днём и сменой.
 */
function journalRow(row: JournalRow, withVehicle: boolean): string[] {
  const engineHours = num(row.engineHours);
  const previousHours = num(row.previousEngineHours);
  const odometerDelta =
    row.odometerKm === null || row.previousOdometerKm === null
      ? null
      : row.odometerKm - row.previousOdometerKm;
  const hoursDelta =
    engineHours === null || previousHours === null ? null : round1(engineHours - previousHours);

  return [
    ...(withVehicle ? [vehicleLabel(row)] : []),
    ru(row.reportDate),
    String(row.shiftOrder),
    sourceLabelOf(row),
    row.personName,
    driverReportStateLabels[row.reportState].toLowerCase(),
    cell(row.odometerKm, 0),
    cell(odometerDelta, 0),
    cell(engineHours, 1),
    cell(hoursDelta, 1),
    cell(num(row.fuelFilledLiters), 1),
    [
      anomalyText(row.odometerAnomaly, row.odometerAnomalyConfirmedAt, 'одометр'),
      anomalyText(row.engineHoursAnomaly, row.engineHoursAnomalyConfirmedAt, 'моточасы'),
    ]
      .filter(Boolean)
      .join('; '),
    readingStateText(row),
  ];
}

function journalSheet(name: string, rows: readonly JournalRow[], withVehicle: boolean): SheetInput {
  return {
    name,
    freezeHeader: true,
    widths: withVehicle ? [VEHICLE_COLUMN.width, ...JOURNAL_WIDTHS] : JOURNAL_WIDTHS,
    rows: [
      withVehicle ? [VEHICLE_COLUMN.header, ...JOURNAL_HEADER] : [...JOURNAL_HEADER],
      ...rows.map((row) => journalRow(row, withVehicle)),
    ],
  };
}

/**
 * Журнал по месяцам: месяц — лист. Листы заводятся на **все** месяцы периода, включая пустые: лист
 * с одной шапкой говорит «в этом месяце смен не было», а пропущенный заставлял бы гадать, был ли
 * месяц в выгрузке вообще.
 */
function journalMonthSheets(rows: readonly JournalRow[], from: string, to: string): SheetInput[] {
  const byMonth = new Map<string, JournalRow[]>();
  for (const row of rows) {
    const month = row.reportDate.slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(row);
    byMonth.set(month, list);
  }
  return monthsBetween(from, to).map((month) =>
    journalSheet(monthLabel(month), byMonth.get(month) ?? [], false),
  );
}

// ── Срез на дату ──

const SNAPSHOT_HEADER = [
  'Техника',
  'Одометр, км',
  'Одометр снят',
  'Моточасы, м/ч',
  'Моточасы сняты',
];
const MAINTENANCE_HEADER = ['Дата ТО', 'Пробег с ТО, км', 'Состояние ТО'];

/**
 * Пробег с ТО в ячейке. `lowerBound` — не украшение: между последним снимком и днём среза остались
 * несданные смены, и число известно только снизу (Р11в). «8 340» без этой оговорки читалось бы как
 * точный пробег, по которому решают, гнать ли машину на ТО.
 */
function kmSinceText(summary: VehicleMaintenanceSummaryDto): string {
  if (summary.kmSince === null) return '—';
  return `${summary.lowerBound ? 'не меньше ' : ''}${cell(summary.kmSince, 0)}`;
}

function snapshotSheet(
  stats: readonly VehicleReadingStatsRow[],
  odometers: Map<string, { km: number; measuredOn: string }>,
  engineHours: Map<string, { value: number; measuredOn: string }>,
  maintenance: Map<string, VehicleMaintenanceSummaryDto> | null,
  on: string,
): SheetInput {
  return {
    name: `Срез на ${on}`,
    freezeHeader: true,
    widths: [38, 14, 14, 14, 14, ...(maintenance === null ? [] : [14, 18, 16])],
    rows: [
      [...SNAPSHOT_HEADER, ...(maintenance === null ? [] : MAINTENANCE_HEADER)],
      ...stats.map((row) => {
        const odometer = odometers.get(row.vehicleId) ?? null;
        const hours = engineHours.get(row.vehicleId) ?? null;
        const summary = maintenance?.get(row.vehicleId) ?? null;
        return [
          row.vehicleLabel,
          cell(odometer?.km ?? null, 0),
          ru(odometer?.measuredOn ?? null),
          cell(hours?.value ?? null, 1),
          ru(hours?.measuredOn ?? null),
          ...(maintenance === null
            ? []
            : [
                ru(summary?.lastMaintenance?.performedOn ?? null),
                summary === null ? '—' : kmSinceText(summary),
                summary === null ? '—' : maintenanceStateLabels[summary.state],
              ]),
        ];
      }),
    ],
  };
}

// ── Наружу ──

/**
 * Потолок построчных выгрузок (Р31).
 *
 * По длине периода потолок уже стоит на ручке (год), и сводным книгам его достаточно: год по парку
 * — это 2 400 строк ответа. У построчных строк столько же, сколько смен в периоде, а
 * `writeWorkbook` собирает XML всех листов и ZIP целиком в памяти — поэтому у них свой предел, и
 * стоит он по замеру сборки книги (13 колонок, узел разработки, node 22):
 *
 * | строк | время | файл | пик RSS |
 * | --- | --- | --- | --- |
 * | 10 000 | 0,28 с | 0,6 МБ | 164 МБ |
 * | 25 000 | 0,64 с | 1,6 МБ | 234 МБ |
 * | 50 000 | 1,3 с | 3,1 МБ | 376 МБ |
 * | 100 000 | 2,8 с | 6,3 МБ | 665 МБ |
 * | 200 000 | 6,2 с | 12,6 МБ | 1 237 МБ |
 * | 400 000 | 12,2 с | 25,3 МБ | 2 395 МБ |
 *
 * Пустой процесс занимает 68 МБ, то есть строка книги стоит около 5,7 КБ памяти и 30 мкс — кривая
 * линейна до конца замера, и упирается она не в сборку, а в предел кучи node (здесь 2 ГБ): на
 * 400 000 строк от него остаётся четверть. Пятьдесят тысяч — та граница, где выгрузка ещё стоит
 * треть гигабайта пика и полторы секунды, то есть переживает несколько одновременных запросов.
 * Годовой объём парка (200 машин, ~150 тыс. смен) в неё не помещается намеренно: книга на 150 тысяч
 * строк — это не отчёт, а выгрузка базы.
 *
 * Отказ приходит **до** сборки, счётом строк, и говорит, сколько их и что делать. Молчаливое
 * обрезание здесь было бы худшим из решений: подписывают и сверяют выгрузку целиком, а обрезанная
 * книга ничем не отличается от полной, кроме отсутствующего хвоста.
 */
export const READING_EXPORT_ROW_LIMIT = 50_000;

export interface ReadingsExportRequest {
  kind: ReadingExportKind;
  from: string;
  to: string;
  /** Только у вариантов про одну машину; у остальных схема запроса его не пропускает. */
  vehicleId?: string | undefined;
  /**
   * Есть ли у запрашивающего `vehicleMaintenance.read` (Р14а). Право приходит решённым, а не
   * принципалом: сборщик книг не место для разбора прав, но и умолчания у этого флага нет — забыть
   * его значило бы раздать данные ТО всем, кто добрался до выгрузок.
   */
  withMaintenance: boolean;
}

export interface ReadingsExportResult {
  /** Имя файла целиком, с расширением: его же портал показывает в списке загрузок. */
  filename: string;
  bytes: Uint8Array;
}

/** Подпись машины для имени файла — по той же машине, что и книга. */
async function vehicleLabelOf(vehicleId: string): Promise<string | null> {
  const [row] = await db
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
  return row ? vehicleLabel(row) : null;
}

/** Строки журнала с проверкой предела: отказ до сборки книги, а не после (Р31). */
async function journalRowsWithLimit(from: string, to: string, vehicleId: string | null) {
  const total = await countJournalRows(from, to, vehicleId);
  if (total > READING_EXPORT_ROW_LIMIT) {
    throw err.badRequest(
      `В выгрузку попадает ${total} строк, предел — ${READING_EXPORT_ROW_LIMIT}: сузьте период`,
      { to: 'Сузьте период' },
    );
  }
  return loadJournalRows(from, to, vehicleId);
}

/**
 * Книга выбранного варианта (Р18). Право на данные ТО приходит решённым флагом, период — уже
 * проверенным на длину: и то и другое дело ручки, а не сборщика.
 *
 * Состав каждой книги:
 *
 * - `fleetSummary` — лист сводки: пробег, наработка, заправленное, разрывы (та самая книга, что
 *   выгружается сегодня, и рисует её тот же `readingStatsSheet`);
 * - `fleetMonths` — три листа-матрицы «машина × месяц»: пробег, наработка, заправленное;
 * - `vehicleJournal` — лист построчного журнала одной машины;
 * - `vehicleMonths` — тот же журнал, месяц отдельным листом;
 * - `snapshot` — лист среза на `to`: последние счётчики с датами и, под своим правом, ТО;
 * - `fleetJournal` — построчный журнал всего парка одним листом, машина первой колонкой.
 */
export async function buildReadingsExport(
  request: ReadingsExportRequest,
): Promise<ReadingsExportResult> {
  const { kind, from, to } = request;
  const period = periodLabel(from, to);
  const name = readingExportKindLabels[kind];

  switch (kind) {
    case 'fleetSummary': {
      const rows = await loadFleetStats(from, to);
      return {
        // Имя прежнее: файл с этим именем уже лежит у диспетчеров в папке за прошлый месяц.
        filename: `Показания техники ${period}.xlsx`,
        bytes: writeWorkbook([readingStatsSheet(rows, period)]),
      };
    }

    case 'fleetMonths': {
      /*
       * Два прохода агрегата, а не один: месяцы дают матрицу, сводка — подписи машин, порядок строк
       * и `gaps`, которого в месяцах нет по построению (Р28а). Цена известна и принята: выгрузку
       * заказывают руками и ждут файла, а собирать подписи парка третьим, своим запросом значило бы
       * завести третий ответ на вопрос «как зовут эту машину».
       */
      const [stats, months] = await Promise.all([
        loadFleetStats(from, to),
        loadFleetMonths(from, to),
      ]);
      return {
        filename: `Показания по месяцам ${period}.xlsx`,
        bytes: writeWorkbook(fleetMonthsSheets(stats, months, from, to)),
      };
    }

    case 'vehicleJournal':
    case 'vehicleMonths': {
      // Схема запроса машину у этих вариантов требует (`readingExportQuerySchema`), и до сборщика
      // запрос без неё не доходит. Проверка стоит второй дверью: сборщика зовут из кода, а не
      // только из ручки, и пустой идентификатор ушёл бы в SQL ошибкой драйвера вместо отказа.
      const vehicleId = request.vehicleId;
      if (vehicleId === undefined || vehicleId === '') {
        throw err.badRequest('Выберите машину', { vehicleId: 'Выберите машину' });
      }
      const label = await vehicleLabelOf(vehicleId);
      if (label === null) throw err.notFound('Машина не найдена');

      const rows = await journalRowsWithLimit(from, to, vehicleId);
      const sheets =
        kind === 'vehicleMonths'
          ? journalMonthSheets(rows, from, to)
          : [journalSheet(`Журнал ${period}`, rows, false)];
      return {
        filename: `${name} ${label} ${period}.xlsx`,
        bytes: writeWorkbook(sheets),
      };
    }

    case 'snapshot': {
      /*
       * Срез берётся на конец периода (`to`, Р16): «последнее» относится к выбранному дню, иначе
       * книга за март показывала бы майский пробег. Состав парка при этом — тот же, что у сводки за
       * период (Р26в): машины, которых в периоде ждали со сменами или которые их сдали.
       */
      const stats = await loadFleetStats(from, to);
      const ids = stats.map((row) => row.vehicleId);
      const [odometers, engineHours, maintenance] = await Promise.all([
        loadLastOdometers(ids, to),
        // Оба счётчика спрашиваются у агрегата, и одной функцией: «что показывал прибор на этот
        // день» — вопрос общий у среза, карточки машины и колонки гаража (Р16, Р27).
        loadLastReadings(ids, to, 'engineHours'),
        request.withMaintenance ? loadMaintenanceSnapshot(ids, to) : null,
      ]);
      return {
        filename: `Срез показаний на ${to}.xlsx`,
        bytes: writeWorkbook([snapshotSheet(stats, odometers, engineHours, maintenance, to)]),
      };
    }

    case 'fleetJournal': {
      const rows = await journalRowsWithLimit(from, to, null);
      return {
        filename: `Журнал показаний парка ${period}.xlsx`,
        bytes: writeWorkbook([journalSheet(`Журнал ${period}`, rows, true)]),
      };
    }
  }
}
