import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import type { ServiceRequestItemDto } from '@technic/contracts';
import { SERVICE_COUNTERPARTY, serviceRequest } from './factories/service';
import {
  completeBody,
  completeFormValues,
  completeIssue,
  completeMode,
  type CompleteFormValues,
} from '../src/features/service-complete/model/completeForm';
import { factIssue, type FactRow } from '../src/features/service-complete/model/fact';

/**
 * The close-works window's pure half: which mode a request closes in, what body a state makes and
 * which fault the window names first. The window itself is pinned by
 * `service-complete-body.test.tsx`; here the same mapping is checked without a render, including
 * inputs a click cannot easily reach (a performed row whose fact was erased, a positive discount).
 */

const DAY = dayjs('2026-10-05');

function item(over: Partial<ServiceRequestItemDto> = {}): ServiceRequestItemDto {
  return {
    id: 'sri-1',
    kind: 'part',
    name: 'Ролик подачи',
    quantity: 2,
    unitPrice: 900,
    amount: 1800,
    performed: null,
    actualQuantity: null,
    actualAmount: null,
    warrantyMonths: 6,
    warrantyUntil: null,
    warrantyUntilManual: false,
    ...over,
  };
}

const repair = serviceRequest({
  status: 'in_work',
  service: { ...SERVICE_COUNTERPARTY },
  estimateFormat: 'items',
  estimatedTotalAmount: 2100,
  items: [
    item(),
    item({ id: 'sri-2', name: 'Тормозная площадка', quantity: 1, unitPrice: 300, amount: 300 }),
  ],
  consumables: [],
});

function values(over: Partial<CompleteFormValues> = {}): CompleteFormValues {
  return { ...completeFormValues(repair, DAY), ...over };
}

const row = (over: Partial<FactRow>): FactRow => ({ ...values().rows[0]!, ...over });

describe('completeMode: one of four, by the contracts predicate and the revision format', () => {
  it('reads the money question from the kind and the contractor, not from the rows', () => {
    expect(completeMode(repair)).toBe('items');
    expect(completeMode({ ...repair, estimateFormat: 'document' })).toBe('document');
    // The own administrator keeps the contractor's rows, and they stay history (R6).
    expect(completeMode({ ...repair, service: null })).toBe('inHouse');
    expect(completeMode({ ...repair, kind: 'consumable', service: null })).toBe('consumable');
  });
});

describe('completeBody: the closing body for a form state', () => {
  it('sends the rows, the discount and trimmed words only in the items mode', () => {
    const body = completeBody(
      values({ adjustment: -150, adjustmentReason: '  торг  ', comment: '  готово  ' }),
      'items',
      7,
    );
    expect(JSON.stringify(body)).toBe(
      '{"completedOn":"2026-10-05","items":[' +
        '{"id":"sri-1","performed":true,"actualQuantity":2,"warrantyUntil":null},' +
        '{"id":"sri-2","performed":true,"actualQuantity":1,"warrantyUntil":null}' +
        '],"adjustmentAmount":-150,"adjustmentReason":"торг","comment":"готово","version":7}',
    );
  });

  it('drops the fact and the warranty of an unchecked row', () => {
    const state = values();
    state.rows = [{ ...state.rows[0]!, performed: false, warrantyUntil: '2027-01-31' }];
    expect(completeBody(state, 'items', 1).items).toEqual([
      { id: 'sri-1', performed: false, actualQuantity: null, warrantyUntil: null },
    ]);
  });

  it('keeps rows and the discount out of every other mode, and consumables out of all but one', () => {
    const state = values({ adjustment: -150, adjustmentReason: 'торг', comment: ' ок ' });
    for (const mode of ['document', 'inHouse'] as const) {
      expect(JSON.stringify(completeBody(state, mode, 1))).toBe(
        '{"completedOn":"2026-10-05","items":[],"adjustmentAmount":null,' +
          '"adjustmentReason":"","comment":"ок","version":1}',
      );
    }
    const lines = completeFormValues(
      {
        ...repair,
        kind: 'consumable',
        consumables: [
          {
            id: 'src-1',
            consumableId: 'oec-1',
            code: 'Д0000093569',
            name: 'Тонер Ricoh 201',
            color: null,
            requestedQuantity: 2,
            issuedQuantity: null,
            issueNote: '',
          },
        ],
      },
      DAY,
    ).lines;
    expect(JSON.stringify(completeBody({ ...state, lines }, 'consumable', 1))).toBe(
      '{"completedOn":"2026-10-05","items":[],"consumables":[' +
        '{"id":"src-1","issuedQuantity":2,"issueNote":""}' +
        '],"adjustmentAmount":null,"adjustmentReason":"","comment":"ок","version":1}',
    );
  });
});

describe('completeIssue: the first fault, top-down', () => {
  it('names rows before the discount and the discount before its reason', () => {
    const erased = values({ adjustment: 5 });
    erased.rows = [row({ actualQuantity: null })];
    expect(completeIssue(erased, 'items', 2100)).toBe(
      'Укажите фактическое количество: Ролик подачи',
    );
    expect(completeIssue(values({ adjustment: 5 }), 'items', 2100)).toBe(
      'Скидка по акту — отрицательная сумма',
    );
    expect(completeIssue(values({ adjustment: -5 }), 'items', 2100)).toBe(
      'Укажите причину скидки: без неё её не примут',
    );
  });

  it('nets a total above the agreed estimate, and only in the items mode', () => {
    expect(completeIssue(values(), 'items', 2000)).toBe(
      'Итог больше согласованной сметы — так закрыть нельзя, переоткройте смету',
    );
    expect(completeIssue(values(), 'document', 2000)).toBeNull();
    expect(completeIssue(values(), 'inHouse', 2000)).toBeNull();
  });

  it('keeps the composed check equal to the per-part checks it is made of', () => {
    const above = [row({ actualQuantity: 3 })];
    expect(factIssue(above, null, '', null)).toBe(
      'Факт больше согласованного (Ролик подачи) — это удорожание: переоткройте смету',
    );
    expect(factIssue([row({ performed: false, actualQuantity: null })], null, '', null)).toBeNull();
  });
});
