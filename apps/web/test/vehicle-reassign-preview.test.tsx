import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleDto } from '@technic/contracts';
import { apiError, json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { assignmentPreview, machinist, vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '@widgets/vehicle-assignment-dialog';

/**
 * Последствия смены техники — вторым шагом окна (волна 4a плана `docs/assignment-periods-plan.md`).
 *
 * До этой волны диспетчер узнавал цену действия постфактум: какие номера ЭСМ-2 сгорели, какие
 * подписи объекта слетели, за какие дни в истории не осталось машиниста. Сервер считает это заранее
 * — тем же расчётом, который потом отработает, — и окно обязано довести посчитанное до человека
 * **до** нажатия, а не после.
 *
 * Отсюда предмет проверок:
 *
 * - последствия видны и названы поимённо: номер, состав выписываемого листа, дни с часами, пробелы;
 * - без просмотра команда не уходит: первое нажатие спрашивает сервер, а не меняет технику;
 * - отпечаток уезжает с подтверждением — им сервер сверяет под блокировками, что обещанное верно;
 * - 409 «последствия изменились» — не ошибка, а вопрос: окно пересчитывает перечень и объясняет,
 *   почему вернуло человека назад;
 * - сегодняшний путь цел: сервер старее портала — команда идёт по-старому, без отпечатка, а смена
 *   без последствий не удлиняется вторым экраном.
 */

const CRANE: VehicleDto = {
  id: 'v-1',
  ownership: 'own',
  vehicleKindId: 'vk-special',
  kindName: 'Спецтехника',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  waybillFormCode: '4p',
  vehicleCategoryId: 'vc-1',
  categoryName: 'Автокраны, г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  vehicleModelId: 'm-1',
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Е646СК799',
  passportNumber: null,
  lessorId: null,
  lessorName: null,
  lessorIsActive: null,
  deactivatedWithLessor: false,
  description: '',
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  status: 'active',
  note: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const OTHER_CRANE: VehicleDto = {
  ...CRANE,
  id: 'v-2',
  modelName: 'Liebherr LTM 1130',
  registrationNumber: 'Х001ХХ199',
};

/** Заявка в работе: только у такой технику и меняют. */
const REQUEST = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: '2026-08-10',
  dateTo: '2026-08-30',
  assignment: {
    vehicleId: CRANE.id,
    ownership: 'own',
    vehicleKindId: CRANE.vehicleKindId,
    vehicleTypeId: CRANE.vehicleTypeId,
    typeName: CRANE.typeName,
    vehicleCategoryId: CRANE.vehicleCategoryId,
    categoryName: CRANE.categoryName,
    categorySpecs: CRANE.categorySpecs,
    modelName: CRANE.modelName,
    registrationNumber: CRANE.registrationNumber,
    description: '',
    lessorId: null,
    lessorName: null,
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-01T10:00:00.000Z',
  },
});

/** Полный набор последствий: сгорающий номер, выписываемый лист с составом, подписи и пробел. */
const LOUD = assignmentPreview({
  plan: {
    cancel: [
      {
        waybillId: 'wb-1',
        displayNumber: '260604-646-00000004897',
        from: '2026-08-10',
        to: '2026-08-16',
      },
    ],
    issue: [
      {
        issueKey: 0,
        from: '2026-08-10',
        to: '2026-08-16',
        vehicleId: OTHER_CRANE.id,
        vehicleName: 'Liebherr LTM 1130 Х001ХХ199',
        driverPersonId: 'p-kuznetsov',
        driverName: 'Кузнецов К. К.',
      },
    ],
  },
  clearedShiftDays: [
    { date: '2026-08-12', hours: 8 },
    { date: '2026-08-13', hours: 7.5 },
  ],
  clearedShiftsFingerprint: 'fp-shifts',
  requiredAnchors: [
    {
      requestId: REQUEST.id,
      requestNumber: REQUEST.displayNumber,
      effectiveDate: '2026-08-10',
      from: '2026-08-10',
      to: '2026-08-11',
    },
  ],
  fingerprint: 'fp-loud',
});

/** Отказ рукопожатия: между просмотром и нажатием план изменился (Р32). */
const STALE = {
  code: 'assignment_preview_stale',
  message: 'Последствия изменились с момента предпросмотра — посмотрите их заново и подтвердите',
  status: 409,
};

function renderModal(
  options: {
    preview?: ReturnType<typeof assignmentPreview>;
    /** Ответ ручки предпросмотра целиком: им подменяют старый сервер (404). */
    previewResponse?: () => ReturnType<typeof json>;
    /*
     * Тип мока сужен до сигнатуры пропса: `ReturnType<typeof vi.fn>` описывает произвольную
     * функцию-заглушку, и `tsc` не признаёт её совместимой с `onSubmit` окна. Приведение здесь не
     * «чтобы замолчало»: сцена и правда передаёт заглушку в место, где ждут конкретный вызов, и
     * тип обязан это отражать — иначе тест перестанет ловить смену сигнатуры пропса.
     */
    onSubmit?: ComponentProps<typeof VehicleAssignModal>['onSubmit'];
  } = {},
) {
  const onSubmit =
    options.onSubmit ?? (vi.fn() as ComponentProps<typeof VehicleAssignModal>['onSubmit']);
  const http = mockHttp({
    'GET /vehicles': () => json(list([CRANE, OTHER_CRANE])),
    'GET /drivers': () => json(list([machinist()])),
    'GET /vehicle-requests/:id/waybills': () => json([]),
    'POST /vehicle-requests/:id/assignment/preview':
      options.previewResponse ?? (() => json(options.preview ?? assignmentPreview())),
  });
  renderWithUser(
    <VehicleAssignModal
      request={REQUEST}
      mode="reassign"
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return { http, onSubmit };
}

/** A cold fallback cannot submit; wait for the actual assignment form before asking the preview. */
async function pressChange(): Promise<void> {
  await screen.findByLabelText('Машинист');
  fireEvent.click(screen.getByRole('button', { name: 'Сменить технику' }));
}

/**
 * Тело последней отправки: назначение, блок коррекции и отпечаток последствий.
 *
 * Аргумент типизирован как проп окна, а к журналу вызовов обращение идёт через `vi.mocked`: тип
 * `Mock` и сигнатура пропса несовместимы напрямую, а расширять тип пропса до «любой заглушки»
 * значило бы перестать ловить смену его сигнатуры — ради чего тест и написан.
 */
function payloadOf(onSubmit: ComponentProps<typeof VehicleAssignModal>['onSubmit']): {
  previewFingerprint?: string;
} {
  return vi.mocked(onSubmit).mock.calls.at(-1)![0] as { previewFingerprint?: string };
}

describe('последствия смены техники', () => {
  it('первое нажатие показывает цену действия, а технику не меняет', async () => {
    const { onSubmit } = renderModal({ preview: LOUD });
    await pressChange();

    // Бумага: что сгорит — номером, что выпишется — вместе с составом. Одних границ недели мало:
    // «выпишется лист за 10–16 августа» не отвечает на вопрос, чьей машиной и чьей фамилией.
    await screen.findByText(/Сгорит № 260604-646-00000004897 за 10\.08\.2026 — 16\.08\.2026/);
    await screen.findByText(
      /Выпишется лист за 10\.08\.2026 — 16\.08\.2026: Liebherr LTM 1130 Х001ХХ199, машинист Кузнецов К\. К\./,
    );

    // Подписи объекта: дни с часами и сумма — цена подтверждения должна быть видна, а не
    // подразумеваться.
    await screen.findByText('12.08.2026 — 8 ч');
    await screen.findByText('13.08.2026 — 7,5 ч');
    await screen.findByText('Всего дней: 2 · 15,5 ч');

    // Пробел машиниста: смене техники он не мешает, но за такие дни лист выписать нечем.
    await screen.findByText(/10\.08\.2026 — 11\.08\.2026 · заявка/);

    // И главное: команда не ушла. Человек читает последствия, а не узнаёт о них постфактум.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('подтверждение уносит отпечаток последствий', async () => {
    const { onSubmit } = renderModal({ preview: LOUD });
    await pressChange();
    await screen.findByText(/Сгорит № 260604-646-00000004897/);

    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // Тем же отпечатком сервер сверяет под блокировками, что обещанное человеку ещё верно.
    expect(payloadOf(onSubmit).previewFingerprint).toBe('fp-loud');
  });

  it('говорить не о чем — команда уходит сразу, но с отпечатком', async () => {
    const { onSubmit, http } = renderModal();
    await pressChange();

    // Второго экрана нет: пустое «ничего не произойдёт, нажмите ещё раз» приучает нажимать не
    // читая, и тогда экран не работает в тот единственный раз, когда сказать ему есть что.
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(http.countOf('POST /vehicle-requests/:id/assignment/preview')).toBe(1);
    expect(payloadOf(onSubmit).previewFingerprint).toBe('fp-preview');
  });

  it('последствия устарели — окно переспрашивает и объясняет, почему вернуло назад', async () => {
    // Первая отправка отбита рукопожатием, вторая проходит: между просмотром и нажатием план
    // изменился, не тронув заявку вовсе.
    const onSubmit = vi.fn().mockRejectedValueOnce(STALE).mockResolvedValue(undefined);
    const { http } = renderModal({ preview: LOUD, onSubmit });
    await pressChange();
    await screen.findByText(/Сгорит № 260604-646-00000004897/);
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));

    // Не тост и не «unlockFingerprint не совпал», а пересчитанный перечень с объяснением.
    await screen.findByText('Последствия пересчитаны');
    await screen.findByText(/Последствия изменились с того момента, как вы их смотрели/);
    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/:id/assignment/preview')).toBe(2),
    );

    // Круг замкнут нажатием, а не сам собой: повторить команду за спиной у человека окно не вправе.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it('сервер старее портала — смена техники идёт по-старому, без отпечатка', async () => {
    // Выкат портала и сервера не обязан быть одномоментным: ручки предпросмотра ещё нет, отпечатка
    // сервер не спрашивает, и работа не должна вставать до следующего релиза.
    const { onSubmit } = renderModal({
      previewResponse: () => apiError(404, { code: 'not_found', message: 'Not Found' }),
    });
    await pressChange();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(payloadOf(onSubmit).previewFingerprint).toBeUndefined();
  });

  it('подписанные дни запирают команду: кнопка гаснет, причина названа', async () => {
    const { onSubmit } = renderModal({
      preview: assignmentPreview({ blockedShiftDays: [{ date: '2026-08-12', hours: 8 }] }),
    });
    await pressChange();

    await screen.findByText('Сменить технику нельзя: дни уже подписаны объектом');
    // Выход назван прямо: подпись снимает не смена техники, а коррекция задним числом.
    await screen.findByText(/Снять её можно только коррекцией/);
    const confirm = screen.getByRole('button', { name: 'Подтвердить смену' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/**
 * Warned sheets of a vehicle change (B4, defect N1 of the repair wave). In `history` the door
 * issues the blanks itself and refuses a warned one nobody confirmed — 409 `waybill_ack_required`;
 * the window used to send no signature, so such a change ended in a toast.
 */
describe('смена техники: предупреждения по выписываемым листам', () => {
  const warning = (gap: 'snils' | 'license', message: string) => ({
    facts: { code: 'driver_documents' as const, personId: 'p-kuznetsov', gaps: [gap] },
    message,
    entities: ['Кузнецов К. К.'],
  });
  const SNILS = warning('snils', 'У машиниста Кузнецов К. К. нет СНИЛС');
  const LICENSE = warning('license', 'У машиниста Кузнецов К. К. нет удостоверения');
  const warned = (w: typeof SNILS, fingerprint: string) =>
    assignmentPreview({
      ...LOUD,
      issues: [{ issueKey: 0, warnings: [w], warningFingerprint: fingerprint }],
    });
  const TICK = /Согласен: листы выпишутся с перечисленными предупреждениями/;
  const payload = (onSubmit: ComponentProps<typeof VehicleAssignModal>['onSubmit'], call = -1) =>
    vi.mocked(onSubmit).mock.calls.at(call)![0];

  it('показывает лист с предупреждением и шлёт подпись только после галочки', async () => {
    const { onSubmit } = renderModal({ preview: warned(SNILS, 'fp-warn-1') });
    await pressChange();

    await screen.findByText('Листы выпишутся с предупреждениями');
    expect(
      screen.getByText(
        'Лист за 10.08.2026 — 16.08.2026: Liebherr LTM 1130 Х001ХХ199, машинист Кузнецов К. К.',
      ),
    ).toBeDefined();
    expect(screen.getByText(SNILS.message)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));
    await screen.findByText('Подтвердите предупреждения по листам');
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: TICK }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(payload(onSubmit).acknowledgements).toEqual({ '0': 'fp-warn-1' });
    expect(payload(onSubmit).previewFingerprint).toBe('fp-loud');
  });

  it('без предупреждений не спрашивает галочки и подписей не шлёт', async () => {
    const { onSubmit } = renderModal({ preview: LOUD });
    await pressChange();
    await screen.findByText(/Сгорит № 260604-646-00000004897/);
    expect(screen.queryByText('Листы выпишутся с предупреждениями')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(payload(onSubmit)).not.toHaveProperty('acknowledgements');
  });

  it('409 «предупреждения изменились» — перезапрос последствий и новая галочка', async () => {
    const refusal = {
      code: 'waybill_ack_required',
      status: 409,
      message: 'Выписка требует подтверждения: предупреждения по 1 листу(ам) ЭСМ-2 изменились',
      details: { issues: warned(LICENSE, 'fp-warn-2').issues },
    };
    const onSubmit = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue(undefined);
    let previews = 0;
    const { http } = renderModal({
      onSubmit,
      previewResponse: () => {
        previews += 1;
        return json(previews === 1 ? warned(SNILS, 'fp-warn-1') : warned(LICENSE, 'fp-warn-2'));
      },
    });
    await pressChange();
    fireEvent.click(await screen.findByRole('checkbox', { name: TICK }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));

    await screen.findByText(LICENSE.message);
    expect(http.countOf('POST /vehicle-requests/:id/assignment/preview')).toBe(2);
    expect(screen.getByText(/Предупреждения по листам изменились/)).toBeDefined();
    expect(screen.getByRole('checkbox', { name: TICK })).toHaveProperty('checked', false);
    // The round is closed by a press, not by itself.
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox', { name: TICK }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить смену' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(payload(onSubmit).acknowledgements).toEqual({ '0': 'fp-warn-2' });
  });
});
