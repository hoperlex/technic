import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  DriverSelectionDto,
  FreightTransportRequestDto,
  RouteTripFields,
  SpecialEquipmentRequestDto,
  VehicleDto,
  VehicleRouteDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RecordedCall } from './http';
import { renderWithUser } from './render';
import { selectOption } from './antd';
import { list } from './factories/common';
import { vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

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
 *
 * Всё это форма выясняет четырьмя ручками, и мок стоит на них, а не на модуле портала: «запроса о
 * рейсе нет вовсе» — утверждение про сеть, и проверять его подменённым модулем значит проверять
 * сегодняшнюю раскладку файлов.
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
 * этого достаточно, чтобы путевого листа не было (ADR 0041). Тип ТС и объект те же, что у
 * грузоперевозки: подбор техники идёт по типу, а перегон подставляет адрес площадки.
 */
const ON_SITE_REQUEST: SpecialEquipmentRequestDto = vehicleRequest({
  id: 'r-2',
  num: 502,
  displayNumber: 'ТС-502',
  objectId: REQUEST.objectId,
  objectCode: REQUEST.objectCode,
  objectName: REQUEST.objectName,
  objectAddress: REQUEST.objectAddress,
  vehicleTypeId: REQUEST.vehicleTypeId,
  vehicleTypeName: REQUEST.vehicleTypeName,
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  // Начало работ — тот же день, на который заказана грузоперевозка: с него считается и перегон.
  dateFrom: '2026-08-10',
  dateTo: null,
});

/** Готовый рейс этой машины на этот день — в него заявка и поедет по умолчанию. */
const EXISTING_ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
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
const LAST_TRIP: RouteTripFields = {
  withTrailer: false,
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'пригородное',
  transportationKind: 'коммерческая',
};

/** Отбор водителей ведёт сервер: форма показывает его ответ и не пересобирает список. */
const SELECTION: DriverSelectionDto = {
  requiredCategory: 'C',
  drivers: [
    {
      personId: 'p-1',
      fullName: 'Тестовый Водитель Первый',
      personnelNo: 'Т-001',
      licenseNumber: '00 00 000001',
      licenseExpiresOn: '2031-03-12',
      verificationStatus: 'verified',
      categories: ['B', 'C'],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
  ],
};

/**
 * Назначение открывает форму на уже выбранной машине — так проверяется блок листа. Собирается из
 * самой машины, а не перечислением полей: назначение и есть снимок единицы парка, и разойтись с
 * ним оно не должно даже в тесте.
 */
const assignment = (v: VehicleDto) => ({
  vehicleId: v.id,
  ownership: v.ownership,
  typeName: v.typeName,
  categoryName: v.categoryName,
  modelName: v.modelName,
  registrationNumber: v.registrationNumber,
  description: v.description,
  lessorId: v.lessorId,
  lessorName: v.lessorName,
  pricePerHour: v.pricePerHour,
  pricePerShift: v.pricePerShift,
  shiftHours: v.shiftHours,
  assignedBy: 'user-1',
  assignedByName: 'Петров П. П.',
  assignedAt: '2026-08-01T10:00:00.000Z',
});

interface Case {
  /** Уже назначенная машина: окно открывается на ней. */
  vehicle?: VehicleDto;
  onSubmit?: (v: unknown) => void;
  request?: FreightTransportRequestDto | SpecialEquipmentRequestDto;
  /** Парк, который видит форма: сужается до одной собственной машины или расширяется до двух. */
  fleet?: VehicleDto[];
  /** Рейсы, которые сервер подсказывает на дату заявки. */
  routes?: VehicleRouteDto[];
}

/**
 * Форма вместе с четырьмя ручками, которыми она собирает рейс. Состав ответа задаётся тестом, а
 * не общим состоянием файла: тест, забывший вернуть парк на место, иначе ронял бы следующие.
 */
function renderModal({
  vehicle,
  onSubmit = () => {},
  request = REQUEST,
  fleet = [OWN_VEHICLE, RENTAL_VEHICLE],
  routes = [],
}: Case = {}): HttpMock {
  const http = mockHttp({
    'GET /vehicles': () => json(list(fleet)),
    /*
     * Подсказка приходит по типу заказанной техники и на дату из формы (ADR 0052): машину
     * диспетчер ещё не выбрал, а бланк закреплён за типом. Графы шапки здесь пусты — наследуются
     * они отдельной ручкой, уже по выбранной машине.
     */
    'GET /vehicle-requests/:id/route-prefill': ({ query }) =>
      json({
        required: true,
        formCode: '4p',
        formLabel: 'Форма 4-П (грузовой автомобиль)',
        reason: null,
        tripDate: query.get('date') ?? '2026-08-10',
        routes,
        trip: null,
      }),
    /** Реквизиты выезда наследуются по выбранной машине и дате рейса. */
    'GET /vehicle-routes/suggest': () => json({ routes: [], trip: LAST_TRIP }),
    'GET /drivers/available': () => json(SELECTION),
  });

  renderWithUser(
    <VehicleAssignModal
      request={{ ...request, assignment: vehicle ? assignment(vehicle) : null }}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return http;
}

/** Запросы отбора водителей по порядку: по ним видно, на какую дату форма их спрашивает. */
const driverCalls = (http: HttpMock): RecordedCall[] =>
  http.calls.filter((c) => c.method === 'GET' && c.path === '/drivers/available');

/** Запросы подсказки рейсов: по ним видно, с чем форма за ней ходила и ходила ли вообще. */
const prefillCalls = (http: HttpMock): RecordedCall[] =>
  http.calls.filter((c) => c.path.endsWith('/route-prefill'));

describe('маршрут в форме перевода в работу', () => {
  it('рейс спрашивается до машины и молча не подставляется', async () => {
    const http = renderModal({
      fleet: [OWN_VEHICLE, OWN_VEHICLE_2, RENTAL_VEHICLE],
      routes: [EXISTING_ROUTE],
    });
    await screen.findByText('Маршрут');

    // Машины ещё нет — и подсказка приходит без неё: рейсы того же типа ТС на дату заявки.
    // Проверяются все запросы: машина не должна попасть в них и позже, когда её выберут.
    expect(prefillCalls(http).length).toBeGreaterThan(0);
    expect(prefillCalls(http).every((c) => c.query.get('vehicleId') === null)).toBe(true);
    // Подставленный рейс выбрал бы и машину, а её выбирает человек: поле стоит на новом рейсе.
    // Ожиданием, а не мгновенной проверкой: значение ставит эффект по приходу подсказки, и до
    // отрисовки поле ещё пустое — на этом тест и был нестабилен в общем прогоне.
    expect(await screen.findByTitle('Новый маршрут')).toBeDefined();
  });

  it('выбранный рейс задаёт машину и запирает её поле', async () => {
    renderModal({
      fleet: [OWN_VEHICLE, OWN_VEHICLE_2, RENTAL_VEHICLE],
      routes: [EXISTING_ROUTE],
    });
    await screen.findByText('Маршрут');

    await selectOption('Рейс', /Р-12/);

    // Машина рейса подставлена, а поле заперто: «рейсом Р-12, но другой машиной» — расхождение,
    // на которое сервер ответил бы отказом.
    await waitFor(() => expect(screen.getByText(/Машину задал рейс Р-12/)).toBeDefined());
    expect(document.querySelector('#vehicleId')!.getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText(/водитель и реквизиты выезда там уже свои/)).toBeDefined();
  });

  it('на собственную машину предлагает готовый рейс этого дня', async () => {
    renderModal({ vehicle: OWN_VEHICLE, routes: [EXISTING_ROUTE] });
    await screen.findByText('Маршрут');

    // Рейс подставлен сам: диспетчер собирает день машины, а не заводит второй рейс на ту же дату.
    expect(await screen.findByTitle(/Р-12/)).toBeDefined();
    // Водитель и реквизиты выезда — свойства рейса: у готового их не переспрашивают.
    expect(screen.queryByText('Рейс с прицепом')).toBeNull();
    expect(screen.getByText(/водитель и реквизиты выезда там уже свои/)).toBeDefined();
  });

  it('когда рейса на этот день нет, спрашивает водителя и реквизиты нового', async () => {
    renderModal({ vehicle: OWN_VEHICLE, routes: [] });
    await screen.findByText('Маршрут');

    expect(await screen.findByText('Водитель')).toBeDefined();
    expect(screen.getByText('Рейс с прицепом')).toBeDefined();
    // Графы шапки подставлены от прошлого рейса этой машины — их не перенабирают каждый раз.
    // Приходят они вторым запросом (`suggest`), уже по выбранной машине, — отсюда ожидание.
    expect(await screen.findByDisplayValue('00000389')).toBeDefined();
    expect(screen.getByDisplayValue('пригородное')).toBeDefined();
  });

  it('готовый рейс уходит идентификатором, а не водителем и графами', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: OWN_VEHICLE, onSubmit, routes: [EXISTING_ROUTE] });
    await screen.findByTitle(/Р-12/);

    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const body = onSubmit.mock.calls[0]![0] as {
      assignment: { route?: { routeId?: string; newRoute?: unknown } };
    };
    expect(body.assignment.route).toEqual({ routeId: 'route-1' });
  });

  it('новый рейс уходит вместе с водителем и реквизитами выезда', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: OWN_VEHICLE, onSubmit, routes: [] });
    await screen.findByText('Водитель');
    // Графы шапки приходят вторым запросом: без ожидания форма уехала бы с пустым гаражным
    // номером, и проверка ниже поймала бы гонку, а не поведение.
    await screen.findByDisplayValue('00000389');

    // Водителя выбирают из тех, кого отобрал сервер: список — тот же, что проверит выписка листа.
    // Выбор идёт по подписи поля: на форме несколько выпадающих списков, и общий поиск по
    // документу молча уходил бы в чужой.
    await selectOption('Водитель', /Тестовый Водитель Первый/);

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
    const http = renderModal({ vehicle: OWN_VEHICLE, routes: [] });
    await screen.findByText('Маршрут');
    await waitFor(() => expect(driverCalls(http).length).toBeGreaterThan(0));
    expect(driverCalls(http)[0]!.query.get('on')).toBe('2026-08-10');

    // Подачу сдвинули на два дня — годность удостоверения проверяется уже на новый день.
    const dateInput = screen.getByDisplayValue('10.08.2026');
    fireEvent.change(dateInput, { target: { value: '12.08.2026' } });
    fireEvent.keyDown(dateInput, { key: 'Enter', keyCode: 13 });

    await waitFor(() => {
      expect(driverCalls(http).at(-1)!.query.get('on')).toBe('2026-08-12');
    });
  });

  it('у заказа техники на объект рейса нет и объяснения тоже: его в этом процессе не бывает', async () => {
    const http = renderModal({ vehicle: OWN_VEHICLE, request: ON_SITE_REQUEST });
    await screen.findByText('Конкретная техника');

    expect(screen.queryByText('Маршрут')).toBeNull();
    expect(screen.queryByText('Маршрут не ведётся')).toBeNull();
    expect(screen.queryByText('Водитель')).toBeNull();
    // Сервер о рейсе даже не спрашивается: спрашивать нечего, и лишний запрос выдал бы, что
    // портал всё-таки держит рейс в уме.
    expect(prefillCalls(http)).toHaveLength(0);
  });

  it('на аренду объясняет, почему рейса нет, а не прячет блок', async () => {
    renderModal({ vehicle: RENTAL_VEHICLE });
    await screen.findByText('Маршрут не ведётся');

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
    await screen.findByText('Фактическая дата подачи');

    expect(screen.getByDisplayValue('10.08.2026')).toBeDefined();
    expect(screen.getByDisplayValue('09:00')).toBeDefined();
    expect(screen.getByText('Заказано: 10.08.2026 09:00')).toBeDefined();
  });

  it('согласованное время уходит вместе с назначением техники', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: RENTAL_VEHICLE, onSubmit });
    await screen.findByDisplayValue('09:00');

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

/**
 * Доставка техники на объект (миграция 0082).
 *
 * Заказ техники на объект маршрута не знает — блока «Маршрут» у него нет и быть не должно
 * (ADR 0041), — но до площадки спецтехника доезжает своим ходом, и на эту поездку выписывается
 * 4-П. Предлагается она, а не требуется: ту же машину могут привезти тралом, и тогда листа не
 * бывает вовсе. Портал способ доставки не ведёт и не спрашивает.
 */
describe('доставка техники на объект', () => {
  it('предлагается заказу техники на объект — но блоком «Маршрут» не притворяется', async () => {
    renderModal({ vehicle: OWN_VEHICLE, request: ON_SITE_REQUEST });
    await screen.findByText('Доставка на объект');

    expect(screen.queryByText('Маршрут')).toBeNull();
    // Выключено по умолчанию: перегон — предложение, а не обязательный шаг.
    expect(screen.queryByLabelText('Дата перегона')).toBeNull();
  });

  it('включённая подставляет день начала работ и адрес объекта, а водителей просит на эту дату', async () => {
    const http = renderModal({ vehicle: OWN_VEHICLE, request: ON_SITE_REQUEST });
    await screen.findByText('Доставка на объект');

    fireEvent.click(screen.getByRole('checkbox', { name: /своим ходом/ }));

    expect(await screen.findByDisplayValue('Химки, ул. Победы, 10')).toBeDefined();
    expect(screen.getAllByDisplayValue('10.08.2026').length).toBeGreaterThan(0);
    // Допуск проверяется на день перегона: удостоверение могло истечь между заказом и выездом.
    await waitFor(() => expect(driverCalls(http).length).toBeGreaterThan(0));
    expect(driverCalls(http).at(-1)!.query.get('on')).toBe('2026-08-10');
  });

  it('уходит вместе с назначением — отдельным перегоном, а не рейсом заявки', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: OWN_VEHICLE, onSubmit, request: ON_SITE_REQUEST });
    await screen.findByText('Доставка на объект');

    fireEvent.click(screen.getByRole('checkbox', { name: /своим ходом/ }));
    await screen.findByDisplayValue('Химки, ул. Победы, 10');
    await selectOption('Водитель перегона', /Тестовый Водитель Первый/);
    fireEvent.change(screen.getByPlaceholderText('База, ул. Автомобильная, 3'), {
      target: { value: 'База, ул. Автомобильная, 3' },
    });
    fireEvent.click(screen.getByText('Взять в работу'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as {
      assignment: {
        route?: unknown;
        delivery?: { routeDate: string; driverPersonId: string; moveFrom: string; moveTo: string };
      };
    };
    // Рейса у заказа техники на объект нет — перегон едет своей записью.
    expect(body.assignment.route).toBeUndefined();
    expect(body.assignment.delivery).toEqual({
      routeDate: '2026-08-10',
      driverPersonId: 'p-1',
      moveFrom: 'База, ул. Автомобильная, 3',
      moveTo: 'Химки, ул. Победы, 10',
      trip: { communicationKind: 'городское' },
    });
  });

  it('без перегона заявка уходит как прежде: галочка ничего не добавляет молча', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: OWN_VEHICLE, onSubmit, request: ON_SITE_REQUEST });
    await screen.findByText('Доставка на объект');

    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as { assignment: { delivery?: unknown } };
    expect(body.assignment.delivery).toBeUndefined();
  });
});
