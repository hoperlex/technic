import { useQueries } from '@tanstack/react-query';
import {
  DEPARTMENT_SCOPED_ROLES,
  roleLabels,
  type DepartmentHeadRefDto,
  type UserAccountDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { usersApi } from '../../api/resources';

/**
 * Кандидаты в руководители отдела — для карточки справочника (§11.1 плана реструктуризации прав,
 * миграция 0149).
 *
 * **Почему список перестал быть «учётками роли „Руководитель отдела“».** Руководство переехало из
 * роли в признак связи «человек ↔ отдел» (`user_departments.is_head`): держатель признака
 * руководит при любой роли, а роль без признака не руководит ничем. Роль кандидата сервер больше
 * не проверяет — отказ ««Иванов» — не руководитель отдела» выражал не правило, а прежнее
 * хранилище. Оставить сужение по роли значило бы, что портал держит снятое правило у себя: назначь
 * администратор руководителем сотрудника отдела — сервер примет, а выбрать его будет негде. После
 * слияния ролей такой список опустел бы молча, не покрасив ни одного теста доступа.
 *
 * **Почему не «любая живая учётка».** Условие осталось, но другое — не роль, а **ось области**.
 * Руководитель обязан работать на отдельской оси: у учётки с объектной или водительской ролью
 * первое же сохранение её карточки обнулит набор отделов вместе с признаком (`replaceUserDepartments`
 * снимает набор чужой оси), то есть выбор из карточки отдела отменился бы правкой, которая его не
 * касалась. Поэтому кандидаты — учётки ролей `DEPARTMENT_SCOPED_ROLES`, и перечень берётся из
 * контрактов: сменится состав отдельских ролей — список поедет за ним сам. Тем же условием отвечает
 * и сервер (`replaceDepartmentHeads`): портал сужает выбор, сервер отказывает — здесь это одно
 * правило, а не портальная привычка.
 *
 * Отбор идёт двумя запросами, по одному на роль: у ручки учёток фильтр `role` принимает одно
 * значение, а тащить весь реестр ради двух ролей — обещать выбор, которого сервер не примет.
 */

export interface DepartmentHeadOption {
  value: string;
  label: string;
}

/** Кто это и в каком он состоянии: с двумя ролями в списке одного ФИО для выбора уже мало. */
function candidateLabel(u: UserAccountDto): string {
  const notes = [u.role ? roleLabels[u.role] : 'без роли', u.isActive ? '' : 'выключена'].filter(
    Boolean,
  );
  return `${u.fullName} — ${notes.join(', ')}`;
}

/**
 * `current` — руководители открытой карточки. В выдачу кандидатов действующий руководитель попадает
 * не всегда: обе страницы отбираются по `DICTIONARY_PAGE_SIZE`, и в крупной компании отдельских
 * учёток однажды станет больше страницы. Без этой добавки поле показало бы на его месте
 * идентификатор, а «Сохранить» вернуло бы список, из которого его молча вычеркнули.
 */
export function useDepartmentHeadOptions(current: DepartmentHeadRefDto[]): {
  options: DepartmentHeadOption[];
  loading: boolean;
} {
  const queries = useQueries({
    queries: DEPARTMENT_SCOPED_ROLES.map((role) => ({
      queryKey: ['users', 'department-head-candidates', role],
      queryFn: () =>
        usersApi.list({
          page: 1,
          pageSize: DICTIONARY_PAGE_SIZE,
          role,
          sortBy: 'fullName',
          sortOrder: 'asc',
        }),
    })),
  });

  const options = queries
    .flatMap((q) => q.data?.items ?? [])
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'))
    .map((u) => ({ value: u.id, label: candidateLabel(u) }));
  for (const head of current) {
    if (!options.some((o) => o.value === head.id)) {
      options.unshift({ value: head.id, label: `${head.fullName} — уже руководит` });
    }
  }

  return { options, loading: queries.some((q) => q.isFetching) };
}
