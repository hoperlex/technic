import { useEffect, useSyncExternalStore } from 'react';

/**
 * Мобильный режим — свойство устройства, а не ширины окна (ADR 0030): узкое окно на десктопе
 * остаётся десктопом, потому что мышь исключена условием. Граница 1024 включительная — iPad
 * 768×1024 мобилен и в ландшафте, а телефон в ландшафте (844 px) не получает десктопную таблицу.
 *
 * Выражение здесь единственное на весь портал: стили опираются на класс `is-mobile`, а не на
 * собственную копию медиазапроса — копия разошлась бы с этой молча.
 */
export const MOBILE_QUERY = '(hover: none) and (pointer: coarse) and (max-width: 1024px)';

/** Класс мобильного режима: вешается на <html>, потому что модалки antd рендерятся вне #root. */
export const MOBILE_ROOT_CLASS = 'is-mobile';

// Подписка на медиазапрос одна на приложение: MediaQueryList создаётся лениво и живёт столько же,
// сколько вкладка, а компоненты добавляют и снимают только свои колбэки.
const listeners = new Set<() => void>();
let mql: MediaQueryList | null = null;
let bound = false;

function media(): MediaQueryList | null {
  if (!mql && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia(MOBILE_QUERY);
  }
  return mql;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  const m = media();
  if (!m) return () => {};
  if (!bound) {
    m.addEventListener('change', notify);
    bound = true;
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** Снимок читается с самого MediaQueryList — своя копия значения рассинхронизировалась бы. */
function getSnapshot(): boolean {
  return media()?.matches ?? false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Держит класс мобильного режима на <html>. Вызывается один раз в корне приложения: стилям нужен
 * признак режима там, куда React не дотягивается, — в порталах модалок и выпадающих списков.
 */
export function useMobileRootClass(isMobile: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(MOBILE_ROOT_CLASS, isMobile);
    return () => root.classList.remove(MOBILE_ROOT_CLASS);
  }, [isMobile]);
}
