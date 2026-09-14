import { createHash } from 'node:crypto';
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
  actsAsServiceOperator,
  actsForCounterparty,
  allowsEstimateApprovalInStatus,
  approveServiceEstimateSchema,
  attachServiceFilesSchema,
  can,
  canApproveServiceEstimate,
  canAssignServiceExecutors,
  canAttachServiceFile,
  canAttachServiceFileSide,
  canDeclareExemption,
  canDeclineServiceRequest,
  canHoldService,
  canOpenServiceEstimateDispute,
  canPickAnyServiceSubject,
  canReopenServiceEstimate,
  canResolveServiceEstimateDispute,
  canResumeService,
  canSubmitServiceEstimate,
  canTransitionServiceStatus,
  closingKindsForFormat,
  completeServiceRequestSchema,
  createServiceRequestSchema,
  declineServiceRequestSchema,
  evaluateExemption,
  formatServiceRequestNumber,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isServiceExecutor,
  isServiceFileKindAttachable,
  isServiceFileKindVisible,
  isServiceRequestClosed,
  isWarrantyActive,
  isWaitingOn,
  moscowInstantOf,
  officeEquipmentTitle,
  openServiceEstimateDisputeSchema,
  parseServiceRequestNumberSearch,
  projectServiceRequestForAudience,
  putServiceEstimateBreakdownSchema,
  putServiceEstimateSchema,
  putServiceExecutorsSchema,
  reopenServiceEstimateSchema,
  resolveServiceEstimateDisputeSchema,
  reworkServiceRequestSchema,
  roleLabels,
  putServiceConsumablesSchema,
  serviceConsumableIssueIssue,
  serviceRequestKindLabels,
  setServiceConsumablesIssuedSchema,
  SERVICE_ADMIN_ROLLBACKS,
  isServiceClosingDocument,
  SERVICE_CLOSING_DOCUMENT_KINDS,
  SERVICE_ESTIMATE_DISPUTE_HOLD_KIND,
  SERVICE_ESTIMATE_DISPUTE_OPEN_STATUSES,
  SERVICE_REQUEST_STATUSES,
  SERVICE_WAITING_ON,
  serviceCommentSchema,
  canRunServiceBulkOperation,
  canStartServiceWork,
  canUseServiceBulk,
  serviceEstimatePending,
  serviceFileAttachingSideLabels,
  serviceFileAttachingSides,
  serviceFileKindLabels,
  serviceHasExecutors,
  serviceHoldSchema,
  serviceIsFirstAssignment,
  serviceMailRepeatable,
  serviceRequestAudienceOf,
  serviceRequestBulkKeyParams,
  serviceRequestBulkSchema,
  serviceRequestListQuerySchema,
  serviceRequestHasEffectivePendingEstimate,
  serviceRequestNeedsClosingDocument,
  serviceRequestNeedsEstimate,
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
  type AccessSubject,
  type EquipmentCandidateInput,
  type ModuleMailOutcome,
  type ServiceEstimateDisputeFacts,
  type ServiceEstimateFormat,
  type ServiceExecutorAssignment,
  type ServiceExecutorsRow,
  type ServiceFileKind,
  type ServiceRequestAudience,
  type ServiceRequestBulkResultDto,
  type ServiceRequestBulkStatusDto,
  type ServiceRequestConsumableDto,
  type ServiceRequestEstimateDisputeDto,
  type ServiceRequestEstimateExemptionDto,
  type ServiceRequestKind,
  type ServiceWaitingOn,
  type ServiceWarrantyRowDto,
  type ServiceRequestChatSummaryDto,
  type ServiceRequestDto,
  type ServiceRequestRepeatDto,
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
  officeEquipmentCandidates,
  officeEquipmentConsumables,
  officeEquipmentConsumableStockEntries,
  officeEquipmentTypes,
  serviceRequestConsumables,
  serviceRequestEstimateDisputes,
  serviceRequestEstimateExemptions,
  serviceRequestExecutors,
  serviceRequestFiles,
  serviceRequestItems,
  serviceRequestPastExecutors,
  serviceRequests,
  serviceRequestStatusHistory,
  users,
} from '../db/schema';
import { grantPermissionsExpr } from '../services/user-scopes';
import { err, type AppError } from '../lib/errors';
/*
 * Разбор ошибки PostgreSQL по коду: частичный уникальный индекс открытого спора ловит гонку двух
 * открытий, и без разбора `23505` второй запрос получил бы 500 вместо внятного 409.
 */
import { pgErrorOf } from '../lib/pg-error';
import { writeAudit } from '../lib/audit';
import {
  documentMailTargets,
  prepareServiceMail,
  queueServiceMailForIntent,
  readServiceSide,
  repeatableServiceMailEventOf,
  serviceMailEventOf,
  type ServiceMailBulkSink,
  type ServiceMailPreparation,
  type ServiceMailResult,
  type ServiceRequestSide,
} from '../services/service-request-mail';
import {
  prepareCandidateMail,
  queueCandidateMail,
} from '../services/office-equipment-candidate-mail';
import {
  outsideBulk,
  readServiceBulkStatus,
  runServiceRequestBulk,
  serviceBulkFingerprint,
  type BulkStepContext,
} from '../services/service-request-bulk';
import { requirePrincipal } from '../auth/plugin';
import {
  accessSubjectColumns,
  accessSubjectOf,
  loadPrincipal,
  type Principal,
} from '../auth/principal';
import {
  archiveWhere,
  assertActsAsRequestCustomer,
  assertArchiveVisible,
  assertCan,
  assertServiceRequestDeletable,
  assertServiceRequestEditable,
  assertServiceRequestScope,
  assertServiceRequestActionable,
  assertServiceRequestVisible,
  inServiceRequestCustomerScope,
  officeEquipmentScopeWhere,
  type ServiceRequestAuthorPlace,
  serviceRequestNamedExecutorWhere,
  type ServiceRequestExecutorFacts,
  serviceRequestVisibilityWhere,
} from '../lib/access';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerServiceAccessDenialAudit } from '../lib/service-access-audit';
import { serviceDenied } from '../lib/service-access-denied';
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
/*
 * Признак повторного обращения по аппарату (план `docs/office-equipment-repeat-request-plan.md`).
 * Правило живёт одним builder'ом на сервере: список, карточка и отбор зовут его же, и второй
 * записи условия — ни в контрактах, ни здесь — не заводится.
 */
import {
  serviceRequestRepeatByRequest,
  serviceRequestRepeatPreviousWhere,
  serviceRequestRepeatWhere,
} from '../services/service-request-repeat';
/*
 * Заявленное место и его разбор (план перемещения из карточки заявки, Р8). Условие очереди и
 * признак строки считает один модуль: разъедься они, ИТ-служба видела бы в списке одно, а в
 * карточке другое.
 */
import {
  confirmedPlaceByRequest,
  placeNotConfirmedWhere,
  type PlaceConfirmation,
} from '../services/service-request-place';
/*
 * Ревизии объёма работ (Э3 плана освобождения): формат предъявления и SQL-редакция правила «какая
 * бумага закрывает заявку». Отдельным модулем потому, что второй читатель условия — отбор пачки
 * автозакрытия в `internal-service-requests.ts`, то есть другой файл и другой процесс.
 */
import {
  activeEstimateFormatByRequest,
  dropEstimateRevisions,
  estimateDisputeByRequest,
  estimateExemptionByRequest,
  estimateSignatureRequiredByDispute,
  readActiveEstimateFormat,
  recordEstimateExemption,
  recordEstimateRevision,
  serviceHasClosingDocumentSql,
} from '../services/service-estimate-revision';
import {
  chatSummaryByRequest,
  chatUnreadCount,
  importServiceCommentMessage,
  markAllChatRead,
  markChatRead,
  postChatMessage,
  readChatPage,
} from '../services/service-request-chat';
// Приём сообщения о технике, которой нет в справочнике (план кандидатов, Р2): два рубежа дублей и
// ключ идемпотентности живут своим модулем, а разбор предмета и вставка пары — здесь, рядом с двумя
// другими способами назвать предмет.
import {
  asCandidateIntakeRepeat,
  assertNoParkDuplicate,
  candidateIntakeFingerprint,
  candidateIntakeKeyOf,
  findIntakeRepeat,
} from '../services/service-request-candidate-intake';
// Замок приёмки под непроверенным предметом (план кандидатов, Р16): правило живёт в модуле
// кандидата вместе с блокировкой его строки — здесь его только применяют, и порядок блокировок
// «заявка → кандидат» описан там же.
import { assertCandidateDecided } from '../services/office-equipment-candidates';
// Тип сообщения проверяется тем же помощником, что и форма карточки парка (Р14): две двери в один
// справочник обязаны принимать одно и то же.
import { assertTypeUsable } from '../services/office-equipment-write';
// Рубильник приёма сообщений о технике (план `docs/office-equipment-request-subject-plan.md`, Р10).
// Ту же функцию зовут ответы сессии: портал показывает дверь по списку из сессии, а пускает в неё
// сервер, читая ту же строку, — двум ответам на один вопрос разойтись нечем.
import { isFeatureEnabled } from '../services/feature-flags';
// Имя карантинного вложения наружу не уходит (план освобождения от согласования, Р6, п. 4).
// Правило одно на десять сборщиков вложений и живёт в своём модуле: девять копий условия
// `quarantinedAt` разошлись бы на первой же новой ручке — ровно этим модуль и заведён.
import { fileNameView } from '../services/file-view';

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
/**
 * Версия у архивирования — параметром запроса (Р4 плана массовых действий, находка Н6): тела у
 * `DELETE` нет, а `z.coerce` нужен потому, что в строке запроса число приезжает строкой.
 * Необязательное поле — временная граница выпуска A, названная и в плане, и на самой ручке.
 */
const archiveVersionQuery = z.object({
  version: z.coerce.number().int().nonnegative().optional(),
});

/**
 * Ключ идемпотентности пачки — заголовком, тем же транспортом, что у сообщения о технике и у
 * закупки (Р7).
 *
 * ОБЯЗАТЕЛЕН, и это не строгость ради строгости: повторный клик и повтор HTTP у пачки не редкость,
 * а норма — она идёт секунды, кнопка видна, вкладка может перезагрузиться. Версии от этого не
 * спасают: повтор после успеха получил бы `version` по всем строкам и выглядел бы как «ничего не
 * вышло», хотя всё вышло.
 *
 * `uuid`, а не свободная строка: ключ порождает портал на попытку отправки, тип отбивает мусор в
 * заголовке раньше маршрута, и он же стоит типом колонки журнала.
 */
function bulkKeyOf(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw err.badRequest(
      'Массовое действие отправляется с заголовком Idempotency-Key — обновите страницу и повторите',
    );
  }
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw err.badRequest('Некорректный Idempotency-Key');
  return parsed.data;
}

/**
 * Заявка, на которую подбирают исполнителя (Р7). В контракты схема не уехала намеренно: она
 * описывает адрес запроса, а не данные модуля, — ровно как `idParams` рядом, и портал шлёт по ней
 * один идентификатор, а не форму.
 */
const executorCandidatesQuery = z.object({ requestId: z.string().uuid() });

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
      /**
       * Срок гарантии единицы — тоже ТЕКУЩИЙ, из справочника (Ф3, §13 плана кандидата). Стоит
       * рядом с объектом карточки по той же причине: оба поля отвечают про карточку сегодня, а не
       * про снимок заявки, — и оба берутся из УЖЕ стоящего соединения, ради названия типа
       * заведённого. Ни нового `leftJoin`, ни второго запроса поле не добавляет.
       */
      equipmentWarrantyUntil: officeEquipment.warrantyUntil,
      /**
       * СООБЩЕНИЕ О ТЕХНИКЕ, ставшее предметом заявки (план кандидатов, Р5, §9). Шесть колонок, а
       * не строка целиком: в блок заявки уходит пересечение двух кругов читателей — тех, кто видит
       * заявку, и тех, кому открыта очередь проверки (Р9), — и выбрано оно составом полей, а не
       * вычёркиванием из DTO кандидата (разбор — при `ServiceRequestCandidateDto` в контрактах).
       *
       * СОЕДИНЕНИЕМ, А НЕ ВТОРЫМ ЗАПРОСОМ, и по той же причине, что у гарантии выше: блок нужен
       * КАЖДОЙ показанной заявке — и в карточке, и в строке списка, где предмет называют, — а
       * связь «заявка ↔ кандидат» ровно 1:1 (`equipment_candidate_id`, третья ветвь
       * `service_requests_subject_check`). Левое соединение по ключу 1:1 строк не размножает, и
       * лишнего похода в базу блок не стоит. Отдельная ручка означала бы запрос на строку списка.
       *
       * СОЕДИНЕНИЕ ЛЕВОЕ, и пустует оно законно — как и соседнее соединение с карточкой парка, но
       * ПО ОЧЕРЕДИ с ним: у заявки с обычным аппаратом кандидата нет, у заявки с кандидатом нет
       * аппарата (Р5), а у заявки без предмета вовсе (Р8) пусты оба. Внутреннее соединение здесь
       * потеряло бы из списка ровно те заявки, ради которых блок и заводится, — и потеряло бы
       * молча. Ссылка при этом `restrict`: строка соединения не приходит пустой НИКОГДА, когда
       * `equipment_candidate_id` непуст, — на этом и стоит сборка блока ниже.
       */
      candidateId: officeEquipmentCandidates.id,
      candidateStatus: officeEquipmentCandidates.status,
      candidateDeclaredModel: officeEquipmentCandidates.declaredModel,
      candidateSerialNumber: officeEquipmentCandidates.serialNumber,
      candidateInventoryNumber: officeEquipmentCandidates.inventoryNumber,
      candidateDecisionReason: officeEquipmentCandidates.decisionReason,
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
    .leftJoin(
      officeEquipmentCandidates,
      eq(serviceRequests.equipmentCandidateId, officeEquipmentCandidates.id),
    )
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
      /*
       * РОЛЬ СВЯЗИ УХОДИТ В КАРТОЧКУ (Р5 плана освобождения от согласования). Сегодня у всех связей
       * она одна — `closing_evidence` по умолчанию миграции `0306`, — и портал, спрашивая предикат,
       * получает тот же ответ, что и раньше. Но половина правила «закрывает ли ЭТОТ файл ЭТУ
       * заявку» живёт именно в роли, и не отдай мы её сейчас, портальная половина осталась бы слепой
       * ровно в день, когда Э4 заведёт первое основание: зелёный тег «закрывает» вернулся бы на
       * счёт, которым заявку открыли.
       */
      purpose: serviceRequestFiles.purpose,
      attachedAt: serviceRequestFiles.attachedAt,
      id: files.id,
      filename: files.filename,
      /*
       * СОСТОЯНИЕ КАРАНТИНА ЧИТАЕТСЯ ЗДЕСЬ, А СУДЬБУ ИМЕНИ РЕШАЕТ `fileNameView` (Р6, п. 4). Без
       * колонки сборщик отдавал бы «Паспорт_Иванова_1984.pdf» всякому, кому видна заявка, — то есть
       * оставлял бы открытой подпись документа, содержимое которого уже заперто: имя файла само
       * бывает персональными данными, и карантин, закрывший одно и оставивший другое, закрывает не
       * инцидент, а его половину.
       */
      quarantinedAt: files.quarantinedAt,
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
      // Имя и признак — парой из общего правила: по отдельности они врут («файл без имени» вместо
      // «файл скрыт по обращению»). Идентификатор и сама строка остаются намеренно — содержимое
      // закрывает замок в `canAccessFile`, а «документ скрыт» и «документа не было» — разные факты.
      ...fileNameView(row),
      contentType: row.contentType,
      size: row.size,
      kind: row.kind,
      purpose: row.purpose,
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
 *
 * Предъявление приходит посчитанным по той же причине и с той же ценой ошибки (Р7, Н11 плана
 * `docs/office-equipment-card-and-list-cleanup-plan.md`): очередь спрашивает ДЕЙСТВУЮЩЕЕ ожидание,
 * а не колонку. У внутренней заявки `estimate_pending_revision` мог сохраниться с тех пор, когда
 * объём работ был обязателен любому ремонту, — и, отдай мы сюда сырое значение, карточка вечно
 * показывала бы «ждёт согласования», которого после Р5 некому дать. Отвечает на это
 * `serviceRequestHasEffectivePendingEstimate`, и она же стоит SQL-выражением в builder'е списка:
 * два разных ответа на один вопрос — ровно то расхождение «бейдж ведёт в пустую очередь», ради
 * которого признак и посчитан здесь, а не выведен полем строки.
 */
function waitingRowOf(r: RequestRow, executorCount: number): ServiceWaitingRequest {
  return {
    status: r.status,
    hasExecutors: serviceHasExecutors({
      serviceCounterpartyId: r.serviceCounterpartyId,
      executorCount,
    }),
    estimatePending: serviceRequestHasEffectivePendingEstimate(r),
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
async function executorsRowOf(
  row: RequestRow,
  exec: typeof db | Tx = db,
): Promise<ServiceExecutorsRow> {
  const [counted] = await exec
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
  seesEquipmentDirectory: boolean,
  inCustomerScope: boolean,
  /**
   * Признак повторного обращения (план `docs/office-equipment-repeat-request-plan.md`).
   * `undefined` — признак не применяется вовсе: окно выключено настройкой, либо у заявки нет
   * аппарата, либо это не ремонт. Отличие от `count: 0` («считали, повторов нет») содержательное, и
   * держится оно спредом в теле: поля не должно быть в объекте, а не только в его JSON.
   */
  repeat: ServiceRequestRepeatDto | undefined,
  /**
   * Подтверждение заявленного места по этой заявке (план перемещения, Р8): `null` — не разобрано
   * либо расхождения не заявляли. Приходит готовым снимком из пакетной догрузки страницы: строка на
   * заявку стоила бы полусотни запросов на список.
   */
  placeConfirmation: PlaceConfirmation | null,
  /**
   * Формат действующей ревизии объёма работ (Р5 плана освобождения): `null` — ревизий у заявки нет
   * вовсе, и планка закрывающего документа у неё сегодняшняя. Приходит снимком пакетной догрузки по
   * той же причине, что и подтверждение места: строка на заявку стоила бы полусотни запросов на
   * список.
   */
  estimateFormat: ServiceEstimateFormat | null,
  /**
   * Заявление об освобождении от подписи и его исход (Р3 плана освобождения): `null` — по этой
   * заявке его не делали. Приходит снимком той же пакетной догрузки, что формат ревизии рядом.
   */
  exemption: ServiceRequestEstimateExemptionDto | null,
  /**
   * Спор об освобождении и его исход (Р9 плана освобождения): `null` — спора по заявке не было ни
   * разу. Приходит снимком той же пакетной догрузки, что формат ревизии и заявление рядом.
   */
  dispute: ServiceRequestEstimateDisputeDto | null,
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
    /**
     * Сторона заказчика ЭТОГО читателя (Н8) — второй признак, которым портал зовёт
     * `canChangeRequestAsCustomer`: первым идёт авторство, и оно приходит сводкой обсуждения.
     * Считает сервер тем же предикатом, что и область видимости, а портал правило не
     * воспроизводит — иначе у «моей заявки» завелось бы два ответа, и разошлись бы они молча.
     */
    inCustomerScope,
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
            /*
             * Единственное поле блока, приходящее из справочника, а не из снимка: срок гарантии
             * живёт в карточке и меняется после заведения заявки (почему не снимок и почему не
             * второй запрос — при самом поле в `ServiceRequestEquipmentDto`).
             *
             * И ровно поэтому оно ЗАКРЫТО ТОМУ, КОМУ ЗАКРЫТ СПРАВОЧНИК (решение владельца
             * 04.09.2026): снимок заявки подрядчик видит по праву — он по нему и едет чинить, — а
             * живая колонка парка ему не полагается. Гейт стоит здесь, в единственном месте, где
             * блок предмета собирается, а не в карте аудиторий (ADR 0160): та отвечает про деньги
             * этой заявки и считается по правам заявки, здесь же спрашивается право справочника —
             * другой вопрос и другой источник ответа. Разбор альтернатив («третья аудитория» и
             * «вторая карта видимости») — при самом поле в контрактах.
             *
             * Без `??`: колонка справочника необязательна, и `null` здесь — её собственное «срок
             * не заведён», а не следствие соединения. Подменять его пустой строкой или датой было
             * бы выдуманным ответом там, где честный ответ — «не знаем». Закрытому читателю
             * приезжает тот же `null`, и это не двусмысленность, а её отсутствие: обоим состояниям
             * портал рисует прочерк, то есть молчит, — тогда как выдуманная дата или пустая строка
             * заставили бы его отвечать за сервер.
             */
            warrantyUntil: seesEquipmentDirectory ? row.equipmentWarrantyUntil : null,
          },
    /**
     * ТРЕТИЙ СПОСОБ НАЗВАТЬ ПРЕДМЕТ: сообщение об аппарате, которого в справочнике ещё нет (план
     * `docs/office-equipment-candidate-plan.md`, Р5, Р15, §9). `null` — предмет обычный: карточка
     * парка либо заявка без аппарата вовсе.
     *
     * ПРИЗНАК — СОЕДИНЕНИЕ, А НЕ КОЛОНКА ЗАЯВКИ, и здесь это не то же самое, что у аппарата выше.
     * У аппарата в самой заявке лежит снимок (имя, оба номера, место), и спрашивать его наличие
     * надо у заявки; у кандидата снимка нет вовсе — ВСЕ поля блока приходят из соединённой строки
     * одним куском. Спроси мы `r.equipmentCandidateId`, пришлось бы утверждать «раз ссылка есть,
     * то и строка пришла» тремя восклицательными знаками — то есть допустить ответ «сообщение
     * есть, а модели у него нет». Ровно тот же довод, что у блока площадки ниже.
     *
     * БЛОК НЕ ЗАКРЫТ НИ ПРАВОМ СПРАВОЧНИКА, НИ АУДИТОРИЕЙ, и это решение, а не пропущенный гейт.
     * Соседнее поле `warrantyUntil` закрыто `officeEquipment.read` — но оно приходит из ЖИВОЙ
     * карточки парка, а кандидат записью справочника не является вовсе (Р1): он предмет самой
     * заявки, живущий в своей таблице. Тот же гейт здесь погасил бы блок у подрядчика, которому
     * справочник закрыт намеренно (`COUNTERPARTY_TYPE_PERMISSIONS.service`) и который поедет на
     * этот аппарат смотреть, и у автора сообщения, которому адресована причина отказа (Р15). Оба
     * остались бы с заявкой без предмета: `equipment` у неё `null` по построению.
     *
     * Проекция по аудиториям блок тоже не режет (`SERVICE_REQUEST_FIELD_AUDIENCE`, строка
     * `equipmentCandidate`): карта отвечает про ДЕНЬГИ заявки, а в блоке нет ни одной цифры —
     * заявленная модель, два номера с шильдика, состояние проверки и слова отказа.
     */
    equipmentCandidate:
      row.candidateId === null
        ? null
        : {
            id: row.candidateId,
            status: row.candidateStatus!,
            declaredModel: row.candidateDeclaredModel!,
            // Номера непусты не оба: `…_identity_check` требует хотя бы один, второй остаётся
            // пустой СТРОКОЙ — колонки кандидата `NOT NULL`. Восклицательный знак здесь про
            // соединение («строка пришла»), а не про значение.
            serialNumber: row.candidateSerialNumber!,
            inventoryNumber: row.candidateInventoryNumber!,
            decisionReason: row.candidateDecisionReason!,
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
      row.equipmentCardObjectId !== r.equipmentObjectId &&
      /*
       * ТРЕТИЙ ЧЛЕН (план перемещения, Р8; находка Н6 того же плана): расхождение считается
       * неразобранным, только пока по заявке нет подтверждающего перемещения. Без него заявка, у
       * которой аппарат нашёлся В ТРЕТЬЕМ месте, висела бы в очереди ИТ-службы до самого закрытия:
       * снимок «B» так и не сравнялся бы с карточкой «C», хотя разбор состоялся. Флагом, а не
       * фактом перемещения по заявке: «увезли в сервис» — тоже строка журнала, но она не отвечает
       * на вопрос, где аппарат стоит на самом деле.
       */
      placeConfirmation === null,
    objectMismatchResolvedBy: placeConfirmation,
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
    ...(repeat ? { repeat } : {}),
    estimateRevision: r.estimateRevision,
    /**
     * ЧЕМ ПРЕДЪЯВЛЕН ОБЪЁМ РАБОТ (Р4, Р5): строками, документом либо гарантийным ремонтом. `null` —
     * ревизий у заявки нет (смету не предъявляли либо её сбросило переназначение), и читается это
     * как планка наследия: закрывает акт, счёт или гарантийный талон.
     *
     * Полем DTO, а не выводом портала из состава: у документной ревизии строк нет вовсе, и «строк
     * ноль» означало бы сразу и документную подачу, и пустой черновик. От формата зависит, какая
     * бумага закрывает заявку, — ошибка в нём открывает дверь, а не портит надпись.
     */
    estimateFormat,
    /**
     * Непогашенное предъявление (Р2) — то, что означала «Смета на согласовании». Полем DTO, а не
     * выводом портала из даты: по нему портал считает доступность четырёх действий (согласовать,
     * вернуть в правку, предъявить заново, переназначить), и посчитанный им по-своему ответ
     * разошёлся бы с сервером молча.
     */
    estimatePendingRevision: r.estimatePendingRevision,
    /**
     * ЧЕМ ОТКРЫТО ОЖИДАНИЕ ПОДПИСИ (Р9): предъявлением (`submit`) либо исходом разрешённого спора
     * (`dispute`). `null` — ожидания нет вовсе либо его открыл старый код, не знавший про
     * происхождение; читается такое значение как `submit` — тем же правилом, что и в базе.
     *
     * Полем DTO, а не выводом портала: этим признаком `canApproveServiceEstimate` решает, пускать ли
     * подпись в «Решена», и портал зовёт тот же предикат теми же полями.
     */
    estimatePendingSource: r.estimatePendingSource,
    /**
     * Заявление об освобождении от подписи (Р3, Р13) — одна из четырёх мер контроля постфактум:
     * карточка обязана сказать словами, почему по заявке нет подписи («Принято без согласования»)
     * либо почему её всё-таки ждут («Заявлено, ждём подписи»).
     */
    exemption,
    /**
     * СПОР ОБ ОСВОБОЖДЕНИИ (Р9) — поле карточки, а не вывод портала из причины заморозки. Признак
     * «спор идёт» портал считает предикатами `canOpenServiceEstimateDispute` и
     * `canResolveServiceEstimateDispute`, а им нужен готовый `disputeOpen`: вывести его из
     * `holdReason` — значит угадывать состояние по свободному тексту, который пишет человек.
     *
     * РАЗРЕШЁННЫЙ СПОР ОСТАЁТСЯ В КАРТОЧКЕ: он единственный объясняет и второе окно приёмки, и
     * подпись, собранную уже в «Решена», — ровно то, ради чего поле и заводили.
     */
    dispute,
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
            /*
             * ЧЕМ ПОСТАВЛЕНА ПОДПИСЬ (Р11) — полем, а не выводом портала из пустого автора. Без него
             * карточка читает подпись как человеческую ВСЕГДА (`serviceEstimateApprovalSourceOf`
             * так и написана: пусто = `human`), то есть показывает подпись под автопринятием —
             * ровно то обвинение, от которого правило и оберегает. И тем же признаком считается
             * «освобождение применено» (`ServiceEstimateDisputeFacts.exemptionApplied`): без него
             * портал не может позвать `canOpenServiceEstimateDispute` — вывести источник подписи из
             * карточки больше неоткуда.
             */
            source: r.estimateApprovalSource,
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
  /*
   * Признак повторного обращения считается ОДНИМ запросом на страницу и идёт в общий `Promise.all`:
   * от остальных блоков он не зависит вовсе. Окно у каждой строки своё — от её собственного
   * `created_at`, — поэтому builder берёт страницу списком троек и считает боковым соединением;
   * группировка по аппарату приписала бы прошлогодней заявке свежий счёт (план повторов, Р6).
   * При выключенном окне карта приходит пустой, не потревожив базу.
   */
  const [
    items,
    fileMap,
    executorMap,
    consumableMap,
    repeatMap,
    placeMap,
    formatMap,
    exemptionMap,
    disputeMap,
  ] = await Promise.all([
    itemsByRequest(ids),
    filesByRequest(ids),
    executorsByRequest(ids),
    consumablesByRequest(ids),
    serviceRequestRepeatByRequest(
      p,
      rows.map((row) => row.r),
    ),
    // Подтверждения заявленного места — тем же пакетным приёмом и по той же причине (Р8).
    confirmedPlaceByRequest(ids),
    /*
     * Формат действующей ревизии (Р5) — тоже одним запросом на страницу: его спрашивает планка
     * закрывающего документа, то есть портал зовёт её на каждой строке списка, и строка на заявку
     * превратила бы горячий путь в полсотни запросов.
     */
    activeEstimateFormatByRequest(ids),
    /*
     * Заявления об освобождении — тем же пакетным приёмом: тег «принято без согласования» стоит в
     * строке СПИСКА (Р13), то есть вопрос задают на каждой из полусотни строк страницы.
     */
    estimateExemptionByRequest(ids),
    /*
     * Споры — тем же пакетным приёмом и по той же причине: признак «по заявке идёт спор» стоит в
     * строке СПИСКА, и вопрос задаётся на каждой из полусотни строк страницы.
     */
    estimateDisputeByRequest(ids),
  ]);
  const chatMap = await chatSummaryByRequest(
    p,
    rows.map((row) => ({
      row: row.r,
      executorIds: (executorMap.get(row.r.id) ?? []).map((e) => e.userId),
    })),
  );
  /**
   * Открыт ли читателю справочник парка — вопрос ОДНОГО права и всей страницы сразу (решение
   * владельца 04.09.2026). Им закрывается единственное поле блока предмета, приходящее из живой
   * карточки, а не из снимка заявки (`warrantyUntil`).
   *
   * СЧИТАЕТСЯ ОДИН РАЗ, А НЕ НА СТРОКУ, в отличие от аудитории: аудитория — свойство ПАРЫ «человек
   * ↔ эта заявка» (назначение открывает деньги ровно одной строки), а «открыт ли справочник» —
   * свойство одного читателя, и одинаково для всех пятидесяти строк страницы.
   *
   * ОБЛАСТЬ СПРАВОЧНИКА ЗДЕСЬ НЕ СПРАШИВАЕТСЯ, и это решение. Область отвечает на вопрос «какие
   * карточки читатель НАХОДИТ», а здесь ничего не ищут: карточку назвала предметом заявка, которая
   * читателю уже видна, и её реквизиты он видит снимком целиком — имя, оба номера и место. Довесок
   * `officeEquipmentScopeWhere` на каждую строку означал бы второй предикат области в выдаче
   * списка, расходящийся с предикатом видимости заявок молча и в ту сторону, где часть строк
   * замолкает без причины, — ровно ту болезнь, от которой Ф3 колонку и лечил.
   *
   * Признак расхождения площадок (`objectMismatch`) правом НЕ закрывается: он не выдаёт значения
   * справочника вовсе — это факт о самой заявке («снимок разошёлся с картотекой и не устранён»), и
   * читает его в первую очередь тот, кто аппарат повезёт.
   */
  const seesEquipmentDirectory = can(p, 'officeEquipment.read');
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
      seesEquipmentDirectory,
      /*
       * Сторона заказчика — свойство пары «человек ↔ эта заявка», как и аудитория рядом, и
       * считается тем же предикатом, что область видимости и подсветка адресата «Заявителю»
       * (Н8). Второго похода в базу здесь нет: обе отдельские колонки и площадка уже в строке.
       */
      inServiceRequestCustomerScope(p, {
        objectId: row.r.equipmentObjectId,
        customerDepartmentId: row.r.customerDepartmentId,
        equipmentDepartmentId: row.r.equipmentDepartmentId,
      }),
      repeatMap.get(row.r.id),
      placeMap.get(row.r.id) ?? null,
      // Ревизий у заявки нет — в карте нет и ключа: `null` здесь и означает планку наследия.
      formatMap.get(row.r.id) ?? null,
      // Заявления не было — ключа в карте нет: `null` означает «освобождение не заявляли», а не
      // «не посчитали».
      exemptionMap.get(row.r.id) ?? null,
      // Спора не было ни разу — ключа в карте нет, и `null` читается так же: «не спорили», а не
      // «не посчитали».
      disputeMap.get(row.r.id) ?? null,
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
 * Строка назначения существует — **голый факт, без гейта по праву**.
 *
 * Отделена от `isNamedExecutorHere` ниже потому, что гейт у двух областей разный, а запрос один.
 * Прежнее правило видимости спрашивает `serviceRequests.execute` (И1), развилка Р3 не спрашивает
 * ничего: держатель одного ИТ-набора этого права не имеет вовсе (Н2 плана свободного объёма
 * работ), а назначенные ему заявки ответ В3 обещает ему прямо. Скопируй мы запрос под второй гейт —
 * «назначен» означало бы разное в двух соседних строках одного модуля.
 *
 * Исполнителем передаётся `tx` там, где вопрос задан внутри транзакции: спросить его через общий
 * пул значило бы занять второе соединение, не отпустив первое, — на исчерпанном пуле это взаимная
 * блокировка, а не лишний запрос.
 */
async function namedExecutorRowExists(
  p: Principal,
  requestId: string,
  exec: typeof db | Tx = db,
): Promise<boolean> {
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
 * След снятия: субъекта с этой заявки когда-то сняли (`service_request_past_executors`, Р5).
 *
 * Спрашивается ТОЛЬКО областью чтения и только у исполнительского профиля при включённом рубильнике
 * — то есть в одной ветке одной развилки. Область действий о следе не знает намеренно: бывший
 * исполнитель смотрит и пишет в чат, но не действует (В11).
 *
 * Запрос закрывается индексом `service_request_past_executors_user_idx` (`user_id, request_id`) без
 * обращения к таблице; `tx` передаётся по той же причине, что и соседу выше.
 */
async function pastExecutorRowExists(
  p: Principal,
  requestId: string,
  exec: typeof db | Tx = db,
): Promise<boolean> {
  const [past] = await exec
    .select({ userId: serviceRequestPastExecutors.userId })
    .from(serviceRequestPastExecutors)
    .where(
      and(
        eq(serviceRequestPastExecutors.requestId, requestId),
        eq(serviceRequestPastExecutors.userId, p.id),
      ),
    )
    .limit(1);
  return !!past;
}

/**
 * Субъект значится поимённым исполнителем этой заявки — половина признака `isNamedExecutor` в
 * `executorAssignment` ниже: один вопрос, один запрос, одно место.
 *
 * Право спрашивается ПЕРЕД базой, и это не экономия: строка назначения переживает отзыв набора
 * (по ней написана переписка и подписаны бумаги, стирать её нельзя), поэтому «назначен» без
 * действующего `serviceRequests.execute` не значит ничего — ни для видимости, ни для хода (И1).
 *
 * Тот же гейт для ОБЛАСТИ ЧТЕНИЯ переехал внутрь `assertServiceRequestVisible` (Р3): там он стоит
 * рядом с веткой, у которой гейта нет, и обе видны одним взглядом.
 */
async function isNamedExecutorHere(
  p: Principal,
  requestId: string,
  exec: typeof db | Tx = db,
): Promise<boolean> {
  if (!can(p, 'serviceRequests.execute')) return false;
  return namedExecutorRowExists(p, requestId, exec);
}

/**
 * Признаки назначения одним набором — и **с памятью**: обе области спрашивают одну и ту же строку
 * назначения (чтение — расширением, действия — условием), и без памяти общий вход изменяющих ручек
 * сходил бы за ней дважды на каждый запрос.
 *
 * Память живёт ровно на время одного вызова: она хранит обещание, а не ответ, поэтому параллельные
 * ветки одного обработчика делят один поход, а следующий запрос читает состояние заново — назначение
 * между запросами успевают снять.
 */
function executorFactsOf(
  p: Principal,
  requestId: string,
  exec: typeof db | Tx = db,
): ServiceRequestExecutorFacts {
  let named: Promise<boolean> | null = null;
  let past: Promise<boolean> | null = null;
  return {
    isNamedExecutor: () => (named ??= namedExecutorRowExists(p, requestId, exec)),
    wasNamedExecutor: () => (past ??= pastExecutorRowExists(p, requestId, exec)),
  };
}

// ── След снятого исполнителя (план свободного объёма работ, Р5) ──

/**
 * Записать след снятия — **единственное место, где строка `service_request_past_executors`
 * появляется**, и зовут его все четыре ветки удаления назначения.
 *
 * ЗАЧЕМ СЛЕД. Снятие исполнителя удаляет строку назначения физически, и вместе с ней исчезала бы
 * заявка из области того, кто её вёл: переписка, документы и предыстория ремонта закрывались бы в
 * тот же миг. Ответ В6 заказчика от 09.09.2026 — «плюс заявки, с которых его сняли», — и держит
 * это обещание отдельная таблица, а не флаг в самом назначении: живое назначение читают 65 раз в
 * восьми файлах, и забытый `removed_at IS NULL` означал бы, что снятый продолжает получать задания.
 *
 * ЗОВЁТСЯ НЕПОСРЕДСТВЕННО ПЕРЕД `DELETE` И В ТОЙ ЖЕ ТРАНЗАКЦИИ. Логических путей снятия три —
 * сброс состава при отмене, переназначение и отказ исполнителя, — а веток `DELETE` четыре, потому
 * что отказ снимает либо свою строку, либо весь состав. Формулировка «в трёх местах» первой
 * редакции плана легко оставила бы четвёртую ветку без следа; порядок «сперва след, потом
 * удаление» тоже не косметика — читать снимаемых из уже опустевшей таблицы было бы нечем.
 *
 * ПОВТОР ОБНОВЛЯЕТ ДАТУ, А НЕ ЗАВОДИТ ВТОРУЮ СТРОКУ (первичный ключ — пара «заявка + учётка»):
 * цикл «сняли → назначили снова → сняли» отвечает на вопрос «этот человек её вёл» тем же одним
 * фактом. Истории всех снятий таблица не ведёт намеренно — на «кто и когда передал заявку»
 * отвечает аудит.
 *
 * BACKFILL НЕ ДЕЛАЕТСЯ И НЕ МОЖЕТ (Н13): старые строки назначений удалены физически, а аудит
 * `serviceRequest.reassign` хранит имена, а не идентификаторы. Семантика — «только вперёд, с даты
 * выката».
 */
async function markPastExecutors(
  tx: Tx,
  requestId: string,
  userIds: readonly string[],
  removedBy: string,
): Promise<void> {
  if (userIds.length === 0) return;
  await tx
    .insert(serviceRequestPastExecutors)
    .values(userIds.map((userId) => ({ requestId, userId, removedBy })))
    .onConflictDoUpdate({
      target: [serviceRequestPastExecutors.requestId, serviceRequestPastExecutors.userId],
      // Время берёт БАЗА, а не сервер: след — единственный факт этой строки, и часы приложения,
      // разъехавшиеся с базой, сделали бы «сняли раньше, чем назначили». Умолчание колонки такое же.
      set: { removedAt: sql`now()`, removedBy },
    });
}

/**
 * Тот же след, когда снимают ВЕСЬ состав: список снимаемых читается из самой таблицы назначений.
 *
 * Отдельной функцией, а не `INSERT ... SELECT`, потому что путей сюда два (сброс состава при отмене
 * и полный отказ администратора), и оба обязаны писать след одинаково; читающий запрос при этом
 * закрывается первичным ключом назначения и стоит меньше, чем разбор второй формы `INSERT`.
 */
async function markAllPastExecutors(tx: Tx, requestId: string, removedBy: string): Promise<void> {
  const rows = await tx
    .select({ userId: serviceRequestExecutors.userId })
    .from(serviceRequestExecutors)
    .where(eq(serviceRequestExecutors.requestId, requestId));
  await markPastExecutors(
    tx,
    requestId,
    rows.map((row) => row.userId),
    removedBy,
  );
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
  /**
   * Признаки назначения — параметром, если вызывающий уже их завёл. Ради общего входа изменяющих
   * ручек: он спрашивает одну и ту же строку назначения дважды — областью чтения и областью
   * действий, — и общая память превращает два похода в один.
   */
  facts: ServiceRequestExecutorFacts = executorFactsOf(p, row.id, exec),
): Promise<void> {
  await assertServiceRequestVisible(
    p,
    {
      id: row.id,
      objectId: row.equipmentObjectId,
      customerDepartmentId: row.customerDepartmentId,
      equipmentDepartmentId: row.equipmentDepartmentId,
      serviceCounterpartyId: row.serviceCounterpartyId,
      // Автор — ось области исполнительского профиля при включённом рубильнике (Р3, ответ В6).
      createdBy: row.createdBy,
    },
    facts,
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
 *
 * СТРАЖ СТОРОНЫ ЗАКАЗЧИКА СТОИТ ЗДЕСЬ, А НЕ В ЧЕТЫРЁХ РУЧКАХ ПООТДЕЛЬНОСТИ (план профилей
 * оргтехники, Р6). Правило сужает ровно одного субъекта — держателя набора «Заявитель» у роли без
 * оси, — и дверей у него сегодня четыре: правка «Новой», её удаление, подшивка и снятие своего
 * вложения. Расставленное по ручкам, оно жило бы в четырёх местах и приезжало бы в пятую ручку
 * только вместе с тем, кто про него вспомнит; на общем входе изменяющих ручек забыть его нельзя.
 * Прочих субъектов оно не касается вовсе — `actsAsRequestCustomer` отвечает им «да», — поэтому
 * общий вход ничего у них не отбирает.
 *
 * Читающие ручки сюда не ходят (кроме `GET /executor-candidates`, куда без права `assign` не
 * попасть): карточку, историю и ленту достаёт `loadRow` + `assertScope`, и глобальное ЧТЕНИЕ у
 * роли без оси остаётся прежним — это действующая модель, а не дыра (Т17).
 */
async function requireEditable(p: Principal, id: string): Promise<RequestRow> {
  const row = await loadRow(id);
  if (row.deletedAt) throw err.notFound(NOT_FOUND);
  const facts = executorFactsOf(p, row.id);
  await assertScope(p, row, db, facts);
  /**
   * **ОБЛАСТЬ ДЕЙСТВИЙ — ВТОРЫМ ВОПРОСОМ, СРАЗУ ЗА ОБЛАСТЬЮ ЧТЕНИЯ** (план свободного объёма работ,
   * Р7; ответ В11 заказчика от 09.09.2026). Стоит она здесь, а не в ручках, по той же причине, по
   * которой здесь стоит страж стороны заказчика: под общим входом живут правка, удаление, подшивка и
   * снятие документов, назначение, заморозка, отмена, объём работ и расходники — расставленное по
   * ручкам правило приезжало бы в следующую только вместе с тем, кто про него вспомнит.
   *
   * СУЖАЕТ ОНА ОДНУ КАТЕГОРИЮ — исполнительский профиль при включённом рубильнике: бывший
   * исполнитель заявку ЧИТАЕТ (след снятия расширил область чтения) и пишет в чат, а действовать по
   * ней больше не может. Всем остальным — обычному коллеге с ролью площадки, «Ведению»,
   * администратору, подрядчику — она отвечает «да» без единого условия, и общий вход у них ничего
   * не отбирает.
   *
   * ДЕЙСТВУЮЩЕГО НАЗНАЧЕННОГО ОНА ПРОПУСКАЕТ, и это условие связности с подшивкой: сисадмина штатно
   * назначают на заявки чужих площадок (ради этого у профиля второй набор), и акт по такой заявке он
   * обязан приложить. Признаки — общие с областью чтения (`facts`), так что второго похода в базу
   * тут не появляется.
   *
   * ПОРЯДОК: чтение → действия → сторона заказчика. Сперва «вижу ли я эту строку вообще», потом «в
   * моей ли она области действий», и только потом «моя ли это запись»: первые два вопроса про
   * область, третий — про сторону, и человеку полезнее узнать про область раньше.
   */
  await assertServiceRequestActionable(p, authorPlaceOf(row), facts.isNamedExecutor);
  assertActsAsRequestCustomer(p, authorPlaceOf(row));
  return row;
}

/**
 * Строка заявки в объёме, которым решается СТОРОНА ЗАКАЗЧИКА: адрес, автор и место (площадка плюс
 * обе отдельские колонки).
 *
 * Одним переводом на все двери, а не пятью объектными литералами по местам вызова: спрашивают его
 * теперь трое — общий вход изменяющих ручек и два стража распоряжения записью (Н8), — и
 * разложенный по вызовам он разъехался бы ровно там, где ошибка означает открытую дверь. Имя поля
 * `objectId` при этом переводится с `equipmentObjectId` именно здесь: в контрактах место заявки
 * называется по-своему, и знать об этом обязано одно место.
 */
function authorPlaceOf(row: RequestRow): ServiceRequestAuthorPlace {
  return {
    id: row.id,
    createdBy: row.createdBy,
    objectId: row.equipmentObjectId,
    customerDepartmentId: row.customerDepartmentId,
    equipmentDepartmentId: row.equipmentDepartmentId,
  };
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
 *
 * СОЕДИНЕНИЕ ПЕРЕДАЁТСЯ (Р4). Признаки, посчитанные общим пулом ДО транзакции, отвечают про
 * назначение, которое к `COMMIT` успевают снять: между чтением и записью помещается целое
 * переназначение. Спрошенные на `tx` после `lockRequest`, они читаются под той же блокировкой, что
 * и сама заявка, — и снятое назначение уже не отвечает «назначен». Образец тот же, что у чата
 * (`postChatMessage`), и умолчание `db` оставлено ручкам, которые решают вне транзакции.
 */
async function executorAssignment(
  p: Principal,
  row: RequestRow,
  exec: typeof db | Tx = db,
): Promise<ServiceExecutorAssignment> {
  const actsForAssignedCounterparty =
    row.serviceCounterpartyId !== null && row.serviceCounterpartyId === p.counterpartyId;
  // Поимённая строка — тем же запросом и тем же условием, что у третьей оси видимости: сторона и
  // область обязаны отвечать про назначение одинаково, иначе человек видел бы заявку, в которой ему
  // нечего делать, — или наоборот.
  return {
    actsForAssignedCounterparty,
    isNamedExecutor: await isNamedExecutorHere(p, row.id, exec),
  };
}

/**
 * СУЖЕНИЕ МАССОВОГО «ПРИНЯТЬ В РАБОТУ» (Р5): пакетный `start` открыт ТОЛЬКО назначенным.
 *
 * У одиночной ручки третья ветка `actsAsServiceExecutor` открывает ход держателю
 * `serviceRequests.estimate` без назначения на заявку — «Ведению», разбирающему застрявшее. В
 * массовом режиме такой субъект набрал бы пятьдесят чужих назначенных заявок и взял их в работу
 * одним нажатием, не будучи исполнителем ни одной, — поэтому здесь спрашивается сам ФАКТ
 * назначения, а не право.
 *
 * Прав это ни у кого не отнимает: одиночная кнопка в карточке работает по-прежнему, и сужение
 * названо планом, а не спрятано в коде. Стоит оно ДО шага и после общего входа: область и сторона
 * заказчика уже спрошены `requireEditable`, а «назначен ли» — вопрос строки исполнителей.
 */
async function assertBulkStartAssignment(p: Principal, id: string): Promise<void> {
  const row = await requireEditable(p, id);
  const assignment = await executorAssignment(p, row);
  if (!assignment.actsForAssignedCounterparty && !assignment.isNamedExecutor) {
    throw err.forbidden(
      'Массово в работу берут только назначенные исполнители — эту заявку откройте карточкой',
    );
  }
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
  /**
   * Заявка, к которой постучались, — только ради журнала отказов (Р6). Приходит адресом запроса, а
   * не строкой: этот отсев работает ДО чтения заявки, и другого способа назвать её здесь нет. В
   * модуле `:id` — всегда заявка, так что это она и есть.
   */
  requestId: string,
  to: ServiceRequestStatus,
  from: readonly ServiceRequestStatus[] = SERVICE_REQUEST_STATUSES,
): void {
  if (from.some((status) => canTransitionServiceStatus(status, to, p, MAYBE_ASSIGNED))) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw serviceDenied.side(
    `${who} не переводит заявку в «${serviceRequestStatusLabels[to]}» — это шаг другой стороны`,
    requestId,
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
  requestId: string,
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
  assignment?: ServiceExecutorAssignment,
): void {
  if (canTransitionServiceStatus(from, to, p, assignment)) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw serviceDenied.side(
    `${who} не может перевести заявку «${serviceRequestStatusLabels[from]}» → «${serviceRequestStatusLabels[to]}»`,
    requestId,
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
async function assertExecutorSide(
  p: Principal,
  row: RequestRow,
  action: string,
  exec: typeof db | Tx = db,
): Promise<void> {
  if (isServiceExecutor(p, await executorAssignment(p, row, exec))) return;
  if (can(p, 'serviceRequests.estimate')) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw serviceDenied.side(`${who} не ${action} — это шаг назначенного исполнителя`, row.id);
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
async function assertConsumableIssuer(
  p: Principal,
  row: RequestRow,
  exec: typeof db | Tx = db,
): Promise<void> {
  if (isServiceExecutor(p, await executorAssignment(p, row, exec))) return;
  if (can(p, 'serviceRequests.status')) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw serviceDenied.side(
    `${who} не отмечает выдачу по этой заявке — это шаг назначенного исполнителя`,
    row.id,
  );
}

/**
 * Сторона «Ведения» у двери, где своего хода нет вовсе, — повтор служебного письма (план аудита
 * исполнителей, Р9; находка Н8).
 *
 * ЗАЧЕМ ОНА ЗДЕСЬ. Право маршрута (`serviceRequests.status`) стороны не задаёт: оно есть и у типа
 * контрагента `service` — подрядчику оно открывает ЕГО половину цикла, — то есть держатель
 * назначенной заявки мог бы САМ инициировать повтор служебной рассылки о ней. Сегодня его
 * останавливает область (повторяемых событий два, и в обоих подрядчика на заявке уже нет по
 * построению), но это совпадение построения, а не запрет: появись третье повторяемое событие,
 * сохраняющее подрядчика, — и дверь открылась бы молча.
 *
 * ПОЧЕМУ КОД НАБОРА, А НЕ ПРАВО. Правило то же и записано один раз в контрактах
 * (`actsAsServiceOperator`): администратор либо держатель `office_equipment_operator`, и ни при
 * каких условиях не подрядчик. Спрашивается оно у самого субъекта — коды наборов принципал читает
 * из БД на каждом запросе, — поэтому реестр профилей соседнего плана здесь не нужен и ждать его
 * незачем. Ни назначение, ни `serviceRequests.execute` двери не открывают: письмо зовёт службу
 * РАЗОБРАТЬ заявку, и повторяет его тот, кто её ведёт.
 *
 * СТОИТ ПОСЛЕ ОБЛАСТИ, как и всякая сторона в модуле: сперва «ваша ли это заявка», потом «ваш ли
 * это шаг». Порядок виден в отказах — подрядчику по чужой заявке отвечает область, по своей
 * назначенной — эта проверка, — и оба отказа попадают в журнал `serviceRequest.access_denied`
 * своими причинами (Р6).
 */
function assertServiceOperatorSide(p: Principal, requestId: string, action: string): void {
  if (actsAsServiceOperator(p)) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw serviceDenied.side(`${who} не ${action} — это шаг ведущего заявку`, requestId);
}

/**
 * ПОЛОЖЕН ЛИ ЭТОЙ ЗАЯВКЕ ОБЪЁМ РАБОТ ВООБЩЕ — единственный вопрос о ПРЕДМЕТЕ во всём сметном
 * круге. Оснований у отказа два, и оба про заявку, а не про человека перед ней.
 *
 * Первое — ВИД. Смета — принадлежность ремонта, и у заявки на расходники её нет вовсе (план §6.2:
 * «та же таблица без строк сметы и без визы ИТ»).
 *
 * Второе — ИСПОЛНИТЕЛЬ (Р5 и §8, фаза C, плана
 * `docs/office-equipment-card-and-list-cleanup-plan.md`): заявку без подрядчика ведёт свой
 * сотрудник, и цен по ней не бывает — ни предъявлять, ни согласовывать, ни возвращать в правку
 * нечего. Признак спрашивается функцией контрактов `serviceRequestNeedsEstimate`, а не строкой
 * `serviceCounterpartyId === null` по месту: то же правило читают предикаты кнопок, вкладка,
 * закрытие работ и очереди, и разъехавшись здесь, оно первым делом показало бы кнопку, на которую
 * сервер отвечает отказом.
 *
 * ПОЧЕМУ ОДНА ФУНКЦИЯ НА ЧЕТЫРЕ ДВЕРИ, А НЕ ПРОВЕРКА ПО РУЧКАМ. Разложенное по четырём
 * обработчикам, правило разъехалось бы с первой же правкой — и разъехалось бы молча: половина
 * дверей осталась бы открытой ровно для того сценария, ради которого волна и делалась.
 *
 * И ни одну из четырёх нельзя пропустить как «всё равно недостижимую». У расходников согласование
 * и возврат в правку и правда заперты соседним условием — предъявления у них не бывает, — но у
 * ВНУТРЕННЕЙ заявки оно бывает: заявки, заведённые до этой волны, несут историческое
 * `estimate_pending_revision`, и обе «глубокие» двери открываются для них по-настоящему. Именно
 * такую заявку «Ведение» и увидело бы в очереди подписи, отвечай ей сервер по состоянию, а не по
 * предмету.
 *
 * ПОРЯДОК ОСНОВАНИЙ ЗНАЧИМ: вид спрашивается первым. Признак Р4 ложен и у расходников — он
 * начинается с `kind === 'repair'`, — и спроси мы его раньше, заявка на расходники получила бы
 * ответ «заявку ведёт свой сотрудник» вместо своего, и человек искал бы у неё подрядчика.
 *
 * 422, А НЕ 403, И ЭТО РАЗНЫЕ ВЕЩИ. Право у человека есть, и просить его не надо: негоден
 * ПРЕДМЕТ — по этой заявке объём работ не составляют. Ответь мы 403, держатель права пошёл бы
 * добывать себе полномочие, которого у него и так достаточно, а «Ведение» искало бы дыру в
 * матрице доступа вместо того, чтобы просто закрыть работы датой.
 *
 * СТОРОНА СПРАШИВАЕТСЯ РАНЬШЕ ПРЕДМЕТА — там, где сторона у ручки своя: `PUT /:id/estimate`
 * зовёт стража ПОСЛЕ `assertExecutorSide`. Иначе держатель `serviceRequests.execute`, не
 * назначенный на заявку, читал бы у чужой внутренней заявки «объём работ не составляют» вместо
 * «это шаг назначенного исполнителя» — то есть узнавал бы о состоянии заявки, к которой его не
 * подпускают, и терял бы настоящую причину отказа. Назначенному же исполнителю отвечает именно
 * предмет: сторона у него в порядке, а составлять по такой заявке нечего.
 *
 * ВРЕМЕННОЙ ТЕРПИМОСТИ ФАЗЫ A ЗДЕСЬ БОЛЬШЕ НЕТ, И РАЗНОБОЯ ОТВЕТОВ ТОЖЕ. Пока раздавалась старая
 * сборка портала, внутренняя заявка отбивалась чем придётся: предъявление — 403 предиката
 * контрактов, согласование и возврат в правку — 422 «объём работ не предъявлен»/«снимать нечего»,
 * а `PUT /:id/estimate` не отбивалась вовсе (своего предиката у неё нет — редактор портал
 * открывает через `canSubmitServiceEstimate`) и молча писала в заявку строки с ценами. Три разных
 * ответа на один вопрос — и ни один не называл причину. Теперь причина одна и названа: залежавшаяся
 * вкладка получает объяснимый 422 и после обновления страницы переходит на новый сценарий.
 */
function assertEstimateApplies(row: RequestRow, action: string): void {
  if (row.kind === 'consumable') {
    throw err.unprocessable(`Заявка на расходники объёма работ не имеет: ${action} нечего`, {
      kind: 'Не тот вид заявки',
    });
  }
  if (!serviceRequestNeedsEstimate(row)) {
    // Помечается не `kind` (вид у заявки верный — ремонт), а колонка, которой решается правило:
    // подрядчика на заявке нет. Соври мы полем, человек искал бы ошибку в виде заявки.
    throw err.unprocessable('Заявку ведёт свой сотрудник — объём работ по ней не составляют', {
      serviceCounterpartyId: 'Подрядчика на заявке нет',
    });
  }
}

function assertCanHold(p: Principal, action: string): void {
  if (canHoldService(p)) return;
  const who = p.role ? roleLabels[p.role] : 'Учётная запись';
  throw err.forbidden(`${who} не ${action} — это шаг того, кто её ведёт`);
}

// ── Спор об освобождении от подписи (Р9) ──

/** Второй открытый спор по заявке — один текст на проверку под блокировкой и на разбор `23505`. */
function disputeAlreadyOpen(): AppError {
  return err.conflict(
    'По заявке уже идёт спор об освобождении от подписи — его закрывают решением по спору',
    { fields: { status: 'По заявке идёт спор' } },
  );
}

/**
 * Гонка двух открытий доходит до частичного уникального индекса: проверка под блокировкой её не
 * ловит лишь в одном случае — если блокировку заявки взял параллельный запрос и отпустил раньше нас.
 * Без разбора `23505` второй человек получил бы 500 там, где ему нужно то же самое «спор уже идёт»
 * (тем же приёмом разбирается занятый код полномочия в `routes/grants.ts`).
 */
function asDisputeOpenConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'service_request_estimate_disputes_open_unique') {
    return disputeAlreadyOpen();
  }
  return e;
}

/**
 * ОТКРЫТЫЙ СПОР ЗАЯВКИ — строкой либо `null`. Открытый бывает ровно один: это держит частичный
 * уникальный индекс `service_request_estimate_disputes_open_unique`, и запрос поэтому берёт первую
 * найденную, не сортируя.
 *
 * Читается ПОД БЛОКИРОВКОЙ ЗАЯВКИ (`lockRequest` первым шагом транзакции), и это не перестраховка:
 * и открытие, и разрешение спора меняют ту же строку заявки, поэтому блокировка сериализует их
 * между собой — прочитанное до транзакции состояние к `COMMIT` устаревает ровно в той гонке, из-за
 * которой проверка и стоит.
 */
async function openDisputeOf(
  exec: Tx,
  requestId: string,
): Promise<{ id: string; revision: number } | null> {
  const [row] = await exec
    .select({
      id: serviceRequestEstimateDisputes.id,
      revision: serviceRequestEstimateDisputes.revision,
    })
    .from(serviceRequestEstimateDisputes)
    .where(
      and(
        eq(serviceRequestEstimateDisputes.requestId, requestId),
        eq(serviceRequestEstimateDisputes.state, 'open'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * ПРИЗНАКИ, КОТОРЫМИ РЕШАЕТСЯ СПОР (`ServiceEstimateDisputeFacts` контрактов): предикат принимает их
 * готовыми, потому что спрашивают его двое — сервер по базе и портал по карточке.
 *
 * «ОСВОБОЖДЕНИЕ ПРИМЕНЕНО» СКЛАДЫВАЕТСЯ ИЗ ТРЁХ УСЛОВИЙ, а не из одной строки следа, и каждое
 * отсекает своё состояние:
 *
 *   · строка следа с исходом `applied` ПО ДЕЙСТВУЮЩЕЙ ревизии — наблюдённое заявление (`observed`,
 *     выключенный рубильник) освобождением не является вовсе, а заявление по прошлой ревизии снято
 *     переизданием;
 *   · подпись стоит под действующей ревизией — её мог снять возврат в правку (`/estimate/reopen`),
 *     который ревизию НЕ поднимает: строка следа при этом остаётся, и спорить было бы не с чем;
 *   · источник подписи — `auto`. Это и есть ответ на «по подписанному человеком объёму работ спорят
 *     обычным возвратом в правку»: после исхода `require_signature` человек подписывает ту же
 *     ревизию, след `applied` остаётся на месте, и без этого слагаемого по заявке открывали бы спор
 *     по кругу — оспаривая подпись, которую сами же и потребовали.
 */
async function disputeFactsOf(exec: Tx, row: RequestRow): Promise<ServiceEstimateDisputeFacts> {
  const [applied] = await exec
    .select({ revision: serviceRequestEstimateExemptions.revision })
    .from(serviceRequestEstimateExemptions)
    .where(
      and(
        eq(serviceRequestEstimateExemptions.requestId, row.id),
        eq(serviceRequestEstimateExemptions.revision, row.estimateRevision),
        eq(serviceRequestEstimateExemptions.outcome, 'applied'),
      ),
    )
    .limit(1);
  return {
    exemptionApplied:
      applied !== undefined &&
      row.estimateApprovalSource === 'auto' &&
      row.approvedEstimateRevision === row.estimateRevision,
    disputeOpen: (await openDisputeOf(exec, row.id)) !== null,
  };
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
    /**
     * Сток письма, если переход идёт строкой пачки (план массовых действий, Р10). Приезжает из
     * `bulk.runTx` доменного шага вместе с транзакцией и уходит построителю письма: тот кладёт
     * готовое намерение в `service_request_bulk_mail_items` вместо строки очереди, а сводку по
     * пачке шлёт финализатор — одну на пару «адресат + аудитория».
     *
     * Необязательный и по умолчанию пустой: одиночная ручка о пачке не знает и ведёт себя ровно как
     * до неё. Проекция аудитории при этом происходит ЗДЕСЬ, на строке, — восстановить её на
     * финализации из полной заявки нельзя.
     */
    bulkMail?: ServiceMailBulkSink | null;
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
    // След снятия — ПЕРВАЯ из четырёх веток удаления (Р5). Заявка, отменённая и потом возвращённая
    // в «Новую», остаётся видна тому, кто её вёл: переписку и документы по ней он писал, и закрывать
    // их отменой нельзя. Пишется до `DELETE` — после него читать снимаемых уже неоткуда.
    await markAllPastExecutors(tx, row.id, actor.id);
    // Оба слоя разом (Н5): «заявка снова ничья» означает и снятого подрядчика, и пустой список
    // поимённых. Снимай мы только колонку — отменённая заявка осталась бы за своим сисадмином, а
    // отложенный триггер `service_requests_executor_present` этого не заметил бы: у неё
    // исполнитель формально есть.
    await tx.delete(serviceRequestExecutors).where(eq(serviceRequestExecutors.requestId, row.id));
  }
  if (reset.estimate) {
    await assertEstimateReplaceable(tx, row.id);
    await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, row.id));
    /*
     * Ревизии уходят вместе со строками, и это ОБЯЗАТЕЛЬНАЯ часть сброса, а не уборка (Р4): номер
     * обнуляется строкой ниже, то есть следующее предъявление снова назовётся первым — и столкнулось
     * бы с прежней «ревизией 1» по первичному ключу. Почему именно `DELETE` и чего тут ждать на Э4 —
     * при самой `dropEstimateRevisions`.
     */
    await dropEstimateRevisions(tx, row.id);
    set.estimateRevision = 0;
    set.estimateSubmittedAt = null;
    set.estimatedTotalAmount = null;
    // Непогашенное предъявление гасится вместе со сметой, и не только ради очереди (Р2): ревизия
    // уходит в `0`, а оставленная pending-ревизия уронила бы саму запись —
    // `service_requests_estimate_pending_check` требует их равенства.
    set.estimatePendingRevision = null;
    // Происхождение ожидания гаснет ВМЕСТЕ с ожиданием (Н4 волны освобождения): оставленное
    // `dispute` у заявки без ожидания означало бы «подпись после спора разрешена», и подпись в
    // «Решена» открылась бы заявке, спора по которой больше нет.
    set.estimatePendingSource = null;
  }
  if (reset.approval) {
    set.approvedEstimateRevision = null;
    set.estimateApprovedBy = null;
    set.estimateApprovedAt = null;
    // Источник подписи — четвёртая колонка снимка (Р11), и гасится он во всех четырёх местах Н4.
    // Оставленный `auto` у заявки без подписи читался бы как «принято без согласования» — то есть
    // как обвинение, которого никто не выдвигал, — а при следующей человеческой подписи уронил бы
    // запись: `service_requests_estimate_approval_source_check` запрещает `auto` с автором.
    set.estimateApprovalSource = null;
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
    /*
     * ВИД ЗАМОРОЗКИ — ТРЕТЬИМ ЕЁ ПОЛЕМ (Р9 плана освобождения от согласования). Гаснет он здесь же и
     * на ЛЮБОМ выходе, потому что `service_requests_hold_kind_check` про статус ничего не знает
     * намеренно (окно выката: старый код возвращает заявку, про колонку не зная) — то есть оставленный
     * вид ошибкой БД не отзовётся, а тихо останется следом спора у заявки, спора по которой больше
     * нет. А по этому следу заперты возврат из заморозки и приёмка: заявка, разрешившая спор, была бы
     * заперта ими навсегда.
     */
    set.holdKind = null;
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
    bulkMail: params.bulkMail ?? null,
  });
  return { mail, mailFailed: mail?.outcome === 'mail_failed', clearedWarranties: warrantySnapshot };
}

/**
 * Подготовка письма перехода: какое событие ставит вход в этот статус и что о нём известно до
 * транзакции (§5.2). `null` — у перехода письма нет, и ручка обязана сказать это словом, а не
 * умолчанием: обязательный параметр `mail` у `applyTransition` для того и заведён.
 */
/**
 * Исходы, по которым письмо действительно НЕ дошло, — только они пишутся отдельной записью отказа.
 * `queued` очевиден, а `not_needed` и `event_off` — штатные состояния: письма не требовалось либо
 * событие выключено рубильником, и запись «не ушло» про них засоряла бы журнал ровно там, где его
 * читают на разборе «почему подрядчик не приехал» (§5.10).
 */
const FAILED_MAIL_OUTCOMES: ReadonlySet<ModuleMailOutcome> = new Set<ModuleMailOutcome>([
  'mail_failed',
  'channel_missing',
  'no_recipients',
  'mail_disabled',
]);

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
    /** Сток письма строки пачки; `null` — обычный путь одиночной ручки (Р10). */
    bulkMail?: ServiceMailBulkSink | null;
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
    bulk: params.bulkMail ?? null,
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
 * Кому разрешена подшивка этого вида — ОБА СЛОЯ, аудитория и сторона (ADR 0160 и план аудита
 * исполнителей, Р3). Статус здесь — «эффективный» (Р110): заморозка видов документов не меняет.
 *
 * Порядок проверок значим, и он же порядок ответов. Сперва два `403` — они окончательны: «этот вид
 * не ваш» не изменится ни от статуса, ни от повторной попытки, и добавлять к нему разбор статуса
 * значило бы рассказывать заявителю про жизнь документа, которого он не увидит. Затем прежние два
 * `422` — они про форму, их читает тот, кому вид разрешён, и действующие тесты проверяют оба текста.
 *
 * СЛОЁВ ДВА, И ОНИ ПРО РАЗНОЕ. Аудитория отвечает «видны ли этому читателю деньги заявки»
 * (`serviceRequests.finance` либо назначение), сторона — «его ли это бумага». Одной аудитории мало:
 * `finance` у ИТ-службы сквозной, и без второго слоя она подшивала бы акт к любой заявке компании,
 * снимая планку закрывающего документа за чужого подрядчика (Н2). Спрашиваются слои по одному
 * ровно ради текста отказа: слитые в один ответ, они называли бы стороне исполнителя чужую причину.
 *
 * Признаки назначения приходят посчитанными — и посчитанными ПОД БЛОКИРОВКОЙ (Р4): зовущая ручка
 * берёт `lockRequest` и передаёт сюда то, что видно внутри её транзакции.
 *
 * ТРЕТИЙ СЛОЙ — САМА ЗАЯВКА (Р5, Н17 плана `office-equipment-card-and-list-cleanup-plan.md`), и
 * приезжает он строкой, а не парой скаляров рядом со статусом: вид `estimate` разрешён политикой
 * всякому исполнителю в «В работе», но по внутреннему ремонту объёма работ не составляют вовсе — и
 * бумага с ценами подшивалась бы к заявке, у которой цен не бывает. Строка берётся ТА ЖЕ, что
 * прочитана под блокировкой: подрядчика с заявки снимают тем же окном, в котором грузят файл.
 */
function assertFileKindAllowed(
  p: Principal,
  request: Pick<RequestRow, 'id' | 'kind' | 'serviceCounterpartyId'>,
  status: ServiceRequestStatus,
  kind: ServiceFileKind,
  assignment: ServiceExecutorAssignment,
): void {
  const requestId = request.id;
  const audience = serviceRequestAudienceOf(p, assignment);
  if (!isServiceFileKindAttachable(kind, audience)) {
    throw serviceDenied.side(
      `«${serviceFileKindLabels[kind]}» к заявке прикладывает исполнитель, а не заявитель`,
      requestId,
    );
  }
  if (!canAttachServiceFileSide(kind, p, assignment)) {
    // Кто именно вправе — словами из той же таблицы: перечисли их здесь руками, и текст разошёлся
    // бы с правилом на первом же изменении матрицы.
    const who = serviceFileAttachingSides(kind)
      .map((side) => serviceFileAttachingSideLabels[side])
      .join(' или ');
    throw serviceDenied.side(
      `«${serviceFileKindLabels[kind]}» к заявке прикладывает ${who}`,
      requestId,
    );
  }
  // Формат действующей ревизии здесь не спрашивается НАМЕРЕННО: вопрос про сам вид бумаги — какую
  // вообще несут к закрытой заявке (Р16, Р29), — а не про то, закрывает ли этот файл эту заявку.
  // Половина правила в одиночку законна ровно в таких местах (см. `SERVICE_CLOSING_DOCUMENT_KINDS` в
  // контрактах), и переводить этот перечень на формат Э3 не должен: сузь его до акта — и обещанный
  // «счёт пришлю завтра» перестал бы подшиваться к принятой заявке.
  if (isServiceRequestClosed(status) && !SERVICE_CLOSING_DOCUMENT_KINDS.includes(kind)) {
    const closing = SERVICE_CLOSING_DOCUMENT_KINDS.map((k) => serviceFileKindLabels[k]).join(', ');
    throw err.unprocessable(
      `Закрытая заявка принимает только документы: ${closing.toLowerCase()}`,
      { kind: 'Заявка закрыта' },
    );
  }
  // Причина Р4 называется своими словами и ДО общего отказа по статусу: тот же `false` от
  // `canAttachServiceFile` иначе объяснил бы внутреннему исполнителю, что «в другом статусе
  // получится», — а не получится никогда, потому что этапа объёма работ у его заявки нет вовсе.
  // Отказ обязан отвечать той причиной, по которой его писали, иначе человек пойдёт ждать смены
  // статуса вместо того, чтобы подшить бумагу другим видом.
  if (kind === 'estimate' && !serviceRequestNeedsEstimate(request)) {
    throw err.unprocessable(
      `«${serviceFileKindLabels[kind]}» не прикладывают: заявку ведёт свой сотрудник — объём работ по ней не составляют`,
      { kind: 'Объём работ не составляется' },
    );
  }
  if (!canAttachServiceFile(kind, status, audience, p, assignment, request)) {
    throw err.unprocessable(
      `«${serviceFileKindLabels[kind]}» не прикладывают к заявке в статусе «${serviceRequestStatusLabels[status]}»`,
      { kind: 'Неподходящий статус' },
    );
  }
}

// Реестр гарантий (§9.5): схема фильтров и форма строки живут в контрактах (`warranty.ts`) —
// реестр читает портал, и второй такой же тип на его стороне разъехался бы с этим.

export default async function serviceRequestsRoutes(app: FastifyInstance): Promise<void> {
  /*
   * Отказы по области и стороне — событием журнала (Р6, этап Э6 плана аудита исполнителей).
   *
   * ЗДЕСЬ, А НЕ В `app.ts`: хук, объявленный внутри плагина, действует только на маршруты этого
   * плагина — контекст соседнего собирается отдельно. Инкапсуляция и есть весь порог: журнал
   * заведён под попытки прямого запроса к чужой ЗАЯВКЕ, и отказ по области в вывозе мусора или в
   * заказе техники не имеет права появиться в нём ни строкой. Регистрация до маршрутов не важна
   * Fastify (хуки контекста собираются целиком), но читается вместе со стражами — тем, ради чего
   * она и стоит первой строкой плагина.
   */
  registerServiceAccessDenialAudit(app);
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
   * **Раскладка свободной записи по графам** (план свободного объёма работ, Р2). Страж — ОДНО право
   * и своё: `serviceRequests.estimateRewrite` уходит в набор «Ведение» и больше никому.
   *
   * Ни `estimate`, ни `execute` эту дверь не открывают, и это главное в страже. Те двое — сторона
   * ИСПОЛНИТЕЛЯ, и правит она свой черновик; здесь же по согласованной ревизии переиздаётся
   * документ: подпись снимается, ревизия поднимается, заявка уходит на второй круг согласования.
   * Запиши мы сюда привычную дизъюнкцию стороны исполнителя — исполнитель получил бы обход
   * собственного замка «согласованное не правится», причём тем же телом запроса.
   */
  const canEstimateRewrite = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'serviceRequests.estimateRewrite',
        'Объём работ раскладывает по графам тот, кто ведёт заявки',
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
   * Спор об освобождении от подписи — обе его ручки (Р9). Право `serviceRequests.assign`, то самое,
   * которым «Ведение» распределяет заявки и которым считается «ведёт ли субъект заявку»
   * (`canOpenServiceEstimateDispute`, `canResolveServiceEstimateDispute`).
   *
   * НЕ `canAssign`, хотя право то же: у стража там свой текст («Назначает сервис оператор
   * оргтехники»), а человек, которому отказали в споре, не назначает никого — отказ обязан называть
   * то действие, за которым он пришёл.
   *
   * ПРАВО ЗАМОРОЗКИ СТРАЖ НЕ СПРАШИВАЕТ, хотя спор останавливает заявку именно ею: механика
   * остановки — не разрешение на неё. Спроси мы `hold`, спор отвалился бы у ИТ-службы, у которой
   * `assign` есть, а `hold` нет, — то есть у одной из двух сторон, ради которых правило и писано.
   */
  const canDispute = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'serviceRequests.assign',
        'Спор об освобождении ведёт тот, кто ведёт заявку',
      ),
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

  /**
   * ДЕЙСТВУЮЩЕЕ предъявление объёма работ — `serviceRequestHasEffectivePendingEstimate` (Р4, Р7) на
   * SQL, а не прежний сырой `estimate_pending_revision IS NOT NULL`.
   *
   * Конъюнкция с признаком Р4 стоит здесь потому, что SQL не зовёт функцию контрактов на колонках,
   * а третьей оси перебора очередь получить не может (Н16): маски выводятся сплошным перебором
   * сочетаний, и каждая новая ось удваивает их число. Значит одно и то же правило записано дважды —
   * функцией для карточки и выражением для списка, — и сторожит их совпадение тест корреляции
   * вместе с db-случаем «одна маска на строку».
   *
   * ОБЕ ПОЛОВИНЫ ПЕРЕПИСАНЫ, И ЭТО ГЛАВНОЕ. `noPendingHere` — ОТРИЦАНИЕ первой, а не «предъявления
   * нет»: половины оси обязаны покрывать все строки без остатка. Оставь мы `noPendingHere` прежним,
   * внутренняя заявка с историческим предъявлением не подошла бы ни к одной из двух половин и
   * выпала бы из очередей вовсе — в том числе из «ждёт исполнителя», куда её отправляет карточка, —
   * а падения не случилось бы: заявка просто исчезла бы из списка, у которого нет строки-эталона.
   */
  const pendingHere = () =>
    and(
      eq(serviceRequests.kind, 'repair'),
      isNotNull(serviceRequests.serviceCounterpartyId),
      isNotNull(serviceRequests.estimatePendingRevision),
    )!;
  const noPendingHere = () => not(pendingHere());

  /**
   * Четыре сочетания двух булевых осей, по которым очередь различает состояния внутри одного
   * статуса (Р2): состав исполнителей и действующее предъявление. Ось визы ИТ ушла отсюда вместе с
   * самой визой (Р10).
   *
   * Каждое сочетание несёт свои половины условия готовыми — и прямую, и отрицание. Порождённые
   * циклом по двум флагам, они прятали бы отрицание в тернарник, а перепутанное отрицание в очереди
   * не падает: оно тихо показывает чужие заявки.
   *
   * Ось предъявления зовётся `estimatePending` и несёт булево — ровно то поле, которое читает
   * `serviceRequestWaitingOn` (Р7). Прежняя пара «`null` либо ревизия 1» изображала колонку, и
   * изобретённая здесь ревизия отвечала на другой вопрос, чем тот, который очередь задаёт.
   */
  const WAITING_AXES = [
    { hasExecutors: false, estimatePending: false, where: [notAssigned, noPendingHere] },
    { hasExecutors: false, estimatePending: true, where: [notAssigned, pendingHere] },
    { hasExecutors: true, estimatePending: false, where: [hasExecutorsHere, noPendingHere] },
    { hasExecutors: true, estimatePending: true, where: [hasExecutorsHere, pendingHere] },
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
    //
    // ЗДЕСЬ ПРАВИЛО ПЕРЕПИСАНО НА SQL, и таких копий на весь модуль ровно две: эта очередь и отбор
    // автозакрытия (`internal-service-requests.ts`). Остальные читатели спрашивают
    // `closingKindsForFormat` по строке, а отбор списка спросить его не может: формат — у каждой
    // строки свой, и одним перечнем видов на всю выборку правило Р5 не выражается. Поэтому обе копии
    // собирает один помощник (`serviceHasClosingDocumentSql`) — он же уезжает в отбор пачки, — а
    // согласие двух редакций правила держит матричный тест эквивалентности (§6 плана). Формат
    // читается подзапросом на каждую строку: у заявки без ревизий перечень остаётся сегодняшним,
    // поэтому очередь ведёт себя ровно как до волны.
    const hasClosingDocument = serviceHasClosingDocumentSql(serviceRequests.id);
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
            // Четвёртое условие (Р8 плана перемещения): разобранное подтверждением из очереди
            // уходит. Коррелированный `NOT EXISTS` здесь законен — он в `WHERE`, а не в списке
            // колонок, — и покрыт частичным индексом миграции `0277`.
            placeNotConfirmedWhere(),
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
      /**
       * ДВЕ ОЧЕРЕДИ ПО СОСТОЯНИЮ ПРЕДМЕТА (план кандидатов, §9): «на проверке» — работа
       * проверяющего, «отклонён» — работа того, кто заявку ведёт. Одним параметром с одним
       * значением из двух: у кандидата состояние одно, и пара чекбоксов допускала бы запрос с
       * заведомо пустым ответом (разбор — при самом параметре в контрактах).
       *
       * ПОДЗАПРОСОМ `EXISTS`, А НЕ СОЕДИНЕНИЕМ, хотя `requestQuery` кандидата уже соединяет. У
       * этого условия ТРИ читателя, и соединение есть только у одного: страница списка строится
       * `requestQuery`, а счётчик той же страницы и «Отметить все прочитанными»
       * (`markAllChatRead`) собирают свои запросы сами — там из справочников соединён один
       * `office_equipment`. Условие по колонке кандидата уронило бы оба с «missing FROM-clause
       * entry», а дописать соединение в три места значило бы завести три способа разойтись:
       * страница показывала бы одно, счётчик считал бы другое, кнопка гасила бы третье. `EXISTS`
       * не зависит от формы вмещающего запроса вовсе — тот же приём и по той же причине, что у
       * `hasClosingDocument` выше.
       *
       * Коррелированный подзапрос здесь безопасен: он стоит в `WHERE`, а не в списке столбцов, —
       * молча переписывает корреляцию драйвер только во втором случае
       * (`office-equipment-sql-correlation.test.ts`).
       */
      q.candidateStatus
        ? exists(
            db
              .select({ x: sql`1` })
              .from(officeEquipmentCandidates)
              .where(
                and(
                  eq(officeEquipmentCandidates.id, serviceRequests.equipmentCandidateId),
                  eq(officeEquipmentCandidates.status, q.candidateStatus),
                ),
              ),
          )
        : undefined,
      q.warrantyClaim ? isNotNull(serviceRequests.warrantyClaimSource) : undefined,
      // Заморозка признак срочности не гасит (Р119) — заявка не перестала быть срочной оттого, что
      // её остановили, — но из отбора выпадает: пока она ждёт решения, браться не за что.
      // Условие шире, чем у прежнего частичного индекса `service_requests_urgent_idx` (тот исключал
      // ещё и закрытые), и после Р1 индекс переписан под этот отбор: подъёма срочных над выбранной
      // сортировкой больше нет, и единственный потребитель условия срочности здесь — вот этот
      // фильтр, отвечающий на «покажи все срочные за период».
      q.urgent
        ? and(
            eq(serviceRequests.isUrgent, true),
            // Из отбора уходит только заморозка (Р119): срочная отложенная ждёт решения, а не рук.
            // Закрытые срочные остаются видимыми, как и были: фильтр — это отбор («покажи все
            // срочные за период»), а не очередь, и отнимать у него прошлое Р119 не просил.
            // Порядок строк отбор не назначает вовсе — его задаёт выбранная человеком сортировка
            // (Р1), и добавлять сюда «а наверх их поднимет…» больше нечего.
            notInArray(serviceRequests.status, ['on_hold']),
          )
        : undefined,
      /*
       * «Только повторные» (план `docs/office-equipment-repeat-request-plan.md`, Р10): условие
       * приходит готовым `EXISTS` из общего builder'а — второй копии правила у списка нет. При
       * выключенном окне (`SERVICE_REQUEST_REPEAT_WINDOW_DAYS = 0`) builder отдаёт ложь, то есть
       * пустую выдачу, а не отказ: параметр остаётся законным запросом с пустым итогом (Р5).
       * Соединений условие не требует и потому годится и счётчику страницы, и `read-all`, которые
       * зовут этот же `listWhere`.
       */
      q.repeat ? serviceRequestRepeatWhere(p) : undefined,
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

  /**
   * Список «предыдущих» по ссылке из тега повтора (Р10 плана повторов).
   *
   * Сначала ищется сама `R` — и ищется ПОД ОБЩИМ ПРЕДИКАТОМ ВИДИМОСТИ, тем же, которым отвечает
   * карточка. Невидимая заявка даёт обычный `404`, неотличимый от «нет такой»: иначе ссылка стала
   * бы оракулом — подставляя чужие идентификаторы, можно было бы узнавать, какие заявки вообще
   * существуют.
   *
   * Условие для самих `P` строит общий builder, а не этот маршрут: длина всех страниц обязана
   * совпасть с `repeat.count`, который человек только что видел в теге, — а совпадёт она лишь
   * тогда, когда условий не шесть похожих, а те же шесть.
   *
   * ДАТЫ ЗАВЕДЕНИЯ ЭТО ЧТЕНИЕ НЕ БЕРЁТ, и это не экономия колонки: окно builder отсчитывает от
   * `created_at` самой `R`, но читает его колонкой базы. Проехав здесь через `Date`, дата потеряла
   * бы микросекунды `timestamptz`, окно съехало бы вниз на этот хвост — и ссылка отвечала бы
   * пустым списком там, где метка обещала повтор.
   */
  async function previousWhere(p: Principal, requestId: string): Promise<SQL> {
    const [subject] = await db
      .select({
        id: serviceRequests.id,
        kind: serviceRequests.kind,
        officeEquipmentId: serviceRequests.officeEquipmentId,
      })
      .from(serviceRequests)
      .where(
        and(eq(serviceRequests.id, requestId), isNull(serviceRequests.deletedAt), visibility(p)),
      )
      .limit(1);
    if (!subject) throw err.notFound(NOT_FOUND);
    return serviceRequestRepeatPreviousWhere(p, subject);
  }

  // ── Список ──
  r.get('/', { ...auth, schema: { querystring: serviceRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    // Режим «предыдущие» отбор не дополняет, а заменяет: схема запретила их сочетание, поэтому
    // здесь именно `или`, а не `and` с остатками `listWhere`.
    const where = q.repeatFor ? await previousWhere(p, q.repeatFor) : listWhere(p, q);

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
     * ПОДЪЁМА СРОЧНЫХ НАД ВЫБРАННОЙ СОРТИРОВКОЙ ЗДЕСЬ БОЛЬШЕ НЕТ — правило снято, а не потеряно
     * (план `docs/office-equipment-card-and-list-cleanup-plan.md`, Р1). Прежде первым аргументом
     * `orderBy` стояло выражение `urgentFirst` (Р56, Р119), поднимавшее незакрытые и не
     * отложенные срочные над любым порядком. Заказчик снял именно его: «за что браться
     * следующим» — решение человека, а список, который переставляет строки сам, это решение
     * отнимает и заодно отвечает не тем, о чём спросили, — выбранная сортировка по номеру
     * начинала работать со второго места.
     *
     * Срочность осталась ОТБОРОМ И МЕТКОЙ: пресет «Срочные» над таблицей, галочка в шите
     * (условие — в `listWhere` выше), красный тег строки, поле карточки и приставка «СРОЧНО ·» в
     * теме письма. Спросить «покажи срочные» — не то же самое, что решить за спросившего, и эту
     * половину волна не трогала.
     *
     * Восстанавливать выражение нельзя без нового разговора с заказчиком: вернувшийся подъём
     * молча отменит выбранный человеком порядок, и первым признаком станет жалоба «сортировка по
     * номеру не работает» — то есть тот самый разбор, из которого Р1 и вырос.
     */
    const [rows, totalRows] = await Promise.all([
      requestQuery()
        .where(where)
        .orderBy(orderByFrom(sortColumns, q.sortBy, q.sortOrder, 'statusChangedAt'))
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
   * Кандидаты в поимённые исполнители ЭТОЙ заявки (§7.1, план аудита исполнителей Р7): живая
   * учётка, которая после назначения и правда сможет работать.
   *
   * Своя ручка, а не `GET /users`, и причина не в удобстве. Список учёток закрыт `users.manage` —
   * правом, которого нет ни у «Ведения», ни у ИТ-службы: спрашивай портал его, поле выбора
   * заполнялось бы только у администратора портала, а у того, кто заявки и распределяет, оставалось
   * бы пустым. Здесь же условие ровно обратное: страж — `serviceRequests.assign`, то самое право,
   * которым назначают.
   *
   * ЗАЯВКА В ЗАПРОСЕ ОБЯЗАТЕЛЬНА, и это Р7. Прежде ручка отвечала «кого вообще можно назначить»
   * вообще — без заявки, без области и, стало быть, без строки области в манифесте (находка Н8).
   * Теперь вопрос задан целиком: кандидаты считаются тем же предикатом
   * (`canBecomeNamedExecutor`), которым их проверяет само назначение, — разойдись они, окно
   * предлагало бы человека, которому `PUT /:id/executors` ответит 422.
   *
   * ОБЛАСТЬ СПРАШИВАЕТСЯ У НАЗЫВАЮЩЕГО, А НЕ У КАНДИДАТА, и путать их нельзя. `requireEditable`
   * отвечает на «ваша ли это заявка» тому, кто список открыл; у самих кандидатов область не
   * спрашивается вовсе — назначение как раз и открывает заявку (третья ось, Р1), и пометка «сейчас
   * видит / не видит» рассказывала бы о состоянии, которое назначение и меняет.
   *
   * Отдаются только пригодные, без строк-заглушек с причиной: поле выбора рисует варианты списком,
   * и неактивная строка в нём — новый элемент интерфейса, которого никто не просил. Причина
   * непригодности живёт там, где на неё смотрят, — в отказе назначения, и называет она человека.
   *
   * Грубый отбор остаётся в SQL (`grantPermissionsExpr` — с гейтом совместимости набора с ролью):
   * он сужает выборку до носителей `execute` НАБОРОМ и тем не тащит из базы весь список учёток.
   * Решает всё равно предикат; шире отбора он не отвечает никогда — то есть в списке не появится
   * никого, кого назначение не примет.
   *
   * Отдаётся минимум — идентификатор и ФИО: поле выбора большего не показывает, а всё остальное про
   * учётку — предмет модуля витрины, а не этого.
   *
   * Путь статический и стоит **до** `/:id`: параметр перехватил бы его первым.
   */
  r.get(
    '/executor-candidates',
    { ...canAssign, schema: { querystring: executorCandidatesQuery } },
    async (req) => {
      const p = requirePrincipal(req);
      const row = await requireEditable(p, req.query.requestId);
      /*
       * Субъект доступа собирается ОДНОЙ выборкой на весь список (`accessSubjectColumns`), а не
       * `loadPrincipal` на строку: тем же выражением считает права принципал, и второго способа
       * ответить «что у этой учётки есть» в портале нет. Соединение с контрагентом обязательно —
       * тип контрагента лежит в его карточке, а без него оператор подрядчика выглядел бы обычным
       * сотрудником.
       */
      const rows = await db
        .select({
          id: users.id,
          fullName: users.fullName,
          counterpartyId: users.counterpartyId,
          ...accessSubjectColumns,
        })
        .from(users)
        .leftJoin(counterparties, eq(counterparties.id, users.counterpartyId))
        .where(
          and(
            eq(users.isActive, true),
            isNull(users.deletedAt),
            sql`${grantPermissionsExpr} @> ARRAY['serviceRequests.execute']::text[]`,
          ),
        )
        .orderBy(users.fullName);
      return {
        items: rows
          .filter((candidate) =>
            canBecomeNamedExecutor(
              { ...accessSubjectOf(candidate), counterpartyId: candidate.counterpartyId },
              row,
            ),
          )
          .map((candidate) => ({ id: candidate.id, fullName: candidate.fullName })),
      };
    },
  );

  // ── Массовые действия над заявками (план `docs/office-equipment-bulk-actions-plan.md`) ──
  /**
   * ОДНА ИЗМЕНЯЮЩАЯ РУЧКА И ОДНА ЧИТАЮЩАЯ (Р1). Девять пакетных ручек означали бы девять мест, где
   * написан один и тот же протокол (версии, ключ, отчёт, порядок, аудит), и первое же исправление
   * разъехалось бы по ним. Различает операции не транспорт, а исполнитель шага — тот же доменный
   * шаг, что зовёт одиночная ручка (Р2, Н9).
   *
   * ПУТЬ СТАТИЧЕСКИЙ, ПОЭТОМУ ОБЪЯВЛЕН ЗДЕСЬ — ДО ПАРАМЕТРИЧЕСКИХ `/:id/…`, тем же правилом, по
   * которому выше стоят `/warranties`, `/waiting-count` и `/executor-candidates`.
   *
   * ТРИ РУБЕЖА ДОПУСКА, И ПОДМЕНЯТЬ ОДИН ДРУГИМ НЕЛЬЗЯ НИ В КАКУЮ СТОРОНУ (Р5, §6.4):
   *
   *   1. страж маршрута — «бывает ли у этого субъекта хоть одна пакетная операция» (`anyOf`);
   *   2. `canUseServiceBulk` — продуктовый допуск к массовому режиму: закрывает Н11 (у заявителя
   *      есть `serviceRequests.delete` на свою «Новую», но массовый интерфейс ему не даётся) и
   *      сужает `start` до назначенных, не принимая `estimate`;
   *   3. `canRunServiceBulkOperation` — точное право НАЗВАННОЙ операции;
   *
   * и только после них — построчный доменный предикат ВНУТРИ шага. Разделительная черта одна:
   * свойство запроса отбивается запросом, свойство строки — строкой (Н7).
   */
  const canBulk = {
    preHandler: [
      app.authenticate,
      app.requireAnyPermission(
        [
          'serviceRequests.assign',
          'serviceRequests.status',
          'serviceRequests.execute',
          'serviceRequests.hold',
          'serviceRequests.urgency',
          // `delete` страж принимает, иначе архивирование не прошло бы его вовсе; допуск
          // `canUseServiceBulk` держателя ОДНОГО лишь `delete` при этом отбивает — так и закрыт Н11.
          'serviceRequests.delete',
        ],
        'Массовые действия над заявками недоступны',
      ),
    ],
  };

  r.post(
    '/bulk',
    { ...canBulk, schema: { body: serviceRequestBulkSchema } },
    async (req): Promise<ServiceRequestBulkResultDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      /*
       * Оба отказа обработчика начинаются одинаково — «Массовый режим», — и это не стиль: перебор
       * прав (`access-conditions.test.ts`) отличает отказ ОБРАБОТЧИКА от отказа стража по одной
       * подстроке на маршрут, а отказов здесь два. Разойдись их начала, положительный случай
       * перебора читался бы как «страж не пустил».
       */
      if (!canUseServiceBulk(p)) {
        throw err.forbidden('Массовый режим открыт тем, кто заявки распределяет и ведёт');
      }
      if (!canRunServiceBulkOperation(p, body.operation)) {
        throw err.forbidden(
          'Массовый режим этой операции вам не открыт — откройте заявки по одной',
        );
      }
      /*
       * Ключ идемпотентности заголовком — тем же транспортом, что у сообщения о технике и у
       * закупки. Обязателен: пачка идёт секунды, кнопка видна, вкладка может перезагрузиться, и
       * повтор без ключа означал бы второе применение к сорока девяти уже сделанным строкам.
       */
      const key = bulkKeyOf(req);
      return runServiceRequestBulk({
        actor: p,
        key,
        fingerprint: serviceBulkFingerprint(body),
        operation: body.operation,
        rows: body.rows,
        log: req.log,
        /*
         * РАЗБОР ОПЕРАЦИИ ЖИВЁТ ЗДЕСЬ, А НЕ В ПРОТОКОЛЕ, и это не стиль: протокол не должен знать
         * ни одного доменного правила, иначе у пачки завёлся бы второй набор условий. Каждая ветка
         * зовёт ТОТ ЖЕ шаг, что и одиночная ручка, — сравнить их можно глазами, не открывая
         * второго файла.
         *
         * КОНТЕКСТ ПАЧКИ (`step`) УЕЗЖАЕТ ШАГУ ПОСЛЕДНИМ АРГУМЕНТОМ — тем самым, которого одиночная
         * ручка не передаёт вовсе. В нём две неразделимые вещи: транзакция строки с checkpoint'ом
         * внутри (Р7) и приписка `bulkOperationId` к аудиту (Р8). Порознь их взять неоткуда —
         * значит ветка не может выполнить строку в транзакции пачки и записать журнал так, будто
         * заявку правили поштучно.
         */
        run: async (row, _index, step) => {
          switch (body.operation) {
            case 'cancel':
              // Отмена — вариант общей ручки статуса с целью `cancelled`; откаты массовыми не
              // бывают вовсе (§4), и второй ветки под них здесь нет.
              //
              // ПОЛЕЙ «РЕКОМЕНДОВАНА ЗАМЕНА» И РЕШЕНИЯ ЗДЕСЬ НЕТ НАМЕРЕННО (Р10): пачка идёт с
              // одной общей причиной, и одна галочка на сорок заявок пометила бы к замене сорок
              // аппаратов, которых человек в глаза не видел. Отсутствие необязательного поля шаг
              // читает как «замена не рекомендована»; решение относится к одному аппарату и
              // вводится только в его карточке.
              await statusStep(
                p,
                row.id,
                { status: 'cancelled', reason: body.reason, version: row.version },
                step,
              );
              return;
            case 'hold':
              await holdStep(p, row.id, { reason: body.reason, version: row.version }, step);
              return;
            case 'resume':
              // Цель у каждой строки своя и берётся из неё самой (`held_from_status`) — человеку
              // решать нечего, поэтому комментарий необязателен.
              await resumeStep(p, row.id, { comment: body.comment, version: row.version }, step);
              return;
            case 'urgency_on':
              await urgencyStep(
                p,
                row.id,
                { isUrgent: true, urgencyReason: body.urgencyReason, version: row.version },
                step,
              );
              return;
            case 'urgency_off':
              // Снятие причины не требует вовсе, и пара «флаг + причина» гасится целиком: порознь
              // её не примет ни схема, ни `CHECK` базы.
              await urgencyStep(
                p,
                row.id,
                { isUrgent: false, urgencyReason: '', version: row.version },
                step,
              );
              return;
            case 'assign':
              await assignStep(
                p,
                row.id,
                {
                  userIds: body.userIds,
                  serviceCounterpartyId: body.serviceCounterpartyId,
                  reason: body.reason,
                  comment: body.comment,
                  version: row.version,
                },
                step,
              );
              return;
            case 'start':
              await assertBulkStartAssignment(p, row.id);
              await startStep(p, row.id, { version: row.version }, step);
              return;
            case 'accept':
              await acceptStep(p, row.id, { comment: body.comment, version: row.version }, step);
              return;
            case 'archive':
              // Версия у пачки ОБЯЗАТЕЛЬНА (Н6): у одиночной ручки она необязательна ради старого
              // портала, а здесь её всегда шлёт отбор строк, и не сверять её значило бы сносить в
              // архив то, чего человек уже не видел.
              await archiveStep(p, row.id, row.version, step);
              return;
          }
        },
      });
    },
  );

  /**
   * Состояние пачки по её ключу (Р1, Н12): прогресс и восстановление после обрыва, а не вторая
   * командная ручка. Ничего не меняет, отвечает только автору (`404` на чужой ключ), и портал
   * начинает опрос одновременно с `POST` — `404` до момента claim допустим.
   */
  r.get(
    '/bulk/:key',
    { ...auth, schema: { params: serviceRequestBulkKeyParams } },
    async (req): Promise<ServiceRequestBulkStatusDto> => {
      const p = requirePrincipal(req);
      const status = await readServiceBulkStatus(p.id, req.params.key);
      // Чужой ключ — `404`, а не `403`: существование чужой пачки не показывается по известному
      // ключу, ровно как архивная заявка не показывается по известному id.
      if (!status) throw err.notFound('Массовая операция не найдена');
      return status;
    },
  );

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

      /**
       * ИДЕМПОТЕНТНОСТЬ — ТОЛЬКО У ВЕТКИ КАНДИДАТА и ДО всякой работы (план кандидатов, §8).
       *
       * Ключ спрашивается первым — раньше разбора предмета, раньше рубежа дублей и раньше
       * транзакции, — и это самый неочевидный шаг приёма (закупка ошиблась ровно на нём). При
       * потерянном ответе первая попытка УЖЕ завела ожидающего кандидата, значит повтор упёрся бы
       * в рубеж 2 «аппарат уже отправлен на проверку», не дойдя до собственного ключа, — то есть
       * обещание «повтор вернёт прежнюю пару» не выполнялось бы ровно в том случае, ради которого
       * ключ и заводится.
       *
       * Повтор заканчивается ЗДЕСЬ и не делает больше ничего: ни письма, ни аудита, ни второй
       * строки. Ответ у него 200, а не 201: этим запросом ничего не создано, и сказать «создано»
       * значило бы соврать клиенту, который как раз и выясняет, создавал он что-нибудь или нет.
       *
       * ОТСЮДА ОДНО ОТСТУПЛЕНИЕ ОТ ОБЫЧНОГО ПОРЯДКА «право → область → работа»: тело без заголовка
       * получит 400 раньше, чем недостающее право получит 403. Принято сознательно — право
       * `officeEquipment.propose` спрашивается ОДИН раз и в одном месте, вместе с разбором предмета
       * (`resolveRequestSubject`), а второй его вызов здесь ради порядка кодов завёл бы второе место,
       * которое однажды разойдётся с первым. Раскрыть 400 при этом нечего: он сообщает лишь то, что
       * у ручки есть заголовок.
       */
      const candidate = body.equipmentCandidate ?? null;
      /**
       * РУБИЛЬНИК ПРИЁМА СООБЩЕНИЙ О ТЕХНИКЕ — ПЕРВЫМ ДЕЛОМ С ТАКИМ ТЕЛОМ (план предмета заявки,
       * Р10; контракт — план кандидата, §14).
       *
       * СЕРВЕР НЕ ДОВЕРЯЕТ КЛИЕНТУ, и это весь смысл проверки. Портал прячет третью ветвь формы по
       * списку включённых ключей из ответа сессии, но список — подсказка экрану, а не защита:
       * прямой запрос мимо портала, открытая со вчера вкладка и держатель `officeEquipment.propose`
       * из полного словаря (администратор) обошли бы её втроём. Поэтому 403 приходит ДАЖЕ
       * ДЕРЖАТЕЛЮ ПРАВА: рубильник — состояние двери, а не свойство учётки.
       *
       * СТОИТ РАНЬШЕ КЛЮЧА ИДЕМПОТЕНТНОСТИ, хотя тот и заявлен первым шагом приёма ниже. Отвергнут
       * порядок «сперва повтор, потом рубильник»: он оставлял бы ветвь, в которой закрытый приём
       * отвечает 200, — и «приём закрыт» имело бы исключение, о котором портал не знает и знать не
       * может. Повтор при этом не теряется: заведённая до выключения пара видна и в списке заявок, и
       * в очереди проверки, а их рубильник намеренно не ограждает.
       *
       * ЧИТАЕТСЯ НА КАЖДЫЙ ЗАПРОС и только у тела с сообщением: строка одна и берётся по первичному
       * ключу, а кэш превратил бы аварийное выключение в «выключится через минуту» — причём на
       * каждом инстансе в свою.
       */
      if (candidate && !(await isFeatureEnabled(db, 'office_equipment_candidate_intake'))) {
        throw err.featureDisabled(
          'Приём сообщений о технике, которой нет в справочнике, сейчас закрыт — заведите карточку через ИТ-службу и выберите аппарат из справочника',
        );
      }
      const intake = candidate
        ? { key: candidateIntakeKeyOf(req), fingerprint: candidateIntakeFingerprint(body) }
        : null;
      if (intake) {
        const repeatOf = await findIntakeRepeat(p, intake.key, intake.fingerprint);
        if (repeatOf) return await repeatedIntakeAnswer(p, repeatOf);
      }

      /**
       * СРОЧНОСТЬ ПРИ ЗАВЕДЕНИИ — ПРАВО, А НЕ УКРАШЕНИЕ ФОРМЫ (план предмета заявки, Р9).
       *
       * До этой строки её не спрашивал никто: «объявить срочность при подаче» считалось просьбой
       * заявителя, и очередь наполнялась срочными заявками ровно настолько, насколько бойко жал
       * галочку каждый. Срочность назначает тот, кто ведёт заявки, — и назначает уже после того,
       * как прочёл описание.
       *
       * `false` ПРИНИМАЕТСЯ ВСЕГДА И ОТ ВСЕХ, и это не поблажка: у поля значение по умолчанию
       * (`createServiceRequestSchema`), то есть `isUrgent: false` приезжает в КАЖДОЙ обычной заявке
       * — и от формы, и от старого клиента, который о срочности не знает вовсе. Отбивай мы его,
       * право на срочность стало бы правом заводить заявки.
       *
       * СПРАШИВАЕТСЯ ЗДЕСЬ, а не схемой и не стражем маршрута, — тем же приёмом и по тем же доводам,
       * что `serviceRequests.createWithoutEquipment` и `officeEquipment.propose` в разборе предмета
       * ниже: схема одна на все учётки и прав не видит, а дверь у ручки одна на всю компанию.
       * 403, а не 422 по полю: человек не ошибся ничем — ему просто не положено объявлять срочность,
       * и отказ поэтому называет выход (заявка заводится обычной, срочность поставит служба).
       *
       * Правку (`PATCH /:id`) это не касается: там срочность сверяется со СТРОКОЙ заявки и право
       * спрашивается на ИЗМЕНЕНИЕ пары, потому что форма правки шлёт оба поля всегда.
       */
      if (body.isUrgent) {
        assertCan(
          p,
          'serviceRequests.urgency',
          'Срочность заявке назначает служба, которая её ведёт — заведите обычную заявку и опишите, почему это срочно',
        );
      }

      // Предмет заявки и её заказчик — одним разбором (Р5, Р6, Р7): у заявки с аппаратом они
      // считаются от карточки единицы, у заявки без аппарата — от оси роли заводящего, у заявки с
      // кандидатом — из самого сообщения о технике.
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
       * ВТОРОЕ ПИСЬМО ЭТОГО ЗАВЕДЕНИЯ — О САМОМ СООБЩЕНИИ (план кандидатов, §10; этап Э5).
       *
       * Оно НЕ ПОДАВЛЯЕТ и НЕ ПОДМЕНЯЕТ `service_request_waiting_it`: это два разных факта и два
       * разных адресата. Служба получает «заявку надо разобрать», проверяющие — «в справочнике
       * появилось сообщение, которое надо проверить», и склеить их нельзя даже при совпадении
       * ящиков: у писем разные `kind`, поэтому уникальность очереди `(kind, dedupe_key)` их не
       * схлопнет, а рубильники щёлкаются порознь.
       *
       * Готовится ДО транзакции, как и соседнее: здесь читается только конфигурация канала, и её
       * отказ — мягкий исход. Адресаты, рубильник и тела считаются внутри транзакции (§5.9).
       */
      const candidateMailPlan = candidate
        ? prepareCandidateMail('office_equipment_candidate_pending', mailActorOf(p))
        : null;

      /**
       * Вид заявки (Н1). «Поля нет» читается как «ремонт» — ровно так, как читает его старый код в
       * окне выката, и так же стоит умолчанием колонки (`0177`). Строки номенклатуры и вид схема
       * сверила между собой (`createServiceRequestSchema`): у расходников строки обязательны, у
       * ремонта их не бывает.
       */
      const kind: ServiceRequestKind = body.kind ?? 'repair';
      const consumables = body.consumables ?? [];

      /*
       * Промис заведения берётся ОТДЕЛЬНОЙ ПЕРЕМЕННОЙ, а не цепочкой прямо на вызове: разбор
       * `23505` обязан стоять снаружи транзакции (ниже), а `.catch`, приписанный к самому вызову,
       * сдвинул бы внутрь всё тело заведения, ничего в нём не изменив. Промис при этом не «висит»:
       * обработчик приписан к нему следующим же выражением, без единого `await` между ними.
       */
      const attempt = db.transaction(async (tx) => {
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
        /**
         * КАНДИДАТ И ЗАЯВКА — ОДНОЙ ТРАНЗАКЦИЕЙ (Р2), и порядок «сначала кандидат» задан ссылкой:
         * заявка держит `equipment_candidate_id`, а не наоборот. Отдельная ручка «сначала кандидат,
         * потом заявка» оставляла бы кандидатов-сирот при каждом обрыве на втором шаге и требовала
         * бы уборки; здесь обрыв не оставляет ничего.
         *
         * Тип сообщения проверяется ОБЩИМ помощником справочника (`assertTypeUsable`, Р14), а не
         * своей копией условия: заявитель выбирает тип из того же перечня, что и оператор в форме
         * карточки, и «здесь неактивный тип ещё можно, а там уже нельзя» было бы расхождением двух
         * дверей в один справочник. Внутри транзакции, потому что помощник работает над `tx`, а
         * пустой откат не стоит ничего.
         */
        const candidateId = candidate
          ? await insertRequestCandidate(tx, p, candidate, requester.departmentId, intake!)
          : null;
        const [row] = await tx
          .insert(serviceRequests)
          .values({
            officeEquipmentId: equipment?.id ?? null,
            /**
             * ТРЕТИЙ СПОСОБ НАЗВАТЬ ПРЕДМЕТ (Р4). Ссылка остаётся заполненной и после решения
             * проверяющего: заявка обязана помнить, что предмет пришёл проверкой, — по этой паре
             * читается история, снимается замок приёмки (Р16) и строится срез «заведено через
             * проверку».
             */
            equipmentCandidateId: candidateId,
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
             *
             * У ЗАЯВКИ С КАНДИДАТОМ СНИМОК ЗАПОЛНЕН ЗАЯВЛЕННЫМ (Р6): модель — как её прочли с
             * шильдика, оба номера и место — как их назвал человек. Пустой снимок здесь был бы
             * неверен: предмет у заявки ЕСТЬ, он просто не проверен, и сервис едет по этому адресу
             * уже сегодня. Решение проверяющего перепишет эти четыре колонки реквизитами заведённой
             * карточки — единственный раз в жизни заявки, когда снимок меняется, и потому событие
             * пишется в историю, а не подменяется молча.
             */
            equipmentName: equipment?.name ?? candidate?.declaredModel ?? '',
            equipmentSerialNumber: equipment?.serialNumber ?? candidate?.serialNumber ?? '',
            equipmentInventoryNumber:
              equipment?.inventoryNumber ?? candidate?.inventoryNumber ?? '',
            // Место — часть того же снимка: сервис поедет по нему, а карточка к тому времени
            // могла переехать (Р57).
            equipmentLocation: equipment?.location ?? candidate?.location ?? '',
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
             * ИТ-службы заводится «Новой» наравне с остальными — тем более что визы не осталось ни
             * в цикле, ни в её наборе (Э9 плана профилей).
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
        /**
         * ПИСЬМО О СООБЩЕНИИ — ТЕМ ЖЕ `tx` И ПОСЛЕДНИМ ШАГОМ ТРАНЗАКЦИИ (atomic-outbox, §5.9
         * почтового плана). Тем же — потому что SQL-ошибка очереди обязана откатить и пару
         * «кандидат + заявка»: письмо, потерянное молча, оставило бы сообщение лежать в очереди, о
         * которой никто не узнал. Последним — потому что тело письма читает уже записанные строки:
         * тип, площадку и подразделение автора берёт `loadCandidateLetterData` по самой строке
         * кандидата, а номер заявки существует только после её вставки (`num` — identity).
         *
         * SMTP при этом работает уже после ответа: в транзакции появляются лишь строка очереди и
         * задача воркера.
         */
        const candidateMail =
          candidateId && candidateMailPlan
            ? await queueCandidateMail(tx, { prepared: candidateMailPlan, candidateId })
            : null;
        return { ...request, mail: transition.mail, requester, candidateId, candidateMail };
      });
      /**
       * РУБЕЖ 2 И ГОНКА КЛЮЧА — СНАРУЖИ ПРЕРВАННОЙ ТРАНЗАКЦИИ (Р10, §8). К моменту `23505`
       * транзакция прервана, и читать в ней нечего: любой запрос в ней ответит `25P02`.
       *
       * Второго чтения ключа «под блокировкой», как у закупки (её шаг 4), здесь нет и не нужно:
       * закупка берёт `FOR UPDATE` на строки расходников и потому обязана перечитать ключ уже под
       * замком, а заведение пары блокировок не берёт вовсе — точкой сериализации служит сам
       * уникальный индекс, и разбор его отказа эту работу и делает.
       */
      const created = await attempt.catch(async (e: unknown) => {
        if (!intake) throw e;
        const repeat = await asCandidateIntakeRepeat(
          e,
          p,
          intake.key,
          intake.fingerprint,
          candidate!,
        );
        return { repeatOf: repeat.requestId };
      });
      if ('repeatOf' in created) return await repeatedIntakeAnswer(p, created.repeatOf);

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
      /**
       * Заведение кандидата — ОБЫЧНЫЙ `writeAudit`, а не строгий (§11 плана кандидатов), и это
       * решение, а не следование соседней строке. След заведения есть и без журнала: пара колонок
       * `created_by/created_at` самой строки плюс ссылка из заявки, — а ронять заведение заявки
       * неудачной записью в журнал нельзя, человек в ней не виноват. Строгим (`writeAuditTx`)
       * станут решения проверяющего (Э4): там журнал отвечает, откуда взялась карточка в парке, и
       * потерянная запись оставила бы этот вопрос без ответа именно в редком случае, ради которого
       * журнал и читают.
       */
      if (created.candidateId) {
        await writeAudit({
          actorUserId: p.id,
          action: 'officeEquipmentCandidate.create',
          entityType: 'officeEquipmentCandidate',
          entityId: created.candidateId,
          metadata: {
            requestId: created.id,
            num: created.num,
            declaredModel: candidate!.declaredModel,
            serialNumber: candidate!.serialNumber,
            inventoryNumber: candidate!.inventoryNumber,
            objectId: candidate!.objectId,
            location: candidate!.location,
          },
        });
      }
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
      return {
        request: forAudience(dto),
        mail: created.mail?.outcome ?? 'not_needed',
        /**
         * Исход второго письма — ОТДЕЛЬНЫМ полем и только у заведения с сообщением о технике
         * (§10). Поле аддитивное: старый клиент лишнее игнорирует, а поле `mail` продолжает
         * отвечать за письмо службы — подмени мы его общим исходом, портал говорил бы «служба не
         * оповещена» там, где не нашлось проверяющего, и наоборот.
         *
         * Тип ответа контрактами пока не объявлен: `packages/contracts/src/service-requests.ts`
         * правит соседняя волна, и лезть в него ради одного необязательного поля значило бы
         * поймать конфликт на ровном месте. Портал читает поле по имени, а объявление приедет
         * вместе с ближайшей правкой контракта заведения.
         */
        ...(created.candidateMail ? { candidateMail: created.candidateMail.outcome } : {}),
      };
    },
  );

  // ── Заведение пары «кандидат + заявка» (план кандидатов, Р2, Р7, §8) ──

  /**
   * Ответ на ПОВТОР потерянной попытки: прежняя пара и ничего больше (§8).
   *
   * Ни 201, ни письма, ни второй строки аудита: ресурс этим запросом не создавался, и сказать
   * «создано» значило бы соврать клиенту, который как раз и выясняет, создавал он что-нибудь или
   * нет. Исход почты — `not_needed`: письмо по этой заявке ушло на первой попытке, и повторять его
   * незачем; «поставлено в очередь» здесь означало бы второе письмо, которого не будет.
   */
  async function repeatedIntakeAnswer(
    p: Principal,
    requestId: string,
  ): Promise<{ request: ServiceRequestDto; mail: ModuleMailOutcome }> {
    const dto = (await getFullDto(p, requestId))!;
    return { request: forAudience(dto), mail: 'not_needed' };
  }

  /**
   * Строка сообщения о технике — той же транзакцией, что и заявка (Р2).
   *
   * ПОДРАЗДЕЛЕНИЕ АВТОРА — СНИМКОМ, и берётся оно у того же разбора, что и снимок заявки
   * (`resolveRequesterPlace`), а не у сегодняшних привязок учётки: по нему считается отдельская ось
   * области проверяющего (Р9), и переведённый в другой отдел человек не должен уносить свои прошлые
   * сообщения из чужой очереди. Пусто у учёток вовсе без отделов (площадочная роль, администратор)
   * — законное состояние: такие кандидаты видны по объекту.
   *
   * Версии, статуса и решения здесь нет ни одного: у только что отправленного сообщения статус
   * `pending`, версия единица и решения не принято — всё это стоит умолчаниями колонок, и
   * повторять их в теле вставки значило бы завести второе место, где записаны те же значения.
   */
  async function insertRequestCandidate(
    tx: Tx,
    p: Principal,
    candidate: EquipmentCandidateInput,
    requesterDepartmentId: string | null,
    intake: { key: string; fingerprint: string },
  ): Promise<string> {
    await assertTypeUsable(tx, candidate.equipmentTypeId);
    const [row] = await tx
      .insert(officeEquipmentCandidates)
      .values({
        equipmentTypeId: candidate.equipmentTypeId,
        declaredModel: candidate.declaredModel,
        serialNumber: candidate.serialNumber,
        inventoryNumber: candidate.inventoryNumber,
        objectId: candidate.objectId,
        location: candidate.location,
        comment: candidate.comment,
        requesterDepartmentId,
        createdBy: p.id,
        idempotencyKey: intake.key,
        idempotencyFingerprint: intake.fingerprint,
      })
      .returning({ id: officeEquipmentCandidates.id });
    return row!.id;
  }

  /**
   * Площадка кандидата — по ОСИ РОЛИ автора (Р7), и оси здесь две, а не одна.
   *
   * Обе оси сужаются — и объектная, и отдельская (`departmentObjectIds`, ADR 0062): опоры на
   * карточку здесь нет вовсе, площадку называет сам человек, и без второй оси сотрудник отдела
   * заводил бы сообщения о технике чужих строек, а очередь проверяющего той площадки наполнялась бы
   * сообщениями, которых никто там не видел.
   *
   * Разбор при этом СВОЙ, а не общий с пометкой «не тот объект» (`resolveEquipmentObject`), хотя обе
   * оси теперь спрашивают оба (план предмета заявки, Р8). Разные у них не проверки, а предмет и
   * слова отказа: там объект ПОПРАВЛЯЕТ карточку и подсказка говорит про аппарат, здесь объект
   * называет место аппарата, которого в справочнике нет, — и человеку надо объяснить, что проверять
   * сообщение будут по площадке. Слив их в одну функцию, пришлось бы разводить тексты флагом, то
   * есть той же развилкой, но спрятанной.
   *
   * Область ПАРКА и роли без осей выбирают из справочника целиком — то же правило и тот же источник
   * (`canPickAnyServiceSubject`), что у соседних разборов предмета.
   *
   * ОСНОВАНИЕ — ОБЛАСТЬ ПАРКА, А НЕ ЛЕНТЫ ЗАЯВОК (план свободного объёма работ, Р9). Прежде здесь
   * стояла сквозная область модуля ЗАЯВОК, хотя вопрос у разбора другой: площадка сообщения о
   * технике — это предмет будущей заявки, то есть справочник, из которого её собирают. Пока оба
   * ключа стоят у одного набора (ИТ-служба), подмена не меняет ни одного ответа — ровно это и обязан
   * доказать parity-тест. Меняется она заранее потому, что `serviceRequests` уезжает из карты
   * области следующим выпуском, и без этой правки уборка строки молча сузила бы ЗАВЕДЕНИЕ: «технику
   * вижу, а сообщить о ней не могу» — не сужение видимости заявок, а поломка сценария, ради которого
   * парк и оставлен видимым целиком (ответ В5).
   *
   * 422 с именем поля, а не 403: право сообщить о технике у человека есть — не годится присланное
   * значение. Тот же код и та же форма ответа, что у чужого объекта в пометке «не тот объект».
   */
  async function resolveCandidateObject(
    p: Principal,
    candidate: EquipmentCandidateInput,
  ): Promise<void> {
    const wide = canPickAnyServiceSubject(p);
    const who = p.role ? roleLabels[p.role] : 'Учётная запись';
    if (
      !wide &&
      isObjectScopedRole(p.role) &&
      !p.constructionObjectIds.includes(candidate.objectId)
    ) {
      throw err.unprocessable(
        'Сообщить о технике можно только со своего объекта — заявку с чужого не увидит и сам заявитель',
        { 'equipmentCandidate.objectId': 'Чужой объект' },
      );
    }
    if (
      !wide &&
      isDepartmentScopedRole(p.role) &&
      !p.departmentObjectIds.includes(candidate.objectId)
    ) {
      throw err.unprocessable(
        `${who} сообщает о технике на площадках своего отдела: на чужой её некому проверить`,
        { 'equipmentCandidate.objectId': 'Чужая площадка' },
      );
    }
    // Существование, а не активность: закрывающаяся площадка ещё держит у себя технику, и запрет
    // выбирать её означал бы сообщение, которое негде записать. Тот же разбор, что у площадки
    // заявителя и у пометки «не тот объект» рядом.
    const [object] = await db
      .select({ id: constructionObjects.id })
      .from(constructionObjects)
      .where(eq(constructionObjects.id, candidate.objectId));
    if (!object) {
      throw err.unprocessable('Объект не найден', { 'equipmentCandidate.objectId': 'Не найден' });
    }
  }

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
    /**
     * `null` у ДВУХ разных заявок, и путать их нельзя: у заявки без аппарата предмета нет вовсе —
     * снимки пустые; у заявки с кандидатом предмет есть и не проверен — снимки заполняет
     * заявленное (Р6). Различает их сам вызывающий по `body.equipmentCandidate`, а отдел-владелец
     * пуст в обоих случаях: владельца у несуществующей карточки нет.
     */
    equipment: EquipmentSnapshot | null;
    equipmentObjectId: string | null;
    customerDepartmentId: string | null;
  }

  /**
   * Предмет заявки и её заказчик — одним разбором, потому что это один вопрос («чья заявка»), у
   * которого ТРИ разных источника ответа.
   *
   * С АППАРАТОМ ответ приходит из справочника: площадка — из карточки единицы, отдел-владелец —
   * оттуда же, отдел-заказчик подсказывается ими и уточняется человеком. Порядок шагов ПЕРЕВЁРНУТ
   * (план предмета заявки, Р8): заказчик → итоговый объект заявки → область по ИТОГОВОМУ объекту.
   * Раньше область спрашивалась по объекту КАРТОЧКИ и стояла перед пометкой «не тот объект» — из-за
   * чего заявку на аппарат чужой площадки сервер отбивал 403 ещё до того, как поправка успевала
   * сказать, что аппарат стоит как раз у нас. Теперь судят по тому, что заявка получит в колонке
   * области, а не по тому, что написано в справочнике: справочник по оргтехнике врёт чаще, чем
   * человек, стоящий рядом с аппаратом.
   *
   * БЕЗ АППАРАТА справочника нет, и ответ даёт **сам заводящий** — выбором заказчика по оси своей
   * роли (Р6). Отсюда и страж права здесь же: «аппарат не прислали» — это не пропущенное поле, а
   * другой способ завести заявку, и разрешение на него отдельное.
   *
   * С КАНДИДАТОМ справочника ещё нет, но предмет есть: человек описал аппарат словами (план
   * кандидатов, Р2). Площадку он называет сам — внутри сообщения, — а заказчик считается тем же
   * разбором, что и у заявки с аппаратом, и потому у этой ветки законно заполнены ОБЕ колонки
   * области сразу: `equipment_object_id` держит физическое место аппарата, `customer_department_id`
   * — заказчика отдельской роли (Р7, последний абзац). Старое XOR-правило к ней не применяется, и
   * третья ветвь `service_requests_subject_check` этого не запрещает.
   */
  async function resolveRequestSubject(
    p: Principal,
    body: {
      officeEquipmentId?: string | null;
      equipmentCandidate?: EquipmentCandidateInput;
      objectId?: string;
      objectOverridden: boolean;
      customerDepartmentId?: string | null;
    },
  ): Promise<RequestSubject> {
    const candidate = body.equipmentCandidate;
    if (candidate) {
      /**
       * 403, А НЕ 422, и спрашивается право ЗДЕСЬ ЖЕ — тем же приёмом и по тем же трём доводам, что
       * у `serviceRequests.createWithoutEquipment` строкой ниже:
       *
       *   * схемой нельзя — она одна на все учётки и прав не видит вовсе;
       *   * стражем маршрута нельзя — дверь у ручки одна на все три способа назвать предмет, и
       *     требование права на ней отобрало бы у всей компании обычную заявку;
       *   * 422 по полю сказало бы «вы ошиблись формой» там, где человек не ошибся ничем: сообщить
       *     о технике ему просто не разрешено, и разрешение это отдельное (Р8).
       *
       * Отказ называет ВЫХОД, а не только запрет: пока право не выдано, аппарат в справочник
       * заводит тот, кому это положено, и заявка после этого заводится обычным способом.
       */
      if (!can(p, 'officeEquipment.propose')) {
        throw err.forbidden(
          'Сообщать о технике, которой нет в справочнике, разрешено отдельно — попросите ИТ-службу завести карточку',
        );
      }
      await resolveCandidateObject(p, candidate);
      const customerDepartmentId = await resolveCustomerDepartment(p, body, {
        ownerDepartmentId: null,
      });
      /*
       * Второй рубеж под тем же правилом, что и у заявки без аппарата: разбор выше выбирает площадку
       * и заказчика порознь, а эта проверка спрашивает у ОБЩЕГО источника области, попала ли
       * получившаяся заявка к самому автору. Разойдись они однажды — человек отправил бы заявку и не
       * увидел её в списке, а искать её было бы некому: у кандидата и очередь проверки своя.
       */
      assertServiceRequestScope(p, {
        objectId: candidate.objectId,
        customerDepartmentId,
        equipmentDepartmentId: null,
      });
      /*
       * РУБЕЖ 1 — ПОСЛЕДНИМ ИЗ ПРОВЕРОК ВХОДА, и порядок содержателен. Он ходит в базу по всему
       * парку и отвечает 409, то есть говорит о ЧУЖИХ строках; спроси мы его раньше области,
       * человек, ошибившийся объектом, узнавал бы попутно о существовании карточки, к которой
       * отношения не имеет. Сначала «вам ли эта заявка», потом «а нет ли такого аппарата».
       */
      await assertNoParkDuplicate(p, candidate);
      return { equipment: null, equipmentObjectId: candidate.objectId, customerDepartmentId };
    }
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
        /*
         * Признак читается, а не дописывается условием в `WHERE`: выключенной карточке нужен СВОЙ
         * ответ. Уйди активность в отбор — она слилась бы с «не найдена», и человек искал бы
         * опечатку в выборе там, где аппарат нашёлся и стоит на месте, просто выведен из
         * эксплуатации.
         */
        isActive: officeEquipment.isActive,
      })
      .from(officeEquipment)
      .where(
        and(eq(officeEquipment.id, body.officeEquipmentId), isNull(officeEquipment.deletedAt)),
      );
    if (!equipment) {
      throw err.badRequest('Единица оргтехники не найдена', { officeEquipmentId: 'Не найдена' });
    }
    /**
     * ВЫВЕДЕННАЯ ИЗ ЭКСПЛУАТАЦИИ КАРТОЧКА ЗАЯВКУ НЕ ПРИНИМАЕТ (Н1 плана
     * `docs/office-equipment-candidate-plan.md`, §13 Ф2).
     *
     * До этой проверки `is_active` не смотрел здесь никто: сервер брал единицу по `id` и живой
     * строке, а неактивные прятал ПОРТАЛ — параметром `isActive: 'true'` у селектора формы. То
     * есть запрет держался клиентом, и обходили его двое: прямой запрос мимо портала и
     * собственный устаревший список опций в открытой форме — карточку гасят в соседней вкладке, а
     * в этой она ещё выбирается.
     *
     * **422, а не 403 и не 409.** Право заводить заявку у человека есть, и спорить не о чем — не
     * годится присланное ЗНАЧЕНИЕ: та же форма ответа, что у чужого объекта в пометке «не тот
     * объект» и у чужого подразделения заявителя. 403 сказал бы «вам не положено» тому, кому
     * положено, и отправил бы человека просить права, которых ему хватает; 409 обещал бы гонку
     * версий, которой нет, — карточку никто не менял под руками, она просто в другом состоянии.
     * Отказ поэтому называет и выход: включить карточку в справочнике, то есть тем же правом
     * `officeEquipment.write`, которым её и выключили.
     *
     * Спрашивается СРАЗУ ЗА СУЩЕСТВОВАНИЕМ и до области: состояние карточки — факт того же рода,
     * что и её наличие, а наличие соседний 400 уже раскрывает. Разбери мы сперва область, тот же
     * человек получал бы то 403 «чужая техника», то 422 в зависимости от того, чья карточка
     * выключена, — и подсказка «включите карточку» терялась бы за отказом о другом.
     *
     * ПРОВЕРКА СТОИТ ТОЛЬКО У ВХОДА. Правку заявки (`PATCH /:id`) она не трогает намеренно, и это
     * не забывчивость: единицу там не меняют вовсе, а гасят карточки как раз тогда, когда аппарат
     * уже уехал по живой заявке. Спрашивай мы активность и дальше по циклу, эти заявки застряли бы
     * на середине — ни доработать смету, ни закрыть, — и «выведен из эксплуатации» стало бы
     * приговором делу, которое ещё доводят до конца. Фикс закрывает вход, а не переписывает
     * историю.
     */
    if (!equipment.isActive) {
      throw err.unprocessable(
        'Аппарат выведен из эксплуатации: включите карточку в справочнике или выберите другой',
        { officeEquipmentId: 'Выведен из эксплуатации' },
      );
    }

    const customerDepartmentId = await resolveCustomerDepartment(p, body, equipment);
    /*
     * Где аппарат стоит на самом деле (Р16) — ДО области, а не после (план предмета заявки, Р8).
     * Порядок содержателен: пометка «не тот объект» отвечает на вопрос «какой объект получит
     * заявка», и спрашивать область раньше него значило бы судить по объекту, которого в заявке не
     * будет. Ровно это и ломало просьбу заказчика: аппарат числится на соседней площадке, стоит у
     * нас, а 403 приходил после заполнения всей формы.
     */
    const equipmentObjectId = await resolveEquipmentObject(p, body, equipment);
    /*
     * Область — по ИТОГОВОМУ объекту заявки и по её заказчику: объектная роль заводит заявку на ту
     * площадку, где заявка и будет видна, роль отдела — от имени своего отдела либо на технику
     * своего отдела. `equipmentDepartmentId` остаётся снимком КАРТОЧКИ, а не заказчика: чужой
     * отдел-владелец области не даёт (её даёт свой отдел-заказчик), но и не отнимает — иначе заявка
     * на аппарат соседнего отдела, стоящий на нашей площадке, отбивалась бы у того, кто на него
     * смотрит.
     *
     * Второй рубеж поверх разборов выше: те выбирают объект и заказчика порознь, а эта проверка
     * спрашивает у ОБЩЕГО источника области, попала ли получившаяся заявка к самому автору.
     * Разойдись они однажды — человек отправил бы заявку и не увидел её в списке.
     */
    assertServiceRequestScope(p, {
      objectId: equipmentObjectId,
      customerDepartmentId,
      equipmentDepartmentId: equipment.ownerDepartmentId,
    });
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
   * ИТ-служба здесь — не исключение из правила, а то же правило: область ПАРКА означает, что её ось
   * — вся компания, и заявку она не теряет ни при каком выборе. Тем же читаются роли без осей вовсе
   * (администратор): предикат области им ничего не сужает.
   *
   * ОСНОВАНИЕ — ОБЛАСТЬ ПАРКА, А НЕ ЛЕНТЫ ЗАЯВОК (Р9), тем же предикатом и по той же причине, что у
   * соседних разборов предмета: отдел-заказчик — это то, из чего заявку собирают, а не то, где её
   * потом ищут. Подмена ответов не меняет (оба ключа у одного набора) и стоит здесь заранее — чтобы
   * уборка `serviceRequests` из карты области в выпуске B осталась уборкой, а не тихой сменой правил
   * заведения.
   *
   * 422 с именем поля, а не 403: право заводить заявку без аппарата у человека есть — не годится
   * присланное значение. Тот же код и та же форма ответа, что у чужого объекта в пометке «не тот
   * объект» и у чужого подразделения заявителя.
   */
  async function resolveEmptySubjectCustomer(
    p: Principal,
    body: { objectId?: string; customerDepartmentId?: string | null },
  ): Promise<{ equipmentObjectId: string | null; customerDepartmentId: string | null }> {
    // Порядок тот же, что у `serviceRequestScopeWhere` и `assertServiceRequestScope`: широкая
    // область снимает ось целиком, и только под ней спрашивается роль. Источник — область ПАРКА
    // (Р9): предмет заявки берут из справочника, и спрашивать про него ленту заявок незачем.
    const wide = canPickAnyServiceSubject(p);
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
   * ОСЕЙ У ПРОВЕРКИ ДВЕ, а не одна, и вторая заведена вместе с переворотом порядка (план предмета
   * заявки, Р8). Пока область спрашивалась ДО этого разбора, отдельскую ось здесь можно было не
   * трогать: объект роли отдела не сужает ничего (`assertServiceRequestScope` судит её по отделам),
   * и заявка держалась в её области отделом-заказчиком, куда бы ни поехала пометка. Теперь по
   * ИТОГОВОМУ объекту считается сама область, и без второй оси сотрудник отдела записал бы заявку на
   * ЛЮБОЙ объект портала — заявка ушла бы на чужую стройку, где её никто не ждёт, и вернулась бы
   * оттуда только жалобой. Приём и смысл те же, что у площадки сообщения о технике
   * (`resolveCandidateObject`): объект обязан быть из площадок своих отделов (`departmentObjectIds`,
   * ADR 0062).
   *
   * Роли без осей (штаб-администратор) не сужает ничто: их область не считается ни объектом, ни
   * отделом, и запрещать им выбор значило бы отобрать поле у тех, кто заводит заявки за сотрудников.
   * Область ПАРКА открывает выбор целиком: согласующий от ИТ решает по всему парку.
   *
   * ОСНОВАНИЕ — ОБЛАСТЬ ПАРКА, А НЕ ЛЕНТЫ ЗАЯВОК (Р9): «на какой площадке числится аппарат» —
   * вопрос справочника, и ответ на него не должен зависеть от того, какие заявки субъекту видно.
   * Ответов подмена не меняет (оба ключа у одного набора), а выпуск B оставляет уборкой карты, а не
   * сменой правил заведения.
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
    // Источник и порядок те же, что у соседних разборов предмета: область ПАРКА (Р9) снимает обе
    // оси целиком, и только под ней спрашивается роль.
    const wide = canPickAnyServiceSubject(p);
    const who = p.role ? roleLabels[p.role] : 'Учётная запись';
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
    if (!wide && isObjectScopedRole(p.role) && !p.constructionObjectIds.includes(chosen)) {
      throw err.unprocessable(
        'Аппарат можно записать только на свой объект — на чужом заявку не увидит и сам заявитель',
        { objectId: 'Чужой объект' },
      );
    }
    if (!wide && isDepartmentScopedRole(p.role) && !p.departmentObjectIds.includes(chosen)) {
      throw err.unprocessable(
        `${who} записывает аппарат на площадки своего отдела: на чужой его никто не ждёт — снимите пометку, и заявка запишется туда, где аппарат числится`,
        { objectId: 'Чужая площадка' },
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
       *
       * Место строки и автор приезжают туда же (Н8): та же функция отвечает и на второй вопрос
       * двери — «заказчик ли он ЭТОЙ заявке», — а сквозная область набора заказчиком не делает.
       */
      assertServiceRequestEditable(
        p,
        { ...authorPlaceOf(row), ...(await executorsRowOf(row)), status: row.status },
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
  /**
   * СРОЧНОСТЬ — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план `docs/office-equipment-bulk-actions-plan.md`, Р2,
   * этап Э1): проверки состояния, сверка версии и журнал живут здесь, а ручка ниже только
   * разбирает тело и приводит ответ к объёму аудитории. Второго набора правил тем самым завести
   * негде — пакет позовёт этот же шаг, а не свою копию условий.
   *
   * Один шаг на два варианта команды — включение и снятие: различает их `isUrgent` в теле, пару
   * «флаг + причина» проверяет схема, и разложенное по двум функциям одно правило разъехалось бы
   * ровно на снятии, где причины не требуют вовсе.
   *
   * Полное состояние уходит наружу, а к аудитории его приводит ручка: `after` собран здесь ради
   * diff'а в журнале, и второй поход за ним был бы лишним запросом, а пакету проекция карточки
   * не нужна вовсе.
   */
  async function urgencyStep(
    p: Principal,
    id: string,
    body: z.infer<typeof setServiceUrgencySchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<ServiceRequestDto> {
    const row = await requireEditable(p, id);
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
    await bulk.runTx(async (tx) => {
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
      /*
       * ПРИПИСКА ПАЧКИ (Р8) — последним ключом и только когда пачка есть: `bulk.audit` вне пачки
       * пуст, и metadata одиночной ручки остаётся прежней до буквы. Так журнал отвечает на вопрос
       * «эти двадцать записей сделаны одним движением», не заводя записи «выполнена пачка».
       */
      metadata: {
        changes: diffServiceRequests(before, after),
        isUrgent: after.isUrgent,
        ...bulk.audit,
      },
    });
    return after;
  }

  r.patch(
    '/:id/urgency',
    { ...canUrgency, schema: { params: idParams, body: setServiceUrgencySchema } },
    async (req) => {
      const after = await urgencyStep(requirePrincipal(req), req.params.id, req.body);
      // Наружу — в объёме аудитории: полное `after` собрано ради журнала, а не ради ответа.
      return forAudience(after);
    },
  );

  // ── Мягкое удаление: заявка уходит в архив ──
  /**
   * АРХИВИРОВАНИЕ — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап Э1): своё правило
   * удаления, мягкое снятие и журнал. Ручка ниже только отвечает `{ ok: true }`.
   *
   * Тела у ручки нет вовсе — поэтому нет его и у шага. Сверки версии здесь тоже нет, и это
   * сегодняшнее поведение, а не упущение выделения (Н6 того же плана): условие `WHERE` спрашивает
   * только «жива ли». Завести её заодно значило бы спрятать новое правило в рефакторинг, у
   * которого весь смысл — не менять ничего.
   */
  async function archiveStep(
    p: Principal,
    id: string,
    /**
     * Версия — НЕОБЯЗАТЕЛЬНАЯ у одиночной ручки и обязательная у пачки (Н6, Р4). Присланная
     * сверяется, отсутствующая означает сегодняшнее поведение: портал прежнего выпуска её не шлёт,
     * и требовать её сразу значило бы сломать работающую дверь ради новой.
     */
    version: number | undefined,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<void> {
    const row = await requireEditable(p, id);
    // Своё правило, а не «то же, что правка» (В20): «Назначенную» ещё удаляют — работа по ней не
    // начиналась, — а править её уже нельзя. Сторона заказчика при этом спрашивается та же, что у
    // правки (Н8): в архив уводят свою заявку либо заявку своей площадки или отдела.
    assertServiceRequestDeletable(p, { ...authorPlaceOf(row), status: row.status });
    const now = new Date();
    /*
     * Транзакция здесь появилась не ради самой правки — она одна, — а ради пачки: мутация и
     * отметка о ней (checkpoint) обязаны быть неразделимы (Р7). У одиночной ручки `bulk.runTx` —
     * обычная `db.transaction`, и наблюдаемое поведение прежнее.
     */
    await bulk.runTx(async (tx) => {
      const [archived] = await tx
        .update(serviceRequests)
        .set({ deletedAt: now, deletedBy: p.id, updatedAt: now, version: row.version + 1 })
        .where(
          and(
            eq(serviceRequests.id, row.id),
            isNull(serviceRequests.deletedAt),
            // Сверка версии — только если её прислали (Н6). Добавленная безусловно, она отбила бы
            // сегодняшний портал, который её не шлёт вовсе.
            ...(version === undefined ? [] : [eq(serviceRequests.version, version)]),
          ),
        )
        .returning({ id: serviceRequests.id });
      if (!archived && version !== undefined) throw err.conflict();
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'serviceRequest.soft_delete',
      entityType: 'serviceRequest',
      entityId: row.id,
      metadata: { num: row.num, status: row.status, ...bulk.audit },
    });
  }

  /**
   * Версия приходит ПАРАМЕТРОМ ЗАПРОСА, а не телом (Р4, находка Н6): тела у `DELETE` нет вовсе, и
   * заводить его ради одного числа значило бы вводить в модуль приём, которого он не знает ни в
   * одной ручке. Поле необязательное: портал прежнего выпуска версии не шлёт, и присланная —
   * сверяется, отсутствующая означает сегодняшнее поведение. Обязательным оно станет выпуском B,
   * когда портал начнёт слать её всегда.
   */
  r.delete(
    '/:id',
    { ...canDelete, schema: { params: idParams, querystring: archiveVersionQuery } },
    async (req) => {
      await archiveStep(requirePrincipal(req), req.params.id, req.query.version);
      return { ok: true };
    },
  );

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
   * **ИСКЛЮЧЕНИЙ БОЛЬШЕ НЕТ: статуса не меняет и переназначение из «В работе»** (просьба
   * администраторов и «Ведения» оргтехники от 14.09.2026, ADR 0187). Прежде эта ручка возвращала
   * работающую заявку в «Новую» — чтобы новый исполнитель нажал «Принять в работу» сам и не
   * наследовал чужое «взялся». Довод верен для ПЕРЕДАЧИ заявки другому, но ручка одна на все
   * правки состава, и отличить их по статусу нечем: добавление второго сисадмина к первому
   * откатывало заявку ровно так же, как замена. На практике это и было главным случаем — работа
   * идёт, человека добавляют в помощь, а заявка падает в «Новую» и обнуляет ход.
   *
   * Цена решения названа и принята: новый исполнитель получает заявку сразу «В работе», и отказ
   * (`canDeclineServiceRequest`, статус «Новая») ему закрыт. Путь назад остался ручной —
   * «Вернуть в «Новую»» у того, кто заявку ведёт.
   *
   * Возраст в текущем ожидании обнуляется всегда (`touchStatusAt`, Р4) — и на первом назначении, и
   * на переназначении: сторона у второго та же, а ждут после него другого, и унаследованный возраст
   * соврал бы о нём в очереди «кто тянет».
   *
   * Порядок блокировок общий для назначения, отказа и смены статуса (Н5): сначала `FOR UPDATE`
   * строки заявки, затем работа со строками исполнителей. Никогда наоборот — иначе назначение,
   * идущее «от исполнителей», встречается со сменой статуса, идущей «от заявки».
   */
  /**
   * НАЗНАЧЕНИЕ — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап Э1): предикат, дельта
   * состава, письмо, транзакция и журнал. Ручка ниже разбирает тело и собирает ответ «заявка плюс
   * исход письма».
   *
   * Исход письма шаг отдаёт как есть, а карточку не собирает: перечитывать заявку ради ответа —
   * дело ручки, и пакету, у которого ответ построчный, эта работа не нужна.
   */
  async function assignStep(
    p: Principal,
    id: string,
    body: z.infer<typeof putServiceExecutorsSchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<ModuleMailOutcome> {
    const row = await requireEditable(p, id);
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
    //
    // Ожидание берётся ДЕЙСТВУЮЩЕЕ — той же функцией, что спрашивает предикат ниже (Р5, Н11):
    // историческое предъявление внутренней заявки ответа больше не ждёт (согласовать её после Р5
    // некому), и запирать им переназначение значило бы оставить такую заявку за прежним
    // исполнителем навсегда — ручного возврата сметы в правку у неё тоже нет.
    if (serviceRequestHasEffectivePendingEstimate(row)) {
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
    /*
     * Тот же состав — не назначение, а повтор нажатия, и отвечает на него отказ В ЛЮБОМ СТАТУСЕ.
     *
     * Оговорка `row.status === 'new'` стояла здесь потому, что из «В работе» тот же состав означал
     * осмысленный ход: заявка уходила в «Новую», то есть возвращалась к назначенным. Отката больше
     * нет (ADR 0187), и оставленная оговорка пропускала бы запрос, которому нечего делать: он
     * обнулил бы возраст ожидания, отправил исполнителям письмо-задание по заявке, которую они и
     * так ведут, и положил в ленту событие без изменений.
     */
    if (!changed) {
      throw err.unprocessable('Эти исполнители уже назначены на заявку');
    }
    /*
     * ПРИЧИНА ПЕРЕНАЗНАЧЕНИЯ БОЛЬШЕ НЕ ОБЯЗАТЕЛЬНА (план свободного объёма работ, Р6; пункт 3
     * разбора заказчика от 09.09.2026: «убрать звёздочку — сделать необязательным, в истории
     * ставить прочерк»). Прежде здесь стоял отказ 422 «Укажите причину переназначения», и он
     * означал, что заявку нельзя передать другому, пока не сочинишь объяснение: половина
     * переназначений идёт по расписанию отпусков и сменам зон ответственности, где объяснять
     * нечего, и поле заполнялось словом «переназначение».
     *
     * Признак `first` остался и работает: по нему различаются событие аудита (`assign` против
     * `reassign`) и адресаты письма. Отменилось ровно одно — требование текста.
     *
     * Пустая причина видна в ленте прочерком «—» и только у события `serviceReassigned`: у прочих
     * видов пустой комментарий означает «сказать нечего», и общий прочерк стёр бы эту разницу.
     */

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
     * Стирается поэтому не на всякой правке состава, а когда заявка меняет руки: сняли поимённого
     * исполнителя либо изменился подрядчик. Добавление второго сисадмина к первому чужого счёта не
     * обесценивает и смету не трогает.
     *
     * УСЛОВИЕ ПОДРЯДЧИКА — ПРОСТО «ИЗМЕНИЛСЯ» (Р9, Н10 плана
     * `docs/office-equipment-card-and-list-cleanup-plan.md`), без прежнего `row.serviceCounterpartyId
     * !== null`. Та половина пропускала переход `NULL → service` при сохранённом составе своих
     * исполнителей: заявку вёл сисадмин, объём работ по ней составлен до этой волны, — и
     * назначенный подрядчик наследовал ЧУЖОЙ внутренний объём работ вместе с его ценами, начиная
     * коммерческий этап с готовой сметы, которой он не писал. Первое назначение условие тоже
     * проходит, но сбрасывать при нулевой ревизии нечего.
     *
     * НОВАЯ ВЕТКА ОТКАЗА, И ОНА ПРИНЯТА (Н19): сброс идёт через `assertEstimateReplaceable`, а та
     * запрещает менять состав объёма работ, по строкам которого уже обратились по гарантии. Путь
     * достижим — `accepted → done → in_work` административными откатами и затем назначение
     * подрядчика, — и такое назначение получит `409` с текстом про гарантийные обращения. Строки,
     * на которые ссылается гарантийная претензия, не стираются ни при каких переназначениях;
     * сегодняшний `service A → service B` ведёт себя ровно так же.
     */
    const handedOver = removed.length > 0 || counterpartyChanged;

    /**
     * Куда уходит заявка — НИКУДА (ADR 0187): назначение статуса не меняет ни при каком исходе.
     * Здесь стояло `row.status === 'in_work' ? 'new' : row.status`, и это была единственная строка,
     * откатывавшая работающую заявку при правке состава исполнителей.
     *
     * Помощник перехода при этом остаётся: он сверяет версию, пишет строку истории `from = to`,
     * обнуляет возраст ожидания (`touchStatusAt`) и отправляет письмо — всё это назначению нужно
     * независимо от того, движется статус или нет. `to` живёт отдельной переменной, а не подставлен
     * в вызов, ровно затем, чтобы этот абзац было к чему прикрепить.
     */
    const to: ServiceRequestStatus = row.status;

    const applied = await bulk.runTx(async (tx, bulkMail) => {
      const locked = await lockRequest(tx, row.id);

      /**
       * СОСТАВ ПРОВЕРЯЕТСЯ ЗДЕСЬ, А НЕ ДО ТРАНЗАКЦИИ (Р7). Кандидаты приезжают из окна, открытого
       * когда угодно, и «он был пригоден, когда я открывал список» доказательством не является:
       * набор отбирают ровно между открытием окна и нажатием кнопки, и проверка, сделанная до
       * `lockRequest`, записала бы исполнителя, который к `COMMIT` уже ничего не может. Под
       * блокировкой заявки состав и проверяется, и пишется — разъехаться им нечем.
       *
       * Проверяется ВЕСЬ присланный состав, а не одни добавленные: тело задаёт состав целиком, и
       * оставшийся в нём мёртвый исполнитель проехал бы молча — вместе с заявкой, которую он не
       * откроет.
       */
      const executors = await resolveNamedExecutors(userIds, locked, tx);

      /**
       * Строки исполнителей пишутся **до** `applyTransition`: письмо собирается внутри той же
       * транзакции и читает исполнителей из таблицы. Вставь мы их после — задание ушло бы без
       * половины адресатов либо вовсе без них.
       *
       * Отложенный `service_requests_executor_present` этому не мешает: он проверяет состояние к
       * концу транзакции, каким бы ни был порядок шагов внутри.
       */
      if (removed.length > 0) {
        // След снятия — ВТОРАЯ ветка (Р5) и главная по частоте: заявку передали другому, и прежний
        // исполнитель обязан дочитать её историю. Пишется до `DELETE`, в той же транзакции: откат
        // переназначения обязан откатывать и след, иначе заявка осталась бы видна тому, с кого её
        // так и не сняли.
        await markPastExecutors(tx, locked.id, removed, p.id);
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
      // `!first` здесь не проверяется, и это по-прежнему не пропуск — хотя довод сменился вместе с
      // Р9. Прежде `handedOver` был ложен у первого назначения по построению; теперь первое
      // назначение подрядчика его проходит, и сброс отрабатывает вхолостую: ревизия у такой заявки
      // нулевая, строк нет, снимать нечего. Добавь мы `!first`, условие сброса читалось бы как
      // правило «первому не сбрасываем», которого нет, — и прятало бы настоящее: смета живёт, пока
      // заявка у того, кто её писал.
      if (handedOver) {
        await assertEstimateReplaceable(tx, locked.id);
        await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, locked.id));
        // Вторая и последняя дорога к полному сбросу — и ревизии снимаются здесь по той же причине,
        // что и в сбросе по переходу: нумерация начинается заново, а прежние номера заняты.
        await dropEstimateRevisions(tx, locked.id);
        patch.estimateRevision = 0;
        patch.estimateSubmittedAt = null;
        patch.estimatedTotalAmount = null;
        // Ревизия уходит в `0`, и оставленное предъявление уронило бы саму запись
        // (`service_requests_estimate_pending_check` требует их равенства). До этой строки оно
        // тут и не окажется — переназначение под висящим предъявлением запрещено предикатом
        // выше, — но защита не должна держаться на выводе о соседней проверке (Р2).
        patch.estimatePendingRevision = null;
        // Происхождение ожидания и источник подписи — вместе с тем, что они описывают (Н4): у
        // заявки, переданной другому подрядчику, не должно остаться ни «принято без согласования»,
        // ни «ожидание открыто спором».
        patch.estimatePendingSource = null;
        patch.approvedEstimateRevision = null;
        patch.estimateApprovedBy = null;
        patch.estimateApprovedAt = null;
        patch.estimateApprovalSource = null;
      }

      const transition = await applyTransition(tx, {
        row: locked,
        to,
        version: body.version,
        actor: p,
        /*
         * В ИСТОРИЮ УХОДИТ ТОЛЬКО ПРИЧИНА (Р6). Прежняя подмена `body.reason ?? body.comment`
         * решала одну задачу — не оставить строку истории пустой, — и делала это чужим текстом:
         * «Комментарий исполнителю» пишут НОВОМУ исполнителю про работу, а лента показывала его
         * как объяснение, почему заявку отобрали у прежнего. Причина стала необязательной, и
         * подмена превратилась бы из спорной в прямо неверную: у переназначения без причины лента
         * обязана показать прочерк, а не подставленное задание.
         */
        comment: body.reason,
        patch,
        // Возраст обнуляется и при `to === from`: сторона та же, а ждут другого (Р4).
        touchStatusAt: true,
        mail: mailPlan,
        bulkMail,
      });
      // Состав уезжает наружу вместе с исходом письма: журнал пишется ПОСЛЕ транзакции
      // (`writeAudit` ходит мимо неё), а имена в нём — те самые, что проверены под блокировкой.
      return { mail: transition.mail, executors };
    });
    const mailResult = applied.mail;
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
        executors: applied.executors.map((e) => e.fullName),
        added: added.length,
        removed: removed.length,
        reason: body.reason ?? '',
        /*
         * «Комментарий исполнителю» — в журнал (Н11). До этой строки он не сохранялся НИГДЕ: в
         * письмо-задание он не попадал, а единственным его читателем была подмена текста истории
         * выше, которую Р6 отменяет. То есть человек писал новому исполнителю задание, нажимал
         * «Сохранить» — и текст исчезал без следа. Довести его до письма — работа почтового контура
         * (§9 плана), а до тех пор он обязан хотя бы оставаться в журнале: по нему видно, что
         * распоряжение отдавали.
         */
        comment: body.comment,
        ...bulk.audit,
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
        metadata: { event: 'service_request_assigned', ...bulk.audit },
      });
    }
    return mailResult?.outcome ?? 'not_needed';
  }

  r.put(
    '/:id/executors',
    { ...canAssign, schema: { params: idParams, body: putServiceExecutorsSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const mail = await assignStep(p, req.params.id, req.body);
      return { request: (await getDto(p, req.params.id))!, mail };
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
   * Заявка в том объёме, которым решается пригодность кандидата: кому она отдана компанией. Больше
   * от неё ничего и не нужно — статус и состояние спрашивает `canAssignServiceExecutors` до всякой
   * пригодности.
   */
  type NamedExecutorTarget = Pick<RequestRow, 'serviceCounterpartyId'>;

  /**
   * Учётка в объёме, которым отвечают на «сможет ли работать»: субъект доступа плюс его контрагент.
   * `Principal` подходит целиком; списку кандидатов принципал на каждую строку не нужен — он
   * собирает тот же субъект одной выборкой (`accessSubjectColumns`).
   */
  interface ExecutorCandidate extends AccessSubject {
    counterpartyId: string | null;
  }

  /** Модель назначения: строка появилась, компания заявки не менялась. */
  const NAMED_ASSIGNMENT: ServiceExecutorAssignment = {
    isNamedExecutor: true,
    actsForAssignedCounterparty: false,
  };

  /** Что именно мешает назначить — причина, а не текст: текст у неё свой в каждом случае. */
  type NamedExecutorObstacle =
    'inactive' | 'contractor' | 'assignedContractor' | 'noExecute' | 'noRead';

  /**
   * Отказ по каждой причине. Текст называет **человека**, а не право: назначающий видит список
   * фамилий, и «у учётки нет полномочия» без имени не подскажет, кого из пятерых убрать. Поле
   * формы своё у каждой причины — окно подсвечивает выбор, а не форму целиком.
   */
  const NAMED_EXECUTOR_REFUSAL: Record<
    NamedExecutorObstacle,
    { text: (name: string) => string; field: string }
  > = {
    inactive: {
      text: (name) => `${name} — учётка закрыта или неактивна, назначить её нельзя`,
      field: 'Учётка неактивна',
    },
    contractor: {
      text: (name) =>
        `${name} работает от сервисной компании — её назначают компанией целиком, а не поимённо`,
      field: 'Подрядчика назначают компанией',
    },
    assignedContractor: {
      text: (name) =>
        `${name} работает от сервисной компании, уже назначенной на заявку: подрядчик ведёт её ` +
        'компанией, и поимённая строка ему ничего не добавит',
      field: 'Подрядчик уже назначен',
    },
    noExecute: {
      text: (name) =>
        `${name} не может быть исполнителем заявки оргтехники — у учётки нет такого полномочия`,
      field: 'Нет полномочия исполнителя',
    },
    noRead: {
      text: (name) => `${name} не открывает заявки на обслуживание — назначенный не увидит и своей`,
      field: 'Нет доступа к заявкам',
    },
  };

  /**
   * ЧТО МЕШАЕТ ПОСТАВИТЬ ЭТУ УЧЁТКУ ПОИМЁННЫМ ИСПОЛНИТЕЛЕМ ЭТОЙ ЗАЯВКИ — весь ответ целиком (план
   * аудита исполнителей, Р7). Отдельной функцией от `resolveNamedExecutors`, потому что спрашивают
   * её двое: сама ручка назначения и список кандидатов, — а разойдись они, окно предлагало бы
   * человека, которому назначение ответит 422.
   *
   * ПРАВИЛО МОДЕЛИРУЕТ СОСТОЯНИЕ «НАЗНАЧЕН» (`isNamedExecutor: true`) и спрашивает у модели один
   * вопрос: становится ли субъект стороной исполнителя, когда строка появится. Отвечает на него
   * общий предикат модуля (`isServiceExecutor`), а не здешняя формула из прав: «чей это ход»
   * записано в контрактах один раз, и второй ответ рядом разъехался бы с коридором молча.
   *
   * ОБЫЧНОЙ ПРОВЕРКИ ВИДИМОСТИ ЗДЕСЬ НЕТ, И ЭТО ГЛАВНОЕ. `assertServiceRequestVisible` отверг бы
   * кандидата вне его объектной или отдельской области — то есть отменил бы третью ось (Р1), ради
   * которой всё и делалось: назначение как раз и ОТКРЫВАЕТ заявку сисадмину соседней площадки.
   * Спрашивать «видит ли он её сейчас» бессмысленно и по существу: с `execute` и строкой назначения
   * он увидит любую, — то есть ответ известен заранее и не проверяет ничего.
   *
   * ВТОРАЯ ОСЬ МОДЕЛИ ПУСТАЯ (`actsForAssignedCounterparty: false`), и заявка — параметр как раз
   * поэтому: поимённая строка компанию на заявку не ставит, а сотруднику подрядчика сторону даёт
   * договор и снимает отказ компании целиком. Достроив модель контрагентом заявки, мы завели бы
   * поимённую строку там, где её не бывает вовсе, — и снять её было бы нечем.
   *
   * Пустая учётка (`null`) — это «закрыта или неактивна»: так отвечает `loadPrincipal`.
   */
  function namedExecutorObstacle(
    candidate: ExecutorCandidate | null,
    row: NamedExecutorTarget,
  ): NamedExecutorObstacle | null {
    if (!candidate) return 'inactive';
    /*
     * Подрядчик отбивается ПЕРВЫМ, хотя модель ниже отбила бы его тоже: `serviceRequests.execute` в
     * наборе типа контрагента `service` нет и не появится, и общий отказ сказал бы ему «нет
     * полномочия» — то есть предложил бы это полномочие выдать. Причина другая и решением своим:
     * поимённых строк у сотрудников подрядчика не бывает вовсе.
     *
     * Заявка спрашивается здесь: у кандидата от УЖЕ назначенной компании сторона исполнителя есть и
     * без строки, и поимённая запись добавила бы к ней только то, чего отказ подрядчика (он снимает
     * компанию целиком) потом не уберёт.
     */
    if (actsForCounterparty(candidate, 'service')) {
      const own =
        candidate.counterpartyId !== null && candidate.counterpartyId === row.serviceCounterpartyId;
      return own ? 'assignedContractor' : 'contractor';
    }
    // Право — через МОДЕЛЬ: «назначен и может» это ровно `isServiceExecutor` при
    // `isNamedExecutor: true`. Пара «назначение + право» (И1) здесь и живёт: одного права мало
    // никогда, но и одной строки без права — тоже.
    if (!isServiceExecutor(candidate, NAMED_ASSIGNMENT)) return 'noExecute';
    /*
     * Читать заявки — вторая половина «сможет работать», и без неё исполнитель выходит мёртвым по
     * другой причине: третья ось откроет ему строку, а страж маршрута (`serviceRequests.read`)
     * не пустит к карточке — 403 на собственной заявке, о которой пришло письмо-задание. Сегодня
     * такой набор в каталоге не собран, но собирается руками (ADR 0106), и держаться на том, что
     * его никто не собрал, эта проверка не должна.
     */
    if (!can(candidate, 'serviceRequests.read')) return 'noRead';
    return null;
  }

  /** Пригоден ли кандидат — та же проверка, повёрнутая к списку: ему причина не нужна. */
  function canBecomeNamedExecutor(
    candidate: ExecutorCandidate | null,
    row: NamedExecutorTarget,
  ): boolean {
    return namedExecutorObstacle(candidate, row) === null;
  }

  /**
   * Состав поимённых исполнителей, проверенный по одному. Зовётся **внутри транзакции, после
   * `lockRequest`** (Р7): список, открытый в окне полчаса назад, доказательством не является, а
   * право отбирают ровно между открытием окна и нажатием кнопки. Перечитанный под блокировкой, он
   * отвечает про то состояние, которое и будет записано.
   *
   * Права считаются полной сборкой субъекта (`loadPrincipal`) — той же, что отвечает на каждом
   * запросе: право приходит четырьмя источниками (роль, тип контрагента, надстройка, набор), и
   * собрать их вторым способом значило бы завести вторую матрицу доступа. Запрос на учётку — цена
   * назначения, а не списка: назначают редко и не больше двух десятков разом.
   *
   * `loadPrincipal` ходит общим пулом, а не транзакцией, и это не дыра в Р7: наборы лежат в
   * СОСЕДНИХ таблицах, блокировка заявки их всё равно не держит, а на READ COMMITTED свежий
   * оператор видит последнее зафиксированное состояние. Блокировка нужна другому — чтобы состав,
   * проверенный здесь, не разъехался с составом, который тут же и пишется.
   */
  async function resolveNamedExecutors(userIds: string[], row: NamedExecutorTarget, exec: Tx) {
    if (userIds.length === 0) return [];
    const rows = await exec
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, userIds));
    const byId = new Map(rows.map((user) => [user.id, user]));
    const resolved: { id: string; fullName: string }[] = [];
    for (const id of userIds) {
      const user = byId.get(id);
      if (!user) throw err.badRequest('Учётная запись не найдена', { userIds: 'Не найдена' });
      const obstacle = namedExecutorObstacle(await loadPrincipal(id), row);
      if (obstacle) {
        const refusal = NAMED_EXECUTOR_REFUSAL[obstacle];
        throw err.unprocessable(refusal.text(user.fullName), { userIds: refusal.field });
      }
      resolved.push(user);
    }
    return resolved;
  }

  // ── Назначение контрагента: совместимый адаптер выпуска 1 ──

  // ── Виза отдела ИТ упразднена (Р10) ──
  /**
   * Ручка `PATCH /:id/it-approval` снята вместе с самой визой: согласует объём работ назначенный
   * сотрудник, и вопрос «чинить или менять» задаёт себе тот же человек, что смотрит на счёт (ответ
   * В2). Двух подписей по порядку больше нет, коридора визы нет вовсе, третья ось очереди ушла
   * вместе с ней.
   *
   * Поля `it_approved_*` при этом остались снимком истории — подпись от 22.08 правдива, и стирать
   * её нечем: карточка показывает её по-прежнему, а решающих мест у неё больше нет. Право
   * `serviceRequests.approveIt` из наборов убрано отдельным выпуском (план профилей оргтехники,
   * Э9, миграция E) — сперва сторона обсуждения переехала на код набора, потом уборка; в словаре и
   * в матрице администратора право осталось.
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
          // След снятия — ТРЕТЬЯ ветка (Р5): исполнитель снял с заявки себя сам. Заявку он всё
          // равно дочитывает: по ней написана его же переписка, и вопрос от заказчика приходит
          // после отказа не реже, чем до.
          await markPastExecutors(tx, locked.id, [p.id], p.id);
          await tx
            .delete(serviceRequestExecutors)
            .where(
              and(
                eq(serviceRequestExecutors.requestId, locked.id),
                eq(serviceRequestExecutors.userId, p.id),
              ),
            );
        } else if (!wholeCounterparty) {
          // ЧЕТВЁРТАЯ ветка (Р5), и легче всего было потерять именно её: отказ «за всех» — путь
          // администратора, доводящего чужую заявку, и снимает он состав целиком. Логических путей
          // снятия три, а веток `DELETE` четыре ровно из-за этой развилки внутри отказа.
          await markAllPastExecutors(tx, locked.id, p.id);
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
  /**
   * «ПРИНЯТЬ В РАБОТУ» — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап Э1): отсев
   * стороны, состав исполнителей, коридор, предикат назначенного и сам переход. Ручка ниже только
   * отдаёт карточку.
   */
  async function startStep(
    p: Principal,
    id: string,
    body: z.infer<typeof startServiceRequestSchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<void> {
    assertSideAllowed(p, id, 'in_work', ['new']);
    const row = await requireEditable(p, id);
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
    assertTransition(p, row.id, row.status, 'in_work', assignment);
    if (!canStartServiceWork({ ...executors, status: row.status }, p, assignment)) {
      const who = p.role ? roleLabels[p.role] : 'Учётная запись';
      throw err.forbidden(`${who} не берёт эту заявку в работу — это шаг назначенного исполнителя`);
    }
    // Приняли в работу — событие переходов (№ 4): службе и стороне заявки, кроме того, кто нажал.
    const mailPlan = await prepareTransitionMail('in_work', p, row.createdBy);
    // `bulkMail` — сток письма: `null` у одиночной ручки, пачка передаёт свой (Р10).
    await bulk.runTx(async (tx, bulkMail) => {
      await applyTransition(tx, {
        row,
        to: 'in_work',
        version: body.version,
        actor: p,
        mail: mailPlan,
        bulkMail,
      });
    });
  }

  r.patch(
    '/:id/start',
    { ...canExecutorStatus, schema: { params: idParams, body: startServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      await startStep(p, req.params.id, req.body);
      return (await getDto(p, req.params.id))!;
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
  /**
   * ЗАМОРОЗКА — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап Э1): право заморозки,
   * коридор, переход с парой «откуда и почему» и журнал. Ручка ниже только отдаёт карточку.
   */
  async function holdStep(
    p: Principal,
    id: string,
    body: z.infer<typeof serviceHoldSchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<void> {
    assertCanHold(p, 'откладывает заявку');
    assertSideAllowed(p, id, 'on_hold');
    const row = await requireEditable(p, id);
    assertTransition(p, row.id, row.status, 'on_hold');
    // Заморозка — событие переходов: причина обязательна по схеме и уходит строкой письма.
    const mailPlan = await prepareTransitionMail('on_hold', p, row.createdBy);
    await bulk.runTx(async (tx, bulkMail) => {
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
        bulkMail,
      });
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'serviceRequest.hold',
      entityType: 'serviceRequest',
      entityId: row.id,
      // Откуда отложили — в metadata: после возврата заявка этого уже не помнит, поля чистятся.
      metadata: { from: row.status, reason: body.reason, ...bulk.audit },
    });
  }

  r.patch(
    '/:id/hold',
    { ...canHold, schema: { params: idParams, body: serviceHoldSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      await holdStep(p, req.params.id, req.body);
      return (await getDto(p, req.params.id))!;
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
  /**
   * ВОЗВРАТ В РАБОТУ — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап Э1): предикат
   * права, цель из самой заявки, переход и журнал. Ручка ниже только отдаёт карточку.
   */
  async function resumeStep(
    p: Principal,
    id: string,
    body: z.infer<typeof serviceResumeSchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<void> {
    if (!canResumeService(p)) {
      const who = p.role ? roleLabels[p.role] : 'Учётная запись';
      throw err.forbidden(
        `${who} не возвращает отложенную заявку в работу — это шаг того, кто её ведёт`,
      );
    }
    const row = await requireEditable(p, id);
    const target = serviceResumeTarget(row);
    if (!target) {
      throw err.unprocessable(
        `Заявка не отложена — она в статусе «${serviceRequestStatusLabels[row.status]}»`,
        { status: 'Заявка не отложена' },
      );
    }
    /**
     * ОБЫЧНЫЙ ВОЗВРАТ НЕ РАЗРЕШАЕТ СПОР (Р9 плана освобождения от согласования). Заявку,
     * остановленную спором об освобождении, отпускает только исход разбора
     * (`PATCH /:id/estimate/dispute/resolution`): он решает, останется ли освобождение, соберут ли
     * подпись и не отменят ли заявку вовсе, — а возврат просто вернул бы её в прежний статус, оставив
     * спор открытым. Заявка работала бы дальше с автоподписью, которую кто-то оспорил и не закрыл.
     *
     * ВИД ЗАМОРОЗКИ, А НЕ СТРОКА СПОРА, и это дешевле на одно чтение ровно потому, что вид гасится
     * вместе с остальными полями заморозки (матрица сбросов): у отложенной заявки «вид есть» и
     * «спор открыт» — одно и то же состояние, а у любой другой вид пуст.
     *
     * ЗАПРЕТ РАБОТАЕТ И В ПАЧКЕ: через эту функцию идёт и массовый возврат (`resumeStep` зовёт
     * строка пачки), и другого входа в возврат у модуля нет.
     *
     * Гонку с открытием спора, случившимся между этим чтением и `COMMIT`, закрывает сверка версии в
     * `applyTransition`: открытие спора двигает версию заявки, и опоздавший возврат получит 409.
     *
     * 422, А НЕ 409, И РЕШАЕТ ЭТО ОТЧЁТ ПАЧКИ. Строка под руками не менялась — у заявки просто
     * другое состояние, у которого своё действие; а пачка переводит 409 в код `version` с текстом
     * «строка изменилась» и СВОЙ текст отказа при этом теряет (`classify` в `service-request-bulk`).
     * Оператор массового возврата прочитал бы «обновите список» вместо «по заявке идёт спор» — то
     * есть обновлял бы страницу по кругу. 422 приезжает кодом `blocked` и этой самой строкой.
     */
    if (row.holdKind === SERVICE_ESTIMATE_DISPUTE_HOLD_KIND) {
      throw err.unprocessable(
        'Заявка остановлена спором об освобождении от подписи — её отпускает решение по спору, а не возврат в работу',
        { status: 'По заявке идёт спор' },
      );
    }
    // Возврат к работе — событие переходов; куда именно вернули, знает `serviceResumeTarget`.
    const mailPlan = await prepareTransitionMail(target, p, row.createdBy);
    await bulk.runTx(async (tx, bulkMail) => {
      await applyTransition(tx, {
        row,
        to: target,
        version: body.version,
        actor: p,
        comment: body.comment,
        mail: mailPlan,
        bulkMail,
      });
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'serviceRequest.resume',
      entityType: 'serviceRequest',
      entityId: row.id,
      // Куда вернули: в самой заявке после возврата от заморозки не остаётся ничего.
      metadata: { to: target, ...bulk.audit },
    });
  }

  r.patch(
    '/:id/resume',
    { ...canHold, schema: { params: idParams, body: serviceResumeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      await resumeStep(p, req.params.id, req.body);
      return (await getDto(p, req.params.id))!;
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
      assertEstimateApplies(row, 'править');
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

  // ── Раскладка свободной записи по графам ──
  /**
   * **Перенос присланного подрядчиком перечня в графы** (план свободного объёма работ, Р2; ответ В9
   * заказчика от 09.09.2026). Подрядчик присылает объём работ письмом — одной записью с общей
   * стоимостью, — исполнитель кладёт её в смету свободной строкой, а «Ведение» позже раскладывает
   * ту же сумму по позициям: услуги, запчасти, количества, гарантии.
   *
   * СВОЯ ДВЕРЬ И СВОЁ ПРАВО, А НЕ ВЕТКА В `PUT /:id/estimate`. Ту открывает `serviceRequests.estimate`
   * — АВТОР объёма работ, исполнитель, — и правит он свой черновик. Эту открывает
   * `serviceRequests.estimateRewrite`, которое уходит в набор «Ведение» и больше никуда, и по
   * СОГЛАСОВАННОЙ ревизии она делает другое: переиздаёт документ. Одна ручка на две работы означала
   * бы, что право на правку черновика молча включает право переиздать подписанное.
   *
   * **ПОРЯДОК ПРОВЕРОК: предмет → статус заявки → состояние ревизии.**
   *
   *   1. `assertEstimateApplies` — у внутренней заявки объёма работ не бывает вовсе (ADR 0174):
   *      раскладывать нечего, и вопрос про ревизию к ней неприменим;
   *   2. **статус заявки**, и он стоит ДО веток по состоянию ревизии (находка второго ревью плана).
   *      И предъявление, и согласование требуют «В работе» (`canSubmitServiceEstimate`,
   *      `canApproveServiceEstimate`), поэтому раскладка, сделанная в «Отложена», создала бы
   *      предъявление, которое НЕКОМУ ПОДПИСАТЬ: кнопки согласования у такой заявки нет вовсе.
   *      Отложенную сперва возобновляют, закрытую не раскладывают (Н4 — после закрытия строки несут
   *      факт и гарантии, на которые ссылаются гарантийные обращения), а у «Новой» объёма работ ещё
   *      нет;
   *   3. **состояние ревизии** — тремя ветками, см. ниже.
   *
   * **ЧЕРНОВИК** (не предъявлен, не согласован) — состав заменяется, номера и подписи не трогаются:
   * ровно то же, что делает исполнитель обычной ручкой.
   *
   * **ПРЕДЪЯВЛЕН И ЖДЁТ ОТВЕТА — 409**, тот же замок, что у обычной правки: согласующий подписал бы
   * не то, что видел. Ждать ответа тут недолго, а альтернатива — молча подменить предмет подписи.
   *
   * **СОГЛАСОВАН — переиздание документа**: ревизия `+1`, снимок согласования снят, итог пересчитан
   * по строкам, поставлено новое предъявление. Инвариант ADR 0133 («единственный путь изменить
   * согласованную смету — вернуть её в правку») от этого не нарушается, а исполняется: подписанное
   * содержимое под ПРЕЖНЕЙ ревизией не меняется ни на строку. Равенство суммы защитой не является —
   * под тем же итогом можно заменить услуги запчастями и переписать гарантии, а подпись стоит под
   * предметом, а не под числом.
   *
   * ПРЕДЪЯВЛЕНИЕ СТАВИТ САМА РУЧКА, И ЭТО НАМЕРЕННО. Действие равно связке «вернуть в правку →
   * заменить состав → предъявить», но у «Ведения» нет прав ни на `reopen`, ни на `submit`: заявка,
   * оставленная без предъявления, повисла бы без подписи и без очереди, а вернуть её в оборот было
   * бы некому. Письмо о предъявлении уходит обычным событием — подпись действительно требуется
   * заново, и узнать об этом обязаны те же, кто узнаёт о предъявлении исполнителя.
   *
   * СОСТОЯНИЕ РЕШАЕТСЯ ДО ТРАНЗАКЦИИ, А ДЕРЖИТСЯ ВЕРСИЕЙ — тот же приём, что у назначения: между
   * чтением и записью помещается чужое согласование, но всякое из них поднимает версию заявки, а её
   * сверяет `applyTransition` под блокировкой. 409 придёт раньше, чем разъедется решение о ветке.
   */
  r.put(
    '/:id/estimate/breakdown',
    {
      ...canEstimateRewrite,
      schema: { params: idParams, body: putServiceEstimateBreakdownSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      assertEstimateApplies(row, 'раскладывать по графам');
      if (row.status !== 'in_work') {
        throw err.unprocessable(
          `Объём работ раскладывают по графам в «${serviceRequestStatusLabels.in_work}», а заявка в статусе «${serviceRequestStatusLabels[row.status]}»: отложенную сперва возобновляют, закрытую не раскладывают, а у «${serviceRequestStatusLabels.new}» объёма работ ещё нет`,
          { status: 'Другой статус' },
        );
      }
      // Первая ветка развилки — тот же замок и тот же код, что у обычной правки состава: 409, а не
      // 422, потому что запер смету не тот, кто её раскладывает, а чужое действие.
      if (serviceEstimatePending(row)) {
        throw err.conflict(
          `Объём работ ревизии ${row.estimateRevision} предъявлен и ждёт ответа — раскладывать его по графам можно, когда по нему решат`,
        );
      }
      /**
       * Третья ветка: согласованную ревизию раскладка ПЕРЕИЗДАЁТ. Условие то же, каким обычная
       * правка отбивает согласованный состав, — снимок согласования указывает на текущую ревизию, —
       * и `estimateRevision > 0` в нём не лишнее: у нулевой ревизии согласовывать было нечего, а
       * `null === null` ответил бы «согласована».
       */
      const reissue =
        row.estimateRevision > 0 && row.approvedEstimateRevision === row.estimateRevision;
      const revision = reissue ? row.estimateRevision + 1 : row.estimateRevision;
      const before = (await getFullDto(p, row.id))!;
      /**
       * Письмо готовится ДО транзакции (Р67) и только у третьей ветки: из внешней среды читаются
       * почтовые настройки процесса, и упавшие внутри они откатили бы саму раскладку. Событие и
       * действие те же, что у предъявления исполнителя (`PATCH /:id/estimate/submit`), — механику
       * повторяем, а не изобретаем: адресат у обоих один, отвечать по числам предстоит ему же.
       */
      const mailPlan = reissue
        ? await prepareServiceMail({
            event: 'service_request_estimate',
            actor: mailActorOf(p),
            authorId: row.createdBy,
            estimate: { revision, action: 'submit' },
          })
        : null;

      const total = await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);
        // Сторона снимается до бизнес-изменения — тем же порядком, что у предъявления: адресаты
        // письма считаются по назначению, а не по состоянию сметы.
        const side = await readServiceSide(tx, locked.id);
        // Строки, на которые сослалось гарантийное обращение, не переписывает никто — ни
        // исполнитель, ни «Ведение», ни переназначение (409 с номерами обращений).
        await assertEstimateReplaceable(tx, locked.id);
        await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, locked.id));
        if (body.items.length > 0) {
          await tx.insert(serviceRequestItems).values(
            body.items.map((item, index) => ({
              requestId: locked.id,
              kind: item.kind,
              name: item.name,
              quantity: money(item.quantity),
              unitPrice: money(item.unitPrice),
              warrantyMonths: item.warrantyMonths ?? null,
              sortOrder: index,
            })),
          );
        }
        const patch: RequestPatch = {};
        let amount: number | null = null;
        /**
         * Тот же итог строкой — для снимка ревизии (ниже). Отдельной переменной, а не `amount!` у
         * места записи: «итог посчитан» и «номер поднялся» — разные утверждения, и восклицательный
         * знак выдал бы второе за первое.
         */
        let reissueTotal: string | null = null;
        if (reissue) {
          const items = await estimateItems(tx, locked.id);
          // Пустой состав схемой разрешён — что с ним делать, решает ручка, и у переиздания ответ
          // один: предъявить нечего. Черновик пустым остаться вправе, подписи ждать — нет.
          if (items.length === 0) {
            throw err.unprocessable(
              'Согласованный объём работ нельзя разложить в ноль строк — заявке нужен состав, который подпишут заново',
              { items: 'Нужна хотя бы одна строка' },
            );
          }
          // Итог пересчитывается ЗДЕСЬ, потому что проставляет его только предъявление (Н5): не
          // сделай этого раскладка — карточка и строки показали бы разные деньги.
          amount = sumAmounts(items);
          reissueTotal = money(amount);
          patch.estimateRevision = revision;
          patch.estimatePendingRevision = revision;
          // Переиздание — это предъявление, и происхождение ожидания у него такое же (Н4):
          // `dispute` пускает подпись в «Решена», и унаследованное от прошлого ожидания оно
          // открыло бы эту дверь ревизии, о которой спора не было.
          patch.estimatePendingSource = 'submit';
          patch.estimateSubmittedAt = new Date();
          patch.estimatedTotalAmount = money(amount);
          // Подпись обесценена подъёмом ревизии — снимок согласования снимается целиком, все три
          // поля разом: оставленный `approved_by` без ревизии читался бы как «кто-то это подписал».
          patch.approvedEstimateRevision = null;
          patch.estimateApprovedBy = null;
          patch.estimateApprovedAt = null;
          // Источник подписи — вместе с самой подписью (Н4): переиздание обесценило её целиком.
          patch.estimateApprovalSource = null;
        }
        await applyTransition(tx, {
          row: locked,
          // Статус тот же: раскладка — не переход. Через помощник ручка всё равно идёт — он
          // единственная точка, где заявка пишет строку истории и сверяет версию (Р4).
          to: locked.status,
          version: body.version,
          actor: p,
          patch,
          // Возраст ожидания сбрасывает только переиздание: ход перешёл к согласующему. Раскладка
          // черновика ничего никому не передаёт — ждут по-прежнему исполнителя.
          touchStatusAt: reissue,
          // Письмо ставит не переход (статус не меняется), а само предъявление — ниже.
          mail: null,
        });
        if (reissue) {
          /*
           * ПЕРЕИЗДАНИЕ ТОЖЕ ПИШЕТ СТРОКУ РЕВИЗИИ (Р4), и это вторая и последняя дорога к номеру:
           * оставь её без строки — номер в заявке ушёл бы вперёд таблицы, а планка закрывающего
           * документа читала бы формат ПРЕДЫДУЩЕГО предъявления. Именно здесь это дороже всего:
           * раскладка «Ведения» существует затем, чтобы переиздать документную подачу в построчную
           * (Р8), то есть ровно она и меняет формат — а значит и перечень бумаг, которыми заявка
           * закрывается.
           *
           * Формат всегда `items`: раскладка кладёт строки по графам, и ревизия после неё построчная
           * по построению, каким бы ни был формат прежней. Сумма — пересчитанный выше итог строк,
           * тот же, что ушёл в снимок заявки.
           */
          await recordEstimateRevision(tx, {
            requestId: locked.id,
            revision,
            format: 'items',
            submittedBy: p.id,
            totalAmount: reissueTotal,
          });
        }
        if (mailPlan) {
          await queueServiceMailForIntent(tx, {
            prepared: mailPlan,
            side,
            requestId: locked.id,
            // Ключ тот же, что у предъявления исполнителя: ревизия у переиздания новая, и второго
            // письма по одной ревизии не будет ни при каком повторе нажатия.
            anchor: `${locked.id}-rev${revision}-submit`,
            extra: { estimate: { revision, action: 'submit' } },
          });
        }
        return amount;
      });

      const after = (await getFullDto(p, row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_breakdown',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          revision,
          // Переиздали или разложили черновик — по составу этого не восстановить, а разбор спора
          // начинается именно с вопроса «под чем стояла подпись».
          reissued: reissue,
          // Итог — только у переиздания: у раскладки черновика его нет вовсе (проставляет его
          // предъявление), и записанный нулём он читался бы как «работы бесплатны».
          ...(total === null ? {} : { total }),
          // Состав, а не итог: раскладка ровно в том и состоит, что сумма остаётся, а предмет
          // становится другим — «было 70 455, стало 70 455» не сказало бы ничего.
          changes: diffServiceEstimate(before.items, after.items),
        },
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
      /*
       * Формат предъявления приезжает ВНЕШНИМ дискриминатором (Р2 плана
       * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`), и гарантийный ремонт — одно из
       * его трёх значений, а не отдельное поле тела. Старое плоское `warrantyRepair` сюда не доходит
       * вовсе: его переводит в `mode` нормализация схемы (`normalizeLegacyEstimateSubmit`) — это и есть
       * совместимость с вкладкой, которая переживает парный выкат. Признак читается один раз и одним
       * способом: второй читатель (`body.warrantyRepair`) компилятором уже не ловится, а разошёлся бы
       * молча — гарантийное предъявление ушло бы с ненулевой подписью.
       */
      const warrantyRepair = body.mode === 'warranty';
      const row = await requireEditable(p, req.params.id);
      assertEstimateApplies(row, 'предъявлять');
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
      /*
       * РУБИЛЬНИК ДОКУМЕНТНОГО РЕЖИМА ГАСИТ ВХОД (Р2, §7 шаг 3 плана
       * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`), и отказ — тот же самый, что
       * стоял здесь затвором выпуска A: снаружи «волна ещё не включена» и «волны ещё нет» обязаны
       * выглядеть одинаково, иначе портал старой версии получал бы два разных объяснения одного
       * состояния.
       *
       * ИМЕННО ВХОД, А НЕ ИСХОД — и в этом вся разница с рубильником освобождения ниже. Документная
       * подача создаёт данные, которых старый читатель не понимает (роль файла, формат ревизии), и
       * пока он жив в проде, счёт-основание снова стал бы для него закрывающей бумагой (§7, шаг 2).
       * Поэтому выключенный ключ запрещает КОМАНДУ.
       */
      if (
        body.mode === 'document' &&
        !(await isFeatureEnabled(db, 'service_estimate_document_mode'))
      ) {
        throw err.unprocessable(
          'Подача объёма работ документом пока выключена — предъявите объём работ строками',
          { mode: 'Формат недоступен' },
        );
      }
      /*
       * ЗАЯВЛЕНИЕ ОБ ОСВОБОЖДЕНИИ: КОМУ ДАНО ЗАЯВИТЬ И ЧТО ИЗ ЭТОГО ВЫШЛО — два разных вопроса
       * (Р3), и отвечают на них две разные функции.
       *
       * Первый — доступ, и его нарушение единственное, что отвечает отказом: заявление по чужой
       * заявке либо от той стороны, что подпись СТАВИТ, — это не освобождение, а подпись за другого
       * (`canDeclareExemption` пускает только оператора назначенного контрагента-сервиса, ответ В1).
       *
       * Второй — исход, и отказом он не бывает никогда: выключенный рубильник даёт `observed`, то
       * есть предъявление проходит, ожидание подписи открывается как обычно, а заявление остаётся в
       * следе. Этим служба и узнаёт ДО включения ключа, сколько заявлений приходит и на какие суммы;
       * отвечай выключенный рубильник отказом, такой картины не было бы вовсе.
       *
       * Рубильник читается ЗДЕСЬ, до транзакции, и один раз: исход уезжает и в письмо (оно
       * готовится до транзакции, Р67), и в строку следа внутри неё, и прочитанный дважды он развёл
       * бы их между собой на переключении ключа.
       */
      const declaration = 'exemption' in body ? body.exemption : undefined;
      if (declaration && !canDeclareExemption(row, p, assignment)) {
        throw err.forbidden(
          'Освобождение от согласования заявляет оператор назначенной сервисной компании — ' +
            'по этой заявке объём работ предъявляется на подпись',
        );
      }
      /*
       * ПАМЯТЬ СПОРА — ВТОРОЙ ВХОД ИСХОДА (Р9). Разрешённый спор с исходом «нужна подпись» значит,
       * что подпись по этой заявке собирают, и повторное заявление освободить от неё не может:
       * иначе исход спора снимался бы возвратом в правку и новым предъявлением — тем же подрядчиком
       * и без чьего-либо ведома.
       *
       * ЧИТАЕТСЯ ДО ТРАНЗАКЦИИ, РЯДОМ С РУБИЛЬНИКОМ, и гонку закрывает не блокировка, а сверка
       * версии. Требование появляется только разрешением спора, а и открытие, и разрешение спора —
       * переходы заявки: каждый двигает версию. Предъявление, начатое до разбора, получит от
       * `applyTransition` честный 409 и повторится уже с новым ответом.
       */
      const exemptionOutcome = declaration
        ? evaluateExemption({
            flagEnabled: await isFeatureEnabled(db, 'service_estimate_exemption'),
            disputeRequiresSignature: await estimateSignatureRequiredByDispute(db, row.id),
          })
        : null;
      // Подпись без подписавшего (Р11): её ставит применённое освобождение, и только оно.
      const autoApproved = exemptionOutcome === 'applied';
      // Гарантийный ремонт — не пустая смета, а осознанное «чиним по гарантии, денег нет», и без
      // названного источника гарантии он ничем не подтверждён (Р27).
      if (warrantyRepair && !row.warrantyClaimSource) {
        throw err.unprocessable(
          'Гарантийный ремонт предъявляют по заявке с обращением по гарантии — укажите источник',
          { warrantyRepair: 'Нет обращения по гарантии' },
        );
      }

      const revision = row.estimateRevision + 1;
      /*
       * Страницы счёта — отдельной переменной, а не чтением `body.fileIds` по месту: сужение союза
       * по `mode` внутри вложенной функции транзакции держится на тонкостях вывода типов, а список
       * страниц нужен трижды (проверка, подшивка, отметка активными). `null` здесь и означает
       * «подача не документная».
       */
      const documentFileIds = body.mode === 'document' ? body.fileIds : null;
      /**
       * Предъявление адресовано тому, кто отвечает по объёму работ, — службе (§3, № 5). Событие
       * держится не за статус (он не меняется), а за пару «ревизия + действие»: повторное
       * предъявление той же ревизии письма не удвоит, а новая ревизия — это другие числа, о
       * которых обязаны узнать заново.
       *
       * ПРИМЕНЁННОЕ ОСВОБОЖДЕНИЕ — СВОЁ ДЕЙСТВИЕ, И АДРЕСАТ У НЕГО ТОТ ЖЕ (Р13). Письмо офису —
       * один из четырёх механизмов контроля постфактум: подпись не собирают вовсе, и служба обязана
       * узнать о деньгах, прошедших мимо неё, иначе первым известием станет счёт из бухгалтерии.
       * Письмо ОДНО, а не два: обычное предъявление ушло бы тому же адресату и говорило бы неправду
       * — «ждём вашего решения» там, где решение уже принято автопринятием.
       *
       * Исход `observed` письма не меняет: подпись по такой заявке собирают обычным порядком, и
       * уходит обычное предъявление.
       */
      const mailAction = autoApproved ? 'exempted' : 'submit';
      const mailPlan = await prepareServiceMail({
        event: 'service_request_estimate',
        actor: mailActorOf(p),
        authorId: row.createdBy,
        estimate: { revision, action: mailAction },
      });
      const total = await db.transaction(async (tx) => {
        /*
         * ВСЯ КОМАНДА — ОДНОЙ ТРАНЗАКЦИЕЙ ПОД БЛОКИРОВКОЙ СТРОКИ (Р7): проверка файлов, подшивка,
         * строка ревизии, подъём номера, заявление и его исход, письмо и история. Блокировка
         * появилась здесь вместе с документной подачей и нужна ровно ей: проверка «файл свободен и
         * догружен» и его подшивка обязаны идти в одной очереди с остальными действиями по заявке —
         * иначе тот же файл успевает уехать основанием в соседнюю заявку между проверкой и
         * вставкой. Сверку версии блокировка не отменяет: её делает `applyTransition`, и чужое
         * действие, вклинившееся до нас, по-прежнему отвечает 409.
         */
        const locked = await lockRequest(tx, row.id);
        const side = await readServiceSide(tx, locked.id);
        if (warrantyRepair) {
          await assertEstimateReplaceable(tx, locked.id);
          await tx.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, locked.id));
          await tx.insert(serviceRequestItems).values({
            requestId: locked.id,
            kind: 'service',
            name: WARRANTY_REPAIR_ITEM_NAME,
            quantity: '1',
            unitPrice: '0',
            sortOrder: 0,
          });
        }
        /**
         * СУММЫ У ДОКУМЕНТНОЙ ПОДАЧИ НЕТ, И ЭТО НЕ ПРОПУЩЕННОЕ ПОЛЕ, А НЕИЗВЕСТНОЕ ЗНАЧЕНИЕ (Р2,
         * ответ В5 заказчика): содержимое счёта системе станет известно только от разбора
         * документа. Ноль вместо него читался бы как «работы бесплатны» — тот же запрет, что у
         * итога по акту, — поэтому `null`, а не `money(0)`.
         *
         * ПРОВЕРКА «ОБЪЁМ РАБОТ ПУСТ» К ЭТОМУ ФОРМАТУ НЕ ПРИМЕНЯЕТСЯ по той же причине: у
         * документной ревизии строк нет вовсе, и требование строки запретило бы формат целиком.
         * У построчного и гарантийного она остаётся нетронутой.
         *
         * СТРОКИ ЧЕРНОВИКА ДОКУМЕНТНАЯ ПОДАЧА НЕ УДАЛЯЕТ. Портал пускает в этот режим, пока набрано
         * не больше одной строки (Р10), и набранное там обязано пережить переключение режима:
         * молчаливое удаление состава у денежной ручки — потеря данных, а не уборка.
         */
        let amount: number | null = null;
        if (documentFileIds === null) {
          const items = await estimateItems(tx, locked.id);
          if (items.length === 0) {
            throw err.unprocessable('Объём работ пуст — добавьте хотя бы одну строку');
          }
          amount = sumAmounts(items);
        } else {
          /*
           * ФАЙЛЫ ПРОВЕРЯЮТСЯ С `requireActive` (Н13, Р7), в отличие от обычной подшивки: основание
           * денежного решения не бывает `pending` — у такого файла объекта в хранилище может не
           * быть вовсе (загрузку оборвали), и через сутки его заберёт уборка. Обычное вложение
           * переживает это незамеченным, а счёт, которым предъявлен объём работ, — нет: заявка
           * осталась бы с ревизией, у которой нет ни строк, ни документа.
           *
           * Лимит на заявку считается вместе с уже подшитыми: страницы счёта — такие же строки
           * связи, и отдельного счёта у них нет.
           */
          const existing = await tx
            .select({ fileId: serviceRequestFiles.fileId })
            .from(serviceRequestFiles)
            .where(eq(serviceRequestFiles.requestId, locked.id));
          assertTotalWithinLimit(existing.length, documentFileIds.length);
          await assertFilesAttachable(tx, documentFileIds, p.id, { requireActive: true });
        }
        const now = new Date();
        await applyTransition(tx, {
          row: locked,
          // Статус тот же (Р8). Через помощник перехода ручка всё равно идёт: он — единственная
          // точка, где заявка пишет строку истории и сбрасывает возраст ожидания, и второго пути
          // писать эти две вещи модуль не заводит (Р4).
          to: locked.status,
          version: body.version,
          actor: p,
          comment: body.comment,
          patch: {
            estimateRevision: revision,
            /*
             * ОЖИДАНИЕ ПОДПИСИ ОТКРЫВАЕТСЯ, ЕСЛИ ПОДПИСЬ СОБИРАЮТ. При применённом освобождении её
             * не собирают вовсе (Р3): открытое ожидание держало бы заявку в очереди согласования,
             * а подписывать в ней уже нечего — и `service_requests_estimate_pending_check` тут ни
             * при чём, он о равенстве номеров.
             *
             * Происхождение ожидания — `submit` (Н2/Н4): подпись в «Решена» открыта ТОЛЬКО
             * ожиданию, созданному разбором спора (`dispute`), и предъявление обязано называть
             * себя явно — иначе первое же ожидание, доехавшее до «Решена», открыло бы эту дверь.
             */
            estimatePendingRevision: autoApproved ? null : revision,
            estimatePendingSource: autoApproved ? null : 'submit',
            estimateSubmittedAt: now,
            // Снимок предъявленной суммы: по нему потом и сверяется закрытие. У документной подачи
            // пусто — и записывается именно `null`, затирая снимок прошлой ревизии: оставленное
            // старое число читалось бы как сумма поданного счёта.
            estimatedTotalAmount: amount === null ? null : money(amount),
            ...(autoApproved
              ? {
                  /*
                   * ПОДПИСЬ БЕЗ АВТОРА (Р11): ревизия и время есть, подписавшего нет и быть не
                   * может — за автопринятие не отвечает ни один человек, а подставить сюда
                   * заявителя освобождения значило бы записать, что оператор сервиса согласовал
                   * смету сам себе (ровно то, что `canApproveServiceEstimate` запрещает явно).
                   * Пару «ревизия + время» держит `service_requests_approval_check`, а пустого
                   * автора он с выпуска A допускает намеренно.
                   */
                  approvedEstimateRevision: revision,
                  estimateApprovedAt: now,
                  estimateApprovedBy: null,
                  estimateApprovalSource: 'auto' as const,
                }
              : {}),
          },
          /*
           * Возраст ожидания сбрасывает только настоящее предъявление: ход перешёл к согласующему
           * (`service → approval`). У применённого освобождения ход никуда не переходит — заявку
           * по-прежнему ведёт исполнитель, теперь уже работая, — и обнулённый возраст спрятал бы
           * из очереди «дольше всех ждут» заявку, которая там стоит по-настоящему.
           */
          touchStatusAt: !autoApproved,
          // Письмо ставит не переход (статус не меняется), а само предъявление — ниже.
          mail: null,
        });
        /*
         * СТРОКА РЕВИЗИИ — ТОЙ ЖЕ ТРАНЗАКЦИЕЙ, ЧТО ПОДЪЁМ НОМЕРА (Р4). До этой правки номер жил
         * только в самой заявке, а формат предъявления не хранился нигде: читать его было неоткуда,
         * и планка закрывающего документа у всех заявок отвечала наследием.
         *
         * ПОСЛЕ `applyTransition`, А ДО СТРАНИЦ И ЗАЯВЛЕНИЯ. Переход сверяет версию заявки и
         * отвечает 409, если её двинули из-под нас, — записанная раньше ревизия откатилась бы
         * вместе со всем прочим, но до отката успела бы погасить прежнюю активную. А страницы и
         * заявление ссылаются на эту строку составными ключами, и ключи немедленные: обратный
         * порядок отказал бы на первой же документной подаче.
         */
        await recordEstimateRevision(tx, {
          requestId: locked.id,
          revision,
          // Формат берётся из команды, а не выводится из состава: «строк ноль» у документной подачи
          // и у пустого черновика выглядят одинаково, а раскладка «Ведения» переиздаёт документную
          // ревизию в построчную — выведенный признак соврал бы на первой же раскладке.
          format: body.mode,
          submittedBy: p.id,
          // Снимок строк. У гарантийного формата это ноль, и ноль здесь законная цена, а не
          // «неизвестно»: служебная нулевая строка и есть весь объём работ по гарантии. У
          // документного — `null`: сумма не опущена, а неизвестна.
          totalAmount: amount === null ? null : money(amount),
        });
        if (documentFileIds !== null) {
          /*
           * СТРАНИЦЫ ОСНОВАНИЯ. Роль назначает СЕРВЕР, клиент её не выбирает (Р5): `estimate_basis`
           * ставится только здесь и только виду `invoice` — иначе фотография поломки стала бы
           * «основанием» и выпала из закрывающих бумаг, а заявка перестала бы закрываться.
           *
           * Порядок страниц — порядок присланного списка: счёт сканируют по листам, и разбор
           * документа (Р12) привяжет предложение к листу по этому номеру. Нумерация с единицы —
           * `service_request_files_page_no_check` отбивает ноль как опечатку.
           *
           * ПОЛИТИКА ВИДОВ ДОКУМЕНТА (`assertFileKindAllowed`) ЗДЕСЬ НЕ СПРАШИВАЕТСЯ, и это не
           * пропуск стража. Та политика отвечает на вопрос «кому и когда разрешено ВЫБРАТЬ этот вид
           * при подшивке», а вида здесь никто не выбирает: он следствие формата команды. Право же
           * на саму команду спрошено выше — `canSubmitServiceEstimate`, та же сторона исполнителя, —
           * и спроси мы политику второй раз, у одного действия завелось бы два ответа на вопрос
           * «можно ли», расходящихся при первой правке перечня.
           */
          await tx.insert(serviceRequestFiles).values(
            documentFileIds.map((fileId, index) => ({
              requestId: locked.id,
              kind: 'invoice' as const,
              purpose: 'estimate_basis' as const,
              estimateRevision: revision,
              pageNo: index + 1,
              fileId,
              attachedBy: p.id,
            })),
          );
          await markFilesActive(tx, documentFileIds);
        }
        if (declaration && exemptionOutcome) {
          /*
           * СЛЕД ЗАЯВЛЕНИЯ — В ТОЙ ЖЕ ТРАНЗАКЦИИ (Р3, Р4). Аудит модуля пишется после `COMMIT`, и
           * сбой между ними оставил бы денежное решение без единой записи о том, кто его принял, —
           * а другого следа у освобождения нет: ни лимита, ни политики, ни ловли дублей заказчик не
           * захотел (Р13).
           */
          await recordEstimateExemption(tx, {
            requestId: locked.id,
            revision,
            declaredBy: p.id,
            note: declaration.note ?? '',
            outcome: exemptionOutcome,
          });
        }
        await queueServiceMailForIntent(tx, {
          prepared: mailPlan,
          side,
          requestId: locked.id,
          // Якорь — пара «ревизия + действие», как и само событие: повтор нажатия второго письма не
          // создаёт, а освобождение и обычное предъявление по одной ревизии не бывают вместе.
          anchor: `${locked.id}-rev${revision}-${mailAction}`,
          extra: { estimate: { revision, action: mailAction } },
        });
        return amount;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_submit',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          revision,
          // `null` у документной подачи — «сумма неизвестна», и записанный вместо него ноль читался
          // бы в журнале как цена (тот же запрет, что у снимка заявки).
          total,
          warrantyRepair,
          // Формат — то, чего по составу заявки не восстановить: разбор денежного решения через
          // месяц начинается с вопроса «чем предъявляли».
          format: body.mode,
          // Исход заявления — в журнале рядом с событием: строка следа отвечает «что решили», а эта
          // запись — «когда и в каком действии». Без исхода событие не отличило бы автопринятие от
          // обычного предъявления.
          ...(exemptionOutcome
            ? { exemption: { outcome: exemptionOutcome, note: declaration?.note ?? '' } }
            : {}),
        },
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
      assertEstimateApplies(row, 'согласовывать');
      const assignment = await executorAssignment(p, row);
      /*
       * КОРИДОР СТАТУСОВ СПРАШИВАЕТСЯ У КОНТРАКТОВ, а не сравнением со «В работе»: после Р9 подпись
       * бывает и в «Решена» — но только по ожиданию, открытому разрешённым спором, и это правило
       * целиком живёт в `allowsEstimateApprovalInStatus`. Своё сравнение здесь было бы ВТОРЫМ
       * носителем статусного правила: оно отбивало бы постспорную подпись 422 при предикате,
       * отвечающем «да», и разошлось бы молча — отладка пошла бы по предикату, который отвечает
       * правильно.
       */
      if (!allowsEstimateApprovalInStatus(row)) {
        throw err.unprocessable(
          `Объём работ согласуют в «${serviceRequestStatusLabels.in_work}» либо в «${serviceRequestStatusLabels.done}» — по ожиданию, открытому разрешённым спором; заявка в статусе «${serviceRequestStatusLabels[row.status]}» согласования не принимает`,
          { status: 'Согласование в этом статусе недоступно' },
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

      /*
       * Одно время на всю подпись: им помечается и сама подпись, и порог окна приёмки после спора
       * (Р9). Два вызова `new Date()` разошлись бы на миллисекунды, и «порог равен времени подписи»
       * перестало бы быть правдой ровно в том месте, где эту пару и сверяют на разборе.
       */
      const signedAt = new Date();
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
                estimateApprovedAt: signedAt,
                /**
                 * ОКНО ПРИЁМКИ ПОСЛЕ СПОРА ОТКРЫВАЕТСЯ ПОДПИСЬЮ, А НЕ РАЗРЕШЕНИЕМ СПОРА (Р9, Н9).
                 * Порог ставится ровно постспорной подписи — той, чьё ожидание открыл исход «нужна
                 * подпись» (`estimate_pending_source = 'dispute'`), — и ставится здесь, а не в ручке
                 * разрешения: отсчитай мы сутки от разрешения, подпись, поставленная через два дня,
                 * закрыла бы заявку автоматически в ту же минуту — никто не успел бы возразить. До
                 * подписи заявка в выборку автозакрытия не входит вовсе (`ESTIMATE_SIGNED` в
                 * `internal-service-requests.ts`): согласованная ревизия там не равна действующей.
                 *
                 * ПО ПРОИСХОЖДЕНИЮ ОЖИДАНИЯ, А НЕ ПО СТАТУСУ «Решена»: спор бывает открыт и из «В
                 * работе», и ветка на статус молчала бы про него. Лишним порог в этом случае не
                 * становится — он раньше закрытия работ, а отбор берёт `GREATEST` с `completed_at`,
                 * то есть у такой заявки срок остаётся прежним.
                 */
                ...(row.estimatePendingSource === 'dispute'
                  ? { autoCloseNotBefore: signedAt }
                  : {}),
                /*
                 * ИСТОЧНИК НАЗЫВАЕТСЯ ЯВНО, хотя пустое значение и читается как `human` (Р11).
                 * Причина не в красоте записи: подпись человека приходит и поверх автопринятой —
                 * исход спора «нужна подпись» (Э5) снимает автоподпись и открывает ожидание, — а
                 * `service_requests_estimate_approval_source_check` запрещает `auto` вместе с
                 * автором. Оставь мы колонку нетронутой, первое же такое согласование упало бы
                 * ошибкой БД.
                 */
                estimateApprovalSource: 'human',
                estimatePendingRevision: null,
                estimatePendingSource: null,
              }
            : {
                estimatePendingRevision: null,
                // Ответ получен и у отказа: ожидание гаснет вместе со своим происхождением (Н4).
                estimatePendingSource: null,
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
      /**
       * Отдельная запись отказа — ТОЛЬКО на настоящих отказах. `not_needed` и `event_off` —
       * штатные исходы: письма не требовалось либо событие выключено администратором, и «письмо не
       * ушло» про них было бы ложной тревогой в журнале, который читают на разборе.
       *
       * Событие называется своим именем: у согласия это движение по объёму работ, у отказа —
       * отмена заявки. Жёстко записанная отмена приписывала бы каждому «Согласовано» чужой факт.
       */
      if (mailOutcome && FAILED_MAIL_OUTCOMES.has(mailOutcome)) {
        await writeAudit({
          actorUserId: p.id,
          action: 'serviceRequest.mailFailed',
          entityType: 'serviceRequest',
          entityId: row.id,
          metadata: {
            event: body.approved ? 'service_request_estimate' : 'service_request_cancelled',
            outcome: mailOutcome,
          },
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
      assertEstimateApplies(row, 'возвращать в правку');
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
            // Источник подписи и происхождение ожидания гаснут вместе с тем, что они описывают
            // (Н4). Для освобождения это главное место: возврат в правку — единственный способ
            // снять автоподпись по своей воле, и оставленный `auto` показывал бы «принято без
            // согласования» у заявки, по которой объём работ предъявляют заново.
            estimateApprovalSource: null,
            estimatePendingRevision: null,
            estimatePendingSource: null,
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

  // ── Спор об освобождении от подписи ──
  /**
   * ОТКРЫТЬ СПОР (Р9 плана `docs/office-equipment-on-site-and-invoice-estimate-plan.md`): «Ведение»
   * не согласно с тем, что подпись под объёмом работ не собирали, и останавливает заявку до разбора.
   *
   * МЕХАНИКА ОСТАНОВКИ — ОБЫЧНАЯ ЗАМОРОЗКА с видом `estimate_exemption_dispute`, а не свой статус:
   * «Отложена» уже умеет и держать заявку, и помнить, куда её вернуть (`held_from_status`), и коридор
   * для обоих входов — из «В работе» и из «Решена» — существовал до этой волны (находка Н7). Второй
   * способ остановить заявку означал бы второе правило возврата, расходящееся с первым.
   *
   * СТРОКА СПОРА — ТОЙ ЖЕ ТРАНЗАКЦИЕЙ, ЧТО ЗАМОРОЗКА. Порознь они дают два невозможных состояния:
   * заморозку с видом «спор» без самого спора (разрешать нечего, заявка стоит навсегда) и открытый
   * спор по работающей заявке (предикат разрешения требует «Отложена» и ответил бы отказом).
   *
   * КОРИДОР СТАТУСОВ ЭТА РУЧКА НЕ СПРАШИВАЕТ, и это осознанно — та же причина, что у согласования
   * объёма работ. Дуга в «Отложена» живёт в `SERVICE_HOLD_TRANSITIONS`, то есть приходит правом
   * `serviceRequests.hold`, а спор ведёт держатель `serviceRequests.assign`: спроси мы
   * `assertTransition`, ИТ-служба получила бы ручку и не смогла бы ею воспользоваться. Кто перед
   * нами, отвечает предикат контрактов, он же исключает оператора подрядчика — освобождение заявил
   * он, и спор с самим собой не контроль, а его имитация.
   *
   * ПОЧЕМУ ПРОВЕРКИ РАЗВЁРНУТЫ, А НЕ СВЕДЕНЫ К ОДНОМУ `if` ПРЕДИКАТА: предикат отвечает «нет» на
   * четыре разных вопроса — не тот статус, освобождение не применено, спор уже идёт, нет права, — и
   * человеку нужен тот из них, который про его случай. Сам предикат спрашивается последним и
   * остаётся единственным носителем правила: ни одна из проверок выше его условий не повторяет, они
   * лишь называют причину раньше.
   */
  r.patch(
    '/:id/estimate/dispute',
    { ...canDispute, schema: { params: idParams, body: openServiceEstimateDisputeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      assertEstimateApplies(row, 'оспаривать');
      // Остановка — вход в «Отложена», а значит событие переходов: исполнителю важно узнать, что
      // работу по заявке остановили, и причина уходит той же строкой письма, что у обычной заморозки.
      const mailPlan = await prepareTransitionMail('on_hold', p, row.createdBy);
      const opened = await db
        .transaction(async (tx) => {
          /*
           * БЛОКИРОВКА ПЕРВЫМ ШАГОМ (Р112): решение принимается по признакам, которые меняет чужая
           * ручка, — подпись снимает возврат в правку, ожидание открывает предъявление, — и
           * прочитанное до транзакции состояние к `COMMIT` устаревает.
           */
          const locked = await lockRequest(tx, row.id);
          const facts = await disputeFactsOf(tx, locked);
          /*
           * ВТОРОЙ ОТКРЫТЫЙ СПОР — ВНЯТНЫЙ 409, А НЕ 23505 ИЗ ЧАСТИЧНОГО ИНДЕКСА. Проверка под
           * блокировкой закрывает обычный случай (две вкладки, два нажатия), а сам индекс остаётся
           * последним словом: его нарушение разбирается после транзакции тем же текстом.
           */
          if (facts.disputeOpen) {
            throw disputeAlreadyOpen();
          }
          /*
           * СТАТУС СПРАШИВАЕТСЯ ПОСЛЕ ОТКРЫТОГО СПОРА, И ПОРЯДОК ЗДЕСЬ СМЫСЛОВОЙ. Спор останавливает
           * заявку, то есть уводит её в «Отложена», которой в перечне нет, — спроси мы статус первым,
           * второе нажатие получило бы «спор открывают до приёмки» вместо «спор уже идёт». Человек
           * читал бы отказ про статус, которого заявка приняла ИМЕННО из-за его спора.
           *
           * Перечень — константой контрактов: его же спрашивает предикат, и второй список статусов
           * разошёлся бы с ним молча.
           */
          if (!SERVICE_ESTIMATE_DISPUTE_OPEN_STATUSES.some((status) => status === locked.status)) {
            throw err.unprocessable(
              `Спор открывают до приёмки — в «${serviceRequestStatusLabels.in_work}» либо в «${serviceRequestStatusLabels.done}»; заявка в статусе «${serviceRequestStatusLabels[locked.status]}»`,
              { status: 'Спор в этом статусе не открывают' },
            );
          }
          if (!facts.exemptionApplied) {
            throw err.unprocessable(
              'Освобождение от подписи по действующей ревизии не применено — объём работ, подписанный человеком, возвращают в правку, а не оспаривают',
              { status: 'Освобождения по этой ревизии нет' },
            );
          }
          if (!canOpenServiceEstimateDispute(locked, p, facts)) {
            const who = p.role ? roleLabels[p.role] : 'Учётная запись';
            throw err.forbidden(
              `${who} не оспаривает освобождение от подписи по этой заявке — это шаг того, кто её ведёт`,
            );
          }
          await applyTransition(tx, {
            row: locked,
            to: 'on_hold',
            version: body.version,
            actor: p,
            comment: body.reason,
            patch: {
              // Пара «откуда и почему» — как у обычной заморозки: порознь их не примет
              // `service_requests_hold_check`, а чистит обе выход из «Отложена».
              heldFromStatus: locked.status,
              holdReason: body.reason,
              /*
               * ВИД ЗАМОРОЗКИ — ЕДИНСТВЕННОЕ, ЧЕМ ЭТА ОСТАНОВКА ОТЛИЧАЕТСЯ ОТ «ждём запчасть», и по
               * нему заперт обычный возврат (`resumeStep`). Без вида разбор спора обходился бы
               * возвратом в работу: заявка поехала бы дальше с автоподписью, которую оспорили.
               */
              holdKind: SERVICE_ESTIMATE_DISPUTE_HOLD_KIND,
            },
            mail: mailPlan,
          });
          /*
           * ПОСЛЕ ПЕРЕХОДА, А НЕ ДО НЕГО — тот же порядок, что у предъявления объёма работ (Р4):
           * сверку версии делает переход, и заявка, двинутая из-под нас, обязана ответить 409 РАНЬШЕ,
           * чем мы займём частичный уникальный индекс. Незакоммиченная строка спора видна конкуренту
           * как занятая — он ждёт на ней до нашего отката, — и обратный порядок подменял бы честный
           * отказ по версии ожиданием на индексе.
           */
          await tx.insert(serviceRequestEstimateDisputes).values({
            requestId: locked.id,
            // Ревизия — действующая: спорят о конкретном предъявлении, и подпись после спора
            // пускается только по ней (`allowsEstimateApprovalInStatus`).
            revision: locked.estimateRevision,
            openedBy: p.id,
            reason: body.reason,
            state: 'open',
          });
          return { revision: locked.estimateRevision, from: locked.status };
        })
        .catch((e: unknown) => {
          throw asDisputeOpenConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_dispute_open',
        entityType: 'serviceRequest',
        entityId: row.id,
        // Откуда заявку остановили — в журнал: после разрешения спора поле `held_from_status` гаснет,
        // и ответить «спорили о работающей или уже решённой заявке» будет нечем.
        metadata: { revision: opened.revision, from: opened.from, reason: body.reason },
      });
      return (await getDto(p, row.id))!;
    },
  );

  /**
   * РАЗРЕШИТЬ СПОР — МАТРИЦА «ОТКУДА ОТКРЫТ × ИСХОД» (Р9). Тело присылает исход, статусы считает
   * сервер: клиент про них не знает и знать не должен.
   *
   * | Открыт из | Исход                 | Куда возвращается                                        |
   * | --------- | --------------------- | -------------------------------------------------------- |
   * | `in_work` | оставить освобождение | `in_work`, порог приёмки — момент разрешения             |
   * | `done`    | оставить освобождение | `done`, факт и гарантии на месте, окно приёмки заново    |
   * | `in_work` | нужна подпись         | `in_work`, автоподпись снята, ожидание открыто           |
   * | `done`    | нужна подпись         | `done`, автоподпись снята, ожидание открыто              |
   * | любой     | отменить заявку       | `cancelled`, причина обязательна, факт и документы целы  |
   *
   * ВОЗВРАТ В ПРЕЖНИЙ СТАТУС, А НЕ В «В работе» ВСЕГДА (блокер 4 плана, находка Н12): матрица сбросов
   * стирает факт закрытия на дуге `done → in_work` — вместе с суммами по акту и датами гарантий, — то
   * есть «вернуть в работу» для спора из «Решена» означало бы отменить выполнение, которого никто не
   * отменял. Куда вернуть, помнит сама заявка (`serviceResumeTarget` по `held_from_status`), и второго
   * носителя этого правила модуль не заводит.
   *
   * ИСХОД `require_signature` — ЕДИНСТВЕННАЯ ДОРОГА К ПОДПИСИ В «Решена»: ожидание открывается с
   * происхождением `dispute`, и ровно его пускает `allowsEstimateApprovalInStatus`. Дальше у человека
   * две дороги общей ручкой согласования: подпись (она же ставит порог окна приёмки) и отказ, который
   * по общему правилу модуля отменяет заявку с причиной.
   *
   * ИСХОД `cancel` НИЧЕГО НЕ СТИРАЕТ СВЕРХ ОБЫЧНОЙ ОТМЕНЫ: факт закрытия, суммы и документы остаются
   * — отмена их не стирает, и переписывать историю мы не будем. Снимает она то же, что всякая отмена
   * (исполнителя и снимок согласования), и делает это матрица сбросов, а не эта ручка.
   *
   * КОРИДОР СТАТУСОВ НЕ СПРАШИВАЕТСЯ — по той же причине, что у открытия: возврат из заморозки живёт
   * предикатом (цель динамическая, таблицей она не выражается), отмена приходит правом
   * `serviceRequests.status`, а спор ведёт держатель `assign`. Право на само действие спрашивает
   * предикат контрактов, и оно то же, что у открытия: спор закрывает тот, кто его начал.
   */
  r.patch(
    '/:id/estimate/dispute/resolution',
    { ...canDispute, schema: { params: idParams, body: resolveServiceEstimateDisputeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const row = await requireEditable(p, req.params.id);
      assertEstimateApplies(row, 'оспаривать');
      /*
       * ЦЕЛЬ СЧИТАЕТСЯ ДО ТРАНЗАКЦИИ, ПОТОМУ ЧТО ОТ НЕЁ ЗАВИСИТ ПИСЬМО: подготовка письма читает
       * настройки процесса и обязана идти снаружи (Р67), а событие у перехода своё у каждого статуса.
       * Под блокировкой цель считается заново и сверяется с этой: разойдись они — заявку двинули
       * из-под нас, и письмо готовилось бы под другой статус.
       */
      const plannedTo =
        body.outcome === 'cancel' ? ('cancelled' as const) : serviceResumeTarget(row);
      if (!plannedTo) {
        throw err.unprocessable(
          `Заявка не остановлена спором — она в статусе «${serviceRequestStatusLabels[row.status]}»`,
          { status: 'Спор по заявке не открыт' },
        );
      }
      const mailPlan = await prepareTransitionMail(plannedTo, p, row.createdBy);
      const resolvedAt = new Date();
      const resolved = await db.transaction(async (tx) => {
        const locked = await lockRequest(tx, row.id);
        const dispute = await openDisputeOf(tx, locked.id);
        /*
         * ОТКРЫТЫЙ СПОР СПРАШИВАЕТСЯ СТРОКОЙ, а не видом заморозки: вид отвечает «заявку остановил
         * спор», а разрешать надо конкретную запись — ей пишутся исход, автор и время. Предикат ниже
         * получает тот же признак готовым.
         */
        if (!dispute) {
          throw err.unprocessable(
            'Открытого спора об освобождении по заявке нет — разрешать нечего',
            { status: 'Спор по заявке не открыт' },
          );
        }
        if (!canResolveServiceEstimateDispute(locked, p, { disputeOpen: true })) {
          const who = p.role ? roleLabels[p.role] : 'Учётная запись';
          throw err.forbidden(
            `${who} не разрешает спор об освобождении по этой заявке — это шаг того, кто его начал`,
          );
        }
        const to = body.outcome === 'cancel' ? ('cancelled' as const) : serviceResumeTarget(locked);
        if (to !== plannedTo) throw err.conflict();
        await applyTransition(tx, {
          row: locked,
          to,
          version: body.version,
          actor: p,
          // Отмена объясняется причиной, два других исхода — необязательным словом вдогонку: почему
          // спорили, уже записано в самом споре, и требовать второе объяснение было бы ритуалом.
          comment: body.outcome === 'cancel' ? body.reason : body.comment,
          patch:
            body.outcome === 'require_signature'
              ? {
                  /*
                   * АВТОПОДПИСЬ СНИМАЕТСЯ ЦЕЛИКОМ — все четыре колонки снимка (Н4): оставленный
                   * `auto` показывал бы «принято без согласования» у заявки, подпись под которой как
                   * раз и собирают, а при будущей человеческой подписи уронил бы запись
                   * (`service_requests_estimate_approval_source_check` запрещает `auto` с автором).
                   */
                  approvedEstimateRevision: null,
                  estimateApprovedAt: null,
                  estimateApprovedBy: null,
                  estimateApprovalSource: null,
                  /*
                   * ОЖИДАНИЕ — ПО ТЕКУЩЕЙ РЕВИЗИИ, и равенства требует сама база
                   * (`service_requests_estimate_pending_check`): ждать можно только подписи под тем,
                   * что предъявлено сейчас. Происхождение `dispute` — то самое, что открывает подпись
                   * в «Решена», и ставится оно ровно здесь: другой дороги к нему нет.
                   */
                  estimatePendingRevision: locked.estimateRevision,
                  estimatePendingSource: 'dispute',
                  /*
                   * ПОРОГ ОКНА ПРИЁМКИ ЗДЕСЬ НЕ СТАВИТСЯ (Н9). Отсчёт «сутки от разрешения» закрыл бы
                   * заявку автоматически сразу после подписи, поставленной через два дня, — окна на
                   * возражение не получил бы никто. Порог ставит сама подпись (ручка согласования), а
                   * до неё заявка в выборку автозакрытия не входит вовсе: согласованная ревизия не
                   * равна действующей.
                   */
                }
              : body.outcome === 'keep'
                ? {
                    /*
                     * ОКНО ПРИЁМКИ НАЧИНАЕТСЯ ЗАНОВО — от момента разрешения спора. Срок автоприёмки
                     * идёт от `completed_at` и времени заморозки не вычитает, поэтому заявка,
                     * простоявшая в споре неделю, созрела бы на первом же прогоне после возврата: её
                     * закрыли бы автоматически в ту же минуту, в которую спор и разрешили.
                     *
                     * Ставится и у спора из «В работе», где порог ни на что не влияет (закрытие
                     * работ позже, а отбор берёт `GREATEST` с `completed_at`): ветка на статус
                     * завела бы второе правило там, где общее верно в обоих случаях.
                     */
                    autoCloseNotBefore: resolvedAt,
                  }
                : /*
                   * ОТМЕНА НЕ ПИШЕТ НИЧЕГО СВОЕГО: порог окна приёмки отменённой заявке не нужен
                   * (отбор берёт только «Решена»), а факт закрытия, суммы и документы остаются на
                   * месте — их не трогает ни эта ручка, ни матрица сбросов отмены.
                   */
                  {},
          mail: mailPlan,
        });
        /*
         * ИСХОД, АВТОР И ВРЕМЯ — ТОЙ ЖЕ ТРАНЗАКЦИЕЙ И ПОСЛЕ ПЕРЕХОДА (тот же порядок, что у
         * открытия): сверку версии делает переход, и запись, прошедшая раньше него, осталась бы
         * «разрешённой» у заявки, которая никуда не уехала. Условие `state = 'open'` — защита от
         * повторного разрешения той же строки: второе нажатие получит ноль строк и 409 ниже.
         */
        const [closed] = await tx
          .update(serviceRequestEstimateDisputes)
          .set({
            state: 'resolved',
            outcome: body.outcome,
            resolvedBy: p.id,
            resolvedAt,
            updatedAt: resolvedAt,
          })
          .where(
            and(
              eq(serviceRequestEstimateDisputes.id, dispute.id),
              eq(serviceRequestEstimateDisputes.state, 'open'),
            ),
          )
          .returning({ id: serviceRequestEstimateDisputes.id });
        if (!closed) throw err.conflict();
        return { revision: dispute.revision, to };
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.estimate_dispute_resolve',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: {
          revision: resolved.revision,
          outcome: body.outcome,
          // Куда заявка ушла: после разрешения `held_from_status` гаснет, и «вернули в работу или
          // в решённую» по самой заявке уже не восстановить.
          to: resolved.to,
          reason: body.outcome === 'cancel' ? body.reason : body.comment,
        },
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
        // Сторона — под блокировкой и на `tx` (Р4): назначение, снятое между чтением заявки и
        // `COMMIT`, обязано закрыть ход, а не сработать по признакам из общего пула. Действие —
        // глаголом: отказ складывается в «… не ведёт состав этой заявки — это шаг назначенного
        // исполнителя».
        await assertExecutorSide(p, locked, 'ведёт состав этой заявки', tx);
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
        // Чей это ход — под блокировкой и на `tx` (Р4): списание со склада по снятому назначению
        // отменять было бы уже нечем, движения остатка неизменяемы.
        await assertConsumableIssuer(p, locked, tx);
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
   *
   * Всё сказанное — про ЗАКРЫТИЕ ПО ОБЪЁМУ РАБОТ. Веток у обработчика три (Р6 плана
   * `docs/office-equipment-card-and-list-cleanup-plan.md`), и внутренний ремонт из этого абзаца не
   * делает ничего: у него нет ни строк, ни сумм, ни гарантий — только дата и слово исполнителя.
   * Разбор веток стоит сразу после блокировки и проверки стороны.
   */
  r.patch(
    '/:id/complete',
    { ...canEstimate, schema: { params: idParams, body: completeServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      assertSideAllowed(p, req.params.id, 'done', ['in_work']);
      const row = await requireEditable(p, req.params.id);
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
        /**
         * СТОРОНА — ПОД ТОЙ ЖЕ БЛОКИРОВКОЙ (Р4), и это главный ход исполнителя: им работа
         * закрывается, а вместе с ней открывается приёмка и платёж. Прежде признаки назначения
         * считались общим пулом до транзакции, и опоздавшего останавливала только сверка версии —
         * то есть страховка от чужой правки, а не проверка «его ли это ход». Теперь коридор
         * спрашивается по строке, перечитанной под блокировкой, и по назначению, прочитанному
         * внутри той же транзакции.
         *
         * Предварительный отсев чужой стороны остаётся до чтения записи (`assertSideAllowed`):
         * оператору подрядчика «шаг исполнителя» отвечают прямо, а не 404 чужой заявки.
         */
        /*
         * ЗАКРЫТИЕ РАБОТ ПРИ ОТКРЫТОМ СПОРЕ НЕВОЗМОЖНО, и отдельной проверки здесь нет намеренно
         * (Р9 плана освобождения от согласования): спор останавливает заявку заморозкой, а коридор
         * ниже пускает в «Решена» только из «В работе» — отложенная упирается в него первой же
         * строкой. Сказано это комментарием, потому что из кода читается «сработал коридор», а не
         * «спор запрещает закрытие»: заведись когда-нибудь дуга `on_hold → done`, запрет исчез бы
         * вместе с коридором молча — и тогда проверку надо ставить тут же, строкой спора
         * (`openDisputeOf`), как она стоит в приёмке.
         */
        assertTransition(
          p,
          locked.id,
          locked.status,
          'done',
          await executorAssignment(p, locked, tx),
        );

        /**
         * ЗАКРЫТИЕ ДЕЛИТСЯ НА ТРИ ВЕТКИ (Р6 плана
         * `docs/office-equipment-card-and-list-cleanup-plan.md`), и первой стоит внутренний ремонт,
         * потому что он не делает НИЧЕГО из того, что делают две другие. Ремонт подрядчика ниже
         * идёт как и шёл — сверка ревизий, факт по строкам, гарантии, скидка, итог и закрывающий
         * документ; заявка на расходники — списание склада тем же ходом; внутренний ремонт —
         * только дата и слово исполнителя.
         *
         * Ветвление здесь, а не тернарниками внутри общего кода: у внутренней заявки не «нули по
         * тем же полям», а отсутствие самих полей. Пройди она общий путь, `estimateItems` закрыл бы
         * фактом её ИСТОРИЧЕСКИЕ строки (у заявок до этого выпуска они есть), сумма выполненного
         * стала бы стоимостью внутреннего ремонта, а даты гарантий — обещанием, которого свой
         * сисадмин не давал. Ровно этого заказчик и просил не делать (просьба 08.09.2026, п. 2).
         *
         * СОДЕРЖИМОЕ, КОТОРОГО У ВНУТРЕННЕЙ ЗАЯВКИ НЕ БЫВАЕТ, ОТВЕРГАЕТСЯ (Р6, §8 плана,
         * фаза C). Временная терпимость фазы A снята: пока раздавалась старая сборка портала,
         * присланные строки, расходники и скидка молча не применялись — «сохранилось, но не
         * сохранилось» терпели ровно до конца окна совместимости. Теперь такое тело получает
         * отказ: залежавшаяся вкладка обязана узнать, что её сценария больше нет, а не закрыть
         * работы наполовину — с датой, но без цифр, которые человек в неё вписал.
         */
        if (locked.kind === 'repair' && !serviceRequestNeedsEstimate(locked)) {
          /**
           * ЗАПРЕЩЕНО СОДЕРЖИМОЕ, А НЕ САМО ПОЛЕ `items` (Н8): массив объявлен схемой
           * ОБЯЗАТЕЛЬНЫМ, и запрет поля сделал бы внутреннее закрытие невозможным вовсе — законное
           * тело такой заявки и есть `items: []`. Отвергается поэтому непустой список, непустые
           * расходники и скидка с причиной: они означают, что клиент собрал тело вокруг сметы,
           * которой по этой заявке не бывает.
           *
           * 422, а не 403: право закрыть работы у исполнителя есть, и он ими же и закроет —
           * негодно присланное. Одним отказом на все четыре поля, а не четырьмя: человеку
           * исправлять их нечем — тело собирает окно закрытия, — и разные тексты означали бы, что
           * у него есть выбор, какое из полей убрать.
           *
           * Скидка спрашивается двумя половинами намеренно, хотя порознь их отсекает проверка
           * пары выше: она стоит СНАРУЖИ транзакции и про вид заявки не знает, и опереться на
           * порядок двух правил значило бы держать запрет на выводе о соседнем коде.
           */
          if (
            body.items.length > 0 ||
            (body.consumables?.length ?? 0) > 0 ||
            body.adjustmentAmount != null ||
            body.adjustmentReason
          ) {
            throw err.unprocessable('По этой заявке стоимость работ не фиксируется', {
              items: 'Внутренний ремонт закрывают датой',
            });
          }
          await applyTransition(tx, {
            row,
            to: 'done',
            version: body.version,
            actor: p,
            comment: body.comment,
            patch: {
              completedAt: moscowInstantOf(body.completedOn, '00:00'),
              /**
               * ИСТОРИЧЕСКОЕ ПРЕДЪЯВЛЕНИЕ ГАСИТСЯ ТЕМ ЖЕ ПАТЧЕМ (Н18). Сегодня закрытой заявки с
               * непогашенным предъявлением не бывает ни одной: согласование гасит pending, а без
               * согласования заявка не закрывалась. Внутреннее закрытие создало бы такое состояние
               * впервые — очереди его уже не увидят (Р7), но колонка остаётся сырым фактом, и
               * первый же отчёт, прочитавший её напрямую, повторил бы ошибку Н11.
               *
               * СНИМОК СОГЛАСОВАНИЯ ПРИ ЭТОМ НЕ ТРОГАЕТСЯ — ни `approved_estimate_revision`, ни
               * автор, ни дата: он объясняет, на каком основании работали, и стереть его значило бы
               * потерять прошлое. Историческую вкладку Р7 оставляет читаемой ровно ради этого.
               */
              estimatePendingRevision: null,
              // Вместе с ожиданием — его происхождение (Н4): признак, переживший гашение, открыл бы
              // подпись в «Решена» заявке, которой никакой спор не касался.
              estimatePendingSource: null,
            },
            mail: mailPlan,
          });
          // Ни итога, ни движений склада: внутреннее закрытие их не производит, и ноль в аудите был
          // бы зафиксированной суммой — то есть ответом на вопрос, который по этой заявке не задают.
          return { mode: 'internal' as const };
        }

        /*
         * Закрывают по согласованной ревизии: иначе правка прошла бы между открытием окна
         * согласования и нажатием кнопки, и работы закрылись бы не по той смете. Проверка переехала
         * сюда вслед за стороной, и порядок «сторона → состояние» этим как раз СОХРАНЁН: оставь мы
         * её снаружи, снятый исполнитель получал бы 409 «согласуйте объём работ заново» вместо 403
         * «это не ваш ход» — переназначение сбрасывает и смету, и подпись, и первым отвечал бы
         * сброс, а не отсутствие стороны.
         *
         * Заодно она стала честнее: ревизия, прочитанная под блокировкой, не разъезжается с
         * согласованием, прошедшим в это же окно.
         *
         * У расходников сметы нет вовсе (§6.2): согласовывать по картриджу со своего склада нечего
         * и не у кого, ревизия так и остаётся нулевой, а подписи — пустой. Спроси мы равенство и
         * здесь, ни одна заявка на расходники не закрылась бы никогда.
         *
         * Вид заявки в условии больше не назван, и это не потеря: спрашивается признак Р4, а
         * `kind === 'repair'` — его половина. Второй половиной (есть ли подрядчик) держится Н1:
         * у внутреннего ремонта `approved_estimate_revision` пуст, `estimate_revision` — ноль, и
         * `NULL !== 0` истинно, то есть прежнее условие не пускало такую заявку в «Решена» ВООБЩЕ.
         * До этой строки внутренняя заявка теперь и не доходит (ветка выше), но условие обязано
         * называть настоящее правило, а не полагаться на порядок веток над собой.
         */
        if (
          serviceRequestNeedsEstimate(locked) &&
          locked.approvedEstimateRevision !== locked.estimateRevision
        ) {
          throw err.conflict(
            `Согласована ревизия ${locked.approvedEstimateRevision ?? 0}, а в заявке ${locked.estimateRevision} — согласуйте объём работ заново`,
          );
        }
        /**
         * ФОРМАТ ДЕЙСТВУЮЩЕЙ РЕВИЗИИ ЧИТАЕТСЯ ОДИН РАЗ И ПОД БЛОКИРОВКОЙ, и спрашивают его теперь
         * двое: планка закрывающего документа (Р5) и сама ветвь закрытия (Р8). Чтение идёт той же
         * транзакцией, в которой взята блокировка заявки, а не до неё: между открытием окна закрытия
         * и нажатием кнопки помещается раскладка «Ведения», переводящая документную ревизию в
         * построчную, — и формат, прочитанный заранее, закрыл бы заявку не тем правилом, по которому
         * она живёт к моменту `COMMIT`.
         */
        const format = await readActiveEstimateFormat(tx, locked.id);
        if (serviceRequestNeedsClosingDocument(locked)) {
          /*
           * У построчной и гарантийной ревизии, как и у заявки без ревизий, перечень сегодняшний:
           * акт, счёт или гарантийный талон. У документной подачи — только акт: тем же счётом,
           * которым объём работ предъявлен, заявка закрываться не должна. Перечень называют
           * контракты (`closingKindsForFormat`), а не этот запрос, — ветвь закрытия ниже своего
           * перечня видов не держит.
           */
          const [closing] = await tx
            .select({ fileId: serviceRequestFiles.fileId })
            .from(serviceRequestFiles)
            .where(
              and(
                eq(serviceRequestFiles.requestId, locked.id),
                // Роль — вторая половина правила (`isServiceClosingFile`): счёт-основание денежного
                // решения закрывающей бумагой не является, иначе заявка закрывалась бы тем же
                // документом, которым объём работ предъявлен. Сегодня у всех связей роль одна —
                // умолчание миграции, — и условие ничего не меняет; без него Э4 открыл бы дыру
                // молча.
                eq(serviceRequestFiles.purpose, 'closing_evidence'),
                inArray(serviceRequestFiles.kind, [...closingKindsForFormat(format)]),
              ),
            )
            .limit(1);
          if (!closing) {
            // Отказ называет ТЕ бумаги, которые закроют ИМЕННО ЭТУ заявку: перечень наследия у
            // документной подачи (Э4) был бы прямой неправдой — человек принёс бы счёт, уже
            // лежащий в заявке основанием, и получил бы тот же отказ второй раз.
            throw err.unprocessable(
              format === 'document'
                ? 'Перевод в «Решена» требует акта о выполненных работах — счёт, которым предъявлен объём работ, заявку не закрывает'
                : 'Перевод в «Решена» требует закрывающего документа — акта, счёта или гарантийного талона',
              { files: 'Нет закрывающего документа' },
            );
          }
        }

        /**
         * ДОКУМЕНТНАЯ ЗАЯВКА ЗАКРЫВАЕТСЯ НАЛИЧИЕМ АКТА, А НЕ ПОЛНОТОЙ ДАННЫХ (Р8, ответ В9): объём
         * работ предъявлен счётом, содержимое счёта системе до распознавания неизвестно, и требовать
         * от исполнителя цифры, которых он никуда не вводил, нечем. Остаётся дата и слово
         * исполнителя — ровно столько же, сколько у внутреннего ремонта, но по другой причине.
         *
         * ВЕТВЬ ЯВНАЯ, А НЕ «САМО СОЙДЁТСЯ ПРИ НУЛЕ СТРОК», и это не осторожность ради осторожности:
         * строки ЧЕРНОВИКА документная подача не удаляет (Р10 — набранное до переключения режима не
         * теряется), то есть строки в заявке лежать МОГУТ. Пройди она общий путь, проверка «отметка
         * нужна по каждой строке» потребовала бы факт по черновику, которого никто не предъявлял, а
         * сумма этого черновика стала бы итогом по акту.
         *
         * ПРИСЛАННОЕ СОДЕРЖИМОЕ ОТВЕРГАЕТСЯ, А НЕ ИГНОРИРУЕТСЯ (тот же приём и та же причина, что у
         * внутреннего ремонта выше): молча отброшенное поле у денежной ручки — это «сохранилось, но
         * не сохранилось», и один такой случай уже стоил разбора (ADR 0179). 422, а не 403: право
         * закрыть работы у исполнителя есть, негодно именно тело — его собрала залежавшаяся вкладка,
         * не знающая, что объём работ предъявлен счётом. Одним отказом на все четыре поля: выбора,
         * какое из них убрать, у человека нет.
         *
         * ОТКАЗ ПО ТЕЛУ СТОИТ ПОСЛЕ ПЛАНКИ БУМАГ, А НЕ ПЕРЕД НЕЙ. Планка — предусловие самого хода и
         * одна для всех форматов: её человек закрывает одним и тем же действием (принести акт) при
         * любой версии вкладки, а негодное тело исправляет не он, а обновлённый портал. Отвечать
         * сперва про формат тела значило бы разбирать версию клиента раньше, чем состояние заявки.
         *
         * ГАРАНТИЯ ПО ТАКОЙ ЗАЯВКЕ НЕ ФИКСИРУЕТСЯ ВОВСЕ, и сказано это вслух именно здесь. Гарантия
         * живёт только на строке объёма работ (`service_request_items.warranty_until` с `CHECK`
         * «гарантия бывает лишь у выполненной строки»), а предъявленных строк у документной ревизии
         * нет — записать дату некуда, и второго носителя гарантии ради случая, который закроется
         * распознаванием, не заводят. В реестр гарантий такая заявка не попадает по той же причине:
         * он собирается из строк. Нужна гарантия раньше распознавания — раскладка «Ведения»
         * переиздаёт счёт по графам, и заявка возвращается в обычный порядок.
         */
        if (format === 'document') {
          if (
            body.items.length > 0 ||
            (body.consumables?.length ?? 0) > 0 ||
            body.adjustmentAmount != null ||
            body.adjustmentReason
          ) {
            throw err.unprocessable(
              'Объём работ по этой заявке предъявлен счётом — стоимости выполненного система ещё не знает: закрывайте работы датой и актом о выполненных работах',
              { items: 'Объём работ предъявлен счётом' },
            );
          }
          await applyTransition(tx, {
            row,
            to: 'done',
            version: body.version,
            actor: p,
            comment: body.comment,
            patch: {
              completedAt: moscowInstantOf(body.completedOn, '00:00'),
              /**
               * ИТОГ ПО АКТУ — `NULL`, А НЕ НОЛЬ, и разница здесь денежная. `sumAmounts([])` даёт
               * ноль, а записанный ноль читается как «работы бесплатны» (тот же запрет, что у снимка
               * суммы ревизии и у итога расходников): карточка показала бы «0,00 ₽», отчёт по
               * затратам — выполненную задаром работу подрядчика. Пустое поле означает «сумма не
               * разобрана», и ровно это портал и пишет словами.
               *
               * Поля пишутся, а не опускаются: заявка могла быть закрыта прежней ревизией, уехать на
               * доработку и вернуться документной — оставленный снимок прошлого итога стал бы итогом
               * по новому акту.
               */
              finalTotalAmount: null,
              finalAdjustmentAmount: null,
              finalAdjustmentReason: '',
            },
            mail: mailPlan,
          });
          return { mode: 'document' as const };
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
        return { mode: 'items' as const, total, works, movements };
      });

      const after = (await getFullDto(p, row.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.complete',
        entityType: 'serviceRequest',
        entityId: row.id,
        /**
         * Аудит внутреннего закрытия НЕ содержит ни `revision`, ни `total`, ни `works`, ни
         * `changes`, ни `grantedWarranties` (Р6). Ноль в поле суммы — тоже зафиксированная
         * стоимость, и отчёт, читающий журнал, посчитал бы внутренние работы бесплатными вместо
         * «стоимость по ним не фиксируется»; ревизия же была бы следом упразднённого шага. Остаётся
         * то единственное, что человек и вводил, — дата выполнения; автора и слово исполнителя
         * несут запись действия и переход статуса.
         *
         * У ДОКУМЕНТНОГО ЗАКРЫТИЯ ТА ЖЕ ПРИЧИНА ПРИ ДРУГОМ ОСНОВАНИИ (Р8): ревизия в журнале есть —
         * она названа счётом и по ней разбирают денежное решение, — а итога и корректировки нет,
         * потому что стоимости система не знает. Посчитанный ноль, который писал здесь общий путь,
         * читался бы в журнале ценой, и отчёт по затратам на подрядчиков считал бы такую заявку
         * бесплатной. Ни `movements` (расходники этой ветвью отвергнуты), ни `changes`, ни
         * `grantedWarranties`: строк, по которым их собирают, у документной ревизии нет.
         */
        metadata:
          outcome.mode === 'internal'
            ? { completedOn: body.completedOn }
            : outcome.mode === 'document'
              ? { revision: row.estimateRevision, completedOn: body.completedOn }
              : {
                  revision: row.estimateRevision,
                  total: outcome.total,
                  works: outcome.works,
                  adjustment: body.adjustmentAmount ?? null,
                  // Что уехало со склада этим закрытием (Р10): в истории заявки строка «Списано со
                  // склада: Тонер Ricoh 201 — 2 шт» берётся отсюда.
                  movements: outcome.movements,
                  // Что именно предъявил исполнитель: «тормозную площадку не ставили» иначе осталось бы
                  // незамеченным, а гарантию на неё искали бы годом позже.
                  changes: diffServiceCompletion(after.items),
                  /**
                   * Выданные гарантии — снимком (Р77). В самой смете живёт только последнее значение:
                   * возврат на доработку его обнуляет, повторное закрытие перезаписывает, и лента
                   * истории техники не смогла бы ответить, до какого числа обещали в первый раз.
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
  /**
   * ПРИЁМКА РАБОТЫ — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап Э1): коридор, замок
   * непроверенного предмета под блокировкой, переход и журнал. Ручка ниже только отдаёт карточку.
   */
  async function acceptStep(
    p: Principal,
    id: string,
    body: z.infer<typeof acceptServiceRequestSchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<void> {
    assertSideAllowed(p, id, 'accepted', ['done']);
    const row = await requireEditable(p, id);
    assertTransition(p, row.id, row.status, 'accepted');
    // Приёмка — событие переходов: исполнителю важно, что работу приняли.
    const mailPlan = await prepareTransitionMail('accepted', p, row.createdBy);
    await bulk.runTx(async (tx, bulkMail) => {
      const locked = await lockRequest(tx, row.id);
      /**
       * ЗАМОК ПРИЁМКИ ПОД НЕПРОВЕРЕННЫМ ПРЕДМЕТОМ (план `docs/office-equipment-candidate-plan.md`,
       * Р16): пока сообщение о технике ждёт решения, работу по заявке не принимают.
       *
       * ПОСЛЕ `lockRequest`, А НЕ ДО ТРАНЗАКЦИИ, и порядок здесь не косметика: решение
       * проверяющего берёт те же две строки в том же порядке «заявка → кандидат» (`runDecision`),
       * и обратный порядок дал бы дедлок ровно в гонке приёмки с решением. Прочитанное же до
       * транзакции состояние кандидата к моменту `COMMIT` устаревает — между чтением и записью
       * помещается целое решение.
       *
       * Заявок без сообщения замок не касается вовсе: у них `equipment_candidate_id` пуст, и
       * помощник отвечает сразу.
       */
      await assertCandidateDecided(tx, locked.equipmentCandidateId);
      /**
       * ПРИЁМКА НЕ ЗАКРЫВАЕТ СПОР (Р9, находка Н14). Приёмка — конец разбирательства, и принять
       * работу по заявке, освобождение которой кто-то оспорил и не закрыл, значило бы разрешить спор
       * молча и в пользу одной стороны: платёж уходит по сумме, подпись под которой и оспаривали.
       *
       * СТРОКОЙ СПОРА, А НЕ ВИДОМ ЗАМОРОЗКИ, в отличие от запрета возврата. Вид живёт ровно пока
       * заявка отложена — выход из «Отложена» гасит его вместе с остальными полями заморозки, — а
       * приёмка идёт из «Решена», где вид пуст ВСЕГДА. То есть здесь он не ответил бы ни на что, и
       * спрашивать надо сам спор.
       *
       * ОТКРЫТЫЙ СПОР В «Решена» СЕГОДНЯ НЕДОСТИЖИМ — спор держит заявку в «Отложена», а оттуда
       * ведут только возврат (заперт видом выше) и отмена, — и замок стоит именно поэтому: он
       * страхует не известную дыру, а следующий путь из заморозки, который заведут, не вспомнив про
       * спор. Цена страховки — один `SELECT` по ключу под уже взятой блокировкой.
       *
       * 422, А НЕ 409 СОСЕДА НИЖЕ: строка под руками не менялась, и пачка («Принять» бывает
       * массовой) показала бы у 409 свой текст «обновите список» вместо причины — ровно как у
       * возврата из заморозки.
       */
      const dispute = await openDisputeOf(tx, locked.id);
      if (dispute) {
        throw err.unprocessable(
          `По заявке идёт спор об освобождении от подписи (ревизия ${dispute.revision}) — сначала разрешите спор, приёмка его не закрывает`,
          { status: 'По заявке идёт спор' },
        );
      }
      /**
       * СОГЛАСОВАННАЯ РЕВИЗИЯ ОБЯЗАНА СОВПАДАТЬ С ДЕЙСТВУЮЩЕЙ — и до этой правки приёмка не
       * спрашивала НИЧЕГО о деньгах и бумагах (Н14): планку закрывающего документа держит переход в
       * «Решена», а здесь оставались лишь коридор, сторона и решение по непроверенному предмету.
       * Пока подпись нельзя было снять после закрытия работ, этого хватало.
       *
       * Теперь можно: автоподпись освобождения снимается исходом спора «нужна подпись» (Р9) прямо в
       * «Решена», и без этой проверки заявку принимали бы молча — то есть платёж уходил бы по
       * объёму работ, подпись под которым только что отозвали. Условие — то же, что у закрытия
       * работ, и буквально по той же причине: принимают по СОГЛАСОВАННОМУ объёму, а не по
       * предъявленному. Признак `serviceRequestNeedsEstimate` обязателен — у расходников и
       * внутреннего ремонта подписи не бывает вовсе, и равенство заперло бы их приёмку навсегда.
       *
       * НУЛЕВАЯ РЕВИЗИЯ ИЗ ПРОВЕРКИ ИСКЛЮЧЕНА, И ЭТО НЕ ПОСЛАБЛЕНИЕ, А ТА ЖЕ ЛОВУШКА, О КОТОРОЙ
       * предупреждает закрытие работ: `NULL !== 0` истинно, и условие без этого слагаемого заперло бы
       * приёмку заявке, по которой объём работ НЕ ПРЕДЪЯВЛЯЛСЯ ВОВСЕ. Такие в «Решена» есть: наследие
       * до выпуска планки и административный перевод статуса. Дыры это не открывает — у предъявленной
       * ревизии номер всегда больше нуля, и все состояния со снятой либо устаревшей подписью остаются
       * заперты.
       *
       * ПОД БЛОКИРОВКОЙ И ПО ПЕРЕЧИТАННОЙ СТРОКЕ: снятие подписи — это `UPDATE` той же заявки, и
       * прочитанное до транзакции состояние к моменту `COMMIT` устаревает ровно в той гонке, ради
       * которой проверка и заводится.
       *
       * ВТОРОЙ НОВЫЙ ЗАМОК — ЗАПРЕТ ПРИЁМКИ ПРИ ОТКРЫТОМ СПОРЕ — стоит ниже, перед этой проверкой.
       */
      if (
        serviceRequestNeedsEstimate(locked) &&
        locked.estimateRevision > 0 &&
        locked.approvedEstimateRevision !== locked.estimateRevision
      ) {
        throw err.conflict(
          `Согласована ревизия ${locked.approvedEstimateRevision ?? 0}, а в заявке ${locked.estimateRevision} — заявку принимают по согласованному объёму работ, дождитесь подписи`,
        );
      }
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
        bulkMail,
      });
    });
    await writeAudit({
      actorUserId: p.id,
      action: 'serviceRequest.accept',
      entityType: 'serviceRequest',
      entityId: row.id,
      metadata: { total: num(row.finalTotalAmount), ...bulk.audit },
    });
  }

  r.patch(
    '/:id/accept',
    { ...canChangeStatus, schema: { params: idParams, body: acceptServiceRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      await acceptStep(p, req.params.id, req.body);
      return (await getDto(p, req.params.id))!;
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
      assertSideAllowed(p, req.params.id, 'in_work', ['done']);
      const row = await requireEditable(p, req.params.id);
      assertTransition(p, row.id, row.status, 'in_work');
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
  /**
   * ОТМЕНА И АДМИНИСТРАТИВНЫЕ ОТКАТЫ — ЕДИНСТВЕННОЙ ФУНКЦИЕЙ (план массовых действий, Р2, этап
   * Э1). Шаг один на обе команды, потому что целевой статус приходит телом: массовая «отмена» —
   * это его вариант с `status: 'cancelled'`, а откаты массовыми не бывают вовсе (§4 того же
   * плана), и вторая функция рядом означала бы второй разбор одной матрицы.
   *
   * Ручка ниже разбирает тело и собирает ответ «заявка плюс исход письма».
   */
  async function statusStep(
    p: Principal,
    id: string,
    body: z.infer<typeof serviceStatusChangeSchema>,
    bulk: BulkStepContext = outsideBulk,
  ): Promise<ModuleMailOutcome> {
    const to = body.status;
    // Здесь дуга не одна: целевой статус называет тело, а исходных у отмены и откатов много.
    assertSideAllowed(p, id, to);
    const row = await requireEditable(p, id);
    if (to !== 'cancelled' && !SERVICE_ADMIN_ROLLBACKS[row.status].includes(to)) {
      throw err.unprocessable(
        `Этой ручкой заявку только отменяют и откатывают назад; переход «${serviceRequestStatusLabels[row.status]}» → «${serviceRequestStatusLabels[to]}» делается своим действием`,
        { status: 'Другое действие' },
      );
    }
    assertTransition(p, row.id, row.status, to);
    // Переход, отменяющий чужую работу, требует объяснения: без него в истории останется пара
    // строк, по которой не понять, что именно случилось.
    if (serviceStatusChangeRequiresReason(row.status, to) && !body.reason) {
      throw err.unprocessable('Укажите причину', { reason: 'Укажите причину' });
    }

    /**
     * ВТОРОЙ ВХОД В «РЕКОМЕНДОВАНА ЗАМЕНА» (Р10, Н3 плана
     * `docs/office-equipment-card-and-list-cleanup-plan.md`). Прежде пометку и решение ставил
     * единственный ход — отказ по объёму работ; у внутреннего ремонта объёма работ после Р5 не
     * бывает, и «чинить нецелесообразно, аппарат под замену» сказать было бы нечем. По этой же
     * пометке собирают список того, что пора менять, — то есть без второго входа волна закрыла бы
     * этап вместе со списком.
     *
     * ПАРА ПРИНИМАЕТСЯ ТОЛЬКО У ОТМЕНЫ РЕМОНТА. Вид — потому что у расходников «замены» не бывает:
     * менять картридж на другой картридж — это и есть заявка, а не вывод по ней. Статус — потому
     * что обе колонки живут у отменённой заявки и только у неё (`service_requests_replacement_check`
     * и `service_requests_rejection_resolution_check`), и присланные на административном откате они
     * упёрлись бы в базу пятисоткой вместо внятного ответа.
     */
    const cancelsRepair = to === 'cancelled' && row.kind === 'repair';
    const resolution = body.resolution ?? '';
    const replacement = body.replacementRecommended ?? false;
    /*
     * Непустые значения там, где их не принимают, — ОТКАЗ, а не молчаливое отбрасывание: окно
     * отмены могло остаться открытым в чужой вкладке над заявкой, которую уже откатили, и
     * «сохранилось, но не сохранилось» — худший из исходов: человек уверен, что аппарат помечен к
     * замене, а в списке замен его нет.
     */
    if (!cancelsRepair && (resolution || replacement)) {
      throw err.unprocessable(
        to === 'cancelled'
          ? 'Замена вместо ремонта отмечается только у ремонтной заявки'
          : 'Замена вместо ремонта отмечается только при отмене заявки',
        { replacementRecommended: 'Не тот переход' },
      );
    }
    /*
     * Отмеченная замена без решения — пометка без содержания: список «что менять» читают через
     * месяц, и строка «рекомендована замена» без единого слова о том, что делаем вместо ремонта,
     * отправляет читателя искать автора. У обычной отмены (дубль, ошибка, заявка потеряла смысл)
     * решение не спрашивается вовсе — там его и нет.
     */
    if (replacement && !resolution) {
      throw err.unprocessable('Отметив замену, напишите, что делаем вместо ремонта', {
        resolution: 'Укажите решение',
      });
    }
    /** Есть ли что записывать: пустая пара полей — обычная отмена, и полей заявки она не трогает. */
    const decided = cancelsRepair && (resolution !== '' || replacement);

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

    const transition = await bulk.runTx(async (tx, bulkMail) => {
      const applied = await applyTransition(tx, {
        row,
        to,
        version: body.version,
        actor: p,
        comment: body.reason,
        // Поля пишутся ТОЛЬКО когда их прислали: пустой патч у обычной отмены и есть «замена не
        // рекомендована», а записанный `false` рядом с пустой строкой означал бы решение, которого
        // никто не принимал, — тот же довод, по которому пометку перестал ставить за человека
        // отказ по объёму работ (Р8 плана цикла).
        patch: decided
          ? { replacementRecommended: replacement, rejectionResolution: resolution }
          : undefined,
        mail: mailPlan,
        bulkMail,
      });
      /**
       * ОТМЕНА ЗАКРЫВАЕТ ОТКРЫТЫЙ СПОР ТОЙ ЖЕ ТРАНЗАКЦИЕЙ (Р9). Матрица разрешения обещает исход
       * КАЖДОМУ спору, и на исходе держится весь постфактумный контроль над освобождениями (Р13):
       * «чем кончился спор» — это запись, а не догадка по статусу заявки.
       *
       * ПОЧЕМУ НЕ ОТКАЗ, КАК У ВОЗВРАТА ИЗ ЗАМОРОЗКИ И ПРИЁМКИ. Там обычная дверь ведёт НЕ ТУДА:
       * возврат пустил бы заявку работать с автоподписью, которую оспорили, а приёмка оплатила бы
       * её. Отмена ведёт ровно туда, куда ведёт исход `cancel` матрицы, — в «Отменена», не стирая
       * ни факта, ни документов; отбивать её значило бы запирать аварийный выход у заявки, которую
       * и так решено закрыть. Тем более что право `serviceRequests.status` есть и у подрядчика, а
       * права разрешить спор (`assign`) у него нет и быть не может: отказ оставил бы его заявку
       * висеть до чужого хода.
       *
       * ПОСЛЕ ПЕРЕХОДА — тот же порядок, что у самой ручки разрешения: сверку версии делает переход,
       * и спор, закрытый раньше него, остался бы «разрешённым» у заявки, которая никуда не уехала.
       * Условие `state = 'open'` защищает от второго закрытия той же строки.
       *
       * ЗАПИСЬ ИДЁТ И В ПАЧКЕ: массовая отмена зовёт этот же шаг, и другого входа в отмену у модуля
       * нет.
       */
      let disputeClosed: { revision: number } | null = null;
      if (to === 'cancelled') {
        const now = new Date();
        const [closed] = await tx
          .update(serviceRequestEstimateDisputes)
          .set({
            state: 'resolved',
            outcome: 'cancel',
            resolvedBy: p.id,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(serviceRequestEstimateDisputes.requestId, row.id),
              eq(serviceRequestEstimateDisputes.state, 'open'),
            ),
          )
          .returning({ revision: serviceRequestEstimateDisputes.revision });
        disputeClosed = closed ?? null;
      }
      return { ...applied, disputeClosed };
    });
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
        /*
         * Решение и пометка — ТЕМ ЖЕ ФОРМАТОМ, что у отказа по объёму работ (Р10): пометка полем,
         * решение элементом `changes`. Сборка истории достаёт содержание события только из
         * `metadata.changes` (`service-request-history.ts`), и записанное полем рядом решение она
         * молча пропустила бы — в ленте осталась бы отмена без единого слова о том, что делаем
         * вместо ремонта. Ветка условна, потому что пустая пара «— → —» нарисовала бы в истории
         * строку изменения, которого не было.
         */
        ...(decided
          ? {
              replacementRecommended: replacement,
              changes: [{ field: 'rejectionResolution', from: '', to: resolution }],
            }
          : {}),
        /*
         * Спор, закрытый этой же отменой, — в журнал: после неё `hold_kind` и `held_from_status`
         * погашены, и по самой заявке уже не ответить, что её отменили из-под открытого спора.
         * Ключа нет вовсе у отмены без спора — обычная отмена не должна выглядеть в журнале как
         * разбор спора.
         */
        ...(transition.disputeClosed
          ? { disputeResolved: { revision: transition.disputeClosed.revision, outcome: 'cancel' } }
          : {}),
        ...bulk.audit,
      },
    });
    if (transition.mail?.outcome === 'mail_failed') {
      await writeAudit({
        actorUserId: p.id,
        action: 'serviceRequest.mailFailed',
        entityType: 'serviceRequest',
        entityId: row.id,
        metadata: { event: mailPlan?.intent.event ?? null, ...bulk.audit },
      });
    }
    return transition.mail?.outcome ?? 'not_needed';
  }

  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: serviceStatusChangeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const mail = await statusStep(p, req.params.id, req.body);
      return { request: (await getDto(p, req.params.id))!, mail };
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
   * письмо, а осознанный второй заход — новое.
   *
   * Дверь — «Ведение» и администратор (`assertServiceOperatorSide`, Р9): одного права маршрута для
   * неё мало, оно есть и у подрядчика.
   */
  r.post(
    '/:id/notify',
    { ...canChangeStatus, schema: { params: idParams, body: notifyServiceRequestSchema } },
    async (req): Promise<ServiceRequestNotifyResultDto> => {
      const p = requirePrincipal(req);
      const row = await requireEditable(p, req.params.id);
      // Сторона — сразу за областью и ДО разбора повторяемости: «это не ваш шаг» и «повторять
      // нечего» отвечают о разном, и получи подрядчик 422 о состоянии там, где дверь ему закрыта
      // совсем, — отказ рассказывал бы про заявку вместо того, чтобы рассказать про него.
      assertServiceOperatorSide(p, row.id, 'повторяет письмо службе');

      const event = repeatableServiceMailEventOf(row.status);
      if (!event) {
        throw err.unprocessable('По этой заявке письма службе не отправлялись', {
          status: 'Нечего повторять',
        });
      }
      // Повтор кнопкой шлёт то же письмо тем же адресатам, что и само событие: разойдись они,
      // «отправить ещё раз» означало бы «отправить не всем». Поэтому и путь один — тот же
      // транзакционный сборщик, только с ключом идемпотентности (Р70). Адресаты и настройки
      // читаются ДО транзакции (Р67): отказ по конфигурации внутри неё откатил бы саму рассылку.
      const mailPlan = await prepareTransitionMail(row.status, p, row.createdBy);
      if (!mailPlan) return { mail: 'not_needed', recipients: [] };

      const result = await db.transaction(async (tx) => {
        /**
         * СОСТАВ ИСПОЛНИТЕЛЕЙ ЧИТАЕТСЯ ПОД БЛОКИРОВКОЙ (Р4). Версии в теле у повтора письма нет —
         * рассылка заявку не правит, — и без блокировки решение «повторять ли» принималось бы по
         * составу, который к `COMMIT` уже другой: назначение, прошедшее в этом окне, получило бы
         * вдогонку письмо «разберите заявку», а служба — задание разбирать разобранное.
         *
         * Заодно блокировка сериализует повтор с самим переходом: `anchor` ищется по строке истории
         * ТЕКУЩЕГО статуса, и статус, сменившийся между чтением и запросом, привязал бы письмо к
         * чужому событию.
         */
        const locked = await lockRequest(tx, row.id);
        if (locked.status !== row.status) {
          // 409, а не 422: исправлять в форме нечего — заявка ушла дальше, пока готовилось письмо,
          // и карточку надо перечитать. Тем же кодом отвечает сверка версии у остальных ходов.
          throw err.conflict();
        }
        /**
         * Повтор запирается не только статусом, но и составом исполнителей (Р14). Письмо «Новой»
         * зовёт службу РАЗОБРАТЬ заявку, и повторять его после назначения незачем: задание
         * исполнителю ушло своим письмом, привязанным к действию, а не к статусу. Пока «Новая»
         * означала «ещё не назначена», на этот вопрос отвечал сам статус; после слияния (Р1) он
         * половину ответа потерял бы молча — кнопка осталась бы на месте, а письмо звало бы
         * разбирать заявку, которую уже разобрали.
         *
         * Предикат тот же, каким портал решает, показывать ли кнопку: разойдись они — либо кнопка
         * вела бы в 422, либо повтор оставался бы недоступным там, где сервер его позволяет.
         */
        if (
          !serviceMailRepeatable({ ...(await executorsRowOf(locked, tx)), status: locked.status })
        ) {
          throw err.unprocessable(
            'Заявку уже разобрали и назначили исполнителя — письмо службе повторять незачем',
            { status: 'Нечего повторять' },
          );
        }

        const [entry] = await tx
          .select({ id: serviceRequestStatusHistory.id })
          .from(serviceRequestStatusHistory)
          .where(
            and(
              eq(serviceRequestStatusHistory.requestId, locked.id),
              eq(serviceRequestStatusHistory.toStatus, locked.status),
            ),
          )
          .orderBy(desc(serviceRequestStatusHistory.changedAt))
          .limit(1);
        if (!entry) {
          throw err.unprocessable('В истории заявки нет записи о переходе в текущий статус', {
            status: 'Нечего повторять',
          });
        }

        return queueServiceMailForIntent(tx, {
          prepared: mailPlan,
          side: await readServiceSide(tx, locked.id),
          requestId: locked.id,
          anchor: entry.id,
          idempotencyKey: req.body.idempotencyKey,
        });
      });

      await writeAudit({
        actorUserId: p.id,
        // Именно «поставлено в очередь»: отправляет письмо worker, и «отправлено» здесь было бы
        // обещанием, которого этот момент не даёт.
        action: FAILED_MAIL_OUTCOMES.has(result.outcome)
          ? 'serviceRequest.mailFailed'
          : 'serviceRequest.mailQueued',
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
      if (isServiceRequestClosed(row.status)) {
        throw err.unprocessable(
          `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» не правится`,
        );
      }
      await db.transaction(async (tx) => {
        // Блокировка строки — та же, под которой номер выдаёт обычная отправка: без неё два
        // одновременных примечания получили бы один `seq` и столкнулись на уникальном индексе.
        const locked = await lockRequest(tx, row.id);
        // Сторона — под этой же блокировкой и на `tx` (Р4): реплика уходит в ленту от имени
        // исполнителя, и снятый успевал бы написать её в окне между отзывом назначения и `COMMIT`.
        await assertExecutorSide(p, locked, 'пишет примечание исполнителя', tx);
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
      /**
       * Документ адресован противоположной стороне (§ 3, № 6): подрядчик подшил акт — читает
       * служба, служба подшила счёт — читает подрядчик. Конфигурация почты спрашивается до
       * транзакции, а цели — внутри неё: сторона приложившего известна только под блокировкой.
       */
      const mailPlan = await prepareServiceMail({
        event: 'service_request_document',
        actor: mailActorOf(p),
        authorId: row.createdBy,
      });

      await db.transaction(async (tx) => {
        /**
         * ВСЁ РЕШЕНИЕ — ПОД БЛОКИРОВКОЙ СТРОКИ (Р4). Версии в теле у подшивки нет и быть не может:
         * документ прикладывают к заявке, а не правят её, — и оптимистичная сверка, страхующая
         * остальные ходы, здесь не страхует ничего. Пока аудитория и сторона считались до
         * транзакции, снятый исполнитель успевал положить закрывающий документ в окне между
         * отзывом назначения и `COMMIT`: заявка закрывалась бумагой того, кто ей уже никто (Н3).
         *
         * Поэтому и `lockRequest`, и признаки назначения на `tx`: под той же блокировкой, под
         * которой идут переназначение и отказ исполнителя. Ровно так же считает свои факты чат
         * (`postChatMessage`) — единственное место модуля, где эта гонка была закрыта и до плана.
         *
         * Аудитория и сторона — два слоя одного правила (ADR 0160 решение 7 и Р3), и ни один из них
         * не заменяет стража ручки: `serviceRequests.files` остаётся на месте.
         */
        const locked = await lockRequest(tx, row.id);
        assertFileKindAllowed(
          p,
          locked,
          effectiveStatus(locked),
          kind,
          await executorAssignment(p, locked, tx),
        );

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

        const side = await readServiceSide(tx, locked.id);
        const assignment = await executorAssignment(p, locked, tx);
        const names = await tx
          .select({ filename: files.filename })
          .from(files)
          .where(inArray(files.id, fileIds))
          .orderBy(files.filename);
        const document = {
          targets: documentMailTargets({
            actorOnServiceSide:
              assignment.actsForAssignedCounterparty || assignment.isNamedExecutor,
            actorIsExternal: actsForCounterparty(p, 'service'),
            // Сторона сервиса — не только компания: заявку, которую ведёт свой сисадмин
            // поимённо, документ тоже касается (§5.2).
            hasServiceAssignment:
              side.serviceCounterpartyId !== null || side.executorUserIds.length > 0,
          }),
          kind,
          names: names.map((n) => n.filename),
          total: existing.length + fileIds.length,
        };
        await queueServiceMailForIntent(tx, {
          prepared: mailPlan,
          side,
          requestId: row.id,
          /**
           * Якорь — заявка и хеш пачки: один `POST` даёт одно письмо, ретрай той же пачки второго
           * не создаёт, а номер заявки обязателен — один файл подшивается к двум заявкам, и хеш без
           * него столкнулся бы с ключом соседней.
           */
          anchor: `${row.id}-${createHash('sha256')
            .update([...fileIds].sort().join(','))
            .digest('hex')
            .slice(0, 32)}`,
          document,
          extra: { document: { kind, names: document.names, total: document.total } },
        });
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

    const detached = await db.transaction(async (tx) => {
      const locked = await lockRequest(tx, row.id);
      // Аудитория — под той же блокировкой, что и остальные проверки ручки (Р4): версии в теле у
      // снятия документа нет, и посчитанная снаружи она отвечала бы про назначение, снятое до
      // `COMMIT`. Запрос за строкой исполнителей идёт по `tx` — второе соединение, взятое из общего
      // пула, не отпустив первого, на исчерпанном пуле означает взаимную блокировку.
      const audience = serviceRequestAudienceOf(p, await executorAssignment(p, locked, tx));
      const [link] = await tx
        .select({
          kind: serviceRequestFiles.kind,
          purpose: serviceRequestFiles.purpose,
          // Обе половины признака основания: роль и ревизия. Зачем спрашивать вторую, когда её
          // непустоту у роли держит `CHECK`, — сказано у самого замка ниже.
          estimateRevision: serviceRequestFiles.estimateRevision,
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

      /*
       * ОСНОВАНИЕ ДЕНЕЖНОГО РЕШЕНИЯ НЕ СНИМАЕТСЯ НИКОГДА (Р6 п. 1 плана освобождения) — ни автором,
       * ни распорядителем чужими файлами, ни после возврата объёма работ в правку, ни через две
       * ревизии: отозванная ревизия остаётся тем, на чём решение СТОЯЛО, и страница счёта — её
       * единственное доказательство.
       *
       * Проверка стоит здесь, под той же блокировкой, которой идёт удаление, и внешний ключ её не
       * заменяет: он сторожит строку РЕВИЗИИ, а связь файла удаляют напрямую (Н7) — `RESTRICT` на
       * это не отвечает вовсе.
       *
       * Замок абсолютный, и потому у него есть аварийный выход — карантин (Р6 п. 4): ошибочно
       * загруженный секретный или чужой документ закрывают от доступа, а не выдёргивают из заявки,
       * — «доказательство скрыто по обращению» и «доказательства не было» суть разные факты.
       *
       * ОТКАЗ НАЗЫВАЕТ ОБА ВЫХОДА, И ЭТО НЕ ВЕЖЛИВОСТЬ. Запрет без выхода читается как поломка: тот,
       * кто подал не тот счёт, будет искать обход — попросит распорядителя чужими файлами (а тому
       * замок тоже откажет), потом администратора с доступом к базе, и снимет связь руками, обойдя
       * и ключ. Поэтому в тексте стоят ровно те два пути, которыми ошибку и исправляют: новое
       * предъявление, помечающее прежнюю ревизию недействующей (Р6 п. 3), и закрытие доступа по
       * обращению (Р6 п. 4). Ручка карантина в тексте не называется намеренно: её заводит соседняя
       * волна, и адрес, соврав один раз, дороже отсутствующего адреса.
       *
       * СПРАШИВАЮТСЯ ОБЕ ПОЛОВИНЫ ПРИЗНАКА — роль и ревизия, — хотя `service_request_files_basis_check`
       * (миграция 0309) делает их равносильными. Замок, молчащий при расхождении схемы с
       * представлением о ней, — худший из возможных: ограничение однажды ослабят ради backfill или
       * восстановления из копии, и единственной ценой этого окажется снятое доказательство денежного
       * решения. Цена вопроса — один уже прочитанный столбец.
       */
      if (link.purpose === 'estimate_basis' || link.estimateRevision !== null) {
        throw err.unprocessable(
          'Этим счётом предъявлен объём работ — основание денежного решения из заявки не снимают. ' +
            'Ошибочный счёт не удаляют, а перестают предъявлять: предъявите объём работ заново с ' +
            'верным счётом, и прежний станет недействующим. Секретный или чужой документ закрывают ' +
            'от доступа по обращению в службу, а из заявки он не снимается и так.',
          { kind: 'Основание объёма работ' },
        );
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
       *
       * ВОПРОСА ЗДЕСЬ ДВА, И ОНИ РАЗНЫЕ. Вид снимаемого файла спрашивается половиной правила
       * (`isServiceClosingDocument`) — «такую бумагу после приёмки не снимают», про формат ревизии
       * это условие не знает и знать не должно: бумагу, которая заявку не закрывает, после приёмки
       * всё равно не выдёргивают. А «остался ли ДРУГОЙ ЗАКРЫВАЮЩИЙ» — уже полное правило, и ему
       * нужны оба признака: формат действующей ревизии и роль связи. Формат читается той же
       * транзакцией, которой взята блокировка строки, — «последний» не должен устареть между
       * проверкой и удалением, и раскладка «Ведения» меняет формат ровно так же, как параллельная
       * подшивка меняет состав.
       */
      if (status === 'accepted' && isServiceClosingDocument(link.kind)) {
        const format = await readActiveEstimateFormat(tx, locked.id);
        const [other] = await tx
          .select({ fileId: serviceRequestFiles.fileId })
          .from(serviceRequestFiles)
          .where(
            and(
              eq(serviceRequestFiles.requestId, locked.id),
              eq(serviceRequestFiles.purpose, 'closing_evidence'),
              inArray(serviceRequestFiles.kind, [...closingKindsForFormat(format)]),
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
        const facts = executorFactsOf(p, row.id, tx);
        await assertScope(p, row, tx, facts);
        /**
         * **ОБЛАСТЬ ДЕЙСТВИЙ — И ЗДЕСЬ, ХОТЯ ОБЩЕГО ВХОДА У ЭТОЙ РУЧКИ НЕТ** (план свободного объёма
         * работ, Р7; находка И2 инвентаря доступа).
         *
         * ПОЧЕМУ РУЧКА ИДЁТ МИМО `requireEditable`. Тот отвечает на архивной строке 404 по
         * построению — «удалённую заявку не двигают», — а эта ручка только с архивной и работает.
         * Подпереть её общим входом нельзя ничем: он закрыт ровно тем состоянием, ради которого её
         * зовут. Поэтому обе области выписаны здесь явно и подряд, в том же порядке, что и на общем
         * входе: сперва чтение, потом действия.
         *
         * ЧТО ЭТО ЗАКРЫВАЕТ. До волны ручка была безобидна: архивную заявку бывший исполнитель не
         * видел вовсе, и `assertScope` отбивал его первым же вопросом. След снятия (Р5) расширил
         * ЧТЕНИЕ — и вместе с ним открыл бы эту дверь, потому что других вопросов у неё не было.
         * Восстановление же не чтение: оно возвращает заявку в работу, и отменить его снятый
         * исполнитель уже не сможет. Право `archive.restore` приезжает отдельным набором
         * («Удалённые записи и возврат их из архива»), то есть сочетание «исполнительский профиль +
         * архивный набор» администратор соберёт законно — на нём дыра и открывалась.
         *
         * ПРОЧИХ ПРАВКА НЕ КАСАЕТСЯ: вне исполнительского профиля предикат отвечает «да» без единого
         * условия, и держатель архивного набора с обычной ролью возвращает заявки ровно как вчера.
         *
         * ФАКТЫ НА АРХИВНОЙ СТРОКЕ ЧИТАЮТСЯ ВЕРНО, И ОТДЕЛЬНОГО ПУТИ ДЛЯ НИХ НЕ НУЖНО: мягкое
         * удаление ставит одну колонку `deleted_at` (`archiveStep`) и не трогает ни строк
         * `service_request_executors`, ни `created_by`. Назначение и авторство поэтому спрашиваются
         * по той же заявке теми же помощниками; признаки общие с областью чтения (`facts`), так что
         * второго похода в базу не появляется, и оба вопроса идут той же транзакцией.
         */
        await assertServiceRequestActionable(p, authorPlaceOf(row), facts.isNamedExecutor);
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
   *
   * ОБЛАСТИ У ЭТОЙ РУЧКИ НЕТ, И ЭТО РЕШЕНИЕ, А НЕ НЕДОСМОТР (план аудита исполнителей, Н8/Р9).
   * Общий помощник `registerPurgeRoute` области не спрашивает ни в одном модуле портала, и заводить
   * её здесь незачем: за ручкой стоит невыдаваемое право `records.purge`, то есть администратор,
   * который разбирает мусор по всей базе, — а не «Ведение» своей площадки. Записано это дважды —
   * здесь и строкой манифеста (`service-access-manifest.ts`, `scope: 'none'` с полем `why`):
   * молчащее «область не спрашивается» читалось бы как забытая проверка.
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
