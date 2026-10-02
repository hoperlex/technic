import { useQuery } from '@tanstack/react-query';
import {
  CREDENTIAL_TYPE_CODES,
  DRIVER_DOCUMENT_SETS,
  type DriverDocumentSet,
  driverDocumentSetLabels,
  requiredCredentialType,
} from '@technic/contracts';
import { driverKeys, driversApi, useLicenseCategoryOptions } from '@entities/driver';
import { useListParams } from '@shared/lib';

interface RegistryFilters {
  documents?: DriverDocumentSet;
  jobTitle?: string;
  categoryId?: string;
  includeDeleted?: string;
}

/** Own the registry query, URL-like list parameters and read-only dictionaries. */
export function useDriverRegistry() {
  const list = useListParams<RegistryFilters>(
    {},
    { searchKeys: ['fullName', 'snils', 'contacts'] },
  );
  const { params, setParams } = list;
  const { data, isFetching } = useQuery({
    queryKey: driverKeys.list(params),
    queryFn: () => driversApi.list(params),
  });
  // Job titles are free text from staff imports, so the server is the only complete dictionary.
  const { data: jobTitles } = useQuery({
    queryKey: driverKeys.jobTitles(),
    queryFn: () => driversApi.jobTitles(),
  });

  const filterType = params.jobTitle ? requiredCredentialType(params.jobTitle) : 'driver_license';
  const filterCategoryOptions = useLicenseCategoryOptions(filterType);
  const visibleTypes = params.jobTitle ? [filterType] : [...CREDENTIAL_TYPE_CODES];

  const setDocuments = (documents: DriverDocumentSet | undefined) =>
    setParams((current) => ({ ...current, documents, page: 1 }));
  // A category id belongs to one credential type and cannot survive a job-title type change.
  const setJobTitle = (jobTitle: string | undefined) =>
    setParams((current) => ({ ...current, jobTitle, categoryId: undefined, page: 1 }));
  const setCategory = (categoryId: string | undefined) =>
    setParams((current) => ({ ...current, categoryId, page: 1 }));

  return {
    ...list,
    data,
    documentSetOptions: DRIVER_DOCUMENT_SETS.map((value) => ({
      value,
      label: driverDocumentSetLabels[value],
    })),
    filterCategoryOptions,
    filterType,
    isFetching,
    jobTitleOptions: (jobTitles ?? []).map((title) => ({
      value: title.jobTitle,
      label: `${title.jobTitle} (${title.count})`,
    })),
    setCategory,
    setDocuments,
    setJobTitle,
    visibleTypes,
  };
}

export type DriverRegistryModel = ReturnType<typeof useDriverRegistry>;
