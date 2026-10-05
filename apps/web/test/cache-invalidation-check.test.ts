import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const CHECK = path.resolve(process.cwd(), 'scripts/check-cache-invalidation.mjs');

function runFixture(source: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'cache-invalidation-check-'));
  const sourceDir = path.join(root, 'src/features/example');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'fixture.ts'), source);
  const result = spawnSync(process.execPath, [CHECK], { cwd: root, encoding: 'utf8' });
  const map = JSON.parse(readFileSync(path.join(root, 'cache-invalidation-map.json'), 'utf8'));
  rmSync(root, { recursive: true, force: true });
  return { result, map };
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
