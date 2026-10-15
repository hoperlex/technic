import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listLocalFormDrafts, objectDraftPayload, useLocalFormDraft } from '@shared/lib';
import { LocalFormDraftNotice } from '@shared/ui';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ordinary request creation attempt', () => {
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
    expect(saved.createAttempt).toEqual(sent);
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
});
