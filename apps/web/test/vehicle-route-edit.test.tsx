import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { selectOption, typeDate } from './antd';
import { VehicleRouteEditModal } from '../src/pages/vehicle/VehicleRouteEditModal';

/**
 * Правка рейса: день, водитель и реквизиты выезда.
 *
 * Главное здесь — перенос дня. Он меняет не только строку рейса: заявка едет в тот день, в
 * который заведён рейс, и вместе с рейсом переезжает её подача. Поэтому проверяется, что перенос
 * спрашивают отдельным окном с перечнем заявок — «двигаю рейс» и «двигаю четыре чужих заказа» это
 * разные решения, и человек должен видеть, какое принимает.
 *
 * Второе — водитель: список подсказывает (пригодные первыми, с пометками), но никого не
 * подставляет сам, даже когда пригоден он один.
 */

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: '2026-08-07',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: null,
  driverName: '',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'городское',
  transportationKind: 'коммерческая',
  comment: '',
  requests: [
    {
      requestId: 'r-1',
      displayNumber: 'ТС-501',
      position: 1,
      status: 'confirmed',
      customerName: 'Объект А',
      loadingLocation: 'Карьер',
      unloadingLocation: 'Площадка 1',
      scheduledAt: '2026-08-07T06:00:00.000Z',
      scheduledTimeUnspecified: false,
      cargoLabel: '12 м³',
    },
  ],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 3,
};

/** Рейс, замороженный выданным листом: бумага у водителя, и править нечего. */
const FROZEN: VehicleRouteDto = {
  ...ROUTE,
  waybill: {
    id: 'w-1',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: '2026-08-07',
  },
};

const SELECTION = {
  requiredCategory: 'C',
  requiredCategoryType: 'driver_license',
  drivers: [
    {
      personId: 'p-1',
      fullName: 'Тестовый Водитель Первый',
      personnelNo: 'Т-001',
      credentialTypeCode: 'driver_license',
      licenseNumber: '00 00 000001',
      licenseExpiresOn: '2031-03-12',
      verificationStatus: 'verified',
      categories: ['C'],
      gaps: [],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
  ],
};

function renderModal(route: VehicleRouteDto = ROUTE) {
  const http = mockHttp({
    'GET /drivers/available': () => json(SELECTION),
    'PATCH /vehicle-routes/:id': ({ body }) => json({ ...route, ...(body as object) }),
  });
  renderWithUser(<VehicleRouteEditModal route={route} onClose={() => {}} onSaved={() => {}} />, {
    user: authUser({ role: 'admin' }),
  });
  return http;
}

describe('правка рейса', () => {
  it('водитель не подставляется сам, даже когда пригоден он один', async () => {
    renderModal();
    await screen.findByText('Дата рейса');

    // Единственный вариант в списке — но поле остаётся пустым: за руль сажает диспетчер.
    await waitFor(() => expect(screen.getByText('Выберите водителя')).toBeDefined());
  });

  it('смена водителя уходит на сервер вместе с версией рейса', async () => {
    const http = renderModal();
    await screen.findByText('Дата рейса');

    await selectOption('Водитель', /Тестовый Водитель Первый/);
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    const body = http.lastCall('PATCH /vehicle-routes/:id')!.body as Record<string, unknown>;
    expect(body.driverPersonId).toBe('p-1');
    expect(body.version).toBe(3);
    // День не трогали — он уходит прежним, и подтверждения переноса не было.
    expect(body.routeDate).toBe('2026-08-07');
  });

  it('перенос дня спрашивают отдельно и называют переезжающие заявки', async () => {
    const http = renderModal();
    await screen.findByText('Дата рейса');

    typeDate('Дата рейса', '12.08.2026');
    fireEvent.click(screen.getByText('Сохранить'));

    // Пока не подтвердили — на сервер ничего не ушло. Заголовок окна antd рисует дважды
    // (сам заголовок и его копия для чтения с экрана), поэтому ищем все совпадения.
    expect((await screen.findAllByText('Перенести маршрут на 12.08.2026?')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/ТС-501/).length).toBeGreaterThan(0);
    expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(0);

    fireEvent.click(screen.getByText('Перенести'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(1));
    expect(
      (http.lastCall('PATCH /vehicle-routes/:id')!.body as Record<string, unknown>).routeDate,
    ).toBe('2026-08-12');
  });

  it('рейс с выписанным листом не правится и объясняет почему', async () => {
    const http = renderModal(FROZEN);
    await screen.findByText('Дата рейса');

    expect(screen.getByText(/аннулируйте его, чтобы править рейс/)).toBeDefined();
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-routes/:id')).toBe(0));
  });
});
