/**
 * Приём и откат партии.
 *
 * Здесь заканчивается цикл «анализ → ограниченная правка → проверка → откат»: команда сверяет
 * дерево с контрольной точкой, гоняет ворота и делает одно из трёх — принимает, откатывает или
 * отдаёт человеку. Решение печатается вместе с причиной: молчаливый откат неотличим от сбоя.
 */
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import type { BaselineSnapshot } from '../verification/behavior-lock.ts';
import { verifyBatch } from '../verification/verifier.ts';
import { ensureWorkspace, type Workspace } from '../state/workspace.ts';
import type { CommandResult } from './commands.ts';
import { loadPolicies } from './commands.ts';

/** Состояние партии между выдачей задания и проверкой. Живёт в рабочем каталоге, вне истории. */
export interface BatchState {
  readonly checkpoint: string;
  readonly allowed: readonly string[];
  readonly findings: readonly string[];
  readonly baseline: BaselineSnapshot;
  readonly createdAt: string;
}

export function batchFile(workspace: Workspace): string {
  return path.join(workspace.state, 'batch.json');
}

export function saveBatch(workspace: Workspace, state: BatchState): void {
  writeFileSync(batchFile(workspace), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function readBatch(workspace: Workspace): BatchState | null {
  const file = batchFile(workspace);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as BatchState;
}

export interface VerifyArgs {
  /** Дополнительные уровни проверки: например, db-набор, выключенный по умолчанию. */
  readonly levels: readonly string[];
  /** Согласие человека на то, что рядом в общем дереве идёт чужая работа. */
  readonly allowConcurrent: boolean;
}

/**
 * Что исполнитель сам назвал изменённым.
 *
 * Отчёт необязателен: ручной адаптер его может и не оставить. Пустой список — не «он ничего не
 * трогал», а «сказать нечем», и тогда любой файл вне партии считается чужой работой, а не выходом
 * за границы. Разница в том, кого система обвиняет, и обвинять без свидетельства она не должна.
 */
function claimedFiles(workspace: Workspace): string[] {
  const file = path.join(workspace.results, 'fix.json');
  if (!existsSync(file)) return [];
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as {
      applied?: { files?: unknown }[];
    };
    const out = new Set<string>();
    for (const item of payload.applied ?? []) {
      if (!Array.isArray(item.files)) continue;
      for (const name of item.files) if (typeof name === 'string') out.add(name);
    }
    return [...out];
  } catch {
    return [];
  }
}

export async function verify(
  config: MaintenanceConfig,
  out: Reporter,
  args: VerifyArgs,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  const workspace = ensureWorkspace(config.runtimeDir);
  const batch = readBatch(workspace);
  if (batch === null) {
    out.error('открытой партии нет: задание исполнителю собирается командой fix-task');
    return { ok: false };
  }

  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  const changed = transaction.changedIn(batch.checkpoint);

  out.heading('партия');
  out.item(`контрольная точка: ${batch.checkpoint}`);
  out.item(`находок: ${batch.findings.join(', ')}`);
  out.item(`разрешено файлов: ${batch.allowed.length}, изменено из них: ${changed.length}`);
  for (const file of changed) out.line(`      ${file}`);

  if (changed.length === 0) {
    // Пустая правка — не повод для отката: откатывать нечего. Но и приёмом это не является:
    // партия просто не сделана, и сказать об этом надо прямо.
    out.heading('решение');
    out.item('ИЗМЕНЕНИЙ НЕТ — исполнитель не тронул ни одного файла партии');
    out.item('партия остаётся открытой: либо выполните задание, либо снимите её командой abort');
    return { ok: false };
  }

  out.heading('проверка');
  const result = verifyBatch({
    notify: (text) => out.item(text),
    config,
    policies,
    baseline: batch.baseline,
    allowed: batch.allowed,
    claimed: claimedFiles(workspace),
    allowConcurrent: args.allowConcurrent,
    tmpDir: workspace.tmp,
    extraLevels: args.levels,
  });
  out.item(`линт: ${result.lintAfter.summary}`);
  out.item(`типы: ${result.typecheckAfter.summary}`);
  for (const level of result.levels) {
    out.item(`${level.title}: ${level.note} (${Math.round(level.durationMs / 1000)} с)`);
    if (level.output === undefined) continue;
    // Хвост печатается сразу: в общем дереве красным может оказаться чужая работа, и человек
    // должен увидеть это здесь, а не идти перезапускать ворота руками.
    for (const line of level.output.split('\n').slice(-15)) out.line(`      ${line}`);
  }
  for (const violation of result.violations) {
    out.warn(`${violation.kind}: ${violation.detail}`);
    for (const file of violation.files) out.line(`      ${file}`);
  }

  writeFileSync(
    path.join(workspace.reports, 'verification.json'),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), batch, changed, result }, null, 2)}\n`,
    'utf8',
  );

  out.heading('решение');
  if (result.outcome === 'accept') {
    await transaction.accept(batch.checkpoint);
    rmSync(batchFile(workspace), { force: true });
    out.item(`ПРИНЯТО — ${result.reason}`);
    out.item('изменения остаются в рабочем дереве; коммит делает человек');
    return { ok: true };
  }

  if (result.outcome === 'rollback') {
    const report = await transaction.rollback(batch.checkpoint);
    rmSync(batchFile(workspace), { force: true });
    out.item(`ОТКАЧЕНО — ${result.reason}`);
    out.item(
      `восстановлено файлов: ${report.restored.length}, удалено созданных: ${report.removed.length}`,
    );
    out.item(
      'это не повод чинить дальше: следующий круг начинается с анализа, а не с правки поверх',
    );
    return { ok: false };
  }

  out.item(`НУЖЕН ЧЕЛОВЕК — ${result.reason}`);
  out.item(`контрольная точка сохранена: ${batch.checkpoint}`);
  out.item(
    'система ничего не трогает: откат разрешённой половины оставил бы дерево в состоянии, которого не было',
  );
  return { ok: false };
}

/** Снять партию, не принимая и не откатывая: человек разобрался сам. */
export async function abortBatch(
  config: MaintenanceConfig,
  out: Reporter,
  { rollback }: { rollback: boolean },
): Promise<CommandResult> {
  const workspace = ensureWorkspace(config.runtimeDir);
  const batch = readBatch(workspace);
  if (batch === null) {
    out.error('открытой партии нет');
    return { ok: false };
  }
  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  if (rollback) {
    const report = await transaction.rollback(batch.checkpoint);
    out.item(`откачено: восстановлено ${report.restored.length}, удалено ${report.removed.length}`);
  } else {
    await transaction.accept(batch.checkpoint);
    out.item('контрольная точка снята, дерево оставлено как есть');
  }
  rmSync(batchFile(workspace), { force: true });
  return { ok: true };
}
