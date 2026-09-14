import { describe, expect, it } from 'vitest';
import { ANALYTICS_BAR_POINT_LIMIT, type AnalyticsPeriodRef } from '@technic/contracts';
import { writeWorkbook, type ChartInput, type SheetInput } from '../src/lib/xlsx';
import { buildInfographicsSheet } from '../src/services/analytics-export-charts';
import { splitPeriods } from '../src/services/analytics/periods';
import type { AnalyticsAtom } from '../src/services/analytics/types';

/**
 * Лист «Инфографика» сводной книги (`docs/analytics-summary-export-plan.md`, §3 «Лист 3»).
 *
 * Единственный лист книги, который рисует, и ошибка в нём не падает, а показывает правдоподобный,
 * но не тот график. Проверяются четыре обещания плана, которые глазами в готовой книге не ловятся:
 *
 * 1. **Витрина вариантов** (Р18а): буквы идут по порядку плана, каждая подписана так, чтобы
 *    читатель отличил вариант от соседнего.
 * 2. **Серия ссылается на клетки листа** (Р18): у графика нет своей копии чисел, он нарисован из
 *    таблицы-источника. Диапазон, съехавший на шапку или на соседнюю таблицу, рисует чужие данные,
 *    и заметить это можно только по адресам.
 * 3. **Больше 26 точек — линия, и об этом сказано словами** (Р26): молчаливая подмена читается как
 *    «нарисовали не тот вариант».
 * 4. **Пустые данные — не ошибка**: площадка без вывоза мусора не получает своих графиков, а лист
 *    всё равно собирается писателем — график без серий тот бросает `XlsxError`.
 *
 * Отдельно проверяется раскладка: писатель за неё не отвечает вовсе, и два графика, поставленные в
 * одну клетку, он соберёт молча — в книге они лягут стопкой, и нижний увидит только тот, кто
 * догадается оттащить верхний мышью.
 */

function atom(over: Partial<AnalyticsAtom>): AnalyticsAtom {
  return {
    module: 'freight',
    customerKind: 'object',
    customerId: 'ob-014',
    customerCode: 'ОБ-014',
    customerName: 'Северная, 12',
    customerIsActive: true,
    payerDepartmentId: null,
    payerDepartmentName: null,
    date: '2026-06-10',
    positionKey: 'veh-1',
    positionLabel: 'А123ВС 78 КамАЗ 65115',
    registrationNumber: 'А123ВС 78',
    requestId: 'req-1',
    requestLabel: 'ТС-40',
    requestStatus: 'done',
    shifts: 0,
    trips: 0,
    volumeM3: 0,
    weightTons: 0,
    engineHours: 0,
    mechHours: 0,
    mechDays: 0,
    removals: 0,
    containerOps: 0,
    relocations: 0,
    moneyFact: 0,
    moneyLow: 0,
    moneyHigh: 0,
    priced: true,
    ...over,
  };
}

/** Работа одного дня во всех четырёх разрядах: на такой площадке обязаны собраться все варианты. */
function workday(date: string, index: number): AnalyticsAtom[] {
  return [
    atom({
      date,
      shifts: 12 + index,
      trips: 30 + index,
      volumeM3: 400 + index,
      moneyFact: 180_000,
    }),
    atom({
      date,
      module: 'onsite',
      positionKey: 'veh-2',
      positionLabel: 'Е777КХ 78 Экскаватор Hitachi ZX200',
      shifts: 20 + index,
      engineHours: 190.5 + index,
      moneyFact: 560_000,
    }),
    atom({
      date,
      module: 'waste',
      positionKey: 'waste-build',
      positionLabel: 'Строительный мусор · самосвал 20 м³',
      registrationNumber: null,
      removals: 6,
      volumeM3: 120,
      moneyFact: 43_000,
    }),
    atom({
      date,
      module: 'waste',
      positionKey: 'waste-tko',
      positionLabel: 'ТКО · контейнер 8 м³',
      registrationNumber: null,
      removals: 3,
      volumeM3: 60,
      moneyFact: 21_000,
    }),
    atom({
      date,
      module: 'mech',
      positionKey: 'mech-plate',
      positionLabel: 'Виброплита Wacker DPU 6555',
      registrationNumber: null,
      mechDays: 20,
      moneyFact: 12_000,
    }),
    atom({
      date,
      module: 'mech',
      positionKey: 'mech-saw',
      positionLabel: 'Швонарезчик Husqvarna FS 400',
      registrationNumber: null,
      mechDays: 8,
      moneyFact: 5_000,
    }),
  ];
}

const OBJECT = 'ОБ-014 Северная, 12';

/**
 * Имя листа рисовальщик не ставит — его ставит сборщик книги: у Excel потолок 31 знак и запрет на
 * двоеточие, а имя уходит в формулы серий. Тест собирает книгу тем же способом, иначе проверял бы
 * не тот лист, который уйдёт читателю.
 */
const asSheet = (sheet: Omit<SheetInput, 'name'>): SheetInput => ({
  ...sheet,
  name: 'Инфографика',
});

const QUARTER: AnalyticsPeriodRef[] = splitPeriods(
  { from: '2026-06-01', to: '2026-08-31' },
  'month',
);

const FULL: AnalyticsAtom[] = ['2026-06-10', '2026-07-10', '2026-08-10'].flatMap(workday);

/**
 * Порядок плана: заказ техники (А–Г), вывоз мусора (Д–И), механизация (К, Л), деньги (М–О).
 * Состав витрины задаёт перечень букв, а не счёт в подписи §3: вариант существует, только если у
 * него есть имя и объяснение, чем он отличается от соседа.
 */
const ALL_LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К', 'Л', 'М', 'Н', 'О'];

const lettersOf = (charts: readonly ChartInput[]): string[] =>
  charts.map((chart) => chart.title.slice(0, 1));

function chartBy(charts: readonly ChartInput[], letter: string): ChartInput {
  const found = charts.find((chart) => chart.title.startsWith(`${letter}.`));
  if (found === undefined) throw new Error(`Вариант ${letter} на листе не собрался`);
  return found;
}

/** Клетка листа по адресу вида `B5` — тем же способом, каким читает её серия графика. */
function cellAt(sheet: { rows: unknown[][] }, address: string): unknown {
  const match = /^([A-Z]+)(\d+)$/u.exec(address);
  if (match === null) throw new Error(`Адрес ${address} не адрес клетки`);
  const column = [...(match[1] ?? '')].reduce(
    (total, letter) => total * 26 + (letter.charCodeAt(0) - 64),
    0,
  );
  return sheet.rows[Number(match[2]) - 1]?.[column - 1];
}

function textAt(sheet: { rows: unknown[][] }, address: string): string {
  const value = cellAt(sheet, address);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Число клетки: в диапазон графика попадает именно оно — уже округлённое, а не исходная сумма. */
function numberAt(sheet: { rows: unknown[][] }, address: string): number {
  const value = cellAt(sheet, address);
  if (typeof value !== 'object' || value === null || !('num' in value)) {
    throw new Error(`Клетка ${address} набрана не числом: ${JSON.stringify(value)}`);
  }
  return (value as { num: number }).num;
}

describe('лист инфографики: витрина вариантов', () => {
  const sheet = buildInfographicsSheet(OBJECT, FULL, QUARTER, 'month');
  const charts = sheet.charts ?? [];

  it('собирает варианты плана по порядку букв', () => {
    expect(lettersOf(charts)).toEqual(ALL_LETTERS);
  });

  it('подписывает каждый вариант буквой и объяснением и не оставляет график без серий', () => {
    for (const chart of charts) {
      // Буква, точка, пробел и объяснение: подпись «Б. Накопительные столбцы» без продолжения не
      // отвечает на вопрос, ради которого витрина и собрана, — чем Б отличается от А.
      expect(chart.title).toMatch(/^[А-О]\. .{30,}/u);
      expect(chart.series.length).toBeGreaterThan(0);
    }
  });

  it('берёт числа из таблиц-источников листа, а не из своей копии', () => {
    // Таблица периодов: подпись в строке 4, шапка в 5, три месяца — строки 6–8.
    expect(textAt(sheet, 'A5')).toBe('Период');
    expect(textAt(sheet, 'A6')).toBe('06.2026');
    expect(textAt(sheet, 'B5')).toBe('Перевозки, смен');
    expect(textAt(sheet, 'E5')).toBe('На объекте, смен');

    const a = chartBy(charts, 'А');
    expect(a.kind).toBe('bar');
    expect([a.firstRow, a.lastRow, a.categoryColumn]).toEqual([6, 8, 1]);
    expect(a.series.map((series) => series.column)).toEqual([2, 5]);

    // Круговая живёт от второй таблицы: два вида отхода — строки 12–13, подписи в колонке A.
    expect(textAt(sheet, 'A11')).toBe('Вид отхода');
    expect(textAt(sheet, 'A12')).toBe('Строительный мусор · самосвал 20 м³');
    const pie = chartBy(charts, 'Д');
    expect([pie.firstRow, pie.lastRow, pie.categoryColumn]).toEqual([12, 13, 1]);
    expect(pie.series).toEqual([{ name: 'м³ вывезено', column: 2 }]);

    // Разрез «вид отхода × отрезок»: серия на вид, категории — те же месяцы.
    const stacked = chartBy(charts, 'Ж');
    expect(textAt(sheet, `A${stacked.firstRow}`)).toBe('06.2026');
    expect(stacked.series.map((series) => series.name)).toEqual([
      'Строительный мусор · самосвал 20 м³',
      'ТКО · контейнер 8 м³',
    ]);
    expect(stacked.series.map((series) => series.column)).toEqual([2, 3]);
    expect(stacked.firstRow).toBeGreaterThan(a.lastRow);
  });

  it('набирает один и тот же объём одинаково в обеих таблицах', () => {
    // Вариант И берёт м³ из таблицы периодов, Ж — из разреза по видам. В клетке лежит уже
    // округлённое число, и разный разряд в двух таблицах нарисовал бы два разных объёма за один
    // месяц — расхождение, которое читатель объяснит ошибкой в данных, а не в разметке.
    const fromPeriods = numberAt(sheet, 'H6');
    const bySlices = numberAt(sheet, 'B17') + numberAt(sheet, 'C17');
    expect(fromPeriods).toBe(bySlices);
  });

  it('ставит моточасы и вывозы линией по второй оси, а не третьим столбцом', () => {
    const v = chartBy(charts, 'В');
    expect(v.series.at(-1)).toEqual({
      name: 'Моточасы',
      column: 6,
      asLine: true,
      secondaryAxis: true,
    });
    const i = chartBy(charts, 'И');
    expect(i.series.at(-1)?.secondaryAxis).toBe(true);
  });

  it('не даёт графикам налезть друг на друга', () => {
    const boxes = charts.map((chart) => chart.anchor);
    for (const [index, box] of boxes.entries()) {
      expect(box.row).toBeGreaterThan(sheet.rows.length);
      for (const other of boxes.slice(index + 1)) {
        const apart =
          box.column + box.width <= other.column ||
          other.column + other.width <= box.column ||
          box.row + box.height <= other.row ||
          other.row + other.height <= box.row;
        expect(apart, `графики ${index} и ${boxes.indexOf(other)} стоят внахлёст`).toBe(true);
      }
    }
  });

  it('собирается писателем в книгу', () => {
    expect(() => writeWorkbook([asSheet(sheet)])).not.toThrow();
  });
});

describe('лист инфографики: правило 26 точек', () => {
  const weeks = splitPeriods({ from: '2026-01-01', to: '2026-12-31' }, 'week');
  const atoms = weeks.map((period, index) => workday(period.from, index)).flat();
  const sheet = buildInfographicsSheet(OBJECT, atoms, weeks, 'week');
  const charts = sheet.charts ?? [];

  it('на 53 отрезках столбчатые варианты собраны линией и говорят об этом', () => {
    expect(weeks.length).toBe(53);
    expect(weeks.length).toBeGreaterThan(ANALYTICS_BAR_POINT_LIMIT);

    for (const letter of ['А', 'Б', 'В', 'Ж', 'З', 'И', 'К', 'Л', 'М', 'Н']) {
      const chart = chartBy(charts, letter);
      expect(chart.kind, `вариант ${letter}`).toBe('line');
      expect(chart.title).toContain('столбцы заменены линией: отрезков 53');
    }
    // У нормированных вариантов подмена стоит дороже: линия показывает величины, а не доли.
    expect(chartBy(charts, 'З').title).toContain('доли не нормируются');
    expect(chartBy(charts, 'Н').title).toContain('доли не нормируются');
  });

  it('круговую и кольцевую правило не трогает: их категории — виды отхода, а не отрезки', () => {
    expect(chartBy(charts, 'Д').kind).toBe('pie');
    expect(chartBy(charts, 'Е').kind).toBe('doughnut');
    expect(chartBy(charts, 'Д').title).not.toContain('линией');
    expect(chartBy(charts, 'Д').lastRow - chartBy(charts, 'Д').firstRow).toBe(1);
  });

  it('собирается писателем в книгу', () => {
    expect(() => writeWorkbook([asSheet(sheet)])).not.toThrow();
  });
});

describe('лист инфографики: неполные данные', () => {
  const withoutWaste = FULL.filter((one) => one.module !== 'waste');
  const sheet = buildInfographicsSheet(OBJECT, withoutWaste, QUARTER, 'month');
  const charts = sheet.charts ?? [];

  it('площадка без вывоза мусора не получает круговую и остальные варианты мусора', () => {
    expect(lettersOf(charts)).toEqual(['А', 'Б', 'В', 'Г', 'К', 'Л', 'М', 'Н', 'О']);
    expect(charts.some((chart) => chart.kind === 'pie' || chart.kind === 'doughnut')).toBe(false);
  });

  it('деньги показывают только те модули, у которых они есть', () => {
    expect(chartBy(charts, 'М').series.map((series) => series.name)).toEqual([
      '₽ перевозки',
      '₽ техника',
      '₽ механизация',
    ]);
  });

  it('аренда без итоговой суммы не получает нулевую линию денег', () => {
    // День присутствия у аренды есть всегда, а суммы может не быть вовсе — такие аренды считает
    // лист «Качество данных». Линия по второй оси в этом случае легла бы плоским нулём, и читатель
    // прочёл бы её как «механизация ничего не стоила».
    const freeRent = FULL.map((one) =>
      one.module === 'mech' ? { ...one, moneyFact: 0, moneyLow: 0, moneyHigh: 0 } : one,
    );
    const sheet = buildInfographicsSheet(OBJECT, freeRent, QUARTER, 'month');
    const mech = chartBy(sheet.charts ?? [], 'К');
    expect(mech.series.map((series) => series.name)).toEqual(['Дней в аренде']);
    expect(() => writeWorkbook([asSheet(sheet)])).not.toThrow();
  });

  it('имя листа рисовальщик не ставит: его ставит сборщик книги', () => {
    expect('name' in buildInfographicsSheet(OBJECT, FULL, QUARTER, 'month')).toBe(false);
  });

  it('площадка без единой цифры даёт лист без графиков, а не исключение', () => {
    const empty = buildInfographicsSheet(OBJECT, [], QUARTER, 'month');
    expect(empty.charts).toEqual([]);
    expect(() => writeWorkbook([asSheet(empty)])).not.toThrow();
  });

  it('собирается писателем в книгу', () => {
    expect(() => writeWorkbook([asSheet(sheet)])).not.toThrow();
  });
});
