import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  moscowDateKeyOf,
  type DriverOptionDto,
  type FreightTransportRequestDto,
  type VehicleDto,
} from '@technic/contracts';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';
import { VehicleRouteModal } from '../src/pages/vehicle/VehicleRouteModal';
import { openSelectOptions } from './antd';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';

/**
 * Полнота документов водителя — справочная информация (ADR 0064).
 *
 * До этого правила водитель без СНИЛСа или без номера удостоверения в списке не появлялся вовсе, а
 * выписка листа на него падала с 422. Половина справочника заведена кадровой выгрузкой без
 * реквизитов ВУ (ADR 0047), человек при этом ездит — и диспетчер шёл заводить рейс мимо портала.
 *
 * Проверяется то, ради чего правило менялось: такой водитель в списке есть, стоит ниже годного,
 * помечен в строке, а последствие названо словами — какие графы бланка останутся пустыми. Дважды:
 * при выборе водителя и при выписке листа, где израсходуется номер бланка.
 */

const VEHICLE: VehicleDto = {
  id: 'v-own',
  ownership: 'own',
  vehicleKindId: 'kind-freight',
  kindName: 'Грузовой транспорт',
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
    vehicleKindId: 'kind-freight',
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
  deletedByName: null,
  scheduledAt: '2026-08-10T09:00:00+03:00',
  // Объект затрат выводится из пары «объект или отдел» под CHECK (Р25).
  costTarget: { kind: 'object', id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
  scheduledTimeUnspecified: false,
  // Ездка вместо пары адресов у заявки (план `docs/route-trips-plan.md`, Р1–Р2): у существующих
  // заявок она ровно одна, и сценарий от этого не меняется.
  trips: [
    {
      id: 'vrt-1',
      num: 1,
      displayNumber: 'Т-43/1',
      fromLocation: 'Карьер Мытищи',
      toLocation: 'Объект Химки',
      fromAddress: null,
      toAddress: null,
      volumeM3: 20,
      weightTons: null,
      fromResponsibleName: 'Петров П. П.',
      fromResponsiblePhone: '+7 926 000-00-01',
      toResponsibleName: 'Сидоров С. С.',
      toResponsiblePhone: '+7 926 000-00-02',
      scheduledAt: null,
      comment: '',
      placement: null,
    },
  ],
};

function driver(over: Partial<DriverOptionDto> & Pick<DriverOptionDto, 'personId' | 'fullName'>) {
  return {
    personnelNo: '',
    // Вид документа приходит с сервера: им подписаны и пометки, и предупреждение (ADR 0095).
    credentialTypeCode: 'driver_license' as const,
    licenseNumber: '00 00 000001',
    licenseExpiresOn: '2031-03-12',
    verificationStatus: 'verified' as const,
    categories: ['C'],
    gaps: [],
    matchesRequiredCategory: true,
    workedRoutes: 0,
    lastWorkedOn: null,
    ...over,
  };
}

/**
 * Порядок задан сервером: с полным комплектом первым, из выгрузки — вторым, хотя по алфавиту он
 * был бы выше. Форма список не пересобирает, иначе правило существовало бы в двух видах.
 */
const SELECTION = {
  requiredCategory: 'C',
  requiredCategoryType: 'driver_license',
  drivers: [
    driver({ personId: 'p-1', fullName: 'Яковлев Яков Яковлевич' }),
    driver({
      personId: 'p-2',
      fullName: 'Абрамов Абрам Абрамович',
      licenseNumber: '',
      gaps: ['requisites', 'issuedOn'],
    }),
  ],
};

function mockAssign() {
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
    'GET /vehicle-routes/suggest': () => json({ routes: [], trip: null, hitched: [] }),
    'GET /vehicle-types': () => json({ items: [], total: 0, page: 1, pageSize: 500 }),
    'GET /drivers/available': () => json(SELECTION),
  });
}

function renderAssign() {
  return renderWithUser(
    <VehicleAssignModal
      request={REQUEST}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );
}

/** Рейс, готовый к выписке: машина, водитель, одна заявка в работе и листа ещё нет. */
function route(driverGaps: string[]) {
  return {
    id: 'route-1',
    displayNumber: 'Р-12',
    purpose: 'freight' as const,
    formCode: '4p' as const,
    /**
     * Живой сегодняшний день, а не константа (ADR 0101, дыра 1): выписка на прошедший день с тех
     * пор уходит в окно коррекции — со своим правом, причиной и ключом операции, — и предупреждения
     * о пробелах документов там уже не спрашивают. Здесь проверяется именно оно, поэтому рейс
     * обязан быть сегодняшним; зафиксированная дата однажды станет прошлым и уронит тест.
     */
    routeDate: moscowDateKeyOf(new Date()),
    vehicleId: 'v-own',
    vehicleLabel: 'КамАЗ 65201 · Е646СК799',
    vehicleKindId: 'kind-freight',
    vehicleTypeId: 'type-dump',
    vehicleTypeName: 'Самосвалы',
    vehicleCategoryId: null,
    vehicleCategorySpecs: null,
    driverPersonId: 'p-2',
    driverName: 'Абрамов Абрам Абрамович',
    driverGaps,
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
    requests: [
      {
        requestId: 'r-1',
        position: 1,
        displayNumber: 'ТС-501',
        customerName: 'Объект Химки',
        status: 'confirmed' as const,
        loadingLocation: 'Карьер Мытищи',
        unloadingLocation: 'Объект Химки',
        cargoLabel: '20 м³',
      },
    ],
    sourceRequest: null,
    moveFrom: '',
    moveTo: '',
    waybill: null,
    createdByName: 'Иванов И. И.',
    createdAt: '2026-08-09T09:00:00.000Z',
    version: 1,
  };
}

describe('неполные документы водителя при выборе', () => {
  it('водитель из выгрузки остаётся в списке, но стоит ниже и помечен', async () => {
    mockAssign();
    renderAssign();
    await screen.findByText('Новый рейс');

    const options = await openSelectOptions('Водитель');
    // Алфавит уступил пригодности: Абрамов ниже Яковлева, потому что у него пустые графы бланка.
    expect(options.map((o) => o.textContent?.split(' ')[0])).toEqual(['Яковлев', 'Абрамов']);
    expect(options[1]!.textContent).toContain('без номера ВУ');
    expect(options[1]!.textContent).toContain('без даты выдачи ВУ');
    expect(options[0]!.textContent).not.toContain('без номера ВУ');
  });

  it('после выбора названы графы и бланк, в котором они останутся пустыми', async () => {
    mockAssign();
    renderAssign();
    await screen.findByText('Новый рейс');

    const options = await openSelectOptions('Водитель');
    fireEvent.click(options[1]!);

    const warning = await screen.findByText(/Водитель без номера ВУ/);
    expect(warning.textContent).toContain('4-П');
    expect(warning.textContent).toContain('останутся пустыми');
    // Именно предупреждение, а не запрет: кнопка перевода в работу на месте и жива.
    expect(screen.getByText('Взять в работу').closest('button')?.disabled).toBe(false);
  });

  it('водитель с полным комплектом предупреждения не поднимает', async () => {
    mockAssign();
    renderAssign();
    await screen.findByText('Новый рейс');

    const options = await openSelectOptions('Водитель');
    fireEvent.click(options[0]!);

    await waitFor(() => {
      const field = document.querySelector('#driverPersonId')?.closest('.ant-select');
      expect(field?.textContent).toContain('Яковлев');
    });
    expect(screen.queryByText(/останутся пустыми/)).toBeNull();
  });
});

describe('неполные документы водителя при выписке листа', () => {
  it('карточка рейса предупреждает до нажатия, а выписка спрашивает подтверждение', async () => {
    const issued = vi.fn();
    mockHttp({
      'GET /vehicle-routes/:id': () => json(route(['snils', 'requisites'])),
      'GET /vehicle-requests': () => json(list([])),
      'POST /vehicle-routes/:id/waybill': () => {
        issued();
        return json({ ...route(['snils', 'requisites']), version: 2 });
      },
    });
    renderWithUser(<VehicleRouteModal routeId="route-1" onClose={() => {}} onChanged={() => {}} />);

    // Предупреждение стоит в карточке: назначить другого человека проще, пока бланк не потрачен.
    const warning = await screen.findByText(/Водитель без СНИЛС, без номера ВУ/);
    expect(warning.textContent).toContain('4-П');

    // Клик в act: подтверждение antd рисует через свой холдер, и без него оно не успевает
    // появиться в разметке к моменту проверки.
    await act(async () => {
      fireEvent.click(screen.getByText('Выписать лист'));
    });
    // Подтверждение — потому что номер бланка расходуется навсегда. Заголовок antd печатает
    // дважды (видимый и для чтения с экрана), поэтому спрашивается набор, а не единственный узел.
    expect(screen.getAllByText('Выписать лист с незаполненными графами?').length).toBeGreaterThan(
      0,
    );
    expect(issued).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('Всё равно выписать'));
    });
    await waitFor(() => expect(issued).toHaveBeenCalled());
  });

  it('с полным комплектом лист выписывается сразу, без лишнего окна', async () => {
    const issued = vi.fn();
    mockHttp({
      'GET /vehicle-routes/:id': () => json(route([])),
      'GET /vehicle-requests': () => json(list([])),
      'POST /vehicle-routes/:id/waybill': () => {
        issued();
        return json({ ...route([]), version: 2 });
      },
    });
    renderWithUser(<VehicleRouteModal routeId="route-1" onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText('Выписать лист');
    expect(screen.queryByText(/останутся пустыми/)).toBeNull();

    fireEvent.click(screen.getByText('Выписать лист'));
    await waitFor(() => expect(issued).toHaveBeenCalled());
  });
});
