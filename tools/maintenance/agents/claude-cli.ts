/**
 * Где взять программу агента.
 *
 * ПОЧЕМУ ЭТО НЕ ПРОСТО СТРОКА В КОНФИГЕ. На машине, где работает эта система, `claude` может не
 * лежать в `PATH` вовсе: в редакторе он живёт внутри расширения, отдельным бинарём, и путь к нему
 * содержит НОМЕР ВЕРСИИ РАСШИРЕНИЯ. Расширение обновляется само — сегодня 2.1.272, завтра 2.1.273,
 * — и записанный в конфиг путь молча перестаёт существовать. Отказ был бы честным, но каждый раз
 * требовал бы правки файла в истории проекта ради чужого обновления.
 *
 * Поэтому порядок поиска такой: явный путь из конфига, затем `PATH`, затем самая свежая копия в
 * расширениях редактора. Первое найденное и есть ответ; что именно выбрано, система печатает —
 * человек должен видеть, какую программу пустили в его дерево.
 */
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { run } from '../analyzers/run.ts';

/** Каталоги, где редакторы держат распакованные расширения. */
const EXTENSION_HOMES = ['.vscode-server/extensions', '.vscode/extensions', '.cursor/extensions'];
const EXTENSION_PREFIX = 'anthropic.claude-code-';
const BINARY_INSIDE = 'resources/native-binary/claude';

/**
 * Аргументы запуска по ролям — знание про КОНКРЕТНУЮ программу, и живёт оно здесь.
 *
 * Это находка первого живого прогона: ревьюер заметил, что общий раннер команд узнал и поиск
 * программы, и её флаги, и домашний каталог. Раннер обязан знать только «роль и адаптер»; какие
 * ключи означают «не смей править» у claude — подробность этой программы, и меняться она будет
 * вместе с ней.
 *
 * Ревьюеру инструменты правки запрещены не словами задания, а флагом: правка, сделанная им, обошла
 * бы отбор, бюджет и контрольную точку — всё, ради чего система построена.
 */
export const CLAUDE_ROLE_ARGS = {
  reviewer: ['-p', '--disallowed-tools', 'Edit', 'Write', 'NotebookEdit'],
  fixer: ['-p', '--permission-mode', 'acceptEdits'],
} as const;

export interface ResolvedBinary {
  readonly path: string;
  /** Откуда взят: человеку это важнее самого пути. */
  readonly source: 'config' | 'PATH' | 'extension';
  readonly version: string | null;
}

/**
 * Найти программу агента.
 *
 * `null` означает «не нашли», и вызывающий обязан сказать об этом словами, а не молча свалиться в
 * ручной режим: человек просил самоходный прогон, и подмена без предупреждения выглядела бы как
 * «агент ничего не нашёл».
 */
export function resolveClaudeBinary(
  explicit: string | null,
  home: string = process.env['HOME'] ?? '/root',
): ResolvedBinary | null {
  if (explicit !== null && explicit !== '') {
    if (!existsSync(explicit)) return null;
    return { path: explicit, source: 'config', version: versionOf(explicit) };
  }

  const inPath = run(home, ['which', 'claude']).stdout.trim();
  if (inPath !== '' && existsSync(inPath)) {
    return { path: inPath, source: 'PATH', version: versionOf(inPath) };
  }

  const bundled = newestBundled(home);
  if (bundled === null) return null;
  return { path: bundled, source: 'extension', version: versionOf(bundled) };
}

/**
 * Самая свежая копия в расширениях.
 *
 * Версии сравниваются по числам, а не строкой: `2.1.9` строкой больше `2.1.10`, и система
 * упорно звала бы устаревшую программу, пока кто-нибудь не заметил бы.
 */
function newestBundled(home: string): string | null {
  const candidates: { file: string; version: number[] }[] = [];
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
      const file = path.join(dir, entry, BINARY_INSIDE);
      if (!existsSync(file)) continue;
      candidates.push({ file, version: numbersOf(entry.slice(EXTENSION_PREFIX.length)) });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0]?.file ?? null;
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

/** Версия программы. `null` — не ответила; это не отказ, но в отчёте видно. */
function versionOf(binary: string): string | null {
  const result = run(process.cwd(), [binary, '--version']);
  const text = result.stdout.trim();
  return result.code === 0 && text !== '' ? text : null;
}
