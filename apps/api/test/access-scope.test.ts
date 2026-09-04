import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  can,
  ROLES,
  type CounterpartyType,
  type Permission,
  type RequestModule,
  type Role,
} from '@technic/contracts';
import {
  approvesOwnRequestOnCreate,
  approvesOwnWeeklyRequest,
  assertArchiveVisible,
  assertCan,
  assertLessorScope,
  assertOperatorScope,
  assertObjectRoleEditable,
  assertPlaceObjectScope,
  WASTE_SCOPE_LABEL,
  assertTransitionAllowed,
  assertRequestScope,
  assertVehicleRequestTypeAllowed,
  assertWeeklyRequestScope,
  canApproveRequest,
  canApproveWeeklyRequest,
  seesWholeWeeklyRequest,
  weeklyRequestReadScope,
  type WeeklyRequestReadScope,
  vehicleRequestVisibilityWhere,
  lessorVisibilityWhere,
  officeEquipmentScopeWhere,
  operatorVisibilityWhere,
  assertOfficeEquipmentScope,
  assertServiceRequestScope,
  serviceRequestVisibilityWhere,
  placeObjectVisibilityWhere,
} from '../src/lib/access';
import {
  mechRequests,
  officeEquipment,
  vehicleRequests,
  vehicles,
  wasteRequests,
} from '../src/db/schema';
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
    // Назначенные полномочия (ADR 0106, шаг 1c): по кодам наборов читается сквозная область модуля,
    // по правам — доступ. Пустые у всех, кроме фикстур визы ИТ ниже: область прочих ролей задают
    // объекты и отделы.
    grantCodes: [],
    grantPermissions: [],
    addons: [],
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
function paramsOf(condition: ReturnType<typeof placeObjectVisibilityWhere>): unknown[] {
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
    expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('штаб без объекта не видит ничего, а не всё', () => {
    const p = principal('shtab');
    expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId))).toEqual([NEVER_MATCH]);
  });

  it('руководитель строительства тоже видит только свой объект (ADR 0025)', () => {
    const p = principal('rukstroy', { constructionObjectIds: [OBJECT_A] });
    expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('комендант сужен теми же объектами: модуль у него один, а область та же', () => {
    const p = principal('commandant', { constructionObjectIds: [OBJECT_A] });
    expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId))).toEqual([OBJECT_A]);
  });

  it('остальные роли видят все объекты', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'operator'] as Role[]) {
      expect(
        placeObjectVisibilityWhere(principal(role), wasteRequests.objectId),
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
      expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId)), role).toEqual([
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
      expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId)), role).toEqual([
        NEVER_MATCH,
      ]);
    }
  });

  // Множественная привязка (ADR 0039): область объектной роли — набор, а не один объект.
  it('с несколькими объектами условие перечисляет их все, а не первый из набора', () => {
    for (const role of ['shtab', 'rukstroy', 'commandant'] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A, OBJECT_B] });
      expect(paramsOf(placeObjectVisibilityWhere(p, wasteRequests.objectId)), role).toEqual([
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
        statusOf(() => assertPlaceObjectScope(p, OBJECT_A, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(200);
      expect(
        statusOf(() => assertPlaceObjectScope(p, OBJECT_B, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(403);
    }
  });

  it('объектная роль работает с любым объектом своего набора (ADR 0039)', () => {
    for (const role of ['shtab', 'rukstroy', 'commandant'] as Role[]) {
      const p = principal(role, { constructionObjectIds: [OBJECT_A, OBJECT_B] });
      expect(
        statusOf(() => assertPlaceObjectScope(p, OBJECT_A, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(200);
      expect(
        statusOf(() => assertPlaceObjectScope(p, OBJECT_B, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(200);
      // Пустой набор — не «работает везде»: активировать такую учётку API не даёт, но проверка
      // не должна зависеть от того, удержался ли этот запрет.
      expect(
        statusOf(() => assertPlaceObjectScope(principal(role, WASTE_SCOPE_LABEL), OBJECT_A)),
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
        statusOf(() => assertPlaceObjectScope(p, OBJECT_A, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(200);
      // Отказ обязателен именно здесь: права на модуль у отдела есть, и без этой ветки сотрудник
      // отдела заводил бы заявки на любой объект компании.
      expect(
        statusOf(() => assertPlaceObjectScope(p, OBJECT_B, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(403);
    }
  });

  it('роль отдела без площадки не работает ни с одним объектом (ADR 0062)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const p = principal(role, { departmentIds: [DEPARTMENT_A] });
      expect(
        statusOf(() => assertPlaceObjectScope(p, OBJECT_A, WASTE_SCOPE_LABEL)),
        role,
      ).toBe(403);
    }
  });

  it('остальным ролям объект заявки не ограничивает работу', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'operator'] as Role[]) {
      expect(
        statusOf(() => assertPlaceObjectScope(principal(role, WASTE_SCOPE_LABEL), OBJECT_B)),
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
      statusOf(() => assertTransitionAllowed(principal('dispatcher'), 'new', 'confirmed', 'waste')),
    ).toBe(200);
    for (const [type, module] of [
      ['operator', 'waste'],
      ['vehicle_lessor', 'vehicle'],
    ] as [CounterpartyType, RequestModule][]) {
      expect(
        statusOf(() =>
          assertTransitionAllowed(executor(type, COUNTERPARTY_A), 'confirmed', 'done', module),
        ),
        type,
      ).toBe(200);
    }
  });

  it('несуществующий переход — 400, чужое право — 403', () => {
    const manager = principal('manager');
    // Перехода «Новая» → «Выполнена» нет ни у кого: это ошибка запроса, а не прав.
    expect(statusOf(() => assertTransitionAllowed(manager, 'new', 'done', 'waste'))).toBe(400);
    // Откат существует, но только у администратора — отказ по правам.
    expect(statusOf(() => assertTransitionAllowed(manager, 'done', 'confirmed', 'waste'))).toBe(
      403,
    );
    // Завершение (ADR 0135) отпирает разбор талонов: у ведущего заявки вывоза он есть — значит
    // есть и ход. А у внешнего исполнителя разбора нет: он бумагу приносит, а не принимает, —
    // отказ по правам (403), а не «недопустимый переход».
    expect(statusOf(() => assertTransitionAllowed(manager, 'done', 'completed', 'waste'))).toBe(
      200,
    );
    expect(
      statusOf(() =>
        assertTransitionAllowed(executor('operator', COUNTERPARTY_A), 'done', 'completed', 'waste'),
      ),
    ).toBe(403);
    // У заказа техники такого хода нет вовсе — это ошибка запроса.
    expect(statusOf(() => assertTransitionAllowed(manager, 'done', 'completed', 'vehicle'))).toBe(
      400,
    );
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

/**
 * Сквозная область модуля у полномочия «Согласование ИТ» (план модернизации, Р54).
 *
 * Это единственное место в портале, где выданный набор меняет **область**, а не набор действий, — и
 * потому проверяется двусторонне. Положительная половина: без неё виза бессмысленна — согласующий,
 * видящий только свой отдел, не сможет подписать ничего. Отрицательная важнее: расширение обязано
 * кончаться на границе модуля, иначе учётка ИТ тихо получает все заявки на вывоз мусора и все
 * заказы техники компании — ровно то, из-за чего ADR 0086 запрещал надстройкам трогать область.
 *
 * Фикстуры называют **коды наборов**, а не надстройки: с шага 1c область читается из назначенных
 * полномочий (ADR 0106), и `addons` у них поэтому пуст. Проверяет это не только текст — принципал с
 * одной надстройкой и без набора здесь обязан остаться суженным своим отделом.
 */
describe('сквозная область модуля оргтехники у согласующего от ИТ (Р54)', () => {
  const itApprover = principal('department', {
    departmentIds: [DEPARTMENT_A],
    grantCodes: ['office_equipment_it_approver'],
  });
  /** Та же роль и тот же отдел, но с обычным набором: область у него прежняя. */
  const operator = principal('department', {
    departmentIds: [DEPARTMENT_A],
    grantCodes: ['office_equipment_operator'],
  });
  /**
   * Держатель одной надстройки без назначения — так выглядит учётка, до которой двойная запись не
   * дошла (расхождение таблиц перехода). Область ей не расширяется: источник у неё теперь один, и
   * этот случай отделяет переключение от «оба поля читаются как раньше».
   */
  const addonOnly = principal('department', {
    departmentIds: [DEPARTMENT_A],
    addons: ['office_equipment_it_approver'],
  });

  /*
   * Спрашивается ВЕСЬ предикат видимости, а не одна ось: с этапа Э3 плана аудита исполнителей оси
   * приватны (Р2), и наружу отвечает только пара `serviceRequestVisibilityWhere` /
   * `assertServiceRequestVisible`. Для сквозной области это даже точнее: «не сужается вовсе»
   * обязано быть верно про итоговое условие запроса, а не про его слагаемое, — сложение осей
   * `and`ом умеет превращать два «сужать нечем» в сужение, и проверять надо ответ целиком.
   */
  it('заявки модуля и справочник не сужаются вовсе', () => {
    expect(serviceRequestVisibilityWhere(itApprover)).toBeUndefined();
    expect(
      officeEquipmentScopeWhere(
        itApprover,
        officeEquipment.objectId,
        officeEquipment.ownerDepartmentId,
      ),
    ).toBeUndefined();
    // Поштучные проверки отвечают так же: чужая заявка и чужая карточка ему открыты.
    expect(
      statusOf(() =>
        assertServiceRequestScope(itApprover, {
          objectId: OBJECT_B,
          customerDepartmentId: DEPARTMENT_B,
          equipmentDepartmentId: DEPARTMENT_B,
        }),
      ),
    ).toBe(200);
    expect(
      statusOf(() =>
        assertOfficeEquipmentScope(itApprover, {
          objectId: OBJECT_B,
          ownerDepartmentId: DEPARTMENT_B,
        }),
      ),
    ).toBe(200);
  });

  /**
   * Т13 ПЛАНА ПРОФИЛЕЙ (`docs/office-equipment-access-profiles-plan.md`, §6.4, §10): сквозная
   * область кончается на границе двух модулей, и «прежняя» проверяется по всем четырём соседям,
   * названным в §6.4, — вывоз, заказ ТС, механизация, путевые листы.
   *
   * Механизация добавлена сюда не для полноты счёта: у неё та же ось «площадка записи», что у
   * вывоза, и тот же предикат (`placeObjectVisibilityWhere`), — то есть ровно тот случай, когда
   * лишняя ветка в `hasModuleWideScope` открыла бы чужой модуль, ничего не сломав в этом файле.
   *
   * Путевые листы устроены иначе, и потому проверяются иначе: предиката области у модуля нет
   * вовсе — он закрыт правом целиком (`waybills.read`), — и «область прежняя» означает у него
   * «модуль как был закрыт, так и закрыт». Сравнивать там нечего, и вместо выдуманного условия
   * спрашивается то единственное, что у модуля есть: право. Держатель ИТ-набора его не получает —
   * ни ролью, ни набором.
   */
  it('в соседних модулях он остаётся собой: вывоз, ТС и механизация — по отделу, листы закрыты', () => {
    // Колонка, а не таблица: до правки Э10 здесь стояло `wasteRequests`, и условие собиралось по
    // объекту, которого у аргумента нет вовсе, — `toBeDefined` зеленел бы и на пустом сравнении.
    const waste = placeObjectVisibilityWhere(itApprover, wasteRequests.objectId);
    expect(waste, 'вывоз мусора сужен').toBeDefined();
    const vehicle = vehicleRequestVisibilityWhere(itApprover, vehicleRequests);
    expect(vehicle, 'заявки ТС сужены').toBeDefined();
    expect(paramsOf(vehicle)).toContain(DEPARTMENT_A);
    const mech = placeObjectVisibilityWhere(itApprover, mechRequests.objectId);
    expect(mech, 'механизация сужена').toBeDefined();
    // Та же роль без набора отвечает тем же условием: набор области соседа не трогает ни в одну
    // сторону — ни расширяет, ни сужает.
    const mechPlain = placeObjectVisibilityWhere(
      principal('department', { departmentIds: [DEPARTMENT_A] }),
      mechRequests.objectId,
    );
    expect(paramsOf(mech)).toEqual(paramsOf(mechPlain));
    // Путевые листы: у модуля предиката области нет — «прежняя» означает «модуль закрыт правом».
    expect(can(itApprover, 'waybills.read'), 'журнал листов закрыт держателю ИТ-набора').toBe(false);
    expect(can(itApprover, 'waybills.cancel')).toBe(false);
  });

  it('второй набор область не трогает — решение 2 ADR 0086 в силе', () => {
    expect(
      serviceRequestVisibilityWhere(operator),
      'оператор оргтехники видит только свой отдел',
    ).toBeDefined();
    expect(
      statusOf(() =>
        assertServiceRequestScope(operator, {
          objectId: OBJECT_B,
          customerDepartmentId: DEPARTMENT_B,
          equipmentDepartmentId: DEPARTMENT_B,
        }),
      ),
    ).toBe(403);
  });

  it('область читается из наборов: одной надстройки без назначения для неё мало', () => {
    expect(
      serviceRequestVisibilityWhere(addonOnly),
      'без назначения область прежняя — свой отдел',
    ).toBeDefined();
    expect(
      officeEquipmentScopeWhere(
        addonOnly,
        officeEquipment.objectId,
        officeEquipment.ownerDepartmentId,
      ),
    ).toBeDefined();
    expect(
      statusOf(() =>
        assertServiceRequestScope(addonOnly, {
          objectId: OBJECT_B,
          customerDepartmentId: DEPARTMENT_B,
          equipmentDepartmentId: DEPARTMENT_B,
        }),
      ),
    ).toBe(403);
  });
});

/**
 * Недельная заявка: область считается парой «право + ось» (план реструктуризации доступа §11,
 * этап 6) — недели своей площадки ведёт тот, у кого есть право и объектная ось; все недели — тот, у
 * кого право есть, а своей оси нет. Раньше здесь стояло перечисление ролей по именам, и слияние
 * ролей (§15, этапы 7–9) сменило бы ему смысл молча: имя исчезает, условие остаётся.
 *
 * Таблица ниже — обе половины пары разом: слева права роли, справа её площадки. Читается она как
 * ответ на вопрос «почему этот субъект не ведёт неделю»: у коменданта, наблюдателя и службы
 * главного механика ответ даёт **левая** колонка (прав нет), у отдела, арендодателя и водителя —
 * **правая** (площадки нет). Обе колонки — литеральные ожидания, а не вычисления теми же
 * предикатами: посчитай мы ожидание проверяемым кодом, тест остался бы зелёным на сломанной паре.
 *
 * Полнота по `ROLES` обязательна и проверяется отдельно. Ветка «своей оси нет — все площадки»
 * безопасна ровно до тех пор, пока каждая роль в этой таблице названа: роль, забытая в списках осей
 * `enums.ts`, попадёт в неё молча — и получит недели всех площадок компании.
 */
describe('недельная заявка: область по роли (план §11)', () => {
  /** Третья площадка: ни объект учётки, ни площадка её отдела — заведомо чужая любой оси. */
  const OBJECT_C = '77777777-7777-7777-7777-777777777777';

  /** Короткие имена прав модуля — таблица читается ими, а не полными строками словаря. */
  type WeeklyPermission = 'read' | 'create' | 'update' | 'approve';
  const permissionOf = (short: WeeklyPermission): Permission => `weeklyRequests.${short}`;

  interface WeeklyRoleCase {
    /** Права модуля у роли по матрице (`ROLE_PERMISSIONS`) — левая половина пары. */
    permissions: readonly WeeklyPermission[];
    /** Что роль видит на чтении (`weeklyRequestReadScope`). */
    read: WeeklyRequestReadScope;
    /**
     * Проходит ли **область ведения** (`assertWeeklyRequestScope`) по своей площадке и по чужой.
     * Это ответ одной правой половины пары: право на маршруте спрашивает страж, и «да» здесь у
     * роли без прав модуля означает не доступ, а «областью не ограничена» — до обработчика она не
     * доходит. Пара сводится воедино в проверке «кто ведёт неделю на самом деле» ниже.
     */
    manages: { own: boolean; foreign: boolean };
    /** Виза своей и чужой площадки (`canApproveWeeklyRequest`) — здесь право уже учтено. */
    approves: { own: boolean; foreign: boolean };
    /** Применяется ли своя подача сразу, без отдельной визы (`approvesOwnWeeklyRequest`). */
    selfApplies: boolean;
  }

  const BY_ROLE: Record<Role, WeeklyRoleCase> = {
    // Офис ведёт неделю на любой площадке: своей оси у него нет, и сужать ему нечего.
    admin: {
      permissions: ['read', 'create', 'update', 'approve'],
      read: { kind: 'all' },
      manages: { own: true, foreign: true },
      approves: { own: true, foreign: true },
      // Виза у администратора есть, но подписью площадки она не становится: он действует не за
      // объект (ADR 0032), и его заявка ждёт визы наравне с остальными.
      selfApplies: false,
    },
    manager: {
      permissions: ['read', 'create', 'update'],
      read: { kind: 'all' },
      manages: { own: true, foreign: true },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    dispatcher: {
      permissions: ['read', 'create', 'update'],
      read: { kind: 'all' },
      manages: { own: true, foreign: true },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    // Площадка: свои объекты и только они — на чтении, на ведении и на визе.
    shtab: {
      permissions: ['read', 'create', 'update'],
      read: { kind: 'objects', objectIds: [OBJECT_A] },
      manages: { own: true, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    rukstroy: {
      permissions: ['read', 'create', 'update', 'approve'],
      read: { kind: 'objects', objectIds: [OBJECT_A] },
      manages: { own: true, foreign: false },
      approves: { own: true, foreign: false },
      // Единственная роль, у которой подача применяет заявку: подпись за площадку ставит тот, кто
      // за площадку отвечает (план Р8).
      selfApplies: true,
    },
    /*
     * Комендант — та самая роль, на которой пара «право + ось» проверяется на честность. Объектная
     * ось у него есть, и область его недельными заявками не ограничивает; закрыт модуль **правом**
     * — недельных прав у роли нет ни одного, и ни один маршрут его внутрь не пускает. Ось здесь
     * оставлена работать намеренно: запрет по имени роли пережил бы саму роль, а выданное однажды
     * право с ним не заработало бы вовсе — набор оказался бы выдан и мёртв.
     */
    commandant: {
      permissions: [],
      read: { kind: 'none' },
      manages: { own: true, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    /*
     * Площадка (ADR 0112) — новая объектная роль, и в этой таблице она **копия коменданта**: ось
     * своя, объектная, а недельных прав нет ни одного. Так и задумано: недели приезжают ей
     * полномочием «Заказ техники», а виза — «Визой объекта», и до выдачи набора строка обязана
     * читаться как «модуль закрыт правом».
     *
     * Строка эта — доказательство, что пара «право + ось» переписана не зря. Ни `weeklyRequestReadScope`,
     * ни `managesWeeklyRequestObject` про роль `site` не знают вовсе: они спрашивают ось
     * (`roleScopeAxis`), а имени роли в них нет. Единственное, что понадобилось от реформы, — строка
     * в `OBJECT_SCOPED_ROLES`; всё остальное сошлось само.
     */
    site: {
      permissions: [],
      read: { kind: 'none' },
      manages: { own: true, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    // Отдел читает неделю площадки **своего отдела** (ADR 0062) — производной областью, не своими
    // объектами. Ведения и визы у него нет с обеих сторон пары: и права, и площадки.
    department: {
      permissions: ['read'],
      read: { kind: 'objects', objectIds: [OBJECT_B] },
      manages: { own: false, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    department_head: {
      permissions: ['read'],
      read: { kind: 'objects', objectIds: [OBJECT_B] },
      manages: { own: false, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    // Арендодатель (учётка заведена парой «роль + тип контрагента»): недели ему открывает его же
    // техника в составе, площадка ему не принадлежит ни в каком смысле.
    operator: {
      permissions: ['read'],
      read: { kind: 'lessor', counterpartyId: COUNTERPARTY_A },
      manages: { own: false, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    // Наблюдатель (ADR 0033): читает все недели и не ведёт ни одной — ровно потому, что права у
    // него одно, на чтение. Область его не ограничивает, и это не послабление: без права ведения
    // до неё он не доходит.
    observer: {
      permissions: ['read'],
      read: { kind: 'all' },
      manages: { own: true, foreign: true },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    // Водитель: своя, четвёртая ось (ADR 0102). Неделя принадлежит площадке, а не работнику, и
    // ветка оси отвечает «ни одной» — чтобы право, попавшее в кабинет, открыло пустоту.
    driver: {
      permissions: [],
      read: { kind: 'none' },
      manages: { own: false, foreign: false },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    // Служба главного механика: своей оси нет по должности, недельных прав нет тоже — модуль
    // закрыт левой колонкой, как у коменданта.
    mechanic: {
      permissions: [],
      read: { kind: 'none' },
      manages: { own: true, foreign: true },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
    chief_mechanic: {
      permissions: [],
      read: { kind: 'none' },
      manages: { own: true, foreign: true },
      approves: { own: false, foreign: false },
      selfApplies: false,
    },
  };

  /**
   * Учётка роли со **всеми** заполненными областями: свои объекты, отделы, площадка отдела и
   * контрагент. Заполнены все четыре нарочно — предикат обязан выбирать ось сам, а не по тому, что
   * осталось непустым. Площадка отдела намеренно другая (`OBJECT_B`): перепутай предикат две
   * объектные области местами, и таблица это увидит.
   *
   * Исполнитель заводится арендодателем: из трёх типов контрагента с учётками недельную заявку
   * открывает только он — у оператора вывоза и сервисной компании нет и права.
   */
  function subjectOf(role: Role): Principal {
    return principal(role, {
      constructionObjectIds: [OBJECT_A],
      departmentIds: [DEPARTMENT_A],
      departmentObjectIds: [OBJECT_B],
      counterpartyId: COUNTERPARTY_A,
      counterpartyType: role === 'operator' ? 'vehicle_lessor' : null,
    });
  }

  it('в таблице перечислены все роли словаря', () => {
    // `Record<Role, …>` держит полноту на компиляции, но прогон её не проверяет: новая роль,
    // добавленная в словарь, обязана получить строку здесь, а не молча уехать в ветку «оси нет».
    expect([...Object.keys(BY_ROLE)].sort()).toEqual([...ROLES].sort());
  });

  it('права модуля у роли — по таблице', () => {
    for (const role of ROLES) {
      const p = subjectOf(role);
      const all: WeeklyPermission[] = ['read', 'create', 'update', 'approve'];
      expect(
        all.filter((short) => can(p, permissionOf(short))),
        role,
      ).toEqual(BY_ROLE[role].permissions);
    }
  });

  it('область чтения — по таблице', () => {
    for (const role of ROLES) {
      expect(weeklyRequestReadScope(subjectOf(role)), role).toEqual(BY_ROLE[role].read);
    }
  });

  it('область ведения — по таблице, на своей площадке и на чужой', () => {
    for (const role of ROLES) {
      const p = subjectOf(role);
      const expected = BY_ROLE[role].manages;
      expect(
        statusOf(() => assertWeeklyRequestScope(p, OBJECT_A)),
        `${role} — своя`,
      ).toBe(expected.own ? 200 : 403);
      expect(
        statusOf(() => assertWeeklyRequestScope(p, OBJECT_C)),
        `${role} — чужая`,
      ).toBe(expected.foreign ? 200 : 403);
    }
  });

  it('виза — по таблице, на своей площадке и на чужой', () => {
    for (const role of ROLES) {
      const p = subjectOf(role);
      expect(canApproveWeeklyRequest(p, OBJECT_A), `${role} — своя`).toBe(
        BY_ROLE[role].approves.own,
      );
      expect(canApproveWeeklyRequest(p, OBJECT_C), `${role} — чужая`).toBe(
        BY_ROLE[role].approves.foreign,
      );
      expect(approvesOwnWeeklyRequest(p, OBJECT_A), `${role} — подача применяет`).toBe(
        BY_ROLE[role].selfApplies,
      );
    }
  });

  /**
   * Сведение обеих половин пары в живой ответ модуля — и второе, независимое от таблицы, ожидание:
   * перечни ролей написаны должностями, как их знает заказчик. Ошибись таблица клеткой — разойтись
   * ей придётся сразу с двумя записями, а не с собственным продолжением.
   */
  it('живой ответ: неделю ведут пятеро, визирует руководитель строительства своей площадки', () => {
    const leads = ROLES.filter(
      (role) => BY_ROLE[role].permissions.includes('update') && BY_ROLE[role].manages.own,
    );
    expect(leads).toEqual(['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy']);

    const approves = ROLES.filter((role) => BY_ROLE[role].approves.own);
    expect(approves).toEqual(['admin', 'rukstroy']);

    const reads = ROLES.filter((role) => BY_ROLE[role].read.kind !== 'none');
    expect(reads).toEqual([
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'operator',
      'observer',
    ]);
  });

  it('весь состав документа скрыт только от арендодателя', () => {
    const hidden = ROLES.filter((role) => !seesWholeWeeklyRequest(subjectOf(role)));
    expect(hidden).toEqual(['operator']);
  });

  // Тип контрагента решает не только модуль, но и саму видимость: недельная заявка открывается
  // арендодателю и никому больше из исполнителей — у остальных нет и права.
  it('исполнитель другого предмета не видит ни одной недели', () => {
    for (const type of ['operator', 'service'] as CounterpartyType[]) {
      expect(weeklyRequestReadScope(executor(type, COUNTERPARTY_A)), type).toEqual({
        kind: 'none',
      });
    }
  });

  // «Контрагент не назван» — это не «ограничений нет»: без него неизвестно, чья техника в составе.
  it('арендодатель без контрагента не видит ни одной недели', () => {
    expect(weeklyRequestReadScope(executor('vehicle_lessor', null))).toEqual({ kind: 'none' });
  });

  // Пустая область — «не видит ничего», а не «видит всё»: у площадки это состояние, которого API не
  // допускает, у отдела без площадки — рабочее (ПТО, АХО).
  it('пустая область не открывает ни одной недели ни на одной оси', () => {
    const shtab = principal('shtab');
    expect(weeklyRequestReadScope(shtab)).toEqual({ kind: 'objects', objectIds: [] });
    expect(statusOf(() => assertWeeklyRequestScope(shtab, OBJECT_A))).toBe(403);
    expect(weeklyRequestReadScope(principal('department'))).toEqual({
      kind: 'objects',
      objectIds: [],
    });
  });

  // Учётка без роли: прав у неё нет ни одного, и «своей оси нет» для неё означает «ни одной
  // площадки», а не «все». До предикатов она доходит, только если проверка права не удержалась.
  it('учётка без роли не видит и не ведёт ничего', () => {
    const none = principal(null);
    expect(weeklyRequestReadScope(none)).toEqual({ kind: 'none' });
    expect(canApproveWeeklyRequest(none, OBJECT_A)).toBe(false);
    expect(statusOf(() => assertWeeklyRequestScope(none, OBJECT_A))).toBe(403);
  });
});
