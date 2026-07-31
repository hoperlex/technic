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

const order = vi.fn(async (_id: string, _body: { requestIds: string[]; version: number }) => ROUTE);
const detach = vi.fn(async () => ROUTE);
let current: VehicleRouteDto = ROUTE;

vi.mock('../src/api/resources', () => ({
  vehicleRoutesApi: {
    get: async () => current,
    order: (id: string, body: { requestIds: string[]; version: number }) => order(id, body),
    detach: () => detach(),
    attach: async () => current,
    issueWaybill: async () => current,
  },
  vehicleRequestsApi: {
    list: async () => ({ items: [], total: 0, page: 1, pageSize: 500 }),
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
