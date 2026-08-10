import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { VehicleRequestAssignmentDto, VehicleRequestDriverDto } from '@technic/contracts';
import { VehicleRequestViewModal } from '../src/pages/vehicle/VehicleRequestViewModal';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';

/** Назначение, у которого ставка и контакт должны читаться одной строкой карточки. */
const ASSIGNMENT: VehicleRequestAssignmentDto = {
  vehicleId: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  vehicleCategoryId: 'vc-1',
  categoryName: 'г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Е646СК799',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: 2500,
  pricePerShift: 18_000,
  shiftHours: 8,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Д. П.',
  assignedAt: '2026-08-02T08:00:00.000Z',
};

const DRIVER: VehicleRequestDriverDto = {
  personId: 'person-1',
  fullName: 'Иванов Иван Иванович',
  phone: '+7 900 123-45-67',
};

const REQUEST = vehicleRequest({ id: 'r1', status: 'confirmed', assignment: ASSIGNMENT });

function renderCard(
  driver: VehicleRequestDriverDto | null,
  user = authUser({ role: 'dispatcher' }),
) {
  const http = mockHttp({
    'GET /vehicle-requests/r1/history': () => json([]),
    'GET /vehicle-requests/r1/driver': () => json(driver),
    'GET /vehicle-requests/r1/waybills': () => json([]),
    'GET /vehicle-requests/r1/relocations': () => json([]),
  });
  const result = renderWithUser(<VehicleRequestViewModal request={REQUEST} onClose={() => {}} />, {
    user,
  });
  return { ...result, http };
}

describe('водитель в строке техники карточки заявки', () => {
  it('показывает ФИО и кликабельный телефон на одном уровне со ставкой', async () => {
    renderCard(DRIVER);

    const name = await screen.findByText(DRIVER.fullName);
    const rate = screen.getByText(/2.*500.*₽\/час/);
    const line = rate.closest<HTMLElement>('.ant-space');
    expect(line).toBeTruthy();
    expect(within(line!).getByText('Водитель:')).toBeDefined();
    expect(within(line!).getByText(DRIVER.fullName)).toBe(name);

    const phone = within(line!).getByRole('link', { name: '+7 (900) 123 45 67' });
    expect(phone.getAttribute('href')).toBe('tel:+79001234567');
  });

  it('объясняет незаполненный телефон и отсутствие назначенного водителя', async () => {
    const { unmount } = renderCard({ ...DRIVER, phone: '' });
    expect(await screen.findByText('телефон не указан')).toBeDefined();
    unmount();

    renderCard(null);
    expect(await screen.findByText('не назначен')).toBeDefined();
  });

  it('не запрашивает и не показывает контакт роли без права на путевые листы', async () => {
    const { http } = renderCard(DRIVER, authUser({ role: 'rukstroy' }));
    await screen.findByText(/2.*500.*₽\/час/);

    await waitFor(() => expect(http.countOf('GET /vehicle-requests/r1/driver')).toBe(0));
    expect(screen.queryByText('Водитель:')).toBeNull();
    expect(screen.queryByText(DRIVER.fullName)).toBeNull();
  });
});
