import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  assignedServiceRequest,
  serviceExecutor,
  serviceInHouseExecutor,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import {
  serviceActionRow,
  serviceExecutorAssignment,
} from '../src/pages/service/serviceRequestRow';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { EstimateEditorModal } from '../src/features/estimate-editor';

/**
 * "Работы выполнены" (ADR 0208): the executor no longer composes service rows; the money step is a
 * document (an invoice or its screenshot), and the service-company operator continues straight to
 * the closing act. `service-estimate-document-mode.test.tsx` covers the happy path with automatic
 * approval; this suite covers every other branch of the same door.
 *
 * The menu label is a promise about the outcome, so it is computed by the same contract predicates
 * the server uses (`canDeclareExemption`, `evaluateExemption`). Wherever the exemption cannot apply,
 * the item must say "for approval" and open the `document` door, whose body carries no exemption.
 */

const DOCUMENT_FLAG = 'service_estimate_document_mode' as const;
const EXEMPTION_FLAG = 'service_estimate_exemption' as const;
const SUBMIT = 'PATCH /service-requests/:id/estimate/submit';

/** "In work" with the service company assigned and nothing pending: the money step is open. */
const IN_WORK = assignedServiceRequest({ status: 'in_work' });

/** A dispute resolved with "signature required": the exemption no longer applies (Р9). */
const SIGNATURE_REQUIRED = assignedServiceRequest({
  status: 'in_work',
  dispute: {
    revision: 1,
    state: 'resolved',
    reason: 'счёт вдвое выше сметы соседней заявки',
    openedBy: 'user-1',
    openedByName: 'Штабов С. И.',
    openedAt: '2026-09-11T08:00:00.000Z',
    outcome: 'require_signature',
    resolvedBy: 'user-1',
    resolvedByName: 'Штабов С. И.',
    resolvedAt: '2026-09-12T08:00:00.000Z',
  },
});

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

/** Put a file into the hidden `Upload` input, the way a person does it. */
function attach(name = 'Счёт № 412.pdf'): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

const submitBody = (http: HttpMock) => http.lastCall(SUBMIT)?.body as Record<string, unknown>;

/** The requests list with the service-module routes it asks for on the first render. */
function renderTab(user: AuthUser, request: ServiceRequestDto): HttpMock {
  const http = mockHttp({
    ...UPLOAD_ROUTES,
    'GET /service-requests': () => json(list([request])),
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /service-requests/:id': () => json(request),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    [SUBMIT]: () => json({ ...request, version: request.version + 1, estimatePendingRevision: 1 }),
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Labels of the row menu (the desktop list), read from the dropdown that opened last. */
async function rowMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  return await waitFor(() => {
    const menu = [...document.querySelectorAll<HTMLElement>('.ant-dropdown')]
      .filter((el) => !el.classList.contains('ant-dropdown-hidden'))
      .map((el) => el.querySelector<HTMLElement>('.ant-dropdown-menu'))
      .filter((el): el is HTMLElement => !!el)
      .at(-1);
    if (!menu) throw new Error('меню действий не открылось');
    return menu;
  });
}

const labelsOf = (menu: HTMLElement) =>
  [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map((el) => el.textContent);

/** The `work_done` door rendered directly: its menu entry is guarded by the actions-menu suite. */
function renderWorkDone(routes: RouteMap, onClose: () => void = () => {}): HttpMock {
  const user = serviceExecutor({ features: [DOCUMENT_FLAG, EXEMPTION_FLAG] });
  const http = mockHttp({ ...UPLOAD_ROUTES, ...routes });
  renderWithUser(
    <EstimateEditorModal
      request={IN_WORK}
      intent="work_done"
      actionRow={serviceActionRow(IN_WORK)}
      assignment={serviceExecutorAssignment(IN_WORK, user)}
      onClose={onClose}
    />,
    { user },
  );
  return http;
}

/** Submit the invoice through the "Работы выполнены" button. */
async function submitWorkDone(http: HttpMock) {
  attach();
  await screen.findByText('Счёт № 412.pdf');
  fireEvent.click(screen.getByRole('button', { name: 'Работы выполнены' }));
  await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
}

/** What the server answers when the declaration was accepted but the exemption did not apply. */
const submitted = (over: Partial<ServiceRequestDto>) =>
  serviceRequest({
    ...IN_WORK,
    version: IN_WORK.version + 1,
    estimateRevision: 2,
    estimateFormat: 'document',
    estimateSubmittedAt: '2026-09-24T10:00:00.000Z',
    files: [serviceRequestFile('invoice', { purpose: 'estimate_basis' })],
    ...over,
  });

describe('второй шаг «Работы выполнены»', () => {
  it.each<[string, Partial<ServiceRequestDto>]>([
    // Recorded as `observed`: no signature yet, the revision waits for a human.
    ['исход «наблюдение»', { approval: null, estimatePendingRevision: 2 }],
    // An automatic signature under an older revision says nothing about this one.
    [
      'автоподпись под прошлой ревизией',
      {
        approval: {
          revision: 1,
          by: null,
          byName: '',
          at: '2026-09-20T10:00:00.000Z',
          source: 'auto',
        },
        estimatePendingRevision: 2,
      },
    ],
  ])('%s — «Документ принят и передан на согласование.»', async (_n, over) => {
    const http = renderWorkDone({ [SUBMIT]: () => json(submitted(over)) });
    await submitWorkDone(http);

    expect(await screen.findByText('Документ принят и передан на согласование.')).toBeDefined();
    expect(screen.queryByText('Документ принят, согласование выполнено автоматически.')).toBeNull();
  });

  it('отказ отправки оставляет окно на документе и показывает причину', async () => {
    const http = renderWorkDone({
      [SUBMIT]: () =>
        apiError(422, { code: 'VALIDATION_ERROR', message: 'Подача документом выключена' }),
    });
    await submitWorkDone(http);

    expect(await screen.findByText('Подача документом выключена')).toBeDefined();
    // Still the document step: its submit button is here and usable again, the act upload is not.
    // The name is matched by its end: jsdom never finishes antd's leave motion, so the spinner's
    // "loading" label stays in the button after the request has settled.
    const again = screen.getByRole('button', { name: /Работы выполнены$/ }) as HTMLButtonElement;
    await waitFor(() => expect(again.classList.contains('ant-btn-loading')).toBe(false));
    expect(again.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Подшить документ/ })).toBeNull();
    expect(screen.queryByText(/^Документ принят/)).toBeNull();
  });

  it('предлагает подшить только акт, а «Готово» закрывает окно без закрытия работ', async () => {
    const onClose = vi.fn();
    const http = renderWorkDone({ [SUBMIT]: () => json(submitted({ approval: null })) }, onClose);
    await submitWorkDone(http);
    await screen.findByRole('button', { name: /Подшить документ/ });

    const kind = document.querySelector('.ant-modal .ant-select') as HTMLElement;
    fireEvent.mouseDown(kind.querySelector('.ant-select-selector') ?? kind);
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-select-item-option')];
      if (found.length === 0) throw new Error('список видов не открылся');
      return found;
    });
    expect(options.map((o) => o.textContent)).toEqual(['Акт']);

    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing the work is a separate action ("Закрыть работы"); there is no atomic submit+close.
    expect(
      http.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    ).toEqual([
      'POST /files/upload-session',
      'PUT /put/file-invoice',
      'POST /files/file-invoice/complete',
      'PATCH /service-requests/sr-1/estimate/submit',
    ]);
  });
});

describe('пункт денежного шага называет исход, который посчитает сервер', () => {
  it.each<[string, AuthUser, ServiceRequestDto]>([
    // A named in-house executor may not declare the exemption at all (`canDeclareExemption`).
    [
      'поимённому своему исполнителю',
      serviceInHouseExecutor({ features: [DOCUMENT_FLAG] }),
      IN_WORK,
    ],
    // The declaration would be recorded as `observed`: the signature is still collected.
    ['при выключенном ключе освобождения', serviceExecutor({ features: [DOCUMENT_FLAG] }), IN_WORK],
    // A resolved dispute is stronger than the new door (`evaluateExemption`, second input).
    [
      'после спора с исходом «нужна подпись»',
      serviceExecutor({ features: [DOCUMENT_FLAG, EXEMPTION_FLAG] }),
      SIGNATURE_REQUIRED,
    ],
  ])(
    '%s — «Передать документ на согласование», и тело без заявления',
    async (_n, user, request) => {
      const http = renderTab(user, request);
      await screen.findByText('СО-14');
      const menu = await rowMenu();

      expect(labelsOf(menu)).toContain('Передать документ на согласование');
      expect(labelsOf(menu)).not.toContain('Работы выполнены');
      fireEvent.click(within(menu).getByText('Передать документ на согласование'));

      // The `document` door: no rows, no exemption notice, its own submit label.
      expect(await screen.findByText('Документы выполненных работ СО-14')).toBeDefined();
      expect(screen.queryByText(/применит автосогласование/)).toBeNull();
      attach();
      await screen.findByText('Счёт № 412.pdf');
      fireEvent.click(screen.getByRole('button', { name: 'Передать документ на согласование' }));

      await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
      expect(submitBody(http)).toEqual({
        mode: 'document',
        fileIds: ['file-invoice'],
        comment: '',
        version: request.version,
      });
    },
  );

  it('без ключа подачи документом у исполнителя денежного шага нет вовсе', async () => {
    // The server rejects a document body with 422 while the key is off, and the row editor is no
    // longer the executor's door (ADR 0208): an item here could only lead into a refusal.
    renderTab(serviceExecutor({ features: [EXEMPTION_FLAG] }), IN_WORK);
    await screen.findByText('СО-14');
    const labels = labelsOf(await rowMenu());

    // The anchor proves the menu opened: an empty list would pass every "not contain" below.
    expect(labels).toContain('Обсуждение');
    for (const money of ['Работы выполнены', 'Передать документ на согласование', 'Объём работ']) {
      expect(labels).not.toContain(money);
    }
  });
});
