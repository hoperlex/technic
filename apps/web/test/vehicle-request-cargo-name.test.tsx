import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { VehicleClassificationDto } from '@technic/contracts';
import { FREIGHT_VEHICLE_KIND_CODE, vehicleClassificationKey } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { freightRequest, freightTrip, vehicleFeed, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { VehicleRequestViewModal } from '../src/pages/vehicle/VehicleRequestViewModal';

/**
 * "What we carry" of a freight trip (ADR 0239) as the portal shows and asks it: the list row and
 * the card name the cargo of the whole request once per distinct value, a request whose trips are
 * older than the field looks as it did, and the edit form asks for the cargo except on such a trip.
 *
 * The rule itself (required, kept on an old trip, never cleared) is the contract's and the server's
 * — `request-trips-contracts.test.ts`, `legacy-trip-edit.db.test.ts`; here only what reaches the
 * person.
 */

/** Three trips, two of them repeated "sand": the summary must name it once. */
const MIXED = freightRequest({
  id: 'vr-mixed',
  num: 51,
  displayNumber: 'ТС-51',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  trips: [
    freightTrip({ id: 'vrt-51-1', num: 1, displayNumber: 'ТС-51/1', cargoName: 'Песок' }),
    freightTrip({ id: 'vrt-51-2', num: 2, displayNumber: 'ТС-51/2', cargoName: 'Песок' }),
    freightTrip({ id: 'vrt-51-3', num: 3, displayNumber: 'ТС-51/3', cargoName: 'Щебень' }),
  ],
});

/** A one-trip request created before migration 0397: its trip names no cargo. */
const LEGACY = freightRequest({
  id: 'vr-legacy',
  num: 52,
  displayNumber: 'ТС-52',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  trips: [freightTrip({ id: 'vrt-52-1', displayNumber: 'ТС-52/1', cargoName: '' })],
});

/** A one-trip request of today: the cargo is named. */
const NAMED = freightRequest({
  id: 'vr-named',
  num: 53,
  displayNumber: 'ТС-53',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  trips: [freightTrip({ id: 'vrt-53-1', displayNumber: 'ТС-53/1', cargoName: 'Арматура' })],
});

const DUMP = {
  key: vehicleClassificationKey('vt-2', null),
  vehicleTypeId: 'vt-2',
  vehicleCategoryId: null,
  kindId: 'vk-freight',
  kindCode: FREIGHT_VEHICLE_KIND_CODE,
  kindName: 'Грузовой транспорт',
  typeCode: 'dump',
  typeName: 'Самосвалы',
  categoryName: null,
  label: 'Самосвалы',
  specCount: 0,
  waybillFormCode: '4p',
} as unknown as VehicleClassificationDto;

function renderTab() {
  mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 3 })),
    'GET /vehicle-requests/feed': () => json(vehicleFeed([MIXED, LEGACY, NAMED])),
    'GET /objects': () => json(list([objectDto({ operators: [], id: 'obj-1' })])),
    'GET /departments': () => json(emptyList()),
    'GET /warehouses': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([DUMP])),
    'GET /vehicles': () => json(emptyList()),
  });
  renderWithUser(<VehicleRequestsTab />, { user: authUser() });
}

function renderCard(request: typeof MIXED) {
  mockHttp({
    'GET /vehicle-requests/:id/history': () => json([]),
    'GET /vehicle-requests/:id/documents': () => json({ items: [] }),
    'GET /vehicle-requests/:id/waybills': () => json([]),
  });
  renderWithUser(<VehicleRequestViewModal request={request} onClose={() => {}} />, {
    user: authUser({ role: 'dispatcher' }),
  });
}

async function rowOf(displayNumber: string): Promise<HTMLElement> {
  return (await screen.findByText(displayNumber)).closest('tr')!;
}

/** The form item labelled "Что везём" in the open editor. */
function cargoItem(): HTMLElement {
  const item = [...document.querySelectorAll('.ant-modal .ant-form-item')].find(
    (el) => el.querySelector('label')?.textContent === 'Что везём',
  );
  if (!item) throw new Error('Поле «Что везём» в форме не найдено');
  return item as HTMLElement;
}

async function openEdit(displayNumber: string): Promise<void> {
  const row = await rowOf(displayNumber);
  fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
  await waitFor(() => expect(screen.getByText(`Заявка ${displayNumber}`)).toBeDefined());
  // The trip fields appear once the form has the request type.
  await waitFor(() => expect(cargoItem()).toBeDefined());
}

describe('что везём: список и карточка', () => {
  it('строка списка называет груз один раз, у старой заявки строки нет', async () => {
    renderTab();

    const mixed = await rowOf('ТС-51');
    expect(mixed.querySelector('[title="Что везём"]')?.textContent).toBe('Песок, Щебень');
    expect((await rowOf('ТС-53')).querySelector('[title="Что везём"]')?.textContent).toBe(
      'Арматура',
    );
    expect((await rowOf('ТС-52')).querySelector('[title="Что везём"]')).toBeNull();
  });

  it('карточка: сводка в обзоре и груз каждой ездки в таблице', async () => {
    renderCard(MIXED);

    expect(await screen.findByText('Что везём')).toBeDefined();
    expect(screen.getByText('Песок, Щебень')).toBeDefined();
    const table = screen.getByText('Щебень').closest('table')!;
    expect(within(table).getAllByText('Песок')).toHaveLength(2);
    expect(within(table).getByText('Щебень')).toBeDefined();
  });

  it('карточка старой заявки выглядит как прежде — без строки «Что везём»', async () => {
    renderCard(LEGACY);

    await screen.findByText('Объём / масса');
    expect(screen.queryByText('Что везём')).toBeNull();
  });
});

describe('что везём: правка', () => {
  it('у ездки старше поля оно не обязательно: старую заявку правят, не выдумывая груз', async () => {
    renderTab();

    await openEdit('ТС-52');
    expect(cargoItem().querySelector('.ant-form-item-required')).toBeNull();
  });

  it('у названного груза поле обязательно и приходит заполненным', async () => {
    renderTab();

    await openEdit('ТС-53');
    expect(cargoItem().querySelector('.ant-form-item-required')).not.toBeNull();
    expect((cargoItem().querySelector('input') as HTMLInputElement).value).toBe('Арматура');
  });
});
