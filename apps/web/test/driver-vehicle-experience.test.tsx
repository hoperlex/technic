import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type {
  DriverOptionDto,
  DriverSelectionDto,
  FreightTransportRequestDto,
  VehicleDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { openSelectOptions } from './antd';
import { list } from './factories/common';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

/**
 * Водители, уже работавшие на выбранной машине, стоят первыми и помечены (ADR 0056).
 *
 * Проверяется ровно то, чем эта пометка живёт: порядок приходит с сервера, а форма его не
 * пересобирает — иначе правило существовало бы в двух видах и разошлось бы при первой правке.
 * Пометка обязательна: список перестал быть алфавитным, и без неё непонятно, почему человек
 * оказался наверху.
 *
 * «Порядок приходит с сервера» — утверждение про ответ ручки отбора, поэтому мок стоит на сети, а
 * не на модуле `api/resources`: подменённый модуль проверял бы, каким файлом портал сегодня зовёт
 * `/drivers/available`, а не то, что форма показывает пришедший список как есть.
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

function driver(
  over: Partial<DriverOptionDto> & Pick<DriverOptionDto, 'personId' | 'fullName'>,
): DriverOptionDto {
  return {
    personnelNo: '',
    licenseNumber: '00 00 000001',
    licenseExpiresOn: '2031-03-12',
    verificationStatus: 'verified',
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
const SELECTION: DriverSelectionDto = {
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
};

/**
 * Форма вместе с ручками, которыми она собирает рейс. Рейсов на эту дату нет — форма стоит на
 * «Новом рейсе», где и спрашивают водителя; графы шапки пусты, они этой проверке безразличны.
 */
function renderModal(): HttpMock {
  const http = mockHttp({
    'GET /vehicles': () => json(list([OWN_VEHICLE])),
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
    'GET /drivers/available': () => json(SELECTION),
  });

  renderWithUser(
    <VehicleAssignModal
      request={REQUEST}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );
  return http;
}

/** Пункты списка водителей в том порядке, в каком их видит диспетчер. */
async function driverOptions(): Promise<string[]> {
  // Список берётся из выпадашки самого поля: на форме несколько списков, и общий поиск по
  // документу молча уходил бы в чужой.
  const options = await openSelectOptions('Водитель');
  return options.map((o) => o.textContent ?? '');
}

describe('водители, работавшие на выбранной машине', () => {
  it('стоят первыми в том порядке, в каком их прислал сервер', async () => {
    const http = renderModal();
    await screen.findByText('Новый рейс');
    await waitFor(() => expect(http.countOf('GET /drivers/available')).toBeGreaterThan(0));

    const options = await driverOptions();
    expect(options.map((o) => o.split(' ')[0])).toEqual(['Яковлев', 'Петров', 'Абрамов']);
  });

  it('помечены в строке — иначе порядок списка ничем не объяснён', async () => {
    renderModal();
    await screen.findByText('Новый рейс');

    const options = await driverOptions();
    expect(options[0]).toContain('работал на этой машине');
    expect(options[1]).toContain('работал на этой машине');
    // Не работал — пометки нет: она означает опыт, а не то, что человек в списке.
    expect(options[2]).not.toContain('работал на этой машине');
  });
});
