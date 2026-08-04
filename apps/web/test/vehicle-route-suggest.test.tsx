import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { vehicleRequest } from './factories/vehicle';
import { VehicleRouteTransferModal } from '../src/pages/vehicle/VehicleRouteTransferModal';

/**
 * Подбор рейсов к заявке идёт по **виду** ТС, а не по заказанному типу (ADR 0059).
 *
 * До этого правила рейс машины другого типа в подсказке не появлялся вовсе: день машины собирают
 * по объектам, а объекты заказывают разное — самосвал и бортовой, — и вторая заявка ехала
 * отдельным рейсом либо не ехала никак. Теперь такие рейсы предлагаются, но не молча: в строке
 * названы тип машины и направление («крупнее», «меньше заказанного»), а порядок ставит заказанный
 * тип первым и заведомо мелкий — последним.
 */

const BASE_ROUTE: VehicleRouteDto = {
  id: 'route-dump',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: '2026-08-03',
  vehicleId: 'v-dump',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleTypeId: 'type-flatbed',
  vehicleTypeName: 'Бортовые автомобили',
  vehicleCategoryId: 'cat-flatbed-5',
  vehicleCategorySpecs: { lift_capacity: 5 },
  driverPersonId: 'p-1',
  driverName: 'Тестовый Водитель Первый',
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '',
  communicationKind: '',
  transportationKind: '',
  comment: '',
  requests: [],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-01T09:00:00.000Z',
  version: 2,
};

/** Рейс машины заказанного типа: то, что предлагали и раньше. */
const ORDERED_TYPE_ROUTE: VehicleRouteDto = {
  ...BASE_ROUTE,
  id: 'route-ordered',
  displayNumber: 'Р-20',
  vehicleId: 'v-light',
  vehicleLabel: 'ГАЗель Next · Х001ХХ199',
  vehicleTypeId: 'type-light',
  vehicleTypeName: 'Грузовые малотоннажные автомобили',
  vehicleCategoryId: 'cat-light-3',
  vehicleCategorySpecs: { lift_capacity: 3 },
};

/** Рейс машины крупнее заказанной: другой тип, но по грузоподъёмности заявка в него влезает. */
const BIGGER_ROUTE = BASE_ROUTE;

/** Рейс машины мельче заказанной: предлагается, но последним — груз может не поместиться. */
const SMALLER_ROUTE: VehicleRouteDto = {
  ...BASE_ROUTE,
  id: 'route-small',
  displayNumber: 'Р-31',
  vehicleId: 'v-small',
  vehicleLabel: 'Ford Transit · У777УУ177',
  vehicleTypeId: 'type-flatbed',
  vehicleTypeName: 'Бортовые автомобили',
  vehicleCategoryId: 'cat-flatbed-1',
  vehicleCategorySpecs: { lift_capacity: 1 },
};

/** Заказан малотоннажный на 3 т, заявка уже едет рейсом Р-7 — из него её и переносят. */
const REQUEST = vehicleRequest({
  requestType: 'freight_transport',
  vehicleTypeId: 'type-light',
  vehicleTypeName: 'Грузовые малотоннажные автомобили',
  vehicleKindId: 'kind-freight',
  vehicleCategoryId: 'cat-light-3',
  vehicleCategoryName: 'Грузовые малотоннажные автомобили, г/п 3 т',
  vehicleCategorySpecs: { lift_capacity: 3 },
  status: 'confirmed',
  route: { id: 'route-7', displayNumber: 'Р-7', position: 1, hasWaybill: false, version: 4 },
  assignment: {
    vehicleId: 'v-light-2',
    ownership: 'own',
    vehicleTypeId: 'type-light',
    typeName: 'Грузовые малотоннажные автомобили',
    vehicleCategoryId: 'cat-light-3',
    categoryName: 'Грузовые малотоннажные автомобили, г/п 3 т',
    categorySpecs: { lift_capacity: 3 },
    modelName: 'ГАЗель',
    registrationNumber: 'А001АА777',
    description: '',
    lessorId: null,
    lessorName: null,
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-01T10:00:00.000Z',
  },
} as never);

function renderTransfer(routes: VehicleRouteDto[], onDone = vi.fn()) {
  const http = mockHttp({
    'GET /vehicle-requests/:id/route-prefill': () =>
      json({
        required: true,
        formCode: '4p',
        formLabel: 'Форма 4-П (грузовой автомобиль)',
        reason: null,
        tripDate: '2026-08-03',
        routes,
        trip: null,
      }),
    'POST /vehicle-routes/:id/requests': () => json(routes[0]),
  });
  renderWithUser(
    <VehicleRouteTransferModal request={REQUEST} onClose={() => {}} onDone={onDone} />,
  );
  return http;
}

/**
 * Пункты открытого списка рейсов — по ним видно и состав подсказки, и её порядок.
 *
 * Поле ждут открытым, а не жмут сразу: до ответа подсказки список пуст и заблокирован, а нажатие
 * по заблокированному не открывает ничего — тест падал бы на гонке, а не на правиле.
 */
async function openRouteList(): Promise<string[]> {
  const field = await waitFor(() => {
    const select = document.querySelector('.ant-select')!;
    expect(select.classList.contains('ant-select-disabled')).toBe(false);
    return select;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  return waitFor(() => {
    const items = [...document.querySelectorAll('.ant-select-item-option')].map(
      (o) => o.textContent ?? '',
    );
    expect(items.length).toBeGreaterThan(0);
    return items;
  });
}

describe('подбор рейсов к заявке с учётом более крупной техники', () => {
  it('рейс машины другого типа предлагается и помечен направлением', async () => {
    renderTransfer([BIGGER_ROUTE]);
    const options = await openRouteList();

    expect(options).toHaveLength(1);
    expect(options[0]).toContain('Р-12');
    expect(options[0]).toContain('другой тип, крупнее');
  });

  it('порядок: заказанный тип, крупнее, и только потом мельче заказанного', async () => {
    // Приходят вперемешку — раскладывает их портал, а не сервер.
    renderTransfer([SMALLER_ROUTE, BIGGER_ROUTE, ORDERED_TYPE_ROUTE]);
    const options = await openRouteList();

    expect(options.map((o) => o.slice(0, 4))).toEqual(['Р-20', 'Р-12', 'Р-31']);
    expect(options[2]).toContain('меньше заказанного');
  });

  it('выбран рейс крупнее — сказано, что заявка поедет его машиной, и это не тревога', async () => {
    renderTransfer([BIGGER_ROUTE]);
    const options = await openRouteList();
    fireEvent.click(document.querySelectorAll('.ant-select-item-option')[0]!);
    expect(options).toBeDefined();

    await waitFor(() =>
      expect(screen.getByText(/Заявка поедет машиной выбранного рейса/)).toBeDefined(),
    );
    expect(screen.getByText(/Техника крупнее заказанной/)).toBeDefined();
    expect(document.querySelector('.ant-alert-warning')).toBeNull();
  });

  it('выбран рейс мельче — то же действие, но предупреждением', async () => {
    renderTransfer([SMALLER_ROUTE]);
    await openRouteList();
    fireEvent.click(document.querySelectorAll('.ant-select-item-option')[0]!);

    await waitFor(() => expect(screen.getByText(/Техника меньше заказанной/)).toBeDefined());
    expect(document.querySelector('.ant-alert-warning')).toBeDefined();
  });

  it('перенос уходит парой «кто + версия» и не зависит от типа машины рейса', async () => {
    const http = renderTransfer([BIGGER_ROUTE]);
    await openRouteList();
    fireEvent.click(document.querySelectorAll('.ant-select-item-option')[0]!);
    await waitFor(() => expect(screen.getByText(/Заявка поедет машиной/)).toBeDefined());

    fireEvent.click(screen.getByText('Перенести'));
    await waitFor(() => expect(http.lastCall('POST /vehicle-routes/:id/requests')).toBeDefined());
    const body = http.lastCall('POST /vehicle-routes/:id/requests')!.body as {
      requestId: string;
      version: number;
      source: { routeId: string; version: number };
    };
    expect(body.requestId).toBe(REQUEST.id);
    expect(body.version).toBe(BIGGER_ROUTE.version);
    expect(body.source).toEqual({ routeId: 'route-7', version: 4 });
  });
});
