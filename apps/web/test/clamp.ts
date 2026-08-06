/**
 * Подмена высот для свёрнутых ячеек (`ExpandableCell`).
 *
 * Переключатель у такой ячейки появляется, только если содержимое в неё не поместилось: замер
 * сравнивает `scrollHeight` с `clientHeight`. В jsdom раскладки нет вовсе — обе высоты нулевые, —
 * поэтому там не сворачивается никакой текст, и проверять в ячейке нечего. Подменённый
 * `scrollHeight` даёт замеру увидеть то, что не влезло.
 *
 * Подменяется прототип, а не отдельный узел: длинных ячеек в строке бывает несколько, и какая из
 * них достанется замеру, тест знать не должен. Высоты возвращает на место общий `afterEach`
 * (см. `setup.ts`) — так подмена не утекает в соседние тесты файла, которые о ней не просили.
 */

const NATIVE_SCROLL_HEIGHT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

let patched = false;

export function pretendContentOverflows(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 100,
  });
  patched = true;
}

export function restoreContentHeights(): void {
  if (!patched) return;
  patched = false;
  // Собственного `scrollHeight` у `HTMLElement.prototype` в jsdom может и не быть — свойство
  // объявлено выше по цепочке. Тогда восстанавливать нечего: подменённое просто снимается, иначе
  // геттер-заглушка пережил бы тест, который её ставил.
  if (NATIVE_SCROLL_HEIGHT) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', NATIVE_SCROLL_HEIGHT);
  } else {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
}
