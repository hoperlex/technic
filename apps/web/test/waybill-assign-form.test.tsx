import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  DriverDto,
  DriverSelectionDto,
  FreightTransportRequestDto,
  RouteTripFields,
  SpecialEquipmentRequestDto,
  VehicleDto,
  VehicleRouteDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RecordedCall } from './http';
import { renderWithUser } from './render';
import { dateInput, selectOption, typeDate } from './antd';
import { list } from './factories/common';
import { machinist, vehicleRequest } from './factories/vehicle';
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

/** Машинист недельных листов ЭСМ-2: без него заказ техники на объект в работу не уходит. */
const MACHINIST = machinist();

/**
 * Заказ техники на объект той же машиной: разница с грузоперевозкой — только в виде заявки, и
 * этого достаточно, чтобы путевого листа на рейс не было (ADR 0041). Свой документ у неё есть —
 * недельные ЭСМ-2 (миграция 0087), и их выписывает уже сам перевод в работу. Тип ТС и объект те
 * же, что у грузоперевозки: подбор техники идёт по типу, а перегон подставляет адрес площадки.
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
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: 'p-9',
  driverName: 'Сидоров Сидор Сидорович',
  driverGaps: [],
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
  // Порядок объезда сценарию не нужен: он проверяет рейс целиком, а не сборку дня.
  points: [],
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
      categories: ['B', 'C'],
      gaps: [],
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
  vehicleKindId: v.vehicleKindId,
  vehicleTypeId: v.vehicleTypeId,
  typeName: v.typeName,
  vehicleCategoryId: v.vehicleCategoryId,
  categoryName: v.categoryName,
  categorySpecs: v.categorySpecs,
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
  /**
   * Справочник водителей, из которого выбирают машиниста. По умолчанию — один: столько их обычно
   * и нужно сценарию. Единственный вариант поле подставляет само (`AutoSelect`), поэтому там, где
   * проверяется «машиниста не выбрали», список задают длиннее.
   */
  machinists?: DriverDto[];
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
  machinists = [MACHINIST],
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
    /*
     * Машинист заказа техники на объект (миграция 0087): на него выписываются недельные листы
     * ЭСМ-2. Список приходит из справочника целиком, а не отбором под машину: граф СНИЛС и
     * удостоверения в том бланке нет, и отбирать по ним некого (ADR 0055).
     */
    'GET /drivers': () => json(list(machinists)),
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
    expect(screen.getByText(/реквизиты выезда там уже свои/)).toBeDefined();
  });

  it('на собственную машину предлагает готовый рейс этого дня', async () => {
    renderModal({ vehicle: OWN_VEHICLE, routes: [EXISTING_ROUTE] });
    await screen.findByText('Маршрут');

    // Рейс подставлен сам: диспетчер собирает день машины, а не заводит второй рейс на ту же дату.
    expect(await screen.findByTitle(/Р-12/)).toBeDefined();
    // Реквизиты выезда — свойства рейса: у готового их не переспрашивают. Водителя с недавних пор
    // спрашивают и здесь (ADR 0048): рейс тот же, а за рулём может ехать другой человек.
    expect(screen.queryByText('Рейс с прицепом')).toBeNull();
    expect(screen.getByText(/реквизиты выезда там уже свои/)).toBeDefined();
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

  it('включённая подставляет адрес объекта, но не дату: её называет человек', async () => {
    const http = renderModal({ vehicle: OWN_VEHICLE, request: ON_SITE_REQUEST });
    await screen.findByText('Доставка на объект');

    fireEvent.click(screen.getByRole('checkbox', { name: /своим ходом/ }));

    // Место известно заранее — техника едет на площадку заявки. День не известен никому: её
    // привозят и накануне, и через день после начала работ.
    expect(await screen.findByDisplayValue('Химки, ул. Победы, 10')).toBeDefined();
    expect(dateInput('Дата перегона').value).toBe('');
    // Пока дня нет, водителей не спрашивают вовсе: годность удостоверения считается на него.
    expect(driverCalls(http)).toHaveLength(0);

    typeDate('Дата перегона', '10.08.2026');

    await waitFor(() => expect(driverCalls(http).length).toBeGreaterThan(0));
    expect(driverCalls(http).at(-1)!.query.get('on')).toBe('2026-08-10');
  });

  it('уходит вместе с назначением — отдельным перегоном, а не рейсом заявки', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: OWN_VEHICLE, onSubmit, request: ON_SITE_REQUEST });
    await screen.findByText('Доставка на объект');

    fireEvent.click(screen.getByRole('checkbox', { name: /своим ходом/ }));
    await screen.findByDisplayValue('Химки, ул. Победы, 10');
    // День перегона называет диспетчер — поле открывается пустым, и без него список водителей
    // заперт: удостоверение проверяется на день выезда.
    typeDate('Дата перегона', '10.08.2026');
    await selectOption('Водитель перегона', /Тестовый Водитель Первый/);
    // Машинист — не водитель перегона: тот везёт технику на объект и едет по 4-П, а этот работает
    // на площадке неделями, и на него выписываются ЭСМ-2.
    await selectOption('Машинист', new RegExp(MACHINIST.fullName));
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

    await selectOption('Машинист', new RegExp(MACHINIST.fullName));
    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as { assignment: { delivery?: unknown } };
    expect(body.assignment.delivery).toBeUndefined();
  });
});

/**
 * Машинист заказа техники на объект (миграция 0087).
 *
 * Заявку берут в работу — и на каждую неделю её срока рождается лист ЭСМ-2. Выписываются они на
 * человека, поэтому поле обязательное: лист без машиниста бухгалтерия не примет. Отбора у списка
 * нет никакого — в бланке нет ни СНИЛС, ни водительского удостоверения, — и это ровно то, чем он
 * отличается от «Водителя» рейса выше.
 */
describe('машинист и недельные листы ЭСМ-2', () => {
  it('спрашивается у заказа техники на объект и обещает, сколько бланков уйдёт', async () => {
    renderModal({ vehicle: OWN_VEHICLE, request: ON_SITE_REQUEST });

    expect(await screen.findByLabelText('Машинист')).toBeDefined();
    // Срок заявки — 10.08–12.08.2026, одна календарная неделя: лист будет один, и человек видит
    // это до нажатия, а не узнаёт из журнала.
    expect(await screen.findByText(/Будет выписано листов ЭСМ-2: 1/)).toBeDefined();
  });

  it('у грузоперевозки его нет: там лист выписывается на рейс, а не на неделю', async () => {
    renderModal({ vehicle: OWN_VEHICLE });
    await screen.findByText('Маршрут');
    expect(screen.queryByLabelText('Машинист')).toBeNull();
  });

  it('без машиниста заявка в работу не уходит', async () => {
    const onSubmit = vi.fn();
    // Двое в справочнике: единственного `AutoSelect` подставил бы сам, и «не выбрали» было бы
    // состоянием, которого в форме не бывает.
    renderModal({
      vehicle: OWN_VEHICLE,
      onSubmit,
      request: ON_SITE_REQUEST,
      machinists: [MACHINIST, machinist({ id: 'p-2', fullName: 'Кузнецов Кузьма Кузьмич' })],
    });
    await screen.findByLabelText('Машинист');

    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(document.querySelector('.ant-form-item-has-error')).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('уходит полем назначения — на него и выпишутся листы', async () => {
    const onSubmit = vi.fn();
    renderModal({ vehicle: OWN_VEHICLE, onSubmit, request: ON_SITE_REQUEST });
    await screen.findByLabelText('Машинист');

    await selectOption('Машинист', new RegExp(MACHINIST.fullName));
    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as { assignment: { driverPersonId?: string } };
    expect(body.assignment.driverPersonId).toBe(MACHINIST.id);
  });
});

/**
 * Водитель готового рейса (ADR 0048): его спрашивают там же, где кладут заявку в уже собранный
 * рейс, — иначе сменить человека можно было только заведением лишнего маршрута «с нужным
 * водителем», и тот оставался пустой записью в плане дня.
 *
 * Правило поля то же, что у всех прочих полей человека в портале (ADR 0083): пустое, ничего не
 * подставлено, и пустота значима — «водителя не трогать». Снятие водителя здесь не предлагается
 * вовсе: его снимают правкой маршрута (ADR 0082).
 */
describe('водитель готового рейса', () => {
  /** Рейс с составом: смена водителя касается всех заявок рейса, и человек должен это прочесть. */
  const SHARED_ROUTE: VehicleRouteDto = {
    ...EXISTING_ROUTE,
    requests: [
      {
        requestId: 'r-99',
        displayNumber: 'ТС-499',
        position: 1,
        status: 'confirmed',
        customerName: 'Объект Мытищи',
        loadingLocation: 'Карьер',
        unloadingLocation: 'Мытищи, ул. Летняя, 3',
        scheduledAt: '2026-08-10T09:00:00.000Z',
        scheduledTimeUnspecified: false,
        cargoLabel: '12 м³',
      },
    ],
  };

  /** Окно на уже назначенной машине: единственный готовый рейс её дня подставляется сам. */
  function renderWithRoute(route: VehicleRouteDto, onSubmit?: (v: unknown) => void) {
    renderModal({ vehicle: OWN_VEHICLE, routes: [route], onSubmit });
    return screen.findByText(/Заявка встанет строкой задания в рейс Р-12/);
  }

  /** Тело назначения, каким окно отдало его наружу. */
  function routeOf(onSubmit: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const payload = onSubmit.mock.calls[0]![0] as {
      assignment: { route: Record<string, unknown> };
    };
    return payload.assignment.route;
  }

  it('поле показано, пусто, а нынешний водитель назван подсказкой', async () => {
    await renderWithRoute(EXISTING_ROUTE);

    // Имя стоит текстом — в поле его нет: подставленная фамилия читается как принятое решение.
    await screen.findByText(/Сейчас за рулём Сидоров Сидор Сидорович/);
    expect(screen.queryByTitle('Сидоров Сидор Сидорович')).toBeNull();
  });

  it('пустое поле в тело не попадает: рейс общий, и молчание значит «не менять»', async () => {
    const onSubmit = vi.fn();
    await renderWithRoute(EXISTING_ROUTE, onSubmit);

    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    expect(routeOf(onSubmit)).toEqual({ routeId: 'route-1' });
    expect('driverPersonId' in routeOf(onSubmit)).toBe(false);
  });

  it('выбранный водитель уходит вместе с рейсом одним телом', async () => {
    const onSubmit = vi.fn();
    await renderWithRoute(EXISTING_ROUTE, onSubmit);

    await selectOption('Водитель', /Тестовый Водитель Первый/);
    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    expect(routeOf(onSubmit)).toEqual({ routeId: 'route-1', driverPersonId: 'p-1' });
  });

  it('о составе рейса предупреждают до нажатия: водитель у рейса один на всех', async () => {
    await renderWithRoute(SHARED_ROUTE);

    await screen.findByText(/Водитель у рейса один на все заявки/);
    expect(screen.getByText(/ТС-499/)).toBeDefined();
  });
});
