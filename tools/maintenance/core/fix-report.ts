/**
 * Отчёт исполнителя: единственное место, где он разбирается.
 *
 * ПОЧЕМУ ОДНО. Раньше `fix.json` читали три разных куска команд, и читали по-разному: один собирал
 * счётчики, другой только список файлов, третий не читал вовсе и подставлял вместо него список
 * изменённых файлов партии. Последнее выключало замок поведения целиком — «что назвал исполнитель»
 * совпадало с «что изменилось», и выход за границы партии становился неотличим от чужой работы.
 *
 * ЗДЕСЬ НЕТ РЕШЕНИЙ, только разбор. Что делать с прочитанным — дело вызывающего: он знает, какие
 * находки выдавал и чем они были.
 */
export interface FixReport {
  /** Был ли отчёт вообще. Отсутствие отчёта и пустой отчёт — разные новости. */
  readonly present: boolean;
  /** Файлы, которые исполнитель НАЗВАЛ изменёнными. Не то же, что изменённые на диске. */
  readonly claimed: readonly string[];
  /** Идентификаторы находок, которые он считает сделанными. */
  readonly applied: readonly string[];
  /** Идентификаторы, за которые он не взялся, с причиной. */
  readonly skipped: readonly { readonly id: string; readonly why: string }[];
  /** Строгость новых находок, о которых он сообщил: по ним считают, не работает ли цикл во вред. */
  readonly newSeverities: readonly string[];
  /** Что не удалось прочитать. Пусто — разбор прошёл целиком. */
  readonly problems: readonly string[];
}

export const EMPTY_FIX_REPORT: FixReport = {
  present: false,
  claimed: [],
  applied: [],
  skipped: [],
  newSeverities: [],
  problems: [],
};

/**
 * Разобрать текст отчёта.
 *
 * Битый JSON даёт `present: true` и проблему в списке — не «отчёта нет». Разница существенна: нет
 * отчёта у ручного адаптера обычное дело, а испорченный отчёт означает, что исполнитель работал, и
 * верить его границам нельзя.
 */
export function parseFixReport(text: string): FixReport {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      ...EMPTY_FIX_REPORT,
      present: true,
      problems: [`отчёт исполнителя не разобрался: ${(cause as Error).message}`],
    };
  }

  const node = parsed as {
    applied?: unknown;
    skipped?: unknown;
    newFindings?: unknown;
  };

  const claimed = new Set<string>();
  const applied: string[] = [];
  if (Array.isArray(node.applied)) {
    for (const item of node.applied) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as { id?: unknown; files?: unknown };
      if (typeof record.id === 'string' && record.id.trim() !== '') applied.push(record.id.trim());
      if (!Array.isArray(record.files)) continue;
      for (const file of record.files) {
        if (typeof file === 'string' && file.trim() !== '') claimed.add(file.trim());
      }
    }
  } else if (node.applied !== undefined) {
    problems.push('поле applied в отчёте не список');
  }

  const skipped: { id: string; why: string }[] = [];
  if (Array.isArray(node.skipped)) {
    for (const item of node.skipped) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as { id?: unknown; why?: unknown };
      if (typeof record.id !== 'string') continue;
      skipped.push({ id: record.id, why: typeof record.why === 'string' ? record.why : 'без причины' });
    }
  }

  const newSeverities: string[] = [];
  if (Array.isArray(node.newFindings)) {
    for (const item of node.newFindings) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as { severity?: unknown };
      newSeverities.push(typeof record.severity === 'string' ? record.severity : 'low');
    }
  }

  return { present: true, claimed: [...claimed], applied, skipped, newSeverities, problems };
}

/** Сколько среди новых находок серьёзных: условие остановки сравнивает именно их. */
export function countSevere(severities: readonly string[]): number {
  return severities.filter((severity) => severity === 'high').length;
}
