import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { config } from '../config';
import { AppError } from './errors';

export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const requestId = String(req.id);

  if (error instanceof AppError) {
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message, fields: error.fields, requestId });
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
