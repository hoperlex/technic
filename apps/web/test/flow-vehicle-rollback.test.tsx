import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  ROLLBACK_WAYBILL_MESSAGE,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleRequestRollbackPreviewDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  approvedVehicleRequest,
  classification,
  vehicleFeed,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { MOBILE_VIEWPORT } from './viewport';
import { expectModalClosed } from './antd';

/**
 * Returning a vehicle request from "in work" to "new" — the administrator's rollback that erases
 * everything the request gained in work (`transitionResetsWork`).
 *
 * THE LIST OF WHAT IS ERASED IS COMPUTED BY THE SERVER (ADR 0211), and that is the main thing the
 * scenario guards. The portal used to assemble it from the request DTO and its relocations — a
 * second carrier of the rule the door executes — and the retelling diverged both ways: it kept
 * silent about days, shifts, the early end and ESM-2 sheets, and promised to remove a relocation
 * that stays because a waybill was issued for it. So the check is not "a route line is present"
 * but "the screen shows exactly what the preview sent": a line absent from the answer is again a
 * lie exactly where the person decides whether to erase the work.
 *
 * Four more things are indistinguishable from correct work by markup alone:
 *
 * 1. The return does not happen on a menu click: first comes a dialog with a mandatory reason.
 * 2. **The approval is absent from the list entirely** (ADR 0172): the rollback keeps it, and a
 *    line about it would stop the person to protect what is not at risk. Checked by negation — such
 *    a line used to be there, and bringing it back unnoticed is easiest.
 * 3. Until the preview answers the dialog promises nothing: neither an empty "nothing to erase"
 *    nor a list. An empty list reads as "no work was gained" — and the return gets pressed calmly.
 * 4. One status PATCH goes to the server — with the reason, the version and the fingerprint of the
 *    consequences read — and the list is refetched after it.
 */

/** Own vehicle with a rate: its assignment is the very agreement the return erases. */
const OWN_VEHICLE: VehicleRequestAssignmentDto = {
  vehicleId: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  vehicleCategoryId: 'vc-1',
  categoryName: 'г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Е646СК799',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: 2500,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Д. П.',
  assignedAt: '2026-08-02T08:00:00.000Z',
};

/** A rental: no rates were agreed for it, so the list names the lessor. */
const RENTAL_VEHICLE: VehicleRequestAssignmentDto = {
  ...OWN_VEHICLE,
  vehicleId: 'v-2',
  ownership: 'rental',
  registrationNumber: null,
  modelName: null,
  description: 'Автокран 25 тн',
  lessorId: 'cp-9',
  lessorName: 'ООО «Кран-Сервис»',
  pricePerHour: null,
};

/**
 * A fact on a request "in work" is no invention: this is how a request looks after it was closed
 * and rolled back into work by an administrator (the `done` → `confirmed` rollback keeps the fact).
 * The return to "new" is the only transition that erases it, and that must be said in advance.
 */
const COMPLETION: VehicleRequestCompletionDto = {
  workedUnit: 'hours',
  workedAmount: 26,
  rate: null,
  totalCost: null,
  completedBy: 'user-1',
  completedByName: 'Диспетчеров Д. П.',
  completedAt: '2026-08-03T14:00:00.000Z',
  // Closed the old status way: such a fact has no actual date (R3 of the actual-end-date plan) and
  // no snapshot of the previous term either.
  endedOn: null,
  previousDateTo: null,
  workedHours: null,
  workedShifts: null,
  deliveryCost: null,
};

/**
 * A preview answer with all seven parts of the plan at once. Not a "typical" request but a full
 * one: the dialog must name every part, and a request missing half of them would not check that.
 *
 * Form numbers are present — that is the answer to a `waybills.read` holder; without the journal
 * the server sends `sheets: null`, and then the counters speak about the paper (a separate check
 * below).
 */
const PREVIEW: VehicleRequestRollbackPreviewDto = {
  blockers: [],
  assignment: true,
  completion: true,
  routes: {
    detach: [{ routeNumber: 'Р-3', date: '2026-08-05' }],
    frozen: [{ routeNumber: 'Р-4', date: '2026-08-06' }],
  },
  relocations: {
    drop: [{ routeNumber: 'Р-8', purpose: 'delivery', routeDate: '2026-08-05' }],
    keep: [{ routeNumber: 'Р-9', purpose: 'pickup', routeDate: '2026-08-14' }],
  },
  shifts: [
    { date: '2026-08-05', approved: false },
    { date: '2026-08-06', approved: true },
  ],
  earlyEnd: { newDateTo: '2026-08-12' },
  esm2: {
    cancelCount: 1,
    keepCount: 1,
    sheets: {
      cancel: [{ id: 'wb-1', number: 'ЭСМ2-000123', from: '2026-08-10', to: '2026-08-16' }],
      keep: [{ id: 'wb-2', number: 'ЭСМ2-000120', from: '2026-08-03', to: '2026-08-09' }],
    },
  },
  dropsLinearFreeze: true,
  fingerprint: 'fp-1',
};

/** No plan at all: the server said there is nothing to erase — only then does the dialog say so. */
const EMPTY_PREVIEW: VehicleRequestRollbackPreviewDto = {
  ...PREVIEW,
  routes: { detach: [], frozen: [] },
  relocations: { drop: [], keep: [] },
  assignment: false,
  completion: false,
  shifts: [],
  earlyEnd: null,
  esm2: { cancelCount: 0, keepCount: 0, sheets: { cancel: [], keep: [] } },
  dropsLinearFreeze: false,
};

/**
 * A request in work with everything it gained: the approval, a vehicle with a rate, a route place
 * and the fact of an earlier closing. The version is deliberately not the first — it shows in the
 * request body.
 */
const IN_WORK = approvedVehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  version: 5,
  assignment: OWN_VEHICLE,
  completion: COMPLETION,
  route: {
    id: 'route-3',
    displayNumber: 'Р-3',
    routeDate: '2026-08-05',
    position: 2,
    hasWaybill: false,
    version: 4,
  },
});

const REASON = 'Заказчик перенёс работы, машину сняли';

const STATUS_ROUTE = 'PATCH /vehicle-requests/:id/status';
const PREVIEW_ROUTE = 'POST /vehicle-requests/:id/rollback/preview';

/**
 * The tab through an administrator's eyes: rolling back along the cycle is their right
 * (`requests.rollbackStatus`), and nobody else has the "Новая" item in the status menu.
 */
function renderTab(over: RouteMap = {}, mobile = false): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([IN_WORK])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
    // Screen dictionaries: the scenario does not need them, but the tab asks on its first render.
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    // The vehicle directory is the assigned-vehicle filter (ADR 0098); the list does not need it.
    'GET /vehicles': () => json(emptyList()),
    // The consequences are asked exactly when the rollback dialog opens and are computed by the
    // server with the plan it will then execute — the portal has no list of its own any more.
    [PREVIEW_ROUTE]: () => json(PREVIEW),
    // Answer with the same request already returned to "new" — as the server does. The approval
    // stays in the answer: the rollback keeps it (ADR 0172), and the request returns ready to work.
    [STATUS_ROUTE]: ({ params, body }) =>
      json(
        approvedVehicleRequest({
          ...IN_WORK,
          id: params.id,
          status: (body as { status: 'new' }).status,
          assignment: null,
          completion: null,
          route: null,
          version: IN_WORK.version + 1,
        }),
      ),
    ...over,
  });

  renderWithUser(<VehicleRequestsTab />, {
    user: authUser({ role: 'admin' }),
    viewport: mobile ? MOBILE_VIEWPORT : undefined,
  });
  return http;
}

/** A button by its visible caption: `*ByRole` on an antd table names the whole tree. */
function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

/**
 * A row's status change: the status tag is a button with the menu of this role's transitions
 * (ADR 0021).
 */
async function openStatusMenu(target: string) {
  clickButton('В работе');
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (el) => el.textContent === target,
    );
    expect(found, `пункт меню «${target}»`).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/**
 * The status menu of the row at `index`: with several rows the first "В работе" tag is not enough,
 * and an earlier row's menu stays in the DOM — only the newest one is clicked.
 */
async function openRowStatusMenu(index: number, target: string) {
  const tags = [...document.querySelectorAll('button')].filter(
    (el) => el.textContent === 'В работе',
  );
  expect(tags[index], `тег статуса строки ${index}`).toBeTruthy();
  fireEvent.click(tags[index]!);
  const item = await waitFor(() => {
    // The newest menu is the last one in the DOM: jsdom runs no closing animation, so an earlier
    // row's menu keeps its items without the hidden class.
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .reverse()
      .find((el) => el.textContent === target);
    expect(found, `пункт меню «${target}»`).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/** The rollback dialog's button: its captions are "Вернуть в «Новую»" and "Не возвращать". */
function submitRollbackModal() {
  clickButton('Вернуть в «Новую»');
}

/** The dialog is open and the consequences are shown: before they appear it promises nothing. */
async function openRollbackWindow() {
  await openStatusMenu('Новая');
  expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
  await screen.findByText('Заявка вернётся в состояние только что заведённой');
}

function typeReason(value = REASON) {
  fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-42'), {
    target: { value },
  });
}

describe('возврат заявки на технику в «Новую»', () => {
  it('перечисляет присланное сервером: что снимется и что останется', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();
    // The menu item alone changes nothing: the work is erased by the confirmation, not a misclick.
    expect(http.countOf(STATUS_ROUTE)).toBe(0);
    // The consequences are asked for the version the dialog will then present to the door.
    expect(http.lastCall(PREVIEW_ROUTE)?.body).toEqual({ version: IN_WORK.version });

    // Removed: the vehicle with its rate (the name from the request, the removal itself from the
    // plan), the route place, the relocation without a waybill, the work days with approved ones
    // named apart, the pending early end, the current week's ESM-2 sheet, the linearity freeze and
    // the presented fact.
    expect(await screen.findByText(/Назначенная техника: Е646СК799 — .*₽\/час/)).toBeDefined();
    expect(screen.getByText('Место в рейсе Р-3 за 05.08.2026')).toBeDefined();
    expect(screen.getByText('Доставка техники на объект — рейс Р-8 от 05.08.2026')).toBeDefined();
    expect(
      screen.getByText('Дни работ — 2 строки, из них согласованных объектом: 06.08.2026'),
    ).toBeDefined();
    expect(
      screen.getByText('Запрос на досрочное завершение по 12.08.2026 — он ждёт визы и будет снят'),
    ).toBeDefined();
    expect(
      screen.getByText('Аннулируются листы ЭСМ-2: ЭСМ2-000123 (10.08.2026 — 16.08.2026)'),
    ).toBeDefined();
    expect(screen.getByText(/Снимется заморозка линейности/)).toBeDefined();
    expect(screen.getByText('Предъявленный факт: 26 ч')).toBeDefined();

    // Stays — and it says why: a waybill holds both the route place and the relocation, and a
    // worked week is not cancelled by the reconciliation. Silence about it is what promised too
    // much.
    expect(
      screen.getByText('Место в рейсе Р-4 за 06.08.2026 — его держит действующий путевой лист'),
    ).toBeDefined();
    expect(screen.getByText(/Вывоз техники с объекта — рейс Р-9 от 14\.08\.2026/)).toBeDefined();
    expect(
      screen.getByText(/Останутся действующими листы ЭСМ-2 за отработанные недели: ЭСМ2-000120/),
    ).toBeDefined();

    // The request has an approval (`approvedVehicleRequest`), and yet not a word about it: the
    // rollback keeps it, and the request returns to "new" approved (ADR 0172).
    expect(screen.queryByText(/Виза руководителя строительства/)).toBeNull();
  });

  it('перечень не обещает того, чего в плане сервера нет', async () => {
    // The same request on a rental vehicle with an empty plan: apart from the assignment the server
    // named nothing — and neither does the dialog. The old portal would add relocations and a route
    // place here from the DTO.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(
          vehicleFeed([
            approvedVehicleRequest({
              ...IN_WORK,
              assignment: RENTAL_VEHICLE,
              completion: null,
              route: null,
            }),
          ]),
        ),
      [PREVIEW_ROUTE]: () => json({ ...EMPTY_PREVIEW, assignment: true }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();

    // A rental without agreed rates names the lessor: the deal was with them, they get the call.
    expect(
      screen.getByText('Назначенная техника: Автокран 25 тн — ООО «Кран-Сервис»'),
    ).toBeDefined();
    expect(screen.queryByText(/Виза руководителя строительства/)).toBeNull();
    expect(screen.queryByText(/Место в рейсе/)).toBeNull();
    expect(screen.queryByText(/Доставка техники/)).toBeNull();
    expect(screen.queryByText(/Дни работ/)).toBeNull();
    expect(screen.queryByText(/ЭСМ-2/)).toBeNull();
    expect(screen.queryByText(/Предъявленный факт/)).toBeNull();
  });

  it('без журнала листов о бумаге говорят счётчики, а не номера бланков', async () => {
    // `sheets: null` is the server's answer to a rollback-right holder without `waybills.read`
    // (ADR 0106): they learn fully whether the paper burns, but strict-accounting numbers stay
    // closed.
    renderTab({
      [PREVIEW_ROUTE]: () =>
        json({ ...PREVIEW, esm2: { cancelCount: 2, keepCount: 1, sheets: null } }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();

    expect(screen.getByText('Аннулируются недельные листы ЭСМ-2 — 2')).toBeDefined();
    expect(
      screen.getByText('Останутся действующими листы ЭСМ-2 за отработанные недели — 1'),
    ).toBeDefined();
    expect(screen.queryByText(/ЭСМ2-000123/)).toBeNull();
  });

  it('до ответа сервера окно не обещает ни перечня, ни пустоты', async () => {
    // The answer is held back: waiting is a state of the dialog, not an instant between frames.
    const held: { release?: () => void } = {};
    renderTab({
      [PREVIEW_ROUTE]: () =>
        new Promise<MockResponse>((resolve) => {
          held.release = () => resolve(json(PREVIEW));
        }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openStatusMenu('Новая');
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();

    // The wait is named aloud. An empty list or "nothing to erase" reads as "the request gained no
    // work", and the return gets pressed calmly — while everything would be erased.
    expect(await screen.findByText('Выясняем, что снимет возврат')).toBeDefined();
    expect(screen.queryByText('Стирать у заявки нечего — сменится только статус.')).toBeNull();
    expect(screen.queryByText(/Назначенная техника/)).toBeNull();

    held.release!();
    expect(await screen.findByText('Место в рейсе Р-3 за 05.08.2026')).toBeDefined();
  });

  it('помеха берётся из ответа предпросмотра, а не из флага заявки', async () => {
    // The request has no `hasActiveWaybill` flag, yet a waybill holds a day of the order
    // (ADR 0207): only the server can say so, and it says it in the words the door refuses with.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(vehicleFeed([approvedVehicleRequest({ ...IN_WORK, hasActiveWaybill: false })])),
      [PREVIEW_ROUTE]: () =>
        json({
          ...PREVIEW,
          blockers: [{ code: 'active_waybill', message: ROLLBACK_WAYBILL_MESSAGE }],
        }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();
    expect(screen.getByText(ROLLBACK_WAYBILL_MESSAGE)).toBeDefined();
  });

  it('флаг заявки сам по себе помехой больше не считается', async () => {
    // The other side of the same: `hasActiveWaybill` holds even for a cancelled sheet, while the
    // plan found no blockers. Scaring with a prohibition the door does not have is no better than
    // keeping silent about one.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(vehicleFeed([approvedVehicleRequest({ ...IN_WORK, hasActiveWaybill: true })])),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();
    expect(screen.queryByText(ROLLBACK_WAYBILL_MESSAGE)).toBeNull();
  });

  it('отказ двери по названной помехе — её текст, а не «последствия пересчитаны»', async () => {
    // The active-waybill refusal is a 409 with the same shared code as a stale fingerprint, but the
    // door raises it before comparing fingerprints. The dialog already named it, so the honest
    // answer is the door's text — not "the data changed" over data that did not change.
    const refusal = `${ROLLBACK_WAYBILL_MESSAGE} (Т-42)`;
    const http = renderTab({
      [PREVIEW_ROUTE]: () =>
        json({ ...PREVIEW, blockers: [{ code: 'active_waybill', message: refusal }] }),
      [STATUS_ROUTE]: () => apiError(409, { code: 'version_conflict', message: refusal }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();

    typeReason();
    submitRollbackModal();

    await waitFor(() =>
      expect(document.querySelector('.ant-message-notice')?.textContent).toContain(refusal),
    );
    expect(screen.queryByText('Последствия пересчитаны')).toBeNull();
    expect(http.countOf(PREVIEW_ROUTE)).toBe(1);
  });

  it('строку решает план, даже если в строке списка нет названия', async () => {
    // A list row that went stale before the dialog opened lacks the vehicle and the fact the
    // server is about to remove. The plan says they go, so the dialog says so too, unnamed.
    renderTab({
      'GET /vehicle-requests/feed': () =>
        json(
          vehicleFeed([approvedVehicleRequest({ ...IN_WORK, assignment: null, completion: null })]),
        ),
      [PREVIEW_ROUTE]: () => json({ ...EMPTY_PREVIEW, assignment: true, completion: true }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();

    expect(screen.getByText('Назначенная техника со ставками')).toBeDefined();
    expect(screen.getByText('Предъявленный факт')).toBeDefined();
  });

  it('запоздавший ответ о другой заявке окно не подменяет', async () => {
    // The dialog is closed while the first answer is on its way and opened on another row. The late
    // answer belongs to the first request: shown here, it would also send that request's version
    // and fingerprint to the second one's door.
    const OTHER = approvedVehicleRequest({
      ...IN_WORK,
      id: 'vr-2',
      num: 43,
      displayNumber: 'Т-43',
      version: 9,
    });
    const OTHER_PREVIEW: VehicleRequestRollbackPreviewDto = {
      ...EMPTY_PREVIEW,
      routes: { detach: [{ routeNumber: 'Р-7', date: '2026-08-07' }], frozen: [] },
      fingerprint: 'fp-other',
    };
    const held: { release?: () => void } = {};
    const http = renderTab({
      'GET /vehicle-requests/feed': () => json(vehicleFeed([IN_WORK, OTHER])),
      [PREVIEW_ROUTE]: ({ params }) =>
        params.id === IN_WORK.id
          ? new Promise<MockResponse>((resolve) => {
              held.release = () => resolve(json(PREVIEW));
            })
          : json(OTHER_PREVIEW),
    });
    expect(await screen.findByText('Т-43')).toBeDefined();

    await openRowStatusMenu(0, 'Новая');
    expect(await screen.findByText('Выясняем, что снимет возврат')).toBeDefined();
    // Leaving stays possible while the answer is awaited: only the confirmation waits for it.
    clickButton('Не возвращать');
    await expectModalClosed('Возврат заявки в «Новую»');

    await openRowStatusMenu(1, 'Новая');
    expect(await screen.findByText('Место в рейсе Р-7 за 07.08.2026')).toBeDefined();
    held.release!();
    await waitFor(() => expect(http.countOf(PREVIEW_ROUTE)).toBe(2));
    // Let the held answer settle before asserting that it changed nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Место в рейсе Р-3 за 05.08.2026')).toBeNull();
    expect(screen.getByText('Место в рейсе Р-7 за 07.08.2026')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Причина возврата заявки № Т-43'), {
      target: { value: REASON },
    });
    submitRollbackModal();
    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    expect(http.lastCall(STATUS_ROUTE)?.path).toBe(`/vehicle-requests/${OTHER.id}/status`);
    expect(http.lastCall(STATUS_ROUTE)?.body).toMatchObject({
      version: OTHER.version,
      previewFingerprint: 'fp-other',
    });
  });

  it('отказ предпросмотра показан вместо перечня: вслепую не подтверждают', async () => {
    renderTab({
      [PREVIEW_ROUTE]: () =>
        apiError(500, { code: 'internal', message: 'Сервер не ответил', requestId: 'req-1' }),
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openStatusMenu('Новая');
    expect(await screen.findByText('Не удалось узнать, что снимет возврат')).toBeDefined();
    expect(screen.queryByText('Стирать у заявки нечего — сменится только статус.')).toBeNull();
  });

  it('без причины окно не отпускает: на сервер ничего не уходит', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();

    submitRollbackModal();
    expect(await screen.findByText('Укажите причину')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    // Spaces are not a reason: otherwise the field would be bypassed with the space bar, and the
    // status history would keep an empty line instead of why the work was erased.
    typeReason('   ');
    submitRollbackModal();
    await waitFor(() => expect(screen.getByText('Укажите причину')).toBeDefined());
    expect(http.countOf(STATUS_ROUTE)).toBe(0);
  });

  it('уходит один PATCH — с причиной, версией и отпечатком прочитанных последствий', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    await openRollbackWindow();

    // The reason is typed with extra spaces: it reaches the status history trimmed.
    typeReason(`  ${REASON}  `);
    submitRollbackModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    const call = http.lastCall(STATUS_ROUTE);
    // The address is the very request whose row opened the menu.
    expect(call?.path).toBe(`/vehicle-requests/${IN_WORK.id}/status`);
    expect(call?.body).toMatchObject({
      status: 'new',
      // The reason is mandatory and leaves with the status in one request: sent separately, it
      // would part from the status change at the server's first refusal.
      comment: REASON,
      // The version guards against a concurrent edit: without it the server could not tell the
      // return of "this" request from one taken into work meanwhile on another vehicle.
      version: IN_WORK.version,
      // The fingerprint is the consequences the person read. Changed between reading and clicking
      // without touching the version (a relocation got a waybill, a week became worked) — the door
      // refuses.
      previewFingerprint: PREVIEW.fingerprint,
    });
    // Removing the vehicle and erasing the fact is the server's job: the portal sends no second
    // request for them. Besides the status PATCH the dialog wrote exactly one POST — the preview
    // question, which changes nothing.
    expect(http.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(http.countOf(PREVIEW_ROUTE)).toBe(1);
    expect(http.calls.filter((c) => c.method !== 'GET')).toHaveLength(2);
  });

  it('устаревший отпечаток возвращает свежий перечень, а не тост «повторите»', async () => {
    let patches = 0;
    const http = renderTab({
      [PREVIEW_ROUTE]: () =>
        json(
          patches === 0
            ? PREVIEW
            : // The week ended while the person was reading: the sheet no longer burns, and that is
              // what they must confirm now.
              {
                ...PREVIEW,
                esm2: { cancelCount: 0, keepCount: 2, sheets: null },
                fingerprint: 'fp-2',
              },
        ),
      [STATUS_ROUTE]: ({ params, body }) => {
        patches += 1;
        if (patches === 1) {
          return apiError(409, {
            code: 'version_conflict',
            message: 'Данные изменились с момента просмотра: посмотрите заново',
          });
        }
        return json(
          approvedVehicleRequest({
            ...IN_WORK,
            id: params.id,
            status: (body as { status: 'new' }).status,
            assignment: null,
            completion: null,
            route: null,
            version: IN_WORK.version + 1,
          }),
        );
      },
    });
    expect(await screen.findByText('Т-42')).toBeDefined();
    await openRollbackWindow();

    typeReason();
    submitRollbackModal();

    // The dialog neither closed nor toasted: it asked the consequences again and said why.
    expect(await screen.findByText('Последствия пересчитаны')).toBeDefined();
    await waitFor(() => expect(http.countOf(PREVIEW_ROUTE)).toBe(2));
    // The old line about the burning sheet is gone: the list describes the new state, not the old.
    expect(screen.queryByText(/Аннулируются/)).toBeNull();
    expect(http.countOf(STATUS_ROUTE)).toBe(1);

    // The second click follows the re-read list: the new fingerprint leaves, the door lets it in.
    submitRollbackModal();
    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(2));
    expect(http.lastCall(STATUS_ROUTE)?.body).toMatchObject({ previewFingerprint: 'fp-2' });
    await expectModalClosed('Возврат заявки в «Новую»');
  });

  it('после возврата список перезапрашивается, а окно закрывается', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();
    expect(http.countOf('GET /vehicle-requests/feed')).toBe(1);

    await openRollbackWindow();
    typeReason();
    submitRollbackModal();

    // The list row must show the new status by itself: the refetch is the only thing taking care of
    // it, and the old status on screen would read as "the return failed".
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/feed')).toBe(2));
    await expectModalClosed('Возврат заявки в «Новую»');
  });

  it('на телефоне окно открывается тем же путём — из списка статусов снизу', async () => {
    const http = renderTab({}, true);
    expect(await screen.findByText('Т-42')).toBeDefined();

    // On a phone the transitions show as a bottom list, not a dropdown (ADR 0030): the "Новая" item
    // appears there by itself, and the reason dialog must open from here too — otherwise a return
    // from a phone would go without an explanation or not at all.
    fireEvent.click(screen.getByLabelText('Изменить статус'));
    clickButton('Новая');

    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
    expect(await screen.findByText('Место в рейсе Р-3 за 05.08.2026')).toBeDefined();
    expect(http.countOf(STATUS_ROUTE)).toBe(0);

    typeReason();
    submitRollbackModal();

    await waitFor(() => expect(http.countOf(STATUS_ROUTE)).toBe(1));
    expect(http.lastCall(STATUS_ROUTE)?.body).toMatchObject({
      status: 'new',
      comment: REASON,
      previewFingerprint: PREVIEW.fingerprint,
    });
  });
});
