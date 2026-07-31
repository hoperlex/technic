import { describe, expect, it } from 'vitest';
import type { ResolvedWasteTariffDto, WasteRequestDto } from '@technic/contracts';
import { wasteAmountLine, wastePricingHint } from '../src/pages/waste/pricingHint';
// Числа сверяются через тот же форматтер: разделитель разрядов в ru-RU — неразрывный пробел,
// и вписанный в ожидание руками он делает тест ложно красным.
import { formatMoney } from '../src/utils/format';

/**
 * Строка расчёта в форме заявки и строка стоимости в списке. Незаданный тариф — предупреждение,
 * а не отказ (ADR 0046): форма о нём говорит, но заявку заводить не мешает, и заведённая без
 * цены заявка потом называет причину пустой суммы, а не показывает прочерк.
 */

const TARIFF: ResolvedWasteTariffDto = {
  tariffId: 't1',
  wasteTypeId: 'wt-1',
  containerTypeId: null,
  operatorCounterpartyId: 'op-1',
  operatorName: 'ТрансИнвест',
  isMinimum: false,
  pricePerM3: 900,
  isPerContainer: false,
  containerVolumeM3: null,
  volumeStepM3: null,
  matchedBy: 'container_kind',
};

const base = {
  isPriced: true,
  wasteTypeId: 'wt-1',
  operatorSelected: false,
  resolved: true,
  requestFailed: false,
  volumeM3: 20,
};

describe('wastePricingHint: расчёт под полями формы', () => {
  it('тариф есть — цена за м³ и итог, строка обычной подсказкой', () => {
    const hint = wastePricingHint({ ...base, tariff: TARIFF });
    expect(hint?.tone).toBe('secondary');
    expect(hint?.text).toContain(`${formatMoney(900)}/м³`);
    expect(hint?.text).toContain(`итого ${formatMoney(18000)}`);
  });

  // «от» ставится, пока исполнитель не выбран и у кого-то дороже (ADR 0026).
  it('минимальная цена помечается «от» и называет чей прайс', () => {
    const hint = wastePricingHint({ ...base, tariff: { ...TARIFF, isMinimum: true } });
    expect(hint?.text).toContain(`от ${formatMoney(900)}/м³`);
    expect(hint?.text).toContain('ТрансИнвест');
  });

  it('тарифа нет — предупреждение, что заявка сохранится без стоимости', () => {
    const hint = wastePricingHint({ ...base, tariff: null });
    expect(hint?.tone).toBe('warning');
    expect(hint?.text).toContain('Тариф на вывоз этого типа мусора не задан');
    expect(hint?.text).toContain('заявка сохранится без стоимости');
  });

  // Причина у пустой цены разная: у назначенного оператора правят его прайс, а не заявку.
  it('у выбранного оператора цены нет — предупреждение называет оператора', () => {
    const hint = wastePricingHint({ ...base, operatorSelected: true, tariff: null });
    expect(hint?.tone).toBe('warning');
    expect(hint?.text).toContain('У выбранного оператора');
  });

  it('ответ ещё не получен — строки о незаданной цене нет', () => {
    expect(wastePricingHint({ ...base, resolved: false, tariff: null })).toBe(null);
  });

  it('тип мусора не выбран — общая подсказка о расчёте', () => {
    const hint = wastePricingHint({ ...base, wasteTypeId: null, tariff: null });
    expect(hint?.tone).toBe('secondary');
    expect(hint?.text).toContain('посчитается автоматически');
  });

  // Контейнерные операции не тарифицируются (ADR 0019): расчёту в их форме места нет.
  it('нетарифицируемая операция — строки нет вовсе', () => {
    expect(wastePricingHint({ ...base, isPriced: false, tariff: TARIFF })).toBe(null);
  });
});

const request = {
  requestType: 'waste_removal',
  wasteTypeId: 'wt-1',
  operatorCounterpartyId: 'op-1',
  amount: 18000,
  pricePerM3: 900,
} as WasteRequestDto;

describe('wasteAmountLine: стоимость в списке', () => {
  it('сумма есть — сумма и цена за м³', () => {
    const line = wasteAmountLine(request);
    expect(line?.tone).toBe('secondary');
    expect(line?.text).toBe(`${formatMoney(18000)} · ${formatMoney(900)}/м³`);
  });

  it('исполнителя нет — сумма с приставкой «от»', () => {
    const line = wasteAmountLine({ ...request, operatorCounterpartyId: null } as WasteRequestDto);
    expect(line?.text.startsWith('от ')).toBe(true);
  });

  it('вывоз без суммы — предупреждение о незаданном тарифе', () => {
    const line = wasteAmountLine({
      ...request,
      amount: null,
      pricePerM3: null,
    } as WasteRequestDto);
    expect(line?.tone).toBe('warning');
    expect(line?.text).toContain('тариф не задан');
  });

  // Заявки старше тарификации: типа мусора у них нет, и сказать о цене нечего.
  it('вывоз без типа мусора — строки нет', () => {
    expect(
      wasteAmountLine({
        ...request,
        amount: null,
        pricePerM3: null,
        wasteTypeId: null,
      } as WasteRequestDto),
    ).toBe(null);
  });

  it('контейнерная операция — строки нет', () => {
    expect(
      wasteAmountLine({
        ...request,
        requestType: 'container_removal',
        amount: null,
        pricePerM3: null,
      } as WasteRequestDto),
    ).toBe(null);
  });
});
