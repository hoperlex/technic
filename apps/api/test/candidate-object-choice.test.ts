import { describe, expect, it } from 'vitest';
import {
  candidateObjectChoice,
  canPlaceCandidateOn,
  DEPARTMENT_SCOPED_ROLES,
  OBJECT_SCOPED_ROLES,
  OFFICE_EQUIPMENT_IT_GRANT,
  type Role,
  type ScopedSubject,
} from '@technic/contracts';

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const OBJECT_B = '22222222-2222-2222-2222-222222222222';
const FOREIGN_OBJECT = '33333333-3333-3333-3333-333333333333';

function subject(role: Role | null, extra: Partial<ScopedSubject> = {}): ScopedSubject {
  return { role, ...extra };
}

describe('место сообщения о ненайденном аппарате (ADR 0249)', () => {
  it.each([null, undefined])('без учётки %s не разрешает ни одного объекта', (who) => {
    expect(candidateObjectChoice(who)).toEqual({ allowedObjectIds: [], ownObjectIds: [] });
    expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(false);
    expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(false);
  });

  it('администратор выбирает любой объект без назначенного набора', () => {
    const who = subject('admin');
    expect(candidateObjectChoice(who)).toEqual({ allowedObjectIds: null, ownObjectIds: [] });
    expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(true);
    expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(true);
  });

  it.each(OBJECT_SCOPED_ROLES)('%s ограничен всеми своими объектами', (role) => {
    const who = subject(role, { constructionObjectIds: [OBJECT_A, OBJECT_B] });
    expect(candidateObjectChoice(who)).toEqual({
      allowedObjectIds: [OBJECT_A, OBJECT_B],
      ownObjectIds: [],
    });
    expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(true);
    expect(canPlaceCandidateOn(who, OBJECT_B)).toBe(true);
    expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(false);
  });

  it.each(OBJECT_SCOPED_ROLES)('%s без привязки не получает выбор чужих объектов', (role) => {
    const who = subject(role);
    expect(candidateObjectChoice(who)).toEqual({ allowedObjectIds: [], ownObjectIds: [] });
    expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(false);
  });

  it.each(DEPARTMENT_SCOPED_ROLES)(
    '%s временно выбирает любой объект, а площадки отдела предлагает первыми',
    (role) => {
      const who = subject(role, { departmentObjectIds: [OBJECT_A, OBJECT_B] });
      expect(candidateObjectChoice(who)).toEqual({
        allowedObjectIds: null,
        ownObjectIds: [OBJECT_A, OBJECT_B],
      });
      expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(true);
      expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(true);
    },
  );

  it.each(DEPARTMENT_SCOPED_ROLES)('%s без площадок тоже может сообщить об аппарате', (role) => {
    const who = subject(role);
    expect(candidateObjectChoice(who)).toEqual({ allowedObjectIds: null, ownObjectIds: [] });
    expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(true);
  });

  it.each([
    ['shtab', [OBJECT_A]],
    ['department', [OBJECT_B]],
  ] satisfies [Role, string[]][])(
    'сквозная область ИТ поверх %s разрешает чужой объект и сохраняет свою ось для приоритета',
    (role, ownObjectIds) => {
      const who = subject(role, {
        constructionObjectIds: [OBJECT_A],
        departmentObjectIds: [OBJECT_B],
        grantCodes: [OFFICE_EQUIPMENT_IT_GRANT],
      });
      expect(candidateObjectChoice(who)).toEqual({ allowedObjectIds: null, ownObjectIds });
      expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(true);
      expect(canPlaceCandidateOn(who, OBJECT_B)).toBe(true);
      expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(true);
    },
  );

  it.each([
    'dispatcher',
    'manager',
    'observer',
    'mechanic',
    'chief_mechanic',
    'operator',
    null,
  ] satisfies (Role | null)[])(
    '%s без собственной площадочной оси выбирает весь справочник',
    (role) => {
      const who = subject(role);
      expect(candidateObjectChoice(who)).toEqual({ allowedObjectIds: null, ownObjectIds: [] });
      expect(canPlaceCandidateOn(who, OBJECT_A)).toBe(true);
      expect(canPlaceCandidateOn(who, FOREIGN_OBJECT)).toBe(true);
    },
  );
});
