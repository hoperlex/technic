import { Badge, Button, Dropdown, Space, Tag } from 'antd';
import { DeleteFilled, HistoryOutlined, MoreOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  EMAIL_VERIFICATION_ENABLED,
  requestRoleTitle,
  type UserAccountDto,
} from '@technic/contracts';
import { emailCell, isPendingRegistration, PhoneLink, roleTags } from '@entities/user-account';
import {
  actionsColumn,
  boolBadgeColumn,
  textColumn,
  UserAvatar,
  type ActionSheetItem,
} from '@shared/ui';

/** Archived-row command; its loading flag is drawn by the desktop row buttons only. */
export type ArchivedRowAction = ActionSheetItem & { loading?: boolean };

interface Options {
  actionsFor: (record: UserAccountDto) => ActionSheetItem[];
  archivedActionsFor: (record: UserAccountDto) => ArchivedRowAction[];
}

const menuOf = (actions: ActionSheetItem[]) => ({
  items: actions.map(({ key, label, danger, disabled }) => ({ key, label, danger, disabled })),
  onClick: ({ key }: { key: string }) => actions.find((action) => action.key === key)?.onClick(),
});

const archivedIcon = (key: string) => {
  if (key === 'history') return <HistoryOutlined />;
  if (key === 'restore') return <ReloadOutlined />;
  return <DeleteFilled />;
};

export function userAccountRegistryColumns({ actionsFor, archivedActionsFor }: Options) {
  return [
    textColumn<UserAccountDto>({
      key: 'email',
      title: 'Email',
      dataIndex: 'email',
      searchable: false,
      width: 220,
      // The foreign-domain mark sits next to the address rather than in its own column: it appears
      // on one row in ten, and a column for it would stand empty.
      render: (_value, record) => emailCell(record),
    }),
    textColumn<UserAccountDto>({
      key: 'fullName',
      title: 'ФИО',
      dataIndex: 'fullName',
      searchable: false,
      render: (_value, record) => (
        <Space size={8}>
          <UserAvatar name={record.fullName} size="small" />
          <span>{record.fullName}</span>
          {isPendingRegistration(record) ? (
            <Badge
              color="gold"
              text={
                record.requestedRole
                  ? `Заявка: ${requestRoleTitle(record.requestedRole)}`
                  : 'Заявка'
              }
            />
          ) : null}
        </Space>
      ),
    }),
    // Phone (ADR 0043): the administrator reviews a registration and calls from this very page, so
    // the number is in the list, not only in the form. No sorting — nobody orders by number, and
    // USER_SORT_FIELDS does not accept it.
    textColumn<UserAccountDto>({
      key: 'phone',
      title: 'Телефон',
      dataIndex: 'phone',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_value, record) => (record.phone ? <PhoneLink phone={record.phone} /> : '—'),
    }),
    // A role with add-ons (ADR 0086) is rendered by hand rather than with badgeColumn: that column
    // draws one tag per cell, and here there can be several. Sorting stays by role —
    // USER_SORT_FIELDS knows only it, and an add-on does not define row order.
    textColumn<UserAccountDto>({
      key: 'role',
      title: 'Роль',
      dataIndex: 'role',
      searchable: false,
      width: 200,
      render: (_value, record) => roleTags(record),
    }),
    textColumn<UserAccountDto>({
      key: 'scope',
      title: 'Область',
      dataIndex: 'constructionObjects',
      // One column for both axes rather than two: they are mutually exclusive (ADR 0040), and a
      // second one would be empty for everyone except department accounts. There is nothing to
      // sort a set by — "Object1, Object7" and "Object2" compare only by an arbitrary
      // representative (ADR 0039).
      sortable: false,
      searchable: false,
      // Departments are shown by code and objects by name — that is how they are called at work.
      // Full department names go to the hover hint: they are needed for checking, not recognition.
      render: (_value, record) => {
        if (record.departments.length > 0) {
          return (
            <span title={record.departments.map((department) => department.name).join(' · ')}>
              {record.departments.map((department) => department.code).join(' · ')}
            </span>
          );
        }
        return record.constructionObjects.length === 0
          ? '—'
          : record.constructionObjects.map((object) => object.name).join(' · ');
      },
    }),
    textColumn<UserAccountDto>({
      key: 'counterpartyName',
      title: 'Контрагент',
      dataIndex: 'counterpartyName',
      searchable: false,
      // The type next to the name: for an executor it answers "what does this account run".
      render: (_value, record) =>
        record.counterpartyName
          ? counterpartyTypeHasAccounts(record.counterpartyType)
            ? `${record.counterpartyName} — ${counterpartyTypeLabels[record.counterpartyType]}`
            : record.counterpartyName
          : '—',
    }),
    boolBadgeColumn<UserAccountDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      width: 120,
    }),
    // Email verification (ADR 0072): until the address is confirmed the registration must not be
    // activated, and the administrator should see that in the list rather than learn it from a
    // refusal. While verification is switched off (EMAIL_VERIFICATION_ENABLED) the column is
    // absent: it does not block activation, and "not confirmed" on a fresh registration would
    // claim something the portal no longer requires.
    ...(EMAIL_VERIFICATION_ENABLED
      ? [
          textColumn<UserAccountDto>({
            key: 'emailVerifiedAt',
            title: 'Адрес',
            dataIndex: 'emailVerifiedAt',
            sortable: false,
            searchable: false,
            width: 140,
            render: (_value, record) =>
              record.emailVerifiedAt ? (
                <Tag color="green">подтверждён</Tag>
              ) : (
                <Tag color="orange">не подтверждён</Tag>
              ),
          }),
        ]
      : []),
    // Registration date: the period filter works on it, and without the column the filtered rows
    // would look filtered by nothing visible.
    textColumn<UserAccountDto>({
      key: 'createdAt',
      title: 'Зарегистрирован',
      dataIndex: 'createdAt',
      searchable: false,
      width: 150,
      render: (_value, record) => dayjs(record.createdAt).format('DD.MM.YYYY'),
    }),
    actionsColumn<UserAccountDto>((record) => {
      if (!record.deletedAt) {
        return (
          <Dropdown menu={menuOf(actionsFor(record))} trigger={['click']}>
            <Button size="small" icon={<MoreOutlined />} />
          </Dropdown>
        );
      }
      // Archived row (ADR 0063): icon buttons instead of a menu. They draw the command's loading
      // state, which also swallows a repeated click while the request is in flight.
      return (
        <Space size={4}>
          <Tag>в архиве</Tag>
          {archivedActionsFor(record).map((action) => (
            <Button
              key={action.key}
              size="small"
              danger={action.danger}
              disabled={action.disabled}
              loading={action.loading}
              icon={archivedIcon(action.key)}
              title={action.label}
              onClick={action.onClick}
            />
          ))}
        </Space>
      );
    }, 140),
  ];
}
