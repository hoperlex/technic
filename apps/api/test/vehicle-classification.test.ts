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
  compareVehicleSize,
  vehicleSubstitutionGroup,
  vehicleSubstitutionHint,
  vehicleSubstitutionOf,
  vehicleSubstitutionRank,
  vehicleSubstitutionWarning,
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

// ── Замена заказанной техники: предупреждение, а не запрет (ADR 0045, ADR 0059) ──
/** Виды ТС: спецтехника и грузовой транспорт — самое крупное расхождение, какое бывает. */
const SPECIAL = '77777777-7777-4777-8777-777777777777';
const FREIGHT = '88888888-8888-4888-8888-888888888888';
const CRANES = '55555555-5555-4555-8555-555555555555';
const TRUCKS = '66666666-6666-4666-8666-666666666666';
const CAT_130 = '33333333-3333-4333-8333-333333333333';
const CAT_25 = '44444444-4444-4444-8444-444444444444';

describe('сравнение техники по ТТХ', () => {
  it('все общие характеристики больше — крупнее', () => {
    expect(compareVehicleSize({ lift_capacity: 25 }, { lift_capacity: 130 })).toBe('bigger');
  });

  it('хоть одна меньше — меньше заказанного', () => {
    expect(compareVehicleSize({ lift_capacity: 130 }, { lift_capacity: 25 })).toBe('smaller');
  });

  it('одна больше, другая меньше — характеристики расходятся', () => {
    // Манипулятор: г/п машины выше заказанной, а г/п стрелы ниже — одним словом не описать.
    const ordered = { lift_capacity: 10, boom_capacity: 7 };
    expect(compareVehicleSize(ordered, { lift_capacity: 15, boom_capacity: 3 })).toBe('mixed');
  });

  it('равные значения — та же величина', () => {
    expect(compareVehicleSize({ lift_capacity: 5 }, { lift_capacity: 5 })).toBe('same');
  });

  it('сравниваются только общие ТТХ: лишние у машины не мешают', () => {
    const actual = { lift_capacity: 12, boom_capacity: 3 };
    expect(compareVehicleSize({ lift_capacity: 5 }, actual)).toBe('bigger');
  });

  it('общих ТТХ нет — сравнивать не с чем, а не «подходит»', () => {
    // Самосвал меряется объёмом кузова, бортовой — грузоподъёмностью (0045_vehicle_specs_seed).
    expect(compareVehicleSize({ body_volume: 12 }, { lift_capacity: 10 })).toBe('unknown');
  });

  it('категория не проставлена — тоже «сравнить не с чем» (ADR 0045 §6)', () => {
    expect(compareVehicleSize({ lift_capacity: 10 }, null)).toBe('unknown');
    expect(compareVehicleSize(null, { lift_capacity: 10 })).toBe('unknown');
  });
});

describe('расхождение назначенной техники с заказанной', () => {
  const ordered = {
    vehicleKindId: SPECIAL,
    vehicleTypeId: CRANES,
    vehicleCategoryId: CAT_130,
    categorySpecs: { lift_capacity: 130 },
  };

  it('та же позиция — расхождения нет и говорить не о чем', () => {
    const s = vehicleSubstitutionOf(ordered, ordered);
    expect(s.typeMismatch).toBe(false);
    expect(s.categoryMismatch).toBe(false);
    expect(vehicleSubstitutionHint(s)).toBeNull();
    expect(
      vehicleSubstitutionWarning({
        substitution: s,
        orderedLabel: 'Автокраны, г/п 130 т',
        actualTypeName: 'Автокраны',
        actualCategoryName: 'Автокраны, г/п 130 т',
      }),
    ).toBeNull();
  });

  it('свой тип, категория меньше — предупреждение о риске', () => {
    const s = vehicleSubstitutionOf(ordered, {
      vehicleKindId: SPECIAL,
      vehicleTypeId: CRANES,
      vehicleCategoryId: CAT_25,
      categorySpecs: { lift_capacity: 25 },
    });
    expect(vehicleSubstitutionHint(s)).toBe('меньше заказанного');
    expect(vehicleSubstitutionGroup(s)).toBe('ordered');
    const w = vehicleSubstitutionWarning({
      substitution: s,
      orderedLabel: 'Автокраны, г/п 130 т',
      actualTypeName: 'Автокраны',
      actualCategoryName: 'Автокраны, г/п 25 т',
    })!;
    expect(w.level).toBe('warning');
    // Названы обе стороны: решение остаётся за человеком, и ему нужны оба наименования.
    expect(w.text).toContain('Автокраны, г/п 130 т');
    expect(w.text).toContain('Автокраны, г/п 25 т');
  });

  it('другой тип крупнее — пометка, а не предупреждение', () => {
    const s = vehicleSubstitutionOf(
      {
        vehicleKindId: FREIGHT,
        vehicleTypeId: TRUCKS,
        vehicleCategoryId: CAT_25,
        categorySpecs: { lift_capacity: 3.5 },
      },
      {
        vehicleKindId: FREIGHT,
        vehicleTypeId: CRANES,
        vehicleCategoryId: CAT_130,
        categorySpecs: { lift_capacity: 10 },
      },
    );
    expect(vehicleSubstitutionHint(s)).toBe('другой тип, крупнее');
    expect(vehicleSubstitutionGroup(s)).toBe('bigger');
    expect(
      vehicleSubstitutionWarning({
        substitution: s,
        orderedLabel: 'Грузовые малотоннажные автомобили, г/п 3.5 т',
        actualTypeName: 'Бортовые автомобили',
        actualCategoryName: 'Бортовые автомобили, г/п 10 т',
      })!.level,
    ).toBe('info');
  });

  it('другой тип, сравнить нечем — так и сказано', () => {
    const s = vehicleSubstitutionOf(ordered, {
      vehicleKindId: SPECIAL,
      vehicleTypeId: TRUCKS,
      vehicleCategoryId: null,
      categorySpecs: null,
    });
    expect(vehicleSubstitutionHint(s)).toBe('другой тип');
    expect(vehicleSubstitutionGroup(s)).toBe('other');
    expect(
      vehicleSubstitutionWarning({
        substitution: s,
        orderedLabel: 'Автокраны, г/п 130 т',
        actualTypeName: 'Тягачи с полуприцепами',
        actualCategoryName: null,
      })!.text,
    ).toContain('Тягачи с полуприцепами');
  });

  it('свой тип, а категория у машины не заполнена — «не разнесли» не равно «не подходит»', () => {
    const s = vehicleSubstitutionOf(ordered, {
      vehicleKindId: SPECIAL,
      vehicleTypeId: CRANES,
      vehicleCategoryId: null,
      categorySpecs: null,
    });
    expect(s.categoryMismatch).toBe(false);
    expect(vehicleSubstitutionHint(s)).toBe('категория не указана');
  });

  it('заявка без категории не расходится ни с чем: сравнивать не с чем', () => {
    // Тип без ТТХ (ADR 0028 §3) и заявки старше миграции 0052 — категории у них нет вовсе.
    const s = vehicleSubstitutionOf(
      { vehicleKindId: SPECIAL, vehicleTypeId: CRANES, vehicleCategoryId: null, categorySpecs: null },
      {
        vehicleKindId: SPECIAL,
        vehicleTypeId: CRANES,
        vehicleCategoryId: CAT_25,
        categorySpecs: { lift_capacity: 25 },
      },
    );
    expect(s.categoryMismatch).toBe(false);
    expect(vehicleSubstitutionHint(s)).toBeNull();
  });

  it('порядок групп: заказанный тип → крупнее → прочие → меньше → другой вид', () => {
    const rank = (actual: Parameters<typeof vehicleSubstitutionOf>[1]): number =>
      vehicleSubstitutionRank(vehicleSubstitutionOf(ordered, actual));
    const own = rank({
      vehicleKindId: SPECIAL,
      vehicleTypeId: CRANES,
      vehicleCategoryId: CAT_25,
      categorySpecs: null,
    });
    const bigger = rank({
      vehicleKindId: SPECIAL,
      vehicleTypeId: TRUCKS,
      vehicleCategoryId: CAT_25,
      categorySpecs: { lift_capacity: 200 },
    });
    const other = rank({
      vehicleKindId: SPECIAL,
      vehicleTypeId: TRUCKS,
      vehicleCategoryId: null,
      categorySpecs: null,
    });
    const smaller = rank({
      vehicleKindId: SPECIAL,
      vehicleTypeId: TRUCKS,
      vehicleCategoryId: CAT_25,
      categorySpecs: { lift_capacity: 25 },
    });
    // Чужой вид — последним, каким бы крупным он ни был: ТТХ у него сравнивать не с чем.
    const kind = rank({
      vehicleKindId: FREIGHT,
      vehicleTypeId: TRUCKS,
      vehicleCategoryId: CAT_25,
      categorySpecs: { lift_capacity: 200 },
    });
    expect([own, bigger, other, smaller, kind]).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * Вид ТС перестал быть границей замены (ADR 0064): раньше сервер отклонял такое назначение с
   * 422, теперь оно проходит с предупреждением. Проверяется то, ради чего правило менялось —
   * расхождение названо и стоит в конце списка, но ничего не отменяет.
   */
  it('другой вид техники — жёлтое предупреждение и последняя группа', () => {
    const s = vehicleSubstitutionOf(ordered, {
      vehicleKindId: FREIGHT,
      vehicleTypeId: TRUCKS,
      vehicleCategoryId: CAT_25,
      categorySpecs: { body_volume: 20 },
    });
    expect(s.kindMismatch).toBe(true);
    expect(vehicleSubstitutionHint(s)).toBe('другой вид техники');
    expect(vehicleSubstitutionGroup(s)).toBe('kind');
    const w = vehicleSubstitutionWarning({
      substitution: s,
      orderedLabel: 'Автокраны, г/п 130 т',
      actualTypeName: 'Самосвалы',
      actualCategoryName: 'Самосвалы, 20 м³',
    })!;
    // Жёлтое независимо от ТТХ: сравнивать грузоподъёмность с объёмом кузова нечем.
    expect(w.level).toBe('warning');
    expect(w.text).toContain('Автокраны, г/п 130 т');
    expect(w.text).toContain('Самосвалы, 20 м³');
    expect(w.text).toContain('другого вида');
  });
});
