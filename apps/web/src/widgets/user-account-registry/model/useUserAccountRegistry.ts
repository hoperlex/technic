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
  // Every filter is set by the panel above the table: objects and counterparties are picked by
  // searching a list that does not fit a column-header dropdown, and on the phone there are no
  // header dropdowns at all. They must not be duplicated in column headers either: the table's
  // onChange delivers an empty filter for them, so any sort would reset the chosen values.
}

/** Own list parameters, lookup data and the account registry queries. */
export function useUserAccountRegistry() {
  const { can } = useAuth();
  const list = useListParams<RegistryFilters>({}, { searchKeys: [] });
  const { params, setParams } = list;
  // Any filter change returns to the first page: the same page number over a different set already
  // means different records.
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((current) => ({ ...current, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: userAccountKeys.list(params),
    queryFn: () => usersApi.list(params),
  });
  // Count of unreviewed registrations; the same number is drawn as a badge in the administration
  // menu.
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
  // Executors are the counterparties an account can work for: a waste operator or a vehicle lessor
  // (ADR 0038). Grouped by type, because the type decides what the account can do, so the choice
  // reads "first as whom, then who" rather than one flat list mixing two kinds of executors.
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
    // Seeing the archive and managing it are different permissions (ADR 0021): restore and purge
    // are checked by their own commands.
    canSeeArchive: can('archive.read'),
    data,
    executorGroups,
    executorsLoading,
    isFetching,
    objectOptions,
    objectsLoading,
    pending,
    // A wish is stated only at self-registration (ADR 0034); administrator-created accounts have
    // none, so this filter is shown only in pending mode — in the full list it would silently cut
    // everyone off.
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
