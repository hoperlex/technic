import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { FreightTransportRequestDto, VehicleDto } from '@technic/contracts';

/**
 * Форма перевода заявки в работу выписывает путевой лист (ADR 0037): здесь проверяется, что она
 * спрашивает водителя ровно там, где лист выписывается, и объясняет причину там, где нет.
 *
 * Отсутствие блока читалось бы как поломка, поэтому «на аренду лист выписывает арендодатель» —
 * это текст на экране, а не пустое место.
 */

const OWN_VEHICLE: VehicleDto = {
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

const RENTAL_VEHICLE: VehicleDto = {
  ...OWN_VEHICLE,
  id: 'v-rent',
  ownership: 'rental',
  modelName: null,
  registrationNumber: null,
  lessorId: 'c-1',
  lessorName: 'ООО «Арендатех»',
  description: 'Самосвал 20 м³',
  pricePerShift: 28000,
};

const REQUEST: FreightTransportRequestDto = {
  id: 'r-1',
  num: 501,
  displayNumber: 'ТС-501',
  requestType: 'freight_transport',
  objectId: 'obj-1',
  objectCode: 'OBJ-A',
  objectName: 'Объект Химки',
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
  assignment: null,
  completion: null,
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

/** Подсказка о листе приходит по машине: собственная его получает, аренда — нет. */
const prefill = async (_id: string, vehicleId: string) =>
  vehicleId === 'v-own'
    ? {
        required: true,
        formLabel: 'Форма 4-П (грузовой автомобиль)',
        reason: null,
        tripDate: '2026-08-10',
        fields: {
          withTrailer: false,
          trailer1Model: '',
          trailer1RegNumber: '',
          trailer2Model: '',
          trailer2RegNumber: '',
          garageNumber: '00000389',
          communicationKind: 'пригородное',
          transportationKind: 'коммерческая',
        },
      }
    : {
        required: false,
        formLabel: null,
        reason: 'Путевой лист на арендную технику выписывает арендодатель',
        tripDate: '2026-08-10',
        fields: null,
      };

vi.mock('../src/api/resources', () => ({
  vehiclesApi: {
    list: async () => ({
      items: [OWN_VEHICLE, RENTAL_VEHICLE],
      total: 2,
      page: 1,
      pageSize: 500,
    }),
  },
  vehicleRequestsApi: { waybillPrefill: prefill },
  driversApi: {
    available: async () => ({
      requiredCategory: 'C',
      drivers: [
        {
          personId: 'p-1',
          fullName: 'Тестовый Водитель Первый',
          personnelNo: 'Т-001',
          licenseNumber: '00 00 000001',
          licenseExpiresOn: '2031-03-12',
          verificationStatus: 'verified' as const,
          categories: ['B', 'C'],
        },
      ],
    }),
  },
}));

const { VehicleAssignModal } = await import('../src/pages/vehicle/VehicleAssignModal');

/** Назначение открывает форму на уже выбранной машине — так проверяется блок листа. */
function assignment(vehicleId: string, ownership: 'own' | 'rental') {
  return {
    vehicleId,
    ownership,
    typeName: 'Самосвалы',
    categoryName: null,
    modelName: ownership === 'own' ? 'КамАЗ 65201' : null,
    registrationNumber: ownership === 'own' ? 'Е646СК799' : null,
    description: ownership === 'rental' ? 'Самосвал 20 м³' : '',
    lessorId: ownership === 'rental' ? 'c-1' : null,
    lessorName: ownership === 'rental' ? 'ООО «Арендатех»' : null,
    pricePerHour: null,
    pricePerShift: ownership === 'rental' ? 28000 : null,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-01T10:00:00.000Z',
  };
}

function renderModal(vehicleId?: string, ownership: 'own' | 'rental' = 'own') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App>
        <VehicleAssignModal
          request={{
            ...REQUEST,
            assignment: vehicleId ? assignment(vehicleId, ownership) : null,
          }}
          confirmLoading={false}
          onCancel={() => {}}
          onSubmit={() => {}}
        />
      </App>
    </QueryClientProvider>,
  );
}

describe('путевой лист в форме перевода в работу', () => {
  it('до выбора машины о листе не спрашивают: он выписывается на конкретную', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());
    expect(screen.queryByText('Путевой лист')).toBeNull();
  });

  it('на собственную машину спрашивает водителя и графы шапки', async () => {
    renderModal('v-own');
    await waitFor(() => expect(screen.getByText('Путевой лист')).toBeDefined());

    expect(screen.getByText('Форма 4-П (грузовой автомобиль) · на 2026-08-10')).toBeDefined();
    expect(screen.getByText('Водитель')).toBeDefined();
    expect(screen.getByText('Рейс с прицепом')).toBeDefined();
    // Графы шапки подставлены от прошлого листа этой машины — их не перенабирают каждый рейс.
    expect(screen.getByDisplayValue('00000389')).toBeDefined();
    expect(screen.getByDisplayValue('пригородное')).toBeDefined();
  });

  it('на аренду объясняет, почему листа нет, а не прячет блок', async () => {
    renderModal('v-rent', 'rental');
    await waitFor(() => expect(screen.getByText('Путевой лист не выписывается')).toBeDefined());

    expect(
      screen.getByText('Путевой лист на арендную технику выписывает арендодатель'),
    ).toBeDefined();
    expect(screen.queryByText('Водитель')).toBeNull();
  });
});
