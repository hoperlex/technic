/**
 * Печать в терминал.
 *
 * Через `process.stdout`, а не `console`: корневые скрипты этого класса не размечены
 * node-глобалями в конфиге линта, и `console` там читается как опечатка. Заодно отчёт получает
 * единственную точку вывода — её легко подменить файлом или буфером.
 */
import process from 'node:process';
import path from 'node:path';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import type { Reporter } from '../core/contracts.ts';

/** Когда журнал перекладывается в `.1`: мегабайты текста в одном файле никто читать не станет. */
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Обрыв канала — не ошибка программы.
 *
 * `pnpm maintain modules | head -30` закрывает поток на середине печати, и Node превращает это в
 * необработанное событие `error`: команда падает стеком там, где на самом деле всё сработало.
 * Обработчик ставится один раз на процесс и глушит только `EPIPE`; всё остальное по-прежнему
 * падает, потому что означает настоящую поломку вывода.
 */
let pipeGuarded = false;

function guardBrokenPipe(): void {
  if (pipeGuarded) return;
  pipeGuarded = true;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }
}

export class ConsoleReporter implements Reporter {
  /**
   * Куда, кроме терминала, ложится каждая строка.
   *
   * ПОЧЕМУ ЖУРНАЛ НУЖЕН ОТДЕЛЬНО ОТ ТЕРМИНАЛА. Прогон идёт десятки минут, и терминал за это время
   * закрывают, теряют в прокрутке или обрывают Ctrl-C. Журнал переживает всё это, а `tail -f`
   * по нему даёт второе окно, в котором видно ход прямо сейчас — не дожидаясь конца шага.
   *
   * Строка уходит в файл сразу, а не накапливается в буфере: журнал, доезжающий до диска на
   * выходе программы, бесполезен ровно в том случае, ради которого заводился.
   */
  private readonly logFile: string | null;

  constructor(logFile: string | null = null) {
    guardBrokenPipe();
    this.logFile = logFile;
    if (logFile !== null) rotate(logFile);
  }

  line(text = ''): void {
    process.stdout.write(`${text}\n`);
    this.log(text);
  }

  /**
   * Запись ТОЛЬКО в журнал.
   *
   * Заголовок запуска («когда, какой командой») нужен разбирающему журнал и совершенно не нужен
   * человеку у терминала: он и так знает, что набрал.
   */
  note(text: string): void {
    this.log(text);
  }

  /** Строка в журнал со временем. Отказ записи молчит: из-за журнала команда падать не должна. */
  private log(text: string): void {
    if (this.logFile === null) return;
    const stamp = new Date().toISOString().slice(11, 19);
    try {
      appendFileSync(this.logFile, `${stamp} ${text}\n`, 'utf8');
    } catch {
      /* журнал — удобство, а не условие работы */
    }
  }

  heading(text: string): void {
    const head = `── ${text} `;
    this.line();
    this.line(`${head}${'─'.repeat(Math.max(3, 78 - head.length))}`);
  }

  item(text: string): void {
    this.line(`  ${text}`);
  }

  warn(text: string): void {
    this.line(`  ! ${text}`);
  }

  error(text: string): void {
    process.stderr.write(`  ОШИБКА ${text}\n`);
    this.log(`  ОШИБКА ${text}`);
  }
}

/** Завести каталог журнала и переложить разросшийся файл в `.1`. */
function rotate(logFile: string): void {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    if (statSync(logFile).size > LOG_LIMIT_BYTES) renameSync(logFile, `${logFile}.1`);
  } catch {
    /* файла ещё нет или каталог недоступен — обе новости не стоят падения команды */
  }
}
