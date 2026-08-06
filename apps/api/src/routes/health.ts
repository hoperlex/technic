import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/client';
import { collectMetrics } from '../services/metrics';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_req, reply) => {
    try {
      await pingDb();
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'not_ready' };
    }
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    try {
      return await collectMetrics();
    } catch {
      // Недоступная база не должна ронять сам сбор метрик: «сервис жив, но не отвечает по данным»
      // — это состояние, ради которого мониторинг и заводят. О недоступности БД скажет
      // `/health/ready`, а здесь остаётся то, что удалось узнать без неё.
      reply.header('content-type', 'text/plain; version=0.0.4');
      return '# HELP technic_up 1 если сервис жив\n# TYPE technic_up gauge\ntechnic_up 1\n';
    }
  });
}
