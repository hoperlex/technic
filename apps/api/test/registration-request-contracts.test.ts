import { describe, expect, it } from 'vitest';
import {
  activationDefaultsFor,
  ADMIN_GRANTS,
  ALL_SYSTEM_GRANT_CODES,
  ARCHIVED_REQUEST_ROLE_LABELS,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  expectedCounterpartyType,
  expectsCorporateEmail,
  INTERNAL_EMAIL_DOMAINS,
  isExternalRegistrationEmail,
  isInternalEmail,
  isRetiringRole,
  MODULE_GRANTS,
  REGISTRATION_ROLE_REQUESTS,
  registerSchema,
  registrationRequestDetail,
  registrationRequestIssue,
  registrationRoleRequestLabels,
  requestRoleTitle,
  ROLE_GRANTS,
  ROLE_MIGRATIONS,
  ROLES,
  type RegistrationRoleRequest,
  type Role,
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
};

/**
 * Совместимые роли набора по его коду — из тех каталогов, откуда таблица умолчаний коды берёт.
 *
 * Наборы перехода (`SYSTEM_GRANT_CODES`) сюда не входят намеренно: они отражают надстройки, и
 * совместимость у них своя. Появись такой код в умолчаниях — тест скажет об этом отсутствием
 * строки каталога, а не молчаливым пропуском проверки.
 */
const GRANT_CATALOG: Readonly<Record<string, { readonly roles: readonly Role[] }>> = {
  ...ADMIN_GRANTS,
  ...ROLE_GRANTS,
  ...MODULE_GRANTS,
};

/**
 * Пожелание, которым регистрируется человек с упраздняемой ролью, — вторая половина сверки с
 * таблицей перевода. Пар четыре, ровно по числу строк `ROLE_MIGRATIONS`, и три из них тождественны
 * по имени; исключение одно — `shtab`, которого в перечне пожеланий нет никогда: заявитель
 * называет себя должностью, а не строкой таблицы прав.
 */
const MIGRATION_TWINS: Readonly<Record<string, RegistrationRoleRequest>> = {
  shtab: 'site_staff',
  rukstroy: 'rukstroy',
  commandant: 'commandant',
  department_head: 'department_head',
};

describe('перечень пожеланий', () => {
  it('у каждого варианта есть подпись, требование уточнения и решение по умолчанию', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      expect(registrationRoleRequestLabels[request]).toBeTruthy();
      expect(registrationRequestDetail[request]).toBeTruthy();
      // Таблица умолчаний обязана отвечать на каждое пожелание — молчания в ней нет: `null` в роли
      // это тоже ответ («умолчания нет, выбирает администратор»), а `undefined` означал бы забытую
      // строку, и форма рассмотрения открылась бы пустой, не сообщив об этом. То же и с наборами:
      // пустой список — «роль без полномочий», а не «полномочия неизвестны».
      const defaults = activationDefaultsFor(request);
      expect(defaults.role).not.toBeUndefined();
      expect(Array.isArray(defaults.grants), request).toBe(true);
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
      const role = activationDefaultsFor(request).role;
      expect(role === null || (ROLES as readonly string[]).includes(role)).toBe(true);
    }
  });

  /**
   * Три площадочных пожелания ведут к одной роли — и это ровно то решение, которое таблица
   * умолчаний обязана была принять при упразднении ролей (см. её же docstring): «перенацелить
   * умолчание на роль, в которую слили прежнюю». Перенацелены они шагом prepare этапа 8
   * (ADR 0113) — тем самым, который закрыл вход в упраздняемые роли: оставь мы прежние умолчания,
   * форма рассмотрения открывалась бы с ролью, которую сервер отвергает.
   *
   * Различие между тремя должностями от этого не пропадает, а переезжает в наборы: заказ техники у
   * сотрудника объекта, он же плюс виза у руководителя строительства, ничего у коменданта.
   */
  it('площадочные пожелания ведут к роли «Площадка» — три должности, одна роль', () => {
    expect(activationDefaultsFor('site_staff')).toEqual({
      role: 'site',
      grants: ['vehicle_ordering'],
    });
    expect(activationDefaultsFor('rukstroy')).toEqual({
      role: 'site',
      grants: ['vehicle_ordering', 'site_approval'],
    });
    expect(activationDefaultsFor('commandant')).toEqual({ role: 'site', grants: [] });
    expect(registrationRoleRequestLabels.site_staff).toBe('Сотрудник объекта');
  });

  /**
   * Отдел устроен той же парой, что площадка: сотрудник и руководитель отличаются одной визой.
   * Роль в умолчании — `department`, а не одноимённое пожеланию `department_head`: эта роль
   * упраздняется этапом 9, и подставить её значило бы открыть форму значением, которое сервер
   * отклоняет.
   */
  it('пожелания отдела ведут к роли «Отдел», а виза приезжает набором', () => {
    expect(activationDefaultsFor('department_staff')).toEqual({ role: 'department', grants: [] });
    expect(activationDefaultsFor('department_head')).toEqual({
      role: 'department',
      grants: ['department_approval'],
    });
  });

  it('ни одно умолчание не указывает на упраздняемую роль', () => {
    // Иначе форма подставила бы роль, которую сервер отклоняет (`retiringRoleIssue`), и заявку
    // нельзя было бы рассмотреть, не разобравшись сперва в реформе.
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      expect(isRetiringRole(activationDefaultsFor(request).role), request).toBe(false);
    }
  });

  /**
   * Набор, несовместимый с подставляемой ролью, — это галочка, которую форма поставит, а сервер
   * отклонит гейтом совместимости: заявка окажется нерассматриваемой, и виноватым будет выглядеть
   * администратор. Сверяется поимённо с каталогом, потому что состав ролей у набора правится в
   * `grants.ts` и о таблице умолчаний там никто не помнит.
   */
  it('каждый подставляемый набор совместим с подставляемой ролью', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      const { role, grants } = activationDefaultsFor(request);
      for (const code of grants) {
        expect((ALL_SYSTEM_GRANT_CODES as readonly string[]).includes(code), code).toBe(true);
        const roles = GRANT_CATALOG[code]?.roles;
        expect(roles, `${request}: набора «${code}» нет в сверяемых каталогах`).toBeTruthy();
        // Наборов без роли не бывает: выдать их учётке, у которой роль не выбрана, нечем.
        expect(role, `${request}: набор «${code}» подставлен без роли`).not.toBeNull();
        expect(
          (roles ?? []) as readonly string[],
          `${request}: «${code}» несовместим с ролью «${role}»`,
        ).toContain(role);
      }
    }
  });

  /**
   * Умолчания и перевод ролей — две таблицы об одном: чем сотрудник объекта отличается от
   * коменданта. Разъедься они — новая учётка получала бы не то, что действующий штаб после
   * перевода, и разница объяснялась бы одним лишь тем, кто когда зарегистрировался.
   *
   * Порядок кодов не сверяется: в форме галочки идут порядком каталога, а не таблицы.
   */
  it('умолчания повторяют перевод ролей поимённо', () => {
    for (const migration of ROLE_MIGRATIONS) {
      const request = MIGRATION_TWINS[migration.from];
      expect(request, `у перевода «${migration.from}» нет пожелания-двойника`).toBeTruthy();
      const defaults = activationDefaultsFor(request);
      expect(defaults.role, migration.from).toBe(migration.to);
      expect([...defaults.grants].sort(), migration.from).toEqual([...migration.grants].sort());
    }
  });

  it('оба исполнителя ведут к роли исполнителя — различает их контрагент (ADR 0038)', () => {
    expect(activationDefaultsFor('waste_operator').role).toBe('operator');
    expect(activationDefaultsFor('vehicle_lessor').role).toBe('operator');
    expect(activationDefaultsFor('service_company').role).toBe('operator');
  });

  it('«другому» роль не подставляется — пожелание требует разбора', () => {
    expect(activationDefaultsFor('other')).toEqual({ role: null, grants: [] });
  });

  it('заявки без пожелания вовсе тоже отвечают — учётку завёл администратор', () => {
    // Отдельного случая у вызывающего быть не должно: форма открывается пустым выбором и там, где
    // пожелания нет в помине.
    expect(activationDefaultsFor(null)).toEqual({ role: null, grants: [] });
    expect(activationDefaultsFor(undefined).grants).toEqual([]);
  });
});

/**
 * Подпись пожелания читается функцией, а не словарём по месту: значение enum'а из Postgres не
 * удаляется никогда (`ALTER TYPE ... DROP VALUE` не существует), и на упразднённом пожелании
 * останутся стоять живые строки `users.requested_role`.
 */
describe('подпись пожелания по значению из базы', () => {
  it('действующее значение читается своей подписью', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      expect(requestRoleTitle(request)).toBe(registrationRoleRequestLabels[request]);
    }
  });

  it('неизвестное значение возвращается как есть, а не пустотой', () => {
    // Так выглядят два дня сразу: день упразднения пожелания и день отката портала на сборку, не
    // знающую нового значения. Код в строке заявки читается хуже подписи, но лучше прочерка — по
    // нему хотя бы видно, о чём речь, а строку уже не переписать.
    expect(requestRoleTitle('shtab')).toBe('shtab');
    expect(requestRoleTitle('')).toBe('');
  });

  it('архивная подпись не спорит с действующей', () => {
    // Сегодня словарь пуст — ни одно пожелание не упраздняется, — и проверка держит правило на
    // тот день, когда он наполнится: подпись **переносится**, а не копируется. Значение в обоих
    // словарях означало бы две подписи одному коду, расходящиеся с первой же правкой.
    for (const value of Object.keys(ARCHIVED_REQUEST_ROLE_LABELS)) {
      expect(REGISTRATION_ROLE_REQUESTS as readonly string[], value).not.toContain(value);
    }
  });
});

/**
 * Ожидаемый тип контрагента (ADR 0038): роль у трёх внешних пожеланий одна, а что учётка исполняет
 * — вывоз мусора, аренду техники или обслуживание оргтехники, — решает тип организации. Ошибка
 * здесь молчалива: подбор выберет одноимённую организацию не того типа, и администратор увидит
 * заполненное поле с правдоподобным названием.
 */
describe('ожидаемый тип контрагента', () => {
  it('у пожеланий про компанию тип задан, у прочих его нет', () => {
    for (const request of REGISTRATION_ROLE_REQUESTS) {
      const type = expectedCounterpartyType(request);
      if (registrationRequestDetail[request] === 'company') {
        expect(type, request).not.toBeNull();
        // Тип, за который в портале никто не работает, вёл бы заявку к контрагенту без единого
        // права — учётке на нём нечего было бы делать.
        expect(COUNTERPARTY_TYPES_WITH_ACCOUNTS as readonly (string | null)[], request).toContain(
          type,
        );
      } else {
        expect(type, request).toBeNull();
      }
    }
  });

  it('три внешних пожелания различаются типом, а не ролью', () => {
    expect(expectedCounterpartyType('waste_operator')).toBe('operator');
    expect(expectedCounterpartyType('vehicle_lessor')).toBe('vehicle_lessor');
    expect(expectedCounterpartyType('service_company')).toBe('service');
  });

  it('учётка без пожелания типа не ждёт', () => {
    expect(expectedCounterpartyType(null)).toBeNull();
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

  /**
   * Отдел пишется в ту же колонку, что и объект: смысл поля («где вы работаете») не меняется, и
   * четвёртого поля ради синонима не заводится. Отличие целиком в вопросе, который видит заявитель,
   * — поэтому проверяется и текст: «Укажите объект» под полем «Отдел» читалось бы как сбой формы.
   */
  it('пожелания отдела требуют подразделения — в поле объекта', () => {
    for (const request of ['department_staff', 'department_head'] as const) {
      expect(() => registerSchema.parse({ ...BASE, requestedRole: request })).toThrow();
      expect(
        registerSchema.parse({ ...BASE, requestedRole: request, requestedObject: 'Снабжение' })
          .requestedObject,
      ).toBe('Снабжение');
      expect(
        registrationRequestIssue({
          requestedRole: request,
          requestedObject: '',
          requestedCompany: '',
          requestedComment: '',
        }),
      ).toEqual({ field: 'requestedObject', message: 'Укажите отдел' });
    }
  });

  it('внешние исполнители требуют название компании', () => {
    for (const request of ['waste_operator', 'vehicle_lessor', 'service_company'] as const) {
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
      requestedComment: 'Работаю в ИТ-службе',
    });
    expect(parsed.requestedObject).toBe('');
    expect(parsed.requestedCompany).toBe('');
    // А вот комментарий переживает любое пожелание: он открыт всем как способ объясниться — узкие
    // должности своего пожелания не получают и приходят под общим, дописывая словами, кем
    // работают. Стёртое объяснение восстановить нечем, и заявку снова пришлось бы решать звонком.
    expect(parsed.requestedComment).toBe('Работаю в ИТ-службе');
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
    expect(parsed.requestedComment).toBe('Сметчик');
  });

  it('подразделение отдела не стирается вместе с чужими уточнениями', () => {
    // Оба вопроса пишут в одно поле, и разбирать их при нормализации значило бы стирать то, что
    // сам же и заполнил.
    const parsed = registerSchema.parse({
      ...BASE,
      requestedRole: 'department_head',
      requestedObject: 'Снабжение',
      requestedCompany: 'ООО «Ромашка»',
    });
    expect(parsed.requestedObject).toBe('Снабжение');
    expect(parsed.requestedCompany).toBe('');
  });

  it('пробелы уточнением не считаются', () => {
    expect(() =>
      registerSchema.parse({ ...BASE, requestedRole: 'site_staff', requestedObject: '   ' }),
    ).toThrow();
    expect(() =>
      registerSchema.parse({ ...BASE, requestedRole: 'department_staff', requestedObject: '   ' }),
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

/** От кого рабочего адреса не ждут: внешние исполнители, водитель и офис. */
const PERSONAL_EMAIL_REQUESTS = [
  'waste_operator',
  'vehicle_lessor',
  'service_company',
  'driver',
  'department_staff',
  'department_head',
] as const;

const CORPORATE_EMAIL_REQUESTS = [
  'site_staff',
  'rukstroy',
  'commandant',
  'dispatcher',
  'other',
] as const;

describe('рабочий адрес по пожеланию', () => {
  it('таблица отвечает на каждое пожелание — и ровно одним из двух ответов', () => {
    // Списки ниже перечислены руками, чтобы читались решением, а не выводом из таблицы; поэтому и
    // проверяется, что вместе они покрывают перечень: новое пожелание иначе выпало бы из обоих.
    const listed = [...PERSONAL_EMAIL_REQUESTS, ...CORPORATE_EMAIL_REQUESTS];
    expect([...listed].sort()).toEqual([...REGISTRATION_ROLE_REQUESTS].sort());
  });

  it('внешние исполнители и офис своей почты не предъявляют', () => {
    // У операторов и сервисной компании рабочая почта по определению не наша (ADR 0010), у
    // водителя она личная, а отдел освобождён решением опроса 28.08.2026: асимметрия с площадкой
    // объявлена риском плана, а не выводом из модели.
    for (const request of PERSONAL_EMAIL_REQUESTS) {
      expect(expectsCorporateEmail(request), request).toBe(false);
      expect(
        isExternalRegistrationEmail({ email: 'operator@mail.ru', requestedRole: request }),
        request,
      ).toBe(false);
    }
  });

  it('от остальных пожеланий ждут — это заявка своего сотрудника', () => {
    for (const request of CORPORATE_EMAIL_REQUESTS) {
      expect(expectsCorporateEmail(request), request).toBe(true);
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
