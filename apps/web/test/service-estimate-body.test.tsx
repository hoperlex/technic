import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { SERVICE_COUNTERPARTY, serviceExecutor, serviceRequest } from './factories/service';
import {
  serviceActionRow,
  serviceExecutorAssignment,
} from '../src/pages/service/serviceRequestRow';
import { EstimateEditorModal } from '../src/features/estimate-editor';

/**
 * The scope-of-work window sends the same bytes for the same input, whatever holds its state.
 *
 * These cases were recorded against the window that kept its rows in `useState`, before it moved
 * onto an antd `Form` with `Form.List` (Q10). Every command of the window is recorded in the order
 * it left `fetch`, as the raw string: key order, a key left out (`exemption` without a declaration)
 * and trimmed text are all part of what the server receives, and a deep-equal on parsed JSON would
 * miss the first two. The order of the calls matters as much: the draft save goes before the
 * submission, and an unchanged composition is submitted without a save (ADR 0133, R9).
 *
 * The refusal cases assert silence on the network after the window has said why. Where the window
 * says it is not pinned here — the state-held window used a toast, the form marks the field — only
 * that a reason appeared and that nothing was sent.
 */

const DOCUMENT_FLAG = 'service_estimate_document_mode' as const;
const EXEMPTION_FLAG = 'service_estimate_exemption' as const;

/** The contractor's executor: the author of the scope of work and the one who may declare. */
const EXECUTOR: AuthUser = serviceExecutor({ features: [DOCUMENT_FLAG, EXEMPTION_FLAG] });

/** A letter from the contractor: several lines, surrounding spaces that the body trims. */
const LETTER = '  Ремонт МФУ (RICOH MP C 2011), 1 шт;\nУзел фотобарабана в сборе, 2 шт  ';
const LETTER_SENT = 'Ремонт МФУ (RICOH MP C 2011), 1 шт;\\nУзел фотобарабана в сборе, 2 шт';

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

/** "In work", the contractor assigned, nothing pending: the composition can be edited. */
function editable(
  items: ServiceRequestItemDto[] = [],
  over: Partial<ServiceRequestDto> = {},
): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimatePendingRevision: null,
    items,
    ...over,
  });
}

/** Storage answers for an upload: session → PUT to storage → confirmation (`filesApi`). */
const UPLOAD_ROUTES: RouteMap = {
  'POST /files/upload-session': () =>
    json({
      fileId: 'file-invoice',
      uploadUrl: 'https://storage.test/put/file-invoice',
      objectKey: 'service/file-invoice.pdf',
      expiresIn: 900,
    }),
  'POST /files/:id/complete': () =>
    json({
      id: 'file-invoice',
      filename: 'Счёт № 412.pdf',
      contentType: 'application/pdf',
      size: 2048,
      status: 'ready',
      createdAt: '2026-09-14T10:00:00.000Z',
    }),
};

const COMMAND = /\/service-requests\/[^/]+\/(estimate(?:\/[a-z]+)?)$/;

/**
 * Renders the window and records every command it sends as `METHOD route body`, in order.
 *
 * Wrapped after `mockHttp`: the mock parses the body, and the parsed copy no longer shows the key
 * order or an omitted key. `test/setup.ts` restores the real fetch after the test.
 */
function renderEditor(
  request: ServiceRequestDto,
  intent?: 'estimate' | 'breakdown' | 'document' | 'work_done',
): string[] {
  mockHttp({
    ...UPLOAD_ROUTES,
    'PUT /service-requests/:id/estimate': () => json({ ...request, version: request.version + 1 }),
    'PUT /service-requests/:id/estimate/breakdown': () =>
      json({ ...request, version: request.version + 1, estimatePendingRevision: 1 }),
    'PATCH /service-requests/:id/estimate/submit': ({ body }) =>
      json({
        ...request,
        version: (body as { version: number }).version + 1,
        estimatePendingRevision: 1,
      }),
  });
  const sent: string[] = [];
  const routed = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = COMMAND.exec(new URL(url, window.location.origin).pathname)?.[1];
    if (route && typeof init?.body === 'string') {
      sent.push(`${init.method} ${route} ${init.body}`);
    }
    return routed(input, init);
  }) as typeof globalThis.fetch;
  renderWithUser(
    <EstimateEditorModal
      request={request}
      intent={intent}
      actionRow={serviceActionRow(request)}
      assignment={serviceExecutorAssignment(request, EXECUTOR)}
      onClose={() => {}}
    />,
    { user: EXECUTOR },
  );
  return sent;
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const SUBMIT = 'Предъявить на согласование';
const DRAFT = 'Сохранить черновик';
const field = (label: string) => screen.getByLabelText(label);
/** The comment has no label of its own: its placeholder is what the person reads. */
const comment = (placeholder: string) => screen.getByPlaceholderText(placeholder);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

/** The `index`-th input with this label in screen order: the parts group first, then services. */
const cell = (label: string, index: number) => screen.getAllByLabelText(label)[index]!;

/** Mode switch item by its caption (`Segmented` renders a label around a radio). */
function mode(label: 'Одной строкой' | 'По графам'): void {
  const option = [...document.querySelectorAll<HTMLElement>('.ant-segmented-item')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!option) throw new Error(`no mode option «${label}»`);
  fireEvent.click(option);
}

/** Press a button and wait until the window has sent `count` commands in total. */
async function press(sent: string[], name: string, count: number): Promise<string[]> {
  fireEvent.click(button(name));
  await waitFor(() => expect(sent).toHaveLength(count));
  return sent;
}

/**
 * The reason a refusal gave after the press: a toast (the state-held window) or a field's error
 * (the form). The persistent line under the buttons does not count — it is there before any press.
 */
async function refused(reason: string): Promise<void> {
  await waitFor(() => {
    const said = [
      ...document.querySelectorAll('.ant-message-notice-title, .ant-form-item-explain-error'),
    ].map((el) => el.textContent);
    expect(said).toContain(reason);
  });
}

function attachInvoice(): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Счёт № 412.pdf', {
    type: 'application/pdf',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

const V = 3;

describe('free mode: one service row (ADR 0179, R1)', () => {
  it('a new estimate: the letter trimmed, quantity one, then the submission with its comment', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), LETTER);
    type(field('Стоимость заказа'), '70455');
    type(comment('Комментарий к объёму работ: что нашли при диагностике'), '  нашли износ  ');

    expect(await press(sent, SUBMIT, 2)).toEqual([
      `PUT estimate {"items":[{"kind":"service","name":"${LETTER_SENT}","quantity":1,"unitPrice":70455,"warrantyMonths":null}],"version":${V}}`,
      `PATCH estimate/submit {"mode":"items","comment":"нашли износ","version":${V + 1}}`,
    ]);
  });

  it('a draft sends the composition only', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), 'Чистка');
    type(field('Стоимость заказа'), '500.5');

    expect(await press(sent, DRAFT, 1)).toEqual([
      `PUT estimate {"items":[{"kind":"service","name":"Чистка","quantity":1,"unitPrice":500.5,"warrantyMonths":null}],"version":${V}}`,
    ]);
  });

  it('an existing one-line estimate with a new price is saved, then submitted', async () => {
    const sent = renderEditor(editable([item()]));
    await waitFor(() => expect(field('Стоимость заказа')).toHaveProperty('value', '1800'));
    type(field('Стоимость заказа'), '2100');

    expect(await press(sent, SUBMIT, 2)).toEqual([
      `PUT estimate {"items":[{"kind":"service","name":"Замена узла подачи","quantity":1,"unitPrice":2100,"warrantyMonths":null}],"version":${V}}`,
      `PATCH estimate/submit {"mode":"items","comment":"","version":${V + 1}}`,
    ]);
  });

  it('an unchanged composition is submitted without a save', async () => {
    const sent = renderEditor(editable([item()]));
    await waitFor(() => expect(field('Стоимость заказа')).toHaveProperty('value', '1800'));

    expect(await press(sent, SUBMIT, 1)).toEqual([
      `PATCH estimate/submit {"mode":"items","comment":"","version":${V}}`,
    ]);
  });

  it('both fields cleared: the draft sends an empty composition', async () => {
    const sent = renderEditor(editable([item()]));
    await waitFor(() => expect(field('Стоимость заказа')).toHaveProperty('value', '1800'));
    type(field('Описание объёма работ'), '');
    type(field('Стоимость заказа'), '');

    expect(await press(sent, DRAFT, 1)).toEqual([`PUT estimate {"items":[],"version":${V}}`]);
  });
});

describe('rows mode: the list order, not the group order', () => {
  it('a new estimate by columns keeps the rows in the order they were added', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить услугу/ }));
    fireEvent.click(button(/Добавить запчасть/));

    // On screen the part stands first (its group is above), in the list it is second.
    type(field('Услуга: наименование'), ' Замена ролика ');
    type(cell('Цена за единицу', 1), '1200');
    type(cell('Срок гарантии в месяцах', 1), '6');
    type(field('Запчасть: наименование'), 'Ролик захвата');
    type(cell('Количество', 0), '2');
    type(cell('Цена за единицу', 0), '450');

    expect(await press(sent, SUBMIT, 2)).toEqual([
      'PUT estimate {"items":[' +
        '{"kind":"service","name":"Замена ролика","quantity":1,"unitPrice":1200,"warrantyMonths":6},' +
        '{"kind":"part","name":"Ролик захвата","quantity":2,"unitPrice":450,"warrantyMonths":null}' +
        `],"version":${V}}`,
      `PATCH estimate/submit {"mode":"items","comment":"","version":${V + 1}}`,
    ]);
  });

  it('an edit: one row removed, one changed, one added at the end', async () => {
    const sent = renderEditor(
      editable([
        item({ id: 'sri-a', name: 'Диагностика', unitPrice: 800, amount: 800 }),
        item({
          id: 'sri-b',
          kind: 'part',
          name: 'Узел подачи',
          quantity: 2,
          unitPrice: 900,
          amount: 1800,
          warrantyMonths: 6,
        }),
        item({ id: 'sri-c', name: 'Установка', unitPrice: 500, amount: 500 }),
      ]),
    );
    await waitFor(() => expect(screen.getAllByLabelText('Услуга: наименование')).toHaveLength(2));

    // Screen order: part «Узел подачи», then services «Диагностика», «Установка».
    fireEvent.click(screen.getAllByRole('button', { name: 'Удалить строку' })[1]!);
    await waitFor(() => expect(screen.getAllByLabelText('Услуга: наименование')).toHaveLength(1));
    type(cell('Цена за единицу', 0), '950');
    type(cell('Срок гарантии в месяцах', 0), '');
    fireEvent.click(button(/Добавить услугу/));
    await waitFor(() => expect(screen.getAllByLabelText('Услуга: наименование')).toHaveLength(2));
    type(cell('Услуга: наименование', 1), 'Чистка');
    type(cell('Цена за единицу', 2), '300');

    expect(await press(sent, SUBMIT, 2)).toEqual([
      'PUT estimate {"items":[' +
        '{"kind":"part","name":"Узел подачи","quantity":2,"unitPrice":950,"warrantyMonths":null},' +
        '{"kind":"service","name":"Установка","quantity":1,"unitPrice":500,"warrantyMonths":null},' +
        '{"kind":"service","name":"Чистка","quantity":1,"unitPrice":300,"warrantyMonths":null}' +
        `],"version":${V}}`,
      `PATCH estimate/submit {"mode":"items","comment":"","version":${V + 1}}`,
    ]);
  });

  it('a draft keeps an unfinished row: no price goes as zero, a cleared quantity as one', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить запчасть/ }));
    type(field('Запчасть: наименование'), 'Р');
    type(field('Количество'), '');

    expect(await press(sent, DRAFT, 1)).toEqual([
      `PUT estimate {"items":[{"kind":"part","name":"Р","quantity":1,"unitPrice":0,"warrantyMonths":null}],"version":${V}}`,
    ]);
  });

  it('the free record carried into columns becomes a service row before the added part', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), 'Ремонт узла');
    type(field('Стоимость заказа'), '3000');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить запчасть/ }));
    type(field('Запчасть: наименование'), 'Шестерня');
    type(cell('Цена за единицу', 0), '150');

    expect(await press(sent, SUBMIT, 2)).toEqual([
      'PUT estimate {"items":[' +
        '{"kind":"service","name":"Ремонт узла","quantity":1,"unitPrice":3000,"warrantyMonths":null},' +
        '{"kind":"part","name":"Шестерня","quantity":1,"unitPrice":150,"warrantyMonths":null}' +
        `],"version":${V}}`,
      `PATCH estimate/submit {"mode":"items","comment":"","version":${V + 1}}`,
    ]);
  });

  it('a single service row folded back into one line goes with quantity one', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить услугу/ }));
    type(field('Услуга: наименование'), 'Заправка');
    type(field('Цена за единицу'), '700');
    type(field('Количество'), '');
    mode('Одной строкой');
    await waitFor(() => expect(field('Описание объёма работ')).toHaveProperty('value', 'Заправка'));

    expect(await press(sent, DRAFT, 1)).toEqual([
      `PUT estimate {"items":[{"kind":"service","name":"Заправка","quantity":1,"unitPrice":700,"warrantyMonths":null}],"version":${V}}`,
    ]);
  });
});

describe('the other doors', () => {
  it('the warranty repair goes by its own format with the comment', async () => {
    const sent = renderEditor(
      editable([], {
        warrantyClaim: {
          source: 'item',
          itemId: 'sri-0',
          itemName: 'Узел подачи',
          sourceRequestNum: 11,
        },
      }),
    );
    await screen.findByText('Как набрать:');
    type(comment('Комментарий к объёму работ: что нашли при диагностике'), ' по гарантии ');

    expect(await press(sent, 'Гарантийный ремонт без оплаты', 1)).toEqual([
      `PATCH estimate/submit {"mode":"warranty","comment":"по гарантии","version":${V}}`,
    ]);
  });

  it('the breakdown sends the whole composition even unchanged', async () => {
    const sent = renderEditor(editable([item()]), 'breakdown');
    await waitFor(() => expect(field('Услуга: наименование')).toHaveProperty('value', item().name));

    expect(await press(sent, 'Разложить по графам', 1)).toEqual([
      `PUT estimate/breakdown {"items":[{"kind":"service","name":"Замена узла подачи","quantity":1,"unitPrice":1800,"warrantyMonths":null}],"version":${V}}`,
    ]);
  });

  it('the breakdown with a part added', async () => {
    const sent = renderEditor(editable([item()]), 'breakdown');
    await waitFor(() => expect(field('Услуга: наименование')).toHaveProperty('value', item().name));
    fireEvent.click(button(/Добавить запчасть/));
    type(await screen.findByLabelText('Запчасть: наименование'), 'Тонер');
    type(cell('Количество', 0), '3');
    type(cell('Цена за единицу', 0), '0');

    expect(await press(sent, 'Разложить по графам', 1)).toEqual([
      'PUT estimate/breakdown {"items":[' +
        '{"kind":"service","name":"Замена узла подачи","quantity":1,"unitPrice":1800,"warrantyMonths":null},' +
        '{"kind":"part","name":"Тонер","quantity":3,"unitPrice":0,"warrantyMonths":null}' +
        `],"version":${V}}`,
    ]);
  });

  it('rows with the exemption declared and no note: an empty declaration rides along', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), 'Ремонт на месте');
    type(field('Стоимость заказа'), '1200');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Согласование не требуется' }));

    expect(await press(sent, SUBMIT, 2)).toEqual([
      `PUT estimate {"items":[{"kind":"service","name":"Ремонт на месте","quantity":1,"unitPrice":1200,"warrantyMonths":null}],"version":${V}}`,
      `PATCH estimate/submit {"mode":"items","exemption":{},"comment":"","version":${V + 1}}`,
    ]);
  });

  it('a declaration taken back drops its note: the body has no exemption at all', async () => {
    const sent = renderEditor(editable([item()]));
    await waitFor(() => expect(field('Стоимость заказа')).toHaveProperty('value', '1800'));
    const box = screen.getByRole('checkbox', { name: 'Согласование не требуется' });
    fireEvent.click(box);
    type(field('Пояснение к освобождению от подписи'), 'на месте');
    fireEvent.click(box);

    expect(await press(sent, SUBMIT, 1)).toEqual([
      `PATCH estimate/submit {"mode":"items","comment":"","version":${V}}`,
    ]);
  });

  it('the invoice with a noted declaration: pages, the note trimmed, no save before it', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), 'Спрятанный состав');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Подать прикреплением счёта' }));
    attachInvoice();
    await screen.findByText('Счёт № 412.pdf');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Согласование не требуется' }));
    type(field('Пояснение к освобождению от подписи'), '  мелкий ремонт  ');
    type(comment('Комментарий к объёму работ: что нашли при диагностике'), 'счёт приложен');

    expect(await press(sent, SUBMIT, 1)).toEqual([
      `PATCH estimate/submit {"mode":"document","fileIds":["file-invoice"],"exemption":{"note":"мелкий ремонт"},"comment":"счёт приложен","version":${V}}`,
    ]);
  });

  it('the direct document door keeps the human approval', async () => {
    const sent = renderEditor(editable(), 'document');
    attachInvoice();
    await screen.findByText('Счёт № 412.pdf');
    type(comment('Комментарий к выполненным работам'), ' готово ');

    expect(await press(sent, 'Передать документ на согласование', 1)).toEqual([
      `PATCH estimate/submit {"mode":"document","fileIds":["file-invoice"],"comment":"готово","version":${V}}`,
    ]);
  });

  it('«Работы выполнены» declares the exemption by itself', async () => {
    const sent = renderEditor(editable(), 'work_done');
    attachInvoice();
    await screen.findByText('Счёт № 412.pdf');

    expect(await press(sent, 'Работы выполнены', 1)).toEqual([
      `PATCH estimate/submit {"mode":"document","fileIds":["file-invoice"],"exemption":{},"comment":"","version":${V}}`,
    ]);
  });
});

describe('refusals send nothing', () => {
  it('free mode: a description without a price, neither submitted nor saved', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), 'Ремонт');

    fireEvent.click(button(SUBMIT));
    await refused('Укажите стоимость заказа');
    fireEvent.click(button(DRAFT));
    await refused('Укажите стоимость заказа');
    expect(sent).toEqual([]);
  });

  it('free mode: a zero price', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Описание объёма работ'), 'Ремонт');
    type(field('Стоимость заказа'), '0');

    fireEvent.click(button(SUBMIT));
    await refused(
      'Стоимость заказа больше нуля: работы без оплаты предъявляют кнопкой «Гарантийный ремонт без оплаты»',
    );
    expect(sent).toEqual([]);
  });

  it('free mode: a price without a description', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    type(field('Стоимость заказа'), '100');

    fireEvent.click(button(SUBMIT));
    await refused('Опишите объём работ: что входит в заказ');
    expect(sent).toEqual([]);
  });

  it('rows mode: an empty composition is not submitted', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    await screen.findByText('Работы не заведены');

    fireEvent.click(button(SUBMIT));
    await refused('Добавьте хотя бы одну строку');
    expect(sent).toEqual([]);
  });

  it('rows mode: a one-letter name, a cleared quantity, a missing price', async () => {
    const sent = renderEditor(editable());
    await screen.findByText('Как набрать:');
    mode('По графам');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить услугу/ }));
    type(field('Услуга: наименование'), 'Р');
    type(field('Цена за единицу'), '10');

    fireEvent.click(button(SUBMIT));
    await refused('У каждой строки должно быть наименование');

    type(field('Услуга: наименование'), 'Ремонт');
    type(field('Количество'), '');
    fireEvent.click(button(SUBMIT));
    await refused('Количество в каждой строке больше нуля');

    type(field('Количество'), '1');
    type(field('Цена за единицу'), '');
    fireEvent.click(button(SUBMIT));
    await refused('Укажите цену в каждой строке');
    expect(sent).toEqual([]);
  });

  it('the breakdown of an unfinished row', async () => {
    const sent = renderEditor(editable([item()]), 'breakdown');
    await waitFor(() => expect(field('Услуга: наименование')).toHaveProperty('value', item().name));
    fireEvent.click(button(/Добавить запчасть/));
    type(await screen.findByLabelText('Запчасть: наименование'), 'Тонер');

    fireEvent.click(button('Разложить по графам'));
    await refused('Укажите цену в каждой строке');
    expect(sent).toEqual([]);
  });

  it('the invoice without a page: the button is locked', async () => {
    const sent = renderEditor(editable(), 'document');
    const submit = button('Передать документ на согласование') as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(sent).toEqual([]);
  });
});
