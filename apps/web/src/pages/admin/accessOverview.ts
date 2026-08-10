import { useQuery } from '@tanstack/react-query';
import {
  accessProfileLabel,
  can,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  PERMISSIONS,
  scopeAxisOf,
  type AccessSubject,
  type Permission,
  type UserDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { usersApi } from '../../api/resources';

/**
 * Общие данные и вычисления вкладки «Права» (`docs/permissions-tab-plan.md`).
 *
 * Витрина считает всё из двух источников: списка учёток и матрицы прав из контрактов. Своего
 * представления о том, «что может штаб», здесь нет ни строчки — только вызовы `can` и соседних
 * функций: копия правил разошлась бы с моделью и врала бы ровно там, где по ней принимают решение.
 *
 * Три среза вкладки берут один и тот же список одним запросом (ключ общий, react-query
 * дедуплицирует): сводки считаются по всем учёткам сразу, а не по странице — «сколько людей под
 * ролью» на одной странице списка не посчитать.
 */

const ACCESS_USERS_KEY = ['users', 'access-overview'] as const;

export interface AccessUsers {
  users: UserDto[];
  /** Сколько учёток всего: список ограничен страницей, и об урезании витрина обязана сказать. */
  total: number;
  truncated: boolean;
  isFetching: boolean;
}

export function useAccessUsers(): AccessUsers {
  const { data, isFetching } = useQuery({
    queryKey: ACCESS_USERS_KEY,
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
  const users = data?.items ?? [];
  const total = data?.total ?? 0;
  return { users, total, truncated: total > users.length, isFetching };
}

/**
 * Субъект доступа из карточки учётки (ADR 0038, 0086) — тройка, которую спрашивает `can`.
 * Область сюда не входит намеренно: она второй слой, и витрина показывает её отдельной колонкой.
 */
export function subjectOf(user: UserDto): AccessSubject {
  return { role: user.role, counterpartyType: user.counterpartyType, addons: user.addons };
}

/** Права субъекта — списком, в порядке объявления матрицы. */
export function grantedPermissions(subject: AccessSubject): readonly Permission[] {
  return PERMISSIONS.filter((permission) => can(subject, permission));
}

/**
 * Чем ограничена область учётки: ось и её значения — объекты, отделы или контрагент. `null` в оси
 * означает «роль без своей оси» (администратор, менеджер, наблюдатель), и значений у неё нет.
 */
export interface ScopeTargets {
  axis: ReturnType<typeof scopeAxisOf>;
  items: string[];
}

export function scopeTargets(user: UserDto): ScopeTargets {
  const axis = scopeAxisOf(user.role);
  if (axis === 'object') return { axis, items: user.constructionObjects.map((o) => o.name) };
  if (axis === 'department') return { axis, items: user.departments.map((d) => d.name) };
  if (axis === 'counterparty') {
    return { axis, items: user.counterpartyName ? [user.counterpartyName] : [] };
  }
  return { axis, items: [] };
}

/**
 * Учётка, у которой роль требует области, а области нет: она не видит ничего и работать не может.
 * Активной такой быть не должна — API её не активирует (ADR 0039, 0040), — но витрина проверяет
 * сама: смысл среза в том, чтобы находить расхождения, а не подтверждать, что их не бывает.
 */
export function scopeAnomaly(user: UserDto): string | null {
  if (!user.role) return user.isActive ? 'Активна, но роль не назначена' : null;
  if (isObjectScopedRole(user.role) && user.constructionObjects.length === 0) {
    return 'Роль работает на объектах, но объекты не заданы';
  }
  if (isDepartmentScopedRole(user.role) && user.departments.length === 0) {
    return 'Роль работает в отделах, но отделы не заданы';
  }
  if (isCounterpartyScopedRole(user.role) && !user.counterpartyId) {
    return 'Роль работает от контрагента, но контрагент не задан';
  }
  return null;
}

/** Живые учётки: витрина отвечает на «кто сейчас что может», и выключенные в счёт не идут. */
export function activeUsers(users: readonly UserDto[]): UserDto[] {
  return users.filter((u) => u.isActive && !u.deletedAt);
}

/**
 * Профиль доступа учётки — то, чем она различима для матрицы: роль, тип контрагента и набор
 * надстроек. Учётки с одинаковым ключом отвечают на `can` одинаково, сколько бы их ни было.
 */
export function profileKey(user: UserDto): string {
  return [
    user.role ?? 'none',
    user.counterpartyType ?? '-',
    [...user.addons].sort().join('+'),
  ].join('|');
}

export interface ProfileUsage {
  key: string;
  subject: AccessSubject;
  label: string;
  users: UserDto[];
}

/**
 * Профили, занятые живыми учётками. Пустые профили матрицы сюда не попадают — их показывает срез
 * «Профили», сравнивая этот список с `ACCESS_PROFILES`: незанятая роль и есть первый ответ на
 * вопрос пересмотра.
 */
export function profileUsage(users: readonly UserDto[]): ProfileUsage[] {
  const byKey = new Map<string, ProfileUsage>();
  for (const user of users) {
    const key = profileKey(user);
    const found = byKey.get(key);
    if (found) {
      found.users.push(user);
      continue;
    }
    const subject = subjectOf(user);
    byKey.set(key, {
      key,
      subject,
      label: user.role ? accessProfileLabel(subject) : 'Без роли',
      users: [user],
    });
  }
  return [...byKey.values()].sort((a, b) => b.users.length - a.users.length);
}

/** Сколько живых учёток владеет каждым правом — вход обратного среза «Права». */
export function permissionHolders(users: readonly UserDto[]): Map<Permission, UserDto[]> {
  const holders = new Map<Permission, UserDto[]>(PERMISSIONS.map((p) => [p, []]));
  for (const user of users) {
    const subject = subjectOf(user);
    for (const permission of PERMISSIONS) {
      if (can(subject, permission)) holders.get(permission)?.push(user);
    }
  }
  return holders;
}
