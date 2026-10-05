import {
  calcWasteAmount,
  isPricedRequestType,
  isVolumeAllowed,
  wasteFactLabel,
  type ResolvedWasteTariffDto,
  type WasteRequestDto,
} from '@technic/contracts';
import { formatMoney } from '@shared/lib';

/**
 * A price line with its tone. The tone decides how the line looks: an ordinary calculation hint is
 * grey, "no price" is yellow, otherwise a missing amount would go unnoticed.
 */
export interface WastePricingHint {
  text: string;
  tone: 'secondary' | 'warning';
}

/**
 * Explain the server-resolved price below the "waste type / volume" fields. The form has no cost
 * field: the price list sets the price (ADR 0009), and the user only needs to see what the request
 * will cost. A missing tariff is a warning rather than a blocker (ADR 0046): the request saves
 * without an amount, so the caller must keep the visual tone together with the text.
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
  // "от" marks the cheapest operator's price: no executor is chosen yet, and assignment will refine
  // it (ADR 0026). When all operators charge the same there is nothing to refine, so no prefix.
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
 * A request's price for list and card views. Null means nothing to show: a container operation
 * never has a price (ADR 0019), and requests older than pricing have no waste type. Removal with a
 * waste type but no amount was created with a missing tariff (ADR 0046) and must not stay silent,
 * otherwise the empty place reads as "free".
 */
export function wasteAmountLine(request: WasteRequestDto): WastePricingHint | null {
  if (request.amount != null) {
    // Until an executor is assigned, the amount is computed by the cheapest price list (ADR 0026),
    // and "от" says operator assignment will refine it.
    const from = request.operatorCounterpartyId ? '' : 'от ';
    return {
      text: `${from}${formatMoney(request.amount)} · ${formatMoney(request.pricePerM3)}/м³`,
      tone: 'secondary',
    };
  }
  if (!isPricedRequestType(request.requestType) || !request.wasteTypeId) return null;
  return { text: 'тариф не задан — стоимость не рассчитана', tone: 'warning' };
}

/**
 * Delivered weight as the subject's second line for scrap removal (ADR 0067). It appears only after
 * closing: before that such a request has neither subject nor figures, and there is nothing to
 * promise the weight with, since the request carries no plan.
 */
export function wasteWeightFactLine(request: WasteRequestDto): string | null {
  return request.completion?.unit === 'weight_tons'
    ? `сдано ${wasteFactLabel(request.completion)}`
    : null;
}

/**
 * What a rollback to "Новая" will erase from this request (transitionResetsWork), as lines built
 * from its own data. For waste requests that is the submitted fact (ADR 0035, ADR 0067) and the
 * removal tickets (ADR 0013, ADR 0024): everything the request was closed with. They are not always
 * present: a request reaches "В работе" without them, and fact and tickets exist only on one that
 * was already closed and rolled back. The list is therefore derived from this exact request, so the
 * confirmation never frightens the user with a loss of data that does not exist.
 */
export function wasteRollbackErases(request: WasteRequestDto): string[] {
  const items: string[] = [];
  if (request.completion) {
    const cost =
      request.completion.totalCost != null ? ` · ${formatMoney(request.completion.totalCost)}` : '';
    items.push(`Предъявленный факт: вывезено ${wasteFactLabel(request.completion)}${cost}`);
  }
  // Tickets are a request-wide pool (ADR 0024) and are counted, not named: what matters in the
  // decision window is that the paper detaches from the request and must be attached again.
  if (request.tickets.length > 0) {
    items.push(`Приложенные талоны вывоза: ${request.tickets.length} шт.`);
  }
  return items;
}
