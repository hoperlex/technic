import dayjs from 'dayjs';
import type { CreateVehicleRequestInput } from '@technic/contracts';
import type { FormValues, TripFormValue } from '@features/vehicle-request-editor';

type FreightBody = Extract<CreateVehicleRequestInput, { requestType: 'freight_transport' }>;

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

/**
 * Form values as the editor holds them, for tests that go through `saveVehicleRequest`.
 *
 * Phones and the time are written the way people type them (`+7 (999) …`, `9:30`): the body builder
 * and the schema are expected to cope, and a fixture that is already normalized would hide a refusal.
 */
export function tripFormRow(overrides: Partial<TripFormValue> = {}): TripFormValue {
  return {
    key: crypto.randomUUID(),
    fromLocation: 'Карьер',
    toLocation: 'Площадка',
    fromAddress: { source: 'object', refId: DIRECTORY_ID },
    toAddress: { source: 'resolved', fiasId: 'fias-1' },
    cargoName: 'Песок',
    fromResponsibleName: 'Иванов Иван',
    fromResponsiblePhone: '+7 (999) 000-00-00',
    toResponsibleName: 'Петров Пётр',
    toResponsiblePhone: '8 999 000 00 01',
    volumeM3: 12.5,
    weightTons: null,
    ...overrides,
  };
}

export function freightFormValues(overrides: Partial<FormValues> = {}): FormValues {
  return {
    requestType: 'freight_transport',
    classificationKey: `${TYPE_ID}:`,
    customerKey: `object:${ID}`,
    scheduledDate: dayjs('2026-10-20'),
    scheduledTime: '9:30',
    trips: [tripFormRow()],
    comment: ' отправить ',
    ...overrides,
  };
}

export function specialFormValues(overrides: Partial<FormValues> = {}): FormValues {
  return {
    requestType: 'special_equipment',
    classificationKey: `${TYPE_ID}:`,
    customerKey: `object:${ID}`,
    dateFrom: dayjs('2026-10-20'),
    dateTo: null,
    responsibleName: 'Иванов Иван',
    responsiblePhone: '+79990000000',
    comment: 'Исходное тело',
    ...overrides,
  };
}
