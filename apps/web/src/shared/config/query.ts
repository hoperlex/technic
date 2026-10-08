import type { DefaultOptions, Query } from '@tanstack/react-query';

/**
 * Freshness of server data: the one module that holds the numbers and the defaults of the portal's
 * query client. `createQueryClient` (`@app/providers`) builds the client from them both for the
 * application and for every test, so a test measures the system that ships. Tests used to build
 * their own client where everything went stale at once and refetched on focus: a list reloaded by
 * itself on each mount, and a mutation that forgot to invalidate it still passed.
 *
 * A profile is a set of query options that a read takes as a whole. LIVE is the client default and
 * covers every read that does not name another profile: feeds, summaries, registers, record cards.
 * SIGNAL, DICTIONARY and STATIC live here as objects that query factories spread; PICK is added
 * with the deferred selectors in wave 5. A freshness number written anywhere else is an exception
 * and has to say why next to it.
 */
export const QUERY_PROFILE = {
  LIVE: {
    /**
     * A mount within ten seconds of the last load reuses the data, a later one refetches. Apart
     * from the user's own mutations, which invalidate regardless of the term, and a reconnect,
     * nothing else refreshes this class: what a colleague changed shows up on the next mount after
     * the term, so a longer term hides it longer.
     */
    staleTime: 10_000,
    /** The library default, written out: an unobserved entry keeps its data for five minutes. */
    gcTime: 5 * 60_000,
    /**
     * Returning to the browser tab does not refetch: a refetch under an open form may reset input
     * that is not saved yet. Turning it on is the plan's open question R1 and needs the form
     * protection of wave 1 first.
     */
    refetchOnWindowFocus: false,
    /** The library default, written out: once the network is back, mounted reads refetch. */
    refetchOnReconnect: true,
  },
  SIGNAL: {
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    meta: { profile: 'SIGNAL' },
  },
  DICTIONARY: {
    staleTime: 30 * 60_000,
    gcTime: 35 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    meta: { profile: 'DICTIONARY' },
  },
  STATIC: {
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { profile: 'STATIC' },
  },
} as const;

/**
 * Defaults of the portal's query client. Retries are kept out of the LIVE profile: a profile says
 * how old data may be, not how a failed request is handled, and every profile shares this policy.
 */
export const QUERY_CLIENT_DEFAULTS = {
  queries: {
    ...QUERY_PROFILE.LIVE,
    retry: 1,
  },
  mutations: {
    /**
     * The library default, written out: a command is never repeated, because its response may be
     * lost after the server applied it, and the repeat would apply it twice.
     */
    retry: false,
  },
} as const satisfies DefaultOptions;

/**
 * A section switch refreshes mounted section reads, including panes visited earlier. Shell reads
 * live outside the section: SIGNAL has its own focus policy, and a shell query with another
 * freshness policy opts out in its canonical query factory.
 */
export function shouldRefreshSectionTabQuery(query: Query): boolean {
  return query.meta?.profile !== 'SIGNAL' && query.meta?.sectionTabRefresh !== false;
}

/**
 * Projection views share an entry with their owner factory. They must carry the owner's cache
 * metadata and freshness options, because a later observer can overwrite the entry's metadata.
 */
type ProfileFields =
  'staleTime' | 'gcTime' | 'refetchOnWindowFocus' | 'refetchOnReconnect' | 'meta';

export function queryProfileOptions<T extends Partial<Record<ProfileFields, unknown>>>(
  base: T,
): Pick<T, ProfileFields> {
  return {
    staleTime: base.staleTime,
    gcTime: base.gcTime,
    refetchOnWindowFocus: base.refetchOnWindowFocus,
    refetchOnReconnect: base.refetchOnReconnect,
    meta: base.meta,
  } as Pick<T, ProfileFields>;
}
