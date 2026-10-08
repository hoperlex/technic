import { useState } from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from './render';
import { listQueryOptions } from '../src/shared/api';
import { DataTable } from '../src/shared/ui';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

interface Row {
  id: string;
  name: string;
}
interface Page {
  items: Row[];
  total: number;
}

afterEach(() => setViewport(DESKTOP_VIEWPORT));

describe('server list placeholder', () => {
  it('keeps rows and pagination during a page request, then replaces them with the answer', async () => {
    let answerSecond: (page: Page) => void = () => {};
    const second = new Promise<Page>((resolve) => {
      answerSecond = resolve;
    });
    const fetchPage = vi.fn((page: number) =>
      page === 1
        ? Promise.resolve({ items: [{ id: 'first', name: 'Первая страница' }], total: 75 })
        : second,
    );
    const client = createTestQueryClient();

    function List() {
      const [page, setPage] = useState(1);
      const result = useQuery(
        listQueryOptions({
          queryKey: ['test-list', page],
          queryFn: () => fetchPage(page),
        }),
      );
      return (
        <>
          <button onClick={() => setPage(2)}>Следующая</button>
          <DataTable<Row>
            columns={[{ key: 'name', title: 'Название', dataIndex: 'name' }]}
            data={result.data?.items ?? []}
            total={result.data?.total ?? 0}
            loading={result.isFetching}
            isPlaceholderData={result.isPlaceholderData}
            page={page}
            pageSize={50}
            onChange={() => {}}
          />
        </>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <List />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Первая страница')).toBeDefined();

    fireEvent.click(screen.getByText('Следующая'));
    expect(screen.getByText('Первая страница')).toBeDefined();
    expect(screen.getByText('Всего: 75')).toBeDefined();
    expect(fetchPage).toHaveBeenCalledWith(2);

    await act(async () =>
      answerSecond({ items: [{ id: 'second', name: 'Вторая страница' }], total: 75 }),
    );
    await waitFor(() => expect(screen.getByText('Вторая страница')).toBeDefined());
    expect(screen.queryByText('Первая страница')).toBeNull();
  });

  it('does not use the previous page as data when the new query is disabled', async () => {
    const client = createTestQueryClient();
    const fetchPage = vi.fn(async (page: number) => ({
      items: [{ id: String(page), name: `Страница ${page}` }],
      total: 1,
    }));
    function List({ page, enabled }: { page: number; enabled: boolean }) {
      const result = useQuery(
        listQueryOptions({
          queryKey: ['disabled-list', page],
          queryFn: () => fetchPage(page),
          enabled,
        }),
      );
      return <div>{result.data?.items[0]?.name ?? 'Нет данных'}</div>;
    }

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <List page={1} enabled />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Страница 1')).toBeDefined();
    rerender(
      <QueryClientProvider client={client}>
        <List page={2} enabled={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Нет данных')).toBeDefined();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('dims retained mobile cards and returns to the top when the page changes', () => {
    setViewport(MOBILE_VIEWPORT);
    const data = [{ id: 'old', name: 'Старая строка' }];
    const table = (page: number, loading: boolean) => (
      <div className="mobile-page__body" style={{ overflow: 'auto', height: 100 }}>
        <DataTable<Row>
          columns={[{ key: 'name', title: 'Название', dataIndex: 'name' }]}
          card={{ title: (row) => row.name }}
          data={data}
          total={75}
          loading={loading}
          isPlaceholderData={loading}
          page={page}
          pageSize={50}
          onChange={() => {}}
        />
      </div>
    );
    const { container, rerender } = render(table(1, false));
    const body = container.querySelector<HTMLElement>('.mobile-page__body')!;
    body.scrollTop = 120;

    rerender(table(2, true));
    expect(body.scrollTop).toBe(0);
    expect(screen.getByText('Старая строка')).toBeDefined();
    expect(container.querySelector('.list-cards--loading')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Загрузка…');
  });
});
