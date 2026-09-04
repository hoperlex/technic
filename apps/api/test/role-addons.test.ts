import { describe, expect, it } from 'vitest';
import {
  accessProfileLabel,
  can,
  canAttachAddon,
  canUse,
  incompatibleAddon,
  isObjectScopedRole,
  PERMISSIONS,
  permissionsFor,
  profilesWith,
  ROLE_ADDON_BASE_ROLES,
  ROLE_ADDON_PERMISSIONS,
  ROLE_ADDONS,
  roleAddonLabels,
  roleAddonsSchema,
  ROLES,
  placeObjectScopeIds,
  type AccessSubject,
  type RoleAddon,
} from '@technic/contracts';

/**
 * Надстройки роли (ADR 0086) — третья ось субъекта доступа рядом с ролью и типом контрагента.
 *
 * Проверяется здесь именно ось: кому надстройку можно навесить, что она добавляет и, главное, чего
 * она не делает. Право она даёт **сверх** роли и только своим базовым ролям — стоит этому
 * разъехаться, и «оператор оргтехники», приписанный чужой роли, откроет чужой модуль, а сама
 * надстройка либо превратится в роль (тогда её получат все, кто так работает), либо начнёт двигать
 * область (тогда штаб увидит соседнюю площадку).
 *
 * Матрица прав как таковая живёт в `permissions.test.ts`; сюда вынесено то, что относится к самой
 * надстройке, — включая проверку `can` на субъекте с несовместимой надстройкой: он приходит не
 * только из формы учётки.
 */

/** Площадка для проверок области: надстройка её не трогает. */
const OBJECT_A = '11111111-1111-1111-1111-111111111111';

/** Единственная пока надстройка — её и разбираем поимённо там, где важен предмет, а не перебор. */
const OFFICE: RoleAddon = 'office_equipment_operator';
const OFFICE_ADDONS = [OFFICE] as const;

describe('надстройка прикрепляется только к своим базовым ролям', () => {
  it('оператор оргтехники — площадке и офису, остальным ролям нет', () => {
    // Список ролей по постановке: оргтехникой занимаются на площадке и в офисе (отдел).
    // Перечислением, потому что это и есть решение: лишняя роль здесь — доступ, выданный целому
    // подразделению, и появиться она должна осознанно, строкой в контракте.
    //
    // Площадок в списке две, и это состояние перехода (ADR 0113): `site` дописана шагом prepare
    // этапа 8, потому что после перевода учёток `shtab` в этой паре не останется никого, а роль
    // спрашивается и матрицей (`canAttachAddon`), и формой учётки. Уйдёт `shtab` вместе с самой
    // ролью — на шаге cleanup.
    expect([...ROLE_ADDON_BASE_ROLES[OFFICE]]).toEqual(['shtab', 'site', 'department']);
  });

  it('перебор по всем ролям: разрешены только перечисленные, и никогда — учётка без роли', () => {
    for (const addon of ROLE_ADDONS) {
      const base = ROLE_ADDON_BASE_ROLES[addon];
      // Надстройка без базовых ролей — надстройка, которую некому выдать.
      expect([...base], addon).not.toEqual([]);
      for (const role of ROLES) {
        expect(canAttachAddon(role, addon), `${role}: ${addon}`).toBe(base.includes(role));
      }
      // Доступ выдаётся ролью: пока её не назначили, навешивать поверх нечего.
      expect(canAttachAddon(null, addon), addon).toBe(false);
      expect(canAttachAddon(undefined, addon), addon).toBe(false);
    }
  });

  /**
   * `incompatibleAddon` отвечает форме учётки и серверу сразу, и отвечает **виновником**: сообщение
   * «какая-то из надстроек не подходит» человек читать не должен.
   */
  it('несовместимость называет первую негодную надстройку, а годный набор — null', () => {
    expect(incompatibleAddon('shtab', [OFFICE])).toBe(null);
    expect(incompatibleAddon('department', [OFFICE])).toBe(null);
    // Пустой набор совместим с любой ролью: надстроек у большинства учёток нет вовсе.
    for (const role of ROLES) expect(incompatibleAddon(role, []), role).toBe(null);
    expect(incompatibleAddon('observer', [OFFICE])).toBe(OFFICE);
    expect(incompatibleAddon('operator', [OFFICE])).toBe(OFFICE);
    expect(incompatibleAddon(null, [OFFICE])).toBe(OFFICE);
    // «Первая» проверяется перебором по всему перечню, а не парой выдуманных кодов: пока надстройка
    // одна, порядок иначе не выразить, а со второй проверка станет содержательной сама.
    for (const role of ROLES) {
      expect(incompatibleAddon(role, ROLE_ADDONS), role).toBe(
        ROLE_ADDONS.find((addon) => !canAttachAddon(role, addon)) ?? null,
      );
    }
  });

  it('схема принимает пустой набор и известные коды, а выдуманный отвергает', () => {
    expect(roleAddonsSchema.parse([])).toEqual([]);
    expect(roleAddonsSchema.parse([...ROLE_ADDONS])).toEqual([...ROLE_ADDONS]);
    expect(roleAddonsSchema.safeParse(['office_equipment_admin']).success).toBe(false);
    expect(roleAddonsSchema.safeParse([OFFICE, 'nope']).success).toBe(false);
    // Набор, а не одно значение: строкой сюда приходить не должно.
    expect(roleAddonsSchema.safeParse(OFFICE).success).toBe(false);
    // Предел стоит от опечатки в клиенте: надстроек в наборе не бывает больше, чем их всего.
    expect(roleAddonsSchema.safeParse([...ROLE_ADDONS, ...ROLE_ADDONS]).success).toBe(false);
  });
});

describe('матрица надстроек', () => {
  /** Тот же инвариант, что у ролей и типов контрагента в `permissions.test.ts`. */
  it('у каждой надстройки объявлен непустой набор прав, и все права из него существуют', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const addon of ROLE_ADDONS) {
      expect(ROLE_ADDON_PERMISSIONS[addon], addon).toBeDefined();
      // Пустой набор — надстройка, которую можно выдать, ничего этим не выдав.
      expect(ROLE_ADDON_PERMISSIONS[addon].length, addon).toBeGreaterThan(0);
      for (const permission of ROLE_ADDON_PERMISSIONS[addon]) {
        expect(known.has(permission), `${addon}: ${permission}`).toBe(true);
      }
    }
  });

  /**
   * Что надстройка даёт — перечислением, а не выборочными проверками: справочник оргтехники плюс
   * три решения по заявке (кого позвать чинить, согласны ли на эти деньги, принята ли работа).
   * Список закрытый — право, дописанное сюда по недосмотру, обязано уронить этот тест: смысл
   * третьей оси в том, что она узкая, и лишнее право означало бы вторую роль под видом надстройки.
   */
  it('«Ведению» дано ровно ведение справочника и решения по заявке', () => {
    /*
     * Заморозка и срочность приехали волной В5 плана переработки заявок и права здесь не расширяют:
     * «Отложена» приходила внутри `serviceRequests.status`, флаг «Срочная» — внутри `update`, то
     * есть всякому, кто правит заявку. Оба выделены своими правами, чтобы их можно было **отобрать**
     * у соседних должностей, и вернулись тому, у кого и были.
     */
    /*
     * Седьмым правом пришли плановые закупки расходников (ADR 0146, план расходников и закупки,
     * Р12) — и вот они перечень действительно расширяют, а не возвращают своё. Это решение
     * заказчика: закупку заводит тот, кто ведёт модуль, — и «Ведение» перестало быть только про
     * заявки и справочник техники. Своё право у закупки потому, что у неё своя таблица и свои
     * ручки; надстройка от этого второй ролью не стала — работа осталась одной и той же должности.
     */
    /*
     * Восьмым — заведение заявки без аппарата (ADR 0146, решение 6, план Р5). Оно тоже расширяет
     * перечень, но иначе, чем закупка: своей двери у права нет вовсе — заведение идёт через тот же
     * `POST /service-requests`, и право лишь снимает с него требование обязательного аппарата. В
     * надстройке оно потому, что «поставьте розетку» и «настройте почту новому сотруднику»
     * приходят к тому, кто ведёт модуль. Требование `serviceRequests.create` (`PERMISSION_REQUIRES`)
     * у всех трёх базовых ролей выполняется: заявку как заказчик заводит каждая.
     */
    /*
     * Девятым — деньги и объём работ заявок (план `docs/office-equipment-requester-card-plan.md`,
     * Р2). Перечень оно расширяет только на бумаге: до выката проекции суммы видел всякий, кому
     * видна заявка, и право лишь называет того, кто продолжит их видеть. «Ведение» здесь потому, что
     * оно согласует объём работ и принимает работу, — отобрать у него цифры значило бы просить
     * подпись вслепую.
     */
    /*
     * Первыми шестью набор стал САМОДОСТАТОЧНЫМ (план
     * `docs/office-equipment-access-profiles-plan.md`, Р4; находка Н4; миграция 0261). Прав они не
     * расширяют вовсе — ни у одного держателя: чтение справочника и круг заказчика по заявке даёт
     * любая из трёх базовых ролей, а источники соединены `OR`. Расширяют они не доступ, а
     * НЕЗАВИСИМОСТЬ состава: прежде набор давал `officeEquipment.write` без `.read` и решения по
     * заявке без её чтения, и работало это лишь потому, что совместимых ролей ровно три и у каждой
     * чтение своё. Пока так — набор нельзя было выдать роли без модуля (этап Э6 расширяет
     * `grant_roles` на менеджера и диспетчера), барьер требований проверял не то, что кажется, а
     * снятие права из роли молча выключило бы половину набора.
     */
    expect([...ROLE_ADDON_PERMISSIONS[OFFICE]]).toEqual([
      'officeEquipment.read',
      'serviceRequests.read',
      'serviceRequests.create',
      'serviceRequests.update',
      'serviceRequests.delete',
      'serviceRequests.files',
      'officeEquipment.write',
      'serviceRequests.assign',
      'serviceRequests.approveEstimate',
      'serviceRequests.status',
      'serviceRequests.finance',
      'serviceRequests.hold',
      'serviceRequests.urgency',
      'officeEquipmentPurchases.manage',
      'serviceRequests.createWithoutEquipment',
    ]);
  });

  /**
   * Права сметы (`serviceRequests.estimate`) в надстройке нет, и это отдельный кейс, а не следствие
   * перечня выше: смету пишет исполнитель, а оператор её согласует. Выданные одному субъекту, эти
   * два права превратили бы согласование в подпись под собственной работой — и заодно открыли бы
   * оператору шаги исполнителя, потому что именно право сметы добавляет коридор исполнителя в
   * `allowedServiceStatusTransitions` (ADR 0085 Р17).
   */
  it('права сметы надстройка не даёт: согласующий не пишет то, что согласует', () => {
    expect([...ROLE_ADDON_PERMISSIONS[OFFICE]]).not.toContain('serviceRequests.estimate');
    for (const role of ROLE_ADDON_BASE_ROLES[OFFICE]) {
      const operator: AccessSubject = { role, addons: OFFICE_ADDONS };
      expect(can(operator, 'serviceRequests.approveEstimate'), role).toBe(true);
      expect(can(operator, 'serviceRequests.status'), role).toBe(true);
      expect(can(operator, 'serviceRequests.estimate'), role).toBe(false);
    }
    // Вне контрагента-сервиса право сметы есть только у администратора — надстройка второго
    // держателя не заводит.
    expect(profilesWith('serviceRequests.estimate').map(accessProfileLabel)).toEqual([
      'Администратор',
      'Оператор (внешний исполнитель) — Сервисная компания',
    ]);
  });
});

describe('надстройка в проверке прав', () => {
  it('штаб с надстройкой ведёт справочник оргтехники, без надстройки — только читает', () => {
    const shtab: AccessSubject = { role: 'shtab' };
    const operator: AccessSubject = { role: 'shtab', addons: OFFICE_ADDONS };
    expect(can(operator, 'officeEquipment.write')).toBe(true);
    expect(can(shtab, 'officeEquipment.write')).toBe(false);
    // Пустой и незаполненный набор — то же самое, что «надстроек нет»: поле необязательное.
    expect(can({ role: 'shtab', addons: [] }, 'officeEquipment.write')).toBe(false);
    expect(can({ role: 'shtab', addons: null }, 'officeEquipment.write')).toBe(false);
    // Чтение у штаба своё, ролевое: надстройка его не «выдаёт заново» и не отнимает.
    expect(can(operator, 'officeEquipment.read')).toBe(true);
    expect(can(shtab, 'officeEquipment.read')).toBe(true);
  });

  it('то же самое у отдела — вторая базовая роль надстройки', () => {
    expect(can({ role: 'department', addons: OFFICE_ADDONS }, 'officeEquipment.write')).toBe(true);
    expect(can({ role: 'department' }, 'officeEquipment.write')).toBe(false);
  });

  /**
   * Несовместимая с ролью надстройка прав не даёт — и это не повтор проверки формы учётки.
   *
   * Субъект приходит в `can` откуда угодно: из принципала на сервере, из текущего пользователя на
   * портале, из чего угодно, что подставили в объект. Держись запрет только на API учёток — и
   * дописанная надстройка открыла бы ведение всего парка компании кому угодно, вплоть до
   * наблюдателя, задуманного как «только просмотр».
   */
  it('несовместимая с ролью надстройка прав не даёт', () => {
    expect(can({ role: 'observer', addons: OFFICE_ADDONS }, 'officeEquipment.write')).toBe(false);
    expect(can({ role: 'commandant', addons: OFFICE_ADDONS }, 'officeEquipment.write')).toBe(false);
    expect(
      can(
        { role: 'operator', counterpartyType: 'service', addons: OFFICE_ADDONS },
        'officeEquipment.write',
      ),
    ).toBe(false);
    // Учётка без роли не получает прав и с надстройкой: доступ выдаётся ролью.
    expect(can({ role: null, addons: OFFICE_ADDONS }, 'officeEquipment.write')).toBe(false);
    // Перебором по всем ролям: у роли, которой надстройка не положена, набор прав от неё не
    // меняется вовсе — ни этим правом, ни каким-либо другим.
    for (const role of ROLES.filter((r) => !canAttachAddon(r, OFFICE))) {
      expect([...permissionsFor({ role, addons: OFFICE_ADDONS })], role).toEqual([
        ...permissionsFor({ role }),
      ]);
    }
  });

  /**
   * Надстройка добавляет свои права и не приносит чужих — сравнением множеств, а не выборочными
   * проверками: смысл третьей оси в том, что она узкая, и лишнее право здесь означало бы вторую
   * роль под видом надстройки.
   */
  it('набор профиля с надстройкой = набор базовой роли плюс права надстройки', () => {
    for (const role of ROLE_ADDON_BASE_ROLES[OFFICE]) {
      expect(new Set(permissionsFor({ role, addons: OFFICE_ADDONS })), role).toEqual(
        new Set([...permissionsFor({ role }), ...ROLE_ADDON_PERMISSIONS[OFFICE]]),
      );
    }
  });

  /**
   * Область надстройка не двигает (ADR 0086): она отвечает на «что человек дополнительно может», а
   * не на «над какими строками». Штаб с надстройкой остаётся штабом своей площадки — и в модуле
   * вывоза, и в самом справочнике оргтехники, где строки отбираются по объекту.
   */
  it('надстройка не меняет область: она отвечает на «что», а не на «над чем»', () => {
    expect(
      placeObjectScopeIds({
        role: 'shtab',
        addons: OFFICE_ADDONS,
        constructionObjectIds: [OBJECT_A],
      }),
    ).toEqual([OBJECT_A]);
    // Пустая область остаётся пустой: надстройка не делает роль «сквозной».
    expect(placeObjectScopeIds({ role: 'shtab', addons: OFFICE_ADDONS })).toEqual([]);
    expect(canUse({ role: 'shtab', addons: OFFICE_ADDONS }, 'wasteRequests.read')).toBe(false);
    expect(
      canUse(
        { role: 'shtab', addons: OFFICE_ADDONS, constructionObjectIds: [OBJECT_A] },
        'wasteRequests.read',
      ),
    ).toBe(true);
    // Ось роли остаётся её собственной — надстройка её не подменяет.
    expect(isObjectScopedRole('shtab')).toBe(true);
  });
});

describe('подпись профиля с надстройкой', () => {
  it('надстройка дописывается к роли, а не заменяет её', () => {
    expect(accessProfileLabel({ role: 'shtab', addons: OFFICE_ADDONS })).toBe(
      'Штаб + Оргтехника: ведение',
    );
    expect(accessProfileLabel({ role: 'department', addons: OFFICE_ADDONS })).toBe(
      'Отдел + Оргтехника: ведение',
    );
    // Без надстроек подпись прежняя: пустой набор не должен дорисовывать «плюс» в конце.
    expect(accessProfileLabel({ role: 'shtab' })).toBe('Штаб');
    expect(accessProfileLabel({ role: 'shtab', addons: [] })).toBe('Штаб');
  });

  it('у каждой надстройки есть своя подпись, и она не повторяет подпись роли', () => {
    const roleNames = new Set(ROLES.map((role) => accessProfileLabel({ role })));
    for (const addon of ROLE_ADDONS) {
      expect(roleAddonLabels[addon], addon).toBeTruthy();
      expect(roleNames.has(roleAddonLabels[addon]), addon).toBe(false);
    }
  });
});
