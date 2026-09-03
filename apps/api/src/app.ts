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
import clientContractGate from './lib/client-contract';
import maintenanceGate from './lib/maintenance';
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
import officeEquipmentModelsRoutes from './routes/office-equipment-models';
import officeEquipmentConsumablesRoutes from './routes/office-equipment-consumables';
import officeEquipmentPurchasesRoutes from './routes/office-equipment-purchases';
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
import vehicleTrailersRoutes from './routes/vehicle-trailers';
import driversRoutes from './routes/drivers';
import waybillsRoutes from './routes/waybills';
import vehicleRequestAssignmentRoutes from './routes/vehicle-request-assignment';
import vehicleRequestAssignmentRepairRoutes from './routes/vehicle-request-assignment-repair';
import vehicleRequestAssignmentCorrectionRoutes from './routes/vehicle-request-assignment-correction';
import vehicleRequestPeriodRoutes from './routes/vehicle-request-period';
import vehicleRequestsRoutes from './routes/vehicle-requests';
import weeklyVehicleRequestsRoutes from './routes/weekly-vehicle-requests';
import vehicleRoutesRoutes from './routes/vehicle-routes';
import garageRoutes from './routes/garage';
import driverRoutes from './routes/driver';
import vehicleReadingsRoutes from './routes/vehicle-readings';
import vehicleReadingsStatsRoutes from './routes/vehicle-readings-stats';
import autoPartReceiptsRoutes from './routes/auto-part-receipts';
import vehicleMaintenanceRoutes from './routes/vehicle-maintenance';
import wasteRequestsRoutes from './routes/waste-requests';
import wasteTicketsRoutes from './routes/waste-tickets';
import ticketAuditRoutes from './routes/ticket-audit';
import mechRequestsRoutes from './routes/mech-requests';
import mechModelsRoutes from './routes/mech-models';
import wasteTypesRoutes from './routes/waste-types';
import wasteTariffsRoutes from './routes/waste-tariffs';
import filesRoutes from './routes/files';
import directoryTransferRoutes from './routes/directory-transfer';
import adminMailRoutes from './routes/admin-mail';
import adminMailingsRoutes from './routes/admin-mailings';
import moduleMailRoutes from './routes/module-mail';
import internalMailRoutes from './routes/internal-mail';
import internalServiceRequestRoutes from './routes/internal-service-requests';
import auditRoutes from './routes/audit';
import releasesRoutes from './routes/releases';
import manualsRoutes from './routes/manuals';

/**
 * Разбор `TRUST_PROXY` для опции `trustProxy` Fastify. Кроме `true`/`false`, списка адресов и
 * одиночного адреса понимает целое число — сколько последних хопов в `X-Forwarded-For` считать
 * своими. Ради него правило и появилось: строка `'1'` без этой ветки ушла бы в `proxy-addr` как
 * адрес и разобралась бы как мусорная подсеть, то есть тихо превратилась бы в «никому не верим».
 * `0` осмыслен сам по себе (не доверять ни одному хопу) и потому в `false` не сводится —
 * `false` отключает разбор заголовка целиком.
 */
export function parseTrustProxy(v: string | undefined): boolean | number | string | string[] {
  if (!v || v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
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
    // trustProxy: в проде — число хопов (`TRUST_PROXY=1`), а не blanket true. Внешний nginx
    // перезаписывает X-Forwarded-For адресом клиента, отбрасывая присланный им заголовок, а
    // nginx веба передаёт значение дальше, себя не дописывая, — до API доходит ровно один
    // адрес, и доверять надо ровно одному. При `true` клиент дописал бы себе любой `req.ip` и
    // обошёл бы все лимиты по адресу (docs/smart-captcha-plan.md, §6).
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    bodyLimit: 1_048_576, // 1 МБ — файлы грузятся напрямую в S3, не через API
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, { secret: config.auth.cookieSecret });
  await app.register(helmet, { contentSecurityPolicy: false });
  /*
   * Потолок частоты берётся из окружения, умолчание прежнее. Понадобилось это тестам: db-файл,
   * прогоняемый в двух режимах чтения (подэтап 4b), делает вдвое больше запросов и упирается в
   * лимит — при этом ловит он не дефект, а сам себя, и падение выглядит ошибкой кода. В проде и в
   * dev значение не меняется: переменной там нет.
   */
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 300);
  await app.register(rateLimit, {
    max: Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 300,
    timeWindow: '1 minute',
  });
  /*
   * Гейт минимальной версии клиента (ADR 0146, решение 7) — ДО авторизации и до маршрутов: вкладка
   * со сборкой ниже пола не должна доходить ни до стража прав, ни до обработчика. Пол берётся из
   * `MIN_CLIENT_CONTRACT`, умолчание `1` — фаза A, в которой не блокируется никто.
   *
   * Рядом с лимитом частоты, а не среди маршрутов: это свойство всего API, а не какого-то из
   * модулей. Ручки, выведенные из-под гейта насовсем (`/auth/refresh`, `/auth/logout`), и границы
   * его области (`/health/*`, `/internal/*` вне гейта) названы в самом плагине.
   */
  await app.register(clientContractGate);
  /*
   * Режим технических работ (план `docs/maintenance-mode-plan.md`) — сразу после гейта версии
   * клиента и ДО авторизации.
   *
   * Порядок этих трёх не произволен. Версия клиента спрашивается первой: вкладка, которой отказано
   * 426, обязана узнать про обновление в любом состоянии портала, иначе после снятия режима она
   * продолжит работу на сборке, которой отказано. Авторизация — последней: в окне закрыт и вход, и
   * `/auth/me`, а страж этого не знает и отвечал бы 401 — «войдите заново» вместо «идут работы».
   *
   * Ручки, выведенные из-под режима насовсем (`/auth/refresh`, `/auth/logout`), и границы его
   * области (`/health/*`, `/metrics`, `/internal/*` вне гейта) названы в самом плагине.
   */
  await app.register(maintenanceGate);
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
  // Справочник моделей аппаратов (план `docs/office-equipment-consumables-plan.md`, Р1) — свой
  // префикс рядом с типами, а не ветка единиц: модель существует независимо от парка (картридж
  // лежит на складе и для аппарата, которого в портале нет), и вести её из адреса единицы значило
  // бы требовать сначала завести технику. Порядок тот же, что у типов: и тип, и модель нужны
  // раньше, чем сама единица.
  await app.register(officeEquipmentModelsRoutes, { prefix: '/api/v1/office-equipment-models' });
  // Расходники — картриджи и тонеры (тот же план, Р5–Р7). Свой префикс рядом с моделями, а не ветка
  // единиц: расходник лежит на складе и для аппарата, которого в портале нет вовсе, — вести его из
  // адреса единицы значило бы требовать сначала завести технику. После моделей, потому что
  // совместимость расходника выражается ссылками на них.
  await app.register(officeEquipmentConsumablesRoutes, {
    prefix: '/api/v1/office-equipment-consumables',
  });
  // Плановая закупка расходников (ADR 0146, Р9) — САМОСТОЯТЕЛЬНЫЙ ДОКУМЕНТ со своим префиксом, а не
  // ветка расходников и не вид заявки. Своим он стал потому, что у него нет ни техники, ни области
  // видимости: остаток расходников один на компанию, значит потребность, дефицит и заказ по
  // дефициту глобальны — ни площадки, ни отдела у такого документа не бывает, и оба довода ADR 0133
  // об одной таблице заявок здесь не работают. После расходников, потому что состав закупки — это
  // ссылки на их позиции.
  await app.register(officeEquipmentPurchasesRoutes, {
    prefix: '/api/v1/office-equipment-purchases',
  });
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
  // Реестр прицепов (план `docs/vehicle-trailers-plan.md`, Р7) — свой префикс, а не ветка
  // `/vehicles`: прицеп не единица техники и в `vehicles` не лежит. Общий адрес обещал бы обратное
  // тем самым, что заказ техники и её справочник читались бы по одному пути.
  await app.register(vehicleTrailersRoutes, { prefix: '/api/v1/vehicle-trailers' });
  await app.register(driversRoutes, { prefix: '/api/v1/drivers' });
  await app.register(vehicleRequestsRoutes, { prefix: '/api/v1/vehicle-requests' });
  // Двери истории назначения (план `docs/assignment-periods-plan.md` §8) — второй плагин на том же
  // префиксе: адреса портала от разделения не меняются, а `vehicle-requests.ts` их не вмещает
  // (§16.1 плана — барьерный файл, которого хотят сразу пять дверей). Тот же приём, что у двух
  // плагинов `vehicle-readings`. Боевых ручек в модуле пока нет: волна 3.1 привезла каркас.
  await app.register(vehicleRequestAssignmentRoutes, { prefix: '/api/v1/vehicle-requests' });
  await app.register(vehicleRequestAssignmentRepairRoutes, { prefix: '/api/v1/vehicle-requests' });
  await app.register(vehicleRequestAssignmentCorrectionRoutes, {
    prefix: '/api/v1/vehicle-requests',
  });
  await app.register(vehicleRequestPeriodRoutes, { prefix: '/api/v1/vehicle-requests' });
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
  // Чеки на автозапчасти (план `docs/auto-part-receipts-plan.md`, §7) — свой префикс, а не ветка
  // склада, который они заменили: предмет у чека другой (бумага с суммой, а не позиция с
  // остатком). Склада на сервере больше нет — выпуск 2 «Заморозка» снял `/api/v1/auto-parts`
  // целиком (Р2, Р22); таблицы `auto_part*` остались в базе нетронутыми на случай возврата
  // решения, но ходить в них некому.
  await app.register(autoPartReceiptsRoutes, { prefix: '/api/v1/auto-part-receipts' });
  // Техобслуживание по пробегу (план «Показания техники», Р14) — свой префикс, а не ветка
  // показаний: права у него свои (`vehicleMaintenance.*`), и держит их порознь ровно то, что
  // служба главного механика ведёт ТО, не открывая приёмку, журналы и фотографии показаний.
  await app.register(vehicleMaintenanceRoutes, { prefix: '/api/v1/vehicle-maintenance' });
  await app.register(waybillsRoutes, { prefix: '/api/v1/waybills' });
  await app.register(wasteRequestsRoutes, { prefix: '/api/v1/waste-requests' });
  // Разбор талонов — отдельный роут на том же префиксе: у него своё право (`ticketReview`), и
  // держать его вместе со статусами заявки значило бы смешивать две области доступа в одном файле.
  await app.register(wasteTicketsRoutes, { prefix: '/api/v1/waste-requests' });
  // Аудит распознавания талонов (ADR 0137, план аудита §6) — третий плагин на том же префиксе.
  // Порознь с разбором, потому что порознь их держит не размер файла, а область доступа: разбор
  // вложен в заявку и проходит область объекта с оператором, а сводка сквозная по всему порталу
  // и закрыта своим правом `wasteRequests.ticketAudit`, которое выдаётся поимённо (§4.1).
  await app.register(ticketAuditRoutes, { prefix: '/api/v1/waste-requests' });
  // Аренда малой механизации (план `docs/mechanization-module-plan.md`) — свой префикс и свои
  // права: с вывозом мусора модуль делит только ось области (площадка эксплуатации), а цикл,
  // заявитель и предмет у него собственные.
  await app.register(mechRequestsRoutes, { prefix: '/api/v1/mech-requests' });
  // Справочник моделей механизации (план `docs/mechanization-models-directory-plan.md`) — рядом с
  // заявкой, хотя ведут его в «Справочниках»: заявка сядет на него этапом Э2, и искать их порознь
  // придётся тому же человеку.
  await app.register(mechModelsRoutes, { prefix: '/api/v1/mech-models' });
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
  // Тот же внутренний контур и тот же секрет: worker будит автозакрытие заявок оргтехники
  // «Решена» → «Закрыта» (план `docs/office-equipment-requests-rework-plan.md`, решение Н7).
  await app.register(internalServiceRequestRoutes, { prefix: '/internal/service-requests' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  // Журнал обновлений (ADR 0077) — служебное окно, а не раздел: читает любой вошедший, права нет.
  await app.register(releasesRoutes, { prefix: '/api/v1/releases' });
  // Руководства (`docs/manuals-plan.md`) — соседнее служебное окно: список читает любой вошедший,
  // а ведёт его держатель `manuals.manage`, и обе роли живут на одном префиксе.
  await app.register(manualsRoutes, { prefix: '/api/v1/manuals' });

  return app;
}
