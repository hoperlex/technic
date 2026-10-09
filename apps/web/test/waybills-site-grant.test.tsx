import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Role, WaybillDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';
import { WaybillsPage } from '../src/pages/waybills';

/**
 * The waybill journal as seen by a site grant holder (ADR 0192): the section is available, but the
 * driver directory is outside this grant.
 *
 * The holder has only `waybills.read`; asking for driver cards would return 403, and showing an
 * empty driver filter would suggest that no drivers exist. Route windows require a separate right.
 *
 * A driver's name stays in the issued sheet row; the restricted data is the company directory.
 */

const SHEET: WaybillDto = {
  id: 'w-1',
  number: '260604-646-00000001',
  formCode: '4p',
  status: 'issued',
  issuedForDate: '2026-09-15',
  periodFrom: null,
  periodTo: null,
  organizationName: 'ООО «СУ-10»',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-1',
  driverName: 'Иванов Иван Иванович',
  withTrailer: false,
  trailerLabel: '',
  issuedByName: 'Диспетчер',
  issuedAt: '2026-09-15T06:00:00.000Z',
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: '',
  printedAt: null,
  exportedAt: null,
  isCorrection: false,
  correctionReason: '',
  correctsNumber: null,
  correctedByNumber: null,
  periodToOriginal: null,
  trimmedAt: null,
  trimReason: '',
  routeId: 'route-1',
  routeNumber: 'Р-12',
  requests: [
    {
      requestId: 'r-1',
      displayNumber: '№ 12',
      slot: 1,
      objectName: 'Площадка 1',
      status: 'confirmed',
    },
  ],
  files: [],
};

/**
 * The site gets waybill access through a grant, not its role. A fixture with role permissions
 * would represent an account the portal cannot actually create.
 */
function siteHolder() {
  return authUser({
    id: 'user-site',
    email: 'site@example.test',
    lastName: 'Площадкин',
    firstName: 'Пётр',
    middleName: 'Сергеевич',
    fullName: 'Площадкин Пётр Сергеевич',
    role: 'site' as Role,
    constructionObjectIds: ['object-1'],
    grantCodes: ['waybills_view'],
    grantPermissions: ['waybills.read'],
  });
}

/** The site holder's own site and a foreign one: the filter must offer only the first. */
const OWN_SITE = objectDto({ id: 'object-1', code: 'ОБ-1', name: 'Своя площадка', address: '' });
const FOREIGN_SITE = objectDto({
  id: 'object-2',
  code: 'ОБ-2',
  name: 'Чужая площадка',
  address: '',
});

function renderFor(user: ReturnType<typeof authUser>) {
  const http = mockHttp({
    'GET /waybills': () => json(list([SHEET])),
    'GET /vehicles': () => json(list([])),
    'GET /drivers': () => json(list([])),
    'GET /objects': () => json(list([OWN_SITE, FOREIGN_SITE])),
  });
  const rendered = renderWithUser(<WaybillsPage />, { user });
  return { http, rendered };
}

describe('журнал листов у держателя набора (ADR 0192)', () => {
  it('площадке фильтр по водителю не показывается, и справочник не запрашивается', async () => {
    const { http } = renderFor(siteHolder());
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));

    // The granted sheet still shows its number, vehicle and driver's name.
    await waitFor(() => expect(screen.getByText('260604-646-00000001')).toBeDefined());
    expect(screen.getByText('Иванов Иван Иванович')).toBeDefined();

    // Neither desktop nor phone exposes the unavailable driver filter.
    const placeholders = [...document.querySelectorAll<HTMLElement>('.ant-select')].map((el) =>
      el.textContent?.trim(),
    );
    expect(placeholders).not.toContain('Все водители');
    // No driver directory request is sent under a grant that lacks `drivers.read`.
    expect(http.countOf('GET /drivers')).toBe(0);
  });

  it('диспетчеру тот же фильтр остаётся на месте', async () => {
    const { http } = renderFor(authUser());
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));

    const placeholders = [...document.querySelectorAll<HTMLElement>('.ant-select')].map((el) =>
      el.textContent?.trim(),
    );
    expect(placeholders).toContain('Все водители');
    expect(http.countOf('GET /drivers')).toBe(0);
    const field = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === 'Все водители',
    );
    fireEvent.mouseDown(field!.querySelector('.ant-select-selector') ?? field!);
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));
  });

  /*
   * The server intersects the site filter with the scope, so a foreign site would find at most a
   * mixed sheet already visible under the holder's own site; it must not be offered. The chosen
   * site must reach the journal request, otherwise the field would narrow nothing.
   */
  it('площадке в отборе предлагаются только её площадки, и выбранная уходит в запрос журнала', async () => {
    const { http } = renderFor(siteHolder());
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));
    expect(http.countOf('GET /objects')).toBe(0);

    const field = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === 'Все площадки',
    );
    expect(field, 'site filter').toBeTruthy();
    fireEvent.mouseDown(field!.querySelector('.ant-select-selector') ?? field!);
    await waitFor(() => expect(http.countOf('GET /objects')).toBe(1));
    const option = await waitFor(() => {
      const options = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(options.map((o) => o.textContent)).toEqual(['ОБ-1 — Своя площадка']);
      return options[0]!;
    });
    fireEvent.click(option);

    await waitFor(() =>
      expect(http.lastCall('GET /waybills')!.query.get('objectId')).toBe('object-1'),
    );
  });

  /**
   * Route and request numbers remain text: their windows require separate rights. The numbers
   * must remain visible because the journal still has to identify the trip behind a sheet.
   */
  it('номер рейса и номер заявки показаны, но никуда не ведут', async () => {
    renderFor(siteHolder());
    await waitFor(() => expect(screen.getByText('260604-646-00000001')).toBeDefined());

    const row = screen.getByText('260604-646-00000001').closest('tr')!;
    // The request caption spans several nodes, so inspect the row text as a whole.
    expect(row.textContent).toContain('Р-12');
    expect(row.textContent).toContain('№ 12');
    // EntityLink leaves both numbers as text without the corresponding window rights.
    expect(row.querySelectorAll('a')).toHaveLength(0);
  });
});
