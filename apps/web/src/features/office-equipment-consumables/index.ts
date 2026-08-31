/**
 * Работа со складом расходников: перечень позиций строками, правка остатка, журнал остатка и
 * правка потребности (план `docs/office-equipment-consumables-and-purchase-plan.md`, Р13, Р14).
 *
 * ПОЧЕМУ СЦЕНАРИЙ, А НЕ СЛАЙС СУЩНОСТИ. Дверей к этому складу стало две, и обе обязаны показывать
 * одно и то же: окно «Картриджи и тонеры» в «Справочниках», где номенклатуру **ведут**, и вкладка
 * «Расходники» раздела «Орг.техника», где со складом **работают** (Р14). Описание строки,
 * разложенное по двум страницам, разошлось бы на первой же правке — ровно так же, как разошёлся бы
 * журнал остатка, будь у него две ленты. Импорт соседней страницы линт границ запрещает прямо:
 * `pages` видит только то, что ниже него.
 *
 * В `entities/office-equipment` этот набор положить нельзя: перечень показывает дату последней
 * ручной правки, а `formatDateTime` живёт в неразложенном `utils/` — линт запрещает слою сущностей
 * зависеть от неразмеченного (`boundaries/no-unknown-dependencies`). Слой сценариев такой
 * зависимости не запрещает, и это единственное место, откуда обе двери видят один модуль.
 */
export {
  officeEquipmentConsumableColumns,
  type OfficeEquipmentConsumableGridActions,
} from './ui/officeEquipmentConsumableGrid';
export { officeEquipmentConsumableCard } from './ui/officeEquipmentConsumableCard';
export {
  ALREADY_ORDERED_HINT,
  CONSUMABLE_SORT_LABELS,
  DEFICIT_HINT,
  LAST_MANUAL_STOCK_HINT,
  PARK_COUNT_HINT,
  REQUIRED_HINT,
  STOCK_HINT,
} from './ui/officeEquipmentConsumableCells';
export { OfficeEquipmentStockModal } from './ui/OfficeEquipmentStockModal';
export { OfficeEquipmentStockHistoryModal } from './ui/OfficeEquipmentStockHistoryModal';
export { OfficeEquipmentRequiredModal } from './ui/OfficeEquipmentRequiredModal';
