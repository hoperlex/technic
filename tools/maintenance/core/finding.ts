/**
 * Контракт находки: единственный машинный интерфейс между агентом и системой.
 *
 * ЗАЧЕМ СТРОГАЯ ФОРМА. Прозу нечем сравнить с прошлым прогоном, нечем отобрать по бюджету и нечем
 * оспорить. Находка без структуры превращается в мнение, а система, принимающая решения по
 * мнениям, не может ни остановиться, ни объяснить, почему остановилась.
 *
 * Поля выбраны так, чтобы отбор работал БЕЗ повторного обращения к модели: строгость и
 * уверенность дают порядок, риск для поведения и список файлов — допуск, доказательство —
 * возможность человеку проверить находку глазами, не веря на слово.
 */
import { createHash } from 'node:crypto';

export type FindingSeverity = 'high' | 'medium' | 'low';
export type BehaviorRisk = 'low' | 'medium' | 'high';

export interface Finding {
  /** Идентификатор в пределах прогона. Отпечаток для узнавания между прогонами — отдельно. */
  readonly id: string;
  readonly category: string;
  readonly title: string;
  /**
   * Stable identity of the problem inside the listed files, for example a symbol, duplicated
   * concept, or violated invariant. Unlike the title and evidence, this field is not prose for a
   * report and must remain unchanged when the reviewer rephrases the same observation.
   */
  readonly subject: string;
  readonly severity: FindingSeverity;
  /** Уверенность агента, от 0 до 1. Ниже порога находка не чинится, но и не исчезает: она в отчёте. */
  readonly confidence: number;
  readonly files: readonly string[];
  /** Наблюдаемое доказательство: что именно видно в коде. Не пересказ намерения. */
  readonly evidence: string;
  /** Правило из architecture.yaml, если находка о нарушении правила. */
  readonly policy?: string;
  readonly relatedAdr?: string;
  /**
   * Риск изменить наблюдаемое поведение при исправлении.
   *
   * Оценивает агент, а решает бюджет. Разделение намеренное: модель хорошо отвечает на вопрос
   * «может ли эта правка что-то изменить», но не должна отвечать на вопрос «допустим ли такой
   * риск сегодня» — это вопрос политики, а не кода.
   */
  readonly behaviorRisk: BehaviorRisk;
  readonly suggestedAction: string;
  /** Оценка объёма правки в строках. Нужна бюджету до того, как правка сделана. */
  readonly estimatedLines?: number;
}

/** Находка вместе с тем, что о ней знает система, а не агент. */
export interface TrackedFinding extends Finding {
  readonly fingerprint: string;
}

/**
 * Identify the same problem across runs without depending on reviewer prose.
 *
 * Category, affected files, and a stable subject describe identity. Title, evidence, policy
 * wording, line numbers, severity, and confidence may change while the underlying debt remains
 * the same. Exact evidence still has its own digest in the ledger to reopen materially changed
 * observations without creating a new identity.
 */
export function fingerprintOf(finding: Finding): string {
  const parts = [
    finding.category,
    [...finding.files].sort().join('|'),
    normalizeSubject(finding.subject),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 16);
}

/**
 * Transitional identity used only to migrate ledger entries written before stable subject
 * existed. New callers must use fingerprintOf.
 */
export function legacyFingerprintOf(finding: Finding): string {
  const parts = [
    finding.policy ?? '',
    finding.category,
    [...finding.files].sort().join('|'),
    normalizeLegacyEvidence(finding.evidence),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 16);
}

function normalizeSubject(subject: string): string {
  return subject.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240);
}

function normalizeLegacyEvidence(evidence: string): string {
  return evidence.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function trackFinding(finding: Finding): TrackedFinding {
  return { ...finding, fingerprint: fingerprintOf(finding) };
}
