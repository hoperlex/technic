/**
 * A vehicle's route for a date: request composition, stop order and issuing a waybill from the
 * assembled route. Consumers import `@entities/vehicle-route` only — the slice's internal modules
 * are hidden, so it can be restructured without touching consumers.
 *
 * Endpoints, query keys and the rule for reading hitched trailers sit together not for tree
 * tidiness: all three describe one response. The `GET /vehicle-routes/suggest` hint is requested
 * by five route-creation windows, they share its cache by its key, and trailers arrive in its
 * `hitched` field — if these three things drifted apart, the windows would start reading the same
 * response differently.
 *
 * `issueWaybill` creates a waybill, yet this slice neither needs nor may import
 * `@entities/waybill`: the waybill journal is a same-layer neighbour, and the endpoint answers
 * with the whole route without a single type from there. The issued waybill is fetched at its own
 * address — that is what keeps the boundary intact.
 */
export { vehicleRouteKeys, vehicleTypesForTrailerKey } from './api/keys';
export { vehicleRoutesApi } from './api/vehicleRoutesApi';
export { vehicleRouteErrorMessage } from './model/errorMessage';
export {
  emptyTrailerGraphs,
  foreignHitchWarning,
  graphsAreHitched,
  hitchedTrailerGraphs,
  hitchedTrailerNote,
  inheritedTrailerGraphs,
  MANUAL_TRAILER_MODES,
  sameTrailerGraphs,
  substitutedTrailerModes,
  TRACTOR_TRAILER_HINT,
  TRACTOR_TRAILERS_TYPE_CODE,
  TRAILER_DIRECTORY_HINT,
  type TrailerGraphs,
  type TrailerGraphsAction,
  trailerGraphsFilled,
  type TrailerSlotMode,
  type TrailerSlotModes,
  type TrailerSubstitution,
  trailerSubstitution,
} from './model/hitchedTrailers';

/*
 * The right to navigate to a route by its number (ADR 0120). It lives here, not in the lists that
 * print the number: the route opens as a window from five different places, and the condition for
 * showing the link must be shared by all of them and match the condition under which the window
 * opens by URL.
 */
export { canOpenRoute, vehicleRouteLink } from './model/links';
export { trailerTripBody, type TrailerTripInput } from './model/trailerTrip';
export {
  actionLabel,
  actionPairLabel,
  assembleRoute,
  blockerMessage,
  mergeHintMessage,
  pointRoleInputOf,
  reorderedPointRoles,
  routeCompositionRefs,
  type PointMergeHint,
  type RouteAssembly,
} from './model/routeAssembly';
