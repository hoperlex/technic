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
import type { ProjectFacts } from '../core/facts.ts';
import type { TrackedFinding } from '../core/finding.ts';
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
import { collectFacts, decisionsFor, saveFacts, widenScope } from '../analyzers/facts.ts';
import { changedSince, collectGit } from '../analyzers/git.ts';
import { run } from '../analyzers/run.ts';
import { decideStart } from '../core/start-gate.ts';
import { anchorNamed, readReleaseAnchor } from '../project/release-anchor.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import { renderRunReport, renderVerdictTable } from '../reporters/markdown.ts';
import { ensureWorkspace, type Workspace } from '../state/workspace.ts';
import { snapshotBaseline } from '../verification/behavior-lock.ts';
import { measureBaseline, verifyBatch } from '../verification/verifier.ts';
import { reviewerPacket } from '../work-packets/reviewer.ts';
import { fixerPacket } from '../work-packets/fixer.ts';
import type { CommandResult } from './commands.ts';
import { loadPolicies } from './commands.ts';
import { readBatch, saveBatch } from './verify.ts';
import { adapterFor, deliver } from './agent-runner.ts';
import { JsonFindingStore, decide, reconcile, type LedgerEntry } from '../state/ledger.ts';
import { JsonSnapshotStore, diffSnapshots, renderDelta, snapshotOf } from '../state/snapshot.ts';
import {
  EMPTY_FIX_REPORT,
  countSevere,
  parseFixReport,
  type FixReport,
} from '../core/fix-report.ts';
import { filesChangedSince, lastChangeOf } from '../analyzers/git.ts';

export interface ConvergeArgs {
  /** Каким адаптером относить задание: ручным или командным. `null` — как сказано в конфиге. */
  readonly agent: 'manual' | 'command' | null;
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
    if (!checkStart(config, policies, out).allowed) return { ok: false };
    state = startRun(budget.passes);
    state = beginPass(state, budget.passes[0]?.id ?? 'structural');
    saveRun(workspace, state);
    out.heading(`прогон ${state.runId}`);
    out.item(`проходов в политике: ${budget.passes.length}, лимит: ${budget.maxPasses}`);
    return emitReviewTask(
      config,
      policies,
      workspace,
      out,
      state,
      budget.passes[0]?.id ?? '',
      args,
    );
  }

  if (state.step === 'finished') {
    out.heading('прогон завершён');
    printState(out, state);
    out.item(`отчёт: ${writeReport(config, workspace, state)}`);
    out.item('новый прогон: maintain converge --abort, затем maintain converge');
    return { ok: true };
  }

  if (state.step === 'awaiting-review')
    return takeReview(config, policies, workspace, out, state, args);
  return takeFix(config, policies, workspace, out, state, args);
}

/**
 * Можно ли начинать прогон.
 *
 * Спрашивается ОДИН раз — при открытии прогона, а не на каждом шаге: условие относится к точке
 * старта, а не к каждому движению. Красная вершина запрещает начинать всегда, потому что тогда
 * краснеет каждая партия не по своей вине; грязь рядом только предупреждает — партия проверяется
 * в отдельном дереве и откатывается пофайлово, так что чужая работа ей не мешает.
 *
 * Ворота до старта гоняются только при `requireGreen`: это шесть минут, и платить их за каждый
 * прогон без спроса нельзя.
 */
function checkStart(
  config: MaintenanceConfig,
  policies: PolicySet,
  out: Reporter,
): { allowed: boolean } {
  const policy = policies.maintenance.start;
  const git = collectGit(config.root);
  const anchor = readReleaseAnchor(config.root);

  let gatesGreen: boolean | null = null;
  if (policy.requireGreen) {
    out.item('политика требует зелёной вершины: гоняю ворота до первой правки');
    const levels = config.verification.filter((level) => level.enabledByDefault);
    gatesGreen = levels.every((level) => run(config.root, level.command).code === 0);
  }

  const decision = decideStart(
    {
      treeClean: git.clean,
      gatesGreen,
      anchorNamed: anchorNamed(anchor),
      foreignWorkInTree: git.changedFiles.length,
    },
    policy,
  );

  out.heading('стартовая точка');
  out.item(
    `выпуск: ${anchor.version ?? 'не прочитан'}${anchor.tagOnHead ? ', тег на вершине' : ''}`,
  );
  for (const problem of anchor.problems) out.line(`      ${problem}`);
  for (const reason of decision.reasons) {
    if (decision.verdict === 'blocked') out.error(reason);
    else out.item(reason);
  }
  if (decision.verdict === 'blocked') {
    out.item(
      'смягчить это нельзя флагом: правила старта ведёт architecture/policies/maintenance.yaml',
    );
    return { allowed: false };
  }
  return { allowed: true };
}

/** Шаг 1 прохода: собрать факты и выдать задание ревьюеру. */
async function emitReviewTask(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
  passId: string,
  args: ConvergeArgs,
): Promise<CommandResult> {
  const pass = policies.maintenance.convergence.passes.find((item) => item.id === passId);
  if (pass === undefined) {
    out.error(`прохода ${passId} нет в политике`);
    return { ok: false };
  }

  out.heading(`проход ${state.passes.length}: ${pass.id}`);
  const scopeFiles = changedSince(config.root, 'HEAD');
  if (scopeFiles === null) {
    out.error('git не смог показать изменения рабочего дерева: прогон остановлен');
    return { ok: false };
  }
  const collected = collectFacts({ config, policies, workspace, withTests: false, scopeFiles });
  const widened = widenScope(config, policies, collected, scopeFiles);
  const facts = widened.facts;
  out.item(widened.note);
  saveFacts(workspace, facts);
  out.item(`линт: ${facts.lint.summary}; зависимости: ${facts.dependencies.summary}`);
  if (state.passes.length <= 1) await rememberStructure(config, workspace, facts, out);

  // Ответ прошлого прохода убирается заранее: иначе следующая команда примет его за новый и
  // отберёт те же находки повторно.
  rmSync(path.join(workspace.results, 'review.json'), { force: true });
  rmSync(path.join(workspace.results, 'fix.json'), { force: true });

  const outputFile = path.join(path.relative(config.root, workspace.results), 'review.json');
  const packet = reviewerPacket({
    facts,
    policies,
    budget: policies.maintenance.convergence,
    pass,
    outputFile,
    decisions: decisionsFor(config, facts),
  });

  /*
   * Задание уходит через адаптер, а не записью в файл напрямую.
   *
   * Раньше цикл писал `task.md` сам и слоя адаптеров не знал вовсе — из-за этого самоходный режим
   * работал только в тяжёлом окне, а повседневный прогон всегда ждал человека с копипастой. Теперь
   * оба режима идут одной дорогой: ручной адаптер делает ровно то же, что делал цикл, а командный
   * зовёт агента сам.
   */
  const reply = deliver(
    adapterFor(config, 'reviewer', args.agent, out),
    packet,
    config,
    workspace,
    out,
  );
  if (reply.kind !== 'answer') return { ok: reply.kind === 'awaiting' };

  // Ответ уже на руках — идём дальше в том же запуске, не заставляя звать команду второй раз.
  return takeReview(config, policies, workspace, out, state, args);
}

/**
 * Запомнить структуру дерева и показать, что изменилось с прошлого раза.
 *
 * Снимок снимается РАЗ НА ПРОГОН, на первом проходе, а не на каждом: он описывает состояние
 * дерева на стабильной точке, а три снимка внутри одного прогона мерили бы работу самой системы,
 * а не проекта.
 *
 * Без этой памяти нельзя ответить на единственный вопрос эксплуатации, ради которого всё и
 * затевалось: за пять прогонов стало лучше или хуже. Факты перезаписываются каждым прогоном, и
 * сравнивать было бы не с чем.
 */
async function rememberStructure(
  config: MaintenanceConfig,
  workspace: Workspace,
  facts: ProjectFacts,
  out: Reporter,
): Promise<void> {
  const store = new JsonSnapshotStore(path.join(workspace.state, 'snapshots.json'));
  const history = await store.load();
  const previous = history[history.length - 1];
  const taken = snapshotOf(facts, { version: readReleaseAnchor(config.root).version });
  await store.append(taken);

  if (previous === undefined) {
    out.item('снимок структуры сохранён: сравнивать пока не с чем, это первый');
    return;
  }
  const delta = diffSnapshots(previous, taken);
  if (delta.changes.length === 0) {
    out.item('структура не изменилась с прошлого прогона');
    return;
  }
  out.heading('что изменилось с прошлого прогона');
  out.line(renderDelta(delta));
}

/** Шаг 2 прохода: принять ответ ревьюера, отобрать безопасное, выдать задание исполнителю. */
async function takeReview(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
  args: ConvergeArgs,
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
   * Ответ, который не разобрался, — это НЕ «находок нет».
   *
   * Разница решающая: «находок нет» закрывает проход успехом и останавливает прогон причиной
   * «чинить больше нечего», то есть система объявляет лучшим исходом собственную неспособность
   * получить ответ. Пустой ответ без единой жалобы разбора — другое дело: агент честно сказал, что
   * не нашёл ничего, и это штатный исход.
   */
  if (parsed.findings.length === 0 && parsed.problems.length > 0) {
    out.error('ответ ревьюера не разобран: прогон ждёт исправленный ответ, а не идёт дальше');
    out.item(`файл: ${path.relative(config.root, file)}`);
    out.item(
      'исправьте ответ в этом файле или удалите его и повторите команду: тогда задание уйдёт ' +
        'агенту заново',
    );
    return { ok: false };
  }

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
    /*
     * В журнал уходит только то, по чему решение ПРИНЯТО. «Отложено» и «отклонено» — решения
     * системы, их можно и нужно помнить. А `manual` означает ровно обратное: система сказала
     * «решать не вправе». Запиши её отложенной — и вопрос, заданный человеку, замолчит на
     * квартал, если человек не успел его открыть. Такие находки остаются новыми и приходят снова,
     * пока человек не ответит командой `maintain ledger`.
     */
    if (verdict.decision === 'selected' || verdict.decision === 'manual') continue;
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
    return closePass(config, policies, workspace, out, next, args);
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
  const packet = fixerPacket({
    findings: selection.selected,
    policies,
    budget: policies.maintenance.convergence,
    outputFile,
    verification: config.verification
      .filter((level) => level.enabledByDefault)
      .map((level) => level.command.join(' ')),
  });
  saveRun(workspace, next);

  out.heading('задание исполнителю');
  out.item(`находок: ${selection.selected.length}, файлов: ${allowed.length}, точка ${checkpoint}`);

  const reply = deliver(
    adapterFor(config, 'fixer', args.agent, out),
    packet,
    config,
    workspace,
    out,
  );
  if (reply.kind !== 'answer') return { ok: reply.kind === 'awaiting' };
  return takeFix(config, policies, workspace, out, next, args);
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
  const lines = changed.length === 0 ? 0 : transaction.changedLinesIn(batch.checkpoint);
  if (changed.length === 0) {
    out.heading('ждём правку исполнителя');
    out.item(`задание: ${path.relative(config.root, workspace.taskFile)}`);
    out.item(`разрешено файлов: ${batch.allowed.length}, изменено: 0`);
    return { ok: true };
  }

  const selected = state.passes.at(-1)?.selectedFindings ?? [];
  const { report, newSevere, resolvedSevere } = fixReportOf(workspace, selected, out);
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
    // Строки считаются по контрольной точке, а не со слов исполнителя: точка хранит содержимое
    // «до», и разница по ней — единственное число, которое не зависит от честности отчёта.
    changedLines: lines,
    newSevere,
    resolvedSevere,
  });
  out.item(`решение: ${decisionWord(result.outcome)} — ${result.reason}`);
  return closePass(config, policies, workspace, out, next, args);
}

/** Закрыть проход: спросить автомат, идти ли дальше, и либо открыть следующий, либо завершить. */
async function closePass(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: RunState,
  args: ConvergeArgs,
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
  return emitReviewTask(config, policies, workspace, out, next, passId, args);
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

/**
 * Отчёт исполнителя со стороны цикла: разбор общий, а вот СМЫСЛ счётчиков — здесь.
 *
 * `resolvedSevere` считается по строгости находок ПАРТИИ, а не по длине списка `applied`. Раньше
 * тремя мелкими правками исполнитель набирал «закрыто три» и заглушал условие «создаёт больше
 * серьёзного, чем чинит» — единственное, которое ловит работу цикла во вред.
 */
function fixReportOf(
  workspace: Workspace,
  batchFindings: readonly TrackedFinding[],
  out: Reporter,
): { report: FixReport; newSevere: number; resolvedSevere: number } {
  const file = path.join(workspace.results, 'fix.json');
  if (!existsSync(file)) {
    return { report: EMPTY_FIX_REPORT, newSevere: 0, resolvedSevere: 0 };
  }
  const report = parseFixReport(readFileSync(file, 'utf8'));
  for (const problem of report.problems) out.warn(problem);
  const applied = new Set(report.applied);
  return {
    report,
    newSevere: countSevere(report.newSeverities),
    resolvedSevere: batchFindings.filter(
      (finding) => applied.has(finding.id) && finding.severity === 'high',
    ).length,
  };
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
