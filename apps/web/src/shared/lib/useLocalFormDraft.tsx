import { useCallback, useEffect, useRef, useState } from 'react';
import { Form, type FormInstance } from 'antd';
import { newIdempotencyKey } from './idempotency';
import {
  listLocalFormDrafts,
  newLocalFormDraftId,
  removeLocalFormDraft,
  writeLocalFormDraft,
  type LocalFormDraft,
} from './localFormDraftStore';

export interface LocalDraftStatus {
  available: boolean;
  savedAt: number | null;
}

export class LocalCreateAttemptError extends Error {}

/**
 * A create body that the route's own contract schema refuses, caught before it is frozen and sent.
 *
 * Freezing such a body used to lock the form: every retry resent it, the server refused it again,
 * and the reconciliation refused it for the same reason (ADR 0247). Being a `LocalCreateAttemptError`
 * tells the save path that nothing reached the server, so no "the first request may still commit"
 * warning appears. It also carries the server's `validation_error` shape (`code`, `status`, `fields`
 * keyed by the dotted issue path, as the API error handler builds them), so `errorMessage` and
 * `errorFields` treat a local refusal exactly like a server one.
 */
export class LocalValidationError extends LocalCreateAttemptError {
  readonly code = 'validation_error';
  readonly status = 400;
  readonly fields: Record<string, string>;

  constructor(
    issues: readonly { path: readonly PropertyKey[]; message: string }[],
    message = 'Проверьте поля формы',
  ) {
    super(message);
    this.name = 'LocalValidationError';
    const fields: Record<string, string> = {};
    for (const issue of issues) {
      const path = issue.path.map(String).join('.') || 'root';
      fields[path] ??= issue.message;
    }
    this.fields = fields;
  }
}

export interface LocalFormDraftController<Payload> {
  active: LocalFormDraft<Payload> | null;
  begin: (target: string) => void;
  clear: () => boolean;
  discardPending: () => void;
  pending: LocalFormDraft<Payload>[];
  persist: () => boolean;
  prepareCreate: <Body>(body: Body) => { body: Body; key: string };
  releaseCreateAttempt: (key: string, nextKey: string) => boolean;
  resetLegacyCreateAttempt: () => boolean;
  restore: (candidate: LocalFormDraft<Payload>) => Payload;
  status: LocalDraftStatus;
}

/** One opening, one key. The caller owns domain validation and any date or file rehydration. */
export function useLocalFormDraft<Payload>({
  userId,
  form,
  read,
  parse,
}: {
  userId: string | null;
  form: string;
  read: () => Payload;
  parse: (value: unknown) => Payload | null;
}): LocalFormDraftController<Payload> {
  const readRef = useRef(read);
  readRef.current = read;
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const [active, setActive] = useState<LocalFormDraft<Payload> | null>(null);
  const activeRef = useRef<LocalFormDraft<Payload> | null>(null);
  const [pending, setPending] = useState<LocalFormDraft<Payload>[]>([]);
  const [status, setStatus] = useState<LocalDraftStatus>({ available: true, savedAt: null });
  const context = useRef<string | null>(null);
  const activate = useCallback((next: LocalFormDraft<Payload> | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  const begin = useCallback(
    (target: string) => {
      context.current = target;
      if (!userId) {
        activate(null);
        setPending([]);
        setStatus({ available: false, savedAt: null });
        return;
      }
      const found = listLocalFormDrafts(userId, form, target, parseRef.current);
      setPending(found.drafts);
      activate(
        found.drafts.length
          ? null
          : {
              schema: 1,
              id: newLocalFormDraftId(),
              userId,
              form,
              target,
              savedAt: 0,
              payload: readRef.current(),
            },
      );
      setStatus({ available: found.available, savedAt: null });
    },
    [userId, form, activate],
  );

  const persist = useCallback((): boolean => {
    const current = activeRef.current;
    if (!current) return false;
    const savedAt = Date.now();
    const next = { ...current, savedAt, payload: readRef.current() };
    const ok = writeLocalFormDraft(next);
    if (ok) activate(next);
    setStatus({ available: ok, savedAt: ok ? savedAt : null });
    return ok;
  }, [activate]);

  // A rejected retry cannot thaw an earlier in-flight POST; only success clears this attempt.
  const prepareCreate = <Body,>(body: Body): { body: Body; key: string } => {
    const current = activeRef.current;
    if (!current) throw new LocalCreateAttemptError('Черновик недоступен — откройте форму заново');
    if (current.createAttempt && current.createAttempt.protocol !== 'receipt-v1') {
      throw new LocalCreateAttemptError(
        'Исход старой отправки нельзя проверить автоматически. Сверьте заявку в списке вручную.',
      );
    }
    const key = current.createAttempt?.key ?? current.nextCreateKey ?? newIdempotencyKey();
    // Form libraries may mutate nested values after a send; the retry must keep the bytes represented
    // by the first persisted JSON body, including file IDs and trip rows.
    const submittedBody = current.createAttempt
      ? (current.createAttempt.body as Body)
      : (JSON.parse(JSON.stringify(body)) as Body);
    const next = {
      ...current,
      savedAt: Date.now(),
      payload: readRef.current(),
      createAttempt: { key, body: submittedBody, protocol: 'receipt-v1' as const },
      nextCreateKey: undefined,
    };
    if (!writeLocalFormDraft(next)) {
      setStatus({ available: false, savedAt: null });
      throw new LocalCreateAttemptError(
        'Не удалось сохранить попытку создания на устройстве. Освободите место и повторите.',
      );
    }
    activate(next);
    setStatus({ available: true, savedAt: next.savedAt });
    return { body: submittedBody, key };
  };

  const releaseCreateAttempt = (key: string, nextKey: string): boolean => {
    const current = activeRef.current;
    if (current?.createAttempt?.protocol !== 'receipt-v1' || current.createAttempt.key !== key)
      return false;
    const { createAttempt: _attempt, ...remaining } = current;
    const next = {
      ...remaining,
      savedAt: Date.now(),
      payload: readRef.current(),
      nextCreateKey: nextKey,
      previousCreateKeys: [...new Set([...(current.previousCreateKeys ?? []), key])],
    };
    if (!writeLocalFormDraft(next)) {
      setStatus({ available: false, savedAt: null });
      return false;
    }
    activate(next);
    setStatus({ available: true, savedAt: next.savedAt });
    if (userId && context.current) {
      const copies = listLocalFormDrafts(userId, form, context.current, parseRef.current).drafts;
      for (const copy of copies) {
        if (copy.id !== next.id && copy.createAttempt?.key === key) removeLocalFormDraft(copy.id);
      }
    }
    return true;
  };

  const resetLegacyCreateAttempt = (): boolean => {
    const current = activeRef.current;
    if (!current?.createAttempt || current.createAttempt.protocol === 'receipt-v1') return false;
    const oldKey = current.createAttempt.key;
    const { createAttempt: _attempt, ...remaining } = current;
    const next = {
      ...remaining,
      savedAt: Date.now(),
      payload: readRef.current(),
      nextCreateKey: newIdempotencyKey(),
      previousCreateKeys: [...new Set([...(current.previousCreateKeys ?? []), oldKey])],
    };
    if (!writeLocalFormDraft(next)) {
      setStatus({ available: false, savedAt: null });
      return false;
    }
    activate(next);
    const found = listLocalFormDrafts(current.userId, form, current.target, parseRef.current);
    if (found.available) {
      for (const copy of found.drafts) {
        if (copy.id !== next.id && copy.createAttempt?.key === oldKey) {
          removeLocalFormDraft(copy.id);
        }
      }
    }
    // The persisted lineage lets a later successful create remove copies missed by this best-effort pass.
    setStatus({ available: true, savedAt: next.savedAt });
    return true;
  };
  const restore = (candidate: LocalFormDraft<Payload>): Payload => {
    const next = { ...candidate, id: newLocalFormDraftId(), savedAt: Date.now() };
    const ok = writeLocalFormDraft(next);
    // The source may still be open in another tab. Keep it until an explicit discard.
    activate(next);
    setPending([]);
    setStatus({ available: ok, savedAt: ok ? next.savedAt : null });
    return candidate.payload;
  };

  const discardPending = () => {
    const removed = pending.map((item) => removeLocalFormDraft(item.id)).every(Boolean);
    setPending([]);
    if (userId && context.current) {
      activate({
        schema: 1,
        id: newLocalFormDraftId(),
        userId,
        form,
        target: context.current,
        savedAt: 0,
        payload: readRef.current(),
      });
    }
    setStatus({ available: removed, savedAt: null });
  };

  const clear = () => {
    const current = activeRef.current;
    let removed = true;
    const relatedKeys = new Set([
      ...(current?.previousCreateKeys ?? []),
      ...(current?.createAttempt ? [current.createAttempt.key] : []),
      ...(current?.nextCreateKey ? [current.nextCreateKey] : []),
    ]);
    if (current && relatedKeys.size > 0) {
      // A confirmed new create also settles restored copies of earlier attempts. The current
      // envelope retains their keys until sibling cleanup succeeds, even across failed removals.
      const found = listLocalFormDrafts(current.userId, form, current.target, parseRef.current);
      removed = found.available;
      if (found.available) {
        for (const copy of found.drafts) {
          if (
            copy.id !== current.id &&
            (relatedKeys.has(copy.createAttempt?.key ?? '') ||
              relatedKeys.has(copy.nextCreateKey ?? '') ||
              copy.previousCreateKeys?.some((key) => relatedKeys.has(key)))
          ) {
            removed = removeLocalFormDraft(copy.id) && removed;
          }
        }
      }
    }
    if (current && removed) removed = removeLocalFormDraft(current.id);
    if (removed) {
      activate(null);
      setPending([]);
    }
    setStatus({ available: removed, savedAt: null });
    return removed;
  };

  return {
    active,
    begin,
    clear,
    discardPending,
    pending,
    persist,
    prepareCreate,
    releaseCreateAttempt,
    resetLegacyCreateAttempt,
    restore,
    status,
  };
}

export function LocalFormDraftAutosave({
  active,
  signature,
  onSave,
}: {
  active: boolean;
  signature: string | undefined;
  onSave: () => boolean;
}) {
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(onSave, 400);
    return () => window.clearTimeout(timer);
  }, [active, signature, onSave]);
  useEffect(() => {
    if (!active) return;
    const flush = () => onSave();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [active, onSave]);
  return null;
}

/** Ant Design does not call `onValuesChange` for `setFieldsValue`, including added trip rows. */
export function FormDraftAutosave<Values extends object>({
  active,
  form,
  onSave,
}: {
  active: boolean;
  form: FormInstance<Values>;
  onSave: () => boolean;
}) {
  const signature = Form.useWatch((values: Values) => JSON.stringify(values), {
    form,
    preserve: true,
  });
  return <LocalFormDraftAutosave active={active} signature={signature} onSave={onSave} />;
}
