/**
 * Кандидат на добавление техники (план `docs/office-equipment-candidate-plan.md`, ADR 0085):
 * сообщение заявителя «в кабинете 214 стоит вот это», которое проходит проверку и только решением
 * человека с `officeEquipment.write` превращается в карточку парка.
 *
 * СВОЯ СУЩНОСТЬ, А НЕ СРЕЗ СПРАВОЧНИКА (Р1). До решения записи в парке не существует вовсе: у
 * кандидата другая область видимости, другой цикл жизни и другой набор реквизитов — шесть
 * наблюдаемых вместо одиннадцати учётных. Вписанный в слайс `office-equipment`, он оплачивался бы
 * исключением в каждом его читателе — списке, карточке, селекторе формы заявки, счётчиках моделей
 * и расходников.
 *
 * Снаружи берут `@entities/office-equipment-candidate` — внутренние модули слайса не видны.
 */
export { officeEquipmentCandidatesApi } from './api/officeEquipmentCandidatesApi';
export { officeEquipmentCandidateKeys } from './api/keys';
export { officeEquipmentCandidatePendingCountQuery } from './api/queries';
/**
 * Состояние непроверенного предмета в самой заявке. В слое сущности, а не у карточки заявки: тот же
 * ответ читают плашка предмета, замок приёмки в меню и подпись заявителю (Р16, §9).
 */
export {
  isSubjectCheckPending,
  serviceRequestSubjectCheck,
  subjectCheckNotice,
  subjectCheckTitle,
  type ServiceRequestSubjectCheck,
} from './model/subject';
