import type { ReactNode } from 'react';
import { useAuth } from '@entities/session';
import { VehicleRequestEditorDialog } from '../ui/VehicleRequestEditorDialog';
import type { VehicleRequestEditorController, VehicleRequestEditorPeriodModalProps } from './types';
import { useVehicleRequestEditorSave } from './useVehicleRequestEditorSave';
import { useVehicleRequestEditorState } from './useVehicleRequestEditorState';

interface Input {
  openRoute: (routeId: string) => void;
  renderPeriodModal: (props: VehicleRequestEditorPeriodModalProps) => ReactNode;
}

/**
 * Public controller of the editor. Pages receive commands plus one node and never observe form,
 * copy, file or period-correction state.
 */
export function useVehicleRequestEditor({
  openRoute,
  renderPeriodModal,
}: Input): VehicleRequestEditorController {
  const { can } = useAuth();
  const state = useVehicleRequestEditorState({
    canChangeStatus: can('vehicleRequests.status'),
  });
  const save = useVehicleRequestEditorSave({ openRoute, state });

  return {
    canCopy: state.canCopy,
    openCopy: state.openCopy,
    openCreate: state.openCreate,
    openEdit: state.openEdit,
    node: (
      <>
        <VehicleRequestEditorDialog
          state={state}
          onFinish={save.onFinish}
          confirmLoading={save.confirmLoading}
        />
        {renderPeriodModal(save.periodModalProps)}
      </>
    ),
  };
}
