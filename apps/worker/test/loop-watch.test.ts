import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchLoop } from '../src/loop-watch';

const STALL_MS = 30 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker watchLoop', () => {
  it('names the step that stopped moving, once', () => {
    const onStall = vi.fn();
    const watch = watchLoop({ stallMs: STALL_MS, onStall });
    watch.enter('job', { jobId: 'j-1', type: 'recognize_waste_ticket_file' });

    vi.advanceTimersByTime(STALL_MS - 60_000);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * STALL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith({
      phase: 'job',
      detail: { jobId: 'j-1', type: 'recognize_waste_ticket_file' },
      silentMs: expect.any(Number),
    });
    expect(onStall.mock.calls[0]![0].silentMs).toBeGreaterThanOrEqual(STALL_MS);
    watch.stop();
  });

  it('stays quiet while steps keep coming, however long the iteration as a whole', () => {
    const onStall = vi.fn();
    const watch = watchLoop({ stallMs: STALL_MS, onStall });
    // A batch of ten fifteen-minute OCR jobs: two and a half hours in one iteration.
    for (let job = 0; job < 10; job++) {
      watch.enter('job', { jobId: `j-${job}` });
      vi.advanceTimersByTime(15 * 60_000);
    }
    expect(onStall).not.toHaveBeenCalled();
    watch.stop();
  });

  it('carries no stale job detail into a step without one', () => {
    const onStall = vi.fn();
    const watch = watchLoop({ stallMs: STALL_MS, onStall });
    watch.enter('job', { jobId: 'j-1' });
    watch.enter('device-mail');
    vi.advanceTimersByTime(STALL_MS + 60_000);
    expect(onStall).toHaveBeenCalledWith({ phase: 'device-mail', silentMs: expect.any(Number) });
    watch.stop();
  });

  it('does not fire after stop', () => {
    const onStall = vi.fn();
    const watch = watchLoop({ stallMs: STALL_MS, onStall });
    watch.stop();
    vi.advanceTimersByTime(10 * STALL_MS);
    expect(onStall).not.toHaveBeenCalled();
  });
});
