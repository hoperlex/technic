import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

const CHECK = path.resolve(process.cwd(), 'scripts/check-cache-invalidation.mjs');

/** Files keyed by their path below `src`; the check runs over them as if they were the portal. */
function runFixtureFiles(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'cache-invalidation-check-'));
  for (const [relPath, source] of Object.entries(files)) {
    const full = path.join(root, 'src', relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  const result = spawnSync(process.execPath, [CHECK], { cwd: root, encoding: 'utf8' });
  const map = JSON.parse(readFileSync(path.join(root, 'cache-invalidation-map.json'), 'utf8'));
  rmSync(root, { recursive: true, force: true });
  return { result, map };
}

function runFixture(source: string) {
  return runFixtureFiles({ 'features/example/fixture.ts': source });
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
    const marked = runFixture(
      source('// cache-invalidation: opaque — the parent refetches its list'),
    );
    expect(marked.result.status).toBe(0);
    expect(marked.map.mutations[0].unresolved).toContain(
      'call-of-a-value-this-walk-cannot-open:reload',
    );
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
    run = runFixtureFiles(PORTAL);
  });

  // An inventory, not a rule: a computed path and a bare call to a foreign slice keep the run green.
  it('stays green and lists the paths it could not evaluate', () => {
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
