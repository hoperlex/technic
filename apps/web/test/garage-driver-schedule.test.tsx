import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import {
  type DriverReportDto,
  type GarageDriverDto,
  type GarageDriverListDto,
  type GarageDriverScheduleDto,
  type GarageDriverShiftDto,
  type GarageDriversSummaryDto,
  monthRange,
  type ReadingIntakeDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list as listOf } from './factories/common';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { GaragePage } from '../src/pages/garage';

/**
 * Garage → «Водители» → «График»: one driver's month of shifts (owner's decisions of 28.10.2026).
 *
 * What the window decides is nothing: statuses, the month and its numbers come from the server.
 * So the tests ask the doors — the row link and the phone card open the same window by the same
 * address, the arrows send the month to the server and keep it in the address, a shift row opens
 * the person's day in the intake registry's own report window, and that door exists only for a
 * viewer of readings and only for a day that has come and stands on paper.
 */

const SCHEDULE = 'GET /garage/drivers/:personId/schedule';
const REPORT = 'GET /vehicle-readings/reports/:id';
const INTAKE = 'GET /vehicle-readings/intake';
const ON_DATE = '2026-07-24';
const MONTH = '2026-07';

const DRIVER: GarageDriverDto = {
  personId: 'p1',
  state: 'free',
  fullName: 'Петров Пётр Петрович',
  personnelNo: 'Т-100',
  phone: '',
  credentialTypeCode: 'driver_license',
  licenseNumber: '',
  licenseExpiresOn: null,
  licenseDefect: null,
  categories: ['C'],
  gaps: [],
  busy: [],
};

const DRIVER_LIST: GarageDriverListDto = {
  items: [DRIVER],
  total: 1,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};

const DRIVER_SUMMARY: GarageDriversSummaryDto = {
  total: 1,
  free: 1,
  assigned: 0,
  documentsIncomplete: 0,
  onDate: ON_DATE,
};

function shift(over: Partial<GarageDriverShiftDto> & Pick<GarageDriverShiftDto, 'key' | 'date'>) {
  const item: GarageDriverShiftDto = {
    source: 'route',
    routeId: null,
    routeNumber: null,
    waybill: null,
    request: null,
    vehicleId: 'v1',
    vehicleLabel: 'В010ОР799',
    readingStatus: 'not_submitted',
    reportId: null,
    noDataReason: null,
    ...over,
  };
  return item;
}

const SHIFTS: GarageDriverShiftDto[] = [
  shift({
    key: 'route:route-1',
    date: '2026-07-20',
    routeId: 'route-1',
    routeNumber: 'Р-12',
    waybill: { id: 'w1', formCode: '4p', number: 'АА000101' },
    readingStatus: 'accepted',
    reportId: 'r-1',
  }),
  shift({
    key: 'esm2:w2:2026-07-21',
    date: '2026-07-21',
    source: 'esm2',
    waybill: { id: 'w2', formCode: 'esm2', number: 'ЭС000007' },
    vehicleLabel: 'Кран КС-1',
    readingStatus: 'no_data',
    reportId: 'r-2',
    noDataReason: 'счётчик разбит',
  }),
  shift({
    key: 'route:route-3',
    date: '2026-07-22',
    routeId: 'route-3',
    routeNumber: 'Р-14',
    waybill: { id: 'w3', formCode: '4p', number: 'АА000102' },
  }),
  shift({
    key: 'no_paper:request:q1:2026-07-23',
    date: '2026-07-23',
    source: 'no_paper',
    request: { id: 'q1', displayNumber: 'ТС-40' },
    readingStatus: 'not_expected',
  }),
  shift({
    key: 'route:route-4',
    date: '2026-07-26',
    routeId: 'route-4',
    routeNumber: 'Р-15',
    waybill: { id: 'w4', formCode: '4p', number: 'АА000103' },
    readingStatus: 'upcoming',
  }),
];

/** The server's answer: the month asked for, or July — the "current" month of this scene. */
function scheduleOf(month: string | null): GarageDriverScheduleDto {
  const answered = month ?? MONTH;
  const own = answered === MONTH;
  return {
    personId: DRIVER.personId,
    fullName: DRIVER.fullName,
    month: answered,
    ...monthRange(answered),
    today: ON_DATE,
    shifts: own ? SHIFTS : [],
    summary: own
      ? { expected: 4, submitted: 2, missing: 1 }
      : { expected: 0, submitted: 0, missing: 0 },
  };
}

const REPORT_DTO: DriverReportDto = {
  id: 'r-1',
  personId: 'p1',
  personName: 'Петров П. П.',
  reportDate: '2026-07-20',
  state: 'accepted',
  draftFormat: 'v3',
  contentVersion: 2,
  version: 3,
  acceptedContentVersion: 2,
  acceptedAt: '2026-07-21T09:00:00.000Z',
  acceptedByName: 'Диспетчер Д. Д.',
  items: [],
  discrepancies: [],
  canAccept: false,
  blockers: ['День уже принят'],
};

function intakeOf(from: string, to: string): ReadingIntakeDto {
  return { items: [], total: 0, page: 1, pageSize: 50, from, to, today: ON_DATE, reports: [] };
}

function renderPage(
  options: { user?: ReturnType<typeof authUser>; viewport?: Viewport; route?: string } = {},
): HttpMock {
  const http = mockHttp({
    'GET /garage/drivers': () => json(DRIVER_LIST),
    'GET /garage/drivers/summary': () => json(DRIVER_SUMMARY),
    'GET /objects': () => json(listOf([])),
    [SCHEDULE]: ({ query }) => json(scheduleOf(query.get('month'))),
    [INTAKE]: ({ query }) => json(intakeOf(query.get('from') ?? '', query.get('to') ?? '')),
    'GET /vehicle-readings/stats': ({ query }) =>
      json({ items: [], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    [REPORT]: () => json(REPORT_DTO),
  });
  renderWithUser(
    <>
      <GaragePage />
      <AddressProbe />
    </>,
    {
      user: options.user ?? authUser({ role: 'dispatcher' }),
      viewport: options.viewport,
      route: options.route ?? `/garage?tab=drivers&date=${ON_DATE}`,
    },
  );
  return http;
}

function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>Шаг назад</button>
    </>
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';
const TITLE = `График — ${DRIVER.fullName}`;

/** The row of the drivers table, found inside its own table rather than the whole document. */
function driverRow(): Promise<HTMLElement> {
  return waitFor(() => {
    const table = screen
      .getByRole('columnheader', { name: 'Рейс/путевой лист' })
      .closest('.ant-table') as HTMLElement;
    return within(table).getByText(DRIVER.fullName).closest('tr') as HTMLElement;
  });
}

/** The open window: the schedule's dialog, not the page behind it. */
async function scheduleWindow(): Promise<HTMLElement> {
  const title = await screen.findByText(TITLE);
  return title.closest('.ant-modal, .ant-drawer') as HTMLElement;
}

describe('гараж: график водителя', () => {
  it('ссылка «График» в строке открывает месяц, названный сервером', async () => {
    const http = renderPage();

    const link = within(await driverRow()).getByText('График');
    expect(link.getAttribute('href')).toBe(`/garage?tab=drivers&date=${ON_DATE}&schedule=p1`);
    fireEvent.click(link);

    const dialog = await scheduleWindow();
    await waitFor(() => expect(http.countOf(SCHEDULE)).toBe(1));
    // No month in the first request: the current month is Moscow's, the server's to name.
    expect(http.lastCall(SCHEDULE)!.path).toBe('/garage/drivers/p1/schedule');
    expect(http.lastCall(SCHEDULE)!.query.get('month')).toBeNull();
    expect(address()).not.toContain('scheduleMonth');

    expect(await within(dialog).findByText('июль 2026')).toBeDefined();
    expect(within(dialog).getByText('Ожидается:').parentElement!.textContent).toBe('Ожидается: 4');
    expect(within(dialog).getByText('Не передано:').parentElement!.textContent).toBe(
      'Не передано: 1',
    );

    // Each paper reads its own way; a day without paper names its order.
    expect(within(dialog).getByText('Р-12')).toBeDefined();
    expect(within(dialog).getByText('4-П № АА000101')).toBeDefined();
    expect(within(dialog).getByText('ЭСМ-2 № ЭС000007')).toBeDefined();
    expect(within(dialog).getByText('без листа')).toBeDefined();
    expect(within(dialog).getByText('ТС-40')).toBeDefined();
    // Statuses are the server's words; the reason of «нет данных» stands under it.
    for (const label of ['принято', 'нет данных', 'не передано', 'показаний не ждут']) {
      expect(within(dialog).getByText(label)).toBeDefined();
    }
    expect(within(dialog).getByText('день не наступил')).toBeDefined();
    expect(within(dialog).getByText('счётчик разбит')).toBeDefined();
  });

  it('стрелки листают месяцы: месяц уходит в запрос и живёт в адресе', async () => {
    const http = renderPage();
    fireEvent.click(within(await driverRow()).getByText('График'));
    const dialog = await scheduleWindow();
    await within(dialog).findByText('июль 2026');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Предыдущий месяц' }));
    await waitFor(() => expect(http.lastCall(SCHEDULE)!.query.get('month')).toBe('2026-06'));
    expect(await within(dialog).findByText('июнь 2026')).toBeDefined();
    expect(address()).toContain('scheduleMonth=2026-06');
    expect(within(dialog).getByText('За этот месяц смен нет')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Следующий месяц' }));
    await within(dialog).findByText('июль 2026');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Следующий месяц' }));
    await waitFor(() => expect(http.lastCall(SCHEDULE)!.query.get('month')).toBe('2026-08'));
    expect(await within(dialog).findByText('август 2026')).toBeDefined();
    expect(address()).toContain('scheduleMonth=2026-08');
  });

  it('строка смены открывает день в приёме показаний, тем же окном отчёта', async () => {
    const http = renderPage();
    fireEvent.click(within(await driverRow()).getByText('График'));
    const dialog = await scheduleWindow();
    await within(dialog).findByText('Р-12');

    // Only days on paper that have come: the day ahead and the day without paper have no door.
    const links = within(dialog).getAllByText('Отчёт дня');
    expect(links).toHaveLength(3);
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      `/garage?tab=readings&sub=intake&date=${ON_DATE}&from=2026-07-20&to=2026-07-20&report=r-1`,
      `/garage?tab=readings&sub=intake&date=${ON_DATE}&from=2026-07-21&to=2026-07-21&report=r-2`,
      // A day nobody opened: the registry of that day, where its row opens the day.
      `/garage?tab=readings&sub=intake&date=${ON_DATE}&from=2026-07-22&to=2026-07-22`,
    ]);

    fireEvent.click(links[0]!);

    expect(await screen.findByText('Отчёт — Петров П. П., 20.07.2026')).toBeDefined();
    await waitFor(() => expect(http.countOf(REPORT)).toBe(1));
    expect(http.lastCall(REPORT)!.path).toBe('/vehicle-readings/reports/r-1');
    expect(http.lastCall(INTAKE)!.query.get('from')).toBe('2026-07-20');
    // The schedule stays behind on its own tab and does not hang over the registry.
    expect(screen.queryByText(TITLE)).toBeNull();

    // Back returns to the drivers tab with the window open on the same person.
    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
    expect(await screen.findByText(TITLE)).toBeDefined();
    expect(address()).toContain('schedule=p1');
  });

  it('без права на показания окно открывается, а двери в приём нет', async () => {
    renderPage({ user: authUser({ role: 'mechanic' }) });
    fireEvent.click(within(await driverRow()).getByText('График'));
    const dialog = await scheduleWindow();
    await within(dialog).findByText('Р-12');
    expect(within(dialog).queryByText('Отчёт дня')).toBeNull();
  });

  it('«назад» закрывает окно, а не уводит со среза', async () => {
    renderPage();
    fireEvent.click(within(await driverRow()).getByText('График'));
    await scheduleWindow();

    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    expect(address()).not.toContain('schedule=');
    expect(address()).toContain(`date=${ON_DATE}`);
  });

  it('присланный адрес открывает окно сам, и месяц из него уходит на сервер как есть', async () => {
    const http = renderPage({
      route: `/garage?tab=drivers&date=${ON_DATE}&schedule=p1&scheduleMonth=2026-06`,
    });
    expect(await screen.findByText(TITLE)).toBeDefined();
    await waitFor(() => expect(http.lastCall(SCHEDULE)?.query.get('month')).toBe('2026-06'));
  });

  it('на телефоне карточка водителя открывает то же окно пунктом «График»', async () => {
    renderPage({ viewport: MOBILE_VIEWPORT });

    expect(await screen.findByText(DRIVER.fullName)).toBeDefined();
    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    fireEvent.click(await screen.findByText('График'));

    expect(await screen.findByText(TITLE)).toBeDefined();
    expect(address()).toContain('schedule=p1');
    // The phone lays the month out as blocks, one per shift.
    expect(await screen.findAllByTestId('schedule-shift')).toHaveLength(SHIFTS.length);
  });
});
