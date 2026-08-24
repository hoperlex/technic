import { createRecognitionEngine, type ProxyEngineConfig, type RecognitionEngine } from './engine';
import type { PreprocessOptions } from './preprocess';

/**
 * Настройки распознавания талонов в воркере (план `docs/waste-ticket-ocr-plan.md`, Р8).
 *
 * Те же переменные, что читает API (`apps/api/src/config.ts`), и это не дублирование по недосмотру:
 * API решает, **ставить ли задачу** и что показывать в карточке, воркер — **как выполнять**, а
 * общий у них только `/etc/technic-portal/prod.env`. Тащить сюда конфигурацию API значило бы
 * связать процессы, которые нарочно живут врозь: у воркера нет ни Fastify, ни маршрутов, ни
 * знания правил портала (та же причина, по которой `mail-accounts.ts` не знает реестра каналов).
 *
 * Значения по умолчанию обязаны совпадать с API до цифры: разойдись `TICKET_OCR_MAX_PAGES`, и
 * карточка обещала бы человеку пять страниц там, где воркер разобрал три.
 */

export interface TicketOcrConfig {
  /** `TICKET_OCR_ENABLED`: модуль отдельно от транспорта — прокси бывает настроен, а модуль выключен. */
  enabled: boolean;
  /** `AI_PROVIDER_MODE`: живой транспорт или заглушка (Р3). */
  mode: 'proxy' | 'stub';
  baseUrl: string;
  token: string;
  /** Заказанная модель: слаг каталога или заглушка `proxy` — «выбирает прокси» (Р7). */
  model: string;
  /** Старшая модель каскада; пусто — эскалации нет (Р14). */
  escalationModel: string;
  maxPerMinute: number;
  maxEdgePx: number;
  maxPages: number;
  httpTimeoutMs: number;
  /** Срок растеризации PDF: она идёт вне транзакции, поэтому свой и заметно короче HTTP. */
  pdfTimeoutMs: number;
  pdfMemoryMb: number;
  /** `heif-convert` из образа воркера, если он там есть: libvips читает HEIF, но не HEVC. */
  heifConvertBin: string | undefined;
}

const DEFAULTS = {
  model: 'proxy',
  maxPerMinute: 30,
  maxEdgePx: 2576,
  maxPages: 5,
  httpTimeoutMs: 120_000,
  pdfTimeoutMs: 60_000,
  pdfMemoryMb: 2048,
};

/** Число из окружения: мусор и ноль откатываются к умолчанию, а не роняют воркер на старте. */
function num(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

export function readTicketOcrConfig(env: NodeJS.ProcessEnv = process.env): TicketOcrConfig {
  return {
    enabled: flag(env.TICKET_OCR_ENABLED),
    mode: env.AI_PROVIDER_MODE === 'proxy' ? 'proxy' : 'stub',
    baseUrl: env.PROXY_LLM_BASE_URL ?? '',
    token: env.PROXY_LLM_TOKEN ?? '',
    model: env.TICKET_OCR_MODEL || DEFAULTS.model,
    escalationModel: env.TICKET_OCR_ESCALATION_MODEL ?? '',
    maxPerMinute: num(env.TICKET_OCR_MAX_PER_MINUTE, DEFAULTS.maxPerMinute),
    maxEdgePx: num(env.TICKET_OCR_MAX_EDGE_PX, DEFAULTS.maxEdgePx),
    maxPages: num(env.TICKET_OCR_MAX_PAGES, DEFAULTS.maxPages),
    httpTimeoutMs: num(env.TICKET_OCR_HTTP_TIMEOUT_MS, DEFAULTS.httpTimeoutMs),
    pdfTimeoutMs: num(env.TICKET_OCR_PDF_TIMEOUT_MS, DEFAULTS.pdfTimeoutMs),
    pdfMemoryMb: num(env.TICKET_OCR_PDF_MEMORY_MB, DEFAULTS.pdfMemoryMb),
    heifConvertBin: env.TICKET_OCR_HEIF_CONVERT_BIN || undefined,
  };
}

/** Настройки подготовки файла из общей конфигурации — чтобы вызывающий не собирал их по полям. */
export function preprocessOptionsFrom(cfg: TicketOcrConfig): PreprocessOptions {
  return {
    maxPages: cfg.maxPages,
    maxEdgePx: cfg.maxEdgePx,
    pdfTimeoutMs: cfg.pdfTimeoutMs,
    pdfMemoryMb: cfg.pdfMemoryMb,
    heifConvertBin: cfg.heifConvertBin,
  };
}

/**
 * Движок по конфигурации. `overrides` существует ради тестов: боевой транспорт закрыт allowlist
 * прокси, и подменять в них нужно ровно `fetch`, а не собирать конфигурацию заново.
 */
export function createEngineFrom(
  cfg: TicketOcrConfig,
  overrides: Partial<ProxyEngineConfig> = {},
): RecognitionEngine {
  return createRecognitionEngine({
    mode: cfg.mode,
    proxy: {
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      timeoutMs: cfg.httpTimeoutMs,
      ...overrides,
    },
  });
}
