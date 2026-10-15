import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { MechRequestDto } from '@technic/contracts';
import { mechFailureText, mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { useAuth } from '@entities/session';
import {
  listLocalFormDrafts,
  LocalCreateAttemptError,
  newIdempotencyKey,
  newLocalFormDraftId,
  useLocalFormDraft,
  writeLocalFormDraft,
} from '@shared/lib';
import {
  COMPLETED_PREFIX,
  FORM,
  parseSource,
  readCompletion,
  removeCompletion,
  withSourceLock,
  writeCompletion,
  type DuplicateDraft,
  type Source,
} from './mechDuplicateStore';
import { MechDuplicateNotice } from './MechDuplicateNotice';
import { MechDuplicateModal } from './MechDuplicateModal';

/** The command has no form fields, but its source, key and uncertain result survive a reload. */
export function useMechDuplicate(): {
  open: (request: MechRequestDto) => void;
  modal: ReactNode;
  notice: ReactNode;
  pending: boolean;
} {
  const { user, can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Source | null>(null);
  const sourceRef = useRef<Source>({ id: '', displayNumber: '' });
  const [saved, setSaved] = useState<DuplicateDraft[]>([]);
  const [busy, setBusy] = useState<'send' | 'reconcile' | null>(null);
  const busyRef = useRef(false);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [cleanupRequired, setCleanupRequired] = useState(false);
  const draft = useLocalFormDraft({
    userId: user?.id ?? null,
    form: FORM,
    read: () => sourceRef.current,
    parse: parseSource,
  });

  const refresh = useCallback(() => {
    if (!user) {
      setSaved([]);
      return;
    }
    setSaved(listLocalFormDrafts(user.id, FORM, undefined, parseSource).drafts);
  }, [user]);
  useEffect(() => {
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (
        event.key?.startsWith('technic:form-draft:v1:') ||
        event.key?.startsWith(COMPLETED_PREFIX)
      )
        refresh();
    };
    const onLocalChange = () => refresh();
    window.addEventListener('storage', onStorage);
    window.addEventListener('technic:mech-duplicate-change', onLocalChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('technic:mech-duplicate-change', onLocalChange);
    };
  }, [refresh]);

  const changed = () => {
    refresh();
    window.dispatchEvent(new Event('technic:mech-duplicate-change'));
  };

  const adoptSaved = (candidate: DuplicateDraft) => {
    const completion = readCompletion(candidate.userId, candidate.target);
    if (!completion.available)
      throw new LocalCreateAttemptError('Не удалось прочитать подтверждение прошлой копии');
    sourceRef.current = candidate.payload;
    draft.begin(candidate.target);
    draft.restore(candidate);
    setConfirmedId(completion.value?.requestId ?? null);
    setConfirmedKey(completion.value?.key ?? null);
    // A ready replacement key can have been saved just before removal of the old completion
    // marker failed. Repeating the explicit new-intent action must keep that reserved key.
    setCleanupRequired(
      !!completion.value &&
        (!candidate.nextCreateKey || candidate.nextCreateKey === completion.value.key),
    );
    setSelected(candidate.payload);
    changed();
  };
  const openSaved = (candidate: DuplicateDraft) => {
    if (busyRef.current || confirmedId) return;
    try {
      adoptSaved(candidate);
    } catch (error) {
      message.error(
        error instanceof LocalCreateAttemptError ? error.message : mechFailureText(error),
      );
    }
  };
  const open = (request: MechRequestDto) => {
    if (busyRef.current || confirmedId) return;
    const source = { id: request.id, displayNumber: request.displayNumber };
    const found = user ? listLocalFormDrafts(user.id, FORM, source.id, parseSource) : null;
    if (!found?.available) {
      message.error('Не удалось прочитать сохранённые попытки. Проверьте хранилище браузера.');
      return;
    }
    const completion = readCompletion(user!.id, source.id);
    if (!completion.available) {
      message.error('Не удалось прочитать подтверждение прошлой копии на устройстве.');
      return;
    }
    const existing = found.drafts.find((item) => item.nextCreateKey) ?? found.drafts[0];
    if (existing) openSaved(existing);
    else {
      sourceRef.current = source;
      draft.begin(source.id);
      setConfirmedId(completion.value?.requestId ?? null);
      setConfirmedKey(completion.value?.key ?? null);
      setCleanupRequired(false);
      setSelected(source);
    }
  };

  const finishConfirmed = async (
    requestId: string,
    key: string,
    sourceId: string,
  ): Promise<boolean> => {
    if (!user) return false;
    return withSourceLock(user.id, sourceId, async () => {
      const completion = readCompletion(user.id, sourceId);
      const found = listLocalFormDrafts(user.id, FORM, sourceId, parseSource);
      if (!completion.available || !found.available) return false;
      // A late answer for an earlier copy must not overwrite a newer confirmed copy or the
      // replacement key already reserved by a separate explicit intent in another tab.
      const current = found.drafts.find(
        (item) => item.createAttempt?.key === key || item.nextCreateKey === key,
      );
      const olderKeys = new Set(current?.previousCreateKeys ?? []);
      const superseded =
        (completion.value !== null && completion.value.key !== key) ||
        found.drafts.some(
          (item) =>
            (item.createAttempt &&
              item.createAttempt.key !== key &&
              !olderKeys.has(item.createAttempt.key)) ||
            (item.nextCreateKey &&
              item.nextCreateKey !== key &&
              !olderKeys.has(item.nextCreateKey)),
        );
      if (!superseded && !writeCompletion(user.id, sourceId, { requestId, key })) return false;
      return draft.clear();
    });
  };

  const showCreated = async (requestId: string, key: string, sourceId: string) => {
    const cleared = await finishConfirmed(requestId, key, sourceId);
    changed();
    setConfirmedId(cleared ? null : requestId);
    setConfirmedKey(cleared ? null : key);
    setCleanupRequired(!cleared);
    if (cleared) setSelected(null);
    void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
    try {
      const created = await mechRequestsApi.get(requestId);
      message.success(`Заведена копия: ${created.displayNumber}`);
    } catch {
      // The receipt proves creation even if current read rights or a later hard delete prevent GET.
      message.success(`Копия создана. ID заявки: ${requestId}`);
    }
    if (!cleared)
      message.error(
        'Копия создана, но подтверждение или запись попытки не сохранены на устройстве. Повторите очистку.',
      );
  };

  const send = async () => {
    if (!selected || !user || busyRef.current || confirmedId || !can('mechRequests.create')) return;
    busyRef.current = true;
    setBusy('send');
    try {
      const attempt = await withSourceLock(user.id, selected.id, async () => {
        const completion = readCompletion(user.id, selected.id);
        if (!completion.available)
          throw new LocalCreateAttemptError('Не удалось прочитать результат прежнего дублирования');
        if (completion.value) {
          setConfirmedId(completion.value.requestId);
          setConfirmedKey(completion.value.key);
          setCleanupRequired(true);
          throw new LocalCreateAttemptError(
            'Копия уже создана. Сначала проверьте её и отдельно начните новое дублирование.',
          );
        }
        const found = listLocalFormDrafts(user.id, FORM, selected.id, parseSource);
        if (!found.available)
          throw new LocalCreateAttemptError('Не удалось прочитать ключ попытки');
        // A second tab must adopt the first tab's persisted attempt before it can send. A confirmed
        // not-created draft carries the server's replacement key for a deliberate new click.
        const active = draft.active;
        if (active?.target === selected.id && active.createAttempt) {
          // Another tab may already have received 201 and removed its envelope. Retrying this
          // restored tab must still use its own frozen key; a missing shared record is not a new
          // user intent.
        } else {
          const existing = found.drafts.find((item) => item.nextCreateKey) ?? found.drafts[0];
          if (existing) adoptSaved(existing);
          else if (active?.target !== selected.id || !active?.nextCreateKey)
            draft.begin(selected.id);
        }
        return draft.prepareCreate({});
      });
      changed();
      const result = await mechRequestsApi.duplicateWithReceipt(selected.id, attempt.key);
      await showCreated(result.requestId, attempt.key, selected.id);
    } catch (error) {
      message.error(
        error instanceof LocalCreateAttemptError ? error.message : mechFailureText(error),
      );
      changed();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const reconcile = async () => {
    const attempt = draft.active?.createAttempt;
    if (!selected || !attempt || busyRef.current || confirmedId) return;
    busyRef.current = true;
    setBusy('reconcile');
    try {
      const result = await mechRequestsApi.reconcileDuplicate(selected.id, attempt.key);
      if (result.state === 'created') await showCreated(result.requestId, attempt.key, selected.id);
      else if (
        await withSourceLock(user!.id, selected.id, async () => {
          const completion = readCompletion(user!.id, selected.id);
          const found = listLocalFormDrafts(user!.id, FORM, selected.id, parseSource);
          if (!completion.available || completion.value || !found.available) return false;
          // A delayed reconcile must not restore an older key over a replacement already
          // reserved or sent by another tab.
          const current = found.drafts.find(
            (item) => item.id === draft.active?.id && item.createAttempt?.key === attempt.key,
          );
          if (!current) return false;
          const olderKeys = new Set(current.previousCreateKeys ?? []);
          if (
            found.drafts.some(
              (item) =>
                (item.createAttempt &&
                  item.createAttempt.key !== attempt.key &&
                  !olderKeys.has(item.createAttempt.key)) ||
                (item.nextCreateKey &&
                  item.nextCreateKey !== attempt.key &&
                  !olderKeys.has(item.nextCreateKey)),
            )
          )
            return false;
          return draft.releaseCreateAttempt(attempt.key, result.nextOperationId);
        })
      ) {
        changed();
        message.info('Копия не была создана. Для новой копии нажмите «Дублировать» ещё раз.');
      } else message.error('Сохранённая попытка изменилась в другой вкладке. Откройте её заново.');
    } catch (error) {
      message.error(mechFailureText(error));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const retryCleanup = async () => {
    if (!confirmedId || !confirmedKey || !selected || !user || busyRef.current) return;
    busyRef.current = true;
    setBusy('reconcile');
    try {
      if (!(await finishConfirmed(confirmedId, confirmedKey, selected.id))) {
        message.error('Не удалось завершить сохранённую попытку на устройстве');
        return;
      }
      setCleanupRequired(false);
      setConfirmedId(null);
      setConfirmedKey(null);
      setSelected(null);
      changed();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const beginAnother = async () => {
    if (!selected || !user || !confirmedId || cleanupRequired || busyRef.current) return;
    busyRef.current = true;
    try {
      await withSourceLock(user.id, selected.id, async () => {
        const completion = readCompletion(user.id, selected.id);
        if (!completion.available)
          throw new LocalCreateAttemptError('Не удалось прочитать результат прежней копии');
        if (completion.value && completion.value.key !== confirmedKey) {
          setConfirmedId(completion.value.requestId);
          setConfirmedKey(completion.value.key);
          throw new LocalCreateAttemptError(
            'В другой вкладке уже создана следующая копия. Проверьте её перед новым действием.',
          );
        }
        const found = listLocalFormDrafts(user.id, FORM, selected.id, parseSource);
        if (!found.available)
          throw new LocalCreateAttemptError('Сначала завершите сохранённую попытку дублирования');
        let next = found.drafts.find((item) => item.nextCreateKey && !item.createAttempt);
        if (found.drafts.some((item) => item.createAttempt) || (found.drafts.length && !next))
          throw new LocalCreateAttemptError('Сначала завершите сохранённую попытку дублирования');
        if (!next) {
          next = {
            schema: 1,
            id: newLocalFormDraftId(),
            userId: user.id,
            form: FORM,
            target: selected.id,
            savedAt: Date.now(),
            payload: selected,
            nextCreateKey: newIdempotencyKey(),
          };
          if (!writeLocalFormDraft(next))
            throw new LocalCreateAttemptError(
              'Не удалось сохранить ключ новой копии на устройстве',
            );
        }
        if (!removeCompletion(user.id, selected.id))
          throw new LocalCreateAttemptError('Не удалось завершить прежнюю копию на устройстве');
        adoptSaved(next);
        setConfirmedId(null);
        setConfirmedKey(null);
        setCleanupRequired(false);
      });
    } catch (error) {
      message.error(
        error instanceof LocalCreateAttemptError ? error.message : mechFailureText(error),
      );
    } finally {
      busyRef.current = false;
    }
  };

  const notice = <MechDuplicateNotice saved={saved} busy={!!busy} onOpen={openSaved} />;

  const modal = (
    <MechDuplicateModal
      selected={selected}
      active={draft.active}
      busy={busy}
      confirmedId={confirmedId}
      cleanupRequired={cleanupRequired}
      canCreate={can('mechRequests.create')}
      onClose={() => {
        if (!busyRef.current && !confirmedId) setSelected(null);
      }}
      onSend={() => void send()}
      onReconcile={() => void reconcile()}
      onCleanup={() => void retryCleanup()}
      onBeginAnother={() => void beginAnother()}
    />
  );

  return { open, modal, notice, pending: !!busy };
}
