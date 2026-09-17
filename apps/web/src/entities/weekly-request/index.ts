/**
 * Недельная заявка на технику (ADR 0085): документ-основание над заказами ТС — площадка заказывает
 * не машину на срок, а неделю целиком. Слайс держит ключи запросов и сами ручки; страницы зовут их
 * по-прежнему через `api/resources.ts`, который их переизлучает.
 */
export { weeklyRequestKeys } from './api/keys';
export { weeklyRequestsApi } from './api/weeklyRequestsApi';
export type {
  WeeklyDecisionResultDto,
  WeeklyRequestHistoryEntryDto,
  WeeklyRequestHistoryEvent,
} from './api/weeklyRequestsApi';
