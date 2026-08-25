import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { vehicleFeed, vehicleRequest, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Правка срока идёт своей дверью (волна 4a плана `docs/assignment-periods-plan.md`; Ж4, З5, Д2).
 *
 * До неё срок уезжал широким `PATCH /vehicle-requests/:id` вместе с комментарием и контактами, и
 * человек нажимал «Сохранить», не зная цены. Цена бывает двух родов, и оба проверяются здесь:
 *
 * - **бумага**: продление выписывает бланки строгой отчётности, сокращение их жжёт — окно обязано
 *   назвать номера до нажатия, а не показать их в журнале после;
 * - **история назначения** (Д2): за новым концом срока остаются решения о технике, и оставить их
 *   нельзя — при следующем продлении они ожили бы сами. Сервер их гасит и требует подтверждения
 *   перечня; без подтверждения он отвечает 422, поэтому окно спрашивает согласие галочкой.
 *
 * Проверяется и граница перевода (И5): у «Новой» заявки ни техники, ни бумаги, ни истории — её
 * срок до cutover ведёт широкий маршрут, и лишнего предпросмотра портал не заказывает.
 *
 * Даты считаются от сегодняшнего дня по МСК: календарь формы живёт относительно «сегодня», и
 * прибитая числом фикстура протухла бы вместе с ним.
 */

const TODAY = moscowDateKeyOf(new Date());
const day = (n: number) => shiftDateKey(TODAY, n);

/** Календарный ключ так, как его набирают в поле: `12.08.2026`. */
function typed(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** Заказ в работе на собственной машине: его продление и выписывает недельные листы. */
const WORKING = vehicleRequest({
  id: 'r-1',
  num: 601,
  displayNumber: 'ТС-601',
  status: 'confirmed',
  assignment: { vehicleId: 'v-1', ownership: 'own', typeName: 'Автокраны' },
  dateFrom: TODAY,
  dateTo: day(7),
} as never);

/** Закрытый заказ: его срок правкой сокращают — работающий сокращают досрочным завершением. */
const CLOSED = vehicleRequest({
  id: 'r-2',
  num: 602,
  displayNumber: 'ТС-602',
  status: 'done',
  assignment: { vehicleId: 'v-1', ownership: 'own', typeName: 'Автокраны' },
  dateFrom: TODAY,
  dateTo: day(10),
} as never);

/** «Новая»: техники нет, бумаги нет, истории нет — до cutover её срок ведёт широкий маршрут. */
const FRESH = vehicleRequest({
  id: 'r-3',
  num: 603,
  displayNumber: 'ТС-603',
  dateFrom: TODAY,
  dateTo: day(3),
});

/** Пустые последствия — то, что предпросмотр отвечает чаще всего; сценарий дополняет их своим. */
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

/** Продление: недельный лист выписывается, гасить нечего, объяснять нечего. */
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
 * Сокращение: лист за отрезанными днями сгорает, отработанный лист переоформляется, а за новым
 * концом срока остаётся решение о технике — его и гасит команда (Д2).
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

/** Ответ боевой ручки: состояние заявки после команды, а не отчёт о ней (Р9). */
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

function renderTab() {
  const http = mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1, confirmed: 1, done: 1 })),
    'GET /vehicle-requests/feed': () => json(vehicleFeed([WORKING, CLOSED, FRESH])),
    'GET /objects': () => json(list([{ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }])),
    'GET /departments': () => json(list([])),
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /vehicles': () => json(emptyList()),
    'GET /vehicle-requests/:id/shifts': () => json({ items: [], onDate: TODAY }),
    // Перегоны 4-П правятся в той же форме у заявки в работе (миграция 0082).
    'GET /vehicle-requests/:id/relocations': () => json([]),
    'POST /vehicle-requests/:id/period/preview': ({ params }) =>
      json(params.id === CLOSED.id ? SHORTEN_PREVIEW : EXTEND_PREVIEW),
    'PATCH /vehicle-requests/:id/period': ({ body }) => {
      const sent = body as { dateFrom?: string; dateTo?: string | null };
      return json(applied(sent.dateFrom ?? TODAY, sent.dateTo ?? null));
    },
    'PATCH /vehicle-requests/:id': ({ body }) => json({ ...WORKING, ...(body as object) }),
  });
  // Диспетчер: заказы ведёт и бумагу читает — предпросмотр двери живёт на `waybills.read`.
  renderWithUser(<VehicleRequestsTab />, { user: authUser() });
  return http;
}

async function openEdit(displayNumber: string): Promise<void> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
  await waitFor(() => expect(screen.getByText(`Заявка ${displayNumber}`)).toBeDefined());
}

/**
 * Набрать дату в поле формы: 0 — начало срока, 1 — окончание. Календарь в jsdom мышью не
 * открывается, а набранное antd принимает по Enter.
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

/** Кнопка по её подписи: окон на экране два — форма заявки и окно срока поверх неё. */
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Кнопка «${label}» не найдена`);
  return found;
}

/** Окно срока целиком: подтверждения ищутся в нём, а не среди полей формы заявки. */
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

    // Окно последствий встаёт до записи: пока человек не подтвердил, заявку не трогали.
    await waitFor(() => expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(1));
    await screen.findByText(/^Срок работ: заявка ТС-601$/);
    expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(0);
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);

    // Видно, что выпишется: лист, машина и человек, на которого он выйдет.
    expect(periodModal().textContent).toContain('Выпишется лист');
    expect(periodModal().textContent).toContain('КамАЗ Е646СК799');
    expect(periodModal().textContent).toContain('Иванов И. И.');
    // Гасить нечего — про погасшие записи о технике окно молчит.
    expect(periodModal().textContent).not.toContain('погаснут записи о технике');

    fireEvent.click(button('Изменить срок'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/period')).toBe(1));
    const sent = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as Record<
      string,
      unknown
    >;
    expect(sent.dateTo).toBe(day(14));
    expect(sent.version).toBe(WORKING.version);
    // Отпечаток — то, что человек видел: без него сервер отвечает «посмотрите последствия заново».
    expect(sent.previewFingerprint).toBe('fp-extend');
    // Гасить и разблокировать нечего — лишнее подтверждение сервер отвергает так же строго,
    // как недостающее.
    expect(sent.cancelGroupsFingerprint).toBeUndefined();
    expect(sent.unlockFingerprint).toBeUndefined();
    expect(sent.operation).toBeUndefined();

    // Остальное тело — второй командой, с версией, которую вернула дверь срока.
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    const rest = http.lastCall('PATCH /vehicle-requests/:id')!.body as Record<string, unknown>;
    expect(rest.version).toBe(7);
  });

  it('сокращение называет гасимые записи о технике и без подтверждения не уходит', async () => {
    const http = renderTab();
    await openEdit('ТС-602');

    typeDate(1, typed(day(3)));
    fireEvent.click(button('Сохранить'));

    await screen.findByText(/^Срок работ: заявка ТС-602$/);
    const text = () => periodModal().textContent ?? '';
    await waitFor(() => expect(text()).toContain('погаснут записи о технике'));

    // Сказано человеческим языком: что именно гаснет и почему это нельзя оставить как есть.
    expect(text()).toContain('Автокран КС-45717');
    expect(text()).toContain('ожили бы сами');
    // Бумага названа номерами: сгорающий лист и отработанный, который придётся переоформить.
    expect(text()).toContain('ЭСМ-2 № 9');
    expect(text()).toContain('ЭСМ-2 № 8');

    // Без галочки и причины команда до сети не доходит: сервер ответил бы 422, и кнопка,
    // которая всегда отказывает, — худший способ об этом сообщить.
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
    // Три подтверждения: последствия, перечень гасимых решений и отработанные листы под правку.
    expect(sent.cancelGroupsFingerprint).toBe('fp-groups');
    expect(sent.unlockFingerprint).toBe('fp-unlock');
    expect(sent.operation.reason).toBe('объект закрыл фронт работ раньше');
    // Ключ идемпотентности — uuid клиента: повтор после обрыва связи не жжёт второй номер.
    expect(sent.operation.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('у «Новой» заявки срок по-прежнему уходит широким маршрутом (И5)', async () => {
    const http = renderTab();
    await openEdit('ТС-603');

    typeDate(1, typed(day(5)));
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    const sent = http.lastCall('PATCH /vehicle-requests/:id')!.body as Record<string, unknown>;
    expect(sent.dateTo).toBe(day(5));
    // Ни техники, ни бумаги, ни истории — показывать в предпросмотре нечего, и портал его не
    // заказывает: старый путь остаётся рабочим до cutover.
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(0);
  });
});
