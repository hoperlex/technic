import { describe, expect, it } from 'vitest';
import type { WasteTariffDto } from '@technic/contracts';
import {
  buildWasteTariffGrid,
  wasteTariffColumnOperators,
  wasteTariffRowKey,
} from '../src/pages/directories/wasteTariffGrid';

const TRANS = 'op-trans-invest';
const TRINITY = 'op-trinity';

function tariff(p: Partial<WasteTariffDto> & { id: string }): WasteTariffDto {
  return {
    operatorCounterpartyId: TRANS,
    operatorName: 'ТК «Транс Инвест»',
    wasteTypeId: 'wt-soil',
    wasteTypeName: 'Чистый грунт',
    containerTypeId: null,
    containerTypeName: null,
    containerVolumeM3: null,
    containerKind: 'truck',
    pricePerM3: 900,
    pricePerContainer: null,
    isPerContainer: false,
    note: '',
    isActive: true,
    ...p,
  };
}

describe('buildWasteTariffGrid: строка — пара, столбец — оператор', () => {
  it('цены разных операторов на одну пару собираются в одну строку', () => {
    const rows = buildWasteTariffGrid([
      tariff({ id: 'a' }),
      tariff({
        id: 'b',
        operatorCounterpartyId: TRINITY,
        operatorName: 'Тринити',
        pricePerM3: 700,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.byOperator[TRANS]!.pricePerM3).toBe(900);
    expect(rows[0]!.byOperator[TRINITY]!.pricePerM3).toBe(700);
  });

  it('разная техника — разные строки, даже у одного типа мусора', () => {
    const rows = buildWasteTariffGrid([
      tariff({ id: 'a' }),
      tariff({
        id: 'b',
        containerTypeId: 'ct-8',
        containerTypeName: 'Контейнер 8 м³',
        containerKind: null,
      }),
    ]);
    expect(rows).toHaveLength(2);
    // Цена на вид техники идёт первой: следом читаются исключения из неё.
    expect(rows.map((r) => r.containerTypeId)).toEqual([null, 'ct-8']);
  });

  it('строки упорядочены по названию типа мусора', () => {
    const rows = buildWasteTariffGrid([
      tariff({ id: 'a', wasteTypeId: 'wt-wood', wasteTypeName: 'Древесные отходы' }),
      tariff({ id: 'b', wasteTypeId: 'wt-concrete', wasteTypeName: 'Бетонный бой' }),
    ]);
    expect(rows.map((r) => r.wasteTypeName)).toEqual(['Бетонный бой', 'Древесные отходы']);
  });

  it('ключ строки различает цель тарифа', () => {
    const kind = wasteTariffRowKey({
      wasteTypeId: 'wt',
      containerTypeId: null,
      containerKind: 'truck',
    });
    const exact = wasteTariffRowKey({
      wasteTypeId: 'wt',
      containerTypeId: 'ct-8',
      containerKind: null,
    });
    expect(kind).not.toBe(exact);
  });
});

describe('wasteTariffColumnOperators: чьи столбцы показывать', () => {
  const operators = [
    { id: TRANS, isActive: true },
    { id: TRINITY, isActive: false },
    { id: 'op-idle', isActive: false },
  ];

  it('активные — всегда, неактивные — только со своими ценами', () => {
    const shown = wasteTariffColumnOperators(operators, [
      tariff({ id: 'a', operatorCounterpartyId: TRINITY }),
    ]);
    expect(shown.map((o) => o.id)).toEqual([TRANS, TRINITY]);
  });

  it('без цен остаются только активные', () => {
    expect(wasteTariffColumnOperators(operators, []).map((o) => o.id)).toEqual([TRANS]);
  });
});
