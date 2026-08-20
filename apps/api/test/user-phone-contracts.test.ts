import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  formatPhone,
  normalizePhone,
  phoneSearchDigits,
  registerSchema,
  updateUserSchema,
} from '@technic/contracts';
import { phoneSearchCondition } from '../src/lib/pagination';
import { users } from '../src/db/schema';

/**
 * Телефон учётки (ADR 0043) и его единый формат (ADR 0066). Проверяется два свойства сразу:
 * поле по-прежнему можно не заполнять — но заполненное приводится к одному виду, десяти цифрам
 * без кода страны, каким бы написанием его ни ввели. Заполненное поле, которое ничего не
 * значит, хуже пустого: администратор по нему звонит.
 */

const REGISTER = {
  email: 'ivanov@example.com',
  lastName: 'Иванов',
  firstName: 'Иван',
  password: 'Sn3-verkhoyansk-77',
  requestedRole: 'dispatcher',
  captchaToken: 'token',
};

const USER = {
  email: 'ivanov@example.com',
  lastName: 'Иванов',
  firstName: 'Иван',
  role: 'dispatcher',
  password: 'Sn3-verkhoyansk-77',
};

/**
 * Приведение номера к виду хранения. Одно правило на все восемь телефонных колонок портала —
 * поэтому оно и проверяется само по себе, а не через каждую схему.
 */
describe('нормализация номера', () => {
  it('любое написание одного номера даёт одни и те же десять цифр', () => {
    const same = [
      '+7 (926) 123-45-67',
      '8 926 123 45 67',
      '8-926-123-45-67',
      '79261234567',
      '9261234567',
      '  +7 926 1234567  ',
    ].map(normalizePhone);
    expect(new Set(same).size).toBe(1);
    expect(same[0]).toBe('9261234567');
  });

  it('не номер — `null`, а не догадка', () => {
    // Городской с добавочным и короткий внутренний к десяти цифрам не сводятся: строгость
    // формата — принятая цена единого вида (ADR 0066 п. 5), а не недосмотр.
    for (const value of ['', 'нет', '—', '495 12-34', '8(495)123-45-67 доб. 12', '9261234']) {
      expect(normalizePhone(value)).toBeNull();
    }
  });

  it('ведущая 7 или 8 снимается только у одиннадцатизначного', () => {
    // У десятизначного «8442…» восьмёрка — код региона (Волгоград), и терять её нельзя.
    expect(normalizePhone('8442123456')).toBe('8442123456');
    expect(normalizePhone('88442123456')).toBe('8442123456');
  });
});

describe('вид номера для человека', () => {
  it('печатается и показывается одинаково — от цифр и от любого написания', () => {
    expect(formatPhone('9261234567')).toBe('+7 (926) 123 45 67');
    expect(formatPhone('8 926 123-45-67')).toBe('+7 (926) 123 45 67');
    // Повторное применение ничего не меняет: вид уже конечный.
    expect(formatPhone(formatPhone('9261234567'))).toBe('+7 (926) 123 45 67');
  });

  it('несводимую запись показывает как есть, а не прячет', () => {
    // Так выглядят записи старше нормализации (миграция 0095 их не трогала) и реквизит шапки
    // бланка, где номеров два. Спрятать их значило бы отнять единственный способ дозвониться.
    expect(formatPhone('8(495)123-45-67 доб. 12')).toBe('8(495)123-45-67 доб. 12');
    expect(formatPhone('(495) 616-23-21, +7-985-211-27-24')).toBe(
      '(495) 616-23-21, +7-985-211-27-24',
    );
    expect(formatPhone('')).toBe('');
  });
});

describe('телефон при регистрации', () => {
  it('не указан — приходит пустой строкой, а не отсутствует', () => {
    // Пустая строка вместо undefined: колонка NOT NULL DEFAULT '', и различать «не прислали» и
    // «оставили пустым» при заведении учётки не нужно — это одно и то же.
    //
    // Схема пустой номер по-прежнему принимает, хотя форма регистрации его уже требует
    // (ADR 0066 п. 6): у учёток, заведённых до этого правила, телефона нет, и обязательность на
    // уровне API сделала бы их непроходимыми для правки.
    expect(registerSchema.parse(REGISTER).phone).toBe('');
    expect(registerSchema.parse({ ...REGISTER, phone: '' }).phone).toBe('');
  });

  it('приводится к десяти цифрам, как бы его ни записали', () => {
    for (const phone of ['+7 926 123-45-67', '8(926)1234567', '  9261234567 ']) {
      expect(registerSchema.parse({ ...REGISTER, phone }).phone).toBe('9261234567');
    }
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
    expect(createUserSchema.parse({ ...USER, phone: '+7 926 123-45-67' }).phone).toBe('9261234567');
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
 * Поиск по номеру. Ищут по тому, что помнят или видят на экране, — по куску, по старому
 * написанию, по номеру с кодом страны, — и находиться обязаны и нормализованные записи, и
 * оставшиеся от свободного формата. Поэтому сравниваются цифры, а не текст.
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
    // Тем и отличается от `normalizePhone`: тот берёт номер целиком, а в поиск вводят хвост.
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
