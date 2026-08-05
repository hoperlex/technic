import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { CounterpartyType, Role } from '@technic/contracts';
import {
  approvesOwnRequestOnCreate,
  assertArchiveVisible,
  assertCan,
  assertLessorScope,
  assertOperatorScope,
  assertObjectRoleEditable,
  assertWasteObjectScope,
  assertTransitionAllowed,
  assertRequestScope,
  assertVehicleRequestTypeAllowed,
  canApproveRequest,
  vehicleRequestVisibilityWhere,
  lessorVisibilityWhere,
  operatorVisibilityWhere,
  wasteRequestVisibilityWhere,
} from '../src/lib/access';
import { vehicleRequests, vehicles, wasteRequests } from '../src/db/schema';
import type { Principal } from '../src/auth/principal';
import { AppError } from '../src/lib/errors';

/**
 * Второй слой доступа (ADR 0021): область видимости. Право отвечает «что роль может делать»,
 * область — «над какими строками». Ошибка здесь не даёт 403 на пустом месте, а тихо открывает
 * чужие заявки, поэтому проверяется и то, что условие ставится, и то, с каким значением.
 */

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const OBJECT_B = '22222222-2222-2222-2222-222222222222';
const DEPARTMENT_A = '55555555-5555-5555-5555-555555555555';
const DEPARTMENT_B = '66666666-6666-6666-6666-666666666666';
const COUNTERPARTY_A = '33333333-3333-3333-3333-333333333333';
const COUNTERPARTY_B = '44444444-4444-4444-4444-444444444444';
/** Заведомо несуществующий id: им подменяется пустая привязка, чтобы условие не исчезло. */
const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

const dialect = new PgDialect();

function principal(role: Role | null, extra: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    email: 'user@test.local',
    lastName: 'Пользователь',
    firstName: 'Тестовый',
    middleName: '',
    fullName: 'Пользователь Тестовый',
    role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyId: null,
    counterpartyType: null,
    authVersion: 1,
    ...extra,
  };
}

/**
 * Внешний исполнитель (ADR 0038): роль плюс тип контрагента. Права и область у него следуют из
 * типа, поэтому в тестах он заводится только парой — роль без типа означает другое.
 */
function executor(counterpartyType: CounterpartyType, counterpartyId: string | null): Principal {
  return principal('operator', { counterpartyType, counterpartyId });
}

/** Заказчик заявки (ADR 0040): в этих проверках он всегда объект — отдельские идут отдельно. */
const onObject = (objectId: string) => ({ objectId, departmentId: null });
const onDepartment = (departmentId: string) => ({ objectId: null, departmentId });

/** Параметры готового SQL-условия: по ним видно, с чем именно сравнивается колонка. */
function paramsOf(condition: ReturnType<typeof wasteRequestVisibilityWhere>): unknown[] {
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
    const p = principal('shtab', { constructionObjectIds: [OBJECT_A] });
    expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('штаб без объекта не видит ничего, а не всё', () => {
    const p = principal('shtab');
    expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId))).toEqual([NEVER_MATCH]);
  });

  it('руководитель строительства тоже видит только свой объект (ADR 0025)', () => {
    const p = principal('rukstroy', { constructionObjectIds: [OBJECT_A] });
    expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('комендант сужен теми же объектами: модуль у него один, а область та же', () => {
    const p = principal('commandant', { constructionObjectIds: [OBJECT_A] });
    expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('остальные роли видят все объекты', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'operator'] as Role[]) {
      expect(
        wasteRequestVisibilityWhere(principal(role), wasteRequests.objectId),
        role,
      ).toBeUndefined();
    }
  });

  // Роль отдела (ADR 0062) видит вывоз со своей площадки — той, что задана её отделу. Область
  // производная, поэтому она в отдельном наборе: прямой привязки объектов у такой учётки нет.
  it('роль отдела видит вывоз с площадки своего отдела', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const p = principal(role, {
        departmentIds: [DEPARTMENT_A],
        departmentObjectIds: [OBJECT_A],
      });
      expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId)), role).toEqual([
        OBJECT_A,
      ]);
    }
  });

  // Отдел без площадки — рабочее состояние (ПТО, АХО): права на модуль у роли есть, работать
  // ими не над чем. Условие обязано остаться: без него «право есть, область не написана»
  // означало бы доступ ко всем заявкам компании сразу.
  it('роль отдела без площадки не видит ничего, а не всё', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const p = principal(role, { departmentIds: [DEPARTMENT_A] });
      expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId)), role).toEqual([
        NEVER_MATCH,
      ]);
    }
  });

  // Множественная привязка (ADR 0039): область объектной роли — набор, а не один объект.
  it('с несколькими объектами условие перечисляет их все, а не первый из набора', () => {
    for (const role of ['shtab', 'rukstroy', 'commandant'] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A, OBJECT_B] });
      expect(paramsOf(wasteRequestVisibilityWhere(p, wasteRequests.objectId)), role).toEqual([
        OBJECT_A,
        OBJECT_B,
      ]);
    }
  });
});

/**
 * Заказчик заявки на технику (ADR 0040): объект или отдел. Ось у роли одна, и заявка чужой оси
 * для неё чужая — у заявки отдела объекта нет вовсе.
 */
describe('видимость заявок ТС по заказчику (ADR 0040)', () => {
  const visibility = (p: Principal) =>
    vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId);

  it('объектная роль сравнивается с объектом заявки, отдельская — с её отделом', () => {
    const shtab = principal('shtab', { constructionObjectIds: [OBJECT_A, OBJECT_B] });
    expect(paramsOf(visibility(shtab))).toEqual([OBJECT_A, OBJECT_B]);
    const head = principal('department_head', { departmentIds: [DEPARTMENT_A] });
    expect(paramsOf(visibility(head))).toEqual([DEPARTMENT_A]);
  });

  it('пустая область не видит ничего, а не всё — на обеих осях', () => {
    expect(paramsOf(visibility(principal('shtab')))).toEqual([NEVER_MATCH]);
    expect(paramsOf(visibility(principal('department')))).toEqual([NEVER_MATCH]);
  });

  it('остальные роли видят заявки обоих заказчиков', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'observer'] as Role[]) {
      expect(visibility(principal(role)), role).toBeUndefined();
    }
  });

  /**
   * Граница ADR 0062: площадка отдела открывает ему вывоз мусора и ничего больше. В «Заказе ТС»
   * роль отдела по-прежнему сравнивается со своим отделом, а объектных заявок не видит и не
   * трогает — иначе сотрудник отдела заказал бы технику на чужую площадку от её имени.
   */
  it('площадка отдела в заказ ТС не приходит', () => {
    const withObject = principal('department_head', {
      departmentIds: [DEPARTMENT_A],
      departmentObjectIds: [OBJECT_A],
    });
    expect(paramsOf(visibility(withObject))).toEqual([DEPARTMENT_A]);
    expect(statusOf(() => assertRequestScope(withObject, onObject(OBJECT_A)))).toBe(403);
    expect(canApproveRequest(withObject, onObject(OBJECT_A))).toBe(false);
    // Тип заказа тоже не меняется: спецтехника выходит на площадку, а заказчиком у отдела
    // остаётся отдел (ADR 0040 п. 10).
    expect(statusOf(() => assertVehicleRequestTypeAllowed(withObject, 'special_equipment'))).toBe(
      403,
    );
  });

  it('заявка чужой оси недоступна: у заявки отдела объекта нет вовсе', () => {
    const shtab = principal('shtab', { constructionObjectIds: [OBJECT_A] });
    expect(statusOf(() => assertRequestScope(shtab, onObject(OBJECT_A)))).toBe(200);
    expect(statusOf(() => assertRequestScope(shtab, onDepartment(DEPARTMENT_A)))).toBe(403);

    const head = principal('department_head', { departmentIds: [DEPARTMENT_A] });
    expect(statusOf(() => assertRequestScope(head, onDepartment(DEPARTMENT_A)))).toBe(200);
    expect(statusOf(() => assertRequestScope(head, onObject(OBJECT_A)))).toBe(403);
  });

  it('руководитель отдела визирует заявку своего отдела и только её', () => {
    const head = principal('department_head', { departmentIds: [DEPARTMENT_A] });
    expect(canApproveRequest(head, onDepartment(DEPARTMENT_A))).toBe(true);
    expect(canApproveRequest(head, onDepartment(DEPARTMENT_B))).toBe(false);
    expect(canApproveRequest(head, onObject(OBJECT_A))).toBe(false);
    // Автовиза следует из ответственности за заказчика, а не из права визы (ADR 0032).
    expect(approvesOwnRequestOnCreate(head, onDepartment(DEPARTMENT_A))).toBe(true);
    const staff = principal('department', { departmentIds: [DEPARTMENT_A] });
    expect(approvesOwnRequestOnCreate(staff, onDepartment(DEPARTMENT_A))).toBe(false);
  });

  it('отдел заказывает только грузоперевозки, остальные роли — оба типа', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const p = principal(role, { departmentIds: [DEPARTMENT_A] });
      expect(
        statusOf(() => assertVehicleRequestTypeAllowed(p, 'freight_transport')),
        role,
      ).toBe(200);
      // 403, а не 422: дело не в состоянии заявки, а в том, что такой заказ роли не положен.
      expect(
        statusOf(() => assertVehicleRequestTypeAllowed(p, 'special_equipment')),
        role,
      ).toBe(403);
    }
    for (const role of ['admin', 'manager', 'shtab', 'rukstroy'] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A] });
      expect(
        statusOf(() => assertVehicleRequestTypeAllowed(p, 'special_equipment')),
        role,
      ).toBe(200);
    }
  });
});

describe('видимость заявок вывоза по контрагенту (ADR 0010)', () => {
  it('оператор видит только заявки своего контрагента', () => {
    const p = executor('operator', COUNTERPARTY_A);
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

  it('арендодатель в вывозе мусора не видит ничего — это не его модуль (ADR 0038)', () => {
    const cond = operatorVisibilityWhere(
      executor('vehicle_lessor', COUNTERPARTY_A),
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

describe('видимость заявок ТС по арендодателю (ADR 0038)', () => {
  it('арендодатель видит заявки, на которые вышла его техника', () => {
    const cond = lessorVisibilityWhere(
      executor('vehicle_lessor', COUNTERPARTY_A),
      vehicles.lessorId,
    );
    expect(paramsOf(cond)).toEqual([COUNTERPARTY_A]);
  });

  it('арендодатель без контрагента не видит ничего', () => {
    const cond = lessorVisibilityWhere(principal('operator'), vehicles.lessorId);
    expect(paramsOf(cond)).toEqual([NEVER_MATCH]);
  });

  it('оператор вывоза в заказе ТС не видит ничего — это не его модуль', () => {
    const cond = lessorVisibilityWhere(executor('operator', COUNTERPARTY_A), vehicles.lessorId);
    expect(paramsOf(cond)).toEqual([NEVER_MATCH]);
  });

  it('на роли без контрагента ограничение не распространяется', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'shtab', 'observer'] as Role[]) {
      expect(lessorVisibilityWhere(principal(role), vehicles.lessorId), role).toBeUndefined();
    }
  });
});

describe('работа с конкретной записью', () => {
  it('объектная роль не работает с чужим объектом', () => {
    for (const role of ['shtab', 'rukstroy', 'commandant'] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A] });
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_A)),
        role,
      ).toBe(200);
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_B)),
        role,
      ).toBe(403);
    }
  });

  it('объектная роль работает с любым объектом своего набора (ADR 0039)', () => {
    for (const role of ['shtab', 'rukstroy', 'commandant'] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A, OBJECT_B] });
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_A)),
        role,
      ).toBe(200);
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_B)),
        role,
      ).toBe(200);
      // Пустой набор — не «работает везде»: активировать такую учётку API не даёт, но проверка
      // не должна зависеть от того, удержался ли этот запрет.
      expect(
        statusOf(() => assertWasteObjectScope(principal(role), OBJECT_A)),
        role,
      ).toBe(403);
    }
  });

  it('роль отдела работает с площадкой своего отдела и только с ней (ADR 0062)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const p = principal(role, {
        departmentIds: [DEPARTMENT_A],
        departmentObjectIds: [OBJECT_A],
      });
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_A)),
        role,
      ).toBe(200);
      // Отказ обязателен именно здесь: права на модуль у отдела есть, и без этой ветки сотрудник
      // отдела заводил бы заявки на любой объект компании.
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_B)),
        role,
      ).toBe(403);
    }
  });

  it('роль отдела без площадки не работает ни с одним объектом (ADR 0062)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const p = principal(role, { departmentIds: [DEPARTMENT_A] });
      expect(
        statusOf(() => assertWasteObjectScope(p, OBJECT_A)),
        role,
      ).toBe(403);
    }
  });

  it('остальным ролям объект заявки не ограничивает работу', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'operator'] as Role[]) {
      expect(
        statusOf(() => assertWasteObjectScope(principal(role), OBJECT_B)),
        role,
      ).toBe(200);
    }
  });

  it('заказчик правит и удаляет заявку только до «В работе» — обе оси', () => {
    for (const role of [
      'shtab',
      'rukstroy',
      'commandant',
      'department',
      'department_head',
    ] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A] });
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
    const p = executor('operator', COUNTERPARTY_A);
    expect(statusOf(() => assertOperatorScope(p, COUNTERPARTY_A))).toBe(200);
    expect(statusOf(() => assertOperatorScope(p, COUNTERPARTY_B))).toBe(403);
    // Неназначенная заявка для оператора тоже чужая.
    expect(statusOf(() => assertOperatorScope(p, null))).toBe(403);
    expect(statusOf(() => assertOperatorScope(principal('manager'), COUNTERPARTY_B))).toBe(200);
  });

  it('арендодатель работает только с заявками, на которые вышла его техника (ADR 0038)', () => {
    const p = executor('vehicle_lessor', COUNTERPARTY_A);
    expect(statusOf(() => assertLessorScope(p, COUNTERPARTY_A))).toBe(200);
    expect(statusOf(() => assertLessorScope(p, COUNTERPARTY_B))).toBe(403);
    // Заявка без назначенной техники — ничья: закрывать её исполнителю нечем.
    expect(statusOf(() => assertLessorScope(p, null))).toBe(403);
    expect(statusOf(() => assertLessorScope(principal('dispatcher'), COUNTERPARTY_B))).toBe(200);
  });

  it('исполнитель не работает с записями чужого модуля', () => {
    // Своя заявка вывоза у арендодателя не «своя»: контрагент тот же, а модуль другой.
    const lessor = executor('vehicle_lessor', COUNTERPARTY_A);
    expect(statusOf(() => assertOperatorScope(lessor, COUNTERPARTY_A))).toBe(403);
    const operator = executor('operator', COUNTERPARTY_A);
    expect(statusOf(() => assertLessorScope(operator, COUNTERPARTY_A))).toBe(403);
  });
});

describe('виза на заявке ТС (ADR 0025, 0032)', () => {
  it('визирует тот, у кого есть право, — руководитель строительства только свой объект', () => {
    const ruk = principal('rukstroy', { constructionObjectIds: [OBJECT_A] });
    expect(canApproveRequest(ruk, onObject(OBJECT_A))).toBe(true);
    expect(canApproveRequest(ruk, onObject(OBJECT_B))).toBe(false);
    // Администратор право визы сохраняет, и объект его не ограничивает.
    expect(canApproveRequest(principal('admin'), onObject(OBJECT_B))).toBe(true);
    for (const role of ['manager', 'dispatcher', 'shtab', 'commandant', 'operator'] as Role[]) {
      expect(
        canApproveRequest(
          principal(role, { constructionObjectIds: [OBJECT_A] }),
          onObject(OBJECT_A),
        ),
        role,
      ).toBe(false);
    }
  });

  it('визирует на любом своём объекте, а автовиза встаёт на каждом из них (ADR 0039)', () => {
    const ruk = principal('rukstroy', { constructionObjectIds: [OBJECT_A, OBJECT_B] });
    expect(canApproveRequest(ruk, onObject(OBJECT_A))).toBe(true);
    expect(canApproveRequest(ruk, onObject(OBJECT_B))).toBe(true);
    expect(approvesOwnRequestOnCreate(ruk, onObject(OBJECT_A))).toBe(true);
    expect(approvesOwnRequestOnCreate(ruk, onObject(OBJECT_B))).toBe(true);
    // Без объектов права визы не остаётся: визировать нечего — область пуста.
    expect(canApproveRequest(principal('rukstroy'), onObject(OBJECT_A))).toBe(false);
  });

  it('руководитель отдела не визирует объектную заявку (ADR 0040)', () => {
    const head = principal('department_head', { departmentIds: [DEPARTMENT_A] });
    // Право визы у роли есть — разводит их область: у отдела своих заявок на объекте не бывает.
    expect(canApproveRequest(head, onObject(OBJECT_A))).toBe(false);
    expect(approvesOwnRequestOnCreate(head, onObject(OBJECT_A))).toBe(false);
  });

  it('сама собой виза встаёт только у того, кто отвечает за объект', () => {
    const ruk = principal('rukstroy', { constructionObjectIds: [OBJECT_A] });
    expect(approvesOwnRequestOnCreate(ruk, onObject(OBJECT_A))).toBe(true);
    expect(approvesOwnRequestOnCreate(ruk, onObject(OBJECT_B))).toBe(false);
    // Право визы автовизы не даёт: администратор заводит заявку не за себя, и она ждёт визы.
    expect(canApproveRequest(principal('admin'), onObject(OBJECT_A))).toBe(true);
    expect(approvesOwnRequestOnCreate(principal('admin'), onObject(OBJECT_A))).toBe(false);
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
    expect(
      statusOf(() => assertTransitionAllowed(principal('dispatcher'), 'new', 'confirmed')),
    ).toBe(200);
    for (const type of ['operator', 'vehicle_lessor'] as CounterpartyType[]) {
      expect(
        statusOf(() =>
          assertTransitionAllowed(executor(type, COUNTERPARTY_A), 'confirmed', 'done'),
        ),
        type,
      ).toBe(200);
    }
  });

  it('несуществующий переход — 400, чужое право — 403', () => {
    const manager = principal('manager');
    // Перехода «Новая» → «Выполнена» нет ни у кого: это ошибка запроса, а не прав.
    expect(statusOf(() => assertTransitionAllowed(manager, 'new', 'done'))).toBe(400);
    // Откат существует, но только у администратора — отказ по правам.
    expect(statusOf(() => assertTransitionAllowed(manager, 'done', 'confirmed'))).toBe(403);
  });

  it('исполнителю объясняют его единственный переход — в любом из модулей', () => {
    for (const type of ['operator', 'vehicle_lessor'] as CounterpartyType[]) {
      try {
        assertTransitionAllowed(executor(type, COUNTERPARTY_A), 'new', 'confirmed');
        expect.unreachable('ожидался отказ');
      } catch (e) {
        expect((e as AppError).statusCode, type).toBe(403);
        expect((e as AppError).message, type).toContain('выполненной');
      }
    }
  });

  it('учётке без роли отказывают по правам, а не разбором переходов', () => {
    try {
      assertTransitionAllowed(principal(null), 'new', 'confirmed');
      expect.unreachable('ожидался отказ');
    } catch (e) {
      expect((e as AppError).statusCode).toBe(403);
      expect((e as AppError).message).toBe('Недостаточно прав для смены статуса');
    }
  });
});
