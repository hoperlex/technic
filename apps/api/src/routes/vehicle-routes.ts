import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, gte, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  attachRouteRequestSchema,
  canIssueWaybill,
  canJoinRoute,
  createVehicleRouteSchema,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRouteEditable,
  issueRouteWaybillSchema,
  MAX_ROUTE_REQUESTS,
  parseVehicleRouteNumberSearch,
  ROUTE_FROZEN_MESSAGE,
  ROUTE_LEGACY_WAYBILL_MESSAGE,
  routeOrderSchema,
  routeVersionQuerySchema,
  type RouteTripFields,
  updateVehicleRouteSchema,
  type VehicleRouteDto,
  vehicleRouteListQuerySchema,
  vehicleStatusLabels,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  persons,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { assertRequestScope } from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { issueWaybillForRoute, tripDate } from '../services/waybill-issue';
import {
  assertRouteVersion,
  attachRequest,
  bumpRouteVersion,
  detachRequest,
  lastTripFields,
  legacyWaybillOf,
  loadRouteDto,
  loadRouteDtos,
  lockRoute,
  lockRoutePair,
  routeOfRequest,
  routeQuery,
  routeRequestCount,
  routeWaybill,
  setRouteOrder,
} from '../services/vehicle-routes';

/**
 * Маршруты: рейс одной машины на дату (план `docs/vehicle-routes-plan.md`).
 *
 * Заявку кладут в рейс переводом в работу (`vehicle-requests`) либо руками здесь; лист
 * выписывается с рейса отдельным действием, когда состав собран. Выписанный лист рейс
 * замораживает — правки отклоняются, пока его не аннулируют.
 *
 * Права спрашиваются обе сразу: `waybills.read` (в рейсе виден водитель — те же персональные
 * данные, что в листе) и `vehicleRequests.status` (рейс — это ход работы по заявке). Одного
 * второго мало: оно есть у внешнего арендодателя, у которого `waybills.read` нет, а в рейсе лежат
 * чужие заявки и допуски водителей собственного парка.
 */

const idParams = z.object({ id: z.string().uuid() });
const requestParams = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });

/** Реквизиты рейса из тела запроса: незаполненные графы — пустые строки, а не «не трогать». */
function tripValues(trip: RouteTripFields | undefined) {
  return {
    withTrailer: trip?.withTrailer ?? false,
    trailer1Model: trip?.trailer1Model ?? '',
    trailer1RegNumber: trip?.trailer1RegNumber ?? '',
    trailer2Model: trip?.trailer2Model ?? '',
    trailer2RegNumber: trip?.trailer2RegNumber ?? '',
    garageNumber: trip?.garageNumber ?? '',
    communicationKind: trip?.communicationKind ?? '',
    transportationKind: trip?.transportationKind ?? '',
  };
}

/**
 * Машина рейса: собственная, живая и с бланком путевого листа за типом. Проверяется при заведении
 * рейса — дальше состав сверяется уже с ней (`canJoinRoute` спрашивает принадлежность назначенной
 * машины заявки).
 */
async function assertRouteVehicle(vehicleId: string): Promise<void> {
  const [row] = await db
    .select({
      ownership: vehicles.ownership,
      status: vehicles.status,
      deletedAt: vehicles.deletedAt,
      formCode: vehicleTypes.waybillFormCode,
      typeName: vehicleTypes.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(eq(vehicles.id, vehicleId));
  if (!row || row.deletedAt) throw err.badRequest('Техника не найдена');
  if (row.ownership !== 'own') {
    throw err.unprocessable(
      'Маршрут ведётся только для собственной техники: путевой лист на арендную выписывает арендодатель',
      { vehicleId: 'Арендная техника' },
    );
  }
  if (row.status !== 'active') {
    throw err.unprocessable(
      `Техника недоступна: ${vehicleStatusLabels[row.status].toLowerCase()}`,
      {
        vehicleId: 'Техника недоступна',
      },
    );
  }
  if (!row.formCode) {
    throw err.unprocessable(`Для типа «${row.typeName}» бланк путевого листа не заведён`, {
      vehicleId: 'Тип без бланка',
    });
  }
}

/**
 * Водитель существует. Допуск к этой машине на эту дату не проверяется здесь намеренно: он
 * проверяется отбором при выписке листа (ADR 0037 п. 6) — до неё рейс планируют и человека
 * ставят предварительно, а удостоверение может быть в работе у кадровика.
 */
async function assertDriver(driverPersonId: string): Promise<void> {
  const [row] = await db
    .select({ deletedAt: persons.deletedAt })
    .from(persons)
    .where(eq(persons.id, driverPersonId));
  if (!row || row.deletedAt) throw err.badRequest('Водитель не найден');
}

/** Заморозку проверяют все правки рейса — состав, порядок, шапка. */
async function assertRouteEditable(tx: Parameters<typeof lockRoute>[0], routeId: string) {
  const waybill = await routeWaybill(tx, routeId);
  if (!isRouteEditable(waybill?.status ?? null)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
  return waybill;
}

/** Заявка глазами правил рейса: вид, состояние, дата подачи и чем её взяли в работу. */
async function loadRequestForRoute(tx: Parameters<typeof lockRoute>[0], requestId: string) {
  const [row] = await tx
    .select({
      id: vehicleRequests.id,
      num: vehicleRequests.num,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      vehicleTypeId: vehicleRequests.vehicleTypeId,
      assignedVehicleId: vehicleRequestAssignments.vehicleId,
      ownership: vehicles.ownership,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId))
    // Порядок блокировок один на модуль: сначала рейсы, потом заявки (иначе выписка листа и
    // смена статуса заявки встретятся встречными блокировками).
    .for('update', { of: vehicleRequests });
  if (!row) throw err.notFound('Заявка не найдена');
  return row;
}

export default async function vehicleRoutesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Обе проверки на каждой ручке — см. заголовок файла.
  const guards = [
    app.authenticate,
    app.requirePermission('waybills.read', 'Недостаточно прав для работы с маршрутами'),
    app.requirePermission('vehicleRequests.status', 'Недостаточно прав для работы с маршрутами'),
  ];

  const sortColumns = {
    routeDate: vehicleRoutes.routeDate,
    num: vehicleRoutes.num,
    createdAt: vehicleRoutes.createdAt,
  };

  r.get(
    '/',
    { preHandler: guards, schema: { querystring: vehicleRouteListQuerySchema } },
    async (req) => {
      const q = req.query;
      const conditions: (SQL | undefined)[] = [
        q.dateFrom ? gte(vehicleRoutes.routeDate, q.dateFrom) : undefined,
        q.dateTo ? lte(vehicleRoutes.routeDate, q.dateTo) : undefined,
        q.vehicleId ? eq(vehicleRoutes.vehicleId, q.vehicleId) : undefined,
        q.driverPersonId ? eq(vehicleRoutes.driverPersonId, q.driverPersonId) : undefined,
        q.num ? eq(vehicleRoutes.num, q.num) : undefined,
      ];

      // Ищут рейс двумя способами: по номеру («Р-12», «12») и по тому, чем он запомнился —
      // госномеру машины или фамилии водителя. Номер разбирается первым: «12» это рейс, а не
      // кусок госномера.
      if (q.search) {
        const num = parseVehicleRouteNumberSearch(q.search);
        conditions.push(
          num
            ? eq(vehicleRoutes.num, num)
            : searchCondition(q.search, [vehicles.registrationNumber, persons.fullName]),
        );
      }

      // «Лист ещё не выписан» — то, чем диспетчер закрывает день, поэтому фильтр по документу
      // спрашивает наличие действующего листа, а не любого: аннулированный рейс не держит.
      const issuedWaybill = db
        .select({ one: sql`1` })
        .from(waybills)
        .where(and(eq(waybills.routeId, vehicleRoutes.id), ne(waybills.status, 'cancelled')));
      if (q.waybill === 'issued') conditions.push(sql`EXISTS ${issuedWaybill}`);
      if (q.waybill === 'none') conditions.push(sql`NOT EXISTS ${issuedWaybill}`);

      if (q.hasFreeSlots !== undefined) {
        const used = db
          .select({ c: count() })
          .from(vehicleRouteRequests)
          .where(eq(vehicleRouteRequests.routeId, vehicleRoutes.id));
        conditions.push(
          q.hasFreeSlots
            ? sql`(${used}) < ${MAX_ROUTE_REQUESTS}`
            : sql`(${used}) >= ${MAX_ROUTE_REQUESTS}`,
        );
      }

      const where = and(...conditions);
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        routeQuery(db)
          .where(where)
          // Вторым ключом всегда номер: рейсов одного дня несколько (смены), и без него страницы
          // разъезжались бы между запросами.
          .orderBy(
            orderByFrom(sortColumns, q.sortBy, q.sortOrder, 'routeDate'),
            desc(vehicleRoutes.num),
          )
          .limit(pg.limit)
          .offset(pg.offset),
        db.select({ c: count() }).from(vehicleRoutes).where(where),
      ]);

      return {
        items: await loadRouteDtos(db, rows),
        total: Number(totalRows[0]!.c),
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );

  /**
   * Рейсы этой машины на эту дату — ими форма перевода в работу предлагает готовый рейс вместо
   * второго, плюс реквизиты прошлого рейса машины для нового.
   */
  r.get(
    '/suggest',
    {
      preHandler: guards,
      schema: {
        querystring: z.object({ vehicleId: z.string().uuid(), date: z.string() }),
      },
    },
    async (req) => {
      const rows = await routeQuery(db)
        .where(
          and(
            eq(vehicleRoutes.vehicleId, req.query.vehicleId),
            eq(vehicleRoutes.routeDate, req.query.date),
          ),
        )
        .orderBy(asc(vehicleRoutes.num));
      return {
        routes: await loadRouteDtos(db, rows),
        trip: await lastTripFields(req.query.vehicleId),
      };
    },
  );

  r.get('/:id', { preHandler: guards, schema: { params: idParams } }, async (req) => {
    const dto = await loadRouteDto(db, req.params.id);
    if (!dto) throw err.notFound('Маршрут не найден');
    return dto;
  });

  r.post(
    '/',
    { preHandler: guards, schema: { body: createVehicleRouteSchema } },
    async (req, reply): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      await assertRouteVehicle(body.vehicleId);
      if (body.driverPersonId) await assertDriver(body.driverPersonId);

      const [created] = await db
        .insert(vehicleRoutes)
        .values({
          vehicleId: body.vehicleId,
          routeDate: body.routeDate,
          driverPersonId: body.driverPersonId ?? null,
          comment: body.comment,
          ...tripValues(body.trip),
          createdBy: p.id,
        })
        .returning({ id: vehicleRoutes.id, num: vehicleRoutes.num });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.create',
        entityType: 'vehicle_route',
        entityId: created!.id,
        metadata: {
          number: formatVehicleRouteNumber(created!.num),
          vehicleId: body.vehicleId,
          routeDate: body.routeDate,
        },
      });
      reply.code(201);
      return (await loadRouteDto(db, created!.id))!;
    },
  );

  /** Водитель, реквизиты рейса и комментарий. Состав правится своими ручками — он про заявки. */
  r.patch(
    '/:id',
    { preHandler: guards, schema: { params: idParams, body: updateVehicleRouteSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      if (body.driverPersonId) await assertDriver(body.driverPersonId);

      await db.transaction(async (tx) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, body.version);
        await assertRouteEditable(tx, route.id);

        await tx
          .update(vehicleRoutes)
          .set({
            ...(body.driverPersonId !== undefined
              ? { driverPersonId: body.driverPersonId }
              : undefined),
            ...(body.trip ? tripValues(body.trip) : undefined),
            ...(body.comment !== undefined ? { comment: body.comment } : undefined),
          })
          .where(eq(vehicleRoutes.id, route.id));
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.update',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { driverPersonId: body.driverPersonId ?? null },
      });
      return (await loadRouteDto(db, req.params.id))!;
    },
  );

  /**
   * Удаляется только пустой рейс, у которого нет ни одного листа — даже аннулированного:
   * аннулированный бланк лежит в журнале учёта и обязан сохранить свой рейс (FK restrict).
   */
  r.delete('/:id', { preHandler: guards, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    await db.transaction(async (tx) => {
      const route = await lockRoute(tx, req.params.id);
      if ((await routeRequestCount(tx, route.id)) > 0) {
        throw err.conflict('В маршруте есть заявки — сначала выньте их');
      }
      const [anyWaybill] = await tx
        .select({ id: waybills.id })
        .from(waybills)
        .where(eq(waybills.routeId, route.id));
      if (anyWaybill) {
        throw err.conflict('По маршруту выписывался путевой лист — рейс остаётся в журнале');
      }
      await tx.delete(vehicleRoutes).where(eq(vehicleRoutes.id, route.id));
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'vehicle_route.delete',
      entityType: 'vehicle_route',
      entityId: req.params.id,
      metadata: {},
    });
    return { ok: true };
  });

  /**
   * Положить заявку в рейс или перенести её из другого.
   *
   * Перенос — операция над двумя рейсами: заявка уходит из исходного, приходит в целевой, и в
   * исходном уплотняются талоны. Поэтому блокируются оба (в порядке `id`), связь читается уже под
   * блокировками, а заморозка проверяется у обоих: из бланка, который у водителя, заявка исчезнуть
   * не может.
   */
  r.post(
    '/:id/requests',
    { preHandler: guards, schema: { params: idParams, body: attachRouteRequestSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      await db.transaction(async (tx) => {
        const { target, source } = await lockRoutePair(
          tx,
          req.params.id,
          body.source?.routeId ?? null,
        );
        assertRouteVersion(target, body.version);
        if (body.source && source) assertRouteVersion(source, body.source.version);
        await assertRouteEditable(tx, target.id);
        if (source && source.id !== target.id) await assertRouteEditable(tx, source.id);

        const request = await loadRequestForRoute(tx, body.requestId);
        assertRequestScope(p, request);

        // Где заявка лежит на самом деле — после блокировок: до них она могла уехать в третий рейс.
        const current = await routeOfRequest(tx, body.requestId);
        if (current && current.routeId !== target.id) {
          if (!body.source || body.source.routeId !== current.routeId) {
            throw err.conflict(
              `Заявка ${formatVehicleRequestNumber(request.num)} лежит в другом маршруте — обновите список`,
            );
          }
        }
        if (current?.routeId === target.id) return; // уже здесь: перевод в работу идемпотентен

        const check = canJoinRoute(
          {
            requestType: request.requestType,
            status: request.status,
            deletedAt: request.deletedAt?.toISOString() ?? null,
            tripDate: await tripDate(tx, request.id),
            ownership: request.ownership ?? null,
          },
          {
            routeDate: target.routeDate,
            requestCount: await routeRequestCount(tx, target.id),
          },
        );
        if (!check.ok) throw err.unprocessable(check.reason, { requestId: check.reason });

        const legacy = await legacyWaybillOf(tx, request.id);
        if (legacy) throw err.unprocessable(`${ROUTE_LEGACY_WAYBILL_MESSAGE} (${legacy})`);

        if (current) {
          await detachRequest(tx, current.routeId, request.id);
          await bumpRouteVersion(tx, current.routeId, p.id);
        }
        await attachRequest(tx, target.id, request.id);

        // Рейс — источник истины о том, чем едут: заявка, переехавшая на другую машину, меняет
        // назначение вместе с рейсом. Ставки не трогаются — о них договариваются по заявке.
        if (request.assignedVehicleId !== target.vehicleId) {
          if (request.vehicleTypeId !== (await vehicleTypeOf(tx, target.vehicleId))) {
            throw err.unprocessable('Машина маршрута другого типа, чем заказано в заявке', {
              requestId: 'Другой тип ТС',
            });
          }
          await tx
            .update(vehicleRequestAssignments)
            .set({
              vehicleId: target.vehicleId,
              vehicleTypeId: request.vehicleTypeId,
              updatedAt: new Date(),
            })
            .where(eq(vehicleRequestAssignments.requestId, request.id));
        }
        await bumpRouteVersion(tx, target.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.attach',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { requestId: body.requestId, from: body.source?.routeId ?? null },
      });
      return (await loadRouteDto(db, req.params.id))!;
    },
  );

  /** Вынуть заявку: она остаётся «В работе», но без рейса — список заявок помечает такую тегом. */
  r.delete(
    '/:id/requests/:requestId',
    {
      preHandler: guards,
      schema: { params: requestParams, querystring: routeVersionQuerySchema },
    },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      await db.transaction(async (tx) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, req.query.version);
        await assertRouteEditable(tx, route.id);
        const removed = await detachRequest(tx, route.id, req.params.requestId);
        if (!removed) throw err.notFound('Заявки нет в этом маршруте');
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.detach',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { requestId: req.params.requestId },
      });
      return (await loadRouteDto(db, req.params.id))!;
    },
  );

  /** Новый порядок талонов — полным составом: сервер переписывает его целиком. */
  r.put(
    '/:id/order',
    { preHandler: guards, schema: { params: idParams, body: routeOrderSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      await db.transaction(async (tx) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, body.version);
        await assertRouteEditable(tx, route.id);

        const rows = await tx
          .select({ requestId: vehicleRouteRequests.requestId })
          .from(vehicleRouteRequests)
          .where(eq(vehicleRouteRequests.routeId, route.id));
        const current = new Set(rows.map((row) => row.requestId));
        const sent = new Set(body.requestIds);
        if (current.size !== sent.size || [...current].some((id) => !sent.has(id))) {
          throw err.unprocessable(
            'Порядок присылается полным составом маршрута — обновите его и попробуйте снова',
          );
        }
        await setRouteOrder(tx, route.id, body.requestIds);
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.reorder',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { order: body.requestIds },
      });
      return (await loadRouteDto(db, req.params.id))!;
    },
  );

  /**
   * Выписать лист по рейсу.
   *
   * Статусы заявок перечитываются под блокировкой их строк: состав лежит в одной таблице, а
   * статусы — в другой, и без этого соседний запрос успел бы закрыть заявку между проверкой и
   * вставкой листа — бланк родился бы на закрытую.
   */
  r.post(
    '/:id/waybill',
    { preHandler: guards, schema: { params: idParams, body: issueRouteWaybillSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);

      const issued = await db.transaction(async (tx) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, req.body.version);
        const waybill = await routeWaybill(tx, route.id);

        const rows = await tx
          .select({
            requestId: vehicleRouteRequests.requestId,
            position: vehicleRouteRequests.position,
            num: vehicleRequests.num,
            status: vehicleRequests.status,
          })
          .from(vehicleRouteRequests)
          .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
          .where(eq(vehicleRouteRequests.routeId, route.id))
          .orderBy(asc(vehicleRouteRequests.position))
          .for('update', { of: vehicleRequests });

        const check = canIssueWaybill({
          driverPersonId: route.driverPersonId,
          requests: rows.map((row) => ({
            displayNumber: formatVehicleRequestNumber(row.num),
            status: row.status,
          })),
          waybillStatus: waybill?.status ?? null,
        });
        if (!check.ok) {
          throw err.unprocessable(
            check.blocking.length > 0
              ? `${check.reason}: ${check.blocking.join(', ')}`
              : check.reason,
          );
        }

        const result = await issueWaybillForRoute(tx, {
          routeId: route.id,
          vehicleId: route.vehicleId,
          routeDate: route.routeDate,
          driverPersonId: route.driverPersonId!,
          trip: {
            withTrailer: route.withTrailer,
            trailer1Model: route.trailer1Model,
            trailer1RegNumber: route.trailer1RegNumber,
            trailer2Model: route.trailer2Model,
            trailer2RegNumber: route.trailer2RegNumber,
            garageNumber: route.garageNumber,
            communicationKind: route.communicationKind,
            transportationKind: route.transportationKind,
          },
          requests: rows.map((row) => ({ requestId: row.requestId, position: row.position })),
          actor: { id: p.id, name: p.fullName },
        });
        await bumpRouteVersion(tx, route.id, p.id);
        return result;
      });

      // Лист уносит из портала персональные данные водителя — выдача учётное событие (ADR 0037).
      await writeAudit({
        actorUserId: p.id,
        action: 'waybill.issue',
        entityType: 'waybill',
        entityId: issued.id,
        metadata: { number: issued.number, routeId: req.params.id },
      });
      return (await loadRouteDto(db, req.params.id))!;
    },
  );
}

/** Тип ТС машины — им сверяется заказанное в заявке при переносе её в чужой рейс. */
async function vehicleTypeOf(
  tx: Parameters<typeof lockRoute>[0],
  vehicleId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ vehicleTypeId: vehicles.vehicleTypeId })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId));
  return row?.vehicleTypeId ?? null;
}
