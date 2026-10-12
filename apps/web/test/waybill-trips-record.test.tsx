import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  RoutePointAction,
  VehicleRouteDto,
  VehicleRoutePointDto,
  VehicleRouteRequestDto,
  WaybillDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { waybill } from './factories/waybill';
import { WaybillsPage } from '../src/pages/waybills';
import { VehicleRouteModal } from '@widgets/vehicle-route-windows';

/**
 * Printed trips and the issue check in the portal (ADR 0108 items 20–21, roadmap item F4), and the
 * route card's one count of the form's capacity.
 *
 * Until now `waybill_trips` and `issue_warnings` were written by every issue and read by nobody.
 * The journal marks a sheet issued under confirmed warnings and names the rows a multi-trip request
 * took; the sheet's view window names every printed row by trip and all three states of the check;
 * the route card answers «what was the live sheet issued under» on demand. The texts are the stored
 * ones — the record is what the dispatcher agreed to, not what the portal would say today.
 *
 * The capacity case pins the other half of F4: `canIssueWaybill` no longer counts requests, so a
 * route with more requests than form rows is refused by the task-row count alone, in its words.
 */

const NUMBER = '260604-646-00000007';

const MULTI_TRIP: WaybillDto = waybill({
  id: 'w-7',
  number: NUMBER,
  requests: [
    {
      requestId: 'r-40',
      displayNumber: 'ТС-40',
      slot: 1,
      objectName: 'ЖК Северный',
      status: 'confirmed',
    },
    { requestId: 'r-41', displayNumber: 'ТС-41', slot: 3, objectName: 'ПТО', status: 'confirmed' },
  ],
  trips: [
    { tripId: 't-1', requestId: 'r-40', displayNumber: 'ТС-40/1', slot: 1, deleted: false },
    { tripId: 't-2', requestId: 'r-40', displayNumber: 'ТС-40/2', slot: 2, deleted: true },
    { tripId: 't-3', requestId: 'r-41', displayNumber: 'ТС-41/1', slot: 3, deleted: false },
  ],
  issueWarnings: {
    status: 'acknowledged',
    warnings: [
      {
        code: 'driver_documents',
        message: 'У водителя Иванов И. И. не внесён СНИЛС — графа бланка останется пустой',
        entities: ['Иванов И. И.'],
      },
    ],
  },
});

const OLD_SHEET: WaybillDto = waybill({
  id: 'w-8',
  number: '260604-646-00000008',
  issueWarnings: { status: 'not_checked', warnings: [] },
});

const DIRECTORIES = {
  'GET /vehicles': () => json(list([])),
  'GET /drivers': () => json(list([])),
  'GET /objects': () => json(list([])),
};

function renderJournal(items: WaybillDto[]) {
  const http = mockHttp({ 'GET /waybills': () => json(list(items)), ...DIRECTORIES });
  renderWithUser(<WaybillsPage />);
  return http;
}

const rowOf = (number: string) => screen.getByText(number).closest('tr')!;

describe('журнал листов: ездки по строкам и проверка выписки', () => {
  it('строка помечает лист с подтверждёнными предупреждениями и называет строки заявки с ездками', async () => {
    renderJournal([MULTI_TRIP, OLD_SHEET]);
    await waitFor(() => expect(screen.getByText(NUMBER)).toBeDefined());

    const row = rowOf(NUMBER);
    expect(within(row).getByText('с предупреждениями')).toBeDefined();
    // Two printed trips under one coupon: the rows are named next to it. A one-trip request is its
    // coupon's own row, and naming it again would say nothing.
    expect(within(row).getByText(/строки 1, 2/)).toBeDefined();
    expect(within(row).queryByText(/строки 3/)).toBeNull();

    // «Not checked» is the state of every sheet before the column: tagging it would drown the
    // rows that carry a decision.
    expect(within(rowOf('260604-646-00000008')).queryByText('с предупреждениями')).toBeNull();
  });

  it('номер открывает окно листа: строка задания каждой ездки и подтверждённое при выписке', async () => {
    renderJournal([MULTI_TRIP]);
    fireEvent.click(await screen.findByText(NUMBER));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`Путевой лист № ${NUMBER}`)).toBeDefined();
    expect(within(dialog).getByText('1. ТС-40/1')).toBeDefined();
    expect(within(dialog).getByText('3. ТС-41/1')).toBeDefined();
    // A trip removed after issue keeps its printed row, marked: the journal remembers the paper.
    const removed = within(dialog).getByText(/2\. ТС-40\/2/);
    expect(removed.textContent).toContain('удалена из заявки');

    expect(within(dialog).getByText('Выписан с подтверждёнными предупреждениями')).toBeDefined();
    expect(within(dialog).getByText(/не внесён СНИЛС/)).toBeDefined();
  });

  it('окно называет и «не проверялся», и лист без ездок — без пустого места', async () => {
    renderJournal([OLD_SHEET]);
    fireEvent.click(await screen.findByText('260604-646-00000008'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('При выписке не проверялся')).toBeDefined();
    expect(within(dialog).getByText(/Ездок в листе нет/)).toBeDefined();
  });

  /*
   * A bundle newer than the API — the window after `deploy-auto --previous`, a cached tab — gets
   * sheets without the two fields. The journal must still render, and the window must read the
   * missing check as the column default does, not crash or claim «clean».
   */
  it('ответ старого сервера без новых полей журнал не роняет и читается «не проверялся»', async () => {
    const legacy: Partial<WaybillDto> = waybill({ id: 'w-9', number: 'OLD-1' });
    delete legacy.trips;
    delete legacy.issueWarnings;
    renderJournal([legacy as WaybillDto]);
    fireEvent.click(await screen.findByText('OLD-1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('При выписке не проверялся')).toBeDefined();
    expect(within(dialog).getByText(/Ездок в листе нет/)).toBeDefined();
  });
});

// ── The route card ──

const requestRow = (index: number): VehicleRouteRequestDto => ({
  requestId: `r-${index}`,
  displayNumber: `ТС-${500 + index}`,
  position: index,
  status: 'confirmed',
  customerName: 'Объект А',
  loadingLocation: 'Карьер',
  unloadingLocation: `Площадка ${index}`,
  scheduledAt: '2026-08-03T06:00:00.000Z',
  scheduledTimeUnspecified: false,
  cargoLabel: '12 м³',
});

const action = (
  index: number,
  role: 'load' | 'unload',
  pairPosition: number,
): RoutePointAction => ({
  position: 1,
  kind: 'freight',
  ref: { kind: 'freight', requestId: `r-${index}`, tripId: `t-${index}` },
  role,
  cargoLabel: '12 м³',
  pairPosition,
  displayNumber: `ТС-${500 + index}/1`,
  requestNum: 500 + index,
  tripNum: 1,
  customerName: 'Объект А',
  contactName: 'Иванов И.И.',
  contactPhone: '9160000001',
  addressMismatch: false,
});

/** Each request its own pair of stops, in order: nothing blocks the issue but what is tested. */
function pointsFor(count: number): VehicleRoutePointDto[] {
  return Array.from({ length: count }, (_, i) => i + 1).flatMap((index) => {
    const load = index * 2 - 1;
    const unload = index * 2;
    return [
      {
        id: `pt-${load}`,
        position: load,
        location: 'Карьер',
        address: null,
        arrivalTime: '',
        comment: '',
        actions: [action(index, 'load', unload)],
        contacts: [{ name: 'Иванов И.И.', phone: '9160000001' }],
      },
      {
        id: `pt-${unload}`,
        position: unload,
        location: `Площадка ${index}`,
        address: null,
        arrivalTime: '',
        comment: '',
        actions: [action(index, 'unload', load)],
        contacts: [{ name: 'Иванов И.И.', phone: '9160000001' }],
      },
    ];
  });
}

function route(requests: number, overrides: Partial<VehicleRouteDto> = {}): VehicleRouteDto {
  return {
    id: 'route-1',
    displayNumber: 'Р-12',
    purpose: 'freight',
    formCode: '4p',
    sourceRequest: null,
    moveFrom: '',
    moveTo: '',
    routeDate: '2099-08-03',
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
    requests: Array.from({ length: requests }, (_, i) => requestRow(i + 1)),
    points: pointsFor(requests),
    waybill: null,
    createdByName: 'Диспетчер',
    createdAt: '2026-08-01T09:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

function renderCard(
  dto: VehicleRouteDto,
  routes: Record<string, () => ReturnType<typeof json>> = {},
) {
  const http = mockHttp({
    'GET /vehicle-routes/:id': () => json(dto),
    'GET /vehicle-requests': () => json(list([])),
    ...routes,
  });
  renderWithUser(<VehicleRouteModal routeId="route-1" onClose={() => {}} onChanged={() => {}} />);
  return http;
}

describe('карточка рейса: проверка выписки и ёмкость одним счётом', () => {
  it('у выданного листа проверку читают по запросу — и только раскрыв блок', async () => {
    const issued = route(2, {
      waybill: { id: 'w-7', number: NUMBER, status: 'issued', issuedForDate: '2099-08-03' },
    });
    const http = renderCard(issued, { 'GET /waybills/:id': () => json(MULTI_TRIP) });

    const header = await screen.findByText(`Проверка при выписке листа ${NUMBER}`);
    // The card is opened many times a day for its composition: the sheet is not read until asked.
    expect(http.countOf('GET /waybills/:id')).toBe(0);

    fireEvent.click(header);
    expect(await screen.findByText(/не внесён СНИЛС/)).toBeDefined();
    expect(screen.getByText('Выписан с подтверждёнными предупреждениями')).toBeDefined();
    expect(http.lastCall('GET /waybills/:id')!.path).toBe('/waybills/w-7');
  });

  it('без выданного листа блока нет', async () => {
    renderCard(route(2));
    await screen.findByText('Заявки рейса (2)');
    expect(screen.queryByText(/Проверка при выписке листа/)).toBeNull();
  });

  /*
   * Eight requests on a seven-row form. The request count used to answer first — a warning above
   * the list and the button's tooltip in its own words; now the task-row count is the only one, so
   * the card names the overflow once, by rows, and the button is still disabled.
   */
  it('заявок больше, чем строк бланка: отказ называет строки задания и только их', async () => {
    renderCard(route(8));
    const button = await screen.findByRole('button', { name: 'Выписать лист' });

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    expect(button.getAttribute('title')).toContain('Строк задания 8, а в бланке 7');
    expect(screen.queryByText(/в маршруте заявок/)).toBeNull();
    expect(screen.getAllByText(/Строк задания 8, а в бланке 7/)).toHaveLength(1);
  });

  it('заявок столько, сколько строк, — выписка открыта', async () => {
    renderCard(route(7));
    const button = await screen.findByRole('button', { name: 'Выписать лист' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });
});
