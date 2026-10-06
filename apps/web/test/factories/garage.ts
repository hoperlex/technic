import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleReadingDayState,
} from '@technic/contracts';

/**
 * A row of the garage day slice as the server sends it: the contract row plus the reading state
 * of the day (ADR 0103, R27). The portal widens the type in `pages/garage/vehicleColumns.tsx`
 * until the field moves into the contract; a fixture without it would render a tag with no label.
 */
export type GarageVehicleRow = GarageVehicleDto & { readingState: VehicleReadingDayState };

/** A free own vehicle with no drivers and no odometer reading: nothing on the row asks for more. */
export function garageVehicle(overrides: Partial<GarageVehicleRow> = {}): GarageVehicleRow {
  return {
    id: 'v-1',
    label: 'Е646СК799',
    state: 'free',
    status: 'active',
    registrationNumber: 'Е646СК799',
    garageNumber: '',
    modelName: null,
    vehicleTypeId: 'vt-1',
    typeName: 'Самосвалы',
    vehicleCategoryId: null,
    categoryName: null,
    drivers: [],
    busy: [],
    readingState: 'reported',
    lastOdometer: null,
    ...overrides,
  };
}

/**
 * `GET /garage/vehicles`. `onDate` is the day the server built the rows for and comes back even
 * when the client sent none: labels like "day 3 of 5" count from it, so a fixture should answer
 * with the day the request asked for.
 */
export function garageVehicleList(
  items: GarageVehicleRow[],
  onDate: string,
  overrides: Partial<GarageVehicleListDto> = {},
): GarageVehicleListDto {
  return { items, total: items.length, page: 1, pageSize: 50, onDate, ...overrides };
}

/** `GET /garage/vehicles/summary`: the counts of the same day, everything zero by default. */
export function garageVehiclesSummary(
  onDate: string,
  overrides: Partial<GarageVehiclesSummaryDto> = {},
): GarageVehiclesSummaryDto {
  return {
    total: 0,
    free: 0,
    onRoute: 0,
    onSite: 0,
    unavailable: 0,
    routesWithoutDriver: 0,
    onDate,
    ...overrides,
  };
}
