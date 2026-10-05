import { lazy } from 'react';
import { Spin } from 'antd';
import { DeferredContent, ViewModal } from '@shared/ui';
import type { WasteRequestViewProps } from './WasteRequestView';

const WasteRequestView = lazy(() =>
  import('./WasteRequestView').then((module) => ({ default: module.WasteRequestView })),
);

export function DeferredWasteRequestView(props: WasteRequestViewProps) {
  return (
    <DeferredContent
      active={!!props.request}
      fallback={
        <ViewModal
          title={props.request ? `Заявка № ${props.request.displayNumber}` : 'Заявка'}
          open={!!props.request}
          onClose={props.onClose}
          width={1000}
          footer={null}
        >
          <Spin />
        </ViewModal>
      }
    >
      <WasteRequestView {...props} />
    </DeferredContent>
  );
}
