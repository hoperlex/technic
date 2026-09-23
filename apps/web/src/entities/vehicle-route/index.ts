/**
 * Рейс машины на дату: состав заявок, порядок объезда и выписка путевого листа с собранного
 * рейса. Снаружи берут `@entities/vehicle-route` — внутренние модули слайса не видны, и
 * перестроить его можно, не трогая потребителей.
 *
 * Ручки, ключи запросов и правило чтения закреплённых прицепов лежат вместе не ради порядка в
 * дереве: все трое говорят об одном ответе. Подсказку `GET /vehicle-routes/suggest` спрашивают
 * пять окон заведения рейса, её же ключом они делят кэш, и прицепы приходят её полем `hitched` —
 * разъедься эти три вещи по разным местам, и окна начали бы читать один ответ по-разному.
 *
 * `issueWaybill` рождает путевой лист, но `@entities/waybill` слайсу не нужен и импортироваться не
 * может: журнал листов — сосед по слою, а ручка отвечает рейсом целиком, без единого типа оттуда.
 * Выписанный лист берут по своему адресу — тем и держится граница.
 */
export { vehicleRouteKeys, vehicleTypesForTrailerKey } from './api/keys';
export { vehicleRoutesApi } from './api/vehicleRoutesApi';
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
