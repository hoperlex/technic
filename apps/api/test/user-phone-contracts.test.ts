import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  phoneSearchDigits,
  registerSchema,
  updateUserSchema,
} from '@technic/contracts';
import { phoneSearchCondition } from '../src/lib/pagination';
import { users } from '../src/db/schema';

/**
 * Телефон учётки (ADR 0043). Проверяется то, ради чего поле заводили именно необязательным: его
 * можно не оставлять — ни при регистрации, ни при заведении учётки администратором, — но если
 * оставили, то это номер, по которому дозвонятся, а не «нет» и не прочерк. Заполненное поле,
 * которое ничего не значит, хуже пустого: администратор по нему звонит.
 */

const REGISTER = {
  email: 'ivanov@example.com',
  lastName: 'Иванов',
  firstName: 'Иван',
  password: 'Sn3-verkhoyansk-77',
  requestedRole: 'dispatcher',
  captchaToken: 'token',
  captchaAnswer: '24680',
};

const USER = {
  email: 'ivanov@example.com',
  lastName: 'Иванов',
  firstName: 'Иван',
  role: 'dispatcher',
  password: 'Sn3-verkhoyansk-77',
};

describe('телефон при регистрации', () => {
  it('не указан — приходит пустой строкой, а не отсутствует', () => {
    // Пустая строка вместо undefined: колонка NOT NULL DEFAULT '', и различать «не прислали» и
    // «оставили пустым» при заведении учётки не нужно — это одно и то же.
    expect(registerSchema.parse(REGISTER).phone).toBe('');
    expect(registerSchema.parse({ ...REGISTER, phone: '' }).phone).toBe('');
  });

  it('записывается ровно так, как его ввели — формат свободный', () => {
    for (const phone of ['+7 926 123-45-67', '8(495)123-45-67 доб. 12', '495 12-34']) {
      expect(registerSchema.parse({ ...REGISTER, phone }).phone).toBe(phone);
    }
  });

  it('обрезает пробелы по краям — их приносит копирование из переписки', () => {
    expect(registerSchema.parse({ ...REGISTER, phone: '  +7 926 123-45-67 ' }).phone).toBe(
      '+7 926 123-45-67',
    );
  });

  it('отказ от номера пишут пустым полем, а не словами', () => {
    for (const phone of ['нет', '—', 'позвоните на почту', '12']) {
      expect(() => registerSchema.parse({ ...REGISTER, phone })).toThrow();
    }
  });

  it('не принимает строку длиннее поля', () => {
    expect(() => registerSchema.parse({ ...REGISTER, phone: '9'.repeat(51) })).toThrow();
  });
});

describe('телефон в карточке учётки', () => {
  it('администратор вправе завести учётку без телефона', () => {
    expect(createUserSchema.parse(USER).phone).toBe('');
    expect(createUserSchema.parse({ ...USER, phone: '+7 926 123-45-67' }).phone).toBe(
      '+7 926 123-45-67',
    );
  });

  it('правило одно и то же: мусор не пройдёт и от администратора', () => {
    expect(() => createUserSchema.parse({ ...USER, phone: 'нет' })).toThrow();
    expect(() => updateUserSchema.parse({ phone: 'нет' })).toThrow();
  });

  it('при правке «поля нет» и «поле пустое» — разные вещи', () => {
    // Первое — «не трогать телефон» (форма прислала только роль), второе — «стереть»: номер
    // сменился, и старый хуже отсутствующего, потому что по нему продолжают звонить.
    expect(updateUserSchema.parse({ role: 'dispatcher' }).phone).toBeUndefined();
    expect(updateUserSchema.parse({ phone: '' }).phone).toBe('');
  });
});

/**
 * Поиск по номеру. Хранится телефон так, как его ввели, поэтому искать его как текст бесполезно:
 * записанный «+7 (926) 123-45-67» не нашёлся бы ни по «8 926», ни по «9261234567». Сравниваются
 * цифры — и в запросе, и в колонке.
 */
describe('нормализация номера для поиска', () => {
  it('любое написание одного номера даёт одни и те же цифры', () => {
    const same = [
      '+7 (926) 123-45-67',
      '8 926 123 45 67',
      '8-926-123-45-67',
      '79261234567',
      '9261234567',
    ].map(phoneSearchDigits);
    expect(new Set(same).size).toBe(1);
    expect(same[0]).toBe('9261234567');
  });

  it('ищет и по куску номера — его чаще и помнят', () => {
    expect(phoneSearchDigits('123-45-67')).toBe('1234567');
    expect(phoneSearchDigits('926')).toBe('926');
  });

  it('ведущая восьмёрка снимается только у одиннадцатизначного', () => {
    // Городской «8 (495) 12-34» — это не «+7» перед номером, и цифру терять нельзя.
    expect(phoneSearchDigits('84951234')).toBe('84951234');
  });

  it('запрос без номера номером не считается', () => {
    // Иначе поиск по фамилии отобрал бы каждого, у кого телефон вообще заполнен.
    for (const term of ['Иванов', '', 'дом 7', 'кв. 12']) {
      expect(phoneSearchDigits(term)).toBe('');
      expect(phoneSearchCondition(term, users.phone)).toBeUndefined();
    }
    expect(phoneSearchCondition(undefined, users.phone)).toBeUndefined();
    expect(phoneSearchCondition('+7 926 123-45-67', users.phone)).toBeDefined();
  });
});
