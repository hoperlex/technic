import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_MODULES,
  MAX_ANALYTICS_STEPS,
  type AnalyticsModule,
  type AnalyticsMoney,
  type AnalyticsStep,
  type AnalyticsTotals,
  emptyTotals,
} from '@technic/contracts';
import { periodCount, periodKeyOf, splitPeriods } from '../src/services/analytics/periods';
import {
  customerKey,
  moneyOf,
  rollupByCustomer,
  rollupByPeriod,
  rollupPositions,
  totalsByModule,
  totalsOf,
} from '../src/services/analytics/rollup';
import { type AnalyticsAtom, NO_VEHICLE_POSITION_KEY } from '../src/services/analytics/types';

/**
 * Нарезка периодов и группировки сводной аналитики
 * (`docs/analytics-summary-export-plan.md`, Э1).
 *
 * Слой считает числа, которые потом печатаются в книге и будут показаны экраном, и ошибка здесь не
 * падает, а тихо врёт правдоподобной цифрой. Поэтому проверяются не функции, а четыре обещания
 * плана, на которых книга держится:
 *
 * 1. **Отрезок дня — одно правило** (Р12, Р13): `periodKeyOf` отвечает и группировке атомов, и оси
 *    динамики. Второе правило разъехалось бы на границе года — там, где 31 декабря и 1 января
 *    лежат в одной ISO-неделе.
 * 2. **Прочерк вместо нуля** (Р16, Р17): величина, которой у модуля не бывает, остаётся `null`.
 *    Ноль на её месте читается как «работа была, величина нулевая».
 * 3. **«Без цены» — заявками, а не строками** (Р9): заявка на десять смен даёт десять атомов, и
 *    счёт строк объявил бы одну неоценённую заявку десятью.
 * 4. **Итог считается из атомов** (Р13): он обязан сойтись с суммой строк свода, но получен не
 *    сложением их — иначе сверять было бы нечего.
 * 5. **Разрез периода ничего не теряет и не удваивает** (Р28): два соседних отрезка в сумме равны
 *    отрезку целиком. На этом держится обещание «свод и инфографика сходятся до копейки», и
 *    держится оно именно здесь — деньги заявки разложены по дням, а группировка их пересобирает.
 * 6. **Вилка денег не переворачивается** (Р9, §7): нижняя оценка не больше верхней ни в одной
 *    группировке, а у вывоза и механизации обе равны. Перевёрнутая вилка печатается молча и
 *    выглядит как обычное число.
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
    date: '2026-08-05',
    positionKey: 'veh-1',
    positionLabel: 'А123ВС 78 КамАЗ 65115',
    registrationNumber: 'А123ВС 78',
    requestId: 'req-1',
    requestLabel: 'ТС-40',
    requestStatus: 'done',
    shifts: 0,
    planShifts: 0,
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

/** Заказ техники ОБ-021, у которого есть срок и нет ни одной заполненной смены (Р29). */
const IDLE_SITE = {
  module: 'onsite',
  customerId: 'ob-021',
  customerCode: 'ОБ-021',
  customerName: 'Парковая, 4',
  positionKey: 'veh-4',
  positionLabel: 'К555МН 78 Погрузчик JCB 3CX',
  registrationNumber: 'К555МН 78',
  requestId: 'req-10',
  requestStatus: 'confirmed',
} as const;

/**
 * Набор одной площадки и двух её соседей. Разбросан по трём неделям августа намеренно: на нём
 * проверяются и свод, и динамика, и это тот самый «один набор атомов на все листы» (Р13).
 *
 * ЗАКРЫТЫЕ ЗАЯВКИ ЗДЕСЬ НЕСУТ «ФАКТ = НИЗ = ВЕРХ», А ИЗ ЗАГРУЗЧИКОВ ТАКАЯ СТРОКА НЕ ПРИХОДИТ: у
 * закрытой заявки заполняется только `moneyFact`, а обе оценки остаются нулями — оценивать
 * закрытое незачем (Р9). Комбинация оставлена намеренно, как заведомо худший случай для
 * инварианта «низ ≤ верх»: он обязан держаться и когда обе оценки не нули, а группировка
 * складывает и округляет их по отдельности. Настоящее поведение закрытой заявки проверяют
 * db-тесты фактов (`analytics-facts-vehicle.db.test.ts`, `analytics-facts-waste-mech.db.test.ts`),
 * и по ним, а не по этой фикстуре, надо судить о том, что печатает книга.
 */
const ATOMS: AnalyticsAtom[] = [
  // ОБ-014, перевозки. Две машины в один день и одна из них повторно — единиц 2, смен 3.
  atom({
    shifts: 1,
    trips: 4,
    volumeM3: 40,
    weightTons: 3.2,
    moneyFact: 12_000,
    moneyLow: 12_000,
    moneyHigh: 12_000,
  }),
  atom({
    positionKey: 'veh-2',
    positionLabel: 'В456ТМ 78 МАЗ 5440',
    registrationNumber: 'В456ТМ 78',
    requestId: 'req-2',
    shifts: 1,
    trips: 2,
    weightTons: 5.4,
    priced: false,
  }),
  atom({
    date: '2026-08-12',
    requestId: 'req-2',
    shifts: 1,
    trips: 3,
    volumeM3: 30,
    priced: false,
  }),
  // ОБ-014, техника на объекте. Моточасы дробные: их сумма и ловит двоичный хвост.
  atom({
    module: 'onsite',
    date: '2026-08-06',
    positionKey: 'veh-9',
    positionLabel: 'Е777КХ 78 Экскаватор Hitachi ZX200',
    registrationNumber: 'Е777КХ 78',
    requestId: 'req-3',
    shifts: 1,
    planShifts: 1,
    engineHours: 243.4,
    moneyFact: 27_000,
    moneyLow: 27_000,
    moneyHigh: 27_000,
  }),
  atom({
    module: 'onsite',
    date: '2026-08-07',
    positionKey: 'veh-9',
    positionLabel: 'Е777КХ 78 Экскаватор Hitachi ZX200',
    registrationNumber: 'Е777КХ 78',
    requestId: 'req-3',
    shifts: 1,
    planShifts: 1,
    engineHours: 243.1,
    relocations: 2,
    moneyFact: 27_000,
    moneyLow: 27_000,
    moneyHigh: 27_000,
  }),
  // День срока, оставшийся без заполненной смены: план есть, факта нет — ровно та разница,
  // ради которой план и заведён отдельной колонкой (Р7).
  atom({
    module: 'onsite',
    date: '2026-08-08',
    positionKey: 'veh-9',
    positionLabel: 'Е777КХ 78 Экскаватор Hitachi ZX200',
    registrationNumber: 'Е777КХ 78',
    requestId: 'req-3',
    planShifts: 1,
  }),
  // ОБ-014, вывоз: объём и лом в тоннах — две величины, а не одна (Р17).
  atom({
    module: 'waste',
    date: '2026-08-05',
    positionKey: 'Строительный мусор · самосвал 20 м³',
    positionLabel: 'Строительный мусор · самосвал 20 м³',
    registrationNumber: null,
    requestId: 'req-4',
    removals: 1,
    volumeM3: 20,
    moneyFact: 7_200,
    moneyLow: 7_200,
    moneyHigh: 7_200,
  }),
  atom({
    module: 'waste',
    date: '2026-08-19',
    positionKey: 'Металлолом · контейнер 8 м³',
    positionLabel: 'Металлолом · контейнер 8 м³',
    registrationNumber: null,
    requestId: 'req-5',
    removals: 1,
    weightTons: 12.4,
    containerOps: 1,
    moneyFact: 4_000,
    moneyLow: 4_000,
    moneyHigh: 4_000,
  }),
  // ОБ-021: действующий объект с кодом больше, чем у закрытого соседа.
  atom({
    customerId: 'ob-021',
    customerCode: 'ОБ-021',
    customerName: 'Парковая, 4',
    requestId: 'req-6',
    shifts: 1,
    trips: 1,
    volumeM3: 10,
    moneyFact: 5_000,
    moneyLow: 5_000,
    moneyHigh: 5_000,
  }),
  // ОБ-021, техника на объекте: заказ, простоявший весь срок без единой заполненной смены (Р29).
  // Дни срока порождают атомы всегда, денег у них только верхняя оценка — и единиц такой набор не
  // даёт вовсе: «смен 0 · ед. 1» рядом со сменами читается как «одна машина работала».
  atom({
    ...IDLE_SITE,
    date: '2026-08-10',
    planShifts: 1,
    moneyHigh: 18_000,
  }),
  atom({
    ...IDLE_SITE,
    date: '2026-08-11',
    planShifts: 1,
    moneyHigh: 18_000,
  }),
  // ОБ-002: закрытый объект. Код меньше всех — порядок решает не он, а действующий признак.
  atom({
    customerId: 'ob-002',
    customerCode: 'ОБ-002',
    customerName: 'Заводская, 1',
    customerIsActive: false,
    requestId: 'req-7',
    shifts: 1,
    trips: 1,
    moneyFact: 3_000,
    moneyLow: 3_000,
    moneyHigh: 3_000,
  }),
  // ОТД-03: отдел-заказчик. Идёт после любых объектов, включая закрытые.
  atom({
    customerKind: 'department',
    customerId: 'dep-03',
    customerCode: 'ОТД-03',
    customerName: 'Снабжение',
    requestId: 'req-8',
    shifts: 1,
    trips: 2,
    volumeM3: 15,
    moneyFact: 9_000,
    moneyLow: 9_000,
    moneyHigh: 9_000,
  }),
];

/** Поля, которые обязаны складываться по любой группировке. */
type CounterField = Exclude<keyof AnalyticsTotals, 'units' | 'requests' | 'money'>;

/**
 * Список складываемых счётчиков берётся у самой заготовки контракта, а не переписывается сюда:
 * колонка, добавленная в книгу завтра, попадёт под проверку разложения сама — а переписанный
 * список тихо оставил бы её непроверенной, и разошлась бы она ровно так же тихо.
 *
 * `units` и `requests` в него не входят по своей причине: это `count(DISTINCT)`, и сложение по
 * группам дало бы кратную величину. Про них — отдельная проверка ниже.
 */
const COUNTERS = Object.keys(emptyTotals('freight')).filter(
  (field): field is CounterField => field !== 'units' && field !== 'requests' && field !== 'money',
);

/** Деньги складываются теми же тремя колонками; `unpriced` — снова `count(DISTINCT)`. */
const MONEY_FIELDS = ['fact', 'low', 'high'] as const;

interface Grouped {
  byModule: Record<AnalyticsModule, AnalyticsTotals>;
  money: AnalyticsMoney;
}

function sumCounter(rows: Grouped[], module: AnalyticsModule, field: CounterField): number {
  return rows.reduce((acc, row) => acc + (row.byModule[module][field] ?? 0), 0);
}

function sumMoney(rows: Grouped[], field: (typeof MONEY_FIELDS)[number]): number {
  return rows.reduce((acc, row) => acc + row.money[field], 0);
}

describe('нарезка периода на отрезки шага (Р12)', () => {
  it('крайние отрезки обрезаются периодом, а подпись остаётся календарной', () => {
    // Обрезка нужна отбору: за границы запроса выходить нельзя. Подпись обрезать нельзя: «нед. 32
    // · 2026 (05.08 – 09.08)» выглядела бы полной неделей с непонятно чьими границами, а читатель по ней
    // сравнивает объёмы — и сравнивал бы четыре дня с семью, не зная об этом.
    expect(splitPeriods({ from: '2026-08-05', to: '2026-08-20' }, 'week')).toEqual([
      {
        key: '2026-W32',
        label: 'нед. 32 · 2026 (03.08 – 09.08)',
        from: '2026-08-05',
        to: '2026-08-09',
      },
      {
        key: '2026-W33',
        label: 'нед. 33 · 2026 (10.08 – 16.08)',
        from: '2026-08-10',
        to: '2026-08-16',
      },
      {
        key: '2026-W34',
        label: 'нед. 34 · 2026 (17.08 – 23.08)',
        from: '2026-08-17',
        to: '2026-08-20',
      },
    ]);
  });

  it('ISO-неделя принадлежит году своего четверга, а не своего дня', () => {
    // 2026 год начинается четвергом, поэтому у него 53 недели, 29.12.2025 уже лежит в его первой,
    // а 01.01.2027 — ещё в его последней. Наивное «неделя = номер по году даты» разорвало бы одну
    // неделю на две строки динамики и потеряло бы половину её работы в каждой.
    expect(periodKeyOf('2025-12-29', 'week')).toBe('2026-W01');
    expect(periodKeyOf('2026-01-01', 'week')).toBe('2026-W01');
    expect(periodKeyOf('2026-12-31', 'week')).toBe('2026-W53');
    expect(periodKeyOf('2027-01-01', 'week')).toBe('2026-W53');
    expect(splitPeriods({ from: '2026-12-28', to: '2027-01-04' }, 'week')).toEqual([
      {
        key: '2026-W53',
        label: 'нед. 53 · 2026 (28.12 – 03.01)',
        from: '2026-12-28',
        to: '2027-01-03',
      },
      {
        key: '2027-W01',
        label: 'нед. 1 · 2027 (04.01 – 10.01)',
        from: '2027-01-04',
        to: '2027-01-04',
      },
    ]);
  });

  it('подпись недели несёт год: иначе две «нед. 1» одного периода неразличимы', () => {
    // Период до 366 дней законно пересекает Новый год, и на оси категорий графика колонки
    // подписаны этой строкой — ключа, по которому они различаются, читатель не видит вовсе.
    // Год берётся у недели, а не у дня: 29.12.2025 подписан 2026-м, как и его ключ.
    const week = (day: string): string | undefined =>
      splitPeriods({ from: day, to: day }, 'week')[0]?.label;
    expect(week('2025-12-29')).toBe('нед. 1 · 2026 (29.12 – 04.01)');
    expect(week('2026-01-01')).toBe('нед. 1 · 2026 (29.12 – 04.01)');
    expect(week('2027-01-04')).toBe('нед. 1 · 2027 (04.01 – 10.01)');
  });

  it('месяц, квартал, полугодие и год режутся календарём, включая февраль', () => {
    expect(splitPeriods({ from: '2026-02-10', to: '2026-04-03' }, 'month')).toEqual([
      { key: '2026-02', label: '02.2026', from: '2026-02-10', to: '2026-02-28' },
      { key: '2026-03', label: '03.2026', from: '2026-03-01', to: '2026-03-31' },
      { key: '2026-04', label: '04.2026', from: '2026-04-01', to: '2026-04-03' },
    ]);
    expect(splitPeriods({ from: '2026-05-20', to: '2026-08-01' }, 'quarter')).toEqual([
      { key: '2026-Q2', label: 'II кв. 2026', from: '2026-05-20', to: '2026-06-30' },
      { key: '2026-Q3', label: 'III кв. 2026', from: '2026-07-01', to: '2026-08-01' },
    ]);
    expect(splitPeriods({ from: '2026-06-30', to: '2026-07-01' }, 'half')).toEqual([
      { key: '2026-H1', label: 'I полугодие 2026', from: '2026-06-30', to: '2026-06-30' },
      { key: '2026-H2', label: 'II полугодие 2026', from: '2026-07-01', to: '2026-07-01' },
    ]);
    expect(splitPeriods({ from: '2025-11-01', to: '2026-02-01' }, 'year')).toEqual([
      { key: '2025', label: '2025', from: '2025-11-01', to: '2025-12-31' },
      { key: '2026', label: '2026', from: '2026-01-01', to: '2026-02-01' },
    ]);
  });

  it('счётчик отрезков считается той же нарезкой: год по неделям упирается ровно в потолок', () => {
    // Потолок проверяют и форма, и сервер (Р26). Формула по номерам месяцев дала бы 52 и кнопку,
    // которая гаснет не там, где сервер отвечает отказом: у 2026 года 53 ISO-недели.
    const year = { from: '2026-01-01', to: '2026-12-31' };
    expect(periodCount(year, 'week')).toBe(53);
    expect(periodCount(year, 'week')).toBe(MAX_ANALYTICS_STEPS);
    expect(periodCount(year, 'month')).toBe(12);
    expect(periodCount(year, 'quarter')).toBe(4);
    expect(periodCount(year, 'half')).toBe(2);
    expect(periodCount(year, 'year')).toBe(1);
    expect(periodCount({ from: '2026-08-05', to: '2026-08-05' }, 'week')).toBe(1);
  });

  it('перевёрнутый период отрезков не даёт вовсе', () => {
    // Схема запроса такой период отвергает, но нарезка не вправе отвечать бесконечным циклом:
    // курсор в ней шагает вперёд, и остановить его может только пустой ответ на входе.
    expect(splitPeriods({ from: '2026-08-20', to: '2026-08-05' }, 'month')).toEqual([]);
    expect(periodCount({ from: '2026-08-20', to: '2026-08-05' }, 'month')).toBe(0);
  });
});

describe('строки свода: кто попадает и в каком порядке (Р4, Р25)', () => {
  it('объекты раньше отделов, действующие раньше закрытых, дальше по коду', () => {
    // Порядок не косметика: под него встают подытоги «Итого по объектам» и «Итого по отделам», и
    // закрытая площадка, всплывшая наверх по коду, попала бы в чужой подытог.
    expect(rollupByCustomer(ATOMS).map((row) => row.code)).toEqual([
      'ОБ-014',
      'ОБ-021',
      'ОБ-002',
      'ОТД-03',
    ]);
  });

  it('строку создаёт работа, а не справочник: заказчика без атомов в своде нет', () => {
    // Р25 дословно: свод отвечает про работу. Пустая строка читается как «площадка простояла», и
    // это неправда — её просто не заказывали.
    const august = ATOMS.filter((item) => item.customerId === 'ob-021');
    expect(rollupByCustomer(august)).toHaveLength(1);
    expect(rollupByCustomer([])).toEqual([]);
  });

  it('отдел и объект — разные строки даже при совпадении идентификатора', () => {
    const same = [
      atom({ customerKind: 'object', customerId: 'x', customerCode: 'ОБ-001', shifts: 1 }),
      atom({ customerKind: 'department', customerId: 'x', customerCode: 'ОТД-01', shifts: 1 }),
    ];
    expect(rollupByCustomer(same).map((row) => row.kind)).toEqual(['object', 'department']);
    expect(customerKey('object', 'x')).not.toBe(customerKey('department', 'x'));
  });
});

describe('счётчики разряда: чего у модуля не бывает, то прочерк (Р16, Р17, Р21)', () => {
  const own = ATOMS.filter((item) => item.customerId === 'ob-014');

  it('поля, которых у модуля не бывает, остаются null, а не становятся нулём', () => {
    const freight = totalsOf(own, 'freight');
    expect(freight.engineHours).toBeNull();
    expect(freight.mechDays).toBeNull();
    expect(freight.removals).toBeNull();
    // У вывоза машин не считаем вовсе (Р21): «количество машин — проблема контрагента».
    const waste = totalsOf(own, 'waste');
    expect(waste.units).toBeNull();
    expect(waste.shifts).toBeNull();
    // Ноль настоящий остаётся нулём: перегонов у перевозок не бывает, а у техники их может не быть.
    expect(totalsOf(own, 'freight').trips).toBe(9);
    expect(totalsOf(own, 'mech').shifts).toBe(0);
  });

  it('единицы техники — count(DISTINCT позиция), а не число смен (Р8)', () => {
    const freight = totalsOf(own, 'freight');
    expect(freight.shifts).toBe(3);
    expect(freight.units).toBe(2);
    expect(freight.requests).toBe(2);
  });

  it('день срока без смены единицы не даёт: иначе простой читался бы как работа (Р8, Р29)', () => {
    // Колонка «ед.» стоит вплотную к «смен», и «смен 0 · ед. 1» отвечает на вопрос «сколько
    // техники работало» числом «одна». Площадка, где заказ простоял месяц без единой заполненной
    // смены, обязана показать ноль в обеих колонках — разницу объясняет план, а не единицы.
    const idle = ATOMS.filter((item) => item.customerId === 'ob-021');
    const onsite = totalsOf(idle, 'onsite');
    expect(onsite.shifts).toBe(0);
    expect(onsite.planShifts).toBe(2);
    expect(onsite.units).toBe(0);
    // Строка детализации у машины при этом есть: срок по ней человек обязан увидеть, иначе заказ,
    // который забыли заполнять, исчезает из книги целиком.
    const positions = rollupPositions(idle).get(customerKey('object', 'ob-021')) ?? [];
    expect(positions.find((row) => row.key === 'veh-4')?.totals.planShifts).toBe(2);
  });

  it('перегон единицы не даёт: он не смена и бывает выполнен не той машиной (Р8, Р27)', () => {
    // Перегон — счётчик, и только: технику привозит тягач, а работает экскаватор. Засчитай
    // перегон единицей — площадка с одним экскаватором показала бы две единицы парка.
    const site = { customerId: 'ob-778', customerCode: 'ОБ-778', module: 'onsite' } as const;
    const withRelocation = [
      atom({ ...site, positionKey: 'veh-9', shifts: 1, engineHours: 8 }),
      atom({
        ...site,
        positionKey: 'veh-8',
        positionLabel: 'М321ОР 78 Тягач МАЗ 5440',
        registrationNumber: 'М321ОР 78',
        requestId: 'req-11',
        relocations: 1,
      }),
    ];
    const onsite = totalsOf(withRelocation, 'onsite');
    expect(onsite.relocations).toBe(1);
    expect(onsite.shifts).toBe(1);
    expect(onsite.units).toBe(1);
  });

  it('у механизации единицу даёт день присутствия: при часовой ставке смен не бывает', () => {
    // Вторая половина того же правила. Считай единицы только по сменам — аренда с почасовой
    // ставкой показала бы «аренд 1 · ед. 0», то есть технику, которой на площадке не было.
    const model = {
      module: 'mech',
      positionKey: 'model-7',
      positionLabel: 'Автовышка АГП-18',
      registrationNumber: null,
      requestId: 'req-12',
    } as const;
    const hourly = [
      atom({ ...model, date: '2026-08-05', mechHours: 8, mechDays: 1 }),
      atom({ ...model, date: '2026-08-06', mechHours: 7, mechDays: 1 }),
    ];
    const mech = totalsOf(hourly, 'mech');
    expect(mech.shifts).toBe(0);
    expect(mech.mechHours).toBe(15);
    expect(mech.mechDays).toBe(2);
    expect(mech.units).toBe(1);
  });

  it('«техника не назначена» единицей не считается, но строкой детализации остаётся', () => {
    // Смена существует и без машины: день работы записан, а чем работали — неизвестно (Р8).
    // Посчитать эту позицию единицей значит объявить отсутствие техники ещё одной техникой:
    // площадка с одним экскаватором и одной такой сменой показала бы две единицы парка.
    // Спрятать её из детализации нельзя по обратной причине — смены без машины человек обязан
    // увидеть, иначе он ищет пропавшие часы в моточасах экскаватора.
    const site = { customerId: 'ob-777', customerCode: 'ОБ-777', module: 'onsite' } as const;
    const withUnknown = [
      atom({ ...site, positionKey: 'veh-9', shifts: 1, engineHours: 8 }),
      atom({
        ...site,
        positionKey: NO_VEHICLE_POSITION_KEY,
        positionLabel: 'Техника не назначена',
        registrationNumber: null,
        requestId: 'req-9',
        shifts: 1,
      }),
    ];
    expect(totalsOf(withUnknown, 'onsite').shifts).toBe(2);
    expect(totalsOf(withUnknown, 'onsite').units).toBe(1);
    const positions = rollupPositions(withUnknown).get(customerKey('object', 'ob-777')) ?? [];
    const unknown = positions.find((row) => row.key === NO_VEHICLE_POSITION_KEY);
    expect(unknown?.totals.shifts).toBe(1);
    // Сама строка честно показывает ноль единиц: машины у неё нет, а прочерк означал бы
    // «единиц у модуля не бывает» — у заказа техники они как раз бывают.
    expect(unknown?.totals.units).toBe(0);
  });

  it('объём и масса лежат в разных полях и никогда не складываются (Р17)', () => {
    const waste = totalsOf(own, 'waste');
    expect(waste.volumeM3).toBe(20);
    expect(waste.weightTons).toBe(12.4);
    expect(waste.removals).toBe(2);
    expect(waste.containerOps).toBe(1);
  });

  it('план складывается там, где он бывает, и остаётся прочерком у прочих разрядов (Р7)', () => {
    // «Смен 52 (план 56)» — сама по себе аналитика: разрыв между сроком заказа и заполненными
    // сменами и есть то, о чём книга обязана сказать. У перевозок, вывоза и механизации срока в
    // этом смысле нет, и ноль на месте плана читался бы как «срок был нулевой».
    const onsite = totalsOf(own, 'onsite');
    expect(onsite.shifts).toBe(2);
    expect(onsite.planShifts).toBe(3);
    for (const module of ['freight', 'waste', 'mech'] as const) {
      expect(totalsOf(own, module).planShifts).toBeNull();
    }
  });

  it('строка свода и строка динамики несут план тем же полем, что и итог', () => {
    // Лист детализации раскрывается из строки свода, а график читает строку динамики: разойдись
    // они в плане — «план 56» на одном листе и «план 52» на другом никто не свёл бы.
    const row = rollupByCustomer(ATOMS).find((item) => item.code === 'ОБ-014');
    expect(row?.byModule.onsite.planShifts).toBe(3);
    const august = rollupByPeriod(
      ATOMS,
      splitPeriods({ from: '2026-08-01', to: '2026-08-31' }, 'month'),
      'month',
    )[0];
    // Пять — это три дня срока ОБ-014 и два дня простоявшего заказа ОБ-021: план собирается по
    // всем площадкам, а не только по тем, где смены заполняли.
    expect(august?.byModule.onsite.planShifts).toBe(5);
    expect(august?.byModule.freight.planShifts).toBeNull();
    expect(totalsByModule(ATOMS).onsite.planShifts).toBe(5);
  });

  it('дробные величины складываются без двоичного хвоста', () => {
    // 243,4 + 243,1 в двоичной арифметике даёт 486,49999999999994, и книга печатает его целиком.
    expect(totalsOf(own, 'onsite').engineHours).toBe(486.5);
    expect(totalsOf(own, 'onsite').relocations).toBe(2);
  });

  it('атомы чужого модуля в счётчик не попадают', () => {
    // Функция получает весь набор и отбирает своё сама: иначе каждый лист фильтровал бы по-своему.
    expect(totalsOf(ATOMS, 'mech').requests).toBe(0);
    expect(totalsOf(ATOMS, 'onsite').requests).toBe(2);
  });
});

describe('деньги: вилка и «без цены» (Р9)', () => {
  it('«без цены» считается по заявкам, а не по строкам', () => {
    // Заявка req-2 дала два атома (две смены). Счёт строк объявил бы её двумя неоценёнными, и
    // служебная колонка, ради которой нулевая клетка отличается от бесплатной работы, соврала бы
    // ровно во столько раз, сколько дней работала заявка.
    const own = ATOMS.filter((item) => item.customerId === 'ob-014');
    expect(own.filter((item) => !item.priced)).toHaveLength(2);
    expect(moneyOf(own).unpriced).toBe(1);
    expect(totalsOf(own, 'freight').money.unpriced).toBe(1);
  });

  it('заявка, оценённая хоть как-нибудь, в «без цены» не попадает', () => {
    expect(moneyOf(ATOMS.filter((item) => item.priced)).unpriced).toBe(0);
  });

  it('округление до копеек делается один раз, в конце суммирования', () => {
    // Три доли по половине копейки — это две копейки вместе и три по отдельности. Округление
    // каждого слагаемого уводит итог заказа, разложенного по 26 дням, на четверть рубля.
    const pennies = [0.005, 0.005, 0.005].map((value) => atom({ moneyFact: value }));
    expect(moneyOf(pennies).fact).toBe(0.02);
    expect(moneyOf([atom({ moneyFact: 0.1 }), atom({ moneyFact: 0.2 })]).fact).toBe(0.3);
  });
});

describe('позиции детализации: порядок модулей и денег', () => {
  it('модули идут как в своде, внутри модуля — по убыванию осторожного итога', () => {
    const positions = rollupPositions(ATOMS).get(customerKey('object', 'ob-014')) ?? [];
    expect(positions.map((row) => row.module)).toEqual([
      'freight',
      'freight',
      'onsite',
      'waste',
      'waste',
    ]);
    // Внутри перевозок первой идёт машина с деньгами, а не та, у которой больше смен: читателя
    // блока из тридцати машин интересуют первые пять по стоимости.
    expect(positions.slice(0, 2).map((row) => row.key)).toEqual(['veh-1', 'veh-2']);
    expect(positions[3]?.label).toBe('Строительный мусор · самосвал 20 м³');
  });

  it('позиция считает свой модуль и свой набор смен', () => {
    const positions = rollupPositions(ATOMS).get(customerKey('object', 'ob-014')) ?? [];
    const excavator = positions.find((row) => row.key === 'veh-9');
    expect(excavator?.totals.engineHours).toBe(486.5);
    expect(excavator?.totals.units).toBe(1);
    expect(excavator?.registrationNumber).toBe('Е777КХ 78');
  });
});

describe('динамика по шагам: пустой отрезок — тоже строка (Р12а)', () => {
  const range = { from: '2026-06-01', to: '2026-08-31' };
  const periods = splitPeriods(range, 'month');

  it('строка выдаётся на каждый отрезок, включая тот, в котором работы не было', () => {
    // Дыра в середине графика — сведение о простое. Пропущенная строка сдвинула бы соседние месяцы
    // вплотную и нарисовала бы непрерывную работу там, где её не было.
    const rows = rollupByPeriod(ATOMS, periods, 'month');
    expect(rows.map((row) => row.period.key)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(rows[0]?.byModule.freight.shifts).toBe(0);
    expect(rows[0]?.byModule.waste.units).toBeNull();
    expect(rows[0]?.money).toEqual({ fact: 0, low: 0, high: 0, unpriced: 0 });
    expect(rows[2]?.byModule.freight.shifts).toBe(6);
  });

  it('атом ложится в отрезок по ключу, а не по обрезанным границам крайнего отрезка', () => {
    // Границы первого и последнего отрезка обрезаны периодом, и сравнение даты с ними — второе
    // правило отнесения дня. Здесь неделя обрезана справа, а работа 19 августа лежит за обрезом
    // календарной недели, но внутри периода — она обязана попасть в свою строку.
    const week = splitPeriods({ from: '2026-08-17', to: '2026-08-19' }, 'week');
    const rows = rollupByPeriod(ATOMS, week, 'week');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.period).toEqual({
      key: '2026-W34',
      label: 'нед. 34 · 2026 (17.08 – 23.08)',
      from: '2026-08-17',
      to: '2026-08-19',
    });
    expect(rows[0]?.byModule.waste.removals).toBe(1);
    expect(rows[0]?.byModule.waste.weightTons).toBe(12.4);
  });
});

describe('итог считается из атомов и сходится с суммой строк (Р13)', () => {
  const rows = rollupByCustomer(ATOMS);
  const totals = totalsByModule(ATOMS);

  it('деньги итога равны сумме денег строк', () => {
    const fact = rows.reduce((acc, row) => acc + row.money.fact, 0);
    expect(moneyOf(ATOMS).fact).toBe(fact);
    expect(moneyOf(ATOMS).unpriced).toBe(1);
  });

  it('итог равен сумме строк по КАЖДОМУ полю, а не только по сменам и деньгам', () => {
    // Два пути к одному числу, и сверять их надо все: колонка, разошедшаяся в подытоге, читается
    // как обычная цифра — книга не подчёркивает её и ничем не жалуется. Раньше здесь стояли две
    // колонки из двенадцати, и дыра в плане (`planShifts`) пролезла бы мимо проверки целиком.
    for (const module of ANALYTICS_MODULES) {
      for (const field of COUNTERS) {
        expect(totals[module][field] ?? 0, `${module}.${field}`).toBe(
          sumCounter(rows, module, field),
        );
      }
      for (const field of MONEY_FIELDS) {
        expect(totals[module].money[field], `${module}.money.${field}`).toBe(
          rows.reduce((acc, row) => acc + row.byModule[module].money[field], 0),
        );
      }
    }
    for (const field of MONEY_FIELDS) {
      expect(moneyOf(ATOMS)[field], `итог.${field}`).toBe(sumMoney(rows, field));
    }
    // Проверка не пуста: набор задевает все четыре разряда и ненулевой план.
    expect(totals.freight.shifts).toBe(6);
    expect(totals.onsite.planShifts).toBe(5);
    expect(totals.waste.removals).toBe(2);
  });

  it('счётчики `count(DISTINCT)` итога не больше суммы строк — сложить их нельзя', () => {
    // `units` и `requests` — единственные поля, по которым равенство не обязано держаться:
    // машина и заявка, задевшие две площадки, стоят в двух строках и в итоге одни. Неравенство в
    // обратную сторону было бы ошибкой отбора — итог не может знать больше, чем его строки.
    for (const module of ANALYTICS_MODULES) {
      expect(totals[module].units ?? 0, `${module}.units`).toBeLessThanOrEqual(
        rows.reduce((acc, row) => acc + (row.byModule[module].units ?? 0), 0),
      );
      expect(totals[module].requests, `${module}.requests`).toBeLessThanOrEqual(
        rows.reduce((acc, row) => acc + row.byModule[module].requests, 0),
      );
    }
    expect(moneyOf(ATOMS).unpriced).toBeLessThanOrEqual(
      rows.reduce((acc, row) => acc + row.money.unpriced, 0),
    );
  });

  it('единицы техники итога складываются не по строкам: одна машина у двух заказчиков — одна', () => {
    // Единственная величина, которую сложить нельзя: `count(DISTINCT)` по всему набору меньше
    // суммы строк ровно на машины, работавшие на двух площадках. Поэтому итог и считается из
    // атомов — сложение строк дало бы парку лишние единицы.
    const shared = [
      atom({ customerId: 'ob-014', customerCode: 'ОБ-014', positionKey: 'veh-1', shifts: 1 }),
      atom({ customerId: 'ob-021', customerCode: 'ОБ-021', positionKey: 'veh-1', shifts: 1 }),
    ];
    const byRow = rollupByCustomer(shared).reduce(
      (acc, row) => acc + (row.byModule.freight.units ?? 0),
      0,
    );
    expect(byRow).toBe(2);
    expect(totalsByModule(shared).freight.units).toBe(1);
  });
});

describe('вилка денег не переворачивается ни в одной группировке (Р9, §7)', () => {
  const rows = rollupByCustomer(ATOMS);
  const weeks = rollupByPeriod(
    ATOMS,
    splitPeriods({ from: '2026-08-01', to: '2026-08-31' }, 'week'),
    'week',
  );
  const totals = totalsByModule(ATOMS);

  /** «Низ не больше верха» — одно утверждение, и спрашивается оно у каждой группировки. */
  function expectFork(money: AnalyticsMoney, where: string): void {
    expect(money.low, `${where}: низ больше верха`).toBeLessThanOrEqual(money.high);
  }

  it('низ не больше верха в строке свода, в строке динамики и в общем итоге — по разрядам тоже', () => {
    // Инвариант держится поатомно (`Math.max` в загрузчике заказа техники), но печатаются не
    // атомы, а группировки: округление и сложение делаются отдельно для низа и для верха, и
    // перевёрнутая вилка вышла бы из книги молча — «оценка 18 000 … 0» выглядит просто числом.
    for (const row of rows) {
      expectFork(row.money, row.code);
      for (const module of ANALYTICS_MODULES) {
        expectFork(row.byModule[module].money, `${row.code}/${module}`);
      }
    }
    for (const row of weeks) {
      expectFork(row.money, row.period.key);
      for (const module of ANALYTICS_MODULES) {
        expectFork(row.byModule[module].money, `${row.period.key}/${module}`);
      }
    }
    for (const module of ANALYTICS_MODULES) {
      expectFork(totals[module].money, `итог/${module}`);
    }
    expectFork(moneyOf(ATOMS), 'итог');
    // И проверка не вырождена: в наборе есть настоящая вилка — заказ, простоявший срок без смен,
    // даёт ноль по низу и верхнюю оценку по сроку (Р29).
    expect(moneyOf(ATOMS).low).toBeLessThan(moneyOf(ATOMS).high);
    expect(totals.onsite.money.low).toBeLessThan(totals.onsite.money.high);
  });

  it('у вывоза и механизации вилки нет вовсе: обе оценки — одно число (Р9)', () => {
    for (const module of ['waste', 'mech'] as const) {
      expect(totals[module].money.low, module).toBe(totals[module].money.high);
      for (const row of rows) {
        expect(row.byModule[module].money.low, `${row.code}/${module}`).toBe(
          row.byModule[module].money.high,
        );
      }
    }
  });
});

describe('разрез периода ничего не теряет и не удваивает (Р28, Р13)', () => {
  /**
   * Сумма мелких отрезков против крупного, в который они вложены — по всем счётчикам и деньгам.
   *
   * Это главный инвариант раскладки: деньги заявки разложены по её дням, и держится равенство
   * именно на группировках. Разъедься они — «свод» и «инфографика» одной книги показали бы разные
   * суммы за один период, и вопрос «какая цифра правильная» остался бы без ответа.
   */
  function expectSplitKeepsWhole(
    from: string,
    to: string,
    fine: AnalyticsStep,
    coarse: AnalyticsStep,
  ): void {
    const range = { from, to };
    const parts = rollupByPeriod(ATOMS, splitPeriods(range, fine), fine);
    const whole = rollupByPeriod(ATOMS, splitPeriods(range, coarse), coarse);
    expect(parts.length, 'отрезков мелкого шага должно быть больше одного').toBeGreaterThan(1);
    expect(whole).toHaveLength(1);
    const one = whole[0]!;
    for (const module of ANALYTICS_MODULES) {
      for (const field of COUNTERS) {
        expect(sumCounter(parts, module, field), `${fine}→${coarse} ${module}.${field}`).toBe(
          one.byModule[module][field] ?? 0,
        );
      }
      for (const field of MONEY_FIELDS) {
        expect(
          parts.reduce((acc, row) => acc + row.byModule[module].money[field], 0),
          `${fine}→${coarse} ${module}.money.${field}`,
        ).toBe(one.byModule[module].money[field]);
      }
    }
    for (const field of MONEY_FIELDS) {
      expect(sumMoney(parts, field), `${fine}→${coarse} money.${field}`).toBe(one.money[field]);
    }
  }

  it('пять недель августа в сумме равны августу целиком', () => {
    expectSplitKeepsWhole('2026-08-01', '2026-08-31', 'week', 'month');
  });

  it('три месяца квартала в сумме равны кварталу целиком', () => {
    // Тот же инвариант на другом зерне: у месяцев границы календарные, у недель — рваные, и
    // ошибка отнесения дня видна только на одном из двух.
    expectSplitKeepsWhole('2026-07-01', '2026-09-30', 'month', 'quarter');
  });

  it('соседние отрезки не делят атом между собой: он целиком в одном', () => {
    // Деление атома «по половине дня» было бы вторым способом свести раскладку, и на нём равенство
    // выше сошлось бы тоже — а вот детализация по машинам разъехалась бы с ним на копейки.
    const weeks = rollupByPeriod(
      ATOMS,
      splitPeriods({ from: '2026-08-01', to: '2026-08-31' }, 'week'),
      'week',
    );
    const withWork = weeks.filter((row) => row.money.fact > 0 || row.money.high > 0);
    expect(withWork.map((row) => row.period.key)).toEqual(['2026-W32', '2026-W33', '2026-W34']);
    // 12 000 + 27 000 + 27 000 + 7 200 + 5 000 + 3 000 + 9 000 — вся работа недели 32 целиком, ни
    // копейки из неё не ушло в соседний отрезок и ни одна не посчиталась дважды.
    expect(weeks.find((row) => row.period.key === '2026-W32')?.money.fact).toBe(90_200);
  });
});

describe('период через Новый год: две «нед. 1» соседних лет — разные отрезки (Р12)', () => {
  const newYear: AnalyticsAtom[] = [
    atom({ date: '2026-12-31', shifts: 1, trips: 1, moneyFact: 1_000 }),
    atom({ date: '2027-01-01', requestId: 'req-13', shifts: 1, trips: 2, moneyFact: 2_000 }),
    atom({
      date: '2027-01-04',
      positionKey: 'veh-2',
      positionLabel: 'В456ТМ 78 МАЗ 5440',
      registrationNumber: 'В456ТМ 78',
      requestId: 'req-14',
      shifts: 1,
      trips: 3,
      moneyFact: 3_000,
    }),
  ];

  it('31 декабря и 1 января складываются в одну строку: это одна ISO-неделя', () => {
    // Тот самый случай, ради которого год недели берётся у её четверга. Разорви эту неделю по
    // границе года — и обе половины показали бы половину работы, каждая правдоподобно.
    const rows = rollupByPeriod(
      newYear,
      splitPeriods({ from: '2026-12-28', to: '2027-01-10' }, 'week'),
      'week',
    );
    expect(rows.map((row) => row.period.key)).toEqual(['2026-W53', '2027-W01']);
    expect(rows[0]?.byModule.freight.shifts).toBe(2);
    expect(rows[0]?.money.fact).toBe(3_000);
    expect(rows[1]?.byModule.freight.shifts).toBe(1);
    expect(rows[1]?.money.fact).toBe(3_000);
    // Граница года — самое вероятное место потери: сумма строк обязана сойтись с итогом.
    expect(sumMoney(rows, 'fact')).toBe(moneyOf(newYear).fact);
    for (const field of COUNTERS) {
      expect(sumCounter(rows, 'freight', field), `freight.${field}`).toBe(
        totalsByModule(newYear).freight[field] ?? 0,
      );
    }
  });

  it('«нед. 1» 2026 года и «нед. 1» 2027-го не сливаются в один отрезок', () => {
    // Ось склеена из двух нарезок намеренно: период, вмещающий обе «нед. 1», упирается в потолок
    // шагов (их 54), и живьём такого запроса не бывает. Но ключ обязан нести год всё равно — на
    // нём же держится подпись колонки графика, а различает читатель колонки только по ней.
    const axis = [
      ...splitPeriods({ from: '2025-12-29', to: '2026-01-04' }, 'week'),
      ...splitPeriods({ from: '2027-01-04', to: '2027-01-10' }, 'week'),
    ];
    expect(axis.map((period) => period.key)).toEqual(['2026-W01', '2027-W01']);
    expect(axis.map((period) => period.label)).toEqual([
      'нед. 1 · 2026 (29.12 – 04.01)',
      'нед. 1 · 2027 (04.01 – 10.01)',
    ]);
    const both = [
      atom({ date: '2025-12-29', shifts: 1, moneyFact: 1_000 }),
      atom({ date: '2027-01-04', requestId: 'req-14', shifts: 1, moneyFact: 2_000 }),
    ];
    const rows = rollupByPeriod(both, axis, 'week');
    expect(rows.map((row) => row.money.fact)).toEqual([1_000, 2_000]);
    expect(rows.map((row) => row.byModule.freight.shifts)).toEqual([1, 1]);
  });
});
