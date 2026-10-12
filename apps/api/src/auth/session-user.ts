import {
  type AuthUser,
  type CounterpartyType,
  type FeatureFlagKey,
  type Permission,
  permissionsFor,
  type Role,
  type RoleAddon,
} from '@technic/contracts';

/**
 * What the session builder reads from an account. Login and password change assemble it from their
 * own query (`userWithCounterpartyType` in `routes/auth.ts`), refresh and `/auth/me` pass the
 * principal (`loadPrincipal`) as is; the two readers must deliver the same subject, otherwise the
 * four session responses diverge on the next request.
 */
export interface AuthUserSource {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  /** Account phone (ADR 0043): the portal prefills it as the requester contact of a repair request. */
  phone: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  /** Account objects (ADR 0039): the portal narrows the object filter to them and prefills the form. */
  constructionObjectIds: string[];
  /** Account departments (ADR 0040): the second scope axis, used instead of objects, not with them. */
  departmentIds: string[];
  /** Department sites (ADR 0062): the derived scope of a department role in waste removal. */
  departmentObjectIds: string[];
  /** Counterparty type (ADR 0038): together with the role it defines the account's permissions. */
  counterpartyType: CounterpartyType | null;
  /**
   * Counterparty of the account (ADR 0010): the portal answers "was this request given to my
   * company?" with it. The type cannot answer that, it only names the module the side works in, and
   * without the id the portal approximated the answer by type (finding N7 of the office equipment
   * executor audit plan).
   *
   * Needs no query of its own: the column lies on the account row and arrives with it, both at
   * login (`userWithCounterpartyType`) and in the principal (`loadPrincipal`).
   */
  counterpartyId: string | null;
  /**
   * Role add-ons (ADR 0086), the third permission source. Since step 1c they are derived from the
   * grant codes (`systemAddonsOf`) instead of a separate read of `user_role_addons`; the response
   * shape stayed the same, the portal still draws the badge next to the role from it.
   */
  addons: RoleAddon[];
  /**
   * Codes of assigned grants (ADR 0106): the portal learns the business profile of the office
   * equipment module from them (profiles plan, R9): discussion side, signature, future mail. They
   * are not permissions and take no part in `can`. The portal switched to them before the dead
   * `serviceRequests.approveIt` was removed, not after; the other order would have silently switched
   * off the "system administrator" profile.
   *
   * Read by the same reader and in the same place as `addons`: the badges are derived from these very
   * codes (`systemAddonsOf`), so the two cannot arrive by different paths.
   */
  grantCodes: string[];
  /**
   * Permissions of assigned grants (ADR 0106), the fourth source of the access subject. Without it
   * the subject here is truncated: a grant assembled by an administrator shows up neither in the
   * role nor in the add-ons, and the computed list would differ from the one the server checks on
   * the next request (`loadPrincipal`).
   *
   * Already filtered by `isPermission`: an orphan permission (removed from the dictionary by a
   * release) is dropped by the reader at the "database to code" boundary, the same way and in the
   * same place as for the principal.
   */
  grantPermissions: Permission[];
}

/**
 * The only builder of the user in session responses: login, `refresh`, `/auth/me` and password
 * change all call it. One builder for four responses on purpose: the plan (§10.1) requires the
 * permission list in all four, and four separate builders would drift apart at the first change of
 * the access model.
 *
 * It lives outside `routes/auth.ts` so that it can be tested without a database: the route module
 * reads the environment and opens a pool at import (`config`, `db/client`), while the guard on the
 * completeness of the permission list (`test/auth-session-permissions.test.ts`) has to run in the
 * everyday gate. Keep this module free of anything that touches the environment or the database.
 *
 * Enabled feature switches come as the SECOND ARGUMENT instead of being read here: the builder is
 * synchronous and pure, it only lays out what has already been read. A database call inside it
 * would turn each of the four responses into an implicit query hidden from the reader.
 */
export function makeAuthUser(u: AuthUserSource, features: FeatureFlagKey[]): AuthUser {
  return {
    id: u.id,
    email: u.email,
    lastName: u.lastName,
    firstName: u.firstName,
    middleName: u.middleName,
    fullName: u.fullName,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    constructionObjectIds: u.constructionObjectIds,
    departmentIds: u.departmentIds,
    departmentObjectIds: u.departmentObjectIds,
    counterpartyType: u.counterpartyType,
    counterpartyId: u.counterpartyId,
    addons: u.addons,
    // Grant codes sit next to the add-ons for the same reason as the permission list below: the
    // portal must learn the module profile from all four session responses, not only `/auth/me`.
    grantCodes: u.grantCodes,
    /*
     * Effective permissions of the account (ADR 0106, decision 5). The server computes them because
     * the portal no longer can: the composition of a grant lives in the database, not in the matrix.
     * The subject is passed whole (`u` is an `AccessSubject`: role, counterparty type, add-ons,
     * grant permissions) and must not be trimmed here: a missing source does not look like an
     * error, only like a shorter permission list.
     *
     * **The order is the dictionary order (`PERMISSIONS`), and it is part of the contract, not a
     * side effect.** `permissionsFor` sets it (`PERMISSIONS.filter(...)`), and nothing here reorders
     * the list, neither alphabetically nor by the database answer. The client is going to compare
     * lists (refresh the menu after `refresh`, notice an access change), and comparing arrays with
     * an unstable order reports "permissions changed" on an unchanged set: either a needless
     * re-render or trust in a comparison that does not deserve it. Alphabetical order would also
     * break the dictionary's grouping by module, which keeps the list readable in diagnostics.
     *
     * A copy rather than the `readonly` array from the contracts: `AuthUser` is a response body,
     * and there is no reason to keep a reference to the array the matrix returned.
     */
    permissions: [...permissionsFor(u)],
    /*
     * Grant permissions as a field of their own next to the total, and it is not a duplicate (see
     * `AuthUser` in the contracts). The total `permissions` answers the portal's `can`; the shared
     * predicates, identical on server and portal, ask the SUBJECT and add up its sources themselves.
     * Without this field the portal's subject is short exactly by the grants that have no add-on.
     * Since the IT service grant was split (profiles plan, E6) that is no longer harmless: executor
     * actions moved to the module grant `office_equipment_executor`, and the system administrator's
     * menu would diverge from the server's answer.
     *
     * A copy, not a reference, for the same reason as `permissions`: this is a response body.
     */
    grantPermissions: [...u.grantPermissions],
    /*
     * Enabled intake switches (plan `docs/office-equipment-request-subject-plan.md`, R10).
     *
     * In all four session responses and for the same reason as the permissions above: the portal
     * draws screens from the login response before it asks `/auth/me`. Returned in one place only,
     * candidate intake would be open or closed depending on how the person signed in. `refresh`
     * delivers an emergency switch-off to the tab through the same field, without a page reload.
     *
     * The list is not a permission and grants no access: `POST /service-requests` reads the same
     * database row itself and does not trust the list sent by the client. It is here only so that
     * the portal does not show a door with a refusal behind it.
     */
    features,
  };
}
