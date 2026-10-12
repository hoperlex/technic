import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { heldServiceRequest, serviceExecutor, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * The portal has no "executor note" any more: the request chat replaced it (ADR 0141, decision 1).
 *
 * The file was rewritten and kept on purpose: it guards the **removal**. Replacing one with the
 * other is not enough: two places for one text would mean "where do I write" for everyone who opens
 * the request and two diverging answers to "what did the service say". So it checks that the window,
 * the menu item and the card line are gone, not that the chat appeared next to them (that is
 * `service-chat.test.tsx`).
 *
 * Release B removed the adapter route and the `serviceComment` DTO field, so the main scenario is a
 * DTO without the field. The previous server (release A code) still answers during the deploy window
 * and after a rollback and may send a leftover `serviceComment`; the card must not show it either.
 */

const EXECUTOR: AuthUser = serviceExecutor();

function renderTab(
  items: ServiceRequestDto[],
  over: RouteMap = {},
  user: AuthUser = EXECUTOR,
): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Подписи пунктов меню строки: на десктопе оно за кнопкой «Действия». */
async function rowActionLabels(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  const menu = await waitFor(() => {
    const found = document.querySelector('.ant-dropdown-menu');
    if (!found) throw new Error('меню действий не открылось');
    return found;
  });
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

describe('окна «Примечание исполнителя» больше нет', () => {
  it('в меню строки его место занято обсуждением', async () => {
    renderTab([serviceRequest({ status: 'in_work' })]);
    await screen.findByText('СО-14');

    const labels = await rowActionLabels();
    expect(labels).not.toContain('Примечание исполнителя');
    expect(labels).toContain('Обсуждение');
  });

  it('у отложенной заявки — то же: писать туда по-прежнему надо, но уже репликой (Р110)', async () => {
    renderTab([heldServiceRequest('in_work')]);
    await screen.findByText('СО-14');

    const labels = await rowActionLabels();
    expect(labels).not.toContain('Примечание исполнителя');
    expect(labels).toContain('Обсуждение');
  });

  it('у закрытой заявки обсуждение остаётся, хотя примечания там не было вовсе', async () => {
    // The old item disappeared on an accepted request: the server refused the write. The feed
    // freezes instead of hiding: reading the dispute with the contractor after acceptance is the
    // point (ADR decision 3).
    renderTab([serviceRequest({ status: 'accepted' })], {}, authUser({ role: 'admin' }));
    await screen.findByText('СО-14');

    expect(await rowActionLabels()).toContain('Обсуждение');
  });
});

/** The open request card, found by its title among the visible modal wraps. */
async function openedCard() {
  fireEvent.click(await screen.findByText('СО-14'));
  return waitFor(() => {
    const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
      .filter((el) => el.style.display !== 'none')
      .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Заявка СО-14');
    if (!wrap) throw new Error('карточка не открылась');
    return within(wrap);
  });
}

describe('карточка без примечания исполнителя', () => {
  it('поля `serviceComment` в DTO нет, и карточка открывается без его строки', async () => {
    const request = serviceRequest({ status: 'in_work' });
    expect('serviceComment' in request).toBe(false);
    const http = renderTab([request]);
    const card = await openedCard();

    expect(card.queryByText('Примечание исполнителя')).toBeNull();
    // The requester's field stays: it is part of the task statement, not a message (ADR decision 1).
    expect(card.getByText('Что ещё важно знать')).toBeDefined();
    // The portal calls the removed route nowhere.
    expect(http.countOf('PATCH /service-requests/:id/service-comment')).toBe(0);
  });

  it('остаток поля от сервера выпуска A в окне выката строкой не выводится', async () => {
    // The previous server still sends the field until it restarts (or after a rollback). The
    // card must not answer "what did the service say" from a second place even then.
    const fromOldServer = {
      ...serviceRequest({ status: 'in_work' }),
      serviceComment: 'ждём поставку',
    } as ServiceRequestDto;
    renderTab([fromOldServer]);
    const card = await openedCard();

    expect(card.queryByText('Примечание исполнителя')).toBeNull();
    expect(card.queryByText('ждём поставку')).toBeNull();
  });
});
