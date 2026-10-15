import { useCallback, useEffect, useRef, useState } from 'react';
import { Form, type FormInstance } from 'antd';
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

export interface LocalFormDraftController<Payload> {
  active: LocalFormDraft<Payload> | null;
  begin: (target: string) => void;
  clear: () => void;
  discardPending: () => void;
  pending: LocalFormDraft<Payload>[];
  persist: () => boolean;
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
  const [pending, setPending] = useState<LocalFormDraft<Payload>[]>([]);
  const [status, setStatus] = useState<LocalDraftStatus>({ available: true, savedAt: null });
  const context = useRef<string | null>(null);

  const begin = useCallback(
    (target: string) => {
      context.current = target;
      if (!userId) {
        setActive(null);
        setPending([]);
        setStatus({ available: false, savedAt: null });
        return;
      }
      const found = listLocalFormDrafts(userId, form, target, parseRef.current);
      setPending(found.drafts);
      setActive(
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
    [userId, form],
  );

  const persist = useCallback((): boolean => {
    if (!active) return false;
    const savedAt = Date.now();
    const ok = writeLocalFormDraft({ ...active, savedAt, payload: readRef.current() });
    setStatus({ available: ok, savedAt: ok ? savedAt : null });
    return ok;
  }, [active]);

  const restore = (candidate: LocalFormDraft<Payload>): Payload => {
    const next = { ...candidate, id: newLocalFormDraftId(), savedAt: Date.now() };
    const ok = writeLocalFormDraft(next);
    // The source may still be open in another tab. Keep it until an explicit discard.
    setActive(next);
    setPending([]);
    setStatus({ available: ok, savedAt: ok ? next.savedAt : null });
    return candidate.payload;
  };

  const discardPending = () => {
    const removed = pending.map((item) => removeLocalFormDraft(item.id)).every(Boolean);
    setPending([]);
    if (userId && context.current) {
      setActive({
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
    if (active) removeLocalFormDraft(active.id);
    setActive(null);
    setPending([]);
    setStatus({ available: true, savedAt: null });
  };

  return { active, begin, clear, discardPending, pending, persist, restore, status };
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
