import { useEffect, useEffectEvent, useRef, useState } from 'react';

/**
 * Why the form is being filled. The caller decides from it how much of the form to overwrite.
 *
 * - `session` — a new window session: opened, switched to another record, or the record arrived.
 * - `refresh` — someone else's newer version over an untouched form: nothing to lose, so silently.
 * - `reload` — the person pressed "Reload" over their changes: everything, by consent.
 * - `own` — the window's own mutation moved the record: only what the person has not touched.
 */
export type RecordFillReason = 'session' | 'refresh' | 'reload' | 'own';

/** Optimistic-lock token or change marker: compared by value, so only primitives. */
export type RecordVersion = string | number;

export interface RecordSessionOptions<T, V extends RecordVersion> {
  /** Whether the window (or the page editor) is open. A closed window is never filled. */
  open: boolean;
  /** Identity of the edited record; `null` for a form without one (a new record, settings). */
  id?: string | null;
  /**
   * The record as the cache serves it; `undefined` while it is not there yet. A form for a new
   * record passes `null` as its type allows: there is nothing to wait for, the session starts.
   */
  data: T | undefined;
  /** Placeholder data is someone else's record (`keepPreviousData`): it does not start a session. */
  isPlaceholderData?: boolean;
  /**
   * The optimistic-lock token the save must carry. Omitted for forms without a version: they are
   * filled once per session and never react to a newer record.
   */
  version?: (data: T) => V | undefined;
  /**
   * What counts as "the record changed under the form". Defaults to `version`. Wider than the lock
   * token where the form is built from more than the record (the weekly composition also follows
   * the site suggestion).
   */
  revision?: (data: T) => RecordVersion | undefined;
  /** Whether the person has changed anything since the last fill. Read only when a newer record arrives. */
  isDirty: () => boolean;
  fill: (data: T, reason: RecordFillReason) => void;
}

export interface RecordSession<V extends RecordVersion> {
  /** The lock token taken when the form was filled — the one the save must carry. */
  version: V | undefined;
  /** Someone else's newer record arrived over a changed form: the notice is due. */
  stale: boolean;
  /** "Reload": fill from the current record and take its version; the person's input is dropped. */
  reload: () => void;
  /**
   * The window's own mutation answered with this version (any block of the window, not only the
   * form). The snapshot moves at once — the next save must not get 409 for our own change — and
   * when the record with this version arrives, untouched fields are refilled from it.
   */
  accept: (version: V) => void;
}

interface PendingOwn<V> {
  version: V;
  /** The cached record's version when the own answer came: still showing it means "not yet". */
  before: RecordVersion | undefined;
}

/**
 * Protection of a form from rereads (stage 5 plan §4.5): a refetch of the record never erases what
 * the person typed, and the save carries the version the person actually saw.
 *
 * WHY A SESSION AND NOT THE RECORD AS THE KEY. Every reread delivers a new object, and a form reset
 * by the object's identity wiped the input on any invalidation — a neighbouring action, a focus
 * return, a background error retry. The form is filled when the window session starts:
 * `[open, id, loaded]`. Forms mounted while closed (a card's nested window) and data loaded before
 * opening are both covered by `open` and `loaded` being in the key: opening fills, reopening the
 * same record fills again.
 *
 * WHY A SNAPSHOT VERSION. A live version would silently turn "I edited version 3" into "I edited
 * version 4" and overwrite a colleague's change; the snapshot makes the server answer 409 instead.
 *
 * A newer record over the open form: untouched — refilled silently (the person loses nothing, and
 * the snapshot follows, so the save will not get 409); changed — fields and snapshot stay, `stale`
 * raises the notice, and "Reload" is the only way the input is dropped (decision R6-a).
 */
export function useRecordSession<T, V extends RecordVersion = number>(
  options: RecordSessionOptions<T, V>,
): RecordSession<V> {
  const { open, id = null, data, isPlaceholderData = false, version } = options;
  const revisionOf = options.revision ?? version;
  const loaded = data !== undefined && !isPlaceholderData;
  // Read only behind `loaded`: `undefined` never reaches `fill` or the version callbacks.
  const record = data as T;
  // Refs, not state, for what the effects compare: the session and the revision effects run in the
  // same commit, and the second must already see the snapshot the first has just taken.
  const revisionRef = useRef<RecordVersion | undefined>(undefined);
  const ownRef = useRef<PendingOwn<V> | null>(null);
  const [snapshot, setSnapshot] = useState<V | undefined>(undefined);
  const [stale, setStale] = useState(false);

  const take = (reason: RecordFillReason) => {
    options.fill(record, reason);
    revisionRef.current = revisionOf?.(record);
    ownRef.current = null;
    setSnapshot(version?.(record));
    setStale(false);
  };

  const startSession = useEffectEvent((_open: boolean, _id: string | null, _loaded: boolean) => {
    if (!open || !loaded) return;
    take('session');
  });
  useEffect(() => startSession(open, id, loaded), [open, id, loaded]);

  const current = open && loaded && revisionOf ? revisionOf(record) : undefined;
  const followRecord = useEffectEvent((_current: RecordVersion | undefined) => {
    if (!open || !loaded || current === undefined) return;
    const own = ownRef.current;
    if (own) {
      const shown = version?.(record);
      if (shown === own.version) return take('own');
      // Our own answer is known but the cache still holds the record from before it: a change of
      // anything else (the suggestion beside it) is not a foreign edit, and the own version will
      // arrive with the refetch our mutation started.
      if (shown === own.before) return;
      ownRef.current = null;
    }
    if (current === revisionRef.current) return;
    if (!options.isDirty()) return take('refresh');
    setStale(true);
  });
  useEffect(() => followRecord(current), [current]);

  return {
    version: snapshot,
    stale,
    reload: () => {
      if (loaded) take('reload');
    },
    accept: (next: V) => {
      const shown = loaded ? version?.(record) : undefined;
      // The answer may come after the cache already holds it (`setQueryData` rendered first): then
      // there is no newer record left to wait for, and the refill happens now.
      if (open && shown === next) return take('own');
      ownRef.current = { version: next, before: shown };
      setSnapshot(next);
    },
  };
}
