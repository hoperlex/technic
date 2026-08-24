import { createHash } from 'node:crypto';
import type { WasteTicketEngine } from '@technic/contracts';

/**
 * Ключ кэша попытки и ключ идемпотентности прокси (план `docs/waste-ticket-ocr-plan.md`, Р12, Р13).
 *
 * Это **один и тот же вопрос**, заданный дважды: «это та же работа?». Наш кэш отвечает на него,
 * чтобы не платить второй раз за уже прочитанную страницу; дедуп прокси — чтобы два воркера,
 * взявшихся за один лист одновременно, не сделали два вызова. Поэтому ключ и составлен одинаково.
 *
 * Важная оговорка, из-за которой кэш нельзя заменить дедупом прокси: дедуп схлопывает
 * **конкурентные** запросы, но не последовательный повтор через минуту — исходный вызов к тому
 * времени уже завершился. От повторной оплаты последовательных попыток спасает только наш кэш.
 */

export interface AttemptKeyParts {
  /** Хэш **растра страницы** (Р10), а не файла. */
  pageSha256: string;
  engine: WasteTicketEngine;
  /** Заказанная модель: фактическую (`model_reported`) до вызова не знает никто (Р7). */
  model: string;
  promptVersion: number;
  preprocessingVersion: number;
}

/**
 * Ключ кэша строкой — ровно тот кортеж, по которому в базе стоит частичный `UNIQUE`
 * (`page_sha256, engine, model, prompt_version, preprocessing_version`).
 *
 * Ключ полон именно потому, что контракт движка не принимает изменяемых подсказок (Р3). Появятся
 * подсказки или проходы с разным набором полей — сюда придётся добавить их хэш, иначе разные
 * вызовы склеятся.
 */
export function attemptCacheKey(parts: AttemptKeyParts): string {
  return [
    parts.pageSha256,
    parts.engine,
    parts.model,
    String(parts.promptVersion),
    String(parts.preprocessingVersion),
  ].join('|');
}

/**
 * `X-Idempotency-Key` для прокси.
 *
 * Обычный проход: `sha256(page_sha256|engine|model|prompt_version|preprocessing_version)` — тот же
 * ключ, что и у кэша, поэтому повтор задачи после разрыва сети не порождает второго вызова к
 * модели, пока прокси помнит первый.
 *
 * Принудительный (`forced`, кнопка «перераспознать» при тех же версиях, Р13): `sha256(базовый |
 * forced | jobId)`. Разовый ключ здесь обязателен — с прежним дедуп схлопнул бы принудительный
 * вызов с исходным и вернул бы старый ответ, то есть кнопка не делала бы ничего. `jobId`, а не
 * случайное число, чтобы повтор **той же** задачи после сбоя сети всё-таки попадал в дедуп: одна
 * задача — один оплаченный вызов.
 */
export function idempotencyKey(
  parts: AttemptKeyParts,
  forced?: { forced?: boolean; jobId?: string },
): string {
  const base = createHash('sha256').update(attemptCacheKey(parts)).digest('hex');
  if (!forced?.forced) return base;
  const jobId = forced.jobId ?? '';
  return createHash('sha256').update(`${base}|forced|${jobId}`).digest('hex');
}
