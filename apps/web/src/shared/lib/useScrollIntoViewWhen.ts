import { useEffect, useRef } from 'react';

/**
 * Проматывание к узлу, когда условие стало верным: окно открыли на конкретном блоке, список
 * показал строку с замечанием. Возвращает ref — его вешают на тот узел, к которому едут.
 *
 * ОТСРОЧКА НЕ УКРАШЕНИЕ. Содержимое окна монтируется до конца анимации, и прокрутка без неё
 * уезжает в ещё не разложенную высоту — тем же приёмом ходит форма показаний водителя.
 *
 * `scrollIntoView` зовётся через `?.`: в тестовой среде метода у узла нет вовсе.
 */
const SCROLL_DELAY_MS = 300;

export function useScrollIntoViewWhen<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  /** Что считать новым поводом проехать: открыли окно на другой записи — едем снова. */
  key?: string | null,
) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(
      () => ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }),
      SCROLL_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [active, key]);
  return ref;
}
