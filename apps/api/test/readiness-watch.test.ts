import { describe, expect, it, vi } from 'vitest';
import { readinessStreak } from '../src/lib/readiness-watch';

/**
 * The readiness streak that ends the process. Both thresholds matter: Docker's 30-second checks
 * reach three failures in a minute, while `deploy-auto` fires five checks in fifteen seconds after
 * recreating the container, and those alone must never end it.
 */
function streak() {
  let clock = 0;
  const onLost = vi.fn();
  const record = readinessStreak({
    minFailures: 3,
    minSpanMs: 60_000,
    onLost,
    now: () => clock,
  });
  const at = (ms: number, ready: boolean) => {
    clock = ms;
    record(ready);
  };
  return { at, onLost };
}

describe('readinessStreak', () => {
  it("reports the third failure of Docker's checks, a minute after the first", () => {
    const { at, onLost } = streak();
    at(0, false);
    at(30_000, false);
    expect(onLost).not.toHaveBeenCalled();
    at(60_000, false);
    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith({ failures: 3, spanMs: 60_000 });
  });

  it('ignores a burst of failures shorter than the span', () => {
    const { at, onLost } = streak();
    for (let i = 0; i < 5; i += 1) at(i * 3_000, false);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('starts over after a success', () => {
    const { at, onLost } = streak();
    at(0, false);
    at(30_000, false);
    at(60_000, true);
    at(90_000, false);
    at(120_000, false);
    expect(onLost).not.toHaveBeenCalled();
    at(150_000, false);
    expect(onLost).toHaveBeenCalledOnce();
  });

  it('reports a lost streak only once', () => {
    const { at, onLost } = streak();
    for (let i = 0; i < 10; i += 1) at(i * 30_000, false);
    expect(onLost).toHaveBeenCalledOnce();
  });
});
