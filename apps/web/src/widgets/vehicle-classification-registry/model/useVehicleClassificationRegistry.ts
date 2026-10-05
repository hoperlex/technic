import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_PAGE_SIZE } from '@technic/contracts';
import {
  vehicleClassificationKeys,
  vehicleClassificationsApi,
  vehicleKindKeys,
  vehicleKindsApi,
  vehicleTypeKeys,
  vehicleTypesApi,
} from '@entities/vehicle-type';
import type { TableChange } from '@shared/ui';

export interface VehicleClassificationParams {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  kindId?: string;
  isActive?: string;
  [key: string]: unknown;
}

/** Own list/filter state and the activation command for classifier rows. */
export function useVehicleClassificationRegistry() {
  const [params, setParams] = useState<VehicleClassificationParams>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sortBy: 'sortOrder',
    sortOrder: 'asc',
  });
  const patchParams = (patch: Partial<VehicleClassificationParams>) =>
    setParams((current) => ({ ...current, ...patch, page: 1 }));

  const listQuery = useQuery({
    queryKey: vehicleClassificationKeys.list(params),
    queryFn: () => vehicleClassificationsApi.list(params),
  });
  // Classification rows omit type-only fields needed by edit and card actions.
  const typesQuery = useQuery({
    queryKey: vehicleTypeKeys.full(),
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const kindsQuery = useQuery({
    queryKey: vehicleKindKeys.root,
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });

  const changeTable = (change: TableChange) =>
    setParams((current) => ({
      ...current,
      page: change.page,
      pageSize: change.pageSize,
      sortBy: change.sortBy ?? 'sortOrder',
      sortOrder: change.sortOrder ?? 'asc',
    }));

  return {
    params,
    setParams,
    patchParams,
    changeTable,
    rows: listQuery.data?.items ?? [],
    total: listQuery.data?.total ?? 0,
    loading: listQuery.isFetching,
    typeById: new Map((typesQuery.data?.items ?? []).map((type) => [type.id, type])),
    kindOptions: (kindsQuery.data?.items ?? []).map((kind) => ({
      value: kind.id,
      label: kind.name,
    })),
  };
}
