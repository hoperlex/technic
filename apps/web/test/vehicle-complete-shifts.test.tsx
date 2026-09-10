import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { CompletionPreviewDto, VehicleRequestShiftsDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { vehicleRequest } from './factories/vehicle';
import { VehicleCompleteModal } from '../src/pages/vehicle/VehicleCompleteModal';

/**
 * Закрытие заявки с неподтверждёнными сменами: заявку закрывают и тогда, когда объект расписался
 * не за все прошедшие дни. Раньше сервер такое закрытие отклонял; теперь оно проходит, но окно
 * закрытия обязано сказать, что принимает работу за площадку, — иначе неподписанные часы попадают
 * в факт молча, а сводка смен у закрытой заявки обнуляется, и заметить это уже негде.
 */

const request = vehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  dateFrom: '2026-08-03',
  dateTo: '2026-08-05',
  shifts: { approvedDays: 1, unapprovedPastDays: 2 },
});

function shift(date: string, approved: boolean) {
  return {
    date,
    startedAt: '08:00',
    endedAt: '20:00',
    machineHours: 11.5,
    refuel: '',
    comment: '',
    filledBy: 'user-2',
    filledByName: 'Петров П. П.',
    filledAt: `${date}T17:00:00.000Z`,
    approvedBy: approved ? 'user-3' : null,
    approvedByName: approved ? 'Сидоров С. С.' : null,
    approvedAt: approved ? `${date}T18:00:00.000Z` : null,
  };
}

const shifts: VehicleRequestShiftsDto = {
  onDate: '2026-08-05',
  items: [shift('2026-08-03', true), shift('2026-08-04', false), shift('2026-08-05', false)],
};

/**
 * Последствия закрытия, какими их считает сервер: у этой сцены бумаге тронуться не с чего — заказ
 * закрывают последним днём срока. Пустой план здесь и есть предмет проверки соседних сценариев:
 * долг по подписям закрытию не мешает, а плану — тем более.
 */
const preview: CompletionPreviewDto = {
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
  asOf: '2026-08-05',
  fingerprint: 'fp-completion',
  completion: {
    endedOn: '2026-08-05',
    previousDateTo: '2026-08-05',
    workedUnit: 'shifts',
    workedAmount: 3,
    rate: null,
    totalCost: null,
  },
  cancelGroups: [],
  cancelGroupsFingerprint: null,
  linearDays: { detachable: [], frozen: [] },
};

function renderModal(onSubmit = vi.fn()) {
  const http = mockHttp({
    'GET /vehicle-requests/vr-1/shifts': () => json(shifts),
    // Заказ техники на объект закрывается своей дверью (ADR 0178), и первым шагом окно идёт за
    // последствиями: без этого маршрута сценарий проверял бы не закрытие, а мок сети.
    'POST /vehicle-requests/vr-1/completion/preview': () => json(preview),
  });
  const view = renderWithUser(
    <VehicleCompleteModal
      request={request}
      onDate="2026-08-05"
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
      onCompleted={() => {}}
    />,
  );
  return { ...view, onSubmit, http };
}

describe('закрытие заявки без согласованных смен', () => {
  it('предупреждает и перечисляет дни без подписи объекта', async () => {
    renderModal();

    expect(
      await screen.findByText(/2 смены без согласования — заявка закрывается без подписи объекта/),
    ).toBeDefined();
    // Даты приходят таблицей смен: закрывающему важно, какие именно дни он принимает за площадку.
    expect(await screen.findByText('Без подписи: 04.08.2026, 05.08.2026')).toBeDefined();
  });

  it('закрытию не мешает: факт уходит с теми же полями', async () => {
    const { http } = renderModal();
    await screen.findByText(/2 смены без согласования/);

    fireEvent.click(screen.getByRole('button', { name: 'Показать последствия' }));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/vr-1/completion/preview')).toBe(1),
    );
    // Тело читается из журнала запросов: факт уходит целиком, вместе с фактической датой, и он же
    // потом подтверждается — отпечаток считается в том числе по количеству и сумме.
    const body = http.lastCall('POST /vehicle-requests/vr-1/completion/preview')?.body as {
      completion: { workedAmount: number; endedOn?: string };
    };
    expect(body.completion.workedAmount).toBeGreaterThan(0);
    expect(body.completion.endedOn).toBe('2026-08-05');
  });

  it('без долга по сменам предупреждения нет', async () => {
    mockHttp({
      'GET /vehicle-requests/vr-1/shifts': () =>
        json({ onDate: '2026-08-05', items: [shift('2026-08-03', true)] }),
    });
    renderWithUser(
      <VehicleCompleteModal
        request={vehicleRequest({
          id: 'vr-1',
          status: 'confirmed',
          shifts: { approvedDays: 1, unapprovedPastDays: 0 },
        })}
        onDate="2026-08-05"
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={() => {}}
        onCompleted={() => {}}
      />,
    );

    await screen.findByText('Выполнение заявки Т-42');
    expect(screen.queryByText(/без согласования/)).toBeNull();
  });
});
