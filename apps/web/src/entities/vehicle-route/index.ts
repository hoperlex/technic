/**
 * Рейс машины на дату. Пока слайс держит ключи запросов и правило чтения закреплённых прицепов:
 * сами ручки живут в `api/resources.ts` и переедут вместе с ним.
 */
export { vehicleRouteKeys, vehicleTypesForTrailerKey } from './api/keys';
export {
  emptyTrailerGraphs,
  graphsAreHitched,
  hitchedTrailerGraphs,
  hitchedTrailerNote,
  inheritedTrailerGraphs,
  sameTrailerGraphs,
  TRACTOR_TRAILER_HINT,
  TRACTOR_TRAILERS_TYPE_CODE,
  type TrailerGraphs,
} from './model/hitchedTrailers';
