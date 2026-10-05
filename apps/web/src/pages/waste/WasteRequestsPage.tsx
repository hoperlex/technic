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

const TABS = ['requests', 'on-site', 'history', 'blind-check', 'archive', 'stats'] as const;

/** Route-level owner: tabs, URL selection and permission-gated tab composition. */
export function WasteRequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, user } = useAuth();
  const canAuditTickets = can('wasteRequests.ticketAudit');
  const statsAxis = roleScopeAxis(user?.role ?? null);
  const items = [
    { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
    { key: 'on-site', label: 'На объекте', children: <OnSiteTab /> },
    { key: 'history', label: 'История', children: <WasteHistoryTab /> },
    ...(can('wasteRequests.ticketReview')
      ? [{ key: 'blind-check', label: 'Перепроверка', children: <BlindCheckQueue /> }]
      : []),
    ...(can('archive.read')
      ? [{ key: 'archive', label: 'Архив', children: <WasteArchiveTab /> }]
      : []),
    ...(statsAxis !== 'counterparty' && statsAxis !== 'person'
      ? [{ key: 'stats', label: 'Статистика', children: <WasteStatsTab /> }]
      : []),
  ];
  const rawTab = searchParams.get('tab') ?? '';
  // A link to a now-hidden tab falls back to the registry instead of rendering an empty page.
  const activeTab =
    (TABS as readonly string[]).includes(rawTab) && items.some((item) => item.key === rawTab)
      ? rawTab
      : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <TicketAuditModal allowed={canAuditTickets} />
      <PageTabs
        activeKey={activeTab}
        // Manual tab selection intentionally drops card deep-link parameters.
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
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = usePlaceObjectScope();
  const canCreate = can('wasteRequests.create');
  const canAssignOperator = can('wasteRequests.assignOperator');
  const canReviewTickets = can('wasteRequests.ticketReview');
  const canAuditTickets = can('wasteRequests.ticketAudit');
  const isOperator = actsForCounterparty(user, 'operator');

  // Shared directory reads stay at the composition boundary because both list and editor use them.
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
  const { data: types, isLoading: typesLoading } = useQuery(
    containerTypeOptionsQuery({ activeOnly: true }),
  );
  const { data: wasteTypes, isLoading: wasteTypesLoading } = useQuery(
    wasteTypeOptionsQuery({ pricedOnly: true }),
  );
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
  const objectFilterOptions = limitObjectOptions(
    (objects?.items ?? []).map((object) => ({
      value: object.id,
      label: objectFilterOptionLabel(object),
    })),
  );
  const allTypes = types?.items ?? [];
  const containerTypes = allTypes
    .filter((type) => type.type === 'cont')
    .map((type) => ({ value: type.id, label: type.name }));
  const truckTypes = allTypes
    .filter((type) => type.type === 'truck')
    .map((type) => ({ value: type.id, label: type.name }));
  const wasteTypeOptions = (wasteTypes?.items ?? []).map((type) => ({
    value: type.id,
    label: type.name,
  }));
  const operatorOptions = (operators?.items ?? []).map((operator) => ({
    value: operator.id,
    label: operator.name,
  }));
  // Sites with explicit operator links are restricted to them; an unconfigured site stays usable.
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
