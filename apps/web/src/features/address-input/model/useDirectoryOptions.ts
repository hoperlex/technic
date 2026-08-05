import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { objectAddressOptionsQuery } from '@entities/object';
import { warehouseOptionsQuery } from '@entities/warehouse';
import { type DirectoryAddressRecord } from '@entities/address';

/** Запись справочника в списке выбора: идентификатор, адрес и подпись, по которой её ищут. */
export interface DirectoryOption extends DirectoryAddressRecord {
  value: string;
  label: string;
}

export interface DirectoryGroup {
  label: string;
  options: DirectoryOption[];
}

/**
 * Справочники, из которых выбирают место погрузки и разгрузки (ADR 0069): объекты и склады
 * поставщиков.
 *
 * Загрузка ленивая (`enabled`): списки нужны только тому, кто включил режим справочника, а окно
 * перегона и форма справочника открываются и без него — тянуть за ними два запроса значило бы
 * платить за чекбокс, которого могут не коснуться.
 */
export function useDirectoryOptions(enabled: boolean): {
  objects: DirectoryOption[];
  warehouses: DirectoryOption[];
  loading: boolean;
} {
  const objectsQuery = useQuery({ ...objectAddressOptionsQuery(), enabled });
  const warehousesQuery = useQuery({ ...warehouseOptionsQuery(), enabled });

  const objects = useMemo(
    () => (objectsQuery.data ?? []).map((o) => ({ ...o, kind: 'object' as const, id: o.value })),
    [objectsQuery.data],
  );
  const warehouses = useMemo(
    () =>
      (warehousesQuery.data ?? []).map((w) => ({ ...w, kind: 'warehouse' as const, id: w.value })),
    [warehousesQuery.data],
  );

  return {
    objects,
    warehouses,
    loading: objectsQuery.isFetching || warehousesQuery.isFetching,
  };
}
