import { describe, expect, it } from 'vitest';
import { createVehicleSchema, updateVehicleSchema, vehicleListQuerySchema } from '@technic/contracts';

const TYPE = '33333333-3333-4333-8333-333333333333';
const MODEL = '44444444-4444-4444-8444-444444444444';

describe('vehicles: создание', () => {
  it('минимально валидно: только тип + дефолты', () => {
    const v = createVehicleSchema.parse({ vehicleTypeId: TYPE });
    expect(v.status).toBe('active');
    expect(v.note).toBe('');
  });

  it('vehicleTypeId обязателен и uuid', () => {
    expect(() => createVehicleSchema.parse({})).toThrow();
    expect(() => createVehicleSchema.parse({ vehicleTypeId: 'not-uuid' })).toThrow();
  });

  it('strict: лишние поля отклоняются', () => {
    expect(() => createVehicleSchema.parse({ vehicleTypeId: TYPE, foo: 1 })).toThrow();
  });

  it('status — только из перечня', () => {
    expect(() => createVehicleSchema.parse({ vehicleTypeId: TYPE, status: 'bogus' })).toThrow();
    expect(createVehicleSchema.parse({ vehicleTypeId: TYPE, status: 'retired' }).status).toBe(
      'retired',
    );
  });

  it('госномер: обрезка пробелов и лимит длины', () => {
    expect(
      createVehicleSchema.parse({ vehicleTypeId: TYPE, registrationNumber: '  В094ЕТ77 ' })
        .registrationNumber,
    ).toBe('В094ЕТ77');
    expect(() =>
      createVehicleSchema.parse({ vehicleTypeId: TYPE, registrationNumber: 'x'.repeat(51) }),
    ).toThrow();
  });

  // Инв. №, зав. № / VIN, изготовитель и дата выпуска убраны из справочника: схема их не принимает.
  it('снятые поля отклоняются как лишние', () => {
    for (const field of ['inventoryNumber', 'serialNumber', 'manufacturerName', 'manufacturedOn']) {
      expect(() => createVehicleSchema.parse({ vehicleTypeId: TYPE, [field]: 'x' })).toThrow();
      expect(() => updateVehicleSchema.parse({ [field]: 'x' })).toThrow();
    }
  });

  it('модель — uuid или null', () => {
    expect(
      createVehicleSchema.parse({ vehicleTypeId: TYPE, vehicleModelId: MODEL }).vehicleModelId,
    ).toBe(MODEL);
    expect(
      createVehicleSchema.parse({ vehicleTypeId: TYPE, vehicleModelId: null }).vehicleModelId,
    ).toBeNull();
    expect(() =>
      createVehicleSchema.parse({ vehicleTypeId: TYPE, vehicleModelId: 'x' }),
    ).toThrow();
  });
});

describe('vehicles: обновление', () => {
  it('частичное обновление: пустой объект ок', () => {
    expect(() => updateVehicleSchema.parse({})).not.toThrow();
  });

  it('strict: лишние поля отклоняются', () => {
    expect(() => updateVehicleSchema.parse({ foo: 1 })).toThrow();
  });

  it('можно поменять только статус (без дефолтов на остальные поля)', () => {
    const v = updateVehicleSchema.parse({ status: 'maintenance' });
    expect(v.status).toBe('maintenance');
    expect(v.vehicleTypeId).toBeUndefined();
    expect(v.note).toBeUndefined();
  });
});

describe('vehicles: список', () => {
  it('includeDeleted: строка → boolean, по умолчанию false', () => {
    expect(vehicleListQuerySchema.parse({}).includeDeleted).toBe(false);
    expect(vehicleListQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted).toBe(true);
    expect(vehicleListQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted).toBe(false);
  });

  it('сортировка — только из allowlist', () => {
    expect(() => vehicleListQuerySchema.parse({ sortBy: 'note' })).toThrow();
    expect(vehicleListQuerySchema.parse({ sortBy: 'status' }).sortBy).toBe('status');
  });

  it('status фильтр — из перечня', () => {
    expect(() => vehicleListQuerySchema.parse({ status: 'bogus' })).toThrow();
    expect(vehicleListQuerySchema.parse({ status: 'active' }).status).toBe('active');
  });
});
