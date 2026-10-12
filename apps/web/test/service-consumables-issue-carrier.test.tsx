import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ServiceRequestConsumableDto, ServiceRequestDto } from '@technic/contracts';
import { officeEquipmentPurchaseKeys } from '@entities/office-equipment';
import { ServiceConsumablesIssueModal } from '@features/service-consumables-issue';
import { authUser } from './factories/auth';
import { serviceRequest } from './factories/service';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

/**
 * Recording the issued quantity of a consumables request moves the position's stock on the server
 * (`applyConsumableFacts`). A purchase card shows that stock of today next to its snapshot
 * (`currentStock`), and the issue modal refreshed the consumables but not the purchases.
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
    requestedQuantity: 3,
    issuedQuantity: 2,
    issueNote: '',
    ...over,
  };
}

const request = (lines: ServiceRequestConsumableDto[]): ServiceRequestDto =>
  serviceRequest({ kind: 'consumable', status: 'done', consumables: lines });

describe('purchase stock carried from an issued-quantity edit', () => {
  it('refreshes the purchase cards after the issue moved the stock', async () => {
    const http = mockHttp({
      'PATCH /service-requests/:id/consumables/issued': () =>
        json(request([line({ issuedQuantity: 3 })])),
    });
    const { queryClient } = renderWithUser(
      <ServiceConsumablesIssueModal request={request([line()])} onClose={() => undefined} />,
      { user: OPERATOR },
    );
    const carriers = [officeEquipmentPurchaseKeys.detail('purchase-1')];
    primeCarriers(queryClient, carriers);

    await screen.findByText('Со склада уйдёт разница, а не всё количество');
    const issued = screen.getAllByLabelText(/^Выдано: /)[0] as HTMLInputElement;
    fireEvent.change(issued, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Записать выдачу' }));

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/consumables/issued')).toBe(1),
    );
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
