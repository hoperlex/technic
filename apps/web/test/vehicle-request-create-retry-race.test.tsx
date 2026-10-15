import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import dayjs from 'dayjs';
import type { VehicleRequestDto } from '@technic/contracts';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import type { FormValues } from '@features/vehicle-request-editor';
import { useVehicleRequestEditorSave } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorSave';
import { useVehicleRequestLocalDraft } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestLocalDraft';
import type { VehicleRequestEditorState } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorState';
import { renderWithUser } from './render';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const vehicleTypeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('vehicle request create retry race', () => {
  it('keeps the original body and key after a later 422 while the first POST can still commit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T20:59:00Z'));

    let finishFirst!: (value: VehicleRequestDto) => void;
    const firstResponse = new Promise<VehicleRequestDto>((resolve) => {
      finishFirst = resolve;
    });
    const create = vi.spyOn(vehicleRequestsApi, 'createWithReceipt');
    create.mockImplementationOnce(() => firstResponse);
    create.mockRejectedValueOnce({ status: 422, message: 'Дата в прошлом' });

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
        operationId,
        backdated: false,
        reviewRequired: false,
        cargoRequired: false,
        customer: { customerPairOf: () => ({ objectId: userId, departmentId: null }) },
        editor: { newFileIds: () => [] },
        closeSaved: vi.fn(),
      } as unknown as VehicleRequestEditorState;
      current = {
        draft,
        save: useVehicleRequestEditorSave({ openCreated: vi.fn(), openRoute: vi.fn(), state }),
      };
      return null;
    }
    renderWithUser(<Harness />);
    const values = {
      requestType: 'special_equipment',
      classificationKey: `${vehicleTypeId}:`,
      dateFrom: dayjs('2026-10-20'),
      responsibleName: 'Иван',
      responsiblePhone: '+79990000000',
      comment: 'Исходное тело',
    } as FormValues;
    act(() => {
      current!.draft.begin({ kind: 'create' }, null, operationId);
      current!.save.onFinish(values);
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(current!.draft.active?.createAttempt?.body).toMatchObject({ comment: 'Исходное тело' });

    // A retry reaches the date gate before the first in-flight request has committed its receipt.
    vi.setSystemTime(new Date('2026-10-20T21:01:00Z'));
    act(() => current!.save.onFinish(values));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(current!.save.confirmLoading).toBe(false));
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(current!.draft.active).toMatchObject({
      operationId,
      createAttempt: { protocol: 'receipt-v1', body: { comment: 'Исходное тело' } },
    });

    // The first POST is still permitted to finish after the apparent refusal of the retry.
    await act(async () => {
      finishFirst({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } as VehicleRequestDto);
      await firstResponse;
    });
  });
});
