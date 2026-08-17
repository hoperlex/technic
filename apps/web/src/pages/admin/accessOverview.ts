import { useQuery } from '@tanstack/react-query';
import {
  accessProfileLabel,
  can,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPersonScopedRole,
  PERMISSIONS,
  roleAddonLabels,
  scopeAxisOf,
  SYSTEM_GRANT_CODES,
  type AccessSubject,
  type Permission,
  type UserAccountDto,
  type UserDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { usersApi } from '../../api/resources';

/**
 * Общие данные и вычисления вкладки «Права» (`docs/permissions-tab-plan.md`).
 *
 * **Права витрина больше не считает — она их спрашивает** (ADR 0106; план реструктуризации §12,
 * этап 2б). До реформы доступ выводился здесь из роли: `subjectOf` собирал тройку «роль + тип
 * контрагента + надстройки», а дальше всё решал `can`. Со свободной сборкой полномочий так больше
 * нельзя: состав набора живёт в базе (`grant_permissions`) и заводится в проде, матрица его не
 * знает и знать не должна. Клиент вывести такие права **не может**, поэтому каждая учётка приезжает
 * со своим списком (`UserAccountDto.permissions`, порядок словарный), и все три среза считают по
 * нему: держателей права, группировку, открытые модули и число прав.
 *
 * Матрица при этом не выброшена, а сменила роль: она отвечает уже не «что человек может», а «чем
 * это объясняется» — роль, надстройка, тип контрагента, — и в этом качестве её по-прежнему
 * спрашивают через контракты (`permissionSources`, `moduleAccess`, `describeAccessScope`). Своего
 * представления о правах здесь нет ни строчки: копия правил разошлась бы с моделью и врала бы ровно
 * там, где по ней принимают решение.
 *
 * Три среза вкладки берут один и тот же список одним запросом (ключ общий, react-query
 * дедуплицирует): сводки считаются по всем учёткам сразу, а не по странице — «сколько людей под
 * ролью» на одной странице списка не посчитать.
 */

const ACCESS_USERS_KEY = ['users', 'access-overview'] as const;

export interface AccessUsers {
  /**
   * Учётка вместе с привязанным работником: список `/users` отвечает `UserAccountDto`, и водителю
   * область задаёт как раз этот работник — четвёртая ось (ADR 0102). Возьми витрина здесь `UserDto`,
   * и показать область водителя было бы нечем.
   */
  users: UserAccountDto[];
  /** Сколько учёток всего: список ограничен страницей, и об урезании витрина обязана сказать. */
  total: number;
  truncated: boolean;
  isFetching: boolean;
}

export function useAccessUsers(): AccessUsers {
  const { data, isFetching } = useQuery({
    queryKey: ACCESS_USERS_KEY,
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
  const users = data?.items ?? [];
  const total = data?.total ?? 0;
  return { users, total, truncated: total > users.length, isFetching };
}

/** Часть учётки, из которой собирается субъект: срезам хватает её, а не всей записи. */
type SubjectFields = Pick<UserDto, 'role' | 'counterpartyType' | 'addons'>;
/** То же плюс права, посчитанные сервером, — вход всякого расчёта доступа на витрине. */
type AccessFields = SubjectFields & Pick<UserDto, 'permissions'>;

/**
 * Матричная тройка учётки (ADR 0038, 0086) — роль, тип контрагента и надстройки.
 *
 * **Входом расчёта прав она больше не служит**: права приходят готовыми, а из тройки их вывести
 * нельзя — набор, собранный в проде, матрице неизвестен. Осталась она там, где отвечает матрица:
 * подпись профиля (`accessProfileLabel`) и объяснение источника права (`permissionSources`). Область
 * (`describeAccessScope`) спрашивается не у неё, а у `effectiveSubject`: одно из правил области
 * смотрит на само право `archive.read`, и на голой тройке оно промолчало бы про набор.
 */
export function subjectOf(user: SubjectFields): AccessSubject {
  return { role: user.role, counterpartyType: user.counterpartyType, addons: user.addons };
}

/**
 * Субъект, который отвечает **по правам сервера**: та же тройка, а списком назначенных прав —
 * весь эффективный набор учётки.
 *
 * Подстановка в `grantPermissions` (четвёртый источник субъекта) — не хитрость, а единственный
 * способ спросить у контрактов производные от прав вещи, не переписав их на портале: `moduleAccess`
 * знает, какое действие считается работой, а какое просмотром, `describeAccessScope` — какие правила
 * области зависят от прав. Оба зовут `can`, а `can` на таком субъекте отвечает ровно «есть ли право
 * в серверном списке»: матричные права в нём уже лежат (сервер считает список тем же
 * `permissionsFor`), и OR источников ничего не добавляет. Тем же приёмом и по той же причине живёт
 * `canUse` текущего пользователя (`auth/AuthContext.tsx`).
 *
 * Для подписи источника этот субъект не годится: на нём «набор» объяснял бы каждое право, включая
 * ролевые. Источники спрашивают `sourceSubject`.
 */
export function effectiveSubject(user: AccessFields): AccessSubject {
  return { ...subjectOf(user), grantPermissions: user.permissions };
}

/**
 * Права учётки, которых матрица объяснить не может, — то есть **доказуемо** пришедшие набором.
 *
 * Сервер отдаёт объединение прав всех наборов учётки, а не разбивку «какое право из какого»
 * (`PermissionOrigin.grantCode` не заполнен ни у кого, см. контракты). Значит доказуемо наборным
 * является только то право, которого нет ни у роли, ни у надстройки, ни у типа контрагента. Право,
 * которое даёт и должность, и набор, отсюда выпадает — и витрина честно подписывает его должностью,
 * оговаривая в карточке, что разбивки по наборам у неё нет. Выдумать её из кодов наборов
 * невозможно: состав набора лежит в базе, а не в контрактах.
 */
export function grantOnlyPermissions(user: AccessFields): Permission[] {
  const matrix = subjectOf(user);
  return user.permissions.filter((permission) => !can(matrix, permission));
}

/**
 * Субъект для подписи источников: наборам отданы только доказуемо наборные права. На нём
 * `permissionSources` из контрактов отвечает про каждое право всеми источниками сразу — роль,
 * надстройка (по имени), набор, тип контрагента, — а порядок источников остаётся один, тот же, что
 * у `can`.
 */
export function sourceSubject(user: AccessFields): AccessSubject {
  return { ...subjectOf(user), grantPermissions: grantOnlyPermissions(user) };
}

/**
 * Учётка, которой открыто всё. Считается по её правам, а не по имени роли: смысл проверки как раз в
 * том, чтобы заметить **собранного** всесильного субъекта, а сравнение с `'admin'` заметило бы
 * только записанного в матрицу.
 */
export function hasAllPermissions(user: Pick<UserDto, 'permissions'>): boolean {
  const held = new Set<Permission>(user.permissions);
  return PERMISSIONS.every((permission) => held.has(permission));
}

/**
 * Подпись набора по его коду. Имён наборов витрина пока не знает — их отдаст каталог полномочий
 * (§12 плана), а список учёток несёт только коды, — поэтому у системных берётся подпись их
 * надстройки, а у собранного администратором показывается сам код. Догадываться о названии по коду
 * нельзя: «Аудитор» и `auditor` совпадают лишь до первого набора, названного иначе.
 */
const SYSTEM_GRANT_LABELS: ReadonlyMap<string, string> = new Map(
  SYSTEM_GRANT_CODES.map((code) => [code, roleAddonLabels[code]] as const),
);

export function grantCodeLabel(code: string): string {
  return SYSTEM_GRANT_LABELS.get(code) ?? code;
}

/**
 * Чем ограничена область учётки: ось и её значения — объекты, отделы, контрагент или работник
 * справочника. `null` в оси означает «роль без своей оси» (администратор, менеджер, наблюдатель), и
 * значений у неё нет. Ось перечислена здесь не сама, а взята из `scopeAxisOf`: список осей, второй
 * раз написанный на портале, разошёлся бы с моделью молча — ровно так и получилось у водителя.
 */
export interface ScopeTargets {
  axis: ReturnType<typeof scopeAxisOf>;
  items: string[];
}

export function scopeTargets(user: UserAccountDto): ScopeTargets {
  const axis = scopeAxisOf(user.role);
  if (axis === 'object') return { axis, items: user.constructionObjects.map((o) => o.name) };
  if (axis === 'department') return { axis, items: user.departments.map((d) => d.name) };
  if (axis === 'counterparty') {
    return { axis, items: user.counterpartyName ? [user.counterpartyName] : [] };
  }
  // Область водителя — карточка работника (ADR 0102), и значение у оси одно: сам работник. Пусто
  // оно только у сломанной учётки, о которой рядом говорит `scopeAnomaly`.
  if (axis === 'person') return { axis, items: user.person ? [user.person.fullName] : [] };
  return { axis, items: [] };
}

/**
 * Подпись оси области — те же слова, что в карточке учётки. Осей четыре, и `Record` по союзу
 * `scopeAxisOf`, а не свободный объект: ось, забытая здесь, оставила бы витрину без подписи ровно
 * там, где она рассказывает про область.
 */
export const scopeAxisTitles: Record<NonNullable<ScopeTargets['axis']>, string> = {
  object: 'Объекты',
  department: 'Отделы',
  counterparty: 'Контрагент',
  // Работник справочника (ADR 0102) — четвёртая ось: у водителя вместо объектов и отделов стоит
  // человек, чьё задание показывает кабинет. Тем же словом, что поле в форме учётки.
  person: 'Работник',
};

/**
 * Область одной строкой: перечень объектов, отделов, имя контрагента или работник справочника. У
 * роли без своей оси — «Все записи», и это не пустое место, а самая широкая область из возможных.
 * Пустая ось молчит: почему набор пуст, говорит `scopeAnomaly` рядом.
 */
export function scopeText(user: UserAccountDto): string {
  const { axis, items } = scopeTargets(user);
  // Ось «работник» названа в самой строке, в отличие от прочих: название объекта, отдела и
  // контрагента говорит за свою ось само, а ФИО работника — нет, рядом в строке стоит такое же ФИО
  // учётки. Без подписи колонка выглядела бы повторяющей сотрудника, а не показывающей область.
  if (axis === 'person' && items.length > 0) return `${scopeAxisTitles.person}: ${items[0]}`;
  if (items.length > 0) return items.join(', ');
  if (!user.role) return '—';
  return axis ? '—' : 'Все записи';
}

/**
 * Учётка, у которой роль требует области, а области нет: она не видит ничего и работать не может.
 * Активной такой быть не должна — API её не активирует (ADR 0039, 0040), — но витрина проверяет
 * сама: смысл среза в том, чтобы находить расхождения, а не подтверждать, что их не бывает.
 */
export function scopeAnomaly(user: UserAccountDto): string | null {
  if (!user.role) return user.isActive ? 'Активна, но роль не назначена' : null;
  if (isObjectScopedRole(user.role) && user.constructionObjects.length === 0) {
    return 'Роль работает на объектах, но объекты не заданы';
  }
  if (isDepartmentScopedRole(user.role) && user.departments.length === 0) {
    return 'Роль работает в отделах, но отделы не заданы';
  }
  if (isCounterpartyScopedRole(user.role) && !user.counterpartyId) {
    return 'Роль работает от контрагента, но контрагент не задан';
  }
  // Четвёртая ось наравне с прочими: кабинет берёт работника из учётки, и без него водителю
  // показывать нечего — задание собирается на человека, которого нет.
  if (isPersonScopedRole(user.role) && !user.person) {
    return 'Роль работает от карточки работника, но работник не задан';
  }
  return null;
}

/**
 * Живые учётки: витрина отвечает на «кто сейчас что может», и выключенные в счёт не идут. Отбор
 * сохраняет тип записи: срезы «Профили» и «Права» работают с `UserDto`, а срез «Людей» — с учёткой
 * вместе с работником, и обеднять её на общем фильтре нельзя.
 *
 * Отсекать удалённые обязана сама витрина: пакетные читатели прав и наборов на сервере фильтра по
 * `deleted_at` не имеют — они отвечают за то, что выдано, а не за то, кто жив, — и «держателей
 * права» без этого отбора набрали бы уволенные.
 */
export function activeUsers<T extends Pick<UserDto, 'isActive' | 'deletedAt'>>(
  users: readonly T[],
): T[] {
  return users.filter((u) => u.isActive && !u.deletedAt);
}

/**
 * Ключ доступа — то, чем учётка (или профиль матрицы) различима **по факту**: роль, тип контрагента
 * и отпечаток набора прав.
 *
 * До реформы ключ строился из «роль + тип контрагента + надстройки»: набор прав был функцией от
 * этой тройки, и учётки с одним ключом отвечали на `can` одинаково. С назначаемыми полномочиями
 * утверждение перестало быть верным — два штаба с одним ключом получают разные права, если одному
 * выдали набор, — и группировка по тройке стала бы ложной ровно в том срезе, который заводили ради
 * ответа «сколько людей может одно и то же».
 *
 * Поэтому основа ключа — сами права, списком в словарном порядке (сервер отдаёт их так, и это часть
 * контракта: при нестабильном порядке одинаковый состав давал бы разные ключи). Надстройки из ключа
 * ушли: они больше не признак, а один из источников тех же прав — учётка с системным набором и
 * учётка с собранным вручную набором того же состава различаются только историей выдачи, а доступ у
 * них один, и в одну строку они попадают правильно.
 *
 * **Роль и тип контрагента в ключе остались, и это не осторожность.** Они несут второй слой —
 * область: «Менеджер» и «Диспетчер» с одинаковыми правами работают над разными строками, а
 * исполнитель без типа контрагента — вообще не тот субъект, что с типом. Слей их ключ, и витрина
 * объявила бы одинаковыми учётки, которые видят разное.
 *
 * Одна функция на две стороны сопоставления (живые учётки и профили матрицы) — намеренно: пока их
 * было две, они считали одно и то же дважды, и разъехаться им было нечем, кроме внимания
 * читающего.
 */
export function accessKey(access: {
  role: AccessSubject['role'];
  counterpartyType?: AccessSubject['counterpartyType'];
  permissions: readonly Permission[];
}): string {
  return [access.role ?? 'none', access.counterpartyType ?? '-', access.permissions.join(',')].join(
    '|',
  );
}

export interface AccessGroup {
  key: string;
  /** Матричная тройка первой учётки группы: подпись и объяснение источников. */
  subject: AccessSubject;
  label: string;
  /**
   * Права группы — одни на всех её членов: тем она и группа. Берутся из первой учётки, потому что
   * равенство списков и есть условие попадания в одну строку.
   */
  permissions: readonly Permission[];
  users: UserAccountDto[];
}

/**
 * Живые учётки, сгруппированные по фактическому доступу. Профили матрицы сюда не попадают вовсе —
 * сопоставляет их с этими группами срез «Профили», по одному и тому же `accessKey`.
 */
export function accessGroups(users: readonly UserAccountDto[]): AccessGroup[] {
  const byKey = new Map<string, AccessGroup>();
  for (const user of users) {
    const key = accessKey(user);
    const found = byKey.get(key);
    if (found) {
      found.users.push(user);
      continue;
    }
    const subject = subjectOf(user);
    byKey.set(key, {
      key,
      subject,
      label: user.role ? accessProfileLabel(subject) : 'Без роли',
      permissions: user.permissions,
      users: [user],
    });
  }
  return [...byKey.values()].sort((a, b) => b.users.length - a.users.length);
}

/**
 * Кто владеет каждым правом — вход обратного среза «Права».
 *
 * Перебираются права самих учёток, а не матрица по каждой: список эффективных прав — это и есть
 * ответ сервера, и спрашивать вместо него `can` значило бы вернуться к расчёту по роли. Промах по
 * ключу (`?.push`) молча отбрасывает право, которого в словаре нет: сервер такие уже отсеял
 * (`isPermission`), но витрина не обязана падать из-за строки, оставшейся от снятого права.
 *
 * Живость учёток здесь не проверяется — её обеспечивает вызывающий (`activeUsers`): срез отвечает
 * на «кто сейчас владеет правом», и уволенные в этот ответ не входят.
 */
export function permissionHolders<T extends Pick<UserDto, 'permissions'>>(
  users: readonly T[],
): Map<Permission, T[]> {
  const holders = new Map<Permission, T[]>(PERMISSIONS.map((p) => [p, []]));
  for (const user of users) {
    for (const permission of user.permissions) holders.get(permission)?.push(user);
  }
  return holders;
}
