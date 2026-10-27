import { describe, expect, it } from 'vitest';
import {
  driverReadingTimeIssues,
  readingHasShiftEnd,
  readingInputSchema,
  readingPointsInputSchema,
  readingShiftMinutes,
  readingTimeIssues,
  reportSubmitSchema,
  routeElapsed,
  routeScalarTimes,
  routeTimeByRequest,
  shiftSpanHours,
  shiftSpanMinutes,
  type ReadingPointTimes,
} from '@technic/contracts';

/**
 * Shift and stop times of a reading (ADR 0234): the contract functions the cabinet previews with
 * and the readings service enforces with. One rule, so one set of tests — the service's own
 * behaviour on top of them is in `reading-times.db.test.ts`.
 */

function stops(...pairs: [string | null, string | null][]): ReadingPointTimes[] {
  return pairs.map(([arrivedAt, departedAt], index) => ({
    position: index + 1,
    arrivedAt: index === 0 ? arrivedAt : null,
    departedAt,
  }));
}

const NO_END = { odometerKm: null, engineHours: null, fuelEndLiters: null };
const ENDED = { odometerKm: 120_000, engineHours: null, fuelEndLiters: null };

describe('пара начала и конца: один толкователь', () => {
  it('конец раньше начала — следующие сутки, равные времена — 24 часа, как у смены объекта', () => {
    expect(shiftSpanMinutes('20:00', '08:00')).toBe(720);
    expect(shiftSpanMinutes('08:00', '08:00')).toBe(24 * 60);
    expect(shiftSpanMinutes('08:00', null)).toBeNull();
    // The hours the site's window shows are the same reading of the pair, rounded.
    expect(shiftSpanHours('08:00', '10:10')).toBe(2.17);
    expect(readingShiftMinutes('esm2', { startedAt: '08:00', endedAt: '10:10', points: [] })).toBe(
      130,
    );
  });
});

describe('время рейса — сумма шагов', () => {
  it('равное следующее время — нулевой шаг, а не сутки', () => {
    const result = routeElapsed(stops(['08:00', '08:00'], [null, '08:00']));
    expect(result).toEqual({ minutes: 0, issue: null });
    // The pair reading would call the same clock times 24 h: the sequence is what tells them apart.
    expect(routeScalarTimes(stops(['08:00', '08:00']))).toEqual({
      startedAt: '08:00',
      endedAt: '08:00',
    });
  });

  it('через полночь — один раз, и не дольше суток', () => {
    expect(routeElapsed(stops(['22:00', '23:30'], [null, '01:15'])).minutes).toBe(195);
    const twice = routeElapsed(stops(['22:00', '01:00'], [null, '23:00'], [null, '02:00']));
    expect(twice.minutes).toBeNull();
    expect(twice.issue?.code).toBe('order');
    expect(twice.issue?.position).toBe(3);
    const long = routeElapsed(stops(['08:00', '20:00'], [null, '07:00'], [null, '09:00']));
    expect(long.issue?.code).toBe('too_long');
  });

  it('незаконченный рейс длительности не имеет, но порядок в нём проверяется', () => {
    expect(routeElapsed(stops(['08:00', '09:00'], [null, null]))).toEqual({
      minutes: null,
      issue: null,
    });
    expect(routeScalarTimes(stops(['08:00', '09:00'], [null, null]))).toEqual({
      startedAt: '08:00',
      endedAt: null,
    });
    expect(readingShiftMinutes('route', { startedAt: null, endedAt: null, points: [] })).toBeNull();
  });
});

describe('форма времени — для всех авторов', () => {
  it('у недельного листа нет остановок, и конец без начала не бывает', () => {
    const codes = readingTimeIssues('esm2', {
      startedAt: null,
      endedAt: '18:00',
      points: stops(['08:00', '09:00']),
    }).map((issue) => issue.code);
    expect(codes).toEqual(['points_not_allowed', 'start_missing']);
  });

  it('пустое время законно: обязательность — правило водителя, а не формы', () => {
    expect(readingTimeIssues('esm2', { startedAt: null, endedAt: null, points: [] })).toEqual([]);
    expect(
      readingTimeIssues('route', { startedAt: null, endedAt: null, points: stops([null, null]) }),
    ).toEqual([]);
  });
});

describe('обязательность у водителя (D11): «закончил» — по вечерним числам', () => {
  it('ЭСМ-2: начало — всегда, конец — вместе с вечерними числами', () => {
    const issues = (startedAt: string | null, endedAt: string | null, values = NO_END) =>
      driverReadingTimeIssues({
        sourceKind: 'esm2',
        hasStops: false,
        values,
        times: { startedAt, endedAt, points: [] },
      }).map((issue) => issue.code);
    expect(issues(null, null)).toEqual(['start_missing']);
    // A morning interim reading needs only the start.
    expect(issues('08:00', null)).toEqual([]);
    expect(issues('08:00', null, ENDED)).toEqual(['end_missing']);
    expect(issues('08:00', '18:00', ENDED)).toEqual([]);
    // The driver is asked instead of having 24 h guessed for him.
    expect(issues('08:00', '08:00', ENDED)).toEqual(['equal_times']);
  });

  it('рейс: прибытие на первую — всегда, отправление с каждой — вместе с вечерними числами', () => {
    const issues = (points: ReadingPointTimes[], values = NO_END) =>
      driverReadingTimeIssues({
        sourceKind: 'route',
        hasStops: true,
        values,
        times: { ...routeScalarTimes(points), points },
      }).map((issue) => `${issue.code}:${issue.position}`);
    expect(issues([])).toEqual(['arrival_missing:1']);
    expect(issues(stops(['08:00', null], [null, null]))).toEqual([]);
    expect(issues(stops(['08:00', '09:00'], [null, null]), ENDED)).toEqual(['departure_missing:2']);
    // Fuel left at the end is an evening value too (ADR 0163 Р8).
    expect(
      issues(stops(['08:00', null], [null, null]), { ...NO_END, fuelEndLiters: 40 }),
    ).toHaveLength(2);
  });

  it('перегон времени не записывает (D8)', () => {
    expect(
      driverReadingTimeIssues({
        sourceKind: 'route',
        hasStops: false,
        values: ENDED,
        times: { startedAt: null, endedAt: null, points: [] },
      }),
    ).toEqual([]);
  });

  it('вечерние числа — одометр, моточасы или остаток на конец; заправка и утро — нет', () => {
    expect(readingHasShiftEnd({ odometerKm: null, engineHours: 5, fuelEndLiters: null })).toBe(
      true,
    );
    expect(readingHasShiftEnd({ odometerKm: null, engineHours: null })).toBe(false);
    expect(readingHasShiftEnd({ odometerKm: 0, engineHours: null })).toBe(true);
  });
});

describe('время рейса по заявкам (D6)', () => {
  const R1 = '11111111-1111-4111-8111-111111111111';
  const R2 = '22222222-2222-4222-8222-222222222222';
  const R3 = '33333333-3333-4333-8333-333333333333';

  it('две ездки одной заявки на одной точке — одна доля', () => {
    const points = stops(['08:00', '09:00'], [null, '10:00']);
    const result = routeTimeByRequest(
      points,
      new Map([
        [1, [R1, R1, R2]],
        [2, [R2]],
      ]),
    );
    expect(result).toEqual({
      ok: true,
      totalSeconds: 7200,
      byRequest: { [R1]: 1800, [R2]: 5400 },
    });
  });

  it('неделимый остаток раздаётся по возрастанию номера заявки, сумма сходится точно', () => {
    // Seven minutes by three requests divide evenly; one minute by seven requests does not.
    const points = stops(['08:00', '08:07']);
    const result = routeTimeByRequest(points, new Map([[1, [R3, R1, R2]]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byRequest).toEqual({ [R1]: 140, [R2]: 140, [R3]: 140 });
    const odd = routeTimeByRequest(
      stops(['08:00', '08:01']),
      new Map([[1, ['a', 'b', 'c', 'd', 'e', 'f', 'g']]]),
    );
    expect(odd.ok && Object.values(odd.byRequest)).toEqual([9, 9, 9, 9, 8, 8, 8]);
    expect(odd.ok && Object.values(odd.byRequest).reduce((a, b) => a + b, 0)).toBe(60);
  });

  it('через полночь доли считаются по шагам, а сумма равна смене', () => {
    const points = stops(['23:00', '23:30'], [null, '00:30']);
    const result = routeTimeByRequest(
      points,
      new Map([
        [1, [R1]],
        [2, [R1, R2]],
      ]),
    );
    expect(result).toEqual({ ok: true, totalSeconds: 5400, byRequest: { [R1]: 3600, [R2]: 1800 } });
  });

  it('точка без заявки и незаконченный рейс не делятся', () => {
    const points = stops(['08:00', '09:00'], [null, '10:00']);
    expect(routeTimeByRequest(points, new Map([[1, [R1]]]))).toEqual({
      ok: false,
      reason: 'unassigned',
    });
    expect(routeTimeByRequest(stops(['08:00', null]), new Map([[1, [R1]]]))).toEqual({
      ok: false,
      reason: 'incomplete',
    });
  });
});

describe('провод: ключи времени без умолчаний', () => {
  it('тело старой сборки разбирается без новых ключей — отпечаток повтора тот же', () => {
    const parsed = reportSubmitSchema.parse({
      version: 3,
      items: [
        {
          itemId: '44444444-4444-4444-8444-444444444444',
          reading: { kind: 'values', odometerKm: 1000 },
        },
      ],
    });
    const reading = parsed.items[0]!.reading;
    expect('startedAt' in reading).toBe(false);
    expect('endedAt' in reading).toBe(false);
    expect('points' in reading).toBe(false);
  });

  it('остановки идут подряд с первой, прибытие — только на первой', () => {
    const point = (position: number, arrivedAt: string | null = null) => ({
      position,
      routePointId: null,
      arrivedAt,
      departedAt: null,
    });
    expect(readingPointsInputSchema.safeParse([point(1, '08:00'), point(2)]).success).toBe(true);
    expect(readingPointsInputSchema.safeParse([point(1), point(3)]).success).toBe(false);
    expect(readingPointsInputSchema.safeParse([point(1), point(2, '09:00')]).success).toBe(false);
    expect(
      readingInputSchema.safeParse({ kind: 'values', odometerKm: 1, startedAt: '8:00' }).success,
    ).toBe(false);
  });
});
