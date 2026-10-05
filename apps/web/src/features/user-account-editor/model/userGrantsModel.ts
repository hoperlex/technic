import {
  GRANT_MODULE_WIDE_SCOPE,
  OFFICE_EQUIPMENT_PROFILE_REGISTRY,
  OFFICE_EQUIPMENT_PROFILES,
  permissionsFor,
  roleLabels,
  type CounterpartyType,
  type GrantDto,
  type GrantStatement,
  type OfficeEquipmentProfileId,
  type Permission,
  type Role,
  type UserGrantRefDto,
} from '@technic/contracts';
import { permissionLabel } from '@entities/grant';

/**
 * The "Grants" field of the account window, computed apart from the screen (plan "grants are
 * assigned in the account window", R4 and §6): checkbox hydration, statement assembly and the
 * "will be added" line.
 *
 * It lives in its own file rather than inside the component for one reason: **the request body
 * here is not equal to the checkbox group value**, and this is the least obvious part of the
 * feature. The group holds only compatible checked grant sets, yet the form must also speak about
 * what vanished from the group — an assignment that the role change extinguishes (§6, "body
 * serialization"). This rule is checked by value-level unit tests, not by clicking through markup:
 * spread across handlers it could only be tested through the screen, which is noticeably worse.
 *
 * There is not a single line of its own notion of compatibility here: what is compatible with the
 * resulting role is told by the catalog the server filtered by role (`grantFormApi.catalog`), and
 * what was in effect before the edit is the assignment's `roleMismatch`, also computed by the
 * server. A second copy of either rule would drift from the server on the first `grant_roles` edit.
 */

/**
 * What the administrator touched by hand while the window is open — two stable sets (R4).
 *
 * The second one (`unchecked`) is not a luxury: without it an unchecked box would come back on its
 * own at the next role change — hydration starts from **assigned** grants, and a set stays assigned
 * until save. A person would uncheck a grant, change the role and save it back without noticing.
 *
 * They live exactly until the window closes: the decision is made in a single sitting.
 */
export interface GrantManualEdits {
  /** Checked by hand — including those not yet assigned to the account. */
  checked: readonly string[];
  /** Unchecked by hand: hydration must not bring them back. */
  unchecked: readonly string[];
}

/** Nothing touched: the window opens in this state and returns to it on close. */
export const NO_GRANT_EDITS: GrantManualEdits = { checked: [], unchecked: [] };

/** Assignments the form does not allow to remove: armed by the role migration (R4, ADR 0113). */
export function lockedGrantIds(assigned: readonly UserGrantRefDto[]): Set<string> {
  return new Set(assigned.filter((g) => g.origin === 'migration').map((g) => g.id));
}

/**
 * An office equipment module profile as a dropdown option (office equipment profiles plan, R7).
 *
 * The list is built FROM THE CONTRACTS REGISTRY (`OFFICE_EQUIPMENT_PROFILE_REGISTRY`), not from a
 * local "profile → grant sets" table: a second such table would drift from the first just as
 * silently as a copy of the compatibility rules would — and the administrator would grant half a
 * profile believing they had granted the whole one.
 *
 * Filtering by the catalog is the same way the form shows a set's incompatibility: the catalog is
 * filtered by the server for the selected role, and a profile none of whose codes this role may
 * hold has nothing to offer — choosing it would check nothing.
 *
 * The "service center" profile IS ALWAYS IN THE LIST AND ALWAYS DISABLED (R11). It is not
 * granted by codes at all, and catalog filtering would drop it first — which is exactly what must
 * not happen: the administrator looks for all four profiles in the list, and a silently missing one
 * would read as "no such profile" or "I have already granted it". The label explains how it is
 * actually granted: an empty code list in the registry is a statement about the granting method,
 * not an omission.
 */
export interface GrantProfileOption {
  value: OfficeEquipmentProfileId;
  /** Option label: for a disabled option it is also the explanation — there is no other place. */
  label: string;
  /** Not granted by codes: cannot be chosen, but must be visible. */
  disabled: boolean;
}

/** What grants the "service center" profile instead of a grant set — verbatim the pair from R2. */
const SERVICE_PROFILE_HINT =
  'выдаётся ролью «Оператор» и контрагентом сервисной компании, не здесь';

export function grantProfileOptions(catalog: readonly GrantDto[]): GrantProfileOption[] {
  const codes = new Set(catalog.map((g) => g.code));
  return OFFICE_EQUIPMENT_PROFILES.flatMap<GrantProfileOption>((value) => {
    const profile = OFFICE_EQUIPMENT_PROFILE_REGISTRY[value];
    if (profile.grants.length === 0) {
      return [{ value, label: `${profile.label} — ${SERVICE_PROFILE_HINT}`, disabled: true }];
    }
    if (!profile.grants.some((code) => codes.has(code))) return [];
    return [{ value, label: profile.label, disabled: false }];
  });
}

/**
 * Codes of the selected profile — what goes into the hydration's **suggested** set (R7), nothing
 * more.
 *
 * Choosing a profile SAVES NOTHING AND CHECKS NOTHING BY ITSELF: it only extends the third set of
 * the formula, while the outcome is decided by assigned grants, manual checks and manual unchecks.
 * Four properties come for free that would otherwise each need separate work: a manual uncheck is
 * not undone (unchecks are subtracted last), a role change extinguishes incompatible sets on its
 * own (intersection with the catalog), incompatible sets never reach the server (the body is built
 * from the same value), and "privilege escalation" remains the administrator saving the form — not
 * a side effect of picking from a list.
 *
 * Both codes of the IT profile go together, in one statement (`buildGrantStatements` assembles the
 * whole body in one request): half a profile is a person who can be assigned as executor but does
 * not see the module, or the other way round.
 */
export function profilePresetCodes(profile: OfficeEquipmentProfileId | null): readonly string[] {
  return profile ? OFFICE_EQUIPMENT_PROFILE_REGISTRY[profile].grants : [];
}

/**
 * The checkbox group value (R4; plan "the registration wish fills the activation form", §3.6):
 *
 * ```text
 * ((assigned ∪ suggested ∪ checked_by_hand) \ unchecked_by_hand) ∩ grant_sets_of_resulting_role
 * ```
 *
 * Recomputed on open and on **every** role change — otherwise the very transition the range exists
 * for breaks: for `shtab` the migration-armed `vehicle_ordering` is incompatible and hidden; on a
 * switch to `site` it enters the range, and if left unchecked the server would revoke it together
 * with its `id`, which the role migration rollback looks for.
 *
 * **Suggested** is the third set, and the wish-based prefill happens here rather than by a separate
 * assignment into the field, for three properties the formula gives for free (§3.6): a manual
 * uncheck is not undone (`unchecked_by_hand` is subtracted last); a role change extinguishes the
 * suggestion on its own — "vehicle ordering" is compatible only with `site` and drops out of the
 * intersection under another role; incompatible sets never reach the server, because
 * `buildGrantStatements` builds the body from this same value.
 *
 * Migration-armed grants are removed from `unchecked_by_hand` right here: they cannot be unchecked,
 * and if one got there by a bypass (stale markup, someone else's edit), silently losing part of the
 * migration would cost more than an extra check.
 *
 * Order follows the catalog: the list is read by eye and must not jump around when checked.
 */
export function hydrateGrantSelection(input: {
  assigned: readonly UserGrantRefDto[];
  catalog: readonly GrantDto[];
  edits: GrantManualEdits;
  /**
   * Codes of grant sets suggested by the applicant's wish (§3.6). A missing field and an empty list
   * are the same thing: an ordinary account and a newly created one have no prefill at all.
   *
   * Codes rather than ids, and this matters: a set's code is stable forever, a catalog row's `id`
   * is not. Translation into ids goes through the catalog the server filtered for the selected
   * role — the form keeps no second notion of what each role may hold. A code absent from the live
   * catalog (set renamed, different role) is silently not found: the catalog is the source of truth
   * here, not a table of defaults.
   */
  suggestedCodes?: readonly string[];
}): string[] {
  const { assigned, catalog, edits, suggestedCodes = [] } = input;
  const locked = lockedGrantIds(assigned);
  const wanted = new Set(assigned.map((g) => g.id));
  const suggested = new Set(suggestedCodes);
  for (const grant of catalog) if (suggested.has(grant.code)) wanted.add(grant.id);
  for (const id of edits.checked) wanted.add(id);
  // Unchecks go last, after suggestions: otherwise the prefill would restore a box the
  // administrator just unchecked, and would do so on every role change.
  for (const id of edits.unchecked) if (!locked.has(id)) wanted.delete(id);
  return catalog.filter((g) => wanted.has(g.id)).map((g) => g.id);
}

/**
 * A manual edit read off the group itself: what appeared goes to "checked", what vanished to
 * "unchecked".
 *
 * Computed as a difference of values, not from the checkbox event: `Checkbox.Group` emits the
 * resulting list, and intent can be recovered from it only by comparing with the previous one. The
 * sets are mutually exclusive — re-checking an unchecked box takes the person's word back entirely.
 */
export function applyGrantToggle(
  edits: GrantManualEdits,
  before: readonly string[],
  after: readonly string[],
): GrantManualEdits {
  const was = new Set(before);
  const now = new Set(after);
  const checked = new Set(edits.checked);
  const unchecked = new Set(edits.unchecked);
  for (const id of after)
    if (!was.has(id)) {
      checked.add(id);
      unchecked.delete(id);
    }
  for (const id of before)
    if (!now.has(id)) {
      unchecked.add(id);
      checked.delete(id);
    }
  return { checked: [...checked], unchecked: [...unchecked] };
}

/**
 * Assignments outside the resulting role's range: assigned, but void under this role (§13.1, §4.3).
 */
export function outOfRangeGrants(
  assigned: readonly UserGrantRefDto[],
  catalog: readonly GrantDto[],
): UserGrantRefDto[] {
  const inRange = new Set(catalog.map((g) => g.id));
  return assigned.filter((g) => !inRange.has(g.id));
}

/**
 * The request body (§6, "body serialization"):
 *
 * ```text
 * rows = managed assignments ∪ switched assignments ∪ checked grant sets
 * selected(id) = id ∈ checkbox group value
 * version(id)  = from the catalog; for an assignment outside it — from `UserAccountDto.grants`
 * ```
 *
 * **Switched** are those whose effect is changed by the role change itself: before the edit the set
 * was in effect (`roleMismatch: false`) and is incompatible with the new role — or vice versa.
 * Without such a row the `site → shtab` transition would reach the server silently, and the
 * completeness rule (§4.2) would answer 400 to a request that is correct in meaning: the
 * extinguished set is not in the group at all — it is incompatible and not shown as a checkbox.
 * Its `selected: false` means not "remove" but "I see it stops being in effect" (§4.3).
 *
 * If the role did not change there are no switched rows by definition, and the body carries no
 * extra rows: an assignment outside the role's range is not touched by the operation (R4).
 *
 * A set whose version is in neither the catalog nor the assignments is skipped: there is nothing to
 * say about it — what is signed is the composition, and it is unknown.
 */
export function buildGrantStatements(input: {
  assigned: readonly UserGrantRefDto[];
  catalog: readonly GrantDto[];
  selected: readonly string[];
  /** Role before the edit: the server computed `roleMismatch` from it. A new account has none. */
  roleBefore: Role | null;
  /** The role currently selected in the form — the one the catalog was filtered by. */
  roleAfter: Role | null;
}): GrantStatement[] {
  const { assigned, catalog, selected, roleBefore, roleAfter } = input;
  const inRange = new Set(catalog.map((g) => g.id));
  const chosen = new Set(selected);
  const versions = new Map<string, number>();
  for (const grant of assigned) versions.set(grant.id, grant.version);
  // Catalog wins over assignments: the composition the form showed in the hint is its version.
  for (const grant of catalog) versions.set(grant.id, grant.version);

  const spoken = new Set<string>();
  for (const grant of assigned) {
    const managed = inRange.has(grant.id);
    const switched = roleAfter !== roleBefore && !grant.roleMismatch !== managed; // before ≠ after
    if (managed || switched) spoken.add(grant.id);
  }
  for (const id of chosen) spoken.add(id);

  // Catalog order, then assignments outside the list: the body is read in debugging and tests, and
  // an order depending on set iteration would force sorting on both sides of every comparison.
  const order = [...catalog.map((g) => g.id), ...assigned.map((g) => g.id)];
  const rows: GrantStatement[] = [];
  const done = new Set<string>();
  for (const id of order) {
    if (!spoken.has(id) || done.has(id)) continue;
    const version = versions.get(id);
    if (version === undefined) continue;
    done.add(id);
    rows.push({ id, version, selected: chosen.has(id) });
  }
  return rows;
}

/**
 * The "will be added" line — **what the grants give beyond the position** (§6).
 *
 * Computed from two full subjects, not by subtracting from the account's permissions, and this is
 * not mere caution: the record's permission list describes the **previous** subject — before the
 * role change and before the counterparty type change — and for an unreviewed application it is
 * empty altogether, so the role's own permissions would land in the line.
 *
 * No compatibility gate is needed here: the composition is taken from checked sets, and only sets
 * compatible with the resulting role can be checked — the catalog is filtered by it.
 */
export function grantAddedPermissions(input: {
  role: Role | null;
  counterpartyType: CounterpartyType | null;
  catalog: readonly GrantDto[];
  selected: readonly string[];
}): Permission[] {
  const { role, counterpartyType, catalog, selected } = input;
  const chosen = new Set(selected);
  const grantPermissions = [
    ...new Set(catalog.filter((g) => chosen.has(g.id)).flatMap((g) => g.permissions)),
  ];
  const base = new Set(permissionsFor({ role, counterpartyType, grantPermissions: [] }));
  return permissionsFor({ role, counterpartyType, grantPermissions }).filter((p) => !base.has(p));
}

/** Modules where a grant set lifts scope narrowing (ADR 0106, decision 2), by showcase names. */
const SCOPE_MODULE_LABELS: Record<string, string> = {
  serviceRequests: 'Орг.техника: заявки',
  officeEquipment: 'Орг.техника: справочник',
};

/**
 * The same wide-scope table, keyed by plain string: a set's code comes from the database, where
 * administrator-built sets live alongside, and casting it to `SystemGrantCode` would promise the
 * opposite.
 */
const WIDE_SCOPE_BY_CODE = new Map<string, readonly string[]>(
  Object.entries(GRANT_MODULE_WIDE_SCOPE),
);

/**
 * Checkbox hint: the set's composition as permissions and — for a system set with wide scope — a
 * warning about it.
 *
 * Scope is stated as a separate phrase rather than implied by the composition: "IT approval"
 * differs from other sets not by a permission but by seeing the whole module, bypassing the role's
 * scope. Were the form silent about it, the administrator would grant the IT approval to a
 * department believing the person stays within their department.
 */
export function grantCompositionText(grant: GrantDto): string {
  const composition =
    grant.permissions.length > 0
      ? `Даёт: ${grant.permissions.map(permissionLabel).join(', ')}`
      : 'Прав в наборе нет: доступа он не даёт';
  const modules = WIDE_SCOPE_BY_CODE.get(grant.code) ?? [];
  if (modules.length === 0) return composition;
  const names = modules.map((m) => SCOPE_MODULE_LABELS[m] ?? m).join(', ');
  return `${composition}. Область: видит эти разделы целиком (${names}), а не только свой объект или отдел`;
}

/** How a set is named in messages: name in quotes — the same way the checkbox labels it. */
const grantNames = (grants: readonly UserGrantRefDto[]): string =>
  grants.map((g) => `«${g.name}»`).join(', ');

/**
 * The role change message — **about the consequence, not about removal** (R4).
 *
 * For add-ons the text read "add-on removed", and it was true: the form really removed an
 * incompatible add-on. Grant sets differ, and the difference is fundamental: the assignment stays
 * alive but yields no permissions — the compatibility gate extinguishes them on read. Were the form
 * to say "removed", the administrator would go grant the set again, while it never went anywhere.
 */
export function roleGateNoticeText(
  role: Role | null,
  extinguished: readonly UserGrantRefDto[],
): string | null {
  if (!role || extinguished.length === 0) return null;
  const names = grantNames(extinguished);
  return extinguished.length === 1
    ? `${names} роли «${roleLabels[role]}» не действует; назначение остаётся — снять его можно в реестре выдач`
    : `${names} роли «${roleLabels[role]}» не действуют; назначения остаются — снять их можно в реестре выдач`;
}

/**
 * Help text under the field: what is still assigned to the account but void under this role.
 *
 * Shown always, not only right after a role change: the person will close the message, but the
 * question "why is a set I definitely granted missing from the list" remains — and its answer must
 * be on screen at the moment it is asked.
 */
export function outOfRangeHintText(grants: readonly UserGrantRefDto[]): string | null {
  if (grants.length === 0) return null;
  return `Ещё выдано, но этой роли не действует: ${grantNames(grants)} — снять можно в реестре выдач`;
}
