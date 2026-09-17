/**
 * Тяжёлое окно: длительный прогон по зонам с бюджетом времени и малыми партиями.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПОВСЕДНЕВНОГО ЦИКЛА. `converge` чинит то, что нашлось вокруг изменённых
 * файлов, и укладывается в минуты. Окно — другое: человек отдаёт системе два часа и говорит
 * «разбери накопленное». Накопленного всегда больше, чем влезет, поэтому здесь появляются две
 * вещи, которых нет в цикле: РАНЖИРОВАННАЯ ОЧЕРЕДЬ (что взять первым) и БЮДЖЕТ ВРЕМЕНИ (когда
 * остановиться, даже если работа осталась).
 *
 * Очередь живёт в файле, а не в памяти: между партиями система ждёт агента, и прогон переживает
 * выход из процесса — ровно как в цикле сходимости.
 */
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { PolicySet, ConvergenceBudget } from '../core/types.ts';
import type { TrackedFinding } from '../core/finding.ts';
import type { WindowState } from '../core/deep-window.ts';
import {
  advanceWindow,
  beginBatch,
  minutesLeft,
  recordBatchOutcome,
  startWindow,
} from '../core/deep-window.ts';
import { rankDebt, type DebtItem } from '../core/debt-queue.ts';
import { parseFindings } from '../core/finding-io.ts';
import { EMPTY_FIX_REPORT, parseFixReport } from '../core/fix-report.ts';
import { selectFindings } from '../core/selector.ts';
import { collectFacts, decisionsFor, saveFacts, widenScope } from '../analyzers/facts.ts';
import { changedSince, collectGit, fileHotness } from '../analyzers/git.ts';
import { decideStart } from '../core/start-gate.ts';
import { anchorNamed, readReleaseAnchor } from '../project/release-anchor.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import { ensureWorkspace, type Workspace } from '../state/workspace.ts';
import { JsonFindingStore, reconcile } from '../state/ledger.ts';
import { snapshotBaseline } from '../verification/behavior-lock.ts';
import { measureBaseline, verifyBatch } from '../verification/verifier.ts';
import { reviewerPacket } from '../work-packets/reviewer.ts';
import { fixerPacket } from '../work-packets/fixer.ts';
import { adapterFor, deliver } from './agent-runner.ts';
import type { CommandResult } from './commands.ts';
import { loadPolicies } from './commands.ts';
import { readBatch, saveBatch } from './verify.ts';

export interface DeepArgs {
  /** Провести окно, даже если рубильник в политике выключен. */
  readonly force: boolean;
  readonly allowConcurrent: boolean;
  readonly status: boolean;
  readonly abort: boolean;
  /** Каким адаптером относить задание: ручным или командным. */
  readonly agent: 'manual' | 'command' | null;
}

const WINDOW_FILE = 'window.json';
const QUEUE_FILE = 'deep-queue.json';

interface QueuedItem {
  readonly zone: string;
  readonly score: number;
  readonly finding: TrackedFinding;
}

function windowFile(workspace: Workspace): string {
  return path.join(workspace.state, WINDOW_FILE);
}

function queueFile(workspace: Workspace): string {
  return path.join(workspace.state, QUEUE_FILE);
}

function readWindow(workspace: Workspace): WindowState | null {
  const file = windowFile(workspace);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
  // Состояние на диске бывает старше кода: окно живёт часами, между партиями систему правят.
  return {
    ...raw,
    batches: (raw.batches ?? []).map((batch) => ({
      ...batch,
      changedFiles: batch.changedFiles ?? [],
    })),
  };
}

function readQueue(workspace: Workspace): QueuedItem[] {
  const file = queueFile(workspace);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as QueuedItem[];
}

function saveState(workspace: Workspace, state: WindowState, queue: readonly QueuedItem[]): void {
  writeFileSync(windowFile(workspace), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  writeFileSync(queueFile(workspace), `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

/**
 * Бюджет партии окна.
 *
 * Пороги допуска (уверенность, допустимый риск) берутся из повседневного бюджета БЕЗ изменений:
 * окно длиннее, но не смелее. Меняются только объёмы — сколько находок, файлов и строк за раз, — и
 * они в окне меньше, а не больше: малая партия откатывается дешевле, а откатывать в окне придётся
 * чаще, чем в цикле.
 */
function batchBudget(policies: PolicySet): ConvergenceBudget {
  const deep = policies.maintenance.deepMaintenance;
  const daily = policies.maintenance.convergence;
  return {
    ...daily,
    maxFindingsPerPass: deep.maxFindingsPerBatch,
    maxFilesChanged: deep.maxFilesPerBatch,
    maxChangedLines: deep.maxChangedLinesPerBatch,
  };
}

export async function deep(
  config: MaintenanceConfig,
  out: Reporter,
  args: DeepArgs,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  const workspace = ensureWorkspace(config.runtimeDir);
  const policy = policies.maintenance.deepMaintenance;

  if (args.abort) {
    rmSync(windowFile(workspace), { force: true });
    rmSync(queueFile(workspace), { force: true });
    out.item('окно снято; контрольная точка партии, если она была, остаётся за командой abort');
    return { ok: true };
  }

  let state = readWindow(workspace);
  if (args.status) {
    if (state === null) {
      out.item('окна нет');
      return { ok: true };
    }
    printWindow(out, state);
    return { ok: true };
  }

  if (state === null) {
    if (!policy.enabled && !args.force) {
      out.error('тяжёлое окно выключено в политике: architecture/policies/maintenance.yaml');
      out.item('провести его разово можно флагом --force');
      return { ok: false };
    }
    if (!checkWindowStart(config, policies, out)) return { ok: false };
    state = startWindow(policy, new Date());
    saveState(workspace, state, []);
    out.heading(`окно ${state.windowId}`);
    out.item(`бюджет: ${policy.windowMinutes} мин, партий не больше ${policy.maxRepairBatches}`);
    out.item(`зоны: ${policy.zones.map((zone) => zone.id).join(' → ')}`);
    return emitZoneReview(config, policies, workspace, out, state, args);
  }

  if (state.step === 'finished') {
    out.heading('окно закрыто');
    printWindow(out, state);
    return { ok: true };
  }

  if (state.step === 'awaiting-review') {
    return takeZoneReview(config, policies, workspace, out, state, args);
  }
  return takeBatchFix(config, policies, workspace, out, state, args);
}

/**
 * Стартовая точка окна: те же правила, что у цикла, и по той же причине.
 *
 * Окно длиннее и правит больше, поэтому красная вершина здесь дороже вдвойне: шесть неудачных
 * партий подряд съедят весь бюджет времени и не дадут ни одной принятой.
 */
function checkWindowStart(config: MaintenanceConfig, policies: PolicySet, out: Reporter): boolean {
  const git = collectGit(config.root);
  const anchor = readReleaseAnchor(config.root);
  const decision = decideStart(
    {
      treeClean: git.clean,
      gatesGreen: null,
      anchorNamed: anchorNamed(anchor),
      foreignWorkInTree: git.changedFiles.length,
    },
    policies.maintenance.start,
  );
  out.heading('стартовая точка');
  out.item(`выпуск: ${anchor.version ?? 'не прочитан'}`);
  for (const reason of decision.reasons) {
    if (decision.verdict === 'blocked') out.error(reason);
    else out.item(reason);
  }
  return decision.verdict !== 'blocked';
}

/** Выдать задание ревьюеру по текущей зоне: окно смотрит зону целиком, а не только изменённое. */
/**
 * Звали ли агента в ЭТОМ запуске команды. Память процесса, а не окна: вопрос «переспрашивать или
 * ждать» живёт ровно одну команду, а окно переживает запуски и хранится на диске — записанный
 * туда, флаг запретил бы переспрос и тогда, когда переспросить как раз надо.
 */
const asked = { reviewer: false };

async function emitZoneReview(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: WindowState,
  args: DeepArgs,
): Promise<CommandResult> {
  const again = asked.reviewer;
  const policy = policies.maintenance.deepMaintenance;
  const zone = policy.zones[state.zoneIndex];
  if (zone === undefined) {
    out.error('зоны кончились, а окно этого не заметило');
    return { ok: false };
  }

  out.heading(`зона ${state.zoneIndex + 1}: ${zone.id}${again ? ' (задание повторно)' : ''}`);
  out.item(`осталось минут: ${Math.round(minutesLeft(state, new Date()))}`);

  /*
   * Полный обзор, а не только изменённое: окно затем и созывается, чтобы разобрать накопленное.
   * Изменённые файлы всё равно берутся затравкой — область вокруг них плотнее и понятнее агенту.
   */
  const scopeFiles = policy.fullScan === 'allowed' ? [] : changedSince(config.root, 'HEAD');
  if (scopeFiles === null) {
    out.error('git не смог показать изменения рабочего дерева: окно остановлено');
    return { ok: false };
  }
  const collected = collectFacts({ config, policies, workspace, withTests: false, scopeFiles });
  const widened = widenScope(config, policies, collected, scopeFiles);
  saveFacts(workspace, widened.facts);
  out.item(widened.note);

  const pass = {
    id: zone.id,
    goal: `Зона «${zone.id}». Ищите: ${zone.looksFor.join(', ')}. Менять допустимо: ${zone.mayChange.join(', ')}.`,
    forbids: zone.mustNotChange,
  };
  const outputFile = path.join(path.relative(config.root, workspace.results), 'review.json');
  rmSync(path.join(workspace.results, 'review.json'), { force: true });

  const packet = reviewerPacket({
    facts: widened.facts,
    policies,
    budget: batchBudget(policies),
    pass,
    outputFile,
    decisions: decisionsFor(config, widened.facts),
  });
  const adapter = adapterFor(config, 'reviewer', args.agent, out);
  asked.reviewer = true;
  const reply = deliver(adapter, packet, config, workspace, out);
  if (reply.kind !== 'answer') {
    return { ok: reply.kind === 'awaiting' };
  }
  // Командный адаптер уже принёс ответ — идём дальше в том же запуске, не заставляя человека
  // звать команду второй раз ради шага, который ничего не ждёт.
  return takeZoneReview(config, policies, workspace, out, state, args);
}

/** Принять ответ ревьюера, построить очередь долга и взять из неё первую партию. */
async function takeZoneReview(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: WindowState,
  args: DeepArgs,
): Promise<CommandResult> {
  const answer = path.join(workspace.results, 'review.json');
  if (!existsSync(answer)) {
    // Ждать осмысленно только в ручном режиме: там задание относит человек. В командном ответа
    // ждать не от кого — окно переспрашивает агента само, иначе шаг стоял бы вечно.
    if ((args.agent ?? config.agent?.mode ?? 'manual') === 'command' && !asked.reviewer) {
      out.heading('ответа ревьюера нет — зовём агента заново');
      return emitZoneReview(config, policies, workspace, out, state, args);
    }
    out.heading('ждём ответ ревьюера');
    out.item(`ответ положить в ${path.relative(config.root, answer)}, затем: pnpm maintain deep`);
    return { ok: true };
  }

  const parsed = parseFindings(readFileSync(answer, 'utf8'), path.relative(config.root, answer));
  for (const problem of parsed.problems) out.warn(problem);
  if (parsed.findings.length === 0 && parsed.problems.length > 0) {
    // Неразобранный ответ — не «в зоне чисто»: окно закрылось бы причиной «очередь пуста», то есть
    // отчиталось бы о разобранном долге там, где не получило ни одного ответа.
    out.error('ответ ревьюера не разобран: окно ждёт исправленный ответ');
    out.item(`файл: ${path.relative(config.root, answer)}`);
    out.item(
      'исправьте ответ в этом файле или удалите его и повторите команду: тогда задание уйдёт ' +
        'агенту заново',
    );
    return { ok: false };
  }

  const store = new JsonFindingStore(path.join(workspace.state, 'ledger.json'));
  const known = await store.load();
  const sifted = reconcile({
    entries: known,
    findings: parsed.findings,
    policy: policies.maintenance.ledger,
    now: new Date(),
    // В окне журнал спрашивают мягче: код с прошлого решения мог не меняться, но окно и созвано
    // затем, чтобы вернуться к отложенному. Переоткрытие по сроку делает `reconcile` сам.
    codeChanged: () => false,
    policyChanged: () => false,
  });
  await store.save(sifted.entries);
  if (sifted.suppressed.length > 0) {
    out.item(`журнал снял ${sifted.suppressed.length}: решение по ним уже принято`);
  }

  const policy = policies.maintenance.deepMaintenance;
  const ranked = rankDebt({
    findings: sifted.fresh,
    zones: policy.zones,
    signals: {
      hotness: fileHotness(config.root, 90),
      ageDays: ageFromLedger(sifted.entries),
    },
  });
  const zone = policy.zones[state.zoneIndex]?.id ?? '';
  const mine = ranked.filter((item) => item.zone === zone);
  const queue: QueuedItem[] = mine.map((item) => ({
    zone: item.zone,
    score: item.score,
    finding: item.finding,
  }));

  out.heading('очередь долга');
  out.item(`в зоне ${zone}: ${queue.length} из ${ranked.length} находок`);
  for (const item of mine.slice(0, 5)) {
    out.line(`      ${item.score.toFixed(2)} — ${item.finding.title}`);
  }

  saveState(workspace, state, queue);
  return takeNextBatch(config, policies, workspace, out, state, queue, args);
}

/** Взять из очереди следующую партию и выдать её исполнителю. */
async function takeNextBatch(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: WindowState,
  queue: readonly QueuedItem[],
  args: DeepArgs,
): Promise<CommandResult> {
  const policy = policies.maintenance.deepMaintenance;
  const advanced = advanceWindow(state, policy, new Date(), queue.length);
  if (advanced.step === 'finished') {
    saveState(workspace, advanced, queue);
    out.heading('окно закрыто');
    printWindow(out, advanced);
    return { ok: true };
  }

  // Зона сменилась — очередь прежней зоны больше не нужна, и новый обзор пойдёт по новой зоне.
  if (advanced.zoneIndex !== state.zoneIndex) {
    saveState(workspace, advanced, []);
    return emitZoneReview(config, policies, workspace, out, advanced, args);
  }

  const budget = batchBudget(policies);
  const selection = selectFindings({
    config,
    policies,
    budget,
    findings: queue.map((item) => item.finding),
  });
  const rest = queue.filter(
    (item) =>
      !selection.selected.some((finding) => finding.fingerprint === item.finding.fingerprint),
  );

  if (selection.selected.length === 0) {
    /*
     * В зоне брать нечего. Записывать это ремонтной партией нельзя, хотя соблазн есть: пустая
     * запись съела бы одну из шести партий окна и подменила бы исход — вместо «долг разобран»
     * человек прочитал бы «зоны пройдены». Поэтому просто идём дальше с пустой очередью, а
     * решение о переходе или закрытии принимает автомат.
     */
    out.item('из очереди зоны отбор не взял ничего: остальное — человеку');
    saveState(workspace, advanced, []);
    return takeNextBatch(config, policies, workspace, out, advanced, [], args);
  }

  const allowed = [...new Set(selection.selected.flatMap((finding) => finding.files))].sort();
  out.heading('замер базы до правки');
  const { lint, typecheck } = measureBaseline(config, workspace.tmp, (text) => out.item(text));
  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  const checkpoint = await transaction.createCheckpoint(allowed);
  saveBatch(workspace, {
    checkpoint,
    allowed,
    findings: selection.selected.map((finding) => finding.id),
    baseline: snapshotBaseline(config, lint, typecheck),
    createdAt: new Date().toISOString(),
  });

  const zoneId = policy.zones[advanced.zoneIndex]?.id ?? '';
  const started = beginBatch(
    advanced,
    zoneId,
    selection.selected.map((finding) => finding.fingerprint),
    new Date(),
  );
  saveState(workspace, started, rest);

  out.heading(`партия ${started.batches.length} зоны ${zoneId}`);
  out.item(`находок ${selection.selected.length}, файлов ${allowed.length}, точка ${checkpoint}`);

  const outputFile = path.join(path.relative(config.root, workspace.results), 'fix.json');
  rmSync(path.join(workspace.results, 'fix.json'), { force: true });
  const packet = fixerPacket({
    findings: selection.selected,
    policies,
    budget,
    outputFile,
    verification: config.verification
      .filter((level) => level.enabledByDefault)
      .map((level) => level.command.join(' ')),
  });
  const reply = deliver(
    adapterFor(config, 'fixer', args.agent, out),
    packet,
    config,
    workspace,
    out,
  );
  if (reply.kind !== 'answer') return { ok: reply.kind === 'awaiting' };
  return takeBatchFix(config, policies, workspace, out, started, args);
}

/** Проверить партию, записать исход и решить, идти ли дальше. */
async function takeBatchFix(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
  state: WindowState,
  args: DeepArgs,
): Promise<CommandResult> {
  const batch = readBatch(workspace);
  if (batch === null) {
    out.error('партии нет, а окно ждёт правку: снимите окно командой deep --abort');
    return { ok: false };
  }
  const transaction = new FileCheckpointTransaction(config.root, workspace.checkpoints);
  const changed = transaction.changedIn(batch.checkpoint);
  const lines = changed.length === 0 ? 0 : transaction.changedLinesIn(batch.checkpoint);
  if (changed.length === 0) {
    out.heading('ждём правку исполнителя');
    out.item(`разрешено файлов: ${batch.allowed.length}, изменено: 0`);
    return { ok: true };
  }

  /*
   * Список «что назвал исполнитель» читается из его отчёта, а НЕ подставляется списком изменённых
   * файлов. Подмена выключала замок поведения целиком: `changedIn` по построению возвращает только
   * файлы партии, значит «названное» всегда лежало внутри разрешённого, и выход агента за границы
   * партии становился неотличим от чужой работы рядом — а с `--allow-concurrent` ещё и молча
   * принимался. В окне, где агенту отдают два часа и много партий подряд, это была самая дорогая
   * дыра из возможных.
   */
  const reportFile = path.join(workspace.results, 'fix.json');
  const report = existsSync(reportFile)
    ? parseFixReport(readFileSync(reportFile, 'utf8'))
    : EMPTY_FIX_REPORT;
  for (const problem of report.problems) out.warn(problem);

  out.heading('проверка партии');
  const result = verifyBatch({
    notify: (text) => out.item(text),
    config,
    policies,
    baseline: batch.baseline,
    allowed: batch.allowed,
    claimed: report.claimed,
    allowConcurrent: args.allowConcurrent,
    tmpDir: workspace.tmp,
    extraLevels: [],
  });
  out.item(`проверка: ${result.outcome} — ${result.reason}`);
  for (const level of result.levels) {
    if (level.output === undefined) continue;
    for (const line of level.output.split('\n').slice(-8)) out.line(`      ${line}`);
  }
  /*
   * Отчёт проверки сохраняется всегда, и это не дубль печати. Окно идёт часами и партиями: к
   * моменту, когда человек вернётся, вывод в терминале уже уехал вверх, а вопрос «почему эту
   * партию не приняли» останется. Файл переживает и прокрутку, и закрытую вкладку.
   */
  writeFileSync(
    path.join(workspace.reports, `${state.windowId}-batch-${state.batches.length}.json`),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), batch, changed, result }, null, 2)}\n`,
    'utf8',
  );

  if (result.outcome === 'accept') await transaction.accept(batch.checkpoint);
  else if (result.outcome === 'rollback') await transaction.rollback(batch.checkpoint);
  if (result.outcome !== 'manual-review') {
    rmSync(path.join(workspace.state, 'batch.json'), { force: true });
  }

  const closed = recordBatchOutcome(
    state,
    {
      outcome: result.outcome,
      reason: result.reason,
      changedFiles: changed,
      // Строки — по контрольной точке: бюджет окна на партию в 400 строк до этого не считался
      // вовсе и сработать не мог.
      changedLines: lines,
    },
    new Date(),
  );
  const queue = readQueue(workspace);
  saveState(workspace, closed, queue);

  if (result.outcome === 'manual-review') {
    out.item('партия оставлена человеку: окно приостановлено до его решения');
    return { ok: false };
  }
  return takeNextBatch(config, policies, workspace, out, closed, queue, args);
}

/** Возраст находок в днях: берётся из журнала, потому что только он помнит первую встречу. */
function ageFromLedger(
  entries: readonly { fingerprint: string; firstSeen: string }[],
): Map<string, number> {
  const now = Date.now();
  const ages = new Map<string, number>();
  for (const entry of entries) {
    const seen = Date.parse(entry.firstSeen);
    if (Number.isFinite(seen)) ages.set(entry.fingerprint, (now - seen) / 86_400_000);
  }
  return ages;
}

function printWindow(out: Reporter, state: WindowState): void {
  out.item(`окно ${state.windowId}, партий ${state.batches.length}, ход ${state.step}`);
  out.item(
    `итоги: файлов ${state.totals.files}, строк ${state.totals.lines}, принято ${state.totals.accepted}, откатов ${state.totals.rollbacks}`,
  );
  if (state.stop !== null) out.item(`остановка: ${state.stop.reason} — ${state.stop.detail}`);
}

export type { DebtItem };
