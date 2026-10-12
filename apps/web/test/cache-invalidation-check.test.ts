import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

const CHECK = path.resolve(process.cwd(), 'scripts/check-cache-invalidation.mjs');

/** Files keyed by their path below `src`; the check runs over them as if they were the portal. */
function runFixtureFiles(
  files: Record<string, string>,
  options: { budget?: Record<string, string[]>; mapOnly?: boolean } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'cache-invalidation-check-'));
  for (const [relPath, source] of Object.entries(files)) {
    const full = path.join(root, 'src', relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  if (options.budget)
    writeFileSync(path.join(root, 'cache-budget.json'), JSON.stringify(options.budget));
  const result = spawnSync(process.execPath, [CHECK, ...(options.mapOnly ? ['--map'] : [])], {
    cwd: root,
    encoding: 'utf8',
  });
  const map = JSON.parse(readFileSync(path.join(root, 'cache-invalidation-map.json'), 'utf8'));
  rmSync(root, { recursive: true, force: true });
  return { result, map };
}

/** The budget a red run asks for: every `[rule] id — what` line of its stderr, by rule. */
function listedFindings(stderr: string) {
  const budget: Record<string, string[]> = {};
  for (const line of stderr.split('\n')) {
    const match = /^ {2}— \[([^\]]+)\] (.*?) — /.exec(line);
    if (!match) continue;
    (budget[match[1]!] ??= []).push(match[2]!);
  }
  return budget;
}

function runFixture(source: string, options: { budget?: Record<string, string[]> } = {}) {
  return runFixtureFiles({ 'features/example/fixture.ts': source }, options);
}

describe('cache invalidation check', () => {
  it('fails when a mutation reaches an API handle of an unknown verb', () => {
    const { result } = runFixture(`
declare function useMutation(options: unknown): unknown;
const unknownApi = { save: () => Promise.resolve() };
useMutation({
  mutationFn: () => unknownApi.save(),
});
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[unknown-write]');
  });

  it('accepts a locally explained delegated writer and keeps it in the write inventory', () => {
    const { result, map } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare const qc: { invalidateQueries(value: unknown): void };
const itemKeys = ['items'] as const;
export function useDelegated(run: () => Promise<unknown>) {
  // cache-write: delegated — the caller supplies the concrete API command.
  return useMutation({
    mutationFn: run,
    onSuccess: () => qc.invalidateQueries({ queryKey: itemKeys }),
  });
}
`);
    expect(result.status).toBe(0);
    expect(map.mutations[0].writeAnalysis).toMatchObject({ kind: 'delegated' });
    expect(map.mutations[0].writes).toEqual(['<delegated> WRITE']);
  });

  it('does not let a delegated marker bypass the empty-invalidation rule', () => {
    const { result } = runFixture(`
declare function useMutation(options: unknown): unknown;
export function useDelegated(run: () => Promise<unknown>) {
  // cache-write: delegated — the caller supplies the concrete API command.
  return useMutation({ mutationFn: run });
}
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[writes-nothing-dropped]');
  });

  it('classifies apiDownload as a read instead of an unknown write', () => {
    const { result, map } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare function apiDownload(url: string, name: string): Promise<void>;
const reportsApi = { exportFile: () => apiDownload('/report', 'report.xlsx') };
export const download = useMutation({
  mutationFn: () => reportsApi.exportFile(),
});
`);
    expect(result.status).toBe(0);
    expect(map.mutations[0].reads).toEqual(['reportsApi.exportFile GET']);
    expect(map.mutations[0].unresolved).toEqual([]);
  });

  // A known read next to an opaque call used to make the mutation a fully resolved reader, so no
  // rule looked at it while the opaque call could be any write.
  it('fails when a known read sits next to a call this walk cannot open', () => {
    const { result, map } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
const thingApi = { get: () => apiFetch('/thing') };
export function useOpaque(run: () => Promise<unknown>) {
  return useMutation({
    mutationFn: async () => {
      await thingApi.get();
      return run();
    },
  });
}
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[unknown-write]');
    expect(map.mutations[0].unresolved).toContain('mutationFn-calls-an-opaque-value:run');
  });

  it('opens a local function given as mutationFn and sees its write', () => {
    const { result, map } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
declare const qc: { invalidateQueries(value: unknown): void };
const itemKeys = ['items'] as const;
const itemsApi = { update: () => apiFetch('/items', { method: 'PATCH' }) };
export function useSave() {
  const toBody = (value: number) => ({ value });
  const save = async (value: number) => {
    toBody(value);
    return itemsApi.update();
  };
  return useMutation({
    mutationFn: save,
    onSuccess: () => qc.invalidateQueries({ queryKey: itemKeys }),
  });
}
`);
    expect(result.status).toBe(0);
    expect(map.mutations[0].writes).toEqual(['itemsApi.update PATCH']);
    expect(map.mutations[0].writeAnalysis).toMatchObject({ kind: 'direct' });
  });

  // Stage 3 wave 12 passed a card's invalidation into its sections as a prop: six writers became
  // "unresolved, drops nothing" and the run stayed green.
  it('fails when a writer has no visible cache effect and an unopenable one', () => {
    const { result } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
const itemsApi = { remove: () => apiFetch('/items', { method: 'DELETE' }) };
export function useRemove(props: { refresh: () => void }) {
  const reload = props.refresh;
  return useMutation({
    mutationFn: () => itemsApi.remove(),
    onSuccess: () => reload(),
  });
}
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[cache-effect-unproven]');
  });

  it('accepts an unreadable drop only with an explained opaque marker', () => {
    const source = (marker: string) => `
declare function useMutation(options: unknown): unknown;
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
const itemsApi = { remove: () => apiFetch('/items', { method: 'DELETE' }) };
export function useRemove(props: { refresh: () => void }) {
  const reload = props.refresh;
  ${marker}
  return useMutation({
    mutationFn: () => itemsApi.remove(),
    onSuccess: () => reload(),
  });
}
`;
    expect(runFixture(source('// cache-invalidation: opaque')).result.status).toBe(1);
    const explained = source('// cache-invalidation: opaque — the parent refetches its list');
    // The marker excuses rule 4 only: the site stays unresolved, and the budget must name it.
    const marked = runFixture(explained);
    expect(marked.result.status).toBe(1);
    expect(marked.result.stderr).not.toContain('[cache-effect-unproven]');
    const budget = listedFindings(marked.result.stderr);
    expect(budget).toEqual({
      unresolved: [
        'features/example/fixture.ts|useRemove (useMutation)|call-of-a-value-this-walk-cannot-open:reload',
      ],
    });
    const budgeted = runFixture(explained, { budget });
    expect(budgeted.result.status).toBe(0);
    expect(budgeted.map.mutations[0].unresolved).toContain(
      'call-of-a-value-this-walk-cannot-open:reload',
    );
  });

  it('fails an opaque marker once the scan reads the mutation in full', () => {
    const { result } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
declare const qc: { invalidateQueries(value: unknown): void };
const itemKeys = ['items'] as const;
const itemsApi = { remove: () => apiFetch('/items', { method: 'DELETE' }) };
// cache-invalidation: opaque — the keys used to come from a list the scan could not read.
export const remove = useMutation({
  mutationFn: () => itemsApi.remove(),
  onSuccess: () => qc.invalidateQueries({ queryKey: itemKeys }),
});
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[opaque-marker-excuses-nothing]');
  });

  it('reads the drop of a portal hook result through the hook body', () => {
    const { result, map } = runFixture(`
declare function useMutation(options: unknown): unknown;
declare function useQueryClient(): { invalidateQueries(value: unknown): void };
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
const itemKeys = ['items'] as const;
const itemsApi = { remove: () => apiFetch('/items', { method: 'DELETE' }) };
export function useItemsInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: itemKeys });
}
export function useRemove() {
  const invalidate = useItemsInvalidate();
  return useMutation({
    mutationFn: () => itemsApi.remove(),
    onSuccess: () => invalidate(),
  });
}
`);
    expect(result.status).toBe(0);
    expect(map.mutations[0].invalidates).toEqual(['items']);
  });
});

/*
 * Shapes the scan learned when the last unresolved sites were cleared (roadmap Q9). Each one used to
 * leave a correct mutation "unresolved", which kept rules 1 and 2 away from it.
 */
describe('cache invalidation check: shapes a correct mutation is written in', () => {
  const ITEM_KEYS = `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const itemKeys = createQueryKeys('items', {});
`;

  it('opens a key list a slice returns and a hook walks in a loop', () => {
    const { result, map } = runFixtureFiles({
      'entities/item/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const itemKeys = createQueryKeys('items', {});
export function itemInvalidation(change: { id: string; ownerIds: string[] }) {
  const always = [itemKeys.lists(), itemKeys.detail(change.id)];
  if (!change.ownerIds.length) return always;
  return [...always, ...change.ownerIds.map((id) => itemKeys.owner(id))];
}
`,
      'entities/item/api/itemsApi.ts': `
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
export const itemsApi = { remove: () => apiFetch('/items', { method: 'DELETE' }) };
`,
      'pages/items/itemCache.ts': `
import { useQueryClient } from '@tanstack/react-query';
import { itemInvalidation } from '@entities/item';
export function useItemInvalidation() {
  const qc = useQueryClient();
  return (change: { id: string; ownerIds: string[] }) => {
    for (const queryKey of itemInvalidation(change)) void qc.invalidateQueries({ queryKey });
  };
}
`,
      'pages/items/ItemCard.tsx': `
import { useMutation } from '@tanstack/react-query';
import { useItemInvalidation } from './itemCache';
export function ItemCard() {
  const invalidate = useItemInvalidation();
  return useMutation({
    mutationFn: () => itemsApi.remove(),
    onSuccess: () => invalidate({ id: 'a', ownerIds: [] }),
  });
}
`,
    });
    expect(result.status).toBe(0);
    expect(map.unresolved).toEqual([]);
    expect(map.mutations[0]).toMatchObject({ invalidates: ['items'], homeRoots: ['items'] });
  });

  it('credits a loop over the invalidate option to the call sites that hand the keys in', () => {
    const { result, map } = runFixtureFiles({
      'entities/item/api/keys.ts': ITEM_KEYS,
      'entities/item/api/itemsApi.ts': `
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
export const itemsApi = { purge: (id: string) => apiFetch('/items/' + id, { method: 'DELETE' }) };
`,
      'features/purge/usePurge.ts': `
import { useMutation, useQueryClient } from '@tanstack/react-query';
export function usePurge({ purge, invalidate }: { purge: (id: string) => Promise<unknown>; invalidate: unknown[][] }) {
  const qc = useQueryClient();
  // cache-write: delegated — the caller supplies the purge command and the keys.
  return useMutation({
    mutationFn: (id: string) => purge(id),
    onSuccess: () => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
    },
  });
}
`,
      'pages/items/ItemsTab.tsx': `
import { usePurge } from '@features/purge';
export function ItemsTab(version: number) {
  return usePurge({ purge: (id) => itemsApi.purge(id, version), invalidate: [itemKeys.root] });
}
`,
    });
    expect(result.status).toBe(0);
    expect(map.unresolved).toEqual([]);
    const hook = map.mutations.find((m: { kind: string }) => m.kind === 'useMutation');
    expect(hook.keysFromCallSites).toEqual(['invalidate']);
    // The purge written inside the options belongs to the call-site record, not to a second
    // direct-call writer of the whole component.
    expect(map.mutations.map((m: { kind: string }) => m.kind).sort()).toEqual([
      'invalidate-option',
      'useMutation',
    ]);
  });

  it('knows state setters, useCallback values and router hook results', () => {
    const { result, map } = runFixtureFiles({
      'entities/item/api/keys.ts': ITEM_KEYS,
      'entities/item/api/itemsApi.ts': `
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
export const itemsApi = {
  preview: () => apiFetch('/items/preview', { method: 'POST' }),
  start: (id: string) => apiFetch('/items/' + id + '/start', { method: 'POST' }),
};
`,
      'pages/items/ItemStart.tsx': `
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
export function useItemStart() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const preview = useMutation({ mutationFn: () => itemsApi.preview(), onSuccess: setStep });
  const start = useCallback(
    (id: string) => {
      void itemsApi.start(id).then(() => qc.invalidateQueries({ queryKey: itemKeys.root }));
    },
    [qc],
  );
  const save = useMutation({
    mutationFn: (id: string) => itemsApi.start(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: itemKeys.root });
      void navigate('/items');
    },
  });
  return { step, preview, start: () => start('a'), save };
}
`,
    });
    expect(result.status).toBe(0);
    expect(map.unresolved).toEqual([]);
  });

  it('reads a conflicting helper name the file does not import as a parameter', () => {
    const { result, map } = runFixtureFiles({
      'entities/item/api/itemsApi.ts': `
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
export const itemsApi = { preview: () => apiFetch('/items/preview', { method: 'POST' }) };
`,
      'pages/a/A.tsx':
        'export function A() { const onSubmit = () => qc.invalidateQueries(); return onSubmit; }',
      'pages/b/B.tsx':
        'export function B() { const onSubmit = () => qc.invalidateQueries(); return onSubmit; }',
      'widgets/item-dialog/useConsequences.ts': `
import { useMutation } from '@tanstack/react-query';
export function useConsequences({ onSubmit }: { onSubmit: (v: unknown) => void }) {
  return useMutation({ mutationFn: () => itemsApi.preview(), onSuccess: (v) => onSubmit(v) });
}
`,
    });
    expect(result.status).toBe(0);
    expect(map.unresolved).toEqual([]);
    expect(
      map.mutations.find((m: { file: string }) => m.file.startsWith('widgets/')).handsUp,
    ).toEqual(['onSubmit']);
  });

  it('keeps a literal of spreads out of the API objects', () => {
    const { result, map } = runFixtureFiles({
      'entities/item/api/itemsApi.ts': `
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
export function send(options: { headers?: Record<string, string> }, extra: () => object) {
  const headers = { ...options.headers, ...extra() };
  return apiFetch('/items', { headers });
}
`,
      'pages/items/ItemsTab.tsx': `
export function ItemsTab(params: object) {
  const query = { ...params, sortBy: 'name' };
  return query;
}
`,
    });
    expect(result.status).toBe(0);
    expect(map.unresolved).toEqual([]);
  });
});

/*
 * The home root of a write in a slice with several roots (`cache-home`), and the budget that keeps
 * every such write declared.
 */
describe('cache invalidation check: declared home roots', () => {
  const files = (marker: string, memberMarker = '') => ({
    'entities/mail/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const scheduleKeys = createQueryKeys('schedules', {});
export const accountKeys = createQueryKeys('accounts', {});
`,
    'entities/mail-log/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const mailLogKeys = createQueryKeys('mail-log', {});
`,
    'entities/mail/api/mailApi.ts': `
declare function apiFetch(url: string, init?: unknown): Promise<unknown>;
${marker}
export const mailApi = {
  saveSchedule: () => apiFetch('/schedules', { method: 'POST' }),
  ${memberMarker}
  sendTest: () => apiFetch('/test', { method: 'POST' }),
};
`,
    'pages/admin/Mail.tsx': `
import { useMutation, useQueryClient } from '@tanstack/react-query';
export function Mail() {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => mailApi.saveSchedule(),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.root }),
  });
  const send = useMutation({
    mutationFn: () => mailApi.sendTest(),
    onSuccess: () => qc.invalidateQueries({ queryKey: mailLogKeys.root }),
  });
  return { save, send };
}
`,
  });

  it('budgets every write of a several-root slice that declares no home', () => {
    const { result } = runFixtureFiles(files(''));
    expect(result.status).toBe(1);
    expect(listedFindings(result.stderr)).toEqual({
      'home-ambiguous': ['mailApi.saveSchedule', 'mailApi.sendTest'],
    });
  });

  it('applies rule 2 to the declared home, a member marker first', () => {
    const declared = runFixtureFiles(
      files(
        '// cache-home: schedules — the object writes schedules.',
        '// cache-home: mail-log — a test letter lands in the log of another slice.',
      ),
    );
    expect(declared.result.status).toBe(1);
    // `save` drops a neighbour root and misses its declared home; `send` drops the root its
    // member marker names, so it passes.
    expect(listedFindings(declared.result.stderr)).toEqual({
      'home-root-missed': ['pages/admin/Mail.tsx:5'],
    });
    expect(
      declared.map.mutations.map((m: { name: string; homeRoots: string[] }) => [
        m.name,
        m.homeRoots,
      ]),
    ).toEqual([
      ['save', ['schedules']],
      ['send', ['mail-log']],
    ]);
  });

  it('refuses a home that names no known root', () => {
    const { result, map } = runFixtureFiles(files('// cache-home: schedule — a typo.'));
    expect(result.status).toBe(1);
    expect(map.unresolved.map((u: { why: string }) => u.why)).toContain(
      'write-handle-home-is-not-a-known-root:mailApi.saveSchedule:schedule',
    );
  });
});

/*
 * The path table: which slice owns an API path. One portal fixture serves every case — the table is
 * portal-wide, and the longest-template and ambiguity answers only mean something with neighbours.
 */
describe('cache invalidation check: API path table', () => {
  const DECLARE = `
declare function apiFetch(path: string, init?: unknown): Promise<unknown>;
declare function createListApi(path: string): { list(): Promise<unknown> };
declare function createGetApi(path: string): { get(id: string): Promise<unknown> };
`;
  const PORTAL = {
    // Two roots in one slice: the table answers with the slice, and the slice with both roots.
    'entities/item/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const itemKeys = createQueryKeys('items', {});
export const itemTagKeys = createQueryKeys('item-tags', {});
`,
    'entities/item/api/itemsApi.ts': `${DECLARE}
const PATH = '/items';
const patch = (id: string, tail: string, body: unknown) =>
  apiFetch(\`\${PATH}/\${id}\${tail}\`, { method: 'PATCH', body });
export const itemsApi = {
  ...createListApi(PATH),
  ...createGetApi(PATH),
  history: (id: string) => apiFetch(\`/items/\${id}/history\`),
  tags: () => apiFetch('/items/tags?active=true'),
  report: (id: string) => apiFetch(\`\${PATH}/\${id}/report\`),
  archive: (id: string) => patch(id, '/archive', {}),
};
`,
    // Another slice under the same first segment: the longer template wins.
    'entities/telemetry/api/telemetryApi.ts': `${DECLARE}
const PATH = '/items';
export const telemetryApi = {
  card: (itemId: string) => apiFetch(\`\${PATH}/\${itemId}/telemetry\`),
};
`,
    // The same template in two slices: a bare call to it has no single owner.
    'entities/label/api/labelsApi.ts': `${DECLARE}
export const labelsApi = { tags: () => apiFetch('/items/tags') };
`,
    'entities/link/api/linkApi.ts': `${DECLARE}
export const linkApi = {
  follow: (url: string) => apiFetch(url),
  children: (base: string) => apiFetch(\`\${base}/children\`),
};
export const linkOpenQuery = (href: string) => ({ queryFn: () => apiFetch(href) });
`,
    'entities/order/api/queries.ts': `${DECLARE}
export const itemOptionsQuery = () => ({
  queryFn: () => apiFetch('/items', { query: { pageSize: 500 } }),
});

export const itemCardQuery = (id: string) => ({ queryFn: () => apiFetch(\`/items/\${id}?full=1\`) });
export const itemTelemetryQuery = (id: string) => ({
  queryFn: () => apiFetch(\`/items/\${id}/telemetry\`),
});
export const itemTagsQuery = () => ({ queryFn: () => apiFetch('/items/tags') });
export const missingQuery = () => ({ queryFn: () => apiFetch('/nowhere') });
`,
  };

  type Outside = { in: string; path: string | null; owner: string | null; [k: string]: unknown };
  type Unresolved = { file: string; form: string; why: string; class: string };
  let run: ReturnType<typeof runFixtureFiles>;
  const outside = (name: string): Outside =>
    run.map.apiPaths.outside.find((o: Outside) => o.in === name);

  beforeAll(() => {
    run = runFixtureFiles(PORTAL, { mapOnly: true });
  });

  // This fixture checks path ownership; --map leaves enforcement to the read-rule fixtures.
  it('lists the paths it could not evaluate', () => {
    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain('Пути API:');
  });

  it('reads a literal path, dropping the query string', () => {
    expect(run.map.apiPaths.handles['itemsApi.tags']).toEqual(['GET /items/tags']);
  });

  it('turns a template substitution into a parameter segment', () => {
    expect(run.map.apiPaths.handles['itemsApi.history']).toEqual(['GET /items/:id/history']);
  });

  it('replaces a path constant of the file with its value, in factories as well', () => {
    expect(run.map.apiPaths.handles['itemsApi.report']).toEqual(['GET /items/:id/report']);
    expect(run.map.apiPaths.handles['itemsApi.list']).toEqual(['GET /items']);
    expect(run.map.apiPaths.handles['itemsApi.get']).toEqual(['GET /items/:id']);
  });

  it('opens a local sender with the arguments of the call', () => {
    expect(run.map.apiPaths.handles['itemsApi.archive']).toEqual(['PATCH /items/:id/archive']);
  });

  it('owns templates by slice and shows every root of the slice', () => {
    expect(run.map.apiPaths.owners['entities/item']).toEqual({
      roots: ['item-tags', 'items'],
      templates: [
        '/items',
        '/items/:id',
        '/items/:id/archive',
        '/items/:id/history',
        '/items/:id/report',
        '/items/tags',
      ],
    });
    expect(run.map.apiPaths.shared).toEqual({
      '/items/tags': ['entities/item', 'entities/label'],
    });
  });

  it('sends a computed path to unresolved with the api-inventory class', () => {
    const paths = (run.map.unresolved as Unresolved[]).filter((u) => u.why.startsWith('api-path-'));
    expect(paths).toEqual([
      {
        file: 'entities/link/api/linkApi.ts',
        form: 'linkApi.children: not rooted: :base/children',
        why: 'api-path-computed-in-a-handle',
        class: 'api-inventory',
      },
      {
        file: 'entities/link/api/linkApi.ts',
        form: 'linkApi.follow: url',
        why: 'api-path-computed-in-a-handle',
        class: 'api-inventory',
      },
      {
        file: 'entities/link/api/linkApi.ts',
        form: 'linkOpenQuery (line 10): apiFetch(href)',
        why: 'api-path-computed-outside-an-api-object',
        class: 'api-inventory',
      },
    ]);
    expect(run.map.apiPaths.handles['linkApi.follow']).toEqual(['GET <computed: url>']);
    expect(outside('linkOpenQuery')).toMatchObject({ path: null, owner: null, why: 'computed' });
  });

  it('matches a bare request to the slice that owns its path', () => {
    expect(outside('itemOptionsQuery')).toMatchObject({
      at: 'entities/order/api/queries.ts:7',
      path: '/items',
      owner: 'entities/item',
      slice: 'entities/item',
      template: '/items',
      roots: ['item-tags', 'items'],
    });
    expect(outside('itemCardQuery')).toMatchObject({ path: '/items/:id', owner: 'entities/item' });
  });

  it('prefers the longest covering template', () => {
    expect(outside('itemTelemetryQuery')).toMatchObject({
      path: '/items/:id/telemetry',
      owner: 'entities/telemetry',
      template: '/items/:itemId/telemetry',
    });
  });

  it('answers "not found" and "ambiguous" explicitly instead of picking an owner', () => {
    expect(outside('missingQuery')).toMatchObject({
      path: '/nowhere',
      owner: null,
      why: 'not-found',
    });
    expect(outside('itemTagsQuery')).toMatchObject({
      owner: null,
      why: 'ambiguous',
      candidates: ['entities/item', 'entities/label'],
    });
    expect(run.map.apiPaths.totals.outsideByAnswer).toEqual({
      ambiguous: 1,
      computed: 1,
      'not-found': 1,
      owned: 3,
    });
  });
});

describe('cache invalidation check: read inventory', () => {
  type Read = {
    at: string;
    kind: string;
    factory: string | null;
    key: { root: string | null; family: string | null; variants?: unknown[]; why?: string };
    handles: Array<{ handle: string; owner: string | null }>;
    paths: Array<{ path: string; owner: string | null }>;
  };
  let reads: Read[];

  beforeAll(() => {
    const run = runFixtureFiles(
      {
        'entities/item/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const itemKeys = createQueryKeys('items', { list: () => ['list'], detail: () => ['detail'] });
export const itemCardKey = ['items', 'card'] as const;
`,
        'entities/item/api/itemsApi.ts': `
declare function apiFetch(path: string): Promise<unknown>;
export const itemsApi = {
  list: () => apiFetch('/items'),
  get: (id: string) => apiFetch(\`/items/\${id}\`),
};
`,
        'entities/foreign/api/foreignApi.ts': `
declare function apiFetch(path: string): Promise<unknown>;
export const foreignApi = { list: () => apiFetch('/foreign') };
`,
        'entities/item/api/wrappers.ts': `
export const itemReadApi = { catalog: () => itemsApi.list() };
`,
        'entities/item/api/queries.ts': `
declare function queryOptions<T>(value: T): T;
export const itemListQuery = () => queryOptions({
  queryKey: itemKeys.list(), queryFn: () => itemsApi.list(),
});

export const itemLabelsQuery = () => queryOptions({
  ...itemListQuery(), select: (data: unknown) => data,
});
`,
        'features/example/reads.tsx': `
declare function useQuery(options: unknown): unknown;
declare function useQueries(options: unknown): unknown;
declare function useInfiniteQuery(options: unknown): unknown;
declare function useOpenedRecord<T>(options: unknown): unknown;
declare function apiFetch(path: string): Promise<unknown>;
const rawKey = ['items', 'detail'] as const;
const detailKey = (id: string) => itemKeys.detail(id);
useQuery(itemLabelsQuery());
useQuery({ queryKey: rawKey, queryFn: () => apiFetch('/foreign') });
useQuery({ queryKey: itemCardKey, queryFn: () => itemsApi.get('1') });
useQuery({ queryKey: detailKey('1'), queryFn: () => itemsApi.get('1') });
useQuery({ queryKey: itemKeys.list(), queryFn: () => itemReadApi.catalog() });
useQueries({ queries: [
  { queryKey: itemKeys.list(), queryFn: () => itemsApi.list() },
  { queryKey: ['items', 'detail'], queryFn: () => itemsApi.get('1') },
] });
useQueries({ queries: [1, 2].map((id) => ({
  queryKey: itemKeys.detail(id), queryFn: () => itemsApi.get(String(id)),
})) });
useInfiniteQuery({ queryKey: itemKeys.list(), queryFn: () => itemsApi.list() });
useQuery({ queryKey: itemKeys.root, queryFn: () => itemsApi.list() });
useQuery({
  queryKey: Math.random() ? itemKeys.list() : itemKeys.detail('1'),
  queryFn: () => itemsApi.list(),
});
useOpenedRecord<unknown>({
  active: true,
  queryKey: (id: string) => itemKeys.detail(id),
  fetch: (id: string) => itemsApi.get(id),
});
`,
      },
      { mapOnly: true },
    );
    expect(run.result.status).toBe(0);
    reads = run.map.readInventory.reads as Read[];
  });

  it('follows a queryOptions factory and its spread to the caller', () => {
    const factory = reads.find((r) => r.kind === 'queryOptions' && r.factory === 'itemLabelsQuery');
    const caller = reads.find((r) => r.kind === 'useQuery' && r.factory === 'itemLabelsQuery');
    expect(factory?.key).toMatchObject({ root: 'items', family: 'list' });
    expect(caller?.key).toMatchObject({ root: 'items', family: 'list' });
    expect(caller?.handles).toMatchObject([{ handle: 'itemsApi.list', owner: 'entities/item' }]);
  });

  it('records bare API reads with the path owner separately from their key family', () => {
    const bare = reads.find((r) => r.kind === 'useQuery' && r.paths.length > 0);
    expect(bare?.key).toMatchObject({ root: 'items', family: 'detail' });
    expect(bare?.paths).toMatchObject([{ path: '/foreign', owner: 'entities/foreign' }]);
  });

  it('enumerates useQueries, infinite queries and opened records', () => {
    expect(reads.filter((r) => r.kind === 'useQueries').map((r) => r.key.family)).toEqual([
      'list',
      'detail',
      'detail',
    ]);
    expect(reads.find((r) => r.kind === 'useInfiniteQuery')?.key).toMatchObject({
      root: 'items',
      family: 'list',
    });
    expect(reads.find((r) => r.kind === 'useOpenedRecord')).toMatchObject({
      key: { root: 'items', family: 'detail' },
      handles: [{ handle: 'itemsApi.get', owner: 'entities/item' }],
    });
  });

  it('keeps root keys and both conditional families explicit', () => {
    expect(reads.find((r) => r.key.family === '$root')?.key).toMatchObject({
      root: 'items',
      family: '$root',
    });
    expect(reads.find((r) => r.key.variants)?.key.variants).toMatchObject([
      { root: 'items', family: 'list' },
      { root: 'items', family: 'detail' },
    ]);
  });

  it('resolves imported literal keys and local key helpers to families', () => {
    expect(reads.find((r) => r.key.family === 'card')?.key).toMatchObject({
      root: 'items',
      family: 'card',
    });
    expect(reads.filter((r) => r.key.family === 'detail').length).toBeGreaterThan(1);
  });

  it('keeps the slice owner of a wrapper whose HTTP verb is not directly visible', () => {
    const wrapper = reads.find((r) => r.handles.some((h) => h.handle === 'itemReadApi.catalog'));
    expect(wrapper?.handles).toMatchObject([
      { handle: 'itemReadApi.catalog', owner: 'entities/item' },
    ]);
  });
});

describe('cache invalidation check: read rules', () => {
  const FILES = {
    'entities/object/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const objectKeys = createQueryKeys('objects', { options: () => ['options'] });
`,
    'entities/object/api/objectsApi.ts': `
declare function apiFetch(path: string): Promise<unknown>;
export const objectsApi = { list: () => apiFetch('/objects') };
`,
    'entities/counterparty/api/keys.ts': `
declare function createQueryKeys(root: string, families: unknown): unknown;
export const counterpartyKeys = createQueryKeys('counterparties', {});
`,
    'entities/counterparty/api/counterpartiesApi.ts': `
declare function apiFetch(path: string): Promise<unknown>;
export const counterpartiesApi = { list: () => apiFetch('/counterparties') };
`,
    'entities/object/api/queries.ts': `
declare function queryOptions<T>(value: T): T;
declare function apiFetch(path: string): Promise<unknown>;
export const objectOptionsQuery = () => queryOptions({
  ...QUERY_PROFILE.DICTIONARY,
  queryKey: objectKeys.options(), queryFn: () => apiFetch('/counterparties'),
});
export const anotherObjectOptionsQuery = () => queryOptions({
  queryKey: objectKeys.options(), queryFn: () => objectsApi.list(),
});
`,
    'features/example/reads.tsx': `
declare function useQuery(options: unknown): unknown;
useQuery(objectOptionsQuery());
useQuery({ queryKey: objectKeys.options(), queryFn: () => objectsApi.list() });
`,
  };

  it('requires an exact named budget for all four rules and rejects a dead entry', () => {
    const missing = runFixtureFiles(FILES);
    expect(missing.result.status).toBe(1);
    expect(
      missing.map.readInventory.reads.find(
        (read: { factory: string }) => read.factory === 'objectOptionsQuery',
      )?.profile,
    ).toBe('DICTIONARY');
    const budget = listedFindings(missing.result.stderr);
    expect(
      Object.fromEntries(Object.entries(budget).map(([rule, ids]) => [rule, ids.length])),
    ).toEqual({
      'foreign-bare-path-in-queries': 1,
      'profiled-read-bypasses-factory': 1,
      'read-under-foreign-root': 2,
      'second-family-factory': 1,
    });
    expect(runFixtureFiles(FILES, { budget }).result.status).toBe(0);
    const stale = runFixtureFiles(FILES, {
      budget: {
        ...budget,
        'second-family-factory': [...(budget['second-family-factory'] ?? []), 'gone'],
      },
    });
    expect(stale.result.status).toBe(1);
    expect(stale.result.stderr).toContain('stale budget entry: [second-family-factory] gone');
  });

  it('derives profiled families from canonical factory metadata', () => {
    const withoutProfile = {
      ...FILES,
      'entities/object/api/queries.ts': FILES['entities/object/api/queries.ts'].replace(
        '  ...QUERY_PROFILE.DICTIONARY,\n',
        '',
      ),
    };
    const budget = listedFindings(runFixtureFiles(withoutProfile).result.stderr);
    expect(budget['profiled-read-bypasses-factory']).toBeUndefined();
    expect(budget['second-family-factory']).toBeUndefined();
  });

  it('allows a documented foreign-root exception while keeping the bare-path rule', () => {
    const files = {
      ...FILES,
      'entities/object/api/queries.ts': FILES['entities/object/api/queries.ts'].replace(
        'export const objectOptionsQuery',
        '// cache-read: foreign — this legacy picker shares the counterparty endpoint.\nexport const objectOptionsQuery',
      ),
    };
    const budget = listedFindings(runFixtureFiles(files).result.stderr);
    expect(budget['read-under-foreign-root']).toBeUndefined();
    expect(budget['foreign-bare-path-in-queries']).toHaveLength(1);
  });
});
