import { calcWasteAmount, isPricedRequestType, isVolumeAllowed } from '@technic/contracts';
import type { ResolvedWasteTariffDto, WasteRequestDto } from '@technic/contracts';
import { formatMoney } from '../../utils/format';

/**
 * Строка расчёта под полями «тип мусора — объём». Поля стоимости в форме нет: цену даёт прайс
 * (ADR 0009), и человеку остаётся увидеть, во что заявка обойдётся.
 *
 * Незаданный тариф — предупреждение, а не отказ (ADR 0046): заявка сохранится, просто без суммы.
 * Тон здесь и решает, чем строка выглядит: обычная подсказка расчёта — серой, «цены нет» —
 * жёлтой, иначе отсутствие суммы прошло бы незамеченным.
 */
export interface WastePricingHint {
  text: string;
  tone: 'secondary' | 'warning';
}

export function wastePricingHint(input: {
  isPriced: boolean;
  wasteTypeId?: string | null;
  operatorSelected: boolean;
  /** Подобранный сервером тариф; `null` при 200 — цены на эту пару в прайсе нет. */
  tariff: ResolvedWasteTariffDto | null;
  /** Ответ сервера получен: отличает «цены нет» от «ещё грузим». */
  resolved: boolean;
  requestFailed: boolean;
  volumeM3: number | null;
}): WastePricingHint | null {
  if (!input.isPriced) return null;
  if (!input.wasteTypeId) {
    return {
      text: 'Стоимость посчитается автоматически: цена — по прайсу, сумма — по объёму',
      tone: 'secondary',
    };
  }
  if (input.requestFailed) {
    return { text: 'Не удалось получить цену — обновите страницу и повторите', tone: 'warning' };
  }
  if (input.resolved && !input.tariff) {
    return {
      text: input.operatorSelected
        ? 'У выбранного оператора цена на этот тип мусора не задана — заявка сохранится без стоимости'
        : 'Тариф на вывоз этого типа мусора не задан — заявка сохранится без стоимости',
      tone: 'warning',
    };
  }
  if (!input.tariff) return null;
  const tariff = input.tariff;
  const amount =
    input.volumeM3 != null && isVolumeAllowed(input.volumeM3, tariff.volumeStepM3 ?? null)
      ? calcWasteAmount(input.volumeM3, tariff.pricePerM3)
      : null;
  // «от» — цена самого дешёвого оператора: исполнитель ещё не выбран, и назначение его уточнит
  // (ADR 0026). Когда все операторы просят одинаково, уточнять нечего — приставки нет.
  const from = tariff.isMinimum ? 'от ' : '';
  return {
    text: [
      `${from}${formatMoney(tariff.pricePerM3)}/м³`,
      amount != null ? `итого ${from}${formatMoney(amount)}` : null,
      tariff.isMinimum ? `по прайсу «${tariff.operatorName}»` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    tone: 'secondary',
  };
}

/**
 * Стоимость заявки строкой для списка и карточки. Пусто — показывать нечего: у контейнерной
 * операции цены не бывает (ADR 0019), у заявок старше тарификации нет и типа мусора.
 * Вывоз с типом мусора, но без суммы — заявка, заведённая при незаданном тарифе (ADR 0046):
 * молчать о ней нельзя, иначе пустое место читается как «бесплатно».
 */
export function wasteAmountLine(r: WasteRequestDto): WastePricingHint | null {
  if (r.amount != null) {
    // Пока исполнителя нет, сумма посчитана по самому дешёвому прайсу (ADR 0026) — «от»
    // говорит, что назначение оператора её уточнит.
    const from = r.operatorCounterpartyId ? '' : 'от ';
    return {
      text: `${from}${formatMoney(r.amount)} · ${formatMoney(r.pricePerM3)}/м³`,
      tone: 'secondary',
    };
  }
  if (!isPricedRequestType(r.requestType) || !r.wasteTypeId) return null;
  return { text: 'тариф не задан — стоимость не рассчитана', tone: 'warning' };
}
