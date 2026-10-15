import { act, renderHook } from '@testing-library/react';
import { Form } from 'antd';
import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateVehicleRequestInput } from '@technic/contracts';
import { listLocalDrafts, type FormValues } from '@features/vehicle-request-editor';
import { useVehicleRequestLocalDraft } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestLocalDraft';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const originalKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const replacementKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const originalBody = {
  requestType: 'special_equipment',
  objectId: userId,
  vehicleTypeId: userId,
  dateFrom: '2026-10-20',
  responsibleName: 'Иванов Иван',
  responsiblePhone: '+79990000000',
  comment: 'original',
  fileIds: [originalKey],
} satisfies CreateVehicleRequestInput;

const changedValues = {
  requestType: 'freight_transport',
  comment: 'edited in second tab',
  scheduledDate: dayjs('2026-10-21'),
  trips: [
    { key: 'one', fromLocation: 'Карьер' },
    { key: 'two', toLocation: 'Площадка', comment: 'Second trip' },
  ],
} as FormValues;

function useTab() {
  const [form] = Form.useForm<FormValues>();
  const draft = useVehicleRequestLocalDraft(form, userId);
  return { form, draft };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Vehicle Request reconciliation draft', () => {
  it('freezes a private JSON copy of nested rows and file IDs before sending', () => {
    const tab = renderHook(useTab);
    const mutable = {
      ...originalBody,
      fileIds: [originalKey],
      trips: [{ fromLocation: 'Первый адрес', cargo: { amount: 1 } }],
    } as unknown as CreateVehicleRequestInput;
    act(() => tab.result.current.draft.begin({ kind: 'create' }, null, originalKey));
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(mutable);
    });

    mutable.fileIds.push(replacementKey);
    (mutable as unknown as { trips: { cargo: { amount: number } }[] }).trips[0]!.cargo.amount = 2;
    (sent.body as unknown as { trips: { fromLocation: string }[] }).trips[0]!.fromLocation =
      'Изменено отправителем';

    let retry!: typeof sent;
    act(() => {
      retry = tab.result.current.draft.prepareCreate(mutable);
    });
    expect(retry.body.fileIds).toEqual([originalKey]);
    expect(retry.body).toMatchObject({
      trips: [{ fromLocation: 'Первый адрес', cargo: { amount: 1 } }],
    });
    expect(listLocalDrafts(userId, { kind: 'create' }).drafts[0]?.createAttempt?.body).toEqual(
      retry.body,
    );
  });

  it('restores the same frozen body in a second tab and atomically adopts the server replacement key', () => {
    const first = renderHook(useTab);
    act(() => first.result.current.draft.begin({ kind: 'create' }, null, originalKey));
    let sent!: ReturnType<typeof first.result.current.draft.prepareCreate>;
    act(() => {
      sent = first.result.current.draft.prepareCreate(originalBody);
    });
    expect(sent.protocol).toBe('receipt-v1');
    const source = listLocalDrafts(userId, { kind: 'create' }).drafts[0]!;

    const second = renderHook(useTab);
    act(() => second.result.current.draft.begin({ kind: 'create' }, null, crypto.randomUUID()));
    expect(second.result.current.draft.pending.map((row) => row.id)).toContain(source.id);
    act(() => second.result.current.draft.restore(source, null));
    expect(second.result.current.draft.active?.id).not.toBe(source.id);
    act(() => second.result.current.form.setFieldsValue(changedValues));
    act(() => expect(second.result.current.draft.persist()).toBe(true));
    let frozen!: typeof sent;
    act(() => {
      frozen = second.result.current.draft.prepareCreate({ ...originalBody, comment: 'changed' });
    });
    expect(frozen).toEqual(sent);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      expect(second.result.current.draft.acceptNotCreated(sent.key, replacementKey)).toBe(
        'resolved',
      );
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    const fork = listLocalDrafts(userId, { kind: 'create' }).drafts.find(
      (row) => row.id === second.result.current.draft.active?.id,
    )!;
    expect(fork.createAttempt).toBeUndefined();
    expect(fork.nextCreateKey).toBe(replacementKey);
    expect(fork.values.trips).toHaveLength(2);
    expect(first.result.current.draft.active?.createAttempt).toEqual(sent);

    let corrected!: typeof sent;
    act(() => {
      corrected = second.result.current.draft.prepareCreate({
        ...originalBody,
        comment: 'corrected after proof',
      });
    });
    expect(corrected.key).toBe(replacementKey);
    expect(corrected.body.comment).toBe('corrected after proof');
  });

  it('keeps the frozen original when the atomic release cannot be stored', () => {
    const tab = renderHook(useTab);
    act(() => tab.result.current.draft.begin({ kind: 'create' }, null, originalKey));
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(originalBody);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    act(() => {
      expect(tab.result.current.draft.acceptNotCreated(sent.key, replacementKey)).toBe(
        'storage-error',
      );
    });
    expect(tab.result.current.draft.active?.createAttempt).toEqual(sent);
    expect(tab.result.current.draft.active?.nextCreateKey).toBeUndefined();
    expect(listLocalDrafts(userId, { kind: 'create' }).drafts[0]?.createAttempt).toEqual(sent);
  });

  it.each(['receipt-v1', 'correction-v1'] as const)(
    'clears restored source and fork after confirmed %s creation',
    (protocol) => {
      const first = renderHook(useTab);
      act(() => first.result.current.draft.begin({ kind: 'create' }, null, originalKey));
      act(() => {
        first.result.current.draft.prepareCreate(
          protocol === 'correction-v1'
            ? { ...originalBody, operationId: originalKey, backdateReason: 'Correction' }
            : originalBody,
        );
      });
      const source = listLocalDrafts(userId, { kind: 'create' }).drafts[0]!;
      const second = renderHook(useTab);
      act(() => second.result.current.draft.begin({ kind: 'create' }, null, crypto.randomUUID()));
      act(() => second.result.current.draft.restore(source, null));
      expect(listLocalDrafts(userId, { kind: 'create' }).drafts).toHaveLength(2);

      act(() => expect(second.result.current.draft.clear()).toBe(true));

      expect(listLocalDrafts(userId, { kind: 'create' }).drafts).toHaveLength(0);
      expect(second.result.current.draft.active).toBeNull();
    },
  );

  it('keeps the active fork and reports storage failure if its source cannot be removed', () => {
    const first = renderHook(useTab);
    act(() => first.result.current.draft.begin({ kind: 'create' }, null, originalKey));
    act(() => first.result.current.draft.prepareCreate(originalBody));
    const source = listLocalDrafts(userId, { kind: 'create' }).drafts[0]!;
    const second = renderHook(useTab);
    act(() => second.result.current.draft.begin({ kind: 'create' }, null, crypto.randomUUID()));
    act(() => second.result.current.draft.restore(source, null));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage denied');
    });

    act(() => expect(second.result.current.draft.clear()).toBe(false));

    expect(second.result.current.draft.active?.createAttempt?.key).toBe(source.createAttempt?.key);
    expect(second.result.current.draft.status.available).toBe(false);
    expect(listLocalDrafts(userId, { kind: 'create' }).drafts).toHaveLength(2);
  });

  it('resets a backdated attempt only after explicit action and saves both new IDs with the fields', () => {
    const tab = renderHook(useTab);
    act(() => tab.result.current.draft.begin({ kind: 'create' }, null, originalKey));
    act(() => tab.result.current.form.setFieldsValue(changedValues));
    const backdatedBody = {
      ...originalBody,
      operationId: originalKey,
      backdateReason: 'Correction',
    };
    let sent!: ReturnType<typeof tab.result.current.draft.prepareCreate>;
    act(() => {
      sent = tab.result.current.draft.prepareCreate(backdatedBody);
    });
    expect(sent.protocol).toBe('correction-v1');
    const nextOperationId = crypto.randomUUID();
    const nextKey = crypto.randomUUID();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      expect(
        tab.result.current.draft.resetBackdatedAttempt(sent.key, nextOperationId, nextKey),
      ).toBe('resolved');
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    const saved = listLocalDrafts(userId, { kind: 'create' }).drafts[0]!;
    expect(saved).toMatchObject({
      operationId: nextOperationId,
      nextCreateKey: nextKey,
      values: { comment: changedValues.comment },
    });
    expect(saved.values.trips).toHaveLength(2);
    expect(saved.createAttempt).toBeUndefined();
    expect(tab.result.current.draft.active?.createAttempt).toBeUndefined();
    let next!: typeof sent;
    act(() => {
      next = tab.result.current.draft.prepareCreate({
        ...backdatedBody,
        operationId: nextOperationId,
      });
    });
    expect(next.key).toBe(nextKey);
    expect(next.body.operationId).toBe(nextOperationId);
    expect(next.protocol).toBe('correction-v1');
  });
});
