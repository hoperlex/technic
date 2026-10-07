import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@shared/api';
import { useOpenedRecord } from '@shared/lib';
import { apiError, json, mockHttp, type MockResponse } from './http';
import { renderWithUser } from './render';

/**
 * The card named in the address (`?open=<id>`) and a failed reread (stage 5 plan §4.5, wave 1).
 *
 * The hook used to close the card on any error of its query, a background one included: a 503 on
 * a reread with the card on screen took away the card and every window open inside it. Now only
 * "nothing to show" (the first read failed) or "the record is gone" (404) closes it.
 */

interface Note {
  id: string;
  title: string;
}

function Card() {
  const opened = useOpenedRecord<Note>({
    active: true,
    queryKey: (id) => ['opened-record-probe', id],
    fetch: (id) => apiFetch<Note>(`/notes/${id}`),
  });
  return (
    <div data-testid="card" data-id={opened.id ?? ''}>
      {opened.record?.title ?? 'нет карточки'}
    </div>
  );
}

function renderCard(first: MockResponse) {
  let answer = first;
  const http = mockHttp({ 'GET /notes/:id': () => answer });
  const { queryClient } = renderWithUser(<Card />, { route: '/notes?open=n-1' });
  return {
    queryClient,
    answer: (next: MockResponse) => (answer = next),
    reread: async () => {
      const before = http.countOf('GET /notes/:id');
      await act(() => queryClient.invalidateQueries({ queryKey: ['opened-record-probe'] }));
      await waitFor(() => expect(http.countOf('GET /notes/:id')).toBeGreaterThan(before));
      // Sent is not answered: the assertions are about what the answer did, effects included.
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      await act(async () => {});
    },
  };
}

const card = () => screen.getByTestId('card');

describe('useOpenedRecord closes the card only when there is nothing to show', () => {
  it('a background 503 keeps the card open with the data it has', async () => {
    const { answer, reread, queryClient } = renderCard(json({ id: 'n-1', title: 'Заявка 14' }));
    await waitFor(() => expect(card().textContent).toBe('Заявка 14'));

    answer(apiError(503, { code: 'service_unavailable', message: 'Сервер недоступен' }));
    await reread();
    await waitFor(() =>
      expect(queryClient.getQueryState(['opened-record-probe', 'n-1'])?.status).toBe('error'),
    );
    await act(async () => {});

    expect(card().textContent).toBe('Заявка 14');
    expect(card().getAttribute('data-id')).toBe('n-1');
    expect(screen.queryByText('Запись не найдена')).toBeNull();
  });

  it('a 404 on a reread closes the card: the record is gone', async () => {
    const { answer, reread } = renderCard(json({ id: 'n-1', title: 'Заявка 14' }));
    await waitFor(() => expect(card().textContent).toBe('Заявка 14'));

    answer(apiError(404, { code: 'not_found', message: 'Не найдено' }));
    await reread();

    await waitFor(() => expect(card().getAttribute('data-id')).toBe(''));
    expect(await screen.findByText('Запись не найдена')).toBeDefined();
  });

  it('a first read that failed closes the card: there is nothing to show', async () => {
    renderCard(apiError(503, { code: 'service_unavailable', message: 'Сервер недоступен' }));

    await waitFor(() => expect(card().getAttribute('data-id')).toBe(''));
    expect(card().textContent).toBe('нет карточки');
  });
});
