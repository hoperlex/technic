import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  can,
  COUNTERPARTY_SCOPED_ROLES,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  DEPARTMENT_SCOPED_ROLES,
  describeAccessScope,
  MODULE_ENTRY_PERMISSION,
  moduleAccess,
  OBJECT_SCOPED_ROLES,
  PERMISSION_ACTIONS,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS,
  PERMISSIONS_BY_MODULE,
  permissionSource,
  permissionsFor,
  PERSON_SCOPED_ROLES,
  ROLE_PERMISSIONS,
  ROLES,
  scopeAxisOf,
  UNSCOPED_TEXT,
  type AccessSubject,
  type Permission,
  type Role,
} from '@technic/contracts';

/**
 * Витрина модели доступа (`docs/permissions-tab-plan.md` §5) — каталог прав, объяснение источника
 * и словесное описание области. Сама матрица проверяется в `permissions.test.ts` и здесь не
 * повторяется: этот файл держит ровно одно — витрина обязана рассказывать про доступ то же самое,
 * что выдаёт `can`. Разъехавшись, она соврёт там, где по ней принимают решение о правах.
 */

/** Субъект доступа роли без контрагента — как в тестах матрицы. */
const of = (role: Role): AccessSubject => ({ role });

/** Профили с надстройкой (ADR 0086): у них источник права — не только роль. */
const addonProfiles = ACCESS_PROFILES.filter((s) => s.addons?.length);

/** Профили внешнего исполнителя: роль плюс тип контрагента (ADR 0038). */
const counterpartyProfiles = ACCESS_PROFILES.filter((s) => s.counterpartyType);

describe('каталог прав: подписи и модули', () => {
  /**
   * Подпись — единственное, чем право представлено человеку: в сетке, в фильтре «у кого есть», в
   * карточке доступа. Пустая означает пустую клетку вместо права, а повторяющаяся — два пункта,
   * которые в витрине не различить: выбрав «Двигает заявку по статусам» в фильтре, аналитик не
   * узнает, о каком из модулей идёт речь.
   */
  it('у каждого права есть непустая подпись, и подписи не повторяются', () => {
    const byLabel = new Map<string, Permission[]>();
    for (const permission of PERMISSIONS) {
      const { label } = PERMISSION_CATALOG[permission];
      expect(label.trim(), permission).not.toBe('');
      byLabel.set(label, [...(byLabel.get(label) ?? []), permission]);
    }
    const collisions = [...byLabel.entries()].filter(([, ps]) => ps.length > 1);
    expect(collisions).toEqual([]);
  });

  /**
   * Разбивка по модулям — это перекладка `PERMISSIONS`, а не второй список рядом с ним. Потерянное
   * право означало бы строку матрицы, которой в витрине нет вовсе; задвоенное — право, показанное
   * в двух модулях сразу, где закрытым его сочтут по первому попавшемуся.
   */
  it('модули в сумме покрывают все права ровно по разу', () => {
    const listed = PERMISSION_MODULES.flatMap((module) => [...PERMISSIONS_BY_MODULE[module]]);
    expect([...listed].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  /**
   * Модуль закрывается своим правом на чтение (ADR 0021): нет его — нет и раздела. Открывающее
   * право из чужого модуля означало бы раздел, который открывается доступом к соседнему.
   */
  it('право, открывающее модуль, принадлежит этому же модулю', () => {
    for (const module of PERMISSION_MODULES) {
      const entry = MODULE_ENTRY_PERMISSION[module];
      expect(PERMISSION_CATALOG[entry].module, module).toBe(module);
      expect(PERMISSIONS_BY_MODULE[module], module).toContain(entry);
    }
  });

  /**
   * Пустая строка и пустая колонка сетки — разные ошибки, но обе означают заведённое зря деление.
   * Модуль без прав в витрине не показать нечем; вид действия, которого нет ни у одного права, —
   * колонка, пустая при любом субъекте.
   */
  it('у каждого модуля есть права, и каждый вид действия кому-нибудь достался', () => {
    for (const module of PERMISSION_MODULES) {
      expect(PERMISSIONS_BY_MODULE[module], module).not.toEqual([]);
    }
    const used = new Set(PERMISSIONS.map((permission) => PERMISSION_CATALOG[permission].action));
    for (const action of PERMISSION_ACTIONS) {
      expect(used.has(action), action).toBe(true);
    }
  });
});

describe('источник права согласован с матрицей', () => {
  /**
   * Главная проверка витрины. `permissionSource` повторяет порядок источников из `can`, и вторая
   * копия этого порядка обязана отвечать так же: источник без права — витрина, объясняющая
   * несуществующий доступ; право без источника — прочерк в карточке там, где доступ есть.
   * Перебором всех профилей и всех прав, а не выборочно: расходятся такие копии в одной клетке.
   */
  it('источник есть ровно там, где право есть', () => {
    for (const profile of ACCESS_PROFILES) {
      for (const permission of PERMISSIONS) {
        const label = `${accessProfileLabel(profile)}: ${permission}`;
        expect(permissionSource(profile, permission) !== null, label).toBe(
          can(profile, permission),
        );
      }
    }
  });

  /**
   * Надстройка (ADR 0086) — третья ось субъекта, и витрина обязана её называть: при пересмотре
   * ролей «право есть у штаба» и «право выдано этому человеку поимённо» — разные ответы, и второй
   * важнее. Роль спрашивается первой, поэтому общее с ролью право остаётся ролевым, даже если та
   * же надстройка его дублирует.
   */
  it('надстройка называет себя, а общие с ролью права остаются ролевыми', () => {
    expect(addonProfiles).not.toEqual([]);
    for (const profile of addonProfiles) {
      const fromRole = new Set(permissionsFor({ role: profile.role }));
      for (const permission of permissionsFor(profile)) {
        const origin = permissionSource(profile, permission);
        const label = `${accessProfileLabel(profile)}: ${permission}`;
        if (fromRole.has(permission)) {
          expect(origin, label).toEqual({ kind: 'role' });
        } else {
          expect(origin?.kind, label).toBe('addon');
          expect(profile.addons, label).toContain(origin?.addon);
        }
      }
      // Надстройка обязана хоть что-то добавлять: профиль, у которого все права ролевые, означал бы
      // выданную впустую надстройку — и пустую строку «источник» в карточке доступа.
      expect(
        permissionsFor(profile).some((p) => permissionSource(profile, p)?.kind === 'addon'),
        accessProfileLabel(profile),
      ).toBe(true);
    }
  });

  /**
   * У внешнего исполнителя роль отвечает «кем он работает», тип контрагента — «по какому предмету»
   * (ADR 0038). Витрина обязана показывать это разделение: модульные права держит контрагент, и
   * при смене типа они уходят, а чтение справочников остаётся при роли.
   */
  it('внешнему исполнителю модуль даёт контрагент, а справочники — роль', () => {
    expect(counterpartyProfiles).not.toEqual([]);
    const fromRole = new Set(ROLE_PERMISSIONS.operator);
    for (const profile of counterpartyProfiles) {
      expect(permissionSource(profile, 'directories.read'), accessProfileLabel(profile)).toEqual({
        kind: 'role',
      });
      const modular = permissionsFor(profile).filter((p) => !fromRole.has(p));
      expect(modular, accessProfileLabel(profile)).not.toEqual([]);
      for (const permission of modular) {
        expect(
          permissionSource(profile, permission),
          `${accessProfileLabel(profile)}: ${permission}`,
        ).toEqual({ kind: 'counterparty' });
      }
    }
  });

  /**
   * Учётка без роли для портала — никто (её и активировать нельзя). Витрина такой учётки обязана
   * остаться пустой: источник, найденный без роли, нарисовал бы в карточке доступ, которого нет.
   */
  it('без роли источника нет ни у одного права', () => {
    for (const permission of PERMISSIONS) {
      expect(permissionSource(null, permission), permission).toBeNull();
      expect(permissionSource({ role: null }, permission), permission).toBeNull();
    }
  });
});

describe('область доступа словами', () => {
  /**
   * Правила области — текст, а не предикат по строке, и разойтись с моделью они могут молча.
   * Страховка от этого — полнота: роль, у которой область задаётся набором в учётке, обязана
   * получить хотя бы одно правило и не может быть объявлена неограниченной. Новая роль с областью,
   * забытая в витрине, роняет этот тест — иначе её учётку показали бы видящей всё.
   */
  it('у каждой роли с областью есть своё правило, и «без ограничений» ей не пишут', () => {
    const scoped: readonly Role[] = [
      ...OBJECT_SCOPED_ROLES,
      ...DEPARTMENT_SCOPED_ROLES,
      ...COUNTERPARTY_SCOPED_ROLES,
      // Четвёртая ось (ADR 0102) наравне с прочими: предиката в слое доступа у неё нет, но витрина
      // обязана сказать про область водителя то же, что говорят про область штаба.
      ...PERSON_SCOPED_ROLES,
    ];
    for (const role of scoped) {
      const rules = describeAccessScope(of(role));
      expect(rules, role).not.toEqual([]);
      expect(rules, role).not.toContain(UNSCOPED_TEXT);
    }
    // У роли от контрагента область задаёт тип контрагента, а не она сама: каждый тип, за который
    // в портале работают, обязан добавить своё правило поверх общих. Сравнением с «ролью без
    // контрагента», а не сверкой текстов: новый тип с учётками так не проскочит неописанным.
    for (const role of COUNTERPARTY_SCOPED_ROLES) {
      const bare = describeAccessScope(of(role)).length;
      for (const counterpartyType of COUNTERPARTY_TYPES_WITH_ACCOUNTS) {
        const rules = describeAccessScope({ role, counterpartyType });
        expect(rules.length, `${role} — ${counterpartyType}`).toBeGreaterThan(bare);
      }
    }
  });

  /**
   * Обратная сторона той же полноты: «областью не ограничен» — сильное утверждение, и достаться
   * оно должно только тому, у кого ограничений действительно не осталось. Сегодня это
   * администратор: своей оси у него нет, а архив он видит.
   */
  it('администратору написано «областью не ограничен» — и ничего сверх этого', () => {
    expect(describeAccessScope(of('admin'))).toEqual([UNSCOPED_TEXT]);
  });

  /**
   * Роль без своей оси — ещё не роль без ограничений: удалённые записи закрыты всем, кроме
   * администратора, и по прямой ссылке отвечают «не найдено». Сочти витрина такую роль
   * неограниченной — наблюдателя и менеджера показали бы равными администратору.
   */
  it('роль без своей оси, но без архива, ограничена удалёнными записями', () => {
    for (const role of ['observer', 'manager'] as Role[]) {
      const rules = describeAccessScope(of(role));
      expect(rules, role).toHaveLength(1);
      expect(rules, role).not.toContain(UNSCOPED_TEXT);
      expect(can(of(role), 'archive.read'), role).toBe(false);
    }
    // Правило одно и то же: разница между ними — не в области, а в правах, и витрина области об
    // этом молчит намеренно.
    expect(describeAccessScope(of('observer'))).toEqual(describeAccessScope(of('manager')));
  });

  it('учётке без роли витрина говорит, что роль не назначена', () => {
    for (const subject of [null, undefined, { role: null }]) {
      const rules = describeAccessScope(subject);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatch(/роль не назначена/i);
      expect(rules).not.toContain(UNSCOPED_TEXT);
    }
  });

  /**
   * Ось области решает, какой набор показать в учётке: объекты, отделы, контрагента или работника
   * справочника. Считается она теми же предикатами, что и сам слой доступа, — тест закрепляет, что
   * лишнего ответа (роль есть в списке осей, а витрина её оси не знает) не бывает.
   *
   * Таблицей «ось → её список ролей», а не повторением ветвей `scopeAxisOf`: копия ветвей молчит
   * ровно про забытую ось — оба ответа выходят `null`, и тест проходит на витрине, которая печатает
   * такой учётке «Все записи». Именно так четвёртая ось (ADR 0102) и осталась незамеченной.
   * `Record` по союзу осей закрывает обратную сторону: ось, добавленная в `scopeAxisOf` без своего
   * списка ролей, не соберётся здесь.
   */
  it('ось области совпадает со списками ролей из модели', () => {
    const axisRoles: Record<NonNullable<ReturnType<typeof scopeAxisOf>>, readonly Role[]> = {
      object: OBJECT_SCOPED_ROLES,
      department: DEPARTMENT_SCOPED_ROLES,
      counterparty: COUNTERPARTY_SCOPED_ROLES,
      person: PERSON_SCOPED_ROLES,
    };
    const axisOfRole = new Map<Role, string>();
    for (const [axis, roles] of Object.entries(axisRoles)) {
      for (const role of roles) {
        // Роль на двух осях — не витринная опечатка, а противоречие в модели: набор в учётке у неё
        // требовали бы двумя разными полями.
        expect(axisOfRole.get(role), role).toBeUndefined();
        axisOfRole.set(role, axis);
      }
    }
    for (const role of ROLES) {
      expect(scopeAxisOf(role), role).toBe(axisOfRole.get(role) ?? null);
    }
    expect(scopeAxisOf(null)).toBeNull();
  });
});

describe('доступ к модулю тремя состояниями', () => {
  /**
   * «Не видит», «смотрит» и «работает» — три разных ответа, и значок модуля в списке учёток
   * показывает именно их. Схлопни витрина два последних — руководитель увидел бы наблюдателя
   * работающим в «Заказе ТС», а это ровно тот вопрос, ради которого вкладку и заводили.
   * Показательными случаями, а не полной таблицей «роль × модуль»: её держат проверки выше.
   */
  it('модуль без прав закрыт, модуль с одним чтением — только виден, модуль с действием — рабочий', () => {
    // Гараж штабу не выдан ни одним правом: раздела нет.
    expect(moduleAccess(of('shtab'), 'garage')).toBe('none');
    // У наблюдателя в «Заказе ТС» одно чтение — и ни одного действия (ADR 0033).
    expect(moduleAccess(of('observer'), 'vehicle')).toBe('read');
    // Менеджер вывоз ведёт: заводит, правит, двигает по статусам.
    expect(moduleAccess(of('manager'), 'waste')).toBe('write');
    // Один модуль, два состояния: неделю площадка собирает, а отдел по ней только читает свою
    // площадку (ADR 0062). Пара показывает, что состояние считается по правам субъекта, а не по
    // тому, открыт ли раздел вообще.
    expect(moduleAccess(of('shtab'), 'weekly')).toBe('write');
    expect(moduleAccess(of('department'), 'weekly')).toBe('read');
  });

  it('учётке без роли закрыты все модули', () => {
    for (const module of PERMISSION_MODULES) {
      expect(moduleAccess(null, module), module).toBe('none');
      expect(moduleAccess({ role: null }, module), module).toBe('none');
    }
  });
});
