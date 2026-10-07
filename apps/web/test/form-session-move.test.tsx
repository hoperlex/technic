import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentDto } from '@technic/contracts';
import { officeEquipmentKeys } from '../src/entities/office-equipment';
import { EquipmentMoveFromRequest } from '../src/features/equipment-move';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { serviceOperator, serviceRequest } from './factories/service';

/**
 * The move window opened from a request against rereads (stage 5 plan appendix A4, decision R6).
 *
 * The window reads the unit's card live, and a reread used to refill the form: the person's input
 * was gone, and the "from" of the move became the fresh place nobody had looked at. That refill was
 * also the way out of the "already moved" refusal. Now a reread over a changed form is the notice
 * with "Reload"; the move goes from the place the form was filled from, and the server's refusal
 * names where the unit really is.
 */

const MOVER: AuthUser = serviceOperator();
const MOVE = 'POST /office-equipment/:id/move';
const CARD = 'GET /office-equipment/:id';
const NOTICE = 'Запись изменена другим пользователем';

function card(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'ty-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    serialNumber: 'SN-1',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: 'каб. 214',
    state: 'on_site',
    stateNote: '',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

/** A colleague moved the unit to another room meanwhile. */
const MOVED = card({ location: 'каб. 300', updatedAt: '2026-01-11T09:00:00.000Z' });

function renderWindow(): {
  http: HttpMock;
  serve: (next: OfficeEquipmentDto) => void;
  reread: () => Promise<void>;
} {
  let current = card();
  const http = mockHttp({
    [CARD]: () => json(current),
    'GET /service-requests/:id': () => json(serviceRequest()),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    [MOVE]: () => json(current, 201),
  });
  const { queryClient } = renderWithUser(
    <EquipmentMoveFromRequest equipmentId="oe-1" serviceRequestId="sr-1" open onClose={() => {}} />,
    { user: MOVER },
  );
  return {
    http,
    serve: (next) => (current = next),
    reread: async () => {
      const before = http.countOf(CARD);
      await act(() => queryClient.invalidateQueries({ queryKey: officeEquipmentKeys.root }));
      await waitFor(() => expect(http.countOf(CARD)).toBeGreaterThan(before));
    },
  };
}

const location = () => screen.getByPlaceholderText('кабинет 214, прорабская') as HTMLInputElement;
const reason = () => screen.getByPlaceholderText(/Перевод бухгалтерии/) as HTMLInputElement;
const from = (http: HttpMock) =>
  (http.lastCall(MOVE)!.body as { from: { location: string } }).from.location;

describe('a colleague moves the unit while the window is open', () => {
  it('a changed form keeps the input under the notice and moves from the place it showed', async () => {
    const { http, serve, reread } = renderWindow();
    await waitFor(() => expect(location().value).toBe('каб. 214'));
    fireEvent.change(reason(), { target: { value: 'Увезли в сервис' } });

    serve(MOVED);
    await reread();

    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(reason().value).toBe('Увезли в сервис');
    expect(location().value).toBe('каб. 214');

    fireEvent.click(screen.getByText('Записать перемещение'));
    await waitFor(() => expect(http.countOf(MOVE)).toBe(1));
    expect(from(http)).toBe('каб. 214');
  });

  it('«Перечитать» refills from the fresh card, and the move goes from it', async () => {
    const { http, serve, reread } = renderWindow();
    await waitFor(() => expect(location().value).toBe('каб. 214'));
    fireEvent.change(reason(), { target: { value: 'Увезли в сервис' } });
    serve(MOVED);
    await reread();

    fireEvent.click(await screen.findByText('Перечитать'));
    await waitFor(() => expect(location().value).toBe('каб. 300'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    fireEvent.change(reason(), { target: { value: 'Увезли в сервис' } });
    fireEvent.click(screen.getByText('Записать перемещение'));
    await waitFor(() => expect(http.countOf(MOVE)).toBe(1));
    expect(from(http)).toBe('каб. 300');
  });

  it('an untouched form follows the colleague’s move silently', async () => {
    const { serve, reread } = renderWindow();
    await waitFor(() => expect(location().value).toBe('каб. 214'));

    serve(MOVED);
    await reread();
    await waitFor(() => expect(location().value).toBe('каб. 300'));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
