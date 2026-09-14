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

export function verifyBatch(options: VerifyOptions): VerificationResult {
  const { config } = options;

  const lintAfter = collectLint({
    root: config.root,
    command: config.analysis.lintCommand,
    outFile: path.join(options.tmpDir, 'lint-after.json'),
    keepMessages: 50,
  });
  const typecheckRun = run(config.root, config.analysis.typecheckCommand);
  const typecheckAfter = toolRun(
    typecheckRun,
    typecheckRun.code === 0 ? 'типы сходятся' : `типы не сходятся (код ${typecheckRun.code})`,
  );

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
    const result = run(config.root, level.command);
    levels.push({
      id: level.id,
      title: level.title,
      ok: result.code === 0,
      durationMs: result.durationMs,
      note: result.code === 0 ? 'зелено' : `код возврата ${result.code}`,
      output: result.code === 0 ? undefined : tailOf(`${result.stdout}\n${result.stderr}`),
    });
  }

  const failed = levels.filter((level) => !level.ok);

  if (failed.length > 0) {
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
