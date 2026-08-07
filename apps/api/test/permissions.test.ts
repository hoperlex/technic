import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  actsForCounterparty,
  allowedServiceStatusTransitions,
  allowedStatusTransitions,
  can,
  canTransitionStatus,
  canUse,
  COUNTERPARTY_TYPE_PERMISSIONS,
  COUNTERPARTY_TYPES,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPlaceScopedRole,
  OPERATOR_STATUS_TRANSITIONS,
  PERMISSIONS,
  permissionsFor,
  profilesWith,
  ROLE_ADDON_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  SERVICE_REQUEST_PERMISSIONS,
  type AccessSubject,
  type CounterpartyType,
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
/** Сервисная компания (ADR 0085) — третий тип с учётками: исполнитель заявок на обслуживание. */
const serviceCompany: AccessSubject = { role: 'operator', counterpartyType: 'service' };

/** Заказчики модуля обслуживания (ADR 0085): площадка и офис — по две роли с каждой стороны. */
const SERVICE_CUSTOMER_ROLES: Role[] = ['shtab', 'rukstroy', 'department', 'department_head'];

/** Оператор оргтехники (ADR 0086) — надстройка на своих базовых ролях. */
const officeOperators: AccessSubject[] = [
  { role: 'shtab', addons: ['office_equipment_operator'] },
  { role: 'department', addons: ['office_equipment_operator'] },
];

/**
 * Профиль без надстроек (ADR 0086) — субъект «роль как есть» (плюс тип контрагента у исполнителя).
 * Надстройка выдаётся поимённо, конкретной учётке, а роль означает «всем, кто так работает»: круги
 * этих двух ответов считаются по отдельности и сравниваются тоже по отдельности.
 */
const isPlainProfile = (s: AccessSubject): boolean => !s.addons?.length;

/** Роли, которым право даёт сама роль, — обратный поиск без профилей с надстройкой. */
const rolesWith = (permission: Permission): (Role | null)[] =>
  profilesWith(permission)
    .filter(isPlainProfile)
    .map((s) => s.role);

/** Профили, у которых право есть при надстройке (ADR 0086), — второй половиной того же поиска. */
const addonProfilesWith = (permission: Permission): AccessSubject[] =>
  profilesWith(permission).filter((s) => !isPlainProfile(s));

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

  /**
   * Надстройка (ADR 0086) — третий источник прав, и в матрице она обязана оставаться добавкой:
   * профиль с надстройкой отличается от своей базовой роли ровно на её права — не больше и не в
   * другую сторону. Проверка идёт по всем профилям сразу, а не по одному штабу: следующая
   * надстройка попадёт сюда сама, и первое же лишнее право уронит тест — в том числе право,
   * приписанное надстройке вместо роли (тогда оно потерялось бы у всех, кому надстройку не выдали).
   */
  it('профиль с надстройкой = базовая роль плюс права надстройки', () => {
    const withAddons = ACCESS_PROFILES.filter((s) => !isPlainProfile(s));
    expect(withAddons).not.toEqual([]);
    for (const profile of withAddons) {
      const granted = (profile.addons ?? []).flatMap((addon) => ROLE_ADDON_PERMISSIONS[addon]);
      expect(new Set(permissionsFor(profile)), accessProfileLabel(profile)).toEqual(
        new Set([...permissionsFor({ role: profile.role }), ...granted]),
      );
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

  /**
   * Справочник оргтехники (ADR 0085) — своя пара прав, а не общая справочниковая. Чтение шире
   * ведения ровно потому, что заявку на ремонт заводят по конкретной единице: не увидев карточек,
   * заказчик не выберет ту, которая сломалась. Перечислением, а не выборочными проверками: круг
   * читающих — это и есть решение, и роль, попавшая сюда по недосмотру, обязана уронить тест.
   *
   * С ADR 0086 ведение получают четвёртым способом — надстройкой «Оператор (оргтехника)», — и это
   * не отменяет главного: ролью справочник по-прежнему ведут те же трое, кто ведёт остальные.
   * Круги считаются по отдельности (`rolesWith` против `addonProfilesWith`) именно поэтому: сложи
   * их в один список — и право, случайно выданное целой роли, затерялось бы среди выданных
   * поимённо, а тест бы этого не заметил.
   */
  it('справочник оргтехники: читают заказчики и наблюдатель, ведут те же, кто ведёт справочники', () => {
    expect(rolesWith('officeEquipment.read')).toEqual([
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'observer',
    ]);
    expect(rolesWith('officeEquipment.write')).toEqual(['admin', 'manager', 'dispatcher']);
    // Надстройка — единственная добавка к этому кругу, и достаётся она ровно тем двум базовым
    // ролям, за которыми справочник закреплён (ADR 0086): площадке и офису. Пара сверх этих двух
    // означала бы ведение парка, которого никто не назначал.
    expect(addonProfilesWith('officeEquipment.write').map(accessProfileLabel)).toEqual([
      'Штаб + Оператор (оргтехника)',
      'Отдел + Оператор (оргтехника)',
    ]);
    // Чтение надстройка не расширяет: его базовые роли и так имеют, а больше её никому не дают.
    expect(addonProfilesWith('officeEquipment.read').map(accessProfileLabel)).toEqual([
      'Штаб + Оператор (оргтехника)',
      'Отдел + Оператор (оргтехника)',
    ]);
    // Комендант закрыт целиком, как и в «Заказе ТС»: оргтехнику на площадке заказывает штаб, а
    // `directories.read` (оно у коменданта есть) карточку единицы не открывает — право своё.
    expect(can(of('commandant'), 'officeEquipment.read')).toBe(false);
    expect(can(of('commandant'), 'officeEquipment.write')).toBe(false);
    expect(can(of('commandant'), 'directories.read')).toBe(true);
    // Заказчики только читают: справочник ведёт ответственный за оргтехнику, а не тот, кто подаёт
    // заявку на ремонт. Ролью — никто из них: надстройка выдаётся учётке, и «штаб» вообще ей не
    // равен (иначе оператором оргтехники стал бы каждый штаб компании, ADR 0086).
    for (const role of [
      'shtab',
      'rukstroy',
      'department',
      'department_head',
      'observer',
    ] as Role[]) {
      expect(can(of(role), 'officeEquipment.write'), role).toBe(false);
    }
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
  it('наблюдатель только смотрит: одни права на чтение и ничего больше (ADR 0033)', () => {
    // Набор сверяется целиком, а не выборочно: смысл роли — в том, чего у неё нет, и право,
    // попавшее сюда по недосмотру, обязано ронять тест. Справочник оргтехники (ADR 0085) добавлен
    // осознанно: у наблюдателя сквозной просмотр, а карточка единицы — часть картины по компании.
    // Третий модуль заявок (ADR 0085) пришёл к нему тем же одним чтением: чтений стало три, а
    // действий по-прежнему ноль — именно это и делает роль наблюдателем.
    expect([...permissionsFor(of('observer'))].sort()).toEqual([
      'directories.read',
      'officeEquipment.read',
      'serviceRequests.read',
      'vehicleRequests.read',
      'wasteRequests.read',
    ]);
    // Ни одного права, которое не кончается на `.read`: перечень выше сверяет состав, а это —
    // правило, по которому он собран, и следующий модуль обязан прийти сюда одним чтением.
    for (const permission of permissionsFor(of('observer'))) {
      expect(permission.endsWith('.read'), permission).toBe(true);
    }
    // Все три модуля заявок видны целиком, без сужения по объекту.
    expect(isObjectScopedRole('observer')).toBe(false);
    expect(allowedStatusTransitions('new', of('observer'))).toEqual([]);
    // Ход сервисной заявки наблюдателю закрыт так же, как ход двух остальных модулей: чтение
    // раздела не даёт ни одной дуги (полный перебор статусов — в `service-corridors.test.ts`).
    expect(allowedServiceStatusTransitions('new', of('observer'))).toEqual([]);
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
      // Пустой бланк (ADR 0071): на начальном этапе — только администратору. Номер строгой
      // отчётности уходит на лист, задание в котором портал не печатает вовсе.
      'waybills.issueBlank',
    ];
    for (const permission of adminOnly) {
      expect(
        profilesWith(permission).map((s) => s.role),
        permission,
      ).toEqual(['admin']);
    }
  });

  /**
   * Пустой бланк — отдельное право, а не часть журнала листов. Те, кто листы выписывает каждый
   * день (менеджер и диспетчер), журнал ведут и бланки аннулируют — но лист без задания не
   * выписывают: он расходует номер строгой отчётности ни на что.
   */
  it('журнал листов ведут менеджер с диспетчером, а пустой бланк выписывает только админ', () => {
    for (const role of ['manager', 'dispatcher'] as const) {
      expect(can(of(role), 'waybills.read'), role).toBe(true);
      expect(can(of(role), 'waybills.cancel'), role).toBe(true);
      expect(can(of(role), 'waybills.issueBlank'), role).toBe(false);
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

  /**
   * Сервисная компания (ADR 0085) — исполнитель заявок на обслуживание оргтехники, и справочника
   * оргтехники у неё нет намеренно. Связи «единица ↔ обслуживающий её сервис» в портале не
   * существует: «его» техника в справочнике ничем не отмечена, и право означало бы доступ ко
   * всему парку компании — к каждому кабинету и к каждому инвентарному номеру. Реквизиты нужной
   * единицы приходят к нему снимком в самой заявке (Р10), и этого для ремонта достаточно.
   */
  it('сервисной компании справочник оргтехники закрыт (ADR 0085)', () => {
    const service = serviceCompany;
    expect(can(service, 'officeEquipment.read')).toBe(false);
    expect(can(service, 'officeEquipment.write')).toBe(false);
    // И это не особенность сервиса: справочник закрыт любому внешнему исполнителю.
    for (const subject of [wasteOperator, vehicleLessor, of('operator')]) {
      expect(can(subject, 'officeEquipment.read'), String(subject.counterpartyType)).toBe(false);
      expect(can(subject, 'officeEquipment.write'), String(subject.counterpartyType)).toBe(false);
    }
  });

  it('учётки заводятся только на тех контрагентов, за которых кто-то работает', () => {
    // Список полный и в порядке самого перечня типов: сервисная компания (ADR 0085) пришла сюда
    // третьей — не строкой второго списка, а тем, что у типа появились права.
    expect([...COUNTERPARTY_TYPES_WITH_ACCOUNTS]).toEqual([
      'operator',
      'vehicle_lessor',
      'service',
    ]);
    // Поставщик (ADR 0051) — сторона договора, а не исполнитель: учётки на него не заводятся,
    // и войти в портал «от поставщика» нельзя. Генподрядчик и подрядчик — там же: их сотрудники
    // работают в портале под собственными ролями, а не «от контрагента».
    for (const type of ['general_contractor', 'contractor', 'supplier'] as CounterpartyType[]) {
      expect([...COUNTERPARTY_TYPES_WITH_ACCOUNTS], type).not.toContain(type);
      expect(counterpartyTypeHasAccounts(type), type).toBe(false);
    }
    expect(counterpartyTypeHasAccounts('service')).toBe(true);
    expect(counterpartyTypeHasAccounts(null)).toBe(false);
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
    // Три профиля, а не два: тип с правами — это тип, за который в портале работают, и своим
    // субъектом он обязан попасть в перебор «всех, кто бывает в портале». Перечислением, а не
    // счётом: пропавший профиль означал бы субъекта, которого перестали проверять тесты доступа.
    expect(ACCESS_PROFILES.filter((s) => s.role === 'operator')).toEqual([
      wasteOperator,
      vehicleLessor,
      serviceCompany,
    ]);
    // Ровно по разу на тип с учётками — и в том же порядке: перечень профилей выводится из
    // матрицы, а не поддерживается вторым списком.
    expect(
      ACCESS_PROFILES.filter((s) => s.role === 'operator').map((s) => s.counterpartyType),
    ).toEqual([...COUNTERPARTY_TYPES_WITH_ACCOUNTS]);
    // Остальные роли — по одному профилю: контрагента у них нет. Профили с надстройкой (ADR 0086)
    // из этого счёта исключены намеренно: надстройка — не второй профиль роли, а третья ось
    // субъекта, и перечисляется она отдельно, следующей проверкой.
    expect(
      ACCESS_PROFILES.filter(isPlainProfile).filter((s) => s.role !== 'operator'),
    ).toHaveLength(ROLES.length - 1);
    expect(accessProfileLabel(vehicleLessor)).toBe(
      'Оператор (внешний исполнитель) — Арендодатель (ТС)',
    );
  });

  /**
   * Надстройка даёт свой различимый субъект (ADR 0086): «штаб» и «штаб с надстройкой» отвечают на
   * `can` по-разному, и перебор «всех, кто бывает в портале» обязан видеть обоих. Перечислением, а
   * не счётом пар: пара, попавшая сюда лишней, — это доступ, которого никто не назначал, а
   * пропавшая — субъект, которого перестали проверять тесты доступа.
   */
  it('профили доступа перечисляют пары «базовая роль × надстройка» (ADR 0086)', () => {
    expect(ACCESS_PROFILES.filter((s) => !isPlainProfile(s))).toEqual([
      { role: 'shtab', addons: ['office_equipment_operator'] },
      { role: 'department', addons: ['office_equipment_operator'] },
    ]);
    expect(accessProfileLabel({ role: 'shtab', addons: ['office_equipment_operator'] })).toBe(
      'Штаб + Оператор (оргтехника)',
    );
  });
});

/**
 * Модуль заявок на обслуживание оргтехники (ADR 0085) — первый, чьи девять прав раздаются трём
 * разным сторонам сразу: заказчик заводит, оператор оргтехники решает, сервис работает. Проверяется
 * здесь именно раздача; какие переходы из этих прав следуют — в `service-corridors.test.ts`.
 */
describe('заявки на обслуживание оргтехники (ADR 0085)', () => {
  /** Права модуля у субъекта, без общего префикса: так их сравнивать между сторонами. */
  const moduleOf = (subject: AccessSubject) =>
    permissionsFor(subject)
      .filter((p) => p.startsWith('serviceRequests.'))
      .map((p) => p.slice('serviceRequests.'.length))
      .sort();

  /**
   * Список прав модуля — не второй перечень рядом с матрицей, а её же срез: он нужен и проверке
   * «открыт ли раздел», и тестам. Разъехавшись с матрицей, он молча перестал бы кого-нибудь
   * закрывать.
   */
  it('прав у модуля девять, и список модуля выводится из матрицы', () => {
    expect([...SERVICE_REQUEST_PERMISSIONS]).toEqual(
      PERMISSIONS.filter((p) => p.startsWith('serviceRequests.')),
    );
    expect(SERVICE_REQUEST_PERMISSIONS).toHaveLength(9);
    // Право без единого держателя — мёртвая строка матрицы: она выглядит как раздача доступа, а
    // означает «этого не может никто».
    for (const permission of SERVICE_REQUEST_PERMISSIONS) {
      expect(profilesWith(permission).length, permission).toBeGreaterThan(0);
    }
  });

  /**
   * Заказчиков четверо: обе роли площадки и обе роли офиса. Сравнением, а не четырьмя
   * перечислениями: разойдясь, два заказчика одной и той же заявки получили бы разный портал —
   * штаб завёл бы, а руководитель строительства не смог бы приложить к ней фотографию.
   */
  it('заказчик заводит, правит, удаляет и подшивает — и все четыре роли одинаково', () => {
    for (const role of SERVICE_CUSTOMER_ROLES) {
      expect(moduleOf(of(role)), role).toEqual(['create', 'delete', 'files', 'read', 'update']);
    }
    // Комендант закрыт целиком: оргтехника на площадке идёт через штаб, как и заказ техники.
    expect(moduleOf(of('commandant'))).toEqual([]);
    // Менеджер и диспетчер ведут справочник оргтехники, но не модуль заявок: ремонтом занимается
    // ответственный за оргтехнику, а не диспетчер вывоза.
    expect(moduleOf(of('manager'))).toEqual([]);
    expect(moduleOf(of('dispatcher'))).toEqual([]);
  });

  it('ход заявки заказчику не выдан: он её просит, а не ведёт', () => {
    for (const role of SERVICE_CUSTOMER_ROLES) {
      for (const permission of [
        'serviceRequests.assign',
        'serviceRequests.estimate',
        'serviceRequests.approveEstimate',
        'serviceRequests.status',
      ] as Permission[]) {
        expect(can(of(role), permission), `${role}: ${permission}`).toBe(false);
      }
    }
  });

  /**
   * Решения по заявке приходят надстройкой (ADR 0086), а не ролью: назначает сервис и принимает
   * работу один назначенный человек, а не всякий, кто завёл заявку. Обратным поиском — так видно,
   * что второго держателя у этих прав нет.
   */
  it('решения по заявке — у оператора оргтехники и администратора', () => {
    for (const permission of [
      'serviceRequests.assign',
      'serviceRequests.approveEstimate',
    ] as Permission[]) {
      expect(rolesWith(permission), permission).toEqual(['admin']);
      expect(addonProfilesWith(permission).map(accessProfileLabel), permission).toEqual([
        'Штаб + Оператор (оргтехника)',
        'Отдел + Оператор (оргтехника)',
      ]);
    }
    // Смету оператор согласует, но не пишет: выданные одному субъекту, эти два права превратили бы
    // согласование в подпись под собственной работой (перебор коридоров — в service-corridors).
    for (const subject of officeOperators) {
      expect(can(subject, 'serviceRequests.approveEstimate'), accessProfileLabel(subject)).toBe(
        true,
      );
      expect(can(subject, 'serviceRequests.estimate'), accessProfileLabel(subject)).toBe(false);
    }
  });

  /**
   * Исполнителя задаёт тип контрагента, а не роль (ADR 0038): «оператор» с контрагентом-сервисом
   * ведёт смету, тот же «оператор» с контрагентом вывоза не видит модуля вовсе. Заводить и править
   * заявки исполнитель не может ни в одном из трёх модулей — это граница модели.
   */
  it('сервисная компания ведёт смету и свою часть цикла, но заявок не заводит', () => {
    expect(moduleOf(serviceCompany)).toEqual(['estimate', 'files', 'read', 'status']);
    expect(moduleOf(wasteOperator)).toEqual([]);
    expect(moduleOf(vehicleLessor)).toEqual([]);
    // Право сметы — стороны исполнителя: вне контрагента `service` оно есть только у
    // администратора, и именно оно (а не имя роли) открывает ему шаги исполнителя.
    expect(profilesWith('serviceRequests.estimate').map(accessProfileLabel)).toEqual([
      'Администратор',
      'Оператор (внешний исполнитель) — Сервисная компания',
    ]);
  });

  /** Наблюдатель — сквозной просмотр без единого действия, тем же одним чтением (полный набор выше). */
  it('наблюдатель видит модуль и не делает в нём ничего', () => {
    expect(moduleOf(of('observer'))).toEqual(['read']);
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
