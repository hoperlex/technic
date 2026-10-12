import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  SHIFT_IDLE_COMMENT_MESSAGE,
  type VehicleRequestShiftDto,
  type VehicleRequestShiftsDto,
} from '@technic/contracts';
import { apiError, json, mockHttp } from './http';
import { renderWithUser } from './render';
import { vehicleRequest } from './factories/vehicle';
import { VehicleShiftsModal } from '../src/pages/vehicle/VehicleShiftsModal';

/**
 * The shift window of the "On site" tab (ADR 0184, decision 13): where a site keeps the hours of
 * each day and the object signs them. Until now it was checked by hand only.
 *
 * What the window must hold, because the server refuses otherwise and the person would meet a 422
 * instead of an inactive control:
 *
 * - **a future day is shown but inactive**, explained by the server's own words (`shiftDayBlocker`):
 *   a shift is written by the fact, and the day of the cut is the server's `onDate`, not the
 *   browser's clock — the scene's `onDate` is fixed, the system time is not touched;
 * - **a signed day is read-only** until the sign-off is taken back, and it cannot be deleted;
 * - **zero machine-hours ask for a reason**: the comment names it as its hint, and the server's
 *   refusal reaches the person readably;
 * - **a sign-off needs a filled day and the right**: an empty day has nothing to sign;
 * - **the bodies are the server's contract**: the day is in the address, the values in the body.
 *
 * The data comes through the HTTP mock, so the test holds to the contract of the shift handlers,
 * not to the module the portal calls them through today.
 */

const ON_DATE = '2026-08-05';

const request = vehicleRequest({
  id: 'r1',
  displayNumber: 'Т-42',
  status: 'confirmed',
  dateFrom: '2026-08-03',
  dateTo: '2026-08-06',
  shifts: { approvedDays: 1, approvedDaysWithoutRoute: 1, unapprovedPastDays: 2 },
});

function shift(date: string, over: Partial<VehicleRequestShiftDto> = {}): VehicleRequestShiftDto {
  return {
    date,
    startedAt: null,
    endedAt: null,
    machineHours: 0,
    refuel: '',
    comment: '',
    filledBy: null,
    filledByName: null,
    filledAt: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    ...over,
  };
}

const filled = {
  filledBy: 'user-2',
  filledByName: 'Петров П. П.',
  filledAt: '2026-08-04T17:00:00.000Z',
};

/** Four days of the term: signed, filled without a sign-off, today empty, tomorrow. */
const shifts: VehicleRequestShiftsDto = {
  onDate: ON_DATE,
  items: [
    shift('2026-08-03', {
      ...filled,
      startedAt: '08:00',
      endedAt: '20:00',
      machineHours: 8,
      refuel: '120 л',
      approvedBy: 'user-3',
      approvedByName: 'Сидоров С. С.',
      approvedAt: '2026-08-03T18:00:00.000Z',
    }),
    shift('2026-08-04', { ...filled, machineHours: 0, comment: 'дождь, простой' }),
    shift(ON_DATE),
    shift('2026-08-06'),
  ],
};

function renderWindow(props: { canEdit?: boolean; canApprove?: boolean } = {}) {
  const http = mockHttp({
    'GET /vehicle-requests/r1/shifts': () => json(shifts),
    'PUT /vehicle-requests/r1/shifts/:date': () => json(shifts),
    'DELETE /vehicle-requests/r1/shifts/:date': () => json(shifts),
    'POST /vehicle-requests/r1/shifts/:date/approval': () => json(shifts),
  });
  renderWithUser(
    <VehicleShiftsModal
      request={request}
      canEdit={props.canEdit ?? true}
      canApprove={props.canApprove ?? true}
      onClose={() => {}}
    />,
  );
  return http;
}

/** The table row of a day, found by the date the person reads in its first cell. */
async function rowOf(date: string): Promise<HTMLElement> {
  const [y, m, d] = date.split('-');
  const cell = await screen.findByText(`${d}.${m}.${y}`);
  return cell.closest('tr')!;
}

const isDisabled = (el: HTMLElement) => (el as HTMLInputElement).disabled;

describe('окно смен на вкладке «На объекте»', () => {
  it('a future day is shown but inactive, explained by the server rule', async () => {
    renderWindow();

    const tomorrow = await rowOf('2026-08-06');
    expect(
      within(tomorrow).getByText('День ещё не наступил — смену подтверждают по факту'),
    ).toBeDefined();
    expect(isDisabled(within(tomorrow).getByRole('spinbutton'))).toBe(true);
    for (const input of within(tomorrow).getAllByRole('textbox')) {
      expect(isDisabled(input)).toBe(true);
    }
    expect(isDisabled(within(tomorrow).getByRole('checkbox'))).toBe(true);
    expect(within(tomorrow).queryByTitle('Сохранить смену')).toBeNull();

    // Today is a day like any past one: it is kept by the fact of the evening.
    const today = await rowOf(ON_DATE);
    expect(isDisabled(within(today).getByRole('spinbutton'))).toBe(false);

    // The header counts the term's days, signed or not, and the accepted hours only.
    expect(screen.getByText('согласовано 1 из 4')).toBeDefined();
    expect(screen.getByText('принято 8 ч')).toBeDefined();
  });

  it('a signed day is read-only and cannot be deleted; its sign-off is taken back by the checkbox', async () => {
    const http = renderWindow();

    const signed = await rowOf('2026-08-03');
    expect(isDisabled(within(signed).getByRole('spinbutton'))).toBe(true);
    expect(within(signed).getByText('Сидоров С. С.')).toBeDefined();
    expect(within(signed).queryByTitle('Удалить смену')).toBeNull();
    expect(within(signed).queryByTitle('Сохранить смену')).toBeNull();

    const box = within(signed).getByRole('checkbox');
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() =>
      expect(http.lastCall('POST /vehicle-requests/r1/shifts/:date/approval')?.path).toBe(
        '/vehicle-requests/r1/shifts/2026-08-03/approval',
      ),
    );
    expect(http.lastCall('POST /vehicle-requests/r1/shifts/:date/approval')?.body).toEqual({
      approved: false,
    });
    expect(await screen.findByText('Согласование снято')).toBeDefined();
  });

  it('a filled day is signed; an empty day has nothing to sign', async () => {
    const http = renderWindow();

    const empty = await rowOf(ON_DATE);
    expect(isDisabled(within(empty).getByRole('checkbox'))).toBe(true);

    const unsigned = await rowOf('2026-08-04');
    fireEvent.click(within(unsigned).getByRole('checkbox'));
    await waitFor(() =>
      expect(http.lastCall('POST /vehicle-requests/r1/shifts/:date/approval')?.body).toEqual({
        approved: true,
      }),
    );
    expect(http.lastCall('POST /vehicle-requests/r1/shifts/:date/approval')?.path).toBe(
      '/vehicle-requests/r1/shifts/2026-08-04/approval',
    );
    expect(await screen.findByText('Смена согласована')).toBeDefined();
  });

  it('a day is saved with the typed values: the day in the address, the values in the body', async () => {
    const http = renderWindow();

    const today = await rowOf(ON_DATE);
    const save = within(today).getByTitle('Сохранить смену').closest('button')!;
    // Nothing typed — nothing to save.
    expect(save.disabled).toBe(true);

    const [start, end, refuel] = within(today).getAllByRole('textbox');
    fireEvent.change(start!, { target: { value: '08:00' } });
    fireEvent.blur(start!);
    fireEvent.change(end!, { target: { value: '19:30' } });
    fireEvent.blur(end!);
    const hours = within(today).getByRole('spinbutton');
    fireEvent.change(hours, { target: { value: '10.5' } });
    fireEvent.blur(hours);
    fireEvent.change(refuel!, { target: { value: '80 л' } });

    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(http.lastCall('PUT /vehicle-requests/r1/shifts/:date')?.path).toBe(
        `/vehicle-requests/r1/shifts/${ON_DATE}`,
      ),
    );
    expect(http.lastCall('PUT /vehicle-requests/r1/shifts/:date')?.body).toEqual({
      startedAt: '08:00',
      endedAt: '19:30',
      machineHours: 10.5,
      refuel: '80 л',
      comment: '',
    });
    expect(await screen.findByText('Смена за 05.08.2026 сохранена')).toBeDefined();
  });

  it('zero machine-hours ask for a reason: the hint names it, the refusal reaches the person', async () => {
    const http = renderWindow();
    http.use({
      'PUT /vehicle-requests/r1/shifts/:date': () =>
        apiError(400, {
          code: 'validation_error',
          message: 'Ошибка валидации',
          fields: { comment: SHIFT_IDLE_COMMENT_MESSAGE },
        }),
    });

    const today = await rowOf(ON_DATE);
    const hours = within(today).getByRole('spinbutton');
    fireEvent.change(hours, { target: { value: '0' } });
    fireEvent.blur(hours);
    expect(within(today).getByPlaceholderText(SHIFT_IDLE_COMMENT_MESSAGE)).toBeDefined();

    fireEvent.click(within(today).getByTitle('Сохранить смену').closest('button')!);
    expect(await screen.findByText('Ошибка валидации: Комментарий')).toBeDefined();
    expect(http.lastCall('PUT /vehicle-requests/r1/shifts/:date')?.body).toMatchObject({
      machineHours: 0,
      comment: '',
    });
  });

  it('an unsigned day is deleted by its own button', async () => {
    const http = renderWindow();

    const unsigned = await rowOf('2026-08-04');
    fireEvent.click(within(unsigned).getByTitle('Удалить смену').closest('button')!);
    await waitFor(() => expect(http.countOf('DELETE /vehicle-requests/r1/shifts/:date')).toBe(1));
    expect(http.lastCall('DELETE /vehicle-requests/r1/shifts/:date')?.path).toBe(
      '/vehicle-requests/r1/shifts/2026-08-04',
    );
    expect(await screen.findByText('Смена за 04.08.2026 удалена')).toBeDefined();
  });

  it('without the rights the window only reads', async () => {
    renderWindow({ canEdit: false, canApprove: false });

    const today = await rowOf(ON_DATE);
    expect(isDisabled(within(today).getByRole('spinbutton'))).toBe(true);
    expect(within(today).queryByTitle('Сохранить смену')).toBeNull();
    for (const box of screen.getAllByRole('checkbox')) expect(isDisabled(box)).toBe(true);
    expect(screen.queryByTitle('Удалить смену')).toBeNull();
  });
});
