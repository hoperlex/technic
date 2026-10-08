import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { counterpartyKeys } from '@entities/counterparty';
import { ObjectsTab } from '../src/pages/directories/ObjectsTab';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

describe('object fields embedded in counterparty cards', () => {
  it('purge refreshes the operator-side object list after the server removes the link', async () => {
    const site = objectDto({ isActive: false, operators: [] });
    const http = mockHttp({
      'GET /objects': () => json(list([site])),
      'GET /counterparties': () => json(list([])),
      'DELETE /objects/:id/purge': () => json({ ok: true }),
    });
    const { queryClient } = renderWithUser(<ObjectsTab />, {
      user: authUser({ role: 'admin' }),
    });
    const carriers = [counterpartyKeys.list({})];
    primeCarriers(queryClient, carriers);

    await screen.findByText(site.name);
    fireEvent.click(screen.getByTitle('Удалить окончательно'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить окончательно' }));

    await waitFor(() => expect(http.countOf('DELETE /objects/:id/purge')).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
