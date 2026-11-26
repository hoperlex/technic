import { describe, expect, it } from 'vitest';
import {
  MECH_RATE_UNITS,
  mechRateUnitLabels,
  mechRateUnitRateLabels,
  mechRateUnitSchema,
  mechUnitsLabel,
} from '@technic/contracts';

/**
 * The rate units of a mechanization rental (ADR 0152 decision 4, ADR 0251). The list mirrors the
 * database enum `mech_rate_unit`; a value the contracts know and the base does not would fail the
 * take-in-work at the INSERT, so the order and the set are pinned here and in migration 0432.
 */
describe('rate units: hour, shift and day (ADR 0251)', () => {
  it('the set and its order match the database enum', () => {
    expect(MECH_RATE_UNITS).toEqual(['hour', 'shift', 'day']);
    expect(mechRateUnitSchema.parse('day')).toBe('day');
    expect(mechRateUnitSchema.safeParse('days').success).toBe(false);
  });

  it('every unit has its picker word and its rate caption', () => {
    expect(mechRateUnitLabels).toEqual({ hour: 'час', shift: 'смена', day: 'сутки' });
    expect(mechRateUnitRateLabels).toEqual({
      hour: 'за час',
      shift: 'за смену',
      day: 'за сутки',
    });
  });

  it('worked days are abbreviated like hours, fractions included', () => {
    expect(mechUnitsLabel('day', 1)).toBe('1 сут.');
    expect(mechUnitsLabel('day', 21)).toBe('21 сут.');
    expect(mechUnitsLabel('day', 4.5)).toBe('4,5 сут.');
    // The other two keep the shared declension of the vehicle module.
    expect(mechUnitsLabel('hour', 26)).toBe('26 ч');
    expect(mechUnitsLabel('shift', 11)).toBe('11 смен');
  });
});
