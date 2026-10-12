import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { vehicleFeed, vehicleRequest, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Дата заявки задним числом в форме (ADR 0101, Р6 и Р15).
 *
 * Проверяется граница между «обычная правка» и «коррекция» — та самая, которую портал и сервер
 * обязаны проводить одинаково:
 *
 * - причина спрашивается ровно тогда, когда правка **двигает календарь в прошлое**, а не когда
 *   заявка просто вчерашняя: у вчерашнего заказа правят и телефон, и комментарий;
 * - без причины форма не отправляется вовсе — сервер такое тело отклонит, и предлагать нажать
 *   кнопку, которая всегда возвращает 422, портал не должен;
 * - вместе с причиной уходит ключ операции (Р31): по нему повтор после обрыва связи вернёт
 *   прежний результат, а не заведёт вторую правку;
 * - тому, у кого права на коррекцию нет, прошлое в календаре заперто — он и выбрать его не может.
 *
 * Since K3a (S-21 of 12.10.2026) the term of an on-site order edited by a journal reader moves
 * through its own door: the reason typed in the form travels there as the operation of the
 * correction journal, and the wide PATCH carries neither the term nor a second declaration of it.
 * (Only a «Новая» order of an account without the journal keeps the term in the wide PATCH, S-22.)
 *
 * Даты считаются от сегодняшнего дня по МСК, а не прибиты числами: правило живёт относительно
 * «сегодня», и фикстура с датой в коде протухла бы вместе с ним.
 */

const TODAY = moscowDateKeyOf(new Date());
const YESTERDAY = shiftDateKey(TODAY, -1);

/** Календарный ключ так, как его набирают в поле: `12.08.2026`. */
function typed(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** Заказ техники на объект, начинающийся сегодня: правка его срока и уводит дату в прошлое. */
const TODAY_REQUEST = vehicleRequest({
  id: 'r-1',
  num: 601,
  displayNumber: 'ТС-601',
  dateFrom: TODAY,
  dateTo: TODAY,
});

/** Тот же заказ, но уже вчерашний: его правят, не трогая календаря. */
const PAST_REQUEST = vehicleRequest({
  id: 'r-2',
  num: 602,
  displayNumber: 'ТС-602',
  dateFrom: YESTERDAY,
  dateTo: YESTERDAY,
});

/**
 * Заказ в работе на собственной машине — единственный, у которого портал ведёт недельные листы
 * ЭСМ-2 сам (`esm2Mode` → `auto`). Сдвиг его начала в прошедшую неделю сервер отклонит, и сказать
 * об этом форма обязана до нажатия.
 */
const IN_WORK_REQUEST = vehicleRequest({
  id: 'r-3',
  num: 603,
  displayNumber: 'ТС-603',
  status: 'confirmed',
  approvedBy: 'user-1',
  approvedByName: 'Руков Р. Р.',
  approvedAt: '2026-08-01T09:30:00.000Z',
  assignment: { vehicleId: 'v-1', ownership: 'own', typeName: 'Автокраны' },
  dateFrom: TODAY,
  dateTo: TODAY,
} as never);

/** Preview of a backdated move of a "new" order: no paper, no history, one journal operation. */
const BACKDATED_PREVIEW = {
  plan: { cancel: [], issue: [] },
  requiredAnchors: [],
  requiredVehicleResolution: null,
  blockedShiftDays: [],
  clearedShiftDays: [],
  clearedShiftsFingerprint: null,
  requiredUnlocks: [],
  unlockFingerprint: 'fp-unlock-empty',
  issues: [],
  operationRequirement: { kind: 'crew', reasonRequired: true, operationIdRequired: true },
  asOf: TODAY,
  fingerprint: 'fp-backdated',
  cancelGroups: [],
  cancelGroupsFingerprint: null,
};

function renderTab(role: 'dispatcher' | 'manager' = 'dispatcher') {
  const http = mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 2, confirmed: 1 })),
    'GET /vehicle-requests/feed': () =>
      json(vehicleFeed([TODAY_REQUEST, PAST_REQUEST, IN_WORK_REQUEST])),
    'GET /objects': () => json(list([{ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }])),
    'GET /departments': () => json(list([])),
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /vehicles': () => json(emptyList()),
    // Смены нужны подсказке о днях, уходящих за срок: у «Новой» заявки их не спрашивают вовсе,
    // но маршрут описан — незамоканный запрос портит журнал вызовов молчанием.
    'GET /vehicle-requests/:id/shifts': () => json({ items: [], onDate: TODAY }),
    // Перегоны 4-П правятся в той же форме у заявки в работе (миграция 0082): к заднему числу
    // отношения не имеют, но без ответа блок формы остался бы без данных.
    'GET /vehicle-requests/:id/relocations': () => json([]),
    'PATCH /vehicle-requests/:id': ({ body }) => json({ ...TODAY_REQUEST, ...(body as object) }),
    // The term door of a "new" order: nothing to show, but a backdated move goes to the correction
    // journal (R32), so the preview asks for an operation and the empty unlock set (D4).
    'POST /vehicle-requests/:id/period/preview': () => json(BACKDATED_PREVIEW),
    'PATCH /vehicle-requests/:id/period': ({ body }) =>
      json({
        version: 2,
        repeated: false,
        dateFrom: (body as { dateFrom: string }).dateFrom,
        dateTo: (body as { dateTo: string | null }).dateTo,
        esm2: { cancelled: [], issued: [] },
        earlyEndDropped: false,
        operationId: 'op-1',
        history: { state: 'empty', validatedOn: null, dirty: false, changes: [], people: [] },
      }),
  });
  // Диспетчер — у него есть `waybills.correct`: прошлое ему открыто на тридцать дней (Р37).
  renderWithUser(<VehicleRequestsTab />, { user: authUser({ role }) });
  return http;
}

/** Row and card share the editor; its synchronous title does not mean lazy fields are ready. */
async function openEdit(displayNumber: string): Promise<void> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
  await waitFor(() => expect(screen.getByText(`Заявка ${displayNumber}`)).toBeDefined());
  await screen.findByLabelText('Дата начала');
}

/**
 * Набрать дату в поле формы. Календарь в jsdom мышью не открывается, а набранное antd принимает
 * по Enter — тем же приёмом вводят период в журнале действий.
 */
function typeDate(index: number, value: string): void {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>('.ant-modal .ant-picker-input input'),
  ];
  const input = inputs[index]!;
  fireEvent.mouseDown(input);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
}

function submit(): void {
  fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary')!);
}

function reasonField(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.ant-modal textarea#backdateReason');
}

describe('дата заявки задним числом в форме', () => {
  it('сдвиг срока в прошлое спрашивает причину и уходит с ключом операции', async () => {
    const http = renderTab();
    await openEdit('ТС-601');
    expect(reasonField(), 'у сегодняшней заявки объяснять нечего').toBeNull();

    typeDate(0, typed(YESTERDAY));
    await waitFor(() => expect(reasonField()).not.toBeNull());

    // Без причины форма до сети не доходит: сервер ответил бы 422, и кнопка, которая всегда
    // отказывает, — худший способ об этом сообщить.
    submit();
    await waitFor(() => expect(screen.getByText('Укажите причину')).toBeDefined());
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);

    fireEvent.change(reasonField()!, { target: { value: 'техника вышла вчера' } });
    submit();
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));

    // The term goes through its door: the reason from the form becomes the journal operation, with
    // the client's uuid as the key (R31) — without it the server would not take the past day.
    const term = http.lastCall('PATCH /vehicle-requests/:id/period')!.body as {
      dateFrom: string;
      previewFingerprint: string;
      unlockFingerprint: string;
      operation: { operationId: string; reason: string };
    };
    expect(term.dateFrom).toBe(YESTERDAY);
    expect(term.previewFingerprint).toBe('fp-backdated');
    expect(term.unlockFingerprint).toBe('fp-unlock-empty');
    expect(term.operation.reason).toBe('техника вышла вчера');
    expect(term.operation.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

    // The rest carries neither the term nor a second declaration: the door has the reason already.
    const body = http.lastCall('PATCH /vehicle-requests/:id')!.body as Record<string, unknown>;
    expect('dateFrom' in body).toBe(false);
    expect(body.backdateReason).toBeUndefined();
    expect(body.operationId).toBeUndefined();
    expect(body.version).toBe(2);
  });

  it('правка вчерашней заявки, не трогающая календарь, причины не требует (Р29)', async () => {
    const http = renderTab();
    await openEdit('ТС-602');
    // Заявка вчерашняя, но её срок остаётся прежним: правится комментарий. Спрашивать здесь
    // право на коррекцию значило бы запереть обычную дневную работу с любой заявкой старше суток.
    expect(reasonField()).toBeNull();

    const comment = document.querySelector<HTMLTextAreaElement>('.ant-modal textarea#comment')!;
    fireEvent.change(comment, { target: { value: 'уточнили место работ' } });
    submit();
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));

    const body = http.lastCall('PATCH /vehicle-requests/:id')!.body as Record<string, unknown>;
    expect(body.comment).toBe('уточнили место работ');
    // Ни причины, ни ключа: обычная правка операцией коррекции не является, и запись в журнале
    // правок бланков ей не положена.
    expect(body.backdateReason).toBeUndefined();
    expect(body.operationId).toBeUndefined();
  });

  it('сдвиг в отработанную неделю назван до нажатия — сервер такую правку отклонит', async () => {
    renderTab();
    await openEdit('ТС-603');

    // Воскресенье прошлой недели: неделя кончилась при любом сегодняшнем дне недели, а лист за
    // неё сверка не выпишет — заявка осталась бы без бумаги на эти дни (Р21).
    typeDate(0, typed(shiftDateKey(weekStartKey(TODAY), -1)));
    await waitFor(() => expect(reasonField()).not.toBeNull());
    expect(screen.getByText(/ЭСМ-2/)).toBeDefined();
  });

  it('без права на коррекцию прошлое в календаре не выбирается', async () => {
    // Менеджер заказы ведёт (заблаговременность его не касается), но `waybills.correct` у него
    // нет — прошлое закрыто целиком, и форма даже не доходит до вопроса о причине.
    const http = renderTab('manager');
    await openEdit('ТС-601');

    typeDate(0, typed(YESTERDAY));
    // Набранное поле не приняло: запертый день значением формы не становится, поэтому и блока
    // причины нет — спрашивать объяснение за дату, которую нельзя выбрать, было бы издевательством.
    expect(reasonField()).toBeNull();
    submit();
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    // The term stayed as it was: the door is not asked, and the wide PATCH carries no term (K3a).
    expect(http.countOf('POST /vehicle-requests/:id/period/preview')).toBe(0);
    const body = http.lastCall('PATCH /vehicle-requests/:id')!.body as Record<string, unknown>;
    expect('dateFrom' in body).toBe(false);
    expect(body.backdateReason).toBeUndefined();
  });
});
