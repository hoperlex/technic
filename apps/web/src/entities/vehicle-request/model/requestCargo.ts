import type { VehicleRequestDto } from '@technic/contracts';

/**
 * "Sand, crushed stone": what a freight request carries, for the list row and the card overview
 * (ADR 0239). The name lives on each trip, so a request summary is the distinct names in trip
 * order; "repeat N times" produces six rows of one cargo, and listing it six times would bury the
 * second one.
 *
 * Empty for an on-site order and for a request whose trips are all older than the field: both
 * places then hide the line instead of printing a dash, so an old request looks as it did.
 */
export function requestCargoNames(request: VehicleRequestDto): string {
  if (request.requestType !== 'freight_transport') return '';
  // Tolerant of a row without trips or names, like `requestContacts`: a list row is not the place
  // to assert the DTO shape, and one malformed row must not take the whole table down.
  const names = (request.trips ?? []).map((trip) => trip.cargoName?.trim()).filter(Boolean);
  return [...new Set(names)].join(', ');
}
