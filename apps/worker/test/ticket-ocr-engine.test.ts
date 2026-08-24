import { createHash } from 'node:crypto';
import {
  MAX_RECOGNIZED_TICKETS_PER_PAGE,
  WASTE_TICKET_FIELDS,
  WASTE_TICKET_WORK_KINDS,
  wasteTicketRecognitionResponseSchema,
} from '@technic/contracts';
import { describe, expect, it } from 'vitest';
import {
  createProxyEngine,
  createRecognitionEngine,
  createStubEngine,
  idempotencyKey,
  parseRetryAfter,
  PROMPT_VERSION,
  RESPONSE_JSON_SCHEMA,
  type PageImage,
  type RecognitionOutcome,
} from '../src/ticket-ocr/engine';
import { TICKET_ITEM_PROPERTIES } from '../src/ticket-ocr/engine/prompt';
import { PREPROCESSING_VERSION } from '../src/ticket-ocr/preprocess';

/**
 * Движок распознавания (план `docs/waste-ticket-ocr-plan.md`, Р3, Р4, Р5, Р12, Р13, Р29).
 *
 * В сеть здесь не ходит ни один тест, и не только из вежливости: боевой транспорт закрыт
 * IP-allowlist прокси и с машины разработки отвечает `403 Forbidden` **страницей nginx**, раньше,
 * чем проверяется токен. Поэтому `fetch` подменяется, а проверяется то, что от движка требуется
 * на самом деле: правильно собранное тело, правильные заголовки и — главное — правильно
 * разложенный отказ.
 *
 * Классификация проверяется по двум осям (Р29), потому что каждая ось управляет своим поведением
 * портала: `errorClass` решает, повторять ли задачу и что обещать человеку, `errorScope` — поднимать
 * ли **глобальный** баннер. Ошибка в первой означает вечное молчание или вечный повтор, во второй —
 * красный баннер «сервис не настроен» из-за одного тяжёлого скана.
 */

const PAGE: PageImage = {
  sha256: 'a'.repeat(64),
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  mediaType: 'image/jpeg',
};

const GOOD_ANSWER = JSON.stringify({
  id: 'chatcmpl-1',
  model: 'qwen/qwen2.5-vl-72b-instruct',
  usage: { prompt_tokens: 1200, completion_tokens: 90 },
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          tickets: [
            {
              number: 'ТЛ-123456',
              issuedOn: '2026-08-14',
              volumeM3: 12.5,
              workKind: 'removal',
              addressRaw: 'г. Новосибирск, ул. Строителей, 12',
            },
          ],
          unreadable: [],
        }),
      },
    },
  ],
});

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function engineWith(
  responder: (url: string, init: RequestInit) => Promise<Response>,
  captured: CapturedRequest[] = [],
  timeoutMs = 5_000,
) {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return await responder(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return createProxyEngine({
    baseUrl: 'https://llm.example.invalid/',
    token: 'secret-token',
    timeoutMs,
    fetchImpl,
    newRequestId: () => 'req-0001',
  });
}

const answering =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  async () =>
    new Response(body, { status, headers });

async function recognize(
  engine: ReturnType<typeof createProxyEngine>,
): Promise<RecognitionOutcome> {
  return await engine.recognize(PAGE, { model: 'test-model' });
}

describe('запрос к прокси', () => {
  it('собирается по контракту Р5: одна страница, схема, температура ноль', async () => {
    const captured: CapturedRequest[] = [];
    const engine = engineWith(answering(200, GOOD_ANSWER), captured);
    await recognize(engine);

    const request = captured[0]!;
    expect(request.url).toBe('https://llm.example.invalid/api/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer secret-token');
    expect(request.body.model).toBe('test-model');
    expect(request.body.temperature).toBe(0);
    expect(request.body.response_format).toMatchObject({ type: 'json_schema' });

    const messages = request.body.messages as { role: string; content: unknown }[];
    const user = messages[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(user[0]!.type).toBe('image_url');
    expect(user[0]!.image_url!.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('никогда не отправляет stream: прокси отвергает такие запросы целиком (Р5)', async () => {
    const captured: CapturedRequest[] = [];
    await recognize(engineWith(answering(200, GOOD_ANSWER), captured));
    expect(Object.keys(captured[0]!.body)).not.toContain('stream');
    expect(Object.keys(captured[0]!.body)).not.toContain('stream_options');
  });

  it('несёт ключ идемпотентности работы и свой идентификатор попытки (Р12)', async () => {
    const captured: CapturedRequest[] = [];
    await recognize(engineWith(answering(200, GOOD_ANSWER), captured));

    // Формула из Р12: sha256(page_sha256|engine|model|prompt_version|preprocessing_version).
    const expected = createHash('sha256')
      .update(`${PAGE.sha256}|proxy|test-model|${PROMPT_VERSION}|${PREPROCESSING_VERSION}`)
      .digest('hex');
    expect(captured[0]!.headers['x-idempotency-key']).toBe(expected);
    expect(captured[0]!.headers['x-request-id']).toBe('req-0001');
  });

  it('не отправляет страницу, которая заведомо не пройдёт по размеру', async () => {
    const captured: CapturedRequest[] = [];
    const engine = createProxyEngine({
      baseUrl: 'https://llm.example.invalid',
      token: 't',
      timeoutMs: 1000,
      maxRequestBytes: 128,
      fetchImpl: (async () => {
        captured.push({ url: '', headers: {}, body: {} });
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const outcome = await engine.recognize(
      { ...PAGE, buffer: Buffer.alloc(4096, 7) },
      { model: 'test-model' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.failure.code).toBe('payload_too_large');
    // 413 стоил бы оплаченного трафика и не сообщил бы ничего сверх того, что известно заранее.
    expect(captured).toHaveLength(0);
  });
});

describe('ключ идемпотентности принудительного прохода (Р13)', () => {
  const parts = {
    pageSha256: PAGE.sha256,
    engine: 'proxy' as const,
    model: 'test-model',
    promptVersion: 1,
    preprocessingVersion: 1,
  };

  it('обычный проход — тот же ключ, что и у кэша', () => {
    expect(idempotencyKey(parts)).toBe(idempotencyKey(parts, { forced: false }));
  });

  it('принудительный — другой, иначе дедуп вернул бы старый ответ', () => {
    const forced = idempotencyKey(parts, { forced: true, jobId: 'job-1' });
    expect(forced).not.toBe(idempotencyKey(parts));
    // Ключ привязан к задаче: повтор ТОЙ ЖЕ задачи после разрыва сети снова попадёт в дедуп, а
    // новое нажатие «перераспознать» — нет.
    expect(forced).toBe(idempotencyKey(parts, { forced: true, jobId: 'job-1' }));
    expect(forced).not.toBe(idempotencyKey(parts, { forced: true, jobId: 'job-2' }));
  });
});

describe('классификация отказов транспорта (Р5, Р29)', () => {
  it.each([
    [
      '403 страницей nginx',
      403,
      '<html><head><title>403 Forbidden</title></head></html>',
      {},
      'http_403',
      'terminal',
      'subsystem',
    ],
    [
      '401 по токену',
      401,
      '{"error":{"message":"unauthorized"}}',
      {},
      'http_401',
      'terminal',
      'subsystem',
    ],
    ['413 этой страницы', 413, 'Request Entity Too Large', {}, 'http_413', 'terminal', 'item'],
    [
      '503 переполненной очереди',
      503,
      '{"error":{"code":"queue_full"}}',
      {},
      'queue_full',
      'transient',
      'subsystem',
    ],
    [
      '504 по дедлайну',
      504,
      '{"error":{"message":"deadline"}}',
      {},
      'deadline_exceeded',
      'transient',
      'subsystem',
    ],
    [
      '429 по частоте',
      429,
      '{"error":{"message":"slow down"}}',
      {},
      'rate_limited',
      'transient',
      'subsystem',
    ],
    [
      '400 про стрим — это настройка',
      400,
      '{"error":{"message":"stream is not allowed"}}',
      {},
      'bad_request_config',
      'terminal',
      'subsystem',
    ],
    [
      '400 про содержимое — это файл',
      400,
      '{"error":{"message":"image is too blurry"}}',
      {},
      'bad_request',
      'terminal',
      'item',
    ],
  ])('%s', async (_name, status, body, headers, code, errorClass, errorScope) => {
    const outcome = await recognize(
      engineWith(answering(status as number, body as string, headers as Record<string, string>)),
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.code).toBe(code);
    expect(outcome.failure.errorClass).toBe(errorClass);
    expect(outcome.failure.errorScope).toBe(errorScope);
  });

  it('403 объясняет обе причины сразу: по ответу nginx их не различить', async () => {
    const outcome = await recognize(engineWith(answering(403, '<html>403 Forbidden</html>')));
    expect(outcome.status === 'failed' && outcome.failure.message).toMatch(/allowlist/);
    expect(outcome.status === 'failed' && outcome.failure.message).toMatch(/токен/);
  });

  it('уважает Retry-After: перенос ровно на названный срок, а не на наш backoff', async () => {
    const outcome = await recognize(
      engineWith(answering(503, '{"error":{"code":"queue_full"}}', { 'retry-after': '42' })),
    );
    expect(outcome.status === 'failed' && outcome.failure.retryAfterMs).toBe(42_000);
  });

  it('разбирает Retry-After и датой, и секундами, и не ждёт вечность', () => {
    const now = Date.parse('2026-08-21T10:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('Fri, 21 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Fri, 21 Aug 2026 09:59:30 GMT', now)).toBe(0);
    expect(parseRetryAfter('через час', now)).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('свой таймаут — про этот скан, оборванная связь — про сервис', async () => {
    const hanging = engineWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      [],
      5,
    );
    const timedOut = await recognize(hanging);
    expect(timedOut.status === 'failed' && timedOut.failure.code).toBe('attempt_timeout');
    expect(timedOut.status === 'failed' && timedOut.failure.errorScope).toBe('item');

    const broken = engineWith(() => Promise.reject(new TypeError('fetch failed')));
    const network = await recognize(broken);
    expect(network.status === 'failed' && network.failure.code).toBe('network_error');
    expect(network.status === 'failed' && network.failure.errorScope).toBe('subsystem');
    expect(network.status === 'failed' && network.failure.errorClass).toBe('transient');
  });
});

describe('разбор ответа модели (Р4)', () => {
  it('успешный ответ отдаёт талоны, фактическую модель, токены и идентификаторы', async () => {
    const outcome = await recognize(
      engineWith(
        answering(200, GOOD_ANSWER, {
          'x-proxy-request-id': 'proxy-42',
          'x-openrouter-request-id': 'or-77',
        }),
      ),
    );
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.response.tickets[0]!.number).toBe('ТЛ-123456');
    expect(outcome.response.unreadable).toEqual([]);
    // Заказанная и фактическая модели — разные величины (Р7): расхождение человек должен видеть.
    expect(outcome.meta.model).toBe('test-model');
    expect(outcome.meta.modelReported).toBe('qwen/qwen2.5-vl-72b-instruct');
    expect(outcome.meta.inputTokens).toBe(1200);
    expect(outcome.meta.outputTokens).toBe(90);
    expect(outcome.meta.proxyRequestId).toBe('proxy-42');
    expect(outcome.meta.upstreamRequestId).toBe('or-77');
    expect(outcome.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('достаёт JSON из markdown-обёртки, но проверяет его той же схемой', async () => {
    const fenced = JSON.stringify({
      model: 'm',
      choices: [
        {
          message: {
            content:
              '```json\n{"tickets":[{"number":"1","issuedOn":null,"volumeM3":null,"workKind":"idle","addressRaw":null}],"unreadable":["volumeM3"]}\n```',
          },
        },
      ],
    });
    const outcome = await recognize(engineWith(answering(200, fenced)));
    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' && outcome.response.unreadable).toEqual(['volumeM3']);
  });

  it.each([
    ['ответ не JSON вовсе', 'совсем не json', 'invalid_json'],
    [
      'талон без обязательных полей',
      '{"tickets":[{"number":"1"}],"unreadable":[]}',
      'schema_mismatch',
    ],
    [
      'номер числом вместо строки',
      '{"tickets":[{"number":7,"issuedOn":null,"volumeM3":null,"workKind":"removal","addressRaw":null}],"unreadable":[]}',
      'schema_mismatch',
    ],
    [
      'выдуманное имя поля в unreadable',
      '{"tickets":[],"unreadable":["carrier"]}',
      'schema_mismatch',
    ],
    [
      'дата не в формате YYYY-MM-DD',
      '{"tickets":[{"number":"1","issuedOn":"14.08.2026","volumeM3":null,"workKind":"removal","addressRaw":null}],"unreadable":[]}',
      'schema_mismatch',
    ],
  ])('%s — это неуспешная попытка, а не пустой результат', async (_name, content, code) => {
    const body = JSON.stringify({ model: 'm', choices: [{ message: { content } }] });
    const outcome = await recognize(engineWith(answering(200, body)));
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.code).toBe(code);
    // Ошибка содержания — про эту страницу, а не про сервис: глобальный баннер она не поднимает.
    expect(outcome.failure.errorScope).toBe('item');
  });

  it('пустой ответ и ответ без содержимого различает от «модель ничего не нашла»', async () => {
    const noChoices = await recognize(engineWith(answering(200, '{"model":"m","choices":[]}')));
    expect(noChoices.status === 'failed' && noChoices.failure.code).toBe('empty_response');

    const empty = JSON.stringify({ model: 'm', choices: [{ message: { content: '   ' } }] });
    const blank = await recognize(engineWith(answering(200, empty)));
    expect(blank.status === 'failed' && blank.failure.code).toBe('empty_response');

    // А вот пустой массив талонов — законный ответ: на кадре бывает шапка бланка без талонов.
    const none = JSON.stringify({
      model: 'm',
      choices: [{ message: { content: '{"tickets":[],"unreadable":[]}' } }],
    });
    const outcome = await recognize(engineWith(answering(200, none)));
    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' && outcome.response.tickets).toEqual([]);
  });

  it('обрезанный по пределу токенов ответ повторять бессмысленно', async () => {
    const truncated = JSON.stringify({
      model: 'm',
      choices: [{ finish_reason: 'length', message: { content: '{"tickets":[{"number":"ТЛ' } }],
    });
    const outcome = await recognize(engineWith(answering(200, truncated)));
    expect(outcome.status === 'failed' && outcome.failure.code).toBe('response_truncated');
    expect(outcome.status === 'failed' && outcome.failure.errorClass).toBe('terminal');
  });

  it('HTML вместо JSON при 200 — это посредник на пути, а не ответ модели', async () => {
    const outcome = await recognize(engineWith(answering(200, '<!doctype html><html>hi</html>')));
    expect(outcome.status === 'failed' && outcome.failure.code).toBe('html_response');
    expect(outcome.status === 'failed' && outcome.failure.errorScope).toBe('subsystem');
  });

  it('расход снимает даже с неуспешной попытки: ответ оплачен в любом случае (Р30)', async () => {
    const body = JSON.stringify({
      model: 'facts/other-model',
      usage: { prompt_tokens: 800, completion_tokens: 10 },
      choices: [{ message: { content: 'не json' } }],
    });
    const outcome = await recognize(engineWith(answering(200, body)));
    expect(outcome.status).toBe('failed');
    expect(outcome.meta.modelReported).toBe('facts/other-model');
    expect(outcome.meta.inputTokens).toBe(800);
  });
});

describe('заглушка (Р3)', () => {
  const stub = createStubEngine();

  it('отвечает одинаково на одну и ту же страницу', async () => {
    const first = await stub.recognize(PAGE, { model: 'stub-model' });
    const second = await stub.recognize(PAGE, { model: 'stub-model' });
    expect(first.status).toBe('done');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('отвечает по той же схеме, что и модель', async () => {
    const outcome = await stub.recognize({ ...PAGE, sha256: 'f3'.repeat(32) }, { model: 'm' });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(wasteTicketRecognitionResponseSchema.safeParse(outcome.response).success).toBe(true);
    expect(outcome.meta.engine).toBe('stub');
    // У заглушки расхождения моделей не бывает: заказали — она и отработала.
    expect(outcome.meta.modelReported).toBe('m');
  });

  it('разные страницы читает по-разному', async () => {
    const one = await stub.recognize({ ...PAGE, sha256: '1'.repeat(64) }, { model: 'm' });
    const two = await stub.recognize({ ...PAGE, sha256: '9c'.repeat(32) }, { model: 'm' });
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  });

  it('умеет отдать заранее заданный отказ — тестам сверки нужен и он', async () => {
    const scripted = createStubEngine({
      scripted: new Map([
        [
          PAGE.sha256,
          {
            status: 'failed' as const,
            failure: {
              code: 'http_403',
              errorClass: 'terminal' as const,
              errorScope: 'subsystem' as const,
              message: 'нет доступа',
              retryAfterMs: null,
            },
          },
        ],
      ]),
    });
    const outcome = await scripted.recognize(PAGE, { model: 'm' });
    expect(outcome.status === 'failed' && outcome.failure.code).toBe('http_403');
  });

  it('выбирается режимом провайдера, а прокси без адреса не заводится', () => {
    expect(createRecognitionEngine({ mode: 'stub' }).kind).toBe('stub');
    expect(() => createRecognitionEngine({ mode: 'proxy' })).toThrow(/PROXY_LLM_BASE_URL/);
  });
});

describe('схема ответа в запросе (Р4)', () => {
  it('перечисляет ровно те поля, что описаны контрактом', () => {
    expect(Object.keys(TICKET_ITEM_PROPERTIES)).toEqual([...WASTE_TICKET_FIELDS]);
    expect(TICKET_ITEM_PROPERTIES.workKind!.enum).toEqual([...WASTE_TICKET_WORK_KINDS]);

    const schema = RESPONSE_JSON_SCHEMA.schema as Record<string, Record<string, never>>;
    const tickets = schema.properties!.tickets as unknown as Record<string, unknown>;
    expect(tickets.maxItems).toBe(MAX_RECOGNIZED_TICKETS_PER_PAGE);
    const items = tickets.items as Record<string, unknown>;
    expect(items.required).toEqual([...WASTE_TICKET_FIELDS]);
    // Строгий режим включается только с этим: без него модель вправе дописать своё поле.
    expect(items.additionalProperties).toBe(false);
  });
});
