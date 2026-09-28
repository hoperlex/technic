import { describe, expect, it } from 'vitest';
import {
  assignmentCorrectionClearsDay,
  dayRoutesKeptWith,
} from '../src/services/shift-approval-scope';

/**
 * The rule of ADR 0210 without a database: which sign-offs an assignment correction clears.
 *
 * The db suite (`shift-approval-scope.db.test.ts`) proves that the three callers ask this rule and
 * agree with each other; here the rule itself is pinned, so a change to it shows up as a failing
 * line of the decision rather than as a drifted fixture.
 */
describe('assignment correction and object sign-offs (ADR 0210)', () => {
  const routeDays = new Set(['2026-09-08']);

  it('a day in a day route keeps its sign-off — its vehicle is the route’s', () => {
    expect(assignmentCorrectionClearsDay('2026-09-08', { routeDays, range: null })).toBe(false);
    // Even inside the command's own range: the range says which days changed vehicle on the
    // assignment, and a route day was never the assignment's to begin with.
    expect(
      assignmentCorrectionClearsDay('2026-09-08', {
        routeDays,
        range: [{ from: '2026-09-01', to: '2026-09-30' }],
      }),
    ).toBe(false);
  });

  it('a route-less day loses its sign-off — it was worked by the assignment’s vehicle', () => {
    expect(assignmentCorrectionClearsDay('2026-09-09', { routeDays, range: null })).toBe(true);
  });

  it('a range bounds the clearing, and an empty range clears nothing', () => {
    const range = [{ from: '2026-09-01', to: '2026-09-07' }];
    expect(assignmentCorrectionClearsDay('2026-09-07', { routeDays, range })).toBe(true);
    expect(assignmentCorrectionClearsDay('2026-09-09', { routeDays, range })).toBe(false);
    expect(assignmentCorrectionClearsDay('2026-09-09', { routeDays, range: [] })).toBe(false);
  });

  it('day routes outlive the command only when the vehicle left on the assignment is own', () => {
    // A rented vehicle does not go on routes: the reassign door's day sync sweeps every day off
    // its route, and those days fall under the assignment again.
    expect(dayRoutesKeptWith('own')).toBe(true);
    expect(dayRoutesKeptWith('rental')).toBe(false);
  });
});
