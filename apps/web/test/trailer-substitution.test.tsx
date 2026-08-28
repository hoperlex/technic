import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  DriverSelectionDto,
  FreightTransportRequestDto,
  HitchedTrailerDto,
  RouteTripFields,
  VehicleDto,
  VehicleRouteDto,
  VehicleTrailerDto,
} from '@technic/contracts';
import { json, mockHttp, type MockResponse } from './http';
import { createTestQueryClient, renderWithUser } from './render';
import { authUser } from './factories/auth';
import { selectOption, typeDate } from './antd';
import { list } from './factories/common';
import { vehicleRouteKeys, vehicleTypesForTrailerKey } from '@entities/vehicle-route';
import { VehicleRouteEditModal } from '../src/pages/vehicle/VehicleRouteEditModal';
import { VehicleRouteCorrectionModal } from '../src/pages/vehicle/VehicleRouteCorrectionModal';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';
import { VehicleRoutesModal } from '../src/pages/vehicle/VehicleRoutesModal';

/**
 * Подстановка прицепа в живых окнах (план `docs/vehicle-trailers-plan.md`, §14, Р20–Р21).
 *
 * Правило само по себе проверяется чистым тестом (`trailer-substitution-rule.test.ts`) — здесь
 * проверяется то, чего чистая функция не видит и чем оба дефекта и жили: **порядок**. Эффекты
 * блока граф идут раньше эффектов окна, ответы сервера приходят когда угодно (а из кэша — в том
 * же коммите, что и открытие), и решение, принятое по ещё не заполненной форме, второй раз не
 * принимается никогда.
 *
 * Четыре сценария, и каждый повторяет случай с прода:
 *
 * 1. Правка рейса тягача с прогретым кэшем подсказки: галочка стоит, графы пусты, за машиной
 *    закреплён полуприцеп — до этой работы подстановка молчала, и лист печатался без прицепа.
 * 2. Рейс, заведённый голым тягачом: правка не возвращает ни прицеп, ни галочку.
 * 3. Коррекция со сменой машины **до** ответа подсказки: графы прежней машины обязаны уйти.
 * 4. Перевод в работу со сменой машины на незакреплённую: графы уходят, режимы возвращаются
 *    ручными, а прошлый рейс новой машины — если он есть — наследуется поверх пустоты.
 */

const TRACTOR_TYPE = 'type-tractor';
const DATE = '2026-08-28';

/** Полуприцеп, закреплённый за тягачом: тот же, что нашёлся в проде за КАМАЗ 65209-S5. */
const KRONE: HitchedTrailerDto = {
  id: 'tr-krone',
  position: 1,
  model: 'КРОНА SDP27',
  registrationNumber: 'ЕН806277',
  status: 'active',
};

const trailerRow = (over: Partial<VehicleTrailerDto> = {}): VehicleTrailerDto =>
  ({
    id: KRONE.id,
    kind: 'semi_trailer',
    model: KRONE.model,
    registrationNumber: KRONE.registrationNumber,
    vin: '',
    passportNumber: '',
    manufacturedYear: null,
    color: '',
    maxMassKg: null,
    curbMassKg: null,
    ownerOrganizationId: null,
    ownerOrganizationName: null,
    status: 'active',
    note: '',
    sourceName: '',
    hitchedVehicle: null,
    hitchPosition: null,
    createdAt: '2026-08-01T06:00:00.000Z',
    updatedAt: '2026-08-01T06:00:00.000Z',
    deletedAt: null,
    ...over,
  }) as VehicleTrailerDto;

/** Справочник типов: по нему блок граф узнаёт седельный тягач (§4.4 (а)). */
const VEHICLE_TYPES = {
  items: [
    { id: TRACTOR_TYPE, code: 'tractor_trailers', name: 'Тягачи с полуприцепами' },
    { id: 'type-dump', code: 'dump_trucks', name: 'Самосвалы' },
  ],
  total: 2,
  page: 1,
  pageSize: 500,
};

const SELECTION: DriverSelectionDto = {
  requiredCategory: 'CE',
  requiredCategoryType: 'driver_license',
  drivers: [
    {
      personId: 'p-1',
      fullName: 'Смуток Василий Николаевич',
      personnelNo: '00414',
      credentialTypeCode: 'driver_license',
      licenseNumber: '99 39 482645',
      licenseExpiresOn: '2031-03-12',
      verificationStatus: 'verified',
      categories: ['C', 'CE'],
      gaps: [],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
  ],
};

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: DATE,
  vehicleId: 'v-tractor',
  vehicleLabel: 'КАМАЗ 65209-S5 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: TRACTOR_TYPE,
  vehicleTypeName: 'Тягачи с полуприцепами',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: 'p-1',
  driverName: 'Смуток Василий Николаевич',
  driverGaps: [],
  // Галочка у тягача стоит с заведения рейса — она встаёт сама, — а графы пусты: закрепление
  // появилось в реестре позже, чем собрали рейс.
  withTrailer: true,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'пригородное',
  transportationKind: 'коммерческая',
  comment: '',
  requests: [
    {
      requestId: 'r-1',
      displayNumber: 'ТС-501',
      position: 1,
      status: 'confirmed',
      customerName: 'Объект А',
      loadingLocation: 'Карьер',
      unloadingLocation: 'Площадка 1',
      scheduledAt: `${DATE}T06:00:00.000Z`,
      scheduledTimeUnspecified: false,
      cargoLabel: '12 м³',
    },
  ],
  points: [],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-27T09:00:00.000Z',
  version: 3,
};

/** Значение графы формы по подписи; `null` — поля на экране нет. */
function fieldValue(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const id = label?.getAttribute('for');
  const input = id ? (document.getElementById(id) as HTMLInputElement | null) : null;
  return input ? input.value : null;
}

function checkbox(labelText: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name: labelText }) as HTMLInputElement;
}

// ── 1–2. Правка рейса ──

/**
 * Кэш прогрет заранее — так окно и открывается в портале: подсказку про эту машину и дату уже
 * спрашивало окно рейса, ответ лежит свежим, и в первый же коммит закрепление приходит вместе с
 * открытием. Именно здесь подстановка и промахивалась мимо ещё не заполненной формы.
 */
function renderEdit(route: VehicleRouteDto, hitched: HitchedTrailerDto[]) {
  const http = mockHttp({
    'GET /drivers/available': () => json(SELECTION),
    'GET /vehicle-routes/suggest': () => json({ routes: [], trip: null, hitched }),
    'GET /vehicle-types': () => json(VEHICLE_TYPES),
    'GET /vehicle-trailers': () => json(list([trailerRow()])),
    'PATCH /vehicle-routes/:id': ({ body }) => json({ ...route, ...(body as object) }),
  });
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(vehicleRouteKeys.suggest(route.vehicleId, route.routeDate), {
    routes: [],
    trip: null,
    hitched,
  });
  queryClient.setQueryData(vehicleTypesForTrailerKey, VEHICLE_TYPES);
  renderWithUser(<VehicleRouteEditModal route={route} onClose={() => {}} onSaved={() => {}} />, {
    user: authUser({ role: 'dispatcher' }),
    queryClient,
  });
  return http;
}

describe('правка рейса: закрепление доходит до пустых граф', () => {
  it('тягач с галочкой и пустыми графами получает закреплённый полуприцеп', async () => {
    const http = renderEdit(ROUTE, [KRONE]);
    await screen.findByText('Дата рейса');

    // Подстановка включает режим справочника, и графа показывает выбранный прицеп.
    await screen.findByLabelText('Прицеп 1');
    await waitFor(() =>
      expect(screen.getAllByText('КРОНА SDP27 ЕН806277').length).toBeGreaterThan(0),
    );
    // Подпись называет источник: подставленное значение читается как принятое решение, и молчать
    // о том, откуда оно, нельзя (§4.3).
    expect(screen.getByText(/В графах — прицеп, закреплённый за машиной/)).toBeTruthy();

    // Главное: до сервера графы доезжают — с них и печатается бланк.
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.lastCall('PATCH /vehicle-routes/:id')).toBeDefined());
    expect(
      (http.lastCall('PATCH /vehicle-routes/:id')!.body as { trip: RouteTripFields }).trip,
    ).toMatchObject({
      withTrailer: true,
      trailer1Model: 'КРОНА SDP27',
      trailer1RegNumber: 'ЕН806277',
    });
  });

  it('окно, переоткрытое на другом рейсе, подставляет по нему, а не по прежнему', async () => {
    /*
     * Барьер готовности формы (Р21). Окно живёт дольше записи — antd не размонтирует закрытое, —
     * и второй рейс въезжает в форму, ещё занятую первым. Блок граф при этом пересоздаётся по
     * `key`, его эффект идёт раньше заполняющего эффекта окна, и без барьера решение принималось
     * бы по графам **прежнего** рейса: прочитав чужое «без прицепа», подстановка молчала и второй
     * раз к решению не возвращалась.
     */
    const DUMP_ROUTE: VehicleRouteDto = {
      ...ROUTE,
      id: 'route-2',
      vehicleId: 'v-dump',
      vehicleLabel: 'КамАЗ 65201 · А123ВС777',
      vehicleTypeId: 'type-dump',
      vehicleTypeName: 'Самосвалы',
      withTrailer: false,
    };
    function Harness() {
      const [route, setRoute] = useState(DUMP_ROUTE);
      return (
        <>
          <button type="button" onClick={() => setRoute(ROUTE)}>
            Открыть рейс тягача
          </button>
          <VehicleRouteEditModal route={route} onClose={() => {}} onSaved={() => {}} />
        </>
      );
    }

    mockHttp({
      'GET /drivers/available': () => json(SELECTION),
      'GET /vehicle-routes/suggest': ({ query }) =>
        json({
          routes: [],
          trip: null,
          hitched: query.get('vehicleId') === ROUTE.vehicleId ? [KRONE] : [],
        }),
      'GET /vehicle-types': () => json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'PATCH /vehicle-routes/:id': ({ body }) => json({ ...ROUTE, ...(body as object) }),
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(vehicleRouteKeys.suggest(DUMP_ROUTE.vehicleId, DUMP_ROUTE.routeDate), {
      routes: [],
      trip: null,
      hitched: [],
    });
    queryClient.setQueryData(vehicleRouteKeys.suggest(ROUTE.vehicleId, ROUTE.routeDate), {
      routes: [],
      trip: null,
      hitched: [KRONE],
    });
    queryClient.setQueryData(vehicleTypesForTrailerKey, VEHICLE_TYPES);
    renderWithUser(<Harness />, { user: authUser({ role: 'dispatcher' }), queryClient });

    await screen.findByText('Дата рейса');
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));

    fireEvent.click(screen.getByText('Открыть рейс тягача'));

    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(true));
    await screen.findByLabelText('Прицеп 1');
    await waitFor(() =>
      expect(screen.getAllByText('КРОНА SDP27 ЕН806277').length).toBeGreaterThan(0),
    );
  });

  it('заполненные графы рейса закрепление не вытесняет', async () => {
    const own = { ...ROUTE, trailer1Model: 'МАЗ-8926', trailer1RegNumber: 'АВ123477' };
    renderEdit(own, [KRONE]);
    await screen.findByText('Дата рейса');

    // Режим остался ручным (список включает только подстановка), а в графах — прицеп рейса.
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe('МАЗ-8926'));
    expect(fieldValue('Прицеп 1: госномер')).toBe('АВ123477');
  });

  it('рейс без прицепа правка не переубеждает — ни графами, ни галочкой', async () => {
    // Голый тягач в ремонт и обратно (§4.4): галочку сняли рукой, и подстановка её не возвращает.
    const bare = { ...ROUTE, withTrailer: false };
    const http = renderEdit(bare, [KRONE]);
    await screen.findByText('Дата рейса');

    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));
    // Граф на экране нет вовсе: блок показывает их по галочке.
    expect(fieldValue('Прицеп 1: марка')).toBeNull();
    expect(screen.queryByLabelText('Прицеп 1')).toBeNull();

    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.lastCall('PATCH /vehicle-routes/:id')).toBeDefined());
    expect(
      (http.lastCall('PATCH /vehicle-routes/:id')!.body as { trip: RouteTripFields }).trip,
    ).toMatchObject({ withTrailer: false, trailer1Model: '', trailer1RegNumber: '' });
  });
});

// ── 3. Коррекция: смена машины до ответа подсказки ──

const CORRECTION_ROUTE: VehicleRouteDto = {
  ...ROUTE,
  routeDate: '2026-08-20',
  trailer1Model: KRONE.model,
  trailer1RegNumber: KRONE.registrationNumber,
  trailerLabel: 'КРОНА SDP27 ЕН806277',
  waybill: { id: 'w-1', number: '00000382', status: 'issued', issuedForDate: '2026-08-20' },
};

const FLEET_VEHICLE: VehicleDto = {
  id: 'v-tractor',
  ownership: 'own',
  vehicleKindId: 'kind-freight',
  kindName: 'Грузовой транспорт',
  vehicleTypeId: TRACTOR_TYPE,
  typeName: 'Тягачи с полуприцепами',
  waybillFormCode: '4p',
  vehicleCategoryId: null,
  categoryName: null,
  categorySpecs: null,
  vehicleModelId: 'm-1',
  modelName: 'КАМАЗ 65209-S5',
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

/** Самосвал без закрепления: на него меняют машину, и прицепу прежней в бланке места нет. */
const TIPPER: VehicleDto = {
  ...FLEET_VEHICLE,
  id: 'v-dump',
  vehicleTypeId: 'type-dump',
  typeName: 'Самосвалы',
  vehicleModelId: 'm-2',
  modelName: 'КамАЗ 65201',
  registrationNumber: 'А123ВС777',
};

/** Арендная единица: без неё ветка «Аренда» в переключателе заперта и не нажимается. */
const RENTAL: VehicleDto = {
  ...TIPPER,
  id: 'v-rent',
  ownership: 'rental',
  modelName: null,
  registrationNumber: null,
  lessorId: 'c-1',
  lessorName: 'ООО «Арендатех»',
  description: 'Самосвал 20 м³',
  pricePerShift: 28000,
};

const CORRECTION_PREVIEW = {
  routeDate: CORRECTION_ROUTE.routeDate,
  today: '2026-08-27',
  blocking: null,
  waybill: CORRECTION_ROUTE.waybill,
  requests: [
    {
      requestId: 'r-1',
      displayNumber: 'ТС-501',
      position: 1,
      workDate: null,
      status: 'confirmed',
      assignmentVehicleId: CORRECTION_ROUTE.vehicleId,
      assignmentVehicleLabel: CORRECTION_ROUTE.vehicleLabel,
      linear: false,
      shiftApproval: null,
    },
  ],
  files: [],
};

describe('коррекция: смена машины обгоняет ответ подсказки', () => {
  it('графы прежней машины уходят, даже если машину сменили до ответа сервера', async () => {
    // Ответ подсказки задерживается — так и бывает, когда диспетчер меняет машину сразу после
    // открытия окна. Прежний код запоминал исходную машину только после ответа, и смена
    // проходила незамеченной: `vehicleChanged` оставался ложным, а коррекция по открытию не
    // подставляет ничего — прицеп прежней машины доезжал до нового бланка.
    const pending: Array<(res: MockResponse) => void> = [];
    const asked: string[] = [];
    const http = mockHttp({
      'GET /vehicle-routes/:id/correction': () => json(CORRECTION_PREVIEW),
      'GET /waybills/:id': () => json({ ...CORRECTION_ROUTE.waybill, files: [] }),
      'GET /vehicles': () => json(list([FLEET_VEHICLE, TIPPER])),
      'GET /drivers/available': () => json(SELECTION),
      'GET /vehicle-types': () => json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'GET /vehicle-routes/suggest': ({ query }) => {
        const vehicleId = query.get('vehicleId') ?? '';
        asked.push(vehicleId);
        return new Promise<MockResponse>((resolve) => {
          pending.push(() =>
            resolve(
              json({
                routes: [],
                trip: null,
                hitched: vehicleId === CORRECTION_ROUTE.vehicleId ? [KRONE] : [],
              }),
            ),
          );
        });
      },
    });

    renderWithUser(
      <VehicleRouteCorrectionModal
        route={CORRECTION_ROUTE}
        onClose={() => {}}
        onSaved={() => {}}
      />,
      { user: authUser({ role: 'dispatcher' }) },
    );
    await screen.findByText('Причина коррекции');
    // Графы открылись прицепом рейса: коррекция описывает состоявшийся день и подставлять в него
    // сегодняшнее закрепление не вправе.
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe('КРОНА SDP27'));

    // Машину меняют, пока подсказка про прежнюю ещё не ответила.
    await selectOption('Машина рейса', /КамАЗ 65201/);
    await waitFor(() => expect(asked).toContain(TIPPER.id));
    for (const resolve of pending.splice(0)) resolve({ status: 200 });

    // Самосвал не тягач и ничего за собой не тянет: галочка снимается вместе с графами.
    await waitFor(() => expect(checkbox('Рейс был с прицепом').checked).toBe(false));

    // Спрятанные графы стёрты, а не спрятаны: вернув галочку, человек видит пустые поля, а не
    // полуприцеп чужой машины, который иначе доехал бы до бланка через `preserve` формы.
    fireEvent.click(checkbox('Рейс был с прицепом'));
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe(''));
    expect(fieldValue('Прицеп 1: госномер')).toBe('');
    expect(http.countOf('GET /vehicle-routes/suggest')).toBeGreaterThanOrEqual(2);
  });
});

// ── 4. Перевод в работу: смена на незакреплённую машину ──

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
  vehicleTypeId: TRACTOR_TYPE,
  vehicleTypeName: 'Тягачи с полуприцепами',
  vehicleKindId: 'kind-freight',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  status: 'new',
  comment: '',
  cancelReason: null,
  approvedBy: 'user-1',
  approvedByName: 'Руков Р. Р.',
  approvedAt: '2026-08-26T09:00:00.000Z',
  assignment: null,
  completion: null,
  route: null,
  files: [],
  version: 1,
  createdBy: 'user-1',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-08-26T09:00:00.000Z',
  updatedAt: '2026-08-26T09:00:00.000Z',
  deletedAt: null,
  deletedByName: null,
  scheduledAt: `${DATE}T09:00:00+03:00`,
  costTarget: { kind: 'object', id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
  scheduledTimeUnspecified: false,
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

/** Готовый рейс самосвала: выбрав его, окно запирает поле машины этим самосвалом. */
const READY_ROUTE: VehicleRouteDto = {
  ...ROUTE,
  id: 'route-ready',
  displayNumber: 'Р-77',
  vehicleId: TIPPER.id,
  vehicleLabel: 'КамАЗ 65201 · А123ВС777',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  withTrailer: false,
  requests: [],
  waybill: null,
};

const assignmentOf = (v: VehicleDto) => ({
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
  assignedAt: '2026-08-26T10:00:00.000Z',
});

/** Прошлый рейс самосвала: его графы шапки наследует новый — но только поверх пустоты. */
const TIPPER_LAST_TRIP: RouteTripFields = {
  withTrailer: true,
  trailer1Model: 'СЗАП-8551',
  trailer1RegNumber: 'АВ123477',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'пригородное',
  transportationKind: 'коммерческая',
};

function renderAssign(lastTripOfTipper: RouteTripFields | null) {
  const http = mockHttp({
    'GET /vehicles': () => json(list([FLEET_VEHICLE, TIPPER])),
    'GET /vehicle-requests/:id/route-prefill': ({ query }) =>
      json({
        required: true,
        formCode: '4p',
        formLabel: 'Форма 4-П (грузовой автомобиль)',
        reason: null,
        tripDate: query.get('date') ?? DATE,
        routes: [],
        trip: null,
      }),
    'GET /vehicle-routes/suggest': ({ query }) =>
      query.get('vehicleId') === FLEET_VEHICLE.id
        ? json({ routes: [], trip: null, hitched: [KRONE] })
        : json({ routes: [], trip: lastTripOfTipper, hitched: [] }),
    'GET /vehicle-types': () => json(VEHICLE_TYPES),
    'GET /vehicle-trailers': () => json(list([trailerRow()])),
    'GET /drivers/available': () => json(SELECTION),
    'GET /drivers': () => json(list([])),
  });
  renderWithUser(
    <VehicleAssignModal
      request={{ ...REQUEST, assignment: assignmentOf(FLEET_VEHICLE) }}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
    { user: authUser({ role: 'dispatcher' }) },
  );
  return http;
}

describe('перевод в работу: справочник типов не задерживает и не повторяет подстановку', () => {
  it('графы встают без типа, а восстановившийся справочник их не переставляет', async () => {
    /*
     * Два независимых процесса (§14, Р21). Графы типа машины не спрашивают вовсе — живое
     * закрепление не должно стоять из-за медленного или упавшего списка типов. А галочка тягача
     * ждёт тип и помнит машину: пока `isTractor` входил в отпечаток источника, восстановившийся
     * запрос менял отпечаток и повторял подстановку, возвращая снятую человеком галочку.
     */
    let typesFail = true;
    const http = mockHttp({
      'GET /vehicles': () => json(list([FLEET_VEHICLE, TIPPER])),
      'GET /vehicle-requests/:id/route-prefill': () =>
        json({
          required: true,
          formCode: '4p',
          formLabel: 'Форма 4-П (грузовой автомобиль)',
          reason: null,
          tripDate: DATE,
          routes: [],
          trip: null,
        }),
      'GET /vehicle-routes/suggest': () => json({ routes: [], trip: null, hitched: [KRONE] }),
      'GET /vehicle-types': () =>
        typesFail ? json({ message: 'справочник недоступен' }, 500) : json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'GET /drivers/available': () => json(SELECTION),
      'GET /drivers': () => json(list([])),
    });
    const { queryClient } = renderWithUser(
      <VehicleAssignModal
        request={{ ...REQUEST, assignment: assignmentOf(FLEET_VEHICLE) }}
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
      { user: authUser({ role: 'dispatcher' }) },
    );

    // Справочник типов лежит, а закрепление уже в графах: одно другого не ждёт.
    await screen.findByLabelText('Прицеп 1');
    await waitFor(() =>
      expect(screen.getAllByText('КРОНА SDP27 ЕН806277').length).toBeGreaterThan(0),
    );
    expect(http.countOf('GET /vehicle-types')).toBeGreaterThan(0);

    // Человек снимает галочку: рейс поедет без прицепа, и это его решение.
    fireEvent.click(checkbox('Рейс с прицепом'));
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));

    // Справочник ожил — подстановка не повторяется, снятая галочка остаётся снятой.
    typesFail = false;
    await queryClient.invalidateQueries({ queryKey: vehicleTypesForTrailerKey });
    await waitFor(() => expect(http.countOf('GET /vehicle-types')).toBeGreaterThan(1));
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));
  });
});

describe('перевод в работу: готовый рейс посередине не оставляет чужой прицеп', () => {
  it('новый рейс тягача → готовый рейс самосвала → новый рейс самосвала даёт пустые графы', async () => {
    /*
     * Готовый рейс запирает поле машины **своей** (ADR 0052), а блок граф у готового не
     * спрашивается вовсе. Пока условие показа стояло обёрткой, блок в этот момент размонтировался
     * вместе с ответом: вернувшись на «Новый рейс», он видел уже самосвал, считал его исходной
     * машиной — и оставлял в графах полуприцеп тягача. Теперь условие живёт пропом `asks`, и
     * блок, не рисуя себя, графы всё-таки снимает.
     */
    mockHttp({
      'GET /vehicles': () => json(list([FLEET_VEHICLE, TIPPER])),
      'GET /vehicle-requests/:id/route-prefill': () =>
        json({
          required: true,
          formCode: '4p',
          formLabel: 'Форма 4-П (грузовой автомобиль)',
          reason: null,
          tripDate: DATE,
          routes: [READY_ROUTE],
          trip: null,
        }),
      'GET /vehicle-routes/suggest': ({ query }) =>
        query.get('vehicleId') === FLEET_VEHICLE.id
          ? json({ routes: [], trip: null, hitched: [KRONE] })
          : json({ routes: [], trip: null, hitched: [] }),
      'GET /vehicle-types': () => json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'GET /drivers/available': () => json(SELECTION),
      'GET /drivers': () => json(list([])),
    });
    renderWithUser(
      <VehicleAssignModal
        request={{ ...REQUEST, assignment: assignmentOf(FLEET_VEHICLE) }}
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
      { user: authUser({ role: 'dispatcher' }) },
    );

    // Новый рейс тягача: закрепление подставилось.
    await screen.findByLabelText('Прицеп 1');
    await waitFor(() =>
      expect(screen.getAllByText('КРОНА SDP27 ЕН806277').length).toBeGreaterThan(0),
    );

    // Готовый рейс самосвала: блок граф уходит, машина в форме становится самосвалом.
    await selectOption('Рейс', /Р-77/);
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Рейс с прицепом' })).toBeNull(),
    );

    // Возврат к новому рейсу — уже на самосвале, за которым ничего не закреплено.
    await selectOption('Рейс', /Новый маршрут/);
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));
    fireEvent.click(checkbox('Рейс с прицепом'));
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe(''));
    expect(fieldValue('Прицеп 1: госномер')).toBe('');
  });
});

describe('перевод в работу: снятую галочку не возвращает ожившая подсказка типов', () => {
  it('тягач без закрепления: справочник ожил, а галочка осталась снятой', async () => {
    /*
     * Узкая щель того же барьера. Память «галочку уже ставили» пуста, пока справочник типов лежит:
     * умолчание не срабатывало ни разу. Человек тем временем снимает галочку, унаследованную от
     * прошлого рейса, — и ожившая подсказка ставит её обратно. Барьер поэтому взводит сам чекбокс,
     * а не эффект: решение человека старше умолчания по типу.
     */
    let typesFail = true;
    const http = mockHttp({
      'GET /vehicles': () => json(list([FLEET_VEHICLE, TIPPER])),
      'GET /vehicle-requests/:id/route-prefill': () =>
        json({
          required: true,
          formCode: '4p',
          formLabel: 'Форма 4-П (грузовой автомобиль)',
          reason: null,
          tripDate: DATE,
          routes: [],
          trip: null,
        }),
      // Закрепления нет — иначе галочку ставит подстановка, и умолчание по типу молчит всегда.
      'GET /vehicle-routes/suggest': () =>
        json({
          routes: [],
          trip: { ...TIPPER_LAST_TRIP, trailer1Model: '', trailer1RegNumber: '' },
          hitched: [],
        }),
      'GET /vehicle-types': () =>
        typesFail ? json({ message: 'справочник недоступен' }, 500) : json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'GET /drivers/available': () => json(SELECTION),
      'GET /drivers': () => json(list([])),
    });
    const { queryClient } = renderWithUser(
      <VehicleAssignModal
        request={{ ...REQUEST, assignment: assignmentOf(FLEET_VEHICLE) }}
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
      { user: authUser({ role: 'dispatcher' }) },
    );

    // Галочка унаследована от прошлого рейса машины, а не поставлена по типу: справочник лежит.
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(true));

    // Человек снимает её: голый тягач в ремонт и обратно — законный выезд (§4.4).
    fireEvent.click(checkbox('Рейс с прицепом'));
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));

    typesFail = false;
    await queryClient.invalidateQueries({ queryKey: vehicleTypesForTrailerKey });
    await waitFor(() => expect(http.countOf('GET /vehicle-types')).toBeGreaterThan(1));
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));
  });
});

describe('перевод в работу: аренда посередине не оставляет чужой прицеп', () => {
  it('своя → аренда → своя без закрепления возвращает пустые графы', async () => {
    /*
     * Ветка аренды снимает блок граф целиком (у арендной машины рейса нет), а скрытые поля
     * rc-field-form хранит. Возврат к своей монтирует блок заново и считает новую машину
     * исходной — `vehicleChanged` ложен, очистки по смене машины не будет. Снимает графы сам блок:
     * машины в форме нет, значит и описывать нечего.
     */
    mockHttp({
      'GET /vehicles': () => json(list([FLEET_VEHICLE, TIPPER, RENTAL])),
      'GET /vehicle-requests/:id/route-prefill': () =>
        json({
          required: true,
          formCode: '4p',
          formLabel: 'Форма 4-П (грузовой автомобиль)',
          reason: null,
          tripDate: DATE,
          routes: [],
          trip: null,
        }),
      'GET /vehicle-routes/suggest': ({ query }) =>
        query.get('vehicleId') === FLEET_VEHICLE.id
          ? json({ routes: [], trip: null, hitched: [KRONE] })
          : json({ routes: [], trip: null, hitched: [] }),
      'GET /vehicle-types': () => json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'GET /drivers/available': () => json(SELECTION),
      'GET /drivers': () => json(list([])),
    });
    renderWithUser(
      <VehicleAssignModal
        request={{ ...REQUEST, assignment: assignmentOf(FLEET_VEHICLE) }}
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
      { user: authUser({ role: 'dispatcher' }) },
    );
    await screen.findByLabelText('Прицеп 1');

    // Уходим в аренду: блок граф исчезает вместе с рейсом.
    fireEvent.click(await screen.findByText(/^Аренда · /));
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Рейс с прицепом' })).toBeNull(),
    );

    // Возвращаемся и берём самосвал без закрепления: полуприцепа тягача в графах быть не должно.
    fireEvent.click(screen.getByText(/^Собственная · /));
    await selectOption('Конкретная техника', /КамАЗ 65201/);
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));
    fireEvent.click(checkbox('Рейс с прицепом'));
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe(''));
    expect(fieldValue('Прицеп 1: госномер')).toBe('');
  });
});

describe('перевод в работу: смена машины уносит чужой прицеп', () => {
  it('машина без закрепления и без прошлого рейса остаётся с пустыми графами и ручным режимом', async () => {
    renderAssign(null);
    // Открылись на тягаче: закрепление подставилось и включило список.
    await screen.findByLabelText('Прицеп 1');
    await waitFor(() =>
      expect(screen.getAllByText('КРОНА SDP27 ЕН806277').length).toBeGreaterThan(0),
    );

    await selectOption('Конкретная техника', /КамАЗ 65201/);

    // Самосвал не тягач: галочка снята вместе с графами, блок граф с экрана ушёл.
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));

    // Обе пары вернулись в ручной режим и пусты: список над очищенной графой обещал бы выбор,
    // которого больше нет.
    fireEvent.click(checkbox('Рейс с прицепом'));
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe(''));
    expect(fieldValue('Прицеп 1: госномер')).toBe('');
    expect(fieldValue('Прицеп 2: марка')).toBe('');
    expect(screen.queryByLabelText('Прицеп 1')).toBeNull();
    expect(screen.queryByLabelText('Прицеп 2')).toBeNull();
  });

  it('у машины с прошлым рейсом поверх очищенных граф встаёт его прицеп, а не чужой', async () => {
    // Очистка и наследование не спорят: блок граф очищает чужое, а окно следом ставит графы
    // прошлого рейса **этой** машины — они и есть лучшее, что портал о ней знает (§4.2.2).
    renderAssign(TIPPER_LAST_TRIP);
    await screen.findByLabelText('Прицеп 1');

    await selectOption('Конкретная техника', /КамАЗ 65201/);

    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe('СЗАП-8551'));
    expect(fieldValue('Прицеп 1: госномер')).toBe('АВ123477');
    expect(checkbox('Рейс с прицепом').checked).toBe(true);
  });
});

// ── 5. «Новый маршрут»: бланк без граф прицепа ──

/** Легковая: у формы № 3 граф прицепа нет вовсе (ADR 0071), и блок для неё не показывается. */
const CAR: VehicleDto = {
  ...FLEET_VEHICLE,
  id: 'v-car',
  vehicleTypeId: 'type-car',
  typeName: 'Легковые автомобили',
  waybillFormCode: 'leg3',
  vehicleModelId: 'm-3',
  modelName: 'Лада Веста',
  registrationNumber: 'Х777ХХ77',
};

describe('новый маршрут: бланк без граф прицепа уносит и сами графы', () => {
  it('смена тягача на легковую очищает подставленный полуприцеп, а не прячет его', async () => {
    /*
     * Граница размонтирования (§14, Р20). Условие показа стояло у вызова блока: выбрали машину
     * формы № 3 — блок исчезал, а его поля оставались в форме (`preserve` у rc-field-form) и
     * уезжали в тело рейса. Теперь условие — проп самого блока, и вместе с вопросом уходит ответ.
     */
    const http = mockHttp({
      'GET /vehicle-routes': () => json(list([])),
      'GET /vehicles': () => json(list([FLEET_VEHICLE, CAR, TIPPER])),
      'GET /drivers': () => json(list([])),
      'GET /drivers/available': () => json(SELECTION),
      'GET /vehicle-routes/suggest': ({ query }) =>
        query.get('vehicleId') === FLEET_VEHICLE.id
          ? json({ routes: [], trip: null, hitched: [KRONE] })
          : json({ routes: [], trip: null, hitched: [] }),
      'GET /vehicle-types': () => json(VEHICLE_TYPES),
      'GET /vehicle-trailers': () => json(list([trailerRow()])),
      'POST /vehicle-routes': ({ body }) => json({ ...ROUTE, ...(body as object) }),
    });
    renderWithUser(
      <VehicleRoutesModal open onClose={() => {}} focusToken={0} onChanged={() => {}} />,
      { user: authUser({ role: 'admin' }) },
    );

    fireEvent.click(await screen.findByText('Новый маршрут'));
    // День — первым: закрепление спрашивают по машине И дате, и без даты подсказки не будет вовсе.
    typeDate('Дата рейса', '28.08.2026');
    // Собственная машина зовётся в списке госномером (`vehicleLabel`), а не маркой.
    await selectOption('Техника', /Е646СК799/);

    // Закрепление подставилось: графы описывают тягач.
    await screen.findByLabelText('Прицеп 1');
    await waitFor(() =>
      expect(screen.getAllByText('КРОНА SDP27 ЕН806277').length).toBeGreaterThan(0),
    );

    // Легковая: блок уходит с экрана целиком.
    await selectOption('Техника', /Х777ХХ77/);
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Рейс с прицепом' })).toBeNull(),
    );

    /*
     * И возвращаемся к бланку с графами — самосвалом, за которым ничего не закреплено. Вот здесь
     * прежний код и врал: снятый с экрана блок уносил вопрос, но не ответ, а вернувшись, считал
     * самосвал исходной машиной (`vehicleChanged` ложен) и оставлял в графах полуприцеп тягача.
     */
    await selectOption('Техника', /А123ВС777/);
    await waitFor(() => expect(checkbox('Рейс с прицепом').checked).toBe(false));
    fireEvent.click(checkbox('Рейс с прицепом'));
    await waitFor(() => expect(fieldValue('Прицеп 1: марка')).toBe(''));
    expect(fieldValue('Прицеп 1: госномер')).toBe('');

    // И в тело рейса графы не уезжают тоже.
    fireEvent.click(checkbox('Рейс с прицепом'));
    fireEvent.click(screen.getByText('Завести'));
    await waitFor(() => expect(http.lastCall('POST /vehicle-routes')).toBeDefined());
    expect(
      (http.lastCall('POST /vehicle-routes')!.body as { trip: RouteTripFields }).trip,
    ).toMatchObject({
      withTrailer: false,
      trailer1Model: '',
      trailer1RegNumber: '',
    });
  });
});
