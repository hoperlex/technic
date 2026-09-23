/**
 * Недельная заявка на технику (ADR 0085): документ-основание над заказами ТС — площадка заказывает
 * не машину на срок, а неделю целиком. Слайс держит ключи запросов и сами ручки; страницы берут их
 * отсюда напрямую — общего реестра ручек, через который они шли прежде, больше нет.
 */
export { weeklyRequestKeys } from './api/keys';
export { weeklyRequestsApi } from './api/weeklyRequestsApi';
export type {
  WeeklyDecisionResultDto,
  WeeklyRequestHistoryEntryDto,
  WeeklyRequestHistoryEvent,
} from './api/weeklyRequestsApi';
