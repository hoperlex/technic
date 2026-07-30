import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Role } from '@technic/contracts';
import {
  approvesOwnRequestOnCreate,
  assertArchiveVisible,
  assertCan,
  assertOperatorScope,
  assertObjectRoleEditable,
  assertObjectScope,
  assertTransitionAllowed,
  canApproveForObject,
  operatorVisibilityWhere,
  requestVisibilityWhere,
} from '../src/lib/access';
import { wasteRequests } from '../src/db/schema';
import type { Principal } from '../src/auth/principal';
import { AppError } from '../src/lib/errors';

/**
 * Второй слой доступа (ADR 0021): область видимости. Право отвечает «что роль может делать»,
 * область — «над какими строками». Ошибка здесь не даёт 403 на пустом месте, а тихо открывает
 * чужие заявки, поэтому проверяется и то, что условие ставится, и то, с каким значением.
 */

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const OBJECT_B = '22222222-2222-2222-2222-222222222222';
const COUNTERPARTY_A = '33333333-3333-3333-3333-333333333333';
const COUNTERPARTY_B = '44444444-4444-4444-4444-444444444444';
/** Заведомо несуществующий id: им подменяется пустая привязка, чтобы условие не исчезло. */
const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

const dialect = new PgDialect();

function principal(role: Role | null, extra: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    email: 'user@test.local',
    fullName: 'Пользователь',
    role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectId: null,
    counterpartyId: null,
    authVersion: 1,
    ...extra,
  };
}

/** Параметры готового SQL-условия: по ним видно, с чем именно сравнивается колонка. */
function paramsOf(condition: ReturnType<typeof requestVisibilityWhere>): unknown[] {
  expect(condition).toBeDefined();
  return dialect.sqlToQuery(condition!).params;
}

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).statusCode;
  }
  return 200;
}

describe('видимость заявок по объекту', () => {
  it('штаб видит только свой объект', () => {
    const p = principal('shtab', { constructionObjectId: OBJECT_A });
    expect(paramsOf(requestVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('штаб без объекта не видит ничего, а не всё', () => {
    const p = principal('shtab');
    expect(paramsOf(requestVisibilityWhere(p, wasteRequests.objectId))).toEqual([NEVER_MATCH]);
  });

  it('руководитель строительства тоже видит только свой объект (ADR 0025)', () => {
    const p = principal('rukstroy', { constructionObjectId: OBJECT_A });
    expect(paramsOf(requestVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('остальные роли видят все объекты', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'operator'] as Role[]) {
      expect(requestVisibilityWhere(principal(role), wasteRequests.objectId), role).toBeUndefined();
    }
  });
});

describe('видимость заявок вывоза по контрагенту (ADR 0010)', () => {
  it('оператор видит только заявки своего контрагента', () => {
    const p = principal('operator', { counterpartyId: COUNTERPARTY_A });
    const cond = operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId);
    expect(paramsOf(cond)).toEqual([COUNTERPARTY_A]);
  });

  it('оператор без контрагента не видит ничего', () => {
    const cond = operatorVisibilityWhere(
      principal('operator'),
      wasteRequests.operatorCounterpartyId,
    );
    expect(paramsOf(cond)).toEqual([NEVER_MATCH]);
  });

  it('на остальные роли ограничение не распространяется', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'shtab'] as Role[]) {
      expect(
        operatorVisibilityWhere(principal(role), wasteRequests.operatorCounterpartyId),
        role,
      ).toBeUndefined();
    }
  });
});

describe('работа с конкретной записью', () => {
  it('объектная роль не работает с чужим объектом', () => {
    for (const role of ['shtab', 'rukstroy'] as Role[]) {
      const p = principal(role, { constructionObjectId: OBJECT_A });
      expect(
        statusOf(() => assertObjectScope(p, OBJECT_A)),
        role,
      ).toBe(200);
      expect(
        statusOf(() => assertObjectScope(p, OBJECT_B)),
        role,
      ).toBe(403);
    }
  });

  it('остальным ролям объект заявки не ограничивает работу', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'operator'] as Role[]) {
      expect(
        statusOf(() => assertObjectScope(principal(role), OBJECT_B)),
        role,
      ).toBe(200);
    }
  });

  it('объектная роль правит и удаляет заявку только до «В работе»', () => {
    for (const role of ['shtab', 'rukstroy'] as Role[]) {
      const p = principal(role, { constructionObjectId: OBJECT_A });
      expect(
        statusOf(() => assertObjectRoleEditable(p, 'new', 'редактировать')),
        role,
      ).toBe(200);
      expect(
        statusOf(() => assertObjectRoleEditable(p, 'confirmed', 'редактировать')),
        role,
      ).toBe(403);
      expect(
        statusOf(() => assertObjectRoleEditable(p, 'done', 'удалять')),
        role,
      ).toBe(403);
    }
    // Заявку в работе правит тот, кто её ведёт: ограничение только у штаба.
    expect(
      statusOf(() => assertObjectRoleEditable(principal('manager'), 'confirmed', 'редактировать')),
    ).toBe(200);
  });

  it('оператор работает только с заявками своего контрагента', () => {
    const p = principal('operator', { counterpartyId: COUNTERPARTY_A });
    expect(statusOf(() => assertOperatorScope(p, COUNTERPARTY_A))).toBe(200);
    expect(statusOf(() => assertOperatorScope(p, COUNTERPARTY_B))).toBe(403);
    // Неназначенная заявка для оператора тоже чужая.
    expect(statusOf(() => assertOperatorScope(p, null))).toBe(403);
    expect(statusOf(() => assertOperatorScope(principal('manager'), COUNTERPARTY_B))).toBe(200);
  });
});

describe('виза на заявке ТС (ADR 0025, 0032)', () => {
  it('визирует тот, у кого есть право, — руководитель строительства только свой объект', () => {
    const ruk = principal('rukstroy', { constructionObjectId: OBJECT_A });
    expect(canApproveForObject(ruk, OBJECT_A)).toBe(true);
    expect(canApproveForObject(ruk, OBJECT_B)).toBe(false);
    // Администратор право визы сохраняет, и объект его не ограничивает.
    expect(canApproveForObject(principal('admin'), OBJECT_B)).toBe(true);
    for (const role of ['manager', 'dispatcher', 'shtab', 'operator'] as Role[]) {
      expect(
        canApproveForObject(principal(role, { constructionObjectId: OBJECT_A }), OBJECT_A),
        role,
      ).toBe(false);
    }
  });

  it('сама собой виза встаёт только у того, кто отвечает за объект', () => {
    const ruk = principal('rukstroy', { constructionObjectId: OBJECT_A });
    expect(approvesOwnRequestOnCreate(ruk, OBJECT_A)).toBe(true);
    expect(approvesOwnRequestOnCreate(ruk, OBJECT_B)).toBe(false);
    // Право визы автовизы не даёт: администратор заводит заявку не за себя, и она ждёт визы.
    expect(canApproveForObject(principal('admin'), OBJECT_A)).toBe(true);
    expect(approvesOwnRequestOnCreate(principal('admin'), OBJECT_A)).toBe(false);
  });
});

describe('видимость архива по прямому id', () => {
  const deletedAt = new Date('2026-01-01T00:00:00Z');

  it('живая запись видна всем, кто до неё дошёл', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'shtab', 'operator'] as Role[]) {
      expect(
        statusOf(() => assertArchiveVisible(principal(role), null, 'Не найдено')),
        role,
      ).toBe(200);
    }
  });

  it('удалённая запись — 404 всем, кроме тех, кому открыт архив', () => {
    for (const role of ['manager', 'dispatcher', 'shtab', 'operator'] as Role[]) {
      // 404, а не 403: существование удалённой записи под известным id тоже не их дело.
      expect(
        statusOf(() => assertArchiveVisible(principal(role), deletedAt, 'Не найдено')),
        role,
      ).toBe(404);
    }
    expect(statusOf(() => assertArchiveVisible(principal('admin'), deletedAt, 'Не найдено'))).toBe(
      200,
    );
  });

  it('учётке без роли архив закрыт', () => {
    expect(statusOf(() => assertArchiveVisible(principal(null), deletedAt, 'Не найдено'))).toBe(
      404,
    );
  });
});

describe('assertCan — право внутри обработчика', () => {
  it('пропускает роль с правом и отвергает остальных', () => {
    expect(statusOf(() => assertCan(principal('admin'), 'records.purge'))).toBe(200);
    expect(statusOf(() => assertCan(principal('manager'), 'records.purge'))).toBe(403);
    expect(statusOf(() => assertCan(principal(null), 'directories.read'))).toBe(403);
  });

  it('передаёт сообщение, объясняющее отказ', () => {
    try {
      assertCan(
        principal('manager'),
        'records.purge',
        'Удалить машину насовсем может только администратор',
      );
      expect.unreachable('ожидался отказ');
    } catch (e) {
      expect((e as AppError).message).toBe('Удалить машину насовсем может только администратор');
    }
  });
});

describe('переход статуса', () => {
  it('разрешённый переход проходит', () => {
    expect(statusOf(() => assertTransitionAllowed('new', 'confirmed', 'dispatcher'))).toBe(200);
    expect(statusOf(() => assertTransitionAllowed('confirmed', 'done', 'operator'))).toBe(200);
  });

  it('несуществующий переход — 400, чужое право — 403', () => {
    // Перехода «Новая» → «Выполнена» нет ни у кого: это ошибка запроса, а не прав.
    expect(statusOf(() => assertTransitionAllowed('new', 'done', 'manager'))).toBe(400);
    // Откат существует, но только у администратора — отказ по правам.
    expect(statusOf(() => assertTransitionAllowed('done', 'confirmed', 'manager'))).toBe(403);
  });

  it('оператору объясняют его единственный переход', () => {
    try {
      assertTransitionAllowed('new', 'confirmed', 'operator');
      expect.unreachable('ожидался отказ');
    } catch (e) {
      expect((e as AppError).statusCode).toBe(403);
      expect((e as AppError).message).toContain('Оператор');
    }
  });

  it('учётке без роли отказывают по правам, а не разбором переходов', () => {
    try {
      assertTransitionAllowed('new', 'confirmed', null);
      expect.unreachable('ожидался отказ');
    } catch (e) {
      expect((e as AppError).statusCode).toBe(403);
      expect((e as AppError).message).toBe('Недостаточно прав для смены статуса');
    }
  });
});
