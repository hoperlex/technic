import { lazy, type ComponentProps } from 'react';
import { Spin } from 'antd';
import { DeferredContent, FormModal } from '@shared/ui';
import type { WasteRequestEditorModal as Editor } from './WasteRequestEditorModal';

const WasteRequestEditorModal = lazy(() =>
  import('./WasteRequestEditorModal').then((module) => ({
    default: module.WasteRequestEditorModal,
  })),
);

/** Keep the mounted presence query and form watches alive after the first open, as before. */
export function DeferredWasteRequestEditor(props: ComponentProps<typeof Editor>) {
  return (
    <DeferredContent
      active={props.open}
      fallback={
        <FormModal
          title={props.record ? 'Редактирование заявки' : 'Новая заявка'}
          open={props.open}
          onCancel={props.onCancel}
          onSubmit={() => undefined}
          okDisabled
          width={880}
        >
          <Spin />
        </FormModal>
      }
    >
      <WasteRequestEditorModal {...props} />
    </DeferredContent>
  );
}
