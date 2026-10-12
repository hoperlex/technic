import type { FormRule } from 'antd';
import { consumableFactIssue, type ConsumableFactRow } from '@entities/service-request';
import {
  factAdjustmentIssue,
  factAdjustmentReasonIssue,
  factRowIssue,
  factTotalIssue,
  type FactRow,
} from './fact';

/*
 * Form rules of the close-works window: each one asks a check of `fact.ts` or of the consumables
 * model and only turns its answer into a verdict. No condition is written here — the same check
 * also names the first fault under the window (`completeIssue`), and a condition copied into a
 * rule would disagree with that line silently.
 *
 * A rule, not a `message.warning` (ADR 0094): the reason lands under the field at fault, the
 * window scrolls to it and flashes, and every fault is raised at once instead of one per click.
 */

const verdict = (issue: string | null): Promise<void> =>
  issue ? Promise.reject(new Error(issue)) : Promise.resolve();

/** The fact of one estimate row; the row is read whole, its agreed quantity included. */
export const factRowRule =
  (name: number): FormRule =>
  ({ getFieldValue }) => ({
    validator: () => verdict(factRowIssue(getFieldValue(['rows', name]) as FactRow)),
  });

export const adjustmentRule: FormRule = {
  validator: (_, value: number | null | undefined) => verdict(factAdjustmentIssue(value ?? null)),
};

export const adjustmentReasonRule: FormRule = ({ getFieldValue }) => ({
  validator: (_, value: string | undefined) =>
    verdict(
      factAdjustmentReasonIssue(
        (getFieldValue('adjustment') as number | null | undefined) ?? null,
        value ?? '',
      ),
    ),
});

/** The total against the agreed estimate; held by the total line, which has no input of its own. */
export const estimateCapRule =
  (estimatedTotal: number | null): FormRule =>
  ({ getFieldValue }) => ({
    validator: () =>
      verdict(
        factTotalIssue(
          getFieldValue('rows') as FactRow[],
          (getFieldValue('adjustment') as number | null | undefined) ?? null,
          estimatedTotal,
        ),
      ),
  });

/** One consumable line, by the contracts' discrepancy rule that the server and `CHECK` share. */
export const consumableLineRule: FormRule = {
  validator: (_, line: ConsumableFactRow) => verdict(consumableFactIssue([line])),
};
