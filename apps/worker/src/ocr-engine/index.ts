import { createProxyEngine, type ProxyEngineConfig } from './proxy';
import type { RecognitionEngine, RecognitionTask } from './types';

export * from './types';
export * from './keys';
export {
  classifyHttpFailure,
  classifyTransportError,
  contentFailures,
  failure,
  parseRetryAfter,
} from './errors';
export { createProxyEngine, type ProxyEngineConfig } from './proxy';

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
 *
 * Заглушку приносит вызывающий (`makeStub`), а не собирает этот модуль: она знает ПРЕДМЕТ —
 * выдумывает талоны или строки чека, — и общий транспорт про предмет не знает ничего.
 */
export function createRecognitionEngine<T>(cfg: {
  mode: 'proxy' | 'stub';
  task: RecognitionTask<T>;
  proxy?: ProxyEngineConfig;
  makeStub: () => RecognitionEngine<T>;
}): RecognitionEngine<T> {
  if (cfg.mode === 'stub') return cfg.makeStub();
  if (!cfg.proxy?.baseUrl || !cfg.proxy.token) {
    throw new Error(
      'AI_PROVIDER_MODE=proxy требует заполнить PROXY_LLM_BASE_URL и PROXY_LLM_TOKEN.',
    );
  }
  return createProxyEngine(cfg.proxy, cfg.task);
}
