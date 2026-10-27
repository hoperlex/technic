import { describe, expect, it } from 'vitest';
import { oldestLabel } from '../src/features/ticket-audit/model/operations';

/**
 * The age of the oldest queued task reads under a day through the portal's one duration wording
 * (`durationLabel`), and in days beyond it — the only part this screen words on its own.
 */
describe('возраст старейшей задачи очереди', () => {
  it('до суток — часы и минуты общей формулировкой, дальше — сутки', () => {
    expect(oldestLabel(null)).toBe('очередь пуста');
    expect(oldestLabel(0)).toBe('старейшая 0 мин');
    expect(oldestLabel(45)).toBe('старейшая 45 мин');
    expect(oldestLabel(125)).toBe('старейшая 2 ч 5 мин');
    expect(oldestLabel(120)).toBe('старейшая 2 ч');
    expect(oldestLabel(49 * 60 + 10)).toBe('старейшая 2 сут 1 ч');
  });
});
