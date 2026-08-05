import type { AuthUser, Role } from '@technic/contracts';

/**
 * Учётки для тестов. Роль задаёт права (ADR 0021), а объекты — область видимости (ADR 0039):
 * различаются сценарии именно этим, поэтому остальные поля живут значениями по умолчанию.
 */
export function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  const lastName = overrides.lastName ?? 'Диспетчеров';
  const firstName = overrides.firstName ?? 'Дмитрий';
  const middleName = overrides.middleName ?? 'Петрович';
  return {
    id: 'user-1',
    email: 'dispatcher@example.test',
    lastName,
    firstName,
    middleName,
    fullName: `${lastName} ${firstName} ${middleName}`.trim(),
    role: 'dispatcher' as Role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyType: null,
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
