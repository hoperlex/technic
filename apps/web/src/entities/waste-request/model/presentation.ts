import {
  calcWasteAmount,
  isPricedRequestType,
  isVolumeAllowed,
  wasteFactLabel,
  type ResolvedWasteTariffDto,
  type WasteRequestDto,
} from '@technic/contracts';
import { formatMoney } from '@shared/lib';

export interface WastePricingHint {
  text: string;
  tone: 'secondary' | 'warning';
}

/**
 * Explain the server-resolved price below the request form. A missing tariff is a warning rather
 * than a blocker (ADR 0046), so the caller must keep its visual tone together with the text.
 */
export function wastePricingHint(input: {
  isPriced: boolean;
  wasteTypeId?: string | null;
  operatorSelected: boolean;
  /** A null tariff in a successful response means that the price list has no matching row. */
  tariff: ResolvedWasteTariffDto | null;
  /** Distinguishes a missing price from a request that has not completed yet. */
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
  // A minimum price belongs to the cheapest operator and can change after assignment (ADR 0026).
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

/** Describe a request's price in list and card views without treating a missing tariff as zero. */
export function wasteAmountLine(request: WasteRequestDto): WastePricingHint | null {
  if (request.amount != null) {
    // Until assignment, the snapshot is the cheapest known price and must remain visibly partial.
    const from = request.operatorCounterpartyId ? '' : 'от ';
    return {
      text: `${from}${formatMoney(request.amount)} · ${formatMoney(request.pricePerM3)}/м³`,
      tone: 'secondary',
    };
  }
  if (!isPricedRequestType(request.requestType) || !request.wasteTypeId) return null;
  return { text: 'тариф не задан — стоимость не рассчитана', tone: 'warning' };
}

/** Scrap removal has no planned subject, so its completion weight occupies the subject subline. */
export function wasteWeightFactLine(request: WasteRequestDto): string | null {
  return request.completion?.unit === 'weight_tons'
    ? `сдано ${wasteFactLabel(request.completion)}`
    : null;
}

/**
 * Describe the actual data that a rollback to New will erase. The list is derived from this exact
 * request so the confirmation never promises removal of data that does not exist.
 */
export function wasteRollbackErases(request: WasteRequestDto): string[] {
  const items: string[] = [];
  if (request.completion) {
    const cost =
      request.completion.totalCost != null ? ` · ${formatMoney(request.completion.totalCost)}` : '';
    items.push(`Предъявленный факт: вывезено ${wasteFactLabel(request.completion)}${cost}`);
  }
  // Tickets are a request-wide pool (ADR 0024); their count is the relevant rollback consequence.
  if (request.tickets.length > 0) {
    items.push(`Приложенные талоны вывоза: ${request.tickets.length} шт.`);
  }
  return items;
}
