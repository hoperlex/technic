/**
 * Сессия вкладки: access-токен и его обновление.
 *
 * Токен живёт только в памяти — не в cookie и не в хранилище: переход по ссылке уходит без
 * заголовка `Authorization`, и ссылка на защищённый маршрут всё равно не работала бы, а токен в
 * хранилище пережил бы вкладку.
 *
 * Всё остальное здесь — про одну проблему: обновление токена нельзя отменить. Запрос refresh уже
 * ушёл, и его ответ может вернуться, когда сессии, ради которой он делался, больше нет — человек
 * успел выйти, а за компьютер сел другой. Такой ответ не должен ни положить токен, ни объявить
 * сессию законченной: в первом случае следующий запрос уйдёт с чужим токеном, во втором — выкинет
 * уже нового пользователя. Поэтому у сессии есть номер, и каждый результат сверяется с ним.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

/** Чем кончилось обновление токена. */
export type RefreshOutcome =
  | { status: 'refreshed' }
  /** Сессия кончилась; `generation` — та, в которой это выяснилось. */
  | { status: 'expired'; generation: number }
  /** Ответ пришёл уже к другой сессии: ни применять его, ни объявлять о нём нельзя. */
  | { status: 'stale' };

/**
 * Ответ обновления токена. Учётка приходит в нём вместе с токеном (ADR 0106, этап 2): сервер
 * пересчитывает эффективные права на каждом обновлении, и после `authVersion + 1` они уже другие.
 *
 * Тип пользователя — `unknown`, и это не небрежность: `shared` не знает правил портала (в нём нет
 * `@technic/contracts`), а транспорту разбирать учётку и не нужно — он передаёт тело нетронутым
 * тому, кто знает его форму. Так же устроен и `apiFetch<T>`: тип называет вызывающий.
 *
 * `expiresIn` описан ради полноты контракта ручки и не читается: вкладка не обновляет токен по
 * расписанию, а идёт за ним на первом же 401 — иначе понадобился бы таймер, живущий дольше
 * запроса, который его завёл.
 */
interface RefreshResponse {
  accessToken: string;
  expiresIn?: number;
  user?: unknown;
}

let accessToken: string | null = null;
let generation = 0;
let refreshing: Promise<RefreshOutcome> | null = null;
let expiredHandlers: (() => void)[] = [];
let refreshedUserHandlers: ((user: unknown) => void)[] = [];

export function getToken(): string | null {
  return accessToken;
}

/** Номер текущей сессии; спрашивается перед запросом, чтобы потом сверить с ним ответ. */
export function currentGeneration(): number {
  return generation;
}

/**
 * Вход: началась новая сессия. Отдельно от продления намеренно — продление не меняет номер, а
 * вход меняет: иначе висящее обновление прежнего пользователя считалось бы своим.
 */
export function startSession(token: string): void {
  generation += 1;
  refreshing = null;
  accessToken = token;
}

/**
 * Продлить текущую сессию новым токеном — например, после смены пароля: пользователь тот же,
 * сессия та же, номер не меняется. Отдельно от `startSession`, чтобы «продлили свою» и «вошёл
 * другой» нельзя было перепутать одним вызовом.
 */
export function renewToken(token: string): void {
  accessToken = token;
}

/**
 * Обрыв сессии: токен забыт, висящее обновление обесценено. Подписчиков НЕ уведомляет — тот, кто
 * слушает истечение, сам зовёт `clear()` в обработчике, и уведомляющий `clear()` замкнул бы вызов
 * в кольцо.
 */
export function clear(): void {
  generation += 1;
  refreshing = null;
  accessToken = null;
}

/**
 * Объявить сессию законченной, если она всё ещё та самая. Возвращает, сработало ли: `false`
 * означает, что за время запроса сессия успела смениться, и сообщать не о чем.
 */
export function expireIfCurrent(expected: number): boolean {
  if (expected !== generation) return false;
  accessToken = null;
  for (const handler of expiredHandlers) handler();
  return true;
}

/** Подписка на конец сессии; возвращает функцию отписки. */
export function onExpired(handler: () => void): () => void {
  expiredHandlers = [...expiredHandlers, handler];
  return () => {
    expiredHandlers = expiredHandlers.filter((h) => h !== handler);
  };
}

/**
 * Подписка на учётку, пришедшую с новым токеном; возвращает функцию отписки.
 *
 * Подписка, а не поле в `RefreshOutcome`, — по тому же устройству, по которому здесь живёт
 * `onExpired`. Обновление дёргает слой HTTP на 401, посреди работы человека, и результат ему нужен
 * ровно один: удалось или нет. Вернуть учётку значением означало бы протаскивать её через каждого,
 * кто зовёт `refresh` (транспорт, bootstrap), и каждый обязан был бы не забыть её передать дальше —
 * а забывший тихо оставлял бы интерфейс с прежними правами. Подписка вдобавок бесплатно получает
 * сверку сессии: уведомление уходит только из своего поколения, и ответ, вернувшийся уже к другому
 * пользователю, до подписчиков не доходит.
 */
export function onRefreshedUser(handler: (user: unknown) => void): () => void {
  refreshedUserHandlers = [...refreshedUserHandlers, handler];
  return () => {
    refreshedUserHandlers = refreshedUserHandlers.filter((h) => h !== handler);
  };
}

/**
 * Обмен refresh-cookie на новый access-токен. Одна попытка на несколько параллельных 401: второй
 * запрос дожидается того же обещания, иначе сервер увидел бы повторное использование refresh и
 * отозвал бы сессию целиком.
 */
export async function refresh(): Promise<RefreshOutcome> {
  if (refreshing) return refreshing;

  const startedAt = generation;
  /** Ответ пришёл к другой сессии — его результат не наш. */
  const stale = () => startedAt !== generation;

  refreshing = fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res): Promise<RefreshOutcome> => {
      if (stale()) return { status: 'stale' };
      if (!res.ok) {
        accessToken = null;
        return { status: 'expired', generation: startedAt };
      }
      const data = (await res.json()) as RefreshResponse;
      if (stale()) return { status: 'stale' };
      accessToken = data.accessToken;
      /*
       * Учётка из ответа применяется, а не выбрасывается. Права считает сервер, и обновление —
       * единственное место, где он сообщает их посреди работы: после `authVersion + 1` он проверяет
       * запросы уже по новому набору, а меню и кнопки остались бы прежними до перезагрузки
       * страницы. Проверка здесь — минимум, доступный транспорту без знания домена: тело либо
       * объект, либо ручка учётку не прислала (так отвечают старые сборки API и тесты, которым
       * пользователь в ответе не нужен).
       */
      if (typeof data.user === 'object' && data.user !== null) {
        for (const handler of refreshedUserHandlers) handler(data.user);
      }
      return { status: 'refreshed' };
    })
    .catch((): RefreshOutcome => {
      if (stale()) return { status: 'stale' };
      accessToken = null;
      return { status: 'expired', generation: startedAt };
    })
    .finally(() => {
      // Только своё: за время запроса сессию могли оборвать и начать обновление заново.
      if (!stale()) refreshing = null;
    });

  return refreshing;
}

/** Тестам: вернуть модуль в состояние «на вкладку ещё никто не входил». */
export function __resetSessionForTests(): void {
  accessToken = null;
  generation = 0;
  refreshing = null;
  expiredHandlers = [];
  refreshedUserHandlers = [];
}
