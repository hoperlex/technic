/**
 * Набор отборов списка между сеансами (ADR 0139).
 *
 * Сотрудник работает не со списком вообще, а со своим срезом: оператор орг.техники живёт в
 * «Требуют решения» по своему объекту, снабженец — в истекающих гарантиях. Срез этот
 * выставляется заново после каждой перезагрузки, потому что отборы живут в `useState`
 * (`useListParams`), а он не переживает ни `F5`, ни уход в другой раздел, ни утренний вход.
 *
 * Хранилище браузера, а не куки: настройки экрана серверу не нужны, а кука уходила бы с каждым
 * запросом, стоила бы заботы о `SameSite` и сроке и упёрлась бы в 4 КБ на весь портал.
 *
 * Хранилище недоступно в приватном режиме части браузеров, и все три функции молча это переживают
 * — приём тот же, что у свёрнутости меню (`siderCollapsed`): отборы не данные пользователя, и
 * падать из-за них нельзя. Цена отказа — набор не переживёт перезагрузку; на этом всё.
 *
 * Ключ включает учётку. Браузер в конторе бывает общим, и портал это уже признаёт — при смене
 * пользователя чистится кэш запросов (`AuthContext`); подставить сменщику чужой срез значило бы
 * показать ему пустой список и не объяснить почему. При выходе набор не чистится: вернулся —
 * набор на месте.
 */

const KEY_PREFIX = 'technic:list-params:';

/**
 * Версия снимка. Поднимается, когда меняется смысл сохранённого, — снимки прежней версии при
 * чтении отбрасываются целиком.
 *
 * Дело не в аккуратности, а в отказе сервера: значения отборов уходят в запрос как есть, и
 * значение, выбывшее из перечня контрактов, сервер встретит четырёхсотым — то есть сломанным
 * списком, который человек не сможет починить, потому что причина лежит в хранилище.
 */
const SNAPSHOT_VERSION = 1;

/** Сколько живёт снимок. Отпуск и болезнь в срок укладываются, забытый год назад — нет. */
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Длина, за которой строка перестаёт быть отбором и становится чужим мусором в хранилище. */
const MAX_VALUE_LENGTH = 128;

/** Режим устройства: размер страницы у десктопа и телефона свой (ADR 0030). */
export type ListMode = 'desktop' | 'mobile';

/** Кому и для какого списка принадлежит набор. `userId` нет — не сохраняем и не читаем. */
export interface ListParamsScope {
  /** Имя списка в хранилище. Обязано пережить переименование файла: это ключ, а не заголовок. */
  scope: string;
  userId: string | undefined;
  /** Ключи отборов этого списка: сохраняются и восстанавливаются только они. */
  fields: readonly string[];
}

export interface ListParamsSnapshot {
  /** Только строки: отборы портала — значения выпадающих списков, `'true'` признаков и даты. */
  filters: Record<string, string>;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /**
   * Размер страницы, если он отличается от умолчания режима. Умолчание не сохраняется намеренно:
   * записанное число пережило бы правку самого умолчания и молча осталось бы прежним.
   */
  pageSize?: number;
  mode: ListMode;
}

interface StoredSnapshot {
  v: number;
  savedAt: number;
  filters: Record<string, string>;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /**
   * Размер страницы у каждого режима свой (ADR 0030), поэтому и хранится он по режимам, а не
   * одним числом с пометкой «выбрано на десктопе». С одним числом список, открытый с телефона,
   * стирал бы выбранные за столом 200 строк — и человек узнавал бы об этом на следующий день.
   */
  pageSize?: Partial<Record<ListMode, number>>;
}

function keyOf(scope: ListParamsScope): string | null {
  return scope.userId ? `${KEY_PREFIX}${scope.userId}:${scope.scope}` : null;
}

/** Снимок как объект — или `null`, если это не наша запись, не наша версия или она просрочена. */
function parse(raw: string | null): StoredSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Partial<StoredSnapshot>;
  if (stored.v !== SNAPSHOT_VERSION) return null;
  if (typeof stored.savedAt !== 'number' || Date.now() - stored.savedAt > TTL_MS) return null;
  return {
    v: SNAPSHOT_VERSION,
    savedAt: stored.savedAt,
    filters: typeof stored.filters === 'object' && stored.filters !== null ? stored.filters : {},
    sortBy: typeof stored.sortBy === 'string' ? stored.sortBy : undefined,
    sortOrder:
      stored.sortOrder === 'asc' || stored.sortOrder === 'desc' ? stored.sortOrder : undefined,
    pageSize: {
      desktop: pageSizeOf(stored.pageSize?.desktop),
      mobile: pageSizeOf(stored.pageSize?.mobile),
    },
  };
}

/** Размер страницы — целое положительное число или ничего: остальное набрано не нами. */
function pageSizeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Сохранённый набор списка. `mode` — режим, в котором список открывают **сейчас**: размер
 * страницы, выбранный на десктопе (200, 500), на телефоне означал бы бесконечную ленту, и там
 * берётся умолчание режима.
 *
 * Из снимка берутся только объявленные ключи и только строки: снимок мог быть записан прошлым
 * выпуском, где у списка был отбор, которого сегодня нет, а неизвестный ключ уехал бы в запрос.
 */
export function readListParams(
  scope: ListParamsScope,
  mode: ListMode,
): Omit<ListParamsSnapshot, 'mode'> | null {
  const key = keyOf(scope);
  if (!key) return null;
  let stored: StoredSnapshot | null = null;
  try {
    stored = parse(localStorage.getItem(key));
    // Мусор и просроченное сносим сразу: иначе запись живёт вечно, а чинить её некому.
    if (!stored) localStorage.removeItem(key);
  } catch {
    return null;
  }
  if (!stored) return null;

  const filters: Record<string, string> = {};
  for (const field of scope.fields) {
    const value = stored.filters[field];
    if (typeof value === 'string' && value && value.length <= MAX_VALUE_LENGTH) {
      filters[field] = value;
    }
  }
  return {
    filters,
    sortBy: stored.sortBy,
    // Порядок без поля сортировки — не порядок: умолчание вкладка считает сама.
    sortOrder: stored.sortBy ? stored.sortOrder : undefined,
    pageSize: stored.pageSize?.[mode],
  };
}

/** Пустой набор — не набор: хранить его значит копить записи о том, что человек ничего не выбрал. */
function isEmpty(stored: Omit<StoredSnapshot, 'v' | 'savedAt'>): boolean {
  return (
    Object.keys(stored.filters).length === 0 &&
    stored.sortBy === undefined &&
    stored.pageSize?.desktop === undefined &&
    stored.pageSize?.mobile === undefined
  );
}

/**
 * Записывается набор целиком, но размер страницы — только своего режима: соседний берётся из уже
 * записанного. Список открывают и за столом, и с телефона, и открытие с телефона не должно
 * отменять выбор, сделанный за столом.
 */
export function writeListParams(scope: ListParamsScope, snapshot: ListParamsSnapshot): void {
  const key = keyOf(scope);
  if (!key) return;
  try {
    const previous = parse(localStorage.getItem(key));
    const other: ListMode = snapshot.mode === 'desktop' ? 'mobile' : 'desktop';
    const next: Omit<StoredSnapshot, 'v' | 'savedAt'> = {
      filters: snapshot.filters,
      sortBy: snapshot.sortBy,
      sortOrder: snapshot.sortBy ? snapshot.sortOrder : undefined,
      pageSize: {
        [snapshot.mode]: snapshot.pageSize,
        [other]: previous?.pageSize?.[other],
      },
    };
    if (isEmpty(next)) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify({ v: SNAPSHOT_VERSION, savedAt: Date.now(), ...next }),
    );
    sweep();
  } catch {
    /* набор просто не переживёт перезагрузку */
  }
}

/**
 * Уборка чужих и просроченных наборов — на записи, как у черновиков водителя (`draftStore`).
 * Своего часа у фронта нет, а перебор десятка ключей стоит меньше, чем хранилище, которое
 * копит записи уволившихся.
 */
function sweep(): void {
  const doomed: string[] = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    if (!parse(localStorage.getItem(key))) doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
}
