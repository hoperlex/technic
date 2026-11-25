import { describe, expect, it } from 'vitest';
import { addMoney, MoneySum, moneyUnits, unitsToRubles } from '../src/services/analytics/money';
import { combinedMoneyOf, moneyOf, rollupByCustomer } from '../src/services/analytics/rollup';
import type { AnalyticsAtom } from '../src/services/analytics/types';

/**
 * Exact money sums of the analytics layer (snow-removal plan, §3.4).
 *
 * Money is summed as exact integers and converted to a number once, rounded to kopecks. The
 * reference value of every check is the exact decimal total parsed once by `Number` — the nearest
 * double, which is all a JSON number or an xlsx cell can carry. A float running sum misses it by
 * roubles on large legal data; the checks below include such a case, so the guard is not vacuous.
 */

/** The largest amount a completion accepts is 999 999 999 ₽ (`MAX_FACT_COST`); stay just below. */
const LARGE = 999_999_998.99;

function atom(over: Partial<AnalyticsAtom>): AnalyticsAtom {
  return {
    module: 'waste',
    customerKind: 'object',
    customerId: 'ob-1',
    customerCode: 'ОБ-001',
    customerName: 'Площадка',
    customerIsActive: true,
    payerDepartmentId: null,
    payerDepartmentName: null,
    date: '2032-01-10',
    positionKey: 'removal|snow|-',
    positionLabel: 'Снег',
    registrationNumber: null,
    requestId: 'req-1',
    requestLabel: 'М-1',
    requestStatus: 'done',
    shifts: 0,
    planShifts: 0,
    trips: 0,
    volumeM3: 0,
    volumeOrderedM3: 0,
    volumeTicketsM3: 0,
    volumeTicketsUnpricedM3: 0,
    volumeTicketsUnconfirmedM3: 0,
    volumePlannedM3: 0,
    moneyPlanned: 0,
    volumePlannedUnpricedM3: 0,
    volumeFactUnpricedM3: 0,
    ticketsWithoutVolume: 0,
    ticketsUnconfirmed: 0,
    ticketFilesUnread: 0,
    ticketFilesWithoutTickets: 0,
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
    moneyTickets: 0,
    priced: true,
    ...over,
  };
}

/** Exact decimal of `count × amount` (amount with two decimals), built with integers. */
function exactTimes(count: number, amount: number): string {
  const kopecks = (BigInt(Math.round(amount * 100)) * BigInt(count)).toString().padStart(3, '0');
  return `${kopecks.slice(0, -2)}.${kopecks.slice(-2)}`;
}

/** The float running sum the layer used before, rounded at the end. */
function floatSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total * 100) / 100;
}

describe('точные денежные суммы', () => {
  it('слагаемое читается по своей десятичной записи, а не умножением', () => {
    expect(moneyUnits(0.1)).toBe(10_000n);
    expect(moneyUnits(123_456.12345)).toBe(12_345_612_345n);
    expect(moneyUnits(-2.5)).toBe(-250_000n);
    // Float residue beyond five places is rounded, never carried as a sixth digit.
    expect(moneyUnits(0.1 + 0.2)).toBe(30_000n);
    expect(moneyUnits(1e21)).toBe(10n ** 26n);
    expect(moneyUnits(1.5e-7)).toBe(0n);
    expect(() => moneyUnits(Number.NaN)).toThrow(RangeError);
  });

  it('к копейкам округляется один раз, половина — от нуля', () => {
    expect(unitsToRubles(moneyUnits(0.1) + moneyUnits(0.2))).toBe(0.3);
    expect(unitsToRubles(moneyUnits(1.005))).toBe(1.01);
    expect(unitsToRubles(moneyUnits(1.00499))).toBe(1);
    expect(unitsToRubles(moneyUnits(-1.005))).toBe(-1.01);
    expect(Object.is(unitsToRubles(moneyUnits(-0.001)), 0)).toBe(true);
    // Five places of a ticket's money are summed before rounding, not rounded one by one.
    const sum = new MoneySum();
    for (let i = 0; i < 3; i += 1) sum.add(0.00334);
    expect(sum.rubles()).toBe(0.01);
  });

  it('сумма тысяч крупных законных сумм равна точной, а сумма с плавающей точкой — нет', () => {
    const atoms = Array.from({ length: 40_000 }, (_, i) =>
      atom({ requestId: `req-${i}`, moneyFact: LARGE }),
    );
    const exact = Number(exactTimes(40_000, LARGE));
    expect(moneyOf(atoms).fact).toBe(exact);
    // The old float running sum misses the same total by roubles: this is what the test guards.
    expect(floatSum(atoms.map((a) => a.moneyFact))).not.toBe(exact);
  });

  it('итог «факт + оценка» выше копеечной точности — ближайшее число к точной сумме', () => {
    // 25 000 closed and 20 000 open requests of one site plus a kopeck: about 4.06·10¹³ ₽, where a
    // double no longer holds kopecks; the published figure must be the nearest one to the exact
    // decimal total, converted once.
    const atoms = [
      ...Array.from({ length: 25_000 }, (_, i) =>
        atom({ requestId: `fact-${i}`, moneyFact: LARGE }),
      ),
      ...Array.from({ length: 20_000 }, (_, i) =>
        atom({
          requestId: `open-${i}`,
          requestStatus: 'new',
          moneyLow: 777_777_777.77,
          moneyHigh: 777_777_777.77,
        }),
      ),
      atom({ requestId: 'kopeck', moneyFact: 0.01 }),
    ];
    const fact = BigInt(exactTimes(25_000, LARGE).replace('.', '')) + 1n;
    const low = BigInt(exactTimes(20_000, 777_777_777.77).replace('.', ''));
    const text = (fact + low).toString();
    const exact = Number(`${text.slice(0, -2)}.${text.slice(-2)}`);
    expect(exact).toBeGreaterThan(2 ** 45);
    // The exact total has kopecks the nearest double cannot hold (its binary value is .0078125,
    // not .01): the comparison is within the precision of the output format, by construction.
    expect(exact.toFixed(4)).not.toBe(`${text.slice(0, -2)}.${text.slice(-2)}00`);

    const combined = combinedMoneyOf(atoms);
    expect(combined.low).toBe(exact);
    expect(combined.high).toBe(exact);
    // A row of the book gets the same figure from its own atoms.
    expect(rollupByCustomer(atoms)[0]?.money.fact).toBe(
      Number(`${fact.toString().slice(0, -2)}.${fact.toString().slice(-2)}`),
    );
    // Summing in floats and adding the two rounded figures misses it.
    const floatFact = floatSum(atoms.map((a) => a.moneyFact));
    const floatLow = floatSum(atoms.map((a) => a.moneyLow));
    expect(Math.round((floatFact + floatLow) * 100) / 100).not.toBe(exact);
  });

  it('сложение двух опубликованных сумм точно, пока они держат копейки', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(addMoney(30_000_000_000_000.01, 30_000_000_000_000.01)).toBe(
      Number('60000000000000.02'),
    );
    expect(addMoney()).toBe(0);
  });
});
