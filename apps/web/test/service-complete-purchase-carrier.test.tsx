import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ServiceRequestConsumableDto, ServiceRequestDto } from '@technic/contracts';
import { officeEquipmentPurchaseKeys } from '@entities/office-equipment';
import { ServiceCompleteModal } from '@features/service-complete';
import { authUser } from './factories/auth';
import { serviceRequest } from './factories/service';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

/**
 * Closing the works of a consumables request writes off the issued quantity in the same
 * transaction (`applyConsumableFacts`, R5). A purchase card shows the position's stock of today
 * next to its snapshot (`currentStock`), and the close-works window refreshed the consumables but
 * not the purchases — the same gap the issued-quantity edit had.
 */

const OPERATOR = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
  phone: '9001234567',
});

function line(over: Partial<ServiceRequestConsumableDto> = {}): ServiceRequestConsumableDto {
  return {
    id: 'src-1',
    consumableId: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201',
    color: null,
    requestedQuantity: 2,
    issuedQuantity: null,
    issueNote: '',
    ...over,
  };
}

const request = (
  status: ServiceRequestDto['status'],
  lines: ServiceRequestConsumableDto[],
): ServiceRequestDto => serviceRequest({ kind: 'consumable', status, consumables: lines });

describe('purchase stock carried from closing consumables works', () => {
  it('refreshes the purchase cards after the close wrote the stock off', async () => {
    const http = mockHttp({
      'PATCH /service-requests/:id/complete': () =>
        json(request('done', [line({ issuedQuantity: 2 })])),
    });
    const { queryClient } = renderWithUser(
      <ServiceCompleteModal request={request('in_work', [line()])} onClose={() => undefined} />,
      { user: OPERATOR },
    );
    const carriers = [officeEquipmentPurchaseKeys.detail('purchase-1')];
    primeCarriers(queryClient, carriers);

    await screen.findByText('Отметьте, сколько выдали');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/complete')).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
