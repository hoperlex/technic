import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type AssignVehicleInput,
  can,
  changeVehicleRequestStatusSchema,
  createVehicleRequestSchema,
  type FileDto,
  formatVehicleRequestNumber,
  isApprovalChangeable,
  isObjectScopedRole,
  isVehicleKindAllowedForRequest,
  REQUEST_STATUSES,
  requestStatusLabels,
  setVehicleRequestApprovalSchema,
  transitionRequiresApproval,
  transitionRequiresAssignment,
  updateVehicleRequestSchema,
  type VehicleRequestAssignmentDto,
  type VehicleRequestDto,
  type VehicleRequestSummaryDto,
  type VehicleRequestType,
  vehicleRequestListQuerySchema,
  vehicleRequestSummaryQuerySchema,
  vehicleStatusLabels,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  files,
  freightTransportRequestDetails,
  specialEquipmentRequestDetails,
  users,
  vehicleCategories,
  vehicleKinds,
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequestFiles,
  vehicleRequests,
  vehicleRequestStatusHistory,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import {
  assertArchiveVisible,
  assertObjectRoleEditable,
  assertObjectScope,
  assertTransitionAllowed,
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
import { diffVehicleAssignment, diffVehicleRequests } from '../services/vehicle-request-diff';
import { loadVehicleRequestHistory } from '../services/vehicle-request-history';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

/** Завизировавший — второй join на ту же таблицу учёток (первый отдаёт автора заявки). */
const approvers = alias(users, 'approvers');
/** Назначивший технику — третий join на учётки (ADR 0027). */
const assigners = alias(users, 'assigners');
/** Арендодатель назначенной машины; у собственной техники его нет. */
const lessors = alias(counterparties, 'lessors');

const requestSelect = {
  id: vehicleRequests.id,
  num: vehicleRequests.num,
  requestType: vehicleRequests.requestType,
  objectId: vehicleRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  // Плоская модель (ADR 0005): тип ТС — напрямую vehicle_type_id.
  vehicleTypeId: vehicleRequests.vehicleTypeId,
  vehicleTypeName: vehicleTypes.name,
  status: vehicleRequests.status,
  comment: vehicleRequests.comment,
  // Причина отмены живёт в истории статусов; актуальна последняя и только у отменённых заявок.
  cancelReason: sql<string | null>`
    CASE WHEN ${vehicleRequests.status} = 'cancelled' THEN (
      SELECT h.comment
      FROM ${vehicleRequestStatusHistory} h
      WHERE h.vehicle_request_id = ${vehicleRequests.id} AND h.to_status = 'cancelled'
      ORDER BY h.changed_at DESC
      LIMIT 1
    ) END`.as('cancel_reason'),
  // Виза руководителя строительства (ADR 0025): пусто — заявка ждёт согласования.
  approvedBy: vehicleRequests.approvedBy,
  approvedByName: approvers.fullName,
  approvedAt: vehicleRequests.approvedAt,
  // Назначенная техника (ADR 0027): ставки — снимок из назначения, реквизиты машины — join'ом.
  assignmentVehicleId: vehicleRequestAssignments.vehicleId,
  assignmentOwnership: vehicles.ownership,
  assignmentCategoryName: vehicleCategories.name,
  assignmentModelName: vehicleModels.name,
  assignmentRegistrationNumber: vehicles.registrationNumber,
  assignmentDescription: vehicles.description,
  assignmentLessorId: vehicles.lessorId,
  assignmentLessorName: lessors.name,
  assignmentPricePerHour: vehicleRequestAssignments.pricePerHour,
  assignmentPricePerShift: vehicleRequestAssignments.pricePerShift,
  assignmentShiftHours: vehicleRequestAssignments.shiftHours,
  assignedBy: vehicleRequestAssignments.assignedBy,
  assignedByName: assigners.fullName,
  assignedAt: vehicleRequestAssignments.assignedAt,
  version: vehicleRequests.version,
  createdBy: vehicleRequests.createdBy,
  createdByName: users.fullName,
  createdAt: vehicleRequests.createdAt,
  updatedAt: vehicleRequests.updatedAt,
  deletedAt: vehicleRequests.deletedAt,
  dateFrom: specialEquipmentRequestDetails.dateFrom,
  dateTo: specialEquipmentRequestDetails.dateTo,
  scheduledAt: freightTransportRequestDetails.scheduledAt,
  scheduledTimeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
  volumeM3: freightTransportRequestDetails.volumeM3,
  weightTons: freightTransportRequestDetails.weightTons,
  loadingLocation: freightTransportRequestDetails.loadingLocation,
  unloadingLocation: freightTransportRequestDetails.unloadingLocation,
  loadingAddress: freightTransportRequestDetails.loadingAddress,
  unloadingAddress: freightTransportRequestDetails.unloadingAddress,
};

function baseQuery() {
  return db
    .select(requestSelect)
    .from(vehicleRequests)
    .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
    .innerJoin(vehicleTypes, eq(vehicleRequests.vehicleTypeId, vehicleTypes.id))
    .innerJoin(users, eq(vehicleRequests.createdBy, users.id))
    .leftJoin(approvers, eq(vehicleRequests.approvedBy, approvers.id))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
    )
    .leftJoin(
      freightTransportRequestDetails,
      eq(vehicleRequests.id, freightTransportRequestDetails.requestId),
    )
    // Назначенная техника (ADR 0027). Её нет у «Новой» заявки, поэтому вся ветка — leftJoin;
    // марка/модель, категория и арендодатель необязательны и у самой машины.
    .leftJoin(vehicleRequestAssignments, eq(vehicleRequests.id, vehicleRequestAssignments.requestId))
    .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
    .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
    .leftJoin(lessors, eq(vehicles.lessorId, lessors.id))
    .leftJoin(assigners, eq(vehicleRequestAssignments.assignedBy, assigners.id));
}

type RequestRow = Awaited<ReturnType<typeof baseQuery>>[number];

/** numeric из pg приходит строкой — приводим к числу с проверкой конечности. */
function toNum(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** number → строка для колонки numeric. */
function numToDb(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

async function filesByRequestIds(ids: string[]): Promise<Map<string, FileDto[]>> {
  const map = new Map<string, FileDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: vehicleRequestFiles.vehicleRequestId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      status: files.status,
      createdAt: files.createdAt,
    })
    .from(vehicleRequestFiles)
    .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
    .where(and(inArray(vehicleRequestFiles.vehicleRequestId, ids), eq(files.status, 'active')));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * Назначенная техника из строки выборки (ADR 0027); null — заявку в работу не брали. Тип ТС у
 * машины и у заявки один — это держит составной FK, поэтому в DTO уходит имя типа заявки.
 */
function toAssignmentDto(r: RequestRow): VehicleRequestAssignmentDto | null {
  if (!r.assignmentVehicleId || !r.assignmentOwnership || !r.assignedBy || !r.assignedAt) {
    return null;
  }
  return {
    vehicleId: r.assignmentVehicleId,
    ownership: r.assignmentOwnership,
    typeName: r.vehicleTypeName,
    categoryName: r.assignmentCategoryName,
    modelName: r.assignmentModelName,
    registrationNumber: r.assignmentRegistrationNumber,
    description: r.assignmentDescription ?? '',
    lessorId: r.assignmentLessorId,
    lessorName: r.assignmentLessorName,
    pricePerHour: toNum(r.assignmentPricePerHour),
    pricePerShift: toNum(r.assignmentPricePerShift),
    shiftHours: r.assignmentShiftHours,
    assignedBy: r.assignedBy,
    assignedByName: r.assignedByName ?? '',
    assignedAt: r.assignedAt.toISOString(),
  };
}

function toDto(r: RequestRow, fileList: FileDto[]): VehicleRequestDto {
  const base = {
    id: r.id,
    num: r.num,
    displayNumber: formatVehicleRequestNumber(r.num),
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    vehicleTypeId: r.vehicleTypeId,
    vehicleTypeName: r.vehicleTypeName,
    status: r.status,
    comment: r.comment,
    cancelReason: r.cancelReason || null,
    approvedBy: r.approvedBy,
    approvedByName: r.approvedByName,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    assignment: toAssignmentDto(r),
    files: fileList,
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
  if (r.requestType === 'special_equipment') {
    return {
      ...base,
      requestType: 'special_equipment',
      dateFrom: r.dateFrom ?? '',
      dateTo: r.dateTo ?? null,
    };
  }
  return {
    ...base,
    requestType: 'freight_transport',
    scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : '',
    scheduledTimeUnspecified: r.scheduledTimeUnspecified ?? false,
    volumeM3: toNum(r.volumeM3),
    weightTons: toNum(r.weightTons),
    loadingLocation: r.loadingLocation ?? '',
    unloadingLocation: r.unloadingLocation ?? '',
    loadingAddress: r.loadingAddress ?? null,
    unloadingAddress: r.unloadingAddress ?? null,
  };
}

async function getDto(id: string): Promise<VehicleRequestDto | null> {
  const [row] = await baseQuery().where(eq(vehicleRequests.id, id));
  if (!row) return null;
  const filesMap = await filesByRequestIds([id]);
  return toDto(row, filesMap.get(id) ?? []);
}

/**
 * Может ли учётка визировать заявку этого объекта (ADR 0025): право визы плюс область —
 * руководитель строительства отвечает за свой объект. Предикат, а не проверка с отказом: тем же
 * правилом решается, ставить ли визу сразу при создании заявки её же автором.
 */
function canApproveForObject(p: Principal, objectId: string): boolean {
  if (!can(p.role, 'vehicleRequests.approve')) return false;
  return !isObjectScopedRole(p.role) || p.constructionObjectId === objectId;
}

async function assertObjectActive(tx: Tx, objectId: string): Promise<void> {
  const [o] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!o) throw err.badRequest('Объект не найден');
  if (!o.isActive) throw err.badRequest('Объект неактивен');
}

/**
 * Плоская модель (ADR 0005): выбран активный тип ТС активного вида, разрешённого этому типу
 * заявки. Иначе — отказ. Тип заявки задаётся в форме явно: на объект заказывают технику любого
 * вида, грузоперевозку — только грузовым (`isVehicleKindAllowedForRequest`).
 */
async function resolveVehicleType(
  tx: Tx,
  typeId: string,
  requestType: VehicleRequestType,
): Promise<void> {
  const [row] = await tx
    .select({
      isActive: vehicleTypes.isActive,
      kindCode: vehicleKinds.code,
      kindActive: vehicleKinds.isActive,
    })
    .from(vehicleTypes)
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .where(eq(vehicleTypes.id, typeId));
  if (!row) throw err.badRequest('Тип ТС не найден');
  if (!row.isActive) throw err.badRequest('Тип ТС неактивен');
  if (!row.kindActive) throw err.badRequest('Вид ТС неактивен');
  if (!isVehicleKindAllowedForRequest(requestType, row.kindCode)) {
    throw err.unprocessable('Грузоперевозку выполняет только грузовая техника');
  }
}

/**
 * Машина, которой берут заявку в работу (ADR 0027). Проверяется всё, чего не видит БД: живая ли
 * запись, годна ли машина к работе и есть ли ставка там, где без неё нельзя. Совпадение типа ТС
 * держит составной FK, но сверяется и здесь — иначе вместо понятного отказа человек получил бы
 * ошибку целостности.
 *
 * Возвращает DTO назначения «как будет после записи»: им же пишется история.
 */
async function resolveAssignment(
  tx: Tx,
  request: { vehicleTypeId: string; vehicleTypeName: string },
  input: AssignVehicleInput,
  actor: { id: string; name: string },
): Promise<VehicleRequestAssignmentDto> {
  const [row] = await tx
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      vehicleTypeId: vehicles.vehicleTypeId,
      status: vehicles.status,
      deletedAt: vehicles.deletedAt,
      registrationNumber: vehicles.registrationNumber,
      description: vehicles.description,
      categoryName: vehicleCategories.name,
      modelName: vehicleModels.name,
      lessorId: vehicles.lessorId,
      lessorName: counterparties.name,
    })
    .from(vehicles)
    .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
    .leftJoin(counterparties, eq(vehicles.lessorId, counterparties.id))
    .where(eq(vehicles.id, input.vehicleId));
  if (!row || row.deletedAt) throw err.badRequest('Техника не найдена');
  if (row.vehicleTypeId !== request.vehicleTypeId) {
    throw err.unprocessable(`Заявка заказана на тип ТС «${request.vehicleTypeName}»`, {
      vehicleId: 'Техника другого типа',
    });
  }
  // «Обслуживание», «Списана» и выключенное предложение аренды к работе не годятся: заявка
  // взята в работу означает, что машина выйдет.
  if (row.status !== 'active') {
    throw err.unprocessable(
      `Техника недоступна: ${vehicleStatusLabels[row.status].toLowerCase()}`,
      { vehicleId: 'Техника недоступна' },
    );
  }
  // Аренда — это счёт от контрагента: заявка в работе без ставки означала бы, что цену
  // выяснят потом. У собственной машины ставки может не быть вовсе.
  if (row.ownership === 'rental' && input.pricePerHour == null && input.pricePerShift == null) {
    throw err.badRequest('Укажите стоимость аренды — за час или за смену', {
      pricePerHour: 'Укажите стоимость',
    });
  }
  return {
    vehicleId: row.id,
    ownership: row.ownership,
    typeName: request.vehicleTypeName,
    categoryName: row.categoryName,
    modelName: row.modelName,
    registrationNumber: row.registrationNumber,
    description: row.description,
    lessorId: row.lessorId,
    lessorName: row.lessorName,
    pricePerHour: input.pricePerHour ?? null,
    pricePerShift: input.pricePerShift ?? null,
    shiftHours: input.shiftHours ?? null,
    assignedBy: actor.id,
    assignedByName: actor.name,
    assignedAt: new Date().toISOString(),
  };
}

/**
 * Назначение заявки: одна строка на заявку, повторный перевод в работу (после отката) её
 * переписывает — вторая машина в заявке одного типа и одного срока не появляется.
 */
async function saveAssignment(
  tx: Tx,
  requestId: string,
  vehicleTypeId: string,
  a: VehicleRequestAssignmentDto,
): Promise<void> {
  const values = {
    vehicleId: a.vehicleId,
    vehicleTypeId,
    pricePerHour: numToDb(a.pricePerHour),
    pricePerShift: numToDb(a.pricePerShift),
    shiftHours: a.shiftHours,
    assignedBy: a.assignedBy,
  };
  await tx
    .insert(vehicleRequestAssignments)
    .values({ requestId, ...values })
    .onConflictDoUpdate({
      target: vehicleRequestAssignments.requestId,
      set: { ...values, assignedAt: new Date(), updatedAt: new Date() },
    });
}

async function attachFiles(
  tx: Tx,
  vehicleRequestId: string,
  fileIds: string[],
  uploaderId: string,
  enforceTotal = false,
): Promise<void> {
  if (fileIds.length === 0) return;
  await assertFilesAttachable(tx, fileIds, uploaderId);
  if (enforceTotal) {
    const [c] = await tx
      .select({ c: count() })
      .from(vehicleRequestFiles)
      .where(eq(vehicleRequestFiles.vehicleRequestId, vehicleRequestId));
    assertTotalWithinLimit(Number(c!.c), fileIds.length);
  }
  await tx
    .insert(vehicleRequestFiles)
    .values(fileIds.map((fileId) => ({ vehicleRequestId, fileId })));
  await markFilesActive(tx, fileIds);
}

async function detachFiles(tx: Tx, vehicleRequestId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(vehicleRequestFiles)
    .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
    .where(
      and(
        eq(vehicleRequestFiles.vehicleRequestId, vehicleRequestId),
        inArray(vehicleRequestFiles.fileId, fileIds),
      ),
    );
  if (linked.length === 0) return;
  const ids = linked.map((l) => l.id);
  await tx
    .delete(vehicleRequestFiles)
    .where(
      and(
        eq(vehicleRequestFiles.vehicleRequestId, vehicleRequestId),
        inArray(vehicleRequestFiles.fileId, ids),
      ),
    );
  await scheduleFilesDeletion(tx, linked, false);
}

/**
 * Меняет ли правка суть заявки — то, что согласовывали (ADR 0025). Комментарий и вложения визу
 * не трогают: ими уточняют уже согласованное. Сравнение с прежними значениями обязательно —
 * форма присылает поля целиком, и «сохранить без изменений» иначе снимало бы визу.
 */
function editChangesSubstance(
  before: VehicleRequestDto,
  body: z.infer<typeof updateVehicleRequestSchema>,
): boolean {
  const changed = (next: unknown, prev: unknown): boolean => next !== undefined && next !== prev;
  if (changed(body.objectId, before.objectId)) return true;
  if (changed(body.vehicleTypeId, before.vehicleTypeId)) return true;
  if (before.requestType === 'special_equipment' && body.requestType === 'special_equipment') {
    return changed(body.dateFrom, before.dateFrom) || changed(body.dateTo, before.dateTo);
  }
  if (before.requestType === 'freight_transport' && body.requestType === 'freight_transport') {
    const scheduledChanged =
      body.scheduledAt !== undefined &&
      new Date(body.scheduledAt).getTime() !== new Date(before.scheduledAt).getTime();
    return (
      scheduledChanged ||
      changed(body.scheduledTimeUnspecified, before.scheduledTimeUnspecified) ||
      changed(body.volumeM3, before.volumeM3) ||
      changed(body.weightTons, before.weightTons) ||
      changed(body.loadingLocation, before.loadingLocation) ||
      changed(body.unloadingLocation, before.unloadingLocation)
    );
  }
  return false;
}

/** Фильтр по визе (ADR 0025): «нет» — заявки, ждущие согласования. */
function approvedFilter(approved: boolean | undefined): SQL | undefined {
  if (approved === undefined) return undefined;
  return approved ? isNotNull(vehicleRequests.approvedAt) : isNull(vehicleRequests.approvedAt);
}

/** Спецтехника: пересечение периодов. */
function specialDateConds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  const conds: (SQL | undefined)[] = [];
  if (dateTo) conds.push(sql`${specialEquipmentRequestDetails.dateFrom} <= ${dateTo}::date`);
  if (dateFrom) {
    conds.push(
      sql`coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom}) >= ${dateFrom}::date`,
    );
  }
  return conds;
}

/** Грузоперевозка: день в Europe/Moscow. */
function freightDateConds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  const conds: (SQL | undefined)[] = [];
  if (dateFrom) {
    conds.push(
      gte(freightTransportRequestDetails.scheduledAt, new Date(`${dateFrom}T00:00:00.000+03:00`)),
    );
  }
  if (dateTo) {
    conds.push(
      lte(freightTransportRequestDetails.scheduledAt, new Date(`${dateTo}T23:59:59.999+03:00`)),
    );
  }
  return conds;
}

/**
 * Календарный диапазон (YYYY-MM-DD). Тип задан — правило своего типа; тип не задан
 * (единый список «Заказ автотехники») — строка проходит, если попадает в диапазон по
 * своему типу: OR двух правил, каждое отсекает чужие строки по NULL в detail-колонках.
 */
function dateFilters(
  requestType: VehicleRequestType | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  if (!dateFrom && !dateTo) return [];
  if (requestType === 'special_equipment') return specialDateConds(dateFrom, dateTo);
  if (requestType === 'freight_transport') return freightDateConds(dateFrom, dateTo);
  return [
    or(and(...specialDateConds(dateFrom, dateTo)), and(...freightDateConds(dateFrom, dateTo))),
  ];
}

export default async function vehicleRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Право на каждое действие отдельно (ADR 0021): модуль «Заказ ТС» оператору вывоза недоступен
  // целиком (ADR 0010), а штаб заводит и правит заявки, но не ведёт их статусы.
  const auth = { preHandler: [app.authenticate, app.requirePermission('vehicleRequests.read')] };
  const canCreate = {
    preHandler: [app.authenticate, app.requirePermission('vehicleRequests.create')],
  };
  const canUpdate = {
    preHandler: [app.authenticate, app.requirePermission('vehicleRequests.update')],
  };
  const canDelete = {
    preHandler: [app.authenticate, app.requirePermission('vehicleRequests.delete')],
  };
  const canChangeStatus = {
    preHandler: [
      app.authenticate,
      app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
    ],
  };
  const canApprove = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'vehicleRequests.approve',
        'Визировать заявки может руководитель строительства',
      ),
    ],
  };

  // ── Список (единый по обоим типам; requestType — необязательное сужение) ──
  r.get('/', { ...auth, schema: { querystring: vehicleRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const showDeleted = q.includeDeleted && can(p.role, 'archive.read');
    const where = and(
      q.requestType ? eq(vehicleRequests.requestType, q.requestType) : undefined,
      showDeleted ? undefined : isNull(vehicleRequests.deletedAt),
      requestVisibilityWhere(p, vehicleRequests.objectId),
      q.status ? eq(vehicleRequests.status, q.status) : undefined,
      q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
      q.vehicleTypeId ? eq(vehicleRequests.vehicleTypeId, q.vehicleTypeId) : undefined,
      q.num ? eq(vehicleRequests.num, q.num) : undefined,
      approvedFilter(q.approved),
      ...dateFilters(q.requestType, q.dateFrom, q.dateTo),
      searchCondition(q.search, [
        vehicleRequests.comment,
        constructionObjects.name,
        constructionObjects.code,
      ]),
    );
    // Сортировка во всех столбцах. «Срок» и «объём/масса» у типов заявки лежат в разных
    // detail-таблицах, поэтому сводятся coalesce: у строки заполнена ровно одна из колонок.
    // Объём и масса — разные единицы, но в одном столбце: сортируем по тому, что указано.
    const sortCols = {
      num: vehicleRequests.num,
      requestType: vehicleRequests.requestType,
      objectName: constructionObjects.name,
      createdByName: users.fullName,
      vehicleTypeName: vehicleTypes.name,
      term: sql`coalesce(${freightTransportRequestDetails.scheduledAt}, ${specialEquipmentRequestDetails.dateFrom}::timestamptz)`,
      amount: sql`coalesce(${freightTransportRequestDetails.volumeM3}, ${freightTransportRequestDetails.weightTons})`,
      loadingLocation: freightTransportRequestDetails.loadingLocation,
      unloadingLocation: freightTransportRequestDetails.unloadingLocation,
      status: vehicleRequests.status,
      approval: vehicleRequests.approvedAt,
      comment: vehicleRequests.comment,
      createdAt: vehicleRequests.createdAt,
    };
    const pg = pageParams(q);
    const rows = await baseQuery()
      .where(where)
      .orderBy(
        orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'),
        asc(vehicleRequests.num),
        asc(vehicleRequests.id),
      )
      .limit(pg.limit)
      .offset(pg.offset);
    const [totalRow] = await db
      .select({ c: count() })
      .from(vehicleRequests)
      .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
      .leftJoin(
        specialEquipmentRequestDetails,
        eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
      )
      .leftJoin(
        freightTransportRequestDetails,
        eq(vehicleRequests.id, freightTransportRequestDetails.requestId),
      )
      .where(where);
    const filesMap = await filesByRequestIds(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toDto(row, filesMap.get(row.id) ?? [])),
      total: Number(totalRow!.c),
      page: pg.page,
      pageSize: pg.pageSize,
    };
  });

  /**
   * Сводка «сколько заявок в каком статусе» для виджета над таблицей. Считается по тем же
   * правилам видимости, что и список: штаб видит только свой объект. Удалённые в счёт не идут —
   * в списке их тоже нет (админский includeDeleted сводку не расширяет).
   */
  r.get(
    '/summary',
    { ...auth, schema: { querystring: vehicleRequestSummaryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const where = and(
        isNull(vehicleRequests.deletedAt),
        requestVisibilityWhere(p, vehicleRequests.objectId),
        req.query.objectId ? eq(vehicleRequests.objectId, req.query.objectId) : undefined,
        req.query.requestType ? eq(vehicleRequests.requestType, req.query.requestType) : undefined,
      );
      const rows = await db
        .select({
          status: vehicleRequests.status,
          c: count(),
          // «Ждёт визы» — про новые заявки: дальше «Новой» незавизированная не уходит, а виза
          // у взятой в работу уже не снимается (ADR 0025).
          awaiting: sql<number>`count(*) FILTER (WHERE ${vehicleRequests.approvedAt} IS NULL)`,
        })
        .from(vehicleRequests)
        .where(where)
        .groupBy(vehicleRequests.status);
      const summary = {
        ...(Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<
          (typeof REQUEST_STATUSES)[number],
          number
        >),
        awaitingApproval: 0,
      };
      for (const row of rows) {
        summary[row.status] = Number(row.c);
        if (row.status === 'new') summary.awaitingApproval = Number(row.awaiting);
      }
      return summary satisfies VehicleRequestSummaryDto;
    },
  );

  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const dto = await getDto(req.params.id);
    if (!dto) throw err.notFound('Заявка не найдена');
    assertArchiveVisible(p, dto.deletedAt, 'Заявка не найдена');
    assertObjectScope(p, dto.objectId);
    return dto;
  });

  // История заявки: создание, правки, смены статусов (ADR 0015). Доступна тем же, кто видит саму
  // заявку — отдельного права на неё нет: это те же события, что и в карточке, только по времени.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [row] = await db
      .select({
        id: vehicleRequests.id,
        objectId: vehicleRequests.objectId,
        deletedAt: vehicleRequests.deletedAt,
        createdAt: vehicleRequests.createdAt,
        createdBy: vehicleRequests.createdBy,
        createdByName: users.fullName,
      })
      .from(vehicleRequests)
      .innerJoin(users, eq(vehicleRequests.createdBy, users.id))
      .where(eq(vehicleRequests.id, req.params.id));
    if (!row) throw err.notFound('Заявка не найдена');
    // Архивная заявка видна только тем, кому открыт архив, — как и сама карточка (GET /:id).
    assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
    assertObjectScope(p, row.objectId);
    return loadVehicleRequestHistory(row.id, {
      at: row.createdAt,
      actorId: row.createdBy,
      actorName: row.createdByName,
    });
  });

  // ── Создание ──
  r.post(
    '/',
    { ...canCreate, schema: { body: createVehicleRequestSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertObjectScope(p, body.objectId);
      // Заявку завёл тот, кто её и визирует, — согласование уже состоялось (ADR 0025). Просить
      // руководителя строительства завизировать собственную заявку отдельным действием незачем.
      const selfApproved = canApproveForObject(p, body.objectId);
      const approvedAt = new Date();

      const createdId = await db.transaction(async (tx) => {
        await assertObjectActive(tx, body.objectId);
        await resolveVehicleType(tx, body.vehicleTypeId, body.requestType);
        const [row] = await tx
          .insert(vehicleRequests)
          .values({
            requestType: body.requestType,
            objectId: body.objectId,
            vehicleTypeId: body.vehicleTypeId,
            status: 'new',
            comment: body.comment,
            createdBy: p.id,
            approvedBy: selfApproved ? p.id : null,
            approvedAt: selfApproved ? approvedAt : null,
          })
          .returning({ id: vehicleRequests.id });
        const id = row!.id;
        if (body.requestType === 'special_equipment') {
          await tx.insert(specialEquipmentRequestDetails).values({
            requestId: id,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo ?? null,
          });
        } else {
          await tx.insert(freightTransportRequestDetails).values({
            requestId: id,
            scheduledAt: new Date(body.scheduledAt),
            scheduledTimeUnspecified: body.scheduledTimeUnspecified,
            volumeM3: numToDb(body.volumeM3),
            weightTons: numToDb(body.weightTons),
            loadingLocation: body.loadingLocation,
            unloadingLocation: body.unloadingLocation,
            loadingAddress: body.loadingAddress ?? null,
            unloadingAddress: body.unloadingAddress ?? null,
          });
        }
        await tx.insert(vehicleRequestStatusHistory).values({
          vehicleRequestId: id,
          fromStatus: null,
          toStatus: 'new',
          changedBy: p.id,
        });
        await attachFiles(tx, id, body.fileIds, p.id);
        return id;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.create',
        entityType: 'vehicle_request',
        entityId: createdId,
        metadata: {
          requestType: body.requestType,
          objectId: body.objectId,
          vehicleTypeId: body.vehicleTypeId,
        },
      });
      // Автоматическая виза — тоже виза: в истории заявки она должна быть видна событием, иначе
      // «кто согласовал» отвечается только текущим значением поля.
      if (selfApproved) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.approve',
          entityType: 'vehicle_request',
          entityId: createdId,
          metadata: { auto: true },
        });
      }
      reply.code(201);
      return (await getDto(createdId))!;
    },
  );

  // ── Обновление ──
  r.patch(
    '/:id',
    { ...canUpdate, schema: { params: idParams, body: updateVehicleRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      // Состояние «до» берётся сразу как DTO: по нему не только проверки, но и дифф для
      // истории — названия справочников там уже собраны (см. vehicle-request-history).
      const before = await getDto(id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      if (before.requestType !== body.requestType) {
        throw err.unprocessable('Тип заявки изменить нельзя');
      }
      assertObjectScope(p, before.objectId);
      assertObjectRoleEditable(p, before.status, 'редактировать');

      const objectId = body.objectId ?? before.objectId;
      const nextTypeId = body.vehicleTypeId ?? before.vehicleTypeId;
      // Согласовано было то, что руководитель строительства видел: переписанную по существу
      // заявку он визирует заново (ADR 0025). Правка самим визирующим визу не снимает — он и
      // подтверждает изменение самим фактом правки.
      const dropApproval =
        !!before.approvedAt &&
        !canApproveForObject(p, objectId) &&
        editChangesSubstance(before, body);

      await db.transaction(async (tx) => {
        if (body.objectId && body.objectId !== before.objectId) {
          assertObjectScope(p, body.objectId);
          await assertObjectActive(tx, body.objectId);
        }
        if (body.vehicleTypeId && body.vehicleTypeId !== before.vehicleTypeId) {
          await resolveVehicleType(tx, body.vehicleTypeId, before.requestType);
          // На заявке уже стоит машина заказанного типа (ADR 0027) — сменить тип означало бы
          // оставить назначение без основания. То же держит составной FK, но человеку нужен
          // ответ, а не ошибка целостности.
          if (before.assignment) {
            throw err.unprocessable(
              'На заявку назначена техника — сменить тип ТС можно, только отменив заявку',
              { vehicleTypeId: 'Назначена техника' },
            );
          }
        }

        const [updated] = await tx
          .update(vehicleRequests)
          .set({
            objectId,
            vehicleTypeId: nextTypeId,
            comment: body.comment ?? before.comment,
            ...(dropApproval ? { approvedBy: null, approvedAt: null } : {}),
            updatedBy: p.id,
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(vehicleRequests.id, id), eq(vehicleRequests.version, body.version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();

        if (body.requestType === 'special_equipment') {
          const [ex] = await tx
            .select()
            .from(specialEquipmentRequestDetails)
            .where(eq(specialEquipmentRequestDetails.requestId, id));
          const dateFrom = body.dateFrom ?? ex!.dateFrom;
          const dateTo = body.dateTo !== undefined ? body.dateTo : ex!.dateTo;
          if (dateTo && dateTo < dateFrom) {
            throw err.badRequest('Дата окончания раньше даты начала');
          }
          await tx
            .update(specialEquipmentRequestDetails)
            .set({ dateFrom, dateTo })
            .where(eq(specialEquipmentRequestDetails.requestId, id));
        } else {
          const [ex] = await tx
            .select()
            .from(freightTransportRequestDetails)
            .where(eq(freightTransportRequestDetails.requestId, id));
          const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : ex!.scheduledAt;
          const volumeM3 = body.volumeM3 !== undefined ? numToDb(body.volumeM3) : ex!.volumeM3;
          const weightTons =
            body.weightTons !== undefined ? numToDb(body.weightTons) : ex!.weightTons;
          if (volumeM3 == null && weightTons == null) {
            throw err.badRequest('Укажите объём или массу');
          }
          await tx
            .update(freightTransportRequestDetails)
            .set({
              scheduledAt,
              // Признак меняется только вместе с датой — иначе остаётся прежним.
              scheduledTimeUnspecified: body.scheduledAt
                ? (body.scheduledTimeUnspecified ?? false)
                : ex!.scheduledTimeUnspecified,
              volumeM3,
              weightTons,
              loadingLocation: body.loadingLocation ?? ex!.loadingLocation,
              unloadingLocation: body.unloadingLocation ?? ex!.unloadingLocation,
              // Метаданные адреса шлются вместе со строкой; null явно сбрасывает верификацию.
              loadingAddress:
                body.loadingAddress !== undefined ? body.loadingAddress : ex!.loadingAddress,
              unloadingAddress:
                body.unloadingAddress !== undefined ? body.unloadingAddress : ex!.unloadingAddress,
            })
            .where(eq(freightTransportRequestDetails.requestId, id));
        }

        if (body.removeFileIds?.length) await detachFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) await attachFiles(tx, id, body.addFileIds, p.id, true);
      });

      const after = (await getDto(id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.update',
        entityType: 'vehicle_request',
        entityId: id,
        // Перечень изменённых полей — то, ради чего история отличает правку от «заявку трогали».
        metadata: { changes: diffVehicleRequests(before, after) },
      });
      // Снятую правкой визу показываем отдельным событием: иначе заявка молча перестаёт
      // годиться в работу, и по истории непонятно, почему.
      if (dropApproval) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.approval_revoke',
          entityType: 'vehicle_request',
          entityId: id,
          metadata: { reason: 'edited' },
        });
      }
      return after;
    },
  );

  // ── Смена статуса ──
  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: changeVehicleRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { status, comment, assignment, version } = req.body;
      // Состояние «до» берётся DTO: при переводе в работу нужна не только сама заявка, но и
      // назначенная прежде техника — по ней считается, что изменилось (повторный перевод после
      // отката может сменить и машину, и ставки).
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      if (before.status === status) return before;
      assertTransitionAllowed(before.status, status, p.role);
      // Без визы заявка не обрабатывается (ADR 0025): в работу её не берут, пока руководитель
      // строительства не согласовал. Отменить незавизированную заявку можно — ей так и закрывают
      // путь. 422, а не 403: право на переход есть, не хватает состояния самой заявки.
      if (transitionRequiresApproval(status) && !before.approvedAt) {
        throw err.unprocessable(
          'Заявку не завизировал руководитель строительства — взять её в работу нельзя',
        );
      }
      // Заявку берут в работу конкретной машиной (ADR 0027). При повторном переводе (после
      // отката администратором) хватает уже назначенной: перевыбирать то же самое незачем.
      if (transitionRequiresAssignment(status) && !assignment && !before.assignment) {
        throw err.unprocessable('Выберите технику — в работу заявку берут конкретной машиной', {
          assignment: 'Выберите технику',
        });
      }

      // Назначение проверяется и пишется в той же транзакции, что и статус: заявка не должна
      // побыть «в работе» ни на чём, даже мгновение.
      const assigned = await db.transaction(async (tx) => {
        let saved: VehicleRequestAssignmentDto | null = null;
        if (assignment) {
          saved = await resolveAssignment(
            tx,
            { vehicleTypeId: before.vehicleTypeId, vehicleTypeName: before.vehicleTypeName },
            assignment,
            { id: p.id, name: p.fullName },
          );
          await saveAssignment(tx, before.id, before.vehicleTypeId, saved);
        }
        const [updated] = await tx
          .update(vehicleRequests)
          .set({ status, updatedBy: p.id, version: before.version + 1, updatedAt: new Date() })
          .where(and(eq(vehicleRequests.id, before.id), eq(vehicleRequests.version, version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(vehicleRequestStatusHistory).values({
          vehicleRequestId: before.id,
          fromStatus: before.status,
          toStatus: status,
          changedBy: p.id,
          comment,
        });
        return saved;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.status',
        entityType: 'vehicle_request',
        entityId: before.id,
        metadata: { from: before.status, to: status, comment },
      });
      // Назначение — отдельное событие истории: «в работе» и «на такой-то машине по такой-то
      // ставке» отвечают на разные вопросы, и второе нужно предъявлять с составом изменений.
      if (assigned) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.assign',
          entityType: 'vehicle_request',
          entityId: before.id,
          metadata: {
            vehicleId: assigned.vehicleId,
            changes: diffVehicleAssignment(before.assignment, assigned),
          },
        });
      }
      return (await getDto(before.id))!;
    },
  );

  // ── Виза руководителя строительства (ADR 0025) ──
  // Постановка и отзыв — одним маршрутом: у них одно право, одна область и один инвариант
  // «пока заявка «Новая»». Отдельные маршруты разошлись бы в проверках при первой же правке.
  r.patch(
    '/:id/approval',
    { ...canApprove, schema: { params: idParams, body: setVehicleRequestApprovalSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { approved, version } = req.body;
      const [existing] = await db
        .select()
        .from(vehicleRequests)
        .where(eq(vehicleRequests.id, req.params.id));
      if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
      // Право на маршруте общее, а визирует руководитель своего объекта: чужую заявку он не
      // согласовывает, даже видя её.
      assertObjectScope(p, existing.objectId);

      const isApproved = existing.approvedAt !== null;
      if (isApproved === approved) return (await getDto(existing.id))!;
      if (!isApprovalChangeable(existing.status)) {
        throw err.unprocessable(
          `Визу ставят и снимают, пока заявка в статусе «${requestStatusLabels.new}»`,
        );
      }

      const [updated] = await db
        .update(vehicleRequests)
        .set({
          approvedBy: approved ? p.id : null,
          approvedAt: approved ? new Date() : null,
          updatedBy: p.id,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(vehicleRequests.id, existing.id), eq(vehicleRequests.version, version)))
        .returning({ id: vehicleRequests.id });
      if (!updated) throw err.conflict();

      await writeAudit({
        actorUserId: p.id,
        action: approved ? 'vehicle_request.approve' : 'vehicle_request.approval_revoke',
        entityType: 'vehicle_request',
        entityId: existing.id,
      });
      return (await getDto(existing.id))!;
    },
  );

  // ── Удаление (hard для «Новая», иначе soft) ──
  r.delete('/:id', { ...canDelete, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = req.params;
    const [existing] = await db.select().from(vehicleRequests).where(eq(vehicleRequests.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
    assertObjectScope(p, existing.objectId);
    assertObjectRoleEditable(p, existing.status, 'удалять');

    if (existing.status === 'new') {
      await db.transaction(async (tx) => {
        const linked = await tx
          .select({ id: files.id, objectKey: files.objectKey })
          .from(vehicleRequestFiles)
          .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
          .where(eq(vehicleRequestFiles.vehicleRequestId, id));
        // Детали, файловые связи и история удаляются каскадом (onDelete cascade).
        await tx.delete(vehicleRequests).where(eq(vehicleRequests.id, id));
        await hardDeleteFiles(tx, linked);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.hard_delete',
        entityType: 'vehicle_request',
        entityId: id,
      });
      return { ok: true, mode: 'hard' };
    }

    await db
      .update(vehicleRequests)
      .set({
        deletedAt: new Date(),
        deletedBy: p.id,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(vehicleRequests.id, id));
    await writeAudit({
      actorUserId: p.id,
      action: 'vehicle_request.soft_delete',
      entityType: 'vehicle_request',
      entityId: id,
    });
    return { ok: true, mode: 'soft' };
  });

  // ── Восстановление удалённой заявки (архив) ──
  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      schema: { params: idParams },
    },
    async (req) => {
      const [existing] = await db
        .select()
        .from(vehicleRequests)
        .where(eq(vehicleRequests.id, req.params.id));
      if (!existing) throw err.notFound('Заявка не найдена');
      if (existing.deletedAt) {
        await db
          .update(vehicleRequests)
          .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
          .where(eq(vehicleRequests.id, existing.id));
        await writeAudit({
          actorUserId: requirePrincipal(req).id,
          action: 'vehicle_request.restore',
          entityType: 'vehicle_request',
          entityId: existing.id,
        });
      }
      return (await getDto(existing.id))!;
    },
  );
}
