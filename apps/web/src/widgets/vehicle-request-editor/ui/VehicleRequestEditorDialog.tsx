import { lazy } from 'react';
import type { FormValues } from '@features/vehicle-request-editor';
import { AsyncContent, FormModal } from '@shared/ui';
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
      onCancel={() => state.setOpen(false)}
      onSubmit={() => state.form.submit()}
      confirmLoading={confirmLoading}
      width={880}
    >
      <AsyncContent>
        <VehicleRequestEditorBody state={state} onFinish={onFinish} />
      </AsyncContent>
    </FormModal>
  );
}
