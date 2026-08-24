import type {
  WasteTicketEngine,
  WasteTicketErrorClass,
  WasteTicketErrorScope,
  WasteTicketRecognitionResponse,
} from '@technic/contracts';

/**
 * Контракт движка распознавания (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р3).
 *
 * `recognize(pageImage) → { tickets[], unreadable[] }` — и **без изменяемых подсказок**. Это не
 * минимализм ради минимализма, а условие целостности кэша (Р12): вызов однозначно задаётся
 * содержимым страницы, движком, моделью и двумя версиями, и ровно из этих пяти величин собран ключ.
 * Добавь контракт параметр «подсказка» — два вызова с разными подсказками стали бы неразличимы
 * ключом и склеились бы: второй молча получил бы ответ первого. Выбор между «положить подсказки в
 * ключ» и «убрать их из контракта» сделан в пользу второго — меньше поверхности и нечему
 * разъезжаться.
 *
 * Промпт и схема поэтому одинаковы для всех проходов, **включая эскалацию** (Р14): старшая модель
 * получает то же самое задание, отличается только `model` — а она в ключ входит.
 *
 * Реализаций три: `stub` (тесты и разработка без сети и без расхода), `proxy` (боевая, единственное
 * место, откуда портал ходит наружу) и `ocr` (внешний OCR с детерминированным парсером — кандидат
 * замера, а не реализация: прокси проводит только `chat/completions`).
 */

/** Страница, как её видит движок: растр, его хэш и тип. Совместима с `PreparedPage`. */
export interface PageImage {
  /** `page_sha256` — хэш растра страницы (Р10). Входит в ключ кэша и идемпотентности. */
  sha256: string;
  buffer: Buffer;
  mediaType: string;
}

export interface RecognizeOptions {
  /** Заказанная модель: слаг каталога или заглушка `proxy` («выбирает прокси», Р7). */
  model: string;
  /**
   * Принудительный проход мимо кэша — кнопка «перераспознать» при тех же версиях промпта (Р13).
   * Меняет **ключ идемпотентности**: с прежним ключом дедуп прокси схлопнул бы вызов с исходным, и
   * «перераспознать» вернуло бы старый ответ, ничего не перераспознав.
   */
  forced?: boolean;
  /** Задача, ради которой идёт принудительный проход: она делает ключ идемпотентности разовым. */
  jobId?: string;
}

/**
 * Всё, что попытка обязана рассказать о себе наверх, — ровно колонки
 * `waste_ticket_recognition_attempts` (Р30).
 *
 * `modelReported` отдельно от `model` не для красоты: заказанная модель и фактическая — разные
 * величины (Р7), фактическую до вызова не знает никто, а метрики качества привязаны именно к ней.
 * `proxyRequestId` — то, что называют оператору прокси, когда разбираются, почему не работает;
 * `upstreamRequestId` — то, по чему вызов находится в биллинге OpenRouter.
 */
export interface AttemptMeta {
  engine: WasteTicketEngine;
  model: string;
  modelReported: string;
  promptVersion: number;
  preprocessingVersion: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  proxyRequestId: string;
  upstreamRequestId: string;
  /** Отправленный `X-Idempotency-Key`: он же ключ кэша попытки, если проход не принудительный. */
  idempotencyKey: string;
  /** `X-Request-Id` — свой на каждую попытку, включая повторы с тем же ключом идемпотентности. */
  requestId: string;
}

/**
 * Неуспешная попытка с обеими осями классификации (Р29).
 *
 * Оси именно две, и путать их дорого. `errorClass` отвечает «повторится ли само» и уезжает в текст
 * на экране: «попытка 3 из 5, следующая в 14:32» против «нужен администратор, автоматического
 * восстановления не будет». `errorScope` отвечает «чей сбой» и решает, поднимать ли **глобальный**
 * баннер: один упёршийся в лимит файл не означает, что сервис не настроен.
 *
 * `retryAfterMs` заполняется, когда прокси назвал срок сам (`Retry-After` при 503/429). Задача
 * переносится **ровно на него**, а не на наш backoff: очередь у прокси общая с чужими сервисами, и
 * наша вежливость — единственное, что мешает нам её занять.
 */
export interface RecognitionFailure {
  code: string;
  errorClass: WasteTicketErrorClass;
  errorScope: WasteTicketErrorScope;
  message: string;
  retryAfterMs: number | null;
}

/**
 * Исход попытки. Возвращается значением, а не исключением, намеренно: и успех, и отказ пишутся
 * **одной и той же строкой** `waste_ticket_recognition_attempts`, отличаясь статусом. Брось движок
 * исключение — вызывающему пришлось бы собирать `meta` (длительность, идентификаторы запросов,
 * фактическую модель) из воздуха, а именно она и нужна, когда разбираются с оператором прокси.
 */
export type RecognitionOutcome =
  | { status: 'done'; response: WasteTicketRecognitionResponse; meta: AttemptMeta }
  | { status: 'failed'; failure: RecognitionFailure; meta: AttemptMeta };

export interface RecognitionEngine {
  readonly kind: WasteTicketEngine;
  recognize(page: PageImage, opts: RecognizeOptions): Promise<RecognitionOutcome>;
}
