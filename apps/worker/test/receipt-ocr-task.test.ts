import { describe, expect, it } from 'vitest';
import { MAX_RECOGNIZED_RECEIPT_LINES, receiptRecognitionResponseSchema } from '@technic/contracts';
import { attemptCacheKey, idempotencyKey } from '../src/ocr-engine';
import { partReceiptTask } from '../src/receipt-ocr';
import { createReceiptStubEngine } from '../src/receipt-ocr/stub';
import { RECEIPT_LINE_PROPERTIES, RESPONSE_JSON_SCHEMA } from '../src/receipt-ocr/prompt';
import { wasteTicketTask } from '../src/ticket-ocr/task';

/**
 * Задание «чек на автозапчасти» и его место в общем движке
 * (план `docs/auto-part-receipt-ocr-plan.md`, Р6, Р8, Р17).
 */

const PAGE = {
  sha256: 'a'.repeat(64),
  buffer: Buffer.from('page'),
  mediaType: 'image/jpeg' as const,
};

const KEY = {
  pageSha256: PAGE.sha256,
  engine: 'proxy' as const,
  model: 'vendor/model-1',
  promptVersion: 1,
  preprocessingVersion: 1,
};

describe('слаг задания в ключе идемпотентности (Р6)', () => {
  it('у талонов строка НЕ меняется: умолчание даёт прежний ключ байт в байт', () => {
    // Главное утверждение этой части выпуска. Допиши мы задание в общую формулу — сменились бы
    // ключи ВСЕХ талонных вызовов разом, и работающий дедуп прокси перестал бы узнавать свои же
    // запросы.
    expect(idempotencyKey({ ...KEY, task: 'waste_ticket' })).toBe(idempotencyKey(KEY));
  });

  it('у чека ключ другой: один лист, прогнанный двумя заданиями, не склеивается дедупом', () => {
    expect(idempotencyKey({ ...KEY, task: 'part_receipt' })).not.toBe(idempotencyKey(KEY));
  });

  it('ключ КЭША задания не знает вовсе: кэши разделены таблицами, склеиться их строкам негде', () => {
    expect(attemptCacheKey({ ...KEY, task: 'part_receipt' })).toBe(attemptCacheKey(KEY));
  });

  it('принудительный проход получает свой ключ — иначе «заново» вернуло бы старый ответ', () => {
    const plain = idempotencyKey({ ...KEY, task: 'part_receipt' });
    const forced = idempotencyKey({ ...KEY, task: 'part_receipt' }, { forced: true, jobId: 'j1' });
    expect(forced).not.toBe(plain);
  });
});

describe('задание чека', () => {
  it('отличается от талонного слагом, промптом и потолком ответа (Р17)', () => {
    expect(partReceiptTask.slug).toBe('part_receipt');
    expect(wasteTicketTask.slug).toBe('waste_ticket');
    // У талона пять полей на бланк, у счёта — семь на каждую из сотни строк: обрезанный по
    // потолку ответ не проходит `JSON.parse` и при этом оплачен целиком.
    expect(partReceiptTask.maxTokens).toBeGreaterThan(wasteTicketTask.maxTokens);
    expect(partReceiptTask.systemPrompt).toMatch(/РУКОПИСНЫЕ ПОМЕТКИ НЕ ЧИТАЙ/);
    // Сумма против цены — самая частая ошибка на плотной таблице с двумя денежными графами.
    expect(partReceiptTask.systemPrompt).toMatch(/5 660,00/);
  });

  it('схема ответа в запросе знает все поля строки, которые ждёт контракт', () => {
    const schema = RESPONSE_JSON_SCHEMA.schema as {
      properties: { lines: { items: { required: string[]; maxItems?: number } } };
    };
    // Поле, добавленное в контракт и забытое здесь, модель просто не вернула бы — и обнаружилось
    // бы это на бумаге, а не в сборке.
    expect(schema.properties.lines.items.required).toEqual(Object.keys(RECEIPT_LINE_PROPERTIES));
    expect(schema.properties.lines.items.maxItems ?? 0).toBe(0);
  });

  it('потолок строк в ответе вдвое больше потолка чека: 120 позиций надо УВИДЕТЬ', () => {
    const lines = (RESPONSE_JSON_SCHEMA.schema as { properties: { lines: { maxItems: number } } })
      .properties.lines;
    expect(lines.maxItems).toBe(MAX_RECOGNIZED_RECEIPT_LINES);
    expect(MAX_RECOGNIZED_RECEIPT_LINES).toBeGreaterThan(100);
  });

  it('проверку ответа держит само задание: битый JSON — неуспешная попытка', () => {
    expect(partReceiptTask.parse({ lines: 'нет' }).success).toBe(false);
    expect(partReceiptTask.parse({ documentNumber: '1', lines: [] }).success).toBe(true);
  });
});

describe('заглушка чека', () => {
  it('отвечает по содержимому страницы, а не случайно', async () => {
    const stub = createReceiptStubEngine();
    const first = await stub.recognize(PAGE, { model: 'm' });
    const second = await stub.recognize(PAGE, { model: 'm' });
    expect(first.status).toBe('done');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('её ответ проходит ту же схему, что и ответ модели', async () => {
    const stub = createReceiptStubEngine();
    const outcome = await stub.recognize(PAGE, { model: 'm' });
    if (outcome.status !== 'done') throw new Error('заглушка обязана отвечать успехом');
    expect(receiptRecognitionResponseSchema.safeParse(outcome.response).success).toBe(true);
    // Слаг задания уехал в ключ идемпотентности и у заглушки: иначе тесты не заметили бы его
    // пропажи в боевом пути.
    expect(outcome.meta.idempotencyKey).not.toBe(
      idempotencyKey({ ...KEY, engine: 'stub', model: 'm' }),
    );
  });
});
