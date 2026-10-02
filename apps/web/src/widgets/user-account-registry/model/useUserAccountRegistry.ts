import { useQuery } from '@tanstack/react-query';
import {
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeLabels,
  registrationRoleRequestLabels,
  REGISTRATION_ROLE_REQUESTS,
  ROLES,
  roleLabels,
} from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { objectKeys, objectsApi } from '@entities/object';
import { useAuth } from '@entities/session';
import { userAccountKeys, usersApi } from '@entities/user-account';
import { useListParams } from '@shared/lib';

interface RegistryFilters {
  role?: string;
  isActive?: string;
  pending?: string;
  constructionObjectId?: string;
  counterpartyId?: string;
  requestedRole?: string;
  createdFrom?: string;
  createdTo?: string;
  includeDeleted?: string;
}

/** Own list parameters, lookup data and the account registry queries. */
export function useUserAccountRegistry() {
  const { can } = useAuth();
  const list = useListParams<RegistryFilters>({}, { searchKeys: [] });
  const { params, setParams } = list;
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((current) => ({ ...current, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: userAccountKeys.list(params),
    queryFn: () => usersApi.list(params),
  });
  const { data: pending } = useQuery({
    queryKey: userAccountKeys.pendingCount(),
    queryFn: () => usersApi.pendingCount(),
  });
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
  const { data: executors, isLoading: executorsLoading } = useQuery({
    queryKey: counterpartyKeys.activeOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

  const objectOptions = (objects?.items ?? []).map((object) => ({
    value: object.id,
    label: `${object.code} — ${object.name}`,
  }));
  // Grouping keeps the counterparty type visible because it determines the available module.
  const executorGroups = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((type) => ({
    label: counterpartyTypeLabels[type],
    options: (executors?.items ?? [])
      .filter((counterparty) => counterparty.type === type)
      .map((counterparty) => ({
        value: counterparty.id,
        label: `${counterparty.name} (ИНН ${counterparty.inn})`,
      })),
  })).filter((group) => group.options.length > 0);

  const showPending = params.pending === 'true';
  const setPending = (next: boolean) =>
    applyFilter({
      pending: next ? 'true' : undefined,
      // The requested-role control disappears outside pending mode, so its value must go too.
      requestedRole: next ? params.requestedRole : undefined,
    });

  return {
    ...list,
    applyFilter,
    canSeeArchive: can('archive.read'),
    data,
    executorGroups,
    executorsLoading,
    isFetching,
    objectOptions,
    objectsLoading,
    pending,
    requestedRoleOptions: REGISTRATION_ROLE_REQUESTS.map((value) => ({
      value,
      label: registrationRoleRequestLabels[value],
    })),
    roleOptions: ROLES.map((role) => ({ value: role, label: roleLabels[role] })),
    setPending,
    showPending,
    statusOptions: [
      { value: 'true', label: 'Активные' },
      { value: 'false', label: 'Неактивные' },
    ],
  };
}

export type UserAccountRegistryModel = ReturnType<typeof useUserAccountRegistry>;
