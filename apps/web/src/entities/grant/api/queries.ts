import { queryOptions } from '@tanstack/react-query';
import { grantFormApi } from './grantsApi';
import { grantKeys } from './keys';

export const grantFormCatalogQuery = (role: Parameters<typeof grantFormApi.catalog>[0]) =>
  queryOptions({
    queryKey: grantKeys.formCatalog(role),
    queryFn: () => grantFormApi.catalog(role),
  });
