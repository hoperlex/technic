import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import { ESLint } from 'eslint';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  ADMIN_GRANTS,
  can as matrixCan,
  canApproveMechRequest,
  allowedStatusTransitions,
  allowedVehicleRequestTransitions,
  allowedServiceStatusTransitions,
  attachableServiceFileKinds,
  canCoordinateServiceRequests,
  canOpenServiceEstimateDispute,
  canResolveServiceEstimateDispute,
  canRunServiceBulkOperation,
  canUseServiceBulk,
  isWaitingOn,
  MODULE_GRANTS,
  PERMISSIONS,
  permissionsFor,
  ROLE_GRANTS,
  type AccessSubject,
  type AuthUser,
  type CatalogGrant,
  type MechRequestDto,
  type Permission,
  type ServiceRequestDto,
} from '@technic/contracts';
import { permissionChecks } from '@entities/session';
import { vehicleRequestDateRules } from '@entities/vehicle-request';
import { mechMenuItems } from '../src/pages/mech/mechRequestMenu';
import { serviceGridView } from '../src/pages/service/serviceRequestGrid';
import { serviceRequestExtraItems } from '../src/pages/service/serviceRequestExtras';
import { serviceRequestMenuItems } from '../src/pages/service/serviceRequestMenu';
import { serviceStatusLine } from '@entities/service-request';
import type {
  ServiceMenuContext,
  ServiceRequestModals,
} from '../src/pages/service/serviceRequestModals';
import {
  serviceActionRow,
  serviceExecutorAssignment,
} from '../src/pages/service/serviceRequestRow';
import { authUser } from './factories/auth';
import { mechRequest } from './factories/mech';
import { assignedServiceRequest, serviceRequest, SERVICE_COUNTERPARTY } from './factories/service';

/**
 * ADR 0223: the portal decides permission-dependent availability by the server's list, never by
 * recomputing the contracts matrix. Two halves are pinned here.
 *
 * THE GUARD. A lint rule (`@typescript-eslint/no-restricted-imports` in `eslint.config.mjs`) keeps
 * the contracts' matrix readers — `can`, `canUse`, `permissionsFor` — out of `apps/web/src`, with a
 * short list of exceptions by file and by name. Lint and not a scan in this test, because the import
 * is the cheapest moment to catch the rule being broken and the editor shows it on the line; the
 * test only proves the rule is live (a rule confirmed by «some error» degrades silently with the
 * config) and that every exception still has its reason.
 *
 * THE EQUALITY. For every access profile — role × counterparty type, role × add-on, role × catalogue
 * grant — what the touched screens and predicates show with the portal's `can` over the shipped list equals what
 * the server's oracle answers: the same contract predicates with their default, the matrix over the
 * full principal. The list itself is pinned to that matrix by guard G1
 * (`apps/api/test/auth-session-permissions.test.ts`); this file pins the portal's side.
 *
 * Equality over subjects as production ships them cannot tell a portal that reads the list from one
 * that recomputes the matrix: both agree there by construction. So a second sweep hands the portal
 * an account the matrix CANNOT read — every grant permission stripped from the subject, the list
 * still carrying them, exactly a set assembled in production and unknown to the matrix — and adds
 * one permission at a time. A screen that asks the matrix anywhere answers differently there, and a
 * sensitivity check proves the sweep would see it for the sampled screens.
 */

// ── The guard ──────────────────────────────────────────────────────────────────────────────────

// vitest runs from apps/web (its config lives there), so the repository root is two levels up.
const REPO = path.resolve(process.cwd(), '../..');
const GUARD_RULE = '@typescript-eslint/no-restricted-imports';

/*
 * The root config, the one `npx eslint .` runs, not a copy: a copy would prove the copy. The React
 * version is pinned only to silence the plugin's «react is not installed» warning — resolved from
 * the repository root, it finds no `react` there; the guard does not depend on it.
 */
const eslint = new ESLint({
  cwd: REPO,
  overrideConfig: { settings: { react: { version: '19.2' } } },
});

async function guardMessages(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO, file) });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === GUARD_RULE)
    .map((message) => message.message);
}

const PROBE = 'apps/web/src/pages/probe/probe.ts';

describe('guard: no contracts matrix reader in the portal (ADR 0223)', () => {
  it.each(['can', 'canUse', 'permissionsFor'])('importing %s is an error', async (name) => {
    const messages = await guardMessages(
      PROBE,
      `import { ${name} } from '@technic/contracts';\nexport const probe = ${name};\n`,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ADR 0223');
  });

  it('an alias and a namespace import are caught too', async () => {
    expect(
      await guardMessages(
        PROBE,
        "import { can as hasPermission } from '@technic/contracts';\nexport const p = hasPermission;\n",
      ),
    ).toHaveLength(1);
    expect(
      await guardMessages(
        PROBE,
        "import * as contracts from '@technic/contracts';\nexport const p = contracts;\n",
      ),
    ).toHaveLength(1);
  });

  it('the rest of the contracts stays importable: scope and rules that are not permissions', async () => {
    expect(
      await guardMessages(
        PROBE,
        "import { isObjectScopedRole, type Permission } from '@technic/contracts';\n" +
          'export const p: [unknown, Permission | null] = [isObjectScopedRole, null];\n',
      ),
    ).toEqual([]);
  });

  /*
   * An exception opens one name in one file. The other readers stay closed there: the session
   * module may ask the matrix for the scope of `canUse`, never for a membership.
   */
  it('an exception opens only its own name', async () => {
    const session = 'apps/web/src/entities/session/model/authContext.tsx';
    expect(
      await guardMessages(
        session,
        "import { canUse } from '@technic/contracts';\nexport const p = canUse;\n",
      ),
    ).toEqual([]);
    expect(
      await guardMessages(
        session,
        "import { can } from '@technic/contracts';\nexport const p = can;\n",
      ),
    ).toHaveLength(1);
  });

  /*
   * A stale exception is a hole without a reason: the file stopped importing the name, and the next
   * edit there may import it for the session subject with nobody noticing. The list is read from
   * the config itself, so it cannot drift from what lint enforces.
   */
  it('every exception still imports the name it is allowed', async () => {
    const config = (await import(
      /* @vite-ignore */ pathToFileURL(path.join(REPO, 'eslint.config.mjs')).href
    )) as { MATRIX_READER_EXCEPTIONS: Record<string, readonly string[]> };
    const exceptions = Object.entries(config.MATRIX_READER_EXCEPTIONS);
    expect(exceptions.length).toBeGreaterThan(0);
    for (const [file, names] of exceptions) {
      const source = readFileSync(path.join(REPO, file), 'utf8');
      const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@technic\/contracts'/g)]
        .flatMap((match) => match[1]!.split(','))
        .map((spec) =>
          spec
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim(),
        );
      for (const name of names) expect(imported, `${file} → ${name}`).toContain(name);
    }
  });
});

// ── The equality ───────────────────────────────────────────────────────────────────────────────

type Can = (permission: Permission) => boolean;

/** The server's oracle over a principal: the matrix it builds the session list with (G1). */
const serverOracle =
  (user: AuthUser): Can =>
  (permission) =>
    matrixCan(user, permission);

/**
 * The account as production ships it for a subject: its fields and the list the server computed
 * (`permissionsFor`, pinned to the session builder by G1). The scope is fixed so that the scope
 * branches of the predicates are walked: own site `obj-1`, own department `dep-1` placed on it. The
 * id is the named executor of `assignedServiceRequest`, and the counterparty is the assigned one,
 * so executor branches are reachable for every subject that may take them.
 */
function shipped(subject: AccessSubject): AuthUser {
  return authUser({
    id: 'user-9',
    role: subject.role,
    counterpartyType: subject.counterpartyType ?? null,
    counterpartyId: subject.counterpartyType ? SERVICE_COUNTERPARTY.id : null,
    addons: [...(subject.addons ?? [])],
    grantCodes: [...(subject.grantCodes ?? [])],
    grantPermissions: [...(subject.grantPermissions ?? [])],
    constructionObjectIds: ['obj-1'],
    departmentIds: ['dep-1'],
    departmentObjectIds: ['obj-1'],
    permissions: [...permissionsFor(subject)],
  });
}

/**
 * The same account with every grant permission stripped from the SUBJECT while the list keeps
 * them: a set assembled in production, which the matrix over the shipped subject cannot see.
 * Grant codes stay — they name the module profile and are not permissions.
 */
function matrixBlind(subject: AccessSubject): AuthUser {
  return { ...shipped(subject), grantPermissions: [] };
}

/** Catalogue grants on every base profile of a role they are compatible with. */
function catalogueSubjects(): AccessSubject[] {
  const catalogue: [string, CatalogGrant][] = [
    ...Object.entries(ADMIN_GRANTS),
    ...Object.entries(ROLE_GRANTS),
    ...Object.entries(MODULE_GRANTS),
  ];
  const bases = ACCESS_PROFILES.filter((subject) => !subject.addons?.length);
  return catalogue.flatMap(([code, grant]) =>
    bases
      .filter((base) => base.role !== null && grant.roles.includes(base.role))
      .map((base) => ({ ...base, grantCodes: [code], grantPermissions: [...grant.permissions] })),
  );
}

const SUBJECTS: readonly AccessSubject[] = [...ACCESS_PROFILES, ...catalogueSubjects()];

const label = (subject: AccessSubject): string =>
  [accessProfileLabel(subject), ...(subject.grantCodes ?? [])].join(' / ');

// Moscow is UTC+3: 11:00 is before the 15:00 cut-off, 16:00 after it.
const CALENDAR_MOMENTS = ['2026-08-12T08:00:00.000Z', '2026-08-12T13:00:00.000Z'];
// Deeper than the correction limit, at it, inside it, yesterday, today and the next two days.
const CALENDAR_DAYS = [
  '2026-06-28',
  '2026-07-12',
  '2026-07-13',
  '2026-08-11',
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
];

/** The vehicle request calendar (`dateRules.ts`): the earliest day, the hint, the locked days. */
function calendar(user: AuthUser, can: Can): unknown {
  return CALENDAR_MOMENTS.map((moment) => {
    vi.setSystemTime(new Date(moment));
    const rules = vehicleRequestDateRules(user, can);
    return {
      min: rules.minDate.format('YYYY-MM-DD'),
      hint: !!rules.leadTimeHint,
      locked: CALENDAR_DAYS.filter((key) => rules.disabledDate(dayjs(key).startOf('day'))),
    };
  });
}

const MECH_REQUESTS: readonly MechRequestDto[] = [
  mechRequest(),
  mechRequest({ objectId: 'obj-2' }),
  mechRequest({ departmentId: 'dep-1' }),
  mechRequest({ approvedAt: '2026-08-02T08:00:00.000Z', approvedBy: 'user-r' }),
  mechRequest({ status: 'confirmed', approvedAt: '2026-08-02T08:00:00.000Z', lessorId: 'cp-1' }),
  mechRequest({
    status: 'confirmed',
    approvedAt: '2026-08-02T08:00:00.000Z',
    lessorId: 'cp-1',
    actualFrom: '2026-08-03',
  }),
  // A running rental with a pending extension request: the extension visa decides it.
  mechRequest({
    status: 'confirmed',
    approvedAt: '2026-08-02T08:00:00.000Z',
    lessorId: 'cp-1',
    actualFrom: '2026-08-03',
    extension: {
      status: 'pending',
      newPlannedTo: '2026-08-24',
      previousPlannedTo: '2026-08-17',
      reason: 'Бетонирование сдвинулось',
      requestedBy: 'user-1',
      requestedByName: 'Диспетчеров Д. П.',
      requestedAt: '2026-08-10T08:00:00.000Z',
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      decisionComment: '',
    },
  }),
  mechRequest({ status: 'done', actualFrom: '2026-08-03', actualTo: '2026-08-10' }),
];

const noop = () => {};

/** The mechanization menu, including the status corridor supplied by the session list. */
function mechMenu(user: AuthUser, can: Can): unknown {
  return MECH_REQUESTS.map((request) => ({
    visa: canApproveMechRequest(user, request, can),
    items: mechMenuItems(request, {
      user,
      can,
      open: {
        takeInWork: noop,
        editDeal: noop,
        issue: noop,
        revokeIssue: noop,
        extend: noop,
        decideExtension: noop,
        complete: noop,
        cancel: noop,
        rollbackToNew: noop,
      },
      run: {
        rollback: noop,
        setApproval: noop,
        duplicate: noop,
        remove: noop,
        withdrawExtension: noop,
      },
    }).map((item) => item.key),
  }));
}

/** The office equipment list's column set (`serviceGridView`). */
function serviceGrid(user: AuthUser, can: Can): unknown {
  return serviceGridView(user, can);
}

const consumableLine = {
  id: 'line-1',
  consumableId: 'consumable-1',
  code: 'C-1',
  name: 'Картридж',
  color: null,
  requestedQuantity: 1,
  issuedQuantity: null,
  issueNote: '',
};

const SERVICE_REQUESTS: readonly ServiceRequestDto[] = [
  serviceRequest(),
  assignedServiceRequest({ status: 'in_work' }),
  assignedServiceRequest({ status: 'in_work', kind: 'consumable', consumables: [] }),
  assignedServiceRequest({ status: 'done', kind: 'consumable', consumables: [consumableLine] }),
  serviceRequest({ status: 'in_work', kind: 'consumable', consumables: [consumableLine] }),
];

/*
 * Windows are never opened here — only the item keys are compared — so the windows object stays
 * empty, and a missing handler would fail loudly only if an item were clicked.
 */
const NO_MODALS = {} as ServiceRequestModals;
const NO_RUN: ServiceMenuContext['run'] = { start: noop, approve: noop, rollbackStart: noop };

/** The office equipment items around a request (`serviceRequestExtras.tsx`). */
function serviceExtras(user: AuthUser, can: Can): unknown {
  return SERVICE_REQUESTS.map((request) =>
    serviceRequestExtraItems(
      request,
      { user, can, modals: NO_MODALS, run: NO_RUN },
      serviceExecutorAssignment(request, user),
      serviceActionRow(request),
      true,
    ).map((item) => item.key),
  );
}

/** The service menu and the contract predicates that other portal surfaces ask directly. */
function serviceMenu(user: AuthUser, can: Can): unknown {
  return SERVICE_REQUESTS.map((request) =>
    serviceRequestMenuItems(request, { user, can, modals: NO_MODALS, run: NO_RUN }).map(
      (item) => item.key,
    ),
  );
}

function remainingPredicates(user: AuthUser, can: Can): unknown {
  const request = assignedServiceRequest({ status: 'in_work' });
  const assignment = serviceExecutorAssignment(request, user);
  return {
    waste: allowedStatusTransitions('done', user, 'waste', can),
    vehicle: allowedVehicleRequestTransitions('new', user, true, can),
    service: allowedServiceStatusTransitions(request.status, user, assignment, can),
    bulk: canUseServiceBulk(user, can),
    bulkOperations: [
      'cancel',
      'accept',
      'hold',
      'resume',
      'urgency_on',
      'assign',
      'start',
      'archive',
    ].map((operation) =>
      canRunServiceBulkOperation(
        user,
        operation as Parameters<typeof canRunServiceBulkOperation>[1],
        can,
      ),
    ),
    documents: attachableServiceFileKinds(
      request.status,
      request.audience,
      user,
      assignment,
      serviceActionRow(request),
      can,
    ),
    coordinator: canCoordinateServiceRequests(user, can),
    dispute: [
      canOpenServiceEstimateDispute(
        { ...serviceActionRow(request), status: 'in_work' },
        user,
        { exemptionApplied: true, disputeOpen: false },
        can,
      ),
      canResolveServiceEstimateDispute(
        { ...serviceActionRow(request), status: 'on_hold' },
        user,
        { disputeOpen: true },
        can,
      ),
    ],
    waiting: ['it', 'approval', 'operator'].map((side) =>
      isWaitingOn(user, side as Parameters<typeof isWaitingOn>[1], can),
    ),
    statusLine: serviceStatusLine(request, user, can),
  };
}

type Screen = (user: AuthUser, can: Can) => unknown;
type ScreenName =
  'calendar' | 'mechMenu' | 'serviceGrid' | 'serviceExtras' | 'serviceMenu' | 'remainingPredicates';
const SCREEN_NAMES: readonly ScreenName[] = [
  'calendar',
  'mechMenu',
  'serviceGrid',
  'serviceExtras',
  'serviceMenu',
  'remainingPredicates',
];
/** As production ships the account: every item, the corridor included. */
const SHIPPED_SCREENS: Record<ScreenName, Screen> = {
  calendar,
  mechMenu,
  serviceGrid,
  serviceExtras,
  serviceMenu,
  remainingPredicates,
};
/** On a matrix-blind account every screen must ask the list, including transition corridors. */
const BLIND_SCREENS: Record<ScreenName, Screen> = SHIPPED_SCREENS;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});

describe('the portal answers what the server answers, profile by profile (ADR 0223)', () => {
  it('server callers retain the matrix default for bulk gates', () => {
    const admin = shipped({ role: 'admin' });
    expect(canUseServiceBulk(admin)).toBe(true);
    expect(canRunServiceBulkOperation(admin, 'cancel')).toBe(true);
  });

  it('the sweep covers every access profile and the catalogue grants', () => {
    expect(SUBJECTS.length).toBeGreaterThan(ACCESS_PROFILES.length);
  });

  it.each(SCREEN_NAMES)('%s: as production ships the account', (name) => {
    const screen = SHIPPED_SCREENS[name];
    for (const subject of SUBJECTS) {
      const user = shipped(subject);
      expect(screen(user, permissionChecks(user).can), label(subject)).toEqual(
        screen(user, serverOracle(user)),
      );
    }
  });

  /*
   * One permission at a time on top of each base profile, delivered by an assembled grant the
   * matrix over the portal's subject cannot see. The server's answer is computed on the full
   * principal (the grant included); the portal's on the matrix-blind account with its list.
   */
  it.each(SCREEN_NAMES)('%s: a grant the matrix cannot see', (name) => {
    const screen = BLIND_SCREENS[name];
    let caughtMatrixReader = false;
    for (const base of ACCESS_PROFILES) {
      const held = new Set(permissionsFor(base));
      for (const permission of PERMISSIONS) {
        if (held.has(permission)) continue;
        const subject = {
          ...base,
          grantPermissions: [...(base.grantPermissions ?? []), permission],
        };
        const server = screen(shipped(subject), serverOracle(shipped(subject)));
        const portalUser = matrixBlind(subject);
        expect(
          screen(portalUser, permissionChecks(portalUser).can),
          `${label(base)} + ${permission}`,
        ).toEqual(server);
        // What the portal would show if it recomputed the matrix over the subject it was shipped.
        if (!caughtMatrixReader) {
          caughtMatrixReader = !isEqual(screen(portalUser, serverOracle(portalUser)), server);
        }
      }
    }
    // Sensitivity: the sweep would have seen a screen that reads the matrix.
    expect(caughtMatrixReader).toBe(true);
  });
});

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
