import { describe, expect, it } from 'vitest';
import {
  REGISTRATION_ROLE_REQUESTS,
  registerSchema,
  registrationRequestDetail,
  registrationRoleRequestLabels,
  registrationRoleRequestRole,
  ROLES,
} from '@technic/contracts';

/**
 * Пожелание по роли в заявке на регистрацию (ADR 0034). Главное свойство, которое здесь
 * проверяется: пожелание **не** назначает роль. Если оно когда-нибудь начнёт попадать в
 * `users.role`, саморегистрация станет выдачей прав, а «заявка = не активна и без роли»
 * перестанет отличать заявку от деактивированной учётки.
 */

const BASE = {
  email: 'ivanov@example.com',
  lastName: 'Иванов',
  firstName: 'Иван',
  password: 'Sn3-verkhoyansk-77',
  captchaToken: 'token',
  captchaAnswer: '24680',
};

describe('перечень пожеланий', () => {
  it('у каждого варианта есть подпись, требование уточнения и решение по роли', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      expect(registrationRoleRequestLabels[request]).toBeTruthy();
      expect(registrationRequestDetail[request]).toBeTruthy();
      const role = registrationRoleRequestRole[request];
      // null — соответствия в портале нет; иначе роль обязана существовать в матрице прав.
      expect(role === null || (ROLES as readonly string[]).includes(role)).toBe(true);
    }
  });

  it('«Сотрудник объекта» — это роль «Штаб», названная понятнее', () => {
    expect(registrationRoleRequestRole.site_staff).toBe('shtab');
    expect(registrationRoleRequestLabels.site_staff).toBe('Сотрудник объекта');
  });

  it('арендодателю техники и «другому» роль не соответствует', () => {
    expect(registrationRoleRequestRole.vehicle_lessor).toBeNull();
    expect(registrationRoleRequestRole.other).toBeNull();
  });
});

describe('уточнение к пожеланию', () => {
  it('объектные роли требуют объект', () => {
    for (const request of ['rukstroy', 'site_staff'] as const) {
      expect(() => registerSchema.parse({ ...BASE, requestedRole: request })).toThrow();
      expect(
        registerSchema.parse({ ...BASE, requestedRole: request, requestedObject: 'ЖК Северный' })
          .requestedObject,
      ).toBe('ЖК Северный');
    }
  });

  it('операторы требуют название компании', () => {
    for (const request of ['waste_operator', 'vehicle_lessor'] as const) {
      expect(() => registerSchema.parse({ ...BASE, requestedRole: request })).toThrow();
      expect(
        registerSchema.parse({ ...BASE, requestedRole: request, requestedCompany: 'ООО «Ромашка»' })
          .requestedCompany,
      ).toBe('ООО «Ромашка»');
    }
  });

  it('диспетчеру и «другому» уточнение не нужно', () => {
    expect(registerSchema.parse({ ...BASE, requestedRole: 'dispatcher' })).toBeTruthy();
    expect(registerSchema.parse({ ...BASE, requestedRole: 'other' })).toBeTruthy();
  });

  it('лишнее уточнение стирается, а не оседает в базе', () => {
    const parsed = registerSchema.parse({
      ...BASE,
      requestedRole: 'dispatcher',
      requestedObject: 'ЖК Северный',
      requestedCompany: 'ООО «Ромашка»',
    });
    expect(parsed.requestedObject).toBe('');
    expect(parsed.requestedCompany).toBe('');
  });

  it('уточнение не той разновидности тоже стирается', () => {
    const parsed = registerSchema.parse({
      ...BASE,
      requestedRole: 'site_staff',
      requestedObject: 'ЖК Северный',
      requestedCompany: 'ООО «Ромашка»',
    });
    expect(parsed.requestedObject).toBe('ЖК Северный');
    expect(parsed.requestedCompany).toBe('');
  });

  it('пробелы уточнением не считаются', () => {
    expect(() =>
      registerSchema.parse({ ...BASE, requestedRole: 'site_staff', requestedObject: '   ' }),
    ).toThrow();
  });
});

describe('пожелание — не роль', () => {
  it('пожелание обязательно, а роли в разобранной заявке нет вовсе', () => {
    expect(() => registerSchema.parse(BASE)).toThrow();
    const parsed = registerSchema.parse({ ...BASE, requestedRole: 'dispatcher' });
    expect('role' in parsed).toBe(false);
  });

  it('значение вне перечня отклоняется', () => {
    expect(() => registerSchema.parse({ ...BASE, requestedRole: 'admin' })).toThrow();
    expect(() => registerSchema.parse({ ...BASE, requestedRole: 'shtab' })).toThrow();
  });
});
