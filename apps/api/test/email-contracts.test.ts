import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  emailSchema,
  loginSchema,
  normalizeEmail,
  optionalEmailSchema,
  registerSchema,
} from '@technic/contracts';

/**
 * Правило адреса — одно на портал (`contracts/email.ts`). Тест держит именно это: вход,
 * регистрация и заведение учётки администратором ведут к одной схеме, а не к трём похожим. Пока
 * они расходились, форма регистрации отправляла адрес, который сама считала верным, и получала от
 * сервера «Ошибка валидации данных: Email» без объяснения.
 */

const ADDRESS = 'davidovsergej777@gmail.com';

describe('приведение адреса', () => {
  it('снимает пробелы по краям и внутри — адрес из копипасты', () => {
    expect(normalizeEmail(` ${ADDRESS} `)).toBe(ADDRESS);
    expect(normalizeEmail('davidovsergej777@gmail. com')).toBe(ADDRESS);
    expect(normalizeEmail('davidovsergej777@gmail.\ncom')).toBe(ADDRESS);
  });

  it('снимает невидимое: неразрывный пробел и нулевую ширину', () => {
    // Из Word и Outlook адрес приходит с неразрывным пробелом (U+00A0), из веба — с пробелом
    // нулевой ширины (U+200B). Ни того, ни другого в поле не видно, и отказ по ним человек
    // прочитать не может. В самом тесте они записаны escape-последовательностями намеренно:
    // литеральный невидимый символ в исходнике не отличить от опечатки (линт его и не пускает).
    expect(normalizeEmail('davidovsergej777@gmail.com\u00a0')).toBe(ADDRESS);
    expect(normalizeEmail('davidovsergej777@\u200bgmail.com')).toBe(ADDRESS);
  });

  it('регистр оставляет как есть — в БД адрес лежит в citext', () => {
    expect(normalizeEmail('Ivanov@SU10.ru')).toBe('Ivanov@SU10.ru');
  });
});

describe('схема адреса', () => {
  it('принимает адрес с пробелами и отдаёт приведённый', () => {
    expect(emailSchema.parse('davidovsergej777@gmail. com')).toBe(ADDRESS);
    expect(optionalEmailSchema.parse(' ivanov@su10.ru ')).toBe('ivanov@su10.ru');
  });

  it('отвергает то, что приведением не спасти', () => {
    expect(emailSchema.safeParse('не адрес').success).toBe(false);
    expect(emailSchema.safeParse('').success).toBe(false);
    expect(emailSchema.safeParse('ivanov@su10').success).toBe(false);
  });

  it('пустое поле необязательного адреса — «не указан», а не ошибка', () => {
    expect(optionalEmailSchema.parse('   ')).toBe('');
  });

  it('сообщение об ошибке — по-русски: его читает человек у поля', () => {
    const parsed = emailSchema.safeParse('не адрес');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.message).toBe('Некорректный email');
  });
});

describe('одно правило на вход, регистрацию и заведение учётки', () => {
  const REGISTRATION = {
    email: 'davidovsergej777@gmail. com',
    lastName: 'Давыдов',
    firstName: 'Сергей',
    middleName: '',
    phone: '9261234567',
    password: 'Konstruktor-7431',
    requestedRole: 'driver' as const,
    captchaToken: 'token',
    captchaAnswer: '12345',
  };

  it('регистрация принимает адрес с пробелом и приводит его', () => {
    const parsed = registerSchema.parse(REGISTRATION);
    expect(parsed.email).toBe(ADDRESS);
  });

  it('вход принимает тот же адрес — иначе войти по заведённому логину нельзя', () => {
    expect(loginSchema.parse({ email: ` ${ADDRESS} `, password: 'secret-123' }).email).toBe(
      ADDRESS,
    );
  });

  it('заведение учётки администратором — та же схема', () => {
    const parsed = createUserSchema.parse({
      email: 'davidovsergej777@gmail. com',
      lastName: 'Давыдов',
      firstName: 'Сергей',
      middleName: '',
      role: 'dispatcher',
      password: 'Konstruktor-7431',
    });
    expect(parsed.email).toBe(ADDRESS);
  });
});
