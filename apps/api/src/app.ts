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
import warehousesRoutes from './routes/warehouses';
import officeEquipmentTypesRoutes from './routes/office-equipment-types';
import officeEquipmentRoutes from './routes/office-equipment';
import serviceRequestsRoutes from './routes/service-requests';
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
import weeklyVehicleRequestsRoutes from './routes/weekly-vehicle-requests';
import vehicleRoutesRoutes from './routes/vehicle-routes';
import garageRoutes from './routes/garage';
import wasteRequestsRoutes from './routes/waste-requests';
import wasteTypesRoutes from './routes/waste-types';
import wasteTariffsRoutes from './routes/waste-tariffs';
import filesRoutes from './routes/files';
import directoryTransferRoutes from './routes/directory-transfer';
import adminMailRoutes from './routes/admin-mail';
import adminMailingsRoutes from './routes/admin-mailings';
import internalMailRoutes from './routes/internal-mail';
import auditRoutes from './routes/audit';
import releasesRoutes from './routes/releases';

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
  await app.register(warehousesRoutes, { prefix: '/api/v1/warehouses' });
  // Справочник оргтехники (ADR 0085): перечень типов идёт перед единицами — окно ведения типов
  // открывается из той же вкладки, и без него единицу не завести.
  await app.register(officeEquipmentTypesRoutes, { prefix: '/api/v1/office-equipment-types' });
  await app.register(officeEquipmentRoutes, { prefix: '/api/v1/office-equipment' });
  // Заявки на обслуживание оргтехники (ADR 0085) — третий модуль заявок: свой префикс, свои права
  // и свой перечень статусов, а не ветка справочника, из которого приходит только предмет заявки.
  await app.register(serviceRequestsRoutes, { prefix: '/api/v1/service-requests' });
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
  // Недельная заявка (ADR 0085) — документ-основание **над** заказами ТС: свой префикс, а не ветка
  // `/vehicle-requests`, потому что и права у неё свои, и область видимости своя.
  await app.register(weeklyVehicleRequestsRoutes, { prefix: '/api/v1/weekly-vehicle-requests' });
  await app.register(vehicleRoutesRoutes, { prefix: '/api/v1/vehicle-routes' });
  // Гараж (ADR 0076) — срез дня поверх рейсов, заявок и листов: своих таблиц у него нет, поэтому
  // и префикс свой, а не ветка одного из этих модулей.
  await app.register(garageRoutes, { prefix: '/api/v1/garage' });
  await app.register(waybillsRoutes, { prefix: '/api/v1/waybills' });
  await app.register(wasteRequestsRoutes, { prefix: '/api/v1/waste-requests' });
  await app.register(wasteTypesRoutes, { prefix: '/api/v1/waste-types' });
  await app.register(wasteTariffsRoutes, { prefix: '/api/v1/waste-tariffs' });
  await app.register(filesRoutes, { prefix: '/api/v1/files' });
  // Обмен справочниками файлом Excel (ADR 0073) — свой префикс, а не ветка каждого справочника:
  // выгружает и загружает их один механизм, и открыт он только администратору.
  await app.register(directoryTransferRoutes, { prefix: '/api/v1/directories' });
  await app.register(adminMailRoutes, { prefix: '/api/v1/admin/mail' });
  await app.register(adminMailingsRoutes, { prefix: '/api/v1/admin/mail' });
  // Наружу не проксируется: этим маршрутом ходит только планировщик из worker (ADR 0075).
  await app.register(internalMailRoutes, { prefix: '/internal/mail' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  // Журнал обновлений (ADR 0077) — служебное окно, а не раздел: читает любой вошедший, права нет.
  await app.register(releasesRoutes, { prefix: '/api/v1/releases' });

  return app;
}
