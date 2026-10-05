import { useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  canCorrectAssignment,
  canReassignVehicle,
  esm2Mode,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { vehicleRouteKeys, vehicleRouteLink } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import * as assignmentModel from '@features/vehicle-assignment';
import { useRouteModal } from '@features/route-modal';
import { useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '@shared/ui';
import { VehicleAssignModal } from '@widgets/vehicle-assignment-dialog';
import { useVehicleRequestEditor, VehicleRelocationModal } from '@widgets/vehicle-request-editor';
import type { VehicleRequestFeedActions } from '@widgets/vehicle-request-feed';
import { useVehicleRequestLifecycle } from '@widgets/vehicle-request-lifecycle';
import { VehicleCompleteModal } from './VehicleCompleteModal';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';
import { VehicleEarlyEndModal } from './VehicleEarlyEndModal';
import { VehicleEsm2Modal } from './VehicleEsm2Modal';
import { VehicleMachinistModal } from './VehicleMachinistModal';
import { VehiclePeriodModal } from './VehiclePeriodModal';
import { VehicleRepairModal } from './VehicleRepairModal';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { VehicleRouteTransferModal } from './VehicleRouteTransferModal';

type OperationActions = Omit<VehicleRequestFeedActions, 'createWeekly' | 'openWeekly'>;

/**
 * Compose the editor, lifecycle and specialist windows that surround the request feed. They stay
 * at page level because widgets cannot import sibling widgets; the tab itself receives one ready
 * command port and one rendered node instead of owning every modal state and mutation.
 */
export function useVehicleRequestOperations() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { openRoute, openRoutesList } = useRouteModal();
  const canChangeStatus = can('vehicleRequests.status');

  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);
  const opened = useOpenedRecord<VehicleRequestDto>({
    active: useActiveTabKey() === 'requests',
    queryKey: (id) => vehicleRequestKeys.detail(id),
    fetch: (id) => vehicleRequestsApi.get(id),
  });
  const viewed = viewRecord ?? opened.record;
  const closeView = () => {
    setViewRecord(null);
    opened.clear();
  };

  const requestEditor = useVehicleRequestEditor({
    openRoute,
    renderPeriodModal: (props) => <VehiclePeriodModal {...props} />,
  });
  const lifecycle = useVehicleRequestLifecycle({
    staleReasonOf: (error) =>
      assignmentModel.reassignStaleReason(error) ?? assignmentModel.recheckReasonOf(error),
    renderCompleteModal: (props) => <VehicleCompleteModal {...props} />,
    renderEarlyEndApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
    renderEarlyEndModal: (props) => <VehicleEarlyEndModal {...props} />,
  });

  const [reassignTarget, setReassignTarget] = useState<VehicleRequestDto | null>(null);
  const [machinistTarget, setMachinistTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  const [repairTarget, setRepairTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  const [relocation, setRelocation] = useState<{
    request: VehicleRequestDto;
    purpose: 'delivery' | 'pickup';
  } | null>(null);
  const [transferTarget, setTransferTarget] = useState<VehicleRequestDto | null>(null);
  const [esm2Target, setEsm2Target] = useState<VehicleRequestDto | null>(null);

  const reassignMutation = useMutation({
    mutationFn: (value: { id: string; version: number; command: assignmentModel.AssignCommand }) =>
      vehicleRequestsApi.changeAssignment(
        value.id,
        assignmentModel.reassignRequestBody(value.command, value.version),
      ),
    onSuccess: (_updated, value) => {
      message.success(
        value.command.correction ? 'Назначение исправлено задним числом' : 'Техника изменена',
      );
      setReassignTarget(null);
      void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      void queryClient.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
      void queryClient.invalidateQueries({ queryKey: garageKeys.root });
    },
    // A stale consequence preview is a question handled inside the assignment dialog, not a
    // second toast. Other failures still use the entity-owned field labels.
    onError: (error) => {
      if (assignmentModel.reassignStaleReason(error) ?? assignmentModel.recheckReasonOf(error)) {
        return;
      }
      message.error(errorMessage(error));
    },
  });

  const canReassign = (request: VehicleRequestDto) =>
    canChangeStatus && canReassignVehicle(request);
  const canChangeMachinist = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canChangeStatus &&
    can('waybills.read') &&
    request.requestType === 'special_equipment' &&
    canCorrectAssignment(request) &&
    esm2Mode({
      requestType: request.requestType,
      status: request.status,
      ownership: request.assignment?.ownership ?? null,
      deletedAt: request.deletedAt,
      isLinear: request.isLinear,
    }) === 'auto';
  // Repair intentionally accepts archived confirmed requests: that is the recovery door for
  // assignment-history gaps that ordinary assignment correction cannot open after deletion.
  const canRepairHistory = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canChangeStatus &&
    can('waybills.read') &&
    request.requestType === 'special_equipment' &&
    request.status === 'confirmed' &&
    !!request.assignment &&
    !request.isLinear &&
    (request.assignment.ownership ?? 'own') === 'own';

  const actions: OperationActions = {
    approveEarlyEnd: lifecycle.actions.approveEarlyEnd,
    canChangeMachinist,
    canDecideEarlyEnd: lifecycle.actions.canDecideEarlyEnd,
    canModify: lifecycle.actions.canModify,
    canReassign,
    canRepairHistory,
    canRequestEarlyEnd: lifecycle.actions.canRequestEarlyEnd,
    changeApproval: lifecycle.actions.changeApproval,
    changeMachinist: setMachinistTarget,
    changeStatus: lifecycle.actions.changeStatus,
    create: requestEditor.openCreate,
    edit: requestEditor.openEdit,
    openOrder: setViewRecord,
    openRoute,
    openRoutes: () => openRoutesList(),
    reassign: setReassignTarget,
    rejectEarlyEnd: lifecycle.actions.rejectEarlyEnd,
    remove: lifecycle.actions.remove,
    repairHistory: setRepairTarget,
    requestEarlyEnd: lifecycle.actions.requestEarlyEnd,
    restore: lifecycle.actions.restore,
    routeLink: (routeId) => vehicleRouteLink(can, routeId),
  };

  const node = (
    <>
      {requestEditor.node}
      <VehicleRequestViewModal
        request={viewed}
        onClose={closeView}
        earlyEndActions={lifecycle.earlyEndActions}
        onEdit={
          viewed && lifecycle.actions.canModify(viewed)
            ? (request) => {
                closeView();
                requestEditor.openEdit(request);
              }
            : undefined
        }
        onCopy={
          viewed && requestEditor.canCopy(viewed)
            ? (request) => {
                closeView();
                requestEditor.openCopy(request);
              }
            : undefined
        }
        onReassign={
          viewed && canReassign(viewed)
            ? (request) => {
                closeView();
                setReassignTarget(request);
              }
            : undefined
        }
        onChangeMachinist={
          viewed && canChangeMachinist(viewed)
            ? (request) => {
                closeView();
                if (canChangeMachinist(request)) setMachinistTarget(request);
              }
            : undefined
        }
        onTransfer={
          viewed && canChangeStatus && viewed.route && !viewed.route.hasWaybill
            ? (request) => {
                closeView();
                setTransferTarget(request);
              }
            : undefined
        }
        onRelocate={
          viewed &&
          canChangeStatus &&
          viewed.requestType === 'special_equipment' &&
          viewed.status === 'confirmed' &&
          viewed.assignment?.ownership === 'own'
            ? (request, purpose) => {
                closeView();
                setRelocation({ request, purpose });
              }
            : undefined
        }
        onIssueEsm2={
          viewed &&
          viewed.requestType === 'special_equipment' &&
          viewed.isLinear &&
          viewed.status === 'confirmed' &&
          viewed.assignment?.ownership === 'own' &&
          canChangeStatus &&
          can('waybills.read')
            ? (request) => {
                closeView();
                setEsm2Target(request);
              }
            : undefined
        }
      />

      <VehicleEsm2Modal
        request={esm2Target}
        onClose={() => setEsm2Target(null)}
        onDone={() => setEsm2Target(null)}
      />
      <VehicleRelocationModal
        request={relocation?.request ?? null}
        purpose={relocation?.purpose ?? 'delivery'}
        onClose={() => setRelocation(null)}
        onDone={() => setRelocation(null)}
      />
      <VehicleRouteTransferModal
        request={transferTarget}
        onClose={() => setTransferTarget(null)}
        onDone={() => setTransferTarget(null)}
      />
      <VehicleAssignModal
        request={lifecycle.assignment.target}
        confirmLoading={lifecycle.assignment.pending}
        onCancel={lifecycle.assignment.close}
        onSubmit={lifecycle.assignment.submit}
      />
      <VehicleAssignModal
        request={reassignTarget}
        mode="reassign"
        confirmLoading={reassignMutation.isPending}
        onCancel={() => setReassignTarget(null)}
        onSubmit={(command) =>
          reassignTarget
            ? reassignMutation.mutateAsync({
                id: reassignTarget.id,
                version: reassignTarget.version,
                command,
              })
            : undefined
        }
      />
      <VehicleMachinistModal
        request={machinistTarget}
        onCancel={() => setMachinistTarget(null)}
        onApplied={() => {
          void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
          void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
        }}
      />
      <VehicleRepairModal
        request={repairTarget}
        onCancel={() => setRepairTarget(null)}
        onRepaired={() => {
          void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
          void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
        }}
      />
      {lifecycle.node}
    </>
  );

  return {
    actions,
    node,
    pending: lifecycle.pending,
    rights: {
      canApprove: lifecycle.rights.canApprove,
      canDelete: lifecycle.rights.canDelete,
      canEdit: lifecycle.rights.canEdit,
      canRestore: lifecycle.rights.canRestore,
    },
  };
}
