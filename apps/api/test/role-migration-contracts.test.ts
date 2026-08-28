import { describe, expect, it } from 'vitest';
import {
  canAttachAddon,
  activationDefaultsFor,
  isRetiringRole,
  NON_GRANTABLE_PERMISSIONS,
  permissionsFor,
  REGISTRATION_ROLE_REQUESTS,
  RETIRING_ROLES,
  ROLE_ADDONS,
  ROLE_ADDON_BASE_ROLES,
  ROLE_GRANTS,
  ROLE_GRANT_CODES,
  ROLE_MIGRATIONS,
  ROLES,
  retiringRoleIssue,
  roleMigrationOf,
  type Permission,
  type Role,
} from '@technic/contracts';

/**
 * Таблица перевода ролей (`ROLE_MIGRATIONS`) против матрицы прав — переходный тест 1 плана §14
 * («тест эквивалентности»), взятый со стороны **перевода**, а не со стороны каталога.
 *
 * Разделение с `grants-contracts.test.ts` не формальное. Там доказывается равенство составов:
 * «старая роль = новая роль + наборы» по словарю прав — утверждение о каталоге. Здесь предмет
 * другой: таблица, по которой едут миграции prepare (0155, 0156), сверка на живых данных
 * (`check:role-migration`) и форма учётки. Разъедься она с матрицей — перевод выдал бы не тот набор
 * не тем людям, и ни один тест каталога этого не увидел бы: каталог остался бы верным.
 *
 * Живых данных здесь нет вовсе, и это граница файла: «у кого какой набор действительно выдан»
 * доказывается только сверкой на базе — она и стоит шагом выката.
 */

/** Права субъекта «роль плюс перечисленные наборы» — тем же способом, каким их считает сервер. */
function permissionsOfPair(role: Role, grants: readonly string[]): Permission[] {
  const fromGrants = grants.flatMap((code) => [
    ...ROLE_GRANTS[code as (typeof ROLE_GRANT_CODES)[number]].permissions,
  ]);
  return [...permissionsFor({ role, grantPermissions: fromGrants })];
}

describe('таблица перевода ролей', () => {
  it('перечисляет ровно четыре упраздняемые роли — по таблице соответствия §9', () => {
    // Перечислением, а не счётом: лишняя строка здесь — это перевод, которого заказчик не решал, а
    // пропавшая — роль, которая доживёт до cleanup и останется без учёток, но с людьми на ней.
    expect([...RETIRING_ROLES]).toEqual(['shtab', 'rukstroy', 'commandant', 'department_head']);
    for (const role of RETIRING_ROLES) {
      expect(ROLES, role).toContain(role);
    }
  });

  it('целевая роль сама не упраздняется и не совпадает с исходной', () => {
    for (const m of ROLE_MIGRATIONS) {
      expect(m.to, `${m.from} → ${m.to}`).not.toBe(m.from);
      // Перевод в роль, которую тоже упраздняют, — это два перевода подряд, и снимок такого не
      // опишет: `role_before` у второго совпал бы с `role_after` первого.
      expect(isRetiringRole(m.to), `${m.from} → ${m.to}`).toBe(false);
    }
  });

  /**
   * Главное утверждение файла: пара «целевая роль + выданные переводом наборы» даёт ровно те же
   * права, что упраздняемая роль. Ни одного потерянного — иначе перевод отберёт доступ; ни одного
   * лишнего, кроме объявленного расширения, — иначе он его расширит.
   */
  it('пара «роль + наборы» равна упраздняемой роли, а расширение — только объявленное', () => {
    for (const m of ROLE_MIGRATIONS) {
      const before = permissionsOfPair(m.from, []);
      const after = permissionsOfPair(m.to, m.grants);
      const lost = before.filter((p) => !after.includes(p));
      const gained = after.filter((p) => !before.includes(p));
      expect(lost, `${m.from} → ${m.to}: перевод отберёт права`).toEqual([]);
      // Равенство, а не включение: объявленный список — это то, что заказчик решил, и «получит
      // меньше объявленного» такой же повод разбираться, как «получит больше».
      expect(gained.sort(), `${m.from} → ${m.to}: расширение разошлось с объявленным`).toEqual(
        [...m.gains].sort(),
      );
    }
  });

  it('расширение объявлено ровно у коменданта — единственное во всей реформе', () => {
    const expanding = ROLE_MIGRATIONS.filter((m) => m.gains.length > 0).map((m) => m.from);
    expect(expanding).toEqual(['commandant']);
  });

  /**
   * Набор, выданный переводом, обязан действовать **после** перевода: гейт совместимости
   * (`grant_roles`) спрашивает роль держателя, и набор, не объявленный для целевой роли, остался бы
   * взведённым навсегда — то есть перевод отобрал бы права молча.
   */
  it('каждый выдаваемый набор совместим с целевой ролью', () => {
    for (const m of ROLE_MIGRATIONS) {
      for (const code of m.grants) {
        expect(ROLE_GRANT_CODES, code).toContain(code);
        expect(ROLE_GRANTS[code].roles, `${code} → ${m.to}`).toContain(m.to);
      }
    }
  });

  /**
   * Обратная сторона: набор не объявляется совместимым с упраздняемой ролью. Иначе взведённое
   * назначение начало бы действовать сразу — а вместе с ним администратор получил бы возможность
   * выдать, например, визу объекта рядовому штабу. Релиз, который никого не переводит, не должен
   * расширять и множество того, что вообще можно выдать.
   */
  it('ни один ролевой набор не объявлен совместимым с упраздняемой ролью', () => {
    for (const code of ROLE_GRANT_CODES) {
      for (const role of ROLE_GRANTS[code].roles) {
        expect(isRetiringRole(role), `${code}: роль «${role}» упраздняется`).toBe(false);
      }
    }
  });

  /**
   * Граница, найденная на этапе 4б и закрытая шагом prepare: надстройка, прикреплённая к
   * упраздняемой роли, обязана быть прикреплена и к целевой. Не будь этой строки — перевод отобрал
   * бы надстройку у переведённого оператора оргтехники молча: роль спрашивают и матрица
   * (`canAttachAddon`), и гейт совместимости набора, в который надстройка отражена двойной записью.
   */
  it('надстройки упраздняемых ролей достаются и целевым', () => {
    for (const addon of ROLE_ADDONS) {
      for (const role of ROLE_ADDON_BASE_ROLES[addon]) {
        const migration = roleMigrationOf(role);
        if (!migration) continue;
        expect(
          canAttachAddon(migration.to, addon),
          `надстройка «${addon}» есть у «${role}», но не у «${migration.to}» — перевод её потеряет`,
        ).toBe(true);
      }
    }
  });

  /** Права кабинета водителя не достаются переводом ни одним способом (план §15). */
  it('кабинет водителя не приезжает переводом', () => {
    for (const m of ROLE_MIGRATIONS) {
      for (const permission of NON_GRANTABLE_PERMISSIONS) {
        expect(permissionsOfPair(m.to, m.grants), `${m.from} → ${m.to}`).not.toContain(permission);
      }
    }
  });

  it('умолчания заявок на регистрацию не указывают на упраздняемые роли', () => {
    // Иначе форма рассмотрения открывалась бы с ролью, которую сервер отклоняет: заявку нельзя
    // было бы принять вовсе.
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      expect(isRetiringRole(activationDefaultsFor(request).role), request).toBe(false);
    }
  });
});

describe('закрытый вход в упраздняемые роли', () => {
  it('назначение упраздняемой роли отклоняется и называет замену', () => {
    const issue = retiringRoleIssue('shtab', null);
    expect(issue).toBeTruthy();
    expect(issue).toContain('«Площадка»');
    // Текст называет и наборы: администратору в этот момент нужно следующее действие, а не
    // объяснение реформы.
    expect(issue).toContain('«Заказ техники»');
    expect(retiringRoleIssue('rukstroy', null)).toContain('«Виза объекта»');
    // У коменданта наборов нет — и обещать их в отказе нечем.
    expect(retiringRoleIssue('commandant', null)).toContain('«Площадка»');
  });

  it('прежняя роль сохраняется: отказ ловит смену, а не саму роль', () => {
    // Иначе действующего штаба нельзя было бы даже переименовать: форма присылает его роль обратно.
    expect(retiringRoleIssue('shtab', 'shtab')).toBeNull();
    expect(retiringRoleIssue('department_head', 'department_head')).toBeNull();
    // А вот перевод между упраздняемыми ролями — это заведение человека на роль, которой не будет.
    expect(retiringRoleIssue('rukstroy', 'shtab')).toBeTruthy();
  });

  it('остальные роли назначаются как прежде', () => {
    for (const role of ROLES) {
      if (isRetiringRole(role)) continue;
      expect(retiringRoleIssue(role, null), role).toBeNull();
    }
    // Учётка без роли — заявка на регистрацию: отказывать здесь нечему.
    expect(retiringRoleIssue(null, 'shtab')).toBeNull();
  });
});
