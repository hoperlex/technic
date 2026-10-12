import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { vehicleFeed, vehicleRequest, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * The work term moves through its own door (wave 4a of `docs/assignment-periods-plan.md`; Ж4, З5,
 * Д2), and since K3a (S-21 of 12.10.2026) the editor sends no `dateFrom`/`dateTo` in the wide
 * `PATCH /vehicle-requests/:id`, because release R2 removes them there for orders in work. The one
 * exception (S-22): a «Новая» order of an account without `waybills.read` keeps its term in the
 * wide PATCH — the door stays guarded by that right.
 *
 * Before the door the term rode the wide PATCH together with the comment and contacts, and the
 * person pressed "Save" without knowing the cost. The cost is of two kinds, and both are checked:
 *
 * - **paper**: an extension issues strict-accounting forms, a shortening burns them — the window
 *   must name the numbers before the click, not in the journal afterwards;
 * - **assignment history** (Д2): vehicle decisions remain past the new end, and keeping them is
 *   impossible — they would come back by themselves with the next extension. The server cancels
 *   them and demands the list be confirmed, so the window asks for a tick.
 *
 * And the split save itself: the term first, the rest second with the door's version; an unchanged
 * term never touches the door; a refused term writes nothing; a rest that fails after the term is
 * named and re-sent alone; a «Новая» order, which has nothing to show, goes through the door
 * without the window; and a refusal by right is shown, not retried through the wide route.
 *
 * Dates are counted from today in Moscow time: the form calendar lives relative to "today", and a
 * fixture pinned by a number would go stale with it.
 */

const TODAY = moscowDateKeyOf(new Date());
const day = (n: number) => shiftDateKey(TODAY, n);

/** A calendar key the way it is typed into the field: `12.08.2026`. */
function typed(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** A running order on an own vehicle: its extension is what issues weekly sheets. */
const WORKING = vehicleRequest({
  id: 'r-1',
  num: 601,
  displayNumber: 'ТС-601',
  status: 'confirmed',
  assignment: { vehicleId: 'v-1', ownership: 'own', typeName: 'Автокраны' },
  dateFrom: TODAY,
  dateTo: day(7),
} as never);

/** A closed order: its term is shortened by an edit — a running one only by an early end. */
const CLOSED = vehicleRequest({
  id: 'r-2',
  num: 602,
  displayNumber: 'ТС-602',
  status: 'done',
  assignment: { vehicleId: 'v-1', ownership: 'own', typeName: 'Автокраны' },
  dateFrom: TODAY,
  dateTo: day(10),
} as never);

/** A "new" order: no vehicle, no paper, no history — its term preview is silent. */
const FRESH = vehicleRequest({
  id: 'r-3',
  num: 603,
  displayNumber: 'ТС-603',
  dateFrom: TODAY,
  dateTo: day(3),
});

/** Empty consequences — the most frequent preview answer; a scenario adds its own on top. */
const EMPTY_PREVIEW = {
  plan: { cancel: [], issue: [] },
  requiredAnchors: [],
  requiredVehicleResolution: null,
  blockedShiftDays: [],
  clearedShiftDays: [],
  clearedShiftsFingerprint: null,
  requiredUnlocks: [],
  unlockFingerprint: null,
  issues: [],
  operationRequirement: null,
  asOf: TODAY,
  fingerprint: 'fp-preview',
  cancelGroups: [],
  cancelGroupsFingerprint: null,
};

/** An extension: a weekly sheet is issued, nothing to cancel, nothing to explain. */
const EXTEND_PREVIEW = {
  ...EMPTY_PREVIEW,
  plan: {
    cancel: [],
    issue: [
      {
        issueKey: 0,
        from: day(8),
        to: day(14),
        vehicleId: 'v-1',
        vehicleName: 'КамАЗ Е646СК799',
        driverPersonId: 'p-1',
        driverName: 'Иванов И. И.',
      },
    ],
  },
  fingerprint: 'fp-extend',
};

/**
 * A shortening: the sheet of the cut days burns, a worked sheet is re-issued, and a vehicle
 * decision remains past the new end — the command cancels it (Д2).
 */
const SHORTEN_PREVIEW = {
  ...EMPTY_PREVIEW,
  plan: {
    cancel: [{ waybillId: 'w-9', displayNumber: 'ЭСМ-2 № 9', from: day(8), to: day(10) }],
    issue: [],
  },
  requiredUnlocks: [{ waybillId: 'w-8', displayNumber: 'ЭСМ-2 № 8', from: TODAY, to: day(3) }],
  unlockFingerprint: 'fp-unlock',
  operationRequirement: { kind: 'crew', reasonRequired: true, operationIdRequired: true },
  cancelGroups: [
    {
      changeGroupId: 'g-1',
      rows: [
        {
          effectiveDate: day(6),
          dimension: 'vehicle',
          vehicle: { vehicleId: 'v-2', name: 'Автокран КС-45717' },
          driver: null,
          origin: 'reassignment',
        },
        {
          effectiveDate: day(6),
          dimension: 'driver',
          vehicle: null,
          driver: { state: 'set', personId: 'p-2' },
          origin: 'reassignment',
        },
      ],
    },
  ],
  cancelGroupsFingerprint: 'fp-groups',
  fingerprint: 'fp-shorten',
};

/** The apply answer: the order's state after the command, not a report about it (Р9). */
const applied = (dateFrom: string, dateTo: string | null) => ({
  version: 7,
  repeated: false,
  dateFrom,
  dateTo,
  esm2: { cancelled: [], issued: [] },
  earlyEndDropped: false,
  operationId: null,
  history: { state: 'materialized', validatedOn: TODAY, dirty: false, changes: [] },
});

interface RenderOptions {
  /** Routes that replace or extend the default ones: refusals and alternative answers. */
  routes?: RouteMap;
  user?: ReturnType<typeof authUser>;
}

function renderTab({ routes = {}, user = authUser() }: RenderOptions = {}) {
  const http = mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1, confirmed: 1, done: 1 })),
    'GET /vehicle-requests/feed': () => json(vehicleFeed([WORKING, CLOSED, FRESH])),
    'GET /objects': () => json(list([{ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }])),
    'GET /departments': () => json(list([])),
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /vehicles': () => json(emptyList()),
    'GET /vehicle-requests/:id/shifts': () => json({ items: [], onDate: TODAY }),
    // 4-P relocations are edited in the same form of a running order (migration 0082).
    'GET /vehicle-requests/:id/relocations': () => json([]),
    'POST /vehicle-requests/:id/period/preview': ({ params }) =>
      json(
        params.id === CLOSED.id
          ? SHORTEN_PREVIEW
          : params.id === FRESH.id
            ? EMPTY_PREVIEW
            : EXTEND_PREVIEW,
      ),
    'PATCH /vehicle-requests/:id/period': ({ body }) => {
      const sent = body as { dateFrom?: string; dateTo?: string | null };
      return json(applied(sent.dateFrom ?? TODAY, sent.dateTo ?? null));
    },
    'PATCH /vehicle-requests/:id': ({ body }) => json({ ...WORKING, ...(body as object) }),
    ...routes,
  });
  // The dispatcher by default: runs orders and reads paper — the door's preview lives on
  // `waybills.read`.
  renderWithUser(<VehicleRequestsTab />, { user });
  return http;
}

/** The body of the last wide PATCH — the one that must no longer carry the term. */
function wideBody(http: ReturnType<typeof mockHttp>): Record<string, unknown> {
  return http.lastCall('PATCH /vehicle-requests/:id')!.body as Record<string, unknown>;
}

/** The wide PATCH carries neither the term nor a backdate declaration (K3a). */
function expectNoTerm(body: Record<string, unknown>): void {
  expect('dateFrom' in body).toBe(false);
  expect('dateTo' in body).toBe(false);
  expect(body.backdateReason).toBeUndefined();
  expect(body.operationId).toBeUndefined();
}

async function openEdit(displayNumber: string): Promise<void> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
  await waitFor(() => expect(screen.getByText(`Заявка ${displayNumber}`)).toBeDefined());
  await screen.findByLabelText('Дата начала');
}

/**
 * Type a date into the form field: 0 is the term start, 1 its end. The calendar does not open by
 * mouse in jsdom, and antd accepts typed input on Enter.
 */
function typeDate(index: number, value: string): void {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>(
      '.ant-modal .ant-picker-input input:not([disabled])',
    ),
  ];
  const input = inputs[index]!;
  fireEvent.mouseDown(input);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
}

/** A button by its label: two windows are on screen — the request form and the term window. */
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Кнопка «${label}» не найдена`);
  return found;
}

/** The term window as a whole: confirmations are looked up in it, not among the form fields. */
function periodModal(): HTMLElement {
  const header = screen.getByText(/^Срок работ: заявка/);
  return header.closest('.ant-modal') as HTMLElement;
}

describe('срок работ правится своей дверью', () => {
  it('продление показывает выписываемый лист и уходит с отпечатком последствий', async () => {
    const http = renderTab();
    await openEdit('ТС-601');

    typeDate(1, typed(day(14)));
    fireEvent.click(button('Сохранить'));

    // The consequences window comes before any write: until the person confirms, nothing changed.
    await waitFor(() => expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(1));
    await screen.findByText(/^Срок работ: заявка ТС-601$/);
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);

    // What gets issued is visible: the sheet, the vehicle and the person it is issued to.
    expect(periodModal().textContent).toContain('Выпишется лист');
    expect(periodModal().textContent).toContain('КамАЗ Е646СК799');
    expect(periodModal().textContent).toContain('Иванов И. И.');
    // Nothing to cancel — the window says nothing about cancelled vehicle decisions.
    expect(periodModal().textContent).not.toContain('погаснут записи о технике');

    fireEvent.click(button('Изменить срок'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1));
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as Record<
      string,
      unknown
    >;
    expect(sent.dateTo).toBe(day(14));
    expect(sent.version).toBe(WORKING.version);
    // The fingerprint is what the person saw: without it the server says "look again".
    expect(sent.previewFingerprint).toBe('fp-extend');
    // Nothing to cancel or unlock — the server refuses an extra confirmation as strictly as a
    // missing one.
    expect(sent.cancelGroupsFingerprint).toBeUndefined();
    expect(sent.unlockFingerprint).toBeUndefined();
    expect(sent.operation).toBeUndefined();

    // The rest goes as a second command, with the version the term door returned — and without
    // the term: the door has already moved it (K3a).
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    const rest = wideBody(http);
    expect(rest.version).toBe(7);
    expectNoTerm(rest);
  });

  it('сокращение называет гасимые записи о технике и без подтверждения не уходит', async () => {
    const http = renderTab();
    await openEdit('ТС-602');

    typeDate(1, typed(day(3)));
    fireEvent.click(button('Сохранить'));

    await screen.findByText(/^Срок работ: заявка ТС-602$/);
    const text = () => periodModal().textContent ?? '';
    await waitFor(() => expect(text()).toContain('погаснут записи о технике'));

    // Said in plain words: what exactly is cancelled and why it cannot stay as it is.
    expect(text()).toContain('Автокран КС-45717');
    expect(text()).toContain('ожили бы сами');
    // Paper is named by numbers: the burning sheet and the worked one that will be re-issued.
    expect(text()).toContain('ЭСМ-2 № 9');
    expect(text()).toContain('ЭСМ-2 № 8');

    // Without the tick and the reason the command never reaches the network: the server would
    // answer 422, and a button that always refuses is the worst way to say so.
    fireEvent.click(button('Изменить срок'));
    await screen.findByText('Подтвердите, что перечисленные записи о технике погаснут');
    expect(screen.getByText('Укажите причину')).toBeDefined();
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);

    fireEvent.click(periodModal().querySelector('input[type="checkbox"]')!);
    fireEvent.change(periodModal().querySelector('textarea')!, {
      target: { value: 'объект закрыл фронт работ раньше' },
    });
    fireEvent.click(button('Изменить срок'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1));
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as {
      dateTo: string;
      previewFingerprint: string;
      cancelGroupsFingerprint: string;
      unlockFingerprint: string;
      operation: { reason: string; operationId: string };
    };
    expect(sent.dateTo).toBe(day(3));
    expect(sent.previewFingerprint).toBe('fp-shorten');
    // Three confirmations: the consequences, the cancelled decisions and the worked sheets.
    expect(sent.cancelGroupsFingerprint).toBe('fp-groups');
    expect(sent.unlockFingerprint).toBe('fp-unlock');
    expect(sent.operation.reason).toBe('объект закрыл фронт работ раньше');
    // The idempotency key is the client's uuid: a retry after a lost answer burns no second number.
    expect(sent.operation.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('у «Новой» заявки срок уходит дверью без окна последствий', async () => {
    const http = renderTab();
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    // The preview answered "nothing happens": no window, the door applies it at once with the
    // fingerprint of what it computed, and nothing it did not ask for.
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(1);
    expect(screen.queryByText(/^Срок работ: заявка/)).toBeNull();
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({
      version: FRESH.version,
      dateFrom: TODAY,
      dateTo: day(5),
      previewFingerprint: 'fp-preview',
    });
    // The door went first: the rest follows with its version and without the term.
    const order = http.calls
      .map((call) => `${call.method} ${call.path}`)
      .filter((call) => call.startsWith('PATCH'));
    expect(order).toEqual([
      `PATCH /vehicle-requests/${FRESH.id}/period`,
      `PATCH /vehicle-requests/${FRESH.id}`,
    ]);
    const rest = wideBody(http);
    expect(rest.version).toBe(7);
    expectNoTerm(rest);
  });

  it('правка без изменения срока дверь срока не трогает', async () => {
    const http = renderTab();
    await openEdit('ТС-601');

    const comment = document.querySelector<HTMLTextAreaElement>('.ant-modal textarea#comment')!;
    fireEvent.change(comment, { target: { value: 'работы с 8 утра' } });
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    // The door refuses an empty command, and an edit of the comment is not a term command.
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    const rest = wideBody(http);
    expect(rest.comment).toBe('работы с 8 утра');
    expect(rest.version).toBe(WORKING.version);
    expectNoTerm(rest);
  });

  it('отказ двери срока не пишет ничего: остальное не уходит', async () => {
    const http = renderTab({
      routes: {
        'POST /vehicle-requests/:id/period/preview': () =>
          apiError(422, { code: 'UNPROCESSABLE', message: 'Слишком рано для заказа на завтра' }),
      },
    });
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    await screen.findByText('Слишком рано для заказа на завтра');
    // The term step is first precisely so that its refusal leaves nothing half-written.
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);
    // The editor stays open with what the person typed.
    expect(screen.getByText('Заявка ТС-603')).toBeDefined();
  });

  it('закрытое окно последствий не пишет ничего', async () => {
    const http = renderTab();
    await openEdit('ТС-601');

    typeDate(1, typed(day(14)));
    fireEvent.click(button('Сохранить'));
    await screen.findByText(/^Срок работ: заявка ТС-601$/);

    fireEvent.click(periodModal().querySelector<HTMLButtonElement>('.ant-modal-close')!);
    // Saving again opens the window anew — the cancelled one left no pending half behind.
    fireEvent.click(button('Сохранить'));
    await waitFor(() => expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(2));
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);
  });

  it('остальное, упавшее после срока, названо и уходит повтором одно', async () => {
    let wideCalls = 0;
    const http = renderTab({
      routes: {
        'PATCH /vehicle-requests/:id': ({ body }) => {
          wideCalls += 1;
          return wideCalls === 1
            ? apiError(422, { code: 'UNPROCESSABLE', message: 'Укажите контактный телефон' })
            : json({ ...FRESH, ...(body as object) });
        },
      },
    });
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    // The one half-applied state of a split save is named, not hidden.
    await screen.findByText(
      'Срок работ изменён, но остальные правки не сохранены: Укажите контактный телефон',
    );
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1);
    expect(screen.getByText('Заявка ТС-603')).toBeDefined();

    // The second "Save" finds the term already applied: no second door call (it would be an empty
    // command), only the rest with the door's version.
    // The toast comes from the failure callback; the button stops loading a render later, and a
    // loading button swallows the click.
    await waitFor(() => expect(button('Сохранить').className).not.toContain('ant-btn-loading'));
    fireEvent.click(button('Сохранить'));
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(2));
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(1);
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1);
    const rest = wideBody(http);
    expect(rest.version).toBe(7);
    expectNoTerm(rest);
  });

  it('громкий предпросмотр «Новой» заявки открывает окно последствий', async () => {
    const http = renderTab({
      routes: {
        // A "new" order that still holds a sheet from before a rollback: the preview has
        // something to say, so the window says it.
        'POST /vehicle-requests/:id/period/preview': () => json(EXTEND_PREVIEW),
      },
    });
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    await screen.findByText(/^Срок работ: заявка ТС-603$/);
    await waitFor(() => expect(periodModal().textContent).toContain('Выпишется лист'));
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);
  });

  it('«Новая» заявка учётки без журнала листов несёт срок в широком PATCH, дверь не спрашивается', async () => {
    // The site staff edits its own «Новая» order and holds no `waybills.read`. S-22: the door stays
    // guarded by that right, and the term of a «Новая» order rides the wide PATCH — one command.
    const SITE = authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });
    const http = renderTab({ user: SITE });
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    const rest = wideBody(http);
    expect(rest.dateFrom).toBe(TODAY);
    expect(rest.dateTo).toBe(day(5));
    expect(rest.version).toBe(FRESH.version);
    // Nothing goes into the past here, so there is nothing to declare.
    expect(rest.backdateReason).toBeUndefined();
    expect(rest.operationId).toBeUndefined();
  });

  it('та же учётка без изменения срока шлёт широкий PATCH без срока', async () => {
    const http = renderTab({ user: authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] }) });
    await openEdit('ТС-603');

    const comment = document.querySelector<HTMLTextAreaElement>('.ant-modal textarea#comment')!;
    fireEvent.change(comment, { target: { value: 'заезд с ул. Ленина' } });
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(0);
    const rest = wideBody(http);
    expect(rest.comment).toBe('заезд с ул. Ленина');
    expectNoTerm(rest);
  });

  it('отказ двери по праву показан как есть, срок широким PATCH не переотправляется', async () => {
    const http = renderTab({
      routes: {
        'POST /vehicle-requests/:id/period/preview': () =>
          apiError(403, { code: 'FORBIDDEN', message: 'Недостаточно прав для правки срока' }),
      },
    });
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    await screen.findByText('Недостаточно прав для правки срока');
    // No retry through the wide route: for an account the door serves, a refusal is an answer.
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
  });
});
