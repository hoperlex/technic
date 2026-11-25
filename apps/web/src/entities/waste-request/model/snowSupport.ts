import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WASTE_REQUEST_CAPABILITY_SNOW, type RequestType } from '@technic/contracts';
import { wasteRequestKeys } from '../api/keys';
import { wasteRequestsApi } from '../api/wasteRequestsApi';

/**
 * Does a capabilities reply confirm snow removal? The reply is checked by shape, not trusted by
 * type: an API from before snow routes the same path into `GET /waste-requests/:id`, and whatever
 * comes back from a server that does not know the route must not read as a confirmation.
 */
export function confirmsSnowSupport(reply: unknown): boolean {
  if (typeof reply !== 'object' || reply === null) return false;
  const capabilities = (reply as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) && capabilities.includes(WASTE_REQUEST_CAPABILITY_SNOW);
}

export interface SnowSupport {
  /**
   * The serving API confirmed snow and its latest check did not fail. Anything else — an older
   * API (no such route), a server that is temporarily unavailable, a check still in flight — is
   * "unconfirmed", and the portal neither offers snow nor sends snow queries and new snow
   * submissions (snow-removal plan, §3.5).
   */
  supported: boolean;
  /** No answer yet: the screen waits instead of declaring snow unavailable. */
  checking: boolean;
  /** Ask again now — on entry to a filter, where there is no window to open. */
  recheck: () => void;
}

/**
 * Snow support of the serving API, asked while `active` and asked AGAIN every time `active`
 * turns on — opening the editor, the stats tab, a type filter or a snow card (§3.5). Rechecking at
 * those moments rather than trusting one answer per session is the point: the portal can outlive
 * a rollback of the API (`deploy-auto --previous`), and a cached "yes" would then send snow forms
 * to a server that rejects them.
 *
 * A failed recheck withdraws an earlier confirmation (`status` turns to error while the old data
 * stays cached), which is the safe direction: snow is hidden until a check succeeds again.
 */
export function useSnowSupport(active: boolean): SnowSupport {
  const query = useQuery({
    queryKey: wasteRequestKeys.capabilities(),
    queryFn: () => wasteRequestsApi.capabilities(),
    enabled: active,
  });
  const { refetch } = query;
  useEffect(() => {
    // `cancelRefetch: false` joins the fetch the observer has just started on mount instead of
    // aborting it, so an opening costs one request, not two.
    if (active) void refetch({ cancelRefetch: false });
  }, [active, refetch]);
  const supported = query.status === 'success' && confirmsSnowSupport(query.data);
  return {
    supported,
    checking: !supported && query.fetchStatus === 'fetching',
    recheck: () => void refetch({ cancelRefetch: false }),
  };
}

/**
 * Request types the portal may offer for a NEW choice: snow only after the API confirmed it.
 * A saved snow request keeps its own type in the list (`keep`), otherwise its editor or filter
 * would show an empty field instead of «Вывоз снега».
 */
export function offeredRequestTypes<T extends RequestType>(
  types: readonly T[],
  snowSupported: boolean,
  keep?: RequestType | null,
): T[] {
  return types.filter((type) => type !== 'snow_removal' || snowSupported || keep === type);
}
