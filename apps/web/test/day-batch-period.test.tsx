import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  dayBatchOutcomeLabels,
  dayBatchRemainderMessage,
  type AuthUser,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDayBatchResultDto,
  type VehicleRequestDaysDto,
} from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { expectModalClosed, selectOption } from './antd';
import { authUser } from './factories/auth';
import {
  assignmentChange,
  assignmentHistory,
  availableDriver,
  dayBatchResult,
  driverSelection,
  ownAssignment,
  requestDay,
  vehicleRequest,
} from './factories/vehicle';
import { VehicleRequestDays } from '../src/pages/vehicle/VehicleRequestDays';
import { VehicleDayBatchModal } from '../src/pages/vehicle/VehicleDayBatchModal';

/**
 * "Распланировать период" — the second door of the "4-П for the whole term" batch (ADR 0207
 * decision 4), plus the report both doors show. The first door is in `day-batch.test.tsx`.
 *
 * Unlike the "take into work" window, this one has a server cut-off day (`onDate`), a machinist
 * known by id only from the assignment history, and a table of days that the answer replaces.
 */

const BATCH = 'POST /vehicle-requests/:id/days/batch';
const TERM = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];

/** An own-machine order in work, five days, none of them planned yet. */
const REQUEST = vehicleRequest({
  id: 'vr-9',
  displayNumber: 'ТС-42',
  status: 'confirmed',
  dateFrom: TERM[0],
  dateTo: TERM[4],
  assignment: ownAssignment(),
});
/** The server's cut-off day is the 12th: two term days are already in the past. */
const DAYS: VehicleRequestDaysDto = {
  onDate: '2026-08-12',
  blocker: null,
  items: TERM.map((d) => requestDay(d)),
};

const MACHINIST_ID = 'p-machinist';
const SELECTION = driverSelection([
  availableDriver(),
  availableDriver({ personId: MACHINIST_ID, fullName: 'Семёнов Семён Семёнович' }),
  availableDriver({ personId: 'p-2', fullName: 'Кузнецов Кузьма Кузьмич' }),
  availableDriver({ personId: 'p-3', fullName: 'Отменённый Олег Олегович' }),
]);

/**
 * The machinist on the cut-off day is the latest live driver change not after it. Every other row
 * here is a way to get that wrong: an earlier driver, a later one, and a superseded change dated
 * exactly on the cut-off day.
 */
const HISTORY = assignmentHistory({
  people: [
    { personId: MACHINIST_ID, fullName: 'Семёнов Семён Семёнович', cardRemovedOn: null },
    { personId: 'p-1', fullName: 'Тестовый Водитель Первый', cardRemovedOn: null },
  ],
  changes: [
    assignmentChange({
      id: 'd-1',
      effectiveDate: '2026-08-10',
      driver: { state: 'set', personId: 'p-1' },
    }),
    assignmentChange({
      id: 'd-2',
      effectiveDate: '2026-08-11',
      driver: { state: 'set', personId: MACHINIST_ID },
    }),
    assignmentChange({
      id: 'd-3',
      effectiveDate: '2026-08-13',
      driver: { state: 'set', personId: 'p-2' },
    }),
    assignmentChange({
      id: 'd-4',
      effectiveDate: '2026-08-12',
      driver: { state: 'set', personId: 'p-3' },
      supersededKind: 'cancelled',
    }),
  ],
});

/** All five days planned and issued: the table the server answers with. */
const PLANNED: VehicleRequestDaysDto = {
  ...DAYS,
  items: TERM.map((d, i) =>
    requestDay(d, {
      route: {
        id: `r-${i}`,
        displayNumber: `Р-${20 + i}`,
        position: 1,
        vehicleId: 'v-1',
        vehicleLabel: 'Ивановец КС-45717 · Е646СК799',
        driverPersonId: MACHINIST_ID,
        driverName: 'Семёнов Семён Семёнович',
        waybill: { id: `w-${i}`, number: `260810-000${i}`, status: 'issued' },
        version: 1,
      },
    }),
  ),
};

beforeEach(() => {
  // Before the term by the browser clock: whatever is "past" here comes from the server's `onDate`.
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-08-01T09:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

function routesFor(result: VehicleRequestDayBatchResultDto, days = DAYS): RouteMap {
  return {
    'GET /vehicle-requests/:id/days': () => json(days),
    'GET /vehicle-requests/:id/assignment-changes': ({ params }) =>
      json(params.id === REQUEST.id ? HISTORY : assignmentHistory({ changes: [], people: [] })),
    'GET /drivers/available': () => json(SELECTION),
    [BATCH]: () => json(result),
  };
}

function renderDays({
  user,
  readOnly,
  days,
  result = dayBatchResult({ days: PLANNED, issued: 5 }),
}: {
  user?: AuthUser;
  readOnly?: boolean;
  days?: VehicleRequestDaysDto;
  result?: VehicleRequestDayBatchResultDto;
} = {}) {
  const http = mockHttp(routesFor(result, days));
  renderWithUser(<VehicleRequestDays request={REQUEST} readOnly={readOnly} />, { user });
  return http;
}

const WINDOW = 'Распланировать период: заявка ТС-42';
const REPORT = 'Выписка 4-П на период: что получилось';
const issueBox = () =>
  screen.getByRole('checkbox', {
    name: 'Выписать путевые листы по заведённым рейсам',
  }) as HTMLInputElement;

/** The value shown by a select field; `null` when it is empty (the placeholder is not a value). */
function selectedText(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-select-content-has-value')?.getAttribute('title') ?? null;
}

/** Open the window from the table and wait for the machinist default to land. */
async function openBatch(machinist = /^Семёнов/) {
  fireEvent.click(await screen.findByText('Распланировать период'));
  await screen.findByText(WINDOW);
  await waitFor(() => expect(selectedText('Водитель на весь период')).toMatch(machinist));
}

function reportModal(): HTMLElement {
  const title = [...document.querySelectorAll('.ant-modal-title')].find(
    (el) => el.textContent === REPORT,
  );
  if (!title) throw new Error('отчёта пачки на экране нет');
  return title.closest('.ant-modal') as HTMLElement;
}

const giveReason = (value: string) =>
  fireEvent.change(screen.getByLabelText('Причина заднего числа'), { target: { value } });

describe('кнопка «Распланировать период»', () => {
  it('есть у того, кто планирует дни', async () => {
    renderDays();
    expect(await screen.findByText('Распланировать период')).toBeDefined();
  });

  const without = (right: string) =>
    authUser({ permissions: authUser().permissions.filter((p) => p !== right) });
  it.each([
    ['в читалке', { readOnly: true }],
    ['без права на ход заявки', { user: without('vehicleRequests.status') }],
    ['без права на путевые листы', { user: without('waybills.read') }],
  ])('нет %s: условие то же, что у подённой двери', async (_name, over) => {
    renderDays(over);
    // The counter is the anchor: the table is on screen, only the door is missing.
    expect(await screen.findByText('распланировано 0 из 5 дней')).toBeDefined();
    expect(screen.queryByText('Распланировать период')).toBeNull();
  });
});

describe('окно «Распланировать период»', () => {
  it('машинист — из истории назначения на день среза, и он же водитель по умолчанию', async () => {
    const http = renderDays();
    await openBatch();

    expect(http.countOf('GET /vehicle-requests/:id/assignment-changes')).toBe(1);
    expect(selectedText('Водитель на весь период')).toMatch(/^Семёнов Семён Семёнович/);
    expect(issueBox().checked).toBe(true);
  });

  it('прошедшие дни считаются по дню среза сервера, а не по часам браузера', async () => {
    renderDays();
    await openBatch();
    // The browser thinks it is 01.08, yet the server says 12.08: two term days are past.
    expect(screen.getByText(/^В сроке 2 дн\. до 12\.08\.2026/)).toBeDefined();
  });

  it('день среза до начала срока — причину не спрашивают, как бы ни спешили часы', async () => {
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    renderDays({ days: { ...DAYS, onDate: '2026-08-10' } });
    // The machinist is read on the cut-off day too: on the 10th the history still names p-1.
    await openBatch(/^Тестовый Водитель Первый/);
    expect(screen.queryByText('Причина заднего числа')).toBeNull();
  });

  it('листы выписываются по второй галочке, причина уходит обрезанной', async () => {
    const http = renderDays();
    await openBatch();
    fireEvent.click(issueBox());
    giveReason('  Техника отработала, оформляем по факту  ');

    fireEvent.click(screen.getByText('Распланировать'));
    await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
    expect(http.lastCall(BATCH)!.body).toEqual({
      driverPersonId: MACHINIST_ID,
      issueWaybills: false,
      reason: 'Техника отработала, оформляем по факту',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  /*
   * `dayBatchBody` trims the reason and drops it when nothing is left, so a reason of spaces would
   * reach the server as no reason at all and `backdateGuard` would answer 422 on the whole batch.
   * The field therefore refuses blank text, not only an empty one — both are checked, because the
   * second is exactly what a bare `required` lets through.
   */
  it('без причины и с причиной из одних пробелов пачка не уходит', async () => {
    const http = renderDays();
    await openBatch();

    fireEvent.click(screen.getByText('Распланировать'));
    expect(await screen.findByText('Укажите причину')).toBeDefined();
    expect(http.countOf(BATCH)).toBe(0);

    giveReason('   ');
    fireEvent.click(screen.getByText('Распланировать'));
    await waitFor(() => expect(screen.getByText('Укажите причину')).toBeDefined());
    // Give a premature request time to leave: the absence is asserted after the form settled.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(http.countOf(BATCH)).toBe(0);
  });

  it('после успеха таблица берётся из ответа, окно закрывается, отчёт остаётся', async () => {
    const http = renderDays();
    expect(await screen.findByText('распланировано 0 из 5 дней')).toBeDefined();
    await openBatch();
    giveReason('Оформляем по факту');
    // The refetch after the batch never answers: whatever the table shows next came from the
    // batch answer itself, which is the point — a second read could show a newer picture than
    // the one the report describes.
    http.use({ 'GET /vehicle-requests/:id/days': () => new Promise(() => {}) });

    fireEvent.click(screen.getByText('Распланировать'));
    expect(await screen.findByText('распланировано 5 из 5 дней')).toBeDefined();
    await expectModalClosed(WINDOW);
    expect(within(reportModal()).getByText('Выписано листов: 5')).toBeDefined();
  });
});

/** The window rendered alone, so a test can switch its target the way the caller does. */
function Harness() {
  const [target, setTarget] = useState({ request: REQUEST, onDate: DAYS.onDate });
  const other: SpecialEquipmentRequestDto = { ...REQUEST, id: 'vr-10', displayNumber: 'ТС-43' };
  return (
    <>
      <button onClick={() => setTarget({ request: { ...REQUEST }, onDate: DAYS.onDate })}>
        та же заявка
      </button>
      <button onClick={() => setTarget({ request: other, onDate: DAYS.onDate })}>
        другая заявка
      </button>
      <VehicleDayBatchModal target={target} onClose={() => {}} onDone={() => {}} />
    </>
  );
}

describe('поля окна живут своей заявкой', () => {
  it('новая сборка той же цели выбор не стирает, другая заявка — стирает', async () => {
    mockHttp(routesFor(dayBatchResult()));
    renderWithUser(<Harness />);
    await screen.findByText(WINDOW);
    await waitFor(() => expect(selectedText('Водитель на весь период')).toMatch(/^Семёнов/));
    await selectOption('Водитель на весь период', /Тестовый Водитель Первый/);
    fireEvent.click(issueBox());

    // The caller rebuilds `target` on every render; a reset keyed on the object would wipe this.
    fireEvent.click(screen.getByText('та же заявка'));
    expect(selectedText('Водитель на весь период')).toMatch(/^Тестовый/);
    expect(issueBox().checked).toBe(false);

    // Another order: a driver left from the neighbour would read as a decision about this one.
    fireEvent.click(screen.getByText('другая заявка'));
    await screen.findByText('Распланировать период: заявка ТС-43');
    await waitFor(() => expect(selectedText('Водитель на весь период')).toBeNull());
    expect(issueBox().checked).toBe(true);
  });
});

/** Run the batch from the table and return the report it leaves behind. */
async function reportOf(result: VehicleRequestDayBatchResultDto): Promise<HTMLElement> {
  const http = renderDays({ result: { ...result, days: PLANNED } });
  await openBatch();
  giveReason('Оформляем по факту');
  fireEvent.click(screen.getByText('Распланировать'));
  await waitFor(() => expect(http.countOf(BATCH)).toBe(1));
  await screen.findByText(REPORT);
  return reportModal();
}

describe('отчёт пачки', () => {
  it('шапка — числа сервера, строки — исходы словаря, пустое названо словами', async () => {
    const report = await reportOf(
      dayBatchResult({
        issued: 1,
        planned: 1,
        skipped: 1,
        failed: 1,
        rows: [
          {
            date: '2026-08-10',
            outcome: 'issued',
            routeNumber: 'Р-20',
            waybillNumber: '260810-0001',
          },
          { date: '2026-08-11', outcome: 'planned', routeNumber: 'Р-21' },
          {
            date: '2026-08-12',
            outcome: 'skipped',
            routeNumber: 'Р-9',
            reason: 'В рейсе нет строк',
          },
          { date: '2026-08-13', outcome: 'failed', reason: 'Сбой выписки' },
        ],
      }),
    );
    const view = within(report);

    for (const tag of ['Выписано листов: 1', 'Заведено рейсов: 1', 'Пропущено: 1', 'Ошибок: 1']) {
      expect(view.getByText(tag)).toBeDefined();
    }
    for (const outcome of ['issued', 'planned', 'skipped', 'failed'] as const) {
      expect(view.getByText(dayBatchOutcomeLabels[outcome])).toBeDefined();
    }
    const row = (date: string) => view.getByText(date).closest('tr') as HTMLElement;
    expect(within(row('10.08.2026')).getByText('260810-0001')).toBeDefined();
    expect(within(row('11.08.2026')).getByText('не выписан')).toBeDefined();
    // A failed day has neither a route nor a sheet, and its reason is the one line printed red.
    const failed = within(row('13.08.2026'));
    expect(failed.getByText('—')).toBeDefined();
    expect(failed.getByText('не выписан')).toBeDefined();
    expect(failed.getByText('Сбой выписки').closest('.ant-typography-danger')).toBeTruthy();
    // A skipped day is the one to finish by hand, so its row names both why and which route
    // refused it: "no task rows left" without the route number does not say where to look.
    const skipped = within(row('12.08.2026'));
    expect(skipped.getByText('Р-9')).toBeDefined();
    expect(skipped.getByText('В рейсе нет строк').closest('.ant-typography-danger')).toBeNull();
    // Nothing left beyond this press, so no promise of another one.
    expect(view.queryByText(/нажмите «Распланировать период» ещё раз/)).toBeNull();
  });

  it('нули показаны наравне с числами, а недобранный остаток назван', async () => {
    const report = await reportOf(dayBatchResult({ issued: 3, remaining: 12 }));
    const view = within(report);

    for (const tag of ['Выписано листов: 3', 'Заведено рейсов: 0', 'Пропущено: 0', 'Ошибок: 0']) {
      expect(view.getByText(tag)).toBeDefined();
    }
    expect(view.getByText(dayBatchRemainderMessage(12))).toBeDefined();
  });
});
