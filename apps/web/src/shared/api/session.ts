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

let accessToken: string | null = null;
let generation = 0;
let refreshing: Promise<RefreshOutcome> | null = null;
let expiredHandlers: (() => void)[] = [];

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
      const data = (await res.json()) as { accessToken: string };
      if (stale()) return { status: 'stale' };
      accessToken = data.accessToken;
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
}
