/**
 * The equipment classifier: what a machine IS before it becomes a particular machine — kind, type,
 * the type's specs, category and the position list assembled from them (ADR 0016, ADR 0028).
 * Outside code takes `@entities/vehicle-type`; the slice's inner modules stay invisible, so it can
 * be rebuilt without touching consumers.
 *
 * Five endpoint groups in one slice is a stage-2 decision (docs/frontend-fsd-stage-2.md §2.1), and
 * it does not rest on brevity: the rule "no common type is derived once categories exist" is one
 * rule for all five, and a slice per group would have needed same-layer neighbour imports from day
 * one.
 *
 * The machines themselves (`vehiclesApi`, `vehicleModelsApi`) do not belong here — that is the
 * neighbouring `vehicle` slice. The border follows the question: here we answer "what kinds of
 * equipment exist", there "which equipment we have".
 *
 * The plan puts `useVehicleClassifications` here too, but the hook stayed in `hooks/`: it sits in
 * the deferred list (`apps/web/scripts/check-stage2-layout.mjs`) next to
 * `useVehicleClassificationFilter`, and the two have to move together — the filter is built on the
 * same position set. The hook already takes its key from this slice
 * (`vehicleClassificationKeys.forSelect`), so the move stays a file move and shifts no cache cell.
 */
export {
  vehicleCategoriesApi,
  vehicleClassificationsApi,
  vehicleKindsApi,
  vehicleSpecsApi,
  vehicleTypesApi,
} from './api/vehicleTypesApi';
export {
  vehicleCategoryKeys,
  vehicleClassificationKeys,
  vehicleKindKeys,
  vehicleSpecKeys,
  vehicleTypeKeys,
  vehicleTypeSpecKeys,
} from './api/keys';

/*
 * Классификатор позиций и фильтр по нему. Ключ запросов хук брал у этого слайса ещё до переезда,
 * поэтому перенос не сдвинул ни одной ячейки кэша. Хук и фильтр выведены вместе: фильтр построен на
 * том же наборе позиций, и порознь они дали бы два разных представления об одном наборе.
 */
export {
  classificationFilterGroups,
  classificationGroups,
  classificationKeyOf,
  useVehicleClassifications,
  withSavedClassification,
  type VehicleClassificationGroup,
  type VehicleClassificationOption,
} from './model/useVehicleClassifications';
export { useVehicleClassificationFilter } from './ui/useVehicleClassificationFilter';
