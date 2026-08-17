/**
 * Ведение техобслуживания машины (план «Показания техники», Р10—Р15): блок обслуживания, форма
 * записи и вход в сводку из списка техники.
 *
 * Сценарий, а не сущность: здесь знают про право текущего пользователя (`vehicleMaintenance.read`
 * решает, будет ли вообще запрос) и про загрузку скана в хранилище — ни того, ни другого слой
 * сущностей не знает. Данные приходят из `@entities/vehicle-maintenance`.
 *
 * Потребителей у сценария трое, и все зовут одно и то же (Р15): карточка машины в сводке показаний
 * ставит блок композицией к своей статистике (Р14а), справочник техники и колонка гаража открывают
 * тот же блок окном из строки (Р14в). Оба списка называют открытую машину одним ключом адреса —
 * `useMaintenanceAddress`.
 */
export { VehicleMaintenanceBlock } from './ui/VehicleMaintenanceBlock';
export { VehicleMaintenanceModal, type MaintenanceVehicle } from './ui/VehicleMaintenanceModal';
export { useVehicleMaintenanceAction } from './ui/useVehicleMaintenanceAction';
export { useMaintenanceAddress } from './model/maintenanceAddress';
