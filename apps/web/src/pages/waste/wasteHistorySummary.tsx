import { Tooltip, Typography } from 'antd';
import { requestStatusLabels, type WasteRequestHistorySummaryDto } from '@technic/contracts';
import { formatMoney } from '@shared/lib';
import type { SummaryItem } from '@shared/ui';

/**
 * The journal summary line (ADR 0135) with the snow counts (snow-removal plan, §3.3).
 *
 * A snow cost is entered by hand and may be missing (S7), so the sum alone no longer says whether
 * it covers every completed request. The line counts completed snow requests with and without a
 * recorded cost — a recorded 0 is a known cost — and marks the sum as incomplete when some are
 * missing. For a snow-only selection with no cost at all the sum is a dash: «0,00 ₽» would read
 * as free removals. An API from before snow sends neither count, and they read as 0.
 */
export function historySummaryItems(
  summary: WasteRequestHistorySummaryDto,
  snowOnly: boolean,
): SummaryItem[] {
  const withCost = summary.snowCompletedWithCost ?? 0;
  const withoutCost = summary.snowCompletedWithoutCost ?? 0;
  const cost =
    snowOnly && withoutCost > 0 && withCost === 0 ? (
      '—'
    ) : withoutCost > 0 ? (
      <Tooltip
        title={`Сумма неполная: у завершённых заявок на вывоз снега (${withoutCost}) стоимость не внесена`}
      >
        <span>
          {formatMoney(summary.totalCost)}{' '}
          <Typography.Text type="warning">неполная</Typography.Text>
        </span>
      </Tooltip>
    ) : (
      formatMoney(summary.totalCost)
    );
  return [
    { label: 'Закрыто', value: summary.total },
    { label: requestStatusLabels.completed, value: summary.completed },
    { label: requestStatusLabels.cancelled, value: summary.cancelled },
    // Removed quantity in two figures: garbage is measured by volume, scrap is accepted by weight
    // (ADR 0067), and the two do not add up. An empty figure is not shown at all: «0 т» in a
    // journal that never had scrap reads as "zero was delivered".
    ...(summary.volumeM3 ? [{ label: 'Вывезено', value: `${summary.volumeM3} м³` }] : []),
    ...(summary.weightTons ? [{ label: 'Сдано лома', value: `${summary.weightTons} т` }] : []),
    ...(withCost + withoutCost > 0
      ? [
          { label: 'Снег со стоимостью', value: withCost },
          { label: 'Снег без стоимости', value: withoutCost },
        ]
      : []),
    { label: 'Стоимость', value: cost },
  ];
}
