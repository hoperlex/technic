import dayjs from 'dayjs';
import {
  normalizeTimeInput,
  parseVehicleClassificationKey,
  type CreateVehicleRequestInput,
  type VehicleRequestDto,
} from '@technic/contracts';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import { editTripBody, newTripBody } from '@features/vehicle-request-editor';
import { MOSCOW_TZ } from '@shared/config';
import type { TermStepResult } from './useEditorTermDoor';
import type { VehicleRequestEditorState } from './useVehicleRequestEditorState';

export function saveVehicleRequest(
  { values, period, termInBody }: TermStepResult,
  state: VehicleRequestEditorState,
  sendCreate: (body: CreateVehicleRequestInput) => Promise<VehicleRequestDto>,
) {
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
}
