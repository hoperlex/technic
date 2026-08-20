import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { CaptchaConfig } from '@technic/contracts';
import { authApi } from '../api/auth';
import { useAuth } from '../auth/AuthContext';

/**
 * Состояние капчи для формы (план `docs/smart-captcha-plan.md` §5).
 *
 * Состояний именно четыре, а не два («ключ есть» / «ключа нет»): между «капча выключена» и «портал
 * не знает, включена ли она» лежит вся разница в поведении формы. При `disabled` заявка уходит с
 * пустым токеном, при `error` — не уходит вовсе: не получив внятного ответа собственной ручки,
 * портал не знает, требуется ли токен, и угадывать здесь нельзя. `loading` держит форму
 * заблокированной по той же причине, только временно.
 *
 * Тип — размеченное объединение, чтобы `clientKey` существовал ровно там, где он осмыслен:
 * проверив `status === 'enabled'`, вызывающий получает `string`, а не `string | null`, и ветки
 * «ключа нет, но виджет рисуем» в коде не заводится.
 */
export type CaptchaState =
  | {
      /**
       * `loading` — конфиг ещё не получен **или** ещё не известна сессия вкладки;
       * `disabled` — сервер прислал `clientKey: null`, капча выключена;
       * `error` — ручка не ответила или ответила не тем.
       */
      status: 'loading' | 'disabled' | 'error';
      clientKey: null;
      retry: () => void;
    }
  | {
      status: 'enabled';
      /** Клиентский ключ виджета (`ysc1_…`). */
      clientKey: string;
      retry: () => void;
    };

/**
 * Ответ `GET /auth/captcha` на вкладку — один: за ключом сходят до трёх форм (регистрация,
 * восстановление пароля, повторное письмо), и ключ у них общий. Промис-синглтон заодно склеивает
 * двойное монтирование React StrictMode.
 *
 * **Сбрасывается при reject** — это не оптимизация, а условие живучести: закешированный отказ
 * держал бы вкладку в состоянии `error` до перезагрузки страницы, хотя сеть моргнула на секунду,
 * а кнопка «Повторить» рядом с полем честно ходила бы в тот же мёртвый кеш.
 */
let configPromise: Promise<CaptchaConfig> | null = null;

function loadConfig(): Promise<CaptchaConfig> {
  if (!configPromise) {
    configPromise = authApi.captcha().catch((error: unknown) => {
      configPromise = null;
      throw error;
    });
  }
  return configPromise;
}

/** Тестам: вернуть модуль в состояние «за ключом на этой вкладке ещё не ходили». */
export function __resetCaptchaConfigForTests(): void {
  configPromise = null;
  inFlight = false;
  current = { status: 'loading', clientKey: null };
}

/**
 * Разбор ответа ручки. Тип `CaptchaConfig` описывает договор, а не то, что реально пришло по
 * сети, поэтому поле проверяется на месте.
 *
 * **`null` и «поля нет» — разные вещи.** Капча считается выключенной, только если `clientKey` в
 * ответе **присутствует** и равен `null`. Ответ без этого поля — старый API во время выката, чужой
 * прокси, обрезанный JSON — это ошибка, а не «выключено»: иначе новый веб на старом API молча
 * отправлял бы формы без капчи, и незакрытая форма выглядела бы исправной.
 */
function readClientKey(config: CaptchaConfig): string | null {
  const raw: unknown = config;
  if (typeof raw !== 'object' || raw === null || !('clientKey' in raw)) {
    throw new Error('Ответ /auth/captcha без поля clientKey');
  }
  const key: unknown = (raw as { clientKey: unknown }).clientKey;
  if (key === null) return null;
  // Пустая строка ключом быть не может, а «выключено» обозначает только `null`: принять её значило
  // бы отрисовать виджет с заведомо нерабочим sitekey.
  if (typeof key !== 'string' || key === '') {
    throw new Error('Ответ /auth/captcha с непонятным clientKey');
  }
  return key;
}

/** То же объединение без `retry`: функция повтора живёт в хуке и в состоянии не хранится. */
type Resolved =
  | { status: 'loading' | 'disabled' | 'error'; clientKey: null }
  | { status: 'enabled'; clientKey: string };

/**
 * Состояние — модульное и общее, а не своё у каждого вызова хука. Причина не в экономии запроса:
 * хук зовут ДВА места одной страницы — сама форма (ей нужно знать, ставить ли правило и пускать ли
 * отправку) и поле капчи (ему — рисовать ли виджет). С состоянием внутри `useState` это два
 * независимых экземпляра, и «Повторить» у поля поднимала бы из `error` только поле: виджет
 * появлялся бы, а форма оставалась заблокированной навсегда — до перезагрузки страницы. Общее
 * состояние делает кнопку тем, чем она выглядит.
 */
let current: Resolved = { status: 'loading', clientKey: null };
const listeners = new Set<() => void>();

function setResolved(next: Resolved): void {
  current = next;
  for (const notify of listeners) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Запрос уже в пути: второй вызов хука не должен начинать его заново. */
let inFlight = false;

/**
 * Загрузить настройку и разложить её по состояниям. Вызывается из эффекта и из `retry`.
 *
 * @param session — статус сессии вкладки; при неизвестном и при вошедшем за ключом не ходим (§12).
 */
async function refresh(session: 'loading' | 'authenticated' | 'unauthenticated'): Promise<void> {
  /*
   * Инвариант против гонки с сессией (§5, §12). `AuthProvider` стартует в статусе `loading` и
   * узнаёт про вкладку асинхронно, а публичный маршрут монтируется сразу — поэтому, пока статус
   * неизвестен, за конфигом не ходим и тега скрипта в документ не вставляем. Иначе сторонний
   * скрипт успевал бы загрузиться в документ, который через мгновение окажется авторизованным.
   *
   * Вошедшему капча не нужна вовсе: страницы с ней сами уводят такую вкладку в портал полной
   * навигацией. Остаёмся в `loading` — единственное состояние, которое ничего не утверждает про
   * капчу и держит форму заблокированной те доли секунды, что живёт документ.
   */
  if (session !== 'unauthenticated') {
    setResolved({ status: 'loading', clientKey: null });
    return;
  }
  if (inFlight) return;
  inFlight = true;
  setResolved({ status: 'loading', clientKey: null });
  try {
    const key = readClientKey(await loadConfig());
    setResolved(
      key === null
        ? { status: 'disabled', clientKey: null }
        : { status: 'enabled', clientKey: key },
    );
  } catch {
    // Сюда приходят и сетевой отказ, и ответ не той формы: для формы это один случай — портал не
    // знает, нужен ли токен, и отправку блокирует.
    setResolved({ status: 'error', clientKey: null });
  } finally {
    inFlight = false;
  }
}

/**
 * Настройка капчи для формы: спрашивает у портала клиентский ключ и переводит ответ в одно из
 * четырёх состояний. Скрипт Яндекса хук не грузит — это дело `CaptchaField`, которому хук говорит,
 * можно ли вообще к нему приступать.
 */
export function useCaptcha(): CaptchaState {
  const { status: session } = useAuth();
  const resolved = useSyncExternalStore(subscribe, () => current);

  useEffect(() => {
    void refresh(session);
  }, [session]);

  /**
   * Повторная попытка после `error`. Кеш модуля сбрасывается явно: отказ в него не попадает, но
   * попытка могла прийтись на уже разрешившийся промис чужого, неудачного разбора — «Повторить»
   * обязана означать новый запрос, а не второе чтение того же ответа.
   */
  const retry = useCallback(() => {
    configPromise = null;
    void refresh(session);
  }, [session]);

  return { ...resolved, retry };
}
