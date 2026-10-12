import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { SERVICE_COUNTERPARTY, serviceExecutor, serviceRequest } from './factories/service';
import { EstimateEditorModal } from '../src/features/estimate-editor';

/**
 * A refused press of the scope-of-work window names the field, not a toast (ADR 0094, Q10).
 *
 * The window used to answer every gap with `message.warning` in the corner and mark nothing, and
 * it stood on the form-blockers allowlist for that reason. Now each check is a rule of the field at
 * fault: the reason stands under that field, every gap is raised by one press, the body gets the
 * flash class, and nothing reaches the server. The bodies themselves are pinned by
 * `service-estimate-body.test.tsx`.
 */

const SAVE = 'PUT /service-requests/:id/estimate';
const SUBMIT = 'PATCH /service-requests/:id/estimate/submit';
const BREAKDOWN = 'PUT /service-requests/:id/estimate/breakdown';

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

function editable(items: ServiceRequestItemDto[] = []): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimatePendingRevision: null,
    items,
  });
}

function renderEditor(request: ServiceRequestDto, intent?: 'estimate' | 'breakdown'): HttpMock {
  const http = mockHttp({
    [SAVE]: () => json({ ...request, version: request.version + 1 }),
    [SUBMIT]: () => json({ ...request, version: request.version + 2, estimatePendingRevision: 1 }),
    [BREAKDOWN]: () => json({ ...request, version: request.version + 1 }),
  });
  renderWithUser(<EstimateEditorModal request={request} intent={intent} onClose={() => {}} />, {
    user: serviceExecutor(),
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

const flashed = () => document.querySelector('.form-blockers--a, .form-blockers--b');
const sent = (http: HttpMock) =>
  http.countOf(SAVE) + http.countOf(SUBMIT) + http.countOf(BREAKDOWN);

function mode(label: 'Одной строкой' | 'По графам'): void {
  const option = [...document.querySelectorAll<HTMLElement>('.ant-segmented-item')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!option) throw new Error(`no mode option «${label}»`);
  fireEvent.click(option);
}

describe('by columns: every gap of every row at once', () => {
  it('one press marks the name, the quantity and the price of two rows', async () => {
    const http = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить запчасть/ }));
    fireEvent.click(screen.getByRole('button', { name: /Добавить услугу/ }));
    fireEvent.change(screen.getByLabelText('Запчасть: наименование'), { target: { value: 'Р' } });
    fireEvent.change(screen.getAllByLabelText('Количество')[1]!, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Предъявить на согласование' }));

    await waitFor(() => expect(flashed()).not.toBeNull());
    const [partPrice, servicePrice] = screen.getAllByLabelText('Цена за единицу');
    // The reasons are drawn by the fields' explain blocks, a render after the refusal.
    await waitFor(() =>
      expect(errorAt(screen.getByLabelText('Запчасть: наименование'))).toBe(
        'У каждой строки должно быть наименование',
      ),
    );
    expect(errorAt(partPrice!)).toBe('Укажите цену в каждой строке');
    expect(errorAt(screen.getByLabelText('Услуга: наименование'))).toBe(
      'У каждой строки должно быть наименование',
    );
    expect(errorAt(screen.getAllByLabelText('Количество')[1]!)).toBe(
      'Количество в каждой строке больше нуля',
    );
    expect(errorAt(servicePrice!)).toBe('Укажите цену в каждой строке');
    // The quantity of the part is filled (one by default): no mark there.
    expect(errorAt(screen.getAllByLabelText('Количество')[0]!)).toBeNull();
    expect(sent(http)).toBe(0);
  });

  it('an edit clears the mark of its field, the others stay', async () => {
    renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить услугу/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Предъявить на согласование' }));
    await waitFor(() => expect(errorAt(screen.getByLabelText('Цена за единицу'))).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Цена за единицу'), { target: { value: '100' } });

    await waitFor(() => expect(errorAt(screen.getByLabelText('Цена за единицу'))).toBeNull());
    expect(errorAt(screen.getByLabelText('Услуга: наименование'))).toBe(
      'У каждой строки должно быть наименование',
    );
  });

  it('an empty list is marked under the groups', async () => {
    const http = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    await screen.findByText('Работы не заведены');

    fireEvent.click(screen.getByRole('button', { name: 'Предъявить на согласование' }));

    expect(
      await screen.findByText('Добавьте хотя бы одну строку', {
        selector: '.ant-form-item-explain-error',
      }),
    ).toBeDefined();
    expect(sent(http)).toBe(0);
  });

  it('a draft by columns is not held by the gaps: an unfinished set is lawful', async () => {
    const http = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить услугу/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));
    expect(flashed()).toBeNull();
  });

  it('the breakdown is held by the same rules', async () => {
    const http = renderEditor(editable([item()]), 'breakdown');
    await waitFor(() =>
      expect(screen.getByLabelText('Услуга: наименование')).toHaveProperty('value', item().name),
    );
    fireEvent.change(screen.getByLabelText('Услуга: наименование'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Разложить по графам' }));

    await waitFor(() => expect(flashed()).not.toBeNull());
    await waitFor(() =>
      expect(errorAt(screen.getByLabelText('Услуга: наименование'))).toBe(
        'У каждой строки должно быть наименование',
      ),
    );
    expect(sent(http)).toBe(0);
  });
});

describe('free mode', () => {
  it('both fields are marked at once, and a second press flashes again', async () => {
    const http = renderEditor(editable());
    await screen.findByText('Как набрать:');
    const submit = screen.getByRole('button', { name: 'Предъявить на согласование' });

    fireEvent.click(submit);
    await waitFor(() => expect(document.querySelector('.form-blockers--a')).not.toBeNull());
    await waitFor(() =>
      expect(errorAt(screen.getByLabelText('Описание объёма работ'))).toBe(
        'Опишите объём работ: что входит в заказ',
      ),
    );
    expect(errorAt(screen.getByLabelText('Стоимость заказа'))).toBe('Укажите стоимость заказа');

    // The flash class alternates: the same blockers on a second press must flash again.
    fireEvent.click(submit);
    await waitFor(() => expect(document.querySelector('.form-blockers--b')).not.toBeNull());
    expect(sent(http)).toBe(0);
  });

  it('the window has no form element: Enter in the price sends nothing', async () => {
    const http = renderEditor(editable());
    await screen.findByText('Как набрать:');
    fireEvent.change(screen.getByLabelText('Описание объёма работ'), {
      target: { value: 'Чистка' },
    });
    fireEvent.change(screen.getByLabelText('Стоимость заказа'), { target: { value: '500' } });

    fireEvent.keyDown(screen.getByLabelText('Стоимость заказа'), { key: 'Enter', code: 'Enter' });

    expect(document.querySelector('.ant-modal form')).toBeNull();
    expect(sent(http)).toBe(0);
  });
});
