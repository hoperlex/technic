import { describe, expect, it } from 'vitest';
import {
  DRIVER_SHIFT_READING_STATUSES,
  driverScheduleSummary,
  driverShiftReadingStatus,
  driverShiftReadingStatusColors,
  driverShiftReadingStatusLabels,
  type DriverReportState,
  garageDriverScheduleQuerySchema,
  monthRange,
  shiftMonthKey,
} from '@technic/contracts';

/**
 * The pure half of the garage driver schedule: the month step the window's arrows take, the
 * status of one shift and the month's three numbers. The shift set itself is SQL and lives in the
 * db test (`garage-driver-schedule.db.test.ts`).
 */

const TODAY = '2026-10-15';

describe('месяц графика', () => {
  it('шаг месяца переходит границу года в обе стороны', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01');
    expect(shiftMonthKey('2026-10', 0)).toBe('2026-10');
    expect(shiftMonthKey('2026-03', -14)).toBe('2025-01');
  });

  it('границы месяца считает monthRange, и февраль високосного года — 29 дней', () => {
    expect(monthRange(shiftMonthKey('2028-03', -1))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('запрос принимает месяц или ничего, и не принимает день и лишних ключей', () => {
    expect(garageDriverScheduleQuerySchema.parse({})).toEqual({});
    expect(garageDriverScheduleQuerySchema.parse({ month: '2026-10' })).toEqual({
      month: '2026-10',
    });
    expect(garageDriverScheduleQuerySchema.safeParse({ month: '2026-10-01' }).success).toBe(false);
    expect(garageDriverScheduleQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(garageDriverScheduleQuerySchema.safeParse({ on: TODAY }).success).toBe(false);
  });
});

describe('состояние показания смены', () => {
  const base = {
    expectsReading: true,
    date: '2026-10-10',
    today: TODAY,
    reportState: null,
    readingKind: null,
  } as const;

  it('день без листа ничего не ждёт — даже если отчёт за день есть', () => {
    expect(driverShiftReadingStatus({ ...base, expectsReading: false })).toBe('not_expected');
    expect(
      driverShiftReadingStatus({
        ...base,
        expectsReading: false,
        reportState: 'accepted',
        readingKind: 'values',
      }),
    ).toBe('not_expected');
  });

  it('показание в переданном отчёте называется состоянием отчёта', () => {
    const of = (reportState: DriverReportState) =>
      driverShiftReadingStatus({ ...base, reportState, readingKind: 'values' });
    expect(of('submitted')).toBe('submitted');
    expect(of('accepted')).toBe('accepted');
    expect(of('needs_reacceptance')).toBe('needs_reacceptance');
  });

  it('«нет данных» старше состояния отчёта: причина нужна и после приёма', () => {
    expect(
      driverShiftReadingStatus({ ...base, reportState: 'accepted', readingKind: 'no_data' }),
    ).toBe('no_data');
  });

  it('черновик и аннулированный отчёт показания не дают', () => {
    expect(driverShiftReadingStatus({ ...base, reportState: 'draft', readingKind: 'values' })).toBe(
      'not_submitted',
    );
    expect(
      driverShiftReadingStatus({ ...base, reportState: 'voided', readingKind: 'values' }),
    ).toBe('not_submitted');
  });

  it('сегодня уже ждут, завтра — ещё нет', () => {
    expect(driverShiftReadingStatus({ ...base, date: TODAY })).toBe('not_submitted');
    expect(driverShiftReadingStatus({ ...base, date: '2026-10-16' })).toBe('upcoming');
    expect(
      driverShiftReadingStatus({ ...base, date: '2026-10-16', reportState: 'submitted' }),
    ).toBe('upcoming');
  });

  it('у каждого состояния есть подпись и цвет', () => {
    for (const status of DRIVER_SHIFT_READING_STATUSES) {
      expect(driverShiftReadingStatusLabels[status]).toBeTruthy();
      expect(driverShiftReadingStatusColors[status]).toBeTruthy();
    }
  });
});

describe('итог месяца', () => {
  it('ожидаемые — все дни с листом, пропущенные — только наступившие без показания', () => {
    expect(
      driverScheduleSummary([
        'submitted',
        'accepted',
        'needs_reacceptance',
        'no_data',
        'not_submitted',
        'not_submitted',
        'upcoming',
        'not_expected',
      ]),
    ).toEqual({ expected: 7, submitted: 4, missing: 2 });
    expect(driverScheduleSummary([])).toEqual({ expected: 0, submitted: 0, missing: 0 });
  });
});
