import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  ADMIN_PAGE_PERMISSIONS,
  canUse,
  DRIVER_CABINET_SECTION,
  isPersonScopedRole,
  isSectionOpen,
  openShellSections,
  PERMISSIONS,
  permissionsFor,
  PORTAL_SECTIONS,
  ROLES,
  SHELL_SECTIONS,
  startSection,
  type Permission,
  type PortalSection,
  type Role,
  type ScopedSubject,
  type SectionAccess,
} from '@technic/contracts';

/**
 * Реестр разделов портала (`docs/portal-sections-plan.md` §6) — состав разделов и стартовая
 * страница учётки. Здесь, рядом с перебором `ACCESS_PROFILES`, по той же причине, что и тесты
 * матрицы: вопрос «куда приземляется субъект» — вопрос доступа, и до реестра его не задавал никто.
 *
 * Что этот файл держит: порядок разделов (два разных — меню и стартовый), непротиворечивость самого
 * реестра и согласие `startSection` с сегодняшним поведением портала. Чего он **не** ловит — раздела,
 * которого в реестре нет вовсе: тест построен из реестра и о пропущенной строке не знает. Эту дыру
 * закрывает `check-portal-routes.mjs` (§6 плана), а не проверки здесь.
 */

/** Право учётки — как его считает портал: список сервера и область матрицы (`AuthContext`). */
function accessOf(subject: ScopedSubject): SectionAccess {
  const granted = new Set(permissionsFor(subject));
  return {
    role: subject.role,
    /*
     * Право спрашивается у списка, а область — у матрицы, и право ей подставляется назначенным
     * (`grantPermissions`): так же собирает предикат портал (`permissionChecks`), и повтори тест
     * это правило иначе — он проверял бы не то, что видит человек. Смысл двух шагов: у матрицы
     * спрашивается ровно область (ADR 0062), потому что права со свободными наборами (ADR 0106)
     * из роли больше не выводятся.
     */
    canUse: (permission) =>
      granted.has(permission) && canUse({ ...subject, grantPermissions: [permission] }, permission),
  };
}

/** Доступ, заданный голым набором прав: роль значима только для кабинета (ADR 0102). */
function accessOfPermissions(permissions: readonly Permission[], role: Role | null): SectionAccess {
  const granted = new Set(permissions);
  return { role, canUse: (permission) => granted.has(permission) };
}

/**
 * Область учётки двумя состояниями. Пустая область — не редкость и не поломка: объектной роли
 * объекты назначают, а отделу они достаются от его площадок (ADR 0062), и раздел «Вывоз мусора»
 * при пустом наборе закрыт, хотя право на него у роли есть.
 */
const SCOPE_STATES = [
  {
    label: 'с площадками',
    scope: { constructionObjectIds: ['object-1'], departmentObjectIds: ['object-1'] },
  },
  { label: 'без площадок', scope: {} },
] as const;

/** Все различимые наборы прав размером один и два — перебор из §6 плана. */
const PERMISSION_COMBOS: readonly (readonly Permission[])[] = PERMISSIONS.flatMap(
  (permission, index) => [
    [permission],
    ...PERMISSIONS.slice(index + 1).map((second) => [permission, second]),
  ],
);

/** Роль перебора: кабинет открыт только водителю, остальным разделам роль безразлична. */
const roleForCombo = (combo: readonly Permission[]): Role =>
  combo.includes('driverCabinet.read') ? 'driver' : 'admin';

/**
 * Сегодняшний `homePath` (`ProtectedRoute.tsx` до реестра) — эталон совместимости, переписанный
 * сюда строка в строку. Копия здесь законна и нужна: сравнивать реестр с самим собой бессмысленно,
 * а обещание «стартовая страница меняется только там, где сегодня ошибка» проверяется ровно
 * сличением с тем перебором, который ошибку и делал.
 */
function legacyHomePath(role: Role | null, can: (permission: Permission) => boolean): string {
  if (isPersonScopedRole(role) && can('driverCabinet.read')) return '/driver';
  if (can('wasteRequests.read')) return '/waste';
  if (can('vehicleRequests.read')) return '/vehicle-requests';
  if (can('garage.read')) return '/garage';
  if (can('waybills.read')) return '/waybills';
  if (can('directories.write')) return '/directories';
  if (ADMIN_PAGE_PERMISSIONS.some((permission) => can(permission))) return '/admin';
  // Раздела «Орг.техника» перебор не знал (ADR 0085) — отсюда и служебная форма вместо раздела.
  return '/change-password';
}

/** Раздел с наименьшим `startOrder` среди открытых — то, чем `startSection` обязан ответить. */
function lowestOpen(access: SectionAccess): PortalSection | null {
  const open = PORTAL_SECTIONS.filter((section) => isSectionOpen(section, access));
  return open.reduce<PortalSection | null>(
    (best, section) => (best === null || section.startOrder < best.startOrder ? section : best),
    null,
  );
}

describe('состав реестра', () => {
  /**
   * Снимок стартового порядка — главная защита совместимости волны. Перебор профилей её не даёт:
   * наборы прав живут в базе (ADR 0106) и из роли не выводятся, а порядок даёт, потому что
   * `startSection` — тот же линейный перебор, что и `homePath`. Список читается как сегодняшний
   * `homePath` плюс «Орг.техника» в хвосте: раздел дописан последним намеренно, иначе механик с
   * назначенным `officeEquipment.read` уехал бы из «Гаража» в оргтехнику.
   */
  it('стартовый порядок — сегодняшний homePath плюс «Орг.техника» в хвосте', () => {
    const byStart = [...PORTAL_SECTIONS]
      .sort((a, b) => a.startOrder - b.startOrder)
      .map((section) => section.id);
    expect(byStart).toEqual([
      'driver-cabinet',
      'waste',
      'vehicle-requests',
      'garage',
      'waybills',
      'directories',
      'admin',
      'office-equipment',
    ]);
  });

  /**
   * Порядок меню — отдельным снимком, потому что это отдельный вопрос: «в каком порядке человек
   * видит разделы» и «какой из них открыть первым» совпадать не обязаны. Два снимка рядом и стоят
   * затем, чтобы расхождение двух порядков было видно как решение, а не как опечатка.
   */
  it('порядок меню остаётся прежним и кабинета в нём нет', () => {
    expect(SHELL_SECTIONS.map((section) => section.id)).toEqual([
      'waste',
      'vehicle-requests',
      'waybills',
      'garage',
      'office-equipment',
      'directories',
      'admin',
    ]);
    // Кабинет — второй контур (ADR 0102): своя ветка маршрутов и свой каркас, пункта меню у него нет.
    expect(SHELL_SECTIONS.map((section) => section.id)).not.toContain('driver-cabinet');
    expect(PORTAL_SECTIONS).toContain(DRIVER_CABINET_SECTION);
  });

  /**
   * Двойник в реестре — не косметика. Повторённый `id` ломает `SECTION_PAGES` (страница достанется
   * одна на двоих), повторённый адрес даёт два пункта меню, ведущих в одно место, а повторённый
   * `startOrder` делает стартовую страницу зависящей от порядка сортировки — то есть невоспроизводимой.
   */
  it('id, адреса и стартовые номера не повторяются', () => {
    for (const key of ['id', 'path', 'startOrder'] as const) {
      const values = PORTAL_SECTIONS.map((section) => section[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  /**
   * Стартовые номера — перестановка 1..N без дыр. Дыра сама по себе безвредна, но означает
   * выброшенный раздел, о котором забыли: номера идут подряд ровно затем, чтобы «пропущено» было
   * видно глазами при чтении реестра.
   */
  it('стартовые номера — перестановка без дыр', () => {
    const orders = PORTAL_SECTIONS.map((section) => section.startOrder).sort((a, b) => a - b);
    expect(orders).toEqual(PORTAL_SECTIONS.map((_, index) => index + 1));
  });

  /** Раздел без прав открыть нечем: строка реестра, невидимая никому, — забытое право, а не решение. */
  it('у каждого раздела есть право и непустые подписи', () => {
    for (const section of PORTAL_SECTIONS) {
      expect(section.permissions, section.id).not.toEqual([]);
      expect(section.label.trim(), section.id).not.toBe('');
      expect(section.short.trim(), section.id).not.toBe('');
      expect(section.path.startsWith('/'), section.id).toBe(true);
    }
  });
});

describe('стартовый раздел субъекта', () => {
  /**
   * Каждый профиль матрицы в двух состояниях области: раздел либо честный `null`. Служебных адресов
   * среди ответов не бывает по устройству — `startSection` возвращает строку реестра, — и проверка
   * здесь о другом: стартовым не может оказаться раздел, из которого учётку тут же выкинет гейт.
   */
  it('каждому профилю стартовый раздел открыт им же самим', () => {
    for (const profile of ACCESS_PROFILES) {
      for (const state of SCOPE_STATES) {
        const label = `${accessProfileLabel(profile)} — ${state.label}`;
        const access = accessOf({ ...profile, ...state.scope });
        const section = startSection(access);
        if (section === null) continue;
        expect(PORTAL_SECTIONS, label).toContain(section);
        expect(isSectionOpen(section, access), label).toBe(true);
        expect(section, label).toBe(lowestOpen(access));
      }
    }
  });

  /**
   * Профили без единого раздела — снимком, а не «их не бывает». Их и правда бывает: комендант
   * работает только с вывозом мусора, и без площадок работать ему не над чем (ADR 0062) — раздел
   * закрыт областью, а не правом. В проде такой учётки нет (объектной роли объект обязателен при
   * активации), но состояние достижимо: объекты у учётки могут исчезнуть позже. Именно этому случаю
   * и адресован пустой главный экран — до реестра он был неотличим от «пароль просрочен».
   *
   * Список короткий не сам по себе: до «Орг.техники» в реестре сюда попадал и оператор сервисной
   * компании — тот самый живой профиль, ради которого волна затевалась.
   */
  it('без единого раздела остаются только профили с пустой областью', () => {
    const empty = ACCESS_PROFILES.flatMap((profile) =>
      SCOPE_STATES.filter(
        (state) => startSection(accessOf({ ...profile, ...state.scope })) === null,
      ).map((state) => `${accessProfileLabel(profile)} — ${state.label}`),
    );
    expect(empty).toEqual(['Комендант — без площадок']);
  });
});

describe('перебор прав', () => {
  /**
   * Одиночные права и все их пары: субъекту достаётся раздел с наименьшим `startOrder` из открытых
   * ему. Перебором, а не по профилям, потому что профиль давно не исчерпывает учётку: со свободной
   * сборкой полномочий (ADR 0106) набор прав собирают поимённо, и «такой роли не бывает» перестало
   * быть доводом. Ловит расхождение прав раздела с правами гейта и ошибку в предикате.
   */
  it('стартовым становится открытый раздел с наименьшим номером', () => {
    for (const combo of PERMISSION_COMBOS) {
      const label = combo.join(' + ');
      const access = accessOfPermissions(combo, roleForCombo(combo));
      const section = startSection(access);
      expect(section, label).toBe(lowestOpen(access));
      if (section !== null) expect(isSectionOpen(section, access), label).toBe(true);
    }
  });

  /**
   * Меню — те же открытые разделы, но без кабинета и в своём порядке. Проверяется вместе с
   * перебором, потому что предикат у меню и стартовой один: разойдись они, человек видел бы пункт,
   * на который его не пускают, — или наоборот, приземлялся бы в раздел, которого в меню нет.
   */
  it('меню — открытые разделы каркаса в порядке SHELL_SECTIONS', () => {
    for (const combo of PERMISSION_COMBOS) {
      const label = combo.join(' + ');
      const access = accessOfPermissions(combo, roleForCombo(combo));
      const menu = openShellSections(access);
      expect(menu, label).toEqual(
        SHELL_SECTIONS.filter((section) => isSectionOpen(section, access)),
      );
      expect(
        menu.map((section) => section.id),
        label,
      ).not.toContain('driver-cabinet');
    }
  });

  /**
   * Условие кабинета — роль вместе с правом (ADR 0102), и это не перестраховка: `driverCabinet.read`
   * есть у администратора, потому что у него есть все права словаря. По одному праву кабинет
   * доставался ему и стартовой страницей, и по прямой ссылке, а выйти из второго контура нечем —
   * ни меню, ни разделов. Ради этого случая у раздела и заведено поле `roles`.
   */
  it('кабинет открыт водителю и закрыт всем прочим с тем же правом', () => {
    const driver = accessOfPermissions(['driverCabinet.read'], 'driver');
    expect(isSectionOpen(DRIVER_CABINET_SECTION, driver)).toBe(true);
    expect(startSection(driver)).toBe(DRIVER_CABINET_SECTION);
    for (const role of [...ROLES.filter((r) => !isPersonScopedRole(r)), null]) {
      const access = accessOfPermissions(['driverCabinet.read'], role);
      expect(isSectionOpen(DRIVER_CABINET_SECTION, access), String(role)).toBe(false);
      // Не «другой раздел», а именно «ни одного»: право кабинета никакого другого не открывает.
      expect(startSection(access), String(role)).toBeNull();
    }
  });
});

describe('совместимость с сегодняшним homePath', () => {
  /**
   * Обещание волны: учётка, которой `homePath` отвечает **рабочим разделом**, оставляет его за
   * собой; меняются только состояния, где сегодняшний перебор доходил до `/change-password`. Поэтому
   * такие наборы из сличения и выброшены — они и есть предмет лечения.
   *
   * Расхождения не «допускаются молча», а перечислены снимком, и снимок этот — третий случай той же
   * болезни, что и весь план: `homePath` знал у справочников одно право (`directories.write`), а
   * меню и маршрут — два (ADR 0085, Р7). Держателю `officeEquipment.write` вместе с правом вкладки
   * администрирования стартовая отдавала «Администрирование», хотя «Справочники» ему открыты и
   * стоят выше. Реестр отвечает одинаково всем трём спрашивающим — и потому лечит заодно и это.
   * Живых учёток правка не двигает: сегодня оба права вместе есть у администратора и диспетчера, а
   * им обоим стартовым остаётся «Вывоз мусора».
   */
  it('стартовый раздел совпадает с homePath всюду, кроме перечисленного', () => {
    const changed: string[] = [];
    for (const combo of PERMISSION_COMBOS) {
      const granted = new Set(combo);
      const role = roleForCombo(combo);
      const legacy = legacyHomePath(role, (permission) => granted.has(permission));
      if (legacy === '/change-password') continue;
      const now = startSection(accessOfPermissions(combo, role))?.path ?? null;
      if (now !== legacy) changed.push(`${combo.join(' + ')}: ${legacy} → ${now}`);
    }
    expect(changed).toEqual([
      'directories.export + officeEquipment.write: /admin → /directories',
      'directories.export + officeEquipmentConsumables.manage: /admin → /directories',
      'directories.export + officeEquipmentConsumables.stock: /admin → /directories',
      'officeEquipment.write + users.manage: /admin → /directories',
      'officeEquipment.write + mailings.read: /admin → /directories',
      'officeEquipment.write + manuals.manage: /admin → /directories',
      'officeEquipmentConsumables.manage + users.manage: /admin → /directories',
      'officeEquipmentConsumables.manage + mailings.read: /admin → /directories',
      'officeEquipmentConsumables.manage + manuals.manage: /admin → /directories',
      'officeEquipmentConsumables.stock + users.manage: /admin → /directories',
      'officeEquipmentConsumables.stock + mailings.read: /admin → /directories',
      'officeEquipmentConsumables.stock + manuals.manage: /admin → /directories',
    ]);
  });

  /**
   * Обратная сторона того же сличения: наборы, доводившие перебор до смены пароля, — это ровно те,
   * кого волна и чинит. Разделов, которыми она лечит, ровно два, и оба — то, чего `homePath` не
   * спрашивал вовсе: модуль «Орг.техника» целиком (ADR 0085) и справочники, открытые не общим
   * `directories.write`, а узкими правами оргтехники (Р7). Узких прав теперь три: `officeEquipment.write`
   * и два права номенклатуры расходников — ими ведут картриджи и правят остаток, а живёт этот
   * справочник окном из той же вкладки, поэтому дверь в раздел им нужна такая же. Четвёртого взяться
   * неоткуда: остальные строки перебора реестр повторяет слово в слово, и появись здесь чужой
   * раздел — разошлись бы права раздела с правами его гейта.
   */
  it('на смену пароля уводили держатели оргтехники — их и лечит реестр', () => {
    const healed = PERMISSION_COMBOS.filter((combo) => {
      const granted = new Set(combo);
      const role = roleForCombo(combo);
      return (
        legacyHomePath(role, (permission) => granted.has(permission)) === '/change-password' &&
        startSection(accessOfPermissions(combo, role)) !== null
      );
    });
    expect(healed).not.toEqual([]);
    const sections = new Set<string>();
    for (const combo of healed) {
      const section = startSection(accessOfPermissions(combo, roleForCombo(combo)));
      // Справочники здесь достаются только держателю узкого права: общий `directories.write`
      // `homePath` знает, и до смены пароля с ним перебор не доходил.
      if (section?.id === 'directories')
        expect(
          combo.some((permission) =>
            (
              [
                'officeEquipment.write',
                'officeEquipmentConsumables.manage',
                'officeEquipmentConsumables.stock',
              ] as string[]
            ).includes(permission),
          ),
          combo.join(' + '),
        ).toBe(true);
      sections.add(section?.id ?? 'нет раздела');
    }
    expect([...sections].sort()).toEqual(['directories', 'office-equipment']);
  });
});
