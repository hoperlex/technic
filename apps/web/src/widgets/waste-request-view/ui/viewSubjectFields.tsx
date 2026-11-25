import { Typography } from 'antd';
import {
  isManualCostOnly,
  isPricedRequestType,
  requiresOrderedVolume,
  wasteFactLabel,
  type WasteRequestDto,
} from '@technic/contracts';
import { wasteFactCostLine } from '@entities/waste-request';
import { formatMoney } from '@shared/lib';
import type { ViewField } from '@shared/ui';

const secondary = { fontSize: 12 } as const;

/**
 * The ordered subject and its money (ADR 0009, ADR 0019).
 *
 * The block follows the stored data, not only the request type: only garbage removal is priced,
 * but replacements and removals created before that decision kept their price, and hiding it would
 * lose the history of amounts. Snow orders a volume of the service type «Снег» and has no price
 * list at all (snow-removal plan, S2, S6): the card shows the volume and «Снег» outside the
 * pricing rows and says where its money comes from instead of an estimate.
 */
export function subjectFields(request: WasteRequestDto): ViewField[] {
  const priced = isPricedRequestType(request.requestType) || request.amount != null;
  const volume: ViewField = {
    key: 'volume',
    label: 'Объём',
    children: request.volumeM3 != null ? `${request.volumeM3} м³` : '—',
  };
  const wasteType: ViewField = {
    key: 'wasteType',
    label: 'Тип мусора',
    children: request.wasteTypeName ?? '—',
  };
  if (!priced) {
    if (!requiresOrderedVolume(request.requestType)) return [];
    return [
      volume,
      wasteType,
      ...(isManualCostOnly(request.requestType)
        ? [
            {
              key: 'amount',
              label: 'Стоимость',
              children: (
                <Typography.Text type="secondary">вносится при закрытии заявки</Typography.Text>
              ),
            },
          ]
        : []),
    ];
  }
  return [
    volume,
    wasteType,
    {
      key: 'amount',
      label: 'Стоимость',
      children:
        request.amount == null ? (
          // The request was created when the price list had no price for this waste type
          // (ADR 0046). A dash would read as "not filled in", so the reason is named. Requests
          // older than pricing have no waste type either: nothing to say there.
          request.wasteTypeId == null ? (
            '—'
          ) : (
            <Typography.Text type="warning">
              тариф не задан — стоимость не рассчитана
            </Typography.Text>
          )
        ) : (
          <div style={{ lineHeight: 1.3 }}>
            {/* Without an operator, ADR 0026 uses the cheapest tariff; “from” signals that
                assigning an operator will refine the price. */}
            <div>
              {request.operatorCounterpartyId ? '' : 'от '}
              {formatMoney(request.amount)}
            </div>
            {request.pricePerM3 != null && (
              <Typography.Text type="secondary" style={secondary}>
                {formatMoney(request.pricePerM3)}/м³
              </Typography.Text>
            )}
          </div>
        ),
    },
  ];
}

/**
 * Completion fact (ADR 0035): what was hauled and what it cost. Its amount is what the request
 * actually cost; the price above is the plan for the requested volume. Legacy vehicle composition
 * is not lifted here: it stays in history, at its completion event.
 *
 * A snow completion without an amount says the amount is awaited (S7); a garbage one says the price
 * list had no price. A recorded 0 is a known amount in both.
 */
export function factFields(request: WasteRequestDto): ViewField[] {
  const fact = request.completion;
  if (!fact) return [];
  const cost = wasteFactCostLine(request);
  return [
    {
      key: 'hauled',
      label: 'Вывезено',
      full: true,
      children: (
        <div style={{ lineHeight: 1.3 }}>
          <div>
            {wasteFactLabel(fact)}
            {fact.totalCost != null ? ` · ${formatMoney(fact.totalCost)}` : ''}
          </div>
          {fact.totalCost != null &&
            request.amount != null &&
            fact.totalCost !== request.amount && (
              <Typography.Text type="secondary" style={secondary}>
                заявка оформлялась на {formatMoney(request.amount)}
              </Typography.Text>
            )}
          {fact.totalCost == null &&
            (cost ? (
              <Typography.Text type={cost.tone} style={secondary}>
                {cost.text}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={secondary}>
                стоимость не указана — цены в прайсе не было
              </Typography.Text>
            ))}
        </div>
      ),
    },
  ];
}
