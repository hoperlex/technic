/**
 * Сообщения об ошибках API: механизм здесь, подписи полей — у домена.
 *
 * Сервер присылает технические имена полей (`volumeM3`, `deliveryAt`), человеку же нужно название
 * из формы. Словарь подписей при этом целиком доменный: `objectId` и `deliveryAt` — про заявки,
 * `captchaToken` и `password` — про вход, `inn` и `synonyms` — про контрагентов. Нижнему слою
 * знать их неоткуда и незачем, поэтому словарь приходит параметром: одна сущность подписывает свои
 * поля, другая — свои, а разбор ответа и сборка текста общие.
 *
 * Глобального состояния здесь нет намеренно: реестр подписей «зарегистрируй свои поля при
 * загрузке» дал бы разный текст ошибки в зависимости от того, какие экраны успели подгрузиться.
 */

/**
 * Ошибка портала, как её собирает транспорт (`shared/api`). Проверка формы повторена здесь, а не
 * взята оттуда, из-за направления зависимостей внутри `shared`: `lib` не смотрит в `api` (это
 * запрещает линт границ), иначе фундамент срастётся в один узел. Признак тот же самый — `code` и
 * `status` в ответе, — и тест сверяет его с тем, что транспорт бросает на самом деле.
 */
interface ApiErrorShape {
  code: string;
  status: number;
  message: string;
  fields?: Record<string, string>;
}

function isApiErrorShape(error: unknown): error is ApiErrorShape {
  return typeof error === 'object' && error !== null && 'code' in error && 'status' in error;
}

/**
 * Поля с ошибками из ответа сервера (`validation_error` или доменная 400 с `fields`) — ровно
 * такими путями, какими их прислал сервер.
 *
 * Подписи сюда не передаются и передаваться не должны: по этим путям форма ищет свои поля
 * (`utils/formErrors`), сопоставляя их с именами `Form.Item`. Подставленная подпись сопоставление
 * сломала бы — ошибка перестала бы показываться на поле и осталась бы только тостом.
 */
export function errorFields(error: unknown): Record<string, string> | null {
  return isApiErrorShape(error) && error.fields && Object.keys(error.fields).length > 0
    ? error.fields
    : null;
}

function fieldLabel(path: string, labels: Record<string, string>): string {
  // zod присылает путь вида `vehicles.0.volumeM3` — для подписи важен последний сегмент.
  const last =
    path
      .split('.')
      .filter((s) => !/^\d+$/.test(s))
      .pop() ?? path;
  return labels[last] ?? last;
}

/**
 * Человекочитаемое сообщение об ошибке. У ошибок валидации сервер шлёт общий текст («Ошибка
 * валидации данных») и детали в `fields` — без них человек не понимает, что именно не так,
 * поэтому подписи полей добавляются к сообщению.
 *
 * Без словаря текст всё равно осмысленный: вместо подписи встанет имя поля с сервера. Это лучше
 * молчания — видно хотя бы, где искать.
 */
export function errorMessage(error: unknown, labels: Record<string, string> = {}): string {
  if (isApiErrorShape(error)) {
    const fields = errorFields(error);
    if (!fields) return error.message;
    const named = [...new Set(Object.keys(fields).map((path) => fieldLabel(path, labels)))];
    return `${error.message}: ${named.join(', ')}`;
  }
  if (error instanceof Error) return error.message;
  return 'Произошла ошибка';
}
