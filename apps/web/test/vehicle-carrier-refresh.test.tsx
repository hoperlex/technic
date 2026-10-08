import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { fuelNormKeys } from '@entities/fuel-norm';
import { vehicleClassificationKeys } from '@entities/vehicle-type';
import { trailerKeys } from '@entities/vehicle-trailer';
import { useVehicleLifecycle } from '@features/vehicle-lifecycle';
import { fleetVehicle } from './factories/vehicle';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

function LifecycleActions() {
  const lifecycle = useVehicleLifecycle();
  return (
    <>
      <button onClick={() => lifecycle.remove(fleetVehicle())}>Archive</button>
      <button onClick={() => lifecycle.restore('v-1')}>Restore</button>
    </>
  );
}

describe('vehicle fields embedded in other directories', () => {
  it('archival refreshes classifier averages, fuel labels and released trailer hitches', async () => {
    const http = mockHttp({
      'DELETE /vehicles/:id': () => json({ unhitchedTrailers: 1 }),
    });
    const { queryClient } = renderWithUser(<LifecycleActions />);
    const carriers = [
      vehicleClassificationKeys.list({}),
      fuelNormKeys.list({}),
      trailerKeys.list({}),
    ];
    primeCarriers(queryClient, carriers);

    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(await screen.findByRole('button', { name: 'В архив' }));
    await waitFor(() => expect(http.countOf('DELETE /vehicles/:id')).toBe(1));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
