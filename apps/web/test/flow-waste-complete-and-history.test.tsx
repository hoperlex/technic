import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { WasteRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { objectDto, wasteRequest, wasteSummary } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';

/**
 * Завершение заявки на вывоз и вкладка «История» (ADR 0135).
 *
 * Проверяется не разметка, а два обещания портала. Первое: пункт «Завершена» предлагается только
 * тогда, когда бумага разобрана, — а пока в разборе что-то ждёт, он выключен и объясняет, чего
 * именно. Второе: закрытые заявки спрашиваются у журнала (`/waste-requests/history`), а не у
 * рабочего списка, — разъедься эти два адреса, вкладка показывала бы работающие заявки либо
 * пустоту, и по разметке это неотличимо от исправной работы.
 */

/** Выполненная заявка, бумага которой разобрана: значка нет — разбирать нечего. */
const DONE = wasteRequest({ id: 'wr-1', status: 'done', version: 7 });

/** Она же с ждущим подтверждения талоном: завершать рано (ADR 0114, Р24). */
const DONE_PENDING = wasteRequest({
  ...DONE,
  id: 'wr-2',
  num: 129,
  displayNumber: 'М-129',
  ticketBadge: { errors: 0, warnings: 0, pendingConfirmation: 2, failures: 0, unreviewedPaper: 0 },
});

/**
 * Она же с приложенным талоном, к разбору которого не приступали: распознавания у бумаги нет вовсе,
 * значит нет и неподтверждённых талонов — прежнее правило читало это как «всё разобрано» (ADR 0135,
 * миграция 0204).
 */
const DONE_UNREVIEWED = wasteRequest({
  ...DONE,
  id: 'wr-3',
  num: 130,
  displayNumber: 'М-130',
  ticketBadge: { errors: 0, warnings: 0, pendingConfirmation: 0, failures: 0, unreviewedPaper: 1 },
});

const COMPLETED = wasteRequest({
  ...DONE,
  id: 'wr-9',
  num: 120,
  displayNumber: 'М-120',
  status: 'completed',
  version: 8,
});

const CANCELLED = wasteRequest({
  id: 'wr-8',
  num: 119,
  displayNumber: 'М-119',
  status: 'cancelled',
  cancelReason: 'Площадка отказалась',
});

/** Экран заявок глазами диспетчера: он же ведёт заявки и разбирает талоны (ADR 0114, Р25). */
function renderPage(rows: WasteRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /waste-requests': () => json(list(rows)),
    'GET /waste-requests/summary': () => json(wasteSummary({ done: rows.length })),
    'GET /waste-requests/history': () => json(list([COMPLETED, CANCELLED])),
    'GET /waste-requests/history/summary': () =>
      json({
        total: 2,
        completed: 1,
        cancelled: 1,
        totalCost: 10_000,
        volumeM3: 20,
        weightTons: 0,
      }),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /waste-requests/present-groups': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(emptyList()),
    'GET /waste-types': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'PATCH /waste-requests/:id/status': () => json(COMPLETED),
    ...over,
  });
  renderWithUser(<WasteRequestsPage />);
  return http;
}

/** Меню переходов у тега статуса. Ищется по `aria-label`: `*ByRole` на таблице antd слишком дорог. */
async function openTransitions(index = 0) {
  fireEvent.click(screen.getAllByLabelText('Изменить статус')[index]!);
  return waitFor(() => {
    const items = [...document.querySelectorAll('.ant-dropdown-menu-item')];
    expect(items.length).toBeGreaterThan(0);
    return items;
  });
}

function switchToTab(label: string) {
  const tab = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => t.textContent === label);
  expect(tab, `вкладка «${label}»`).toBeTruthy();
  fireEvent.click(tab!);
}

describe('завершение заявки на вывоз и журнал закрытых', () => {
  it('разобранная заявка предлагает «Завершена» как обычный переход', async () => {
    const http = renderPage([DONE]);
    expect(await screen.findByText('М-128')).toBeDefined();

    const items = await openTransitions();
    const complete = items.find((el) => el.textContent === 'Завершена');
    expect(complete).toBeTruthy();
    expect(complete!.className).not.toContain('ant-dropdown-menu-item-disabled');

    fireEvent.click(complete!);
    await waitFor(() => expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(1));
    // Версия — из строки списка: заявка не менялась между показом и нажатием.
    expect(http.lastCall('PATCH /waste-requests/:id/status')?.body).toMatchObject({
      status: 'completed',
      version: 7,
    });
  });

  it('пока талоны не подтверждены, пункт выключен и называет причину', async () => {
    const http = renderPage([DONE_PENDING]);
    expect(await screen.findByText('М-129')).toBeDefined();

    const items = await openTransitions();
    const complete = items.find((el) => el.textContent === 'Завершена');
    expect(complete).toBeTruthy();
    // Пункт остаётся в меню: убери его вовсе — и пришедший завершить заявку решил бы, что права
    // нет. Он выключен и объясняет, чего ждёт.
    expect(complete!.className).toContain('ant-dropdown-menu-item-disabled');
    expect(complete!.getAttribute('title')).toContain('не подтверждено талонов: 2');

    fireEvent.click(complete!);
    expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(0);
  });

  it('приложенный, но не разобранный талон тоже держит пункт выключенным', async () => {
    const http = renderPage([DONE_UNREVIEWED]);
    expect(await screen.findByText('М-130')).toBeDefined();

    const items = await openTransitions();
    const complete = items.find((el) => el.textContent === 'Завершена');
    expect(complete!.className).toContain('ant-dropdown-menu-item-disabled');
    // Текст говорит не только «нельзя», но и что делать: файл распознают либо талон заводят руками.
    expect(complete!.getAttribute('title')).toContain('приложенных талонов не разобрано: 1');
    expect(complete!.getAttribute('title')).toContain('заведите талон руками');

    fireEvent.click(complete!);
    expect(http.countOf('PATCH /waste-requests/:id/status')).toBe(0);
  });

  it('вкладка «История» спрашивает журнал и показывает закрытые заявки', async () => {
    const http = renderPage([DONE]);
    expect(await screen.findByText('М-128')).toBeDefined();

    switchToTab('История');
    expect(await screen.findByText('М-120')).toBeDefined();
    expect(screen.getByText('М-119')).toBeDefined();
    expect(http.countOf('GET /waste-requests/history')).toBeGreaterThan(0);
    // Рабочий список журналу не отвечает: закрытых заявок он не отдаёт вовсе (ADR 0135).
    const journalCall = http.lastCall('GET /waste-requests/history');
    expect(journalCall?.path).toBe('/waste-requests/history');
    // Итог считается по тем же фильтрам, что и таблица, — и спрашивается своей ручкой.
    await waitFor(() =>
      expect(http.countOf('GET /waste-requests/history/summary')).toBeGreaterThan(0),
    );
  });
});
