import { createProxyEngine, type ProxyEngineConfig } from './proxy';
import { createStubEngine, type StubEngineOptions } from './stub';
import type { RecognitionEngine } from './types';

export * from './types';
export * from './keys';
export {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  USER_TEXT,
  RESPONSE_JSON_SCHEMA,
  MAX_TOKENS,
} from './prompt';
export {
  classifyHttpFailure,
  classifyTransportError,
  contentFailures,
  failure,
  parseRetryAfter,
} from './errors';
export { createProxyEngine, type ProxyEngineConfig } from './proxy';
export { createStubEngine, type StubEngineOptions, type StubScript } from './stub';

/**
 * Выбор движка по режиму провайдера (план `docs/waste-ticket-ocr-plan.md`, Р3, Р8).
 *
 * Режим задаёт портальный `AI_PROVIDER_MODE`, а не тип задачи: у портала не бывает «этот файл
 * читаем моделью, а этот заглушкой». Движок входит в ключ кэша попытки (Р12) именно поэтому —
 * переключение режима на стенде не должно возвращать ответ заглушки как ответ модели.
 *
 * Отсутствие адреса или токена при `proxy` — это отказ на старте, а не на первом талоне: заявки
 * закрываются круглосуточно, и «забыли PROXY_LLM_TOKEN» обнаружилось бы вечером на закрытии
 * вместо выката.
 */
export function createRecognitionEngine(cfg: {
  mode: 'proxy' | 'stub';
  proxy?: ProxyEngineConfig;
  stub?: StubEngineOptions;
}): RecognitionEngine {
  if (cfg.mode === 'stub') return createStubEngine(cfg.stub);
  if (!cfg.proxy?.baseUrl || !cfg.proxy.token) {
    throw new Error(
      'AI_PROVIDER_MODE=proxy требует заполнить PROXY_LLM_BASE_URL и PROXY_LLM_TOKEN.',
    );
  }
  return createProxyEngine(cfg.proxy);
}
