import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  GarageDriverDto,
  GarageDriverListDto,
  GarageDriversSummaryDto,
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж (ADR 0076): срез дня по своей технике и водителям.
 *
 * Проверяется то, ради чего раздел заведён: строка отвечает, чем машина и человек заняты в
 * выбранный день, а номера ведут в модули, где эту работу ведут. Плюс общий день: он живёт на
 * странице, а не во вкладке, и переключение вкладки его не сбрасывает — иначе переход «чем занята
 * машина» → «кто за рулём» терял бы день, ради которого его и делают.
 *
 * Данные приходят HTTP-моком: раздел держится за контракт ручек среза, а не за то, каким модулем
 * портал их сегодня зовёт.
 */

const ON_DATE = '2026-07-24';

const vehicles: GarageVehicleDto[] = [
  {
    id: 'v1',
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
    drivers: [{ personId: 'p1', fullName: 'Петров Пётр Петрович' }],
    busy: [
      {
        kind: 'route',
        routeId: 'route-1',
        displayNumber: 'Р-12',
        purpose: 'freight',
        vehicleId: 'v1',
        vehicleLabel: 'Е646СК799',
        driverPersonId: 'p1',
        driverName: 'Петров Пётр Петрович',
        moveFrom: '',
        moveTo: '',
        sourceRequest: null,
        requests: [
          {
            requestId: 'req-1',
            displayNumber: 'ТС-101',
            status: 'confirmed',
            customerName: 'Альфа-объект',
            // Грузоперевозка: своего дня у строки состава нет — день несёт сам рейс (ADR 0100 §2).
            workDate: null,
          },
        ],
        waybill: { waybillId: 'w-1', number: '260604-646-00000004897', status: 'issued' },
      },
    ],
  },
  {
    id: 'v2',
    state: 'on_site',
    status: 'active',
    label: 'В010ОР799',
    registrationNumber: 'В010ОР799',
    garageNumber: '',
    modelName: 'Экскаватор',
    vehicleTypeId: 'vt-2',
    typeName: 'Экскаваторы',
    vehicleCategoryId: 'vc-1',
    categoryName: 'Экскаватор, ковш 1 м³',
    drivers: [],
    busy: [
      {
        kind: 'special',
        requestId: 'req-2',
        displayNumber: 'ТС-205',
        status: 'confirmed',
        customerName: 'Бета-объект',
        dateFrom: '2026-07-20',
        dateTo: '2026-07-28',
        vehicleId: 'v2',
        vehicleLabel: 'В010ОР799',
        shift: { filled: true, approved: false },
        earlyEndPending: true,
      },
    ],
  },
  {
    id: 'v3',
    state: 'unavailable',
    status: 'maintenance',
    label: 'К777МН799',
    registrationNumber: 'К777МН799',
    garageNumber: '',
    modelName: null,
    vehicleTypeId: 'vt-1',
    typeName: 'Самосвалы',
    vehicleCategoryId: null,
    categoryName: null,
    drivers: [],
    busy: [],
  },
  {
    id: 'v4',
    state: 'free',
    status: 'active',
    label: 'Н123АА799',
    registrationNumber: 'Н123АА799',
    garageNumber: '',
    modelName: null,
    vehicleTypeId: 'vt-1',
    typeName: 'Самосвалы',
    vehicleCategoryId: null,
    categoryName: null,
    drivers: [],
    busy: [],
  },
];

const drivers: GarageDriverDto[] = [
  {
    personId: 'p1',
    state: 'assigned',
    fullName: 'Петров Пётр Петрович',
    personnelNo: 'Т-100',
    phone: '9990000000',
    credentialTypeCode: 'driver_license',
    licenseNumber: '00 00 000100',
    licenseExpiresOn: '2099-03-12',
    categories: ['B', 'C'],
    gaps: [],
    busy: [
      {
        kind: 'route',
        routeId: 'route-1',
        displayNumber: 'Р-12',
        purpose: 'freight',
        vehicleId: 'v1',
        vehicleLabel: 'Е646СК799',
        driverPersonId: 'p1',
        driverName: 'Петров Пётр Петрович',
        moveFrom: '',
        moveTo: '',
        sourceRequest: null,
        requests: [],
        waybill: null,
      },
    ],
  },
  {
    personId: 'p2',
    state: 'free',
    fullName: 'Сидоров Сидор Сидорович',
    personnelNo: 'Т-101',
    phone: '',
    credentialTypeCode: 'driver_license',
    licenseNumber: '',
    licenseExpiresOn: null,
    // Пробелы комплекта не убирают человека из списка и не делают его занятым (ADR 0064).
    categories: [],
    gaps: ['snils', 'license'],
    busy: [],
  },
];

const vehicleList: GarageVehicleListDto = {
  items: vehicles,
  total: 4,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};

const vehicleSummary: GarageVehiclesSummaryDto = {
  total: 4,
  free: 1,
  onRoute: 1,
  onSite: 1,
  unavailable: 1,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};

const driverList: GarageDriverListDto = {
  items: drivers,
  total: 2,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};

const driverSummary: GarageDriversSummaryDto = {
  total: 2,
  free: 1,
  assigned: 1,
  documentsIncomplete: 1,
  onDate: ON_DATE,
};

/** Смотрит администратор: у него открыты все три раздела, куда ведут номера из среза. */
const admin = authUser({ role: 'admin' });

function renderPage(options: { viewport?: Viewport } = {}) {
  const http = mockHttp({
    'GET /garage/vehicles': () => json(vehicleList),
    'GET /garage/vehicles/summary': () => json(vehicleSummary),
    'GET /garage/drivers': () => json(driverList),
    'GET /garage/drivers/summary': () => json(driverSummary),
    // Классификатор наполняет фильтр вкладки техники; отбор строк ведёт сервер.
    'GET /vehicle-classifications': () => json(emptyList()),
    // Колонка «ТО» спрашивает состояние пакетом на видимую страницу (Р16): к срезу дня она
    // отношения не имеет, но у администратора право на обслуживание есть, и без ответа колонка
    // молча осталась бы без данных. Проверяют её свои тесты (`garage-maintenance`).
    'GET /vehicle-maintenance/snapshot': ({ query }) =>
      json({ on: query.get('on') ?? '', items: [] }),
  });
  const rendered = renderWithUser(<GaragePage />, {
    user: admin,
    viewport: options.viewport,
    route: `/garage?tab=vehicles&date=${ON_DATE}`,
  });
  return { ...rendered, http };
}

describe('гараж: срез дня', () => {
  it('строка техники отвечает, чем машина занята и кто за рулём', async () => {
    renderPage();

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    // Состояние дня — одно на строку, и у недоступной машины рядом стоит причина.
    expect(screen.getByText('в рейсе')).toBeDefined();
    expect(screen.getByText('на объекте')).toBeDefined();
    expect(screen.getByText('свободна')).toBeDefined();
    expect(screen.getByText('недоступна')).toBeDefined();
    // Причина недоступности — статусом самой машины: тег говорит «недоступна», строка под ним —
    // чем именно (`vehicleStatusLabels`).
    expect(screen.getByText('обслуживание')).toBeDefined();

    // Занятость: рейс с его составом и выписанным бланком, заказ с объектом и сроком.
    expect(screen.getByText('Р-12')).toBeDefined();
    expect(screen.getByText('260604-646-00000004897')).toBeDefined();
    expect(screen.getByText('ТС-205')).toBeDefined();
    expect(screen.getByText(/20\.07 – 28\.07/u)).toBeDefined();
    // Смена дня заполнена, но объект её ещё не подписал — это и есть долг по приёмке.
    expect(screen.getByText(/смена заполнена/u)).toBeDefined();
    // Запрошенный досрочный отъезд виден до визы: срок в строке пока прежний.
    expect(screen.getByText('отъезд на визе')).toBeDefined();
    expect(screen.getByText('Петров Пётр Петрович')).toBeDefined();
  });

  it('номера ведут в модули, где эту работу ведут', async () => {
    renderPage();

    expect(await screen.findByText('Р-12')).toBeDefined();
    // Рейс — на вкладку маршрутов с открытой карточкой; заявка — в свой список; лист — в журнал.
    expect(screen.getByText('Р-12').getAttribute('href')).toBe(
      '/vehicle-requests?tab=routes&open=route-1',
    );
    expect(screen.getByText('ТС-101').getAttribute('href')).toBe(
      '/vehicle-requests?tab=requests&open=req-1',
    );
    expect(screen.getByText('260604-646-00000004897').getAttribute('href')).toBe(
      `/waybills?number=${encodeURIComponent('260604-646-00000004897')}`,
    );
  });

  it('сводка считает тот же день, что и таблица', async () => {
    const { http } = renderPage();

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(screen.getByText('Парк')).toBeDefined();
    expect(screen.getByText('Свободны:')).toBeDefined();

    // Обе ручки спрошены на выбранный день, а не на «сегодня» браузера.
    for (const path of ['/garage/vehicles', '/garage/vehicles/summary']) {
      const call = http.calls.find((c) => c.path === path);
      expect(call?.query.get('on'), path).toBe(ON_DATE);
    }
    // Сводка идёт без фильтра состояния: иначе она свелась бы к одной своей цифре.
    expect(http.calls.find((c) => c.path === '/garage/vehicles/summary')?.query.has('state')).toBe(
      false,
    );
  });

  it('день общий у обеих вкладок и живёт в адресе', async () => {
    const { http } = renderPage();
    expect(await screen.findByText('Е646СК799')).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Водители' }));

    // Водитель показан со своей занятостью — тем же днём, что смотрели на соседней вкладке.
    expect(await screen.findByText('Сидоров Сидор Сидорович')).toBeDefined();
    await waitFor(() =>
      expect(http.calls.find((c) => c.path === '/garage/drivers')?.query.get('on')).toBe(ON_DATE),
    );

    // Перебор дня стрелкой уводит обе вкладки на соседние сутки.
    fireEvent.click(screen.getByLabelText('Следующий день'));
    await waitFor(() => {
      const last = [...http.calls].reverse().find((c) => c.path === '/garage/drivers');
      expect(last?.query.get('on')).toBe('2026-07-25');
    });
  });

  it('водитель показан с документами и своей занятостью, а свободный — без неё', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Водители' }));

    expect(await screen.findByText('Петров Пётр Петрович')).toBeDefined();
    expect(screen.getByText('B, C')).toBeDefined();
    expect(screen.getByText(/00 00 000100/u)).toBeDefined();
    expect(screen.getByText('назначен')).toBeDefined();
    // Рейс назван машиной: колонки техники на этой вкладке нет. Совпадений несколько — соседняя
    // вкладка остаётся смонтированной со своим списком, и это её строка, а не вторая наша.
    expect(screen.getAllByText('Е646СК799').length).toBeGreaterThan(0);

    // Пробелы комплекта помечают строку, но состояние остаётся «свободен» (ADR 0064).
    expect(screen.getByText('свободен')).toBeDefined();
    expect(screen.getByText('документы: 2')).toBeDefined();
  });

  it('раздел ничего не ведёт: действий в строках нет', async () => {
    renderPage();

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Изменить статус' })).toBeNull();
    expect(screen.queryByLabelText('Открыть карточку')).toBeNull();
    expect(screen.queryByRole('button', { name: /Новый маршрут/u })).toBeNull();
  });

  it('на телефоне тот же срез читается карточками', async () => {
    renderPage({ viewport: MOBILE_VIEWPORT });

    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(document.querySelector('.ant-table')).toBeNull();
    expect(document.querySelectorAll('.list-card')).toHaveLength(4);
    // Пустой день говорит об этом словами: карточке нечего показать, кроме состояния.
    expect(screen.getAllByText('на этот день ничего не назначено').length).toBeGreaterThan(0);
  });
});
