import { describe, expect, it } from 'vitest';
import { serviceRequestErrorMessage } from '@entities/service-request';
import { wasteRequestErrorMessage } from '@entities/waste-request';
import { waybillErrorMessage } from '@entities/waybill';

const failure = (fields: Record<string, string>): unknown => ({
  code: 'validation_error',
  message: 'Ошибка валидации данных',
  fields,
  status: 400,
});

describe('operational domain error labels', () => {
  it('подписывает поля заявки на обслуживание', () => {
    expect(
      serviceRequestErrorMessage(
        failure({ 'consumables.0.requestedQuantity': 'Неверно', reason: 'Пусто' }),
      ),
    ).toBe('Ошибка валидации данных: Количество, Причина');
  });

  it('подписывает поля заявки на вывоз', () => {
    expect(
      wasteRequestErrorMessage(failure({ deliveryAt: 'Неверно', volumeM3: 'Неверно' })),
    ).toBe('Ошибка валидации данных: Дата доставки, Объём');
  });

  it('подписывает поля путевого листа', () => {
    expect(waybillErrorMessage(failure({ reason: 'Пусто' }))).toBe(
      'Ошибка валидации данных: Причина аннулирования',
    );
  });
});
