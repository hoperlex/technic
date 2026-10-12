import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleClassificationDto, VehicleKindDto, VehicleTypeDto } from '@technic/contracts';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { VehicleTypesTab } from '../src/pages/directories/VehicleTypesTab';
import { list } from './factories/common';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

/**
 * Switching a type's linear flag rewrites its requests on the server (ADR 0107): the requests it
 * catches get the snapshot `isLinearFrozen`, and every other request of the type reads the new flag
 * as its own `isLinear`. The editor refreshed the type directory and its carriers but not the
 * vehicle requests, so a feed or card already in the cache kept the old mode.
 */

const kind: VehicleKindDto = {
  id: 'kind-special',
  code: 'special_equipment',
  name: 'Спецтехника',
  sortOrder: 10,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const type: VehicleTypeDto = {
  id: 'vt-excavators',
  kindId: kind.id,
  kindCode: kind.code,
  kindName: kind.name,
  code: 'excavators',
  name: 'Экскаваторы',
  description: '',
  isActive: true,
  sortOrder: 20,
  waybillFormCode: '4p',
  isLinear: false,
  maintenanceBasis: 'none',
  frozenRequests: 0,
  specCount: 0,
  categoryCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** The directory lists the classifier: a type without categories is a row of its own. */
const row: VehicleClassificationDto = {
  key: `${type.id}:`,
  vehicleTypeId: type.id,
  vehicleCategoryId: null,
  kindId: type.kindId,
  kindCode: type.kindCode,
  kindName: type.kindName,
  typeCode: type.code,
  typeName: type.name,
  categoryName: null,
  label: type.name,
  specCount: 0,
  waybillFormCode: type.waybillFormCode,
  avgPricePerHour: null,
  avgPricePerShift: null,
  isActive: true,
  typeIsActive: true,
  categoryIsActive: null,
  sortOrder: type.sortOrder,
  categorySortOrder: null,
};

function linearCheckbox(): HTMLInputElement | undefined {
  const label = [...document.querySelectorAll('.ant-checkbox-wrapper')].find(
    (el) => el.textContent?.trim() === 'Линейная техника',
  );
  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
}

describe('vehicle requests carried from a linear switch', () => {
  it('refreshes the vehicle requests after the switch endpoint rewrote their mode', async () => {
    const switched = { ...type, isLinear: true };
    const http = mockHttp({
      'GET /vehicle-classifications': () => json(list([row])),
      'GET /vehicle-types': () => json(list([type])),
      'GET /vehicle-kinds': () => json(list([kind])),
      'GET /vehicle-types/:id/linear-switch-preview': () =>
        json({ next: true, count: 0, archivedCount: 0, requests: [], fingerprint: 'f-0' }),
      'POST /vehicle-types/:id/linear': () =>
        json({ type: switched, frozenNow: 0, frozenNums: [], frozenTotal: 0 }),
      'PATCH /vehicle-types/:id': () =>
        json({ type: switched, unhitchedTrailers: 0, unhitchedVehicles: 0 }),
    });
    const { queryClient } = renderWithUser(<VehicleTypesTab />);
    const carriers = [vehicleRequestKeys.feed({}), vehicleRequestKeys.detail('request-1')];
    primeCarriers(queryClient, carriers);

    await screen.findByText('Экскаваторы');
    const edit = [...document.querySelectorAll('tbody button')].find((b) =>
      b.getAttribute('title')?.startsWith('Редактировать тип'),
    );
    fireEvent.click(edit!);
    await waitFor(() => expect(linearCheckbox()).toBeTruthy());
    fireEvent.click(linearCheckbox()!);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-types/:id')).toBe(1));
    expect(http.countOf('POST /vehicle-types/:id/linear')).toBe(1);
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
