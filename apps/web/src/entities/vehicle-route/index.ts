/**
 * Рейс машины на дату. Пока слайс держит ключи запросов и правило чтения закреплённых прицепов:
 * сами ручки живут в `api/resources.ts` и переедут вместе с ним.
 */
export { vehicleRouteKeys, vehicleTypesForTrailerKey } from './api/keys';
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
