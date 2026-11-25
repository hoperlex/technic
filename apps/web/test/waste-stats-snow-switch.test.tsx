import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { WasteStatsDto, WasteStatsFigures, WasteStatsKind } from '@technic/contracts';
import { useSearchParams } from 'react-router';
import { wasteRequestKeys } from '@entities/waste-request';
import { PageTabs } from '../src/shared/ui';
import { WasteStatsTab } from '../src/pages/waste/WasteStatsTab';
import { costNotes, doneCostWarning } from '../src/pages/waste/wasteStatsNumbers';
import { apiError, json, mockHttp, type HttpMock, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';

/**
 * The «Мусор / Снег» switch of the statistics tab (snow-removal plan, S8, §3.4, §3.5).
 *
 * Garbage and snow are never one table. The switch lives in the address with the month, every
 * reply is cached by month AND kind, and only figures of the selected kind are drawn — a slow or
 * out-of-order reply of the other kind must not fill the table. A reply is checked before it is
 * cached: snow needs the echoed `kind: 'snow'` (an older API ignores the parameter and answers
 * with garbage), while garbage still accepts a reply without `kind`.
 */

const LEGACY = {
  volumeM3: 0,
  volumeOrderedM3: 0,
  totalCost: 0,
  costEstimated: 0,
  confirmedVolumeM3: 0,
  confirmedVolumeUnpricedM3: 0,
  confirmedCost: 0,
};

function figures(over: Partial<WasteStatsFigures> = {}): WasteStatsFigures {
  return {
    ...LEGACY,
    plannedVolumeM3: 0,
    plannedCost: null,
    plannedVolumeUnpricedM3: 0,
    doneVolumeM3: 0,
    doneCost: null,
    doneVolumeUnpricedM3: 0,
    ticketVolumeM3: 0,
    ticketVolumeUnconfirmedM3: 0,
    ticketVolumeUnpricedM3: 0,
    ticketCost: null,
    ticketsWithoutVolume: 0,
    ticketsUnconfirmed: 0,
    ticketFilesUnread: 0,
    ticketFilesWithoutTickets: 0,
    unpricedRequests: 0,
    removals: 0,
    requests: 0,
    ...over,
  };
}

function reply(kind: WasteStatsKind | undefined, month: string, site: string): WasteStatsDto {
  const row = figures({ plannedVolumeM3: 40, doneVolumeM3: 30, removals: 1, requests: 1 });
  return {
    month,
    ...(kind ? { kind } : {}),
    from: `${month}-01`,
    to: `${month}-28`,
    rows: [
      {
        objectId: `obj-${site}`,
        code: site,
        name: `Площадка ${site}`,
        isActive: true,
        ...row,
        positions: [{ key: `${site}|p`, label: kind === 'snow' ? 'Снег' : 'Грунт', ...row }],
      },
    ],
    totals: row,
    quality: [],
  } as WasteStatsDto;
}

function AddressProbe() {
  const [sp] = useSearchParams();
  return <div data-testid="address">{sp.toString()}</div>;
}

function renderTab(route: string, routes: RouteMap): { http: HttpMock; queryClient: QueryClient } {
  const http = mockHttp({
    'GET /waste-requests/capabilities': () => json({ capabilities: ['snow-removal-v1'] }),
    ...routes,
  });
  const { queryClient } = renderWithUser(
    <PageTabs
      activeKey="stats"
      items={[
        {
          key: 'stats',
          label: 'Статистика',
          children: (
            <>
              <WasteStatsTab />
              <AddressProbe />
            </>
          ),
        },
      ]}
    />,
    { user: authUser({ id: 'user-disp', role: 'dispatcher' }), route },
  );
  return { http, queryClient };
}

const statsCalls = (http: HttpMock) =>
  http.calls
    .filter((c) => c.path === '/waste-requests/stats')
    .map((c) => Object.fromEntries(c.query));

/** Picks a kind once the switch offers it: «Снег» is enabled only after the capability answer. */
async function pickKind(label: 'Мусор' | 'Снег') {
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-segmented-item')].find(
      (item) => item.textContent === label,
    );
    expect(found?.classList.contains('ant-segmented-item-disabled')).toBe(false);
    return found!;
  });
  fireEvent.click(option.querySelector('input') ?? option);
}

const address = () => screen.getByTestId('address').textContent ?? '';

describe('переключатель «Мусор / Снег» статистики', () => {
  it('пишет вид в адрес рядом с вкладкой и месяцем; мусор спрашивается голым ?month=', async () => {
    const { http, queryClient } = renderTab('/waste?tab=stats&month=2026-12', {
      'GET /waste-requests/stats': ({ query }) =>
        json(reply((query.get('kind') as WasteStatsKind) ?? 'waste', query.get('month')!, 'М')),
    });
    await screen.findByText('Площадка М');
    expect(statsCalls(http)).toEqual([{ month: '2026-12' }]);

    await pickKind('Снег');
    await waitFor(() => expect(address()).toBe('tab=stats&month=2026-12&kind=snow'));
    await waitFor(() =>
      expect(statsCalls(http)).toContainEqual({ month: '2026-12', kind: 'snow' }),
    );
    // One cell per month and kind under the waste request root.
    await waitFor(() =>
      expect(queryClient.getQueryData(wasteRequestKeys.stats('2026-12', 'snow'))).toBeDefined(),
    );
    expect(queryClient.getQueryData(wasteRequestKeys.stats('2026-12', 'waste'))).toBeDefined();
    expect(wasteRequestKeys.stats('2026-12', 'snow')[0]).toBe(wasteRequestKeys.root[0]);
  });

  it('негодный вид в адресе открывает мусор и до сервера не доходит', async () => {
    const { http } = renderTab('/waste?tab=stats&month=2026-12&kind=ice', {
      'GET /waste-requests/stats': ({ query }) => json(reply(undefined, query.get('month')!, 'М')),
    });
    await screen.findByText('Площадка М');
    expect(statsCalls(http)).toEqual([{ month: '2026-12' }]);
  });

  it('старый ответ без вида годится мусору, но не снегу', async () => {
    renderTab('/waste?tab=stats&month=2026-12&kind=snow', {
      // An API from before snow ignores `kind` and answers with the garbage figures.
      'GET /waste-requests/stats': ({ query }) => json(reply(undefined, query.get('month')!, 'М')),
    });
    expect(
      await screen.findByText(/Статистика по снегу недоступна: сервер её не поддерживает/),
    ).toBeDefined();
    expect(screen.queryByText('Площадка М')).toBeNull();

    await pickKind('Мусор');
    expect(await screen.findByText('Площадка М')).toBeDefined();
  });

  it('ответ другого вида или месяца — местная ошибка, а не чужие цифры', async () => {
    renderTab('/waste?tab=stats&month=2026-12', {
      'GET /waste-requests/stats': () => json(reply('snow', '2026-11', 'Чужая')),
    });
    expect(await screen.findByText(/Не удалось получить статистику за месяц/)).toBeDefined();
    expect(screen.queryByText('Площадка Чужая')).toBeNull();
  });

  it('отказ сервера на снег — «недоступна», даже после подтверждённой поддержки', async () => {
    renderTab('/waste?tab=stats&month=2026-12&kind=snow', {
      'GET /waste-requests/stats': () =>
        apiError(400, { code: 'validation_error', message: 'Лишний параметр kind' }),
    });
    expect(
      await screen.findByText(/Статистика по снегу недоступна: сервер её не поддерживает/),
    ).toBeDefined();
  });

  it('сбой сервера на снег — местная ошибка, а не «снег не поддерживается»', async () => {
    renderTab('/waste?tab=stats&month=2026-12&kind=snow', {
      'GET /waste-requests/stats': () => apiError(503, { code: 'error', message: 'Сбой сервера' }),
    });
    expect(await screen.findByText(/Не удалось получить статистику за месяц/)).toBeDefined();
    expect(screen.queryByText(/Статистика по снегу недоступна/)).toBeNull();
  });

  it('без подтверждения сервера снег выключен и не спрашивается', async () => {
    const { http } = renderTab('/waste?tab=stats&month=2026-12&kind=snow', {
      'GET /waste-requests/capabilities': () =>
        apiError(503, { code: 'error', message: 'Недоступно' }),
      'GET /waste-requests/stats': ({ query }) => json(reply('waste', query.get('month')!, 'М')),
    });
    expect(
      await screen.findByText(/Статистика по снегу недоступна: сервер её не поддерживает/),
    ).toBeDefined();
    expect(statsCalls(http)).toEqual([]);
    await pickKind('Мусор');
    await screen.findByText('Площадка М');
    const snowItem = [...document.querySelectorAll('.ant-segmented-item')].find(
      (item) => item.textContent === 'Снег',
    )!;
    expect(snowItem.classList.contains('ant-segmented-item-disabled')).toBe(true);
  });

  it('медленный ответ другого вида не попадает в таблицу выбранного', async () => {
    let lateGarbage!: (response: MockResponse) => void;
    renderTab('/waste?tab=stats&month=2026-12', {
      'GET /waste-requests/stats': ({ query }) =>
        query.get('kind') === 'snow'
          ? json(reply('snow', query.get('month')!, 'Снежная'))
          : new Promise<MockResponse>((resolve) => {
              lateGarbage = resolve;
            }),
    });
    await waitFor(() => expect(lateGarbage).toBeDefined());
    await pickKind('Снег');
    expect(await screen.findByText('Площадка Снежная')).toBeDefined();

    lateGarbage(json(reply('waste', '2026-12', 'Мусорная')));
    // The garbage reply lands in its own cell and the snow table stays as it is.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Площадка Мусорная')).toBeNull();
    expect(screen.getByText('Площадка Снежная')).toBeDefined();
  });

  it('переключение закрывает окно площадки', async () => {
    renderTab('/waste?tab=stats&month=2026-12', {
      'GET /waste-requests/stats': ({ query }) =>
        json(
          reply(
            (query.get('kind') as WasteStatsKind) ?? 'waste',
            query.get('month')!,
            query.get('kind') === 'snow' ? 'С' : 'М',
          ),
        ),
    });
    fireEvent.click(await screen.findByText('Площадка М'));
    expect(await screen.findByText('Грунт')).toBeDefined();
    await pickKind('Снег');
    await screen.findByText('Площадка С');
    await waitFor(() =>
      expect(
        document.querySelector('.ant-modal-wrap:not([style*="none"]) .ant-modal-title'),
      ).toBeNull(),
    );
  });
});

describe('слова о деньгах снега', () => {
  const snow = figures({ doneVolumeM3: 30, doneVolumeUnpricedM3: 10, doneCost: 15000 });

  it('недостающая сумма — не внесённая стоимость, а не отсутствие цены в прайсе', () => {
    const lines = doneCostWarning(snow, 'snow');
    expect(lines[0]).toMatch(
      /^Сумма неполная: стоимость не внесена для 10 м³ из 30 м³ вывезенного$/,
    );
    expect(lines[1]).toBe('Стоимость вывоза снега вносится вручную при закрытии заявки');
    expect(lines.join(' ')).not.toMatch(/прайс/);
  });

  it('план и талоны в деньгах — прочерки без предупреждений о цене', () => {
    const notes = costNotes(
      {
        ...snow,
        plannedVolumeM3: 40,
        plannedVolumeUnpricedM3: 40,
        ticketVolumeM3: 20,
        ticketVolumeUnpricedM3: 20,
      },
      'snow',
    );
    expect(notes.map((n) => n.text)).toEqual(['план —', 'по талонам —']);
    expect(notes.every((n) => !n.warning || n.warning.length === 0)).toBe(true);
  });
});
