import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  eq,
  exists,
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
  calcVehicleRequestCost,
  can,
  changeVehicleRequestStatusSchema,
  CLOSED_REQUEST_STATUSES,
  type CompleteVehicleRequestInput,
  type ConfirmScheduleInput,
  createVehicleRequestSchema,
  type FileDto,
  formatVehicleRequestNumber,
  waybillFormLabels,
  isApprovalChangeable,
  isClosedRequestStatus,
  isVehicleKindAllowedForRequest,
  moscowDateKeyOf,
  rateForWorkUnit,
  REQUEST_STATUSES,
  requestStatusLabels,
  setVehicleRequestApprovalSchema,
  type SpecialEquipmentRequestDto,
  transitionRequiresApproval,
  transitionRequiresAssignment,
  transitionRequiresCompletion,
  updateVehicleRequestSchema,
  type VehicleOnSiteListDto,
  type VehicleOnSiteSummaryDto,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleRequestDto,
  type VehicleRequestHistorySummaryDto,
  type VehicleRequestOnSiteQuery,
  type VehicleRequestSummaryDto,
  type VehicleRequestType,
  vehicleRequestHistoryQuerySchema,
  vehicleRequestListQuerySchema,
  vehicleRequestOnSiteQuerySchema,
  vehicleRequestSummaryQuerySchema,
  vehicleStatusLabels,
  vehicleWorkUnitRateLabels,
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
  vehicleRequestCompletions,
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
  approvesOwnRequestOnCreate,
  assertArchiveVisible,
  assertLessorScope,
  assertObjectRoleEditable,
  assertObjectScope,
  assertTransitionAllowed,
  canApproveForObject,
  lessorVisibilityWhere,
  requestVisibilityWhere,
} from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { nextRequestContact } from '../lib/request-contact';
import {
  assertFilesAttachable,
  assertTotalWithinLimit,
  hardDeleteFiles,
  markFilesActive,
  scheduleFilesDeletion,
} from '../services/request-files';
import {
  diffVehicleAssignment,
  diffVehicleCompletion,
  diffVehicleRequests,
} from '../services/vehicle-request-diff';
import { loadVehicleRequestHistory } from '../services/vehicle-request-history';
import {
  issueWaybill,
  lastWaybillFields,
  tripDate,
  waybillRequirementFor,
} from '../services/waybill-issue';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

/** Завизировавший — второй join на ту же таблицу учёток (первый отдаёт автора заявки). */
const approvers = alias(users, 'approvers');
/**
 * Заказанная категория (ADR 0028). Своим алиасом: `vehicleCategories` в этом запросе уже занята
 * категорией назначенной машины, а это разные вещи — заказали одно, вышло может быть другое.
 */
const requestCategories = alias(vehicleCategories, 'request_categories');
/** Назначивший технику — третий join на учётки (ADR 0027). */
const assigners = alias(users, 'assigners');
/** Закрывший заявку фактом — четвёртый join на учётки (ADR 0029). */
const completers = alias(users, 'completers');
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
  // Категория заказанного типа (ADR 0028); пусто — у типа категорий нет.
  vehicleCategoryId: vehicleRequests.vehicleCategoryId,
  vehicleCategoryName: requestCategories.name,
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
  // Факт выполнения (ADR 0029): отработанное и стоимость — снимок на момент закрытия.
  completionWorkedUnit: vehicleRequestCompletions.workedUnit,
  completionWorkedAmount: vehicleRequestCompletions.workedAmount,
  completionRate: vehicleRequestCompletions.rate,
  completionTotalCost: vehicleRequestCompletions.totalCost,
  completedBy: vehicleRequestCompletions.completedBy,
  completedByName: completers.fullName,
  completedAt: vehicleRequestCompletions.completedAt,
  version: vehicleRequests.version,
  createdBy: vehicleRequests.createdBy,
  createdByName: users.fullName,
  createdAt: vehicleRequests.createdAt,
  updatedAt: vehicleRequests.updatedAt,
  deletedAt: vehicleRequests.deletedAt,
  dateFrom: specialEquipmentRequestDetails.dateFrom,
  dateTo: specialEquipmentRequestDetails.dateTo,
  // Контакт ответственного (миграция 0062): у заявки на объект один, у грузоперевозки — по одному
  // на концах маршрута. Имена колонок разные, поэтому в выборку идут обе пары.
  responsibleName: specialEquipmentRequestDetails.responsibleName,
  responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
  scheduledAt: freightTransportRequestDetails.scheduledAt,
  scheduledTimeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
  volumeM3: freightTransportRequestDetails.volumeM3,
  weightTons: freightTransportRequestDetails.weightTons,
  loadingLocation: freightTransportRequestDetails.loadingLocation,
  unloadingLocation: freightTransportRequestDetails.unloadingLocation,
  loadingAddress: freightTransportRequestDetails.loadingAddress,
  unloadingAddress: freightTransportRequestDetails.unloadingAddress,
  loadingResponsibleName: freightTransportRequestDetails.loadingResponsibleName,
  loadingResponsiblePhone: freightTransportRequestDetails.loadingResponsiblePhone,
  unloadingResponsibleName: freightTransportRequestDetails.unloadingResponsibleName,
  unloadingResponsiblePhone: freightTransportRequestDetails.unloadingResponsiblePhone,
};

function baseQuery() {
  return (
    db
      .select(requestSelect)
      .from(vehicleRequests)
      .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
      .innerJoin(vehicleTypes, eq(vehicleRequests.vehicleTypeId, vehicleTypes.id))
      // Заказанная категория (ADR 0028): её нет у типа без ТТХ и у заявок старше миграции 0052.
      .leftJoin(requestCategories, eq(vehicleRequests.vehicleCategoryId, requestCategories.id))
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
      .leftJoin(
        vehicleRequestAssignments,
        eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
      )
      .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
      .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
      .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
      .leftJoin(lessors, eq(vehicles.lessorId, lessors.id))
      .leftJoin(assigners, eq(vehicleRequestAssignments.assignedBy, assigners.id))
      // Факт выполнения (ADR 0029): есть только у закрытой заявки, и то не у всякой — у
      // выполненных до миграции 0053 его не восстановить.
      .leftJoin(
        vehicleRequestCompletions,
        eq(vehicleRequests.id, vehicleRequestCompletions.requestId),
      )
      .leftJoin(completers, eq(vehicleRequestCompletions.completedBy, completers.id))
  );
}

type RequestRow = Awaited<ReturnType<typeof baseQuery>>[number];

// Машина в подзапросе видимости — своим алиасом: в списке `vehicles` уже присоединена, и
// одноимённая таблица внутри EXISTS читалась бы как ссылка на внешнюю.
const scopedVehicles = alias(vehicles, 'scoped_vehicles');

/**
 * Область видимости арендодателя (ADR 0038): заявка видна, если на неё назначена его техника.
 *
 * EXISTS, а не условие по присоединённой колонке: то же правило нужно списку, журналу, срезу «На
 * объекте» и трём сводкам, а таблицы в них соединены по-разному — join ради видимости пришлось
 * бы добавлять в каждый запрос отдельно и не забывать в следующем. Для всех остальных ролей
 * условие пустое и в запрос не попадает.
 */
function assignedLessorWhere(p: Principal): SQL | undefined {
  const ownLessor = lessorVisibilityWhere(p, scopedVehicles.lessorId);
  if (!ownLessor) return undefined;
  return exists(
    db
      .select({ one: sql`1` })
      .from(vehicleRequestAssignments)
      .innerJoin(scopedVehicles, eq(vehicleRequestAssignments.vehicleId, scopedVehicles.id))
      .where(and(eq(vehicleRequestAssignments.requestId, vehicleRequests.id), ownLessor)),
  );
}

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

/**
 * Факт выполнения из строки выборки (ADR 0029); null — заявку не закрывали фактом. Отработанное
 * и суммы приходят из numeric строками — приводятся тем же `toNum`, что и ставки.
 */
function toCompletionDto(r: RequestRow): VehicleRequestCompletionDto | null {
  if (!r.completionWorkedUnit || !r.completedBy || !r.completedAt) return null;
  return {
    workedUnit: r.completionWorkedUnit,
    workedAmount: toNum(r.completionWorkedAmount) ?? 0,
    rate: toNum(r.completionRate),
    totalCost: toNum(r.completionTotalCost),
    completedBy: r.completedBy,
    completedByName: r.completedByName ?? '',
    completedAt: r.completedAt.toISOString(),
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
    vehicleCategoryId: r.vehicleCategoryId,
    vehicleCategoryName: r.vehicleCategoryName,
    status: r.status,
    comment: r.comment,
    cancelReason: r.cancelReason || null,
    approvedBy: r.approvedBy,
    approvedByName: r.approvedByName,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    assignment: toAssignmentDto(r),
    completion: toCompletionDto(r),
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
      responsibleName: r.responsibleName ?? '',
      responsiblePhone: r.responsiblePhone ?? '',
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
    loadingResponsibleName: r.loadingResponsibleName ?? '',
    loadingResponsiblePhone: r.loadingResponsiblePhone ?? '',
    unloadingResponsibleName: r.unloadingResponsibleName ?? '',
    unloadingResponsiblePhone: r.unloadingResponsiblePhone ?? '',
  };
}

async function getDto(id: string): Promise<VehicleRequestDto | null> {
  const [row] = await baseQuery().where(eq(vehicleRequests.id, id));
  if (!row) return null;
  const filesMap = await filesByRequestIds([id]);
  return toDto(row, filesMap.get(id) ?? []);
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
 * Заказанная позиция классификатора (ADR 0028): активный тип ТС (ADR 0005) активного вида,
 * разрешённого этому типу заявки, и — если у типа есть активные категории (ADR 0016) — одна из
 * них. Тип заявки задаётся в форме явно: на объект заказывают технику любого вида,
 * грузоперевозку — только грузовым (`isVehicleKindAllowedForRequest`).
 *
 * Категория не «ещё одно поле формы», а часть выбора: у типа с категориями заказ без неё
 * неадресен («нужен автокран» — какой?), а у типа без ТТХ её неоткуда взять. Принадлежность
 * категории типу держит составной FK, но сверяется и здесь — вместо ошибки целостности человек
 * должен получить ответ.
 */
async function resolveClassification(
  tx: Tx,
  typeId: string,
  categoryId: string | null,
  requestType: VehicleRequestType,
): Promise<void> {
  const [row] = await tx
    .select({
      name: vehicleTypes.name,
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

  const activeCategories = await tx
    .select({ id: vehicleCategories.id })
    .from(vehicleCategories)
    .where(and(eq(vehicleCategories.vehicleTypeId, typeId), eq(vehicleCategories.isActive, true)));

  if (!categoryId) {
    if (activeCategories.length > 0) {
      throw err.unprocessable(`Выберите категорию типа «${row.name}»`, {
        vehicleCategoryId: 'Выберите категорию',
      });
    }
    return;
  }
  // Категория чужого типа и выключенная категория — разные ошибки: первая означает сломанный
  // клиент, вторая — что позицию убрали из справочника, пока форма была открыта.
  if (!activeCategories.some((c) => c.id === categoryId)) {
    const [existing] = await tx
      .select({ isActive: vehicleCategories.isActive, typeId: vehicleCategories.vehicleTypeId })
      .from(vehicleCategories)
      .where(eq(vehicleCategories.id, categoryId));
    if (!existing || existing.typeId !== typeId) {
      throw err.badRequest('Категория не найдена у этого типа ТС', {
        vehicleCategoryId: 'Категория другого типа',
      });
    }
    throw err.unprocessable('Категория неактивна', { vehicleCategoryId: 'Категория неактивна' });
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
  request: {
    vehicleTypeId: string;
    vehicleTypeName: string;
    vehicleCategoryId: string | null;
    vehicleCategoryName: string | null;
  },
  input: AssignVehicleInput,
  actor: { id: string; name: string },
): Promise<VehicleRequestAssignmentDto> {
  const [row] = await tx
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      vehicleTypeId: vehicles.vehicleTypeId,
      vehicleCategoryId: vehicles.vehicleCategoryId,
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
  // Категория заказана — значит заказана определённая машина по ТТХ (ADR 0028): автокран на 25 т
  // вместо 130 т работу не сделает. У машины категория может быть не заполнена (в справочнике
  // она необязательна, особенно у аренды) — тогда доверяем тому, кто назначает: запретить здесь
  // означало бы закрыть заявку на технику, которая ей подходит.
  if (
    request.vehicleCategoryId &&
    row.vehicleCategoryId &&
    row.vehicleCategoryId !== request.vehicleCategoryId
  ) {
    throw err.unprocessable(
      `Заявка заказана на «${request.vehicleCategoryName ?? request.vehicleTypeName}»`,
      { vehicleId: 'Техника другой категории' },
    );
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
  driverPersonId: string | null,
): Promise<void> {
  const values = {
    vehicleId: a.vehicleId,
    vehicleTypeId,
    pricePerHour: numToDb(a.pricePerHour),
    pricePerShift: numToDb(a.pricePerShift),
    shiftHours: a.shiftHours,
    // Кто за рулём (ADR 0037): у аренды водитель чужой, и колонка остаётся пустой.
    driverPersonId: driverPersonId ?? null,
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

/**
 * Факт, которым закрывают заявку (ADR 0029). Ставку берёт не клиент, а сервер — из назначения,
 * по выбранной единице: «сколько стоило» должно объясняться той ценой, о которой договорились
 * при переводе в работу, а не той, что пришла в теле запроса. Сумма приходит уже посчитанной
 * (её видел человек в окне закрытия) и правится свободно — счёт арендодателя включает перегон и
 * простой; не прислана — считается ставкой на количество.
 *
 * Возвращает DTO «как будет после записи»: им же пишется история.
 */
function resolveCompletion(
  assignment: VehicleRequestAssignmentDto | null,
  input: CompleteVehicleRequestInput,
  actor: { id: string; name: string },
): VehicleRequestCompletionDto {
  const rate = rateForWorkUnit(assignment, input.workedUnit);
  const totalCost = input.totalCost ?? calcVehicleRequestCost(rate, input.workedAmount);
  // Аренда — счёт от контрагента (ADR 0027): закрытие без суммы означало бы «сколько заплатили,
  // выясним потом». Своя машина без ставок закрывается и без суммы: внутреннюю технику не всегда
  // считают в деньгах. Ставка не задана именно за выбранную единицу — об этом и говорим: обычно
  // достаточно закрыть сменами вместо часов.
  if (assignment?.ownership === 'rental' && totalCost == null) {
    throw err.unprocessable(
      `Ставка ${vehicleWorkUnitRateLabels[input.workedUnit]} у назначенной техники не задана — укажите стоимость`,
      { totalCost: 'Укажите стоимость' },
    );
  }
  return {
    workedUnit: input.workedUnit,
    workedAmount: input.workedAmount,
    rate,
    totalCost,
    completedBy: actor.id,
    completedByName: actor.name,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Закрытие заявки: одна строка на заявку. Повторное закрытие (после отката администратором)
 * переписывает её — двух фактов об одной работе не бывает.
 */
async function saveCompletion(
  tx: Tx,
  requestId: string,
  c: VehicleRequestCompletionDto,
): Promise<void> {
  const values = {
    workedUnit: c.workedUnit,
    workedAmount: String(c.workedAmount),
    rate: numToDb(c.rate),
    totalCost: numToDb(c.totalCost),
    completedBy: c.completedBy,
  };
  await tx
    .insert(vehicleRequestCompletions)
    .values({ requestId, ...values })
    .onConflictDoUpdate({
      target: vehicleRequestCompletions.requestId,
      set: { ...values, completedAt: new Date(), updatedAt: new Date() },
    });
}

/**
 * Фактический срок, уточнённый при переводе заявки в работу. Пишется в ту же detail-таблицу, что и
 * заказанный: план и факт в заявке одно поле — время, о котором договорились, — а расхождение с
 * первоначальным читается историей.
 *
 * Вызывается внутри транзакции перевода в работу и обязательно до выписки путевого листа: дату
 * рейса лист берёт из заявки (`tripDate`), и записанный позже срок отправил бы лист на заказанное
 * время вместо согласованного.
 */
async function applyConfirmedSchedule(
  tx: Tx,
  requestId: string,
  schedule: ConfirmScheduleInput,
): Promise<void> {
  if (schedule.requestType === 'special_equipment') {
    await tx
      .update(specialEquipmentRequestDetails)
      .set({ dateFrom: schedule.dateFrom, dateTo: schedule.dateTo ?? null })
      .where(eq(specialEquipmentRequestDetails.requestId, requestId));
    return;
  }
  await tx
    .update(freightTransportRequestDetails)
    .set({
      scheduledAt: new Date(schedule.scheduledAt),
      scheduledTimeUnspecified: schedule.scheduledTimeUnspecified,
    })
    .where(eq(freightTransportRequestDetails.requestId, requestId));
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
 *
 * Контакт ответственного (миграция 0062) сути не меняет: руководитель строительства визирует
 * технику, срок и объект, а не то, кто встретит машину. Уточнённый телефон не должен возвращать
 * заявку на согласование — иначе исправление опечатки в номере снимает визу и останавливает рейс.
 */
function editChangesSubstance(
  before: VehicleRequestDto,
  body: z.infer<typeof updateVehicleRequestSchema>,
): boolean {
  const changed = (next: unknown, prev: unknown): boolean => next !== undefined && next !== prev;
  if (changed(body.objectId, before.objectId)) return true;
  if (changed(body.vehicleTypeId, before.vehicleTypeId)) return true;
  // Категория — часть заказанного (ADR 0028): «автокран 25 т» вместо «130 т» согласовывают
  // заново. Не переданная категория — не «сняли», а «не трогали»: иначе форма, которая её не
  // знает, снимала бы визу каждой правкой.
  if (
    body.vehicleCategoryId !== undefined &&
    (body.vehicleCategoryId ?? null) !== before.vehicleCategoryId
  ) {
    return true;
  }
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

/**
 * Столбцы сортировки списка и журнала. «Срок» и «объём/масса» у типов заявки лежат в разных
 * detail-таблицах, поэтому сводятся coalesce: у строки заполнена ровно одна из колонок. Объём и
 * масса — разные единицы, но в одном столбце: сортируем по тому, что указано.
 */
const sortColumns = {
  num: vehicleRequests.num,
  requestType: vehicleRequests.requestType,
  objectName: constructionObjects.name,
  createdByName: users.fullName,
  // Сортируют по тому, что видно в столбце: у заявки с категорией это её наименование
  // (ADR 0028) — оно уже начинается с типа, поэтому порядок остаётся типовым.
  vehicleTypeName: sql`coalesce(${requestCategories.name}, ${vehicleTypes.name})`,
  term: sql`coalesce(${freightTransportRequestDetails.scheduledAt}, ${specialEquipmentRequestDetails.dateFrom}::timestamptz)`,
  amount: sql`coalesce(${freightTransportRequestDetails.volumeM3}, ${freightTransportRequestDetails.weightTons})`,
  loadingLocation: freightTransportRequestDetails.loadingLocation,
  unloadingLocation: freightTransportRequestDetails.unloadingLocation,
  status: vehicleRequests.status,
  approval: vehicleRequests.approvedAt,
  comment: vehicleRequests.comment,
  createdAt: vehicleRequests.createdAt,
  // Столбцы журнала (ADR 0029): у кого брали и во сколько обошлось.
  lessorName: lessors.name,
  totalCost: vehicleRequestCompletions.totalCost,
  completedAt: vehicleRequestCompletions.completedAt,
};

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

/**
 * Условия журнала закрытых заявок (ADR 0029). Границы видимости те же, что у списка: штаб видит
 * свой объект, архивные заявки — только тот, кому открыт архив. Статус сужается до одного из
 * закрытых; открытая заявка историей ещё не стала, и просить её здесь нечего.
 */
function historyWhere(p: Principal, q: z.infer<typeof vehicleRequestHistoryQuerySchema>): SQL {
  const statuses =
    q.status && isClosedRequestStatus(q.status) ? [q.status] : [...CLOSED_REQUEST_STATUSES];
  const showDeleted = q.includeDeleted && can(p, 'archive.read');
  return and(
    inArray(vehicleRequests.status, statuses),
    showDeleted ? undefined : isNull(vehicleRequests.deletedAt),
    requestVisibilityWhere(p, vehicleRequests.objectId),
    assignedLessorWhere(p),
    q.requestType ? eq(vehicleRequests.requestType, q.requestType) : undefined,
    q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
    q.vehicleTypeId ? eq(vehicleRequests.vehicleTypeId, q.vehicleTypeId) : undefined,
    q.vehicleCategoryId ? eq(vehicleRequests.vehicleCategoryId, q.vehicleCategoryId) : undefined,
    q.num ? eq(vehicleRequests.num, q.num) : undefined,
    // «У кого брали»: арендодатель лежит у самой машины, а не в назначении, — своя техника под
    // такой фильтр не попадает никогда, и это верно: у неё арендодателя нет.
    q.lessorId ? eq(vehicles.lessorId, q.lessorId) : undefined,
    approvedFilter(q.approved),
    ...dateFilters(q.requestType, q.dateFrom, q.dateTo),
    searchCondition(q.search, [
      vehicleRequests.comment,
      constructionObjects.name,
      constructionObjects.code,
    ]),
  )!;
}

/**
 * Счётчик строк журнала: те же join'ы, что нужны его условиям (объект — поиску, detail-таблицы —
 * датам, назначение с машиной — арендодателю). Без них `where` сослался бы на таблицы, которых
 * в запросе нет.
 */
function historyCountQuery() {
  return db
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
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
    )
    .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id));
}

/**
 * Условия вкладки «На объекте» (ADR 0036): заказ спецтехники, взятый в работу, чей срок накрывает
 * день `onDate`. Пересечение периодов считает тот же `specialDateConds`, что и фильтр списка, —
 * пустая дата окончания там и здесь означает одно и то же: `coalesce(date_to, date_from)`.
 *
 * Ни статуса, ни типа заявки, ни дат в фильтрах вкладки нет — они этот список определяют, а не
 * сужают. Границы видимости общие со списком: штаб и руководитель строительства видят свой объект,
 * а удалённые заявки не показываются никому — техники по ним на объекте нет.
 */
function onSiteWhere(p: Principal, q: VehicleRequestOnSiteQuery, onDate: string): SQL {
  return and(
    eq(vehicleRequests.requestType, 'special_equipment'),
    eq(vehicleRequests.status, 'confirmed'),
    isNull(vehicleRequests.deletedAt),
    requestVisibilityWhere(p, vehicleRequests.objectId),
    assignedLessorWhere(p),
    q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
    q.vehicleTypeId ? eq(vehicleRequests.vehicleTypeId, q.vehicleTypeId) : undefined,
    q.vehicleCategoryId ? eq(vehicleRequests.vehicleCategoryId, q.vehicleCategoryId) : undefined,
    q.num ? eq(vehicleRequests.num, q.num) : undefined,
    ...specialDateConds(onDate, onDate),
    searchCondition(q.search, [
      vehicleRequests.comment,
      constructionObjects.name,
      constructionObjects.code,
    ]),
  )!;
}

/**
 * Счётчик строк среза: join'ы под его условия — объект нужен поиску, деталь спецтехники срокам.
 * Без них `where` сослался бы на таблицы, которых в запросе нет.
 */
function onSiteCountQuery() {
  return db
    .select({ c: count() })
    .from(vehicleRequests)
    .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
    );
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
    const showDeleted = q.includeDeleted && can(p, 'archive.read');
    const where = and(
      q.requestType ? eq(vehicleRequests.requestType, q.requestType) : undefined,
      showDeleted ? undefined : isNull(vehicleRequests.deletedAt),
      requestVisibilityWhere(p, vehicleRequests.objectId),
      assignedLessorWhere(p),
      q.status ? eq(vehicleRequests.status, q.status) : undefined,
      q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
      q.vehicleTypeId ? eq(vehicleRequests.vehicleTypeId, q.vehicleTypeId) : undefined,
      q.vehicleCategoryId ? eq(vehicleRequests.vehicleCategoryId, q.vehicleCategoryId) : undefined,
      q.num ? eq(vehicleRequests.num, q.num) : undefined,
      approvedFilter(q.approved),
      ...dateFilters(q.requestType, q.dateFrom, q.dateTo),
      searchCondition(q.search, [
        vehicleRequests.comment,
        constructionObjects.name,
        constructionObjects.code,
      ]),
    );
    const pg = pageParams(q);
    const rows = await baseQuery()
      .where(where)
      .orderBy(
        orderByFrom(sortColumns, q.sortBy, q.sortOrder, 'createdAt'),
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

  // ── Журнал закрытых заявок: вкладка «История» (ADR 0029) ──
  // Тот же список, суженный до состоявшегося: «Выполнена» и «Отменена». Отдельным маршрутом, а
  // не фильтром общего списка, потому что вопросы к нему другие: не «что сейчас в работе», а
  // «что за период заказали, у кого брали и во сколько это обошлось» — отсюда свой фильтр по
  // арендодателю, свой порядок по умолчанию (по сроку работ) и своя денежная сводка.
  r.get(
    '/history',
    { ...auth, schema: { querystring: vehicleRequestHistoryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const where = historyWhere(p, req.query);
      const pg = pageParams(req.query);
      const rows = await baseQuery()
        .where(where)
        // По сроку работ, а не по дате создания: журнал читают по времени, когда техника
        // работала, — так же его и сводят с табелями и счетами.
        .orderBy(
          orderByFrom(sortColumns, req.query.sortBy, req.query.sortOrder, 'term'),
          asc(vehicleRequests.num),
          asc(vehicleRequests.id),
        )
        .limit(pg.limit)
        .offset(pg.offset);
      const [totalRow] = await historyCountQuery().where(where);
      const filesMap = await filesByRequestIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, filesMap.get(row.id) ?? [])),
        total: Number(totalRow!.c),
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );

  /**
   * Итог журнала за выбранные фильтры: сколько закрыто, чем закончилось и на какую сумму.
   * Считается по тем же условиям, что и сам журнал, — иначе сводка отвечала бы не про то, что
   * человек видит в таблице. Отдельно считаются выполненные заявки без суммы: без этой цифры
   * итог читается как «столько всего и потратили».
   */
  r.get(
    '/history/summary',
    { ...auth, schema: { querystring: vehicleRequestHistoryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const where = historyWhere(p, req.query);
      const [agg] = await db
        .select({
          total: count(),
          done: sql<number>`count(*) FILTER (WHERE ${vehicleRequests.status} = 'done')`,
          cancelled: sql<number>`count(*) FILTER (WHERE ${vehicleRequests.status} = 'cancelled')`,
          totalCost: sql<string | null>`sum(${vehicleRequestCompletions.totalCost})`,
          withoutCost: sql<number>`count(*) FILTER (WHERE ${vehicleRequests.status} = 'done' AND ${vehicleRequestCompletions.totalCost} IS NULL)`,
        })
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
        .leftJoin(
          vehicleRequestAssignments,
          eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
        )
        .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
        .leftJoin(
          vehicleRequestCompletions,
          eq(vehicleRequests.id, vehicleRequestCompletions.requestId),
        )
        .where(where);
      return {
        total: Number(agg!.total),
        done: Number(agg!.done),
        cancelled: Number(agg!.cancelled),
        totalCost: toNum(agg!.totalCost) ?? 0,
        withoutCost: Number(agg!.withoutCost),
      } satisfies VehicleRequestHistorySummaryDto;
    },
  );

  /**
   * Техника на объектах прямо сейчас — вкладка «На объекте» (ADR 0036). Отбор ведут сроки заявки:
   * сегодняшний день по Москве должен попадать в её период, а сама заявка — быть «В работе»
   * (ADR 0027: до этого она не названа машиной, и на объект по ней никто не выходил).
   *
   * «Сегодня» считает сервер и возвращает в `onDate`: часы клиента бывают сбиты, а браузер
   * восточнее Москвы начинает сутки раньше — и подпись «день 3 из 5» отвечала бы про другой день,
   * чем отбор строк.
   */
  r.get(
    '/on-site',
    { ...auth, schema: { querystring: vehicleRequestOnSiteQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const onDate = moscowDateKeyOf(new Date());
      const where = onSiteWhere(p, req.query, onDate);
      const pg = pageParams(req.query);
      const rows = await baseQuery()
        .where(where)
        // По объекту, а не по дате создания: срез читают площадкой — «что сейчас стоит на этом
        // объекте», — и строки одного объекта должны идти рядом.
        .orderBy(
          orderByFrom(sortColumns, req.query.sortBy, req.query.sortOrder, 'objectName'),
          asc(vehicleRequests.num),
          asc(vehicleRequests.id),
        )
        .limit(pg.limit)
        .offset(pg.offset);
      const [totalRow] = await onSiteCountQuery().where(where);
      const filesMap = await filesByRequestIds(rows.map((row) => row.id));
      return {
        // Тип заявки задан условием отбора: сужение здесь ничего не отбрасывает, оно лишь
        // сообщает это типам — на объекте стоит спецтехника, а не грузоперевозка.
        items: rows
          .map((row) => toDto(row, filesMap.get(row.id) ?? []))
          .filter(
            (dto): dto is SpecialEquipmentRequestDto => dto.requestType === 'special_equipment',
          ),
        total: Number(totalRow!.c),
        page: pg.page,
        pageSize: pg.pageSize,
        onDate,
      } satisfies VehicleOnSiteListDto;
    },
  );

  /**
   * Итог среза: сколько единиц техники на объектах, на скольких объектах, сколько вышло сегодня и
   * сколько уезжает. Считается по тем же условиям, что и сам список, — сводка обязана отвечать про
   * то, что человек видит перед собой.
   *
   * «Вышла» и «уезжает» — крайние дни периода: по ним планируют и приёмку машины, и освобождение
   * площадки. Однодневная заявка попадает в обе цифры, и это верно — она и вышла, и уедет сегодня.
   */
  r.get(
    '/on-site/summary',
    { ...auth, schema: { querystring: vehicleRequestOnSiteQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const onDate = moscowDateKeyOf(new Date());
      const [agg] = await db
        .select({
          total: count(),
          objects: sql<number>`count(DISTINCT ${vehicleRequests.objectId})`,
          arrivedToday: sql<number>`count(*) FILTER (WHERE ${specialEquipmentRequestDetails.dateFrom} = ${onDate}::date)`,
          leavingToday: sql<number>`count(*) FILTER (WHERE coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom}) = ${onDate}::date)`,
        })
        .from(vehicleRequests)
        .innerJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
        .leftJoin(
          specialEquipmentRequestDetails,
          eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
        )
        .where(onSiteWhere(p, req.query, onDate));
      return {
        total: Number(agg!.total),
        objects: Number(agg!.objects),
        arrivedToday: Number(agg!.arrivedToday),
        leavingToday: Number(agg!.leavingToday),
      } satisfies VehicleOnSiteSummaryDto;
    },
  );

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
        assignedLessorWhere(p),
        req.query.objectId ? eq(vehicleRequests.objectId, req.query.objectId) : undefined,
        req.query.requestType ? eq(vehicleRequests.requestType, req.query.requestType) : undefined,
        // Заказанная техника (ADR 0028): один тип целиком либо одна его категория — те же
        // условия, что и в списке.
        req.query.vehicleTypeId
          ? eq(vehicleRequests.vehicleTypeId, req.query.vehicleTypeId)
          : undefined,
        req.query.vehicleCategoryId
          ? eq(vehicleRequests.vehicleCategoryId, req.query.vehicleCategoryId)
          : undefined,
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
    // Список арендодателю чужую заявку не покажет, но карточку он мог бы открыть по прямому id
    // (ADR 0038): область спрашивается там, где запись достают, а не только там, где ищут.
    assertLessorScope(p, dto.assignment?.lessorId ?? null);
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
        // Арендодатель назначенной машины: по нему история открывается исполнителю (ADR 0038) —
        // границы у неё те же, что у карточки.
        assignedLessorId: vehicles.lessorId,
      })
      .from(vehicleRequests)
      .innerJoin(users, eq(vehicleRequests.createdBy, users.id))
      .leftJoin(
        vehicleRequestAssignments,
        eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
      )
      .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
      .where(eq(vehicleRequests.id, req.params.id));
    if (!row) throw err.notFound('Заявка не найдена');
    // Архивная заявка видна только тем, кому открыт архив, — как и сама карточка (GET /:id).
    assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
    assertObjectScope(p, row.objectId);
    assertLessorScope(p, row.assignedLessorId);
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
      // Заявку завёл тот, кто за объект и отвечает, — согласование уже состоялось (ADR 0025):
      // просить руководителя строительства завизировать собственную заявку незачем. Право визы
      // само по себе автовизы не даёт (ADR 0032) — администратор заводит заявку не за себя.
      const selfApproved = approvesOwnRequestOnCreate(p, body.objectId);
      const approvedAt = new Date();

      const createdId = await db.transaction(async (tx) => {
        await assertObjectActive(tx, body.objectId);
        await resolveClassification(
          tx,
          body.vehicleTypeId,
          body.vehicleCategoryId ?? null,
          body.requestType,
        );
        const [row] = await tx
          .insert(vehicleRequests)
          .values({
            requestType: body.requestType,
            objectId: body.objectId,
            vehicleTypeId: body.vehicleTypeId,
            vehicleCategoryId: body.vehicleCategoryId ?? null,
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
            responsibleName: body.responsibleName,
            responsiblePhone: body.responsiblePhone,
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
            loadingResponsibleName: body.loadingResponsibleName,
            loadingResponsiblePhone: body.loadingResponsiblePhone,
            unloadingResponsibleName: body.unloadingResponsibleName,
            unloadingResponsiblePhone: body.unloadingResponsiblePhone,
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
          vehicleCategoryId: body.vehicleCategoryId ?? null,
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
      // Тип и категория меняются одной позицией классификатора (ADR 0028). Сменили тип, а
      // категорию не прислали — прежняя относится к прежнему типу, и оставлять её нельзя:
      // считаем, что категории нет, а нужна ли она новому типу, скажет resolveClassification.
      const typeChanged = nextTypeId !== before.vehicleTypeId;
      const nextCategoryId =
        body.vehicleCategoryId !== undefined
          ? (body.vehicleCategoryId ?? null)
          : typeChanged
            ? null
            : before.vehicleCategoryId;
      const classificationChanged = typeChanged || nextCategoryId !== before.vehicleCategoryId;
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
        if (classificationChanged) {
          await resolveClassification(tx, nextTypeId, nextCategoryId, before.requestType);
          // На заявке уже стоит машина заказанного типа (ADR 0027) — сменить заказ означало бы
          // оставить назначение без основания. Тип держит и составной FK, но человеку нужен
          // ответ, а не ошибка целостности; категорию (ADR 0028) не держит никто — машину
          // выбирали именно под неё.
          if (before.assignment) {
            throw err.unprocessable(
              'На заявку назначена техника — сменить тип или категорию можно, только отменив заявку',
              { vehicleTypeId: 'Назначена техника' },
            );
          }
        }

        const [updated] = await tx
          .update(vehicleRequests)
          .set({
            objectId,
            vehicleTypeId: nextTypeId,
            vehicleCategoryId: nextCategoryId,
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
            .set({
              dateFrom,
              dateTo,
              responsibleName: nextRequestContact(
                body.responsibleName,
                ex!.responsibleName,
                'responsibleName',
                'Укажите ответственного',
              ),
              responsiblePhone: nextRequestContact(
                body.responsiblePhone,
                ex!.responsiblePhone,
                'responsiblePhone',
                'Укажите контактный телефон',
              ),
            })
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
              loadingResponsibleName: nextRequestContact(
                body.loadingResponsibleName,
                ex!.loadingResponsibleName,
                'loadingResponsibleName',
                'Укажите ответственного за погрузку',
              ),
              loadingResponsiblePhone: nextRequestContact(
                body.loadingResponsiblePhone,
                ex!.loadingResponsiblePhone,
                'loadingResponsiblePhone',
                'Укажите телефон ответственного за погрузку',
              ),
              unloadingResponsibleName: nextRequestContact(
                body.unloadingResponsibleName,
                ex!.unloadingResponsibleName,
                'unloadingResponsibleName',
                'Укажите ответственного за разгрузку',
              ),
              unloadingResponsiblePhone: nextRequestContact(
                body.unloadingResponsiblePhone,
                ex!.unloadingResponsiblePhone,
                'unloadingResponsiblePhone',
                'Укажите телефон ответственного за разгрузку',
              ),
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
  /**
   * Что портал знает о будущем путевом листе до перевода заявки в работу (ADR 0037): выписывается
   * ли он на эту машину, на какую дату и чем заполнить графы, которых нет ни в заявке, ни в
   * справочниках. Их наследуют от прошлого листа этой машины: гаражный номер, вид сообщения и
   * прицепы от рейса к рейсу те же, и перенабирать их каждый раз незачем.
   *
   * Причина «лист не выписывается» отдаётся текстом: диспетчер должен видеть, почему полей нет,
   * а не отсутствующий блок — отсутствие читается как поломка.
   */
  r.get(
    '/:id/waybill-prefill',
    {
      ...canChangeStatus,
      schema: { params: idParams, querystring: z.object({ vehicleId: z.string().uuid() }) },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const before = await getDto(req.params.id);
      if (!before) throw err.notFound('Заявка не найдена');
      assertObjectScope(p, before.objectId);

      const requirement = await waybillRequirementFor(db, req.query.vehicleId);
      return {
        required: requirement.formCode !== null,
        formCode: requirement.formCode,
        formLabel: requirement.formCode ? waybillFormLabels[requirement.formCode] : null,
        reason: requirement.reason,
        tripDate: await tripDate(db, before.id),
        fields: requirement.formCode ? await lastWaybillFields(req.query.vehicleId) : null,
      };
    },
  );

  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: changeVehicleRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { status, comment, assignment, completion, schedule, version } = req.body;
      // Состояние «до» берётся DTO: при переводе в работу нужна не только сама заявка, но и
      // назначенная прежде техника — по ней считается, что изменилось (повторный перевод после
      // отката может сменить и машину, и ставки).
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertObjectScope(p, before.objectId);
      // Заявку закрывает тот, чья техника на неё вышла (ADR 0038): без этой проверки арендодатель
      // закрыл бы чужую заявку по прямому id — право на переход у него есть, область спрашивается
      // отдельно.
      assertLessorScope(p, before.assignment?.lessorId ?? null);
      if (before.status === status) return before;
      assertTransitionAllowed(p, before.status, status);
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
      // Заявку закрывают фактом (ADR 0029): сколько отработали и во сколько это обошлось.
      // Спрашивать факт есть смысл только там, где есть назначенная машина со ставкой: у заявок,
      // взятых в работу до ADR 0027, считать нечем — их закрывают как раньше, с прочерком.
      // Повторное закрытие (после отката) обходится прежним фактом, как и назначение.
      if (
        transitionRequiresCompletion(status) &&
        !completion &&
        !before.completion &&
        before.assignment
      ) {
        throw err.unprocessable('Укажите отработанное время — им заявка и закрывается', {
          completion: 'Укажите отработанное время',
        });
      }
      // Срок уточняют полями своего типа заявки: тип неизменяем, и «дата начала» у грузоперевозки
      // означала бы, что заявку подменили по дороге.
      if (schedule && schedule.requestType !== before.requestType) {
        throw err.unprocessable('Тип заявки изменить нельзя', { schedule: 'Другой тип заявки' });
      }

      // Назначение, факт и уточнённый срок проверяются и пишутся в той же транзакции, что и статус:
      // заявка не должна побыть «в работе» ни на чём, «выполненной» без факта или взятой на одно
      // время с листом на другое — даже мгновение.
      const { assigned, completed } = await db.transaction(async (tx) => {
        // Срок — первым: дату рейса путевой лист берёт из заявки, и записанный после выписки он
        // отправил бы лист на заказанное время вместо согласованного.
        if (schedule) await applyConfirmedSchedule(tx, before.id, schedule);
        let saved: VehicleRequestAssignmentDto | null = null;
        if (assignment) {
          saved = await resolveAssignment(
            tx,
            {
              vehicleTypeId: before.vehicleTypeId,
              vehicleTypeName: before.vehicleTypeName,
              vehicleCategoryId: before.vehicleCategoryId,
              vehicleCategoryName: before.vehicleCategoryName,
            },
            assignment,
            { id: p.id, name: p.fullName },
          );
          await saveAssignment(
            tx,
            before.id,
            before.vehicleTypeId,
            saved,
            assignment.driverPersonId ?? null,
          );

          // Путевой лист выдаётся в этой же транзакции (ADR 0037): состояния «в работе, а листа
          // нет» не существует. На аренду и типы без бланка лист не выписывается — сервис
          // возвращает null, и это нормальный ход, а не ошибка.
          if (transitionRequiresAssignment(status)) {
            await issueWaybill(tx, {
              requestId: before.id,
              vehicleId: saved.vehicleId,
              driverPersonId: assignment.driverPersonId ?? null,
              fields: assignment.waybill ?? null,
              actor: { id: p.id, name: p.fullName },
            });
          }
        }
        // Ставка берётся из назначения — того, что стоит на заявке сейчас: сменить машину, не
        // меняя статуса, нельзя (ADR 0027), поэтому оно же и было в работе.
        let closed: VehicleRequestCompletionDto | null = null;
        if (completion) {
          closed = resolveCompletion(before.assignment, completion, {
            id: p.id,
            name: p.fullName,
          });
          await saveCompletion(tx, before.id, closed);
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
        return { assigned: saved, completed: closed };
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
      // Факт выполнения — тоже своё событие: «Выполнена» отвечает «что с заявкой», закрытие —
      // «сколько отработали и сколько это стоило». Повторное закрытие после отката видно
      // составом изменений: та же работа, но другое время и другая сумма.
      if (completed) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.complete',
          entityType: 'vehicle_request',
          entityId: before.id,
          metadata: { changes: diffVehicleCompletion(before.completion, completed) },
        });
      }
      const after = (await getDto(before.id))!;
      // Уточнённый срок — событие правки, а не назначения: заказывали на одно время, вышли на
      // другое, и в истории это читается теми же строками «было → стало», что и обычная правка
      // заявки. Совпал с заказанным — события нет: «уточнили и не изменили» истории не событие.
      if (schedule) {
        const changes = diffVehicleRequests(before, after);
        if (changes.length > 0) {
          await writeAudit({
            actorUserId: p.id,
            action: 'vehicle_request.update',
            entityType: 'vehicle_request',
            entityId: before.id,
            metadata: { changes },
          });
        }
      }
      return after;
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
