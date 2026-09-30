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
});
