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
  cardRemovedOn: null,
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

  /**
   * Снятая карточка (ADR 0190, Э4). Человек с машины никуда не делся, и строка обязана показать
   * его имя и телефон — но рядом стоит пометка: по этому заказу выпишется ещё бланк строгой
   * отчётности на удалённого, и узнать об этом надо здесь, а не в бухгалтерии заказчика.
   *
   * Проверяется именно **сочетание**: имя на месте, контакт на месте, пометка рядом. Строка,
   * которая от снятия карточки замолчала бы, была бы хуже — заказчику всё так же нужно звонить.
   */
  it('называет снятую карточку пометкой, не пряча ни имени, ни телефона', async () => {
    renderCard({ ...DRIVER, cardRemovedOn: '2026-09-14' });

    expect(await screen.findByText(DRIVER.fullName)).toBeDefined();
    expect(screen.getByRole('link', { name: '+7 (900) 123 45 67' })).toBeDefined();
    expect(screen.getByText('снят из справочника')).toBeDefined();
  });

  it('у живой карточки пометки нет', async () => {
    renderCard(DRIVER);

    expect(await screen.findByText(DRIVER.fullName)).toBeDefined();
    expect(screen.queryByText('снят из справочника')).toBeNull();
  });

  /**
   * Заказчик — первый, кому контакт и нужен: машину на площадке встречает он (ADR 0122). Права на
   * путевые листы у руководителя строительства нет и не появится, поэтому проверяется именно он:
   * пока строка спрашивала `waybills.read`, номер водителя приходилось узнавать у диспетчера.
   */
  it('показывает контакт заказчику, у которого нет права на путевые листы', async () => {
    const rukstroy = authUser({ role: 'rukstroy' });
    expect(rukstroy.permissions).not.toContain('waybills.read');

    const { http } = renderCard(DRIVER, rukstroy);

    expect(await screen.findByText(DRIVER.fullName)).toBeDefined();
    expect(screen.getByText('Водитель:')).toBeDefined();
    expect(screen.getByRole('link', { name: '+7 (900) 123 45 67' })).toBeDefined();
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/r1/driver')).toBe(1));
  });
});
