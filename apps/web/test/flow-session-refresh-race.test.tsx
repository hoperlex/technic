import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { apiError, json, mockHttp } from './http';
import { apiFetch } from '../src/shared/api';
import {
  __resetSessionForTests,
  clear as clearSession,
  currentGeneration,
  getToken,
  onExpired,
  startSession,
} from '../src/shared/api';

/**
 * Гонка, ради которой у сессии появился номер.
 *
 * Обновление токена нельзя отменить: запрос refresh уже ушёл. Пока он висит, человек успевает
 * выйти, а за компьютер садится другой и входит своей учёткой. Ответ первого возвращается позже — и
 * без сверки поколения делает одно из двух: кладёт свежий токен уже чужой сессии либо объявляет
 * законченной сессию нового пользователя. Оба случая на общем рабочем месте выглядят как «портал
 * сам разлогинился», а разбираться приходится с журналами сервера.
 *
 * Тесты последовательных сценариев (`flow-session-switch`, `flow-session-expired-switch`) такого не
 * ловят: там ответы приходят в том же порядке, в каком отправлены.
 */
describe('висящее обновление токена и смена сессии', () => {
  it('ответ старого refresh не выкидывает нового пользователя', async () => {
    __resetSessionForTests();

    /** Ответ refresh придержим: он должен вернуться уже после входа второго пользователя. */
    let releaseRefresh: (() => void) | null = null;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const http = mockHttp({
      // Первый пользователь: его запрос упирается в 401, портал идёт обновлять токен.
      'GET /objects': () =>
        apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' }),
      'POST /auth/refresh': async () => {
        await refreshHeld;
        // Пока ответ висел, refresh-cookie первого протухла — сервер отказывает.
        return apiError(401, { code: 'unauthorized', message: 'Сессия истекла' });
      },
    });

    startSession('token-A');
    let expiredCalls = 0;
    const unsubscribe = onExpired(() => {
      expiredCalls += 1;
    });

    // Запрос первого пользователя: уходит, получает 401 и ждёт обновления.
    const pending = apiFetch('/objects').catch(() => 'failed');
    // Обновление должно быть НАЧАТО в сессии первого — иначе тест проверял бы не гонку, а
    // обычное обновление уже второго пользователя.
    await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(1));

    // За компьютер садится второй: выход и вход, пока обновление первого ещё висит.
    clearSession();
    startSession('token-B');
    const generationOfB = currentGeneration();

    // Только теперь отпускаем ответ первого.
    releaseRefresh!();
    await pending;

    expect(expiredCalls).toBe(0);
    expect(getToken()).toBe('token-B');
    expect(currentGeneration()).toBe(generationOfB);
    unsubscribe();
  });

  it('ответ refresh, вернувшийся после входа другого, не подменяет его токен', async () => {
    __resetSessionForTests();

    let releaseRefresh: (() => void) | null = null;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    const http = mockHttp({
      'GET /objects': () =>
        apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' }),
      'POST /auth/refresh': async () => {
        await refreshHeld;
        // Обновление прошло успешно — но уже не для той сессии.
        return json({ accessToken: 'token-A-refreshed' });
      },
    });

    startSession('token-A');
    const pending = apiFetch('/objects').catch(() => 'failed');
    await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(1));

    clearSession();
    startSession('token-B');

    releaseRefresh!();
    await pending;

    // Токен второго остаётся на месте: чужое обновление до него не дотягивается.
    expect(getToken()).toBe('token-B');
  });

  it('в своей же сессии обновление применяется как обычно', async () => {
    __resetSessionForTests();

    let attempt = 0;
    mockHttp({
      // Первый заход — 401, после обновления тот же запрос проходит.
      'GET /objects': () => {
        attempt += 1;
        return attempt === 1
          ? apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' })
          : json({ items: [], total: 0, page: 1, pageSize: 100 });
      },
      'POST /auth/refresh': () => json({ accessToken: 'token-A-refreshed' }),
    });

    startSession('token-A');
    await apiFetch('/objects');

    expect(getToken()).toBe('token-A-refreshed');
    expect(attempt).toBe(2);
  });
});
