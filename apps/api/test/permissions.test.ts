import { describe, expect, it } from 'vitest';
import {
  allowedStatusTransitions,
  can,
  canTransitionStatus,
  PERMISSIONS,
  permissionsFor,
  ROLE_PERMISSIONS,
  ROLES,
  rolesWith,
  type Permission,
} from '@technic/contracts';

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

  it('каждое право кому-то выдано: право без ролей — забытая строка матрицы', () => {
    const orphaned = PERMISSIONS.filter((p) => rolesWith(p).length === 0);
    expect(orphaned).toEqual([]);
  });

  it('учётка без роли не может ничего', () => {
    for (const permission of PERMISSIONS) {
      expect(can(null, permission), permission).toBe(false);
    }
    expect(permissionsFor(null)).toEqual([]);
  });

  it('администратор может всё', () => {
    for (const permission of PERMISSIONS) {
      expect(can('admin', permission), permission).toBe(true);
    }
  });
});

describe('права ролей', () => {
  it('диспетчер ведёт справочники наравне с менеджером', () => {
    expect(can('dispatcher', 'directories.write')).toBe(true);
    expect([...ROLE_PERMISSIONS.dispatcher].sort()).toEqual([...ROLE_PERMISSIONS.manager].sort());
  });

  it('справочники читают все роли — без них не заполнить форму заявки', () => {
    for (const role of ROLES) expect(can(role, 'directories.read'), role).toBe(true);
  });

  it('справочники правят только те, кто их ведёт', () => {
    expect(rolesWith('directories.write')).toEqual(['admin', 'manager', 'dispatcher']);
  });

  it('оператор вывоза — исполнитель: только чтение своих заявок и их закрытие (ADR 0010)', () => {
    expect(can('operator', 'wasteRequests.read')).toBe(true);
    expect(can('operator', 'wasteRequests.status')).toBe(true);
    expect(can('operator', 'wasteRequests.create')).toBe(false);
    expect(can('operator', 'wasteRequests.update')).toBe(false);
    expect(can('operator', 'wasteRequests.delete')).toBe(false);
    expect(can('operator', 'wasteRequests.assignOperator')).toBe(false);
    // Модуль «Заказ ТС» оператору недоступен целиком.
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('vehicleRequests.'))) {
      expect(can('operator', permission), permission).toBe(false);
    }
  });

  it('штаб заводит заявки обоих модулей, но не ведёт их статусы', () => {
    expect(can('shtab', 'wasteRequests.create')).toBe(true);
    expect(can('shtab', 'vehicleRequests.create')).toBe(true);
    expect(can('shtab', 'wasteRequests.status')).toBe(false);
    expect(can('shtab', 'vehicleRequests.status')).toBe(false);
    expect(can('shtab', 'directories.write')).toBe(false);
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
      expect(rolesWith(permission), permission).toEqual(['admin']);
    }
  });
});

describe('переходы статусов следуют из прав', () => {
  it('роль без права на статус не меняет его вовсе', () => {
    expect(allowedStatusTransitions('new', 'shtab')).toEqual([]);
    expect(canTransitionStatus('new', 'confirmed', 'shtab')).toBe(false);
  });

  it('у оператора один переход — закрыть взятую в работу заявку', () => {
    expect(allowedStatusTransitions('confirmed', 'operator')).toEqual(['done']);
    expect(allowedStatusTransitions('new', 'operator')).toEqual([]);
    expect(canTransitionStatus('new', 'cancelled', 'operator')).toBe(false);
  });

  it('откат закрытой заявки идёт от права, а не от имени роли', () => {
    expect(canTransitionStatus('done', 'confirmed', 'admin')).toBe(true);
    expect(can('manager', 'requests.rollbackStatus')).toBe(false);
    expect(canTransitionStatus('done', 'confirmed', 'manager')).toBe(false);
  });
});
