import { Tag, Typography } from 'antd';
import { formatSnils, type DriverDto } from '@technic/contracts';
import { documentBadge, documentCardLines, documentPrimary } from '@entities/driver';
import { PhoneLink } from '@entities/user-account';
import type { CardConfig } from '@shared/ui';
import type { DriverRegistryModel } from '../model/useDriverRegistry';
import type { DriverRegistryActions } from '../model/types';

/** Mobile card mirrors the desktop registry without hiding document defects behind tooltips. */
export function driverRegistryCard(
  model: DriverRegistryModel,
  actions: DriverRegistryActions,
): CardConfig<DriverDto> {
  return {
    title: (record) => record.fullName,
    badge: (record) => (record.deletedAt ? <Tag>в архиве</Tag> : documentBadge(record)),
    primary: documentPrimary,
    lines: [
      (record) =>
        record.email ? (
          `Email: ${record.email}`
        ) : (
          <Typography.Text type="secondary">Email не указан</Typography.Text>
        ),
      (record) =>
        record.phone ? (
          <>
            Телефон: <PhoneLink phone={record.phone} />
          </>
        ) : (
          <Typography.Text type="secondary">Телефон не указан</Typography.Text>
        ),
      (record) => (record.jobTitle ? `Должность: ${record.jobTitle}` : null),
      ...documentCardLines(model.visibleTypes),
      (record) => (record.personnelNo ? `Таб. № ${record.personnelNo}` : null),
      (record) => (record.snils ? `СНИЛС ${formatSnils(record.snils)}` : null),
    ],
    onOpen: actions.canWrite
      ? (record) => (record.deletedAt ? undefined : actions.edit(record))
      : undefined,
    actions: (record) => {
      if (!actions.canWrite) return [];
      if (record.deletedAt) {
        return actions.purge.allowed
          ? [
              {
                key: 'purge',
                label: 'Удалить окончательно',
                danger: true,
                onClick: () => actions.purge.confirm(record.id, record.fullName),
              },
            ]
          : [];
      }
      return [
        { key: 'edit', label: 'Редактировать', onClick: () => actions.edit(record) },
        {
          key: 'license',
          label: 'Заменить удостоверение',
          onClick: () => actions.replaceDocument(record),
        },
        { key: 'delete', label: 'Удалить', danger: true, onClick: () => actions.remove(record) },
      ];
    },
  };
}
