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
  /** Номер обращения из ответа сервера: по нему в логе находится причина пятисотки. */
  requestId?: string;
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
 *
 * У пятисотки к тексту добавляется номер обращения. В проде сервер прячет причину за общим
 * «Внутренняя ошибка сервера» (и правильно делает — в ней бывает SQL), а человеку остаётся
 * сообщение, с которым некуда прийти: воспроизвести его на чужом экране нечем. Номер из ответа —
 * это то, по чему причина находится в логе одной командой. У 4xx его не печатаем: там текст
 * называет проблему сам, и хвост из uuid только мешает читать.
 */
export function errorMessage(error: unknown, labels: Record<string, string> = {}): string {
  if (isApiErrorShape(error)) {
    const fields = errorFields(error);
    const text = fields
      ? `${error.message}: ${[...new Set(Object.keys(fields).map((path) => fieldLabel(path, labels)))].join(', ')}`
      : error.message;
    return error.status >= 500 && error.requestId
      ? `${text} (обращение ${error.requestId})`
      : text;
  }
  if (error instanceof Error) return error.message;
  return 'Произошла ошибка';
}
