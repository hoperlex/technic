import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  acceptServiceRequestSchema,
  actsForCounterparty,
  approveServiceEstimateSchema,
  approveServiceItSchema,
  assignServiceSchema,
  attachServiceFilesSchema,
  can,
  canHoldService,
  canResumeService,
  canTransitionServiceStatus,
  completeServiceRequestSchema,
  createServiceRequestSchema,
  declineServiceRequestSchema,
  formatServiceRequestNumber,
  hasCurrentItApproval,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isServiceExecutor,
  isServiceRequestClosed,
  isWarrantyActive,
  isWaitingOn,
  moscowInstantOf,
  officeEquipmentTitle,
  parseServiceRequestNumberSearch,
  putServiceEstimateSchema,
  putServiceExecutorsSchema,
  reopenServiceEstimateSchema,
  reworkServiceRequestSchema,
  roleLabels,
  putServiceConsumablesSchema,
  serviceConsumableIssueIssue,
  serviceRequestKindLabels,
  setServiceConsumablesIssuedSchema,
  SERVICE_ADMIN_ROLLBACKS,
  isServiceClosingDocument,
  SERVICE_CLOSING_DOCUMENT_KINDS,
  SERVICE_REQUEST_STATUSES,
  SERVICE_WAITING_ON,
  serviceCommentSchema,
  serviceFileKindLabels,
  serviceHoldSchema,
  serviceRequestListQuerySchema,
  serviceRequestNeedsClosingDocument,
  serviceRequestStatusLabels,
  serviceRequestWaitingOn,
  serviceResetOnTransition,
  serviceResumeSchema,
  serviceResumeTarget,
  serviceStatusChangeRequiresReason,
  notifyServiceRequestSchema,
  type ServiceRequestNotifyResultDto,
  serviceStatusChangeSchema,
  setServiceUrgencySchema,
  startServiceRequestSchema,
  submitServiceEstimateSchema,
  updateServiceRequestSchema,
  urgencyIssue,
  WARRANTY_EXPIRING_DAYS,
  WARRANTY_REPAIR_ITEM_NAME,
  warrantyDaysLeft,
  warrantyListQuerySchema,
  warrantyState,
  warrantyToday,
  type ServiceExecutorAssignment,
  type ServiceFileKind,
  type ServiceRequestConsumableDto,
  type ServiceRequestKind,
  type ServiceWaitingOn,
  type ServiceWarrantyRowDto,
  type ServiceRequestDto,
  type ServiceRequestExecutorDto,
  type ServiceRequestFileDto,
  type ServiceRequestItemDto,
  type ServiceRequestRequesterPlaceDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  files,
  officeEquipment,
  officeEquipmentConsumables,
  officeEquipmentConsumableStockEntries,
  officeEquipmentTypes,
  serviceRequestConsumables,
  serviceRequestExecutors,
  serviceRequestFiles,
  serviceRequestItems,
  serviceRequests,
  serviceRequestStatusHistory,
  users,
} from '../db/schema';
import { grantPermissionsExpr } from '../services/user-scopes';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  loadServiceLetterData,
  logServiceMailFailure,
  planServiceAssignmentMail,
  planServiceMail,
  queueServiceMails,
  renderServiceLetter,
  serviceMailEventOf,
  type ServiceMailPlan,
} from '../services/service-request-mail';
import { requirePrincipal } from '../auth/plugin';
import { loadPrincipal, type Principal } from '../auth/principal';
import {
  archiveWhere,
  assertArchiveVisible,
  assertServiceRequestDeletable,
  assertServiceRequestEditable,
  assertServiceRequestScope,
  officeEquipmentScopeWhere,
  serviceExecutorVisibilityWhere,
  serviceRequestScopeWhere,
} from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import {
  assertFilesAttachable,
  assertTotalWithinLimit,
  hardDeleteFiles,
  markFilesActive,
  scheduleFilesDeletion,
} from '../services/request-files';
import {
  diffServiceCompletion,
  diffServiceEstimate,
  diffServiceRequests,
  serviceRequestTitle,
} from '../services/service-request-diff';
import { loadServiceRequestHistory } from '../services/service-request-history';

/**
 * Заявки на обслуживание оргтехники (ADR 0085).
 *
 * Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
 * которую согласует заказчик, а после работ — приёмка. Ведут заявку три стороны — заказчик,
 * оператор оргтехники (надстройка роли, ADR 0086) и внешняя сервисная компания, — и у каждой свой
 * коридор переходов (контракты, `allowedServiceStatusTransitions`).
 *
 * Порядок проверок в каждой изменяющей ручке один и тот же:
 * право (`requirePermission`) → область (`assertServiceRequestScope` и область исполнителя) →
 * коридор (`assertTransition`) → условие самого перехода → транзакция со сверкой `version` →
 * история и аудит после неё. Коды отказов: 403 — право, область и коридор; 422 — состояние
 * записи; 409 — конкуренция (версия, ревизия, дубликат) и живые ссылки; 404 — записи нет.
 *
 * Переход, у которого есть содержание, живёт своей ручкой (Р18): `/status` остаётся отмене и
 * административным откатам, у которых из данных только причина.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RequestRow = typeof serviceRequests.$inferSelect;
type RequestPatch = Partial<typeof serviceRequests.$inferInsert>;

const idParams = z.object({ id: z.string().uuid() });
const fileParams = idParams.extend({ fileId: z.string().uuid() });

const NOT_FOUND = 'Заявка не найдена';

// ── Числа и даты ──

/** `numeric` приезжает из драйвера строкой: в DTO суммы должны быть числами. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * Дата гарантии: «дата выполнения + N месяцев» календарём, а не тридцатью днями — в талоне срок
 * тоже написан месяцами. 31 января плюс месяц — это 28 (29) февраля: в феврале 31-го нет, и без
 * подрезки дата уехала бы в март, продлив гарантию на пару дней сверх обещанного.
 */
function addMonths(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1 + months, d!));
  if (at.getUTCDate() !== d) at.setUTCDate(0);
  return at.toISOString().slice(0, 10);
}

// ── Выборка заявки ──

const customerDepartments = alias(departments, 'service_customer_departments');
const equipmentDepartments = alias(departments, 'service_equipment_departments');
const creators = alias(users, 'service_creators');
const approvers = alias(users, 'service_approvers');
/** Кто завизировал от ИТ: своя копия таблицы — согласующий и согласовавший смету бывают разными. */
const itApprovers = alias(users, 'service_it_approvers');
const acceptors = alias(users, 'service_acceptors');
/** Строка сметы, по гарантии которой обращаются, и её заявка: спор ведут по её номеру. */
const claimItems = alias(serviceRequestItems, 'service_claim_items');
const claimRequests = alias(serviceRequests, 'service_claim_requests');
/** Обратная сторона той же ссылки: кто обратился по гарантии этой заявки (`ON DELETE RESTRICT`). */
const claimedItems = alias(serviceRequestItems, 'service_claimed_items');

/**
 * Тип единицы и её объект есть всегда (`NOT NULL` и `RESTRICT`), поэтому они `innerJoin`. Отделы,
 * исполнитель и снимки решений необязательны — `leftJoin` здесь означает ровно «этого ещё не
 * произошло», а не потерянную ссылку.
 *
 * Реквизиты предмета берутся из **заявки**, а не из справочника: единицу переносят и
 * переименовывают, а заявка обязана остаться рассказом о том, что чинили тогда (ADR 0085 §7).
 * Из справочника приходит только название типа — его в снимке нет.
 */
function requestQuery() {
  return db
    .select({
      r: serviceRequests,
      typeName: officeEquipmentTypes.name,
      objectId: constructionObjects.id,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      customerDepartmentId: customerDepartments.id,
      customerDepartmentCode: customerDepartments.code,
      customerDepartmentName: customerDepartments.name,
      equipmentDepartmentId: equipmentDepartments.id,
      equipmentDepartmentCode: equipmentDepartments.code,
      equipmentDepartmentName: equipmentDepartments.name,
      serviceName: counterparties.name,
      createdByName: creators.fullName,
      approvedByName: approvers.fullName,
      itApprovedByName: itApprovers.fullName,
      acceptedByName: acceptors.fullName,
      claimItemName: claimItems.name,
      claimRequestNum: claimRequests.num,
    })
    .from(serviceRequests)
    .innerJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
    .innerJoin(officeEquipmentTypes, eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id))
    .innerJoin(constructionObjects, eq(serviceRequests.equipmentObjectId, constructionObjects.id))
    .innerJoin(creators, eq(serviceRequests.createdBy, creators.id))
    .leftJoin(customerDepartments, eq(serviceRequests.customerDepartmentId, customerDepartments.id))
    .leftJoin(
      equipmentDepartments,
      eq(serviceRequests.equipmentDepartmentId, equipmentDepartments.id),
    )
    .leftJoin(counterparties, eq(serviceRequests.serviceCounterpartyId, counterparties.id))
    .leftJoin(approvers, eq(serviceRequests.estimateApprovedBy, approvers.id))
    .leftJoin(itApprovers, eq(serviceRequests.itApprovedBy, itApprovers.id))
    .leftJoin(acceptors, eq(serviceRequests.acceptedBy, acceptors.id))
    .leftJoin(claimItems, eq(serviceRequests.warrantyClaimItemId, claimItems.id))
    .leftJoin(claimRequests, eq(claimItems.requestId, claimRequests.id));
}

type HeaderRow = Awaited<ReturnType<typeof requestQuery>>[number];

async function itemsByRequest(ids: string[]): Promise<Map<string, ServiceRequestItemDto[]>> {
  const map = new Map<string, ServiceRequestItemDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(serviceRequestItems)
    .where(inArray(serviceRequestItems.requestId, ids))
    .orderBy(asc(serviceRequestItems.sortOrder), asc(serviceRequestItems.createdAt));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      name: row.name,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unitPrice),
      amount: num(row.amount) ?? 0,
      performed: row.performed,
      actualQuantity: num(row.actualQuantity),
      actualAmount: num(row.actualAmount),
      warrantyMonths: row.warrantyMonths,
      warrantyUntil: row.warrantyUntil,
      warrantyUntilManual: row.warrantyUntilManual,
    });
    map.set(row.requestId, list);
  }
  return map;
}

async function filesByRequest(ids: string[]): Promise<Map<string, ServiceRequestFileDto[]>> {
  const map = new Map<string, ServiceRequestFileDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: serviceRequestFiles.requestId,
      kind: serviceRequestFiles.kind,
      attachedAt: serviceRequestFiles.attachedAt,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
    })
    .from(serviceRequestFiles)
    .innerJoin(files, eq(serviceRequestFiles.fileId, files.id))
    .where(and(inArray(serviceRequestFiles.requestId, ids), eq(files.status, 'active')))
    .orderBy(asc(serviceRequestFiles.attachedAt));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      kind: row.kind,
      attachedAt: row.attachedAt.toISOString(),
    });
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * Строки заявки на расходники (Н9). Своей выборкой, по той же причине, что исполнители и смета: их
 * несколько на заявку.
 *
 * Реквизиты позиции читаются из **живой** карточки справочника, а не снимком: строка ссылается на
 * неё `ON DELETE RESTRICT`, и переименование позиции обязано читаться в заявке новым именем. Склад
 * — не история заявки, а действующий перечень.
 *
 * Порядок — по наименованию позиции: у строк заявки своего порядка нет (сортировать по времени
 * заведения нечего — `PUT /:id/consumables` заменяет состав целиком одной вставкой), а карточка
 * обязана показывать их одинаково при каждом открытии.
 */
async function consumablesByRequest(
  ids: string[],
): Promise<Map<string, ServiceRequestConsumableDto[]>> {
  const map = new Map<string, ServiceRequestConsumableDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: serviceRequestConsumables.id,
      requestId: serviceRequestConsumables.requestId,
      consumableId: serviceRequestConsumables.consumableId,
      requestedQuantity: serviceRequestConsumables.requestedQuantity,
      issuedQuantity: serviceRequestConsumables.issuedQuantity,
      issueNote: serviceRequestConsumables.issueNote,
      code: officeEquipmentConsumables.code,
      name: officeEquipmentConsumables.name,
      color: officeEquipmentConsumables.color,
    })
    .from(serviceRequestConsumables)
    .innerJoin(
      officeEquipmentConsumables,
      eq(serviceRequestConsumables.consumableId, officeEquipmentConsumables.id),
    )
    .where(inArray(serviceRequestConsumables.requestId, ids))
    .orderBy(asc(officeEquipmentConsumables.name), asc(officeEquipmentConsumables.code));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      consumableId: row.consumableId,
      code: row.code,
      name: row.name,
      color: row.color,
      requestedQuantity: row.requestedQuantity,
      issuedQuantity: row.issuedQuantity,
      issueNote: row.issueNote,
    });
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * Поимённые исполнители заявок (Н5) — второй слой рядом с исполнителем-контрагентом. Своей
 * выборкой, а не соединением в `requestQuery`: их несколько на заявку, и `leftJoin` размножил бы
 * строки заголовка, испортив и `count`, и страницу.
 */
async function executorsByRequest(ids: string[]): Promise<Map<string, ServiceRequestExecutorDto[]>> {
  const map = new Map<string, ServiceRequestExecutorDto[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: serviceRequestExecutors.requestId,
      userId: serviceRequestExecutors.userId,
      assignedAt: serviceRequestExecutors.assignedAt,
      name: users.fullName,
    })
    .from(serviceRequestExecutors)
    .innerJoin(users, eq(serviceRequestExecutors.userId, users.id))
    .where(inArray(serviceRequestExecutors.requestId, ids))
    .orderBy(asc(serviceRequestExecutors.assignedAt), asc(users.fullName));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({ userId: row.userId, name: row.name, assignedAt: row.assignedAt.toISOString() });
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * Подразделение заявителя (Н11): ссылка со снимком названия. Заполнена ровно одна пара — этого
 * требует `service_requests_requester_place_check`, — поэтому в карточку уходит одно поле, а не
 * два: «и отдел, и площадка» — состояние, которого не бывает.
 */
function requesterPlaceOf(r: RequestRow): ServiceRequestRequesterPlaceDto | null {
  if (r.requesterDepartmentId) {
    return { kind: 'department', id: r.requesterDepartmentId, name: r.requesterDepartmentName };
  }
  if (r.requesterObjectId) {
    return { kind: 'object', id: r.requesterObjectId, name: r.requesterObjectName };
  }
  return null;
}

/**
 * Строка, по которой считается очередь (`serviceRequestWaitingOn`). Три поля вместо статуса: у
 * «Сметы на согласовании» две очереди подряд, и границу между ними проводит только ревизионная
 * виза ИТ (Н3).
 */
function waitingRowOf(r: RequestRow): {
  status: ServiceRequestStatus;
  estimateRevision: number;
  itApprovedEstimateRevision: number | null;
} {
  return {
    status: r.status,
    estimateRevision: r.estimateRevision,
    itApprovedEstimateRevision: r.itApprovedEstimateRevision,
  };
}

function toDto(
  row: HeaderRow,
  items: ServiceRequestItemDto[],
  fileList: ServiceRequestFileDto[],
  executors: ServiceRequestExecutorDto[],
  consumables: ServiceRequestConsumableDto[],
): ServiceRequestDto {
  const r = row.r;
  return {
    id: r.id,
    num: r.num,
    displayNumber: formatServiceRequestNumber(r.num),
    kind: r.kind,
    status: r.status,
    statusChangedAt: r.statusChangedAt.toISOString(),
    /**
     * Кого ждут — считает сервер: правило одно на список, карточку и бейдж раздела (Р35).
     *
     * По **строке**, а не по статусу (Н3): в «Смете на согласовании» ждут двоих по очереди —
     * сперва ИТ («чинить или менять»), потом «Ведение» («согласны на эту сумму»), — и различает
     * их только ревизионная виза.
     */
    waitingOn: serviceRequestWaitingOn(waitingRowOf(r)),
    // Заморозка ходит парой (Р104, Р107): при `on_hold` оба поля непусты, в остальных статусах
    // пусты оба — этого требует CHECK в базе. По `heldFromStatus` считается и «эффективный»
    // статус: виды документов отложенной «Диагностики» — те же, что у неё (Р110).
    heldFromStatus: r.heldFromStatus,
    holdReason: r.holdReason,
    equipment: {
      id: r.officeEquipmentId,
      name: r.equipmentName,
      serialNumber: r.equipmentSerialNumber,
      inventoryNumber: r.equipmentInventoryNumber,
      typeName: row.typeName,
      location: r.equipmentLocation,
    },
    object: { id: row.objectId, code: row.objectCode, name: row.objectName },
    customerDepartment: row.customerDepartmentId
      ? {
          id: row.customerDepartmentId,
          code: row.customerDepartmentCode!,
          name: row.customerDepartmentName!,
        }
      : null,
    equipmentDepartment: row.equipmentDepartmentId
      ? {
          id: row.equipmentDepartmentId,
          code: row.equipmentDepartmentCode!,
          name: row.equipmentDepartmentName!,
        }
      : null,
    requesterPlace: requesterPlaceOf(r),
    description: r.description,
    responsibleName: r.responsibleName,
    responsiblePhone: r.responsiblePhone,
    isUrgent: r.isUrgent,
    urgencyReason: r.urgencyReason,
    // Виза ИТ: снимок решения. `null` — заявка ещё ждёт отдел (Р51).
    itApproval: r.itApprovedAt
      ? {
          by: r.itApprovedBy,
          byName: row.itApprovedByName ?? '',
          at: r.itApprovedAt.toISOString(),
          auto: r.itApprovedAuto,
        }
      : null,
    service: r.serviceCounterpartyId
      ? { id: r.serviceCounterpartyId, name: row.serviceName ?? '' }
      : null,
    executors,
    warrantyClaim: r.warrantyClaimSource
      ? {
          source: r.warrantyClaimSource,
          itemId: r.warrantyClaimItemId,
          itemName: row.claimItemName ?? '',
          sourceRequestNum: row.claimRequestNum,
        }
      : null,
    estimateRevision: r.estimateRevision,
    estimateSubmittedAt: r.estimateSubmittedAt ? r.estimateSubmittedAt.toISOString() : null,
    estimatedTotalAmount: num(r.estimatedTotalAmount),
    approval:
      r.estimateApprovedAt && r.approvedEstimateRevision !== null
        ? {
            by: r.estimateApprovedBy,
            byName: row.approvedByName ?? '',
            at: r.estimateApprovedAt.toISOString(),
            revision: r.approvedEstimateRevision,
          }
        : null,
    items,
    // Строки расходников — предмет заявки этого вида (Н9). У ремонта список пуст: предмет там
    // смета, и двух списков предмета у одной заявки не бывает.
    consumables,
    completion: r.completedAt
      ? {
          completedAt: r.completedAt.toISOString(),
          totalAmount: num(r.finalTotalAmount),
          adjustmentAmount: num(r.finalAdjustmentAmount),
          adjustmentReason: r.finalAdjustmentReason,
        }
      : null,
    acceptedByName: row.acceptedByName ?? '',
    acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
    // Пустой источник у принятой заявки — не ошибка, а след окна выката (план §5, M2): читается
    // он как «принято человеком», и ни портал, ни отчёт не должны считать иначе.
    acceptanceSource: r.acceptanceSource,
    replacementRecommended: r.replacementRecommended,
    comment: r.comment,
    serviceComment: r.serviceComment,
    files: fileList,
    createdByName: row.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    version: r.version,
  };
}

async function loadDtos(rows: HeaderRow[]): Promise<ServiceRequestDto[]> {
  const ids = rows.map((row) => row.r.id);
  const [items, fileMap, executorMap, consumableMap] = await Promise.all([
    itemsByRequest(ids),
    filesByRequest(ids),
    executorsByRequest(ids),
    consumablesByRequest(ids),
  ]);
  return rows.map((row) =>
    toDto(
      row,
      items.get(row.r.id) ?? [],
      fileMap.get(row.r.id) ?? [],
      executorMap.get(row.r.id) ?? [],
      consumableMap.get(row.r.id) ?? [],
    ),
  );
}

async function getDto(id: string): Promise<ServiceRequestDto | null> {
  const [row] = await requestQuery().where(eq(serviceRequests.id, id));
  if (!row) return null;
  const [dto] = await loadDtos([row]);
  return dto ?? null;
}

// ── Область и коридор ──

/**
 * Область сервисной компании по одной записи: она работает только с назначенными ей заявками
 * (ADR 0038). Проверка по строке, а не предикатом выборки: список чужое прячет
 * (`serviceExecutorVisibilityWhere`), а карточка и ход заявки получают запись по id и без неё
 * отдали бы её любому исполнителю, который знает id.
 *
 * Следствие, принятое в ADR 0085 сознательно: «Новую» заявку сервис не видит — исполнителя в ней
 * ещё нет, и заявка ничья.
 */
function assertExecutorScope(p: Principal, serviceCounterpartyId: string | null): void {
  if (!isCounterpartyScopedRole(p.role)) return;
  if (!actsForCounterparty(p, 'service') || serviceCounterpartyId !== p.counterpartyId) {
    throw err.forbidden('Сервисная компания работает только с назначенными ей заявками');
  }
}

/** Обе оси области сразу: заказчик заявки (объект и отделы) и назначенный исполнитель. */
function assertScope(p: Principal, row: RequestRow): void {
  assertServiceRequestScope(p, {
    objectId: row.equipmentObjectId,
    customerDepartmentId: row.customerDepartmentId,
    equipmentDepartmentId: row.equipmentDepartmentId,
  });
  assertExecutorScope(p, row.serviceCounterpartyId);
}

/** Заявка по id — без области и без разбора архива: их спрашивает вызывающий. */
async function loadRow(id: string): Promise<RequestRow> {
  const [row] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id));
  if (!row) throw err.notFound(NOT_FOUND);
  return row;
}

/**
 * Живая заявка в области субъекта — общий вход всех изменяющих ручек. Архивная отвечает 404, а не
 * 403: удалённую заявку не двигают, и знать о её существовании по известному id тоже незачем.
 */
async function requireEditable(p: Principal, id: string): Promise<RequestRow> {
  const row = await loadRow(id);
  if (row.deletedAt) throw err.notFound(NOT_FOUND);
  assertScope(p, row);
  return row;
}

/**
 * Строка заявки под `FOR UPDATE` — первым шагом транзакции, которая решает по её состоянию (Р112).
 * Приём тот же, что у недельной заявки и модуля ТО (`weekly-request-apply.ts`,
 * `vehicle-maintenance.ts`): приёмка и снятие закрывающего документа встречаются на одной строке
 * заявки, и без блокировки `EXISTS` по файлам ничего не гарантирует — между ним и `COMMIT` документ
 * успевают снять.
 *
 * Возвращает строку, перечитанную **после** блокировки: проверки, стоящие за ней, обязаны решать по
 * актуальному состоянию, а не по тому, что вернул `requireEditable` до транзакции.
 */
async function lockRequest(tx: Tx, id: string): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(serviceRequests)
    .where(eq(serviceRequests.id, id))
    .for('update');
  if (!row) throw err.notFound(NOT_FOUND);
  return row;
}

/**
 * Признаки назначения, которых до чтения заявки знать неоткуда: субъект **мог бы** оказаться и
 * назначенным подрядчиком, и поимённым исполнителем. Ими спрашивается предварительный отсев
 * `assertSideAllowed` — «бывает ли у этой стороны такой ход вообще», — а настоящее назначение
 * считается по строке (`executorAssignment`) и проверяется вторым разом уже в обработчике.
 *
 * Ответить здесь «не назначен» было бы неверно: у поимённого исполнителя дуги исполнителя
 * открываются назначением, и предварительный отсев отбирал бы их у него, не заглянув в заявку.
 * Ответить «назначен» безопасно ровно потому, что проверка повторяется: `isServiceExecutor` всё
 * равно спросит у поимённого `serviceRequests.execute`, а у подрядчика — тип контрагента.
 */
const MAYBE_ASSIGNED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: true,
  isNamedExecutor: true,
};

/**
 * Кто субъект **на этой заявке** (Н5): оператор назначенного контрагента, поимённый исполнитель —
 * или никто. Пара признаков, а не готовый ответ: решение по ним принимает `isServiceExecutor` из
 * контрактов, и второго правила рядом с ним заводить нельзя.
 *
 * Строка исполнителей спрашивается только у того, кто вообще может быть назначен поимённо: без
 * `serviceRequests.execute` ответ всё равно «не исполнитель», и лишний запрос в базу на каждом
 * ходе оператора не нужен.
 */
async function executorAssignment(
  p: Principal,
  row: RequestRow,
): Promise<ServiceExecutorAssignment> {
  const actsForAssignedCounterparty =
    row.serviceCounterpartyId !== null && row.serviceCounterpartyId === p.counterpartyId;
  if (!can(p, 'serviceRequests.execute')) {
    return { actsForAssignedCounterparty, isNamedExecutor: false };
  }
  const [named] = await db
    .select({ userId: serviceRequestExecutors.userId })
    .from(serviceRequestExecutors)
    .where(
      and(eq(serviceRequestExecutors.requestId, row.id), eq(serviceRequestExecutors.userId, p.id)),
    )
    .limit(1);
  return { actsForAssignedCounterparty, isNamedExecutor: !!named };
}

/**
 * Чужая сторона отсекается **до** чтения записи.
 *
 * Специализированная ручка описывает одну дугу коридора (Р18), и субъекту, у которого этой дуги
 * нет вовсе, отказывают сразу: ни область, ни состояние заявки ответа не изменят, а «шаг
 * исполнителя» у оператора должен упираться в прямое «это не ваш шаг», а не в 404 чужой заявки.
 * Одного права на маршруте для этого мало: `serviceRequests.status` есть и у оператора, и у
 * сервиса, а переходы за ним стоят разные (Р17).
 *
 * Настоящий исходный статус здесь неизвестен, поэтому проверка повторяется в обработчике
 * (`assertTransition`) — уже по нему.
 */
function assertSideAllowed(
  p: Principal,
  to: ServiceRequestStatus,
  from: readonly ServiceRequestStatus[] = SERVICE_REQUEST_STATUSES,
): void {
  if (from.some((status) => canTransitionServiceStatus(status, to, p, MAYBE_ASSIGNED))) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(
    `${who} не переводит заявку в «${serviceRequestStatusLabels[to]}» — это шаг другой стороны`,
  );
}

/**
 * Переход доступен субъекту — коридор из контрактов (Р17). 403, а не 422: сам переход существует,
 * но не для этой стороны — оператор не ведёт смету, а сервис не принимает работу за заказчика.
 *
 * Признаки назначения обязательны у ходов исполнителя (Н5): их открывает **факт назначения**, а
 * не право, и посчитаны они должны быть по строке заявки (`executorAssignment`). Опущенные, они
 * означают «сторона исполнителя определяется одним субъектом» — так спрашивают ручки, у которых
 * шага исполнителя нет вовсе (отмена, откаты, заморозка).
 */
function assertTransition(
  p: Principal,
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
  assignment?: ServiceExecutorAssignment,
): void {
  if (canTransitionServiceStatus(from, to, p, assignment)) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(
    `${who} не может перевести заявку «${serviceRequestStatusLabels[from]}» → «${serviceRequestStatusLabels[to]}»`,
  );
}

/**
 * Ход исполнителя, который **не меняет статуса**: правка состава сметы, снятие согласования,
 * примечание сервиса. Коридора у таких ручек нет — двигать нечего, — а сторона у них та же, и
 * спросить её всё равно надо: маршрут открыт «одному из прав» (`estimate` **или** `execute`), и
 * без этой проверки держатель `execute` правил бы смету любой заявки, на которую его не назначали.
 *
 * Дизъюнкция здесь та же, что в коридоре контрактов (`allowedServiceStatusTransitions`), и в том
 * же порядке: **назначение** — `isServiceExecutor`, единственный ответ модуля на вопрос «чей это
 * ход», — **либо** право сметы, которым «Ведение» и администратор доводят заявку за исполнителя.
 * Второй ветки достаточно и для сервисной компании: до этой строки доходит только назначенная —
 * чужую отсекла область (`assertExecutorScope` внутри `requireEditable`).
 *
 * Строку заявки функция получает готовой: спрашивается она после `requireEditable`, потому что
 * назначение считается по самой заявке, а не по правам субъекта.
 */
async function assertExecutorSide(p: Principal, row: RequestRow, action: string): Promise<void> {
  if (isServiceExecutor(p, await executorAssignment(p, row))) return;
  if (can(p, 'serviceRequests.estimate')) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(`${who} не ${action} — это шаг назначенного исполнителя`);
}

/**
 * Держит и отпускает заявку тот, кто её ведёт (Р105) — предикатом контрактов, а не правом на
 * маршруте (план §7.3): `canHoldService` отвечает «есть `hold` **или** есть `status`», и той же
 * функцией спрашивает портал. Исполнителю заморозка закрыта при любом праве: о задержке он
 * сообщает примечанием.
 */
/**
 * Чей ход — правка факта выдачи (§7.3 плана). Предикат тот же, что у ходов исполнителя, и записан
 * один раз на оба случая: **оператор назначенного контрагента либо поимённый исполнитель с
 * `serviceRequests.execute`** (`isServiceExecutor` контрактов — единственный ответ модуля на вопрос
 * «чей это ход») **либо обладатель `serviceRequests.status`** — «Ведение», которое разбирает ошибки
 * и доводит заявку за любую сторону (§6.2).
 *
 * Второй ветки достаточно и для сервисной компании, если её оператор дошёл сюда через право хода:
 * чужую заявку отсекла область (`assertExecutorScope` внутри `requireEditable`).
 */
async function assertConsumableIssuer(p: Principal, row: RequestRow): Promise<void> {
  if (isServiceExecutor(p, await executorAssignment(p, row))) return;
  if (can(p, 'serviceRequests.status')) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(`${who} не отмечает выдачу по этой заявке — это шаг назначенного исполнителя`);
}

/**
 * Смета — принадлежность ремонта, и у заявки на расходники её нет вовсе (план §6.2: «та же таблица
 * без строк сметы и без визы ИТ»). Страж стоит в **каждой** из пяти дверей сметного круга, хотя
 * достижимы снаружи только две — правка состава и предъявление: остальные три требуют статуса
 * «Смета на согласовании», куда без предъявления не попасть. Опираться на эту недостижимость
 * значило бы держать защиту на выводе о чужом коде — а он меняется; строка на ручку дешевле.
 *
 * 422, а не 403: право у человека есть, негоден предмет — эта заявка не про ремонт.
 */
function assertRepairKind(row: RequestRow, action: string): void {
  if (row.kind !== 'consumable') return;
  throw err.unprocessable(`Заявка на расходники сметы не имеет: ${action} нечего`, {
    kind: 'Не тот вид заявки',
  });
}

function assertCanHold(p: Principal, action: string): void {
  if (canHoldService(p)) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(`${who} не ${action} — это шаг того, кто её ведёт`);
}

// ── Ссылки на смету по гарантии ──

/**
 * Кто обратился по гарантии строк этой заявки. Ссылка `warranty_claim_item_id` объявлена
 * `ON DELETE RESTRICT`, поэтому и замена состава сметы, и удаление заявки насовсем упёрлись бы в
 * неё ошибкой целостности. Человеку нужен не код 23503, а номера заявок, которые на неё сослались:
 * спор с сервисом ведут именно по ним.
 */
async function claimingRequestNumbers(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ num: serviceRequests.num })
    .from(serviceRequests)
    .innerJoin(claimedItems, eq(serviceRequests.warrantyClaimItemId, claimedItems.id))
    .where(eq(claimedItems.requestId, requestId));
  return rows.map((row) => formatServiceRequestNumber(row.num));
}

/** Смету, ставшую источником гарантийного обращения, не переписывают: 409 с номерами обращений. */
async function assertEstimateReplaceable(tx: Tx, requestId: string): Promise<void> {
  const nums = await claimingRequestNumbers(tx, requestId);
  if (nums.length === 0) return;
  throw err.conflict(
    `По гарантии этой сметы обратились: ${nums.join(', ')} — менять её состав нельзя`,
  );
}

// ── Гарантийное обращение (Р26) ──

interface WarrantyClaimColumns {
  source: 'equipment' | 'item' | null;
  itemId: string | null;
}

/**
 * По чьей гарантии обращаются — с проверкой основания, а не с записью флага.
 *
 * У источника `equipment` условие одно: гарантия поставщика на саму единицу заполнена и действует
 * на сегодня. У источника `item` их четыре, и каждое отвечает на свой вопрос спора: та ли это
 * техника, состоялся ли ремонт (заявка принята), сделали ли именно эту работу и не кончился ли
 * срок. Отказы — 422: запрос понятен, не годится названное основание.
 */
async function resolveWarrantyClaim(
  tx: Tx,
  claim: { source?: 'equipment' | 'item' | null; itemId?: string | null } | undefined,
  equipment: { id: string; warrantyUntil: string | null },
  currentRequestId: string | null,
): Promise<WarrantyClaimColumns> {
  if (!claim?.source) return { source: null, itemId: null };
  const today = warrantyToday();

  if (claim.source === 'equipment') {
    if (!isWarrantyActive(equipment.warrantyUntil, today)) {
      throw err.unprocessable(
        equipment.warrantyUntil
          ? `Гарантия поставщика на эту технику истекла ${equipment.warrantyUntil} — обращаться по ней нельзя`
          : 'У этой техники не заведён срок гарантии поставщика',
        { warrantyClaim: 'Гарантия не действует' },
      );
    }
    return { source: 'equipment', itemId: null };
  }

  const [row] = await tx
    .select({
      id: serviceRequestItems.id,
      name: serviceRequestItems.name,
      performed: serviceRequestItems.performed,
      warrantyUntil: serviceRequestItems.warrantyUntil,
      requestId: serviceRequests.id,
      requestNum: serviceRequests.num,
      requestStatus: serviceRequests.status,
      requestDeletedAt: serviceRequests.deletedAt,
      requestEquipmentId: serviceRequests.officeEquipmentId,
    })
    .from(serviceRequestItems)
    .innerJoin(serviceRequests, eq(serviceRequestItems.requestId, serviceRequests.id))
    .where(eq(serviceRequestItems.id, claim.itemId!));
  if (!row || row.requestDeletedAt) {
    throw err.unprocessable('Позиция прошлого ремонта не найдена', {
      warrantyClaim: 'Позиция не найдена',
    });
  }
  const source = formatServiceRequestNumber(row.requestNum);
  if (row.requestEquipmentId !== equipment.id) {
    throw err.unprocessable(`Позиция из заявки ${source} относится к другой единице техники`, {
      warrantyClaim: 'Другая техника',
    });
  }
  if (currentRequestId && row.requestId === currentRequestId) {
    throw err.unprocessable('Обращаться можно по гарантии другой заявки, а не этой же', {
      warrantyClaim: 'Это та же заявка',
    });
  }
  // Именно «Принята», а не «закрыта»: пока источник ждёт приёмки, вторую заявку на ту же единицу
  // не даёт завести уникальный индекс (Р21), так что состояние «Ожидает приёмки» здесь недостижимо.
  if (row.requestStatus !== 'accepted') {
    throw err.unprocessable(`Заявка ${source} ещё не принята — по её гарантии не обращаются`, {
      warrantyClaim: 'Заявка-источник не принята',
    });
  }
  if (row.performed !== true) {
    throw err.unprocessable(
      `Позиция «${row.name}» в заявке ${source} не выполнялась — гарантии на неё нет`,
      { warrantyClaim: 'Работа не выполнялась' },
    );
  }
  if (!isWarrantyActive(row.warrantyUntil, today)) {
    throw err.unprocessable(
      row.warrantyUntil
        ? `Гарантия на «${row.name}» истекла ${row.warrantyUntil}`
        : `На позицию «${row.name}» гарантия не давалась`,
      { warrantyClaim: 'Гарантия не действует' },
    );
  }
  return { source: 'item', itemId: row.id };
}

// ── Одна открытая заявка на единицу (Р21) ──
//
// **На единицу И НА ВИД** (В12, миграция `0177`): ремонт и расходники по одному аппарату друг другу
// не мешают — картридж просят и тому принтеру, который сейчас в ремонте, — а два открытых ремонта
// по-прежнему означали бы два сервиса, два акта и две гарантии на одну работу. Проверка повторяет
// условие пары частичных индексов `service_requests_open_repair_unique` и `…_open_consumable_unique`
// затем, что человеку нужен номер занявшей место заявки, а не `23505`.

async function assertNoOpenRequest(
  tx: Tx,
  equipmentId: string,
  kind: ServiceRequestKind,
  exceptId?: string,
): Promise<void> {
  const [open] = await tx
    .select({ num: serviceRequests.num })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipmentId),
        eq(serviceRequests.kind, kind),
        isNull(serviceRequests.deletedAt),
        notInArray(serviceRequests.status, ['accepted', 'cancelled']),
        exceptId ? ne(serviceRequests.id, exceptId) : undefined,
      ),
    );
  if (!open) return;
  // Номер в ответе — не украшение: портал вместо глухого отказа предлагает открыть эту заявку.
  throw err.conflict(
    `По этой технике уже есть незакрытая заявка ${formatServiceRequestNumber(open.num)} (${serviceRequestKindLabels[kind].toLowerCase()}) — откройте её`,
  );
}

// ── Строки заявки на расходники и склад (§4 набросков, Р1–Р8) ──

/**
 * Позиции номенклатуры, названные в теле, — с проверкой, что они вообще есть в справочнике.
 * Внешний ключ строки заявки поймал бы то же самое, но ответом `23503`: человек, выбравший позицию
 * из подсказки, которую в этот момент удалили, должен прочитать про неё словами.
 *
 * Гашение позиции (`is_active = false`) заведению строки НЕ мешает: оно говорит «больше не
 * закупаем», а не «этой позиции нет». Что погашенное не предлагают в форме — дело подсказки, а не
 * отказа сервера.
 */
async function assertConsumablesExist(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: officeEquipmentConsumables.id })
    .from(officeEquipmentConsumables)
    .where(inArray(officeEquipmentConsumables.id, [...ids]));
  if (rows.length === ids.length) return;
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  throw err.unprocessable(
    missing.length === 1
      ? 'Позиция номенклатуры не найдена — обновите справочник и выберите заново'
      : `Позиций номенклатуры не найдено: ${missing.length} — обновите справочник и выберите заново`,
    { consumables: 'Позиция не найдена' },
  );
}

/** Строка заявки вместе с реквизитами позиции: их называет и отказ по остатку, и причина события. */
interface ConsumableLineRow {
  id: string;
  consumableId: string;
  code: string;
  name: string;
  requestedQuantity: number;
  issuedQuantity: number | null;
  issueNote: string;
}

/**
 * Строки заявки под её блокировкой. Своего `FOR UPDATE` у них нет и не нужно: строка заявки уже
 * взята `lockRequest`, а состав правит только та же заявка. Дерутся за **карточки склада**, и
 * порядок их захвата задан ниже.
 */
async function consumableLinesOf(tx: Tx, requestId: string): Promise<ConsumableLineRow[]> {
  return tx
    .select({
      id: serviceRequestConsumables.id,
      consumableId: serviceRequestConsumables.consumableId,
      code: officeEquipmentConsumables.code,
      name: officeEquipmentConsumables.name,
      requestedQuantity: serviceRequestConsumables.requestedQuantity,
      issuedQuantity: serviceRequestConsumables.issuedQuantity,
      issueNote: serviceRequestConsumables.issueNote,
    })
    .from(serviceRequestConsumables)
    .innerJoin(
      officeEquipmentConsumables,
      eq(serviceRequestConsumables.consumableId, officeEquipmentConsumables.id),
    )
    .where(eq(serviceRequestConsumables.requestId, requestId));
}

/** Что уехало со склада (или вернулось на него) одним действием — строкой аудита и ответа. */
interface ConsumableMovement {
  lineId: string;
  consumableId: string;
  code: string;
  name: string;
  entryKind: 'issue' | 'return';
  /** Всегда положительное: направление называет `entryKind`. */
  quantity: number;
  quantityBefore: number;
  quantityAfter: number;
}

/**
 * Факт выдачи по строкам заявки и вызванное им движение склада — **одной транзакцией** с тем
 * действием, которое факт и меняет (Р5).
 *
 * ЧТО ДВИГАЕТ СКЛАД. Не смена статуса, а **изменение факта** (Р6): каждая правка порождает событие
 * на разницу — было 2, стало 3, значит `issue` на единицу; было 2, стало 0, значит `return` на две.
 * Отсюда поведение на всех путях назад само собой: возврат на доработку, отмена и откат склада не
 * касаются вовсе, а повторное «Решена» списывает только разницу, если факт изменился. Признак «уже
 * списано» не нужен — его роль играет само «выдано».
 *
 * ПОРЯДОК ЗАХВАТА, и переставить его нельзя: строка заявки (её берёт вызывающий, `lockRequest`) →
 * карточки склада `FOR UPDATE` **в порядке возрастания `consumable_id`** → проверка остатков →
 * `UPDATE` количества и `INSERT` события. Сортировка именно по позиции склада, а не по строке
 * заявки: дерутся две заявки не за свои строки — те у каждой свои, — а за общие карточки
 * номенклатуры, которые берёт `FOR UPDATE` ещё и триггер цепочки (`0172`). Отсортируй мы строки
 * заявки, две заявки с одними и теми же позициями брали бы их в противоположном порядке и давали
 * `40P01` вместо закрытия (тест `service-request-consumables.db.test.ts`).
 *
 * `UPDATE` карточки идёт **перед** `INSERT` события: триггер цепочки сверяет «стало» события с
 * фактическим остатком карточки, и событие, вставленное раньше правки, будет отбито.
 *
 * ПРИЧИНУ СОБЫТИЯ ПИШЕТ СЕРВЕР (план §7.3). `reason` журнала обязателен всегда (`CHECK` в `0172`),
 * а `issue_note` строки объясняет расхождение факта с запрошенным и при обычной выдаче пуст: это
 * разные поля, и подставлять одно вместо другого нельзя.
 */
async function applyConsumableFacts(
  tx: Tx,
  params: {
    request: { id: string; num: number; kind: ServiceRequestKind };
    actor: Principal;
    /** Присланные факты; строки, которых здесь нет, остаются как были. */
    facts: readonly { id: string; issuedQuantity: number; issueNote: string }[];
    /**
     * Закрытие работ: факт обязан быть у **каждой** строки — своим значением в теле либо уже
     * проставленный правкой. Умолчание «сколько просили» подставляет форма, а не сервер: списывать
     * со склада по молчанию клиента он не должен (контракт `completeServiceRequestSchema`).
     */
    requireEveryLine: boolean;
  },
): Promise<ConsumableMovement[]> {
  const { request, actor, facts } = params;
  const lines = await consumableLinesOf(tx, request.id);
  if (request.kind !== 'consumable') {
    if (facts.length > 0) {
      throw err.unprocessable('Строки номенклатуры бывают только у заявки на расходники', {
        consumables: 'Не тот вид заявки',
      });
    }
    return [];
  }

  const byId = new Map(lines.map((line) => [line.id, line]));
  const wanted = new Map<string, { issuedQuantity: number; issueNote: string }>();
  for (const fact of facts) {
    if (!byId.has(fact.id)) {
      throw err.unprocessable('В заявке нет такой строки номенклатуры — обновите карточку', {
        consumables: 'Строка не найдена',
      });
    }
    if (wanted.has(fact.id)) {
      throw err.unprocessable('Строка номенклатуры названа дважды — оставьте одну отметку', {
        consumables: 'Повтор строки',
      });
    }
    wanted.set(fact.id, { issuedQuantity: fact.issuedQuantity, issueNote: fact.issueNote });
  }

  /** Строка, которую надо записать: новый факт, его причина и разница со списанным. */
  const targets: { line: ConsumableLineRow; issued: number; note: string; delta: number }[] = [];
  for (const line of lines) {
    const fact = wanted.get(line.id);
    if (!fact) {
      if (params.requireEveryLine && line.issuedQuantity === null) {
        throw err.unprocessable(
          `По строке «${line.name}» нет отметки о выдаче — укажите, сколько выдали`,
          { consumables: 'Заполните все строки' },
        );
      }
      continue;
    }
    // Правило одно на сервер и портал (`serviceConsumableIssueIssue`), а `CHECK`
    // `service_request_consumables_note_check` повторяет его последним рубежом.
    const issue = serviceConsumableIssueIssue({
      requestedQuantity: line.requestedQuantity,
      issuedQuantity: fact.issuedQuantity,
      issueNote: fact.issueNote,
    });
    if (issue) {
      throw err.unprocessable(`${line.name}: ${issue}`, { consumables: issue });
    }
    targets.push({
      line,
      issued: fact.issuedQuantity,
      note: fact.issueNote,
      delta: fact.issuedQuantity - (line.issuedQuantity ?? 0),
    });
  }

  /**
   * СОРТИРОВКА ПО ПОЗИЦИИ СКЛАДА, А НЕ ПО СТРОКЕ ЗАЯВКИ. Строки заявки — случайные `uuid`, у каждой
   * заявки свои: две заявки с одними и теми же позициями брали бы их в противоположном порядке, и
   * встречное ожидание дало бы `40P01` вместо закрытия. Общий порядок обязан быть у того, за что
   * дерутся, — у карточки склада.
   */
  const moving = targets
    .filter((target) => target.delta !== 0)
    .sort((a, b) =>
      a.line.consumableId < b.line.consumableId
        ? -1
        : a.line.consumableId > b.line.consumableId
          ? 1
          : 0,
    );

  const now = new Date();
  const movements: ConsumableMovement[] = [];
  // Карточка берётся своим `FOR UPDATE` — по одной и в этом порядке, а не одной выборкой по списку:
  // порядок захвата обязан читаться в коде, а не выводиться из плана запроса. Позиция в заявке
  // одна на строку (`service_request_consumables_unique`), поэтому дважды одну и ту же карточку
  // цикл не берёт.
  for (const target of moving) {
    const [card] = await tx
      .select({ quantity: officeEquipmentConsumables.quantity })
      .from(officeEquipmentConsumables)
      .where(eq(officeEquipmentConsumables.id, target.line.consumableId))
      .for('update');
    // Позицию, на которую ссылается строка заявки, не удаляет никто (`ON DELETE RESTRICT`), — но
    // отвечать «не найдено» лучше словами, чем разыменованием пустоты.
    if (!card) throw err.notFound('Позиция номенклатуры не найдена');
    const before = card.quantity;
    const after = before - target.delta;
    if (after < 0) {
      // Отказ, а не минус (Р7): `quantity >= 0` стоит `CHECK`ом, и выходов у человека два — оба
      // законные, и оба названы в тексте.
      throw err.unprocessable(
        `${target.line.name} (${target.line.code}): на складе ${before}, выдаётся ${target.delta}. Исправьте выданное количество или пополните остаток`,
        { consumables: 'Не хватает остатка' },
      );
    }
    await tx
      .update(officeEquipmentConsumables)
      .set({ quantity: after, updatedBy: actor.id, updatedAt: now })
      .where(eq(officeEquipmentConsumables.id, target.line.consumableId));
    const entryKind = target.delta > 0 ? 'issue' : 'return';
    const head = `${entryKind === 'issue' ? 'Выдано' : 'Возврат'} по заявке ${formatServiceRequestNumber(request.num)}`;
    await tx.insert(officeEquipmentConsumableStockEntries).values({
      consumableId: target.line.consumableId,
      entryKind,
      serviceRequestId: request.id,
      serviceRequestConsumableId: target.line.id,
      quantityBefore: before,
      quantityAfter: after,
      reason: target.note ? `${head}: ${target.note}` : head,
      changedBy: actor.id,
    });
    movements.push({
      lineId: target.line.id,
      consumableId: target.line.consumableId,
      code: target.line.code,
      name: target.line.name,
      entryKind,
      quantity: Math.abs(target.delta),
      quantityBefore: before,
      quantityAfter: after,
    });
  }

  // Факт строки пишется после событий: обе стороны инварианта сверяет отложенный триггер на
  // коммите (`0186`), и порядок внутри транзакции ему безразличен — важно, что обе половины
  // изменены одной транзакцией.
  for (const target of targets) {
    if (target.issued === target.line.issuedQuantity && target.note === target.line.issueNote) {
      continue;
    }
    await tx
      .update(serviceRequestConsumables)
      .set({ issuedQuantity: target.issued, issueNote: target.note, updatedAt: now })
      .where(eq(serviceRequestConsumables.id, target.line.id));
  }
  return movements;
}

// ── Переход статуса ──

/**
 * Перевод заявки с проверкой версии, сбросом по матрице возвратов и записью в историю статусов.
 *
 * Что стирается при возврате назад, решает контракт (`serviceResetOnTransition`), а не маршрут:
 * матрица §5.4 покрывает все дуги — и операторские, и административные, — и разъехаться с
 * порталом она не должна.
 *
 * `status_changed_at` обновляется только при смене статуса и при переназначении, где статус тот же
 * (`touchStatusAt`): правка сметы, примечание исполнителя и подшивка документа возраст ожидания не
 * сбрасывают — иначе очередь «дольше всех ждут» обнулялась бы каждой мелкой правкой.
 */
/**
 * Гарантия, снятая вместе с фактом закрытия. Уходит в metadata аудита того действия, которое факт и
 * сняло: сама строка сметы своё прошлое не помнит (Р77).
 */
interface ClearedWarranty {
  itemId: string;
  name: string;
  warrantyUntil: string | null;
}

async function applyTransition(
  tx: Tx,
  params: {
    row: RequestRow;
    to: ServiceRequestStatus;
    version: number;
    actor: Principal;
    comment?: string;
    /** Поля, которые пишет сама ручка: исполнитель, снимок решения, суммы. */
    patch?: RequestPatch;
    touchStatusAt?: boolean;
    /**
     * План письма службе, посчитанный **до** транзакции (Р67): адресаты и обратные адреса ходят в
     * базу и в конфигурацию, и упавшие внутри они откатили бы саму заявку. `null` — переход письма
     * не шлёт.
     */
    mail?: ServiceMailPlan | null;
  },
): Promise<{ mailFailed: boolean; clearedWarranties: ClearedWarranty[] }> {
  const { row, to, actor } = params;
  const reset = serviceResetOnTransition(row.status, to);
  const now = new Date();
  const set: RequestPatch = {};
  /** Гарантии, снятые вместе с фактом: уходят в metadata аудита вызывающей ручки (Р77). */
  let warrantySnapshot: ClearedWarranty[] = [];

  if (reset.itApproval) {
    set.itApprovedBy = null;
    set.itApprovedAt = null;
    set.itApprovedAuto = false;
  }
  if (reset.executor) {
    set.serviceCounterpartyId = null;
    // Оба слоя разом (Н5): «заявка снова ничья» означает и снятого подрядчика, и пустой список
    // поимённых. Снимай мы только колонку — отменённая заявка осталась бы за своим сисадмином, а
    // отложенный триггер `service_requests_executor_present` этого не заметил бы: у неё
    // исполнитель формально есть.
    await tx.delete(serviceRequestExecutors).where(eq(serviceRequestExecutors.requestId, row.id));
  }
  if (reset.estimate) {
    await assertEstimateReplaceable(tx, row.id);
    await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, row.id));
    set.estimateRevision = 0;
    set.estimateSubmittedAt = null;
    set.estimatedTotalAmount = null;
  }
  if (reset.approval) {
    set.approvedEstimateRevision = null;
    set.estimateApprovedBy = null;
    set.estimateApprovedAt = null;
  }
  if (reset.completion) {
    /**
     * Что за гарантии снимаются — снимком **до** очистки (план
     * `office-equipment-mail-and-history-plan.md`, Р77). `service_request_items.warranty_until`
     * хранит одно последнее значение: закрытие его перезаписывает, возврат обнуляет, и «что нам
     * обещали в марте» после этого не восстановить ни лентой, ни отчётом.
     *
     * Снимок снимается здесь, где происходит очистка, а не в ручках: путей к ней два — возврат на
     * доработку и административный `done → in_work`, — и третий, заведённый однажды, оказался бы
     * без снимка молча.
     */
    warrantySnapshot = await tx
      .select({
        itemId: serviceRequestItems.id,
        name: serviceRequestItems.name,
        warrantyUntil: serviceRequestItems.warrantyUntil,
      })
      .from(serviceRequestItems)
      .where(
        and(
          eq(serviceRequestItems.requestId, row.id),
          isNotNull(serviceRequestItems.warrantyUntil),
        ),
      );

    // Факт снимается целиком, вместе с гарантиями. Дату из талона сохранить нельзя, хотя она и
    // введена руками: CHECK не допускает гарантию у строки без выполнения, а выполнение возврат как
    // раз снимает. При повторном закрытии дату присылают снова — она приходит той же ручкой.
    await tx
      .update(serviceRequestItems)
      .set({
        performed: null,
        actualQuantity: null,
        warrantyUntil: null,
        warrantyUntilManual: false,
        updatedAt: now,
      })
      .where(eq(serviceRequestItems.requestId, row.id));
    set.completedAt = null;
    set.finalTotalAmount = null;
    set.finalAdjustmentAmount = null;
    set.finalAdjustmentReason = '';
  }
  if (reset.acceptance) {
    set.acceptedBy = null;
    set.acceptedAt = null;
    // Источник приёмки чистится вместе с парой (план §5, M2): оставленный у непринятой заявки, он
    // уронил бы накат M9 — там связка «источник есть ровно у принятой» становится ограничением.
    set.acceptanceSource = null;
  }
  if (reset.replacement) {
    // Пометка «рекомендована замена» живёт только у отменённой заявки (M5): возврат в «Новую»
    // обязан её снять, иначе `service_requests_replacement_check` встретит откат ошибкой БД.
    set.replacementRecommended = false;
  }
  if (reset.hold) {
    // Выход из заморозки чистит её поля — при возобновлении, при отмене отложенной и на любом
    // пути, заведённом позже (Р118). Ветка стоит здесь, а не в двух ручках: иначе отмену
    // отложенной заявки поймал бы `service_requests_hold_check` ошибкой БД — статус уже не
    // `on_hold`, а `held_from_status` ещё стоит.
    set.heldFromStatus = null;
    set.holdReason = '';
  }

  const patch = { ...set, ...(params.patch ?? {}) };
  const statusChanged = to !== row.status;
  const [updated] = await tx
    .update(serviceRequests)
    .set({
      ...patch,
      status: to,
      ...(statusChanged || params.touchStatusAt ? { statusChangedAt: now } : {}),
      updatedBy: actor.id,
      updatedAt: now,
      version: row.version + 1,
    })
    .where(and(eq(serviceRequests.id, row.id), eq(serviceRequests.version, params.version)))
    .returning({ id: serviceRequests.id });
  if (!updated) throw err.conflict();

  const { mailFailed } = await recordServiceStatusTransition(tx, {
    requestId: row.id,
    // Переназначение — тот же статус: в истории оно и должно читаться как «Назначен сервис» →
    // «Назначен сервис», иначе строка «сменили исполнителя» пропадёт вовсе.
    fromStatus: row.status,
    toStatus: to,
    estimateRevision: (patch.estimateRevision as number | undefined) ?? row.estimateRevision,
    actorId: actor.id,
    comment: params.comment ?? '',
    mail: params.mail,
  });
  return { mailFailed, clearedWarranties: warrantySnapshot };
}

/**
 * Единственная точка, где заявка записывает вход в статус (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р65, Р67).
 *
 * Точек было две — заведение и `applyTransition`, — и письмо, повешенное на любую из них, пропускало
 * бы половину случаев: «Новой» заявка бывает и при заведении, и вернувшись откатом. Теперь строку
 * истории пишет один помощник, он же ставит письма события: новая дуга перехода не должна требовать
 * помнить про почту.
 *
 * Возвращает id строки истории — из него собирается ключ дедупликации письма. Ключ по заявке был бы
 * неверен: повторный цикл «отменили → вернули» не дал бы второго письма.
 */
async function recordServiceStatusTransition(
  tx: Tx,
  params: {
    requestId: string;
    fromStatus: ServiceRequestStatus | null;
    toStatus: ServiceRequestStatus;
    estimateRevision: number;
    actorId: string;
    comment: string;
    /** План письма, посчитанный до транзакции; `null` — письма у этого перехода нет. */
    mail?: ServiceMailPlan | null;
  },
): Promise<{ statusHistoryId: string; mailFailed: boolean }> {
  const [entry] = await tx
    .insert(serviceRequestStatusHistory)
    .values({
      requestId: params.requestId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      estimateRevision: params.estimateRevision,
      changedBy: params.actorId,
      comment: params.comment,
    })
    .returning({ id: serviceRequestStatusHistory.id });

  if (!params.mail) return { statusHistoryId: entry!.id, mailFailed: false };

  // Данные письма — своей же строкой в той же транзакции: отказать по данным это чтение не может,
  // а собирать те же поля отдельно в каждой ручке значило бы завести два расходящихся письма.
  const data = await loadServiceLetterData(tx, params.requestId);

  /**
   * Ошибка **сборки тела** заявку не роняет: письма нет, заявка есть, исход `mail_failed` уходит
   * ответом и в аудит после commit. Ошибка вставки письма — отказ хранилища, и она летит наружу,
   * откатывая всё: прятать потерю письма мягким исходом нельзя.
   */
  let letter: ReturnType<typeof renderServiceLetter>;
  try {
    letter = renderServiceLetter(params.mail.event, data);
  } catch (e) {
    logServiceMailFailure(params.requestId, e);
    return { statusHistoryId: entry!.id, mailFailed: true };
  }

  await queueServiceMails(tx, {
    plan: params.mail,
    statusHistoryId: entry!.id,
    requestId: params.requestId,
    letter,
  });
  return { statusHistoryId: entry!.id, mailFailed: false };
}

// ── Смета ──

/** Сумма строк: считает БД (`amount` — GENERATED), сервер только складывает. */
function sumAmounts(rows: { amount: string | null }[]): number {
  return rows.reduce((total, row) => total + (num(row.amount) ?? 0), 0);
}

async function estimateItems(tx: Tx, requestId: string) {
  return tx
    .select()
    .from(serviceRequestItems)
    .where(eq(serviceRequestItems.requestId, requestId))
    .orderBy(asc(serviceRequestItems.sortOrder), asc(serviceRequestItems.createdAt));
}

// ── Файлы (§8.3) ──

/**
 * В каких статусах вид документа принимают. Правило одной строкой: до терминального статуса файлы
 * живут обычной жизнью, после него заявка принимает бумаги и ничего не отдаёт (Р16, Р29).
 *
 * Смета — вид исполнителя, и после предъявления она заперта вместе со строками. Акт и счёт
 * приходят от «В работе» и позже, гарантийный талон — от предъявления работ: раньше гарантировать
 * нечего.
 */
const FILE_KIND_STATUSES: Record<ServiceFileKind, ServiceRequestStatus[]> = {
  attachment: [
    'new',
    'it_approved',
    'assigned',
    'diagnostics',
    'estimate_review',
    'in_work',
    'done',
  ],
  // Смета предъявляется из «В работе» (Н2), значит и файл сметы прикладывают оттуда же;
  // `diagnostics` — legacy: снимается выпуском 2.
  estimate: ['in_work', 'diagnostics', 'estimate_review'],
  act: ['in_work', 'done', 'accepted', 'cancelled'],
  invoice: ['in_work', 'done', 'accepted', 'cancelled'],
  /**
   * Гарантийный талон принимается и в «В работе» (план §7.3). Без этого планка Н8 замыкает круг:
   * закрывающим документом талон считается, но подшить его можно было только после «Решена», куда
   * без закрывающего документа не пускают. Заявка, у которой единственная бумага — талон, не
   * закрывалась бы вовсе.
   */
  warranty_card: ['in_work', 'done', 'accepted', 'cancelled'],
};

/**
 * «Эффективный» статус заявки (Р110): у отложенной — тот, из которого её отложили. Заморозка
 * останавливает ход заявки, а не жизнь вокруг неё: вложение к отложенной «Диагностике» — то же
 * вложение, и виды документов ему разрешаются те же. Тот же расчёт делает портал (`attachableKinds`
 * в `ServiceRequestDocuments.tsx`) — разойдись они, портал предлагал бы вид, на котором придёт
 * отказ.
 */
function effectiveStatus(row: {
  status: ServiceRequestStatus;
  heldFromStatus: ServiceRequestStatus | null;
}): ServiceRequestStatus {
  return row.heldFromStatus ?? row.status;
}

/** Статус здесь — «эффективный» (Р110): заморозка видов документов не меняет. */
function assertFileKindAllowed(status: ServiceRequestStatus, kind: ServiceFileKind): void {
  if (isServiceRequestClosed(status) && !SERVICE_CLOSING_DOCUMENT_KINDS.includes(kind)) {
    const closing = SERVICE_CLOSING_DOCUMENT_KINDS.map((k) => serviceFileKindLabels[k]).join(', ');
    throw err.unprocessable(
      `Закрытая заявка принимает только документы: ${closing.toLowerCase()}`,
      { kind: 'Заявка закрыта' },
    );
  }
  if (!FILE_KIND_STATUSES[kind].includes(status)) {
    throw err.unprocessable(
      `«${serviceFileKindLabels[kind]}» не прикладывают к заявке в статусе «${serviceRequestStatusLabels[status]}»`,
      { kind: 'Неподходящий статус' },
    );
  }
}

// Реестр гарантий (§9.5): схема фильтров и форма строки живут в контрактах (`warranty.ts`) —
// реестр читает портал, и второй такой же тип на его стороне разъехался бы с этим.

export default async function serviceRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { preHandler: [app.authenticate, app.requirePermission('serviceRequests.read')] };
  const canCreate = {
    preHandler: [app.authenticate, app.requirePermission('serviceRequests.create')],
  };
  const canUpdate = {
    preHandler: [app.authenticate, app.requirePermission('serviceRequests.update')],
  };
  const canDelete = {
    preHandler: [app.authenticate, app.requirePermission('serviceRequests.delete')],
  };
  const canAssign = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.assign', 'Назначает сервис оператор оргтехники'),
    ],
  };
  /**
   * Работа исполнителя по заявке: смета, её предъявление и возврат в правку, закрытие работ,
   * примечание. Держат её **две стороны с разными правами** (план §7.3), поэтому страж —
   * «одно из перечисленных»: у сервисной компании и у «Ведения» это `serviceRequests.estimate`,
   * у поимённого исполнителя — `serviceRequests.execute`, которым он значится в заявке.
   *
   * Записанное конъюнкцией, условие отобрало бы ручку у обеих сторон сразу; записанное одним
   * правом стороны — у поимённого исполнителя, и матрица §6 для него не работала бы ни при каком
   * `execute`. Страж отвечает только на вопрос «пускать ли к ручке вообще»: что субъекту доступно
   * **на этой заявке**, решает коридор (`assertTransition`) и `assertExecutorSide` — держатель
   * `execute` без назначения получает отказ от них, а не отсюда.
   */
  const canEstimate = {
    preHandler: [
      app.authenticate,
      app.requireAnyPermission(
        ['serviceRequests.estimate', 'serviceRequests.execute'],
        'Смету ведёт исполнитель',
      ),
    ],
  };
  const canApproveEstimate = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.approveEstimate', 'Смету согласует заказчик'),
    ],
  };
  const canApproveIt = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.approveIt', 'Заявку визирует отдел ИТ'),
    ],
  };
  const canChangeStatus = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.status', 'Недостаточно прав для смены статуса'),
    ],
  };
  /**
   * Две статусные дуги исполнителя — «принять в работу» и «отказаться». Право хода у них общее с
   * операторским коридором (`serviceRequests.status`), и по той же причине, что у сметы, страж
   * здесь «одно из перечисленных»: поимённому исполнителю дугу открывает назначение вместе с
   * `serviceRequests.execute`. Какая из сторон перед ним, страж не различает — это дело
   * `assertSideAllowed` и `assertTransition`, стоящих первыми строками обработчиков.
   */
  const canExecutorStatus = {
    preHandler: [
      app.authenticate,
      app.requireAnyPermission(
        ['serviceRequests.status', 'serviceRequests.execute'],
        'Недостаточно прав для смены статуса',
      ),
    ],
  };
  /**
   * Правка факта выдачи расходников (Р6). Страж тот же, что у статусных ходов исполнителя, и по той
   * же причине «одно из перечисленных»: правит факт тот, кто картриджи вёз, — оператор назначенного
   * контрагента (у него `serviceRequests.status` есть) либо поимённый исполнитель
   * (`serviceRequests.execute`), — **либо** «Ведение», которое разбирает ошибки за любую сторону.
   *
   * Отдельного права на списание нет и быть не должно (Р8): списание — следствие закрытия заявки, а
   * не действие над складом. Заведи мы его — исполнитель без прав на справочник не смог бы закрыть
   * собственную заявку, а прав на справочник у него нет и не будет.
   *
   * Кто перед стражем на **этой** заявке, решает `assertConsumableIssuer`: держатель `execute` без
   * назначения получает отказ от него, а не отсюда.
   */
  const canSetIssued = {
    preHandler: [
      app.authenticate,
      app.requireAnyPermission(
        ['serviceRequests.status', 'serviceRequests.execute'],
        'Выдачу отмечает назначенный исполнитель',
      ),
    ],
  };
  const canFiles = {
    preHandler: [app.authenticate, app.requirePermission('serviceRequests.files')],
  };
  /**
   * Срочность — своё право (Н12): сегодня флаг приходил вместе с `serviceRequests.update`, то есть
   * всякому, кто правит заявку, и составом набора его было не отобрать. Требование постановки
   * «внешний исполнитель приоритет не ставит» держится тем же правом: у сервисной компании нет ни
   * `update`, ни этого.
   */
  const canUrgency = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.urgency', 'Срочность ставит тот, кто ведёт заявки'),
    ],
  };
  /**
   * Заморозка и возврат: право спрашивает **обработчик** предикатом `canHoldService`, а не страж
   * (план §7.3). Причина в окне волн: до выката каталога наборов (В5) «Ведение» приходит носителям
   * надстройки `office_equipment_operator`, а права `hold` в ней нет и появиться не может —
   * надстройка правится той же волной В5. Спроси страж `hold` напрямую, и заморозка отвалилась бы
   * у тех, кто ею пользуется сегодня, на весь промежуток между волнами.
   *
   * Портал спрашивает ту же функцию контрактов — разойдись они, кнопка вела бы в 403.
   */
  const canHold = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.read', 'Заявки на обслуживание недоступны'),
    ],
  };

  /** Обе оси видимости списка: заказчик заявки и назначенный исполнитель. */
  function visibility(p: Principal): SQL | undefined {
    return and(
      serviceRequestScopeWhere(
        p,
        serviceRequests.equipmentObjectId,
        serviceRequests.customerDepartmentId,
        serviceRequests.equipmentDepartmentId,
      ),
      serviceExecutorVisibilityWhere(p, serviceRequests.serviceCounterpartyId),
    );
  }

  /**
   * Виза ИТ стоит на **текущей** ревизии сметы — то же равенство, что в `hasCurrentItApproval`
   * (Н3), переведённое на SQL: очередь отбирается выборкой, а предикат контрактов считает по
   * строке. Разъехаться им нечем — обе половины сравнивают ровно эти две колонки.
   */
  const currentItApproval = sql`${serviceRequests.itApprovedEstimateRevision} IS NOT NULL
      AND ${serviceRequests.itApprovedEstimateRevision} = ${serviceRequests.estimateRevision}`;

  /**
   * Условие «в этом состоянии ждут такую-то сторону». Статусы не перечисляются руками, а
   * **выводятся** из `serviceRequestWaitingOn`: та же функция, что отвечает в карточке, опрашивается
   * на обоих исходах визы, и статусы раскладываются на три кучки — «ждут всегда», «ждут только с
   * визой» и «ждут только без визы». Вторая и третья существуют ровно из-за «Сметы на
   * согласовании»: там две очереди подряд.
   */
  function waitingSideWhere(side: ServiceWaitingOn): SQL | undefined {
    const always: ServiceRequestStatus[] = [];
    const signed: ServiceRequestStatus[] = [];
    const unsigned: ServiceRequestStatus[] = [];
    for (const status of SERVICE_REQUEST_STATUSES) {
      const withIt =
        serviceRequestWaitingOn({ status, estimateRevision: 1, itApprovedEstimateRevision: 1 }) ===
        side;
      const withoutIt =
        serviceRequestWaitingOn({
          status,
          estimateRevision: 1,
          itApprovedEstimateRevision: null,
        }) === side;
      if (withIt && withoutIt) always.push(status);
      else if (withIt) signed.push(status);
      else if (withoutIt) unsigned.push(status);
    }
    const parts = [
      always.length > 0 ? inArray(serviceRequests.status, always) : undefined,
      signed.length > 0
        ? and(inArray(serviceRequests.status, signed), currentItApproval)
        : undefined,
      unsigned.length > 0
        ? and(inArray(serviceRequests.status, unsigned), not(currentItApproval))
        : undefined,
    ].filter((part): part is SQL => part !== undefined);
    return parts.length > 0 ? or(...parts) : undefined;
  }

  /** Субъект значится поимённым исполнителем этой заявки (Н5). */
  function namedExecutorHere(p: Principal): SQL {
    return exists(
      db
        .select({ x: sql`1` })
        .from(serviceRequestExecutors)
        .where(
          and(
            eq(serviceRequestExecutors.requestId, serviceRequests.id),
            eq(serviceRequestExecutors.userId, p.id),
          ),
        ),
    );
  }

  /**
   * Очередь «Ждут меня» (Р35). `null` — у субъекта шага в цикле нет вовсе (заказчик, наблюдатель):
   * очередь пуста, и стоить обращения к базе она не должна.
   *
   * Сторона считается двумя источниками, и второй без первого не выводится. `isWaitingOn` знает
   * стороны, видные **по субъекту** — согласующего от ИТ, распределяющего, оператора подрядчика.
   * Поимённый исполнитель ей не виден и виден быть не может: «я в списке назначенных» — свойство
   * заявки, и отбирается оно соединением с `service_request_executors`.
   */
  function waitingOnMeWhere(p: Principal): SQL | null {
    const parts: SQL[] = [];
    for (const side of SERVICE_WAITING_ON) {
      if (!isWaitingOn(p, side)) continue;
      const where = waitingSideWhere(side);
      if (where) parts.push(where);
    }
    if (can(p, 'serviceRequests.execute')) {
      const service = waitingSideWhere('service');
      const named = service ? and(service, namedExecutorHere(p)) : undefined;
      if (named) parts.push(named);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : or(...parts)!;
  }

  // ── Список ──
  r.get('/', { ...auth, schema: { querystring: serviceRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const mine = waitingOnMeWhere(p);
    // «Предъявлена или принята, а закрывающих документов нет ни одного» — очередь «Ожидаются
    // документы» (Р114). Планка та же, что у приёмки (Р112): её снимает любой из трёх видов, и
    // прежняя пара «акт и счёт» заставляла бы портал требовать бумагу, которая ничего не запирает.
    // Отменённая заявка сюда не попадает: работ не было, и ждать по ней нечего.
    const hasClosingDocument = exists(
      db
        .select({ x: sql`1` })
        .from(serviceRequestFiles)
        .where(
          and(
            eq(serviceRequestFiles.requestId, serviceRequests.id),
            inArray(serviceRequestFiles.kind, [...SERVICE_CLOSING_DOCUMENT_KINDS]),
          ),
        ),
    );
    const searchNum = q.search ? parseServiceRequestNumberSearch(q.search) : null;
    const where = and(
      archiveWhere(p, q.archive, serviceRequests.deletedAt),
      visibility(p),
      q.status ? eq(serviceRequests.status, q.status) : undefined,
      q.objectId ? eq(serviceRequests.equipmentObjectId, q.objectId) : undefined,
      // Отдел спрашивают одним фильтром, а отвечают им две колонки: заявку ведёт и тот, кто её
      // подал, и отдел, за которым числится техника.
      q.departmentId
        ? or(
            eq(serviceRequests.customerDepartmentId, q.departmentId),
            eq(serviceRequests.equipmentDepartmentId, q.departmentId),
          )
        : undefined,
      q.equipmentId ? eq(serviceRequests.officeEquipmentId, q.equipmentId) : undefined,
      q.equipmentTypeId ? eq(officeEquipment.equipmentTypeId, q.equipmentTypeId) : undefined,
      q.serviceCounterpartyId
        ? eq(serviceRequests.serviceCounterpartyId, q.serviceCounterpartyId)
        : undefined,
      q.waitingOnMe
        ? // У субъекта без шага в цикле (наблюдатель) очередь пуста, а не равна всему списку.
          (mine ?? sql`false`)
        : undefined,
      q.mine ? eq(serviceRequests.createdBy, p.id) : undefined,
      q.awaitingDocuments
        ? and(inArray(serviceRequests.status, ['done', 'accepted']), not(hasClosingDocument))
        : undefined,
      q.warrantyClaim ? isNotNull(serviceRequests.warrantyClaimSource) : undefined,
      // Заморозка признак срочности не гасит (Р119) — заявка не перестала быть срочной оттого, что
      // её остановили, — но из отбора выпадает: пока она ждёт решения, браться не за что.
      // Условие у́же, чем у частичного индекса `service_requests_urgent_idx` (он исключает ещё и
      // закрытые), и это осознанно: индексом живёт очередь — сортировка `urgentFirst`, — а фильтр
      // отвечает на «покажи все срочные за период», и прошлое у него не отнимают.
      q.urgent
        ? and(
            eq(serviceRequests.isUrgent, true),
            // Из отбора уходит только заморозка (Р119): срочная отложенная ждёт решения, а не рук.
            // Закрытые срочные остаются видимыми, как и были: фильтр — это отбор («покажи все
            // срочные за период»), а не очередь, и отнимать у него прошлое Р119 не просил —
            // наверх их не поднимает сортировка `urgentFirst`, и этого достаточно.
            notInArray(serviceRequests.status, ['on_hold']),
          )
        : undefined,
      q.createdFrom
        ? gte(serviceRequests.createdAt, new Date(`${q.createdFrom}T00:00:00Z`))
        : undefined,
      q.createdTo
        ? lte(serviceRequests.createdAt, new Date(`${q.createdTo}T23:59:59Z`))
        : undefined,
      // Ищут либо по номеру заявки («СО-14» и «14» — одно и то же), либо по тому, как технику
      // называют: бухгалтерия по инвентарному номеру, сервис по серийному, остальные по модели.
      searchNum !== null
        ? eq(serviceRequests.num, searchNum)
        : searchCondition(q.search, [
            serviceRequests.equipmentName,
            serviceRequests.equipmentSerialNumber,
            serviceRequests.equipmentInventoryNumber,
          ]),
    );

    const sortColumns = {
      num: serviceRequests.num,
      status: serviceRequests.status,
      equipment: serviceRequests.equipmentName,
      object: constructionObjects.name,
      service: counterparties.name,
      statusChangedAt: serviceRequests.statusChangedAt,
      createdAt: serviceRequests.createdAt,
    };
    const pg = pageParams(q);
    /**
     * Срочные — первыми, каким бы ни была остальная сортировка (Р56). Признак стоит **перед**
     * выбранной колонкой, а не вместо неё: внутри срочных порядок остаётся тем, который человек
     * выбрал сам. Закрытые заявки из этого правила выпадают — срочность у них уже ничего не
     * значит, и красная строка в архиве только мешала бы читать список. Отложенная выпадает вместе
     * с ними (Р119): первой строкой стоит то, за что берутся, а заморозка ждёт решения, а не рук.
     */
    const urgentFirst = sql`(${serviceRequests.isUrgent} AND ${serviceRequests.status} NOT IN ('accepted','cancelled','on_hold')) DESC`;
    const [rows, totalRows] = await Promise.all([
      requestQuery()
        .where(where)
        .orderBy(urgentFirst, orderByFrom(sortColumns, q.sortBy, q.sortOrder, 'statusChangedAt'))
        .limit(pg.limit)
        .offset(pg.offset),
      db
        .select({ c: count() })
        .from(serviceRequests)
        .innerJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
        .where(where),
    ]);
    return {
      items: await loadDtos(rows),
      total: Number(totalRows[0]!.c),
      page: pg.page,
      pageSize: pg.pageSize,
    };
  });

  // ── Реестр действующих гарантий (§9.5) ──
  /**
   * Строка реестра — носитель гарантии: сама единица техники либо **выполненная** позиция ремонта.
   * Два источника, а не один: гарантия поставщика существует и без единого ремонта, а гарантия на
   * запчасть живёт в заявке.
   *
   * Гарантии техники отдаются только тому, у кого есть `officeEquipment.read`: у сервисной компании
   * его нет намеренно (Р7) — «её» техника в справочнике ничем не отмечена, и реестр по области
   * справочника означал бы для неё весь парк компании. Гарантии своих ремонтов она видит.
   *
   * Реестр показывает **действующие** гарантии: истёкшие — это история, и в вопросе «что ещё
   * покрыто» они только мешают.
   */
  r.get(
    '/warranties',
    { ...auth, schema: { querystring: warrantyListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const today = warrantyToday();
      const horizon = q.expiring
        ? sql`CURRENT_DATE + CAST(${WARRANTY_EXPIRING_DAYS} AS integer)`
        : null;
      const rows: ServiceWarrantyRowDto[] = [];

      if (q.kind !== 'repair' && can(p, 'officeEquipment.read')) {
        const units = await db
          .select({
            id: officeEquipment.id,
            name: officeEquipment.name,
            serialNumber: officeEquipment.serialNumber,
            inventoryNumber: officeEquipment.inventoryNumber,
            warrantyUntil: officeEquipment.warrantyUntil,
            typeName: officeEquipmentTypes.name,
            objectName: constructionObjects.name,
            departmentName: departments.name,
          })
          .from(officeEquipment)
          .innerJoin(
            officeEquipmentTypes,
            eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id),
          )
          .innerJoin(constructionObjects, eq(officeEquipment.objectId, constructionObjects.id))
          .leftJoin(departments, eq(officeEquipment.ownerDepartmentId, departments.id))
          .where(
            and(
              isNull(officeEquipment.deletedAt),
              officeEquipmentScopeWhere(
                p,
                officeEquipment.objectId,
                officeEquipment.ownerDepartmentId,
              ),
              isNotNull(officeEquipment.warrantyUntil),
              sql`${officeEquipment.warrantyUntil} >= CURRENT_DATE`,
              horizon ? sql`${officeEquipment.warrantyUntil} <= ${horizon}` : undefined,
              q.objectId ? eq(officeEquipment.objectId, q.objectId) : undefined,
              q.departmentId ? eq(officeEquipment.ownerDepartmentId, q.departmentId) : undefined,
              q.equipmentTypeId
                ? eq(officeEquipment.equipmentTypeId, q.equipmentTypeId)
                : undefined,
              searchCondition(q.search, [
                officeEquipment.name,
                officeEquipment.serialNumber,
                officeEquipment.inventoryNumber,
              ]),
            ),
          );
        for (const unit of units) {
          rows.push({
            id: `equipment:${unit.id}`,
            kind: 'equipment',
            equipmentId: unit.id,
            equipmentName: unit.name,
            serialNumber: unit.serialNumber,
            inventoryNumber: unit.inventoryNumber,
            typeName: unit.typeName,
            objectName: unit.objectName,
            departmentName: unit.departmentName,
            subject: 'Гарантия поставщика',
            warrantyUntil: unit.warrantyUntil!,
            state: warrantyState(unit.warrantyUntil, today),
            daysLeft: warrantyDaysLeft(unit.warrantyUntil, today),
            requestId: null,
            requestNum: null,
            displayNumber: null,
            itemId: null,
          });
        }
      }

      if (q.kind !== 'equipment') {
        const repairs = await db
          .select({
            itemId: serviceRequestItems.id,
            itemName: serviceRequestItems.name,
            warrantyUntil: serviceRequestItems.warrantyUntil,
            requestId: serviceRequests.id,
            requestNum: serviceRequests.num,
            equipmentId: serviceRequests.officeEquipmentId,
            equipmentName: serviceRequests.equipmentName,
            serialNumber: serviceRequests.equipmentSerialNumber,
            inventoryNumber: serviceRequests.equipmentInventoryNumber,
            typeName: officeEquipmentTypes.name,
            objectName: constructionObjects.name,
            departmentName: equipmentDepartments.name,
          })
          .from(serviceRequestItems)
          .innerJoin(serviceRequests, eq(serviceRequestItems.requestId, serviceRequests.id))
          .innerJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
          .innerJoin(
            officeEquipmentTypes,
            eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id),
          )
          .innerJoin(
            constructionObjects,
            eq(serviceRequests.equipmentObjectId, constructionObjects.id),
          )
          .leftJoin(
            equipmentDepartments,
            eq(serviceRequests.equipmentDepartmentId, equipmentDepartments.id),
          )
          .where(
            and(
              isNull(serviceRequests.deletedAt),
              visibility(p),
              // Гарантия бывает только у выполненной работы (Р12): на неустановленную запчасть её
              // нет, и в реестре такой строке места тоже нет.
              eq(serviceRequestItems.performed, true),
              isNotNull(serviceRequestItems.warrantyUntil),
              sql`${serviceRequestItems.warrantyUntil} >= CURRENT_DATE`,
              horizon ? sql`${serviceRequestItems.warrantyUntil} <= ${horizon}` : undefined,
              q.objectId ? eq(serviceRequests.equipmentObjectId, q.objectId) : undefined,
              q.departmentId
                ? or(
                    eq(serviceRequests.customerDepartmentId, q.departmentId),
                    eq(serviceRequests.equipmentDepartmentId, q.departmentId),
                  )
                : undefined,
              q.equipmentTypeId
                ? eq(officeEquipment.equipmentTypeId, q.equipmentTypeId)
                : undefined,
              searchCondition(q.search, [
                serviceRequests.equipmentName,
                serviceRequests.equipmentSerialNumber,
                serviceRequests.equipmentInventoryNumber,
                serviceRequestItems.name,
              ]),
            ),
          );
        for (const repair of repairs) {
          rows.push({
            id: `item:${repair.itemId}`,
            kind: 'repair',
            equipmentId: repair.equipmentId,
            equipmentName: repair.equipmentName,
            serialNumber: repair.serialNumber,
            inventoryNumber: repair.inventoryNumber,
            typeName: repair.typeName,
            objectName: repair.objectName,
            departmentName: repair.departmentName,
            subject: repair.itemName,
            warrantyUntil: repair.warrantyUntil!,
            state: warrantyState(repair.warrantyUntil, today),
            daysLeft: warrantyDaysLeft(repair.warrantyUntil, today),
            requestId: repair.requestId,
            requestNum: repair.requestNum,
            displayNumber: formatServiceRequestNumber(repair.requestNum),
            itemId: repair.itemId,
          });
        }
      }

      // Два источника сходятся в одном списке, поэтому сортировка и страница считаются здесь, а не
      // в SQL: у реестра одна колонка порядка — «когда кончится», и объединять две выборки ради
      // неё в базе значило бы писать UNION с одинаковыми колонками из разных таблиц.
      //
      // Порог у этого решения назван числом, а не «когда станет много» (Р43): пока действующих
      // гарантий меньше 5 000, выборка целиком в память дешевле UNION ALL с приведением колонок.
      // Больше — переписывать на SQL, иначе вкладка узаконит выборку без предела.
      const desc = q.sortOrder === 'desc';
      rows.sort((a, b) => {
        const byField =
          q.sortBy === 'equipment'
            ? a.equipmentName.localeCompare(b.equipmentName)
            : a.warrantyUntil.localeCompare(b.warrantyUntil);
        return desc ? -byField : byField;
      });
      const pg = pageParams(q);
      return {
        items: rows.slice(pg.offset, pg.offset + pg.limit),
        total: rows.length,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );

  // ── Счётчик «ждут меня» ──
  /**
   * Сколько заявок области субъекта стоит именно за ним — число для бейджа на пункте меню.
   * Отдельной ручкой, а не полем списка (образец — `/users/pending-count`): бейдж живёт в каркасе
   * портала и виден на любой странице, и тянуть ради одного числа страницу заявок значило бы
   * грузить список на каждый вход в портал.
   *
   * Сторону называет `isWaitingOn` — по правам и типу контрагента, а не по имени роли (Р35):
   * оператор оргтехники приходит надстройкой над штабом или отделом, сервис — типом контрагента,
   * и сравнение `waitingOn` с ролью развалилось бы на обоих.
   *
   * Область — та же `visibility`, что у списка: разойдись они, бейдж считал бы заявки, которых в
   * списке не видно, и вёл бы в пустую очередь. Архивные не в счёт — удалённую заявку не двигают.
   *
   * У субъекта без шага в цикле (заказчик, наблюдатель) счёт нулевой без запроса в БД: портал
   * такому счётчик и не спрашивает (Р39), но ручка открыта всем читателям модуля, и пустая
   * сторона не должна стоить обращения к базе.
   *
   * Маршрут стоит рядом с `/warranties` — до `/:id`: оба пути статические, и держать их вместе
   * значит не перечитывать потом весь файл в поисках, не перехватил ли их параметр.
   */
  r.get('/waiting-count', auth, async (req) => {
    const p = requirePrincipal(req);
    const mine = waitingOnMeWhere(p);
    if (!mine) return { count: 0 };
    const [row] = await db
      .select({ c: count() })
      .from(serviceRequests)
      .where(and(isNull(serviceRequests.deletedAt), visibility(p), mine));
    return { count: Number(row!.c) };
  });

  /**
   * Кандидаты в поимённые исполнители — те, кого вообще можно назначить на заявку (§7.1): учётка с
   * правом `serviceRequests.execute`, живая и не удалённая.
   *
   * Своя ручка, а не `GET /users`, и причина не в удобстве. Список учёток закрыт `users.manage` —
   * правом, которого нет ни у «Ведения», ни у ИТ-службы: спрашивай портал его, поле выбора
   * заполнялось бы только у администратора портала, а у того, кто заявки и распределяет, оставалось
   * бы пустым. Здесь же условие ровно обратное: страж — `serviceRequests.assign`, то самое право,
   * которым назначают.
   *
   * Отдаётся минимум — идентификатор и ФИО: поле выбора большего не показывает, а всё остальное про
   * учётку — предмет модуля витрины, а не этого.
   *
   * Право читается **эффективным** (`grantPermissionsExpr` — с гейтом совместимости набора с
   * ролью), а не по составу набора в коде: у переведённой учётки набор мог перестать действовать,
   * и назначенный по такому списку человек получил бы отказ от коридора — то есть кандидат,
   * которого нельзя назначить.
   *
   * Путь статический и стоит **до** `/:id`: параметр перехватил бы его первым.
   */
  r.get('/executor-candidates', { ...canAssign }, async () => {
    const rows = await db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          isNull(users.deletedAt),
          sql`${grantPermissionsExpr} @> ARRAY['serviceRequests.execute']::text[]`,
        ),
      )
      .orderBy(users.fullName);
    return { items: rows.map((row) => ({ id: row.id, fullName: row.fullName })) };
  });

  // ── Карточка ──
  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const row = await loadRow(req.params.id);
    // Карточку достают по id, минуя условия списка, поэтому оба ограничения выдачи повторяются
    // здесь: архив — 404, чужая область — 403.
    assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
    assertScope(p, row);
    return (await getDto(row.id))!;
  });

  // ── История: статусы и аудит (ADR 0012) ──
  // Отдельного права нет: это те же события, что в карточке, только по времени, — и границы у неё
  // те же, что у самой заявки.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const row = await loadRow(req.params.id);
    assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
    assertScope(p, row);
    const [author] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, row.createdBy));
    return loadServiceRequestHistory(row.id, {
      at: row.createdAt,
      actorId: row.createdBy,
      actorName: author?.fullName ?? '',
    });
  });

  // ── Заведение ──
  /**
   * Заявка получает снимок предмета и снимок заказчика: единицу перенесут и перезакрепят, а заявка
   * должна остаться рассказом о том, что чинили тогда, и не переехать в чужую область (Р5, Р10).
   */
  r.post(
    '/',
    { ...canCreate, schema: { body: createServiceRequestSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const body = req.body;

      const [equipment] = await db
        .select({
          id: officeEquipment.id,
          name: officeEquipment.name,
          serialNumber: officeEquipment.serialNumber,
          inventoryNumber: officeEquipment.inventoryNumber,
          objectId: officeEquipment.objectId,
          ownerDepartmentId: officeEquipment.ownerDepartmentId,
          location: officeEquipment.location,
          warrantyUntil: officeEquipment.warrantyUntil,
        })
        .from(officeEquipment)
        .where(
          and(eq(officeEquipment.id, body.officeEquipmentId), isNull(officeEquipment.deletedAt)),
        );
      if (!equipment) {
        throw err.badRequest('Единица оргтехники не найдена', { officeEquipmentId: 'Не найдена' });
      }

      const customerDepartmentId = await resolveCustomerDepartment(p, body, equipment);
      // Область — по заказчику будущей заявки: объектная роль заводит заявку на технику своих
      // площадок, роль отдела — от имени своего отдела либо на технику своего отдела.
      assertServiceRequestScope(p, {
        objectId: equipment.objectId,
        customerDepartmentId,
        equipmentDepartmentId: equipment.ownerDepartmentId,
      });


      /**
       * Адресаты и обратные адреса считаются **до** транзакции (Р67): здесь ходят в базу и в
       * конфигурацию, и отказ по данным внутри транзакции откатил бы саму заявку. Мягкий исход
       * («почта выключена», «канал не настроен») возвращается ответом — заявка заводится в любом
       * случае.
       *
       * Автор будущей заявки — сам заводящий: ответ службы на письмо уйдёт ему.
       */
      const mailPlan = await planServiceMail('new', { actor: p, authorId: p.id });

      /**
       * Вид заявки (Н1). «Поля нет» читается как «ремонт» — ровно так, как читает его старый код в
       * окне выката, и так же стоит умолчанием колонки (`0177`). Строки номенклатуры и вид схема
       * сверила между собой (`createServiceRequestSchema`): у расходников строки обязательны, у
       * ремонта их не бывает.
       */
      const kind: ServiceRequestKind = body.kind ?? 'repair';
      const consumables = body.consumables ?? [];

      const created = await db.transaction(async (tx) => {
        await assertNoOpenRequest(tx, equipment.id, kind);
        await assertConsumablesExist(
          tx,
          consumables.map((line) => line.consumableId),
        );
        const claim = await resolveWarrantyClaim(tx, body.warrantyClaim, equipment, null);
        /**
         * Подразделение заявителя (Н11, M5): проставляет его **сервер** по учётке `created_by`, а
         * не клиент — иначе заявку подавали бы от имени чужого отдела. Названия снимаются из
         * справочника **в той же транзакции**, что и вставка: снимок обязан совпадать с тем, как
         * подразделение называлось в момент заведения.
         */
        const requester = await resolveRequesterPlace(tx, p, body);
        const [row] = await tx
          .insert(serviceRequests)
          .values({
            officeEquipmentId: equipment.id,
            equipmentObjectId: equipment.objectId,
            customerDepartmentId,
            equipmentDepartmentId: equipment.ownerDepartmentId,
            equipmentName: equipment.name,
            equipmentSerialNumber: equipment.serialNumber,
            equipmentInventoryNumber: equipment.inventoryNumber,
            // Место — часть того же снимка: сервис поедет по нему, а карточка к тому времени
            // могла переехать (Р57).
            equipmentLocation: equipment.location,
            kind,
            description: body.description,
            responsibleName: body.responsibleName,
            responsiblePhone: body.responsiblePhone,
            isUrgent: body.isUrgent,
            urgencyReason: body.urgencyReason,
            // Подразделение заявителя — ссылка и снимок названия одной парой: заполненный
            // идентификатор без названия означал бы снимок, который ничего не помнит (Н11).
            requesterDepartmentId: requester.departmentId,
            requesterDepartmentName: requester.departmentName,
            requesterObjectId: requester.objectId,
            requesterObjectName: requester.objectName,
            /*
             * Автовизы при заведении больше нет (Н3). Она существовала потому, что заявку,
             * заведённую самим согласующим, незачем было подписывать вторым действием **на входе**;
             * виза по смете — решение по чужому счёту, и автоматической быть не может. Заявка
             * обладателя `approveIt` заводится «Новой» наравне с остальными.
             */
            warrantyClaimSource: claim.source,
            warrantyClaimItemId: claim.itemId,
            comment: body.comment,
            createdBy: p.id,
            updatedBy: p.id,
          })
          .returning({ id: serviceRequests.id, num: serviceRequests.num });
        const request = row!;
        /**
         * Строки номенклатуры приезжают **заведением**, а не отдельным `PUT` следом (контракт
         * заведения): заявка на расходники без строк запрещена постановкой, и разложенное на два
         * запроса заведение оставляло бы её в этом состоянии всякий раз, когда второй запрос не
         * дошёл.
         */
        if (consumables.length > 0) {
          await tx.insert(serviceRequestConsumables).values(
            consumables.map((line) => ({
              requestId: request.id,
              consumableId: line.consumableId,
              requestedQuantity: line.requestedQuantity,
            })),
          );
        }
        const transition = await recordServiceStatusTransition(tx, {
          requestId: request.id,
          fromStatus: null,
          toStatus: 'new',
          estimateRevision: 0,
          actorId: p.id,
          comment: '',
          mail: mailPlan.plan,
        });
        if (body.fileIds.length > 0) {
          await assertFilesAttachable(tx, body.fileIds, p.id);
          await tx
            .insert(serviceRequestFiles)
            .values(
              body.fileIds.map((fileId) => ({ requestId: request.id, fileId, attachedBy: p.id })),
            );
          await markFilesActive(tx, body.fileIds);
        }
        return { ...request, mailFailed: transition.mailFailed, requester };
      });

      const dto = (await getDto(created.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.create',
        entityType: 'serviceRequest',
        entityId: created.id,
        metadata: {
          num: created.num,
          kind,
          title: serviceRequestTitle(dto),
          objectId: equipment.objectId,
          customerDepartmentId,
          warrantyClaim: dto.warrantyClaim?.source ?? null,
          isUrgent: dto.isUrgent,
          requesterDepartmentId: created.requester.departmentId,
          requesterObjectId: created.requester.objectId,
        },
      });
      // Неудача сборки письма пишется в аудит только теперь: `writeAudit` ходит мимо транзакции, и
      // запись, сделанная внутри, пережила бы её откат (Р67).
      if (created.mailFailed) {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: created.id,
          metadata: { event: 'service_request_waiting_it' },
        });
      }
      reply.code(201);
      return { request: dto, mail: created.mailFailed ? 'mail_failed' : mailPlan.outcome };
    },
  );

  /**
   * От чьего имени заявка (Р5). Значение по умолчанию — подсказка, а не фиксация: сотрудник
   * соседнего отдела чинит «чужой» принтер чаще, чем кажется, и присланное значение всегда
   * побеждает подсказку. Чужой отдел роли отдела недоступен — 403; несколько отделов без подсказки
   * из техники означают, что выбрать должен человек, — 422.
   *
   * `null` и `undefined` — **разные** ответы, а не одно «пусто» (Р12). `null` присылает форма:
   * человек выбрал «заявка от площадки», и подставлять ему отдел вместо явного выбора значит
   * молча отменить решение. `undefined` — поля в теле нет вовсе: так приходят старые клиенты и
   * интеграции, и для них подсказка остаётся единственным способом заполнить заказчика.
   */
  async function resolveCustomerDepartment(
    p: Principal,
    body: { customerDepartmentId?: string | null },
    equipment: { ownerDepartmentId: string | null },
  ): Promise<string | null> {
    if (body.customerDepartmentId === null) {
      /**
       * Заявка от площадки. Роли отдела она доступна только по технике своего отдела: без
       * отдела-заказчика такая заявка держится в её области одним `equipment_department_id`
       * (`serviceRequestScopeWhere`), и по чужой единице учётка завела бы заявку, которой сама
       * потом не увидит. Ролей без отдельской оси граница не касается вовсе: их область
       * считается объектом техники либо не считается ничем.
       */
      if (
        isDepartmentScopedRole(p.role) &&
        !(equipment.ownerDepartmentId && p.departmentIds.includes(equipment.ownerDepartmentId))
      ) {
        throw err.forbidden(
          `${roleLabels[p.role!]} заводит заявку от площадки только по технике своего отдела — по чужой технике заявка заводится от отдела`,
        );
      }
      return null;
    }
    if (body.customerDepartmentId) {
      if (isDepartmentScopedRole(p.role) && !p.departmentIds.includes(body.customerDepartmentId)) {
        throw err.forbidden(`${roleLabels[p.role!]} заводит заявки только от своих отделов`);
      }
      const [department] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, body.customerDepartmentId));
      if (!department) {
        throw err.badRequest('Отдел не найден', { customerDepartmentId: 'Не найден' });
      }
      return department.id;
    }
    if (equipment.ownerDepartmentId && p.departmentIds.includes(equipment.ownerDepartmentId)) {
      return equipment.ownerDepartmentId;
    }
    if (p.departmentIds.length === 1) return p.departmentIds[0]!;
    if (p.departmentIds.length > 1) {
      throw err.unprocessable('Укажите отдел, от имени которого заведена заявка', {
        customerDepartmentId: 'Выберите отдел',
      });
    }
    // Отделов у автора нет вовсе (штаб, руководитель строительства, администратор): заявка
    // объектная. `NULL` здесь означает «к отделам не относится», а не «видна всем».
    return null;
  }

  /** Подразделение заявителя: пара «ссылка + снимок названия», заполненная максимум одна. */
  interface RequesterPlace {
    departmentId: string | null;
    departmentName: string;
    objectId: string | null;
    objectName: string;
  }

  const NO_REQUESTER_PLACE: RequesterPlace = {
    departmentId: null,
    departmentName: '',
    objectId: null,
    objectName: '',
  };

  /**
   * Откуда сам заявитель (Н11, В25). Источник один и он не обсуждается — привязки учётки
   * `created_by`: её отдел, а если отделов у неё нет — её площадка. `responsible_name` остаётся
   * тем, **кому звонить**, и на подразделение не влияет: иначе правка контакта задним числом
   * переписывала бы, от какого отдела пришла заявка.
   *
   * Клиент присылает не подразделение, а **выбор из своих**: у учётки с двумя отделами одно
   * значение не подставить, и тогда выбирает человек — ровно как с отделом-заказчиком. Чужое
   * подразделение отбивается 422: «выбор» не означает «любое».
   *
   * Ни одной привязки — обе пары пустые, и это законное состояние (администратор портала), а не
   * дефект. Ошибкой оно выглядело бы только у того, кто ждёт от карточки заполненного поля.
   */
  async function resolveRequesterPlace(
    tx: Tx,
    p: Principal,
    body: { requesterDepartmentId?: string | null; requesterObjectId?: string | null },
  ): Promise<RequesterPlace> {
    const chosenDepartment = body.requesterDepartmentId ?? null;
    const chosenObject = body.requesterObjectId ?? null;
    if (chosenDepartment && chosenObject) {
      throw err.unprocessable(
        'Подразделение заявителя — либо отдел, либо площадка: пришло и то и другое',
        { requesterObjectId: 'Выберите одно' },
      );
    }

    const department = async (id: string): Promise<RequesterPlace> => {
      const [row] = await tx
        .select({ name: departments.name })
        .from(departments)
        .where(eq(departments.id, id));
      if (!row) throw err.unprocessable('Отдел заявителя не найден', { requesterDepartmentId: 'Не найден' });
      return { ...NO_REQUESTER_PLACE, departmentId: id, departmentName: row.name };
    };
    const object = async (id: string): Promise<RequesterPlace> => {
      const [row] = await tx
        .select({ name: constructionObjects.name })
        .from(constructionObjects)
        .where(eq(constructionObjects.id, id));
      if (!row) throw err.unprocessable('Площадка заявителя не найдена', { requesterObjectId: 'Не найдена' });
      return { ...NO_REQUESTER_PLACE, objectId: id, objectName: row.name };
    };

    if (chosenDepartment) {
      if (!p.departmentIds.includes(chosenDepartment)) {
        throw err.unprocessable('Заявитель не числится в этом отделе', {
          requesterDepartmentId: 'Чужой отдел',
        });
      }
      return department(chosenDepartment);
    }
    if (chosenObject) {
      // Площадка — запасной ответ, а не второй равноправный (Н11): у учётки с отделом
      // подразделением остаётся отдел, и выбор площадки в обход него означал бы заявку «от
      // площадки» от человека, который в ней не числится.
      if (p.departmentIds.length > 0) {
        throw err.unprocessable(
          'У заявителя есть отдел — подразделением заявки становится он, а не площадка',
          { requesterObjectId: 'Укажите отдел' },
        );
      }
      if (!p.constructionObjectIds.includes(chosenObject)) {
        throw err.unprocessable('Заявитель не работает на этой площадке', {
          requesterObjectId: 'Чужая площадка',
        });
      }
      return object(chosenObject);
    }

    if (p.departmentIds.length === 1) return department(p.departmentIds[0]!);
    if (p.departmentIds.length > 1) {
      throw err.unprocessable('Укажите отдел, в котором числится заявитель', {
        requesterDepartmentId: 'Выберите отдел',
      });
    }
    if (p.constructionObjectIds.length === 1) return object(p.constructionObjectIds[0]!);
    if (p.constructionObjectIds.length > 1) {
      throw err.unprocessable('Укажите площадку, на которой работает заявитель', {
        requesterObjectId: 'Выберите площадку',
      });
    }
    return NO_REQUESTER_PLACE;
  }

  // ── Правка заявки ──
  r.patch(
    '/:id',
    { ...canUpdate, schema: { params: idParams, body: updateServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      // Со стороны заказчика правится только «Новая»: дальше за заявкой стоят договорённости с
      // исполнителем. Закрытую не правит никто — её предмет уже стал историей.
      assertServiceRequestEditable(p, row.status, 'редактировать');
      if (isServiceRequestClosed(row.status)) {
        throw err.unprocessable(
          `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» не правится`,
        );
      }
      // Отложенную не правит и администратор (Р110): `assertServiceRequestEditable` держит только
      // площадочные роли, и без этой ветки заморозка останавливала бы заявку для одних и не
      // останавливала для других. Отказ такой же, как у срочности: сначала возобновите.
      if (row.status === 'on_hold') {
        throw err.unprocessable('Отложенную заявку не правят — сначала возобновите её', {
          status: 'Заявка отложена',
        });
      }
      const before = (await getDto(row.id))!;

      /**
       * «Поле пришло» и «значение изменилось» — разные события (Р12б). Форма присылает заказчика
       * всегда, поэтому сравнение идёт со строкой заявки, а не с телом запроса: прогоняй мы
       * неизменившееся значение через ограничения заново, согласующий от ИТ, который видит чужую
       * заявку сквозной областью, получал бы 403 на правку телефона — состав поля заказчика эта
       * область ему не расширяет (Р11б). Заодно отсюда следует, что прежний площадочный заказчик
       * правкой не сбрасывается: «не менял» никогда не означает «сбросил».
       */
      const customerChanged =
        body.customerDepartmentId !== undefined &&
        (body.customerDepartmentId ?? null) !== row.customerDepartmentId;
      const customerDepartmentId = customerChanged
        ? await resolveCustomerDepartment(p, body, {
            ownerDepartmentId: row.equipmentDepartmentId,
          })
        : row.customerDepartmentId;

      await db.transaction(async (tx) => {
        const patch: RequestPatch = {
          updatedBy: p.id,
          updatedAt: new Date(),
          version: row.version + 1,
        };
        if (body.description !== undefined) patch.description = body.description;
        if (customerChanged) patch.customerDepartmentId = customerDepartmentId;
        if (body.responsibleName !== undefined) patch.responsibleName = body.responsibleName;
        if (body.responsiblePhone !== undefined) patch.responsiblePhone = body.responsiblePhone;
        if (body.comment !== undefined) patch.comment = body.comment;
        if (body.isUrgent !== undefined || body.urgencyReason !== undefined) {
          // Пара сверяется по склеенному состоянию: `PATCH` присылает половину, и «поставили
          // срочность, причину оставили прежней» — законная правка, а «сняли срочность, забыли
          // причину» — нет. Схема этого не видит, CHECK в базе увидит и ответит ошибкой БД.
          const urgency = {
            isUrgent: body.isUrgent ?? row.isUrgent,
            urgencyReason: body.urgencyReason ?? row.urgencyReason,
          };
          const issue = urgencyIssue(urgency);
          if (issue) throw err.unprocessable(issue, { urgencyReason: issue });
          patch.isUrgent = urgency.isUrgent;
          patch.urgencyReason = urgency.urgencyReason;
        }
        if (body.warrantyClaim !== undefined) {
          // Обращение по гарантии проверяется заново: за время правки срок мог кончиться, а
          // заявка-источник — уехать в архив.
          const [equipment] = await tx
            .select({
              id: officeEquipment.id,
              warrantyUntil: officeEquipment.warrantyUntil,
            })
            .from(officeEquipment)
            .where(eq(officeEquipment.id, row.officeEquipmentId));
          const claim = await resolveWarrantyClaim(tx, body.warrantyClaim, equipment!, row.id);
          patch.warrantyClaimSource = claim.source;
          patch.warrantyClaimItemId = claim.itemId;
        }
        const [updated] = await tx
          .update(serviceRequests)
          .set(patch)
          .where(and(eq(serviceRequests.id, row.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
      });

      const after = (await getDto(row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.update',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Перечень изменённых полей — то, ради чего история отличает правку от «заявку трогали».
        metadata: { changes: diffServiceRequests(before, after) },
      });
      return after;
    },
  );

  // ── Срочность ──
  /**
   * Своя ручка, а не поле правки (Р56). Заказчик правит заявку только «Новой», а «сломался
   * единственный принтер на площадке» выясняется и тогда, когда заявка уже у сервиса: срочность
   * должна ставиться и сниматься до самого закрытия — но не всеми.
   *
   * Кто именно, решает право `serviceRequests.assign`, а не имя роли: оператор оргтехники — тот же
   * «Штаб» или «Отдел», и правило «место — только Новую» отобрало бы у него признак вместе с
   * заказчиком.
   */
  r.patch(
    '/:id/urgency',
    { ...canUrgency, schema: { params: idParams, body: setServiceUrgencySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      if (isServiceRequestClosed(row.status)) {
        throw err.unprocessable(
          `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» уже закрыта — срочность ей ничего не меняет`,
        );
      }
      // Отложенной срочность не меняют (Р119): признак заморозка не гасит, но и разбирать его
      // поверх остановки незачем — очередь срочных отложенную не показывает, и «поставили красным»
      // не сдвинуло бы её ни на строку.
      if (row.status === 'on_hold') {
        throw err.unprocessable('Отложенной заявке срочность не меняют — сначала возобновите её', {
          status: 'Заявка отложена',
        });
      }

      const before = (await getDto(row.id))!;
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(serviceRequests)
          .set({
            isUrgent: body.isUrgent,
            urgencyReason: body.urgencyReason,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: row.version + 1,
          })
          .where(and(eq(serviceRequests.id, row.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
      });

      const after = (await getDto(row.id))!;
      // Возраст в статусе срочность не сбрасывает: она не ожидание, и очередь «дольше всех ждут»
      // не должна обнуляться от того, что заявку пометили красным.
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.urgency',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { changes: diffServiceRequests(before, after), isUrgent: after.isUrgent },
      });
      return after;
    },
  );

  // ── Мягкое удаление: заявка уходит в архив ──
  r.delete('/:id', { ...canDelete, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const row = await requireEditable(p, req.params.id);
    // Своё правило, а не «то же, что правка» (В20): «Назначенную» ещё удаляют — работа по ней не
    // начиналась, — а править её уже нельзя.
    assertServiceRequestDeletable(p, row.status);
    const now = new Date();
    await db
      .update(serviceRequests)
      .set({ deletedAt: now, deletedBy: p.id, updatedAt: now, version: row.version + 1 })
      .where(and(eq(serviceRequests.id, row.id), isNull(serviceRequests.deletedAt)));
    await writeAudit({
      actorUserId: p.id,
      action: 'serviceRequest.soft_delete',
      entityType: 'serviceRequest',
      entityId: row.id,
      metadata: { num: row.num, status: row.status },
    });
    return { ok: true };
  });

  // ── Назначение исполнителей (Н5, Н6) ──
  /**
   * Исполнителей у заявки два слоя, и назначаются они **одним действием**: свои сотрудники
   * поимённо, сервисная компания — контрагентом целиком (Н5). «Наш сисадмин + КопиЛайт» —
   * обычный случай постановки, и разложенный на два запроса он давал бы промежуточное состояние,
   * в котором заявка уже переназначена, но ещё наполовину.
   *
   * Переназначение — тот же статус, другой исполнитель: заявка не откатывается назад, но её
   * возраст в статусе обнуляется (`touchStatusAt`), иначе новый исполнитель наследовал бы чужое
   * ожидание. Матрица `serviceResetOnTransition` эту дугу не покрывает и покрыть не может: она
   * отвечает на вопрос «куда перешла заявка», а здесь заявка никуда не переходила.
   *
   * Порядок блокировок общий для назначения, отказа и смены статуса (Н5): сначала `FOR UPDATE`
   * строки заявки, затем работа со строками исполнителей. Никогда наоборот — иначе назначение,
   * идущее «от исполнителей», встречается со сменой статуса, идущей «от заявки».
   */
  r.put(
    '/:id/executors',
    { ...canAssign, schema: { params: idParams, body: putServiceExecutorsSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'assigned', [
        'new',
        // legacy: снимается выпуском 2 — из «Согласована ИТ» доступно то же, что из «Новой».
        'it_approved',
        'assigned',
        'diagnostics', // legacy: снимается выпуском 2 — то же, что из «В работе»
        'in_work',
      ]);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'assigned');

      const userIds = [...new Set(body.userIds)];
      if (userIds.length === 0 && !body.serviceCounterpartyId) {
        throw err.unprocessable(
          'Назначьте хотя бы одного исполнителя — сотрудника или сервисную компанию',
          { userIds: 'Нужен исполнитель' },
        );
      }

      const executors = await resolveNamedExecutors(userIds);
      const service = body.serviceCounterpartyId
        ? await resolveServiceCounterparty(body.serviceCounterpartyId)
        : null;

      /**
       * Что именно меняется, считается **до** транзакции: от дельты зависят и адресаты письма, и
       * обязательность причины. Состав, прочитанный здесь, к моменту записи не устареет: и
       * назначение, и отказ поднимают версию самой заявки, а её сверяет `applyTransition` — 409
       * придёт раньше, чем разъедется дельта.
       */
      const current = await db
        .select({ userId: serviceRequestExecutors.userId })
        .from(serviceRequestExecutors)
        .where(eq(serviceRequestExecutors.requestId, row.id));
      const had = new Set(current.map((r) => r.userId));
      const keep = new Set(userIds);
      const removed = [...had].filter((id) => !keep.has(id));
      const added = userIds.filter((id) => !had.has(id));
      const counterpartyId = service?.id ?? null;
      const counterpartyChanged = row.serviceCounterpartyId !== counterpartyId;
      const changed = removed.length > 0 || added.length > 0 || counterpartyChanged;
      // «Назначена» и тот же состав — не назначение, а повтор нажатия. Из остальных статусов тот
      // же состав означает возврат заявки к исполнителям, и он законен.
      if (!changed && row.status === 'assigned') {
        throw err.unprocessable('Эти исполнители уже назначены на заявку');
      }
      // Первое назначение причины не требует, переназначение требует: у прежнего исполнителя
      // отбирают работу, и в истории обязано остаться, почему.
      const first = row.status === 'new' || row.status === 'it_approved';
      if (!first && !body.reason) {
        throw err.unprocessable(
          'Укажите причину переназначения — у прежнего исполнителя отбирают работу',
          { reason: 'Укажите причину' },
        );
      }

      /**
       * Письмо о назначении (Н13) — задание на работу, и уходит оно **только тем, кого назначили
       * этим действием**: поимённо — новым строкам, компании — только если сменилась она сама.
       * Иначе при каждом переназначении сервиса свои сисадмины, давно ведущие заявку, получали бы
       * повторное «вам назначено» и перестали бы читать эти письма вовсе.
       *
       * Обратный адрес — автор заявки: вопрос исполнителя про поломку адресован ему, а не
       * назначившему. Считается до транзакции (Р67): адресаты ходят в базу и в конфигурацию, и
       * упавшие внутри откатили бы саму заявку.
       */
      const mailPlan = await planServiceAssignmentMail(
        { userIds: added, serviceCounterpartyId: counterpartyChanged ? counterpartyId : null },
        { actor: p, authorId: row.createdBy },
      );

      /**
       * Смета — документ того, кто её составлял, и держится она **только** пока заявка у него.
       * Стирается поэтому не на всякой правке состава, а когда заявка меняет руки: у прежнего
       * подрядчика её забрали либо сняли поимённого исполнителя. Добавление второго сисадмина к
       * первому чужого счёта не обесценивает и смету не трогает.
       */
      const handedOver =
        removed.length > 0 || (row.serviceCounterpartyId !== null && counterpartyChanged);

      const mailFailed = await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);

        /**
         * Строки исполнителей пишутся **до** `applyTransition`: письмо собирается внутри той же
         * транзакции и читает исполнителей из таблицы. Вставь мы их после — задание ушло бы без
         * половины адресатов либо вовсе без них.
         *
         * Отложенный `service_requests_executor_present` этому не мешает: он проверяет состояние к
         * концу транзакции, каким бы ни был порядок шагов внутри.
         */
        if (removed.length > 0) {
          await tx
            .delete(serviceRequestExecutors)
            .where(
              and(
                eq(serviceRequestExecutors.requestId, locked.id),
                inArray(serviceRequestExecutors.userId, removed),
              ),
            );
        }
        if (added.length > 0) {
          await tx.insert(serviceRequestExecutors).values(
            added.map((userId) => ({
              requestId: locked.id,
              userId,
              assignedBy: p.id,
            })),
          );
        }

        const patch: RequestPatch = { serviceCounterpartyId: counterpartyId };
        if (handedOver && !first) {
          await assertEstimateReplaceable(tx, locked.id);
          await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, locked.id));
          patch.estimateRevision = 0;
          patch.estimateSubmittedAt = null;
          patch.estimatedTotalAmount = null;
          patch.approvedEstimateRevision = null;
          patch.estimateApprovedBy = null;
          patch.estimateApprovedAt = null;
        }

        const transition = await applyTransition(tx, {
          row: locked,
          to: 'assigned',
          version: body.version,
          actor: p,
          comment: body.reason ?? body.comment,
          patch,
          touchStatusAt: true,
          mail: mailPlan.plan,
        });
        return transition.mailFailed;
      });

      await writeAudit({
        actorUserId: p.id,
        action: first ? 'serviceRequest.assign' : 'serviceRequest.reassign',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          serviceCounterpartyId: counterpartyId,
          serviceName: service?.name ?? '',
          // Поимённо — именами, а не идентификаторами: журнал читают люди, и «сняли исполнителя
          // 8f3c…» ничего им не говорит.
          executors: executors.map((e) => e.fullName),
          added: added.length,
          removed: removed.length,
          reason: body.reason ?? '',
        },
      });
      // Неудача сборки письма пишется в аудит только теперь: `writeAudit` ходит мимо транзакции, и
      // запись, сделанная внутри, пережила бы её откат (Р67).
      if (mailFailed) {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: row.id,
          metadata: { event: 'service_request_assigned' },
        });
      }
      return {
        request: (await getDto(row.id))!,
        mail: mailFailed ? 'mail_failed' : mailPlan.outcome,
      };
    },
  );

  /**
   * Контрагент-исполнитель: активная сервисная компания и никто больше. Разбор общий у новой ручки
   * и у совместимого адаптера — двух ответов на «годится ли этот контрагент» быть не должно.
   */
  async function resolveServiceCounterparty(id: string) {
    const [service] = await db
      .select({
        id: counterparties.id,
        name: counterparties.name,
        type: counterparties.type,
        isActive: counterparties.isActive,
        deletedAt: counterparties.deletedAt,
      })
      .from(counterparties)
      .where(eq(counterparties.id, id));
    if (!service || service.deletedAt) throw err.badRequest('Контрагент не найден');
    if (service.type !== 'service') {
      throw err.badRequest('Исполнителем может быть только контрагент типа «Сервисная компания»', {
        serviceCounterpartyId: 'Нужна сервисная компания',
      });
    }
    if (!service.isActive) throw err.badRequest('Контрагент неактивен');
    return service;
  }

  /**
   * Кого можно назначить поимённо — учётку с правом `serviceRequests.execute`, и только её
   * (план §7.1). Назначение само открывает статусные ходы: без этой проверки администратор мог бы
   * назначить исполнителем заказчика и тем выдать ему ходы, которых нет ни в одном наборе.
   *
   * Отказ называет **человека**, а не право: назначающий видит список фамилий, и «у учётки нет
   * полномочия» без имени не подскажет, кого из пятерых убрать.
   *
   * Права считаются полной сборкой субъекта (`loadPrincipal`) — той же, что отвечает на каждом
   * запросе: право приходит четырьмя источниками (роль, тип контрагента, надстройка, набор), и
   * собрать их вторым способом значило бы завести вторую матрицу доступа. Запрос на учётку — цена
   * назначения, а не списка: назначают редко и не больше двух десятков разом.
   */
  async function resolveNamedExecutors(userIds: string[]) {
    if (userIds.length === 0) return [];
    const rows = await db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, userIds));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const resolved: { id: string; fullName: string }[] = [];
    for (const id of userIds) {
      const row = byId.get(id);
      if (!row) throw err.badRequest('Учётная запись не найдена', { userIds: 'Не найдена' });
      const subject = await loadPrincipal(id);
      if (!subject) {
        throw err.unprocessable(
          `${row.fullName} — учётка закрыта или неактивна, назначить её нельзя`,
          { userIds: 'Учётка неактивна' },
        );
      }
      if (!can(subject, 'serviceRequests.execute')) {
        throw err.unprocessable(
          `${row.fullName} не может быть исполнителем заявки оргтехники — у учётки нет такого полномочия`,
          { userIds: 'Нет полномочия исполнителя' },
        );
      }
      resolved.push(row);
    }
    return resolved;
  }

  // ── Назначение контрагента: совместимый адаптер выпуска 1 ──
  /**
   * Прежняя ручка назначения. Остаётся на весь выпуск 1 и удаляется в выпуске 2 (план §7.3), и
   * причина не в старом коде сервера, а в старом коде **браузера**: вкладка, открытая до выката,
   * живёт с загруженным JS и зовёт прежний адрес — удали мы ручку сразу, назначение отвечало бы
   * 404 всем, кто не перезагрузил страницу.
   *
   * Адаптер меняет **только контрагента** и не трогает строк поимённых исполнителей: у старой
   * ручки ровно такая семантика, и трактовать её как «назначить компанию и пустой список людей»
   * нельзя — заявка «свой сисадмин + КопиЛайт», переназначенная из вчерашней вкладки, молча
   * лишилась бы своего сотрудника.
   */
  r.patch(
    '/:id/service',
    { ...canAssign, schema: { params: idParams, body: assignServiceSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'assigned', [
        'new',
        'it_approved', // legacy: снимается выпуском 2
        'assigned',
        'diagnostics', // legacy: снимается выпуском 2
        'in_work',
      ]);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'assigned');

      const first = row.status === 'new' || row.status === 'it_approved';
      const reassignment = !first;
      if (reassignment && !body.reason) {
        throw err.unprocessable(
          'Укажите причину переназначения — у прежнего сервиса отбирают работу',
          {
            reason: 'Укажите причину',
          },
        );
      }
      if (row.status === 'assigned' && row.serviceCounterpartyId === body.serviceCounterpartyId) {
        throw err.unprocessable('Заявка уже назначена этому сервису');
      }

      const service = await resolveServiceCounterparty(body.serviceCounterpartyId);

      const executorChanged = row.serviceCounterpartyId !== service.id;
      await db.transaction(async (tx) => {
        const patch: RequestPatch = { serviceCounterpartyId: service.id };
        if (executorChanged && !first) {
          // Смета прежнего исполнителя вместе с ревизией и снимком предъявления (§5.4).
          await assertEstimateReplaceable(tx, row.id);
          await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, row.id));
          patch.estimateRevision = 0;
          patch.estimateSubmittedAt = null;
          patch.estimatedTotalAmount = null;
          patch.approvedEstimateRevision = null;
          patch.estimateApprovedBy = null;
          patch.estimateApprovedAt = null;
        }
        await applyTransition(tx, {
          row,
          to: 'assigned',
          version: body.version,
          actor: p,
          comment: body.reason ?? body.comment,
          patch,
          touchStatusAt: true,
        });
      });

      await writeAudit({
        actorUserId: p.id,
        action: reassignment ? 'serviceRequest.reassign' : 'serviceRequest.assign',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          serviceCounterpartyId: service.id,
          serviceName: service.name,
          reason: body.reason ?? '',
          legacyAdapter: true,
        },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Виза отдела ИТ по смете (Н3) ──
  /**
   * Решение переехало со входа на смету: «чинить за эти деньги или менять аппарат». Одна ручка на
   * оба исхода — право одно (`serviceRequests.approveIt`), область одна и момент решения один, тот
   * же приём, что у согласования сметы.
   *
   * Первый исход **статуса не меняет**: он подписывает текущую ревизию сметы, и заявка остаётся в
   * «Смете на согласовании» — дальше её двигает согласование суммы. Поэтому коридора у него нет и
   * `assertSideAllowed` спрашивается только у второго.
   *
   * Второй закрывает заявку отменой с пометкой «рекомендована замена» (В21): своего терминального
   * статуса у него нет, «закрыта без результата» у модуля уже есть (Р53), а второе имя для того же
   * состояния делило бы отчёты пополам. Причина обязательна — из пометки собирается список «что
   * пора менять», и «ИТ отказал» без объяснения заказчик прочитает как молчание.
   */
  r.patch(
    '/:id/it-approval',
    { ...canApproveIt, schema: { params: idParams, body: approveServiceItSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      if (!body.approved) assertSideAllowed(p, 'cancelled', ['estimate_review']);
      const row = await requireEditable(p, req.params.id);
      assertRepairKind(row, 'визировать');
      // Визируют **смету**, а не заявку: до предъявления согласовывать нечего — предмет решения
      // (счёт инженера) появляется позже.
      if (row.status !== 'estimate_review') {
        throw err.unprocessable(
          `Визу ИТ ставят на предъявленную смету, а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Смета не предъявлена' },
        );
      }
      if (!body.approved) assertTransition(p, row.status, 'cancelled');

      if (body.approved) {
        // Порядок подписей жёсткий: сперва ИТ, потом деньги. Второй раз подписывать ту же ревизию
        // нечего — согласие уже стоит, и повтор лишь переписал бы дату решения.
        if (hasCurrentItApproval(waitingRowOf(row))) {
          throw err.unprocessable(
            `Виза ИТ на ревизию сметы ${row.estimateRevision} уже стоит — дальше решают по сумме`,
            { approved: 'Виза уже стоит' },
          );
        }
        const now = new Date();
        await db.transaction(async (tx) => {
          const locked = await lockRequest(tx, row.id);
          const [updated] = await tx
            .update(serviceRequests)
            .set({
              itApprovedBy: p.id,
              itApprovedAt: now,
              // Ревизия — то, **что именно** подписано (Н3): следующее предъявление поднимет её и
              // обесценит подпись, не стирая её. `NULL` осталась бы «входной визой старого
              // образца», то есть визой сметы не считалась бы вовсе.
              itApprovedEstimateRevision: locked.estimateRevision,
              // Автовизы больше нет ни при заведении, ни здесь: виза по смете — решение по чужому
              // счёту, и автоматической быть не может.
              itApprovedAuto: false,
              updatedBy: p.id,
              updatedAt: now,
              version: locked.version + 1,
            })
            .where(
              and(eq(serviceRequests.id, locked.id), eq(serviceRequests.version, body.version)),
            )
            .returning({ id: serviceRequests.id });
          if (!updated) throw err.conflict();
          // Строка истории у визы своя, хотя статус не меняется: «кто и когда подписал ревизию» —
          // событие цикла, и без неё лента показывала бы прыжок из «Сметы» в «В работе» без
          // объяснения, кто по дороге сказал «чинить».
          await recordServiceStatusTransition(tx, {
            requestId: locked.id,
            fromStatus: locked.status,
            toStatus: locked.status,
            estimateRevision: locked.estimateRevision,
            actorId: p.id,
            comment: body.reason ?? '',
          });
        });
      } else {
        await db.transaction(async (tx) => {
          await applyTransition(tx, {
            row,
            to: 'cancelled',
            version: body.version,
            actor: p,
            comment: body.reason,
            // Пометка живёт только у отменённой заявки (M5) и объясняет, почему её закрыли без
            // ремонта. Возврат в «Новую» снимает её матрицей сброса.
            patch: { replacementRecommended: true },
          });
        });
      }

      await writeAudit({
        actorUserId: p.id,
        action: body.approved ? 'serviceRequest.it_approve' : 'serviceRequest.it_reject',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          revision: row.estimateRevision,
          reason: body.reason ?? '',
          ...(body.approved ? {} : { replacementRecommended: true }),
        },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Отказ исполнителя (Н5, §4.2) ──
  /**
   * Отказ снимает **отказавшегося**, а не заявку с распределения, и слоя у него два, с разными
   * правилами — потому что назначаются они по-разному:
   *
   * - **свой сотрудник** снимает свою строку: остальные назначенные продолжают вести заявку;
   * - **оператор сервисной компании** снимает **всю компанию** — назначена была она, а не человек,
   *   поимённых строк у её сотрудников нет вовсе, и «часть подрядчика» отказаться не может.
   *
   * Заявка возвращается в «Новую», только если не осталось **ни строк, ни контрагента**. Осталось
   * хоть что-то — статус не меняется, и в истории остаётся строка о том, кто ушёл: пара переходов
   * без неё не объяснила бы, почему исполнителей стало меньше.
   *
   * Возврат идёт в «Новую», а не к визе ИТ (Н3): визы на входе больше нет.
   */
  r.patch(
    '/:id/decline',
    { ...canExecutorStatus, schema: { params: idParams, body: declineServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'new', ['assigned']);
      const row = await requireEditable(p, req.params.id);
      const assignment = await executorAssignment(p, row);
      assertTransition(p, row.status, 'new', assignment);

      const outcome = await db.transaction(async (tx) => {
        // Порядок блокировок тот же, что у назначения (Н5): сперва заявка, потом её исполнители.
        const locked = await lockRequest(tx, row.id);
        const named = await tx
          .select({ userId: serviceRequestExecutors.userId })
          .from(serviceRequestExecutors)
          .where(eq(serviceRequestExecutors.requestId, locked.id));

        /**
         * Каким слоем субъект держит заявку — решает та же функция контрактов, что открывает ему
         * ход исполнителя (`isServiceExecutor`): двух ответов на «исполнитель ли он и по какому
         * основанию» в модуле быть не должно. Признаки подаются по одному, порознь, — именно
         * потому, что снимается **тот слой, которым отказавшийся и был назначен**.
         */
        const ownRow = isServiceExecutor(p, {
          actsForAssignedCounterparty: false,
          isNamedExecutor: named.some((row) => row.userId === p.id),
        });
        const wholeCounterparty =
          !ownRow &&
          isServiceExecutor(p, {
            actsForAssignedCounterparty:
              locked.serviceCounterpartyId !== null &&
              locked.serviceCounterpartyId === p.counterpartyId,
            isNamedExecutor: false,
          });

        let restNamed = named;
        let restCounterparty = locked.serviceCounterpartyId;
        if (ownRow) restNamed = named.filter((row) => row.userId !== p.id);
        else if (wholeCounterparty) restCounterparty = null;
        else {
          // Ни строкой, ни компанией субъект в заявке не значится — сюда доходит только тот, кому
          // коридор открыт правом сметы, то есть администратор, доводящий чужую заявку. Отказ за
          // всех: выбирать, чью именно строку снять, ему не по чему.
          restNamed = [];
          restCounterparty = null;
        }

        if (restNamed.length === 0 && restCounterparty === null) {
          // Оба слоя снимает матрица возвратов (`reset.executor`): и контрагента, и строки.
          await applyTransition(tx, {
            row: locked,
            to: 'new',
            version: body.version,
            actor: p,
            comment: body.reason,
          });
          return { returned: true, wholeCounterparty, ownRow };
        }

        if (ownRow) {
          await tx
            .delete(serviceRequestExecutors)
            .where(
              and(
                eq(serviceRequestExecutors.requestId, locked.id),
                eq(serviceRequestExecutors.userId, p.id),
              ),
            );
        }
        const [updated] = await tx
          .update(serviceRequests)
          .set({
            serviceCounterpartyId: restCounterparty,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: locked.version + 1,
          })
          .where(and(eq(serviceRequests.id, locked.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
        // Статус тот же — строка истории всё равно пишется: иначе «исполнителей стало меньше»
        // осталось бы событием без следа, а спорят с подрядчиком именно по нему.
        await recordServiceStatusTransition(tx, {
          requestId: locked.id,
          fromStatus: locked.status,
          toStatus: locked.status,
          estimateRevision: locked.estimateRevision,
          actorId: p.id,
          comment: body.reason,
        });
        return { returned: false, wholeCounterparty, ownRow };
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.decline',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          reason: body.reason,
          serviceCounterpartyId: row.serviceCounterpartyId,
          // Что именно сняли и осталась ли заявка у кого-то: по одной причине этого не восстановить.
          scope: outcome.ownRow ? 'self' : outcome.wholeCounterparty ? 'counterparty' : 'all',
          returnedToNew: outcome.returned,
        },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Принятие заявки в работу ──
  // Своего события в аудите у перехода нет: содержания сверх самого перехода в нём тоже нет, и
  // строка аудита повторила бы строку истории статусов слово в слово.
  //
  // Отдельного статуса «Диагностика» больше нет (Н2): взявшийся за заявку стоит в «В работе» и
  // оттуда же предъявляет смету.
  r.patch(
    '/:id/start',
    { ...canExecutorStatus, schema: { params: idParams, body: startServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      assertSideAllowed(p, 'in_work', ['assigned']);
      const row = await requireEditable(p, req.params.id);
      const assignment = await executorAssignment(p, row);
      assertTransition(p, row.status, 'in_work', assignment);
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: 'in_work',
          version: req.body.version,
          actor: p,
        });
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Заморозка (Р103) ──
  /**
   * Своя дуга — своя ручка (Р18). Цель у заморозки одна, а исходных статусов много (Р106):
   * откладывают и «Новую» (ждём решения заказчика), и «Согласована ИТ» (нет денег до квартала), и
   * «Ожидает приёмки» (ждём акт от сервиса), — поэтому `assertSideAllowed` спрашивается без
   * перечня исходных, а настоящий коридор проверяет `assertTransition` уже по строке.
   *
   * Куда вернуть, клиент не присылает: исходный статус сервер берёт из самой заявки (Р104) — иначе
   * «Отложена» стала бы вторым входом в цикл, в обход виз, сметы и назначения. Причина обязательна
   * (Р107): даты «отложена до» у заморозки нет, и на вопрос «когда ждать» отвечает только она —
   * она же уходит комментарием в историю статусов.
   *
   * Письма службе заморозка не шлёт (Р111): это внутреннее решение оператора, а не событие для
   * исполнителя — о задержке сервис узнаёт звонком и может продолжать чинить.
   */
  r.patch(
    '/:id/hold',
    { ...canHold, schema: { params: idParams, body: serviceHoldSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertCanHold(p, 'откладывает заявку');
      assertSideAllowed(p, 'on_hold');
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'on_hold');
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: 'on_hold',
          version: body.version,
          actor: p,
          comment: body.reason,
          // Пара «откуда и почему» пишется целиком: порознь их не примет CHECK в базе, а чистит
          // обе выход из заморозки (Р118). Возраст в статусе обнуляет сам переход (Р108).
          patch: { heldFromStatus: row.status, holdReason: body.reason },
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.hold',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Откуда отложили — в metadata: после возврата заявка этого уже не помнит, поля чистятся.
        metadata: { from: row.status, reason: body.reason },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Возврат в работу ──
  /**
   * Таблицей коридора возврат не выражается: цель у него динамическая — тот статус, из которого
   * заявку отложили (`serviceResumeTarget`). Поэтому право спрашивается предикатом
   * `canResumeService`, а не `assertSideAllowed` (§6), и условие у него то же, что у заморозки
   * (Р105): держит и отпускает заявку тот, кто её ведёт, а исполнитель о задержке только сообщает.
   *
   * Поля заморозки обнуляет `applyTransition` по флагу `hold` из матрицы сбросов (Р118) — здесь их
   * трогать нечем и не нужно. Возраст в статусе обнуляется самим переходом (Р108): вернувшийся
   * исполнитель не наследует время, которое заявка простояла.
   */
  r.patch(
    '/:id/resume',
    { ...canHold, schema: { params: idParams, body: serviceResumeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      if (!canResumeService(p)) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не возвращает отложенную заявку в работу — это шаг того, кто её ведёт`,
        );
      }
      const row = await requireEditable(p, req.params.id);
      const target = serviceResumeTarget(row);
      if (!target) {
        throw err.unprocessable(
          `Заявка не отложена — она в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Заявка не отложена' },
        );
      }
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: target,
          version: body.version,
          actor: p,
          comment: body.comment,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.resume',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Куда вернули: в самой заявке после возврата от заморозки не остаётся ничего.
        metadata: { to: target },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Состав сметы ──
  /**
   * Смета передаётся целиком: это документ, и «добавить строку» без остальных строк не имеет
   * смысла. Правится она в «В работе» — предъявленная заперта (Р14), и отдельного статуса
   * «Диагностика» под неё больше нет (Н2).
   *
   * **Согласованная ревизия не правится.** Иначе состав менялся бы под уже поставленными
   * подписями: и виза ИТ, и согласие по сумме относятся к номеру ревизии, а не к строкам, и правка
   * без подъёма номера оставила бы обе подписи стоять под цифрами, которых никто не видел. Снять
   * согласование и открыть смету обратно — своё действие (`/estimate/reopen`).
   *
   * 409, а не 422: смету запер не сам исполнитель, а чужое действие — согласование, — и человеку
   * нужно обновить окно, а не исправить данные.
   */
  r.put(
    '/:id/estimate',
    { ...canEstimate, schema: { params: idParams, body: putServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      await assertExecutorSide(p, row, 'ведёт смету этой заявки');
      assertRepairKind(row, 'править');
      // legacy: `diagnostics` снимается выпуском 2 — из неё доступно то же, что из «В работе».
      if (row.status !== 'in_work' && row.status !== 'diagnostics') {
        throw err.conflict(
          `Смета правится только в статусе «${serviceRequestStatusLabels.in_work}»`,
        );
      }
      if (row.estimateRevision > 0 && row.approvedEstimateRevision === row.estimateRevision) {
        throw err.conflict(
          `Ревизия сметы ${row.estimateRevision} согласована — верните смету в правку, прежде чем менять состав`,
        );
      }
      const before = (await getDto(row.id))!;

      await db.transaction(async (tx) => {
        await assertEstimateReplaceable(tx, row.id);
        await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, row.id));
        if (body.items.length > 0) {
          await tx.insert(serviceRequestItems).values(
            body.items.map((item, index) => ({
              requestId: row.id,
              kind: item.kind,
              name: item.name,
              quantity: money(item.quantity),
              unitPrice: money(item.unitPrice),
              warrantyMonths: item.warrantyMonths ?? null,
              sortOrder: index,
            })),
          );
        }
        // Правка сметы возраст ожидания не сбрасывает: заявка всё это время ждёт того же сервиса.
        const [updated] = await tx
          .update(serviceRequests)
          .set({ updatedBy: p.id, updatedAt: new Date(), version: row.version + 1 })
          .where(and(eq(serviceRequests.id, row.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
      });

      const after = (await getDto(row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_update',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Состав, а не итог: «было 7 100, стало 6 900» скрывает, что вместо термоузла поставили
        // ролик, — а спорят с сервисом именно о составе.
        metadata: { changes: diffServiceEstimate(before.items, after.items) },
      });
      return after;
    },
  );

  // ── Предъявление сметы ──
  r.patch(
    '/:id/estimate/submit',
    { ...canEstimate, schema: { params: idParams, body: submitServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      // Смета предъявляется из «В работе» (Н2); `diagnostics` — legacy: снимается выпуском 2.
      assertSideAllowed(p, 'estimate_review', ['in_work', 'diagnostics']);
      const row = await requireEditable(p, req.params.id);
      assertRepairKind(row, 'предъявлять');
      const assignment = await executorAssignment(p, row);
      assertTransition(p, row.status, 'estimate_review', assignment);
      // Гарантийный ремонт — не пустая смета, а осознанное «чиним по гарантии, денег нет», и без
      // названного источника гарантии он ничем не подтверждён (Р27).
      if (body.warrantyRepair && !row.warrantyClaimSource) {
        throw err.unprocessable(
          'Гарантийный ремонт предъявляют по заявке с обращением по гарантии — укажите источник',
          { warrantyRepair: 'Нет обращения по гарантии' },
        );
      }

      const revision = row.estimateRevision + 1;
      const total = await db.transaction(async (tx) => {
        if (body.warrantyRepair) {
          await assertEstimateReplaceable(tx, row.id);
          await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, row.id));
          await tx.insert(serviceRequestItems).values({
            requestId: row.id,
            kind: 'service',
            name: WARRANTY_REPAIR_ITEM_NAME,
            quantity: '1',
            unitPrice: '0',
            sortOrder: 0,
          });
        }
        const items = await estimateItems(tx, row.id);
        if (items.length === 0) {
          throw err.unprocessable('Смета пуста — добавьте хотя бы одну строку');
        }
        const amount = sumAmounts(items);
        await applyTransition(tx, {
          row,
          to: 'estimate_review',
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: {
            estimateRevision: revision,
            estimateSubmittedAt: new Date(),
            // Снимок предъявленной суммы: по нему потом и сверяется закрытие.
            estimatedTotalAmount: money(amount),
          },
        });
        return amount;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_submit',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { revision, total, warrantyRepair: body.warrantyRepair },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Согласование сметы ──
  /**
   * Одна ручка на «да» и «нет»: у них одно право, одна область и один момент. Согласие пишет
   * снимок из трёх полей — кто, когда и какую ревизию, — потому что по отдельности ни одно из них
   * не отвечает на вопрос «что именно согласовали». Причину отказа требует тело ручки.
   *
   * Оба исхода ведут в **один статус** — «В работе» (Н2): «Диагностики», куда возвращалась
   * отклонённая смета, больше нет, и различает исходы не пара «откуда → куда», а само тело. Стирать
   * при отказе нечего: обе подписи обесценивает подъём ревизии на следующем предъявлении (Н3).
   *
   * **Порядок подписей жёсткий: сперва ИТ, потом деньги** (Н3). Иначе «Ведение» согласовывало бы
   * сумму ремонта, который через минуту признают ненужным. Проверяет порядок сервер, а не скрытая
   * кнопка портала.
   */
  r.patch(
    '/:id/estimate/approval',
    { ...canApproveEstimate, schema: { params: idParams, body: approveServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const to: ServiceRequestStatus = 'in_work';
      assertSideAllowed(p, to, ['estimate_review']);
      const row = await requireEditable(p, req.params.id);
      assertRepairKind(row, 'согласовывать');
      assertTransition(p, row.status, to);
      if (row.status !== 'estimate_review') {
        throw err.unprocessable(
          `Согласуют смету, предъявленную на согласование, а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
        );
      }
      if (body.approved && !hasCurrentItApproval(waitingRowOf(row))) {
        throw err.unprocessable(
          'Сумму согласуют после визы ИТ по этой ревизии сметы — сперва отдел ИТ решает, чинить или менять аппарат',
          { approved: 'Нет визы ИТ' },
        );
      }

      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to,
          version: body.version,
          actor: p,
          comment: body.reason ?? '',
          patch: body.approved
            ? {
                approvedEstimateRevision: row.estimateRevision,
                estimateApprovedBy: p.id,
                estimateApprovedAt: new Date(),
              }
            : {},
        });
      });

      await writeAudit({
        actorUserId: p.id,
        action: body.approved
          ? 'serviceRequest.estimate_approve'
          : 'serviceRequest.estimate_reject',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { revision: row.estimateRevision, reason: body.reason ?? '' },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Возврат сметы в правку ──
  /**
   * Единственный путь изменить **согласованную** смету (Р14). Статуса заявка при этом не меняет:
   * «Диагностики», куда она откатывалась прежде, больше нет (Н2), а второй дуги `in_work →
   * estimate_review` заводить нельзя — она сделала бы необязательным подъём ревизии, на котором
   * держится обесценивание обеих подписей (Н3).
   *
   * Поэтому ручка делает ровно одно: **снимает снимок согласования**. Дальше исполнитель правит
   * состав обычной ручкой сметы и предъявляет её заново — с ревизией +1, как любое предъявление.
   * Снимок согласования и есть то, что запирает правку: подпись под цифрами, которых уже нет, была
   * бы согласием, которого никто не давал.
   *
   * Визу ИТ ручка не трогает: обесценит её тот же подъём ревизии. Стереть её здесь значило бы
   * завести второе правило рядом с ревизионным — и разойтись с ним на первой же правке.
   */
  r.patch(
    '/:id/estimate/reopen',
    { ...canEstimate, schema: { params: idParams, body: reopenServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      await assertExecutorSide(p, row, 'возвращает смету в правку');
      assertRepairKind(row, 'возвращать в правку');
      // legacy: `diagnostics` снимается выпуском 2 — из неё доступно то же, что из «В работе».
      if (row.status !== 'in_work' && row.status !== 'diagnostics') {
        throw err.unprocessable(
          `Смету возвращают в правку из «${serviceRequestStatusLabels.in_work}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Другой статус' },
        );
      }
      if (row.approvedEstimateRevision === null) {
        throw err.unprocessable(
          'Согласования у этой сметы нет — снимать нечего, правьте состав и предъявляйте её заново',
          { status: 'Смета не согласована' },
        );
      }
      await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);
        const [updated] = await tx
          .update(serviceRequests)
          .set({
            approvedEstimateRevision: null,
            estimateApprovedBy: null,
            estimateApprovedAt: null,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: locked.version + 1,
          })
          .where(and(eq(serviceRequests.id, locked.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
        // Статус тот же, событие своё: «согласование снято» обязано быть видно в ленте — иначе
        // между двумя согласованиями одной заявки не понять, что произошло.
        await recordServiceStatusTransition(tx, {
          requestId: locked.id,
          fromStatus: locked.status,
          toStatus: locked.status,
          estimateRevision: locked.estimateRevision,
          actorId: p.id,
          comment: body.reason,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_reopen',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { revision: row.estimateRevision, reason: body.reason },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Строки заявки на расходники ──
  /**
   * Состав передаётся целиком, как и смета: это список того, что просят, и «добавить одну позицию»
   * без остальных заставляло бы сервер угадывать, снимали ли что-то.
   *
   * Право — `serviceRequests.update` (план §7.3): состав заявки на расходники это её **предмет**,
   * ровно как описание неисправности у ремонта, и правит его тот же субъект по тому же правилу
   * («заказчик — пока заявку никому не отдали»).
   *
   * ПОКА ВЫДАЧИ НЕ БЫЛО. Строку, за которой числится движение склада, не удаляет ни маршрут, ни
   * каскад (`ON DELETE RESTRICT` составного ключа журнала), и замена состава упёрлась бы в неё
   * `23503`. Но дело не в коде ошибки: заявка, по которой уже что-то выдали, — это не список
   * пожеланий, а основание записи на складе, и менять его задним числом нельзя.
   */
  r.put(
    '/:id/consumables',
    { ...canUpdate, schema: { params: idParams, body: putServiceConsumablesSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      if (row.kind !== 'consumable') {
        throw err.unprocessable('Строки номенклатуры бывают только у заявки на расходники', {
          items: 'Не тот вид заявки',
        });
      }
      // Действие — глаголом: отказ складывается в «… может править заявку только до назначения
      // сервиса», и «править состав» дало бы «править состав заявку».
      assertServiceRequestEditable(p, row.status, 'править');
      if (isServiceRequestClosed(row.status)) {
        throw err.unprocessable(
          `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» не правится`,
        );
      }
      // Отложенную не правит и администратор (Р110) — то же правило, что у прочей правки заявки.
      if (row.status === 'on_hold') {
        throw err.unprocessable('Отложенную заявку не правят — сначала возобновите её', {
          status: 'Заявка отложена',
        });
      }
      const before = (await getDto(row.id))!;

      await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);
        const lines = await consumableLinesOf(tx, locked.id);
        if (lines.some((line) => line.issuedQuantity !== null)) {
          throw err.conflict(
            'По заявке уже отмечена выдача — состав больше не меняют, правьте выданное количество',
          );
        }
        await assertConsumablesExist(
          tx,
          body.items.map((line) => line.consumableId),
        );
        await tx
          .delete(serviceRequestConsumables)
          .where(eq(serviceRequestConsumables.requestId, locked.id));
        await tx.insert(serviceRequestConsumables).values(
          body.items.map((line) => ({
            requestId: locked.id,
            consumableId: line.consumableId,
            requestedQuantity: line.requestedQuantity,
          })),
        );
        // Правка состава возраст ожидания не сбрасывает: заявка всё это время ждёт того же.
        const [updated] = await tx
          .update(serviceRequests)
          .set({ updatedBy: p.id, updatedAt: new Date(), version: locked.version + 1 })
          .where(and(eq(serviceRequests.id, locked.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
      });

      const after = (await getDto(row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.consumables_update',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Состав, а не «строки трогали»: спорят о том, что именно просили и в каком количестве.
        metadata: {
          before: before.consumables.map((line) => ({
            code: line.code,
            name: line.name,
            requestedQuantity: line.requestedQuantity,
          })),
          after: after.consumables.map((line) => ({
            code: line.code,
            name: line.name,
            requestedQuantity: line.requestedQuantity,
          })),
        },
      });
      return after;
    },
  );

  // ── Правка факта выдачи (Р6) ──
  /**
   * Склад двигает **изменение факта**, а не смена статуса. Каждая правка порождает событие на
   * разницу: было 2, стало 3 — `issue` на единицу; было 2, стало 0 — `return` на две. Возврат
   * заявки на доработку, отмена и откат склада не касаются вовсе: заявку возвращают на доработку не
   * потому, что картридж сняли с аппарата и увезли на склад, — тонер стоит там, где его поставили.
   * Вернули физически — исполнитель правит факт вниз этой самой ручкой, и это осознанное действие с
   * причиной, а не побочный эффект кнопки «вернуть».
   *
   * **Пока заявка не закрыта.** После «Закрыта» строки заявки замирают, и всё, что случилось со
   * складом дальше, — это уже ручная правка остатка с причиной, доступная тому, у кого есть на неё
   * право (`officeEquipmentConsumables.stock`). Иначе закрытая заявка оставалась бы бессрочным
   * входом в склад.
   */
  r.patch(
    '/:id/consumables/issued',
    { ...canSetIssued, schema: { params: idParams, body: setServiceConsumablesIssuedSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      if (row.kind !== 'consumable') {
        throw err.unprocessable('Выдачу отмечают только у заявки на расходники', {
          items: 'Не тот вид заявки',
        });
      }
      await assertConsumableIssuer(p, row);
      /**
       * Матрица §6.2 называет **два** статуса поимённо — «В работе» и «Решена», — и проверка
       * перечисляет их так же, вместо прежнего «лишь бы не закрыта». Разница не редакционная:
       * «не закрыта» пускало правку из «Новой» и «Назначена», то есть **списывало со склада по
       * заявке, которую ещё никто не взял в работу**, а держателю `serviceRequests.status`
       * назначение и не требуется. Отложенную не правят по тому же правилу, что и её состав
       * (Р110): под разбирательством о задержке факт выдачи — предмет спора, а не поле формы.
       *
       * Закрытой оставлен свой текст: там человеку нужен не список статусов, а куда идти дальше.
       */
      if (row.status !== 'in_work' && row.status !== 'done') {
        throw err.unprocessable(
          isServiceRequestClosed(row.status)
            ? `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» закрыта — остаток правят вручную, с правом на справочник`
            : `Выдачу отмечают в статусах «${serviceRequestStatusLabels.in_work}» и «${serviceRequestStatusLabels.done}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: isServiceRequestClosed(row.status) ? 'Заявка закрыта' : 'Другой статус' },
        );
      }

      const movements = await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);
        const written = await applyConsumableFacts(tx, {
          request: { id: locked.id, num: locked.num, kind: locked.kind },
          actor: p,
          facts: body.items,
          requireEveryLine: false,
        });
        const [updated] = await tx
          .update(serviceRequests)
          .set({ updatedBy: p.id, updatedAt: new Date(), version: locked.version + 1 })
          .where(and(eq(serviceRequests.id, locked.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
        return written;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.consumables_issued',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Движение склада — вместе с заявкой: журнал остатка отвечает на вопрос «что с полкой», а
        // аудит заявки — «кто и когда это сделал по ней».
        metadata: { movements },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Закрытие работ ──
  /**
   * Итог **не принимается от клиента**, а считается сервером из строк (Р12): присланная сумма
   * означала бы, что итог и состав могут разойтись молча — ровно то, ради чего строки заведены.
   *
   * Порядок в транзакции значим: сначала строкам проставляется факт, потом читаются их суммы
   * (`actual_amount` считает БД), потом складывается итог с корректировкой, и только затем он
   * сверяется с согласованным. Гарантии ставятся тем же обновлением строки, что и факт: гарантии на
   * невыполненную работу не бывает, и порознь эти два поля писать нельзя.
   */
  r.patch(
    '/:id/complete',
    { ...canEstimate, schema: { params: idParams, body: completeServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      // legacy: `diagnostics` снимается выпуском 2 — из неё доступно то же, что из «В работе».
      assertSideAllowed(p, 'done', ['in_work', 'diagnostics']);
      const row = await requireEditable(p, req.params.id);
      const assignment = await executorAssignment(p, row);
      assertTransition(p, row.status, 'done', assignment);
      // Закрывают по согласованной ревизии: иначе правка прошла бы между открытием окна
      // согласования и нажатием кнопки, и работы закрылись бы не по той смете.
      //
      // У расходников сметы нет вовсе (§6.2): согласовывать по картриджу со своего склада нечего и
      // не у кого, ревизия так и остаётся нулевой, а подписи — пустой. Спроси мы равенство и здесь,
      // ни одна заявка на расходники не закрылась бы никогда.
      if (row.kind === 'repair' && row.approvedEstimateRevision !== row.estimateRevision) {
        throw err.conflict(
          `Согласована ревизия сметы ${row.approvedEstimateRevision ?? 0}, а в заявке ${row.estimateRevision} — согласуйте её заново`,
        );
      }
      // Дата выполнения не бывает в будущем: от неё отсчитываются гарантии, и «закрыто 2027-м»
      // сдвинуло бы их на годы вперёд — портал перестал бы отвечать, действует гарантия или нет.
      // Проверка здесь, а не в схеме: «сегодня» знает сервер, и календарные сутки у него московские.
      const closingToday = warrantyToday();
      if (body.completedOn > closingToday) {
        throw err.unprocessable('Дата выполнения не может быть в будущем', {
          completedOn: 'Дата в будущем',
        });
      }
      // Скидка и причина — неразрывная пара: причина без суммы ничего не корректирует, сумма без
      // причины делает итог необъяснимым. Нулевую отсекает схема (`negative`).
      if (body.adjustmentAmount != null && !body.adjustmentReason) {
        throw err.unprocessable('Скидку по акту нужно объяснить', {
          adjustmentReason: 'Укажите причину',
        });
      }
      if (body.adjustmentAmount == null && body.adjustmentReason) {
        throw err.unprocessable('Причина без суммы ничего не корректирует', {
          adjustmentAmount: 'Укажите сумму скидки',
        });
      }

      const outcome = await db.transaction(async (tx) => {
        /**
         * Планка закрывающего документа переехала сюда с приёмки (Н8): за работу внешнего сервиса
         * платят, и бумага — основание платежа. Свой сисадмин и замена картриджа закрываются без
         * неё — правило живёт **одной функцией контрактов**, потому что спрашивают его четверо:
         * этот переход, отбор пачки автозакрытия, портал неактивной кнопкой и текст отказа.
         *
         * Проверка внутри транзакции и после блокировки строки (Р112): между чтением и `COMMIT`
         * документ успевают снять, и `EXISTS`, посчитанный до неё, ничего не гарантирует.
         */
        const locked = await lockRequest(tx, row.id);
        if (serviceRequestNeedsClosingDocument(locked)) {
          const [closing] = await tx
            .select({ fileId: serviceRequestFiles.fileId })
            .from(serviceRequestFiles)
            .where(
              and(
                eq(serviceRequestFiles.requestId, locked.id),
                inArray(serviceRequestFiles.kind, [...SERVICE_CLOSING_DOCUMENT_KINDS]),
              ),
            )
            .limit(1);
          if (!closing) {
            throw err.unprocessable(
              'Перевод в «Решена» требует закрывающего документа — акта, счёта или гарантийного талона',
              { files: 'Нет закрывающего документа' },
            );
          }
        }
        const rows = await estimateItems(tx, row.id);
        const sent = new Map(body.items.map((item) => [item.id, item]));
        if (sent.size !== rows.length) {
          throw err.unprocessable('Отметка о выполнении нужна по каждой строке сметы', {
            items: 'Заполните все строки',
          });
        }
        // Шаг 1: факт по строкам. Каждая обязана получить `true` или `false` — «не заполнено»
        // после закрытия означало бы план, выданный за факт.
        for (const item of rows) {
          const fact = sent.get(item.id);
          if (!fact) {
            throw err.unprocessable(`По строке «${item.name}» нет отметки о выполнении`, {
              items: 'Заполните все строки',
            });
          }
          if (!fact.performed && fact.actualQuantity != null) {
            throw err.unprocessable(
              `Строка «${item.name}» не выполнена — фактического количества у неё быть не может`,
              { items: 'Уберите количество' },
            );
          }
          if (fact.actualQuantity != null && fact.actualQuantity > Number(item.quantity)) {
            throw err.unprocessable(
              `По строке «${item.name}» фактическое количество больше согласованного — это удорожание, его согласуют заново`,
              { items: 'Количество больше согласованного' },
            );
          }
          if (!fact.performed && fact.warrantyUntil) {
            throw err.unprocessable(`На невыполненную строку «${item.name}» гарантии не бывает`, {
              items: 'Уберите гарантию',
            });
          }
          // Гарантия из талона не может кончиться раньше, чем работы сделаны: такая дата — либо
          // опечатка в году, либо чужой талон. Молча принятая, она означала бы позицию, на которую
          // гарантия «была», но никогда не действовала.
          if (fact.warrantyUntil && fact.warrantyUntil < body.completedOn) {
            throw err.unprocessable(
              `Гарантия по строке «${item.name}» истекает раньше даты выполнения — проверьте талон`,
              { items: 'Гарантия раньше выполнения' },
            );
          }
          // Дата из талона побеждает расчёт и помечается как введённая руками: её источник —
          // бумага, а не «дата выполнения плюс N месяцев».
          const warrantyUntil = !fact.performed
            ? null
            : (fact.warrantyUntil ??
              (item.warrantyMonths ? addMonths(body.completedOn, item.warrantyMonths) : null));
          await tx
            .update(serviceRequestItems)
            .set({
              performed: fact.performed,
              actualQuantity:
                fact.performed && fact.actualQuantity != null ? money(fact.actualQuantity) : null,
              warrantyUntil,
              warrantyUntilManual: !!fact.performed && !!fact.warrantyUntil,
              updatedAt: new Date(),
            })
            .where(eq(serviceRequestItems.id, item.id));
        }

        // Шаг 2: суммы читаются уже после обновления — `actual_amount` считает БД.
        const done = await tx
          .select({ amount: serviceRequestItems.actualAmount })
          .from(serviceRequestItems)
          .where(eq(serviceRequestItems.requestId, row.id));
        // Шаг 3: итог по акту — сумма выполненного плюс скидка.
        const works = sumAmounts(done);
        const adjustment = body.adjustmentAmount ?? null;
        const total = works + (adjustment ?? 0);
        if (total < 0) {
          throw err.unprocessable('Скидка больше суммы выполненных работ', {
            adjustmentAmount: 'Скидка больше итога',
          });
        }
        // Шаг 4: сверка с согласованным — страховка инварианта, а не рабочая проверка: поднять
        // цену или объём при закрытии нечем (CHECK не даёт), и сработать она может только на
        // испорченных данных.
        const approved = num(row.estimatedTotalAmount);
        if (approved !== null && total > approved) {
          throw err.conflict(
            `Итог по акту (${money(total)}) больше согласованной сметы (${money(approved)})`,
          );
        }

        /**
         * Шаг 5: списание расходников — **той же транзакцией**, что и смена статуса (Р5), и до
         * неё: нехватка остатка обязана отменить весь переход, иначе заявка успевала бы стать
         * решённой при неудавшемся списании. Порядок захвата блокировок — внутри
         * `applyConsumableFacts`: заявка уже взята `lockRequest` выше, дальше идут карточки склада
         * по возрастанию `consumable_id`.
         *
         * Списывается **факт**, а не запрошенное (Р3): заявка на два тонера, из которых поставили
         * один, оставила бы склад врущим на единицу — и без всякого признака, что это произошло.
         */
        const movements = await applyConsumableFacts(tx, {
          request: { id: locked.id, num: locked.num, kind: locked.kind },
          actor: p,
          facts: body.consumables ?? [],
          requireEveryLine: true,
        });

        // Шаг 6: факт закрытия. Дата выполнения — календарные сутки, момент собирается по Москве:
        // от неё считаются гарантии, и часовой пояс сдвигал бы их на день.
        await applyTransition(tx, {
          row,
          to: 'done',
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: {
            completedAt: moscowInstantOf(body.completedOn, '00:00'),
            // Итога по акту у расходников не бывает: сметы нет, платить не за что, и «0,00 ₽» в
            // карточке читалось бы как выполненная на ноль работа.
            finalTotalAmount: locked.kind === 'consumable' ? null : money(total),
            finalAdjustmentAmount: adjustment === null ? null : money(adjustment),
            finalAdjustmentReason: adjustment === null ? '' : body.adjustmentReason,
          },
        });
        return { total, works, movements };
      });

      const after = (await getDto(row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.complete',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          revision: row.estimateRevision,
          total: outcome.total,
          works: outcome.works,
          adjustment: body.adjustmentAmount ?? null,
          // Что уехало со склада этим закрытием (Р10): в истории заявки строка «Списано со склада:
          // Тонер Ricoh 201 — 2 шт» берётся отсюда.
          movements: outcome.movements,
          // Что именно предъявил исполнитель: «тормозную площадку не ставили» иначе осталось бы
          // незамеченным, а гарантию на неё искали бы годом позже.
          changes: diffServiceCompletion(after.items),
          /**
           * Выданные гарантии — снимком (Р77). В самой смете живёт только последнее значение:
           * возврат на доработку его обнуляет, повторное закрытие перезаписывает, и лента истории
           * техники не смогла бы ответить, до какого числа обещали в первый раз.
           */
          grantedWarranties: after.items
            .filter((item) => item.warrantyUntil)
            .map((item) => ({
              itemId: item.id,
              name: item.name,
              warrantyUntil: item.warrantyUntil,
            })),
        },
      });
      return after;
    },
  );

  // ── Приёмка ──
  /**
   * Планки закрывающего документа здесь больше нет: она переехала на «Решена» (Н8) — туда, где
   * работу предъявляют. Проверять её дважды значило бы держать одно правило в двух местах, а
   * заявку-наследие, уехавшую в «Решена» без бумаги до выпуска 1, приёмка запирала бы навсегда:
   * автозакрытие такую заявку не берёт, и снять её с очереди мог бы только человек.
   *
   * Снятый последним закрывающий документ у принятой заявки по-прежнему не снимает никто
   * (`DELETE /:id/files/:fileId`): планка удерживается там, где её можно обойти.
   *
   * Приёмка человеком — `acceptance_source = 'human'` (Н7). Автоматическая пишет `auto` и пустого
   * автора, и различает их именно это поле, а не отсутствие имени: имя теряется вместе с учёткой.
   */
  r.patch(
    '/:id/accept',
    { ...canChangeStatus, schema: { params: idParams, body: acceptServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'accepted', ['done']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'accepted');
      await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);
        await applyTransition(tx, {
          // Переход считается по строке, перечитанной под блокировкой: расхождение с прочитанной
          // до транзакции упрётся в сверку версии и вернёт 409, а не молча пройдёт по старой.
          row: locked,
          to: 'accepted',
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: { acceptedBy: p.id, acceptedAt: new Date(), acceptanceSource: 'human' },
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.accept',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { total: num(row.finalTotalAmount) },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Возврат на доработку ──
  // Факт закрытия снимает матрица §5.4: работы предъявят заново, и «сколько сделали» до этого
  // момента остаётся без ответа — иначе в заявке «в работе» висел бы итог, которого никто не принял.
  r.patch(
    '/:id/rework',
    { ...canChangeStatus, schema: { params: idParams, body: reworkServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'in_work', ['done']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'in_work');
      const reworked = await db.transaction(async (tx) =>
        applyTransition(tx, {
          row,
          to: 'in_work',
          version: body.version,
          actor: p,
          comment: body.reason,
        }),
      );
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.rework',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Снятые гарантии — снимком: строка сметы своё прошлое не помнит, и лента истории техники
        // иначе показала бы «гарантия была» без даты, до которой её обещали (Р77).
        metadata: { reason: body.reason, clearedWarranties: reworked.clearedWarranties },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Отмена и административные откаты ──
  /**
   * Только они (Р18): у остальных переходов есть содержание, и оно проверяется своей ручкой рядом
   * со своей схемой. Отдать их сюда значило бы завести второй путь к тем же переходам — без
   * назначенного исполнителя, без ревизии сметы и без факта закрытия.
   */
  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: serviceStatusChangeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const to = body.status;
      // Здесь дуга не одна: целевой статус называет тело, а исходных у отмены и откатов много.
      assertSideAllowed(p, to);
      const row = await requireEditable(p, req.params.id);
      if (to !== 'cancelled' && !SERVICE_ADMIN_ROLLBACKS[row.status].includes(to)) {
        throw err.unprocessable(
          `Этой ручкой заявку только отменяют и откатывают назад; переход «${serviceRequestStatusLabels[row.status]}» → «${serviceRequestStatusLabels[to]}» делается своим действием`,
          { status: 'Другое действие' },
        );
      }
      assertTransition(p, row.status, to);
      // Переход, отменяющий чужую работу, требует объяснения: без него в истории останется пара
      // строк, по которой не понять, что именно случилось.
      if (serviceStatusChangeRequiresReason(row.status, to) && !body.reason) {
        throw err.unprocessable('Укажите причину', { reason: 'Укажите причину' });
      }

      /**
       * Письмо у этой ручки бывает дважды: отмена («не выезжайте») и откат в «Новую» — заявка
       * снова ждёт визы, и ждут её так же, как при заведении (Р65). Адресаты считаются до
       * транзакции, автор письма для обратного адреса — автор самой заявки.
       */
      const mailPlan = await planServiceMail(to, { actor: p, authorId: row.createdBy });

      const transition = await db.transaction(async (tx) =>
        applyTransition(tx, {
          row,
          to,
          version: body.version,
          actor: p,
          comment: body.reason,
          mail: mailPlan.plan,
        }),
      );
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.status',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          from: row.status,
          to,
          reason: body.reason,
          // Второй путь к очистке факта — административный `done → in_work` (Р77).
          ...(transition.clearedWarranties.length > 0
            ? { clearedWarranties: transition.clearedWarranties }
            : {}),
        },
      });
      if (transition.mailFailed) {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: row.id,
          metadata: { event: mailPlan.plan?.event ?? null },
        });
      }
      return {
        request: (await getDto(row.id))!,
        mail: transition.mailFailed ? 'mail_failed' : mailPlan.outcome,
      };
    },
  );

  /**
   * Повторная отправка письма службе (Р70).
   *
   * Что именно повторяется, решает сервер: берётся последняя строка истории **текущего** статуса, и
   * работает это лишь там, где у статуса есть событие — «Новая» и «Отменена». В остальных статусах
   * повторять нечего: письма по ним не уходили, и сервер выбирал бы наугад.
   *
   * Ключ идемпотентности приходит от портала: два одновременных нажатия и повтор HTTP дают одно
   * письмо, а осознанный второй заход — новое. Право — у того, кто ведёт заявки (и у администратора,
   * который разбирает застрявшее).
   */
  r.post(
    '/:id/notify',
    { ...canChangeStatus, schema: { params: idParams, body: notifyServiceRequestSchema } },
    async (req): Promise<ServiceRequestNotifyResultDto> => {
      const p = requirePrincipal(req);
      const row = await requireEditable(p, req.params.id);

      const event = serviceMailEventOf(row.status);
      if (!event) {
        throw err.unprocessable('По этой заявке письма службе не отправлялись', {
          status: 'Нечего повторять',
        });
      }

      const [entry] = await db
        .select({ id: serviceRequestStatusHistory.id })
        .from(serviceRequestStatusHistory)
        .where(
          and(
            eq(serviceRequestStatusHistory.requestId, row.id),
            eq(serviceRequestStatusHistory.toStatus, row.status),
          ),
        )
        .orderBy(desc(serviceRequestStatusHistory.changedAt))
        .limit(1);
      if (!entry) {
        throw err.unprocessable('В истории заявки нет записи о переходе в текущий статус', {
          status: 'Нечего повторять',
        });
      }

      const mailPlan = await planServiceMail(row.status, { actor: p, authorId: row.createdBy });
      if (!mailPlan.plan) return { mail: mailPlan.outcome, recipients: [] };
      const plan = mailPlan.plan;

      const failed = await db.transaction(async (tx) => {
        const data = await loadServiceLetterData(tx, row.id);
        let letter: ReturnType<typeof renderServiceLetter>;
        try {
          letter = renderServiceLetter(plan.event, data);
        } catch (e) {
          logServiceMailFailure(row.id, e);
          return true;
        }
        await queueServiceMails(tx, {
          plan,
          statusHistoryId: entry.id,
          requestId: row.id,
          letter,
          idempotencyKey: req.body.idempotencyKey,
        });
        return false;
      });

      await writeAudit({
        actorUserId: p.id,
        // Именно «поставлено в очередь»: отправляет письмо worker, и «отправлено» здесь было бы
        // обещанием, которого этот момент не даёт.
        action: failed ? 'serviceRequest.mailFailed' : 'serviceRequest.mailQueued',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { event, recipients: plan.recipients.map((r) => r.email) },
      });

      return {
        mail: failed ? 'mail_failed' : 'queued',
        recipients: failed ? [] : plan.recipients.map((r) => r.email),
      };
    },
  );

  // ── Примечание исполнителя (приём ADR 0053) ──
  // Ход заявки оно не меняет и возраст ожидания не сбрасывает: это строка сервиса в карточке.
  r.patch(
    '/:id/service-comment',
    { ...canEstimate, schema: { params: idParams, body: serviceCommentSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      await assertExecutorSide(p, row, 'пишет примечание исполнителя');
      if (isServiceRequestClosed(row.status)) {
        throw err.unprocessable(
          `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» не правится`,
        );
      }
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(serviceRequests)
          .set({
            serviceComment: body.serviceComment,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: row.version + 1,
          })
          .where(and(eq(serviceRequests.id, row.id), eq(serviceRequests.version, body.version)))
          .returning({ id: serviceRequests.id });
        if (!updated) throw err.conflict();
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.service_comment',
        entityType: 'serviceRequest',
        entityId: row.id,
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Документы (§8.3) ──
  r.post(
    '/:id/files',
    { ...canFiles, schema: { params: idParams, body: attachServiceFilesSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { fileIds, kind } = req.body;
      const row = await requireEditable(p, req.params.id);
      assertFileKindAllowed(effectiveStatus(row), kind);

      await db.transaction(async (tx) => {
        const existing = await tx
          .select({ fileId: serviceRequestFiles.fileId })
          .from(serviceRequestFiles)
          .where(eq(serviceRequestFiles.requestId, row.id));
        assertTotalWithinLimit(existing.length, fileIds.length);
        await assertFilesAttachable(tx, fileIds, p.id);
        await tx
          .insert(serviceRequestFiles)
          .values(fileIds.map((fileId) => ({ requestId: row.id, fileId, kind, attachedBy: p.id })));
        await markFilesActive(tx, fileIds);
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.files_attach',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { kind, fileIds },
      });
      return (await getDto(row.id))!;
    },
  );

  /**
   * Снятие документа. После терминального статуса заявка бумаги только принимает: снять их может
   * лишь тот, кто распоряжается чужими файлами (`files.manageAny`). Предъявленная смета не
   * снимается вовсе — её возвращают в диагностику, а не вынимают из карточки. В остальном вложение
   * снимает тот, кто его приложил.
   *
   * Все проверки стоят **внутри транзакции, после `FOR UPDATE` по строке заявки** (Р112), и читают
   * статус, перечитанный под блокировкой. Прежде они решали по строке из `requireEditable` — то
   * есть по состоянию, которое к моменту удаления уже могло стать «Принята», а приёмка требует
   * закрывающего документа: заявка осталась бы принятой без единственной бумаги.
   */
  r.delete('/:id/files/:fileId', { ...canFiles, schema: { params: fileParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { fileId } = req.params;
    const row = await requireEditable(p, req.params.id);
    const manageAny = can(p, 'files.manageAny');

    const detached = await db.transaction(async (tx) => {
      const locked = await lockRequest(tx, row.id);
      const [link] = await tx
        .select({
          kind: serviceRequestFiles.kind,
          attachedBy: serviceRequestFiles.attachedBy,
          id: files.id,
          objectKey: files.objectKey,
        })
        .from(serviceRequestFiles)
        .innerJoin(files, eq(serviceRequestFiles.fileId, files.id))
        .where(
          and(eq(serviceRequestFiles.requestId, locked.id), eq(serviceRequestFiles.fileId, fileId)),
        );
      if (!link) throw err.notFound('Файл не прикреплён к этой заявке');

      // Статус — «эффективный» (Р110), тем же правилом, что и виды документов при подшивке:
      // заморозка бумаги не запирает, и смета отложенной «Диагностики» снимается так же, как
      // смета незамороженной.
      const status = effectiveStatus(locked);
      if (isServiceRequestClosed(status) && !manageAny) {
        throw err.forbidden('Из закрытой заявки документы не снимают');
      }
      // legacy: `diagnostics` снимается выпуском 2 — смета живёт в «В работе» (Н2).
      if (
        link.kind === 'estimate' &&
        status !== 'in_work' &&
        status !== 'diagnostics' &&
        !manageAny
      ) {
        throw err.unprocessable(
          'Предъявленная смета не снимается — верните заявку в работу и предъявите смету заново',
          { kind: 'Смета предъявлена' },
        );
      }
      if (link.attachedBy !== p.id && !manageAny) {
        throw err.forbidden('Снять вложение может тот, кто его приложил');
      }
      /*
       * Последний закрывающий документ у принятой заявки не снимает никто — включая
       * `files.manageAny` (ADR 0125). Планка Р112 иначе держалась бы **только** в момент приёмки:
       * принять без бумаги нельзя, а через минуту снять её — можно, и принятая заявка оставалась бы
       * без подтверждения работы, ничем не отбираясь ни очередью, ни отчётом. Ошибочный акт
       * меняется в обратном порядке: сначала подшить верный, потом снять неверный.
       *
       * Считается здесь же, под блокировкой строки: параллельная приёмка и параллельное снятие
       * второго документа выстроены в ту же очередь, и «последний» не устареет между проверкой и
       * удалением.
       */
      if (status === 'accepted' && isServiceClosingDocument(link.kind)) {
        const [other] = await tx
          .select({ fileId: serviceRequestFiles.fileId })
          .from(serviceRequestFiles)
          .where(
            and(
              eq(serviceRequestFiles.requestId, locked.id),
              inArray(serviceRequestFiles.kind, [...SERVICE_CLOSING_DOCUMENT_KINDS]),
              ne(serviceRequestFiles.fileId, fileId),
            ),
          )
          .limit(1);
        if (!other) {
          throw err.unprocessable(
            'Это единственный документ, по которому заявку приняли — подшейте другой и снимите этот',
            { kind: 'Последний закрывающий документ' },
          );
        }
      }

      await tx
        .delete(serviceRequestFiles)
        .where(
          and(eq(serviceRequestFiles.requestId, locked.id), eq(serviceRequestFiles.fileId, fileId)),
        );
      // Из хранилища объект уходит отложенно: ошибочно откреплённый файл успевают вернуть.
      await scheduleFilesDeletion(tx, [{ id: link.id, objectKey: link.objectKey }], false);
      return link;
    });

    await writeAudit({
      actorUserId: p.id,
      action: 'serviceRequest.files_detach',
      entityType: 'serviceRequest',
      entityId: row.id,
      metadata: { kind: detached.kind, fileIds: [fileId] },
    });
    return (await getDto(row.id))!;
  });

  // ── Восстановление из архива ──
  /**
   * Идемпотентно: живая заявка просто отдаётся — повтор запроса при потерянном ответе обычное дело.
   * Пока заявка лежала в архиве, по той же единице могли завести новую: уникальный индекс (Р21)
   * иначе отклонил бы возврат ошибкой БД, а человеку нужен номер той заявки, которая заняла место.
   */
  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      schema: { params: idParams },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const restored = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(serviceRequests)
          .where(eq(serviceRequests.id, req.params.id));
        if (!row) throw err.notFound(NOT_FOUND);
        // Область — до разбора состояния: живая заявка отдаётся отсюда карточкой целиком (повтор
        // запроса — обычное дело), и проверка после `if (!row.deletedAt)` не мешала бы читать чужую
        // заявку в обход `serviceRequests.read`.
        assertScope(p, row);
        if (!row.deletedAt) return false;
        if (!isServiceRequestClosed(row.status)) {
          await assertNoOpenRequest(tx, row.officeEquipmentId, row.kind, row.id);
        }
        await tx
          .update(serviceRequests)
          .set({
            deletedAt: null,
            deletedBy: null,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: row.version + 1,
          })
          .where(eq(serviceRequests.id, row.id));
        return true;
      });
      // Журнал пишется только на состоявшемся возврате: на повторе восстанавливать было нечего.
      if (restored) {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.restore',
          entityType: 'serviceRequest',
          entityId: req.params.id,
        });
      }
      return (await getDto(req.params.id))!;
    },
  );

  /**
   * Удаление насовсем (ADR 0060, ADR 0070) — только из архива, вторым шагом после осознанного
   * первого. Строки сметы, документы и история уходят каскадом; сама заявка держит единицу
   * оргтехники `RESTRICT`, а её строки — гарантийные обращения других заявок. Второе объясняется
   * до транзакции и номерами: «на запись ссылаются другие данные» в споре о гарантии не ответ.
   */
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      const nums = await claimingRequestNumbers(tx, row.id);
      if (nums.length > 0) {
        throw err.conflict(
          `По гарантии этой заявки обращались: ${nums.join(', ')} — удалить её насовсем нельзя`,
        );
      }
      const linked = await tx
        .select({ id: files.id, objectKey: files.objectKey })
        .from(serviceRequestFiles)
        .innerJoin(files, eq(serviceRequestFiles.fileId, files.id))
        .where(eq(serviceRequestFiles.requestId, row.id));
      await tx.delete(serviceRequests).where(eq(serviceRequests.id, row.id));
      await hardDeleteFiles(tx, linked);
    },
    notFound: NOT_FOUND,
    stillLive: 'Заявка не в архиве — сначала удалите её',
    subject: 'заявку',
    audit: {
      action: 'serviceRequest.purge',
      entityType: 'serviceRequest',
      // Номер и предмет: после удаления по entityId искать уже нечего, а спрашивают «куда делась
      // СО-14».
      metadata: (row) => ({
        num: row.num,
        equipment: officeEquipmentTitle({
          name: row.equipmentName,
          serialNumber: row.equipmentSerialNumber,
          inventoryNumber: row.equipmentInventoryNumber,
        }),
        status: row.status,
      }),
    },
  });
}
