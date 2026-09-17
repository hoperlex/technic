/**
 * Состояние одного прогона сходимости.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ С ОДНИМИ ТИПАМИ. Прогон идёт не за один запуск команды: между
 * проходами система ждёт человека — он относит задание агенту и приносит ответ. Значит состояние
 * обязано пережить выход из процесса, лечь в файл и быть прочитанным следующей командой. А раз
 * так, его форма — контракт сразу для трёх сторон: автомата цикла, отчёта и командной строки.
 * Общий файл типов держит их в согласии без того, чтобы кто-то из них зависел от чужой логики.
 */
import type { Decision } from './selector.ts';
import type { TrackedFinding } from './finding.ts';
import type { Outcome } from '../verification/verifier.ts';

/** На чьём ходу прогон. Шагов ожидания ровно два: ответ ревьюера и правка исполнителя. */
export type RunStep = 'awaiting-review' | 'awaiting-fix' | 'finished';

/**
 * Причины остановки — закрытый список.
 *
 * Закрытый не ради стройности: человек, увидевший в отчёте незнакомую причину, не может ни
 * проверить её, ни оспорить. Каждая причина здесь соответствует строке в
 * `architecture/policies/maintenance.yaml` — политика называет условия, код их вычисляет.
 */
export type StopReason =
  | 'maxPassesReached'
  | 'noSelectedFindings'
  | 'improvementBelowThreshold'
  | 'behaviorRegressionDetected'
  | 'changeBudgetExceeded'
  | 'newSevereIssuesExceedResolved'
  | 'verificationFailedRepeatedly'
  | 'manualDecisionRequired';

/** Итог одного прохода. Заполняется по мере хода: отбор — раньше, проверка — позже. */
export interface PassRecord {
  readonly passId: string;
  readonly startedAt: string;
  /** Сколько находок разобрано и как их рассудил отбор. */
  readonly counts: Readonly<Record<Decision, number>>;
  /** Находки, отданные человеку: из них собирается список решений в отчёте. */
  readonly manualFindings: readonly TrackedFinding[];
  /**
   * Находки, взятые в работу этим проходом.
   *
   * Хранятся, потому что провалившийся проход НЕ ПОВТОРЯЕТСЯ (решение заказчика 14.09.2026): его
   * находки не исчезают, а уходят человеку в отчёт. Без списка сказать, что именно осталось
   * несделанным, было бы нечем — счётчика мало.
   */
  readonly selectedFindings: readonly TrackedFinding[];
  readonly verification: Outcome | null;
  readonly verificationReason: string | null;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
  /** Сколько серьёзных проблем исполнитель создал и сколько закрыл: условие остановки читает их. */
  readonly newSevere: number;
  readonly resolvedSevere: number;
  readonly finishedAt: string | null;
}

export interface RunTotals {
  readonly files: number;
  readonly lines: number;
  readonly rollbacks: number;
  readonly accepted: number;
}

/** Цех прогона: отдельное дерево, в котором идёт вся работа. */
export interface WorkshopRef {
  readonly path: string;
  /** Вершина, от которой дерево собрано: с ней сверяется передача коммита в ветку. */
  readonly base: string;
}

export interface RunState {
  readonly runId: string;
  readonly startedAt: string;
  /** Номер текущего прохода, считая с нуля. */
  readonly passIndex: number;
  readonly step: RunStep;
  readonly passes: readonly PassRecord[];
  readonly stop: { readonly reason: StopReason; readonly detail: string } | null;
  readonly totals: RunTotals;
  /**
   * Где прогон работает. `null` или отсутствие — прямо в рабочем дереве, по-старому.
   *
   * Лежит в состоянии, а не в памяти команды, потому что прогон идёт несколькими запусками:
   * дерево создаёт первый, пользуется им каждый следующий, а сносит тот, который прогон закрывает.
   */
  readonly workshop?: WorkshopRef | null;
}
