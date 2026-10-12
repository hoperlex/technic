import type { CompleteServiceRequestInput, ServiceRequestItemDto } from '@technic/contracts';

/**
 * The closing fact of one estimate row (R12). Plan and fact are different figures: three rollers
 * were agreed, two were fitted, the brake pad was not needed at all. The row stays in the estimate
 * but does not count as performed — and gets no warranty.
 */
export interface FactRow {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  performed: boolean;
  /** Actual quantity; never above the agreed one — that would be a price rise (R12). */
  actualQuantity: number | null;
  /** Warranty date from the slip (`YYYY-MM-DD`); empty — the server counts it from the work date. */
  warrantyUntil: string | null;
  warrantyMonths: number | null;
}

/** The closing default is "done as agreed": the executor unchecks what was not needed. */
export function factRowsFrom(items: readonly ServiceRequestItemDto[]): FactRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    performed: item.performed ?? true,
    actualQuantity: item.actualQuantity ?? item.quantity,
    warrantyUntil: item.warrantyUntil,
    warrantyMonths: item.warrantyMonths,
  }));
}

/** The amount of what was performed: an unperformed row does not enter the total at all. */
export function factRowsAmount(rows: readonly FactRow[]): number {
  return rows.reduce(
    (sum, row) => (row.performed ? sum + (row.actualQuantity ?? 0) * row.unitPrice : sum),
    0,
  );
}

/**
 * The act total: what was performed plus the adjustment. It is computed on screen and **never
 * typed in** — otherwise the row sum and the total would drift apart silently, and the act would
 * be argued over a figure nobody checked. The server counts it the same way; here it is only shown.
 */
export function factTotal(rows: readonly FactRow[], adjustment: number | null): number {
  return factRowsAmount(rows) + (adjustment ?? 0);
}

/*
 * What stops the works from closing. The checks repeat the server's (`completeServiceRequestSchema`
 * and the R12 invariant) — not to replace them, but so the executor learns of a slip before the
 * click. Each check is its own function because two readers ask them: the form rules mark the one
 * field at fault, and `factIssue` names the first fault in the line under the window. Written
 * twice, the rule and the line would disagree on the first edit.
 */

/** One row: a performed row needs a positive fact no larger than the agreed quantity. */
export function factRowIssue(row: FactRow): string | null {
  if (!row.performed) return null;
  if (!row.actualQuantity || row.actualQuantity <= 0) {
    return `Укажите фактическое количество: ${row.name}`;
  }
  if (row.actualQuantity > row.quantity) {
    return `Факт больше согласованного (${row.name}) — это удорожание: переоткройте смету`;
  }
  return null;
}

/** The act discount is a strictly negative sum; zero is cut off by the schema (`negative`). */
export function factAdjustmentIssue(adjustment: number | null): string | null {
  return adjustment != null && adjustment >= 0 ? 'Скидка по акту — отрицательная сумма' : null;
}

/** A discount without a reason makes the total unexplainable: the server answers it with 422. */
export function factAdjustmentReasonIssue(
  adjustment: number | null,
  adjustmentReason: string,
): string | null {
  return adjustment != null && !adjustmentReason.trim()
    ? 'Укажите причину скидки: без неё её не примут'
    : null;
}

/**
 * A safety net for the invariant rather than a working check: closing has no way to raise a price
 * or a quantity, and if the total still came out above the agreed estimate, the screen shows the
 * error the server would reject with 422.
 */
export function factTotalIssue(
  rows: readonly FactRow[],
  adjustment: number | null,
  estimatedTotal: number | null,
): string | null {
  return estimatedTotal != null && factTotal(rows, adjustment) > estimatedTotal
    ? 'Итог больше согласованной сметы — так закрыть нельзя, переоткройте смету'
    : null;
}

/** The first fault, in the window's top-down order: rows, discount, reason, total. */
export function factIssue(
  rows: readonly FactRow[],
  adjustment: number | null,
  adjustmentReason: string,
  estimatedTotal: number | null,
): string | null {
  for (const row of rows) {
    const issue = factRowIssue(row);
    if (issue) return issue;
  }
  return (
    factAdjustmentIssue(adjustment) ??
    factAdjustmentReasonIssue(adjustment, adjustmentReason) ??
    factTotalIssue(rows, adjustment, estimatedTotal)
  );
}

/** The closing body's rows: per-row marks. No total here on purpose — the server counts it (R12). */
export function factToPayload(rows: readonly FactRow[]): CompleteServiceRequestInput['items'] {
  return rows.map((row) => ({
    id: row.id,
    performed: row.performed,
    // An unperformed row has no actual quantity: it was not delivered at all.
    actualQuantity: row.performed ? row.actualQuantity : null,
    warrantyUntil: row.performed ? row.warrantyUntil : null,
  }));
}
