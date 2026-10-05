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
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
  type VehicleRequestPeriodResultDto,
} from '@entities/vehicle-request';
import { vehicleRouteKeys, vehicleRouteLink } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import {
  editTripBody,
  newTripBody,
  retypeErases,
  type FormValues,
  type VehiclePeriodCommand,
} from '@features/vehicle-request-editor';
import { MOSCOW_TZ } from '@shared/config';
import type { PendingPeriodSave, VehicleRequestEditorPeriodModalProps } from './types';
import type { VehicleRequestEditorState } from './useVehicleRequestEditorState';

/**
 * Save input: form values plus an already applied term change (wave 4a of
 * `docs/assignment-periods-plan.md`).
 *
 * `period` arrives when the term went through its own door and carries two things the form no
 * longer has: the **fresh version** of the request (the door bumped it — the old one would answer
 * 409) and the fact that the calendar has already been moved by this edit, so no second entry in
 * the correction journal is due.
 */
interface SaveInput {
  period?: VehicleRequestPeriodResultDto;
  values: FormValues;
}

interface Input {
  openRoute: (routeId: string) => void;
  state: VehicleRequestEditorState;
}

export function useVehicleRequestEditorSave({ openRoute, state }: Input) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const canApprove = can('vehicleRequests.approve');
  /**
   * A term change waiting for its door: the request, the new term and the form values to be saved
   * right after (wave 4a of `docs/assignment-periods-plan.md`).
   *
   * State, not a flag inside the mutation: a dialog stands between "pressed Save" and "confirmed the
   * consequences", and the form values must survive it — the form has already run its rules, and
   * asking them again would be a second pass over the same fields.
   */
  const [periodSave, setPeriodSave] = useState<PendingPeriodSave | null>(null);

  /**
   * The request was moved to another date while it sits in the previous day's route.
   *
   * The portal does not forbid such an edit: request and route are edited by different people at
   * different times, and forbidding it would demand fixing the route before learning of the
   * mismatch. Staying silent is wrong too — the route stays on the old day and the waybill would
   * print a task that no longer exists that day. So the dialog names the mismatch and leads to where
   * it is fixed: the route card, where the route day moves together with its requests.
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
      // as a window over the list (ADR 0120): leaving the list would take away the very request just
      // edited, together with its filters and page.
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
    mutationFn: ({ values, period }: SaveInput) => {
      // One classifier position is chosen (ADR 0028); the API receives it as a "type + category"
      // pair, with an empty category for a type that has none.
      const picked = parseVehicleClassificationKey(values.classificationKey)!;
      /*
       * Backdating (ADR 0101): the reason and operation key are sent only when the operation really
       * goes into the past. Sending them always is wrong: the server would create a correction
       * record for ordinary daily work, and the form-correction journal would fill with requests
       * for tomorrow.
       *
       * A term already applied through its own door no longer moves the calendar of this edit: the
       * body's dates equal those stored on the request, and a reason here would mean a second
       * journal entry for the same edit — the person explained it to the term door already.
       */
      const backdate =
        state.backdated && !period
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
        ...backdate,
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
          dateFrom: values.dateFrom!.format('YYYY-MM-DD'),
          dateTo: values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null,
          responsibleName: values.responsibleName!,
          responsiblePhone: values.responsiblePhone!,
        };
        if (!state.record || !edit) {
          return vehicleRequestsApi.create({ ...base, fileIds: state.editor.newFileIds() });
        }
        return retyping
          ? vehicleRequestsApi.changeRequestType(state.record.id, { ...base, ...edit })
          : vehicleRequestsApi.update(state.record.id, { ...base, ...edit });
      }

      // A freight customer is an object or a department, exactly one (ADR 0040): the server rejects
      // both axes, and the half is chosen by the kind of the selected value, not the editor's axis.
      const customerBody = pair.departmentId
        ? { departmentId: pair.departmentId }
        : { objectId: pair.objectId! };
      // No time given -> Moscow midnight plus a flag: the request is "for the date", without an hour.
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
        return vehicleRequestsApi.create({
          ...base,
          trips: created,
          fileIds: state.editor.newFileIds(),
        });
      }
      if (retyping) {
        return vehicleRequestsApi.changeRequestType(state.record.id, {
          ...base,
          trips: created,
          ...edit,
        });
      }
      /*
       * An edit sends the full list (§7): a row with `id` overwrites an existing trip, a row without
       * one creates a new trip, and a trip missing from the list is soft-deleted (R13a). Numbers are
       * not reused: the next trip gets the next free number, and "ТС-40/2" from an issued waybill
       * stays forever the trip that was printed.
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
      state.setOpen(false);
      warnRouteDateMismatch(saved);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  /**
   * Whether this term edit goes through its own door, and what the term becomes (Ж4, З5, И5 of
   * `docs/assignment-periods-plan.md`).
   *
   * `null` means no door here, and the term goes the old broad way. That happens in four cases,
   * each a property of the edit itself, not "not done yet":
   *
   * - **the term did not change**: the door would not accept an empty command — it would bump the
   *   request version and leave a journal row with no subject;
   * - **not an on-site order**: freight has no work term at all;
   * - **the request is "new"**: no vehicle, no paper, no history — the preview has nothing to show
   *   and nothing to cancel. Until cutover its term follows the broad route, legitimately (И5);
   * - **no permission to read paperwork**: consequences are shown by the preview, which lives on
   *   `waybills.read`; a role without it would hit 403 in the middle of saving.
   */
  const periodDoorCommand = (values: FormValues): VehiclePeriodCommand | null => {
    const { record } = state;
    if (!record || record.requestType !== 'special_equipment') return null;
    if (values.requestType !== 'special_equipment') return null;
    if (record.status === 'new' || !can('waybills.read')) return null;
    const dateFrom = values.dateFrom!.format('YYYY-MM-DD');
    const dateTo = values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null;
    if (dateFrom === record.dateFrom && dateTo === record.dateTo) return null;
    return { dateFrom, dateTo };
  };

  /**
   * Conversion is confirmed, an ordinary save is not. Changing the type does not just change values:
   * the previous type's fields disappear with its detail, and an approval set by someone other than
   * the editor goes too. The list comes from the request itself (`retypeErases`), not general words:
   * the person must see what will cease to exist before the click, not in the history afterwards.
   */
  const submit = (values: FormValues) => {
    const { record } = state;
    if (!record || record.requestType === values.requestType) {
      /*
       * A term change has its own door (`docs/assignment-periods-plan.md`, wave 4a; Ж4, З5, Д2).
       * Saving then splits into two commands: the term has its own consequences and handshakes,
       * and "extend and also fix the comment" is never one body. The term goes first — it shows the
       * cost and takes confirmations — then the rest with the version it returned.
       */
      const command = periodDoorCommand(values);
      if (command && record?.requestType === 'special_equipment') {
        setPeriodSave({ request: record, command, values });
        return;
      }
      save.mutate({ values });
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

  /*
   * The term door's dialog (wave 4a of `docs/assignment-periods-plan.md`) shows what burns and what
   * gets issued, which vehicle decisions a shortening cancels, and takes confirmations the broad
   * route lacks. The backdate reason typed in the form moves there, together with the same
   * operation key: the person explains one edit, not every handler it passes through.
   */
  const periodModalProps: VehicleRequestEditorPeriodModalProps = {
    request: periodSave?.request ?? null,
    command: periodSave?.command ?? null,
    reason: periodSave?.values.backdateReason,
    operationId: state.operationId,
    onCancel: () => setPeriodSave(null),
    onApplied: (result) => {
      const pending = periodSave;
      setPeriodSave(null);
      // The rest of the body goes as a second command with its own door and version. Its dates
      // equal what the door already wrote, so the broad route will not touch them.
      if (pending) save.mutate({ values: pending.values, period: result });
    },
  };

  return { confirmLoading: save.isPending, onFinish, periodModalProps };
}
