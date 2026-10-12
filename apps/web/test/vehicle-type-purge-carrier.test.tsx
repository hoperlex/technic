import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleTypeDto } from '@technic/contracts';
import { vehicleSpecKeys } from '@entities/vehicle-type';
import { VehicleTypeCardDrawer } from '@widgets/vehicle-type-card';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

const type: VehicleTypeDto = {
  id: 'type-1',
  kindId: 'kind-1',
  kindCode: 'special_equipment',
  kindName: 'Спецтехника',
  code: 'cranes',
  name: 'Автокраны',
  description: '',
  isActive: false,
  sortOrder: 10,
  waybillFormCode: '4p',
  isLinear: false,
  maintenanceBasis: 'none',
  frozenRequests: 0,
  specCount: 1,
  categoryCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('spec usage carried from a vehicle type purge', () => {
  it('refreshes the spec directory, whose usage count loses the purged type', async () => {
    const http = mockHttp({
      'GET /vehicle-types/:id/specs': () => json([]),
      'GET /vehicle-categories': () => json(list([])),
      // The spec section's picker observes the active specs: the drop refetches them at once.
      'GET /vehicle-specs': () => json(list([])),
      'DELETE /vehicle-types/:id/purge': () => json({ ok: true }),
    });
    const { queryClient } = renderWithUser(
      <VehicleTypeCardDrawer type={type} onClose={() => undefined} />,
      { user: authUser({ role: 'admin' }) },
    );
    const carriers = [vehicleSpecKeys.list({})];
    primeCarriers(queryClient, carriers);

    fireEvent.click(await screen.findByRole('button', { name: /Удалить тип окончательно/ }));
    // The confirmation's own button, not the drawer's «Удалить тип окончательно».
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить окончательно' }));

    await waitFor(() => expect(http.countOf('DELETE /vehicle-types/:id/purge')).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
