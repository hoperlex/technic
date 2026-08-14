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
import { useIsMobile } from '@shared/lib';
import { userAuditKeys } from '@entities/user-audit';
import { auditApi, usersApi } from '../../api/resources';
import { formatDateTime } from '../../utils/format';
import { AuditEventCell } from './UserAuditChanges';

/**
 * Путь одной учётной записи (ADR 0109): от заявки на регистрацию до того, чем учётка стала
 * сегодня.
 *
 * Лентой сверху вниз, а не таблицей: вопрос к этой панели — «как человек дошёл до нынешнего
 * доступа», и события здесь читают подряд, а не сравнивают между собой. По той же причине порядок
 * обратный ленте журнала — от старого к новому: путь читается с начала.
 *
 * Заканчивается путь состоянием «сейчас», и это не украшение. Последнее событие отвечает, что
 * поменяли, но не отвечает, что в итоге у человека есть: снятая надстройка и оставшиеся у него
 * четыре — разные новости, а по одной строке журнала вторую не восстановить.
 */

/** Хвост длинной истории человеку уже не нужен — как и в истории заявки. */
const PATH_LIMIT = 200;

/** Кем учётка стала: роль, доступ, архив — тремя баблами, как в списке учёток. */
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

/** Чем учётка стала к сегодняшнему дню; пустые поля пропущены — «—» в пяти строках подряд не читается. */
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

/** Событие пути: когда и что сделали, кто — отдельной строкой снизу. */
function pathItem(entry: AuditEntryDto) {
  return {
    key: entry.id,
    children: (
      <Space direction="vertical" size={0}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDateTime(entry.createdAt)}
        </Typography.Text>
        <AuditEventCell entry={entry} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {/* Пусто — автора удалили насовсем либо человек сделал это сам до входа: подтвердил
              адрес, восстановил пароль по ссылке из письма. */}
          {entry.actorName ?? 'без администратора'}
        </Typography.Text>
      </Space>
    ),
  };
}

interface Props {
  /** Чей путь показан; `null` — панель закрыта. */
  userId: string | null;
  /** Имя для заголовка, пока карточка не загрузилась: панель открывают из строки, где оно уже есть. */
  fallbackName?: string | null;
  onClose: () => void;
}

export function UserAuditPathDrawer({ userId, fallbackName, onClose }: Props) {
  const isMobile = useIsMobile();
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
    // От старого к новому: путь читают с начала, а не с последней правки.
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
      // Во весь экран на телефоне и широкой полосой на десктопе: в событии по три-четыре строки
      // значений, и в узкой панели каждая переносилась бы по слогам.
      width={isMobile ? '100%' : 520}
      title={user?.fullName ?? fallbackName ?? 'Путь учётной записи'}
      destroyOnHidden
    >
      {cardLoading && !user ? (
        <Skeleton active />
      ) : user ? (
        <ViewFields items={currentFields(user)} />
      ) : (
        // Учётку удалили насовсем: события её жизни в журнале остались, а карточки уже нет.
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
