/**
 * Классификатор техники: чем машина является, прежде чем стать конкретной машиной, — вид, тип,
 * ТТХ типа, категория и сведённый из них список позиций (ADR 0016, ADR 0028). Снаружи берут
 * `@entities/vehicle-type` — внутренние модули слайса не видны, и перестроить его можно, не трогая
 * потребителей.
 *
 * Пять ручек одним слайсом — решение этапа 2 (docs/frontend-fsd-stage-2.md §2.1), и держится оно
 * не на краткости: правило «общий тип при наличии категорий не выводится» одно на все пять, и
 * слайс на каждую ручку потребовал бы импортов соседа по слою с первого дня.
 *
 * Сами машины (`vehiclesApi`, `vehicleModelsApi`) сюда не входят: это соседний слайс `vehicle`.
 * Граница проходит по вопросу — здесь отвечают «что за техника бывает», там «какая техника есть».
 *
 * `useVehicleClassifications` план кладёт сюда же, но хук остался в `hooks/`: он живёт в списке
 * отложенного (`apps/web/scripts/check-stage2-layout.mjs`) вместе с `useVehicleClassificationFilter`,
 * и переезжать им вдвоём — фильтр построен на том же наборе позиций. До переезда ключ
 * `vehicleClassificationKeys.forSelect` потребителей не имеет: хук собирает его литералом.
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
