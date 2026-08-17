import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, desc, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  attachRouteRequestSchema,
  can,
  canCorrectRoute,
  canIssueWaybill,
  canJoinRoute,
  correctRouteSchema,
  createVehicleRouteSchema,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRelocationPurpose,
  isRouteEditable,
  issueRouteWaybillSchema,
  mergePointsSchema,
  moscowDateKeyOf,
  movedRouteDateKey,
  ROUTE_REQUEST_CAPACITY,
  parseVehicleRouteNumberSearch,
  pointOrderSchema,
  pointRoleOrderSchema,
  ROUTE_FROZEN_MESSAGE,
  ROUTE_LEGACY_WAYBILL_MESSAGE,
  routeOrderSchema,
  routePointSchema,
  type RequestStatus,
  routeVersionQuerySchema,
  type RouteTripFields,
  splitPointSchema,
  transferCorrectionSchema,
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
import { requestIsLinearSql } from '../db/linear-mode';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { assertRequestScope } from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { issueWaybillForRoute, routeWaybillFormFor, tripDate } from '../services/waybill-issue';
import {
  assertRoutePlacement,
  createRoutePoint,
  deleteRoutePoint,
  loadRoutePoints,
  mergeRoutePoints,
  placeRequestTrips,
  pointOrderByComposition,
  setPointRoleOrder,
  setRoutePointOrder,
  splitRoutePoint,
  updateRoutePoint,
} from '../services/route-points';
import {
  assertRouteVersion,
  attachRequest,
  bumpRouteVersion,
  detachRequest,
  lastTripFields,
  legacyWaybillOf,
  loadRouteDto,
  loadRouteDtos,
  lockRequestRow,
  lockRoute,
  lockRoutePair,
  moveRouteToDate,
  routeOfRequestDay,
  routeQuery,
  routeRequestCount,
  type RouteRow,
  routeWaybill,
  setRouteOrder,
  vehicleClassOf,
} from '../services/vehicle-routes';
import {
  applyReassignment,
  approvedShiftsOfComposition,
  bumpRequestVersions,
  cancelRouteWaybillForCorrection,
  clearShiftApprovals,
  CORRECTION_EMPTY_MESSAGE,
  correctionVehicle,
  issueCorrectionWaybill,
  loadRouteComposition,
  lockCompositionPair,
  lockRouteComposition,
  markCorrectionWaybill,
  planReassignment,
  planTransfer,
  preflightCorrection,
  routeTripOf,
  TRANSFER_RELOCATION_MESSAGE,
  TRANSFER_SAME_ROUTE_MESSAGE,
} from '../services/vehicle-route-correction';
import {
  backdateAccessOf,
  backdateOrThrow,
  cancelWaybillForCorrection,
  checkBackdate,
  CORRECTION_OPERATION_ID_REQUIRED,
  type CorrectionRecord,
  linkCorrectionRequests,
  runCorrection,
} from '../services/waybill-correction';

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
const pointParams = z.object({ id: z.string().uuid(), pointId: z.string().uuid() });

/**
 * Рейс вместе с его порядком объезда.
 *
 * Точки теперь поле самого `VehicleRouteDto` (§6 плана), поэтому пересечения типов здесь больше
 * нет — оно заводилось, пока контракт о них не знал, и стоило дорого: сервер и портал склеивали
 * точки каждый у себя, а тест, собравший рейс честным DTO, точек не имел вовсе и потому не мог
 * проверить ни одну сборку дня.
 */
async function routeWithPoints(id: string): Promise<VehicleRouteDto> {
  const [dto, points] = await Promise.all([loadRouteDto(db, id), loadRoutePoints(db, id)]);
  if (!dto) throw err.notFound('Маршрут не найден');
  return { ...dto, points };
}

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
 * Машина рейса: собственная и живая. Проверяется при заведении рейса — дальше состав сверяется уже
 * с ней (`canJoinRoute` спрашивает принадлежность назначенной машины заявки).
 *
 * Бланк типа здесь больше не спрашивается (ADR 0065). Он и не отвечал на вопрос этой проверки:
 * заполненная колонка читалась как «этой техникой можно возить грузы», хотя говорит она лишь о
 * том, какую бумагу печатать. Отвечать на «чем закрывают заявку» перестал и вид ТС — он больше
 * не граница замены, — так что рейс идёт за назначением: собственная активная машина, а бланк
 * подберёт `routeWaybillForm` (у перегона — всегда 4-П).
 */
async function assertRouteVehicle(vehicleId: string): Promise<void> {
  const [row] = await db
    .select({
      ownership: vehicles.ownership,
      status: vehicles.status,
      deletedAt: vehicles.deletedAt,
    })
    .from(vehicles)
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
}

/**
 * Ёмкость рейса выражением SQL: сколько заявок он держит — решает бланк (ADR 0068), а бланк
 * закреплён за типом машины рейса. У 4-П строк задания семь, у формы № 3 — десять.
 *
 * Подзапрос самодостаточен и смотрит только на `vehicle_routes`: тем же условием фильтруется и
 * страница списка, и подсчёт всего найденного, а тот идёт без джойнов машины и её типа.
 *
 * `CASE` собирается из самой таблицы ёмкостей: добавится бланк — SQL узнает о нём вместе с
 * контрактами, а не останется с прежними числами, вписанными руками.
 */
const capacityOf = sql`(
  SELECT CASE
    WHEN ${vehicleRoutes.purpose} <> 'freight' THEN ${ROUTE_REQUEST_CAPACITY['4p']}
    ${sql.join(
      Object.entries(ROUTE_REQUEST_CAPACITY).map(
        ([code, capacity]) => sql`WHEN ${vehicleTypes.waybillFormCode} = ${code} THEN ${capacity}`,
      ),
      sql` `,
    )}
    ELSE 0
  END
  FROM ${vehicles}
  JOIN ${vehicleTypes} ON ${vehicleTypes.id} = ${vehicles.vehicleTypeId}
  WHERE ${vehicles.id} = ${vehicleRoutes.vehicleId}
)`;

/**
 * Заявка перегона под блокировкой: её состояние решает, выписывать ли лист, — так же, как у
 * грузового рейса решают статусы состава.
 */
async function lockRequestForIssue(
  tx: Parameters<typeof lockRoute>[0],
  requestId: string,
): Promise<{ displayNumber: string; status: RequestStatus }> {
  const [row] = await tx
    .select({ num: vehicleRequests.num, status: vehicleRequests.status })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId))
    .for('update', { of: vehicleRequests });
  if (!row) throw err.notFound('Заявка перегона не найдена');
  return { displayNumber: formatVehicleRequestNumber(row.num), status: row.status };
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

/**
 * Сегодня по МСК: границы заднего числа — календарные сутки, и UTC сдвинул бы их на три часа.
 * Тем же `moscowDateKeyOf` границу считает портал — двух расчётов одной даты быть не должно.
 */
function today(): string {
  return moscowDateKeyOf(new Date());
}

/** Заморозку проверяют все правки рейса — состав, порядок, шапка. */
async function assertRouteEditable(tx: Parameters<typeof lockRoute>[0], routeId: string) {
  const waybill = await routeWaybill(tx, routeId);
  if (!isRouteEditable(waybill?.status ?? null)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
  return waybill;
}

/**
 * Общее начало всякой правки точек: рейс под `FOR UPDATE`, сверка версии и заморозки.
 *
 * Тремя шагами и в этом порядке (Р15, Р16, Р17). Блокировка первой — иначе версия читалась бы у
 * строки, которую сосед правит прямо сейчас; заморозка последней — она спрашивает лист рейса, а
 * тот меняется только под этой же блокировкой.
 */
async function lockEditableRoute(
  tx: Parameters<typeof lockRoute>[0],
  routeId: string,
  version: number,
): Promise<RouteRow> {
  const route = await lockRoute(tx, routeId);
  assertRouteVersion(route, version);
  await assertRouteEditable(tx, route.id);
  return route;
}

/** Бланк рейса: им считается ёмкость задания строками (Р11) и раскладка каждой строки. */
async function routeFormCode(tx: Parameters<typeof lockRoute>[0], route: RouteRow) {
  return (await routeWaybillFormFor(tx, { purpose: route.purpose, vehicleId: route.vehicleId }))
    .formCode;
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
      vehicleTypeName: vehicleTypes.name,
      // Вид заказанного типа — граница замены (ADR 0059): её и сверяет укладка в чужой рейс.
      kindId: vehicleTypes.kindId,
      // Линейный ли заказанный тип (ADR 0100 §1): такой заказ в рейс тоже ходит, но днём и только
      // из карточки заявки — отсюда правило и берёт слова для отказа этой двери. Режим заявки, а
      // не признак справочника: заявку могло застать переключение (миграция 0137).
      isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear),
      assignedVehicleId: vehicleRequestAssignments.vehicleId,
      ownership: vehicles.ownership,
    })
    .from(vehicleRequests)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
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

  /**
   * Коррекция задним числом — сверх обычных прав ещё одно (Р4, ADR 0101 п. 7).
   *
   * Спрашивается оно и на чтении последствий: окно коррекции показывает цену операции, и открывать
   * его тому, кто операцию выполнить не может, значит обещать несуществующую кнопку.
   *
   * Глубину (`waybills.correctBeyondLimit`, Р37) guard не решает: она зависит от даты рейса, и
   * ответ на неё даёт `backdateGuard` в обработчике — с кодом отказа, по которому портал отличает
   * «нет права» от «слишком давно».
   */
  const correctionGuards = [
    ...guards,
    app.requirePermission('waybills.correct', 'Недостаточно прав для коррекции задним числом'),
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
          q.hasFreeSlots ? sql`(${used}) < ${capacityOf}` : sql`(${used}) >= ${capacityOf}`,
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
        // Счётчик идёт теми же join'ами, что и выборка: поиск рейса смотрит на госномер машины и
        // фамилию водителя, и без этих таблиц условие ссылалось бы на то, чего в запросе нет —
        // Postgres отвечает «missing FROM-clause entry», то есть поиск ронял бы весь список.
        db
          .select({ c: count() })
          .from(vehicleRoutes)
          .innerJoin(vehicles, eq(vehicles.id, vehicleRoutes.vehicleId))
          .leftJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
          .where(where),
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

  /** Карточка рейса: состав, лист и **порядок объезда** — точки с их ролями (§7 плана точек). */
  r.get('/:id', { preHandler: guards, schema: { params: idParams } }, async (req) =>
    routeWithPoints(req.params.id),
  );

  /**
   * Завести рейс. Дата в прошлом — под правом и с причиной (ADR 0101 п. 4, дыра 1 плана).
   *
   * До ADR 0101 здесь не спрашивалось ничего: вчерашний рейс заводился молча, а следом так же молча
   * выписывался лист. Дверь закрывается тем же единым предикатом, что и все прочие входы заднего
   * числа (`backdateGuard`), а эффективная дата берётся по таблице §4 плана — `routeDate`.
   *
   * Записи операции (`waybill_corrections`) здесь нет намеренно, и это не пропуск. Строка операции
   * заводится там, где рождается или списывается **документ**: она объясняет разрыв нумерации
   * бланков и ссылается на листы своими колонками. Рейс — планировочная запись, номера строгой
   * отчётности он не расходует, и пустая операция без единого листа засоряла бы журнал коррекций
   * тем, что в нём не ищут. Объяснение остаётся в аудите заведения, а причина у бумаги появится
   * своя — её спросит выписка листа, которая эту операцию и заведёт.
   *
   * Машина по-прежнему собственная и **активная** (`assertRouteVehicle`, Р17): послабление
   * «в любом статусе, кроме удалённой» дано коррекции, а не заведению — там речь о рейсе, который
   * ещё соберут, и ставить в план списанную технику незачем.
   */
  r.post(
    '/',
    { preHandler: guards, schema: { body: createVehicleRouteSchema } },
    async (req, reply): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      const reason = body.reason ?? '';
      const backdated = backdateOrThrow(
        checkBackdate({
          effectiveDate: body.routeDate,
          today: today(),
          subject: p,
          hasReason: reason !== '',
        }),
      );
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
        // Признак заднего числа и причина — здесь же: своей строки в журнале коррекций у рейса нет
        // (см. заголовок ручки), и объяснение «почему рейс заведён вчерашним днём» живёт в ленте
        // аудита рядом с самим заведением.
        metadata: {
          number: formatVehicleRouteNumber(created!.num),
          vehicleId: body.vehicleId,
          routeDate: body.routeDate,
          backdated,
          reason,
        },
      });
      reply.code(201);
      return routeWithPoints(created!.id);
    },
  );

  /**
   * Дата рейса, водитель, реквизиты и комментарий. Состав правится своими ручками — он про заявки.
   *
   * Дата переносит рейс вместе с его заявками (`moveRouteToDate`): день рейса и день подачи —
   * одно и то же событие с двух сторон, и разъехаться им нельзя. У перегона переносить нечего:
   * состава у него нет, а срок работ заявки задаёт не он.
   *
   * Задний ход спрашивается **только за дату** (ADR 0101 п. 4 и 6, Р29). Правка водителя,
   * реквизитов и комментария прошлого рейса права не требует: действующий лист правку запрещает
   * целиком (`assertRouteEditable`), а без листа рейс — планировочная запись, которая о прошедшем
   * дне ничего не утверждает; требовать за неё `waybills.correct` значило бы запирать подготовку к
   * самой коррекции. Сдвиг `routeDate` — другое дело: `moveRouteToDate` переписывает `scheduledAt`
   * **всех** грузовых заявок состава, то есть двигает календарь заказчика ровно так же, как
   * защищённый `PATCH /vehicle-requests/:id`, — и без guard'а эта ручка была бы обходом того.
   *
   * Эффективная дата — более ранняя из старой и новой (`movedRouteDateKey`): перенос снимает работу
   * с одного дня и ставит на другой, утверждая о каждом из них.
   *
   * Записи в `waybill_corrections` здесь нет по той же причине, что у заведения рейса: номеров
   * строгой отчётности перенос не расходует (действующий лист его и не пустит), а операция без
   * единого листа засоряла бы журнал коррекций тем, чего в нём не ищут. Право и причина
   * спрашиваются, объяснение уходит в аудит.
   */
  r.patch(
    '/:id',
    { preHandler: guards, schema: { params: idParams, body: updateVehicleRouteSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      const reason = body.reason?.trim() ?? '';
      if (body.driverPersonId) await assertDriver(body.driverPersonId);

      let moved: string[] = [];
      let movedTo: string | null = null;
      let backdated = false;
      await db.transaction(async (tx) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, body.version);
        await assertRouteEditable(tx, route.id);

        // Guard стоит под блокировкой рейса и до первой записи: прежнюю дату решает та строка,
        // которую мы и правим, а прочитанная вне транзакции она успела бы уехать соседней вкладкой
        // — и «более ранняя из двух» посчиталась бы не от того дня. Отсюда же берётся и сам факт
        // переноса: «что двигаем» и «за что спрашиваем право» обязаны решаться одним выражением.
        const movingTo =
          body.routeDate && body.routeDate !== route.routeDate ? body.routeDate : null;
        const effectiveDate = movedRouteDateKey(route.routeDate, movingTo);
        backdated =
          effectiveDate !== null &&
          backdateOrThrow(
            checkBackdate({
              effectiveDate,
              today: today(),
              subject: p,
              hasReason: reason !== '',
            }),
          );

        // «Откуда — куда» есть только у перегона: у грузового рейса задание собирается из заявок,
        // и записанное сюда место в бланк не попало бы никуда.
        if (
          (body.moveFrom !== undefined || body.moveTo !== undefined) &&
          route.purpose === 'freight'
        ) {
          throw err.unprocessable('Задание «откуда — куда» бывает только у перегона техники', {
            moveFrom: 'Не тот вид рейса',
          });
        }

        const values = {
          ...(body.driverPersonId !== undefined
            ? { driverPersonId: body.driverPersonId }
            : undefined),
          ...(body.trip ? tripValues(body.trip) : undefined),
          ...(body.comment !== undefined ? { comment: body.comment } : undefined),
          ...(body.moveFrom !== undefined ? { moveFrom: body.moveFrom } : undefined),
          ...(body.moveTo !== undefined ? { moveTo: body.moveTo } : undefined),
        };
        // Пустой запрос правки — законное тело: перенос рейса на другую дату присылает одну дату,
        // и графы шапки при этом не трогает. `UPDATE` без единого значения драйвер не собирает
        // вовсе («No values to set»), и до появления переноса такого тела просто не приходило.
        if (Object.keys(values).length > 0) {
          await tx.update(vehicleRoutes).set(values).where(eq(vehicleRoutes.id, route.id));
        }

        if (movingTo) {
          moved = await moveRouteToDate(tx, route.id, movingTo);
          movedTo = movingTo;
        }
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.update',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        // Переехавшие заявки называются поимённо: перенос рейса меняет и их подачу, а по одной
        // дате в записи потом не понять, что именно уехало вместе с рейсом.
        //
        // Признак заднего числа и причина — здесь же: своей строки в журнале коррекций у переноса
        // нет (см. заголовок ручки), и «почему рейс уехал во вчера» объясняет лента аудита рядом с
        // самой правкой.
        metadata: {
          driverPersonId: body.driverPersonId ?? null,
          ...(movedTo ? { routeDate: movedTo, movedRequests: moved } : {}),
          ...(backdated ? { backdated, reason } : {}),
        },
      });
      return routeWithPoints(req.params.id);
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
   * исходном уплотняются позиции. Поэтому блокируются оба (в порядке `id`), связь читается уже под
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

        // После блокировок: до них заявка могла уехать в третий рейс.
        // Где заявка лежит на самом деле — её единственная строка без дня: линейные дни этой
        // дверью не ходят вовсе (ADR 0100 §8), и спрашивать их здесь незачем.
        const current = await routeOfRequestDay(tx, body.requestId, null);
        if (current && current.routeId !== target.id) {
          if (!body.source || body.source.routeId !== current.routeId) {
            throw err.conflict(
              `Заявка ${formatVehicleRequestNumber(request.num)} лежит в другом маршруте — обновите список`,
            );
          }
        }
        if (current?.routeId === target.id) return; // уже здесь: перевод в работу идемпотентен

        // Бланк рейса: им заданы и потолок состава, и ёмкость задания строками (Р11).
        const { formCode } = await routeWaybillFormFor(tx, {
          purpose: target.purpose,
          vehicleId: target.vehicleId,
        });
        const check = canJoinRoute(
          {
            requestType: request.requestType,
            isLinear: request.isLinear,
            status: request.status,
            deletedAt: request.deletedAt?.toISOString() ?? null,
            // Со стороны рейса заявка приходит целиком, одним днём подачи. Линейный заказ такого
            // дня не несёт, и правило откажет ему словами (`LINEAR_DAY_DOOR_MESSAGE`): дверь у
            // дня одна — карточка заявки, где известно, какой именно день срока кладут.
            day: { kind: 'trip', date: await tripDate(tx, request.id) },
            ownership: request.ownership ?? null,
          },
          {
            routeDate: target.routeDate,
            requestCount: await routeRequestCount(tx, target.id),
            purpose: target.purpose,
            // Ёмкость рейса задаёт его бланк: у 4-П семь строк задания, у формы № 3 десять
            // (ADR 0068).
            formCode,
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
        /*
         * Ездки раскладываются точками сразу (Р8): «взял в работу» обязано быть законченным
         * действием, иначе диспетчер получал бы рейс, в котором заявка есть, а ехать по нему
         * некуда. Автосборка садится на уже стоящие точки того же тождества — в том числе
         * собранные прежними заявками, — и заводит новые только в конец.
         *
         * Дальше — то, чего база не держит: ёмкость бланка **строками задания** (Р11: ездки плюс
         * линейные дни, а не строки состава) и порядок «погрузка раньше разгрузки» (Р6). Заявка с
         * тремя ездками занимает три строки бланка, и `canJoinRoute` выше, считающий строки
         * состава, этого не заметил бы.
         */
        await placeRequestTrips(tx, target.id, request.id);
        await assertRoutePlacement(tx, { routeId: target.id, formCode });

        // Рейс — источник истины о том, чем едут: заявка, переехавшая на другую машину, меняет
        // назначение вместе с рейсом. Ставки не трогаются — о них договариваются по заявке.
        if (request.assignedVehicleId !== target.vehicleId) {
          const routeVehicle = await vehicleClassOf(tx, target.vehicleId);
          if (!routeVehicle) throw err.unprocessable('У маршрута не найдена машина');
          // Сверяется вид, а не тип (ADR 0059): заявку закрывают и машиной крупнее заказанной, и
          // именно это правило пускает в один рейс заявки разных объектов, заказанные разным.
          // Расхождение типа портал показывает пометкой — здесь оно ничего не блокирует.
          if (request.kindId !== routeVehicle.kindId) {
            throw err.unprocessable(
              `Заявка заказана на «${request.vehicleTypeName}», а маршрут едет «${routeVehicle.typeName}» — это другой вид техники`,
              { requestId: 'Другой вид ТС' },
            );
          }
          await tx
            .update(vehicleRequestAssignments)
            .set({
              vehicleId: target.vehicleId,
              // Тип машины рейса, а не заказанный: назначение отвечает на «чем едут».
              vehicleTypeId: routeVehicle.vehicleTypeId,
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
      return routeWithPoints(req.params.id);
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
      const removed = await db.transaction(async (tx) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, req.query.version);
        await assertRouteEditable(tx, route.id);
        // Заявка — под `FOR UPDATE` и после рейса (Р17): её строкой заперт состав, и укладка той же
        // заявки в соседний рейс не должна вклиниться между проверкой и снятием. Тем же порядком и
        // той же строкой её берёт укладка (`loadRequestForRoute`).
        await lockRequestRow(tx, req.params.requestId);
        const row = await detachRequest(tx, route.id, req.params.requestId);
        if (!row) throw err.notFound('Заявки нет в этом маршруте');
        await bumpRouteVersion(tx, route.id, p.id);
        return row;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.detach',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        // День снятой строки — часть события: линейный день и грузовая заявка выбывают из состава
        // одинаково, а означают разное (ADR 0100 §2).
        metadata: { requestId: req.params.requestId, workDate: removed.workDate },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /** Новый порядок строк задания — полным составом: сервер переписывает его целиком. */
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
        /*
         * Порядок переписывается в двух местах, и это не дублирование. Состав задаёт талоны
         * заказчиков (`slot`, Р20), а печать задания идёт по позициям **точек** (Р11): переставив
         * только состав, дверь показала бы человеку новый порядок и напечатала бы старый.
         *
         * Точки выводятся из состава, пока каждая принадлежит одной заявке. Общая остановка двух
         * заявок (Р8) такого ответа не имеет — тогда отказ словами и указание на дверь порядка
         * объезда, где вопрос задаётся точками. Догадка здесь означала бы, что машина поедет не
         * тем порядком, о котором просили, и никто этого не заметит.
         */
        const pointOrder = await pointOrderByComposition(tx, route.id, body.requestIds);
        if (!pointOrder) {
          throw err.unprocessable(
            'В маршруте есть остановка, общая для нескольких заявок, — порядок объезда у неё один на всех. Переставьте точки в порядке объезда.',
            { requestIds: 'Порядок задаётся точками' },
          );
        }
        await setRouteOrder(tx, route.id, body.requestIds);
        await setRoutePointOrder(tx, route.id, pointOrder);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: (
            await routeWaybillFormFor(tx, { purpose: route.purpose, vehicleId: route.vehicleId })
          ).formCode,
        });
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.reorder',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { order: body.requestIds },
      });
      return routeWithPoints(req.params.id);
    },
  );

  // ── Точки: порядок объезда (план `docs/route-trips-plan.md` §7) ──
  //
  // Права те же, что у всего модуля (Р19): своих у точек нет — это тот же рейс, только собранный
  // остановками, а не заявками. Каждая дверь идёт одним порядком: блокировка рейса, версия,
  // заморозка (`lockEditableRoute`) → правка → проверки, которых не держит база (Р6 и ёмкость
  // бланка строками задания, `assertRoutePlacement`) → версия рейса вверх.
  //
  // Проверки **после** правки, а не до: порядок объезда собирают перестановками, и состояние
  // «разгрузка выше погрузки» законно ровно до конца транзакции — отказ до правки запретил бы
  // половину законных сборок.

  /**
   * Завести точку: адрес, время прибытия, комментарий и роли (минимум одна, Р13).
   *
   * Роль, названная здесь, но лежащая на другой точке, переезжает сюда: «завести остановку и
   * положить на неё погрузку» — обычный способ развести две ездки по разным заездам, и требовать
   * ради этого разнесения значило бы заставлять человека делать два действия вместо одного.
   */
  r.post(
    '/:id/points',
    { preHandler: guards, schema: { params: idParams, body: routePointSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      const pointId = await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, body.version);
        const created = await createRoutePoint(tx, route.id, body);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
        return created;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_create',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { pointId, location: body.location, roles: body.roles },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /** Править точку: адрес, время, комментарий и состав ролей **целиком** (§7). */
  r.patch(
    '/:id/points/:pointId',
    { preHandler: guards, schema: { params: pointParams, body: routePointSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, body.version);
        await updateRoutePoint(tx, route.id, req.params.pointId, body);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_update',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { pointId: req.params.pointId, location: body.location, roles: body.roles },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Убрать точку вместе с её ролями; позиции уплотняются (Р13).
   *
   * Отказ ровно один: роль, которая у своей строки задания последняя, — тогда строка исчезла бы из
   * маршрута молча, а исчезнуть она вправе только вместе с заявкой или днём, у которых свои двери
   * и свои проверки.
   */
  r.delete(
    '/:id/points/:pointId',
    { preHandler: guards, schema: { params: pointParams, querystring: routeVersionQuerySchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);

      await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, req.query.version);
        await deleteRoutePoint(tx, route.id, req.params.pointId);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_delete',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { pointId: req.params.pointId },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Новый порядок объезда — полным списком точек (Р14): сервер переписывает позиции целиком, и две
   * одновременные перестановки не соберут дыр в нумерации.
   *
   * Нарушенный порядок ездки — 422 с её номером (Р6): между погрузкой и разгрузкой груз в кузове, и
   * бумага, обещающая обратное, отправила бы машину за грузом, который она уже везёт.
   */
  r.put(
    '/:id/points/order',
    { preHandler: guards, schema: { params: idParams, body: pointOrderSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, body.version);
        await setRoutePointOrder(tx, route.id, body.pointIds);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_reorder',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { order: body.pointIds },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Новый порядок работ **внутри одной точки** — полным списком её ролей.
   *
   * Дверь заведена сверх §7 плана, и вот зачем. Порядок строк задания — это порядок отрывных
   * талонов заказчиков (Р12, Р20, ADR 0068 п. 2), и задаёт его порядок объезда. Но две строки,
   * стоящие на **одной и той же** паре точек, объезд не различает — автосборка переиспользует точку
   * (Р8), — и до сих пор их разводил номер заявки, то есть порядок заведения записей. Здесь тот же
   * вопрос возвращается человеку в виде, который имеет физический смысл: какую из ездок на этой
   * остановке грузят первой.
   *
   * Проверок Р6 и ёмкости после неё не нужно — но они и здесь: перестановка ролей внутри точки не
   * трогает ни порядка объезда, ни состава, а `assertRoutePlacement` заодно возвращает свежие точки
   * тем же путём, каким их проверяют остальные двери. Дешевле одного лишнего чтения то, что у всех
   * дверей точек порядок действий один.
   */
  r.put(
    '/:id/points/:pointId/roles/order',
    { preHandler: guards, schema: { params: pointParams, body: pointRoleOrderSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, body.version);
        await setPointRoleOrder(tx, route.id, req.params.pointId, body.roles);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_roles_reorder',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { pointId: req.params.pointId, roles: body.roles },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Совместить точки одного адреса в одну остановку (Р9а): роли переезжают в первую по позиции.
   *
   * Разные ответственные совмещению не помеха — точка выйдет с обоими, и бланк напечатает обоих
   * (Р11а): машина действительно приезжает в одно место, а встречают её двое. Разный адрес —
   * помеха: в два места сразу машина приехать не может.
   */
  r.post(
    '/:id/points/merge',
    { preHandler: guards, schema: { params: idParams, body: mergePointsSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      const targetId = await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, body.version);
        const merged = await mergeRoutePoints(tx, route.id, body.pointIds);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
        return merged;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_merge',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { pointIds: body.pointIds, targetId },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /** Разнести точку надвое (Р9а): названные роли уходят в новую точку сразу за исходной. */
  r.post(
    '/:id/points/:pointId/split',
    { preHandler: guards, schema: { params: pointParams, body: splitPointSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      const created = await db.transaction(async (tx) => {
        const route = await lockEditableRoute(tx, req.params.id, body.version);
        const pointId = await splitRoutePoint(tx, route.id, req.params.pointId, body.roles);
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: await routeFormCode(tx, route),
        });
        await bumpRouteVersion(tx, route.id, p.id);
        return pointId;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.point_split',
        entityType: 'vehicle_route',
        entityId: req.params.id,
        metadata: { pointId: req.params.pointId, createdPointId: created, roles: body.roles },
      });
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Выписать лист по рейсу.
   *
   * Статусы заявок перечитываются под блокировкой их строк: состав лежит в одной таблице, а
   * статусы — в другой, и без этого соседний запрос успел бы закрыть заявку между проверкой и
   * вставкой листа — бланк родился бы на закрытую.
   *
   * Пустой бланк (рейс без заявок) спрашивает своё право — `waybills.issueBlank`, ADR 0071.
   * Отдельным guard'ом его не закрыть: ручка одна на обе выписки, а право решает не «пускать ли
   * сюда», а «считать ли пустое задание ошибкой».
   *
   * **Прошедший день** (ADR 0101 п. 4, дыра 1 плана). Раньше эта ручка про дату не спрашивала
   * вовсе: границы на заведении рейса дыру не закрывают, потому что вчерашний рейс уже существует —
   * и лист на него выписывался молча, без права, объяснения и метки. Теперь дату спрашивает тот же
   * `backdateGuard`, что и все прочие входы, а сама выписка становится операцией `issue` (Р31):
   * причина уходит в `correction_reason` **при пустом** `corrects_waybill_id` (Р35) — заменять было
   * нечего, лист рождён не взамен другого, — а ключ идемпотентности спасает от второго сгоревшего
   * номера после обрыва связи.
   *
   * Отдельной ручки под это нет намеренно: действие одно и то же — «выписать лист по рейсу», — и
   * второй маршрут с той же семантикой разошёлся бы с первым в мелочах (проверки состава, аудит,
   * ответ). Различает их календарь, и различает его предикат.
   */
  r.post(
    '/:id/waybill',
    { preHandler: guards, schema: { params: idParams, body: issueRouteWaybillSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const blankAllowed = can(p, 'waybills.issueBlank');
      const reason = req.body.reason ?? '';

      const [known] = await db
        .select({ routeDate: vehicleRoutes.routeDate })
        .from(vehicleRoutes)
        .where(eq(vehicleRoutes.id, req.params.id));
      if (!known) throw err.notFound('Маршрут не найден');

      /*
       * Доступ считается функцией, а не разово: на повторе операции (Р31) это единственная
       * проверка, которая вообще случится, и `runCorrection` зовёт её сам. Здесь же она нужна
       * первый раз — вердикт решает, обычная это дневная выписка или коррекция.
       */
      const authorize = () =>
        backdateOrThrow(
          checkBackdate({
            // Эффективная дата — день рейса (таблица §4 плана): лист выписывается на него, а не на
            // день нажатия кнопки.
            effectiveDate: known.routeDate,
            today: today(),
            subject: p,
            hasReason: reason !== '',
          }),
        );
      const backdated = authorize();

      /**
       * Сама выписка. Одна на обе ветки: коррекционная отличается от дневной ровно меткой листа —
       * второй набор шагов разошёлся бы с первым уже на следующей правке правил выписки.
       */
      const issueInTransaction = async (
        tx: Parameters<typeof lockRoute>[0],
        correction: CorrectionRecord | null,
      ) => {
        const route = await lockRoute(tx, req.params.id);
        assertRouteVersion(route, req.body.version);
        /*
         * Дата перечитывается под блокировкой: между первым чтением и `FOR UPDATE` рейс успевают
         * перенести на другой день (`moveRouteToDate`), а от даты зависит, коррекция это или
         * обычная выписка. Вердикт, посчитанный по устаревшей дате, завёл бы лист прошедшего дня
         * без операции — или, наоборот, операцию там, где её не нужно.
         */
        const locked = backdateOrThrow(
          checkBackdate({
            effectiveDate: route.routeDate,
            today: today(),
            subject: p,
            hasReason: reason !== '',
          }),
        );
        if (locked !== backdated) {
          throw err.conflict(
            'Рейс переехал на другой день, пока выписывался лист — откройте карточку заново',
          );
        }
        const waybill = await routeWaybill(tx, route.id);

        /*
         * Порядок захвата — по `id` заявки, а не по позиции талона, и сортируется состав уже в
         * памяти. Позиция важна для бумаги, но для блокировок она чужая: тем же строкам
         * `vehicle_requests` берёт `FOR UPDATE` аннулирование листа, и берёт их по возрастанию
         * `id` (`waybill-locks.ts`). Два порядка на одних строках — это клинч на первом же рейсе,
         * где номера талонов идут не в порядке идентификаторов.
         *
         * `LockRows` в плане Postgres стоит над `Sort`, поэтому строки блокируются именно в
         * порядке `ORDER BY`, а не в порядке чтения таблицы.
         */
        const lockedComposition = await tx
          .select({
            requestId: vehicleRouteRequests.requestId,
            position: vehicleRouteRequests.position,
            num: vehicleRequests.num,
            status: vehicleRequests.status,
          })
          .from(vehicleRouteRequests)
          .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRouteRequests.requestId))
          .where(eq(vehicleRouteRequests.routeId, route.id))
          .orderBy(asc(vehicleRequests.id))
          .for('update', { of: vehicleRequests });
        const rows = [...lockedComposition].sort((a, b) => a.position - b.position);

        // Заявка-основание перегона: у него состава нет, и её состояние решает вместо талонов.
        // Строка блокируется тем же `FOR UPDATE`, что и состав грузового рейса, — иначе соседний
        // запрос успел бы отменить заявку между проверкой и вставкой листа.
        const source = route.sourceRequestId
          ? await lockRequestForIssue(tx, route.sourceRequestId)
          : null;

        const check = canIssueWaybill({
          purpose: route.purpose,
          driverPersonId: route.driverPersonId,
          blankAllowed,
          // Бланк рейса: им проверяется, что состав в него влезает — его строки задания и
          // печатают заявки (ADR 0068).
          formCode: (
            await routeWaybillFormFor(tx, { purpose: route.purpose, vehicleId: route.vehicleId })
          ).formCode,
          requests: rows.map((row) => ({
            displayNumber: formatVehicleRequestNumber(row.num),
            status: row.status,
          })),
          sourceRequest: source,
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
          routeNumber: formatVehicleRouteNumber(route.num),
          purpose: route.purpose,
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
          relocation: route.sourceRequestId
            ? { requestId: route.sourceRequestId, from: route.moveFrom, to: route.moveTo }
            : null,
          // Рукопожатие (Р21) — насквозь, обеими ветками: дневная выписка и задняя подтверждают
          // одну и ту же бумагу, и своего поля у второй нет.
          acknowledge: req.body.acknowledge ?? null,
          actor: { id: p.id },
        });
        /*
         * Метка коррекции (Р35): лист, рождённый задним числом, объяснён причиной при **пустой**
         * ссылке на заменяемый номер — заменять было нечего. Признак коррекции для фильтра журнала
         * (Р28) считается по ссылке на операцию, а не по `corrects_waybill_id`, — иначе такой лист
         * в фильтр не попал бы вовсе.
         */
        if (correction) {
          await markCorrectionWaybill(tx, {
            waybillId: result.id,
            correctionId: correction.id,
            reason,
            correctsWaybillId: null,
          });
        }
        await bumpRouteVersion(tx, route.id, p.id);
        return { ...result, blank: rows.length === 0 && !route.sourceRequestId };
      };

      /** Что выписано; на повторе операции (Р31) остаётся `null` — выписывать было нечего. */
      let issued: Awaited<ReturnType<typeof issueInTransaction>> | null = null;
      let correctionId: string | null = null;

      if (!backdated) {
        issued = await db.transaction((tx) => issueInTransaction(tx, null));
      } else {
        // Ключ идемпотентности обязателен ровно здесь: сегодняшняя выписка операцией не является и
        // повтора не боится, а выписка задним числом заводит строку в журнале коррекций и жжёт
        // номер серии — повтор после обрыва связи обязан вернуть прежний лист, а не следующий.
        if (!req.body.operationId) {
          throw err.unprocessable(CORRECTION_OPERATION_ID_REQUIRED, {
            operationId: 'Не передан ключ операции',
          });
        }
        const outcome = await runCorrection(
          {
            operationId: req.body.operationId,
            kind: 'issue',
            target: req.params.id,
            body: req.body,
            reason,
            actorUserId: p.id,
          },
          {
            authorize,
            perform: async (tx, correction) => {
              issued = await issueInTransaction(tx, correction);
              /*
               * Снимок «было → стало» (Р16). Состояние листа сюда не кладётся — он никуда не делся
               * и читается из журнала по ссылке на операцию; здесь то, что объясняет саму операцию:
               * какой день выписан задним числом и каким номером это кончилось.
               */
              return {
                route: { id: req.params.id, routeDate: known.routeDate },
                waybill: { id: issued.id, number: issued.number, blank: issued.blank },
              };
            },
          },
        );
        correctionId = outcome.correction.id;
      }

      // Лист уносит из портала персональные данные водителя — выдача учётное событие (ADR 0037).
      // Пустой бланк помечается отдельно (ADR 0071): номер строгой отчётности ушёл на лист, за
      // задание в котором портал не отвечает, и в журнале это обязано быть отличимо.
      //
      // На повторе операции записи нет: второй строки об одной и той же выдаче в ленте быть не
      // должно — номер выдан один раз.
      if (issued) {
        await writeAudit({
          actorUserId: p.id,
          action: 'waybill.issue',
          entityType: 'waybill',
          entityId: issued.id,
          metadata: {
            number: issued.number,
            routeId: req.params.id,
            blank: issued.blank,
            backdated,
            reason,
            correctionId,
          },
        });
      }
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Что будет, если рейс исправить, — до нажатия, а не после (Р36, Р18).
   *
   * Читающая половина коррекции: те же правила теми же функциями, но без единой правки. Окно
   * показывает ими цену операции — какой номер сгорит, сколько заявок сменят машину, под какими
   * днями снимутся подписи объекта — и её блокировки, если состав к коррекции не готов (Р3, Р13).
   *
   * Отметки печати и выгрузки (Р18) и подшитые к листу файлы (Р34) сюда не собираются: они уже
   * есть у карточки листа (`GET /waybills/:id`), и второй расчёт того же самого разошёлся бы с
   * журналом. Портал берёт их оттуда — номер листа он знает из рейса.
   */
  r.get(
    '/:id/correction',
    { preHandler: correctionGuards, schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const route = await loadRouteDto(db, req.params.id);
      if (!route) throw err.notFound('Маршрут не найден');

      const composition = await loadRouteComposition(db, req.params.id);
      const check = canCorrectRoute(
        { routeDate: route.routeDate, requests: composition },
        today(),
        {
          unlimited: backdateAccessOf(p).beyondLimit,
        },
      );

      return {
        routeDate: route.routeDate,
        today: today(),
        blocking: check.ok ? null : { reason: check.reason, requests: check.blocking },
        // Действующий лист: его номер сгорит. Аннулированный не называется — заменять в нём нечего,
        // и коррекция такого рейса просто выпишет новый номер (Р35).
        waybill: route.waybill && route.waybill.status !== 'cancelled' ? route.waybill : null,
        requests: composition.map((row) => ({
          requestId: row.requestId,
          displayNumber: row.displayNumber,
          position: row.position,
          // День линейного заказа: его назначение коррекция не трогает (ADR 0100 п. 4), и окно
          // обязано сказать об этом — иначе «сменят машину» прочтётся и про него.
          workDate: row.workDate,
          status: row.status,
          assignedVehicleId: row.assignedVehicleId,
        })),
        shifts: await approvedShiftsOfComposition(db, composition),
      };
    },
  );

  /**
   * Исправить исполнение рейса (ADR 0101 п. 2, Р2): одно событие, а не пять.
   *
   * Одна транзакция: блокировки в стабильном порядке (рейс, затем заявки по возрастанию `id`) →
   * граница заднего числа (Р29) → готовность состава (Р3, Р13) → **проверки будущего состояния до
   * первого аннулирования** (Р36) → аннулирование действующего листа → машина, водитель и
   * реквизиты рейса → назначения состава → снятие подписей смен (Р5) → новый лист с меткой
   * коррекции (Р35) → версии заявок (Р24) → связь операции с заявками (Р16).
   *
   * Машина принимается только здесь: обычная правка рейса её по-прежнему не берёт (ADR 0082 п. 5).
   * «Поедет другой машиной» в будущем — это другое назначение, а в прошедшем дне рейс состоялся
   * один, и ехала им одна машина — просто не та, что записана.
   *
   * Состав коррекцией не меняется: приход и уход заявки — перенос между рейсами со своей командой,
   * своими блокировками и версией второго рейса (Р30). `requestOrder` двигает только талоны внутри
   * рейса.
   *
   * Идемпотентность, запись операции и перевод вердикта в HTTP-отказ — общие для всех входов
   * заднего числа и живут в `waybill-correction.ts` (Р31, Р16).
   */
  r.post(
    '/:id/correction',
    { preHandler: correctionGuards, schema: { params: idParams, body: correctRouteSchema } },
    async (req): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      const access = backdateAccessOf(p);
      const blankAllowed = can(p, 'waybills.issueBlank');

      const [known] = await db
        .select({ routeDate: vehicleRoutes.routeDate })
        .from(vehicleRoutes)
        .where(eq(vehicleRoutes.id, req.params.id));
      if (!known) throw err.notFound('Маршрут не найден');

      /*
       * Доступ считается функцией, а не разово: на повторе операции (Р31) это единственная
       * проверка, которая вообще случится, и `runCorrection` зовёт её сам. Причина у коррекции
       * обязательна по схеме, поэтому `hasReason` здесь всегда истинно — вердикт решает вопросы
       * права и глубины (Р37).
       */
      const authorize = () =>
        backdateOrThrow(
          checkBackdate({
            // Эффективная дата операции — день рейса (таблица §4 плана). Ошибка здесь сдвинула бы
            // границу всей коррекции.
            effectiveDate: known.routeDate,
            today: today(),
            subject: p,
            hasReason: true,
          }),
        );

      /**
       * Номера обоих листов операции — для журнала аудита. Полем объекта, а не переменной: значение
       * появляется внутри `perform`, и вывод типов у переменной, присвоенной из замыкания, остался
       * бы на её начальном `null`.
       */
      const trace: { cancelled: string | null; issued: string | null } = {
        cancelled: null,
        issued: null,
      };

      const outcome = await runCorrection(
        {
          operationId: body.operationId,
          kind: 'route',
          target: req.params.id,
          body,
          reason: body.reason,
          actorUserId: p.id,
        },
        {
          authorize,
          perform: async (tx, correction) => {
            const route = await lockRoute(tx, req.params.id);
            assertRouteVersion(route, body.version);
            /*
             * Дата перечитывается под блокировкой: между чтением строки и `FOR UPDATE` рейс успевают
             * перенести на другой день (`moveRouteToDate`), а от даты зависит и право, и глубина.
             * Вердикт, посчитанный по устаревшей дате, разрешил бы правку, которой сам бы и отказал.
             */
            backdateOrThrow(
              checkBackdate({
                effectiveDate: route.routeDate,
                today: today(),
                subject: p,
                hasReason: true,
              }),
            );

            const composition = await lockRouteComposition(tx, route.id);
            const ready = canCorrectRoute(
              { routeDate: route.routeDate, requests: composition },
              today(),
              { unlimited: access.beyondLimit },
            );
            if (!ready.ok) {
              throw err.unprocessable(
                ready.blocking.length > 0
                  ? `${ready.reason} Заявки: ${ready.blocking.join(', ')}`
                  : ready.reason,
              );
            }

            // ── Будущее состояние рейса ──
            const vehicleId = body.vehicleId ?? route.vehicleId;
            const driverPersonId = body.driverPersonId ?? route.driverPersonId;
            const trip = body.trip ? tripValues(body.trip) : routeTripOf(route);
            const currentOrder = composition.map((row) => row.requestId);
            const order = body.requestOrder ?? currentOrder;
            if (body.requestOrder) {
              const current = new Set(currentOrder);
              if (
                current.size !== body.requestOrder.length ||
                body.requestOrder.some((id) => !current.has(id))
              ) {
                throw err.unprocessable(
                  'Порядок присылается полным составом маршрута — обновите его и попробуйте снова',
                );
              }
            }

            /*
             * Пустая коррекция (Р31): тело, повторяющее нынешнее состояние рейса, сожгло бы номер,
             * ничего не исправив. Схема ловит только заведомо пустое — «те же значения» видно лишь
             * здесь, под блокировкой.
             */
            const was = routeTripOf(route);
            const changes =
              vehicleId !== route.vehicleId ||
              driverPersonId !== route.driverPersonId ||
              (Object.keys(trip) as (keyof typeof trip)[]).some((key) => trip[key] !== was[key]) ||
              order.some((id, index) => id !== currentOrder[index]);
            if (!changes) throw err.unprocessable(CORRECTION_EMPTY_MESSAGE);

            // Машина в любом статусе, кроме удалённой и арендной (Р17): истории статусов у техники
            // нет, а правят задним числом как раз ту единицу, которую с тех пор списали.
            const vehicle = await correctionVehicle(tx, vehicleId);

            const source = route.sourceRequestId
              ? await lockRequestForIssue(tx, route.sourceRequestId)
              : null;
            const existing = await routeWaybill(tx, route.id);
            const active = existing && existing.status !== 'cancelled' ? existing : null;

            /*
             * Р36: всё, что способно отказать, спрашивается **до** первого аннулирования — бланк
             * новой машины и его ёмкость, состояние состава, водитель на дату рейса, вид техники
             * для назначений. Дальше идут только правки.
             */
            const ordered = order.map((requestId, index) => {
              const row = composition.find((item) => item.requestId === requestId)!;
              return { ...row, position: index + 1 };
            });
            await preflightCorrection(
              tx,
              {
                purpose: route.purpose,
                vehicleId,
                routeDate: route.routeDate,
                driverPersonId,
                withTrailer: trip.withTrailer,
                sourceRequest: source,
                waybillStatus: active?.status ?? null,
                blankAllowed,
              },
              ordered,
            );
            const reassignment = await planReassignment(tx, ordered, vehicleId);
            const approvals = await approvedShiftsOfComposition(tx, ordered);

            // ── Правки ──
            if (active) {
              const cancelled = await cancelWaybillForCorrection(tx, {
                waybillId: active.id,
                correctionId: correction.id,
                reason: body.reason,
                actorUserId: p.id,
              });
              // Соседняя вкладка успела списать этот номер раньше: продолжать коррекцию нечем —
              // рейс уже не тот, о котором человек принимал решение.
              if (!cancelled) throw err.conflict('Лист уже аннулирован — откройте рейс заново');
            }

            await tx
              .update(vehicleRoutes)
              .set({ vehicleId, driverPersonId, ...trip })
              .where(eq(vehicleRoutes.id, route.id));
            if (body.requestOrder) await setRouteOrder(tx, route.id, order);
            const reassigned = await applyReassignment(tx, reassignment);
            await clearShiftApprovals(tx, approvals);

            const issued = await issueWaybillForRoute(tx, {
              routeId: route.id,
              routeNumber: formatVehicleRouteNumber(route.num),
              purpose: route.purpose,
              vehicleId,
              routeDate: route.routeDate,
              driverPersonId: driverPersonId!,
              trip,
              requests: ordered.map((row) => ({
                requestId: row.requestId,
                position: row.position,
              })),
              relocation: route.sourceRequestId
                ? { requestId: route.sourceRequestId, from: route.moveFrom, to: route.moveTo }
                : null,
              /*
               * Рукопожатие коррекции (Р21а): подтверждается **будущий** лист — тот, что родится
               * после смены машины, водителя и порядка талонов. Отпечаток поэтому считается уже
               * здесь, из контекста выписки, а не по состоянию рейса до операции: у нового бланка
               * бывает и другая ёмкость, и другие пробелы документов другого водителя.
               */
              acknowledge: body.acknowledge ?? null,
              actor: { id: p.id },
            });
            await markCorrectionWaybill(tx, {
              waybillId: issued.id,
              correctionId: correction.id,
              reason: body.reason,
              // Заменять было нечего — рейс прошедшего дня без действующего листа коррекция тоже
              // кончает новым номером, и он объяснён причиной при пустой ссылке (Р35).
              correctsWaybillId: active?.id ?? null,
            });
            trace.cancelled = active?.number ?? null;
            trace.issued = issued.number;

            const touched = [
              ...composition.map((row) => row.requestId),
              ...(route.sourceRequestId ? [route.sourceRequestId] : []),
            ];
            await bumpRequestVersions(tx, touched, p.id);
            await bumpRouteVersion(tx, route.id, p.id);
            await linkCorrectionRequests(tx, correction.id, touched);

            /*
             * Снимок «было → стало» (Р16). Здесь то, чего через месяц уже не восстановить: прежняя
             * машина и водитель рейса, прежние назначения заявок и снятые подписи смен — их в
             * `vehicle_request_shifts` после снятия нет вовсе. Состояние листов сюда не кладётся:
             * они никуда не делись и читаются из журнала по ссылке на операцию.
             */
            return {
              route: {
                id: route.id,
                number: formatVehicleRouteNumber(route.num),
                routeDate: route.routeDate,
                vehicleId: { before: route.vehicleId, after: vehicleId },
                vehicleStatus: vehicle.status,
                driverPersonId: { before: route.driverPersonId, after: driverPersonId },
                trip: { before: was, after: trip },
                order: { before: currentOrder, after: order },
              },
              waybill: {
                cancelled: active ? { id: active.id, number: active.number } : null,
                issued: { id: issued.id, number: issued.number },
              },
              requests: reassigned,
              // Дни линейных заказов: их назначение не менялось (ADR 0100 п. 4), но машина дня
              // сменилась вместе с рейсом — и в разбирательстве это надо будет объяснить.
              linearDays: composition
                .filter((row) => row.workDate !== null)
                .map((row) => ({
                  requestId: row.requestId,
                  displayNumber: row.displayNumber,
                  workDate: row.workDate,
                })),
              shifts: approvals,
            };
          },
        },
      );

      if (!outcome.repeated) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_route.correct',
          entityType: 'vehicle_route',
          entityId: req.params.id,
          // Оба номера в одной записи: лента аудита остаётся местом, где видно всё подряд в одном
          // порядке, а «почему» отвечает журнал коррекций (Р16).
          metadata: {
            correctionId: outcome.correction.id,
            operationId: body.operationId,
            reason: body.reason,
            cancelledNumber: trace.cancelled,
            issuedNumber: trace.issued,
          },
        });
      }
      return routeWithPoints(req.params.id);
    },
  );

  /**
   * Перенести заявку между рейсами прошедших дней (ADR 0101 п. 14, Р30): «оформили средой, а ехали
   * вторником».
   *
   * `:id` — рейс-**приёмник**, `source` — источник со своей версией. Одна транзакция и один порядок
   * шагов:
   *
   * 1. блокировки Р24 — сперва оба рейса по возрастанию `id` (`lockRoutePair`), затем заявки обоих
   *    составов одним проходом (`lockCompositionPair`);
   * 2. обе версии рейсов; граница заднего числа по **более ранней** из двух дат (таблица §4 плана);
   * 3. состав обоих рейсов целиком в работе (Р3, Р13) — правило одно для выписки и перевыписки;
   * 4. preflight будущих составов обоих рейсов **до первого аннулирования** (Р36);
   * 5. оба действующих листа списываются, и только потом заявка переезжает: между «списали
   *    приёмник» и «списали источник» не должно быть мгновения, в котором одна работа стоит в двух
   *    действующих документах;
   * 6. назначение заявки переписывается на машину приёмника — рейс источник истины о том, чем едут
   *    (ADR 0052 п. 4);
   * 7. новый лист приёмнику и, если источник не опустел, ему тоже (Р22);
   * 8. **одна** запись операции на оба рейса и оба листа (Р16), версии заявок вверх (Р24).
   *
   * Почему отдельной командой, а не `requestIds` в теле коррекции рейса: состав меняется сразу в
   * двух рейсах, и та форма позволяла бы потерять талон в чужом рейсе — без его версии, без его
   * блокировки и без списания его бланка.
   *
   * Расхождение дат здесь не проверяется намеренно (`canJoinRoute` не зовётся): рейсы разных дней —
   * это и есть предмет операции, а несовпадение дня подачи заявки с днём рейса — штатное состояние
   * (ADR 0082 п. 3, Р6). Дату самой заявки перенос не двигает: у неё свой вход со своей причиной.
   */
  r.post(
    '/:id/correction/transfer',
    { preHandler: correctionGuards, schema: { params: idParams, body: transferCorrectionSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const access = backdateAccessOf(p);
      const blankAllowed = can(p, 'waybills.issueBlank');

      if (body.source.routeId === req.params.id) {
        throw err.unprocessable(TRANSFER_SAME_ROUTE_MESSAGE, { source: 'Тот же рейс' });
      }

      /*
       * Даты обоих рейсов до транзакции — ими считается вердикт на первой попытке и на повторе
       * (Р31): `runCorrection` зовёт `authorize` сам, в том числе тогда, когда `perform` не
       * выполняется вовсе, и второго места, где спросить право, у повтора нет.
       */
      const known = await db
        .select({ id: vehicleRoutes.id, routeDate: vehicleRoutes.routeDate })
        .from(vehicleRoutes)
        .where(inArray(vehicleRoutes.id, [req.params.id, body.source.routeId]));
      if (known.length !== 2) throw err.notFound('Маршрут не найден');
      /** Более ранний из двух дней: он решает и право, и глубину (таблица §4 плана). */
      const earliest = known.map((row) => row.routeDate).sort()[0]!;

      const authorize = () =>
        backdateOrThrow(
          checkBackdate({
            effectiveDate: earliest,
            today: today(),
            subject: p,
            // Причина у переноса обязательна по схеме — вердикт решает вопросы права и глубины.
            hasReason: true,
          }),
        );

      /** Номера обеих сторон — для аудита; появляются внутри `perform`, поэтому полями объекта. */
      const trace: { cancelled: string[]; issued: string[] } = { cancelled: [], issued: [] };

      const outcome = await runCorrection(
        {
          operationId: body.operationId,
          kind: 'transfer',
          // Цель — оба рейса: `:id` телом не передаётся, и без него один ключ покрыл бы перенос в
          // соседний рейс тем же телом. Порядок здесь фиксированный (приёмник, источник), потому
          // что отпечаток считается от значения как есть.
          target: [req.params.id, body.source.routeId],
          body,
          reason: body.reason,
          actorUserId: p.id,
        },
        {
          authorize,
          perform: async (tx, correction) => {
            const { target, source } = await lockRoutePair(tx, req.params.id, body.source.routeId);
            // Недостижимо: id разные (проверено выше), а ненайденный рейс `lockRoute` объявляет
            // сам. Строка стоит ради типа — молчаливый `!` прятал бы это рассуждение.
            if (!source) throw err.notFound('Исходный маршрут не найден');
            assertRouteVersion(target, body.version);
            assertRouteVersion(source, body.source.version);

            /*
             * Даты перечитываются под блокировкой: между первым чтением и `FOR UPDATE` любой из
             * рейсов успевают перенести на другой день (`moveRouteToDate`), а от более ранней даты
             * зависит и право, и глубина.
             */
            const effective = [target.routeDate, source.routeDate].sort()[0]!;
            backdateOrThrow(
              checkBackdate({
                effectiveDate: effective,
                today: today(),
                subject: p,
                hasReason: true,
              }),
            );

            // Талоны бывают только у грузового рейса: у перегона вместо состава одна
            // заявка-основание, и «перенести в него» означало бы другой перегон (ADR 0057).
            if (isRelocationPurpose(target.purpose) || isRelocationPurpose(source.purpose)) {
              throw err.unprocessable(TRANSFER_RELOCATION_MESSAGE);
            }

            const composition = await lockCompositionPair(tx, target.id, source.id);
            /*
             * Готовность обоих составов (Р3, Р13). Проверяется каждый по своей дате: у приёмника и
             * источника разные дни, и глубина у них тоже разная — рейс двухнедельной давности
             * диспетчер правит сам, а месячной уже нет.
             */
            for (const side of [
              { route: target, requests: composition.target },
              { route: source, requests: composition.source },
            ]) {
              const ready = canCorrectRoute(
                { routeDate: side.route.routeDate, requests: side.requests },
                today(),
                { unlimited: access.beyondLimit },
              );
              if (!ready.ok) {
                throw err.unprocessable(
                  ready.blocking.length > 0
                    ? `Маршрут ${formatVehicleRouteNumber(side.route.num)}: ${ready.reason} Заявки: ${ready.blocking.join(', ')}`
                    : `Маршрут ${formatVehicleRouteNumber(side.route.num)}: ${ready.reason}`,
                );
              }
            }

            /*
             * Будущие составы обеих сторон — и всё, что способно отказать, спрашивается по ним до
             * первого аннулирования (Р36): ёмкость бланка приёмника (у 4-П семь строк задания, у
             * формы № 3 десять — ADR 0068), водитель на дату каждого рейса, вид техники для
             * назначения. Опустевший источник в preflight не идёт: лист ему не выписывается вовсе
             * (Р22), и «в маршруте нет заявок» было бы отказом за то, чего команда не собирается
             * делать.
             */
            const plan = planTransfer({
              requestId: body.requestId,
              position: body.position,
              target: composition.target,
              source: composition.source,
            });
            const prospective = (route: RouteRow) => ({
              purpose: route.purpose,
              vehicleId: route.vehicleId,
              routeDate: route.routeDate,
              driverPersonId: route.driverPersonId,
              withTrailer: route.withTrailer,
              sourceRequest: null,
              // Действующий лист аннулируется этой же транзакцией — проверку «лист уже есть»
              // preflight снимает сам (`correction: { allowed: true }`).
              waybillStatus: null,
              blankAllowed,
            });
            await preflightCorrection(tx, prospective(target), plan.target);
            if (plan.source.length > 0) {
              await preflightCorrection(tx, prospective(source), plan.source);
            }
            /*
             * Назначение переезжает на машину приёмника (ADR 0052 п. 4): в прошедшем дне заявку
             * везла та машина, чьим рейсом она ехала. Вид техники сверяется здесь же — до
             * аннулирования (ADR 0059). Линейного дня в плане не бывает (`planTransfer` его
             * отклоняет), поэтому список либо пуст (заявка уже назначена на эту машину), либо
             * состоит из одной строки.
             */
            const reassignment = await planReassignment(tx, [plan.moved], target.vehicleId);

            // ── Правки. Сперва оба номера списаны (Р30), потом переезд, потом оба новых листа ──
            const cancelled = {
              target: await cancelRouteWaybillForCorrection(tx, {
                routeId: target.id,
                correctionId: correction.id,
                reason: body.reason,
                actorUserId: p.id,
              }),
              source: await cancelRouteWaybillForCorrection(tx, {
                routeId: source.id,
                correctionId: correction.id,
                reason: body.reason,
                actorUserId: p.id,
              }),
            };

            await detachRequest(tx, source.id, body.requestId);
            // Днём строки перенос не распоряжается: `planTransfer` пускает сюда только грузовую
            // заявку, у которой день несёт сам рейс (ADR 0100 §2).
            await attachRequest(tx, target.id, body.requestId, null);
            /*
             * Ездки переезжают вместе с талоном (Р8). Их роли в источнике сняты каскадом, а пустые
             * точки убрал `detachRequest`, — и без этой раскладки заявка встала бы в приёмник
             * строкой состава без единой точки: печатать её нечем, «откуда» и «куда» неизвестны.
             * Прежде этого не было видно — задание собиралось из состава; со строками задания это
             * ровно `rows_unplaced`, и перевыписанный лист умолчал бы о переехавшей работе.
             */
            await placeRequestTrips(tx, target.id, body.requestId);
            await setRouteOrder(
              tx,
              target.id,
              plan.target.map((row) => row.requestId),
            );
            const reassigned = await applyReassignment(tx, reassignment);

            /*
             * Оба листа — с рукопожатием своей стороны (Р21а): наборы предупреждений у приёмника и
             * источника разные, потому что задание у них разное, и общий отпечаток означал бы, что
             * подтверждение одной бумаги закрывает вторую, которой человек не видел.
             */
            const issued = {
              target: await issueCorrectionWaybill(tx, {
                route: target,
                composition: plan.target,
                correctionId: correction.id,
                reason: body.reason,
                correctsWaybillId: cancelled.target?.id ?? null,
                acknowledge: body.acknowledge?.target ?? null,
                actorUserId: p.id,
              }),
              source: await issueCorrectionWaybill(tx, {
                route: source,
                composition: plan.source,
                correctionId: correction.id,
                reason: body.reason,
                correctsWaybillId: cancelled.source?.id ?? null,
                acknowledge: body.acknowledge?.source ?? null,
                actorUserId: p.id,
              }),
            };
            trace.cancelled = [cancelled.target?.number, cancelled.source?.number].filter(
              (n): n is string => !!n,
            );
            trace.issued = [issued.target?.number, issued.source?.number].filter(
              (n): n is string => !!n,
            );

            /*
             * Версии заявок (Р24) — всем, кого задели оба рейса, а не одной переехавшей: у
             * остальных сменился номер листа, в котором стоит их талон, и чужая открытая карточка
             * сохранила бы поверх коррекции старое состояние.
             *
             * Связь с операцией (Р16), наоборот, только у переехавшей: «что делали с этой заявкой
             * задним числом» — вопрос про неё одну, а соседки по рейсу ничего задним числом не
             * получили, кроме нового номера бумаги.
             */
            await bumpRequestVersions(
              tx,
              [...composition.target, ...composition.source].map((row) => row.requestId),
              p.id,
            );
            await bumpRouteVersion(tx, target.id, p.id);
            await bumpRouteVersion(tx, source.id, p.id);
            await linkCorrectionRequests(tx, correction.id, [body.requestId]);

            /*
             * Снимок «было → стало» (Р16): откуда и куда уехал талон, чем заявка была назначена до
             * переноса и какими номерами это кончилось с обеих сторон. Состояние листов сюда не
             * кладётся — они читаются из журнала по ссылке на операцию.
             */
            return {
              request: {
                id: plan.moved.requestId,
                displayNumber: plan.moved.displayNumber,
                // Талон «был третьим в Р-7, стал вторым в Р-9»: обе позиции считаются планом, а не
                // телом запроса, — в теле позиции может не быть вовсе (заявка встаёт последней).
                position: {
                  before: plan.moved.position,
                  after: plan.target.find((row) => row.requestId === plan.moved.requestId)!
                    .position,
                },
              },
              routes: {
                target: {
                  id: target.id,
                  number: formatVehicleRouteNumber(target.num),
                  routeDate: target.routeDate,
                  vehicleId: target.vehicleId,
                },
                source: {
                  id: source.id,
                  number: formatVehicleRouteNumber(source.num),
                  routeDate: source.routeDate,
                  vehicleId: source.vehicleId,
                  // Опустевший источник остаётся пустым и без листа (Р22) — в разбирательстве
                  // «почему у этого рейса нет бумаги» отвечает именно эта строка.
                  emptied: plan.source.length === 0,
                },
              },
              waybills: { cancelled, issued },
              requests: reassigned,
            };
          },
        },
      );

      if (!outcome.repeated) {
        await writeAudit({
          actorUserId: p.id,
          // Тем же действием, что и коррекция рейса: в ленте аудита это одно событие — «прошедший
          // день переписан», — и отбор по коррекциям не должен терять половину из них. Что именно
          // произошло, говорит `operation`.
          action: 'vehicle_route.correct',
          entityType: 'vehicle_route',
          entityId: req.params.id,
          metadata: {
            operation: 'transfer',
            correctionId: outcome.correction.id,
            operationId: body.operationId,
            reason: body.reason,
            requestId: body.requestId,
            sourceRouteId: body.source.routeId,
            cancelledNumbers: trace.cancelled,
            issuedNumbers: trace.issued,
          },
        });
      }

      /*
       * Обе стороны в ответе: операция изменила два рейса, и карточка, показавшая только приёмник,
       * оставила бы источник с прежним номером листа на экране. Ответ пересобирается из текущего
       * состояния — тем же кодом на первой попытке и на повторе (Р31).
       */
      return {
        target: await routeWithPoints(req.params.id),
        source: await routeWithPoints(body.source.routeId),
      };
    },
  );
}
