import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type {
  GarageBusyEntry,
  GarageDriverDto,
  GarageDriverListDto,
  GarageDriversSummaryDto,
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
} from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { vehicleFeed, vehicleRequest, vehicleSummary } from './factories/vehicle';
import { MOBILE_VIEWPORT } from './viewport';
import { DataTable, EntityLink } from '../src/shared/ui';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { GarageVehiclesTab } from '../src/pages/garage/GarageVehiclesTab';
import { GarageDriversTab } from '../src/pages/garage/GarageDriversTab';

/**
 * Рейс с телефона (ADR 0030, ADR 0120, план `docs/vehicle-routes-modal-plan.md` §3.4).
 *
 * Окно поверх страницы решает вопрос «а что там за маршрут» на десктопе само собой, а на телефоне
 * — нет: там номер живёт внутри строки карточки, и до реформы половина входов в рейс с телефона
 * либо промахивалась, либо не существовала вовсе. Отсюда три правки, и проверяются здесь именно
 * они, а не вид экрана:
 *
 * — в карточке заявки рейс стал ссылкой **и** пунктом шита действий: пальцем по пункту во весь
 *   экран попадают вернее, чем по номеру между двух слов, а ссылка остаётся ради Ctrl-клика;
 * — обе вкладки гаража завели пункты по рейсам дня. Это была дыра, а не неудобство: занятость
 *   там текстовая строка, ссылки в ней нет вовсе — с телефона рейс из гаража не открывался никак.
 *   Пунктов столько же, сколько рейсов у записи: машина за день ходит несколькими, и единственный
 *   «главный» пункт молча прятал бы остальные;
 * — `ListCard` перестал отдавать себе любое касание и спрашивает то же правило, что строка
 *   таблицы (`opensRow`): иначе нажатие на номер рейса значило бы сразу две вещи — открыть рейс и
 *   открыть саму запись поверх него.
 */

const ON_DATE = '2026-08-18';

/** Заказ в рейсе: ровно та строка списка, у которой на телефоне спрашивают «где она едет». */
const ORDER = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  route: {
    id: 'route-1',
    displayNumber: 'Р-12',
    routeDate: ON_DATE,
    position: 1,
    hasWaybill: false,
    version: 3,
  },
});

const FEED_ROUTES: RouteMap = {
  'GET /vehicle-requests/feed': () => json(vehicleFeed([ORDER])),
  'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
  'GET /objects': () => json(emptyList()),
  'GET /departments': () => json(emptyList()),
  'GET /vehicle-classifications': () => json([]),
  // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
  'GET /vehicles': () => json(emptyList()),
};

/** Открыть шит действий записи: на телефоне колонки кнопок нет, есть одна «точечная» кнопка. */
function openActions(index = 0) {
  fireEvent.click(screen.getAllByLabelText('Действия')[index]!);
}

describe('телефон: рейс из карточки заявки', () => {
  it('открывается нажатием на номер в строке карточки — и саму заявку при этом не открывает', async () => {
    const openRoute = vi.fn();
    mockHttp(FEED_ROUTES);
    renderWithUser(<VehicleRequestsTab />, {
      viewport: MOBILE_VIEWPORT,
      routeModal: { openRoute },
    });

    // Карточка, а не таблица: телефонное представление списка (ADR 0030).
    expect(await screen.findByText('Т-42')).toBeDefined();
    expect(document.querySelector('.ant-table')).toBeNull();

    fireEvent.click(screen.getByText('Р-12'));
    expect(openRoute).toHaveBeenCalledWith('route-1');
    /*
     * И ничего больше: до правки `ListCard` карточка забирала себе любое касание, поэтому один
     * палец открыл бы и рейс, и карточку заявки поверх него — человек увидел бы не то, что
     * нажимал, а собранное из двух действий.
     */
    expect(screen.queryByText('Заявка Т-42')).toBeNull();
  });

  it('дублируется пунктом действий с номером рейса в подписи', async () => {
    const openRoute = vi.fn();
    mockHttp(FEED_ROUTES);
    renderWithUser(<VehicleRequestsTab />, {
      viewport: MOBILE_VIEWPORT,
      routeModal: { openRoute },
    });

    expect(await screen.findByText('Т-42')).toBeDefined();
    openActions();

    // Номер в подписи не украшение: по нему видно, тот ли это рейс, о котором думаешь, ещё до
    // нажатия — иначе пункт обещал бы «какой-то маршрут».
    fireEvent.click(screen.getByText('Открыть маршрут Р-12'));
    expect(openRoute).toHaveBeenCalledWith('route-1');
  });
});

/** Два рейса дня и заказ на площадке рядом: пункты положены только рейсам, и обоим. */
const BUSY: GarageBusyEntry[] = [
  {
    kind: 'route',
    routeId: 'route-1',
    displayNumber: 'Р-12',
    purpose: 'freight',
    vehicleId: 'v-1',
    vehicleLabel: 'Е646СК799',
    vehicleModelName: 'КамАЗ 65201',
    vehicleOwnership: 'own',
    vehicleWaybillFormCode: '4p',
    driverPersonId: 'p-1',
    driverName: 'Иванов Иван Иванович',
    moveFrom: '',
    moveTo: '',
    sourceRequest: null,
    requests: [
      {
        requestId: 'req-1',
        displayNumber: 'ТС-501',
        status: 'confirmed',
        customerName: 'Объект А',
        workDate: null,
      },
    ],
    waybill: null,
  },
  {
    kind: 'route',
    routeId: 'route-2',
    displayNumber: 'Р-13',
    purpose: 'freight',
    vehicleId: 'v-1',
    vehicleLabel: 'Е646СК799',
    vehicleModelName: 'КамАЗ 65201',
    vehicleOwnership: 'own',
    vehicleWaybillFormCode: '4p',
    driverPersonId: 'p-1',
    driverName: 'Иванов Иван Иванович',
    moveFrom: '',
    moveTo: '',
    sourceRequest: null,
    requests: [],
    waybill: null,
  },
  {
    kind: 'esm2',
    waybillId: 'w-9',
    number: 'ЭСМ-00000004',
    status: 'issued',
    periodFrom: '2026-08-17',
    periodTo: '2026-08-23',
    vehicleId: 'v-1',
    vehicleLabel: 'Е646СК799',
    vehicleModelName: 'КамАЗ 65201',
    vehicleOwnership: 'own',
    vehicleWaybillFormCode: '4p',
    driverPersonId: 'p-1',
    driverName: 'Иванов Иван Иванович',
    sourceRequest: null,
  },
];

const VEHICLE: GarageVehicleDto = {
  id: 'v-1',
  state: 'on_route',
  status: 'active',
  label: 'Е646СК799',
  registrationNumber: 'Е646СК799',
  garageNumber: '12',
  modelName: 'КамАЗ 65201',
  vehicleTypeId: 'vt-1',
  typeName: 'Самосвалы',
  vehicleCategoryId: null,
  categoryName: null,
  drivers: [{ personId: 'p-1', fullName: 'Иванов Иван Иванович' }],
  busy: BUSY,
};

const DRIVER: GarageDriverDto = {
  personId: 'p-1',
  state: 'assigned',
  fullName: 'Иванов Иван Иванович',
  personnelNo: 'Т-100',
  phone: '9990000000',
  credentialTypeCode: 'driver_license',
  licenseNumber: '00 00 000100',
  licenseExpiresOn: '2099-03-12',
  licenseDefect: null,
  categories: ['C'],
  gaps: [],
  busy: BUSY,
};

const GARAGE_ROUTES: RouteMap = {
  'GET /garage/vehicles': () =>
    json({
      items: [VEHICLE],
      total: 1,
      page: 1,
      pageSize: 50,
      onDate: ON_DATE,
    } satisfies GarageVehicleListDto),
  'GET /garage/vehicles/summary': () =>
    json({
      total: 1,
      free: 0,
      onRoute: 1,
      onSite: 0,
      unavailable: 0,
      routesWithoutDriver: 0,
      onDate: ON_DATE,
    } satisfies GarageVehiclesSummaryDto),
  'GET /garage/drivers': () =>
    json({
      items: [DRIVER],
      total: 1,
      page: 1,
      pageSize: 50,
      onDate: ON_DATE,
    } satisfies GarageDriverListDto),
  'GET /garage/drivers/summary': () =>
    json({
      total: 1,
      free: 0,
      assigned: 1,
      documentsIncomplete: 0,
      onDate: ON_DATE,
    } satisfies GarageDriversSummaryDto),
  'GET /vehicle-classifications': () => json([]),
  // Справочник площадок наполняет фильтр отбора по объекту — своих строк среза он не даёт.
  'GET /objects': () => json(emptyList()),
  'GET /vehicle-maintenance/snapshot': ({ query }) =>
    json({ on: query.get('on') ?? '', items: [] }),
  // Колонка «Запчасти, ₽» — свой пакетный запрос и никаких особых прав (план чеков, Р14, Р5).
  'GET /auto-part-receipts/vehicles/snapshot': ({ query }) =>
    json({ to: query.get('to') ?? '', items: [] }),
};

describe('телефон: рейс из гаража', () => {
  it('карточка техники даёт пункт на каждый рейс дня', async () => {
    const openRoute = vi.fn();
    mockHttp(GARAGE_ROUTES);
    renderWithUser(<GarageVehiclesTab date={ON_DATE} dayControls={null} />, {
      viewport: MOBILE_VIEWPORT,
      routeModal: { openRoute },
    });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    openActions();

    /*
     * Пунктов ровно два — по числу рейсов, а не один «первый попавшийся»: машина за день ходит
     * несколькими, и спрашивают чаще про последний. Недельный лист в тот же день пункта не даёт:
     * рейса за ним нет, открывать нечего.
     */
    expect(screen.getAllByText(/^Открыть маршрут /u).map((el) => el.textContent)).toEqual([
      'Открыть маршрут Р-12',
      'Открыть маршрут Р-13',
    ]);

    fireEvent.click(screen.getByText('Открыть маршрут Р-13'));
    expect(openRoute).toHaveBeenCalledWith('route-2');
  });

  it('карточка водителя даёт те же пункты — до этого с телефона в рейс было не попасть', async () => {
    const openRoute = vi.fn();
    mockHttp(GARAGE_ROUTES);
    renderWithUser(<GarageDriversTab date={ON_DATE} dayControls={null} />, {
      viewport: MOBILE_VIEWPORT,
      routeModal: { openRoute },
    });

    expect(await screen.findByText('Иванов Иван Иванович')).toBeDefined();
    openActions();

    expect(screen.getAllByText(/^Открыть маршрут /u).map((el) => el.textContent)).toEqual([
      'Открыть маршрут Р-12',
      'Открыть маршрут Р-13',
    ]);

    fireEvent.click(screen.getByText('Открыть маршрут Р-12'));
    expect(openRoute).toHaveBeenCalledWith('route-1');
  });

  it('без права на рейс шит действий не становится второй дверью мимо него', async () => {
    mockHttp(GARAGE_ROUTES);
    // Механик: гараж ему положен (`garage.read`), рейсы — нет (`vehicleRequests.status`). На
    // десктопе номер остаётся текстом, и пункт шита обязан исчезнуть тем же условием — иначе
    // окно открывалось бы там, где ссылки не показывают.
    renderWithUser(<GarageDriversTab date={ON_DATE} dayControls={null} />, {
      viewport: MOBILE_VIEWPORT,
      user: authUser({ role: 'mechanic' }),
    });

    expect(await screen.findByText('Иванов Иван Иванович')).toBeDefined();
    // Других действий у карточки водителя нет вовсе, поэтому исчезает и сама кнопка шита.
    expect(screen.queryByLabelText('Действия')).toBeNull();
  });
});

interface Row {
  id: string;
  number: string;
}

describe('ссылка внутри мобильной карточки', () => {
  const ROWS: Row[] = [{ id: 'a', number: 'Т-42' }];
  const COLUMNS = [{ key: 'number', title: '№', dataIndex: 'number' }];

  function renderCard(onOpen: () => void, onActivate: () => void) {
    renderWithUser(
      <DataTable<Row>
        columns={COLUMNS}
        card={{
          title: (r) => r.number,
          onOpen,
          lines: [
            () => (
              <>
                Маршрут{' '}
                <EntityLink
                  to="/vehicle-requests?route=route-1"
                  title="Открыть маршрут"
                  onActivate={onActivate}
                >
                  Р-12
                </EntityLink>
              </>
            ),
          ],
        }}
        data={ROWS}
        total={1}
        page={1}
        pageSize={50}
        onChange={vi.fn()}
      />,
      { viewport: MOBILE_VIEWPORT },
    );
  }

  it('открывает связанную запись, а карточку, в которой лежит, — нет', () => {
    const onOpen = vi.fn();
    const onActivate = vi.fn();
    renderCard(onOpen, onActivate);

    fireEvent.click(screen.getByText('Р-12'));
    expect(onActivate).toHaveBeenCalledTimes(1);
    // Одно касание — одно действие. `ListCard` спрашивает то же правило, что строка таблицы:
    // разъедься они, один и тот же список вёл бы себя на телефоне и на десктопе по-разному.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('касание мимо ссылки карточку по-прежнему открывает', () => {
    const onOpen = vi.fn();
    const onActivate = vi.fn();
    renderCard(onOpen, onActivate);

    // Контроль к предыдущему: проверять «не открылась» имеет смысл только там, где она вообще
    // открывается, — иначе тест прошёл бы и на карточке, разучившейся открываться совсем.
    fireEvent.click(screen.getByText('Т-42'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
