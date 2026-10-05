import { vehicleRoutePath, type Permission } from '@technic/contracts';

/*
 * The right to follow a route number shown in someone else's list. A link has two halves that
 * drift apart when kept separately: the address ("which window to open") and the right to it
 * ("show the link at all"). This file holds the second half: the address lives in
 * packages/contracts/src/links.ts, and contracts deliberately know nothing about rights (the portal
 * has can, a letter has the recipient's visibility scope).
 *
 * A wrapper returns null when the target is not for this role, and the call site keeps rendering
 * the plain text it always had. A link leading where the role is not let in ends in an empty
 * screen, a redirect or a "not found" message, which is worse than a plain number.
 */

type Can = (permission: Permission) => boolean;

/**
 * Route card and route list of an own vehicle (ADR 0120, windows over the page). Both permissions
 * that guard the route endpoints are required: waybills.read because the route shows the driver
 * (ADR 0037 item 13), vehicleRequests.status because the route is run by whoever moves requests.
 *
 * The condition is the one the former "Routes" tab had; only the destination of the number changed.
 * The URL-window host (useRouteModalState in @features/route-modal) asks the same predicate for
 * direct URL entry: the link and the URL parameter are closed by one rule, otherwise a direct link
 * would open what the interface does not show.
 */
export const canOpenRoute = (can: Can): boolean =>
  can('waybills.read') && can('vehicleRequests.status');

/** Route card as a window over the page where the number was seen; null hides the link. */
export function vehicleRouteLink(can: Can, routeId: string): string | null {
  if (!canOpenRoute(can)) return null;
  return vehicleRoutePath(routeId);
}
