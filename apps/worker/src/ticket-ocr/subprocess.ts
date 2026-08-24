import { spawn } from 'node:child_process';
import { brokenSubsystem } from './errors';

/**
 * Запуск чужой программы под поводком (план `docs/waste-ticket-ocr-plan.md`, Р9).
 *
 * Модуль зовёт наружу дважды — растеризатор PDF и, если он есть в образе, конвертер HEIC, — и оба
 * раза по одной причине: разбирать враждебный файл в процессе воркера нельзя. Воркер держит
 * соединение с базой и **арендованные задачи очереди** (`job-lease.ts`); разрыв в парсере уносит
 * не одну заявку, а всё, что процесс успел взять, и задачи вернутся в очередь только по истечении
 * аренды.
 *
 * Отсюда три ограничения, и каждое закрывает свой способ умереть:
 *
 * - **срок** — по нему потомок получает `SIGKILL`, а не вежливый `SIGTERM`: зациклившийся парсер
 *   сигнал обработать не обязан;
 * - **память** — `ulimit -v` на потомке. Бомба, разворачивающаяся в гигабайты, упирается в свой
 *   предел и падает сама, вместо того чтобы утащить машину в своп вместе с базой;
 * - **вывод** — обрезается на лету: битый файл заставляет poppler сыпать предупреждениями
 *   мегабайтами, и собирать их в память ради строки в журнале значило бы получить вторую бомбу
 *   вслед за первой.
 *
 * Оболочка в цепочке одна и нужна только ради `ulimit` (`prlimit` в slim-образах нет, а Node не
 * умеет ставить потомку `RLIMIT_AS`). Аргументы ей передаются **позиционно** (`"$@"`), а не
 * склейкой строки: файл с именем `; rm -rf /` иначе был бы командой. `|| :` после `ulimit`
 * намеренный — там, где предел адресного пространства не ставится, программа обязана работать без
 * него, а не молча не запускаться: срок и разрешение растеризации остаются.
 *
 * `exec` в конце не украшение: без него родителем остаётся `sh`, и `SIGKILL` по сроку убивает
 * оболочку, а растеризатор продолжает жевать бомбу уже сиротой.
 */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURED_OUTPUT = 64_000;

export async function runLimited(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; memoryMb: number },
): Promise<RunResult> {
  const kb = String(Math.max(256, Math.round(opts.memoryMb)) * 1024);
  const child = spawn(
    '/bin/sh',
    ['-c', 'ulimit -v "$1" 2>/dev/null || :; shift; exec "$@"', 'sh', kb, bin, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk;
  });

  return await new Promise<RunResult>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * `sh` отвечает 127, когда программы нет вовсе. Это ошибка **образа**, а не файла пользователя:
 * `terminal` + `subsystem` (Р29) — баннер поднимается сразу, повторять задачу бессмысленно, чинить
 * нужно сборку воркера.
 */
export function assertBinaryPresent(bin: string, res: RunResult): void {
  if (res.code !== 127) return;
  throw brokenSubsystem(
    'binary_missing',
    `Программа ${bin} не установлена в образе воркера — обработка таких файлов невозможна.`,
  );
}
