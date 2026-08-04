import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { DriverOptionDto, FreightTransportRequestDto, VehicleDto } from '@technic/contracts';

/**
 * Водители, уже работавшие на выбранной машине, стоят первыми и помечены (ADR 0056).
 *
 * Проверяется ровно то, чем эта пометка живёт: порядок приходит с сервера, а форма его не
 * пересобирает — иначе правило существовало бы в двух видах и разошлось бы при первой правке.
 * Пометка обязательна: список перестал быть алфавитным, и без неё непонятно, почему человек
 * оказался наверху.
 */

const OWN_VEHICLE: VehicleDto = {
  id: 'v-own',
  ownership: 'own',
  vehicleTypeId: 'type-dump',
  typeName: 'Самосвалы',
  waybillFormCode: '4p',
  vehicleCategoryId: null,
  categoryName: null,
  categorySpecs: null,
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
  vehicleKindId: 'kind-freight',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  status: 'new',
  comment: '',
  cancelReason: null,
  approvedBy: 'user-1',
  approvedByName: 'Руков Р. Р.',
  approvedAt: '2026-08-01T09:00:00.000Z',
  assignment: {
    vehicleId: 'v-own',
    ownership: 'own',
    vehicleTypeId: 'type-dump',
    typeName: 'Самосвалы',
    vehicleCategoryId: null,
    categoryName: null,
    categorySpecs: null,
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
    // Категория у всех подходит: её влияние на порядок и пометки проверяется отдельно
    // (`driver-category-advisory`), а здесь она размечала бы весь список одинаково.
    matchesRequiredCategory: true,
    workedRoutes: 0,
    lastWorkedOn: null,
    ...over,
  };
}

/**
 * Ответ сервера уже отсортирован: работавшие первыми, по свежести. Алфавит поставил бы первым
 * Абрамова — на нём и видно, что форма не сортирует список заново.
 */
const availableDrivers = vi.fn(async (_q: { vehicleId: string; on: string }) => ({
  requiredCategory: 'C',
  drivers: [
    driver({
      personId: 'p-2',
      fullName: 'Яковлев Яков Яковлевич',
      workedRoutes: 12,
      lastWorkedOn: '2026-07-14',
    }),
    driver({
      personId: 'p-3',
      fullName: 'Петров Пётр Петрович',
      workedRoutes: 2,
      lastWorkedOn: '2026-02-03',
    }),
    driver({ personId: 'p-1', fullName: 'Абрамов Абрам Абрамович' }),
  ],
}));

/** Рейсов на эту дату нет — форма стоит на «Новом маршруте», где и спрашивают водителя. */
const prefill = vi.fn(async (_id: string, params: { date?: string } = {}) => ({
  required: true,
  formCode: '4p' as const,
  formLabel: 'Форма 4-П (грузовой автомобиль)',
  reason: null,
  tripDate: params.date ?? '2026-08-10',
  routes: [],
  trip: null,
}));

const suggest = vi.fn(async (_q: { vehicleId: string; date: string }) => ({
  routes: [],
  trip: null,
}));

vi.mock('../src/api/resources', () => ({
  vehiclesApi: {
    list: async () => ({ items: [OWN_VEHICLE], total: 1, page: 1, pageSize: 500 }),
  },
  vehicleRequestsApi: { routePrefill: prefill },
  vehicleRoutesApi: { suggest },
  driversApi: {
    available: (q: { vehicleId: string; on: string }) => availableDrivers(q),
  },
}));

const { VehicleAssignModal } = await import('../src/pages/vehicle/VehicleAssignModal');

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App>
        <VehicleAssignModal
          request={REQUEST}
          confirmLoading={false}
          onCancel={() => {}}
          onSubmit={() => {}}
        />
      </App>
    </QueryClientProvider>,
  );
}

/** Пункты списка водителей в том порядке, в каком их видит диспетчер. */
async function driverOptions(): Promise<string[]> {
  const field = document.querySelector('#driverPersonId')!.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  await waitFor(() => expect(document.querySelector('.ant-select-item-option')).toBeTruthy());
  return [...document.querySelectorAll('.ant-select-item-option')].map((o) => o.textContent ?? '');
}

describe('водители, работавшие на выбранной машине', () => {
  it('стоят первыми в том порядке, в каком их прислал сервер', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Новый рейс')).toBeDefined());
    await waitFor(() => expect(availableDrivers).toHaveBeenCalled());

    const options = await driverOptions();
    expect(options.map((o) => o.split(' ')[0])).toEqual(['Яковлев', 'Петров', 'Абрамов']);
  });

  it('помечены в строке — иначе порядок списка ничем не объяснён', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Новый рейс')).toBeDefined());

    const options = await driverOptions();
    expect(options[0]).toContain('работал на этой машине');
    expect(options[1]).toContain('работал на этой машине');
    // Не работал — пометки нет: она означает опыт, а не то, что человек в списке.
    expect(options[2]).not.toContain('работал на этой машине');
  });
});
