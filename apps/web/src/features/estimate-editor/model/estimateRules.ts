import type { FormRule } from 'antd';
import { rowsForSave, type EstimateMode, type EstimateRow } from './rows';

/*
 * What the typed composition lacks, field by field. Each check answers for one field and is asked
 * twice: by the form rule of that field (the mark under it, ADR 0094) and by `estimateIssue` (the
 * line under the buttons). One function per field, so the mark and the line cannot disagree.
 *
 * The checks repeat the contracts' `serviceEstimateItemSchema`: a name of two characters or more,
 * a quantity above zero, a price not below zero. They stand here so the person learns about a gap
 * before sending, not from a 400 in reply.
 */

/** Free mode, the description: the list of works from the contractor's letter. */
export function freeNameIssue(name: string | undefined): string | null {
  return (name ?? '').trim().length < 2 ? 'Опишите объём работ: что входит в заказ' : null;
}

/**
 * Free mode, the price of the whole order: REQUIRED AND POSITIVE (customer answer V10 of
 * 09.09.2026; test wave defect D1). "Empty = 0" is cancelled, and zero is cancelled with it.
 *
 * WHY ZERO MEANS "NOT PRICED" HERE AND NOT "FREE". The free mode has exactly two fields, and the
 * second is the price of the WHOLE order, not of one item: the works and parts inside the
 * description are not broken down at all. "This whole list costs nothing" is not a deal but a gap —
 * a contractor who sends a list of units never writes "0" as its sum — and letting it through would
 * submit "free" under something nobody priced. By columns it is different: a zero stands at ONE row
 * among others, visible in its column and meaningful ("the part comes with the kit"), so there it
 * stays lawful.
 *
 * FREE WORK IS NOT FORBIDDEN BY THIS: it has its own door, "Гарантийный ремонт без оплаты", which
 * submits a zero sum as a service row assembled by the server (R27). That door needs an EMPTY
 * composition, so it never passes these checks, and "no money" is said there aloud by a button
 * rather than implied by an empty field.
 */
export function freePriceIssue(price: number | null | undefined): string | null {
  if (price == null) return 'Укажите стоимость заказа';
  if (price <= 0)
    return 'Стоимость заказа больше нуля: работы без оплаты предъявляют кнопкой «Гарантийный ремонт без оплаты»';
  return null;
}

export function rowNameIssue(name: string | undefined): string | null {
  return (name ?? '').trim().length < 2 ? 'У каждой строки должно быть наименование' : null;
}

export function rowQuantityIssue(quantity: number | null | undefined): string | null {
  return !quantity || quantity <= 0 ? 'Количество в каждой строке больше нуля' : null;
}

export function rowPriceIssue(price: number | null | undefined): string | null {
  return price == null || price < 0 ? 'Укажите цену в каждой строке' : null;
}

/** By columns with no row at all: the list itself is the field that lacks something. */
export function rowsListIssue(rows: readonly EstimateRow[]): string | null {
  return rows.length === 0 ? 'Добавьте хотя бы одну строку' : null;
}

/**
 * The first gap of the typed composition, for the line under the buttons.
 *
 * THE MODE IS ASKED EXPLICITLY, AND WITHOUT IT THE FUNCTION IS WRONG (plan
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, R1, finding N6). The free mode
 * shows neither a quantity nor a unit price: the portal supplies them. Asking for them there would
 * refuse on fields the person cannot see, so the free mode asks exactly what it shows — the
 * description and the price of the order. The parameter has no default on purpose: a silent "by
 * columns" would bring that defect back unnoticed.
 */
export function estimateIssue(rows: readonly EstimateRow[], mode: EstimateMode): string | null {
  if (mode === 'free') {
    const row = rows[0];
    return freeNameIssue(row?.name) ?? (row ? freePriceIssue(row.unitPrice) : null);
  }
  const empty = rowsListIssue(rows);
  if (empty) return empty;
  for (const row of rows) {
    const issue =
      rowNameIssue(row.name) ?? rowQuantityIssue(row.quantity) ?? rowPriceIssue(row.unitPrice);
    if (issue) return issue;
  }
  return null;
}

/** A field of the form as antd names it: `['rows', 0, 'unitPrice']`. */
export type EstimateFieldPath = (string | number)[];

/**
 * The fields a DRAFT validates (test wave defect D1): none by columns, and in free mode the two
 * fields of the record once typing has started.
 *
 * A draft is an unfinished composition, and saving one is its purpose — but in free mode
 * "unfinished" and "distorted" differ. The row leaves with the quantity and price the portal
 * supplies (`rowsToPayload`), so a description saved without a price lands in the database as
 * ZERO. Then the zero stops being a gap: the next opening brings it as a ready value, and the
 * submission goes with a zero sum — "empty = 0", cancelled by answer V10, would return in two
 * steps, the second one unnoticed. The refusal belongs to the first step.
 *
 * The untouched free record means "nothing typed yet": `rowsForSave` drops it, the composition
 * leaves empty, and that stays lawful. The requirement appears exactly when typing has started.
 *
 * By columns the rule is the old one: an empty price is visible in its column at a concrete row,
 * a saved zero is equally visible, and the person reads it as a value instead of getting it in
 * place of a gap. The free mode has nowhere to show the gap: both of its fields look filled.
 */
export function draftFieldsToCheck(
  rows: readonly EstimateRow[],
  mode: EstimateMode,
): EstimateFieldPath[] {
  if (mode !== 'free' || rowsForSave(rows, mode).length === 0) return [];
  return [
    ['rows', 0, 'name'],
    ['rows', 0, 'unitPrice'],
  ];
}

/** An antd rule from a field check: the check's words become the mark under the field. */
function checked<T>(check: (value: T) => string | null): FormRule[] {
  return [
    {
      validator: (_rule, value: T) => {
        const issue = check(value);
        return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
      },
    },
  ];
}

export const FREE_NAME_RULES = checked(freeNameIssue);
export const FREE_PRICE_RULES = checked(freePriceIssue);
export const ROW_NAME_RULES = checked(rowNameIssue);
export const ROW_QUANTITY_RULES = checked(rowQuantityIssue);
export const ROW_PRICE_RULES = checked(rowPriceIssue);
/** `Form.List` rules: the validator receives the whole list. */
export const ROWS_LIST_RULES = [
  {
    validator: (_rule: unknown, rows: readonly EstimateRow[] | undefined) => {
      const issue = rowsListIssue(rows ?? []);
      return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
    },
  },
];
