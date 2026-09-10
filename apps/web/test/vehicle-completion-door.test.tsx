import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { CompletionPreviewDto, SpecialEquipmentRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { dateInput, typeDate } from './antd';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { VehicleCompleteModal } from '../src/pages/vehicle/VehicleCompleteModal';

/**
 * Закрытие заказа техники **фактической датой** — окно и его дверь (ADR 0178, план
 * `docs/vehicle-request-actual-end-date-plan.md`, этап Э14).
 *
 * Проверяется то, что окно обещает и что уносит на сервер, а не вёрстка. Вопросов четыре, и цена
 * у каждого своя: каким днём открывается поле даты (Р2), считается ли отработанное по факту, идёт
 * ли закрытие в новую дверь с подтверждением показанного (Р1, Р17) — и не спрашивают ли дату у
 * арендодателя, которому её спрашивать нельзя (Р16).
 *
 * «Сегодня» приходит в окно пропом (`onDate`, ADR 0036) — его считает сервер по Москве, часы
 * браузера тут не годятся.
 */

/** Среда 12.08.2026: заказ брали по воскресенье 16-е, работы кончились сегодня. */
const TODAY = '2026-08-12';

/** Заказ, который закрывают: своя техника, в работе, срок 10–16.08 — ровно одна неделя ЭСМ-2. */
function inWork(overrides: Partial<SpecialEquipmentRequestDto> = {}): SpecialEquipmentRequestDto {
  return vehicleRequest({
    status: 'confirmed',
    dateFrom: '2026-08-10',
    dateTo: '2026-08-16',
    version: 7,
    assignment: {
      vehicleId: 'v-1',
      ownership: 'own',
      vehicleKindId: 'vk-special',
      vehicleTypeId: 'vt-1',
      typeName: 'Автокраны',
      vehicleCategoryId: 'vc-1',
      categoryName: 'г/п 25 т',
      categorySpecs: { lift_capacity: 25 },
      modelName: 'КС-45717',
      registrationNumber: 'А111АА77',
      description: '',
      lessorId: null,
      lessorName: null,
      pricePerHour: null,
      pricePerShift: 20000,
      shiftHours: null,
      assignedBy: 'user-1',
      assignedByName: 'Петров П. П.',
      assignedAt: '2026-08-10T06:00:00.000Z',
    },
    ...overrides,
  });
}

/**
 * Последствия, какими их считает сервер: неделя за фактом сгорает, часы четверга стираются, день
 * пятницы уходит из рейса, решение о технике с субботы гаснет. Числа выбраны разными нарочно —
 * так видно, что окно берёт каждое из своего поля ответа, а не пересказывает одно.
 */
const PREVIEW: CompletionPreviewDto = {
  plan: {
    cancel: [
      {
        waybillId: 'wb-2',
        displayNumber: 'ЭСМ-000124',
        from: '2026-08-17',
        to: '2026-08-23',
      },
    ],
    issue: [],
  },
  requiredAnchors: [],
  requiredVehicleResolution: null,
  blockedShiftDays: [],
  clearedShiftDays: [{ date: '2026-08-13', hours: 8 }],
  clearedShiftsFingerprint: 'fp-shifts',
  requiredUnlocks: [],
  unlockFingerprint: null,
  issues: [],
  operationRequirement: null,
  asOf: TODAY,
  fingerprint: 'fp-completion',
  completion: {
    endedOn: TODAY,
    previousDateTo: '2026-08-16',
    workedUnit: 'shifts',
    workedAmount: 3,
    rate: 20000,
    totalCost: 60000,
  },
  cancelGroups: [
    {
      changeGroupId: 'grp-1',
      rows: [
        {
          dimension: 'vehicle',
          origin: 'assignment',
          effectiveDate: '2026-08-15',
          vehicle: { vehicleId: 'v-2', name: 'В222ВВ77' },
          driver: null,
        },
      ],
    },
  ],
  cancelGroupsFingerprint: 'fp-groups',
  linearDays: { detachable: [{ date: '2026-08-14', routeNumber: 'Р-77' }], frozen: [] },
};

const COMPLETION_ROUTE = 'POST /vehicle-requests/vr-1/completion';
const PREVIEW_ROUTE = 'POST /vehicle-requests/vr-1/completion/preview';

function renderModal(
  request: SpecialEquipmentRequestDto,
  options: {
    preview?: CompletionPreviewDto;
    lessor?: boolean;
    onSubmit?: () => void;
    onCompleted?: () => void;
  } = {},
): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/vr-1/shifts': () => json({ onDate: TODAY, items: [] }),
    [PREVIEW_ROUTE]: () => json(options.preview ?? PREVIEW),
    [COMPLETION_ROUTE]: () =>
      json({
        version: request.version + 1,
        repeated: false,
        status: 'done',
        dateFrom: request.dateFrom,
        dateTo: TODAY,
        endedOn: TODAY,
        previousDateTo: '2026-08-16',
        esm2: { cancelled: ['ЭСМ-000124'], issued: [], trimmed: ['ЭСМ-000123'] },
        earlyEndDropped: false,
        clearedShiftDays: ['2026-08-13'],
        detachedDays: [{ date: '2026-08-14', routeNumber: 'Р-77' }],
        operationId: null,
      }),
  });
  renderWithUser(
    <VehicleCompleteModal
      request={request}
      onDate={TODAY}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={options.onSubmit ?? (() => {})}
      onCompleted={options.onCompleted ?? (() => {})}
    />,
    // Арендодатель узнаётся так же, как везде в портале: роль от контрагента плюс его тип.
    options.lessor
      ? { user: authUser({ role: 'operator', counterpartyType: 'vehicle_lessor' }) }
      : {},
  );
  return http;
}

/** Дойти до второго шага: попросить у сервера последствия закрытия. */
async function showConsequences(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Показать последствия' }));
  await screen.findByRole('button', { name: 'Выполнена' });
}

describe('фактическая дата закрытия', () => {
  it('открывается сегодняшним днём, а не концом срока', async () => {
    renderModal(inWork());

    // Р2: технику брали по воскресенье, работы кончились в среду — подставляется среда.
    await waitFor(() => expect(dateInput('Фактическое окончание работ').value).toBe('12.08.2026'));
    // Отработанное считается по **факту**, а не по заказанному сроку: 10–12 августа — три смены
    // (по заказанному их было бы семь). Поле показывает число с точностью до сотых — так его
    // рисует `InputNumber` со `precision={2}`.
    expect((await screen.findByLabelText('Отработано смен')).getAttribute('value')).toBe('3.00');
  });

  it('сдвиг даты пересчитывает отработанное', async () => {
    renderModal(inWork());
    await waitFor(() => expect(dateInput('Фактическое окончание работ').value).toBe('12.08.2026'));

    typeDate('Фактическое окончание работ', '11.08.2026');

    await waitFor(() =>
      expect(screen.getByLabelText('Отработано смен').getAttribute('value')).toBe('2.00'),
    );
  });

  /**
   * Границы считает контракт `completionEndBounds` — теми же их проверяет дверь, и предлагать дату,
   * которую она отклонит, портал не должен. Здесь проверяется верхняя: закрыть завтрашним днём
   * нельзя, потому что завтра ещё не наступило.
   */
  it('дату вне границ окно не принимает и на сервер её не несёт', async () => {
    const http = renderModal(inWork());
    await waitFor(() => expect(dateInput('Фактическое окончание работ').value).toBe('12.08.2026'));

    typeDate('Фактическое окончание работ', '13.08.2026');
    await showConsequences();

    expect(
      (http.lastCall(PREVIEW_ROUTE)?.body as { completion: { endedOn: string } }).completion
        .endedOn,
    ).toBe(TODAY);
  });
});

describe('закрытие идёт своей дверью', () => {
  it('последствия показываются по ответу сервера, а считать их порталу нечем', async () => {
    renderModal(inWork());
    await waitFor(() => expect(dateInput('Фактическое окончание работ').value).toBe('12.08.2026'));

    await showConsequences();

    expect(screen.getByText(/Сгорит № ЭСМ-000124/)).toBeDefined();
    expect(screen.getByText(/13\.08\.2026 — 8 ч/)).toBeDefined();
    expect(screen.getByText(/14\.08\.2026 — рейс Р-77/)).toBeDefined();
    expect(screen.getByText(/с 15\.08\.2026 — Техника: В222ВВ77/)).toBeDefined();
    // Правку листа предпросмотр числом не отдаёт (поля под неё в общем DTO ещё нет), поэтому окно
    // называет правило: номер бланка при сокращении остаётся жив.
    expect(screen.getByText(/будет сокращён по 12\.08\.2026/)).toBeDefined();
  });

  it('закрытие уходит в дверь и носит обратно все отпечатки', async () => {
    const onCompleted = vi.fn();
    const onSubmit = vi.fn();
    const http = renderModal(inWork(), { onCompleted, onSubmit });
    await waitFor(() => expect(dateInput('Фактическое окончание работ').value).toBe('12.08.2026'));
    await showConsequences();

    // Гашение подтверждается галочкой: без неё дверь отвечает 422, и просить её надо здесь.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));

    await waitFor(() => expect(http.countOf(COMPLETION_ROUTE)).toBe(1));
    expect(http.lastCall(COMPLETION_ROUTE)?.body).toEqual({
      version: 7,
      comment: '',
      completion: {
        workedUnit: 'shifts',
        workedAmount: 3,
        totalCost: 60000,
        endedOn: TODAY,
      },
      previewFingerprint: 'fp-completion',
      cancelGroupsFingerprint: 'fp-groups',
      clearedShiftsFingerprint: 'fp-shifts',
    });
    // Статусная ручка не зовётся вовсе: у заказа техники её «Выполнена» отвечает отказом.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(http.countOf('PATCH /vehicle-requests/vr-1/status')).toBe(0);
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
  });

  /**
   * Лишний отпечаток дверь отвергает так же строго, как недостающий: присутствие каждого задаёт
   * ответ сервера, а не желание клиента (Р28). Пустой план — тот случай, когда подтверждать нечего.
   */
  it('пустой план подтверждений не носит', async () => {
    const http = renderModal(inWork(), {
      preview: {
        ...PREVIEW,
        plan: { cancel: [], issue: [] },
        clearedShiftDays: [],
        clearedShiftsFingerprint: null,
        cancelGroups: [],
        cancelGroupsFingerprint: null,
        linearDays: { detachable: [], frozen: [] },
      },
    });
    await waitFor(() => expect(dateInput('Фактическое окончание работ').value).toBe('12.08.2026'));
    await showConsequences();

    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));

    await waitFor(() => expect(http.countOf(COMPLETION_ROUTE)).toBe(1));
    const body = http.lastCall(COMPLETION_ROUTE)?.body as Record<string, unknown>;
    expect(body.previewFingerprint).toBe('fp-completion');
    expect(body).not.toHaveProperty('cancelGroupsFingerprint');
    expect(body).not.toHaveProperty('clearedShiftsFingerprint');
  });
});

describe('арендодатель закрывает без даты', () => {
  /**
   * Р16, решение заказчика по В6: арендодатель закрывает заявку своим коридором — срок остаётся
   * плановым, бумага не трогается, последствий нет **по построению**. Значит, ни поля даты, ни
   * второго шага, ни отпечатков у него быть не должно: предпросмотр его ветви показал бы пустой
   * план, а присланный отпечаток дверь отвергла бы 422.
   */
  it('поля фактической даты нет, предпросмотр не зовётся, отпечатков нет', async () => {
    const http = renderModal(
      inWork({
        assignment: {
          ...inWork().assignment!,
          ownership: 'rental',
          lessorId: 'cp-1',
          lessorName: 'ООО «Арендатор»',
        },
      }),
      { lessor: true },
    );

    expect(await screen.findByLabelText('Отработано смен')).toBeDefined();
    expect(screen.queryByLabelText('Фактическое окончание работ')).toBeNull();
    // Кнопка сразу закрывающая: второго шага у этой ветви нет.
    expect(screen.queryByRole('button', { name: 'Показать последствия' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Стоимость, ₽'), { target: { value: '55000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));

    await waitFor(() => expect(http.countOf(COMPLETION_ROUTE)).toBe(1));
    expect(http.countOf(PREVIEW_ROUTE)).toBe(0);
    const body = http.lastCall(COMPLETION_ROUTE)?.body as {
      completion: Record<string, unknown>;
    } & Record<string, unknown>;
    expect(body.completion).not.toHaveProperty('endedOn');
    expect(body).not.toHaveProperty('previewFingerprint');
  });
});
