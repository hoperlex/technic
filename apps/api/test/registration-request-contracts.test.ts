import { describe, expect, it } from 'vitest';
import {
  defaultRoleForRequest,
  expectsCorporateEmail,
  INTERNAL_EMAIL_DOMAINS,
  isExternalRegistrationEmail,
  isInternalEmail,
  REGISTRATION_ROLE_REQUESTS,
  registerSchema,
  registrationRequestDetail,
  registrationRoleRequestLabels,
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
  it('у каждого варианта есть подпись, требование уточнения и решение по умолчанию', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      expect(registrationRoleRequestLabels[request]).toBeTruthy();
      expect(registrationRequestDetail[request]).toBeTruthy();
      // Таблица умолчаний обязана отвечать на каждое пожелание — молчания в ней нет: `null` это
      // тоже ответ («умолчания нет, выбирает администратор»), а `undefined` означал бы забытую
      // строку, и форма рассмотрения открылась бы пустой, не сообщив об этом.
      expect(defaultRoleForRequest(request)).not.toBeUndefined();
    }
  });

  /**
   * Главная проверка этой таблицы после развязывания имени роли и связи (§11.1 плана
   * реструктуризации прав): роли сливаются и упраздняются, а умолчание — единственное место, где
   * имя роли записано текстом рядом с пожеланием. Умолчание, указывающее на упразднённую роль, не
   * падает нигде: форма подставит несуществующее, портал покажет пустой выбор заполненным, а
   * сервер откажет схемой уже при сохранении.
   */
  it('ни одно умолчание не указывает на несуществующую роль', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      const role = defaultRoleForRequest(request);
      expect(role === null || (ROLES as readonly string[]).includes(role)).toBe(true);
    }
  });

  it('«Сотрудник объекта» — это роль «Штаб», названная понятнее', () => {
    expect(defaultRoleForRequest('site_staff')).toBe('shtab');
    expect(registrationRoleRequestLabels.site_staff).toBe('Сотрудник объекта');
  });

  it('комендант назван своей должностью — она и есть роль в портале', () => {
    expect(defaultRoleForRequest('commandant')).toBe('commandant');
    // Отдельный вариант, а не «сотрудник объекта»: роли разные — коменданту техника закрыта, и
    // администратор видит по пожеланию, какую из двух подставит форма.
    expect(defaultRoleForRequest('commandant')).not.toBe(defaultRoleForRequest('site_staff'));
  });

  it('оба исполнителя ведут к роли исполнителя — различает их контрагент (ADR 0038)', () => {
    expect(defaultRoleForRequest('waste_operator')).toBe('operator');
    expect(defaultRoleForRequest('vehicle_lessor')).toBe('operator');
  });

  it('«другому» роль не подставляется — пожелание требует разбора', () => {
    expect(defaultRoleForRequest('other')).toBeNull();
  });

  it('заявки без пожелания вовсе тоже отвечают — учётку завёл администратор', () => {
    // Отдельного случая у вызывающего быть не должно: форма открывается пустым выбором и там, где
    // пожелания нет в помине.
    expect(defaultRoleForRequest(null)).toBeNull();
  });
});

describe('уточнение к пожеланию', () => {
  it('объектные роли требуют объект', () => {
    for (const request of ['rukstroy', 'site_staff', 'commandant'] as const) {
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

  it('«другое» требует объяснения словами', () => {
    // Единственное пожелание без роли-соответствия: без комментария в заявке нет ничего, кроме
    // ФИО и адреса, — и рассматривать её пришлось бы звонком, ради отмены которого пожелания и
    // заводили.
    expect(() => registerSchema.parse({ ...BASE, requestedRole: 'other' })).toThrow();
    expect(
      registerSchema.parse({
        ...BASE,
        requestedRole: 'other',
        requestedComment: 'Сметчик, нужен просмотр заявок',
      }).requestedComment,
    ).toBe('Сметчик, нужен просмотр заявок');
  });

  it('диспетчеру и водителю уточнение не нужно', () => {
    expect(registerSchema.parse({ ...BASE, requestedRole: 'dispatcher' })).toBeTruthy();
    expect(registerSchema.parse({ ...BASE, requestedRole: 'driver' })).toBeTruthy();
  });

  it('лишнее уточнение стирается, а не оседает в базе', () => {
    const parsed = registerSchema.parse({
      ...BASE,
      requestedRole: 'dispatcher',
      requestedObject: 'ЖК Северный',
      requestedCompany: 'ООО «Ромашка»',
      requestedComment: 'Сметчик',
    });
    expect(parsed.requestedObject).toBe('');
    expect(parsed.requestedCompany).toBe('');
    expect(parsed.requestedComment).toBe('');
  });

  it('уточнение не той разновидности тоже стирается', () => {
    const parsed = registerSchema.parse({
      ...BASE,
      requestedRole: 'site_staff',
      requestedObject: 'ЖК Северный',
      requestedCompany: 'ООО «Ромашка»',
      requestedComment: 'Сметчик',
    });
    expect(parsed.requestedObject).toBe('ЖК Северный');
    expect(parsed.requestedCompany).toBe('');
    expect(parsed.requestedComment).toBe('');
  });

  it('пробелы уточнением не считаются', () => {
    expect(() =>
      registerSchema.parse({ ...BASE, requestedRole: 'site_staff', requestedObject: '   ' }),
    ).toThrow();
    expect(() =>
      registerSchema.parse({ ...BASE, requestedRole: 'other', requestedComment: '   ' }),
    ).toThrow();
  });
});

/**
 * Домен адреса в заявке (ADR 0090). Признак ничего не запрещает — по нему портал предупреждает
 * заявителя и помечает заявку администратору, — поэтому цена ошибки здесь односторонняя: чужой
 * адрес, принятый за свой, молча снимает предупреждение там, где оно и нужно.
 */
describe('свой домен и чужой', () => {
  it('адреса в доменах компании — свои, включая поддомены', () => {
    for (const domain of INTERNAL_EMAIL_DOMAINS) {
      expect(isInternalEmail(`ivanov@${domain}`)).toBe(true);
      // Поддомен принадлежит тому же домену: почта с `auto.su10.ru` — не внешняя служба.
      expect(isInternalEmail(`ivanov@auto.${domain}`)).toBe(true);
    }
  });

  it('регистр домена значения не имеет', () => {
    expect(isInternalEmail('Ivanov@SU10.RU')).toBe(true);
  });

  it('похожий домен своим не считается', () => {
    // Хвост сравнивается целыми метками, иначе домен, дописанный слева или справа, выдавал бы
    // себя за наш.
    expect(isInternalEmail('ivanov@su10.ru.example.com')).toBe(false);
    expect(isInternalEmail('ivanov@nesu10.ru')).toBe(false);
    expect(isInternalEmail('ivanov@mail.ru')).toBe(false);
  });

  it('строка без адреса своей не бывает', () => {
    expect(isInternalEmail('su10.ru')).toBe(false);
    expect(isInternalEmail('')).toBe(false);
  });
});

describe('рабочий адрес по пожеланию', () => {
  it('операторы работают от лица сторонней компании — своей почты от них не ждут', () => {
    for (const request of ['waste_operator', 'vehicle_lessor'] as const) {
      expect(expectsCorporateEmail(request)).toBe(false);
      expect(
        isExternalRegistrationEmail({ email: 'operator@mail.ru', requestedRole: request }),
      ).toBe(false);
    }
  });

  it('от остальных пожеланий ждут — это заявка своего сотрудника', () => {
    for (const request of [
      'dispatcher',
      'rukstroy',
      'site_staff',
      'commandant',
      'other',
    ] as const) {
      expect(expectsCorporateEmail(request)).toBe(true);
      expect(isExternalRegistrationEmail({ email: 'ivanov@mail.ru', requestedRole: request })).toBe(
        true,
      );
      expect(isExternalRegistrationEmail({ email: 'ivanov@su10.ru', requestedRole: request })).toBe(
        false,
      );
    }
  });

  it('учётка без пожелания признаком не помечается', () => {
    // Её завёл администратор, а не заявитель: адрес он выбрал сам, и предупреждать его не о чем.
    expect(isExternalRegistrationEmail({ email: 'ivanov@mail.ru', requestedRole: null })).toBe(
      false,
    );
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
