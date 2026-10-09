import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OFFICE_EQUIPMENT_STATES,
  OFFICE_EQUIPMENT_WARRANTY_FILTERS,
  officeEquipmentStateLabels,
  WARRANTY_EXPIRING_DAYS,
  type OfficeEquipmentWarrantyFilter,
} from '@technic/contracts';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';

const warrantyFilterLabels: Record<OfficeEquipmentWarrantyFilter, string> = {
  active: 'Действует',
  expiring: `Истекает (${WARRANTY_EXPIRING_DAYS} дней)`,
  expired: 'Истекла',
};

export const warrantyOptions = OFFICE_EQUIPMENT_WARRANTY_FILTERS.map((value) => ({
  value,
  label: warrantyFilterLabels[value],
}));

export const stateOptions = OFFICE_EQUIPMENT_STATES.map((value) => ({
  value,
  label: officeEquipmentStateLabels[value],
}));

/** Restored values load their labels immediately; empty filters wait for their first opening. */
export function useEquipmentFilterChoices(params: {
  objectId?: string;
  equipmentTypeId?: string;
  departmentId?: string;
}) {
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const onOpen = (key: string) => setOpened((previous) => new Set(previous).add(key));
  const wanted = (key: string, value?: string) => opened.has(key) || !!value;
  const typesEnabled = wanted('equipmentTypeId', params.equipmentTypeId);
  const objectsEnabled = wanted('objectId', params.objectId);
  const departmentsEnabled = wanted('departmentId', params.departmentId);
  const types = useQuery({ ...officeEquipmentTypeOptionsQuery(), enabled: typesEnabled });
  const objects = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    enabled: objectsEnabled,
  });
  const departments = useQuery({ ...departmentOptionsQuery(), enabled: departmentsEnabled });
  return {
    onOpen,
    typeOptions: types.data ?? [],
    typesLoading: types.isLoading,
    typesReady: typesEnabled && types.isSuccess,
    objectOptions: objects.data ?? [],
    objectsReady: objectsEnabled && objects.isSuccess,
    departmentOptions: departments.data ?? [],
    departmentsReady: departmentsEnabled && departments.isSuccess,
  };
}
