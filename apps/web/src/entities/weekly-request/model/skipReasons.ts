import type { WeeklyRequestItemDto } from '@technic/contracts';
import { isApiError } from '@shared/api';

/** Map either item ids or indexed API field paths back to the saved weekly-request rows. */
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
