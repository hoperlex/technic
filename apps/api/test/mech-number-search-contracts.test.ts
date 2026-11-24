import { describe, expect, it } from 'vitest';
import {
  mechRequestHistoryQuerySchema,
  mechRequestListQuerySchema,
  parseMechRequestNumberSearch,
  parseMechRequestNumberTerm,
} from '@technic/contracts';

/**
 * The number a person types into a mechanization search box. Two parsers on purpose: the lax one
 * serves the office's number-only field, the strict one the lessor's mixed search (number OR text).
 * `mech_requests.num` is an int4, so everything above 2147483647 must never reach a comparison:
 * Postgres answers it with 22003, a 500, instead of "no rows".
 */

describe('the strict number term of a mixed search', () => {
  it.each([
    ['МХ-42', 42],
    ['мх-42', 42],
    ['мх42', 42],
    ['MX 42', 42],
    ['mx-42', 42],
    // Cyrillic and Latin letters in one prefix: the layout is switched mid-word.
    ['Мx-42', 42],
    ['№42', 42],
    ['№ 42', 42],
    ['№ МХ-42', 42],
    [' 42 ', 42],
    ['42', 42],
    ['2147483647', 2147483647],
  ])('%j finds the number %i', (term, num) => {
    expect(parseMechRequestNumberTerm(term)).toBe(num);
  });

  it.each([
    // A text search that merely contains digits stays a text search.
    ['Ленина 15'],
    ['Wacker 3070'],
    ['МХ-'],
    ['МХ'],
    ['42 дом'],
    [''],
    [' '],
    // The number is positive: there is no request 0.
    ['0'],
    ['МХ-0'],
    // Beyond the int4 column and beyond the safe-integer range.
    ['2147483648'],
    ['99999999999'],
    ['99999999999999999999'],
  ])('%j is not a number', (term) => {
    expect(parseMechRequestNumberTerm(term)).toBeUndefined();
  });
});

describe('the lax number of the office field', () => {
  it('still takes the first digits wherever they stand', () => {
    expect(parseMechRequestNumberSearch('МХ-42')).toBe(42);
    expect(parseMechRequestNumberSearch('мх42')).toBe(42);
    expect(parseMechRequestNumberSearch('42')).toBe(42);
    expect(parseMechRequestNumberSearch('Ленина 15')).toBe(15);
    expect(parseMechRequestNumberSearch('МХ-')).toBeUndefined();
    expect(parseMechRequestNumberSearch('0')).toBeUndefined();
  });

  it('passes an oversized number on, so the query schema answers it with a 400', () => {
    expect(parseMechRequestNumberSearch('99999999999')).toBe(99999999999);
  });
});

describe('the office number filter is capped at the column', () => {
  it.each([
    ['the list', mechRequestListQuerySchema],
    ['the journal', mechRequestHistoryQuerySchema],
  ])('%s accepts the largest int4 and refuses the next one', (_name, schema) => {
    expect(schema.safeParse({ num: '2147483647' }).success).toBe(true);
    expect(schema.safeParse({ num: '2147483648' }).success).toBe(false);
    expect(schema.safeParse({ num: '99999999999' }).success).toBe(false);
  });
});
