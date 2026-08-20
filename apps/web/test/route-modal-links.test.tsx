import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { useLocation } from 'react-router';
import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  Role,
  VehicleRouteRequestDto,
  WaybillDto,
} from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { EntityLink } from '../src/shared/ui';
import { RouteRequestRow } from '../src/pages/vehicle/RouteRequestRow';
import { WaybillsPage } from '../src/pages/WaybillsPage';
import { GarageVehiclesTab } from '../src/pages/garage/GarageVehiclesTab';

/**
 * Номер чужой записи, который открывает окно и никуда не уводит (ADR 0120, план
 * `docs/vehicle-routes-modal-plan.md` §3.5 и §5).
 *
 * Куда ведут адреса — дело `entity-cross-links`. Здесь проверяется вторая половина того же
 * решения: что происходит по нажатию. Номер остался настоящей ссылкой — его открывают соседней
 * вкладкой и шлют письмами, — но обычный клик по нему больше не уходит по адресу, а открывает
 * запись окном поверх той страницы, где о ней спросили. Обе половины ломаются молча:
 *
 * — забудь `preventDefault` — и окно откроется, но страница под ним успеет смениться, унеся
 *   фильтры, ради которых её и открыли;
 * — перехвати клик с модификатором — и Ctrl перестанет открывать соседнюю вкладку, а Shift
 *   окно браузера: ссылка, ставшая кнопкой, снаружи выглядит прежней;
 * — забудь про право — и окно откроется там, где номер обязан оставаться текстом. Это уже не
 *   удобство, а дыра: показали бы то, чего роли не положено, и без адреса, по которому это
 *   заметно.
 *
 * Последнее проверяется на живых экранах механика (§3.5): у него есть и журнал листов, и гараж
 * (`waybills.read`, `garage.read`), а прав на заявки и на ход заявок нет вовсе
 * (`packages/contracts/src/permissions.ts` — `mechanic`). Статус-независимый адрес окна
 * (`?request=…`) снёс бы этот барьер, не будь обёрток `vehicleRequestViewLink` и
 * `vehicleRouteLink`: талоны журнала и заявки занятости стали бы для механика ссылками,
 * кончающимися сообщением «Заявка не найдена или недоступна».
 */

/** Адрес страницы под ссылкой: ушли по нему или остались там, где стояли. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="path">{`${location.pathname}${location.search}`}</div>;
}

/** Ссылка по видимому номеру. `null` — номер показан текстом, и это отдельное состояние. */
const linkFor = (text: string): HTMLAnchorElement | null =>
  [...document.querySelectorAll('a')].find((a) => a.textContent === text) ?? null;

describe('номер записи ссылкой, открывающей окно', () => {
  const ROUTE_HREF = '/vehicle-requests?route=route-1';

  it('обычным кликом открывает окно и оставляет страницу на месте', () => {
    const onActivate = vi.fn();
    renderWithUser(
      <>
        <LocationProbe />
        <EntityLink to={ROUTE_HREF} title="Открыть маршрут" onActivate={onActivate}>
          Р-12
        </EntityLink>
      </>,
      // Страница с отбором в адресе: ровно её и жалко потерять ради вопроса «что там за рейс».
      { route: '/waybills?number=260604-646-00000004897' },
    );

    const link = screen.getByText('Р-12');
    // Адрес настоящий и при перехваченном клике: им ссылку открывают соседней вкладкой браузера
    // и шлют письмами, а ссылка, ставшая кнопкой, обоих способов лишается.
    expect(link.getAttribute('href')).toBe(ROUTE_HREF);

    // `fireEvent` отвечает `false`, когда событие погасили: это и означает «переход не
    // состоялся». Без `preventDefault` окно открылось бы поверх уже другой страницы.
    expect(fireEvent.click(link)).toBe(false);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('path').textContent).toBe('/waybills?number=260604-646-00000004897');
  });

  it('с Ctrl, Meta и Shift не открывает окна и оставляет переход браузеру', () => {
    const onActivate = vi.fn();
    renderWithUser(
      <EntityLink to={ROUTE_HREF} title="Открыть маршрут" onActivate={onActivate}>
        Р-12
      </EntityLink>,
    );

    const link = screen.getByText('Р-12');
    /*
     * Три способа браузера открыть адрес: Ctrl — соседней вкладкой, Meta — тем же на макбуке,
     * Shift — отдельным окном. Все три к ссылке и обращены, и подменять их своим окном значило бы
     * ломать ссылку: списком рейсов пользуются, держа рядом два-три открытых.
     *
     * Событие поэтому не гасится вовсе — умолчание остаётся браузеру, и `onActivate` не зовётся.
     */
    for (const [name, modifier] of [
      ['Ctrl', { ctrlKey: true }],
      ['Meta', { metaKey: true }],
      ['Shift', { shiftKey: true }],
    ] as const) {
      expect(fireEvent.click(link, modifier), name).toBe(true);
      expect(onActivate, name).not.toHaveBeenCalled();
    }
  });

  it('без права остаётся прежним текстом: ни ссылки, ни окна', () => {
    const onActivate = vi.fn();
    // `null` возвращают обёртки `utils/links`, когда роли цель не положена. Право спрашивается
    // один раз, при вычислении адреса, и второй двери мимо него у номера нет.
    renderWithUser(
      <EntityLink to={null} title="Открыть маршрут" onActivate={onActivate}>
        Р-12
      </EntityLink>,
    );

    const number = screen.getByText('Р-12');
    expect(number.tagName).not.toBe('A');
    expect(document.querySelector('a')).toBeNull();

    fireEvent.click(number);
    expect(onActivate).not.toHaveBeenCalled();
  });
});

const ROUTE_REQUEST: VehicleRouteRequestDto = {
  requestId: 'req-1',
  displayNumber: 'ТС-501',
  position: 1,
  status: 'confirmed',
  customerName: 'Объект А',
  loadingLocation: 'Карьер',
  unloadingLocation: 'Площадка 1',
  scheduledAt: '2026-08-18T06:00:00.000Z',
  scheduledTimeUnspecified: false,
  cargoLabel: '12 м³',
};

describe('номер заявки в составе рейса', () => {
  it('открывает читалку заявки поверх рейса, а не уводит в список заявок', () => {
    const openRequest = vi.fn();
    renderWithUser(
      <>
        <LocationProbe />
        <RouteRequestRow
          item={ROUTE_REQUEST}
          frozen={false}
          busy={false}
          onDetach={vi.fn()}
          onTransfer={null}
        />
      </>,
      { routeModal: { openRequest }, route: '/vehicle-requests?route=route-1' },
    );

    /*
     * Исходная просьба заказчика: до реформы номер в составе был обычным текстом — из рейса в
     * заявку не попасть вовсе, её искали руками в списке. Теперь она открывается окном поверх
     * рейса, который как раз собирают, и рейс при этом остаётся в адресе: уход на вкладку заявок
     * стоил бы разбора собранного.
     */
    const number = screen.getByText('ТС-501').closest('a');
    expect(number?.getAttribute('href')).toBe('/vehicle-requests?request=req-1');

    fireEvent.click(number!);
    expect(openRequest).toHaveBeenCalledWith('req-1');
    expect(screen.getByTestId('path').textContent).toBe('/vehicle-requests?route=route-1');
  });
});

const WAYBILL: WaybillDto = {
  id: 'w-1',
  number: '260604-646-00000004897',
  formCode: '4p',
  status: 'issued',
  issuedForDate: '2026-08-18',
  periodFrom: null,
  periodTo: null,
  organizationName: 'ООО «СУ-10»',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-1',
  driverName: 'Иванов Иван Иванович',
  withTrailer: false,
  trailerLabel: '',
  issuedByName: 'Диспетчер',
  issuedAt: '2026-08-18T06:00:00.000Z',
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: '',
  printedAt: null,
  exportedAt: null,
  isCorrection: false,
  correctionReason: '',
  correctsNumber: null,
  correctedByNumber: null,
  routeId: 'route-1',
  routeNumber: 'Р-12',
  requests: [
    {
      requestId: 'req-1',
      displayNumber: 'ТС-501',
      slot: 1,
      objectName: 'Объект А',
      status: 'confirmed',
    },
  ],
  files: [],
};

const ON_DATE = '2026-08-18';

const GARAGE_VEHICLE: GarageVehicleDto = {
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
  busy: [
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
      waybill: { waybillId: 'w-1', number: '260604-646-00000004897', status: 'issued' },
    },
  ],
};

const GARAGE_ROUTES: RouteMap = {
  'GET /garage/vehicles': () =>
    json({
      items: [GARAGE_VEHICLE],
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
  'GET /vehicle-classifications': () => json([]),
  // Справочник площадок наполняет фильтр отбора по объекту — своих строк среза он не даёт.
  'GET /objects': () => json(emptyList()),
  // Колонка «ТО» спрашивает состояние пакетом на видимую страницу: право на обслуживание у
  // механика есть, и без ответа она молча осталась бы без данных.
  'GET /vehicle-maintenance/snapshot': ({ query }) =>
    json({ on: query.get('on') ?? '', items: [] }),
};

/**
 * Обе роли службы главного механика: набор прав у них разный (главный ещё списывает бланки и
 * ведёт водителей), а граница здесь одна и та же — заявок нет ни у того, ни у другого.
 */
const MECHANICS: Role[] = ['mechanic', 'chief_mechanic'];

describe('барьер механика: номера заявок и рейса', () => {
  it('в журнале путевых листов остаются текстом, и клик по ним ничего не открывает', async () => {
    for (const role of MECHANICS) {
      mockHttp({
        'GET /waybills': () => json(list([WAYBILL])),
        // Справочники панели фильтров: водителей механик читает, техника ему тоже положена.
        'GET /vehicles': () => json(emptyList()),
        'GET /drivers': () => json(emptyList()),
      });
      const { routeModal, unmount } = renderWithUser(<WaybillsPage />, {
        user: authUser({ role }),
      });

      // Журнал механику положен целиком — вопрос только в номерах чужих записей в нём.
      expect(await screen.findByText('260604-646-00000004897'), role).toBeDefined();

      // Рейс: `vehicleRouteLink` вернул `null` — `vehicleRequests.status` у роли нет.
      expect(linkFor('Р-12'), role).toBeNull();
      expect(screen.getByText('Р-12'), role).toBeDefined();
      // Талон заказчика: `vehicleRequestViewLink` вернул `null` — нет `vehicleRequests.read`.
      // Номер стоит в строке «1. ТС-501 — Объект А», поэтому опознаётся вхождением.
      expect(linkFor('ТС-501'), role).toBeNull();

      fireEvent.click(screen.getByText('Р-12'));
      fireEvent.click(screen.getByText(/ТС-501/u));
      expect(routeModal.openRoute, role).not.toHaveBeenCalled();
      expect(routeModal.openRequest, role).not.toHaveBeenCalled();

      unmount();
    }
  });

  it('в срезе гаража — тоже текст, а номер бланка ссылкой остаётся', async () => {
    for (const role of MECHANICS) {
      mockHttp(GARAGE_ROUTES);
      const { routeModal, unmount } = renderWithUser(
        <GarageVehiclesTab date={ON_DATE} dayControls={null} />,
        { user: authUser({ role }) },
      );

      expect(await screen.findByText('Е646СК799'), role).toBeDefined();

      expect(linkFor('Р-12'), role).toBeNull();
      expect(screen.getByText('Р-12'), role).toBeDefined();
      expect(linkFor('ТС-501'), role).toBeNull();
      /*
       * Контроль на месте: журнал листов механику положен, и номер бланка в той же строке
       * остался настоящей ссылкой. Без него тест проходил бы и на срезе, не отрисовавшем ссылок
       * вовсе, — то есть проверял бы поломку вместо права.
       */
      expect(linkFor('260604-646-00000004897'), role).not.toBeNull();

      fireEvent.click(screen.getByText('Р-12'));
      fireEvent.click(screen.getByText(/ТС-501/u));
      expect(routeModal.openRoute, role).not.toHaveBeenCalled();
      expect(routeModal.openRequest, role).not.toHaveBeenCalled();

      unmount();
    }
  });
});
