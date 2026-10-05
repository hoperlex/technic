import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type SpecialEquipmentRequestDto, type VehicleRequestDto } from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteLink } from '@entities/vehicle-route';
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
import { vehicleRequestOperationRules } from './vehicleRequestOperationRules';

type OperationActions = Omit<VehicleRequestFeedActions, 'createWeekly' | 'openWeekly'>;

/**
 * Compose the editor, lifecycle and specialist windows that surround the request feed. They stay
 * at page level because widgets cannot import sibling widgets; the tab itself receives one ready
 * command port and one rendered node instead of owning every modal state and mutation.
 */
export function useVehicleRequestOperations() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  // The route and the route list open as windows over this list (ADR 0120): "where does this
  // request go" no longer costs leaving the screen together with its filters and page.
  const { openRoute, openRoutesList } = useRouteModal();
  const rules = vehicleRequestOperationRules(can);
  const { canChangeMachinist, canReassign, canRepairHistory } = rules;

  // The open request card: read-only fields plus the event history (ADR 0015).
  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);
  /*
   * The request named in the address: links from a route composition or the waybill journal lead
   * here. The record is fetched by id, not searched in the loaded page: the same request may sit on
   * another page or under another filter.
   *
   * Weekly ids never come here: a weekly row leads to its own page (`/vehicle-requests/weekly/:id`)
   * rather than opening a card in the list, and no weekly link sets `open`. Otherwise the feed
   * would ask the orders route for a weekly document and get "Record not found" on every such
   * address.
   */
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
    staleReasonOf: assignmentModel.assignmentRecheckReason,
    renderCompleteModal: (props) => <VehicleCompleteModal {...props} />,
    renderEarlyEndApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
    renderEarlyEndModal: (props) => <VehicleEarlyEndModal {...props} />,
  });

  const reassignment = assignmentModel.useVehicleReassignment();
  // Machinist change within the term and "composition by dates" (`docs/assignment-periods-plan.md`,
  // §9). A dialog of its own, not a field of the vehicle-change dialog: that one changes what runs
  // the request — vehicle, rates and route — while this is one decision about a person and a date.
  const [machinistTarget, setMachinistTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  const [repairTarget, setRepairTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  const [relocation, setRelocation] = useState<{
    request: VehicleRequestDto;
    purpose: 'delivery' | 'pickup';
  } | null>(null);
  const [transferTarget, setTransferTarget] = useState<VehicleRequestDto | null>(null);
  const [esm2Target, setEsm2Target] = useState<VehicleRequestDto | null>(null);

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
    reassign: reassignment.open,
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
      {/* The request card: read-only fields plus event history. Editing goes through the same form
          as from the table, and only when the role may edit. Every specialist action below closes
          the card first: the command changes the request version, and the card's fields would be
          stale. */}
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
        // Vehicle change right from the card (ADR 0048): the "Vehicle" field is visible here, and
        // changing it here is natural rather than going back to the list row.
        onReassign={
          viewed && canReassign(viewed)
            ? (request) => {
                closeView();
                reassignment.open(request);
              }
            : undefined
        }
        // Machinist change and "composition by dates" from the card: the "Driver" line answers
        // about today, and "who worked in March" is asked while looking at it.
        onChangeMachinist={
          viewed && canChangeMachinist(viewed)
            ? (request) => {
                closeView();
                if (canChangeMachinist(request)) setMachinistTarget(request);
              }
            : undefined
        }
        onTransfer={
          viewed && rules.canTransfer(viewed)
            ? (request) => {
                closeView();
                setTransferTarget(request);
              }
            : undefined
        }
        onRelocate={
          viewed && rules.canRelocate(viewed)
            ? (request, purpose) => {
                closeView();
                setRelocation({ request, purpose });
              }
            : undefined
        }
        onIssueEsm2={
          viewed && rules.canIssueEsm2(viewed)
            ? (request) => {
                closeView();
                setEsm2Target(request);
              }
            : undefined
        }
      />

      {/* Weekly ESM-2 on demand: a linear request gets no forms by itself, and the person issues
          them one week at a time (ADR 0100). */}
      <VehicleEsm2Modal
        request={esm2Target}
        onClose={() => setEsm2Target(null)}
        onDone={() => setEsm2Target(null)}
      />
      {/* Delivery to the site and pickup from it: a relocation route with a 4-P. Optional — the
          equipment may come on a carrier. */}
      <VehicleRelocationModal
        request={relocation?.request ?? null}
        purpose={relocation?.purpose ?? 'delivery'}
        onClose={() => setRelocation(null)}
        onDone={() => setRelocation(null)}
      />
      {/* Moving the request between routes: suitable routes of the same day and vehicle type. */}
      <VehicleRouteTransferModal
        request={transferTarget}
        onClose={() => setTransferTarget(null)}
        onDone={() => setTransferTarget(null)}
      />
      {/* Taking into work: vehicle, rates (ADR 0027) and the actual term, all in the same request
          as the status change — a request is never "in work" on nothing, nor taken for one time
          with a waybill for another. */}
      <VehicleAssignModal
        request={lifecycle.assignment.target}
        confirmLoading={lifecycle.assignment.pending}
        onCancel={lifecycle.assignment.close}
        onSubmit={lifecycle.assignment.submit}
      />
      {/* Vehicle change of a request in work (ADR 0048): the same selection dialog without the
          actual term — it is agreed already, only what runs the request changes. */}
      <VehicleAssignModal
        request={reassignment.target}
        mode="reassign"
        confirmLoading={reassignment.pending}
        onCancel={reassignment.close}
        onSubmit={reassignment.submit}
      />
      {/* Machinist change within the term and "composition by dates"
          (`docs/assignment-periods-plan.md`, §9): the dialog shows the request history in segments,
          asks for a person and a date and, before writing, the cost. It stays open after the
          command: the composition refreshes in place, and a second change in a row goes with the
          new request version. */}
      <VehicleMachinistModal
        request={machinistTarget}
        onCancel={() => setMachinistTarget(null)}
        onApplied={() => {
          // Lists behind the dialog are stale: the request has a new version, weeks new form
          // numbers.
          void queryClient.invalidateQueries({ queryKey: vehicleRequestKeys.root });
          void queryClient.invalidateQueries({ queryKey: waybillKeys.root });
        }}
      />
      {/* History repair (sub-stage 6a): machinist gaps, filling unknown days and the decision about
          the vehicle after the term end. The dialog asks the server what to repair — the portal
          does not compute it: it depends on which paper can still be cancelled. */}
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
