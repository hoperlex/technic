import { describe, expect, it } from 'vitest';
import { apiError, mockHttp } from './http';
import { apiFetch } from '@shared/api';
import { errorFields, errorMessage } from '@shared/lib';

/**
 * Сообщения об ошибках API. Механизм общий, подписи полей — доменные и приходят параметром;
 * поэтому и здесь имена полей взяты произвольные: тест, написанный на словаре заявок, проверял бы
 * словарь, а не разбор ответа.
 *
 * Главное в этом файле — разница между двумя функциями. `errorMessage` собирает текст для человека
 * и подставляет подписи; `errorFields` отдаёт пути ровно такими, какими их прислал сервер, потому
 * что по ним форма ищет свои поля. Перепутать их местами легко, а увидеть подмену — только на
 * экране, где ошибка перестанет показываться на поле.
 */

/** Ошибка портала в том виде, в каком её бросает транспорт. */
const apiFailure = (
  message: string,
  fields?: Record<string, string>,
  code = 'validation_error',
): unknown => ({ code, message, fields, status: 400 });

const LABELS = { alpha: 'Первое поле', beta: 'Второе поле' };

describe('errorMessage', () => {
  it('перечисляет поля подписями домена', () => {
    const error = apiFailure('Ошибка валидации данных', {
      alpha: 'Обязательное поле',
      beta: 'Слишком длинно',
    });

    expect(errorMessage(error, LABELS)).toBe('Ошибка валидации данных: Первое поле, Второе поле');
  });

  it('без словаря показывает имя поля так, как его прислал сервер', () => {
    // Хуже подписи, но лучше молчания: человеку видно, где искать, а разработчику — какого
    // ключа не хватает в словаре сущности.
    const error = apiFailure('Ошибка валидации данных', { alpha: 'Обязательное поле' });

    expect(errorMessage(error)).toBe('Ошибка валидации данных: alpha');
  });

  it('неизвестное словарю поле остаётся техническим именем рядом с подписанными', () => {
    const error = apiFailure('Ошибка валидации данных', {
      alpha: 'Обязательное поле',
      gamma: 'Некорректное значение',
    });

    expect(errorMessage(error, LABELS)).toBe('Ошибка валидации данных: Первое поле, gamma');
  });

  it('подпись ищется по последнему сегменту пути', () => {
    // zod присылает путь вида `vehicles.0.volumeM3`: номер элемента в подписи не значим, значимо
    // имя поля на конце.
    const error = apiFailure('Ошибка валидации данных', { 'items.0.alpha': 'Обязательное поле' });

    expect(errorMessage(error, LABELS)).toBe('Ошибка валидации данных: Первое поле');
  });

  it('одно и то же поле в нескольких элементах не повторяется в тексте', () => {
    const error = apiFailure('Ошибка валидации данных', {
      'items.0.alpha': 'Обязательное поле',
      'items.1.alpha': 'Обязательное поле',
    });

    expect(errorMessage(error, LABELS)).toBe('Ошибка валидации данных: Первое поле');
  });

  it('ошибка без полей показывается своим текстом', () => {
    const conflict = { code: 'conflict', message: 'Заявку уже изменили', status: 409 };

    expect(errorMessage(conflict, LABELS)).toBe('Заявку уже изменили');
    // Пустой `fields` — то же самое, что его отсутствие: двоеточие без перечисления читалось бы
    // как оборванное сообщение.
    expect(errorMessage(apiFailure('Ошибка валидации данных', {}), LABELS)).toBe(
      'Ошибка валидации данных',
    );
  });

  it('у пятисотки к тексту добавляется номер обращения', () => {
    // В проде сервер прячет причину («Внутренняя ошибка сервера») — и правильно, в ней бывает
    // SQL. Но без номера человеку не с чем прийти: причина лежит в логе, а найти её там нечем.
    const internal = {
      code: 'internal_error',
      message: 'Внутренняя ошибка сервера',
      status: 500,
      requestId: '4781258b-163e-49c2-befa-7626e70b99c6',
    };

    expect(errorMessage(internal, LABELS)).toBe(
      'Внутренняя ошибка сервера (обращение 4781258b-163e-49c2-befa-7626e70b99c6)',
    );
  });

  it('у 4xx номер не печатается: текст называет проблему сам', () => {
    // Хвост из uuid у «Заявку уже изменили» ничего не добавляет — идти с ним некуда, читать мешает.
    const conflict = {
      code: 'conflict',
      message: 'Заявку уже изменили',
      status: 409,
      requestId: 'cadf0b65-559f-4b04-8c4d-77056a1fc485',
    };

    expect(errorMessage(conflict, LABELS)).toBe('Заявку уже изменили');
  });

  it('пятисотка без номера остаётся своим текстом', () => {
    const internal = { code: 'internal_error', message: 'Внутренняя ошибка сервера', status: 500 };

    expect(errorMessage(internal, LABELS)).toBe('Внутренняя ошибка сервера');
  });

  it('не-API ошибки: свой текст у Error и общий у всего остального', () => {
    expect(errorMessage(new Error('Сеть недоступна'))).toBe('Сеть недоступна');
    expect(errorMessage(new TypeError('Failed to fetch'), LABELS)).toBe('Failed to fetch');
    expect(errorMessage('строка вместо ошибки')).toBe('Произошла ошибка');
    expect(errorMessage(null)).toBe('Произошла ошибка');
    expect(errorMessage(undefined)).toBe('Произошла ошибка');
    // Объект без `code`/`status` ошибкой портала не считается — иначе чужой объект с полем
    // `message` притворился бы ответом сервера.
    expect(errorMessage({ message: 'Не отсюда' })).toBe('Произошла ошибка');
  });
});

describe('errorFields', () => {
  it('возвращает пути такими, как их прислал сервер', () => {
    // Подписи здесь ни при чём, и параметра для них нет: по этим путям `applyApiFieldErrors`
    // находит поля формы (верхний сегмент пути — имя `Form.Item`). Подставленная подпись
    // сопоставление сломала бы, и ошибка осталась бы только тостом.
    const fields = { alpha: 'Обязательное поле', 'items.0.beta': 'Некорректное значение' };

    expect(errorFields(apiFailure('Ошибка валидации данных', fields))).toEqual(fields);
    expect(Object.keys(errorFields(apiFailure('Ошибка', fields)) ?? {})).toEqual([
      'alpha',
      'items.0.beta',
    ]);
  });

  it('пусто там, где полей нет', () => {
    expect(errorFields(apiFailure('Заявку уже изменили', undefined, 'conflict'))).toBeNull();
    expect(errorFields(apiFailure('Ошибка валидации данных', {}))).toBeNull();
    expect(errorFields(new Error('Сеть недоступна'))).toBeNull();
    expect(errorFields(null)).toBeNull();
  });
});

describe('разбор настоящего ответа сервера', () => {
  /*
   * Признак ошибки портала (`code` и `status`) продублирован в `shared/lib`: направление внутри
   * shared не позволяет `lib` смотреть в `api`. Дубль обязан совпадать с оригиналом, и держится
   * это совпадение здесь — на том, что транспорт бросает на самом деле, а не на нашем пересказе.
   */
  it('текст и поля собираются из того, что бросил транспорт', async () => {
    mockHttp({
      'POST /samples': () =>
        apiError(400, {
          code: 'validation_error',
          message: 'Ошибка валидации данных',
          fields: { alpha: 'Обязательное поле' },
        }),
    });

    const error: unknown = await apiFetch('/samples', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );

    expect(errorMessage(error, LABELS)).toBe('Ошибка валидации данных: Первое поле');
    expect(errorFields(error)).toEqual({ alpha: 'Обязательное поле' });
  });

  it('номер обращения доезжает от сервера до текста тоста', async () => {
    // Сквозная проверка: `requestId` теряется молча — он проходит транспорт, разбор ошибки и
    // сборку сообщения, и на любом из трёх участков его легко не передать.
    mockHttp({
      'PATCH /vehicle-requests/:id/status': () =>
        apiError(500, {
          code: 'internal_error',
          message: 'Внутренняя ошибка сервера',
          requestId: 'req-42',
        }),
    });

    const error: unknown = await apiFetch('/vehicle-requests/r-1/status', {
      method: 'PATCH',
      body: {},
    }).catch((e: unknown) => e);

    expect(errorMessage(error, LABELS)).toBe('Внутренняя ошибка сервера (обращение req-42)');
  });

  it('доменная ошибка без полей — своим текстом', async () => {
    mockHttp({
      'DELETE /samples/:id': () =>
        apiError(409, { code: 'conflict', message: 'Запись используется' }),
    });

    const error: unknown = await apiFetch('/samples/s-1', { method: 'DELETE' }).catch(
      (e: unknown) => e,
    );

    expect(errorMessage(error, LABELS)).toBe('Запись используется');
    expect(errorFields(error)).toBeNull();
  });
});
