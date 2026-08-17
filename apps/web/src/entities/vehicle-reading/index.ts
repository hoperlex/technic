/**
 * Показания техники (ADR 0103): сколько машина прошла, сколько наработала и сколько в неё залили —
 * по дням, по месяцам и по всему парку.
 *
 * Слайс заведён потому, что экранов у этих данных стало три (Р19): сводка парка, карточка машины и
 * реестр приёма. Клиент, живший рядом с одним из них, второму был бы соседом по слою — импорт,
 * который границы запрещают, — а третий завёл бы себе свою копию ключей, и приёмка перестала бы
 * гасить кэш статистики.
 *
 * Снаружи берут `@entities/vehicle-reading` — внутренние модули слайса не видны.
 */
export { vehicleReadingsApi, type VehicleReadingStatsDto } from './api/vehicleReadingsApi';
export { vehicleReadingKeys } from './api/keys';
/**
 * Правила ввода показаний. Лежат в слайсе по той же причине, что и клиент: вводят их из двух мест
 * — кабинет водителя и карточка отчёта в гараже, — а экраны эти лежат на одном слое и друг друга
 * не видят. Оставь пороги у одного — второй завёл бы свои, и «странное число» разошлось бы с
 * «странным числом».
 */
export {
  ENGINE_HOURS_MAX,
  ENGINE_HOURS_WARN_PER_DAY,
  FUEL_MAX_LITERS,
  ODOMETER_MAX_KM,
  ODOMETER_WARN_KM_PER_DAY,
  formatReading,
  parseReadingNumber,
  previousHintText,
  readingWarnings,
  type ReadingField,
  type ReadingValue,
  type ReadingWarning,
} from './model/readingLimits';
