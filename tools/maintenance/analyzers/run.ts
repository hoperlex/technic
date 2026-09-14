/**
 * Запуск внешних инструментов.
 *
 * Все инструменты зовутся отсюда и одинаково: без оболочки (аргументы не разбираются вторично),
 * с замером времени и с сохранением вывода. Вывод сохраняется всегда, даже при успехе: разбирая
 * красный прогон, человек первым делом хочет увидеть, что напечатал сам инструмент, а не наш
 * пересказ.
 */
import { spawnSync } from 'node:child_process';
import type { ToolRun } from '../core/facts.ts';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly failedToStart: boolean;
}

export function run(
  root: string,
  command: readonly string[],
  options: { input?: string } = {},
): RunResult {
  const [binary, ...args] = command;
  const started = Date.now();
  if (binary === undefined) {
    return { code: -1, stdout: '', stderr: 'пустая команда', durationMs: 0, failedToStart: true };
  }
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    return { code: -1, stdout: '', stderr: result.error.message, durationMs, failedToStart: true };
  }
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs,
    failedToStart: false,
  };
}

/** Итог шага в общей форме фактов. */
export function toolRun(result: RunResult, summary: string): ToolRun {
  return { ok: result.code === 0, durationMs: result.durationMs, summary };
}

/** Шаг, который не выполнялся. `ok: false` намеренно: пропуск ничего не доказывает. */
export function skipped(why: string): ToolRun {
  return { ok: false, durationMs: 0, summary: `не выполнялся: ${why}`, skipped: why };
}

/**
 * Подстановка в команду конфига.
 *
 * Команды задаются в конфиге данными, а не кодом, поэтому путь к временному файлу отчёта
 * подставляется токеном. Токен один и известный: выдумывать язык шаблонов ради одного значения
 * дороже, чем он стоит.
 */
export function withOutFile(command: readonly string[], file: string): string[] {
  return command.map((part) => part.replace('{out}', file));
}
