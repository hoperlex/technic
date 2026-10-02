import { useQuery } from '@tanstack/react-query';
import type { CredentialTypeCode } from '@technic/contracts';
import { driversApi } from '../api/driversApi';
import { licenseCategoryKeys } from '../api/keys';

/**
 * Category options are shared by the registry filter and both document forms. The credential type
 * stays in the key because equal letters from different document kinds are different records.
 */
export function useLicenseCategoryOptions(type: CredentialTypeCode) {
  const { data } = useQuery({
    queryKey: licenseCategoryKeys.byType(type),
    queryFn: () => driversApi.licenseCategories(type),
    staleTime: Infinity,
  });

  return (data ?? []).map((category) => ({
    value: category.id,
    label: `${category.name} — ${category.description}`,
  }));
}
