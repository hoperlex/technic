import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { DirectoriesPage } from '../src/pages/directories';

/**
 * Switching a directories tab refreshes what it is about to show.
 *
 * A hidden `Tabs` pane is not unmounted, so on return it shows the cache gathered before the edits
 * made on its neighbour. Directories suffer from it more than other sections: they refer to each
 * other, and the server glues a neighbour's fields into the list — type and category names for
 * vehicles, the container volume the price is computed by for the price list. Before the refresh
 * existed, a type renamed on one tab kept its old name on another until the page was reloaded, not
 * for the ten seconds of `staleTime`.
 *
 * The check reads the cache mark rather than a re-render: the probe key has no observer, so the
 * mark is all an invalidation can do to it, and it is what makes the next mount refetch however
 * young the entry is. Without it the test client, which keeps the LIVE term
 * (`createTestQueryClient`), would show the entry from the cache like production does.
 */

/** Посторонний запрос в кэше: он и показывает, что обновление задевает не только свою вкладку. */
const OTHER_KEY = ['vehicles', {}];

describe('справочники: переключение вкладки обновляет данные', () => {
  it('переключение помечает кэш соседних вкладок устаревшим', async () => {
    mockHttp({
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      // Ответственных за объект выбирают из учёток — вкладка объектов спрашивает их сразу.
      'GET /users': () => json(emptyList()),
    });

    const { queryClient } = renderWithUser(<DirectoriesPage />, {
      user: authUser({ role: 'admin' }),
    });

    // Первая вкладка отрисована — остальные antd монтирует только при показе.
    expect(await screen.findByRole('tab', { name: 'Отделы' })).toBeDefined();

    queryClient.setQueryData(OTHER_KEY, { items: [], total: 0 });
    expect(queryClient.getQueryState(OTHER_KEY)?.isInvalidated).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Отделы' }));

    await waitFor(() => expect(queryClient.getQueryState(OTHER_KEY)?.isInvalidated).toBe(true));
  });
});
