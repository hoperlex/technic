import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { canUse as scopedCanUse, type AuthUser, type Permission } from '@technic/contracts';
import { authApi } from '../api/auth';
import { accessFingerprint } from './accessFingerprint';
import { clear as clearSession, onExpired, onRefreshedUser, refresh } from '@shared/api';

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

/** Тестам: вернуть модуль в состояние «на вкладку ещё никто не входил». */
export function __resetAuthForTests(): void {
  resetAuthBootstrap();
  cachedUserId = null;
  // Вместе с учёткой забывается и её доступ: иначе первый же сценарий следующего файла сравнил бы
  // свой отпечаток с чужим и вычистил кэш там, где ничего не менялось.
  cachedAccess = '';
}

function bootstrapAuth(): Promise<AuthUser | null> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const outcome = await refresh();
      if (outcome.status !== 'refreshed') return null;
      return authApi.me();
    })().catch(() => null);
  }
  return bootstrapPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const queryClient = useQueryClient();

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
  }, [adoptSession]);

  /*
   * Сессия кончилась посреди работы (refresh истёк, отозван или учётку выключили) — уводим на
   * вход. Без этого страница остаётся на экране как вошедшая, а каждое действие отвечает
   * «Требуется авторизация»: сообщение верное, но выглядит поломкой печати или выгрузки, а не
   * концом сессии. Bootstrap сюда не попадает — он зовёт `refreshSession` напрямую.
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
  }, [adoptSession]);

  /*
   * Обновление токена принесло учётку — применяем её целиком. Права считает сервер, и обновление
   * (после `authVersion + 1`) — тот самый момент, когда набор меняется посреди работы: без этого
   * сервер разрешает уже по-новому, а меню и кнопки остаются прежними до перезагрузки страницы.
   * Человек при этом либо видит раздел, в который его больше не пускают, либо не видит того, что
   * ему только что открыли, — и то и другое читается как поломка портала, а не как смена доступа.
   */
  useEffect(() => {
    return onRefreshedUser((raw) => {
      /*
       * Только сессии, которая уже на экране. Обновление её продлевает, а не начинает: начинают вход
       * и bootstrap, и оба ставят пользователя вместе со статусом. Подставленный во время bootstrap
       * пользователь разошёлся бы с ним ответами — упавший следом `/auth/me` объявил бы вкладку
       * невошедшей, оставив на руках учётку. Свою права он и так принесёт: сервер считает их для
       * `/auth/me` тем же способом.
       */
      if (!user) return;
      // Тело транспорт передаёт нетронутым: `shared` не знает правил портала, поэтому форму
      // называет тот, кто её знает. Ручка `POST /auth/refresh` отдаёт ровно `AuthUser`.
      const next = raw as AuthUser;
      // Bootstrap вкладки помнит свой ответ; без этой строки повторное монтирование провайдера
      // вернуло бы права, действовавшие до обновления.
      bootstrapPromise = Promise.resolve(next);
      /*
       * «Вошёл другой» обновлением не бывает — ответ, вернувшийся уже к другому пользователю, до
       * подписки не доходит вовсе (сверку поколения делает сама сессия). А вот СМЕНА ДОСТУПА той же
       * учётки бывает именно здесь: обновление токена — тот самый момент, когда выданный набор
       * доезжает до вкладки посреди работы (`authVersion + 1`). Поэтому кэш выбрасывается по тому
       * же правилу, что и при смене учётки, — иначе новый доступ показывал бы старые, собранные для
       * прежней аудитории ответы (ADR 0160, Р15).
       */
      adoptSession(next);
      setUser(next);
    });
    // Зависимость от `user` — ради проверки выше: подписка обязана видеть текущее состояние
    // сессии, а не то, каким оно было на первом рендере. `adoptSession` мемоизирован и ссылку не
    // меняет, поэтому подписка от него не пересоздаётся.
  }, [user, adoptSession]);

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
      setUser: (u) => setUser(u),
      async refreshUser() {
        const me = await authApi.me();
        // Сервер может ответить другой учёткой: вкладку открыли заново после входа под другим
        // пользователем в соседней. Тогда кэш прежней тоже не наш.
        adoptSession(me);
        setUser(me);
      },
      ...permissionChecks(user),
    }),
    [user, status, adoptSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return ctx;
}
