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
  type AddressMeta,
  type AssignVehicleInput,
  calcVehicleRequestCost,
  canReassignVehicle,
  canShortenWorkPeriodByEdit,
  changeVehicleAssignmentSchema,
  changeVehicleRequestStatusSchema,
  CLOSED_REQUEST_STATUSES,
  dateOnlySchema,
  type CompleteVehicleRequestInput,
  type ConfirmScheduleInput,
  createVehicleRequestSchema,
  type CreateVehicleRequestInput,
  decideVehicleEarlyEndSchema,
  earlyEndBlocker,
  earlyEndDateBounds,
  type FileDto,
  type AssignRouteInput,
  canJoinRoute,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRouteEditable,
  ROLLBACK_WAYBILL_MESSAGE,
  ROUTE_FROZEN_MESSAGE,
  ROUTE_LEGACY_WAYBILL_MESSAGE,
  shouldDetachOnStatus,
  type VehicleRouteDto,
  waybillFormLabels,
  isAllowedEarlyEndDate,
  isApprovalChangeable,
  isClosedRequestStatus,
  type CreateRelocationRouteInput,
  createRelocationRouteSchema,
  isCargoAmountRequired,
  isDirectoryAddressSource,
  CARGO_AMOUNT_MESSAGE,
  isVehicleKindAllowedForRequest,
  moscowDateKeyOf,
  rateForWorkUnit,
  REQUEST_STATUSES,
  type RequestStatus,
  requestVehicleEarlyEndSchema,
  type RequestWaybillDto,
  approvedShiftsBlocker,
  approveVehicleRequestShiftSchema,
  saveVehicleRequestShiftSchema,
  shiftDayBlocker,
  shiftsCompletionBlocker,
  type VehicleRequestShiftsDto,
  type VehicleRequestShiftsSummaryDto,
  requestStatusLabels,
  setVehicleRequestApprovalSchema,
  type SpecialEquipmentRequestDto,
  transitionRequiresApproval,
  transitionRequiresAssignment,
  transitionRequiresCompletion,
  transitionResetsWork,
  updateVehicleRequestSchema,
  type UpdateVehicleRequestInput,
  type VehicleOnSiteListDto,
  type VehicleOnSiteSummaryDto,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleOwnership,
  type VehicleRequestDto,
  type VehicleRequestEarlyEndDto,
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
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  files,
  freightTransportRequestDetails,
  persons,
  specialEquipmentRequestDetails,
  users,
  vehicleCategories,
  vehicleKinds,
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequestCompletions,
  vehicleRequestEarlyEndings,
  vehicleRequestFiles,
  vehicleRequests,
  vehicleRequestStatusHistory,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  warehouses,
  waybillRequests,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import {
  approvesOwnRequestOnCreate,
  archiveWhere,
  assertArchiveVisible,
  assertLessorScope,
  assertObjectRoleEditable,
  assertTransitionAllowed,
  assertRequestScope,
  type RequestCustomer,
  assertVehicleRequestTypeAllowed,
  canApproveRequest,
  assertShiftApprover,
  vehicleRequestVisibilityWhere,
  lessorVisibilityWhere,
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
import { registerPurgeRoute } from '../services/directory-purge';
import {
  diffVehicleAssignment,
  diffVehicleCompletion,
  diffVehicleEarlyEnd,
  diffVehicleRequests,
  earlyEndReasonChange,
  shiftChange,
} from '../services/vehicle-request-diff';
import {
  deleteRequestShift,
  dropRequestShifts,
  hasUnapprovedPastShiftsSql,
  loadRequestShift,
  loadRequestShifts,
  saveRequestShift,
  setShiftApproval,
  shiftSummaries,
  unapprovedPastShiftDates,
} from '../services/vehicle-request-shifts';
import { loadVehicleRequestHistory } from '../services/vehicle-request-history';
import { categorySpecsSql } from '../services/vehicle-categories';
import {
  activeWaybillOfRequest,
  attachRequest,
  bumpRouteVersion,
  createRelocationRoute,
  detachRequest,
  dropPlannedRelocations,
  lastTripFields,
  legacyWaybillOf,
  loadRouteDto,
  loadRouteDtos,
  lockRoute,
  relocationRoutesOfRequest,
  routeOfRequest,
  routeQuery,
  routeRequestCount,
  routeWaybill,
} from '../services/vehicle-routes';
import {
  routeWaybillFormFor,
  tripDate,
  waybillRequirementByType,
  waybillRequirementFor,
} from '../services/waybill-issue';
import { auditEsm2Sync, type Esm2SyncResult, syncEsm2Waybills } from '../services/waybill-esm2';

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
/**
 * Тип назначенной машины — своим алиасом рядом с заказанным: `vehicleTypes` в этом запросе уже
 * занята типом заявки, а с ADR 0059 это разные вещи — заказали одно, вышло может быть крупнее.
 */
const assignmentTypes = alias(vehicleTypes, 'assignment_types');
/** Закрывший заявку фактом — четвёртый join на учётки (ADR 0029). */
const completers = alias(users, 'completers');
/** Арендодатель назначенной машины; у собственной техники его нет. */
const lessors = alias(counterparties, 'lessors');

// Досрочное завершение (ADR 0044): кто попросил сократить срок и кто решил. Две разные учётки —
// в норме площадка и руководитель строительства, — поэтому два алиаса.
const earlyEndRequesters = alias(users, 'early_end_requesters');
const earlyEndDeciders = alias(users, 'early_end_deciders');

/** Отправивший заявку в архив (ADR 0070): им подписана строка вкладки «Архив». */
const deleters = alias(users, 'deleters');

const requestSelect = {
  id: vehicleRequests.id,
  num: vehicleRequests.num,
  requestType: vehicleRequests.requestType,
  // Заказчик заявки (ADR 0040): объект строительства или отдел — заполнена ровно одна пара.
  objectId: vehicleRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  objectAddress: constructionObjects.address,
  departmentId: vehicleRequests.departmentId,
  departmentCode: departments.code,
  departmentName: departments.name,
  // Плоская модель (ADR 0005): тип ТС — напрямую vehicle_type_id.
  vehicleTypeId: vehicleRequests.vehicleTypeId,
  vehicleTypeName: vehicleTypes.name,
  // Вид заказанного типа — граница замены (ADR 0059): им окно назначения спрашивает технику.
  vehicleKindId: vehicleTypes.kindId,
  // Категория заказанного типа (ADR 0028); пусто — у типа категорий нет.
  vehicleCategoryId: vehicleRequests.vehicleCategoryId,
  vehicleCategoryName: requestCategories.name,
  // ТТХ заказанной категории — левая сторона сравнения «крупнее или меньше» (ADR 0059).
  vehicleCategorySpecs: categorySpecsSql(vehicleRequests.vehicleCategoryId).as(
    'request_category_specs',
  ),
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
  // Вид, тип и категория — машины, а не заказа: с ADR 0059 и ADR 0064 они могут расходиться, и
  // карточка обязана показывать, чем заявку закрыли на самом деле.
  assignmentVehicleKindId: assignmentTypes.kindId,
  assignmentVehicleTypeId: vehicles.vehicleTypeId,
  assignmentTypeName: assignmentTypes.name,
  assignmentCategoryId: vehicles.vehicleCategoryId,
  assignmentCategoryName: vehicleCategories.name,
  assignmentCategorySpecs: categorySpecsSql(vehicles.vehicleCategoryId).as(
    'assignment_category_specs',
  ),
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
  // Рейс, в котором заявка едет (маршруты): номер и позиция — ими список рисует колонку
  // «Маршрут», а их отсутствие у грузоперевозки в работе — предупреждение «Без маршрута».
  routeId: vehicleRoutes.id,
  routeNum: vehicleRoutes.num,
  routePosition: vehicleRouteRequests.position,
  // Версия рейса: ею перенос заявки в другой маршрут опознаёт исходный (ADR 0052).
  routeVersion: vehicleRoutes.version,
  // Выписан ли по рейсу действующий лист: подзапросом, а не четвёртым join'ом — в списке нужен
  // признак, а не сам документ (ADR 0041 п. 8).
  routeHasWaybill: sql<boolean>`EXISTS (
    SELECT 1 FROM ${waybills} w
    WHERE w.route_id = ${vehicleRoutes.id} AND w.status <> 'cancelled'
  )`.as('route_has_waybill'),
  // Факт выполнения (ADR 0029): отработанное и стоимость — снимок на момент закрытия.
  completionWorkedUnit: vehicleRequestCompletions.workedUnit,
  completionWorkedAmount: vehicleRequestCompletions.workedAmount,
  completionRate: vehicleRequestCompletions.rate,
  completionTotalCost: vehicleRequestCompletions.totalCost,
  completedBy: vehicleRequestCompletions.completedBy,
  completedByName: completers.fullName,
  completedAt: vehicleRequestCompletions.completedAt,
  // Досрочное завершение (ADR 0044): запрос на сокращение срока и решение по нему.
  earlyEndStatus: vehicleRequestEarlyEndings.status,
  earlyEndNewDateTo: vehicleRequestEarlyEndings.newDateTo,
  earlyEndPreviousDateTo: vehicleRequestEarlyEndings.previousDateTo,
  earlyEndReason: vehicleRequestEarlyEndings.reason,
  earlyEndRequestedBy: vehicleRequestEarlyEndings.requestedBy,
  earlyEndRequestedByName: earlyEndRequesters.fullName,
  earlyEndRequestedAt: vehicleRequestEarlyEndings.requestedAt,
  earlyEndDecidedBy: vehicleRequestEarlyEndings.decidedBy,
  earlyEndDecidedByName: earlyEndDeciders.fullName,
  earlyEndDecidedAt: vehicleRequestEarlyEndings.decidedAt,
  earlyEndDecisionComment: vehicleRequestEarlyEndings.decisionComment,
  version: vehicleRequests.version,
  createdBy: vehicleRequests.createdBy,
  createdByName: users.fullName,
  createdAt: vehicleRequests.createdAt,
  updatedAt: vehicleRequests.updatedAt,
  deletedAt: vehicleRequests.deletedAt,
  deletedByName: deleters.fullName,
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
      .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
      .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
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
      .leftJoin(assignmentTypes, eq(vehicles.vehicleTypeId, assignmentTypes.id))
      .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
      .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
      .leftJoin(lessors, eq(vehicles.lessorId, lessors.id))
      .leftJoin(assigners, eq(vehicleRequestAssignments.assignedBy, assigners.id))
      // Рейс (маршруты): заявка лежит максимум в одном (UNIQUE request_id), поэтому пара
      // leftJoin'ов не размножает строки. leftJoin, а не inner: «в работе и без маршрута» —
      // законное состояние, и такие заявки список обязан показывать первым делом.
      .leftJoin(vehicleRouteRequests, eq(vehicleRouteRequests.requestId, vehicleRequests.id))
      .leftJoin(vehicleRoutes, eq(vehicleRoutes.id, vehicleRouteRequests.routeId))
      // Факт выполнения (ADR 0029): есть только у закрытой заявки, и то не у всякой — у
      // выполненных до миграции 0053 его не восстановить.
      .leftJoin(
        vehicleRequestCompletions,
        eq(vehicleRequests.id, vehicleRequestCompletions.requestId),
      )
      .leftJoin(completers, eq(vehicleRequestCompletions.completedBy, completers.id))
      // Досрочное завершение (ADR 0044): строки нет у подавляющего большинства заявок — срок
      // сокращают редко, и у грузоперевозки его не сокращают вовсе.
      .leftJoin(
        vehicleRequestEarlyEndings,
        eq(vehicleRequests.id, vehicleRequestEarlyEndings.requestId),
      )
      .leftJoin(
        earlyEndRequesters,
        eq(vehicleRequestEarlyEndings.requestedBy, earlyEndRequesters.id),
      )
      .leftJoin(earlyEndDeciders, eq(vehicleRequestEarlyEndings.decidedBy, earlyEndDeciders.id))
      // Кто удалил (ADR 0070): пусто у живой заявки, а у архивной — ещё и если учётку снесли.
      .leftJoin(deleters, eq(vehicleRequests.deletedBy, deleters.id))
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
 * Назначенная техника из строки выборки (ADR 0027); null — заявку в работу не брали.
 *
 * Тип и категория здесь — **машины**: с ADR 0059 они с заказанными расходятся, и подставлять в
 * назначение заказанный тип (как делалось, пока их равенство держал составной FK) значило бы
 * показывать в карточке не то, чем заявку закрыли.
 */
function toAssignmentDto(r: RequestRow): VehicleRequestAssignmentDto | null {
  if (!r.assignmentVehicleId || !r.assignmentOwnership || !r.assignedBy || !r.assignedAt) {
    return null;
  }
  return {
    vehicleId: r.assignmentVehicleId,
    ownership: r.assignmentOwnership,
    vehicleKindId: r.assignmentVehicleKindId ?? r.vehicleKindId,
    vehicleTypeId: r.assignmentVehicleTypeId ?? r.vehicleTypeId,
    typeName: r.assignmentTypeName ?? r.vehicleTypeName,
    vehicleCategoryId: r.assignmentCategoryId,
    categoryName: r.assignmentCategoryName,
    categorySpecs: r.assignmentCategorySpecs,
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

/**
 * Досрочное завершение из строки выборки (ADR 0044); null — срок заявки не сокращали. Состояние
 * запроса и решение по нему хранятся вместе: «ждёт визы» — это ровно строка без решившего.
 */
function toEarlyEndDto(r: RequestRow): VehicleRequestEarlyEndDto | null {
  if (
    !r.earlyEndStatus ||
    !r.earlyEndNewDateTo ||
    !r.earlyEndRequestedBy ||
    !r.earlyEndRequestedAt
  ) {
    return null;
  }
  return {
    status: r.earlyEndStatus,
    newDateTo: r.earlyEndNewDateTo,
    previousDateTo: r.earlyEndPreviousDateTo ?? r.earlyEndNewDateTo,
    reason: r.earlyEndReason ?? '',
    requestedBy: r.earlyEndRequestedBy,
    requestedByName: r.earlyEndRequestedByName ?? '',
    requestedAt: r.earlyEndRequestedAt.toISOString(),
    decidedBy: r.earlyEndDecidedBy,
    decidedByName: r.earlyEndDecidedByName,
    decidedAt: r.earlyEndDecidedAt ? r.earlyEndDecidedAt.toISOString() : null,
    decisionComment: r.earlyEndDecisionComment ?? '',
  };
}

function toDto(
  r: RequestRow,
  fileList: FileDto[],
  shifts?: VehicleRequestShiftsSummaryDto,
): VehicleRequestDto {
  const base = {
    id: r.id,
    num: r.num,
    displayNumber: formatVehicleRequestNumber(r.num),
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    objectAddress: r.objectAddress,
    departmentId: r.departmentId,
    departmentCode: r.departmentCode,
    departmentName: r.departmentName,
    vehicleTypeId: r.vehicleTypeId,
    vehicleTypeName: r.vehicleTypeName,
    vehicleKindId: r.vehicleKindId,
    vehicleCategoryId: r.vehicleCategoryId,
    vehicleCategoryName: r.vehicleCategoryName,
    vehicleCategorySpecs: r.vehicleCategorySpecs,
    status: r.status,
    comment: r.comment,
    cancelReason: r.cancelReason || null,
    approvedBy: r.approvedBy,
    approvedByName: r.approvedByName,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    assignment: toAssignmentDto(r),
    completion: toCompletionDto(r),
    route:
      r.routeId && r.routeNum !== null && r.routePosition !== null
        ? {
            id: r.routeId,
            displayNumber: formatVehicleRouteNumber(r.routeNum),
            position: r.routePosition,
            hasWaybill: r.routeHasWaybill,
            version: r.routeVersion ?? 0,
          }
        : null,
    files: fileList,
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    deletedByName: r.deletedByName,
  };
  if (r.requestType === 'special_equipment') {
    return {
      ...base,
      requestType: 'special_equipment',
      dateFrom: r.dateFrom ?? '',
      dateTo: r.dateTo ?? null,
      responsibleName: r.responsibleName ?? '',
      responsiblePhone: r.responsiblePhone ?? '',
      earlyEnd: toEarlyEndDto(r),
      // Сводка смен: пустая пара нулей у заявки, по которой ещё ничего не подтверждали, — так же
      // читается «долга нет». Считается запросом рядом с файлами (`toDtos`).
      shifts: shifts ?? { approvedDays: 0, unapprovedPastDays: 0 },
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

/**
 * Строки выборки в DTO: файлы и сводка смен подтягиваются к странице целиком — по запросу на
 * список, а не по запросу на строку.
 *
 * День среза передаётся, когда вызывающий уже его вычислил (вкладка «На объекте»): сводка обязана
 * считать «сколько дней прошло» по тому же дню, по которому отбирались строки, иначе список и
 * подписи в нём отвечали бы про разные сутки.
 */
async function toDtos(rows: RequestRow[], onDate?: string): Promise<VehicleRequestDto[]> {
  const [filesMap, shiftsMap] = await Promise.all([
    filesByRequestIds(rows.map((r) => r.id)),
    shiftSummaries(rows, onDate ?? moscowDateKeyOf(new Date())),
  ]);
  return rows.map((row) => toDto(row, filesMap.get(row.id) ?? [], shiftsMap.get(row.id)));
}

async function getDto(id: string): Promise<VehicleRequestDto | null> {
  const [row] = await baseQuery().where(eq(vehicleRequests.id, id));
  if (!row) return null;
  const [dto] = await toDtos([row]);
  return dto ?? null;
}

/** Адрес смены: заявка и день. Дата в теле не дублируется — второй ответ разошёлся бы с первым. */
const shiftParams = z.object({ id: z.string().uuid(), date: dateOnlySchema });

/**
 * Заявка, у которой можно вести смену этого дня, — либо отказ той же строкой, какой портал
 * объясняет неактивную строку таблицы (`shiftDayBlocker`): не спецтехника, не «В работе», архив,
 * день вне срока или день ещё не наступил.
 */
async function requireShiftEditableRequest(
  p: Principal,
  id: string,
  date: string,
): Promise<SpecialEquipmentRequestDto> {
  const request = await getDto(id);
  if (!request || request.deletedAt) throw err.notFound('Заявка не найдена');
  assertRequestScope(p, request);
  const blocker = shiftDayBlocker(request, date, moscowDateKeyOf(new Date()));
  if (blocker) throw err.unprocessable(blocker, { shiftDate: 'День недоступен' });
  return request as SpecialEquipmentRequestDto;
}

/** Ответ маршрутов смены: таблица целиком и день среза — тем же составом, что отдаёт чтение. */
async function shiftsResponse(
  request: SpecialEquipmentRequestDto,
): Promise<VehicleRequestShiftsDto> {
  return {
    items: await loadRequestShifts(request.id, request),
    onDate: moscowDateKeyOf(new Date()),
  };
}

async function assertObjectActive(tx: Tx, objectId: string): Promise<void> {
  const [o] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!o) throw err.badRequest('Объект не найден');
  if (!o.isActive) throw err.badRequest('Объект неактивен');
}

async function assertDepartmentActive(tx: Tx, departmentId: string): Promise<void> {
  const [d] = await tx
    .select({ isActive: departments.isActive })
    .from(departments)
    .where(eq(departments.id, departmentId));
  if (!d) throw err.badRequest('Отдел не найден');
  if (!d.isActive) throw err.badRequest('Отдел неактивен');
}

/**
 * Заказчик заявки (ADR 0040): объект или отдел, ровно один. Схема пропускает только валидные
 * пары, но заказчика надо ещё и разрешить — учётке своей оси и живой записи справочника.
 */
/**
 * Заказчик после правки (ADR 0040): переданный заменяет прежнего целиком — присланный объект
 * снимает отдел и наоборот. Не переданный ничего не меняет.
 *
 * «Заменяет целиком», а не «дополняет»: заказчик у заявки один, и присылать вместе с новым
 * отделом ещё и `objectId: null` клиенту незачем — схема пары всё равно не примет.
 */
function customerAfterEdit(
  before: RequestCustomer,
  body: UpdateVehicleRequestInput,
): RequestCustomer {
  const departmentId = body.requestType === 'freight_transport' ? body.departmentId : undefined;
  if (body.objectId) return { objectId: body.objectId, departmentId: null };
  if (departmentId) return { objectId: null, departmentId };
  return { objectId: before.objectId, departmentId: before.departmentId };
}

/**
 * Заказчик из тела запроса (ADR 0040). У спецтехники он всегда объект: её заказывают на площадку,
 * и отдела в схеме такой заявки нет вовсе — читать оттуда `departmentId` было бы неправдой о том,
 * что клиент может прислать.
 */
function customerOf(body: CreateVehicleRequestInput): RequestCustomer {
  if (body.requestType === 'special_equipment') {
    return { objectId: body.objectId, departmentId: null };
  }
  return { objectId: body.objectId ?? null, departmentId: body.departmentId ?? null };
}

async function assertCustomerActive(tx: Tx, customer: RequestCustomer): Promise<void> {
  if (customer.objectId) await assertObjectActive(tx, customer.objectId);
  if (customer.departmentId) await assertDepartmentActive(tx, customer.departmentId);
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
 * Объём или масса груза — там, где груз бывает.
 *
 * Условие спрашивает бланк заказанного типа ТС: у формы № 3 (легковой автомобиль) груза нет, и
 * требовать число значило бы заставлять заявителя его выдумывать. Схема этого не проверяет —
 * бланк живёт в справочнике, и взять его ей неоткуда (ADR 0037 п. 4, тот же приём, что у
 * категории ТС и ставок).
 */
async function assertCargoAmount(
  tx: Tx,
  vehicleTypeId: string,
  cargo: { volumeM3: string | null; weightTons: string | null },
): Promise<void> {
  if (cargo.volumeM3 != null || cargo.weightTons != null) return;

  const [row] = await tx
    .select({ formCode: vehicleTypes.waybillFormCode })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, vehicleTypeId));
  if (isCargoAmountRequired(row?.formCode ?? null)) {
    throw err.unprocessable(CARGO_AMOUNT_MESSAGE, { volumeM3: CARGO_AMOUNT_MESSAGE });
  }
}

/**
 * Адрес, выбранный из справочника (ADR 0069). Портал присылает строку адреса и ссылку на запись,
 * из которой её взяли; сервер убеждается, что запись есть, действует и адрес у неё тот же.
 *
 * Проверка не формальность: у справочного источника нет ФИАС, и «верифицирован» держится ровно на
 * том, что за адресом стоит живая запись справочника. Без сверки признак верификации выставлял бы
 * себе сам клиент — а он в жёсткой модели (ADR 0006) решает, примут заявку или нет.
 *
 * Строки сравниваются как есть, с точностью до пробелов по краям: адрес попал в заявку копией из
 * справочника, и любое расхождение означает, что выбор устарел — запись отредактировали, пока
 * форма была открыта.
 */
async function assertDirectoryAddress(
  tx: Tx,
  field: 'loadingLocation' | 'unloadingLocation',
  location: string,
  meta: AddressMeta | null | undefined,
): Promise<void> {
  if (!meta || !isDirectoryAddressSource(meta.source)) return;
  // Ссылку требует контракт (`verifiedAddressMetaSchema`); здесь она уже есть.
  const refId = meta.refId!;
  const fail = (message: string) => err.unprocessable(message, { [field]: message });

  if (meta.source === 'object') {
    const [row] = await tx
      .select({ address: constructionObjects.address, isActive: constructionObjects.isActive })
      .from(constructionObjects)
      .where(eq(constructionObjects.id, refId));
    if (!row) throw fail('Объект из справочника не найден — выберите адрес заново');
    if (!row.isActive) throw fail('Объект в справочнике выключен — выберите другой адрес');
    if (row.address.trim() !== location.trim()) {
      throw fail('Адрес объекта в справочнике изменился — выберите адрес заново');
    }
    return;
  }

  // Склад приостановленного поставщика в списке не предлагают: возить к нему незачем, даже если
  // сам склад активен (деактивация поставщика склады не гасит).
  const [row] = await tx
    .select({
      address: warehouses.address,
      isActive: warehouses.isActive,
      supplierActive: counterparties.isActive,
      supplierDeletedAt: counterparties.deletedAt,
    })
    .from(warehouses)
    .innerJoin(counterparties, eq(warehouses.supplierCounterpartyId, counterparties.id))
    .where(eq(warehouses.id, refId));
  if (!row) throw fail('Склад из справочника не найден — выберите адрес заново');
  if (!row.isActive) throw fail('Склад в справочнике выключен — выберите другой адрес');
  if (!row.supplierActive || row.supplierDeletedAt) {
    throw fail('Поставщик склада больше не работает — выберите другой адрес');
  }
  if (row.address.trim() !== location.trim()) {
    throw fail('Адрес склада в справочнике изменился — выберите адрес заново');
  }
}

/**
 * Машина, которой берут заявку в работу (ADR 0027). Проверяется всё, чего не видит БД: живая ли
 * запись, годна ли машина к работе и есть ли ставка там, где без неё нельзя.
 *
 * Классификация заказа не проверяется вовсе (ADR 0045, ADR 0059, ADR 0064): ни категория, ни тип,
 * ни вид ТС назначение не отклоняют. Заявку закрывают тем, что есть в парке, а подходит ли эта
 * машина, знает диспетчер, а не сервер: справочник заполнен неровно, заявку заводит один человек,
 * а парк ведёт другой, и отказ по расхождению строк прятал бы машину, которой работу и делают.
 * Расхождение при этом не замалчивается — портал называет его в списке, предупреждением под полем
 * и записью в истории заявки (назначение хранит тип и категорию **машины**, а не заказа).
 *
 * Осталось то, что к качеству данных отношения не имеет: статус машины. «Обслуживание»,
 * «Списана» и выключенное предложение аренды — это не расхождение справочников, а состояние: такая
 * машина не выйдет, сколько её ни назначай.
 *
 * Возвращает DTO назначения «как будет после записи»: им же пишется история.
 */
async function resolveAssignment(
  tx: Tx,
  input: AssignVehicleInput,
  actor: { id: string; name: string },
): Promise<VehicleRequestAssignmentDto> {
  const [row] = await tx
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      vehicleTypeId: vehicles.vehicleTypeId,
      typeName: vehicleTypes.name,
      kindId: vehicleTypes.kindId,
      status: vehicles.status,
      deletedAt: vehicles.deletedAt,
      registrationNumber: vehicles.registrationNumber,
      description: vehicles.description,
      categoryId: vehicles.vehicleCategoryId,
      categoryName: vehicleCategories.name,
      categorySpecs: categorySpecsSql(vehicles.vehicleCategoryId),
      modelName: vehicleModels.name,
      lessorId: vehicles.lessorId,
      lessorName: counterparties.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
    .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
    .leftJoin(counterparties, eq(vehicles.lessorId, counterparties.id))
    .where(eq(vehicles.id, input.vehicleId));
  if (!row || row.deletedAt) throw err.badRequest('Техника не найдена');
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
    // Вид, тип и категория — машины: назначение отвечает на «чем закрыли», а не «что заказывали».
    vehicleKindId: row.kindId,
    vehicleTypeId: row.vehicleTypeId,
    typeName: row.typeName,
    vehicleCategoryId: row.categoryId,
    categoryName: row.categoryName,
    categorySpecs: row.categorySpecs,
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
 * Рейс, в который заявка едет (маршруты). Перевод в работу больше не выписывает документ — он
 * кладёт заявку в маршрут: в существующий рейс этой машины на эту дату либо в новый, заведённый
 * тут же. Лист выписывается с рейса отдельным действием, когда состав собран.
 *
 * Маршрут обязателен ровно там, где выписывается лист (грузоперевозка на собственной машине с
 * бланком за типом): у аренды рейс ведёт арендодатель, а у заказа техники на объект рейса нет
 * вовсе — там период стояния машины на площадке (ADR 0041).
 */
async function attachToRoute(
  tx: Tx,
  params: {
    request: {
      id: string;
      num: number;
      requestType: VehicleRequestType;
      objectId: string | null;
      departmentId: string | null;
    };
    assignment: VehicleRequestAssignmentDto;
    route: AssignRouteInput | undefined;
    actor: { id: string };
  },
): Promise<void> {
  const requirement = await waybillRequirementFor(tx, {
    requestType: params.request.requestType,
    vehicleId: params.assignment.vehicleId,
  });

  if (!requirement.formCode) {
    // Рейс у такой заявки не спрашивается вовсе: у аренды его ведёт арендодатель, а у заказа
    // техники на объект рейса не существует — там период стояния машины на площадке.
    if (params.route) {
      throw err.unprocessable(
        requirement.reason ??
          'На эту заявку маршрут не ведётся: путевой лист по ней не выписывается',
        { route: 'Маршрут не ведётся' },
      );
    }
    return;
  }

  const routeDate = await tripDate(tx, params.request.id);
  const current = await routeOfRequest(tx, params.request.id);

  // Повторный перевод в работу после отката: заявка уже стоит в рейсе, и трогать его незачем —
  // ровно так же прежняя выдача не поднимала второй талон для той же заявки.
  const requestedId = params.route && 'routeId' in params.route ? params.route.routeId : null;
  if (current && (!requestedId || requestedId === current.routeId)) return;

  let targetId = requestedId;
  if (targetId) {
    const route = await lockRoute(tx, targetId);
    if (route.vehicleId !== params.assignment.vehicleId) {
      throw err.unprocessable('Маршрут заведён на другую машину', { route: 'Другая машина' });
    }
    const waybill = await routeWaybill(tx, route.id);
    if (!isRouteEditable(waybill?.status ?? null)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
    const check = canJoinRoute(
      {
        requestType: params.request.requestType,
        // Статус целевой: заявка становится «В работе» в этой же транзакции.
        status: 'confirmed',
        deletedAt: null,
        tripDate: routeDate,
        ownership: params.assignment.ownership,
      },
      {
        routeDate: route.routeDate,
        requestCount: await routeRequestCount(tx, route.id),
        purpose: route.purpose,
        // Ёмкость рейса задаёт его бланк: у 4-П семь строк задания, у формы № 3 десять (ADR 0068).
        formCode: (
          await routeWaybillFormFor(tx, {
            purpose: route.purpose,
            vehicleId: route.vehicleId,
          })
        ).formCode,
      },
    );
    if (!check.ok) throw err.unprocessable(check.reason, { route: check.reason });
  } else {
    if (!params.route) {
      throw err.unprocessable('Выберите маршрут — рейс планируется маршрутом', {
        route: 'Выберите маршрут',
      });
    }
    const newRoute = 'newRoute' in params.route ? params.route.newRoute : null;
    const driverPersonId = newRoute?.driverPersonId ?? null;
    const trip = newRoute?.trip;
    const [created] = await tx
      .insert(vehicleRoutes)
      .values({
        vehicleId: params.assignment.vehicleId,
        routeDate,
        driverPersonId,
        withTrailer: trip?.withTrailer ?? false,
        trailer1Model: trip?.trailer1Model ?? '',
        trailer1RegNumber: trip?.trailer1RegNumber ?? '',
        trailer2Model: trip?.trailer2Model ?? '',
        trailer2RegNumber: trip?.trailer2RegNumber ?? '',
        garageNumber: trip?.garageNumber ?? '',
        communicationKind: trip?.communicationKind ?? '',
        transportationKind: trip?.transportationKind ?? '',
        createdBy: params.actor.id,
      })
      .returning({ id: vehicleRoutes.id });
    targetId = created!.id;
  }

  if (current) {
    await detachRequest(tx, current.routeId, params.request.id);
    await bumpRouteVersion(tx, current.routeId, params.actor.id);
  }
  await attachRequest(tx, targetId!, params.request.id);
  await bumpRouteVersion(tx, targetId!, params.actor.id);
}

/**
 * Перегон техники по заявке: доставка на объект или вывоз с него (миграция 0082).
 *
 * Спецтехника доезжает до площадки по городу своим ходом, и на эту поездку выписывается 4-П.
 * Заводится он по желанию: технику могут привезти тралом, и тогда листа не будет вовсе — способ
 * доставки портал не ведёт и спрашивать его не должен.
 *
 * Машина берётся из назначения заявки: «перегнать одной, а работать другой» не состояние, а
 * расхождение. На арендную технику перегон не заводится — лист на неё выписывает арендодатель.
 */
async function addRelocation(
  tx: Tx,
  params: {
    request: { id: string; num: number; requestType: VehicleRequestType };
    assignment: { vehicleId: string; ownership: VehicleOwnership };
    purpose: 'delivery' | 'pickup';
    input: Omit<CreateRelocationRouteInput, 'purpose'>;
    actor: { id: string };
  },
): Promise<{ id: string; num: number }> {
  if (params.request.requestType !== 'special_equipment') {
    throw err.unprocessable(
      'Перегон заводится на заказ техники на объект: у грузоперевозки рейс и есть сама работа',
      { purpose: 'Не тот вид заявки' },
    );
  }
  if (params.assignment.ownership !== 'own') {
    throw err.unprocessable('Путевой лист на арендную технику выписывает арендодатель', {
      purpose: 'Арендная техника',
    });
  }
  return createRelocationRoute(tx, {
    requestId: params.request.id,
    vehicleId: params.assignment.vehicleId,
    purpose: params.purpose,
    routeDate: params.input.routeDate,
    driverPersonId: params.input.driverPersonId ?? null,
    moveFrom: params.input.moveFrom,
    moveTo: params.input.moveTo,
    trip: params.input.trip,
    comment: params.input.comment,
    actorId: params.actor.id,
  });
}

/**
 * Заявка уходит из «В работе»: отмена и возврат в «Новую» вынимают её из рейса — рейса не будет,
 * и держать её в плане незачем. «Выполнена» состав не трогает: рейс состоялся, и связь заявки с
 * маршрутом стала историей. Из замороженного рейса заявка не выбывает ни при каком статусе —
 * бланк уже у водителя, и исчезнуть из него она не может.
 *
 * Запланированные перегоны уходят по тому же правилу: рейс без единого выписанного листа
 * убирается, а с листом — хоть бы и аннулированным — остаётся, потому что на него ссылается
 * журнал бланков строгой отчётности.
 */
async function detachOnStatus(
  tx: Tx,
  requestId: string,
  next: RequestStatus,
  actorId: string,
): Promise<string[]> {
  // Перегоны: та же граница «отмена и возврат в „Новую“», но состава у них нет — убирается сам
  // рейс. «Выполнена» их не трогает: технику вывозят и после того, как работы закрыли.
  const droppedRelocations =
    next === 'cancelled' || next === 'new' ? await dropPlannedRelocations(tx, requestId) : [];

  const current = await routeOfRequest(tx, requestId);
  if (!current) return droppedRelocations;
  const route = await lockRoute(tx, current.routeId);
  const waybill = await routeWaybill(tx, route.id);
  const frozen = !isRouteEditable(waybill?.status ?? null);
  if (!shouldDetachOnStatus(next, frozen)) return droppedRelocations;
  await detachRequest(tx, route.id, requestId);
  await bumpRouteVersion(tx, route.id, actorId);
  return droppedRelocations;
}

/**
 * Заявка переезжает в рейс новой машины (ADR 0048). Рейс заведён на конкретную машину, поэтому
 * смена техники — это всегда переезд, а не правка: заявка вынимается из прежнего маршрута и
 * кладётся в маршрут новой единицы тем же путём, что и при переводе в работу.
 *
 * Замороженный выписанным листом рейс не отдаёт заявку: бланк уже у водителя, и исчезнуть из него
 * задним числом она не может — сначала лист аннулируют (`waybills.cancel`). Тем же правилом рейс
 * держит заявку при смене статуса (`detachOnStatus`).
 */
async function moveToRouteOfVehicle(
  tx: Tx,
  params: Parameters<typeof attachToRoute>[1],
): Promise<void> {
  // Лист, выписанный до маршрутов, держит заявку так же, как замороженный рейс: в бланке стоят
  // прежние машина и водитель, а рейса, который можно было бы проверить, у него нет. Спрашивается
  // до всего остального — новой машине бланк может быть и не нужен, но выданный уже на руках.
  const legacyWaybill = await legacyWaybillOf(tx, params.request.id);
  if (legacyWaybill) {
    throw err.conflict(`${ROUTE_LEGACY_WAYBILL_MESSAGE} (${legacyWaybill})`);
  }
  const current = await routeOfRequest(tx, params.request.id);
  if (current) {
    const route = await lockRoute(tx, current.routeId);
    const waybill = await routeWaybill(tx, route.id);
    if (!isRouteEditable(waybill?.status ?? null)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
    await detachRequest(tx, route.id, params.request.id);
    await bumpRouteVersion(tx, route.id, params.actor.id);
  }
  // Прежнего рейса у заявки уже нет — `attachToRoute` заводит новый либо кладёт в существующий
  // маршрут новой машины. Ему же остаётся решить, нужен ли рейс вообще: у аренды и у типов без
  // бланка его не бывает, и тогда заявка просто остаётся без маршрута.
  await attachToRoute(tx, params);
}

/**
 * Назначение заявки: одна строка на заявку, повторный перевод в работу (после отката) её
 * переписывает — вторая машина в заявке одного типа и одного срока не появляется.
 */
async function saveAssignment(
  tx: Tx,
  requestId: string,
  /** Заказанный тип заявки: им держится запрет менять заказ под назначенной машиной. */
  orderedVehicleTypeId: string,
  a: VehicleRequestAssignmentDto,
): Promise<void> {
  const values = {
    vehicleId: a.vehicleId,
    // Тип машины и заказанный тип пишутся по отдельности (миграция 0083): первый — цель
    // составного FK на технику, второй — на заявку. Совпадать они не обязаны (ADR 0059).
    vehicleTypeId: a.vehicleTypeId,
    orderedVehicleTypeId,
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
 * Чем объясняется переписанная бумага в журнале бланков. Причина аннулирования обязательна
 * (CHECK `waybills_cancel_reason_check`), и «сверка» ею не является: человек, открывший журнал,
 * должен прочесть, что случилось с заявкой, а не что сработала функция.
 */
function esm2StatusReason(status: RequestStatus): string {
  return `Заявка переведена в «${requestStatusLabels[status]}» — путевые листы переоформлены`;
}

/** Календарный ключ `YYYY-MM-DD` человеку: `24.07.2026`. Через JS Date он бы поехал на день. */
function dateKeyRu(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

/** Максимум дат в перечне отказа: заявка бывает на месяц, и весь список в сообщение не влезет. */
const MAX_LISTED_DATES = 5;

/** Даты перечнем: «12.08.2026, 13.08.2026 и ещё 7». */
function listDates(dates: string[]): string {
  const head = dates.slice(0, MAX_LISTED_DATES).map(dateKeyRu).join(', ');
  const rest = dates.length - MAX_LISTED_DATES;
  return rest > 0 ? `${head} и ещё ${rest}` : head;
}

/**
 * Согласованное сокращение срока (ADR 0044): новый последний день записывается прямо в заявку.
 * Отдельной пары «план/факт» у срока нет — в заявке одно время, то, о котором договорились, — а
 * расхождение с первоначальным читается историей. Тем же приёмом пишется срок, уточнённый при
 * переводе заявки в работу (`applyConfirmedSchedule`).
 */
async function applyEarlyEnd(tx: Tx, requestId: string, newDateTo: string): Promise<void> {
  await tx
    .update(specialEquipmentRequestDetails)
    .set({ dateTo: newDateTo })
    .where(eq(specialEquipmentRequestDetails.requestId, requestId));
}

/**
 * Снимает ожидающий визы запрос на досрочное завершение (ADR 0044) и отвечает, был ли он.
 *
 * Запрос перестаёт иметь смысл сам по себе в двух случаях: заявку закрыли (сокращать срок больше
 * нечего) и срок поправили обычной правкой (снимок `previous_date_to` разошёлся с заявкой, и виза
 * решала бы про другой период). Оба раза строка снимается молча для визирующего, но событием для
 * истории: иначе «ждёт визы» висело бы на закрытой заявке и считалось в сводке среза.
 *
 * Решённые запросы не трогаются: согласованный уже сократил срок, отклонённый объясняет, почему
 * этого не случилось, — и оба остаются ответом на вопрос «что было с этой заявкой».
 */
async function clearPendingEarlyEnd(tx: Tx, requestId: string): Promise<boolean> {
  const removed = await tx
    .delete(vehicleRequestEarlyEndings)
    .where(
      and(
        eq(vehicleRequestEarlyEndings.requestId, requestId),
        eq(vehicleRequestEarlyEndings.status, 'pending'),
      ),
    )
    .returning({ requestId: vehicleRequestEarlyEndings.requestId });
  return removed.length > 0;
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

/** Срок работ после правки: не переданное поле означает «не трогали». */
function workPeriodAfterEdit(
  before: SpecialEquipmentRequestDto,
  body: Extract<UpdateVehicleRequestInput, { requestType: 'special_equipment' }>,
): { dateFrom: string; dateTo: string | null } {
  return {
    dateFrom: body.dateFrom ?? before.dateFrom,
    dateTo: body.dateTo !== undefined ? (body.dateTo ?? null) : before.dateTo,
  };
}

/** Правка вообще трогает срок работ — по любой из двух границ (ADR 0044: такая правка снимает
 * ожидающий визы запрос на досрочное завершение: его снимок периода после неё уже не про эту
 * заявку). */
function changesWorkPeriod(before: VehicleRequestDto, body: UpdateVehicleRequestInput): boolean {
  if (before.requestType !== 'special_equipment' || body.requestType !== 'special_equipment') {
    return false;
  }
  const next = workPeriodAfterEdit(before, body);
  return next.dateFrom !== before.dateFrom || next.dateTo !== before.dateTo;
}

/**
 * Правка сокращает срок работ: последний день переезжает назад. Считается по тому же
 * `coalesce(date_to, date_from)`, которым период читают отбор среза и подписи присутствия —
 * пустая дата окончания и здесь означает однодневный срок.
 */
function shortensWorkPeriod(before: VehicleRequestDto, body: UpdateVehicleRequestInput): boolean {
  if (before.requestType !== 'special_equipment' || body.requestType !== 'special_equipment') {
    return false;
  }
  const next = workPeriodAfterEdit(before, body);
  return (next.dateTo || next.dateFrom) < (before.dateTo || before.dateFrom);
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
  // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили — им архив и открывают.
  deletedAt: vehicleRequests.deletedAt,
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
  return and(
    inArray(vehicleRequests.status, statuses),
    archiveWhere(p, q.archive, vehicleRequests.deletedAt),
    vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId),
    assignedLessorWhere(p),
    q.requestType ? eq(vehicleRequests.requestType, q.requestType) : undefined,
    q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
    q.departmentId ? eq(vehicleRequests.departmentId, q.departmentId) : undefined,
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
    .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
    .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
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
 * Второе условие — заявка, у которой срок уже прошёл, а дни работы не подтверждены: работа по ней
 * не принята, закрыть её нельзя, и исчезать из единственного экрана, куда смотрят каждое утро,
 * она не должна — иначе всплывёт через месяц, при попытке закрытия. В таблице такая строка
 * помечается тегом присутствия `awaiting`.
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
    vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId),
    assignedLessorWhere(p),
    q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
    // Фильтра по отделу здесь нет намеренно: срез — про спецтехнику на площадке, а её отдел не
    // заказывает вовсе (CHECK `vehicle_requests_department_freight_check`).
    q.vehicleTypeId ? eq(vehicleRequests.vehicleTypeId, q.vehicleTypeId) : undefined,
    q.vehicleCategoryId ? eq(vehicleRequests.vehicleCategoryId, q.vehicleCategoryId) : undefined,
    q.num ? eq(vehicleRequests.num, q.num) : undefined,
    or(and(...specialDateConds(onDate, onDate)), hasUnapprovedPastShiftsSql(onDate)),
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
    .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
    .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
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
    const where = and(
      q.requestType ? eq(vehicleRequests.requestType, q.requestType) : undefined,
      // Архив (ADR 0070): вкладка «Архив» просит `only`, обычный список — умолчание `exclude`.
      // Границы видимости при этом те же: свой объект, свой отдел, своя техника.
      archiveWhere(p, q.archive, vehicleRequests.deletedAt),
      vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId),
      assignedLessorWhere(p),
      q.status ? eq(vehicleRequests.status, q.status) : undefined,
      q.objectId ? eq(vehicleRequests.objectId, q.objectId) : undefined,
      q.departmentId ? eq(vehicleRequests.departmentId, q.departmentId) : undefined,
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
      .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
      .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
      .leftJoin(
        specialEquipmentRequestDetails,
        eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
      )
      .leftJoin(
        freightTransportRequestDetails,
        eq(vehicleRequests.id, freightTransportRequestDetails.requestId),
      )
      .where(where);
    return {
      items: await toDtos(rows),
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
      return {
        items: await toDtos(rows),
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
        .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
        .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
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
      // День среза передаётся сводке смен: «сколько дней уже прошло» обязано считаться по тому же
      // дню, по которому отбирались строки.
      const items = await toDtos(rows, onDate);
      return {
        // Тип заявки задан условием отбора: сужение здесь ничего не отбрасывает, оно лишь
        // сообщает это типам — на объекте стоит спецтехника, а не грузоперевозка.
        items: items.filter(
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
          // Досрочный отъезд (ADR 0044): по статусу заявки его не видно — она всё ещё «В работе»
          // на весь заказанный срок, а площадка освободится раньше, если визу поставят.
          earlyEndPending: sql<number>`count(*) FILTER (WHERE ${vehicleRequestEarlyEndings.status} = 'pending')`,
          // Долг подписей: по скольким заявкам работа ещё не принята объектом. Пока цифра не
          // ноль, эти заявки не закроются — а часть из них уже отработала свой срок.
          shiftsPending: sql<number>`count(*) FILTER (WHERE ${hasUnapprovedPastShiftsSql(onDate)})`,
        })
        .from(vehicleRequests)
        // Отдел здесь не присоединяется: срез отбирает спецтехнику, а её заказывает только
        // объект (CHECK `vehicle_requests_department_freight_check`).
        .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
        .leftJoin(
          specialEquipmentRequestDetails,
          eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
        )
        .leftJoin(
          vehicleRequestEarlyEndings,
          eq(vehicleRequests.id, vehicleRequestEarlyEndings.requestId),
        )
        .where(onSiteWhere(p, req.query, onDate));
      return {
        total: Number(agg!.total),
        objects: Number(agg!.objects),
        arrivedToday: Number(agg!.arrivedToday),
        leavingToday: Number(agg!.leavingToday),
        earlyEndPending: Number(agg!.earlyEndPending),
        shiftsPending: Number(agg!.shiftsPending),
      } satisfies VehicleOnSiteSummaryDto;
    },
  );

  /**
   * Сводка «сколько заявок в каком статусе» для виджета над таблицей. Считается по тем же
   * правилам видимости, что и список: штаб видит только свой объект. Удалённые в счёт не идут —
   * счётчик отвечает на «сколько работы», а работы по архивной заявке нет (ADR 0070): свою
   * численность архив показывает своей вкладкой.
   */
  r.get(
    '/summary',
    { ...auth, schema: { querystring: vehicleRequestSummaryQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const where = and(
        isNull(vehicleRequests.deletedAt),
        vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId),
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
    assertRequestScope(p, dto);
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
        departmentId: vehicleRequests.departmentId,
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
    assertRequestScope(p, row);
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
      // Отдел заказывает только грузоперевозки (ADR 0040) — проверяется до области: «вам такой
      // заказ не положен» точнее, чем «это не ваш объект», когда объекта у роли нет вовсе.
      assertVehicleRequestTypeAllowed(p, body.requestType);
      const customer = customerOf(body);
      assertRequestScope(p, customer);
      // Заявку завёл тот, кто за объект или отдел и отвечает, — согласование уже состоялось
      // (ADR 0025): просить его завизировать собственную заявку незачем. Право визы само по себе
      // автовизы не даёт (ADR 0032) — администратор заводит заявку не за себя.
      const selfApproved = approvesOwnRequestOnCreate(p, customer);
      const approvedAt = new Date();

      const createdId = await db.transaction(async (tx) => {
        await assertCustomerActive(tx, customer);
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
            objectId: customer.objectId,
            departmentId: customer.departmentId,
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
          await assertCargoAmount(tx, body.vehicleTypeId, {
            volumeM3: numToDb(body.volumeM3),
            weightTons: numToDb(body.weightTons),
          });
          await assertDirectoryAddress(
            tx,
            'loadingLocation',
            body.loadingLocation,
            body.loadingAddress,
          );
          await assertDirectoryAddress(
            tx,
            'unloadingLocation',
            body.unloadingLocation,
            body.unloadingAddress,
          );
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
      assertRequestScope(p, before);
      assertObjectRoleEditable(p, before.status, 'редактировать');

      // Заказчик после правки: переданный заменяет прежнего целиком — объект снимает отдел и
      // наоборот (ADR 0040). Не переданный оставляет всё как было.
      const customer: RequestCustomer = customerAfterEdit(before, body);
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
      //
      // Снимается виза только там, где её можно поставить обратно, — то есть пока заявка «Новая»
      // (ADR 0044). У заявки в работе виза уже отработала своё: она основание состоявшихся
      // договорённостей с исполнителем (ADR 0025 п. 6), и снятая правкой она не возвращается
      // ничем — заявка навсегда осталась бы в работе и «ждущей визы» одновременно.
      const dropApproval =
        !!before.approvedAt &&
        isApprovalChangeable(before.status) &&
        !canApproveRequest(p, customer) &&
        editChangesSubstance(before, body);

      // Сокращать срок работающей заявки обычной правкой нельзя (ADR 0044): для этого есть
      // досрочное завершение с визой, и прямая правка обошла бы её в один шаг. Продление и правка
      // ещё не начатой заявки остаются как были — это не то, ради чего заводилась виза.
      if (shortensWorkPeriod(before, body) && !canShortenWorkPeriodByEdit(before.status)) {
        throw err.unprocessable(
          'Срок работающей техники сокращают досрочным завершением — с визой руководителя строительства',
          { dateTo: 'Досрочное завершение' },
        );
      }

      const periodEdited = changesWorkPeriod(before, body);
      let earlyEndDropped = false;
      let esm2: Esm2SyncResult = { cancelled: [], issued: [] };

      await db.transaction(async (tx) => {
        const customerChanged =
          customer.objectId !== before.objectId || customer.departmentId !== before.departmentId;
        if (customerChanged) {
          // Переносить заявку можно только внутрь своей области: иначе объектная роль сдвигала бы
          // её на чужую площадку, а отдельская — уводила бы из-под своего руководителя.
          assertRequestScope(p, customer);
          await assertCustomerActive(tx, customer);
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
            objectId: customer.objectId,
            departmentId: customer.departmentId,
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
          await assertCargoAmount(tx, nextTypeId, { volumeM3, weightTons });
          // Строка и метаданные приходят парой (`updateVehicleRequestSchema`), поэтому проверять
          // есть что ровно тогда, когда адрес правили: у нетронутого адреса запись справочника
          // сверять незачем — заявка помнит его таким, каким он был на подаче.
          if (body.loadingLocation !== undefined) {
            await assertDirectoryAddress(
              tx,
              'loadingLocation',
              body.loadingLocation,
              body.loadingAddress,
            );
          }
          if (body.unloadingLocation !== undefined) {
            await assertDirectoryAddress(
              tx,
              'unloadingLocation',
              body.unloadingLocation,
              body.unloadingAddress,
            );
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

        // Правка срока делает ожидающий визы запрос на досрочное завершение беспредметным:
        // он просил сократить другой период (ADR 0044).
        if (periodEdited) {
          earlyEndDropped = await clearPendingEarlyEnd(tx, id);
          // Продлённый срок добавляет недели, сдвинутое начало переписывает первую (миграция
          // 0087). Сокращать срок работающей заявки правкой нельзя вовсе — на это есть досрочное
          // завершение с визой, — так что здесь бумага чаще прибавляется, чем сгорает.
          esm2 = await syncEsm2Waybills(tx, {
            requestId: id,
            actor: { id: p.id },
            reason: 'Срок работ изменён правкой заявки — путевые листы переоформлены',
          });
        }
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
      // Снятый правкой запрос на досрочное завершение — тоже своё событие: руководитель
      // строительства перестанет видеть его в ожидающих визы, и причина должна быть в истории.
      if (earlyEndDropped) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.early_end_cancel',
          entityType: 'vehicle_request',
          entityId: id,
          metadata: { reason: 'edited', changes: earlyEndReasonChange('Срок заявки изменён') },
        });
      }
      await auditEsm2Sync({
        actorUserId: p.id,
        requestId: id,
        reason: 'period_edited',
        result: esm2,
      });
      return after;
    },
  );

  // ── Смена статуса ──
  /**
   * То же для маршрутов: ведётся ли по этой заявке рейс, на какую дату, какие рейсы уже заведены
   * на неё и чем были заполнены графы шапки в прошлый раз.
   *
   * Машина необязательна, и от неё зависит, какие рейсы подсказаны (ADR 0052):
   *
   * - **без машины** — все рейсы дня (ADR 0064). День планируют с этого вопроса: заявка едет
   *   рейсом, а рейс уже знает, какой машиной. Классификацией список не сужается ни в одну
   *   ступень — ни типом (ADR 0059), ни видом: рейс машины другого вида — такой же ответ на
   *   «чем заявка поедет», и прятать его значило бы вернуть запрет, снятый в назначении. Чем
   *   каждый рейс отличается от заказанного, считает портал правилом из контрактов: в строке рейса
   *   приезжают вид и тип его машины и ТТХ её категории, и порядок списка считается по ним.
   *   Принадлежность спрашивать не у чего и незачем — рейс заводится только на собственную технику
   *   (`assertRouteVehicle`), так что список и так сужен ею.
   * - **с машиной** — рейсы именно этой машины плюс графы шапки от её прошлого рейса: реквизиты
   *   выезда наследуются от конкретной единицы, и без неё наследовать нечего.
   *
   * Причина «рейс не ведётся» отдаётся текстом там, где о ней есть что сказать (аренда, тип без
   * бланка); у заказа техники на объект её нет и быть не должно — рейса у такой заявки не
   * существует (ADR 0041).
   */
  r.get(
    '/:id/route-prefill',
    {
      // Обе проверки, как на всех ручках маршрутов: в ответе лежат чужие рейсы и ФИО водителей
      // собственного парка, а `vehicleRequests.status` есть и у внешнего арендодателя (ADR 0038).
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: {
        params: idParams,
        querystring: z.object({
          vehicleId: z.string().uuid().optional(),
          /**
           * День рейса, если его правят прямо в форме: подача уточняется при переводе в работу, а
           * рейс печатает задание на день — подсказка соседнего дня показала бы рейсы, в которые
           * заявка всё равно не встанет. Не передан — берётся дата, записанная в заявке.
           */
          date: dateOnlySchema.optional(),
        }),
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const before = await getDto(req.params.id);
      if (!before) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);

      const vehicleId = req.query.vehicleId;
      const requirement = vehicleId
        ? await waybillRequirementFor(db, {
            requestType: before.requestType,
            vehicleId,
          })
        : await waybillRequirementByType(db, {
            requestType: before.requestType,
            vehicleTypeId: before.vehicleTypeId,
          });
      const date = req.query.date ?? (await tripDate(db, before.id));
      if (!requirement.formCode) {
        return {
          required: false,
          formCode: null,
          formLabel: null,
          reason: requirement.reason,
          tripDate: date,
          routes: [],
          trip: null,
        };
      }

      const rows = await routeQuery(db)
        .where(
          and(
            eq(vehicleRoutes.routeDate, date),
            // Без машины — весь день целиком (ADR 0064): классификация рейса его из подсказки не
            // убирает, она задаёт только порядок, и считает его портал (`vehicleSubstitutionRank`).
            vehicleId ? eq(vehicleRoutes.vehicleId, vehicleId) : undefined,
          ),
        )
        // Порядок здесь стабильный и предсказуемый — по номеру рейса: пригодность машины считает
        // портал, и рейсы одного типа не должны перемешиваться между запросами.
        .orderBy(asc(vehicleRoutes.num));
      return {
        required: true,
        formCode: requirement.formCode,
        formLabel: waybillFormLabels[requirement.formCode],
        reason: null,
        tripDate: date,
        routes: await loadRouteDtos(db, rows),
        trip: vehicleId ? await lastTripFields(vehicleId) : null,
      };
    },
  );

  /**
   * Лист, выписанный по этой заявке (ADR 0041). Отдельной ручкой, а не полем DTO: лист нужен
   * одной карточке одного вида заявок, а в списочный запрос он добавил бы три join'а к каждой
   * строке — ради колонки, которой в списке нет.
   *
   * Право своё, `waybills.read`: в листе персональные данные водителя, и заказчику со стороны
   * объекта их не показывают (ADR 0037 п. 13).
   */
  /**
   * Перегоны заявки: доставка техники на объект и вывоз с него (миграция 0082).
   *
   * Отдельной ручкой по тем же причинам, что и лист (ADR 0041 п. 8): они нужны одной карточке
   * одного вида заявок, а в списочный запрос добавили бы join'ы ради колонки, которой в списке
   * нет. Право то же — в рейсе виден водитель, а это персональные данные листа.
   */
  r.get(
    '/:id/relocations',
    {
      preHandler: [app.authenticate, app.requirePermission('waybills.read')],
      schema: { params: idParams },
    },
    async (req): Promise<VehicleRouteDto[]> => {
      const p = requirePrincipal(req);
      const request = await getDto(req.params.id);
      if (!request) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, request);
      return relocationRoutesOfRequest(db, request.id);
    },
  );

  /**
   * Завести перегон: доставку техники на объект или вывоз с неё.
   *
   * Доставку предлагает и форма перевода в работу, но обязательной она не будет никогда: технику
   * везут и тралом. Вывоз заводится только здесь — в момент перевода в работу его дату ещё не
   * знают, а к концу работ она известна (в том числе после досрочного завершения, ADR 0044).
   */
  r.post(
    '/:id/relocations',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status'),
      ],
      schema: { params: idParams, body: createRelocationRouteSchema },
    },
    async (req, reply): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      const before = await getDto(req.params.id);
      if (!before) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);

      const created = await db.transaction(async (tx) => {
        if (!before.assignment) {
          throw err.unprocessable('На заявку не назначена техника — перегонять нечего', {
            purpose: 'Нет техники',
          });
        }
        if (before.status !== 'confirmed') {
          throw err.unprocessable(
            `Заявка в статусе «${requestStatusLabels[before.status]}» — перегон заводят по заявке в работе`,
            { purpose: 'Заявка не в работе' },
          );
        }
        return addRelocation(tx, {
          request: before,
          assignment: before.assignment,
          purpose: body.purpose,
          input: body,
          actor: { id: p.id },
        });
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.create',
        entityType: 'vehicle_route',
        entityId: created.id,
        metadata: {
          number: formatVehicleRouteNumber(created.num),
          purpose: body.purpose,
          requestId: req.params.id,
          routeDate: body.routeDate,
        },
      });
      reply.code(201);
      return (await loadRouteDto(db, created.id))!;
    },
  );

  /**
   * Путевые листы заявки — списком, а не одним (миграция 0087).
   *
   * У грузоперевозки лист по-прежнему один: рейс один. У заказа техники на объект их столько,
   * сколько недель в сроке, — ЭСМ-2 выписывается на каждую, — и «показать лист заявки» перестало
   * быть вопросом с единственным ответом.
   *
   * Аннулированные отдаются наравне с действующими и идут в конце: испорченный и переоформленный
   * бланк остаётся частью истории заявки, а сгоревший номер должно быть видно там же, где выдан.
   */
  r.get(
    '/:id/waybills',
    {
      preHandler: [app.authenticate, app.requirePermission('waybills.read')],
      schema: { params: idParams },
    },
    async (req): Promise<RequestWaybillDto[]> => {
      const p = requirePrincipal(req);
      const request = await getDto(req.params.id);
      if (!request) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, request);

      const rows = await db
        .select({
          id: waybills.id,
          number: waybills.number,
          prefix: waybillSeries.prefix,
          numberWidth: waybillSeries.numberWidth,
          formCode: waybills.formCode,
          status: waybills.status,
          issuedForDate: waybills.issuedForDate,
          periodFrom: waybills.periodFrom,
          periodTo: waybills.periodTo,
          slot: waybillRequests.slot,
          driverName: persons.fullName,
          routeId: waybills.routeId,
          routeNum: vehicleRoutes.num,
        })
        .from(waybillRequests)
        .innerJoin(waybills, eq(waybills.id, waybillRequests.waybillId))
        .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
        .innerJoin(persons, eq(persons.id, waybills.driverPersonId))
        // Рейс — leftJoin: у ЭСМ-2 его нет вовсе, а у листов, выданных до маршрутов, ещё нет.
        .leftJoin(vehicleRoutes, eq(vehicleRoutes.id, waybills.routeId))
        .where(eq(waybillRequests.requestId, request.id))
        // Порядок задан явно, а не оставлен планировщику: действующие листы недели за неделей,
        // аннулированные — следом.
        .orderBy(sql`(${waybills.status} = 'cancelled')`, waybills.issuedForDate, waybills.number);

      return rows.map((row) => ({
        id: row.id,
        number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
        formCode: row.formCode,
        status: row.status,
        issuedForDate: row.issuedForDate,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        slot: row.slot,
        driverName: row.driverName,
        routeId: row.routeId,
        routeNumber: row.routeNum === null ? null : formatVehicleRouteNumber(row.routeNum),
      }));
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
      assertRequestScope(p, before);
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
      // Работу по дням принимает объект: пока за наступивший день никто не расписался, о его
      // машиночасах ещё не договорились, и закрывать по ним заявку рано. Дни перечисляются в
      // отказе — иначе непонятно, куда идти их подтверждать.
      if (transitionRequiresCompletion(status)) {
        const pendingShifts = shiftsCompletionBlocker(before);
        if (pendingShifts) {
          const special = before as SpecialEquipmentRequestDto;
          const dates = await unapprovedPastShiftDates(
            special.id,
            special,
            moscowDateKeyOf(new Date()),
          );
          throw err.unprocessable(`${pendingShifts}: ${listDates(dates)}`, {
            shifts: 'Согласуйте смены',
          });
        }
      }
      // Срок уточняют полями своего типа заявки: тип неизменяем, и «дата начала» у грузоперевозки
      // означала бы, что заявку подменили по дороге.
      if (schedule && schedule.requestType !== before.requestType) {
        throw err.unprocessable('Тип заявки изменить нельзя', { schedule: 'Другой тип заявки' });
      }
      // Возврат в «Новую» стирает работу заявки, и причина ему нужна так же, как отмене: в
      // истории иначе осталась бы пара переходов, по которой не понять, ошиблись машиной,
      // отказался исполнитель или заявку завели не тому объекту. Схема тела спросить это не
      // может — она знает только целевой статус, а требование зависит от исходного.
      const resetsWork = transitionResetsWork(before.status, status);
      if (resetsWork && !comment) {
        throw err.unprocessable(
          `Укажите причину возврата заявки в «${requestStatusLabels.new}» — она снимает технику и рейс`,
          { comment: 'Укажите причину' },
        );
      }
      // Откат снимает назначение — и вместе с ним позволил бы поставить другую машину на дни,
      // работу которых объект уже принял. Тот же запрет, что и у прямой смены техники: иначе он
      // обходился бы в один шаг. Снятие подписи — отдельное видимое действие, и начинают с него.
      if (resetsWork) {
        const approvedShifts = approvedShiftsBlocker(before);
        if (approvedShifts) {
          throw err.unprocessable(
            `${approvedShifts}: возврат в «${requestStatusLabels.new}» снимает технику, а согласованные дни — это работа именно её`,
          );
        }
      }

      // Назначение, факт и уточнённый срок проверяются и пишутся в той же транзакции, что и статус:
      // заявка не должна побыть «в работе» ни на чём, «выполненной» без факта или взятой на одно
      // время с листом на другое — даже мгновение.
      const { assigned, completed, earlyEndDropped, droppedRelocations, esm2 } =
        await db.transaction(async (tx) => {
          // Возврат в «Новую» не спорит с выданной бумагой: заявку, стоящую в действующем листе,
          // стереть с работы нельзя — она пошла бы в чей-то следующий рейс, и одна работа
          // оказалась бы сразу в двух документах (ADR 0050). Строка заявки при этом блокируется
          // тем же `FOR UPDATE`, которым её берёт выписка листа: без блокировки лист успел бы
          // родиться между проверкой и сбросом.
          if (resetsWork) {
            await tx
              .select({ id: vehicleRequests.id })
              .from(vehicleRequests)
              .where(eq(vehicleRequests.id, before.id))
              .for('update', { of: vehicleRequests });
            const issued = await activeWaybillOfRequest(tx, before.id);
            if (issued) throw err.conflict(`${ROLLBACK_WAYBILL_MESSAGE} (${issued})`);
          }
          // Срок — первым: дату рейса путевой лист берёт из заявки, и записанный после выписки он
          // отправил бы лист на заказанное время вместо согласованного.
          if (schedule) await applyConfirmedSchedule(tx, before.id, schedule);
          let saved: VehicleRequestAssignmentDto | null = null;
          if (assignment) {
            saved = await resolveAssignment(tx, assignment, { id: p.id, name: p.fullName });
            await saveAssignment(tx, before.id, before.vehicleTypeId, saved);

            // Заявка кладётся в рейс в этой же транзакции (маршруты): состояния «в работе, а рейса
            // нет» перевод в работу не создаёт. Документ при этом не рождается — лист выписывают с
            // рейса, когда состав собран. На заказ техники на объект, на аренду и на типы без
            // бланка рейс не ведётся вовсе, и это нормальный ход, а не ошибка.
            if (transitionRequiresAssignment(status)) {
              await attachToRoute(tx, {
                request: before,
                assignment: saved,
                route: assignment.route,
                actor: { id: p.id },
              });

              // Доставка техники на объект — по желанию: спецтехника доезжает до площадки своим
              // ходом, и на эту поездку выписывается 4-П, но повезти её могут и тралом. Вывоз
              // заводят позже, из карточки заявки: в этот момент его дату ещё не знают.
              if (assignment.delivery) {
                await addRelocation(tx, {
                  request: before,
                  assignment: saved,
                  purpose: 'delivery',
                  input: assignment.delivery,
                  actor: { id: p.id },
                });
              }
            }
          }
          // Уход из «В работе» рейс не ломает: закрытая заявка остаётся талоном состоявшегося
          // рейса, отменённая и возвращённая в «Новую» выбывает — но только пока рейс не заморожен
          // выписанным листом.
          const droppedRelocations =
            before.status === 'confirmed' && status !== 'confirmed'
              ? await detachOnStatus(tx, before.id, status, p.id)
              : [];
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
          // Возврат в «Новую» снимает и назначение, и факт: «Новая» с машиной, ставками и суммой
          // закрытия читалась бы как заявка, которую с работы не снимали, а повторный перевод в
          // работу молча обошёлся бы прежней техникой (ADR 0027 п. 8) — то есть той самой, из-за
          // которой заявку и откатили. Факт остаётся у заявок, откатанных из «Выполнена» в
          // «В работе», — там его берегут намеренно, и снимает его только следующий шаг назад.
          if (resetsWork) {
            await tx
              .delete(vehicleRequestAssignments)
              .where(eq(vehicleRequestAssignments.requestId, before.id));
            await tx
              .delete(vehicleRequestCompletions)
              .where(eq(vehicleRequestCompletions.requestId, before.id));
            // Дни работы уходят вместе с машиной: машины нет — нет и её смен. Подтверждённых
            // среди них уже не бывает, с ними откат отклонён выше, — стираются черновики часов.
            await dropRequestShifts(tx, before.id);
          }
          const [updated] = await tx
            .update(vehicleRequests)
            // Виза уходит вместе с работой (ADR 0025): заявка возвращается к состоянию «заведена
            // и ждёт решения», а согласовывали руководителю строительства не её, а то, что с ней
            // случилось дальше. Оставленная виза дала бы диспетчеру взять заявку в работу снова,
            // не спросив никого.
            .set({
              status,
              ...(resetsWork ? { approvedBy: null, approvedAt: null } : {}),
              updatedBy: p.id,
              version: before.version + 1,
              updatedAt: new Date(),
            })
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
          // Ожидающий визы запрос на досрочное завершение уходит вместе со статусом (ADR 0044):
          // у закрытой и отменённой заявки сокращать нечего, а «ждёт визы» на ней висело бы вечно
          // и считалось бы в сводке среза.
          const droppedEarlyEnd =
            before.status === 'confirmed' && status !== 'confirmed'
              ? await clearPendingEarlyEnd(tx, before.id)
              : false;
          /*
           * Путевые листы ЭСМ-2 (миграция 0087) — после смены статуса, а не до: сверка читает
           * заявку из базы, и на прежнем статусе она посчитала бы не тот набор недель.
           *
           * Переводом в работу листы рождаются на все недели срока; отменой и возвратом в «Новую»
           * аннулируются вместе с работой. Закрытие срока не меняет и потому ничего не трогает —
           * сверка на нём молчит сама, отдельного условия для этого не нужно.
           */
          const esm2 = await syncEsm2Waybills(tx, {
            requestId: before.id,
            actor: { id: p.id },
            reason: esm2StatusReason(status),
            driverPersonId: assignment?.driverPersonId ?? null,
          });
          return {
            assigned: saved,
            completed: closed,
            earlyEndDropped: droppedEarlyEnd,
            droppedRelocations,
            esm2,
          };
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.status',
        entityType: 'vehicle_request',
        entityId: before.id,
        metadata: {
          from: before.status,
          to: status,
          comment,
          // Убранные перегоны — часть того же события: рейс исчез не сам по себе, а вместе со
          // сменой статуса, и в журнале это должно читаться одной записью.
          ...(droppedRelocations.length > 0 ? { droppedRelocations } : {}),
          // Сброс отмечается и в самом переходе: по журналу должно быть видно, что заявка не
          // просто вернулась в «Новую», а лишилась всего, чем её собирались выполнять.
          ...(resetsWork ? { reset: true } : {}),
          // Выписанные и сгоревшие номера — тем же событием: бланки строгой отчётности изменились
          // не сами по себе, а сменой статуса заявки.
          ...(esm2.issued.length > 0 ? { esm2Issued: esm2.issued } : {}),
          ...(esm2.cancelled.length > 0 ? { esm2Cancelled: esm2.cancelled } : {}),
        },
      });
      // Назначение — отдельное событие истории: «в работе» и «на такой-то машине по такой-то
      // ставке» отвечают на разные вопросы, и второе нужно предъявлять с составом изменений.
      // Снятое возвратом в «Новую» назначение — то же событие с прочерками справа: вопрос «чем
      // выполняли заявку» один, и «ничем, машину сняли» — такой же ответ на него.
      if (assigned || (resetsWork && before.assignment)) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.assign',
          entityType: 'vehicle_request',
          entityId: before.id,
          metadata: {
            vehicleId: assigned?.vehicleId ?? before.assignment!.vehicleId,
            changes: diffVehicleAssignment(before.assignment, assigned),
          },
        });
      }
      // Факт выполнения — тоже своё событие: «Выполнена» отвечает «что с заявкой», закрытие —
      // «сколько отработали и сколько это стоило». Повторное закрытие после отката видно
      // составом изменений: та же работа, но другое время и другая сумма, — а снятый возвратом
      // в «Новую» факт виден прочерками: предъявлять по этой заявке больше нечего.
      if (completed || (resetsWork && before.completion)) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.complete',
          entityType: 'vehicle_request',
          entityId: before.id,
          metadata: { changes: diffVehicleCompletion(before.completion, completed) },
        });
      }
      // Снятый закрытием запрос на досрочное завершение — своё событие: иначе он просто исчезает
      // из списка ожидающих визы, и по истории непонятно, чем кончился.
      if (earlyEndDropped) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.early_end_cancel',
          entityType: 'vehicle_request',
          entityId: before.id,
          metadata: {
            reason: 'closed',
            changes: earlyEndReasonChange(`Заявка переведена в «${requestStatusLabels[status]}»`),
          },
        });
      }
      // Снятая возвратом виза — событие того же вида, что и обычный отзыв визы (ADR 0025):
      // руководителю строительства важно, что заявка снова ждёт его решения, а не то, каким
      // действием она этого дождалась.
      if (resetsWork && before.approvedAt) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.approval_revoke',
          entityType: 'vehicle_request',
          entityId: before.id,
        });
      }
      await auditEsm2Sync({
        actorUserId: p.id,
        requestId: before.id,
        reason: `status:${status}`,
        result: esm2,
      });
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

  // ── Смена назначенной техники у заявки в работе (ADR 0048) ──
  /**
   * Сменить машину и ставки, не трогая статус: заказанная техника сломалась, ушла на другой
   * объект или её перепутали при переводе в работу. До этого маршрута исправить назначение можно
   * было только откатом заявки (ADR 0027 п. 8) — то есть силами администратора и с двумя лишними
   * переходами в истории.
   *
   * Право — `vehicleRequests.status`, то же, которым машину назначают при переводе в работу: это
   * решение диспетчера о том, чем выполнять заявку, а не правка заказа. Общее право правки
   * (`vehicleRequests.update`) сюда не годится — оно есть у площадки, а подбор техники не её дело.
   */
  r.patch(
    '/:id/assignment',
    { ...canChangeStatus, schema: { params: idParams, body: changeVehicleAssignmentSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { version, route, ...rates } = req.body;
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);
      // Арендодатель видит свои заявки и закрывает их (ADR 0038), но подбор техники — не его
      // решение: сменить машину он мог бы только на свою, а вместе с ней и исполнителя заявки.
      assertLessorScope(p, before.assignment?.lessorId ?? null);
      // Предикат общий с порталом (`canReassignVehicle`): у «Новой» машину назначает сам перевод
      // в работу, у закрытой и отменённой менять нечего — там это уже история, а у заявки с
      // принятыми днями работы подмена машины переписала бы задним числом то, под чем стоит
      // подпись объекта.
      if (!canReassignVehicle(before)) {
        const approvedShifts = approvedShiftsBlocker(before);
        if (approvedShifts) {
          throw err.unprocessable(
            `${approvedShifts}: подтверждённые дни — это работа нынешней машины`,
            { vehicleId: 'Есть согласованные смены' },
          );
        }
        throw err.unprocessable(
          before.status === 'confirmed'
            ? 'У заявки нет назначенной техники — её назначает перевод в работу'
            : 'Сменить технику можно только у заявки в работе',
          { vehicleId: 'Заявка не в работе' },
        );
      }

      let esm2: Esm2SyncResult = { cancelled: [], issued: [] };
      const assigned = await db.transaction(async (tx) => {
        const saved = await resolveAssignment(
          tx,
          { ...rates, route },
          { id: p.id, name: p.fullName },
        );
        // Область проверяется и по новой машине, а не только по прежней: иначе арендодатель одним
        // запросом увёл бы заявку на чужую технику — и заодно из собственной видимости.
        assertLessorScope(p, saved.lessorId);
        // Рейс и назначение переезжают одной транзакцией: заявка не должна побыть назначенной на
        // одну машину, а стоящей в рейсе другой — по такой паре не выписать ни лист, ни счёт.
        await moveToRouteOfVehicle(tx, {
          request: before,
          assignment: saved,
          route,
          actor: { id: p.id },
        });
        await saveAssignment(tx, before.id, before.vehicleTypeId, saved);
        const [updated] = await tx
          .update(vehicleRequests)
          .set({ updatedBy: p.id, version: before.version + 1, updatedAt: new Date() })
          .where(and(eq(vehicleRequests.id, before.id), eq(vehicleRequests.version, version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();
        // В бланке ЭСМ-2 напечатана машина — сменив её, лист исправить нельзя, можно только
        // выписать заново (миграция 0087). Машинист при этом наследуется с прежнего листа: меняли
        // технику, а не человека, — если только его не назвали прямо в этом же запросе.
        esm2 = await syncEsm2Waybills(tx, {
          requestId: before.id,
          actor: { id: p.id },
          reason: 'Заявке назначена другая техника — путевые листы переоформлены',
          driverPersonId: rates.driverPersonId ?? null,
        });
        return saved;
      });

      await auditEsm2Sync({
        actorUserId: p.id,
        requestId: before.id,
        reason: 'vehicle_changed',
        result: esm2,
      });
      // То же событие истории, что и у назначения при переводе в работу (ADR 0027 п. 9): вопрос
      // «чем и почём выполняют заявку» один, и ответ на него читается одной строкой «было → стало»
      // независимо от того, каким действием машину поменяли.
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
      return (await getDto(before.id))!;
    },
  );

  // ── Досрочное завершение заказа спецтехники (ADR 0044) ──
  /**
   * Запросить сокращение срока: техника освободилась раньше заказанного.
   *
   * Право — общее право правки заявки: состав ролей у него ровно тот, кому это действие и нужно
   * (площадка, диспетчер, менеджер), а у арендодателя и наблюдателя его нет. Ограничение
   * «объектная роль правит только "Новую"» здесь **не применяется** осознанно: действие
   * придумано ровно для заявки в работе, и просит его как раз тот, кто стоит на площадке, —
   * а решает всё равно не он.
   *
   * Запрос того, кто эту заявку визирует, применяется сразу: согласование состоялось самим фактом
   * обращения (ADR 0025 п. 5, ADR 0032 — администратор под это правило не подпадает, он действует
   * не за объект).
   */
  r.post(
    '/:id/early-end',
    { ...canUpdate, schema: { params: idParams, body: requestVehicleEarlyEndSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { newDateTo, reason, version } = req.body;
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);

      // «Сегодня» считает сервер — тем же способом, что и срез «На объекте» (ADR 0036): часы
      // клиента бывают сбиты, а браузер восточнее Москвы начинает сутки раньше.
      const onDate = moscowDateKeyOf(new Date());
      const blocker = earlyEndBlocker(before, onDate);
      if (blocker) throw err.unprocessable(blocker);
      const special = before as SpecialEquipmentRequestDto;
      if (!isAllowedEarlyEndDate(special, onDate, newDateTo)) {
        const bounds = earlyEndDateBounds(special, onDate)!;
        throw err.unprocessable(
          `Новая дата окончания — с ${dateKeyRu(bounds.min)} по ${dateKeyRu(bounds.max)}`,
          { newDateTo: 'Дата вне срока заявки' },
        );
      }

      const auto = approvesOwnRequestOnCreate(p, before);
      const previousDateTo = special.dateTo!;
      let esm2: Esm2SyncResult = { cancelled: [], issued: [] };
      await db.transaction(async (tx) => {
        const values = {
          // Своя виза не нужна тому, кто её и ставит: запрос сразу записывается согласованным.
          status: auto ? ('approved' as const) : ('pending' as const),
          newDateTo,
          previousDateTo,
          reason,
          requestedBy: p.id,
          requestedAt: new Date(),
          decidedBy: auto ? p.id : null,
          decidedAt: auto ? new Date() : null,
          decisionComment: '',
        };
        // Одна заявка — одна запись: повторный запрос переписывает прежний (ADR 0044). Цепочка
        // при этом не теряется — каждый запрос и каждое решение остаются событием истории.
        await tx
          .insert(vehicleRequestEarlyEndings)
          .values({ requestId: before.id, ...values })
          .onConflictDoUpdate({
            target: vehicleRequestEarlyEndings.requestId,
            set: { ...values, updatedAt: new Date() },
          });
        if (auto) {
          await applyEarlyEnd(tx, before.id, newDateTo);
          // Сокращённый срок переписывает бумагу той же транзакцией (миграция 0087): недели за
          // новой датой аннулируются, а текущая — аннулируется и выписывается заново, с днями по
          // новый последний день включительно. Отработанные недели сверка не трогает.
          esm2 = await syncEsm2Waybills(tx, {
            requestId: before.id,
            actor: { id: p.id },
            reason: `Срок заявки сокращён до ${dateKeyRu(newDateTo)} — путевые листы переоформлены`,
          });
        }
        // Версию поднимает и запрос: он меняет то, что показывает карточка заявки, и второй
        // человек, правящий её с прежней версией, должен получить конфликт, а не тихую перезапись.
        const [updated] = await tx
          .update(vehicleRequests)
          .set({ updatedBy: p.id, version: before.version + 1, updatedAt: new Date() })
          .where(and(eq(vehicleRequests.id, before.id), eq(vehicleRequests.version, version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();
      });

      const after = (await getDto(before.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.early_end_request',
        entityType: 'vehicle_request',
        entityId: before.id,
        metadata: {
          newDateTo,
          previousDateTo,
          changes: diffVehicleEarlyEnd({ previousDateTo, newDateTo, reason }),
        },
      });
      // Собственная виза — отдельным событием с пометкой `auto`, как и при заведении заявки:
      // иначе на вопрос «кто согласовал сокращение» отвечало бы только текущее состояние строки.
      if (auto) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.early_end_approve',
          entityType: 'vehicle_request',
          entityId: before.id,
          metadata: { auto: true, changes: diffVehicleRequests(before, after) },
        });
      }
      await auditEsm2Sync({
        actorUserId: p.id,
        requestId: before.id,
        reason: 'early_end',
        result: esm2,
      });
      return after;
    },
  );

  /**
   * Решение по запросу: виза или отказ. Одним маршрутом — у них одно право, одна область и один
   * инвариант «пока запрос ждёт визы»; раздельные разошлись бы в проверках, как и у визы заявки.
   *
   * Состояние заявки проверяется заново, а не по снимку запроса: между обращением и визой проходит
   * ночь, за которую заявку успевают закрыть, поправить ей срок или просто дожить до запрошенного
   * дня. Виза, поставленная не глядя на это, сократила бы срок задним числом.
   */
  r.patch(
    '/:id/early-end',
    { ...canApprove, schema: { params: idParams, body: decideVehicleEarlyEndSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { approved, comment, version } = req.body;
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);
      // Право на маршруте общее, а решает руководитель своего объекта — тот же, кто визирует
      // саму заявку (ADR 0025 п. 4).
      if (!canApproveRequest(p, before)) {
        throw err.forbidden('Досрочное завершение визирует руководитель этого объекта');
      }

      const pending =
        before.requestType === 'special_equipment' && before.earlyEnd?.status === 'pending'
          ? before.earlyEnd
          : null;
      if (!pending) throw err.unprocessable('Запрос на досрочное завершение не найден');
      let esm2: Esm2SyncResult = { cancelled: [], issued: [] };

      if (approved) {
        const onDate = moscowDateKeyOf(new Date());
        const blocker = earlyEndBlocker(before, onDate);
        if (blocker) throw err.unprocessable(blocker);
        if (!isAllowedEarlyEndDate(before, onDate, pending.newDateTo)) {
          throw err.unprocessable(
            `Запрошенная дата ${dateKeyRu(pending.newDateTo)} больше не годится: срок заявки изменился или день уже прошёл — нужен новый запрос`,
          );
        }
      }

      await db.transaction(async (tx) => {
        await tx
          .update(vehicleRequestEarlyEndings)
          .set({
            status: approved ? 'approved' : 'rejected',
            decidedBy: p.id,
            decidedAt: new Date(),
            decisionComment: comment,
            updatedAt: new Date(),
          })
          .where(eq(vehicleRequestEarlyEndings.requestId, before.id));
        // Срок сокращается той же транзакцией, что и виза: состояния «согласовано, а срок
        // прежний» не бывает — по нему считают и площадку, и аренду. Той же транзакцией
        // переписываются путевые листы (миграция 0087): бумага, утверждающая работу, которой не
        // будет, не должна пережить визу даже на мгновение.
        if (approved) {
          await applyEarlyEnd(tx, before.id, pending.newDateTo);
          esm2 = await syncEsm2Waybills(tx, {
            requestId: before.id,
            actor: { id: p.id },
            reason: `Срок заявки сокращён до ${dateKeyRu(pending.newDateTo)} — путевые листы переоформлены`,
          });
        }
        const [updated] = await tx
          .update(vehicleRequests)
          .set({ updatedBy: p.id, version: before.version + 1, updatedAt: new Date() })
          .where(and(eq(vehicleRequests.id, before.id), eq(vehicleRequests.version, version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();
      });

      const after = (await getDto(before.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: approved ? 'vehicle_request.early_end_approve' : 'vehicle_request.early_end_reject',
        entityType: 'vehicle_request',
        entityId: before.id,
        // У визы состав изменений — сам срок заявки: она его и меняет. У отказа менять нечего,
        // и событие несёт причину: заявка живёт дальше по заказанному сроку, и это надо объяснить.
        metadata: approved
          ? { changes: diffVehicleRequests(before, after) }
          : { changes: earlyEndReasonChange(comment) },
      });
      await auditEsm2Sync({
        actorUserId: p.id,
        requestId: before.id,
        reason: 'early_end',
        result: esm2,
      });
      return after;
    },
  );

  /**
   * Отозвать запрос, пока он ждёт визы: «отбой, техника нужна». Отзывает любой, кто мог его
   * подать, — не только автор: запрос ведут вдвоём с диспетчером, и отбой обычно приходит ему.
   * Решённый запрос не отзывается: согласованный уже сократил срок, отклонённый объясняет, почему
   * этого не произошло.
   */
  r.delete('/:id/early-end', { ...canUpdate, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const before = await getDto(req.params.id);
    if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
    assertRequestScope(p, before);

    const dropped = await db.transaction(async (tx) => {
      const removed = await clearPendingEarlyEnd(tx, before.id);
      if (!removed) return false;
      // Версия считается от текущей строки, а не от прочитанной: отзыв запроса ничего не
      // переписывает в заявке, и отбирать его у того, кто правит её в этот же момент, незачем.
      await tx
        .update(vehicleRequests)
        .set({
          updatedBy: p.id,
          version: sql`${vehicleRequests.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(vehicleRequests.id, before.id));
      return true;
    });
    if (!dropped) throw err.unprocessable('Запрос на досрочное завершение не найден');

    await writeAudit({
      actorUserId: p.id,
      action: 'vehicle_request.early_end_cancel',
      entityType: 'vehicle_request',
      entityId: before.id,
      metadata: { reason: 'withdrawn', changes: earlyEndReasonChange('Запрос отозван') },
    });
    return (await getDto(before.id))!;
  });

  // ── Подтверждение смен по заказу спецтехники ──
  // Техника стоит на объекте неделями, а работа считается по дням: за каждый день заказа — время
  // смены, машиночасы, заправка и подпись объекта. Без подписи по всем наступившим дням заявка не
  // закрывается, а сама она не уходит из среза «На объекте», даже когда срок уже прошёл.

  /**
   * Таблица смен заявки: дни заказа целиком, включая те, за которые ещё ничего не внесли.
   *
   * День среза считает сервер и отдаёт в `onDate` — тем же порядком, что и вкладка «На объекте»
   * (ADR 0036): по нему портал решает, какие строки ещё в будущем и потому неактивны.
   */
  r.get('/:id/shifts', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const request = await getDto(req.params.id);
    if (!request) throw err.notFound('Заявка не найдена');
    assertArchiveVisible(p, request.deletedAt, 'Заявка не найдена');
    assertRequestScope(p, request);
    assertLessorScope(p, request.assignment?.lessorId ?? null);
    const onDate = moscowDateKeyOf(new Date());
    // У грузоперевозки смен нет вовсе: у неё не период работ, а момент подачи. Пустая таблица, а
    // не 422 — карточка спрашивает смены у любой заявки, и отказ ей пришлось бы обходить.
    if (request.requestType !== 'special_equipment') {
      return { items: [], onDate } satisfies VehicleRequestShiftsDto;
    }
    return {
      items: await loadRequestShifts(request.id, request),
      onDate,
    } satisfies VehicleRequestShiftsDto;
  });

  /**
   * Записать смену дня: время, машиночасы, заправку и комментарий. Первое заполнение заводит
   * строку, повторное её переписывает — заготовок на весь период нет намеренно (иначе пустую
   * заготовку было бы не отличить от «день не заполнили», а на этом различии держатся и запрет
   * закрытия, и предупреждение в срезе).
   *
   * Право — общее право правки заявки: часы ведёт тот же, кто ведёт саму заявку. Ограничение
   * «объектная роль правит только "Новую"» здесь **не применяется** осознанно, как и у досрочного
   * завершения (ADR 0044 п. 3): смены появляются ровно у заявки в работе, и заполняет их тот, кто
   * стоит на площадке.
   */
  r.put(
    '/:id/shifts/:date',
    {
      ...canUpdate,
      schema: { params: shiftParams, body: saveVehicleRequestShiftSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { date } = req.params;
      const request = await requireShiftEditableRequest(p, req.params.id, date);
      const before = await loadRequestShift(request.id, date, request);
      // Принятый день не переписывается: иначе часы менялись бы под уже поставленной подписью.
      // Снять подпись может тот же круг, кто её ставил, — и это отдельное, видимое действие.
      if (before?.approvedAt) {
        throw err.unprocessable(
          `Смена за ${dateKeyRu(date)} согласована — сначала снимите согласование`,
        );
      }
      await db.transaction(async (tx) => {
        await saveRequestShift(tx, { requestId: request.id, date, actorId: p.id, input: req.body });
      });
      return await shiftsResponse(request);
    },
  );

  /**
   * Убрать ошибочно заведённый день — пока он не подтверждён. Согласованный день удалению не
   * подлежит: за ним стоит принятая работа, и стирают её снятием подписи, а не молча.
   */
  r.delete('/:id/shifts/:date', { ...canUpdate, schema: { params: shiftParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { date } = req.params;
    const request = await requireShiftEditableRequest(p, req.params.id, date);
    const before = await loadRequestShift(request.id, date, request);
    if (!before) throw err.notFound('Смена не найдена');
    if (before.approvedAt) {
      throw err.unprocessable(
        `Смена за ${dateKeyRu(date)} согласована — сначала снимите согласование`,
      );
    }
    await db.transaction(async (tx) => {
      await deleteRequestShift(tx, request.id, date);
    });
    return await shiftsResponse(request);
  });

  /**
   * Подпись объекта под днём работы — и её снятие. Одним маршрутом, как виза заявки (ADR 0025
   * п. 6): у них одно право, одна область и один инвариант; раздельные разошлись бы в проверках.
   *
   * Подтверждает тот, кто мог бы эту заявку завести (`canConfirmShifts`): решение принимает
   * заказчик — он один видит, во сколько машина вышла и сколько простояла. Снятие нужно не реже
   * подписи: им откатывают заявку и меняют машину, запертые подтверждёнными днями.
   */
  r.post(
    '/:id/shifts/:date/approval',
    {
      ...canCreate,
      schema: { params: shiftParams, body: approveVehicleRequestShiftSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { date } = req.params;
      const { approved } = req.body;
      const request = await requireShiftEditableRequest(p, req.params.id, date);
      // Право на маршруте общее, а подтверждает заказчик этой заявки — как виза руководителя
      // строительства проверяется по объекту, а не по одному лишь праву.
      assertShiftApprover(p, request);
      const before = await loadRequestShift(request.id, date, request);
      // Подтверждают внесённые часы, а не пустой день: подпись под ненаписанным ничего не значит.
      if (!before) {
        throw err.unprocessable(`Смена за ${dateKeyRu(date)} не заполнена — подтверждать нечего`, {
          machineHours: 'Заполните смену',
        });
      }
      if (!!before.approvedAt === approved) return await shiftsResponse(request);

      await db.transaction(async (tx) => {
        await setShiftApproval(tx, { requestId: request.id, date, approved, actorId: p.id });
      });

      const after = (await loadRequestShift(request.id, date, request))!;
      await writeAudit({
        actorUserId: p.id,
        action: approved ? 'vehicle_request.shift_approve' : 'vehicle_request.shift_revoke',
        entityType: 'vehicle_request',
        entityId: request.id,
        metadata: { shiftDate: date, changes: shiftChange(after) },
      });
      return await shiftsResponse(request);
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
      assertRequestScope(p, existing);

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
    assertRequestScope(p, existing);
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

  /**
   * Удаление заявки насовсем (ADR 0070) — общая механика справочников (ADR 0060), право
   * `records.purge`, только из архива. Второй шаг после осознанного первого: пока заявка не
   * удалена, сносить нечего, и одного неверного клика для необратимого действия мало.
   *
   * Детали типа, назначение, смены, закрытие, досрочное завершение, история статусов и связи с
   * файлами уходят каскадом — они существуют только при заявке. Рейс и путевой лист держат её
   * `RESTRICT`: заявку, по которой выписан документ, стереть нельзя, и отказ БД человек читает
   * названием того, кто на неё ссылается.
   */
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(vehicleRequests).where(eq(vehicleRequests.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      const linked = await tx
        .select({ id: files.id, objectKey: files.objectKey })
        .from(vehicleRequestFiles)
        .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
        .where(eq(vehicleRequestFiles.vehicleRequestId, row.id));
      await tx.delete(vehicleRequests).where(eq(vehicleRequests.id, row.id));
      await hardDeleteFiles(tx, linked);
    },
    notFound: 'Заявка не найдена',
    stillLive: 'Заявка не в архиве — сначала удалите её',
    subject: 'заявку',
    audit: {
      action: 'vehicle_request.purge',
      entityType: 'vehicle_request',
      // Номер, заказчик и статус — то, чем заявку называют: после удаления по entityId искать уже
      // нечего, а спрашивают «куда делась ТС-123».
      metadata: (row) => ({
        num: row.num,
        objectId: row.objectId,
        departmentId: row.departmentId,
        requestType: row.requestType,
        status: row.status,
      }),
    },
  });
}
