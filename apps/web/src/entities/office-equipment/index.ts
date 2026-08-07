/**
 * Оргтехника: единица учёта — что стоит по кабинетам и площадкам, за каким отделом закреплено и до
 * какого числа действует гарантия поставщика (ADR 0085). Здесь же перечень типов: сам по себе тип
 * ничего не значит и своей сущностью не становится (Р34).
 *
 * Снаружи берут `@entities/office-equipment` — внутренние модули слайса не видны, и перестроить
 * его можно, не трогая ни вкладку справочника, ни будущий модуль заявок на обслуживание.
 */
export { officeEquipmentApi, officeEquipmentTypesApi } from './api/officeEquipmentApi';
export { officeEquipmentKeys, officeEquipmentTypeKeys } from './api/keys';
export { officeEquipmentOptionsQuery, officeEquipmentTypeOptionsQuery } from './api/queries';
export { WarrantyTag } from './ui/WarrantyTag';
