/**
 * Печать в терминал.
 *
 * Через `process.stdout`, а не `console`: корневые скрипты этого класса не размечены
 * node-глобалями в конфиге линта, и `console` там читается как опечатка. Заодно отчёт получает
 * единственную точку вывода — её легко подменить файлом или буфером.
 */
import process from 'node:process';
import type { Reporter } from '../core/contracts.ts';

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
  constructor() {
    guardBrokenPipe();
  }

  line(text = ''): void {
    process.stdout.write(`${text}\n`);
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
  }
}
