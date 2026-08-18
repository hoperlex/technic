import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  VehicleRequestAssignmentDto,
  VehicleRequestCompletionDto,
  VehicleRouteDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  approvedVehicleRequest,
  classification,
  vehicleFeed,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { MOBILE_VIEWPORT } from './viewport';
import { expectModalClosed } from './antd';

/**
 * Возврат заявки на технику из «В работе» в «Новую» — откат администратора, который стирает всё,
 * что заявка нажила в работе (`transitionResetsWork`): назначенную машину со ставками, место в
 * рейсе, перегоны, визу руководителя строительства и предъявленный факт.
 *
 * Сценарий стережёт три вещи, каждая из которых по разметке неотличима от исправной работы:
 *
 * 1. Возврат не выполняется нажатием пункта меню: сперва окно с обязательной причиной — тем же,
 *    что и у отмены. Уйди запрос сразу, работа стёрлась бы промахом по соседнему пункту.
 * 2. Перечень стираемого собран по данным самой заявки, а не написан статикой: обещать снятие
 *    визы у заявки без визы или перегона у той, которой его не заводили, — врать человеку ровно
 *    там, где он решает, стирать ли работу.
 * 3. На сервер уходит один PATCH статуса — с причиной и версией заявки, — а список после него
 *    перезапрашивается: строка со старым статусом читалась бы как «возврат не прошёл».
 */

// Сценарий ведёт весь экран — список, меню статусов, окно причины: пяти секунд по умолчанию ему
// хватает не всегда, а упавший по таймауту тест читается как поломка портала.

/** Собственная машина со ставкой: её назначение и есть та договорённость, которую стирает возврат. */
const OWN_VEHICLE: VehicleRequestAssignmentDto = {
  vehicleId: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  vehicleCategoryId: 'vc-1',
  categoryName: 'г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Е646СК799',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: 2500,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Д. П.',
  assignedAt: '2026-08-02T08:00:00.000Z',
};

/** Арендная: ставок по ней не согласовали, и назвать в перечне остаётся арендодателя. */
const RENTAL_VEHICLE: VehicleRequestAssignmentDto = {
  ...OWN_VEHICLE,
  vehicleId: 'v-2',
  ownership: 'rental',
  registrationNumber: null,
  modelName: null,
  description: 'Автокран 25 тн',
  lessorId: 'cp-9',
  lessorName: 'ООО «Кран-Сервис»',
  pricePerHour: null,
};

/**
 * Факт у заявки «В работе» — не выдумка: так выглядит заявка, которую уже закрывали и откатили
 * администратором назад в работу (откат `done` → `confirmed` прежний факт бережёт). Возврат в
 * «Новую» — единственный переход, который его стирает, и сказать об этом нужно заранее.
 */
const COMPLETION: VehicleRequestCompletionDto = {
  workedUnit: 'hours',
  workedAmount: 26,
  rate: null,
  totalCost: null,
  completedBy: 'user-1',
  completedByName: 'Диспетчеров Д. П.',
  completedAt: '2026-08-03T14:00:00.000Z',
};

/** Перегон доставки (миграция 0082): едет ради этой заявки и на назначенной ей машине. */
const DELIVERY: VehicleRouteDto = {
  id: 'route-8',
  displayNumber: 'Р-8',
  purpose: 'delivery',
  formCode: '4p',
  routeDate: '2026-08-05',
  vehicleId: 'v-1',
  vehicleLabel: 'Ивановец КС-45717 · Е646СК799',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  vehicleTypeName: 'Автокраны',
  vehicleCategoryId: 'vc-1',
  vehicleCategorySpecs: { lift_capacity: 25 },
  driverPersonId: 'p-1',
  driverGaps: [],
  driverName: 'Водителев В. В.',
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
  // Состава у перегона нет: вместо талонов заказчиков он держит заявку, ради которой едет.
  requests: [],
  // Порядок объезда сценарию не нужен: он проверяет не сборку дня, а рейс целиком.
  points: [],
  sourceRequest: {
    requestId: 'vr-1',
    displayNumber: 'Т-42',
    status: 'confirmed',
    customerName: 'ЖК Северный',
  },
  moveFrom: 'База, Каширское ш., 12',
  moveTo: 'ЖК Северный',
  // Лист не выписан: с выписанным сервер возврат не пропустит вовсе (`ROLLBACK_WAYBILL_MESSAGE`).
  waybill: null,
  createdByName: 'Диспетчеров Д. П.',
  createdAt: '2026-08-03T06:00:00.000Z',
  version: 1,
};

/**
 * Заявка в работе со всем нажитым: виза, машина со ставкой, место в рейсе и факт прошлого
 * закрытия. Версия нарочно не первая — её видно в теле запроса.
 */
const IN_WORK = approvedVehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  version: 5,
  assignment: OWN_VEHICLE,
  completion: COMPLETION,
  route: {
    id: 'route-3',
    displayNumber: 'Р-3',
    routeDate: '2026-08-05',
    position: 2,
    hasWaybill: false,
    version: 4,
  },
});

const REASON = 'Заказчик перенёс работы, машину сняли';

/**
 * Вкладка глазами администратора: откат назад по циклу — его право
 * (`requests.rollbackStatus`), и пункта «Новая» в меню статусов больше ни у кого нет.
 */
function renderTab(over: RouteMap = {}, mobile = false): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([IN_WORK])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
    // Справочники экрана: сценарию не нужны, но вкладка их спрашивает при первом рендере.
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    // Перегоны спрашиваются, только когда окно возврата открыто: их портал стирает вместе с
    // машиной и потому обязан назвать по именам.
    'GET /vehicle-requests/:id/relocations': () => json([DELIVERY]),
    // Отвечаем той же заявкой, уже вернувшейся в «Новую», — так отвечает и сервер.
    'PATCH /vehicle-requests/:id/status': ({ params, body }) =>
      json(
        approvedVehicleRequest({
          ...IN_WORK,
          id: params.id,
          status: (body as { status: 'new' }).status,
          approvedBy: null,
          approvedByName: null,
          approvedAt: null,
          assignment: null,
          completion: null,
          route: null,
          version: IN_WORK.version + 1,
        }),
      ),
    ...over,
  });

  renderWithUser(<VehicleRequestsTab />, {
    user: authUser({ role: 'admin' }),
    viewport: mobile ? MOBILE_VIEWPORT : undefined,
  });
  return http;
}

/** Кнопка по видимой подписи: `*ByRole` на таблице antd считает доступные имена всему дереву. */
function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

/** Смена статуса строки: тег статуса — кнопка с меню переходов, доступных этой роли (ADR 0021). */
async function openStatusMenu(target: string) {
  clickButton('В работе');
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (el) => el.textContent === target,
    );
    expect(found, `пункт меню «${target}»`).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/** Кнопка окна возврата: подписи у неё свои — «Вернуть в «Новую»» и «Не возвращать». */
function submitRollbackModal() {
  clickButton('Вернуть в «Новую»');
}

const STATUS_ROUTE = 'PATCH /vehicle-requests/:id/status';

describe('возврат заявки на технику в «Новую»', () => {
  it('пункт меню открывает окно и перечисляет стираемое до нажатия', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
    // Пункт меню сам по себе ничего не меняет: работу стирает подтверждение, а не промах пальцем.
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    // Перечень — по данным этой заявки: машина со ставкой, её место в рейсе, заведённый перегон,
    // виза с именем подписанта и факт, оставшийся от прошлого закрытия.
    expect(await screen.findByText(/Назначенная техника: Е646СК799 — .*₽\/час/)).toBeDefined();
    expect(screen.getByText('Место в рейсе Р-3')).toBeDefined();
    expect(screen.getByText('Доставка техники на объект — рейс Р-8 от 05.08.2026')).toBeDefined();
    expect(screen.getByText('Виза руководителя строительства (Рукстроев Р. С.)')).toBeDefined();
    expect(screen.getByText('Предъявленный факт: 26 ч')).toBeDefined();
  });

  it('перечень не обещает того, чего у заявки нет', async () => {
    // Та же заявка, но арендной машиной, без рейса, перегонов и факта: стирать у неё нечего,
    // кроме назначения и визы.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(
          vehicleFeed([
            approvedVehicleRequest({
              ...IN_WORK,
              assignment: RENTAL_VEHICLE,
              completion: null,
              route: null,
            }),
          ]),
        ),
      'GET /vehicle-requests/:id/relocations': () => json([]),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();

    // У аренды ставок не согласовали — назван арендодатель: с ним договаривались, ему и звонить.
    expect(
      screen.getByText('Назначенная техника: Автокран 25 тн — ООО «Кран-Сервис»'),
    ).toBeDefined();
    expect(screen.getByText('Виза руководителя строительства (Рукстроев Р. С.)')).toBeDefined();
    expect(screen.queryByText(/Место в рейсе/)).toBeNull();
    expect(screen.queryByText(/Доставка техники/)).toBeNull();
    expect(screen.queryByText(/Предъявленный факт/)).toBeNull();
  });

  it('без причины окно не отпускает: на сервер ничего не уходит', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();

    submitRollbackModal();
    expect(await screen.findByText('Укажите причину')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    // Пробелы причиной не считаются: иначе поле обходилось бы нажатием на пробел, а в истории
    // статусов осталась бы пустая строка вместо объяснения, зачем стёрли работу.
    fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-42'), {
      target: { value: '   ' },
    });
    submitRollbackModal();
    await waitFor(() => expect(screen.getByText('Укажите причину')).toBeDefined());
    expect(http.countOf(STATUS_ROUTE)).toBe(0);
  });

  it('с причиной уходит один PATCH статуса — с причиной и версией заявки', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();

    // Причина набирается с лишними пробелами: в историю статусов она попадает обрезанной.
    fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-42'), {
      target: { value: `  ${REASON}  ` },
    });
    submitRollbackModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    const call = http.lastCall(STATUS_ROUTE);
    // Адрес — та самая заявка, из строки которой открыли меню.
    expect(call?.path).toBe(`/vehicle-requests/${IN_WORK.id}/status`);
    expect(call?.body).toMatchObject({
      status: 'new',
      // Причина обязательна и уходит тем же запросом, что и статус: отдельным она разъехалась бы
      // со сменой статуса при первом же отказе сервера.
      comment: REASON,
      // Версия — защита от одновременной правки: без неё сервер не отличит возврат «этой» заявки
      // от возврата той, которую тем временем успели взять в работу другой машиной.
      version: IN_WORK.version,
    });
    // Снятие машины и стирание факта — дело сервера: вторым запросом портал их не досылает.
    expect(http.calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
  });

  it('после возврата список перезапрашивается, а окно закрывается', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();
    expect(http.countOf('GET /vehicle-requests/feed')).toBe(1);

    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-42'), {
      target: { value: REASON },
    });
    submitRollbackModal();

    // Строка списка обязана показать новый статус сама: перезапрос — единственное, что об этом
    // заботится, а прежний статус на экране читался бы как «возврат не прошёл».
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/feed')).toBe(2));
    await expectModalClosed('Возврат заявки в «Новую»');
  });

  it('на телефоне окно открывается тем же путём — из списка статусов снизу', async () => {
    const http = renderTab({}, true);
    expect(await screen.findByText('Т-42')).toBeDefined();

    // На телефоне переходы показываются списком снизу, а не выпадающим меню (ADR 0030): пункт
    // «Новая» появляется там сам, и окно причины обязано открыться и отсюда — иначе возврат
    // с телефона уходил бы без объяснения либо не уходил вовсе.
    fireEvent.click(screen.getByLabelText('Изменить статус'));
    clickButton('Новая');

    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
    expect(screen.getByText('Место в рейсе Р-3')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-42'), {
      target: { value: REASON },
    });
    submitRollbackModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    expect(http.lastCall(STATUS_ROUTE)?.body).toMatchObject({ status: 'new', comment: REASON });
  });
});
