import { Button, Space, Tag, Typography, type TableColumnsType } from 'antd';
import { DeleteFilled, DeleteOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  type CounterpartyDto,
  counterpartyTypeColors,
  counterpartyTypeLabels,
} from '@technic/contracts';
import {
  actionsColumn,
  badgeColumn,
  boolBadgeColumn,
  textColumn,
  type CardConfig,
} from '@shared/ui';
import type { CounterpartyRegistryActions } from '../model/types';

/** Build desktop columns with every write behind an explicit feature action port. */
export function counterpartyRegistryColumns(
  actions: CounterpartyRegistryActions,
): TableColumnsType<CounterpartyDto> {
  return [
    textColumn<CounterpartyDto>({
      key: 'name',
      title: 'Наименование',
      dataIndex: 'name',
      // Aliases stay directly below the legal name because operators search by either one.
      render: (_value, record) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{record.name}</div>
          {record.synonyms.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.synonyms.join(' · ')}
            </Typography.Text>
          )}
        </div>
      ),
    }),
    textColumn<CounterpartyDto>({ key: 'inn', title: 'ИНН', dataIndex: 'inn', width: 150 }),
    badgeColumn<CounterpartyDto>({
      key: 'type',
      title: 'Тип',
      dataIndex: 'type',
      labels: counterpartyTypeLabels,
      colors: counterpartyTypeColors,
      width: 210,
    }),
    textColumn<CounterpartyDto>({
      key: 'objects',
      title: 'Объекты',
      dataIndex: 'objects',
      sortable: false,
      searchable: false,
      width: 220,
      // Only waste operators own site bindings; an empty cell is intentional for every other type.
      render: (_value, record) =>
        record.objects.length === 0 ? '—' : record.objects.map((object) => object.code).join(' · '),
    }),
    textColumn<CounterpartyDto>({
      key: 'email',
      title: 'Email',
      dataIndex: 'email',
      searchable: false,
      width: 220,
      ellipsis: true,
      // Most types legitimately have no address. The column reveals missing shared mailboxes for
      // service companies before the first notification silently has nobody to reach (ADR 0153).
      render: (_value, record) => record.email || '—',
    }),
    textColumn<CounterpartyDto>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      searchable: false,
      ellipsis: true,
    }),
    boolBadgeColumn<CounterpartyDto>({
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      trueText: 'Да',
      falseText: 'Нет',
      filters: true,
      width: 120,
    }),
    actionsColumn<CounterpartyDto>(
      (record) =>
        record.deletedAt ? (
          <Space size={4}>
            <Tag>в архиве</Tag>
            {actions.canRestore ? (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                title="Восстановить"
                onClick={() => actions.restore(record.id)}
              />
            ) : null}
            {actions.purge.allowed ? (
              <Button
                size="small"
                danger
                icon={<DeleteFilled />}
                title="Удалить окончательно"
                loading={actions.purge.pending}
                onClick={() => actions.purge.confirm(record.id, record.name)}
              />
            ) : null}
          </Space>
        ) : (
          <Space size={4}>
            <Button size="small" icon={<EditOutlined />} onClick={() => actions.edit(record)} />
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => actions.remove(record)}
            />
          </Space>
        ),
      130,
    ),
  ];
}

/** Phone cards preserve the same identity, archive state and action set as desktop rows. */
export function counterpartyRegistryCard(
  actions: CounterpartyRegistryActions,
): CardConfig<CounterpartyDto> {
  return {
    title: (record) => record.name,
    // Without an archive badge a removed phone card would look live while exposing other actions.
    badge: (record) =>
      record.deletedAt ? (
        <Tag>в архиве</Tag>
      ) : (
        <Tag color={record.isActive ? 'green' : 'default'}>{record.isActive ? 'Да' : 'Нет'}</Tag>
      ),
    primary: (record) => (
      <Tag color={counterpartyTypeColors[record.type]}>{counterpartyTypeLabels[record.type]}</Tag>
    ),
    lines: [
      (record) => (record.synonyms.length > 0 ? record.synonyms.join(' · ') : null),
      (record) => (record.inn ? `ИНН ${record.inn}` : null),
      (record) =>
        record.objects.length > 0
          ? `Объекты: ${record.objects.map((object) => object.code).join(' · ')}`
          : null,
      (record) => record.email || null,
      (record) => record.comment || null,
    ],
    onOpen: (record) => (record.deletedAt ? undefined : actions.edit(record)),
    actions: (record) =>
      record.deletedAt
        ? [
            ...(actions.canRestore
              ? [
                  {
                    key: 'restore',
                    label: 'Восстановить',
                    onClick: () => actions.restore(record.id),
                  },
                ]
              : []),
            ...(actions.purge.allowed
              ? [
                  {
                    key: 'purge',
                    label: 'Удалить окончательно',
                    danger: true,
                    onClick: () => actions.purge.confirm(record.id, record.name),
                  },
                ]
              : []),
          ]
        : [
            { key: 'edit', label: 'Редактировать', onClick: () => actions.edit(record) },
            {
              key: 'delete',
              label: 'Удалить',
              danger: true,
              onClick: () => actions.remove(record),
            },
          ],
  };
}
