import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import type { VehicleDto, VehicleRouteDto } from '@technic/contracts';
import {
  assignCommandBody,
  assignScheduleOf,
  assignmentBlockers,
  assignmentDriverLookup,
  assignmentFleetByOwnership,
  assignmentRouteOptions,
  assignmentVehicleOptions,
  dayBatchBody,
  dayBatchModel,
  mergeAssignmentFleet,
  NEW_ROUTE,
  orderedVehiclePosition,
  reassignPreviewBlocked,
  reassignPreviewIsSilent,
  reassignStaleReason,
} from '@features/vehicle-assignment';
import { assignmentPreview, vehicleRequest } from './factories/vehicle';

function vehicle(overrides: Partial<VehicleDto> & Pick<VehicleDto, 'id'>): VehicleDto {
  return {
    ownership: 'own',
    vehicleKindId: 'kind-special',
    kindName: 'Спецтехника',
    vehicleTypeId: 'type-crane',
    typeName: 'Автокран',
    waybillFormCode: '4p',
    vehicleCategoryId: 'category-25',
    categoryName: 'Автокраны, 25 т',
    categorySpecs: { lift_capacity: 25 },
    vehicleModelId: null,
    modelName: 'Ивановец',
    registrationNumber: 'А001АА77',
    passportNumber: null,
    lessorId: null,
    lessorName: null,
    lessorIsActive: null,
    deactivatedWithLessor: false,
    description: '',
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    status: 'active',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('vehicle assignment command', () => {
  it('uses one body for the schedule, route, delivery and historical correction', () => {
    const request = vehicleRequest({ dateFrom: '2026-10-02', dateTo: '2026-10-04' });
    const schedule = assignScheduleOf(request, {
      dateFrom: dayjs('2026-10-03'),
      dateTo: dayjs('2026-10-05'),
    });
    const command = assignCommandBody(
      {
        vehicleId: 'vehicle-2',
        pricePerHour: 2500,
        machinistId: 'person-machinist',
        routeId: NEW_ROUTE,
        driverPersonId: 'person-driver',
        withTrailer: true,
        trailer1Model: 'МАЗ-8926',
        trailer1RegNumber: '8062 ЕН 77',
        garageNumber: '389',
        communicationKind: 'городское',
        deliveryDate: dayjs('2026-10-02'),
        deliveryDriverId: 'person-delivery',
        deliveryFrom: '  База  ',
        deliveryTo: '  Объект  ',
        correctionReason: '  работала другая машина  ',
        unlockWaybillIds: ['sheet-1'],
      },
      {
        schedule,
        needsMachinist: true,
        needsRoute: true,
        wantsDelivery: true,
        correctionId: 'operation-1',
      },
    );

    expect(command.schedule).toEqual({
      requestType: 'special_equipment',
      dateFrom: '2026-10-03',
      dateTo: '2026-10-05',
    });
    expect(command.assignment).toMatchObject({
      vehicleId: 'vehicle-2',
      driverPersonId: 'person-machinist',
      route: {
        newRoute: {
          driverPersonId: 'person-driver',
          trip: {
            withTrailer: true,
            trailer1Model: 'МАЗ-8926',
            trailer1RegNumber: '8062 ЕН 77',
          },
        },
      },
      delivery: {
        routeDate: '2026-10-02',
        driverPersonId: 'person-delivery',
        moveFrom: 'База',
        moveTo: 'Объект',
      },
    });
    expect(command.correction).toEqual({
      operationId: 'operation-1',
      reason: 'работала другая машина',
      unlockWaybillIds: ['sheet-1'],
    });
  });

  it('keeps an existing route driver when the form leaves the optional field empty', () => {
    const command = assignCommandBody(
      { vehicleId: 'vehicle-2', routeId: 'route-7' },
      {
        schedule: null,
        needsMachinist: false,
        needsRoute: true,
        wantsDelivery: false,
        correctionId: null,
      },
    );
    expect(command.assignment.route).toEqual({ routeId: 'route-7' });
  });
});

describe('vehicle assignment selection', () => {
  it('deduplicates fleet pages and keeps another vehicle kind selectable as the last group', () => {
    const exact = vehicle({ id: 'exact' });
    const rental = vehicle({
      id: 'rental',
      ownership: 'rental',
      lessorId: 'lessor-1',
      lessorName: 'Арендодатель',
      description: 'Самосвал',
      vehicleKindId: 'kind-freight',
      vehicleTypeId: 'type-tipper',
      typeName: 'Самосвал',
      vehicleCategoryId: null,
      categoryName: null,
      categorySpecs: null,
    });
    const merged = mergeAssignmentFleet([exact], [exact, rental]);
    const fleet = assignmentFleetByOwnership(merged);
    const groups = assignmentVehicleOptions({
      fleet,
      ownership: 'rental',
      ordered: orderedVehiclePosition(vehicleRequest()),
    });

    expect(merged.map((item) => item.id)).toEqual(['exact', 'rental']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Другой вид техники');
    expect(groups[0]?.options[0]?.value).toBe('rental');
  });

  it('excludes a full or issued route from the picker', () => {
    const route = (overrides: Partial<VehicleRouteDto>): VehicleRouteDto =>
      ({
        id: 'route-1',
        formCode: '4p',
        requests: [],
        waybill: null,
        ...overrides,
      }) as VehicleRouteDto;
    const available = route({ id: 'available' });
    const issued = route({ id: 'issued', waybill: { status: 'issued' } as never });
    const full = route({
      id: 'full',
      requests: Array.from({ length: 7 }, (_, index) => ({ id: String(index) })) as never,
    });
    expect(assignmentRouteOptions([available, issued, full]).map((item) => item.id)).toEqual([
      'available',
    ]);
  });

  it('uses the joined route date and trailer when selecting its driver', () => {
    const joinedRoute = {
      routeDate: '2026-10-07',
      withTrailer: true,
    } as VehicleRouteDto;
    expect(
      assignmentDriverLookup({
        needsRoute: true,
        joinedRoute,
        tripDate: '2026-10-06',
        wantsDelivery: false,
        deliveryDate: null,
        withTrailer: false,
      }),
    ).toEqual({ needed: true, on: '2026-10-07', withTrailer: true });
  });

  it('returns field blockers for an incomplete rental delivery', () => {
    const blockers = assignmentBlockers(
      { routeId: NEW_ROUTE, deliveryFrom: ' ' },
      {
        correctionEnabled: false,
        isRental: true,
        machinistRequired: false,
        needsRoute: true,
        reassign: false,
        requestType: 'freight_transport',
        schedule: null,
        wantsDelivery: true,
      },
    );
    expect(blockers).toMatchObject({
      scheduledDate: 'Укажите фактическую дату',
      vehicleId: 'Выберите технику',
      pricePerHour: 'Укажите стоимость аренды — за час или за смену',
      deliveryDate: 'Укажите дату перегона',
      deliveryDriverId: 'Выберите водителя перегона',
      deliveryFrom: 'Укажите, откуда идёт техника',
      deliveryTo: 'Укажите, куда идёт техника',
      driverPersonId: 'Выберите водителя — на рейс выписывается путевой лист',
    });
  });
});

describe('assignment day batch model', () => {
  it('defaults to the listed machinist, reports a long portion and trims the command reason', () => {
    const model = dayBatchModel({
      term: { dateFrom: '2026-01-01', dateTo: '2026-03-10' },
      onDate: '2026-02-01',
      machinist: { personId: 'person-1', name: 'Иванов' },
      driverOptions: [{ value: 'person-1' }],
      driverSelectionReady: true,
    });
    expect(model.defaultDriverId).toBe('person-1');
    expect(model.pastDays.length).toBeGreaterThan(0);
    expect(model.portionHint).toContain('50');
    expect(
      dayBatchModel({
        term: { dateFrom: '2026-01-01', dateTo: null },
        onDate: '2026-01-01',
        machinist: { personId: 'person-1', name: 'Иванов' },
        driverOptions: [],
        driverSelectionReady: false,
      }).machinistNote,
    ).toBeNull();
    expect(
      dayBatchBody(
        { dayBatchDriverId: 'person-1', dayBatchReason: '  документы оформлены позже  ' },
        'batch-1',
      ),
    ).toEqual({
      driverPersonId: 'person-1',
      issueWaybills: true,
      reason: 'документы оформлены позже',
      operationId: 'batch-1',
    });
  });
});

describe('assignment preview model', () => {
  it('skips an empty preview but blocks a preview with signed work days', () => {
    expect(reassignPreviewIsSilent(assignmentPreview())).toBe(true);
    const blocked = assignmentPreview({
      blockedShiftDays: [{ date: '2026-10-01', hours: 8 }],
    });
    expect(reassignPreviewIsSilent(blocked)).toBe(false);
    expect(reassignPreviewBlocked(blocked)).toBe(true);
  });

  it('reopens only assignment-preview conflicts', () => {
    expect(
      reassignStaleReason({ status: 409, code: 'assignment_preview_stale', message: 'stale' }),
    ).toContain('Последствия изменились');
    expect(
      reassignStaleReason({ status: 426, code: 'client_upgrade_required', message: 'upgrade' }),
    ).toBeNull();
    expect(reassignStaleReason({ status: 409, code: 'version_conflict', message: 'version' })).toBe(
      null,
    );
  });
});
