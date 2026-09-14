/**
 * Граф импортов: направления между пакетами и циклы между файлами.
 *
 * ЗАЧЕМ ОН, ЕСЛИ ЕСТЬ ЛИНТ. Линт стережёт слои ВНУТРИ портала; уровнем выше не стережёт ничто —
 * импорт из сервера в портал или из общего словаря в приложение прошёл бы молча. Здесь считается
 * ровно это: направления между пакетами по карте модулей и циклы, которых не видит ни одно
 * правило.
 *
 * РАЗБОР РЕГУЛЯРНЫМ ВЫРАЖЕНИЕМ, А НЕ КОМПИЛЯТОРОМ. Осознанный размен: нужен список зависимостей,
 * а не типы. Цена — импорты, собранные строкой во время работы (`import(path)`), в граф не
 * попадут; такой импорт здесь и не принят. Выигрыш — секунда на тысяче файлов вместо минуты и
 * отсутствие зависимости ядра от конкретного компилятора.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { DependencyFacts, DependencyViolation } from '../core/facts.ts';
import type { AliasEntry, ModulePackage } from '../core/types.ts';

export interface DependencyOptions {
  readonly root: string;
  readonly files: readonly string[];
  readonly packages: readonly ModulePackage[];
  readonly aliases: readonly AliasEntry[];
  readonly maxCycles: number;
}

const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];

/** Импорт превращается в путь файла внутри дерева либо в `null`, если он внешний. */
function resolveImport(
  root: string,
  fromFile: string,
  specifier: string,
  aliases: readonly AliasEntry[],
): string | null {
  let candidate: string | null = null;
  if (specifier.startsWith('.')) {
    candidate = path.join(path.dirname(fromFile), specifier);
  } else {
    for (const alias of aliases) {
      const prefix = alias.prefix.replace(/\*$/, '');
      if (!specifier.startsWith(prefix)) continue;
      if (alias.within !== undefined && !fromFile.startsWith(alias.within)) continue;
      candidate = path.posix.join(alias.target.replace(/\*$/, ''), specifier.slice(prefix.length));
      break;
    }
  }
  if (candidate === null) return null;
  const normalized = candidate.split(path.sep).join('/');

  // Порядок проб тот же, что у сборщика: точное имя, затем расширения, затем `index`. Первый
  // существующий файл и есть ответ — угадывать дальше значило бы разойтись с настоящей сборкой.
  if (hasFile(root, normalized)) return normalized;
  for (const extension of EXTENSIONS) {
    if (hasFile(root, `${normalized}${extension}`)) return `${normalized}${extension}`;
  }
  for (const extension of EXTENSIONS) {
    if (hasFile(root, `${normalized}/index${extension}`)) return `${normalized}/index${extension}`;
  }
  return null;
}

function hasFile(root: string, relative: string): boolean {
  if (path.extname(relative) === '') return false;
  return existsSync(path.join(root, relative));
}

/** Пакет, которому принадлежит файл: самый длинный совпавший путь. */
function packageOf(file: string, packages: readonly ModulePackage[]): ModulePackage | null {
  let best: ModulePackage | null = null;
  for (const item of packages) {
    const base = item.path.replace(/\/+$/, '');
    if (file !== base && !file.startsWith(`${base}/`)) continue;
    if (best === null || base.length > best.path.length) best = item;
  }
  return best;
}

export function collectDependencies(options: DependencyOptions): DependencyFacts {
  const started = Date.now();
  const graph = new Map<string, string[]>();
  const violations: DependencyViolation[] = [];
  const directionSeen = new Map<string, Set<string>>();
  let edges = 0;

  for (const file of options.files) {
    let text: string;
    try {
      text = readFileSync(path.join(options.root, file), 'utf8');
    } catch {
      continue;
    }
    const targets: string[] = [];
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolveImport(options.root, file, specifier, options.aliases);
      if (resolved === null) {
        // Внешний пакет либо алиас, о котором конфиг не знает. Нарушением это не считается: карта
        // модулей описывает своё дерево, а не содержимое node_modules.
        continue;
      }
      targets.push(resolved);
      edges += 1;

      const from = packageOf(file, options.packages);
      const to = packageOf(resolved, options.packages);
      if (from === null || to === null || from.id === to.id) continue;
      if (from.mayDependOn.includes(to.id)) continue;
      const key = `${from.id}->${to.id}`;
      const known = directionSeen.get(key) ?? new Set<string>();
      known.add(file);
      directionSeen.set(key, known);
    }
    graph.set(file, targets);
  }

  for (const [key, files] of [...directionSeen.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [from = '', to = ''] = key.split('->');
    violations.push({
      kind: 'direction',
      from,
      to,
      // Файлов может быть много; в факт идут первые по алфавиту, а число названо в тексте.
      files: [...files].sort().slice(0, 10),
      severity: 'hard',
      detail: `карта модулей не разрешает ${from} зависеть от ${to}; мест: ${files.size}`,
    });
  }

  for (const cycle of findCycles(graph, options.maxCycles)) {
    violations.push({
      kind: 'cycle',
      from: cycle[0] ?? '',
      to: cycle[cycle.length - 1] ?? '',
      files: cycle,
      // Цикл — кандидат на разбор, а не поломка: между файлами одного слайса он встречается и в
      // здоровом коде. Жёстким его делает только правило, которое он нарушает.
      severity: 'soft',
      detail: `взаимная зависимость ${cycle.length} файлов`,
    });
  }

  return {
    ok: violations.every((violation) => violation.severity !== 'hard'),
    durationMs: Date.now() - started,
    summary: `${graph.size} файлов, ${edges} связей, нарушений: ${violations.length}`,
    modules: graph.size,
    edges,
    violations,
  };
}

/**
 * Компоненты сильной связности размером больше одного — Тарьян, без рекурсии.
 *
 * Без стека на куче обход валится переполнением на дереве в тысячу файлов с длинными цепочками:
 * проверено на этом репозитории.
 */
function findCycles(graph: Map<string, string[]>, limit: number): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;

  for (const start of [...graph.keys()].sort()) {
    if (index.has(start)) continue;
    const work: { node: string; edge: number }[] = [{ node: start, edge: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const targets = graph.get(frame.node) ?? [];
      if (frame.edge < targets.length) {
        const next = targets[frame.edge];
        frame.edge += 1;
        if (next === undefined || !graph.has(next)) continue;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const node = stack.pop();
          if (node === undefined) break;
          onStack.delete(node);
          component.push(node);
          if (node === frame.node) break;
        }
        if (component.length > 1 && found.length < limit) found.push(component.sort());
      }
    }
  }
  return found;
}
