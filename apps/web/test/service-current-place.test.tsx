import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { MOBILE_VIEWPORT } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * "Stands now" after a move (ADR 0215): the request keeps its own site, and the portal adds where
 * the unit really is — in the list row, in the card header and on the phone card.
 *
 * The failure this guards against is silent: without the block every screen keeps naming the
 * declared site (or the old site's room), and executors travel there. Nothing errors.
 */

const OPERATOR: AuthUser = serviceOperator();

/** Declared on site B, then IT found it on site C and took it to the service. */
const moved = (over: Partial<ServiceRequestDto> = {}) =>
  serviceRequest({
    object: { id: 'obj-b', code: 'ОБ-2', name: 'ЖК Южный' },
    objectOverridden: true,
    equipment: {
      ...serviceRequest().equipment!,
      location: '',
    },
    currentPlace: {
      object: { id: 'obj-c', code: 'ОБ-3', name: 'Склад' },
      location: 'кабинет 5',
      state: 'at_service',
      stateNote: 'СЦ Принт',
      movedOn: '2026-09-29',
    },
    ...over,
  });

const NOW = 'Сейчас: ОБ-3 — Склад · кабинет 5 · в ремонте (СЦ Принт)';

function routes(items: ServiceRequestDto[]): RouteMap {
  return {
    'GET /service-requests': () => json(list(items)),
    'GET /service-requests/executor-candidates': () => json({ items: [] }),
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
  };
}

async function openCard(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText('СО-14'));
  return await waitFor(() => {
    const modal = document.querySelector<HTMLElement>('.ant-modal-wrap');
    if (!modal) throw new Error('карточка не открылась');
    return modal;
  });
}

describe('где стоит сейчас (ADR 0215)', () => {
  it('list row keeps the filed site on top and adds where the unit is now', async () => {
    mockHttp(routes([moved()]));
    renderWithUser(<RequestsTab />, { user: OPERATOR });

    const row = (await screen.findByText('СО-14')).closest('tr')!;
    // The top line stays the request's own site: filter, sort and scope work on it.
    expect(within(row).getByText('ОБ-2 — ЖК Южный')).toBeDefined();
    expect(within(row).getByText(NOW)).toBeDefined();
  });

  it('card header names where to go first and the filed site as "в заявке"', async () => {
    mockHttp(routes([moved()]));
    renderWithUser(<RequestsTab />, { user: OPERATOR });

    const modal = await openCard();
    expect(within(modal).getAllByText(NOW).length).toBeGreaterThan(0);
    expect(within(modal).getAllByText('в заявке:').length).toBeGreaterThan(0);
    // The declaration is still named: the move does not rewrite what the requester said.
    expect(within(modal).getByText('Объект указан заявителем')).toBeDefined();
  });

  it('phone card line says where to go, not where the request was filed', async () => {
    mockHttp(routes([moved()]));
    renderWithUser(<RequestsTab />, { user: OPERATOR, viewport: MOBILE_VIEWPORT });

    await screen.findByText('СО-14');
    const card = document.querySelector<HTMLElement>('.list-card')!;
    expect(within(card).getByText(NOW)).toBeDefined();
    expect(within(card).queryByText(/ЖК Южный/)).toBeNull();
  });

  it('nothing moved — no tag, and the snapshot reads as before', async () => {
    mockHttp(routes([serviceRequest()]));
    renderWithUser(<RequestsTab />, { user: OPERATOR });

    const row = (await screen.findByText('СО-14')).closest('tr')!;
    expect(within(row).queryByText(/^Сейчас:/)).toBeNull();
    expect(within(row).getByText('ОБ-1 — ЖК Северный')).toBeDefined();
  });

  it('a server that predates the field (no key at all) reads as "nothing moved"', async () => {
    const { currentPlace: _dropped, ...legacy } = moved();
    mockHttp(routes([legacy as ServiceRequestDto]));
    renderWithUser(<RequestsTab />, { user: OPERATOR });

    const row = (await screen.findByText('СО-14')).closest('tr')!;
    expect(within(row).queryByText(/^Сейчас:/)).toBeNull();
  });
});
