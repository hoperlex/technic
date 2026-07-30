import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  formatFullName,
  formatShortName,
  normalizeNamePart,
  passwordSchema,
  registerSchema,
  splitFullName,
  updateUserSchema,
} from '@technic/contracts';

/**
 * ФИО хранится по частям (ADR 0034), а `full_name` считает база. Здесь проверяется вход:
 * что именно приложение кладёт в эти три колонки. Расхождение правил клиента и сервера дало бы
 * форму, принимающую то, что API отвергнет, — поэтому правила живут в контрактах, а не в UI.
 */

const CAPTCHA = { captchaToken: 'token', captchaAnswer: '24680' };
const VALID_REGISTRATION = {
  email: 'ivanov@example.com',
  lastName: 'Иванов',
  firstName: 'Иван',
  middleName: 'Иванович',
  password: 'Sn3-verkhoyansk-77',
  requestedRole: 'dispatcher' as const,
  ...CAPTCHA,
};

describe('нормализация частей ФИО', () => {
  it('схлопывает пробелы и обрезает края', () => {
    expect(normalizeNamePart('  ван   дер  Берг ')).toBe('ван дер Берг');
    const parsed = registerSchema.parse({ ...VALID_REGISTRATION, lastName: '  Иванов  ' });
    expect(parsed.lastName).toBe('Иванов');
  });

  it('отчество необязательно и превращается в пустую строку', () => {
    const { middleName: _drop, ...withoutMiddleName } = VALID_REGISTRATION;
    expect(registerSchema.parse(withoutMiddleName).middleName).toBe('');
    expect(registerSchema.parse({ ...VALID_REGISTRATION, middleName: '   ' }).middleName).toBe('');
  });

  it('фамилия и имя обязательны', () => {
    expect(() => registerSchema.parse({ ...VALID_REGISTRATION, lastName: ' ' })).toThrow();
    expect(() => registerSchema.parse({ ...VALID_REGISTRATION, firstName: '' })).toThrow();
  });

  it('дефис, апостроф и составные фамилии допустимы, цифры и знаки — нет', () => {
    expect(
      registerSchema.parse({ ...VALID_REGISTRATION, lastName: 'Салтыков-Щедрин' }),
    ).toBeTruthy();
    expect(registerSchema.parse({ ...VALID_REGISTRATION, lastName: "О'Коннор" })).toBeTruthy();
    expect(registerSchema.parse({ ...VALID_REGISTRATION, lastName: 'ван дер Берг' })).toBeTruthy();
    expect(() => registerSchema.parse({ ...VALID_REGISTRATION, lastName: 'Иванов2' })).toThrow();
    expect(() => registerSchema.parse({ ...VALID_REGISTRATION, lastName: 'Иванов_' })).toThrow();
  });

  it('латиница внутри кириллического слова отклоняется, отдельным словом — нет', () => {
    // «Ивaнов» с латинской «a»: визуально та же фамилия, а для поиска и сверки — другая.
    expect(() => registerSchema.parse({ ...VALID_REGISTRATION, lastName: 'Ивaнов' })).toThrow();
    expect(registerSchema.parse({ ...VALID_REGISTRATION, firstName: 'Jean' })).toBeTruthy();
  });
});

describe('склейка и разбор ФИО', () => {
  it('полное ФИО без отчества не тянет за собой лишний пробел', () => {
    expect(formatFullName({ lastName: 'Иванов', firstName: 'Иван', middleName: '' })).toBe(
      'Иванов Иван',
    );
  });

  it('короткая форма — фамилия и инициалы', () => {
    expect(formatShortName({ lastName: 'Иванов', firstName: 'иван', middleName: 'Иванович' })).toBe(
      'Иванов И. И.',
    );
    expect(formatShortName({ lastName: 'Иванов', firstName: 'Иван', middleName: '' })).toBe(
      'Иванов И.',
    );
  });

  it('разбор строки: хвост сверх двух слов целиком уходит в отчество', () => {
    expect(splitFullName('Иванов Иван Иванович')).toEqual({
      lastName: 'Иванов',
      firstName: 'Иван',
      middleName: 'Иванович',
    });
    expect(splitFullName('Алиев Рустам Мамед оглы').middleName).toBe('Мамед оглы');
    expect(splitFullName('Администратор')).toEqual({
      lastName: 'Администратор',
      firstName: '',
      middleName: '',
    });
  });
});

describe('прочность пароля', () => {
  it('длины мало: последовательности и частые пароли отклоняются', () => {
    expect(() => passwordSchema.parse('1234567890')).toThrow();
    expect(() => passwordSchema.parse('qwertyuiop')).toThrow();
    expect(() => passwordSchema.parse('password123')).toThrow();
    expect(() => passwordSchema.parse('aaaaaaaaaa')).toThrow();
    expect(passwordSchema.parse('Sn3-verkhoyansk-77')).toBeTruthy();
  });

  it('пароль не должен содержать email, фамилию или имя', () => {
    expect(() =>
      registerSchema.parse({ ...VALID_REGISTRATION, password: 'ivanov-parol-1' }),
    ).toThrow();
    expect(() =>
      createUserSchema.parse({
        email: 'petrov@example.com',
        lastName: 'Петров',
        firstName: 'Пётр',
        role: 'dispatcher',
        password: 'petrov@example.com',
      }),
    ).toThrow();
  });
});

describe('обновление пользователя', () => {
  it('части ФИО передаются по отдельности и каждая необязательна', () => {
    expect(updateUserSchema.parse({ lastName: '  Петров ' }).lastName).toBe('Петров');
    expect(updateUserSchema.parse({ role: 'dispatcher' }).lastName).toBeUndefined();
    // Пустое отчество — законное значение: «стереть отчество», а не «не трогать».
    expect(updateUserSchema.parse({ middleName: '' }).middleName).toBe('');
    expect(() => updateUserSchema.parse({ firstName: '' })).toThrow();
  });
});
