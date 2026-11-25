/**
 * Exact money sums of the analytics layer (snow-removal plan, §3.4; ADR 0182, R13).
 *
 * Atom money arrives as JavaScript numbers parsed from PostgreSQL `numeric` text, and the reports
 * add thousands of them: a site row, a module total, the whole book, and then derived totals such
 * as «факт + оценка». Added as floats, every addend brings its own binary error, the errors pile up,
 * and a large total stops matching the same total counted by hand — a kopeck off, or, above about
 * 3.5·10¹³ ₽, a different nearest double. So money is summed here as an exact scaled INTEGER and is
 * converted to a number exactly ONCE, rounded to kopecks, at the very end; a derived total (fact
 * plus estimate) is summed from the same integers, never from two already rounded figures.
 *
 * Rounding happens once and only at the output: addends are not rounded first, or a kopeck lost on
 * every request would move the site total, and positions would stop adding up to their row (the
 * `rollup.ts` rule, kept).
 */

/**
 * Decimal places carried exactly. Kopecks are two; a ticket's money is volume × price, that is
 * `numeric(12,3)` × `numeric(12,2)` — five places — and it must be summed before it is rounded.
 */
const SCALE = 5;
const TEN = 10n;

/** Digits of the output: money is published in kopecks by every report format (JSON and xlsx). */
const KOPECK_DIGITS = 2;

/**
 * An addend as an exact integer of 10⁻⁵ ₽.
 *
 * The number is read through its shortest round-trip text (`String`), not multiplied by 10⁵: a
 * decimal with up to fifteen significant digits — every `numeric` the layer reads — comes back from
 * that text exactly as PostgreSQL printed it, while `value * 100000` already carries the float
 * error this module exists to avoid. Digits beyond the fifth place (only float residue such as
 * 0.30000000000000004 can have them) are rounded half away from zero.
 */
export function moneyUnits(value: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError(`Сумма не является числом: ${value}`);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(value));
  if (!match) throw new RangeError(`Сумма не разобрана: ${value}`);
  const [, sign, whole = '0', fraction = '', exponent = '0'] = match;
  const digits = BigInt(`${whole}${fraction}`);
  // value = digits × 10^-places
  const places = fraction.length - Number(exponent);
  let units: bigint;
  if (places <= SCALE) {
    units = digits * TEN ** BigInt(SCALE - places);
  } else {
    const divisor = TEN ** BigInt(places - SCALE);
    units = digits / divisor + ((digits % divisor) * 2n >= divisor ? 1n : 0n);
  }
  return sign === '-' ? -units : units;
}

/**
 * Exact units to a number of roubles: rounded to kopecks half away from zero, then converted ONCE.
 * The conversion goes through decimal text, so the result is the double nearest to the exact
 * kopeck total; integer division by 100 after `Number(bigint)` would round twice above 2⁵³.
 */
export function unitsToRubles(units: bigint): number {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const divisor = TEN ** BigInt(SCALE - KOPECK_DIGITS);
  const kopecks = magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n);
  if (kopecks === 0n) return 0;
  const text = kopecks.toString().padStart(KOPECK_DIGITS + 1, '0');
  return Number(
    `${negative ? '-' : ''}${text.slice(0, -KOPECK_DIGITS)}.${text.slice(-KOPECK_DIGITS)}`,
  );
}

/** A running money total in exact units. */
export class MoneySum {
  #units = 0n;

  add(value: number): void {
    this.#units += moneyUnits(value);
  }

  /**
   * A derived total — fact plus estimate — from the running sums themselves. Adding two rounded
   * outputs instead would convert twice and, above kopeck precision of a double, publish a figure
   * that is not the nearest one to the exact total.
   */
  static combined(...sums: MoneySum[]): MoneySum {
    const result = new MoneySum();
    for (const sum of sums) result.#units += sum.#units;
    return result;
  }

  rubles(): number {
    return unitsToRubles(this.#units);
  }
}

/**
 * Exact sum of a few money figures converted once — for figures that are already outputs of this
 * module (rounded to kopecks), such as the fact and the estimate of one report row. Such a figure
 * holds its kopecks exactly while it is below 2⁴⁶ ≈ 7·10¹³ ₽, so the result equals the sum of the
 * underlying exact totals; above that the figures themselves have already lost their kopecks.
 */
export function addMoney(...values: number[]): number {
  const sum = new MoneySum();
  for (const value of values) sum.add(value);
  return sum.rubles();
}
