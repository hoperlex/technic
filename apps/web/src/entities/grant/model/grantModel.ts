import {
  isGrantable,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  roleLabels,
  roleMigrationOf,
  ROLES,
  validateGrantAssignment,
  type GrantImpactDto,
  type GrantImpactUserDto,
  type GrantOrigin,
  type GrantValidationDetailsDto,
  type Permission,
  type PermissionModule,
  type Role,
} from '@technic/contracts';
import { isApiError } from '@shared/api';

/**
 * Vocabulary of the grant set builder (ADR 0106, plan §12): what to show in the permission list,
 * which roles to offer and in what words to retell the server's response.
 *
 * There is not a single line of its own model here, and that is the file's main property. Grantable
 * permissions are selected by the contracts predicate (`isGrantable`), the role list by the very
 * assignment check the server rejects with (`validateGrantAssignment`), and barrier violations are
 * not computed at all — they arrive as ready texts and are only placed. A second copy of any of
 * these rules on the portal would drift from the server on the first catalog edit: the form would
 * show a checkbox the server rejects, or hide one it accepts.
 */

/** A module in the permission list: its grantable permissions in `PERMISSIONS` dictionary order. */
export interface GrantModuleGroup {
  module: PermissionModule;
  label: string;
  permissions: Permission[];
}

/**
 * Builder permissions grouped by showcase module.
 *
 * Non-grantable ones (`NON_GRANTABLE_PERMISSIONS`, invariant 5 of plan §8) are filtered here, at
 * the list's source, not in markup: hiding a checkbox is a job for one place, and "shown but
 * disabled" does not fit here. A permission that is never grantable under any conditions is not a
 * choice with a refusal reason in the builder but a row that never occurs in a set; permanent
 * deletion and account management must not even flash in the list of what can be assembled.
 *
 * A module without a single grantable permission drops out entirely — this is how the driver
 * cabinet goes: both its permissions are protected, and an empty module header would promise a
 * choice that does not exist.
 */
export const GRANT_MODULE_GROUPS: GrantModuleGroup[] = PERMISSION_MODULES.map((module) => ({
  module,
  label: permissionModuleLabels[module],
  permissions: PERMISSIONS_BY_MODULE[module].filter(isGrantable),
})).filter((group) => group.permissions.length > 0);

/** All permissions the builder shows at all: it also uses them to clean an incoming composition. */
export const GRANTABLE_PERMISSIONS: Permission[] = GRANT_MODULE_GROUPS.flatMap(
  (group) => group.permissions,
);

/**
 * The same list, but the **whole dictionary** — without filtering to grantable ones.
 *
 * Needed by mailing addressing (ADR 0111): a schedule does not grant a permission, it asks "who has
 * it", and `NON_GRANTABLE_PERMISSIONS` has nothing to do with that question. Hiding `users.manage`
 * here would give the non-grantable list a second meaning — and, worse, hide from the form a
 * permission a migration may have assigned to a schedule: on opening such a schedule the
 * administrator would silently drop its addressing without touching anything in the form.
 */
export const PERMISSION_MODULE_GROUPS: GrantModuleGroup[] = PERMISSION_MODULES.map((module) => ({
  module,
  label: permissionModuleLabels[module],
  permissions: [...PERMISSIONS_BY_MODULE[module]],
})).filter((group) => group.permissions.length > 0);

/**
 * Roles that can receive grants — today all except the driver.
 *
 * Derived from the assignment check, not from a list with `driver` struck out: barrier 2 lives in
 * the contracts, and a role name written here would be a second answer to "who may not hold grant
 * sets". Should a second such role appear, the list narrows by itself without editing this file.
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

/** Permission label — a verb phrase from the account's viewpoint, as the catalog declares it. */
export function permissionLabel(permission: Permission): string {
  return PERMISSION_CATALOG[permission].label;
}

/** Compatible roles as a string. Empty: nobody may get the set, and that must be said in words. */
export function roleListText(roles: readonly Role[]): string {
  return roles.length > 0 ? roles.map((role) => roleLabels[role]).join(', ') : 'ни одной роли';
}

/** Russian plural form by count: 1 — `one`, 2–4 — `few`, 5–20 and 11–14 — `many`. */
function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** "affects 1 / 2 / 5 accounts" in Russian forms — accusative case, as in the preview summary. */
export function accountsWord(count: number): string {
  return plural(count, 'учётку', 'учётки', 'учёток');
}

/** "1 / 2 / 5 permissions will be added" in Russian forms. */
export function permissionsWord(count: number): string {
  return plural(count, 'право', 'права', 'прав');
}

/**
 * Impact summary: how many accounts are affected and how many **distinct** permissions are added
 * and removed.
 *
 * Permissions are counted as a set across all affected accounts, not summed per row: "2
 * permissions will be added" means two catalog permissions, not two people with one each. A per-row
 * sum over ten holders would say "20 permissions will be added" where two are added — and the
 * warning would read as a malfunction.
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
 * The summary in words — the "affects 7 accounts: 2 permissions added, 1 removed" from §12.
 *
 * Zero affected is not an empty string but a separate answer: a set assigned to nobody is edited
 * without consequences, and silence here would read as a preview that failed to load.
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

/** Tag marking a holder whose role is outside the compatible list. */
export const ROLE_MISMATCH_TAG = 'роль не в списке';

/**
 * The same mark for a pre-armed assignment (prepare step, ADR 0113) — in its own words.
 *
 * The role mismatch here is not a fault but a state by construction: the set is granted to a
 * holder of a role being retired one release before the migration and gives no permissions until
 * then — the role already gives them. Such a row must not be shown with the same orange "role not
 * in the list" tag: the administrator would see hundreds of warnings and "clean up" exactly the
 * grants the migration relies on.
 */
export const ROLE_MIGRATION_PENDING_TAG = 'ждёт перевода роли';

/**
 * Whether an assignment is armed by the role migration: granted by it while the holder is still on
 * the old role.
 */
export function isPendingRoleMigration(role: Role | null, origin: GrantOrigin): boolean {
  return origin === 'migration' && roleMigrationOf(role) !== null;
}

/**
 * The same in words, which cannot be done without: the tag reports the mismatch, but the
 * administrator needs its meaning — the grant is alive, yet the person has no permissions from it
 * at all (§13.1). A silent mass revocation is more dangerous than a mismatch, so the assignment
 * stays, and the screen must explain it.
 *
 * A pre-armed grant means the opposite, hence its own text: it gives no permissions by design, and
 * revoking it is the only way to spoil the migration.
 */
export function roleMismatchText(role: Role | null, origin: GrantOrigin = 'manual'): string {
  const migration = roleMigrationOf(role);
  if (origin === 'migration' && migration) {
    return `Набор выдан заранее: он заменит права роли «${roleLabels[migration.from]}», когда учётку переведут на «${roleLabels[migration.to]}». До перевода прав он не даёт — их даёт роль. Отзыв означает, что при переводе человек эти права потеряет.`;
  }
  const whose = role ? `Роль «${roleLabels[role]}»` : 'Роль не назначена, и она';
  return `${whose} не входит в список совместимых: выдача жива, но доступ по набору у этой учётки погашен — прав он ей не даёт.`;
}

/** What changes for one holder — in words, not as two code lists. */
export function userDeltaText(user: GrantImpactUserDto): string {
  if (user.roleMismatch) return 'прав по набору не получает: роль не в списке совместимых';
  const parts: string[] = [];
  if (user.added.length > 0) {
    parts.push(`добавится: ${user.added.map(permissionLabel).join(', ')}`);
  }
  if (user.removed.length > 0) {
    parts.push(`снимется: ${user.removed.map(permissionLabel).join(', ')}`);
  }
  // An empty delta is an answer too: the person is affected but neither gains nor loses anything.
  return parts.length > 0 ? parts.join('; ') : 'доступ не изменится';
}

/**
 * Barrier violations as server texts — from the preview and from a rejection alike.
 *
 * One parser for two response shapes on purpose: their halves are the same (`violations` — about
 * the set itself, `holders` — about the outcome for holders), and a second parser would give two
 * screens different words for one prohibition. Messages are not rebuilt: they are already written
 * with the culprit inside ("the 'account management' permission is not granted by grants…"), and
 * shortening them would lose the reason.
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

/** Violations shown by the preview: "cannot be saved like this" — before the click. */
export function impactViolationTexts(impact: GrantImpactDto): string[] {
  return violationTextsOf({ violations: impact.violations, holders: impact.holders });
}

/** Violations from a 400 rejection: parsed the same way as the preview. */
export function apiViolationTexts(error: unknown): string[] {
  return isApiError(error) ? violationTextsOf(error.details) : [];
}

/** Stale data: a 409 on the impact fingerprint or version — both have one outcome, "look again". */
export function isStaleConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}
