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
  out.line('Дальнейшие команды (analyze, review, fix-task, verify, converge, deep, report)');
  out.line('появляются этапами ЭB–ЭF плана docs/maintenance-framework-plan.md.');
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
