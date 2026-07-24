import { describe, expect, it } from 'vitest';
import {
  createVehicleKindSchema,
  createVehicleTypeSchema,
  updateParentTypeSchema,
  updateSubtypeSchema,
  vehicleTypeCodeSchema,
  vehicleTypeListQuerySchema,
} from '@technic/contracts';

const KIND_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

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

describe('vehicle_types: создание (discriminatedUnion по level)', () => {
  it('тип создаётся без родителя, с дефолтами', () => {
    const t = createVehicleTypeSchema.parse({
      level: 'type',
      kindId: KIND_ID,
      code: 'cranes',
      name: 'Краны',
    });
    expect(t.level).toBe('type');
    if (t.level !== 'type') throw new Error('unreachable');
    expect(t.kindId).toBe(KIND_ID);
    expect(t.description).toBe('');
    expect(t.sortOrder).toBe(100);
  });

  it('тип НЕ принимает parentId/isSelectable/isActive (strict)', () => {
    expect(() =>
      createVehicleTypeSchema.parse({
        level: 'type',
        kindId: KIND_ID,
        code: 'cranes',
        name: 'Краны',
        parentId: PARENT_ID,
      }),
    ).toThrow();
    expect(() =>
      createVehicleTypeSchema.parse({
        level: 'type',
        kindId: KIND_ID,
        code: 'cranes',
        name: 'Краны',
        isSelectable: true,
      }),
    ).toThrow();
    expect(() =>
      createVehicleTypeSchema.parse({
        level: 'type',
        kindId: KIND_ID,
        code: 'cranes',
        name: 'Краны',
        isActive: true,
      }),
    ).toThrow();
  });

  it('подтип требует parentId', () => {
    expect(() =>
      createVehicleTypeSchema.parse({ level: 'subtype', code: 'truck_crane', name: 'Автокран' }),
    ).toThrow();
  });

  it('подтип НЕ принимает kindId/isSelectable (strict), но принимает isActive', () => {
    expect(() =>
      createVehicleTypeSchema.parse({
        level: 'subtype',
        parentId: PARENT_ID,
        kindId: KIND_ID,
        code: 'truck_crane',
        name: 'Автокран',
      }),
    ).toThrow();
    expect(() =>
      createVehicleTypeSchema.parse({
        level: 'subtype',
        parentId: PARENT_ID,
        code: 'truck_crane',
        name: 'Автокран',
        isSelectable: true,
      }),
    ).toThrow();
    const ok = createVehicleTypeSchema.parse({
      level: 'subtype',
      parentId: PARENT_ID,
      code: 'truck_crane',
      name: 'Автокран',
      isActive: false,
    });
    if (ok.level !== 'subtype') throw new Error('unreachable');
    expect(ok.isActive).toBe(false);
  });

  it('требует level (без него union не проходит)', () => {
    expect(() =>
      createVehicleTypeSchema.parse({ kindId: KIND_ID, code: 'cranes', name: 'Краны' }),
    ).toThrow();
  });
});

describe('vehicle_types: код (^[a-z][a-z0-9_]*$)', () => {
  it('валидные коды', () => {
    for (const c of ['cranes', 'truck_crane', 'light_kmu_truck', 'a1']) {
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
  it('updateParentTypeSchema принимает только name/description/sortOrder', () => {
    const ok = updateParentTypeSchema.parse({ name: 'Краны 2', sortOrder: 15 });
    expect(ok.name).toBe('Краны 2');
    for (const bad of [{ code: 'x' }, { kindId: KIND_ID }, { parentId: PARENT_ID }, { isActive: true }, { isSelectable: false }, { level: 'type' }]) {
      expect(() => updateParentTypeSchema.parse(bad)).toThrow();
    }
  });

  it('updateSubtypeSchema принимает name/description/sortOrder/isActive, но не структурные', () => {
    const ok = updateSubtypeSchema.parse({ name: 'Автокран 2', isActive: false });
    expect(ok.isActive).toBe(false);
    for (const bad of [{ code: 'x' }, { kindId: KIND_ID }, { parentId: PARENT_ID }, { isSelectable: true }, { level: 'subtype' }]) {
      expect(() => updateSubtypeSchema.parse(bad)).toThrow();
    }
  });
});

describe('vehicle_types: list-query', () => {
  it('view по умолчанию list; level/isActive парсятся', () => {
    const q = vehicleTypeListQuerySchema.parse({ level: 'subtype', isActive: 'false' });
    expect(q.view).toBe('list');
    expect(q.level).toBe('subtype');
    expect(q.isActive).toBe(false);
  });
  it('view=hierarchy принимается', () => {
    const q = vehicleTypeListQuerySchema.parse({ view: 'hierarchy', pageSize: 500 });
    expect(q.view).toBe('hierarchy');
    expect(q.pageSize).toBe(500);
  });
});
