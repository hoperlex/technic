import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { SpecialEquipmentRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { VehicleCompleteModal } from '../src/pages/vehicle/VehicleCompleteModal';

/**
 * The closing row of a rental (plan `docs/vehicle-rental-completion-documents-plan.md`, D1–D4):
 * shifts, actual hours and cost side by side, the average per shift live under the hours, the
 * delivery as an amount of its own. Driven through the lessor's branch — it sends at once, without
 * the preview step, so the body is what the row produced; the door itself is `vehicle-completion-door`.
 */

const TODAY = '2026-08-12';
const ROUTE = 'POST /vehicle-requests/vr-1/completion';

function rental(overrides: Partial<SpecialEquipmentRequestDto> = {}): SpecialEquipmentRequestDto {
  return vehicleRequest({
    status: 'confirmed',
    // Three ordered days: the shifts open on 3.
    dateFrom: '2026-08-10',
    dateTo: '2026-08-12',
    version: 4,
    assignment: {
      vehicleId: 'v-9',
      ownership: 'rental',
      vehicleKindId: 'vk-special',
      vehicleTypeId: 'vt-1',
      typeName: 'Автокраны',
      vehicleCategoryId: 'vc-1',
      categoryName: 'г/п 25 т',
      categorySpecs: { lift_capacity: 25 },
      modelName: '',
      registrationNumber: '',
      description: 'Автокран 25 т',
      lessorId: 'cp-1',
      lessorName: 'ООО «Арендатор»',
      pricePerHour: 1500,
      pricePerShift: 12000,
      shiftHours: 8,
      assignedBy: 'user-1',
      assignedByName: 'Петров П. П.',
      assignedAt: '2026-08-10T06:00:00.000Z',
    },
    ...overrides,
  });
}

function render(request: SpecialEquipmentRequestDto): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/vr-1/shifts': () => json({ onDate: TODAY, items: [] }),
    [ROUTE]: () =>
      json({
        version: request.version + 1,
        repeated: false,
        status: 'done',
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        endedOn: null,
        previousDateTo: null,
        esm2: { cancelled: [], issued: [], trimmed: [] },
        earlyEndDropped: false,
        clearedShiftDays: [],
        detachedDays: [],
        operationId: null,
      }),
  });
  renderWithUser(
    <VehicleCompleteModal
      request={request}
      onDate={TODAY}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={() => {}}
      onCompleted={() => {}}
    />,
    { user: authUser({ role: 'operator', counterpartyType: 'vehicle_lessor' }) },
  );
  return http;
}

function value(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

async function sent(http: HttpMock): Promise<Record<string, unknown>> {
  await waitFor(() => expect(http.countOf(ROUTE)).toBe(1));
  return (http.lastCall(ROUTE)?.body as { completion: Record<string, unknown> }).completion;
}

describe('rental closing row', () => {
  it('asks shifts and hours, shows the average per shift and bills the selected unit', async () => {
    const http = render(rental());
    await waitFor(() => expect(value('Отработано смен')).toBe('3.00'));
    expect(value('Стоимость, ₽')).toBe('36000.00');

    fireEvent.change(screen.getByLabelText('Фактически часов'), { target: { value: '26' } });
    // D2: the hours divided between the shifts, live.
    expect(await screen.findByText('по 8,7 ч на смену')).toBeDefined();
    // The other count does not move the cost: shifts are billed.
    expect(value('Стоимость, ₽')).toBe('36000.00');

    // Switched to hours: the same counts, the cost is now hours × the hourly rate.
    fireEvent.click(screen.getByText(/^Часами/));
    await waitFor(() => expect(value('Стоимость, ₽')).toBe('39000.00'));

    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));
    expect(await sent(http)).toMatchObject({
      workedUnit: 'hours',
      workedAmount: 26,
      workedHours: 26,
      workedShifts: 3,
      totalCost: 39000,
      deliveryCost: null,
    });
  });

  it('does not send without the hours', async () => {
    const http = render(rental());
    await waitFor(() => expect(value('Отработано смен')).toBe('3.00'));
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));
    expect(await screen.findByText('Укажите часы')).toBeDefined();
    expect(http.countOf(ROUTE)).toBe(0);
  });

  it('opens the delivery amount by the box and sends it apart from the cost', async () => {
    const http = render(rental());
    await waitFor(() => expect(value('Отработано смен')).toBe('3.00'));
    fireEvent.change(screen.getByLabelText('Фактически часов'), { target: { value: '24' } });
    expect(screen.queryByLabelText('Стоимость привоза/увоза, ₽')).toBeNull();

    fireEvent.click(screen.getByLabelText('Доставка на объект'));
    const field = await screen.findByLabelText('Стоимость привоза/увоза, ₽');
    // Ticked and empty: the closing waits for the amount.
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));
    expect(await screen.findByText('Укажите стоимость доставки')).toBeDefined();
    expect(http.countOf(ROUTE)).toBe(0);

    fireEvent.change(field, { target: { value: '12000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));
    expect(await sent(http)).toMatchObject({
      workedUnit: 'shifts',
      workedAmount: 3,
      totalCost: 36000,
      deliveryCost: 12000,
    });
  });

  it('reopens on the previous fact, delivery included', async () => {
    render(
      rental({
        completion: {
          workedUnit: 'shifts',
          workedAmount: 2,
          rate: 12000,
          totalCost: 30000,
          completedBy: 'user-1',
          completedByName: 'Петров П. П.',
          completedAt: '2026-08-11T15:00:00.000Z',
          endedOn: null,
          previousDateTo: null,
          workedHours: 19,
          workedShifts: 2,
          deliveryCost: 7000,
        },
      }),
    );
    await waitFor(() => expect(value('Отработано смен')).toBe('2.00'));
    expect(value('Фактически часов')).toBe('19.00');
    expect(value('Стоимость, ₽')).toBe('30000.00');
    expect(value('Стоимость привоза/увоза, ₽')).toBe('7000.00');
  });

  it('keeps the window of an own vehicle as it was', async () => {
    render(
      rental({
        assignment: {
          ...rental().assignment!,
          ownership: 'own',
          lessorId: null,
          lessorName: null,
        },
      }),
    );
    expect(await screen.findByLabelText('Отработано смен')).toBeDefined();
    expect(screen.queryByLabelText('Фактически часов')).toBeNull();
    expect(screen.queryByLabelText('Доставка на объект')).toBeNull();
  });
});
