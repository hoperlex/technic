import { DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  auditActionLabels,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeLabels,
  ROLES,
  roleLabels,
  USER_TARGET_AUDIT_ACTIONS,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import type { FilterDefinition } from '@shared/ui';
import { withSavedOption } from '@shared/lib';
import { objectKeys, objectsApi } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { userAccountKeys, usersApi } from '@entities/user-account';

/**
 * Change-log filters (ADR 0109): by the events themselves — period, action, administrator — and by
 * the data of the account that was acted on.
 *
 * The second group is why the screen was rebuilt: questions to the log are asked about people —
 * "what was changed for mechanics", "who was given SU-10" — and there used to be nothing to filter
 * them by. Filtering uses the account's state **now**: the log keeps no snapshot at event time,
 * and a filter bar must not promise a time machine.
 *
 * Kept in a module of its own: there are about ten fields, and each lives twice — as a bar on
 * desktop and as a descriptor for the phone sheet (ADR 0030).
 */

/** The account narrowing the log: the id for the query, the name for the field label. */
export interface AuditFilterTarget {
  id: string;
  name: string;
}

export interface AuditFilterParams {
  // The index signature comes from `useListParams`: the filter set goes to the request as is, and
  // list parameters (page, sorting) live in the same object.
  [key: string]: unknown;
  search?: string;
  actions?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  targetRole?: string;
  targetIsActive?: string;
  targetObjectId?: string;
  targetDepartmentId?: string;
  targetCounterpartyId?: string;
  targetArchive?: string;
}

const DATE = 'YYYY-MM-DD';

/**
 * Action checkboxes cover the actions whose target is an account — the same ones the server's log
 * slice returns. Grant issue and revocation (ADR 0106) are visible in the feed, so the reader must
 * be able to pick them with the same field: a filter shorter than the feed forces searching by eye.
 */
const actionOptions = USER_TARGET_AUDIT_ACTIONS.map((action) => ({
  value: action,
  label: auditActionLabels[action],
}));
const roleOptions = ROLES.map((r) => ({ value: r, label: roleLabels[r] }));
const accessOptions = [
  { value: 'true', label: 'Доступ открыт' },
  { value: 'false', label: 'Доступ закрыт' },
];
/**
 * Archive as three positions rather than a "show archive" checkbox as in the account list: the log
 * is about the past by construction, and a default hiding archived accounts would cut off the most
 * frequent question to it — what happened to a person who has already left.
 */
const archiveOptions = [
  { value: 'include', label: 'Любые учётки' },
  { value: 'exclude', label: 'Только действующие' },
  { value: 'only', label: 'Только из архива' },
];

interface Args {
  params: AuditFilterParams;
  apply: (patch: AuditFilterParams) => void;
  target: AuditFilterTarget | null;
  onTargetChange: (target: AuditFilterTarget | null) => void;
}

export function useUserAuditFilters({ params, apply, target, onTargetChange }: Args) {
  /**
   * People for both pickers come from one query: the same account can be both actor and target.
   * Inactive accounts are not removed: the log is read precisely about those who were switched off,
   * and a filter without them would answer "no entries" to the most frequent question.
   */
  const { data: people, isFetching: peopleLoading } = useQuery({
    queryKey: userAccountKeys.options(),
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
  const personOptions = (people?.items ?? []).map((u) => ({ value: u.id, label: u.fullName }));
  // An archived account is not in the list of live ones, yet its history is asked most often — its
  // name arrives with the selection, so the field shows a person rather than a bare id.
  const targetOptions = withSavedOption(personOptions, { id: target?.id, name: target?.name });

  // All sites are loaded, closed ones included: the log is about the past, and accounts of a closed
  // site are asked about exactly when reviewing where its people went.
  const { data: objects, isFetching: objectsLoading } = useQuery({
    queryKey: objectKeys.options({ activeOnly: false }),
    queryFn: () => objectsApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const objectOptions = (objects?.items ?? []).map((o) => ({
    value: o.id,
    label: `${o.code} — ${o.name}`,
  }));
  const { data: departmentOptions, isFetching: departmentsLoading } =
    useQuery(departmentOptionsQuery());
  const { data: counterparties, isFetching: counterpartiesLoading } = useQuery({
    queryKey: counterpartyKeys.options(),
    queryFn: () =>
      counterpartiesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  // Grouped by type, as in the account form: the counterparty type decides what the account does.
  const counterpartyGroups = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((type) => ({
    label: counterpartyTypeLabels[type],
    options: (counterparties?.items ?? [])
      .filter((c) => c.type === type)
      .map((c) => ({ value: c.id, label: c.name })),
  })).filter((g) => g.options.length > 0);

  const selectedActions = params.actions ? params.actions.split(',') : [];

  const filters = (
    <Space wrap size={8}>
      <Input.Search
        allowClear
        placeholder="ФИО или адрес"
        style={{ width: 220 }}
        defaultValue={params.search}
        onSearch={(v) => apply({ search: v || undefined })}
      />
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Действия с', 'по']}
        value={[params.from ? dayjs(params.from) : null, params.to ? dayjs(params.to) : null]}
        onChange={(range) =>
          apply({ from: range?.[0]?.format(DATE), to: range?.[1]?.format(DATE) })
        }
      />
      <Select
        allowClear
        mode="multiple"
        // Selected items collapse into "+N" when they do not fit: a set can hold a dozen actions,
        // and a stretched field would push the other filters to another line.
        maxTagCount="responsive"
        // Search by label: the list holds about twenty actions, and the needed one ("password
        // reset", "grant issued") would otherwise be found by scrolling. By label, not by action
        // code: the reader never sees the code, it is not shown even in the log row.
        showSearch
        optionFilterProp="label"
        placeholder="Все действия"
        style={{ width: 260 }}
        options={actionOptions}
        value={selectedActions}
        onChange={(v: string[]) => apply({ actions: v.length > 0 ? v.join(',') : undefined })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой администратор"
        style={{ width: 220 }}
        options={personOptions}
        loading={peopleLoading}
        value={params.actorUserId}
        onChange={(v: string | undefined) => apply({ actorUserId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любая учётная запись"
        style={{ width: 240 }}
        options={targetOptions}
        loading={peopleLoading}
        value={target?.id}
        onChange={(id: string | undefined) =>
          onTargetChange(
            id ? { id, name: targetOptions.find((o) => o.value === id)?.label ?? id } : null,
          )
        }
      />
      <Select
        allowClear
        placeholder="Любая роль"
        style={{ width: 180 }}
        options={roleOptions}
        value={params.targetRole}
        onChange={(v: string | undefined) => apply({ targetRole: v })}
      />
      <Select
        allowClear
        placeholder="Любой доступ"
        style={{ width: 160 }}
        options={accessOptions}
        value={params.targetIsActive}
        onChange={(v: string | undefined) => apply({ targetIsActive: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой объект"
        style={{ width: 220 }}
        options={objectOptions}
        loading={objectsLoading}
        value={params.targetObjectId}
        onChange={(v: string | undefined) => apply({ targetObjectId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой отдел"
        style={{ width: 200 }}
        options={departmentOptions ?? []}
        loading={departmentsLoading}
        value={params.targetDepartmentId}
        onChange={(v: string | undefined) => apply({ targetDepartmentId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Любой контрагент"
        style={{ width: 220 }}
        options={counterpartyGroups}
        loading={counterpartiesLoading}
        value={params.targetCounterpartyId}
        onChange={(v: string | undefined) => apply({ targetCounterpartyId: v })}
      />
      <Select
        style={{ width: 190 }}
        options={archiveOptions}
        value={params.targetArchive ?? 'include'}
        onChange={(v: string) => apply({ targetArchive: v })}
      />
    </Space>
  );

  /** The same filters as descriptors, for the phone sheet (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'dateRange',
      key: 'period',
      label: 'Действия за период',
      from: params.from,
      to: params.to,
      onChange: (from, to) => apply({ from, to }),
    },
    {
      kind: 'select',
      key: 'actorUserId',
      label: 'Администратор',
      value: params.actorUserId,
      options: personOptions,
      placeholder: 'Любой администратор',
      loading: peopleLoading,
      onChange: (v) => apply({ actorUserId: v }),
    },
    {
      kind: 'select',
      key: 'target',
      label: 'Учётная запись',
      value: target?.id,
      options: targetOptions,
      placeholder: 'Любая учётная запись',
      loading: peopleLoading,
      onChange: (id) =>
        onTargetChange(
          id ? { id, name: targetOptions.find((o) => o.value === id)?.label ?? id } : null,
        ),
    },
    {
      kind: 'select',
      key: 'targetRole',
      label: 'Роль учётной записи',
      value: params.targetRole,
      options: roleOptions,
      placeholder: 'Любая роль',
      onChange: (v) => apply({ targetRole: v }),
    },
    {
      kind: 'select',
      key: 'targetIsActive',
      label: 'Доступ',
      value: params.targetIsActive,
      options: accessOptions,
      placeholder: 'Любой доступ',
      onChange: (v) => apply({ targetIsActive: v }),
    },
    {
      kind: 'select',
      key: 'targetObjectId',
      label: 'Объект',
      value: params.targetObjectId,
      options: objectOptions,
      placeholder: 'Любой объект',
      loading: objectsLoading,
      onChange: (v) => apply({ targetObjectId: v }),
    },
    {
      kind: 'select',
      key: 'targetDepartmentId',
      label: 'Отдел',
      value: params.targetDepartmentId,
      options: departmentOptions ?? [],
      placeholder: 'Любой отдел',
      loading: departmentsLoading,
      onChange: (v) => apply({ targetDepartmentId: v }),
    },
    {
      kind: 'select',
      key: 'targetCounterpartyId',
      label: 'Контрагент',
      value: params.targetCounterpartyId,
      options: counterpartyGroups,
      placeholder: 'Любой контрагент',
      loading: counterpartiesLoading,
      onChange: (v) => apply({ targetCounterpartyId: v }),
    },
    {
      kind: 'select',
      key: 'targetArchive',
      label: 'Архивные учётки',
      value: params.targetArchive ?? 'include',
      options: archiveOptions,
      onChange: (v) => apply({ targetArchive: v ?? 'include' }),
    },
  ];

  return { filters, mobileFilters };
}
