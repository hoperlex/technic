import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from './config';
import { logger } from './logger';
import { errorHandler, notFoundHandler } from './lib/error-handler';
import authPlugin from './auth/plugin';
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import objectsRoutes from './routes/objects';
import containerTypesRoutes from './routes/container-types';
import wasteRequestsRoutes from './routes/waste-requests';
import filesRoutes from './routes/files';
import auditRoutes from './routes/audit';

function parseTrustProxy(v: string | undefined): boolean | string | string[] {
  if (!v || v === 'true') return true;
  if (v === 'false') return false;
  if (v.includes(',')) return v.split(',').map((s) => s.trim());
  return v;
}

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // trustProxy: диапазоны nginx (не blanket true в проде — см. TRUST_PROXY, §23)
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    bodyLimit: 1_048_576, // 1 МБ — файлы грузятся напрямую в S3, не через API
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, { secret: config.auth.cookieSecret });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(authPlugin);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(usersRoutes, { prefix: '/api/v1/users' });
  await app.register(objectsRoutes, { prefix: '/api/v1/objects' });
  await app.register(containerTypesRoutes, { prefix: '/api/v1/container-types' });
  await app.register(wasteRequestsRoutes, { prefix: '/api/v1/waste-requests' });
  await app.register(filesRoutes, { prefix: '/api/v1/files' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });

  return app;
}
