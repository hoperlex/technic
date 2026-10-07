import { licenseCategoriesQuery } from '../api/queries';
import { useQuery } from '@tanstack/react-query';
import type { CredentialTypeCode } from '@technic/contracts';

/**
 * Category options are shared by the registry filter and both document forms. The credential type
 * stays in the key because equal letters from different document kinds are different records.
 */
export function useLicenseCategoryOptions(type: CredentialTypeCode) {
  const { data } = useQuery({
    ...licenseCategoriesQuery(type),
    staleTime: Infinity,
  });

  return (data ?? []).map((category) => ({
    value: category.id,
    label: `${category.name} — ${category.description}`,
  }));
}
