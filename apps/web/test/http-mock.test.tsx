import { describe, expect, it } from 'vitest';
import { apiError, json, mockHttp, noContent, takeUnmatchedHttp } from './http';
import { apiFetch, isApiError } from '../src/api/client';

/**
 * Проверка самой сети безопасности: сценарные тесты держатся на этих моках, и молчаливая
 * поломка здесь означала бы, что зелёные тесты ничего не проверяют.
 */
describe('HTTP-моки для тестов', () => {
  it('отвечает по маршруту и записывает запрос в журнал', async () => {
    const http = mockHttp({
      'GET /waste-requests': ({ query }) =>
        json({ items: [], total: 0, page: 1, pageSize: 100, status: query.get('status') }),
    });

    const result = await apiFetch<{ status: string | null }>('/waste-requests', {
      query: { status: 'new' },
    });

    expect(result.status).toBe('new');
    expect(http.countOf('GET /waste-requests')).toBe(1);
    expect(http.lastCall('GET /waste-requests')?.query.get('status')).toBe('new');
  });

  it('подставляет параметры пути и отдаёт тело запроса обработчику', async () => {
    const http = mockHttp({
      'PATCH /waste-requests/:id/status': ({ params, body }) => json({ id: params.id, echo: body }),
    });

    await apiFetch('/waste-requests/wr-7/status', {
      method: 'PATCH',
      body: { status: 'confirmed', version: 3 },
    });

    expect(http.lastCall('PATCH /waste-requests/:id/status')?.body).toEqual({
      status: 'confirmed',
      version: 3,
    });
  });

  it('ответ 204 не разбирается как тело', async () => {
    mockHttp({ 'DELETE /files/:id': () => noContent() });
    await expect(apiFetch('/files/f-1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('ошибка приходит в том же виде, что и от сервера — с полями формы', async () => {
    mockHttp({
      'POST /waste-requests': () =>
        apiError(400, {
          code: 'validation_error',
          message: 'Проверьте поля',
          fields: { deliveryAt: 'Дата в прошлом' },
        }),
    });

    const error: unknown = await apiFetch('/waste-requests', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(isApiError(error)).toBe(true);
    // Проверку сузили предикатом: `fields` есть только у ошибки портала, и тест должен падать
    // именно на её отсутствии, а не на чтении поля у чего попало.
    if (!isApiError(error)) throw new Error('ожидалась ошибка портала');
    expect(error.fields).toEqual({ deliveryAt: 'Дата в прошлом' });
  });

  it('незаданный маршрут падает с внятным сообщением, а не пустым ответом', async () => {
    mockHttp({});
    await expect(apiFetch('/objects')).rejects.toThrow(/Нет мока для «GET \/objects»/);
    // Отсутствие мока здесь — предмет проверки, а не оплошность: гасим запись, иначе общая
    // сверка в setup.ts уронит этот же тест второй раз.
    expect(takeUnmatchedHttp()).toEqual(['GET /objects']);
  });

  /*
   * Пара тестов на само восстановление сети. Хук снятия мока живёт в `test/setup.ts`, а не внутри
   * `mockHttp`: зарегистрированный изнутри `it`, он попадал бы не в ту сюиту и до следующего теста
   * не доживал — подменённый `fetch` утекал бы в соседние тесты, и падали бы они, а не виновник.
   */
  let mockedFetch: typeof globalThis.fetch | null = null;

  it('ставит подмену сети внутри теста', () => {
    mockHttp({ 'GET /objects': () => json([]) });
    mockedFetch = globalThis.fetch;
    expect(mockedFetch).toBeTypeOf('function');
  });

  it('и снимает её до следующего теста', () => {
    expect(globalThis.fetch).not.toBe(mockedFetch);
  });
});
