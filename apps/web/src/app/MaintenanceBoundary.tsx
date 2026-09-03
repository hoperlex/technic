import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Result, Space, Typography } from 'antd';
import { ToolOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  enterMaintenanceMode,
  leaveMaintenanceMode,
  maintenanceModeState,
  onMaintenanceModeChange,
  readMaintenanceModeNotice,
  type MaintenanceModeNotice,
} from '@shared/api';
import { MOSCOW_TZ } from '@shared/config';
import { resetAuthBootstrap } from '../auth/AuthContext';

/**
 * Граница режима технических работ: пока портал закрыт, приложение не смонтировано вовсе.
 *
 * **Почему выше `AuthProvider`, а не внутри `App`** (план `docs/maintenance-mode-plan.md`, §4.5).
 * Провайдер на первом же монтировании запускает `bootstrapAuth()` — `refresh`, затем `/auth/me`.
 * В окне `/auth/me` отвечает 503, bootstrap превращает это в `null`, а промис кэшируется на всю
 * жизнь вкладки: после снятия режима он не повторится, и обещание «работа продолжается без входа»
 * не выполнится. Заглушка внутри портала эту гонку не закрывает — к моменту, когда она появится,
 * bootstrap уже сходил и уже запомнил ответ. Поэтому дети не монтируются, пока режим активен.
 *
 * **Что теряется.** Появление заглушки размонтирует портал: открытые формы и несохранённое
 * пропадают. Это цена закрытия и повод объявлять окно заранее; черновик показаний в кабинете
 * водителя живёт в хранилище браузера и переживает окно целиком.
 */

/**
 * Раз в 25 секунд — середина окна 20–30 с из плана. Опрос идёт всегда, а не только пока заглушка
 * висит: файл статуса переживает остановку `technic-api` и потому единственный, кто вообще может
 * сообщить закрытие вкладке, которая ничего не спрашивает (503 приходит только на запрос, а в окне
 * запросы либо замкнуты, либо некому отвечать).
 */
const POLL_INTERVAL_MS = 25_000;

/** Раздаёт статику веба, а не api: файла нет → 404, и это штатный ответ «режима нет» (Р6 плана). */
const STATUS_URL = '/maintenance.json';

/**
 * Что ответил файл статуса.
 *
 * Третьего состояния («не смог спросить») хватает одного на все причины: сетевую ошибку, 5xx и
 * нечитаемое тело портал обязан толковать ОДИНАКОВО — как отсутствие ответа, а не как ответ.
 */
type Verdict =
  ({ kind: 'closed' } & MaintenanceModeNotice) | { kind: 'open' } | { kind: 'unknown' };

async function askStatusFile(): Promise<Verdict> {
  let res: Response;
  try {
    // `?ts=` вдобавок к `no-store` — тем же приёмом, что у проверки версии: заголовок уважают не
    // все промежуточные кэши, а несвежий ответ здесь означал бы заглушку на работающем портале.
    res = await fetch(`${STATUS_URL}?ts=${Date.now()}`, { cache: 'no-store' });
  } catch {
    return { kind: 'unknown' };
  }

  // Файла нет — режима нет. Единственный ответ, кроме явного `active: false`, которым работы
  // объявляются законченными.
  if (res.status === 404) return { kind: 'open' };
  /*
   * Всё прочее неуспешное — 5xx веба, 502 от лежащего рядом сервиса, 403 на неверно заведённой
   * локации — заглушку НЕ снимает. «Не смог спросить» не то же самое, что «работы кончились»:
   * ошибиться в эту сторону значит открыть портал посреди миграции, а в обратную — подержать
   * заглушку лишние 25 секунд до следующего опроса.
   */
  if (!res.ok) return { kind: 'unknown' };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Нечитаемое тело — по той же причине не ответ. Так выглядит и подменённый прокси html вместо
    // файла, и файл, недописанный до конца в момент чтения.
    return { kind: 'unknown' };
  }
  if (typeof body !== 'object' || body === null) return { kind: 'unknown' };

  const { active } = body as { active?: unknown };
  if (active !== true) return { kind: 'open' };
  return { kind: 'closed', ...readMaintenanceModeNotice(body) };
}

/**
 * Опрос файла статуса. Проверка на монтировании, при возврате видимости и фокуса вкладки и по
 * таймеру — тем же устройством, что у `useVersionCheck`: вкладка, пролежавшая свёрнутой всё окно,
 * обязана узнать о конце работ сразу, а не через четверть минуты.
 */
function useStatusFileWatch(): void {
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const check = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const verdict = await askStatusFile();
        if (cancelled) return;
        if (verdict.kind === 'closed') enterMaintenanceMode(verdict);
        else if (verdict.kind === 'open') leaveMaintenanceMode();
        // 'unknown' — состояние не трогаем ни в какую сторону.
      } finally {
        inFlight = false;
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
}

/** Срок показывается, только если он читается датой: битую строку лучше не показывать вовсе. */
function untilLabel(until: string | null): string | null {
  if (!until) return null;
  const at = dayjs(until);
  if (!at.isValid()) return null;
  return at.tz(MOSCOW_TZ).format('DD.MM.YYYY HH:mm');
}

/**
 * Объявление на весь экран. Тон спокойный намеренно: человек не сделал ничего плохого и делать
 * ничего не должен — портал откроется сам, и об этом сказано прямо. Ни кнопки перезагрузки, ни
 * ссылки на вход тут нет: и то и другое предложило бы действие, которое сейчас не работает.
 */
function MaintenanceScreen({ reason, until }: MaintenanceModeNotice) {
  const finish = untilLabel(until);
  return (
    <div
      role="status"
      aria-label="Технические работы"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <Result
        icon={<ToolOutlined />}
        title="Идут технические работы"
        subTitle={
          <Space orientation="vertical" size={8} style={{ maxWidth: 520, textAlign: 'left' }}>
            <Typography.Text>
              Портал закрыт на время работ. Делать ничего не нужно: страница сама проверяет
              состояние и откроется, когда работы закончатся, — перезагружать её и входить заново не
              потребуется.
            </Typography.Text>
            {reason && (
              <Typography.Text>
                <Typography.Text strong>Что делаем: </Typography.Text>
                {reason}
              </Typography.Text>
            )}
            {finish && (
              <Typography.Text>
                <Typography.Text strong>Ожидаемое окончание: </Typography.Text>
                {finish} (МСК)
              </Typography.Text>
            )}
          </Space>
        }
      />
    </div>
  );
}

export function MaintenanceBoundary({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Состояние живёт вне дерева React: ставит его транспорт, отвечая на чужой запрос (503), и
  // опрос файла — поэтому подпиской, а не состоянием компонента. Третий аргумент нужен серверному
  // рендеру и стоит того же: состояние модуля от способа отрисовки не зависит.
  const state = useSyncExternalStore(
    onMaintenanceModeChange,
    maintenanceModeState,
    maintenanceModeState,
  );
  useStatusFileWatch();
  const wasClosed = useRef(false);

  if (state.active) {
    wasClosed.current = true;
    return <MaintenanceScreen reason={state.reason} until={state.until} />;
  }

  /*
   * Режим снят — портал начинается заново, и оба действия ниже обязательны. Окно затевалось ради
   * изменения данных и, бывает, прав: продолжать со списками, набранными до миграции, значит
   * показывать заведомо неверное, а помнить ответ bootstrap, полученный при закрытом портале, —
   * остаться невошедшим навсегда.
   *
   * Делается это ПРЯМО В РЕНДЕРЕ, а не эффектом, и иначе нельзя: эффекты ребёнка выполняются
   * раньше эффектов родителя, то есть к моменту, когда сработал бы наш `useEffect`, `AuthProvider`
   * уже смонтирован и уже позвал `bootstrapAuth()` со старым промисом, а первые запросы экранов
   * уже легли в кэш, который мы только собираемся чистить. Повторов это не даёт: признак гасится
   * тут же, и двойной прогон рендера в `StrictMode` видит его уже снятым — очистка ровно одна.
   */
  if (wasClosed.current) {
    wasClosed.current = false;
    resetAuthBootstrap();
    queryClient.clear();
  }

  return <>{children}</>;
}
