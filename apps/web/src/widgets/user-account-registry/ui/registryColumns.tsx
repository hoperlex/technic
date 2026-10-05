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
    textColumn<UserAccountDto>({
      key: 'phone',
      title: 'Телефон',
      dataIndex: 'phone',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_value, record) => (record.phone ? <PhoneLink phone={record.phone} /> : '—'),
    }),
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
      sortable: false,
      searchable: false,
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
