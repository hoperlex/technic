import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  __resetMaintenanceModeForTests,
  apiFetch,
  enterMaintenanceMode,
  isMaintenanceModeActive,
  maintenanceModeState,
  refresh,
} from '@shared/api';
import { MaintenanceBoundary } from '@app/MaintenanceBoundary';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { authApi } from '../src/api/auth';
import { createTestQueryClient } from './render';
import { authUser } from './factories/auth';

/**
 * Режим технических работ со стороны портала (план `docs/maintenance-mode-plan.md`, этапы Э5–Э6).
 *
 * Проверяется то, чего не видно глазами и что стоит дорого при промахе. Транспорт: закрытый портал
 * не молотят фоновые обновления списков, но выход сквозь него проходит — иначе нажавший «Выйти»
 * остался бы с живой серверной сессией. Граница: заглушка появляется обоими каналами, снимается
 * только подтверждённым ответом файла, а после снятия портал начинается заново — с чистым кэшем и
 * повторным bootstrap, потому что окно затевалось ради изменения данных и прав.
 *
 * Сеть подменяется целиком, а не через `mockHttp`: файл статуса лежит вне `/api/v1`, и роутер моков
 * отвечает на всё внешнее пустым 200 — то есть ровно тем «нечитаемым телом», отличать которое от
 * ответа и есть предмет половины проверок.
 */

type FileAnswer =
  { kind: 'missing' } | { kind: 'offline' } | { kind: 'served'; status?: number; text: string };

interface ApiAnswer {
  status: number;
  body?: unknown;
}

/** Отказ гейта ровно той формы, что задана контрактом: статус, код, причина и срок в `details`. */
const REFUSAL: ApiAnswer = {
  status: 503,
  body: {
    code: 'maintenance_mode',
    message: 'Портал закрыт на технические работы',
    details: { reason: 'Перевод схемы', until: '2026-09-04T03:00:00.000Z' },
  },
};

/** Тот же файл статуса, каким его пишет команда оператора. */
const CLOSED_FILE: FileAnswer = {
  kind: 'served',
  text: JSON.stringify({
    active: true,
    reason: 'Перевод схемы',
    until: '2026-09-04T03:00:00.000Z',
    startedAt: '2026-09-04T00:00:00.000Z',
  }),
};

let file: FileAnswer;
let api: (path: string, method: string) => ApiAnswer;
let sent: { method: string; path: string }[];

beforeEach(() => {
  file = { kind: 'missing' };
  api = () => ({ status: 200, body: { ok: true } });
  sent = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ method, path: url.pathname });

    if (url.pathname === '/maintenance.json') {
      if (file.kind === 'offline') throw new TypeError('Failed to fetch');
      if (file.kind === 'missing') return new Response(null, { status: 404 });
      return new Response(file.text, {
        status: file.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const answer = api(url.pathname.replace('/api/v1', ''), method);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Состояние режима живёт в модуле и пережило бы тест: следующий начинал бы с закрытого портала,
  // и падал бы он, а не тот, кто портал закрыл.
  __resetMaintenanceModeForTests();
});

/** Дать дойти опросу файла: он уходит в сеть, и его ответ приходит уже следующей задачей. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const wentTo = (method: string, path: string) =>
  sent.filter((call) => call.method === method && call.path === path).length;

function Probe() {
  const { status, user } = useAuth();
  return <div>{status === 'authenticated' ? user!.email : `сессия: ${status}`}</div>;
}

/**
 * Тот же порядок, что в точке входа: граница режима выше авторизации, а не внутри портала.
 *
 * `StrictMode` здесь не для полноты картины. Граница делает сброс bootstrap и очистку кэша прямо в
 * рендере (иначе `AuthProvider` успевает смонтироваться раньше), а `StrictMode` рендер удваивает —
 * без него проверка «очистка ровно одна» не проверяла бы главный риск этого решения.
 */
function renderPortal(): QueryClient {
  const queryClient = createTestQueryClient();
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MaintenanceBoundary>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </MaintenanceBoundary>
      </QueryClientProvider>
    </StrictMode>,
  );
  return queryClient;
}

const stub = () => screen.queryByRole('status', { name: 'Технические работы' });

describe('транспорт в режиме технических работ', () => {
  it('отказ гейта поднимает флаг и запоминает, что объявил оператор', async () => {
    api = () => REFUSAL;

    await expect(apiFetch('/service-requests')).rejects.toMatchObject({
      status: 503,
      code: 'maintenance_mode',
    });

    expect(isMaintenanceModeActive()).toBe(true);
    expect(maintenanceModeState()).toMatchObject({
      reason: 'Перевод схемы',
      until: '2026-09-04T03:00:00.000Z',
    });
  });

  it('разбирается пара «статус + код»: чужая 503 портал не закрывает', async () => {
    // 503 отдаёт и промежуточный прокси, и перегруженный сервис. Прими портал её за режим — он
    // замкнул бы себя сам, и снять это было бы некому: файла статуса при этом нет.
    api = () => ({ status: 503, body: { code: 'error', message: 'Сервис недоступен' } });

    await expect(apiFetch('/service-requests')).rejects.toMatchObject({ status: 503 });

    expect(isMaintenanceModeActive()).toBe(false);
  });

  it('пока портал закрыт, обычный запрос не уходит вовсе', async () => {
    enterMaintenanceMode({ reason: 'Перевод схемы', until: null });

    await expect(apiFetch('/service-requests')).rejects.toMatchObject({
      status: 503,
      code: 'maintenance_mode',
    });

    // Именно «не отправлен», а не «отправлен и отбит»: иначе каждая вкладка всё окно молотила бы
    // по закрытому API фоновыми обновлениями списков.
    expect(sent).toHaveLength(0);
  });

  it('выход проходит сквозь закрытый портал', async () => {
    enterMaintenanceMode({ reason: null, until: null });
    api = () => ({ status: 200, body: { ok: true } });

    await authApi.logout();

    // Замкни транспорт эту дверь — нажавший «Выйти» остался бы с неотозванной серверной
    // refresh-сессией: вкладка забыла бы токен, а сервер продолжал бы менять cookie на новые.
    expect(wentTo('POST', '/api/v1/auth/logout')).toBe(1);
  });

  it('обновления сессии замыкание не касается вовсе', async () => {
    enterMaintenanceMode({ reason: null, until: null });
    api = () => ({ status: 200, body: { accessToken: 'token' } });

    await refresh();

    // У refresh собственный `fetch` мимо транспорта, и это существенно: отказ он прочитал бы как
    // конец сессии и выбросил бы человека на форму входа — ровно то, чего режим избегает.
    expect(wentTo('POST', '/api/v1/auth/refresh')).toBe(1);
  });
});

describe('граница режима технических работ', () => {
  it('заглушка появляется по отказу 503, и портал под ней не смонтирован', async () => {
    api = (path) => (path === '/auth/refresh' ? { status: 401 } : { status: 200, body: {} });
    renderPortal();
    await settle();
    expect(stub()).toBeNull();
    expect(screen.getByText('сессия: unauthenticated')).toBeDefined();

    api = () => REFUSAL;
    await act(async () => void (await apiFetch('/service-requests').catch(() => undefined)));

    expect(stub()).not.toBeNull();
    expect(screen.getByText('Идут технические работы')).toBeDefined();
    expect(screen.queryByText('сессия: unauthenticated')).toBeNull();
  });

  it('заглушка появляется по файлу статуса и называет причину и срок', async () => {
    // Второй канал существует ради главного сценария: в окне `technic-api` остановлен, и 503
    // сказать некому — файл раздаёт статика веба.
    file = CLOSED_FILE;
    renderPortal();
    await settle();

    const screenText = stub()!.textContent ?? '';
    expect(screenText).toContain('Перевод схемы');
    // Срок показывается по-московски, как все времена портала.
    expect(screenText).toContain('04.09.2026 06:00');
  });

  it('ни сетевая ошибка, ни 5xx, ни нечитаемое тело заглушку не снимают', async () => {
    file = CLOSED_FILE;
    renderPortal();
    await settle();
    expect(stub()).not.toBeNull();

    // «Не смог спросить» — не то же самое, что «работы кончились»: ошибиться в эту сторону значит
    // открыть портал посреди миграции.
    for (const answer of [
      { kind: 'offline' } as const,
      { kind: 'served', status: 502, text: 'Bad Gateway' } as const,
      { kind: 'served', text: '<html>заглушка прокси</html>' } as const,
      { kind: 'served', text: 'null' } as const,
    ]) {
      file = answer;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(stub()).not.toBeNull();
    }

    // А подтверждённый ответ снимает: файла нет — режима нет.
    file = { kind: 'missing' };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(stub()).toBeNull();
  });

  it('явное «active: false» тоже снимает заглушку', async () => {
    file = CLOSED_FILE;
    renderPortal();
    await settle();
    expect(stub()).not.toBeNull();

    file = { kind: 'served', text: JSON.stringify({ active: false }) };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(stub()).toBeNull();
  });

  it('после снятия режима кэш чистится ровно раз, а bootstrap спрашивает сервер заново', async () => {
    const me = authUser();
    const open = (path: string): ApiAnswer => {
      if (path === '/auth/refresh') return { status: 200, body: { accessToken: 'token' } };
      if (path === '/auth/me') return { status: 200, body: me };
      return { status: 200, body: { ok: true } };
    };
    api = open;

    const queryClient = renderPortal();
    await screen.findByText(me.email);
    // Шпион ставится после первого входа: та очистка — «вкладка узнала, чья сессия», и к режиму
    // отношения не имеет.
    const clear = vi.spyOn(queryClient, 'clear');

    api = () => REFUSAL;
    await act(async () => void (await apiFetch('/service-requests').catch(() => undefined)));
    expect(stub()).not.toBeNull();
    expect(screen.queryByText(me.email)).toBeNull();

    api = open;
    file = { kind: 'missing' };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Портал открылся сам: ни перезагрузки, ни входа заново.
    await screen.findByText(me.email);
    /*
     * Ровно одна очистка — та, что сделала граница. Вторая означала бы, что сброс bootstrap заодно
     * обнулил `cachedUserId`: провайдер принял бы того же человека за нового и выбросил бы кэш,
     * который сам же начал наполнять.
     */
    expect(clear).toHaveBeenCalledTimes(1);
    // И повторный bootstrap: запомненный при закрытом портале ответ не годится — в окне менялись
    // и данные, и права.
    expect(wentTo('GET', '/api/v1/auth/me')).toBe(2);
  });
});
