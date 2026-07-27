import { describe, expect, it } from 'vitest';
import {
  createVehicleKindSchema,
  createVehicleTypeSchema,
  updateVehicleTypeSchema,
  vehicleTypeCodeSchema,
  vehicleTypeListQuerySchema,
} from '@technic/contracts';

const KIND_ID = '11111111-1111-4111-8111-111111111111';

describe('vehicle_kinds contracts', () => {
  it('дефолты и парсинг', () => {
    const k = createVehicleKindSchema.parse({ code: 'special_equipment', name: 'Спецтехника' });
    expect(k.sortOrder).toBe(100);
    expect(k.isActive).toBe(true);
  });

  it('пустой code/name отклоняется', () => {
    expect(() => createVehicleKindSchema.parse({ code: '   ', name: 'X' })).toThrow();
    expect(() => createVehicleKindSchema.parse({ code: 'x', name: '' })).toThrow();
  });
});

describe('vehicle_types: создание (плоская модель, ADR 0005)', () => {
  it('тип создаётся с дефолтами', () => {
    const t = createVehicleTypeSchema.parse({
      kindId: KIND_ID,
      code: 'truck_cranes',
      name: 'Автокраны',
    });
    expect(t.kindId).toBe(KIND_ID);
    expect(t.description).toBe('');
    expect(t.sortOrder).toBe(100);
    expect(t.isActive).toBe(true);
  });

  it('kindId обязателен', () => {
    expect(() =>
      createVehicleTypeSchema.parse({ code: 'truck_cranes', name: 'Автокраны' }),
    ).toThrow();
  });

  it('структурные/чужие поля отклоняются (strict)', () => {
    for (const bad of [{ parentId: KIND_ID }, { level: 'flat' }, { isSelectable: true }]) {
      expect(() =>
        createVehicleTypeSchema.parse({ kindId: KIND_ID, code: 'x', name: 'X', ...bad }),
      ).toThrow();
    }
  });
});

describe('vehicle_types: код (^[a-z][a-z0-9_]*$)', () => {
  it('валидные коды', () => {
    for (const c of ['truck_cranes', 'dump_trucks', 'passenger_cars', 'a1']) {
      expect(vehicleTypeCodeSchema.parse(c)).toBe(c);
    }
  });
  it('невалидные коды', () => {
    for (const c of ['Cranes', '1crane', '_crane', 'truck-crane', 'кран', 'truck crane', '']) {
      expect(() => vehicleTypeCodeSchema.parse(c)).toThrow();
    }
  });
});

describe('vehicle_types: обновление (strict, без структурных полей)', () => {
  it('принимает name/description/sortOrder/isActive', () => {
    const ok = updateVehicleTypeSchema.parse({ name: 'Автокраны 2', isActive: false });
    expect(ok.name).toBe('Автокраны 2');
    expect(ok.isActive).toBe(false);
  });
  it('структурные ключи (code/kindId/parentId/level) отклоняются', () => {
    for (const bad of [
      { code: 'x' },
      { kindId: KIND_ID },
      { parentId: KIND_ID },
      { level: 'flat' },
    ]) {
      expect(() => updateVehicleTypeSchema.parse(bad)).toThrow();
    }
  });
});

describe('vehicle_types: list-query', () => {
  it('kindId/isActive парсятся', () => {
    const q = vehicleTypeListQuerySchema.parse({ kindId: KIND_ID, isActive: 'false' });
    expect(q.kindId).toBe(KIND_ID);
    expect(q.isActive).toBe(false);
  });
});
