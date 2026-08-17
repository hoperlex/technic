import {
  isGrantable,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  roleLabels,
  ROLES,
  validateGrantAssignment,
  type GrantImpactDto,
  type GrantImpactUserDto,
  type GrantValidationDetailsDto,
  type Permission,
  type PermissionModule,
  type Role,
} from '@technic/contracts';
import { isApiError } from '@shared/api';

/**
 * Словарь конструктора полномочий (ADR 0106, план §12): что показывать в списке прав, какие роли
 * предлагать и какими словами пересказывать ответ сервера.
 *
 * Своего представления о модели здесь нет ни строчки, и это главное свойство файла. Перечень
 * выдаваемых прав отбирается предикатом контрактов (`isGrantable`), список ролей — той же самой
 * проверкой выдачи, которой отказывает сервер (`validateGrantAssignment`), а нарушения барьеров не
 * вычисляются вовсе — они приходят готовыми текстами и только раскладываются по местам. Вторая
 * копия любого из этих правил на портале разошлась бы с сервером в первую же правку каталога: форма
 * показала бы галочку, которую сервер отклонит, либо спрятала бы ту, которую он принимает.
 */

/** Модуль в списке прав: его выдаваемые права в порядке словаря `PERMISSIONS`. */
export interface GrantModuleGroup {
  module: PermissionModule;
  label: string;
  permissions: Permission[];
}

/**
 * Права конструктора, разложенные по модулям витрины.
 *
 * Невыдаваемые (`NON_GRANTABLE_PERMISSIONS`, инвариант 5 плана §8) отсеиваются здесь, у самого
 * источника списка, а не в разметке: спрятать чекбокс — задача одного места, и «показали, но
 * заблокировали» тут не годится. Право, которое не выдаётся ни при каких условиях, в конструкторе
 * не выбор с причиной отказа, а строка, которой в наборе не бывает; удаление насовсем и ведение
 * учёток не должны даже мелькать в списке того, что можно собрать.
 *
 * Модуль без единого выдаваемого права выпадает целиком — так уходит кабинет водителя: оба его
 * права защищены, и пустой заголовок модуля обещал бы выбор, которого нет.
 */
export const GRANT_MODULE_GROUPS: GrantModuleGroup[] = PERMISSION_MODULES.map((module) => ({
  module,
  label: permissionModuleLabels[module],
  permissions: PERMISSIONS_BY_MODULE[module].filter(isGrantable),
})).filter((group) => group.permissions.length > 0);

/** Все права, которые конструктор вообще показывает: ими же он чистит присланный состав. */
export const GRANTABLE_PERMISSIONS: Permission[] = GRANT_MODULE_GROUPS.flatMap(
  (group) => group.permissions,
);

/**
 * Тот же список, но **весь словарь** — без отбора выдаваемых.
 *
 * Нужен адресации рассылок (ADR 0111): расписание не выдаёт право, а спрашивает «у кого оно есть»,
 * и `NON_GRANTABLE_PERMISSIONS` к этому вопросу отношения не имеет. Спрятать здесь `users.manage`
 * значило бы завести второй смысл у списка невыдаваемых прав — и, хуже того, скрыть от формы право,
 * которое расписанию могла подобрать миграция: открыв такое расписание, администратор молча снял бы
 * его адресацию, ничего в форме не тронув.
 */
export const PERMISSION_MODULE_GROUPS: GrantModuleGroup[] = PERMISSION_MODULES.map((module) => ({
  module,
  label: permissionModuleLabels[module],
  permissions: [...PERMISSIONS_BY_MODULE[module]],
})).filter((group) => group.permissions.length > 0);

/**
 * Роли, которым полномочия выдаются, — сегодня это все, кроме водителя.
 *
 * Выводятся проверкой выдачи, а не списком с вычеркнутым `driver`: барьер 2 живёт в контрактах, и
 * записанное здесь имя роли стало бы вторым ответом на вопрос «кому наборы не положены». Заведут
 * вторую такую роль — список сузится сам, без правки этого файла.
 */
export const GRANT_ROLES: Role[] = ROLES.filter(
  (role) =>
    validateGrantAssignment({
      roles: [role],
      permissions: [],
      subjectPermissionsAfter: null,
      subjectRole: null,
    }).length === 0,
);

export const grantRoleOptions = GRANT_ROLES.map((role) => ({
  value: role,
  label: roleLabels[role],
}));

/** Подпись права — глаголом от лица учётки, как её объявляет каталог прав. */
export function permissionLabel(permission: Permission): string {
  return PERMISSION_CATALOG[permission].label;
}

/** Совместимые роли строкой. Пусто — набор выдавать некому, и сказать это надо словами. */
export function roleListText(roles: readonly Role[]): string {
  return roles.length > 0 ? roles.map((role) => roleLabels[role]).join(', ') : 'ни одной роли';
}

/** Русское склонение по числу: 1 — `one`, 2–4 — `few`, 5–20 и 11–14 — `many`. */
function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** «затронет 1 учётку, 2 учётки, 5 учёток» — винительный падеж: так стоит в сводке предпросмотра. */
export function accountsWord(count: number): string {
  return plural(count, 'учётку', 'учётки', 'учёток');
}

/** «добавится 1 право, 2 права, 5 прав». */
export function permissionsWord(count: number): string {
  return plural(count, 'право', 'права', 'прав');
}

/**
 * Сводка последствий: сколько учёток затронуто и сколько **разных** прав придёт и уйдёт.
 *
 * Права считаются множеством по всем затронутым, а не суммой по строкам: «добавится 2 права»
 * означает два права каталога, а не два человека, каждому по одному. Сумма по строкам на десяти
 * держателях дала бы «добавится 20 прав» там, где добавляется два, — и предупреждение читалось бы
 * как поломка.
 */
export interface GrantImpactSummary {
  accounts: number;
  added: Permission[];
  removed: Permission[];
}

export function impactSummary(impact: GrantImpactDto): GrantImpactSummary {
  const added = new Set<Permission>();
  const removed = new Set<Permission>();
  for (const user of impact.users) {
    for (const permission of user.added) added.add(permission);
    for (const permission of user.removed) removed.add(permission);
  }
  return { accounts: impact.users.length, added: [...added], removed: [...removed] };
}

/**
 * Сводка словами — то самое «затронет 7 учёток: добавится 2 права, снимется 1» из §12.
 *
 * Ноль затронутых — не пустая строка, а отдельный ответ: набор, который никому не выдан, правится
 * без последствий, и молчание в этом месте читалось бы как незагрузившийся предпросмотр.
 */
export function impactSummaryText(impact: GrantImpactDto): string {
  const { accounts, added, removed } = impactSummary(impact);
  if (accounts === 0) return 'Набор никому не выдан: чьих-либо прав эта правка не изменит.';
  const addedText =
    added.length > 0
      ? `добавится ${added.length} ${permissionsWord(added.length)}`
      : 'ничего не добавится';
  const removedText =
    removed.length > 0
      ? `снимется ${removed.length} ${permissionsWord(removed.length)}`
      : 'ничего не снимется';
  return `Затронет ${accounts} ${accountsWord(accounts)}: ${addedText}, ${removedText}.`;
}

/** Пометка держателя, чья роль вне списка совместимых, — тегом. */
export const ROLE_MISMATCH_TAG = 'роль не в списке';

/**
 * То же самое словами, и без них обойтись нельзя: тег сообщает о несоответствии, а администратору
 * нужен его смысл — выдача жива, но прав по ней у человека нет вовсе (§13.1). Молчаливый массовый
 * отзыв опаснее несоответствия, поэтому назначение остаётся, и объяснить это обязан экран.
 */
export function roleMismatchText(role: Role | null): string {
  const whose = role ? `Роль «${roleLabels[role]}»` : 'Роль не назначена, и она';
  return `${whose} не входит в список совместимых: выдача жива, но доступ по набору у этой учётки погашен — прав он ей не даёт.`;
}

/** Что изменится у одного держателя — словами, а не двумя списками кодов. */
export function userDeltaText(user: GrantImpactUserDto): string {
  if (user.roleMismatch) return 'прав по набору не получает: роль не в списке совместимых';
  const parts: string[] = [];
  if (user.added.length > 0) {
    parts.push(`добавится: ${user.added.map(permissionLabel).join(', ')}`);
  }
  if (user.removed.length > 0) {
    parts.push(`снимется: ${user.removed.map(permissionLabel).join(', ')}`);
  }
  // Пустая дельта — тоже ответ: человек операцией затронут, но не теряет и не получает ничего.
  return parts.length > 0 ? parts.join('; ') : 'доступ не изменится';
}

/**
 * Нарушения барьеров текстами сервера — из предпросмотра и из отказа одинаково.
 *
 * Один разбор на две формы ответа намеренно: половины у них те же самые (`violations` — про сам
 * набор, `holders` — про итог у держателей), и второй разбор дал бы двум экранам разные слова об
 * одном запрете. Сообщения не пересобираются: они уже написаны с виновником внутри («право „Ведение
 * учётных записей“ не выдаётся полномочиями…»), и переписать их короче значило бы потерять причину.
 */
function violationTextsOf(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const parsed = details as Partial<GrantValidationDetailsDto>;
  return [
    ...(parsed.violations ?? []).map((violation) => violation.message),
    ...(parsed.holders ?? []).flatMap((holder) =>
      holder.violations.map((violation) => `${holder.fullName}: ${violation.message}`),
    ),
  ];
}

/** Нарушения, показанные предпросмотром: «так сохранить нельзя» — до нажатия. */
export function impactViolationTexts(impact: GrantImpactDto): string[] {
  return violationTextsOf({ violations: impact.violations, holders: impact.holders });
}

/** Нарушения из отказа 400: тем же разбором, что и предпросмотр. */
export function apiViolationTexts(error: unknown): string[] {
  return isApiError(error) ? violationTextsOf(error.details) : [];
}

/** Данные устарели: 409 отпечатка последствий и версии — исход у них один, «посмотрите заново». */
export function isStaleConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}
