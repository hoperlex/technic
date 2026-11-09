import { describe, expect, it } from 'vitest';
import { vehicleRequestErrorMessage } from '@entities/vehicle-request';
import { vehicleRouteErrorMessage } from '@entities/vehicle-route';
import { weeklyRequestErrorMessage } from '@entities/weekly-request';

const failure = (fields: Record<string, string>): unknown => ({
  code: 'validation_error',
  message: 'Ошибка валидации данных',
  fields,
  status: 400,
});

describe('vehicle domain error labels', () => {
  it('подписывает поля заказа техники и называет причину', () => {
    expect(
      vehicleRequestErrorMessage(failure({ vehicleTypeId: 'Пусто', dateFrom: 'Неверно' })),
    ).toBe('Ошибка валидации данных: Тип техники — Пусто; Дата начала — Неверно');
  });

  it('у поля ездки называет строку, а английский текст zod не показывает', () => {
    expect(
      vehicleRequestErrorMessage(
        failure({
          'trips.0.volumeM3': 'Значение должно быть больше 0',
          'trips.1.weightTons': 'Invalid input: expected number, received string',
        }),
      ),
    ).toBe(
      'Ошибка валидации данных: Объём (строка 1) — Значение должно быть больше 0; Масса (строка 2)',
    );
  });

  it('подписывает поля маршрута', () => {
    expect(vehicleRouteErrorMessage(failure({ driverId: 'Пусто', points: 'Пусто' }))).toBe(
      'Ошибка валидации данных: Водитель, Точки маршрута',
    );
  });

  it('подписывает поля недельной заявки', () => {
    expect(weeklyRequestErrorMessage(failure({ weekStart: 'Неверно', items: 'Пусто' }))).toBe(
      'Ошибка валидации данных: Начало недели, Состав заявки',
    );
  });
});
