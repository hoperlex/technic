import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import {
  LINEAR_DAY_DOOR_MESSAGE,
  LINEAR_DAY_FROZEN_MESSAGE,
  type VehicleDto,
  type VehicleRequestDayDto,
  type VehicleRequestDaysDto,
  type VehicleRouteDto,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { selectOption } from './antd';
import { list } from './factories/common';
import { vehicleRequest } from './factories/vehicle';
import { VehicleRequestDays } from '../src/pages/vehicle/VehicleRequestDays';
import { VehicleRouteModal } from '../src/pages/vehicle/VehicleRouteModal';

/**
 * Дни линейного заказа в портале (ADR 0100): заказ такой машины ведётся не неделями стояния на
 * площадке, а днями — каждый день срока это отдельный выезд, который кладут в рейс машины на эту
 * дату.
 *
 * Проверяется то, чем блок «Дни работ» отличается от таблицы смен, и каждое отличие — решение,
 * а не оформление: длинный срок показывается окном в неделю (иначе квартальный заказ даёт девяносто
 * нечитаемых строк), машина дня может разойтись с назначением и это помечается, замороженный
 * выписанным листом день не снимается, а у арендной заявки дней не бывает вовсе — и блок обязан
 * сказать это словами.
 *
 * Отдельно — форма планирования: день и объект известны заранее, спрашиваются только машина и
 * водитель, готовый рейс машины предлагается первым (иначе второй объект того же дня уедет вторым
 * бланком вместо той же семёрки строк задания), а водитель не подставляется даже единственный.
 */

/** Автовышка — линейная техника: днём объезжает площадки, вечером возвращается в гараж. */
const LIFT: VehicleDto = {
  id: 'v-lift',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  kindName: 'Спецтехника',
  vehicleTypeId: 'vt-1',
  typeName: 'Автовышки',
  waybillFormCode: '4p',
  vehicleCategoryId: 'vc-1',
  categoryName: 'Автовышки, 22 м',
  categorySpecs: null,
  vehicleModelId: 'm-1',
  modelName: 'ВС-22-01',
  registrationNumber: 'А111АА77',
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

/** Вторая единица того же типа: на разные дни срока выходят разные машины (решение 8). */
const LIFT_2: VehicleDto = {
  ...LIFT,
  id: 'v-lift-2',
  modelName: 'ВС-22-02',
  registrationNumber: 'В222ВВ77',
};

/** Назначение заявки: машина по умолчанию, а не машина каждого дня (решение 4). */
const ASSIGNMENT = {
  vehicleId: LIFT.id,
  ownership: LIFT.ownership,
  vehicleKindId: LIFT.vehicleKindId,
  vehicleTypeId: LIFT.vehicleTypeId,
  typeName: LIFT.typeName,
  vehicleCategoryId: LIFT.vehicleCategoryId,
  categoryName: LIFT.categoryName,
  categorySpecs: LIFT.categorySpecs,
  modelName: LIFT.modelName,
  registrationNumber: LIFT.registrationNumber,
  description: LIFT.description,
  lessorId: null,
  lessorName: null,
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Петров П. П.',
  assignedAt: '2026-08-09T10:00:00.000Z',
};

/** Линейная заявка в работе на собственной машине — только у такой и планируют дни. */
const REQUEST = vehicleRequest({
  id: 'vr-9',
  displayNumber: 'ТС-42',
  isLinear: true,
  status: 'confirmed',
  dateFrom: '2026-08-10',
  dateTo: '2026-08-18',
  assignment: ASSIGNMENT,
});

/** День, на который ещё никого не назначили: строка есть, а плана за ней нет. */
function free(date: string): VehicleRequestDayDto {
  return { date, outOfTerm: false, route: null, shift: null, otherVehicle: false };
}

/** Понедельник: отработан машиной заявки, лист выписан, объект часы подписал. */
const MONDAY: VehicleRequestDayDto = {
  date: '2026-08-10',
  outOfTerm: false,
  otherVehicle: false,
  route: {
    id: 'r-12',
    displayNumber: 'Р-12',
    position: 3,
    vehicleId: LIFT.id,
    vehicleLabel: 'ВС-22-01 · А111АА77',
    driverPersonId: 'p-1',
    driverName: 'Тестовый Водитель Первый',
    waybill: { id: 'w-1', number: '260604-646-00000004897', status: 'issued' },
    version: 2,
  },
  shift: {
    startedAt: '08:00',
    endedAt: '17:00',
    machineHours: 8.5,
    approvedAt: '2026-08-11T06:00:00.000Z',
    approvedByName: 'Прорабов П. П.',
  },
};

/** Вторник: выехала вторая единица — расхождение с назначением законно и помечается. */
const TUESDAY: VehicleRequestDayDto = {
  date: '2026-08-11',
  outOfTerm: false,
  otherVehicle: true,
  route: {
    id: 'r-15',
    displayNumber: 'Р-15',
    position: 1,
    vehicleId: LIFT_2.id,
    vehicleLabel: 'ВС-22-02 · В222ВВ77',
    driverPersonId: null,
    driverName: '',
    waybill: null,
    version: 1,
  },
  shift: null,
};

/**
 * День, оставшийся за сроком: срок сократили досрочным завершением, а лист за этот день уже у
 * водителя — сверка такой день с рейса не снимает и спрятать его нельзя.
 */
const LEFTOVER: VehicleRequestDayDto = {
  date: '2026-08-19',
  outOfTerm: true,
  otherVehicle: false,
  route: {
    id: 'r-20',
    displayNumber: 'Р-20',
    position: 2,
    vehicleId: LIFT.id,
    vehicleLabel: 'ВС-22-01 · А111АА77',
    driverPersonId: 'p-1',
    driverName: 'Тестовый Водитель Первый',
    waybill: { id: 'w-2', number: '260604-646-00000004901', status: 'issued' },
    version: 5,
  },
  shift: null,
};

/** План заказа: две недели срока плюс день за сроком. День среза — среда 12 августа. */
const DAYS: VehicleRequestDaysDto = {
  onDate: '2026-08-12',
  blocker: null,
  items: [
    MONDAY,
    TUESDAY,
    free('2026-08-12'),
    free('2026-08-13'),
    free('2026-08-14'),
    free('2026-08-15'),
    free('2026-08-16'),
    free('2026-08-17'),
    free('2026-08-18'),
    LEFTOVER,
  ],
};

/** Рейс этой машины на 12 августа: в нём уже есть строка, и в него же должен встать день. */
const ROUTE_16: VehicleRouteDto = {
  id: 'r-16',
  displayNumber: 'Р-16',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: '2026-08-12',
  vehicleId: LIFT.id,
  vehicleLabel: 'ВС-22-01 · А111АА77',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  vehicleTypeName: 'Автовышки',
  vehicleCategoryId: 'vc-1',
  vehicleCategorySpecs: null,
  driverPersonId: 'p-1',
  driverName: 'Тестовый Водитель Первый',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'городское',
  transportationKind: 'коммерческая',
  comment: '',
  requests: [
    {
      requestId: 'vr-9',
      displayNumber: 'ТС-42',
      position: 1,
      // День линейного заказа: строка стоит в рейсе ради одного дня срока (ADR 0100 §2).
      workDate: '2026-08-12',
      status: 'confirmed',
      customerName: 'ЖК Северный',
      loadingLocation: '',
      unloadingLocation: '',
      scheduledAt: '2026-08-12T05:00:00.000Z',
      scheduledTimeUnspecified: true,
      cargoLabel: '',
    },
  ],
  // Порядок объезда сценарию не нужен: он проверяет рейс целиком, а не сборку дня.
  points: [],
  waybill: null,
  createdByName: 'Диспетчеров Д. П.',
  createdAt: '2026-08-11T09:00:00.000Z',
  version: 3,
};

/** Водители на день: единственный пригодный — и он всё равно не подставляется (ADR 0083). */
const SELECTION = {
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
      categories: ['C'],
      gaps: [],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
  ],
};

/**
 * Что стоит в поле выбора: `null` — поле пустое. Читается заполненное содержимое поля, а не текст
 * всего `Form.Item`: у пустого поля там лежит placeholder, и «пусто» от «выбрано» так не отличить.
 */
function selectedText(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-select-content-has-value')?.getAttribute('title') ?? null;
}

/** Строка таблицы дней по дате — действия и пометки читаются в пределах своего дня. */
function dayRow(date: string): HTMLElement {
  return screen.getByText(date).closest('tr') as HTMLElement;
}

function renderDays(days: VehicleRequestDaysDto = DAYS, routes: VehicleRouteDto[] = []) {
  const http = mockHttp({
    'GET /vehicle-requests/:id/days': () => json(days),
    'GET /vehicles': () => json(list([LIFT, LIFT_2])),
    // Рейсы выбранной машины на этот день плюс графы шапки прошлого рейса.
    'GET /vehicle-routes/suggest': () => json({ routes, trip: null, hitched: [] }),
    'GET /vehicle-types': () => json({ items: [], total: 0, page: 1, pageSize: 500 }),
    'GET /drivers/available': () => json(SELECTION),
    'POST /vehicle-requests/:id/days/:date/route': () => json(days),
    'DELETE /vehicle-requests/:id/days/:date/route': () => json(days),
  });
  // Клиент запросов отдаётся наружу: им сценарии среза гаража читают, помечен ли его кэш
  // устаревшим после правки дня (см. describe «срез гаража после правки дня»).
  const { queryClient } = renderWithUser(<VehicleRequestDays request={REQUEST} />);
  return { http, queryClient };
}

/**
 * Пустая шапка нового рейса. Тело её теперь несёт всегда: графы прицепа уезжают из формы, а не из
 * подсказки (план `docs/vehicle-trailers-plan.md`, §4.2.2), и «прицепа нет» — такой же ответ, как
 * «прицеп такой-то». Сервер читает её ровно как прежнее отсутствие ключа (`tripValues`).
 */
const EMPTY_TRIP = {
  withTrailer: false,
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '',
  communicationKind: '',
  transportationKind: '',
};

describe('таблица дней линейного заказа', () => {
  it('день показывает рейс, машину, водителя, лист, часы смены и подпись объекта', async () => {
    renderDays();
    await screen.findByText('10.08.2026');

    const row = dayRow('10.08.2026');
    expect(within(row).getByText('Р-12')).toBeDefined();
    expect(within(row).getByText('строка 3')).toBeDefined();
    expect(within(row).getByText('ВС-22-01 · А111АА77')).toBeDefined();
    expect(within(row).getByText('Тестовый Водитель Первый')).toBeDefined();
    expect(within(row).getByText('260604-646-00000004897')).toBeDefined();
    expect(within(row).getByText('08:00 – 17:00')).toBeDefined();
    expect(within(row).getByText('8,5 ч')).toBeDefined();
    expect(within(row).getByText('Прорабов П. П.')).toBeDefined();
  });

  it('помечает день, который отработала не машина заявки', async () => {
    renderDays();
    await screen.findByText('11.08.2026');

    const row = dayRow('11.08.2026');
    // Назначение у линейного заказа — машина по умолчанию, а работает в конкретный день та, чьим
    // рейсом день закрыт: расхождение законно и помечается, а не отклоняется (решение 4).
    expect(within(row).getByText('не машина заявки')).toBeDefined();
    expect(within(row).getByText('ВС-22-02 · В222ВВ77')).toBeDefined();
    // Рейс собрали заранее, человека ставят утром — пустой водитель это состояние, а не поломка.
    expect(within(row).getByText('не назначен')).toBeDefined();
  });

  it('показывает неделю дня среза, а остальные дни — за переключателем недель', async () => {
    renderDays();
    await screen.findByText('10.08.2026');

    // Срез — среда 12 августа, значит неделя 10–16: дней следующей недели в таблице нет.
    expect(screen.queryByText('17.08.2026')).toBeNull();
    expect(screen.queryByText('19.08.2026')).toBeNull();
    expect(screen.getByText('распланировано 3 из 10 дней')).toBeDefined();

    fireEvent.click(screen.getByLabelText('Следующая неделя'));

    expect(await screen.findByText('17.08.2026')).toBeDefined();
    expect(screen.queryByText('10.08.2026')).toBeNull();
    // День за сроком остался в таблице с пометкой: лист за него уже у водителя, и прятать
    // выданную бумагу нельзя.
    expect(within(dayRow('19.08.2026')).getByText('за сроком')).toBeDefined();
  });

  it('«снять» убирает день с рейса, а замороженный листом день не отдаёт', async () => {
    const { http } = renderDays();
    await screen.findByText('11.08.2026');

    const frozen = dayRow('10.08.2026');
    expect(within(frozen).getByText('Снять').closest('button')!.disabled).toBe(true);
    expect(within(frozen).getByTitle(LINEAR_DAY_FROZEN_MESSAGE)).toBeDefined();

    fireEvent.click(within(dayRow('11.08.2026')).getByText('Снять'));

    await waitFor(() =>
      expect(http.countOf('DELETE /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    expect(http.lastCall('DELETE /vehicle-requests/:id/days/:date/route')!.path).toBe(
      '/vehicle-requests/vr-9/days/2026-08-11/route',
    );
  });

  it('у арендной заявки называет причину, а не показывает пустую таблицу', async () => {
    // Текст — тот же, которым откажет сервер (`linearDaysBlocker`): правило одно на портал и API.
    const reason =
      'Заявку ведут арендной техникой: в рейсы она не ходит, путевой лист на неё выписывает арендодатель';
    renderDays({ items: [], onDate: '2026-08-12', blocker: reason });

    expect(await screen.findByText(reason)).toBeDefined();
    expect(screen.queryByText('В рейс')).toBeNull();
  });
});

describe('день в рейс', () => {
  /** Открыть форму планирования на дне среза — том, который и планируют чаще всего. */
  async function openPlanning() {
    await screen.findByText('12.08.2026');
    fireEvent.click(within(dayRow('12.08.2026')).getByText('В рейс'));
    await screen.findByText('День 12.08.2026 в рейс');
  }

  it('спрашивает машину и водителя и уносит на сервер выбранное', async () => {
    const { http } = renderDays();
    await openPlanning();

    // Машина подставлена назначенной: ею закрывают большинство дней срока.
    await waitFor(() => expect(selectedText('Машина')).toContain('А111АА77'));
    // Водитель — пустым полем, даже когда пригоден он один: на разные дни выходят разные люди.
    expect(selectedText('Водитель')).toBeNull();

    await selectOption('Машина', /В222ВВ77/);
    await selectOption('Водитель', /Тестовый Водитель Первый/);
    fireEvent.click(screen.getByText('Поставить в рейс'));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    const call = http.lastCall('POST /vehicle-requests/:id/days/:date/route')!;
    // День — часть адреса, а не тела: второй ответ на «за какой это день» разошёлся бы с первым.
    expect(call.path).toBe('/vehicle-requests/vr-9/days/2026-08-12/route');
    expect(call.body).toEqual({
      newRoute: { vehicleId: 'v-lift-2', driverPersonId: 'p-1', trip: EMPTY_TRIP },
    });
  });

  /**
   * Прошедший день (ADR 0101 п. 4, дыра 1 плана). Правило дней прошлое разрешает — выезд оформляют
   * и задним числом, — но сервер спрашивает за него право и причину, и форма обязана спросить её
   * первой: иначе человек соберёт рейс и получит 422 на нажатии.
   *
   * Прошедшим день считается по **дню среза от сервера** (`onDate`), а не по часам браузера: тем
   * же поясом границу считает `backdateGuard`, и разъехаться им нельзя.
   */
  it('у прошедшего дня спрашивает причину и уносит её на сервер', async () => {
    const { http } = renderDays({
      ...DAYS,
      items: DAYS.items.map((day) => (day.date === '2026-08-11' ? free('2026-08-11') : day)),
    });
    await screen.findByText('11.08.2026');
    fireEvent.click(within(dayRow('11.08.2026')).getByText('В рейс'));
    await screen.findByText('День 11.08.2026 в рейс');

    // Без причины форма запрос не отправляет вовсе: тело заведомо отклоняемое.
    fireEvent.click(screen.getByText('Поставить в рейс'));
    await screen.findByText('Укажите причину');
    expect(http.countOf('POST /vehicle-requests/:id/days/:date/route')).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина заднего числа'), {
      target: { value: 'машина отработала день, вносим по факту' },
    });
    fireEvent.click(screen.getByText('Поставить в рейс'));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    expect(http.lastCall('POST /vehicle-requests/:id/days/:date/route')!.body).toEqual({
      newRoute: { vehicleId: 'v-lift', driverPersonId: null, trip: EMPTY_TRIP },
      reason: 'машина отработала день, вносим по факту',
    });
  });

  it('день среза причины не требует: сегодняшний выезд не задним числом', async () => {
    const { http } = renderDays();
    await openPlanning();

    expect(screen.queryByLabelText('Причина заднего числа')).toBeNull();
    fireEvent.click(screen.getByText('Поставить в рейс'));
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    expect(http.lastCall('POST /vehicle-requests/:id/days/:date/route')!.body).toEqual({
      newRoute: { vehicleId: 'v-lift', driverPersonId: null, trip: EMPTY_TRIP },
    });
  });

  it('готовый рейс машины на этот день предлагается первым', async () => {
    const { http } = renderDays(DAYS, [ROUTE_16]);
    await openPlanning();

    // Второй объект того же дня обязан попасть в тот же лист, пока в нём есть строки задания.
    await waitFor(() => expect(selectedText('Рейс')).toContain('Р-16'));
    expect(screen.getByText('Водитель рейса Р-16 — Тестовый Водитель Первый')).toBeDefined();

    fireEvent.click(screen.getByText('Поставить в рейс'));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    expect(http.lastCall('POST /vehicle-requests/:id/days/:date/route')!.body).toEqual({
      routeId: 'r-16',
    });
  });
});

describe('линейный день в составе рейса', () => {
  it('читается днём заказа, снимается отсюда — а добавляется только из карточки заявки', async () => {
    mockHttp({
      'GET /vehicle-routes/:id': () => json(ROUTE_16),
      // Подсказка «что положить в рейс»: линейных заказов в ней нет и быть не должно.
      'GET /vehicle-requests': () => json(list([])),
    });
    renderWithUser(<VehicleRouteModal routeId="r-16" onClose={() => {}} onChanged={() => {}} />);

    expect(await screen.findByText('ТС-42')).toBeDefined();
    expect(screen.getByText('ЖК Северный')).toBeDefined();
    expect(screen.getByText('день заказа 12.08.2026')).toBeDefined();
    expect(
      screen.getByText(
        'День работ на объекте: в задание печатаются адрес площадки и характер работ',
      ),
    ).toBeDefined();
    // Снять день со стороны рейса можно, добавить — нельзя, и дверь названа словами.
    expect(screen.getByTitle('Снять день с рейса')).toBeDefined();
    expect(screen.getByText(LINEAR_DAY_DOOR_MESSAGE)).toBeDefined();
  });
});

/**
 * Срез гаража после правки дня линейного заказа (ADR 0131).
 *
 * Заготовка — рейс без состава и без выписанного листа — из среза дня ушла: занятость машины и
 * назначенность водителя следуют теперь не из факта существования рейса, а из того, есть ли по
 * нему куда ехать. Значит состав рейса решает, видна ли работа в срезе, — а планирование дней
 * состав как раз и меняет: поставленный день наполняет рейс, снятый опустошает, и опустевший рейс
 * без листа пропадает из среза целиком. Обе двери обязаны погасить кэш гаража: своих таблиц у него
 * нет, чужие корни (`['vehicle-requests']`, `['vehicle-routes']`) до `['garage']` не достают.
 *
 * Проверяется пометка кэша, а не перерисовка среза, — по той же причине, что в
 * `garage-invalidation`: у тестового `QueryClient` `staleTime` равен нулю, поэтому гараж
 * перезапросился бы при открытии сам, и сценарий «перешли и увидели свежее» прошёл бы даже с
 * невыполненной инвалидацией.
 */
describe('срез гаража после правки дня', () => {
  /** Вкладка «Техника» гаража на день среза: день и фильтры приходят внутри параметров. */
  const GARAGE_KEY = garageKeys.vehicles({ on: '2026-08-12' });

  /**
   * Гараж, открытый до правки и лежащий в кэше свежим, — ровно так его застаёт диспетчер,
   * вернувшийся к срезу сразу после планирования.
   */
  function fillGarage(queryClient: QueryClient) {
    queryClient.setQueryData(GARAGE_KEY, { items: [], total: 0, onDate: '2026-08-12' });
    expect(queryClient.getQueryState(GARAGE_KEY)?.isInvalidated).toBe(false);
  }

  it('день, поставленный в рейс, помечает срез дня устаревшим', async () => {
    const { http, queryClient } = renderDays();
    await screen.findByText('12.08.2026');
    fillGarage(queryClient);

    fireEvent.click(within(dayRow('12.08.2026')).getByText('В рейс'));
    await screen.findByText('День 12.08.2026 в рейс');
    fireEvent.click(screen.getByText('Поставить в рейс'));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    await waitFor(() => expect(queryClient.getQueryState(GARAGE_KEY)?.isInvalidated).toBe(true));
  });

  it('день, снятый с рейса, помечает срез дня устаревшим', async () => {
    const { http, queryClient } = renderDays();
    await screen.findByText('11.08.2026');
    fillGarage(queryClient);

    fireEvent.click(within(dayRow('11.08.2026')).getByText('Снять'));

    await waitFor(() =>
      expect(http.countOf('DELETE /vehicle-requests/:id/days/:date/route')).toBe(1),
    );
    await waitFor(() => expect(queryClient.getQueryState(GARAGE_KEY)?.isInvalidated).toBe(true));
  });
});
