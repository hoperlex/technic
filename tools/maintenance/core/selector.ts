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
import { matchesAny, normalizePath } from './paths.ts';
import type { BehaviorRisk } from './finding.ts';
import type { ArchitectureException, ConvergenceBudget, PolicySet } from './types.ts';

export type Decision =
  /** Берётся в работу исполнителем. */
  | 'selected'
  /** Отложено бюджетом или порогом: вернётся в следующем круге без потери. */
  | 'deferred'
  /**
   * Требует человека: защищённая область, риск поведения, запрет автоправки, просроченное
   * исключение.
   */
  | 'manual'
  /**
   * Отклонено по существу: правило совещательное, находка вне области работы, нарушение
   * узаконено исключением из реестра.
   */
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
  /**
   * День, на который проверяется срок исключений. Приходит параметром по той же причине, что и в
   * автомате цикла: иначе про просроченное исключение нечего утверждать тесту, а прогон вчерашнего
   * дня нельзя повторить сегодня.
   */
  readonly now?: Date;
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

  // Реестр исключений спрашивается ВТОРЫМ: после защищённой области, но раньше самого правила.
  //
  // После области — потому что исключение узаконивает нарушение ПРАВИЛА, а не право машины лезть
  // в миграции или в права. Пусти его вперёд, и строки в exceptions.yaml хватило бы, чтобы снять
  // запрет из protected-surfaces.yaml, которого она не касалась, — причём молча, вердиктом
  // «отклонено».
  //
  // Раньше правила — потому что дальше идут проверки, отвечающие «что делать с нарушением»:
  // чинить, нести человеку, отложить. Узаконенного нарушения среди них нет вовсе, и спрашивать
  // про него «разрешена ли автоправка» значит вернуть человеку ровно то, от чего исключение его и
  // избавило.
  const covering = exceptionsFor(finding, options);
  if (covering.length > 0) {
    const today = (options.now ?? new Date()).toISOString().slice(0, 10);
    const active = covering.find((exception) => isActive(exception, today));
    if (active !== undefined) {
      return {
        decision: 'rejected',
        reason: `узаконено исключением ${active.id}: ${oneLine(active.reason)}`,
      };
    }
    const stale = covering[0];
    if (stale !== undefined) {
      // Просроченное исключение не укрывает находку — но и автомату она не отдаётся. Оба
      // очевидных ответа здесь неверны: укрыть значит сделать дату пересмотра украшением, а
      // молча починить — переписать место, которое человек однажды объявил осознанным, не
      // спросив его. Верен третий: показать человеку и назвать просроченную запись, чтобы он
      // продлил её или снял.
      return {
        decision: 'manual',
        reason: `исключение ${stale.id} не действует (пересмотр: ${stale.reviewBy ?? 'не назначен'}): подтвердите его или снимите`,
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
 * Исключения, описанные ровно на эту находку: то же правило и ВСЕ её файлы под масками записи.
 *
 * Все, а не любой: исключение узаконивает нарушение в названном месте, и находка, половина
 * которой лежит за его масками, узаконена не целиком. Хватило бы одного совпавшего файла —
 * разрешение молча растянулось бы на соседей, которых человек в него не вписывал.
 *
 * Находка без правила под исключение не попадает никогда: реестр разрешает нарушить конкретное
 * правило, а не «что-нибудь в этих файлах».
 */
function exceptionsFor(
  finding: TrackedFinding,
  options: SelectOptions,
): readonly ArchitectureException[] {
  const target = finding.policy;
  if (target === undefined || finding.files.length === 0) return [];
  return options.policies.exceptions.filter(
    (exception) =>
      exception.policy === target &&
      finding.files.every((file) =>
        matchesAny(normalizePath(options.config.root, file), exception.paths),
      ),
  );
}

/**
 * Действует ли исключение в этот день.
 *
 * Бессрочных исключений не бывает: запись без даты пересмотра — и запись с датой, которую не
 * прочитать, — это не разрешение, а забытое нарушение, и укрывать находку она не должна. Сравнение
 * идёт днями как строками `YYYY-MM-DD`: `reviewBy` назначают на день, и исключение доживает этот
 * день до конца, а не до полуночи чьего-то часового пояса.
 */
function isActive(exception: ArchitectureException, today: string): boolean {
  const reviewBy = exception.reviewBy;
  if (reviewBy === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) return false;
  return today <= reviewBy;
}

/** Причина исключения пишется в YAML абзацем, а читается строкой таблицы отчёта. */
function oneLine(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim();
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
