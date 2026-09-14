import {
  ANALYTICS_MODULES,
  analyticsModuleLabels,
  analyticsStepLabels,
  emptyTotals,
  requestStatusLabels,
  type AnalyticsCustomerKind,
  type AnalyticsCustomerRow,
  type AnalyticsExportQuery,
  type AnalyticsModule,
  type AnalyticsMoney,
  type AnalyticsPeriodRef,
  type AnalyticsPositionRow,
  type AnalyticsQualityEntry,
  type AnalyticsStep,
  type AnalyticsTotals,
} from '@technic/contracts';
import {
  writeWorkbook,
  type CellInput,
  type PivotInput,
  type RowStyle,
  type SheetInput,
} from '../lib/xlsx';
import { buildInfographicsSheet } from './analytics-export-charts';
import { periodKeyOf, splitPeriods } from './analytics/periods';
import {
  customerKey,
  moneyOf,
  rollupByCustomer,
  rollupPositions,
  totalsByModule,
} from './analytics/rollup';
import { assertAnalyticsQuery, loadAnalyticsAtoms } from './analytics/summary';
import type { AnalyticsAtom, AnalyticsRange } from './analytics/types';

/**
 * Сводная книга по заказчикам: заказ техники, вывоз мусора и механизация за период
 * (план `docs/analytics-summary-export-plan.md`, §3).
 *
 * Вторая служебная книга «Администрирования» после показаний автотранспорта
 * (`readings-admin-export.ts`), и приёмы у неё те же: ячейка-число против ячейки-прочерка,
 * заголовок группы слитой строкой, уровни группировки, скрытый лист-двойник как источник сводной,
 * лист параметров. Отличие одно и оно важнее сходства: **книга не считает ничего сама**.
 *
 * Четыре правила, которые здесь нельзя нарушить:
 *
 * 1. **Все листы рисуются из одного набора атомов, полученного одной выборкой** (Р13, ADR 0180
 *    §4). Атомы приходят из `loadAnalyticsAtoms` ровно один раз, а «Свод», «Детализация»,
 *    «Инфографика» и «Данные» — четыре его группировки. Второй ответ на «сколько смен за август»
 *    в проекте недопустим, а заводится он ровно так: отдельной выборкой «специально для листа».
 * 2. **Своей арифметики нет** (Р13): числа приходят готовыми из `rollup.ts`. Исключения
 *    перечислимы — доля на листе «Качество», «итого» денежной вилки (сложение двух готовых чисел,
 *    которого в `AnalyticsTotals` нет вовсе) и подписи в заголовках блоков.
 * 3. **Числа лежат числами, даты — датами** (Р4 книги показаний): по текстовой ячейке не считает
 *    ни формула, ни сводная, и «1 234,5», набранное строкой, числом уже не станет.
 * 4. **Объём и масса не складываются никогда, часы и смены механизации — тоже** (Р17): разные
 *    колонки, а не одна с единицей в подписи.
 */

// ── Ячейки ──

const DASH = '—';

/**
 * Число или прочерк. `null` в `AnalyticsTotals` — это «величины у модуля не бывает» (Р16): у
 * перевозок не бывает моточасов, у вывоза — единиц техники. Ноль на их месте соврал бы, объявив
 * величину существующей и нулевой.
 */
function num(value: number | null, digits: 0 | 1 = 0): CellInput {
  return value === null ? DASH : { num: value, digits };
}

/**
 * Число для скрытого листа-источника: неизвестное — **пустая ячейка**, а не прочерк. Прочерк
 * сделал бы поле кэша сводной смешанным, и колонка перестала бы складываться (ADR 0180 §3).
 */
function raw(value: number | null, digits: 0 | 1 = 0): CellInput {
  return value === null ? '' : { num: value, digits };
}

/**
 * Округление до копейки при сложении двух готовых чисел вилки. Складываются уже округлённые
 * `fact` и `low`, и двоичный хвост суммы («2196300.0000000005») попал бы в книгу как есть:
 * формат ячейки прячет его от глаза, но не от формулы и не от сводной.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Деньги в подписи блока: «2 196 300». Разряды разделены пробелом — книгу читают глазами. */
function moneyText(value: number): string {
  const whole = Math.round(value);
  return String(Math.abs(whole))
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')
    .replace(/^/u, whole < 0 ? '−' : '');
}

/** «01.08.2026 – 31.08.2026» — период человеку: он же в имени файла и в заголовках листов. */
function periodLabel(from: string, to: string): string {
  const ru = (date: string): string => {
    const [y, m, d] = date.slice(0, 10).split('-');
    return y && m && d ? `${d}.${m}.${y}` : date;
  };
  return from === to ? ru(from) : `${ru(from)} – ${ru(to)}`;
}

/**
 * Имя ячейки по номерам колонки и строки: слитые диапазоны шапки задаются ссылками, а не
 * номерами. Своя копия правила «1 → A, 27 → AA» здесь потому, что писатель книг её наружу не
 * отдаёт, а тянуть ради трёх строк внутренности `xlsx.ts` — значит связать сборщик с его кухней.
 */
function cellRef(column: number, row: number): string {
  let rest = column;
  let name = '';
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return `${name}${row}`;
}

// ── Имена листов ──

/*
 * Имена короткие намеренно: у Excel потолок 31 знак, и имя листа уходит в формулы сводной и в
 * ссылки графиков — переименование после выката ломает и то, и другое. Название выбранной
 * площадки поэтому стоит заголовком в первой строке листа «Инфографика», а не в его имени (Р12а).
 */
const SUMMARY_SHEET = 'Свод';
const DETAIL_SHEET = 'Детализация';
const INFOGRAPHICS_SHEET = 'Инфографика';
const SOURCE_SHEET = 'Данные';
const PIVOT_SHEET = 'Сводная';
const QUALITY_SHEET = 'Качество';
const PARAMETERS_SHEET = 'Параметры';

const CUSTOMER_KIND_LABELS: Record<AnalyticsCustomerKind, string> = {
  object: 'Объект',
  department: 'Отдел',
};

/** Подпись заказчика: код и название вместе — по коду ищут, по названию узнают. */
function customerLabel(row: { code: string; name: string }): string {
  return [row.code, row.name].filter(Boolean).join(' ') || DASH;
}

// ── Методика (Р19) ──

/**
 * Строка листа «Параметры» о колонке книги: что считается, из какого модуля, каким днём отнесения,
 * что не входит.
 *
 * Это не украшение и не документация: состав показателей — та самая цель, ради которой книга
 * заказана, и без строки на каждую колонку следующая редакция начнётся со спора о том, что такое
 * смена. Методика поэтому живёт **одним списком с самими колонками** — колонка без объяснения
 * физически не собирается.
 */
interface MethodRow {
  what: string;
  source: string;
  day: string;
  excluded: string;
}

/** День отнесения по модулю (Р11): правило одно на модуль, и здесь оно названо словами. */
const MODULE_DAY: Record<AnalyticsModule, string> = {
  freight: 'День рейса',
  onsite: 'День смены',
  waste: 'День вывоза; без него — дата доставки',
  mech: 'Дни аренды: факт, а у незакрытой — план',
};

const NOT_COUNTED = 'Отменённые и удалённые заявки';

/**
 * Колонки, которых в своде нет, а объяснить надо (Р19): план смен живёт в «Детализации» и в
 * «Данных» — в свод он не идёт, там и без него больше двадцати колонок, а разница план/факт —
 * вопрос детализации.
 */
const DETAIL_ONLY_METHODS: { title: string; row: MethodRow }[] = [
  {
    title: 'Детализация и «Данные» · план смен',
    row: {
      what: 'Дней срока заказа на объект, попавших в период, — против заполненных смен (Р7)',
      // Обратных кавычек в клетке книги нет: имя функции в отчёте читателю ничего не объясняет, а
      // в Excel выглядит опечаткой. Правило же одно и то же — тот расчёт дней, что и в карточке.
      source: 'Срок заявки на технику; состав дней считается тем же правилом, что и в карточке',
      day: 'Каждый день срока внутри периода',
      excluded: `${NOT_COUNTED}. День срока даёт план и тогда, когда смену на него не завели: иначе колонка отвечала бы про старательность учётчика, а не про срок. Факт бывает больше плана после коррекции задним числом`,
    },
  },
];

// ── Колонки свода ──

/** Числовые поля счётчиков: колонка свода берёт своё поле, а не считает его заново. */
type TotalsField = {
  [K in keyof AnalyticsTotals]: AnalyticsTotals[K] extends number | null ? K : never;
}[keyof AnalyticsTotals];

/** Источник строки свода: подытог, «Всего» и строка заказчика устроены одинаково (Р13). */
interface SummaryValues {
  byModule: Record<AnalyticsModule, AnalyticsTotals>;
  money: AnalyticsMoney;
}

interface SummaryColumn {
  title: string;
  width: number;
  cell: (values: SummaryValues) => CellInput;
  method: MethodRow;
}

interface SummaryGroup {
  /** Верхний этаж шапки: разряд работы или деньги. */
  title: string;
  columns: SummaryColumn[];
}

function counter(
  module: AnalyticsModule,
  field: TotalsField,
  title: string,
  width: number,
  digits: 0 | 1,
  method: Omit<MethodRow, 'day' | 'excluded'> & Partial<MethodRow>,
): SummaryColumn {
  return {
    title,
    width,
    /*
     * Прочерк вместо нуля (Р16) в двух случаях сразу: поля, которого у разряда не бывает вовсе
     * (`null` в `AnalyticsTotals` — у перевозок не бывает моточасов, у вывоза единиц техники), и
     * разряда, в котором у заказчика нет ни одной заявки. Ноль во втором случае — тоже ложь:
     * отдел, которому вывоз мусора не заказывают вовсе, показал бы «вывезено 0 м³», и строка
     * читалась бы как «возили, да ничего не вывезли».
     */
    cell: (values) =>
      values.byModule[module].requests === 0 ? DASH : num(values.byModule[module][field], digits),
    method: {
      day: MODULE_DAY[module],
      excluded: NOT_COUNTED,
      ...method,
    },
  };
}

/** Денежная колонка: вилка считается по всем разрядам разом, поэтому берёт `money` строки. */
function money(
  title: string,
  pick: (value: AnalyticsMoney) => number,
  method: Omit<MethodRow, 'day' | 'excluded'> & Partial<MethodRow>,
): SummaryColumn {
  return {
    title,
    width: 15,
    cell: (values) => ({ num: pick(values.money), digits: 0 }),
    method: {
      day: 'День, на который разложена стоимость заявки',
      excluded: NOT_COUNTED,
      ...method,
    },
  };
}

/**
 * Шапка свода в два этажа: верхний — разряд работы, нижний — показатель (§3, лист 1).
 *
 * Разряды разрезаны по единицам измерения, а не по модулям портала: заказ техники стоит двумя
 * группами, потому что перевозка меряется ездками, а работа на площадке — моточасами, и в одну
 * колонку они не ложатся (Р17).
 */
const SUMMARY_GROUPS: SummaryGroup[] = [
  {
    title: analyticsModuleLabels.freight,
    columns: [
      counter('freight', 'shifts', 'смен', 8, 0, {
        what: 'Пар «машина и день рейса», в которых участвовала хотя бы одна заявка заказчика (Р6)',
        source: 'Рейсы и состав заявок в них',
        excluded: `${NOT_COUNTED}; доли смены между заказчиками не делятся`,
      }),
      counter('freight', 'units', 'ед.', 8, 0, {
        what: 'Разных машин в тех же сменах',
        source: 'История назначения машины на день (Р8)',
        excluded: `${NOT_COUNTED}; «техника не назначена» машиной не считается`,
      }),
      counter('freight', 'trips', 'ездок', 9, 0, {
        what: 'Ездок в рейсах заявок заказчика',
        source: 'Ездки заявки',
      }),
      counter('freight', 'volumeM3', 'м³', 10, 1, {
        what: 'Перевезённый объём',
        source: 'Ездки заявки',
        excluded: 'С массой не складывается (Р17)',
      }),
      counter('freight', 'weightTons', 'т', 10, 1, {
        what: 'Перевезённая масса',
        source: 'Ездки заявки',
        excluded: 'С объёмом не складывается (Р17)',
      }),
    ],
  },
  {
    title: analyticsModuleLabels.onsite,
    columns: [
      counter('onsite', 'shifts', 'смен', 8, 0, {
        what: 'Заполненных смен техники на площадке (Р7)',
        source: 'Смены заявки на технику',
        excluded: `${NOT_COUNTED}; дни срока без заполненной смены`,
      }),
      counter('onsite', 'units', 'ед.', 8, 0, {
        what: 'Разных машин в тех же сменах',
        source: 'История назначения машины на день (Р8)',
        excluded: `${NOT_COUNTED}; «техника не назначена» машиной не считается`,
      }),
      counter('onsite', 'engineHours', 'мото-ч', 10, 1, {
        what: 'Моточасы заполненных смен',
        source: 'Смены заявки на технику',
      }),
    ],
  },
  {
    title: analyticsModuleLabels.waste,
    columns: [
      counter('waste', 'removals', 'вывозов', 10, 0, {
        what: 'Вывозов — заявок, а не самосвалов (Р21)',
        source: 'Закрытия заявок на вывоз',
      }),
      counter('waste', 'volumeM3', 'м³', 10, 1, {
        what: 'Вывезенный объём',
        source: 'Закрытия заявок на вывоз',
        excluded: 'С массой лома не складывается (Р17)',
      }),
      counter('waste', 'weightTons', 'лом, т', 10, 1, {
        what: 'Принятая масса лома',
        source: 'Закрытия заявок на вывоз',
        excluded: 'С объёмом не складывается (Р17)',
      }),
      counter('waste', 'containerOps', 'конт. опер.', 12, 0, {
        what: 'Установки, замены и снятия контейнеров',
        source: 'Заявки на вывоз контейнерных видов',
        excluded: 'Объёма и денег у операции нет',
      }),
    ],
  },
  {
    title: analyticsModuleLabels.mech,
    columns: [
      counter('mech', 'requests', 'аренд', 9, 0, {
        what: 'Заявок на механизацию, работавших в периоде',
        source: 'Заявки механизации',
      }),
      counter('mech', 'units', 'ед.', 8, 0, {
        what: 'Разных моделей справочника механизации',
        source: 'Заявки механизации',
      }),
      counter('mech', 'shifts', 'смен', 8, 0, {
        what: 'Отработанных единиц при ставке за смену',
        source: 'Факт заявки механизации',
        excluded: 'С часами не складывается (Р17)',
      }),
      counter('mech', 'mechHours', 'ч', 8, 1, {
        what: 'Отработанных единиц при ставке за час',
        source: 'Факт заявки механизации',
        excluded: 'Со сменами не складывается (Р17)',
      }),
      counter('mech', 'mechDays', 'дней', 8, 0, {
        what: 'Дней присутствия техники на площадке',
        source: 'Срок аренды: факт, а у незакрытой — план',
      }),
    ],
  },
  {
    title: 'Деньги, ₽',
    columns: [
      money('факт', (value) => value.fact, {
        what: 'Сумма закрытий по всем четырём разрядам',
        source: 'Закрытия заявок и итоговые суммы аренд',
        excluded: 'Незакрытые заявки: у них только оценка',
      }),
      money('оценка ниж.', (value) => value.low, {
        what: 'Оценка незакрытых заявок по факту смен (Р9)',
        source: 'Цена назначения × заполненные смены или моточасы',
        excluded: 'Закрытые заявки: их деньги известны',
      }),
      money('оценка верх.', (value) => value.high, {
        what: 'Оценка незакрытых заявок по сроку заказа (Р9)',
        source: 'Цена дня × дни срока внутри периода',
        excluded: 'Закрытые заявки: их деньги известны',
      }),
      money('итого ниж.', (value) => round2(value.fact + value.low), {
        what: 'Факт плюс нижняя оценка — осторожный итог',
        source: 'Сумма двух соседних колонок',
      }),
      money('итого верх.', (value) => round2(value.fact + value.high), {
        what: 'Факт плюс верхняя оценка — итог по сроку',
        source: 'Сумма двух соседних колонок',
      }),
      {
        title: 'без цены',
        width: 10,
        cell: (values) => ({ num: values.money.unpriced, digits: 0 }),
        method: {
          what: 'Заявок, не оценённых ни фактом, ни расчётом (Р9)',
          source: 'Считается по заявкам, а не по строкам',
          day: 'Заявка целиком, независимо от дня',
          excluded: 'Оценённые заявки; ноль в деньгах означает бесплатную работу',
        },
      },
    ],
  },
];

const SUMMARY_COLUMNS = SUMMARY_GROUPS.flatMap((group) => group.columns);

/** Первая колонка свода — ось строк (Р4); в методике она не нуждается, потому что не число. */
const SUMMARY_LABEL_WIDTH = 34;

function summaryRow(values: SummaryValues): CellInput[] {
  return SUMMARY_COLUMNS.map((column) => column.cell(values));
}

function valuesOf(atoms: AnalyticsAtom[]): SummaryValues {
  return { byModule: totalsByModule(atoms), money: moneyOf(atoms) };
}

/**
 * Лист «Свод»: строка на заказчика, подытоги по группам и «Всего» (§3, лист 1).
 *
 * Подытоги и «Всего» считаются **из атомов** своей части, а не сложением уже собранных строк:
 * сложение строк — второй путь к тому же числу, и расхождение на нём не ловится ничем (Р13). По
 * той же причине их нет вовсе там, где группа пуста: подытог обязан стоять под своей группой.
 *
 * Автофильтра на листе нет намеренно: он поймал бы серые строки подытогов и «Всего» и складывал бы
 * отфильтрованное с общим.
 */
function summarySheet(
  rows: AnalyticsCustomerRow[],
  atoms: AnalyticsAtom[],
  period: string,
): SheetInput {
  const sheet: CellInput[][] = [[`Сводная аналитика по заказчикам за ${period}`], []];
  const rowStyles: (RowStyle | undefined)[] = [{ bold: true }, undefined];
  const merges: string[] = [];

  const groupRow: CellInput[] = ['Заказчик'];
  const titleRow: CellInput[] = ['Объект / отдел'];
  let column = 2;
  for (const group of SUMMARY_GROUPS) {
    groupRow.push(group.title, ...group.columns.slice(1).map(() => ''));
    titleRow.push(...group.columns.map((item) => item.title));
    if (group.columns.length > 1) {
      merges.push(`${cellRef(column, 3)}:${cellRef(column + group.columns.length - 1, 3)}`);
    }
    column += group.columns.length;
  }
  // Ось строк стоит в обоих этажах шапки одной слитой ячейкой: два разных слова над одной
  // колонкой читались бы как две колонки.
  merges.push('A3:A4');
  sheet.push(groupRow, titleRow);
  rowStyles.push({ bold: true }, { bold: true });

  const subtotal = (kind: AnalyticsCustomerKind, title: string): void => {
    const own = atoms.filter((atom) => atom.customerKind === kind);
    if (own.length === 0) return;
    sheet.push([title, ...summaryRow(valuesOf(own))]);
    rowStyles.push({ fill: 'grey', bold: true });
  };

  let kind: AnalyticsCustomerKind | null = null;
  for (const row of rows) {
    // Подытог закрывает группу перед первой строкой следующей: объекты идут раньше отделов (Р4),
    // и закрытый объект остаётся внутри своей группы, а не уезжает за отделы.
    if (kind !== null && kind !== row.kind) subtotal(kind, 'Итого по объектам');
    kind = row.kind;
    sheet.push([customerLabel(row), ...summaryRow({ byModule: row.byModule, money: row.money })]);
    rowStyles.push(undefined);
  }
  if (kind === 'object') subtotal('object', 'Итого по объектам');
  if (kind === 'department') subtotal('department', 'Итого по отделам');

  sheet.push(['Всего', ...summaryRow(valuesOf(atoms))]);
  rowStyles.push({ fill: 'grey', bold: true });

  return {
    name: SUMMARY_SHEET,
    headerRow: 4,
    autoFilter: false,
    widths: [SUMMARY_LABEL_WIDTH, ...SUMMARY_COLUMNS.map((item) => item.width)],
    rows: sheet,
    rowStyles,
    merges,
  };
}

// ── Детализация ──

interface DetailColumn {
  title: string;
  width: number;
  cell: (totals: AnalyticsTotals) => CellInput;
}

function detailCounter(
  field: TotalsField,
  title: string,
  width: number,
  digits: 0 | 1 = 0,
): DetailColumn {
  return { title, width, cell: (totals) => num(totals[field], digits) };
}

/**
 * Колонки детализации — объединение показателей всех разрядов: строка блока и строка позиции
 * берут свои, чужие остаются прочерками (Р16). Одна таблица вместо четырёх потому, что блоки
 * сворачиваются группировкой и читаются подряд, а четыре шапки внутри листа Excel не умеет.
 */
const DETAIL_COLUMNS: DetailColumn[] = [
  { title: 'Гос. номер', width: 14, cell: () => DASH },
  detailCounter('shifts', 'Смен', 8),
  /*
   * План стоит вплотную к факту (Р7): «смен 52 (план 56)» — разница видна глазом, а разнесённые по
   * краям таблицы колонки заставили бы читателя считать её в уме. У разрядов без срока плана не
   * бывает вовсе, и там остаётся прочерк — `planShifts` у них `null`.
   *
   * У позиции план осмыслен так же, как факт: день срока несёт машину ЭТОГО дня, взятую историей
   * назначения (Р8), — та же машина, на которую ляжет и смена. Заказ, где технику меняли внутри
   * срока, поэтому показывает план по каждой машине отдельно, а не сваливает его на последнюю.
   */
  detailCounter('planShifts', 'План смен', 11),
  detailCounter('units', 'Ед.', 7),
  detailCounter('trips', 'Ездок', 9),
  detailCounter('volumeM3', 'м³', 10, 1),
  detailCounter('weightTons', 'т', 10, 1),
  detailCounter('engineHours', 'Мото-ч', 10, 1),
  detailCounter('removals', 'Вывозов', 10),
  detailCounter('containerOps', 'Конт. опер.', 12),
  detailCounter('relocations', 'Перегонов', 11),
  detailCounter('mechHours', 'Ч механ.', 10, 1),
  detailCounter('mechDays', 'Дней аренды', 12),
  detailCounter('requests', 'Заявок', 9),
  { title: '₽ факт', width: 15, cell: (totals) => ({ num: totals.money.fact, digits: 0 }) },
  { title: '₽ оц. ниж.', width: 15, cell: (totals) => ({ num: totals.money.low, digits: 0 }) },
  { title: '₽ оц. верх.', width: 15, cell: (totals) => ({ num: totals.money.high, digits: 0 }) },
  { title: 'Без цены', width: 10, cell: (totals) => ({ num: totals.money.unpriced, digits: 0 }) },
];

const DETAIL_LAST_COLUMN = cellRef(DETAIL_COLUMNS.length + 1, 1).replace(/\d+$/u, '');

/**
 * Подпись строки «план / факт смен» (Р7): «дней срока 56 · смен заполнено 52 · без смены 4».
 *
 * Разница названа словом, а не знаком: «без смены 4» и «сверх срока 4» — разные события (второе
 * бывает после коррекции задним числом, ADR 0101), и минус в колонке различить их не даёт.
 */
function planFactLabel(totals: AnalyticsTotals): string {
  const plan = totals.planShifts;
  const fact = totals.shifts;
  const head = `план смен (дни срока заказов внутри периода): ${plan ?? DASH} · заполнено ${fact ?? DASH}`;
  if (plan === null || fact === null) return head;
  if (plan === fact) return `${head} · срок закрыт сменами полностью`;
  return plan > fact
    ? `${head} · без смены ${plan - fact}`
    : `${head} · сверх срока ${fact - plan}`;
}

/**
 * Строка-счётчик блока: одно число в своей колонке, остальные — прочерки. Пустого `AnalyticsTotals`
 * для неё не заводится: у него деньги нулевые, а ноль в денежной клетке обязан означать бесплатную
 * работу и ничего больше (Р9).
 */
function counterRow(label: string, title: string, value: number | null): CellInput[] {
  return [
    label,
    ...DETAIL_COLUMNS.map((column) =>
      column.title === title && value !== null ? { num: value, digits: 0 as const } : DASH,
    ),
  ];
}

function detailRow(
  label: string,
  totals: AnalyticsTotals,
  registration: string | null,
): CellInput[] {
  return [
    label,
    ...DETAIL_COLUMNS.map((column, index) =>
      index === 0 ? (registration ?? DASH) : column.cell(totals),
    ),
  ];
}

/**
 * Лист «Детализация»: блок на заказчика, внутри — разряд работы, внутри разряда — позиция
 * (§3, лист 2). Уровни сворачиваются кнопкой слева, как в книге показаний.
 *
 * В подписи блока стоят только деньги: складывать смены перевозок со сменами на объекте нельзя
 * (Р6, Р17) — у первых зерно «машина и день рейса», у вторых строка смены, и общее число было бы
 * вторым ответом на «сколько смен», не отвечающим ни на один вопрос.
 */
function detailSheet(
  rows: AnalyticsCustomerRow[],
  positions: Map<string, AnalyticsPositionRow[]>,
  period: string,
): SheetInput {
  const sheet: CellInput[][] = [
    [`Детализация по площадкам за ${period}`],
    [],
    ['Объект / разряд / позиция', ...DETAIL_COLUMNS.map((column) => column.title)],
  ];
  const rowStyles: (RowStyle | undefined)[] = [{ bold: true }, undefined, undefined];
  const outline: number[] = [0, 0, 0];
  const merges: string[] = [];

  for (const row of rows) {
    /*
     * Вилка дописывается, только если незакрытые заявки у заказчика есть: «оценка 0 – 0» читается
     * как оценённая в ноль работа, тогда как оценивать здесь попросту нечего (Р9).
     */
    const vilka =
      row.money.low === 0 && row.money.high === 0
        ? ''
        : ` · оценка незакрытых ${moneyText(row.money.low)} – ${moneyText(row.money.high)}`;
    sheet.push([
      `${CUSTOMER_KIND_LABELS[row.kind]} ${customerLabel(row)}` +
        ` · ₽ факт ${moneyText(row.money.fact)}${vilka}`,
    ]);
    merges.push(`A${sheet.length}:${DETAIL_LAST_COLUMN}${sheet.length}`);
    rowStyles.push({ fill: 'grey', bold: true });
    outline.push(0);

    const own = positions.get(customerKey(row.kind, row.id)) ?? [];
    for (const module of ANALYTICS_MODULES) {
      const totals = row.byModule[module];
      // Разряд, в котором у заказчика не было ни одной заявки, блок не открывает: пустая строка
      // с прочерками читается как «работали, но ничего не намерили».
      if (totals.requests === 0) continue;
      sheet.push(detailRow(analyticsModuleLabels[module], totals, null));
      rowStyles.push({ bold: true });
      outline.push(1);

      if (module === 'onsite') {
        /*
         * План смен (Р7): разница «план 56, факт 52» — сама по себе аналитика, и книга обязана
         * назвать её числом, а не оставить читателю вычитание в уме. Оба числа приходят готовыми
         * (`planShifts` и `shifts` складывает `rollup`), вычитание здесь — подпись, а не второй
         * ответ на «сколько смен»: своего определения дня срока книга не заводит.
         *
         * Факт бывает и БОЛЬШЕ плана — коррекция задним числом (ADR 0101) оставляет смены у
         * заказа, закрытого раньше срока, — поэтому у разницы две стороны, и «сверх срока»
         * названо словом: отрицательное число в колонке «без смены» читалось бы как ошибка книги.
         */
        sheet.push(counterRow(planFactLabel(totals), 'План смен', totals.planShifts));
        rowStyles.push(undefined);
        outline.push(2);

        /*
         * Перегоны показываются счётчиком, но сменами не считаются (Р27): в перевозках они удвоили
         * бы работу, а спрятанные целиком скрыли бы стоимость доставки техники на площадку.
         */
        sheet.push(
          counterRow(
            'перегонов (доставка и вывоз техники) — в смены перевозок не входят',
            'Перегонов',
            totals.relocations,
          ),
        );
        rowStyles.push(undefined);
        outline.push(2);
      }

      for (const position of own.filter((item) => item.module === module)) {
        sheet.push(detailRow(position.label, position.totals, position.registrationNumber));
        rowStyles.push(undefined);
        outline.push(2);
      }
    }

    sheet.push([]);
    rowStyles.push(undefined);
    outline.push(0);
  }

  return {
    name: DETAIL_SHEET,
    headerRow: 3,
    autoFilter: false,
    widths: [44, ...DETAIL_COLUMNS.map((column) => column.width)],
    rows: sheet,
    rowStyles,
    merges,
    outline,
    /*
     * Итоговой строки под группой у этого листа нет: блок кончается пустой строкой и заголовком
     * следующего заказчика, а сам итог стоит СВЕРХУ — заголовком блока и строкой разряда. Обещай
     * книга обратное (`summaryBelow` по умолчанию), Excel повесил бы кнопку сворачивания на строку
     * ниже группы, и «минус» у позиций «Перевозок» оказался бы на строке «Вывоз мусора».
     */
    summaryBelow: false,
  };
}

// ── Скрытый лист атомов ──

/** Колонка кэша сводной: имя поля обязано совпадать со ссылкой из `PivotInput`. */
const SOURCE_CUSTOMER = 'Заказчик';
const SOURCE_PERIOD = 'Отрезок периода';
const SOURCE_SHIFTS = 'Смен';
const SOURCE_MONEY = '₽ итого';

interface SourceColumn {
  title: string;
  cell: (atom: AnalyticsAtom, periodName: string) => CellInput;
}

/**
 * Числовая колонка атома. Поле, которого у модуля не бывает, остаётся **пустым**: ноль объявил бы
 * величину существующей, а прочерк сделал бы поле сводной смешанным (Р16). Что бывает у модуля,
 * решает `emptyTotals` — тот же список, по которому отвечают прочерками «Свод» и «Детализация».
 */
function sourceCounter(
  field: TotalsField & keyof AnalyticsAtom,
  title: string,
  digits: 0 | 1 = 0,
): SourceColumn {
  return {
    title,
    cell: (atom) => (emptyTotals(atom.module)[field] === null ? '' : raw(atom[field], digits)),
  };
}

const SOURCE_COLUMNS: SourceColumn[] = [
  { title: SOURCE_PERIOD, cell: (_atom, periodName) => periodName },
  { title: 'Дата', cell: (atom) => ({ date: atom.date }) },
  { title: 'Вид заказчика', cell: (atom) => CUSTOMER_KIND_LABELS[atom.customerKind] },
  { title: 'Код', cell: (atom) => atom.customerCode || DASH },
  {
    title: SOURCE_CUSTOMER,
    cell: (atom) => customerLabel({ code: atom.customerCode, name: atom.customerName }),
  },
  { title: 'Отдел-плательщик', cell: (atom) => atom.payerDepartmentName ?? DASH },
  { title: 'Разряд работы', cell: (atom) => analyticsModuleLabels[atom.module] },
  { title: 'Позиция', cell: (atom) => atom.positionLabel },
  { title: 'Гос. номер', cell: (atom) => atom.registrationNumber ?? DASH },
  { title: 'Заявка', cell: (atom) => atom.requestLabel },
  { title: 'Статус', cell: (atom) => requestStatusLabels[atom.requestStatus] },
  sourceCounter('shifts', SOURCE_SHIFTS),
  // План — обычная колонка атома: сводная сравнивает его с фактом по любому разрезу мышью, и
  // «план по отделу-плательщику» не потребует ни новой выборки, ни новой книги.
  sourceCounter('planShifts', 'План смен'),
  sourceCounter('trips', 'Ездок'),
  sourceCounter('volumeM3', 'м³', 1),
  sourceCounter('weightTons', 'т', 1),
  sourceCounter('engineHours', 'Мото-ч', 1),
  sourceCounter('mechHours', 'Ч механизации', 1),
  sourceCounter('mechDays', 'Дней аренды'),
  sourceCounter('removals', 'Вывозов'),
  sourceCounter('containerOps', 'Конт. опер.'),
  sourceCounter('relocations', 'Перегонов'),
  { title: '₽ факт', cell: (atom) => ({ num: atom.moneyFact, digits: 0 }) },
  { title: '₽ оц. ниж.', cell: (atom) => ({ num: atom.moneyLow, digits: 0 }) },
  { title: '₽ оц. верх.', cell: (atom) => ({ num: atom.moneyHigh, digits: 0 }) },
  {
    title: SOURCE_MONEY,
    // «Итого» сводной — осторожный итог «факт плюс нижняя оценка», тот же, по которому `rollup`
    // сортирует позиции. Верхняя оценка в источнике сводной подняла бы наверх заказ, который
    // просто долго не закрывают.
    cell: (atom) => ({ num: round2(atom.moneyFact + atom.moneyLow), digits: 0 }),
  },
];

/**
 * Лист «Данные» — плоские атомы, источник сводной (§3, лист 4).
 *
 * Он повторяет строки «Детализации», и это осознанная цена: сводная требует, чтобы строка сама
 * себя описывала, а в детализации заказчик назван заголовком блока. Условие ADR 0180 §4 держится:
 * оба листа рисуются из **одного** набора атомов, полученного одной выборкой, — двух выборок за
 * одними и теми же днями в книге нет.
 */
function sourceSheet(
  atoms: AnalyticsAtom[],
  periods: AnalyticsPeriodRef[],
  step: AnalyticsStep,
): SheetInput {
  // Подпись отрезка ищется по ключу, а не сравнением даты с границами: у крайних отрезков границы
  // обрезаны периодом запроса, и сравнение стало бы вторым правилом отнесения дня (см. periods.ts).
  const labels = new Map(periods.map((period) => [period.key, period.label]));
  return {
    name: SOURCE_SHEET,
    hidden: true,
    freezeHeader: true,
    rows: [
      SOURCE_COLUMNS.map((column) => column.title),
      ...atoms.map((atom): CellInput[] => {
        const key = periodKeyOf(atom.date, step);
        const periodName = labels.get(key) ?? key;
        return SOURCE_COLUMNS.map((column) => column.cell(atom, periodName));
      }),
    ],
  };
}

// ── Сводная ──

/**
 * Разметка сводной (§3, лист 5): заказчик по строкам, отрезок периода по колонкам, деньги и смены
 * значениями. Разрезы по разряду работы, статусу, отделу-плательщику и позиции лежат в кэше рядом
 * и собираются мышью.
 *
 * Кэш пишется целиком (ADR 0180 §3): с пустым кэшем сводная оживает только в Excel, а LibreOffice
 * и отечественные редакторы показали бы пустой лист.
 */
function pivot(): PivotInput {
  return {
    sheet: PIVOT_SHEET,
    source: SOURCE_SHEET,
    rowField: SOURCE_CUSTOMER,
    columnField: SOURCE_PERIOD,
    startRow: 3,
    values: [
      { field: SOURCE_MONEY, label: SOURCE_MONEY },
      { field: SOURCE_SHIFTS, label: SOURCE_SHIFTS },
    ],
  };
}

function pivotSheet(period: string): SheetInput {
  return {
    name: PIVOT_SHEET,
    widths: [34, 16, 16, 16, 16, 16],
    rows: [[`Сводная таблица по заказчикам за ${period}`]],
    rowStyles: [{ bold: true }],
  };
}

// ── Качество данных ──

/**
 * Значение строки качества: «14 из 52 (27 %)» либо просто число.
 *
 * Доля считается **только при непустом знаменателе**: «6 из 0» — не ноль процентов, а отсутствие
 * основания, и напечатанный ноль читался бы как благополучие. Это единственная арифметика листа.
 */
function qualityValue(entry: AnalyticsQualityEntry): CellInput {
  if (entry.outOf === null) return { num: entry.value, digits: 0 };
  if (entry.outOf === 0) return `${entry.value} из 0`;
  return `${entry.value} из ${entry.outOf} (${Math.round((entry.value / entry.outOf) * 100)} %)`;
}

/**
 * Лист «Качество» (§3, лист 6, Р20): насколько цифрам можно верить. Строки приходят от загрузчиков
 * модулей — «смена без визы» и «вывоз без талона» из счётчиков не выводятся вовсе, и выведенные
 * дали бы второе определение там, где уже есть первое.
 */
function qualitySheet(quality: AnalyticsQualityEntry[], period: string): SheetInput {
  return {
    name: QUALITY_SHEET,
    headerRow: 3,
    autoFilter: false,
    widths: [52, 22, 72],
    rows: [
      [`Качество данных за ${period}`],
      [],
      ['Показатель', 'Значение', 'Чем грозит'],
      ...quality.map((entry): CellInput[] => [entry.label, qualityValue(entry), entry.note]),
    ],
    rowStyles: [{ bold: true }, undefined, { bold: true }],
  };
}

// ── Параметры и методика ──

/** Кто и когда выгрузил. Время и имя решает вызывающий: сборщик книги не знает ни того, ни другого. */
export interface AnalyticsExportContext {
  actor: string;
  at: string;
}

interface ParametersInput {
  query: AnalyticsExportQuery;
  context: AnalyticsExportContext;
  chartLabel: string | null;
  customers: number;
  atoms: number;
  positions: number;
  periods: number;
}

function parametersSheet(input: ParametersInput): SheetInput {
  const { query, context } = input;
  const rows: CellInput[][] = [
    ['Сводная аналитика — параметры выгрузки'],
    [],
    ['Период с', { date: query.from }],
    ['Период по', { date: query.to }],
    ['Шаг периода', analyticsStepLabels[query.step]],
    ['Отрезков в периоде', { num: input.periods }],
    [
      'Площадка инфографики',
      // Лист инфографики строится по одной площадке (Р12а); не выбрана — листа в книге нет вовсе,
      // и это законное состояние книги, а не сбой. Сказать об этом словами обязан лист параметров.
      input.chartLabel ?? 'не выбрана — листа «Инфографика» в книге нет',
    ],
    ['Выгрузил', context.actor],
    ['Выгружено', context.at],
    ['Отбор', 'заказчики, у которых в периоде есть хоть одна цифра'],
    /*
     * Счётчики названы тем, что считают, а не «строками листа»: на «Своде» строк больше, чем
     * заказчиков (подытоги и «Всего»), а на «Детализации» — куда больше, чем позиций (заголовки
     * блоков, строки разрядов, план смен, счётчик перегонов). Подпись «строк детализации» при
     * числе позиций врала бы в разы, а число строк листа не отвечало бы ни на один вопрос
     * читателя: объём книги он видит полосой прокрутки, а сверяет он состав.
     */
    ['Заказчиков в своде', { num: input.customers }],
    ['Позиций в детализации', { num: input.positions }],
    ['Строк листа «Данные» (атомов)', { num: input.atoms }],
    [],
    ['Прочерк «—»', 'величины у разряда не бывает либо она неизвестна; в суммы не входит'],
    ['Пустая ячейка на листе «Данные»', 'то же, но прочерк сделал бы поле сводной смешанным'],
    ['Деньги', 'вилка: факт закрытий, нижняя оценка по факту смен, верхняя — по сроку заказа'],
    [],
    ['Методика: что и как считается'],
    ['Колонка', 'Что считается', 'Источник', 'День отнесения', 'Что не входит'],
  ];
  const rowStyles: (RowStyle | undefined)[] = rows.map(() => undefined);
  rowStyles[0] = { bold: true };
  rowStyles[rows.length - 2] = { bold: true };
  rowStyles[rows.length - 1] = { bold: true };

  /*
   * Строка методики на каждую колонку свода (Р19) — и собираются они тем же списком, которым
   * собран сам свод: колонка без объяснения физически не заводится. Это и есть «состав
   * показателей», ради которого книга заказана; без него следующая редакция начнётся со спора о
   * том, что такое смена.
   */
  const method: { title: string; row: MethodRow }[] = SUMMARY_GROUPS.flatMap((group) =>
    group.columns.map((column) => ({
      title: `${group.title} · ${column.title}`,
      row: column.method,
    })),
  );
  method.push(...DETAIL_ONLY_METHODS);
  for (const item of method) {
    rows.push([item.title, item.row.what, item.row.source, item.row.day, item.row.excluded]);
    rowStyles.push(undefined);
  }

  return {
    name: PARAMETERS_SHEET,
    widths: [34, 56, 46, 38, 46],
    rows,
    rowStyles,
  };
}

// ── Книга целиком ──

export interface AnalyticsExportResult {
  filename: string;
  bytes: Uint8Array;
}

const UNKNOWN_ACTOR: AnalyticsExportContext = { actor: DASH, at: DASH };

/**
 * Книга сводной аналитики целиком: семь листов, один набор атомов, ни одного своего числа.
 *
 * Атомы грузятся **однажды** (`loadAnalyticsAtoms`) — там же стоят и все три потолка, — а листы
 * получаются его группировками из `rollup.ts`. Потолок периода и шагов проверяется до выборки:
 * отказ после десяти секунд работы над книгой, которую всё равно не отдадут, — худший из ответов.
 */
export async function buildAnalyticsExport(
  query: AnalyticsExportQuery,
  context: AnalyticsExportContext = UNKNOWN_ACTOR,
): Promise<AnalyticsExportResult> {
  const range: AnalyticsRange = { from: query.from, to: query.to };
  assertAnalyticsQuery(range, query.step);

  const { atoms, quality } = await loadAnalyticsAtoms(range);
  const periods = splitPeriods(range, query.step);
  const rows = rollupByCustomer(atoms);
  const positions = rollupPositions(atoms);
  const period = periodLabel(query.from, query.to);

  /*
   * Площадка инфографики зовётся так же, как строка свода, и берётся из тех же атомов: справочник
   * ради названия не спрашивается — это была бы вторая выборка за теми же данными, а книга и так
   * знает всё, что попало в период. Площадка без работы в периоде строки свода не имеет (Р25), и
   * лист собирается с честной подписью, а не с пустым заголовком.
   */
  const chartRow = query.chartObjectId
    ? rows.find((row) => row.kind === 'object' && row.id === query.chartObjectId)
    : undefined;
  const chartLabel = query.chartObjectId
    ? chartRow
      ? customerLabel(chartRow)
      : 'Площадка без работ в периоде'
    : null;

  const sheets: SheetInput[] = [
    summarySheet(rows, atoms, period),
    detailSheet(rows, positions, period),
  ];

  if (query.chartObjectId !== undefined && chartLabel !== null) {
    const own = atoms.filter(
      (atom) => atom.customerKind === 'object' && atom.customerId === query.chartObjectId,
    );
    /*
     * Имя листа ставит сборщик книги, а не рисовальщик графиков: у Excel потолок 31 знак, а имя
     * уходит в формулы сводной и в ссылки графиков. Название площадки поэтому живёт заголовком в
     * первой строке листа (Р12а).
     */
    sheets.push({
      ...buildInfographicsSheet(chartLabel, own, periods, query.step),
      name: INFOGRAPHICS_SHEET,
    });
  }

  sheets.push(
    sourceSheet(atoms, periods, query.step),
    pivotSheet(period),
    qualitySheet(quality, period),
    parametersSheet({
      query,
      context,
      chartLabel,
      customers: rows.length,
      atoms: atoms.length,
      positions: [...positions.values()].reduce((total, list) => total + list.length, 0),
      periods: periods.length,
    }),
  );

  return {
    filename: `Сводная аналитика ${period}.xlsx`,
    bytes: writeWorkbook(sheets, pivot()),
  };
}
