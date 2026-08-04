import { useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 10 * 60_000;

// latestBuildId = buildId из /version.json, если он ОТЛИЧАЕТСЯ от вшитого __BUILD_ID__
// (иначе null). Опрос продолжается всегда: новый релиз обновит latestBuildId,
// даже если предыдущий пользователь отложил обновление кнопкой «Позже».
// Проверка: на mount, при возврате видимости/фокуса вкладки и раз в ~10 минут.
export const useVersionCheck = (): { latestBuildId: string | null } => {
  const [latestBuildId, setLatestBuildId] = useState<string | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) return; // в dev version.json не эмитится

    let cancelled = false;
    let inFlight = false;
    let timer = 0;

    const check = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data: unknown = await res.json();
        const id = (data as { buildId?: unknown })?.buildId;
        if (!cancelled && typeof id === 'string' && id && id !== __BUILD_ID__) {
          setLatestBuildId((prev) => (prev === id ? prev : id));
        }
      } catch {
        // offline / 404 / невалидный JSON — игнорируем
      } finally {
        inFlight = false;
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    timer = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  return { latestBuildId };
};
