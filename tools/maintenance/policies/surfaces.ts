/**
 * Решение о защищённой области: можно ли трогать этот путь автоматически.
 */
import type { ProtectedSurface, SurfaceMode, SurfaceVerdict } from '../core/types.ts';
import { bestMatch, normalizePath } from '../core/paths.ts';

/** Порядок строгости. Нужен там, где путь попал сразу в две области. */
const RANK: Record<SurfaceMode, number> = { allowed: 0, 'manual-review': 1, forbidden: 2 };

export function isAtLeastAsStrict(mode: SurfaceMode, than: SurfaceMode): boolean {
  return RANK[mode] >= RANK[than];
}

/**
 * Режим для одного пути.
 *
 * Побеждает самая длинная совпавшая маска — то есть самое точное правило. При равной длине
 * побеждает СТРОГАЯ: совпадение двух областей означает, что человек описал одно место дважды, и
 * толковать его разногласие в пользу разрешения нельзя. Цена ошибок здесь несимметрична: лишний
 * запрет стоит одной ручной правки, лишнее разрешение — правки в миграции или в правах.
 */
export function resolveSurface(
  root: string,
  surfaces: readonly ProtectedSurface[],
  defaultMode: SurfaceMode,
  filePath: string,
): SurfaceVerdict {
  const relative = normalizePath(root, filePath);
  let winner: { surface: ProtectedSurface; pattern: string } | null = null;
  for (const surface of surfaces) {
    const pattern = bestMatch(relative, surface.paths);
    if (pattern === null) continue;
    if (winner === null) {
      winner = { surface, pattern };
      continue;
    }
    if (pattern.length > winner.pattern.length) {
      winner = { surface, pattern };
      continue;
    }
    if (
      pattern.length === winner.pattern.length &&
      RANK[surface.mode] > RANK[winner.surface.mode]
    ) {
      winner = { surface, pattern };
    }
  }
  if (winner === null) {
    return { path: relative, mode: defaultMode, surface: null, matchedPattern: null };
  }
  return {
    path: relative,
    mode: winner.surface.mode,
    surface: winner.surface,
    matchedPattern: winner.pattern,
  };
}

/**
 * Режим для набора файлов: самый строгий из встреченных.
 *
 * Партия правок оценивается целиком, а не по файлам: один запрещённый файл среди разрешённых
 * делает запрещённой всю партию. Разделять её — работа отбора, а не этого решения.
 */
export function strictestMode(
  verdicts: readonly SurfaceVerdict[],
  fallback: SurfaceMode,
): SurfaceMode {
  let mode: SurfaceMode = fallback;
  for (const verdict of verdicts) {
    if (RANK[verdict.mode] > RANK[mode]) mode = verdict.mode;
  }
  return mode;
}
