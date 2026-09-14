import {
  ANALYTICS_BAR_POINT_LIMIT,
  analyticsStepLabels,
  type AnalyticsPeriodRef,
  type AnalyticsPeriodRow,
  type AnalyticsStep,
} from '@technic/contracts';
import type {
  CellInput,
  ChartInput,
  ChartKind,
  ChartSeries,
  RowStyle,
  SheetInput,
} from '../lib/xlsx';
import { periodKeyOf } from './analytics/periods';
import { rollupByPeriod } from './analytics/rollup';
import type { AnalyticsAtom } from './analytics/types';

/**
 * Лист инфографики сводной выгрузки (план `docs/analytics-summary-export-plan.md`, §3 «Лист 3»).
 *
 * **Витрина вариантов, а не один выбранный график** (Р18а): одни и те же данные площадки показаны
 * четырнадцатью способами, каждый подписан буквой. Цель книги — понять, какая форма информативна на
 * живых данных, и решать это по макетам нельзя; отвергнутые варианты уйдут следующей редакцией
 * вместе с кодом, который их строит.
 *
 * Вариантов четырнадцать — по одному на букву перечня А–О. Состав задаёт сам перечень, а не число
 * в подписи: вариант существует, только если у него есть имя и объяснение, чем он отличается от
 * соседа, — безымянный вариант витрину не пополняет, а засоряет.
 *
 * **Площадка ровно одна** (Р12а). Сравнительных представлений в книге нет вовсе: свод и так
 * отвечает, кто сколько отработал, а график, сравнивающий двадцать объектов, не читается и
 * провоцирует выводы, которых данные не несут.
 *
 * Отдельным файлом от сборщика книги, потому что это единственный лист, который умеет рисовать:
 * остальные шесть — таблицы, и смешивать «как считается» с «как рисуется» в одном файле здесь уже
 * пробовали (ADR 0180).
 *
 * **Имени листа здесь нет намеренно** — его ставит сборщик книги. У Excel потолок 31 знак и запрет
 * на двоеточие, а имя уходит в формулы серий и сводной; «Инфографика: <площадка>» не пережило бы
 * ни потолка, ни чистки. Название площадки живёт заголовком первой строки (Р12а).
 */

// ── Клетки ──

/**
 * Число листа. Прочерка в этих таблицах нет намеренно, хотя в своде он обязателен (Р16): серия
 * графика ссылается на диапазон клеток, и строка «—» посреди диапазона рисуется разрывом линии —
 * читатель увидит остановку работ там, где её не было. Отрезок без работы — это ноль.
 */
function cell(value: number, digits: 0 | 1 = 0): CellInput {
  const factor = digits === 1 ? 10 : 1;
  return { num: Math.round(value * factor) / factor, digits };
}

function ru(date: string | undefined): string {
  const [year, month, day] = (date ?? '').split('-');
  return year !== undefined && month !== undefined && day !== undefined
    ? `${day}.${month}.${year}`
    : '—';
}

// ── Раскладка ──

/**
 * Колонка подписей широкая, остальные — под число: подпись недели («нед. 32 · 2026 (03.08 –
 * 09.08)») длиннее любого числа книги, а ось категорий графика читает именно её.
 */
const LABEL_WIDTH = 30;
const VALUE_WIDTH = 13;

/**
 * Сетка графиков: два в ряд, семь колонок на график. Ширина клетки задана выше, значит график
 * выходит около 670 точек — два таких ряда ложатся в экран ноутбука без горизонтальной прокрутки,
 * а шире они начинают требовать её у каждого читателя.
 */
const CHART_COLUMNS = 7;
const CHART_ROWS = 16;
const CHART_GAP = 1;
const CHARTS_IN_ROW = 2;
/** Сетка начинается со второй колонки: широкая колонка подписей растянула бы первый график. */
const GRID_COLUMN = 2;
/** Запас строк между последней таблицей-источником и первым графиком. */
const CHARTS_TOP_GAP = 2;

const GRID_WIDTH =
  GRID_COLUMN - 1 + CHARTS_IN_ROW * CHART_COLUMNS + (CHARTS_IN_ROW - 1) * CHART_GAP;

const WIDTHS = [LABEL_WIDTH, ...Array.from({ length: GRID_WIDTH - 1 }, () => VALUE_WIDTH)];

function anchorOf(slot: number, top: number): ChartInput['anchor'] {
  const column = GRID_COLUMN + (slot % CHARTS_IN_ROW) * (CHART_COLUMNS + CHART_GAP);
  const row = top + Math.floor(slot / CHARTS_IN_ROW) * (CHART_ROWS + CHART_GAP);
  return { column, row, width: CHART_COLUMNS, height: CHART_ROWS };
}

// ── Таблицы-источники ──

/** Строки данных таблицы (1-based, включительно) — то, на что ссылаются серии графиков. */
interface Table {
  firstRow: number;
  lastRow: number;
}

interface Sheet {
  rows: CellInput[][];
  styles: (RowStyle | undefined)[];
}

/**
 * Блок листа: подпись, шапка, данные и пустая строка после. Подпись обязательна — таблиц на листе
 * четыре, и без неё читатель не поймёт, из какой из них нарисован график, который он правит.
 */
function pushTable(sheet: Sheet, caption: string, header: CellInput[], body: CellInput[][]): Table {
  sheet.rows.push([caption]);
  sheet.styles.push({ bold: true });
  sheet.rows.push(header);
  sheet.styles.push({ fill: 'grey', bold: true });
  const firstRow = sheet.rows.length + 1;
  for (const line of body) {
    sheet.rows.push(line);
    sheet.styles.push(undefined);
  }
  sheet.rows.push([]);
  sheet.styles.push(undefined);
  return { firstRow, lastRow: firstRow + body.length - 1 };
}

/**
 * Подписи категорий у всех четырёх таблиц стоят в первой колонке: ось графика читает именно её, и
 * разная колонка подписей у разных таблиц была бы вторым правилом там, где хватает одного.
 */
const LABEL_COLUMN = 1;

/**
 * Колонки таблицы периодов. Номером ссылается каждая серия вариантов А–Г, И, К, М–О, поэтому
 * номера живут картой целиком, вместе с колонками, которые пока не рисует никто: колонка, забытая
 * в карте, сдвинула бы все правые серии на единицу, и график молча показал бы соседнее число.
 */
const PERIOD_AT = {
  period: 1,
  freightShifts: 2,
  trips: 3,
  freightVolume: 4,
  onsiteShifts: 5,
  engineHours: 6,
  removals: 7,
  wasteVolume: 8,
  mechDays: 9,
  moneyFreight: 10,
  moneyOnsite: 11,
  moneyWaste: 12,
  moneyMech: 13,
} as const;

const PERIOD_HEADER: CellInput[] = [
  'Период',
  'Перевозки, смен',
  'Ездок',
  'м³ перевезено',
  'На объекте, смен',
  'Мото-ч',
  'Вывозов',
  'м³ вывезено',
  'Механизация, дней',
  '₽ перевозки',
  '₽ техника',
  '₽ мусор',
  '₽ механизация',
];

/**
 * Деньги разряда одним числом — «факт плюс нижняя оценка».
 *
 * Вилку (Р9) график показать не может: две серии на модуль превратили бы накопительные столбцы М
 * в восемь слоёв, из которых половина — та же работа, посчитанная дважды. Берётся осторожный край
 * вилки — тот же, по которому сортируется детализация: верхняя оценка подняла бы наверх заказ,
 * который просто долго не закрывают.
 */
function money(row: AnalyticsPeriodRow, module: 'freight' | 'onsite' | 'waste' | 'mech'): number {
  const own = row.byModule[module].money;
  return own.fact + own.low;
}

function periodBody(rows: AnalyticsPeriodRow[]): CellInput[][] {
  return rows.map((row) => [
    row.period.label,
    cell(row.byModule.freight.shifts ?? 0),
    cell(row.byModule.freight.trips ?? 0),
    cell(row.byModule.freight.volumeM3 ?? 0, 1),
    cell(row.byModule.onsite.shifts ?? 0),
    cell(row.byModule.onsite.engineHours ?? 0, 1),
    cell(row.byModule.waste.removals ?? 0),
    cell(row.byModule.waste.volumeM3 ?? 0, 1),
    cell(row.byModule.mech.mechDays ?? 0),
    cell(money(row, 'freight')),
    cell(money(row, 'onsite')),
    cell(money(row, 'waste')),
    cell(money(row, 'mech')),
  ]);
}

// ── Разрез по позициям ──

/**
 * Позиция разреза: вид отхода у мусора, модель у механизации. Хранит и итог за период (круговая
 * Д), и раскладку по отрезкам (накопительные Ж, З, Л) — оба графика обязаны показывать одни и те
 * же доли, а два независимых подсчёта разошлись бы на округлении.
 */
interface Slice {
  label: string;
  total: number;
  byPeriod: Map<string, number>;
}

/**
 * Столько же цветов у писателя (`SERIES_COLORS`), и это не совпадение: седьмая серия повторила бы
 * цвет первой, а в накопительном столбце два одноцветных слоя неразличимы вовсе. Лишние позиции
 * сворачиваются в «Прочие», а не отбрасываются, — иначе сумма долей перестала бы давать объём
 * площадки, и график начал бы противоречить листу «Свод».
 */
const SLICE_LIMIT = 6;

function sliceByPosition(
  atoms: AnalyticsAtom[],
  step: AnalyticsStep,
  amountOf: (atom: AnalyticsAtom) => number,
): Slice[] {
  const slices = new Map<string, Slice>();
  for (const atom of atoms) {
    const amount = amountOf(atom);
    const slice = slices.get(atom.positionKey) ?? {
      label: atom.positionLabel,
      total: 0,
      byPeriod: new Map<string, number>(),
    };
    slice.total += amount;
    const key = periodKeyOf(atom.date, step);
    slice.byPeriod.set(key, (slice.byPeriod.get(key) ?? 0) + amount);
    slices.set(atom.positionKey, slice);
  }
  const ordered = [...slices.values()]
    .filter((slice) => slice.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'ru'));
  if (ordered.length <= SLICE_LIMIT) return ordered;

  const head = ordered.slice(0, SLICE_LIMIT - 1);
  const tail = ordered.slice(SLICE_LIMIT - 1);
  const rest: Slice = { label: `Прочие (${tail.length})`, total: 0, byPeriod: new Map() };
  for (const slice of tail) {
    rest.total += slice.total;
    for (const [key, value] of slice.byPeriod) {
      rest.byPeriod.set(key, (rest.byPeriod.get(key) ?? 0) + value);
    }
  }
  return [...head, rest];
}

/**
 * Разряд округления приходит снаружи и совпадает с тем, которым та же величина набрана в таблице
 * периодов. Разойдись они — вариант И нарисовал бы 181 м³ там, где вариант Ж рисует 181,5: клетка
 * хранит уже округлённое число, и график читает именно его, а не исходную сумму.
 */
function sliceBody(
  slices: readonly Slice[],
  periods: readonly AnalyticsPeriodRef[],
  digits: 0 | 1,
): CellInput[][] {
  return periods.map((period) => [
    period.label,
    ...slices.map((slice) => cell(slice.byPeriod.get(period.key) ?? 0, digits)),
  ]);
}

// ── Варианты ──

/** Заготовка графика: всё, кроме места на листе, — место раздаётся сеткой одним проходом. */
interface Variant {
  letter: string;
  kind: ChartKind;
  /** Объяснение в одну строку: чем этот вариант отличается от соседнего (Р18а). */
  headline: string;
  table: Table;
  categoryColumn: number;
  series: ChartSeries[];
  /**
   * Категории графика — отрезки периода. Только такой вариант попадает под правило Р26: у круга
   * и кольца категории — виды отхода, и сколько бы ни было отрезков, их там ровно столько,
   * сколько видов.
   */
  byPeriod: boolean;
}

/**
 * Правило Р26 словами в заголовке.
 *
 * Молча подменить столбцы линией нельзя: читатель сверяет лист с описанием вариантов и решит, что
 * нарисован не тот график — либо что вариант Б сломан, либо что он и есть вариант Г. У
 * нормированных столбцов подмена дороже: линия показывает величины, а не доли, то есть отвечает
 * уже на другой вопрос, и об этом сказано отдельно.
 */
function lineNote(kind: ChartKind, count: number): string {
  const tail = kind === 'percentBar' ? ', доли не нормируются' : '';
  return ` (столбцы заменены линией: отрезков ${count}${tail})`;
}

function chartOf(variant: Variant, slot: number, top: number, steps: number): ChartInput {
  const downgraded =
    variant.byPeriod &&
    (variant.kind === 'bar' || variant.kind === 'stackedBar' || variant.kind === 'percentBar') &&
    steps > ANALYTICS_BAR_POINT_LIMIT;
  return {
    kind: downgraded ? 'line' : variant.kind,
    title: `${variant.letter}. ${variant.headline}${downgraded ? lineNote(variant.kind, steps) : ''}`,
    firstRow: variant.table.firstRow,
    lastRow: variant.table.lastRow,
    categoryColumn: variant.categoryColumn,
    series: variant.series,
    anchor: anchorOf(slot, top),
  };
}

/**
 * Серия из одних нулей в график не идёт (§3, третья оговорка к витрине), и правило это общее для
 * всех вариантов: пустая рамка с легендой отвечает на вопрос хуже, чем отсутствие графика, — а
 * нулевую линию поверх столбцов читатель принимает за сведение о работе, которой не было, вместо
 * признака того, что величину площадке никто не заводил (аренда без итоговой суммы, лист
 * «Качество данных»).
 */
function filled(
  rows: readonly AnalyticsPeriodRow[],
  pick: (row: AnalyticsPeriodRow) => number,
): boolean {
  return rows.some((row) => pick(row) !== 0);
}

export function buildInfographicsSheet(
  objectLabel: string,
  atoms: AnalyticsAtom[],
  periods: AnalyticsPeriodRef[],
  step: AnalyticsStep,
): Omit<SheetInput, 'name'> {
  const periodRows = rollupByPeriod(atoms, periods, step);
  const sheet: Sheet = { rows: [], styles: [] };

  sheet.rows.push([`Инфографика: ${objectLabel}`]);
  sheet.styles.push({ bold: true });
  sheet.rows.push([
    `Период ${ru(periods[0]?.from)} – ${ru(periods[periods.length - 1]?.to)} · шаг «${
      analyticsStepLabels[step]
    }» · отрезков ${periods.length}`,
  ]);
  sheet.styles.push(undefined);
  sheet.rows.push([]);
  sheet.styles.push(undefined);

  const wasteAtoms = atoms.filter((atom) => atom.module === 'waste');
  const mechAtoms = atoms.filter((atom) => atom.module === 'mech');
  const wasteSlices = sliceByPosition(wasteAtoms, step, (atom) => atom.volumeM3);
  const mechSlices = sliceByPosition(mechAtoms, step, (atom) => atom.mechDays);

  // ── Источники ──

  const periodTable =
    periodRows.length > 0
      ? pushTable(
          sheet,
          'Таблица 1. Работа по отрезкам — источник вариантов А–Г, И, К, М–О. ' +
            'Деньги: факт закрытий плюс нижняя оценка незакрытых заявок (Р9).',
          PERIOD_HEADER,
          periodBody(periodRows),
        )
      : null;

  const wasteTotalTable =
    wasteSlices.length > 0
      ? pushTable(
          sheet,
          'Таблица 2. Виды отхода за весь период — источник Д и Е.',
          ['Вид отхода', 'м³ вывезено'],
          wasteSlices.map((slice) => [slice.label, cell(slice.total, 1)]),
        )
      : null;

  const wasteCrossTable =
    wasteSlices.length > 0 && periods.length > 0
      ? pushTable(
          sheet,
          'Таблица 3. Вид отхода × отрезок, м³ — источник Ж и З.',
          ['Период', ...wasteSlices.map((slice) => slice.label)],
          sliceBody(wasteSlices, periods, 1),
        )
      : null;

  const mechCrossTable =
    mechSlices.length > 0 && periods.length > 0
      ? pushTable(
          sheet,
          'Таблица 4. Модель механизации × отрезок, дней — источник Л.',
          ['Период', ...mechSlices.map((slice) => slice.label)],
          sliceBody(mechSlices, periods, 0),
        )
      : null;

  // ── Заготовки вариантов ──

  const variants: Variant[] = [];
  const column = (index: number): number => LABEL_COLUMN + 1 + index;

  if (periodTable !== null) {
    const shiftSeries: ChartSeries[] = [];
    if (filled(periodRows, (row) => row.byModule.freight.shifts ?? 0)) {
      shiftSeries.push({ name: 'Смены перевозок', column: PERIOD_AT.freightShifts });
    }
    if (filled(periodRows, (row) => row.byModule.onsite.shifts ?? 0)) {
      shiftSeries.push({ name: 'Смены на объекте', column: PERIOD_AT.onsiteShifts });
    }
    const hasEngineHours = filled(periodRows, (row) => row.byModule.onsite.engineHours ?? 0);

    if (shiftSeries.length > 0) {
      variants.push(
        {
          letter: 'А',
          kind: 'bar',
          headline: 'Столбцы рядом — смены перевозок против смен на объекте',
          table: periodTable,
          categoryColumn: LABEL_COLUMN,
          series: shiftSeries,
          byPeriod: true,
        },
        {
          letter: 'Б',
          kind: 'stackedBar',
          headline:
            'Накопительные столбцы — те же смены одним столбцом: общая загрузка и её состав',
          table: periodTable,
          categoryColumn: LABEL_COLUMN,
          series: shiftSeries,
          byPeriod: true,
        },
      );
      if (hasEngineHours) {
        variants.push({
          letter: 'В',
          kind: 'bar',
          headline:
            'Столбцы и линия по второй оси — смены столбцами, моточасы линией: рост смен без роста моточасов значит простои',
          table: periodTable,
          categoryColumn: LABEL_COLUMN,
          series: [
            ...shiftSeries,
            {
              name: 'Моточасы',
              column: PERIOD_AT.engineHours,
              asLine: true,
              secondaryAxis: true,
            },
          ],
          byPeriod: true,
        });
      }
      variants.push({
        letter: 'Г',
        kind: 'line',
        headline: 'Линии — те же смены: единственный вариант, читаемый на 53 точках',
        table: periodTable,
        categoryColumn: LABEL_COLUMN,
        series: shiftSeries,
        byPeriod: true,
      });
    }
  }

  if (wasteTotalTable !== null) {
    variants.push(
      {
        letter: 'Д',
        kind: 'pie',
        headline: 'Круговая по видам отхода — доли объёма за весь период',
        table: wasteTotalTable,
        categoryColumn: LABEL_COLUMN,
        series: [{ name: 'м³ вывезено', column: column(0) }],
        byPeriod: false,
      },
      {
        letter: 'Е',
        kind: 'doughnut',
        headline: 'Кольцевая — те же доли, но плотнее и с местом под итог в середине',
        table: wasteTotalTable,
        categoryColumn: LABEL_COLUMN,
        series: [{ name: 'м³ вывезено', column: column(0) }],
        byPeriod: false,
      },
    );
  }

  if (wasteCrossTable !== null) {
    const series = wasteSlices.map((slice, index) => ({
      name: slice.label,
      column: column(index),
    }));
    variants.push(
      {
        letter: 'Ж',
        kind: 'stackedBar',
        headline: 'Накопительные столбцы по отрезкам — и общий объём вывоза, и структура видов',
        table: wasteCrossTable,
        categoryColumn: LABEL_COLUMN,
        series,
        byPeriod: true,
      },
      {
        letter: 'З',
        kind: 'percentBar',
        headline:
          'Нормированные к 100 % — та же структура без объёма: что мы возим, без сезонности',
        table: wasteCrossTable,
        categoryColumn: LABEL_COLUMN,
        series,
        byPeriod: true,
      },
    );
  }

  if (periodTable !== null && wasteSlices.length > 0) {
    const series: ChartSeries[] = [];
    if (filled(periodRows, (row) => row.byModule.waste.volumeM3 ?? 0)) {
      series.push({ name: 'м³ вывезено', column: PERIOD_AT.wasteVolume });
    }
    if (filled(periodRows, (row) => row.byModule.waste.removals ?? 0)) {
      series.push({
        name: 'Вывозов',
        column: PERIOD_AT.removals,
        asLine: true,
        secondaryAxis: true,
      });
    }
    if (series.length > 0) {
      variants.push({
        letter: 'И',
        kind: 'bar',
        headline:
          'Столбцы «объём» и линия «вывозов» — рост числа вывозов без роста объёма значит недогруз',
        table: periodTable,
        categoryColumn: LABEL_COLUMN,
        series,
        byPeriod: true,
      });
    }
  }

  if (periodTable !== null) {
    /*
     * Деньги механизации проверяются отдельно от дней: день присутствия арендованной техники есть
     * всегда, а итоговой суммы у аренды может не быть вовсе — именно такие аренды считает лист
     * «Качество данных». Наличие атомов механизации закрыло бы вариант слабее соседей и пустило бы
     * в книгу плоскую нулевую линию по второй оси.
     */
    const series: ChartSeries[] = [];
    if (filled(periodRows, (row) => row.byModule.mech.mechDays ?? 0)) {
      series.push({ name: 'Дней в аренде', column: PERIOD_AT.mechDays });
    }
    if (filled(periodRows, (row) => money(row, 'mech'))) {
      series.push({
        name: '₽ механизация',
        column: PERIOD_AT.moneyMech,
        asLine: true,
        secondaryAxis: true,
      });
    }
    if (series.length > 0) {
      variants.push({
        letter: 'К',
        kind: 'bar',
        headline: 'Столбцы «дней в аренде» и линия «₽» — цена дня видна расхождением линий',
        table: periodTable,
        categoryColumn: LABEL_COLUMN,
        series,
        byPeriod: true,
      });
    }
  }

  if (mechCrossTable !== null) {
    variants.push({
      letter: 'Л',
      kind: 'stackedBar',
      headline: 'Накопительные столбцы по моделям — какая техника занимает площадку',
      table: mechCrossTable,
      categoryColumn: LABEL_COLUMN,
      series: mechSlices.map((slice, index) => ({ name: slice.label, column: column(index) })),
      byPeriod: true,
    });
  }

  if (periodTable !== null) {
    const moneySeries: ChartSeries[] = [
      { name: '₽ перевозки', column: PERIOD_AT.moneyFreight, module: 'freight' as const },
      { name: '₽ техника', column: PERIOD_AT.moneyOnsite, module: 'onsite' as const },
      { name: '₽ мусор', column: PERIOD_AT.moneyWaste, module: 'waste' as const },
      { name: '₽ механизация', column: PERIOD_AT.moneyMech, module: 'mech' as const },
    ]
      .filter((item) => filled(periodRows, (row) => money(row, item.module)))
      .map(({ name, column: at }) => ({ name, column: at }));

    if (moneySeries.length > 0) {
      variants.push(
        {
          letter: 'М',
          kind: 'stackedBar',
          headline: 'Накопительные столбцы по модулям — структура и итог расходов площадки',
          table: periodTable,
          categoryColumn: LABEL_COLUMN,
          series: moneySeries,
          byPeriod: true,
        },
        {
          letter: 'Н',
          kind: 'percentBar',
          headline: 'Нормированные к 100 % — доли модулей без влияния объёма работ',
          table: periodTable,
          categoryColumn: LABEL_COLUMN,
          series: moneySeries,
          byPeriod: true,
        },
        {
          letter: 'О',
          kind: 'line',
          headline: 'Линии по модулям — динамика каждого отдельно, без взаимного заслонения',
          table: periodTable,
          categoryColumn: LABEL_COLUMN,
          series: moneySeries,
          byPeriod: true,
        },
      );
    }
  }

  const top = sheet.rows.length + CHARTS_TOP_GAP;
  const charts = variants.map((variant, slot) => chartOf(variant, slot, top, periods.length));

  return {
    rows: sheet.rows,
    rowStyles: sheet.styles,
    widths: WIDTHS,
    charts,
  };
}
