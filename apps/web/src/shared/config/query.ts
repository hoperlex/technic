import type { DefaultOptions } from '@tanstack/react-query';

/**
 * Freshness of server data: the one module that holds the numbers and the defaults of the portal's
 * query client. `createQueryClient` (`@app/providers`) builds the client from them both for the
 * application and for every test, so a test measures the system that ships. Tests used to build
 * their own client where everything went stale at once and refetched on focus: a list reloaded by
 * itself on each mount, and a mutation that forgot to invalidate it still passed.
 *
 * A profile is a set of query options that a read takes as a whole. LIVE is the client default and
 * covers every read that does not name another profile: feeds, summaries, registers, record cards.
 * The other profiles of the stage 5 plan (SIGNAL, DICTIONARY, PICK, STATIC) belong here as well, as
 * objects that query factories spread; a freshness number written anywhere else is an exception and
 * has to say why next to it.
 */
export const QUERY_PROFILE = {
  LIVE: {
    /**
     * A mount within ten seconds of the last load reuses the data, a later one refetches. Nothing
     * else refreshes this class: what a colleague changed shows up on the next mount after the
     * term, so a longer term hides it longer. The user's own mutations invalidate regardless.
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
