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
import userGrantsRoutes from './routes/user-grants';
import grantsRoutes from './routes/grants';
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
import driverRoutes from './routes/driver';
import vehicleReadingsRoutes from './routes/vehicle-readings';
import vehicleReadingsStatsRoutes from './routes/vehicle-readings-stats';
import vehicleMaintenanceRoutes from './routes/vehicle-maintenance';
import wasteRequestsRoutes from './routes/waste-requests';
import wasteTypesRoutes from './routes/waste-types';
import wasteTariffsRoutes from './routes/waste-tariffs';
import filesRoutes from './routes/files';
import directoryTransferRoutes from './routes/directory-transfer';
import adminMailRoutes from './routes/admin-mail';
import adminMailingsRoutes from './routes/admin-mailings';
import moduleMailRoutes from './routes/module-mail';
import internalMailRoutes from './routes/internal-mail';
import auditRoutes from './routes/audit';
import releasesRoutes from './routes/releases';
import manualsRoutes from './routes/manuals';

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
  // Выдача и отзыв полномочия — тот же префикс учёток, свой файл: цель операции — человек (журнал и
  // `authVersion` пишутся ему), а порядок блокировок у неё обратный порядку правки учётки — сначала
  // строка набора, потом строка учётки (ADR 0106, решение 7). Тем же приёмом на один префикс
  // зарегистрированы три файла почтового контура.
  await app.register(userGrantsRoutes, { prefix: '/api/v1/users' });
  // Каталог назначаемых полномочий (ADR 0106, этап 3) — свой префикс, а не ветка `/users`: учётками
  // ведают одни ручки, составом наборов другие, и права у них хоть и совпадают (`users.manage`
  // невыдаваемое), но предмет разный — здесь правят каталог, а не человека.
  await app.register(grantsRoutes, { prefix: '/api/v1/grants' });
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
  // Кабинет водителя (ADR 0102) — второй контур портала: свой префикс, свои два права и своя, самая
  // узкая область («свой человек»). Ветка `/driver` намеренно не ветвь `/drivers`: справочник
  // работников ведут с правами `drivers.*`, а здесь работник смотрит собственное задание.
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  // Показания техники (ADR 0103) со стороны портала: приёмка дня, правка за водителя, разбор
  // расхождений и порядок смен. Своя ветка, а не `/garage`: гараж эти строки только показывает,
  // а ведёт их этот модуль — и права у него свои, `vehicleReadings.*`.
  await app.register(vehicleReadingsRoutes, { prefix: '/api/v1/vehicle-readings' });
  // Журнал машины и сводка по парку — второй плагин на том же префиксе: у них общий предмет и
  // общее право `vehicleReadings.read`, но разные пути и разная цена запроса (сводка считает
  // разности по всему парку за период). Тот же приём, что у двух плагинов `admin/mail`.
  await app.register(vehicleReadingsStatsRoutes, { prefix: '/api/v1/vehicle-readings' });
  // Техобслуживание по пробегу (план «Показания техники», Р14) — свой префикс, а не ветка
  // показаний: права у него свои (`vehicleMaintenance.*`), и держит их порознь ровно то, что
  // служба главного механика ведёт ТО, не открывая приёмку, журналы и фотографии показаний.
  await app.register(vehicleMaintenanceRoutes, { prefix: '/api/v1/vehicle-maintenance' });
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
  // Служебные адресаты писем модулей: тот же раздел администрирования, но настраивают в нём не
  // расписание для учёток, а ящик службы, которая портал не открывает.
  await app.register(moduleMailRoutes, { prefix: '/api/v1/admin/mail' });
  // Наружу не проксируется: этим маршрутом ходит только планировщик из worker (ADR 0075).
  await app.register(internalMailRoutes, { prefix: '/internal/mail' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  // Журнал обновлений (ADR 0077) — служебное окно, а не раздел: читает любой вошедший, права нет.
  await app.register(releasesRoutes, { prefix: '/api/v1/releases' });
  // Руководства (`docs/manuals-plan.md`) — соседнее служебное окно: список читает любой вошедший,
  // а ведёт его держатель `manuals.manage`, и обе роли живут на одном префиксе.
  await app.register(manualsRoutes, { prefix: '/api/v1/manuals' });

  return app;
}
