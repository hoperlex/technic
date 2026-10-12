import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { SERVICE_COUNTERPARTY, serviceOperator, serviceRequest } from './factories/service';
import { ServiceCompleteModal } from '../src/features/service-complete/ui/ServiceCompleteModal';

/**
 * A refused close-works click names the field, not a toast (ADR 0094, Q7).
 *
 * The window used to answer every fault with `message.warning` in the corner and mark nothing; it
 * was the last office-equipment window on the form-blockers allowlist for that reason. Now each
 * check is a rule of the field at fault: the reason stands under that field, every fault is raised
 * by one click, the wrapper gets the flash class, and nothing reaches the server.
 */

const ROUTE = 'PATCH /service-requests/:id/complete';

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
    warrantyMonths: null,
    warrantyUntil: null,
    warrantyUntilManual: false,
    ...over,
  };
}

function repair(over: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimateRevision: 1,
    estimateFormat: 'items',
    estimatedTotalAmount: 1800,
    items: [item({})],
    ...over,
  });
}

function renderComplete(request: ServiceRequestDto): HttpMock {
  const http = mockHttp({ [ROUTE]: () => json(request) });
  renderWithUser(<ServiceCompleteModal request={request} onClose={() => {}} />, {
    user: serviceOperator(),
  });
  return http;
}

/** The reason drawn by the `Form.Item` that holds the element, or `null` when it has none. */
function errorAt(element: Element): string | null {
  return (
    element.closest('.ant-form-item')?.querySelector('.ant-form-item-explain-error')?.textContent ??
    null
  );
}

const field = (label: string) => screen.getByLabelText(label);
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));
const toast = () => document.querySelector('.ant-message-notice');
const flashed = () => document.querySelector('.form-blockers--a, .form-blockers--b');

describe('close works: a refusal marks the field at fault', () => {
  it('an erased fact and a discount without a reason are both marked by one click', async () => {
    const http = renderComplete(repair());
    const fact = await screen.findByLabelText('Фактическое количество: Ролик подачи');

    fireEvent.change(fact, { target: { value: '' } });
    fireEvent.change(field('Скидка по акту'), { target: { value: '-100' } });
    close();

    await waitFor(() => expect(errorAt(fact)).toBe('Укажите фактическое количество: Ролик подачи'));
    expect(errorAt(field('Причина скидки'))).toBe('Укажите причину скидки: без неё её не примут');
    expect(flashed()).not.toBeNull();
    expect(toast()).toBeNull();
    expect(http.countOf(ROUTE)).toBe(0);
  });

  it('unchecking the row withdraws its mark, and the fixed window closes', async () => {
    const http = renderComplete(repair());
    const fact = await screen.findByLabelText('Фактическое количество: Ролик подачи');

    fireEvent.change(fact, { target: { value: '' } });
    close();
    await waitFor(() => expect(errorAt(fact)).not.toBeNull());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ролик подачи' }));
    await waitFor(() => expect(errorAt(fact)).toBeNull());

    close();
    await waitFor(() => expect(http.countOf(ROUTE)).toBe(1));
  });

  it('a total above the agreed estimate is named under the total line', async () => {
    // The agreed sum is lower than the rows: the net of R12 has no input, its holder is the line.
    const http = renderComplete(repair({ estimatedTotalAmount: 1500 }));
    const total = await screen.findByText('Итого по акту:');
    close();

    await waitFor(() =>
      expect(errorAt(total)).toBe(
        'Итог больше согласованной сметы — так закрыть нельзя, переоткройте смету',
      ),
    );
    expect(toast()).toBeNull();
    expect(http.countOf(ROUTE)).toBe(0);

    // The way out the text names in the window itself: the act discount brings the total down.
    fireEvent.change(field('Скидка по акту'), { target: { value: '-300' } });
    fireEvent.change(field('Причина скидки'), { target: { value: 'торг' } });
    await waitFor(() => expect(errorAt(total)).toBeNull());
    close();
    await waitFor(() => expect(http.countOf(ROUTE)).toBe(1));
  });

  it('a consumable line issued short without a reason is marked on its line', async () => {
    const http = renderComplete(
      serviceRequest({
        kind: 'consumable',
        status: 'in_work',
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
      }),
    );
    const issued = await screen.findByLabelText('Выдано: Тонер Ricoh 201');

    fireEvent.change(issued, { target: { value: '1' } });
    close();

    await waitFor(() =>
      expect(errorAt(field('Причина расхождения: Тонер Ricoh 201'))).toMatch(
        /^Тонер Ricoh 201: Объясните, почему выдали меньше/,
      ),
    );
    expect(toast()).toBeNull();
    expect(http.countOf(ROUTE)).toBe(0);
  });
});
