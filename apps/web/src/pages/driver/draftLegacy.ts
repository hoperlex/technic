import type { DraftItem } from './api';
import {
  fingerprint,
  legacyDraftKey,
  normalizeItem,
  type BranchState,
  type DraftEntry,
} from './draftMerge';

/**
 * Drafts of the formats before the current one: `v1` cells (ADR 0129, Р11б) and `v2` branches (ADR
 * 0234). Both are read here and never written: an old build may still be open in a tab and keeps
 * writing its own cells, so the only safe writer of an old cell is that old build.
 *
 * The rule is the one ADR 0129 set for `v1`: what a person typed in an old format is never dropped
 * and never guessed at. A `v2` row is addressed by its source key — the same address `v3` uses — so
 * unlike a `v1` record it can be taken over without asking: when `v3` holds nothing for that key,
 * the row becomes the `v3` row, and its mark goes into the `v3` journal in the same branch write.
 * When `v3` already holds the key, the `v2` row is a later edit in an old tab: it is shown as an
 * unmatched record, and the person decides.
 */

export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Запись прежнего формата, ещё не учтённая: показывается блоком и переезжает нажатием (Р14). */
export interface LegacyRecord {
  /** The `v1` record's `itemId`, or the `v2` row's source key: the block's render key. */
  itemId: string;
  item: DraftItem;
  fingerprint: string;
  savedAt: number;
}

/**
 * Mark of one VERSION of a `v2` row. The clock alone names it: a `v2` version is born with a new
 * counter in its writer's branch, and copies carry the same clock. The content stays out on purpose
 * — the normalizer gains keys with every format, and a mark over content would change for every
 * handled row at once and bring them all back (the reason `legacyFingerprint` freezes its fields).
 */
function v2Mark(key: string, entry: DraftEntry): string {
  return fingerprint(['v2', key, entry.clock.counter, entry.clock.branch]);
}

/**
 * Takes the `v2` rows over (see the module header). `own` is the merged `v3` state; the result is
 * that state with the adopted rows and their marks, plus the rows left for the person to place.
 *
 * An adopted row gets the first counter in this branch: `v3` holds no version of that key, so there
 * is nothing to be newer than. Two tabs adopting the same row write equal content under two
 * branches, and the merge picks one of them deterministically.
 *
 * A `v2` tombstone is not carried over: it is the old build's record of a sent row, and the server
 * already holds that reading.
 */
export function adoptV2(
  own: BranchState,
  v2: BranchState,
  branch: string,
): { state: BranchState; records: LegacyRecord[] } {
  const entries = { ...own.entries };
  const legacy = new Set(own.legacy);
  const records: LegacyRecord[] = [];
  for (const [key, entry] of Object.entries(v2.entries)) {
    if (!entry.item) continue;
    const mark = v2Mark(key, entry);
    if (own.legacy.includes(mark)) continue;
    if (own.entries[key] === undefined) {
      entries[key] = { clock: { counter: 1, branch }, savedAt: entry.savedAt, item: entry.item };
      legacy.add(mark);
    } else {
      records.push({ itemId: key, item: entry.item, fingerprint: mark, savedAt: entry.savedAt });
    }
  }
  return { state: { ...own, entries, legacy: [...legacy].sort() }, records };
}

/**
 * Записи прежнего формата — только чтение. Учтённые те, чей отпечаток содержимого лежит в журнале;
 * разошёлся отпечаток — старая вкладка переписала запись, и это новая правка человека, а не
 * воскресший призрак (Р11б).
 *
 * `handled` joins the `v3` journal with the `v2` ones: a `v1` record placed by the `v2` build was
 * journaled there, and it must not come back only because the format moved on.
 */
export function readLegacy(
  userId: string,
  date: string,
  handled: ReadonlySet<string>,
): LegacyRecord[] {
  const raw = localStorage.getItem(legacyDraftKey(userId, date));
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  const draft = value as { savedAt?: unknown; items?: unknown } | null;
  const savedAt = typeof draft?.savedAt === 'number' ? draft.savedAt : 0;
  const items = draft?.items;
  // Просроченный черновик не показывается даже до уборки: неделю назад введённые показания
  // относятся уже не к тому счётчику, что человек видит перед собой.
  if (!items || typeof items !== 'object' || Date.now() - savedAt > TTL_MS) return [];
  const records: LegacyRecord[] = [];
  for (const [itemId, rawItem] of Object.entries(items)) {
    // Тем же нормализатором, что и ветки: старый формат знал виды показаний и поля, которых
    // больше нет, а новых не знал вовсе — недостающее читается пустым, лишнее не смотрится. Двух
    // приведений на входы хранилища быть не должно: они разойдутся на первом же новом поле.
    const item = normalizeItem(rawItem);
    const mark = legacyFingerprint(itemId, item);
    if (!handled.has(mark)) records.push({ itemId, item, fingerprint: mark, savedAt });
  }
  return records;
}

/**
 * Отпечаток записи `v1`. Идентификатор строки входит в него намеренно: две записи, совпавшие
 * содержимым до последнего пробела, гасились бы одной пометкой.
 *
 * **Остатков топлива здесь нет, и это не забытая строка.** Формат `v1` перестал записываться до
 * того, как остатки появились: у всякой его записи оба поля — пустая строка, приведённая
 * нормализатором, то есть одна и та же константа у всех. Различать они не могут ничего, а вот смена
 * формулы стоила бы дорого и сразу: отпечаток изменился бы у всех записей `v1` разом, и уже
 * разобранная запись всплыла бы у водителя ещё раз как непривязанная. Перечисление здесь описывает
 * не `DraftItem`, а то, чем записи прежнего формата **отличаются друг от друга**. The times of
 * `v3` stay out for the same reason.
 */
export function legacyFingerprint(itemId: string, item: DraftItem): string {
  return fingerprint([
    itemId,
    item.odometerKm,
    item.engineHours,
    item.fuelFilledLiters,
    item.comment,
    item.files.map((file) => file.id),
    item.confirmAnomaly,
  ]);
}

/** `savedAt` of a `v1` cell for the TTL sweep; an unreadable cell has none and goes. */
export function legacySavedAt(raw: string | null): number | null {
  try {
    const value = JSON.parse(raw ?? '') as { savedAt?: unknown } | null;
    return typeof value?.savedAt === 'number' ? value.savedAt : null;
  } catch {
    return null;
  }
}
