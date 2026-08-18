import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  ADDON_MODULE_WIDE_SCOPE,
  ADMIN_GRANT_CODES,
  ADMIN_GRANTS,
  ALL_SYSTEM_GRANT_CODES,
  can,
  conflictingPermissions,
  COUNTERPARTY_SCOPED_ROLES,
  createUserSchema,
  DEPARTMENT_SCOPED_ROLES,
  effectiveDelta,
  GRANT_CONFLICTS,
  GRANT_MODULE_WIDE_SCOPE,
  GRANT_SCOPE_MATRIX,
  grantCodeSchema,
  grantListQuerySchema,
  grantScopeRule,
  grantStatementListSchema,
  isGrantable,
  isPermission,
  MAX_ASSIGNED_GRANTS,
  MAX_GRANT_STATEMENTS,
  NON_GRANTABLE_PERMISSIONS,
  OBJECT_SCOPED_ROLES,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSION_REQUIRES,
  permissionSource,
  permissionSources,
  permissionsFor,
  PERMISSIONS,
  PERMISSIONS_BY_MODULE,
  PERSON_SCOPED_ROLES,
  ROLE_ADDON_BASE_ROLES,
  ROLE_ADDON_PERMISSIONS,
  ROLE_ADDONS,
  ROLE_GRANT_CODES,
  ROLE_GRANTS,
  ROLE_PERMISSIONS,
  ROLE_SCOPE_AXES,
  roleScopeAxis,
  ROLES,
  SYSTEM_GRANT_CODES,
  updateUserSchema,
  validateGrantAssignment,
  type AccessSubject,
  type GrantScopeRule,
  type GrantViolation,
  type GrantViolationCode,
  type Permission,
  type PermissionModule,
  type Role,
  type RoleGrantCode,
  type RoleScopeAxis,
} from '@technic/contracts';

/**
 * Границы назначаемых полномочий (ADR 0106, шаг 1a) — `packages/contracts/src/grants.ts`.
 *
 * Файл держит ровно то, что ADR объявил критерием готовности шага, и держит числами: «пять
 * невыдаваемых прав», «назначаемых 53 из 58» (в ADR было 50 из 55 — словарь пополнили пара прав
 * техобслуживания и ведение руководств), «две пары разделения обязанностей». В самом `grants.ts`
 * эти числа живут только в тексте комментария, а текст ничего не роняет: следующее право,
 * добавленное в словарь, молча станет назначаемым, а строка, убранная из
 * `NON_GRANTABLE_PERMISSIONS`, откроет кабинет водителя — то есть чужие персональные данные —
 * пакетом, собранным в конструкторе.
 *
 * Права ролей здесь не проверяются: они живут в `permissions.test.ts`, витрина каталога — в
 * `permission-catalog.test.ts`. Этот файл отвечает на другой вопрос: не «кому положено право», а
 * «что нельзя выдать, что без чего не имеет смысла и что нельзя свести в одном человеке».
 *
 * Наборы как **источник** прав (шаг 1c) — тоже здесь, последними тремя блоками: `grantPermissions`
 * на субъекте, множественный `permissionSources` и `effectiveDelta` описывают поведение наборов, а
 * не должностей, и ломаются они вместе с границами выдачи, а не вместе с матрицей ролей.
 *
 * **Барьеры выдачи** (этап 3, первая волна) — два последних блока: матрица «ось роли × модуль»
 * (`grant-scope.ts`) и единая проверка `validateGrantAssignment`. Проверяются они здесь по той же
 * причине, по которой лежат рядом в контрактах: барьер, у которого нет теста на **каждое**
 * нарушение по отдельности, отличается от отсутствующего барьера только тем, что о нём написано в
 * плане. Отдельно проверяется неслучайность запретов: матрица обязана расходиться с фактическим
 * состоянием слоя области (`apps/api/src/lib/access.ts`) не молча, а падением.
 *
 * Состав системных наборов в базе сверяется отдельно — `grants-catalog.db.test.ts`: он про
 * миграцию, а здесь нет базы вовсе.
 */

/** Словарь прав множеством: «существует ли такое право» спрашивается здесь на каждом шагу. */
const ALL: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/**
 * Невыдаваемые права, выписанные вторым списком намеренно.
 *
 * Обычно вторая копия — это дефект, и весь соседний db-тест написан против неё. Здесь она и есть
 * проверка: сравнение константы с самой собой не поймало бы ничего, а тест обязан падать в тот
 * момент, когда кто-то убирает право из запрета. Список короткий, закрытый и меняется решением
 * ADR, а не выкатом, — поэтому его дешевле выписать, чем вывести.
 */
const EXPECTED_NON_GRANTABLE: readonly Permission[] = [
  'records.purge',
  'users.manage',
  'waybills.correctBeyondLimit',
  'driverCabinet.read',
  'driverCabinet.submit',
];

describe('невыдаваемые права: пять, и именно эти', () => {
  /**
   * Число и состав вместе. Число ловит шестое право, потихоньку добавленное в запрет (оно сузило бы
   * конструктор молча), состав — подмену: список той же длины, где вместо `driverCabinet.submit`
   * стоит что-то безобидное, прошёл бы проверку на длину и открыл бы приём показаний от чужого
   * имени.
   */
  it('список ровно из пяти прав и совпадает с решением 6 ADR 0106', () => {
    expect(NON_GRANTABLE_PERMISSIONS).toHaveLength(5);
    expect([...NON_GRANTABLE_PERMISSIONS]).toEqual([...EXPECTED_NON_GRANTABLE]);
    // Оба права кабинета, а не одно: кабинет показывает задание конкретного работника и принимает
    // показания от его имени (ADR 0102), и достаться «заодно с пакетом» он не должен ни на чтение,
    // ни на запись.
    expect([...NON_GRANTABLE_PERMISSIONS]).toContain('driverCabinet.read');
    expect([...NON_GRANTABLE_PERMISSIONS]).toContain('driverCabinet.submit');
  });

  /**
   * Запрет на несуществующее право — запрет ни на что: право переименовали, строка осталась, и
   * конструктор снова показывает чекбокс, которого не должен. Компилятор такое ловит только пока
   * список объявлен через `satisfies readonly Permission[]`; проверка стоит и здесь, потому что
   * условие это про данные, а не про типы.
   */
  it('каждое невыдаваемое право существует в словаре', () => {
    for (const permission of NON_GRANTABLE_PERMISSIONS) {
      expect(ALL.has(permission), permission).toBe(true);
    }
    expect(new Set(NON_GRANTABLE_PERMISSIONS).size).toBe(NON_GRANTABLE_PERMISSIONS.length);
  });
});

describe('назначаемые права: 53 из 58', () => {
  /**
   * То самое число из ADR. Считается вычитанием, а не записано «50»: право, добавленное в словарь,
   * обязано пополнить назначаемые — и одновременно оба слагаемых закреплены явно, иначе тест
   * согласился бы с любой парой чисел, включая «5 из 5».
   */
  it('назначаемых ровно столько, сколько прав минус запрет', () => {
    // Пятьдесят пять — число ADR 0106; сверх него словарь пополнили пара прав техобслуживания
    // (план «Показания техники», Р14) и ведение руководств (`docs/manuals-plan.md`) — все три
    // пополнили и назначаемые сразу, как того и требует правило ниже. Пятьдесят восемь и
    // пятьдесят три расходятся ровно на длину запрета, и это третье равенство здесь не лишнее:
    // без него тест согласился бы с правом, добавленным в словарь и тихо попавшим в запрет.
    expect(PERMISSIONS).toHaveLength(58);
    const grantable = PERMISSIONS.filter(isGrantable);
    expect(grantable).toHaveLength(PERMISSIONS.length - NON_GRANTABLE_PERMISSIONS.length);
    expect(grantable).toHaveLength(53);
  });

  /**
   * Предикат и список — один ответ. Спрашивают `isGrantable` схема запроса, конструктор и тесты;
   * разойдись он со списком хоть на одном праве — форма покажет чекбокс, который сервер отклонит,
   * либо сервер примет то, чего форма не показывает. Перебором всех прав, а не выборочно: такие
   * расхождения живут в одной клетке.
   */
  it('isGrantable согласован со списком на каждом праве', () => {
    const forbidden = new Set<string>(NON_GRANTABLE_PERMISSIONS);
    for (const permission of PERMISSIONS) {
      expect(isGrantable(permission), permission).toBe(!forbidden.has(permission));
    }
  });
});

describe('требования прав друг к другу', () => {
  /**
   * Ключ и значения — существующие права. Требование, повешенное на выкаченное право, не проверяет
   * ничего; требование **несуществующего** права не выполнить вовсе — набор с таким правом сервер
   * будет отклонять всегда, и причина отказа («нужно право, которого нет в словаре») не будет
   * понятна ни администратору, ни в журнале.
   */
  it('все ключи и все требования — существующие права', () => {
    for (const [permission, required] of Object.entries(PERMISSION_REQUIRES)) {
      expect(ALL.has(permission), permission).toBe(true);
      for (const dependency of required ?? []) {
        expect(ALL.has(dependency), `${permission} → ${dependency}`).toBe(true);
      }
    }
  });

  /**
   * Главная проверка таблицы. Требование, ссылающееся на невыдаваемое право, делает набор с
   * зависимым правом несобираемым в принципе: инвариант проверяется по итоговым правам учётки, а
   * невыдаваемое право взять неоткуда, кроме роли. Самый близкий пример — `users.manage`: объяви
   * его требованием чего-нибудь ещё, и это «что-нибудь» перестанет выдаваться навсегда, причём
   * отказ придёт из проверки инварианта, а не из запрета, и читаться будет как ошибка сервера.
   */
  it('ни одно требование не ссылается на невыдаваемое право', () => {
    const forbidden = new Set<string>(NON_GRANTABLE_PERMISSIONS);
    for (const [permission, required] of Object.entries(PERMISSION_REQUIRES)) {
      for (const dependency of required ?? []) {
        // Исключение ровно одно, и оно не требование, а объявление: невыдаваемое право может
        // требовать само себя — так `users.manage` объявлен входным правом модуля витрины.
        if (dependency === permission) continue;
        expect(forbidden.has(dependency), `${permission} → ${dependency}`).toBe(false);
      }
    }
  });

  /**
   * «Требует само себя» и «строки нет» — разные утверждения, и различие это несёт смысл: первое
   * говорит «право входное, за ним не стоит ничего», второе — «требование не объявлено». Схлопни их
   * читатель (или заботливый рефакторинг, вычищающий «бессмысленные» самоссылки) — и таблица
   * перестанет отличать решение от молчания, а `Partial` в типе останется без объяснения.
   */
  it('входное право объявлено самоссылкой, а не отсутствием строки', () => {
    // `manuals.manage` — четвёртое входное право: модуль «Руководства» состоит из него одного, и
    // самоссылка здесь объявляет, что за правом не стоит ничего (`docs/manuals-plan.md` §3.1).
    for (const entry of [
      'audit.read',
      'mailings.read',
      'users.manage',
      'manuals.manage',
    ] as const) {
      expect(PERMISSION_REQUIRES[entry], entry).toEqual([entry]);
    }
    // Отсутствие строки — не «право самодостаточно»: читают таблицу через `?? []`, и вот эти права
    // требований не объявляют вовсе.
    expect(PERMISSION_REQUIRES['wasteRequests.create']).toBeUndefined();
    expect(PERMISSION_REQUIRES['officeEquipment.write']).toBeUndefined();
    // Настоящие требования — не самоссылки: ход заказа без чтения заказа и есть тот случай
    // коменданта, ради которого таблица заведена (ADR 0021).
    expect(PERMISSION_REQUIRES['vehicleRequests.status']).toEqual(['vehicleRequests.read']);
    expect(PERMISSION_REQUIRES['waybills.cancel']).toEqual(['waybills.read']);
  });
});

describe('конфликты обязанностей', () => {
  /**
   * Пара из несуществующих прав — правило, которое не сработает никогда: разделение обязанностей на
   * бумаге есть, а смету составляет и утверждает один человек. Переименование права в словаре ловит
   * компилятор, но только пока пара объявлена типом; данные проверяются здесь.
   */
  it('обе пары состоят из существующих и различных прав', () => {
    expect(GRANT_CONFLICTS).toHaveLength(2);
    for (const { permissions, reason } of GRANT_CONFLICTS) {
      const [first, second] = permissions;
      expect(ALL.has(first), first).toBe(true);
      expect(ALL.has(second), second).toBe(true);
      // Пара из одного и того же права запрещала бы само это право — не разделение обязанностей, а
      // молчаливый запрет на выдачу.
      expect(first, reason).not.toBe(second);
      // Причина уходит в текст отказа: пустая оставила бы администратора без объяснения, почему
      // набор не сохраняется.
      expect(reason.trim(), `${first} × ${second}`).not.toBe('');
    }
  });

  /**
   * Порядок прав в наборе — свойство перебора, а не решения. Найдись пара только в объявленном
   * порядке — запрет обходился бы перестановкой чекбоксов в форме, то есть не существовал бы вовсе.
   */
  it('пара находится в любом порядке и не зависит от лишних прав рядом', () => {
    for (const conflict of GRANT_CONFLICTS) {
      const [first, second] = conflict.permissions;
      expect(conflictingPermissions([first, second])).toBe(conflict);
      expect(conflictingPermissions([second, first])).toBe(conflict);
      // С посторонними правами вперемешку — так набор и приходит с формы.
      expect(conflictingPermissions(['directories.read', second, 'waybills.read', first])).toBe(
        conflict,
      );
    }
  });

  /**
   * Обратная сторона: половина пары конфликтом не является. Сработай проверка на одном праве —
   * «Оператор (оргтехника)» перестал бы сохраняться, хотя `serviceRequests.approveEstimate` без
   * `serviceRequests.estimate` — это ровно та раскладка, ради которой пара и заведена.
   */
  it('половина пары и непересекающийся набор конфликтом не считаются', () => {
    expect(conflictingPermissions([])).toBeNull();
    expect(conflictingPermissions(['serviceRequests.estimate'])).toBeNull();
    expect(conflictingPermissions(['serviceRequests.approveEstimate'])).toBeNull();
    expect(conflictingPermissions(['serviceRequests.approveIt'])).toBeNull();
    expect(
      conflictingPermissions(['directories.read', 'waybills.read', 'vehicleRequests.read']),
    ).toBeNull();
  });
});

describe('коды системных наборов покрывают надстройки', () => {
  /**
   * **Главная проверка файла — и она обратна той, что делает компилятор.**
   *
   * `SYSTEM_GRANT_CODES` объявлен как `satisfies readonly RoleAddon[]`, и это утверждение про одно
   * направление: каждый код — существующая надстройка. Двойной записи шагов 1a–1d нужно обратное:
   * у **каждой** надстройки есть набор, в который её выдачу можно отразить. Третья надстройка,
   * добавленная в `ROLE_ADDONS` без строки в `SYSTEM_GRANT_CODES` и без набора в каталоге,
   * скомпилируется без единого замечания, а выдача такой надстройки на правке учётки упадёт
   * пятисоткой — «набора с таким кодом нет», — и произойдёт это на живой учётке, а не в сборке.
   *
   * Сверкой множеств в обе стороны, а не длиной: списки одинаковой длины с разъехавшимися кодами —
   * ровно тот случай, который ловить и нужно.
   */
  it('у каждой надстройки есть системный набор, и лишних кодов нет', () => {
    const codes = new Set<string>(SYSTEM_GRANT_CODES);
    for (const addon of ROLE_ADDONS) {
      expect(codes.has(addon), `надстройка «${addon}» без системного набора`).toBe(true);
    }
    const addons = new Set<string>(ROLE_ADDONS);
    for (const code of SYSTEM_GRANT_CODES) {
      expect(addons.has(code), `набор «${code}» без надстройки`).toBe(true);
    }
    expect([...codes].sort()).toEqual([...addons].sort());
  });

  /**
   * Каталог прав надстройки — тоже часть моста: набор, которому нечего выдавать, отражал бы выдачу
   * в пустоту. Здесь проверяется только непустота и существование прав; точное равенство состава
   * тому, что лежит в базе, — предмет `grants-catalog.db.test.ts`.
   */
  it('состав каждой надстройки непуст и состоит из существующих прав', () => {
    for (const code of SYSTEM_GRANT_CODES) {
      const permissions = ROLE_ADDON_PERMISSIONS[code];
      expect(permissions, code).not.toEqual([]);
      for (const permission of permissions) {
        expect(isPermission(permission), `${code}: ${permission}`).toBe(true);
      }
      expect(ROLE_ADDON_BASE_ROLES[code], code).not.toEqual([]);
    }
  });

  /**
   * Вторая таблица сквозной области — по кодам наборов, а не по надстройкам — существует ради
   * перехода и обязана отвечать так же, как первая. Разъехавшись, она означала бы, что «сквозная
   * область» до переключения читателей и после него — разные вещи: виза ИТ, переставшая видеть
   * заявки всей компании, ничем себя не выдаёт — прав у держателя ровно столько же, а подписывать
   * ему нечего.
   */
  it('сквозная область по коду набора совпадает с областью надстройки', () => {
    expect(Object.keys(GRANT_MODULE_WIDE_SCOPE).sort()).toEqual([...SYSTEM_GRANT_CODES].sort());
    for (const code of SYSTEM_GRANT_CODES) {
      expect([...GRANT_MODULE_WIDE_SCOPE[code]], code).toEqual([...ADDON_MODULE_WIDE_SCOPE[code]]);
    }
  });
});

/**
 * Административная часть стартового каталога (план §10, этап 4) — четыре набора, разгружающие
 * администратора: обмен справочниками, архивариус, аудитор, бланки.
 *
 * **Зачем отдельный блок, если состав в базе сверяет `grants-catalog.db.test.ts`.** Тот отвечает на
 * «равна ли база коду», этот — на «имеет ли смысл сам код». Набор, объявленный так, что барьеры
 * выдачи его не пропускают, — набор-пустышка: он занимает строку в каталоге, показывается
 * администратору, а нажатие «выдать» отвечает отказом, который никто не может устранить, потому что
 * системный набор не редактируется вовсе. Барьеры считаются по контрактам, без базы, — значит и
 * проверять их надо здесь.
 */
describe('административная часть каталога: наборы, которые вообще можно выдать', () => {
  /**
   * **Главная проверка блока.** Каждая пара «набор × его роль» проходит `validateGrantAssignment` —
   * все пять барьеров разом: невыдаваемое право, роль без наборов, матрица осей, требования прав
   * друг к другу и разделение обязанностей.
   *
   * Итог считается как считает его сервер: права роли **плюс** состав набора. Подставить сюда один
   * состав набора значило бы проверять не то — барьеры итога (4 и 5) смотрят на все источники
   * сразу, и «Аудитор» из одного `audit.read` прошёл бы проверку, которой на живой учётке нет.
   */
  it('каждый набор проходит проверку выдачи для каждой своей роли', () => {
    for (const code of ADMIN_GRANT_CODES) {
      const grant = ADMIN_GRANTS[code];
      expect(grant.roles, `набор «${code}» не назначить ни одной роли`).not.toEqual([]);
      expect(grant.permissions, `набор «${code}» пуст`).not.toEqual([]);
      for (const role of grant.roles) {
        const after = [...new Set<Permission>([...ROLE_PERMISSIONS[role], ...grant.permissions])];
        const violations = validateGrantAssignment({
          roles: [role],
          permissions: grant.permissions,
          subjectPermissionsAfter: after,
          subjectRole: role,
          grantLabel: grant.name,
        });
        expect(
          violations.map((v) => `[${v.code}] ${v.message}`),
          `набор «${code}» нельзя выдать роли «${role}»`,
        ).toEqual([]);
      }
    }
  });

  /**
   * Состав сам по себе — та же проверка без субъекта (`subjectPermissionsAfter: null`), то есть
   * ровно три барьера набора на всём декартовом произведении «роли × права» сразу.
   *
   * Отдельным утверждением от предыдущего, потому что ловит другое: там роли перебираются по одной,
   * и промах в одной строке `grant_roles` виден лишь в её итерации; здесь набор проверяется так,
   * как его проверит конструктор при сохранении — целиком.
   */
  it('состав каждого набора законен сам по себе, без держателя', () => {
    for (const code of ADMIN_GRANT_CODES) {
      const grant = ADMIN_GRANTS[code];
      const violations = validateGrantAssignment({
        roles: grant.roles,
        permissions: grant.permissions,
        subjectPermissionsAfter: null,
        subjectRole: null,
        grantLabel: grant.name,
      });
      expect(
        violations.map((v) => `[${v.code}] ${v.message}`),
        `состав набора «${code}» не проходит барьеры`,
      ).toEqual([]);
    }
  });

  /**
   * Набор обязан что-то давать. Административная часть каталога заводится ради **запертых** прав —
   * тех девяти, что сегодня есть только у администратора (§10), — и право, которое роль и так
   * имеет, в таком наборе означает одно из двух: либо промах в составе, либо матрица ролей уехала
   * вперёд каталога. Второе важнее: раздай кто-нибудь `waybills.issueBlank` диспетчеру строкой в
   * `ROLE_PERMISSIONS`, и «Бланки строгой отчётности» станут набором, выдача которого не меняет
   * ничего, — а администратор продолжит его выдавать, считая, что решает вопрос.
   */
  it('ни одно право административных наборов не выдано совместимой роли сегодня', () => {
    for (const code of ADMIN_GRANT_CODES) {
      const grant = ADMIN_GRANTS[code];
      for (const role of grant.roles) {
        const already = grant.permissions.filter((p) => ROLE_PERMISSIONS[role].includes(p));
        expect(
          already,
          `набор «${code}» ничего не добавляет роли «${role}»: право уже даёт ROLE_PERMISSIONS`,
        ).toEqual([]);
      }
    }
  });

  /**
   * Коды административных наборов — системные, и администратору они не отдаются: `grantCodeSchema`
   * обязана отклонить каждый. Без этого пользовательский набор под кодом «Архивариус» встал бы
   * рядом с системным (уникальный индекс его не пустит только пока системная строка жива), а
   * будущая правка каталога миграцией искала бы строку по коду и нашла бы чужую.
   */
  it('системные коды не отдаются под пользовательский набор', () => {
    for (const code of ADMIN_GRANT_CODES) {
      expect(grantCodeSchema.safeParse(code).success, code).toBe(false);
    }
    // Обратное: обычный код проходит — проверка отклоняет системные, а не всё подряд.
    expect(grantCodeSchema.safeParse('fuel_intake').success).toBe(true);
  });

  /**
   * Перечень всех системных кодов собран из двух списков, а не переписан третьим: он и есть тот
   * фильтр, по которому страж базы утверждает «лишних системных наборов нет». Разъехавшись с
   * источниками, он либо пропустил бы незаведённый набор, либо потребовал бы несуществующего.
   */
  it('перечень системных кодов — это перенесённые плюс административные и ролевые, без дублей', () => {
    expect([...ALL_SYSTEM_GRANT_CODES].sort()).toEqual(
      [...SYSTEM_GRANT_CODES, ...ADMIN_GRANT_CODES, ...ROLE_GRANT_CODES].sort(),
    );
    expect(new Set<string>(ALL_SYSTEM_GRANT_CODES).size).toBe(ALL_SYSTEM_GRANT_CODES.length);
    // Сквозной области ни административные, ни ролевые наборы не несут: таблица типизирована
    // `SystemGrantCode`, и ключей под них там нет — утверждение проверяет, что их не добавили заодно.
    for (const code of [...ADMIN_GRANT_CODES, ...ROLE_GRANT_CODES]) {
      expect(Object.keys(GRANT_MODULE_WIDE_SCOPE), code).not.toContain(code);
    }
  });
});

/**
 * Ролевая часть каталога (план §10 «замещающие упразднённые роли», §15 этап 4б; ADR 0112) — три
 * набора, в которые переезжает различие между четырьмя упраздняемыми ролями.
 *
 * Отдельным блоком от административного, потому что проверяется здесь другое. Там набор обязан
 * **что-то давать** роли, которая у него в `grant_roles`; здесь набор обязан давать **ровно то**, чем
 * старая роль отличалась от новой, — и это утверждение проверяется равенством множеств, а не
 * непустотой разности.
 */
describe('ролевая часть каталога: наборы, замещающие упразднённые роли', () => {
  /**
   * **Обязательство реформы, выраженное кодом** (план §9, таблица соответствия). Каждая упраздняемая
   * роль обязана быть в точности равна паре «роль-преемник + наборы»: не «не меньше», а равна — набор
   * с лишним правом расширил бы доступ этапом 8 молча, набор с недостающим отобрал бы его так же
   * молча.
   *
   * Считается по сумме прав, а не по разности составов: у наборов и ролей источники разные, а вопрос
   * один — что будет у человека после перевода.
   *
   * Комендант в таблице стоит **особняком и с разницей**, а не с равенством: решением №1 заказчика
   * (17.08.2026) ему объявлено расширение — оргтехника, — и это единственная строка всей реформы, где
   * прав становится больше. Разница выписана поимённо: молчаливое «ну там что-то добавится» и есть
   * тот способ, которым расширение доступа проходит незамеченным.
   */
  it('старая роль равна новой паре «роль + наборы» — поимённо', () => {
    const sum = (role: Role, codes: readonly RoleGrantCode[]): Set<Permission> =>
      new Set<Permission>([
        ...ROLE_PERMISSIONS[role],
        ...codes.flatMap((code) => [...ROLE_GRANTS[code].permissions]),
      ]);
    const same = (was: Role, becomes: Set<Permission>): void => {
      expect([...becomes].sort(), was).toEqual([...ROLE_PERMISSIONS[was]].sort());
    };

    same('shtab', sum('site', ['vehicle_ordering']));
    same('rukstroy', sum('site', ['vehicle_ordering', 'site_approval']));
    same('department_head', sum('department', ['department_approval']));

    // Комендант: `site` без единого набора, и разница — ровно оргтехника (справочник на чтение плюс
    // заявки на обслуживание со стороны заказчика). Ничего сверх неё появиться не должно.
    const commandant = new Set<Permission>(ROLE_PERMISSIONS.commandant);
    const gained = ROLE_PERMISSIONS.site.filter((p) => !commandant.has(p));
    const lost = ROLE_PERMISSIONS.commandant.filter(
      (p) => !new Set<Permission>(ROLE_PERMISSIONS.site).has(p),
    );
    expect(gained.sort()).toEqual([
      'officeEquipment.read',
      'serviceRequests.create',
      'serviceRequests.delete',
      'serviceRequests.files',
      'serviceRequests.read',
      'serviceRequests.update',
    ]);
    expect(lost, 'комендант не должен потерять ни одного права').toEqual([]);
  });

  /**
   * Права кабинета водителя не достались роли `site` ни одним способом — проверка, которую §15 плана
   * требует на **каждом** этапе. Роль новая, объектная и заводится под каталог: попади сюда
   * `driverCabinet.*`, площадка увидела бы задание конкретного работника.
   */
  it('кабинет водителя не приехал ни в роль `site`, ни в один ролевой набор', () => {
    const cabinet: readonly Permission[] = ['driverCabinet.read', 'driverCabinet.submit'];
    for (const permission of cabinet) {
      expect(ROLE_PERMISSIONS.site, permission).not.toContain(permission);
      for (const code of ROLE_GRANT_CODES) {
        expect(ROLE_GRANTS[code].permissions, `${code} → ${permission}`).not.toContain(permission);
      }
    }
  });

  /**
   * Состав набора сам по себе — три барьера набора на всём декартовом произведении «роли × права»,
   * то есть ровно то, что посчитает конструктор при сохранении. Главное здесь — барьер матрицы осей:
   * у `site` ось объектная, и клетки модулей `vehicle` и `weekly` обязаны быть `scoped`. Стой там
   * `forbidden` — набор нельзя было бы завести вовсе, и разбираться пришлось бы с матрицей, а не с
   * составом.
   */
  it('состав каждого набора законен сам по себе, без держателя', () => {
    for (const code of ROLE_GRANT_CODES) {
      const grant = ROLE_GRANTS[code];
      expect(grant.roles, `набор «${code}» не назначить ни одной роли`).not.toEqual([]);
      expect(grant.permissions, `набор «${code}» пуст`).not.toEqual([]);
      const violations = validateGrantAssignment({
        roles: grant.roles,
        permissions: grant.permissions,
        subjectPermissionsAfter: null,
        subjectRole: null,
        grantLabel: grant.name,
      });
      expect(
        violations.map((v) => `[${v.code}] ${v.message}`),
        `состав набора «${code}» не проходит барьеры`,
      ).toEqual([]);
    }
  });

  /**
   * Выдача по итогу — и здесь наборы ведут себя **по-разному**, что и есть проверяемое утверждение.
   *
   * «Заказ техники» и «Виза отдела» выдаются своей роли в одиночку: первый открывает модуль вместе с
   * чтением, у второй чтение уже есть от роли `department`. «Виза объекта» в одиночку выдаче не
   * подлежит — подпись без модуля, который подписывают, — и отказ приходит барьером требований, а не
   * решением формы. Поверх «Заказа техники» она выдаётся: так и собирается `rukstroy`.
   */
  it('«Виза объекта» выдаётся только поверх «Заказа техники», остальные — сами по себе', () => {
    const check = (role: Role, codes: readonly RoleGrantCode[], added: RoleGrantCode) => {
      const after = [
        ...new Set<Permission>([
          ...ROLE_PERMISSIONS[role],
          ...codes.flatMap((code) => [...ROLE_GRANTS[code].permissions]),
        ]),
      ];
      return validateGrantAssignment({
        roles: [role],
        permissions: ROLE_GRANTS[added].permissions,
        subjectPermissionsAfter: after,
        subjectRole: role,
        grantLabel: ROLE_GRANTS[added].name,
      });
    };

    expect(check('site', ['vehicle_ordering'], 'vehicle_ordering').map((v) => v.code)).toEqual([]);
    expect(
      check('department', ['department_approval'], 'department_approval').map((v) => v.code),
    ).toEqual([]);
    // В одиночку — отказ, и он называет недостающее право, а не «недопустимую комбинацию».
    const alone = check('site', ['site_approval'], 'site_approval');
    expect(alone.map((v) => v.code)).toEqual(['requirement_missing', 'requirement_missing']);
    expect(alone.map((v) => v.requires).sort()).toEqual([
      'vehicleRequests.read',
      'weeklyRequests.read',
    ]);
    // Поверх «Заказа техники» — законна: так собирается сегодняшний руководитель строительства.
    expect(
      check('site', ['vehicle_ordering', 'site_approval'], 'site_approval').map((v) => v.code),
    ).toEqual([]);
  });

  /**
   * Набор обязан что-то давать той роли, которой он положен. Ролевая часть каталога заводится ради
   * **различий между ролями**, и право, которое роль-получатель уже имеет от матрицы, означает
   * ошибку в `grant_roles`: перечисли кто-нибудь рядом с `site` ещё и `shtab`, и «Заказ техники»
   * стал бы набором, выдача которого не меняет ничего.
   */
  it('ни одно право ролевых наборов не выдано совместимой роли сегодня', () => {
    for (const code of ROLE_GRANT_CODES) {
      const grant = ROLE_GRANTS[code];
      for (const role of grant.roles) {
        const already = grant.permissions.filter((p) => ROLE_PERMISSIONS[role].includes(p));
        expect(
          already,
          `набор «${code}» ничего не добавляет роли «${role}»: право уже даёт ROLE_PERMISSIONS`,
        ).toEqual([]);
      }
    }
  });

  /** Коды ролевых наборов системные, и администратору под свой набор они не отдаются. */
  it('системные коды не отдаются под пользовательский набор', () => {
    for (const code of ROLE_GRANT_CODES) {
      expect(grantCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});

/**
 * Права системного набора «Оператор (оргтехника)» — выписаны списком, а не взяты из
 * `ROLE_ADDON_PERMISSIONS`. Субъекту на шаге 1c права наборов приходят готовым списком из базы, и
 * тест обязан подставлять их так же: вывод состава из кода надстройки проверял бы мост перехода
 * (это делает блок выше), а не то, что матрица считает по присланному.
 *
 * Порядок здесь — порядок выдачи, и он намеренно не словарный: разница прав показывается словарём
 * (`PERMISSIONS`), и проверка порядка ниже опирается на то, что эти два порядка различны.
 */
const OPERATOR_GRANT: readonly Permission[] = [
  'officeEquipment.write',
  'serviceRequests.assign',
  'serviceRequests.approveEstimate',
  'serviceRequests.status',
];

/**
 * Субъекты с наборами — то, чего в `ACCESS_PROFILES` нет и больше не будет: с произвольной сборкой
 * субъекты перестают быть перечислимыми (§10.1 плана). Поэтому сплошные проверки ниже идут по
 * профилям **плюс** этой горсти: роль, дающая часть прав набора; роль, не дающая ничего из него;
 * исполнитель с контрагентом; учётка без роли.
 */
const GRANT_SUBJECTS: readonly AccessSubject[] = [
  { role: 'shtab', grantPermissions: OPERATOR_GRANT },
  { role: 'manager', grantPermissions: OPERATOR_GRANT },
  { role: 'shtab', addons: ['office_equipment_operator'], grantPermissions: OPERATOR_GRANT },
  { role: 'operator', counterpartyType: 'service', grantPermissions: ['serviceRequests.read'] },
  { role: null, grantPermissions: OPERATOR_GRANT },
];

describe('наборы как четвёртый источник прав', () => {
  /**
   * Само переключение источника: право, которого роль не даёт, приходит списком из базы — и `can`
   * отвечает «да». Роль спрашивать здесь незачем: совместимость набора с ролью стоит там, где права
   * считаются (`grantPermissionsExpr`, соединение с `grant_roles`), и второй гейт в матрице означал
   * бы два ответа на один вопрос.
   */
  it('право из набора даёт `can`, а тот же субъект без набора его не имеет', () => {
    const plain: AccessSubject = { role: 'shtab' };
    const holder: AccessSubject = { role: 'shtab', grantPermissions: OPERATOR_GRANT };
    for (const permission of OPERATOR_GRANT) {
      // Штаб — заказчик заявки: заводит и правит, а решения по ней (кого позвать, согласны ли на
      // смету, принята ли работа) не его. Ради них набор и выдаётся.
      expect(can(plain, permission), permission).toBe(false);
      expect(can(holder, permission), permission).toBe(true);
    }
    // Набор только добавляет (инвариант 1 §8: «отобрать = не выдать»): ни одного своего права штаб
    // с набором не теряет. Обратное означало бы, что порядок источников влияет на ответ.
    for (const permission of permissionsFor(plain)) {
      expect(can(holder, permission), permission).toBe(true);
    }
  });

  /**
   * **Условие совместимости шага, и проверяется оно сплошь.** Поле необязательное, потому что
   * субъектом по-прежнему бывает «роль как есть»: так его собирают `ACCESS_PROFILES`, тесты матрицы
   * и портал до переключения `/auth/me` на эффективные права. Три написания отсутствия — поля нет,
   * `null`, пустой список — обязаны давать один ответ: разойдись хоть одно, и часть вызовов `can`
   * начала бы считать иначе, чем остальные, причём незаметно.
   */
  it('субъект без набора считается как раньше — на всех профилях и всех правах', () => {
    for (const profile of ACCESS_PROFILES) {
      for (const permission of PERMISSIONS) {
        const label = `${accessProfileLabel(profile)}: ${permission}`;
        const answer = can(profile, permission);
        expect(can({ ...profile, grantPermissions: undefined }, permission), label).toBe(answer);
        expect(can({ ...profile, grantPermissions: null }, permission), label).toBe(answer);
        expect(can({ ...profile, grantPermissions: [] }, permission), label).toBe(answer);
        // И ни одного источника «набор» там, где наборов нет: витрина, объясняющая доступ выдачей,
        // которой не было, хуже витрины без выдач вовсе.
        expect(
          permissionSources(profile, permission).every((origin) => origin.kind !== 'grant'),
          label,
        ).toBe(true);
      }
    }
  });

  /**
   * Учётка без роли для портала — никто, и набор этого не меняет. Правило то же, что в SQL: при
   * `users.role IS NULL` соединение с `grant_roles` не выполняется ни для одной строки, прав нет
   * вовсе. Ответь матрица иначе — неактивированная учётка получила бы доступ по одной выдаче.
   */
  it('без роли набор не даёт ничего', () => {
    for (const permission of PERMISSIONS) {
      expect(can({ role: null, grantPermissions: OPERATOR_GRANT }, permission), permission).toBe(
        false,
      );
      expect(
        permissionSources({ role: null, grantPermissions: OPERATOR_GRANT }, permission),
        permission,
      ).toEqual([]);
    }
  });
});

describe('источники права перечисляются все', () => {
  /**
   * Главная проверка множественной функции: совпадение источников — норма, а не ошибка, и назвать
   * обязаны каждый. «Первый найденный» здесь отвечает не неточно, а неверно: по нему нельзя считать
   * последствия отзыва — снятие набора отбирает право только если его не даёт больше никто.
   */
  it('роль и набор на одном праве дают два источника, а не один', () => {
    // Премиса: у менеджера это право ролевое. Уйди оно из роли — проверка прошла бы, перестав
    // проверять то, ради чего написана.
    expect(ROLE_PERMISSIONS.manager).toContain('officeEquipment.write');
    expect(
      permissionSources(
        { role: 'manager', grantPermissions: ['officeEquipment.write'] },
        'officeEquipment.write',
      ),
    ).toEqual([{ kind: 'role' }, { kind: 'grant' }]);
  });

  /**
   * Двойная запись шагов 1a–1d: одна и та же выдача видна и надстройкой, и набором. Совпадение
   * старого источника с новым — свойство перехода, и оба обязаны называть себя; витрина по такому
   * субъекту объясняет, что снятие надстройки доступа не изменит.
   */
  it('надстройка и набор перехода называют себя оба', () => {
    expect(
      permissionSources(
        {
          role: 'shtab',
          addons: ['office_equipment_operator'],
          grantPermissions: ['serviceRequests.assign'],
        },
        'serviceRequests.assign',
      ),
    ).toEqual([{ kind: 'addon', addon: 'office_equipment_operator' }, { kind: 'grant' }]);
  });

  /**
   * Порядок источников — тот же, что в `can`: роль → надстройки → наборы → контрагент. Тип
   * контрагента спрашивается последним, а не первым по признаку «это же его модуль», и порядок этот
   * читается витриной как «чем право объясняется в первую очередь».
   */
  it('тип контрагента идёт после набора', () => {
    expect(
      permissionSources(
        {
          role: 'operator',
          counterpartyType: 'operator',
          grantPermissions: ['wasteRequests.status'],
        },
        'wasteRequests.status',
      ),
    ).toEqual([{ kind: 'grant' }, { kind: 'counterparty' }]);
  });

  /**
   * Несовместимая с ролью надстройка источником не становится и на шаге 1c: гейт `canAttachAddon`
   * остаётся на месте до 1e. Набор в этом же месте роль не спрашивает — но не потому, что гейта нет,
   * а потому, что он стоит в SQL, и подставленный тестом список означает «сервер его уже пропустил».
   */
  it('надстройка чужой роли источником не считается', () => {
    expect(
      permissionSources(
        { role: 'commandant', addons: ['office_equipment_operator'] },
        'officeEquipment.write',
      ),
    ).toEqual([]);
  });

  /**
   * Источники есть ровно там, где право есть. Та же проверка, что в `permission-catalog.test.ts`, но
   * на субъектах с наборами: источник без права — витрина, объясняющая несуществующий доступ; право
   * без источника — прочерк в карточке там, где доступ есть.
   */
  it('пустой список источников ровно там, где нет права', () => {
    for (const subject of [...ACCESS_PROFILES, ...GRANT_SUBJECTS]) {
      for (const permission of PERMISSIONS) {
        const label = `${accessProfileLabel(subject)}: ${permission}`;
        expect(permissionSources(subject, permission).length > 0, label).toBe(
          can(subject, permission),
        );
      }
    }
  });

  /**
   * Единственное число сохранено обёрткой над первым элементом, и это условие шага: её зовут
   * карточка доступа портала и тест витрины, а шаг 1c переключает источник, а не читателей. Обёртка
   * обязана совпадать с первым источником на **любом** субъекте — вторая реализация того же порядка
   * разъехалась бы с первой при первой правке модели.
   */
  it('единственное число — ровно первый из перечисленных источников', () => {
    for (const subject of [...ACCESS_PROFILES, ...GRANT_SUBJECTS]) {
      for (const permission of PERMISSIONS) {
        const label = `${accessProfileLabel(subject)}: ${permission}`;
        expect(permissionSource(subject, permission), label).toEqual(
          permissionSources(subject, permission)[0] ?? null,
        );
      }
    }
    // Роль спрашивается первой, поэтому общее с набором право карточка по-прежнему объясняет
    // должностью — ответ старых читателей на прежнем субъекте не меняется вовсе.
    expect(
      permissionSource(
        { role: 'manager', grantPermissions: ['officeEquipment.write'] },
        'officeEquipment.write',
      ),
    ).toEqual({ kind: 'role' });
  });
});

describe('разница эффективных прав', () => {
  /**
   * Выдача набора: добавляется только то, чего у субъекта не было. Порядок — словарный, а не тот, в
   * котором права пришли в наборе: предпросмотр читают глазами, и строки в нём не должны
   * переставляться от того, в каком порядке отмечали галочки.
   */
  it('выдача показывает добавленное в словарном порядке', () => {
    const before: AccessSubject = { role: 'shtab' };
    const after: AccessSubject = { ...before, grantPermissions: OPERATOR_GRANT };
    expect(effectiveDelta(before, after)).toEqual({
      added: [
        'serviceRequests.assign',
        'serviceRequests.approveEstimate',
        'serviceRequests.status',
        'officeEquipment.write',
      ],
      removed: [],
    });
  });

  /**
   * **То, ради чего функция и заведена.** Отзыв набора отбирает право только если его не даёт больше
   * никто. Предпросмотр, считающий разницу списков наборов, показал бы держателю роли «Менеджер»
   * уход `officeEquipment.write` — то есть напугал бы отзывом, ничего не меняющим.
   */
  it('снятие набора отбирает право только если его не даёт больше никто', () => {
    const holder: AccessSubject = {
      role: 'manager',
      grantPermissions: ['officeEquipment.write', 'serviceRequests.assign'],
    };
    expect(effectiveDelta(holder, { ...holder, grantPermissions: [] })).toEqual({
      added: [],
      removed: ['serviceRequests.assign'],
    });
  });

  /**
   * Пока действует двойная запись, ни один из двух источников не единственный, и отзыв любого из них
   * доступа не меняет. Это и есть свойство, ради которого шаги 1c и 1d разведены: откат на версию,
   * читающую надстройки, безопасен, потому что оба источника дают одно и то же.
   */
  it('при двойной записи отзыв любого из двух источников доступа не меняет', () => {
    const both: AccessSubject = {
      role: 'shtab',
      addons: ['office_equipment_operator'],
      grantPermissions: OPERATOR_GRANT,
    };
    expect(effectiveDelta(both, { ...both, grantPermissions: [] })).toEqual({
      added: [],
      removed: [],
    });
    expect(effectiveDelta(both, { ...both, addons: [] })).toEqual({ added: [], removed: [] });
  });

  /**
   * Замена одного набора другим — разница, а не объединение: общее право не показывается ни в одном
   * списке. Субъект сам с собой даёт пустоту: предпросмотр «ничего не изменится» обязан быть пустым,
   * а не перечислять весь набор.
   */
  it('замена набора показывает только разницу', () => {
    const before: AccessSubject = {
      role: 'shtab',
      grantPermissions: ['serviceRequests.assign', 'serviceRequests.status'],
    };
    const after: AccessSubject = {
      role: 'shtab',
      grantPermissions: ['serviceRequests.status', 'serviceRequests.approveIt'],
    };
    expect(effectiveDelta(before, after)).toEqual({
      added: ['serviceRequests.approveIt'],
      removed: ['serviceRequests.assign'],
    });
    expect(effectiveDelta(before, before)).toEqual({ added: [], removed: [] });
  });

  /**
   * Крайние случаи предпросмотра. Назначение роли — тоже переход состояния субъекта, и разница
   * обязана показать все её права; отсутствующий субъект по обе стороны — пустоту, а не падение;
   * набор без роли — пустоту, а не права набора (иначе предпросмотр обещал бы доступ, которого
   * неактивированная учётка не получит).
   */
  it('назначение роли, отсутствие субъекта и набор без роли', () => {
    expect(effectiveDelta({ role: null }, { role: 'commandant' })).toEqual({
      added: [...permissionsFor({ role: 'commandant' })],
      removed: [],
    });
    expect(effectiveDelta(null, undefined)).toEqual({ added: [], removed: [] });
    expect(
      effectiveDelta({ role: null }, { role: null, grantPermissions: OPERATOR_GRANT }),
    ).toEqual({ added: [], removed: [] });
  });
});

/**
 * Ось каждой роли — вторым списком, как и невыдаваемые права выше, и по той же причине: сравнение
 * матрицы с самой собой не поймало бы ничего. `Record<Role, …>` при этом не даст забыть новую роль,
 * а забытая роль — это самый дорогой промах барьера: её ось выведется в `none`, где вся строка
 * матрицы `global`, и проверка выдачи выключится ровно для той роли, которую заводили.
 */
const EXPECTED_AXIS: Record<Role, RoleScopeAxis> = {
  admin: 'none',
  manager: 'none',
  dispatcher: 'none',
  shtab: 'object',
  rukstroy: 'object',
  commandant: 'object',
  // Площадка (ADR 0112): объектная ось — то, ради чего роль вообще заведена ролью, а не набором
  // (§11 плана — «роль вводится, когда появляется новая ось либо должность с глобальной областью»).
  // Ось у неё та же, что у трёх ролей, которые она заменит: наследуется не имя, а способ ограничения.
  site: 'object',
  department: 'department',
  department_head: 'department',
  operator: 'counterparty',
  observer: 'none',
  driver: 'person',
  mechanic: 'none',
  chief_mechanic: 'none',
};

/**
 * Оси, которые слой области **действительно** фильтрует, — выписаны по `apps/api/src/lib/access.ts`
 * с именами функций. Это и есть проверка «`forbidden` стоит там, где предиката нет»: матрица
 * утверждает решение, а этот список — факт, и разойтись они обязаны падением.
 *
 * Модуля, которого нет ни здесь, ни в `UNSCOPED_MODULES`, быть не может — полнота проверяется ниже:
 * новый модуль витрины обязан получить ответ «где у него область», а не унаследовать чужой.
 */
const SCOPED_AXES_BY_MODULE: Partial<Record<PermissionModule, readonly RoleScopeAxis[]>> = {
  // wasteRequestVisibilityWhere + assertWasteObjectScope (объект, площадка отдела), operatorVisibilityWhere.
  waste: ['object', 'department', 'counterparty'],
  // vehicleRequestVisibilityWhere + assertRequestScope, lessorVisibilityWhere.
  vehicle: ['object', 'department', 'counterparty'],
  // weeklyRequestReadScope + assertWeeklyRequestScope: обе площадочные оси и арендодатель.
  weekly: ['object', 'department', 'counterparty'],
  // serviceRequestScopeWhere + assertServiceRequestScope, serviceExecutorVisibilityWhere.
  service: ['object', 'department', 'counterparty'],
  // officeEquipmentScopeWhere + assertOfficeEquipmentScope — только две площадочные оси: ветки
  // контрагента у предиката нет вовсе (ADR 0085: «его» техника в справочнике ничем не отмечена).
  officeEquipment: ['object', 'department'],
};

/**
 * Модули, у которых предиката области нет ни для одной оси: маршрут закрыт правом и больше ничем.
 * Проверено чтением — `routes/garage.ts`, `routes/vehicle-readings.ts`, `routes/vehicle-maintenance.ts`,
 * `routes/drivers.ts`, `routes/waybills.ts`, `routes/audit.ts`, `routes/admin-mailings.ts` спрашивают
 * только `requirePermission`; у архива слепа ручка возврата (`/:id/restore` у заявок вывоза и заказов
 * ТС поднимает строку по id без проверки области), у файлов `files.manageAny` означает обход владения.
 * У руководств предиката нет и быть не по чему: в `app_manuals` нет колонки, по которой список
 * можно сузить, — он один на компанию (`docs/manuals-plan.md` §3.1).
 */
const UNSCOPED_MODULES: readonly PermissionModule[] = [
  'directories',
  'drivers',
  'waybills',
  'garage',
  'driverCabinet',
  'vehicleReadings',
  'vehicleMaintenance',
  'records',
  'files',
  'manuals',
  'admin',
];

/**
 * Единственный модуль без предиката, где вместо запрета стоит `global`, — и это не послабление, а
 * второй смысл: справочники не делятся ни по объектам, ни по отделам, такой колонки в схеме нет
 * вовсе, а `directories.read` сегодня есть у каждой роли с осью. Запрет здесь означал бы «нельзя
 * выдать доступ к данным, которые роль и так видит».
 */
const GLOBAL_WITHOUT_PREDICATE: readonly PermissionModule[] = ['directories'];

/** Оси, у которых область есть, — то есть все, кроме «своей оси нет». */
const REAL_AXES: readonly RoleScopeAxis[] = ROLE_SCOPE_AXES.filter((axis) => axis !== 'none');

describe('матрица «ось роли × модуль»', () => {
  /**
   * Полнота обеих осей таблицы. Компилятор её и так требует (`Record` по модулям и по осям), но
   * условие это про данные: `Object.keys` ловит лишний ключ, оставшийся от переименованного модуля,
   * а перебор — клетку, заполненную чем-то вне трёх значений. Заодно проверяется, что все три
   * значения в таблице встречаются: матрица, выродившаяся в один `forbidden`, прошла бы любую
   * проверку полноты и запретила бы реформу целиком.
   */
  it('у каждой пары «ось × модуль» есть решение, и все три значения в ходу', () => {
    expect(Object.keys(GRANT_SCOPE_MATRIX).sort()).toEqual([...PERMISSION_MODULES].sort());
    const seen = new Set<GrantScopeRule>();
    for (const module of PERMISSION_MODULES) {
      const row = GRANT_SCOPE_MATRIX[module];
      expect(Object.keys(row).sort(), module).toEqual([...ROLE_SCOPE_AXES].sort());
      for (const axis of ROLE_SCOPE_AXES) {
        expect(['scoped', 'global', 'forbidden'], `${module} × ${axis}`).toContain(row[axis]);
        seen.add(row[axis]);
      }
    }
    expect(seen).toEqual(new Set<GrantScopeRule>(['scoped', 'global', 'forbidden']));
  });

  /**
   * Ось роли считается витринным `scopeAxisOf`, и это осознанное переиспользование: классификация
   * ролей по осям обязана быть одна на портал и на выдачу. Тест — цена этого решения: он держит
   * витрину на месте, сверяя её ответ со списками `*_SCOPED_ROLES` из `enums.ts`, по которым API
   * требует область при активации. Съедь одна роль в `none` — и барьер для неё выключится молча.
   */
  it('ось каждой роли — та же, что в списках `*_SCOPED_ROLES`', () => {
    for (const role of ROLES) {
      expect(roleScopeAxis(role), role).toBe(EXPECTED_AXIS[role]);
    }
    for (const role of OBJECT_SCOPED_ROLES) expect(roleScopeAxis(role), role).toBe('object');
    for (const role of DEPARTMENT_SCOPED_ROLES) {
      expect(roleScopeAxis(role), role).toBe('department');
    }
    for (const role of COUNTERPARTY_SCOPED_ROLES) {
      expect(roleScopeAxis(role), role).toBe('counterparty');
    }
    for (const role of PERSON_SCOPED_ROLES) expect(roleScopeAxis(role), role).toBe('person');
    // Роль без своей оси — тоже решение, а не остаток: `none` означает «ограничивать нечем», и
    // именно эта строка матрицы разрешает наборы диспетчеру, менеджеру и службе главного механика.
    const withAxis = new Set<string>([
      ...OBJECT_SCOPED_ROLES,
      ...DEPARTMENT_SCOPED_ROLES,
      ...COUNTERPARTY_SCOPED_ROLES,
      ...PERSON_SCOPED_ROLES,
    ]);
    for (const role of ROLES) {
      if (withAxis.has(role)) continue;
      expect(roleScopeAxis(role), role).toBe('none');
    }
  });

  /**
   * **Главная проверка матрицы: `scoped` стоит там и только там, где предикат есть.** Клетка
   * `scoped` — это обещание «набор увидит своё»; поставленная модулю без фильтрации, она открывает
   * данные всей компании и делает это молча, потому что отказа не будет вовсе.
   *
   * Полнота списков проверяется первой: модуль, не попавший ни в один из двух, означает, что решение
   * про него не принимали, — и тест обязан упасть до сравнения, а не согласиться с молчанием.
   */
  it('`scoped` стоит там и только там, где в слое области есть предикат', () => {
    for (const module of PERMISSION_MODULES) {
      const scopedAxes = SCOPED_AXES_BY_MODULE[module];
      const unscoped = UNSCOPED_MODULES.includes(module);
      expect(
        (scopedAxes ? 1 : 0) + (unscoped ? 1 : 0),
        `модуль «${module}» не отнесён ни к одному из двух списков (или отнесён к обоим)`,
      ).toBe(1);
      for (const axis of ROLE_SCOPE_AXES) {
        expect(GRANT_SCOPE_MATRIX[module][axis] === 'scoped', `${module} × ${axis}`).toBe(
          (scopedAxes ?? []).includes(axis),
        );
      }
    }
  });

  /**
   * Обратная сторона того же условия: у модуля без предиката все четыре живые оси закрыты. Ровно
   * это и есть инвариант 4 плана — «либо запретить выдачу ролям с осью, либо сначала написать сам
   * предикат», — и `global` в такой клетке был бы третьим, несуществующим вариантом: «выдать и
   * надеяться».
   *
   * Исключение одно и названо явно (`GLOBAL_WITHOUT_PREDICATE`): справочник делить нечем. Список
   * исключений в тесте, а не флаг в матрице, потому что каждое новое исключение обязано пройти через
   * этот файл — то есть быть замеченным.
   */
  it('модуль без предиката закрыт для всех четырёх осей с областью', () => {
    for (const module of UNSCOPED_MODULES) {
      if (GLOBAL_WITHOUT_PREDICATE.includes(module)) continue;
      for (const axis of REAL_AXES) {
        expect(GRANT_SCOPE_MATRIX[module][axis], `${module} × ${axis}`).toBe('forbidden');
      }
    }
    // Справочник: три оси общие, а водителю — запрет (у роли `driver` нет `directories.read`
    // намеренно, ADR 0102: ответы кабинета самодостаточны).
    expect(GRANT_SCOPE_MATRIX.directories).toEqual({
      object: 'global',
      department: 'global',
      counterparty: 'global',
      person: 'forbidden',
      none: 'global',
    });
    // Строка `none` — `global` всюду, кроме кабинета: роль без оси не ограничена ничем по
    // построению, и запрет ей означал бы отказ от реформы для диспетчера и менеджера.
    for (const module of PERMISSION_MODULES) {
      expect(GRANT_SCOPE_MATRIX[module].none, module).toBe(
        module === 'driverCabinet' ? 'forbidden' : 'global',
      );
    }
    // Ось `person` — это ровно роль `driver`, а ей наборы не выдаются вовсе: строка запрещена
    // целиком, и `scoped` в ней утверждал бы, что водителю есть куда что-то выдать.
    for (const module of PERMISSION_MODULES) {
      expect(GRANT_SCOPE_MATRIX[module].person, module).toBe('forbidden');
    }
  });

  /**
   * **Матрица не спорит с уже открытыми данными.** `forbidden` в клетке, где роль с этой осью право
   * уже имеет, — не защита, а ошибка: запрет на выдачу того, что роль видит и без набора, отказал бы
   * администратору в наборе, ничего при этом не закрыв.
   *
   * Перебор идёт по `ACCESS_PROFILES`, то есть заодно по типам контрагента и по обеим действующим
   * надстройкам — а надстройки и есть два системных набора шага 1a. Тем самым проверяется и то, что
   * матрица пропускает две выдачи, которые уже работают в проде.
   *
   * Роль `driver` исключена, и это не оговорка ради теста: ей наборы не выдаются ни одним способом
   * (барьер 2), а права кабинета приходят от роли, мимо всякой выдачи. По той же причине из перебора
   * выпадают невыдаваемые права — до матрицы они не доходят вовсе, их снимает барьер 1, и перебор
   * обязан повторять порядок проверки, а не спорить с ним. Иначе тест требовал бы разрешить
   * администратору кабинет, который у него есть по роли и который набором не выдаётся никому.
   */
  it('матрица не запрещает того, что роль с осью уже видит', () => {
    for (const profile of ACCESS_PROFILES) {
      const role = profile.role;
      if (!role || role === 'driver') continue;
      for (const permission of permissionsFor(profile)) {
        if (!isGrantable(permission)) continue;
        const { module } = PERMISSION_CATALOG[permission];
        expect(
          grantScopeRule(role, module),
          `${accessProfileLabel(profile)} уже имеет ${permission} (модуль «${module}»)`,
        ).not.toBe('forbidden');
      }
    }
  });

  /**
   * Клетки, названные планом и ADR поимённо. Сплошные проверки выше согласны с любой самосогласованной
   * таблицей; эти четыре строки говорят, что таблица — именно та, о которой шла речь.
   */
  it('клетки из плана и ADR стоят там, где обещано', () => {
    // Инвариант 4 плана §8 дословно: путевые листы и гараж роли с объектной осью не выдаются.
    expect(grantScopeRule('shtab', 'waybills')).toBe('forbidden');
    expect(grantScopeRule('shtab', 'garage')).toBe('forbidden');
    // ADR 0085: справочника оргтехники у сервисной компании нет намеренно — пометить «свою» технику
    // в схеме нечем, и право означало бы весь парк компании.
    expect(grantScopeRule('operator', 'officeEquipment')).toBe('forbidden');
    // А площадке и отделу тот же справочник выдаётся: у него есть предикат обеих площадочных осей.
    expect(grantScopeRule('shtab', 'officeEquipment')).toBe('scoped');
    expect(grantScopeRule('department_head', 'officeEquipment')).toBe('scoped');
    // Те же листы диспетчеру — законны: своей оси у роли нет, сужать нечего.
    expect(grantScopeRule('dispatcher', 'waybills')).toBe('global');
    // Будущие «Аудитор» и «Рассылки» (§10 плана) уходят ролям без оси, и это условие реформы.
    expect(grantScopeRule('shtab', 'admin')).toBe('forbidden');
    expect(grantScopeRule('dispatcher', 'admin')).toBe('global');
    // Кабинет — единственный столбец без единого разрешения: второй замок к невыдаваемым правам.
    for (const axis of ROLE_SCOPE_AXES) {
      expect(GRANT_SCOPE_MATRIX.driverCabinet[axis], axis).toBe('forbidden');
    }
  });
});

/** Коды нарушений подряд — по ним читаются проверки ниже, и порядок в них тоже значим. */
const codesOf = (violations: readonly GrantViolation[]): readonly GrantViolationCode[] =>
  violations.map((violation) => violation.code);

/** Итоговые права субъекта: то, что вернёт `can` после операции, — роль плюс выданное. */
const effectiveAfter = (
  subject: AccessSubject,
  granted: readonly Permission[] = [],
): readonly Permission[] => [...new Set<Permission>([...permissionsFor(subject), ...granted])];

describe('единая проверка выдачи', () => {
  /**
   * Законная выдача проходит целиком — и проверяется это на **действующем** системном наборе, а не
   * на выдуманном: «Оператор (оргтехника)» с его настоящими базовыми ролями. Тест, у которого
   * законных выдач нет, доказывает работоспособность запрета, но не проверку: функция,
   * возвращающая нарушение всегда, прошла бы все остальные проверки этого блока.
   */
  it('системный набор своим базовым ролям проходит без нарушений', () => {
    for (const role of ROLE_ADDON_BASE_ROLES.office_equipment_operator) {
      expect(
        validateGrantAssignment({
          roles: [...ROLE_ADDON_BASE_ROLES.office_equipment_operator],
          permissions: OPERATOR_GRANT,
          subjectRole: role,
          subjectPermissionsAfter: effectiveAfter({ role }, OPERATOR_GRANT),
          grantLabel: 'Оператор (оргтехника)',
        }),
        role,
      ).toEqual([]);
    }
    // Будущий «Аудитор» (§10 плана) — набор из одного входного права роли без оси: журнал действий
    // открывается своим чтением, а не общим `users.manage` модуля витрины.
    expect(
      validateGrantAssignment({
        roles: ['dispatcher', 'manager'],
        permissions: ['audit.read'],
        subjectRole: 'dispatcher',
        subjectPermissionsAfter: effectiveAfter({ role: 'dispatcher' }, ['audit.read']),
        grantLabel: 'Аудитор',
      }),
    ).toEqual([]);
  });

  /**
   * Барьер 1 — невыдаваемое право. Вторая половина проверки важнее первой: `users.manage` лежит в
   * модуле `admin`, запрещённом объектной оси, то есть попадает сразу под два барьера. Названо
   * должно быть одно нарушение — то, которое человек может устранить: «это право не выдаётся
   * вовсе». Список из двух отказов на одну галочку читается как ошибка сервера.
   */
  it('невыдаваемое право названо один раз и не дублируется матрицей', () => {
    const violations = validateGrantAssignment({
      roles: ['shtab'],
      permissions: ['users.manage'],
      subjectRole: 'shtab',
      subjectPermissionsAfter: null,
    });
    expect(codesOf(violations)).toEqual(['permission_not_grantable']);
    expect(violations[0]!.permission).toBe('users.manage');
    expect(violations[0]!.message).toContain('users.manage');
    // Все пять — по разу каждое, ни одного пропущенного: список запрета и проверка выдачи обязаны
    // отвечать одинаково, иначе форма покажет чекбокс, который сервер отклонит.
    const all = validateGrantAssignment({
      roles: ['dispatcher'],
      permissions: [...NON_GRANTABLE_PERMISSIONS],
      subjectRole: 'dispatcher',
      subjectPermissionsAfter: null,
    });
    expect(codesOf(all)).toEqual(NON_GRANTABLE_PERMISSIONS.map(() => 'permission_not_grantable'));
    expect(all.map((violation) => violation.permission)).toEqual([...NON_GRANTABLE_PERMISSIONS]);
  });

  /**
   * Барьер 2 — роль `driver`. Отказ ей целиком, и клетки матрицы вдогонку не перечисляются: набор
   * из десяти прав дал бы одиннадцать строк отказа, из которых главная утонула бы. Проверяется это
   * прямо: то же право той же роли — одно нарушение, а рядом с площадочной ролью — два разных.
   */
  it('роль «Водитель» отклоняется целиком, а не клетка за клеткой', () => {
    expect(
      codesOf(
        validateGrantAssignment({
          roles: ['driver'],
          permissions: ['waybills.read', 'garage.read', 'directories.read'],
          subjectRole: 'driver',
          subjectPermissionsAfter: null,
        }),
      ),
    ).toEqual(['role_not_grantable']);
    // Законная роль в том же наборе проверяется своим порядком: отказ водителю не отменяет разбора
    // остальных, иначе набор «для площадки и водителя» сохранялся бы после снятия одной роли.
    expect(
      codesOf(
        validateGrantAssignment({
          roles: ['driver', 'shtab', 'dispatcher'],
          permissions: ['waybills.read'],
          subjectRole: 'shtab',
          subjectPermissionsAfter: null,
        }),
      ),
    ).toEqual(['role_not_grantable', 'module_forbidden_for_axis']);
  });

  /**
   * Барьер 3 — декартово произведение против матрицы. Тот самый случай плана: набор с
   * `waybills.read`, выданный площадке, открыл бы листы всей компании. Проверяется и текст: отказ
   * обязан называть право, роль и модуль, а не «недопустимую комбинацию» — по такому сообщению
   * администратор не поймёт, какую галочку снимать.
   */
  it('право модуля без области отклоняется каждой ролью с осью — и текст называет виновников', () => {
    const violations = validateGrantAssignment({
      roles: ['shtab', 'rukstroy', 'dispatcher'],
      permissions: ['waybills.read', 'garage.read'],
      subjectRole: 'shtab',
      subjectPermissionsAfter: null,
      grantLabel: 'Журнал листов',
    });
    // Две роли с осью × два права = четыре нарушения; диспетчер законен и в списке не появляется.
    expect(codesOf(violations)).toEqual([
      'module_forbidden_for_axis',
      'module_forbidden_for_axis',
      'module_forbidden_for_axis',
      'module_forbidden_for_axis',
    ]);
    expect(violations.map((violation) => `${violation.role}:${violation.permission}`)).toEqual([
      'shtab:waybills.read',
      'shtab:garage.read',
      'rukstroy:waybills.read',
      'rukstroy:garage.read',
    ]);
    const first = violations[0]!;
    expect(first.message).toContain('Журнал листов');
    expect(first.message).toContain('waybills.read');
    expect(first.message).toContain('Штаб');
    expect(first.message).toContain('Путевые листы');
    expect(first.message).toContain('объекты строительства');
    // Тот же набор ролям без оси законен: сужать нечего, и запрет был бы отказом без причины.
    expect(
      validateGrantAssignment({
        roles: ['dispatcher', 'manager', 'chief_mechanic'],
        permissions: ['waybills.read', 'garage.read'],
        subjectRole: 'dispatcher',
        subjectPermissionsAfter: null,
      }),
    ).toEqual([]);
  });

  /**
   * Барьер 4 — «модуль закрывается чтением», и проверяется он **по итогу**. Один и тот же набор
   * законен одному субъекту и незаконен другому: штаб заказы видит и ход им двигать может, комендант
   * заказов не видит вовсе — у него `vehicleRequests.status` открыл бы прямой вызов смены статуса
   * без раздела (ADR 0021, §13.1). Проверяй мы состав набора, отклонены были бы оба — включая
   * действующий системный «Оператор (оргтехника)», который так и устроен.
   */
  it('требование прав проверяется по итогу субъекта, а не внутри набора', () => {
    const grant: readonly Permission[] = ['vehicleRequests.status'];
    expect(
      validateGrantAssignment({
        roles: ['shtab', 'commandant'],
        permissions: grant,
        subjectRole: 'shtab',
        subjectPermissionsAfter: effectiveAfter({ role: 'shtab' }, grant),
      }),
    ).toEqual([]);
    const violations = validateGrantAssignment({
      roles: ['shtab', 'commandant'],
      permissions: grant,
      subjectRole: 'commandant',
      subjectPermissionsAfter: effectiveAfter({ role: 'commandant' }, grant),
    });
    expect(codesOf(violations)).toEqual(['requirement_missing']);
    expect(violations[0]!.permission).toBe('vehicleRequests.status');
    expect(violations[0]!.requires).toBe('vehicleRequests.read');
    expect(violations[0]!.message).toContain('vehicleRequests.read');
    expect(violations[0]!.message).toContain('Заказ ТС');
    // Обратный порядок тех же прав в итоге ничего не меняет: требование — свойство множества, а
    // порядок нарушений задаёт словарь `PERMISSIONS`, а не то, как права пришли.
    expect(
      codesOf(
        validateGrantAssignment({
          roles: [],
          permissions: [],
          subjectRole: 'chief_mechanic',
          subjectPermissionsAfter: ['waybills.cancel'],
        }),
      ),
    ).toEqual(['requirement_missing']);
  });

  /**
   * Барьер 5 — разделение обязанностей по итогу. Пара собирается из двух источников (роль дала
   * составление сметы, набор — её утверждение), и внутри набора её не видно вовсе.
   */
  it('конфликт обязанностей находится в итоге, собранном из двух источников', () => {
    const violations = validateGrantAssignment({
      roles: ['dispatcher'],
      permissions: ['serviceRequests.approveEstimate'],
      subjectRole: 'dispatcher',
      subjectPermissionsAfter: [
        'serviceRequests.read',
        'serviceRequests.estimate',
        'serviceRequests.approveEstimate',
      ],
      grantLabel: 'Согласование сметы',
    });
    expect(codesOf(violations)).toEqual(['duty_conflict']);
    expect(violations[0]!.conflict).toBe(GRANT_CONFLICTS[0]);
    expect(violations[0]!.message).toContain(GRANT_CONFLICTS[0]!.reason);
    expect(violations[0]!.message).toContain('Согласование сметы');
    // Та же проверка, что у `conflictingPermissions`, и первая названная пара обязана совпадать:
    // два ответа на один вопрос означали бы, что форма и сервер запрещают разное.
    expect(violations[0]!.conflict).toBe(
      conflictingPermissions([
        'serviceRequests.read',
        'serviceRequests.estimate',
        'serviceRequests.approveEstimate',
      ]),
    );
  });

  /**
   * **Оговорка об администраторе — по роли, и только по ней.** У `admin` весь словарь, то есть обе
   * запрещённые пары есть у него всегда; без оговорки любая операция над его учёткой отклонялась бы
   * отказом, который никто не может устранить.
   *
   * Вторая половина теста — прямая проверка того, что отвергнутая планом формулировка **не**
   * реализована. Исполнитель-подрядчик с полным модулем обслуживания на руках обязан получить
   * конфликт: правило «у кого есть весь модуль — того не проверяем» выключало бы проверку ровно в
   * той операции, которая дособирает модуль и создаёт пару (§13.1).
   */
  it('администратор освобождён от конфликтов, а «весь модуль» не освобождает никого', () => {
    expect(
      validateGrantAssignment({
        roles: [],
        permissions: [],
        subjectRole: 'admin',
        subjectPermissionsAfter: [...PERMISSIONS],
      }),
    ).toEqual([]);
    // Тот же итог у не-администратора — два конфликта: обе пары таблицы налицо.
    expect(
      codesOf(
        validateGrantAssignment({
          roles: [],
          permissions: [],
          subjectRole: 'dispatcher',
          subjectPermissionsAfter: [...PERMISSIONS],
        }),
      ),
    ).toEqual(['duty_conflict', 'duty_conflict']);
    // Весь модуль обслуживания у сервисной компании: четыре права из десяти у неё уже есть по типу
    // контрагента, остальные шесть не защищены — набор вправе выдать их разом.
    const wholeModule = PERMISSIONS_BY_MODULE.service;
    expect(wholeModule.length).toBe(10);
    expect(
      codesOf(
        validateGrantAssignment({
          roles: ['operator'],
          permissions: [],
          subjectRole: 'operator',
          subjectPermissionsAfter: [...wholeModule],
        }),
      ),
    ).toEqual(['duty_conflict', 'duty_conflict']);
  });

  /**
   * Все пять барьеров сразу — в объявленном порядке: сначала свойства набора (право → роль → пары
   * «роль × право»), затем свойства итога. Порядок проверяется, потому что по нему читают отказ:
   * первым администратор видит то, что мешает сохранить набор вовсе, а не последствия у одного
   * держателя.
   */
  it('нарушения перечисляются все и в объявленном порядке', () => {
    const violations = validateGrantAssignment({
      roles: ['driver', 'shtab'],
      permissions: ['users.manage', 'waybills.read'],
      subjectRole: 'shtab',
      subjectPermissionsAfter: [
        'waybills.cancel',
        'serviceRequests.estimate',
        'serviceRequests.approveEstimate',
      ],
      grantLabel: 'Сборный',
    });
    expect(codesOf(violations)).toEqual([
      'permission_not_grantable',
      'role_not_grantable',
      'module_forbidden_for_axis',
      'requirement_missing',
      'duty_conflict',
    ]);
    // Каждое нарушение объясняет себя человеку и называет виновника кодом права там, где право есть.
    for (const violation of violations) {
      expect(violation.message.trim(), violation.code).not.toBe('');
      expect(violation.message, violation.code).toContain('Сборный');
      if (violation.permission) {
        expect(violation.message, violation.code).toContain(violation.permission);
      }
    }
  });

  /**
   * `subjectPermissionsAfter: null` — «операции над учёткой в этом вызове нет»: так конструктор
   * сохраняет состав набора, который ещё никому не выдан. Барьеры набора при этом работают
   * полностью, барьеры итога молчат — и молчат именно потому, что итога не существует, а не потому,
   * что их забыли позвать. Поле объявлено обязательным ровно ради этой разницы.
   */
  it('без итога проверяются барьеры набора, а барьеры итога молчат', () => {
    expect(
      codesOf(
        validateGrantAssignment({
          roles: ['driver', 'shtab'],
          permissions: ['users.manage', 'waybills.read'],
          subjectRole: null,
          subjectPermissionsAfter: null,
        }),
      ),
    ).toEqual(['permission_not_grantable', 'role_not_grantable', 'module_forbidden_for_axis']);
  });

  /**
   * Крайние случаи. Пустой вход законен (набор без прав ничего не открывает, набор без ролей никому
   * не выдаётся), дубликаты в форме — одно нарушение, а не два, и функция не бросает ни на чём:
   * отказ — это данные, которые возвращают, а не исключение, которое ловят.
   */
  it('пустой вход, дубликаты и словарь целиком — без исключений', () => {
    expect(
      validateGrantAssignment({
        roles: [],
        permissions: [],
        subjectRole: null,
        subjectPermissionsAfter: null,
      }),
    ).toEqual([]);
    expect(
      codesOf(
        validateGrantAssignment({
          roles: ['shtab', 'shtab', 'driver', 'driver'],
          permissions: ['users.manage', 'users.manage', 'waybills.read', 'waybills.read'],
          subjectRole: 'shtab',
          subjectPermissionsAfter: null,
        }),
      ),
    ).toEqual(['permission_not_grantable', 'role_not_grantable', 'module_forbidden_for_axis']);
    // Словарь целиком всем ролям разом: проверка обязана ответить списком, а не упасть на роли без
    // прав, на пустом словаре области или на невыдаваемом праве в чужом модуле.
    const everything = validateGrantAssignment({
      roles: [...ROLES],
      permissions: [...PERMISSIONS],
      subjectRole: null,
      subjectPermissionsAfter: [...PERMISSIONS],
    });
    expect(Array.isArray(everything)).toBe(true);
    expect(new Set(codesOf(everything))).toEqual(
      new Set<GrantViolationCode>([
        'permission_not_grantable',
        'role_not_grantable',
        'module_forbidden_for_axis',
        'duty_conflict',
      ]),
    );
  });
});

/**
 * Полномочия в теле учётки (план «полномочия назначаются в окне учётки», §4) — граница
 * высказывания, уникальность строки и взаимное исключение с надстройками.
 *
 * Проверяется здесь то, что схема **обязана** ловить одна на сервер и на портал. Правил, которые
 * без базы не проверить, — полнота высказывания, границы молчания при смене роли, отказ на снятие
 * взведённого переводом назначения, `MAX_ASSIGNED_GRANTS` по итогу — в этом файле нет намеренно:
 * они живут в db-тестах, и искать их отсутствие здесь не надо.
 */
const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** Учётка, у которой правильно всё, кроме проверяемого: остальные поля к полномочиям не относятся. */
const newUser = {
  email: 'grants@test.local',
  lastName: 'Пользователь',
  firstName: 'Тестовый',
  middleName: '',
  password: 'Fx7#kq2Lm9tz',
  role: 'dispatcher',
} as const;

describe('границы высказывания о полномочиях', () => {
  it('граница тела вдвое больше границы итога — иначе полная замена не выражается', () => {
    // При полной замене в теле сходятся обе стороны разницы: строки снимаемых назначений и строки
    // выдаваемых наборов. Связь границ выражена умножением в самой константе, и тест сторожит
    // именно её: разъехавшись, они запретили бы законный запрос молча (§4.2).
    expect(MAX_GRANT_STATEMENTS).toBe(2 * MAX_ASSIGNED_GRANTS);
  });

  it('граница итога стоит с запасом над поставочным каталогом', () => {
    // Константа ниже факта запрещает сохранить карточку человека, которому ничего не добавляли:
    // правка телефона упёрлась бы в предел полномочий. Каталог поставки — девять системных наборов,
    // и предел обязан быть заведомо выше их всех вместе, а не «примерно столько же» (§4.2, §7.1).
    expect(MAX_ASSIGNED_GRANTS).toBeGreaterThan(ALL_SYSTEM_GRANT_CODES.length);
  });

  it('строк не больше границы тела, а ровно граница — законна', () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: uuid(i + 1), version: 1, selected: true }));
    expect(grantStatementListSchema.safeParse(rows(MAX_GRANT_STATEMENTS)).success).toBe(true);
    expect(grantStatementListSchema.safeParse(rows(MAX_GRANT_STATEMENTS + 1)).success).toBe(false);
  });

  it('строка — это набор, показанный состав и галочка', () => {
    const ok = { id: uuid(1), version: 3, selected: false };
    expect(grantStatementListSchema.safeParse([ok]).success).toBe(true);
    // Код вместо идентификатора: высказывание говорит `id`, потому что код правится, а `id` — нет.
    expect(grantStatementListSchema.safeParse([{ ...ok, id: 'auditor' }]).success).toBe(false);
    // Версия — номер состава: нумерация с единицы, дробей и нуля у неё не бывает.
    expect(grantStatementListSchema.safeParse([{ ...ok, version: 0 }]).success).toBe(false);
    expect(grantStatementListSchema.safeParse([{ ...ok, version: 1.5 }]).success).toBe(false);
    // Галочка обязательна: строка без неё не высказывание, а упоминание набора.
    expect(grantStatementListSchema.safeParse([{ id: uuid(1), version: 3 }]).success).toBe(false);
  });
});

describe('один набор — ровно одна строка (§4.3)', () => {
  it('противоречащие строки об одном наборе отклоняются схемой', () => {
    // «Побеждает последнее» означало бы, что за администратора решил порядок сериализации формы, а
    // «побеждает снятие» — что за него решили мы. Оба правила отвергнуты: тело противоречиво, и
    // отвечать на него нужно отказом, а не догадкой.
    const parsed = grantStatementListSchema.safeParse([
      { id: uuid(1), version: 2, selected: true },
      { id: uuid(1), version: 2, selected: false },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('дубль с одинаковой галочкой — та же ошибка, в том числе при разных версиях', () => {
    // Разные версии у одного набора — вопрос «какой состав ему показывали», а подписывают именно
    // состав (Р7). Полностью одинаковая пара строк тоже отклоняется: одна строка на набор — это
    // правило формата тела, а не способ обойти противоречие.
    expect(
      grantStatementListSchema.safeParse([
        { id: uuid(1), version: 2, selected: true },
        { id: uuid(1), version: 5, selected: true },
      ]).success,
    ).toBe(false);
    expect(
      grantStatementListSchema.safeParse([
        { id: uuid(1), version: 2, selected: true },
        { id: uuid(1), version: 2, selected: true },
      ]).success,
    ).toBe(false);
    // Разные наборы с одинаковой версией — обычное тело: сторожится повтор `id`, а не совпадение
    // номеров состава.
    expect(
      grantStatementListSchema.safeParse([
        { id: uuid(1), version: 2, selected: true },
        { id: uuid(2), version: 2, selected: false },
      ]).success,
    ).toBe(true);
  });

  it('отказ указывает на виноватую строку, а не на всё поле', () => {
    const parsed = grantStatementListSchema.safeParse([
      { id: uuid(1), version: 1, selected: true },
      { id: uuid(2), version: 1, selected: true },
      { id: uuid(1), version: 1, selected: false },
    ]);
    expect(parsed.success).toBe(false);
    // Путь ведёт ко второй строке про тот же набор: форма подсвечивает её, а не первое упоминание —
    // первое законно, лишнее именно повторное.
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path)).toContainEqual([2, 'id']);
  });
});

describe('полномочия в теле учётки', () => {
  it('поле необязательно, и молчание отличается от пустого высказывания', () => {
    // Отсутствие поля — «назначений не касаемся», пустой массив — «решать не о чем». У схемы
    // различие держится тем, что умолчания `[]` нет: достроив его, контракт превратил бы правку
    // телефона в высказывание о полномочиях.
    expect(updateUserSchema.parse({}).grants).toBeUndefined();
    expect(updateUserSchema.parse({ grants: [] }).grants).toEqual([]);
    expect(createUserSchema.parse({ ...newUser }).grants).toBeUndefined();
  });

  it('высказывание принимается обеими операциями', () => {
    const grants = [
      { id: uuid(1), version: 4, selected: true },
      { id: uuid(2), version: 1, selected: false },
    ];
    expect(createUserSchema.parse({ ...newUser, grants }).grants).toEqual(grants);
    expect(updateUserSchema.parse({ grants }).grants).toEqual(grants);
  });

  it('границы и уникальность действуют внутри тела учётки, а не только отдельной схемой', () => {
    expect(
      updateUserSchema.safeParse({
        grants: [
          { id: uuid(1), version: 1, selected: true },
          { id: uuid(1), version: 1, selected: false },
        ],
      }).success,
    ).toBe(false);
    expect(
      updateUserSchema.safeParse({
        grants: Array.from({ length: MAX_GRANT_STATEMENTS + 1 }, (_, i) => ({
          id: uuid(i + 1),
          version: 1,
          selected: true,
        })),
      }).success,
    ).toBe(false);
  });

  it('полномочия и надстройки в одном теле — отказ: оба правят одно множество', () => {
    // Надстройка на шагах 1a–1e ADR 0106 — тот же набор, выданный через `user_grants`. Тело,
    // назвавшее оба поля, задаёт два итога сразу, и вопрос «какой главный» ответа не имеет (§4.1).
    const grants = [{ id: uuid(1), version: 1, selected: true }];
    expect(
      updateUserSchema.safeParse({ grants, addons: ['office_equipment_operator'] }).success,
    ).toBe(false);
    // Пустой список надстроек у правки — это «снять все», то есть тоже высказывание о наборах.
    expect(updateUserSchema.safeParse({ grants, addons: [] }).success).toBe(false);
    // Порознь оба поля законны: путь надстроек доживает до шага 1e.
    expect(updateUserSchema.safeParse({ grants }).success).toBe(true);
    expect(updateUserSchema.safeParse({ addons: ['office_equipment_operator'] }).success).toBe(
      true,
    );
  });

  it('у создания конфликтом считается непустой список надстроек', () => {
    // Здесь `addons` достраивается умолчанием до `[]`, и отличить присланный пустой список от
    // отсутствия поля невозможно; пустой же о наборах ничего не утверждает — у новой учётки
    // «надстроек нет» и «надстройки не трогаем» дают один итог.
    const grants = [{ id: uuid(1), version: 1, selected: true }];
    expect(
      createUserSchema.safeParse({
        ...newUser,
        grants,
        addons: ['office_equipment_operator'],
      }).success,
    ).toBe(false);
    expect(createUserSchema.safeParse({ ...newUser, grants, addons: [] }).success).toBe(true);
    expect(createUserSchema.safeParse({ ...newUser, grants }).success).toBe(true);
  });
});

describe('каталог наборов отбирается ролью', () => {
  it('роль в запросе необязательна и принимается значением словаря', () => {
    // Форма учётки показывает только совместимые с выбранной ролью наборы (Р2), и отбор делает
    // сервер по `grant_roles`: иначе правило совместимости было бы написано второй раз — в портале.
    expect(grantListQuerySchema.parse({}).role).toBeUndefined();
    expect(grantListQuerySchema.parse({ role: 'shtab' }).role).toBe('shtab');
    expect(grantListQuerySchema.safeParse({ role: 'кладовщик' }).success).toBe(false);
  });

  it('роль `driver` схемой не отсеивается: спрашивают каталог, а не выдачу', () => {
    // Наборов она не принимает вовсе (барьер 2), но ответ «список пуст» здесь честнее отказа 400 —
    // отказывать нужно на выдаче, где решение и принимается.
    expect(grantListQuerySchema.safeParse({ role: 'driver' }).success).toBe(true);
  });
});
