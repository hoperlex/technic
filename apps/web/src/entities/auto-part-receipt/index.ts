/**
 * Чеки на автозапчасти (план `docs/auto-part-receipts-plan.md`, ADR 0154): скан бумаги плюс
 * строки «техника — наименование — количество — сумма». Раздел отвечает на один вопрос — «сколько
 * вложено в эту машину».
 *
 * Слайс сущности: запросы, ключи кэша и матрица их гашения. Компонентов здесь нет вовсе — вкладка,
 * окна и колонка знают про права смотрящего и про загрузку файлов, а слой сущностей ни того, ни
 * другого не знает. Правил предмета здесь тоже нет: границы полей, обязательность скана и запрет
 * на присланный итог живут в контрактах одной копией на портал и сервер (§6).
 *
 * Снаружи берут `@entities/auto-part-receipt` — внутренние модули слайса не видны.
 */
export { autoPartReceiptApi, type VehiclePartsSpendSnapshotResult } from './api/autoPartReceiptApi';
export {
  autoPartReceiptInvalidation,
  autoPartReceiptKeys,
  ownVehicleKeys,
  type AutoPartReceiptCacheChange,
} from './api/keys';
