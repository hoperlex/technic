import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import type {
  ServiceRequestConsumableDto,
  ServiceRequestDto,
  ServiceRequestItemDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { SERVICE_COUNTERPARTY, serviceOperator, serviceRequest } from './factories/service';
import { ServiceCompleteModal } from '../src/features/service-complete/ui/ServiceCompleteModal';

/**
 * The close-works window sends the same bytes for the same input, whatever holds its state.
 *
 * These cases were recorded against the window that kept its rows in `useState`, before it moved
 * onto an antd `Form` with `Form.List` (Q7). The request body is compared as the raw string that
 * left `fetch`, not as a parsed object: key order, a dropped `consumables` key and trimmed text are
 * all part of what the server receives, and a deep-equal on parsed JSON would miss the first two.
 *
 * One case per mode of the window (ADR 0174, ADR 0183 decision 2), plus the edits that change the
 * body: an unchecked row, a changed fact, a warranty date typed in, a discount with its reason, and
 * a discount cleared after its reason was typed — the reason input is then disabled but keeps its
 * text, and today's window sends it (the server answers 422 «Причина без суммы…»).
 */

const ROUTE = 'PATCH /service-requests/:id/complete';
const TODAY = () => dayjs().format('YYYY-MM-DD');

function item(over: Partial<ServiceRequestItemDto>): ServiceRequestItemDto {
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

/** A contractor repair with an items-format revision: the window shows rows, discount and total. */
function itemsRequest(over: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimateRevision: 1,
    estimateFormat: 'items',
    estimatedTotalAmount: 2100,
    items: [
      item({}),
      item({
        id: 'sri-2',
        name: 'Тормозная площадка',
        quantity: 1,
        unitPrice: 300,
        amount: 300,
        performed: true,
        actualQuantity: 1,
        warrantyMonths: null,
        warrantyUntil: '2027-03-31',
      }),
    ],
    ...over,
  });
}

function consumableLine(over: Partial<ServiceRequestConsumableDto>): ServiceRequestConsumableDto {
  return {
    id: 'src-1',
    consumableId: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201',
    color: null,
    requestedQuantity: 2,
    issuedQuantity: null,
    issueNote: '',
    ...over,
  };
}

/** Renders the window and records every raw body sent to the close-works route. */
function renderComplete(request: ServiceRequestDto): string[] {
  mockHttp({ [ROUTE]: () => json(request) });
  const raw: string[] = [];
  const routed = globalThis.fetch;
  // Wrapped after `mockHttp`: the mock parses the body, and the parsed copy no longer shows the
  // key order or an omitted key. `test/setup.ts` restores the real fetch after the test.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === 'PATCH' && url.endsWith('/complete') && typeof init.body === 'string') {
      raw.push(init.body);
    }
    return routed(input, init);
  }) as typeof globalThis.fetch;
  renderWithUser(<ServiceCompleteModal request={request} onClose={() => {}} />, {
    user: serviceOperator(),
  });
  return raw;
}

async function submit(raw: string[]): Promise<string> {
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));
  await waitFor(() => expect(raw).toHaveLength(1));
  return raw[0]!;
}

/** A date is typed and confirmed with Enter: the calendar does not open by mouse in jsdom. */
function typeDate(input: HTMLElement, text: string): void {
  fireEvent.mouseDown(input);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('close-works body: contractor repair with rows', () => {
  it('defaults: every row performed with the agreed quantity, nothing else', async () => {
    const raw = renderComplete(itemsRequest());
    await screen.findByLabelText('Фактическое количество: Ролик подачи');

    expect(await submit(raw)).toBe(
      `{"completedOn":"${TODAY()}","items":[` +
        '{"id":"sri-1","performed":true,"actualQuantity":2,"warrantyUntil":null},' +
        '{"id":"sri-2","performed":true,"actualQuantity":1,"warrantyUntil":"2027-03-31"}' +
        '],"adjustmentAmount":null,"adjustmentReason":"","comment":"","version":3}',
    );
  });

  it('edits: date, unchecked row, fact, warranty, discount, reason and comment', async () => {
    const raw = renderComplete(itemsRequest());
    await screen.findByLabelText('Фактическое количество: Ролик подачи');

    typeDate(field('Дата выполнения'), '05.10.2026');
    // An unchecked row keeps its place but drops its fact and its warranty date from the body.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Тормозная площадка' }));
    fireEvent.change(field('Фактическое количество: Ролик подачи'), { target: { value: '1' } });
    typeDate(field('Гарантия до: Ролик подачи'), '15.04.2027');
    fireEvent.change(field('Скидка по акту'), { target: { value: '-150' } });
    fireEvent.change(field('Причина скидки'), { target: { value: '  торг  ' } });
    fireEvent.change(field('Комментарий'), { target: { value: '  заменили ролик  ' } });

    expect(await submit(raw)).toBe(
      '{"completedOn":"2026-10-05","items":[' +
        '{"id":"sri-1","performed":true,"actualQuantity":1,"warrantyUntil":"2027-04-15"},' +
        '{"id":"sri-2","performed":false,"actualQuantity":null,"warrantyUntil":null}' +
        '],"adjustmentAmount":-150,"adjustmentReason":"торг","comment":"заменили ролик","version":3}',
    );
  });

  it('a cleared discount leaves its typed reason in the body, as the state-held window did', async () => {
    const raw = renderComplete(itemsRequest());
    await screen.findByLabelText('Скидка по акту');

    fireEvent.change(field('Скидка по акту'), { target: { value: '-100' } });
    fireEvent.change(field('Причина скидки'), { target: { value: 'торг' } });
    fireEvent.change(field('Скидка по акту'), { target: { value: '' } });
    expect(field('Причина скидки').disabled).toBe(true);

    expect(await submit(raw)).toBe(
      `{"completedOn":"${TODAY()}","items":[` +
        '{"id":"sri-1","performed":true,"actualQuantity":2,"warrantyUntil":null},' +
        '{"id":"sri-2","performed":true,"actualQuantity":1,"warrantyUntil":"2027-03-31"}' +
        '],"adjustmentAmount":null,"adjustmentReason":"торг","comment":"","version":3}',
    );
  });
});

describe('close-works body: the other three modes', () => {
  it('consumables: the fact of every line, an untouched one included', async () => {
    const raw = renderComplete(
      serviceRequest({
        kind: 'consumable',
        status: 'in_work',
        consumables: [
          consumableLine({}),
          consumableLine({ id: 'src-2', requestedQuantity: 1, issuedQuantity: 1 }),
        ],
      }),
    );
    const issued = await screen.findAllByLabelText(/^Выдано: /);
    const notes = screen.getAllByLabelText(/^Причина расхождения: /);

    fireEvent.change(issued[0]!, { target: { value: '1' } });
    fireEvent.change(notes[0]!, { target: { value: '  на складе был один  ' } });

    expect(await submit(raw)).toBe(
      `{"completedOn":"${TODAY()}","items":[],"consumables":[` +
        '{"id":"src-1","issuedQuantity":1,"issueNote":"на складе был один"},' +
        '{"id":"src-2","issuedQuantity":1,"issueNote":""}' +
        '],"adjustmentAmount":null,"adjustmentReason":"","comment":"","version":3}',
    );
  });

  it('in-house repair: no rows even when a historical estimate has them', async () => {
    const raw = renderComplete(itemsRequest({ service: null }));
    fireEvent.change(await screen.findByLabelText('Что сделали'), {
      target: { value: '  заменили ролик подачи  ' },
    });

    expect(await submit(raw)).toBe(
      `{"completedOn":"${TODAY()}","items":[],"adjustmentAmount":null,` +
        '"adjustmentReason":"","comment":"заменили ролик подачи","version":3}',
    );
  });

  it('document-format revision: neither rows nor a discount', async () => {
    const raw = renderComplete(
      itemsRequest({ estimateFormat: 'document', estimatedTotalAmount: null, items: [] }),
    );
    await screen.findByText(/Отмечать нечего/);

    expect(await submit(raw)).toBe(
      `{"completedOn":"${TODAY()}","items":[],"adjustmentAmount":null,` +
        '"adjustmentReason":"","comment":"","version":3}',
    );
  });
});
