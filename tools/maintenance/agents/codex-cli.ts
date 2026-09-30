/**
 * Locate the Codex CLI without pinning an editor-extension version in repository history.
 *
 * Resolution order is explicit config, PATH, then the newest supported editor extension. The
 * selected path and version are reported before execution so an unattended run is auditable.
 */
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { run } from '../analyzers/run.ts';
import type { ResolvedBinary } from './claude-cli.ts';

const EXTENSION_HOMES = ['.vscode-server/extensions', '.vscode/extensions', '.cursor/extensions'];
const EXTENSION_PREFIX = 'openai.chatgpt-';
const BINARY_CANDIDATES = [
  'bin/linux-x86_64/codex',
  'bin/linux-aarch64/codex',
  'bin/macos-x86_64/codex',
  'bin/macos-aarch64/codex',
];

/**
 * Role-specific safety defaults belong to the CLI integration, not the generic process adapter.
 * Reviewers receive a read-only sandbox; fixers receive workspace write access with reviewed
 * approvals. Both sessions are ephemeral and read their packet from stdin.
 */
export const CODEX_ROLE_ARGS = {
  reviewer: ['exec', '--sandbox', 'read-only', '--ephemeral', '-'],
  fixer: ['exec', '--sandbox', 'workspace-write', '--approve-for-me', '--ephemeral', '-'],
} as const;

export function resolveCodexBinary(
  explicit: string | null,
  home: string = process.env['HOME'] ?? '/root',
): ResolvedBinary | null {
  if (explicit !== null && explicit !== '') {
    if (!existsSync(explicit)) return null;
    return { path: explicit, source: 'config', version: versionOf(explicit) };
  }

  const inPath = run(home, ['which', 'codex']).stdout.trim();
  if (inPath !== '' && existsSync(inPath)) {
    return { path: inPath, source: 'PATH', version: versionOf(inPath) };
  }

  const bundled = newestBundled(home);
  if (bundled === null) return null;
  return { path: bundled.file, source: 'extension', version: bundled.version };
}

function newestBundled(home: string): { file: string; version: string | null } | null {
  const candidates: { file: string; version: number[]; label: string }[] = [];
  for (const place of EXTENSION_HOMES) {
    const dir = path.join(home, place);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(EXTENSION_PREFIX)) continue;
      for (const inside of BINARY_CANDIDATES) {
        const file = path.join(dir, entry, inside);
        if (!existsSync(file)) continue;
        const label = entry.slice(EXTENSION_PREFIX.length);
        candidates.push({ file, version: numbersOf(label), label });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const selected = candidates[0];
  return selected === undefined ? null : { file: selected.file, version: selected.label };
}

function numbersOf(text: string): number[] {
  return text
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function versionOf(binary: string): string | null {
  const result = run(process.cwd(), [binary, '--version']);
  const text = result.stdout.trim();
  return result.code === 0 && text !== '' ? text : null;
}
