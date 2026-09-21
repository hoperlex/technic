import type { WasteTicketRecognitionResponse } from '@technic/contracts';
import {
  createRecognitionEngine,
  type ProxyEngineConfig,
  type RecognitionEngine,
} from '../ocr-engine';
import { createStubEngine } from './stub';
import { wasteTicketTask } from './task';
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
  /**
   * `TICKET_OCR_ATTEMPT_TTL_DAYS`: сколько дней хранится сырьё попытки (Р31). Ответ модели держат
   * ради двух вещей — разбора «почему прочитано так» и повторной настройки промпта, — и обе
   * перестают быть нужными задолго до того, как заканчивается срок хранения самой заявки.
   */
  attemptTtlDays: number;
  /**
   * `TICKET_OCR_DATE_ANCHOR_DAYS`: окно вокруг якоря заявки, за которым дата талона становится
   * поводом для второго прохода (ADR 0166, п. 4). Бумагу приносят с опозданием, но не на месяц.
   *
   * Управляет ТОЛЬКО эскалацией: выбор века им не гасится — у того свой выключатель ниже. Порог
   * вынесен в окружение затем, чтобы поднять его в первые недели наблюдения можно было без
   * выката (ADR 0166, последствия).
   */
  dateAnchorDays: number;
  /**
   * `TICKET_OCR_DATE_YEAR_FROM_ANCHOR`: век двузначного года выбирает якорь заявки, а не модель
   * (ADR 0166, п. 2). Умолчание — включено; выключается значением `0` или `false`.
   *
   * Выключатель нужен свой, потому что откатывать правило иначе пришлось бы выкатом воркера:
   * `TICKET_OCR_DATE_ANCHOR_DAYS` к выбору года отношения не имеет. При выключенном год берётся
   * из `issuedOn` модели, как до этой работы, транскрипция всё равно пишется в `issued_on_raw`, а
   * эскалация по расстоянию до якоря продолжает работать (ADR 0166, риски плана).
   */
  dateYearFromAnchor: boolean;
}

const DEFAULTS = {
  model: 'proxy',
  maxPerMinute: 30,
  maxEdgePx: 2576,
  maxPages: 5,
  httpTimeoutMs: 120_000,
  pdfTimeoutMs: 60_000,
  pdfMemoryMb: 2048,
  attemptTtlDays: 180,
  dateAnchorDays: 30,
};

/** Число из окружения: мусор и ноль откатываются к умолчанию, а не роняют воркер на старте. */
function num(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Признак, включённый по умолчанию: гасят его только явным `0` или `false`. Отдельная функция, а
 * не `flag` с «наоборот», потому что смысл незаданной переменной у них противоположный: `flag`
 * отвечает «выключено, пока не включили» (так заводят новый модуль), а этот — «работает, пока не
 * выключили» (так откатывают правило, которое уже в бою). Пустая строка и мусор считаются
 * незаданным: `TICKET_OCR_DATE_YEAR_FROM_ANCHOR=` в конфиге прода не должен молча менять правило.
 */
function flagOn(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value !== '0' && value !== 'false';
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
    attemptTtlDays: num(env.TICKET_OCR_ATTEMPT_TTL_DAYS, DEFAULTS.attemptTtlDays),
    // Две настройки даты (ADR 0166) — единственные в этом файле, у которых нет пары в
    // `apps/api/src/config.ts`, и правило «умолчания обязаны совпадать до цифры» их не касается
    // просто потому, что совпадать не с чем: API не решает ни когда звать старшую модель, ни
    // какой век выбрать двузначному году. Обе величины нужны там, где читают бумагу, — в воркере.
    dateAnchorDays: num(env.TICKET_OCR_DATE_ANCHOR_DAYS, DEFAULTS.dateAnchorDays),
    dateYearFromAnchor: flagOn(env.TICKET_OCR_DATE_YEAR_FROM_ANCHOR),
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
): RecognitionEngine<WasteTicketRecognitionResponse> {
  return createRecognitionEngine({
    mode: cfg.mode,
    task: wasteTicketTask,
    makeStub: () => createStubEngine(),
    proxy: {
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      timeoutMs: cfg.httpTimeoutMs,
      ...overrides,
    },
  });
}
