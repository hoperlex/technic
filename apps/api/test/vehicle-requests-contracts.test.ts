import { describe, expect, it } from 'vitest';
import {
  changeVehicleRequestStatusSchema,
  createVehicleRequestSchema,
  formatVehicleRequestNumber,
  parseVehicleRequestNumberSearch,
  updateVehicleRequestSchema,
  vehicleRequestListQuerySchema,
} from '@technic/contracts';

const OBJ = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const TYPE = '33333333-3333-4333-8333-333333333333';

const special = {
  requestType: 'special_equipment' as const,
  objectId: OBJ,
  vehicleSubtypeId: SUB,
  dateFrom: '2026-07-25',
};
const freight = {
  requestType: 'freight_transport' as const,
  objectId: OBJ,
  vehicleSubtypeId: SUB,
  scheduledAt: '2026-07-25T14:30:00+03:00',
  volumeM3: 12.5,
  loadingLocation: 'Склад А',
  unloadingLocation: 'Объект Б',
};

describe('vehicle-requests: создание — discriminator', () => {
  it('без requestType union не проходит', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ objectId: OBJ, vehicleSubtypeId: SUB }),
    ).toThrow();
  });

  it('спецтехника: базовый парсинг + дефолты', () => {
    const v = createVehicleRequestSchema.parse(special);
    if (v.requestType !== 'special_equipment') throw new Error('unreachable');
    expect(v.comment).toBe('');
    expect(v.fileIds).toEqual([]);
    expect(v.dateTo ?? null).toBeNull();
  });

  it('грузоперевозка: базовый парсинг', () => {
    const v = createVehicleRequestSchema.parse(freight);
    if (v.requestType !== 'freight_transport') throw new Error('unreachable');
    expect(v.volumeM3).toBe(12.5);
    expect(v.loadingLocation).toBe('Склад А');
  });
});

describe('vehicle-requests: тип ТС — переходный период (ADR 0005, Фаза 1)', () => {
  it('vehicleTypeId (плоский) — валидно, как синоним подтипа', () => {
    const { vehicleSubtypeId: _s, ...noSub } = special;
    const v = createVehicleRequestSchema.parse({ ...noSub, vehicleTypeId: TYPE });
    if (v.requestType !== 'special_equipment') throw new Error('unreachable');
    expect(v.vehicleTypeId).toBe(TYPE);
  });

  it('оба поля сразу — отклоняется', () => {
    expect(() => createVehicleRequestSchema.parse({ ...special, vehicleTypeId: TYPE })).toThrow();
  });

  it('ни одного поля типа — отклоняется', () => {
    const { vehicleSubtypeId: _s, ...noRef } = special;
    expect(() => createVehicleRequestSchema.parse(noRef)).toThrow();
  });

  it('обновление: оба поля типа сразу — отклоняется', () => {
    expect(() =>
      updateVehicleRequestSchema.parse({
        requestType: 'special_equipment',
        version: 1,
        vehicleTypeId: TYPE,
        vehicleSubtypeId: SUB,
      }),
    ).toThrow();
  });
});

describe('vehicle-requests: строгость схем (.strict)', () => {
  it('спецтехника отклоняет freight-поля', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...special, scheduledAt: '2026-07-25T14:30:00+03:00' }),
    ).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...special, volumeM3: 5 })).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...special, loadingLocation: 'x' })).toThrow();
  });

  it('грузоперевозка отклоняет special-поля', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...freight, dateFrom: '2026-07-25' }),
    ).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...freight, dateTo: '2026-07-26' })).toThrow();
  });
});

describe('vehicle-requests: кросс-поля и валидация значений', () => {
  it('dateTo не раньше dateFrom', () => {
    expect(() =>
      createVehicleRequestSchema.parse({
        ...special,
        dateFrom: '2026-07-25',
        dateTo: '2026-07-24',
      }),
    ).toThrow();
    const ok = createVehicleRequestSchema.parse({
      ...special,
      dateFrom: '2026-07-25',
      dateTo: '2026-07-25',
    });
    expect(ok.requestType).toBe('special_equipment');
  });

  it('спецтехника: некорректная дата отклоняется', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...special, dateFrom: '2026-13-40' }),
    ).toThrow();
    expect(() =>
      createVehicleRequestSchema.parse({ ...special, dateFrom: '25-07-2026' }),
    ).toThrow();
  });

  it('грузоперевозка требует объём или массу', () => {
    const { volumeM3: _v, ...noAmount } = freight;
    expect(() => createVehicleRequestSchema.parse(noAmount)).toThrow();
    const byWeight = createVehicleRequestSchema.parse({ ...noAmount, weightTons: 3.2 });
    expect(byWeight.requestType).toBe('freight_transport');
  });

  it('объём/масса: >0 и не более 3 знаков', () => {
    expect(() => createVehicleRequestSchema.parse({ ...freight, volumeM3: 0 })).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...freight, volumeM3: -1 })).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...freight, volumeM3: 1.2345 })).toThrow();
    expect(createVehicleRequestSchema.parse({ ...freight, volumeM3: 1.234 }).requestType).toBe(
      'freight_transport',
    );
  });

  it('scheduledAt требует offset', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...freight, scheduledAt: '2026-07-25T14:30:00' }),
    ).toThrow();
  });
});

describe('vehicle-requests: обновление', () => {
  it('требует version и requestType', () => {
    expect(() =>
      updateVehicleRequestSchema.parse({
        requestType: 'special_equipment',
        dateFrom: '2026-07-25',
      }),
    ).toThrow();
    const ok = updateVehicleRequestSchema.parse({
      requestType: 'special_equipment',
      version: 0,
      comment: 'правка',
    });
    expect(ok.requestType).toBe('special_equipment');
  });

  it('запрещённые поля не игнорируются (strict)', () => {
    expect(() =>
      updateVehicleRequestSchema.parse({
        requestType: 'special_equipment',
        version: 1,
        scheduledAt: '2026-07-25T14:30:00+03:00',
      }),
    ).toThrow();
  });

  it('status change требует version', () => {
    expect(() => changeVehicleRequestStatusSchema.parse({ status: 'confirmed' })).toThrow();
    expect(changeVehicleRequestStatusSchema.parse({ status: 'confirmed', version: 2 }).status).toBe(
      'confirmed',
    );
  });
});

describe('vehicle-requests: список и номер', () => {
  it('requestType обязателен в list-query', () => {
    expect(() => vehicleRequestListQuerySchema.parse({})).toThrow();
    const q = vehicleRequestListQuerySchema.parse({ requestType: 'special_equipment' });
    expect(q.requestType).toBe('special_equipment');
    expect(q.includeDeleted).toBe(false);
  });

  it('формат и разбор номера', () => {
    expect(formatVehicleRequestNumber(123)).toBe('ТС-000123');
    expect(parseVehicleRequestNumberSearch('123')).toBe(123);
    expect(parseVehicleRequestNumberSearch('ТС-123')).toBe(123);
    expect(parseVehicleRequestNumberSearch('ТС-000123')).toBe(123);
    expect(parseVehicleRequestNumberSearch('  ')).toBeUndefined();
  });
});
