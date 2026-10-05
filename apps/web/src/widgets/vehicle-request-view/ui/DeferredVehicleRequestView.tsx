import { lazy } from 'react';
import { Spin } from 'antd';
import { DeferredContent, ViewModal } from '@shared/ui';
import type { VehicleRequestViewModalProps } from '../model/types';

const VehicleRequestViewModal = lazy(() =>
  import('./VehicleRequestViewModal').then((module) => ({
    default: module.VehicleRequestViewModal,
  })),
);

export function DeferredVehicleRequestView(props: VehicleRequestViewModalProps) {
  return (
    <DeferredContent
      active={!!props.request}
      fallback={
        <ViewModal
          title={props.request ? `Заявка ${props.request.displayNumber}` : 'Заявка'}
          open={!!props.request}
          onClose={props.onClose}
          width={1000}
          footer={null}
        >
          <Spin />
        </ViewModal>
      }
    >
      <VehicleRequestViewModal {...props} />
    </DeferredContent>
  );
}
