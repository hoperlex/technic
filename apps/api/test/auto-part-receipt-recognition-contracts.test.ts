import { describe, expect, it } from 'vitest';
import {
  mergeReceiptPages,
  receiptDraftFrom,
  receiptRecognitionResponseSchema,
  type ReceiptRecognitionResponse,
} from '@technic/contracts';

/**
 * Правила подстановки распознанного в форму чека (план `docs/auto-part-receipt-ocr-plan.md`,
 * Р3, Р9—Р11, Р10а).
 *
 * Файл проверяет ровно одно утверждение, и оно же главное в этой части выпуска: **портал не
 * обрезает и не округляет за человека**. Прочитанное, что не годится для чека, в поле не
 * попадает — оно остаётся в подсказке дословно, а решает человек.
 */

const TODAY = '2026-09-21';

function page(over: Partial<ReceiptRecognitionResponse> = {}): ReceiptRecognitionResponse {
  return receiptRecognitionResponseSchema.parse({
    documentNumber: '1138',
    purchasedOn: '2026-08-25',
    purchasedOnRaw: '25 августа 2026 г.',
    sellerName: 'ООО "МС-партс"',
    linesTotal: 5660,
    documentTotal: 5660,
    linesTruncated: false,
    lines: [{ article: 'ШМБС-18х27', name: 'Гидрозамок опоры', quantity: 2, amount: 5660 }],
    ...over,
  });
}

describe('ответ модели: схема прощает многословие, но не форму', () => {
  it('лишнее поле отбрасывается, а не роняет оплаченную страницу', () => {
    const parsed = receiptRecognitionResponseSchema.parse({
      documentNumber: '1',
      lines: [{ name: 'Фильтр', amount: 100, confidence: 0.9 }],
      comment: 'вот результат',
    });
    expect(parsed.lines[0]).not.toHaveProperty('confidence');
    // Умолчания: незаполненное моделью поле приходит `null`, а вид позиции — «деталь».
    expect(parsed.lines[0]!.article).toBeNull();
    expect(parsed.lines[0]!.kind).toBe('part');
    expect(parsed.linesTruncated).toBe(false);
  });

  it('дата не в формате `YYYY-MM-DD` — это неуспешная попытка, а не пустое поле', () => {
    expect(receiptRecognitionResponseSchema.safeParse({ purchasedOn: '25.08.2026' }).success).toBe(
      false,
    );
  });
});

describe('склейка страниц одного счёта (Р3)', () => {
  it('шапка — с первой, где прочитана; итоги — с последней; строки по порядку', () => {
    const merged = mergeReceiptPages([
      page({ linesTotal: null, documentTotal: null, lines: [] }),
      page({
        documentNumber: null,
        sellerName: null,
        purchasedOn: null,
        purchasedOnRaw: null,
        linesTotal: 83145,
        documentTotal: 83145,
        linesTruncated: true,
        lines: [
          { article: null, name: 'Шланг', quantity: 10, quantityRaw: '10.00', unit: 'шт', amount: 3650, kind: 'part' },
        ],
      }),
    ]);
    // Реквизиты печатают на первом листе: «последнее выигрывает» затёрло бы их пустотой второго.
    expect(merged.documentNumber).toBe('1138');
    expect(merged.sellerName).toBe('ООО "МС-партс"');
    // «Итого» стоит ПОД таблицей, то есть на последнем листе.
    expect(merged.linesTotal).toBe(83145);
    // Оборвана хоть одна страница — оборван счёт.
    expect(merged.linesTruncated).toBe(true);
    expect(merged.lines).toHaveLength(1);
  });
});

describe('черновик формы: что подставляется, а что остаётся человеку', () => {
  it('обычный счёт подставляется целиком, машина — никогда (Р2)', () => {
    const draft = receiptDraftFrom(page(), TODAY);
    expect(draft.header.documentNumber).toBe('1138');
    expect(draft.header.purchasedOn).toBe('2026-08-25');
    expect(draft.lines[0]).toMatchObject({ article: 'ШМБС-18х27', quantity: 2, amount: 5660 });
    expect(draft.lines[0]!.issues).toEqual([]);
    expect(draft.notes.draftTotal).toBe(5660);
  });

  it('дробное количество не подставляется и не округляется (Р10)', () => {
    const draft = receiptDraftFrom(
      page({ lines: [{ name: 'Масло', quantity: 4.75, quantityRaw: '4,75 л', amount: 3200 }] }),
      TODAY,
    );
    // Округление здесь переписало бы чек за механика: «4,75 л» заносят одной упаковкой, перенеся
    // объём в наименование.
    expect(draft.lines[0]!.quantity).toBeNull();
    expect(draft.lines[0]!.issues).toContain('quantityFraction');
    // Дословное чтение остаётся — ради него подсказка и существует.
    expect(draft.lines[0]!.quantityRaw).toBe('4,75 л');
  });

  it('дата в будущем не подставляется: форма такую не примет (Р11)', () => {
    const draft = receiptDraftFrom(page({ purchasedOn: '2026-12-31' }), TODAY);
    expect(draft.header.purchasedOn).toBe('');
    expect(draft.header.purchasedOnIssue).not.toBe('');
    expect(draft.header.purchasedOnRaw).toBe('25 августа 2026 г.');
  });

  it('что не влезает в границы чека — в подсказку, а не в поле (Р10а)', () => {
    const draft = receiptDraftFrom(
      page({
        documentNumber: 'Н'.repeat(101),
        sellerName: 'П'.repeat(201),
        lines: [
          { name: 'Ф'.repeat(301), article: 'A'.repeat(101), unit: 'е'.repeat(21), amount: 100 },
          { name: 'Свеча', quantity: 1, amount: 10.005 },
          { name: 'Ветошь', quantity: 1, amount: null },
        ],
      }),
      TODAY,
    );
    expect(draft.header.documentNumber).toBe('');
    expect(draft.header.sellerName).toBe('');
    expect(draft.lines[0]!.name).toBe('');
    expect(draft.lines[0]!.issues).toEqual(
      expect.arrayContaining(['nameTooLong', 'articleTooLong', 'unitTooLong']),
    );
    // Единица подписывает число: пустую заменяет то же умолчание, что и при ручном вводе.
    expect(draft.lines[0]!.unit).toBe('шт');
    expect(draft.lines[1]!.amount).toBeNull();
    expect(draft.lines[1]!.issues).toContain('amountKopecks');
    expect(draft.lines[2]!.issues).toContain('amountMissing');
  });

  it('строк больше сотни: подставляется сотня, остальные названы числом', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      name: `Позиция ${i + 1}`,
      quantity: 1,
      amount: 100,
    }));
    const draft = receiptDraftFrom(page({ lines: many }), TODAY);
    expect(draft.lines).toHaveLength(100);
    // Молча потерять двадцать позиций нельзя: портал предлагает завести вторую запись, и это
    // законно — уникальности у номера чека нет вовсе.
    expect(draft.notes.recognizedLines).toBe(120);
    expect(draft.notes.droppedLines).toBe(20);
  });

  it('итог с бумаги приходит рядом с суммой подставленного — ею и сверяют полноту (Р9)', () => {
    const draft = receiptDraftFrom(
      page({ linesTotal: 83145, documentTotal: 83145, lines: [{ name: 'Шланг', quantity: 1, amount: 3650 }] }),
      TODAY,
    );
    expect(draft.notes.linesTotal).toBe(83145);
    expect(draft.notes.draftTotal).toBe(3650);
    // Ни одно из этих чисел не сохранится: поля итога у чека нет вовсе, и это предупреждение живёт,
    // пока открыта форма.
  });
});
