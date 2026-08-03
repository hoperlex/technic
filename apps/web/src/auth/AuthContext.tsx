import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { can as roleCan, type AuthUser, type Permission, type Role } from '@technic/contracts';
import { authApi } from '../api/auth';
import { refreshSession, resetSession, setSessionExpiredHandler } from '../api/client';

type Status = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthUser | null;
  status: Status;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (u: AuthUser) => void;
  refreshUser: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
  /**
   * Право текущего пользователя по общей матрице (ADR 0021) — той же, по которой API
   * проверяет доступ. Спрашивается у самого пользователя, а не у его роли: у внешнего
   * исполнителя модуль задаёт тип контрагента (ADR 0038). Интерфейс скрывает недоступное, но
   * решение всё равно за сервером: здесь это удобство, а не защита.
   */
  can: (permission: Permission) => boolean;
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

/** Тестам: вернуть модуль в состояние «на вкладку ещё никто не входил». */
export function __resetAuthForTests(): void {
  bootstrapPromise = null;
  cachedUserId = null;
}

function bootstrapAuth(): Promise<AuthUser | null> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const ok = await refreshSession();
      if (!ok) return null;
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
  const adoptSession = (next: AuthUser | null) => {
    if (next?.id !== cachedUserId) queryClient.clear();
    cachedUserId = next?.id ?? null;
  };

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
  }, []);

  /*
   * Сессия кончилась посреди работы (refresh истёк, отозван или учётку выключили) — уводим на
   * вход. Без этого страница остаётся на экране как вошедшая, а каждое действие отвечает
   * «Требуется авторизация»: сообщение верное, но выглядит поломкой печати или выгрузки, а не
   * концом сессии. Bootstrap сюда не попадает — он зовёт `refreshSession` напрямую.
   */
  useEffect(() => {
    setSessionExpiredHandler(() => {
      bootstrapPromise = Promise.resolve(null);
      // Сессии больше нет: забываем токен, обесцениваем висящее обновление и чистим кэш — иначе
      // набранные данные дождались бы следующего вошедшего.
      resetSession();
      adoptSession(null);
      setUser(null);
      setStatus('unauthenticated');
    });
    return () => setSessionExpiredHandler(null);
  }, []);

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
        resetSession();
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
      hasRole: (...roles) => !!user?.role && roles.includes(user.role),
      can: (permission) => roleCan(user, permission),
    }),
    [user, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return ctx;
}
