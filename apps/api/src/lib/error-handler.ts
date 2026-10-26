import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { config } from '../config';
import { AppError } from './errors';
import { isDbUnavailable } from './pg-error';

/** A failover of the managed cluster takes seconds; the pool's own deadlines are 5 and 15 s. */
const DB_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const requestId = String(req.id);

  if (error instanceof AppError) {
    /*
     * `Retry-After` у отказа, который просит повторить (сегодня это исчерпание протокола повторов
     * истории назначения — `assignment-retry.ts`, решение В4 плана периодов).
     *
     * Признак структурный, а не `instanceof` конкретного класса: обработчик ошибок один на весь
     * портал и лежит слоем ниже сервисов — импортируй он сервис ради одного отказа, следующий такой
     * отказ притащил бы сюда второй сервис. Заголовок — часть протокола 503, а не украшение: без
     * него «попробуйте позже» остаётся пожеланием в тексте, которое клиент прочитать не может.
     */
    const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      reply.header('Retry-After', String(Math.round(retryAfter)));
    }
    // `details` уходит рядом с `fields`, а не вместо них: первое разбирает машина (список
    // предупреждений выписки с отпечатком, коды блокеров), второе помечает поля формы. Пустое
    // значение в тело не попадает — `undefined` сериализатор выбрасывает сам.
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
      fields: error.fields,
      details: error.details,
      requestId,
    });
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const fields: Record<string, string> = {};
    for (const v of error.validation) {
      const path =
        (v.instancePath ? v.instancePath.replace(/^\//, '').replace(/\//g, '.') : '') ||
        (v.params as { issue?: { path?: (string | number)[] } })?.issue?.path?.join('.') ||
        'root';
      fields[path] = v.message ?? 'Некорректное значение';
    }
    return reply.code(400).send({
      code: 'validation_error',
      message: 'Ошибка валидации данных',
      fields,
      requestId,
    });
  }

  /*
   * The database did not answer or could not be reached: a failover, a dropped connection, a pool
   * deadline. Repeating the request can succeed, so the answer is 503 with `Retry-After`, not a 500
   * that reads as a bug in the screen. The code differs from the maintenance gate's on purpose: the
   * portal closes itself only on `maintenance_mode`, and a few seconds of failover must not do that.
   */
  if (isDbUnavailable(error)) {
    req.log.warn({ err: error }, 'PostgreSQL недоступен');
    reply.header('Retry-After', String(DB_UNAVAILABLE_RETRY_AFTER_SECONDS));
    return reply.code(503).send({
      code: 'db_unavailable',
      message: 'База данных временно недоступна. Повторите через несколько секунд.',
      requestId,
    });
  }

  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

  if (status === 429) {
    return reply.code(429).send({
      code: 'rate_limited',
      message: 'Слишком много запросов, попробуйте позже',
      requestId,
    });
  }

  if (status < 500) {
    return reply
      .code(status)
      .send({ code: error.code ?? 'bad_request', message: error.message, requestId });
  }

  req.log.error({ err: error }, 'Необработанная ошибка');
  return reply.code(500).send({
    code: 'internal_error',
    message: config.isProd ? 'Внутренняя ошибка сервера' : String(error.message ?? error),
    requestId,
  });
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    code: 'not_found',
    message: 'Маршрут не найден',
    requestId: String(req.id),
  });
}
