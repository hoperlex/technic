import type { WaybillDto } from '@technic/contracts';

/**
 * A waybill of the journal (`GET /waybills`): an issued one-day 4-P sheet of a route, neither
 * corrected, trimmed nor cancelled. Every mark of the journal row is off by default, so a scenario
 * about one of them sets exactly that one.
 */
export function waybill(overrides: Partial<WaybillDto> = {}): WaybillDto {
  return {
    id: 'w-1',
    number: '260604-646-00000001',
    formCode: '4p',
    status: 'issued',
    issuedForDate: '2026-08-10',
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
    issuedAt: '2026-08-10T06:00:00.000Z',
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
    trips: [],
    issueWarnings: { status: 'clean', warnings: [] },
    routeId: 'route-1',
    routeNumber: 'Р-12',
    requests: [],
    files: [],
    ...overrides,
  };
}
