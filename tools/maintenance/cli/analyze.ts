/**
 * Команды протокола анализа: собрать факты, выдать задание, принять ответ, отобрать безопасное.
 *
 * Здесь связываются готовые части и печатается человеческий отчёт; ни отбора, ни разбора ответа
 * в этом файле нет — за них отвечают ядро и анализаторы.
 */
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { PolicySet } from '../core/types.ts';
import type { TrackedFinding } from '../core/finding.ts';
import { parseFindings } from '../core/finding-io.ts';
import { selectFindings, type Selection } from '../core/selector.ts';
import { collectFacts, decisionsFor, saveFacts, widenScope } from '../analyzers/facts.ts';
import { changedSince } from '../analyzers/git.ts';
import { renderPacket } from '../work-packets/render.ts';
import { reviewerPacket } from '../work-packets/reviewer.ts';
import { fixerPacket } from '../work-packets/fixer.ts';
import { ensureWorkspace } from '../state/workspace.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import { snapshotBaseline } from '../verification/behavior-lock.ts';
import { measureBaseline } from '../verification/verifier.ts';
import { readBatch, saveBatch } from './verify.ts';
import type { CommandResult } from './commands.ts';
import { loadPolicies } from './commands.ts';

export interface AnalyzeArgs {
  readonly withTests: boolean;
  readonly since: string | null;
  readonly all: boolean;
  readonly pass: string | null;
}

export async function analyze(
  config: MaintenanceConfig,
  out: Reporter,
  args: AnalyzeArgs,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  const workspace = ensureWorkspace(config.runtimeDir);

  const scopeFiles = resolveScope(config, args);
  if (scopeFiles === null) {
    // Область не определилась — работать не по чему. Молча взять всё дерево нельзя: задание агенту
    // по всему репозиторию — не то, что человек просил командой про изменённое.
    out.error(`git не смог показать изменения от ${args.since ?? 'HEAD'}: проверьте ссылку`);
    return { ok: false };
  }
  out.heading('сбор фактов');
  if (args.all) out.item('область: всё дерево');

  const collected = collectFacts({
    config,
    policies,
    workspace,
    withTests: args.withTests,
    scopeFiles,
  });
  const widened = widenScope(config, policies, collected, scopeFiles);
  const facts = widened.facts;
  out.item(widened.note);
  const file = saveFacts(workspace, facts);

  out.item(`линт: ${facts.lint.summary}`);
  out.item(`типы: ${facts.typecheck.summary}`);
  out.item(
    `тесты: ${facts.tests.skipped === undefined ? facts.tests.summary : facts.tests.summary}`,
  );
  out.item(`зависимости: ${facts.dependencies.summary}`);
  out.item(`файлов измерено: ${facts.metrics.files}, строк всего: ${facts.metrics.totalLines}`);
  out.item(`факты: ${path.relative(config.root, file)}`);

  if (facts.dependencies.violations.length > 0) {
    out.heading('нарушения, найденные машиной');
    for (const violation of facts.dependencies.violations.slice(0, 10)) {
      // Файлы печатаются рядом с описанием: «взаимная зависимость трёх файлов» без имён не
      // отвечает на единственный вопрос человека — каких именно.
      out.item(`[${violation.severity}] ${violation.kind}: ${violation.detail}`);
      out.line(`      ${violation.files.slice(0, 4).join(', ')}`);
    }
  }

  out.heading('что относится к области');
  out.item(`домены: ${facts.relevance.domains.join(', ') || 'нет'}`);
  out.item(`правила: ${facts.relevance.policies.join(', ') || 'нет'}`);
  out.item(`решений в контексте: ${facts.relevance.adr.length}`);
  if (facts.relevance.surfaces.length > 0) {
    out.item(`под ограничением файлов: ${facts.relevance.surfaces.length}`);
  }

  // Дерево с чужой незавершённой работой — не повод останавливать анализ: он ничего не меняет.
  // Повод остановиться появится позже, перед первой правкой, и скажет об этом другая проверка.
  if (!facts.git.clean) {
    out.warn('дерево грязное: анализ допустим, автоматическая правка — нет');
  }

  const pass = choosePass(policies, args.pass);
  if (pass === null) {
    out.error(`прохода ${args.pass ?? ''} нет в политике обслуживания`);
    return { ok: false };
  }

  const outputFile = path.join(path.relative(config.root, workspace.results), 'review.json');
  const packet = reviewerPacket({
    facts,
    policies,
    budget: policies.maintenance.convergence,
    pass,
    outputFile,
    decisions: decisionsFor(config, facts),
  });
  writeFileSync(workspace.taskFile, renderPacket(packet), 'utf8');

  out.heading('задание ревьюеру');
  out.item(`проход: ${pass.id}`);
  out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
  out.item(`ответ положить в: ${outputFile}`);
  out.line();
  out.item('дальше: отдайте задание агенту, затем `pnpm maintain review`');
  return { ok: true };
}

/**
 * Область работы: изменённое от базы, изменённое в дереве или всё дерево.
 *
 * Умолчание — изменённое в рабочем дереве. Полное дерево остаётся редким режимом: гонять агента
 * по неизменённому коду дорого и бессмысленно, а главное — каждый такой прогон заново приносит
 * старые находки, по которым решение уже принималось.
 */
function resolveScope(config: MaintenanceConfig, args: AnalyzeArgs): string[] | null {
  if (args.all) return [];
  return changedSince(config.root, args.since ?? 'HEAD');
}

function choosePass(policies: PolicySet, wanted: string | null) {
  const passes = policies.maintenance.convergence.passes;
  if (wanted === null) return passes[0] ?? null;
  return passes.find((item) => item.id === wanted) ?? null;
}

export interface ReviewArgs {
  readonly file: string | null;
}

/**
 * Приём ответа ревьюера: разбор, проверка формы, отбор.
 *
 * Отбор сохраняется в отчёт целиком — со всеми отклонёнными и отложенными. Отчёт, в котором видно
 * только принятое, не отвечает на главный вопрос человека: «а почему вот это не взяли».
 */
export async function review(
  config: MaintenanceConfig,
  out: Reporter,
  args: ReviewArgs,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  const workspace = ensureWorkspace(config.runtimeDir);
  const file = args.file ?? path.join(workspace.results, 'review.json');
  if (!existsSync(file)) {
    out.error(`ответа ревьюера нет: ${path.relative(config.root, file)}`);
    return { ok: false };
  }

  const parsed = parseFindings(readFileSync(file, 'utf8'), path.relative(config.root, file));
  out.heading('разбор ответа');
  out.item(`находок принято: ${parsed.findings.length}`);
  for (const problem of parsed.problems) out.warn(problem);
  if (parsed.findings.length === 0) {
    out.error('ни одной разобранной находки — отбирать нечего');
    return { ok: false };
  }

  const selection = selectFindings({
    config,
    policies,
    budget: policies.maintenance.convergence,
    findings: parsed.findings,
  });
  printSelection(out, selection);
  saveSelection(workspace.reports, selection, parsed.problems);

  out.heading('итог');
  out.item(
    `к правке: ${selection.selected.length}, файлов: ${selection.files.length}, строк по оценке: ${selection.estimatedLines}`,
  );
  out.item(`отчёт: ${path.relative(config.root, path.join(workspace.reports, 'selection.json'))}`);
  if (selection.selected.length === 0) {
    out.item('правок нет — это штатный исход: цикл останавливается на «нет отобранных находок»');
    return { ok: true };
  }
  out.item('дальше: `pnpm maintain fix-task` соберёт задание исполнителю');
  return { ok: true };
}

function printSelection(out: Reporter, selection: Selection): void {
  const order = ['selected', 'manual', 'deferred', 'rejected'] as const;
  const titles: Record<(typeof order)[number], string> = {
    selected: 'в работу',
    manual: 'человеку',
    deferred: 'отложено',
    rejected: 'отклонено',
  };
  for (const decision of order) {
    const items = selection.verdicts.filter((verdict) => verdict.decision === decision);
    if (items.length === 0) continue;
    out.heading(`${titles[decision]} — ${items.length}`);
    for (const item of items) {
      out.item(
        `${item.finding.id} [${item.finding.severity}/${item.finding.confidence}] ${item.finding.title}`,
      );
      out.line(`      ${item.reason}`);
    }
  }
}

function saveSelection(
  reportsDir: string,
  selection: Selection,
  problems: readonly string[],
): void {
  const payload = {
    decidedAt: new Date().toISOString(),
    budget: 'architecture/policies/maintenance.yaml',
    problems,
    estimatedLines: selection.estimatedLines,
    files: selection.files,
    verdicts: selection.verdicts.map((verdict) => ({
      decision: verdict.decision,
      reason: verdict.reason,
      finding: verdict.finding,
    })),
  };
  writeFileSync(
    path.join(reportsDir, 'selection.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

/** Задание исполнителю собирается из сохранённого отбора, а не из свежего ответа модели. */
export async function fixTask(config: MaintenanceConfig, out: Reporter): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  const workspace = ensureWorkspace(config.runtimeDir);
  const file = path.join(workspace.reports, 'selection.json');
  if (!existsSync(file)) {
    out.error('отбора нет: сначала `pnpm maintain review`');
    return { ok: false };
  }
  const payload = JSON.parse(readFileSync(file, 'utf8')) as {
    verdicts?: { decision?: string; finding?: TrackedFinding }[];
  };
  const selected = (payload.verdicts ?? [])
    .filter((verdict) => verdict.decision === 'selected')
    .map((verdict) => verdict.finding)
    .filter((finding): finding is TrackedFinding => finding !== undefined);

  if (selected.length === 0) {
    out.error('в отборе нет ни одной находки к правке');
    return { ok: false };
  }

  // Открытая партия означает, что предыдущая правка не проверена. Выдать вторую поверх первой
  // значит потерять возможность откатить обе: контрольные точки перекроются.
  if (readBatch(workspace) !== null) {
    out.error('уже есть открытая партия: завершите её командой verify или снимите командой abort');
    return { ok: false };
  }

  /*
   * Контрольная точка снимается ДО выдачи задания и только с файлов партии.
   *
   * Дерево здесь общее: рядом лежит чужая незавершённая работа, и откат «всего дерева» унёс бы её
   * вместе с неудачной правкой. Поэтому сохраняются ровно те файлы, которые разрешено трогать.
   *
   * Вместе с точкой снимается базовая линия инструментов: без неё «стало хуже» не с чем сравнить,
   * а сравнивать с прошлым прогоном нельзя — дерево между ними меняли другие.
   */
  const allowed = [...new Set(selected.flatMap((finding) => finding.files))].sort();
  out.heading('контрольная точка');
  out.item('снимаю базовую линию: линт и типы');
  out.heading('замер базы до правки');
  const { lint, typecheck } = measureBaseline(config, workspace.tmp, (text) => out.item(text));
  out.item(`линт: ${lint.summary}`);
  out.item(`типы: ${typecheck.summary}`);

  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  const checkpoint = await transaction.createCheckpoint(allowed);
  try {
    saveBatch(workspace, {
      checkpoint,
      allowed,
      findings: selected.map((finding) => finding.id),
      baseline: snapshotBaseline(config, lint, typecheck),
      createdAt: new Date().toISOString(),
    });
  } catch (cause) {
    // Точка без записи о партии — сирота: её никто не примет и не откатит, а следующий прогон
    // увидит открытую партию, которой нет. Поэтому неудачная запись снимает и точку.
    await transaction.accept(checkpoint);
    throw cause;
  }
  out.item(`сохранено файлов: ${allowed.length}, точка ${checkpoint}`);

  const outputFile = path.join(path.relative(config.root, workspace.results), 'fix.json');
  const packet = fixerPacket({
    findings: selected,
    policies,
    budget: policies.maintenance.convergence,
    outputFile,
    verification: config.verification
      .filter((level) => level.enabledByDefault)
      .map((level) => level.command.join(' ')),
  });
  writeFileSync(workspace.taskFile, renderPacket(packet), 'utf8');

  out.heading('задание исполнителю');
  out.item(
    `находок: ${selected.length}, файлов: ${new Set(selected.flatMap((item) => item.files)).size}`,
  );
  out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
  out.item(`ответ положить в: ${outputFile}`);
  out.line();
  out.item('после правки: `pnpm maintain verify` проверит и примет или откатит партию');
  return { ok: true };
}
