/**
 * Общий обход исходников фронта для проверок качества.
 *
 * Живёт отдельным модулем не ради краткости: детекцию сырых ключей зовут две проверки
 * (`check-stage2-layout` и бюджеты качества), а разъехавшись, они начали бы считать по-разному —
 * и расхождение обнаружилось бы ровно тогда, когда на одну из них полагаются.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Все `.ts`/`.tsx` под каталогом, рекурсивно. */
export function walkTs(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * Обращения к кэшу запросов сырым ключом. Проверяется не только `queryKey:` — строка прячется и в
 * `setQueryData`, и в `invalidateQueries`.
 *
 * Регулярка временная и заведомо неполная: ключ, сначала записанный в переменную
 * (`const SCHEDULES_KEY = ['mailing-schedules']`), она не видит. Замена на обход AST — работа Б4
 * плана `docs/frontend-followup-plan.md`; менять придётся только эту функцию.
 */
const CACHE_CALLS =
  /(queryKey:\s*\[\s*'|invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*'|setQueryData\(\s*\[\s*'|getQueryData\(\s*\[\s*'|removeQueries\(\s*\{\s*queryKey:\s*\[\s*'|cancelQueries\(\s*\{\s*queryKey:\s*\[\s*')/;

export function hasRawQueryKey(code) {
  return CACHE_CALLS.test(code);
}

/** Ключи и есть содержимое `keys.ts` — там строки законны. */
export function isEntityKeysFile(relPath) {
  return relPath.startsWith(`entities${path.sep}`) && relPath.includes(`api${path.sep}keys`);
}
