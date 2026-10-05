import { lazy, useEffect, useState, type ComponentType } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSearchParams } from 'react-router';
import { AsyncTabs, PageTabs, TabsExtra, useActiveTabKey } from '@shared/ui';
import { createTestQueryClient, renderWithUser } from './render';

function deferredTab() {
  let resolve!: (module: { default: ComponentType }) => void;
  const promise = new Promise<{ default: ComponentType }>((done) => {
    resolve = done;
  });
  const load = vi.fn(() => promise);
  return {
    Tab: lazy(load),
    load,
    finish: (Tab: ComponentType) =>
      act(async () => {
        resolve({ default: Tab });
        await promise;
      }),
  };
}

describe('граница загрузки тела вкладки', () => {
  it('держит полосу при холодном входе и не запускает невидимую или ещё не открытую вкладку', async () => {
    const first = deferredTab();
    const next = deferredTab();
    const hidden = deferredTab();
    const allowed = false;
    renderWithUser(
      <AsyncTabs
        items={[
          { key: 'first', label: 'Первая', children: <first.Tab /> },
          { key: 'next', label: 'Следующая', children: <next.Tab /> },
          ...(allowed ? [{ key: 'hidden', label: 'Закрытая', children: <hidden.Tab /> }] : []),
        ]}
      />,
    );
    const strip = screen.getByRole('tablist');
    expect(first.load).toHaveBeenCalledTimes(1);
    expect(next.load).not.toHaveBeenCalled();
    expect(hidden.load).not.toHaveBeenCalled();
    expect(screen.queryByRole('tab', { name: 'Закрытая' })).toBeNull();
    await first.finish(() => <span>Первый экран</span>);
    expect(screen.getByText('Первый экран')).toBeDefined();
    expect(screen.getByRole('tablist')).toBe(strip);
    fireEvent.click(screen.getByRole('tab', { name: 'Следующая' }));
    expect(next.load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tablist')).toBe(strip);
    await next.finish(() => <span>Следующий экран</span>);
    expect(screen.getByText('Следующий экран')).toBeDefined();
    expect(hidden.load).not.toHaveBeenCalled();
  });

  it('повторное открытие сохраняет поле и экземпляр вкладки без повторного импорта', async () => {
    const first = deferredTab();
    const unmount = vi.fn();
    function FormTab() {
      const [value, setValue] = useState('');
      useEffect(
        () => () => {
          unmount();
        },
        [],
      );
      return (
        <input
          aria-label="Отбор"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    renderWithUser(
      <AsyncTabs
        items={[
          { key: 'first', label: 'Первая', children: <first.Tab /> },
          { key: 'next', label: 'Следующая', children: <span>Сосед</span> },
        ]}
      />,
    );
    await first.finish(FormTab);
    const field = screen.getByRole('textbox', { name: 'Отбор' });
    fireEvent.change(field, { target: { value: 'сохранённый фильтр' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Следующая' }));
    expect(unmount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Первая' }));
    expect(screen.getByRole('textbox', { name: 'Отбор' })).toBe(field);
    expect((field as HTMLInputElement).value).toBe('сохранённый фильтр');
    expect(first.load).toHaveBeenCalledTimes(1);
  });

  it('PageTabs сохраняет URL, корень обновления и единственный активный слот при lazy-переходе', async () => {
    const next = deferredTab();
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    function Body({ tabKey }: { tabKey: string }) {
      const active = useActiveTabKey();
      return (
        <>
          <TabsExtra tabKey={tabKey}>
            <span>{`Сводка ${tabKey}`}</span>
          </TabsExtra>
          <span>{`${tabKey}: активна ${active}`}</span>
        </>
      );
    }
    function Page() {
      const [params, setParams] = useSearchParams();
      return (
        <>
          <output>{params.toString()}</output>
          <PageTabs
            activeKey={params.get('tab') ?? 'first'}
            refreshQueryKey={['scenario']}
            onChange={(tab) => setParams({ tab })}
            items={[
              { key: 'first', label: 'Первая', children: <Body tabKey="first" /> },
              { key: 'next', label: 'Следующая', children: <next.Tab /> },
            ]}
          />
        </>
      );
    }
    renderWithUser(<Page />, { queryClient, route: '/?tab=first&open=card' });
    expect(screen.getByText('Сводка first')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Следующая' }));
    expect(screen.getByRole('status').textContent).toBe('tab=next');
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['scenario'] });
    expect(screen.queryByText('Сводка first')).toBeNull();
    await next.finish(() => <Body tabKey="next" />);
    await waitFor(() => expect(screen.getByText('Сводка next')).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: 'Первая' }));
    expect(screen.getByText('Сводка first')).toBeDefined();
    expect(screen.queryByText('Сводка next')).toBeNull();
    expect(next.load).toHaveBeenCalledTimes(1);
  });
});
