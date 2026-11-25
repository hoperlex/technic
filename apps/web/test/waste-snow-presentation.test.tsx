import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  WasteRequestCompletionDto,
  WasteRequestDto,
  WasteRequestHistorySummaryDto,
} from '@technic/contracts';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { apiError, json, mockHttp, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { MOBILE_VIEWPORT } from './viewport';
import { WasteRequestsPage } from '../src/pages/waste';
import { historySummaryItems } from '../src/pages/waste/wasteHistorySummary';

/**
 * How a snow request reads in the portal (snow-removal plan, §3.3): its type label and colour in
 * every list, the ordered volume and «Снег» in the card outside any pricing, the recorded amount
 * or an «ожидает ввода» note in the fact, and a journal summary that counts completed snow with
 * and without a cost. Snow is shown only while the serving API confirms it (§3.5).
 */

const SNOW_OK = { capabilities: ['snow-removal-v1'] };

function snowFact(totalCost: number | null): WasteRequestCompletionDto {
  return {
    unit: 'volume_m3',
    volumeM3: 18,
    weightTons: null,
    pricePerM3: null,
    totalCost,
    removedOn: '2026-12-01',
    completedBy: 'user-1',
    completedByName: 'Диспетчеров Д. П.',
    completedAt: '2026-12-02T10:00:00.000Z',
  } as WasteRequestCompletionDto;
}

const SNOW = wasteRequest({
  id: 'wr-s1',
  displayNumber: 'М-201',
  requestType: 'snow_removal',
  wasteTypeId: '29cd9e92-0d72-4666-8ff1-76e0d6aad553',
  wasteTypeName: 'Снег',
  volumeM3: 16,
  pricePerM3: null,
  amount: null,
  status: 'confirmed',
});

function setup(
  rows: WasteRequestDto[],
  over: RouteMap = {},
  options: { route?: string; mobile?: boolean } = {},
) {
  const http = mockHttp({
    'GET /waste-requests/capabilities': () => json(SNOW_OK),
    'GET /waste-requests': () => json(list(rows)),
    'GET /waste-requests/summary': () => json(wasteSummary({ confirmed: rows.length })),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /waste-requests/:id/history': () => json([]),
    // A done request opens with the review panel for a dispatcher; its paper is not the subject.
    'GET /waste-requests/:id/tickets': () =>
      json({
        tickets: [],
        pages: [],
        files: [],
        checks: [],
        attempts: [],
        blindChecks: [],
        ticketsVolumeM3: 0,
        preliminary: false,
        acceptanceAllowed: true,
        badge: { errors: 0, warnings: 0, pendingConfirmation: 0, failures: 0, unreviewedPaper: 0 },
      }),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
    ...over,
  });
  renderWithUser(<WasteRequestsPage />, {
    route: options.route,
    viewport: options.mobile ? MOBILE_VIEWPORT : undefined,
  });
  return http;
}

async function openCard(displayNumber: string) {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(within(row as HTMLElement).getByLabelText('Открыть карточку'));
  await screen.findByText(`Заявка № ${displayNumber}`);
}

describe('карточка заявки на вывоз снега', () => {
  it('показывает тип, «Снег» и заказанный объём вне цены, стоимость — при закрытии', async () => {
    setup([SNOW]);
    await openCard('М-201');
    await waitFor(() => expect(screen.getAllByText('вносится при закрытии заявки').length).toBe(1));
    const dialog = screen.getByText('Заявка № М-201').closest('.ant-modal') as HTMLElement;
    expect(within(dialog).getByText('Вывоз снега')).toBeDefined();
    expect(within(dialog).getByText('Снег')).toBeDefined();
    expect(within(dialog).getByText('16 м³')).toBeDefined();
    // No estimate exists, so the garbage warning about a missing tariff must not appear.
    expect(within(dialog).queryByText(/тариф не задан/)).toBeNull();
  });

  it('факт без суммы говорит «ожидает ввода», записанный ноль — известная сумма', async () => {
    const noCost = { ...SNOW, status: 'done' as const, completion: snowFact(null) };
    const zero = {
      ...SNOW,
      id: 'wr-s2',
      num: 202,
      displayNumber: 'М-202',
      status: 'done' as const,
      completion: snowFact(0),
    };
    setup([noCost, zero]);
    await openCard('М-201');
    expect((await screen.findAllByText('стоимость ожидает ввода')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/цены в прайсе не было/)).toBeNull();
    fireEvent.click(
      [...document.querySelectorAll('.ant-modal-footer button')]
        .filter((b) => b.textContent === 'Закрыть')
        .at(-1)!,
    );

    await openCard('М-202');
    await waitFor(() => expect(screen.getAllByText(/18 м³ · 0,00 ₽/).length).toBeGreaterThan(0));
  });

  it('по ссылке без подтверждения сервера — состояние «недоступна» вместо карточки', async () => {
    const http = setup(
      [],
      {
        'GET /waste-requests/capabilities': () =>
          apiError(400, { code: 'validation_error', message: 'Некорректный идентификатор' }),
        'GET /waste-requests/:id': () => json(SNOW),
      },
      { route: '/waste?tab=requests&open=wr-s1' },
    );
    expect(await screen.findByText('Заявка на вывоз снега сейчас недоступна')).toBeDefined();
    // Nothing more about the request is asked: its history waits for a confirmed server.
    expect(http.countOf('GET /waste-requests/:id/history')).toBe(0);
    expect(screen.queryByText('Редактировать')).toBeNull();
  });
});

describe('списки показывают снег как тип', () => {
  it('телефонная карточка: тип, объём со «Снег», без строки цены', async () => {
    setup([SNOW], {}, { mobile: true });
    expect(await screen.findByText('Вывоз снега')).toBeDefined();
    expect(screen.getByText('16 м³ · Снег')).toBeDefined();
    expect(screen.queryByText(/тариф не задан/)).toBeNull();
  });

  it('фильтр типа предлагает снег только после подтверждения сервера', async () => {
    let supported = false;
    const http = setup([], {
      'GET /waste-requests/capabilities': () =>
        supported ? json(SNOW_OK) : apiError(503, { code: 'error', message: 'Недоступно' }),
    });
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
    // Nothing is asked before the person enters the filter.
    expect(http.countOf('GET /waste-requests/capabilities')).toBe(0);

    const select = screen.getByText('Все типы заявок').closest('.ant-select')!;
    fireEvent.mouseDown(select.querySelector('.ant-select-content') ?? select);
    await waitFor(() => expect(http.countOf('GET /waste-requests/capabilities')).toBe(1));
    const labels = () =>
      [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option')].map(
        (o) => o.textContent,
      );
    await waitFor(() => expect(labels()).toContain('Вывоз мусора (разовый объём)'));
    expect(labels()).not.toContain('Вывоз снега');

    // Leaving and entering the filter again asks again.
    supported = true;
    fireEvent.mouseDown(select.querySelector('.ant-select-content') ?? select);
    await waitFor(() => expect(select.classList.contains('ant-select-open')).toBe(false));
    fireEvent.mouseDown(select.querySelector('.ant-select-content') ?? select);
    await waitFor(() => expect(http.countOf('GET /waste-requests/capabilities')).toBe(2));
    await waitFor(() => expect(labels()).toContain('Вывоз снега'));
  });
});

describe('итог журнала со снегом', () => {
  const base: WasteRequestHistorySummaryDto = {
    total: 4,
    completed: 3,
    cancelled: 1,
    totalCost: 12_000,
    volumeM3: 60,
    weightTons: 0,
    snowCompletedWithCost: 0,
    snowCompletedWithoutCost: 0,
  };

  function shown(summary: WasteRequestHistorySummaryDto, snowOnly: boolean) {
    const items = historySummaryItems(summary, snowOnly);
    const { container, unmount } = render(
      <div>
        {items.map((item) => (
          <div key={item.label}>
            {item.label}: {item.value}
          </div>
        ))}
      </div>,
    );
    // Money is printed with non-breaking spaces; the comparison is about words, not spacing.
    const text = [...container.querySelectorAll('div > div')].map((el) =>
      el.textContent?.replace(/\s+/g, ' '),
    );
    unmount();
    return text;
  }

  it('считает завершённый снег со стоимостью и без неё и помечает неполную сумму', () => {
    const text = shown({ ...base, snowCompletedWithCost: 1, snowCompletedWithoutCost: 2 }, false);
    expect(text).toContain('Снег со стоимостью: 1');
    expect(text).toContain('Снег без стоимости: 2');
    expect(text).toContain('Стоимость: 12 000,00 ₽ неполная');
  });

  it('только снег и ни одной суммы — прочерк, а не ноль', () => {
    const text = shown(
      { ...base, totalCost: 0, snowCompletedWithCost: 0, snowCompletedWithoutCost: 3 },
      true,
    );
    expect(text).toContain('Стоимость: —');
  });

  it('записанный ноль — известная сумма', () => {
    const text = shown(
      { ...base, totalCost: 0, snowCompletedWithCost: 2, snowCompletedWithoutCost: 0 },
      true,
    );
    expect(text).toContain('Стоимость: 0,00 ₽');
  });

  it('ответ сервера без счётчиков снега читается как обычный итог', () => {
    const legacy = { ...base } as Partial<WasteRequestHistorySummaryDto>;
    delete legacy.snowCompletedWithCost;
    delete legacy.snowCompletedWithoutCost;
    const text = shown(legacy as WasteRequestHistorySummaryDto, false);
    expect(text).toContain('Стоимость: 12 000,00 ₽');
    expect(text.some((line) => line?.startsWith('Снег'))).toBe(false);
  });

  it('итог показывается, только когда он и список отвечают на текущий отбор', async () => {
    let listAnswer!: (response: MockResponse) => void;
    let listCalls = 0;
    const http = setup(
      [],
      {
        'GET /waste-requests/history': () => {
          listCalls += 1;
          if (listCalls === 1) return json(list<WasteRequestDto>([]));
          return new Promise<MockResponse>((resolve) => {
            listAnswer = resolve;
          });
        },
        'GET /waste-requests/history/summary': ({ query }) =>
          json({
            ...base,
            total: query.get('status') === 'cancelled' ? 1 : 4,
          }),
      },
      { route: '/waste?tab=history' },
    );
    const bar = () =>
      screen.queryByText('Журнал')?.closest('div')?.textContent?.replace(/\s+/g, ' ') ?? null;
    await waitFor(() => expect(bar()).toContain('Закрыто: 4'));

    // A new filter: the summary for it arrives first, the list is still on its way.
    const status = screen.getByText('Завершённые и отменённые').closest('.ant-select')!;
    fireEvent.mouseDown(status.querySelector('.ant-select-content') ?? status);
    const cancelled = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option')]
        .filter((o) => o.textContent === 'Отменена')
        .at(-1);
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(cancelled);
    await waitFor(() => expect(http.countOf('GET /waste-requests/history/summary')).toBe(2));
    await waitFor(() => expect(listCalls).toBe(2));
    expect(bar()).toBeNull();

    listAnswer(json(list<WasteRequestDto>([])));
    await waitFor(() => expect(bar()).toContain('Закрыто: 1'));
  });
});
