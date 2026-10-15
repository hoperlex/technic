import { lazy } from 'react';
import { Alert, Button } from 'antd';
import type { FormValues } from '@features/vehicle-request-editor';
import { FormDraftAutosave } from '@shared/lib';
import { AsyncContent, FormModal, LocalFormDraftNotice } from '@shared/ui';
import type { VehicleRequestEditorState } from '../model/useVehicleRequestEditorState';

const VehicleRequestEditorBody = lazy(() =>
  import('./VehicleRequestEditorBody').then((module) => ({
    default: module.VehicleRequestEditorBody,
  })),
);

interface Props {
  confirmLoading: boolean;
  onFinish: (values: FormValues) => void;
  state: VehicleRequestEditorState;
}

/** The controller freezes the copy calendar and operation key at open, before UI code arrives. */
export function VehicleRequestEditorDialog({ confirmLoading, onFinish, state }: Props) {
  const { draft } = state;
  return (
    <FormModal
      title={
        state.record
          ? `Заявка ${state.record.displayNumber}`
          : state.copy
            ? `Новая заявка на автотехнику — по образцу ${state.copy.source.displayNumber}`
            : 'Новая заявка на автотехнику'
      }
      open={state.open}
      onCancel={state.close}
      onSubmit={() => state.form.submit()}
      confirmLoading={confirmLoading}
      okDisabled={draft.pending.length > 0 || state.reviewRequired || state.restoring}
      width={880}
    >
      <FormDraftAutosave
        active={state.open && !!draft.active}
        form={state.form}
        onSave={draft.persist}
      />
      <LocalFormDraftNotice
        active={!!draft.active}
        pending={draft.pending}
        status={draft.status}
        fileNotice
        createMayHaveSucceeded={draft.pending[0]?.target.kind !== 'edit'}
        restoring={state.restoring}
        restoreDisabled={state.typesLoading || state.customer.loading}
        onRestore={(candidate) => void state.restoreDraft(candidate)}
        onDiscard={() => draft.discardPending(state.operationId)}
      />
      {state.reviewRequired && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Проверьте восстановленные поля и ездки"
          description={
            <Button size="small" onClick={state.confirmReview}>
              Я сверил заявку с текущей версией
            </Button>
          }
        />
      )}
      {draft.pending.length === 0 && (
        <AsyncContent>
          <VehicleRequestEditorBody state={state} onFinish={onFinish} />
        </AsyncContent>
      )}
    </FormModal>
  );
}
