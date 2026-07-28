import { describe, expect, it } from 'vitest';
import {
  createWasteTariffSchema,
  findSimilarWasteTypes,
  findWasteTypeByName,
  pricePerM3FromContainer,
  updateWasteTariffSchema,
  validateWasteTariff,
  validateWasteTypeChoice,
  type WasteTariffDefinition,
  wasteTypeNameKey,
  wasteTypeNameSchema,
} from '@technic/contracts';
import { wasteTypeCodeFromName } from '../src/services/waste-types';

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

describe('wasteTypeNameKey: вариации написания дают один ключ', () => {
  it('регистр, пробелы, разделители и «ё» значения не имеют', () => {
    const key = wasteTypeNameKey('Бетонный бой');
    for (const variant of [
      'бетонный бой',
      'БЕТОННЫЙ  БОЙ',
      ' Бетонный-бой ',
      'Бетонный/бой!',
      'бетонныйбой',
    ]) {
      expect(wasteTypeNameKey(variant)).toBe(key);
    }
  });

  it('«ё» и «е» — одна буква', () => {
    expect(wasteTypeNameKey('Щёбень')).toBe(wasteTypeNameKey('щебень'));
  });

  it('разные типы остаются разными', () => {
    expect(wasteTypeNameKey('Чистый грунт')).not.toBe(wasteTypeNameKey('Замусоренный грунт'));
  });

  it('название без букв и цифр даёт пустой ключ — такое запрещено схемой', () => {
    expect(wasteTypeNameKey('— —')).toBe('');
    expect(() => wasteTypeNameSchema.parse('— —')).toThrow();
    expect(wasteTypeNameSchema.parse('  Бетонный бой  ')).toBe('Бетонный бой');
  });
});

describe('findWasteTypeByName: блокирующий дубль', () => {
  const types = [
    { id: 'a', name: 'Бетонный бой' },
    { id: 'b', name: 'Чистый грунт' },
  ];

  it('находит тип по любой вариации написания', () => {
    expect(findWasteTypeByName('  БЕТОННЫЙ-бой ', types)?.id).toBe('a');
  });

  it('незнакомое название дубля не даёт', () => {
    expect(findWasteTypeByName('Асфальтовый лом', types)).toBeUndefined();
  });
});

describe('findSimilarWasteTypes: предупреждение, а не запрет', () => {
  const types = [
    { id: 'a', name: 'Бетонный бой' },
    { id: 'b', name: 'Чистый грунт' },
    { id: 'c', name: 'Строительные отходы' },
    { id: 'd', name: 'ОССиГ' },
  ];

  it('опечатка в одну букву показывается как похожая', () => {
    expect(findSimilarWasteTypes('Бетоный бой', types).map((t) => t.id)).toEqual(['a']);
  });

  it('вхождение целиком: «Грунт» рядом с «Чистый грунт»', () => {
    expect(findSimilarWasteTypes('Грунт', types).map((t) => t.id)).toEqual(['b']);
  });

  it('другой тип из того же прайса похожим не считается', () => {
    expect(findSimilarWasteTypes('Строительный мусор', types)).toEqual([]);
    expect(findSimilarWasteTypes('Древесные отходы', types)).toEqual([]);
  });

  it('точный дубль в похожие не попадает — у него отдельный запрет', () => {
    expect(findSimilarWasteTypes('бетонный  бой', types)).toEqual([]);
  });
});

describe('validateWasteTypeChoice: тип берётся ровно одним способом', () => {
  it('существующий тип', () => {
    expect(validateWasteTypeChoice({ wasteTypeId: WASTE_TYPE_ID })).toEqual({});
  });

  it('новый тип по названию', () => {
    expect(validateWasteTypeChoice({ wasteTypeName: 'Бетонный бой' })).toEqual({});
  });

  it('оба сразу и ни одного — ошибка', () => {
    expect(
      validateWasteTypeChoice({ wasteTypeId: WASTE_TYPE_ID, wasteTypeName: 'Бетонный бой' }),
    ).toHaveProperty('wasteTypeId');
    expect(validateWasteTypeChoice({})).toHaveProperty('wasteTypeId');
  });
});

describe('wasteTypeCodeFromName: код выводится из названия', () => {
  it('кириллица переводится в латиницу, разделители — в «_»', () => {
    expect(wasteTypeCodeFromName('Бетонный бой')).toBe('betonnyy_boy');
    expect(wasteTypeCodeFromName('ОССиГ')).toBe('ossig');
    expect(wasteTypeCodeFromName('  Щебень 5-20  ')).toBe('scheben_5_20');
  });

  it('код всегда начинается с латинской буквы — этого требует CHECK', () => {
    expect(wasteTypeCodeFromName('5 класс')).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(wasteTypeCodeFromName('Ь')).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
