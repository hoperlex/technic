/**
 * Проверка партии и решение о её судьбе.
 *
 * РЕШЕНИЙ РОВНО ТРИ, И ПРИНИМАЕТ ИХ КОД: принять, откатить, отдать человеку. Четвёртого —
 * «попробовать починить ещё раз» — здесь нет намеренно: один проваленный batch не должен
 * становиться началом свободного самоисправления. Новый круг начинается сверху, с анализа, и
 * только по решению оркестратора.
 */
import type { MaintenanceConfig } from '../core/config.ts';
import type { LintFacts, ToolRun } from '../core/facts.ts';
import type { PolicySet } from '../core/types.ts';
import { run } from '../analyzers/run.ts';
import { collectLint } from '../analyzers/lint.ts';
import { toolRun } from '../analyzers/run.ts';
import { checkBehaviorLock, type BaselineSnapshot, type LockViolation } from './behavior-lock.ts';
import { createIsolatedTree } from '../git/worktree.ts';
import path from 'node:path';

export type Outcome = 'accept' | 'rollback' | 'manual-review';

export interface LevelResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly note: string;
  /**
   * Хвост вывода упавшего шага.
   *
   * Без него отчёт говорит «проверка не прошла» и замолкает — а человеку нужно знать, ЧТО именно
   * не прошло, и особенно в общем дереве: там красным может оказаться чужая работа, и тогда откат
   * верной правки объясняется не ею.
   */
  readonly output?: string;
}

export interface VerificationResult {
  readonly outcome: Outcome;
  readonly reason: string;
  readonly levels: readonly LevelResult[];
  readonly violations: readonly LockViolation[];
  readonly lintAfter: LintFacts;
  readonly typecheckAfter: ToolRun;
}

export interface VerifyOptions {
  readonly config: MaintenanceConfig;
  readonly policies: PolicySet;
  readonly baseline: BaselineSnapshot;
  readonly allowed: readonly string[];
  /** Файлы, которые исполнитель назвал изменёнными: из его отчёта `fix.json`. */
  readonly claimed: readonly string[];
  /**
   * Согласие человека на то, что рядом идёт чужая работа.
   *
   * Без него чужие правки останавливают приём: система не вправе решать за человека, что
   * появившиеся в дереве файлы — не последствие её же партии. С ним — она их просто не трогает,
   * что и так верно: ни приём, ни откат за пределы партии не выходят.
   */
  readonly allowConcurrent: boolean;
  readonly tmpDir: string;
  /** Дополнительные уровни проверки сверх включённых по умолчанию. */
  readonly extraLevels: readonly string[];
}

/** Последние строки вывода: полный лог инструмента нечитаем, а хвост обычно и есть ответ. */
function tailOf(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n').trim();
}

/**
 * Где проверять партию.
 *
 * ОБЩЕЕ ДЕРЕВО ДЛЯ ЭТОГО НЕ ГОДИТСЯ. В нём всегда лежит чужая незавершённая работа, и ворота
 * краснеют по чужой причине: верная правка системы откатывается, а человек видит «проверка не
 * прошла» без объяснения. Проверено трижды на живых прогонах.
 *
 * Изолированное дерево отвечает ровно на тот вопрос, который и нужен: «зелено ли HEAD плюс эта
 * партия». Именно это и уедет в коммит — ни больше, ни меньше.
 *
 * Базовая линия снимается ТАМ ЖЕ, только без файлов партии. Сравнивать изолированный прогон с
 * замером на грязном дереве нельзя: разница тогда означала бы не «стало хуже от правки», а
 * «дерево другое».
 */
function measure(root: string, config: MaintenanceConfig, tmpDir: string, suffix: string) {
  const lint = collectLint({
    root,
    command: config.analysis.lintCommand,
    outFile: path.join(tmpDir, `lint-${suffix}.json`),
    keepMessages: 50,
  });
  const typecheckRun = run(root, config.analysis.typecheckCommand);
  const typecheck = toolRun(
    typecheckRun,
    typecheckRun.code === 0 ? 'типы сходятся' : `типы не сходятся (код ${typecheckRun.code})`,
  );
  return { lint, typecheck };
}

/**
 * Базовая линия «до правки».
 *
 * Снимается там же, где потом пойдёт проверка: в изолированном дереве — от `HEAD` без файлов
 * партии. Иначе сравнение вышло бы между разными деревьями, и «стало хуже» означало бы «дерево
 * другое». Без изоляции остаётся прежнее поведение: замер прямо в рабочем дереве.
 */
export function measureBaseline(
  config: MaintenanceConfig,
  tmpDir: string,
): { lint: LintFacts; typecheck: ToolRun } {
  if (config.analysis.isolateVerification !== true) {
    return measure(config.root, config, tmpDir, 'before');
  }
  const tree = createIsolatedTree({
    root: config.root,
    home: path.join(tmpDir, 'trees'),
    files: [],
    linkPaths: config.analysis.linkPaths ?? [],
  });
  try {
    return measure(tree.path, config, tmpDir, 'before');
  } finally {
    tree.dispose();
  }
}

/**
 * Виновата ли партия в падении шага.
 *
 * Ответ «нет» означает, что тот же шаг падает на голой базе. Проверяется только при изоляции: без
 * неё базы как отдельного дерева не существует, и отличить чужую красноту от своей нечем — там
 * остаётся прежнее поведение, откат.
 */
function blameBatch(
  config: MaintenanceConfig,
  options: VerifyOptions,
  failed: readonly LevelResult[],
): boolean {
  if (config.analysis.isolateVerification !== true) return true;
  const base = createIsolatedTree({
    root: config.root,
    home: path.join(options.tmpDir, 'trees'),
    files: [],
    linkPaths: config.analysis.linkPaths ?? [],
  });
  try {
    for (const level of failed) {
      const command = config.verification.find((item) => item.id === level.id)?.command;
      if (command === undefined) continue;
      // Хоть один шаг, зелёный на базе и красный с партией, — и вина партии доказана.
      if (run(base.path, command).code === 0) return true;
    }
    return false;
  } finally {
    base.dispose();
  }
}

export function verifyBatch(options: VerifyOptions): VerificationResult {
  const { config } = options;
  const isolate = config.analysis.isolateVerification === true;

  const tree = isolate
    ? createIsolatedTree({
        root: config.root,
        home: path.join(options.tmpDir, 'trees'),
        files: options.allowed,
        linkPaths: config.analysis.linkPaths ?? [],
      })
    : null;
  const where = tree?.path ?? config.root;

  const measured = measure(where, config, options.tmpDir, 'after');
  const lintAfter = measured.lint;
  const typecheckAfter = measured.typecheck;

  // Замок поведения смотрит на ОСНОВНОЕ дерево: он отвечает не «зелено ли», а «что тронул
  // исполнитель», и ответ на это лежит там, где исполнитель работал.
  const violations = checkBehaviorLock({
    config,
    policies: options.policies,
    baseline: options.baseline,
    allowed: options.allowed,
    claimed: options.claimed,
    lintAfter,
    typecheckAfter,
  });

  /*
   * Замок поведения проверяется ДО прогона тестов, и это не оптимизация времени.
   * Вышедшая за границы партии правка делает любой исход тестов бессмысленным: зелено — значит
   * зелено вместе с тем, чего мы не разрешали и не сможем откатить.
   */
  const outOfControl = violations.filter(
    (violation) =>
      violation.kind === 'out-of-scope' ||
      violation.kind === 'evidence-touched' ||
      violation.kind === 'protected-touched' ||
      (violation.kind === 'concurrent-change' && !options.allowConcurrent),
  );
  if (outOfControl.length > 0) {
    tree?.dispose();
    return {
      // Не откат: файлы вне партии система не сохраняла и восстановить их не может, а откат
      // разрешённой половины оставил бы дерево в состоянии, которого не было никогда.
      outcome: 'manual-review',
      reason: outOfControl.map((violation) => violation.detail).join('; '),
      levels: [],
      violations,
      lintAfter,
      typecheckAfter,
    };
  }

  /*
   * «Стало хуже» решается ДО прогона тестов и без него.
   *
   * Если ошибок линта прибавилось или перестали сходиться типы, исход партии уже известен —
   * откат. Гонять ради этого шестиминутные ворота значит платить временем за ответ, который
   * получен минуту назад.
   */
  const worseBefore = violations.filter((violation) => violation.kind === 'worse-than-before');
  if (worseBefore.length > 0) {
    tree?.dispose();
    return {
      outcome: 'rollback',
      reason: worseBefore.map((violation) => violation.detail).join('; '),
      levels: [],
      violations,
      lintAfter,
      typecheckAfter,
    };
  }

  const levels: LevelResult[] = [];
  for (const level of config.verification) {
    if (!level.enabledByDefault && !options.extraLevels.includes(level.id)) continue;
    const result = run(where, level.command);
    levels.push({
      id: level.id,
      title: level.title,
      ok: result.code === 0,
      durationMs: result.durationMs,
      note: result.code === 0 ? 'зелено' : `код возврата ${result.code}`,
      output: result.code === 0 ? undefined : tailOf(`${result.stdout}\n${result.stderr}`),
    });
  }

  tree?.dispose();
  const failed = levels.filter((level) => !level.ok);

  if (failed.length > 0) {
    /*
     * ПЕРЕД ОТКАТОМ СПРАШИВАЕМ, ЧЬЯ ЭТО КРАСНОТА.
     *
     * Упавший шаг ещё не значит «правка сломала»: база бывает красной сама по себе — сегодня,
     * например, `HEAD` этого репозитория не собирается, потому что коммит забрал файл портала, а
     * его контракты остались незакоммиченными. Откатить в такой ситуации верную правку значит
     * наказать её за чужую поломку и ничего не починить.
     *
     * Поэтому упавший шаг перезапускается на базе БЕЗ партии — и только он один: гонять ради
     * этого все ворота второй раз стоило бы ещё столько же времени.
     */
    const guilty = blameBatch(config, options, failed);
    if (!guilty) {
      return {
        outcome: 'manual-review',
        reason: `база сама красная: ${failed.map((level) => level.title).join(', ')} падает и без этой правки`,
        levels,
        violations,
        lintAfter,
        typecheckAfter,
      };
    }
    return {
      outcome: 'rollback',
      reason: `проверка не прошла: ${failed.map((level) => level.title).join(', ')}`,
      levels,
      violations,
      lintAfter,
      typecheckAfter,
    };
  }
  if (levels.length === 0) {
    // Пустой список уровней — это не «всё хорошо», а «ничего не проверено». Принять партию на
    // этом основании значит объявить доказанным то, что никто не доказывал.
    return {
      outcome: 'manual-review',
      reason: 'ни один уровень проверки не выполнялся: подтверждать сохранение поведения нечем',
      levels,
      violations,
      lintAfter,
      typecheckAfter,
    };
  }

  return {
    outcome: 'accept',
    reason: `проверка пройдена: ${levels.map((level) => level.title).join(', ')}`,
    levels,
    violations,
    lintAfter,
    typecheckAfter,
  };
}
