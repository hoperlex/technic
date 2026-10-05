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

/**
 * Own the registry query, URL-like list parameters and read-only dictionaries of the driver
 * directory (ADR 0037, ADR 0095).
 */
export function useDriverRegistry() {
  const list = useListParams<RegistryFilters>(
    {},
    // 'contacts' is a column key, not a record field: the header search of the «Контакты» column
    // matches both the email and the phone number, and the server parses the term itself
    // (phoneSearchCondition). Renaming it to a DTO field would silently drop phone search.
    { searchKeys: ['fullName', 'snils', 'contacts'] },
  );
  const { params, setParams } = list;
  const { data, isFetching } = useQuery({
    queryKey: driverKeys.list(params),
    queryFn: () => driversApi.list(params),
  });
  // Job titles arrive from staff imports as free text (ADR 0095): there is no job-title dictionary,
  // so the server list is the only complete one. The key lives under the ['drivers'] root on
  // purpose — invalidating driverKeys.root after a new driver is saved refreshes these per-title
  // counters too; an own root would leave them stale after the first created driver.
  const { data: jobTitles } = useQuery({
    queryKey: driverKeys.jobTitles(),
    queryFn: () => driversApi.jobTitles(),
  });

  // The credential kind the registry asks about right now is named by the job-title filter. Without
  // a filter it is the driver license, as the directory always opened: it is about drivers, and the
  // second column pair is visible anyway.
  const filterType = params.jobTitle ? requiredCredentialType(params.jobTitle) : 'driver_license';
  const filterCategoryOptions = useLicenseCategoryOptions(filterType);
  // Without a filter both kinds are shown — the directory is opened precisely to see who lacks
  // what. With a job title only its own kind: driver-license columns of excavator operators are empty in
  // every row and only waste width (ADR 0095).
  const visibleTypes = params.jobTitle ? [filterType] : [...CREDENTIAL_TYPE_CODES];

  const setDocuments = (documents: DriverDocumentSet | undefined) =>
    setParams((current) => ({ ...current, documents, page: 1 }));
  // The category resets with the job title: letters coincide across credential kinds, but a
  // category is a dictionary record of one kind, and driver-license «C» matches no excavator operator. The
  // list would silently become empty and read as «nobody has it».
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
    // The count is not decoration: the same title spelled differently in the staff import shows up
    // as a second row with one person, which is a reason to fix the HR data, not the portal
    // (ADR 0095).
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
