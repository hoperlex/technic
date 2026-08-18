import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  approveWeeklyRequestSchema,
  BACKDATE_PERMISSION_MESSAGE,
  canCancelWaybill,
  createWeeklyRequestSchema,
  dateOnlySchema,
  extendBlocker,
  formatVehicleRequestNumber,
  formatWeeklyRequestNumber,
  isWeeklyRequestEditable,
  isWeeklyWeekOverdue,
  itemWarnings,
  minRequestDateKey,
  moscowDateKeyOf,
  newItemBlocker,
  orderEffectiveDateTo,
  sourceItemBlocker,
  updateWeeklyRequestSchema,
  uuidSchema,
  vehicleLabel,
  waybillDisplayNumber,
  weekStartKey,
  WEEKLY_CORRECTION_REQUIRED_MESSAGE,
  WEEKLY_SELECTABLE_WEEKS,
  weeklyItemKindLabels,
  weeklyRequestStatusSchema,
  weeklyWeekBlocker,
  weeklyWeekBounds,
  weeklyWeekEffectiveDate,
  weeklyWeekLabel,
  type WeeklyApplyResultDto,
  type WeeklyCorrectionPreviewDto,
  type WeeklyCorrectionSheetDto,
  type WeeklyCorrectionWeekDto,
  type WeeklyDocumentCellDto,
  type WeeklyDocumentRowDto,
  type WeeklyItemCounts,
  type WeeklyItemWarning,
  type WeeklyPreviousWeekDto,
  type WeeklyRequestDocumentsDto,
  type WeeklyRequestItemDto,
  type WeeklyRequestItemInput,
  type WeeklyRequestItemKind,
  type WeeklyRequestScope,
  type WeeklySourceOrder,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  specialEquipmentRequestDetails,
  users,
  vehicleCategories,
  vehicleModels,
  vehicleRequestAssignments,
  vehicleRequestEarlyEndings,
  vehicleRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
  weeklyVehicleRequestHistory,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
// Изменения для истории заказа — тем же модулем, что и у обычной правки: подписи полей общие.
import { earlyEndReasonChange, weeklyExtendChanges } from '../services/vehicle-request-diff';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import {
  approvesOwnWeeklyRequest,
  assertWeeklyRequestScope,
  canApproveWeeklyRequest,
  seesWholeWeeklyRequest,
} from '../lib/access';
import { applyWeeklyRequest } from '../services/weekly-request-apply';
import {
  assertWeeklyRequestReadable,
  weeklyItemsReadWhere,
} from '../services/weekly-request-access';
import { loadLeftBy } from '../services/weekly-request-blockers';
import { auditEsm2Sync, esm2CorrectionScope } from '../services/waybill-esm2';
// Механика заднего числа — общая для всех входов (ADR 0101): вердикт, запись операции,
// идемпотентность по ключу и связь операции с заявками живут в одном месте, а не переписываются
// каждым входом по-своему.
import {
  backdateAccessOf,
  backdateOrThrow,
  checkBackdate,
  findCorrection,
  linkCorrectionRequests,
  runCorrection,
} from '../services/waybill-correction';

/**
 * Недельная заявка на технику (ADR 0085): площадка заказывает не по одной машине, а неделями.
 *
 * Документ-основание **над** заказами ТС, а не третий их тип: согласование недельной заявки
 * порождает и продлевает обычные заказы, и дальше всё работает как раньше — машину назначает
 * диспетчер, ЭСМ-2 портал ведёт сам, заявка закрывается фактом. Отдельного действия «применить»
 * нет: виза применяет заявку той же транзакцией, иначе возникло бы состояние «завизировано, но
 * ничего не произошло».
 *
 * Права свои (`weeklyRequests.*`), и область — свой предикат (`weeklyRequestVisibilityWhere`):
 * `vehicleRequests.read` есть у наблюдателя и у арендодателя, а тамошний предикат неизвестной роли
 * отвечает «ограничений нет».
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

/** Предложение состава: пара «площадка + неделя» — всё, что нужно, чтобы его собрать. */
const suggestionQuerySchema = z.object({
  objectId: uuidSchema,
  weekStart: dateOnlySchema,
});

// ── Алиасы: одна таблица встречается в запросе состава несколько раз ──
const creators = alias(users, 'weekly_creators');
const updaters = alias(users, 'weekly_updaters');
const approvers = alias(users, 'weekly_approvers');
const historyActors = alias(users, 'weekly_history_actors');
/** Заказ-основание строки `extend`/`leave`. */
const sourceRequests = alias(vehicleRequests, 'weekly_source_requests');
/** Порождённый заказ строки `new`. */
const createdRequests = alias(vehicleRequests, 'weekly_created_requests');
const sourceDetails = alias(specialEquipmentRequestDetails, 'weekly_source_details');
const sourceEarlyEnds = alias(vehicleRequestEarlyEndings, 'weekly_source_early_ends');
/**
 * Назначение заказа, к которому относится строка. Одним join'ом на `coalesce`, а не двумя: заказ у
 * строки ровно один — у `extend` и `leave` это основание, у `new` — порождённый, и CHECK
 * `weekly_items_kind_shape_check` не даёт им встретиться вместе.
 */
const itemAssignments = alias(vehicleRequestAssignments, 'weekly_item_assignments');
const itemVehicles = alias(vehicles, 'weekly_item_vehicles');
const itemVehicleModels = alias(vehicleModels, 'weekly_item_vehicle_models');
const itemVehicleTypes = alias(vehicleTypes, 'weekly_item_vehicle_types');
const itemVehicleCategories = alias(vehicleCategories, 'weekly_item_vehicle_categories');
/** Заказанная позиция классификатора строки `new` — не путать с типом назначенной машины. */
const orderedTypes = alias(vehicleTypes, 'weekly_ordered_types');
const orderedCategories = alias(vehicleCategories, 'weekly_ordered_categories');
/** Рейс-перегон «вывоз» по заказу: оформленный вывоз исключает единицу из подбора (этап 2 плана). */
const pickupRoutes = alias(vehicleRoutes, 'weekly_pickup_routes');

const weeklySelect = {
  id: weeklyVehicleRequests.id,
  num: weeklyVehicleRequests.num,
  objectId: weeklyVehicleRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  weekStart: weeklyVehicleRequests.weekStart,
  status: weeklyVehicleRequests.status,
  comment: weeklyVehicleRequests.comment,
  cancelReason: weeklyVehicleRequests.cancelReason,
  approvedBy: weeklyVehicleRequests.approvedBy,
  approvedByName: approvers.fullName,
  approvedAt: weeklyVehicleRequests.approvedAt,
  appliedAt: weeklyVehicleRequests.appliedAt,
  createdBy: weeklyVehicleRequests.createdBy,
  createdByName: creators.fullName,
  createdAt: weeklyVehicleRequests.createdAt,
  updatedByName: updaters.fullName,
  updatedAt: weeklyVehicleRequests.updatedAt,
  version: weeklyVehicleRequests.version,
};

function headerQuery() {
  return db
    .select(weeklySelect)
    .from(weeklyVehicleRequests)
    .innerJoin(constructionObjects, eq(weeklyVehicleRequests.objectId, constructionObjects.id))
    .innerJoin(creators, eq(weeklyVehicleRequests.createdBy, creators.id))
    .leftJoin(updaters, eq(weeklyVehicleRequests.updatedBy, updaters.id))
    .leftJoin(approvers, eq(weeklyVehicleRequests.approvedBy, approvers.id));
}

type HeaderRow = Awaited<ReturnType<typeof headerQuery>>[number];

const itemSelect = {
  id: weeklyVehicleRequestItems.id,
  weeklyRequestId: weeklyVehicleRequestItems.weeklyRequestId,
  position: weeklyVehicleRequestItems.position,
  kind: weeklyVehicleRequestItems.kind,
  sourceRequestId: weeklyVehicleRequestItems.sourceRequestId,
  sourceRequestNum: sourceRequests.num,
  sourceObjectId: sourceRequests.objectId,
  sourceRequestType: sourceRequests.requestType,
  sourceStatus: sourceRequests.status,
  sourceDeletedAt: sourceRequests.deletedAt,
  sourceDateFrom: sourceDetails.dateFrom,
  sourceDateTo: sourceDetails.dateTo,
  pendingEarlyEndDate: sourceEarlyEnds.newDateTo,
  vehicleTypeId: weeklyVehicleRequestItems.vehicleTypeId,
  vehicleTypeName: orderedTypes.name,
  vehicleCategoryId: weeklyVehicleRequestItems.vehicleCategoryId,
  vehicleCategoryName: orderedCategories.name,
  dateFrom: weeklyVehicleRequestItems.dateFrom,
  dateTo: weeklyVehicleRequestItems.dateTo,
  responsibleName: weeklyVehicleRequestItems.responsibleName,
  responsiblePhone: weeklyVehicleRequestItems.responsiblePhone,
  deliveryNeeded: weeklyVehicleRequestItems.deliveryNeeded,
  deliveryFrom: weeklyVehicleRequestItems.deliveryFrom,
  comment: weeklyVehicleRequestItems.comment,
  expectedDateTo: weeklyVehicleRequestItems.expectedDateTo,
  previousDateTo: weeklyVehicleRequestItems.previousDateTo,
  appliedSourceVersion: weeklyVehicleRequestItems.appliedSourceVersion,
  snapshotVehicleId: weeklyVehicleRequestItems.snapshotVehicleId,
  createdRequestId: weeklyVehicleRequestItems.createdRequestId,
  createdRequestNum: createdRequests.num,
  createdRequestApprovedAt: createdRequests.approvedAt,
  sourceApprovedAt: sourceRequests.approvedAt,
  result: weeklyVehicleRequestItems.result,
  skipReason: weeklyVehicleRequestItems.skipReason,
  // Машина заказа, к которому относится строка, — и её реквизиты для подписи (`vehicleLabel`).
  currentVehicleId: itemAssignments.vehicleId,
  ownership: itemVehicles.ownership,
  vehicleDescription: itemVehicles.description,
  vehicleRegistrationNumber: itemVehicles.registrationNumber,
  vehicleModelName: itemVehicleModels.name,
  vehicleTypeOfVehicle: itemVehicleTypes.name,
  vehicleCategoryOfVehicle: itemVehicleCategories.name,
};

function itemsQuery() {
  return db
    .select(itemSelect)
    .from(weeklyVehicleRequestItems)
    .leftJoin(sourceRequests, eq(weeklyVehicleRequestItems.sourceRequestId, sourceRequests.id))
    .leftJoin(sourceDetails, eq(sourceRequests.id, sourceDetails.requestId))
    .leftJoin(
      sourceEarlyEnds,
      and(eq(sourceRequests.id, sourceEarlyEnds.requestId), eq(sourceEarlyEnds.status, 'pending')),
    )
    .leftJoin(createdRequests, eq(weeklyVehicleRequestItems.createdRequestId, createdRequests.id))
    .leftJoin(orderedTypes, eq(weeklyVehicleRequestItems.vehicleTypeId, orderedTypes.id))
    .leftJoin(
      orderedCategories,
      eq(weeklyVehicleRequestItems.vehicleCategoryId, orderedCategories.id),
    )
    .leftJoin(
      itemAssignments,
      sql`${itemAssignments.requestId} = coalesce(${weeklyVehicleRequestItems.sourceRequestId}, ${weeklyVehicleRequestItems.createdRequestId})`,
    )
    .leftJoin(itemVehicles, eq(itemAssignments.vehicleId, itemVehicles.id))
    .leftJoin(itemVehicleModels, eq(itemVehicles.vehicleModelId, itemVehicleModels.id))
    .leftJoin(itemVehicleTypes, eq(itemVehicles.vehicleTypeId, itemVehicleTypes.id))
    .leftJoin(itemVehicleCategories, eq(itemVehicles.vehicleCategoryId, itemVehicleCategories.id));
}

type ItemRow = Awaited<ReturnType<typeof itemsQuery>>[number];

/** Подпись назначенной машины: правило одно на портал и сервер (`vehicleLabel`). */
function labelOf(row: ItemRow): string | null {
  if (!row.currentVehicleId || !row.ownership) return null;
  return vehicleLabel({
    ownership: row.ownership,
    description: row.vehicleDescription ?? '',
    categoryName: row.vehicleCategoryOfVehicle,
    typeName: row.vehicleTypeOfVehicle ?? '',
    registrationNumber: row.vehicleRegistrationNumber,
    modelName: row.vehicleModelName,
  });
}

/**
 * Заказ строки глазами предикатов состава — из тех же колонок, что читает применение.
 *
 * Оформленный вывоз и чужое «уезжает» здесь не спрашиваются: этот объект нужен ровно для
 * `itemWarnings` — предупреждений под сохранённой строкой, — а годность строки решается там, где
 * её решают, и негодность объясняется причиной из предложения (`blocked`) либо отказом применения.
 * Читать ради предупреждений ещё два запроса на список значило бы платить за то, чего никто не
 * показывает.
 */
function orderOf(row: ItemRow): WeeklySourceOrder | null {
  if (!row.sourceRequestId || !row.sourceRequestType) return null;
  return {
    id: row.sourceRequestId,
    objectId: row.sourceObjectId,
    requestType: row.sourceRequestType,
    status: row.sourceStatus!,
    deletedAt: row.sourceDeletedAt ? row.sourceDeletedAt.toISOString() : null,
    dateFrom: row.sourceDateFrom ?? '',
    dateTo: row.sourceDateTo,
    hasAssignment: !!row.currentVehicleId,
    pickupRoute: null,
    leftBy: null,
    pendingEarlyEndDate: row.pendingEarlyEndDate,
  };
}

function countsOf(items: { kind: WeeklyRequestItemKind }[]): WeeklyItemCounts {
  return {
    extend: items.filter((i) => i.kind === 'extend').length,
    new: items.filter((i) => i.kind === 'new').length,
    leave: items.filter((i) => i.kind === 'leave').length,
  };
}

/**
 * Строки состава по заявкам страницы — одним запросом на всю выдачу.
 *
 * Предупреждения считаются только у неприменённой заявки: у применённой состав заморожен, и
 * «продление задевает лист» там уже не совет, а рассказ о прошлом. `otherWeekly` тоже спрашивается
 * только там, где им пользуются, — лишний запрос на список ни к чему.
 */
async function loadItems(
  weeklyIds: string[],
  scopes: Map<string, WeeklyRequestScope & { editable: boolean }>,
  withWarnings: boolean,
  /**
   * Учётка, которой собирают состав. Нужна ради одной ветки: арендодателю документ открыли его же
   * строки, и показывать рядом с ними чужие заказы, машины и сроки — значит отдать ему парк
   * площадки. Условие сужения то же самое, что открыло заявку (`weeklyItemsReadWhere`), — второго
   * места, где живёт это правило, быть не должно.
   */
  viewer?: Principal,
): Promise<Map<string, WeeklyRequestItemDto[]>> {
  const byRequest = new Map<string, WeeklyRequestItemDto[]>();
  if (weeklyIds.length === 0) return byRequest;

  const rows = await itemsQuery()
    .where(
      and(
        inArray(weeklyVehicleRequestItems.weeklyRequestId, weeklyIds),
        viewer ? weeklyItemsReadWhere(viewer) : undefined,
      ),
    )
    .orderBy(
      asc(weeklyVehicleRequestItems.weeklyRequestId),
      asc(weeklyVehicleRequestItems.position),
    );

  const otherWeekly = withWarnings ? await loadOtherWeekly(rows) : new Map();

  for (const row of rows) {
    const scope = scopes.get(row.weeklyRequestId);
    const order = orderOf(row);
    let warnings: WeeklyItemWarning[] = [];
    if (withWarnings && scope?.editable && order) {
      warnings = itemWarnings(
        {
          ...order,
          ownership: row.ownership,
          pendingEarlyEndDate: row.pendingEarlyEndDate,
          otherWeekly: otherWeekly.get(row.sourceRequestId!) ?? null,
        },
        scope,
        row.kind === 'extend' ? row.dateTo : null,
      );
    }
    const list = byRequest.get(row.weeklyRequestId) ?? [];
    list.push({
      id: row.id,
      position: row.position,
      kind: row.kind,
      sourceRequestId: row.sourceRequestId,
      sourceRequestNum: row.sourceRequestNum,
      sourceDisplayNumber:
        row.sourceRequestNum === null ? null : formatVehicleRequestNumber(row.sourceRequestNum),
      sourceStatus: row.sourceStatus,
      sourceDateFrom: row.sourceDateFrom,
      sourceDateTo: row.sourceDateTo,
      vehicleTypeId: row.vehicleTypeId,
      vehicleTypeName: row.vehicleTypeName,
      vehicleCategoryId: row.vehicleCategoryId,
      vehicleCategoryName: row.vehicleCategoryName,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
      responsibleName: row.responsibleName,
      responsiblePhone: row.responsiblePhone,
      deliveryNeeded: row.deliveryNeeded,
      deliveryFrom: row.deliveryFrom,
      comment: row.comment,
      expectedDateTo: row.expectedDateTo,
      previousDateTo: row.previousDateTo,
      appliedSourceVersion: row.appliedSourceVersion,
      snapshotVehicleId: row.snapshotVehicleId,
      currentVehicleId: row.currentVehicleId,
      currentVehicleLabel: labelOf(row),
      createdRequestId: row.createdRequestId,
      createdRequestNum: row.createdRequestNum,
      result: row.result,
      skipReason: row.skipReason,
      warnings,
    });
    byRequest.set(row.weeklyRequestId, list);
  }
  return byRequest;
}

/**
 * Заказы состава, стоящие ещё и в другой активной недельной заявке (план §8). Запрета на две
 * недели у одного заказа нет намеренно — планировать через неделю нормально, а порядок применения
 * разрешается сроком сам, — но видеть это человек должен заранее.
 *
 * «Активная» — это ещё не прошедшая: заявка отработанной недели тоже не отменена, но предупреждать
 * о ней значит рассказывать про прошлое там, где спрашивают про планы.
 */
async function loadOtherWeekly(
  rows: { sourceRequestId: string | null; weeklyRequestId: string }[],
): Promise<Map<string, { num: number; weekStart: string }>> {
  const sourceIds = [...new Set(rows.map((r) => r.sourceRequestId).filter((v) => v !== null))];
  const mine = new Set(rows.map((r) => r.weeklyRequestId));
  const found = new Map<string, { num: number; weekStart: string }>();
  if (sourceIds.length === 0) return found;

  const others = await db
    .select({
      sourceRequestId: weeklyVehicleRequestItems.sourceRequestId,
      num: weeklyVehicleRequests.num,
      weekStart: weeklyVehicleRequests.weekStart,
      weeklyRequestId: weeklyVehicleRequests.id,
    })
    .from(weeklyVehicleRequestItems)
    .innerJoin(
      weeklyVehicleRequests,
      eq(weeklyVehicleRequestItems.weeklyRequestId, weeklyVehicleRequests.id),
    )
    .where(
      and(
        inArray(weeklyVehicleRequestItems.sourceRequestId, sourceIds),
        ne(weeklyVehicleRequests.status, 'cancelled'),
        gte(weeklyVehicleRequests.weekStart, weekStartKey(moscowDateKeyOf(new Date()))),
      ),
    )
    .orderBy(asc(weeklyVehicleRequests.weekStart));
  for (const row of others) {
    if (mine.has(row.weeklyRequestId)) continue;
    if (!row.sourceRequestId || found.has(row.sourceRequestId)) continue;
    found.set(row.sourceRequestId, { num: row.num, weekStart: row.weekStart });
  }
  return found;
}

function toDto(header: HeaderRow, items: WeeklyRequestItemDto[]): WeeklyVehicleRequestDto {
  const bounds = weeklyWeekBounds(header.weekStart);
  return {
    id: header.id,
    num: header.num,
    displayNumber: formatWeeklyRequestNumber(header.num),
    objectId: header.objectId,
    objectCode: header.objectCode,
    objectName: header.objectName,
    weekStart: header.weekStart,
    weekEnd: bounds.to,
    weekLabel: weeklyWeekLabel(header.weekStart),
    status: header.status,
    comment: header.comment,
    cancelReason: header.cancelReason,
    approvedBy: header.approvedBy,
    approvedByName: header.approvedByName,
    approvedAt: header.approvedAt ? header.approvedAt.toISOString() : null,
    appliedAt: header.appliedAt ? header.appliedAt.toISOString() : null,
    items,
    counts: countsOf(items),
    createdBy: header.createdBy,
    createdByName: header.createdByName,
    createdAt: header.createdAt.toISOString(),
    updatedByName: header.updatedByName,
    updatedAt: header.updatedAt.toISOString(),
    version: header.version,
  };
}

/** Область недели по шапке — правая сторона всех предикатов состава. */
function scopeOf(
  header: { objectId: string; weekStart: string },
  today: string,
): WeeklyRequestScope {
  const bounds = weeklyWeekBounds(header.weekStart);
  return { objectId: header.objectId, weekStart: bounds.from, weekEnd: bounds.to, today };
}

async function loadDtos(
  headers: HeaderRow[],
  withWarnings: boolean,
  viewer?: Principal,
): Promise<WeeklyVehicleRequestDto[]> {
  const today = moscowDateKeyOf(new Date());
  const scopes = new Map(
    headers.map((h) => [
      h.id,
      { ...scopeOf(h, today), editable: isWeeklyRequestEditable(h.status) },
    ]),
  );
  const items = await loadItems(
    headers.map((h) => h.id),
    scopes,
    withWarnings,
    viewer,
  );
  // `counts` считается по тем строкам, что уехали человеку: «8 единиц» рядом с одной видимой
  // строкой само по себе есть выдача состава — цифра сказала бы арендодателю ровно то, что от
  // него закрыли строками.
  return headers.map((h) => toDto(h, items.get(h.id) ?? []));
}

async function getDto(id: string, viewer?: Principal): Promise<WeeklyVehicleRequestDto | null> {
  const [header] = await headerQuery().where(eq(weeklyVehicleRequests.id, id));
  if (!header) return null;
  const [dto] = await loadDtos([header], true, viewer);
  return dto ?? null;
}

/**
 * Недельные заявки по идентификаторам — для ленты раздела «Заказ автотехники», где строки
 * догружаются после того, как порядок и страница выбраны объединённым запросом.
 *
 * Экспортируется отсюда, а не собирается лентой заново: сборщик DTO у документа один, и второй,
 * «облегчённый», разошёлся бы с ним при первой же правке состава — в списке появились бы поля,
 * которых нет в карточке, или наоборот.
 */
export async function loadWeeklyDtosByIds(
  ids: string[],
  viewer: Principal,
): Promise<Map<string, WeeklyVehicleRequestDto>> {
  if (ids.length === 0) return new Map();
  const headers = await headerQuery().where(inArray(weeklyVehicleRequests.id, ids));
  const dtos = await loadDtos(headers, false, viewer);
  return new Map(dtos.map((dto) => [dto.id, dto]));
}

/** Шапка под правку: читается до транзакции — область и статус решаются по ней. */
async function requireHeader(id: string): Promise<HeaderRow> {
  const [header] = await headerQuery().where(eq(weeklyVehicleRequests.id, id));
  if (!header) throw err.notFound('Недельная заявка не найдена');
  return header;
}

// ── Сборка состава ──

/**
 * Заказы, из которых собирается неделя, — тем же условием, что вкладка «На объекте» (ADR 0036).
 * Отбор широкий намеренно: негодные заказы не выбрасываются молча, а объясняются причиной
 * (`blocked`) — иначе площадка не поймёт, куда делась знакомая машина.
 *
 * Два режима, и разница между ними существенна. Предложению нужен **срез площадки**, и отбор в нём
 * узкий: чужого и закрытого там быть не должно вовсе. Сохранению состава приходят **названные
 * клиентом заказы**, и отбирать их тем же условием нельзя: заказ чужой площадки, откаченный в
 * «Новую» или ушедший в архив пропал бы из выборки, а человек получил бы «не найден» вместо
 * причины. Поэтому здесь фильтров нет — на все эти вопросы отвечает `sourceItemBlocker`, один и
 * тот же на портал и сервер.
 *
 * Оформленный вывоз и ожидающий визы отъезд едут `leftJoin`'ами, и оба безопасны — кандидата они
 * не размножают: у рейса-перегона это держит частичный `vehicle_routes_source_request_unique` на
 * пару `(source_request_id, purpose)`, у запроса на отъезд — первичный ключ по `request_id`.
 * Третий источник негодности, чужое «уезжает», join'ом брать нельзя вовсе — он читается отдельной
 * map-выборкой (`loadLeftBy`) и приходит сюда параметром.
 */
async function loadCandidates(tx: Tx | typeof db, objectId: string, ids?: string[]) {
  return tx
    .select({
      id: vehicleRequests.id,
      num: vehicleRequests.num,
      objectId: vehicleRequests.objectId,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      vehicleId: vehicleRequestAssignments.vehicleId,
      ownership: vehicles.ownership,
      vehicleDescription: vehicles.description,
      vehicleRegistrationNumber: vehicles.registrationNumber,
      vehicleModelName: vehicleModels.name,
      vehicleTypeName: vehicleTypes.name,
      vehicleCategoryName: vehicleCategories.name,
      pendingEarlyEndDate: vehicleRequestEarlyEndings.newDateTo,
      pickupRouteNum: pickupRoutes.num,
      pickupRouteDate: pickupRoutes.routeDate,
    })
    .from(vehicleRequests)
    .innerJoin(
      specialEquipmentRequestDetails,
      eq(vehicleRequests.id, specialEquipmentRequestDetails.requestId),
    )
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
    )
    .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
    .leftJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
    .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
    .leftJoin(
      vehicleRequestEarlyEndings,
      and(
        eq(vehicleRequests.id, vehicleRequestEarlyEndings.requestId),
        eq(vehicleRequestEarlyEndings.status, 'pending'),
      ),
    )
    .leftJoin(
      pickupRoutes,
      and(eq(vehicleRequests.id, pickupRoutes.sourceRequestId), eq(pickupRoutes.purpose, 'pickup')),
    )
    .where(
      ids
        ? inArray(vehicleRequests.id, ids)
        : and(
            eq(vehicleRequests.objectId, objectId),
            eq(vehicleRequests.requestType, 'special_equipment'),
            eq(vehicleRequests.status, 'confirmed'),
            isNull(vehicleRequests.deletedAt),
          ),
    )
    .orderBy(asc(vehicleRequests.num));
}

type Candidate = Awaited<ReturnType<typeof loadCandidates>>[number];

/**
 * Кандидат глазами предикатов. `leftBy` приходит параметром, а не колонкой выборки: решений
 * «уезжает» по одному заказу бывает несколько, и join размножил бы кандидата — читается оно
 * отдельной map-выборкой (`loadLeftBy`).
 */
function candidateOrder(c: Candidate, leftBy: { num: number } | null): WeeklySourceOrder {
  return {
    id: c.id,
    objectId: c.objectId,
    requestType: c.requestType,
    status: c.status,
    deletedAt: c.deletedAt ? c.deletedAt.toISOString() : null,
    dateFrom: c.dateFrom,
    dateTo: c.dateTo,
    hasAssignment: !!c.vehicleId,
    pickupRoute:
      c.pickupRouteNum !== null && c.pickupRouteDate !== null
        ? { num: c.pickupRouteNum, routeDate: c.pickupRouteDate }
        : null,
    leftBy,
    pendingEarlyEndDate: c.pendingEarlyEndDate,
  };
}

function candidateDto(
  c: Candidate,
  order: WeeklySourceOrder,
  scope: WeeklyRequestScope,
  otherWeekly: { num: number; weekStart: string } | null,
): WeeklySuggestionOrderDto {
  // Почему по этой единице нельзя выбрать «Остаётся» — считает сервер, и тем же предикатом, каким
  // он потом откажет: разойдись форма с сервером, площадка видела бы вариант, который всегда
  // отвечает отказом. Живой случай один — срок, идущий ровно до воскресенья недели: продлевать
  // внутри этой недели нечем, а «оставить дальше» решает заявка на следующую неделю.
  const extendBlockedReason = extendBlocker(order, scope, null, scope.weekEnd);
  // Даты продления у такой единицы нет: воскресенье — это её же конец срока, то есть день, который
  // сервер тут же и отвергнет. Отдать его значило бы вернуть форме дату, которой не должно быть.
  const suggestedDateTo = extendBlockedReason ? null : scope.weekEnd;
  return {
    requestId: c.id,
    num: c.num,
    displayNumber: formatVehicleRequestNumber(c.num),
    dateFrom: c.dateFrom,
    dateTo: c.dateTo,
    effectiveDateTo: orderEffectiveDateTo(order),
    vehicleTypeName: c.vehicleTypeName ?? '',
    vehicleCategoryName: c.vehicleCategoryName,
    vehicleId: c.vehicleId,
    vehicleLabel:
      c.vehicleId && c.ownership
        ? vehicleLabel({
            ownership: c.ownership,
            description: c.vehicleDescription ?? '',
            categoryName: c.vehicleCategoryName,
            typeName: c.vehicleTypeName ?? '',
            registrationNumber: c.vehicleRegistrationNumber,
            modelName: c.vehicleModelName,
          })
        : null,
    ownership: c.ownership,
    suggestedDateTo,
    extendBlockedReason,
    // Умолчание — «остаётся»: неделя чаще продлевается, чем сокращается. Единица, которую
    // продлить нечем, приходит без решения — за неё выбирают «Уезжает» или не выбирают ничего.
    included: !extendBlockedReason,
    // Предупреждения считаются от той же даты, что предложена: продления нет — нет ни сплошного
    // срока, ни перевыписки листа, и говорить о них было бы рассказом о том, чего не будет.
    warnings: itemWarnings(
      { ...order, ownership: c.ownership, otherWeekly },
      scope,
      suggestedDateTo,
    ),
  };
}

/**
 * Последняя применённая недельная заявка этой площадки до целевой недели — и заказы её позиций.
 *
 * «Прошлая» — это именно **последняя применённая**, а не «неделя минус семь дней»: неделю
 * пропускают, и тогда преемственность тянется от той заявки, что была. Черновик и заявка на визе
 * прошлой не считаются: они ещё ничего не решили, а их состав человек и так видит у себя.
 *
 * Строки `leave` в кандидаты не тянутся вовсе: решение по ним принято, и этап 2 их же и
 * заблокировал бы («уезжает по НЗ-15»). Заказ у остальных ровно один — основание у продления,
 * порождённый у новой строки, — и CHECK `weekly_items_kind_shape_check` не даёт им встретиться
 * вместе, поэтому `coalesce` здесь читается однозначно.
 */
async function loadPreviousApplied(
  objectId: string,
  weekStart: string,
): Promise<{ id: string; num: number; weekStart: string; orders: Map<string, number> } | null> {
  const [previous] = await db
    .select({
      id: weeklyVehicleRequests.id,
      num: weeklyVehicleRequests.num,
      weekStart: weeklyVehicleRequests.weekStart,
    })
    .from(weeklyVehicleRequests)
    .where(
      and(
        eq(weeklyVehicleRequests.objectId, objectId),
        eq(weeklyVehicleRequests.status, 'applied'),
        lt(weeklyVehicleRequests.weekStart, weekStart),
      ),
    )
    .orderBy(desc(weeklyVehicleRequests.weekStart), desc(weeklyVehicleRequests.num))
    .limit(1);
  if (!previous) return null;

  const rows = await db
    .select({
      sourceRequestId: weeklyVehicleRequestItems.sourceRequestId,
      createdRequestId: weeklyVehicleRequestItems.createdRequestId,
      sourceNum: sourceRequests.num,
      createdNum: createdRequests.num,
    })
    .from(weeklyVehicleRequestItems)
    .leftJoin(sourceRequests, eq(weeklyVehicleRequestItems.sourceRequestId, sourceRequests.id))
    .leftJoin(createdRequests, eq(weeklyVehicleRequestItems.createdRequestId, createdRequests.id))
    .where(
      and(
        eq(weeklyVehicleRequestItems.weeklyRequestId, previous.id),
        ne(weeklyVehicleRequestItems.kind, 'leave'),
      ),
    )
    .orderBy(asc(weeklyVehicleRequestItems.position));

  const orders = new Map<string, number>();
  for (const row of rows) {
    const requestId = row.sourceRequestId ?? row.createdRequestId;
    const num = row.sourceNum ?? row.createdNum;
    // Строка `new`, не дошедшая до применения, заказа не породила — тянуть за неё нечего.
    if (!requestId || num === null) continue;
    orders.set(requestId, num);
  }
  return { ...previous, orders };
}

/** Строки состава к записи: серверные поля проставляются здесь и только здесь (план §7). */
async function buildItemRows(
  tx: Tx,
  weekly: { id: string; objectId: string; weekStart: string },
  items: WeeklyRequestItemInput[],
): Promise<(typeof weeklyVehicleRequestItems.$inferInsert)[]> {
  const today = moscowDateKeyOf(new Date());
  const scope = scopeOf(weekly, today);
  const [object] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, weekly.objectId));
  const fullScope: WeeklyRequestScope = { ...scope, objectIsActive: !!object?.isActive };

  const sourceIds = items
    .map((i) => (i.kind === 'new' ? null : i.sourceRequestId))
    .filter((v): v is string => v !== null);
  const seen = new Set<string>();
  for (const id of sourceIds) {
    // Два решения об одной машине на одну неделю противоречивы по определению; частичный UNIQUE
    // это и держит, но человеку нужен ответ, а не ошибка целостности.
    if (seen.has(id)) throw err.unprocessable('Один заказ дважды в составе недели');
    seen.add(id);
  }

  const candidates = new Map(
    sourceIds.length > 0
      ? (await loadCandidates(tx, weekly.objectId, sourceIds)).map((c) => [c.id, c] as const)
      : [],
  );
  // Чужое решение «уезжает» — второй источник негодности строки, и join'ом его брать нельзя:
  // применённых недель с таким решением по одному заказу бывает несколько (`loadLeftBy`).
  const leftBy = await loadLeftBy(tx, sourceIds, weekly.id);

  const rows: (typeof weeklyVehicleRequestItems.$inferInsert)[] = [];
  for (const [index, item] of items.entries()) {
    const base = {
      weeklyRequestId: weekly.id,
      weekStart: weekly.weekStart,
      position: index,
      comment: item.comment ?? '',
    };
    if (item.kind === 'new') {
      const classification = await loadClassificationFor(
        tx,
        item.vehicleTypeId,
        item.vehicleCategoryId ?? null,
      );
      const blocker = newItemBlocker(
        {
          vehicleTypeId: item.vehicleTypeId,
          vehicleCategoryId: item.vehicleCategoryId ?? null,
          dateFrom: item.dateFrom,
          dateTo: item.dateTo,
          responsibleName: item.responsibleName,
          responsiblePhone: item.responsiblePhone,
          deliveryNeeded: item.deliveryNeeded,
          deliveryFrom: item.deliveryFrom,
        },
        fullScope,
        classification,
      );
      if (blocker) throw err.unprocessable(`Строка ${index + 1}: ${blocker}`);
      rows.push({
        ...base,
        kind: 'new',
        vehicleTypeId: item.vehicleTypeId,
        vehicleCategoryId: item.vehicleCategoryId ?? null,
        dateFrom: item.dateFrom,
        dateTo: item.dateTo,
        responsibleName: item.responsibleName,
        responsiblePhone: item.responsiblePhone,
        deliveryNeeded: item.deliveryNeeded,
        deliveryFrom: item.deliveryFrom,
      });
      continue;
    }

    const candidate = candidates.get(item.sourceRequestId);
    // Сюда не попадает грузоперевозка: у неё нет детали срока, и `innerJoin` её отсекает. Ответ
    // тот же по существу — неделю собирают из заказов техники на объект.
    if (!candidate) {
      throw err.unprocessable(
        `Строка ${index + 1}: заказ техники не найден — неделю собирают из заказов на объект`,
      );
    }
    // Принадлежность объекту проверяется всегда и отдельно (`sourceItemBlocker` первым условием):
    // `source_request_id` — обычный внешний ключ, и без явной проверки клиент подсунул бы заказ
    // чужой площадки, а сервер продлил бы его.
    const order = candidateOrder(candidate, leftBy.get(candidate.id) ?? null);
    // `expected_date_to` читается из самого заказа, а не из тела: прими его сервер от клиента —
    // тот подменил бы контрольный снимок и провёл бы через визу продление заказа, срок которого
    // давно другой (план §7).
    const expectedDateTo = orderEffectiveDateTo(order);
    const blocker =
      item.kind === 'extend'
        ? extendBlocker(order, fullScope, null, item.dateTo)
        : sourceItemBlocker(order, fullScope, null);
    if (blocker) {
      throw err.unprocessable(
        `Строка ${index + 1} (${formatVehicleRequestNumber(candidate.num)}): ${blocker}`,
      );
    }
    rows.push(
      item.kind === 'extend'
        ? {
            ...base,
            kind: 'extend',
            sourceRequestId: item.sourceRequestId,
            dateTo: item.dateTo,
            expectedDateTo,
          }
        : {
            ...base,
            kind: 'leave',
            sourceRequestId: item.sourceRequestId,
            expectedDateTo,
          },
    );
  }
  return rows;
}

/** Состояние позиции классификатора для `newItemBlocker` — тем же справочником, что у формы. */
async function loadClassificationFor(
  tx: Tx,
  typeId: string,
  categoryId: string | null,
): Promise<{ typeIsActive: boolean; categoryIsActive: boolean | null; hasCategories: boolean }> {
  const [type] = await tx
    .select({ isActive: vehicleTypes.isActive })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, typeId));
  const categories = await tx
    .select({ id: vehicleCategories.id, isActive: vehicleCategories.isActive })
    .from(vehicleCategories)
    .where(eq(vehicleCategories.vehicleTypeId, typeId));
  const chosen = categoryId ? categories.find((c) => c.id === categoryId) : undefined;
  return {
    typeIsActive: !!type?.isActive,
    hasCategories: categories.some((c) => c.isActive),
    categoryIsActive: categoryId ? !!chosen?.isActive : null,
  };
}

/** Переписать состав целиком и поднять версию. Массив переписывается, а не правится построчно. */
async function replaceItems(
  tx: Tx,
  weekly: { id: string; objectId: string; weekStart: string },
  items: WeeklyRequestItemInput[],
): Promise<void> {
  const rows = await buildItemRows(tx, weekly, items);
  await tx
    .delete(weeklyVehicleRequestItems)
    .where(eq(weeklyVehicleRequestItems.weeklyRequestId, weekly.id));
  if (rows.length > 0) await tx.insert(weeklyVehicleRequestItems).values(rows);
}

/**
 * Неделя, на которую заявку заводить нельзя, — 422 с объяснением, а не молчаливое выравнивание.
 *
 * Субъект спрашивается ради режима прошлого (ADR 0101): просроченную неделю открывает право
 * `waybills.correct`, и в пределах его глубины заявку на неё заводят, правят и подают наравне с
 * будущей. Причины и записи в журнал здесь не спрашивается — заведение и подача ничего не двигают,
 * и объяснение у них было бы объяснением намерения. Всё, что о прошлом, спрашивается на визе.
 */
function assertWeekAllowed(weekStart: string, p: Principal): void {
  const blocker = weeklyWeekBlocker(
    weekStart,
    moscowDateKeyOf(new Date()),
    WEEKLY_SELECTABLE_WEEKS,
    backdateAccessOf(p),
  );
  if (blocker) throw err.unprocessable(blocker, { weekStart: blocker });
}

/**
 * Итог применения, вынесенный из транзакции. Объектом, а не парой `let`: присваивание идёт внутри
 * замыкания, и по обычной переменной анализ типов видел бы только её начальный `null`.
 */
type WeeklyApplyOutcome = Awaited<ReturnType<typeof applyWeeklyRequest>>;
interface ApplyOutcomeHolder {
  apply: WeeklyApplyResultDto | null;
  esm2: WeeklyApplyOutcome['esm2'];
}

/**
 * Аудит переписанной бумаги — после транзакции и по каждому затронутому заказу: сгоревший номер
 * бланка строгой отчётности не должен объясняться только строкой в ответе.
 */
async function auditWeeklyEsm2(
  actorUserId: string,
  esm2: WeeklyApplyOutcome['esm2'],
): Promise<void> {
  for (const e of esm2) {
    await auditEsm2Sync({
      actorUserId,
      requestId: e.requestId,
      reason: 'weekly_request',
      result: e.sync,
    });
  }
}

/**
 * События истории **заказов**, которых коснулось применение (Р6).
 *
 * Пишутся отдельно от аудита самой недельной заявки и по каждому заказу: человек, открывший
 * карточку заказа, должен прочесть, почему у него сдвинулся срок, — иначе дата меняется будто
 * сама собой, а решение об этом принималось в чужом документе.
 *
 * Ветка снятого запроса на отъезд остаётся при том, что недельная заявка его больше не снимает
 * (единица с нерешённым запросом в состав не идёт): она следует ответу общего сервиса правки
 * срока, а не собственному знанию, — и если снятие однажды придёт оттуда, история заказа не
 * промолчит там, где обычная правка говорит.
 */
async function auditWeeklyOrderEvents(
  actorUserId: string,
  weeklyNum: number,
  apply: WeeklyApplyResultDto | null,
): Promise<void> {
  if (!apply) return;
  const number = formatWeeklyRequestNumber(weeklyNum);
  for (const item of apply.items) {
    if (!item.requestId) continue;
    if (item.result === 'extended') {
      await writeAudit({
        actorUserId,
        action: 'vehicle_request.weekly_extend',
        entityType: 'vehicle_request',
        entityId: item.requestId,
        metadata: {
          weeklyRequest: number,
          changes: weeklyExtendChanges(number, item.previousDateTo, item.newDateTo),
        },
      });
    }
    if (item.earlyEndDropped) {
      await writeAudit({
        actorUserId,
        action: 'vehicle_request.early_end_cancel',
        entityType: 'vehicle_request',
        entityId: item.requestId,
        metadata: {
          reason: 'weekly',
          changes: earlyEndReasonChange(`Срок продлён недельной заявкой ${number}`),
        },
      });
    }
  }
}

// ── Чек-лист готовности недели (§5 шаг 6) ──

const CELL_NONE: WeeklyDocumentCellDto = { state: 'none', number: null, text: '—' };
const CELL_LESSOR: WeeklyDocumentCellDto = {
  state: 'lessor',
  number: null,
  text: 'Ведёт арендодатель',
};

function kindSuffix(row: ItemRow): string {
  if (row.result === 'skipped') return 'пропущена';
  return weeklyItemKindLabels[row.kind].toLowerCase();
}

/**
 * Клетка ЭСМ-2: лист недели заявки. Ищется по `weekStartKey(period_from) = week_start`, а не по
 * равенству понедельнику: у заказа, начавшегося в среду, первый период начинается со среды.
 */
function esm2Cell(
  row: ItemRow,
  weekStart: string,
  sheets: Map<string, { weekStart: string; number: string }[]>,
): WeeklyDocumentCellDto {
  if (row.kind === 'leave' || row.result === 'skipped') return CELL_NONE;
  const requestId = row.sourceRequestId ?? row.createdRequestId;
  if (!requestId) return CELL_NONE;
  if (row.ownership && row.ownership !== 'own') return CELL_LESSOR;
  if (!row.currentVehicleId) {
    return { state: 'awaiting', number: null, text: 'Будет при назначении' };
  }
  const sheet = (sheets.get(requestId) ?? []).find((s) => s.weekStart === weekStart);
  if (!sheet) return { state: 'awaiting', number: null, text: 'Будет при назначении' };
  return { state: 'issued', number: sheet.number, text: `№ ${sheet.number}` };
}

/**
 * Клетка перегона: доставка новой техники и вывоз уезжающей (план Р10, Р11). Продление перегона не
 * задевает вовсе — машина уже на площадке.
 */
function relocationCell(
  row: ItemRow,
  routes: Map<string, { purpose: string; number: string | null }[]>,
): WeeklyDocumentCellDto {
  if (row.kind === 'extend' || row.result === 'skipped') return CELL_NONE;
  if (row.kind === 'new' && !row.deliveryNeeded) return CELL_NONE;
  if (row.ownership && row.ownership !== 'own') return CELL_LESSOR;
  const requestId = row.sourceRequestId ?? row.createdRequestId;
  if (!requestId) return CELL_NONE;
  const wanted = row.kind === 'leave' ? 'pickup' : 'delivery';
  const trip = (routes.get(requestId) ?? []).find((t) => t.purpose === wanted);
  if (!trip) {
    return {
      state: 'missing',
      number: null,
      text: row.kind === 'leave' ? 'Вывоз не оформлен' : 'Доставка запрошена, рейса нет',
    };
  }
  if (!trip.number)
    return { state: 'awaiting', number: null, text: 'Рейс заведён, лист не выписан' };
  return { state: 'issued', number: trip.number, text: `№ ${trip.number}` };
}

export default async function weeklyVehicleRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const auth = { preHandler: [app.authenticate, app.requirePermission('weeklyRequests.read')] };
  const canCreate = {
    preHandler: [app.authenticate, app.requirePermission('weeklyRequests.create')],
  };
  const canUpdate = {
    preHandler: [app.authenticate, app.requirePermission('weeklyRequests.update')],
  };
  /*
   * Решение по заявке — виза либо отказ. Страж пропускает всякого, кому виден модуль, а само право
   * спрашивает обработчик, и это не послабление, а единственный способ выразить правило.
   *
   * Прав у визы два, и какое из них требуется, решает **неделя заявки**: у будущей —
   * `weeklyRequests.approve` (руководитель строительства, как и было), у просроченной — право
   * прошлого `waybills.correct` (ADR 0101; фактически диспетчер и администратор). Страж маршрута
   * умеет только конъюнкцию, а «одно или другое, смотря какая неделя» ею не пишется: жёсткое
   * `weeklyRequests.approve` закрыло бы просроченную неделю ровно тому, кто её и проводит, а
   * жёсткое `waybills.correct` отняло бы обычную визу у площадки. Выбор живёт в контрактах
   * (`weeklyApprovalPermission`) и спрашивается предикатом `canApproveWeeklyRequest` — вместе с
   * областью, которую страж всё равно не проверяет.
   */
  const canDecide = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'weeklyRequests.read',
        'Недельные заявки этой учётке не видны — визировать нечего',
      ),
    ],
  };

  /**
   * Область видимости списка — тем же переводом, которым фильтруется лента раздела и проверяется
   * доступ к карточке (`services/weekly-request-access.ts`). Своего условия здесь нет намеренно:
   * два похожих разошлись бы молча, и разошлись бы в сторону «в списке видно, а по ссылке 404».
   */
  // ── Списка у модуля нет ──
  //
  // Недельная заявка живёт строкой в общем списке «Заказ автотехники» (ADR 0089), и своей выдачи
  // у неё не осталось: два маршрута, отвечающих на один вопрос «какие недели я вижу», разошлись бы
  // фильтрами и областью — а расхождение здесь означает либо строку, видимую в списке и закрытую
  // по ссылке, либо обратное. Ленту отдаёт `GET /vehicle-requests/feed`, состав ей собирает
  // `loadWeeklyDtosByIds` ниже — тем же сборщиком, что и карточку.

  // ── Предложение состава (план Р4, преемственность недель — план «Отбор состава» §3) ──
  r.get(
    '/suggestion',
    { ...canCreate, schema: { querystring: suggestionQuerySchema } },
    async (req): Promise<WeeklySuggestionDto> => {
      const p = requirePrincipal(req);
      const { objectId, weekStart } = req.query;
      assertWeeklyRequestScope(p, objectId);
      assertWeekAllowed(weekStart, p);

      const scope = scopeOf({ objectId, weekStart }, moscowDateKeyOf(new Date()));
      const [existing] = await db
        .select({ id: weeklyVehicleRequests.id })
        .from(weeklyVehicleRequests)
        .where(
          and(
            eq(weeklyVehicleRequests.objectId, objectId),
            eq(weeklyVehicleRequests.weekStart, scope.weekStart),
            ne(weeklyVehicleRequests.status, 'cancelled'),
          ),
        );

      // Источников кандидатов два, и второй — не удобство, а правило: каждая следующая недельная
      // заявка пытается продлить **все** позиции прошлой. Срез площадки один этого не даёт —
      // позиция, вышедшая из среза (закрыта фактом, отменена, откачена в «Новую», потеряла
      // назначение), до предикатов бы не дошла и исчезла бы из сборки молча, ни в `blocked`, ни
      // где-либо ещё.
      const previous = await loadPreviousApplied(objectId, scope.weekStart);
      const snapshot = await loadCandidates(db, objectId);
      const known = new Set(snapshot.map((c) => c.id));
      const carriedIds = [...(previous?.orders.keys() ?? [])].filter((id) => !known.has(id));
      const candidates =
        carriedIds.length > 0
          ? [...snapshot, ...(await loadCandidates(db, objectId, carriedIds))].sort(
              (a, b) => a.num - b.num,
            )
          : snapshot;
      const leftBy = await loadLeftBy(
        db,
        candidates.map((c) => c.id),
        existing?.id ?? null,
      );

      // Решения, уже принятые в собираемой заявке: строка «уезжает» показывается своим блоком, а
      // не предлагается к продлению повторно.
      const leaving = new Set<string>();
      if (existing) {
        const decided = await db
          .select({ sourceRequestId: weeklyVehicleRequestItems.sourceRequestId })
          .from(weeklyVehicleRequestItems)
          .where(
            and(
              eq(weeklyVehicleRequestItems.weeklyRequestId, existing.id),
              eq(weeklyVehicleRequestItems.kind, 'leave'),
            ),
          );
        for (const d of decided) if (d.sourceRequestId) leaving.add(d.sourceRequestId);
      }
      const otherWeekly = await loadOtherWeekly(
        candidates.map((c) => ({ sourceRequestId: c.id, weeklyRequestId: existing?.id ?? '' })),
      );

      const result: WeeklySuggestionDto = {
        objectId,
        weekStart: scope.weekStart,
        weekEnd: scope.weekEnd,
        weekLabel: weeklyWeekLabel(scope.weekStart),
        extend: [],
        leaving: [],
        beyond: [],
        blocked: [],
        previous: null,
        existingRequestId: existing?.id ?? null,
      };
      /** Позиции прошлой недели, не доехавшие до состава, — каждая с причиной (план §3 п. 3). */
      const dropped: WeeklyPreviousWeekDto['dropped'] = [];
      let carried = 0;
      for (const c of candidates) {
        const order = candidateOrder(c, leftBy.get(c.id) ?? null);
        const dto = candidateDto(c, order, scope, otherWeekly.get(c.id) ?? null);
        const fromPrevious = previous?.orders.has(c.id) ?? false;
        const blocker = sourceItemBlocker(order, scope, null);
        if (blocker) {
          // Заказ, заказанный **дальше** недели, — не негодность, а отдельный список: решать по
          // нему на этой неделе нечего, и в шапке формы он считается строкой «ещё 3 единицы
          // заказаны дольше недели». Отделяется по причине, а не по одному сроку: заказ чужой
          // площадки или без назначения — это `blocked`, каким бы длинным ни был его срок.
          // Проверяется тем же предикатом с концом срока, приведённым к воскресенью: годен во
          // всём, кроме собственной длины, — значит «дольше недели», иначе «не годится».
          const onlyTooLong =
            orderEffectiveDateTo(order) > scope.weekEnd &&
            sourceItemBlocker({ ...order, dateTo: scope.weekEnd }, scope, null) === null;
          if (onlyTooLong) result.beyond.push(dto);
          else {
            result.blocked.push({
              requestId: c.id,
              displayNumber: formatVehicleRequestNumber(c.num),
              reason: blocker,
            });
          }
          if (fromPrevious) dropped.push({ displayNumber: dto.displayNumber, reason: blocker });
          continue;
        }
        if (fromPrevious) carried += 1;
        if (leaving.has(c.id)) result.leaving.push({ ...dto, included: false });
        else result.extend.push(dto);
      }
      if (previous) {
        // Позиция, которой не нашлось даже в выборке по идентификаторам: заказ снесён насовсем.
        // Практически недостижимо — `ON DELETE RESTRICT` не даёт `purge` тронуть заказ,
        // на который ссылается применённая заявка, — но молчать об этом всё равно нельзя.
        const seen = new Set(candidates.map((c) => c.id));
        for (const [requestId, num] of previous.orders) {
          if (seen.has(requestId)) continue;
          dropped.push({
            displayNumber: formatVehicleRequestNumber(num),
            reason: 'Заказ удалён из портала',
          });
        }
        result.previous = {
          weeklyRequestId: previous.id,
          num: previous.num,
          weekLabel: weeklyWeekLabel(previous.weekStart),
          carried,
          dropped,
        };
      }
      return result;
    },
  );

  // ── Заведение черновика ──
  r.post('/', { ...canCreate, schema: { body: createWeeklyRequestSchema } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const body = req.body;
    assertWeeklyRequestScope(p, body.objectId);
    assertWeekAllowed(body.weekStart, p);

    const [existing] = await db
      .select({ id: weeklyVehicleRequests.id, num: weeklyVehicleRequests.num })
      .from(weeklyVehicleRequests)
      .where(
        and(
          eq(weeklyVehicleRequests.objectId, body.objectId),
          eq(weeklyVehicleRequests.weekStart, body.weekStart),
          ne(weeklyVehicleRequests.status, 'cancelled'),
        ),
      );
    // Одна заявка на пару «объект + неделя» (план Р3): две означали бы два состава, которые при
    // согласовании подерутся за один и тот же заказ. Ответ называет существующую — кнопка
    // открывает её, а не заводит вторую.
    if (existing) {
      throw err.conflict(
        `Заявка ${formatWeeklyRequestNumber(existing.num)} на эту неделю уже собирается — откройте её`,
      );
    }

    const createdId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(weeklyVehicleRequests)
        .values({
          objectId: body.objectId,
          weekStart: body.weekStart,
          status: 'draft',
          comment: body.comment,
          createdBy: p.id,
        })
        .returning({ id: weeklyVehicleRequests.id, num: weeklyVehicleRequests.num });
      const created = row!;
      await replaceItems(
        tx,
        { id: created.id, objectId: body.objectId, weekStart: body.weekStart },
        body.items,
      );
      await tx.insert(weeklyVehicleRequestHistory).values({
        weeklyRequestId: created.id,
        event: 'status',
        fromStatus: null,
        toStatus: 'draft',
        changedBy: p.id,
        payload: { items: body.items.length },
      });
      return created.id;
    });

    await writeAudit({
      actorUserId: p.id,
      action: 'weekly_request.create',
      entityType: 'weekly_vehicle_request',
      entityId: createdId,
      metadata: { objectId: body.objectId, weekStart: body.weekStart, items: body.items.length },
    });
    reply.code(201);
    return (await getDto(createdId))!;
  });

  // ── Карточка ──
  //
  // Доступ спрашивается не по площадке, а тем же предикатом, что фильтрует список: у арендодателя
  // область выражается составом заявки, и синхронная проверка по `objectId` её не выражает вовсе.
  // Ответ на «не видно» — 404: для наблюдателя, отдела и арендодателя сам факт существования
  // недели у чужой площадки тоже не их дело (внятный отказ остался на правке и визе).
  r.get('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    await assertWeeklyRequestReadable(p, req.params.id);
    const dto = await getDto(req.params.id, p);
    if (!dto) throw err.notFound('Недельная заявка не найдена');
    return dto;
  });

  // ── Правка состава ──
  r.patch(
    '/:id',
    { ...canUpdate, schema: { params: idParams, body: updateWeeklyRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const header = await requireHeader(req.params.id);
      assertWeeklyRequestScope(p, header.objectId);
      if (!isWeeklyRequestEditable(header.status)) {
        throw err.unprocessable('Применённая заявка не правится — она уже стала историей');
      }
      // Третья точка проверки недели: черновик, заведённый в четверг, доживает до понедельника.
      assertWeekAllowed(header.weekStart, p);

      await db.transaction(async (tx) => {
        await replaceItems(tx, header, body.items);
        const [updated] = await tx
          .update(weeklyVehicleRequests)
          .set({
            comment: body.comment ?? header.comment,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: header.version + 1,
          })
          .where(
            and(
              eq(weeklyVehicleRequests.id, header.id),
              eq(weeklyVehicleRequests.version, body.version),
            ),
          )
          .returning({ id: weeklyVehicleRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(weeklyVehicleRequestHistory).values({
          weeklyRequestId: header.id,
          event: 'items_changed',
          changedBy: p.id,
          payload: { items: body.items.length },
        });
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'weekly_request.update',
        entityType: 'weekly_vehicle_request',
        entityId: header.id,
        metadata: { items: body.items.length },
      });
      return (await getDto(header.id))!;
    },
  );

  // ── Подать / снять ──
  /**
   * Два перехода составителя. Подача проверяет неделю (черновик мог пролежать до понедельника) и
   * непустой состав; снятие не проверяет ничего, кроме статуса: снять с рассмотрения нужно уметь
   * всегда, в том числе просроченную заявку (план §8).
   *
   * Подача тем, кто эту заявку и визирует, применяет её сразу (план Р8) — как автовиза заявки ТС.
   */
  r.post(
    '/:id/status',
    { ...canUpdate, schema: { params: idParams, body: weeklyRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const header = await requireHeader(req.params.id);
      assertWeeklyRequestScope(p, header.objectId);
      if (!isWeeklyRequestEditable(header.status)) {
        throw err.unprocessable(
          header.status === 'applied'
            ? 'Применённая заявка не снимается: сроки сокращают досрочным завершением по каждой машине'
            : 'Заявка уже снята',
        );
      }
      if (body.status === 'pending' && header.status !== 'draft') {
        throw err.unprocessable('Заявка уже подана на визу');
      }

      const [itemCount] = await db
        .select({ c: count() })
        .from(weeklyVehicleRequestItems)
        .where(eq(weeklyVehicleRequestItems.weeklyRequestId, header.id));
      if (body.status === 'pending') {
        assertWeekAllowed(header.weekStart, p);
        if (Number(itemCount!.c) === 0) {
          throw err.unprocessable('Решение не принято ни по одной единице — состав пуст');
        }
      }

      // Просроченная неделя подачей не применяется никогда (см. `approvesOwnWeeklyRequest`): её
      // проведение требует причины и ключа операции, а в теле подачи их нет и быть не должно.
      // Такая заявка спокойно доходит до визы, где всё это спрашивается явно.
      const selfApplies =
        body.status === 'pending' &&
        approvesOwnWeeklyRequest(p, header.objectId, {
          weekStart: header.weekStart,
          today: moscowDateKeyOf(new Date()),
        });
      const outcome: ApplyOutcomeHolder = { apply: null, esm2: [] };

      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(weeklyVehicleRequests)
          .set({
            status: body.status,
            cancelReason: body.status === 'cancelled' ? body.reason : header.cancelReason,
            updatedBy: p.id,
            updatedAt: new Date(),
            version: header.version + 1,
          })
          .where(
            and(
              eq(weeklyVehicleRequests.id, header.id),
              eq(weeklyVehicleRequests.version, body.version),
            ),
          )
          .returning({ id: weeklyVehicleRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(weeklyVehicleRequestHistory).values({
          weeklyRequestId: header.id,
          event: 'status',
          fromStatus: header.status,
          toStatus: body.status,
          changedBy: p.id,
          comment: body.reason,
        });
        if (!selfApplies) return;
        // Виза применяет заявку той же транзакцией: состояния «завизировано, но сроки прежние» не
        // бывает. Версия — только что записанная: сервис сверяет её под собственной блокировкой.
        const applied = await applyWeeklyRequest(tx, {
          weeklyRequestId: header.id,
          expectedVersion: header.version + 1,
          actor: { id: p.id },
        });
        outcome.apply = applied.result;
        outcome.esm2 = applied.esm2;
      });

      await writeAudit({
        actorUserId: p.id,
        action: selfApplies ? 'weekly_request.approve' : `weekly_request.${body.status}`,
        entityType: 'weekly_vehicle_request',
        entityId: header.id,
        metadata: { status: body.status, reason: body.reason, auto: selfApplies || undefined },
      });
      await auditWeeklyEsm2(p.id, outcome.esm2);
      await auditWeeklyOrderEvents(p.id, header.num, outcome.apply);
      return { request: (await getDto(header.id))!, apply: outcome.apply };
    },
  );

  // ── Виза либо отказ; виза применяет (план Р6) ──
  /**
   * Виза применяет заявку той же транзакцией — и этим же маршрутом идёт проведение **просроченной**
   * недели задним числом (ADR 0101).
   *
   * Второго маршрута под просроченную неделю нет намеренно: действие человека одно — «завизировать
   * и провести», — и разведя его по двум ручкам, портал получил бы две кнопки на одно решение, а
   * отказ «не та ручка» вместо отказа по существу. Различие целиком в том, что просроченная неделя
   * добавляет: другое право (`weeklyApprovalPermission`), обязательный блок `correction`, вердикт
   * `backdateGuard` по воскресенью недели и запись операции. Обычной неделе не достаётся ни одного
   * лишнего запроса.
   */
  r.post(
    '/:id/approval',
    { ...canDecide, schema: { params: idParams, body: approveWeeklyRequestSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const body = req.body;
      const header = await requireHeader(req.params.id);
      assertWeeklyRequestScope(p, header.objectId);
      const today = moscowDateKeyOf(new Date());
      const week = { weekStart: header.weekStart, today };
      const overdue = isWeeklyWeekOverdue(header.weekStart, today);
      /*
       * Право на маршруте общее (`weeklyRequests.read`), а решает предикат: у будущей недели —
       * руководитель этой площадки, у просроченной — тот, у кого есть право прошлого. Замена права
       * живёт в контрактах (`weeklyApprovalPermission`), и тем же выбором портал решает, показывать
       * ли кнопку: страж маршрута выразить «одно право или другое, смотря какая неделя» не может, а
       * жёсткое `weeklyRequests.approve` на нём закрыло бы просроченную неделю тому единственному,
       * кто её и проводит.
       *
       * Замена права касается **визы**, а не решения вообще. Отказ ничего в прошлом не двигает: он
       * возвращает заявку в черновик, чтобы площадка правила состав, — и спрашивать за него право
       * коррекции значило бы отдать отказ по просроченной неделе диспетчеру, то есть тому, кто про
       * нужность техники на объекте как раз и не решает. Поэтому у отказа правило прежнее и
       * недели не знает: руководитель строительства этой площадки отклоняет любую свою заявку,
       * хотя провести просроченную уже не вправе.
       */
      const decidesWeek = body.approved ? week : undefined;
      if (!canApproveWeeklyRequest(p, header.objectId, decidesWeek)) {
        throw err.forbidden(
          overdue && body.approved
            ? `Неделя ${weeklyWeekLabel(header.weekStart)} уже ${header.weekStart < weekStartKey(today) ? 'прошла' : 'началась'}: проводит её тот, у кого есть право коррекции задним числом, — обратитесь к диспетчеру или администратору`
            : 'Недельную заявку визирует руководитель этой площадки',
        );
      }
      // Блок коррекции и просроченность обязаны совпасть в обе стороны. Нет блока у просроченной —
      // операция прошла бы без причины и без следа; есть блок у будущей — в журнале коррекций
      // появилась бы строка про обычную работу, и фильтр журнала (Р28 ADR 0101) наполнился бы ею.
      const correction = body.approved ? body.correction : undefined;
      if (body.approved && overdue && !correction) {
        throw err.unprocessable(WEEKLY_CORRECTION_REQUIRED_MESSAGE, {
          correction: 'Нужна причина и ключ операции',
        });
      }
      if (correction && !overdue) {
        throw err.unprocessable(
          `Неделя ${weeklyWeekLabel(header.weekStart)} ещё не наступила — корректировать в ней нечего, визируйте без блока коррекции`,
          { correction: 'Неделя не просрочена' },
        );
      }

      /*
       * Повтор уже выполненной операции узнаётся **до** проверки состояния, и здесь это не
       * оптимизация, а условие идемпотентности вообще (Р31 ADR 0101). Виза переводит заявку
       * `pending → applied`, то есть первая же попытка делает состояние непригодным для второй:
       * ретрай после обрыва связи упёрся бы в «недельная заявка уже применена» — отказ на работу,
       * которая на самом деле сделана его же собственным запросом. Найденный ключ снимает эту
       * проверку и только её: автора с отпечатком сверит `runCorrection`, а `perform` не позовётся
       * вовсе.
       */
      const prior = correction ? await findCorrection(db, correction.operationId) : undefined;
      if (!prior && header.status !== 'pending') {
        throw err.unprocessable(
          header.status === 'applied'
            ? 'Недельная заявка уже применена'
            : 'Визируется только заявка, поданная на визу',
        );
      }

      const outcome: ApplyOutcomeHolder = { apply: null, esm2: [] };
      /** Что субъекту позволено задним числом: пятая точка проверки недели считает глубину им. */
      const access = backdateAccessOf(p);
      /**
       * Эффективная дата операции — воскресенье недели заявки. Той же границей `canCancelWaybill`
       * считает лист ЭСМ-2 отработанным, и второй расчёт «когда неделя кончилась» разошёлся бы с
       * первым на шесть дней.
       *
       * Плана до неё, в отличие от коррекции назначения, не нужно вовсе: там эффективную дату
       * задавал самый ранний из задетых листов, и на повторе её было уже не пересчитать, — а здесь
       * она известна из шапки и одинакова на любой попытке.
       */
      const effectiveDate = weeklyWeekEffectiveDate(header.weekStart);
      /**
       * Проверка доступа функцией, а не разово: `runCorrection` зовёт её сам на каждой попытке,
       * включая повтор, — там это единственная проверка доступа, какая вообще случится (Р31
       * ADR 0101). Возвращает `backdated` — задним ли числом идёт операция.
       */
      const authorize = (): boolean => {
        if (!canApproveWeeklyRequest(p, header.objectId, week)) {
          throw err.forbidden(BACKDATE_PERMISSION_MESSAGE);
        }
        /*
         * На повторе спрашивается только право — и спрашивается всегда: молча отдать прежний
         * результат тому, у кого `waybills.correct` успели отобрать между попытками, — та же
         * утечка, что провести неделю без права. Предел дней при этом остаётся проверенным первой
         * попыткой: второй раз он ничего нового не разрешает, потому что и работы второй раз не
         * происходит, — а пересчитанный назавтра он отказал бы в результате, который уже получен.
         */
        if (prior) return false;
        return backdateOrThrow(
          checkBackdate({
            effectiveDate,
            today,
            subject: p,
            hasReason: (correction?.reason ?? '').trim() !== '',
          }),
        );
      };
      /** Задним ли числом идёт операция: у начавшейся, но не кончившейся недели — нет. */
      let backdated = false;
      /** true — эту же команду уже выполнил этот же запрос: сроки второй раз не двигались. */
      let repeated = false;

      if (correction) {
        backdated = authorize();
        const done = await runCorrection(
          {
            operationId: correction.operationId,
            kind: 'weekly',
            // Целью служит сама недельная заявка: тело визы одинаково у двух разных недель одной
            // площадки, и без идентификатора один ключ покрыл бы две разные команды.
            target: header.id,
            body: req.body,
            reason: correction.reason,
            actorUserId: p.id,
          },
          {
            authorize,
            perform: async (tx, record) => {
              const applied = await applyWeeklyRequest(tx, {
                weeklyRequestId: header.id,
                expectedVersion: body.version,
                actor: { id: p.id },
                correction: {
                  id: record.id,
                  access,
                  reason: correction.reason,
                  unlockWaybillIds: correction.unlockWaybillIds,
                },
              });
              outcome.apply = applied.result;
              outcome.esm2 = applied.esm2;
              // «Что делали с этим заказом задним числом» спрашивают со стороны заказа, и связь
              // операции с ним — единственный ответ (Р16 ADR 0101). Порождённые строкой `new`
              // заказы связываются наравне с продлёнными: их дата начала тоже в прошлом.
              await linkCorrectionRequests(
                tx,
                record.id,
                applied.result.items.flatMap((i) => (i.requestId ? [i.requestId] : [])),
              );
              /*
               * Снимок «было → стало» (Р16 ADR 0101). Строки итога уходят сюда целиком: в самой
               * заявке остаются только результаты, а «какой срок был у ТС-341 до проведения» и
               * «какие номера сгорели» спрашивают через месяцы — и ответить на это будет нечем.
               */
              return {
                weeklyRequest: { id: header.id, num: header.num },
                week: { start: header.weekStart, end: weeklyWeekBounds(header.weekStart).to },
                applied: applied.result.applied,
                skipped: applied.result.skipped,
                items: applied.result.items,
                esm2: applied.result.esm2,
                unlockWaybillIds: correction.unlockWaybillIds,
              };
            },
          },
        );
        repeated = done.repeated;
      } else {
        await db.transaction(async (tx) => {
          if (body.approved) {
            const applied = await applyWeeklyRequest(tx, {
              weeklyRequestId: header.id,
              expectedVersion: body.version,
              actor: { id: p.id },
            });
            outcome.apply = applied.result;
            outcome.esm2 = applied.esm2;
            return;
          }
          // Отклонённая возвращается в черновик, а причина показывается сверху в самой заявке: тому,
          // кто открыл её править, надо видеть, что именно не устроило.
          const [updated] = await tx
            .update(weeklyVehicleRequests)
            .set({
              status: 'draft',
              updatedBy: p.id,
              updatedAt: new Date(),
              version: header.version + 1,
            })
            .where(
              and(
                eq(weeklyVehicleRequests.id, header.id),
                eq(weeklyVehicleRequests.version, body.version),
              ),
            )
            .returning({ id: weeklyVehicleRequests.id });
          if (!updated) throw err.conflict();
          await tx.insert(weeklyVehicleRequestHistory).values({
            weeklyRequestId: header.id,
            event: 'status',
            fromStatus: 'pending',
            toStatus: 'draft',
            changedBy: p.id,
            comment: body.comment,
          });
        });
      }

      /*
       * Повтор не порождает ни второго события в ленте, ни второй записи истории заказов: работа
       * сделана первой попыткой, а итог применения лежит в самих строках состава — карточка
       * покажет его тем же DTO. `apply` в ответе при этом пуст, и это честно: пересказывать
       * прошлый итог по нынешнему состоянию значило бы выдумать его заново.
       */
      if (repeated) return { request: (await getDto(header.id))!, apply: null };

      await writeAudit({
        actorUserId: p.id,
        action: body.approved ? 'weekly_request.approve' : 'weekly_request.reject',
        entityType: 'weekly_vehicle_request',
        entityId: header.id,
        metadata: body.approved
          ? {
              applied: outcome.apply?.applied ?? 0,
              skipped: outcome.apply?.skipped ?? 0,
              // Признаки заднего числа — только там, где оно было: у обычной визы пустые поля в
              // ленте читались бы как «коррекция без причины». `backdated` при этом не равен
              // «неделя просрочена»: у начавшейся недели воскресенье ещё впереди, операция идёт
              // сегодняшним днём, а причина и ключ у неё всё равно спрошены.
              ...(correction
                ? {
                    overdueWeek: true,
                    backdated,
                    reason: correction.reason,
                    operationId: correction.operationId,
                    unlockWaybillIds: correction.unlockWaybillIds,
                  }
                : {}),
            }
          : { comment: body.comment },
      });
      await auditWeeklyEsm2(p.id, outcome.esm2);
      await auditWeeklyOrderEvents(p.id, header.num, outcome.apply);
      return { request: (await getDto(header.id))!, apply: outcome.apply };
    },
  );

  // ── Что проведение этой недели тронет в прошлом (предпросмотр) ──
  /**
   * Читающая половина визы просроченной недели: те же правила теми же функциями, но без единой
   * правки. Окно показывает ею цену операции — какие номера ЭСМ-2 можно назвать к перевыписке, за
   * какие прошедшие недели появится бумага, какая у операции эффективная дата и докуда достаёт
   * глубина субъекта, — и её запреты, если провести неделю нельзя.
   *
   * Расхождение предпросмотра и исполнения здесь недопустимо: диалог обещает человеку сгоревшие
   * номера, и обещание верно ровно до тех пор, пока считает его та же работа. Поэтому ни одного
   * своего расчёта тут нет — `weeklyWeekBlocker`, `weeklyWeekEffectiveDate`, `checkBackdate`,
   * `esm2CorrectionScope` и `canCancelWaybill` те же, что на визе и в сверке.
   *
   * Доступ — по чтению карточки: понять, почему кнопка недоступна, должен и тот, кто провести
   * неделю не вправе. Ответ на этот вопрос лежит в полях `allowed` и `blockedReason`, а не в
   * отказе маршрута: 403 объяснил бы отсутствие права, но не то, что делать дальше.
   */
  r.get(
    '/:id/correction',
    { ...auth, schema: { params: idParams } },
    async (req): Promise<WeeklyCorrectionPreviewDto> => {
      const p = requirePrincipal(req);
      await assertWeeklyRequestReadable(p, req.params.id);
      const header = await requireHeader(req.params.id);
      // Момент времени берётся один раз на весь ответ: полночь между двумя `new Date()` дала бы
      // окну сегодняшний день от одной границы и вчерашний от другой.
      const now = new Date();
      const today = moscowDateKeyOf(now);
      const week = { weekStart: header.weekStart, today };
      const access = backdateAccessOf(p);
      const bounds = weeklyWeekBounds(header.weekStart);
      const effectiveDate = weeklyWeekEffectiveDate(header.weekStart);

      /*
       * Почему провести нельзя — по одной причине и в том же порядке, в каком откажет виза: сперва
       * право (его не исправить ничем, что человек допишет в форму), потом сама неделя (глубина и
       * границы), потом состояние документа. Обратный порядок предложил бы площадке искать
       * причину в неделе там, где верный ответ — «это не ваше действие».
       */
      const allowed = canApproveWeeklyRequest(p, header.objectId, week);
      const weekBlocker = weeklyWeekBlocker(
        header.weekStart,
        today,
        WEEKLY_SELECTABLE_WEEKS,
        access,
      );
      const blockedReason = !allowed
        ? isWeeklyWeekOverdue(header.weekStart, today)
          ? 'Просроченную неделю проводит тот, у кого есть право коррекции задним числом'
          : 'Недельную заявку визирует руководитель этой площадки'
        : (weekBlocker ??
          (header.status === 'pending'
            ? null
            : header.status === 'applied'
              ? 'Недельная заявка уже применена'
              : 'Визируется только заявка, поданная на визу'));

      // Строки состава — тем же сужением, что и карточка: чек-лист и предпросмотр рассказывают об
      // одних и тех же заказах, и второй отбор открыл бы арендодателю чужие листы площадки.
      const rows = await itemsQuery()
        .where(
          and(eq(weeklyVehicleRequestItems.weeklyRequestId, header.id), weeklyItemsReadWhere(p)),
        )
        .orderBy(asc(weeklyVehicleRequestItems.position));

      const unlockable: WeeklyCorrectionSheetDto[] = [];
      const pastWeeks: WeeklyCorrectionWeekDto[] = [];
      for (const row of rows) {
        // Бумагу двигает только продление: «уезжает» с заказом не делает ничего, а порождённый
        // строкой `new` заказ рождается без назначения — листов у него нет и быть не может.
        if (row.kind !== 'extend' || !row.sourceRequestId || !row.dateTo) continue;
        const displayNumber = row.sourceRequestNum
          ? formatVehicleRequestNumber(row.sourceRequestNum)
          : '';
        const scope = await esm2CorrectionScope(db, {
          requestId: row.sourceRequestId,
          today,
          // Срок, каким он станет: продление и добавляет заказу те прошедшие недели, о которых
          // окно рассказывает. По нынешнему `date_to` их не видно вовсе.
          dateTo: row.dateTo,
        });
        for (const sheet of scope.sheets) {
          // Назвать можно ровно отработанный лист: действующий лист незакончившейся недели сверка
          // переоформит сама, и разрешения на это не спрашивают. Граница — `canCancelWaybill`, та
          // же, которой `esm2SyncPlan` запирает неделю.
          const worked = !canCancelWaybill(
            { issuedForDate: sheet.periodFrom, periodTo: sheet.periodTo },
            today,
          );
          if (!worked) continue;
          unlockable.push({
            waybillId: sheet.id,
            requestId: row.sourceRequestId,
            displayNumber,
            number: sheet.number,
            periodFrom: sheet.periodFrom,
            periodTo: sheet.periodTo,
          });
        }
        for (const period of scope.pastWeeks) {
          pastWeeks.push({
            requestId: row.sourceRequestId,
            displayNumber,
            from: period.from,
            to: period.to,
          });
        }
      }

      const verdict = checkBackdate({ effectiveDate, today, subject: p, hasReason: true });
      return {
        weeklyRequestId: header.id,
        weekStart: header.weekStart,
        weekEnd: bounds.to,
        weekLabel: weeklyWeekLabel(header.weekStart),
        today,
        overdue: isWeeklyWeekOverdue(header.weekStart, today),
        effectiveDate,
        // Причина в вердикте подставлена заведомо непустой: спрашивается здесь не «хватает ли
        // объяснения» (его человек ещё не написал), а «пройдёт ли операция задним числом».
        backdated: verdict.ok && verdict.backdated,
        // Граница считается тем же правилом, что и нижний предел дейтпикера в форме заявки
        // (`minRequestDateKey`): у права без предела она `null`, и выдуманный «очень давний год»
        // здесь запирал бы то, что сервер примет.
        correctionFloor: minRequestDateKey(now, access),
        allowed,
        blockedReason,
        unlockable,
        pastWeeks,
      };
    },
  );

  // ── Чек-лист готовности недели (§5 шаг 6) ──
  r.get(
    '/:id/documents',
    { ...auth, schema: { params: idParams } },
    async (req): Promise<WeeklyRequestDocumentsDto> => {
      const p = requirePrincipal(req);
      await assertWeeklyRequestReadable(p, req.params.id);
      const header = await requireHeader(req.params.id);

      // Строки сужаются тем же условием, что и состав карточки: чек-лист перечисляет ЭСМ-2 и
      // перегоны по каждой единице, и без сужения он рассказал бы арендодателю о документах чужих
      // машин площадки — в обход того, что закрыто в самом составе.
      const rows = await itemsQuery()
        .where(
          and(eq(weeklyVehicleRequestItems.weeklyRequestId, header.id), weeklyItemsReadWhere(p)),
        )
        .orderBy(asc(weeklyVehicleRequestItems.position));
      const requestIds = [
        ...new Set(
          rows.map((row) => row.sourceRequestId ?? row.createdRequestId).filter((v) => v !== null),
        ),
      ];

      const sheets = new Map<string, { weekStart: string; number: string }[]>();
      const trips = new Map<string, { purpose: string; number: string | null }[]>();
      if (requestIds.length > 0) {
        const sheetRows = await db
          .select({
            requestId: waybills.sourceRequestId,
            periodFrom: waybills.periodFrom,
            number: waybills.number,
            prefix: waybillSeries.prefix,
            numberWidth: waybillSeries.numberWidth,
          })
          .from(waybills)
          .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
          .where(
            and(
              inArray(waybills.sourceRequestId, requestIds),
              eq(waybills.formCode, 'esm2'),
              ne(waybills.status, 'cancelled'),
            ),
          );
        for (const s of sheetRows) {
          if (!s.requestId || !s.periodFrom) continue;
          const list = sheets.get(s.requestId) ?? [];
          list.push({
            weekStart: weekStartKey(s.periodFrom),
            number: waybillDisplayNumber(s.prefix, s.number, s.numberWidth),
          });
          sheets.set(s.requestId, list);
        }

        const tripRows = await db
          .select({
            requestId: vehicleRoutes.sourceRequestId,
            purpose: vehicleRoutes.purpose,
            number: waybills.number,
            prefix: waybillSeries.prefix,
            numberWidth: waybillSeries.numberWidth,
            status: waybills.status,
          })
          .from(vehicleRoutes)
          .leftJoin(
            waybills,
            and(eq(waybills.routeId, vehicleRoutes.id), ne(waybills.status, 'cancelled')),
          )
          .leftJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
          .where(inArray(vehicleRoutes.sourceRequestId, requestIds));
        for (const t of tripRows) {
          if (!t.requestId) continue;
          const list = trips.get(t.requestId) ?? [];
          list.push({
            purpose: t.purpose,
            number:
              t.number !== null && t.prefix !== null && t.numberWidth !== null
                ? waybillDisplayNumber(t.prefix, t.number, t.numberWidth)
                : null,
          });
          trips.set(t.requestId, list);
        }
      }

      const bounds = weeklyWeekBounds(header.weekStart);
      const docRows: WeeklyDocumentRowDto[] = rows.map((row) => {
        const requestId = row.sourceRequestId ?? row.createdRequestId;
        const num = row.sourceRequestNum ?? row.createdRequestNum;
        const title = `${row.vehicleTypeName ?? row.vehicleTypeOfVehicle ?? 'Техника'} (${kindSuffix(row)})`;
        return {
          itemId: row.id,
          kind: row.kind,
          title,
          requestId: row.result === 'skipped' ? null : requestId,
          displayNumber:
            row.result === 'skipped' || num === null ? null : formatVehicleRequestNumber(num),
          vehicleLabel: labelOf(row),
          // Расхождение снимка с текущим назначением — это переназначение **после** применения:
          // снимок берётся в момент применения, и правка до визы в него просто попадает.
          vehicleChanged: !!row.snapshotVehicleId && row.snapshotVehicleId !== row.currentVehicleId,
          ownership: row.ownership,
          approved: !!(row.sourceApprovedAt ?? row.createdRequestApprovedAt),
          esm2: esm2Cell(row, bounds.from, sheets),
          relocation: relocationCell(row, trips),
          result: row.result,
          skipReason: row.skipReason,
        };
      });

      return {
        weeklyRequestId: header.id,
        weekStart: bounds.from,
        weekEnd: bounds.to,
        weekLabel: weeklyWeekLabel(header.weekStart),
        applied: docRows.filter((row) => row.result !== 'pending' && row.result !== 'skipped')
          .length,
        skipped: docRows.filter((row) => row.result === 'skipped').length,
        rows: docRows,
      };
    },
  );

  // ── История: статусы и правки состава (план Р17) ──
  // Транзакционная таблица, а не только аудит: `writeAudit` намеренно не роняет операцию при сбое
  // записи, и тогда причина отклонения и сам факт перехода могли бы исчезнуть.
  r.get('/:id/history', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    await assertWeeklyRequestReadable(p, req.params.id);
    const header = await requireHeader(req.params.id);
    const rows = await db
      .select({
        id: weeklyVehicleRequestHistory.id,
        event: weeklyVehicleRequestHistory.event,
        fromStatus: weeklyVehicleRequestHistory.fromStatus,
        toStatus: weeklyVehicleRequestHistory.toStatus,
        payload: weeklyVehicleRequestHistory.payload,
        comment: weeklyVehicleRequestHistory.comment,
        changedBy: weeklyVehicleRequestHistory.changedBy,
        changedByName: historyActors.fullName,
        changedAt: weeklyVehicleRequestHistory.changedAt,
      })
      .from(weeklyVehicleRequestHistory)
      .innerJoin(historyActors, eq(weeklyVehicleRequestHistory.changedBy, historyActors.id))
      .where(eq(weeklyVehicleRequestHistory.weeklyRequestId, header.id))
      .orderBy(asc(weeklyVehicleRequestHistory.changedAt));
    /*
     * `payload` уходит целиком только тому, кто видит весь состав. Сужения строк здесь мало:
     * события несут содержание документа **отдельно** от них — `items_changed` называет размер
     * состава числом, `item_dropped` — сколько строк сняли и на каких позициях, `applied` — отчёт
     * по каждой строке с номером заказа и сроками. Арендодателю, которому документ открыли его же
     * машины, это раскрыло бы ровно то, что от него закрыто строками.
     *
     * Пересчитать нельзя честно: у `items_changed` привязки к строкам нет вовсе (число на момент
     * события, а состав с тех пор менялся), `item_dropped` говорит о строках, которых больше не
     * существует. Пересчёт одного лишь `applied` дал бы худшее — вид полной истории, из которой
     * молча вынуто остальное. Поэтому `null`, а событие, переход, автор, дата и комментарий
     * остаются: они объясняют, что с документом происходило, и состава не раскрывают.
     */
    const wholeVisible = seesWholeWeeklyRequest(p);
    return rows.map((row) => ({
      ...row,
      payload: wholeVisible ? row.payload : null,
      changedAt: row.changedAt.toISOString(),
    }));
  });
}
