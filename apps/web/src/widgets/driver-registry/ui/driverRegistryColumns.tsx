import { Button, Space, Tag, Typography, type TableColumnType } from 'antd';
import { DeleteFilled, DeleteOutlined, EditOutlined, IdcardOutlined } from '@ant-design/icons';
import { formatSnils, type DriverDto } from '@technic/contracts';
import { documentColumns } from '@entities/driver';
import { PhoneLink } from '@entities/user-account';
import { actionsColumn, textColumn } from '@shared/ui';
import type { DriverRegistryModel } from '../model/useDriverRegistry';
import type { DriverRegistryActions } from '../model/types';

/**
 * Desktop columns and actions for the driver registry.
 *
 * The current credential is shown in the row: whether the person can go on a trip is decided by
 * it, and expired documents must be visible as a list, not only inside the card. Each credential
 * kind (driver license, tractor operator certificate) gets its own column pair: a loader operator
 * holds «C» in the tractor certificate, and letters merged into one column would read as a truck
 * permit. The job-title filter drops the irrelevant pair (visibleTypes, ADR 0095).
 */
export function driverRegistryColumns(
  model: DriverRegistryModel,
  actions: DriverRegistryActions,
): TableColumnType<DriverDto>[] {
  return [
    textColumn<DriverDto>({ key: 'fullName', title: 'ФИО', dataIndex: 'fullName' }),
    // Second column, right after the name: for trip-task mailing and calling the driver, contacts
    // are asked for more often than SNILS or personnel number, and empty cells at the row start are
    // seen without scrolling. Email and phone share one cell in two lines — they are read together,
    // the question is one: «how to reach this driver». No sorting: the column answers «are there
    // contacts», and sorting it would just shuffle empty rows. Absence is written as a word: an
    // empty cell reads as «not checked», while «не указан» means «nowhere to call, and known».
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
    // Job title sits next to the personnel number: it comes from the same HR data and tells which
    // credential to ask of the person. No sorting: there are about ten titles, and the filter
    // replaces ordering while also hiding irrelevant columns.
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
