import { Space, Tag } from 'antd';
import {
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  requestRoleTitle,
  type UserAccountDto,
} from '@technic/contracts';
import { emailCell, isPendingRegistration, PhoneLink, roleTags } from '@entities/user-account';
import { UserAvatar, type ActionSheetItem, type CardConfig } from '@shared/ui';
import type { ArchivedRowAction } from './registryColumns';

interface Options {
  actionsFor: (record: UserAccountDto) => ActionSheetItem[];
  archivedActionsFor: (record: UserAccountDto) => ArchivedRowAction[];
  edit: (record: UserAccountDto) => void;
}

/** The mobile card carries the same fields and commands as the desktop registry row. */
export function userAccountRegistryCard({
  actionsFor,
  archivedActionsFor,
  edit,
}: Options): CardConfig<UserAccountDto> {
  return {
    title: (record) => (
      <Space size={8}>
        <UserAvatar name={record.fullName} size="small" />
        <span>{record.fullName}</span>
      </Space>
    ),
    badge: (record) =>
      isPendingRegistration(record) ? (
        <Tag color="gold">Ждёт активации</Tag>
      ) : (
        <Tag color={record.isActive ? 'green' : 'default'}>
          {record.isActive ? 'Активен' : 'Отключён'}
        </Tag>
      ),
    primary: (record) => roleTags(record),
    lines: [
      (record) => emailCell(record),
      (record) => (record.phone ? <PhoneLink phone={record.phone} /> : null),
      (record) => {
        const places =
          record.departments.length > 0 ? record.departments : record.constructionObjects;
        return places.length > 0 ? places.map((place) => place.name).join(' · ') : null;
      },
      (record) =>
        record.counterpartyName
          ? counterpartyTypeHasAccounts(record.counterpartyType)
            ? `${record.counterpartyName} — ${counterpartyTypeLabels[record.counterpartyType]}`
            : record.counterpartyName
          : null,
      (record) =>
        record.requestedRole ? `Пожелание: ${requestRoleTitle(record.requestedRole)}` : null,
      (record) => (record.deletedAt ? 'В архиве' : null),
    ],
    onOpen: (record) => (record.deletedAt ? undefined : edit(record)),
    actions: (record) => (record.deletedAt ? archivedActionsFor(record) : actionsFor(record)),
  };
}
