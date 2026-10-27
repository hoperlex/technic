import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  DriverReportDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingIntakeDto,
  ReportItemDto,
} from '@technic/contracts';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';
import { GaragePage } from '../src/pages/garage';

/**
 * The request shift table is a carrier of driver readings (readings-shifts-merge plan §6.7): a
 * request day takes its hours and refuelling from the submitted readings, and its diagnostics show
 * the report state. A reading entered or a day accepted in the garage must therefore refresh the
 * request's shifts — a request card opened over the garage would otherwise keep yesterday's day.
 * The ADR 0222 pattern: a fresh inactive entry is primed, the mutation runs, the entry must fetch
 * again when its carrier is next opened.
 */

const REPORT = 'GET /vehicle-readings/reports/:id';
const SUBMIT = 'POST /vehicle-readings/reports/:personId/:date/submit';
const ACCEPT = 'POST /vehicle-readings/reports/:id/accept';
const DAY = '2026-08-14';

const ITEM: ReportItemDto = {
  id: 'item-1',
  sourceKind: 'esm2',
  sourceId: 'wb-1',
  sourceLabel: 'ЭСМ-2 № 000123',
  vehicleId: 'v-1',
  vehicleLabel: 'Экскаватор · 0002 ММ 77',
  shiftOrder: 1,
  reading: null,
};

function report(over: Partial<DriverReportDto> = {}): DriverReportDto {
  return {
    id: 'r-1',
    personId: 'p-1',
    personName: 'Петров П. П.',
    reportDate: DAY,
    state: 'submitted',
    contentVersion: 1,
    version: 3,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items: [ITEM],
    discrepancies: [],
    canAccept: false,
    blockers: ['не закрыто строк: 1'],
    ...over,
  };
}

const INTAKE: ReadingIntakeDto = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 100,
  from: '2026-08-08',
  to: DAY,
  today: '2026-08-17',
  reports: [],
};

const VEHICLES: GarageVehicleListDto = { items: [], total: 0, page: 1, pageSize: 50, onDate: DAY };
const VEHICLES_SUMMARY: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: DAY,
};

/** The shift tables of two requests: the garage does not know which request a reading serves. */
const CARRIERS = [vehicleRequestKeys.shifts('request-1'), vehicleRequestKeys.shifts('request-2')];

function renderIntakeCard(dto: DriverReportDto) {
  const http = mockHttp({
    'GET /vehicle-readings/intake': () => json(INTAKE),
    [REPORT]: () => json(dto),
    [SUBMIT]: () => json(dto),
    [ACCEPT]: () => json({ ...dto, state: 'accepted', canAccept: false }),
    'GET /vehicle-readings/stats': ({ query }) =>
      json({ items: [], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
  });
  const { queryClient } = renderWithUser(<GaragePage />, {
    route: `/garage?tab=readings&sub=intake&date=${DAY}&report=r-1`,
  });
  primeCarriers(queryClient, CARRIERS);
  return { http, queryClient };
}

describe('request shifts carried from the readings intake', () => {
  it('a reading entered for the driver refreshes the request shift tables', async () => {
    const { http, queryClient } = renderIntakeCard(report());
    expect(await screen.findByText(`Отчёт — Петров П. П., 14.08.2026`)).toBeDefined();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Внести показание — ЭСМ-2 № 000123' }),
    );
    const form = screen
      .getByText('Показания — ЭСМ-2 № 000123')
      .closest('.ant-modal') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('Моточасы на конец смены'), {
      target: { value: '812,5' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(SUBMIT)).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(CARRIERS[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, CARRIERS);
  });

  it('accepting a day refreshes them too: the driver diagnostics show the report state', async () => {
    const filled: ReportItemDto = {
      ...ITEM,
      reading: {
        id: 'rd-1',
        itemId: 'item-1',
        kind: 'values',
        odometerKm: null,
        engineHours: 812.5,
        fuelStartLiters: null,
        fuelFilledLiters: null,
        fuelEndLiters: null,
        noDataReason: '',
        comment: '',
        source: 'driver',
        recordedAt: '2026-08-14T17:20:00.000Z',
        odometerAnomaly: null,
        engineHoursAnomaly: null,
        odometerDelta: null,
        engineHoursDelta: 8,
        fileIds: [],
      },
    };
    const { http, queryClient } = renderIntakeCard(
      report({ items: [filled], canAccept: true, blockers: [] }),
    );
    expect(await screen.findByText(`Отчёт — Петров П. П., 14.08.2026`)).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: /Принять день/u }));

    await waitFor(() => expect(http.countOf(ACCEPT)).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(CARRIERS[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, CARRIERS);
  });
});
