/**
 * Readiness that keeps failing ends the process.
 *
 * Docker marks the container unhealthy after five failed checks and does nothing more: the restart
 * policy `unless-stopped` acts only on an exit. On 26.10.2026 the label stood for twenty minutes
 * until a person restarted the container by hand. So the process counts its own readiness checks,
 * and after a streak that no failover lasts it exits, and Docker starts a fresh process.
 *
 * A streak needs both a count and a span. `deploy-auto` asks readiness five times within fifteen
 * seconds after recreating the container, and a count alone would turn one slow start into an exit.
 */

export interface LostReadiness {
  failures: number;
  spanMs: number;
}

export function readinessStreak(options: {
  minFailures: number;
  minSpanMs: number;
  onLost: (streak: LostReadiness) => void;
  now?: () => number;
}): (ready: boolean) => void {
  const now = options.now ?? Date.now;
  let failures = 0;
  let since = 0;
  let lost = false;
  return (ready) => {
    if (ready) {
      failures = 0;
      return;
    }
    if (failures === 0) since = now();
    failures += 1;
    const spanMs = now() - since;
    if (lost || failures < options.minFailures || spanMs < options.minSpanMs) return;
    lost = true;
    options.onLost({ failures, spanMs });
  };
}

let record: ((ready: boolean) => void) | undefined;

/**
 * The readiness route reports every check here. Only the server process arms a reaction: the same
 * route runs in tests and must not end the test runner.
 */
export function noteReadiness(ready: boolean): void {
  record?.(ready);
}

export function armReadinessWatch(watch: (ready: boolean) => void): void {
  record = watch;
}
