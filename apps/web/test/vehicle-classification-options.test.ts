import { describe, expect, it } from 'vitest';
import type { VehicleClassificationDto } from '@technic/contracts';
import {
  classificationFilterGroups,
  classificationGroups,
} from '../src/hooks/useVehicleClassifications';

/**
 * Варианты выбора техники: в форме заявки — конечные позиции классификатора (ADR 0028), в фильтре
 * списка — они же плюс «весь тип». Оба списка собираются из одного ответа сервера, порядок которого
 * и есть порядок справочника.
 */
function position(
  over: Partial<VehicleClassificationDto> & {
    vehicleTypeId: string;
    vehicleCategoryId: string | null;
    typeName: string;
  },
): VehicleClassificationDto {
  return {
    key: `${over.vehicleTypeId}:${over.vehicleCategoryId ?? ''}`,
    kindId: 'kind-1',
    kindCode: 'special_equipment',
    kindName: 'Спецтехника',
    typeCode: over.typeName,
    categoryName: null,
    label: over.categoryName ?? over.typeName,
    specCount: over.vehicleCategoryId ? 1 : 0,
    avgPricePerHour: null,
    avgPricePerShift: null,
    isActive: true,
    typeIsActive: true,
    categoryIsActive: over.vehicleCategoryId ? true : null,
    sortOrder: 0,
    categorySortOrder: null,
    ...over,
  };
}

const crane25 = position({
  vehicleTypeId: 'crane',
  vehicleCategoryId: 'c25',
  typeName: 'Автокраны',
  categoryName: 'Автокраны, г/п 25 т',
  label: 'Автокраны, г/п 25 т',
});
const crane130 = position({
  vehicleTypeId: 'crane',
  vehicleCategoryId: 'c130',
  typeName: 'Автокраны',
  categoryName: 'Автокраны, г/п 130 т',
  label: 'Автокраны, г/п 130 т',
});
const drill = position({ vehicleTypeId: 'drill', vehicleCategoryId: null, typeName: 'Ямобур' });
const tipper = position({
  vehicleTypeId: 'tipper',
  vehicleCategoryId: null,
  typeName: 'Самосвал',
  kindCode: 'freight_transport',
  kindName: 'Грузовая техника',
});

describe('classificationGroups (выбор в форме заявки)', () => {
  it('позиции раскладываются по видам ТС, порядок сервера сохраняется', () => {
    const groups = classificationGroups([crane25, crane130, drill, tipper]);
    expect(groups.map((g) => g.label)).toEqual(['Спецтехника', 'Грузовая техника']);
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['crane:c25', 'crane:c130', 'drill:']);
    expect(groups[1]!.options).toEqual([{ value: 'tipper:', label: 'Самосвал' }]);
  });
});

describe('порядок цены у позиции (подсказка выбора)', () => {
  it('позиция со средней ставкой получает приписку, без ставок — не получает', () => {
    const priced = { ...crane25, avgPricePerHour: 2400 };
    const [special] = classificationGroups([priced, drill]);
    // Пробел разрядов у ru-RU неразрывный — сверяем по цифрам и единице.
    expect(special!.options[0]!.priceHint).toMatch(/^~ 2.400 ₽\/час$/);
    // Позиция без единой заполненной ставки остаётся без приписки: «нет цены» — не «бесплатно».
    expect(special!.options[1]!.priceHint).toBeUndefined();
  });

  it('в фильтре списка цен нет: там выбирают, что искать, а не что заказать', () => {
    const [special] = classificationFilterGroups([{ ...crane25, avgPricePerHour: 2400 }]);
    expect(special!.options.every((o) => !('priceHint' in o) || o.priceHint === undefined)).toBe(
      true,
    );
  });
});

describe('classificationFilterGroups (фильтр списка)', () => {
  it('у типа с категориями впереди стоит он сам целиком', () => {
    const [special] = classificationFilterGroups([crane25, crane130, drill]);
    expect(special!.options).toEqual([
      { value: 'crane:', label: 'Автокраны — все категории' },
      { value: 'crane:c25', label: 'Автокраны, г/п 25 т' },
      { value: 'crane:c130', label: 'Автокраны, г/п 130 т' },
      // Тип без категорий сам конечная позиция — «весь тип» ему не добавляется.
      { value: 'drill:', label: 'Ямобур' },
    ]);
  });

  it('вариант «весь тип» — один на тип, сколько бы категорий у него ни было', () => {
    const [special] = classificationFilterGroups([crane25, crane130]);
    expect(special!.options.filter((o) => o.value === 'crane:')).toHaveLength(1);
  });

  it('пустой классификатор — пустой список вариантов', () => {
    expect(classificationFilterGroups([])).toEqual([]);
  });
});
