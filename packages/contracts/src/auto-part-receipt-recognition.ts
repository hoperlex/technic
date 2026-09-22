/**
 * Распознавание чека на автозапчасти: что портал просит у модели, что получает и во что это
 * превращается в форме (план `docs/auto-part-receipt-ocr-plan.md`, Р1, Р8—Р11, Р10а).
 *
 * ГЛАВНОЕ ОТЛИЧИЕ ОТ ТАЛОНОВ, из которого следует весь файл: **сверять не с чем**. У талона есть
 * заявка — её объём, дата и адрес, — и ради сверки с ней там построен целый контур: подтверждение
 * каждого талона человеком, статусы, уникальность номера. У чека эталона нет вовсе: бумага сама и
 * есть первоисточник. Поэтому здесь нет ни подтверждения, ни очереди разбора — распознанное живёт
 * в форме до нажатия «Сохранить» и становится обычным чеком, неотличимым от набранного руками.
 *
 * Отсюда же место правил подстановки. Они здесь, а не в портале, потому что отвечают на вопрос
 * «годится ли прочитанное для чека» — а это вопрос к тем же границам, которыми чек описан рядом
 * (`RECEIPT_MAX_LINES`, `RECEIPT_MAX_QUANTITY`, потолки полей). Живи они в окне, второе правило
 * разъехалось бы с первым молча: форма подставила бы дробное количество, а схема отбила бы его.
 */

import { z } from 'zod';
import {
  RECEIPT_MAX_AMOUNT,
  RECEIPT_MAX_LINES,
  RECEIPT_MAX_QUANTITY,
  RECEIPT_FUTURE_DATE_MESSAGE,
} from './auto-part-receipts';
import { dateOnlySchema } from './common';
import type { RecognitionErrorClass, RecognitionErrorScope } from './recognition';

// ── Что мы просим у модели ──

/**
 * Что это за позиция по смыслу (Р3а). Признак нужен ровно для одного — покрасить строку, не
 * похожую на запчасть: в одном счёте с гидрозамками едут доставка, работы и канцелярия.
 *
 * Даёт его **модель**, а не словарь ключевых слов в портале: словарь пришлось бы вести, и он
 * разошёлся бы с жизнью на первом же «шиномонтаже» внутри наименования детали. И это **мнение**, а
 * не факт: снимает строку человек, а сохранить её вместе со всеми законно и ничего не требует.
 */
export const RECEIPT_LINE_KINDS = ['part', 'service', 'other'] as const;
export type ReceiptLineKind = (typeof RECEIPT_LINE_KINDS)[number];

/**
 * Потолок строк в ответе модели — предохранитель от зациклившейся модели, а не граница предмета.
 * Он НАРОЧНО вдвое больше `RECEIPT_MAX_LINES` (100): счёт на 120 позиций законен, и портал обязан
 * увидеть все 120, чтобы сказать «в чек помещается сотня, заведите вторую запись» (Р10а). Обрежь
 * мы ответ по сотне — предупреждение было бы нечем обосновать.
 */
export const MAX_RECOGNIZED_RECEIPT_LINES = 200;

/** Строка таблицы, как её вернула модель: ещё не строка чека, а прочитанное с бумаги. */
export const receiptRecognitionLineSchema = z
  .object({
    /** Пусто и `null` здесь равнозначны: графы артикула нет у доброй половины бумаг. */
    article: z.string().max(200).nullable().default(null),
    name: z.string().max(1000).nullable().default(null),
    /** Число как напечатано: дробное законно в бумаге и незаконно в чеке — решает `draft` ниже. */
    quantity: z.number().finite().nullable().default(null),
    quantityRaw: z.string().max(50).nullable().default(null),
    unit: z.string().max(50).nullable().default(null),
    /** Сумма строки, а не цена за единицу (Р9): в счёте это крайнее правое число. */
    amount: z.number().finite().nullable().default(null),
    kind: z.enum(RECEIPT_LINE_KINDS).default('part'),
  })
  .strip();
export type ReceiptRecognitionLine = z.infer<typeof receiptRecognitionLineSchema>;

/**
 * Ответ модели на одну страницу. Схему просим у прокси (`response_format`), но верим только этой
 * проверке: строгий режим поддержан не всеми моделями каталога, а посредников в цепочке двое.
 * Невалидный ответ — неуспешная попытка, а не «ничего не прочитано».
 *
 * `.strip()`, а не `.strict()`: лишнее поле в ответе МОДЕЛИ — это её многословие, а не ошибка
 * клиента, и терять из-за него оплаченную страницу незачем. (В схемах ввода портала всё наоборот:
 * там `.strict()`, потому что лишнее поле означает непонятое намерение человека.)
 */
export const receiptRecognitionResponseSchema = z
  .object({
    documentNumber: z.string().max(200).nullable().default(null),
    /** Нормализованная дата документа; век двузначного года выбирает модель, а портал проверяет. */
    purchasedOn: dateOnlySchema.nullable().default(null),
    /** Та же дата ДОСЛОВНО: «25 августа 2026 г.», «09.09.26» — на случай, когда первая не годится. */
    purchasedOnRaw: z.string().max(100).nullable().default(null),
    sellerName: z.string().max(500).nullable().default(null),
    /** «Итого» под таблицей — им проверяется полнота распознавания (Р9). */
    linesTotal: z.number().finite().nullable().default(null),
    /** «Всего к оплате»; отличается от `linesTotal`, когда НДС начислен сверх таблицы. */
    documentTotal: z.number().finite().nullable().default(null),
    /** Таблица продолжается за краем кадра: строк меньше, чем на бумаге. */
    linesTruncated: z.boolean().default(false),
    lines: z.array(receiptRecognitionLineSchema).max(MAX_RECOGNIZED_RECEIPT_LINES).default([]),
  })
  .strip();
export type ReceiptRecognitionResponse = z.infer<typeof receiptRecognitionResponseSchema>;

// ── Во что это превращается в форме ──

/**
 * Почему поле не подставилось. Портал показывает это подсказкой рядом с пустой ячейкой и кладёт
 * туда же дословное чтение — человек видит, что на бумаге, и вписывает сам.
 *
 * Пустой список — всё прочитанное годится. Правило на все случаи одно: **портал не обрезает и не
 * округляет за человека** (Р10, Р10а). Обрезанное наименование в карточке выглядит как полное, и
 * отличить его потом нечем; округлённое количество — это переписанный за механика чек.
 */
export const RECEIPT_DRAFT_ISSUES = [
  'quantityFraction',
  'quantityRange',
  'amountMissing',
  'amountRange',
  'amountKopecks',
  'nameMissing',
  'nameTooLong',
  'articleTooLong',
  'unitTooLong',
] as const;
export type ReceiptDraftIssue = (typeof RECEIPT_DRAFT_ISSUES)[number];

/** Строка черновика: то, что встанет в форму, плюс дословное чтение для подсказки. */
export interface ReceiptDraftLine {
  article: string;
  name: string;
  /** `null` — в поле ничего не подставляется: человек вписывает сам, глядя на `quantityRaw`. */
  quantity: number | null;
  quantityRaw: string;
  unit: string;
  amount: number | null;
  kind: ReceiptLineKind;
  issues: ReceiptDraftIssue[];
}

/** Шапка черновика. Пустое поле значит «не подставляем», а не «в бумаге пусто». */
export interface ReceiptDraftHeader {
  documentNumber: string;
  /** `YYYY-MM-DD` либо пусто: дата в будущем формой не принимается и потому не подставляется. */
  purchasedOn: string;
  purchasedOnRaw: string;
  /** Почему дата не подставилась — та же фраза, что скажет форма при ручном вводе (ADR 0094). */
  purchasedOnIssue: string;
  sellerName: string;
}

/**
 * Что показать над таблицей (Р9). Все три — предупреждения, и ни одно не мешает сохранить чек:
 * бумага бывает с позициями, которых в портал не заносят.
 */
export interface ReceiptDraftNotes {
  /** «Итого» с бумаги; `null` — не прочитано. */
  linesTotal: number | null;
  /** «Всего к оплате» с бумаги. */
  documentTotal: number | null;
  /** Сумма подставленных строк — с ней и сверяется `linesTotal`. */
  draftTotal: number;
  /** Таблица оборвана кадром: заполняем частично и говорим об этом (решение В4). */
  linesTruncated: boolean;
  /** Сколько строк прочитано всего и сколько не поместилось в чек (Р10а). */
  recognizedLines: number;
  droppedLines: number;
}

export interface ReceiptDraft {
  header: ReceiptDraftHeader;
  lines: ReceiptDraftLine[];
  notes: ReceiptDraftNotes;
}

/** Пустая строка вместо `null`: у формы одно представление «ничего не подставили» — пусто. */
function text(value: string | null | undefined, max: number): { value: string; tooLong: boolean } {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return { value: '', tooLong: false };
  return trimmed.length > max ? { value: '', tooLong: true } : { value: trimmed, tooLong: false };
}

/** Кратна ли сумма копейке — тем же допуском, что считает форма: `1250.35 * 100` двоично неточно. */
function isKopecks(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/**
 * Прочитанное моделью → черновик формы.
 *
 * `today` передаётся, а не берётся из часов: день считается по Москве и приходит оттуда же, откуда
 * его берёт сама форма, — иначе чек, заводимый в 00:30 МСК, встречал бы «дата в будущем» на ровном
 * месте.
 *
 * Строк подставляется не больше `RECEIPT_MAX_LINES`: остальные не теряются молча, а считаются в
 * `droppedLines`, и портал предлагает завести вторую запись (это законно — уникальности у номера
 * чека нет вовсе, обе записи честно назовут один номер).
 */
export function receiptDraftFrom(response: ReceiptRecognitionResponse, today: string): ReceiptDraft {
  const documentNumber = text(response.documentNumber, 100).value;
  const sellerName = text(response.sellerName, 200).value;
  const purchasedOnRaw = (response.purchasedOnRaw ?? '').trim();
  const purchasedOn = response.purchasedOn ?? '';
  // Дата в будущем формой не принимается вовсе, и подставлять её значило бы заполнить поле
  // заведомым отказом (Р11). Якоря вроде даты заявки у чека нет — сверять не с чем.
  const future = purchasedOn !== '' && purchasedOn > today;

  const lines: ReceiptDraftLine[] = [];
  for (const raw of response.lines.slice(0, RECEIPT_MAX_LINES)) {
    const issues: ReceiptDraftIssue[] = [];
    const name = text(raw.name, 300);
    if (name.tooLong) issues.push('nameTooLong');
    else if (!name.value) issues.push('nameMissing');
    const article = text(raw.article, 100);
    if (article.tooLong) issues.push('articleTooLong');
    const unit = text(raw.unit, 20);
    if (unit.tooLong) issues.push('unitTooLong');

    let quantity: number | null = raw.quantity;
    if (quantity !== null && !Number.isInteger(quantity)) {
      // «4,75 л» механик заносит одной упаковкой, перенеся объём в наименование (Р10): портал
      // показывает прочитанное и ждёт решения, а не округляет.
      quantity = null;
      issues.push('quantityFraction');
    } else if (quantity !== null && (quantity < 1 || quantity > RECEIPT_MAX_QUANTITY)) {
      quantity = null;
      issues.push('quantityRange');
    }

    let amount: number | null = raw.amount;
    if (amount === null) issues.push('amountMissing');
    else if (amount < 0 || amount > RECEIPT_MAX_AMOUNT) {
      amount = null;
      issues.push('amountRange');
    } else if (!isKopecks(amount)) {
      amount = null;
      issues.push('amountKopecks');
    }

    lines.push({
      article: article.value,
      name: name.value,
      quantity,
      quantityRaw: (raw.quantityRaw ?? '').trim(),
      // Единица подписывает число: пустую заменяет то же умолчание, что и при ручном вводе.
      unit: unit.value || 'шт',
      amount,
      kind: raw.kind,
      issues,
    });
  }

  const draftTotal =
    Math.round(lines.reduce((sum, line) => sum + (line.amount ?? 0) * 100, 0)) / 100;

  return {
    header: {
      documentNumber,
      purchasedOn: future ? '' : purchasedOn,
      purchasedOnRaw,
      purchasedOnIssue: future ? RECEIPT_FUTURE_DATE_MESSAGE : '',
      sellerName,
    },
    lines,
    notes: {
      linesTotal: response.linesTotal,
      documentTotal: response.documentTotal,
      draftTotal,
      linesTruncated: response.linesTruncated,
      recognizedLines: response.lines.length,
      droppedLines: Math.max(0, response.lines.length - RECEIPT_MAX_LINES),
    },
  };
}

/**
 * Страницы одного файла — в один ответ (Р3).
 *
 * Счёт бывает многостраничным, и таблица рвётся посреди строк: на скане видны последние пять
 * позиций, а «Итого» говорит, что начало осталось на другой странице. Поэтому страницы
 * складываются в порядке следования, а шапка и итоги берутся оттуда, где они есть:
 *
 * - **шапка — с первой страницы, где прочитана**: реквизиты печатают вверху первого листа, и
 *   «последнее выигрывает» затёрло бы их пустотой второго;
 * - **итоги — с последней, где прочитаны**: «Итого» стоит ПОД таблицей, то есть на последнем
 *   листе, и первая страница про него не знает;
 * - **обрыв таблицы — признак всего файла**: оборвана хоть одна страница — оборван счёт.
 */
export function mergeReceiptPages(
  pages: readonly ReceiptRecognitionResponse[],
): ReceiptRecognitionResponse {
  const merged: ReceiptRecognitionResponse = {
    documentNumber: null,
    purchasedOn: null,
    purchasedOnRaw: null,
    sellerName: null,
    linesTotal: null,
    documentTotal: null,
    linesTruncated: false,
    lines: [],
  };
  for (const page of pages) {
    merged.documentNumber ??= page.documentNumber;
    merged.purchasedOn ??= page.purchasedOn;
    merged.purchasedOnRaw ??= page.purchasedOnRaw;
    merged.sellerName ??= page.sellerName;
    if (page.linesTotal !== null) merged.linesTotal = page.linesTotal;
    if (page.documentTotal !== null) merged.documentTotal = page.documentTotal;
    merged.linesTruncated = merged.linesTruncated || page.linesTruncated;
    merged.lines.push(...page.lines);
  }
  return merged;
}

// ── Что портал спрашивает у сервера ──

/**
 * Состояние распознавания скана (§9 плана).
 *
 * `idle` — задачи на этот файл ещё не ставили; остальные четыре повторяют состояние файловой
 * строки. Отдельное `idle` нужно затем, чтобы окно отличало «не просили» от «просили и не вышло»:
 * первое предлагает распознать, второе объясняет, почему не получилось.
 */
export const RECEIPT_RECOGNITION_STATUSES = [
  'idle',
  'pending',
  'done',
  'failed',
  'unsupported',
] as const;
export type ReceiptRecognitionStatus = (typeof RECEIPT_RECOGNITION_STATUSES)[number];

/** Тот же скан уже подшит к другому чеку (Р12) — предупреждение, а не запрет. */
export interface ReceiptDuplicateScanDto {
  receiptId: string;
  documentNumber: string;
  purchasedOn: string;
  /** Пусто, когда карточка спрашивающему не видна: ссылку показывать не на что. */
  visible: boolean;
}

/**
 * Ответ ручки состояния. `draft` приходит готовым (`receiptDraftFrom` считает его на сервере), и
 * это не экономия на портале: правило «что годится для чека» одно, и считать его в браузере
 * значило бы завести второе — расходящееся с первым ровно там, где портал подставит то, что схема
 * потом отобьёт.
 */
export interface ReceiptRecognitionStateDto {
  fileId: string;
  status: ReceiptRecognitionStatus;
  /** Страниц в файле и сколько из них разобрано: «в файле 6 страниц, обработано 5 (лимит)». */
  totalPages: number;
  processedPages: number;
  draft: ReceiptDraft | null;
  /** Классификация отказа — ею окно решает, обещать ли автоматический повтор. */
  errorClass: RecognitionErrorClass | null;
  errorScope: RecognitionErrorScope | null;
  /** Фраза для человека; пусто, когда отказа нет. */
  message: string;
  duplicate: ReceiptDuplicateScanDto | null;
}


/**
 * Состояние подсистемы чтения (§11 плана, по образцу баннера талонов).
 *
 * Четыре состояния, и `disabled` среди них не для полноты: у выключенного модуля доля отказов
 * идеальная — ноль из нуля, — и назвать его «работает» значило бы обещать чтение, которого не
 * будет. Разница между `degraded` и `unconfigured` тоже не косметическая: первое проходит само,
 * второе ждёт человека, и обещать восстановление там, где его нет, — тот же обман, что и молчание.
 */
export const RECEIPT_RECOGNITION_HEALTH_STATES = [
  'disabled',
  'ok',
  'degraded',
  'unconfigured',
] as const;
export type ReceiptRecognitionHealthState = (typeof RECEIPT_RECOGNITION_HEALTH_STATES)[number];

export interface ReceiptRecognitionHealthDto {
  state: ReceiptRecognitionHealthState;
  /** С какого момента длится нездоровье; `null` у здоровой и выключенной подсистемы. */
  since: string | null;
  /** Код последнего терминального отказа — его и называют оператору прокси. */
  code: string;
  /** Попытки за окно и сколько из них — отказ ПОДСИСТЕМЫ: один битый файл сюда не входит. */
  attempts: number;
  failed: number;
  /** Задачи, которые ждут очереди дольше пятнадцати минут: попыток нет, и доля их не покажет. */
  waiting: number;
}
