import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OfficeEquipmentDto } from '@technic/contracts';
import { isCurrentPickAnswer, QUERY_PROFILE } from '@shared/config';
import { withSavedOption } from '@shared/lib';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import type { OfficeEquipmentFilterParams } from './OfficeEquipmentFilters';

/** A filter opens its own directory, while the card form observes all three at PICK age. */
export function useOfficeEquipmentChoices({
  params,
  record,
  formOpen,
  typesOpen,
  modelsOpen,
}: {
  params: OfficeEquipmentFilterParams;
  record: OfficeEquipmentDto | null;
  formOpen: boolean;
  typesOpen: boolean;
  modelsOpen: boolean;
}) {
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const onOpen = (key: string) => setOpened((previous) => new Set(previous).add(key));
  const types = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    ...(formOpen ? QUERY_PROFILE.PICK : {}),
    enabled:
      formOpen ||
      typesOpen ||
      modelsOpen ||
      opened.has('equipmentTypeId') ||
      !!params.equipmentTypeId,
  });
  // Historical cards and filters keep inactive sites named after closure.
  const objects = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    ...(formOpen ? QUERY_PROFILE.PICK : {}),
    enabled: formOpen || opened.has('objectId') || !!params.objectId,
  });
  const departments = useQuery({
    ...departmentOptionsQuery(),
    ...(formOpen ? QUERY_PROFILE.PICK : {}),
    enabled: formOpen || opened.has('departmentId') || !!params.departmentId,
  });

  return {
    onOpen,
    typesLoading: types.isLoading,
    typesCurrent: formOpen && isCurrentPickAnswer(types),
    objectsCurrent: formOpen && isCurrentPickAnswer(objects),
    typeOptions: withSavedOption(types.data ?? [], {
      id: record?.type.id,
      name: record?.type.name,
    }),
    objectOptions: withSavedOption(objects.data ?? [], {
      id: record?.object.id,
      name: record ? `${record.object.code} — ${record.object.name}` : undefined,
    }),
    departmentOptions: withSavedOption(departments.data ?? [], {
      id: record?.department?.id,
      name: record?.department
        ? `${record.department.code} — ${record.department.name}`
        : undefined,
    }),
  };
}
