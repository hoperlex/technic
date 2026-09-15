/**
 * Кто относит задание агенту: выбор адаптера и один общий способ его позвать.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ. Заданий в системе два (ревьюеру и исполнителю), команд — тоже
 * несколько, и без общего места каждая звала бы агента по-своему: где-то с таймаутом, где-то без,
 * где-то печатая путь к ответу, где-то молча. Разойдись эти способы — и человек перестал бы
 * понимать, чего система ждёт и от кого.
 */
import path from 'node:path';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { AgentAdapter, AgentReply } from '../agents/adapter.ts';
import { manualAdapter } from '../agents/manual.ts';
import { commandAdapter } from '../agents/command.ts';
import type { WorkPacket } from '../work-packets/types.ts';
import type { Workspace } from '../state/workspace.ts';

/** Потолок ожидания по умолчанию: двадцать минут. Ноль означал бы «ждать вечно». */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Какой адаптер взять.
 *
 * Флаг командной строки главнее конфига намеренно: конфиг описывает обычный порядок работы, а
 * флаг — сегодняшнее решение человека, и оно не должно требовать правки файла в истории.
 */
export function adapterFor(
  config: MaintenanceConfig,
  override: 'manual' | 'command' | null,
): AgentAdapter {
  const settings = config.agent;
  const mode = override ?? settings?.mode ?? 'manual';
  if (mode === 'manual') return manualAdapter();

  const command = settings?.command ?? [];
  if (command.length === 0) {
    // Команда не названа — это не повод молча свалиться в ручной режим: человек просил
    // самоходный, и подмена без предупреждения выглядела бы как «агент ничего не нашёл».
    throw new Error('режим command выбран, но команда агента не задана в maintenance.config.ts');
  }
  return commandAdapter({
    command,
    dryRun: settings?.dryRun === true,
    log: (text) => process.stdout.write(`${text}\n`),
  });
}

/**
 * Позвать адаптер и рассказать человеку, чем кончилось.
 *
 * Отказ агента печатается как отказ, а не как пустой ответ: «агент не отработал» и «агент ничего
 * не нашёл» — разные новости, и путать их нельзя, иначе несостоявшийся прогон читается как
 * «в коде порядок».
 */
export function deliver(
  adapter: AgentAdapter,
  packet: WorkPacket,
  config: MaintenanceConfig,
  workspace: Workspace,
  out: Reporter,
): AgentReply {
  const reply = adapter.deliver(packet, {
    root: config.root,
    taskFile: workspace.taskFile,
    answerFile: path.join(config.root, packet.outputFile),
    timeoutMs: config.agent?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (reply.kind === 'awaiting') {
    out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
    out.item(`ответ положить в ${packet.outputFile}, затем повторить команду`);
    return reply;
  }
  if (reply.kind === 'failed') {
    out.error(`агент ${adapter.title}: ${reply.why}`);
    return reply;
  }
  out.item(`агент ${adapter.title} ответил (${reply.text.length} символов)`);
  return reply;
}
