import { act, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VehicleRequestDto } from '@technic/contracts';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import { listLocalDrafts, type FormValues } from '@features/vehicle-request-editor';
import { useVehicleRequestEditorSave } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorSave';
import { useVehicleRequestLocalDraft } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestLocalDraft';
import type { VehicleRequestEditorState } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorState';
import {
  freightFormValues,
  specialFormValues,
  tripFormRow,
} from './factories/vehicleRequestCreateBody';
import { renderWithUser } from './render';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nextKey = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const REFUSAL_WARNING = /Отказ повторной отправки не доказывает/;
const LOST_ANSWER_WARNING = /Ответ сервера мог не дойти/;

function mount(options: { backdated?: boolean } = {}) {
  const openCreated = vi.fn();
  const closeSaved = vi.fn();
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
      backdated: !!options.backdated,
      reviewRequired: false,
      cargoRequired: false,
      customer: { customerPairOf: () => ({ objectId: userId, departmentId: null }) },
      editor: { newFileIds: () => [], removedIds: [] },
      closeSaved,
    } as unknown as VehicleRequestEditorState;
    current = {
      draft,
      save: useVehicleRequestEditorSave({ openCreated, openRoute: vi.fn(), state }),
    };
    return null;
  }
  renderWithUser(<Harness />);
  const view = () => current!;
  act(() => view().draft.begin({ kind: 'create' }, null, operationId));
  return { view, openCreated, closeSaved };
}

const storedAttempts = () =>
  listLocalDrafts(userId, { kind: 'create' }).drafts.map((row) => row.createAttempt);

const apiError = (status: number, message: string, fields?: Record<string, string>) => ({
  code: status === 409 ? 'idempotency_conflict' : 'validation_error',
  status,
  message,
  fields,
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('Vehicle Request create: a body the portal refuses locally', () => {
  it('shows the reason, sends nothing, freezes nothing and does not warn about a first request', async () => {
    const create = vi.spyOn(vehicleRequestsApi, 'createWithReceipt');
    const correction = vi.spyOn(vehicleRequestsApi, 'createCorrection');
    const reconcile = vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt');
    const { view } = mount();

    act(() => {
      view().save.onFinish(freightFormValues({ trips: [tripFormRow({ volumeM3: 0 })] }));
    });

    expect(
      await screen.findByText(
        'Проверьте поля формы: Объём (строка 1) — Значение должно быть больше 0',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(view().save.confirmLoading).toBe(false));
    expect(create).not.toHaveBeenCalled();
    expect(correction).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(screen.queryByText(REFUSAL_WARNING)).toBeNull();
    expect(screen.queryByText(LOST_ANSWER_WARNING)).toBeNull();
    expect(view().draft.active?.createAttempt).toBeUndefined();
    expect(storedAttempts().every((attempt) => attempt === undefined)).toBe(true);
  });

  it('lets the corrected form through with the same key', async () => {
    const create = vi
      .spyOn(vehicleRequestsApi, 'createWithReceipt')
      .mockResolvedValue({ id: requestId } as VehicleRequestDto);
    const { view } = mount();
    act(() => {
      view().save.onFinish(freightFormValues({ trips: [tripFormRow({ volumeM3: 0 })] }));
    });
    await screen.findByText(/Значение должно быть больше 0/);
    await waitFor(() => expect(view().save.confirmLoading).toBe(false));

    act(() => {
      view().save.onFinish(freightFormValues({ trips: [tripFormRow({ volumeM3: 2 })] }));
    });

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ trips: [{ volumeM3: 2 }] });
  });

  it('resends a valid frozen body when the form was edited into an invalid one', async () => {
    const create = vi.spyOn(vehicleRequestsApi, 'createWithReceipt');
    create.mockRejectedValue(new TypeError('Failed to fetch'));
    const { view } = mount();
    act(() => {
      view().save.onFinish(freightFormValues({ trips: [tripFormRow({ volumeM3: 3 })] }));
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view().save.confirmLoading).toBe(false));

    act(() => {
      view().save.onFinish(freightFormValues({ trips: [tripFormRow({ volumeM3: 0 })] }));
    });

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(create.mock.calls[1]?.[0]).toMatchObject({ trips: [{ volumeM3: 3 }] });
    expect(screen.queryByText(/Значение должно быть больше 0/)).toBeNull();
  });
});

describe('Vehicle Request create: the route refuses a frozen receipt-v1 attempt', () => {
  it.each([
    [
      400,
      'Ошибка валидации данных',
      { 'trips.0.volumeM3': 'Значение должно быть больше 0' },
      'Ошибка валидации данных: Объём (строка 1) — Значение должно быть больше 0',
    ],
    [422, 'Дата заявки в прошлом.', undefined, 'Дата заявки в прошлом'],
  ])(
    'answer %i: reconciles by itself, releases the attempt and names the reason',
    async (status, text, fields, reason) => {
      const create = vi
        .spyOn(vehicleRequestsApi, 'createWithReceipt')
        .mockRejectedValue(apiError(status, text, fields));
      const reconcile = vi
        .spyOn(vehicleRequestsApi, 'reconcileCreateAttempt')
        .mockResolvedValue({ state: 'not-created', nextOperationId: nextKey });
      const { view, closeSaved } = mount();

      act(() => {
        view().save.onFinish(specialFormValues());
      });

      expect(
        await screen.findByText(`Заявка не создана: ${reason}. Исправьте поля и сохраните снова.`),
      ).toBeTruthy();
      const [body, key] = create.mock.calls[0]!;
      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(body, key);
      expect(view().draft.active?.createAttempt).toBeUndefined();
      expect(view().draft.active?.nextCreateKey).toBe(nextKey);
      expect(storedAttempts().every((attempt) => attempt === undefined)).toBe(true);
      expect(screen.queryByText(REFUSAL_WARNING)).toBeNull();
      // The error toast was rewritten in place, not left next to the explanation.
      expect(screen.queryByText(text)).toBeNull();
      // Nothing is sent without a person pressing the button again.
      expect(create).toHaveBeenCalledOnce();
      expect(closeSaved).not.toHaveBeenCalled();

      create.mockResolvedValue({ id: requestId } as VehicleRequestDto);
      act(() => {
        view().save.onFinish(specialFormValues({ comment: 'исправлено' }));
      });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(create.mock.calls[1]).toEqual([
        expect.objectContaining({ comment: 'исправлено' }),
        nextKey,
      ]);
    },
  );

  it('opens the created request when the reconciliation proves the first send committed', async () => {
    vi.spyOn(vehicleRequestsApi, 'createWithReceipt').mockRejectedValue(
      apiError(422, 'Дата заявки в прошлом'),
    );
    vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt').mockResolvedValue({
      state: 'created',
      requestId,
    });
    const request = { id: requestId, displayNumber: 'ТС-40' } as VehicleRequestDto;
    vi.spyOn(vehicleRequestsApi, 'get').mockResolvedValue(request);
    const { view, openCreated, closeSaved } = mount();

    act(() => {
      view().save.onFinish(specialFormValues());
    });

    await waitFor(() => expect(openCreated).toHaveBeenCalledWith(request));
    expect(closeSaved).toHaveBeenCalledOnce();
    expect(view().draft.active).toBeNull();
    expect(screen.queryByText(/Заявка не создана/)).toBeNull();
    expect(screen.queryByText(REFUSAL_WARNING)).toBeNull();
  });

  it('keeps the frozen original and the old warning when the reconciliation itself fails', async () => {
    const create = vi
      .spyOn(vehicleRequestsApi, 'createWithReceipt')
      .mockRejectedValue(apiError(400, 'Ошибка валидации данных'));
    const reconcile = vi
      .spyOn(vehicleRequestsApi, 'reconcileCreateAttempt')
      .mockRejectedValue({ code: 'unavailable', status: 503, message: 'Сервер недоступен' });
    const { view } = mount();

    act(() => {
      view().save.onFinish(specialFormValues());
    });

    expect(
      await screen.findByText(/Не удалось сверить исходную отправку: Сервер недоступен/),
    ).toBeTruthy();
    expect(await screen.findByText(REFUSAL_WARNING)).toBeTruthy();
    // The refusal text itself is still on the screen: nothing replaced it.
    expect(screen.getByText('Ошибка валидации данных')).toBeTruthy();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(view().draft.active?.createAttempt).toMatchObject({
      key: create.mock.calls[0]![1],
      protocol: 'receipt-v1',
    });
    expect(view().draft.active?.nextCreateKey).toBeUndefined();
  });

  it.each([
    ['a network failure', new TypeError('Failed to fetch'), LOST_ANSWER_WARNING],
    ['a server error', apiError(503, 'Сервис недоступен'), LOST_ANSWER_WARNING],
    ['a key conflict', apiError(409, 'Ключ занят другой заявкой'), REFUSAL_WARNING],
  ])('%s does not start a reconciliation', async (_name, error, warning) => {
    vi.spyOn(vehicleRequestsApi, 'createWithReceipt').mockRejectedValue(error);
    const reconcile = vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt');
    const { view } = mount();

    act(() => {
      view().save.onFinish(specialFormValues());
    });

    expect(await screen.findByText(warning)).toBeTruthy();
    expect(reconcile).not.toHaveBeenCalled();
    expect(view().draft.active?.createAttempt?.protocol).toBe('receipt-v1');
  });

  it('keeps the manual door for a correction-v1 attempt', async () => {
    const correction = vi
      .spyOn(vehicleRequestsApi, 'createCorrection')
      .mockRejectedValue(apiError(422, 'Нет права на коррекцию'));
    const reconcile = vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt');
    const { view } = mount({ backdated: true });

    act(() => {
      view().save.onFinish(
        specialFormValues({ dateFrom: dayjs('2026-10-01'), backdateReason: 'Забыли завести' }),
      );
    });

    expect(await screen.findByText(REFUSAL_WARNING)).toBeTruthy();
    expect(correction).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(view().draft.active?.createAttempt?.protocol).toBe('correction-v1');
  });

  it('does not start a second reconciliation while one is running', async () => {
    const create = vi.spyOn(vehicleRequestsApi, 'createWithReceipt');
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    create.mockRejectedValue(apiError(422, 'Дата заявки в прошлом'));
    let finish!: (value: { state: 'not-created'; nextOperationId: string }) => void;
    const reconcile = vi.spyOn(vehicleRequestsApi, 'reconcileCreateAttempt').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { view } = mount();
    act(() => {
      view().save.onFinish(specialFormValues());
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view().save.confirmLoading).toBe(false));

    // The button's reconciliation is in flight when the next send is refused.
    act(() => {
      void view().save.reconcileAttempt();
    });
    expect(reconcile).toHaveBeenCalledOnce();
    act(() => {
      view().save.onFinish(specialFormValues());
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view().save.confirmLoading).toBe(false));
    expect(reconcile).toHaveBeenCalledOnce();

    await act(async () => finish({ state: 'not-created', nextOperationId: nextKey }));
    await waitFor(() => expect(view().draft.active?.nextCreateKey).toBe(nextKey));
  });
});
