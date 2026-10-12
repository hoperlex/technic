import type { Dayjs } from 'dayjs';
import {
  serviceRequestNeedsEstimate,
  type CompleteServiceRequestInput,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  consumableFactIssue,
  consumableFactPayload,
  consumableFactRows,
  type ConsumableFactRow,
} from '@entities/service-request';
import { factIssue, factRowsFrom, factToPayload, type FactRow } from './fact';

const DATE = 'YYYY-MM-DD';

/**
 * What the window closes, one of four, and exactly one.
 *
 * - `items` — a contractor repair with a row-by-row revision: fact per row, act discount, total;
 * - `document` — the same repair whose revision was submitted as an invoice (R8 of
 *   `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, ADR 0183 decision 2): no rows to
 *   mark, no discount, and a sum nobody knows yet;
 * - `inHouse` — the company's own administrator (R6 of
 *   `office-equipment-card-and-list-cleanup-plan.md`): a date and optional words, no money;
 * - `consumable` — what was issued from the warehouse (R3, §6.2), no estimate at all.
 *
 * The money question is asked through the contracts' `serviceRequestNeedsEstimate` (R4) — the same
 * function the server's closing branch asks — and NOT through "does the request have rows". A
 * request handed over from a contractor to the own administrator keeps the contractor's rows; read
 * by rows, the historical estimate would turn into the fact and the cost of an in-house repair.
 *
 * `inHouse` is the negation of the other two subjects, not a condition of its own: consumables are
 * kept out of it because they have their own subject (what was issued), not because "there is no
 * money there either", so the third branch can never one day coincide with the first.
 *
 * `document` is read from the revision FORMAT, not from "zero rows": a row-format revision that
 * has not been filled yet is empty too, and explaining it with words about an invoice would lie.
 * The feature switch of the wave is NOT asked here: it decides whether such a revision may be
 * created, and one already created is a fact of the request that a switch must not turn back
 * into zeros on screen.
 */
export type CompleteMode = 'items' | 'document' | 'inHouse' | 'consumable';

export function completeMode(request: ServiceRequestDto): CompleteMode {
  if (request.kind === 'consumable') return 'consumable';
  // The DTO carries the company as an object, the predicate wants its id — the same translation
  // the actions menu does next to the closing-document bar.
  const priced = serviceRequestNeedsEstimate({
    kind: request.kind,
    serviceCounterpartyId: request.service?.id ?? null,
  });
  if (!priced) return 'inHouse';
  return request.estimateFormat === 'document' ? 'document' : 'items';
}

/**
 * The window's state, held by the antd form. Every mode keeps every key: the store is reset from
 * one shape whichever branch is on screen, so the body below never meets an absent value.
 */
export interface CompleteFormValues {
  completedOn: Dayjs;
  rows: FactRow[];
  lines: ConsumableFactRow[];
  adjustment: number | null;
  adjustmentReason: string;
  comment: string;
}

/**
 * The state a freshly opened window starts from. The consumable default "as much as was asked" is
 * set HERE, by the form (R3): the server does not write anything off the warehouse on the client's
 * silence and answers 422 «нет отметки о выдаче».
 */
export function completeFormValues(request: ServiceRequestDto, today: Dayjs): CompleteFormValues {
  return {
    completedOn: today,
    rows: factRowsFrom(request.items),
    lines: consumableFactRows(request.consumables),
    adjustment: null,
    adjustmentReason: '',
    comment: '',
  };
}

/**
 * The closing body. Pinned byte for byte by `test/service-complete-body.test.tsx`: the key order
 * and the `consumables` key left out (as `undefined`) for every mode but one are what the server
 * has always received.
 *
 * Estimate rows and consumable lines are the subject of one kind of request or the other, never
 * both: the server rejects an estimate on consumables and consumables on a repair.
 *
 * `items: []` outside the `items` mode is not "nothing to send" but the LAWFUL body (N8): the
 * schema field is required, and forbidding the field would make in-house closing impossible; the
 * server rejects only non-empty content. The rows of a historical estimate are left out on purpose
 * (R6): sent as fact, a past scope of work would become the cost of an in-house repair and give
 * warranties on items nobody fitted.
 */
export function completeBody(
  values: CompleteFormValues,
  mode: CompleteMode,
  version: number,
): CompleteServiceRequestInput {
  const counted = mode === 'items';
  return {
    completedOn: values.completedOn.format(DATE),
    items: counted ? factToPayload(values.rows) : [],
    consumables: mode === 'consumable' ? consumableFactPayload(values.lines) : undefined,
    adjustmentAmount: counted ? values.adjustment : null,
    adjustmentReason: counted ? values.adjustmentReason.trim() : '',
    comment: values.comment.trim(),
    version,
  };
}

/**
 * The first fault, for the line under the window. In-house and document closing have none: the
 * date is preset, the comment is optional, and rows and sums do not enter the body — checking them
 * would hold a person to a form they cannot see, and the "total above the agreed sum" net would
 * compare a computed zero with an unknown sum (R8).
 */
export function completeIssue(
  values: CompleteFormValues,
  mode: CompleteMode,
  estimatedTotal: number | null,
): string | null {
  if (mode === 'consumable') return consumableFactIssue(values.lines);
  if (mode === 'items') {
    return factIssue(values.rows, values.adjustment, values.adjustmentReason, estimatedTotal);
  }
  return null;
}
