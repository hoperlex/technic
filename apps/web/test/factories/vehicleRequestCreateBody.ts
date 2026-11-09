import type { CreateVehicleRequestInput } from '@technic/contracts';

type FreightBody = Extract<CreateVehicleRequestInput, { requestType: 'freight_transport' }>;
type SpecialBody = Extract<CreateVehicleRequestInput, { requestType: 'special_equipment' }>;

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TYPE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DIRECTORY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * Create bodies that the route's stable schema accepts, written out by hand.
 *
 * Tests that must prove "a real body is not refused" build theirs through `saveVehicleRequest`; these
 * are for tests that need a valid frozen body or a body spoiled in exactly one place.
 */
export function freightTripBody(
  overrides: Partial<FreightBody['trips'][number]> = {},
): FreightBody['trips'][number] {
  return {
    fromLocation: 'Карьер',
    toLocation: 'Площадка',
    fromAddress: { source: 'object', refId: DIRECTORY_ID },
    toAddress: { source: 'warehouse', refId: DIRECTORY_ID },
    cargoName: 'Песок',
    volumeM3: 10,
    weightTons: null,
    fromResponsibleName: 'Иванов Иван',
    fromResponsiblePhone: '+79990000000',
    toResponsibleName: 'Петров Пётр',
    toResponsiblePhone: '+79990000001',
    scheduledAt: null,
    comment: '',
    ...overrides,
  };
}

export function freightRequestBody(overrides: Partial<FreightBody> = {}): FreightBody {
  return {
    requestType: 'freight_transport',
    objectId: ID,
    vehicleTypeId: TYPE_ID,
    scheduledAt: '2026-10-20T10:00:00+03:00',
    scheduledTimeUnspecified: false,
    trips: [freightTripBody()],
    comment: '',
    fileIds: [],
    ...overrides,
  };
}

export function specialRequestBody(overrides: Partial<SpecialBody> = {}): SpecialBody {
  return {
    requestType: 'special_equipment',
    objectId: ID,
    vehicleTypeId: TYPE_ID,
    dateFrom: '2026-10-20',
    responsibleName: 'Иванов Иван',
    responsiblePhone: '+79990000000',
    comment: '',
    fileIds: [],
    ...overrides,
  };
}
