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
  canResumeService,
  canTransitionServiceStatus,
  completeServiceRequestSchema,
  createServiceRequestSchema,
  declineServiceRequestSchema,
  formatServiceRequestNumber,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isServiceRequestClosed,
  isWarrantyActive,
  isWaitingOn,
  moscowInstantOf,
  officeEquipmentTitle,
  parseServiceRequestNumberSearch,
  putServiceEstimateSchema,
  reopenServiceEstimateSchema,
  reworkServiceRequestSchema,
  roleLabels,
  SERVICE_ADMIN_ROLLBACKS,
  isServiceClosingDocument,
  SERVICE_CLOSING_DOCUMENT_KINDS,
  SERVICE_REQUEST_STATUSES,
  serviceCommentSchema,
  serviceFileKindLabels,
  serviceHoldSchema,
  serviceRequestListQuerySchema,
  serviceRequestStatusLabels,
  serviceResetOnTransition,
  serviceResumeSchema,
  serviceResumeTarget,
  serviceStatusChangeRequiresReason,
  notifyServiceRequestSchema,
  type ServiceRequestNotifyResultDto,
  serviceStatusChangeSchema,
  serviceWaitingOn,
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
  type ServiceFileKind,
  type ServiceWarrantyRowDto,
  type ServiceRequestDto,
  type ServiceRequestFileDto,
  type ServiceRequestItemDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  files,
  officeEquipment,
  officeEquipmentTypes,
  serviceRequestFiles,
  serviceRequestItems,
  serviceRequests,
  serviceRequestStatusHistory,
  users,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  loadServiceLetterData,
  logServiceMailFailure,
  planServiceMail,
  queueServiceMails,
  renderServiceLetter,
  serviceMailEventOf,
  type ServiceMailPlan,
} from '../services/service-request-mail';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import {
  archiveWhere,
  assertArchiveVisible,
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

function toDto(
  row: HeaderRow,
  items: ServiceRequestItemDto[],
  fileList: ServiceRequestFileDto[],
): ServiceRequestDto {
  const r = row.r;
  return {
    id: r.id,
    num: r.num,
    displayNumber: formatServiceRequestNumber(r.num),
    status: r.status,
    statusChangedAt: r.statusChangedAt.toISOString(),
    // Кого ждут — считает сервер: правило одно на список, карточку и бейдж раздела (Р35).
    waitingOn: serviceWaitingOn(r.status),
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
  const [items, fileMap] = await Promise.all([itemsByRequest(ids), filesByRequest(ids)]);
  return rows.map((row) => toDto(row, items.get(row.r.id) ?? [], fileMap.get(row.r.id) ?? []));
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
  if (from.some((status) => canTransitionServiceStatus(status, to, p))) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(
    `${who} не переводит заявку в «${serviceRequestStatusLabels[to]}» — это шаг другой стороны`,
  );
}

/**
 * Переход доступен субъекту — коридор из контрактов (Р17). 403, а не 422: сам переход существует,
 * но не для этой стороны — оператор не ведёт смету, а сервис не принимает работу за заказчика.
 */
function assertTransition(
  p: Principal,
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
): void {
  if (canTransitionServiceStatus(from, to, p)) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(
    `${who} не может перевести заявку «${serviceRequestStatusLabels[from]}» → «${serviceRequestStatusLabels[to]}»`,
  );
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

async function assertNoOpenRequest(tx: Tx, equipmentId: string, exceptId?: string): Promise<void> {
  const [open] = await tx
    .select({ num: serviceRequests.num })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipmentId),
        isNull(serviceRequests.deletedAt),
        notInArray(serviceRequests.status, ['accepted', 'cancelled']),
        exceptId ? ne(serviceRequests.id, exceptId) : undefined,
      ),
    );
  if (!open) return;
  // Номер в ответе — не украшение: портал вместо глухого отказа предлагает открыть эту заявку.
  throw err.conflict(
    `По этой технике уже есть незакрытая заявка ${formatServiceRequestNumber(open.num)} — откройте её`,
  );
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
  if (reset.executor) set.serviceCounterpartyId = null;
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
  estimate: ['diagnostics', 'estimate_review'],
  act: ['in_work', 'done', 'accepted', 'cancelled'],
  invoice: ['in_work', 'done', 'accepted', 'cancelled'],
  warranty_card: ['done', 'accepted', 'cancelled'],
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
  const canEstimate = {
    preHandler: [
      app.authenticate,
      app.requirePermission('serviceRequests.estimate', 'Смету ведёт исполнитель'),
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
  const canFiles = {
    preHandler: [app.authenticate, app.requirePermission('serviceRequests.files')],
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

  /** Статусы, в которых ждут именно этого субъекта, — очередь «Требуют решения» (Р35). */
  function waitingStatuses(p: Principal): ServiceRequestStatus[] {
    return SERVICE_REQUEST_STATUSES.filter((status) => isWaitingOn(p, serviceWaitingOn(status)));
  }

  // ── Список ──
  r.get('/', { ...auth, schema: { querystring: serviceRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const mine = waitingStatuses(p);
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
        ? mine.length > 0
          ? inArray(serviceRequests.status, mine)
          : // У субъекта без шага в цикле (наблюдатель) очередь пуста, а не равна всему списку.
            sql`false`
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
    const mine = waitingStatuses(p);
    if (mine.length === 0) return { count: 0 };
    const [row] = await db
      .select({ c: count() })
      .from(serviceRequests)
      .where(
        and(
          isNull(serviceRequests.deletedAt),
          visibility(p),
          inArray(serviceRequests.status, mine),
        ),
      );
    return { count: Number(row!.c) };
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
       * Заявку, заведённую обладателем визы, визирует сама система (Р52) — приём ADR 0025
       * (решение 5). Администратора это не касается (ADR 0032): он заводит заявку не от имени
       * отдела ИТ, и его заявка ждёт визы наравне с остальными.
       */
      const autoApproved = p.role !== 'admin' && can(p, 'serviceRequests.approveIt');
      const now = new Date();

      /**
       * Адресаты и обратные адреса считаются **до** транзакции (Р67): здесь ходят в базу и в
       * конфигурацию, и отказ по данным внутри транзакции откатил бы саму заявку. Мягкий исход
       * («почта выключена», «канал не настроен») возвращается ответом — заявка заводится в любом
       * случае.
       *
       * Автор будущей заявки — сам заводящий: ответ службы на письмо уйдёт ему.
       */
      const mailPlan = autoApproved
        ? ({ plan: null, outcome: 'queued' } as const)
        : await planServiceMail('new', { actor: p, authorId: p.id });

      const created = await db.transaction(async (tx) => {
        await assertNoOpenRequest(tx, equipment.id);
        const claim = await resolveWarrantyClaim(tx, body.warrantyClaim, equipment, null);
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
            description: body.description,
            responsibleName: body.responsibleName,
            responsiblePhone: body.responsiblePhone,
            isUrgent: body.isUrgent,
            urgencyReason: body.urgencyReason,
            ...(autoApproved
              ? {
                  status: 'it_approved' as const,
                  itApprovedBy: p.id,
                  itApprovedAt: now,
                  itApprovedAuto: true,
                }
              : {}),
            warrantyClaimSource: claim.source,
            warrantyClaimItemId: claim.itemId,
            comment: body.comment,
            createdBy: p.id,
            updatedBy: p.id,
          })
          .returning({ id: serviceRequests.id, num: serviceRequests.num });
        const request = row!;
        const transition = await recordServiceStatusTransition(tx, {
          requestId: request.id,
          fromStatus: null,
          // Автовиза видна в истории тем же переходом, что и заведение: заявка не была «Новой»
          // ни секунды, и рисовать событие, которого не происходило, незачем.
          toStatus: autoApproved ? 'it_approved' : 'new',
          estimateRevision: 0,
          actorId: p.id,
          comment: autoApproved ? 'Заявку завёл согласующий от ИТ — виза проставлена сразу' : '',
          // Письма у автовизы нет и не должно быть: адресат письма — тот же отдел, который заявку
          // и завёл, а «вам заявка, которую вы только что подписали» — шум (Р66). Механика это
          // делает сама: в «Новой» такая заявка не бывает.
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
        return { ...request, mailFailed: transition.mailFailed };
      });

      const dto = (await getDto(created.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.create',
        entityType: 'serviceRequest',
        entityId: created.id,
        metadata: {
          num: created.num,
          title: serviceRequestTitle(dto),
          objectId: equipment.objectId,
          customerDepartmentId,
          warrantyClaim: dto.warrantyClaim?.source ?? null,
          isUrgent: dto.isUrgent,
          itAutoApproved: autoApproved,
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
    { ...canUpdate, schema: { params: idParams, body: setServiceUrgencySchema } },
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
      if (!can(p, 'serviceRequests.assign')) {
        assertServiceRequestEditable(p, row.status, 'менять срочность');
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
    assertServiceRequestEditable(p, row.status, 'удалять');
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

  // ── Назначение и переназначение исполнителя ──
  /**
   * Переназначение — тот же статус, другой исполнитель: заявка не откатывается назад, но её
   * возраст в статусе обнуляется (`touchStatusAt`), иначе новый сервис наследовал бы чужое
   * ожидание. Вместе с исполнителем стирается его незавершённая смета и снимок согласования:
   * ревизия прежнего сервиса к новому отношения не имеет.
   *
   * Матрица `serviceResetOnTransition` эту дугу не покрывает и покрыть не может: она отвечает на
   * вопрос «куда перешла заявка», а здесь заявка никуда не переходила — сменился исполнитель.
   */
  r.patch(
    '/:id/service',
    { ...canAssign, schema: { params: idParams, body: assignServiceSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'assigned', ['it_approved', 'assigned', 'diagnostics']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'assigned');

      const reassignment = row.status !== 'it_approved';
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

      const [service] = await db
        .select({
          id: counterparties.id,
          name: counterparties.name,
          type: counterparties.type,
          isActive: counterparties.isActive,
          deletedAt: counterparties.deletedAt,
        })
        .from(counterparties)
        .where(eq(counterparties.id, body.serviceCounterpartyId));
      if (!service || service.deletedAt) throw err.badRequest('Контрагент не найден');
      if (service.type !== 'service') {
        throw err.badRequest(
          'Исполнителем может быть только контрагент типа «Сервисная компания»',
          {
            serviceCounterpartyId: 'Нужна сервисная компания',
          },
        );
      }
      if (!service.isActive) throw err.badRequest('Контрагент неактивен');

      const executorChanged = row.serviceCounterpartyId !== service.id;
      await db.transaction(async (tx) => {
        const patch: RequestPatch = { serviceCounterpartyId: service.id };
        if (executorChanged && row.status !== 'it_approved') {
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
        },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Виза отдела ИТ ──
  /**
   * Одна ручка на «да» и «нет» (Р51): у решения одно право, одна область и один момент — тот же
   * приём, что у согласования сметы. Отказ закрывает заявку с причиной (Р53): своего терминального
   * статуса у него нет, «закрыта без результата» у модуля уже есть, и второе имя для того же
   * состояния делило бы отчёты пополам.
   */
  r.patch(
    '/:id/it-approval',
    { ...canApproveIt, schema: { params: idParams, body: approveServiceItSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const to: ServiceRequestStatus = body.approved ? 'it_approved' : 'cancelled';
      assertSideAllowed(p, to, ['new']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, to);

      const now = new Date();
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to,
          version: body.version,
          actor: p,
          comment: body.reason,
          // Отказ визы снимать нечего: подписи ещё не было. Согласие пишет снимок решения —
          // «кто и когда», как виза заказа ТС (ADR 0025).
          patch: body.approved
            ? { itApprovedBy: p.id, itApprovedAt: now, itApprovedAuto: false }
            : {},
        });
      });

      await writeAudit({
        actorUserId: p.id,
        action: body.approved ? 'serviceRequest.it_approve' : 'serviceRequest.it_reject',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { reason: body.reason ?? '' },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Отказ исполнителя ──
  r.patch(
    '/:id/decline',
    { ...canChangeStatus, schema: { params: idParams, body: declineServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      // Отказ возвращает заявку оператору, а не в «Новую» (Р51): виза ИТ уже дана, и решение
      // «внешний ремонт нужен» отказом подрядчика не отменяется — менять надо исполнителя.
      assertSideAllowed(p, 'it_approved', ['assigned']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'it_approved');
      await db.transaction(async (tx) => {
        // Исполнителя снимает матрица возвратов: заявка снова ничья, но виза ИТ при ней остаётся.
        await applyTransition(tx, {
          row,
          to: 'it_approved',
          version: body.version,
          actor: p,
          comment: body.reason,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.decline',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { reason: body.reason, serviceCounterpartyId: row.serviceCounterpartyId },
      });
      return (await getDto(row.id))!;
    },
  );

  // ── Взятие в диагностику ──
  // Своего события в аудите у перехода нет: содержания сверх самого перехода в нём тоже нет, и
  // строка аудита повторила бы строку истории статусов слово в слово.
  r.patch(
    '/:id/start',
    { ...canChangeStatus, schema: { params: idParams, body: startServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      assertSideAllowed(p, 'diagnostics', ['assigned']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'diagnostics');
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: 'diagnostics',
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
    { ...canChangeStatus, schema: { params: idParams, body: serviceHoldSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
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
    { ...canChangeStatus, schema: { params: idParams, body: serviceResumeSchema } },
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
   * смысла. Правится она только в «Диагностике» — предъявленная заперта (Р14).
   *
   * 409, а не 422: смету запер не сам заказчик, а чужое действие — её предъявление, — и человеку
   * нужно обновить окно, а не исправить данные.
   */
  r.put(
    '/:id/estimate',
    { ...canEstimate, schema: { params: idParams, body: putServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      if (row.status !== 'diagnostics') {
        throw err.conflict(
          `Смета правится только в статусе «${serviceRequestStatusLabels.diagnostics}»`,
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
      assertSideAllowed(p, 'estimate_review', ['diagnostics']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'estimate_review');
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
   * не отвечает на вопрос «что именно согласовали». Отказ требует причины и стирает снимок
   * (матрица §5.4): заявка возвращается в диагностику к тому же исполнителю.
   */
  r.patch(
    '/:id/estimate/approval',
    { ...canApproveEstimate, schema: { params: idParams, body: approveServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const to: ServiceRequestStatus = body.approved ? 'in_work' : 'diagnostics';
      assertSideAllowed(p, to, ['estimate_review']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, to);
      if (row.status !== 'estimate_review') {
        throw err.unprocessable(
          `Согласуют смету, предъявленную на согласование, а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
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

  // ── Переоткрытие сметы ──
  // Единственный путь изменить согласованную смету (Р14): дуги `in_work → estimate_review` нет
  // намеренно, и второй путь назад сделал бы этот инвариант необязательным.
  r.patch(
    '/:id/estimate/reopen',
    { ...canEstimate, schema: { params: idParams, body: reopenServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, 'diagnostics', ['in_work']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'diagnostics');
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: 'diagnostics',
          version: body.version,
          actor: p,
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
      assertSideAllowed(p, 'done', ['in_work']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.status, 'done');
      // Закрывают по согласованной ревизии: иначе правка прошла бы между открытием окна
      // согласования и нажатием кнопки, и работы закрылись бы не по той смете.
      if (row.approvedEstimateRevision !== row.estimateRevision) {
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
        // Шаг 5: сверка с согласованным — страховка инварианта, а не рабочая проверка: поднять
        // цену или объём при закрытии нечем (CHECK не даёт), и сработать она может только на
        // испорченных данных.
        const approved = num(row.estimatedTotalAmount);
        if (approved !== null && total > approved) {
          throw err.conflict(
            `Итог по акту (${money(total)}) больше согласованной сметы (${money(approved)})`,
          );
        }

        // Шаг 4: факт закрытия. Дата выполнения — календарные сутки, момент собирается по Москве:
        // от неё считаются гарантии, и часовой пояс сдвигал бы их на день.
        await applyTransition(tx, {
          row,
          to: 'done',
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: {
            completedAt: moscowInstantOf(body.completedOn, '00:00'),
            finalTotalAmount: money(total),
            finalAdjustmentAmount: adjustment === null ? null : money(adjustment),
            finalAdjustmentReason: adjustment === null ? '' : body.adjustmentReason,
          },
        });
        return { total, works };
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
   * Принимают работу с закрывающим документом — актом, счётом **или** гарантийным талоном (Р112,
   * отменяет Р16). Комплекта планка не требует: любой из трёх подтверждает, что работа состоялась,
   * а перечисление недостающих читалось бы как «нужны все три».
   *
   * Проверка стоит внутри транзакции и **после блокировки строки заявки**, а не по DTO,
   * прочитанному до неё: между чтением и `COMMIT` документ успевают снять. Снятие ходит той же
   * блокировкой (`DELETE /:id/files/:fileId`), поэтому два запроса выстраиваются в очередь — либо
   * документ снимут до приёмки, и откажет она, либо приёмка пройдёт первой, и откажет снятие.
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
          throw err.unprocessable('Нужен один из документов: акт, счёт или гарантийный талон', {
            files: 'Нет закрывающего документа',
          });
        }
        await applyTransition(tx, {
          // Переход считается по строке, перечитанной под блокировкой: расхождение с прочитанной
          // до транзакции упрётся в сверку версии и вернёт 409, а не молча пройдёт по старой.
          row: locked,
          to: 'accepted',
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: { acceptedBy: p.id, acceptedAt: new Date() },
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
      if (link.kind === 'estimate' && status !== 'diagnostics' && !manageAny) {
        throw err.unprocessable('Предъявленная смета не снимается — верните заявку в диагностику', {
          kind: 'Смета предъявлена',
        });
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
          await assertNoOpenRequest(tx, row.officeEquipmentId, row.id);
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
