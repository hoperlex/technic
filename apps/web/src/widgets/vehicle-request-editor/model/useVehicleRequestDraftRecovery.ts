import { useState } from 'react';
import { App, type FormInstance } from 'antd';
import { costTargetKeyOf, type VehicleRequestDto } from '@technic/contracts';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import { classificationKeyOf } from '@entities/vehicle-type';
import type { RequestCustomerOptions } from '@features/request-customer';
import type { FormValues, VehicleRequestLocalDraft } from '@features/vehicle-request-editor';
import type { EditorFile, FileEditorController } from './useFileEditor';
import type { useVehicleRequestLocalDraft } from './useVehicleRequestLocalDraft';

interface Input {
  draft: ReturnType<typeof useVehicleRequestLocalDraft>;
  form: FormInstance<FormValues>;
  files: FileEditorController;
  classifications: ReadonlyMap<string, unknown>;
  typesLoading: boolean;
  customer: RequestCustomerOptions;
  setRecord: (record: VehicleRequestDto | null) => void;
  setOperationId: (id: string) => void;
  setTripsExpanded: (expanded: boolean) => void;
}

/** An edit draft is a full replacement, so a changed server version needs a visible review gate. */
export function useVehicleRequestDraftRecovery({
  draft,
  form,
  files,
  classifications,
  typesLoading,
  customer,
  setRecord,
  setOperationId,
  setTripsExpanded,
}: Input) {
  const { message, modal } = App.useApp();
  const [reviewRequired, setReviewRequired] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const restoreDraft = async (candidate: VehicleRequestLocalDraft) => {
    if (restoring || typesLoading || customer.loading) return;
    setRestoring(true);
    try {
      const latest =
        candidate.target.kind === 'edit'
          ? await vehicleRequestsApi.get(candidate.target.sourceId)
          : null;
      const changed = !!latest && latest.version !== candidate.baseVersion;
      const apply = () => {
        const values = draft.restore(candidate, latest?.version ?? null);
        const savedClassification = latest ? classificationKeyOf(latest) : null;
        if (
          values.classificationKey &&
          !classifications.has(values.classificationKey) &&
          values.classificationKey !== savedClassification
        )
          values.classificationKey = '';
        const pair = customer.customerPairOf(values.customerKey);
        if (
          values.customerKey &&
          !pair.objectId &&
          !pair.departmentId &&
          values.customerKey !== (latest ? costTargetKeyOf(latest) : null)
        )
          values.customerKey = undefined;
        if (latest) {
          setRecord(latest);
          files.reset(latest.files.map((file): EditorFile => ({ ...file, isNew: false })));
        } else files.reset([]);
        form.resetFields();
        form.setFieldsValue(values);
        setOperationId(candidate.operationId);
        setTripsExpanded(
          (values.trips?.length ?? 0) > 1 ||
            !!values.trips?.some((trip) => trip.scheduledTime || trip.comment),
        );
        setReviewRequired(changed);
      };
      if (changed) {
        const accepted = await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: 'Заявка изменилась после сохранения черновика',
            content:
              'Восстановите черновик, сверьте все ездки и поля с текущей заявкой, затем подтвердите проверку перед отправкой.',
            okText: 'Восстановить для проверки',
            cancelText: 'Пока не восстанавливать',
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (accepted) apply();
      } else apply();
    } catch {
      message.error(
        'Не удалось загрузить актуальную заявку. Черновик сохранён на этом устройстве.',
      );
    } finally {
      setRestoring(false);
    }
  };

  return {
    confirmReview: () => setReviewRequired(false),
    resetReview: () => setReviewRequired(false),
    restoreDraft,
    restoring,
    reviewRequired,
  };
}
