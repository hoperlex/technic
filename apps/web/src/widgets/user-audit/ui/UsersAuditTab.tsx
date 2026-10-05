import { useEffect, useState } from 'react';
import { Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { roleColors, roleLabels, type AuditEntryDto } from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { DataTable, PageTableLayout, textColumn, type CardConfig } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { formatDateTime, useListParams } from '@shared/lib';
import { auditApi, userAuditKeys } from '@entities/user-audit';
import { AuditEventCell } from './UserAuditChanges';
import { useUserAuditFilters, type AuditFilterParams } from './UserAuditFilters';
import { UserAuditPathDrawer, type AuditTarget } from './UserAuditPathDrawer';

/**
 * Account change log (ADR 0088, ADR 0109): what happened to an account, who did it and when.
 *
 * The screen answers review questions — "who gave this person the dispatcher role", "who was given
 * SU-10 last Tuesday", "what happened to an account that no longer exists". It used to show a list
 * of administrator actions without detail: edits of objects, departments and contacts arrived as a
 * single "Account changed" line, and there was no way to filter the log by account data.
 *
 * Two things are absent on purpose. The action code is never shown: the line is built by the
 * contracts describer (`describeAuditEntry`, `auditChangesOf`) — duplicated in markup, the wording
 * would drift with the first new account field. And there is no event card: the row is its own
 * card, and the connected story is the account path — the drawer opened from the row.
 */

/**
 * Period bounds are instants, not days: entries are stored to the second, and "on August 10" is the
 * span from midnight to midnight computed in the portal time zone (Moscow). Without the time zone
 * the bound would shift by hours: the server has its UTC, the browser has its own.
 */
const dayStart = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).startOf('day').toISOString() : undefined;
const dayEnd = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).endOf('day').toISOString() : undefined;

/** Whom the action targeted: name, address and what the account is now. Empty — it was purged. */
function targetCell(entry: AuditEntryDto) {
  if (!entry.targetName && !entry.targetEmail) return '—';
  return (
    <Space orientation="vertical" size={0}>
      <span>{entry.targetName ?? '—'}</span>
      {entry.targetEmail ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {entry.targetEmail}
        </Typography.Text>
      ) : null}
      <Space size={4} wrap>
        {entry.targetRole ? (
          <Tag color={roleColors[entry.targetRole]} style={{ marginInlineEnd: 0 }}>
            {roleLabels[entry.targetRole]}
          </Tag>
        ) : null}
        {entry.targetDeletedAt ? (
          <Tag color="red" style={{ marginInlineEnd: 0 }}>
            в архиве
          </Tag>
        ) : null}
      </Space>
    </Space>
  );
}

export function UsersAuditTab() {
  // Search goes by people — the account's name and address, the administrator's name — not by
  // table columns: the log has no searchable columns at all.
  const { params, setParams, setSort, onTableChange } = useListParams<AuditFilterParams>(
    {},
    { searchKeys: [] },
  );

  /** Whose path is open in the drawer; `null` means the drawer is closed. */
  const [path, setPath] = useState<AuditTarget | null>(null);
  /**
   * Which account narrows the log. It lives here rather than coming from outside: reviewing a
   * particular person is now done by the path drawer — from both the account list and a log row —
   * and this filter stays what it always was, an ordinary narrowing of the feed.
   */
  const [target, setTarget] = useState<AuditTarget | null>(null);

  /** Any filter change returns to page one: the same page over a different set is other records. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  /** Changing the person is a filter change like any other: the page returns to the first one. */
  useEffect(() => {
    setParams((p) => ({ ...p, page: 1 }));
  }, [target?.id, setParams]);

  const query = {
    ...params,
    from: dayStart(params.from),
    to: dayEnd(params.to),
    // The target is the pair "entity type and id": the log is shared by the whole portal, and
    // without the type the filter would also pick up a record of another kind with a matching id.
    entityType: target ? 'user' : undefined,
    entityId: target?.id,
  };
  const { data, isFetching } = useQuery({
    queryKey: userAuditKeys.list(query),
    queryFn: () => auditApi.list(query),
  });

  const { filters, mobileFilters } = useUserAuditFilters({
    params,
    apply: applyFilter,
    target,
    onTargetChange: setTarget,
  });

  const openPath = (entry: AuditEntryDto) => {
    if (!entry.entityId) return;
    setPath({ id: entry.entityId, name: entry.targetName ?? entry.targetEmail ?? '' });
  };

  const columns = [
    textColumn<AuditEntryDto>({
      key: 'createdAt',
      title: 'Когда',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (_v, r) => formatDateTime(r.createdAt),
    }),
    // The account is the second column, not the last: the screen is about what happened to people
    // and is read by them — the "who" column answers a different question, by whom it was done.
    textColumn<AuditEntryDto>({
      key: 'target',
      title: 'Учётная запись',
      dataIndex: 'targetName',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => targetCell(r),
    }),
    // Sorting is by action code while a human-readable line is shown: identical events cluster
    // together, and reading them in a row ("all rejections this month") is easier than picking
    // them one by one with a filter.
    textColumn<AuditEntryDto>({
      key: 'action',
      title: 'Что изменилось',
      dataIndex: 'action',
      searchable: false,
      render: (_v, r) => <AuditEventCell entry={r} />,
    }),
    textColumn<AuditEntryDto>({
      key: 'actorName',
      title: 'Кто изменил',
      dataIndex: 'actorName',
      // No sorting: the server orders the log by time and action code, while the author's name
      // comes from a join — `AUDIT_SORT_FIELDS` does not accept it.
      sortable: false,
      searchable: false,
      width: 220,
      // Empty when the author's account was purged, or when the person acted before signing in
      // (address confirmation, password reset from an email link).
      render: (_v, r) => r.actorName ?? '—',
    }),
  ];

  /**
   * A log row as a card on the phone (ADR 0042). The title is the account: the list is read by
   * people, while the event time goes to a subline, as does the author of the edit.
   */
  const card: CardConfig<AuditEntryDto> = {
    title: (r) => r.targetName ?? r.targetEmail ?? '—',
    badge: (r) => (r.targetDeletedAt ? <Tag color="red">в архиве</Tag> : null),
    primary: (r) => <AuditEventCell entry={r} />,
    lines: [
      (r) => formatDateTime(r.createdAt),
      (r) => (r.actorName ? `Кто: ${r.actorName}` : null),
    ],
    onOpen: openPath,
  };

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'ФИО или адрес',
          onChange: (v) => applyFilter({ search: v }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { createdAt: 'Когда' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<AuditEntryDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={openPath}
        onChange={onTableChange}
      />
      <UserAuditPathDrawer target={path} onClose={() => setPath(null)} />
    </PageTableLayout>
  );
}
