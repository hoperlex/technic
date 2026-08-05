import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  actsForCounterparty,
  allowedStatusTransitions,
  can,
  canTransitionStatus,
  canUse,
  COUNTERPARTY_TYPE_PERMISSIONS,
  COUNTERPARTY_TYPES,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPlaceScopedRole,
  OPERATOR_STATUS_TRANSITIONS,
  PERMISSIONS,
  permissionsFor,
  profilesWith,
  ROLE_PERMISSIONS,
  ROLES,
  type AccessSubject,
  type Permission,
  type Role,
} from '@technic/contracts';

/** Площадка для проверок правила видимости раздела (ADR 0062). */
const OBJECT_A = '11111111-1111-1111-1111-111111111111';

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

  /**
   * Вывоз мусора у отдела — набор заказчика, как у штаба (ADR 0062): заводит, правит и удаляет,
   * а ход заявки решают те, кто её исполняет. Перечислением, а не выборочной проверкой: смысл
   * набора в его границе, и «назначить исполнителя», попавшее сюда, обязано уронить тест.
   */
  it('отдел ведёт вывоз мусора как заказчик — без статусов и назначений (ADR 0062)', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      expect(
        [...permissionsFor(of(role)).filter((p) => p.startsWith('wasteRequests.'))].sort(),
        role,
      ).toEqual([
        'wasteRequests.create',
        'wasteRequests.delete',
        'wasteRequests.read',
        'wasteRequests.update',
      ]);
    }
  });

  /**
   * Правило видимости раздела (ADR 0062): право открывает модуль только вместе с непустой
   * областью. Права у отдела одни и те же — разводит их площадка, а не матрица.
   */
  it('вывоз мусора открыт отделу с площадкой и закрыт отделу без неё', () => {
    for (const role of ['department', 'department_head'] as Role[]) {
      const withObject = { ...of(role), departmentObjectIds: [OBJECT_A] };
      expect(canUse(withObject, 'wasteRequests.read'), role).toBe(true);
      const officeOnly = of(role);
      expect(can(officeOnly, 'wasteRequests.read'), role).toBe(true);
      expect(canUse(officeOnly, 'wasteRequests.read'), role).toBe(false);
      // «Заказ ТС» областью не сужается: заказчик там сам отдел, и он у роли всегда есть.
      expect(canUse(officeOnly, 'vehicleRequests.read'), role).toBe(true);
    }
  });

  it('область сужает раздел и у объектных ролей, а у остальных — нет', () => {
    expect(canUse({ role: 'shtab', constructionObjectIds: [OBJECT_A] }, 'wasteRequests.read')).toBe(
      true,
    );
    // Учётку объектной роли без объектов API активировать не даёт, но правило не должно
    // зависеть от того, удержался ли тот запрет.
    expect(canUse({ role: 'shtab' }, 'wasteRequests.read')).toBe(false);
    for (const role of ['admin', 'manager', 'dispatcher', 'observer'] as Role[]) {
      expect(canUse({ role }, 'wasteRequests.read'), role).toBe(true);
    }
    expect(canUse({ role: 'operator', counterpartyType: 'operator' }, 'wasteRequests.read')).toBe(
      true,
    );
    // Права нет — раздела нет, сколько бы области ни было.
    expect(
      canUse({ role: 'commandant', constructionObjectIds: [OBJECT_A] }, 'vehicleRequests.read'),
    ).toBe(false);
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
    // `requests.rollbackStatus` покрывает и возврат «В работе» → «Новая»: это тот же откат назад
    // по циклу, и второго права под него не заводили — иначе «кто откатывает заявки» пришлось бы
    // выяснять по двум строкам матрицы вместо одной.
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
    // Примечание исполнителя (ADR 0053) — не правка заявки: писать своё оператор может, менять
    // предмет заявки по-прежнему нет.
    expect(can(wasteOperator, 'wasteRequests.operatorComment')).toBe(true);
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
    //
    // Разошлись ровно на одном: примечание исполнителя (ADR 0053) заведено в вывозе мусора и в
    // заказе ТС не повторено. Там исполнитель появляется у заявки вместе с назначением машины
    // (ADR 0038), и до назначения «строки контрагента» у неё нет вовсе — вопрос решается своим
    // решением, а не переносом права.
    const WASTE_ONLY = ['operatorComment'];
    expect(moduleOf(vehicleLessor, 'vehicleRequests.')).toEqual(
      moduleOf(wasteOperator, 'wasteRequests.').filter((p) => !WASTE_ONLY.includes(p)),
    );
    expect(moduleOf(vehicleLessor, 'vehicleRequests.')).toEqual(['read', 'status']);
    expect(moduleOf(wasteOperator, 'wasteRequests.')).toEqual([
      'operatorComment',
      'read',
      'status',
    ]);
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
    // Поставщик (ADR 0051) — сторона договора, а не исполнитель: учётки на него не заводятся,
    // и войти в портал «от поставщика» нельзя.
    expect([...COUNTERPARTY_TYPES_WITH_ACCOUNTS]).not.toContain('supplier');
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

  /**
   * Свой коридор исполнителя (`OPERATOR_STATUS_TRANSITIONS`) заменяет общий, а не дополняет его:
   * откаты приходят из `requestStatusRollbacks` мимо коридора, и появление там возврата «В работе»
   * → «Новая» исполнителя коснуться не должно. Снятие заявки с работы — решение заказчика, а
   * исполнителю оно стёрло бы уже назначенную ему машину.
   */
  it('коридор исполнителя не расширяется новыми откатами', () => {
    for (const subject of [wasteOperator, vehicleLessor]) {
      expect(allowedStatusTransitions('confirmed', subject)).toEqual(
        OPERATOR_STATUS_TRANSITIONS.confirmed,
      );
      expect(canTransitionStatus('confirmed', 'new', subject)).toBe(false);
    }
    expect(OPERATOR_STATUS_TRANSITIONS.confirmed).not.toContain('new');
  });

  it('откат закрытой заявки идёт от права, а не от имени роли', () => {
    expect(canTransitionStatus('done', 'confirmed', of('admin'))).toBe(true);
    expect(can(of('manager'), 'requests.rollbackStatus')).toBe(false);
    expect(canTransitionStatus('done', 'confirmed', of('manager'))).toBe(false);
  });

  /**
   * Возврат «В работе» → «Новая» — тот же откат по тому же праву: заявку, взятую в работу по
   * ошибке, снимают с неё, а не заводят второй такой же. Отличается он последствием — стирает
   * назначенную технику, факт, рейс и визу, — и потому тем более не раздаётся всем, кто ведёт
   * заявки: чужую работу диспетчер стирать не должен.
   */
  it('возврат «В работе» → «Новая» доступен по тому же праву отката', () => {
    expect(canTransitionStatus('confirmed', 'new', of('admin'))).toBe(true);
    // Ход вперёд остаётся первым: откат дописывается к обычным переходам, а не вместо них.
    expect(allowedStatusTransitions('confirmed', of('admin'))).toEqual([
      'done',
      'cancelled',
      'new',
    ]);
    for (const role of ['manager', 'dispatcher'] as Role[]) {
      expect(can(of(role), 'requests.rollbackStatus'), role).toBe(false);
      expect(canTransitionStatus('confirmed', 'new', of(role)), role).toBe(false);
      // Забрали только откат: заявку в работе они по-прежнему и закрывают, и отменяют.
      expect(allowedStatusTransitions('confirmed', of(role)), role).toEqual(['done', 'cancelled']);
    }
  });
});
