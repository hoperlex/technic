import { Tag, Typography } from 'antd';
import { formatSnils, type DriverDto } from '@technic/contracts';
import { documentBadge, documentCardLines, documentPrimary } from '@entities/driver';
import { PhoneLink } from '@entities/user-account';
import type { CardConfig } from '@shared/ui';
import type { DriverRegistryModel } from '../model/useDriverRegistry';
import type { DriverRegistryActions } from '../model/types';

/**
 * Driver card on a phone (ADR 0042): the name and the credential state are what the directory is
 * opened for. A document defect is a line, not a tag tooltip: tooltips do not open on touch
 * (ADR 0030 item 6).
 *
 * The header speaks about the credential required by the job title: an excavator operator is asked
 * for a tractor certificate, and an empty driver license has no business at the top. The other kind
 * is visible in lines below — but only while the registry is not filtered by job title
 * (visibleTypes).
 */
export function driverRegistryCard(
  model: DriverRegistryModel,
  actions: DriverRegistryActions,
): CardConfig<DriverDto> {
  return {
    title: (record) => record.fullName,
    // Archive first: for a removed card the document state no longer decides anything.
    badge: (record) => (record.deletedAt ? <Tag>в архиве</Tag> : documentBadge(record)),
    primary: documentPrimary,
    lines: [
      // Contacts come first, like the second column on desktop: trip-task mailing and calls need
      // them more than other requisites. Absence is written as a word rather than an omitted line:
      // a card has no visible empty cell, and «no email» means the trip task will not reach them.
      (record) =>
        record.email ? (
          `Email: ${record.email}`
        ) : (
          <Typography.Text type="secondary">Email не указан</Typography.Text>
        ),
      // The number is a link: the directory is read as cards on a phone, and calling is why the
      // number is here (ADR 0030).
      (record) =>
        record.phone ? (
          <>
            Телефон: <PhoneLink phone={record.phone} />
          </>
        ) : (
          <Typography.Text type="secondary">Телефон не указан</Typography.Text>
        ),
      // Job title before documents: it explains which paper is asked of the person, and without it
      // «нет УТМ» on an operator's card reads as a portal error.
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
