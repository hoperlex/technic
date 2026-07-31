import { describe, expect, it } from 'vitest';
import { createUserSchema, updateUserSchema } from '@technic/contracts';

// Область учётки, заданная объектами (ADR 0039). Инвариант «объектной роли обязателен объект»
// раньше держал CHECK `users_rukstroy_object_check` (миграция 0050); с переходом на набор он
// снят — CHECK читает колонки своей строки, а набор лежит в отдельной таблице. Проверяют его
// теперь контракт (здесь) и `resolveObjectIds` на сервере, поэтому тест есть.

const OBJECT_A = '11111111-1111-4111-8111-111111111111';
const OBJECT_B = '22222222-2222-4222-8222-222222222222';

const base = {
  email: 'user@test.local',
  lastName: 'Пользователь',
  firstName: 'Тестовый',
  middleName: '',
  password: 'Fx7#kq2Lm9tz',
};

describe('объекты учётки при создании (ADR 0039)', () => {
  it('объектной роли нужен хотя бы один объект', () => {
    for (const role of ['shtab', 'rukstroy'] as const) {
      expect(
        createUserSchema.safeParse({ ...base, role, constructionObjectIds: [] }).success,
        role,
      ).toBe(false);
      // Поле не передали вовсе — тот же отказ: пустой набор по умолчанию не обходит требование.
      expect(createUserSchema.safeParse({ ...base, role }).success, role).toBe(false);
      expect(
        createUserSchema.safeParse({ ...base, role, constructionObjectIds: [OBJECT_A] }).success,
        role,
      ).toBe(true);
    }
  });

  it('объектов может быть несколько — в этом весь смысл перехода с колонки', () => {
    const parsed = createUserSchema.parse({
      ...base,
      role: 'shtab',
      constructionObjectIds: [OBJECT_A, OBJECT_B],
    });
    expect(parsed.constructionObjectIds).toEqual([OBJECT_A, OBJECT_B]);
  });

  it('остальным ролям объекты не требуются', () => {
    for (const role of ['admin', 'manager', 'dispatcher', 'observer'] as const) {
      expect(createUserSchema.safeParse({ ...base, role }).success, role).toBe(true);
    }
  });

  it('в наборе только ссылки на справочник, и он не безразмерный', () => {
    expect(
      createUserSchema.safeParse({ ...base, role: 'shtab', constructionObjectIds: ['Объект 1'] })
        .success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({
        ...base,
        role: 'shtab',
        constructionObjectIds: Array.from({ length: 51 }, () => OBJECT_A),
      }).success,
    ).toBe(false);
  });
});

describe('объекты учётки при правке (ADR 0039)', () => {
  it('отсутствие поля означает «не трогать привязки», а пустой массив — «снять все»', () => {
    expect(updateUserSchema.parse({}).constructionObjectIds).toBeUndefined();
    expect(updateUserSchema.parse({ constructionObjectIds: [] }).constructionObjectIds).toEqual([]);
  });

  it('непустой набор при правке не требуется схемой: роль известна только серверу', () => {
    // PATCH приходит без роли, когда её не меняют, и «нужен ли объект» из тела не следует —
    // это решает `resolveObjectIds` по роли из БД. Схема проверяет форму, а не инвариант.
    expect(updateUserSchema.safeParse({ constructionObjectIds: [] }).success).toBe(true);
  });
});

describe('отделы учётки (ADR 0040)', () => {
  const DEPARTMENT_A = '33333333-3333-4333-8333-333333333333';

  it('роли отдела нужен хотя бы один отдел', () => {
    for (const role of ['department', 'department_head'] as const) {
      expect(createUserSchema.safeParse({ ...base, role }).success, role).toBe(false);
      expect(
        createUserSchema.safeParse({ ...base, role, departmentIds: [DEPARTMENT_A] }).success,
        role,
      ).toBe(true);
    }
  });

  it('объекты и отделы вместе не бывают: учётка работает на одной оси', () => {
    expect(
      createUserSchema.safeParse({
        ...base,
        role: 'department_head',
        departmentIds: [DEPARTMENT_A],
        constructionObjectIds: [OBJECT_A],
      }).success,
    ).toBe(false);
    // Отдельно каждая ось проходит — запрещено именно сочетание.
    expect(
      createUserSchema.safeParse({ ...base, role: 'shtab', constructionObjectIds: [OBJECT_A] })
        .success,
    ).toBe(true);
  });

  it('объектной роли отделы не нужны, и наоборот', () => {
    expect(
      createUserSchema.safeParse({ ...base, role: 'shtab', departmentIds: [DEPARTMENT_A] }).success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({ ...base, role: 'department', constructionObjectIds: [OBJECT_A] })
        .success,
    ).toBe(false);
  });
});
