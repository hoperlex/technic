import type { WeeklyRequestItemDto } from '@technic/contracts';
import { isApiError } from '@shared/api';

/**
 * Per-row refusal reasons from a 422 "applied to no row" answer (section 9). They cannot be shown
 * in one toast: specific rows must be fixed, and the person must see which ones without matching
 * the list against the table by eye.
 *
 * The server keys a reason either by the row itself (its id) or by its place in the sent array
 * (items.3, the path zod uses for fields). Both are parsed: the endpoint is written by another
 * stream, and relying on one spelling would lose reasons silently.
 */
export function weeklySkipReasonsFromError(
  error: unknown,
  items: WeeklyRequestItemDto[],
): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!isApiError(error) || !error.fields) return reasons;
  for (const [path, message] of Object.entries(error.fields)) {
    const byId = items.find((item) => item.id === path);
    if (byId) {
      reasons.set(byId.id, message);
      continue;
    }
    const index = /(?:^|\.)(\d+)(?:\.|$)/.exec(path)?.[1];
    const byIndex = index != null ? items[Number(index)] : undefined;
    if (byIndex) reasons.set(byIndex.id, message);
  }
  return reasons;
}
