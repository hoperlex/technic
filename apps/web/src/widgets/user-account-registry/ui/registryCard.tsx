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

/**
 * Account card on the phone (ADR 0042). The title is the full name: the list is read by people, and
 * the email comes second. A pending registration is marked right in the header: in the shared list
 * it lies among employees and differs only by that.
 */
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
    // Role and add-ons (ADR 0086) with the same tags as the table: the phone card must not tell
    // less about a person than the desktop row.
    primary: (record) => roleTags(record),
    lines: [
      (record) => emailCell(record),
      // The number is tappable: the card is read on a phone, and a call is why the number is kept.
      (record) => (record.phone ? <PhoneLink phone={record.phone} /> : null),
      (record) => {
        // Scope: departments (ADR 0040) or objects — whichever the account has filled.
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
    // An archived card does not open for editing, but its commands are the same as in the table
    // (ADR 0063): the modes must not diverge, otherwise restore would exist only with a mouse.
    onOpen: (record) => (record.deletedAt ? undefined : edit(record)),
    actions: (record) => (record.deletedAt ? archivedActionsFor(record) : actionsFor(record)),
  };
}
