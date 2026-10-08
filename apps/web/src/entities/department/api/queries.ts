import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE, queryProfileOptions } from '@shared/config';
import { departmentsApi } from './departmentsApi';
import { departmentKeys } from './keys';

/**
 * Departments fit in one response and are searched locally. The vehicle request form and account
 * editor must share one key and one set of request parameters; different page sizes or sorting under
 * the same key would make the answer depend on which screen loaded first.
 */
export const departmentOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: departmentKeys.options(),
    queryFn: () =>
      departmentsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
  });

/**
 * A department request has no object of its own (ADR 0040), so address suggestions use every
 * object linked to that department (ADR 0144). An empty set is meaningful. The legacy singular
 * `DepartmentDto.object` is null for departments with several objects and would lose those sites.
 * This observer projects the same cached department response as the standard options picker.
 */
export const departmentPlatformQuery = () => {
  const base = departmentOptionsQuery();
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof departmentsApi.list>>) =>
      new Map(r.items.map((d) => [d.id, d.objects.map((o) => o.id)] as const)),
  };
};

/**
 * Registration matching needs separate code and name fields. Splitting the picker label would be
 * ambiguous when a department name contains a dash. This observer shares the picker response;
 * its structural output keeps the entity slice independent of the page that performs matching.
 */
export const departmentRecordsQuery = () => {
  const base = departmentOptionsQuery();
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof departmentsApi.list>>) =>
      r.items.map((d) => ({ id: d.id, code: d.code, name: d.name })),
  };
};

/*
 * Account leadership is no longer inferred from the active-department picker. The account card
 * carries `UserDepartmentRefDto.isHead` directly, including leadership of inactive departments;
 * the picker would omit those links and show an incomplete account.
 */
