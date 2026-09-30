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
  it('подписывает поля заказа техники', () => {
    expect(
      vehicleRequestErrorMessage(failure({ vehicleTypeId: 'Пусто', dateFrom: 'Неверно' })),
    ).toBe('Ошибка валидации данных: Тип техники, Дата начала');
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
