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

import { clientRequestHeaders } from './clientContract';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

/** How a token refresh ended. */
export type RefreshOutcome =
  | { status: 'refreshed' }
  /** The session ended; `generation` is the one in which that came out. */
  | { status: 'expired'; generation: number }
  /**
   * The server gave no verdict: the proxy or the API answered 502/503/504, or nothing answered at
   * all. The session stays as it was, because the refresh cookie is still valid: the API keeps it
   * on such failures (ADR 0233), and ending the session here logged people out on every page reload
   * during a failover.
   */
  | { status: 'unavailable' }
  /** The answer came to another session: it may be neither applied nor announced. */
  | { status: 'stale' };

/**
 * Statuses of a server that is there but cannot answer now: nginx without a live API (502), the
 * API without a database (503 `db_unavailable`), nginx giving up on the API (504). A 500 is not one
 * of them: that is a bug, and repeating would not cure it.
 */
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function isServerUnreachableStatus(status: number): boolean {
  return UNREACHABLE_STATUSES.has(status);
}

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
 * Exchange of the refresh cookie for a new access token. One attempt for several parallel 401s: the
 * second request waits for the same promise, otherwise the server would see the refresh reused and
 * revoke the whole session.
 */
export async function refresh(): Promise<RefreshOutcome> {
  if (refreshing) return refreshing;

  const startedAt = generation;
  /** The answer came to another session: its result is not ours. */
  const stale = () => startedAt !== generation;

  /*
   * Client version headers are set here too, not only in the transport: this `fetch` bypasses
   * `http.ts`, and without them the server would see the refresh as a request from an unknown build.
   * The `/auth/refresh` route itself is exempt from the gate for good (ADR 0146, decision 7):
   * otherwise its refusal would land in the `!res.ok` branch below and read as the end of the
   * session, so the gate would log live people out. The headers still go: diagnostics in the server
   * log are needed here too, and "exempt" does not mean "anonymous".
   */
  refreshing = fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: clientRequestHeaders(),
  })
    .then(
      async (res): Promise<RefreshOutcome> => {
        if (stale()) return { status: 'stale' };
        if (isServerUnreachableStatus(res.status)) return { status: 'unavailable' };
        if (!res.ok) {
          accessToken = null;
          return { status: 'expired', generation: startedAt };
        }
        const data = (await res.json()) as RefreshResponse;
        if (stale()) return { status: 'stale' };
        accessToken = data.accessToken;
        /*
         * The account in the answer is applied, not thrown away. The server computes permissions,
         * and a refresh is the only place it reports them mid-work: after `authVersion + 1` it
         * already checks requests against the new set, while the menu and buttons would stay as
         * they were until a reload. The check here is the minimum a transport can do without
         * knowing the domain: the body is an object, or the route sent no account (old API builds
         * and tests that need no user answer so).
         */
        if (typeof data.user === 'object' && data.user !== null) {
          for (const handler of refreshedUserHandlers) handler(data.user);
        }
        return { status: 'refreshed' };
      },
      /*
       * No answer at all: the network or the proxy dropped the request. Kept apart from the
       * `catch` below, which takes a broken answer: that one still ends the session, because a
       * server that answers but cannot be read will not be cured by waiting.
       */
      (): RefreshOutcome => (stale() ? { status: 'stale' } : { status: 'unavailable' }),
    )
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
