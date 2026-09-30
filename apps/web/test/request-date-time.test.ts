import { describe, expect, it } from 'vitest';
import { formatDateTimeMaybe } from '@entities/request';

describe('formatDateTimeMaybe', () => {
  it('не добавляет выдуманное время, если согласована только дата', () => {
    expect(formatDateTimeMaybe('2026-09-30T12:34:00.000Z', true)).toBe('30.09.2026');
  });

  it('показывает согласованное время в часовом поясе портала', () => {
    expect(formatDateTimeMaybe('2026-09-30T12:34:00.000Z', false)).toBe('30.09.2026 15:34');
  });

  it('показывает прочерк вместо отсутствующей отметки', () => {
    expect(formatDateTimeMaybe(null, false)).toBe('—');
    expect(formatDateTimeMaybe(undefined, true)).toBe('—');
  });
});
