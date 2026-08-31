/**
 * Оргтехника: единица учёта — что стоит по кабинетам и площадкам, за каким отделом закреплено и до
 * какого числа действует гарантия поставщика (ADR 0085). Здесь же перечень типов: сам по себе тип
 * ничего не значит и своей сущностью не становится (Р34).
 *
 * Снаружи берут `@entities/office-equipment` — внутренние модули слайса не видны, и перестроить
 * его можно, не трогая ни вкладку справочника, ни будущий модуль заявок на обслуживание.
 */
export {
  officeEquipmentApi,
  officeEquipmentConsumablesApi,
  officeEquipmentModelsApi,
  officeEquipmentTypesApi,
} from './api/officeEquipmentApi';
/**
 * Плановая закупка расходников (ADR 0146). В этом же слайсе, а не в своём: документ живёт только
 * при номенклатуре — он состоит из её позиций, считается по её остатку и потребности и открывается
 * с той же вкладки. Отдельный слайс развёл бы по двум входам то, что всегда зовут вместе.
 */
export { officeEquipmentPurchasesApi } from './api/officeEquipmentPurchasesApi';
export {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
  officeEquipmentPurchaseKeys,
  officeEquipmentTypeKeys,
} from './api/keys';
export {
  officeEquipmentActiveConsumablesQuery,
  officeEquipmentConsumablePickerQuery,
  officeEquipmentModelOptionsQuery,
  officeEquipmentModelPickerQuery,
  officeEquipmentOptionsQuery,
  officeEquipmentTypeOptionsQuery,
} from './api/queries';
export { EquipmentStateTag } from './ui/EquipmentStateTag';
/**
 * Список единиц: колонки таблицы и карточка строки на телефоне. В слое сущности, а не у вкладки
 * справочника, потому что потребителей стало два — справочник, где карточку ведут, и вкладка
 * «Техника» раздела «Орг.техника», где её эксплуатируют (Р73). Два описания одной строки разъехались
 * бы при первой правке.
 */
export {
  officeEquipmentCard,
  officeEquipmentColumns,
  numbersLine,
  type OfficeEquipmentGridActions,
} from './ui/officeEquipmentGrid';
export { WarrantyTag } from './ui/WarrantyTag';
/**
 * Поля карточки единицы. Живут в слое сущности, а не у вкладки справочника: заводят единицу из
 * двух мест — из самого справочника и из формы заявки, когда техники в списке не нашлось, — и два
 * набора одиннадцати полей с правилом «нужен хотя бы один номер» разъехались бы при первой правке.
 */
export { OfficeEquipmentFields } from './ui/OfficeEquipmentFields';
/**
 * Форма модели аппарата (Р1). В слое сущности по той же причине, что и поля карточки: заводят
 * модель из двух мест — из окна «Модели аппаратов» и из самой карточки техники, когда нужной
 * модели в перечне не нашлось.
 */
export { OfficeEquipmentModelFormModal } from './ui/OfficeEquipmentModelFormModal';
export {
  officeEquipmentPayload,
  officeEquipmentUpdatePayload,
  type OfficeEquipmentFormValues,
} from './model/form';
