/**
 * Распознавание талонов вывоза: вход модуля (ADR 0114, план `docs/waste-ticket-ocr-plan.md`).
 *
 * Модуль отвечает за две вещи и ни за что больше:
 *
 * 1. **подготовка** (`preprocess.ts`) — из приложенного к заявке файла получить страницы, годные
 *    для модели, а негодный файл отвергнуть с причиной, не потратив ни копейки (Р9, Р10);
 * 2. **распознавание** (`engine/`) — отдать страницу движку и получить `{ tickets, unreadable }`
 *    либо классифицированный отказ (Р3, Р5, Р29).
 *
 * Чего здесь нет намеренно: транзакций, блокировок заявки, записи попыток и талонов, повторов
 * задачи. Всё это — работа задачи очереди (Р11, Р12), и порядок там свой: T0 под блокировкой
 * заявки, растеризация без блокировок, T1 под advisory lock ключа кэша, T2 снова под блокировкой
 * заявки. Модуль в этом порядке — те два шага, которые не касаются базы вовсе, и именно поэтому
 * их можно звать между транзакциями, не держа строку заявки на время сети.
 */
export {
  detectFileType,
  prepareTicketFile,
  PREPROCESSING_VERSION,
  type DetectedFileType,
  type PreparedFile,
  type PreparedPage,
  type PreprocessOptions,
  type TicketSourceKind,
} from './preprocess';
export { TicketFileError, brokenSubsystem, retryableFile, unsupportedFile } from './errors';
export { detectQuarterTurn, detectSheetBox, detectSkew, otsuThreshold } from './layout';
export { rasterizePdf, type PdfRasterOptions, type PdfRasterResult } from './pdf';
export * from './engine';
export {
  runTicketRecognitionJob,
  type TicketJobDeps,
  type TicketJobPayload,
  type TicketJobResult,
} from './job';
export {
  createEngineFrom,
  preprocessOptionsFrom,
  readTicketOcrConfig,
  type TicketOcrConfig,
} from './config';
