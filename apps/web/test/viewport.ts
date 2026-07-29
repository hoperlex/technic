/**
 * Управляемый `matchMedia` для тестов: jsdom его не реализует, а опираются на него двое — antd
 * (брейкпоинты сетки и адаптивные компоненты) и сам портал (режим устройства, ADR 0030).
 * Прежняя заглушка отвечала `matches: false` на любой запрос, поэтому мобильный режим было
 * нечем включить, а antd считал, что не подходит ни один брейкпоинт.
 *
 * Здесь на каждый запрос заводится собственный `MediaQueryList` и живёт до конца прогона: смена
 * вьюпорта пересчитывает `matches` у всех заведённых и будит подписчиков тех, у кого значение
 * изменилось. Поэтому mobile → desktop переключается прямо в тесте, без переимпорта модулей.
 */

export interface Viewport {
  width: number;
  /** Тип указателя: `fine` — мышь, `coarse` — палец. Из него же выводится `hover`. */
  pointer: 'fine' | 'coarse';
}

export const DESKTOP_VIEWPORT: Viewport = { width: 1440, pointer: 'fine' };
export const MOBILE_VIEWPORT: Viewport = { width: 390, pointer: 'coarse' };

let current: Viewport = DESKTOP_VIEWPORT;

/** Поддержаны те признаки, которыми пользуются antd и портал; остальные считаются неподходящими. */
function matchesFeature(feature: string, value: string): boolean {
  const px = Number.parseFloat(value);
  switch (feature) {
    case 'min-width':
      return current.width >= px;
    case 'max-width':
      return current.width <= px;
    case 'width':
      return current.width === px;
    case 'pointer':
    case 'any-pointer':
      return value === current.pointer;
    case 'hover':
    case 'any-hover':
      return value === (current.pointer === 'fine' ? 'hover' : 'none');
    default:
      return false;
  }
}

/** Запятая — «или», ` and ` — «и», условие — `(признак: значение)`. Больше синтаксиса не нужно. */
function evaluate(query: string): boolean {
  return query.split(',').some((group) =>
    group
      .trim()
      .split(' and ')
      .every((raw) => {
        const parsed = /^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/.exec(raw.trim());
        const [, feature, value] = parsed ?? [];
        return feature && value ? matchesFeature(feature, value) : false;
      }),
  );
}

interface Entry {
  mql: MediaQueryList;
  listeners: Set<(event: MediaQueryListEvent) => void>;
}

const registry = new Map<string, Entry>();

function entryFor(query: string): Entry {
  const existing = registry.get(query);
  if (existing) return existing;

  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  // `matches` — геттер: значение всегда считается по текущему вьюпорту, и своей копии, способной
  // разойтись с ним, ни у кого нет. Событие остаётся только средством разбудить подписчиков.
  const mql = {
    get media() {
      return query;
    },
    get matches() {
      return evaluate(query);
    },
    onchange: null,
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(listener);
    },
    // Устаревшая пара: часть библиотек всё ещё подписывается через неё.
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;

  const entry: Entry = { mql, listeners };
  registry.set(query, entry);
  return entry;
}

export function installMatchMedia(): void {
  window.matchMedia = (query: string) => entryFor(query).mql;
}

/** Меняет вьюпорт и уведомляет подписчиков тех запросов, у которых изменился результат. */
export function setViewport(next: Viewport): void {
  const before = new Map([...registry].map(([query, entry]) => [query, entry.mql.matches]));
  current = next;
  window.innerWidth = next.width;

  for (const [query, entry] of registry) {
    const matches = entry.mql.matches;
    if (matches === before.get(query)) continue;
    const event = { matches, media: query } as MediaQueryListEvent;
    for (const listener of entry.listeners) listener(event);
  }
}

/** Между тестами вьюпорт всегда десктопный: существующий набор проверяет именно десктоп. */
export function resetViewport(): void {
  setViewport(DESKTOP_VIEWPORT);
}
