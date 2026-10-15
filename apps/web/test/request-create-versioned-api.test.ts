import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateMechRequestInput, CreateServiceRequestInput } from '@technic/contracts';
import { wasteRequestsApi, type WasteRequestPayload } from '@entities/waste-request';
import { mechRequestsApi } from '@entities/mech-request';
import { serviceRequestsApi } from '@entities/service-request';
import { apiFetch } from '@shared/api';
import type * as SharedApi from '@shared/api';

vi.mock('@shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  apiFetch: vi.fn(),
}));

beforeEach(() => vi.mocked(apiFetch).mockReset());

describe('ordinary create transport survives an older API rollback', () => {
  it.each([
    [
      'waste',
      (key?: string) => wasteRequestsApi.create({} as WasteRequestPayload, key),
      '/waste-requests',
    ],
    [
      'mech',
      (key?: string) => mechRequestsApi.create({} as CreateMechRequestInput, key),
      '/mech-requests',
    ],
    [
      'service',
      (key?: string) => serviceRequestsApi.create({} as CreateServiceRequestInput, key),
      '/service-requests',
    ],
  ])('%s sends keyed attempts only to an exact versioned route', (_kind, create, root) => {
    create('efefefef-efef-4fef-8fef-efefefefefef');
    expect(apiFetch).toHaveBeenCalledWith(
      `${root}/_create-with-receipt`,
      expect.objectContaining({
        headers: { 'Idempotency-Key': 'efefefef-efef-4fef-8fef-efefefefefef' },
      }),
    );
    vi.mocked(apiFetch).mockClear();
    create();
    expect(apiFetch).toHaveBeenCalledWith(root, expect.objectContaining({ method: 'POST' }));
  });

  it('keeps Service candidate intake on its existing root route', () => {
    serviceRequestsApi.create(
      { equipmentCandidate: { inventoryNumber: 'A' } } as CreateServiceRequestInput,
      'efefefef-efef-4fef-8fef-efefefefefef',
    );
    expect(apiFetch).toHaveBeenCalledWith(
      '/service-requests',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
