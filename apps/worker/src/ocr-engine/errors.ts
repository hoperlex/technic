import type { WasteTicketErrorClass, WasteTicketErrorScope } from '@technic/contracts';
import type { RecognitionFailure } from './types';

/**
 * Классификация отказов прокси по двум осям (план `docs/waste-ticket-ocr-plan.md`, Р5, Р29).
 *
 * Здесь единственное место, где HTTP-ответ превращается в решение портала, и решений три сразу:
 * повторять ли задачу, поднимать ли глобальный баннер и что написать человеку в строке талона.
 *
 * |              | `transient`                                   | `terminal`                                        |
 * | ---          | ---                                           | ---                                               |
 * | `subsystem`  | 503, 504, сеть, стоящий воркер → баннер по порогу | 401, 403, «стрим запрещён», сломанный конфиг → баннер до вмешательства |
 * | `item`       | таймаут на одном тяжёлом скане → только строка талона | 413 этого файла, содержательный 400 → строка, баннера нет |
 *
 * Две тонкости, ради которых таблица и расписана.
 *
 * **403 приходит HTML-ом от nginx**, а не JSON от прокси, и приходит **до** проверки токена
 * (проверено 18.08.2026): отличить «нашего адреса нет в allowlist» от «неверный токен» по нему
 * нельзя. Поэтому текст ошибки говорит про обе причины сразу и зовёт администратора, а класс —
 * `terminal` + `subsystem`: повтора не будет, баннер поднимается немедленно, не дожидаясь порога.
 *
 * **413 — это про файл, а не про сервис.** Один упёршийся в лимит скан не означает, что
 * распознавание сломано, и прежнее правило, поднимавшее на нём глобальный красный баннер навсегда,
 * было ровно этой ошибкой. Поэтому у 413 область `item`: строка талона и реестр, баннера нет.
 */

export function failure(
  code: string,
  errorClass: WasteTicketErrorClass,
  errorScope: WasteTicketErrorScope,
  message: string,
  retryAfterMs: number | null = null,
): RecognitionFailure {
  return { code, errorClass, errorScope, message, retryAfterMs };
}

/** Дольше этого ждать не станем даже по просьбе прокси: дальше начинается «никогда». */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * `Retry-After` в миллисекундах — секундами или датой, как разрешает HTTP.
 *
 * Заголовок уважается буквально (Р5): при 503 `queue_full` задача переносится **ровно на
 * указанный срок**, а не на наш backoff. Очередь у прокси общая с чужими сервисами, и наш backoff
 * в две секунды означал бы, что мы её и занимаем.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

/** Похоже ли тело на страницу nginx, а не на ответ прокси. */
function looksLikeHtml(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<title>');
}

/**
 * Код ошибки из тела, если он там есть.
 *
 * «Если есть» — существенная оговорка: ошибки OpenRouter приходят **без конверта** `{error:{code}}`
 * (Р5), так что разбор идёт по HTTP-статусу, а `error.code` только уточняет его — `queue_full` и
 * `dedup_full` при 503 различают «занята очередь» и «переполнен дедуп», и в журнале это разные
 * поводы для разговора с оператором.
 */
function bodyErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const err = (parsed as { error?: unknown }).error;
      if (err && typeof err === 'object') {
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string' && code) return code;
        if (typeof code === 'number') return String(code);
      }
      const top = (parsed as { code?: unknown }).code;
      if (typeof top === 'string' && top) return top;
    }
  } catch {
    // тело не JSON — это нормально: nginx отвечает HTML, а прокси иногда простым текстом
  }
  return null;
}

/** Короткая выжимка тела для журнала: целиком его хранить незачем, HTML nginx — тем более. */
function snippet(body: string, limit = 300): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Приметы сломанной **настройки** в теле 400: такие 400 относятся к подсистеме, а не к файлу.
 *
 * Различие не теоретическое. «Стрим запрещён» или «неизвестная модель» означает, что портал
 * настроен неверно и так будет с каждым сканом — баннер и администратор. А 400 про содержимое
 * (слишком длинное сообщение, битая картинка) касается одной страницы, и глобальный баннер на нём
 * означал бы «распознавание не настроено» при исправно работающем сервисе.
 */
const CONFIG_MARKERS =
  /stream|not\s+allowed|unsupported\s+parameter|unknown\s+model|invalid\s+model|no\s+such\s+model|model_not_found|provider|transforms|plugins|no\s+endpoints/i;

/** HTTP-ответ прокси → отказ с двумя осями (Р5, Р29). */
export function classifyHttpFailure(
  status: number,
  body: string,
  headers?: { get(name: string): string | null },
  now = Date.now(),
): RecognitionFailure {
  const retryAfter = parseRetryAfter(headers?.get('retry-after'), now);
  const code = bodyErrorCode(body);
  const tail = snippet(body);

  if (status === 400) {
    return CONFIG_MARKERS.test(body)
      ? failure(
          code ?? 'bad_request_config',
          'terminal',
          'subsystem',
          `Прокси отклонил запрос как неверный (400): ${tail}. Это настройка портала — нужен администратор.`,
        )
      : failure(
          code ?? 'bad_request',
          'terminal',
          'item',
          `Прокси отклонил запрос по этой странице (400): ${tail}.`,
        );
  }
  if (status === 401) {
    return failure(
      'http_401',
      'terminal',
      'subsystem',
      'Прокси не принял токен (401) — распознавание не настроено, нужен администратор.',
    );
  }
  if (status === 402) {
    return failure(
      code ?? 'http_402',
      'terminal',
      'subsystem',
      'Прокси отказал по оплате (402) — обращение к оператору прокси.',
    );
  }
  if (status === 403) {
    /*
     * Тот самый nginx: HTML вместо JSON и проверка адреса раньше проверки токена. Обе причины
     * названы в тексте намеренно — по ответу они неразличимы, и гадать за администратора значит
     * отправить его чинить не то.
     */
    return failure(
      'http_403',
      'terminal',
      'subsystem',
      looksLikeHtml(body)
        ? 'Прокси ответил отказом доступа (403) страницей nginx: адрес воркера не в allowlist либо неверен токен. Нужен администратор.'
        : `Прокси ответил отказом доступа (403): ${tail}. Нужен администратор.`,
    );
  }
  if (status === 404 || status === 405) {
    return failure(
      `http_${status}`,
      'terminal',
      'subsystem',
      `Адрес прокси отвечает ${status} — проверьте PROXY_LLM_BASE_URL.`,
    );
  }
  if (status === 408) {
    return failure(
      'http_408',
      'transient',
      'subsystem',
      'Прокси не дождался запроса (408) — попробуем ещё раз.',
      retryAfter,
    );
  }
  if (status === 413) {
    // Про этот файл, не про сервис: страница слишком тяжёлая даже после ресайза.
    return failure(
      'http_413',
      'terminal',
      'item',
      'Прокси отклонил страницу как слишком большую (413) — уменьшите разрешение скана.',
    );
  }
  if (status === 415 || status === 422) {
    return failure(
      code ?? `http_${status}`,
      'terminal',
      'item',
      `Прокси не принял содержимое страницы (${status}): ${tail}.`,
    );
  }
  if (status === 429) {
    return failure(
      code ?? 'rate_limited',
      'transient',
      'subsystem',
      'Прокси ограничил частоту обращений (429).',
      retryAfter,
    );
  }
  if (status === 503) {
    // `queue_full` и `dedup_full` — штатная перегрузка общей очереди, а не сбой.
    return failure(
      code ?? 'http_503',
      'transient',
      'subsystem',
      `Прокси временно недоступен (503${code ? `, ${code}` : ''}).`,
      retryAfter,
    );
  }
  if (status === 504) {
    return failure(
      code ?? 'deadline_exceeded',
      'transient',
      'subsystem',
      'Прокси не уложился в дедлайн (504) — попытка будет повторена.',
      retryAfter,
    );
  }
  if (status >= 500) {
    return failure(
      code ?? `http_${status}`,
      'transient',
      'subsystem',
      `Прокси ответил ошибкой ${status}: ${tail}.`,
      retryAfter,
    );
  }
  // Прочие 4xx — про этот запрос, а не про сервис: повторять нечего, баннер поднимать не за что.
  return failure(
    code ?? `http_${status}`,
    'terminal',
    'item',
    `Прокси отклонил запрос (${status}): ${tail}.`,
  );
}

/**
 * Отказ, не дошедший до ответа: оборванное соединение, DNS, наш собственный срок.
 *
 * Свой таймаут и сетевой сбой разведены по областям сознательно. Наш срок вышел — это, скорее
 * всего, тяжёлый скан, на который модель думала дольше обычного: `item`, строка талона, повтор
 * (Р29, «таймаут на одном тяжёлом скане»). А оборванное соединение — это про сервис целиком:
 * `subsystem`, и такие как раз считаются в доле, поднимающей баннер по порогу.
 */
export function classifyTransportError(err: unknown, timedOut: boolean): RecognitionFailure {
  const text = err instanceof Error ? err.message : String(err);
  if (timedOut) {
    return failure(
      'attempt_timeout',
      'transient',
      'item',
      'Ответ от прокси не пришёл за отведённое время — попытка будет повторена.',
    );
  }
  return failure(
    'network_error',
    'transient',
    'subsystem',
    `Прокси недоступен: ${snippet(text, 200)}`,
  );
}

/**
 * Отказы **содержания**: ответ пришёл, но читать в нём нечего (Р4).
 *
 * Это не транспорт, и путать их нельзя: транспортный сбой говорит о сервисе, содержательный — о
 * модели на этой странице. Поэтому область у всех них `item`, а класс различается по тому, даст ли
 * повтор другой результат: обрезанный по `max_tokens` ответ будет обрезан и в следующий раз
 * (`terminal`), а сорвавшаяся в текст вместо JSON модель при повторе вполне может ответить
 * правильно (`transient`).
 */
export const contentFailures = {
  invalidJson: (detail: string): RecognitionFailure =>
    failure(
      'invalid_json',
      'transient',
      'item',
      `Модель ответила не JSON: ${snippet(detail, 200)}`,
    ),
  schemaMismatch: (detail: string): RecognitionFailure =>
    failure(
      'schema_mismatch',
      'transient',
      'item',
      `Ответ модели не прошёл проверку схемы: ${snippet(detail, 200)}`,
    ),
  emptyResponse: (): RecognitionFailure =>
    failure('empty_response', 'transient', 'item', 'Прокси вернул ответ без содержимого.'),
  truncated: (): RecognitionFailure =>
    failure(
      'response_truncated',
      'terminal',
      'item',
      'Ответ модели обрезан по пределу токенов — на этой странице слишком много текста.',
    ),
  refused: (reason: string): RecognitionFailure =>
    failure(
      'content_filter',
      'terminal',
      'item',
      `Модель отказалась читать изображение: ${snippet(reason, 200)}`,
    ),
  htmlResponse: (): RecognitionFailure =>
    failure(
      'html_response',
      'terminal',
      'subsystem',
      'Вместо ответа прокси пришла HTML-страница — на пути стоит посредник, нужен администратор.',
    ),
  payloadTooLarge: (bytes: number, limit: number): RecognitionFailure =>
    failure(
      'payload_too_large',
      'terminal',
      'item',
      `Страница не отправлена: ${Math.round(bytes / 1024 / 1024)} МБ при пределе ${Math.round(limit / 1024 / 1024)} МБ.`,
    ),
};
