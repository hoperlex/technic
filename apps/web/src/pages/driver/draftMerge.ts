import type { DraftItem } from './api';

/**
 * Логические часы, разбор ветки и слияние — машинерия черновика показаний `v2`
 * ([draftStore.ts](draftStore.ts), Р11в и Р11г плана кабинета водителя).
 *
 * Отдельным модулем не по смыслу, а по размеру: вместе с хранилищем они перевалили бы за 400
 * строк — порог бюджета качества (scripts/quality.mjs). Граница проведена там, где она честная:
 * здесь правила, по которым версии сравниваются и складываются, там — ключи, запись и уборка.
 */

// ── Ключи хранилища ──

/**
 * Префикс нынешнего формата намеренно не начинается со старого: прежняя сборка перебирает ключи по
 * `startsWith` своего, и `…-v2:` под него не подходит ни в уборке по TTL, ни в очистке при выходе
 * (Р11б). Оба живут здесь, рядом со слиянием, а не в хранилище: по ним же сходятся ячейки, которые
 * слияние и складывает.
 */
export const PREFIX = 'technic:driver-draft-v2:';
export const V1_PREFIX = 'technic:driver-draft:';

/** Общее начало ключей дня: им же событие `storage` узнаёт, что перерисовывать (Р11в). */
export const draftPrefix = (userId: string, date: string): string => `${PREFIX}${userId}:${date}:`;

/**
 * Ключ ячейки прежнего формата. Нужен наружу ради того же события `storage`: запись, изменённую
 * вкладкой старой сборки, кабинет обязан показать снова (Р11б). Точный ключ лучше похожего хвоста —
 * по хвосту «учётка: дата» под перерисовку попадала бы любая чужая запись, им оканчивающаяся.
 */
export const legacyDraftKey = (userId: string, date: string): string =>
  `${V1_PREFIX}${userId}:${date}`;

/**
 * Часы версии: счётчик берётся как «наибольший виденный по этой строке плюс один», ветка разводит
 * одновременные записи детерминированно — строковым сравнением.
 *
 * Физическое время для порядка не годится: две ветки пишут в одну миллисекунду легко, и при
 * равных отметках победитель слияния не определён — два чтения выбрали бы разных.
 */
export interface DraftClock {
  counter: number;
  branch: string;
}

/** Версия строки: значение или надгробие (`item: null`) — слияние выбирает старшую из них (Р11г). */
export interface DraftEntry {
  clock: DraftClock;
  /** Физическое время: подпись «сохранено» и дата у непривязанного блока (Р14), не порядок версий. */
  savedAt: number;
  item: DraftItem | null;
}

/** Живая строка черновика: то же самое, но заведомо со значением. */
export type DraftRow = DraftEntry & { item: DraftItem };

/**
 * Попытка отправки. Ключ идемпотентности принадлежит ей, а не дню: после слияния веток ключей
 * столько же, сколько веток, а повторить нужно ровно ту пару «ключ + версия», которая ушла на
 * сервер, — сервер сверяет ключ раньше версии и на повтор отвечает текущим состоянием (Р12а).
 */
export interface SubmitAttempt {
  key: string;
  reportVersion: number;
  /** Отпечаток тела без версии отчёта: версия растёт сама, тело от этого другой командой не станет. */
  fingerprint: string;
  clock: DraftClock;
  state: 'pending' | 'succeeded' | 'rejected';
}

/** Содержимое одной ветки дня — ровно то, что лежит в ячейке хранилища. */
export interface BranchState {
  savedAt: number;
  entries: Record<string, DraftEntry>;
  /** Множество отпечатков учтённых записей `v1`: множества сливаются без порядка и без потерь. */
  legacy: string[];
  attempts: SubmitAttempt[];
}

export interface Branch {
  key: string;
  state: BranchState;
}

/** Попыток дня хранится несколько, но не все подряд: день, отправленный двадцать раз, не нужен. */
const MAX_ATTEMPTS = 10;

const isClock = (value: unknown): value is DraftClock =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DraftClock).counter === 'number' &&
  typeof (value as DraftClock).branch === 'string';

/**
 * Запись черновика в нынешней форме `DraftItem`: недостающее читается пустым, лишнее не смотрится.
 *
 * Нужен он не аккуратности ради. Ветка, записанная прежней сборкой, физически не содержит ключей,
 * добавленных позже: у записи до релиза топлива `fuelStartLiters` равен `undefined`, а разбор числа
 * доходит до `.trim()` и роняет блок при первой же перерисовке (план топлива, Н11). Дефолты
 * интерфейса от этого не спасают вовсе: `seedValues` подставляет запись черновика ЦЕЛИКОМ вместо
 * серверного значения, а не сливает её по полям, — заполнять пропуски там некому.
 *
 * Один нормализатор на оба входа хранилища: этот и `readLegacy` формата `v1`
 * ([draftStore.ts](draftStore.ts), Р11б). Второй, заведённый «по месту», разошёлся бы с первым на
 * следующем же добавленном поле — и разошёлся бы молча.
 *
 * Побочный эффект приведения безвреден и ожидаем: канонический вид старой ветки от него меняется,
 * `sameContent` признаёт её отличной от слияния, и консолидация один раз перепишет её полной
 * формой (Р11в). Дефект здесь только кажущийся — переписывание однократно и само себя гасит.
 */
export function normalizeItem(raw: unknown): DraftItem {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<DraftItem>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    odometerKm: text(item.odometerKm),
    engineHours: text(item.engineHours),
    // Топливо в порядке смены (ADR 0163) — тем же, что в форме и в остальных перечислениях.
    fuelStartLiters: text(item.fuelStartLiters),
    fuelFilledLiters: text(item.fuelFilledLiters),
    fuelEndLiters: text(item.fuelEndLiters),
    comment: text(item.comment),
    files: Array.isArray(item.files) ? item.files : [],
    confirmAnomaly: item.confirmAnomaly === true,
  };
}

/** Чужая или испорченная ячейка читается как «ветки нет»: угадывать её содержимое нечем. */
export function parseBranch(raw: string | null): BranchState | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const state = value as Partial<BranchState>;
  if (typeof state.savedAt !== 'number' || typeof state.entries !== 'object') return null;
  const entries: Record<string, DraftEntry> = {};
  for (const [key, entry] of Object.entries(state.entries ?? {})) {
    const parsed = entry as Partial<DraftEntry> | null;
    // Версия без часов сравнению не поддаётся: молча выбросить её честнее, чем выдать ей чужие.
    if (!parsed || !isClock(parsed.clock) || typeof parsed.savedAt !== 'number') continue;
    entries[key] = {
      clock: parsed.clock,
      savedAt: parsed.savedAt,
      /*
       * Форма записи приводится здесь — на границе доверия, — а не на выходе `readDraft`. Через
       * `parseBranch` ветка входит в портал целиком: её видят слияние, консолидация и страница, и
       * победившая версия уезжает обратно в хранилище копией. Приведи её только на выходе чтения —
       * и неполная запись всё равно осталась бы в слиянии, в консолидации и в сравнении содержимого,
       * то есть ровно там, где её потом никто не ищет.
       *
       * Отсутствующее `item` — это надгробие (Р11г), и нормализовать его нельзя: `null` обязан
       * остаться `null`, иначе удаление строки превратилось бы в пустое значение и воскресило её.
       */
      item: parsed.item == null ? null : normalizeItem(parsed.item),
    };
  }
  const attempts = (Array.isArray(state.attempts) ? state.attempts : []).filter(
    (attempt: Partial<SubmitAttempt> | null): attempt is SubmitAttempt =>
      !!attempt && typeof attempt.key === 'string' && isClock(attempt.clock),
  );
  const legacy = (Array.isArray(state.legacy) ? state.legacy : []).filter(
    (mark: unknown): mark is string => typeof mark === 'string',
  );
  return { savedAt: state.savedAt, entries, legacy, attempts };
}

/** Старше — больший счётчик; при равенстве — старшая ветка по строковому сравнению (Р11в). */
export function compareClocks(a: DraftClock, b: DraftClock): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0;
}

/**
 * Часы новой попытки — «наибольший виденный среди попыток плюс один», тем же счётом, что и у строк
 * (Р11в). Своей истории у попытки нет вовсе: ключ идемпотентности рождается вместе с ней, и
 * счётчик, взятый от предшественницы с тем же ключом, у всякой новой попытки равнялся бы единице.
 * Часы от этого вырождаются: все незавершённые попытки одинаковы, порядок между ними задаёт
 * устойчивость сортировки — то есть случайность, — и срез до десяти отрезает как раз новую. Дальше
 * отправка уходит, ответ теряется, а повторить её нечем: попытки в черновике нет (Р12а п. 1).
 */
export const nextAttemptClock = (
  attempts: readonly SubmitAttempt[],
  branch: string,
): DraftClock => ({
  counter: attempts.reduce((max, attempt) => Math.max(max, attempt.clock.counter), 0) + 1,
  branch,
});

/**
 * Порядок попыток — от новых к старым, и он полон: при равных часах разводит ключ. Полнота здесь
 * обязательна, а не аккуратна: на устойчивость сортировки опереться нечем — порядок на входе задаёт
 * обход веток, а тот идёт в порядке `localStorage`.
 */
const byClock = (a: SubmitAttempt, b: SubmitAttempt): number =>
  compareClocks(b.clock, a.clock) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Порядок и число попыток заданы жёстко: иначе консолидация переписывала бы ветку каждым чтением.
 *
 * Срез оставляет незавершённые раньше закрытых, и это не вкус. Потерянная незавершённая попытка —
 * это повтор новым ключом, то есть вторая отправка того же дня (Р12а п. 1). Потерянная закрытая
 * стоит несравнимо меньше: её копия из соседней ветки воскреснет незавершённой, и портал повторит
 * тем же ключом команду, ответ на которую уже получен, — сервер отобьёт повтор текущим состоянием.
 */
export function orderAttempts(attempts: readonly SubmitAttempt[]): SubmitAttempt[] {
  const ordered = [...attempts].sort(byClock);
  if (ordered.length <= MAX_ATTEMPTS) return ordered;
  const kept = new Set(
    [...ordered]
      .sort(
        (a, b) => Number(a.state !== 'pending') - Number(b.state !== 'pending') || byClock(a, b),
      )
      .slice(0, MAX_ATTEMPTS),
  );
  return ordered.filter((attempt) => kept.has(attempt));
}

/**
 * Слияние всех веток дня: строки — по логическим часам, журналы отпечатков — объединением
 * множеств, попытки — по ключу (старшие часы), физическая отметка — наибольшая из виденных.
 */
export function mergeBranches(branches: readonly Branch[]): BranchState {
  const entries: Record<string, DraftEntry> = {};
  const legacy = new Set<string>();
  const attempts = new Map<string, SubmitAttempt>();
  let savedAt = 0;
  for (const { state } of branches) {
    for (const [key, entry] of Object.entries(state.entries)) {
      const won = entries[key];
      if (!won || compareClocks(entry.clock, won.clock) > 0) entries[key] = entry;
    }
    for (const mark of state.legacy) legacy.add(mark);
    for (const attempt of state.attempts) {
      const won = attempts.get(attempt.key);
      if (!won || compareClocks(attempt.clock, won.clock) > 0) attempts.set(attempt.key, attempt);
    }
    savedAt = Math.max(savedAt, state.savedAt);
  }
  const ordered = orderAttempts([...attempts.values()]);
  return { savedAt, entries, legacy: [...legacy].sort(), attempts: ordered };
}

/** Пустое слияние: у дня нет ни строк, ни журнала, ни попыток — своей ветки он не заводит. */
export function isEmpty(state: BranchState): boolean {
  const { entries, legacy, attempts } = state;
  return legacy.length === 0 && attempts.length === 0 && Object.keys(entries).length === 0;
}

/** Содержимое без физической отметки: по нему консолидация решает, писать ветку или не трогать. */
export const sameContent = (a: BranchState, b: BranchState): boolean =>
  canonical([a.entries, a.legacy, a.attempts]) === canonical([b.entries, b.legacy, b.attempts]);

/** Порядок ключей в объекте задаёт не содержимое, а история правок: сериализуем по алфавиту. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

/**
 * Отпечаток содержимого. FNV-1a двумя семенами: шестьдесят четыре бита — цена того, что совпадение
 * отпечатков значит совпадение содержимого, а не удачу; хранить сами тела было бы дороже во
 * столько же раз.
 */
export function fingerprint(value: unknown): string {
  const text = canonical(value);
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x9dc5811c)}`;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
