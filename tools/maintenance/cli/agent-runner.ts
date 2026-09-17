/**
 * Кто относит задание агенту: выбор адаптера и один общий способ его позвать.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ. Заданий в системе два (ревьюеру и исполнителю), команд — несколько, и
 * без общего места каждая звала бы агента по-своему: где-то с таймаутом, где-то без, где-то печатая
 * путь к ответу, где-то молча. Разойдись эти способы — и человек перестал бы понимать, чего система
 * ждёт и от кого.
 *
 * РОЛЬ РЕШАЕТ, С КАКИМИ ПРАВАМИ ЗАПУСКАТЬ. Ревьюеру инструменты правки запрещены аргументами
 * программы, а не только словами задания: правка, сделанная им, обошла бы отбор, бюджет и
 * контрольную точку — всё, ради чего система и построена. Исполнителю правка разрешена, потому что
 * это его работа, а границы держат точка, замок поведения и откат.
 */
import path from 'node:path';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { AgentAdapter, AgentReply } from '../agents/adapter.ts';
import { manualAdapter } from '../agents/manual.ts';
import { commandAdapter } from '../agents/command.ts';
import { CLAUDE_ROLE_ARGS, resolveClaudeBinary } from '../agents/claude-cli.ts';
import type { PacketRole, WorkPacket } from '../work-packets/types.ts';
import type { Workspace } from '../state/workspace.ts';

/** Потолок ожидания по умолчанию: двадцать минут. Ноль означал бы «ждать вечно». */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Какой адаптер взять для этой роли.
 *
 * Флаг командной строки главнее конфига намеренно: конфиг описывает обычный порядок работы, а
 * флаг — сегодняшнее решение человека, и оно не должно требовать правки файла в истории.
 */
export function adapterFor(
  config: MaintenanceConfig,
  role: PacketRole,
  override: 'manual' | 'command' | null,
  out: Reporter,
): AgentAdapter {
  const settings = config.agent;
  const mode = override ?? settings?.mode ?? 'manual';
  if (mode === 'manual') return manualAdapter();

  const binary = resolveClaudeBinary(settings?.binary ?? null);
  if (binary === null) {
    /*
     * Программы нет — а человек просил самоходный прогон. Молча вернуться к ручному режиму нельзя:
     * он ждал бы ответа, которого никто не принесёт, и решил бы, что агент ничего не нашёл.
     */
    throw new Error(
      'режим command выбран, но программа агента не найдена: ни в настройке, ни в PATH, ни в расширениях редактора',
    );
  }

  // Умолчания флагов живут рядом с самой программой, а не здесь: раннер знает роль и адаптер, но
  // не должен знать, какими ключами эта конкретная программа запрещает правку.
  const roleArgs =
    role === 'reviewer'
      ? (settings?.reviewerArgs ?? CLAUDE_ROLE_ARGS.reviewer)
      : (settings?.fixerArgs ?? CLAUDE_ROLE_ARGS.fixer);

  out.item(
    `агент: ${binary.version ?? 'версия неизвестна'} (${binary.source}), роль ${role}, аргументы: ${roleArgs.join(' ')}`,
  );

  return commandAdapter({
    command: [binary.path, ...roleArgs],
    id: `claude-${role}`,
    title: `claude (${role})`,
    dryRun: settings?.dryRun === true,
    log: (text) => out.line(`      ${text}`),
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
  const started = Date.now();
  const timeoutMs = config.agent?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Пока агент думает, команда не печатает ничего: вывод приходит одним куском в конце. Минуты
  // тишины неотличимы от зависания, поэтому ожидание объявляется заранее и с потолком.
  if (adapter.id !== 'manual') {
    out.item(`жду ответ агента: это минуты, потолок ${Math.round(timeoutMs / 60000)} мин`);
  }
  const reply = adapter.deliver(packet, {
    root: config.root,
    taskFile: workspace.taskFile,
    answerFile: path.join(config.root, packet.outputFile),
    timeoutMs,
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
  const seconds = Math.round((Date.now() - started) / 1000);
  out.item(`агент ${adapter.title} ответил за ${seconds} с (${reply.text.length} символов)`);
  return reply;
}
