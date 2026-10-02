import { vehicleRoutePath, type Permission } from '@technic/contracts';

type Can = (permission: Permission) => boolean;

/**
 * Route cards expose a driver and operational requests, so both source permissions are required.
 * The feature host uses the same predicate for direct URL entry; links and deep links must never
 * disagree about whether the destination exists for a role.
 */
export const canOpenRoute = (can: Can): boolean =>
  can('waybills.read') && can('vehicleRequests.status');

/** Return the URL-backed route window path only when the caller may open that record. */
export function vehicleRouteLink(can: Can, routeId: string): string | null {
  if (!canOpenRoute(can)) return null;
  return vehicleRoutePath(routeId);
}
