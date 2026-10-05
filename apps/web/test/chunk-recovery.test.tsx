import { lazy, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type * as SharedLib from '@shared/lib';
import { __resetChunkLoadFailureForTests, hasChunkLoadFailure, reloadPage } from '@shared/lib';
import { AsyncContent } from '@shared/ui';
import { AppUpdateBanner } from '@widgets/app-update-banner';
import { renderWithUser } from './render';

vi.mock('@shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedLib>()),
  reloadPage: vi.fn(),
}));

beforeEach(() => {
  __resetChunkLoadFailureForTests();
  vi.mocked(reloadPage).mockClear();
});

afterEach(() => {
  cleanup();
  __resetChunkLoadFailureForTests();
  vi.restoreAllMocks();
});

describe('восстановление загрузки чанка', () => {
  it('отказ lazy показывает обновление, сохраняет каркас и не запускает цикл повторов', async () => {
    // React reports caught render errors too; the assertions below verify the actual recovery UI.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi.fn(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/old.js')),
    );
    const Screen = lazy(load);
    function Harness() {
      const [count, setCount] = useState(0);
      return (
        <>
          <AppUpdateBanner />
          <nav>Каркас портала</nav>
          <button onClick={() => setCount(count + 1)}>Проверить {count}</button>
          <AsyncContent>
            <Screen />
          </AsyncContent>
        </>
      );
    }
    renderWithUser(<Harness />);

    const recovery = await screen.findByRole('alert', {
      name: 'Не удалось загрузить часть портала',
    });
    expect(screen.getByText('Каркас портала')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Позже' })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();

    // A parent render must not turn the cached rejection into an automatic retry/reload loop.
    fireEvent.click(screen.getByRole('button', { name: 'Проверить 0' }));
    expect(screen.getByRole('button', { name: 'Проверить 1' })).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();

    fireEvent.click(within(recovery).getByRole('button', { name: /Обновить страницу/u }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('vite:preloadError требует обновления даже без отказа API и не перезагружает сам', () => {
    renderWithUser(<AppUpdateBanner />);
    const event = new Event('vite:preloadError', { cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('alert', { name: 'Не удалось загрузить часть портала' })).toBeDefined();
    expect(reloadPage).not.toHaveBeenCalled();
    fireEvent(window, new Event('vite:preloadError', { cancelable: true }));
    expect(
      screen.getAllByRole('alert', { name: 'Не удалось загрузить часть портала' }),
    ).toHaveLength(1);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('прогретый раздел сохраняет черновик при отказе нового дочернего чанка', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loadLeaf = vi.fn(() =>
      Promise.reject(
        new TypeError('error loading dynamically imported module: /assets/old-tab.js'),
      ),
    );
    const Leaf = lazy(loadLeaf);
    function LoadedSection() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <label>
            Черновик прогретого раздела
            <input defaultValue="Не терять до ручного обновления" />
          </label>
          <button onClick={() => setOpen(!open)}>Переключить вкладку</button>
          {open && (
            <AsyncContent>
              <Leaf />
            </AsyncContent>
          )}
        </>
      );
    }
    const loadSection = vi.fn(async () => ({ default: LoadedSection }));
    const Section = lazy(loadSection);
    renderWithUser(
      <>
        <AppUpdateBanner />
        <AsyncContent>
          <Section />
        </AsyncContent>
      </>,
    );

    const draft = (await screen.findByLabelText('Черновик прогретого раздела')) as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'Изменённый черновик' } });
    fireEvent.click(screen.getByRole('button', { name: 'Переключить вкладку' }));
    const recovery = await screen.findByRole('alert', {
      name: 'Не удалось загрузить часть портала',
    });
    expect(draft.value).toBe('Изменённый черновик');
    expect(loadSection).toHaveBeenCalledTimes(1);
    expect(loadLeaf).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(within(recovery).queryByRole('button', { name: 'Позже' })).toBeNull();
    // A chunk failure must not mask the document: the open draft stays editable (decision
    // 06.10.2026); only a server version refusal (426) blocks the screen.
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    fireEvent.change(draft, { target: { value: 'Дописанный после отказа' } });
    expect(draft.value).toBe('Дописанный после отказа');

    // Remounting a failed lazy leaf cannot repair its cached rejection or discard the parent draft.
    fireEvent.click(screen.getByRole('button', { name: 'Переключить вкладку' }));
    fireEvent.click(screen.getByRole('button', { name: 'Переключить вкладку' }));
    expect(loadSection).toHaveBeenCalledTimes(1);
    expect(loadLeaf).toHaveBeenCalledTimes(1);
    expect(draft.value).toBe('Дописанный после отказа');
    expect(reloadPage).not.toHaveBeenCalled();
    fireEvent.click(within(recovery).getByRole('button', { name: /Обновить страницу/u }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('ошибка рендера не выдаётся за несовместимую версию или потерянный чанк', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error('render bug');
    }
    renderWithUser(
      <>
        <AppUpdateBanner />
        <AsyncContent>
          <Broken />
        </AsyncContent>
      </>,
    );
    expect(screen.getByText('Не удалось открыть экран')).toBeDefined();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('alert', { name: 'Не удалось загрузить часть портала' })).toBeNull();
    expect(hasChunkLoadFailure()).toBe(false);
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
