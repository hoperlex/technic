import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listLocalFormDrafts, objectDraftPayload, useLocalFormDraft } from '@shared/lib';
import { LocalFormDraftNotice, RequestCreateAttemptNotice } from '@shared/ui';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ordinary request creation attempt', () => {
  const failRemovalOf = (id: string) => {
    const original = Storage.prototype.removeItem;
    return vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
      if (key.endsWith(id)) throw new Error('storage temporarily unavailable');
      original.call(this, key);
    });
  };

  it('persists the exact first body and key through editing and restoration', () => {
    let current = { comment: 'first' };
    const props = {
      userId: 'operator',
      form: 'waste-request',
      read: () => current,
      parse: objectDraftPayload,
    };
    const first = renderHook(() => useLocalFormDraft(props));
    act(() => first.result.current.begin('create'));
    let sent!: { body: { comment: string }; key: string };
    act(() => {
      sent = first.result.current.prepareCreate({ comment: 'original request' });
    });
    current = { comment: 'edited after timeout' };
    act(() => {
      expect(first.result.current.persist()).toBe(true);
    });
    const saved = listLocalFormDrafts('operator', 'waste-request', 'create', objectDraftPayload)
      .drafts[0]!;
    expect(saved.createAttempt).toEqual({ ...sent, protocol: 'receipt-v1' });
    first.unmount();

    const restored = renderHook(() => useLocalFormDraft(props));
    act(() => restored.result.current.begin('create'));
    act(() => restored.result.current.restore(saved));
    let retry!: typeof sent;
    act(() => {
      retry = restored.result.current.prepareCreate({ comment: 'new form values' });
    });
    expect(retry).toEqual(sent);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage cleared');
    });
    expect(() => {
      act(() => restored.result.current.prepareCreate({ comment: 'another retry' }));
    }).toThrow('Не удалось сохранить попытку');
  });

  it('does not send when the attempt cannot be saved', () => {
    const props = {
      userId: 'operator',
      form: 'mech-request',
      read: () => ({ comment: 'draft' }),
      parse: objectDraftPayload,
    };
    const draft = renderHook(() => useLocalFormDraft(props));
    act(() => draft.result.current.begin('create'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => {
      act(() => draft.result.current.prepareCreate({ comment: 'submit' }));
    }).toThrow('Не удалось сохранить попытку');
  });

  it('keeps nested fields and file IDs from the first send when form values mutate in place', () => {
    const draft = renderHook(() =>
      useLocalFormDraft({
        userId: 'operator',
        form: 'vehicle-request',
        read: () => ({ comment: 'draft' }),
        parse: objectDraftPayload,
      }),
    );
    act(() => draft.result.current.begin('create'));
    const body = { trips: [{ destination: 'First' }], fileIds: ['uploaded-first'] };
    let first!: { body: typeof body; key: string };
    act(() => {
      first = draft.result.current.prepareCreate(body);
    });
    body.trips[0]!.destination = 'Changed';
    body.fileIds.push('uploaded-later');
    let retry!: typeof first;
    act(() => {
      retry = draft.result.current.prepareCreate(body);
    });
    expect(retry.key).toBe(first.key);
    expect(retry.body).toEqual({
      trips: [{ destination: 'First' }],
      fileIds: ['uploaded-first'],
    });
    expect(
      listLocalFormDrafts('operator', 'vehicle-request', 'create', objectDraftPayload).drafts[0]
        ?.createAttempt?.body,
    ).toEqual(retry.body);
  });

  it('clears the original attempted draft after a restored retry succeeds', () => {
    const props = {
      userId: 'operator',
      form: 'service-request',
      read: () => ({ comment: 'draft' }),
      parse: objectDraftPayload,
    };
    const original = renderHook(() => useLocalFormDraft(props));
    act(() => original.result.current.begin('create'));
    act(() => original.result.current.prepareCreate({ comment: 'first', fileIds: ['file-1'] }));
    const source = listLocalFormDrafts('operator', 'service-request', 'create', objectDraftPayload)
      .drafts[0]!;
    original.unmount();

    const restored = renderHook(() => useLocalFormDraft(props));
    act(() => restored.result.current.begin('create'));
    act(() => restored.result.current.restore(source));
    expect(
      listLocalFormDrafts('operator', 'service-request', 'create', objectDraftPayload).drafts,
    ).toHaveLength(2);
    act(() => restored.result.current.clear());
    expect(
      listLocalFormDrafts('operator', 'service-request', 'create', objectDraftPayload).drafts,
    ).toEqual([]);
  });

  it('does not allow discarding an attempted pending draft before reconciliation', () => {
    const onDiscard = vi.fn();
    render(
      <LocalFormDraftNotice
        active={false}
        pending={[{ id: 'draft', savedAt: Date.now(), createAttempt: { key: 'attempt-key' } }]}
        status={{ available: true, savedAt: null }}
        onRestore={vi.fn()}
        onDiscard={onDiscard}
        createMayHaveSucceeded
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Удалить черновики и начать заново',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('freezes nested submitted data before the editor changes it in place', () => {
    const draft = renderHook(() =>
      useLocalFormDraft({
        userId: 'operator',
        form: 'waste-request',
        read: () => ({ comment: 'draft' }),
        parse: objectDraftPayload,
      }),
    );
    act(() => draft.result.current.begin('create'));
    const body = { fileIds: ['first'], trips: [{ address: 'first' }] };
    let first!: { body: typeof body; key: string };
    act(() => {
      first = draft.result.current.prepareCreate(body);
    });
    body.fileIds[0] = 'changed';
    body.trips[0]!.address = 'changed';
    expect(first.body).toEqual({ fileIds: ['first'], trips: [{ address: 'first' }] });
    expect(draft.result.current.active?.createAttempt?.body).toEqual(first.body);
  });

  it('keeps an uncertain body until reconciliation and uses the server replacement key', () => {
    let current = { comment: 'first' };
    const draft = renderHook(() =>
      useLocalFormDraft({
        userId: 'operator',
        form: 'service-request',
        read: () => current,
        parse: objectDraftPayload,
      }),
    );
    act(() => draft.result.current.begin('create'));
    let first!: { body: { comment: string }; key: string };
    act(() => {
      first = draft.result.current.prepareCreate({ comment: 'sent' });
    });
    current = { comment: 'corrected after 422' };
    act(() => expect(draft.result.current.persist()).toBe(true));
    let retry!: typeof first;
    act(() => {
      retry = draft.result.current.prepareCreate({ comment: 'corrected' });
    });
    expect(retry).toEqual(first);
    const replacement = crypto.randomUUID();
    current = { comment: 'edited immediately before reconciliation' };
    act(() => expect(draft.result.current.releaseCreateAttempt(first.key, replacement)).toBe(true));
    expect(draft.result.current.active?.payload).toEqual(current);
    let corrected!: typeof first;
    act(() => {
      corrected = draft.result.current.prepareCreate({ comment: 'corrected' });
    });
    expect(corrected).toEqual({ key: replacement, body: { comment: 'corrected' } });
    act(() => draft.result.current.clear());
    expect(
      listLocalFormDrafts('operator', 'service-request', 'create', objectDraftPayload).drafts,
    ).toEqual([]);
  });

  it('does not retry or reconcile an unmarked draft from the old root POST protocol', () => {
    let visible = { comment: 'draft' };
    const props = {
      userId: 'operator',
      form: 'waste-request',
      read: () => visible,
      parse: objectDraftPayload,
    };
    const original = renderHook(() => useLocalFormDraft(props));
    act(() => original.result.current.begin('create'));
    act(() => original.result.current.prepareCreate({ comment: 'sent' }));
    const saved = listLocalFormDrafts('operator', 'waste-request', 'create', objectDraftPayload)
      .drafts[0]!;
    const legacy = {
      ...saved,
      createAttempt: { key: saved.createAttempt!.key, body: saved.createAttempt!.body },
    };
    localStorage.setItem(`technic:form-draft:v1:${saved.id}`, JSON.stringify(legacy));
    original.unmount();

    const restored = renderHook(() => useLocalFormDraft(props));
    act(() => restored.result.current.begin('create'));
    act(() => restored.result.current.restore(legacy));
    expect(() => {
      act(() => restored.result.current.prepareCreate({ comment: 'retry' }));
    }).toThrow('Сверьте заявку в списке вручную');
    expect(
      restored.result.current.releaseCreateAttempt(legacy.createAttempt.key, crypto.randomUUID()),
    ).toBe(false);
    render(<RequestCreateAttemptNotice pending legacy checking={false} onCheck={vi.fn()} />);
    expect(screen.getByText(/Проверьте заявку в списке вручную/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Проверить создание' })).toBeNull();
    visible = { comment: 'edited immediately before reset' };
    act(() => expect(restored.result.current.resetLegacyCreateAttempt()).toBe(true));
    expect(restored.result.current.active?.payload).toEqual(visible);
    expect(restored.result.current.active?.createAttempt).toBeUndefined();
    let next!: { key: string; body: { comment: string } };
    act(() => {
      next = restored.result.current.prepareCreate({ comment: 'new send' });
    });
    expect(next.key).not.toBe(legacy.createAttempt.key);
    expect(next.body).toEqual({ comment: 'new send' });
  });

  it('clears a restored source after a replacement-key create despite an earlier removal failure', () => {
    const props = {
      userId: 'operator',
      form: 'mech-request',
      read: () => ({ comment: 'visible edit' }),
      parse: objectDraftPayload,
    };
    const original = renderHook(() => useLocalFormDraft(props));
    act(() => original.result.current.begin('create'));
    let first!: { key: string; body: { comment: string } };
    act(() => {
      first = original.result.current.prepareCreate({ comment: 'first send' });
    });
    const source = listLocalFormDrafts('operator', 'mech-request', 'create', objectDraftPayload)
      .drafts[0]!;
    original.unmount();

    const restored = renderHook(() => useLocalFormDraft(props));
    act(() => restored.result.current.begin('create'));
    act(() => restored.result.current.restore(source));
    const removal = failRemovalOf(source.id);
    const replacement = crypto.randomUUID();
    act(() =>
      expect(restored.result.current.releaseCreateAttempt(first.key, replacement)).toBe(true),
    );
    expect(restored.result.current.active?.previousCreateKeys).toContain(first.key);
    const released = restored.result.current.active!;
    restored.unmount();
    const nextTab = renderHook(() => useLocalFormDraft(props));
    act(() => nextTab.result.current.begin('create'));
    act(() => nextTab.result.current.restore(released));
    expect(nextTab.result.current.active?.previousCreateKeys).toContain(first.key);
    act(() => nextTab.result.current.prepareCreate({ comment: 'new send' }));
    act(() => nextTab.result.current.clear());
    expect(nextTab.result.current.active).not.toBeNull();
    expect(nextTab.result.current.status.available).toBe(false);
    removal.mockRestore();
    act(() => nextTab.result.current.clear());
    expect(
      listLocalFormDrafts('operator', 'mech-request', 'create', objectDraftPayload).drafts,
    ).toEqual([]);
  });

  it('clears a legacy restored source after manual reset and a new create', () => {
    const props = {
      userId: 'operator',
      form: 'service-request',
      read: () => ({ comment: 'visible edit' }),
      parse: objectDraftPayload,
    };
    const original = renderHook(() => useLocalFormDraft(props));
    act(() => original.result.current.begin('create'));
    act(() => original.result.current.prepareCreate({ comment: 'first send' }));
    const saved = listLocalFormDrafts('operator', 'service-request', 'create', objectDraftPayload)
      .drafts[0]!;
    const legacy = {
      ...saved,
      createAttempt: { key: saved.createAttempt!.key, body: saved.createAttempt!.body },
    };
    localStorage.setItem(`technic:form-draft:v1:${saved.id}`, JSON.stringify(legacy));
    original.unmount();

    const restored = renderHook(() => useLocalFormDraft(props));
    act(() => restored.result.current.begin('create'));
    act(() => restored.result.current.restore(legacy));
    const removal = failRemovalOf(saved.id);
    act(() => expect(restored.result.current.resetLegacyCreateAttempt()).toBe(true));
    expect(restored.result.current.active?.previousCreateKeys).toContain(legacy.createAttempt.key);
    removal.mockRestore();
    act(() => restored.result.current.prepareCreate({ comment: 'new send' }));
    act(() => restored.result.current.clear());
    expect(
      listLocalFormDrafts('operator', 'service-request', 'create', objectDraftPayload).drafts,
    ).toEqual([]);
  });
});
