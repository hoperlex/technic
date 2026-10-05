import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { actsForCounterparty, roleScopeAxis } from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { objectFilterOptionLabel, objectsApi, objectKeys } from '@entities/object';
import { useAuth, usePlaceObjectScope } from '@entities/session';
import { wasteRequestKeys } from '@entities/waste-request';
import { wasteTypeOptionsQuery } from '@entities/waste-type';
import { TicketAuditModal } from '@features/ticket-audit';
import { WasteOperatorAssignmentModal } from '@features/waste-operator-assignment';
import { WasteRequestCompletionModal } from '@features/waste-request-completion';
import { useWasteRequestEditor } from '@features/waste-request-editor';
import { useWasteRequestLifecycle } from '@features/waste-request-lifecycle';
import { BlindCheckQueue } from '@features/waste-ticket-review';
import { withSavedOption } from '@shared/lib';
import { PageTabs, useActiveTabKey } from '@shared/ui';
import { WasteRequestFeed } from '@widgets/waste-request-feed';
import { useWasteRequestView } from '@widgets/waste-request-view';
import { OnSiteTab } from './OnSiteTab';
import { WasteArchiveTab } from './WasteArchiveTab';
import { WasteHistoryTab } from './WasteHistoryTab';
import { WasteStatsTab } from './WasteStatsTab';

// The tab lives in the URL, not in state: links from neighbouring sections (the install request
// number in the sites list) arrive with a ready answer which tab to show and what to open on it.
const TABS = ['requests', 'on-site', 'history', 'blind-check', 'archive', 'stats'] as const;

/** Route-level owner: tabs, URL selection and permission-gated tab composition. */
export function WasteRequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, user } = useAuth();
  // Recognition audit (ADR 0137) is a modal over the registry, not a tab: the permission is strong
  // and rare. It is mounted here, above the tabs, because a ?ticketAudit=1 link may arrive on any
  // tab; mounted inside one tab it would open only when that tab happened to be active.
  const canAuditTickets = can('wasteRequests.ticketAudit');
  // The stats tab (ADR 0193) shares the list permission but has a narrower audience: counterparty
  // executors and person-scoped accounts get no answer, because a summary of other sites is not
  // theirs to read. The check asks the role scope axis with the same predicate the server uses
  // (assertWasteStatsAudience in apps/api/src/services/waste-stats.ts); if the two drifted apart,
  // the tab would lead straight into a 403.
  const statsAxis = roleScopeAxis(user?.role ?? null);
  const items = [
    { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
    { key: 'on-site', label: 'На объекте', children: <OnSiteTab /> },
    // History (ADR 0135) lists done and cancelled requests and is open to everyone who sees the
    // module: a closed request carries the same information as a working one, and the server
    // narrows the result with the same scope as the working list.
    { key: 'history', label: 'История', children: <WasteHistoryTab /> },
    // Blind re-check is a second person's work (ADR 0114, R31): they read the ticket without seeing
    // the recognized or confirmed values. It is a tab rather than a section because the scope and
    // the permission are the same as ticket review.
    ...(can('wasteRequests.ticketReview')
      ? [{ key: 'blind-check', label: 'Перепроверка', children: <BlindCheckQueue /> }]
      : []),
    // The archive holds deleted requests (ADR 0070). It is gated by the archive.read permission,
    // never by a role name: the server closes the archive listing with the same permission, and a
    // role-based check would either lead to an empty list or hide an archive the user may read.
    ...(can('archive.read')
      ? [{ key: 'archive', label: 'Архив', children: <WasteArchiveTab /> }]
      : []),
    // Stats stay last: the first tabs are the daily request work people come here for, and a tab
    // inserted in the middle would shift familiar positions instead of extending the strip.
    ...(statsAxis !== 'counterparty' && statsAxis !== 'person'
      ? [{ key: 'stats', label: 'Статистика', children: <WasteStatsTab /> }]
      : []),
  ];
  const rawTab = searchParams.get('tab') ?? '';
  // A link to a hidden tab falls back to the registry instead of an empty page, so saved URLs
  // survive a role change.
  const activeTab =
    (TABS as readonly string[]).includes(rawTab) && items.some((item) => item.key === rawTab)
      ? rawTab
      : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <TicketAuditModal allowed={canAuditTickets} />
      <PageTabs
        activeKey={activeTab}
        // Manual tab selection intentionally drops card deep-link parameters: the URL keeps only
        // tab, and the open parameter of a card opened by link goes away with the switch.
        onChange={(tab) => setSearchParams({ tab })}
        refreshQueryKey={wasteRequestKeys.root}
        items={items}
      />
    </div>
  );
}

/** Compose independently owned list, editor, lifecycle and card slices. */
function RequestsTab() {
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
