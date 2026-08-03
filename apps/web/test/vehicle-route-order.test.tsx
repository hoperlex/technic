import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { VehicleRouteDto } from '@technic/contracts';

/**
 * Карточка рейса: порядок заявок — это талоны бланка 4-П, и переставляются они стрелками
 * (позиций максимум четыре, а перетаскивание внутри таблицы на телефоне требует своего решения).
 *
 * Проверяется два правила, каждое из которых легко потерять при правках:
 *   1. порядок уходит на сервер **полным составом** — сервер переписывает талоны одним заходом,
 *      и «подвинуть одну строку» здесь не бывает;
 *   2. выписанный лист карточку замораживает — ни стрелок, ни изъятия, ни добавления, потому что
 *      бланк уже у водителя (ADR 0037 п. 9).
 */

const REQUEST_A = {
  requestId: 'r-a',
  displayNumber: 'ТС-501',
  position: 1,
  status: 'confirmed' as const,
  customerName: 'Объект А',
  loadingLocation: 'Карьер',
  unloadingLocation: 'Площадка 1',
  scheduledAt: '2026-08-03T06:00:00.000Z',
  scheduledTimeUnspecified: false,
  cargoLabel: '12 м³',
};

const REQUEST_B = { ...REQUEST_A, requestId: 'r-b', displayNumber: 'ТС-502', position: 2 };

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  routeDate: '2026-08-03',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-1',
  driverName: 'Тестовый Водитель Первый',
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: '',
  transportationKind: '',
  comment: '',
  requests: [REQUEST_A, REQUEST_B],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-01T09:00:00.000Z',
  version: 3,
};

const ISSUED_ROUTE: VehicleRouteDto = {
  ...ROUTE,
  waybill: {
    id: 'w-1',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: '2026-08-03',
  },
};

/**
 * Кандидаты на добавление в рейс: свободная заявка, заявка чужого рейса (её переносят) и заявка
 * рейса, замороженного выписанным листом, — последнюю предлагать нельзя (ADR 0052).
 */
const FREE_REQUEST = {
  id: 'r-free',
  displayNumber: 'ТС-701',
  requestType: 'freight_transport' as const,
  loadingLocation: 'Карьер',
  unloadingLocation: 'Площадка 3',
  assignment: { ownership: 'own' as const, vehicleId: 'v-own' },
  route: null,
};

const REQUEST_IN_OTHER_ROUTE = {
  ...FREE_REQUEST,
  id: 'r-other',
  displayNumber: 'ТС-702',
  assignment: { ownership: 'own' as const, vehicleId: 'v-other' },
  route: { id: 'route-9', displayNumber: 'Р-9', position: 2, hasWaybill: false, version: 5 },
};

const REQUEST_IN_FROZEN_ROUTE = {
  ...FREE_REQUEST,
  id: 'r-frozen',
  displayNumber: 'ТС-703',
  route: { id: 'route-8', displayNumber: 'Р-8', position: 1, hasWaybill: true, version: 2 },
};

const order = vi.fn(async (_id: string, _body: { requestIds: string[]; version: number }) => ROUTE);
const detach = vi.fn(async () => ROUTE);
const attach = vi.fn(
  async (
    _id: string,
    _body: { requestId: string; version: number; source?: { routeId: string; version: number } },
  ) => current,
);
let current: VehicleRouteDto = ROUTE;
let candidates: unknown[] = [];

vi.mock('../src/api/resources', () => ({
  vehicleRoutesApi: {
    get: async () => current,
    order: (id: string, body: { requestIds: string[]; version: number }) => order(id, body),
    detach: () => detach(),
    attach: (
      id: string,
      body: { requestId: string; version: number; source?: { routeId: string; version: number } },
    ) => attach(id, body),
    issueWaybill: async () => current,
  },
  vehicleRequestsApi: {
    list: async () => ({
      items: candidates,
      total: candidates.length,
      page: 1,
      pageSize: 500,
    }),
  },
  waybillsApi: {
    cancel: async () => ({}),
    printPdf: async () => new Blob(),
    exportUrl: (id: string) => `/waybills/${id}/export`,
  },
}));

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, user: { role: 'dispatcher' } }),
}));

const { VehicleRouteModal } = await import('../src/pages/vehicle/VehicleRouteModal');

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App>
        <VehicleRouteModal routeId="route-1" onClose={() => {}} onChanged={() => {}} />
      </App>
    </QueryClientProvider>,
  );
}

describe('порядок заявок в рейсе', () => {
  it('стрелка вверх отправляет весь состав в новом порядке', async () => {
    current = ROUTE;
    order.mockClear();
    renderModal();

    const up = await screen.findByLabelText('Поднять ТС-502');
    fireEvent.click(up);

    await waitFor(() => expect(order).toHaveBeenCalledTimes(1));
    expect(order).toHaveBeenCalledWith('route-1', {
      requestIds: ['r-b', 'r-a'],
      version: 3,
    });
  });

  it('первую заявку выше не поднять, последнюю ниже не опустить', async () => {
    current = ROUTE;
    renderModal();

    // jest-dom в проекте не подключён: смотрим на сам атрибут, как в auto-select.test.tsx.
    expect((await screen.findByLabelText('Поднять ТС-501')).hasAttribute('disabled')).toBe(true);
    expect((await screen.findByLabelText('Опустить ТС-502')).hasAttribute('disabled')).toBe(true);
  });

  it('выписанный лист замораживает рейс: правок в карточке нет, и сказано почему', async () => {
    current = ISSUED_ROUTE;
    candidates = [];
    renderModal();

    expect(await screen.findByText(/аннулируйте его, чтобы править рейс/i)).toBeTruthy();
    expect(screen.queryByLabelText('Поднять ТС-502')).toBeNull();
    expect(screen.queryByLabelText('Убрать ТС-501')).toBeNull();
    // Второй лист по рейсу не выписывается — кнопка остаётся, но нажать её нельзя.
    expect(screen.getByRole('button', { name: 'Выписать лист' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

/**
 * Открыть список кандидатов: у antd плейсхолдер — не атрибут поля, а свой элемент, поэтому поле
 * ищется по нему и открывается тем же mouseDown, каким его открывает человек.
 */
/** Тексты пунктов открытого списка: antd рисует их и в самом списке, и в подписи выбранного. */
const optionTexts = () =>
  [...document.querySelectorAll('.ant-select-item-option')].map((n) => n.textContent ?? '');

async function openCandidates() {
  // Сначала — что список кандидатов доехал: до него поле пустует и открывать в нём нечего.
  await screen.findByText(/свободная или из другого рейса/i);
  const field = [...document.querySelectorAll('.ant-select')].at(-1)!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

/**
 * Перенос заявки из чужого рейса (ADR 0052): переложить ТС-702 из Р-9 сюда — одно действие, а не
 * «вынуть и положить» двумя, между которыми заявка висит в работе без маршрута.
 */
describe('перенос заявки в этот рейс', () => {
  it('заявка чужого рейса подписана рейсом и уходит вместе с ним в source', async () => {
    current = ROUTE;
    candidates = [FREE_REQUEST, REQUEST_IN_OTHER_ROUTE];
    attach.mockClear();
    renderModal();

    await openCandidates();
    // Подпись говорит, откуда заявку забирают: диспетчер не должен думать, что она свободна.
    const option = await screen.findByText(/ТС-702.*из Р-9, талон 2/);
    fireEvent.click(option.closest('.ant-select-item-option') ?? option);

    // Кнопка называет действие своим именем — это перенос, а не добавление.
    fireEvent.click(await screen.findByText('Перенести'));

    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    expect(attach).toHaveBeenCalledWith('route-1', {
      requestId: 'r-other',
      version: 3,
      // Исходный рейс — парой «кто + версия»: одинокая версия совпала бы случайно.
      source: { routeId: 'route-9', version: 5 },
    });
  });

  it('заявку из замороженного рейса не предлагают: из бумаги у водителя она не исчезнет', async () => {
    current = ROUTE;
    candidates = [FREE_REQUEST, REQUEST_IN_FROZEN_ROUTE];
    renderModal();

    await openCandidates();

    await waitFor(() => expect(optionTexts().some((t) => t.includes('ТС-701'))).toBe(true));
    expect(optionTexts().some((t) => t.includes('ТС-703'))).toBe(false);
  });

  it('свободная заявка добавляется без source — забирать её не у кого', async () => {
    current = ROUTE;
    candidates = [FREE_REQUEST];
    attach.mockClear();
    renderModal();

    await openCandidates();
    await waitFor(() => expect(optionTexts().some((t) => t.includes('ТС-701'))).toBe(true));
    const free = [...document.querySelectorAll('.ant-select-item-option')].find((n) =>
      n.textContent?.includes('ТС-701'),
    )!;
    fireEvent.click(free);
    fireEvent.click(await screen.findByText('Добавить'));

    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    expect(attach.mock.calls[0]![1]).toEqual({
      requestId: 'r-free',
      version: 3,
      source: undefined,
    });
  });
});
