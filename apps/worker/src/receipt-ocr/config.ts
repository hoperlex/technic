import type { ReceiptRecognitionResponse } from '@technic/contracts';
import { createRecognitionEngine, type ProxyEngineConfig, type RecognitionEngine } from '../ocr-engine';
import { preprocessOptionsFrom, readTicketOcrConfig } from '../ticket-ocr/config';
import type { PreprocessOptions } from '../ticket-ocr/preprocess';
import { createReceiptStubEngine } from './stub';
import { partReceiptTask } from './task';

/**
 * Настройки чтения чеков (план `docs/auto-part-receipt-ocr-plan.md`, §11, Р17).
 *
 * ТРАНСПОРТ ОБЩИЙ, ЗАДАНИЕ СВОЁ. Адрес прокси, токен и режим (`AI_PROVIDER_MODE`) — те же
 * переменные, что читает распознавание талонов: прокси у портала один, и вторая пара переменных
 * для того же адреса означала бы два места, где его можно настроить по-разному.
 *
 * А вот ЧТО и КАК читать — своё, и это не симметрия ради симметрии. Предметы разные: талон это
 * пять рукописных полей на бланке A6, счёт — типографская таблица на A4 до сотни строк. У них
 * заведомо разные модель и разрешение (мелкий артикул против крупной рукописи), разные потолки
 * ответа и разная цена страницы. Одна настройка на двоих означала бы, что выбор, сделанный замером
 * для одного предмета, молча применяется к другому.
 *
 * Подготовка файла (`TICKET_OCR_MAX_PAGES`, `MAX_EDGE_PX`, таймауты PDF) пока берётся общая:
 * растеризация от предмета не зависит, а разойтись двум наборам значений было бы негде. Разрешение
 * отделится, если замер покажет, что артикулу нужно больше пикселей, чем рукописи, — и тогда у
 * него появится своя переменная, а не «поднимем общую и посмотрим».
 */

export interface ReceiptOcrConfig {
  /** `RECEIPT_OCR_ENABLED`: модуль отдельно от транспорта — прокси бывает настроен, а модуль нет. */
  enabled: boolean;
  mode: 'proxy' | 'stub';
  baseUrl: string;
  token: string;
  /** `RECEIPT_OCR_MODEL`: слаг каталога или заглушка `proxy` — «выбирает прокси». */
  model: string;
  maxPerMinute: number;
  httpTimeoutMs: number;
  preprocess: PreprocessOptions;
}

const DEFAULTS = {
  model: 'proxy',
  maxPerMinute: 30,
  httpTimeoutMs: 120_000,
};

function flag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function num(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readReceiptOcrConfig(env: NodeJS.ProcessEnv = process.env): ReceiptOcrConfig {
  const shared = readTicketOcrConfig(env);
  return {
    enabled: flag(env.RECEIPT_OCR_ENABLED),
    mode: shared.mode,
    baseUrl: shared.baseUrl,
    token: shared.token,
    model: env.RECEIPT_OCR_MODEL || DEFAULTS.model,
    maxPerMinute: num(env.RECEIPT_OCR_MAX_PER_MINUTE, DEFAULTS.maxPerMinute),
    httpTimeoutMs: num(env.RECEIPT_OCR_HTTP_TIMEOUT_MS, DEFAULTS.httpTimeoutMs),
    preprocess: preprocessOptionsFrom(shared),
  };
}

/** Движок по конфигурации; `overrides` — ради тестов, где подменяется ровно `fetch`. */
export function createReceiptEngineFrom(
  cfg: ReceiptOcrConfig,
  overrides: Partial<ProxyEngineConfig> = {},
): RecognitionEngine<ReceiptRecognitionResponse> {
  return createRecognitionEngine({
    mode: cfg.mode,
    task: partReceiptTask,
    makeStub: () => createReceiptStubEngine(),
    proxy: {
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      timeoutMs: cfg.httpTimeoutMs,
      ...overrides,
    },
  });
}
