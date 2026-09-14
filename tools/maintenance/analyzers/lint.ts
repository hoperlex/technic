/**
 * Линт как источник фактов.
 *
 * Числа берутся из машинного отчёта, а не из человеческого текста: пересказ вывода ломается от
 * первой же смены формата, и тогда долг, который «не блокирует и не показывается», растёт
 * незаметно. Ровно так в этом репозитории однажды набралось больше сотни предупреждений.
 *
 * Инструмент здесь не настраивается: какой конфиг и какой командой звать — дело проводки проекта.
 */
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import type { LintFacts, LintMessage } from '../core/facts.ts';
import { run, withOutFile } from './run.ts';

interface EslintFileReport {
  filePath?: string;
  errorCount?: number;
  warningCount?: number;
  messages?: { ruleId?: string | null; line?: number; severity?: number; message?: string }[];
}

export interface LintOptions {
  readonly root: string;
  readonly command: readonly string[];
  /** Куда класть машинный отчёт. Каталог обязан быть вне истории. */
  readonly outFile: string;
  /** Сколько сообщений оставить в фактах. Полный список остаётся в файле отчёта. */
  readonly keepMessages: number;
}

export function collectLint(options: LintOptions): LintFacts {
  const command = withOutFile(options.command, options.outFile);
  const result = run(options.root, command);

  let report: EslintFileReport[] | null = null;
  try {
    report = JSON.parse(readFileSync(options.outFile, 'utf8')) as EslintFileReport[];
  } catch {
    report = null;
  }

  // Код 2 у ESLint означает «не смог проверить», а не «нашёл ошибки». Разница принципиальна:
  // поломка конфига без этой проверки читалась бы как чистый код.
  if (!Array.isArray(report)) {
    return {
      ok: false,
      measured: false,
      durationMs: result.durationMs,
      summary: result.failedToStart
        ? `линт не запустился: ${result.stderr.trim().slice(0, 200)}`
        : 'линт не отдал машинный отчёт',
      errors: 0,
      warnings: 0,
      byRule: {},
      messages: [],
    };
  }

  let errors = 0;
  let warnings = 0;
  const byRule: Record<string, number> = {};
  const messages: LintMessage[] = [];
  for (const file of report) {
    errors += file.errorCount ?? 0;
    warnings += file.warningCount ?? 0;
    for (const message of file.messages ?? []) {
      const rule = message.ruleId ?? '(без правила)';
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      messages.push({
        file: path.relative(options.root, file.filePath ?? ''),
        line: message.line ?? 0,
        rule,
        severity: message.severity === 2 ? 'error' : 'warning',
        message: message.message ?? '',
      });
    }
  }

  // Сообщения упорядочены строго: ошибки раньше предупреждений, дальше по файлу и строке. Иначе
  // обрезка до `keepMessages` зависела бы от порядка обхода файловой системы.
  messages.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  return {
    ok: errors === 0,
    measured: true,
    durationMs: result.durationMs,
    summary: `${errors} ошибок, ${warnings} предупреждений`,
    errors,
    warnings,
    byRule,
    messages: messages.slice(0, options.keepMessages),
  };
}

/** Временный отчёт инструмента удаляется: он не факт, а сырьё для факта. */
export function dropReport(file: string): void {
  rmSync(file, { force: true });
}
