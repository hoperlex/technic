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
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, unionAll } from 'drizzle-orm/pg-core';
import {
  type AddressMeta,
  ADDRESS_NOT_VERIFIED_MESSAGE,
  type AssignVehicleInput,
  calcVehicleRequestCost,
  can,
  // Контакт ездки: жёсткая модель спрашивается за **изменившееся** значение (Р2а), и спрашивается
  // теми же схемами, что при заведении, — иначе форма и правка разошлись бы в границах полей.
  contactNameSchema,
  contactPhoneSchema,
  // Объект затрат (Р25): одна функция на портал и сервер вместо двух десятков мест, разбирающих
  // пару «объект или отдел» самостоятельно.
  costTargetOf,
  verifiedAddressMetaSchema,
  // Коррекция назначения задним числом (ADR 0101, Р8): предикат состояния, который она не
  // снимает, признак операции в теле и текст отказа закрытой заявке.
  ASSIGNMENT_CORRECTION_CLOSED_MESSAGE,
  BACKDATE_PERMISSION_MESSAGE,
  canCorrectAssignment,
  canReassignVehicle,
  type CorrectAssignmentInput,
  canShortenWorkPeriodByEdit,
  changeVehicleAssignmentSchema,
  changeVehicleRequestStatusSchema,
  type ChangeVehicleRequestStatusInput,
  changeVehicleRequestTypeSchema,
  type ChangeVehicleRequestTypeInput,
  CLOSED_REQUEST_STATUSES,
  dateOnlySchema,
  type CompleteVehicleRequestInput,
  type ConfirmScheduleInput,
  createVehicleRequestSchema,
  type CreateVehicleRequestInput,
  decideVehicleEarlyEndSchema,
  earlyEndBlocker,
  earlyEndDateBounds,
  // Недели ЭСМ-2 считаются теми же функциями, что и в самой сверке: правка срока обязана знать,
  // какую бумагу она задевает, до того как её тронет (ADR 0101, Р36).
  esm2Mode,
  // Аннулируемый лист в предпросмотре отката (§5.4): номер человеку, период — чтобы он узнал
  // свою неделю.
  type Esm2CancelPreviewDto,
  type Esm2Period,
  esm2Periods,
  esm2RequestedPeriods,
  type FeedKind,
  type FileDto,
  type FreightTransportRequestDto,
  type AssignRouteInput,
  canJoinRoute,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  isRouteEditable,
  issueRequestEsm2Schema,
  LINEAR_DAY_FROZEN_MESSAGE,
  linearDaysBlocker,
  linearRouteJoinDay,
  planDayBlocker,
  planVehicleRequestDaySchema,
  // Предпросмотр последствий перехода (§5.4): тело у него то же самое, что у самой смены статуса —
  // план обязан считаться по тем входам, по которым его потом исполнит боевая ручка.
  previewVehicleRequestStatusSchema,
  type VehicleRequestStatusPreviewDto,
  type VehicleRequestDaysDto,
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
  // Перегон из карточки заявки: та же схема плюс причина заднего числа (ADR 0101 п. 4). Общая
  // схема перегона остаётся без неё — блоком доставки в переводе в работу дату задаёт не она.
  createRequestRelocationSchema,
  isCargoAmountRequired,
  isDirectoryAddressSource,
  CARGO_AMOUNT_MESSAGE,
  moscowDateKeyOf,
  // Какую дату двигает правка и какая из них решает глубину (ADR 0101, §4) — одной функцией на
  // портал и сервер: форма спрашивает причину ровно там, где её спросит ручка.
  movedRequestDateKey,
  type RequestCalendar,
  // Ближний край даты заявки (ADR 0104): заявитель заказывает технику на завтра до 15:00, позже —
  // с послезавтра. Тем же предикатом форма запирает дни в календаре; день заказа (а не всякую
  // сдвинутую границу срока) называет `movedRequestStartKey`.
  movedRequestStartKey,
  vehicleRequestLeadTimeBlocker,
  onlyWeeklyRows,
  rateForWorkUnit,
  REQUEST_STATUSES,
  type RequestStatus,
  requestTypeChangeBlocker,
  requestVehicleEarlyEndSchema,
  type RequestWaybillDto,
  approvedShiftsBlocker,
  approveVehicleRequestShiftSchema,
  saveVehicleRequestShiftSchema,
  shiftDayBlocker,
  shiftsCompletionWarning,
  type VehicleRequestShiftsDto,
  type VehicleRequestShiftsSummaryDto,
  requestStatusLabels,
  setVehicleRequestApprovalSchema,
  type SpecialEquipmentRequestDto,
  transitionRequiresApproval,
  transitionRequiresAssignment,
  transitionRequiresCompletion,
  transitionResetsWork,
  // Ездка в теле правки (Р2а): жёсткая модель остаётся у **новой** строки, а существующая
  // приходит с послаблениями бэкфила — сверяет её с прежним состоянием сервер.
  type UpdateRequestTripInput,
  updateVehicleRequestSchema,
  type UpdateVehicleRequestInput,
  // Своё время ездки — внутри календарного дня заявки (Р18): одна функция на схему и сервер.
  TRIP_DAY_MESSAGE,
  tripsOutOfRequestDay,
  type VehicleFeedListDto,
  type VehicleFeedQuery,
  type VehicleFeedRow,
  vehicleFeedQuerySchema,
  type VehicleOnSiteDayVehicleDto,
  type VehicleOnSiteListDto,
  type VehicleOnSiteSummaryDto,
  type VehicleRequestAssignmentDto,
  type VehicleRequestCompletionDto,
  type VehicleOwnership,
  type VehicleRequestDto,
  type VehicleRequestDriverDto,
  type VehicleRequestEarlyEndDto,
  type VehicleRequestHistorySummaryDto,
  type VehicleRequestOnSiteQuery,
  type VehicleRequestSummaryDto,
  type VehicleRequestTripDto,
  type VehicleRequestType,
  type VehicleRequestWeeklyExtensionDto,
  type VehicleRequestWeeklyOriginDto,
  vehicleRequestHistoryQuerySchema,
  vehicleRequestListQuerySchema,
  type VehicleRequestListQuery,
  vehicleRequestOnSiteQuerySchema,
  vehicleRequestSummaryQuerySchema,
  vehicleStatusLabels,
  vehicleWorkUnitRateLabels,
  waybillDisplayNumber,
  // Понедельник недели ЭСМ-2: им коррекция проверяет, не стоит ли в неделе названного листа
  // второй действующий бланк (Р11) — недельный замок сверки считается тем же ключом.
  weekStartKey,
  weeklyRowsExcludedBy,
  type RoutePurpose,
} from '@technic/contracts';
import { db } from '../db/client';
// Режим заявки — днями или неделями — читается ровно одним выражением на весь портал: у заявки,
// застигнутой переключением признака у типа, лежит снимок, и живой справочник ей больше не указ.
import { requestIsLinear, requestIsLinearSql } from '../db/linear-mode';
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
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequestCompletions,
  vehicleRequestShifts,
  // Ездки заявки (миграция 0136, Р1) и раскладка их по точкам маршрута (Р4, Р5): адреса,
  // количество и контакты живут здесь, а не в строке деталей грузоперевозки.
  vehicleRequestTrips,
  vehicleRoutePoints,
  vehicleRoutePointTrips,
  // Связь операции коррекции с заявками (ADR 0101, миграция 0129): ею повтор находит заявку,
  // заведённую прежней попыткой той же операции.
  vehicleRequestCorrections,
  vehicleRequestEarlyEndings,
  vehicleRequestFiles,
  vehicleKinds,
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
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
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
// Уборка следов недельной заявки при удалении насовсем (ADR 0085 Р15): общая на все четыре
// вкладки, откуда `purge` доходит до её ссылок.
import { dropWeeklyItemsOfRequest } from '../services/weekly-request-cleanup';
// Недельная часть ленты: область видимости документа и его сборщик DTO. Оба берутся готовыми —
// собери лента свои, они разошлись бы с карточкой недели при первой же правке.
import {
  weeklyRequestObjectScopeWhere,
  weeklyRequestReadWhereOnTable,
} from '../services/weekly-request-access';
import { loadWeeklyDtosByIds } from './weekly-vehicle-requests';
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
  lockRequestRow,
  lockRoute,
  lockRouteOfRequestDay,
  lockRoutePair,
  lockRoutesOfRequest,
  plannedDaysOfRequest,
  relocationRoutesOfRequest,
  routeOfRequestDay,
  routeQuery,
  routeRequestCount,
  routeWaybill,
} from '../services/vehicle-routes';
// Точки маршрута (план `docs/route-trips-plan.md`, этап 3): раскладка ездок и дня по остановкам.
// Заявка зовёт её там, где меняет работу рейса, — при укладке в рейс, правке ездок и постановке
// дня, — потому что задание листа собирается из точек, а не из строк состава.
import {
  assertRoutePlacement,
  placeLinearDay,
  placeRequestTrips,
  syncRequestTripPlacement,
} from '../services/route-points';
// Дни линейного заказа (ADR 0100): чтение плана и сверка его с заявкой. Сверка стоит рядом со
// сверкой листов ЭСМ-2 и зовётся теми же местами — см. `syncLinearRouteDays`.
import {
  asDayRaceConflict,
  auditLinearDaysSync,
  type LinearDaysSyncResult,
  type LinearRequestState,
  loadLinearRequest,
  loadRequestDays,
  lockLinearRequest,
  openDayRoute,
  syncLinearRouteDays,
} from '../services/vehicle-request-days';
import {
  routeWaybillFormFor,
  tripDate,
  waybillRequirementByType,
  waybillRequirementFor,
} from '../services/waybill-issue';
import {
  auditEsm2Sync,
  // Тот же вход и тот же план, что у боевой сверки, но без единой записи (§5.4): им предпросмотр
  // отвечает «что случится», а боевая ручка сверяет, что обещанное ещё верно.
  buildEsm2SyncPlan,
  // Что коррекция назначения задела бы в прошлом (Р8, Р36): действующие листы заявки и прошедшие
  // недели, у которых бумаги нет вовсе. Считается до первой правки — эффективной датой отсюда
  // спрашивается право и глубина.
  esm2CorrectionScope,
  // Неделя ручной выдачи, посчитанная до транзакции: её `periodTo` и есть эффективная дата
  // операции (таблица §4 плана), по которой спрашивается право и глубина.
  esm2OnDemandPeriod,
  type Esm2SheetRef,
  type Esm2SyncResult,
  type IssuedEsm2,
  issueEsm2OnDemand,
  syncEsm2Waybills,
} from '../services/waybill-esm2';
// Снятие подписей объекта под днями работы (Р5) — общим кодом с коррекцией рейса: подпись снимают
// обе операции, и второе написание того же `UPDATE` разошлось бы с первым.
import { clearShiftApprovals, type ShiftApproval } from '../services/vehicle-route-correction';
// Задний ход даты заявки (ADR 0101, Р6 и Р15): право и глубину спрашивает общий предикат, а
// причину, автора и след кладёт общая транзакционная операция — та же, что у бланков.
import {
  backdateOrThrow,
  checkBackdate,
  correctionFingerprint,
  type CorrectionKind,
  type CorrectionRecord,
  CORRECTION_OPERATION_ID_REQUIRED,
  findCorrection,
  linkCorrectionRequests,
  runCorrection,
} from '../services/waybill-correction';
// Последствия изменившегося срока работ — общим сервисом: их же зовёт применение недельной заявки,
// и два описания одного правила разошлись бы при первой правке.
import { afterWorkPeriodChanged, clearPendingEarlyEnd } from '../services/vehicle-request-period';
// Условия появления заказа спецтехники — общим сервисом с применением недельной заявки (ADR 0085):
// иначе проверки классификации и активности площадки разойдутся у формы и у недели.
import {
  assertObjectActive,
  createSpecialEquipmentRequest,
  resolveClassification,
} from '../services/vehicle-request-create';

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
  // Линейная ли это техника (ADR 0100, миграция 0127) — признак **заказанного** типа, не машины:
  // им заявка отвечает, ведут её днями или неделями стояния на площадке и рождаются ли листы
  // ЭСМ-2 сами. Читается **эффективным** выражением (`requestIsLinearSql`): норма ADR 0100 §1 —
  // живой join, но заявку, застигнутую переключением признака, ведёт её снимок (миграция 0137).
  // Отсюда всё и расходится: перегон, дни, отбор по машине, срез «На объекте», визы и
  // `isLinearRequest` берут признак из этой строки, и прямому `vehicleTypes.isLinear` тут не место.
  isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear).as(
    'request_is_linear',
  ),
  // Сам снимок — для метки в интерфейсе (Р7): `isLinear` отвечает «как ведётся», а диспетчеру
  // нужно ещё «почему» и «с какого числа».
  isLinearFrozen: vehicleRequests.isLinearFrozen,
  linearFrozenAt: vehicleRequests.linearFrozenAt,
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
  // День рейса: им портал ловит расхождение с датой подачи — заявку подвинули, а рейс остался на
  // прежнем дне (`routeDateMismatch`).
  routeDate: vehicleRoutes.routeDate,
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
  // Контакт ответственного (миграция 0062) — только у заказа техники на объект: у грузоперевозки
  // контакты уехали на ездку, по одному на каждый конец (Р2), и в строке заявки их больше нет.
  responsibleName: specialEquipmentRequestDetails.responsibleName,
  responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
  /*
   * Момент **первой** подачи (Р3) — всё, что осталось у деталей грузоперевозки после миграции
   * `0136`. Адреса, количество и контакты стали колонками ездки и добираются к странице отдельным
   * запросом (`tripsByRequests`): у заявки с ездками A→B и A→C «адреса разгрузки заявки» не
   * существует, и колонка, отвечавшая на этот вопрос, отвечала бы наугад.
   */
  scheduledAt: freightTransportRequestDetails.scheduledAt,
  scheduledTimeUnspecified: freightTransportRequestDetails.scheduledTimeUnspecified,
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
      // Рейс (маршруты): в колонке списка стоит **грузовой** рейс заявки — та единственная строка
      // состава, у которой нет дня (частичный UNIQUE по `request_id WHERE work_date IS NULL`,
      // миграция 0127). Условие обязательное, а не украшение: с ADR 0100 линейный заказ стоит в
      // стольких рейсах, сколько дней распланировано, и без него строка списка размножилась бы по
      // числу дней. План линейного заказа показывает своя ручка (`GET /:id/days`) — массив дней в
      // строку списка не кладут.
      // leftJoin, а не inner: «в работе и без маршрута» — законное состояние, и такие заявки
      // список обязан показывать первым делом.
      .leftJoin(
        vehicleRouteRequests,
        and(
          eq(vehicleRouteRequests.requestId, vehicleRequests.id),
          isNull(vehicleRouteRequests.workDate),
        ),
      )
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

// Рейсы дней в подзапросе отбора — своими алиасами: обе таблицы уже присоединены к выборке
// (колонка «Маршрут»), и одноимённые внутри EXISTS читались бы как ссылки на внешние.
const dayRouteRequests = alias(vehicleRouteRequests, 'day_route_requests');
const dayRoutes = alias(vehicleRoutes, 'day_routes');

/**
 * Отбор заявок по машине (ADR 0098) — назначенной **или** отработавшей хотя бы один день заказа
 * (ADR 0100 §12).
 *
 * Вторая половина условия появилась вместе с линейной техникой. У линейного заказа назначение —
 * машина по умолчанию (ADR 0100 §4), а работали в конкретные дни другие единицы, и отбор по одному
 * назначению отвечал бы на вопрос «где ходила ТС-341» неверно в обе стороны сразу: показывал бы
 * заказы, на которые она только назначена, и прятал бы те, которые она на самом деле отработала.
 *
 * Одним выражением, потому что мест применения пять — список, лента, архив, «История» и сводка над
 * таблицей, — и разойтись им нельзя: цифра над таблицей обязана сходиться с числом строк под ней, а
 * лента — отвечать то же, что вкладка. Тем же приёмом устроены `assignedLessorWhere` здесь и
 * `specialBusyExists` в гараже.
 *
 * `EXISTS`, а не join: заявка стоит в стольких рейсах, сколько дней распланировано, и join размножил
 * бы строку по числу дней — а в счётчиках завысил бы «всего». Ссылка на назначение при этом остаётся
 * условием по присоединённой колонке: `vehicle_request_assignments` есть во всех пяти запросах
 * (`request_id` там первичный ключ, и строк join не множит).
 *
 * `work_date IS NOT NULL` — не украшение: без него условие поймало бы и грузовую строку состава, то
 * есть заявку, которая просто едет в рейсе этой машины, — а это не «машина работала по заказу», это
 * «машина везёт груз», и спрашивают про это журналом листов и «Маршрутами».
 */
function requestVehicleWhere(vehicleId: string | undefined): SQL | undefined {
  if (!vehicleId) return undefined;
  return or(
    eq(vehicleRequestAssignments.vehicleId, vehicleId),
    exists(
      db
        .select({ one: sql`1` })
        .from(dayRouteRequests)
        .innerJoin(dayRoutes, eq(dayRoutes.id, dayRouteRequests.routeId))
        .where(
          and(
            eq(dayRouteRequests.requestId, vehicleRequests.id),
            isNotNull(dayRouteRequests.workDate),
            eq(dayRoutes.vehicleId, vehicleId),
          ),
        ),
    ),
  );
}

/**
 * Дни заказа, отработанные спрошенной машиной, — по странице целиком, тем же добором, что файлы и
 * сводка смен. Спрашиваются только при отборе по машине: без фильтра вопроса «какими днями совпало»
 * не существует.
 *
 * Ими строка списка и объясняет, почему заявка нашлась по машине, которой на ней не назначено
 * (ADR 0100 §12): пустой список у найденной заявки означает, что совпало назначение.
 */
async function matchedDaysByRequestIds(
  ids: string[],
  vehicleId: string | undefined,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!vehicleId || ids.length === 0) return map;
  const rows = await db
    .select({ requestId: dayRouteRequests.requestId, workDate: dayRouteRequests.workDate })
    .from(dayRouteRequests)
    .innerJoin(dayRoutes, eq(dayRoutes.id, dayRouteRequests.routeId))
    .where(
      and(
        inArray(dayRouteRequests.requestId, ids),
        isNotNull(dayRouteRequests.workDate),
        eq(dayRoutes.vehicleId, vehicleId),
      ),
    )
    .orderBy(asc(dayRouteRequests.workDate));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push(row.workDate!);
    map.set(row.requestId, list);
  }
  return map;
}

/**
 * Машина дня среза у линейных заказов страницы (ADR 0100 §12) — рейс, в который поставлен именно
 * этот день. Заказ без такого дня в карту не попадает вовсе: «день не распланирован» — законный
 * ответ среза, и подменять его назначением нельзя.
 *
 * Подпись машины собирается той же парой «модель · госномер», какой день подписан в таблице дней
 * заказа (`loadRequestDays`): одна и та же машина одного и того же дня не должна называться на двух
 * экранах по-разному. Рейс дня всегда на собственной технике (`assertDayRouteVehicle`), поэтому
 * ветки аренды у подписи нет.
 */
async function dayVehiclesByRequestIds(
  ids: string[],
  onDate: string,
): Promise<Map<string, VehicleOnSiteDayVehicleDto>> {
  const map = new Map<string, VehicleOnSiteDayVehicleDto>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      requestId: dayRouteRequests.requestId,
      routeId: dayRoutes.id,
      routeNum: dayRoutes.num,
      vehicleId: dayRoutes.vehicleId,
      registrationNumber: vehicles.registrationNumber,
      modelName: vehicleModels.name,
      driverPersonId: dayRoutes.driverPersonId,
      driverName: persons.fullName,
    })
    .from(dayRouteRequests)
    .innerJoin(dayRoutes, eq(dayRoutes.id, dayRouteRequests.routeId))
    .innerJoin(vehicles, eq(vehicles.id, dayRoutes.vehicleId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .leftJoin(persons, eq(persons.id, dayRoutes.driverPersonId))
    .where(and(inArray(dayRouteRequests.requestId, ids), eq(dayRouteRequests.workDate, onDate)));
  for (const row of rows) {
    map.set(row.requestId, {
      routeId: row.routeId,
      routeDisplayNumber: formatVehicleRouteNumber(row.routeNum),
      vehicleId: row.vehicleId,
      vehicleLabel: [row.modelName, row.registrationNumber].filter(Boolean).join(' · '),
      driverPersonId: row.driverPersonId,
      driverName: row.driverName ?? '',
    });
  }
  return map;
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

/**
 * «ТС-40/2» — номер заявки и номер ездки в ней. Собирает сервер, а не портал: подпись заявки
 * задана одной функцией на весь портал (`formatVehicleRequestNumber`), и вторая её склейка на
 * клиенте разошлась бы с бланком при первой же смене формата.
 */
function tripDisplayNumber(requestNum: number, tripNum: number): string {
  return `${formatVehicleRequestNumber(requestNum)}/${tripNum}`;
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

// Точки раскладки — своими алиасами: у ездки их две (погрузка и разгрузка), и обе таблицы входят
// в запрос дважды. Одноимённые внутри одного `select` читались бы как одна.
const loadPointTrips = alias(vehicleRoutePointTrips, 'load_point_trips');
const unloadPointTrips = alias(vehicleRoutePointTrips, 'unload_point_trips');
const loadPoints = alias(vehicleRoutePoints, 'load_points');
const unloadPoints = alias(vehicleRoutePoints, 'unload_points');

/**
 * Ездки страницы заявок (Р1) — одним запросом на страницу, а не на строку: тем же приёмом, что
 * файлы, сводка смен и недельные ссылки.
 *
 * Мягко удалённые (Р13а) не приходят вовсе: карточка показывает то, что едет сейчас, а помнить,
 * что именно напечатано, — дело журнала листов и истории. Порядок — по `num`, то есть по тому, как
 * ездки заводили; первая из них и стоит в колонках списка.
 *
 * `displayNumber` («ТС-40/2») собирает сервер, а не портал: номер заявки и номер ездки лежат в
 * разных таблицах, и склеенный на клиенте он разошёлся бы с бланком при первой же смене формата
 * (`formatVehicleRequestNumber` — одна функция на весь портал).
 *
 * Раскладка (`placement`) добирается двумя парами `leftJoin` — по одной на роль. Строк это не
 * множит: `route_point_trips_trip_role_unique` держит у ездки ровно одну погрузку и одну
 * разгрузку, поэтому каждая пара даёт не больше строки. Пусто — заявка не в рейсе либо её вынули.
 */
async function tripsByRequests(
  reader: { select: (typeof db)['select'] },
  requests: readonly { id: string; num: number }[],
): Promise<Map<string, VehicleRequestTripDto[]>> {
  const map = new Map<string, VehicleRequestTripDto[]>();
  if (requests.length === 0) return map;
  const nums = new Map(requests.map((r) => [r.id, r.num]));
  const rows = await reader
    .select({
      id: vehicleRequestTrips.id,
      requestId: vehicleRequestTrips.requestId,
      num: vehicleRequestTrips.num,
      fromLocation: vehicleRequestTrips.fromLocation,
      toLocation: vehicleRequestTrips.toLocation,
      fromAddress: vehicleRequestTrips.fromAddress,
      toAddress: vehicleRequestTrips.toAddress,
      volumeM3: vehicleRequestTrips.volumeM3,
      weightTons: vehicleRequestTrips.weightTons,
      fromResponsibleName: vehicleRequestTrips.fromResponsibleName,
      fromResponsiblePhone: vehicleRequestTrips.fromResponsiblePhone,
      toResponsibleName: vehicleRequestTrips.toResponsibleName,
      toResponsiblePhone: vehicleRequestTrips.toResponsiblePhone,
      scheduledAt: vehicleRequestTrips.scheduledAt,
      comment: vehicleRequestTrips.comment,
      loadPosition: loadPoints.position,
      unloadPosition: unloadPoints.position,
    })
    .from(vehicleRequestTrips)
    .leftJoin(
      loadPointTrips,
      and(eq(loadPointTrips.tripId, vehicleRequestTrips.id), eq(loadPointTrips.role, 'load')),
    )
    .leftJoin(loadPoints, eq(loadPoints.id, loadPointTrips.pointId))
    .leftJoin(
      unloadPointTrips,
      and(eq(unloadPointTrips.tripId, vehicleRequestTrips.id), eq(unloadPointTrips.role, 'unload')),
    )
    .leftJoin(unloadPoints, eq(unloadPoints.id, unloadPointTrips.pointId))
    .where(
      and(
        inArray(
          vehicleRequestTrips.requestId,
          requests.map((r) => r.id),
        ),
        isNull(vehicleRequestTrips.deletedAt),
      ),
    )
    .orderBy(asc(vehicleRequestTrips.requestId), asc(vehicleRequestTrips.num));
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({
      id: row.id,
      num: row.num,
      displayNumber: tripDisplayNumber(nums.get(row.requestId) ?? 0, row.num),
      fromLocation: row.fromLocation,
      toLocation: row.toLocation,
      fromAddress: row.fromAddress,
      toAddress: row.toAddress,
      volumeM3: toNum(row.volumeM3),
      weightTons: toNum(row.weightTons),
      fromResponsibleName: row.fromResponsibleName,
      fromResponsiblePhone: row.fromResponsiblePhone,
      toResponsibleName: row.toResponsibleName,
      toResponsiblePhone: row.toResponsiblePhone,
      scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
      comment: row.comment,
      // Разложена ездка только тогда, когда стоят **обе** точки: одна половина пары — состояние,
      // которого не бывает (Р5), и показывать её как раскладку значило бы обещать рейс, в котором
      // груз некуда везти.
      placement:
        row.loadPosition !== null && row.unloadPosition !== null
          ? { loadPosition: row.loadPosition, unloadPosition: row.unloadPosition }
          : null,
    });
    map.set(row.requestId, list);
  }
  return map;
}

/** Обратные ссылки недельной заявки у страницы заказов: основание и продления (ADR 0085). */
interface WeeklyLinks {
  origins: Map<string, VehicleRequestWeeklyOriginDto>;
  extensions: Map<string, VehicleRequestWeeklyExtensionDto[]>;
}

/**
 * Откуда заказ появился и какими неделями его продлевали (ADR 0085 Р11, Р17) — двумя запросами на
 * страницу, а не на строку: тем же приёмом, что файлы и сводка смен.
 *
 * Ветки разные по смыслу, и объединять их в один запрос нечем: основание ищется по
 * `created_request_id` и всегда одно (частичный `UNIQUE` в базе), продления — по
 * `source_request_id` со строками результата `extended`, и их бывает несколько. Строки `leave` и
 * непримененные строки `extend` сюда не попадают намеренно: они говорят о намерении, а карточка
 * заказа объясняет **состоявшееся** продление срока.
 */
async function weeklyLinksByRequestIds(ids: string[]): Promise<WeeklyLinks> {
  const origins = new Map<string, VehicleRequestWeeklyOriginDto>();
  const extensions = new Map<string, VehicleRequestWeeklyExtensionDto[]>();
  if (ids.length === 0) return { origins, extensions };
  const [created, extended] = await Promise.all([
    db
      .select({
        requestId: weeklyVehicleRequestItems.createdRequestId,
        itemId: weeklyVehicleRequestItems.id,
        weeklyRequestId: weeklyVehicleRequests.id,
        weeklyRequestNum: weeklyVehicleRequests.num,
        deliveryNeeded: weeklyVehicleRequestItems.deliveryNeeded,
        deliveryFrom: weeklyVehicleRequestItems.deliveryFrom,
      })
      .from(weeklyVehicleRequestItems)
      .innerJoin(
        weeklyVehicleRequests,
        eq(weeklyVehicleRequestItems.weeklyRequestId, weeklyVehicleRequests.id),
      )
      .where(inArray(weeklyVehicleRequestItems.createdRequestId, ids)),
    db
      .select({
        requestId: weeklyVehicleRequestItems.sourceRequestId,
        weeklyRequestId: weeklyVehicleRequests.id,
        weeklyRequestNum: weeklyVehicleRequests.num,
        weekStart: weeklyVehicleRequests.weekStart,
      })
      .from(weeklyVehicleRequestItems)
      .innerJoin(
        weeklyVehicleRequests,
        eq(weeklyVehicleRequestItems.weeklyRequestId, weeklyVehicleRequests.id),
      )
      .where(
        and(
          inArray(weeklyVehicleRequestItems.sourceRequestId, ids),
          eq(weeklyVehicleRequestItems.result, 'extended'),
        ),
      )
      .orderBy(asc(weeklyVehicleRequests.weekStart), asc(weeklyVehicleRequests.num)),
  ]);
  for (const row of created) {
    if (!row.requestId) continue;
    origins.set(row.requestId, {
      weeklyRequestId: row.weeklyRequestId,
      weeklyRequestNum: row.weeklyRequestNum,
      itemId: row.itemId,
      deliveryNeeded: row.deliveryNeeded,
      deliveryFrom: row.deliveryFrom,
    });
  }
  for (const row of extended) {
    if (!row.requestId) continue;
    const list = extensions.get(row.requestId) ?? [];
    list.push({
      weeklyRequestId: row.weeklyRequestId,
      weeklyRequestNum: row.weeklyRequestNum,
      weekStart: row.weekStart,
    });
    extensions.set(row.requestId, list);
  }
  return { origins, extensions };
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

/**
 * Ответы на вопрос выдачи — то, чего в самой заявке нет, а есть только в паре «заявка и то, о чём
 * спросили»: машина дня в срезе «На объекте» и дни, которыми заявка совпала с отбором по машине.
 * Выдача, таких вопросов не задававшая, полей не получает вовсе (`undefined`), и это не пробел, а
 * отказ отвечать на незаданное.
 */
interface RequestDtoAnswers {
  dayVehicle?: VehicleOnSiteDayVehicleDto | null;
  matchedDays?: string[];
}

function toDto(
  r: RequestRow,
  fileList: FileDto[],
  trips: VehicleRequestTripDto[],
  shifts?: VehicleRequestShiftsSummaryDto,
  weekly?: {
    origin: VehicleRequestWeeklyOriginDto | null;
    extensions: VehicleRequestWeeklyExtensionDto[];
  },
  answers?: RequestDtoAnswers,
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
    // Объект затрат (Р25) — разобранная пара выше, а не ещё одно поле про заказчика: разбирают её
    // два десятка мест, и каждое вольно решить иначе. Колонкой он не хранится и снимком здесь не
    // становится: выводится тем же `costTargetOf` из тех же шести полей, что лежат рядом.
    costTarget: costTargetOf(r),
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
            routeDate: r.routeDate ?? '',
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
      // Линейность заказанного типа (ADR 0100): ею карточка решает, показывать ли блок недельных
      // листов или ждать, что их попросят по одному. Значение эффективное — см. `requestSelect`.
      isLinear: r.isLinear,
      // Метка «прежний режим: по неделям, с 14.08» (Р7): пары `isLinearFrozen`/`linearFrozenAt`
      // база держит целой (CHECK миграции 0137), но TS о ней не знает — отсюда проверка обеих.
      linearFrozen:
        r.isLinearFrozen !== null && r.linearFrozenAt
          ? { isLinear: r.isLinearFrozen, at: r.linearFrozenAt.toISOString() }
          : null,
      responsibleName: r.responsibleName ?? '',
      responsiblePhone: r.responsiblePhone ?? '',
      earlyEnd: toEarlyEndDto(r),
      // Сводка смен: пустая пара нулей у заявки, по которой ещё ничего не подтверждали, — так же
      // читается «долга нет». Считается запросом рядом с файлами (`toDtos`).
      shifts: shifts ?? { approvedDays: 0, unapprovedPastDays: 0 },
      // «Создан по НЗ-12» и «Продления: НЗ-15, НЗ-18» (ADR 0085): основание одно, продлений бывает
      // несколько. Считаются запросом на страницу там же, где файлы и смены.
      weeklyOrigin: weekly?.origin ?? null,
      weeklyExtensions: weekly?.extensions ?? [],
      // Машина дня и дни совпадения — только там, где о них спросили: в прочих выдачах полей нет
      // вовсе (ADR 0100 §12), и `null` в них означал бы «спросили и не нашли».
      ...(answers?.dayVehicle !== undefined ? { dayVehicle: answers.dayVehicle } : {}),
      ...(answers?.matchedDays !== undefined ? { matchedDays: answers.matchedDays } : {}),
    };
  }
  return {
    ...base,
    requestType: 'freight_transport',
    scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : '',
    scheduledTimeUnspecified: r.scheduledTimeUnspecified ?? false,
    // Ездки (Р1, Р2): то, что прежде лежало парой адресов, количеством и контактами самой заявки.
    // Их не бывает ноль — заявка заводится хотя бы с одной, а последнюю снять нечем; итог по
    // заявке портал и печать считают сами (`requestCargoTotal`), суммы в DTO нет намеренно.
    trips,
  };
}

/**
 * Строки выборки в DTO: файлы и сводка смен подтягиваются к странице целиком — по запросу на
 * список, а не по запросу на строку.
 *
 * Второй аргумент — чем спрашивали саму выдачу, и от него зависит, на что строка отвечает сверх
 * себя самой:
 *
 * - `onDate` передаётся, когда вызывающий уже вычислил день среза (вкладка «На объекте»). Сводка
 *   смен обязана считать «сколько дней прошло» по тому же дню, по которому отбирались строки, иначе
 *   список и подписи в нём отвечали бы про разные сутки. С ADR 0100 тот же день выбирает и машину
 *   строки у линейного заказа: срез отвечает «что на площадке сегодня», а не «чем заказ взяли в
 *   работу вообще»;
 * - `vehicleId` передаётся там, где по машине отбирали (`requestVehicleWhere`): заявка находится и
 *   днями, а строка обязана объяснить, чем именно совпала.
 */
async function toDtos(
  rows: RequestRow[],
  q: { onDate?: string; vehicleId?: string } = {},
): Promise<VehicleRequestDto[]> {
  const ids = rows.map((r) => r.id);
  const [filesMap, tripsMap, shiftsMap, weekly, matchedDays, dayVehicles] = await Promise.all([
    filesByRequestIds(ids),
    // Ездки — тем же добором на страницу, что и файлы: строка списка показывает первую из них, а
    // карточка все, и запрос на строку превратил бы список из двадцати заявок в двадцать запросов.
    tripsByRequests(db, rows),
    shiftSummaries(rows, q.onDate ?? moscowDateKeyOf(new Date())),
    weeklyLinksByRequestIds(ids),
    matchedDaysByRequestIds(ids, q.vehicleId),
    q.onDate
      ? dayVehiclesByRequestIds(ids, q.onDate)
      : Promise.resolve(new Map<string, VehicleOnSiteDayVehicleDto>()),
  ]);
  return rows.map((row) =>
    toDto(
      row,
      filesMap.get(row.id) ?? [],
      tripsMap.get(row.id) ?? [],
      shiftsMap.get(row.id),
      {
        origin: weekly.origins.get(row.id) ?? null,
        extensions: weekly.extensions.get(row.id) ?? [],
      },
      {
        // Машину дня спрашивают только у линейного заказа: у прочих день среза машину не выбирает —
        // она стоит на площадке весь срок, и ответ на этот вопрос у них один, назначение.
        dayVehicle: q.onDate && row.isLinear ? (dayVehicles.get(row.id) ?? null) : undefined,
        matchedDays: q.vehicleId ? (matchedDays.get(row.id) ?? []) : undefined,
      },
    ),
  );
}

async function getDto(id: string): Promise<VehicleRequestDto | null> {
  const [row] = await baseQuery().where(eq(vehicleRequests.id, id));
  if (!row) return null;
  const [dto] = await toDtos([row]);
  return dto ?? null;
}

/**
 * Заявка, заведённая прежней попыткой той же операции (ADR 0101, Р31): на повторе `runCorrection`
 * не зовёт `perform` вовсе, а ответить обязан тем же самым — и найти заявку больше нечем. Номера у
 * клиента нет (он его и не знал, когда посылал запрос), есть только ключ операции, а связь
 * «операция → заявка» пишет сама операция (`linkCorrectionRequests`).
 *
 * Пустой ответ означает, что ключом воспользовалась операция другого вида — до этой строки такой
 * запрос не доходит (`runCorrection` сверяет отпечаток и автора и отвечает 409), поэтому здесь тот
 * же 409: продолжать, не понимая, что произошло, дороже, чем попросить обновить страницу.
 */
/**
 * Это повтор уже выполненной правки задним числом (ADR 0101, Р31)?
 *
 * Своей веткой, потому что у правки повтор выглядит иначе, чем у всех прочих команд коррекции:
 * второй раз календарь никуда не двигается — он **уже** там, куда его двинули, — и
 * `movedRequestDateKey` честно отвечает «сдвига нет». Обычной дорогой такой запрос идти не должен:
 * он разобьётся о версию заявки, и человек, у которого оборвалась связь, прочтёт «конфликт версий»
 * о правке, которая на самом деле сохранена, — то есть ровно то, ради чего ключ и заводили.
 *
 * Сверяются оба признака, как и в самой операции: автор и отпечаток тела. Одного ключа мало —
 * клиент, переиспользовавший uuid для другой правки, молча не сохранил бы её: мы вернули бы ему
 * карточку, ничего не записав. Отпечаток считается тем же способом, что и внутри `runCorrection`,
 * иначе повтор перестал бы опознаваться при первой же правке нормализации.
 */
async function repeatedRequestEdit(input: {
  operationId: string;
  actorUserId: string;
  requestId: string;
  body: unknown;
}): Promise<boolean> {
  const prior = await findCorrection(db, input.operationId);
  if (!prior || prior.actorUserId !== input.actorUserId) return false;
  const fingerprint = correctionFingerprint({
    kind: 'request_date' satisfies CorrectionKind,
    target: input.requestId,
    body: input.body,
  });
  return prior.fingerprint === fingerprint;
}

async function correctionRequestId(correctionId: string): Promise<string> {
  const [row] = await db
    .select({ requestId: vehicleRequestCorrections.requestId })
    .from(vehicleRequestCorrections)
    .where(eq(vehicleRequestCorrections.correctionId, correctionId));
  if (!row) throw err.conflict('Операция с этим ключом заявки не заводила — обновите страницу');
  return row.requestId;
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

/** День в адресе ручек плана — тем же параметром, что и у смен: день у них один и тот же. */
const dayParams = shiftParams;

/**
 * Заявка глазами дней плюс область видимости — общее начало всех трёх ручек плана.
 *
 * Область спрашивается по DTO (как и у смен): в нём собраны заказчик и арендодатель, по которым
 * считаются `assertRequestScope` и `assertLessorScope`. Правила дней читают своё состояние —
 * признак линейности заказанного типа, срок и назначение, — и берут его отдельным запросом:
 * DTO отвечает «что это за заявка», а не «можно ли распланировать её день».
 */
async function requireDaysRequest(p: Principal, id: string): Promise<LinearRequestState> {
  const request = await getDto(id);
  if (!request) throw err.notFound('Заявка не найдена');
  assertArchiveVisible(p, request.deletedAt, 'Заявка не найдена');
  assertRequestScope(p, request);
  // Арендодатель ведёт свои заявки (ADR 0038), но чужой парк и его водители — не его дело: в плане
  // по дням стоят машины и люди собственного парка.
  assertLessorScope(p, request.assignment?.lessorId ?? null);
  const state = await loadLinearRequest(db, id);
  if (!state) throw err.notFound('Заявка не найдена');
  return state;
}

/**
 * Ответ ручек плана: дни срока целиком, день среза и причина, по которой дней не ведут вовсе.
 * Причина отдаётся вместе с таблицей, а не вместо неё: у арендного заказа дней не бывает, и блок
 * обязан объяснить это словами, а не пустотой (план У14).
 */
async function daysResponse(request: LinearRequestState): Promise<VehicleRequestDaysDto> {
  return {
    items: await loadRequestDays(db, request),
    onDate: moscowDateKeyOf(new Date()),
    blocker: linearDaysBlocker(request),
  };
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
 *
 * Одна функция на заведение и на переоформление (ADR 0091): тело у них одной формы — полный состав
 * своего типа, — и заказчик читается из него одинаково.
 */
function customerOf(
  body: CreateVehicleRequestInput | ChangeVehicleRequestTypeInput,
): RequestCustomer {
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
 * Как ездка названа в отказе.
 *
 * Сохранённая — своим номером («ездка ТС-40/2»), новая — строкой присланного списка: номера у неё
 * ещё нет, его назначит сервер (Р13а), и выдумывать «будущий второй» значило бы назвать в отказе
 * то, чего не существует. Путь поля рядом с сообщением указывает на ту же строку машинно
 * (`trips.1.fromAddress`), поэтому форма подсветит её независимо от слов.
 */
function tripLabel(requestNum: number, index: number, num: number | null): string {
  return num === null
    ? `новая ездка (строка ${index + 1})`
    : `ездка ${tripDisplayNumber(requestNum, num)}`;
}

/** Путь поля ездки в теле запроса — тем же видом, каким его составляет zod (`trips.1.volumeM3`). */
function tripField(index: number, field: string): string {
  return `trips.${index}.${field}`;
}

/**
 * Ездка глазами серверной проверки: значения из тела плюс номер, если он у ездки уже есть.
 *
 * Номер здесь необязателен намеренно — им отличается перезапись от заведения (Р2а): у строки без
 * `id` номера ещё нет, его назначит запись, и в отказе такая ездка называется строкой формы.
 */
interface TripCheckRow {
  num: number | null;
  volumeM3?: number | null;
  weightTons?: number | null;
}

/**
 * Объём или масса груза — там, где груз бывает, и **у каждой ездки** (Р2).
 *
 * Условие спрашивает бланк заказанного типа ТС: у формы № 3 (легковой автомобиль) груза нет, и
 * требовать число значило бы заставлять заявителя его выдумывать. Схема этого не проверяет —
 * бланк живёт в справочнике, и взять его ей неоткуда (ADR 0037 п. 4, тот же приём, что у
 * категории ТС и ставок).
 *
 * Бланк читается один раз на весь список, а не на ездку: тип у заявки один, и шесть одинаковых
 * запросов к справочнику ради шести строк ничего бы не уточнили.
 */
async function assertCargoAmount(
  tx: Tx,
  vehicleTypeId: string,
  requestNum: number,
  trips: readonly TripCheckRow[],
): Promise<void> {
  const empty = trips.findIndex((t) => t.volumeM3 == null && t.weightTons == null);
  if (empty < 0) return;

  const [row] = await tx
    .select({ formCode: vehicleTypes.waybillFormCode })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, vehicleTypeId));
  if (!isCargoAmountRequired(row?.formCode ?? null)) return;
  throw err.unprocessable(
    `${tripLabel(requestNum, empty, trips[empty]!.num)}: ${CARGO_AMOUNT_MESSAGE}`,
    { [tripField(empty, 'volumeM3')]: CARGO_AMOUNT_MESSAGE },
  );
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
 *
 * Спрашивается у **ездки** (Р2): адресов у заявки больше нет, и отказ обязан называть ту строку
 * списка, в которой выбор устарел, — иначе в форме с шестью ездками человек ищет её сам.
 */
async function assertDirectoryAddress(
  tx: Tx,
  at: { field: string; trip: string },
  location: string,
  meta: AddressMeta | null | undefined,
): Promise<void> {
  if (!meta || !isDirectoryAddressSource(meta.source)) return;
  // Ссылку требует контракт (`verifiedAddressMetaSchema`); здесь она уже есть.
  const refId = meta.refId!;
  const fail = (message: string) =>
    err.unprocessable(`${at.trip}: ${message}`, { [at.field]: message });

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

// ── Ездки заявки: запись (Р1, Р2а, Р13а) ──

/**
 * Тот же адрес: и печатаемая строка, и метаданные.
 *
 * Поле за полем, а не сравнением JSON: в базе лежит `jsonb`, и порядок ключей в нём не задан —
 * `{"source":…,"fiasId":…}` и `{"fiasId":…,"source":…}` описывают один адрес, а строками
 * различаются. Необязательные поля сводятся к `null`: отсутствующий ключ и `null` в нём означают
 * одно и то же — «этого у адреса нет».
 */
function sameAddressMeta(a: AddressMeta | null, b: AddressMeta | null): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.source === b.source &&
    (a.fiasId ?? null) === (b.fiasId ?? null) &&
    (a.fiasLevel ?? null) === (b.fiasLevel ?? null) &&
    (a.geoLat ?? null) === (b.geoLat ?? null) &&
    (a.geoLon ?? null) === (b.geoLon ?? null) &&
    (a.refId ?? null) === (b.refId ?? null)
  );
}

/**
 * Что не так с адресом для записи (ADR 0006), либо `null`, если он годится. Тем же разбором, что
 * и в схеме заведения: `null` отдельной веткой — иначе человек прочёл бы служебное «expected
 * object, received null» вместо «выберите из подсказок».
 */
function verifiedAddressIssue(meta: AddressMeta | null): string | null {
  if (!meta) return ADDRESS_NOT_VERIFIED_MESSAGE;
  const parsed = verifiedAddressMetaSchema.safeParse(meta);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? ADDRESS_NOT_VERIFIED_MESSAGE);
}

/**
 * Жёсткая модель адреса — за **новое** значение, а не за перезапись прежнего (Р2а).
 *
 * Нетронутый адрес принимается как есть, и это не послабление, а условие того, что старые заявки
 * останутся правимыми: бэкфил принёс строки без метаданных (заявки старше ADR 0006 и миграции
 * `0062`), а ездки правятся полным списком — приёма «не отправлять нетронутое» у списка нет. Не
 * будь этой ветки, уточнение телефона в такой заявке требовало бы сначала выдумать за прошлое
 * адрес из справочника.
 *
 * Сравнивается пара целиком: сменилась печатаемая строка или сменились метаданные — значение
 * новое, и жёсткая модель спрашивается с него полностью.
 */
function assertAddressWritable(
  next: { location: string; meta: AddressMeta | null },
  prev: { location: string; meta: AddressMeta | null } | null,
  at: { field: string; trip: string },
): void {
  if (
    prev &&
    prev.location.trim() === next.location.trim() &&
    sameAddressMeta(prev.meta, next.meta)
  ) {
    return;
  }
  const issue = verifiedAddressIssue(next.meta);
  if (issue) throw err.unprocessable(`${at.trip}: ${issue}`, { [at.field]: issue });
}

/**
 * То же для контакта (Р2а): пустое имя и несводимый телефон принимаются, пока их не трогают, —
 * у заявок старше миграции `0062` контакта нет вовсе, а телефон бывает легаси-строкой (ADR 0066).
 * Изменённое значение проверяется той же схемой, что при заведении.
 */
function assertContactWritable(
  next: string,
  prev: string | null,
  schema: typeof contactNameSchema | typeof contactPhoneSchema,
  at: { field: string; trip: string },
): void {
  if (prev !== null && prev === next) return;
  const parsed = schema.safeParse(next);
  if (parsed.success) return;
  const message = parsed.error.issues[0]?.message ?? 'Некорректное значение';
  throw err.unprocessable(`${at.trip}: ${message}`, { [at.field]: message });
}

/** Сохранённая ездка под блокировкой — ровно те колонки, с которыми сравнивается присланная. */
const storedTripColumns = {
  id: vehicleRequestTrips.id,
  num: vehicleRequestTrips.num,
  fromLocation: vehicleRequestTrips.fromLocation,
  toLocation: vehicleRequestTrips.toLocation,
  fromAddress: vehicleRequestTrips.fromAddress,
  toAddress: vehicleRequestTrips.toAddress,
  volumeM3: vehicleRequestTrips.volumeM3,
  weightTons: vehicleRequestTrips.weightTons,
  fromResponsibleName: vehicleRequestTrips.fromResponsibleName,
  fromResponsiblePhone: vehicleRequestTrips.fromResponsiblePhone,
  toResponsibleName: vehicleRequestTrips.toResponsibleName,
  toResponsiblePhone: vehicleRequestTrips.toResponsiblePhone,
  scheduledAt: vehicleRequestTrips.scheduledAt,
  comment: vehicleRequestTrips.comment,
  deletedAt: vehicleRequestTrips.deletedAt,
};

/**
 * Ездки заявки под блокировкой — **все**, вместе с мягко удалёнными (Р13а).
 *
 * Удалённые нужны обеим сторонам договора: без них `id` снесённой ездки прошёл бы как «строка не
 * найдена, заведём новую» (а это тихая подмена: в выданном листе стоит та, снесённая), и номер
 * новой ездки сел бы на освободившееся место — то самое переиспользование, которого Р13а не
 * допускает.
 */
async function lockRequestTrips(tx: Tx, requestId: string) {
  return tx
    .select(storedTripColumns)
    .from(vehicleRequestTrips)
    .where(eq(vehicleRequestTrips.requestId, requestId))
    .orderBy(asc(vehicleRequestTrips.num))
    .for('update');
}

type StoredTrip = Awaited<ReturnType<typeof lockRequestTrips>>[number];

/** Присланная ездка так, как она ляжет в базу; `num` у новой назначает запись. */
function tripValues(t: UpdateRequestTripInput): Omit<StoredTrip, 'id' | 'num' | 'deletedAt'> {
  return {
    fromLocation: t.fromLocation,
    toLocation: t.toLocation,
    fromAddress: t.fromAddress ?? null,
    toAddress: t.toAddress ?? null,
    volumeM3: numToDb(t.volumeM3),
    weightTons: numToDb(t.weightTons),
    fromResponsibleName: t.fromResponsibleName,
    fromResponsiblePhone: t.fromResponsiblePhone,
    toResponsibleName: t.toResponsibleName,
    toResponsiblePhone: t.toResponsiblePhone,
    scheduledAt: t.scheduledAt ? new Date(t.scheduledAt) : null,
    comment: t.comment,
  };
}

/** Ездка изменилась: значение к значению, теми же полями, которыми она и пишется. */
function tripChanged(next: ReturnType<typeof tripValues>, prev: StoredTrip): boolean {
  return (
    next.fromLocation !== prev.fromLocation ||
    next.toLocation !== prev.toLocation ||
    !sameAddressMeta(next.fromAddress, prev.fromAddress) ||
    !sameAddressMeta(next.toAddress, prev.toAddress) ||
    // Количество сравнивается числами, а не строками numeric: «12» и «12.000» — одно и то же
    // значение, и записанное обратно оно не должно читаться как правка.
    toNum(next.volumeM3) !== toNum(prev.volumeM3) ||
    toNum(next.weightTons) !== toNum(prev.weightTons) ||
    next.fromResponsibleName !== prev.fromResponsibleName ||
    next.fromResponsiblePhone !== prev.fromResponsiblePhone ||
    next.toResponsibleName !== prev.toResponsibleName ||
    next.toResponsiblePhone !== prev.toResponsiblePhone ||
    (next.scheduledAt?.getTime() ?? null) !== (prev.scheduledAt?.getTime() ?? null) ||
    next.comment !== prev.comment
  );
}

/**
 * Ездки заявки после правки — полным списком (§7, Р2а, Р13а).
 *
 * Одна функция на заведение, правку и переоформление: у заведения сохранённых ездок просто нет, и
 * каждая присланная строка проходит жёсткую модель целиком — ровно то же, что делает схема. Второй
 * записи того же порядка быть не должно: разойдись они, заявка, которую приняло заведение,
 * перестала бы сохраняться правкой.
 *
 * По шагам:
 *
 * 1. сохранённые ездки берутся под блокировкой — вместе с мягко удалёнными;
 * 2. `id` чужой заявки или удалённой ездки — отказ, а не тихое заведение новой;
 * 3. поле за полем: на **изменившемся** адресе спрашивается верификация (ADR 0006), на
 *    изменившемся контакте — непустое имя и сводимый телефон; нетронутое принимается как есть;
 * 4. своё время ездки обязано лежать в календарном дне заявки (Р18), количество — там, где его
 *    требует бланк типа ТС (`assertCargoAmount`);
 * 5. записывается изменившееся: новые строки получают следующие свободные номера, пропавшие из
 *    списка — `deleted_at`.
 *
 * Возвращает признак «состав или значения ездок изменились»: им правка решает, поднимать ли
 * версию маршрута (Р18) — задание листа собрано ровно из этих полей.
 */
async function applyRequestTrips(
  tx: Tx,
  params: {
    requestId: string;
    /** Номер заявки — им ездка называется в отказах («ездка ТС-40/2»). */
    requestNum: number;
    /** Заказанный тип ТС **после** правки: его бланк решает, обязательно ли количество. */
    vehicleTypeId: string;
    /** Момент подачи заявки после правки: в его календарном дне обязаны лежать времена ездок. */
    scheduledAt: Date;
    /** Полный состав заявки после правки; пустой список — ездок не остаётся (переоформление). */
    trips: readonly UpdateRequestTripInput[];
  },
): Promise<{ changed: boolean }> {
  const stored = await lockRequestTrips(tx, params.requestId);
  const byId = new Map(stored.map((t) => [t.id, t]));
  const seen = new Set<string>();

  // Присланная строка и её прежнее состояние — парами, один раз на весь дальнейший разбор.
  const pairs = params.trips.map((input, index) => {
    const label = tripLabel(
      params.requestNum,
      index,
      input.id ? (byId.get(input.id)?.num ?? null) : null,
    );
    if (!input.id) return { input, index, label, prev: null };
    const prev = byId.get(input.id);
    // Чужая ездка — это не «заведём новую»: под тем же `id` в другой заявке едет свой груз, и
    // молчаливое заведение подменило бы правку заведением, ничего не сказав.
    if (!prev) {
      // Не `tripLabel`: тот назвал бы строку с неизвестным `id` новой ездкой, а она как раз
      // объявлена существующей — и именно это в ней и не сходится.
      throw err.unprocessable(`строка ${index + 1}: ездка не из этой заявки — обновите страницу`, {
        [tripField(index, 'id')]: 'Ездка не найдена',
      });
    }
    if (prev.deletedAt) {
      throw err.unprocessable(
        `ездка ${tripDisplayNumber(params.requestNum, prev.num)} удалена — заведите новую вместо неё`,
        { [tripField(index, 'id')]: 'Ездка удалена' },
      );
    }
    if (seen.has(input.id)) {
      throw err.unprocessable(
        `ездка ${tripDisplayNumber(params.requestNum, prev.num)} встречается в списке дважды`,
        { [tripField(index, 'id')]: 'Ездка повторяется' },
      );
    }
    seen.add(input.id);
    return { input, index, label, prev };
  });

  for (const { input, index, label, prev } of pairs) {
    const at = (field: string) => ({ field: tripField(index, field), trip: label });
    assertAddressWritable(
      { location: input.fromLocation, meta: input.fromAddress ?? null },
      prev ? { location: prev.fromLocation, meta: prev.fromAddress } : null,
      at('fromAddress'),
    );
    assertAddressWritable(
      { location: input.toLocation, meta: input.toAddress ?? null },
      prev ? { location: prev.toLocation, meta: prev.toAddress } : null,
      at('toAddress'),
    );
    assertContactWritable(
      input.fromResponsibleName,
      prev?.fromResponsibleName ?? null,
      contactNameSchema,
      at('fromResponsibleName'),
    );
    assertContactWritable(
      input.fromResponsiblePhone,
      prev?.fromResponsiblePhone ?? null,
      contactPhoneSchema,
      at('fromResponsiblePhone'),
    );
    assertContactWritable(
      input.toResponsibleName,
      prev?.toResponsibleName ?? null,
      contactNameSchema,
      at('toResponsibleName'),
    );
    assertContactWritable(
      input.toResponsiblePhone,
      prev?.toResponsiblePhone ?? null,
      contactPhoneSchema,
      at('toResponsiblePhone'),
    );
  }

  /*
   * Своё время ездки — внутри календарного дня заявки (Р18), и здесь спрашивается сохранённый
   * день: схема отвечает только за случай, когда обе стороны сравнения видны из тела. Одна
   * функция на схему и сервер — разойдись они, форма приняла бы то, чем ручка ответит 422.
   */
  const [outOfDay] = tripsOutOfRequestDay(params.scheduledAt.toISOString(), params.trips);
  if (outOfDay !== undefined) {
    throw err.unprocessable(`${pairs[outOfDay]!.label}: ${TRIP_DAY_MESSAGE}`, {
      [tripField(outOfDay, 'scheduledAt')]: TRIP_DAY_MESSAGE,
    });
  }

  await assertCargoAmount(
    tx,
    params.vehicleTypeId,
    params.requestNum,
    pairs.map(({ input, prev }) => ({
      num: prev?.num ?? null,
      volumeM3: input.volumeM3,
      weightTons: input.weightTons,
    })),
  );

  // Запись справочника сверяется только у изменившегося адреса — по тому же правилу Р2а: у
  // нетронутого выбор состоялся тогда, когда заявку заводили, и отклонять его сегодня из-за
  // переименованного склада значило бы запереть правку телефона за правкой справочника.
  let changed = false;
  // Следующий свободный номер считается по **всем** строкам заявки, включая мягко удалённые
  // (Р13а): переиспользуй его — и «ТС-40/2» в старом листе и «ТС-40/2» в новом означали бы
  // разное. Счётчик растёт и внутри одной правки: две новые ездки получают два разных номера.
  let maxNum = stored.reduce((max, t) => Math.max(max, t.num), 0);
  for (const { input, index, label, prev } of pairs) {
    const next = tripValues(input);
    if (prev && !tripChanged(next, prev)) continue;
    changed = true;
    if (
      !prev ||
      next.fromLocation !== prev.fromLocation ||
      !sameAddressMeta(next.fromAddress, prev.fromAddress)
    ) {
      await assertDirectoryAddress(
        tx,
        { field: tripField(index, 'fromLocation'), trip: label },
        next.fromLocation,
        next.fromAddress,
      );
    }
    if (
      !prev ||
      next.toLocation !== prev.toLocation ||
      !sameAddressMeta(next.toAddress, prev.toAddress)
    ) {
      await assertDirectoryAddress(
        tx,
        { field: tripField(index, 'toLocation'), trip: label },
        next.toLocation,
        next.toAddress,
      );
    }
    if (prev) {
      await tx.update(vehicleRequestTrips).set(next).where(eq(vehicleRequestTrips.id, prev.id));
    } else {
      maxNum += 1;
      await tx
        .insert(vehicleRequestTrips)
        .values({ requestId: params.requestId, num: maxNum, ...next });
    }
  }

  // Ездка, которой в присланном списке не оказалось, удаляется мягко (Р13а): на неё может
  // ссылаться выданный лист, а журнал бланков строгой отчётности обязан помнить, что печаталось.
  const dropped = stored.filter((t) => !t.deletedAt && !seen.has(t.id));
  if (dropped.length > 0) {
    changed = true;
    await tx
      .update(vehicleRequestTrips)
      .set({ deletedAt: new Date() })
      .where(
        inArray(
          vehicleRequestTrips.id,
          dropped.map((t) => t.id),
        ),
      );
  }
  return { changed };
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
  options: {
    /**
     * Назначение переписывает прошедшие дни (ADR 0101 п. 15, Р17). Тогда состояние машины не
     * спрашивается: типичная коррекция за прошлую неделю касается как раз той единицы, которую с
     * тех пор списали или отправили в ремонт, а истории статусов у техники нет — проверить «была
     * ли она активна тогда» нечем. Отказать по нынешнему статусу значило бы запретить исправлять
     * ровно то, ради чего коррекцию и завели.
     *
     * Удалённая запись остаётся отказом и здесь: это не «машина в ремонте», а «такой машины в
     * портале нет».
     */
    correction?: boolean;
  } = {},
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
  if (row.status !== 'active' && !options.correction) {
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
 * Линейный ли это заказ (ADR 0100 §1). Признак есть только у заказа техники на объект: у
 * грузоперевозки его нет вовсе — она ходила в рейсы всегда и днями не ведётся.
 *
 * Читается из DTO, а не запросом: DTO и так собран join'ом заказанного типа, и второе чтение того
 * же признака разошлось бы с первым ровно в тот момент, когда справочник правят рядом.
 */
function isLinearRequest(r: VehicleRequestDto): boolean {
  return r.requestType === 'special_equipment' && r.isLinear;
}

/**
 * Рейсы, которых правка заявки касается, — под блокировкой и в каноническом порядке (Р17).
 *
 * Порядок «маршруты → заявки» объявлен ADR 0050 п. 12, а внутри — по возрастанию `id`, тем же
 * правилом, каким `lockRoutePair` берёт пару переноса: две встречные правки иначе встали бы во
 * взаимную блокировку. Описывать «маршрут заявки» в единственном числе здесь нельзя: у
 * грузоперевозки он один (Р7), а у линейного заказа их столько, сколько дней распланировано, и
 * правка контакта или комментария задевает их все.
 *
 * Какие именно это рейсы, известно из связи, а связь читается до блокировки — поэтому её
 * перечитывает `lockRoutesOfRequest` уже под ней (Р17): между чтением и `FOR UPDATE` заявку
 * успевают переложить в соседний рейс, и правка разложила бы её ездки в чужой день.
 *
 * `extraRouteIds` — рейс, названный телом запроса: перевод в работу и смена машины кладут заявку в
 * готовый маршрут, и он берётся тем же проходом, а не отдельным `lockRoute` после. Иначе две
 * встречные команды «переставить заявку из A в B» и «из B в A» взяли бы одну пару в двух порядках.
 *
 * Заморозка спрашивается сразу: она нужна и тому, кто версию поднимает, и тому, кто отказывает
 * (Р15), а второй запрос за листом того же рейса ответил бы то же самое.
 */
async function lockRequestRoutes(
  tx: Tx,
  requestId: string,
  extraRouteIds: readonly string[] = [],
): Promise<{ id: string; frozen: boolean; purpose: RoutePurpose; vehicleId: string }[]> {
  const routes = await lockRoutesOfRequest(tx, requestId, extraRouteIds);
  // Назначение и машина едут вместе с рейсом не для показа: по ним выводится его бланк
  // (`routeWaybillFormFor`, ADR 0065), а бланк задаёт ёмкость задания — сколько строк влезет
  // после раскладки правленых ездок по точкам.
  const locked: { id: string; frozen: boolean; purpose: RoutePurpose; vehicleId: string }[] = [];
  for (const route of routes) {
    const waybill = await routeWaybill(tx, route.id);
    locked.push({
      id: route.id,
      frozen: !isRouteEditable(waybill?.status ?? null),
      purpose: route.purpose,
      vehicleId: route.vehicleId,
    });
  }
  return locked;
}

/**
 * Рейс, названный телом запроса: он берётся вместе с рейсами заявки, а не отдельным захватом после
 * них (Р17). Новый рейс сюда не попадает — его строка рождается в этой же транзакции, и спорить за
 * неё некому.
 */
function namedRouteIds(route: AssignRouteInput | undefined): string[] {
  return route && 'routeId' in route ? [route.routeId] : [];
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
      /** Линейный ли заказанный тип (ADR 0100 §1): у такой заявки рейс не один, а по одному на день. */
      isLinear: boolean;
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
    // техники на объект рейса не существует — там период стояния машины на площадке. У линейного
    // заказа рейсы есть, но не здесь и не один: дни планируют по одному после перевода в работу,
    // разными машинами и разными водителями (ADR 0100 §8).
    if (params.route) {
      throw err.unprocessable(
        params.request.isLinear
          ? 'Дни линейного заказа планируются после перевода в работу — по одному, из карточки заявки: на разные дни выходят разные машины'
          : (requirement.reason ??
              'На эту заявку маршрут не ведётся: путевой лист по ней не выписывается'),
        { route: 'Маршрут не ведётся' },
      );
    }
    return;
  }

  const routeDate = await tripDate(tx, params.request.id);
  // Грузовая строка заявки — та единственная, у которой дня нет: день несёт сам рейс. Линейные
  // дни сюда не попадают вовсе (у них другой вид заявки), но спрашивать их «заодно» нельзя —
  // ответом стал бы первый попавшийся день.
  const current = await routeOfRequestDay(tx, params.request.id, null);

  // Повторный перевод в работу после отката: заявка уже стоит в рейсе, и трогать его незачем —
  // ровно так же прежняя выдача не поднимала второй талон для той же заявки.
  const requestedId = params.route && 'routeId' in params.route ? params.route.routeId : null;
  if (current && (!requestedId || requestedId === current.routeId)) return;

  if (current) {
    /*
     * Прежний рейс заявки взят из связи, а связь прочитана без блокировки (Р17): между чтением и
     * захватом её успевают переложить в третий рейс, и заявка ушла бы из того маршрута, где её уже
     * нет, — вместе со своими точками. Поэтому оба рейса берутся сразу и по возрастанию `id`
     * (`lockRoutePair`), а связь перечитывается под блокировкой.
     */
    await lockRoutePair(tx, requestedId ?? current.routeId, current.routeId);
    const again = await routeOfRequestDay(tx, params.request.id, null);
    if (again?.routeId !== current.routeId) {
      throw err.conflict('Заявку переложили в другой маршрут, пока вы её вели — обновите карточку');
    }
  }

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
        isLinear: params.request.isLinear,
        // Статус целевой: заявка становится «В работе» в этой же транзакции.
        status: 'confirmed',
        deletedAt: null,
        // День заявки — точка: сюда доходит только грузоперевозка, у которой день несёт подача.
        day: { kind: 'trip', date: routeDate },
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
  /*
   * Ездки раскладываются точками тут же (Р8, §4.2): «взял в работу» обязано быть законченным
   * действием — иначе диспетчер получал бы рейс, в котором заявка есть, а порядка объезда нет.
   * Погрузка и разгрузка садятся на уже стоящие точки того же тождества (в том числе собранные
   * прежними заявками), иначе заводятся новые в конец.
   *
   * Следом — ёмкость бланка **строками задания** (Р11): заявка с тремя ездками занимает три
   * строки, а `canJoinRoute` выше считает строки состава и такой заявки не заметил бы. Бланк здесь
   * тот же, которым решался сам вопрос «нужен ли рейс»: рейс заведён на машину назначения, а чужую
   * машину существующий рейс не принимает (проверка выше).
   */
  await placeRequestTrips(tx, targetId!, params.request.id);
  await assertRoutePlacement(tx, { routeId: targetId!, formCode: requirement.formCode });
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
    request: { id: string; num: number; requestType: VehicleRequestType; isLinear: boolean };
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
  // Перегон — про машину, которая приезжает на площадку и остаётся там. Линейная уезжает вечером
  // домой, и её выезд это обычный рейс дня (ADR 0100 §9): доставлять её на объект нечем и незачем.
  if (params.request.isLinear) {
    throw err.unprocessable(
      'Линейная техника вечером возвращается на базу — её выезд это обычный рейс дня: планируйте дни в карточке заявки, перегон ей не заводят',
      { purpose: 'Линейная техника' },
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
 * Рейсов у заявки бывает и несколько: у линейного заказа их столько, сколько дней распланировано
 * (ADR 0100 §2), и снимаются они **все** — отменённая заявка не оставляет за собой ни одного дня.
 * Замороженные при этом остаются, каждый со своей бумагой: правило одно и то же на день и на
 * грузовую заявку.
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
): Promise<{ droppedRelocations: string[]; detachedDays: string[] }> {
  // Перегоны: та же граница «отмена и возврат в „Новую“», но состава у них нет — убирается сам
  // рейс. «Выполнена» их не трогает: технику вывозят и после того, как работы закрыли.
  const droppedRelocations =
    next === 'cancelled' || next === 'new' ? await dropPlannedRelocations(tx, requestId) : [];

  const detachedDays: string[] = [];
  // Порядок блокировок один на модуль: рейсы берутся по возрастанию `id`, иначе две встречные
  // смены статуса встанут во взаимную блокировку (тем же порядком работает `lockRoutePair`), а
  // связь перечитывается уже под блокировкой (Р17) — иначе отмена сняла бы заявку с того рейса, в
  // котором её на самом деле уже нет.
  for (const route of await lockRoutesOfRequest(tx, requestId)) {
    const waybill = await routeWaybill(tx, route.id);
    const frozen = !isRouteEditable(waybill?.status ?? null);
    if (!shouldDetachOnStatus(next, frozen)) continue;
    const removed = await detachRequest(tx, route.id, requestId);
    await bumpRouteVersion(tx, route.id, actorId);
    if (removed?.workDate) detachedDays.push(removed.workDate);
  }
  return { droppedRelocations, detachedDays };
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
  /*
   * У линейного заказа переезжать нечему: назначение — машина по умолчанию, а фактическая машина
   * каждого дня своя и живёт в своём рейсе (ADR 0100 §4). Сменили машину заявки — сменилась та,
   * что выйдет в следующий незапланированный день; уже распланированные дни остаются как есть,
   * иначе смена техники утащила бы за собой один случайный день из тридцати.
   */
  if (params.request.isLinear) return;
  // Лист, выписанный до маршрутов, держит заявку так же, как замороженный рейс: в бланке стоят
  // прежние машина и водитель, а рейса, который можно было бы проверить, у него нет. Спрашивается
  // до всего остального — новой машине бланк может быть и не нужен, но выданный уже на руках.
  const legacyWaybill = await legacyWaybillOf(tx, params.request.id);
  if (legacyWaybill) {
    throw err.conflict(`${ROUTE_LEGACY_WAYBILL_MESSAGE} (${legacyWaybill})`);
  }
  const current = await routeOfRequestDay(tx, params.request.id, null);
  if (current) {
    /*
     * Оба конца переезда — одним захватом и по возрастанию `id` (Р17, `lockRoutePair`). Прежде
     * здесь стоял одиночный `lockRoute` прежнего рейса, а рейс новой машины брался позже, уже из
     * `attachToRoute`: две встречные смены техники — «ТС-1 из A в B» и «ТС-2 из B в A» — брали
     * тогда одну пару в противоположных порядках и вставали во взаимную блокировку. Проверено
     * встречными транзакциями: до правки Postgres разрывал одну из них.
     *
     * Целевой рейс называет тело запроса; новый (`newRoute`) сюда не попадает — его строка
     * рождается в этой же транзакции.
     */
    const [targetId] = namedRouteIds(params.route);
    const { source } = await lockRoutePair(tx, targetId ?? current.routeId, current.routeId);
    const route = source!;
    // Связь перечитывается под блокировкой (Р17): рейс выяснен из неё, а прочитана она была без
    // блокировки — за это время заявку успевают переложить, и мы сняли бы её точки в чужом дне.
    const again = await routeOfRequestDay(tx, params.request.id, null);
    if (again?.routeId !== route.id) {
      throw err.conflict('Заявку переложили в другой маршрут, пока вы её вели — обновите карточку');
    }
    const waybill = await routeWaybill(tx, route.id);
    if (!isRouteEditable(waybill?.status ?? null)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
    // Роли ездок уходят каскадом состава, опустевшие точки — вместе с ними (Р13, `detachRequest`).
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

/**
 * Детерминированная сериализация значения: ключи объектов по алфавиту, `undefined` выброшено,
 * порядок элементов массива сохранён (в плане ЭСМ-2 им задан порядок недель).
 *
 * Нужна ровно затем, чтобы два независимых расчёта одного и того же входа дали одну строку:
 * порядок ключей в JSON не гарантирован ни клиентом, ни драйвером, а отпечаток предпросмотра
 * сравнивается побайтово.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalize(value: unknown): unknown {
  // Дата во входе плана не ждётся, но `JSON.stringify` превратил бы её в строку, а обход по
  // ключам — в пустой объект: два разных дня дали бы один отпечаток.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    normalized[key] = canonicalize(source[key]);
  }
  return normalized;
}

/**
 * Отпечаток обещания предпросмотра (§5.4): вход плана ЭСМ-2 целиком плюс само действие.
 *
 * Хешируется **весь нормализованный вход**, а не выбранные из него поля. Ручной перечень
 * `id:период` не заметил бы перевешивания листа на другую машину, а решение «оставить или сжечь»
 * принимается именно по машине и машинисту (`sameVehicle`, `sameDriver`): диалог пообещал бы одно,
 * а сверка сделала бы другое. Новый вход `esm2SyncPlan` попадает сюда сам, не требуя правки.
 *
 * Второй сомножитель — тело перехода: подтверждали конкретное действие, а не «какой-нибудь откат».
 * `version` в него не входит — у неё своя проверка и свой текст ошибки, — а `comment` и сам
 * `previewFingerprint` плана не касаются вовсе.
 */
function statusPreviewFingerprint(
  planInput: unknown,
  body: Pick<ChangeVehicleRequestStatusInput, 'status' | 'assignment' | 'schedule' | 'completion'>,
): string {
  const action = canonicalJson({
    status: body.status,
    assignment: body.assignment,
    schedule: body.schedule,
    completion: body.completion,
  });
  return createHash('md5')
    .update(`${canonicalJson(planInput)}|${action}`)
    .digest('hex');
}

/**
 * Аннулируемые листы — человеку, а не идентификаторами: в диалоге он ищет свой бланк и свою
 * неделю, и «сгорит 2 листа» без номеров не даёт проверить обещание ничем.
 */
async function esm2CancelPreview(tx: Tx, ids: readonly string[]): Promise<Esm2CancelPreviewDto[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(inArray(waybills.id, [...ids]))
    // Неделя за неделей: порядок в диалоге читается календарём, а не порядком, в каком сверка
    // сложила свой список.
    .orderBy(waybills.periodFrom);
  return rows.map((row) => ({
    id: row.id,
    number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
    from: row.periodFrom ?? '',
    to: row.periodTo ?? '',
  }));
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
      tripsChangeSubstance(before.trips, body.trips)
    );
  }
  return false;
}

/**
 * Меняют ли ездки суть заявки (ADR 0025): состав, адреса и количество — да, контакты и примечание
 * — нет.
 *
 * Граница та же, что и была у заявки с одной парой адресов, и проведена она по тому же признаку:
 * руководитель строительства визирует, **что и куда везут**, а не то, кто встретит машину на
 * воротах. Уточнённый телефон визу не снимает — иначе исправление опечатки в номере останавливало
 * бы рейс до повторного согласования.
 *
 * Список не прислан вовсе — ездок не трогали (§7), и суть не менялась.
 */
function tripsChangeSubstance(
  before: readonly VehicleRequestTripDto[],
  trips: readonly UpdateRequestTripInput[] | undefined,
): boolean {
  if (!trips) return false;
  if (trips.length !== before.length) return true;
  const byId = new Map(before.map((t) => [t.id, t]));
  return trips.some((t) => {
    const prev = t.id ? byId.get(t.id) : undefined;
    if (!prev) return true;
    return (
      t.fromLocation !== prev.fromLocation ||
      t.toLocation !== prev.toLocation ||
      (t.volumeM3 ?? null) !== prev.volumeM3 ||
      (t.weightTons ?? null) !== prev.weightTons ||
      (t.scheduledAt ? new Date(t.scheduledAt).getTime() : null) !==
        (prev.scheduledAt ? new Date(prev.scheduledAt).getTime() : null)
    );
  });
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

// ── Календарь заявки для правила заднего числа (ADR 0101, Р29) ──

/**
 * Календарь заведённой заявки: у грузоперевозки день подачи по МСК, у заказа на объект границы
 * срока. Момент подачи сводится к дню намеренно — граница заднего числа считается днями, и час
 * в ней не значит ничего (§4 плана, «Часовой пояс»).
 */
function requestCalendarOf(r: VehicleRequestDto): RequestCalendar {
  return r.requestType === 'freight_transport'
    ? { scheduledDay: moscowDateKeyOf(new Date(r.scheduledAt)) }
    : { dateFrom: r.dateFrom, dateTo: r.dateTo };
}

/**
 * Тот же календарь из тела правки. Не переданное поле остаётся `undefined` — «не трогали», и
 * различать это с `null` обязательно: снятая дата окончания календарь двигает, непереданная нет.
 */
/**
 * Тот же календарь из тела переоформления (ADR 0091). Отдельно от `editedRequestCalendar`, потому
 * что тело здесь полное, а не частичное: `undefined` в нём не бывает, и «не трогали» тоже — у
 * нового типа своя деталь, и дата в ней стоит всегда.
 */
function retypedRequestCalendar(body: ChangeVehicleRequestTypeInput): RequestCalendar {
  return body.requestType === 'freight_transport'
    ? { scheduledDay: moscowDateKeyOf(new Date(body.scheduledAt)) }
    : { dateFrom: body.dateFrom, dateTo: body.dateTo ?? null };
}

function editedRequestCalendar(body: UpdateVehicleRequestInput): RequestCalendar {
  if (body.requestType === 'freight_transport') {
    return {
      scheduledDay:
        body.scheduledAt === undefined ? undefined : moscowDateKeyOf(new Date(body.scheduledAt)),
    };
  }
  return { dateFrom: body.dateFrom, dateTo: body.dateTo };
}

/**
 * Недели ЭСМ-2, которые правка срока задела бы в уже прошедшем (Р8, Р21).
 *
 * Считается симметрической разностью «нужных недель» до и после правки, суженной до недель,
 * кончившихся раньше сегодня. Обе половины разности — беда, и разная:
 *
 * - неделя **появилась** — листа за неё нет и не будет: сверка прошедшую неделю не выписывает,
 *   пока не придёт проверенный контекст коррекции (`esm2SyncPlan`, этап 6);
 * - неделя **исчезла или сдвинула границы** — выписанный лист остался бы с периодом, которого у
 *   заявки больше нет: аннулировать его сверка тоже не станет — отработанная неделя ей закрыта.
 *
 * Набор недель считается тем же способом, каким его считает сама сверка: в `auto` его задаёт срок
 * заявки, в `on_demand` (линейный заказ, ADR 0100) — уже выписанные листы, подрезанные сроком.
 * Второй расчёт «каких недель заявке не хватает» разошёлся бы с первым при первой же правке.
 */
async function pastEsm2WeeksTouched(
  before: VehicleRequestDto,
  body: UpdateVehicleRequestInput,
  today: string,
): Promise<Esm2Period[]> {
  if (before.requestType !== 'special_equipment' || body.requestType !== 'special_equipment') {
    return [];
  }
  const mode = esm2Mode({
    requestType: before.requestType,
    status: before.status,
    ownership: before.assignment?.ownership ?? null,
    deletedAt: before.deletedAt,
    isLinear: before.isLinear,
  });
  // Бумаги у заявки нет вовсе — ни арендной, ни «Новой», ни закрытой: задевать нечего.
  if (mode === 'none') return [];
  // Листы нужны только линейному заказу: там набор недель задают они, а не срок.
  const sheets =
    mode === 'on_demand'
      ? await db
          .select({
            id: waybills.id,
            periodFrom: waybills.periodFrom,
            periodTo: waybills.periodTo,
            vehicleId: waybills.vehicleId,
            driverPersonId: waybills.driverPersonId,
          })
          .from(waybills)
          .where(and(eq(waybills.sourceRequestId, before.id), ne(waybills.status, 'cancelled')))
      : [];
  const wanted = (dateFrom: string, dateTo: string | null): Esm2Period[] =>
    mode === 'auto'
      ? esm2Periods(dateFrom, dateTo)
      : esm2RequestedPeriods(
          sheets.map((s) => ({ ...s, periodFrom: s.periodFrom!, periodTo: s.periodTo! })),
          dateFrom,
          dateTo,
        );

  const next = workPeriodAfterEdit(before, body);
  const key = (p: Esm2Period): string => `${p.from}|${p.to}`;
  const was = wanted(before.dateFrom, before.dateTo);
  const now = wanted(next.dateFrom, next.dateTo);
  const wasKeys = new Set(was.map(key));
  const nowKeys = new Set(now.map(key));
  return [...was.filter((p) => !nowKeys.has(key(p))), ...now.filter((p) => !wasKeys.has(key(p)))]
    .filter((p) => p.to < today)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

// ── Коррекция назначения задним числом (ADR 0101, Р8) ──

/**
 * Подписи объекта под днями работы заявки — те, которые коррекция снимет (Р5, ADR 0101 п. 16).
 *
 * Все подтверждённые дни, а не выборка: назначение у заявки одно на весь срок, и, переписав в нём
 * машину, операция меняет то, чем работали **во все** подписанные дни разом. Дня, которого правка
 * не коснулась, здесь просто не бывает.
 *
 * Прежние `approvedBy`/`approvedAt` читаются вместе со строками: в таблице после снятия их не
 * останется, а в снимке операции они и есть ответ на «кто принял эти часы» через два месяца.
 */
async function approvedShiftsOfRequest(
  requestId: string,
  displayNumber: string,
): Promise<ShiftApproval[]> {
  const rows = await db
    .select({
      shiftDate: vehicleRequestShifts.shiftDate,
      approvedBy: vehicleRequestShifts.approvedBy,
      approvedByName: users.fullName,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .innerJoin(users, eq(users.id, vehicleRequestShifts.approvedBy))
    .where(
      and(
        eq(vehicleRequestShifts.requestId, requestId),
        isNotNull(vehicleRequestShifts.approvedAt),
      ),
    )
    .orderBy(vehicleRequestShifts.shiftDate);
  return rows.flatMap((row) =>
    row.approvedBy && row.approvedAt
      ? [
          {
            requestId,
            displayNumber,
            date: row.shiftDate,
            approvedBy: row.approvedBy,
            approvedByName: row.approvedByName,
            approvedAt: row.approvedAt.toISOString(),
          },
        ]
      : [],
  );
}

/** Что коррекция назначения задевает в прошлом — и, значит, за что она отвечает правом. */
interface AssignmentCorrectionPlan {
  /**
   * Эффективная дата операции (§4 плана). Самая **ранняя** из задетых: глубину решает она, как у
   * переноса между рейсами её решает более ранний из двух рейсов.
   */
  effectiveDate: string;
  /** Названные листы отработанных недель: их переоформит сверка. */
  unlocked: Esm2SheetRef[];
  /** Прошедшие недели, у которых листа нет вовсе: их операция выпишет (дыра 3). */
  pastWeeks: Esm2Period[];
  /** Подписи объекта, которые операция снимет. */
  approvals: ShiftApproval[];
}

export const ASSIGNMENT_CORRECTION_EMPTY_MESSAGE =
  'Коррекция ничего не правит задним числом: ни одного листа ЭСМ-2 к перевыписке не названо, прошедших недель без листа у заявки нет, снимать нечего. Обычная смена техники идёт без блока коррекции';

/**
 * Собрать коррекцию назначения до первой правки (Р36) и объяснить отказ, если собрать её нельзя.
 *
 * Отвечает на три вопроса, и все три — до того, как сгорел первый номер:
 *
 * 1. **что названо** — принадлежат ли перечисленные листы этой заявке и действуют ли они. Список
 *    от клиента это перечень намерения, а не разрешение (Р11): чужой или уже аннулированный номер
 *    в нём — ошибка, а не молчаливо пропущенная строка;
 * 2. **что из этого выйдет** — недельный замок сверки считается по понедельнику, и лист, названный
 *    в неделе, где живёт второй действующий бланк, был бы аннулирован **без перевыписки**: неделю
 *    запер бы неназванный сосед (`esm2SyncPlan`, `locked`). Об этом ниже отдельно;
 * 3. **какая у операции глубина** — эффективная дата, по которой `backdateGuard` спросит право,
 *    предел дней и причину.
 */
async function planAssignmentCorrection(
  before: VehicleRequestDto,
  correction: CorrectAssignmentInput,
  /** Машина, которую назначает эта же операция: режим ЭСМ-2 считается по будущему состоянию. */
  nextVehicleId: string,
  today: string,
): Promise<AssignmentCorrectionPlan> {
  // Принадлежность будущей машины — одним чтением: смена арендной единицы на собственную заводит
  // бумагу там, где её не было вовсе, и глубина этих недель обязана быть спрошена (см.
  // `esm2CorrectionScope`). Машины нет — пусть об этом скажет `resolveAssignment` своим отказом;
  // здесь берётся «своя» как состояние, при котором проверок больше, а не меньше.
  const [next] = await db
    .select({ ownership: vehicles.ownership })
    .from(vehicles)
    .where(eq(vehicles.id, nextVehicleId));
  const scope = await esm2CorrectionScope(db, {
    requestId: before.id,
    ownership: next?.ownership ?? 'own',
    today,
  });

  const byId = new Map(scope.sheets.map((s) => [s.id, s]));
  const unknown = correction.unlockWaybillIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw err.unprocessable(
      unknown.length === 1
        ? 'Названный лист не найден среди действующих ЭСМ-2 этой заявки — обновите карточку: его успели аннулировать либо он принадлежит другой заявке'
        : `Названные листы (${unknown.length}) не найдены среди действующих ЭСМ-2 этой заявки — обновите карточку: их успели аннулировать либо они принадлежат другой заявке`,
      { unlockWaybillIds: 'Лист не найден' },
    );
  }
  const unlocked = correction.unlockWaybillIds.map((id) => byId.get(id)!);

  /*
   * Неделя переоформляется целиком или не переоформляется вовсе.
   *
   * Замок сверки считается по понедельнику (`esm2SyncPlan`), а лист после линейной техники
   * уникален по паре «неделя + машина» (ADR 0100 п. 7). Поэтому в неделе, где стоят листы двух
   * единиц, любой исход плох: назвав один, получишь аннулирование без перевыписки — неделю запрёт
   * второй; назвав оба, получишь один новый лист вместо двух — набор недель их не различает, и
   * недельный отчёт второй машины (свои моточасы, свой оборот с подписью заказчика) пропал бы.
   *
   * Поэтому отказ, а не молчаливое расширение списка. Дверь для такой недели своя и она есть:
   * лист списывают номером и выписывают заново по требованию (ADR 0100 §6), где машина называется
   * явно, — там неделя двух единиц выражается, а здесь нет.
   */
  for (const sheet of unlocked) {
    const week = weekStartKey(sheet.periodFrom);
    const neighbours = scope.sheets.filter(
      (s) => s.id !== sheet.id && weekStartKey(s.periodFrom) === week,
    );
    if (neighbours.length > 0) {
      throw err.unprocessable(
        `В неделе листа № ${sheet.number} (${dateKeyRu(sheet.periodFrom)} — ${dateKeyRu(sheet.periodTo)}) у заявки есть ещё ${neighbours.length === 1 ? 'один действующий лист' : 'действующие листы'} — № ${neighbours
          .map((s) => s.number)
          .join(
            ', № ',
          )}: на неделю выписался бы один бланк, и недельный отчёт второй машины пропал бы. Такую неделю переоформляют по одному листу — аннулированием номера и выпиской ЭСМ-2 по требованию, где машина называется явно`,
        { unlockWaybillIds: 'В неделе несколько листов' },
      );
    }
  }

  /*
   * Подписи смен снимает не всякая коррекция назначения, и линейный заказ — тот случай, где не
   * снимает (ADR 0100 §4, backlog «Машина в таблице смен»). Там машина дня — машина **рейса**
   * дня, а назначение остаётся машиной по умолчанию: подпись объекта под часами относится к
   * единице, которая в этот день вышла, и правка умолчания её не опровергает. У обычного заказа
   * наоборот — машина одна на весь срок, и подпись стоит ровно под её работой.
   */
  const approvals = isLinearRequest(before)
    ? []
    : await approvedShiftsOfRequest(before.id, before.displayNumber);

  /*
   * Эффективная дата — по таблице §4 плана: у листа ЭСМ-2 (и существующего, и новой прошедшей
   * недели) это `periodTo`, тем же концом недели, каким её считает `canCancelWaybill`. Снятая
   * подпись стоит в этом ряду наравне: день, за который объект расписался, — такой же прошедший
   * день, и операция утверждает о нём, что работала другая машина.
   *
   * Пусто — операции нечего утверждать о прошлом: ни листа к перевыписке, ни недели без бумаги, ни
   * подписи. Такой запрос отклоняется, а не проходит молча (Р31, «пустая коррекция»): иначе блок
   * `correction` стал бы способом обойти замок подтверждённых дней, ничего не корректируя.
   */
  const touched = [
    ...unlocked.map((s) => s.periodTo),
    ...scope.pastWeeks.map((w) => w.to),
    ...approvals.map((a) => a.date),
  ];
  if (touched.length === 0) throw err.unprocessable(ASSIGNMENT_CORRECTION_EMPTY_MESSAGE);

  return {
    effectiveDate: touched.reduce((a, b) => (a < b ? a : b)),
    unlocked,
    pastWeeks: scope.pastWeeks,
    approvals,
  };
}

/**
 * Адрес **первой живой** ездки заявки (§9): у заявки с ездками A→B и A→C единственного адреса
 * разгрузки не существует (Р2), а список обязан упорядочиваться однозначно — первая ездка это и
 * есть то, что показано в строке.
 *
 * Скалярным подзапросом, а не join'ом с ездками: сортировочные столбцы общие у четырёх выборок
 * (список, журнал, архив, срез «На объекте»), и join пришлось бы добавлять в каждую — и не забыть
 * в следующей. Добавлять его в саму выборку нельзя и по существу: у заявки ездок несколько, и join
 * размножил бы строку списка по их числу, а счётчик «всего» разошёлся бы с числом строк под ним.
 *
 * Запросом на строку это не становится: SQL остаётся один, а ключ сортировки Postgres считает
 * индексным поиском по `(request_id, num)` — тем самым уникальным ограничением, которым номер
 * ездки в заявке и единственен.
 *
 * Мягко удалённую ездку (Р13а) в сортировку пускать нельзя: она никуда не едет, и её адрес в
 * списке означал бы рейс, которого нет.
 */
function firstTripColumn(column: 'from_location' | 'to_location'): SQL {
  return sql`(
    SELECT t.${sql.raw(column)}
    FROM ${vehicleRequestTrips} t
    WHERE t.request_id = ${vehicleRequests.id} AND t.deleted_at IS NULL
    ORDER BY t.num
    LIMIT 1
  )`;
}

/**
 * Столбцы сортировки списка и журнала. «Срок» у типов заявки лежит в разных detail-таблицах,
 * поэтому сводится coalesce: у строки заполнена ровно одна из колонок.
 *
 * Адреса и количество считаются по ездкам — колонок с ними у заявки больше нет (Р2). Ключи
 * столбцов при этом прежние, и это договор с порталом: для читателя списка ничего не изменилось,
 * изменился источник.
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
  // Количество — **сумма** живых ездок тем же правилом, каким подписывается груз: объём, а если
  // его нет ни у одной — масса (`requestCargoTotal`, `tripCargoLabel`). Ездок у заявки нет вовсе
  // (заказ техники на объект) — сумма пуста, и строка уходит в конец, как уходила с пустой
  // колонкой.
  amount: sql`(
    SELECT coalesce(sum(t.volume_m3), sum(t.weight_tons))
    FROM ${vehicleRequestTrips} t
    WHERE t.request_id = ${vehicleRequests.id} AND t.deleted_at IS NULL
  )`,
  loadingLocation: firstTripColumn('from_location'),
  unloadingLocation: firstTripColumn('to_location'),
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
    // Машина (ADR 0027, ADR 0098, ADR 0100 §12): тот же общий отбор, что и в списке, — журнал
    // спрашивают ровно про неё («чем закрывали заказы этой машины» и «где она ходила»).
    requestVehicleWhere(q.vehicleId),
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
 * Счётчик строк списка: те же join'ы, что нужны его условиям (объект — поиску, detail-таблицы —
 * датам, назначение — фильтру по машине). Отдельной функцией, потому что спрашивают его двое —
 * сам список и лента раздела: цифра «всего» обязана считаться по тем же условиям, по которым
 * выбирается страница, и разъедься эти два запроса, пагинация обещала бы страницы, которых нет.
 */
function listCountQuery() {
  return (
    db
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
      // Назначение (ADR 0027) — под фильтр по машине: `request_id` там первичный ключ, поэтому
      // строк join не размножает, и цифра «всего» остаётся числом заявок, как у рейсов в выборке.
      .leftJoin(
        vehicleRequestAssignments,
        eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
      )
  );
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
 *
 * Линейные заказы (ADR 0100) отсюда не исключаются, и это разница с гаражом, а не расхождение с
 * ним: гараж отвечает про **машину** («занята ли она весь срок» — нет, не занята), а срез про
 * **площадку** («ждёт ли она сегодня технику» — ждёт, заказ идёт). Меняется у такой строки не
 * наличие, а машина: она берётся из рейса дня, а не из назначения (`dayVehiclesByRequestIds`).
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

// ── Лента раздела: заказы ТС и недельные заявки одним списком ──

/**
 * Недельная часть диапазона дат: пересечение недели `week_start … week_start + 6` с заданным
 * отрезком — тем же правилом, каким пересекается срок спецтехники (`specialDateConds`).
 *
 * Недельный документ не «происходит в день», он занимает неделю целиком, и вопрос «что было в
 * августе» обязан отвечать про заявку, чья неделя началась в июле и кончилась в августе. Границы
 * считаются по `week_start`, а не по хранимому концу: конца недели в таблице нет вовсе — он
 * выводится из начала (`weeklyWeekBounds`), и второе его определение в SQL разошлось бы с первым.
 */
function weeklyDateConds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): (SQL | undefined)[] {
  const conds: (SQL | undefined)[] = [];
  if (dateTo) conds.push(sql`${weeklyVehicleRequests.weekStart} <= ${dateTo}::date`);
  if (dateFrom) conds.push(sql`${weeklyVehicleRequests.weekStart} + 6 >= ${dateFrom}::date`);
  return conds;
}

/**
 * Условие недельной части ленты — те фильтры списка заказов, которым у недельного документа есть
 * соответствие (объект, поиск по шапке, виза, диапазон дат) плюс два своих: вид документа и
 * неделя. Фильтры без соответствия сюда не попадают вовсе — они убирают недельные строки из
 * выдачи целиком (`weeklyRowsExcludedBy`), и «применить их как-нибудь» означало бы отвечать
 * документами, у которых спрошенного признака не бывает.
 *
 * Видимость — `weeklyRequestReadWhereOnTable`, тот же перевод области, которым проверяется доступ
 * к карточке недели. Своего условия здесь нет намеренно: два похожих разошлись бы молча, и
 * разошлись бы в сторону «в ленте видно, а по ссылке 404».
 *
 * Поиск по тексту ищет по шапке — комментарию и площадке. Состав он не ищет: ответ «ТС-341 стоит в
 * НЗ-15» сам по себе есть выдача состава, а её арендодателю сужают строками (ADR 0085), и второе
 * место с тем же условием видимости разошлось бы с первым.
 */
function weeklyFeedWhere(p: Principal, q: VehicleFeedQuery): SQL | undefined {
  return and(
    weeklyRequestReadWhereOnTable(p),
    q.objectId ? eq(weeklyVehicleRequests.objectId, q.objectId) : undefined,
    q.weekStart ? eq(weeklyVehicleRequests.weekStart, q.weekStart) : undefined,
    // Номер спрашивают парой «вид документа + номер» (`parseFeedNumberSearch`): «НЗ-12» и «ТС-12» —
    // две независимые последовательности, и одного числа мало, чтобы понять, что ищут.
    q.kind === 'weekly' && q.num !== undefined ? eq(weeklyVehicleRequests.num, q.num) : undefined,
    q.approved === undefined
      ? undefined
      : q.approved
        ? isNotNull(weeklyVehicleRequests.approvedAt)
        : isNull(weeklyVehicleRequests.approvedAt),
    ...weeklyDateConds(q.dateFrom, q.dateTo),
    searchCondition(q.search, [
      weeklyVehicleRequests.comment,
      constructionObjects.name,
      constructionObjects.code,
    ]),
  );
}

/**
 * Ключ сортировки ленты — своим выражением на каждой стороне: у заказа и у недели одно и то же
 * поле хранится по-разному (срок заказа лежит в двух detail-таблицах, срок недели — в `week_start`),
 * а объединение сортируется одним столбцом.
 *
 * `null` на недельной стороне — не пробел в данных, а честный ответ: позиции классификатора,
 * статуса заказа и комментария заявки ТС у недельного документа не бывает вовсе. Такие строки
 * уходят в конец (`NULLS LAST`), а не притворяются пустыми значениями в середине списка.
 *
 * Незнакомый ключ (столбцы журнала и архива — их лента не показывает) откатывается к дате
 * создания тем же правилом, что и `orderByFrom`: сортировать по столбцу, которого в выдаче нет,
 * нечем.
 */
function feedSortExprs(sortBy: string | undefined): { order: SQL; weekly: SQL } {
  const none = sql`null`;
  const byField: Record<string, { order: SQL; weekly: SQL }> = {
    createdAt: {
      order: sql`${vehicleRequests.createdAt}`,
      weekly: sql`${weeklyVehicleRequests.createdAt}`,
    },
    objectName: {
      order: sql`${constructionObjects.name}`,
      weekly: sql`${constructionObjects.name}`,
    },
    term: {
      order: sql`coalesce(${freightTransportRequestDetails.scheduledAt}, ${specialEquipmentRequestDetails.dateFrom}::timestamptz)`,
      weekly: sql`${weeklyVehicleRequests.weekStart}::timestamptz`,
    },
    approval: {
      order: sql`${vehicleRequests.approvedAt}`,
      weekly: sql`${weeklyVehicleRequests.approvedAt}`,
    },
    // Столбцы, которых у недельного документа нет: заказанная позиция классификатора, статус
    // заявки ТС и её комментарий. Сортировка по ним осмысленна для заказов и оставлена им.
    vehicleTypeName: {
      order: sql`coalesce(${requestCategories.name}, ${vehicleTypes.name})`,
      weekly: none,
    },
    status: { order: sql`${vehicleRequests.status}`, weekly: none },
    comment: { order: sql`${vehicleRequests.comment}`, weekly: none },
  };
  return byField[sortBy ?? ''] ?? byField.createdAt!;
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

  /**
   * Условие списка заказов — одной функцией, потому что спрашивают его двое: сам список и лента
   * раздела, где заказы идут вперемешку с недельными заявками. Разойдись эти два места, фильтр в
   * ленте отвечал бы не то же самое, что тот же фильтр во вкладке, — а человек считает их одним
   * списком, потому что это и есть один список.
   */
  const listWhere = (p: Principal, q: VehicleRequestListQuery) =>
    and(
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
      // Машина (ADR 0027, ADR 0098) — единица парка, а не позиция классификатора выше: «где ходил
      // ТС-341» спрашивают госномером. С ADR 0100 §12 ответ считает не только назначение, но и дни
      // линейного заказа, отработанные этой машиной, — одним общим выражением на все пять выдач.
      requestVehicleWhere(q.vehicleId),
      q.num ? eq(vehicleRequests.num, q.num) : undefined,
      approvedFilter(q.approved),
      ...dateFilters(q.requestType, q.dateFrom, q.dateTo),
      searchCondition(q.search, [
        vehicleRequests.comment,
        constructionObjects.name,
        constructionObjects.code,
      ]),
    );

  // ── Список (единый по обоим типам; requestType — необязательное сужение) ──
  r.get('/', { ...auth, schema: { querystring: vehicleRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    const where = listWhere(p, q);
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
    const [totalRow] = await listCountQuery().where(where);
    return {
      // Машина отбора едет в сборку DTO: по ней строка объясняет, что совпала днями, а не
      // назначением (ADR 0100 §12).
      items: await toDtos(rows, { vehicleId: q.vehicleId }),
      total: Number(totalRow!.c),
      page: pg.page,
      pageSize: pg.pageSize,
    };
  });

  /**
   * Лента раздела «Заказ автотехники»: заказы ТС и недельные заявки одним списком (ADR 0085).
   *
   * Отдельным маршрутом, а не флагом у `GET /`: тем списком пользуются вкладка «Архив» и форма
   * подбора заявок в рейс, и подмешивать туда документ, который в рейс не ставится, значило бы
   * предлагать диспетчеру строку, которую нельзя выбрать.
   *
   * Страница выбирается объединением **ключей** двух выборок, а не двумя списками, склеенными
   * после: только так пагинация честная. Склей их клиент — пятидесятая строка ленты зависела бы от
   * того, чего в выдаче больше, а вторая страница повторяла бы часть первой. Готовые карточки
   * догружаются по идентификаторам уже выбранной страницы, каждая своим сборщиком: у заказа это
   * `toDtos`, у недели — `loadWeeklyDtosByIds`, и третьего, «общего», DTO не заводится.
   */
  r.get(
    '/feed',
    { ...auth, schema: { querystring: vehicleFeedQuerySchema } },
    async (req): Promise<VehicleFeedListDto> => {
      const p = requirePrincipal(req);
      const q = req.query;
      const pg = pageParams(q);

      /**
       * Кого лента показывает. Заказы уходят из неё, когда спрошены только недельные строки;
       * недельные — когда задан фильтр без соответствия у документа либо у учётки нет права их
       * читать. Право спрашивается здесь, а не областью выборки: у арендодателя и наблюдателя
       * `vehicleRequests.read` есть, и без этой проверки лента открывала бы им недельные заявки
       * тем же запросом, которым они смотрят свои заказы.
       */
      const withOrders = !onlyWeeklyRows(q);
      const withWeekly = can(p, 'weeklyRequests.read') && !weeklyRowsExcludedBy(q);

      const orderWhere = listWhere(p, q);
      const weeklyWhere = weeklyFeedWhere(p, q);
      const sortExpr = feedSortExprs(q.sortBy);

      // Ключи обеих выборок одной формы — иначе их не объединить: вид документа (он же
      // дискриминатор строки), идентификатор, номер и то единственное выражение, которым лента
      // сортируется. Псевдонимы заданы явно: `ORDER BY` над объединением умеет ссылаться только на
      // имена столбцов выдачи, а не на выражения.
      const orderKeys = db
        .select({
          kind: sql<FeedKind>`'order'::text`.as('feed_kind'),
          id: sql<string>`${vehicleRequests.id}`.as('feed_id'),
          num: sql<number>`${vehicleRequests.num}`.as('feed_num'),
          sort: sql`${sortExpr.order}`.as('feed_sort'),
        })
        .from(vehicleRequests)
        // Те же join'ы, что нужны условиям списка и его сортировке: объект — поиску и порядку по
        // площадке, detail-таблицы — датам и сроку, классификатор — порядку по типу ТС.
        .leftJoin(constructionObjects, eq(vehicleRequests.objectId, constructionObjects.id))
        .leftJoin(departments, eq(vehicleRequests.departmentId, departments.id))
        .innerJoin(vehicleTypes, eq(vehicleRequests.vehicleTypeId, vehicleTypes.id))
        .leftJoin(requestCategories, eq(vehicleRequests.vehicleCategoryId, requestCategories.id))
        .leftJoin(
          specialEquipmentRequestDetails,
          eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
        )
        .leftJoin(
          freightTransportRequestDetails,
          eq(vehicleRequests.id, freightTransportRequestDetails.requestId),
        )
        // Назначение (ADR 0027) — под фильтр списка по машине: `request_id` там первичный ключ,
        // и лишних ключей объединение от него не получит.
        .leftJoin(
          vehicleRequestAssignments,
          eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
        )
        .where(orderWhere);
      const weeklyKeys = db
        .select({
          kind: sql<FeedKind>`'weekly'::text`.as('feed_kind'),
          id: sql<string>`${weeklyVehicleRequests.id}`.as('feed_id'),
          num: sql<number>`${weeklyVehicleRequests.num}`.as('feed_num'),
          sort: sql`${sortExpr.weekly}`.as('feed_sort'),
        })
        .from(weeklyVehicleRequests)
        .innerJoin(constructionObjects, eq(weeklyVehicleRequests.objectId, constructionObjects.id))
        .where(weeklyWhere);

      /**
       * Порядок ленты. По номеру она сортирует парой «вид, номер»: «НЗ-12» и «ТС-12» не лежат на
       * одной числовой оси, и смешать их значило бы выдать недельную заявку за заказ с тем же
       * числом. По остальным ключам — общим столбцом, и всегда `NULLS LAST`: сторона, у которой
       * такого столбца нет, уходит в конец, а не встаёт в середину списка.
       *
       * Замыкает порядок пара «вид, номер, идентификатор» — устойчивый разделитель совпадений. Без
       * него две строки с одинаковой датой создания вставали бы в произвольном порядке на каждом
       * запросе, и листание теряло бы одни строки и повторяло другие.
       */
      const dir = sql.raw(q.sortOrder === 'asc' ? 'asc' : 'desc');
      const orderBy =
        q.sortBy === 'num'
          ? [sql`${sql.identifier('feed_kind')} asc`, sql`${sql.identifier('feed_num')} ${dir}`]
          : [
              sql`${sql.identifier('feed_sort')} ${dir} nulls last`,
              sql`${sql.identifier('feed_kind')} asc`,
              sql`${sql.identifier('feed_num')} asc`,
            ];
      const tail = [...orderBy, sql`${sql.identifier('feed_id')} asc`];

      const keys =
        withOrders && withWeekly
          ? await unionAll(orderKeys, weeklyKeys)
              .orderBy(...tail)
              .limit(pg.limit)
              .offset(pg.offset)
          : withOrders
            ? await orderKeys
                .orderBy(...tail)
                .limit(pg.limit)
                .offset(pg.offset)
            : withWeekly
              ? await weeklyKeys
                  .orderBy(...tail)
                  .limit(pg.limit)
                  .offset(pg.offset)
              : [];

      // Карточки — по идентификаторам выбранной страницы, каждая своим сборщиком. Множества не
      // пересекаются, поэтому и `total` считается суммой двух счётчиков: объединять выборки ради
      // счёта незачем, а два запроса дешевле одного с `UNION`.
      const orderIds = keys.filter((k) => k.kind === 'order').map((k) => k.id);
      const weeklyIds = keys.filter((k) => k.kind === 'weekly').map((k) => k.id);
      const [orderDtos, weeklyDtos, orderTotal, weeklyTotal, pendingCount] = await Promise.all([
        orderIds.length > 0
          ? baseQuery()
              .where(inArray(vehicleRequests.id, orderIds))
              // Тем же вопросом, что и вкладка: строка ленты обязана объяснять совпадение по дню
              // так же, как строка списка, — это один список (ADR 0100 §12).
              .then((rows) => toDtos(rows, { vehicleId: q.vehicleId }))
          : Promise.resolve([]),
        loadWeeklyDtosByIds(weeklyIds, p),
        withOrders
          ? listCountQuery()
              .where(orderWhere)
              .then((rows) => Number(rows[0]!.c))
          : Promise.resolve(0),
        withWeekly
          ? db
              .select({ c: count() })
              .from(weeklyVehicleRequests)
              .innerJoin(
                constructionObjects,
                eq(weeklyVehicleRequests.objectId, constructionObjects.id),
              )
              .where(weeklyWhere)
              .then((rows) => Number(rows[0]!.c))
          : Promise.resolve(0),
        // Цифра «ждут визы» — та, ради которой открывали отдельную вкладку. Считается по области
        // учётки, а не по фильтрам ленты: она о работе, а не о выдаче. Область объектная
        // (`weeklyRequestObjectScopeWhere`) — «сколько недель ждёт подписи» есть счёт площадки, и
        // арендодателю он не отвечает ни на что: визу он не ставит.
        can(p, 'weeklyRequests.read')
          ? db
              .select({ c: count() })
              .from(weeklyVehicleRequests)
              .where(
                and(weeklyRequestObjectScopeWhere(p), eq(weeklyVehicleRequests.status, 'pending')),
              )
              .then((rows) => Number(rows[0]!.c))
          : Promise.resolve(0),
      ]);

      const orderById = new Map(orderDtos.map((dto) => [dto.id, dto]));
      // Раскладка строго в порядке ключей: он и есть порядок ленты. Строка, карточка которой не
      // собралась, пропускается — документ снесли между двумя запросами, и показывать вместо него
      // пустую строку хуже, чем не показывать ничего.
      const items = keys.flatMap((key): VehicleFeedRow[] => {
        if (key.kind === 'order') {
          const order = orderById.get(key.id);
          return order ? [{ kind: 'order', order }] : [];
        }
        const weekly = weeklyDtos.get(key.id);
        return weekly ? [{ kind: 'weekly', weekly }] : [];
      });

      return {
        items,
        total: orderTotal + weeklyTotal,
        page: pg.page,
        pageSize: pg.pageSize,
        weeklyPendingCount: pendingCount,
      };
    },
  );

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
        items: await toDtos(rows, { vehicleId: req.query.vehicleId }),
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
      // дню, по которому отбирались строки. Он же выбирает машину строки у линейного заказа
      // (ADR 0100 §12): срез отвечает про сегодняшнюю площадку, а не про назначение вообще.
      const items = await toDtos(rows, { onDate });
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
          // Долг подписей: по скольким заявкам работа ещё не принята объектом. Пока цифра не ноль,
          // эти заявки закрываются только с предупреждением — а часть из них уже отработала срок.
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
        // Машина (ADR 0098, ADR 0100 §12): сводка считается по тому же общему выражению, что и
        // список под ней, — иначе цифры над таблицей отвечали бы не про её строки.
        requestVehicleWhere(req.query.vehicleId),
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
        // Назначение (ADR 0027) — под фильтр по машине: `request_id` там первичный ключ, поэтому
        // строк join не размножает и счётчики статусов не завышает.
        .leftJoin(
          vehicleRequestAssignments,
          eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
        )
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

      /*
       * Заведение задним числом (ADR 0101, Р15). Эффективная дата — по таблице §4 плана: у заказа
       * техники на объект первый день срока, у грузоперевозки день подачи по МСК. Конец срока не
       * спрашивается: он не раньше начала, и глубину решает именно начало.
       *
       * Ритуал «завести сегодняшним днём, чтобы тут же исправить на вчера» не защищал ничего —
       * поэтому вход тот же самый, что у правки, и правило на нём одно.
       */
      const effectiveDate =
        body.requestType === 'special_equipment'
          ? body.dateFrom
          : moscowDateKeyOf(new Date(body.scheduledAt));
      const reason = body.backdateReason?.trim() ?? '';
      // Функцией, а не разово: `runCorrection` зовёт её сам на каждой попытке, включая повтор, —
      // на нём это единственная проверка доступа, которая вообще случится (Р31).
      const authorize = () =>
        backdateOrThrow(
          checkBackdate({
            effectiveDate,
            today: moscowDateKeyOf(new Date()),
            subject: p,
            hasReason: reason !== '',
          }),
        );
      const backdated = authorize();

      /*
       * Заблаговременность (ADR 0104): заявитель заказывает технику не раньше чем на завтра, а
       * после 15:00 МСК — начиная с послезавтра. Спрашивается после заднего числа: прошлое —
       * вопрос права и глубины, и отвечать на него «закажите на послезавтра» было бы неверно.
       * Заведение задним числом (право есть, причина названа) правило пропускает как есть.
       */
      const tooSoon = backdated ? null : vehicleRequestLeadTimeBlocker(p, effectiveDate);
      if (tooSoon) {
        throw err.unprocessable(tooSoon, {
          [body.requestType === 'special_equipment' ? 'dateFrom' : 'scheduledAt']: 'Слишком рано',
        });
      }

      // Сама запись заявки — одна на обе ветки: обычное заведение открывает транзакцию само,
      // заведение задним числом отдаёт эту же работу транзакции операции (Р16), где рядом с
      // заявкой ложатся причина, автор и связь `vehicle_request_corrections`.
      const insertRequest = async (tx: Tx): Promise<string> => {
        // Заказ спецтехники заводится общим сервисом: тем же кодом его порождает применение
        // недельной заявки (ADR 0085), и проверки площадки с классификатором обязаны быть одни.
        let id: string;
        if (body.requestType === 'special_equipment') {
          id = await createSpecialEquipmentRequest(tx, {
            objectId: body.objectId,
            vehicleTypeId: body.vehicleTypeId,
            vehicleCategoryId: body.vehicleCategoryId ?? null,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo ?? null,
            responsibleName: body.responsibleName,
            responsiblePhone: body.responsiblePhone,
            comment: body.comment,
            createdBy: p.id,
            approvedBy: selfApproved ? p.id : null,
            approvedAt: selfApproved ? approvedAt : null,
          });
        } else {
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
            // Номер нужен здесь же: им ездка называется в отказах («ездка ТС-40/2»), а выдаёт его
            // последовательность — заранее он неизвестен.
            .returning({ id: vehicleRequests.id, num: vehicleRequests.num });
          id = row!.id;
          const scheduledAt = new Date(body.scheduledAt);
          await tx.insert(freightTransportRequestDetails).values({
            requestId: id,
            scheduledAt,
            scheduledTimeUnspecified: body.scheduledTimeUnspecified,
          });
          // Ездки — тем же кодом, каким их правят (Р2а): у заведения сохранённых строк просто
          // нет, и каждая присланная проходит жёсткую модель целиком. Номера назначает запись,
          // начиная с первого.
          await applyRequestTrips(tx, {
            requestId: id,
            requestNum: row!.num,
            vehicleTypeId: body.vehicleTypeId,
            scheduledAt,
            trips: body.trips,
          });
          await tx.insert(vehicleRequestStatusHistory).values({
            vehicleRequestId: id,
            fromStatus: null,
            toStatus: 'new',
            changedBy: p.id,
          });
        }
        await attachFiles(tx, id, body.fileIds, p.id);
        return id;
      };

      let createdId: string;
      /** Повтор той же операции (Р31): заявка уже заведена, второй записи в аудит быть не должно. */
      let repeated = false;
      if (!backdated) {
        createdId = await db.transaction(insertRequest);
      } else {
        // Ключ идемпотентности обязателен ровно здесь: обычное заведение повтора не боится (человек
        // увидит вторую заявку в списке и снесёт её), а заведение задним числом заводит строку в
        // журнале коррекций — и без ключа обрыв связи оставил бы две заявки и две операции.
        if (!body.operationId) {
          throw err.unprocessable(CORRECTION_OPERATION_ID_REQUIRED, {
            operationId: 'Не передан ключ операции',
          });
        }
        let inserted: string | undefined;
        const outcome = await runCorrection(
          {
            operationId: body.operationId,
            kind: 'request_date',
            // Цели у заведения ещё нет — заявка рождается самой операцией. Отпечаток при этом
            // считается по телу целиком, и повтор с другим составом полей под тем же ключом
            // остаётся тем, что он есть: другой командой (409), а не второй заявкой.
            target: 'vehicle-requests',
            body,
            reason,
            actorUserId: p.id,
          },
          {
            authorize,
            perform: async (tx, correction) => {
              inserted = await insertRequest(tx);
              await linkCorrectionRequests(tx, correction.id, [inserted]);
              // Снимок «было → стало»: «было» здесь пусто по построению — заявки до операции не
              // существовало. Остаётся то, ради чего операцию и открывают через месяцы: каким днём
              // заявку завели и каким числом это сделали.
              return {
                request: { id: inserted, requestType: body.requestType, effectiveDate },
              };
            },
          },
        );
        repeated = outcome.repeated;
        // Ответ пересобирается из текущего состояния, а не из снимка в `payload` (Р31): заявку
        // после операции успели поправить, и повтор обязан ответить то же, что ответил бы обычный
        // запрос. Связь операции с заявкой — единственное, чем повтор её вообще находит.
        createdId = inserted ?? (await correctionRequestId(outcome.correction.id));
      }

      if (!repeated) {
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
            // Признак заднего числа — и в аудите: журнал коррекций отвечает «почему», а лента
            // аудита остаётся местом, где события заявки видны подряд и в одном порядке.
            ...(backdated ? { backdated, backdateReason: reason } : {}),
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
        // Правка ведёт поля одного типа; смена типа — переоформление, у него своя ручка (ADR 0091).
        throw err.unprocessable('Тип заявки меняют переоформлением заявки');
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
      let days: LinearDaysSyncResult = { detached: [], frozen: [] };

      /*
       * Задний ход правки (ADR 0101, Р6, Р29).
       *
       * Guard спрашивается не на всякой правке вчерашней заявки, а только там, где правка
       * **что-то утверждает о прошедшем дне**, — то есть двигает календарь. Уточнение телефона или
       * комментария правом на коррекцию не запирается: иначе `waybills.correct` понадобилось бы
       * для обычной дневной работы с любой заявкой старше суток.
       *
       * Какую именно дату двигают и какая из них решает глубину, считает `movedRequestDateKey` —
       * одна функция на портал и сервер: форма по ней спрашивает причину ровно тогда, когда её
       * спросит ручка. `null` оттуда — календарь не тронут, и заднего числа здесь нет вовсе.
       */
      const beforeCalendar = requestCalendarOf(before);
      const afterCalendar = editedRequestCalendar(body);
      const effectiveDate = movedRequestDateKey(beforeCalendar, afterCalendar);
      const reason = body.backdateReason?.trim() ?? '';
      const today = moscowDateKeyOf(new Date());
      const authorize = (): boolean =>
        effectiveDate === null
          ? false
          : backdateOrThrow(
              checkBackdate({ effectiveDate, today, subject: p, hasReason: reason !== '' }),
            );
      const backdated = authorize();

      /*
       * Повтор уже выполненной правки (Р31) — прежде всех прочих проверок: у него нет ни сдвига
       * календаря (он уже состоялся), ни свежей версии заявки (её подняла первая попытка), и любая
       * следующая проверка ответила бы ему отказом на работу, которая на самом деле сделана.
       */
      if (body.operationId && !backdated) {
        const repeat = await repeatedRequestEdit({
          operationId: body.operationId,
          actorUserId: p.id,
          requestId: id,
          body,
        });
        if (repeat) {
          /*
           * Доступ перепроверяется и на повторе (Р31, ADR 0101 п. 9) — здесь руками, а не общим
           * `authorize`: у правки повтор тем и отличается, что сдвига календаря на нём уже нет
           * (`movedRequestDateKey` отвечает `null`, а `backdateGuard` без эффективной даты не
           * спрашивается вовсе), и единственная проверка доступа, какая вообще случилась бы,
           * молча пропала бы. Молча отдать прежний результат тому, у кого `waybills.correct`
           * успели отобрать между попытками, — та же утечка, что выполнить правку без права; тем
           * же порядком и теми же словами отвечает повтор коррекции назначения.
           *
           * Предел глубины при этом остаётся проверенным первой попыткой: второй раз он ничего
           * нового не разрешает, потому что и работы второй раз не происходит.
           */
          if (!can(p, 'waybills.correct')) throw err.forbidden(BACKDATE_PERMISSION_MESSAGE);
          return before;
        }
      }

      /*
       * Заблаговременность (ADR 0104) — та же, что при заведении: правка, переносящая заказ на
       * другой день, назначает его заново, и заявитель не вправе назначить его ближе, чем завёл бы
       * новую заявку. Иначе правило обходилось бы в два шага — завести на послезавтра, тут же
       * перенести на завтра.
       *
       * Спрашивается **день заказа** (`movedRequestStartKey`), а не эффективная дата заднего хода:
       * та берёт в расчёт и конец срока, а сокращение периода технику ближе не придвигает.
       * `null` — день заказа не тронут: уточнение телефона у заявки на завтра сохраняется и в 15:01.
       */
      const movedStart = movedRequestStartKey(beforeCalendar, afterCalendar);
      const tooSoon =
        backdated || movedStart === null ? null : vehicleRequestLeadTimeBlocker(p, movedStart);
      if (tooSoon) {
        throw err.unprocessable(tooSoon, {
          [before.requestType === 'special_equipment' ? 'dateFrom' : 'scheduledAt']: 'Слишком рано',
        });
      }

      /*
       * Что правка срока сделала бы с уже отработанной бумагой (Р8, Р21) — до самой правки, а не
       * после (Р36).
       *
       * Сверка ЭСМ-2 отработанную неделю не трогает намеренно: лист за неё уже побывал на объекте,
       * а прошедшую неделю без листа она не выписывает вовсе, пока не придёт проверенный контекст
       * коррекции (этап 6 плана). Оба правила верны — и оба **молчаливы**: сдвинув начало срока в
       * позапрошлую среду, человек получил бы заявку, у которой на эту неделю нет и не появится
       * никакой бумаги, и узнал бы об этом только из журнала. Поэтому здесь отказ с перечнем
       * недель: он называет цену до нажатия и не делает вида, что бумага сошлась.
       */
      if (backdated && periodEdited) {
        const weeks = await pastEsm2WeeksTouched(before, body, today);
        if (weeks.length > 0) {
          throw err.unprocessable(
            `Правка срока задевает недельные листы ЭСМ-2 за уже прошедшие недели (${weeks
              .map((w) => `${dateKeyRu(w.from)} — ${dateKeyRu(w.to)}`)
              .join(
                '; ',
              )}): бумагу отработанной недели правка срока не переписывает — такой лист переоформляют коррекцией недельного бланка`,
            { dateFrom: 'Задевает отработанную неделю ЭСМ-2' },
          );
        }
      }

      const applyEdit = async (tx: Tx): Promise<void> => {
        /*
         * Рейсы заявки — под блокировкой и первым делом (Р17): порядок «маршруты → заявки» один на
         * модуль, и правка, взявшая заявку раньше рейса, встала бы во встречную блокировку со
         * сборкой дня. Их бывает несколько: у грузоперевозки рейс один, а у линейного заказа
         * столько, сколько дней распланировано (Р7), и правка задевает их все — поэтому берутся по
         * возрастанию `id`, тем же порядком, каким `lockRoutePair` берёт пару переноса.
         *
         * Строка заявки — сразу следом, а не первым `UPDATE` ниже: под ней заперт состав, и без
         * неё заявку успели бы положить ещё в один рейс между этим списком и раскладкой ездок по
         * его точкам.
         */
        const routes = await lockRequestRoutes(tx, id);
        await lockRequestRow(tx, id);
        /** Правка попала в документ (Р18) — из этих полей собрано задание листа. */
        let documentEdited = false;
        /** Ездки переписаны: состав или значения. Считает `applyRequestTrips`. */
        let tripsEdited = false;

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
            // Снимок режима относится к прежнему типу (Р4): носить его на новом заявка не вправе —
            // иначе она пошла бы по режиму справочника, из которого её уже увели.
            ...(typeChanged ? { isLinearFrozen: null, linearFrozenAt: null } : {}),
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
          const responsibleName = nextRequestContact(
            body.responsibleName,
            ex!.responsibleName,
            'responsibleName',
            'Укажите ответственного',
          );
          const responsiblePhone = nextRequestContact(
            body.responsiblePhone,
            ex!.responsiblePhone,
            'responsiblePhone',
            'Укажите контактный телефон',
          );
          // Задание линейного дня печатается контактом заявки и её комментарием (Р9б, Р11): у
          // такого заказа в графе груза стоит характер работ. Значит правка этой пары попадает в
          // документ так же, как у грузоперевозки — правка ездки.
          documentEdited =
            responsibleName !== ex!.responsibleName ||
            responsiblePhone !== ex!.responsiblePhone ||
            (body.comment !== undefined && body.comment !== before.comment);
          await tx
            .update(specialEquipmentRequestDetails)
            .set({ dateFrom, dateTo, responsibleName, responsiblePhone })
            .where(eq(specialEquipmentRequestDetails.requestId, id));
        } else {
          // Тип сторон совпадает — правка чужого типа отклонена до транзакции («Тип заявки меняют
          // переоформлением»), но сузить `before` этой проверкой TS не умеет: сравниваются два
          // разных значения. Тем же приёмом сужается заявка в ручках смен.
          const prev = before as FreightTransportRequestDto;
          const [ex] = await tx
            .select()
            .from(freightTransportRequestDetails)
            .where(eq(freightTransportRequestDetails.requestId, id));
          const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : ex!.scheduledAt;
          /*
           * Дата отдельно от времени (Р18). Календарный день заявки — это день её рейса
           * (`tripDate`), и сдвинуть его правкой, пока заявка стоит в маршруте, значило бы развести
           * заказ с рейсом молча: рейс остался бы на прежнем дне со всем своим заданием. Время
           * внутри дня двигается свободно — им заявка отвечает на «во сколько подать», а не на
           * «каким днём ехать».
           */
          const dayMoved =
            moscowDateKeyOf(scheduledAt) !== moscowDateKeyOf(new Date(prev.scheduledAt));
          if (dayMoved && routes.length > 0) {
            throw err.unprocessable(
              'Заявка стоит в маршруте: выньте её из маршрута или перенесите в маршрут нужного дня',
              { scheduledAt: 'Заявка в маршруте' },
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
            })
            .where(eq(freightTransportRequestDetails.requestId, id));

          /*
           * Ездки — полным списком (§7, Р2а): строка с `id` перезаписывает существующую, строка
           * без него заводит новую, а ездка, которой в списке не оказалось, мягко удаляется (Р13а).
           * Список не прислан вовсе — ездок не трогали, и тогда сверяется только количество: бланк
           * мог смениться вместе с типом ТС, и у прежних ездок оно стало обязательным.
           */
          if (body.trips) {
            tripsEdited = (
              await applyRequestTrips(tx, {
                requestId: id,
                requestNum: before.num,
                vehicleTypeId: nextTypeId,
                scheduledAt,
                trips: body.trips,
              })
            ).changed;
            /*
             * Раскладка сводится с правленым составом ездок (Р18): добавленная ездка
             * раскладывается точками, мягко удалённая (Р13а) снимает свои роли — каскада у
             * `deleted_at` нет и быть не может.
             *
             * Незамороженные рейсы, потому что замороженному правка ездок и так отказывает ниже
             * (`ROUTE_FROZEN_MESSAGE`): менять точки под выданной бумагой нельзя. Рейс здесь один
             * — грузоперевозка едет одним маршрутом целиком (Р7), — но цикл честнее выбора
             * «первого попавшегося»: список даёт `lockRequestRoutes`, и он же держит блокировки.
             */
            if (tripsEdited) {
              for (const route of routes.filter((r) => !r.frozen)) {
                await syncRequestTripPlacement(tx, route.id, id);
                // Ёмкость считается по бланку рейса, а он выводится из назначения и машины
                // (ADR 0065): у типа машины бланк правится справочником уже после сборки.
                await assertRoutePlacement(tx, {
                  routeId: route.id,
                  formCode: (
                    await routeWaybillFormFor(tx, {
                      purpose: route.purpose,
                      vehicleId: route.vehicleId,
                    })
                  ).formCode,
                });
              }
            }
          } else {
            await assertCargoAmount(
              tx,
              nextTypeId,
              before.num,
              prev.trips.map((t) => ({
                num: t.num,
                volumeM3: t.volumeM3,
                weightTons: t.weightTons,
              })),
            );
            // Своё время ездки лежит в дне заявки (Р18) — и когда двигают одну подачу: сохранённые
            // времена обязаны переехать вместе с ней, а не остаться во вчера.
            const [outOfDay] = tripsOutOfRequestDay(scheduledAt.toISOString(), prev.trips);
            if (outOfDay !== undefined) {
              const trip = prev.trips[outOfDay]!;
              throw err.unprocessable(`ездка ${trip.displayNumber}: ${TRIP_DAY_MESSAGE}`, {
                scheduledAt: TRIP_DAY_MESSAGE,
              });
            }
          }
          // В документ попадает и время подачи: рейс печатает задание на день, а водителю время
          // приезжает заданием (ADR 0102). Календарный день сюда не входит — его правка у заявки
          // в маршруте уже отклонена выше.
          documentEdited =
            tripsEdited ||
            scheduledAt.getTime() !== new Date(prev.scheduledAt).getTime() ||
            (body.scheduledAt !== undefined &&
              (body.scheduledTimeUnspecified ?? false) !== prev.scheduledTimeUnspecified);
        }

        if (body.removeFileIds?.length) await detachFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) await attachFiles(tx, id, body.addFileIds, p.id, true);

        // Последствия изменившегося срока — общим сервисом: ожидающий визы запрос на досрочное
        // завершение становится беспредметным (он просил сократить другой период, ADR 0044), а
        // недельные листы ЭСМ-2 переоформляются под новый срок (миграция 0087). Продлённый срок
        // добавляет недели, сдвинутое начало переписывает первую; сокращать срок работающей заявки
        // правкой нельзя вовсе, так что здесь бумага чаще прибавляется, чем сгорает.
        //
        // Снятие запроса здесь молчаливое, и это осознанно: правит один заказ один человек, глядя
        // на него. Недельная заявка тем же сервисом пользуется иначе — там согласие спрашивают
        // построчно.
        if (periodEdited) {
          ({ earlyEndDropped, esm2, days } = await afterWorkPeriodChanged(tx, {
            requestId: id,
            actor: { id: p.id },
            reason: 'Срок работ изменён правкой заявки — путевые листы переоформлены',
            dropPendingEarlyEnd: true,
          }));
          /*
           * Дни линейного заказа, которых рейс не отдал (ADR 0100 п. 11, Р11). У обычной правки
           * это предупреждение: срок продлевают вперёд, замороженный день остаётся в выданном
           * листе, и человек читает о нём событием аудита. У коррекции — отказ: она утверждает,
           * что прошедший день был другим, а бумага на этот день уже у водителя. Молча оставить
           * их значило бы развести заявку с выданным бланком и никому об этом не сказать.
           */
          if (backdated && days.frozen.length > 0) {
            throw err.unprocessable(
              `Дни заказа стоят в рейсах с выписанными листами (${days.frozen
                .map((d) => `${dateKeyRu(d.date)} — ${d.routeNumber}`)
                .join(
                  '; ',
                )}): сначала аннулируйте лист рейса, иначе правка срока разойдётся с выданной бумагой`,
              { dateFrom: 'День в замороженном рейсе' },
            );
          }
        }

        /*
         * Версия рейса поднимается при всякой правке, попадающей в документ (Р18): адреса,
         * контакты, количество, время, состав ездок. Не «на всякой правке» — уточнение
         * комментария грузоперевозки или подмена вложения задания не меняют, а лишняя версия
         * заставила бы диспетчера, держащего маршрут открытым, пересобирать его на ровном месте.
         *
         * Ездки замороженного рейса правку не принимают вовсе (Р15): задание напечатано и у
         * водителя на руках, разойтись с ним заявка не вправе — сначала лист аннулируют.
         */
        if (documentEdited) {
          if (tripsEdited && routes.some((r) => r.frozen)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
          // Замороженный рейс версией не двигают: его бумага уже выпущена, и «пересоберите
          // маршрут» сказать там некому — лист сначала аннулируют.
          for (const route of routes.filter((r) => !r.frozen)) {
            await bumpRouteVersion(tx, route.id, p.id);
          }
        }
      };

      let repeated = false;
      if (!backdated) {
        await db.transaction(applyEdit);
      } else {
        // Ключ идемпотентности обязателен ровно здесь: обычная правка операцией не является, а
        // правка задним числом заводит строку в журнале коррекций и сжигает номера ЭСМ-2. Версия
        // заявки повтор не спасает — она ответит 409 там, где всё уже сохранено.
        if (!body.operationId) {
          throw err.unprocessable(CORRECTION_OPERATION_ID_REQUIRED, {
            operationId: 'Не передан ключ операции',
          });
        }
        const outcome = await runCorrection(
          {
            operationId: body.operationId,
            kind: 'request_date',
            target: id,
            body,
            reason,
            actorUserId: p.id,
          },
          {
            authorize,
            perform: async (tx, correction) => {
              await applyEdit(tx);
              await linkCorrectionRequests(tx, correction.id, [id]);
              // Снимок «было → стало» (Р16): календарь заявки и то, что за ним поехало. Через два
              // месяца по журналу спросят не «какая дата стоит сейчас», а «какой день эта правка
              // объявила рабочим и какая бумага из-за неё сменилась» — восстановить это по
              // текущему состоянию будет уже нечем.
              return {
                request: {
                  id,
                  num: before.num,
                  requestType: before.requestType,
                  effectiveDate,
                  calendar: { before: beforeCalendar, after: afterCalendar },
                },
                esm2,
                linearDays: days,
              };
            },
          },
        );
        repeated = outcome.repeated;
      }

      const after = (await getDto(id))!;
      if (repeated) return after;

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.update',
        entityType: 'vehicle_request',
        entityId: id,
        // Перечень изменённых полей — то, ради чего история отличает правку от «заявку трогали».
        metadata: {
          changes: diffVehicleRequests(before, after),
          // Задний ход — и в ленте аудита: журнал коррекций отвечает «почему», а лента остаётся
          // местом, где события заявки видны подряд и в одном порядке.
          ...(backdated ? { backdated, backdateReason: reason } : {}),
        },
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
      await auditLinearDaysSync({
        actorUserId: p.id,
        requestId: id,
        reason: 'period_edited',
        result: days,
      });
      return after;
    },
  );

  // ── Переоформление в другой тип (ADR 0091) ──
  /**
   * Заявку заводят одним типом, а нужна она другим: самосвал под вывоз грунта заказывают то
   * работой на объекте, то рейсом, и ошибиться при заведении легко. До сих пор это чинилось только
   * отменой заявки и заведением новой — с потерей номера, вложений и истории, по которой заказ и
   * ищут.
   *
   * Отдельная ручка, а не послабление в правке. Правка присылает поля частично и меняет значения;
   * здесь меняется то, **из каких полей заявка состоит**: старая деталь снимается целиком, новая
   * приходит полным составом — тем самым, каким её завели бы этим типом сразу. Одной схемой это не
   * выражается, и `PATCH /:id` на чужой тип по-прежнему отвечает отказом.
   */
  r.patch(
    '/:id/request-type',
    { ...canUpdate, schema: { params: idParams, body: changeVehicleRequestTypeSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      const before = await getDto(id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      // Область — по нынешнему заказчику: переоформляет тот, кому эта заявка и так доступна.
      assertRequestScope(p, before);
      assertObjectRoleEditable(p, before.status, 'переоформить');
      // Тип, в который переоформляют, должен быть доступен роли (ADR 0040): отделу спецтехника
      // закрыта, и обойти это переоформлением своей же грузоперевозки нельзя.
      assertVehicleRequestTypeAllowed(p, body.requestType);

      /*
       * Задний ход переоформления (ADR 0101, Р29) — четвёртая дверь к прошлому, и последняя.
       *
       * Тело переоформления это полный состав целевого типа, то есть дата в нём стоит всегда, а
       * правила «не раньше сегодня» у схемы нет намеренно (см. её докблок): заявку, заведённую
       * вчера, переоформляют сегодня, и требовать сдвинуть срок вперёд ради смены вида было бы
       * правкой заказа вместо правки его формы. Ровно поэтому проверять здесь надо не «дата в
       * прошлом», а «дату двигают в прошлое» — и это тот же вопрос, на который отвечает
       * `movedRequestDateKey` у обычной правки.
       *
       * Календари у типов разной формы (срок работ против дня подачи), и смена вида читается как
       * сдвиг: у нового типа своя дата, и утверждает она о своём дне. Оставшееся неизменным —
       * прежний срок, перенесённый один в один, — сдвигом не считается и права не требует.
       *
       * Строки операции (`waybill_corrections`) эта дверь не заводит — по тому же правилу, что и
       * заведение рейса задним числом (§1 плана): переоформление номеров строгой отчётности не
       * расходует, тип меняют только у «Новой», листа у неё быть не может. Право и причина
       * спрашиваются, объяснение уходит в аудит события.
       */
      const retypeEffectiveDate = movedRequestDateKey(
        requestCalendarOf(before),
        retypedRequestCalendar(body),
      );
      const retypeReason = body.backdateReason?.trim() ?? '';
      const retypeBackdated =
        retypeEffectiveDate !== null &&
        backdateOrThrow(
          checkBackdate({
            effectiveDate: retypeEffectiveDate,
            today: moscowDateKeyOf(new Date()),
            subject: p,
            hasReason: retypeReason !== '',
          }),
        );

      // Заказчик приходит целиком, как при заведении: у заказа на объект это площадка, у
      // грузоперевозки — площадка либо отдел. Переехать он может только внутрь своей области.
      const customer = customerOf(body);
      assertRequestScope(p, customer);

      /**
       * Виза снимается по тому же правилу, что и у существенной правки (ADR 0025): переоформление
       * существенно всегда — согласовывали не то, чем заявка стала. Правка самим визирующим визу
       * не снимает: он подтверждает изменение самим фактом правки.
       *
       * `isApprovalChangeable` здесь не спрашивается отдельно: тип меняют только у «Новой», а это
       * ровно то состояние, в котором визу можно поставить обратно.
       */
      const dropApproval = !!before.approvedAt && !canApproveRequest(p, customer);

      await db.transaction(async (tx) => {
        // Вид заказанной техники — по типу, который стоит в заявке **сейчас**: им решается, годится
        // ли эта позиция обоим типам заявки. Новую позицию (её могли сменить тем же окном) проверит
        // `resolveClassification` уже под новый тип.
        const [ordered] = await tx
          .select({ kindCode: vehicleKinds.code })
          .from(vehicleTypes)
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .where(eq(vehicleTypes.id, before.vehicleTypeId));
        const blocker = requestTypeChangeBlocker(
          before,
          ordered?.kindCode ?? null,
          body.requestType,
        );
        if (blocker) throw err.unprocessable(blocker, { requestType: 'Тип менять нельзя' });

        const customerChanged =
          customer.objectId !== before.objectId || customer.departmentId !== before.departmentId;
        if (customerChanged) await assertCustomerActive(tx, customer);
        // Позиция классификатора проверяется всегда, даже нетронутая: годность решает тип заявки,
        // а он как раз и сменился.
        await resolveClassification(
          tx,
          body.vehicleTypeId,
          body.vehicleCategoryId ?? null,
          body.requestType,
        );

        const [updated] = await tx
          .update(vehicleRequests)
          .set({
            requestType: body.requestType,
            objectId: customer.objectId,
            departmentId: customer.departmentId,
            vehicleTypeId: body.vehicleTypeId,
            vehicleCategoryId: body.vehicleCategoryId ?? null,
            comment: body.comment,
            ...(dropApproval ? { approvedBy: null, approvedAt: null } : {}),
            updatedBy: p.id,
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(vehicleRequests.id, id), eq(vehicleRequests.version, body.version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();

        if (body.requestType === 'special_equipment') {
          await tx
            .delete(freightTransportRequestDetails)
            .where(eq(freightTransportRequestDetails.requestId, id));
          // Ездки уходят вместе с видом заявки: у заказа техники на объект их не бывает вовсе
          // (Р7). Мягко (Р13а), а не удалением: на ездку может ссылаться выданный лист, а
          // `waybill_trips` объявлен `RESTRICT` — и правильно, журнал бланков строгой отчётности
          // обязан помнить, что печаталось. Обратное переоформление заведёт новые, со своими
          // номерами: прежние остались в бумаге, и переиспользовать их номера нельзя.
          await applyRequestTrips(tx, {
            requestId: id,
            requestNum: before.num,
            vehicleTypeId: body.vehicleTypeId,
            // Ездок в списке нет, и сравнивать их календарные дни не с чем: момент подачи у
            // заявки этим переоформлением как раз и исчезает.
            scheduledAt: new Date(),
            trips: [],
          });
          await tx.insert(specialEquipmentRequestDetails).values({
            requestId: id,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo ?? null,
            responsibleName: body.responsibleName,
            responsiblePhone: body.responsiblePhone,
          });
        } else {
          await tx
            .delete(specialEquipmentRequestDetails)
            .where(eq(specialEquipmentRequestDetails.requestId, id));
          // Следы срока работ уходят вместе с ним: у грузоперевозки не период, а момент подачи, и
          // ни решения об отъезде (ADR 0044), ни дней работы (миграция 0086) у неё не бывает. У
          // «Новой» заявки этих строк почти никогда нет — но откат из работы (ADR 0058) снимает
          // машину, а решённый запрос на досрочный отъезд оставляет, и брошенный он вернулся бы
          // в карточку при обратном переоформлении.
          await tx
            .delete(vehicleRequestEarlyEndings)
            .where(eq(vehicleRequestEarlyEndings.requestId, id));
          await dropRequestShifts(tx, id);
          const scheduledAt = new Date(body.scheduledAt);
          await tx.insert(freightTransportRequestDetails).values({
            requestId: id,
            scheduledAt,
            scheduledTimeUnspecified: body.scheduledTimeUnspecified,
          });
          // Ездки приходят полным составом — тем самым, каким их завели бы этим типом сразу
          // (жёсткая модель целиком: тело переоформления это тело заведения). Номера продолжают
          // прежний ряд заявки, если она уже была грузоперевозкой: `num` не переиспользуется даже
          // после переоформления туда и обратно (Р13а).
          await applyRequestTrips(tx, {
            requestId: id,
            requestNum: before.num,
            vehicleTypeId: body.vehicleTypeId,
            scheduledAt,
            trips: body.trips,
          });
        }

        if (body.removeFileIds?.length) await detachFiles(tx, id, body.removeFileIds);
        if (body.addFileIds?.length) await attachFiles(tx, id, body.addFileIds, p.id, true);
      });

      const after = (await getDto(id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_request.change_type',
        entityType: 'vehicle_request',
        entityId: id,
        // Дифф здесь шире, чем у правки: в нём стоят поля обеих деталей — одни ушли в прочерк,
        // другие из прочерка появились. Иначе история сообщала бы, что заявка сменила тип, но
        // молчала бы о том, что стало с заказанным сроком.
        //
        // Задний ход (ADR 0101) помечается здесь же: своей строки в журнале коррекций у этой двери
        // нет — номеров она не жжёт, — и объяснение живёт единственным местом, где его будут
        // искать, рядом с самим переоформлением.
        metadata: {
          changes: diffVehicleRequests(before, after),
          ...(retypeBackdated ? { backdated: true, backdateReason: retypeReason } : {}),
        },
      });
      if (dropApproval) {
        await writeAudit({
          actorUserId: p.id,
          action: 'vehicle_request.approval_revoke',
          entityType: 'vehicle_request',
          entityId: id,
          metadata: { reason: 'retyped' },
        });
      }
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
   *
   * **Прошедшая дата** (ADR 0101 п. 4, дыра 1 плана). Перегон — такой же рейс, как заводимый со
   * стороны маршрутов, и заводился он вчерашним днём молча, пока `POST /vehicle-routes/` уже
   * спрашивал право и причину: дверей к прошлому две, и правило у них обязано быть одно (Р29).
   * Эффективная дата — `routeDate` по таблице §4 плана.
   *
   * Строки операции (`waybill_corrections`) эта дверь не заводит — по тому же правилу, что и
   * заведение обычного рейса (§1 плана, уточнение этапа 7): журнал коррекций объясняет разрыв
   * нумерации **бланков** и ссылается на листы своими колонками, а рейс-перегон — планировочная
   * запись, номера строгой отчётности он не расходует. Операция без единого листа засоряла бы
   * журнал тем, чего в нём не ищут, поэтому право и причина спрашиваются, а объяснение уходит в
   * аудит события `vehicle_route.create`. Причина у бумаги появится своя — её спросит выписка
   * листа по этому рейсу, которая операцию и заведёт.
   */
  r.post(
    '/:id/relocations',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status'),
      ],
      schema: { params: idParams, body: createRequestRelocationSchema },
    },
    async (req, reply): Promise<VehicleRouteDto> => {
      const p = requirePrincipal(req);
      const body = req.body;

      const before = await getDto(req.params.id);
      if (!before) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);

      const reason = body.reason?.trim() ?? '';
      const backdated = backdateOrThrow(
        checkBackdate({
          effectiveDate: body.routeDate,
          today: moscowDateKeyOf(new Date()),
          subject: p,
          hasReason: reason !== '',
        }),
      );

      const created = await db.transaction(async (tx) => {
        // Строка заявки — прежде нового рейса (Р17): её блокировкой закреплён набор рейсов заявки,
        // и без неё перегон родился бы посреди смены статуса — та уже сосчитала, какие рейсы у
        // заявки есть, и убрала бы запланированные, не увидев этого. Рейсов эта дверь не берёт
        // вовсе: она их заводит, а спорить за ещё не рождённую строку некому.
        await lockRequestRow(tx, req.params.id);
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
          request: { ...before, isLinear: isLinearRequest(before) },
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
        // Признак заднего числа и причина — здесь же: своей строки в журнале коррекций у рейса нет
        // (см. заголовок ручки), и объяснение «почему перегон заведён прошедшим днём» живёт в
        // ленте аудита рядом с самим заведением — тем же полем, что у заведения обычного рейса.
        metadata: {
          number: formatVehicleRouteNumber(created.num),
          purpose: body.purpose,
          requestId: req.params.id,
          routeDate: body.routeDate,
          backdated,
          reason,
        },
      });
      reply.code(201);
      return (await loadRouteDto(db, created.id))!;
    },
  );

  /**
   * Водитель или машинист назначенной техники в карточке заявки.
   *
   * Отдельная ручка сохраняет границу персональных данных: основной список заявок читают также
   * объектные роли, которым ФИО и телефон водителя не положены. Источник зависит от вида работы:
   * у грузоперевозки водитель принадлежит маршруту, у заказа спецтехники машинист записан в
   * недельных листах ЭСМ-2. Последний лист остаётся запасным источником и для снятого маршрута —
   * закрытая заявка должна по-прежнему объяснять, кто выполнял работу.
   */
  r.get(
    '/:id/driver',
    {
      preHandler: [app.authenticate, app.requirePermission('waybills.read')],
      schema: { params: idParams },
    },
    async (req): Promise<VehicleRequestDriverDto | null> => {
      const p = requirePrincipal(req);
      const request = await getDto(req.params.id);
      if (!request) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, request);
      if (!request.assignment) return null;

      // У грузоперевозки водитель известен уже после включения заявки в маршрут — ждать выпуска
      // путевого листа для показа контакта нельзя.
      if (request.route) {
        const [routeDriver] = await db
          .select({ personId: persons.id, fullName: persons.fullName, phone: persons.phone })
          .from(vehicleRoutes)
          .innerJoin(persons, eq(persons.id, vehicleRoutes.driverPersonId))
          .where(eq(vehicleRoutes.id, request.route.id))
          .limit(1);
        if (routeDriver) return routeDriver;
      }

      // Для ЭСМ-2 берём действующий лист, а если работа уже закрыта и лист аннулирован — последний
      // исторический. У одной заявки недель несколько, но сверка выписывает их одному машинисту.
      const [waybillDriver] = await db
        .select({ personId: persons.id, fullName: persons.fullName, phone: persons.phone })
        .from(waybillRequests)
        .innerJoin(waybills, eq(waybills.id, waybillRequests.waybillId))
        .innerJoin(persons, eq(persons.id, waybills.driverPersonId))
        .where(eq(waybillRequests.requestId, request.id))
        .orderBy(
          sql`(${waybills.status} = 'cancelled')`,
          desc(waybills.issuedAt),
          desc(waybills.periodFrom),
        )
        .limit(1);
      return waybillDriver ?? null;
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

  /**
   * Выписать недельный лист ЭСМ-2 по требованию (ADR 0100 §6).
   *
   * Единственная ручная выдача у этого бланка — и заведена она ровно для линейной техники, у
   * которой недели стояния на площадке нет: машина вечером возвращается на базу, и лист наперёд
   * утверждал бы работу, которой не было. Всё, что можно решить без человека, решает сервер:
   * границы недели считает `esm2Periods` (пересечение календарной недели дня со сроком заявки),
   * а годность заявки, машины и машиниста — `issueEsm2OnDemand` словами, а не кодом ошибки.
   *
   * Права — те же две, что у выписки листа с рейса (`vehicle-routes.ts`): `waybills.read` и
   * `vehicleRequests.status`. Отдельного права не заводим — это тот же документ и тот же коридор
   * решений; одного `vehicleRequests.status` мало: оно есть у внешнего арендодателя, а в листе
   * персональные данные машиниста собственного парка (ADR 0037 п. 13).
   *
   * Событие аудита своё — `waybill.esm2_issue`: сверка пишет `waybill.esm2_sync`, и смешивать
   * «портал переоформил бумагу» с «человек попросил бланк» нельзя, иначе на вопрос «кто сжёг
   * номер» журнал ответит «система».
   *
   * **Прошедшая неделя** (ADR 0101 п. 4, дыра 3 плана). Дыру закрывала только половина: сверка
   * прошедшую неделю не выписывает без проверенного контекста (`esm2SyncPlan`), а ручная выдача шла
   * мимо неё вовсе — и лист за неделю месячной давности рождался без права, причины и следа. Теперь
   * дату спрашивает тот же `backdateGuard`, что и все прочие входы, эффективная дата берётся по
   * таблице §4 плана (`periodTo` недели, а не её понедельник и не день нажатия кнопки), а сама
   * выписка становится операцией `esm2`: причина уходит в `correction_reason` при пустом
   * `corrects_waybill_id` (Р35), ключ идемпотентности спасает от второго сгоревшего номера.
   *
   * Вид операции здесь `esm2`, а не `issue`, хотя лист рождается точно так же: журнал коррекций
   * читают по предмету, а не по действию, и «что делали с недельным бланком» — вопрос, который
   * задают вместе с коррекцией назначения (Р8), а не вместе с выпиской по рейсу.
   */
  r.post(
    '/:id/esm2',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: { params: idParams, body: issueRequestEsm2Schema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { weekOf, vehicleId, driverPersonId, version } = req.body;
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);
      // Область арендодателя — как у соседних действий по заявке (ADR 0038): свои заявки он
      // ведёт, но выписка бланка нашего парка не его дело, а по прямому id он бы сюда дошёл.
      assertLessorScope(p, before.assignment?.lessorId ?? null);

      /*
       * Задний ход выдачи (Р29, Р35). Неделя считается до транзакции — её `periodTo` и есть
       * эффективная дата, — а `null` оттуда означает «выписывать по этой заявке нечего»: право за
       * прошлое тогда не спрашивается вовсе, и отказ называет настоящую причину словами
       * (`issueEsm2OnDemand`), а не «нет права на прошлое» там, где листа не будет ни при каком
       * праве.
       */
      const period = await esm2OnDemandPeriod(db, { requestId: before.id, weekOf });
      const reason = req.body.reason?.trim() ?? '';
      // Функцией, а не разово: `runCorrection` зовёт её сам на каждой попытке, включая повтор, —
      // на нём это единственная проверка доступа, которая вообще случится (Р31).
      const authorize = (): boolean =>
        period === null
          ? false
          : backdateOrThrow(
              checkBackdate({
                effectiveDate: period.to,
                today: moscowDateKeyOf(new Date()),
                subject: p,
                hasReason: reason !== '',
              }),
            );
      const backdated = authorize();

      /** Сама выдача. Одна на обе ветки: коррекционная отличается ровно меткой листа (Р35). */
      const issueInTransaction = async (
        tx: Tx,
        correction: CorrectionRecord | null,
      ): Promise<IssuedEsm2> => {
        const created = await issueEsm2OnDemand(tx, {
          requestId: before.id,
          weekOf,
          vehicleId,
          driverPersonId,
          actor: { id: p.id },
          // Неделя, по которой спрошено право: разъехавшись со сроком заявки между чтением и
          // транзакцией, она получит конфликт, а не бланк прошедшей недели без операции.
          guardedPeriodTo: period?.to ?? null,
          // Рукопожатие выписки (Р21а): отпечаток, прочитанный человеком в окне. Сервер считает
          // набор сам и под теми же чтениями, из которых печатает бланк, — тело только возвращает
          // подтверждение обратно, и не переданное означает «набор обязан быть пуст».
          acknowledge: req.body.acknowledge ?? null,
          ...(correction ? { correction: { id: correction.id, reason } } : {}),
        });
        // Версия двигается той же транзакцией: у заявки прибавился документ строгой отчётности,
        // и второй человек, приславший ту же неделю с прежней версией, должен получить конфликт,
        // а не сжечь ещё один номер вслед за первым.
        const [updated] = await tx
          .update(vehicleRequests)
          .set({ updatedBy: p.id, version: before.version + 1, updatedAt: new Date() })
          .where(and(eq(vehicleRequests.id, before.id), eq(vehicleRequests.version, version)))
          .returning({ id: vehicleRequests.id });
        if (!updated) throw err.conflict();
        return created;
      };

      /** Что выписано; на повторе операции (Р31) остаётся `null` — выписывать было нечего. */
      let issued: IssuedEsm2 | null = null;
      let correctionId: string | null = null;

      if (!backdated) {
        issued = await db.transaction((tx) => issueInTransaction(tx, null));
      } else {
        // Ключ идемпотентности обязателен ровно здесь: лист текущей недели повтора не боится
        // (второй бланк на ту же машину не пустит частичный UNIQUE), а выписка задним числом
        // заводит строку в журнале коррекций и жжёт номер серии — повтор после обрыва связи обязан
        // вернуть прежний лист, а не следующий номер.
        if (!req.body.operationId) {
          throw err.unprocessable(CORRECTION_OPERATION_ID_REQUIRED, {
            operationId: 'Не передан ключ операции',
          });
        }
        const outcome = await runCorrection(
          {
            operationId: req.body.operationId,
            kind: 'esm2',
            target: before.id,
            body: req.body,
            reason,
            actorUserId: p.id,
          },
          {
            authorize,
            perform: async (tx, correction) => {
              const created = await issueInTransaction(tx, correction);
              issued = created;
              // «Что делали с этой заявкой задним числом» спрашивают со стороны заявки, и связь
              // операции с ней — единственный ответ (Р16).
              await linkCorrectionRequests(tx, correction.id, [before.id]);
              /*
               * Снимок «было → стало» (Р16). «Было» здесь пусто по построению — бланка за эту
               * неделю не существовало, — и остаётся то, ради чего операцию откроют через месяцы:
               * какая неделя закрыта задним числом, какой машиной и каким номером это кончилось.
               */
              return {
                request: { id: before.id, num: before.num },
                waybill: {
                  id: created.id,
                  number: created.number,
                  periodFrom: created.period.from,
                  periodTo: created.period.to,
                },
                vehicleId,
                driverPersonId,
              };
            },
          },
        );
        correctionId = outcome.correction.id;
      }

      // Событие о самом бланке, как и у выписки с рейса (`waybill.issue`): номер строгой
      // отчётности ушёл на документ, и журнал обязан отвечать, кто и на какую неделю его взял.
      //
      // На повторе операции записи нет: второй строки об одной и той же выдаче в ленте быть не
      // должно — номер выдан один раз.
      if (issued) {
        await writeAudit({
          actorUserId: p.id,
          action: 'waybill.esm2_issue',
          entityType: 'waybill',
          entityId: issued.id,
          metadata: {
            number: issued.number,
            requestId: before.id,
            periodFrom: issued.period.from,
            periodTo: issued.period.to,
            vehicleId,
            driverPersonId,
            // Задний ход — и в ленте аудита: журнал коррекций отвечает «почему», а лента остаётся
            // местом, где события заявки видны подряд и в одном порядке.
            ...(backdated ? { backdated, reason, correctionId } : {}),
          },
        });
      }
      return (await getDto(before.id))!;
    },
  );

  /**
   * Что случится с заявкой после перехода — до самого перехода (§5.4).
   *
   * Заведена под один сценарий: откат «Выполнена» → «В работе» у заказа техники на объект.
   * Заморозка режима снята закрытием, и вернувшаяся в работу заявка пойдёт по актуальному
   * справочнику, каким бы он ни стал, — а окно назначения отправляет статус в тот же миг, в
   * который человек называет машину. Момента, чтобы что-то посоветовать, между ними нет вовсе,
   * поэтому совет спрашивают отдельным запросом и тем же телом.
   *
   * Последствия считает **та же сверка**, а не «недели срока минус выписанное»: прошедшая неделя,
   * листа не имевшая, сверкой не выписывается без проверенного контекста коррекции, а статусная
   * ручка зовёт её без него — самодельный расчёт разошёлся бы с реальностью на все прошедшие
   * недели срока.
   *
   * Права двойные. Тело у предпросмотра то же, что у смены статуса, и на этом одинаковость
   * кончается: в ответе номера ЭСМ-2 — документов строгой отчётности. `waybills.read` есть не у
   * всех, у кого есть `vehicleRequests.status` (у внешнего арендодателя его нет, а свой коридор
   * `confirmed → done` открыт), да и «откат без журнала листов» с ADR 0106 стал собираемым
   * набором полномочий.
   */
  r.post(
    '/:id/status/preview',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: { params: idParams, body: previewVehicleRequestStatusSchema },
    },
    async (req): Promise<VehicleRequestStatusPreviewDto> => {
      const p = requirePrincipal(req);
      const body = req.body;
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      // Границы — те же и в том же порядке, что у боевой ручки: чужую заявку и недопустимый
      // переход предпросмотр обязан отвергать ровно так же, иначе он стал бы дорогой в обход.
      assertRequestScope(p, before);
      assertLessorScope(p, before.assignment?.lessorId ?? null);
      assertTransitionAllowed(p, before.status, body.status);
      // И только тот сценарий, ради которого ручка заведена: по прочим переходам советовать
      // нечего, а отвечать номерами бланков тем более.
      if (
        before.requestType !== 'special_equipment' ||
        before.status !== 'done' ||
        body.status !== 'confirmed'
      ) {
        throw err.unprocessable(
          `Последствия портал считает только для возврата заказа техники на объект из «${requestStatusLabels.done}» в «${requestStatusLabels.confirmed}» — по остальным переходам советовать нечего`,
        );
      }
      // Версия спрашивается наравне с боевой ручкой: совет, данный по устаревшей заявке, хуже,
      // чем никакого.
      if (before.version !== body.version) throw err.conflict();

      /*
       * Дата расчёта — одна на весь ответ (Р12): недели отбираются условием `p.to >= today`, и
       * полночь, наступившая между двумя чтениями, обещала бы лишний лист. В отпечаток она уходит
       * не отдельным полем, а внутри самого входа плана.
       */
      const asOf = moscowDateKeyOf(new Date());
      // Одним снимком: план и номера листов, которые он собрался жечь, обязаны рассказывать об
      // одном и том же состоянии бумаги. Записи здесь нет ни одной — это чтение.
      return db.transaction(async (tx) => {
        const planned = await buildEsm2SyncPlan(tx, {
          requestId: before.id,
          driverPersonId: body.assignment?.driverPersonId ?? null,
          asOf,
        });
        // Режим — эффективный признак (Р2), каким заявка пойдёт после возврата: снимка у закрытой
        // заявки нет, и отвечает справочник — тот, который могли переключить, пока она стояла.
        const isLinear = isLinearRequest(before);
        return {
          mode: isLinear ? 'daily' : 'weekly',
          esm2: {
            issue: planned?.plan.issue ?? [],
            cancel: await esm2CancelPreview(tx, planned?.plan.cancel ?? []),
          },
          // Вторая половина последствий: недельный заказ занимает машину на весь срок, линейный —
          // только распланированными днями.
          busy: isLinear ? 'days' : 'term',
          fingerprint: statusPreviewFingerprint(planned?.input ?? null, body),
        };
      });
    },
  );

  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: changeVehicleRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { status, comment, assignment, completion, schedule, version, previewFingerprint } =
        req.body;
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

      /*
       * Дата расчёта — одна на весь переход (Р12). Сверка ЭСМ-2 спрашивала бы «сегодня» сама, и
       * полночь, наступившая между сверкой отпечатка и её вызовом, дала бы другой план при уже
       * принятом обещании: неделя, показанная диалогом как предстоящая, к моменту записи стала бы
       * прошедшей и не выписалась бы вовсе. Тем же днём меряется задний ход доставки и долг
       * подписей — двух «сегодня» в одном запросе быть не должно.
       */
      const today = moscowDateKeyOf(new Date());
      /*
       * Доставка задним числом (ADR 0101, Р29) — та же дверь к прошлому, что и отдельная ручка
       * перегона, только приехавшая сюда полем перевода в работу. Без этой проверки правило
       * обходилось бы одним движением: завести перегон прошедшим днём не отдельным запросом, а
       * вместе со статусом.
       *
       * Спрашивается ровно про дату перегона, а не про сам переход: в работу заявку берут сегодня,
       * и требовать причину за это значило бы объяснять то, чего никто не двигал. Причина поэтому
       * лежит внутри `delivery`, у своей границы.
       *
       * Строки операции здесь нет — по тому же правилу, что у прочих рейсовых дверей (§1 плана,
       * уточнение этапа 7): рейс номеров строгой отчётности не расходует, объяснение уходит в
       * аудит `vehicle_route.create`, а причина у бумаги появится своя — её спросит выписка.
       */
      const deliveryReason = assignment?.delivery?.reason?.trim() ?? '';
      const deliveryBackdated =
        !!assignment?.delivery &&
        backdateOrThrow(
          checkBackdate({
            effectiveDate: assignment.delivery.routeDate,
            today,
            subject: p,
            hasReason: deliveryReason !== '',
          }),
        );
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
      // Работу по дням принимает объект, но закрытию неподписанные дни не мешают: заявку закрывают
      // и тогда, когда подписи ещё не собрали, — это предупреждение, а не запрет
      // (`shiftsCompletionWarning`). След остаётся в истории: сводка смен у закрытой заявки
      // обнуляется, и без пометки у события закрытия неподтверждённая работа выглядела бы принятой.
      const pendingShiftDates =
        transitionRequiresCompletion(status) && shiftsCompletionWarning(before)
          ? await unapprovedPastShiftDates(before.id, before as SpecialEquipmentRequestDto, today)
          : [];
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

      // Откат «Выполнена» → «В работе» у заказа техники на объект — единственный переход, которому
      // портал обещает точный результат сверки (§5.4), и единственный, у которого он спрашивает
      // подтверждение обещанного.
      const rollbackToWork =
        before.requestType === 'special_equipment' &&
        before.status === 'done' &&
        status === 'confirmed';

      // Назначение, факт и уточнённый срок проверяются и пишутся в той же транзакции, что и статус:
      // заявка не должна побыть «в работе» ни на чём, «выполненной» без факта или взятой на одно
      // время с листом на другое — даже мгновение.
      const { assigned, completed, earlyEndDropped, droppedRelocations, detachedDays, esm2, days } =
        await db.transaction(async (tx) => {
          /*
           * Блокировки — первым делом и в этом порядке: тип, рейсы, заявка (Р5, Р11, Р17).
           *
           * Тип берётся `FOR SHARE` раньше заявки намеренно: переключение признака идёт той же
           * дорогой — сначала `FOR UPDATE` на строке типа, потом `UPDATE` его заявок, — и возьми
           * мы заявку первой, две встречные транзакции встали бы во взаимную блокировку. Рейсов
           * переключение не касается вовсе, поэтому между типом и заявкой они и встают.
           *
           * Рейсы — **до** заявки, и это та самая перестановка, ради которой писался Р17: прежде
           * смена статуса брала строку заявки первой, а рейсы добирала уже из `detachOnStatus`,
           * `attachToRoute` и сверки дней, — то есть встречно выписке листа, которая берёт рейс,
           * а потом состав (ADR 0050 п. 12). Две такие транзакции Postgres разрывал как взаимную
           * блокировку; проверено встречными транзакциями до и после правки.
           *
           * Берутся все рейсы заявки разом (`lockRequestRoutes`): нынешние её дни, перегоны и
           * названный телом целевой рейс перевода в работу. Дальше по ходу транзакции те же строки
           * берутся повторно — это уже ничего не стоит и ничего не ждёт.
           *
           * Строка заявки блокируется всегда, а не только на возврате в «Новую»: под тем же
           * `FOR UPDATE` её берут выписка листа и аннулирование (Р11), и без него параллельная
           * правка бумаги успела бы вклиниться между принятым отпечатком и сверкой.
           *
           * Признак справочника читается здесь напрямую намеренно (Р10): это не режим заявки, а
           * **вход** `requestIsLinear` — режим собирается строкой ниже, из него и снимка.
           */
          const [orderedType] = await tx
            // linear-mode-ok: вход `requestIsLinear`, а не режим заявки — режим собирается ниже
            .select({ isLinear: vehicleTypes.isLinear })
            .from(vehicleTypes)
            .where(eq(vehicleTypes.id, before.vehicleTypeId))
            .for('share');
          if (!orderedType) throw err.notFound('Заявка не найдена');
          await lockRequestRoutes(tx, before.id, namedRouteIds(assignment?.route));
          const locked = await lockRequestRow(tx, before.id);
          /*
           * Режим этой транзакции — перечитанный **под блокировкой** (Р5), а не тот, что приехал
           * в `before`: DTO читалось до транзакции, и признак типа к этому моменту мог уже
           * переключиться. Дальше он идёт во все правила явным параметром — иначе укладка в рейс
           * и перегон решали бы по значению, которого в базе больше нет.
           */
          const isLinear =
            before.requestType === 'special_equipment' &&
            requestIsLinear({
              isLinearFrozen: locked.isLinearFrozen,
              typeIsLinear: orderedType.isLinear,
            });

          /*
           * Сверка отпечатка (§5.4) — под блокировками и **до первой записи**: диалог обещал
           * человеку точный результат, а между просмотром и нажатием план меняется, не тронув
           * заявку вовсе — признак типа переключили, лист аннулировали своей ручкой, наступила
           * полночь. `version` ни одного из этих трёх случаев не ловит, поэтому у неё своя
           * проверка, а здесь своя.
           */
          if (rollbackToWork) {
            if (!previewFingerprint) {
              throw err.unprocessable(
                'Возврат заказа в работу переписывает недельные листы ЭСМ-2: посмотрите последствия и подтвердите их',
                { previewFingerprint: 'Нужен просмотр последствий' },
              );
            }
            const planned = await buildEsm2SyncPlan(tx, {
              requestId: before.id,
              driverPersonId: assignment?.driverPersonId ?? null,
              asOf: today,
            });
            if (statusPreviewFingerprint(planned?.input ?? null, req.body) !== previewFingerprint) {
              throw err.conflict(
                'Данные изменились с момента просмотра: посмотрите последствия возврата заново',
              );
            }
          }

          // Возврат в «Новую» не спорит с выданной бумагой: заявку, стоящую в действующем листе,
          // стереть с работы нельзя — она пошла бы в чей-то следующий рейс, и одна работа
          // оказалась бы сразу в двух документах (ADR 0050). Заявка к этому моменту уже под
          // `FOR UPDATE`: без блокировки лист успел бы родиться между проверкой и сбросом.
          if (resetsWork) {
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
                // Режим — перечитанный под блокировкой (Р5), а не `before.isLinear`: у линейного
                // заказа рейс не один, а по одному на день, и решать это по устаревшему значению
                // значило бы положить заявку не в тот план.
                request: { ...before, isLinear },
                assignment: saved,
                route: assignment.route,
                actor: { id: p.id },
              });

              // Доставка техники на объект — по желанию: спецтехника доезжает до площадки своим
              // ходом, и на эту поездку выписывается 4-П, но повезти её могут и тралом. Вывоз
              // заводят позже, из карточки заявки: в этот момент его дату ещё не знают.
              if (assignment.delivery) {
                await addRelocation(tx, {
                  // Тот же перечитанный признак: линейной технике перегон не заводят вовсе, и
                  // отказ обязан считаться по режиму, действующему в этой транзакции.
                  request: { ...before, isLinear },
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
          const detached =
            before.status === 'confirmed' && status !== 'confirmed'
              ? await detachOnStatus(tx, before.id, status, p.id)
              : { droppedRelocations: [], detachedDays: [] };
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
            // Тот самый день, которым посчитан отпечаток (Р12): спроси сверка «сегодня» сама,
            // полночь дала бы ей другой набор недель, чем тот, что подтвердил человек.
            asOf: today,
          });
          /*
           * План по дням (ADR 0100 §11) — тем же порядком и по той же причине, что и бумага:
           * сверка читает заявку из базы. Отмена и возврат в «Новую» снимают дни уже выше
           * (`detachOnStatus`, там же спрашивается заморозка), но сверка идёт и по ним: она же
           * ловит дни, оставшиеся за сроком после уточнения периода тем же запросом.
           */
          const days = await syncLinearRouteDays(tx, {
            requestId: before.id,
            actor: { id: p.id },
            reason: `Заявка переведена в «${requestStatusLabels[status]}»`,
          });
          /*
           * Снятие заморозки режима (Р4) — **последним шагом** транзакции, строго после обеих
           * сверок. Заявка дорабатывала по снимку, и уход из «В работе» возвращает её справочнику:
           * снимок относится к работе, а не к закрытому заказу. Сними его раньше — и обе сверки
           * посчитали бы уже по новому режиму: крайняя неделя ЭСМ-2 не выписалась бы вовсе, и
           * заявка ушла бы в закрытие без бумаги за отработанное.
           *
           * Условие только про уход из работы: мягкое удаление статуса не меняет и заморозку не
           * снимает — архивная заявка остаётся «В работе», и восстановление обязано вернуть её
           * ровно такой, какой её спрятали (§5.5).
           */
          if (before.status === 'confirmed' && locked.isLinearFrozen !== null) {
            await tx
              .update(vehicleRequests)
              .set({ isLinearFrozen: null, linearFrozenAt: null })
              .where(eq(vehicleRequests.id, before.id));
          }
          return {
            assigned: saved,
            completed: closed,
            earlyEndDropped: droppedEarlyEnd,
            droppedRelocations: detached.droppedRelocations,
            detachedDays: detached.detachedDays,
            esm2,
            days,
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
          // Доставка, заведённая прошедшим днём (ADR 0101, Р29): своего события у неё нет — рейс
          // родился внутри перевода в работу, — поэтому объяснение живёт здесь, рядом с ним.
          ...(deliveryBackdated
            ? { deliveryBackdated: true, deliveryBackdateReason: deliveryReason }
            : {}),
          // Снятые дни линейного заказа — тем же порядком: их сняла не сверка сама по себе, а
          // смена статуса, и в истории это одно событие (ADR 0100 §11).
          ...(detachedDays.length > 0 ? { detachedDays } : {}),
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
          metadata: {
            changes: [
              ...diffVehicleCompletion(before.completion, completed),
              // Дни, за которые объект так и не расписался: закрытие их принимает молча, а спорят о
              // машиночасах через два месяца — по истории, и она обязана помнить, что подписи не было.
              ...(completed && pendingShiftDates.length > 0
                ? [{ field: 'shiftsPending', from: null, to: listDates(pendingShiftDates) }]
                : []),
            ],
          },
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
      await auditLinearDaysSync({
        actorUserId: p.id,
        requestId: before.id,
        reason: `status:${status}`,
        result: days,
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
   *
   * Этим же маршрутом идёт коррекция назначения задним числом (ADR 0101, Р8): у заказа техники на
   * объект рейса нет — машина и машинист стоят на самой заявке, — и «ехала другая машина»
   * исправляется здесь, а не коррекцией рейса. Признак приходит блоком `correction`; всё, что он
   * добавляет, собрано ниже в одном месте и в обычной смене техники не участвует.
   */
  r.patch(
    '/:id/assignment',
    { ...canChangeStatus, schema: { params: idParams, body: changeVehicleAssignmentSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { version, route, correction, ...rates } = req.body;
      const before = await getDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertRequestScope(p, before);
      // Арендодатель видит свои заявки и закрывает их (ADR 0038), но подбор техники — не его
      // решение: сменить машину он мог бы только на свою, а вместе с ней и исполнителя заявки.
      assertLessorScope(p, before.assignment?.lessorId ?? null);
      if (!correction) {
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
      } else if (!canCorrectAssignment(before)) {
        // Коррекция снимает у того же предиката ровно одну половину — замок подтверждённых дней
        // (Р5): их подпись и есть то, что операция сознательно снимает. Состояние заявки остаётся
        // запретом и под правом, а закрытой он объясняется порядком совместной работы (Р38).
        throw err.unprocessable(
          before.status === 'confirmed'
            ? 'У заявки нет назначенной техники — её назначает перевод в работу'
            : before.status === 'done'
              ? ASSIGNMENT_CORRECTION_CLOSED_MESSAGE
              : 'Сменить технику можно только у заявки в работе',
          { vehicleId: 'Заявка не в работе' },
        );
      }

      const today = moscowDateKeyOf(new Date());
      /*
       * Повтор уже выполненной операции узнаётся **до** всех расчётов, и это не оптимизация (Р31).
       * Первая попытка сожгла названные листы: пересчитанный по нынешнему состоянию план не нашёл
       * бы их среди действующих и ответил бы отказом на работу, которая на самом деле сделана.
       * Поэтому при найденном ключе план не считается вовсе — `runCorrection` сверит автора с
       * отпечатком (чужой ключ и другая команда — 409) и вернёт прежний результат, не зовя
       * `perform`.
       */
      const prior = correction ? await findCorrection(db, correction.operationId) : undefined;
      /**
       * Всё, что коррекция считает **до** первой правки (Р36): какие листы она назовёт, какие
       * недели выпишет, какие подписи снимет и какая у неё эффективная дата. Обычная смена техники
       * сюда не заходит вовсе — ни одного лишнего запроса ей не достаётся.
       */
      const plan =
        correction && !prior
          ? await planAssignmentCorrection(before, correction, rates.vehicleId, today)
          : null;
      // Функцией, а не разово: `runCorrection` зовёт её сам на каждой попытке, включая повтор, —
      // на нём это единственная проверка доступа, которая вообще случится (Р31).
      const authorize = (): boolean => {
        if (plan) {
          return backdateOrThrow(
            checkBackdate({
              effectiveDate: plan.effectiveDate,
              today,
              subject: p,
              hasReason: correction!.reason.trim() !== '',
            }),
          );
        }
        /*
         * Повтор: глубину пересчитать нечем — предмет операции уже переписан ею самой, — но право
         * спрашивается всё равно. Молча отдать прежний результат тому, у кого `waybills.correct`
         * успели отобрать между попытками, — та же утечка, что выполнить операцию без права.
         * Предел дней при этом остаётся проверенным первой попыткой: второй раз он ничего нового
         * не разрешает, потому что и работы второй раз не происходит.
         */
        if (correction && !can(p, 'waybills.correct')) {
          throw err.forbidden(BACKDATE_PERMISSION_MESSAGE);
        }
        return false;
      };
      authorize();

      let esm2: Esm2SyncResult = { cancelled: [], issued: [] };
      let days: LinearDaysSyncResult = { detached: [], frozen: [] };
      /** Назначение, каким оно записано; `null` на повторе операции — `perform` там не звался. */
      let assigned: Awaited<ReturnType<typeof resolveAssignment>> | null = null;

      type SavedAssignment = Awaited<ReturnType<typeof resolveAssignment>>;
      const applyAssignment = async (
        tx: Tx,
        correctionId: string | null,
      ): Promise<SavedAssignment> => {
        /*
         * Канонический порядок Р17 — первым делом и до всякой правки: сначала все рейсы заявки
         * (нынешний, названный телом целевой и перегоны) по возрастанию `id`, затем её строка.
         *
         * Порядок здесь был встречный дважды. Смена машины брала прежний рейс и целевой двумя
         * захватами без общего порядка (`moveToRouteOfVehicle`), а у линейного заказа переезжать
         * нечему вовсе — там рейсы брались **после** записи заявки, из сверки дней
         * (`syncLinearRouteDays`), то есть ровно наоборот канону.
         */
        await lockRequestRoutes(tx, before.id, namedRouteIds(route));
        await lockRequestRow(tx, before.id);
        const saved = await resolveAssignment(
          tx,
          { ...rates, route },
          { id: p.id, name: p.fullName },
          { correction: correctionId !== null },
        );
        // Область проверяется и по новой машине, а не только по прежней: иначе арендодатель одним
        // запросом увёл бы заявку на чужую технику — и заодно из собственной видимости.
        assertLessorScope(p, saved.lessorId);
        // Рейс и назначение переезжают одной транзакцией: заявка не должна побыть назначенной на
        // одну машину, а стоящей в рейсе другой — по такой паре не выписать ни лист, ни счёт.
        await moveToRouteOfVehicle(tx, {
          request: { ...before, isLinear: isLinearRequest(before) },
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
        //
        // Причина коррекции идёт сюда же и уходит в оба листа (Р35): в сгоревший — как причина
        // списания, в новый — как `correction_reason`. Обычной смене техники объяснение пишет
        // портал, и оно у неё одно на всё.
        esm2 = await syncEsm2Waybills(tx, {
          requestId: before.id,
          actor: { id: p.id },
          reason:
            correctionId && correction
              ? correction.reason
              : 'Заявке назначена другая техника — путевые листы переоформлены',
          driverPersonId: rates.driverPersonId ?? null,
          ...(correctionId && correction
            ? {
                correction: { id: correctionId, unlockWaybillIds: correction.unlockWaybillIds },
              }
            : {}),
        });
        // План по дням смена машины не двигает (ADR 0100 §4) — сверка зовётся ради другого: новая
        // машина бывает арендной, а арендную технику ведёт арендодатель, и в рейсах ей не место.
        days = await syncLinearRouteDays(tx, {
          requestId: before.id,
          actor: { id: p.id },
          reason: correctionId
            ? 'Коррекция назначения задним числом'
            : 'Заявке назначена другая техника',
        });
        /*
         * Дни, которых замороженный рейс не отдал (ADR 0100 §11, Р11). У обычной смены техники это
         * событие аудита: бумага дня выписана, день остаётся в ней, и портал об этом рассказывает.
         * У коррекции — отказ: она утверждает, что прошедший день был другим, а лист этого дня уже
         * у водителя, и молча разойтись с ним операция не вправе.
         */
        if (correctionId && days.frozen.length > 0) {
          throw err.unprocessable(
            `Дни заказа стоят в рейсах с выписанными листами (${days.frozen
              .map((d) => `${dateKeyRu(d.date)} — ${d.routeNumber}`)
              .join(
                '; ',
              )}): сначала аннулируйте лист рейса, иначе коррекция разойдётся с выданной бумагой`,
            { vehicleId: 'День в замороженном рейсе' },
          );
        }
        return saved;
      };

      let repeated = false;
      if (!correction) {
        assigned = await db.transaction((tx) => applyAssignment(tx, null));
      } else {
        const outcome = await runCorrection(
          {
            operationId: correction.operationId,
            kind: 'esm2',
            target: before.id,
            body: req.body,
            reason: correction.reason,
            actorUserId: p.id,
          },
          {
            authorize,
            perform: async (tx, record) => {
              const saved = await applyAssignment(tx, record.id);
              assigned = saved;
              // «Что делали с этой заявкой задним числом» спрашивают со стороны заявки, и связь
              // операции с ней — единственный ответ (Р16).
              await linkCorrectionRequests(tx, record.id, [before.id]);
              // Подписи объекта под днями работы снимаются здесь, а не в сверке: бумага и часы —
              // разные предметы, и второй из них к листам ЭСМ-2 отношения не имеет (Р5).
              //
              // План здесь всегда посчитан: `perform` не зовётся там, где прежняя операция нашлась
              // по ключу, а только там план и оставляют пустым.
              await clearShiftApprovals(tx, plan?.approvals ?? []);
              /*
               * Снимок «было → стало» (Р16). Прежние `approvedBy`/`approvedAt` попадают сюда
               * целиком: в самой таблице смен их после снятия уже нет, а «кто принял 11,5
               * машиночаса за 12 августа» спрашивают через два месяца — и ответить на это будет
               * больше нечем.
               */
              return {
                request: { id: before.id, num: before.num },
                assignment: {
                  before: before.assignment
                    ? {
                        vehicleId: before.assignment.vehicleId,
                        typeName: before.assignment.typeName,
                      }
                    : null,
                  after: { vehicleId: saved.vehicleId, ownership: saved.ownership },
                },
                esm2,
                linearDays: days,
                unlockedWaybills: (plan?.unlocked ?? []).map((s) => ({
                  id: s.id,
                  number: s.number,
                  periodFrom: s.periodFrom,
                  periodTo: s.periodTo,
                })),
                pastWeeks: plan?.pastWeeks ?? [],
                shiftApprovals: plan?.approvals ?? [],
              };
            },
          },
        );
        repeated = outcome.repeated;
      }

      // Ответ пересобирается из текущего состояния (Р31): повтор обязан ответить то же, что
      // ответил бы обычный запрос, а второго события в ленте аудита он не порождает — работа
      // сделана первой попыткой.
      if (repeated || !assigned) return (await getDto(before.id))!;

      await auditEsm2Sync({
        actorUserId: p.id,
        requestId: before.id,
        reason: correction ? 'correction' : 'vehicle_changed',
        result: esm2,
      });
      await auditLinearDaysSync({
        actorUserId: p.id,
        requestId: before.id,
        reason: correction ? 'correction' : 'vehicle_changed',
        result: days,
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
          // Задний ход — и в ленте аудита: журнал коррекций отвечает «почему», а лента остаётся
          // местом, где события заявки видны подряд и в одном порядке.
          ...(correction && plan
            ? {
                backdated: true,
                backdateReason: correction.reason,
                effectiveDate: plan.effectiveDate,
                unlockedWaybills: plan.unlocked.map((s) => s.number),
                clearedShiftApprovals: plan.approvals.map((a) => a.date),
              }
            : {}),
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
      let days: LinearDaysSyncResult = { detached: [], frozen: [] };
      await db.transaction(async (tx) => {
        /*
         * Канонический порядок Р17 — до первой записи: сокращённый срок снимает дни с рейсов
         * (`syncLinearRouteDays`), то есть эта транзакция берёт и рейсы, и заявку. Прежде она шла
         * к ним с конца — запись запроса, срок заказа, и только потом рейсы, — а встречная правка
         * заявки (`PATCH /:id`) идёт каноном: сначала рейсы, потом строка заказа. Две такие
         * транзакции Postgres разрывал как взаимную блокировку; проверено встречными транзакциями.
         */
        await lockRequestRoutes(tx, before.id);
        await lockRequestRow(tx, before.id);
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
          // Дни за новым концом срока сняты той же транзакцией (ADR 0100 §11): рейс на день,
          // которого у заказа больше нет, — это выезд, за который никто не заплатит.
          days = await syncLinearRouteDays(tx, {
            requestId: before.id,
            actor: { id: p.id },
            reason: `Срок заявки сокращён до ${dateKeyRu(newDateTo)}`,
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
      await auditLinearDaysSync({
        actorUserId: p.id,
        requestId: before.id,
        reason: 'early_end',
        result: days,
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
      let days: LinearDaysSyncResult = { detached: [], frozen: [] };

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
        // Тот же канонический порядок, что и у самого запроса сокращения (Р17): виза правит срок и
        // снимает дни с рейсов, значит рейсы и заявка берутся до первой записи и в этом порядке.
        await lockRequestRoutes(tx, before.id);
        await lockRequestRow(tx, before.id);
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
          days = await syncLinearRouteDays(tx, {
            requestId: before.id,
            actor: { id: p.id },
            reason: `Срок заявки сокращён до ${dateKeyRu(pending.newDateTo)}`,
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
      await auditLinearDaysSync({
        actorUserId: p.id,
        requestId: before.id,
        reason: 'early_end',
        result: days,
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
      // Заявка — раньше своего запроса на сокращение (Р17): рейсов отзыв не трогает вовсе, но
      // строку заказа он правит, а смена статуса снимает тот же запрос уже под её блокировкой
      // (`clearPendingEarlyEnd`). Обратный порядок здесь и был бы встречной блокировкой.
      await lockRequestRow(tx, before.id);
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

  // ── Дни линейного заказа (ADR 0100) ──
  // Линейная техника вечером возвращается на базу, а за день успевает поработать на нескольких
  // площадках: каждый день срока — отдельный выезд, который кладут в рейс машины на эту дату и
  // печатают в его 4-П. Дверь одна — карточка заявки (ADR 0100 §8): день знает свой срок и свою
  // заявку, а из карточки маршрута ту же заявку пришлось бы разыскивать по объекту среди всех
  // работающих. Своей таблицы у дней нет — перечень выводится из срока (§2).

  /**
   * План по дням: дни срока целиком, их рейсы, машины, водители, листы и часы смен.
   *
   * Отдельной ручкой, как смены: массив дней месячного заказа в строку списка не кладут, а нужен
   * он одной карточке одного вида заявок.
   *
   * Право — `waybills.read`: в плане стоят ФИО водителей собственного парка и номера выписанных
   * бланков, то есть ровно те персональные данные, которых заказчику со стороны объекта не
   * показывают (ADR 0037 п. 13).
   */
  r.get(
    '/:id/days',
    {
      preHandler: [app.authenticate, app.requirePermission('waybills.read')],
      schema: { params: idParams },
    },
    async (req): Promise<VehicleRequestDaysDto> => {
      const p = requirePrincipal(req);
      return daysResponse(await requireDaysRequest(p, req.params.id));
    },
  );

  /**
   * Поставить день заказа в рейс: в уже заведённый рейс машины на этот день либо в новый.
   *
   * Повторяет приём перевода в работу (`attachToRoute`), но с днём: рейс либо называют, либо
   * заводят тут же — «и то, и другое» означало бы два разных ответа на вопрос, куда едет день.
   * Машина спрашивается всегда, водитель — нет: рейс собирают заранее, человека ставят утром, и
   * подставлять вчерашнего портал не вправе (ADR 0083).
   *
   * Порядок здесь важен дважды. Сначала дешёвая проверка правилом — до того, как заводится рейс:
   * иначе отказ по сроку сжигал бы номер «Р-». Потом блокировки: сначала рейс, потом заявка —
   * порядок общий для модуля (`loadRequestForRoute`), иначе смена статуса заявки и планирование
   * дня встретятся встречными блокировками.
   *
   * Права — те же две, что у выписки листа с рейса и у перегона: `waybills.read` (в рейсе виден
   * водитель) и `vehicleRequests.status` (планирование — это ход работы по заявке).
   *
   * **Прошедший день** (ADR 0101 п. 4, дыра 1 плана). Правило дней прошлое разрешает и разрешать
   * будет — выезд оформляют и задним числом, а запрет отправил бы его мимо портала
   * (`planDayBlocker`), — но «можно» перестало значить «молча»: день в прошлом ставится в рейс
   * только с правом `waybills.correct` и названной причиной. Эффективная дата — сам день: он же
   * `routeDate` рейса (составной FK, миграция 0127), и второго ответа на «за какое число это
   * работа» здесь быть не может.
   *
   * Строки операции дверь не заводит — по тому же правилу, что заведение рейса и перегон (§1
   * плана, уточнение этапа 7): постановка дня в рейс номера строгой отчётности не расходует, а
   * операция без единого листа засоряла бы журнал коррекций. Объяснение уходит в аудит события
   * `vehicle_route.attach`; причина у бумаги появится своя — её спросит выписка листа по рейсу.
   */
  r.post(
    '/:id/days/:date/route',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: { params: dayParams, body: planVehicleRequestDaySchema },
    },
    async (req): Promise<VehicleRequestDaysDto> => {
      const p = requirePrincipal(req);
      const { date } = req.params;
      const body = req.body;
      const request = await requireDaysRequest(p, req.params.id);

      const reason = body.reason?.trim() ?? '';
      const backdated = backdateOrThrow(
        checkBackdate({
          effectiveDate: date,
          today: moscowDateKeyOf(new Date()),
          subject: p,
          hasReason: reason !== '',
        }),
      );

      const planned = await db.transaction(async (tx) => {
        // Проверка до рейса: у нового маршрута номер берётся из последовательности, и отказ по
        // сроку после его заведения сжёг бы «Р-» ни на что. Под блокировкой она повторится теми
        // же словами — здесь она про порядок, а не про правильность.
        const preflight = planDayBlocker(request, date, await plannedDaysOfRequest(tx, request.id));
        if (preflight) throw err.unprocessable(preflight, { date: 'День недоступен' });

        const route = await openDayRoute(tx, { body, date, actorId: p.id });
        // Заявка — после рейса: порядок блокировок в модуле общий.
        const state = await lockLinearRequest(tx, request.id);
        if (!state) throw err.notFound('Заявка не найдена');
        const plannedDays = await plannedDaysOfRequest(tx, request.id);
        const blocker = planDayBlocker(state, date, plannedDays);
        if (blocker) throw err.unprocessable(blocker, { date: 'День недоступен' });

        const waybill = await routeWaybill(tx, route.id);
        if (!isRouteEditable(waybill?.status ?? null)) throw err.conflict(ROUTE_FROZEN_MESSAGE);
        // День строки состава физически равен дню рейса (составной FK, миграция 0127): рейс
        // соседнего дня не «немного не тот», его база просто не примет — и объяснять это отказом
        // целостности нельзя.
        if (route.routeDate !== date) {
          throw err.unprocessable(
            `Маршрут ${formatVehicleRouteNumber(route.num)} заведён на ${route.routeDate}, а планируется день ${date}: день заказа и день рейса — это один и тот же день`,
            { routeId: 'Рейс другого дня' },
          );
        }
        const check = canJoinRoute(
          {
            requestType: state.requestType,
            isLinear: state.isLinear,
            status: state.status,
            deletedAt: state.deletedAt,
            // Ответ линейного заказа о дне — отрезок срока и уже занятые дни: какой именно день
            // кладут, отвечает сам рейс.
            day: linearRouteJoinDay(state, plannedDays),
            ownership: state.ownership,
          },
          {
            routeDate: route.routeDate,
            requestCount: await routeRequestCount(tx, route.id),
            purpose: route.purpose,
            // Ёмкость рейса задаёт его бланк: у 4-П семь строк задания (ADR 0068). Второй объект
            // того же дня попадает в тот же лист, пока эти строки есть.
            formCode: (
              await routeWaybillFormFor(tx, {
                purpose: route.purpose,
                vehicleId: route.vehicleId,
              })
            ).formCode,
          },
        );
        if (!check.ok) throw err.unprocessable(check.reason, { routeId: check.reason });

        try {
          await attachRequest(tx, route.id, request.id, date);
        } catch (e) {
          // Гонка двух диспетчеров: ловит её уникальный индекс, а не проверка выше (план У12).
          throw asDayRaceConflict(e, date);
        }
        /*
         * День линейного заказа — такая же строка задания, как ездка, и место в порядке объезда у
         * неё своё (план `docs/route-trips-plan.md`, Р5а). Точка заводится той же транзакцией, что
         * и строка состава: без неё день стоял бы в рейсе, но не печатался — задание листа
         * собирается из точек, а не из состава.
         *
         * Правило переиспользования общее с ездками (Р8): нашлась точка того же объекта с тем же
         * ответственным — день садится на неё, машина заезжает один раз; нет — новая в конец.
         */
        await placeLinearDay(tx, route.id, request.id, date);
        // Ёмкость проверяется после раскладки, а не до: считать надо строки задания — ездки плюс
        // линейные дни (Р11), — а до постановки дня их на одну меньше.
        await assertRoutePlacement(tx, {
          routeId: route.id,
          formCode: (
            await routeWaybillFormFor(tx, { purpose: route.purpose, vehicleId: route.vehicleId })
          ).formCode,
        });
        await bumpRouteVersion(tx, route.id, p.id);
        return route;
      });

      // Событие то же, что и у укладки заявки в рейс со стороны маршрута: состав рейса изменился,
      // и в журнале это должно читаться одинаково, откуда бы ни пришли. День — в метаданных.
      //
      // Задний ход — тем же событием: строки в журнале коррекций у планирования нет (см. заголовок
      // ручки), и «почему день поставлен прошедшим числом» объясняется здесь.
      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.attach',
        entityType: 'vehicle_route',
        entityId: planned.id,
        metadata: { requestId: request.id, workDate: date, backdated, reason },
      });
      return daysResponse(request);
    },
  );

  /**
   * Снять день с рейса. Рейс при этом остаётся: он мог собираться из нескольких заявок, и пустой
   * маршрут диспетчер убирает своим действием — как и всегда.
   *
   * Состояние заявки здесь не спрашивается намеренно: снять ошибочно поставленный день нужно и у
   * отменённой, и у закрытой заявки — сверка (`syncLinearRouteDays`) делает ровно это же сама.
   * Единственный отказ — выписанный лист: бланк уже у водителя, и исчезнуть из него день не может.
   */
  r.delete(
    '/:id/days/:date/route',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: { params: dayParams },
    },
    async (req): Promise<VehicleRequestDaysDto> => {
      const p = requirePrincipal(req);
      const { date } = req.params;
      const request = await requireDaysRequest(p, req.params.id);

      const routeId = await db.transaction(async (tx) => {
        /*
         * Рейс дня выясняется из связи, поэтому берётся приёмом Р17: прочитать → взять `FOR UPDATE`
         * → **перечитать** связь под блокировкой (`lockRouteOfRequestDay`). Прежде здесь стоял
         * одиночный `lockRoute` по первому чтению, и день, успевший переехать в соседний рейс,
         * снимался «с того рейса, где его уже нет»: `detachRequest` не находил строки, ответ всё
         * равно приходил успешный, а день оставался стоять в новом рейсе. Проверено параллельными
         * транзакциями: до правки ручка отвечала 200 при живом дне.
         *
         * Заявка — следом за рейсом (Р17): под её строкой стоит и укладка дня в рейс
         * (`lockLinearRequest`), и без неё день успели бы поставить обратно между снятием и концом
         * транзакции.
         */
        const route = await lockRouteOfRequestDay(tx, request.id, date);
        if (!route) throw err.notFound('Этот день не стоит ни в одном рейсе');
        await lockRequestRow(tx, request.id);
        const waybill = await routeWaybill(tx, route.id);
        if (!isRouteEditable(waybill?.status ?? null)) {
          throw err.conflict(LINEAR_DAY_FROZEN_MESSAGE);
        }
        const removed = await detachRequest(tx, route.id, request.id);
        // Недостижимо: связь перечитана под блокировкой рейса, а снять её без него нельзя. Ответ
        // «сняли» при неснятом дне хуже отказа, поэтому проверка стоит, а не подразумевается.
        if (!removed)
          throw err.conflict('День только что сняли с рейса — обновите карточку заявки');
        await bumpRouteVersion(tx, route.id, p.id);
        return route.id;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'vehicle_route.detach',
        entityType: 'vehicle_route',
        entityId: routeId,
        metadata: { requestId: request.id, workDate: date },
      });
      return daysResponse(request);
    },
  );

  // ── Подтверждение смен по заказу спецтехники ──
  // Техника стоит на объекте неделями, а работа считается по дням: за каждый день заказа — время
  // смены, машиночасы, заправка и подпись объекта. Пока подписи по наступившим дням нет, заявка не
  // уходит из среза «На объекте» даже с прошедшим сроком, а её закрытие идёт с предупреждением.

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
    remove: async (tx, row, actor) => {
      const linked = await tx
        .select({ id: files.id, objectKey: files.objectKey })
        .from(vehicleRequestFiles)
        .innerJoin(files, eq(vehicleRequestFiles.fileId, files.id))
        .where(eq(vehicleRequestFiles.vehicleRequestId, row.id));
      // Намерение уступает, факт держит (ADR 0085 Р15): строки «остаётся» и «уезжает»
      // неприменённых недельных заявок снимаются здесь же, а применённая заявка удалению помешает
      // и объяснится словами — заказ, ставший её следствием, снести насовсем нельзя.
      const cleanup = await dropWeeklyItemsOfRequest(tx, actor, {
        id: row.id,
        displayNumber: formatVehicleRequestNumber(row.num),
      });
      await tx.delete(vehicleRequests).where(eq(vehicleRequests.id, row.id));
      await hardDeleteFiles(tx, linked);
      return cleanup;
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
