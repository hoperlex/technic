import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useSearchParams } from 'react-router';
import type { VehicleRouteDto, WaybillDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { vehicleFeed, vehicleRequest, vehicleSummary } from './factories/vehicle';
import { wasteRequest } from './factories/waste';
import { VehicleRoutesTab } from '../src/pages/vehicle/VehicleRoutesTab';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { VehicleRequestsPage } from '../src/pages/VehicleRequestsPage';
import { WaybillsPage } from '../src/pages/WaybillsPage';
import { OnSiteTab } from '../src/pages/waste/OnSiteTab';

/**
 * Переход по номеру чужой записи: ссылка ведёт на вкладку, где запись показывают, и просит
 * открыть её карточку (`?tab=…&open=…`).
 *
 * Проверяется не «клик открывает окно», а два правила, которые ломаются молча и обнаруживаются
 * людьми:
 *
 * — вкладка выбирается по состоянию записи. Лист выписывают на рейс, а читают журнал позже, когда
 *   заявка уже закрыта: ссылка на список заявок привела бы в список, где её нет;
 * — ссылки нет там, где вкладка роли не положена. Ведущая в закрытый раздел ссылка кончается
 *   пустым экраном — это хуже, чем номер обычным текстом, каким он и был.
 */

const admin = authUser({ id: 'user-admin', role: 'admin' });
/** Штаб объекта: заявки видит, но рейсы и журнал листов ему не положены (ADR 0021). */
const shtab = authUser({ id: 'user-shtab', role: 'shtab', constructionObjectIds: ['obj-1'] });

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: '2026-07-20',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
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
  communicationKind: '',
  transportationKind: '',
  comment: '',
  requests: [
    {
      requestId: 'r-open',
      displayNumber: 'ТС-501',
      position: 1,
      status: 'confirmed',
      customerName: 'Объект А',
      loadingLocation: 'Карьер',
      unloadingLocation: 'Площадка 1',
      scheduledAt: '2026-07-20T06:00:00.000Z',
      scheduledTimeUnspecified: false,
      cargoLabel: '12 м³',
    },
    {
      requestId: 'r-done',
      displayNumber: 'ТС-502',
      position: 2,
      status: 'done',
      customerName: 'Объект Б',
      loadingLocation: 'Карьер',
      unloadingLocation: 'Площадка 2',
      scheduledAt: '2026-07-20T07:00:00.000Z',
      scheduledTimeUnspecified: false,
      cargoLabel: '12 м³',
    },
  ],
  waybill: {
    id: 'w-1',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: '2026-07-20',
  },
  createdByName: 'Диспетчер',
  createdAt: '2026-07-19T09:00:00.000Z',
  version: 3,
};

const WAYBILL: WaybillDto = {
  id: 'w-1',
  number: '260604-646-00000004897',
  formCode: '4p',
  status: 'issued',
  issuedForDate: '2026-07-20',
  periodFrom: null,
  periodTo: null,
  organizationName: 'ООО «СУ-10»',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-1',
  driverName: 'Иванов Иван Иванович',
  withTrailer: false,
  trailerLabel: '',
  issuedByName: 'Диспетчер',
  issuedAt: '2026-07-20T06:00:00.000Z',
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: '',
  printedAt: null,
  exportedAt: null,
  isCorrection: false,
  correctionReason: '',
  correctsNumber: null,
  correctedByNumber: null,
  requests: [
    {
      requestId: 'r-done',
      displayNumber: 'ТС-502',
      slot: 1,
      objectName: 'Объект Б',
      status: 'done',
    },
  ],
  files: [],
};

/** Ссылка по видимому номеру: `EntityLink` рисует обычный `<a>` с адресом вкладки. */
const linkFor = (text: string): HTMLAnchorElement | null =>
  [...document.querySelectorAll('a')].find((a) => a.textContent === text) ?? null;

/**
 * Справочники панели фильтров: техника и водители спрашиваются обоими списками — маршрутами и
 * журналом листов. Здесь они пустые: тест про ссылки между вкладками, а не про отбор.
 */
const DIRECTORIES: RouteMap = {
  'GET /vehicles': () => json(list([])),
  'GET /drivers': () => json(list([])),
};

function routesRoutes(over: RouteMap = {}): RouteMap {
  return {
    'GET /vehicle-routes': () => json(list([ROUTE])),
    'GET /vehicle-routes/:id': () => json(ROUTE),
    ...DIRECTORIES,
    ...over,
  };
}

describe('переход по номеру записи между вкладками', () => {
  it('состав рейса ведёт к заявке, а вкладку выбирает её состояние', async () => {
    mockHttp(routesRoutes());
    renderWithUser(<VehicleRoutesTab />, { user: admin });

    await screen.findByText('Р-12');
    // Заявка в работе живёт в списке, закрытая — в журнале закрытых (ADR 0029).
    expect(linkFor('ТС-501')!.getAttribute('href')).toBe(
      '/vehicle-requests?tab=requests&open=r-open',
    );
    expect(linkFor('ТС-502')!.getAttribute('href')).toBe(
      '/vehicle-requests?tab=history&open=r-done',
    );
  });

  it('номер листа в рейсе ведёт в журнал с этим же номером в поиске', async () => {
    mockHttp(routesRoutes());
    renderWithUser(<VehicleRoutesTab />, { user: admin });

    await screen.findByText('Р-12');
    expect(linkFor('260604-646-00000004897')!.getAttribute('href')).toBe(
      `/waybills?number=${encodeURIComponent('260604-646-00000004897')}`,
    );
  });

  it('номер рейса в строке заявки ведёт на вкладку маршрутов', async () => {
    const inRoute = vehicleRequest({
      id: 'vr-1',
      status: 'confirmed',
      route: {
        id: 'route-1',
        displayNumber: 'Р-12',
        routeDate: '2026-07-20',
        position: 1,
        hasWaybill: false,
        version: 3,
      },
    });
    mockHttp({
      'GET /vehicle-requests/feed': () => json(vehicleFeed([inRoute])),
      'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /vehicle-classifications': () => json([]),
      // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
      'GET /vehicles': () => json(emptyList()),
    });
    renderWithUser(<VehicleRequestsTab />, { user: admin });

    await screen.findByText('Т-42');
    expect(linkFor('Р-12')!.getAttribute('href')).toBe('/vehicle-requests?tab=routes&open=route-1');
  });

  it('без права на маршруты номер рейса остаётся текстом', async () => {
    const inRoute = vehicleRequest({
      id: 'vr-1',
      status: 'confirmed',
      route: {
        id: 'route-1',
        displayNumber: 'Р-12',
        routeDate: '2026-07-20',
        position: 1,
        hasWaybill: false,
        version: 3,
      },
    });
    mockHttp({
      'GET /vehicle-requests/feed': () => json(vehicleFeed([inRoute])),
      'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /vehicle-classifications': () => json([]),
      // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
      'GET /vehicles': () => json(emptyList()),
    });
    renderWithUser(<VehicleRequestsTab />, { user: shtab });

    await screen.findByText('Т-42');
    expect(screen.getByText('Р-12')).toBeTruthy();
    expect(linkFor('Р-12')).toBeNull();
  });

  it('талон заказчика в журнале листов ведёт к заявке', async () => {
    mockHttp({ 'GET /waybills': () => json(list([WAYBILL])), ...DIRECTORIES });
    renderWithUser(<WaybillsPage />, { user: admin });

    await screen.findByText('260604-646-00000004897');
    expect(linkFor('ТС-502')!.getAttribute('href')).toBe(
      '/vehicle-requests?tab=history&open=r-done',
    );
  });

  it('журнал листов открывается по номеру из адреса', async () => {
    const http = mockHttp({ 'GET /waybills': () => json(list([WAYBILL])), ...DIRECTORIES });
    renderWithUser(<WaybillsPage />, {
      user: admin,
      route: `/waybills?number=${encodeURIComponent('260604-646-00000004897')}`,
    });

    await waitFor(() =>
      expect(http.lastCall('GET /waybills')!.query.get('search')).toBe('260604-646-00000004897'),
    );
    // Номер из адреса виден и в самом поле поиска: иначе журнал выглядел бы отобранным
    // неизвестно по чему, и сбросить отбор было бы нечем.
    await waitFor(() =>
      expect(screen.getByPlaceholderText<HTMLInputElement>('Номер листа').value).toBe(
        '260604-646-00000004897',
      ),
    );
  });

  it('номер заявки установки в списке площадок ведёт к самой заявке', async () => {
    mockHttp({
      'GET /waste-requests/present': () => json(list([wasteRequest({ id: 'wr-7' })])),
    });
    renderWithUser(<OnSiteTab />, { user: admin });

    await screen.findByText('ЖК Северный');
    expect(linkFor('М-128')!.getAttribute('href')).toBe('/waste?tab=requests&open=wr-7');
  });
});

/**
 * Адрес страницы под наблюдением: в jsdom закрытое окно antd остаётся в разметке как есть —
 * анимации там не проигрываются, и «закрылось ли оно» по классам не прочитать. Проверяется
 * поэтому сам предмет правила: карточку показывают, пока запись названа в адресе.
 */
function UrlSpy() {
  const [searchParams] = useSearchParams();
  return <div data-testid="url">{searchParams.toString()}</div>;
}

/** Ручки, без которых страница раздела не отрисуется: списки и сводки её вкладок. */
function vehiclePageRoutes(over: RouteMap = {}): RouteMap {
  return {
    'GET /vehicle-requests': () => json(emptyList()),
    // Вкладка «Заказ автотехники» читает ленту: заказы и недельные заявки одним списком.
    'GET /vehicle-requests/feed': () => json(vehicleFeed([])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary()),
    'GET /vehicle-requests/history': () => json(emptyList()),
    'GET /vehicle-requests/history/summary': () =>
      json({ total: 0, done: 0, cancelled: 0, totalCost: 0, withoutCost: 0 }),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json([]),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /vehicle-requests/:id/history': () => json([]),
    'GET /vehicle-requests/:id/waybills': () => json([]),
    'GET /vehicle-requests/:id/relocations': () => json([]),
    ...over,
  };
}

describe('карточка, названная в адресе страницы', () => {
  it('открывается по `open`, даже если строки нет в загруженном списке', async () => {
    const opened = vehicleRequest({ id: 'vr-77', displayNumber: 'ТС-77', status: 'confirmed' });
    const http = mockHttp(vehiclePageRoutes({ 'GET /vehicle-requests/:id': () => json(opened) }));
    renderWithUser(<VehicleRequestsPage />, {
      user: admin,
      route: '/vehicle-requests?tab=requests&open=vr-77',
    });

    // Список пуст: заявку спрашивают по идентификатору, а не ищут в его строках.
    await screen.findByText('Заявка ТС-77');
    expect(http.lastCall('GET /vehicle-requests/:id')!.path).toContain('vr-77');
  });

  it('спрашивается ровно одной вкладкой — той, что названа в адресе', async () => {
    const closed = vehicleRequest({ id: 'vr-88', displayNumber: 'ТС-88', status: 'done' });
    const http = mockHttp(vehiclePageRoutes({ 'GET /vehicle-requests/:id': () => json(closed) }));
    renderWithUser(<VehicleRequestsPage />, {
      user: admin,
      route: '/vehicle-requests?tab=history&open=vr-88',
    });

    await screen.findByText('Заявка ТС-88');
    // Списков заявок в разделе три, и все они остаются смонтированными: без проверки «моя вкладка
    // активна» один и тот же идентификатор запросили бы разом три вкладки. Считается точный
    // путь: шаблон `:id` совпал бы заодно со сводкой и журналом.
    const byId = http.calls.filter((c) => c.path === '/vehicle-requests/vr-88');
    expect(byId.length).toBe(1);
  });

  it('закрытие карточки убирает её из адреса, а вкладку оставляет', async () => {
    const opened = vehicleRequest({ id: 'vr-77', displayNumber: 'ТС-77', status: 'confirmed' });
    mockHttp(vehiclePageRoutes({ 'GET /vehicle-requests/:id': () => json(opened) }));
    renderWithUser(
      <>
        <UrlSpy />
        <VehicleRequestsPage />
      </>,
      { user: admin, route: '/vehicle-requests?tab=requests&open=vr-77' },
    );

    await screen.findByText('Заявка ТС-77');
    fireEvent.click(document.querySelector('.ant-modal-close')!);

    // Останься `open` — при следующем возвращении на страницу карточка открылась бы сама;
    // вкладка же остаётся выбранной: закрыли карточку, а не ушли из списка.
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('tab=requests'));
  });
});
