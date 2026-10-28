import { describe, expect, it } from 'vitest';
import {
  driverDayInterval,
  driverDayTime,
  isShiftTimeFromDriver,
  durationLabel,
  requestRouteSpan,
  requestRouteStops,
  routeHoursForCompletion,
  routeScalarTimes,
  routeTimePrefill,
  type ReadingPointTimes,
  type RequestRouteTimeDto,
  type VehicleRequestShiftDto,
} from '@technic/contracts';

/**
 * Stage 3 of the readings-shifts merge (plan §8): the driver's times reach the requests. These are
 * the rules both sides ask — the server overlays a request day and splits a freight route by them,
 * the portal locks the inputs and proposes the completion by them. The wiring on the live schema is
 * in `request-driver-times.db.test.ts`.
 */

function esm2(startedAt: string | null, endedAt: string | null) {
  return { sourceKind: 'esm2' as const, times: { startedAt, endedAt, points: [] } };
}

function stops(...pairs: [string | null, string | null][]): ReadingPointTimes[] {
  return pairs.map(([arrivedAt, departedAt], index) => ({
    position: index + 1,
    arrivedAt: index === 0 ? arrivedAt : null,
    departedAt,
  }));
}

/** A route reading: its scalar pair is derived from the stops, as the write path stores it. */
function route(points: ReadingPointTimes[]) {
  return { sourceKind: 'route' as const, times: { ...routeScalarTimes(points), points } };
}

describe('время дня заявки по показаниям водителя', () => {
  it('одно показание ЭСМ-2 — его пара; конец раньше начала — следующие сутки', () => {
    expect(driverDayTime([esm2('08:00', '17:30')])).toEqual({
      startedAt: '08:00',
      endedAt: '17:30',
      intervals: [{ startedAt: '08:00', endedAt: '17:30' }],
      issue: null,
    });
    expect(driverDayTime([esm2('20:00', '06:00')])).toMatchObject({
      startedAt: '20:00',
      endedAt: '06:00',
      issue: null,
    });
  });

  it('рейс — прибытие на первую точку и отправление с последней', () => {
    const day = driverDayTime([route(stops(['07:40', '09:00'], [null, '11:15'], [null, '12:05']))]);
    expect(day).toMatchObject({ startedAt: '07:40', endedAt: '12:05', issue: null });
  });

  it('несколько показаний одного дня складываются в один интервал от раннего начала до позднего конца', () => {
    const day = driverDayTime([esm2('13:00', '18:00'), esm2('08:00', '12:00')]);
    expect(day.startedAt).toBe('08:00');
    expect(day.endedAt).toBe('18:00');
    // Intervals come in start order, whatever order the readings were read in.
    expect(day.intervals).toEqual([
      { startedAt: '08:00', endedAt: '12:00' },
      { startedAt: '13:00', endedAt: '18:00' },
    ]);
  });

  it('интервал через полночь допустим один раз, пока весь день не длиннее суток', () => {
    // Day shift then a night shift ending the next morning: 08:00 → 02:00, 18 h.
    expect(driverDayTime([esm2('08:00', '17:00'), esm2('18:00', '02:00')])).toMatchObject({
      startedAt: '08:00',
      endedAt: '02:00',
      issue: null,
    });
  });

  it('интервалы, не укладывающиеся в одни сутки, не сливаются — время указывает объект', () => {
    // 02:00 is unfolded on the day itself, before the night shift: 02:00 → 08:00 next day is 30 h.
    const day = driverDayTime([esm2('20:00', '08:00'), esm2('02:00', '06:00')]);
    expect(day).toMatchObject({ startedAt: null, endedAt: null, issue: 'ambiguous' });
    expect(day.intervals).toEqual([
      { startedAt: '02:00', endedAt: '06:00' },
      { startedAt: '20:00', endedAt: '08:00' },
    ]);
  });

  it('рейс нулевой длины не превращается в смену на сутки', () => {
    // The site's pair reads equal clock times as 24 h; a zero route must not become one.
    expect(driverDayTime([route(stops(['09:00', '09:00']))])).toMatchObject({
      startedAt: null,
      issue: 'ambiguous',
    });
  });

  it('показание без полной пары делает время дня неполным, а не коротким', () => {
    const day = driverDayTime([esm2('08:00', '12:00'), esm2('13:00', null)]);
    expect(day).toMatchObject({ startedAt: null, endedAt: null, issue: 'incomplete' });
    expect(day.intervals).toEqual([{ startedAt: '08:00', endedAt: '12:00' }]);
    // A relocation has no stops and no time (D8).
    expect(driverDayTime([route([])]).issue).toBe('incomplete');
    // A legacy reading recorded before times existed.
    expect(driverDayTime([esm2(null, null)]).issue).toBe('incomplete');
  });

  it('день без показаний — ни времени, ни причины', () => {
    expect(driverDayTime([])).toEqual({
      startedAt: null,
      endedAt: null,
      intervals: [],
      issue: null,
    });
  });
});

describe('время смены по водителю в окне и в таблице', () => {
  const base: Pick<VehicleRequestShiftDto, 'source' | 'filledAt' | 'driverDay'> = {
    source: 'driver',
    filledAt: null,
    driverDay: {
      machineHours: 9,
      refuelLiters: 0,
      clean: true,
      since: null,
      fingerprint: 'v1:x',
      startedAt: '08:00',
      endedAt: '17:00',
      intervals: [{ startedAt: '08:00', endedAt: '17:00' }],
      timeIssue: null,
    },
  };

  it('время водителя действует только в день водителя с одним интервалом', () => {
    expect(isShiftTimeFromDriver(base)).toBe(true);
    expect(isShiftTimeFromDriver({ ...base, source: 'site' })).toBe(false);
    expect(
      isShiftTimeFromDriver({
        ...base,
        driverDay: { ...base.driverDay!, startedAt: null, endedAt: null, timeIssue: 'ambiguous' },
      }),
    ).toBe(false);
  });

  it('сервер до этапа 3 времени не присылает — время остаётся за объектом', () => {
    const { startedAt: _s, endedAt: _e, intervals: _i, timeIssue: _t, ...old } = base.driverDay!;
    expect(driverDayInterval(old)).toBeNull();
    expect(isShiftTimeFromDriver({ ...base, driverDay: old })).toBe(false);
  });
});

describe('время по точкам грузоперевозки', () => {
  it('часы закрытия округляются вверх до целого часа после суммы (D12)', () => {
    expect(routeHoursForCompletion(2 * 3600 + 10 * 60)).toBe(3);
    expect(routeHoursForCompletion(2 * 3600)).toBe(2);
    expect(routeHoursForCompletion(1)).toBe(1);
    expect(routeHoursForCompletion(0)).toBe(0);
    // A share with a remainder second of the D6 split still rounds as a whole.
    expect(routeHoursForCompletion(3 * 3600 + 1)).toBe(4);
  });

  it('длительность читается часами и минутами — одна формулировка портала', () => {
    expect(durationLabel(2 * 3600 + 10 * 60)).toBe('2 ч 10 мин');
    // Minutes are an amount, not a clock: never zero-padded.
    expect(durationLabel(2 * 3600 + 5 * 60)).toBe('2 ч 5 мин');
    expect(durationLabel(45 * 60)).toBe('45 мин');
    expect(durationLabel(3 * 3600)).toBe('3 ч');
    expect(durationLabel(3 * 3600, { zeroMinutes: true })).toBe('3 ч 0 мин');
    expect(durationLabel(3 * 3600 + 60, { zeroMinutes: true })).toBe('3 ч 1 мин');
    expect(durationLabel(20)).toBe('меньше минуты');
    expect(durationLabel(0)).toBe('0 мин');
    expect(durationLabel(-90)).toBe('0 мин');
    // A split share with seconds rounds to the minute.
    expect(durationLabel(30 * 60 + 40)).toBe('31 мин');
  });

  it('предложение закрытия — часы вверх, иначе причина словами', () => {
    const time = (patch: Partial<RequestRouteTimeDto>): RequestRouteTimeDto => ({
      readings: [],
      seconds: null,
      issues: [],
      ...patch,
    });
    expect(routeTimePrefill(time({ seconds: 7800 }))).toEqual({
      ok: true,
      hours: 3,
      seconds: 7800,
    });
    expect(routeTimePrefill(time({ issues: ['no_data', 'incomplete'] }))).toEqual({
      ok: false,
      reason: 'смена рейса закрыта без показаний',
    });
    expect(routeTimePrefill(time({}))).toEqual({
      ok: false,
      reason: 'водитель ещё не сдал показания по рейсу',
    });
    expect(routeTimePrefill(time({ seconds: 0 }))).toMatchObject({ ok: false });
  });

  it('остановки заявки несут начало своего отрезка и число делящих его заявок (D6)', () => {
    const points = [
      {
        position: 1,
        location: 'Карьер',
        arrivedAt: '07:00',
        departedAt: '08:00',
        requestIds: ['a', 'b'],
      },
      {
        position: 2,
        location: 'Объект А',
        arrivedAt: null,
        departedAt: '09:30',
        requestIds: ['a'],
      },
      {
        position: 3,
        location: 'Объект Б',
        arrivedAt: null,
        departedAt: '10:00',
        requestIds: ['b'],
      },
    ];
    expect(requestRouteStops(points, 'b')).toEqual([
      {
        position: 1,
        location: 'Карьер',
        arrivedAt: '07:00',
        segmentFrom: '07:00',
        departedAt: '08:00',
        sharedBy: 2,
      },
      {
        position: 3,
        location: 'Объект Б',
        arrivedAt: null,
        segmentFrom: '09:30',
        departedAt: '10:00',
        sharedBy: 1,
      },
    ]);
    expect(requestRouteStops(points, 'c')).toEqual([]);
  });
});

describe('время линейного дня на общем рейсе (D13)', () => {
  const stop = (
    position: number,
    arrivedAt: string | null,
    departedAt: string | null,
    requestIds: string[],
  ) => ({ position, location: `Точка ${position}`, arrivedAt, departedAt, requestIds });

  it('день берёт время своих точек: от начала отрезка первой до отправления с последней', () => {
    // A quarry and an unloading for a freight request, then the site of the linear day.
    const points = [
      stop(1, '07:40', '09:10', ['freight']),
      stop(2, null, '11:00', ['freight']),
      stop(3, null, '15:20', ['linear']),
    ];
    const span = requestRouteSpan(points, 'linear');
    expect(span).toEqual({
      points: [{ position: 3, arrivedAt: '11:00', departedAt: '15:20' }],
      shared: true,
    });
    expect(driverDayTime([route(span.points)])).toMatchObject({
      startedAt: '11:00',
      endedAt: '15:20',
      issue: null,
    });
  });

  it('чужая точка между своими входит в отрезок дня, как D6 режет перевозку', () => {
    const points = [
      stop(1, '07:00', '08:00', ['linear']),
      stop(2, null, '09:00', ['freight']),
      stop(3, null, '23:30', ['linear', 'freight']),
      stop(4, null, '00:30', ['freight']),
    ];
    const span = requestRouteSpan(points, 'linear');
    expect(span.points.map((point) => point.position)).toEqual([1, 2, 3]);
    expect(driverDayTime([route(span.points)])).toMatchObject({
      startedAt: '07:00',
      endedAt: '23:30',
    });
  });

  it('рейс одной заявки — весь рейс и не общий', () => {
    const points = [stop(1, '06:50', '12:00', ['linear']), stop(2, null, '17:10', ['linear'])];
    const span = requestRouteSpan(points, 'linear');
    expect(span.shared).toBe(false);
    expect(span.points).toEqual(stops(['06:50', '12:00'], [null, '17:10']));
  });

  it('точки рейса без этой заявки времени дню не дают, а незаписанное отправление — неполное время', () => {
    expect(requestRouteSpan([stop(1, '07:00', '08:00', ['freight'])], 'linear')).toEqual({
      points: [],
      shared: true,
    });
    const interim = requestRouteSpan(
      [stop(1, '07:00', null, ['freight']), stop(2, null, '12:00', ['linear'])],
      'linear',
    );
    expect(interim.points).toEqual([{ position: 2, arrivedAt: null, departedAt: '12:00' }]);
    expect(driverDayTime([route(interim.points)]).issue).toBe('incomplete');
  });
});
