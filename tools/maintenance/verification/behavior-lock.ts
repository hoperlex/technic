/**
 * Замок поведения: проверки, которые идут ДО и ВМЕСТО доверия к зелёному прогону.
 *
 * Зелёные тесты доказывают сохранение поведения только при двух условиях: правка не вышла за
 * границы партии и доказательство не подправлено под правку. Без них «всё зелено» означает лишь
 * то, что исполнитель сумел сделать прогон зелёным — а это другое утверждение.
 *
 * Поэтому здесь четыре независимых вопроса:
 *   1. изменилось ли что-то за пределами разрешённого списка файлов;
 *   2. не тронуты ли тесты и другие носители доказательства;
 *   3. не тронуты ли защищённые области;
 *   4. не стало ли хуже там, где измеримо (ошибки линта, типы).
 */
import type { MaintenanceConfig } from '../core/config.ts';
import type { LintFacts, ToolRun } from '../core/facts.ts';
import type { PolicySet } from '../core/types.ts';
import { collectGit } from '../analyzers/git.ts';
import { normalizePath } from '../core/paths.ts';
import { resolveSurface } from '../policies/surfaces.ts';

export interface LockViolation {
  readonly kind:
    | 'out-of-scope'
    | 'concurrent-change'
    | 'evidence-touched'
    | 'protected-touched'
    | 'worse-than-before';
  readonly detail: string;
  readonly files: readonly string[];
}

export interface BaselineSnapshot {
  readonly lintErrors: number;
  readonly lintWarnings: number;
  readonly typecheckOk: boolean;
  /** Файлы, изменённые в дереве ДО правки: чужая работа, которую нельзя приписать партии. */
  readonly dirtyBefore: readonly string[];
}

export function snapshotBaseline(
  config: MaintenanceConfig,
  lint: LintFacts,
  typecheck: ToolRun,
): BaselineSnapshot {
  return {
    lintErrors: lint.errors,
    lintWarnings: lint.warnings,
    typecheckOk: typecheck.ok,
    dirtyBefore: collectGit(config.root).changedFiles,
  };
}

export interface LockInput {
  readonly config: MaintenanceConfig;
  readonly policies: PolicySet;
  readonly baseline: BaselineSnapshot;
  /** Файлы, которые партии разрешено менять. */
  readonly allowed: readonly string[];
  /**
   * Файлы, которые исполнитель сам назвал изменёнными (отчёт `fix.json`).
   *
   * Нужны, чтобы отличить две разные беды. Файл вне партии, названный исполнителем, — выход за
   * границы: он сделал то, чего не разрешали. Файл вне партии, которого исполнитель не называл, —
   * почти наверняка чужая параллельная работа: дерево общее, и пока шли ворота, рядом правили
   * своё. Первое запрещено, второе — обычная жизнь репозитория, и валить на неё прогон нельзя.
   */
  readonly claimed: readonly string[];
  readonly lintAfter: LintFacts;
  readonly typecheckAfter: ToolRun;
}

/**
 * Что изменилось помимо разрешённого.
 *
 * Сравнение идёт со СНИМКОМ ДО, а не с чистым деревом: в общем дереве уже лежала чужая работа, и
 * считать её правкой исполнителя нельзя — иначе система откатывала бы чужое или, что хуже,
 * отказывалась работать при каждом чужом черновике.
 */
export function checkBehaviorLock(input: LockInput): LockViolation[] {
  const { config, policies, baseline } = input;
  const allowed = new Set(input.allowed.map((file) => normalizePath(config.root, file)));
  const before = new Set(baseline.dirtyBefore.map((file) => normalizePath(config.root, file)));
  const now = collectGit(config.root).changedFiles.map((file) => normalizePath(config.root, file));

  const violations: LockViolation[] = [];
  const claimed = new Set(input.claimed.map((file) => normalizePath(config.root, file)));
  const outside = now.filter((file) => !allowed.has(file) && !before.has(file));
  const byFixer = outside.filter((file) => claimed.has(file));
  const byOthers = outside.filter((file) => !claimed.has(file));

  if (byFixer.length > 0) {
    violations.push({
      kind: 'out-of-scope',
      detail:
        'исполнитель правил файлы вне партии: система их не сохраняла, откатить не может и принять не вправе',
      files: byFixer,
    });
  }
  if (byOthers.length > 0) {
    violations.push({
      kind: 'concurrent-change',
      detail:
        'в дереве появились изменения вне партии, которых исполнитель не называл — похоже на чужую параллельную работу',
      files: byOthers,
    });
  }

  const touched = now.filter((file) => allowed.has(file));

  const evidence = touched.filter((file) => isEvidence(file));
  if (evidence.length > 0) {
    violations.push({
      kind: 'evidence-touched',
      detail: 'тронуто доказательство поведения: подгонять тест под правку запрещено',
      files: evidence,
    });
  }

  const protectedFiles = touched.filter((file) => {
    const verdict = resolveSurface(config.root, policies.surfaces, policies.surfaceDefault, file);
    return verdict.mode !== 'allowed';
  });
  if (protectedFiles.length > 0) {
    violations.push({
      kind: 'protected-touched',
      detail: 'тронута защищённая область',
      files: protectedFiles,
    });
  }

  // Несработавший линт — не «ошибок ноль», а «сравнить нечем». Принять партию в таком состоянии
  // значит объявить доказанным то, что никто не измерил.
  if (!input.lintAfter.measured) {
    violations.push({
      kind: 'worse-than-before',
      detail: `линт не дал машинного отчёта (${input.lintAfter.summary}): сравнить с базовой линией нечем`,
      files: [],
    });
  }

  // «Не хуже» считается по ошибкам, а не по предупреждениям: предупреждения — это долг, и его
  // колебание на единицу не повод откатывать верную правку. Ошибка же означает сломанное.
  if (input.lintAfter.errors > baseline.lintErrors) {
    violations.push({
      kind: 'worse-than-before',
      detail: `ошибок линта стало больше: было ${baseline.lintErrors}, стало ${input.lintAfter.errors}`,
      files: [],
    });
  }
  if (baseline.typecheckOk && !input.typecheckAfter.ok) {
    violations.push({
      kind: 'worse-than-before',
      detail: 'типы сходились до правки и не сходятся после',
      files: [],
    });
  }

  return violations;
}

/**
 * Носители доказательства поведения.
 *
 * Признак — путь, а не содержимое: тест может лежать рядом с кодом или в отдельном каталоге, но
 * и то, и другое читается по имени. Ошибка в сторону строгости здесь дешевле: лишний отказ стоит
 * одной ручной проверки, пропуск — веры в зелёный прогон, который ничего не доказывает.
 */
function isEvidence(file: string): boolean {
  return /(^|\/)test(s)?\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}
