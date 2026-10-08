import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { DirectoriesPage } from '../src/pages/directories';
import { AdministrationPage } from '../src/pages/admin';

const OTHER_SECTION_KEY = ['vehicle-requests', 'list'];

/** A mounted badge stays active even when its value is not drawn inside either section. */
function watchSignal(queryClient: ReturnType<typeof renderWithUser>['queryClient']) {
  const fetchSignal = vi.fn(async () => 0);
  const observer = new QueryObserver(queryClient, {
    queryKey: ['stage5-test', 'signal'],
    queryFn: fetchSignal,
    meta: { profile: 'SIGNAL' },
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { fetchSignal, unsubscribe, key: ['stage5-test', 'signal'] };
}

function expectOtherSectionsUntouched(
  queryClient: ReturnType<typeof renderWithUser>['queryClient'],
) {
  expect(queryClient.getQueryState(OTHER_SECTION_KEY)?.isInvalidated).toBe(false);
}

describe('section tab switches refresh only open data', () => {
  it('directories refresh visited tabs within the R5 request limit, but not inactive cache or SIGNAL', async () => {
    const http = mockHttp({
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /users': () => json(emptyList()),
    });
    const { queryClient } = renderWithUser(<DirectoriesPage />, {
      user: authUser({ role: 'admin' }),
    });
    const signal = watchSignal(queryClient);
    try {
      queryClient.setQueryData(OTHER_SECTION_KEY, emptyList());
      await waitFor(() => expect(http.countOf('GET /objects')).toBeGreaterThan(0));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(signal.fetchSignal).toHaveBeenCalledTimes(1);

      const before = http.calls.length;
      fireEvent.click(screen.getByRole('tab', { name: 'Отделы' }));
      await waitFor(() => expect(http.countOf('GET /departments')).toBeGreaterThan(0));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(http.calls.length - before).toBeLessThanOrEqual(7);
      expectOtherSectionsUntouched(queryClient);
      expect(signal.fetchSignal).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryState(signal.key)?.isInvalidated).toBe(false);

      const backBefore = http.calls.length;
      const objectsBefore = http.countOf('GET /objects');
      fireEvent.click(screen.getByRole('tab', { name: 'Объекты' }));
      await waitFor(() => expect(http.countOf('GET /objects')).toBeGreaterThan(objectsBefore));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(http.calls.length - backBefore).toBeLessThanOrEqual(7);
      expectOtherSectionsUntouched(queryClient);
      expect(signal.fetchSignal).toHaveBeenCalledTimes(1);
    } finally {
      signal.unsubscribe();
    }
  });

  it('administration refreshes visited tabs within the R5 request limit, but not inactive cache or SIGNAL', async () => {
    const http = mockHttp({
      'GET /users': () => json(emptyList()),
      'GET /users/pending-count': () => json({ count: 0 }),
      'GET /objects': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
    });
    const { queryClient } = renderWithUser(<AdministrationPage />, {
      user: authUser({ role: 'admin' }),
    });
    const signal = watchSignal(queryClient);
    try {
      queryClient.setQueryData(OTHER_SECTION_KEY, emptyList());
      await waitFor(() => expect(http.countOf('GET /users')).toBeGreaterThan(0));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(signal.fetchSignal).toHaveBeenCalledTimes(1);

      const before = http.calls.length;
      const usersBefore = http.countOf('GET /users');
      fireEvent.click(screen.getByRole('tab', { name: 'Права' }));
      await waitFor(() => expect(http.countOf('GET /users')).toBeGreaterThan(usersBefore));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(http.calls.length - before).toBeLessThanOrEqual(9);
      expectOtherSectionsUntouched(queryClient);
      expect(signal.fetchSignal).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryState(signal.key)?.isInvalidated).toBe(false);

      const backBefore = http.calls.length;
      const usersBackBefore = http.countOf('GET /users');
      fireEvent.click(screen.getByRole('tab', { name: 'Пользователи' }));
      await waitFor(() => expect(http.countOf('GET /users')).toBeGreaterThan(usersBackBefore));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(http.calls.length - backBefore).toBeLessThanOrEqual(9);
      expectOtherSectionsUntouched(queryClient);
      expect(signal.fetchSignal).toHaveBeenCalledTimes(1);
    } finally {
      signal.unsubscribe();
    }
  });
});
