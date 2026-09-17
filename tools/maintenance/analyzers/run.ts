/**
 * Запуск внешних инструментов.
 *
 * Все инструменты зовутся отсюда и одинаково: без оболочки (аргументы не разбираются вторично),
 * с замером времени и с сохранением вывода. Вывод сохраняется всегда, даже при успехе: разбирая
 * красный прогон, человек первым делом хочет увидеть, что напечатал сам инструмент, а не наш
 * пересказ.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ToolRun } from '../core/facts.ts';

/**
 * Пульс долгого шага.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ ПРОЦЕССОМ. Инструменты зовутся синхронно: пока идёт линт по репозиторию или
 * ворота, наш процесс стоит в системном вызове и не может напечатать ни строки — таймеры в нём не
 * срабатывают по определению. Значит, говорить «я жив» должен кто-то другой, и другого способа,
 * кроме второго процесса, у синхронного запуска нет.
 *
 * ЗАЧЕМ ВООБЩЕ. Молчание в три минуты и зависание выглядят одинаково, и человек жмёт Ctrl-C —
 * ровно тогда, когда правка уже в дереве, а решение по ней ещё не принято. Пульс стоит одного
 * лишнего процесса на шаг и снимает этот обрыв.
 *
 * Пульс сам следит за тем, что его никто не бросил: если родитель умер (ppid стал 1) или прошёл
 * час, он выходит. Иначе забытый процесс печатал бы точки в чужой терминал до перезагрузки.
 */
const PULSE_SOURCE = `
const label = process.argv[1];
const every = Number(process.argv[2]);
const started = Date.now();
setInterval(() => {
  if (process.ppid <= 1) process.exit(0);
  const sec = Math.round((Date.now() - started) / 1000);
  if (sec > 3600) process.exit(0);
  process.stdout.write('      … ' + label + ': идёт ' + sec + ' с\\n');
}, every).unref?.();
setTimeout(() => process.exit(0), 3610 * 1000);
`;

/** Сколько ждать между ударами пульса: реже — снова похоже на тишину, чаще — мешает читать. */
const PULSE_EVERY_MS = 20_000;

/**
 * Запустить пульс. Возвращает «погасить»; гасить обязательно, и лучше в `finally`.
 */
export function startPulse(label: string, everyMs: number = PULSE_EVERY_MS): () => void {
  const child = spawn(process.execPath, ['-e', PULSE_SOURCE, label, String(everyMs)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  return () => {
    child.kill('SIGKILL');
  };
}

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
  options: { input?: string; pulse?: string } = {},
): RunResult {
  const [binary, ...args] = command;
  const started = Date.now();
  if (binary === undefined) {
    return { code: -1, stdout: '', stderr: 'пустая команда', durationMs: 0, failedToStart: true };
  }
  // Пульс заводится только там, где его просили: у `git rev-parse` он был бы шумом.
  const stopPulse = options.pulse === undefined ? null : startPulse(options.pulse);
  let result;
  try {
    result = spawnSync(binary, args, {
      cwd: root,
      encoding: 'utf8',
      input: options.input,
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    stopPulse?.();
  }
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
