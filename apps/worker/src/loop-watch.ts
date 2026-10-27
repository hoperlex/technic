/**
 * What the loop was busy with when it stopped moving: the step it entered last and how long ago.
 * `detail` names the job when the step is one (id and type), so the fatal line points at the row.
 */
export interface LoopStall {
  phase: string;
  detail?: Record<string, unknown>;
  silentMs: number;
}

export interface LoopWatch {
  /** The loop entered a step: the silence clock starts over. */
  enter(phase: string, detail?: Record<string, unknown>): void;
  stop(): void;
}

/**
 * Calls `onStall` once when no step has been entered for `stallMs`.
 *
 * The clock runs per step (one job, one tick, one cleanup pass), not per iteration: a batch runs its
 * jobs one after another, so an iteration's length grows with the batch while a step's does not, and
 * only a per-step limit can sit close above the longest legitimate step.
 *
 * The timer is not unref'd on purpose. A step stuck on a promise that holds no handle would
 * otherwise let the process drain and exit 0 without a word; kept alive, it ends on `onStall` with
 * the step named.
 */
export function watchLoop(options: {
  stallMs: number;
  onStall: (stall: LoopStall) => void;
  checkEveryMs?: number;
  now?: () => number;
}): LoopWatch {
  const now = options.now ?? Date.now;
  let phase = 'start';
  let detail: Record<string, unknown> | undefined;
  let enteredAt = now();

  const timer = setInterval(
    () => {
      const silentMs = now() - enteredAt;
      if (silentMs < options.stallMs) return;
      clearInterval(timer);
      options.onStall({ phase, ...(detail ? { detail } : {}), silentMs });
    },
    options.checkEveryMs ?? Math.min(60_000, options.stallMs / 4),
  );

  return {
    enter(next, nextDetail) {
      phase = next;
      detail = nextDetail;
      enteredAt = now();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
