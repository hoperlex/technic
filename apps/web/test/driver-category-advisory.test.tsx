import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriverOptionDto, FreightTransportRequestDto, VehicleDto } from '@technic/contracts';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';

/**
 * Категория прав — справочная информация (ADR 0055).
 *
 * Проверяется то, ради чего правило менялось: водитель с чужой категорией из списка не исчезает,
 * расхождение названо словами, а выбрать его портал не мешает. Пометки в строке мало — её читают
 * при выборе и забывают, поэтому после выбора расхождение повторяется предупреждением, где названы
 * обе стороны: что требует машина и что открыто у водителя.
 */

const VEHICLE: VehicleDto = {
  id: 'v-own',
  ownership: 'own',
  vehicleTypeId: 'type-dump',
  typeName: 'Самосвалы',
  vehicleCategoryId: null,
  categoryName: null,
  vehicleModelId: 'm-1',
  modelName: 'КамАЗ 65201',
  registrationNumber: 'Е646СК799',
  passportNumber: null,
  lessorId: null,
  lessorName: null,
  lessorIsActive: null,
  deactivatedWithLessor: false,
  description: '',
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  status: 'active',
  note: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const REQUEST: FreightTransportRequestDto = {
  id: 'r-1',
  num: 501,
  displayNumber: 'ТС-501',
  requestType: 'freight_transport',
  objectId: 'obj-1',
  objectCode: 'OBJ-A',
  objectName: 'Объект Химки',
  objectAddress: 'Химки, ул. Победы, 10',
  departmentId: null,
  departmentCode: null,
  departmentName: null,
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  status: 'new',
  comment: '',
  cancelReason: null,
  approvedBy: 'user-1',
  approvedByName: 'Руков Р. Р.',
  approvedAt: '2026-08-01T09:00:00.000Z',
  assignment: {
    vehicleId: 'v-own',
    ownership: 'own',
    typeName: 'Самосвалы',
    categoryName: null,
    modelName: 'КамАЗ 65201',
    registrationNumber: 'Е646СК799',
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
  completion: null,
  route: null,
  files: [],
  version: 1,
  createdBy: 'user-1',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  deletedAt: null,
  scheduledAt: '2026-08-10T09:00:00+03:00',
  scheduledTimeUnspecified: false,
  volumeM3: 20,
  weightTons: null,
  loadingLocation: 'Карьер Мытищи',
  unloadingLocation: 'Объект Химки',
  loadingAddress: null,
  unloadingAddress: null,
  loadingResponsibleName: 'Петров П. П.',
  loadingResponsiblePhone: '+7 926 000-00-01',
  unloadingResponsibleName: 'Сидоров С. С.',
  unloadingResponsiblePhone: '+7 926 000-00-02',
};

function driver(over: Partial<DriverOptionDto> & Pick<DriverOptionDto, 'personId' | 'fullName'>) {
  return {
    personnelNo: '',
    licenseNumber: '00 00 000001',
    licenseExpiresOn: '2031-03-12',
    verificationStatus: 'verified' as const,
    categories: ['C'],
    matchesRequiredCategory: true,
    workedRoutes: 0,
    lastWorkedOn: null,
    ...over,
  };
}

/**
 * Машине нужна CE, а у Петрова открыта только C. Порядок задан сервером: подходящий первым — форма
 * список не пересобирает, иначе правило существовало бы в двух видах.
 */
const SELECTION = {
  requiredCategory: 'CE',
  drivers: [
    driver({ personId: 'p-1', fullName: 'Абрамов Абрам Абрамович', categories: ['C', 'CE'] }),
    driver({
      personId: 'p-2',
      fullName: 'Петров Пётр Петрович',
      categories: ['C'],
      matchesRequiredCategory: false,
    }),
  ],
};

function mockAssign(selection: typeof SELECTION = SELECTION) {
  return mockHttp({
    'GET /vehicles': () => json(list([VEHICLE])),
    'GET /vehicle-requests/:id/route-prefill': ({ query }) =>
      json({
        required: true,
        formCode: '4p',
        formLabel: 'Форма 4-П (грузовой автомобиль)',
        reason: null,
        tripDate: query.get('date') ?? '2026-08-10',
        routes: [],
        trip: null,
      }),
    'GET /vehicle-routes/suggest': () => json({ routes: [], trip: null }),
    'GET /drivers/available': () => json(selection),
  });
}

function renderModal() {
  return renderWithUser(
    <VehicleAssignModal
      request={REQUEST}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );
}

/** Само поле «Водитель»: селектов на форме несколько, и различает их только имя поля. */
const driverField = () => document.querySelector('#driverPersonId')!.closest('.ant-select')!;

/** Пункты списка водителей — в том виде, в каком их читает диспетчер. */
async function openDrivers(): Promise<HTMLElement[]> {
  const field = driverField();
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  await waitFor(() => expect(document.querySelector('.ant-select-item-option')).toBeTruthy());
  return [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
}

describe('категория прав при выборе водителя', () => {
  it('водитель с чужой категорией остаётся в списке и помечен', async () => {
    mockAssign();
    renderModal();
    await screen.findByText('Новый рейс');

    const options = await openDrivers();
    expect(options.map((o) => o.textContent?.split(' ')[0])).toEqual(['Абрамов', 'Петров']);
    expect(options[1]!.textContent).toContain('категория не подходит');
    // У подходящего пометки нет: предупреждение на каждой строке обесценивает себя.
    expect(options[0]!.textContent).not.toContain('категория не подходит');
  });

  it('после выбора расхождение названо обеими сторонами, а не одним фактом «не совпало»', async () => {
    mockAssign();
    renderModal();
    await screen.findByText('Новый рейс');

    const options = await openDrivers();
    fireEvent.click(options[1]!);

    const warning = await screen.findByText(/Машине нужна категория «CE»/);
    expect(warning.textContent).toContain('C');
    expect(warning.textContent).toContain('Рейс заведётся как есть');
  });

  it('подходящий водитель предупреждения не поднимает', async () => {
    mockAssign();
    renderModal();
    await screen.findByText('Новый рейс');

    const options = await openDrivers();
    fireEvent.click(options[0]!);

    await waitFor(() => expect(driverField().textContent).toContain('Абрамов'));
    expect(screen.queryByText(/Машине нужна категория/)).toBeNull();
  });

  it('пустой список объясняется комплектом документов, а не категорией', async () => {
    mockAssign({ requiredCategory: 'CE', drivers: [] });
    renderModal();
    await screen.findByText('Новый рейс');

    expect(await screen.findByText(/Нет водителей с полным комплектом документов/)).toBeTruthy();
  });
});
