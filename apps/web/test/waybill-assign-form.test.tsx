import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type {
  FreightTransportRequestDto,
  SpecialEquipmentRequestDto,
  VehicleDto,
} from '@technic/contracts';

/**
 * Форма перевода заявки в работу кладёт её в рейс (маршруты): здесь проверяется, что она
 * спрашивает маршрут ровно там, где он ведётся, и объясняет причину там, где нет.
 *
 * Отсутствие блока читалось бы как поломка, поэтому «на аренду лист выписывает арендодатель» —
 * это текст на экране, а не пустое место.
 *
 * Ровно одно исключение — заказ техники на объект (ADR 0041): там нет ни блока, ни текста, ни
 * запроса к серверу. Объяснять отсутствие рейса, которого в этом процессе не существует, значит
 * наводить на мысль, что где-то он всё же бывает.
 *
 * Порядок вопросов задан ADR 0052: рейс спрашивается **до** машины и сам её задаёт — рейсы
 * подсказываются по типу заказанной техники, а выбранный запирает поле «Конкретная техника».
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

/**
 * Вторая собственная единица того же типа. Нужна там, где проверяется выбор: с одной машиной
 * `AutoSelect` подставляет её сам (единственный вариант), и «машина не выбрана» — состояние,
 * которого в такой форме не бывает.
 */
const OWN_VEHICLE_2: VehicleDto = {
  ...OWN_VEHICLE,
  id: 'v-own-2',
  modelName: 'МАЗ 6501',
  registrationNumber: 'А123ВС777',
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
  assignment: null,
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

/**
 * Заказ техники на объект той же машиной: разница с грузоперевозкой — только в виде заявки, и
 * этого достаточно, чтобы путевого листа не было (ADR 0041).
 */
const ON_SITE_REQUEST: SpecialEquipmentRequestDto = {
  id: 'r-2',
  num: 502,
  displayNumber: 'ТС-502',
  requestType: 'special_equipment',
  objectId: REQUEST.objectId,
  objectCode: REQUEST.objectCode,
  objectName: REQUEST.objectName,
  objectAddress: REQUEST.objectAddress,
  departmentId: null,
  departmentCode: null,
  departmentName: null,
  vehicleTypeId: REQUEST.vehicleTypeId,
  vehicleTypeName: REQUEST.vehicleTypeName,
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  status: 'new',
  comment: '',
  cancelReason: null,
  approvedBy: REQUEST.approvedBy,
  approvedByName: REQUEST.approvedByName,
  approvedAt: REQUEST.approvedAt,
  assignment: null,
  completion: null,
  route: null,
  files: [],
  version: 1,
  createdBy: REQUEST.createdBy,
  createdByName: REQUEST.createdByName,
  createdAt: REQUEST.createdAt,
  updatedAt: REQUEST.updatedAt,
  deletedAt: null,
  dateFrom: '2026-08-10',
  dateTo: null,
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 926 000-00-01',
  earlyEnd: null,
};

/** Готовый рейс этой машины на этот день — в него заявка и поедет по умолчанию. */
const EXISTING_ROUTE = {
  id: 'route-1',
  displayNumber: 'Р-12',
  routeDate: '2026-08-10',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-9',
  driverName: 'Сидоров Сидор Сидорович',
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'пригородное',
  transportationKind: 'коммерческая',
  comment: '',
  requests: [],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-09T09:00:00.000Z',
  version: 1,
};

/** Графы шапки от прошлого рейса машины: их наследует новый рейс, а готовому они уже свои. */
const LAST_TRIP = {
  withTrailer: false,
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'пригородное',
  transportationKind: 'коммерческая',
};

/**
 * Подсказка приходит по типу заказанной техники и на дату из формы (ADR 0052): машину диспетчер
 * ещё не выбрал, а бланк закреплён за типом. Ведётся ли рейс на выбранную единицу, форма решает
 * сама правилом из контрактов — по принадлежности машины.
 */
let routes = [EXISTING_ROUTE];
const prefill = vi.fn(async (_id: string, params: { vehicleId?: string; date?: string } = {}) => ({
  required: true,
  formCode: '4p' as const,
  formLabel: 'Форма 4-П (грузовой автомобиль)',
  reason: null,
  tripDate: params.date ?? '2026-08-10',
  routes: params.vehicleId ? routes.filter((r) => r.vehicleId === params.vehicleId) : routes,
  trip: params.vehicleId ? LAST_TRIP : null,
}));

/** Реквизиты выезда наследуются отдельной ручкой — по выбранной машине и дате рейса. */
const suggest = vi.fn(async (_q: { vehicleId: string; date: string }) => ({
  routes: [],
  trip: LAST_TRIP,
}));

/** Отбор водителей — шпион: по нему видно, на какую дату форма их спрашивает. */
const availableDrivers = vi.fn(async (_q: { vehicleId: string; on: string }) => ({
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
}));

/** Парк, который видит форма: тест сужает его до одной собственной машины или расширяет до двух. */
let fleet: VehicleDto[] = [OWN_VEHICLE, RENTAL_VEHICLE];

vi.mock('../src/api/resources', () => ({
  vehiclesApi: {
    list: async () => ({ items: fleet, total: fleet.length, page: 1, pageSize: 500 }),
  },
  vehicleRequestsApi: { routePrefill: prefill },
  vehicleRoutesApi: { suggest },
  driversApi: {
    available: (q: { vehicleId: string; on: string }) => availableDrivers(q),
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

function renderModal(
  vehicleId?: string,
  ownership: 'own' | 'rental' = 'own',
  onSubmit: (v: unknown) => void = () => {},
  request: FreightTransportRequestDto | SpecialEquipmentRequestDto = REQUEST,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App>
        <VehicleAssignModal
          request={{
            ...request,
            assignment: vehicleId ? assignment(vehicleId, ownership) : null,
          }}
          confirmLoading={false}
          onCancel={() => {}}
          onSubmit={onSubmit}
        />
      </App>
    </QueryClientProvider>,
  );
}

/** Выбор значения в AutoSelect: окно живёт в портале, поэтому поле ищется по id (ADR 0052). */
async function pickOption(fieldId: string, text: string) {
  const field = document.querySelector(`#${fieldId}`)!.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  await waitFor(() => expect(document.querySelector('.ant-select-item-option')).toBeTruthy());
  const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
    o.textContent?.includes(text),
  );
  fireEvent.click(option!);
}

describe('маршрут в форме перевода в работу', () => {
  it('рейс спрашивается до машины и молча не подставляется', async () => {
    routes = [EXISTING_ROUTE];
    fleet = [OWN_VEHICLE, OWN_VEHICLE_2, RENTAL_VEHICLE];
    prefill.mockClear();
    renderModal();
    await waitFor(() => expect(screen.getByText('Маршрут')).toBeDefined());

    // Машины ещё нет — и подсказка приходит без неё: рейсы того же типа ТС на дату заявки.
    expect(prefill.mock.calls[0]![1]?.vehicleId).toBeUndefined();
    // Подставленный рейс выбрал бы и машину, а её выбирает человек: поле стоит на новом рейсе.
    expect(screen.getByTitle('Новый маршрут')).toBeDefined();
    fleet = [OWN_VEHICLE, RENTAL_VEHICLE];
  });

  it('выбранный рейс задаёт машину и запирает её поле', async () => {
    routes = [EXISTING_ROUTE];
    fleet = [OWN_VEHICLE, OWN_VEHICLE_2, RENTAL_VEHICLE];
    renderModal();
    await waitFor(() => expect(screen.getByText('Маршрут')).toBeDefined());

    await pickOption('routeId', 'Р-12');

    // Машина рейса подставлена, а поле заперто: «рейсом Р-12, но другой машиной» — расхождение,
    // на которое сервер ответил бы отказом.
    await waitFor(() => expect(screen.getByText(/Машину задал рейс Р-12/)).toBeDefined());
    expect(document.querySelector('#vehicleId')!.getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText(/водитель и реквизиты выезда там уже свои/)).toBeDefined();
    fleet = [OWN_VEHICLE, RENTAL_VEHICLE];
  });

  it('на собственную машину предлагает готовый рейс этого дня', async () => {
    routes = [EXISTING_ROUTE];
    renderModal('v-own');
    await waitFor(() => expect(screen.getByText('Маршрут')).toBeDefined());

    // Рейс подставлен сам: диспетчер собирает день машины, а не заводит второй рейс на ту же дату.
    await waitFor(() => expect(screen.getByTitle(/Р-12/)).toBeDefined());
    // Водитель и реквизиты выезда — свойства рейса: у готового их не переспрашивают.
    expect(screen.queryByText('Рейс с прицепом')).toBeNull();
    expect(screen.getByText(/водитель и реквизиты выезда там уже свои/)).toBeDefined();
  });

  it('когда рейса на этот день нет, спрашивает водителя и реквизиты нового', async () => {
    routes = [];
    renderModal('v-own');
    await waitFor(() => expect(screen.getByText('Маршрут')).toBeDefined());

    expect(screen.getByText('Водитель')).toBeDefined();
    expect(screen.getByText('Рейс с прицепом')).toBeDefined();
    // Графы шапки подставлены от прошлого рейса этой машины — их не перенабирают каждый раз.
    // Приходят они вторым запросом (`suggest`), уже по выбранной машине, — отсюда ожидание.
    await waitFor(() => expect(screen.getByDisplayValue('00000389')).toBeDefined());
    expect(screen.getByDisplayValue('пригородное')).toBeDefined();
  });

  it('готовый рейс уходит идентификатором, а не водителем и графами', async () => {
    routes = [EXISTING_ROUTE];
    const onSubmit = vi.fn();
    renderModal('v-own', 'own', onSubmit);
    await waitFor(() => expect(screen.getByText(/Р-12/)).toBeDefined());

    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const body = onSubmit.mock.calls[0]![0] as {
      assignment: { route?: { routeId?: string; newRoute?: unknown } };
    };
    expect(body.assignment.route).toEqual({ routeId: 'route-1' });
  });

  it('новый рейс уходит вместе с водителем и реквизитами выезда', async () => {
    routes = [];
    const onSubmit = vi.fn();
    renderModal('v-own', 'own', onSubmit);
    await waitFor(() => expect(screen.getByText('Водитель')).toBeDefined());

    // Водителя выбирают из тех, кого отобрал сервер: список — тот же, что проверит выписка листа.
    // Поле ищется по id: окно живёт в портале, и querySelector надёжнее порядкового номера.
    const driverField = document.querySelector('#driverPersonId')!.closest('.ant-select')!;
    fireEvent.mouseDown(driverField.querySelector('.ant-select-selector') ?? driverField);
    await waitFor(() => expect(document.querySelector('.ant-select-item-option')).toBeTruthy());
    fireEvent.click(document.querySelector('.ant-select-item-option')!);

    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const body = onSubmit.mock.calls[0]![0] as {
      assignment: {
        route?: { newRoute?: { driverPersonId?: string; trip?: { garageNumber?: string } } };
      };
    };
    expect(body.assignment.route?.newRoute?.driverPersonId).toBe('p-1');
    expect(body.assignment.route?.newRoute?.trip?.garageNumber).toBe('00000389');
  });

  it('водителей спрашивает на ту дату, которую назначили в форме, а не на заказанную', async () => {
    routes = [];
    availableDrivers.mockClear();
    renderModal('v-own');
    await waitFor(() => expect(screen.getByText('Маршрут')).toBeDefined());
    await waitFor(() => expect(availableDrivers).toHaveBeenCalled());
    expect(availableDrivers.mock.calls[0]![0].on).toBe('2026-08-10');

    // Подачу сдвинули на два дня — годность удостоверения проверяется уже на новый день.
    const dateInput = screen.getByDisplayValue('10.08.2026');
    fireEvent.change(dateInput, { target: { value: '12.08.2026' } });
    fireEvent.keyDown(dateInput, { key: 'Enter', keyCode: 13 });

    await waitFor(() => {
      const last = availableDrivers.mock.calls.at(-1)![0];
      expect(last.on).toBe('2026-08-12');
    });
  });

  it('у заказа техники на объект рейса нет и объяснения тоже: его в этом процессе не бывает', async () => {
    prefill.mockClear();
    renderModal('v-own', 'own', () => {}, ON_SITE_REQUEST);
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());

    expect(screen.queryByText('Маршрут')).toBeNull();
    expect(screen.queryByText('Маршрут не ведётся')).toBeNull();
    expect(screen.queryByText('Водитель')).toBeNull();
    // Сервер о рейсе даже не спрашивается: спрашивать нечего, и лишний запрос выдал бы, что
    // портал всё-таки держит рейс в уме.
    expect(prefill).not.toHaveBeenCalled();
  });

  it('на аренду объясняет, почему рейса нет, а не прячет блок', async () => {
    renderModal('v-rent', 'rental');
    await waitFor(() => expect(screen.getByText('Маршрут не ведётся')).toBeDefined());

    expect(
      screen.getByText('Путевой лист на арендную технику выписывает арендодатель'),
    ).toBeDefined();
    expect(screen.queryByText('Водитель')).toBeNull();
  });
});

/**
 * Фактический срок (заказанное время планируемое): форма открывается на заказанном, показывает
 * его же справкой и отдаёт согласованное вместе с назначением — одним переходом в работу.
 */
describe('фактический срок в форме перевода в работу', () => {
  it('поля подставлены заказанным, а заказанное остаётся видно рядом', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Фактическая дата подачи')).toBeDefined());

    expect(screen.getByDisplayValue('10.08.2026')).toBeDefined();
    expect(screen.getByDisplayValue('09:00')).toBeDefined();
    expect(screen.getByText('Заказано: 10.08.2026 09:00')).toBeDefined();
  });

  it('согласованное время уходит вместе с назначением техники', async () => {
    const onSubmit = vi.fn();
    renderModal('v-rent', 'rental', onSubmit);
    await waitFor(() => expect(screen.getByDisplayValue('09:00')).toBeDefined());

    const timeInput = screen.getByDisplayValue('09:00');
    fireEvent.change(timeInput, { target: { value: '10:30' } });
    fireEvent.blur(timeInput);
    fireEvent.click(screen.getByText('Взять в работу'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as {
      assignment: { vehicleId: string };
      schedule: { requestType: string; scheduledAt: string; scheduledTimeUnspecified: boolean };
    };
    expect(body.assignment.vehicleId).toBe('v-rent');
    expect(body.schedule.requestType).toBe('freight_transport');
    expect(body.schedule.scheduledAt).toBe('2026-08-10T10:30:00+03:00');
    expect(body.schedule.scheduledTimeUnspecified).toBe(false);
  });
});
