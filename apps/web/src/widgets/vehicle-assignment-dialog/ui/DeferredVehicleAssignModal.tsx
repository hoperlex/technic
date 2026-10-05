import { lazy } from 'react';
import { Spin } from 'antd';
import { DeferredContent, FormModal } from '@shared/ui';
import type { VehicleAssignModalProps } from '../model/types';

const VehicleAssignModal = lazy(() =>
  import('./VehicleAssignModal').then((module) => ({ default: module.VehicleAssignModal })),
);

export function DeferredVehicleAssignModal(props: VehicleAssignModalProps) {
  const title = props.mode === 'reassign' ? 'Смена техники' : 'В работу';
  return (
    <DeferredContent
      active={!!props.request}
      // The real owner survives close: dayBatch.report appears after the assignment has closed.
      fallback={
        <FormModal
          title={props.request ? `${title}: заявка ${props.request.displayNumber}` : title}
          open={!!props.request}
          onCancel={props.onCancel}
          onSubmit={() => undefined}
          okText={props.mode === 'reassign' ? 'Сменить технику' : 'Взять в работу'}
          okDisabled
          width={880}
        >
          <Spin />
        </FormModal>
      }
    >
      <VehicleAssignModal {...props} />
    </DeferredContent>
  );
}
