import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import type { WasteStatsDto } from '@technic/contracts';
import { useSearchParams } from 'react-router';
import { PageTabs } from '../src/components/PageTabs';
import { WasteStatsTab } from '../src/pages/waste/WasteStatsTab';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';

/**
 * Вкладка «Статистика» вывоза мусора (план `docs/waste-stats-tab-plan.md`).
 *
 * Проверяется то, что портал решает сам, — всё остальное считает сервер:
 *
 * - отчётный месяц берётся из адреса и им же уходит в запрос (Р9). Негодное значение вкладку не
 *   ломает: «статистику за август» шлют ссылкой, и чужая или обрезанная ссылка обязана открыть
 *   экран, а не пустоту;
 * - доли подписаны под числами (Р3, Р4). Без этих подписей колонка «подтверждено талонами»
 *   читается как недовывоз, хотя у незакрытой заявки талонов не бывает по порядку работы;
 * - окно детализации открывается нажатием на площадку и показывает пришедшие позиции со сводной
 *   строкой — своего запроса не делая (Р11).
 */

/** Пробелы в числах русской локали неразрывные — сравнивать текст можно только нормализовав. */
const text = (node: Element | null | undefined): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ');

const hasText = (needle: string) => (_content: string, node: Element | null) =>
  node?.children.length === 0 && text(node).includes(needle);

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
        volumeM3: 50,
        volumeOrderedM3: 15,
        totalCost: 4500,
        costEstimated: 1500,
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
            volumeM3: 45,
            volumeOrderedM3: 15,
            totalCost: 4500,
            costEstimated: 1500,
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
            volumeM3: 5,
            volumeOrderedM3: 0,
            totalCost: 0,
            costEstimated: 0,
            confirmedVolumeM3: 5,
            // Весь подтверждённый объём позиции без цены закрытия — отсюда и прочерк.
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
    totals: {
      volumeM3: 50,
      volumeOrderedM3: 15,
      totalCost: 4500,
      costEstimated: 1500,
      confirmedVolumeM3: 25,
      confirmedVolumeUnpricedM3: 5,
      confirmedCost: 2000,
      ticketsWithoutVolume: 1,
      unpricedRequests: 1,
      removals: 3,
      requests: 4,
    },
    quality: [
      {
        key: 'waste.removals_without_ticket',
        label: 'Вывозов без принятого талона',
        value: 1,
        outOf: 3,
        note: 'Объём и вес не подтверждены документом',
      },
    ],
    ...over,
  };
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

  it('строка показывает доли: сколько ещё не вывезено и сколько посчитано оценкой', async () => {
    renderTab('/waste?tab=stats&month=2026-05');

    await screen.findByText('ЖК Северный');
    // Именно строка данных: первым в `tbody` у antd идёт скрытый ряд измерения колонок.
    const row = document.querySelector('tbody tr.ant-table-row');
    expect(text(row)).toContain('50 м³');
    expect(text(row)).toContain('в т. ч. заказано 15 м³');
    expect(text(row)).toContain('4 500,00 ₽');
    expect(text(row)).toContain('в т. ч. оценка 1 500,00 ₽');
    // Ноль в денежной клетке обязан означать бесплатную работу, поэтому неоценённые названы.
    expect(text(row)).toContain('1 без цены');

    // Качество данных стоит рядом с числами, а не умалчивается.
    expect(screen.getByText(hasText('Вывозов без принятого талона: 1 из 3'))).toBeTruthy();
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
    expect(text(total)).toContain('50 м³');
    expect(text(total)).toContain('4 500,00 ₽');

    // У позиции без цены закрытия — прочерк, а не ноль: умножать подтверждённые кубы не на что.
    const ground = [...modal.querySelectorAll('tbody tr')].find((tr) => text(tr).includes('Грунт'));
    expect(text(ground)).toContain('—');
  });
});
