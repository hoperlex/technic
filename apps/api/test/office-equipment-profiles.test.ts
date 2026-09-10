import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  actsAsRequestCustomer,
  actsAsServiceExecutorOnly,
  ALL_SYSTEM_GRANT_CODES,
  audienceMatches,
  can,
  canChangeRequestAsCustomer,
  canWriteChat,
  hasModuleWideScope,
  MODULE_GRANT_CODES,
  MODULE_GRANTS,
  OFFICE_EQUIPMENT_EXECUTOR_GRANT,
  OFFICE_EQUIPMENT_IT_GRANT,
  OFFICE_EQUIPMENT_OPERATOR_GRANT,
  OFFICE_EQUIPMENT_PROFILE_REGISTRY,
  OFFICE_EQUIPMENT_PROFILES,
  OFFICE_EQUIPMENT_REQUESTER_GRANT,
  officeEquipmentProfilesOf,
  participantSidesOf,
  ROLE_ADDON_PERMISSIONS,
  ROLES,
  roleScopeAxis,
  SERVICE_CHAT_SIDES,
  type AccessSubject,
  type RequestCustomerFacts,
  type Role,
  type ServiceChatFacts,
} from '@technic/contracts';

/**
 * Реестр бизнес-профилей модуля «Орг.техника» и опознание профиля КОДОМ НАБОРА
 * (`docs/office-equipment-access-profiles-plan.md`, Р3 и Р9; unit-часть Т14).
 *
 * Главное утверждение файла: профиль — это выданный набор, а не сумма прав. До этого шага сторона
 * обсуждения «Системный администратор» держалась на `serviceRequests.approveIt` — праве мёртвом
 * (виза упразднена вместе с ручкой и коридором), и уборка этого права из набора погасила бы сторону
 * молча, вместе с яркой меткой и письмом. Сторона «Ведение» держалась на конъюнкции
 * `status && assign`, которую с назначаемыми полномочиями (ADR 0106) собирает в проде кто угодно.
 *
 * УБОРКА СОСТОЯЛАСЬ (Э9, миграция E): мёртвого права в наборе ИТ-службы больше нет, а сторона `it`
 * на месте — ровно потому, что опознание переехало на код заранее. Переходное сравнение стороны
 * `it` с прежней формулой снято тем же выпуском: сравнивать стало не с чем.
 *
 * Т14 ДОЕХАЛА ЦЕЛИКОМ. Этап Э6 завёл `office_equipment_executor` (миграция 0262), этап Э7 —
 * `office_equipment_requester` (миграция D): исключений в реестре не осталось ни одного, и
 * проверка «каждый код реестра существует в каталоге» стала полной. Здесь она смотрит на КОД
 * (сводный перечень контрактов и составы наборов); сверку реестра с БАЗОЙ ведёт
 * `grants-catalog.db.test.ts`, а поведение держателей — `office-equipment-profiles.db.test.ts`.
 */

/** Никто ни к заявке, ни к её сторонам отношения не имеет: чистый субъект без единого факта. */
const NO_FACTS: ServiceChatFacts = {
  userId: '11111111-1111-4111-8111-111111111111',
  isAuthor: false,
  inCustomerScope: false,
  actsForAssignedService: false,
  isNamedExecutor: false,
};

const PROFILES = OFFICE_EQUIPMENT_PROFILES.map((id) => OFFICE_EQUIPMENT_PROFILE_REGISTRY[id]);

describe('Реестр профилей модуля «Орг.техника» (Р3)', () => {
  it('перечень и таблица описывают одни и те же четыре профиля', () => {
    expect(Object.keys(OFFICE_EQUIPMENT_PROFILE_REGISTRY)).toEqual([...OFFICE_EQUIPMENT_PROFILES]);
    expect(new Set(OFFICE_EQUIPMENT_PROFILES).size).toBe(OFFICE_EQUIPMENT_PROFILES.length);
    for (const profile of PROFILES) expect(profile.label.trim()).not.toBe('');
  });

  /**
   * Коды — не украшение таблицы, а то, чем профиль выдают. Пустая строка или пробел здесь означали
   * бы выдачу, которой не существует, а один код на два профиля — что снятие набора у одного гасит
   * профиль у другого.
   */
  it('коды непусты и не дублируются между профилями', () => {
    const codes = PROFILES.flatMap((profile) => profile.grants);
    for (const code of codes) expect(code).toBe(code.trim());
    for (const code of codes) expect(code).not.toBe('');
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * ИТ-профиль выдаётся РОВНО ДВУМЯ кодами (Р4, план аудита исполнителей): координация видит модуль
   * сквозным, работа руками открывается назначением. Порядок значим — так их сохраняет форма учётки
   * (Э8), атомарно и парой.
   */
  it('«Системный администратор» требует ровно двух кодов, «Заявитель» — одного', () => {
    expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY.it.grants).toEqual([
      OFFICE_EQUIPMENT_IT_GRANT,
      OFFICE_EQUIPMENT_EXECUTOR_GRANT,
    ]);
    expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY.requester.grants).toEqual([
      OFFICE_EQUIPMENT_REQUESTER_GRANT,
    ]);
    expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY.operator.grants).toEqual([
      OFFICE_EQUIPMENT_OPERATOR_GRANT,
    ]);
  });

  /**
   * Сервисный центр наборами не выдаётся вовсе (Р11): он выражается парой «роль + тип контрагента»,
   * и набором быть не может — набор scope-neutral, а видимость подрядчика считает предикат по
   * контрагенту. Пустой список здесь — запрет, и проверяется он вместе с обратной половиной: у
   * остальных трёх профилей контрагента нет.
   */
  it('«Сервисный центр» кодами не выдаётся, и связь с контрагентом есть только у него', () => {
    expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY.service.grants).toEqual([]);
    expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY.service.counterpartyType).toBe('service');
    for (const id of OFFICE_EQUIPMENT_PROFILES.filter((p) => p !== 'service')) {
      expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY[id].counterpartyType, id).toBeNull();
      expect(OFFICE_EQUIPMENT_PROFILE_REGISTRY[id].grants.length, id).toBeGreaterThan(0);
    }
  });

  /**
   * У профиля одна ОСНОВНАЯ сторона, и стороны между профилями не повторяются: подпись «профиль
   * такой-то» обязана читаться в обе стороны. Полный набор сторон конкретной заявки при этом
   * считает `participantSidesOf` — у ИТ-службы при назначении их две, — и реестр на это не влияет.
   */
  it('основных сторон ровно четыре, по одной на профиль, и `all` среди них нет', () => {
    const sides = PROFILES.map((profile) => profile.primaryChatSide);
    expect(new Set(sides).size).toBe(sides.length);
    expect(sides).not.toContain('all');
    expect([...sides].sort()).toEqual(SERVICE_CHAT_SIDES.filter((s) => s !== 'all').sort());
  });

  /**
   * Т14, ГЛАВНОЕ УТВЕРЖДЕНИЕ, И ТЕПЕРЬ ОНО ПОЛНОЕ (этап Э7, миграция D): **каждый код реестра
   * существует в каталоге**, без единого исключения.
   *
   * До Э7 здесь стояло переходное утверждение «три кода из четырёх»: `…_requester` был назван
   * реестром, но не заведён никем, и перечислять его приходилось отдельной строкой ожидаемого
   * отсутствия. Реестр называл код раньше каталога намеренно — иначе профиль «Заявитель» нельзя
   * было бы описать ничем, а он существует и без набора, базовым состоянием роли (Р6).
   *
   * Проверка смотрит на СВОДНЫЙ перечень `ALL_SYSTEM_GRANT_CODES`, а не на четыре списка по
   * отдельности, и отвечает поэтому на второй вопрос заодно: «попал ли код в тот список, по
   * которому страж каталога сверяет базу». Забытая строка там означает не падение, а молчание
   * стража — то есть набор, состав которого не сверяет никто.
   *
   * Компилятор ту же вещь держит с другой стороны: обе константы реестра объявлены
   * `satisfies ModuleGrantCode`, а две первые — `satisfies SystemGrantCode`. Тест этого не
   * дублирует: `satisfies` отвечает за существование кода в КОДЕ, тест — за попадание в сводный
   * перечень, а сверку с БАЗОЙ ведёт `grants-catalog.db.test.ts`.
   */
  it('каждый код реестра существует в каталоге — все четыре', () => {
    const known = new Set<string>(ALL_SYSTEM_GRANT_CODES);
    const codes = PROFILES.flatMap((profile) => profile.grants);
    expect(codes.filter((code) => !known.has(code))).toEqual([]);
    // И поимённо — счёт «их четыре» сошёлся бы и у реестра, где один код подменили другим.
    expect(codes).toEqual([
      OFFICE_EQUIPMENT_REQUESTER_GRANT,
      OFFICE_EQUIPMENT_OPERATOR_GRANT,
      OFFICE_EQUIPMENT_IT_GRANT,
      OFFICE_EQUIPMENT_EXECUTOR_GRANT,
    ]);
  });

  /**
   * Т14, ПОСТОЯННАЯ ЧАСТЬ ДЛЯ «ЗАЯВИТЕЛЯ»: код профиля существует **модульным** набором, и состав
   * у него ровно тот, что записан в каноническом каталоге Р4, — семь прав заказчика и ни одним
   * больше.
   *
   * Шестым право было до выпуска B волны кандидатов (ADR 0165; этап Э6 плана предмета заявки,
   * миграция 0294): седьмым в состав приехало `officeEquipment.propose` — сообщение о технике,
   * которой нет в справочнике. Профиля это не меняет: заявитель по-прежнему только заводит свою
   * заявку, а сообщение — часть того же шага, где он выбирает предмет. Решений по заявке и
   * проверки сообщений здесь как не было, так и нет.
   *
   * Проверяется здесь, а не только в `grants-contracts.test.ts`, потому что утверждение про
   * ПРОФИЛЬ: реестр обещает, что этим кодом выдаётся заявитель, — и обещание ложно ровно тогда,
   * когда в состав приедет решение по заявке. Права названы поимённо: счёт «их семь» сошёлся бы и
   * у набора, собранного из чужих.
   */
  it('код профиля «Заявитель» — модульный набор из семи прав заказчика', () => {
    expect(MODULE_GRANT_CODES).toContain(OFFICE_EQUIPMENT_REQUESTER_GRANT);
    const grant = MODULE_GRANTS.office_equipment_requester;
    expect([...grant.permissions].sort()).toEqual([
      'officeEquipment.propose',
      'officeEquipment.read',
      'serviceRequests.create',
      'serviceRequests.delete',
      'serviceRequests.files',
      'serviceRequests.read',
      'serviceRequests.update',
    ]);
    /*
     * Роли — только те две, у которых своей оси области НЕТ (Р5, Р6). Ролям-заказчикам набор не
     * нужен: права у них уже есть, и набор, ничего не дающий, запрещён тестом каталога.
     */
    expect([...grant.roles].sort()).toEqual(['dispatcher', 'manager']);
    /*
     * Сквозной области у него нет и быть не может — таблица типизирована системными кодами, и
     * модульный ключ в неё не пройдёт компилятором. Проверяется обратная сторона того же: функция
     * принимает ЛЮБЫЕ строки из базы, и промах по ключу — её штатный ответ.
     *
     * Глобальное чтение у держателя при этом есть, и приходит оно НЕ отсюда, а от роли без оси:
     * набор тут ни при чём, и путать эти два источника нельзя — иначе «сузим набором» выглядело бы
     * возможным решением, а оно невозможно (ADR 0106, решение 2).
     */
    expect(hasModuleWideScope([OFFICE_EQUIPMENT_REQUESTER_GRANT], 'serviceRequests')).toBe(false);
    expect(hasModuleWideScope([OFFICE_EQUIPMENT_REQUESTER_GRANT], 'officeEquipment')).toBe(false);
  });

  /**
   * Т14, ПОСТОЯННАЯ ЧАСТЬ: код исполнителя существует **модульным** набором, и состав у него
   * ровно тот, ради которого профиль разделили (план профилей, Р4; план аудита исполнителей, Э8).
   *
   * Проверяется здесь, а не только в `grants-contracts.test.ts`, потому что утверждение про
   * ПРОФИЛЬ: реестр обещает, что второй код ИТ-профиля открывает работу руками, — и обещание это
   * ложно ровно тогда, когда состав набора уедет. Три права названы поимённо: счёт «их три»
   * сошёлся бы и у набора, собранного из чужого.
   */
  it('второй код ИТ-профиля — модульный набор из трёх прав исполнителя', () => {
    expect(MODULE_GRANT_CODES).toContain(OFFICE_EQUIPMENT_EXECUTOR_GRANT);
    const grant = MODULE_GRANTS.office_equipment_executor;
    expect([...grant.permissions].sort()).toEqual([
      'serviceRequests.execute',
      'serviceRequests.files',
      'serviceRequests.read',
    ]);
    expect([...grant.roles].sort()).toEqual(['department', 'shtab', 'site']);
    /*
     * Сквозной области у него нет и быть не может: таблица `GRANT_MODULE_WIDE_SCOPE` типизирована
     * системными кодами, и модульный ключ в неё не пройдёт компилятором. Проверяется тут обратная
     * сторона того же — что ответ функции на код исполнителя «нет» по обоим модулям: она принимает
     * ЛЮБЫЕ строки из базы, и промах по ключу — её штатный ответ, а не ошибка.
     */
    expect(hasModuleWideScope([OFFICE_EQUIPMENT_EXECUTOR_GRANT], 'serviceRequests')).toBe(false);
    expect(hasModuleWideScope([OFFICE_EQUIPMENT_EXECUTOR_GRANT], 'officeEquipment')).toBe(false);
    // А у первого кода профиля она есть — иначе «разделение» было бы переносом без разделения.
    expect(hasModuleWideScope([OFFICE_EQUIPMENT_IT_GRANT], 'serviceRequests')).toBe(true);
  });
});

describe('Профиль опознаётся кодом набора, а не правом (Р9)', () => {
  /**
   * Перебор субъектов переехал вместе с опознанием. `ACCESS_PROFILES` собирает субъект как пару
   * «роль + надстройка», и не неси он кодов — профиль с надстройкой перестал бы опознаваться
   * стороной у каждого субъекта перебора разом, а выглядело бы это дефектом сторон.
   *
   * Равенство строк не случайно: код системного набора и код надстройки — одна и та же выдача,
   * читаемая двумя полями (`SYSTEM_GRANT_CODES ... satisfies readonly RoleAddon[]`).
   */
  it('перебор субъектов несёт коды теми же строками, что надстройки', () => {
    for (const subject of ACCESS_PROFILES) {
      expect([...(subject.grantCodes ?? [])], accessProfileLabel(subject)).toEqual([
        ...(subject.addons ?? []),
      ]);
    }
    expect(ACCESS_PROFILES.filter((s) => s.grantCodes?.length).length).toBeGreaterThan(0);
  });

  /**
   * Сторона ИТ-службы. Сравнение доказывает, что дело именно в коде: у субъекта БЕЗ кода права
   * набора те же самые — все до единого, — и стороной он всё равно не становится.
   *
   * Мёртвой визы среди этих прав больше нет (Э9, миграция E), и утверждение от этого не ослабло, а
   * усилилось: прежде можно было заподозрить, что сторону держит `serviceRequests.approveIt` в
   * составе, теперь состав его не содержит вовсе — а сторона у кода есть, у прав нет.
   */
  it('«Системный администратор» — по коду, а не по правам набора', () => {
    const byCode: AccessSubject = { role: 'shtab', grantCodes: [OFFICE_EQUIPMENT_IT_GRANT] };
    const byPermissions: AccessSubject = {
      role: 'shtab',
      grantPermissions: [...ROLE_ADDON_PERMISSIONS.office_equipment_it_approver],
    };
    expect(participantSidesOf(byCode, NO_FACTS)).toEqual(['it']);
    expect(audienceMatches({ side: 'it' }, byCode, NO_FACTS)).toBe(true);

    expect(can(byPermissions, 'serviceRequests.approveIt')).toBe(false);
    expect(participantSidesOf(byPermissions, NO_FACTS)).toEqual([]);
    expect(audienceMatches({ side: 'it' }, byPermissions, NO_FACTS)).toBe(false);
  });

  /**
   * Сторона «Ведение» — и здесь ОСОЗНАННАЯ СМЕНА ПОВЕДЕНИЯ, а не побочный эффект переезда: субъект
   * с собранным вручную набором, дающим `status` и `assign`, стороной «Ведение» быть перестал.
   * Прежде он ею был — конъюнкция прав не различала происхождение, — и человек, которому профиля
   * модуля никто не выдавал, видел яркими реплики, адресованные администратору модуля.
   */
  it('«Ведение» — по коду; тот же набор прав без кода стороной не делает', () => {
    const byCode: AccessSubject = { role: 'shtab', grantCodes: [OFFICE_EQUIPMENT_OPERATOR_GRANT] };
    const assembled: AccessSubject = {
      role: 'shtab',
      grantPermissions: ['serviceRequests.status', 'serviceRequests.assign'],
    };
    expect(participantSidesOf(byCode, NO_FACTS)).toEqual(['operator']);
    expect(can(assembled, 'serviceRequests.status')).toBe(true);
    expect(can(assembled, 'serviceRequests.assign')).toBe(true);
    expect(participantSidesOf(assembled, NO_FACTS)).toEqual([]);
  });

  /**
   * Второй рубеж, и код его не отменяет: у подрядчика с выданным руками набором «Ведение» код
   * настоящий. Без явного исключения по типу контрагента исполнитель стал бы заказчиком
   * собственной работы — принимал бы её и согласовывал бы свою же смету глазами «Ведения».
   */
  it('подрядчик с кодом «Ведения» остаётся исполнителем', () => {
    const contractor: AccessSubject = {
      role: 'operator',
      counterpartyType: 'service',
      grantCodes: [OFFICE_EQUIPMENT_OPERATOR_GRANT],
    };
    expect(participantSidesOf(contractor, NO_FACTS)).toEqual([]);
    expect(audienceMatches({ side: 'operator' }, contractor, NO_FACTS)).toBe(false);
    // Своя сторона приходит к нему фактом назначения, а не кодом и не правом.
    expect(participantSidesOf(contractor, { ...NO_FACTS, actsForAssignedService: true })).toEqual([
      'service',
    ]);
  });

  /**
   * Администратор кодов не имеет вовсе, а обеими сторонами быть обязан: прежняя формула включала
   * его сама (у роли есть все права), и переезд на коды не должен был его потерять. Исключение
   * здесь завело бы второе правило про админа, расходящееся с первым (`isWaitingOn`).
   */
  it('администратор остаётся обеими сторонами ведения модуля', () => {
    const admin: AccessSubject = { role: 'admin' };
    expect(admin.grantCodes).toBeUndefined();
    expect(participantSidesOf(admin, NO_FACTS)).toEqual(['operator', 'it']);
  });
});

/**
 * Страж стороны заказчика `actsAsRequestCustomer` (план профилей оргтехники, Р6; план карточки
 * заявителя, §13) — предикат, ради которого этап Э7 идёт в таком порядке: сперва он, потом
 * миграции B и D.
 *
 * ЧТО ОН ЗАКРЫВАЕТ. У `manager` и `dispatcher` оси области нет, и предикат видимости им ничего не
 * сужает — заявки компании видны им целиком. Пока модуля у них не было, это ничего не значило;
 * набор «Заявитель» превратил бы «видит все» в «правит и удаляет любую чужую „Новую“».
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА ПРО НЕГО — НЕВЛИЯНИЕ: ни один действующий субъект портала не изменил
 * поведения ни на одном сочетании признаков. Это проверяемое утверждение, а не намерение, и
 * проверяется оно сплошным перебором, а не выборочными случаями.
 */
describe('Страж стороны заказчика (Р6)', () => {
  /** Четыре сочетания двух признаков: правило обязано отвечать на каждое, а не на удобное. */
  const FACTS: readonly RequestCustomerFacts[] = [
    { isAuthor: false, inCustomerScope: false },
    { isAuthor: true, inCustomerScope: false },
    { isAuthor: false, inCustomerScope: true },
    { isAuthor: true, inCustomerScope: true },
  ];

  /** Роли без своей оси области — те две, ради которых набор «Заявитель» и заведён (Р5, Р6). */
  const OFFICE_ROLES: readonly Role[] = ['manager', 'dispatcher'];

  /**
   * НЕВЛИЯНИЕ, СПЛОШНЫМ ПЕРЕБОРОМ. `ACCESS_PROFILES` — это все, кто в портале бывает: роли, типы
   * контрагента и пары с надстройками. Кода «Заявителя» нет ни у одного из них (набор модульный, а
   * перебор собирается из надстроек), и значит правило обязано отвечать «да» на любом сочетании
   * признаков — то есть не сужать никого из них ни на один сценарий.
   *
   * Утверждение сильнее, чем «роли с осью не изменились»: оно охватывает и администратора, и
   * подрядчика, и наблюдателя, и учётку без роли.
   */
  it('ни один действующий субъект портала не сужен — ни на одном сочетании признаков', () => {
    for (const subject of [...ACCESS_PROFILES, { role: null } as AccessSubject]) {
      for (const facts of FACTS) {
        expect(
          actsAsRequestCustomer(subject, facts),
          `${accessProfileLabel(subject)} @ ${JSON.stringify(facts)}`,
        ).toBe(true);
      }
    }
  });

  /**
   * И то же самое, но с выданным кодом «Заявителя» у РОЛИ С ОСЬЮ: правило её не касается тоже.
   * Строки `grant_roles` под такими ролями нет (набор им не нужен — права у них уже есть), но
   * предикат обязан отвечать по своему условию, а не по тому, что выдача до него не дойдёт:
   * второй барьер, стоящий на предположении о первом, — это один барьер.
   *
   * Роли отбираются ОСЬЮ, а не именами, и это не оформление: правило написано про ось, и
   * перечисление имён означало бы вторую классификацию ролей рядом с `roleScopeAxis` — ту самую,
   * которая ошибается в самую дорогую сторону (роль с осью попадает в `none`, где ничего не
   * сужается). Заодно отсюда видно, что ролей без оси в портале больше двух: наблюдатель и обе
   * роли службы главного механика тоже без оси, и правило сужало бы их — просто набора им никто не
   * выдаёт, потому что `grant_roles` их не перечисляет.
   */
  it('роль СО своей осью правило не сужает даже с выданным кодом заявителя', () => {
    const scoped = ROLES.filter((role) => roleScopeAxis(role) !== 'none');
    expect(scoped.length).toBeGreaterThan(0);
    for (const role of scoped) {
      const subject: AccessSubject = { role, grantCodes: [OFFICE_EQUIPMENT_REQUESTER_GRANT] };
      for (const facts of FACTS) {
        expect(actsAsRequestCustomer(subject, facts), `${role} @ ${JSON.stringify(facts)}`).toBe(
          true,
        );
      }
    }
    // А роль без оси — сужается, и это ровно то же условие, прочитанное с другой стороны.
    for (const role of ROLES.filter((r) => roleScopeAxis(r) === 'none' && r !== 'admin')) {
      const subject: AccessSubject = { role, grantCodes: [OFFICE_EQUIPMENT_REQUESTER_GRANT] };
      expect(
        actsAsRequestCustomer(subject, { isAuthor: false, inCustomerScope: false }),
        role,
      ).toBe(false);
    }
    // Администратор — исключение по построению, а не по имени: кодов наборов у него не бывает,
    // права приходят ролью. Субъект с кодом здесь выдуман, и правило его сужает наравне с прочими.
    expect(roleScopeAxis('admin')).toBe('none');
  });

  /**
   * СОБСТВЕННО ПРАВИЛО: держатель «Заявителя» у роли без оси действует только на СВОИХ строках.
   *
   * Вторая половина дизъюнкции (`inCustomerScope`) у такого субъекта сегодня ложна при любой
   * заявке — площадок и отделов у роли нет, — и проверяется она здесь ради того дня, когда роль
   * получит ось: правило обязано заработать само, а не через правку файла.
   */
  it('держатель «Заявителя» без оси: своя строка — да, чужая — нет', () => {
    for (const role of OFFICE_ROLES) {
      const subject: AccessSubject = { role, grantCodes: [OFFICE_EQUIPMENT_REQUESTER_GRANT] };
      expect(
        actsAsRequestCustomer(subject, { isAuthor: false, inCustomerScope: false }),
        role,
      ).toBe(false);
      expect(actsAsRequestCustomer(subject, { isAuthor: true, inCustomerScope: false }), role).toBe(
        true,
      );
      expect(actsAsRequestCustomer(subject, { isAuthor: false, inCustomerScope: true }), role).toBe(
        true,
      );
    }
  });

  /**
   * ДВА НАБОРА НЕ СМЕШИВАЮТСЯ (Р6, прямым текстом): код «Ведения» открывает операторские действия
   * ОТДЕЛЬНЫМ слоем, и правило автора его держателя не касается вовсе. Иначе централизованное
   * ведение перестало бы работать в тот же день, когда его разрешили: оператор ведёт чужие заявки —
   * ради этого профиль и существует.
   *
   * Проверяется на паре кодов, а не на одном «Ведении»: администратор выдаёт профили по
   * отдельности, и человек с обоими наборами — рабочий случай, а не выдумка теста.
   */
  it('код «Ведения» снимает правило автора — и в одиночку, и в паре с «Заявителем»', () => {
    for (const role of OFFICE_ROLES) {
      const pairs: readonly string[][] = [
        [OFFICE_EQUIPMENT_OPERATOR_GRANT],
        [OFFICE_EQUIPMENT_REQUESTER_GRANT, OFFICE_EQUIPMENT_OPERATOR_GRANT],
      ];
      for (const grantCodes of pairs) {
        const subject: AccessSubject = { role, grantCodes };
        expect(
          actsAsRequestCustomer(subject, { isAuthor: false, inCustomerScope: false }),
          `${role}: ${grantCodes.join('+')}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Профиль — КОД, а не сумма прав (Р9), и здесь это видно острее всего: субъект с теми же шестью
   * правами, собранными руками, правилом не сужается. Иначе профиль модуля выводился бы из состава
   * чужого набора, а собранный администратором пакет тихо получал бы чужое ограничение.
   */
  it('те же права без кода набора правило не включают', () => {
    const assembled: AccessSubject = {
      role: 'manager',
      grantPermissions: [
        'officeEquipment.read',
        'serviceRequests.read',
        'serviceRequests.create',
        'serviceRequests.update',
        'serviceRequests.delete',
        'serviceRequests.files',
      ],
    };
    expect(can(assembled, 'serviceRequests.update')).toBe(true);
    expect(actsAsRequestCustomer(assembled, { isAuthor: false, inCustomerScope: false })).toBe(
      true,
    );
  });

  /**
   * И граница со стороной обсуждения: участие в разговоре со стороны `customer` считается СТРОЖЕ —
   * только автором, — и страж туда не переезжает. Подставь мы его в `matchesServiceChatSide`,
   * участниками «Заявителя» стали бы разом все, кого правило не сужает: администратор, подрядчик,
   * наблюдатель. Письмо от лица заказчика закрыто поэтому автором, а не этим предикатом.
   */
  it('сторона обсуждения `customer` остаётся строже стража и им не подменяется', () => {
    const admin: AccessSubject = { role: 'admin' };
    expect(actsAsRequestCustomer(admin, { isAuthor: false, inCustomerScope: true })).toBe(true);
    expect(participantSidesOf(admin, { ...NO_FACTS, inCustomerScope: true })).not.toContain(
      'customer',
    );
    // А у автора сторона есть — и это тот самый факт, которым портал рисует кнопки (Р6).
    const office: AccessSubject = {
      role: 'manager',
      grantCodes: [OFFICE_EQUIPMENT_REQUESTER_GRANT],
    };
    expect(participantSidesOf(office, { ...NO_FACTS, isAuthor: true })).toEqual(['customer']);
    expect(participantSidesOf(office, NO_FACTS)).toEqual([]);
  });
});

/**
 * ПОЛОВИНА ПРО `it` СНЯТА МИГРАЦИЕЙ E (Э9, §10 плана, строка Т14). Она сравнивала опознание по коду
 * с прежним выводом по праву `serviceRequests.approveIt` и доказывала, что Э3 ПЕРЕНОСИТ опознание,
 * а не меняет состав сторон у действующих учёток. Право из набора убрано — сравнивать стало не с
 * чем, и оставленное утверждение падало бы ПРАВДИВО: старая формула ИТ-службу больше не находит.
 *
 * Половина про `operator` осталась: конъюнкция `status && assign` жива у всех, кому «Ведение»
 * выдано, и совпадение с ней означает, что переезд на код никого из действующих держателей не
 * потерял. Расхождение на СОБРАННЫХ вручную наборах в перебор не входит — это ровно то изменение
 * поведения, ради которого этап и сделан (см. «Ведение» выше).
 */
describe('Переходное: опознание «Ведения» по коду совпадает с выводом по правам', () => {
  it('сторона `operator` совпадает с прежней конъюнкцией прав на всех субъектах перебора', () => {
    for (const subject of ACCESS_PROFILES) {
      const byCode = participantSidesOf(subject, NO_FACTS).includes('operator');
      const byPermissions =
        can(subject, 'serviceRequests.status') &&
        can(subject, 'serviceRequests.assign') &&
        subject.counterpartyType !== 'service';
      expect(byCode, accessProfileLabel(subject)).toBe(byPermissions);
    }
  });
});

/**
 * Обратный вопрос реестра — «какие профили выданы ЭТИМИ кодами» (Э8, Р7): им подписывается учётка в
 * админке и им же форма отвечает, что у человека уже есть.
 *
 * Проверяется здесь, а не на портале, по той же причине, по которой здесь живёт весь файл: правило
 * читает реестр, реестр лежит в контрактах, и второго его толкования быть не должно ни на одной
 * стороне.
 */
describe('Профили по кодам выданных наборов (Р7, Р9)', () => {
  it('пара кодов ИТ опознаётся профилем, а половина — ничем', () => {
    // Половина профиля — это человек, которого можно назначить исполнителем, но который не видит
    // модуль, либо наоборот. Подписать её «Системным администратором» значило бы спрятать ровно ту
    // неполноту, ради которой пресет выдаёт оба кода одной транзакцией.
    expect(
      officeEquipmentProfilesOf([OFFICE_EQUIPMENT_IT_GRANT, OFFICE_EQUIPMENT_EXECUTOR_GRANT]),
    ).toEqual(['it']);
    expect(officeEquipmentProfilesOf([OFFICE_EQUIPMENT_EXECUTOR_GRANT])).toEqual([]);
    expect(officeEquipmentProfilesOf([OFFICE_EQUIPMENT_IT_GRANT])).toEqual([]);
  });

  it('профилей бывает несколько сразу, и порядок у них реестровый', () => {
    // Один человек штатно бывает и заявителем, и ведущим модуль: профили независимы, и ответ здесь
    // — список, а не «первый подошедший». Порядок — по ходу заявки, чтобы подпись не перескакивала
    // от порядка кодов в ответе сервера.
    expect(
      officeEquipmentProfilesOf([
        OFFICE_EQUIPMENT_OPERATOR_GRANT,
        OFFICE_EQUIPMENT_REQUESTER_GRANT,
      ]),
    ).toEqual(['requester', 'operator']);
  });

  it('«Сервисный центр» не опознаётся НИКОГДА — даже у учётки без наборов', () => {
    /*
     * Самая дорогая ошибка этой функции: у профиля пустой список кодов (Р11), и наивное `every`
     * прошло бы на любом наборе кодов — включая пустой. Тогда «Сервисным центром» подписалась бы
     * каждая учётка компании. Профиль выражен парой «роль `operator` + тип контрагента `service`»,
     * и по кодам его не видно ни при каких кодах.
     */
    expect(officeEquipmentProfilesOf([])).toEqual([]);
    expect(officeEquipmentProfilesOf(null)).toEqual([]);
    expect(officeEquipmentProfilesOf(undefined)).toEqual([]);
    for (const profile of OFFICE_EQUIPMENT_PROFILES) {
      const codes = OFFICE_EQUIPMENT_PROFILE_REGISTRY[profile].grants;
      expect(officeEquipmentProfilesOf(codes), profile).not.toContain('service');
    }
  });

  it('чужой код профилем не считается: опознаётся ВЫДАЧА, а не похожий набор', () => {
    // Собранный администратором набор с тем же составом прав профилем не является (Р9): профиль —
    // это код, и вывести его из состава значило бы вернуть ровно ту ошибку, от которой Э3 уводил.
    expect(officeEquipmentProfilesOf(['auditor', 'waste_ticket_audit'])).toEqual([]);
  });
});

/**
 * Правка и удаление заявки: `canChangeRequestAsCustomer` (план профилей оргтехники, находка Н8,
 * решение заказчика 04.09.2026 — «системный администратор не правит и не удаляет чужие заявки»).
 *
 * ЧТО ЗАКРЫВАЕТ. Две клетки §5.1 — «Изменение заявки: Сисадмин —» и «Удаление (в архив): Сисадмин
 * —» — не держало ничто: обе половины профиля выдаются поверх ролей `shtab`/`site`/`department`, у
 * каждой из которых `serviceRequests.update` и `.delete` есть по матрице, а сквозная область
 * ИТ-набора снимает у них ось. Теперь эти клетки держит этот предикат.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ЭТОГО БЛОКА — ТО ЖЕ, ЧТО У СОСЕДНЕГО: невлияние. Ни одна роль БЕЗ наборов
 * оргтехники поведения не изменила, и доказывается это сплошным перебором, а не выборкой случаев:
 * сквозная область приходит только набором, и субъекту без наборов правило отвечает «да» на любом
 * сочетании признаков.
 */
describe('Правка и удаление: сторона заказчика (Н8)', () => {
  const FACTS: readonly RequestCustomerFacts[] = [
    { isAuthor: false, inCustomerScope: false },
    { isAuthor: true, inCustomerScope: false },
    { isAuthor: false, inCustomerScope: true },
    { isAuthor: true, inCustomerScope: true },
  ];

  /** Профиль «Системный администратор» целиком — оба кода, как его выдаёт форма учётки (Р2, Э8). */
  const IT_CODES = [OFFICE_EQUIPMENT_IT_GRANT, OFFICE_EQUIPMENT_EXECUTOR_GRANT];

  /**
   * НЕВЛИЯНИЕ, СПЛОШНЫМ ПЕРЕБОРОМ. `ACCESS_PROFILES` — все, кто в портале бывает: роли, типы
   * контрагента и пары «роль + набор». Правило написано про исполнительский профиль модуля,
   * поэтому перебор делится ровно надвое, и делит его тот же `actsAsServiceExecutorOnly`, которым
   * субъекта опознают сервер и портал:
   *
   *   · кто исполнительским профилем НЕ является — ответ обязан совпасть с прежним стражем на
   *     каждом из четырёх сочетаний признаков. Не «true», а именно совпасть: так утверждение
   *     остаётся верным и для держателя «Заявителя», которого сужает прежнее правило;
   *   · кто является — это половина профиля ИТ-службы и набор исполнителя, и таких субъектов
   *     перебор обязан найти хоть одного: сойдись он к пустому множеству, тест зеленел бы,
   *     ничего не проверяя.
   *
   * ДЕЛИТЕЛЬ СМЕНИЛСЯ ВМЕСТЕ С ПРАВИЛОМ (план
   * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р10). Прежде здесь стоял
   * `hasModuleWideScope(…, 'serviceRequests')` — КАРТА сквозной области, — и это было верно, пока
   * страж опознавал субъекта ею же. Карта из модуля уезжает следующим выпуском, страж переехал на
   * коды наборов, и делитель обязан был переехать за ним: оставленный прежним, он делил бы перебор
   * не по тому признаку и молча пропускал бы в «невлияние» тех, кого правило как раз и сузило.
   *
   * Утверждение сильнее, чем «роли с осью не тронуты»: сюда попадают и штаб, и наблюдатель, и
   * подрядчик, и учётка без роли вовсе.
   */
  it('ни один субъект вне исполнительского профиля не изменил поведения — ни на одном сочетании', () => {
    const narrowed: string[] = [];
    for (const subject of [...ACCESS_PROFILES, { role: null } as AccessSubject]) {
      if (actsAsServiceExecutorOnly(subject)) {
        narrowed.push(accessProfileLabel(subject));
        continue;
      }
      for (const facts of FACTS) {
        expect(
          canChangeRequestAsCustomer(subject, facts),
          `${accessProfileLabel(subject)} @ ${JSON.stringify(facts)}`,
        ).toBe(actsAsRequestCustomer(subject, facts));
      }
    }
    // Исполнительский профиль приходит наборами модуля — тем, которым выдают половину профиля ИТ,
    // и отделённым от него набором «работа исполнителем».
    expect(narrowed.length).toBeGreaterThan(0);
    expect(
      narrowed.every((label) => label.includes('ИТ-служба') || label.includes('исполнител')),
      narrowed.join(' | '),
    ).toBe(true);
  });

  /**
   * И то же самое ответом соседа: там, где прежнее правило автора отвечало «да», новое обязано
   * отвечать тем же — субъекты у них разные, и подменять один другим нельзя. Перебор идёт по всем
   * ролям с кодом «Заявителя»: у него сквозной области нет и быть не может (Р9), поэтому добавка
   * Н8 его не касается ни в одном случае.
   */
  it('держателя «Заявителя» новая дверь судит ровно тем же ответом, что и прежняя', () => {
    for (const role of ROLES) {
      const subject: AccessSubject = { role, grantCodes: [OFFICE_EQUIPMENT_REQUESTER_GRANT] };
      for (const facts of FACTS) {
        expect(
          canChangeRequestAsCustomer(subject, facts),
          `${role} @ ${JSON.stringify(facts)}`,
        ).toBe(actsAsRequestCustomer(subject, facts));
      }
    }
  });

  /**
   * СОБСТВЕННО ПРАВИЛО. Профиль ИТ-службы на всех трёх ролях, поверх которых его выдают (Н8):
   * чужая строка — «нет», своя по авторству либо по НАСТОЯЩЕЙ области — «да».
   *
   * Роли перечислены поимённо, потому что поимённо названа и находка: сквозная область снимает ось
   * у каждой из трёх, и без правила все три правили бы любую «Новую» компании.
   */
  it('профиль ИТ: чужая заявка — нет, своя по авторству или по своей области — да', () => {
    for (const role of ['shtab', 'site', 'department'] as const) {
      const subject: AccessSubject = { role, grantCodes: IT_CODES };
      expect(hasModuleWideScope(subject.grantCodes, 'serviceRequests'), role).toBe(true);
      expect(
        canChangeRequestAsCustomer(subject, { isAuthor: false, inCustomerScope: false }),
        role,
      ).toBe(false);
      expect(
        canChangeRequestAsCustomer(subject, { isAuthor: true, inCustomerScope: false }),
        role,
      ).toBe(true);
      expect(
        canChangeRequestAsCustomer(subject, { isAuthor: false, inCustomerScope: true }),
        role,
      ).toBe(true);
    }
  });

  /**
   * НАБОР ИСПОЛНИТЕЛЯ В ОДИНОЧКУ ПРАВИЛО ТЕПЕРЬ ВКЛЮЧАЕТ — и это ИЗМЕНЕНИЕ поведения, названное
   * вслух решением Р10 плана `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, а
   * не сохранение прежнего.
   *
   * ЧТО БЫЛО. Страж опознавал сужаемого субъекта КАРТОЙ сквозной области
   * (`hasModuleWideScope(…, 'serviceRequests')`), а у отделённого набора «работа исполнителем»
   * карты нет вовсе — он затем и отделён, чтобы назначенному не отдавать заодно сквозную
   * видимость. Держатель одного этого набора под правило не попадал ни разу и правил чужие «Новые»
   * заявки по обычной оси своей роли.
   *
   * ЧТО СТАЛО И ПОЧЕМУ ИМЕННО ТАК. Страж переехал с карты на коды наборов
   * (`actsAsServiceExecutorOnly`), потому что карта из модуля уезжает следующим выпуском: сними её,
   * прежний признак стал бы ложным у ВСЕХ, страж ответил бы «да» — и правка чужой заявки открылась
   * бы через назначение ровно тому профилю, у которого её только что отобрали. Правило «правка и
   * удаление — своя площадка либо своё авторство» обязано пережить уборку карты без единой правки
   * поведения, и переживает оно её только опознанием по кодам.
   *
   * ЦЕНА НАЗВАНА: держатель одного исполнительского набора сузился. Это правильная строгость —
   * «я чиню эту заявку» и «я ею распоряжаюсь» разведены двумя разными основаниями, — но это
   * изменение, и держит его отдельный случай, а не сноска в чужом комментарии.
   *
   * ЧЕГО ПРАВИЛО НЕ ОТНЯЛО: свою площадку и своё авторство. Назначенный сотрудник правку СВОЕЙ
   * заявки не теряет ни на чьей площадке — за это отвечают два последних сочетания признаков; а
   * подшивка документов по чужой заявке живёт за другим предикатом и правилом не тронута вовсе
   * (случай в конце файла).
   */
  it('набор исполнителя в одиночку правило ТЕПЕРЬ включает: чужая заявка — нет, своя — да', () => {
    const subject: AccessSubject = {
      role: 'shtab',
      grantCodes: [OFFICE_EQUIPMENT_EXECUTOR_GRANT],
    };
    // Карты сквозной области у набора нет — то есть прежний признак этого субъекта не ловил.
    expect(hasModuleWideScope(subject.grantCodes, 'serviceRequests')).toBe(false);
    // А новый ловит: доступ к модулю пришёл ему набором работы руками, роль не `admin`, «Ведения»
    // нет. Обе строки стоят рядом намеренно — в них и записана вся суть переезда Р10.
    expect(actsAsServiceExecutorOnly(subject)).toBe(true);

    expect(canChangeRequestAsCustomer(subject, { isAuthor: false, inCustomerScope: false })).toBe(
      false,
    );
    expect(canChangeRequestAsCustomer(subject, { isAuthor: true, inCustomerScope: false })).toBe(
      true,
    );
    expect(canChangeRequestAsCustomer(subject, { isAuthor: false, inCustomerScope: true })).toBe(
      true,
    );
    expect(canChangeRequestAsCustomer(subject, { isAuthor: true, inCustomerScope: true })).toBe(
      true,
    );

    // Прежний страж на чужой строке по-прежнему отвечает «да» — сузил субъекта именно новый, а не
    // изменившееся поведение соседа. Без этой строки случай не отличал бы одно от другого.
    expect(actsAsRequestCustomer(subject, { isAuthor: false, inCustomerScope: false })).toBe(true);
  });

  /**
   * ИСКЛЮЧЕНИЕ ПЕРВОЕ: «Ведение». Держатель кода `office_equipment_operator` правит и удаляет
   * чужие заявки по должности — операторский слой с авторским не смешивается (Р6 прямым текстом),
   * и пара «Ведение + ИТ» у одного человека рабочая: он и координирует, и чинит.
   */
  it('«Ведение» снимает правило — и в одиночку, и в паре с набором ИТ', () => {
    const pairs: readonly string[][] = [
      [OFFICE_EQUIPMENT_OPERATOR_GRANT],
      [...IT_CODES, OFFICE_EQUIPMENT_OPERATOR_GRANT],
    ];
    for (const grantCodes of pairs) {
      const subject: AccessSubject = { role: 'department', grantCodes };
      expect(
        canChangeRequestAsCustomer(subject, { isAuthor: false, inCustomerScope: false }),
        grantCodes.join('+'),
      ).toBe(true);
    }
  });

  /**
   * ИСКЛЮЧЕНИЕ ВТОРОЕ: `admin`. Основание то же, по которому он исключён в `actsAsServiceOperator`
   * и в стороне обсуждения `it`: права у него от роли, кодов наборов не бывает вовсе, а разбор
   * застрявшего за любую сторону — его работа. Субъект с кодом здесь выдуман нарочно: исключение
   * обязано держаться ролью, а не тем, что до кодов дело не дойдёт.
   */
  it('администратор правит и удаляет любую заявку — даже с кодами наборов', () => {
    for (const grantCodes of [undefined, IT_CODES]) {
      const admin: AccessSubject = { role: 'admin', grantCodes };
      expect(
        canChangeRequestAsCustomer(admin, { isAuthor: false, inCustomerScope: false }),
        JSON.stringify(grantCodes),
      ).toBe(true);
    }
  });

  /**
   * И ГРАНИЦА, РАДИ КОТОРОЙ ПРЕДИКАТ ОТДЕЛЬНЫЙ: подшивку документов правило не трогает. Страж
   * авторства стоит на общем входе ВСЕХ изменяющих ручек, и под ним, кроме правки и удаления,
   * живут подшивка и снятие вложения. Сисадмина штатно назначают исполнителем на заявку чужой
   * площадки — акт по ней он обязан приложить, — поэтому старый предикат на чужой строке ему
   * отвечает «да», а новый «нет», и это два разных ответа на два разных вопроса.
   */
  it('прежний страж на чужой строке сисадмина не сужает — иначе исполнитель потерял бы подшивку', () => {
    const subject: AccessSubject = { role: 'site', grantCodes: IT_CODES };
    const foreign = { isAuthor: false, inCustomerScope: false };
    expect(actsAsRequestCustomer(subject, foreign)).toBe(true);
    expect(canChangeRequestAsCustomer(subject, foreign)).toBe(false);
  });
});

describe('Частичный отзыв наборов: таблица Р3 целиком (Т11)', () => {
  /**
   * **СЕМЬ СТРОК ТАБЛИЦЫ Р3** плана
   * `docs/office-equipment-free-estimate-and-executor-scope-plan.md` — все до одной, вместе со
   * столбцом «чат по заявке, с которой снят».
   *
   * ЗАЧЕМ ТАБЛИЦА ТЕСТОМ. Заказчик ответил про ПОЛНЫЙ профиль («исполнитель видит только свои
   * заявки»), а в проде наборы снимают поодиночке: у человека остаётся половина профиля, к нему
   * добавляют «Ведение», его переводят в администраторы. Ревью потребовало ответить за каждое
   * такое состояние ТАБЛИЦЕЙ, а не выводом по ходу чтения, — и таблица имеет цену ровно до тех
   * пор, пока её кто-то сверяет.
   *
   * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, А ЧТО НЕТ. Здесь — ответы ЧИСТЫХ предикатов контрактов, то есть та
   * половина правила, которую зовут и сервер, и портал. Саму выдачу — «в списке ровно эти
   * заявки» — проверяет `service-executor-scope.db.test.ts` на живой базе: предикат отвечает «кто
   * он в модуле», а не «что он увидит», и подменять одно другим нельзя ни в одну сторону.
   */

  /** Ветви области из развилки Р3 — теми же словами, что в плане. */
  type ScopeBranch = 'всё' | 'область «Ведения»' | 'свои' | 'как сегодня';

  /**
   * Развилка Р3 в том же ПОРЯДКЕ, в каком её задаёт сервер (`executorScopeVisibilityWhere` и
   * `assertVisibleUnderExecutorScope`): администратор, «Ведение», исполнительский профиль, все
   * остальные.
   *
   * ПОРЯДОК — ЧАСТЬ УТВЕРЖДЕНИЯ, а не деталь записи. Переставь «Ведение» после исполнительского
   * профиля — и пара «ИТ + Ведение» получила бы область «свои» вместо области своей роли, то есть
   * ровно тот ответ, который таблица Р3 ему не обещает. Три вопроса задаются по субъекту и в базу
   * не ходят — потому их и можно задать здесь.
   */
  function scopeBranchOf(subject: AccessSubject): ScopeBranch {
    if (subject.role === 'admin') return 'всё';
    if ((subject.grantCodes ?? []).includes(OFFICE_EQUIPMENT_OPERATOR_GRANT)) {
      return 'область «Ведения»';
    }
    if (actsAsServiceExecutorOnly(subject)) return 'свои';
    return 'как сегодня';
  }

  /**
   * Факты заявки, С КОТОРОЙ СУБЪЕКТА СНЯЛИ: действующего назначения нет (строку удаляют физически),
   * подрядчиком этой заявки он не работает, автором не был и к стороне заказчика не относится.
   * Именно в этой точке столбец таблицы и задан — «чат по заявке, с которой снят».
   */
  const REMOVED: ServiceChatFacts = {
    userId: '22222222-2222-4222-8222-222222222222',
    isAuthor: false,
    inCustomerScope: false,
    actsForAssignedService: false,
    isNamedExecutor: false,
  };

  const IT = OFFICE_EQUIPMENT_IT_GRANT;
  const EXECUTOR = OFFICE_EQUIPMENT_EXECUTOR_GRANT;
  const OPERATOR = OFFICE_EQUIPMENT_OPERATOR_GRANT;

  const ROWS: {
    what: string;
    subject: AccessSubject;
    scope: ScopeBranch;
    /**
     * Ответ САМОГО предиката контрактов на этой строке. Столбец заведён затем, чтобы таблица
     * проверяла код, а не себя: ветку «Ведения» и ветку админа выбирает помощник выше, и без
     * этого столбца три строки из семи сверяли бы помощника с помощником.
     */
    executorOnly: boolean;
    /** Пишет ли он в обсуждение заявки, с которой снят. */
    writes: boolean;
    sides: string[];
  }[] = [
    {
      what: 'ИТ + исполнитель',
      subject: { role: 'shtab', grantCodes: [IT, EXECUTOR] },
      scope: 'свои',
      executorOnly: true,
      // Участие снятого держится на стороне `it`, то есть на КОДЕ набора: сторона `service`
      // требует действующей строки назначения, которой у него больше нет (Н15).
      writes: true,
      sides: ['it'],
    },
    {
      what: 'только исполнитель (ИТ снят)',
      subject: { role: 'shtab', grantCodes: [EXECUTOR] },
      scope: 'свои',
      executorOnly: true,
      // Названная граница волны, а не недоделка: факт «был назначен» в модель чата не заводится.
      writes: false,
      sides: [],
    },
    {
      what: 'только ИТ (исполнитель снят)',
      subject: { role: 'shtab', grantCodes: [IT] },
      // Назначения остаются, новых не будет: право `serviceRequests.execute` у держателя одного
      // ИТ-набора отсутствует вовсе (Н2), а область считают КОДЫ, а не право.
      scope: 'свои',
      executorOnly: true,
      writes: true,
      sides: ['it'],
    },
    {
      what: 'ИТ + исполнитель + «Ведение»',
      subject: { role: 'shtab', grantCodes: [IT, EXECUTOR, OPERATOR] },
      scope: 'область «Ведения»',
      // «Ведение» исключает субъекта из правила: координатор модуля правит чужие заявки по
      // должности, и операторский слой с исполнительским не смешивается.
      executorOnly: false,
      writes: true,
      sides: ['operator', 'it'],
    },
    {
      what: 'оба набора сняты',
      subject: { role: 'shtab', grantCodes: [] },
      scope: 'как сегодня',
      executorOnly: false,
      // «По стороне заказчика»: у снятого её нет — он не автор и не его площадка. Вторая половина
      // строки (когда сторона есть) проверяется отдельным случаем ниже.
      writes: false,
      sides: [],
    },
    {
      what: 'admin',
      subject: { role: 'admin', grantCodes: [] },
      scope: 'всё',
      // Роль `admin` исключена первым же сомножителем: право `execute` у него по построению.
      executorOnly: false,
      writes: true,
      sides: ['operator', 'it'],
    },
    {
      what: 'оператор контрагента service',
      subject: { role: 'operator', counterpartyType: 'service', grantCodes: [] },
      // Ось подрядчика, как сегодня: кодов наборов оргтехники у него не бывает ни одного, и
      // сужает его собственная ось «заявка назначена моей компании».
      scope: 'как сегодня',
      executorOnly: false,
      // Сторона `service` требует ДЕЙСТВУЮЩЕГО назначения компании — со снятой заявкой её нет.
      writes: false,
      sides: [],
    },
  ];

  it('область заявок — все семь строк', () => {
    // Сперва ответ самого предиката: это и есть половина правила, живущая в контрактах.
    expect(ROWS.map((row) => [row.what, actsAsServiceExecutorOnly(row.subject)])).toEqual(
      ROWS.map((row) => [row.what, row.executorOnly]),
    );
    expect(ROWS.map((row) => [row.what, scopeBranchOf(row.subject)])).toEqual(
      ROWS.map((row) => [row.what, row.scope]),
    );
  });

  it('чат по заявке, с которой снят, — все семь строк', () => {
    expect(
      ROWS.map((row) => [
        row.what,
        canWriteChat(row.subject, REMOVED, 'in_work'),
        participantSidesOf(row.subject, REMOVED),
      ]),
    ).toEqual(ROWS.map((row) => [row.what, row.writes, row.sides]));
  });

  it('«по стороне заказчика» и «по своей стороне» — вторая половина двух строк', () => {
    /*
     * ДВЕ СТРОКИ ТАБЛИЦЫ ОТВЕЧАЮТ НЕ «ДА/НЕТ», А «ПО СТОРОНЕ», и на снятых фактах обе выглядят
     * одинаково — пустым списком. Без этого случая они доказывали бы лишь то, что у постороннего
     * стороны нет, а обещание «по стороне заказчика» осталось бы непроверенным.
     */
    const plain: AccessSubject = { role: 'shtab', grantCodes: [] };
    const asAuthor: ServiceChatFacts = { ...REMOVED, isAuthor: true };
    expect(participantSidesOf(plain, asAuthor)).toEqual(['customer']);
    expect(canWriteChat(plain, asAuthor, 'in_work')).toBe(true);

    const contractor: AccessSubject = {
      role: 'operator',
      counterpartyType: 'service',
      grantCodes: [],
    };
    const assigned: ServiceChatFacts = { ...REMOVED, actsForAssignedService: true };
    expect(participantSidesOf(contractor, assigned)).toEqual(['service']);
    expect(canWriteChat(contractor, assigned, 'in_work')).toBe(true);
  });

  it('закрытая заявка гасит письмо у всех семи строк', () => {
    // Второй сомножитель `canWriteChat` — закрытость заявки, а не статус вообще. Строка стоит
    // здесь, потому что таблица Р3 говорит про ЖИВУЮ заявку: у закрытой ответ один на всех.
    for (const row of ROWS) {
      expect(canWriteChat(row.subject, { ...REMOVED, isAuthor: true }, 'accepted'), row.what).toBe(
        false,
      );
    }
  });
});
