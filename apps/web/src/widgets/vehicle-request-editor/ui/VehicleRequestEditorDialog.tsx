import { lazy } from 'react';
import { Alert, Button } from 'antd';
import {
  isBackdatedCreateAttempt,
  isLegacyOrdinaryCreateAttempt,
  type FormValues,
} from '@features/vehicle-request-editor';
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
  onReconcile: () => void;
  onResetBackdated: () => void;
  onResetLegacy: () => void;
  reconciling: boolean;
  state: VehicleRequestEditorState;
}

/** The controller freezes the copy calendar and operation key at open, before UI code arrives. */
export function VehicleRequestEditorDialog({
  confirmLoading,
  onFinish,
  onReconcile,
  onResetBackdated,
  onResetLegacy,
  reconciling,
  state,
}: Props) {
  const { draft } = state;
  const attempt = draft.active?.createAttempt;
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
        attemptKey={attempt?.key}
        attemptHelp={
          isLegacyOrdinaryCreateAttempt(attempt)
            ? `Попытка ${attempt.key} отправлена старой версией портала. Новая сверка для неё недоступна; сначала проверьте реестр, затем при необходимости начните новую попытку вручную.`
            : attempt?.protocol === 'receipt-v1'
              ? `Исходное тело и файлы сохранены с кодом ${attempt.key}. Сверка определит, создана ли заявка; отказ 400/422 сам по себе этого не доказывает.`
              : undefined
        }
        onReconcile={attempt?.protocol === 'receipt-v1' ? onReconcile : undefined}
        reconciling={reconciling}
        fileNotice
        createMayHaveSucceeded={draft.pending[0]?.target.kind !== 'edit'}
        restoring={state.restoring}
        restoreDisabled={state.typesLoading || state.customer.loading}
        onRestore={(candidate) => void state.restoreDraft(candidate)}
        onDiscard={() => draft.discardPending(state.operationId)}
      />
      {isBackdatedCreateAttempt(attempt) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Отправка задним числом требует ручной проверки"
          description={
            <Button size="small" onClick={onResetBackdated}>
              Проверил список — начать новую попытку
            </Button>
          }
        />
      )}
      {isLegacyOrdinaryCreateAttempt(attempt) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Старая отправка требует ручной проверки"
          description={
            <Button size="small" onClick={onResetLegacy}>
              Проверил список — начать новую попытку
            </Button>
          }
        />
      )}
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
