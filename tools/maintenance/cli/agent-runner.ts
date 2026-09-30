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
import { CODEX_ROLE_ARGS, resolveCodexBinary } from '../agents/codex-cli.ts';
import type { PacketRole, WorkPacket } from '../work-packets/types.ts';
import type { Workspace } from '../state/workspace.ts';

/** Потолок ожидания по умолчанию: двадцать минут. Ноль означал бы «ждать вечно». */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export interface AgentCommandOverride {
  /** One-run provider override. `null` keeps the repository setting. */
  readonly provider: 'claude' | 'codex' | null;
  /** One-run model override. `null` keeps the repository setting or the CLI default. */
  readonly model: string | null;
}

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
  commandOverride: AgentCommandOverride = { provider: null, model: null },
): AgentAdapter {
  const settings = config.agent;
  const mode = override ?? settings?.mode ?? 'manual';
  if (mode === 'manual') return manualAdapter();

  const provider = commandOverride.provider ?? settings?.provider ?? 'claude';
  const configuredModel = commandOverride.model ?? settings?.model ?? null;
  const model = configuredModel?.trim() ?? null;
  if (configuredModel !== null && model === '') {
    throw new Error('модель агента не может быть пустой строкой');
  }
  const binary =
    provider === 'codex'
      ? resolveCodexBinary(settings?.binary ?? null)
      : resolveClaudeBinary(settings?.binary ?? null);
  if (binary === null) {
    // Falling back to manual mode would leave an unattended run waiting for an answer forever.
    throw new Error(
      `режим command выбран, но ${provider} не найден: ни в настройке, ни в PATH, ни в расширениях редактора`,
    );
  }

  // Provider-specific permissions stay next to the CLI integration; custom args remain an escape hatch.
  const defaults = provider === 'codex' ? CODEX_ROLE_ARGS : CLAUDE_ROLE_ARGS;
  const roleArgs =
    role === 'reviewer'
      ? (settings?.reviewerArgs ?? defaults.reviewer)
      : (settings?.fixerArgs ?? defaults.fixer);
  // Both supported CLIs accept `--model` as a global option. Keep it before role-specific
  // arguments so Codex sees it before the stdin marker (`-`) at the end of `exec`.
  const commandArgs = model === null ? roleArgs : ['--model', model, ...roleArgs];

  out.item(
    `агент: ${provider} ${binary.version ?? 'версия неизвестна'} (${binary.source}), модель ${model ?? 'по умолчанию CLI'}, роль ${role}, аргументы: ${commandArgs.join(' ')}`,
  );

  return commandAdapter({
    command: [binary.path, ...commandArgs],
    id: `${provider}-${role}`,
    title: `${provider} (${role})`,
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
    // Корень здесь — это КАТАЛОГ КОДА: агент работает там, где лежит дерево прогона (в цехе —
    // отдельное дерево). А ответ ложится в рабочий каталог системы, который всегда в репозитории:
    // складывать ответы в цех значило бы терять их вместе с деревом.
    root: config.root,
    taskFile: workspace.taskFile,
    answerFile: path.join(workspace.results, path.basename(packet.outputFile)),
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
