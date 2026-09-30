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
import type { DeepMaintenanceBudget, PolicySet, ConvergenceBudget } from '../core/types.ts';
import type { TrackedFinding } from '../core/finding.ts';
import type {
  WindowFindingRecord,
  WindowFindingStatus,
  WindowReviewRecord,
  WindowState,
} from '../core/deep-window.ts';
import {
  advanceWindow,
  beginBatch,
  minutesLeft,
  recordBatchOutcome,
  startWindow,
} from '../core/deep-window.ts';
import { rankDebtDetailed, zoneForNextDebtBatch, type DebtItem } from '../core/debt-queue.ts';
import { parseFindings } from '../core/finding-io.ts';
import { EMPTY_FIX_REPORT, parseFixReport } from '../core/fix-report.ts';
import { selectFindings, type Verdict } from '../core/selector.ts';
import { collectFacts, decisionsFor, saveFacts, widenScope } from '../analyzers/facts.ts';
import { changedSince, collectGit, fileHotness } from '../analyzers/git.ts';
import { renderWindowReport } from '../reporters/markdown.ts';
import { decideStart } from '../core/start-gate.ts';
import { askChoice } from './ask.ts';
import { anchorNamed, readReleaseAnchor } from '../project/release-anchor.ts';
import { FileCheckpointTransaction } from '../git/transaction.ts';
import { ensureWorkspace, type Workspace } from '../state/workspace.ts';
import { JsonFindingStore, reconcile } from '../state/ledger.ts';
import { snapshotBaseline } from '../verification/behavior-lock.ts';
import { measureBaseline, measureGateBaseline, verifyBatch } from '../verification/verifier.ts';
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
  /** Собрать подробный отчёт окна: что делали партии, что осталось в долге. */
  readonly report: boolean;
  readonly abort: boolean;
  /** Каким адаптером относить задание: ручным или командным. */
  readonly agent: 'manual' | 'command' | null;
  /** Разовый выбор CLI; `null` — настройка `agent.provider`. */
  readonly provider: 'claude' | 'codex' | null;
  /** Разовый id модели; `null` — настройка `agent.model` или умолчание выбранного CLI. */
  readonly model: string | null;
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
    baseGates: raw.baseGates ?? [],
    reviews: raw.reviews ?? [],
    findings: raw.findings ?? [],
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

function findingRecord(
  finding: TrackedFinding,
  sourceZone: string,
  status: WindowFindingStatus,
  reason: string,
  targetZone: string | null = null,
  score: number | null = null,
): WindowFindingRecord {
  return {
    fingerprint: finding.fingerprint,
    title: finding.title,
    category: finding.category,
    files: finding.files,
    sourceZones: [sourceZone],
    targetZone,
    score,
    status,
    reason,
  };
}

/** Update a finding while retaining every zone that independently reported it. */
function withFindings(state: WindowState, records: readonly WindowFindingRecord[]): WindowState {
  const merged = new Map(state.findings.map((record) => [record.fingerprint, record]));
  for (const record of records) {
    const previous = merged.get(record.fingerprint);
    const sources =
      previous === undefined
        ? record.sourceZones
        : [...new Set([...previous.sourceZones, ...record.sourceZones])];
    // A later reviewer may rediscover accepted debt; rediscovery must not reopen completed work.
    const retainAccepted = previous?.status === 'accepted' && record.status === 'queued';
    merged.set(
      record.fingerprint,
      previous === undefined
        ? record
        : retainAccepted
          ? { ...previous, sourceZones: sources }
          : {
              ...record,
              sourceZones: sources,
            },
    );
  }
  return { ...state, findings: [...merged.values()] };
}

function withReview(
  state: WindowState,
  review: WindowReviewRecord,
  records: readonly WindowFindingRecord[],
): WindowState {
  return {
    ...withFindings(state, records),
    reviews: [...state.reviews, review],
  };
}

function withVerdicts(state: WindowState, verdicts: readonly Verdict[]): WindowState {
  const known = new Map(state.findings.map((record) => [record.fingerprint, record]));
  return withFindings(
    state,
    verdicts.map((verdict) => {
      const previous = known.get(verdict.finding.fingerprint);
      return findingRecord(
        verdict.finding,
        previous?.sourceZones.at(-1) ?? 'unknown',
        verdict.decision,
        verdict.reason,
        previous?.targetZone ?? null,
        previous?.score ?? null,
      );
    }),
  );
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
  if (args.status || args.report) {
    if (state === null) {
      out.item('окна нет');
      return { ok: true };
    }
    printWindow(out, state);
    // Цифры отвечают на «где оно сейчас», а подробности — на «куда ушли три часа»; второй вопрос
    // задают чаще, и ответ на него в цифрах не помещается.
    if (args.report)
      out.item(`подробный отчёт: ${await writeWindowReport(config, workspace, state)}`);
    else out.item('подробнее: pnpm maintain deep --report');
    return { ok: true };
  }

  if (state === null) {
    if (!policy.enabled && !args.force) {
      out.error('тяжёлое окно выключено в политике: architecture/policies/maintenance.yaml');
      out.item('провести его разово можно флагом --force');
      return { ok: false };
    }
    const start = checkWindowStart(config, policies, workspace, out);
    if (!start.allowed) return { ok: false };
    state = startWindow(policy, new Date(), start.baseGates);
    saveState(workspace, state, []);
    out.heading(`окно ${state.windowId}`);
    out.item(`бюджет: ${policy.zoneMinutes} мин, партий не больше ${policy.maxRepairBatches}`);
    out.item(`зоны: ${policy.zones.map((zone) => zone.id).join(' → ')}`);
    out.item(
      `ход пишется в ${path.relative(config.root, path.join(config.runtimeDir, 'logs', 'maintain.log'))} — за ним можно следить: tail -f`,
    );
    return emitZoneReview(config, policies, workspace, out, state, args);
  }

  if (state.step === 'finished') {
    out.heading('окно закрыто');
    printWindow(out, state);
    out.item(`отчёт: ${await writeWindowReport(config, workspace, state)}`);
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
 * A deep window always pays for one full baseline before any edit. The same facts are then reused
 * by every batch, so a pre-existing failure cannot be blamed on a repair and the baseline cannot
 * drift during the window.
 */
function checkWindowStart(
  config: MaintenanceConfig,
  policies: PolicySet,
  workspace: Workspace,
  out: Reporter,
) {
  const git = collectGit(config.root);
  const anchor = readReleaseAnchor(config.root);
  out.heading('базовая линия ворот');
  const baseGates = measureGateBaseline(config, workspace.tmp, [], (text) => out.item(text));
  const gatesGreen = baseGates.every((level) => level.ok);
  const decision = decideStart(
    {
      treeClean: git.clean,
      gatesGreen,
      anchorNamed: anchorNamed(anchor),
      foreignWorkInTree: git.changedFiles.length,
    },
    policies.maintenance.start,
  );
  out.heading('стартовая точка');
  out.item(`выпуск: ${anchor.version ?? 'не прочитан'}`);
  for (const gate of baseGates) {
    out.item(`${gate.id}: ${gate.ok ? 'зелено' : `красно, следов ${gate.marks.length}`}`);
  }
  for (const reason of decision.reasons) {
    if (decision.verdict === 'blocked') out.error(reason);
    else out.item(reason);
  }
  return { allowed: decision.verdict !== 'blocked', baseGates };
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
    goal: `Зона «${zone.id}». Ищите: ${zone.looksFor.map((kind) => kind.id).join(', ')}. Менять допустимо: ${zone.mayChange.join(', ')}.`,
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
  const adapter = adapterFor(config, 'reviewer', args.agent, out, {
    provider: args.provider,
    model: args.model,
  });
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

  const zone = policies.maintenance.deepMaintenance.zones[state.zoneIndex]?.id ?? '';
  const rawAnswer = readFileSync(answer, 'utf8');
  const artifact = path.join(
    workspace.reports,
    `${state.windowId}-${zone}-review-${Date.now()}.json`,
  );
  writeFileSync(artifact, rawAnswer, 'utf8');

  const parsed = parseFindings(rawAnswer, path.relative(config.root, answer));
  for (const problem of parsed.problems) out.warn(problem);
  if (parsed.findings.length === 0 && parsed.problems.length > 0) {
    // An invalid answer is not an empty zone: keep the raw artifact and wait for a valid reply.
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
    // A deep window revisits debt by schedule; the ledger itself decides when a decision expires.
    codeChanged: () => false,
    policyChanged: () => false,
  });
  await store.save(sifted.entries);
  if (sifted.suppressed.length > 0) {
    out.item(`журнал снял ${sifted.suppressed.length}: решение по ним уже принято`);
  }

  const policy = policies.maintenance.deepMaintenance;
  const routed = rankDebtDetailed({
    findings: sifted.fresh,
    zones: policy.zones,
    signals: {
      hotness: fileHotness(config.root, 90),
      ageDays: ageFromLedger(sifted.entries),
    },
  });

  const records: WindowFindingRecord[] = [
    ...sifted.suppressed.map(({ finding, why }) => findingRecord(finding, zone, 'suppressed', why)),
    ...routed.unclassified.map((finding) =>
      findingRecord(
        finding,
        zone,
        'unclassified',
        `вид «${finding.category}» не назначен ни одной зоне; автоматическая правка запрещена`,
      ),
    ),
  ];

  const existing = readQueue(workspace);
  const queue = new Map(existing.map((item) => [item.finding.fingerprint, item]));
  const accepted = new Set(
    state.findings
      .filter((finding) => finding.status === 'accepted')
      .map((finding) => finding.fingerprint),
  );
  for (const item of routed.ranked) {
    const targetIndex = policy.zones.findIndex((candidate) => candidate.id === item.zone);
    const late = targetIndex < state.zoneIndex;
    records.push(
      findingRecord(
        item.finding,
        zone,
        'queued',
        item.zone === zone
          ? `поставлена в очередь зоны ${zone}`
          : late
            ? `целевая зона ${item.zone} уже просмотрена; находка будет разобрана после последнего обзора`
            : `перенесена из зоны ${zone} в очередь зоны ${item.zone}`,
        item.zone,
        item.score,
      ),
    );
    if (!accepted.has(item.finding.fingerprint)) {
      queue.set(item.finding.fingerprint, {
        zone: item.zone,
        score: item.score,
        finding: item.finding,
      });
    }
  }

  const nextState = withReview(
    state,
    {
      zone,
      observed: parsed.findings.length,
      fresh: sifted.fresh.length,
      suppressed: sifted.suppressed.length,
      classified: routed.ranked.length,
      unclassified: routed.unclassified.length,
      artifact: path.relative(config.root, artifact),
    },
    records,
  );
  const orderedQueue = [...queue.values()].sort((a, b) => b.score - a.score);
  const mine = orderedQueue.filter((item) => item.zone === zone);

  out.heading('очередь долга');
  out.item(
    `после обзора ${zone}: в текущей зоне ${mine.length}, всего в межзонной очереди ${orderedQueue.length}, без зоны ${routed.unclassified.length}`,
  );
  for (const item of mine.slice(0, 5)) {
    out.line(`      ${item.score.toFixed(2)} — ${item.finding.title}`);
  }

  saveState(workspace, nextState, orderedQueue);
  return takeNextBatch(config, policies, workspace, out, nextState, orderedQueue, args);
}

/** Взять из очереди следующую партию и выдать её исполнителю. */
/**
 * Время зоны вышло: спросить человека, а не закрывать окно молча.
 *
 * ПОЧЕМУ ВОПРОС, А НЕ ЧИСЛО В ПОЛИТИКЕ. Сколько времени стоит потратить — известно только сейчас и
 * только человеку: он видит, что зона разобрана наполовину, и знает, занят ли он ближайший час.
 * Число в политике этого знать не может, каким бы оно ни было.
 *
 * ПОЧЕМУ ЛЕСТНИЦА. Отказ продолжать редко значит «хватит совсем» — чаще «столько не дам». Вопрос
 * с двумя ответами превращал бы «дам ещё полчаса» в «закрывай».
 *
 * Терминала нет (окно запустили из хука или скрипта) — спрашивать некого, и окно закрывается, как
 * закрывалось раньше. Молчаливое ожидание ответа было бы худшим исходом: команда висела бы вечно.
 */
function askForMoreTime(
  policy: DeepMaintenanceBudget,
  state: WindowState,
  out: Reporter,
): WindowState | null {
  const zone = policy.zones[state.zoneIndex]?.id ?? 'зона';
  const full = Math.round(policy.zoneMinutes);
  const minutes = askChoice(
    `\n  Время зоны «${zone}» вышло (${full} мин). Продолжить?`,
    [
      { key: 'y', title: `ещё ${full} мин`, value: full },
      { key: '1', title: '120 мин', value: 120 },
      { key: '2', title: '90 мин', value: 90 },
      { key: '3', title: '60 мин', value: 60 },
      { key: 'n', title: 'закрыть окно', value: 0 },
    ].filter((choice) => choice.value === 0 || choice.value <= full || choice.key === 'y'),
  );
  if (minutes === null || minutes <= 0) return null;

  out.item(`добавлено минут: ${minutes}`);
  return {
    ...state,
    step: state.step === 'finished' ? 'awaiting-review' : state.step,
    stop: null,
    deadline: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
}

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
  const zoneId =
    zoneForNextDebtBatch(state.zoneIndex, policy.zones, queue) ??
    policy.zones[state.zoneIndex]?.id ??
    '';
  const currentQueue = queue.filter((item) => item.zone === zoneId);
  let advanced = advanceWindow(state, policy, new Date(), currentQueue.length);
  if (advanced.stop?.reason === 'timeBudgetSpent') {
    const extended = askForMoreTime(policy, advanced, out);
    if (extended !== null) {
      // The extension belongs to the current zone; future-zone debt remains untouched.
      advanced = advanceWindow(extended, policy, new Date(), currentQueue.length);
    }
  }
  if (advanced.step === 'finished') {
    saveState(workspace, advanced, queue);
    out.heading('окно закрыто');
    printWindow(out, advanced);
    out.item(`отчёт: ${await writeWindowReport(config, workspace, advanced)}`);
    return { ok: true };
  }

  // A zone change must retain findings already routed to another zone.
  if (advanced.zoneIndex !== state.zoneIndex) {
    saveState(workspace, advanced, queue);
    return emitZoneReview(config, policies, workspace, out, advanced, args);
  }

  const budget = batchBudget(policies);
  const selection = selectFindings({
    config,
    policies,
    budget,
    findings: currentQueue.map((item) => item.finding),
  });
  const verdicts = new Map(
    selection.verdicts.map((verdict) => [verdict.finding.fingerprint, verdict]),
  );
  const rest = queue.filter(
    (item) => item.zone !== zoneId || verdicts.get(item.finding.fingerprint)?.retryable === true,
  );
  const selectedState = withVerdicts(advanced, selection.verdicts);
  writeFileSync(
    path.join(
      workspace.reports,
      `${state.windowId}-${zoneId}-selection-${state.batches.length + 1}.json`,
    ),
    `${JSON.stringify(selection, null, 2)}\n`,
    'utf8',
  );

  if (selection.selected.length === 0) {
    // A fresh empty batch cannot change any verdict, so remove this zone from the active queue.
    const futureQueue = queue.filter((item) => item.zone !== zoneId);
    out.item(
      `из очереди зоны отбор не взял ничего; ${selection.verdicts.length} решений сохранено для отчёта`,
    );
    saveState(workspace, selectedState, futureQueue);
    return takeNextBatch(config, policies, workspace, out, selectedState, futureQueue, args);
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

  const started = beginBatch(
    selectedState,
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
    adapterFor(config, 'fixer', args.agent, out, {
      provider: args.provider,
      model: args.model,
    }),
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
    baseGates: state.baseGates,
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

  const verifiedState =
    result.baseGates === undefined ? state : { ...state, baseGates: result.baseGates };
  const closed = recordBatchOutcome(
    verifiedState,
    {
      outcome: result.outcome,
      reason: result.reason,
      changedFiles: changed,
      // Count from the checkpoint so the per-batch line budget reflects the actual edit.
      changedLines: lines,
    },
    new Date(),
  );
  const completed = new Set(closed.batches.at(-1)?.findings ?? []);
  const status: WindowFindingStatus =
    result.outcome === 'accept'
      ? 'accepted'
      : result.outcome === 'rollback'
        ? 'rolled-back'
        : 'manual';
  const finalized = withFindings(
    closed,
    closed.findings
      .filter((finding) => completed.has(finding.fingerprint))
      .map((finding) => ({
        ...finding,
        status,
        reason: result.reason,
      })),
  );
  const queue = readQueue(workspace);
  saveState(workspace, finalized, queue);

  if (result.outcome === 'manual-review') {
    out.item('партия оставлена человеку: окно приостановлено до его решения');
    return { ok: false };
  }
  return takeNextBatch(config, policies, workspace, out, finalized, queue, args);
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

/**
 * Собрать и положить отчёт окна.
 *
 * Заголовки находок берутся из журнала: партия помнит только отпечатки, и без журнала отчёт
 * говорил бы «находка a1b2c3d4» — то есть ничего. Журнала может не быть (первое окно), и тогда
 * отчёт честно покажет отпечатки, а не промолчит.
 */
async function writeWindowReport(
  config: MaintenanceConfig,
  workspace: Workspace,
  state: WindowState,
): Promise<string> {
  const store = new JsonFindingStore(path.join(workspace.state, 'ledger.json'));
  const titles = new Map<string, string>();
  try {
    for (const entry of await store.load()) titles.set(entry.fingerprint, entry.title);
  } catch {
    /* журнала нет — отчёт покажет отпечатки */
  }
  const queue = readQueue(workspace).map((item) => ({
    title: item.finding.title,
    score: item.score,
  }));
  const text = `${renderWindowReport(state, { titles, queue })}\n`;
  const file = path.join(workspace.reports, `${state.windowId}.md`);
  writeFileSync(file, text, 'utf8');
  return path.relative(config.root, file);
}

function printWindow(out: Reporter, state: WindowState): void {
  out.item(`окно ${state.windowId}, партий ${state.batches.length}, ход ${state.step}`);
  out.item(
    `итоги: файлов ${state.totals.files}, строк ${state.totals.lines}, принято ${state.totals.accepted}, откатов ${state.totals.rollbacks}`,
  );
  if (state.stop !== null) out.item(`остановка: ${state.stop.reason} — ${state.stop.detail}`);
}

export type { DebtItem };
