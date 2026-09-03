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
  approveServiceEstimateSchema,
  attachServiceFilesSchema,
  can,
  canApproveServiceEstimate,
  canAssignServiceExecutors,
  canAttachServiceFile,
  canDeclineServiceRequest,
  canHoldService,
  canReopenServiceEstimate,
  canResumeService,
  canSubmitServiceEstimate,
  canTransitionServiceStatus,
  completeServiceRequestSchema,
  createServiceRequestSchema,
  declineServiceRequestSchema,
  formatServiceRequestNumber,
  hasModuleWideScope,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isServiceExecutor,
  isServiceFileKindVisible,
  isServiceRequestClosed,
  isWarrantyActive,
  isWaitingOn,
  moscowInstantOf,
  officeEquipmentTitle,
  parseServiceRequestNumberSearch,
  projectServiceRequestForAudience,
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
  canStartServiceWork,
  serviceEstimatePending,
  serviceFileKindLabels,
  serviceHasExecutors,
  serviceHoldSchema,
  serviceIsFirstAssignment,
  serviceMailRepeatable,
  serviceRequestAudienceOf,
  serviceRequestListQuerySchema,
  serviceRequestNeedsClosingDocument,
  serviceRequestStatusLabels,
  serviceRequestWaitingOn,
  serviceChatPageQuerySchema,
  markServiceChatReadSchema,
  sendServiceChatMessageSchema,
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
  type ServiceExecutorsRow,
  type ServiceFileKind,
  type ServiceRequestAudience,
  type ServiceRequestConsumableDto,
  type ServiceRequestKind,
  type ServiceWaitingOn,
  type ServiceWarrantyRowDto,
  type ServiceRequestChatSummaryDto,
  type ServiceRequestDto,
  type ServiceRequestExecutorDto,
  type ServiceRequestFileDto,
  type ServiceRequestItemDto,
  type ServiceRequestRequesterPlaceDto,
  type ServiceRequestStatus,
  type ServiceWaitingRequest,
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
  prepareServiceMail,
  queueServiceMailForIntent,
  readServiceSide,
  repeatableServiceMailEventOf,
  serviceMailEventOf,
  type ServiceMailPreparation,
  type ServiceMailResult,
  type ServiceRequestSide,
} from '../services/service-request-mail';
import { requirePrincipal } from '../auth/plugin';
import { loadPrincipal, type Principal } from '../auth/principal';
import {
  archiveWhere,
  assertArchiveVisible,
  assertCan,
  assertServiceRequestDeletable,
  assertServiceRequestEditable,
  assertServiceRequestScope,
  assertServiceRequestVisible,
  officeEquipmentScopeWhere,
  serviceRequestNamedExecutorWhere,
  serviceRequestVisibilityWhere,
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
import {
  chatSummaryByRequest,
  chatUnreadCount,
  importServiceCommentMessage,
  markAllChatRead,
  markChatRead,
  postChatMessage,
  readChatPage,
} from '../services/service-request-chat';

/**
 * Заявки на обслуживание оргтехники (ADR 0085).
 *
 * Цикл длиннее, чем у вывоза мусора и заказа техники: между «приняли» и «сделали» стоит смета,
 * которую согласует заказчик, а после работ — приёмка. Ведут заявку три стороны — заказчик,
 * оператор оргтехники (надстройка роли, ADR 0086) и внешняя сервисная компания, — и у каждой свой
 * коридор переходов (контракты, `allowedServiceStatusTransitions`).
 *
 * Порядок проверок в каждой изменяющей ручке один и тот же:
 * право (`requirePermission`) → область (`assertServiceRequestVisible` — все три оси разом) →
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

/**
 * Отказ по файлу — ОДНИМ текстом на два разных случая: связи с заявкой нет вовсе и связь есть, но
 * вид документа читателю не виден (ADR 0160, решение 6). Константой, а не двумя строками по месту:
 * разойдись они хоть словом, по ответу читалось бы наличие счёта — то самое, что закрыто в
 * карточке, только добытое перебором идентификаторов.
 */
const FILE_NOT_LINKED = 'Файл не прикреплён к этой заявке';

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
 * ВСЕ СОЕДИНЕНИЯ, КРОМЕ АВТОРА, — ЛЕВЫЕ, И ПРЕДМЕТ ЗАЯВКИ В ТОМ ЧИСЛЕ (Р8, ADR 0146, решение 7).
 *
 * Аппарат, его тип и площадка соединялись `innerJoin` — «они есть всегда». Правило это перестаёт
 * быть верным: заявку разрешают заводить без аппарата, а у заявки «от отдела» пуста и площадка —
 * снимок места брать неоткуда. Внутреннее соединение отвечает на такую строку не ошибкой, а
 * МОЛЧАНИЕМ: заявка пропадает из списка, из счётчика, из карточки, из отбора «отметить все
 * прочитанными» — и пропадает бесследно, потому что ни один ответ при этом не ломается и никто
 * ничего не замечает.
 *
 * ПОЧЕМУ ЛЕВОЕ СОЕДИНЕНИЕ ПРИХОДИТ РАНЬШЕ САМИХ ТАКИХ ЗАЯВОК — и это половина смысла выпуска.
 * Заводить их сегодня нечем: права нет, форма не спрашивает, ни одной строки без аппарата в базе
 * не существует. Значит на боевых данных `leftJoin` возвращает РОВНО ТО ЖЕ, что возвращал
 * `innerJoin`: аппарат есть у всякой заявки, внешний ключ `RESTRICT` гарантирует совпадение, и ни
 * одна строка не приходит пустой — ответы ручек до и после правки совпадают значение в значение.
 * Выпуск не включает ничего; он делает безопасным следующий. Обратный порядок означал бы, что
 * первую заявку без предмета встречает сервер, который её теряет, — а узнают об этом не по ошибке
 * в журнале, а по звонку «моя заявка пропала».
 *
 * Автор при этом остаётся `innerJoin`, и это не недосмотр: `created_by` — `NOT NULL` с `RESTRICT`,
 * и заявки без автора не бывает ни сейчас, ни после выпуска 2б. Пустеет предмет, а не человек.
 *
 * Отделы, исполнитель и снимки решений необязательны и были левыми всегда — там `leftJoin`
 * означает ровно «этого ещё не произошло», а не потерянную ссылку.
 *
 * Реквизиты предмета берутся из **заявки**, а не из справочника: единицу переносят и
 * переименовывают, а заявка обязана остаться рассказом о том, что чинили тогда (ADR 0085 §7).
 * Из справочника приходит только название типа и — единственным исключением — текущий объект
 * карточки: по нему считается расхождение (Р16), а расхождение и есть вопрос «снимок ещё
 * расходится с тем, где аппарат стоит сейчас».
 */
function requestQuery() {
  return db
    .select({
      r: serviceRequests,
      typeName: officeEquipmentTypes.name,
      /**
       * Где единица числится **сейчас**. Не снимок и не реквизит карточки заявки: живое значение
       * справочника, нужное ровно затем, чтобы погасить пометку расхождения, когда технику
       * перенесут (Р16). Соединением, а не колонкой, — иначе гасить её пришлось бы вторым
       * действием и человеком, который обязан не забыть.
       */
      equipmentCardObjectId: officeEquipment.objectId,
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
    .leftJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
    .leftJoin(officeEquipmentTypes, eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id))
    .leftJoin(constructionObjects, eq(serviceRequests.equipmentObjectId, constructionObjects.id))
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
async function executorsByRequest(
  ids: string[],
): Promise<Map<string, ServiceRequestExecutorDto[]>> {
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
 * Строка, по которой считается очередь (`serviceRequestWaitingOn`). Три поля вместо статуса, но уже
 * не те, что были: снятые статусы (Р1) означали состав исполнителей и непогашенное предъявление, и
 * ровно этими двумя признаками очередь теперь и различает оба рабочих статуса (Р2). Ось визы ИТ
 * ушла вместе с самой визой (Р10) — `hasCurrentItApproval` этой строке больше не годится и здесь не
 * зовётся.
 *
 * Состав исполнителей приходит **посчитанным**: в самой строке заявки лежит только контрагент, а
 * поимённые исполнители живут своей таблицей и выбираются рядом с остальными блоками карточки
 * (`executorsByRequest`). Тот же приём, что у `ServiceExecutorAssignment`: чего в строке нет,
 * предикат принимает готовым.
 */
function waitingRowOf(r: RequestRow, executorCount: number): ServiceWaitingRequest {
  return {
    status: r.status,
    hasExecutors: serviceHasExecutors({
      serviceCounterpartyId: r.serviceCounterpartyId,
      executorCount,
    }),
    estimatePendingRevision: r.estimatePendingRevision,
  };
}

/**
 * Состав исполнителей заявки строкой (Р2) — пара «контрагент + число поимённых строк», которую
 * ждут `serviceHasExecutors` и `serviceIsFirstAssignment`.
 *
 * Своим запросом, а не соединением: поимённых исполнителей у заявки несколько, и `leftJoin` в
 * заголовке размножил бы строки. Зовут её ручки, которым состав нужен ради решения, а не ради
 * показа, — правка заявки (Р14) и назначение (Р5); карточка тот же состав уже везёт списком.
 */
async function executorsRowOf(row: RequestRow): Promise<ServiceExecutorsRow> {
  const [counted] = await db
    .select({ c: count() })
    .from(serviceRequestExecutors)
    .where(eq(serviceRequestExecutors.requestId, row.id));
  return {
    serviceCounterpartyId: row.serviceCounterpartyId,
    executorCount: Number(counted!.c),
  };
}

function toDto(
  row: HeaderRow,
  items: ServiceRequestItemDto[],
  fileList: ServiceRequestFileDto[],
  executors: ServiceRequestExecutorDto[],
  consumables: ServiceRequestConsumableDto[],
  chat: ServiceRequestChatSummaryDto,
  audience: ServiceRequestAudience,
): ServiceRequestDto {
  const r = row.r;
  return {
    /**
     * В каком объёме собран этот ответ (ADR 0160, решение 4). Поле отвечает не про заявку, а про
     * читателя — как и посчитанные сервером стороны разговора рядом: без него `estimatedTotalAmount:
     * null` читается двусмысленно, и портал нарисовал бы честный прочерк там, где рисовать не надо
     * ничего.
     *
     * Значение стоит здесь ДО проекции и не зависит от неё: сборка отдаёт полное DTO, а карта полей
     * подменяет `audience` на `'requester'` только вместе с самими деньгами — то есть ровно тогда,
     * когда ответ и правда урезан.
     */
    audience,
    id: r.id,
    num: r.num,
    displayNumber: formatServiceRequestNumber(r.num),
    kind: r.kind,
    status: r.status,
    statusChangedAt: r.statusChangedAt.toISOString(),
    /**
     * Кого ждут — считает сервер: правило одно на список, карточку и бейдж раздела (Р35).
     *
     * По **строке**, а не по статусу (Р2): «Новая» отвечает составом исполнителей — нет никого,
     * ждут распределения; есть, ждут, что за неё возьмутся, — а «В работе» отвечает непогашенным
     * предъявлением: висит, ждут подписи под объёмом работ; не висит, ждут самих работ.
     */
    waitingOn: serviceRequestWaitingOn(waitingRowOf(r, executors.length)),
    // Заморозка ходит парой (Р104, Р107): при `on_hold` оба поля непусты, в остальных статусах
    // пусты оба — этого требует CHECK в базе. По `heldFromStatus` считается и «эффективный»
    // статус: виды документов отложенной «Диагностики» — те же, что у неё (Р110).
    heldFromStatus: r.heldFromStatus,
    holdReason: r.holdReason,
    /**
     * Предмет заявки. `null` — заявка заведена без аппарата (Р8); на боевых данных этой ветки
     * сегодня не берёт ни одна строка — заводить такие заявки нечем, — и в том её смысл: сервер
     * учится читать раньше, чем появляется что читать.
     *
     * Спрашивается САМА ЗАЯВКА (`office_equipment_id`), а не соединение: предмет заявки — её
     * собственный снимок, а справочник добавляет к нему одно лишь название типа. Вывод «не пришёл
     * тип — значит аппарата нет» был бы вторым ответом на тот же вопрос, и разошёлся бы с первым на
     * первой же испорченной карточке.
     *
     * Название типа поэтому `?? ''`, а не `!`: соединение с типом стоит ЗА соединением с карточкой,
     * и утверждать «здесь точно не пусто» значило бы положиться на два внешних ключа разом.
     * Испорченная карточка — не повод потерять заявку; остальные реквизиты снимка (`equipment_name`
     * и соседи) — колонки самой заявки, `NOT NULL`, и пустеют они пустой СТРОКОЙ, а не `NULL`:
     * у заявки без аппарата в них записано «ничего», и читаются они без оговорок.
     */
    equipment:
      r.officeEquipmentId === null
        ? null
        : {
            id: r.officeEquipmentId,
            name: r.equipmentName,
            serialNumber: r.equipmentSerialNumber,
            inventoryNumber: r.equipmentInventoryNumber,
            typeName: row.typeName ?? '',
            location: r.equipmentLocation,
          },
    /**
     * Площадка предмета. Пустеет вместе с аппаратом: у заявки «от отдела» снимка места нет вовсе
     * (Р8). Признак — СОЕДИНЕНИЕ, а не колонка заявки, и это не то же самое, что у аппарата выше:
     * все три поля объекта приходят из справочника площадок одной строкой, и спрашивать её наличие
     * у другого источника значило бы допустить ответ «объект есть, а названия у него нет».
     */
    object:
      row.objectId === null
        ? null
        : { id: row.objectId, code: row.objectCode!, name: row.objectName! },
    /**
     * «Не тот объект» (Р16): объект заявки назвал человек, а не подставила карточка техники. Факт
     * заявления, и только он — историчный, как остальные снимки заявки.
     */
    objectOverridden: r.objectOverridden,
    /**
     * Расхождение **не устранено**: заявили и до сих пор не перенесли. Конъюнкция хранимой пометки
     * и живого сравнения со справочником — порознь оба признака отвечают неверно. Хранимый сам не
     * гаснет ничем: ИТ-служба перенесёт единицу, а флаг у заявки останется `true` навсегда, и
     * отбор через месяц станет списком всего, что когда-либо поправляли. Вычисляемого мало:
     * технику возят, и у прошлогодних заявок снимок расходится с карточкой сплошь и рядом, хотя
     * никто ничего не заявлял.
     *
     * Сравнивается **снимок заявки**, а не объект из соединения с площадкой: `equipmentObjectId` и
     * есть то, что заявка помнит о месте аппарата, и второй путь к тому же значению разошёлся бы с
     * первым на первой же правке соединений.
     *
     * У закрытой заявки признак остаётся честным — «расхождение было и не устранено»: DTO
     * рассказывает о заявке, а не о том, стоит ли она в чьей-то очереди. Из очереди ИТ-службы
     * закрытые убирает отбор списка, где к этой паре добавлено третье условие.
     */
    // У заявки без аппарата расхождения не бывает по определению: сравнивать снимок не с чем, и
    // карточки, которую «надо перенести», не существует. Условие названо первым явно, а не оставлено
    // на волю сравнения двух `NULL`: `NULL !== NULL` в JavaScript даёт `false` случайно, а не по
    // смыслу, и первая же правка сравнения превратила бы случайность в дефект.
    objectMismatch:
      r.officeEquipmentId !== null &&
      r.objectOverridden &&
      row.equipmentCardObjectId !== r.equipmentObjectId,
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
    /**
     * Непогашенное предъявление (Р2) — то, что означала «Смета на согласовании». Полем DTO, а не
     * выводом портала из даты: по нему портал считает доступность четырёх действий (согласовать,
     * вернуть в правку, предъявить заново, переназначить), и посчитанный им по-своему ответ
     * разошёлся бы с сервером молча.
     */
    estimatePendingRevision: r.estimatePendingRevision,
    // Когда предъявляли в последний раз. Активным предъявлением НЕ является (Р9): возврат в правку
    // эту дату не трогает, и у отозванного она непуста.
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
    /**
     * Решение при отказе по объёму работ (Р12): что делаем вместо ремонта. Показывается само по
     * себе, рядом с пометкой замены, а не «под причиной»: причины отмены в DTO нет вовсе — она
     * уходит комментарием перехода и живёт на вкладке истории, где её и читают.
     */
    rejectionResolution: r.rejectionResolution,
    comment: r.comment,
    serviceComment: r.serviceComment,
    // Обсуждение (ADR 0141): счёт и мои стороны считает сервер — портал правил сторон не
    // воспроизводит вовсе (§3.2). Блок есть у каждой заявки, в том числе у той, где не сказано ещё
    // ни слова: «переписки нет» — это `total: 0`, а не отсутствующее поле.
    chat,
    files: fileList,
    createdByName: row.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    version: r.version,
  };
}

/**
 * Заявки страницы со всем, что к ним подшито, — ПОЛНЫМИ, каким бы ни был читатель. Наружу они не
 * уходят: чем это отличается от `loadDtos` и почему умолчание именно такое — в комментарии к нему.
 *
 * Принципал нужен двум блокам. Обсуждению (ADR 0141): «моё непрочитанное» и «мои стороны» —
 * свойства пары «человек ↔ заявка», а не самой заявки, и посчитать их без читателя нельзя. И
 * аудитории (ADR 0160): «в каком объёме собран ответ» — свойство той же пары. Остальные блоки от
 * читателя не зависят и не должны: состав сметы и вложений у всех один.
 *
 * Сводка чата считается ПОСЛЕ исполнителей, а не рядом с ними: поимённое назначение — один из
 * четырёх фактов разговора (`chatFactsFor`), и второй запрос за теми же строками означал бы два
 * ответа на вопрос «кто назначен» в одном ответе API.
 */
async function loadFullDtos(p: Principal, rows: HeaderRow[]): Promise<ServiceRequestDto[]> {
  const ids = rows.map((row) => row.r.id);
  const [items, fileMap, executorMap, consumableMap] = await Promise.all([
    itemsByRequest(ids),
    filesByRequest(ids),
    executorsByRequest(ids),
    consumablesByRequest(ids),
  ]);
  const chatMap = await chatSummaryByRequest(
    p,
    rows.map((row) => ({
      row: row.r,
      executorIds: (executorMap.get(row.r.id) ?? []).map((e) => e.userId),
    })),
  );
  return rows.map((row) => {
    const executors = executorMap.get(row.r.id) ?? [];
    /**
     * Аудитория считается ПО СТРОКЕ (ADR 0160, решение 1), и признаки назначения собираются из
     * того, что уже загружено: контрагент стоит в самой заявке, а поимённые исполнители пришли
     * общей выборкой страницы. Второго похода в базу здесь быть не должно — список отдаёт до
     * полусотни строк за запрос, и вопрос «назначен ли я» на каждой из них стоил бы столько же
     * запросов.
     *
     * Правило то же, что у `executorAssignment` (одиночная строка): назначенный контрагент —
     * совпадение с контрагентом субъекта, поимённый исполнитель — его строка в составе. Право
     * `serviceRequests.execute` здесь не спрашивается намеренно: его спросит `isServiceExecutor`
     * внутри, а вторая такая проверка была бы вторым ответом на тот же вопрос. Там она стоит ради
     * лишнего запроса, которого здесь нет.
     */
    const audience = serviceRequestAudienceOf(p, {
      actsForAssignedCounterparty:
        row.r.serviceCounterpartyId !== null && row.r.serviceCounterpartyId === p.counterpartyId,
      isNamedExecutor: executors.some((e) => e.userId === p.id),
    });
    return toDto(
      row,
      items.get(row.r.id) ?? [],
      fileMap.get(row.r.id) ?? [],
      executors,
      consumableMap.get(row.r.id) ?? [],
      chatMap.get(row.r.id)!,
      audience,
    );
  });
}

/**
 * Ответ в объёме аудитории. Аудиторию не пересчитывает, а читает из самого DTO: она посчитана по
 * строке при сборке, и второй расчёт по субъекту разошёлся бы с первым на назначенной заявке —
 * ровно там, где цена расхождения выше всего.
 */
function forAudience(dto: ServiceRequestDto): ServiceRequestDto {
  return projectServiceRequestForAudience(dto, dto.audience);
}

/**
 * ПОЛНОЕ DTO — ВНУТРЬ, ПРОЕЦИРОВАННОЕ — НАРУЖУ (ADR 0160, решение 3).
 *
 * Функций две, и умолчание выбрано так, чтобы забывчивость стоила дешевле. `loadDtos`/`getDto` —
 * те имена, которыми зовут сборку все ручки и с которых спишет следующая, — отдают ответ УЖЕ
 * урезанным: новая ручка проецирует, ничего не зная про аудиторию и не вспоминая о ней. Забытая
 * проекция была бы утечкой счёта заявителю, и заметить её нечем — ответ выглядит правильным.
 *
 * Полное значение спрашивается ОТДЕЛЬНЫМ именем (`loadFullDtos`/`getFullDto`), и зовут его только
 * там, где DTO не уходит в ответ, а служит сырьём: `diffServiceRequests` и соседи считают историю
 * ПО DTO, и урезанное DTO заявителя записало бы в журнал, что заявитель ничего не менял. Снимок в
 * `metadata` единственный — восстановить потерянное «Ведением» уже нечем, и это была бы порча
 * данных, а не сокрытие.
 *
 * Отсюда же правило для ручек, которым нужно и то и другое (правка, срочность, состав, закрытие):
 * `before`/`after` берутся полными, а в ответ уходит `forAudience(after)` — одной строкой рядом с
 * `return`, а не «где-нибудь выше», чтобы читалось вместе с ответом.
 */
async function loadDtos(p: Principal, rows: HeaderRow[]): Promise<ServiceRequestDto[]> {
  return (await loadFullDtos(p, rows)).map(forAudience);
}

async function getFullDto(p: Principal, id: string): Promise<ServiceRequestDto | null> {
  const [row] = await requestQuery().where(eq(serviceRequests.id, id));
  if (!row) return null;
  const [dto] = await loadFullDtos(p, [row]);
  return dto ?? null;
}

async function getDto(p: Principal, id: string): Promise<ServiceRequestDto | null> {
  const dto = await getFullDto(p, id);
  return dto === null ? null : forAudience(dto);
}

// ── Область и коридор ──

/**
 * Субъект значится поимённым исполнителем этой заявки — третья ось видимости (Р1) и половина
 * признака `isNamedExecutor` в `executorAssignment` ниже: один вопрос, один запрос, одно место.
 *
 * Право спрашивается ПЕРЕД базой, и это не экономия: строка назначения переживает отзыв набора
 * (по ней написана переписка и подписаны бумаги, стирать её нельзя), поэтому «назначен» без
 * действующего `serviceRequests.execute` не значит ничего — ни для видимости, ни для хода (И1).
 *
 * Исполнителем передаётся `tx` там, где вопрос задан внутри транзакции: спросить его через общий
 * пул значило бы занять второе соединение, не отпустив первое, — на исчерпанном пуле это взаимная
 * блокировка, а не лишний запрос.
 */
async function isNamedExecutorHere(
  p: Principal,
  requestId: string,
  exec: typeof db | Tx = db,
): Promise<boolean> {
  if (!can(p, 'serviceRequests.execute')) return false;
  const [named] = await exec
    .select({ userId: serviceRequestExecutors.userId })
    .from(serviceRequestExecutors)
    .where(
      and(
        eq(serviceRequestExecutors.requestId, requestId),
        eq(serviceRequestExecutors.userId, p.id),
      ),
    )
    .limit(1);
  return !!named;
}

/**
 * Все три оси области сразу — заказчик заявки (объект и отделы), назначенный подрядчик и поимённое
 * назначение. Тонкая обёртка над общим предикатом (`assertServiceRequestVisible`, Р2): своё правило
 * здесь разъехалось бы со списком, и карточка отдавала бы то, чего список не показывает.
 *
 * Имя оставлено прежним намеренно: им подписана область в карте ручек §2.2 плана, его ищет инвентарь
 * доступа (`scripts/service-access-inventory.ts`) и статический разбор манифеста, и переименование
 * стоило бы правки трёх сторожей ради ничего.
 *
 * Стала асинхронной вместе с третьей осью: назначение — строка в базе, а не поле принципала. Поход
 * туда стоит только носителю `serviceRequests.execute` (см. `isNamedExecutorHere`), то есть ни
 * заказчику, ни наблюдателю, ни оператору подрядчика.
 */
async function assertScope(
  p: Principal,
  row: RequestRow,
  exec: typeof db | Tx = db,
): Promise<void> {
  await assertServiceRequestVisible(
    p,
    {
      objectId: row.equipmentObjectId,
      customerDepartmentId: row.customerDepartmentId,
      equipmentDepartmentId: row.equipmentDepartmentId,
      serviceCounterpartyId: row.serviceCounterpartyId,
    },
    () => isNamedExecutorHere(p, row.id, exec),
  );
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
  await assertScope(p, row);
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
  // Поимённая строка — тем же запросом и тем же условием, что у третьей оси видимости: сторона и
  // область обязаны отвечать про назначение одинаково, иначе человек видел бы заявку, в которой ему
  // нечего делать, — или наоборот.
  return {
    actsForAssignedCounterparty,
    isNamedExecutor: await isNamedExecutorHere(p, row.id),
  };
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
 * чужую отсекла область (`assertScope` внутри `requireEditable`).
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
 * чужую заявку отсекла область (`assertScope` внутри `requireEditable`).
 */
async function assertConsumableIssuer(p: Principal, row: RequestRow): Promise<void> {
  if (isServiceExecutor(p, await executorAssignment(p, row))) return;
  if (can(p, 'serviceRequests.status')) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(
    `${who} не отмечает выдачу по этой заявке — это шаг назначенного исполнителя`,
  );
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
  throw err.unprocessable(`Заявка на расходники объёма работ не имеет: ${action} нечего`, {
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
    `По гарантии этого объёма работ обратились: ${nums.join(', ')} — менять его состав нельзя`,
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
  /**
   * Аппарат заявки; `null` — заявка без аппарата (Р8). Спор о гарантии ведут о КОНКРЕТНОЙ единице:
   * либо о её гарантии поставщика, либо о работе, выполненной на ней же, — и обе проверки ниже
   * начинаются со сравнения «та ли это техника». Без аппарата сравнивать не с чем.
   */
  equipment: { id: string; warrantyUntil: string | null } | null,
  currentRequestId: string | null,
): Promise<WarrantyClaimColumns> {
  if (!claim?.source) return { source: null, itemId: null };
  // Дверь, закрытая раньше, чем в неё постучали (Р7): заявку без аппарата ещё нечем завести, но
  // отказ здесь уже стоит — иначе первая же такая заявка получила бы обращение по гарантии
  // неизвестно чего, и разбирали бы это в споре с сервисом, а не в портале.
  if (!equipment) {
    throw err.unprocessable(
      'Обращаются по гарантии конкретного аппарата, а у этой заявки аппарата нет',
      { warrantyClaim: 'Заявка без аппарата' },
    );
  }
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
     * Подготовка письма, сделанная **до** транзакции (Р67): из внешней среды читаются только
     * почтовые настройки процесса, и упавшие внутри они откатили бы саму заявку. Адресатов она не
     * несёт — их читает транзакция после блокировки (§5.2). `null` — переход письма не шлёт.
     *
     * Параметр ОБЯЗАТЕЛЬНЫЙ, и это единственный способ не потерять новую дугу: пока промолчать было
     * можно, шесть переходов модуля не ставили писем вовсе — молча, без единого предупреждения.
     */
    mail: ServiceMailPreparation | null;
  },
): Promise<{
  mail: ServiceMailResult | null;
  mailFailed: boolean;
  clearedWarranties: ClearedWarranty[];
}> {
  const { row, to, actor } = params;
  /**
   * Сторона заявки снимается ДО бизнес-изменения: отмена сбрасывает исполнителя тем же переходом
   * (`serviceResetOnTransition`, флаг `executor`), и строка, перечитанная после него, о подрядчике
   * уже не помнит — письмо «выезд не требуется» ушло бы одной службе, то есть тому, кто отмену и
   * сделал.
   */
  const side = await readServiceSide(tx, row.id);
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
    // Непогашенное предъявление гасится вместе со сметой, и не только ради очереди (Р2): ревизия
    // уходит в `0`, а оставленная pending-ревизия уронила бы саму запись —
    // `service_requests_estimate_pending_check` требует их равенства.
    set.estimatePendingRevision = null;
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
  if (reset.rejection) {
    /**
     * Обе пометки отказа разом (Р12). Они живут и умирают вместе: и «рекомендована замена», и
     * решение, принятое вместо ремонта, объясняют, почему заявку закрыли без ремонта, — и обе
     * относятся к отмене, которой после возврата в «Новую» больше нет. Сними мы одну, откат упёрся
     * бы в `service_requests_replacement_check` либо в
     * `service_requests_rejection_resolution_check` ошибкой БД.
     */
    set.replacementRecommended = false;
    set.rejectionResolution = '';
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

  const { mail } = await recordServiceStatusTransition(tx, {
    requestId: row.id,
    side,
    // Переназначение — тот же статус: в истории оно и должно читаться как «Назначен сервис» →
    // «Назначен сервис», иначе строка «сменили исполнителя» пропадёт вовсе.
    fromStatus: row.status,
    toStatus: to,
    estimateRevision: (patch.estimateRevision as number | undefined) ?? row.estimateRevision,
    actorId: actor.id,
    comment: params.comment ?? '',
    mail: params.mail,
  });
  return { mail, mailFailed: mail?.outcome === 'mail_failed', clearedWarranties: warrantySnapshot };
}

/**
 * Подготовка письма перехода: какое событие ставит вход в этот статус и что о нём известно до
 * транзакции (§5.2). `null` — у перехода письма нет, и ручка обязана сказать это словом, а не
 * умолчанием: обязательный параметр `mail` у `applyTransition` для того и заведён.
 */
async function prepareTransitionMail(
  status: ServiceRequestStatus,
  actor: Principal,
  authorId: string | null,
): Promise<ServiceMailPreparation | null> {
  const event = serviceMailEventOf(status);
  if (!event) return null;
  return prepareServiceMail({ event, actor: mailActorOf(actor), authorId });
}

/** Актор события для почты: его источник вычёркивается из обычных адресатов (§5.4). */
function mailActorOf(p: Principal): { id: string; email: string; counterpartyId: string | null } {
  return { id: p.id, email: p.email, counterpartyId: p.counterpartyId };
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
    /**
     * Подготовка письма, сделанная до транзакции; `null` — письма у этого перехода нет.
     * Адресатов она НЕ несёт: их читает сама транзакция после блокировки заявки (§5.2).
     */
    mail: ServiceMailPreparation | null;
    /** Сторона заявки, снятая ДО бизнес-изменения: отмена сбрасывает исполнителя тем же переходом. */
    side: ServiceRequestSide;
  },
): Promise<{ statusHistoryId: string; mail: ServiceMailResult | null }> {
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

  if (!params.mail) return { statusHistoryId: entry!.id, mail: null };

  /**
   * Письмо ставится тем же `tx`, что и строка истории: рубильник, адресаты, их права и копии
   * читаются после блокировки заявки, а не заранее (§5.2). Якорь ключа дедупликации — строка
   * истории: по заявке он был бы неверен дважды — повторный цикл «отменили → вернули» не дал бы
   * второго письма, а второй адресат не получил бы ничего.
   */
  const mail = await queueServiceMailForIntent(tx, {
    prepared: params.mail,
    side: params.side,
    requestId: params.requestId,
    anchor: entry!.id,
    extra: { fromStatus: params.fromStatus, comment: params.comment },
  });
  return { statusHistoryId: entry!.id, mail };
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
 * В каких статусах вид документа принимают — таблица УЕХАЛА В КОНТРАКТЫ
 * (`SERVICE_FILE_KIND_POLICY`, ADR 0160): там же, где записано, кому вид виден и кто его кладёт.
 * Три вопроса об одном виде документа стояли в трёх местах — здесь, в проекции карточки и в форме
 * подшивки портала, — и расходились они молча: форма предлагала вид, на котором приходил отказ, а
 * подшитый счёт исчезал из карточки того, кто его положил.
 *
 * Здесь остаются только КОДЫ ОТВЕТА, потому что вопросы разные: неподходящий статус — ошибка
 * формы, которую человек исправляет выбором (422), а запрет по аудитории — отсутствие права (403).
 */

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

/**
 * Кладёт ли аудитория такой вид документа ХОТЬ КОГДА-НИБУДЬ. Вопрос права, и статуса он не знает
 * намеренно: заявителю, приложившему счёт, «неподходящий статус» пообещал бы, что в другом статусе
 * получится, — а не получится никогда.
 *
 * Перебором статусов, а не своим перечнем: единственная таблица видов живёт в контрактах, и второй
 * список «что кому можно» рядом с ней разошёлся бы с ней на первом же новом виде документа.
 */
function kindAttachableByAudience(
  kind: ServiceFileKind,
  audience: ServiceRequestAudience,
): boolean {
  return SERVICE_REQUEST_STATUSES.some((status) => canAttachServiceFile(kind, status, audience));
}

/**
 * Статус здесь — «эффективный» (Р110): заморозка видов документов не меняет.
 *
 * Порядок проверок значим. Сперва аудитория (403): «этот вид не ваш» — окончательный ответ, и
 * добавлять к нему разбор статуса значило бы рассказывать заявителю про жизнь документа, которого
 * он не увидит. Затем прежние два 422 — они про форму, их читает тот, кому вид разрешён, и
 * действующие тесты проверяют оба текста.
 */
function assertFileKindAllowed(
  status: ServiceRequestStatus,
  kind: ServiceFileKind,
  audience: ServiceRequestAudience,
): void {
  if (!kindAttachableByAudience(kind, audience)) {
    throw err.forbidden(
      `«${serviceFileKindLabels[kind]}» к заявке прикладывает исполнитель, а не заявитель`,
    );
  }
  if (isServiceRequestClosed(status) && !SERVICE_CLOSING_DOCUMENT_KINDS.includes(kind)) {
    const closing = SERVICE_CLOSING_DOCUMENT_KINDS.map((k) => serviceFileKindLabels[k]).join(', ');
    throw err.unprocessable(
      `Закрытая заявка принимает только документы: ${closing.toLowerCase()}`,
      { kind: 'Заявка закрыта' },
    );
  }
  if (!canAttachServiceFile(kind, status, audience)) {
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
        'Объём работ ведёт исполнитель',
      ),
    ],
  };
  /**
   * Согласование объёма работ (Р3). Страж «одно из перечисленных», как у сметы и отказа, и по той
   * же причине: согласуют двое — «Ведение» правом `serviceRequests.approveEstimate` и назначенный
   * поимённо сотрудник, у которого есть только `serviceRequests.execute` (ответ В2). Записанное
   * одним правом, условие отобрало бы ручку у второго, а «я в списке назначенных» — свойство
   * заявки, и стражу оно не видно.
   *
   * Что субъекту доступно **на этой заявке**, решает предикат `canApproveServiceEstimate` в теле
   * ручки: держатель `execute` без строки в заявке получает отказ от него, а не отсюда, — а
   * оператор подрядчика исключается им же, чтобы не подписывать собственный счёт.
   */
  const canApproveEstimate = {
    preHandler: [
      app.authenticate,
      app.requireAnyPermission(
        ['serviceRequests.approveEstimate', 'serviceRequests.execute'],
        'Объём работ согласует тот, кто ведёт заявку',
      ),
    ],
  };
  /**
   * Состав номенклатуры расходников (Р15). Пара прав — **`serviceRequests.estimate` +
   * `serviceRequests.execute`**, та же, что у ручек объёма работ, и выбрана она не по смыслу слова
   * «смета», а потому что это и есть «сторона исполнителя» в матрице: у сервисной компании набор —
   * `read`, `estimate`, `status`, `files`, и ни `update`, ни `execute` в нём нет. Возьми мы
   * напрашивающуюся пару `update` + `execute`, назначенный подрядчик не смог бы заполнить
   * номенклатуру вовсе — то есть исполнитель, ради которого правка и делается, остался бы без
   * ручки.
   *
   * Своим стражем, а не общим с `canEstimate`: права те же, а отказ разный — «Смету ведёт
   * исполнитель» у заявки на расходники читалось бы как ошибка сервера.
   */
  const canConsumables = {
    preHandler: [
      app.authenticate,
      app.requireAnyPermission(
        ['serviceRequests.estimate', 'serviceRequests.execute'],
        'Состав заполняет исполнитель',
      ),
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

  /**
   * Видимость списка — общим предикатом целиком (Р2, Р1): заказчик ∨ назначенный подрядчик ∨
   * поимённое назначение. Имя оставлено ради сторожей (инвентарь Э0 и статический разбор манифеста
   * ищут `visibility(`), а содержимое уехало в `lib/access.ts` — там же, где его спрашивают
   * карточка, файловый страж и журнал расходников.
   */
  function visibility(p: Principal): SQL | undefined {
    return serviceRequestVisibilityWhere(p);
  }

  /**
   * У заявки есть исполнители — то же, что `serviceHasExecutors` (Р2), переведённое на SQL:
   * очередь отбирается выборкой, а предикат контрактов считает по строке. Дизъюнкция, а не «строки
   * есть»: у сервисной компании поимённых строк не бывает вовсе, и заявка, отданная подрядчику,
   * числилась бы вечно нераспределённой.
   *
   * Корреляция стоит в `WHERE`, а не в списке столбцов, — там подмена квалификации drizzle не
   * достаёт (`office-equipment-sql-correlation.test.ts`).
   */
  /*
   * ФУНКЦИЯМИ, А НЕ КОНСТАНТАМИ, и это не стиль. `db.select(...)` строит запрос **в момент вызова**,
   * и вычисленное на уровне регистрации плагина оно выполняется при каждой загрузке маршрутов —
   * то есть у всякого, кто поднимает приложение с подменённым клиентом БД. Первая редакция держала
   * здесь константы, и `readings-export.test.ts` падал на разборе `{ x: 1 }`: его двойник ловит
   * запросы по списку столбцов и о чужом подзапросе не знает. Прод от этого не страдал (строится
   * builder, а не выполняется запрос), но побочный эффект на регистрации — сам по себе не то, чего
   * ждут от описания условия.
   */
  const hasExecutorsHere = () =>
    or(
      isNotNull(serviceRequests.serviceCounterpartyId),
      exists(
        db
          .select({ x: sql`1` })
          .from(serviceRequestExecutors)
          .where(eq(serviceRequestExecutors.requestId, serviceRequests.id)),
      ),
    )!;
  /** Заявка ничья: ни контрагента, ни поимённых строк — то, что «Новая» означала до слияния. */
  const notAssigned = () => not(hasExecutorsHere());

  /** Непогашенное предъявление объёма работ — `serviceEstimatePending` (Р2) на SQL. */
  const pendingHere = () => isNotNull(serviceRequests.estimatePendingRevision);
  const noPendingHere = () => isNull(serviceRequests.estimatePendingRevision);

  /**
   * Четыре сочетания двух булевых осей, по которым очередь различает состояния внутри одного
   * статуса (Р2): состав исполнителей и непогашенное предъявление. Ось визы ИТ ушла отсюда вместе с
   * самой визой (Р10).
   *
   * Каждое сочетание несёт свои половины условия готовыми — и прямую, и отрицание. Порождённые
   * циклом по двум флагам, они прятали бы отрицание в тернарник, а перепутанное отрицание в очереди
   * не падает: оно тихо показывает чужие заявки.
   */
  const WAITING_AXES = [
    { hasExecutors: false, estimatePendingRevision: null, where: [notAssigned, noPendingHere] },
    { hasExecutors: false, estimatePendingRevision: 1, where: [notAssigned, pendingHere] },
    { hasExecutors: true, estimatePendingRevision: null, where: [hasExecutorsHere, noPendingHere] },
    { hasExecutors: true, estimatePendingRevision: 1, where: [hasExecutorsHere, pendingHere] },
  ] as const;

  /**
   * Условие «в этом состоянии ждут такую-то сторону». Статусы не перечисляются руками, а
   * **выводятся** из `serviceRequestWaitingOn`: та же функция, что отвечает в карточке,
   * опрашивается по каждому статусу на всех четырёх сочетаниях двух признаков, и статусы
   * раскладываются по получившимся маскам. Переписать её на ручной перечень нельзя ни при каком
   * упрощении: ровно эта выведенность и держит согласие карточки со списком — разойдись они, бейдж
   * вёл бы в очередь, где заявки нет.
   *
   * Маска — четыре бита, по одному на сочетание. Прежде кучек было три и назывались они словами
   * («ждут всегда», «ждут с визой», «ждут без визы»); осей стало две, и словарь пришлось бы завести
   * на девять случаев — поэтому кучки считаются, а не перечисляются.
   */
  function waitingSideWhere(side: ServiceWaitingOn): SQL | undefined {
    const byMask = new Map<number, ServiceRequestStatus[]>();
    for (const status of SERVICE_REQUEST_STATUSES) {
      let mask = 0;
      WAITING_AXES.forEach((axis, bit) => {
        if (serviceRequestWaitingOn({ status, ...axis }) === side) mask |= 1 << bit;
      });
      if (mask === 0) continue;
      byMask.set(mask, [...(byMask.get(mask) ?? []), status]);
    }
    const parts = [...byMask].map(([mask, statuses]) =>
      and(inArray(serviceRequests.status, statuses), axesWhere(mask)),
    );
    return parts.length > 0 ? or(...parts) : undefined;
  }

  /**
   * Условие по признакам для одной маски. Оси, от которых ответ не зависит, из условия **уходят**:
   * маска «ждут при любом предъявлении, но только с исполнителями» — это `hasExecutors`, а не
   * дизъюнкция двух сочетаний, и записанная дизъюнкцией она читалась бы как правило, которого нет.
   *
   * `undefined` — ответ не зависит ни от одной оси: статус отвечает сам (приёмка, заморозка,
   * закрытые), и лишнее условие в SQL только мешало бы читать план запроса.
   */
  function axesWhere(mask: number): SQL | undefined {
    const bits = WAITING_AXES.map((_, bit) => (mask & (1 << bit)) !== 0);
    // Ось «свободна», если ответ одинаков при обоих её значениях, — тогда её половина условия и не
    // нужна. Соседи по оси исполнителей отстоят на два бита, по оси предъявления — на один.
    const freeExecutors = bits[0] === bits[2] && bits[1] === bits[3];
    const freePending = bits[0] === bits[1] && bits[2] === bits[3];
    if (freeExecutors && freePending) return undefined;
    const halves = WAITING_AXES.map((axis, bit) =>
      bits[bit]
        ? and(
            ...[
              freeExecutors ? undefined : axis.where[0](),
              freePending ? undefined : axis.where[1](),
            ],
          )
        : undefined,
    ).filter((part): part is SQL => part !== undefined);
    // Одинаковые половины после выброшенных осей повторяются — берётся любая: они тождественны.
    return freeExecutors || freePending ? halves[0] : or(...halves);
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
    /*
     * Поимённый исполнитель добирается соединением — и сторон у него теперь ДВЕ (Р3). К прежней
     * «ждут исполнителя» добавилось «ждут согласования»: по ответу В2 объём работ согласует
     * назначенный сотрудник, а `isWaitingOn` его не видит и видеть не может — «я в списке
     * назначенных» это свойство заявки, а не субъекта.
     *
     * Оставь мы здесь одну сторону `service`, согласующий не увидел бы свою же заявку в «Ждут
     * меня» вовсе: в очередь она попадает ровно этой веткой, а сторона у неё — `approval`.
     */
    if (can(p, 'serviceRequests.execute')) {
      for (const side of ['service', 'approval'] as const) {
        const where = waitingSideWhere(side);
        const named = where ? and(where, serviceRequestNamedExecutorWhere(p)) : undefined;
        if (named) parts.push(named);
      }
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : or(...parts)!;
  }

  /**
   * Условие отбора списка — своей функцией, потому что читателей у него теперь двое: сам список и
   * кнопка «Отметить все прочитанными» (ADR 0141, §3.4). Кнопка обязана гасить РОВНО то, что человек
   * видит на экране; собери она свой отбор — однажды съела бы заявку, которой в списке не было, и
   * заметили бы это только по пропавшему разговору.
   */
  function listWhere(
    p: Principal,
    q: z.infer<typeof serviceRequestListQuerySchema>,
  ): SQL | undefined {
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
      /**
       * Очередь расхождений по объекту (Р16) — конъюнкция трёх условий, и каждое обязательно.
       *
       * **Заявлено** (`object_overridden`): без него в очередь попало бы всё, у чего снимок
       * разошёлся с карточкой сам собой, — а таких большинство, технику возят. **Не устранено**
       * (снимок ≠ карточка): без него пометка не гасилась бы ничем, и через месяц отбор перестал бы
       * быть очередью, став списком всего, что когда-либо поправляли. **Заявка открыта**: без него
       * ИТ-служба разбирала бы прошлогодние закрытые заявки, у которых расхождение законно —
       * аппарат с тех пор переехал, и переносить в справочнике нечего.
       *
       * Соединением с карточкой, а не колонкой: перенос единицы гасит очередь сам, без второго
       * действия и без человека, который обязан не забыть. Соединение здесь уже есть — его держит
       * отбор по типу оргтехники, и оба читателя `listWhere` его ставят.
       */
      q.objectMismatch
        ? and(
            eq(serviceRequests.objectOverridden, true),
            ne(serviceRequests.equipmentObjectId, officeEquipment.objectId),
            notInArray(serviceRequests.status, ['accepted', 'cancelled']),
          )
        : undefined,
      /**
       * Очередь «Ожидаются документы» — инструмент того, кто заявку ведёт, и заявителю она МОЛЧА
       * ИГНОРИРУЕТСЯ (ADR 0160, решение 9), как игнорируется запрос архива без права. Не 422:
       * отличие ответов «отказ» и «пустая выдача» само по себе оракул — по нему перебором читается,
       * подшит ли по заявке счёт, то есть ровно то, что закрыто в карточке.
       *
       * Право спрашивается СУБЪЕКТНОЕ, а не аудитория строки: у назначенного внутреннего
       * исполнителя отдельные строки выдачи законно финансовые, но глобальный фильтр по ним стал бы
       * оракулом по СОСЕДНИМ — неназначенным строкам его базовой области.
       */
      q.awaitingDocuments && can(p, 'serviceRequests.finance')
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
    return where;
  }

  // ── Список ──
  r.get('/', { ...auth, schema: { querystring: serviceRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const where = listWhere(p, q);

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
        // Соединение с карточкой держит отбор по типу оргтехники и очередь расхождений — колонки
        // эти живут в справочнике. ЛЕВОЕ, как и в самой выборке страницы (Р8): останься оно
        // внутренним, счётчик считал бы одно, а страница показывала бы другое — «показано 20 из
        // 19». Расходиться этим двум запросам нельзя ни на строку.
        .leftJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
        .where(where),
    ]);
    return {
      items: await loadDtos(p, rows),
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
          /*
           * Карточка техники, её тип и площадка — ЛЕВЫМИ соединениями, по той же причине, что и в
           * базовой выборке заявки (Р8, ADR 0146, решение 7). Носитель строки здесь — ВЫПОЛНЕННАЯ
           * ПОЗИЦИЯ РЕМОНТА, а не аппарат: гарантия на работу существует и у заявки без аппарата
           * («поставили розетку», «заменили блок питания, привезённого своим»), и при внутреннем
           * соединении такая строка исчезла бы из реестра молча — то есть человек, пришедший
           * спорить с сервисом по гарантии, увидел бы, что гарантии нет.
           *
           * Отбор по типу оргтехники (`q.equipmentTypeId`) ниже соединение не превращает обратно во
           * внутреннее: спросив тип, человек и просит только те строки, у которых аппарат есть.
           */
          .leftJoin(officeEquipment, eq(serviceRequests.officeEquipmentId, officeEquipment.id))
          .leftJoin(
            officeEquipmentTypes,
            eq(officeEquipment.equipmentTypeId, officeEquipmentTypes.id),
          )
          .leftJoin(
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
            ? // Наименование остаётся строкой и у ремонта по заявке без аппарата — там оно пустое
              // (снимок заявки, `NOT NULL`). Такие строки собираются в начале списка и из
              // сортировки не выпадают: сравнивать пустую строку можно, порядок от неё не рушится.
              a.equipmentName.localeCompare(b.equipmentName)
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

  // ── Обсуждение заявки: счётчик и «отметить все прочитанными» (ADR 0141) ──
  /**
   * Сколько заявок области несут непрочитанное, адресованное МНЕ, — число для бейджа раздела.
   *
   * Бейдж этот ОТДЕЛЬНЫЙ от золотого «ждёт меня»: сумма двух не отвечает ни на один из двух
   * вопросов — «где меня ждут» и «где мне написали» — и вела бы в список, отобранный не тем
   * фильтром. Считается только яркое (адресованное мне); чужая переписка живёт блёклой точкой в
   * строке и в бейдж не идёт — иначе у «Ведения», видящего все заявки модуля, он горел бы всегда.
   *
   * Область — та же `visibility`, что у списка и у `waiting-count`, по той же причине.
   *
   * Путь статический и стоит **до** `/:id`: параметр перехватил бы его первым.
   */
  r.get('/unread-count', auth, async (req) => {
    const p = requirePrincipal(req);
    return { count: await chatUnreadCount(p, visibility(p)) };
  });

  /**
   * «Отметить все прочитанными» по заявкам ТЕКУЩЕГО ОТБОРА.
   *
   * Ручка заведена под редкий, но неустранимый случай (§3.4): человеку сегодня выдали набор
   * «Ведение», стороны считаются динамически — и открытые заявки загорелись у него разом. Отсечка по
   * дате заведения учётки этот случай не ловит: учётка старая, новые у неё права.
   *
   * Отбор приходит теми же параметрами, что и список, и разбирается той же схемой: кнопка обязана
   * гасить ровно то, что человек видит. `POST`, а не `PATCH`: тело — это фильтр, а не изменяемая
   * запись, и адреса записи у этой ручки нет вовсе.
   *
   * Путь статический и стоит **до** `/:id` — иначе параметр прочитал бы `messages` как
   * идентификатор заявки.
   */
  r.post(
    '/messages/read-all',
    { ...auth, schema: { body: serviceRequestListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      return { count: await markAllChatRead(p, listWhere(p, req.body)) };
    },
  );

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
    await assertScope(p, row);
    return (await getDto(p, row.id))!;
  });

  // ── История: статусы и аудит (ADR 0012) ──
  // Отдельного права нет: это те же события, что в карточке, только по времени, — и границы у неё
  // те же, что у самой заявки. Объём — тоже: аудитория считается по той же строке, что и в карточке
  // (ADR 0160, решение 8), иначе цена ремонта читалась бы из ленты у заявки, где её не показывают.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const row = await loadRow(req.params.id);
    assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
    await assertScope(p, row);
    const [author] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, row.createdBy));
    return loadServiceRequestHistory(
      row.id,
      {
        at: row.createdAt,
        actorId: row.createdBy,
        actorName: author?.fullName ?? '',
      },
      serviceRequestAudienceOf(p, await executorAssignment(p, row)),
    );
  });

  // ── Обсуждение заявки (ADR 0141) ──
  /**
   * Страница ленты. Право то же, что у карточки: текст реплик видят ВСЕ, кому видна заявка, —
   * адресат управляет подсветкой, а не видимостью (решение 2 ADR). Границы те же, что у самой
   * заявки: архив — 404, чужая область — 403.
   *
   * Страничная и курсорная (§3.6): первая редакция плана возвращала всю ленту и в `GET`, и в `POST`,
   * и повторяла это каждые двадцать секунд — стоимость росла как «реплики × открытые клиенты».
   */
  r.get(
    '/:id/messages',
    { ...auth, schema: { params: idParams, querystring: serviceChatPageQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const row = await loadRow(req.params.id);
      assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
      await assertScope(p, row);
      return readChatPage(p, row.id, req.query);
    },
  );

  /**
   * Отправка реплики.
   *
   * Страж — чтение модуля: новых прав переписка не заводит вовсе (решение 4 ADR). Отдельное «право
   * переписки» пришлось бы выдавать руками рядом с правом видеть заявку, и первая же забытая выдача
   * дала бы участника цикла, который заявку ведёт, но написать по ней не может, — причём без
   * единого следа в интерфейсе. Кто перед ручкой на ЭТОЙ заявке, решает `canWriteChat` внутри
   * транзакции, под блокировкой: назначение и статус к моменту отправки успевают измениться.
   *
   * Ответ — ТОЛЬКО созданная реплика и новый `lastSeq`, а не вся лента: отправка стоит одной
   * строки, и возвращать полсотни ради одной значило бы удваивать трафик на каждое сообщение.
   */
  r.post(
    '/:id/messages',
    { ...auth, schema: { params: idParams, body: sendServiceChatMessageSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const row = await loadRow(req.params.id);
      assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
      await assertScope(p, row);
      return postChatMessage(p, row.id, req.body);
    },
  );

  /**
   * Подтверждение прочтения. Зовётся ПОСЛЕ успешного показа ленты, а не при открытии окна: отметка,
   * поставленная на открытии, гасила бы разговор и тогда, когда загрузка упала и человек не увидел
   * ничего (§3.4).
   *
   * Право то же, что у чтения ленты: курсор — свойство читателя, и двигать его вправе каждый, кому
   * заявка видна, включая наблюдателя, который писать не может.
   */
  r.post(
    '/:id/messages/read',
    { ...auth, schema: { params: idParams, body: markServiceChatReadSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const row = await loadRow(req.params.id);
      assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
      await assertScope(p, row);
      return markChatRead(p, row.id, req.body.throughSeq);
    },
  );

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

      // Предмет заявки и её заказчик — одним разбором (Р5, Р6, Р7): у заявки с аппаратом они
      // считаются от карточки единицы, у заявки без аппарата — от оси роли заводящего.
      const { equipment, equipmentObjectId, customerDepartmentId } = await resolveRequestSubject(
        p,
        body,
      );

      /**
       * Адресаты и обратные адреса считаются **до** транзакции (Р67): здесь ходят в базу и в
       * конфигурацию, и отказ по данным внутри транзакции откатил бы саму заявку. Мягкий исход
       * («почта выключена», «канал не настроен») возвращается ответом — заявка заводится в любом
       * случае.
       *
       * Автор будущей заявки — сам заводящий: ответ службы на письмо уйдёт ему.
       */
      const mailPlan = await prepareTransitionMail('new', p, p.id);

      /**
       * Вид заявки (Н1). «Поля нет» читается как «ремонт» — ровно так, как читает его старый код в
       * окне выката, и так же стоит умолчанием колонки (`0177`). Строки номенклатуры и вид схема
       * сверила между собой (`createServiceRequestSchema`): у расходников строки обязательны, у
       * ремонта их не бывает.
       */
      const kind: ServiceRequestKind = body.kind ?? 'repair';
      const consumables = body.consumables ?? [];

      const created = await db.transaction(async (tx) => {
        // Замок «одна открытая заявка вида на аппарат» (Р21) без аппарата не зовётся, и это не
        // послабление, а буквальное прочтение правила: запирается ЕДИНИЦА, а её здесь нет. Тем же
        // читаются и частичные уникальные индексы под ним — в B-tree `NULL` не равен `NULL`, и
        // открытых заявок без аппарата бывает сколько угодно (миграция 0230).
        if (equipment) await assertNoOpenRequest(tx, equipment.id, kind);
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
            officeEquipmentId: equipment?.id ?? null,
            /**
             * Объект заявки — снимок, как и остальные реквизиты предмета, и при поднятой пометке
             * его называет человек (Р16, ответ В3). Справочник заявка при этом НЕ правит: перенос
             * единицы — решение ИТ-службы после проверки, а карточку заводит всякий заявитель, и
             * опечатка в заявке возила бы аппараты по объектам.
             *
             * У заявки без аппарата в этой же колонке лежит ЗАКАЗЧИК-ПЛОЩАДКА (Р6) либо `NULL`,
             * если заказчик — отдел: колонка одна, потому что областью роли площадки заведует
             * именно она.
             */
            equipmentObjectId,
            objectOverridden: body.objectOverridden,
            customerDepartmentId,
            /**
             * Отдел-владелец единицы — третий снимок области (ADR 0085 §8). У заявки без аппарата
             * он пуст ВСЕГДА, и не «потому что неоткуда взять»: владельца у несуществующей единицы
             * нет вовсе, а подставь мы сюда отдел-заказчик, роль отдела видела бы заявку дважды по
             * двум разным основаниям — и первая же правка заказчика оставила бы её видимой по
             * второму.
             */
            equipmentDepartmentId: equipment?.ownerDepartmentId ?? null,
            /*
             * Снимок предмета у заявки без аппарата ПУСТЫМИ СТРОКАМИ, а не «Без аппарата» словами
             * (§5 плана): колонки эти — копия справочника, и подпись для человека в них означала
             * бы, что поиск по названию техники находит заявку, у которой техники нет. Как её
             * называть на экране, решает портал по `equipment: null` (`SERVICE_REQUEST_NO_EQUIPMENT`).
             */
            equipmentName: equipment?.name ?? '',
            equipmentSerialNumber: equipment?.serialNumber ?? '',
            equipmentInventoryNumber: equipment?.inventoryNumber ?? '',
            // Место — часть того же снимка: сервис поедет по нему, а карточка к тому времени
            // могла переехать (Р57).
            equipmentLocation: equipment?.location ?? '',
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
          mail: mailPlan,
          // Заявки до этой транзакции не существовало: стороны у неё нет по построению.
          side: { serviceCounterpartyId: null, executorUserIds: [] },
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
        return { ...request, mail: transition.mail, requester };
      });

      const dto = (await getFullDto(p, created.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.create',
        entityType: 'serviceRequest',
        entityId: created.id,
        metadata: {
          num: created.num,
          kind,
          title: serviceRequestTitle(dto),
          // Объект заявки, а не карточки: при поднятой пометке они расходятся, и журнал обязан
          // помнить, куда заявку в итоге записали (Р16).
          objectId: equipmentObjectId,
          objectOverridden: body.objectOverridden,
          customerDepartmentId,
          warrantyClaim: dto.warrantyClaim?.source ?? null,
          isUrgent: dto.isUrgent,
          requesterDepartmentId: created.requester.departmentId,
          requesterObjectId: created.requester.objectId,
        },
      });
      // Неудача сборки письма пишется в аудит только теперь: `writeAudit` ходит мимо транзакции, и
      // запись, сделанная внутри, пережила бы её откат (Р67).
      if (created.mail?.outcome === 'mail_failed') {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: created.id,
          metadata: { event: 'service_request_waiting_it' },
        });
      }
      reply.code(201);
      // Наружу — в объёме аудитории: полное `dto` собрано ради заголовка в журнале.
      return { request: forAudience(dto), mail: created.mail?.outcome ?? 'not_needed' };
    },
  );

  // ── Предмет и заказчик заводимой заявки (Р5, Р6, Р7) ──

  /** Карточка единицы на момент заведения: из неё снимаются снимки предмета и обе оси области. */
  interface EquipmentSnapshot {
    id: string;
    name: string;
    serialNumber: string;
    inventoryNumber: string;
    objectId: string;
    ownerDepartmentId: string | null;
    location: string;
    warrantyUntil: string | null;
  }

  /** Что заявка получит в трёх колонках области: предмет, площадка и отдел-заказчик. */
  interface RequestSubject {
    /** `null` — заявка без аппарата: снимки предмета пустые, отдел-владелец пуст всегда. */
    equipment: EquipmentSnapshot | null;
    equipmentObjectId: string | null;
    customerDepartmentId: string | null;
  }

  /**
   * Предмет заявки и её заказчик — одним разбором, потому что это один вопрос («чья заявка»), у
   * которого два разных источника ответа.
   *
   * С АППАРАТОМ ответ приходит из справочника: площадка — из карточки единицы, отдел-владелец —
   * оттуда же, отдел-заказчик подсказывается ими и уточняется человеком. Порядок шагов прежний и
   * не переставлен: сперва область по карточке, потом пометка «не тот объект» внутри неё.
   *
   * БЕЗ АППАРАТА справочника нет, и ответ даёт **сам заводящий** — выбором заказчика по оси своей
   * роли (Р6). Отсюда и страж права здесь же: «аппарат не прислали» — это не пропущенное поле, а
   * другой способ завести заявку, и разрешение на него отдельное.
   */
  async function resolveRequestSubject(
    p: Principal,
    body: {
      officeEquipmentId?: string | null;
      objectId?: string;
      objectOverridden: boolean;
      customerDepartmentId?: string | null;
    },
  ): Promise<RequestSubject> {
    if (body.officeEquipmentId == null) {
      /**
       * 403, А НЕ 422 (Р5). Право `serviceRequests.createWithoutEquipment` спрашивается ЗДЕСЬ, а
       * не схемой и не стражем маршрута:
       *
       *   * схемой нельзя — она одна на все учётки и прав не видит вовсе, а «заполните аппарат» в
       *     ответ рядовому заявителю означало бы «вы ошиблись полем» там, где человек не ошибся
       *     ничем: ему просто не положено;
       *   * стражем маршрута нельзя — дверь у ручки одна на оба способа заведения, и требование
       *     права на ней отобрало бы у всей компании обычную заявку с аппаратом.
       */
      if (!can(p, 'serviceRequests.createWithoutEquipment')) {
        throw err.forbidden(
          'Заявку без аппарата заводит тот, кому это разрешено отдельно — выберите аппарат из справочника',
        );
      }
      const customer = await resolveEmptySubjectCustomer(p, body);
      // Второй рубеж под тем же правилом: разбор выше выбирает заказчика по оси роли, а эта
      // проверка спрашивает у общего источника области, попала ли заявка к самому автору. Разойдись
      // они однажды — человек отправил бы заявку и не увидел её в списке.
      assertServiceRequestScope(p, {
        objectId: customer.equipmentObjectId,
        customerDepartmentId: customer.customerDepartmentId,
        equipmentDepartmentId: null,
      });
      return { equipment: null, ...customer };
    }

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
    // Где аппарат стоит на самом деле (Р16). Спрашивается ПОСЛЕ области по карточке: заявку
    // заводят на технику своей области, а чекбокс лишь поправляет объект внутри неё.
    const equipmentObjectId = await resolveEquipmentObject(p, body, equipment);
    return { equipment, equipmentObjectId, customerDepartmentId };
  }

  /**
   * Заказчик заявки БЕЗ АППАРАТА — по ОСИ РОЛИ заводящего (Р6, ADR 0146, решение 6).
   *
   * **Это не удобство поля, а условие работоспособности заявки.** У заявки с аппаратом площадка
   * приходит из карточки единицы, и роль площадки, выбравшая заказчиком чужой отдел, всё равно
   * остаётся в своей области — заявку она видит по объекту. Без аппарата такой опоры нет: три
   * колонки области заполняет сам человек, и выбор поперёк своей оси создаёт заявку **вне
   * собственной области автора** — он потеряет её сразу после отправки, а искать её будет некому,
   * потому что и остальные роли этой оси её не увидят.
   *
   * Поэтому:
   *
   *   | роль площадки | только свой объект     | `equipment_object_id`     |
   *   | роль отдела   | только свой отдел      | `customer_department_id`  |
   *   | ИТ-служба     | и то и другое          | соответственно            |
   *
   * ИТ-служба здесь — не исключение из правила, а то же правило: сквозная область модуля (Р54)
   * означает, что её ось — вся компания, и заявку она не теряет ни при каком выборе. Тем же
   * читаются роли без осей вовсе (администратор): предикат области им ничего не сужает.
   *
   * 422 с именем поля, а не 403: право заводить заявку без аппарата у человека есть — не годится
   * присланное значение. Тот же код и та же форма ответа, что у чужого объекта в пометке «не тот
   * объект» и у чужого подразделения заявителя.
   */
  async function resolveEmptySubjectCustomer(
    p: Principal,
    body: { objectId?: string; customerDepartmentId?: string | null },
  ): Promise<{ equipmentObjectId: string | null; customerDepartmentId: string | null }> {
    // Источник тот же, что у `serviceRequestScopeWhere` и `assertServiceRequestScope`, и спрошен он
    // в том же порядке: сквозная область снимает ось целиком, и только под ней спрашивается роль.
    const wide = hasModuleWideScope(p.grantCodes, 'serviceRequests');
    const objectAxis = !wide && isObjectScopedRole(p.role);
    const departmentAxis = !wide && isDepartmentScopedRole(p.role);
    const who = p.role ? roleLabels[p.role] : 'Учётная запись';

    if (body.objectId) {
      if (departmentAxis) {
        throw err.unprocessable(
          `${who} заводит заявку без аппарата от своего отдела: заявку от площадки она сама потом не увидит`,
          { objectId: 'Заявка заводится от отдела' },
        );
      }
      if (objectAxis && !p.constructionObjectIds.includes(body.objectId)) {
        throw err.unprocessable(
          'Заявку можно завести только от своего объекта — заявку от чужого не увидит и сам заявитель',
          { objectId: 'Чужой объект' },
        );
      }
      // Существование, а не активность: закрывающаяся площадка ещё работает, и заявки с неё
      // приходят до последнего дня. Тот же разбор, что у пометки «не тот объект» рядом.
      const [object] = await db
        .select({ id: constructionObjects.id })
        .from(constructionObjects)
        .where(eq(constructionObjects.id, body.objectId));
      if (!object) throw err.unprocessable('Объект не найден', { objectId: 'Не найден' });
      return { equipmentObjectId: object.id, customerDepartmentId: null };
    }

    // Схема сверила: заказчик ровно один (Р7). Раз это не объект — значит отдел, и пустым он здесь
    // быть не может. Утверждение поэтому проверяется, а не подразумевается: разойдись схема с этим
    // разбором, заявка ушла бы в базу с нулём заказчиков и упёрлась бы в `CHECK` кодом 23514.
    const chosenDepartment = body.customerDepartmentId;
    if (!chosenDepartment) {
      throw err.unprocessable('Укажите, для кого заявка: объект или отдел', {
        objectId: 'Заказчик не указан',
      });
    }
    if (objectAxis) {
      throw err.unprocessable(
        `${who} заводит заявку без аппарата от своей площадки: заявку от отдела она сама потом не увидит`,
        { customerDepartmentId: 'Заявка заводится от площадки' },
      );
    }
    /*
     * Свой отдел проверяет общий разбор заказчика — тот же, что у заявки с аппаратом: чужой отдел
     * там отвечает 403, и заводить рядом второй ответ на тот же вопрос нельзя. Подсказок он здесь
     * не применяет ни одной — ветка «поле пришло со значением» до них не доходит, — и это верно:
     * подсказывать заказчика неоткуда, когда предмета нет.
     */
    return {
      equipmentObjectId: null,
      customerDepartmentId: await resolveCustomerDepartment(
        p,
        { customerDepartmentId: chosenDepartment },
        { ownerDepartmentId: null },
      ),
    };
  }

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

  /**
   * Где аппарат стоит на самом деле (Р16, ответ В3). Пометки нет — объект берётся из карточки
   * техники, как и прежде; пометка есть — из тела, и схема заведения уже сверила пару между собой
   * (объект без пометки ничего не объявляет, пометка без объекта не говорит, где аппарат).
   *
   * **Список ограничен областью заявителя, и это не удобство поля, а его единственное безопасное
   * устройство.** `equipment_object_id` задаёт область видимости роли объекта
   * (`serviceRequestScopeWhere`): свободный выбор означал бы, что заявку можно отправить в чужую
   * область — и увести из своей, оставив автора без собственной заявки. Портал показывает тот же
   * отбор по привязкам автора, но портал не защита.
   *
   * Ось у проверки одна — объектная, и берётся она у того же источника, что `assertServiceRequestScope`:
   * у роли отдела и у штаба область считается отделами либо не считается ничем, и объект её не
   * сужает — запрещать им выбор значило бы отобрать поле у тех, кто заводит заявки за сотрудников.
   * Сквозная область модуля (Р54) открывает выбор целиком: согласующий от ИТ решает по всему парку.
   *
   * 422, а не 403: право заводить заявку у человека есть, негодно присланное значение — ровно тот
   * же код, каким отвечает чужой отдел заявителя (`resolveRequesterPlace`).
   */
  async function resolveEquipmentObject(
    p: Principal,
    body: { objectId?: string; objectOverridden: boolean },
    equipment: { objectId: string },
  ): Promise<string> {
    if (!body.objectOverridden || !body.objectId) return equipment.objectId;
    const chosen = body.objectId;
    // Существование, а не активность: закрывающаяся площадка всё ещё может держать у себя аппарат,
    // и запрет выбирать её означал бы заявку, которую негде записать. Тот же разбор, что у
    // площадки заявителя рядом (`resolveRequesterPlace`).
    const [object] = await db
      .select({ id: constructionObjects.id })
      .from(constructionObjects)
      .where(eq(constructionObjects.id, chosen));
    if (!object) {
      throw err.unprocessable('Объект не найден', { objectId: 'Не найден' });
    }
    if (
      !hasModuleWideScope(p.grantCodes, 'serviceRequests') &&
      isObjectScopedRole(p.role) &&
      !p.constructionObjectIds.includes(chosen)
    ) {
      throw err.unprocessable(
        'Аппарат можно записать только на свой объект — на чужом заявку не увидит и сам заявитель',
        { objectId: 'Чужой объект' },
      );
    }
    return object.id;
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
      if (!row)
        throw err.unprocessable('Отдел заявителя не найден', {
          requesterDepartmentId: 'Не найден',
        });
      return { ...NO_REQUESTER_PLACE, departmentId: id, departmentName: row.name };
    };
    const object = async (id: string): Promise<RequesterPlace> => {
      const [row] = await tx
        .select({ name: constructionObjects.name })
        .from(constructionObjects)
        .where(eq(constructionObjects.id, id));
      if (!row)
        throw err.unprocessable('Площадка заявителя не найдена', {
          requesterObjectId: 'Не найдена',
        });
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
      /**
       * Со стороны заказчика правится «Новая», у которой ещё нет исполнителей (Р14): после
       * назначения за заявкой стоят договорённости с исполнителем, и менять её предмет задним
       * числом нельзя. Закрытую не правит никто — её предмет уже стал историей.
       *
       * Строкой, а не статусом: пока «Новая» означала «ещё не назначена», на этот вопрос отвечал
       * статус, а после слияния (Р1) он половину ответа потерял бы молча — правка открылась бы у
       * заявки, которую исполнитель уже прочитал.
       */
      assertServiceRequestEditable(
        p,
        { ...(await executorsRowOf(row)), status: row.status },
        'редактировать',
      );
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
      /**
       * СРОЧНОСТЬ — СВОЁ ПРАВО И ЗДЕСЬ, а не только у ручки `PATCH /:id/urgency` (план профилей
       * оргтехники, Р10; находка Н1): прежде пара приезжала вместе с `serviceRequests.update`, и
       * заявитель ставил себе «Срочная» правкой собственной «Новой». Дверь была вторая, а право
       * заводили затем, чтобы закрыть их обе.
       *
       * Спрашивается ПО ЭФФЕКТУ, а не по присутствию полей, — тот же приём, что у `customerChanged`
       * ниже (Р12б), и по той же причине, только острее: форма шлёт пару ВСЕГДА, потому что порознь
       * её не принимают ни схема, ни `CHECK` базы. Условие «поле прислали» закрыло бы правом
       * срочности всю форму заявителя — описание, телефон, заказчика, — а не красную метку.
       *
       * Склеенное состояние здесь то же, что уходит в патч: `PATCH` присылает половину пары, и
       * решение об очереди — это разница склейки со строкой, а не присланное значение само по себе.
       * Снятие срочности отсюда закрыто наравне с постановкой: снять — значит изменить флаг.
       *
       * До первой записи: отказ не должен зависеть от того, дошло ли дело до `UPDATE`.
       */
      const urgency = {
        isUrgent: body.isUrgent ?? row.isUrgent,
        urgencyReason: body.urgencyReason ?? row.urgencyReason,
      };
      const urgencyChanged =
        urgency.isUrgent !== row.isUrgent || urgency.urgencyReason !== row.urgencyReason;
      if (urgencyChanged) {
        assertCan(p, 'serviceRequests.urgency', 'Срочность ставит тот, кто ведёт заявки');
      }
      const before = (await getFullDto(p, row.id))!;

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
      /**
       * У ЗАЯВКИ БЕЗ АППАРАТА ЗАКАЗЧИК НЕ МЕНЯЕТ ОСЬ (Р6, Р7). Технику при правке не меняют вовсе —
       * это было верно и раньше, — а вот заказчик правится, и без этих двух отказов он утащил бы
       * заявку туда, где `service_requests_subject_check` её уже не пускает:
       *
       *   * заявка ОТ ПЛОЩАДКИ + присланный отдел = два заказчика сразу, и заявку считали бы своей
       *     обе роли;
       *   * заявка ОТ ОТДЕЛА + присланный `null` («заявка от площадки») = ноль заказчиков, и её не
       *     увидит никто.
       *
       * База обе строки отвергнет, но ответом `23514` — то есть 500 вместо фразы. Внутри своей оси
       * правка при этом остаётся: отдел на соседний отдел меняется, и чужой из них отбивает общий
       * разбор заказчика (403), как у заявки с аппаратом.
       *
       * Заявка с аппаратом сюда не попадает вовсе: у неё площадка заполнена всегда (первая ветвь
       * того же `CHECK`), и отдел-заказчик рядом с ней законен и обязателен не бывает.
       */
      if (customerChanged && row.officeEquipmentId === null) {
        if (row.equipmentObjectId !== null) {
          throw err.unprocessable(
            'Заявка без аппарата заведена от площадки — отдел-заказчик ей не назначается',
            { customerDepartmentId: 'Заявка от площадки' },
          );
        }
        if (body.customerDepartmentId === null) {
          throw err.unprocessable(
            'У заявки без аппарата заказчик обязателен: без него её не увидит никто, включая заявителя',
            { customerDepartmentId: 'Заказчик обязателен' },
          );
        }
      }
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
        if (urgencyChanged) {
          // Пара сверяется по склеенному состоянию (оно же считалось выше, для права): `PATCH`
          // присылает половину, и «поставили срочность, причину оставили прежней» — законная
          // правка, а «сняли срочность, забыли причину» — нет. Схема этого не видит, CHECK в базе
          // увидит и ответит ошибкой БД.
          //
          // Условие здесь то же, что у права, и это не оптимизация записи: пиши мы пару всякий раз,
          // когда её прислали, право спрашивалось бы по одному правилу, а колонки менялись бы по
          // другому — и «отказано, но записано» стало бы вопросом порядка строк.
          const issue = urgencyIssue(urgency);
          if (issue) throw err.unprocessable(issue, { urgencyReason: issue });
          patch.isUrgent = urgency.isUrgent;
          patch.urgencyReason = urgency.urgencyReason;
        }
        if (body.warrantyClaim !== undefined) {
          // Обращение по гарантии проверяется заново: за время правки срок мог кончиться, а
          // заявка-источник — уехать в архив.
          // У заявки без аппарата спрашивать справочник не о чем, и запрос не делается вовсе:
          // отказ (или снятие обращения) разбирает `resolveWarrantyClaim` по пустому аппарату.
          const [equipment] =
            row.officeEquipmentId === null
              ? []
              : await tx
                  .select({
                    id: officeEquipment.id,
                    warrantyUntil: officeEquipment.warrantyUntil,
                  })
                  .from(officeEquipment)
                  .where(eq(officeEquipment.id, row.officeEquipmentId));
          const claim = await resolveWarrantyClaim(
            tx,
            body.warrantyClaim,
            equipment ?? null,
            row.id,
          );
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

      const after = (await getFullDto(p, row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.update',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Перечень изменённых полей — то, ради чего история отличает правку от «заявку трогали».
        metadata: { changes: diffServiceRequests(before, after) },
      });
      // Наружу — в объёме аудитории: полное `after` собрано ради журнала, а не ради ответа.
      return forAudience(after);
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

      const before = (await getFullDto(p, row.id))!;
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

      const after = (await getFullDto(p, row.id))!;
      // Возраст в статусе срочность не сбрасывает: она не ожидание, и очередь «дольше всех ждут»
      // не должна обнуляться от того, что заявку пометили красным.
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.urgency',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { changes: diffServiceRequests(before, after), isUrgent: after.isUrgent },
      });
      // Наружу — в объёме аудитории: полное `after` собрано ради журнала, а не ради ответа.
      return forAudience(after);
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
   * **Назначение перестало быть переходом** (Р5). Статуса оно не меняет: «Назначена» снята
   * миграцией `0224`, и то, что она означала, называет теперь состав исполнителей
   * (`serviceHasExecutors`). Строка истории кладётся `from = to` — тем же приёмом, каким писалась
   * снятая виза ИТ, — иначе «исполнителей поменяли» осталось бы событием без следа.
   *
   * **Исключение одно: переназначение из «В работе» возвращает заявку в «Новую».** Иначе новый
   * исполнитель унаследовал бы чужое «взялся» и никогда не нажал бы «Принять в работу»: заявка
   * стояла бы в «В работе» у человека, который её ещё не открывал. Требовать от «Ведения» сперва
   * откатить статус, а потом назначить — два действия на одно намерение ровно в том модуле, из
   * которого мы убираем лишние нажатия.
   *
   * Возраст в текущем ожидании обнуляется всегда (`touchStatusAt`, Р4) — и на первом назначении, и
   * на переназначении: сторона у второго та же, а ждут после него другого, и унаследованный возраст
   * соврал бы о нём в очереди «кто тянет».
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
      const row = await requireEditable(p, req.params.id);
      /**
       * Доступность спрашивается предикатом, а не коридором (Р11): дуги у назначения больше нет, а
       * `assertSideAllowed` с `assertTransition` умеют отвечать только про дуги. Предикат отвечает
       * тем же составом условий — статус («Новая» либо «В работе»), право `serviceRequests.assign`
       * и отсутствие висящего предъявления, — и той же функцией отвечает портал, рисуя пункт меню.
       *
       * Запрет переназначения под висящим предъявлением — сегодняшнее правило, а не новое: из
       * «Сметы на согласовании» переназначить было нельзя, потому что цифры принадлежат прежнему
       * исполнителю и переданная заявка оставила бы новому чужой счёт. После слияния это же
       * состояние зовётся «В работе» + предъявление, и не войди условие в предикат — запрет тихо
       * исчез бы вместе со статусом.
       */
      // Состояние отвечает своим кодом, а право и статус — предикатом: коды отказов в модуле
      // разведены (403 — право, область и сторона; 422 — состояние записи), и один общий отказ от
      // предиката стёр бы это различие как раз там, где человеку надо не «просить прав», а дождаться
      // ответа по объёму работ.
      if (serviceEstimatePending(row)) {
        throw err.unprocessable(
          'Объём работ предъявлен и ждёт ответа — переназначить заявку можно, когда по нему решат',
          { status: 'Объём работ на согласовании' },
        );
      }
      if (!canAssignServiceExecutors(row, p)) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не назначает исполнителей заявке в статусе «${serviceRequestStatusLabels[row.status]}»`,
        );
      }

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
      /**
       * Первое ли это назначение — по СОСТАВУ, а не по статусу (Р11). Прежнее `row.status === 'new'`
       * было верно лишь потому, что статус с составом совпадал: назначение уводило заявку в
       * «Назначенную». Совпадать больше нечему, и признак становится тем, чем был по смыслу —
       * «исполнителей у заявки ещё не было». Той же функцией отвечает окно назначения, решая,
       * спрашивать ли причину: разойдись они, окно требовало бы причину там, где она не нужна, либо
       * отправляло запрос, на который придёт 422.
       */
      const first = serviceIsFirstAssignment({
        serviceCounterpartyId: row.serviceCounterpartyId,
        executorCount: current.length,
      });
      // Тот же состав у «Новой» — не назначение, а повтор нажатия. Из «В работе» тот же состав
      // означает возврат заявки к назначенным (ниже она уходит в «Новую»), и он законен.
      if (!changed && row.status === 'new') {
        throw err.unprocessable('Эти исполнители уже назначены на заявку');
      }
      // Первое назначение причины не требует, переназначение требует: у прежнего исполнителя
      // отбирают работу, и в истории обязано остаться, почему.
      if (!first && !body.reason) {
        throw err.unprocessable(
          'Укажите причину переназначения — у прежнего исполнителя отбирают работу',
          { reason: 'Укажите причину' },
        );
      }

      /**
       * Письмо о назначении (Н13) — задание на работу, и уходит оно новым исполнителям. Прежней
       * сервисной компании при смене или снятии назначения уходит отдельный отзыв: новое задание
       * другой компании само по себе не говорит старой, что выезд больше не требуется.
       *
       * Обратный адрес — ящик службы: внешний подрядчик отвечает тем, кто ведёт заявку, а не её
       * автору. Считается до транзакции (Р67): адресаты ходят в базу и в конфигурацию, и упавшие
       * внутри откатили бы саму заявку.
       */
      const mailPlan = await prepareServiceMail({
        event: 'service_request_assigned',
        actor: mailActorOf(p),
        authorId: row.createdBy,
        /**
         * Дельта назначения — единственное, чего транзакция сама не узнает: новую компанию она как
         * раз записывает, прежнюю после записи уже не достать, а поимённые адресаты — это
         * ДОБАВЛЕННЫЕ, а не весь состав (иначе «вам назначено» ушло бы тому, кто ведёт заявку
         * неделю).
         */
        assignment: {
          userIds: added,
          serviceCounterpartyId: counterpartyChanged ? counterpartyId : null,
          previousServiceCounterpartyId: counterpartyChanged ? row.serviceCounterpartyId : null,
        },
      });

      /**
       * Смета — документ того, кто её составлял, и держится она **только** пока заявка у него.
       * Стирается поэтому не на всякой правке состава, а когда заявка меняет руки: у прежнего
       * подрядчика её забрали либо сняли поимённого исполнителя. Добавление второго сисадмина к
       * первому чужого счёта не обесценивает и смету не трогает.
       */
      const handedOver =
        removed.length > 0 || (row.serviceCounterpartyId !== null && counterpartyChanged);

      /**
       * Куда уходит заявка. Назначение статуса не меняет — кроме переназначения из «В работе»:
       * оно возвращает её в «Новую», чтобы новый исполнитель нажал «Принять в работу» сам (Р5).
       * Исполнителей эта дуга НЕ снимает (`serviceResetOnTransition`): строки пишутся ниже, до
       * помощника перехода, и сброс, идущий следом, оставил бы заявку ничьей — молча, потому что
       * отложенный `service_requests_executor_present` для «Новой» возвращается сразу.
       */
      const to: ServiceRequestStatus = row.status === 'in_work' ? 'new' : row.status;

      const mailResult = await db.transaction(async (tx) => {
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
        // `!first` здесь больше не проверяется, и это не пропуск: у первого назначения нет ни
        // снятых строк, ни прежнего контрагента, — то есть `handedOver` при нём ложен по
        // построению, и вторая половина условия отвечала бы на вопрос, которого не бывает.
        if (handedOver) {
          await assertEstimateReplaceable(tx, locked.id);
          await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, locked.id));
          patch.estimateRevision = 0;
          patch.estimateSubmittedAt = null;
          patch.estimatedTotalAmount = null;
          // Ревизия уходит в `0`, и оставленное предъявление уронило бы саму запись
          // (`service_requests_estimate_pending_check` требует их равенства). До этой строки оно
          // тут и не окажется — переназначение под висящим предъявлением запрещено предикатом
          // выше, — но защита не должна держаться на выводе о соседней проверке (Р2).
          patch.estimatePendingRevision = null;
          patch.approvedEstimateRevision = null;
          patch.estimateApprovedBy = null;
          patch.estimateApprovedAt = null;
        }

        const transition = await applyTransition(tx, {
          row: locked,
          to,
          version: body.version,
          actor: p,
          comment: body.reason ?? body.comment,
          patch,
          // Возраст обнуляется и при `to === from`: сторона та же, а ждут другого (Р4).
          touchStatusAt: true,
          mail: mailPlan,
        });
        return transition.mail;
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
      if (mailResult?.outcome === 'mail_failed') {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: row.id,
          metadata: { event: 'service_request_assigned' },
        });
      }
      return {
        request: (await getDto(p, row.id))!,
        mail: mailResult?.outcome ?? 'not_needed',
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

  // ── Виза отдела ИТ упразднена (Р10) ──
  /**
   * Ручка `PATCH /:id/it-approval` снята вместе с самой визой: согласует объём работ назначенный
   * сотрудник, и вопрос «чинить или менять» задаёт себе тот же человек, что смотрит на счёт (ответ
   * В2). Двух подписей по порядку больше нет, `SERVICE_IT_TRANSITIONS` пуста, третья ось очереди
   * ушла вместе с ней.
   *
   * Поля `it_approved_*` при этом остались снимком истории — подпись от 22.08 правдива, и стирать
   * её нечем: карточка показывает её по-прежнему, а решающих мест у неё больше нет. Право
   * `serviceRequests.approveIt` тоже остаётся в матрице и перестаёт давать ходы: уборка выданных
   * наборов — отдельный откат, и делать её в одном выпуске с переделкой цикла значило бы смешать
   * два разных (§8).
   */

  // ── Отказ исполнителя (Н5, §4.2) ──
  /**
   * Отказ снимает **отказавшегося**, а не заявку с распределения, и слоя у него два, с разными
   * правилами — потому что назначаются они по-разному:
   *
   * - **свой сотрудник** снимает свою строку: остальные назначенные продолжают вести заявку;
   * - **оператор сервисной компании** снимает **всю компанию** — назначена была она, а не человек,
   *   поимённых строк у её сотрудников нет вовсе, и «часть подрядчика» отказаться не может.
   *
   * **Статуса отказ не меняет вовсе** (Р7). Прежде он ходил `assigned → new`, и статус сам
   * различал два исхода; после слияния (Р1) отказавшийся и так стоит в «Новой», а различает исходы
   * состав: ушёл последний — заявка ждёт распределения, кто-то остался — она по-прежнему ждёт
   * исполнителя. Строка истории пишется прежняя (`from = to` с причиной): без неё «исполнителей
   * стало меньше» ничем не объяснено, а спорят с подрядчиком именно по ней.
   *
   * **Исполнителя снимает сама ручка, а не матрица сброса.** Дуги, на которой стоял `reset.executor`,
   * больше нет, и на `in_work → new` сброс не ставится намеренно (Р5, п. 2) — иначе он ломал бы
   * переназначение и откат «принял в работу». Значит контрагента снимает здешний `patch`, а строки
   * — здешний `DELETE`: понадеявшись на матрицу, мы оставили бы отказавшуюся компанию в заявке
   * молча.
   *
   * **Возраст ожидания сбрасывается условно** (Р4): при полном отказе сторона меняется
   * (`service → operator`) и возраст обнуляется, при частичном — нет. Обнули мы его и там, уход
   * одного из троих сисадминов прятал бы заявку из очереди «кто тянет» на неделю, хотя те, кто
   * остался, ждут её ровно столько же, сколько ждали.
   *
   * Отказ **взявшегося** (из «В работе») ручка не открывает (Р7): сегодня его нет, и заводить его
   * заодно значило бы расширение, о котором не просили, — такую заявку возвращает переназначение
   * либо откат «Ведения».
   */
  r.patch(
    '/:id/decline',
    { ...canExecutorStatus, schema: { params: idParams, body: declineServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      const assignment = await executorAssignment(p, row);
      // Дуги у отказа больше нет — доступность спрашивает предикат Р11 (той же функцией отвечает
      // пункт меню в портале). Сторона считается по строке заявки, а не по правам: отказывается
      // назначенный, и `assertSideAllowed` до чтения заявки ответить на это не мог никогда.
      if (row.status !== 'new') {
        throw err.unprocessable(
          `От заявки в статусе «${serviceRequestStatusLabels[row.status]}» не отказываются — взявшегося исполнителя меняет переназначение`,
          { status: 'Другой статус' },
        );
      }
      /*
       * «Есть от чего отказываться» — своей проверкой и своим текстом, хотя предикат это условие
       * тоже держит (найдено db-тестами). Разведены они по причине, общей для всей ручки (§Г
       * реализации): предикат отвечает одним «нет», а коды здесь разные — 422 у состояния заявки и
       * 403 у стороны. Слей мы их, отказ по нераспределённой заявке приходил бы как «вы не
       * назначенный исполнитель», хотя дело не в субъекте: отказываться просто не от чего.
       */
      if (!serviceHasExecutors(await executorsRowOf(row))) {
        throw err.unprocessable(
          'От заявки, которую никому не отдали, отказываться нечего — её ещё распределяют',
          { status: 'Исполнителей нет' },
        );
      }
      if (
        !canDeclineServiceRequest(
          { ...(await executorsRowOf(row)), status: row.status },
          p,
          assignment,
        )
      ) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не отказывается от этой заявки — это шаг назначенного исполнителя`,
        );
      }

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
          // предикат открыт правом сметы, то есть администратор, доводящий чужую заявку. Отказ за
          // всех: выбирать, чью именно строку снять, ему не по чему.
          restNamed = [];
          restCounterparty = null;
        }

        /**
         * Свои строки ручка снимает сама — и поимённые, и всю компанию. Раньше полный отказ
         * доверял это матрице сброса (`reset.executor` на дуге `assigned → new`), но дуги больше
         * нет, а `in_work → new` сброса не несёт и нести не должна (Р5, п. 2): она обслуживает
         * переназначение и откат «принял в работу», которым исполнителей терять нельзя.
         *
         * Поимённые строки удаляются **до** помощника перехода — тем же порядком блокировок, что у
         * назначения (Н5): сперва заявка, потом её исполнители.
         */
        if (ownRow) {
          await tx
            .delete(serviceRequestExecutors)
            .where(
              and(
                eq(serviceRequestExecutors.requestId, locked.id),
                eq(serviceRequestExecutors.userId, p.id),
              ),
            );
        } else if (!wholeCounterparty) {
          await tx
            .delete(serviceRequestExecutors)
            .where(eq(serviceRequestExecutors.requestId, locked.id));
        }

        const left = serviceHasExecutors({
          serviceCounterpartyId: restCounterparty,
          executorCount: restNamed.length,
        });
        await applyTransition(tx, {
          row: locked,
          // Статуса отказ не меняет (Р7): и полный, и частичный оставляют заявку «Новой», а
          // различает их состав. Строка истории `from = to` при этом пишется — без неё
          // «исполнителей стало меньше» осталось бы событием без следа.
          to: locked.status,
          version: body.version,
          actor: p,
          comment: body.reason,
          patch: { serviceCounterpartyId: restCounterparty },
          // Условный сброс возраста (Р4): ушёл последний — ждут уже распределяющего, и отсчёт
          // начинается заново; кто-то остался — работу никому не передавали, и оставшиеся ждут её
          // ровно столько же, сколько ждали.
          touchStatusAt: !left,
          // Отказ исполнителя правит состав, а не шлёт письмо: снявшийся виден в письме о назначении,
          // а оставшаяся без исполнителя заявка уходит в «Новую» и письмо ставит уже её событие.
          mail: null,
        });
        return { left, wholeCounterparty, ownRow };
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
          // Не `returnedToNew`, как прежде: возвращать больше некуда — статуса отказ не меняет
          // (Р7), — а спрашивают у журнала ровно то же самое: осталась ли заявка у кого-нибудь.
          leftUnassigned: !outcome.left,
        },
      });
      return (await getDto(p, row.id))!;
    },
  );

  // ── Принятие заявки в работу ──
  // Своего события в аудите у перехода нет: содержания сверх самого перехода в нём тоже нет, и
  // строка аудита повторила бы строку истории статусов слово в слово.
  //
  // Отдельного статуса «Диагностика» больше нет (Н2): взявшийся за заявку стоит в «В работе» и
  // оттуда же предъявляет объём работ.
  //
  // Коридор теперь `new → in_work` вместо `assigned → in_work` (Р6): промежуточной «Назначенной»
  // между заведением и работой не стало. Открывает ход всё тот же **факт назначения**, а не право,
  // — и он же сам собой закрывает ход у нераспределённой заявки: у «Новой» без исполнителей
  // назначенных нет, и `isServiceExecutor` ложен при любом праве.
  r.patch(
    '/:id/start',
    { ...canExecutorStatus, schema: { params: idParams, body: startServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      assertSideAllowed(p, 'in_work', ['new']);
      const row = await requireEditable(p, req.params.id);
      const assignment = await executorAssignment(p, row);
      const executors = await executorsRowOf(row);
      /*
       * «Есть кому браться» — своей проверкой и своим 422, как у отказа. Найдено db-тестами:
       * прежде запрет держал статус (коридор был `assigned → in_work`, и у «Новой» дуг не было), а
       * после Р6 держать стало нечем — коридор открывает дизъюнкция, вторая половина которой,
       * право на объём работ, назначения не спрашивает. Заявку без исполнителей администратор
       * переводил в «В работе», и ловил это отложенный `service_requests_executor_present` на
       * `COMMIT`: данные целы, но наружу уходило 500 вместо отказа.
       */
      if (!serviceHasExecutors(executors)) {
        throw err.unprocessable(
          'Заявку сначала распределяют — брать в работу нераспределённую некому',
          { status: 'Исполнителей нет' },
        );
      }
      assertTransition(p, row.status, 'in_work', assignment);
      if (!canStartServiceWork({ ...executors, status: row.status }, p, assignment)) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не берёт эту заявку в работу — это шаг назначенного исполнителя`,
        );
      }
      // Приняли в работу — событие переходов (№ 4): службе и стороне заявки, кроме того, кто нажал.
      const mailPlan = await prepareTransitionMail('in_work', p, row.createdBy);
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: 'in_work',
          version: req.body.version,
          actor: p,
          mail: mailPlan,
        });
      });
      return (await getDto(p, row.id))!;
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
      // Заморозка — событие переходов: причина обязательна по схеме и уходит строкой письма.
      const mailPlan = await prepareTransitionMail('on_hold', p, row.createdBy);
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
          mail: mailPlan,
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
      return (await getDto(p, row.id))!;
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
      // Возврат к работе — событие переходов; куда именно вернули, знает `serviceResumeTarget`.
      const mailPlan = await prepareTransitionMail(target, p, row.createdBy);
      await db.transaction(async (tx) => {
        await applyTransition(tx, {
          row,
          to: target,
          version: body.version,
          actor: p,
          comment: body.comment,
          mail: mailPlan,
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
      return (await getDto(p, row.id))!;
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
      await assertExecutorSide(p, row, 'ведёт объём работ этой заявки');
      assertRepairKind(row, 'править');
      if (row.status !== 'in_work') {
        throw err.conflict(
          `Объём работ правится только в статусе «${serviceRequestStatusLabels.in_work}»`,
        );
      }
      /**
       * **Первый замок Р9.** Прежде правку предъявленного состава запирал сам статус: предъявленная
       * смета стояла в «Смете на согласовании», а эта ручка работала только из «В работе». Статус
       * снят (Р1), и, не заведи мы замок заново, исполнитель молча менял бы цифры под висящей
       * подписью — согласующий подписал бы не то, что видел.
       *
       * Ключ от замка один — «вернуть объём работ в правку» (`/estimate/reopen`): отзывает своё
       * предъявление тот, кто его подал.
       */
      if (serviceEstimatePending(row)) {
        throw err.conflict(
          `Объём работ ревизии ${row.estimateRevision} предъявлен и ждёт ответа — верните его в правку, прежде чем менять состав`,
        );
      }
      if (row.estimateRevision > 0 && row.approvedEstimateRevision === row.estimateRevision) {
        throw err.conflict(
          `Ревизия ${row.estimateRevision} согласована — верните объём работ в правку, прежде чем менять состав`,
        );
      }
      const before = (await getFullDto(p, row.id))!;

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

      const after = (await getFullDto(p, row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_update',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Состав, а не итог: «было 7 100, стало 6 900» скрывает, что вместо термоузла поставили
        // ролик, — а спорят с сервисом именно о составе.
        metadata: { changes: diffServiceEstimate(before.items, after.items) },
      });
      // Наружу — в объёме аудитории: полное `after` собрано ради журнала, а не ради ответа.
      return forAudience(after);
    },
  );

  // ── Предъявление объёма работ ──
  /**
   * **Предъявление перестало быть переходом** (Р8): заявка всё это время стоит в «В работе» — ровно
   * как просил заказчик, — а ожидание подписи открывает своя колонка `estimate_pending_revision`.
   * Ревизия при этом по-прежнему поднимается: на ней держится обесценивание подписи.
   *
   * **Второй замок Р9 — здесь, и пропустить его легче всего.** Повторное предъявление запирал сам
   * статус: из «Сметы на согласовании» эта ручка была недоступна. Сняв его, мы позволили бы
   * исполнителю поднять ревизию и подменить снимок суммы под уже открытым окном согласования —
   * согласующий нажал бы «Согласовать» по цифрам, которых больше нет, а сверка ревизий на закрытии
   * этого не поймала бы: ревизия-то согласована свежая.
   */
  r.patch(
    '/:id/estimate/submit',
    { ...canEstimate, schema: { params: idParams, body: submitServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      assertRepairKind(row, 'предъявлять');
      const assignment = await executorAssignment(p, row);
      // Объём работ предъявляют из «В работе» (Р8). Дуги у действия больше нет, поэтому статус
      // спрашивается прямо, а сторону исполнителя — предикат Р11, тот же, каким портал решает,
      // рисовать ли кнопку.
      if (row.status !== 'in_work') {
        throw err.unprocessable(
          `Объём работ предъявляют из «${serviceRequestStatusLabels.in_work}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Другой статус' },
        );
      }
      if (serviceEstimatePending(row)) {
        throw err.conflict(
          `Объём работ ревизии ${row.estimateRevision} уже предъявлен и ждёт ответа — верните его в правку, если нужно предъявить заново`,
        );
      }
      if (!canSubmitServiceEstimate(row, p, assignment)) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не предъявляет объём работ по этой заявке — это шаг исполнителя`,
        );
      }
      // Гарантийный ремонт — не пустая смета, а осознанное «чиним по гарантии, денег нет», и без
      // названного источника гарантии он ничем не подтверждён (Р27).
      if (body.warrantyRepair && !row.warrantyClaimSource) {
        throw err.unprocessable(
          'Гарантийный ремонт предъявляют по заявке с обращением по гарантии — укажите источник',
          { warrantyRepair: 'Нет обращения по гарантии' },
        );
      }

      const revision = row.estimateRevision + 1;
      /**
       * Предъявление адресовано тому, кто отвечает по объёму работ, — службе (§3, № 5). Событие
       * держится не за статус (он не меняется), а за пару «ревизия + действие»: повторное
       * предъявление той же ревизии письма не удвоит, а новая ревизия — это другие числа, о
       * которых обязаны узнать заново.
       */
      const mailPlan = await prepareServiceMail({
        event: 'service_request_estimate',
        actor: mailActorOf(p),
        authorId: row.createdBy,
        estimate: { revision, action: 'submit' },
      });
      const total = await db.transaction(async (tx) => {
        const side = await readServiceSide(tx, row.id);
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
          throw err.unprocessable('Объём работ пуст — добавьте хотя бы одну строку');
        }
        const amount = sumAmounts(items);
        await applyTransition(tx, {
          row,
          // Статус тот же (Р8). Через помощник перехода ручка всё равно идёт: он — единственная
          // точка, где заявка пишет строку истории и сбрасывает возраст ожидания, и второго пути
          // писать эти две вещи модуль не заводит (Р4).
          to: row.status,
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: {
            estimateRevision: revision,
            // Этим и открывается ожидание подписи (Р2): колонка равна поднятой ревизии, и
            // `CHECK` в базе сторожит, что предъявлена именно текущая.
            estimatePendingRevision: revision,
            estimateSubmittedAt: new Date(),
            // Снимок предъявленной суммы: по нему потом и сверяется закрытие.
            estimatedTotalAmount: money(amount),
          },
          // Ход перешёл к согласующему (`service → approval`) — возраст ожидания начинается заново.
          touchStatusAt: true,
          // Письмо ставит не переход (статус не меняется), а само предъявление — ниже.
          mail: null,
        });
        await queueServiceMailForIntent(tx, {
          prepared: mailPlan,
          side,
          requestId: row.id,
          anchor: `${row.id}-rev${revision}-submit`,
          extra: { estimate: { revision, action: 'submit' } },
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
      return (await getDto(p, row.id))!;
    },
  );

  // ── Согласование объёма работ ──
  /**
   * Одна ручка на «да» и «нет»: у них одно право, одна область и один момент. Согласие пишет
   * снимок из трёх полей — кто, когда и какую ревизию, — потому что по отдельности ни одно из них
   * не отвечает на вопрос «что именно согласовали». Причину и решение при отказе требует тело ручки.
   *
   * **Исходы разошлись** (Р8, В1). «Согласовано» статуса не меняет вовсе — заявка стоит в «В
   * работе», ровно как просил заказчик. «Не согласовано» уводит её в «Отменена»: своего
   * терминального статуса у отказа нет, «закрыта без результата» у модуля уже есть (Р53), а второе
   * имя для того же состояния делило бы отчёты пополам.
   *
   * Оба исхода гасят предъявление (`estimate_pending_revision → NULL`): ответ получен, и заявка
   * уходит из очереди согласования. У отказа это не формальность — оставленное предъявление
   * держало бы отменённую заявку в очереди подписи, и `canApproveServiceEstimate` пришлось бы
   * отбивать её вторым правилом рядом с перечнем статусов.
   *
   * **Порядок подписей снят вместе с визой ИТ** (Р10): согласует назначенный сотрудник, и вопрос
   * «чинить или менять» он задаёт себе сам, глядя на тот же счёт. Проверки «сумму согласуют после
   * визы» здесь больше нет — не потому, что её ослабили, а потому, что второй подписи не стало.
   *
   * **Коридор эту дугу не сторожит, и это осознанно.** Отмена по `SERVICE_OPERATOR_TRANSITIONS`
   * требует `serviceRequests.status`, а согласующим по ответу В2 бывает поимённый исполнитель, у
   * которого только `serviceRequests.execute`. Спроси мы здесь `assertTransition`, сторона Р3
   * получила бы ручку и не смогла бы ею воспользоваться. Кто перед нами, отвечает предикат
   * `canApproveServiceEstimate` — он же исключает оператора подрядчика: объём работ предъявил он, и
   * подпись под собственным счётом не согласование, а его копия.
   */
  r.patch(
    '/:id/estimate/approval',
    { ...canApproveEstimate, schema: { params: idParams, body: approveServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      assertRepairKind(row, 'согласовывать');
      const assignment = await executorAssignment(p, row);
      if (row.status !== 'in_work') {
        throw err.unprocessable(
          `Объём работ согласуют в «${serviceRequestStatusLabels.in_work}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Другой статус' },
        );
      }
      if (!serviceEstimatePending(row)) {
        throw err.unprocessable('Объём работ не предъявлен — согласовывать нечего', {
          status: 'Объём работ не предъявлен',
        });
      }
      if (!canApproveServiceEstimate(row, p, assignment)) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не согласует объём работ по этой заявке — это шаг того, кто её ведёт`,
        );
      }

      /**
       * Отказ по объёму работ отменяет заявку (В1) — значит ставит и письмо об отмене, как всякий
       * ВХОД В «Отменённую» (Р65). До ADR 0153 эта дуга письма не ставила вовсе, и дыра была тихой:
       * модуль объявляет событие привязанным к статусу, а не к ручке, и вторая дуга в тот же статус
       * молча этого не делала. Заметно стало на подрядчике — счёт предъявил он, отказ отменяет его
       * же работу, и узнать об этом ему было неоткуда.
       *
       * Согласование письма не ставит: статус у него не меняется, и события у «В работе» нет.
       */
      const mailPlan = body.approved
        ? null
        : await prepareTransitionMail('cancelled', p, row.createdBy);
      /**
       * Согласие статуса не меняет, но исполнителю сказать обязано: он ждёт ответа по предъявленным
       * числам и без письма узнаёт о нём, только заглянув в портал, — а у подрядчика портала может
       * не быть вовсе. Отказ отдельного письма не получает: он отменяет заявку, и об отмене уже
       * уходит своё письмо (§3) — второе означало бы, что подрядчик читает про отказ дважды.
       */
      const estimateMail = body.approved
        ? await prepareServiceMail({
            event: 'service_request_estimate',
            actor: mailActorOf(p),
            authorId: row.createdBy,
            estimate: { revision: row.estimateRevision, action: 'approved' },
          })
        : null;

      const mailResult = await db.transaction(async (tx) => {
        const side = await readServiceSide(tx, row.id);
        const transition = await applyTransition(tx, {
          row,
          mail: mailPlan,
          // «Согласовано» — тот же статус, «не согласовано» — отмена (В1).
          to: body.approved ? row.status : 'cancelled',
          version: body.version,
          actor: p,
          // Причина уходит комментарием перехода — туда же, куда у всякого перехода с объяснением.
          // Решение остаётся полем заявки: с него начинается разбор отклонённой заявки через месяц.
          comment: body.reason ?? '',
          patch: body.approved
            ? {
                approvedEstimateRevision: row.estimateRevision,
                estimateApprovedBy: p.id,
                estimateApprovedAt: new Date(),
                estimatePendingRevision: null,
              }
            : {
                estimatePendingRevision: null,
                /**
                 * Пометка замены больше НЕ ставится за человека (Р8). Прежде отказ ИТ означал «не
                 * чинить, значит менять», и флаг проставляла сама ручка; после слияния подписей «не
                 * согласовано» означает много чего ещё, и проставленный автоматически флаг был бы
                 * решением, которого никто не принимал.
                 */
                replacementRecommended: body.replacementRecommended,
                rejectionResolution: body.resolution ?? '',
              },
          // Ход возвращается исполнителю (`approval → service`) — возраст начинается заново. У
          // отказа возраст обнуляет сама смена статуса.
          touchStatusAt: body.approved,
        });
        if (estimateMail) {
          return queueServiceMailForIntent(tx, {
            prepared: estimateMail,
            side,
            requestId: row.id,
            anchor: `${row.id}-rev${row.estimateRevision}-approved`,
            extra: { estimate: { revision: row.estimateRevision, action: 'approved' } },
          });
        }
        return transition.mail;
      });
      // Исход у обеих половин свой: у согласия — письмо исполнителю, у отказа — письмо об отмене.
      const mailOutcome = mailResult?.outcome ?? (body.approved ? null : 'mail_failed');

      await writeAudit({
        actorUserId: p.id,
        action: body.approved
          ? 'serviceRequest.estimate_approve'
          : 'serviceRequest.estimate_reject',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          revision: row.estimateRevision,
          reason: body.reason ?? '',
          ...(mailOutcome ? { mail: mailOutcome } : {}),
          ...(body.approved
            ? {}
            : {
                replacementRecommended: body.replacementRecommended,
                /**
                 * Решение пишется элементом `changes`, а не полем рядом (Р12). Сборка истории
                 * извлекает содержание события только из `metadata.changes`
                 * (`service-request-history.ts`): произвольное поле рядом с `revision` и `reason`
                 * она молча пропустит, и подпись `rejectionResolution` в словаре изменений осталась
                 * бы неиспользованной. Своя ветка в `changesOf` по имени действия отвергнута — она
                 * заводит исключение ради одного поля там, где общий канал уже работает.
                 */
                changes: [{ field: 'rejectionResolution', from: '', to: body.resolution ?? '' }],
              }),
        },
      });
      /**
       * Исход почты уходит в аудит, а не в ответ, и это не потеря: ручка возвращает карточку
       * заявки (`ServiceRequestDto`), и приписать ей поле значило бы менять контракт ради случая,
       * у которого уже есть выход — кнопка «отправить ещё раз» по отменённой заявке (Р70).
       */
      if (mailOutcome && mailOutcome !== 'queued') {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: row.id,
          metadata: { event: 'service_request_cancelled', outcome: mailOutcome },
        });
      }
      return (await getDto(p, row.id))!;
    },
  );

  // ── Возврат объёма работ в правку ──
  /**
   * **Ключ от обоих замков Р9.** Ручка снимает ДВЕ отметки: снимок согласования (как и прежде) и
   * само предъявление — `estimate_pending_revision → NULL`. Отсюда и предусловие «есть что
   * снимать»: подпись ЛИБО непогашенное предъявление; прежнего «согласование есть» после Р9 мало —
   * иначе отозвать собственное предъявление было бы нечем, и оба замка заперли бы исполнителя
   * снаружи собственной сметы.
   *
   * Статуса заявка при этом не меняет и не меняла: второй дуги в предъявление заводить нельзя — она
   * сделала бы необязательным подъём ревизии, на котором держится обесценивание подписи (Р9).
   * Дальше исполнитель правит состав обычной ручкой и предъявляет заново — с ревизией +1.
   *
   * **Дату предъявления ручка НЕ трогает.** `estimate_submitted_at` сохраняет прежний смысл —
   * «когда предъявляли в последний раз», — и чистит её только полный сброс сметы. Активное
   * состояние определяет исключительно `estimatePendingRevision`: считай портал активным сам факт
   * непустой даты, у отозванного предъявления он показывал бы «предъявлено» (Р9).
   *
   * Визу ИТ ручка не трогает по-прежнему: подпись от 22.08 — снимок истории, стирать её нечем (Р10).
   */
  r.patch(
    '/:id/estimate/reopen',
    { ...canEstimate, schema: { params: idParams, body: reopenServiceEstimateSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      assertRepairKind(row, 'возвращать в правку');
      const assignment = await executorAssignment(p, row);
      if (row.status !== 'in_work') {
        throw err.unprocessable(
          `Объём работ возвращают в правку из «${serviceRequestStatusLabels.in_work}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Другой статус' },
        );
      }
      if (!serviceEstimatePending(row) && row.approvedEstimateRevision === null) {
        throw err.unprocessable(
          'У этого объёма работ нет ни предъявления, ни согласования — снимать нечего, правьте состав и предъявляйте заново',
          { status: 'Снимать нечего' },
        );
      }
      if (!canReopenServiceEstimate(row, p, assignment)) {
        const who = p.role ? roleLabels[p.role] : 'Учётная запись';
        throw err.forbidden(
          `${who} не возвращает объём работ в правку по этой заявке — это шаг исполнителя`,
        );
      }
      /**
       * Возврат в правку адресован тому, кто работал: объём работ вернули, и делать надо ему. Тот
       * же случай, что у решения по объёму, — письмо стороне сервиса, а не службе.
       */
      const mailPlan = await prepareServiceMail({
        event: 'service_request_estimate',
        actor: mailActorOf(p),
        authorId: row.createdBy,
        estimate: { revision: row.estimateRevision, action: 'reopened' },
      });
      await db.transaction(async (tx) => {
        const side = await readServiceSide(tx, row.id);
        await applyTransition(tx, {
          row,
          // Статус тот же, событие своё: «предъявление отозвано» и «согласование снято» обязаны
          // быть видны в ленте — иначе между двумя согласованиями одной заявки не понять, что
          // произошло. Пишет строку тот же помощник перехода, что и у остальных ходов (Р4).
          to: row.status,
          version: body.version,
          actor: p,
          comment: body.reason,
          patch: {
            approvedEstimateRevision: null,
            estimateApprovedBy: null,
            estimateApprovedAt: null,
            estimatePendingRevision: null,
          },
          /**
           * Условный сброс возраста (Р4), и условие здесь не «сменилась ли сторона вообще», а какое
           * из двух предусловий сработало. Отзыв ВИСЯЩЕГО предъявления возвращает ход исполнителю
           * (`approval → service`) — отсчёт начинается заново. Снятие подписи с уже согласованного
           * объёма не двигает ничего: до него ждали исполнителя и после него ждут его же.
           */
          touchStatusAt: serviceEstimatePending(row),
          // Письмо ставит не переход (статус тот же), а сам возврат — ниже.
          mail: null,
        });
        await queueServiceMailForIntent(tx, {
          prepared: mailPlan,
          side,
          requestId: row.id,
          anchor: `${row.id}-rev${row.estimateRevision}-reopened`,
          extra: { estimate: { revision: row.estimateRevision, action: 'reopened' } },
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_reopen',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { revision: row.estimateRevision, reason: body.reason },
      });
      return (await getDto(p, row.id))!;
    },
  );

  // ── Строки заявки на расходники ──
  /**
   * Состав передаётся целиком, как и смета: это список того, что просят, и «добавить одну позицию»
   * без остальных заставляло бы сервер угадывать, снимали ли что-то.
   *
   * **Состав заполняет исполнитель, а не заказчик** (Р15). Заявитель номенклатуры не знает — его
   * дело сказать словами, чего не хватает, — и требование позиций ушло из схемы заведения. Значит
   * ушло и прежнее правило доступа («заказчик, пока заявку никому не отдали»): правит теперь
   * назначенный, пока не отмечена выдача. Заказчик состав **видит** — это ответ на его «что мне
   * привезут» — и не правит.
   *
   * Пара прав — `serviceRequests.estimate` + `serviceRequests.execute`, та же, что у ручек объёма
   * работ, и выбрана она не по смыслу слова «смета», а потому что это и есть «сторона исполнителя»
   * в матрице (страж `canConsumables`). Назначение **на эту заявку** проверяет тело ручки
   * (`assertExecutorSide`), как и у объёма работ: держатель `execute` без строки в заявке получает
   * отказ от него, а не от `preHandler`.
   *
   * Статусов два — «Новая» (уже назначенная) и «В работе»: состав нужен исполнителю ровно тогда,
   * когда он собирается ехать. Дальше «В работе» его не правят — там идёт выдача, у которой своя
   * ручка (Р6).
   *
   * ПОКА ВЫДАЧИ НЕ БЫЛО. Строку, за которой числится движение склада, не удаляет ни маршрут, ни
   * каскад (`ON DELETE RESTRICT` составного ключа журнала), и замена состава упёрлась бы в неё
   * `23503`. Но дело не в коде ошибки: заявка, по которой уже что-то выдали, — это не список
   * пожеланий, а основание записи на складе, и менять его задним числом нельзя.
   */
  r.put(
    '/:id/consumables',
    { ...canConsumables, schema: { params: idParams, body: putServiceConsumablesSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      if (row.kind !== 'consumable') {
        throw err.unprocessable('Строки номенклатуры бывают только у заявки на расходники', {
          items: 'Не тот вид заявки',
        });
      }
      // Действие — глаголом: отказ складывается в «… не ведёт состав этой заявки — это шаг
      // назначенного исполнителя».
      await assertExecutorSide(p, row, 'ведёт состав этой заявки');
      /**
       * Перечень статусов поимённо, а не «лишь бы не закрыта» (тот же приём, что у правки факта
       * выдачи). Отложенная попадает во вторую ветку по общему правилу Р110: под разбирательством о
       * задержке состав — предмет спора, а не поле формы. Закрытой оставлен свой текст: там
       * человеку нужен не список статусов, а то, что менять уже нечего.
       */
      if (row.status !== 'new' && row.status !== 'in_work') {
        throw err.unprocessable(
          isServiceRequestClosed(row.status)
            ? `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» закрыта — состав ей уже не меняют`
            : `Состав правят в статусах «${serviceRequestStatusLabels.new}» и «${serviceRequestStatusLabels.in_work}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: isServiceRequestClosed(row.status) ? 'Заявка закрыта' : 'Другой статус' },
        );
      }
      const before = (await getFullDto(p, row.id))!;

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

      const after = (await getFullDto(p, row.id))!;
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
      // Наружу — в объёме аудитории: полное `after` собрано ради журнала, а не ради ответа.
      return forAudience(after);
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
      return (await getDto(p, row.id))!;
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
          `Согласована ревизия ${row.approvedEstimateRevision ?? 0}, а в заявке ${row.estimateRevision} — согласуйте объём работ заново`,
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

      // «Решена» — событие переходов: заявку предъявили к приёмке, и ждут теперь заказчика.
      const mailPlan = await prepareTransitionMail('done', p, row.createdBy);
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
          throw err.unprocessable('Отметка о выполнении нужна по каждой строке объёма работ', {
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
            `Итог по акту (${money(total)}) больше согласованного объёма работ (${money(approved)})`,
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
          mail: mailPlan,
        });
        return { total, works, movements };
      });

      const after = (await getFullDto(p, row.id))!;
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
      // Наружу — в объёме аудитории: полное `after` собрано ради журнала, а не ради ответа.
      return forAudience(after);
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
      // Приёмка — событие переходов: исполнителю важно, что работу приняли.
      const mailPlan = await prepareTransitionMail('accepted', p, row.createdBy);
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
          mail: mailPlan,
        });
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.accept',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { total: num(row.finalTotalAmount) },
      });
      return (await getDto(p, row.id))!;
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
      // Возврат на доработку — событие переходов: причина в письме, иначе исполнитель узнает факт без дела.
      const mailPlan = await prepareTransitionMail('in_work', p, row.createdBy);
      const reworked = await db.transaction(async (tx) =>
        applyTransition(tx, {
          row,
          to: 'in_work',
          version: body.version,
          actor: p,
          comment: body.reason,
          mail: mailPlan,
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
      return (await getDto(p, row.id))!;
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
       * транзакции; автор заявки остаётся обратным адресом письма службе, а подрядчик отвечает на
       * ящик службы.
       */
      // Сторону, которой адресована отмена, снимает сама транзакция — до бизнес-изменения (§5.2):
      // отмена сбрасывает исполнителя тем же переходом, и подрядчик, уже собравшийся ехать, иначе
      // выпал бы из адресатов ровно того письма, ради которого оно и существует (ADR 0153).
      const mailPlan = await prepareTransitionMail(to, p, row.createdBy);

      const transition = await db.transaction(async (tx) =>
        applyTransition(tx, {
          row,
          to,
          version: body.version,
          actor: p,
          comment: body.reason,
          mail: mailPlan,
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
      if (transition.mail?.outcome === 'mail_failed') {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: row.id,
          metadata: { event: mailPlan?.intent.event ?? null },
        });
      }
      return {
        request: (await getDto(p, row.id))!,
        mail: transition.mail?.outcome ?? 'not_needed',
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

      const event = repeatableServiceMailEventOf(row.status);
      if (!event) {
        throw err.unprocessable('По этой заявке письма службе не отправлялись', {
          status: 'Нечего повторять',
        });
      }
      /**
       * Повтор запирается не только статусом, но и составом исполнителей (Р14). Письмо «Новой»
       * зовёт службу РАЗОБРАТЬ заявку, и повторять его после назначения незачем: задание
       * исполнителю ушло своим письмом, привязанным к действию, а не к статусу. Пока «Новая»
       * означала «ещё не назначена», на этот вопрос отвечал сам статус; после слияния (Р1) он
       * половину ответа потерял бы молча — кнопка осталась бы на месте, а письмо звало бы разбирать
       * заявку, которую уже разобрали.
       *
       * Предикат тот же, каким портал решает, показывать ли кнопку: разойдись они — либо кнопка
       * вела бы в 422, либо повтор оставался бы недоступным там, где сервер его позволяет.
       */
      if (!serviceMailRepeatable({ ...(await executorsRowOf(row)), status: row.status })) {
        throw err.unprocessable(
          'Заявку уже разобрали и назначили исполнителя — письмо службе повторять незачем',
          { status: 'Нечего повторять' },
        );
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

      // Повтор кнопкой шлёт то же письмо тем же адресатам, что и само событие: разойдись они,
      // «отправить ещё раз» означало бы «отправить не всем». Поэтому и путь один — тот же
      // транзакционный сборщик, только с ключом идемпотентности (Р70).
      const mailPlan = await prepareTransitionMail(row.status, p, row.createdBy);
      if (!mailPlan) return { mail: 'not_needed', recipients: [] };

      const result = await db.transaction(async (tx) =>
        queueServiceMailForIntent(tx, {
          prepared: mailPlan,
          side: await readServiceSide(tx, row.id),
          requestId: row.id,
          anchor: entry.id,
          idempotencyKey: req.body.idempotencyKey,
        }),
      );

      await writeAudit({
        actorUserId: p.id,
        // Именно «поставлено в очередь»: отправляет письмо worker, и «отправлено» здесь было бы
        // обещанием, которого этот момент не даёт.
        action:
          result.outcome === 'queued' ? 'serviceRequest.mailQueued' : 'serviceRequest.mailFailed',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          event,
          outcome: result.outcome,
          recipients: result.recipients.map((r) => r.email),
        },
      });

      return { mail: result.outcome, recipients: result.recipients.map((r) => r.email) };
    },
  );

  // ── Примечание исполнителя (приём ADR 0053) — АДАПТЕР СОВМЕСТИМОСТИ ──
  /**
   * Ручка живёт ровно столько, сколько работает сервер выпуска A (ADR 0141, решение 7, §3.10):
   * браузер держит СТАРЫЙ бандл и после выката чата продолжает звать её, а откат релиза возвращает
   * сервер, который о ленте не знает. Снимается она выпуском B — вместе со слайсом портала, полем
   * DTO и колонкой в `schema.ts`; сама колонка уходит из базы ещё выпуском позже.
   *
   * Пока она жива, делает две вещи ОДНОЙ транзакцией: обновляет колонку, как раньше, и вставляет
   * ту же строку репликой `origin='import'` с хешем текста — так написанное старым клиентом сразу
   * видно в обсуждении, а повторный перенос выпуска C на том же хеше дубля не создаст.
   *
   * Транзакция — верхнеуровневая (`db.transaction`), и это требование схемы, а не стиль: адресата
   * можно вставить только в транзакции, создавшей реплику, а `xmin` строки из savepoint'а
   * триггер не признаёт (§3.3).
   *
   * Ход заявки примечание не меняет и возраст ожидания не сбрасывает: это строка сервиса в карточке.
   */
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
        // Блокировка строки — та же, под которой номер выдаёт обычная отправка: без неё два
        // одновременных примечания получили бы один `seq` и столкнулись на уникальном индексе.
        await lockRequest(tx, row.id);
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
        // Пустое значение — старый способ «стереть примечание». Колонку он чистит, а ленту стирать
        // нечем: реплики не правятся и не удаляются (решение 6 ADR), и пустая строка в разговоре
        // не значила бы ничего.
        if (body.serviceComment !== '') {
          await importServiceCommentMessage(tx, p.id, row.id, body.serviceComment);
        }
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.service_comment',
        entityType: 'serviceRequest',
        entityId: row.id,
      });
      return (await getDto(p, row.id))!;
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
      // Аудитория — первый слой подшивки (ADR 0160, решение 7), а не замена стражу ручки:
      // `serviceRequests.files` остаётся на месте, и одной аудитории для действия недостаточно.
      assertFileKindAllowed(
        effectiveStatus(row),
        kind,
        serviceRequestAudienceOf(p, await executorAssignment(p, row)),
      );

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
      return (await getDto(p, row.id))!;
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
    const audience = serviceRequestAudienceOf(p, await executorAssignment(p, row));

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
      if (!link) throw err.notFound(FILE_NOT_LINKED);

      /*
       * ЗАМОК АУДИТОРИИ (ADR 0160, решение 7) — четвёртый, и стоит он первым, потому что отвечает
       * раньше всех остальных: заявителю доступен только файл, который он сам подшил и который ему
       * ВИДЕН по видам.
       *
       * Невидимый вид отвечает `404` тем же текстом, что и «связи нет вовсе», — и это не
       * небрежность, а условие задачи: разведи мы ответы, по коду читалось бы, есть ли у заявки
       * счёт, перебором идентификаторов и без единого скачивания. Ровно поэтому оба отказа
       * называются одной константой.
       *
       * Своего файла заявитель, наоборот, не лишается: «снимает тот, кто приложил» — прежнее общее
       * правило ниже, здесь оно повторено без оговорки про `files.manageAny`. Распорядитель чужими
       * файлами, не видящий денег этой заявки, снимал бы бумагу, которой не видит.
       */
      if (audience === 'requester') {
        if (!isServiceFileKindVisible(link.kind, audience)) throw err.notFound(FILE_NOT_LINKED);
        if (link.attachedBy !== p.id) {
          throw err.forbidden('Снять вложение может тот, кто его приложил');
        }
      }

      // Статус — «эффективный» (Р110), тем же правилом, что и виды документов при подшивке:
      // заморозка бумаги не запирает, и смета отложенной «Диагностики» снимается так же, как
      // смета незамороженной.
      const status = effectiveStatus(locked);
      if (isServiceRequestClosed(status) && !manageAny) {
        throw err.forbidden('Из закрытой заявки документы не снимают');
      }
      /*
       * ТРЕТИЙ ЗАМОК ВИСЯЩЕГО ПРЕДЪЯВЛЕНИЯ (Р9), и держал его раньше статус.
       *
       * Прежнее условие звучало «снимать можно только из „В работе“», и этого хватало: предъявление
       * уводило заявку в «Смету на согласовании», откуда условие и отбивало снятие. Предъявление
       * статуса менять перестало (Р8) — заявка остаётся в «В работе», прежнее условие обращается в
       * ложь, и исполнитель вынимает предъявленный файл из-под открытого окна согласования:
       * согласующий смотрит на цифры, документа под которыми уже нет.
       *
       * Поэтому условий теперь два, и они про разное. `status !== 'in_work'` — прежнее правило:
       * из «Решена», «Новой» и прочего предъявление не трогают вовсе. `serviceEstimatePending` —
       * то, что статус держал молча: пока ответа на предъявление нет, бумага под ним неприкосновенна.
       * Ключ от замка тот же, что у двух других (правки состава и повторного предъявления), —
       * «Вернуть объём работ в правку»: он гасит предъявление, и файл снова снимается.
       *
       * Найдено db-тестами при реализации; в Р9 плана этого замка не было — он разбирал состав и
       * повторное предъявление, а про документы говорил только перечнем видов (Р14).
       */
      const estimateLocked = status !== 'in_work' || serviceEstimatePending(locked);
      if (link.kind === 'estimate' && estimateLocked && !manageAny) {
        throw err.unprocessable(
          'Предъявленный объём работ не снимается — верните его в правку и предъявите заново',
          { kind: 'Объём работ предъявлен' },
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
    return (await getDto(p, row.id))!;
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
        //
        // Третья ось спрашивается ТОЙ ЖЕ транзакцией (`tx`), а не общим пулом: строка уже взята под
        // блокировку выше, и второе соединение ради одного `EXISTS` заперло бы само себя, стоило
        // пулу кончиться.
        await assertScope(p, row, tx);
        if (!row.deletedAt) return false;
        // Место в очереди по единице занимает только заявка С аппаратом. Правило «одна открытая
        // заявка на единицу и вид» (Р21) держат уникальные частичные индексы по
        // `office_equipment_id`, а `NULL` в уникальном индексе PostgreSQL считает отличным от
        // всякого другого `NULL` — заявки без аппарата (Р8) друг другу не мешают и мешать не
        // должны: «одна заявка на аппарат» без аппарата означало бы «одна заявка на всю компанию».
        // Условие названо явно, а не оставлено базе: сравнение `office_equipment_id = NULL` и так
        // не находит ничего, но отвечает это «ничего» случайностью трёхзначной логики, а не
        // правилом, — и первая же правка запроса превратила бы случайность в дефект.
        if (!isServiceRequestClosed(row.status) && row.officeEquipmentId !== null) {
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
      return (await getDto(p, req.params.id))!;
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
