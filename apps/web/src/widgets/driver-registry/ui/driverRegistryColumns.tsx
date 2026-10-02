import { Button, Space, Tag, Typography, type TableColumnType } from 'antd';
import { DeleteFilled, DeleteOutlined, EditOutlined, IdcardOutlined } from '@ant-design/icons';
import { formatSnils, type DriverDto } from '@technic/contracts';
import { documentColumns } from '@entities/driver';
import { PhoneLink } from '@entities/user-account';
import { actionsColumn, textColumn } from '@shared/ui';
import type { DriverRegistryModel } from '../model/useDriverRegistry';
import type { DriverRegistryActions } from '../model/types';

/** Desktop columns and actions for the driver registry. */
export function driverRegistryColumns(
  model: DriverRegistryModel,
  actions: DriverRegistryActions,
): TableColumnType<DriverDto>[] {
  return [
    textColumn<DriverDto>({ key: 'fullName', title: 'ФИО', dataIndex: 'fullName' }),
    textColumn<DriverDto>({
      key: 'contacts',
      title: 'Контакты',
      dataIndex: 'email',
      sortable: false,
      width: 220,
      render: (_value, record) => (
        <>
          {record.email || <Typography.Text type="secondary">email не указан</Typography.Text>}
          <br />
          {record.phone ? (
            <PhoneLink phone={record.phone} />
          ) : (
            <Typography.Text type="secondary">телефон не указан</Typography.Text>
          )}
        </>
      ),
    }),
    textColumn<DriverDto>({
      key: 'snils',
      title: 'СНИЛС',
      dataIndex: 'snils',
      width: 160,
      render: (_value, record) => formatSnils(record.snils),
    }),
    textColumn<DriverDto>({
      key: 'personnelNo',
      title: 'Табельный',
      dataIndex: 'personnelNo',
      width: 130,
    }),
    textColumn<DriverDto>({
      key: 'jobTitle',
      title: 'Должность',
      dataIndex: 'jobTitle',
      sortable: false,
      searchable: false,
      width: 180,
      render: (_value, record) =>
        record.jobTitle || <Typography.Text type="secondary">—</Typography.Text>,
    }),
    ...model.visibleTypes.flatMap((type) => documentColumns(type)),
    ...(actions.canWrite
      ? [
          actionsColumn<DriverDto>((record) =>
            record.deletedAt ? (
              <Space>
                <Tag>в архиве</Tag>
                {actions.purge.allowed ? (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteFilled />}
                    title="Удалить окончательно"
                    loading={actions.purge.pending}
                    onClick={() => actions.purge.confirm(record.id, record.fullName)}
                  />
                ) : null}
              </Space>
            ) : (
              <Space>
                <Button size="small" icon={<EditOutlined />} onClick={() => actions.edit(record)} />
                <Button
                  size="small"
                  icon={<IdcardOutlined />}
                  title="Заменить удостоверение"
                  onClick={() => actions.replaceDocument(record)}
                />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => actions.remove(record)}
                />
              </Space>
            ),
          ),
        ]
      : []),
  ];
}
