/**
 * Чтение ответа агента.
 *
 * ДОВЕРИЕ ЗДЕСЬ НЕУМЕСТНО. Ответ пришёл от модели, а не от инструмента: он может быть обрезан,
 * обёрнут в пояснения, содержать уверенность «высокая» вместо числа или файл, которого нет. Всё
 * это — обычные случаи, а не сбой, и обрабатывать их надо поштучно: одна кривая находка не должна
 * ронять весь разбор, но и проходить молча тоже не должна.
 */
import type { BehaviorRisk, Finding, FindingSeverity } from './finding.ts';
import { trackFinding, type TrackedFinding } from './finding.ts';

export interface ParseResult {
  readonly findings: readonly TrackedFinding[];
  /** Что не удалось разобрать. Печатается человеку: молчаливая потеря находки хуже её отсутствия. */
  readonly problems: readonly string[];
}

const SEVERITIES: readonly FindingSeverity[] = ['high', 'medium', 'low'];
const RISKS: readonly BehaviorRisk[] = ['low', 'medium', 'high'];

/**
 * Достать объект из ответа.
 *
 * Модель регулярно оборачивает JSON в тройные кавычки или добавляет строку «вот результат».
 * Требовать чистоты бесполезно — дешевле вырезать объект: берём от первой открывающей скобки до
 * последней закрывающей.
 */
function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function parseFindings(text: string, source: string): ParseResult {
  const problems: string[] = [];
  const body = extractJson(text);
  if (body === null) {
    return { findings: [], problems: [`${source}: объекта JSON в ответе нет`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    return {
      findings: [],
      problems: [`${source}: ответ не разобрался как JSON — ${(cause as Error).message}`],
    };
  }
  const container = parsed as { findings?: unknown; newFindings?: unknown };
  const raw = Array.isArray(container.findings)
    ? container.findings
    : Array.isArray(container.newFindings)
      ? container.newFindings
      : null;
  if (raw === null) {
    return { findings: [], problems: [`${source}: в объекте нет списка findings`] };
  }

  const findings: TrackedFinding[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const finding = readFinding(item, `${source}: находка #${index + 1}`, problems);
    if (finding === null) return;
    // Задвоенный идентификатор ломает отчёт отбора: по нему адресуется задание исполнителю.
    if (seen.has(finding.id)) {
      problems.push(
        `${source}: идентификатор ${finding.id} встречается дважды — вторая находка отброшена`,
      );
      return;
    }
    seen.add(finding.id);
    findings.push(trackFinding(finding));
  });

  return { findings, problems };
}

function readFinding(value: unknown, where: string, problems: string[]): Finding | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${where}: ожидался объект`);
    return null;
  }
  const node = value as Record<string, unknown>;

  const id = text(node['id']);
  const title = text(node['title']);
  const category = text(node['category']);
  const evidence = text(node['evidence']);
  const action = text(node['suggestedAction']);
  const files = stringList(node['files']);

  if (id === null || title === null || category === null || evidence === null || action === null) {
    problems.push(
      `${where}: нет обязательных полей id, category, title, evidence, suggestedAction`,
    );
    return null;
  }
  if (files.length === 0) {
    // Находка без файлов неотличима от мнения: её нечем проверить и нечем ограничить бюджетом.
    problems.push(`${where} (${id}): не назван ни один файл`);
    return null;
  }

  const severity = enumValue(node['severity'], SEVERITIES);
  const behaviorRisk = enumValue(node['behaviorRisk'], RISKS);
  if (severity === null || behaviorRisk === null) {
    problems.push(`${where} (${id}): severity или behaviorRisk вне словаря`);
    return null;
  }

  const confidence = Number(node['confidence']);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    problems.push(`${where} (${id}): уверенность обязана быть числом от 0 до 1`);
    return null;
  }

  const estimated = Number(node['estimatedLines']);
  return {
    id,
    category,
    title,
    severity,
    confidence,
    files,
    evidence,
    policy: text(node['policy']) ?? undefined,
    relatedAdr: text(node['relatedAdr']) ?? undefined,
    behaviorRisk,
    suggestedAction: action,
    estimatedLines: Number.isFinite(estimated) && estimated > 0 ? Math.round(estimated) : undefined,
  };
}

/** Значение из закрытого словаря. Всё, чего в словаре нет, — промах формы, а не синоним. */
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() as T;
  return allowed.includes(normalized) ? normalized : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const parsed = text(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
