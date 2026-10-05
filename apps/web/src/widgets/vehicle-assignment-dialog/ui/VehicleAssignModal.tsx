import { useEffect, useState } from 'react';
import { App, Button, Form } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { moscowDateKeyOf, type VehicleRequestStatusPreviewDto } from '@technic/contracts';
import { vehicleRequestErrorMessage, vehicleRequestsApi } from '@entities/vehicle-request';
import {
  type AssignCommand,
  assignCommandBody,
  assignScheduleOf,
  assignmentBlockers,
  canBatchAssignmentDays,
  RollbackPreview,
} from '@features/vehicle-assignment';
import { FormGrid, FormModal, useFormBlockers } from '@shared/ui';
import { useAssignmentCorrection } from '../model/useAssignmentCorrection';
import { useAssignmentDelivery } from '../model/useAssignmentDelivery';
import { useAssignmentFleet } from '../model/useAssignmentFleet';
import { useAssignmentFormReset } from '../model/useAssignmentFormReset';
import { useAssignmentRouteCrew } from '../model/useAssignmentRouteCrew';
import { useDayBatch } from '../model/useDayBatch';
import { useReassignConsequences } from '../model/useReassignConsequences';
import type { VehicleAssignModalProps, VehicleAssignmentFormValues } from '../model/types';
import { AssignmentDeliveryFields } from './AssignmentDeliveryFields';
import { AssignmentFleetFields } from './AssignmentFleetFields';
import { AssignmentRouteFields } from './AssignmentRouteFields';
import { AssignmentScheduleFields } from './AssignmentScheduleFields';

/**
 * Choosing the vehicle, term and rates when taking a request into work (ADR 0027). The model hooks
 * each own one independent part (fleet, correction, delivery, route and crew, day batch, vehicle
 * change preview); this component composes them and owns the two second steps.
 *
 * The actual term is asked first: the ordered time is a plan — the request is created in advance,
 * and when the vehicle really goes out is agreed with the contractor exactly here. Fields are
 * filled with the ordered values and the original order is shown under them: an edit must be
 * visible, not a silent substitution. The block precedes the vehicle choice because the route date
 * decides which drivers are fit, and the list below is rebuilt by it.
 *
 * Rates are filled from the rental offer and edited freely: they are agreed per request, and the
 * directory price list does not overrule that. The difference with the price list is shown as a
 * hint — to keep the edit visible, not silent.
 *
 * The same dialog changes the vehicle of a running request (ADR 0048): the selection works the same
 * in both cases, and a second dialog with the same content would drift on the first edit. Only the
 * actual-term block differs — not asked on a change: the term is agreed, only what runs the request
 * changes. The ESM-2 machinist is asked with the same field on a change: another unit brings
 * another person, and reissuing forms by hand is work that reconciliation does itself (migration
 * 0087). The previous name is not filled in (ADR 0083): it stands as text under the field, and an
 * empty value means "keep the previous one" — the portal hints, it does not decide.
 *
 * The existing route's driver follows the same rule (ADR 0048). The dialog used to ask only for a
 * new route, and there was no way to change the person on an assembled route: only the route edit
 * dialog (ADR 0082) or an extra route "with the right driver" — created not for the route, leaving
 * an empty entry in the day plan that was removed by hand later. The field is optional for an
 * existing route and opens empty, with the current driver named under it. Removing the driver is
 * not offered: the route is shared, and leaving it driverless together with other requests is a
 * separate decision made by editing the route, where its whole composition is visible.
 */
export function VehicleAssignModal({
  request,
  mode = 'confirm',
  confirmLoading,
  onCancel,
  onSubmit,
}: VehicleAssignModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<VehicleAssignmentFormValues>();
  const blockers = useFormBlockers(form);
  // Changing the vehicle of a running request (ADR 0048): the term is not asked — it is agreed.
  const reassign = mode === 'reassign';
  const targetId = request?.id ?? null;
  const fleet = useAssignmentFleet(request, form);
  useAssignmentFormReset(request, form, fleet);
  const correction = useAssignmentCorrection(request, reassign, form);
  /*
   * Linear equipment (ADR 0100): a machine that returns to the base in the evening and works two or
   * three sites a day. The portal runs such an order by days, not by a week standing on a site, and
   * in this dialog that means exactly two things: no weekly ESM-2 forms are issued when taking into
   * work (decision 5), and such a machine has no relocation (decision 9).
   *
   * The flag is asked of the **ordered** type and comes with the request: how a request is run is
   * decided by the order — before a unit is found for it — so the selected vehicle's type does not
   * matter. Freight has no flag: it has a delivery moment, not a work term.
   */
  const isLinear = request?.requestType === 'special_equipment' && request.isLinear;
  const delivery = useAssignmentDelivery({
    request,
    reassign,
    isLinear,
    ownership: fleet.ownership,
    form,
  });
  const crew = useAssignmentRouteCrew({
    request,
    reassign,
    form,
    fleet,
    delivery,
    currentMachinist: correction.currentMachinist,
  });

  // ── "Done" -> "In work" rollback: a second step with consequences (§5.4 of the plan) ──
  /*
   * The only transition on which the dialog asks the server before sending the status. Closing
   * releases the mode freeze, and the request returning to work follows the directory's current
   * mode, whatever it has become: what happens to paper and occupancy only the server knows — and
   * computes it with the same reconciliation that will then run.
   *
   * The portal learns the vehicle and machinist no earlier than in this dialog, and the dialog used
   * to fire the status mutation at once: there was no moment at which the server could advise
   * anything. Other transitions go as before.
   */
  const rollbackToWork =
    !reassign && request?.requestType === 'special_equipment' && request.status === 'done';
  // The shown consequences and the body that received them: the confirmation sends exactly that
  // body.
  const [rollbackStep, setRollbackStep] = useState<{
    preview: VehicleRequestStatusPreviewDto;
    payload: AssignCommand;
  } | null>(null);
  useEffect(() => setRollbackStep(null), [targetId]);
  const preview = useMutation({
    // The preview is called with the same body the status will be sent with: the plan is computed
    // by the vehicle, machinist and term of this form, and a second assembly would drift from the
    // first — and with it the fingerprint the server uses to check what was promised.
    mutationFn: async (payload: AssignCommand) => ({
      payload,
      preview: await vehicleRequestsApi.statusPreview(request!.id, {
        status: 'confirmed',
        version: request!.version,
        assignment: payload.assignment,
        schedule: payload.schedule ?? undefined,
      }),
    }),
    onSuccess: setRollbackStep,
    onError: (error) => message.error(vehicleRequestErrorMessage(error)),
  });
  // ── Vehicle change: a second step with consequences (wave 4a of assignment-periods) ──
  /*
   * A preview exists for a vehicle change of an on-site order — and only for it. Freight has
   * neither a work term nor weekly paper, so there are no consequences worth asking about: the
   * server does not demand a fingerprint for it even after the read switch. Taking into work never
   * comes here — nothing can burn yet.
   */
  const previewsConsequences = reassign && request?.requestType === 'special_equipment';
  // The consequences step itself — preview, confirmations, command, recount — is its own hook.
  const consequences = useReassignConsequences({ request, onSubmit });
  const canBatchDays = canBatchAssignmentDays({
    request,
    reassign,
    rollbackToWork,
    ownership: fleet.ownership,
  });
  const dayBatchEnabled = (Form.useWatch('dayBatchEnabled', form) ?? false) && canBatchDays;
  // The batch is called by a second request after taking into work, and its refusal does not undo
  // the first: the request is in work by then and must not be rolled back. Hence its own failure
  // caption — the person must read that the request is taken but the paper is not issued.
  const dayBatch = useDayBatch({
    failureHint: 'Заявка взята в работу, но 4-П на период не выписаны:',
  });

  const submit = (values: VehicleAssignmentFormValues) => {
    // The term is refined only when taking into work: a running request's term is agreed, and a
    // vehicle change does not touch it (ADR 0048) — the server does not accept `schedule`
    // otherwise.
    const schedule = reassign ? null : assignScheduleOf(request, values);
    // Rules the server checks too. Each is named at its own field, not by a toast over the form:
    // the order of reasons is the order of fields, and the screen scrolls to the first one (ADR
    // 0094).
    const blocked = blockers.raise(
      assignmentBlockers(values, {
        requestType: request?.requestType,
        reassign,
        schedule,
        machinistRequired: crew.machinistRequired,
        isRental: fleet.isRental,
        wantsDelivery: delivery.wants,
        correctionEnabled: correction.correctionEnabled,
        needsRoute: crew.routeModel.needsRoute,
      }),
    );
    if (blocked || !values.vehicleId) return;
    const payload = assignCommandBody(values, {
      schedule,
      needsMachinist: crew.needsMachinist,
      needsRoute: crew.routeModel.needsRoute,
      wantsDelivery: delivery.wants,
      // The idempotency key goes only with the correction enabled: without it no journal operation
      // is created, and the key has nothing to identify.
      correctionId: correction.correctionEnabled ? correction.operationId : null,
    });
    // On the "done" -> "in work" rollback a server question stands between "pressed" and "sent":
    // what exactly happens to paper and occupancy. Other transitions go at once, as they did.
    if (rollbackToWork) {
      preview.mutate(payload);
      return;
    }
    // A vehicle change asks the same, for the same reason: the person must learn the cost before
    // the click, not from burnt numbers afterwards (wave 4a).
    if (previewsConsequences) {
      consequences.start(payload);
      return;
    }
    /*
     * The 4-P batch goes as a **second** request and only after a successful transition (ADR 0207).
     *
     * One body cannot do it, and not by oversight: days are placed by the days door, whose rule
     * (`linearDaysBlocker`) requires the request already in work and with an assigned vehicle —
     * before that there is nothing to plan and nothing to plan on. Hence the order: status first,
     * paper second.
     *
     * A refused transition cancels the batch silently: the request is not in work, and the sender
     * already reported the refusal. A refused batch, on the contrary, is loud (`failureHint`): the
     * request stays in work, and must not be rolled back for unissued paper.
     */
    if (dayBatchEnabled && request) {
      const requestId = request.id;
      void Promise.resolve(onSubmit(payload)).then(
        () => dayBatch.apply({ requestId, values }),
        () => {},
      );
      return;
    }
    // The status handler answers with a promise (`mutateAsync`), and an unhandled refusal would be
    // noise in the console: the sender already reported it.
    void Promise.resolve(onSubmit(payload)).catch(() => {});
  };

  // Either second step: from here on the dialog speaks not about selection but about the cost.
  const secondStep = !!rollbackStep || consequences.shown;
  const title = rollbackStep
    ? 'Последствия возврата'
    : consequences.shown
      ? 'Последствия смены техники'
      : reassign
        ? 'Смена техники'
        : 'В работу';
  // On the second step the button must answer what was read: the person confirms not "change the
  // vehicle" in general but these consequences.
  const okText = rollbackStep
    ? 'Вернуть в работу'
    : consequences.shown
      ? 'Подтвердить смену'
      : reassign
        ? 'Сменить технику'
        : 'Взять в работу';
  // Back from the second step to the form — both ways at once: only one is ever open.
  const backToForm = () => {
    setRollbackStep(null);
    consequences.back();
  };

  return (
    <>
      <FormModal
        title={request ? `${title}: заявка ${request.displayNumber}` : title}
        open={!!request}
        onCancel={onCancel}
        onSubmit={() =>
          rollbackStep
            ? // The confirmation sends the very body the server computed the consequences for,
              // with the fingerprint by which it checks that the promise still holds.
              void onSubmit({
                ...rollbackStep.payload,
                previewFingerprint: rollbackStep.preview.fingerprint,
              })
            : consequences.shown
              ? consequences.confirm()
              : form.submit()
        }
        confirmLoading={confirmLoading || preview.isPending || consequences.pending}
        okText={okText}
        okDisabled={consequences.okDisabled}
        // "Back" leads away from sending — hence it stands apart from the primary action.
        footerExtra={secondStep ? <Button onClick={backToForm}>Назад</Button> : undefined}
        width={880}
      >
        {request && rollbackStep && (
          <RollbackPreview preview={rollbackStep.preview} fact={request.completion} />
        )}
        {request && consequences.node}
        {request && (
          // On the second step the form is hidden, not unmounted: "Back" must return the dialog
          // filled, and half its fields are assembled from server answers — collecting them again
          // would cost the person choices already made.
          <div style={{ display: secondStep ? 'none' : undefined }}>
            {/* Fields in pairs (FormGrid): the dialog asks for term, vehicle, rates and waybill
                boxes — in one column half of them went below the scroll. One column on a phone. */}
            <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
              <FormGrid>
                <AssignmentScheduleFields
                  request={request}
                  reassign={reassign}
                  form={form}
                  fleet={fleet}
                  correction={correction}
                  crew={crew}
                  canBatchDays={canBatchDays}
                  dayBatchEnabled={dayBatchEnabled}
                  today={moscowDateKeyOf(new Date())}
                />
                <AssignmentFleetFields form={form} fleet={fleet} crew={crew} />
                <AssignmentDeliveryFields delivery={delivery} fleet={fleet} crew={crew} />
                <AssignmentRouteFields targetId={request.id} fleet={fleet} crew={crew} />
              </FormGrid>
            </Form>
          </div>
        )}
      </FormModal>
      {/* The batch report is the dialog's sibling, not its content: by the time it shows, the
          transition has happened, the caller closed the dialog, and there is no form to return to.
          The hook that holds it survives the close. */}
      {dayBatch.report}
    </>
  );
}
