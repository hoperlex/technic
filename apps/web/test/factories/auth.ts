import { permissionsFor, type AuthUser, type Role } from '@technic/contracts';

/**
 * Учётки для тестов. Права приходят учётке списком (ADR 0106) — по умолчанию тем, который сервер
 * посчитал бы её роли, — а объекты задают область видимости (ADR 0039): различаются сценарии именно
 * этим, поэтому остальные поля живут значениями по умолчанию.
 */
export function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  const lastName = overrides.lastName ?? 'Диспетчеров';
  const firstName = overrides.firstName ?? 'Дмитрий';
  const middleName = overrides.middleName ?? 'Петрович';
  const role = overrides.role ?? ('dispatcher' as Role);
  const counterpartyType = overrides.counterpartyType ?? null;
  // Надстроек роли (ADR 0086) у большинства учёток нет: сценарий, которому они нужны, задаёт их
  // сам — умолчанием здесь стоит «прав сверх роли не выдано».
  const addons = overrides.addons ?? [];
  return {
    id: 'user-1',
    email: 'dispatcher@example.test',
    lastName,
    firstName,
    middleName,
    fullName: `${lastName} ${firstName} ${middleName}`.trim(),
    phone: '',
    role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyType,
    addons,
    /*
     * Эффективные права, которые сервер посчитал и отдал (ADR 0106, этап 2): портал их больше не
     * выводит, а спрашивает, поэтому без этого поля учётка теста не может ничего.
     *
     * Считаются они **полным субъектом** — роль, тип контрагента, надстройки, — то есть тем же
     * `permissionsFor`, которым отвечает сервер: одной ролью исполнитель приходил бы в тест без прав
     * своего модуля (ADR 0038), а учётка с надстройкой — без прав надстройки (ADR 0086), и тест
     * описывал бы состояние, которого в портале не бывает.
     *
     * Собранный администратором набор (право есть, а роль его не даёт) задаётся сценарием: `permissions`
     * в `overrides` перекрывает эту строку — ровно так проверяется, что портал спрашивает список, а
     * не выводит его из роли.
     */
    permissions: [...permissionsFor({ role, counterpartyType, addons })],
    ...overrides,
  };
}

/** Штаб объекта: заявки заводит только на свою площадку — область сужена одним объектом. */
export function shtabUser(objectId: string, overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({
    id: 'user-shtab',
    email: 'shtab@example.test',
    lastName: 'Штабов',
    firstName: 'Сергей',
    middleName: 'Иванович',
    fullName: 'Штабов Сергей Иванович',
    role: 'shtab' as Role,
    constructionObjectIds: [objectId],
    ...overrides,
  });
}

/**
 * Сотрудник отдела с площадкой (ADR 0062): вывоз мусора ведёт на ней наравне со штабом, и
 * область у него производная — объект задан отделу, а не учётке.
 */
export function departmentUser(
  departmentId: string,
  objectIds: string[] = [],
  overrides: Partial<AuthUser> = {},
): AuthUser {
  return authUser({
    id: 'user-department',
    email: 'department@example.test',
    lastName: 'Отделов',
    firstName: 'Олег',
    middleName: 'Дмитриевич',
    fullName: 'Отделов Олег Дмитриевич',
    role: 'department' as Role,
    departmentIds: [departmentId],
    departmentObjectIds: objectIds,
    ...overrides,
  });
}

/** Ответ `/auth/login` и `/auth/refresh`: токен доступа плюс сам пользователь. */
export function loginResponse(user: AuthUser = authUser()) {
  return { accessToken: `token-${user.id}`, user };
}
