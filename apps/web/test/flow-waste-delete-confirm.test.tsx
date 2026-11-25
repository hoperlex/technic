import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { WasteRequestDto } from '@technic/contracts';
import { WasteRequestsPage } from '../src/pages/waste';
import { WasteArchiveTab } from '../src/pages/waste/WasteArchiveTab';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';

/**
 * Deletion sends what the person confirmed (snow-removal plan, §3.2): the version the dialog was
 * opened on and the mode it promised. Between the click and the answer the request may be rolled
 * back to «Новая», and an archive confirmation must not become a hard delete: the server refuses
 * with 409, and the portal reloads before asking again.
 */

const admin = authUser({ id: 'user-admin', role: 'admin' });

function pageRoutes(rows: () => WasteRequestDto[], extra: RouteMap = {}): RouteMap {
  return {
    'GET /waste-requests': () => json(list(rows())),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
    ...extra,
  };
}

/** The row's delete button has only an icon: it is found by the icon inside the row. */
async function clickRowDelete() {
  const icon = await waitFor(() => {
    const found = document.querySelector('tbody .anticon-delete');
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(icon.closest('button')!);
}

async function confirmDialog(title: string) {
  await screen.findAllByText(title);
  // A closed confirmation stays in the DOM: the dialog just opened is the last one.
  const ok = [...document.querySelectorAll('.ant-modal-confirm button')]
    .filter((button) => button.textContent === 'Подтвердить')
    .at(-1);
  fireEvent.click(ok!);
}

describe('удаление заявки на вывоз: подтверждение доходит до сервера', () => {
  it('«Новая» удаляется насовсем: уходят режим hard и версия из окна', async () => {
    const row = wasteRequest({ status: 'new', version: 5 });
    const http = mockHttp(
      pageRoutes(() => [row], {
        'DELETE /waste-requests/:id': () => json({ ok: true, mode: 'hard' }),
      }),
    );
    renderWithUser(<WasteRequestsPage />);
    await clickRowDelete();
    await confirmDialog('Удалить заявку?');

    await waitFor(() => expect(http.countOf('DELETE /waste-requests/:id')).toBe(1));
    const call = http.lastCall('DELETE /waste-requests/:id')!;
    expect(call.path).toBe(`/waste-requests/${row.id}`);
    expect(Object.fromEntries(call.query)).toEqual({ version: '5', mode: 'hard' });
  });

  it('заявка в работе уходит в архив: режим soft; отказ 409 перечитывает список', async () => {
    let row = wasteRequest({ status: 'confirmed', version: 7 });
    const http = mockHttp(
      pageRoutes(() => [row], {
        'DELETE /waste-requests/:id': () =>
          apiError(409, { code: 'conflict', message: 'Заявка изменилась — обновите страницу' }),
      }),
    );
    renderWithUser(<WasteRequestsPage />);
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
    await clickRowDelete();
    // Meanwhile the request was rolled back to «Новая»: the server sees the drift and refuses.
    row = wasteRequest({ status: 'new', version: 8 });
    await confirmDialog('Переместить заявку в архив?');

    await waitFor(() => expect(http.countOf('DELETE /waste-requests/:id')).toBe(1));
    expect(Object.fromEntries(http.lastCall('DELETE /waste-requests/:id')!.query)).toEqual({
      version: '7',
      mode: 'soft',
    });
    // The list is reread before the person can confirm again, so the next dialog asks about the
    // request as it is now: «Удалить», not «Переместить в архив».
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(2));
    await clickRowDelete();
    expect((await screen.findAllByText('Удалить заявку?')).length).toBeGreaterThan(0);
  });
});

describe('окончательное удаление из архива', () => {
  const archived = (version: number) =>
    wasteRequest({
      id: 'wr-9',
      displayNumber: 'М-9',
      status: 'confirmed',
      version,
      deletedAt: '2026-08-05T10:00:00.000Z',
      deletedByName: 'Админов А. А.',
    });

  function purgeButton(): HTMLElement {
    return [...document.querySelectorAll('tbody button')].find(
      (button) => button.getAttribute('aria-label') === 'Удалить окончательно',
    ) as HTMLElement;
  }

  async function confirmPurge() {
    await screen.findAllByText('Удалить заявку «М-9» окончательно?');
    // A closed confirmation stays in the DOM: the dialog just opened is the last one.
    const ok = [...document.querySelectorAll('.ant-modal button')]
      .filter((button) => button.textContent === 'Удалить окончательно')
      .at(-1);
    fireEvent.click(ok!);
  }

  it('уходит архивная версия, которую человек видел', async () => {
    const http = mockHttp({
      'GET /waste-requests': () => json(list([archived(12)])),
      'DELETE /waste-requests/:id/purge': () => json({ ok: true }),
    });
    renderWithUser(<WasteArchiveTab />, { user: admin });
    await screen.findByText('М-9');
    fireEvent.click(purgeButton());
    await confirmPurge();

    await waitFor(() => expect(http.countOf('DELETE /waste-requests/:id/purge')).toBe(1));
    const call = http.lastCall('DELETE /waste-requests/:id/purge')!;
    expect(call.path).toBe('/waste-requests/wr-9/purge');
    expect(Object.fromEntries(call.query)).toEqual({ version: '12' });
  });

  it('отказ 409 перечитывает архив, и следующее подтверждение несёт новую версию', async () => {
    let version = 12;
    let refuse = true;
    const http = mockHttp({
      'GET /waste-requests': () => json(list([archived(version)])),
      'DELETE /waste-requests/:id/purge': () =>
        refuse
          ? apiError(409, { code: 'conflict', message: 'Заявка изменилась — обновите страницу' })
          : json({ ok: true }),
    });
    renderWithUser(<WasteArchiveTab />, { user: admin });
    await screen.findByText('М-9');
    fireEvent.click(purgeButton());
    // Restored and archived again in another tab: the archived version moved on.
    version = 14;
    await confirmPurge();

    await waitFor(() => expect(http.countOf('DELETE /waste-requests/:id/purge')).toBe(1));
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(2));
    refuse = false;
    fireEvent.click(purgeButton());
    await confirmPurge();
    await waitFor(() => expect(http.countOf('DELETE /waste-requests/:id/purge')).toBe(2));
    expect(Object.fromEntries(http.lastCall('DELETE /waste-requests/:id/purge')!.query)).toEqual({
      version: '14',
    });
  });
});
