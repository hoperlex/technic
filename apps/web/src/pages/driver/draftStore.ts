import type { ReportSubmitBody } from '@technic/contracts';
import type { DraftFile, DraftItem } from './api';
import {
  compareClocks,
  draftPrefix,
  fingerprint,
  isEmpty,
  legacyDraftKey,
  mergeBranches,
  nextAttemptClock,
  normalizeItem,
  orderAttempts,
  parseBranch,
  PREFIX,
  sameContent,
  V1_PREFIX,
  type Branch,
  type BranchState,
  type DraftClock,
  type DraftEntry,
  type DraftRow,
  type SubmitAttempt,
} from './draftMerge';

/**
 * Черновик показаний версии 2: адресуется источником, пишется ветками, сливается при чтении
 * (план кабинета водителя — Р11, Р11б, Р11в, Р11г, Р12а, Р14).
 *
 * Три решения, из которых следует всё остальное.
 *
 * 1. **Свой физический ключ.** Черновик прежнего формата лежит целым объектом дня и переписывается
 *    целиком; пока жива вкладка старой сборки, у той ячейки два писателя, и уцелевает последняя
 *    запись. Поэтому `v2` живёт под своим префиксом, а в `v1` этот модуль не пишет и записей из
 *    него не удаляет — только читает и предъявляет человеку (Р11б, Р14).
 * 2. **Ветка на документ.** `localStorage` не даёт ни блокировки, ни сравнения-с-обменом: между
 *    чтением и записью общего ключа влезает соседняя вкладка и уносит чужую правку, а событие
 *    `storage` приходит уже после потери. Общего ключа у писателей поэтому нет вовсе — каждый
 *    документ пишет свой, а слияние происходит при чтении.
 * 3. **Порядок версий задают логические часы** `{счётчик, ветка}` (draftMerge.ts). Физическое
 *    время осталось для TTL и для подписи «сохранено в 14:32».
 *
 * Отсюда же удаление строки: вычеркнутая из своей ветки, она вернулась бы из соседней при
 * следующем слиянии, поэтому удаление — такая же версия строки, как значение (Р11г).
 */

export type { DraftClock, DraftEntry, DraftFile, DraftItem, DraftRow, SubmitAttempt };

// ── Что видит страница ──

/** Запись прежнего формата, ещё не учтённая: показывается блоком и переезжает нажатием (Р14). */
export interface LegacyRecord {
  itemId: string;
  item: DraftItem;
  fingerprint: string;
  savedAt: number;
}

export interface DraftView {
  /** Строки по ключу `sourceKind:sourceId`: он переживает пересоздание строки ожидания (Р11). */
  items: Record<string, DraftRow>;
  /** Последняя физическая отметка веток дня — для подписи, а не для выбора победителя. */
  savedAt: number | null;
  legacy: LegacyRecord[];
  /** От новых к старым по логическим часам: повторяют последнюю совпавшую по отпечатку. */
  attempts: SubmitAttempt[];
}

/** Изменение строки: значение или надгробие. */
export interface DraftChange {
  key: string;
  item: DraftItem | null;
  /**
   * Записать, только если победитель слияния — та самая версия. Так гасятся отправленные строки:
   * переписанную, пока запрос был в пути, гасить нельзя — это правка, сделанная позже той, что
   * ушла на сервер (Р12).
   */
  ifClock?: DraftClock;
}

/**
 * Правка ветки одной записью: перенос кладёт значение цели и надгробие источника вместе, успешная
 * отправка — надгробия строк, пометки учтённых `v1` и итог попытки. Порознь они дали бы либо
 * задвоение, либо потерю (Р14а п. 4, Р12).
 */
export interface DraftPatch {
  items?: readonly DraftChange[];
  /** Отпечатки записей `v1`, с которыми что-то сделали: перенесли, отправили, отклонили (Р11б). */
  legacy?: readonly string[];
  /** Попытка ложится в ветку до `POST`: команда, ушедшая без следа, при повторе станет второй. */
  attempt?: { key: string; reportVersion: number; fingerprint: string };
  /** Итог попытки — версионированной отметкой: копия из соседней ветки иначе воскресит её. */
  close?: { key: string; state: 'succeeded' | 'rejected' };
}

/**
 * Итог записи. Отказ хранилища не глотается молча: перенос и отправка обязаны узнать о нём раньше,
 * чем тронут файлы или сеть (Р14а п. 5, Р12а п. 1).
 */
export type WriteResult = { ok: true } | { ok: false; error: unknown };

// ── Ключи и ветка ──

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ветка этого документа — случайное значение, рождённое загрузкой модуля и живущее только в
 * памяти. `sessionStorage` для этого не годится, и это не осторожность, а буква стандарта: при
 * открытии дочерней вкладки и при дублировании существующей хранилище сессии копируется, и два
 * документа получили бы один ключ — ровно ту гонку, ради которой ключи и разводились. Значение в
 * памяти скопировать нечем.
 */
const BRANCH = newBranch();

function newBranch(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const draftBranch = (): string => BRANCH;

/** Ключи наружу отдаёт хранилище: снаружи это один модуль, и деление на два — его внутреннее дело. */
export { draftPrefix, legacyDraftKey } from './draftMerge';

const ownKey = (userId: string, date: string): string => `${draftPrefix(userId, date)}${BRANCH}`;

function readBranches(userId: string, date: string): Branch[] {
  const prefix = draftPrefix(userId, date);
  const branches: Branch[] = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const state = parseBranch(localStorage.getItem(key));
    if (state) branches.push({ key, state });
  }
  return branches;
}

// ── Чтение ──

export function readDraft(userId: string, date: string): DraftView {
  const branches = readBranches(userId, date);
  const merged = mergeBranches(branches);
  consolidate(userId, date, branches, merged);
  const items: Record<string, DraftRow> = {};
  for (const [key, entry] of Object.entries(merged.entries)) {
    // Надгробия наружу не выходят: их дело — гасить строку в слиянии, а не показываться.
    if (entry.item) items[key] = { ...entry, item: entry.item };
  }
  return {
    items,
    savedAt: merged.savedAt || null,
    legacy: readLegacy(userId, date, merged.legacy),
    attempts: merged.attempts,
  };
}

/**
 * Победившие версии переписываются в свою ветку — иначе веток набирается по одной на загрузку и
 * уборке нечего снимать. Копия идёт с **исходными** часами, а ветка пишется, только если её
 * содержимое действительно изменилось: без этих двух правил соседние вкладки ответили бы на
 * `storage` взаимными консолидациями и обновляли бы друг другу отметки до бесконечности (Р11в).
 */
function consolidate(
  userId: string,
  date: string,
  branches: readonly Branch[],
  merged: BranchState,
): void {
  const key = ownKey(userId, date);
  const own = branches.find((branch) => branch.key === key)?.state;
  // Пустой день своей ветки не заводит: иначе каждое чтение календаря оставляло бы по ключу.
  if (own ? sameContent(own, merged) : isEmpty(merged)) return;
  // Отказ хранилища здесь молчалив намеренно: консолидация — удобство уборки, а не сохранение
  // введённого, и мешать чтению дня она не должна.
  write(key, { ...merged, savedAt: Date.now() });
}

/**
 * Записи прежнего формата — только чтение. Учтённые те, чей отпечаток содержимого лежит в журнале;
 * разошёлся отпечаток — старая вкладка переписала запись, и это новая правка человека, а не
 * воскресший призрак (Р11б).
 */
function readLegacy(userId: string, date: string, handled: readonly string[]): LegacyRecord[] {
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
  const seen = new Set(handled);
  const records: LegacyRecord[] = [];
  for (const [itemId, rawItem] of Object.entries(items)) {
    // Тем же нормализатором, что и ветки `v2`: старый формат знал виды показаний и поля, которых
    // больше нет, а новых не знал вовсе — недостающее читается пустым, лишнее не смотрится. Двух
    // приведений на два входа хранилища быть не должно: они разойдутся на первом же новом поле.
    const item = normalizeItem(rawItem);
    const mark = legacyFingerprint(itemId, item);
    if (!seen.has(mark)) records.push({ itemId, item, fingerprint: mark, savedAt });
  }
  return records;
}

// ── Запись ──

export function writeDraft(userId: string, date: string, patch: DraftPatch): WriteResult {
  // Ветки перечитываются здесь и сейчас, а не берутся из снимка страницы: между отрисовкой и этой
  // записью соседняя вкладка могла поднять счётчик — и версия, выданная по устаревшему снимку,
  // проиграла бы слияние собственной правке. Замороженная браузером вкладка — тот же случай.
  const branches = readBranches(userId, date);
  const merged = mergeBranches(branches);
  const now = Date.now();
  const entries = { ...merged.entries };
  for (const change of patch.items ?? []) {
    const current = merged.entries[change.key];
    if (change.ifClock && !(current && compareClocks(current.clock, change.ifClock) === 0))
      continue;
    entries[change.key] = {
      // Победитель слияния несёт наибольший счётчик по строке — он и есть «наибольший виденный».
      clock: { counter: (current?.clock.counter ?? 0) + 1, branch: BRANCH },
      savedAt: now,
      item: change.item,
    };
  }
  const legacy = new Set([...merged.legacy, ...(patch.legacy ?? [])]);
  const attempts = new Map(merged.attempts.map((attempt) => [attempt.key, attempt]));
  if (patch.attempt) {
    // Часы новой попытки считает `nextAttemptClock`: своей предшественницы у нового ключа нет.
    attempts.set(patch.attempt.key, {
      ...patch.attempt,
      state: 'pending',
      clock: nextAttemptClock(merged.attempts, BRANCH),
    });
  }
  const closing = patch.close && attempts.get(patch.close.key);
  // Итог кладётся старшими часами: копия попытки из соседней ветки иначе выиграла бы слияние, и
  // портал повторил бы уже принятую команду (Р12а п. 4).
  if (patch.close && closing) {
    attempts.set(closing.key, {
      ...closing,
      state: patch.close.state,
      clock: { counter: closing.clock.counter + 1, branch: BRANCH },
    });
  }
  return write(ownKey(userId, date), {
    savedAt: now,
    entries,
    legacy: [...legacy].sort(),
    attempts: orderAttempts([...attempts.values()]),
  });
}

function write(key: string, state: BranchState): WriteResult {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Какую попытку повторять: последняя незавершённая с тем же отпечатком тела, а не последняя
 * вообще — между обрывом и повтором человек мог отправить соседний день или поправить строку
 * (Р12а п. 3). Порядок в `attempts` — от новых к старым, поэтому первая совпавшая и есть последняя.
 */
export function pendingAttempt(view: DraftView, mark: string): SubmitAttempt | null {
  return view.attempts.find((a) => a.state === 'pending' && a.fingerprint === mark) ?? null;
}

/** Отпечаток тела отправки — без версии отчёта: она растёт сама, командой тело быть не перестаёт. */
export function bodyFingerprint(items: ReportSubmitBody['items']): string {
  // Порядок строк в теле не гарантирован ничем: перечитанный отчёт дал бы другой отпечаток тому же
  // самому телу, и повтор ушёл бы второй командой.
  return fingerprint([...items].sort((a, b) => (a.itemId < b.itemId ? -1 : 1)));
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
 * не `DraftItem`, а то, чем записи прежнего формата **отличаются друг от друга**.
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

// ── Уборка ──

/**
 * Уборка по TTL: своего фонового процесса у портала нет, а «когда-нибудь потом» для чужих
 * показаний на общем телефоне означает «никогда», — поэтому зовётся при входе в кабинет.
 */
export function pruneDrafts(): void {
  const now = Date.now();
  // Сначала старый формат: ветка с журналом держится, пока для дня есть `v1`-ключ, и уходит вместе
  // с ним. Внутрь записи модуль при этом не лезет — истёкшая ячейка удаляется целиком, ровно как
  // её убирала прежняя сборка (Р11б).
  const legacyDays = new Set<string>();
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(V1_PREFIX)) continue;
    const savedAt = legacySavedAt(localStorage.getItem(key));
    if (savedAt === null || now - savedAt > TTL_MS) localStorage.removeItem(key);
    else legacyDays.add(key.slice(V1_PREFIX.length));
  }
  const branches: { key: string; day: string; state: BranchState }[] = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue;
    const state = parseBranch(localStorage.getItem(key));
    if (!state) localStorage.removeItem(key);
    else branches.push({ key, day: key.slice(PREFIX.length, key.lastIndexOf(':')), state });
  }
  const doomed = new Set(
    branches
      .filter(({ state }) => now - state.savedAt > TTL_MS)
      // Журнал переживает опустевший черновик: отправка, вычистившая последнюю строку, стёрла бы
      // вместе с ней и память о том, что `v1` уже учтён, — и блок воскрес бы следующим чтением.
      .filter(({ state, day }) => state.legacy.length === 0 || !legacyDays.has(day))
      .map(({ key }) => key),
  );
  /*
   * Отметка удаления держится не сроком своей ветки, а наличием того, что она гасит: ветка со
   * старым значением строки переживает ветку с отметкой, если её вкладка продолжает писать другие
   * строки, — и погашенная строка воскресла бы. Поэтому ветку с непереехавшей отметкой оставляем:
   * консолидация перенесёт отметку раньше, чем ветка уйдёт (Р11г). Проходов несколько — снятая с
   * удаления ветка сама становится «остающейся» и может удержать соседнюю.
   */
  for (let pass = 0; pass < branches.length && doomed.size > 0; pass += 1) {
    const kept = branches.filter(({ key }) => !doomed.has(key));
    const rescued = branches.filter(({ key, state }) => doomed.has(key) && gates(state, kept));
    if (rescued.length === 0) break;
    for (const { key } of rescued) doomed.delete(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
}

/**
 * Есть ли в ветке отметка удаления, которой ещё некому заменить: в остающихся ветках лежит более
 * младшая версия строки, а самой отметки — или чего-то старше неё — нет. Когда младших версий нет
 * нигде, отметка уходит вместе со своей веткой по общему TTL.
 */
function gates(state: BranchState, kept: readonly { state: BranchState }[]): boolean {
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry.item !== null) continue;
    let best: DraftClock | null = null;
    for (const other of kept) {
      const rival = other.state.entries[key];
      if (rival && (!best || compareClocks(rival.clock, best) > 0)) best = rival.clock;
    }
    if (best && compareClocks(best, entry.clock) < 0) return true;
  }
  return false;
}

function legacySavedAt(raw: string | null): number | null {
  try {
    const value = JSON.parse(raw ?? '') as { savedAt?: unknown } | null;
    return typeof value?.savedAt === 'number' ? value.savedAt : null;
  } catch {
    return null;
  }
}

/**
 * Выход из учётной записи чистит оба префикса: на общем телефоне чужие показания не должны
 * пережить смену человека (Р11б).
 */
export function clearUserDrafts(userId: string): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(`${V1_PREFIX}${userId}:`) || key.startsWith(`${PREFIX}${userId}:`)) {
      localStorage.removeItem(key);
    }
  }
}
