import { describe, expect, it } from 'vitest';
import {
  createVehicleKindSchema,
  createVehicleTypeSchema,
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

describe('vehicle_types contracts', () => {
  it('дефолты (selectable, description) и верхний уровень без parentId', () => {
    const t = createVehicleTypeSchema.parse({ kindId: KIND_ID, code: 'excavators', name: 'Экскаваторы' });
    expect(t.kindId).toBe(KIND_ID);
    expect(t.isSelectable).toBe(true);
    expect(t.description).toBe('');
    expect(t.parentId ?? null).toBeNull();
  });

  it('принимает parentId (подтип)', () => {
    const t = createVehicleTypeSchema.parse({
      kindId: KIND_ID,
      parentId: PARENT_ID,
      code: 'excavator_crawler',
      name: 'Экскаваторы гусеничные',
      isSelectable: true,
    });
    expect(t.parentId).toBe(PARENT_ID);
  });

  it('требует валидный kindId', () => {
    expect(() => createVehicleTypeSchema.parse({ code: 'x', name: 'y' })).toThrow();
    expect(() =>
      createVehicleTypeSchema.parse({ kindId: 'not-uuid', code: 'x', name: 'y' }),
    ).toThrow();
  });

  it('list-query приводит isSelectable/isActive к boolean', () => {
    const q = vehicleTypeListQuerySchema.parse({ isSelectable: 'true', isActive: 'false' });
    expect(q.isSelectable).toBe(true);
    expect(q.isActive).toBe(false);
  });
});
