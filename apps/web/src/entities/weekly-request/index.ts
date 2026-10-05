/**
 * Weekly vehicle request (docs/adr/0085-weekly-vehicle-request.md): a base document above vehicle
 * orders; the site orders a whole week rather than a vehicle for a term. The slice holds query
 * keys, endpoints and the shared weekly vocabulary; pages take them from here directly, since the
 * common endpoint registry they used to go through no longer exists.
 */
export { weeklyRequestKeys } from './api/keys';
export { weeklyRequestsApi } from './api/weeklyRequestsApi';
export { weeklyRequestErrorMessage } from './model/errorMessage';
export {
  pastWeekSelectOptions,
  weeklyOverdueWord,
  weeklyPreviousText,
  weeklyBackdateAccess,
  weeklyRequestPath,
  weeklyToday,
  weekSelectOptions,
} from './model/weeklyPresentation';
export { weeklySkipReasonsFromError } from './model/skipReasons';
export { WeeklyItemWarnings, WeeklyStatusTag, weeklyCountsText } from './ui/presentation';
export type {
  WeeklyDecisionResultDto,
  WeeklyRequestHistoryEntryDto,
  WeeklyRequestHistoryEvent,
} from './api/weeklyRequestsApi';
