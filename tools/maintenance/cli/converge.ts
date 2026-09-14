/**
 * Цикл сходимости: команда, которая ведёт прогон от прохода к проходу.
 *
 * ПОЧЕМУ ЭТО НЕ ОДИН ДОЛГИЙ ЗАПУСК. Между шагами стоит человек: он относит задание агенту в
 * редакторе и приносит ответ. Значит команда не «идёт до конца», а ПРОДВИГАЕТ прогон настолько,
 * насколько может без человека, и останавливается, назвав следующий шаг. Запусти её снова — она
 * продолжит с того же места, потому что состояние лежит в файле, а не в памяти процесса.
 *
 * Решение о продолжении принимает автомат (`core/convergence.ts`), а не эта команда и тем более
 * не модель: здесь только ввод-вывод и печать.
 */
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { RunState } from '../core/run-state.ts';
import type { PolicySet } from '../core/types.ts';
import {
  advance,
  beginPass,
  recordSelection,
  recordVerification,
  startRun,
} from '../core/convergence.ts';
import { parseFindings } from '../core/finding-io.ts';
import { selectFindings } from '../core/selector.ts';
import { collectFacts, saveFacts, widenScope } from '../analyzers/facts.ts';
import { changedSince } from '../analyzers/git.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import { renderRunReport, renderVerdictTable } from '../reporters/markdown.ts';
import { ensureWorkspace, type Workspace } from '../state/workspace.ts';
import { snapshotBaseline } from '../verification/behavior-lock.ts';
import { measureBaseline, verifyBatch } from '../verification/verifier.ts';
import { renderPacket } from '../work-packets/render.ts';
import { reviewerPacket } from '../work-packets/reviewer.ts';
import { fixerPacket } from '../work-packets/fixer.ts';
import type { CommandResult } from './commands.ts';
import { loadPolicies } from './commands.ts';
import { readBatch, saveBatch } from './verify.ts';
import { JsonFindingStore, decide, reconcile, type LedgerEntry } from '../state/ledger.ts';
import { filesChangedSince, lastChangeOf } from '../analyzers/git.ts';

export interface ConvergeArgs {
  readonly allowConcurrent: boolean;
  readonly levels: readonly string[];
  readonly abort: boolean;
  readonly status: boolean;
}

function runFile(workspace: Workspace): string {
  return path.join(workspace.state, 'run.json');
}

/**
 * Чтение состояния прогона с приведением к сегодняшней форме.
 *
 * СОСТОЯНИЕ НА ДИСКЕ БЫВАЕТ СТАРШЕ КОДА, и это не исключительный случай: прогон живёт днями,
 * между его шагами систему правят. Поле, появившееся после начала прогона, читается как
 * `undefined` — и падает не там, где его добавили, а в отчёте через неделю. Проверено на себе:
 * первая же репетиция после добавления списка находок прохода уронила команду снятия прогона.
 *
 * Поэтому читается не «как есть», а с умолчаниями. Состояние прогона — рабочее, а не исторический
 * документ: потерять у него поле не страшно, страшно не суметь его открыть.
 */
function readRun(workspace: Workspace): RunState | null {
  const file = runFile(workspace);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RunState;
  return {
    ...raw,
    passes: (raw.passes ?? []).map((record) => ({
      ...record,
      manualFindings: record.manualFindings ?? [],
      selectedFindings: record.selectedFindings ?? [],
      changedFiles: record.changedFiles ?? [],
    })),
  };
}

function saveRun(workspace: Workspace, state: RunState): void {
  writeFileSync(runFile(workspace), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function converge(
  config: MaintenanceConfig,
  out: Reporter,
  args: ConvergeArgs,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  const workspace = ensureWorkspace(config.runtimeDir);
  const budget = policies.maintenance.convergence;

  if (args.abort) return abortRun(workspace, config, out);

  let state = readRun(workspace);
  if (args.status) {
    if (state === null) {
      out.item('прогона нет');
      return { ok: true };
    }
    printState(out, state);
    return { ok: true };
  }

  if (state === null) {
    state = startRun(budget.passes);
    state = beginPass(state, budget.passes[0]?.id ?? 'structural');
    saveRun(workspace, state);
    out.heading(`прогон ${state.runId}`);
    out.item(`проходов в политике: ${budget.passes.length}, лимит: ${budget.maxPasses}`);
    return emitReviewTask(config, policies, workspace, out, state, budget.passes[0]?.id ?? '');
  }

  if (state.step === 'finished') {
    out.heading('прогон завершён');
    printState(out, state);
    out.item(`отчёт: ${writeReport(config, workspace, state)}`);
    out.item('новый прогон: maintain converge --abort, затем maintain converge');
    return { ok: true };
  }

  if (state.step === 'awaiting-review') return takeReview(config, policies, workspace, out, state);
  return takeFix(config, policies, workspace, out, state, args);
}

/** Шаг 1 прохода: собрать факты и выдать задание ревьюеру. */
async function emitReviewTask(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
  passId: string,
): Promise<CommandResult> {
  const pass = policies.maintenance.convergence.passes.find((item) => item.id === passId);
  if (pass === undefined) {
    out.error(`прохода ${passId} нет в политике`);
    return { ok: false };
  }

  out.heading(`проход ${state.passes.length}: ${pass.id}`);
  const scopeFiles = changedSince(config.root, 'HEAD');
  const collected = collectFacts({ config, policies, workspace, withTests: false, scopeFiles });
  const widened = widenScope(config, policies, collected, scopeFiles);
  const facts = widened.facts;
  out.item(widened.note);
  saveFacts(workspace, facts);
  out.item(`линт: ${facts.lint.summary}; зависимости: ${facts.dependencies.summary}`);

  // Ответ прошлого прохода убирается заранее: иначе следующая команда примет его за новый и
  // отберёт те же находки повторно.
  rmSync(path.join(workspace.results, 'review.json'), { force: true });
  rmSync(path.join(workspace.results, 'fix.json'), { force: true });

  const outputFile = path.join(path.relative(config.root, workspace.results), 'review.json');
  writeFileSync(
    workspace.taskFile,
    renderPacket(
      reviewerPacket({
        facts,
        policies,
        budget: policies.maintenance.convergence,
        pass,
        outputFile,
      }),
    ),
    'utf8',
  );
  out.item(`задание ревьюеру: ${path.relative(config.root, workspace.taskFile)}`);
  out.item(`ответ положить в ${outputFile}, затем повторить: pnpm maintain converge`);
  return { ok: true };
}

/** Шаг 2 прохода: принять ответ ревьюера, отобрать безопасное, выдать задание исполнителю. */
async function takeReview(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
): Promise<CommandResult> {
  const file = path.join(workspace.results, 'review.json');
  if (!existsSync(file)) {
    out.heading('ждём ответ ревьюера');
    out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
    out.item(`ответ: ${path.relative(config.root, file)}`);
    return { ok: true };
  }

  const parsed = parseFindings(readFileSync(file, 'utf8'), path.relative(config.root, file));
  for (const problem of parsed.problems) out.warn(problem);

  /*
   * Журнал спрашивают ДО отбора, а не после.
   *
   * Смысл журнала в том, чтобы решение человека («это осознанный долг», «это ложное срабатывание»)
   * не спрашивалось каждый прогон заново. Пропусти этот шаг — и отбор честно отработает по
   * находкам, про которые всё давно решено, а человек получит тот же список третий раз подряд.
   */
  const store = new JsonFindingStore(path.join(workspace.state, 'ledger.json'));
  const known = await store.load();
  const sifted = reconcile({
    entries: known,
    findings: parsed.findings,
    policy: policies.maintenance.ledger,
    now: new Date(),
    codeChanged: codeChangedSince(config.root),
    policyChanged: policyChangedSince(config.root),
  });
  if (sifted.suppressed.length > 0) {
    out.item(`журнал снял ${sifted.suppressed.length}: про них решение уже принято`);
    for (const item of sifted.suppressed.slice(0, 5)) {
      out.line(`      ${item.finding.id} — ${item.why}`);
    }
  }
  if (sifted.reopened.length > 0) out.item(`переоткрыто: ${sifted.reopened.length}`);

  const selection = selectFindings({
    config,
    policies,
    budget: policies.maintenance.convergence,
    findings: sifted.fresh,
  });
  out.heading('отбор');
  out.line(renderVerdictTable(selection.verdicts));

  /*
   * Решение отбора записывается в журнал сразу: всё, что не взято в работу, получает статус
   * «отложено». Иначе следующий прогон принесёт те же находки как новые — и экономии не будет
   * ровно там, где она нужнее всего, в отклонённом и отложенном.
   */
  let entries = sifted.entries;
  const now = new Date();
  for (const verdict of selection.verdicts) {
    if (verdict.decision === 'selected') continue;
    entries = decide(entries, verdict.finding.fingerprint, 'deferred', {
      note: `${verdict.decision}: ${verdict.reason}`,
      now,
    });
  }
  await store.save(entries);

  let next = recordSelection(state, selection);

  if (selection.selected.length === 0) {
    // Нечего чинить — проход закрывается без партии. Это штатный и лучший исход: система нашла,
    // что автоматически трогать нечего, и сказала об этом, а не придумала работу.
    next = recordVerification(next, {
      outcome: 'accept',
      reason: 'правок не потребовалось',
      changedFiles: [],
      changedLines: 0,
      newSevere: 0,
      resolvedSevere: 0,
    });
    return closePass(config, policies, workspace, out, next);
  }

  const allowed = [...new Set(selection.selected.flatMap((finding) => finding.files))].sort();
  const { lint, typecheck } = measureBaseline(config, workspace.tmp);

  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  const checkpoint = await transaction.createCheckpoint(allowed);
  saveBatch(workspace, {
    checkpoint,
    allowed,
    findings: selection.selected.map((finding) => finding.id),
    baseline: snapshotBaseline(config, lint, typecheck),
    createdAt: new Date().toISOString(),
  });

  const outputFile = path.join(path.relative(config.root, workspace.results), 'fix.json');
  writeFileSync(
    workspace.taskFile,
    renderPacket(
      fixerPacket({
        findings: selection.selected,
        policies,
        budget: policies.maintenance.convergence,
        outputFile,
        verification: config.verification
          .filter((level) => level.enabledByDefault)
          .map((level) => level.command.join(' ')),
      }),
    ),
    'utf8',
  );
  saveRun(workspace, next);

  out.heading('задание исполнителю');
  out.item(`находок: ${selection.selected.length}, файлов: ${allowed.length}, точка ${checkpoint}`);
  out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
  out.item(`отчёт положить в ${outputFile}, затем повторить: pnpm maintain converge`);
  return { ok: true };
}

/**
 * Менялся ли код находки после решения по ней.
 *
 * Список изменённого считается ОДИН раз на дату и запоминается: журнал спрашивает про каждую
 * запись, а история git на сотне записей опрашивалась бы сотню раз.
 */
function codeChangedSince(root: string): (entry: LedgerEntry) => boolean {
  const cache = new Map<string, Set<string>>();
  return (entry) => {
    const since = entry.decidedAt ?? entry.firstSeen;
    let touched = cache.get(since);
    if (touched === undefined) {
      touched = new Set(filesChangedSince(root, since));
      cache.set(since, touched);
    }
    return entry.files.some((file) => touched.has(file));
  };
}

/** Менялось ли правило, на которое ссылается находка: по истории файла политик. */
function policyChangedSince(root: string): (entry: LedgerEntry) => boolean {
  const changedAt = lastChangeOf(root, 'architecture/policies/architecture.yaml');
  return (entry) => {
    if (entry.policy === undefined || changedAt === null) return false;
    return changedAt > (entry.decidedAt ?? entry.firstSeen);
  };
}

/** Шаг 3 прохода: проверить правку, принять или откатить, закрыть проход. */
async function takeFix(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
  args: ConvergeArgs,
): Promise<CommandResult> {
  const batch = readBatch(workspace);
  if (batch === null) {
    out.error('партии нет, а прогон ждёт правку: снимите прогон командой converge --abort');
    return { ok: false };
  }
  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  const changed = transaction.changedIn(batch.checkpoint);
  if (changed.length === 0) {
    out.heading('ждём правку исполнителя');
    out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
    out.item(`разрешено файлов: ${batch.allowed.length}, изменено: 0`);
    return { ok: true };
  }

  const report = readFixReport(workspace);
  const result = verifyBatch({
    config,
    policies,
    baseline: batch.baseline,
    allowed: batch.allowed,
    claimed: report.claimed,
    allowConcurrent: args.allowConcurrent,
    tmpDir: workspace.tmp,
    extraLevels: args.levels,
  });

  out.heading('проверка');
  out.item(`линт: ${result.lintAfter.summary}; типы: ${result.typecheckAfter.summary}`);
  for (const level of result.levels) out.item(`${level.title}: ${level.note}`);
  for (const violation of result.violations) out.warn(`${violation.kind}: ${violation.detail}`);

  if (result.outcome === 'accept') await transaction.accept(batch.checkpoint);
  else if (result.outcome === 'rollback') {
    const rolled = await transaction.rollback(batch.checkpoint);
    out.item(
      `откачено файлов: ${rolled.restored.length}, удалено созданных: ${rolled.removed.length}`,
    );
  }
  if (result.outcome !== 'manual-review') {
    rmSync(path.join(workspace.state, 'batch.json'), { force: true });
  }

  const next = recordVerification(state, {
    outcome: result.outcome,
    reason: result.reason,
    changedFiles: changed,
    changedLines: report.lines,
    newSevere: report.newSevere,
    resolvedSevere: report.resolvedSevere,
  });
  out.item(`решение: ${decisionWord(result.outcome)} — ${result.reason}`);
  return closePass(config, policies, workspace, out, next);
}

/** Закрыть проход: спросить автомат, идти ли дальше, и либо открыть следующий, либо завершить. */
async function closePass(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
): Promise<CommandResult> {
  const budget = policies.maintenance.convergence;
  let next = advance(state, budget, policies.maintenance.stopConditions);

  if (next.step === 'finished') {
    saveRun(workspace, next);
    out.heading('прогон завершён');
    printState(out, next);
    out.item(`отчёт: ${writeReport(config, workspace, next)}`);
    return { ok: next.stop?.reason !== 'manualDecisionRequired' };
  }

  const passId = budget.passes[next.passIndex]?.id ?? '';
  next = beginPass(next, passId);
  saveRun(workspace, next);
  return emitReviewTask(config, policies, workspace, out, next, passId);
}

function abortRun(workspace: Workspace, config: MaintenanceConfig, out: Reporter): CommandResult {
  const state = readRun(workspace);
  if (state === null) {
    out.item('прогона нет');
    return { ok: true };
  }
  // Отчёт пишется даже у снятого прогона: сделанное в нём — уже история, и терять её из-за того,
  // что человек решил начать заново, незачем.
  out.item(`снят прогон ${state.runId}; отчёт: ${writeReport(config, workspace, state)}`);
  rmSync(runFile(workspace), { force: true });
  return { ok: true };
}

/**
 * Что показать человеку: не только отданное ему отбором.
 *
 * Провалившийся проход не повторяется (решение заказчика 14.09.2026), и его находки иначе
 * исчезли бы молча: отбор их взял, правка не прошла, повтора не будет. Поэтому в список решений
 * идут и они — вместе с теми, что отбор сразу отдал человеку.
 */
function itemsForHuman(state: RunState) {
  const out = state.passes.flatMap((record) => [
    ...record.manualFindings,
    ...(record.verification === 'accept' ? [] : record.selectedFindings),
  ]);
  const seen = new Set<string>();
  return out.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
}

function writeReport(config: MaintenanceConfig, workspace: Workspace, state: RunState): string {
  // Раздел решений печатает сам отчёт — вторым вызовом он выходил бы дважды и с разным
  // содержимым. Вызывающий передаёт лишь СПИСОК, потому что правило «откаченный проход не
  // повторяется» знает он, а не отчёт.
  const text = `${renderRunReport(state, { decisionItems: itemsForHuman(state) })}\n`;
  const file = path.join(workspace.reports, `${state.runId}.md`);
  writeFileSync(file, text, 'utf8');
  return path.relative(config.root, file);
}

function printState(out: Reporter, state: RunState): void {
  out.item(`прогон ${state.runId}, проходов сделано: ${state.passes.length}, ход: ${state.step}`);
  out.item(
    `итоги: файлов ${state.totals.files}, строк ${state.totals.lines}, принято партий ${state.totals.accepted}, откатов ${state.totals.rollbacks}`,
  );
  if (state.stop !== null) out.item(`остановка: ${state.stop.reason} — ${state.stop.detail}`);
}

function decisionWord(outcome: string): string {
  if (outcome === 'accept') return 'ПРИНЯТО';
  if (outcome === 'rollback') return 'ОТКАЧЕНО';
  return 'НУЖЕН ЧЕЛОВЕК';
}

interface FixReport {
  readonly claimed: string[];
  readonly lines: number;
  readonly newSevere: number;
  readonly resolvedSevere: number;
}

/**
 * Отчёт исполнителя.
 *
 * Он необязателен: ручной адаптер его может не оставить. Отсутствие отчёта не выдумывается за
 * исполнителя — все счётчики остаются нулевыми, и условие «создал больше, чем починил» тогда
 * просто не срабатывает. Считать по молчанию значило бы обвинять или оправдывать без данных.
 */
function readFixReport(workspace: Workspace): FixReport {
  const file = path.join(workspace.results, 'fix.json');
  const empty: FixReport = { claimed: [], lines: 0, newSevere: 0, resolvedSevere: 0 };
  if (!existsSync(file)) return empty;
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as {
      applied?: { files?: unknown; severity?: unknown }[];
      newFindings?: { severity?: unknown }[];
    };
    const claimed = new Set<string>();
    for (const item of payload.applied ?? []) {
      if (!Array.isArray(item.files)) continue;
      for (const name of item.files) if (typeof name === 'string') claimed.add(name);
    }
    const severe = (items: readonly { severity?: unknown }[] | undefined) =>
      (items ?? []).filter((item) => item.severity === 'high').length;
    return {
      claimed: [...claimed],
      lines: 0,
      newSevere: severe(payload.newFindings),
      resolvedSevere: (payload.applied ?? []).length,
    };
  } catch {
    return empty;
  }
}

/** Отдельная команда отчёта: печатает состояние прогона, ничего не меняя. */
export async function report(config: MaintenanceConfig, out: Reporter): Promise<CommandResult> {
  const workspace = ensureWorkspace(config.runtimeDir);
  const state = readRun(workspace);
  if (state === null) {
    out.error('прогона нет: начните его командой maintain converge');
    return { ok: false };
  }
  out.line(renderRunReport(state, { decisionItems: itemsForHuman(state) }));
  out.item(`сохранено: ${writeReport(config, workspace, state)}`);
  return { ok: true };
}
