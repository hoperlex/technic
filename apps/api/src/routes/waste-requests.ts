import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  can,
  assignWasteOperatorSchema,
  changeWasteRequestStatusSchema,
  createWasteRequestSchema,
  type FileDto,
  MIN_WASTE_VOLUME_M3,
  REQUEST_STATUSES,
  type RequestType,
  requiresWasteVehicles,
  sumVehicleAmount,
  sumVehicleVolume,
  updateWasteRequestSchema,
  type WasteRequestDto,
  type WasteRequestSummaryDto,
  type WasteRequestVehicleDto,
  wasteRequestListQuerySchema,
  wasteRequestSummaryQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  containerTypes,
  counterparties,
  files,
  presentContainers,
  requestFiles,
  requestStatusHistory,
  users,
  wasteRequests,
  wasteTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import {
  assertArchiveVisible,
  assertCan,
  assertOperatorScope,
  assertShtabEditable,
  assertShtabScope,
  assertTransitionAllowed,
  operatorVisibilityWhere,
  requestVisibilityWhere,
} from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  assertFilesAttachable,
  assertTotalWithinLimit,
  hardDeleteFiles,
  markFilesActive,
  scheduleFilesDeletion,
} from '../services/request-files';
import { priceWasteRequest, toNum } from '../services/waste-pricing';
import { diffWasteRequests } from '../services/waste-request-diff';
import { loadWasteRequestHistory } from '../services/waste-request-history';
import {
  countActiveVehicles,
  hardDeleteVehicles,
  insertVehicles,
  markVehiclesDeleted,
  restoreVehicles,
  updateVehicleCounts,
  vehiclesByRequestIds,
} from '../services/waste-request-vehicles';
import { assertOperatorServesObject } from '../services/object-operators';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

// Машины есть только у вывоза мусора. Талоны бывают у заявок любого типа и с ADR 0024 везде
// крепятся к самой заявке — общим пулом, а не к отдельной машине.
const VEHICLES_NOT_APPLICABLE = 'Машины прикладываются только к заявкам на вывоз мусора';

const requestSelect = {
  id: wasteRequests.id,
  num: wasteRequests.num,
  objectId: wasteRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  requestType: wasteRequests.requestType,
  containerTypeId: wasteRequests.containerTypeId,
  containerTypeName: containerTypes.name,
  wasteTypeId: wasteRequests.wasteTypeId,
  wasteTypeName: wasteTypes.name,
  volumeM3: wasteRequests.volumeM3,
  pricePerM3: wasteRequests.pricePerM3,
  amount: wasteRequests.amount,
  deliveryAt: wasteRequests.deliveryAt,
  deliveryTimeUnspecified: wasteRequests.deliveryTimeUnspecified,
  comment: wasteRequests.comment,
  status: wasteRequests.status,
  // Причина отмены живёт в истории статусов; в списке нужна последняя и только у отменённых
  // заявок — после отката администратором прежняя причина к текущему статусу не относится.
  cancelReason: sql<string | null>`
    CASE WHEN ${wasteRequests.status} = 'cancelled' THEN (
      SELECT h.comment
      FROM ${requestStatusHistory} h
      WHERE h.request_id = ${wasteRequests.id} AND h.to_status = 'cancelled'
      ORDER BY h.changed_at DESC
      LIMIT 1
    ) END`.as('cancel_reason'),
  // Кто вывозит (ADR 0010): контрагент-оператор; он же определяет видимость заявки для оператора.
  operatorCounterpartyId: wasteRequests.operatorCounterpartyId,
  operatorName: counterparties.name,
  version: wasteRequests.version,
  createdBy: wasteRequests.createdBy,
  createdByName: users.fullName,
  createdAt: wasteRequests.createdAt,
  updatedAt: wasteRequests.updatedAt,
  deletedAt: wasteRequests.deletedAt,
};

type RequestRow = Awaited<ReturnType<typeof baseQuery>>[number];

/** Вложения заявки, разложенные по назначению: документы и талоны закрытия (ADR 0013). */
interface RequestFileGroups {
  files: FileDto[];
  tickets: FileDto[];
}

const EMPTY_FILE_GROUPS: RequestFileGroups = { files: [], tickets: [] };

async function filesByRequestIds(ids: string[]): Promise<Map<string, RequestFileGroups>> {
  const map = new Map<string, RequestFileGroups>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: requestFiles.requestId,
      kind: requestFiles.kind,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(requestFiles)
    .innerJoin(files, eq(requestFiles.fileId, files.id))
    .where(and(inArray(requestFiles.requestId, ids), eq(files.status, 'active')));
  for (const row of rows) {
    const groups = map.get(row.requestId) ?? { files: [], tickets: [] };
    (row.kind === 'ticket' ? groups.tickets : groups.files).push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.requestId, groups);
  }
  return map;
}

function toDto(
  r: RequestRow,
  fileGroups: RequestFileGroups,
  vehicles: WasteRequestVehicleDto[] = [],
): WasteRequestDto {
  return {
    id: r.id,
    num: r.num,
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    requestType: r.requestType,
    containerTypeId: r.containerTypeId,
    containerTypeName: r.containerTypeName,
    wasteTypeId: r.wasteTypeId,
    wasteTypeName: r.wasteTypeName,
    volumeM3: r.volumeM3,
    pricePerM3: toNum(r.pricePerM3),
    amount: toNum(r.amount),
    operatorCounterpartyId: r.operatorCounterpartyId,
    operatorName: r.operatorName,
    deliveryAt: r.deliveryAt.toISOString(),
    deliveryTimeUnspecified: r.deliveryTimeUnspecified,
    comment: r.comment,
    status: r.status,
    // Пустой комментарий отмены (история до миграции 0024) читается как «причина не указана».
    cancelReason: r.cancelReason || null,
    files: fileGroups.files,
    tickets: fileGroups.tickets,
    vehicles,
    // Факт вывоза считается по строкам машин (ADR 0024): объём — суммой, сумма — по снимкам цен
    // в самих строках. Отдельных колонок у заявки нет: производная от машин не должна уметь
    // с ними разойтись — тем же принципом, что и `amount` у самой заявки.
    factVolumeM3: vehicles.length > 0 ? sumVehicleVolume(vehicles) : null,
    factAmount: sumVehicleAmount(vehicles),
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

// Справочники присоединяются left join: тип контейнера/машины опционален в зависимости от типа
// заявки, тип мусора есть только у тарифицируемых операций (ADR 0009), а оператор может быть
// ещё не назначен (ADR 0010).
function baseQuery() {
  return db
    .select(requestSelect)
    .from(wasteRequests)
    .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
    .leftJoin(containerTypes, eq(wasteRequests.containerTypeId, containerTypes.id))
    .leftJoin(wasteTypes, eq(wasteRequests.wasteTypeId, wasteTypes.id))
    .leftJoin(counterparties, eq(wasteRequests.operatorCounterpartyId, counterparties.id))
    .innerJoin(users, eq(wasteRequests.createdBy, users.id));
}

/**
 * Оператор заявки — контрагент типа «Оператор» (ADR 0010). Подрядчик в этом поле означал бы,
 * что заявку увидит не тот, кто её выполняет: видимость оператора считается по этой колонке.
 */
async function assertOperatorAssignable(
  tx: Tx,
  counterpartyId: string,
  objectId: string,
): Promise<void> {
  const [cp] = await tx
    .select({
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  if (!cp || cp.deletedAt) throw err.badRequest('Контрагент не найден');
  if (cp.type !== 'operator') {
    throw err.badRequest('Оператором заявки может быть только контрагент типа «Оператор»', {
      operatorCounterpartyId: 'Нужен контрагент типа «Оператор»',
    });
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  // Исполнитель должен работать на объекте заявки (ADR 0010, миграция 0027).
  await assertOperatorServesObject(tx, objectId, counterpartyId);
}

/** Нормализованный набор «предметных» колонок заявки, включая снимок цены (ADR 0009). */
interface RequestSubject {
  containerTypeId: string | null;
  wasteTypeId: string | null;
  volumeM3: number | null;
  wasteTariffId: string | null;
  pricePerM3: string | null;
}

/** Присутствует ли контейнер этого типа на объекте (по view наличия present_containers). */
async function isTypePresent(tx: Tx, objectId: string, containerTypeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: presentContainers.id })
    .from(presentContainers)
    .where(
      and(
        eq(presentContainers.objectId, objectId),
        eq(presentContainers.containerTypeId, containerTypeId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Проверяет и нормализует поля заявки по её типу:
 *  - установка — сверяет тип контейнера (type='cont');
 *  - замена/снятие — сверяет, что контейнер этого типа присутствует на объекте (view наличия);
 *  - вывоз — техники не несёт вовсе (ADR 0022): присланный тип отбрасывается.
 * Тарифицируется один вывоз (ADR 0019): у него требуются тип мусора и объём, по ним
 * подбирается тариф и возвращается снимок цены. Прайс берётся у назначенного оператора, а пока
 * его нет — самый дешёвый среди операторов (ADR 0023). У контейнерных операций эти поля
 * обнуляются — так они очищаются и при смене типа уже заведённой заявки.
 */
async function resolveSubject(
  tx: Tx,
  input: {
    requestType: RequestType;
    objectId: string;
    containerTypeId: string | null;
    wasteTypeId: string | null;
    volumeM3: number | null;
    operatorCounterpartyId: string | null;
  },
): Promise<RequestSubject> {
  if (input.requestType === 'container_install') {
    if (!input.containerTypeId) throw err.badRequest('Выберите тип контейнера');
    const [ct] = await tx
      .select({ type: containerTypes.type })
      .from(containerTypes)
      .where(eq(containerTypes.id, input.containerTypeId));
    if (!ct) throw err.badRequest('Тип контейнера не найден');
    if (ct.type !== 'cont') throw err.badRequest('Для установки нужен тип контейнера');
    return {
      containerTypeId: input.containerTypeId,
      wasteTypeId: null,
      volumeM3: null,
      wasteTariffId: null,
      pricePerM3: null,
    };
  }

  if (input.requestType === 'container_replace' || input.requestType === 'container_removal') {
    const what = input.requestType === 'container_replace' ? 'замены' : 'снятия';
    if (!input.containerTypeId) throw err.badRequest(`Выберите тип контейнера для ${what}`);
    if (!(await isTypePresent(tx, input.objectId, input.containerTypeId))) {
      throw err.badRequest(`На объекте нет контейнера этого типа для ${what}`);
    }
    // Контейнерная операция не тарифицируется (ADR 0019): присланные тип мусора и объём
    // отбрасываются вместе со снимком цены.
    return {
      containerTypeId: input.containerTypeId,
      wasteTypeId: null,
      volumeM3: null,
      wasteTariffId: null,
      pricePerM3: null,
    };
  }

  // waste_removal — вывоз разового объёма (ADR 0022): техника в предмет заявки не входит, чем
  // вывозить, решает оператор и предъявляет машинами при закрытии (ADR 0011). Тип из
  // справочника здесь не хранится даже у заявок, заведённых раньше: правка приводит их к
  // общему виду, иначе в карточке осталось бы поле, которого у типа заявки больше нет.

  // Тип мусора и объём обязательны, цена берётся из прайса по виду техники «Самосвал».
  if (!input.wasteTypeId) throw err.badRequest('Выберите тип мусора');
  if (input.volumeM3 == null) throw err.badRequest('Укажите объём');
  if (input.volumeM3 < MIN_WASTE_VOLUME_M3) {
    throw err.badRequest(`Объём не меньше ${MIN_WASTE_VOLUME_M3} м³`);
  }
  const volumeM3 = input.volumeM3;
  const [wt] = await tx
    .select({ id: wasteTypes.id, isActive: wasteTypes.isActive })
    .from(wasteTypes)
    .where(eq(wasteTypes.id, input.wasteTypeId));
  if (!wt) throw err.badRequest('Тип мусора не найден');
  if (!wt.isActive) throw err.badRequest('Тип мусора неактивен');

  const pricing = await priceWasteRequest({
    requestType: input.requestType,
    wasteTypeId: input.wasteTypeId,
    volumeM3,
    operatorCounterpartyId: input.operatorCounterpartyId,
  });

  return {
    containerTypeId: null,
    wasteTypeId: input.wasteTypeId,
    volumeM3,
    wasteTariffId: pricing.wasteTariffId,
    pricePerM3: pricing.pricePerM3,
  };
}

async function getRequestDto(id: string): Promise<WasteRequestDto | null> {
  const [row] = await baseQuery().where(eq(wasteRequests.id, id));
  if (!row) return null;
  const [filesMap, vehiclesMap] = await Promise.all([
    filesByRequestIds([id]),
    vehiclesByRequestIds([id]),
  ]);
  return toDto(row, filesMap.get(id) ?? EMPTY_FILE_GROUPS, vehiclesMap.get(id) ?? []);
}

async function linkFiles(
  tx: Tx,
  requestId: string,
  fileIds: string[],
  uploaderId: string,
  enforceTotal = false,
  // Талоны приходят только с закрытием заявки; всё остальное — документы (ADR 0013).
  kind: 'attachment' | 'ticket' = 'attachment',
): Promise<void> {
  if (fileIds.length === 0) return;
  await assertFilesAttachable(tx, fileIds, uploaderId);
  if (enforceTotal) {
    const [c] = await tx
      .select({ c: count() })
      .from(requestFiles)
      .where(eq(requestFiles.requestId, requestId));
    assertTotalWithinLimit(Number(c!.c), fileIds.length);
  }
  await tx.insert(requestFiles).values(fileIds.map((fileId) => ({ requestId, fileId, kind })));
  await markFilesActive(tx, fileIds);
}

/**
 * Живые талоны самой заявки (ADR 0013). Считаются по состоянию заявки, а не по телу запроса:
 * при повторном закрытии талон мог быть приложен ещё в прошлый раз (ADR 0020).
 */
async function countRequestTickets(tx: Tx, requestId: string): Promise<number> {
  const [row] = await tx
    .select({ c: count() })
    .from(requestFiles)
    .innerJoin(files, eq(requestFiles.fileId, files.id))
    .where(
      and(
        eq(requestFiles.requestId, requestId),
        eq(requestFiles.kind, 'ticket'),
        eq(files.status, 'active'),
      ),
    );
  return Number(row!.c);
}

async function unlinkFiles(tx: Tx, requestId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(requestFiles)
    .innerJoin(files, eq(requestFiles.fileId, files.id))
    .where(and(eq(requestFiles.requestId, requestId), inArray(requestFiles.fileId, fileIds)));
  if (linked.length === 0) return;
  const ids = linked.map((l) => l.id);
  await tx
    .delete(requestFiles)
    .where(and(eq(requestFiles.requestId, requestId), inArray(requestFiles.fileId, ids)));
  await scheduleFilesDeletion(tx, linked, false);
}

/** Один текст отказа на все три пути назначения исполнителя: форма, правка, отдельный маршрут. */
const ASSIGN_OPERATOR_DENIED = 'Оператора назначает диспетчер или менеджер';

export default async function wasteRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Право на каждое действие отдельно (ADR 0021). Раньше модуль был открыт любому вошедшему,
  // а роли ограничивались запретами («не оператор»), из-за чего новая роль по умолчанию
  // получала права заказчика.
  const auth = { preHandler: [app.authenticate, app.requirePermission('wasteRequests.read')] };
  const canCreate = {
    preHandler: [
      app.authenticate,
      app.requirePermission('wasteRequests.create', 'Недостаточно прав для создания заявки'),
    ],
  };
  const canUpdate = {
    preHandler: [
      app.authenticate,
      app.requirePermission('wasteRequests.update', 'Недостаточно прав для редактирования заявки'),
    ],
  };
  const canDelete = {
    preHandler: [
      app.authenticate,
      app.requirePermission('wasteRequests.delete', 'Недостаточно прав для удаления заявки'),
    ],
  };
  const canChangeStatus = {
    preHandler: [
      app.authenticate,
      app.requirePermission('wasteRequests.status', 'Недостаточно прав для смены статуса'),
    ],
  };
  const canAssignOperator = {
    preHandler: [
      app.authenticate,
      app.requirePermission('wasteRequests.assignOperator', ASSIGN_OPERATOR_DENIED),
    ],
  };

  r.get('/', { ...auth, schema: { querystring: wasteRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const showDeleted = q.includeDeleted && can(p.role, 'archive.read');
    const where = and(
      showDeleted ? undefined : isNull(wasteRequests.deletedAt),
      requestVisibilityWhere(p, wasteRequests.objectId),
      operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
      q.status ? eq(wasteRequests.status, q.status) : undefined,
      q.objectId ? eq(wasteRequests.objectId, q.objectId) : undefined,
      q.containerTypeId ? eq(wasteRequests.containerTypeId, q.containerTypeId) : undefined,
      q.operatorCounterpartyId
        ? eq(wasteRequests.operatorCounterpartyId, q.operatorCounterpartyId)
        : undefined,
      q.requestType ? eq(wasteRequests.requestType, q.requestType) : undefined,
      q.num ? eq(wasteRequests.num, q.num) : undefined,
      q.deliveryFrom ? gte(wasteRequests.deliveryAt, q.deliveryFrom) : undefined,
      q.deliveryTo ? lte(wasteRequests.deliveryAt, q.deliveryTo) : undefined,
      searchCondition(q.search, [
        wasteRequests.comment,
        constructionObjects.name,
        constructionObjects.code,
      ]),
    );
    const sortCols = {
      num: wasteRequests.num,
      objectName: constructionObjects.name,
      createdByName: users.fullName,
      containerTypeName: containerTypes.name,
      wasteTypeName: wasteTypes.name,
      requestType: wasteRequests.requestType,
      deliveryAt: wasteRequests.deliveryAt,
      status: wasteRequests.status,
      operatorName: counterparties.name,
      comment: wasteRequests.comment,
      createdAt: wasteRequests.createdAt,
    };
    const p2 = pageParams(q);
    // Сортировка по неуникальному столбцу (status, requestType, deliveryAt) сама по себе не задаёт
    // порядок строк с одинаковым значением: между запросами страниц они могут переставиться, и
    // тогда часть заявок задвоится, а часть пропадёт. num + id доводят сортировку до полной.
    const rows = await baseQuery()
      .where(where)
      .orderBy(
        orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'),
        asc(wasteRequests.num),
        asc(wasteRequests.id),
      )
      .limit(p2.limit)
      .offset(p2.offset);
    const [totalRow] = await db
      .select({ c: count() })
      .from(wasteRequests)
      .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
      .where(where);
    const [filesMap, vehiclesMap] = await Promise.all([
      filesByRequestIds(rows.map((row) => row.id)),
      vehiclesByRequestIds(rows.map((row) => row.id)),
    ]);
    return {
      items: rows.map((row) =>
        toDto(row, filesMap.get(row.id) ?? EMPTY_FILE_GROUPS, vehiclesMap.get(row.id) ?? []),
      ),
      total: Number(totalRow!.c),
      page: p2.page,
      pageSize: p2.pageSize,
    };
  });

  // Наличие контейнеров на площадках (view present_containers): присутствующие заявки установки.
  r.get(
    '/present',
    { ...auth, schema: { querystring: wasteRequestListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const where = and(
        isNull(wasteRequests.deletedAt),
        requestVisibilityWhere(p, wasteRequests.objectId),
        operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
        inArray(wasteRequests.id, db.select({ id: presentContainers.id }).from(presentContainers)),
        q.objectId ? eq(wasteRequests.objectId, q.objectId) : undefined,
        searchCondition(q.search, [constructionObjects.name, constructionObjects.code]),
      );
      const sortCols = {
        num: wasteRequests.num,
        objectName: constructionObjects.name,
        containerTypeName: containerTypes.name,
        deliveryAt: wasteRequests.deliveryAt,
        createdAt: wasteRequests.createdAt,
      };
      const p2 = pageParams(q);
      const rows = await baseQuery()
        .where(where)
        .orderBy(
          orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'),
          asc(wasteRequests.num),
          asc(wasteRequests.id),
        )
        .limit(p2.limit)
        .offset(p2.offset);
      const [totalRow] = await db
        .select({ c: count() })
        .from(wasteRequests)
        .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
        .where(where);
      const filesMap = await filesByRequestIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, filesMap.get(row.id) ?? EMPTY_FILE_GROUPS)),
        total: Number(totalRow!.c),
        page: p2.page,
        pageSize: p2.pageSize,
      };
    },
  );

  /**
   * Сводка «сколько заявок в каком статусе» для виджета над таблицей. Считается по тем же
   * правилам видимости, что и список: штаб видит свой объект, оператор — только назначенные
   * ему заявки (ADR 0010). Удалённые в счёт не идут — их нет и в списке.
   */
  r.get(
    '/summary',
    { ...auth, schema: { querystring: wasteRequestSummaryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const rows = await db
        .select({ status: wasteRequests.status, c: count() })
        .from(wasteRequests)
        .where(
          and(
            isNull(wasteRequests.deletedAt),
            requestVisibilityWhere(p, wasteRequests.objectId),
            operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
            req.query.objectId ? eq(wasteRequests.objectId, req.query.objectId) : undefined,
          ),
        )
        .groupBy(wasteRequests.status);
      const summary = Object.fromEntries(
        REQUEST_STATUSES.map((s) => [s, 0]),
      ) as WasteRequestSummaryDto;
      for (const row of rows) summary[row.status] = Number(row.c);
      return summary;
    },
  );

  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const dto = await getRequestDto(req.params.id);
    if (!dto) throw err.notFound('Заявка не найдена');
    assertArchiveVisible(p, dto.deletedAt, 'Заявка не найдена');
    assertShtabScope(p, dto.objectId);
    assertOperatorScope(p, dto.operatorCounterpartyId);
    return dto;
  });

  // История заявки: создание, правки, смены статусов. Доступна тем же, кто видит саму заявку —
  // отдельного права на неё нет: это те же события, что и в карточке, только по времени.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [row] = await db
      .select({
        id: wasteRequests.id,
        objectId: wasteRequests.objectId,
        operatorCounterpartyId: wasteRequests.operatorCounterpartyId,
        deletedAt: wasteRequests.deletedAt,
        createdAt: wasteRequests.createdAt,
        createdBy: wasteRequests.createdBy,
        createdByName: users.fullName,
      })
      .from(wasteRequests)
      .innerJoin(users, eq(wasteRequests.createdBy, users.id))
      .where(eq(wasteRequests.id, req.params.id));
    if (!row) throw err.notFound('Заявка не найдена');
    assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
    assertShtabScope(p, row.objectId);
    assertOperatorScope(p, row.operatorCounterpartyId);
    return loadWasteRequestHistory(row.id, {
      at: row.createdAt,
      actorId: row.createdBy,
      actorName: row.createdByName,
    });
  });

  r.post('/', { ...canCreate, schema: { body: createWasteRequestSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const body = req.body;
    assertShtabScope(p, body.objectId);
    // Исполнителя можно указать прямо в форме заявки, но это по-прежнему назначение оператора:
    // без отдельной проверки роль с правом на заявку (штаб) назначала бы его в обход
    // `PATCH /:id/operator`, где право спрашивают. Право требуется по факту присутствия поля,
    // а не по изменению значения: форма его не шлёт, если назначать нельзя.
    if (body.operatorCounterpartyId !== undefined) {
      assertCan(p, 'wasteRequests.assignOperator', ASSIGN_OPERATOR_DENIED);
    }
    const created = await db.transaction(async (tx) => {
      // Оператор проверяется до расчёта: цена берётся из его прайса (ADR 0023), и считать её по
      // исполнителю, которого нельзя назначить, незачем.
      if (body.operatorCounterpartyId) {
        await assertOperatorAssignable(tx, body.operatorCounterpartyId, body.objectId);
      }
      const subject = await resolveSubject(tx, {
        requestType: body.requestType,
        objectId: body.objectId,
        containerTypeId: body.containerTypeId ?? null,
        wasteTypeId: body.wasteTypeId ?? null,
        volumeM3: body.volumeM3 ?? null,
        operatorCounterpartyId: body.operatorCounterpartyId ?? null,
      });
      const [row] = await tx
        .insert(wasteRequests)
        .values({
          objectId: body.objectId,
          requestType: body.requestType,
          ...subject,
          operatorCounterpartyId: body.operatorCounterpartyId ?? null,
          deliveryAt: body.deliveryAt,
          deliveryTimeUnspecified: body.deliveryTimeUnspecified,
          comment: body.comment,
          status: 'new',
          createdBy: p.id,
        })
        .returning({ id: wasteRequests.id });
      await tx.insert(requestStatusHistory).values({
        requestId: row!.id,
        fromStatus: null,
        toStatus: 'new',
        changedBy: p.id,
      });
      await linkFiles(tx, row!.id, body.fileIds, p.id);
      return row!;
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'waste_request.create',
      entityType: 'waste_request',
      entityId: created.id,
    });
    reply.code(201);
    return (await getRequestDto(created.id))!;
  });

  r.patch(
    '/:id',
    { ...canUpdate, schema: { params: idParams, body: updateWasteRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      // Смена исполнителя правкой заявки — то же назначение оператора, и спрашивается до
      // загрузки заявки: право не зависит от её содержимого.
      if (body.operatorCounterpartyId !== undefined) {
        assertCan(p, 'wasteRequests.assignOperator', ASSIGN_OPERATOR_DENIED);
      }
      // Состояние «до» берётся сразу как DTO: по нему не только проверки, но и дифф для
      // истории — названия справочников и суммы там уже собраны (см. waste-request-history).
      const before = await getRequestDto(id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertShtabScope(p, before.objectId);
      assertShtabEditable(p, before.status, 'редактировать');
      if (body.objectId) assertShtabScope(p, body.objectId);

      const rt = body.requestType ?? before.requestType;
      const objectId = body.objectId ?? before.objectId;
      const operatorCounterpartyId =
        body.operatorCounterpartyId !== undefined
          ? body.operatorCounterpartyId
          : before.operatorCounterpartyId;
      await db.transaction(async (tx) => {
        // Проверяем и при переносе заявки на другой объект: пара «оператор — объект» могла
        // разойтись, даже если исполнителя не меняли. До расчёта: цена идёт из прайса оператора.
        if (
          operatorCounterpartyId &&
          (operatorCounterpartyId !== before.operatorCounterpartyId || objectId !== before.objectId)
        ) {
          await assertOperatorAssignable(tx, operatorCounterpartyId, objectId);
        }
        const subject = await resolveSubject(tx, {
          requestType: rt,
          objectId,
          containerTypeId:
            body.containerTypeId !== undefined ? body.containerTypeId : before.containerTypeId,
          wasteTypeId: body.wasteTypeId !== undefined ? body.wasteTypeId : before.wasteTypeId,
          volumeM3: body.volumeM3 !== undefined ? body.volumeM3 : before.volumeM3,
          operatorCounterpartyId,
        });
        const [updated] = await tx
          .update(wasteRequests)
          .set({
            objectId,
            requestType: rt,
            ...subject,
            operatorCounterpartyId,
            deliveryAt: body.deliveryAt ?? new Date(before.deliveryAt),
            // Признак меняется только вместе с датой — иначе остаётся прежним.
            deliveryTimeUnspecified: body.deliveryAt
              ? (body.deliveryTimeUnspecified ?? false)
              : before.deliveryTimeUnspecified,
            comment: body.comment ?? before.comment,
            updatedBy: p.id,
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(wasteRequests.id, id), eq(wasteRequests.version, body.version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
        if (body.removeFileIds?.length) await unlinkFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) await linkFiles(tx, id, body.addFileIds, p.id, true);
        // Машины заявки (ADR 0011). Пометку ставит и снимает любой, кто правит заявку; удалить
        // запись насовсем может только администратор — ошибочно снятый талон иначе не заметить.
        if (body.deleteVehicleIds?.length) {
          assertCan(p, 'records.purge', 'Удалить машину насовсем может только администратор');
        }
        if (body.addVehicles?.length) {
          if (!requiresWasteVehicles(rt)) {
            throw err.badRequest(VEHICLES_NOT_APPLICABLE, {
              vehicles: 'Машины заполняются только у вывоза мусора',
            });
          }
          // Талон при заведении машины не спрашивается: он общий на заявку (ADR 0024) и
          // приложен ещё закрытием — к отдельной строке бумага не относится.
          await insertVehicles(tx, id, body.addVehicles, p.id, {
            wasteTypeId: subject.wasteTypeId,
            operatorCounterpartyId,
          });
        }
        if (body.vehicleCounts?.length) await updateVehicleCounts(tx, id, body.vehicleCounts);
        if (body.markDeletedVehicleIds?.length) {
          await markVehiclesDeleted(tx, id, body.markDeletedVehicleIds, p.id);
        }
        if (body.restoreVehicleIds?.length) await restoreVehicles(tx, id, body.restoreVehicleIds);
        if (body.deleteVehicleIds?.length) await hardDeleteVehicles(tx, id, body.deleteVehicleIds);
        // Смена типа на контейнерную операцию оставила бы машины у заявки, которая по ним
        // не отчитывается.
        if (!requiresWasteVehicles(rt) && (await countActiveVehicles(tx, id)) > 0) {
          throw err.badRequest(
            'У этого типа заявки не может быть машин — снимите их перед сменой типа',
            { requestType: 'Сначала снимите машины' },
          );
        }
        // Выполненная заявка без единой машины означала бы вывоз без подтверждения — то же
        // требование, что и при закрытии (контейнерных операций оно не касается).
        if (
          before.status === 'done' &&
          requiresWasteVehicles(rt) &&
          (await countActiveVehicles(tx, id)) === 0
        ) {
          throw err.badRequest('У выполненной заявки должна остаться хотя бы одна машина', {
            vehicles: 'Оставьте хотя бы одну машину',
          });
        }
      });
      const after = (await getRequestDto(id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.update',
        entityType: 'waste_request',
        entityId: id,
        // Перечень изменённых полей — то, ради чего история отличает правку от «заявку трогали».
        metadata: { changes: diffWasteRequests(before, after) },
      });
      return after;
    },
  );

  // Назначение (или снятие) оператора вывоза — отдельно от общего PATCH: тот пересчитывает
  // предмет заявки целиком, а смена исполнителя касается только его и цены (ADR 0010).
  // Цена пересчитывается вместе с назначением: прайс у каждого оператора свой (ADR 0023), и
  // оставить снимок от прежнего исполнителя значило бы выставить счёт по чужому прайсу. Снятие
  // оператора возвращает цену «от» — минимальную среди операторов.
  r.patch(
    '/:id/operator',
    { ...canAssignOperator, schema: { params: idParams, body: assignWasteOperatorSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { operatorCounterpartyId, version } = req.body;
      const before = await getRequestDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      await db.transaction(async (tx) => {
        if (operatorCounterpartyId) {
          await assertOperatorAssignable(tx, operatorCounterpartyId, before.objectId);
        }
        // Заявки старше тарификации (без типа мусора и объёма) пересчёту не поддаются — у них
        // снимок цены остаётся прежним, а не обнуляется отказом.
        const pricing =
          before.wasteTypeId != null && before.volumeM3 != null
            ? await priceWasteRequest({
                requestType: before.requestType,
                wasteTypeId: before.wasteTypeId,
                volumeM3: before.volumeM3,
                operatorCounterpartyId,
              })
            : {};
        const [updated] = await tx
          .update(wasteRequests)
          .set({
            operatorCounterpartyId,
            ...pricing,
            updatedBy: p.id,
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(wasteRequests.id, before.id), eq(wasteRequests.version, version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
      });
      const after = (await getRequestDto(before.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.assign_operator',
        entityType: 'waste_request',
        entityId: before.id,
        // Имя исполнителя в истории — снимком: контрагента могут переименовать.
        metadata: { operatorCounterpartyId, changes: diffWasteRequests(before, after) },
      });
      return after;
    },
  );

  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: changeWasteRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { status, comment, vehicles, vehicleCounts, ticketFileIds, version } = req.body;
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      assertShtabScope(p, existing.objectId);
      assertOperatorScope(p, existing.operatorCounterpartyId);
      if (existing.status === status) return (await getRequestDto(existing.id))!;
      assertTransitionAllowed(existing.status, status, p.role);
      await db.transaction(async (tx) => {
        // Закрытие заявки — это предъявление факта, и оно проводится тем же запросом, что и
        // смена статуса. Талон обязателен: «Выполнена» без бумаги о вывозе — отметка о работе,
        // которую нечем подтвердить (ADR 0020). Крепится он к самой заявке у любого типа —
        // общим пулом (ADR 0024): оператор отдаёт бумаги пачкой за всё закрытие, и какая из них
        // про какую машину, из талона всё равно не следует.
        // Обязательность считается по состоянию заявки, а не по телу запроса: талон мог прийти
        // с прошлым закрытием, и требовать его второй раз значило бы просить ту же бумагу дважды.
        // Машины предъявляет один вывоз мусора: там объём заказан заявкой, а чем его увезли,
        // видно только по факту — и «Выполнена» без единой машины не проходит. При повторном
        // закрытии (после отката администратором) хватает уже заведённых, а количество в них
        // правится через `vehicleCounts`.
        if (status === 'done') {
          if (!requiresWasteVehicles(existing.requestType)) {
            if (vehicles.length > 0 || vehicleCounts.length > 0) {
              throw err.badRequest(VEHICLES_NOT_APPLICABLE, {
                vehicles: 'Машины заполняются только у вывоза мусора',
              });
            }
          } else {
            await insertVehicles(tx, existing.id, vehicles, p.id, {
              wasteTypeId: existing.wasteTypeId,
              operatorCounterpartyId: existing.operatorCounterpartyId,
            });
            await updateVehicleCounts(tx, existing.id, vehicleCounts);
            if ((await countActiveVehicles(tx, existing.id)) === 0) {
              throw err.badRequest('Укажите хотя бы одну машину', {
                vehicles: 'Добавьте машину',
              });
            }
          }
          await linkFiles(tx, existing.id, ticketFileIds, p.id, true, 'ticket');
          if ((await countRequestTickets(tx, existing.id)) === 0) {
            throw err.badRequest('Приложите талон — без него заявка не закрывается', {
              ticketFileIds: 'Приложите талон',
            });
          }
        }
        const [updated] = await tx
          .update(wasteRequests)
          .set({ status, updatedBy: p.id, version: existing.version + 1, updatedAt: new Date() })
          .where(and(eq(wasteRequests.id, existing.id), eq(wasteRequests.version, version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(requestStatusHistory).values({
          requestId: existing.id,
          fromStatus: existing.status,
          toStatus: status,
          changedBy: p.id,
          comment,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.status',
        entityType: 'waste_request',
        entityId: existing.id,
        metadata: {
          from: existing.status,
          to: status,
          comment,
          // Талоны этого закрытия — по одному числу видно, чем подтверждён вывоз (ADR 0024:
          // список общий на заявку, поэтому и число одно).
          ticketsAdded: ticketFileIds.length,
        },
      });
      return (await getRequestDto(existing.id))!;
    },
  );

  r.delete('/:id', { ...canDelete, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = req.params;
    const [existing] = await db.select().from(wasteRequests).where(eq(wasteRequests.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
    assertShtabScope(p, existing.objectId);
    assertShtabEditable(p, existing.status, 'удалять');

    if (existing.status === 'new') {
      // hard delete + физическое удаление файлов: и вложений заявки, и её талонов — с ADR 0024
      // те и другие лежат в request_files, отдельного места у талонов машин больше нет.
      await db.transaction(async (tx) => {
        const linked = await tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(requestFiles)
          .innerJoin(files, eq(requestFiles.fileId, files.id))
          .where(eq(requestFiles.requestId, id));
        // Машины уходят каскадом вместе с заявкой, но строки files каскад не трогает.
        await tx.delete(wasteRequests).where(eq(wasteRequests.id, id));
        await hardDeleteFiles(tx, linked);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.hard_delete',
        entityType: 'waste_request',
        entityId: id,
      });
      return { ok: true, mode: 'hard' };
    }

    await db
      .update(wasteRequests)
      .set({
        deletedAt: new Date(),
        deletedBy: p.id,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(wasteRequests.id, id));
    await writeAudit({
      actorUserId: p.id,
      action: 'waste_request.soft_delete',
      entityType: 'waste_request',
      entityId: id,
    });
    return { ok: true, mode: 'soft' };
  });

  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      schema: { params: idParams },
    },
    async (req) => {
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing) throw err.notFound('Заявка не найдена');
      if (existing.deletedAt) {
        await db
          .update(wasteRequests)
          .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
          .where(eq(wasteRequests.id, existing.id));
        await writeAudit({
          actorUserId: requirePrincipal(req).id,
          action: 'waste_request.restore',
          entityType: 'waste_request',
          entityId: existing.id,
        });
      }
      return (await getRequestDto(existing.id))!;
    },
  );
}
