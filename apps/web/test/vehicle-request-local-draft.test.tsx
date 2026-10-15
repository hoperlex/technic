import dayjs from 'dayjs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Form } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  draftValues,
  listLocalDrafts,
  newDraftId,
  restoreDraftValues,
  writeLocalDraft,
  type FormValues,
  type VehicleRequestLocalDraft,
} from '@features/vehicle-request-editor';
import { FormDraftAutosave } from '@shared/lib';

const target = { kind: 'edit' as const, sourceId: 'request-1' };
const values: FormValues = {
  requestType: 'freight_transport',
  customerKey: 'object:site-1',
  classificationKey: 'truck:',
  scheduledDate: dayjs('2026-10-16'),
  trips: [
    {
      key: 'trip-a',
      id: 'saved-trip',
      fromLocation: 'Карьер',
      fromAddress: { source: 'resolved', fiasId: 'from' },
    },
    { key: 'trip-b', toLocation: 'Площадка', comment: 'Вторая ездка' },
  ],
};

const snapshot = (overrides: Partial<VehicleRequestLocalDraft> = {}): VehicleRequestLocalDraft => ({
  schema: 1,
  id: newDraftId(),
  userId: 'user-1',
  target,
  baseVersion: 4,
  operationId: 'operation-1',
  savedAt: Date.now(),
  values: draftValues(values),
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('vehicle request local draft', () => {
  it('recovers dates, both trip rows and address metadata after storage round-trip', () => {
    expect(writeLocalDraft(snapshot())).toBe(true);
    const found = listLocalDrafts('user-1', target);
    expect(found.available).toBe(true);
    expect(found.drafts).toHaveLength(1);
    const restored = restoreDraftValues(found.drafts[0]!.values);
    expect(restored.scheduledDate?.format('YYYY-MM-DD')).toBe('2026-10-16');
    expect(restored.trips).toEqual(values.trips);
    expect(found.drafts[0]!.baseVersion).toBe(4);
    expect(found.drafts[0]!.operationId).toBe('operation-1');
  });

  it('keeps tabs and accounts separate and reports denied storage', () => {
    const first = snapshot();
    const second = snapshot();
    writeLocalDraft(first);
    writeLocalDraft(second);
    expect(listLocalDrafts('user-1', target).drafts.map((row) => row.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(listLocalDrafts('user-2', target).drafts).toHaveLength(0);
    expect(listLocalDrafts('user-1', { kind: 'copy', sourceId: 'request-1' }).drafts).toHaveLength(
      0,
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(writeLocalDraft(snapshot())).toBe(false);
  });

  it('keeps a draft begun before the required request type and classifier are chosen', () => {
    const incomplete = snapshot({
      values: draftValues({ trips: [{ key: 'first', fromLocation: 'Карьер' }] } as FormValues),
    });
    expect(writeLocalDraft(incomplete)).toBe(true);
    expect(listLocalDrafts('user-1', target).drafts[0]?.values.trips?.[0]?.fromLocation).toBe(
      'Карьер',
    );
  });

  it('saves a programmatic trip-list change and flushes on pagehide', async () => {
    vi.useFakeTimers();
    function Harness() {
      const [form] = Form.useForm<FormValues>();
      const save = () =>
        writeLocalDraft(snapshot({ values: draftValues(form.getFieldsValue(true)) }));
      return (
        <Form form={form} initialValues={values}>
          <FormDraftAutosave active form={form} onSave={save} />
          <button
            type="button"
            onClick={() =>
              form.setFieldsValue({
                trips: [
                  ...(form.getFieldValue('trips') ?? []),
                  { key: 'trip-c', toLocation: 'Склад' },
                ],
              })
            }
          >
            Add trip
          </button>
        </Form>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByText('Add trip'));
    await act(async () => vi.advanceTimersByTime(400));
    expect(listLocalDrafts('user-1', target).drafts[0]?.values.trips).toHaveLength(3);
    fireEvent(window, new Event('pagehide'));
    expect(listLocalDrafts('user-1', target).drafts).toHaveLength(2);
    vi.useRealTimers();
  });
});
