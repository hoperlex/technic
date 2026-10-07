import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { departmentsApi } from './departmentsApi';
import { departmentKeys } from './keys';

/**
 * Отделы для выпадающих списков. Справочник маленький и запрашивается целиком: подразделения
 * приходят одним ответом, а поиск по ним идёт на клиенте — поле открывается без запроса на каждую
 * букву.
 *
 * Запрос описан здесь, а не на экранах, потому что спрашивают его в двух местах — в форме заявки
 * на технику и в карточке учётки. Разойдись у них `pageSize` или сортировка, один и тот же ключ
 * стал бы отдавать двум экранам разные списки.
 */
export const departmentOptionsQuery = () =>
  queryOptions({
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
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof departmentsApi.list>>) =>
      r.items.map((d) => ({ id: d.id, code: d.code, name: d.name })),
  };
};

/*
 * Запроса «какими отделами учётка руководит» здесь больше нет намеренно. Он читал признак с чужой
 * стороны связи — из `DepartmentDto.heads` справочника, — пока `UserDto` его не отдавал; теперь
 * признак приходит самой карточкой (`UserDepartmentRefDto.isHead`), и обход стал не только лишним,
 * но и неверным: выпадающий список отделов отдаёт только действующие, а руководство выключенным
 * отделом остаётся и должно быть видно.
 */
