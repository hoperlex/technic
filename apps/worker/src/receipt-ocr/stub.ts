import {
  receiptRecognitionResponseSchema,
  type ReceiptLineKind,
  type ReceiptRecognitionResponse,
} from '@technic/contracts';
import { idempotencyKey } from '../ocr-engine';
import type {
  AttemptMeta,
  PageImage,
  RecognitionEngine,
  RecognitionFailure,
  RecognitionOutcome,
  RecognizeOptions,
} from '../ocr-engine';
import { PREPROCESSING_VERSION } from '../ticket-ocr/preprocess';
import { PROMPT_VERSION } from './prompt';

/**
 * Заглушка чтения чека: предсказуемый ответ без сети и без расхода (`AI_PROVIDER_MODE=stub`).
 *
 * Это не «выключено» — выключено означает, что задача не ставится вовсе. `stub` означает
 * «распознавание работает, только читает не модель»: заводятся страницы и попытки, считается
 * черновик, форма заполняется — весь контур, кроме одного звена. Ровно это и нужно разработке,
 * тестам API и показу заказчику.
 *
 * Ответ **выводится из хэша страницы**, а не берётся случайным: попытка принадлежит содержимому, и
 * заглушка, отвечающая на один лист по-разному, ломала бы кэш и проверку «этот скан уже подшит».
 *
 * Выдумка списана с настоящих счетов (§1 плана): типографская таблица на несколько позиций, у
 * части строк артикул, изредка попадается строка услуги (доставка) и изредка — обрыв таблицы
 * кадром. Так заглушка прогоняет редкие ветки портала, а не только «всё прочиталось».
 */

/** Готовый ответ на конкретную страницу: тестам иногда нужен свой счёт или свой отказ. */
export type ReceiptStubScript =
  | { status: 'done'; response: ReceiptRecognitionResponse }
  | { status: 'failed'; failure: RecognitionFailure };

export interface ReceiptStubOptions {
  scripted?: Map<string, ReceiptStubScript>;
  latencyMs?: number;
  now?: () => number;
}

/** Целое из куска хэша: нужен разброс, а не криптография. */
function pick(sha: string, offset: number, mod: number): number {
  const chunk = sha.slice(offset % 56, (offset % 56) + 8) || '0';
  return parseInt(chunk, 16) % mod;
}

const NAMES = [
  'Гидрозамок опоры ISVBPS M 12',
  'Шланг d=18x27мм маслобензостойкий Р=16Бар ГОСТ 10362-76',
  'Фильтр масляный MANN W914/2',
  'Стекло для двери Bobcat новый тип',
  'Размыкатель КС3577.28.200',
] as const;

const ARTICLES = ['ШМБС-18х27', 'УТ-00010050', '5336-5009160', '', 'КС3577.83.200'] as const;

function stubResponse(sha: string): ReceiptRecognitionResponse {
  const count = 1 + pick(sha, 0, 4);
  const lines = Array.from({ length: count }, (_, seq) => {
    // Каждая пятая строка — услуга: портал красит такие подписью «похоже, не запчасть» (Р3а), и
    // ветка обязана встречаться сама, а не только в подставленном тесте.
    const service = pick(sha, 8 + seq * 4, 5) === 0;
    const kind: ReceiptLineKind = service ? 'service' : 'part';
    const quantity = 1 + pick(sha, 16 + seq * 4, 10);
    const amount = (100 + pick(sha, 24 + seq * 4, 900_000)) / 100;
    return {
      article: service ? null : (ARTICLES[pick(sha, 32 + seq * 4, ARTICLES.length)] ?? null),
      name: service ? 'Доставка' : (NAMES[pick(sha, 40 + seq * 4, NAMES.length)] ?? null),
      quantity,
      quantityRaw: `${quantity}.00`,
      unit: 'шт',
      amount,
      kind,
    };
  });
  const linesTotal = Math.round(lines.reduce((sum, l) => sum + l.amount * 100, 0)) / 100;
  // Изредка таблица оборвана кадром: тогда итог с бумаги БОЛЬШЕ суммы строк, и портал обязан это
  // показать (Р9). Величина добавки заведомо заметная — иначе предупреждение не отличить от
  // копеечного расхождения округления.
  const truncated = pick(sha, 4, 7) === 0;
  return {
    documentNumber: `${1000 + pick(sha, 48, 9000)}`,
    purchasedOn: `2026-0${1 + pick(sha, 12, 9)}-1${pick(sha, 20, 9)}`,
    purchasedOnRaw: null,
    sellerName: 'ООО "МС-партс"',
    linesTotal: truncated ? linesTotal + 12_000 : linesTotal,
    documentTotal: truncated ? linesTotal + 12_000 : linesTotal,
    linesTruncated: truncated,
    lines,
  };
}

export function createReceiptStubEngine(
  options: ReceiptStubOptions = {},
): RecognitionEngine<ReceiptRecognitionResponse> {
  const now = options.now ?? Date.now;
  return {
    kind: 'stub',
    async recognize(
      page: PageImage,
      opts: RecognizeOptions,
    ): Promise<RecognitionOutcome<ReceiptRecognitionResponse>> {
      const started = now();
      if (options.latencyMs) {
        await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
      }
      const meta: AttemptMeta = {
        engine: 'stub',
        model: opts.model,
        modelReported: opts.model,
        promptVersion: PROMPT_VERSION,
        preprocessingVersion: PREPROCESSING_VERSION,
        inputTokens: null,
        outputTokens: null,
        durationMs: Math.max(0, Math.round(now() - started)),
        proxyRequestId: '',
        upstreamRequestId: '',
        idempotencyKey: idempotencyKey(
          {
            pageSha256: page.sha256,
            engine: 'stub',
            model: opts.model,
            promptVersion: PROMPT_VERSION,
            preprocessingVersion: PREPROCESSING_VERSION,
            task: 'part_receipt',
          },
          opts,
        ),
        requestId: `stub-${page.sha256.slice(0, 12)}`,
      };

      const scripted = options.scripted?.get(page.sha256);
      if (scripted) {
        return scripted.status === 'done'
          ? { status: 'done', response: scripted.response, meta }
          : { status: 'failed', failure: scripted.failure, meta };
      }

      // Свой ответ идёт через ту же схему, что и ответ модели: разойдись заглушка с контрактом,
      // расхождение всплыло бы уже на боевой модели, где его приняли бы за её ошибку.
      const response = receiptRecognitionResponseSchema.parse(stubResponse(page.sha256));
      return { status: 'done', response, meta };
    },
  };
}
