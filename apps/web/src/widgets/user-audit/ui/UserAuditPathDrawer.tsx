import { Drawer, Empty, Skeleton, Space, Tag, Timeline, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  roleAddonLabels,
  roleColors,
  roleLabels,
  type AuditEntryDto,
  type UserAccountDto,
} from '@technic/contracts';
import { ViewFields, type ViewField } from '@shared/ui';
import { formatDateTime, useIsMobile } from '@shared/lib';
import { usersApi } from '@entities/user-account';
import { auditApi, userAuditKeys } from '@entities/user-audit';
import { AuditEventCell } from './UserAuditChanges';

/**
 * The path of one account (ADR 0109): from the registration request to what the account is today.
 *
 * A top-down timeline rather than a table: the question to this drawer is "how did the person
 * arrive at their current access", so events are read in sequence, not compared. For the same
 * reason the order is the reverse of the log — oldest first: a path is read from its start.
 *
 * The path ends with the "now" state, and that is not decoration. The last event says what was
 * changed but not what the person has as a result: one removed add-on and the four that remain are
 * different news, and the second cannot be reconstructed from a single log line.
 */

/** The tail of a long history is no longer useful to a person — same as in request history. */
const PATH_LIMIT = 200;

/** What the account became: role, access, archive — three bubbles, as in the account list. */
function StateTags({ user }: { user: UserAccountDto }) {
  return (
    <Space size={4} wrap>
      {user.role ? (
        <Tag color={roleColors[user.role]}>{roleLabels[user.role]}</Tag>
      ) : (
        <Tag>без роли</Tag>
      )}
      <Tag color={user.isActive ? 'green' : 'default'}>
        {user.isActive ? 'доступ открыт' : 'доступ закрыт'}
      </Tag>
      {user.deletedAt ? <Tag color="red">в архиве</Tag> : null}
    </Space>
  );
}

/** The account as of today; empty fields are skipped — "—" on five lines in a row does not read. */
function currentFields(user: UserAccountDto): ViewField[] {
  const fields: ViewField[] = [
    { key: 'state', label: 'Сейчас', full: true, children: <StateTags user={user} /> },
    { key: 'email', label: 'Адрес', full: true, children: user.email },
  ];
  if (user.constructionObjects.length > 0) {
    fields.push({
      key: 'objects',
      label: 'Объекты',
      full: true,
      children: user.constructionObjects.map((o) => o.name).join(', '),
    });
  }
  if (user.departments.length > 0) {
    fields.push({
      key: 'departments',
      label: 'Отделы',
      full: true,
      children: user.departments.map((d) => d.name).join(', '),
    });
  }
  if (user.counterpartyName) {
    fields.push({ key: 'counterparty', label: 'Контрагент', children: user.counterpartyName });
  }
  if (user.addons.length > 0) {
    fields.push({
      key: 'addons',
      label: 'Надстройки',
      full: true,
      children: user.addons.map((a) => roleAddonLabels[a]).join(', '),
    });
  }
  if (user.person) {
    fields.push({ key: 'person', label: 'Работник', children: user.person.fullName });
  }
  return fields;
}

/** A path event: when and what was done, and who — on a separate line below. */
function pathItem(entry: AuditEntryDto) {
  return {
    key: entry.id,
    children: (
      <Space orientation="vertical" size={0}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDateTime(entry.createdAt)}
        </Typography.Text>
        <AuditEventCell entry={entry} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {/* Empty when the author was purged, or when the person did it themselves before signing
              in: confirmed the address, reset the password from an email link. */}
          {entry.actorName ?? 'без администратора'}
        </Typography.Text>
      </Space>
    ),
  };
}

/**
 * The account whose path is shown: the id for queries and the name for the title until the card
 * loads. The drawer is opened from a row that already has the name, so there is no reason to show
 * a blank instead.
 *
 * Declared here rather than in a sub-tab: whose path is viewed is the drawer's own concern, and it
 * is opened from two places (the log and the account list).
 */
export interface AuditTarget {
  id: string;
  name: string;
}

interface Props {
  /** Whose path is shown; `null` means the drawer is closed. */
  target: AuditTarget | null;
  onClose: () => void;
}

export function UserAuditPathDrawer({ target, onClose }: Props) {
  const isMobile = useIsMobile();
  const userId = target?.id ?? null;
  const open = userId !== null;

  const { data: card, isFetching: cardLoading } = useQuery({
    queryKey: userAuditKeys.path(userId ?? 'none'),
    queryFn: () => usersApi.get(userId!),
    enabled: open,
  });
  const pathQuery = {
    entityType: 'user',
    entityId: userId ?? '',
    page: 1,
    pageSize: PATH_LIMIT,
    sortBy: 'createdAt',
    // Oldest first: a path is read from its start, not from the latest edit.
    sortOrder: 'asc',
  };
  const { data: events, isFetching: eventsLoading } = useQuery({
    queryKey: userAuditKeys.list(pathQuery),
    queryFn: () => auditApi.list(pathQuery),
    enabled: open,
  });

  const user = card?.user;
  const items = (events?.items ?? []).map(pathItem);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      // Full screen on a phone and a wide panel on desktop: an event has three or four value lines,
      // and a narrow panel would wrap each by syllable. Width is set with `size` — `width` is
      // deprecated in antd 6, and the neighbouring vehicle-type card uses the same prop.
      size={isMobile ? '100%' : 520}
      title={user?.fullName ?? target?.name ?? 'Путь учётной записи'}
      destroyOnHidden
    >
      {cardLoading && !user ? (
        <Skeleton active />
      ) : user ? (
        <ViewFields items={currentFields(user)} />
      ) : (
        // The account was purged: its life events remain in the log, but the card is gone.
        <Typography.Text type="secondary">Учётная запись удалена насовсем</Typography.Text>
      )}
      <div style={{ marginTop: 16 }}>
        {eventsLoading && items.length === 0 ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : items.length > 0 ? (
          <Timeline items={items} />
        ) : (
          <Empty description="Событий по этой учётной записи нет" />
        )}
      </div>
    </Drawer>
  );
}
