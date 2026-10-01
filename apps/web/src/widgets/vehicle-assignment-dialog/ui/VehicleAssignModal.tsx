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

/** Compose the assignment workflow while model hooks own each independent state machine. */
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
  const reassign = mode === 'reassign';
  const targetId = request?.id ?? null;
  const fleet = useAssignmentFleet(request, form);
  useAssignmentFormReset(request, form, fleet);
  const correction = useAssignmentCorrection(request, reassign, form);
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

  const rollbackToWork =
    !reassign && request?.requestType === 'special_equipment' && request.status === 'done';
  const [rollbackStep, setRollbackStep] = useState<{
    preview: VehicleRequestStatusPreviewDto;
    payload: AssignCommand;
  } | null>(null);
  useEffect(() => setRollbackStep(null), [targetId]);
  const preview = useMutation({
    // Preview and confirmation share the immutable command so the fingerprint protects what was shown.
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
  const previewsConsequences = reassign && request?.requestType === 'special_equipment';
  const consequences = useReassignConsequences({ request, onSubmit });
  const canBatchDays = canBatchAssignmentDays({
    request,
    reassign,
    rollbackToWork,
    ownership: fleet.ownership,
  });
  const dayBatchEnabled = (Form.useWatch('dayBatchEnabled', form) ?? false) && canBatchDays;
  const dayBatch = useDayBatch({
    failureHint: 'Заявка взята в работу, но 4-П на период не выписаны:',
  });

  const submit = (values: VehicleAssignmentFormValues) => {
    const schedule = reassign ? null : assignScheduleOf(request, values);
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
      correctionId: correction.correctionEnabled ? correction.operationId : null,
    });
    if (rollbackToWork) {
      preview.mutate(payload);
      return;
    }
    if (previewsConsequences) {
      consequences.start(payload);
      return;
    }
    // Day planning is intentionally a second command: a failed batch must not undo assignment.
    if (dayBatchEnabled && request) {
      const requestId = request.id;
      void Promise.resolve(onSubmit(payload)).then(
        () => dayBatch.apply({ requestId, values }),
        () => {},
      );
      return;
    }
    void Promise.resolve(onSubmit(payload)).catch(() => {});
  };

  const secondStep = !!rollbackStep || consequences.shown;
  const title = rollbackStep
    ? 'Последствия возврата'
    : consequences.shown
      ? 'Последствия смены техники'
      : reassign
        ? 'Смена техники'
        : 'В работу';
  const okText = rollbackStep
    ? 'Вернуть в работу'
    : consequences.shown
      ? 'Подтвердить смену'
      : reassign
        ? 'Сменить технику'
        : 'Взять в работу';
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
            ? void onSubmit({
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
        footerExtra={secondStep ? <Button onClick={backToForm}>Назад</Button> : undefined}
        width={880}
      >
        {request && rollbackStep && (
          <RollbackPreview preview={rollbackStep.preview} fact={request.completion} />
        )}
        {request && consequences.node}
        {request && (
          // Keeping the form mounted makes Back restore server-backed choices without a second fetch.
          <div style={{ display: secondStep ? 'none' : undefined }}>
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
      {dayBatch.report}
    </>
  );
}
