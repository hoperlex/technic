import { useQuery } from '@tanstack/react-query';
import { actsForCounterparty } from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { objectFilterOptionLabel, objectsApi, objectKeys } from '@entities/object';
import { useAuth, usePlaceObjectScope } from '@entities/session';
import { wasteTypeOptionsQuery } from '@entities/waste-type';
import { WasteOperatorAssignmentModal } from '@features/waste-operator-assignment';
import { WasteRequestCompletionModal } from '@features/waste-request-completion';
import { useWasteRequestEditor } from '@features/waste-request-editor';
import { useWasteRequestLifecycle } from '@features/waste-request-lifecycle';
import { withSavedOption } from '@shared/lib';
import { useActiveTabKey } from '@shared/ui';
import { WasteRequestFeed } from '@widgets/waste-request-feed';
import { useWasteRequestView } from '@widgets/waste-request-view';

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

  // Shared directory reads stay at the composition boundary because both list and editor use them.
  // isLoading is passed to editor fields as well: a required field with a single option fills
  // itself, and it must not do so from a list that has not finished loading.
  const { data: objects, isLoading: objectsLoading } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  // One directory read split by kind below: the request needs both containers and trucks, and a
  // second request for the same answer would only delay the first screen.
  const { data: types, isLoading: typesLoading } = useQuery(
    containerTypeOptionsQuery({ activeOnly: true }),
  );
  // Waste types exist only for removal requests (ADR 0019), and only types with an active price
  // are offered (ADR 0017): choosing an unpriced type would end in "tariff not found" on save.
  const { data: wasteTypes, isLoading: wasteTypesLoading } = useQuery(
    wasteTypeOptionsQuery({ pricedOnly: true }),
  );
  // Operators are counterparties of the operator type (ADR 0010). An operator never picks the
  // executor, so the list is requested only for those who may assign one.
  const { data: operators, isLoading: operatorsLoading } = useQuery({
    queryKey: counterpartyKeys.activeOperatorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'operator',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: canAssignOperator,
  });

  const objectOptions = limitObjectOptions(
    (objects?.items ?? []).map((object) => ({
      value: object.id,
      label: `${object.code} — ${object.name}`,
    })),
  );
  // The list filter also names the site by address: requests are searched by "what was on that
  // street" as often as by site name. The editor keeps the shorter label because there a user picks
  // one of their own sites rather than searching.
  const objectFilterOptions = limitObjectOptions(
    (objects?.items ?? []).map((object) => ({
      value: object.id,
      label: objectFilterOptionLabel(object),
    })),
  );
  const allTypes = types?.items ?? [];
  // Installation picks only containers (type cont).
  const containerTypes = allTypes
    .filter((type) => type.type === 'cont')
    .map((type) => ({ value: type.id, label: type.name }));
  // Trucks serve legacy closing vehicles (ADR 0011) and the list filter: a removal request no
  // longer names equipment (ADR 0022), but requests created before that decision keep their type.
  const truckTypes = allTypes
    .filter((type) => type.type === 'truck')
    .map((type) => ({ value: type.id, label: type.name }));
  const wasteTypeOptions = (wasteTypes?.items ?? []).map((type) => ({
    value: type.id,
    label: type.name,
  }));
  // The list filter ignores the site: requests are searched by operator and site independently.
  const operatorOptions = (operators?.items ?? []).map((operator) => ({
    value: operator.id,
    label: operator.name,
  }));
  // The executor is chosen among operators linked to the request site (ADR 0010). This repeats the
  // server rule (assertOperatorServesObject in apps/api/src/services/object-operators.ts) and must
  // stay identical to it: a site without any operator links does not narrow the list, otherwise a
  // new site would have nobody to choose. The already assigned operator stays in the options even
  // if its link was removed; otherwise the field would show a raw identifier instead of a name.
  const operatorOptionsFor = (
    objectId: string | undefined,
    assigned?: { id: string | null; name: string | null },
  ) => {
    const all = operators?.items ?? [];
    const linked = objectId
      ? all.filter((operator) => operator.objects.some((object) => object.id === objectId))
      : [];
    const options = (linked.length > 0 ? linked : all).map((operator) => ({
      value: operator.id,
      label: operator.name,
    }));
    return withSavedOption(options, { id: assigned?.id, name: assigned?.name });
  };

  const editor = useWasteRequestEditor({
    containerTypes: { cont: containerTypes, loading: typesLoading },
    objectFieldDisabled,
    objectOptions,
    objectsLoading,
    operatorOptionsFor,
    operatorsLoading,
    soleObjectId: soleObjectId ?? undefined,
    wasteTypes: { options: wasteTypeOptions, loading: wasteTypesLoading },
  });
  const lifecycle = useWasteRequestLifecycle({
    renderCompletion: (props) => <WasteRequestCompletionModal {...props} />,
    renderOperator: (props) => (
      <WasteOperatorAssignmentModal
        {...props}
        loading={operatorsLoading}
        options={operatorOptionsFor(props.request?.objectId, {
          id: props.request?.operatorCounterpartyId ?? null,
          name: props.request?.operatorName ?? null,
        })}
      />
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
        objectOptions: objectFilterOptions,
        objectsLoading,
        subjectTypes: { cont: containerTypes, truck: truckTypes },
        operators: canAssignOperator
          ? { options: operatorOptions, loading: operatorsLoading }
          : null,
      }}
    >
      {view.node}
      {lifecycle.node}
      {editor.node}
    </WasteRequestFeed>
  );
}
