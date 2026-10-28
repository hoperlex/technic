import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listLocalFormDrafts,
  newLocalFormDraftId,
  objectDraftPayload,
  restoreFormDateFields,
  storeFormDateFields,
  writeLocalFormDraft,
} from '@shared/lib';
import { mergeComposition } from '../src/widgets/weekly-request-workspace/model/useWeeklyCompositionDraft';
import type { WeeklyCompositionState } from '../src/widgets/weekly-request-workspace/model/compositionState';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('request draft recovery across forms', () => {
  it('keeps an uncertain submitted attempt after unsent drafts age out', () => {
    const savedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const base = {
      schema: 1 as const,
      userId: 'dispatcher',
      form: 'mech-duplicate',
      target: 'source-1',
      savedAt,
      payload: { id: 'source-1' },
    };
    expect(writeLocalFormDraft({ ...base, id: 'unsent' })).toBe(true);
    expect(
      writeLocalFormDraft({
        ...base,
        id: 'attempted',
        createAttempt: {
          key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          body: {},
          protocol: 'receipt-v1',
        },
      }),
    ).toBe(true);
    expect(
      listLocalFormDrafts('dispatcher', 'mech-duplicate', undefined, objectDraftPayload).drafts.map(
        (item) => item.id,
      ),
    ).toEqual(['attempted']);
  });

  it('keeps form types, accounts and targets separate and restores calendar dates', () => {
    const payload = storeFormDateFields(
      { deliveryDate: dayjs('2026-10-16'), comment: 'После обеда' },
      ['deliveryDate'],
    );
    const draft = {
      schema: 1 as const,
      id: newLocalFormDraftId(),
      userId: 'dispatcher',
      form: 'waste-request',
      target: 'create',
      savedAt: Date.now(),
      payload,
    };
    expect(writeLocalFormDraft(draft)).toBe(true);
    expect(
      listLocalFormDrafts('dispatcher', 'mech-request', 'create', objectDraftPayload).drafts,
    ).toEqual([]);
    expect(
      listLocalFormDrafts('dispatcher', 'waste-request', 'edit', objectDraftPayload).drafts,
    ).toEqual([]);
    expect(
      listLocalFormDrafts('other', 'waste-request', 'create', objectDraftPayload).drafts,
    ).toEqual([]);
    const recovered = listLocalFormDrafts(
      'dispatcher',
      'waste-request',
      'create',
      objectDraftPayload,
    );
    expect(recovered.drafts[0]?.id).toBe(draft.id);
    expect(
      restoreFormDateFields<{ deliveryDate: dayjs.Dayjs; comment: string }>(
        recovered.drafts[0]!.payload,
        ['deliveryDate'],
      ).deliveryDate.format('YYYY-MM-DD'),
    ).toBe('2026-10-16');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(writeLocalFormDraft({ ...draft, id: newLocalFormDraftId() })).toBe(false);
  });

  it('retains new server rows when an older weekly composition is recovered', () => {
    const row = (requestId: string) => ({
      requestId,
      displayNumber: requestId,
      title: requestId,
      effectiveDateTo: '2026-10-17',
      ownership: null,
      suggestedDateTo: '2026-10-18',
      extendBlockedReason: null,
      warnings: [],
      staleReason: null,
      itemId: null,
    });
    const current: WeeklyCompositionState = {
      rows: [row('vehicle-a'), row('vehicle-b')],
      decisions: {
        'vehicle-a': { kind: 'leave', dateTo: '' },
        'vehicle-b': { kind: 'extend', dateTo: '2026-10-18' },
      },
      newRows: [],
    };
    const saved: WeeklyCompositionState = {
      rows: [row('vehicle-a')],
      decisions: { 'vehicle-a': { kind: 'extend', dateTo: '2026-10-25' } },
      newRows: [],
    };
    const merged = mergeComposition(current, saved);
    expect(merged.rows.map((item) => item.requestId)).toEqual(['vehicle-a', 'vehicle-b']);
    expect(merged.decisions['vehicle-a']?.dateTo).toBe('2026-10-25');
    expect(merged.decisions['vehicle-b']?.kind).toBe('extend');
  });
});
