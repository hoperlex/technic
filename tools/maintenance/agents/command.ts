/**
 * Командный адаптер: систему зовёт не человек, а процесс.
 *
 * ЗАЧЕМ. Ручная передача делает цикл пошаговым: каждая выдача задания стоит переключения
 * внимания человека. Командный адаптер закрывает этот разрыв — задание уходит внешнему агенту на
 * stdin, ответ приходит его выводом. Команда задаётся ДАННЫМИ (например
 * `['claude','-p','--permission-mode','acceptEdits']`), потому что выбор агента и его права —
 * решение человека, а не инструмента; код не имеет права знать конкретного поставщика.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Разбора ответа нет: текст отдаётся наверх как есть, разбирает его
 * `core/finding-io.ts`. Решений про находки нет тем более. Адаптер отвечает ровно за доставку —
 * иначе появится второе место, которое понимает формат ответа, и они разойдутся.
 *
 * ПОЧЕМУ НЕ `analyzers/run.ts`. Тот запуск сделан под инструменты, которые заведомо заканчиваются,
 * и таймаута не имеет. Для агента таймаут обязателен, поэтому процесс поднимается здесь.
 */
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AgentAdapter, AgentContext, AgentReply } from './adapter.ts';
import type { WorkPacket } from '../work-packets/types.ts';
import { renderPacket } from '../work-packets/render.ts';

export interface CommandAgentOptions {
  /** Команда и аргументы. Запускается БЕЗ оболочки: строку из конфига никто не разбирает дважды. */
  readonly command: readonly string[];
  readonly id?: string;
  readonly title?: string;
  /**
   * Сухой прогон: показать команду и ничего не запускать.
   *
   * Момент, когда дерево впервые отдают чужому процессу с правом правки, — не тот момент, когда
   * человек должен догадываться, что именно запустится. Поэтому сухой прогон печатает команду и
   * возвращает `awaiting`: задание на диске уже лежит, а решение отдать его — за человеком.
   */
  readonly dryRun?: boolean;
  /** Куда печатать сухой прогон. Подменяется в тестах; по умолчанию — обычный вывод. */
  readonly log?: (text: string) => void;
}

/** Сколько хвоста чужого вывода попадает в причину отказа: длинный лог в одну строку нечитаем. */
const WHY_TAIL = 2000;

export function commandAdapter(options: CommandAgentOptions): AgentAdapter {
  const log = options.log ?? ((text: string) => process.stdout.write(`${text}\n`));
  return {
    id: options.id ?? 'command',
    title: options.title ?? `Внешняя команда: ${options.command.join(' ') || 'не задана'}`,
    deliver(packet: WorkPacket, context: AgentContext): AgentReply {
      const text = renderPacket(packet);
      // Задание пишется на диск и в командном режиме: агент может сослаться на файл, а человек —
      // прочитать его потом, разбирая, на что именно агент отвечал.
      mkdirSync(path.dirname(context.taskFile), { recursive: true });
      mkdirSync(path.dirname(context.answerFile), { recursive: true });
      writeFileSync(context.taskFile, text, 'utf8');

      const [binary, ...args] = options.command;
      if (binary === undefined) {
        return { kind: 'failed', why: 'команда агента не задана' };
      }
      // Таймаут — часть контракта, а не настройка. Нулевой или отрицательный означал бы «ждать
      // вечно», а зависший агент в автоматическом цикле некому прервать.
      if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) {
        return {
          kind: 'failed',
          why: 'таймаут агента обязан быть положительным числом миллисекунд',
        };
      }

      if (options.dryRun === true) {
        log(`сухой прогон: запустил бы ${quote([binary, ...args])}`);
        log(`задание на stdin из ${path.relative(context.root, context.taskFile)}`);
        log(`ответ ожидался бы в ${path.relative(context.root, context.answerFile)}`);
        return { kind: 'awaiting', where: path.relative(context.root, context.taskFile) };
      }

      const result = spawnSync(binary, args, {
        cwd: context.root,
        encoding: 'utf8',
        input: text,
        timeout: context.timeoutMs,
        // SIGTERM агент может перехватить и продолжить думать; ждать этого мы уже не собираемся.
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      });

      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        // Срабатывание таймаута — ОТКАЗ, а не тихий пустой ответ. Разница принципиальная: пустой
        // ответ цикл прочтёт как «агент ничего не нашёл» и пойдёт дальше на ложном основании.
        if (code === 'ETIMEDOUT') {
          return {
            kind: 'failed',
            why: `агент не уложился в ${context.timeoutMs} мс и был снят`,
          };
        }
        return { kind: 'failed', why: `агент не запустился: ${result.error.message}` };
      }

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      if (result.status !== 0) {
        // Код возврата — единственный надёжный признак провала самого запуска. К причине
        // прикладывается хвост вывода: без него человеку нечего читать, кроме номера.
        const why =
          result.status === null
            ? `агент снят сигналом ${String(result.signal)}`
            : `агент вернул код ${result.status}`;
        const tail = tailOf(stderr) || tailOf(stdout);
        return { kind: 'failed', why: tail === '' ? why : `${why}: ${tail}` };
      }

      // Непустой stderr при нулевом коде ошибкой НЕ считается: агенты печатают туда ход работы,
      // предупреждения и статистику. Считать это провалом значило бы отбрасывать верные ответы
      // из-за строки прогресса.
      if (stdout.trim() !== '') {
        // Ответ сохраняется в условленный файл: дальше его читает тот же код, что и в ручном
        // режиме, и человек видит ровно то, что система разбирала.
        writeFileSync(context.answerFile, stdout, 'utf8');
        return { kind: 'answer', text: stdout };
      }

      // Пустой stdout — не обязательно провал: агент мог записать ответ в названный ему файл, а в
      // поток печатать только ход работы.
      if (existsSync(context.answerFile)) {
        const saved = readFileSync(context.answerFile, 'utf8');
        if (saved.trim() !== '') return { kind: 'answer', text: saved };
      }
      return {
        kind: 'failed',
        why: 'агент завершился успешно, но ответа нет ни в выводе, ни в файле ответа',
      };
    },
  };
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > WHY_TAIL ? `…${trimmed.slice(-WHY_TAIL)}` : trimmed;
}

/** Печать команды человеку: аргумент с пробелом должен быть виден как один аргумент. */
function quote(command: readonly string[]): string {
  return command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}
