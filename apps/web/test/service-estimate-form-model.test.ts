import { describe, expect, it } from 'vitest';
import type { ServiceRequestItemDto } from '@technic/contracts';
import {
  breakdownBody,
  documentSubmitBody,
  estimateFill,
  estimateNeedsSave,
  estimateSaveBody,
  itemsSubmitBody,
  switchedRows,
  warrantySubmitBody,
} from '../src/features/estimate-editor/model/estimateForm';
import {
  estimateDraftIssue,
  estimateIssue,
  FREE_PRICE_RULES,
  ROWS_LIST_RULES,
  ROW_NAME_RULES,
} from '../src/features/estimate-editor/model/estimateRules';
import type { EstimateRow } from '../src/features/estimate-editor/model/rows';

/**
 * The pure half of the scope-of-work window: what a fill puts into the form, what a mode switch
 * does to the rows, which body each command sends, and what the rules refuse. The bodies are
 * compared as JSON strings, because the key order and an absent `exemption` key are part of what
 * the server receives (the same bytes are pinned through the window by
 * `service-estimate-body.test.tsx`).
 */

function item(over: Partial<ServiceRequestItemDto> = {}): ServiceRequestItemDto {
  return {
    id: 'sri-1',
    kind: 'service',
    name: 'Замена узла подачи',
    quantity: 1,
    unitPrice: 1800,
    amount: 1800,
    performed: null,
    actualQuantity: null,
    actualAmount: null,
    warrantyMonths: null,
    warrantyUntil: null,
    warrantyUntilManual: false,
    ...over,
  };
}

function row(over: Partial<EstimateRow> = {}): EstimateRow {
  return {
    key: 'row-x',
    kind: 'service',
    name: 'Чистка',
    quantity: 1,
    unitPrice: 500,
    warrantyMonths: null,
    ...over,
  };
}

const strip = (rows: EstimateRow[]) => rows.map(({ key: _key, ...rest }) => rest);

describe('estimateFill', () => {
  it('an empty estimate opens as one empty free record', () => {
    const { mode, rows } = estimateFill([], false);
    expect(mode).toBe('free');
    expect(strip(rows)).toEqual([
      { kind: 'service', name: '', quantity: 1, unitPrice: null, warrantyMonths: null },
    ]);
  });

  it('a single fitting row opens free, several rows open by columns', () => {
    expect(estimateFill([item()], false).mode).toBe('free');
    expect(estimateFill([item(), item({ id: 'sri-2' })], false).mode).toBe('rows');
    expect(estimateFill([item({ unitPrice: 0, amount: 0 })], false).mode).toBe('rows');
  });

  it('the breakdown always opens by columns and keeps the rows as saved', () => {
    const { mode, rows } = estimateFill([item()], true);
    expect(mode).toBe('rows');
    expect(strip(rows)).toEqual([
      {
        kind: 'service',
        name: 'Замена узла подачи',
        quantity: 1,
        unitPrice: 1800,
        warrantyMonths: null,
      },
    ]);
    expect(estimateFill([], true)).toEqual({ mode: 'rows', rows: [] });
  });
});

describe('switchedRows', () => {
  it('into the free mode the single row becomes a service of quantity one without warranty', () => {
    const [free] = switchedRows([row({ quantity: null, warrantyMonths: 6 })], 'free');
    expect(free).toMatchObject({ kind: 'service', quantity: 1, warrantyMonths: null });
  });

  it('back to columns the untouched record is dropped, a typed one is kept', () => {
    expect(switchedRows([row({ name: '', unitPrice: null })], 'rows')).toEqual([]);
    expect(switchedRows([row({ name: '', unitPrice: 10 })], 'rows')).toHaveLength(1);
  });
});

describe('composition bodies', () => {
  it('the save trims names, substitutes one and zero, and drops the untouched free record', () => {
    const rows = [row({ name: '  Ролик ', quantity: null, unitPrice: null, kind: 'part' })];
    expect(JSON.stringify(estimateSaveBody(rows, 'rows', 7))).toBe(
      '{"items":[{"kind":"part","name":"Ролик","quantity":1,"unitPrice":0,"warrantyMonths":null}],"version":7}',
    );
    expect(estimateSaveBody([row({ name: ' ', unitPrice: null })], 'free', 7)).toEqual({
      items: [],
      version: 7,
    });
  });

  it('the breakdown sends the same composition to its own door', () => {
    expect(JSON.stringify(breakdownBody([row()], 'rows', 4))).toBe(
      '{"items":[{"kind":"service","name":"Чистка","quantity":1,"unitPrice":500,"warrantyMonths":null}],"version":4}',
    );
  });

  it('a save is needed only when the sent composition differs from the stored one', () => {
    const stored = [item({ name: 'Чистка', unitPrice: 500, amount: 500 })];
    expect(estimateNeedsSave([row({ name: ' Чистка ' })], 'free', stored)).toBe(false);
    expect(estimateNeedsSave([row({ unitPrice: 501 })], 'free', stored)).toBe(true);
    expect(estimateNeedsSave([row({ name: '', unitPrice: null })], 'free', [])).toBe(false);
    expect(estimateNeedsSave([], 'rows', stored)).toBe(true);
  });
});

describe('submission bodies', () => {
  it('rows: the declaration key is absent without one and goes before the comment with one', () => {
    expect(
      JSON.stringify(itemsSubmitBody({ exemption: undefined, comment: ' ok ', version: 2 })),
    ).toBe('{"mode":"items","comment":"ok","version":2}');
    expect(JSON.stringify(itemsSubmitBody({ exemption: {}, comment: '', version: 2 }))).toBe(
      '{"mode":"items","exemption":{},"comment":"","version":2}',
    );
  });

  it('warranty: the format and the comment only', () => {
    expect(JSON.stringify(warrantySubmitBody({ comment: ' гарантия ', version: 3 }))).toBe(
      '{"mode":"warranty","comment":"гарантия","version":3}',
    );
  });

  it('document: pages, then the declaration, then the comment', () => {
    expect(
      JSON.stringify(
        documentSubmitBody({
          fileIds: ['f-1', 'f-2'],
          exemption: { note: 'на месте' },
          comment: '',
          version: 5,
        }),
      ),
    ).toBe(
      '{"mode":"document","fileIds":["f-1","f-2"],"exemption":{"note":"на месте"},"comment":"","version":5}',
    );
  });
});

describe('estimate rules', () => {
  it('free mode asks the description first, then the price, and refuses zero', () => {
    expect(estimateIssue([row({ name: 'Р', unitPrice: null })], 'free')).toBe(
      'Опишите объём работ: что входит в заказ',
    );
    expect(estimateIssue([row({ unitPrice: null })], 'free')).toBe('Укажите стоимость заказа');
    expect(estimateIssue([row({ unitPrice: 0 })], 'free')).toMatch(/^Стоимость заказа больше нуля/);
    expect(estimateIssue([], 'free')).toBe('Опишите объём работ: что входит в заказ');
    expect(estimateIssue([row()], 'free')).toBeNull();
  });

  it('by columns: an empty list, then per row the name, the quantity, the price', () => {
    expect(estimateIssue([], 'rows')).toBe('Добавьте хотя бы одну строку');
    expect(estimateIssue([row(), row({ name: ' Р ' })], 'rows')).toBe(
      'У каждой строки должно быть наименование',
    );
    expect(estimateIssue([row({ quantity: null })], 'rows')).toBe(
      'Количество в каждой строке больше нуля',
    );
    expect(estimateIssue([row({ unitPrice: null })], 'rows')).toBe('Укажите цену в каждой строке');
    // Zero stays lawful by columns: it is visible in its column at a concrete row.
    expect(estimateIssue([row({ unitPrice: 0 })], 'rows')).toBeNull();
  });

  it('a draft refuses only a started free record', () => {
    expect(estimateDraftIssue([row({ name: '', unitPrice: null })], 'free')).toBeNull();
    expect(estimateDraftIssue([row({ unitPrice: null })], 'free')).toBe('Укажите стоимость заказа');
    expect(
      estimateDraftIssue([row({ name: '', unitPrice: null, quantity: null })], 'rows'),
    ).toBeNull();
  });

  it('the form rules reject with the same words', async () => {
    type Validator = (rule: unknown, value: unknown) => Promise<void>;
    const run = (rules: readonly unknown[], value: unknown) =>
      (rules[0] as { validator: Validator }).validator({}, value);
    await expect(run(FREE_PRICE_RULES, null)).rejects.toThrow('Укажите стоимость заказа');
    await expect(run(FREE_PRICE_RULES, 10)).resolves.toBeUndefined();
    await expect(run(ROW_NAME_RULES, 'Р')).rejects.toThrow(
      'У каждой строки должно быть наименование',
    );
    await expect(run(ROWS_LIST_RULES, [])).rejects.toThrow('Добавьте хотя бы одну строку');
    await expect(run(ROWS_LIST_RULES, [row()])).resolves.toBeUndefined();
  });
});
