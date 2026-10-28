import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentRequestOptionDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { equipmentSelectorOption, equipmentSelectorRoutes } from './factories/officeEquipment';
import { serviceCustomer, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * The form's hint about requests already open on the chosen unit (ADR 0236).
 *
 * The server no longer refuses a second open request on a unit, so the hint is the only place
 * where the requester learns about the first one. What is checked: the hint asks the ordinary list
 * with the unit and `openOnly`, names only open requests of the chosen kind, stays silent when
 * there are none, and is never asked while editing (the unit cannot change there).
 */

const NORTH = objectDto();
const REQUESTER: AuthUser = serviceCustomer({
  constructionObjectIds: [NORTH.id],
  phone: '9001234567',
});
// The only unit of the selector: the field picks it by itself, so the hint has a unit to ask about.
const UNIT: OfficeEquipmentRequestOptionDto = equipmentSelectorOption();

const OPEN_REPAIR = serviceRequest({ id: 'sr-21', num: 21, displayNumber: 'СО-21' });
const HELD_REPAIR = serviceRequest({
  id: 'sr-22',
  num: 22,
  displayNumber: 'СО-22',
  status: 'on_hold',
});
const OPEN_CONSUMABLE = serviceRequest({
  id: 'sr-23',
  num: 23,
  displayNumber: 'СО-23',
  kind: 'consumable',
});
// What a server older than `openOnly` would add: it ignores the filter and returns history too.
const ACCEPTED_REPAIR = serviceRequest({
  id: 'sr-24',
  num: 24,
  displayNumber: 'СО-24',
  status: 'accepted',
});

function renderForm(
  open: ReturnType<typeof serviceRequest>[],
  request: Parameters<typeof serviceRequest>[0] | null = null,
): HttpMock {
  const http = mockHttp({
    ...equipmentSelectorRoutes([UNIT]),
    'GET /objects': () => json(list([NORTH])),
    'GET /departments': () => json(list([])),
    'GET /service-requests': () => json(list(open)),
  });
  renderWithUser(
    <ServiceRequestForm
      open
      request={request ? serviceRequest(request) : null}
      onClose={() => {}}
    />,
    { user: REQUESTER },
  );
  return http;
}

describe('hint about requests already open on the unit', () => {
  it('names the open requests of the same kind and links to them', async () => {
    const http = renderForm([OPEN_REPAIR, HELD_REPAIR, OPEN_CONSUMABLE, ACCEPTED_REPAIR]);

    expect(await screen.findByText(/По этому аппарату уже открыты заявки/)).toBeDefined();
    const links = screen.getAllByRole('link').filter((a) => /^СО-\d+$/.test(a.textContent ?? ''));
    expect(links.map((a) => a.textContent)).toEqual(['СО-21', 'СО-22']);
    expect(links[0]!.getAttribute('href')).toBe('/office-equipment?tab=requests&open=sr-21');
    expect(links[0]!.getAttribute('target')).toBe('_blank');

    const query = http.lastCall('GET /service-requests')!.query;
    expect(query.get('equipmentId')).toBe(UNIT.id);
    expect(query.get('openOnly')).toBe('true');
  });

  it('follows the chosen kind', async () => {
    renderForm([OPEN_REPAIR, OPEN_CONSUMABLE]);
    await screen.findByText(/По этому аппарату уже открыта заявка/);

    fireEvent.click(screen.getByText('Расходники'));

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'СО-21' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'СО-23' })).toBeDefined();
  });

  it('says nothing when the unit has no open request', async () => {
    const http = renderForm([ACCEPTED_REPAIR]);

    await waitFor(() => expect(http.countOf('GET /service-requests')).toBe(1));
    expect(screen.queryByText(/По этому аппарату уже открыт/)).toBeNull();
  });

  it('is not asked while editing: the unit cannot change there', async () => {
    const http = renderForm([OPEN_REPAIR], { equipment: serviceRequest().equipment });

    expect(await screen.findByLabelText('Описание')).toBeDefined();
    expect(http.countOf('GET /service-requests')).toBe(0);
    expect(screen.queryByText(/По этому аппарату уже открыт/)).toBeNull();
  });
});
