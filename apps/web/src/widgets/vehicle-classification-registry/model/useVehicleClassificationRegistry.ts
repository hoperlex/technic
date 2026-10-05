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
  // An index signature keeps the params object usable as the apiFetch query as-is.
  [key: string]: unknown;
}

/**
 * Own list/filter state of the classifier registry and the read-only dictionaries its rows need.
 * Activation lives in the vehicle-classification-lifecycle feature, not here.
 */
export function useVehicleClassificationRegistry() {
  // pageSize comes from the contract: the server accepts only PAGE_SIZES (100/200/500), and any
  // other value is rejected by querystring validation, so the list would not load at all.
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
  // The types themselves, for edit and the card: a classifier row carries only what is shown,
  // while the form needs the whole type (code, kind, description, order). There are dozens of
  // types, so they are loaded at once.
  const typesQuery = useQuery({
    queryKey: vehicleTypeKeys.full(),
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });
  const kindsQuery = useQuery({
    queryKey: vehicleKindKeys.root,
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });

  // Sorting is server-side; clearing it returns the directory to its own sort order.
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
