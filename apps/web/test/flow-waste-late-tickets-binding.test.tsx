import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WasteRequestDto } from '@technic/contracts';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto, wasteRequest, wasteSummary } from './factories/waste';
import { json, mockHttp, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { WasteRequestsPage } from '../src/pages/waste';

/**
 * Late tickets (ADR 0189) are uploaded in the request card and attached by a button. Both answers
 * — the upload and the attach — belong to the request the card showed when they were started
 * (snow-removal plan, §3.3): a file chosen for one request must not appear among the pending files
 * of the next, and a late attach must not swap the card back or reopen it.
 */

// Without the review right the card shows the plain ticket list: the review panel is not the
// subject here and would add its own reads.
const closer = authUser({
  permissions: authUser().permissions.filter((p) => p !== 'wasteRequests.ticketReview'),
});

const A = wasteRequest({ id: 'wr-a', num: 301, displayNumber: 'М-301', status: 'done' });
const B = wasteRequest({ id: 'wr-b', num: 302, displayNumber: 'М-302', status: 'done' });
const LATE = {
  id: 'f-late',
  filename: 'late.jpg',
  contentType: 'image/jpeg',
  size: 4,
  status: 'active',
  createdAt: '2026-12-02T10:00:00.000Z',
};

function setup(over: RouteMap) {
  const http = mockHttp({
    'GET /waste-requests': () => json(list<WasteRequestDto>([A, B])),
    'GET /waste-requests/summary': () => json(wasteSummary({ done: 2 })),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /waste-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([])),
    'GET /counterparties': () => json(list([])),
    'POST /files/upload-session': () =>
      json({
        fileId: 'f-late',
        uploadUrl: 'https://storage.test/put/f-late',
        objectKey: 'tickets/f-late.jpg',
        expiresIn: 900,
      }),
    'DELETE /files/:id': () => json({ ok: true }),
    ...over,
  });
  renderWithUser(<WasteRequestsPage />, { user: closer });
  return http;
}

async function openCard(displayNumber: string) {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(within(row as HTMLElement).getByLabelText('Открыть карточку'));
  await screen.findByText(`Заявка № ${displayNumber}`);
  // The card body is a lazy chunk: the ticket block appears after the title of its fallback.
  await waitFor(() => expect(screen.getAllByText('Добавить талон').length).toBeGreaterThan(0));
}

function closeCard() {
  const close = [...document.querySelectorAll('.ant-modal-footer button')]
    .filter((b) => b.textContent === 'Закрыть')
    .at(-1);
  fireEvent.click(close!);
}

function pickTicket() {
  const input = [...document.querySelectorAll<HTMLInputElement>('.ant-modal input[type=file]')].at(
    -1,
  )!;
  fireEvent.change(input, {
    target: { files: [new File(['scan'], 'late.jpg', { type: 'image/jpeg' })] },
  });
}

describe('догрузка талонов привязана к заявке, для которой начата', () => {
  it('загрузка, закончившаяся на другой заявке, удаляется и в её список не попадает', async () => {
    let finish!: (response: MockResponse) => void;
    const http = setup({
      'POST /files/:id/complete': () =>
        new Promise<MockResponse>((resolve) => {
          finish = resolve;
        }),
    });
    await openCard('М-301');
    pickTicket();
    await waitFor(() => expect(http.countOf('POST /files/:id/complete')).toBe(1));
    closeCard();
    await openCard('М-302');

    finish(json(LATE));
    await waitFor(() => expect(http.countOf('DELETE /files/:id')).toBe(1));
    expect(screen.queryByText('Ждут отправки')).toBeNull();
    expect(screen.queryByText(/Приложить к заявке/)).toBeNull();
  });

  it('поздний ответ приложения не возвращает карточку к прежней заявке', async () => {
    let attach!: (response: MockResponse) => void;
    const http = setup({
      'POST /files/:id/complete': () => json(LATE),
      'POST /waste-requests/:id/ticket-files': () =>
        new Promise<MockResponse>((resolve) => {
          attach = resolve;
        }),
    });
    await openCard('М-301');
    pickTicket();
    fireEvent.click(await screen.findByText('Приложить к заявке (1)'));
    await waitFor(() => expect(http.countOf('POST /waste-requests/:id/ticket-files')).toBe(1));
    expect(http.lastCall('POST /waste-requests/:id/ticket-files')!.path).toBe(
      '/waste-requests/wr-a/ticket-files',
    );
    closeCard();
    await openCard('М-302');

    attach(json({ ...A, tickets: [LATE], version: A.version + 1 }));
    await waitFor(() => expect(screen.getAllByText('Талон приложен').length).toBeGreaterThan(0));
    expect(screen.getByText('Заявка № М-302')).toBeDefined();
    expect(screen.queryByText('Заявка № М-301')).toBeNull();
  });
});
