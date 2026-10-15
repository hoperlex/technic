import { useState } from 'react';
import { App, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CARGO_AMOUNT_MESSAGE,
  moscowDateKeyOf,
  normalizeTimeInput,
  parseVehicleClassificationKey,
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
  editTripBody,
  isBackdatedCreateAttempt,
  newTripBody,
  retypeErases,
  type FormValues,
} from '@features/vehicle-request-editor';
import { MOSCOW_TZ } from '@shared/config';
import { mayHaveCommittedWrite } from '@shared/api';
import { LocalCreateAttemptError } from '@shared/lib';
import { useEditorTermDoor, type TermStepResult } from './useEditorTermDoor';
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
    mutationFn: ({ values, period, termInBody }: TermStepResult) => {
      // One classifier position is chosen (ADR 0028); the API receives it as a "type + category"
      // pair, with an empty category for a type that has none.
      const picked = parseVehicleClassificationKey(values.classificationKey)!;
      /*
       * Backdating (ADR 0101): the reason and operation key are sent only when the operation really
       * goes into the past. Sending them always is wrong: the server would create a correction
       * record for ordinary daily work, and the form-correction journal would fill with requests
       * for tomorrow.
       *
       * Only a body that carries a calendar sends them: creation, conversion, a freight edit and
       * the wide edit that carries the term itself (`termInBody`). Otherwise the wide edit of an
       * on-site order has no term (K3a): its door has taken the reason already, and a second one
       * here would be a second journal entry for the same edit.
       */
      const backdate = state.backdated
        ? {
            backdateReason: values.backdateReason?.trim(),
            operationId: state.operationId,
          }
        : {};
      /*
       * The customer as a column pair from the selected option (R2, R2a): kind and id are stored in
       * it as data, and parsing the string on every save is pointless.
       *
       * A value the field does not offer is sent as an empty pair (K8) — protection, not loss: this
       * is how a department left in the form after conversion to on-site equipment stays out.
       */
      const pair = state.customer.customerPairOf(values.customerKey);
      const common = {
        vehicleTypeId: picked.vehicleTypeId,
        vehicleCategoryId: picked.vehicleCategoryId,
        comment: values.comment ?? '',
      };
      // A type change of an existing request is a conversion, not an edit (ADR 0091): it has its
      // own handler because the previous type's detail is dropped whole and the new one arrives in
      // full.
      const retyping = !!state.record && state.record.requestType !== values.requestType;
      const edit = state.record
        ? {
            // The version returned by the term door, if it ran first: it changed the request, and
            // the old version would answer 409 to an edit the person already started.
            version: period?.version ?? state.record.version,
            addFileIds: state.editor.newFileIds(),
            removeFileIds: state.editor.removedIds,
          }
        : null;

      if (values.requestType === 'special_equipment') {
        // Only an object orders on-site equipment: it goes to a site, and such a request has no
        // department (ADR 0040) — a department role never reaches this branch, the type is closed.
        const base = {
          requestType: 'special_equipment' as const,
          objectId: pair.objectId!,
          ...common,
          responsibleName: values.responsibleName!,
          responsiblePhone: values.responsiblePhone!,
        };
        const term = {
          dateFrom: values.dateFrom!.format('YYYY-MM-DD'),
          dateTo: values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null,
          ...backdate,
        };
        if (!state.record || !edit) {
          const body = {
            ...base,
            ...term,
            fileIds: state.editor.newFileIds(),
          };
          return sendCreate(body);
        }
        if (retyping) {
          return vehicleRequestsApi.changeRequestType(state.record.id, {
            ...base,
            ...term,
            ...edit,
          });
        }
        /*
         * K3a (S-21, S-22 of 12.10.2026): the wide PATCH carries the term only for a «Новая» order
         * of an account without the journal right (`termInBody`), the route the owner kept for it.
         * Otherwise the term moved through its own door before this call (`useEditorTermDoor`) or
         * did not change, and the server reads an absent `dateFrom`/`dateTo` as "untouched".
         * Release R2 removes the dates from the wide PATCH for orders in work under client floor 7,
         * so a contract-7 bundle must not send them there.
         */
        return vehicleRequestsApi.update(state.record.id, {
          ...base,
          ...(termInBody ? term : {}),
          ...edit,
        });
      }

      // A freight customer is an object or a department, exactly one (ADR 0040): the server rejects
      // both axes, and the half is chosen by the kind of the selected value, not the editor's axis.
      const customerBody = pair.departmentId
        ? { departmentId: pair.departmentId }
        : { objectId: pair.objectId! };
      // No time given -> Moscow midnight plus a flag: the request is "for the date", without an
      // hour.
      const time = normalizeTimeInput(values.scheduledTime ?? '');
      const scheduledAt = dayjs
        .tz(`${values.scheduledDate!.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
        .format('YYYY-MM-DDTHH:mm:ssZ');
      const base = {
        requestType: 'freight_transport' as const,
        ...customerBody,
        ...common,
        scheduledAt,
        scheduledTimeUnspecified: time === undefined,
        ...backdate,
      };
      /*
       * Trips from the form list (R1, R2): addresses, cargo and contacts moved from the request to
       * them, and the form sends them in full.
       *
       * The request day is passed to the assembly separately: the trip's own time (R3) is asked in
       * hours, and the moment is built from it and the delivery day — otherwise the first edit of
       * the delivery would leave trips in yesterday, and the server would answer 422 on a field
       * nobody touched (R18).
       */
      const requestDay = values.scheduledDate!.format('YYYY-MM-DD');
      const formTrips = values.trips ?? [];
      /*
       * Creation and conversion are fully strict (ADR 0006): every trip is new, its address comes
       * with its metadata and must be verified. On conversion the new type's detail is created from
       * scratch (ADR 0091), so there is no `id` by nature — an on-site order had no trips at all.
       */
      const created = formTrips.map((trip) => newTripBody(trip, requestDay));
      if (!state.record || !edit) {
        const body = {
          ...base,
          trips: created,
          fileIds: state.editor.newFileIds(),
        };
        return sendCreate(body);
      }
      if (retyping) {
        return vehicleRequestsApi.changeRequestType(state.record.id, {
          ...base,
          trips: created,
          ...edit,
        });
      }
      /*
       * An edit sends the full list (§7): a row with `id` overwrites an existing trip, a row
       * without one creates a new trip, and a trip missing from the list is soft-deleted (R13a).
       * Numbers are not reused: the next trip gets the next free number, and "ТС-40/2" from an
       * issued waybill stays forever the trip that was printed.
       *
       * The R2a exemptions are kept by the assembly itself (`editTripBody`): address metadata goes
       * as is, down to `null`, and the server demands verification only for the changed field.
       */
      return vehicleRequestsApi.update(state.record.id, {
        ...base,
        trips: formTrips.map((trip) => editTripBody(trip, requestDay)),
        ...edit,
      });
    },
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
      state.draft.clear();
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
  };
}
