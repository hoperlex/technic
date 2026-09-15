#!/usr/bin/env node
/**
 * `pnpm maintain <команда>` — оболочка над внутренним API системы обслуживания.
 *
 * Здесь нет ни одного решения о проекте: разбор аргументов, вызов команды, код возврата. Всё
 * остальное живёт в ядре — иначе вынести ядро во внешнюю библиотеку было бы нечем.
 *
 * Запускается штатным Node: с версии 22 он снимает типы сам, и сборщик системе не нужен. Цена
 * этого — только стираемый синтаксис (никаких `enum` и `namespace`) и расширение `.ts` в
 * относительных импортах.
 *
 * Постановка и этапы: docs/maintenance-framework-plan.md.
 */
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.ts';
import { MaintenanceConfigError } from '../core/errors.ts';
import { ConsoleReporter } from '../reporters/console.ts';
import type { Severity } from '../core/types.ts';
import { doctor, showModules, showPolicies, showSurfaces, type CommandResult } from './commands.ts';
import { analyze, fixTask, review } from './analyze.ts';
import { abortBatch, verify } from './verify.ts';
import { converge, report } from './converge.ts';
import { deep } from './deep.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = new ConsoleReporter();

function help(): void {
  out.line('pnpm maintain <команда>');
  out.line();
  out.line('  doctor                  проверить конфиг, политики, карту и рабочий каталог');
  out.line('  policies [--severity …] перечень правил (hard | soft | advisory)');
  out.line('  surfaces [путь …]       защищённые области; с путями — решение по каждому');
  out.line('  modules                 пакеты, направления, слои и домены');
  out.line();
  out.line('  analyze [--all] [--since <ref>] [--pass <id>] [--with-tests]');
  out.line('                          собрать факты и выдать задание ревьюеру');
  out.line('  review [--file <путь>]  разобрать ответ ревьюера и отобрать безопасное');
  out.line('  fix-task                снять контрольную точку и собрать задание исполнителю');
  out.line('  verify [--level <id>] [--allow-concurrent]');
  out.line('                          проверить правку и принять её либо откатить');
  out.line('  abort [--rollback]      снять открытую партию: с откатом или оставив дерево');
  out.line();
  out.line('  converge [--status] [--abort] [--allow-concurrent] [--level <id>]');
  out.line(
    '                          цикл сходимости: продвигает прогон на шаг и называет следующий',
  );
  out.line('  report                  отчёт прогона и список решений для человека');
  out.line();
  out.line('  deep [--force] [--status] [--abort] [--agent manual|command] [--allow-concurrent]');
  out.line(
    '                          тяжёлое окно: зоны, очередь долга, малые партии, бюджет времени',
  );
}

/** Значение именованного аргумента: `--since HEAD~3`. Отсутствует — `null`, а не пустая строка. */
function valueArg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new MaintenanceConfigError('аргументы', `${name} ожидает значение`);
  }
  return value;
}

/** Повторяемый аргумент: `--level database --level e2e`. */
function allValues(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg !== name) return;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new MaintenanceConfigError('аргументы', `${name} ожидает значение`);
    }
    out.push(value);
  });
  return out;
}

/** Каким адаптером относить задание сегодня. Ошибка лучше молчаливого возврата к ручному режиму. */
function agentArg(args: readonly string[]): 'manual' | 'command' | null {
  const value = valueArg(args, '--agent');
  if (value === null) return null;
  if (value === 'manual' || value === 'command') return value;
  throw new MaintenanceConfigError(
    'аргументы',
    `--agent ожидает manual или command, получено ${value}`,
  );
}

function severityArg(args: readonly string[]): Severity | null {
  const index = args.indexOf('--severity');
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === 'hard' || value === 'soft' || value === 'advisory') return value;
  throw new MaintenanceConfigError('аргументы', '--severity ожидает hard | soft | advisory');
}

async function main(): Promise<number> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return 0;
  }

  const config = await loadConfig(ROOT);
  let result: CommandResult;
  switch (command) {
    case 'doctor':
      result = await doctor(config, out);
      break;
    case 'policies':
      result = await showPolicies(config, out, severityArg(args));
      break;
    case 'surfaces':
      result = await showSurfaces(config, out, args);
      break;
    case 'modules':
      result = await showModules(config, out);
      break;
    case 'analyze':
      result = await analyze(config, out, {
        withTests: args.includes('--with-tests'),
        since: valueArg(args, '--since'),
        all: args.includes('--all'),
        pass: valueArg(args, '--pass'),
      });
      break;
    case 'review':
      result = await review(config, out, { file: valueArg(args, '--file') });
      break;
    case 'fix-task':
      result = await fixTask(config, out);
      break;
    case 'verify':
      result = await verify(config, out, {
        levels: allValues(args, '--level'),
        allowConcurrent: args.includes('--allow-concurrent'),
      });
      break;
    case 'abort':
      result = await abortBatch(config, out, { rollback: args.includes('--rollback') });
      break;
    case 'converge':
      result = await converge(config, out, {
        allowConcurrent: args.includes('--allow-concurrent'),
        levels: allValues(args, '--level'),
        abort: args.includes('--abort'),
        status: args.includes('--status'),
      });
      break;
    case 'report':
      result = await report(config, out);
      break;
    case 'deep':
      result = await deep(config, out, {
        force: args.includes('--force'),
        allowConcurrent: args.includes('--allow-concurrent'),
        status: args.includes('--status'),
        abort: args.includes('--abort'),
        agent: agentArg(args),
      });
      break;
    default:
      out.error(`неизвестная команда: ${command}`);
      out.line();
      help();
      return 2;
  }
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Ошибка политики — это «поправьте файл», а не сбой программы: стек здесь прячет единственное,
  // что нужно человеку. Всё остальное печатается стеком, потому что означает дефект системы.
  if (error instanceof MaintenanceConfigError) {
    out.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
