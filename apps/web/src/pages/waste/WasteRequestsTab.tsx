import { actsForCounterparty } from '@technic/contracts';
import { useAuth, usePlaceObjectScope } from '@entities/session';
import { WasteRequestCompletionModal } from '@features/waste-request-completion';
import { useWasteRequestEditor } from '@features/waste-request-editor';
import { useWasteRequestLifecycle } from '@features/waste-request-lifecycle';
import { useActiveTabKey } from '@shared/ui';
import { WasteRequestFeed } from '@widgets/waste-request-feed';
import { useWasteRequestView } from '@widgets/waste-request-view';
import { WasteOperatorAssignmentWithOptions } from './WasteOperatorAssignmentWithOptions';

/** Compose independently owned list, editor, lifecycle and card slices. */
export function WasteRequestsTab() {
  const { user, can } = useAuth();
  const active = useActiveTabKey() === 'requests';
  // Visibility scope (own sites), not a permission: it decides what filters and columns show, not
  // what is allowed. A department role derives its sites from its department (ADR 0062). A role
  // with one site gets the filter fixed on it; with several the filter stays open but limited to
  // them (ADR 0039), and "all" means all of its own sites because the server returns nothing else.
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = usePlaceObjectScope();
  // Actions follow permissions only (ADR 0021), the same ones the API checks.
  const canCreate = can('wasteRequests.create');
  const canAssignOperator = can('wasteRequests.assignOperator');
  // Ticket review is a separate permission (ADR 0114, R25): without it there is neither the badge
  // column nor the filter. The server agrees: the ticketReview parameter without the permission is
  // rejected rather than ignored.
  const canReviewTickets = can('wasteRequests.ticketReview');
  const canAuditTickets = can('wasteRequests.ticketAudit');
  // A waste operator is an executor role acting for an operator counterparty (ADR 0038); the role
  // alone is not enough, since the same role serves equipment lessors in another section.
  const isOperator = actsForCounterparty(user, 'operator');

  const editor = useWasteRequestEditor({
    objectFieldDisabled,
    limitObjectOptions,
    soleObjectId: soleObjectId ?? undefined,
  });
  const lifecycle = useWasteRequestLifecycle({
    renderCompletion: (props) => <WasteRequestCompletionModal {...props} />,
    renderOperator: (props) => (
      <WasteOperatorAssignmentWithOptions {...props} canAssignOperator={canAssignOperator} />
    ),
  });
  const view = useWasteRequestView({
    active,
    canModify: lifecycle.actions.canModify,
    onEdit: editor.actions.edit,
  });

  return (
    <WasteRequestFeed
      actions={{
        canModify: lifecycle.actions.canModify,
        changeStatus: lifecycle.actions.changeStatus,
        create: editor.actions.create,
        edit: editor.actions.edit,
        open: view.actions.open,
        openTicketReview: view.actions.openTicketReview,
        remove: lifecycle.actions.remove,
        restore: lifecycle.actions.restore,
      }}
      pending={lifecycle.pending}
      rights={{
        canAuditTickets,
        canCreate,
        canDelete: lifecycle.rights.canDelete,
        canEdit: lifecycle.rights.canEdit,
        canRestore: lifecycle.rights.canRestore,
        canReviewTickets,
        isOperator,
      }}
      sources={{
        initialObjectId: soleObjectId ?? '',
        objectFilterDisabled: objectFieldDisabled,
        limitObjectOptions,
        canAssignOperator,
      }}
    >
      {view.node}
      {lifecycle.node}
      {editor.node}
    </WasteRequestFeed>
  );
}
