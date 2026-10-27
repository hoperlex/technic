import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { canUse as scopedCanUse, type AuthUser, type Permission } from '@technic/contracts';
import { accessFingerprint } from './accessFingerprint';
import { authApi } from '../api/authApi';
import {
  clear as clearSession,
  isApiError,
  isServerUnreachableStatus,
  MAINTENANCE_MODE_CODE,
  onExpired,
  onRefreshedUser,
  refresh,
} from '@shared/api';

type Status = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthUser | null;
  status: Status;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (u: AuthUser) => void;
  refreshUser: () => Promise<void>;
  /**
   * Есть ли у текущего пользователя право — по списку, который посчитал и отдал сервер
   * (`AuthUser.permissions`, ADR 0106).
   *
   * Раньше здесь стояла общая матрица (ADR 0021): пока набор прав задавала роль, портал выводил
   * права сам, и оба ответа — свой и серверный — совпадали по построению. Со свободной сборкой
   * полномочий это перестало быть верным: состав набора живёт в базе (`grant_permissions`) и
   * заводится в проде, матрица его не знает и знать не должна — иначе она перестала бы быть данными
   * и начала зависеть от таблиц. Вывести права из роли клиент больше **не может**, поэтому он их
   * спрашивает: список приходит во всех четырёх ответах сессии.
   *
   * Интерфейс по-прежнему только скрывает недоступное: решение по запросу принимает сервер, на своём
   * субъекте. Список управляет ровно тем, что человек видит.
   */
  can: (permission: Permission) => boolean;
  /**
   * Открыт ли раздел (ADR 0062): право **и** непустая область, в которой оно применимо. Спрашивают
   * там, где решается «показывать ли раздел» — меню, маршруты, стартовая страница; действия внутри
   * раздела спрашивают `can`, потому что пустой область к тому моменту уже не бывает.
   */
  canUse: (permission: Permission) => boolean;
}

/**
 * Проверки прав текущего пользователя. Отдельной функцией, а не двумя строками в провайдере: тем же
 * правилом собирает контекст тестовая оболочка рендера (`test/render.tsx`), и вторая копия правила
 * «право из списка, область по роли» разъехалась бы с этой при первой правке модели доступа.
 */
export function permissionChecks(user: AuthUser | null): Pick<AuthContextValue, 'can' | 'canUse'> {
  // Множеством, а не поиском по массиву: `can` зовут больше сотни мест, и пересобирается набор
  // только при смене пользователя.
  const granted = new Set(user?.permissions ?? []);
  return {
    can: (permission) => granted.has(permission),
    /*
     * Право — из списка сервера, область — по-прежнему по роли: отдельным полем сервер её не отдаёт,
     * и единственный её знаток — `MODULE_SCOPE` в контрактах, а он приватен. Поэтому право
     * подставляется матрице назначенным (`grantPermissions`, четвёртый источник субъекта): `canUse`
     * спрашивает и право, и область, право у портала уже спрошено — у сервера, — и ответом матрицы
     * остаётся ровно область. Пересчитывать право матрицей нельзя по причине из `can` выше, а
     * повторить правило области здесь значило бы завести ему вторую копию вне контрактов.
     */
    canUse: (permission) =>
      granted.has(permission) &&
      !!user &&
      scopedCanUse({ ...user, grantPermissions: [permission] }, permission),
  };
}

/**
 * Экспортируется ради тестов: они подставляют пользователя значением контекста, а не мокают
 * модуль целиком — `vi.mock` поднимается на верх файла и не переключается между сценариями.
 */
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Один bootstrap на вкладку: React StrictMode иначе дважды ротирует refresh → reuse detection → разлогин. */
let bootstrapPromise: Promise<AuthUser | null> | null = null;

/**
 * Чья сессия сейчас в кэше запросов.
 *
 * Держится отдельно от состояния React намеренно: при истечении сессии `user` обнуляется, и
 * сравнивать вход следующего пользователя было бы не с чем — данные предыдущего остались бы в
 * кэше и показались бы новому на общем рабочем месте. Ключи запросов учётку не содержат, поэтому
 * различает сессии только эта переменная.
 */
let cachedUserId: string | null = null;

/**
 * Отпечаток доступа, при котором набран кэш (ADR 0160, Р15). Рядом с `cachedUserId` и по той же
 * причине: ключи запросов не содержат ни учётки, ни её прав, и различить «те же данные» от «уже не
 * те» может только сравнение с тем, что было.
 */
let cachedAccess = '';

/**
 * Забыть ответ bootstrap: следующее монтирование провайдера спросит сервер заново.
 *
 * Заведено ради режима технических работ (`docs/maintenance-mode-plan.md`, §4.5), и без него режим
 * не работает вовсе. Промис кэшируется на всю жизнь вкладки, а в окне `/auth/me` отвечает 503 —
 * bootstrap превращает это в `null` и запоминает навсегда. После снятия режима вкладка так и
 * осталась бы невошедшей, то есть обещание «работа продолжается без входа» не выполнилось бы.
 *
 * `cachedUserId` при этом НЕ трогается, и это не упущение. Он отвечает на вопрос «чьи данные лежат
 * в кэше запросов», а зовущий (граница режима) кэш как раз только что вычистил сам. Обнули его
 * здесь — и первый же bootstrap вернул бы того же человека, `adoptSession` увидел бы смену учётки
 * там, где её нет, и вычистил бы кэш ВТОРОЙ раз, уже после того как провайдер начал его наполнять.
 * Смену учётки этот сброс не маскирует: вошедшего под другой сравнивать по-прежнему есть с чем.
 */
export function resetAuthBootstrap(): void {
  bootstrapPromise = null;
}

/**
 * Pauses between bootstrap attempts while the server cannot answer: 1, 2, 4, 8, then every 10 s.
 * No limit on attempts: signing in during the outage would hit the same database, and the moment
 * the server answers the tab goes on by itself, into the portal or to the login form.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];

/** Bootstrap is waiting for the server. Module state, like `bootstrapPromise`: it belongs to the tab. */
let bootstrapUnreachable = false;
const unreachableListeners = new Set<() => void>();

function setBootstrapUnreachable(next: boolean): void {
  if (bootstrapUnreachable === next) return;
  bootstrapUnreachable = next;
  for (const listener of unreachableListeners) listener();
}

function subscribeUnreachable(listener: () => void): () => void {
  unreachableListeners.add(listener);
  return () => unreachableListeners.delete(listener);
}

/** Whether the tab's first look at the session is waiting for the server; the loader says so. */
export function useAuthReconnecting(): boolean {
  return useSyncExternalStore(subscribeUnreachable, () => bootstrapUnreachable);
}

const UNREACHABLE = Symbol('unreachable');

/**
 * A failed `/auth/me` that waiting can cure: no answer at all (`fetch` rejects with a TypeError),
 * or 502/503/504. The maintenance gate's 503 is excluded: the window has its own screen and its
 * own reset of the bootstrap (`resetAuthBootstrap`).
 */
function isUnreachableError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return isApiError(e) && isServerUnreachableStatus(e.status) && e.code !== MAINTENANCE_MODE_CODE;
}

async function bootstrapOnce(): Promise<AuthUser | null | typeof UNREACHABLE> {
  const outcome = await refresh();
  if (outcome.status === 'unavailable') return UNREACHABLE;
  if (outcome.status !== 'refreshed') return null;
  try {
    return await authApi.me();
  } catch (e) {
    return isUnreachableError(e) ? UNREACHABLE : null;
  }
}

/**
 * Bootstrap that waits out a server which cannot answer (ADR 0233). A run replaced meanwhile by a
 * sign-in or a sign-out answers with the replacement: its own `null` would declare signed out a tab
 * that has just signed in. A run dropped by a reset answers `null` and starts nothing: only an
 * unmounted provider waits for it, and the next mount asks anew.
 */
async function retryBootstrap(isCurrent: () => boolean): Promise<AuthUser | null> {
  for (let attempt = 0; ; attempt += 1) {
    const me = await bootstrapOnce();
    if (!isCurrent()) return bootstrapPromise ?? null;
    if (me !== UNREACHABLE) {
      setBootstrapUnreachable(false);
      return me;
    }
    setBootstrapUnreachable(true);
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!isCurrent()) return bootstrapPromise ?? null;
  }
}

/** Тестам: вернуть модуль в состояние «на вкладку ещё никто не входил». */
export function __resetAuthForTests(): void {
  resetAuthBootstrap();
  setBootstrapUnreachable(false);
  cachedUserId = null;
  // Вместе с учёткой забывается и её доступ: иначе первый же сценарий следующего файла сравнил бы
  // свой отпечаток с чужим и вычистил кэш там, где ничего не менялось.
  cachedAccess = '';
}

function bootstrapAuth(): Promise<AuthUser | null> {
  if (!bootstrapPromise) {
    // A run replaced while waiting may have left the flag up; the new run sets it again if needed.
    setBootstrapUnreachable(false);
    const run: Promise<AuthUser | null> = retryBootstrap(() => bootstrapPromise === run).catch(
      () => null,
    );
    bootstrapPromise = run;
  }
  return bootstrapPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const queryClient = useQueryClient();

  /*
   * The account as of the last `setUser` call, readable synchronously by the refresh subscription.
   *
   * The subscription used to close over `user` and re-subscribe on every change of it. A closure
   * sees the account of the render that created it, and the effect that replaces it runs only
   * after the next render commits; React may yield between the commit and its passive effects, and
   * on a loaded machine it does. A 401 refresh completing inside that gap met the subscription made
   * while the tab was still signed out, saw no session and dropped the account it carried — the
   * menu kept the old access until a reload, and nothing retried. The ref is written in the same
   * step that hands the account to React, so no such gap exists: every path that changes the
   * account goes through `setUser` below.
   */
  const userRef = useRef<AuthUser | null>(null);
  const setUser = useCallback((next: AuthUser | null) => {
    userRef.current = next;
    setUserState(next);
  }, []);

  /**
   * Кэш запросов принадлежит той учётке, при которой он набран: ключи её не содержат, а
   * `staleTime` у справочников доходит до минут. Поэтому при любой смене или обрыве сессии он
   * выбрасывается целиком — иначе на общем рабочем месте следующий вошедший увидел бы чужие
   * заявки, пока данные не протухнут сами.
   */
  const adoptSession = useCallback(
    (next: AuthUser | null) => {
      /*
       * Второе условие — смена доступа при той же учётке (ADR 0160, Р15). После разграничения
       * карточки по аудиториям одна и та же заявка приходит РАЗНОЙ: человеку выдали «Ведение», сервер
       * уже отдаёт суммы, а в кэше лежит ответ, собранный для заявителя, — и вкладка «Объём работ»,
       * открывшаяся по новому праву, показывала бы пустую таблицу до протухания кэша.
       *
       * Правило одно на обе стороны, хотя опасна из них только одна: «право отобрали» портал
       * переживает и без сброса (перерисуется по новым правам), а «право выдали» — нет. Разные
       * правила на «дали» и «отобрали» разъехались бы на первой же правке, и разъехались бы в ту
       * сторону, которую никто не проверяет.
       */
      if (next?.id !== cachedUserId || accessFingerprint(next) !== cachedAccess)
        queryClient.clear();
      cachedUserId = next?.id ?? null;
      cachedAccess = accessFingerprint(next);
      // Мемоизация — не оптимизация, а условие честных зависимостей: функцию зовут три эффекта и
      // значение контекста, и без стабильной ссылки каждый из них либо врёт линтеру о своих
      // зависимостях, либо перезапускается на каждый рендер провайдера. Сравниваемое состояние живёт
      // в модульных переменных, поэтому от рендера функция не зависит вовсе — только от клиента кэша.
    },
    [queryClient],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await bootstrapAuth();
      if (cancelled) return;
      adoptSession(me);
      if (!me) {
        setStatus('unauthenticated');
        return;
      }
      setUser(me);
      setStatus('authenticated');
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptSession, setUser]);

  /*
   * Сессия кончилась посреди работы (refresh истёк, отозван или учётку выключили) — уводим на
   * вход. Без этого страница остаётся на экране как вошедшая, а каждое действие отвечает
   * «Требуется авторизация»: сообщение верное, но выглядит поломкой печати или выгрузки, а не
   * концом сессии. Bootstrap сюда не попадает — он зовёт `refresh` (`shared/api/session.ts`) сам.
   */
  useEffect(() => {
    // Сессия объявляет о своём конце сама — сверив, что кончилась именно та, к которой относился
    // запрос. Здесь остаётся React-часть: забыть пользователя, вычистить кэш и увести на вход.
    return onExpired(() => {
      bootstrapPromise = Promise.resolve(null);
      clearSession();
      adoptSession(null);
      setUser(null);
      setStatus('unauthenticated');
    });
  }, [adoptSession, setUser]);

  /*
   * A token refresh brought the account — apply it whole. The server computes permissions, and a
   * refresh (after `authVersion + 1`) is exactly when the set changes mid-work: without this the
   * server already authorizes the new way while the menu and buttons stay as they were until a
   * reload. The person then either sees a section they are no longer let into or does not see the
   * one just opened to them, and both read as a broken portal rather than changed access.
   */
  useEffect(() => {
    return onRefreshedUser((raw) => {
      /*
       * Only a session already handed to the screen. A refresh extends a session, it does not start
       * one: login and bootstrap start it, and both set the account together with the status. An
       * account substituted during bootstrap would disagree with it — a `/auth/me` failing right
       * after would declare the tab signed out with an account still in hand. Bootstrap brings its
       * permissions anyway: the server computes them for `/auth/me` the same way.
       *
       * Read from the ref, not from `user`: see `userRef` for the gap a closure leaves.
       */
      if (!userRef.current) return;
      // The transport passes the body untouched: `shared` does not know the portal's rules, so the
      // shape is named by whoever knows it. `POST /auth/refresh` returns exactly an `AuthUser`.
      const next = raw as AuthUser;
      // The tab's bootstrap remembers its answer; without this line a remount of the provider
      // would bring back the permissions that were in force before the refresh.
      bootstrapPromise = Promise.resolve(next);
      /*
       * "Someone else signed in" never arrives through a refresh — an answer that came back to a
       * different user does not reach subscribers at all (the session checks the generation). A
       * CHANGE OF ACCESS for the same account does arrive exactly here: a token refresh is the
       * moment a newly granted set reaches the tab mid-work (`authVersion + 1`). So the cache is
       * dropped by the same rule as on an account switch — otherwise the new access would show old
       * answers built for the previous audience (ADR 0160, R15).
       */
      adoptSession(next);
      setUser(next);
    });
    // Subscribed once per provider: both dependencies are stable references, and the check reads
    // the ref, so the subscription has no reason to be recreated — recreating it on every account
    // change is what opened the gap.
  }, [adoptSession, setUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      async login(email, password) {
        const res = await authApi.login({ email, password });
        bootstrapPromise = Promise.resolve(res.user);
        // Вошли под другой учёткой — кэш предыдущей выбрасывается. Сравнение идёт с
        // `cachedUserId`, а не с `user`: после истечения сессии тот уже пуст.
        adoptSession(res.user);
        setUser(res.user);
        setStatus('authenticated');
        return res.user;
      },
      async logout() {
        await authApi.logout().catch(() => {});
        bootstrapPromise = Promise.resolve(null);
        clearSession();
        adoptSession(null);
        setUser(null);
        setStatus('unauthenticated');
      },
      setUser,
      async refreshUser() {
        const me = await authApi.me();
        // Сервер может ответить другой учёткой: вкладку открыли заново после входа под другим
        // пользователем в соседней. Тогда кэш прежней тоже не наш.
        adoptSession(me);
        setUser(me);
      },
      ...permissionChecks(user),
    }),
    [user, status, adoptSession, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return ctx;
}
