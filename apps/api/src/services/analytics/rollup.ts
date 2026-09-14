import {
  ANALYTICS_MODULES,
  type AnalyticsCustomerKind,
  type AnalyticsCustomerRow,
  type AnalyticsModule,
  type AnalyticsMoney,
  type AnalyticsPeriodRef,
  type AnalyticsPeriodRow,
  type AnalyticsPositionRow,
  type AnalyticsStep,
  type AnalyticsTotals,
  emptyTotals,
} from '@technic/contracts';
import { periodKeyOf } from './periods';
import { type AnalyticsAtom, NO_VEHICLE_POSITION_KEY } from './types';

/**
 * Группировки набора атомов (план `docs/analytics-summary-export-plan.md`, Р13).
 *
 * Свод, детализация по площадкам, динамика по шагам и итог — четыре **группировки одного набора**,
 * а не четыре запроса. Поэтому здесь нет ни одного обращения к БД: функции чистые, атомы приходят
 * снаружи, и книга с будущим экраном аналитики считают по ним одно и то же. Второй ответ на
 * «сколько вывезли за август» в проекте недопустим, а заводится он ровно так — отдельным запросом
 * «специально для листа».
 *
 * Итог по всем строкам тоже считается **из атомов** (`totalsByModule` над полным набором), а не
 * сложением уже собранных строк: сложение строк — второй путь к тому же числу, и расхождение на
 * нём не отлавливается ничем.
 */

/**
 * Поля, которые просто складываются по любой группировке. Единиц техники и заявок здесь нет
 * намеренно: они считаются `count(DISTINCT)`, а сложение по группам дало бы кратную величину.
 */
const SUMMED = [
  'shifts',
  // План (дни срока в периоде) складывается наравне с фактом и тем же механизмом: отдельная
  // ветка для него завела бы второе правило там, где «у модуля этой величины не бывает» уже
  // решено заготовкой `emptyTotals` — у трёх прочих разрядов поле остаётся прочерком само.
  'planShifts',
  'trips',
  'volumeM3',
  'weightTons',
  'engineHours',
  'mechHours',
  'mechDays',
  'removals',
  'containerOps',
  'relocations',
] as const;

const MODULE_ORDER: Record<AnalyticsModule, number> = {
  freight: ANALYTICS_MODULES.indexOf('freight'),
  onsite: ANALYTICS_MODULES.indexOf('onsite'),
  waste: ANALYTICS_MODULES.indexOf('waste'),
  mech: ANALYTICS_MODULES.indexOf('mech'),
};

/** Объекты раньше отделов (Р4): свод читают сверху, и площадки в нём главные. */
const KIND_ORDER: Record<AnalyticsCustomerKind, number> = { object: 0, department: 1 };

/**
 * Округление **один раз, в конце суммирования**. Округлять слагаемые нельзя: деньги заявки
 * разложены по её дням (Р28), и копейка, потерянная на каждом из 26 дней, уводит итог заказа на
 * четверть рубля — а свод и динамика обязаны сойтись до копейки, потому что собраны из одних строк.
 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Ключ заказчика: вид и id вместе. Отдел и объект с одинаковым id — разные строки свода. */
export function customerKey(kind: AnalyticsCustomerKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Деньги набора (Р9).
 *
 * `unpriced` считается **по заявкам**, а не по строкам: заявка на десять смен даёт десять атомов,
 * и счёт строк объявил бы одну неоценённую заявку десятью. Колонка «без цены» существует, чтобы
 * нулевая клетка не читалась как бесплатная работа, — десятикратно завышенная, она ровно это
 * сообщение и уничтожает.
 */
export function moneyOf(atoms: AnalyticsAtom[]): AnalyticsMoney {
  let fact = 0;
  let low = 0;
  let high = 0;
  const unpriced = new Set<string>();
  for (const atom of atoms) {
    fact += atom.moneyFact;
    low += atom.moneyLow;
    high += atom.moneyHigh;
    if (!atom.priced) unpriced.add(atom.requestId);
  }
  return {
    fact: round(fact, 2),
    low: round(low, 2),
    high: round(high, 2),
    unpriced: unpriced.size,
  };
}

/**
 * Несёт ли атом смену своего разряда — единственное основание засчитать единицу техники (Р8).
 *
 * Колонка «ед.» стоит вплотную к «смен» и читается как «сколько техники работало», поэтому счёт по
 * всем подряд атомам врёт дважды. Атом дня срока живёт и без смены (Р29) — площадка, где заказ
 * простоял месяц без единой заполненной смены, показала бы «смен 0 · ед. 1», то есть работающую
 * машину там, где работы не было вовсе. Перегон — тоже атом без смены (Р27), и выполненный не той
 * машиной, что работает на площадке, он добавил бы второй экскаватор к единственному настоящему.
 *
 * У механизации смены при часовой ставке не бывает вовсе, и её работу несёт день присутствия: не
 * будь этой половины правила, аренда с почасовой ставкой показала бы «аренд 3 · ед. 0».
 */
function carriesShift(atom: AnalyticsAtom): boolean {
  return atom.shifts > 0 || atom.mechDays > 0;
}

/**
 * Счётчики одного разряда работы по его атомам.
 *
 * Пустая заготовка берётся у `emptyTotals(module)`, и поля, которых у модуля не бывает, остаются
 * `null` (Р16): у вывоза нет единиц техники (Р21), у перевозок — моточасов. Ноль на их месте —
 * ложь: он означает «величина есть и она нулевая», а книга обязана показать прочерк.
 *
 * `units` — `count(DISTINCT positionKey)` по тем атомам, что несут смену (Р8): позиция заказа
 * техники и есть машина, взятая историей назначения на день, а не текущей строкой.
 * Синтетическая позиция «техника не назначена» из счёта исключена: отсутствие машины — не машина,
 * и площадка с одним экскаватором и одной такой сменой показала бы две единицы. В строках
 * детализации она при этом остаётся — свои смены человек обязан увидеть.
 */
export function totalsOf(atoms: AnalyticsAtom[], module: AnalyticsModule): AnalyticsTotals {
  const own = atoms.filter((atom) => atom.module === module);
  const totals = emptyTotals(module);
  const positions = new Set<string>();
  const requests = new Set<string>();
  for (const atom of own) {
    for (const field of SUMMED) {
      const current = totals[field];
      if (current !== null) totals[field] = current + atom[field];
    }
    if (atom.positionKey !== NO_VEHICLE_POSITION_KEY && carriesShift(atom)) {
      positions.add(atom.positionKey);
    }
    requests.add(atom.requestId);
  }
  for (const field of SUMMED) {
    const summed = totals[field];
    // Три знака — не точность моточасов, а срез двоичного хвоста: 243,4 + 243,1 иначе печатается
    // как 486,49999999999994, и книга выглядит посчитанной неверно.
    if (summed !== null) totals[field] = round(summed, 3);
  }
  if (totals.units !== null) totals.units = positions.size;
  totals.requests = requests.size;
  totals.money = moneyOf(own);
  return totals;
}

/** Счётчики всех четырёх разрядов: строка свода, строка динамики и общий итог устроены одинаково. */
export function totalsByModule(atoms: AnalyticsAtom[]): Record<AnalyticsModule, AnalyticsTotals> {
  const entries = ANALYTICS_MODULES.map((module) => [module, totalsOf(atoms, module)] as const);
  return Object.fromEntries(entries) as Record<AnalyticsModule, AnalyticsTotals>;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Строки свода — по строке на заказчика (Р4).
 *
 * В свод попадают только те, у кого в периоде есть хоть один атом (Р25): ни активность объекта, ни
 * его наличие в справочнике строки не создают — свод отвечает про работу, а не про справочник.
 * Пустая строка в нём читается как «площадка простояла», а это неправда.
 *
 * Порядок: объекты, затем отделы; внутри — действующие раньше закрытых, дальше по коду. Закрытые
 * внизу своей половины потому, что свод читают сверху вниз, и первыми должны стоять площадки, по
 * которым ещё принимают решения.
 */
export function rollupByCustomer(atoms: AnalyticsAtom[]): AnalyticsCustomerRow[] {
  const groups = groupBy(atoms, (atom) => customerKey(atom.customerKind, atom.customerId));
  const rows: AnalyticsCustomerRow[] = [];
  for (const own of groups.values()) {
    const first = own[0];
    if (!first) continue;
    rows.push({
      kind: first.customerKind,
      id: first.customerId,
      code: first.customerCode,
      name: first.customerName,
      isActive: first.customerIsActive,
      byModule: totalsByModule(own),
      money: moneyOf(own),
    });
  }
  rows.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(b.isActive) - Number(a.isActive) ||
      a.code.localeCompare(b.code, 'ru') ||
      a.name.localeCompare(b.name, 'ru'),
  );
  return rows;
}

/**
 * Позиции детализации по заказчикам: ключ карты — тот же `customerKey`, что у строк свода, потому
 * что блок детализации раскрывается из строки свода и обязан показать её же числа.
 *
 * Внутри заказчика порядок модулей — как в `ANALYTICS_MODULES` (он же порядок колонок свода), а
 * внутри модуля — по убыванию денег: в блоке из тридцати машин читателя интересуют первые пять.
 * Деньги для сортировки — «факт плюс нижняя оценка», то есть осторожный итог: верхняя оценка
 * подняла бы наверх заказ, который просто долго не закрывают.
 */
export function rollupPositions(atoms: AnalyticsAtom[]): Map<string, AnalyticsPositionRow[]> {
  const byCustomer = groupBy(atoms, (atom) => customerKey(atom.customerKind, atom.customerId));
  const result = new Map<string, AnalyticsPositionRow[]>();
  for (const [key, own] of byCustomer) {
    const positions = groupBy(own, (atom) => `${atom.module}:${atom.positionKey}`);
    const rows: AnalyticsPositionRow[] = [];
    for (const group of positions.values()) {
      const first = group[0];
      if (!first) continue;
      rows.push({
        module: first.module,
        key: first.positionKey,
        label: first.positionLabel,
        registrationNumber: first.registrationNumber,
        totals: totalsOf(group, first.module),
      });
    }
    rows.sort((a, b) => {
      const byModule = MODULE_ORDER[a.module] - MODULE_ORDER[b.module];
      if (byModule !== 0) return byModule;
      const moneyA = a.totals.money.fact + a.totals.money.low;
      const moneyB = b.totals.money.fact + b.totals.money.low;
      return moneyB - moneyA || a.label.localeCompare(b.label, 'ru');
    });
    result.set(key, rows);
  }
  return result;
}

/**
 * Динамика по отрезкам шага (лист инфографики, Р12а).
 *
 * Строка выдаётся на **каждый** отрезок, включая пустой: дыра в середине графика — сведение о том,
 * что в июле работы не было, а пропущенная строка сдвинула бы соседние месяцы вплотную и
 * нарисовала бы непрерывную работу там, где её не было.
 *
 * Атом попадает в отрезок по ключу (`periodKeyOf`), а не сравнением даты с границами: у крайних
 * отрезков границы обрезаны периодом запроса, и такое сравнение стало бы вторым правилом отнесения
 * дня — тем самым, из-за которого свод и динамика начинают отвечать по-разному.
 */
export function rollupByPeriod(
  atoms: AnalyticsAtom[],
  periods: AnalyticsPeriodRef[],
  step: AnalyticsStep,
): AnalyticsPeriodRow[] {
  const byKey = groupBy(atoms, (atom) => periodKeyOf(atom.date, step));
  return periods.map((period) => {
    const own = byKey.get(period.key) ?? [];
    return { period, byModule: totalsByModule(own), money: moneyOf(own) };
  });
}
