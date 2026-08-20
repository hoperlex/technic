/**
 * Оснастка тестов страниц с капчей: регистрация, «Забыли пароль?», подтверждение адреса
 * (план `docs/smart-captcha-plan.md` §5 и §12).
 *
 * Одним файлом, а не тремя копиями в тестах страниц: подделывается здесь чужая служба — скрипт
 * `captcha.js` Яндекса, которого в jsdom не бывает вовсе, — и три её копии разошлись бы при первой
 * же правке виджета, продолжая при этом «проходить»: каждая проверяла бы свою выдумку.
 *
 * Что подделывается:
 *
 * - **Загрузка скрипта.** jsdom внешние скрипты не грузит и об этом даже не сообщает: тег в
 *   документе появляется, а `onload`/`onerror` не приходят никогда. Поэтому «приезд» скрипта
 *   разыгрывает `appear()` — ставит `window.smartCaptcha` и зовёт колбэк готовности ровно так, как
 *   это делает настоящий `captcha.js`. Заодно тест видит сам тег: страницы, которым капча не
 *   нужна, обязаны обходиться без него, и проверяется это его отсутствием в документе.
 * - **Полная навигация.** `window.location.assign` в jsdom не реализован и шумит на весь вывод;
 *   подменяется здесь весь объект `location` — иначе не выйдет: свойства у него неперезаписываемые,
 *   и `vi.spyOn` на `assign` падает с «Cannot redefine property».
 *
 * Всё это переживает размонтирование дерева (глобальные объекты, теги в `head`, кеши модулей),
 * поэтому снимается общим хуком в `test/setup.ts` — см. `resetCaptcha()` в конце файла.
 */
import { act, waitFor } from '@testing-library/react';
import { expect, vi, type Mock } from 'vitest';
import { json, type MockResponse, type RouteHandler } from './http';
import { __resetCaptchaScriptForTests } from '../src/components/CaptchaField';
import { __resetCaptchaConfigForTests } from '../src/components/useCaptcha';

/** Хост, с которого портал тянет виджет: по нему тесты и узнают чужой скрипт в документе. */
const SCRIPT_HOST = 'smartcaptcha.cloud.yandex.ru';

/**
 * Теги скрипта Яндекса в документе. Пустой список — сторонний код в документ не попал: это
 * утверждение проверяют страницы при выключенной капче, при неизвестной сессии и у вошедшей
 * вкладки (§12).
 */
export function captchaScriptTags(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script')].filter((tag) =>
    tag.src.includes(SCRIPT_HOST),
  );
}

/** Ответ `GET /auth/captcha`: ключ виджета или `null` — единственный признак «капча выключена». */
export const captchaConfig = (clientKey: string | null): MockResponse => json({ clientKey });

/**
 * Ответ без поля `clientKey`: старый API во время выката, чужой прокси, обрезанный JSON. Для
 * портала это ошибка, а не «капча выключена» (§5) — на этом различии и держится вся проверка.
 */
export const captchaConfigWithoutKey = (): MockResponse => json({});

/** Ручка не ответила вовсе: сеть моргнула, сервер лежит. */
export function captchaConfigUnreachable(): never {
  throw new Error('сеть недоступна');
}

/**
 * Ответ, который тест отпускает сам. Нужен состояниям «ещё не ответили»: подставить готовое
 * состояние вместо задержки значило бы убрать из теста ровно то, что он проверяет, — промежуток,
 * пока портал ещё не знает ответа.
 */
export interface HeldResponse {
  /** Обработчик маршрута: висит, пока тест не отпустит. */
  handler: RouteHandler;
  /** Отпустить ответ и дать порталу его обработать. */
  release: () => Promise<void>;
}

export function heldResponse(response: () => MockResponse): HeldResponse {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    handler: async () => {
      await held;
      return response();
    },
    release: async () => {
      release();
      // Ответ разобран и состояние применено — иначе тест продолжился бы раньше портала.
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

/** Тип службы Яндекса берётся из объявления `CaptchaField`: своя копия разошлась бы с ней молча. */
type SmartCaptchaApi = NonNullable<Window['smartCaptcha']>;

/** События виджета, которыми он разговаривает с формой. */
type WidgetEvent = 'success' | 'token-expired' | 'network-error' | 'javascript-error';

export interface SmartCaptchaService {
  /**
   * Ключи, с которыми рисовали виджет. По ним видно главное: портал взял ключ у собственной ручки,
   * а не вшил его в сборку.
   */
  readonly sitekeys: string[];
  /** Сброс виджета — им форма гасит потраченный одноразовый токен. */
  readonly reset: Mock;
  /** Снятие виджета: без него при следующем монтировании в контейнере оказалось бы два чекбокса. */
  readonly destroy: Mock;
  /** Дождаться тега скрипта, «загрузить» его и дождаться нарисованного чекбокса. */
  appear: () => Promise<void>;
  /** Человек прошёл проверку: виджет отдаёт форме одноразовый токен. */
  check: (token: string) => Promise<void>;
  /**
   * Событие виджета без токена: токен истёк, пропала связь, сломался сам виджет. Ни одно из них
   * проверку пройденной не делает.
   */
  emit: (event: Exclude<WidgetEvent, 'success'>) => Promise<void>;
}

/**
 * Поддельная служба SmartCaptcha на один тест. Ставится в документ не сразу: пока портал не
 * вставил тег скрипта, объекта `window.smartCaptcha` нет — как не бывает его и в браузере до
 * загрузки `captcha.js`. Иначе проверка «скрипта в документе нет» ничего не значила бы: код,
 * взявшийся грузить его без нужды, находил бы готовую службу и молчал.
 */
export function smartCaptchaService(): SmartCaptchaService {
  const sitekeys: string[] = [];
  /** Подписки виджета: ключ — «идентификатор виджета:событие». */
  const handlers = new Map<string, Set<(token: string) => void>>();
  /** Чекбоксы, нарисованные в контейнерах: снимать их при `destroy` — забота самой службы. */
  const nodes = new Map<number, HTMLElement>();
  let lastWidgetId = 0;

  const reset = vi.fn();
  const destroy = vi.fn((widgetId?: number) => {
    if (widgetId === undefined) return;
    nodes.get(widgetId)?.remove();
    nodes.delete(widgetId);
  });

  const api: SmartCaptchaApi = {
    render(container, params) {
      lastWidgetId += 1;
      sitekeys.push(params.sitekey);
      // Настоящий виджет рисует чекбокс сам, вне React; тесту он нужен как признак «виджет на
      // месте» — по нему же видно, что контейнер портала React не перерисовывает.
      const checkbox = document.createElement('div');
      checkbox.dataset.testid = 'smartcaptcha';
      checkbox.textContent = 'Я не робот';
      container.append(checkbox);
      nodes.set(lastWidgetId, checkbox);
      return lastWidgetId;
    },
    subscribe(widgetId: number, event: WidgetEvent, handler: (token: string) => void) {
      const key = `${widgetId}:${event}`;
      const set = handlers.get(key) ?? new Set();
      set.add(handler);
      handlers.set(key, set);
      return () => set.delete(handler);
    },
    reset,
    destroy,
  };

  async function fire(event: WidgetEvent, token: string): Promise<void> {
    const listeners = handlers.get(`${lastWidgetId}:${event}`);
    if (!listeners || listeners.size === 0) {
      throw new Error(
        `Виджет капчи не подписан на «${event}»: он ещё не нарисован — сначала дождитесь appear().`,
      );
    }
    await act(async () => {
      for (const listener of [...listeners]) listener(token);
      await Promise.resolve();
    });
  }

  return {
    get sitekeys() {
      return [...sitekeys];
    },
    reset,
    destroy,
    async appear() {
      await waitFor(() => expect(captchaScriptTags()).toHaveLength(1));
      // Тот же порядок, что у настоящего скрипта: сначала появляется объект службы, потом
      // вызывается колбэк готовности, имя которого стоит в query самого тега.
      await act(async () => {
        window.smartCaptcha = api;
        window.onSmartCaptchaLoaded?.();
        await Promise.resolve();
      });
      await waitFor(() => expect(sitekeys.length).toBeGreaterThan(0));
    },
    check: (token) => fire('success', token),
    emit: (event) => fire(event, ''),
  };
}

export interface NavigationLog {
  /** Адреса, по которым портал уводил вкладку целиком (`window.location.assign`). */
  readonly to: string[];
}

/** Настоящий `location`, снятый перед первой подменой; возвращается в `resetCaptcha()`. */
let realLocation: Location | null = null;

/**
 * Следить за полной навигацией. Подменяется весь `location`, а не метод: свойства объекта
 * неперезаписываемы (`vi.spyOn(window.location, 'assign')` падает с «Cannot redefine property»), а
 * настоящий `assign` в jsdom не реализован и шумит на весь вывод прогона.
 *
 * Остальные поля копируются как есть: по `origin` мок сети собирает адреса запросов.
 */
export function trackNavigation(): NavigationLog {
  const to: string[] = [];
  realLocation ??= window.location;
  const stub = {
    ...realLocation,
    assign: (url: string) => {
      to.push(url);
    },
    replace: (url: string) => {
      to.push(url);
    },
  };
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: stub });
  return { to };
}

/**
 * Нажать и узнать, ушёл бы браузер сам. Так различаются полная навигация и SPA-переход: `Link`
 * react-router гасит событие (`preventDefault`) и оставляет документ жить, а обычная ссылка —
 * нет. Именно это требование §12: документ со сторонним `captcha.js` обязан умереть до того, как
 * человек наберёт логин и пароль.
 *
 * Событие гасится последним обработчиком, уже после React: иначе jsdom попытался бы уйти по
 * адресу и завалил бы вывод сообщениями «Not implemented: navigation».
 */
export function clickLeavesDocument(element: HTMLElement): boolean {
  let preventedBySpa = true;
  const guard = (event: Event) => {
    preventedBySpa = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', guard);
  element.click();
  document.removeEventListener('click', guard);
  return !preventedBySpa;
}

/**
 * Вернуть всё, что капча оставляет за собой, в исходное состояние. Зовётся из `test/setup.ts`
 * после каждого теста: ни кеши модулей (ключ на вкладку, промис скрипта), ни объекты службы, ни
 * теги в `head` размонтированием дерева не убираются — второй тест файла начинал бы с чужой
 * капчи, и падал бы он, а не тот, кто её оставил.
 */
export function resetCaptcha(): void {
  __resetCaptchaConfigForTests();
  __resetCaptchaScriptForTests();
  delete window.smartCaptcha;
  delete window.onSmartCaptchaLoaded;
  for (const tag of captchaScriptTags()) tag.remove();
  if (realLocation) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: realLocation,
    });
    realLocation = null;
  }
}
