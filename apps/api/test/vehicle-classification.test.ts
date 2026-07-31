import { describe, expect, it } from 'vitest';
import {
  classificationPriceHint,
  createVehicleKindSchema,
  createVehicleTypeSchema,
  parseVehicleClassificationKey,
  updateVehicleTypeSchema,
  vehicleClassificationKey,
  vehicleClassificationLabel,
  vehicleClassificationListQuerySchema,
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

// ── Классификатор «тип/категория» (ADR 0028) ──
// Ключ позиции — единственное, что уходит из списка выбора: им форма отвечает и «какой тип»,
// и «какая категория», не заводя второго поля.

describe('vehicle_classifications: ключ позиции', () => {
  const TYPE_ID = '22222222-2222-4222-8222-222222222222';
  const CATEGORY_ID = '33333333-3333-4333-8333-333333333333';

  it('ключ категории разбирается обратно в пару', () => {
    const key = vehicleClassificationKey(TYPE_ID, CATEGORY_ID);
    expect(key).toBe(`${TYPE_ID}:${CATEGORY_ID}`);
    expect(parseVehicleClassificationKey(key)).toEqual({
      vehicleTypeId: TYPE_ID,
      vehicleCategoryId: CATEGORY_ID,
    });
  });

  it('тип без категорий — пустая половина ключа, а не отсутствие ключа', () => {
    for (const empty of [null, undefined]) {
      const key = vehicleClassificationKey(TYPE_ID, empty);
      expect(key).toBe(`${TYPE_ID}:`);
      expect(parseVehicleClassificationKey(key)).toEqual({
        vehicleTypeId: TYPE_ID,
        vehicleCategoryId: null,
      });
    }
  });

  it('пустой и битый ключ разбираются в null, а не в позицию с пустым типом', () => {
    for (const bad of ['', null, undefined, ':', `:${CATEGORY_ID}`]) {
      expect(parseVehicleClassificationKey(bad)).toBeNull();
    }
  });
});

describe('vehicle_classifications: подпись позиции', () => {
  it('категория вытесняет тип — её наименование уже начинается с него', () => {
    expect(
      vehicleClassificationLabel({ typeName: 'Автокраны', categoryName: 'Автокраны, г/п 130 т' }),
    ).toBe('Автокраны, г/п 130 т');
  });

  it('без категории показывается чистый тип', () => {
    expect(vehicleClassificationLabel({ typeName: 'Ямобур', categoryName: null })).toBe('Ямобур');
    expect(vehicleClassificationLabel({ typeName: 'Ямобур' })).toBe('Ямобур');
  });
});

describe('vehicle_classifications: порядок цены позиции', () => {
  // Пробел разрядов в «2 400 ₽» — неразрывный (ru-RU), поэтому сверяем по цифрам и знаку.
  it('час важнее смены: им заказывают чаще, и позиции сравниваются в одних единицах', () => {
    expect(classificationPriceHint({ avgPricePerHour: 2400, avgPricePerShift: 18000 })).toMatch(
      /^~ 2.400 ₽\/час$/,
    );
  });

  it('без почасовой показывается смена', () => {
    expect(classificationPriceHint({ avgPricePerHour: null, avgPricePerShift: 18000 })).toMatch(
      /^~ 18.000 ₽\/смена$/,
    );
  });

  it('ставок нет — приписки нет: пусто и ноль это разные ответы', () => {
    expect(classificationPriceHint({ avgPricePerHour: null, avgPricePerShift: null })).toBeNull();
  });

  it('копейки в порядок цены не идут — средняя округляется до рубля', () => {
    expect(classificationPriceHint({ avgPricePerHour: 2416.667, avgPricePerShift: null })).toMatch(
      /^~ 2.417 ₽\/час$/,
    );
  });
});

describe('vehicle_classifications: list-query', () => {
  it('вид, тип и активность парсятся', () => {
    const q = vehicleClassificationListQuerySchema.parse({
      kindId: KIND_ID,
      vehicleTypeId: '22222222-2222-4222-8222-222222222222',
      isActive: 'true',
    });
    expect(q.kindId).toBe(KIND_ID);
    expect(q.isActive).toBe(true);
  });

  it('сортировка вне allowlist отклоняется', () => {
    expect(() => vehicleClassificationListQuerySchema.parse({ sortBy: 'specSignature' })).toThrow();
  });
});
