import { describe, expect, it } from 'vitest';
import {
  ADMIN_GRANT_CODES,
  ADMIN_GRANTS,
  ALL_SYSTEM_GRANT_CODES,
  COUNTERPARTY_TYPES,
  FEATURE_FLAGS,
  MODULE_GRANT_CODES,
  MODULE_GRANTS,
  PERMISSIONS,
  permissionsFor,
  ROLE_ADDON_BASE_ROLES,
  ROLE_ADDON_PERMISSIONS,
  ROLE_ADDONS,
  ROLE_GRANT_CODES,
  ROLE_GRANTS,
  ROLES,
  SYSTEM_GRANT_CODES,
  validateGrantAssignment,
  type AccessSubject,
  type AuthUser,
  type CounterpartyType,
  type FeatureFlagKey,
  type Permission,
  type Role,
  type RoleAddon,
} from '@technic/contracts';
import { type AuthUserSource, makeAuthUser } from '../src/auth/session-user';

/**
 * Guard G1: every session response (login, `refresh`, `/auth/me`, password change) carries the
 * complete permission list, that is `permissionsFor` of the full access subject in dictionary order.
 *
 * All four responses go through one builder, `makeAuthUser`. A builder that drops a permission
 * source (role, counterparty type, add-ons, grant permissions) does not fail loudly: it returns a
 * shorter list, and the portal hides a section from someone the server lets in. So the builder is
 * swept over every subject the contracts can describe and its list must equal `permissionsFor` for
 * the same subject, built here independently from the axis values.
 *
 * Separate from `auth-permissions.db.test.ts` on purpose. That suite proves the loading side (the
 * SQL readers deliver the full subject to each of the four routes) and is skipped without
 * `TEST_DATABASE_URL`. The everyday gate (`pnpm check`) runs without a database, so the builder half
 * of the guarantee lives here and needs nothing but the contracts.
 */

/** A grant composition together with the roles it is compatible with. */
interface CatalogueEntry {
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
}

/**
 * The system grant catalogue, assembled from the contracts' own lists so that a new grant is swept
 * without touching this file. The two transitional codes keep their composition in the add-on
 * tables (`SYSTEM_GRANT_CODES` is declared `satisfies readonly RoleAddon[]`); the other three lists
 * carry it as `CatalogGrant`. The test below fails if `ALL_SYSTEM_GRANT_CODES` gains a list that is
 * not assembled here, instead of silently leaving those grants out of the sweep.
 */
const CATALOGUE: ReadonlyMap<string, CatalogueEntry> = new Map<string, CatalogueEntry>([
  ...SYSTEM_GRANT_CODES.map((code): [string, CatalogueEntry] => [
    code,
    { roles: ROLE_ADDON_BASE_ROLES[code], permissions: ROLE_ADDON_PERMISSIONS[code] },
  ]),
  ...ADMIN_GRANT_CODES.map((code): [string, CatalogueEntry] => [code, ADMIN_GRANTS[code]]),
  ...ROLE_GRANT_CODES.map((code): [string, CatalogueEntry] => [code, ROLE_GRANTS[code]]),
  ...MODULE_GRANT_CODES.map((code): [string, CatalogueEntry] => [code, MODULE_GRANTS[code]]),
]);

/**
 * The compatibility gate of `grantPermissionsExpr`: a held grant gives permissions only while its
 * `grant_roles` contain the account's role. An account without a role matches no row.
 */
function active(role: Role | null, entry: CatalogueEntry): boolean {
  return role !== null && entry.roles.includes(role);
}

/**
 * Grant permissions as the reader hands them over: `array_agg(DISTINCT ...)` deduplicates and in
 * practice sorts as text, so the input is not in dictionary order. The response order must not
 * depend on it.
 */
function databaseOrder(permissions: Iterable<Permission>): Permission[] {
  return [...new Set(permissions)].sort();
}

interface GrantHolding {
  readonly label: string;
  readonly codes: string[];
  readonly permissions: Permission[];
}

/**
 * Grant states of an account with this role: none; each catalogue grant alone (active, or held but
 * gated out by the role); the whole catalogue at once; and the widest custom grant an administrator
 * may assemble for the role, i.e. every permission that passes the set barriers of
 * `validateGrantAssignment` (non-grantable permissions, the driver role, the axis × module matrix).
 */
function grantHoldings(role: Role | null): GrantHolding[] {
  const single = [...CATALOGUE].map(([code, entry]) => ({
    label: active(role, entry) ? code : `${code} (gated out)`,
    codes: [code],
    permissions: active(role, entry) ? databaseOrder(entry.permissions) : [],
  }));
  const whole = {
    label: 'whole catalogue',
    codes: [...CATALOGUE.keys()],
    permissions: databaseOrder(
      [...CATALOGUE.values()].flatMap((entry) => (active(role, entry) ? entry.permissions : [])),
    ),
  };
  const assembled = {
    label: 'widest assembled grant',
    codes: ['assembled-by-admin'],
    permissions:
      role === null
        ? []
        : databaseOrder(
            PERMISSIONS.filter(
              (permission) =>
                validateGrantAssignment({
                  roles: [role],
                  permissions: [permission],
                  subjectPermissionsAfter: null,
                  subjectRole: null,
                }).length === 0,
            ),
          ),
  };
  return [{ label: 'no grants', codes: [], permissions: [] }, ...single, whole, assembled];
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((set) => [...set, item])], [[]]);
}

const ROLE_AXIS: readonly (Role | null)[] = [...ROLES, null];
const COUNTERPARTY_AXIS: readonly (CounterpartyType | null)[] = [null, ...COUNTERPARTY_TYPES];
const ADDON_AXIS: readonly RoleAddon[][] = subsets(ROLE_ADDONS);
/** Scope fields take no part in permissions; both states prove the builder does not mix them in. */
const SCOPE_AXIS = [
  { label: 'no scope', constructionObjectIds: [], departmentIds: [], departmentObjectIds: [] },
  {
    label: 'scoped',
    constructionObjectIds: ['object-a', 'object-b'],
    departmentIds: ['department-a'],
    departmentObjectIds: ['object-c'],
  },
] as const;

/**
 * The login path passes the whole `users` row to the builder; its extra columns must not reach the
 * response body, and the full-shape comparison below catches a builder that spreads its input.
 */
type SessionRow = AuthUserSource & {
  passwordHash: string;
  authVersion: number;
  personId: string | null;
};

interface Combo {
  readonly label: string;
  readonly row: SessionRow;
  readonly subject: AccessSubject;
}

function combosFor(role: Role | null): Combo[] {
  const combos: Combo[] = [];
  for (const counterpartyType of COUNTERPARTY_AXIS) {
    for (const addons of ADDON_AXIS) {
      for (const grants of grantHoldings(role)) {
        for (const scope of SCOPE_AXIS) {
          const row: SessionRow = {
            id: 'user-1',
            email: 'holder@example.invalid',
            lastName: 'Holder',
            firstName: 'Session',
            middleName: 'Test',
            fullName: 'Holder Session Test',
            phone: '+70000000000',
            role,
            isActive: true,
            mustChangePassword: false,
            constructionObjectIds: [...scope.constructionObjectIds],
            departmentIds: [...scope.departmentIds],
            departmentObjectIds: [...scope.departmentObjectIds],
            counterpartyType,
            counterpartyId: counterpartyType ? `counterparty-${counterpartyType}` : null,
            addons,
            grantCodes: grants.codes,
            grantPermissions: grants.permissions,
            passwordHash: 'not-a-real-hash',
            authVersion: 7,
            personId: null,
          };
          combos.push({
            label: [
              role ?? 'no role',
              counterpartyType ?? 'no counterparty',
              addons.length > 0 ? addons.join('+') : 'no add-ons',
              grants.label,
              scope.label,
            ].join(' / '),
            row,
            // Built from the axis values, not read back from the row: the expectation must not be
            // computed from the builder's own input object.
            subject: {
              role,
              counterpartyType,
              addons,
              grantPermissions: grants.permissions,
              grantCodes: grants.codes,
            },
          });
        }
      }
    }
  }
  return combos;
}

const ALL_COMBOS: readonly Combo[] = ROLE_AXIS.flatMap(combosFor);
const SWEEP_FEATURES: FeatureFlagKey[] = [...FEATURE_FLAGS];

const DICTIONARY_INDEX: ReadonlyMap<Permission, number> = new Map(
  PERMISSIONS.map((permission, index) => [permission, index]),
);

/** Strictly increasing dictionary index: dictionary order and no duplicates. */
function inDictionaryOrder(list: readonly Permission[]): boolean {
  return list.every(
    (permission, i) =>
      i === 0 || DICTIONARY_INDEX.get(list[i - 1]!)! < DICTIONARY_INDEX.get(permission)!,
  );
}

function expectedUser(
  row: SessionRow,
  subject: AccessSubject,
  features: FeatureFlagKey[],
): AuthUser {
  return {
    id: row.id,
    email: row.email,
    lastName: row.lastName,
    firstName: row.firstName,
    middleName: row.middleName,
    fullName: row.fullName,
    phone: row.phone,
    role: row.role,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    constructionObjectIds: row.constructionObjectIds,
    departmentIds: row.departmentIds,
    departmentObjectIds: row.departmentObjectIds,
    counterpartyType: row.counterpartyType,
    counterpartyId: row.counterpartyId,
    addons: row.addons,
    grantCodes: row.grantCodes,
    permissions: [...permissionsFor(subject)],
    grantPermissions: row.grantPermissions,
    features,
  };
}

/**
 * How each field of the access subject is removed when checking that the sweep would notice it
 * missing. A mapped type over `AccessSubject`, so a new subject field does not compile until it is
 * declared here either as a permission source or as one the matrix does not read.
 */
const DROP_SOURCE: { [K in keyof Required<AccessSubject>]: (s: AccessSubject) => AccessSubject } = {
  role: (s) => ({ ...s, role: null }),
  counterpartyType: (s) => ({ ...s, counterpartyType: null }),
  addons: (s) => ({ ...s, addons: [] }),
  grantPermissions: (s) => ({ ...s, grantPermissions: [] }),
  grantCodes: (s) => ({ ...s, grantCodes: [] }),
};

/** Grant codes say what is held, not what is allowed: `can` does not read them (profiles plan, R9). */
const NOT_A_PERMISSION_SOURCE: ReadonlySet<keyof AccessSubject> = new Set(['grantCodes']);

describe('session builder carries the complete permission list (G1, no database)', () => {
  it('the swept catalogue is the whole system grant catalogue', () => {
    expect([...CATALOGUE.keys()].sort()).toEqual([...ALL_SYSTEM_GRANT_CODES].sort());
  });

  it.each(ROLE_AXIS.map((role) => [role ?? 'no role', role] as const))(
    'permissions equal permissionsFor of the full subject in dictionary order: %s',
    (_, role) => {
      for (const { label, row, subject } of combosFor(role)) {
        const user = makeAuthUser(row, SWEEP_FEATURES);
        expect(user.permissions, label).toEqual(permissionsFor(subject));
        expect(inDictionaryOrder(user.permissions), `${label}: dictionary order`).toBe(true);
        expect(user, label).toEqual(expectedUser(row, subject, SWEEP_FEATURES));
      }
    },
  );

  /*
   * The equality above is only as strong as the subjects it runs on: if no swept subject got
   * anything from, say, its grants, a builder ignoring grants would pass. So every permission
   * source must change the list on at least one swept subject, and the one field the matrix does
   * not read must change it on none.
   */
  it.each(Object.keys(DROP_SOURCE) as (keyof AccessSubject)[])(
    'the sweep would notice a builder that drops %s',
    (field) => {
      const changed = ALL_COMBOS.filter(
        ({ subject }) =>
          permissionsFor(DROP_SOURCE[field](subject)).join() !== permissionsFor(subject).join(),
      ).length;
      if (NOT_A_PERMISSION_SOURCE.has(field)) expect(changed, field).toBe(0);
      else expect(changed, field).toBeGreaterThan(0);
    },
  );

  it('the sweep contains lists whose dictionary order differs from alphabetical order', () => {
    const differs = ALL_COMBOS.some(({ subject }) => {
      const list = permissionsFor(subject);
      return list.join() !== [...list].sort().join();
    });
    expect(differs).toBe(true);
  });

  it('enabled switches pass through untouched', () => {
    const { row } = combosFor('shtab')[0]!;
    const lists: FeatureFlagKey[][] = [
      [],
      [...FEATURE_FLAGS],
      ...FEATURE_FLAGS.map((flag) => [flag]),
    ];
    for (const features of lists) {
      expect(makeAuthUser(row, features).features).toEqual(features);
    }
  });
});
