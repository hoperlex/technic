/**
 * Детерминированный отбор: что из найденного берётся в работу.
 *
 * ГЛАВНОЕ РЕШЕНИЕ ВСЕЙ СИСТЕМЫ ПРИНИМАЕТСЯ ЗДЕСЬ, И ПРИНИМАЕТ ЕГО КОД. Агент находит проблемы и
 * оценивает их; сколько чинить, в скольких файлах и на сколько строк — вопрос политики, а не
 * модели. Отдай это решение агенту, и цикл перестанет останавливаться: у модели всегда найдётся
 * ещё одно улучшение.
 *
 * ОТБОР ПОВТОРЯЕМ. Одни и те же находки при одном и том же бюджете дают один и тот же выбор:
 * порядок задан явно, а не порядком прихода. Иначе два прогона на неизменённом коде давали бы
 * разные правки, и сравнивать их было бы нечем.
 */
import type { MaintenanceConfig } from './config.ts';
import type { TrackedFinding } from './finding.ts';
import { resolveSurface } from '../policies/surfaces.ts';
import type { BehaviorRisk } from './finding.ts';
import type { ConvergenceBudget, PolicySet } from './types.ts';

export type Decision =
  /** Берётся в работу исполнителем. */
  | 'selected'
  /** Отложено бюджетом или порогом: вернётся в следующем круге без потери. */
  | 'deferred'
  /** Требует человека: защищённая область, риск поведения, запрет автоправки. */
  | 'manual'
  /** Отклонено по существу: правило совещательное, находка вне области работы. */
  | 'rejected';

export interface Verdict {
  readonly finding: TrackedFinding;
  readonly decision: Decision;
  readonly reason: string;
}

export interface Selection {
  readonly verdicts: readonly Verdict[];
  readonly selected: readonly TrackedFinding[];
  readonly files: readonly string[];
  readonly estimatedLines: number;
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;
const RISK_RANK: Record<BehaviorRisk, number> = { low: 1, medium: 2, high: 3 };
/** Оценка объёма для находки, где агент её не дал. Намеренно щедрая: бюджет должен ошибаться в запас. */
const UNKNOWN_LINES = 40;

export interface SelectOptions {
  readonly config: MaintenanceConfig;
  readonly policies: PolicySet;
  readonly budget: ConvergenceBudget;
  readonly findings: readonly TrackedFinding[];
}

export function selectFindings(options: SelectOptions): Selection {
  const { budget } = options;
  const ordered = [...options.findings].sort(compareFindings);

  const verdicts: Verdict[] = [];
  const selected: TrackedFinding[] = [];
  const files = new Set<string>();
  let lines = 0;

  for (const finding of ordered) {
    const blocked = blockingReason(finding, options);
    if (blocked !== null) {
      verdicts.push({ finding, decision: blocked.decision, reason: blocked.reason });
      continue;
    }

    if (selected.length >= budget.maxFindingsPerPass) {
      verdicts.push({
        finding,
        decision: 'deferred',
        reason: `в проход берётся не больше ${budget.maxFindingsPerPass} находок`,
      });
      continue;
    }

    const nextFiles = new Set(files);
    for (const file of finding.files) nextFiles.add(file);
    if (nextFiles.size > budget.maxFilesChanged) {
      verdicts.push({
        finding,
        decision: 'deferred',
        reason: `лимит файлов в партии — ${budget.maxFilesChanged}`,
      });
      continue;
    }

    const cost = finding.estimatedLines ?? UNKNOWN_LINES;
    if (lines + cost > budget.maxChangedLines) {
      verdicts.push({
        finding,
        decision: 'deferred',
        reason: `лимит изменённых строк — ${budget.maxChangedLines}`,
      });
      continue;
    }

    selected.push(finding);
    lines += cost;
    for (const file of nextFiles) files.add(file);
    verdicts.push({ finding, decision: 'selected', reason: 'в пределах бюджета и допуска' });
  }

  return { verdicts, selected, files: [...files].sort(), estimatedLines: lines };
}

/** Причина, по которой находка не может быть взята в автоматическую работу вовсе. */
function blockingReason(
  finding: TrackedFinding,
  options: SelectOptions,
): { decision: Decision; reason: string } | null {
  const { config, policies, budget } = options;

  // Защищённая область проверяется первой: она отвечает не «стоит ли», а «можно ли вообще», и
  // ответ «нельзя» не должен зависеть от уверенности модели или от остатка бюджета.
  for (const file of finding.files) {
    const verdict = resolveSurface(config.root, policies.surfaces, policies.surfaceDefault, file);
    if (verdict.mode === 'forbidden') {
      return {
        decision: 'manual',
        reason: `${file} — защищённая область ${verdict.surface?.id ?? ''}: автоматическая правка запрещена`,
      };
    }
    if (verdict.mode === 'manual-review') {
      return {
        decision: 'manual',
        reason: `${file} — область ${verdict.surface?.id ?? ''} правится только человеком`,
      };
    }
  }

  if (finding.policy !== undefined) {
    const policy = policies.policies.find((item) => item.id === finding.policy);
    if (policy === undefined) {
      // Ссылка на несуществующее правило — признак, что модель его выдумала. Такую находку нельзя
      // ни чинить автоматически, ни молча принимать: её смотрит человек.
      return { decision: 'manual', reason: `правила ${finding.policy} нет в политике` };
    }
    if (policy.severity === 'advisory') {
      return {
        decision: 'rejected',
        reason: `правило ${policy.id} совещательное: поводом к правке не является`,
      };
    }
    if (!policy.autofix) {
      return { decision: 'manual', reason: `правило ${policy.id} запрещает автоматическую правку` };
    }
  }

  if (RISK_RANK[finding.behaviorRisk] > RISK_RANK[budget.allowedRisk]) {
    return {
      decision: 'manual',
      reason: `риск для поведения ${finding.behaviorRisk} выше допустимого ${budget.allowedRisk}`,
    };
  }

  if (finding.confidence < budget.minAutofixConfidence) {
    return {
      decision: 'deferred',
      reason: `уверенность ${finding.confidence} ниже порога ${budget.minAutofixConfidence}`,
    };
  }

  return null;
}

/**
 * Порядок находок: строгость, затем уверенность, затем дешевизна, затем идентификатор.
 *
 * Последний ключ нужен не для смысла, а для повторяемости: без него две одинаково оценённые
 * находки меняются местами от запуска к запуску.
 */
function compareFindings(a: TrackedFinding, b: TrackedFinding): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  const byConfidence = b.confidence - a.confidence;
  if (byConfidence !== 0) return byConfidence;
  const byCost = (a.estimatedLines ?? UNKNOWN_LINES) - (b.estimatedLines ?? UNKNOWN_LINES);
  if (byCost !== 0) return byCost;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
