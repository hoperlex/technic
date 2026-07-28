import { describe, expect, it } from 'vitest';
import {
  createWasteTariffSchema,
  createWasteTypeSchema,
  pricePerM3FromContainer,
  updateWasteTariffSchema,
  validateWasteTariff,
  type WasteTariffDefinition,
} from '@technic/contracts';

const WASTE_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const CONTAINER_TYPE_ID = '22222222-2222-4222-8222-222222222222';

const perM3: WasteTariffDefinition = {
  containerTypeId: CONTAINER_TYPE_ID,
  containerKind: null,
  pricePerM3: 1500,
  pricePerContainer: null,
  isPerContainer: false,
};

describe('validateWasteTariff: цель тарифа', () => {
  it('тариф на конкретный тип корректен', () => {
    expect(validateWasteTariff(perM3)).toEqual({});
  });

  it('тариф на вид техники корректен', () => {
    expect(
      validateWasteTariff({ ...perM3, containerTypeId: null, containerKind: 'truck' }),
    ).toEqual({});
  });

  it('и тип, и вид одновременно — ошибка', () => {
    expect(validateWasteTariff({ ...perM3, containerKind: 'cont' })).toHaveProperty(
      'containerTypeId',
    );
  });

  it('ни типа, ни вида — ошибка', () => {
    expect(validateWasteTariff({ ...perM3, containerTypeId: null })).toHaveProperty(
      'containerTypeId',
    );
  });
});

describe('validateWasteTariff: цена', () => {
  it('за м³ цена обязательна и положительна', () => {
    expect(validateWasteTariff({ ...perM3, pricePerM3: null })).toHaveProperty('pricePerM3');
    expect(validateWasteTariff({ ...perM3, pricePerM3: 0 })).toHaveProperty('pricePerM3');
  });

  it('за контейнер нужна цена за контейнер, а не за м³', () => {
    const perContainer: WasteTariffDefinition = {
      ...perM3,
      isPerContainer: true,
      pricePerM3: null,
      pricePerContainer: 15000,
    };
    expect(validateWasteTariff(perContainer)).toEqual({});
    expect(validateWasteTariff({ ...perContainer, pricePerContainer: null })).toHaveProperty(
      'pricePerContainer',
    );
  });

  it('цена за контейнер не задаётся тарифу на вид техники', () => {
    expect(
      validateWasteTariff({
        containerTypeId: null,
        containerKind: 'cont',
        pricePerM3: null,
        pricePerContainer: 15000,
        isPerContainer: true,
      }),
    ).toHaveProperty('containerTypeId');
  });
});

describe('pricePerM3FromContainer', () => {
  it('прайс п.3: 15 000 ₽ за контейнер 8 м³ — это 1875 ₽/м³', () => {
    expect(pricePerM3FromContainer(15000, 8)).toBe(1875);
  });

  it('округляет до копеек', () => {
    expect(pricePerM3FromContainer(10000, 27)).toBe(370.37);
  });
});

describe('схемы прайса', () => {
  it('цена округляется до копеек на входе', () => {
    const parsed = createWasteTariffSchema.parse({
      wasteTypeId: WASTE_TYPE_ID,
      containerTypeId: CONTAINER_TYPE_ID,
      pricePerM3: 1500.005,
    });
    expect(parsed.pricePerM3).toBe(1500.01);
    // Умолчания: позиция создаётся действующей и тарифицируется за м³.
    expect(parsed.isPerContainer).toBe(false);
    expect(parsed.isActive).toBe(true);
    expect(parsed.note).toBe('');
  });

  it('неположительная цена отклоняется', () => {
    expect(() =>
      createWasteTariffSchema.parse({ wasteTypeId: WASTE_TYPE_ID, pricePerM3: 0 }),
    ).toThrow();
  });

  it('правка допускает частичное тело — инварианты проверяет сервер на слитой позиции', () => {
    expect(updateWasteTariffSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(updateWasteTariffSchema.parse({ containerTypeId: null }).containerTypeId).toBeNull();
  });

  it('посторонние поля не проходят', () => {
    expect(() => updateWasteTariffSchema.parse({ isActive: false, amount: 100 })).toThrow();
  });
});

describe('createWasteTypeSchema', () => {
  it('код — латиница в нижнем регистре с цифрами и «_»', () => {
    expect(
      createWasteTypeSchema.parse({ code: 'concrete_debris', name: 'Бетонный бой' }).code,
    ).toBe('concrete_debris');
    for (const code of ['Concrete', '1soil', 'бетон', 'soil-clean'])
      expect(() => createWasteTypeSchema.parse({ code, name: 'Тип' })).toThrow();
  });

  it('название не может быть пустым', () => {
    expect(() => createWasteTypeSchema.parse({ code: 'soil', name: '   ' })).toThrow();
  });
});
