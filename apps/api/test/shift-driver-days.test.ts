import { describe, expect, it } from 'vitest';
import {
  driverDayDto,
  driverDiagnosticsDto,
  driverShiftDayOf,
  type DriverShiftReading,
} from '../src/services/shift-driver-days';

/**
 * The rule of a driver day (readings-shifts-merge plan §6.2, D3, D16): when the driver's readings
 * are the request day's numbers in one click, and what a non-clean day still carries. Pure — the
 * live wiring (both source branches, report states, the continuity query, the doors) is proven by
 * `shift-driver-days.db.test.ts`.
 */

const DAY = '2026-08-12';

function reading(over: Partial<DriverShiftReading> = {}): DriverShiftReading {
  return {
    readingId: 'reading-1',
    version: 1,
    itemId: 'item-1',
    reportState: 'submitted',
    personName: 'Машинистов Иван Петрович',
    sourceKind: 'esm2',
    sourceId: 'waybill-1',
    sourceLabel: 'ЭСМ-2 № 0012',
    kind: 'values',
    engineHours: 1208.5,
    engineHoursAnomaly: null,
    previousId: 'reading-0',
    previousEngineHours: 1200,
    previousDate: '2026-08-11',
    continuous: true,
    fuelFilledLiters: 120,
    noDataReason: '',
    comment: '',
    discrepancies: [],
    times: { startedAt: null, endedAt: null, points: [] },
    sharedRoute: false,
    ...over,
  };
}

describe('день водителя', () => {
  it('a reading after yesterday’s snapshot is clean: hours are the delta, refuelling the liters', () => {
    const day = driverShiftDayOf(DAY, [reading()]);
    expect(day).toMatchObject({
      machineHours: 8.5,
      refuelLiters: 120,
      clean: true,
      since: null,
      issues: [],
    });
    expect(day.fingerprint).toMatch(/^v1:/);
    // The predecessor may be of the same day: the vehicle's earlier shift.
    expect(driverShiftDayOf(DAY, [reading({ previousDate: DAY })]).clean).toBe(true);
  });

  it('several items of one day sum, without binary noise', () => {
    const day = driverShiftDayOf(DAY, [
      reading({ engineHours: 1200.3, previousEngineHours: 1200.1, fuelFilledLiters: 10.1 }),
      reading({
        readingId: 'reading-2',
        itemId: 'item-2',
        engineHours: 1200.7,
        previousEngineHours: 1200.3,
        previousId: 'reading-1',
        previousDate: DAY,
        fuelFilledLiters: 20.2,
      }),
    ]);
    expect(day.machineHours).toBe(0.6);
    expect(day.refuelLiters).toBe(30.3);
    expect(day.clean).toBe(true);
  });

  it('a broken pair is a gap: the sum stays, «since» names its predecessor (D16)', () => {
    const day = driverShiftDayOf(DAY, [
      reading({ previousDate: '2026-08-09', engineHours: 1223, continuous: false }),
    ]);
    expect(day).toMatchObject({ machineHours: 23, clean: false, since: '2026-08-09' });
    expect(day.issues).toEqual(['gap']);
  });

  it('a predecessor days back over a continuous pair is clean: the calendar alone breaks nothing (D16)', () => {
    // A Monday after a weekend without expected shifts: the garage's rule finds no missed shift.
    const day = driverShiftDayOf(DAY, [reading({ previousDate: '2026-08-08', engineHours: 1208 })]);
    expect(day).toMatchObject({ machineHours: 8, clean: true, since: null, issues: [] });
  });

  it('a first snapshot, no_data, a missing counter and a reset are not clean', () => {
    const first = driverShiftDayOf(DAY, [
      reading({ previousId: null, previousEngineHours: null, previousDate: null }),
    ]);
    expect(first).toMatchObject({ clean: false, machineHours: null, issues: ['first_snapshot'] });

    const noData = driverShiftDayOf(DAY, [
      reading({
        kind: 'no_data',
        engineHours: null,
        fuelFilledLiters: null,
        noDataReason: 'счётчик неисправен',
      }),
    ]);
    expect(noData).toMatchObject({
      clean: false,
      machineHours: null,
      refuelLiters: null,
      issues: ['no_data'],
    });

    const missing = driverShiftDayOf(DAY, [reading({ engineHours: null })]);
    expect(missing).toMatchObject({ clean: false, issues: ['missing_engine_hours'] });

    const reset = driverShiftDayOf(DAY, [
      reading({ engineHours: 3, engineHoursAnomaly: 'counter_reset' }),
    ]);
    expect(reset).toMatchObject({ clean: false, machineHours: null, issues: ['counter_reset'] });
  });

  it('an unresolved vehicle, date or source-state discrepancy blocks; driver and resolved ones do not', () => {
    for (const kind of ['vehicle', 'date', 'source_state'] as const) {
      const day = driverShiftDayOf(DAY, [reading({ discrepancies: [{ kind, resolved: false }] })]);
      expect(day.clean, kind).toBe(false);
      expect(day.issues, kind).toEqual(['discrepancy']);
      expect(
        driverShiftDayOf(DAY, [reading({ discrepancies: [{ kind, resolved: true }] })]).clean,
        `${kind} resolved`,
      ).toBe(true);
    }
    // The counter is the vehicle's: a substitute machinist is the ordinary case.
    expect(
      driverShiftDayOf(DAY, [reading({ discrepancies: [{ kind: 'driver', resolved: false }] })])
        .clean,
    ).toBe(true);
  });

  it('a sum outside 0..24 is not signable in one click', () => {
    const day = driverShiftDayOf(DAY, [reading({ engineHours: 1230 })]);
    expect(day).toMatchObject({ machineHours: 30, clean: false, issues: ['out_of_range'] });
  });

  it('an empty refill reads as not refuelled, as the garage aggregate reads it', () => {
    const day = driverShiftDayOf(DAY, [reading({ fuelFilledLiters: null })]);
    expect(day).toMatchObject({ refuelLiters: 0, clean: true });
  });

  it('the fingerprint covers readings, versions, predecessors, sources and numbers — not the report state', () => {
    const base = driverShiftDayOf(DAY, [reading()]).fingerprint;
    expect(driverShiftDayOf(DAY, [reading({ reportState: 'accepted' })]).fingerprint).toBe(base);
    expect(driverShiftDayOf(DAY, [reading({ personName: 'Другой' })]).fingerprint).toBe(base);
    for (const over of [
      { version: 2 },
      { previousId: 'reading-x' },
      { sourceId: 'waybill-2' },
      { sourceKind: 'route' as const },
      { engineHours: 1209 },
      { previousEngineHours: 1201 },
      { fuelFilledLiters: 100 },
      { readingId: 'reading-9' },
    ]) {
      expect(driverShiftDayOf(DAY, [reading(over)]).fingerprint, JSON.stringify(over)).not.toBe(
        base,
      );
    }
  });

  it('the driver interval is part of the day and of what is signed; a day without one keeps its fingerprint', () => {
    const untimed = driverShiftDayOf(DAY, [reading()]);
    expect(untimed).toMatchObject({ startedAt: null, endedAt: null, timeIssue: 'incomplete' });
    const timed = driverShiftDayOf(DAY, [
      reading({ times: { startedAt: '08:00', endedAt: '17:00', points: [] } }),
    ]);
    expect(timed).toMatchObject({ startedAt: '08:00', endedAt: '17:00', timeIssue: null });
    expect(timed.fingerprint).not.toBe(untimed.fingerprint);
    // A clean day stays clean without a time: the time decides only what is shown and written.
    expect(untimed.clean).toBe(true);
    // A day without driver times hashes exactly as before stage 3, so an open tab is not refused.
    expect(untimed.fingerprint).toBe(
      driverShiftDayOf(DAY, [reading({ times: { startedAt: '08:00', endedAt: null, points: [] } })])
        .fingerprint,
    );
  });

  it('a shared route marks the day; the hours stay the route reading’s whole delta (D13)', () => {
    const route = { sourceKind: 'route' as const, sourceId: 'route-1', sourceLabel: 'Р-12' };
    const shared = driverShiftDayOf(DAY, [reading({ ...route, sharedRoute: true })]);
    expect(shared).toMatchObject({ machineHours: 8.5, clean: true, sharedRoute: true });
    expect(driverDayDto(shared).sharedRoute).toBe(true);
    // The mark explains the hours, it signs nothing: the fingerprint does not move with it.
    expect(shared.fingerprint).toBe(driverShiftDayOf(DAY, [reading(route)]).fingerprint);
    expect(driverShiftDayOf(DAY, [reading()]).sharedRoute).toBe(false);
  });

  it('the public part carries numbers only; the diagnostics carry names, comments and states', () => {
    const day = driverShiftDayOf(DAY, [
      reading({
        comment: 'работали без обеда',
        discrepancies: [{ kind: 'driver', resolved: false }],
      }),
    ]);
    // The shift time is a number of the day too (plan §8): everyone who reads the request sees it.
    expect(Object.keys(driverDayDto(day)).sort()).toEqual([
      'clean',
      'endedAt',
      'fingerprint',
      'intervals',
      'machineHours',
      'refuelLiters',
      'sharedRoute',
      'since',
      'startedAt',
      'timeIssue',
    ]);
    expect(driverDiagnosticsDto(day).readings[0]).toMatchObject({
      personName: 'Машинистов Иван Петрович',
      reportState: 'submitted',
      sourceLabel: 'ЭСМ-2 № 0012',
      machineHours: 8.5,
      comment: 'работали без обеда',
      discrepancies: [{ kind: 'driver', resolved: false }],
    });
    // The comment lives in the diagnostics only: the day carries no reading text the doors could
    // copy into the public shift row (D10).
    expect(day).not.toHaveProperty('comment');
  });
});
