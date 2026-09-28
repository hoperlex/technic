import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  dayBatchPortionMessage,
  type DriverSelectionDto,
  type VehicleRequestDto,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { selectOption, typeDate } from './antd';
import { list } from './factories/common';
import {
  availableDriver,
  dayBatchResult,
  driverSelection,
  fleetVehicle,
  freightRequest,
  machinist,
  ownAssignment,
  vehicleRequest,
} from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

/**
 * The "4-П for the whole term" batch (ADR 0207) from the "take into work" window: a second request
 * after the status transition. Guarded here: where the checkbox is offered, what the driver field
 * defaults to, when the backdate reason is asked, and that the batch never runs ahead of the
 * transition. The "Распланировать период" door and the report are in `day-batch-period.test.tsx`.
 */

const BATCH = 'POST /vehicle-requests/:id/days/batch';

/** The order's machinist: the default of the batch driver (ADR 0207 decision 6). */
const MACHINIST = machinist();
/** The same person as the driver selection sees him — the only way the default can apply. */
const MACHINIST_OPTION = availableDriver({ personId: MACHINIST.id, fullName: MACHINIST.fullName });
const DRIVER = availableDriver();

/** A three-day on-site order with an own machine already assigned (re-taking after a rollback). */
const ORDER = vehicleRequest({
  id: 'vr-1',
  dateFrom: '2026-08-10',
  dateTo: '2026-08-12',
  assignment: ownAssignment(),
});

/** Noon in Moscow well before the term: none of the order days is in the past for the client. */
const BEFORE_TERM = new Date('2026-08-01T09:00:00.000Z');
/** Noon of the second term day: 10.08 is already in the past by the client's Moscow calendar. */
const INSIDE_TERM = new Date('2026-08-11T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: BEFORE_TERM });
});

afterEach(() => {
  vi.useRealTimers();
});

interface Case {
  request?: VehicleRequestDto;
  mode?: 'confirm' | 'reassign';
  onSubmit?: (v: unknown) => void | Promise<unknown>;
  selection?: DriverSelectionDto;
  routes?: RouteMap;
}

function renderAssign({
  request = ORDER,
  mode,
  onSubmit = async () => {},
  selection = driverSelection([DRIVER, MACHINIST_OPTION]),
  routes = {},
}: Case = {}) {
  const http = mockHttp({
    'GET /vehicles': () =>
      json(list([fleetVehicle(), fleetVehicle({ id: 'v-2', registrationNumber: 'А123ВС777' })])),
    // Two people in the directory, so the machinist field never fills itself in.
    'GET /drivers': () =>
      json(list([MACHINIST, machinist({ id: 'p-2', fullName: 'Кузнецов Кузьма Кузьмич' })])),
    'GET /drivers/available': () => json(selection),
    [BATCH]: () => json(dayBatchResult({ issued: 3 })),
    ...routes,
  });
  const { queryClient } = renderWithUser(
    <VehicleAssignModal
      request={request}
      mode={mode}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return { http, queryClient };
}

const batchBox = () => screen.queryByRole('checkbox', { name: 'Выписать 4-П на весь период' });

async function enableBatch() {
  await waitFor(() => expect(batchBox(), 'галочка пачки').toBeTruthy());
  fireEvent.click(batchBox()!);
  await screen.findByText('Водитель на весь период');
}

/** The value shown by a select field; `null` when it is empty (the placeholder is not a value). */
function selectedText(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-select-content-has-value')?.getAttribute('title') ?? null;
}

/** The shortest legal form: the machinist, then the batch with him defaulted as the driver. */
async function readyToTake() {
  await selectOption('Машинист', /Семёнов/);
  await enableBatch();
  await waitFor(() => expect(selectedText('Водитель на весь период')).toMatch(/^Семёнов/));
}

const takeIntoWork = () => fireEvent.click(screen.getByText('Взять в работу'));

/** Let pending microtasks and a few macrotasks run, so a premature request would already be out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function takeExpectingNoBatch(http: HttpMock, onSubmit: ReturnType<typeof vi.fn>) {
  takeIntoWork();
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  await settle();
  expect(http.countOf(BATCH)).toBe(0);
}

describe('галочка «Выписать 4-П на весь период» в окне перевода в работу', () => {
  // Linearity is not part of the condition: a one-day 4-П is asked for any machine on site.
  it.each([false, true])(
    'предлагается заказу на объект своей машиной (линейная: %s)',
    async (l) => {
      renderAssign({ request: { ...ORDER, isLinear: l } });
      await enableBatch();
      expect(screen.getByText(/Каждый день срока \(3 дн\.\) встанет в рейс/)).toBeDefined();
    },
  );

  // Each case waits for a field of the same render pass, so absence is not just "not loaded yet".
  const rental = ownAssignment({ ownership: 'rental', lessorId: 'c-1', lessorName: 'Аренда' });
  it.each<[string, Case, string]>([
    // The lessor issues the sheet for his own machine; the portal may not promise it.
    ['аренды', { request: { ...ORDER, assignment: rental } }, 'Арендодатель'],
    // The term is already running; missing days are added by the button in the card.
    [
      'смены техники',
      {
        request: { ...ORDER, status: 'confirmed' },
        mode: 'reassign',
        routes: { 'GET /vehicle-requests/:id/waybills': () => json([]) },
      },
      'Сменить технику',
    ],
    // The days of a returned order are already lived through.
    ['возврата из «Выполнена»', { request: { ...ORDER, status: 'done' } }, 'Машинист'],
  ])('у %s её нет', async (_name, over, anchor) => {
    renderAssign(over);
    await screen.findByText(anchor);
    expect(batchBox()).toBeNull();
  });

  it('у грузоперевозки её нет: там лист выписывается на рейс самой заявки', async () => {
    const prefill = { required: true, formCode: '4p', formLabel: '4-П', reason: null, trip: null };
    renderAssign({
      request: freightRequest({ assignment: ownAssignment() }),
      routes: {
        'GET /vehicle-requests/:id/route-prefill': ({ query }) =>
          json({ ...prefill, tripDate: query.get('date'), routes: [] }),
        'GET /vehicle-routes/suggest': () => json({ routes: [], trip: null, hitched: [] }),
        'GET /vehicle-types': () => json(list([])),
      },
    });
    await screen.findByText('Маршрут');
    expect(batchBox()).toBeNull();
  });

  it('подсказка считает дни по фактическому сроку формы, а не по заказанному', async () => {
    renderAssign();
    await enableBatch();
    typeDate('Фактическая дата окончания', '14.08.2026');
    expect(await screen.findByText(/Каждый день срока \(5 дн\.\)/)).toBeDefined();
  });

  it('срок длиннее порции обещает остаток, а не отказ', async () => {
    renderAssign({ request: { ...ORDER, dateTo: '2026-10-08' } });
    await enableBatch();
    // 10.08–08.10 is sixty days: the first fifty go now, the other ten on the next press.
    expect(document.body.textContent).toContain(dayBatchPortionMessage(60));
  });
});

describe('водитель на весь период', () => {
  it('обязателен: без него перевод в работу не уходит вовсе', async () => {
    const onSubmit = vi.fn(async () => {});
    renderAssign({ onSubmit, selection: driverSelection([DRIVER]) });
    await selectOption('Машинист', /Семёнов/);
    await enableBatch();
    takeIntoWork();
    expect(await screen.findByText('Выберите водителя — без него лист не выписать')).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('без машины поле выключено: годность документов считается под машину', async () => {
    renderAssign({ request: { ...ORDER, assignment: null } });
    await enableBatch();
    expect(
      screen.getByText('Сначала выберите технику: годность документов считается под машину'),
    ).toBeDefined();
    const field = screen.getByText('Водитель на весь период').closest('.ant-form-item')!;
    expect(field.querySelector('.ant-select-disabled')).toBeTruthy();
  });

  it('список — отбор под машину на первый день срока; машинист из него подставляется', async () => {
    const { http } = renderAssign();
    await readyToTake();
    const query = http.lastCall('GET /drivers/available')!.query;
    expect(query.get('vehicleId')).toBe('v-1');
    expect(query.get('on')).toBe('2026-08-10');
    // The batch prints no trailer, so the selection is never measured against one.
    expect(query.get('withTrailer')).toBeNull();
    // Default and choice agree, so there is nothing to warn about.
    expect(screen.queryByText(/Листы уйдут не на машиниста заявки/)).toBeNull();
  });

  it('машиниста нет в отборе — поле пусто, и окно объясняет почему', async () => {
    renderAssign({ selection: driverSelection([DRIVER]) });
    await selectOption('Машинист', /Семёнов/);
    await enableBatch();
    expect(
      await screen.findByText(
        'Машинист заявки (Семёнов Семён Семёнович) в отборе водителей на 10.08.2026 не значится — выберите, кто поедет',
      ),
    ).toBeDefined();
    expect(selectedText('Водитель на весь период')).toBeNull();
  });

  it('выбранного водителя подстановка не перетирает — и расхождение названо вслух', async () => {
    renderAssign();
    await enableBatch();
    await selectOption('Водитель на весь период', /Тестовый Водитель Первый/);
    // The machinist arrives after the choice: the default must not win over a human decision.
    await selectOption('Машинист', /Семёнов/);
    expect(
      await screen.findByText(
        'Листы уйдут не на машиниста заявки (Семёнов Семён Семёнович), а на выбранного здесь человека',
      ),
    ).toBeDefined();
    expect(selectedText('Водитель на весь период')).toMatch(/^Тестовый Водитель Первый/);
  });
});

/**
 * This window has no server cut-off day (the order day does not exist yet), so the portal reads the
 * Moscow calendar itself; a term wholly ahead is covered by the body test below.
 */
describe('причина заднего числа в окне перевода — по календарю клиента', () => {
  it('в сроке есть прошедший день — причина обязательна, называет их число и уходит обрезанной', async () => {
    vi.setSystemTime(INSIDE_TERM);
    const { http } = renderAssign();
    await readyToTake();

    expect(screen.getByText(/^В сроке 1 дн\. до 11\.08\.2026/)).toBeDefined();
    takeIntoWork();
    expect(await screen.findByText('Укажите причину')).toBeDefined();
    expect(http.countOf(BATCH)).toBe(0);

    fireEvent.change(screen.getByLabelText('Причина заднего числа'), {
      target: { value: '  Техника отработала, листы оформляем по факту  ' },
    });
    takeIntoWork();
    await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
    expect(http.lastCall(BATCH)!.body).toMatchObject({
      reason: 'Техника отработала, листы оформляем по факту',
    });
  });
});

/** The days door plans only an order already in work with its machine, hence the order (ADR 0207). */
describe('порядок: сначала перевод в работу, потом пачка', () => {
  it('пачка ждёт ответа перевода и уходит только после него', async () => {
    let finish!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { http } = renderAssign({ onSubmit });
    await readyToTake();

    takeIntoWork();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await settle();
    expect(http.countOf(BATCH)).toBe(0);

    finish();
    await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
  });

  it('перевод отклонён — пачки нет: заявка не в работе, планировать нечего', async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error('409')));
    const { http } = renderAssign({ onSubmit });
    await readyToTake();
    await takeExpectingNoBatch(http, onSubmit);
  });

  it('пачка отклонена — отказ говорит, что заявка всё же взята в работу', async () => {
    const { http } = renderAssign({
      routes: {
        [BATCH]: () => apiError(422, { code: 'VALIDATION_ERROR', message: 'Водитель не найден' }),
      },
    });
    await readyToTake();

    takeIntoWork();
    await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
    expect(
      await screen.findByText(
        'Заявка взята в работу, но 4-П на период не выписаны: Водитель не найден',
      ),
    ).toBeDefined();
  });

  it('галочка снята — уходит один перевод, без пачки', async () => {
    const onSubmit = vi.fn(async () => {});
    const { http } = renderAssign({ onSubmit });
    await readyToTake();
    fireEvent.click(batchBox()!);
    // `Form.useWatch` publishes the unchecked state on the next render, not inside the click.
    await waitFor(() => expect(screen.queryByText('Водитель на весь период')).toBeNull());
    await takeExpectingNoBatch(http, onSubmit);
  });

  /*
   * A RISK, NOT A LIVE DEFECT. `onSubmit` may return `void`, and the batch is chained on
   * `Promise.resolve(onSubmit(payload))`: such a caller releases it before the transition answers,
   * and the server rejects a batch for an order not in work. The only caller today returns
   * `mutateAsync`; the next one passing a plain `mutate` would not. Expected to fail until fixed.
   */
  it.fails('перевод без обещания не должен отпускать пачку раньше ответа', async () => {
    const onSubmit = vi.fn(() => {});
    const { http } = renderAssign({ onSubmit });
    await readyToTake();
    await takeExpectingNoBatch(http, onSubmit);
  });
});

describe('тело пачки и следы после неё', () => {
  it('листы выписываются всегда, причины нет, ключ повтора — свой на каждое нажатие', async () => {
    const { http } = renderAssign();
    await readyToTake();
    // The whole term is ahead, so nothing is asked and no `reason` key leaves at all: "no
    // explanation" and "an empty explanation" differ for the server's schema.
    expect(screen.queryByText('Причина заднего числа')).toBeNull();

    takeIntoWork();
    await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
    takeIntoWork();
    await waitFor(() => expect(http.countOf(BATCH)).toBe(2));

    const calls = http.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/days/batch'));
    // There is no second checkbox in this window: the paper is the reason it was ticked.
    for (const call of calls) {
      expect(call.path).toBe('/vehicle-requests/vr-1/days/batch');
      expect(call.body).toEqual({
        driverPersonId: MACHINIST.id,
        issueWaybills: true,
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    }
    // The key recognises the server's own interrupted request; a second press is a new operation.
    const keys = calls.map((c) => (c.body as { operationId: string }).operationId);
    expect(new Set(keys).size).toBe(2);
  });

  it('гаснут заявки, рейсы, журнал листов и срез гаража', async () => {
    const { http, queryClient } = renderAssign();
    const keys = [
      vehicleRequestKeys.feed({}),
      vehicleRouteKeys.list({}),
      waybillKeys.list({}),
      garageKeys.vehicles({ on: '2026-08-10' }),
    ];
    for (const key of keys) queryClient.setQueryData(key, { items: [] });
    await readyToTake();

    takeIntoWork();
    await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
    await waitFor(() =>
      expect(keys.map((k) => queryClient.getQueryState(k)?.isInvalidated)).toEqual(
        Array(4).fill(true),
      ),
    );
  });
});
