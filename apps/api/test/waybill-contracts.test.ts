import { describe, expect, it } from 'vitest';
import {
  cancelWaybillSchema,
  formatWaybillNumber,
  isWaybillEditable,
  WAYBILL_FORM_CODES,
  WAYBILL_STATUSES,
  waybillDisplayNumber,
  waybillFormLabels,
  waybillStatusLabels,
} from '@technic/contracts';

/**
 * Путевой лист — документ строгой отчётности (ADR 0037): его ищут и сверяют по номеру, поэтому
 * печатное представление номера обязано быть одним и тем же в журнале, на бланке и в разговоре.
 */

describe('номер путевого листа', () => {
  it('печатается с ведущими нулями до ширины серии', () => {
    expect(formatWaybillNumber(4897, 8)).toBe('00004897');
    expect(formatWaybillNumber(1, 8)).toBe('00000001');
  });

  it('номер длиннее ширины не обрезается: потерянная цифра — другой документ', () => {
    expect(formatWaybillNumber(123456789, 8)).toBe('123456789');
  });

  it('с серией читается так, как напечатан на бланке', () => {
    expect(waybillDisplayNumber('260604-646-', 4897, 8)).toBe('260604-646-00004897');
  });

  it('без серии остаётся один номер — префикс у новой серии пуст', () => {
    expect(waybillDisplayNumber('', 4897, 8)).toBe('00004897');
  });
});

describe('состояния и бланки', () => {
  it('черновика у листа нет: он рождается выданным', () => {
    expect(WAYBILL_STATUSES).toEqual(['issued', 'cancelled']);
  });

  it('у каждого состояния и бланка есть подпись — их читает человек', () => {
    expect(WAYBILL_STATUSES.filter((s) => !waybillStatusLabels[s])).toEqual([]);
    expect(WAYBILL_FORM_CODES.filter((f) => !waybillFormLabels[f])).toEqual([]);
  });

  it('бланки объявлены все три, хотя выписывается пока один', () => {
    expect(WAYBILL_FORM_CODES).toContain('4p');
    expect(WAYBILL_FORM_CODES).toContain('leg3');
    expect(WAYBILL_FORM_CODES).toContain('esm2');
  });
});

/**
 * Граница правки листа (ADR 0037 п. 9): до даты выезда лист аннулируют и выписывают заново, в
 * день выезда и позже — нет. Бланк уже у водителя, и запись, разошедшаяся с бумагой на руках,
 * хуже отсутствия записи.
 */
describe('до какого дня лист можно аннулировать', () => {
  it('накануне — можно', () => {
    expect(isWaybillEditable('2026-08-10', '2026-08-09')).toBe(true);
  });

  it('в день выезда — уже нет: бланк у водителя', () => {
    expect(isWaybillEditable('2026-08-10', '2026-08-10')).toBe(false);
  });

  it('задним числом — тем более нет', () => {
    expect(isWaybillEditable('2026-08-10', '2026-08-11')).toBe(false);
  });

  it('аннулирование без причины не принимается: в журнале должно быть видно, почему', () => {
    expect(cancelWaybillSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(cancelWaybillSchema.safeParse({ reason: 'испорчен при печати' }).success).toBe(true);
  });
});
