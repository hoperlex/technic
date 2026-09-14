/**
 * Пути и маски. Переносимая часть: знает только про строки.
 */
import path from 'node:path';

/**
 * Приведение к виду, в котором сравниваются все пути системы: относительный от корня, через
 * прямые косые, без ведущих `./`.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. Половина путей приходит от git (`apps/api/src/x.ts`), половина — из
 * конфигов и аргументов командной строки (`./apps/api/src/x.ts`, абсолютный путь, путь с `..`).
 * Сравнение их «как есть» даёт ложные промахи в защищённых областях — то есть молчаливое
 * разрешение править то, что править запрещено.
 */
export function normalizePath(root: string, value: string): string {
  const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
  const relative = path.relative(root, absolute);
  return relative.split(path.sep).join('/');
}

/**
 * Совпадение пути с маской. Маска пишется в стиле `.gitignore`-подобных списков: `apps/**`,
 * `apps/api/src/*.ts`, точный путь.
 *
 * Отдельный разбор для маски-каталога: `apps/api/drizzle/**` обязан покрывать и сам каталог, и
 * всё внутри него. Без этого правила запрет «не трогать миграции» пропускал бы сам каталог.
 */
export function matchesPattern(relPath: string, pattern: string): boolean {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (clean === '') return false;
  if (relPath === clean) return true;
  if (clean.endsWith('/**')) {
    const base = clean.slice(0, -3);
    if (relPath === base || relPath.startsWith(`${base}/`)) return true;
  }
  return path.matchesGlob(relPath, clean);
}

/**
 * Самая длинная совпавшая маска из списка.
 *
 * Длина, а не порядок в файле: точечный запрет внутри разрешённой области обязан побеждать общее
 * разрешение, и зависеть это не должно от того, кто раньше дописал строку в политику.
 */
export function bestMatch(relPath: string, patterns: readonly string[]): string | null {
  let best: string | null = null;
  for (const pattern of patterns) {
    if (!matchesPattern(relPath, pattern)) continue;
    if (best === null || pattern.length > best.length) best = pattern;
  }
  return best;
}

/** Попадает ли путь хотя бы под одну маску. */
export function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(relPath, pattern));
}
