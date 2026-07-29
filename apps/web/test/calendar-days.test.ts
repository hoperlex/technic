import { describe, expect, it } from 'vitest';
import { calendarDaysLabel } from '../src/utils/date';

/**
 * Подсказка о длине периода в заявке на технику: обе границы входят в срок, пустая дата
 * окончания — один день (сервер считает период тем же `coalesce(date_to, date_from)`).
 */
describe('calendarDaysLabel', () => {
  it('включает обе границы периода', () => {
    expect(calendarDaysLabel('2026-08-01', '2026-08-03')).toBe('3 календарных дня');
  });

  it('без даты окончания — один день', () => {
    expect(calendarDaysLabel('2026-08-01')).toBe('1 календарный день');
    expect(calendarDaysLabel('2026-08-01', null)).toBe('1 календарный день');
  });

  it('считает через границу месяца', () => {
    expect(calendarDaysLabel('2026-01-28', '2026-02-02')).toBe('6 календарных дней');
  });

  it('склоняет число дней', () => {
    expect(calendarDaysLabel('2026-08-01', '2026-08-01')).toBe('1 календарный день');
    expect(calendarDaysLabel('2026-08-01', '2026-08-02')).toBe('2 календарных дня');
    expect(calendarDaysLabel('2026-08-01', '2026-08-05')).toBe('5 календарных дней');
    // 11–14 — «дней» вопреки последней цифре.
    expect(calendarDaysLabel('2026-08-01', '2026-08-11')).toBe('11 календарных дней');
    expect(calendarDaysLabel('2026-08-01', '2026-08-14')).toBe('14 календарных дней');
    expect(calendarDaysLabel('2026-08-01', '2026-08-21')).toBe('21 календарный день');
    expect(calendarDaysLabel('2026-08-01', '2026-08-23')).toBe('23 календарных дня');
  });

  it('не считает период, у которого конец раньше начала', () => {
    expect(calendarDaysLabel('2026-08-05', '2026-08-01')).toBeNull();
  });
});
