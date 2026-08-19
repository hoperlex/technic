import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  can,
  type ClassificationFilter,
  driverDocumentGaps,
  type GarageDriverListDto,
  garageDriverQuerySchema,
  type GarageDriversSummaryDto,
  type GarageDriverState,
  type GarageVehicleDto,
  type GarageVehicleListDto,
  garageVehicleQuerySchema,
  type GarageVehiclesSummaryDto,
  type GarageVehicleState,
  licenseNumberLabel,
  moscowDateKeyOf,
  requiredCredentialType,
  vehicleLabel,
  type VehicleReadingDayState,
  waybillDocumentOf,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { db } from '../db/client';
import {
  personEmployments,
  persons,
  vehicleCategories,
  vehicleModels,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { queryClassificationWhere } from '../lib/classification-filter';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  documentsCompleteCondition,
  driverCondition,
  loadDriverLicenses,
} from '../services/drivers';
import {
  driversOfBusy,
  driverStateSql,
  loadDriverBusy,
  loadVehicleBusy,
  vehicleStateSql,
} from '../services/garage';
import { loadLastOdometers } from '../services/readings-aggregate';
import { loadVehicleReadingStates, pendingReadingsSql } from '../services/readings-stats';

/**
 * Гараж: чем занят день собственной техники и водителей (ADR 0076).
 *
 * Раздел читающий и никаких действий не предлагает — ни здесь, ни на портале: заявки, рейсы и
 * бланки ведут в своих модулях, а срез отвечает на единственный вопрос «кто чем занят и кто
 * свободен». Поэтому у всех четырёх ручек одно право, `garage.read`, и ни одной мутирующей.
 *
 * Право своё, а не сумма прав тех списков, из которых срез собран: в строке видно, кто за рулём, —
 * это те же персональные данные, что в карточке водителя (ADR 0037 п. 13).
 */

/** Свободные первыми: гараж открывают вопросом «кому дать работу», а не «кто уже занят». */
const vehicleStateOrderSql = (on: string): SQL => sql`CASE ${vehicleStateSql(on)}
  WHEN 'free' THEN 0 WHEN 'on_route' THEN 1 WHEN 'on_site' THEN 2 ELSE 3 END`;

const driverStateOrderSql = (on: string): SQL => sql`CASE ${driverStateSql(on)}
  WHEN 'free' THEN 0 ELSE 1 END`;

/**
 * День среза: присланный либо сегодняшний по Москве. Считает его сервер даже тогда, когда клиент
 * прислал дату, — и возвращает в ответе: часы браузера бывают сбиты, а восточнее Москвы сутки
 * начинаются раньше, и подписи разошлись бы с отбором (приём вкладки «На объекте», ADR 0036).
 */
function dayOf(on: string | undefined): string {
  return on ?? moscowDateKeyOf(new Date());
}

/**
 * Фильтр «не сданы» и колонка «Показания» (ADR 0103, Р27) — расширение вкладки техники, которого
 * контракт гаража пока не описывает: этап показаний `packages/contracts` не трогает, а колонке уже
 * есть что показывать. Схема и тип живут здесь ровно до того, как контракт их узнает.
 *
 * Значение у фильтра одно: «не сданы» — вопрос следующего утра, и обратного к нему («сданы») никто
 * не задаёт.
 */
const vehicleListQuerySchema = garageVehicleQuerySchema.extend({
  readings: z.enum(['pending']).optional(),
});

interface GarageVehicleWithReadings extends GarageVehicleDto {
  /** Что с показаниями машины за этот день — одно значение из пяти, по старшинству (Р27). */
  readingState: VehicleReadingDayState;
}

interface GarageVehicleListWithReadingsDto extends GarageVehicleListDto {
  items: GarageVehicleWithReadings[];
}

/**
 * Условия перечня техники: собственный парк, живые записи, набор позиций классификатора и поиск.
 * Общие у страницы и сводки — иначе сводка отвечала бы не про тот список, который человек видит
 * перед собой.
 *
 * Только `ownership='own'` (ADR 0076): гараж — свой парк. Предложение аренды машиной не является
 * вовсе — это строка прайса арендодателя, у неё нет ни госномера, ни рейса, ни листа.
 */
function vehicleWhere(q: {
  classifications?: ClassificationFilter;
  vehicleTypeId?: string;
  vehicleCategoryId?: string;
  search?: string;
}): SQL {
  return and(
    eq(vehicles.ownership, 'own'),
    isNull(vehicles.deletedAt),
    // Позиции классификатора (ADR 0028) набором: типы целиком и отдельные категории сразу — тот
    // же фильтр, что в заявках. Прежнюю пару полей принимает тот же вызов, пока её шлют вкладки
    // со старым JS.
    queryClassificationWhere(vehicles.vehicleTypeId, vehicles.vehicleCategoryId, q),
    // Ищут по тому, что видят на борту и в путевом листе: госномер (гомоглифы сводит
    // `vehicle_reg_normalize`, как и в справочнике), марка, гаражный номер.
    q.search
      ? or(
          sql`${vehicles.registrationNumberNormalized} ILIKE '%' || vehicle_reg_normalize(${q.search}) || '%'`,
          ilike(vehicleModels.name, `%${q.search}%`),
          ilike(vehicles.garageNumber, `%${q.search}%`),
        )
      : undefined,
  )!;
}

/**
 * Строка перечня техники. Категория и марка необязательны — их подставляет `leftJoin`, — а тип
 * есть у машины всегда; те же три join'а повторяют счётчик и сводка: `where` ссылается на все три
 * таблицы, и без них запрос не собрался бы.
 */
function vehicleQuery(state: SQL<GarageVehicleState>) {
  return db
    .select({
      id: vehicles.id,
      state,
      status: vehicles.status,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      garageNumber: vehicles.garageNumber,
      vehicleTypeId: vehicles.vehicleTypeId,
      typeName: vehicleTypes.name,
      vehicleCategoryId: vehicles.vehicleCategoryId,
      categoryName: vehicleCategories.name,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId));
}

/**
 * Те же join'ы под счётчик и сводку. Столбцы перечислены обоими сразу — `count(*) FILTER` считает
 * ровно те состояния, что перечисляет `GarageVehicleState`, а счётчику страницы нужен только
 * `total`: разделять их на два запроса ради четырёх неиспользуемых чисел незачем.
 */
function vehicleTotalsQuery(state: SQL<GarageVehicleState>) {
  return db
    .select({
      total: count(),
      free: sql<number>`count(*) FILTER (WHERE ${state} = 'free')`,
      onRoute: sql<number>`count(*) FILTER (WHERE ${state} = 'on_route')`,
      onSite: sql<number>`count(*) FILTER (WHERE ${state} = 'on_site')`,
      unavailable: sql<number>`count(*) FILTER (WHERE ${state} = 'unavailable')`,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId));
}

/**
 * Условия перечня водителей: действующая специализация водителя и фильтр комплекта документов —
 * оба теми же выражениями, что у справочника (`driverCondition`, `documentsCompleteCondition`).
 * Комплект считается **на день среза**, а не на сегодня: тот же человек годен на вчерашний рейс и
 * просрочен на завтрашний.
 */
function driverWhere(
  q: { documents?: 'complete' | 'incomplete'; search?: string },
  on: string,
): SQL {
  const complete = documentsCompleteCondition(on);
  return and(
    isNull(persons.deletedAt),
    driverCondition(),
    q.documents === undefined
      ? undefined
      : q.documents === 'complete'
        ? complete
        : sql`NOT (${complete})`,
    // Ищут по ФИО и табельному — тем же двум полям, которыми водителя зовут в наряде.
    q.search
      ? or(
          searchCondition(q.search, [persons.fullName]),
          searchCondition(q.search, [personEmployments.personnelNo]),
        )
      : undefined,
  )!;
}

/**
 * Строка перечня водителей: человек и его действующее трудовое отношение — табельный номер и
 * должность. Должность здесь не для показа: ею выбирается вид документа, по которому считаются
 * пробелы комплекта и берётся удостоверение для листа (ADR 0095).
 */
function driverQuery(state: SQL<GarageDriverState>) {
  return db
    .select({
      personId: persons.id,
      state,
      fullName: persons.fullName,
      snils: persons.snils,
      phone: persons.phone,
      personnelNo: personEmployments.personnelNo,
      jobTitle: personEmployments.jobTitle,
    })
    .from(persons)
    .leftJoin(
      personEmployments,
      and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
    );
}

/** Тот же join под счётчик и сводку: по табельному идёт поиск, и без него `where` не собрать. */
function driverTotalsQuery(state: SQL<GarageDriverState>, complete: SQL) {
  return db
    .select({
      total: count(),
      free: sql<number>`count(*) FILTER (WHERE ${state} = 'free')`,
      assigned: sql<number>`count(*) FILTER (WHERE ${state} = 'assigned')`,
      documentsIncomplete: sql<number>`count(*) FILTER (WHERE NOT (${complete}))`,
    })
    .from(persons)
    .leftJoin(
      personEmployments,
      and(eq(personEmployments.personId, persons.id), isNull(personEmployments.endedOn)),
    );
}

export default async function garageRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = [app.authenticate, app.requirePermission('garage.read')];

  r.get(
    '/vehicles',
    { preHandler: guards, schema: { querystring: vehicleListQuerySchema } },
    async (req): Promise<GarageVehicleListWithReadingsDto> => {
      const q = req.query;
      const on = dayOf(q.on);
      const state = vehicleStateSql(on);
      const where = and(
        vehicleWhere(q),
        q.state ? sql`${state} = ${q.state}` : undefined,
        // Отбор идёт до страницы, а не после: «не сданы» — это фильтр списка, и посчитанный по
        // загруженной странице он врал бы и в счётчике, и в листании.
        //
        // Спрашивает он **ожидаемую смену дня** (Р26б), а не строку ожидания, поэтому в отбор
        // попадает и день, который никто не открывал: у водителя без учётки строк нет вовсе, а
        // показания за него вводит диспетчер. Колонка такой день подписывает «нет» — состояний,
        // кроме пяти, у неё не прибавилось, — и это не разнобой: «нет» она показывает и у
        // открытого дня, по которому не сдано ничего.
        q.readings === 'pending' ? pendingReadingsSql(on) : undefined,
      )!;

      const sortCols = {
        state: vehicleStateOrderSql(on),
        registrationNumber: vehicles.registrationNumberNormalized,
        typeName: vehicleTypes.name,
        status: vehicles.status,
      };
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        vehicleQuery(state)
          .where(where)
          // Вторым ключом всегда госномер: машин с одним состоянием в парке десятки, и без него
          // страницы разъезжались бы между запросами.
          .orderBy(
            orderByFrom(sortCols, q.sortBy, q.sortOrder, 'state'),
            vehicles.registrationNumberNormalized,
          )
          .limit(pg.limit)
          .offset(pg.offset),
        vehicleTotalsQuery(state).where(where),
      ]);

      /**
       * Одометр — данные модуля показаний, а не гаража: `garage.read` открывает срез дня, а цифры
       * приборов открывает `vehicleReadings.read` (план «Показания техники», Р16). Без него запрос
       * не уходит вовсе и поля в ответе нет — `null` означал бы «показаний не было», то есть
       * отвечал бы неправду про парк вместо молчания про доступ.
       */
      const showOdometer = can(requirePrincipal(req), 'vehicleReadings.read');

      // Занятости, состояние показаний и последний одометр добираются по найденной странице —
      // одним приёмом и одним заходом: все три ответа относятся к тем же машинам, и второй круг
      // ожидания здесь ни к чему. Каждый из трёх — одна выборка на страницу, а не на строку.
      const vehicleIds = rows.map((row) => row.id);
      const [busy, readings, odometers] = await Promise.all([
        loadVehicleBusy(on, vehicleIds),
        loadVehicleReadingStates(on, vehicleIds),
        showOdometer ? loadLastOdometers(vehicleIds, on) : null,
      ]);

      return {
        items: rows.map((row) => {
          const entries = busy.get(row.id) ?? [];
          return {
            id: row.id,
            // Строк ожидания у машины в этот день не нашлось вовсе — «нет» (Р27): задания не было
            // либо кабинет его ещё не открывал.
            readingState: readings.get(row.id) ?? 'none',
            state: row.state,
            status: row.status,
            label: vehicleLabel(row),
            registrationNumber: row.registrationNumber,
            garageNumber: row.garageNumber ?? '',
            modelName: row.modelName,
            vehicleTypeId: row.vehicleTypeId,
            typeName: row.typeName,
            vehicleCategoryId: row.vehicleCategoryId,
            categoryName: row.categoryName,
            busy: entries,
            drivers: driversOfBusy(entries),
            // Показания на этот день у машины есть не всегда, и `null` здесь — законный ответ:
            // машину могли завести вчера, а её счётчик снять некому.
            ...(odometers === null ? {} : { lastOdometer: odometers.get(row.id) ?? null }),
          };
        }),
        total: Number(totalRows[0]!.total),
        page: pg.page,
        pageSize: pg.pageSize,
        onDate: on,
      };
    },
  );

  /**
   * Итог по парку. Фильтр состояния сюда не приходит намеренно: сводка тем и отвечает, сколько
   * машин в каждом состоянии, — суженная им, она свелась бы к одной своей цифре.
   */
  r.get(
    '/vehicles/summary',
    { preHandler: guards, schema: { querystring: garageVehicleQuerySchema } },
    async (req): Promise<GarageVehiclesSummaryDto> => {
      const on = dayOf(req.query.on);
      const state = vehicleStateSql(on);
      const where = vehicleWhere(req.query);

      const [totals] = await vehicleTotalsQuery(state).where(where);

      // Рейсы без водителя считаются по самим рейсам, а не по машинам: у одной машины бывает два
      // рейса за день, и «машин с рейсом без водителя» ответило бы на другой вопрос — сколько
      // бланков сегодня не выписать, видно только по рейсам.
      const [routes] = await db
        .select({ c: count() })
        .from(vehicleRoutes)
        .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
        .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
        .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
        .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
        .where(and(eq(vehicleRoutes.routeDate, on), isNull(vehicleRoutes.driverPersonId), where));

      return {
        total: Number(totals!.total),
        free: Number(totals!.free),
        onRoute: Number(totals!.onRoute),
        onSite: Number(totals!.onSite),
        unavailable: Number(totals!.unavailable),
        routesWithoutDriver: Number(routes!.c),
        onDate: on,
      };
    },
  );

  r.get(
    '/drivers',
    { preHandler: guards, schema: { querystring: garageDriverQuerySchema } },
    async (req): Promise<GarageDriverListDto> => {
      const q = req.query;
      const on = dayOf(q.on);
      const state = driverStateSql(on);
      const where = and(driverWhere(q, on), q.state ? sql`${state} = ${q.state}` : undefined)!;

      const sortCols = {
        state: driverStateOrderSql(on),
        fullName: persons.fullName,
        personnelNo: personEmployments.personnelNo,
      };
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        driverQuery(state)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'state'), persons.fullName)
          .limit(pg.limit)
          .offset(pg.offset),
        driverTotalsQuery(state, documentsCompleteCondition(on)).where(where),
      ]);

      const personIds = rows.map((row) => row.personId);
      const [busy, licenses] = await Promise.all([
        loadDriverBusy(on, personIds),
        loadDriverLicenses(db, personIds),
      ]);

      return {
        items: rows.map((row) => {
          const own = licenses.get(row.personId) ?? [];
          const jobTitle = row.jobTitle ?? '';
          // Документ, которым лист выпишется на этот день, и пробелы комплекта — теми же двумя
          // функциями, что показывают карточку водителя и форму выписки (ADR 0064). Вид документа
          // задаёт должность (ADR 0095): у машиниста погрузчика лист выпишется по тракторному, и
          // водительское, лежащее рядом, ни граф не заполнит, ни пробел не закроет.
          const license = waybillDocumentOf(own, jobTitle, on);
          return {
            personId: row.personId,
            state: row.state,
            fullName: row.fullName,
            personnelNo: row.personnelNo ?? '',
            phone: row.phone,
            credentialTypeCode: requiredCredentialType(jobTitle),
            licenseNumber: license ? licenseNumberLabel(license) : '',
            licenseExpiresOn: license?.expiresOn ?? null,
            categories: license?.categories.map((c) => c.name) ?? [],
            gaps: driverDocumentGaps({ snils: row.snils, jobTitle, licenses: own }, on),
            busy: busy.get(row.personId) ?? [],
          };
        }),
        total: Number(totalRows[0]!.total),
        page: pg.page,
        pageSize: pg.pageSize,
        onDate: on,
      };
    },
  );

  r.get(
    '/drivers/summary',
    { preHandler: guards, schema: { querystring: garageDriverQuerySchema } },
    async (req): Promise<GarageDriversSummaryDto> => {
      const on = dayOf(req.query.on);
      const state = driverStateSql(on);
      // Фильтр комплекта сводку не сужает по той же причине, что и состояние: «сколько с
      // пробелами» — одна из её цифр.
      const where = driverWhere({ search: req.query.search }, on);
      const complete = documentsCompleteCondition(on);

      const [totals] = await driverTotalsQuery(state, complete).where(where);

      return {
        total: Number(totals!.total),
        free: Number(totals!.free),
        assigned: Number(totals!.assigned),
        documentsIncomplete: Number(totals!.documentsIncomplete),
        onDate: on,
      };
    },
  );
}
