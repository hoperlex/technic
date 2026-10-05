import { RENTAL_STATUSES, VEHICLE_STATUSES, vehicleStatusLabels } from '@technic/contracts';

/** Status options shared by the vehicle editor and registry filters. */
export const vehicleStatusOptions = VEHICLE_STATUSES.map((status) => ({
  value: status,
  label: vehicleStatusLabels[status],
}));

/** Rental offers have the smaller lifecycle defined by ADR 0018. */
export const rentalVehicleStatusOptions = RENTAL_STATUSES.map((status) => ({
  value: status,
  label: vehicleStatusLabels[status],
}));
