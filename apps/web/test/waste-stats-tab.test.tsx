import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import type { WasteStatsDto } from '@technic/contracts';
import { useSearchParams } from 'react-router';
import { PageTabs } from '../src/components/PageTabs';
import { WasteStatsTab } from '../src/pages/waste/WasteStatsTab';
import { confirmedNotes, pluralForm } from '../src/pages/waste/wasteStatsNumbers';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';

/**
 * The waste "Statistics" tab (ADR 0193, three-volume columns — ADR 0209).
 *
 * What is checked is what the portal decides itself — everything else is counted by the server:
 *
 * - the reporting month comes from the address and goes to the request with it (R9); a bad value
 *   does not break the tab;
 * - the columns and captions of ADR 0209: Ordered · Removed · By tickets · Cost, "N заявок" under
 *   the ordered volume only, the plan and the confirmed cost under the cost, every caption on a line
 *   of its own, a dash instead of zero where nothing has a price, no "N без цены" (decision Z7);
 * - the "Итого" row prints the server total, not a sum of the rows;
 * - a response without the new fields (a new build against an old server) shows a stub instead of
 *   throwing in render;
 * - the site window opens by a click on the site and shows the positions that came with the row,
 *   without a request of its own (R11).
 */

/** Пробелы в числах русской локали неразрывные — сравнивать текст можно только нормализовав. */
const text = (node: Element | null | undefined): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ');

const hasText = (needle: string) => (_content: string, node: Element | null) =>
  node?.children.length === 0 && text(node).includes(needle);

/** Deprecated combined fields: required by the type, no longer read by the tab. */
const LEGACY = { volumeM3: 0, volumeOrderedM3: 0, totalCost: 0, costEstimated: 0 };

function dto(over: Partial<WasteStatsDto> = {}): WasteStatsDto {
  return {
    month: '2026-05',
    from: '2026-05-01',
    to: '2026-05-31',
    rows: [
      {
        objectId: 'obj-1',
        code: 'СЕВ-1',
        name: 'ЖК Северный',
        isActive: true,
        ...LEGACY,
        plannedVolumeM3: 60,
        plannedCost: 5400,
        plannedVolumeUnpricedM3: 6,
        doneVolumeM3: 45,
        doneCost: 4000,
        doneVolumeUnpricedM3: 5,
        confirmedVolumeM3: 25,
        confirmedVolumeUnpricedM3: 5,
        confirmedCost: 2000,
        ticketsWithoutVolume: 1,
        unpricedRequests: 1,
        removals: 3,
        requests: 4,
        positions: [
          {
            key: 'removal|wt-1|-',
            label: 'Строительный мусор',
            ...LEGACY,
            plannedVolumeM3: 55,
            plannedCost: 5400,
            plannedVolumeUnpricedM3: 1,
            doneVolumeM3: 40,
            doneCost: 4000,
            doneVolumeUnpricedM3: 0,
            confirmedVolumeM3: 20,
            confirmedVolumeUnpricedM3: 0,
            confirmedCost: 2000,
            ticketsWithoutVolume: 1,
            unpricedRequests: 0,
            removals: 2,
            requests: 3,
          },
          {
            key: 'removal|wt-2|-',
            label: 'Грунт',
            ...LEGACY,
            // Nothing of this position has a price: dashes, not zeros.
            plannedVolumeM3: 5,
            plannedCost: null,
            plannedVolumeUnpricedM3: 5,
            doneVolumeM3: 5,
            doneCost: null,
            doneVolumeUnpricedM3: 5,
            confirmedVolumeM3: 5,
            confirmedVolumeUnpricedM3: 5,
            confirmedCost: null,
            ticketsWithoutVolume: 0,
            unpricedRequests: 1,
            removals: 1,
            requests: 1,
          },
        ],
      },
    ],
    // Deliberately NOT the sum of the rows: the "Итого" row must print the server total.
    totals: {
      ...LEGACY,
      plannedVolumeM3: 70,
      plannedCost: 6400,
      plannedVolumeUnpricedM3: 6,
      doneVolumeM3: 52,
      doneCost: 4700,
      doneVolumeUnpricedM3: 5,
      confirmedVolumeM3: 30,
      confirmedVolumeUnpricedM3: 5,
      confirmedCost: 2500,
      ticketsWithoutVolume: 1,
      unpricedRequests: 1,
      removals: 4,
      requests: 5,
    },
    quality: [
      {
        key: 'waste.removals_without_ticket',
        label: 'Вывозов без принятого талона',
        value: 1,
        outOf: 3,
        note: 'Объём и вес не подтверждены документом',
      },
      {
        key: 'waste.requests_without_ordered_volume',
        label: 'Заявок вывоза без заказанного объёма',
        value: 1,
        outOf: 5,
        note: 'Заказанный объём не указан',
      },
    ],
    ...over,
  };
}

/** The same response as an old server sends it: without the ADR 0209 fields. */
function legacyDto(): WasteStatsDto {
  const strip = (f: object) => {
    const copy: Record<string, unknown> = { ...f };
    for (const key of [
      'plannedVolumeM3',
      'plannedCost',
      'plannedVolumeUnpricedM3',
      'doneVolumeM3',
      'doneCost',
      'doneVolumeUnpricedM3',
    ]) {
      delete copy[key];
    }
    return copy;
  };
  const body = dto();
  return {
    ...body,
    rows: body.rows.map((r) => ({ ...strip(r), positions: r.positions.map(strip) })),
    totals: strip(body.totals),
  } as unknown as WasteStatsDto;
}

/** The first data row: antd puts a hidden measure row first in `tbody`. */
function firstRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>('tbody tr.ant-table-row');
  if (!row) throw new Error('строки таблицы нет');
  return row;
}

/**
 * Адрес в тесте живёт в `MemoryRouter`, а не в `window.location`, — спросить его можно только у
 * того, кто внутри. Без этого зонда проверить, что смена месяца не потеряла вкладку, нечем.
 */
function AddressProbe() {
  const [sp] = useSearchParams();
  return <div data-testid="address">{sp.toString()}</div>;
}

/** Вкладка живёт внутри `PageTabs`: без него она не знает, что открыта, и запроса не делает. */
function renderTab(route: string, body: WasteStatsDto = dto()): HttpMock {
  const http = mockHttp({
    'GET /waste-requests/stats': ({ query }) =>
      json({ ...body, month: query.get('month') ?? body.month }),
  });
  renderWithUser(
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
  return http;
}

const monthOf = (http: HttpMock): string | null =>
  http.calls.find((c) => c.path === '/waste-requests/stats')?.query.get('month') ?? null;

describe('вывоз: вкладка «Статистика»', () => {
  it('отчётный месяц берётся из адреса и им же уходит в запрос', async () => {
    const http = renderTab('/waste?tab=stats&month=2026-05');

    await screen.findByText('ЖК Северный');
    expect(monthOf(http)).toBe('2026-05');
    // Поле подписано по-русски: «май 2026», а не «2026-05».
    const picker = document.querySelector<HTMLInputElement>('.ant-picker input');
    expect(picker?.value).toBe('май 2026');
  });

  it('негодный месяц в адресе открывает текущий, а не пустоту', async () => {
    const http = renderTab('/waste?tab=stats&month=2026-13');

    await screen.findByText('ЖК Северный');
    expect(monthOf(http)).toBe(dayjs().format('YYYY-MM'));
  });

  it('смена месяца уходит в запрос и не теряет вкладку из адреса', async () => {
    const http = renderTab('/waste?tab=stats&month=2026-05');
    await screen.findByText('ЖК Северный');

    // Панель выбора месяца открывается нажатием на поле, дальше — ячейка нужного месяца.
    const input = document.querySelector<HTMLInputElement>('.ant-picker input');
    if (!input) throw new Error('поля месяца нет');
    // Календарь в jsdom мышью не открывается — месяц набирают руками и подтверждают Enter, тем же
    // приёмом, что и период в тестах сводки показаний.
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'июль 2026' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() => {
      const months = http.calls
        .filter((c) => c.path === '/waste-requests/stats')
        .map((c) => c.query.get('month'));
      expect(months).toContain('2026-07');
    });
    /*
     * Вкладка обязана остаться в адресе: страница переключает вкладки, чистя адрес целиком, и
     * запись одного лишь месяца вернула бы человека на «Заявки» нажатием на календарь.
     */
    const address = screen.getByTestId('address').textContent ?? '';
    expect(address).toContain('tab=stats');
    expect(address).toContain('month=2026-07');
  });

  it('строка: три объёма и стоимость вывезенного, план и талоны — подписями под ней', async () => {
    renderTab('/waste?tab=stats&month=2026-05');
    await screen.findByText('ЖК Северный');

    const head = document.querySelector('thead');
    for (const title of ['Площадка', 'Заказано', 'Вывезено', 'По талонам', 'Стоимость']) {
      expect(text(head)).toContain(title);
    }

    const row = firstRow();
    const r = within(row);
    expect(text(row)).toContain('60 м³');
    expect(text(row)).toContain('45 м³');
    expect(text(row)).toContain('25 м³');
    expect(text(row)).toContain('4 000,00 ₽');
    expect(r.getByText('4 заявки')).toBeTruthy();
    expect(r.getByText('план 5 400,00 ₽, без цены 6 м³')).toBeTruthy();
    expect(r.getByText('по талонам 2 000,00 ₽')).toBeTruthy();
    expect(r.getByText('объём не прочитан у 1 талона')).toBeTruthy();
    // Two captions read the same — under the removed cost and under the tickets — and both are shown.
    expect(r.getAllByText('без цены 5 м³')).toHaveLength(2);
    /*
     * Every caption is a line of its own: inline captions in a row are glued into one string, and
     * a check by `textContent` would not notice.
     */
    for (const node of [
      r.getByText(/^план /),
      r.getByText(/^по талонам /),
      r.getByText('4 заявки'),
    ]) {
      expect(node.style.display).toBe('block');
    }
    // "N без цены" is not shown (decision Z7), while "без цены … м³" in the same row is legitimate.
    expect(r.queryByText(/^\d+ без цены$/)).toBeNull();

    // Quality is shown next to the numbers, the new rows of ADR 0209 included.
    expect(screen.getByText(hasText('Вывозов без принятого талона: 1 из 3'))).toBeTruthy();
    expect(screen.getByText(hasText('Заявок вывоза без заказанного объёма: 1 из 5'))).toBeTruthy();
  });

  it('«Итого» печатает итог сервера, а полоса сводки — только счётчики', async () => {
    renderTab('/waste?tab=stats&month=2026-05');
    await screen.findByText('ЖК Северный');

    const total = document.querySelector<HTMLElement>('div.ant-table-summary');
    expect(text(total)).toContain('Итого');
    for (const value of ['70 м³', '52 м³', '30 м³', '4 700,00 ₽', '5 заявок']) {
      expect(text(total)).toContain(value);
    }
    expect(text(total)).toContain('по талонам 2 500,00 ₽');

    const body = text(document.body);
    expect(body).toContain('Площадок: 1');
    expect(body).toContain('Заявок: 5');
    expect(body).toContain('Вывозов: 4');
    // The volumes and the money moved to the "Итого" row (decision Z9).
    expect(body).not.toContain('Объём:');
    expect(body).not.toContain('Подтверждено:');
  });

  it('ответ старого сервера показывает заглушку, а не роняет портал', async () => {
    renderTab('/waste?tab=stats&month=2026-05', legacyDto());

    expect(
      await screen.findByText('Сервер ещё отдаёт статистику в прежнем виде — обновите страницу'),
    ).toBeTruthy();
    // No table and no total — so there is no site to open a window for either.
    expect(screen.queryByText('ЖК Северный')).toBeNull();
    expect(document.querySelector('.ant-table-summary')).toBeNull();
  });

  it('нажатие на площадку открывает детализацию со сводной строкой и без нового запроса', async () => {
    const http = renderTab('/waste?tab=stats&month=2026-05');

    fireEvent.click(await screen.findByText('ЖК Северный'));
    const modal = await waitFor(() => {
      const el = document.querySelector('.ant-modal-body');
      if (!el) throw new Error('окно не открылось');
      return el as HTMLElement;
    });

    // Позиции — те самые, что приехали со строкой; второго запроса окно не делает.
    expect(within(modal).getByText('Строительный мусор')).toBeTruthy();
    expect(within(modal).getByText('Грунт')).toBeTruthy();
    expect(http.calls.filter((c) => c.path === '/waste-requests/stats')).toHaveLength(1);

    // Непрочитанная графа названа: недостачу ищут в бумаге, а не в закрытии.
    expect(text(modal)).toContain('объём не прочитан у 1 талона');

    const total = modal.querySelector('.ant-table-summary tr');
    expect(text(total)).toContain('Итого');
    // The window's total is the site row itself: 60 / 45 / 25 m3 and 4 000 RUB.
    for (const value of ['60 м³', '45 м³', '25 м³', '4 000,00 ₽', '4 заявки']) {
      expect(text(total)).toContain(value);
    }

    // A position without any price: dashes, not zeros — there is nothing to multiply by.
    const ground = [...modal.querySelectorAll('tbody tr')].find((tr) => text(tr).includes('Грунт'));
    expect(text(ground)).toContain('план —');
    expect(text(ground)).toContain('по талонам —');
  });
});

describe('вывоз: числа вкладки «Статистика»', () => {
  it('«N заявок» склоняется', () => {
    const forms = ['заявка', 'заявки', 'заявок'] as const;
    expect([1, 4, 5, 11, 21, 22, 112].map((n) => `${n} ${pluralForm(n, forms)}`)).toEqual([
      '1 заявка',
      '4 заявки',
      '5 заявок',
      '11 заявок',
      '21 заявка',
      '22 заявки',
      '112 заявок',
    ]);
  });

  it('после «у» талоны стоят в родительном падеже', () => {
    const unread = (n: number) =>
      confirmedNotes({ ...dto().totals, ticketsWithoutVolume: n }).find((x) => x.key === 'unread')
        ?.text;
    expect(unread(1)).toBe('объём не прочитан у 1 талона');
    expect(unread(2)).toBe('объём не прочитан у 2 талонов');
    expect(unread(21)).toBe('объём не прочитан у 21 талона');
    expect(unread(11)).toBe('объём не прочитан у 11 талонов');
  });
});
