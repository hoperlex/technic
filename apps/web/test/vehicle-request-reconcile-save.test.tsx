import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateVehicleRequestInput, VehicleRequestDto } from '@technic/contracts';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import {
  draftValues,
  newDraftId,
  writeLocalDraft,
  type FormValues,
} from '@features/vehicle-request-editor';
import { useVehicleRequestEditorSave } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorSave';
import { useVehicleRequestLocalDraft } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestLocalDraft';
import type { VehicleRequestEditorState } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorState';
import { renderWithUser } from './render';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const nextKey = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const body = {
  requestType: 'special_equipment',
  objectId: userId,
  vehicleTypeId: userId,
  dateFrom: '2026-10-20',
  responsibleName: 'Иванов Иван',
  responsiblePhone: '+79990000000',
  comment: 'first POST',
  fileIds: [key],
} satisfies CreateVehicleRequestInput;

function mountAttempt(legacy = false) {
  const openCreated = vi.fn();
  const closeSaved = vi.fn();
  const source = legacy
    ? {
        schema: 1 as const,
        id: newDraftId(),
        userId,
        target: { kind: 'create' as const },
        baseVersion: null,
        operationId: key,
        savedAt: Date.now(),
        values: draftValues({} as FormValues),
        createAttempt: { key, body },
      }
    : null;
  if (source) expect(writeLocalDraft(source)).toBe(true);
  let current: {
    draft: ReturnType<typeof useVehicleRequestLocalDraft>;
    save: ReturnType<typeof useVehicleRequestEditorSave>;
  } | null = null;
  function Harness() {
    const [form] = Form.useForm<FormValues>();
    const draft = useVehicleRequestLocalDraft(form, userId);
    const state = {
      form,
      draft,
      record: null,
      operationId: key,
      backdated: false,
      reviewRequired: false,
      cargoRequired: false,
      customer: { customerPairOf: () => ({ objectId: userId, departmentId: null }) },
      editor: { newFileIds: () => [] },
      closeSaved,
      resetLegacyOrdinaryAttempt: (attemptKey: string) =>
        draft.resetLegacyOrdinaryAttempt(attemptKey, nextKey),
    } as unknown as VehicleRequestEditorState;
    current = {
      draft,
      save: useVehicleRequestEditorSave({ openCreated, openRoute: vi.fn(), state }),
    };
    return null;
  }
  renderWithUser(<Harness />);
  const view = () => current!;
  act(() => {
    view().draft.begin({ kind: 'create' }, null, key);
    if (source) view().draft.restore(source, null);
    else view().draft.prepareCreate(body);
  });
  return { view, openCreated, closeSaved };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Vehicle Request create reconciliation', () => {
  it.each([409, 503])('keeps the frozen original after reconcile returns %i', async (status) => {
    const reconcile = vi
      .spyOn(vehicleRequestsApi, 'reconcileCreateAttempt')
      .mockRejectedValue({ status, message: 'unavailable' });
    const { view, closeSaved } = mountAttempt();
    const attempt = view().draft.active!.createAttempt!;

    await act(async () => view().save.reconcileAttempt());

    expect(reconcile).toHaveBeenCalledWith(body, attempt.key);
    expect(view().draft.active?.createAttempt).toEqual(attempt);
    expect(closeSaved).not.toHaveBeenCalled();
  });

  it('releases only after server proof and uses the server replacement key', async () => {
    vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt').mockResolvedValue({
      state: 'not-created',
      nextOperationId: nextKey,
    });
    const { view, closeSaved } = mountAttempt();

    await act(async () => view().save.reconcileAttempt());

    expect(view().draft.active?.createAttempt).toBeUndefined();
    expect(view().draft.active?.nextCreateKey).toBe(nextKey);
    expect(closeSaved).not.toHaveBeenCalled();
    let next!: ReturnType<ReturnType<typeof useVehicleRequestLocalDraft>['prepareCreate']>;
    act(() => {
      next = view().draft.prepareCreate({ ...body, comment: 'corrected' });
    });
    expect(next).toMatchObject({ key: nextKey, body: { comment: 'corrected' } });
  });

  it('reads a committed request with current permissions before opening it', async () => {
    vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt').mockResolvedValue({
      state: 'created',
      requestId,
    });
    const request = { id: requestId, displayNumber: 'ТС-40' } as VehicleRequestDto;
    const get = vi.spyOn(vehicleRequestsApi, 'get').mockResolvedValue(request);
    const { view, openCreated, closeSaved } = mountAttempt();

    await act(async () => view().save.reconcileAttempt());
    await waitFor(() => expect(openCreated).toHaveBeenCalledWith(request));

    expect(get).toHaveBeenCalledWith(requestId);
    expect(closeSaved).toHaveBeenCalledOnce();
    expect(view().draft.active).toBeNull();
  });

  it('requires an explicit warning confirmation before replacing an old root-route key', async () => {
    const create = vi.spyOn(vehicleRequestsApi, 'createWithReceipt');
    const { view } = mountAttempt(true);

    act(() => view().save.confirmLegacyOrdinaryReset());
    expect(view().draft.active?.createAttempt?.key).toBe(key);
    expect(await screen.findByText(/Старая версия API могла проигнорировать ключ/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Я проверил список — начать новую попытку' }),
    );

    await waitFor(() => expect(view().draft.active?.createAttempt).toBeUndefined());
    expect(view().draft.active?.nextCreateKey).toBe(nextKey);
    expect(create).not.toHaveBeenCalled();
  });
});
