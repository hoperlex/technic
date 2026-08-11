/**
 * Заявка на обслуживание оргтехники (ADR 0085): что сломалось, кто чинит, во сколько это встало
 * и чем подтверждено. Здесь — обращение к ручкам модуля, ключи запросов, признаки ожидания и
 * теги, которыми состояние заявки читается одинаково в списке, карточке и окнах действий.
 *
 * Правил портала слайс не знает: кто ждёт «меня» и что субъекту разрешено, считают функции
 * контрактов у тех, кому видна учётка (features и pages). Снаружи берут
 * `@entities/service-request` — внутренние модули не видны, и перестроить слайс можно, не трогая
 * ни раздел, ни окна действий.
 */
export { serviceRequestsApi } from './api/serviceRequestsApi';
export { serviceCompanyKeys, serviceRequestKeys } from './api/keys';
export { serviceCompanyOptionsQuery } from './api/queries';
export {
  isServiceRequestOverdue,
  serviceTodoLabel,
  statusAgeDays,
  statusAgeLabel,
} from './model/waiting';
export {
  isAwaitingDocuments,
  missingClosingDocuments,
  serviceDocumentCounts,
} from './model/documents';
export { ServiceEstimateTable } from './ui/ServiceEstimateTable';
export { ServiceRequestContext } from './ui/ServiceRequestContext';
export { ServiceStatusTag } from './ui/ServiceStatusTag';
export { UrgentTag } from './ui/UrgentTag';
export { WaitingOnTag } from './ui/WaitingOnTag';
