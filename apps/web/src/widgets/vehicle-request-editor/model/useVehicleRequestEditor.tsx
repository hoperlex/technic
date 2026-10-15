import type { ReactNode } from 'react';
import type { VehicleRequestDto } from '@technic/contracts';
import { useAuth } from '@entities/session';
import { VehicleRequestEditorDialog } from '../ui/VehicleRequestEditorDialog';
import type { VehicleRequestEditorController, VehicleRequestEditorPeriodModalProps } from './types';
import { useVehicleRequestEditorSave } from './useVehicleRequestEditorSave';
import { useVehicleRequestEditorState } from './useVehicleRequestEditorState';

interface Input {
  openCreated: (request: VehicleRequestDto) => void;
  openRoute: (routeId: string) => void;
  renderPeriodModal: (props: VehicleRequestEditorPeriodModalProps) => ReactNode;
}

/**
 * Public controller of the editor. Pages receive commands plus one node and never observe form,
 * copy, file or period-correction state.
 */
export function useVehicleRequestEditor({
  openCreated,
  openRoute,
  renderPeriodModal,
}: Input): VehicleRequestEditorController {
  const { can } = useAuth();
  const state = useVehicleRequestEditorState({
    canChangeStatus: can('vehicleRequests.status'),
  });
  const save = useVehicleRequestEditorSave({ openCreated, openRoute, state });

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
          onReconcile={() => void save.reconcileAttempt()}
          onResetBackdated={save.confirmBackdatedReset}
          onResetLegacy={save.confirmLegacyOrdinaryReset}
          reconciling={save.reconcilePending}
          confirmLoading={save.confirmLoading}
        />
        {renderPeriodModal(save.periodModalProps)}
      </>
    ),
  };
}
