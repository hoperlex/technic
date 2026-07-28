import { describe, expect, it } from 'vitest';
import {
  buildVehicleCategoryName,
  createVehicleCategorySchema,
  createVehicleSpecSchema,
  formatSpecNumber,
  formatSpecValue,
  updateVehicleCategorySchema,
  type VehicleCategoryValueDto,
  type VehicleTypeSpecDto,
} from '@technic/contracts';
import { checkedValues, valueDtos, valueToColumn } from '../src/services/vehicle-categories';
import { AppError } from '../src/lib/errors';

// ТТХ и категории типов ТС (ADR 0016). Проверяется то, что не держат ключи БД: полнота набора
// значений, границы из справочника ТТХ и формат наименования категории.

const TYPE = '11111111-1111-4111-8111-111111111111';
const CAPACITY = '22222222-2222-4222-8222-222222222222';
const BOOM = '33333333-3333-4333-8333-333333333333';

const capacity: VehicleTypeSpecDto & { specId: string } = {
  specId: CAPACITY,
  code: 'lift_capacity',
  name: 'Грузоподъёмность',
  shortName: 'г/п',
  unit: 'т',
  decimals: 1,
  minValue: 0,
  maxValue: 100,
  sortOrder: 10,
  isActive: true,
};

const boom: VehicleTypeSpecDto & { specId: string } = {
  specId: BOOM,
  code: 'boom_length',
  name: 'Длина стрелы',
  shortName: 'стрела',
  unit: 'м',
  decimals: 0,
  minValue: null,
  maxValue: null,
  sortOrder: 20,
  isActive: true,
};

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.statusCode : 0;
  }
  return 200;
}

describe('набор значений категории', () => {
  it('принимает полный набор и возвращает значения по ТТХ', () => {
    const values = checkedValues(
      [
        { specId: BOOM, value: 21 },
        { specId: CAPACITY, value: 25 },
      ],
      [capacity, boom],
    );
    expect(values.get(CAPACITY)).toBe(25);
    expect(values.get(BOOM)).toBe(21);
  });

  it('пропущенное значение — 422: полноту набора ключами БД не выразить', () => {
    expect(statusOf(() => checkedValues([{ specId: CAPACITY, value: 25 }], [capacity, boom]))).toBe(
      422,
    );
  });

  it('значение по чужому ТТХ — 422', () => {
    expect(
      statusOf(() =>
        checkedValues(
          [
            { specId: CAPACITY, value: 25 },
            { specId: TYPE, value: 1 },
          ],
          [capacity],
        ),
      ),
    ).toBe(422);
  });

  it('у типа без ТТХ категорий не бывает — 422', () => {
    expect(statusOf(() => checkedValues([{ specId: CAPACITY, value: 25 }], []))).toBe(422);
  });

  it('масштаб сверх заданного в справочнике — 422', () => {
    expect(statusOf(() => checkedValues([{ specId: BOOM, value: 21.5 }], [boom]))).toBe(422);
    expect(statusOf(() => checkedValues([{ specId: CAPACITY, value: 25.5 }], [capacity]))).toBe(
      200,
    );
  });

  it('выход за границы ТТХ — 422', () => {
    expect(statusOf(() => checkedValues([{ specId: CAPACITY, value: 100.5 }], [capacity]))).toBe(
      422,
    );
    expect(statusOf(() => checkedValues([{ specId: CAPACITY, value: -1 }], [capacity]))).toBe(422);
  });

  it('значение приводится к масштабу ТТХ для numeric-колонки', () => {
    expect(valueToColumn(25, capacity)).toBe('25.0');
    expect(valueToColumn(21, boom)).toBe('21');
  });
});

describe('наименование категории', () => {
  const values = (): VehicleCategoryValueDto[] =>
    valueDtos(
      [capacity, boom],
      new Map([
        [CAPACITY, 25],
        [BOOM, 21],
      ]),
    );

  it('собирается из типа и значений в порядке ТТХ', () => {
    expect(buildVehicleCategoryName('Автокраны', values())).toBe(
      'Автокраны, г/п 25 т, стрела 21 м',
    );
  });

  it('порядок частей задаёт sortOrder привязки, а не порядок значений', () => {
    const reordered = values()
      .map((v) => (v.specId === BOOM ? { ...v, sortOrder: 1 } : v))
      .reverse();
    expect(buildVehicleCategoryName('Автокраны', reordered)).toBe(
      'Автокраны, стрела 21 м, г/п 25 т',
    );
  });

  it('хвостовые нули не показываются — как в канонизации сигнатуры', () => {
    expect(formatSpecNumber(21.0, 1)).toBe('21');
    expect(formatSpecNumber(25.5, 1)).toBe('25.5');
    expect(formatSpecNumber(20.5, 2)).toBe('20.5');
    expect(formatSpecNumber(100, 0)).toBe('100');
    expect(formatSpecNumber(10, 1)).toBe('10');
  });

  it('безразмерный ТТХ показывается без единицы', () => {
    expect(formatSpecValue(4, { unit: '', decimals: 0 })).toBe('4');
    expect(formatSpecValue(4, { unit: 'шт', decimals: 0 })).toBe('4 шт');
  });
});

describe('контракты', () => {
  it('один ТТХ дважды в наборе значений отклоняется', () => {
    const parsed = createVehicleCategorySchema.safeParse({
      vehicleTypeId: TYPE,
      values: [
        { specId: CAPACITY, value: 25 },
        { specId: CAPACITY, value: 32 },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('пустой набор значений отклоняется', () => {
    expect(createVehicleCategorySchema.safeParse({ vehicleTypeId: TYPE, values: [] }).success).toBe(
      false,
    );
  });

  it('тип категории неизменяем: vehicleTypeId в PATCH отклоняется', () => {
    expect(updateVehicleCategorySchema.safeParse({ vehicleTypeId: TYPE }).success).toBe(false);
  });

  it('пустое имя в PATCH допустимо — это возврат к автогенерации', () => {
    expect(updateVehicleCategorySchema.safeParse({ name: '' }).success).toBe(true);
  });

  it('минимум больше максимума у ТТХ отклоняется', () => {
    const parsed = createVehicleSpecSchema.safeParse({
      code: 'lift_capacity',
      name: 'Грузоподъёмность',
      unit: 'т',
      minValue: 10,
      maxValue: 5,
    });
    expect(parsed.success).toBe(false);
  });

  it('код ТТХ — только латиница в нижнем регистре', () => {
    const bad = createVehicleSpecSchema.safeParse({ code: 'Грузоподъёмность', name: 'Г/п' });
    expect(bad.success).toBe(false);
  });
});
