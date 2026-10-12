import type {
  PutServiceEstimateBreakdownInput,
  PutServiceEstimateInput,
  ServiceEstimateExemptionDeclaration,
  ServiceRequestItemDto,
  SubmitServiceEstimateInput,
} from '@technic/contracts';
import {
  initialEstimateMode,
  rowsChanged,
  rowsForSave,
  rowsFromItems,
  rowsToPayload,
  toFreeRows,
  type EstimateMode,
  type EstimateRow,
} from './rows';

/**
 * The window's composition as the form holds it: the input mode, the rows and the comment.
 *
 * THE MODE IS AN INPUT MODE, NOT A KIND OF DOCUMENT (R1): both modes leave as the same rows, and
 * the database has no format mark at all. It lives next to the rows because a switch rewrites both
 * at once (`switchedRows`), and the dirtiness of the window is read from the two together.
 */
export interface EstimateFormValues {
  mode: EstimateMode;
  rows: EstimateRow[];
  comment: string;
}

/**
 * What a fill puts into the composition: the saved rows and the mode guessed from them (R8).
 *
 * THE BREAKDOWN ALWAYS OPENS BY COLUMNS, and that is its whole point: the coordinator pressed
 * "Break down by columns" precisely to unfold a one-line entry — and a one-line entry is exactly
 * what passes `fitsFreeMode`, so without this branch the window would open as two fields with
 * nothing to break down.
 */
export function estimateFill(
  items: readonly ServiceRequestItemDto[],
  breakdown: boolean,
): Pick<EstimateFormValues, 'mode' | 'rows'> {
  const initial = rowsFromItems(items);
  const mode = breakdown ? 'rows' : initialEstimateMode(initial);
  return { mode, rows: mode === 'free' ? toFreeRows(initial) : initial };
}

/**
 * The rows after a switch of the input mode (R8). Into the free mode the composition is BROUGHT
 * to its shape, not merely shown as two fields: the quantity and kind of the single row become
 * what the portal will send — otherwise the total would be counted from a cleared quantity and
 * show zero under a filled price.
 *
 * Back to columns there is nothing to bring — the description already lies as the name, the price
 * as the unit price — but the UNTOUCHED record is dropped: the free mode always keeps its row, and
 * without dropping it a person who looked into "Одной строкой" and came back would find an empty
 * service row they never added.
 */
export function switchedRows(rows: readonly EstimateRow[], next: EstimateMode): EstimateRow[] {
  return next === 'free' ? toFreeRows(rows) : rowsForSave(rows, 'free');
}

/**
 * `PUT /:id/estimate`: the composition whole. In free mode the untouched record is filtered out
 * (R8) — two empty fields mean "nothing typed yet", not a row of the estimate.
 */
export function estimateSaveBody(
  rows: readonly EstimateRow[],
  mode: EstimateMode,
  version: number,
): PutServiceEstimateInput {
  return { items: rowsToPayload(rowsForSave(rows, mode)), version };
}

/**
 * Whether the save goes before the submission. An unchanged composition is not rewritten: an extra
 * `PUT` would raise the request version and take it from whoever is looking at the card.
 */
export function estimateNeedsSave(
  rows: readonly EstimateRow[],
  mode: EstimateMode,
  items: readonly ServiceRequestItemDto[],
): boolean {
  return rowsChanged(rowsForSave(rows, mode), items);
}

/**
 * `PUT /:id/estimate/breakdown`: the composition whole and unconditionally — pressing "Разложить"
 * is the decision to reissue the document, and whether anything changed is the server's call.
 */
export function breakdownBody(
  rows: readonly EstimateRow[],
  mode: EstimateMode,
  version: number,
): PutServiceEstimateBreakdownInput {
  return { items: rowsToPayload(rowsForSave(rows, mode)), version };
}

interface SubmitParts {
  /** The declaration, or `undefined` when none is made: then the key is absent from the body. */
  exemption: ServiceEstimateExemptionDeclaration | undefined;
  comment: string;
  version: number;
}

/**
 * The submission of the saved rows. The format is the outer discriminator of the body (R2 of
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`) and is named directly.
 *
 * The exemption is lawful with rows too, and that is the main case of the review (R2): a small
 * repair on site is typed as rows and marked "no approval needed" at once. The requirement "an
 * exemption needs an invoice" was rejected by the customer on 11.09.2026.
 */
export function itemsSubmitBody({
  exemption,
  comment,
  version,
}: SubmitParts): SubmitServiceEstimateInput {
  return {
    mode: 'items',
    ...(exemption ? { exemption } : {}),
    comment: comment.trim(),
    version,
  };
}

/** The warranty repair (R27): its zero service row is assembled by the server, not sent. */
export function warrantySubmitBody({
  comment,
  version,
}: Omit<SubmitParts, 'exemption'>): SubmitServiceEstimateInput {
  return { mode: 'warranty', comment: comment.trim(), version };
}

/**
 * The submission by invoice (R2): pages of the document instead of rows, and NO SUM at all
 * (answer V5: "it comes from parsing the document") — a substituted zero would read as "the works
 * are free".
 */
export function documentSubmitBody({
  fileIds,
  exemption,
  comment,
  version,
}: SubmitParts & { fileIds: string[] }): SubmitServiceEstimateInput {
  return {
    mode: 'document',
    fileIds,
    ...(exemption ? { exemption } : {}),
    comment: comment.trim(),
    version,
  };
}
