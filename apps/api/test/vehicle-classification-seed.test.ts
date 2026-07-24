import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_SOURCE_NAME,
  VEHICLE_INSTANCE_OVERRIDES,
  VEHICLE_PARENT_TYPES,
  VEHICLE_SOURCE_MAPPINGS,
  VEHICLE_SUBTYPES,
} from '../src/db/vehicle-classification-data';
import { createVehicleTypeSourceMappingSchema } from '@technic/contracts';

const parentByCode = new Map(VEHICLE_PARENT_TYPES.map((p) => [p.code, p]));
const subtypeByCode = new Map(VEHICLE_SUBTYPES.map((s) => [s.code, s]));

describe('дерево классификатора ТС', () => {
  it('22 подтипа: 16 активных, 6 неактивных', () => {
    expect(VEHICLE_SUBTYPES).toHaveLength(22);
    expect(VEHICLE_SUBTYPES.filter((s) => s.isActive)).toHaveLength(16);
    expect(VEHICLE_SUBTYPES.filter((s) => !s.isActive)).toHaveLength(6);
  });

  it('суммы активных экземпляров: 93 всего, 65 спец, 28 груз', () => {
    const sum = (k?: string) =>
      VEHICLE_SUBTYPES.filter((s) => !k || s.kindCode === k).reduce((a, s) => a + s.activeCount, 0);
    expect(sum()).toBe(93);
    expect(sum('special_equipment')).toBe(65);
    expect(sum('freight_transport')).toBe(28);
  });

  it('активных подтипов: спец 10, груз 6', () => {
    expect(
      VEHICLE_SUBTYPES.filter((s) => s.isActive && s.kindCode === 'special_equipment'),
    ).toHaveLength(10);
    expect(
      VEHICLE_SUBTYPES.filter((s) => s.isActive && s.kindCode === 'freight_transport'),
    ).toHaveLength(6);
  });

  it('activeCount>0 ⇔ подтип активен', () => {
    for (const s of VEHICLE_SUBTYPES) expect(s.isActive).toBe(s.activeCount > 0);
  });

  it('родитель активен ⇔ есть активный потомок', () => {
    for (const p of VEHICLE_PARENT_TYPES) {
      const anyActiveChild = VEHICLE_SUBTYPES.some((s) => s.parentCode === p.code && s.isActive);
      expect(p.isActive).toBe(anyActiveChild);
    }
  });

  it('каждый подтип относится к виду своего родителя', () => {
    for (const s of VEHICLE_SUBTYPES) {
      const p = parentByCode.get(s.parentCode);
      expect(p).toBeDefined();
      expect(s.kindCode).toBe(p!.kindCode);
    }
  });

  it('коды уникальны (родители+подтипы)', () => {
    const codes = [...VEHICLE_PARENT_TYPES, ...VEHICLE_SUBTYPES].map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('исключение самосвалов', () => {
  it('нет кода dump_truck и названия «Самосвал»', () => {
    const all = [...VEHICLE_PARENT_TYPES, ...VEHICLE_SUBTYPES];
    expect(all.some((t) => t.code === 'dump_truck')).toBe(false);
    expect(all.some((t) => /самосвал/i.test(t.name))).toBe(false);
  });

  it('нет mapping для «Самосвалы»', () => {
    expect(VEHICLE_SOURCE_MAPPINGS.some((m) => m.sourceName === EXCLUDED_SOURCE_NAME)).toBe(false);
    expect(EXCLUDED_SOURCE_NAME).toBe('Самосвалы');
  });
});

describe('source mappings', () => {
  it('direct → выбираемый конечный подтип', () => {
    for (const m of VEHICLE_SOURCE_MAPPINGS.filter((x) => x.strategy === 'direct')) {
      expect(subtypeByCode.has(m.targetCode)).toBe(true);
      expect(m.requiresInstanceResolution).toBe(false);
    }
  });

  it('неоднозначные → невыбираемый родитель + requiresInstanceResolution', () => {
    for (const m of VEHICLE_SOURCE_MAPPINGS.filter((x) => x.strategy !== 'direct')) {
      expect(parentByCode.has(m.targetCode)).toBe(true);
      expect(m.requiresInstanceResolution).toBe(true);
    }
  });

  it('цель каждого mapping существует в дереве', () => {
    for (const m of VEHICLE_SOURCE_MAPPINGS) {
      expect(parentByCode.get(m.targetCode) ?? subtypeByCode.get(m.targetCode)).toBeDefined();
    }
  });

  it('Zod-схема: валидное правило и отказ на неизвестной стратегии', () => {
    const parsed = createVehicleTypeSourceMappingSchema.parse({
      sourceCode: 'worked_list_06_26_06_27',
      sourceName: 'Автокраны',
      normalizedSourceName: 'автокраны',
      vehicleTypeId: '11111111-1111-4111-8111-111111111111',
      resolutionStrategy: 'direct',
    });
    expect(parsed.requiresInstanceResolution).toBe(false);
    expect(() =>
      createVehicleTypeSourceMappingSchema.parse({
        sourceCode: 'x',
        sourceName: 'y',
        normalizedSourceName: 'y',
        vehicleTypeId: '11111111-1111-4111-8111-111111111111',
        resolutionStrategy: 'bogus',
      }),
    ).toThrow();
  });
});

describe('ручные исправления', () => {
  it('JCB TLT30C → forklift, МАЗ У702/У782 → multilift, ГАЗ-33106/JAC → light_kmu_truck', () => {
    const byTarget = (code: string) =>
      VEHICLE_INSTANCE_OVERRIDES.filter((o) => o.targetCode === code);
    expect(byTarget('forklift').some((o) => o.match.modelIncludes === 'JCB TLT30C')).toBe(true);
    expect(byTarget('multilift').map((o) => o.match.plate).sort()).toEqual([
      'У702АС777',
      'У782АС777',
    ]);
    expect(byTarget('light_kmu_truck').length).toBeGreaterThanOrEqual(2);
  });
});
