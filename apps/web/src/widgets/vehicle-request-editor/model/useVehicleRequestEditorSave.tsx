import { useState } from 'react';
import { App, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CARGO_AMOUNT_MESSAGE,
  moscowDateKeyOf,
  routeDateMismatch,
  type VehicleRequestDto,
  type CreateVehicleRequestInput,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { vehicleRouteKeys, vehicleRouteLink } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import {
  isBackdatedCreateAttempt,
  isLegacyOrdinaryCreateAttempt,
  retypeErases,
  type FormValues,
} from '@features/vehicle-request-editor';
import { mayHaveCommittedWrite } from '@shared/api';
import { LocalCreateAttemptError } from '@shared/lib';
import { useEditorTermDoor, type TermStepResult } from './useEditorTermDoor';
import { saveVehicleRequest } from './saveVehicleRequest';
import type { VehicleRequestEditorState } from './useVehicleRequestEditorState';

interface Input {
  openCreated: (request: VehicleRequestDto) => void;
  openRoute: (routeId: string) => void;
  state: VehicleRequestEditorState;
}

export function useVehicleRequestEditorSave({ openCreated, openRoute, state }: Input) {
  const { message, modal } = App.useApp();
  const [reconcilePending, setReconcilePending] = useState(false);
  const { can } = useAuth();
  const qc = useQueryClient();
  const canApprove = can('vehicleRequests.approve');

  const sendCreate = (body: CreateVehicleRequestInput) => {
    const attempt = state.draft.prepareCreate(body);
    return attempt.protocol === 'correction-v1'
      ? vehicleRequestsApi.createCorrection(attempt.body)
      : vehicleRequestsApi.createWithReceipt(attempt.body, attempt.key);
  };

  const reconcileAttempt = async () => {
    const attempt = state.draft.active?.createAttempt;
    if (state.record || attempt?.protocol !== 'receipt-v1' || reconcilePending) return;
    setReconcilePending(true);
    try {
      const outcome = await vehicleRequestsApi.reconcileCreateAttempt(attempt.body, attempt.key);
      if (outcome.state === 'not-created') {
        const applied = state.draft.acceptNotCreated(attempt.key, outcome.nextOperationId);
        if (applied === 'storage-error') {
          message.error(
            'Сверка завершилась, но новый ключ не сохранился на устройстве. Повторите сверку.',
          );
        } else if (applied === 'stale') {
          message.warning(
            'Попытка в этом окне уже изменилась. Проверьте черновик перед сохранением.',
          );
        } else {
          message.success(
            'Заявка по прежней попытке не создана. Исправьте поля и сохраните снова.',
          );
        }
        return;
      }

      // Receipt ownership proves creation, but reading the card must still use current permissions.
      let request: VehicleRequestDto | null = null;
      try {
        request = await vehicleRequestsApi.get(outcome.requestId);
      } catch {
        // A revoked read grant does not turn a committed create into a failed attempt.
      }
      if (!state.draft.clear()) {
        message.warning('Заявка создана, но черновик не удалось удалить с устройства.');
      }
      state.closeSaved();
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      if (request) {
        openCreated(request);
      } else {
        modal.info({
          title: 'Заявка создана',
          content: (
            <>
              Не удалось открыть карточку с текущими правами или соединением. ID заявки:{' '}
              <Typography.Text copyable>{outcome.requestId}</Typography.Text>
            </>
          ),
        });
      }
    } catch (error) {
      message.error(`Не удалось сверить исходную отправку: ${errorMessage(error)}. Ключ сохранён.`);
    } finally {
      setReconcilePending(false);
    }
  };

  const confirmBackdatedReset = () => {
    const attempt = state.draft.active?.createAttempt;
    if (state.record || !attempt || !isBackdatedCreateAttempt(attempt)) return;
    modal.confirm({
      title: 'Начать новую попытку заведения задним числом?',
      content: (
        <>
          Сначала проверьте список заявок. Первый запрос может завершиться позже даже после отказа
          или потери ответа. Новая отправка с другим ключом тогда создаст дубль. Поля и ездки
          останутся в форме; новый запрос автоматически не отправится.
        </>
      ),
      okText: 'Я проверил список — начать новую попытку',
      okButtonProps: { danger: true },
      cancelText: 'Оставить прежнюю попытку',
      onOk: () => {
        const outcome = state.resetBackdatedAttempt(attempt.key);
        if (outcome === 'storage-error') {
          message.error('Новые ключи не сохранились на устройстве. Прежняя попытка оставлена.');
        } else if (outcome === 'stale') {
          message.warning('Попытка уже изменилась. Проверьте черновик.');
        } else {
          message.success('Новая попытка подготовлена. Проверьте поля перед сохранением.');
        }
      },
    });
  };

  const confirmLegacyOrdinaryReset = () => {
    const attempt = state.draft.active?.createAttempt;
    if (state.record || !isLegacyOrdinaryCreateAttempt(attempt)) return;
    modal.confirm({
      title: 'Начать новую попытку после старой отправки?',
      content: (
        <>
          Сначала проверьте список заявок. Старая версия API могла проигнорировать ключ, а первый
          запрос может завершиться позже. Новая отправка тогда создаст дубль. Поля и ездки останутся
          в форме; новый запрос автоматически не отправится.
        </>
      ),
      okText: 'Я проверил список — начать новую попытку',
      okButtonProps: { danger: true },
      cancelText: 'Оставить прежнюю попытку',
      onOk: () => {
        const outcome = state.resetLegacyOrdinaryAttempt(attempt.key);
        if (outcome === 'storage-error') {
          message.error('Новый ключ не сохранился на устройстве. Прежняя попытка оставлена.');
        } else if (outcome === 'stale') {
          message.warning('Попытка уже изменилась. Проверьте черновик.');
        } else {
          message.success('Новая попытка подготовлена. Проверьте поля перед сохранением.');
        }
      },
    });
  };

  /**
   * The request was moved to another date while it sits in the previous day's route.
   *
   * The portal does not forbid such an edit: request and route are edited by different people at
   * different times, and forbidding it would demand fixing the route before learning of the
   * mismatch. Staying silent is wrong too — the route stays on the old day and the waybill would
   * print a task that no longer exists that day. So the dialog names the mismatch and leads to
   * where it is fixed: the route card, where the route day moves together with its requests.
   */
  const warnRouteDateMismatch = (saved: VehicleRequestDto) => {
    if (saved.requestType !== 'freight_transport' || !saved.route) return;
    // A local constant: the route is read later from the button closure, where the narrowing on
    // `saved.route` no longer applies.
    const route = saved.route;
    const routeLink = vehicleRouteLink(can, route.id);
    const mismatch = routeDateMismatch(
      { tripDate: moscowDateKeyOf(new Date(saved.scheduledAt)) },
      { displayNumber: route.displayNumber, routeDate: route.routeDate },
    );
    if (!mismatch) return;
    modal.warning({
      title: 'Дата заявки разошлась с днём маршрута',
      content: mismatch,
      okText: 'Понятно',
      // The navigation button sits next to the explanation, otherwise the person closes the dialog
      // and searches for the route by hand, and half the mismatches stay unnoticed. The route opens
      // as a window over the list (ADR 0120): leaving the list would take away the very request
      // just edited, together with its filters and page.
      ...(routeLink
        ? {
            cancelText: `Открыть маршрут ${route.displayNumber}`,
            okCancel: true,
            onCancel: () => openRoute(route.id),
          }
        : {}),
    });
  };

  const save = useMutation({
    mutationFn: (input: TermStepResult) => saveVehicleRequest(input, state, sendCreate),
    onSuccess: (saved) => {
      term.reset();
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // A changed work term reconciles ESM-2 again (`afterWorkPeriodChanged`), like an early end:
      // editing the request rewrites already issued forms.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      // Editing the request bumps its route's version (R18): addresses, contacts, count and
      // composition of trips go into the document, so the route card must re-read. Otherwise an
      // open route keeps the old version and its next action gets 409 — the server protects the
      // data, but the screen is unreliable until refreshed.
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      if (!state.draft.clear()) {
        message.warning(
          'Заявка сохранена, но связанные черновики не удалось удалить с устройства.',
        );
      }
      state.closeSaved();
      warnRouteDateMismatch(saved);
    },
    onError: (error, { period }) => {
      message.error(
        // The one half-applied state of a split save (see `useEditorTermDoor`): it is named, not
        // hidden — the editor stays open, and the next "Save" sends only the rest.
        period
          ? `Срок работ изменён, но остальные правки не сохранены: ${errorMessage(error)}`
          : errorMessage(error),
      );
      if (!state.record && !(error instanceof LocalCreateAttemptError)) {
        message.warning(
          mayHaveCommittedWrite(error)
            ? 'Ответ сервера мог не дойти. Сверьте исходную отправку по сохранённому ключу.'
            : 'Отказ повторной отправки не доказывает, что первая заявка не создана. Сверьте исходную попытку.',
        );
      }
    },
  });

  const term = useEditorTermDoor({ state, saveRest: (input) => save.mutate(input) });

  /**
   * Conversion is confirmed, an ordinary save is not. Changing the type does not just change
   * values: the previous type's fields disappear with its detail, and an approval set by someone
   * other than the editor goes too. The list comes from the request itself (`retypeErases`), not
   * general words: the person must see what will cease to exist before the click, not in the
   * history afterwards.
   */
  const submit = (values: FormValues) => {
    const { record } = state;
    if (!record || record.requestType === values.requestType) {
      /*
       * A term change has its own door (K3a; Ж4, З5, Д2 of `docs/assignment-periods-plan.md`).
       * Saving then splits into two commands: the term has its own consequences and handshakes,
       * and "extend and also fix the comment" is never one body. The term goes first, then the
       * rest with the version it returned — the order and its failures are `useEditorTermDoor`'s.
       */
      if (!term.start(values)) save.mutate({ values, period: term.applied });
      return;
    }
    // An approver's own edit does not drop the approval (ADR 0025): the approver confirms the
    // conversion by the edit itself — the server answers by the same rule.
    const erased = retypeErases(record, !!record.approvedAt && !canApprove);
    modal.confirm({
      title: `Переоформить заявку ${record.displayNumber} в «${vehicleRequestTypeLabels[values.requestType]}»?`,
      content: (
        <>
          <div>У заявки не станет:</div>
          <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
            {erased.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Typography.Text type="secondary">
            Номер, вложения и история остаются за заявкой.
          </Typography.Text>
        </>
      ),
      okText: 'Переоформить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => save.mutateAsync({ values }),
    });
  };

  /** Rules that depend on the request type and cannot be expressed as field rules. */
  const onFinish = (values: FormValues) => {
    if (state.reviewRequired) {
      message.warning('Сначала подтвердите проверку восстановленных полей и ездок.');
      return;
    }
    // Keep the last keystroke before the request leaves the browser. A failed network response must
    // leave a recoverable form even when the autosave timer has not fired yet.
    state.draft.persist();
    if (values.requestType === 'special_equipment') {
      submit(values);
      return;
    }
    /*
     * Quantity is asked of **each** trip, not of the request: they carry different things, and "6
     * trips, one without volume" is a legitimate form state that the server rejects naming the row
     * (`assertCargoAmount`). The refusal names the row the way the list card does: a new trip has
     * no number yet, and promising one is impossible (R13a).
     */
    const emptyCargo = state.cargoRequired
      ? (values.trips ?? []).findIndex((trip) => trip.volumeM3 == null && trip.weightTons == null)
      : -1;
    if (emptyCargo >= 0) {
      const trips = values.trips ?? [];
      message.error(
        trips.length > 1
          ? `Строка ${emptyCargo + 1}: ${CARGO_AMOUNT_MESSAGE}`
          : CARGO_AMOUNT_MESSAGE,
      );
      return;
    }
    // Strict address verification (ADR 0006) is not checked here: the field's own rule stops the
    // submit with an error on that field rather than a general message.
    submit(values);
  };

  return {
    confirmLoading: save.isPending || term.pending,
    onFinish,
    periodModalProps: term.periodModalProps,
    reconcileAttempt,
    reconcilePending,
    confirmBackdatedReset,
    confirmLegacyOrdinaryReset,
  };
}
