import {
  wasteTicketRecognitionResponseSchema,
  type WasteTicketRecognitionResponse,
  type WasteTicketWorkKind,
} from '@technic/contracts';
import { PREPROCESSING_VERSION } from '../preprocess';
import { idempotencyKey } from './keys';
import { PROMPT_VERSION } from './prompt';
import type {
  AttemptMeta,
  PageImage,
  RecognitionEngine,
  RecognitionFailure,
  RecognitionOutcome,
  RecognizeOptions,
} from './types';

/**
 * Заглушка движка: предсказуемый ответ без сети и без расхода
 * (план `docs/waste-ticket-ocr-plan.md`, Р3; `AI_PROVIDER_MODE=stub`).
 *
 * Это не «выключено». Выключено — это `TICKET_OCR_ENABLED=false`, и тогда задача не ставится вовсе.
 * `stub` означает «распознавание работает, только читает не модель»: заводятся страницы, попытки,
 * талоны, считаются четыре проверки, работает разбор человеком — весь контур, кроме одного звена.
 * Ровно это и нужно разработке (боевой транспорт закрыт allowlist прокси и отвечает 403 с машины
 * разработки), тестам API и демонстрации заказчику.
 *
 * Ответ **выводится из хэша страницы**, а не берётся случайным. Причин две. Первая: попытка
 * принадлежит содержимому (Р12), и заглушка, отвечающая на один и тот же лист по-разному, ломала
 * бы всё, что на этом построено, — кэш, повторное закрытие тем же талоном, проверку «этот номер уже
 * предъявляли». Вторая: тест, ожидающий конкретный номер, не должен ничего подставлять руками —
 * он берёт готовую страницу и знает, что придёт.
 *
 * Сама выдумка списана с замера 22 настоящих талонов (§2 плана): у трети кадров два талона, номер
 * печатный, изредка попадается бланк простоя — без объёма и это законно (Р2). Так заглушка
 * прогоняет и редкие ветки, а не только «один талон, всё прочиталось».
 */

/** Готовый ответ на конкретную страницу: тестам иногда нужен именно свой талон или свой отказ. */
export type StubScript =
  | { status: 'done'; response: WasteTicketRecognitionResponse }
  | { status: 'failed'; failure: RecognitionFailure };

export interface StubEngineOptions {
  /** Сценарий по `page_sha256`: что вернуть на эту страницу вместо выведенного из хэша. */
  scripted?: Map<string, StubScript>;
  /** Задержка ответа: изредка нужна, чтобы проверить продление аренды задачи на времени вызова. */
  latencyMs?: number;
  now?: () => number;
}

/** Целое из куска хэша: нужен разброс, а не криптография. */
function pick(sha: string, offset: number, mod: number): number {
  const chunk = sha.slice(offset % 56, (offset % 56) + 8) || '0';
  return parseInt(chunk, 16) % mod;
}

function stubResponse(sha: string): WasteTicketRecognitionResponse {
  const twoTickets = pick(sha, 0, 3) === 0;
  const tickets = [0, 1].slice(0, twoTickets ? 2 : 1).map((seq) => {
    const idle = pick(sha, 8 + seq * 4, 17) === 0;
    const workKind: WasteTicketWorkKind = idle ? 'idle' : 'removal';
    const number = `ТЛ-${String(100_000 + pick(sha, 16 + seq * 4, 900_000))}`;
    // Дата собирается по частям и заведомо существует: 31 февраля не прошло бы схему контрактов,
    // и заглушка роняла бы тесты сверки датой, а не тем, что они проверяют.
    const day = 1 + pick(sha, 24 + seq * 4, 28);
    const month = 1 + pick(sha, 32 + seq * 4, 12);
    const volume = idle ? null : (1 + pick(sha, 40 + seq * 4, 400)) / 10;
    return {
      number,
      issuedOn: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      volumeM3: volume,
      workKind,
      addressRaw: `г. Новосибирск, ул. Строителей, д. ${1 + pick(sha, 48 + seq * 4, 40)}`,
    };
  });
  // Изредка объём «не читается» — это не то же самое, что простой без объёма (Р2), и обе ветки
  // должны встречаться, иначе различие между ними никто ни разу не проверит.
  const unreadable = pick(sha, 4, 11) === 0 ? (['volumeM3'] as const) : ([] as const);
  return { tickets, unreadable: [...unreadable] };
}

export function createStubEngine(options: StubEngineOptions = {}): RecognitionEngine {
  const now = options.now ?? Date.now;
  return {
    kind: 'stub',
    async recognize(page: PageImage, opts: RecognizeOptions): Promise<RecognitionOutcome> {
      const started = now();
      if (options.latencyMs) {
        await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
      }
      const meta: AttemptMeta = {
        engine: 'stub',
        model: opts.model,
        // Заглушка отрабатывает ровно то, что заказали: расхождения моделей (Р7) тут не бывает.
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

      /*
       * Собственный ответ прогоняется через ту же схему, что и ответ модели. Не перестраховка:
       * заглушка задаёт форму, на которую опираются тесты API и разработка, и разойдись она с
       * контрактом — расхождение всплыло бы уже на боевой модели, где его примут за её ошибку.
       */
      const response = wasteTicketRecognitionResponseSchema.parse(stubResponse(page.sha256));
      return { status: 'done', response, meta };
    },
  };
}
