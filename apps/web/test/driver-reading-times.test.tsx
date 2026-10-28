import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import type {
  DriverAssignmentDto,
  DriverAssignmentPoint,
  DriverReportDto,
  DriverReportFormat,
  ReportItemDto,
  ReportSubmitBody,
  VehicleReadingDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverReadingsPage } from '../src/pages/driver/DriverReadingsPage';
import { ReadingBlock } from '../src/pages/driver/DriverReadingBlock';
import { emptyItem } from '../src/pages/driver/readingsDraft';
import { stopsOf } from '../src/pages/driver/readingStops';

/**
 * Shift and stop times in the driver cabinet (ADR 0234; plan `docs/readings-shifts-merge-plan.md`
 * §7.4, owner decisions D5, D6, D8, D9, D11).
 *
 * Checked as the driver meets them: where the fields stand (variant A — inside the existing
 * groups, the route's stops above the counters), that a time is typed (ADR 0237 removed the
 * «сейчас» button), what the live per-request split says, and which submit the D11 rule stops
 * before it leaves the phone — the same contract rule the readings service applies, read by the
 * report's stored format. Since ADR 0237 a block the driver sends is a whole shift: both fuel
 * levels and a counter come with the times, so `fillNumbers` is part of every sending scenario.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const driver = authUser({
  id: 'user-driver',
  email: 'driver@example.test',
  role: 'driver',
  lastName: 'Водителев',
  firstName: 'Виктор',
  middleName: 'Иванович',
  fullName: 'Водителев Виктор Иванович',
});

const routeItem: ReportItemDto = {
  id: 'item-route',
  sourceKind: 'route',
  sourceId: 'route-1',
  sourceLabel: 'Рейс Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 6520 · В456ОР77',
  shiftOrder: 1,
  reading: null,
};

const esm2Item: ReportItemDto = {
  id: 'item-esm2',
  sourceKind: 'esm2',
  sourceId: 'wb-1',
  sourceLabel: 'ЭСМ-2 № 000318',
  vehicleId: 'v-2',
  vehicleLabel: 'JCB 3CX · А123ВС77',
  shiftOrder: 1,
  reading: null,
};

/** A relocation: a route without stops (D8) — it records no time. */
const moveItem: ReportItemDto = { ...routeItem, id: 'item-move', sourceId: 'route-move' };

/** Live route point ids: uuids, as the wire schema of a stop requires (`readingPointInputSchema`). */
const RP1 = '11111111-1111-4111-8111-111111111111';
const RP2 = '22222222-2222-4222-8222-222222222222';
const RP4 = '44444444-4444-4444-8444-444444444444';

/** The requests of the route as the server names them on the task: an id and its own number. */
const REQUESTS = {
  'ТС-40': { id: 'a0000000-0000-4000-8000-000000000040', displayNumber: 'ТС-40' },
  'ТС-41': { id: 'a0000000-0000-4000-8000-000000000041', displayNumber: 'ТС-41' },
} as const;

const action = (
  roleLabel: string,
  displayNumber: `${keyof typeof REQUESTS}/${number}`,
  cargoLabel: string,
) => ({
  role: roleLabel === 'Грузим' ? ('load' as const) : ('unload' as const),
  roleLabel,
  displayNumber,
  customerName: 'ООО «Заказчик»',
  cargoLabel,
  comment: '',
  request: REQUESTS[displayNumber.split('/')[0] as keyof typeof REQUESTS],
});

/**
 * The mock-up's route: a shared loading stop, then one unloading stop per request. The third point
 * has route position 4 — the task left out a point of a cancelled request — and must still be the
 * reading's stop 3: a reading numbers its stops 1..N without gaps.
 */
const routePoints: DriverAssignmentPoint[] = [
  {
    id: RP1,
    position: 1,
    location: 'Карьер «Северный»',
    arrivalTime: '07:30',
    actions: [action('Грузим', 'ТС-40/1', '18 м³'), action('Грузим', 'ТС-41/1', '12 м³')],
    contacts: [],
    comment: '',
  },
  {
    id: RP2,
    position: 2,
    location: 'ул. Строителей, 12',
    arrivalTime: '09:30',
    actions: [action('Выгружаем', 'ТС-40/1', '18 м³')],
    contacts: [],
    comment: '',
  },
  {
    id: RP4,
    position: 4,
    location: 'Промзона, склад 4',
    arrivalTime: '11:00',
    actions: [action('Выгружаем', 'ТС-41/1', '12 м³')],
    contacts: [],
    comment: '',
  },
];

function reportOf(
  items: ReportItemDto[],
  draftFormat: DriverReportFormat,
  overrides: Partial<DriverReportDto> = {},
): DriverReportDto {
  return {
    id: 'report-1',
    personId: 'p-1',
    personName: driver.fullName,
    reportDate: today,
    state: 'draft',
    draftFormat,
    contentVersion: 1,
    version: 3,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items,
    discrepancies: [],
    canAccept: false,
    blockers: [],
    ...overrides,
  };
}

function assignmentOf(items: ReportItemDto[]): DriverAssignmentDto {
  return {
    date: today,
    canSubmit: true,
    entries: items.map((item) => ({
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      sourceLabel: item.sourceLabel,
      purposeLabel: item.sourceKind === 'esm2' ? 'Работа на объекте' : 'Грузоперевозка',
      vehicleLabel: item.vehicleLabel,
      garageNumber: '',
      trailerLabel: '',
      itemId: item.id,
      shiftOrder: item.shiftOrder,
      points: item.sourceId === 'route-1' ? routePoints : [],
      moveFrom: '',
      moveTo: '',
      comment: '',
      previous: null,
    })),
  };
}

interface SentRequest {
  path: string;
  headers: Record<string, string>;
}

function renderCabinet(
  items: ReportItemDto[],
  draftFormat: DriverReportFormat = 'v3',
  overrides: Partial<DriverReportDto> = {},
  /** The task's rows; a submitted report may hold an item the task no longer has. */
  task: ReportItemDto[] = items,
) {
  const http = mockHttp({
    'GET /driver/assignment': () => json(assignmentOf(task)),
    'GET /driver/reports/:date': () => json(null),
    'POST /driver/reports/:date/open': () => json(reportOf(items, draftFormat, overrides)),
    'POST /driver/reports/:date/submit': () =>
      json(reportOf(items, draftFormat, { state: 'submitted', version: 4 })),
  });
  const sent: SentRequest[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      path: new URL(raw, window.location.origin).pathname,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    return inner(input, init);
  }) as typeof globalThis.fetch;
  const rendered = renderWithUser(
    <DriverLayout>
      <DriverReadingsPage />
    </DriverLayout>,
    { user: driver, route: '/driver' },
  );
  return { ...rendered, http, sent };
}

async function waitForBlocks(): Promise<void> {
  await waitFor(
    () => expect(document.querySelectorAll('[id^="reading-"]').length).toBeGreaterThan(0),
    { timeout: 3000 },
  );
}

function blockOf(itemId: string): HTMLElement {
  const element = document.getElementById(`reading-${itemId}`);
  if (!element) throw new Error(`Блока строки «${itemId}» нет на экране`);
  return element;
}

/** A field by its label: the wrapper `label` starts with it. */
function field(scope: HTMLElement, label: string): HTMLInputElement {
  const wrapper = [...scope.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = wrapper?.querySelector('input');
  if (!input) throw new Error(`Поля «${label}» нет`);
  return input;
}

const labelsIn = (scope: HTMLElement): string[] =>
  [...scope.querySelectorAll('label')].map((l) => l.querySelector('span')?.textContent ?? '');

/** A group of the block by its heading, as the driver finds it (Р7). */
function group(scope: HTMLElement, title: string): HTMLElement {
  const heading = [...scope.querySelectorAll('strong')].find((el) => el.textContent === title);
  const box = heading?.closest('div');
  if (!box) throw new Error(`Группы «${title}» нет в блоке`);
  return box as HTMLElement;
}

const stop = (position: number): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-stop="${position}"]`);
  if (!element) throw new Error(`Точки ${position} нет`);
  return element;
};

function type(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

async function submitSheet(): Promise<void> {
  const button = await screen.findByText('Передать');
  await waitFor(() => expect(button.closest('button')?.disabled).toBe(false));
  fireEvent.click(button);
}

function submitBody(http: ReturnType<typeof mockHttp>): ReportSubmitBody {
  return http.lastCall('POST /driver/reports/:date/submit')?.body as ReportSubmitBody;
}

/** Both fuel levels and a counter: the numbers of a whole shift (ADR 0237) the time tests share. */
function fillNumbers(block: HTMLElement, odometer = '18252'): void {
  type(field(group(block, 'Начало смены'), 'Топливо'), '120');
  type(field(group(block, 'Конец смены'), 'Топливо'), '90');
  type(field(block, 'Одометр'), odometer);
}

/** Times of the mock-up: 07:40 arrival, departures 08:30, 10:05, 11:50. */
function fillRoute(): void {
  type(field(stop(1), 'Прибытие'), '07:40');
  type(field(stop(1), 'Убытие'), '08:30');
  type(field(stop(2), 'Убытие'), '10:05');
  type(field(stop(3), 'Убытие'), '11:50');
}

describe('кабинет водителя: время смены и остановок', () => {
  beforeEach(() => localStorage.clear());

  it('ЭСМ-2: время начала открывает начало смены, окончания — конец, с длительностью', async () => {
    renderCabinet([esm2Item]);
    await waitForBlocks();
    const block = blockOf(esm2Item.id);

    // D9, variant A: the time stands in the group of the moment it is taken, first in it.
    expect(labelsIn(group(block, 'Начало смены'))[0]).toBe('Время начала');
    expect(labelsIn(group(block, 'Конец смены'))[0]).toBe('Время окончания');
    // An ESM-2 item has no stops: the route block is for routes only.
    expect(within(block).queryByText('Маршрут — время по факту')).toBeNull();

    type(field(block, 'Время начала'), '08:00');
    type(field(block, 'Время окончания'), '20:00');
    expect(await within(block).findByText('смена 12 ч')).toBeDefined();

    // An end earlier than the start is the next day — one reading of a pair (`shiftSpanMinutes`).
    type(field(block, 'Время окончания'), '06:00');
    expect(
      await within(block).findByText('смена 22 ч · ночная — конец раньше начала'),
    ).toBeDefined();
  });

  it('время набирается рукой: кнопки «сейчас» нет, «730» читается как 07:30', async () => {
    renderCabinet([esm2Item]);
    await waitForBlocks();
    const block = blockOf(esm2Item.id);

    // ADR 0237: the readings are sent when the shift ends, so the device's clock at that moment is
    // not the time of the event, and a tap on it wrote a wrong time more often than a right one.
    expect(within(block).queryByRole('button', { name: /сейчас/u })).toBeNull();

    const end = field(block, 'Время окончания');
    type(end, '730');
    fireEvent.blur(end);
    await waitFor(() => expect(field(block, 'Время окончания').value).toBe('07:30'));
  });

  it('рейс: точки по порядку с делами и планом, прибытие и убытие на первой, убытие на остальных', async () => {
    renderCabinet([routeItem]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    const route = group(block, 'Маршрут — время по факту');
    // Numbered 1..N among the shown stops: the route's own position 4 is the reading's stop 3.
    const stops = [...route.querySelectorAll<HTMLElement>('[data-stop]')];
    expect(stops.map((element) => element.dataset.stop)).toEqual(['1', '2', '3']);
    expect(within(stop(3)).getByText('3. Промзона, склад 4')).toBeDefined();
    expect(within(stop(1)).getByText('Грузим ТС-40/1 · 18 м³')).toBeDefined();
    expect(within(stop(1)).getByText('план 07:30')).toBeDefined();

    expect(labelsIn(stop(1))).toEqual(['Прибытие', 'Убытие']);
    expect(labelsIn(stop(2))).toEqual(['Убытие']);
    expect(labelsIn(stop(3))).toEqual(['Убытие']);
    expect(within(stop(1)).getByText('Прибытие на первую точку — начало смены')).toBeDefined();
    expect(within(stop(3)).getByText('Убытие с последней точки — конец смены')).toBeDefined();
    // Four time fields, and none has a «сейчас» (ADR 0237).
    expect(route.querySelectorAll('input')).toHaveLength(4);
    expect(within(route).queryAllByRole('button', { name: /сейчас/u })).toHaveLength(0);

    // The route block stands above the counters, and the scalar pair is not typed on a route.
    const order = [...block.querySelectorAll('strong')].map((el) => el.textContent);
    expect(order.indexOf('Маршрут — время по факту')).toBeLessThan(order.indexOf('Конец смены'));
    expect(within(block).queryByText('Время начала')).toBeNull();
  });

  it('время по заявкам считается вживую делением контракта, общая точка — поровну', async () => {
    renderCabinet([routeItem]);
    await waitForBlocks();
    const summary = within(blockOf(routeItem.id)).getByTestId('route-summary');

    expect(
      within(summary).getByText(
        'Посчитается, когда будут отмечены прибытие на первую точку и убытие со всех точек',
      ),
    ).toBeDefined();

    fillRoute();
    // Stop 1 (50 min) is split between ТС-40 and ТС-41; stops 2 and 3 belong to one each (D6).
    await waitFor(() => expect(within(summary).getByText('ТС-40')).toBeDefined());
    const line = (label: string) => within(summary).getByText(label).parentElement!.textContent;
    // A list of durations keeps the zero minutes, so every line has one shape.
    expect(line('ТС-40')).toBe('ТС-402 ч 0 мин');
    expect(line('ТС-41')).toBe('ТС-412 ч 10 мин');
    expect(within(summary).getByText('Смена 07:40–11:50')).toBeDefined();
    expect(within(summary).getByText('4 ч 10 мин')).toBeDefined();
    expect(
      within(summary).getByText('Общая точка 1 делится поровну: по 25 мин каждой заявке'),
    ).toBeDefined();
  });

  it('D11: вечерние показания без времени окончания не уходят — отказ под полем', async () => {
    const { http } = renderCabinet([esm2Item]);
    await waitForBlocks();
    const block = blockOf(esm2Item.id);

    fillNumbers(block);
    await submitSheet();

    expect(await within(block).findByText('Укажите время начала смены')).toBeDefined();
    expect(
      within(block).getByText('Переданы показания конца смены — укажите время её окончания'),
    ).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    type(field(block, 'Время начала'), '08:00');
    type(field(block, 'Время окончания'), '08:00');
    await submitSheet();
    expect(await within(block).findByText('Начало и конец смены совпадают')).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    type(field(block, 'Время окончания'), '20:00');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      kind: 'values',
      odometerKm: 18252,
      startedAt: '08:00',
      endedAt: '20:00',
    });
  });

  it('утро без вечера больше не уходит: все недостающие поля и время окончания — отказами сразу', async () => {
    const { http } = renderCabinet([esm2Item]);
    await waitForBlocks();
    const block = blockOf(esm2Item.id);

    // ADR 0237: the morning-only interim submit that ADR 0163 allowed is gone. The block is whole
    // or does not leave, and every refusal stands under its own field at once.
    type(field(group(block, 'Начало смены'), 'Топливо'), '62');
    await submitSheet();
    expect(await within(block).findByText('Укажите время начала смены')).toBeDefined();
    expect(
      within(block).getByText('Переданы показания конца смены — укажите время её окончания'),
    ).toBeDefined();
    expect(within(block).getByText('Укажите остаток топлива на конец смены')).toBeDefined();
    expect(within(block).getAllByText('Укажите одометр или моточасы')).toHaveLength(2);
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    type(field(group(block, 'Конец смены'), 'Топливо'), '40');
    type(field(block, 'Моточасы'), '310.5');
    type(field(block, 'Время начала'), '08:00');
    type(field(block, 'Время окончания'), '17:00');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      fuelStartLiters: 62,
      fuelEndLiters: 40,
      engineHours: 310.5,
      startedAt: '08:00',
      endedAt: '17:00',
    });
  });

  it('D11 на рейсе: прибытие на первую точку обязательно, с вечерними — каждое убытие', async () => {
    const { http } = renderCabinet([routeItem]);
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    fillNumbers(block, '231468');
    type(field(stop(2), 'Убытие'), '10:05');
    await submitSheet();

    expect(
      await within(stop(1)).findByText('Укажите время прибытия на первую точку'),
    ).toBeDefined();
    expect(
      within(stop(1)).getByText(
        'Переданы показания конца смены — укажите время отправления с точки 1',
      ),
    ).toBeDefined();
    expect(
      within(stop(3)).getByText(
        'Переданы показания конца смены — укажите время отправления с точки 3',
      ),
    ).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    fillRoute();
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    // The stops go back as the server will compare them: reading positions 1..N with the live
    // point ids, an arrival only at stop 1; the scalar pair is never typed on a route.
    const reading = submitBody(http).items[0]!.reading;
    expect(reading).not.toHaveProperty('startedAt');
    expect(reading).toMatchObject({
      points: [
        { position: 1, routePointId: RP1, arrivedAt: '07:40', departedAt: '08:30' },
        { position: 2, routePointId: RP2, arrivedAt: null, departedAt: '10:05' },
        { position: 3, routePointId: RP4, arrivedAt: null, departedAt: '11:50' },
      ],
    });
  });

  it('строка персонала без времени уходит как есть и день не держит; правка водителя — его слово', async () => {
    // Staff entered this vehicle's numbers in the garage without times (D5 allows it).
    const staffReading: VehicleReadingDto = {
      id: 'reading-staff',
      itemId: 'item-esm2-staff',
      kind: 'values',
      odometerKm: 2000,
      engineHours: 310.5,
      fuelStartLiters: null,
      fuelFilledLiters: null,
      fuelEndLiters: null,
      startedAt: null,
      endedAt: null,
      points: [],
      noDataReason: '',
      comment: '',
      source: 'staff',
      recordedAt: `${today}T09:00:00.000Z`,
      odometerAnomaly: null,
      engineHoursAnomaly: null,
      odometerDelta: null,
      engineHoursDelta: null,
      fileIds: [],
    };
    const staffItem: ReportItemDto = {
      ...esm2Item,
      id: 'item-esm2-staff',
      sourceId: 'wb-2',
      sourceLabel: 'ЭСМ-2 № 000319',
      vehicleId: 'v-3',
      vehicleLabel: 'Hitachi ZX200 · Е321КХ77',
      reading: staffReading,
    };
    const { http } = renderCabinet([staffItem, esm2Item], 'v3', { state: 'submitted' });
    await waitForBlocks();

    const own = blockOf(esm2Item.id);
    type(field(own, 'Время начала'), '08:00');
    fillNumbers(own);
    type(field(own, 'Время окончания'), '17:00');
    await submitSheet();

    // The staff line goes back as saved and does not ask the driver for times it never had.
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    const sentItems = submitBody(http).items;
    expect(sentItems.find((line) => line.itemId === staffItem.id)?.reading).toMatchObject({
      odometerKm: 2000,
      engineHours: 310.5,
      startedAt: null,
      endedAt: null,
    });
    expect(sentItems.find((line) => line.itemId === esm2Item.id)?.reading).toMatchObject({
      startedAt: '08:00',
      endedAt: '17:00',
    });

    // Changed by the driver, the line is his word: the same rule as on the server.
    const staffBlock = blockOf(staffItem.id);
    type(field(staffBlock, 'Одометр'), '2001');
    await submitSheet();
    expect(await within(staffBlock).findByText('Укажите время начала смены')).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1);
  });

  it('рейс вне задания в сданном отчёте: точки называет сам отчёт, и время по ним передаётся', async () => {
    // The route lost its waybill after the report was submitted: the task dropped it, the frozen
    // report kept the item, and the server still asks the arrival at its stops.
    const frozen: ReportItemDto = {
      ...routeItem,
      id: 'item-route-frozen',
      sourceId: 'route-frozen',
      stops: [
        { routePointId: RP1, location: 'Карьер «Северный»' },
        { routePointId: RP2, location: 'ул. Строителей, 12' },
      ],
    };
    const { http } = renderCabinet([frozen, esm2Item], 'v3', { state: 'submitted' }, [esm2Item]);
    await waitForBlocks();

    expect(document.querySelectorAll('[data-stop]')).toHaveLength(2);
    fillNumbers(blockOf(frozen.id), '231468');
    await submitSheet();
    expect(
      await within(stop(1)).findByText('Укажите время прибытия на первую точку'),
    ).toBeDefined();
    expect(http.countOf('POST /driver/reports/:date/submit')).toBe(0);

    type(field(stop(1), 'Прибытие'), '07:40');
    type(field(stop(1), 'Убытие'), '08:30');
    type(field(stop(2), 'Убытие'), '10:05');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      odometerKm: 231468,
      points: [
        { position: 1, routePointId: RP1, arrivedAt: '07:40', departedAt: '08:30' },
        { position: 2, routePointId: RP2, arrivedAt: null, departedAt: '10:05' },
      ],
    });
  });

  it('отчёт v2 доезжает без времени: правило читает формат отчёта, а не сборки', async () => {
    const { http } = renderCabinet([esm2Item], 'v2');
    await waitForBlocks();

    fillNumbers(blockOf(esm2Item.id));
    await submitSheet();

    // A `v2` report opened before the release finishes under its own time rules (ADR 0234,
    // decision 6); the completeness of the numbers is the cabinet's own and does not depend on it.
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({ startedAt: null, endedAt: null });
  });

  it('перегон: ни полей времени, ни ключей времени в теле (D8)', async () => {
    const { http } = renderCabinet([moveItem]);
    await waitForBlocks();
    const block = blockOf(moveItem.id);

    expect(within(block).queryByText('Маршрут — время по факту')).toBeNull();
    expect(within(block).queryByRole('button', { name: /сейчас/u })).toBeNull();

    fillNumbers(block, '231468');
    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    const reading = submitBody(http).items[0]!.reading;
    expect(reading).not.toHaveProperty('points');
    expect(reading).not.toHaveProperty('startedAt');
    expect(reading).not.toHaveProperty('endedAt');
  });

  it('набранное время лежит в черновике v3 и переживает перезагрузку', async () => {
    const first = renderCabinet([routeItem]);
    await waitForBlocks();
    type(field(stop(1), 'Прибытие'), '07:40');

    const keys = Object.keys(localStorage).filter((key) => key.includes('driver-draft'));
    expect(keys.every((key) => key.startsWith('technic:driver-draft-v3:'))).toBe(true);
    expect(keys.map((key) => localStorage.getItem(key)).join('')).toContain('07:40');

    first.unmount();
    renderCabinet([routeItem]);
    await waitForBlocks();
    expect(field(stop(1), 'Прибытие').value).toBe('07:40');
  });

  it('сохранённые остановки показания главнее живых: после перестройки маршрута правят записанное', async () => {
    const saved: VehicleReadingDto = {
      id: 'reading-1',
      itemId: routeItem.id,
      kind: 'values',
      odometerKm: null,
      engineHours: null,
      fuelStartLiters: 180,
      fuelFilledLiters: null,
      fuelEndLiters: null,
      startedAt: '07:40',
      endedAt: null,
      points: [
        {
          position: 1,
          routePointId: RP1,
          location: 'Карьер «Северный»',
          arrivedAt: '07:40',
          departedAt: null,
        },
        // The live point of this stop was rebuilt away: the snapshot keeps the address.
        {
          position: 2,
          routePointId: null,
          location: 'Старый адрес разгрузки',
          arrivedAt: null,
          departedAt: null,
        },
      ],
      noDataReason: '',
      comment: '',
      source: 'driver',
      recordedAt: `${today}T08:00:00.000Z`,
      odometerAnomaly: null,
      engineHoursAnomaly: null,
      odometerDelta: null,
      engineHoursDelta: null,
      fileIds: [],
    };
    const { http } = renderCabinet([{ ...routeItem, reading: saved }]);
    await waitForBlocks();

    expect(document.querySelectorAll('[data-stop]')).toHaveLength(2);
    expect(within(stop(2)).getByText('2. Старый адрес разгрузки')).toBeDefined();
    expect(field(stop(1), 'Прибытие').value).toBe('07:40');

    // A stop without a request cannot be split: the summary says so instead of dropping its time.
    // The saved reading has only the fuel start: the rest of a whole shift is typed now.
    type(field(group(blockOf(routeItem.id), 'Конец смены'), 'Топливо'), '90');
    type(field(blockOf(routeItem.id), 'Одометр'), '231468');
    type(field(stop(1), 'Убытие'), '08:30');
    type(field(stop(2), 'Убытие'), '10:05');
    expect(
      await screen.findByText(
        'У части точек нет заявки — время между заявками распределит диспетчер',
      ),
    ).toBeDefined();

    await submitSheet();
    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    expect(submitBody(http).items[0]!.reading).toMatchObject({
      points: [
        { position: 1, routePointId: RP1, arrivedAt: '07:40', departedAt: '08:30' },
        { position: 2, routePointId: null, arrivedAt: null, departedAt: '10:05' },
      ],
    });
  });

  it('в читающем дне время не правится: поля выключены вместе с числами (Р10)', () => {
    const onChange = vi.fn();
    const entry = assignmentOf([routeItem]).entries[0]!;
    renderWithUser(
      <>
        <ReadingBlock
          item={esm2Item}
          value={emptyItem()}
          previous={null}
          stops={[]}
          errors={{}}
          uploading={false}
          readOnly
          onChange={onChange}
          onUpload={vi.fn()}
          onRemoveFile={vi.fn()}
        />
        <ReadingBlock
          item={routeItem}
          value={emptyItem()}
          previous={null}
          stops={stopsOf(routeItem, entry)}
          errors={{}}
          uploading={false}
          readOnly
          onChange={onChange}
          onUpload={vi.fn()}
          onRemoveFile={vi.fn()}
        />
      </>,
      { user: driver },
    );

    // No «сейчас» button anywhere (ADR 0237): the fields are the only way to a time.
    expect(screen.queryAllByRole('button', { name: /сейчас/u })).toHaveLength(0);
    expect(field(blockOf(esm2Item.id), 'Время начала').disabled).toBe(true);
    expect(field(stop(1), 'Прибытие').disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
