import { randomUUID } from 'node:crypto';
import { wasteTicketRecognitionResponseSchema } from '@technic/contracts';
import { PREPROCESSING_VERSION } from '../preprocess';
import { classifyHttpFailure, classifyTransportError, contentFailures } from './errors';
import { idempotencyKey, type AttemptKeyParts } from './keys';
import {
  MAX_TOKENS,
  PROMPT_VERSION,
  RESPONSE_JSON_SCHEMA,
  SYSTEM_PROMPT,
  USER_TEXT,
} from './prompt';
import type {
  AttemptMeta,
  PageImage,
  RecognitionEngine,
  RecognitionOutcome,
  RecognizeOptions,
} from './types';

/**
 * Боевой движок: обращение к модели через LLM-прокси заказчика
 * (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р3, Р5, Р7, Р12).
 *
 * **Это единственное место, откуда портал ходит к модели.** Не оборот речи: скилл прокси прямо
 * предупреждает, что пропущенная ветка вызова годами идёт мимо дедупа и оплачивается дважды, и
 * проверяется это грепом в чек-листе выката. Ключей провайдера у портала нет и не будет; из
 * браузера к прокси не обращаются никогда (CORS там нет вовсе) — вызывает только воркер.
 *
 * Что здесь важнее кода:
 *
 * - **`stream` не отправляется ни при каких обстоятельствах** (Р5): стриминг у прокси запрещён, и
 *   поле в теле — это гарантированный отказ на каждом запросе;
 * - **одна страница на запрос**: тело ограничено ~26 МБ, и пять страниц одним толстым запросом
 *   упёрлись бы в 413 там, где пять отдельных проходят;
 * - **схему просим, но верим только своей валидации** (Р4): `response_format` может не дойти до
 *   модели, поэтому ответ всегда проверяется `zod`-схемой контрактов, а невалидный JSON — это
 *   неуспешная попытка, а не «пустой результат»;
 * - **ошибка содержания и ошибка транспорта — разные вещи** и попадают в разные коды (`errors.ts`):
 *   первая говорит о модели на этой странице, вторая о сервисе целиком, и только вторая поднимает
 *   баннер;
 * - **`X-Request-Id` свой на каждую попытку, `X-Idempotency-Key` — на каждую работу**: первый
 *   отвечает на «какой это был запрос», второй — на «это та же работа?» (Р12).
 *
 * `PROXY_LLM_ACK_NO_PROVIDER_POLICY` сюда сознательно не передаётся: этой переменной нет в
 * документации прокси ни строкой, её выдал заказчик отдельно, и толковать флаг по названию нельзя
 * (Р6). Пока смысл не подтверждён оператором, портал его хранит, но не отправляет.
 */

export interface ProxyEngineConfig {
  /** `PROXY_LLM_BASE_URL` — без хвостового `/api/v1/...`: путь дописывается здесь. */
  baseUrl: string;
  /** `PROXY_LLM_TOKEN`. */
  token: string;
  /** `TICKET_OCR_HTTP_TIMEOUT_MS`: меньше дедлайна прокси (~190 с) и меньше таймаута транзакции. */
  timeoutMs: number;
  /** Предел тела запроса; по умолчанию с запасом к ~26 МБ прокси. */
  maxRequestBytes?: number;
  /** Подмена для тестов: боевой транспорт закрыт allowlist, и ходить в сеть тесты не должны. */
  fetchImpl?: typeof fetch;
  newRequestId?: () => string;
  now?: () => number;
}

/** Запас к пределу прокси: JSON, заголовки и base64 весят больше самой картинки. */
const DEFAULT_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Токены расхода: у прокси и OpenRouter имена полей разные, а колонка попытки одна (Р30). */
function readUsage(payload: Record<string, unknown>): ChatUsage {
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return { inputTokens: null, outputTokens: null };
  const u = usage as Record<string, unknown>;
  const num = (...names: string[]): number | null => {
    for (const name of names) {
      const value = u[name];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  return {
    inputTokens: num('prompt_tokens', 'input_tokens'),
    outputTokens: num('completion_tokens', 'output_tokens'),
  };
}

/**
 * Текст ответа модели.
 *
 * Мультимодальные модели отвечают то строкой, то массивом блоков, а некоторые посредники кладут
 * ответ в `text` вместо `message.content`. Разбираем все три: ответ, потерянный на форме конверта,
 * стоил бы оплаченной попытки и строки «модель ничего не прочитала».
 */
function readContent(choice: Record<string, unknown>): string {
  const message = choice.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'string') return block;
          if (block && typeof block === 'object') {
            const text = (block as Record<string, unknown>).text;
            if (typeof text === 'string') return text;
          }
          return '';
        })
        .join('');
    }
  }
  const text = choice.text;
  return typeof text === 'string' ? text : '';
}

/**
 * JSON из ответа модели.
 *
 * Модель просили отвечать голым JSON, но она вправе обернуть его в ```json или предварить фразой
 * «Вот результат:». Вытащить объект из такой обёртки — не послабление проверки: схема всё равно
 * применяется к результату целиком (Р4). Послаблением было бы принять неполный или иначе
 * устроенный объект, а этого здесь не происходит.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  if (body.startsWith('{')) return body;
  const from = body.indexOf('{');
  const to = body.lastIndexOf('}');
  return from >= 0 && to > from ? body.slice(from, to + 1) : body;
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

export function createProxyEngine(cfg: ProxyEngineConfig): RecognitionEngine {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const newRequestId = cfg.newRequestId ?? randomUUID;
  const now = cfg.now ?? Date.now;
  const maxRequestBytes = cfg.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`;

  return {
    kind: 'proxy',
    async recognize(page: PageImage, opts: RecognizeOptions): Promise<RecognitionOutcome> {
      const started = now();
      const parts: AttemptKeyParts = {
        pageSha256: page.sha256,
        engine: 'proxy',
        model: opts.model,
        promptVersion: PROMPT_VERSION,
        preprocessingVersion: PREPROCESSING_VERSION,
      };
      const requestId = newRequestId();
      const meta: AttemptMeta = {
        engine: 'proxy',
        model: opts.model,
        modelReported: '',
        promptVersion: PROMPT_VERSION,
        preprocessingVersion: PREPROCESSING_VERSION,
        inputTokens: null,
        outputTokens: null,
        durationMs: 0,
        proxyRequestId: '',
        upstreamRequestId: '',
        idempotencyKey: idempotencyKey(parts, opts),
        requestId,
      };
      const done = <T extends RecognitionOutcome>(outcome: T): T => {
        meta.durationMs = Math.max(0, Math.round(now() - started));
        return outcome;
      };

      const body = JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${page.mediaType};base64,${page.buffer.toString('base64')}`,
                },
              },
              { type: 'text', text: USER_TEXT },
            ],
          },
        ],
        response_format: { type: 'json_schema', json_schema: RESPONSE_JSON_SCHEMA },
        max_tokens: MAX_TOKENS,
        // Ноль не «поменьше фантазии», а воспроизводимость: без него две попытки на одной странице
        // дают разные цифры, и «перераспознать» невозможно отличить от ошибки чтения.
        temperature: 0,
        // `stream` здесь нет и быть не может (Р5) — прокси отвергает такие запросы целиком.
      });

      const bytes = Buffer.byteLength(body);
      if (bytes > maxRequestBytes) {
        // Отказ до отправки: 413 стоил бы оплаченного трафика и ничего не сообщил бы сверх этого.
        return done({
          status: 'failed',
          failure: contentFailures.payloadTooLarge(bytes, maxRequestBytes),
          meta,
        });
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, cfg.timeoutMs);

      let status = 0;
      let text = '';
      let headers: Headers | undefined;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${cfg.token}`,
            'x-idempotency-key': meta.idempotencyKey,
            'x-request-id': requestId,
          },
          body,
          signal: controller.signal,
        });
        status = res.status;
        headers = res.headers;
        // Идентификаторы снимаются до разбора тела: при 403 от nginx тела по делу нет вовсе, а
        // назвать оператору прокси всё равно что-то нужно.
        meta.proxyRequestId = res.headers.get('x-proxy-request-id') ?? '';
        meta.upstreamRequestId = res.headers.get('x-openrouter-request-id') ?? '';
        text = await res.text();
      } catch (err) {
        return done({ status: 'failed', failure: classifyTransportError(err, timedOut), meta });
      } finally {
        clearTimeout(timer);
      }

      if (status < 200 || status >= 300) {
        return done({
          status: 'failed',
          failure: classifyHttpFailure(status, text, headers, now()),
          meta,
        });
      }
      if (looksLikeHtml(text)) {
        return done({ status: 'failed', failure: contentFailures.htmlResponse(), meta });
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        return done({
          status: 'failed',
          failure: contentFailures.invalidJson(err instanceof Error ? err.message : String(err)),
          meta,
        });
      }

      // Фактическая модель и расход снимаются даже у неуспешной попытки: ответ, не прошедший
      // схему, всё равно оплачен, и метрика расхода без него врала бы в меньшую сторону (Р30).
      if (typeof payload.model === 'string') meta.modelReported = payload.model;
      const usage = readUsage(payload);
      meta.inputTokens = usage.inputTokens;
      meta.outputTokens = usage.outputTokens;

      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = choices[0];
      if (!choice || typeof choice !== 'object') {
        return done({ status: 'failed', failure: contentFailures.emptyResponse(), meta });
      }
      const first = choice as Record<string, unknown>;
      const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : '';
      const message = (first.message ?? {}) as Record<string, unknown>;
      if (typeof message.refusal === 'string' && message.refusal) {
        return done({ status: 'failed', failure: contentFailures.refused(message.refusal), meta });
      }
      if (finishReason === 'content_filter') {
        return done({ status: 'failed', failure: contentFailures.refused(finishReason), meta });
      }
      const content = readContent(first);
      if (!content.trim()) {
        return done({ status: 'failed', failure: contentFailures.emptyResponse(), meta });
      }
      if (finishReason === 'length') {
        return done({ status: 'failed', failure: contentFailures.truncated(), meta });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(content));
      } catch {
        return done({ status: 'failed', failure: contentFailures.invalidJson(content), meta });
      }

      const validated = wasteTicketRecognitionResponseSchema.safeParse(parsed);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        const where = issue ? `${issue.path.join('.') || 'ответ'}: ${issue.message}` : 'неизвестно';
        return done({ status: 'failed', failure: contentFailures.schemaMismatch(where), meta });
      }

      return done({ status: 'done', response: validated.data, meta });
    },
  };
}
