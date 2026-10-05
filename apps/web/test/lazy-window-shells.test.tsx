import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import { ServiceChatModal } from '@features/service-chat';
import { TicketAuditModal } from '@features/ticket-audit';
import { apiError, json, mockHttp } from './http';
import { renderWithUser } from './render';
import { serviceRequest } from './factories/service';

const CHAT = 'GET /service-requests/:id/messages';
const READ = 'POST /service-requests/:id/messages/read';
const SUMMARY = 'GET /waste-requests/ticket-audit/summary';

async function finishClosing(dialog: HTMLElement) {
  // destroyOnHidden removes the portal after motion; jsdom needs the browser's end events.
  await waitFor(() => {
    fireEvent.animationEnd(dialog);
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
}

function ChatProbe() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Открыть обсуждение</button>
      <ServiceChatModal request={open ? serviceRequest() : null} onClose={() => setOpen(false)} />
    </>
  );
}

function AuditProbe({ initiallyAllowed = true }: { initiallyAllowed?: boolean }) {
  const [allowed, setAllowed] = useState(initiallyAllowed);
  const location = useLocation();
  return (
    <>
      <output data-testid="address">{location.search}</output>
      <button onClick={() => setAllowed(false)}>Отозвать право</button>
      <TicketAuditModal allowed={allowed} />
    </>
  );
}

describe('ленивое тело внутри синхронного окна', () => {
  it('закрывает холодный чат до кода без чтения ленты, затем открывает загруженный модуль', async () => {
    const http = mockHttp({
      [CHAT]: () => json({ items: [], hasMore: false, lastSeq: 0, readThroughSeq: 0 }),
      [READ]: () => json({ readThroughSeq: 0, lastSeq: 0 }),
    });
    renderWithUser(<ChatProbe />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(http.countOf(CHAT)).toBe(0);
    fireEvent.click(screen.getByText('Открыть обсуждение'));
    const pending = screen.getByRole('dialog');
    expect(within(pending).getByText('Обсуждение СО-14')).toBeDefined();
    fireEvent.click(within(pending).getByRole('button', { name: 'Закрыть' }));
    await act(() => vi.dynamicImportSettled());
    expect(http.countOf(CHAT)).toBe(0);
    expect(http.countOf(READ)).toBe(0);
    await finishClosing(pending);

    fireEvent.click(screen.getByText('Открыть обсуждение'));
    expect(await screen.findByText('По заявке СО-14 пока ничего не написано.')).toBeDefined();
    expect(http.countOf(CHAT)).toBe(1);
    expect(http.countOf(READ)).toBe(0);
  });

  it('отзыв права закрывает холодный аудит и чистит только его URL-ключи до загрузки отчёта', async () => {
    const http = mockHttp({
      [SUMMARY]: () => apiError(500, { code: 'error', message: 'Нет сети' }),
    });
    renderWithUser(<AuditProbe />, {
      route: '/waste?tab=history&objectId=obj-1&ticketAudit=1&from=2026-10-01&to=2026-10-05',
    });
    const pending = screen.getByRole('dialog');
    fireEvent.click(screen.getByText('Отозвать право'));
    await act(() => vi.dynamicImportSettled());
    expect(screen.getByTestId('address').textContent).toBe('?tab=history&objectId=obj-1');
    expect(http.countOf(SUMMARY)).toBe(0);
    await finishClosing(pending);
    expect(await screen.findByText('Аудит распознавания вам недоступен')).toBeDefined();
  });

  it('тёплый deep-link аудита передаёт прежний период и закрывается над прежней вкладкой', async () => {
    const http = mockHttp({
      [SUMMARY]: () => apiError(500, { code: 'error', message: 'Нет сети' }),
    });
    renderWithUser(<AuditProbe />, {
      route: '/waste?tab=history&ticketAudit=1&from=2026-10-01&to=2026-10-05',
    });
    await screen.findByText('Сводка');
    await waitFor(() => expect(http.countOf(SUMMARY)).toBe(1));
    expect(http.lastCall(SUMMARY)?.query.get('from')).toBe('2026-10-01');
    expect(http.lastCall(SUMMARY)?.query.get('to')).toBe('2026-10-05');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('?tab=history'));
  });
});
