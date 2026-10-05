import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasChunkLoadFailure, onChunkLoadFailure, requireChunkReload } from './chunkRecovery';

const POLL_INTERVAL_MS = 10 * 60_000;

// Keep polling after a dismissal: a later release must still offer its own update. Only an id
// different from this document's embedded build is published; check on mount, focus and visibility
// return as well as every ten minutes, since a sleeping tab can outlive several deployments.
export const useVersionCheck = (): { latestBuildId: string | null; chunkLoadFailed: boolean } => {
  const [latestBuildId, setLatestBuildId] = useState<string | null>(null);
  const chunkLoadFailed = useSyncExternalStore(
    onChunkLoadFailure,
    hasChunkLoadFailure,
    hasChunkLoadFailure,
  );

  useEffect(() => {
    // Vite emits this before rejecting a preload. Suppress the unhandled rejection and retain a
    // sticky signal even if lazy() subsequently sees a different error after the cancelled event.
    const onPreloadError = (event: Event) => {
      event.preventDefault();
      requireChunkReload();
    };
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return; // The development server does not emit version.json.

    let cancelled = false;
    let inFlight = false;
    let timer = 0;

    const check = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data: unknown = await res.json();
        const id = (data as { buildId?: unknown })?.buildId;
        if (!cancelled && typeof id === 'string' && id && id !== __BUILD_ID__) {
          setLatestBuildId((prev) => (prev === id ? prev : id));
        }
      } catch {
        // Offline, 404 or invalid JSON is not evidence of a newer release.
      } finally {
        inFlight = false;
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    timer = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  return { latestBuildId, chunkLoadFailed };
};
