import { describe, expect, it } from 'vitest';
import {
  cancelWaybillSchema,
  formatWaybillNumber,
  isWaybillEditable,
  WAYBILL_FORM_CODES,
  WAYBILL_STATUSES,
  waybillDisplayNumber,
  waybillFormLabels,
  waybillRequirement,
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
 * На какой рейс выписывается лист (ADR 0037 п. 1, ADR 0041).
 *
 * Ограничение идёт и по типу заявки, и по виду ТС — и это не тавтология: заявку на технику для
 * работы на объекте можно завести и на самосвал, у которого бланк за типом закреплён. Рейса,
 * маршрута и груза у такой заявки нет, а значит, нет и путевого листа.
 *
 * Разница между «не выписывается, потому что…» и «не выписывается вовсе» — не косметика: первое
 * форма показывает текстом (отсутствие блока читалось бы как поломка), второе не показывает
 * ничем, потому что упоминать нечего.
 */
describe('на какой рейс выписывается путевой лист', () => {
  const dumpTruck = { ownership: 'own', formCode: '4p', typeName: 'Самосвалы' } as const;

  it('грузоперевозка собственной машиной с бланком — выписывается', () => {
    expect(waybillRequirement({ requestType: 'freight_transport', ...dumpTruck })).toEqual({
      formCode: '4p',
      reason: null,
    });
  });

  it('заказ техники на объект — не выписывается и не объясняется: у заявки нет рейса', () => {
    expect(waybillRequirement({ requestType: 'special_equipment', ...dumpTruck })).toEqual({
      formCode: null,
      reason: null,
    });
  });

  it('заказ техники на объект не спасает даже машина с бланком: решает вид заявки', () => {
    const onSite = waybillRequirement({
      requestType: 'special_equipment',
      ownership: 'rental',
      formCode: '4p',
      typeName: 'Самосвалы',
    });
    // Ни «арендодатель выпишет», ни «бланка нет»: об аренде говорить нечего там, где документа
    // не существует в принципе.
    expect(onSite).toEqual({ formCode: null, reason: null });
  });

  it('аренда под грузоперевозку — причина текстом: лист выписывает арендодатель', () => {
    const rental = waybillRequirement({
      requestType: 'freight_transport',
      ownership: 'rental',
      formCode: '4p',
      typeName: 'Самосвалы',
    });
    expect(rental.formCode).toBeNull();
    expect(rental.reason).toContain('арендодатель');
  });

  it('тип без бланка — причина называет тип: это поправимое состояние справочника', () => {
    const noForm = waybillRequirement({
      requestType: 'freight_transport',
      ownership: 'own',
      formCode: null,
      typeName: 'Автокраны',
    });
    expect(noForm.formCode).toBeNull();
    expect(noForm.reason).toContain('Автокраны');
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
