import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import type { DriverAssignmentDto, DriverReportDto, ReportItemDto } from '@technic/contracts';
import { driverCabinetKeys } from '@entities/driver-cabinet';
import { MOSCOW_TZ } from '@shared/config';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverReadingsPage } from '../src/pages/driver/DriverReadingsPage';
import { authUser } from './factories/auth';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

/**
 * A driver's submit for a day relinks the vehicle's later readings on the server: a later report
 * recomputes its deltas and anomalies, and a later assignment shows the submitted numbers as its
 * `previous` snapshot (`previousReadings` reads strictly before the date). The page used to drop
 * only the submitted day's assignment, which cannot change, so a later day opened within the
 * freshness term warned against the counters of the day before.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');
const tomorrow = dayjs(today).add(1, 'day').format('YYYY-MM-DD');
const yesterday = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const driver = authUser({ id: 'user-driver', role: 'driver', fullName: 'Водителев Виктор' });

const item: ReportItemDto = {
  id: 'item-route',
  sourceKind: 'route',
  sourceId: 'route-1',
  sourceLabel: 'Рейс Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  shiftOrder: 1,
  reading: null,
};

function reportOf(overrides: Partial<DriverReportDto> = {}): DriverReportDto {
  return {
    id: 'report-1',
    personId: 'p-1',
    personName: driver.fullName,
    reportDate: today,
    state: 'draft',
    draftFormat: 'v2',
    contentVersion: 1,
    version: 3,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items: [item],
    discrepancies: [],
    canAccept: false,
    blockers: [],
    ...overrides,
  };
}

const assignment: DriverAssignmentDto = {
  date: today,
  canSubmit: true,
  entries: [
    {
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      sourceLabel: item.sourceLabel,
      purposeLabel: 'Грузоперевозка',
      vehicleLabel: item.vehicleLabel,
      garageNumber: '',
      trailerLabel: '',
      itemId: item.id,
      shiftOrder: item.shiftOrder,
      points: [],
      moveFrom: '',
      moveTo: '',
      comment: '',
      previous: null,
    },
  ],
};

describe('later cabinet days carried from a submit', () => {
  beforeEach(() => localStorage.clear());

  it('refreshes later assignments and reports, and leaves the submitted and earlier days', async () => {
    const http = mockHttp({
      'GET /driver/assignment': () => json(assignment),
      'GET /driver/reports/:date': () => json(null),
      'POST /driver/reports/:date/open': () => json(reportOf()),
      'POST /driver/reports/:date/submit': () => json(reportOf({ state: 'submitted', version: 4 })),
    });
    const { queryClient } = renderWithUser(
      <DriverLayout>
        <DriverReadingsPage />
      </DriverLayout>,
      { user: driver, route: '/driver' },
    );
    await waitFor(() => expect(document.getElementById(`reading-${item.id}`)).not.toBeNull(), {
      timeout: 3000,
    });
    const carriers = [driverCabinetKeys.assignment(tomorrow), driverCabinetKeys.report(tomorrow)];
    primeCarriers(queryClient, carriers);

    const block = document.getElementById(`reading-${item.id}`)!;
    const odometer = [...block.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Одометр'))
      ?.querySelector('input');
    fireEvent.change(odometer!, { target: { value: '145400' } });
    const button = await screen.findByText('Передать');
    await waitFor(() => expect(button.closest('button')?.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(http.countOf('POST /driver/reports/:date/submit')).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    // The submitted day's report holds the command's answer (R8), and earlier days are not
    // touched by the server: neither is dropped.
    expect(queryClient.getQueryState(driverCabinetKeys.report(today))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(driverCabinetKeys.report(yesterday))?.isInvalidated).toBe(
      false,
    );
    await expectCarriersRefetched(queryClient, carriers);
  });
});
