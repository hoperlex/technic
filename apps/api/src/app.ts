import { randomUUID } from 'node:crypto';
import Fastify, { type RouteOptions } from 'fastify';
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
import departmentsRoutes from './routes/departments';
import counterpartiesRoutes from './routes/counterparties';
import containerTypesRoutes from './routes/container-types';
import vehicleKindsRoutes from './routes/vehicle-kinds';
import vehicleTypesRoutes from './routes/vehicle-types';
import vehicleSpecsRoutes from './routes/vehicle-specs';
import vehicleCategoriesRoutes from './routes/vehicle-categories';
import vehicleClassificationsRoutes from './routes/vehicle-classifications';
import vehicleModelsRoutes from './routes/vehicle-models';
import vehiclesRoutes from './routes/vehicles';
import driversRoutes from './routes/drivers';
import waybillsRoutes from './routes/waybills';
import vehicleRequestsRoutes from './routes/vehicle-requests';
import wasteRequestsRoutes from './routes/waste-requests';
import wasteTypesRoutes from './routes/waste-types';
import wasteTariffsRoutes from './routes/waste-tariffs';
import filesRoutes from './routes/files';
import auditRoutes from './routes/audit';

function parseTrustProxy(v: string | undefined): boolean | string | string[] {
  if (!v || v === 'true') return true;
  if (v === 'false') return false;
  if (v.includes(',')) return v.split(',').map((s) => s.trim());
  return v;
}

export interface BuildAppOptions {
  /**
   * Наблюдатель за регистрацией маршрутов. Нужен стражу авторизации
   * (test/route-authorization.test.ts): он проверяет, что у каждого маршрута объявлена
   * проверка прав, а получить это из готового приложения Fastify больше неоткуда.
   */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildApp(options: BuildAppOptions = {}) {
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

  if (options.onRoute) app.addHook('onRoute', options.onRoute);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(usersRoutes, { prefix: '/api/v1/users' });
  await app.register(objectsRoutes, { prefix: '/api/v1/objects' });
  await app.register(departmentsRoutes, { prefix: '/api/v1/departments' });
  await app.register(counterpartiesRoutes, { prefix: '/api/v1/counterparties' });
  await app.register(containerTypesRoutes, { prefix: '/api/v1/container-types' });
  await app.register(vehicleKindsRoutes, { prefix: '/api/v1/vehicle-kinds' });
  await app.register(vehicleTypesRoutes, { prefix: '/api/v1/vehicle-types' });
  await app.register(vehicleSpecsRoutes, { prefix: '/api/v1/vehicle-specs' });
  await app.register(vehicleCategoriesRoutes, { prefix: '/api/v1/vehicle-categories' });
  await app.register(vehicleClassificationsRoutes, { prefix: '/api/v1/vehicle-classifications' });
  await app.register(vehicleModelsRoutes, { prefix: '/api/v1/vehicle-models' });
  await app.register(vehiclesRoutes, { prefix: '/api/v1/vehicles' });
  await app.register(driversRoutes, { prefix: '/api/v1/drivers' });
  await app.register(vehicleRequestsRoutes, { prefix: '/api/v1/vehicle-requests' });
  await app.register(waybillsRoutes, { prefix: '/api/v1/waybills' });
  await app.register(wasteRequestsRoutes, { prefix: '/api/v1/waste-requests' });
  await app.register(wasteTypesRoutes, { prefix: '/api/v1/waste-types' });
  await app.register(wasteTariffsRoutes, { prefix: '/api/v1/waste-tariffs' });
  await app.register(filesRoutes, { prefix: '/api/v1/files' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });

  return app;
}
