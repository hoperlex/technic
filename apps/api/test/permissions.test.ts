import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  actsForCounterparty,
  allowedStatusTransitions,
  can,
  canTransitionStatus,
  COUNTERPARTY_TYPE_PERMISSIONS,
  COUNTERPARTY_TYPES,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPlaceScopedRole,
  PERMISSIONS,
  permissionsFor,
  profilesWith,
  ROLE_PERMISSIONS,
  ROLES,
  type AccessSubject,
  type Permission,
  type Role,
} from '@technic/contracts';

/** Субъект доступа роли без контрагента: у всех ролей, кроме исполнителя, он совпадает с ролью. */
const of = (role: Role): AccessSubject => ({ role });
/** Внешний исполнитель: роль плюс тип контрагента — модуль работы задаёт он (ADR 0038). */
const wasteOperator: AccessSubject = { role: 'operator', counterpartyType: 'operator' };
const vehicleLessor: AccessSubject = { role: 'operator', counterpartyType: 'vehicle_lessor' };

describe('матрица прав', () => {
  it('у каждой роли объявлен свой набор прав, и все права из него существуют', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role], role).toBeDefined();
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(known.has(permission), `${role}: ${permission}`).toBe(true);
      }
    }
  });

  it('у каждого типа контрагента объявлен свой набор прав, и все права из него существуют', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const type of COUNTERPARTY_TYPES) {
      expect(COUNTERPARTY_TYPE_PERMISSIONS[type], type).toBeDefined();
      for (const permission of COUNTERPARTY_TYPE_PERMISSIONS[type]) {
        expect(known.has(permission), `${type}: ${permission}`).toBe(true);
      }
    }
  });

  it('каждое право кому-то выдано: право без субъектов — забытая строка матрицы', () => {
    const orphaned = PERMISSIONS.filter((p) => profilesWith(p).length === 0);
    expect(orphaned).toEqual([]);
  });

  it('учётка без роли не может ничего', () => {
    for (const permission of PERMISSIONS) {
      expect(can(null, permission), permission).toBe(false);
      expect(can({ role: null }, permission), permission).toBe(false);
    }
    expect(permissionsFor(null)).toEqual([]);
  });

  it('администратор может всё', () => {
    for (const permission of PERMISSIONS) {
      expect(can(of('admin'), permission), permission).toBe(true);
    }
  });
});

describe('права ролей', () => {
  it('диспетчер ведёт справочники наравне с менеджером', () => {
    expect(can(of('dispatcher'), 'directories.write')).toBe(true);
    expect([...ROLE_PERMISSIONS.dispatcher].sort()).toEqual([...ROLE_PERMISSIONS.manager].sort());
  });

  it('справочники читают все роли — без них не заполнить форму заявки', () => {
    for (const role of ROLES) expect(can(of(role), 'directories.read'), role).toBe(true);
  });

  it('справочники правят только те, кто их ведёт', () => {
    expect(profilesWith('directories.write').map((s) => s.role)).toEqual([
      'admin',
      'manager',
      'dispatcher',
    ]);
  });

  it('руководитель строительства ведёт заявки своего объекта и визирует технику (ADR 0025, 0031)', () => {
    expect(can(of('rukstroy'), 'vehicleRequests.create')).toBe(true);
    expect(can(of('rukstroy'), 'vehicleRequests.update')).toBe(true);
    expect(can(of('rukstroy'), 'vehicleRequests.delete')).toBe(true);
    expect(can(of('rukstroy'), 'vehicleRequests.approve')).toBe(true);
    // Статусы заявки ведут те, кто её обрабатывает: виза — не смена статуса.
    expect(can(of('rukstroy'), 'vehicleRequests.status')).toBe(false);
    expect(can(of('rukstroy'), 'directories.write')).toBe(false);
  });

  /**
   * Вывоз мусора у руководителя строительства и штаба — один набор прав (ADR 0031), а не два
   * похожих списка: разойдясь, они дадут двум заказчикам одного объекта разный портал.
   * Сравнением, а не перечислением: новое право вывоза у штаба обязано появиться и здесь.
   */
  it('руководитель строительства ведёт вывоз мусора наравне со штабом (ADR 0031)', () => {
    const wasteOf = (role: Role) =>
      permissionsFor(of(role))
        .filter((p) => p.startsWith('wasteRequests.'))
        .sort();
    expect(wasteOf('rukstroy')).toEqual(wasteOf('shtab'));
    expect(wasteOf('rukstroy')).not.toEqual([]);
    // Исполнение остаётся за теми, кто заявку обрабатывает: заказчик её только заводит.
    expect(can(of('rukstroy'), 'wasteRequests.status')).toBe(false);
    expect(can(of('rukstroy'), 'wasteRequests.assignOperator')).toBe(false);
  });

  it('визирует заказчик, а не тот, кто обрабатывает заявку', () => {
    // Заказчиков двое: объект и отдел (ADR 0040). Право визы у них одно, разводит их область —
    // руководитель строительства визирует свои объекты, руководитель отдела — свои отделы.
    expect(profilesWith('vehicleRequests.approve').map((s) => s.role)).toEqual([
      'admin',
      'rukstroy',
      'department_head',
    ]);
  });

  /**
   * Отдел (ADR 0040) — заказчик со стороны офиса. Сотрудник и руководитель отдела различаются
   * ровно визой, как штаб и руководитель строительства на объекте. Сравнением, а не
   * перечислением: новое право у сотрудника обязано появиться и у руководителя.
   */
  it('руководитель отдела = сотрудник отдела плюс виза (ADR 0040)', () => {
    const withoutApprove = (role: Role) =>
      permissionsFor(of(role))
        .filter((p) => p !== 'vehicleRequests.approve')
        .sort();
    expect(withoutApprove('department_head')).toEqual(withoutApprove('department'));
    expect(can(of('department_head'), 'vehicleRequests.approve')).toBe(true);
    expect(can(of('department'), 'vehicleRequests.approve')).toBe(false);
  });

  it('отдел не ведёт вывоз мусора: мусор вывозят с площадки, а не из кабинета', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      expect(
        permissionsFor(of(role)).filter((p) => p.startsWith('wasteRequests.')),
        role,
      ).toEqual([]);
    }
  });

  it('отдел работает в пределах отдела, а не объекта (ADR 0040)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      expect(isDepartmentScopedRole(role), role).toBe(true);
      expect(isObjectScopedRole(role), role).toBe(false);
      expect(isPlaceScopedRole(role), role).toBe(true);
    }
    // Объектные роли на второй оси не оказываются: одна учётка — одна ось.
    for (const role of ['shtab', 'rukstroy'] as Role[]) {
      expect(isDepartmentScopedRole(role), role).toBe(false);
      expect(isPlaceScopedRole(role), role).toBe(true);
    }
  });

  /**
   * Наблюдатель (ADR 0033) — роль без единого действия: перечислением прав, а не выборочными
   * проверками, потому что смысл роли в том, чего у неё нет. Новое право, попавшее сюда по
   * недосмотру, обязано уронить этот тест.
   */
  it('наблюдатель только смотрит: три права на чтение и ничего больше (ADR 0033)', () => {
    expect([...permissionsFor(of('observer'))].sort()).toEqual([
      'directories.read',
      'vehicleRequests.read',
      'wasteRequests.read',
    ]);
    // Оба модуля заявок видны целиком, без сужения по объекту.
    expect(isObjectScopedRole('observer')).toBe(false);
    expect(allowedStatusTransitions('new', of('observer'))).toEqual([]);
  });

  it('объектные роли работают в пределах своего объекта', () => {
    expect(isObjectScopedRole('shtab')).toBe(true);
    expect(isObjectScopedRole('rukstroy')).toBe(true);
    expect(isObjectScopedRole('commandant')).toBe(true);
    for (const role of ['admin', 'manager', 'dispatcher', 'operator', 'observer'] as const) {
      expect(isObjectScopedRole(role), role).toBe(false);
    }
    expect(isObjectScopedRole(null)).toBe(false);
  });

  it('штаб заводит заявки обоих модулей, но не ведёт их статусы', () => {
    expect(can(of('shtab'), 'wasteRequests.create')).toBe(true);
    expect(can(of('shtab'), 'vehicleRequests.create')).toBe(true);
    expect(can(of('shtab'), 'wasteRequests.status')).toBe(false);
    expect(can(of('shtab'), 'vehicleRequests.status')).toBe(false);
    expect(can(of('shtab'), 'directories.write')).toBe(false);
  });

  /**
   * Комендант — заказчик на объекте по одному модулю: вывоз мусора он ведёт наравне со штабом,
   * технику не заказывает вовсе. Вывоз — сравнением, а не перечислением: разойдясь, два заказчика
   * одной площадки получили бы разный портал на одну и ту же заявку.
   */
  it('комендант ведёт вывоз мусора наравне со штабом', () => {
    const wasteOf = (role: Role) =>
      permissionsFor(of(role))
        .filter((p) => p.startsWith('wasteRequests.'))
        .sort();
    expect(wasteOf('commandant')).toEqual(wasteOf('shtab'));
    expect(wasteOf('commandant')).not.toEqual([]);
    // Исполнение остаётся за теми, кто заявку обрабатывает: заказчик её только заводит.
    expect(can(of('commandant'), 'wasteRequests.status')).toBe(false);
    expect(can(of('commandant'), 'wasteRequests.assignOperator')).toBe(false);
  });

  /**
   * Модуль техники закрыт коменданту целиком — правом, а не спрятанной вкладкой: иначе чужой
   * заказ техники по его объекту открывался бы прямой ссылкой. Перечислением, потому что смысл
   * роли ровно в этом: право модуля, попавшее сюда по недосмотру, обязано уронить проверку.
   */
  it('комендант не заказывает технику: модуль закрыт целиком', () => {
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('vehicleRequests.'))) {
      expect(can(of('commandant'), permission), permission).toBe(false);
    }
    expect([...permissionsFor(of('commandant'))].sort()).toEqual([
      'directories.read',
      'wasteRequests.create',
      'wasteRequests.delete',
      'wasteRequests.read',
      'wasteRequests.update',
    ]);
  });

  it('архив, откаты и учётки — только администратору', () => {
    const adminOnly: Permission[] = [
      'archive.read',
      'archive.restore',
      'requests.rollbackStatus',
      'records.purge',
      'users.manage',
      'audit.read',
    ];
    for (const permission of adminOnly) {
      expect(
        profilesWith(permission).map((s) => s.role),
        permission,
      ).toEqual(['admin']);
    }
  });
});

/**
 * Права внешнего исполнителя (ADR 0038) следуют из типа его контрагента: роль отвечает «кем он
 * работает», тип — «по какому предмету». Проверки здесь именно про эту зависимость: одна роль
 * без контрагента модульных прав не даёт, а два типа не пересекаются ни одним модулем.
 */
describe('права внешнего исполнителя зависят от типа контрагента (ADR 0038)', () => {
  it('роль исполнителя сама по себе даёт только чтение справочников', () => {
    expect([...permissionsFor(of('operator'))]).toEqual(['directories.read']);
    expect(isCounterpartyScopedRole('operator')).toBe(true);
  });

  it('оператор вывоза: свои заявки вывоза читает и закрывает, заказ ТС ему закрыт', () => {
    expect(can(wasteOperator, 'wasteRequests.read')).toBe(true);
    expect(can(wasteOperator, 'wasteRequests.status')).toBe(true);
    expect(can(wasteOperator, 'wasteRequests.create')).toBe(false);
    expect(can(wasteOperator, 'wasteRequests.update')).toBe(false);
    expect(can(wasteOperator, 'wasteRequests.delete')).toBe(false);
    expect(can(wasteOperator, 'wasteRequests.assignOperator')).toBe(false);
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('vehicleRequests.'))) {
      expect(can(wasteOperator, permission), permission).toBe(false);
    }
  });

  it('арендодатель ТС: те же права в заказе техники, что у оператора в вывозе', () => {
    const moduleOf = (subject: AccessSubject, prefix: string) =>
      permissionsFor(subject)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .sort();
    // Сравнением, а не перечислением: новое право у оператора вывоза — это решение про
    // исполнителя вообще, и здесь оно обязано появиться тоже (либо разойтись осознанно).
    expect(moduleOf(vehicleLessor, 'vehicleRequests.')).toEqual(
      moduleOf(wasteOperator, 'wasteRequests.'),
    );
    expect(moduleOf(vehicleLessor, 'vehicleRequests.')).toEqual(['read', 'status']);
    // Вывоз мусора арендодателю закрыт целиком — ровно так же, как ему закрыт заказ ТС.
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('wasteRequests.'))) {
      expect(can(vehicleLessor, permission), permission).toBe(false);
    }
  });

  it('исполнитель без контрагента не работает ни в одном модуле', () => {
    for (const permission of PERMISSIONS.filter((p) => p.endsWith('.read'))) {
      const allowed = can({ role: 'operator', counterpartyType: null }, permission);
      expect(allowed, permission).toBe(permission === 'directories.read');
    }
  });

  it('учётки заводятся только на тех контрагентов, за которых кто-то работает', () => {
    expect([...COUNTERPARTY_TYPES_WITH_ACCOUNTS]).toEqual(['operator', 'vehicle_lessor']);
    for (const type of COUNTERPARTY_TYPES) {
      const hasAccounts = COUNTERPARTY_TYPES_WITH_ACCOUNTS.includes(type);
      expect(COUNTERPARTY_TYPE_PERMISSIONS[type].length > 0, type).toBe(hasAccounts);
    }
  });

  it('тип контрагента даёт права только роли, которая от контрагента и работает', () => {
    // У «Менеджера» контрагента не бывает, и подставленный тип его прав не меняет.
    const manager: AccessSubject = { role: 'manager', counterpartyType: 'vehicle_lessor' };
    expect([...permissionsFor(manager)].sort()).toEqual([...permissionsFor(of('manager'))].sort());
    expect(actsForCounterparty(manager, 'vehicle_lessor')).toBe(false);
    expect(actsForCounterparty(vehicleLessor, 'vehicle_lessor')).toBe(true);
    expect(actsForCounterparty(vehicleLessor, 'operator')).toBe(false);
  });

  it('профили доступа перечисляют исполнителя по разу на каждый тип контрагента', () => {
    expect(ACCESS_PROFILES.filter((s) => s.role === 'operator')).toEqual([
      wasteOperator,
      vehicleLessor,
    ]);
    // Остальные роли — по одному профилю: контрагента у них нет.
    expect(ACCESS_PROFILES.filter((s) => s.role !== 'operator')).toHaveLength(ROLES.length - 1);
    expect(accessProfileLabel(vehicleLessor)).toBe(
      'Оператор (внешний исполнитель) — Арендодатель (ТС)',
    );
  });
});

describe('переходы статусов следуют из прав', () => {
  it('роль без права на статус не меняет его вовсе', () => {
    expect(allowedStatusTransitions('new', of('shtab'))).toEqual([]);
    expect(canTransitionStatus('new', 'confirmed', of('shtab'))).toBe(false);
  });

  it('у исполнителя один переход — закрыть взятую в работу заявку, в любом из модулей', () => {
    for (const subject of [wasteOperator, vehicleLessor]) {
      expect(allowedStatusTransitions('confirmed', subject)).toEqual(['done']);
      expect(allowedStatusTransitions('new', subject)).toEqual([]);
      expect(canTransitionStatus('new', 'cancelled', subject)).toBe(false);
    }
    // Без контрагента модульного права на статус нет — значит нет и перехода.
    expect(allowedStatusTransitions('confirmed', of('operator'))).toEqual([]);
  });

  it('откат закрытой заявки идёт от права, а не от имени роли', () => {
    expect(canTransitionStatus('done', 'confirmed', of('admin'))).toBe(true);
    expect(can(of('manager'), 'requests.rollbackStatus')).toBe(false);
    expect(canTransitionStatus('done', 'confirmed', of('manager'))).toBe(false);
  });
});
