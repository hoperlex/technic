import { describe, expect, it } from 'vitest';
import {
  can,
  GARAGE_DRIVER_STATES,
  GARAGE_VEHICLE_STATES,
  garageDriverQuerySchema,
  garageDriverStateColors,
  garageDriverStateLabels,
  garageVehicleQuerySchema,
  garageVehicleStateColors,
  garageVehicleStateLabels,
  profilesWith,
} from '@technic/contracts';

/**
 * Контракты гаража (ADR 0076): запросы среза и словарь состояний.
 *
 * Сами состояния считает сервер одним SQL-выражением — здесь проверяется то, что живёт в
 * контрактах: день приходит параметром (а не «сегодня» сервера), фильтры сужают список
 * перечисленными значениями, а каждому состоянию есть подпись и цвет. Пропущенная подпись не
 * ломает сборку — `Record` требует все ключи, — но пропущенный **вариант** в схеме превращает
 * фильтр в 400 на ровном месте.
 */

describe('запрос среза дня', () => {
  it('день необязателен: пустой означает сегодня, и считает его сервер', () => {
    const parsed = garageVehicleQuerySchema.parse({});
    expect(parsed.on).toBeUndefined();
    expect(parsed.page).toBe(1);
  });

  it('день принимается только календарным ключом', () => {
    expect(garageVehicleQuerySchema.parse({ on: '2026-08-06' }).on).toBe('2026-08-06');
    expect(garageVehicleQuerySchema.safeParse({ on: '06.08.2026' }).success).toBe(false);
    // Дата, которой не бывает: регулярное выражение её пропускает, а `dateOnlySchema` — нет.
    expect(garageVehicleQuerySchema.safeParse({ on: '2026-02-31' }).success).toBe(false);
  });

  it('фильтр состояния принимает только перечисленные значения', () => {
    for (const state of GARAGE_VEHICLE_STATES) {
      expect(garageVehicleQuerySchema.parse({ state }).state).toBe(state);
    }
    expect(garageVehicleQuerySchema.safeParse({ state: 'busy' }).success).toBe(false);

    for (const state of GARAGE_DRIVER_STATES) {
      expect(garageDriverQuerySchema.parse({ state }).state).toBe(state);
    }
    expect(garageDriverQuerySchema.safeParse({ state: 'on_route' }).success).toBe(false);
  });

  it('сортировка сужена полями, которые сервер умеет считать', () => {
    expect(garageVehicleQuerySchema.parse({ sortBy: 'state' }).sortBy).toBe('state');
    expect(garageVehicleQuerySchema.safeParse({ sortBy: 'busy' }).success).toBe(false);
    expect(garageDriverQuerySchema.parse({ sortBy: 'fullName' }).sortBy).toBe('fullName');
    // Удостоверением не сортируют: колонка собирается в памяти из документов человека.
    expect(garageDriverQuerySchema.safeParse({ sortBy: 'license' }).success).toBe(false);
  });

  it('комплект документов спрашивается теми же двумя словами, что в справочнике', () => {
    expect(garageDriverQuerySchema.parse({ documents: 'complete' }).documents).toBe('complete');
    expect(garageDriverQuerySchema.parse({ documents: 'incomplete' }).documents).toBe('incomplete');
    expect(garageDriverQuerySchema.safeParse({ documents: 'any' }).success).toBe(false);
  });
});

describe('словарь состояний', () => {
  it('у каждого состояния есть подпись и цвет', () => {
    for (const state of GARAGE_VEHICLE_STATES) {
      expect(garageVehicleStateLabels[state], state).toBeTruthy();
      expect(garageVehicleStateColors[state], state).toBeTruthy();
    }
    for (const state of GARAGE_DRIVER_STATES) {
      expect(garageDriverStateLabels[state], state).toBeTruthy();
      expect(garageDriverStateColors[state], state).toBeTruthy();
    }
  });

  it('состояния перечислены по старшинству — тем же порядком, что считает сервер', () => {
    // Порядок здесь не украшение: по нему читается правило «недоступность перекрывает работу, а
    // объект — рейс», и разойдись он с `vehicleStateSql`, список состояний перестал бы объяснять
    // колонку.
    expect([...GARAGE_VEHICLE_STATES]).toEqual(['unavailable', 'on_site', 'on_route', 'free']);
    expect([...GARAGE_DRIVER_STATES]).toEqual(['assigned', 'free']);
  });
});

describe('право на раздел', () => {
  it('гараж открыт тем же, кто ведёт водителей и листы', () => {
    expect(profilesWith('garage.read').map((s) => s.role)).toEqual([
      'admin',
      'manager',
      'dispatcher',
    ]);
  });

  it('наблюдателю раздел закрыт, хотя заявки он читает', () => {
    // В срезе видно, кто за рулём: это персональные данные, а у наблюдателя нет ни `drivers.read`,
    // ни `waybills.read` (ADR 0033) — и гараж не должен обойти оба запрета.
    expect(can({ role: 'observer' }, 'vehicleRequests.read')).toBe(true);
    expect(can({ role: 'observer' }, 'garage.read')).toBe(false);
  });

  it('арендодателю ТС раздел закрыт: парк и водители в нём наши', () => {
    expect(can({ role: 'operator', counterpartyType: 'vehicle_lessor' }, 'garage.read')).toBe(
      false,
    );
  });
});
