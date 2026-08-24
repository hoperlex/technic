import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  calcWasteFactCost,
  assignWasteOperatorSchema,
  changeWasteRequestStatusSchema,
  type CompleteWasteRequestInput,
  createWasteRequestSchema,
  FACT_UNIT_MISMATCH_MESSAGE,
  factVolumeOf,
  factWeightOf,
  type FileDto,
  formatWasteRequestNumber,
  MIN_WASTE_VOLUME_M3,
  presentContainerGroupsQuerySchema,
  REQUEST_STATUSES,
  type RequestType,
  transitionResetsWork,
  updateWasteOperatorCommentSchema,
  updateWasteRequestSchema,
  type WasteFactAmount,
  type WasteFactUnit,
  wasteFactUnit,
  wasteOperatorCommentEditable,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestCompletionDto,
  type WasteRequestDto,
  type WasteRequestSummaryDto,
  type WasteRequestVehicleDto,
  wasteRequestListQuerySchema,
  wasteRequestSummaryQuerySchema,
  can,
  type WasteTicketBadgeDto,
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
  wasteRequestCompletions,
  wasteRequests,
  wasteTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import {
  archiveWhere,
  assertArchiveVisible,
  assertCan,
  assertOperatorScope,
  assertObjectRoleEditable,
  assertWasteObjectScope,
  assertTransitionAllowed,
  operatorVisibilityWhere,
  wasteRequestVisibilityWhere,
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
import { priceWasteRequest, resolveWasteTariffByKind, toNum } from '../services/waste-pricing';
import {
  assertContainerGroupAvailable,
  assertContainerOwnerAllowed,
  loadPresentGroups,
} from '../services/container-groups';
import {
  diffWasteCompletion,
  diffWasteRequests,
  ownerMismatchChanges,
} from '../services/waste-request-diff';
import { loadWasteRequestHistory } from '../services/waste-request-history';
import { vehiclesByRequestIds } from '../services/waste-request-vehicles';
import { assertOperatorServesObject } from '../services/object-operators';
import { enqueueTicketRecognition, purgeRequestRecognition } from '../services/waste-tickets';
import { wasteTicketChecks } from '../services/waste-ticket-checks';
import { loadTicketCheckInputs } from '../services/waste-ticket-inputs';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

// Факт есть у заявок на вывоз (ADR 0035, ADR 0067): контейнерные операции вывезенного не несут
// и закрываются одним талоном. Талоны бывают у заявок любого типа и с ADR 0024 везде крепятся к
// самой заявке — общим пулом.
const FACT_NOT_APPLICABLE = 'Вывезенное указывается только у заявок на вывоз';

/** Кто закрыл заявку — второй join на users: первый занят автором заявки. */
const completers = alias(users, 'completers');

/** Кто отправил заявку в архив (ADR 0070) — третий join на users: им подписана строка архива. */
const deleters = alias(users, 'deleters');

/** Чей контейнер снимаем — второй join на контрагентов: первый занят оператором заявки. */
const containerOwners = alias(counterparties, 'container_owners');

/** numeric в БД принимает строку; null остаётся null. */
function numToDb(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

const requestSelect = {
  id: wasteRequests.id,
  num: wasteRequests.num,
  // Формат номера: заявки до миграции 0064 показываются прежним «<num>-<буква типа>».
  legacyNumFormat: wasteRequests.legacyNumFormat,
  objectId: wasteRequests.objectId,
  objectCode: constructionObjects.code,
  objectName: constructionObjects.name,
  objectAddress: constructionObjects.address,
  requestType: wasteRequests.requestType,
  containerTypeId: wasteRequests.containerTypeId,
  containerTypeName: containerTypes.name,
  // Контейнеры на объекте (миграция 0080): сколько единиц трогает заявка и чьи они.
  containersCount: wasteRequests.containersCount,
  containerOwnerCounterpartyId: wasteRequests.containerOwnerCounterpartyId,
  containerOwnerName: containerOwners.name,
  wasteTypeId: wasteRequests.wasteTypeId,
  wasteTypeName: wasteTypes.name,
  volumeM3: wasteRequests.volumeM3,
  pricePerM3: wasteRequests.pricePerM3,
  amount: wasteRequests.amount,
  deliveryAt: wasteRequests.deliveryAt,
  deliveryTimeUnspecified: wasteRequests.deliveryTimeUnspecified,
  // Кто принимает машину на площадке (миграция 0062).
  responsibleName: wasteRequests.responsibleName,
  responsiblePhone: wasteRequests.responsiblePhone,
  // Комментарий двух сторон (ADR 0053): площадка пишет заявку, исполнитель — своё примечание.
  comment: wasteRequests.comment,
  operatorComment: wasteRequests.operatorComment,
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
  // Факт выполнения (ADR 0035): сколько вывезли, по какой цене считали и во сколько обошлось —
  // снимок на момент закрытия. Вывезенное — в одной из двух колонок: мусор меряют объёмом,
  // металлолом принимают по весу (ADR 0067).
  completionVolumeM3: wasteRequestCompletions.volumeM3,
  completionWeightTons: wasteRequestCompletions.weightTons,
  completionPricePerM3: wasteRequestCompletions.pricePerM3,
  completionTotalCost: wasteRequestCompletions.totalCost,
  completedBy: wasteRequestCompletions.completedBy,
  completedByName: completers.fullName,
  completedAt: wasteRequestCompletions.completedAt,
  version: wasteRequests.version,
  createdBy: wasteRequests.createdBy,
  createdByName: users.fullName,
  createdAt: wasteRequests.createdAt,
  updatedAt: wasteRequests.updatedAt,
  deletedAt: wasteRequests.deletedAt,
  deletedByName: deleters.fullName,
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

/**
 * Факт выполнения из строки закрытия (ADR 0035). Пусто — заявка не закрыта либо закрыта
 * контейнерной операцией: у неё вывезенного нет вовсе, только талон.
 *
 * Наличие строки определяется по автору и времени закрытия, а не по величине: величин две
 * (объём либо вес, ADR 0067), заполнена всегда одна, и проверка по объёму приняла бы закрытие
 * металлолома за отсутствие факта.
 */
function toCompletionDto(r: RequestRow): WasteRequestCompletionDto | null {
  if (!r.completedBy || !r.completedAt) return null;
  const volumeM3 = toNum(r.completionVolumeM3);
  const weightTons = toNum(r.completionWeightTons);
  // Заполнена ровно одна колонка — это держит CHECK `..._measure_check` (миграция 0091). Строка,
  // у которой пусты обе, схеме БД противоречит, и выдумывать ей ноль нельзя: закрытие без
  // предъявленной величины — не «вывезли нисколько», а испорченная строка.
  const amount: WasteFactAmount | null =
    weightTons != null
      ? { unit: 'weight_tons', weightTons }
      : volumeM3 != null
        ? { unit: 'volume_m3', volumeM3 }
        : null;
  if (!amount) return null;
  return {
    ...amount,
    pricePerM3: toNum(r.completionPricePerM3),
    totalCost: toNum(r.completionTotalCost),
    completedBy: r.completedBy,
    completedByName: r.completedByName ?? '',
    completedAt: r.completedAt.toISOString(),
  };
}

const EMPTY_BADGES: ReadonlyMap<string, WasteTicketBadgeDto> = new Map();

/**
 * Значки разбора для страницы списка (ADR 0114, Р24). Считает их ТА ЖЕ функция, что и карточка:
 * человек включает фильтр «Требуют разбора», получает список и по значкам решает, с какой строки
 * начать, — пустой значок при живом фильтре читается как ошибка портала.
 *
 * Соблазн посчитать разбивку отдельным SQL — «дёшево, прямо в списке» — стоил бы второго
 * определения того, что такое расхождение: допуски, отклонённые талоны, снятые принятия с их
 * отпечатками. Два определения разъезжаются молча и именно в ту сторону, где список успокаивает, а
 * карточка показывает расхождение.
 *
 * Соседей по номеру расчёт списка НЕ называет: `visible` не передан, и замечание о повторе
 * скажет «по другой заявке». Значку этого достаточно — он показывает число, а не текст, — а
 * право читать чужую заявку проверяется там, где текст читают (Р28).
 */
async function ticketBadgesFor(
  rows: readonly RequestRow[],
): Promise<ReadonlyMap<string, WasteTicketBadgeDto>> {
  const bundles = await loadTicketCheckInputs(rows);
  const badges = new Map<string, WasteTicketBadgeDto>();
  for (const [requestId, bundle] of bundles) {
    badges.set(requestId, wasteTicketChecks(bundle.inputs).badge);
  }
  return badges;
}

function toDto(
  r: RequestRow,
  fileGroups: RequestFileGroups,
  vehicles: WasteRequestVehicleDto[] = [],
  /**
   * Значок разбора талонов (ADR 0114, Р24). `null` — либо у смотрящего нет права разбора, либо
   * бумаги у заявки нет вовсе. Нулями это не заменяется намеренно: «разбирать нечего» и «всё
   * разобрано» — разные ответы, и один значок на оба означал бы, что молчащая подсистема выглядит
   * как порядок.
   */
  ticketBadge: WasteTicketBadgeDto | null = null,
): WasteRequestDto {
  return {
    id: r.id,
    num: r.num,
    displayNumber: formatWasteRequestNumber(r.num, r.requestType, r.legacyNumFormat),
    objectId: r.objectId,
    objectCode: r.objectCode,
    objectName: r.objectName,
    objectAddress: r.objectAddress,
    requestType: r.requestType,
    containerTypeId: r.containerTypeId,
    containerTypeName: r.containerTypeName,
    containersCount: r.containersCount,
    containerOwnerCounterpartyId: r.containerOwnerCounterpartyId,
    containerOwnerName: r.containerOwnerName,
    wasteTypeId: r.wasteTypeId,
    wasteTypeName: r.wasteTypeName,
    volumeM3: r.volumeM3,
    pricePerM3: toNum(r.pricePerM3),
    amount: toNum(r.amount),
    operatorCounterpartyId: r.operatorCounterpartyId,
    operatorName: r.operatorName,
    deliveryAt: r.deliveryAt.toISOString(),
    deliveryTimeUnspecified: r.deliveryTimeUnspecified,
    responsibleName: r.responsibleName,
    responsiblePhone: r.responsiblePhone,
    comment: r.comment,
    operatorComment: r.operatorComment,
    status: r.status,
    // Пустой комментарий отмены (история до миграции 0024) читается как «причина не указана».
    cancelReason: r.cancelReason || null,
    files: fileGroups.files,
    tickets: fileGroups.tickets,
    vehicles,
    ticketBadge,
    completion: toCompletionDto(r),
    version: r.version,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    deletedByName: r.deletedByName,
  };
}

// Справочники присоединяются left join: тип контейнера/машины опционален в зависимости от типа
// заявки, тип мусора есть только у тарифицируемых операций (ADR 0009), а оператор может быть
// ещё не назначен (ADR 0010). Факт выполнения — тоже left join: он появляется при закрытии.
function baseQuery() {
  return (
    db
      .select(requestSelect)
      .from(wasteRequests)
      .innerJoin(constructionObjects, eq(wasteRequests.objectId, constructionObjects.id))
      .leftJoin(containerTypes, eq(wasteRequests.containerTypeId, containerTypes.id))
      .leftJoin(wasteTypes, eq(wasteRequests.wasteTypeId, wasteTypes.id))
      .leftJoin(counterparties, eq(wasteRequests.operatorCounterpartyId, counterparties.id))
      .leftJoin(containerOwners, eq(wasteRequests.containerOwnerCounterpartyId, containerOwners.id))
      .leftJoin(wasteRequestCompletions, eq(wasteRequests.id, wasteRequestCompletions.requestId))
      .leftJoin(completers, eq(wasteRequestCompletions.completedBy, completers.id))
      // Кто удалил (ADR 0070): пусто у живой заявки, а у архивной — ещё и если учётку снесли.
      .leftJoin(deleters, eq(wasteRequests.deletedBy, deleters.id))
      .innerJoin(users, eq(wasteRequests.createdBy, users.id))
  );
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
  containersCount: number;
  containerOwnerCounterpartyId: string | null;
  wasteTypeId: string | null;
  volumeM3: number | null;
  wasteTariffId: string | null;
  pricePerM3: string | null;
}

/**
 * Проверяет и нормализует поля заявки по её типу:
 *  - установка — сверяет тип контейнера (type='cont');
 *  - замена/снятие — сверяет группу присутствия: столько контейнеров этого типа от этого
 *    владельца на объекте действительно стоит (ADR 0054);
 *  - вывоз — техники не несёт вовсе (ADR 0022): присланный тип отбрасывается.
 * Тарифицируется один вывоз (ADR 0019): у него требуются тип мусора и объём, по ним
 * подбирается тариф и возвращается снимок цены. Прайс берётся у назначенного оператора, а пока
 * его нет — самый дешёвый среди операторов (ADR 0026). У контейнерных операций эти поля
 * обнуляются — так они очищаются и при смене типа уже заведённой заявки.
 */
async function resolveSubject(
  tx: Tx,
  input: {
    requestType: RequestType;
    objectId: string;
    containerTypeId: string | null;
    containersCount: number;
    containerOwnerCounterpartyId: string | null;
    wasteTypeId: string | null;
    volumeM3: number | null;
    operatorCounterpartyId: string | null;
    /** Правимая заявка: её собственный вклад в присутствие не должен мешать ей самой. */
    requestId?: string;
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
      // Установка привозит один контейнер; владельцем её делает назначенный оператор, и
      // отдельной колонкой это не дублируется.
      containersCount: 1,
      containerOwnerCounterpartyId: null,
      wasteTypeId: null,
      volumeM3: null,
      wasteTariffId: null,
      pricePerM3: null,
    };
  }

  if (input.requestType === 'container_replace' || input.requestType === 'container_removal') {
    const what = input.requestType === 'container_replace' ? 'замены' : 'снятия';
    if (!input.containerTypeId) throw err.badRequest(`Выберите тип контейнера для ${what}`);
    await assertContainerGroupAvailable(tx, {
      requestType: input.requestType,
      objectId: input.objectId,
      containerTypeId: input.containerTypeId,
      ownerId: input.containerOwnerCounterpartyId,
      count: input.containersCount,
      requestId: input.requestId,
    });
    // Контейнерная операция не тарифицируется (ADR 0019): присланные тип мусора и объём
    // отбрасываются вместе со снимком цены.
    return {
      containerTypeId: input.containerTypeId,
      containersCount: input.containersCount,
      containerOwnerCounterpartyId: input.containerOwnerCounterpartyId,
      wasteTypeId: null,
      volumeM3: null,
      wasteTariffId: null,
      pricePerM3: null,
    };
  }

  // metal_removal — вывоз металлолома (ADR 0067): предмета у заявки нет вовсе. Ветка стоит до
  // вывоза мусора и именно веткой, а не общим «иначе»: последняя ветка этой функции требует тип
  // мусора с объёмом, и новый тип провалился бы в неё отказом «Выберите тип мусора».
  if (input.requestType === 'metal_removal') {
    return {
      containerTypeId: null,
      containersCount: 1,
      containerOwnerCounterpartyId: null,
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
    containersCount: 1,
    containerOwnerCounterpartyId: null,
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

/**
 * Факт закрытия из присланного (ADR 0035): вывезенное — от человека, цена — основание расчёта,
 * сумма — расчёт либо то, что прислал клиент.
 *
 * Цена берётся снимком самой заявки: по нему её оформляли, и правка прайса уже оформленную заявку
 * не переписывает (ADR 0009). Снимка нет (заявки старше тарификации) — подбор по виду «Самосвал»
 * на момент закрытия: вывоз тарифицируется самосвалами (ADR 0022), прайс берётся у оператора
 * заявки (ADR 0026). Нет цены и там — закрытие всё равно проходит: мусор вывезен, талон на руках,
 * и отказ здесь означал бы «сначала заполните справочник», а заявка уже выполнена. Тогда сумму
 * вводят руками — либо правят прайс и закрывают заявку заново.
 *
 * Закрытие по весу (металлолом, ADR 0067) через подбор цены не проходит вовсе: прайс задан в
 * ₽/м³ на пару «тип мусора × техника», а у лома нет ни того, ни другого. Строка сохраняется
 * одним весом — без цены, тарифа и суммы.
 */
async function resolveWasteCompletion(
  tx: Tx,
  request: WasteRequestDto,
  input: CompleteWasteRequestInput,
  actor: { id: string; name: string },
): Promise<{ dto: WasteRequestCompletionDto; wasteTariffId: string | null }> {
  if (input.weightTons != null) {
    return {
      wasteTariffId: null,
      dto: {
        unit: 'weight_tons',
        weightTons: input.weightTons,
        pricePerM3: null,
        totalCost: null,
        completedBy: actor.id,
        completedByName: actor.name,
        completedAt: new Date().toISOString(),
      },
    };
  }
  // Дальше — закрытие объёмом; что величина прислана ровно одна, проверила схема тела запроса,
  // а что именно та, которой меряется эта заявка, — роут статуса перед вызовом.
  const volumeM3 = input.volumeM3!;
  const [snapshot] = await tx
    .select({ wasteTariffId: wasteRequests.wasteTariffId, pricePerM3: wasteRequests.pricePerM3 })
    .from(wasteRequests)
    .where(eq(wasteRequests.id, request.id));
  let wasteTariffId = snapshot?.wasteTariffId ?? null;
  let pricePerM3 = toNum(snapshot?.pricePerM3 ?? null);
  if (pricePerM3 == null && request.wasteTypeId) {
    const resolved = await resolveWasteTariffByKind(
      request.wasteTypeId,
      WASTE_REMOVAL_CONTAINER_KIND,
      request.operatorCounterpartyId,
    );
    wasteTariffId = resolved?.tariffId ?? null;
    pricePerM3 = resolved?.pricePerM3 ?? null;
  }
  return {
    // Тариф хранится только вместе с ценой: ссылка на прайс без цены ничего не объясняет.
    wasteTariffId: pricePerM3 == null ? null : wasteTariffId,
    dto: {
      unit: 'volume_m3',
      volumeM3,
      pricePerM3,
      // Сумма приходит от клиента — он показывал её человеку перед нажатием. Поле не прислано —
      // считаем по цене сами; прислан пустым — значит закрываем без суммы (счёт выяснят позже).
      totalCost:
        input.totalCost === undefined ? calcWasteFactCost(volumeM3, pricePerM3) : input.totalCost,
      completedBy: actor.id,
      completedByName: actor.name,
      completedAt: new Date().toISOString(),
    },
  };
}

/**
 * Закрытие заявки: одна строка на заявку. Повторное закрытие (после отката администратором)
 * переписывает её — двух фактов об одном вывозе не бывает.
 */
async function saveWasteCompletion(
  tx: Tx,
  requestId: string,
  c: WasteRequestCompletionDto,
  wasteTariffId: string | null,
  /**
   * День фактического вывоза (ADR 0114, Р19). Источник хранится рядом со значением: `entered` —
   * человек ввёл, `unknown` — дня нет. Историческим закрытиям он **не выдумывается**: подстановка
   * плановой даты выдала бы предположение за факт, и сверка нарисовала бы расхождения там, где их
   * никто не совершал.
   */
  removedOn: string | null | undefined,
): Promise<void> {
  const values = {
    // Ровно одна из двух колонок — вторая явным NULL: строка переписывается целиком, и оставшееся
    // от прошлого закрытия число разошлось бы с CHECK `..._measure_check` (миграция 0091).
    volumeM3: numToDb(factVolumeOf(c)),
    weightTons: numToDb(factWeightOf(c)),
    pricePerM3: numToDb(c.pricePerM3),
    wasteTariffId,
    totalCost: numToDb(c.totalCost),
    completedBy: c.completedBy,
    // Пустое поле — это «неизвестно», а не «не меняли»: закрытие переписывает строку целиком.
    removedOn: removedOn ?? null,
    removedOnSource: removedOn ? ('entered' as const) : ('unknown' as const),
  };
  await tx
    .insert(wasteRequestCompletions)
    .values({ requestId, ...values })
    .onConflictDoUpdate({
      target: wasteRequestCompletions.requestId,
      set: { ...values, completedAt: new Date(), updatedAt: new Date() },
    });
}

/** Один текст отказа на все три пути назначения исполнителя: форма, правка, отдельный маршрут. */
const ASSIGN_OPERATOR_DENIED = 'Оператора назначает диспетчер или менеджер';

/**
 * Подтверждённый вывоз чужого контейнера — событие истории заявки (ADR 0054), а не колонка: это
 * не свойство заявки, а решение человека и объяснение почему. Пустая причина означает, что
 * расхождения не было, — записывать нечего.
 *
 * Пишется по сохранённой заявке: имена сторон берутся из её DTO, где они уже собраны.
 */
async function writeOwnerMismatchAudit(
  actorUserId: string,
  dto: WasteRequestDto,
  reason: string,
): Promise<void> {
  if (!reason) return;
  await writeAudit({
    actorUserId,
    action: 'waste_request.owner_mismatch',
    entityType: 'waste_request',
    entityId: dto.id,
    metadata: { changes: ownerMismatchChanges(dto, reason) },
  });
}

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
  // Примечание исполнителя (ADR 0053) — своё право: у оператора нет права на правку заявки, а
  // площадка чужую строку не трогает.
  const canOperatorComment = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'wasteRequests.operatorComment',
        'Недостаточно прав для комментария исполнителя',
      ),
    ],
  };

  r.get('/', { ...auth, schema: { querystring: wasteRequestListQuerySchema } }, async (req) => {
    const p = requirePrincipal(req);
    const q = req.query;
    // Реестр разбора (ADR 0114, Р24). Право спрашивается ЗДЕСЬ, а не в `preHandler`: сам список
    // открыт всем, у кого есть чтение заявок, и закрыт только этот его срез. Параметр без права
    // отклоняется, а не игнорируется: молчаливое игнорирование вернуло бы полный список, и человек
    // прочитал бы его как «разбирать нечего».
    if (q.ticketReview) {
      assertCan(p, 'wasteRequests.ticketReview', 'Разбор талонов — отдельное право');
    }
    const where = and(
      // Архив (ADR 0070): вкладка «Архив» просит `only`, обычный список — умолчание `exclude`.
      // Границы видимости при этом те же: свой объект, свои заявки, — архив их не расширяет.
      archiveWhere(p, q.archive, wasteRequests.deletedAt),
      wasteRequestVisibilityWhere(p, wasteRequests.objectId),
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
      // «Требуют разбора»: неподтверждённый или спорный талон, неудачный файл, мёртвая задача либо
      // непринятое расхождение. Именно ждущая работа, а не только расхождения, — иначе корректно
      // распознанный талон без замечаний остался бы неподтверждённым навсегда (Р24).
      q.ticketReview === 'pending'
        ? sql`(
            EXISTS (SELECT 1 FROM waste_tickets wt
                     WHERE wt.request_id = ${wasteRequests.id}
                       AND (wt.status = 'unconfirmed' OR array_length(wt.needs_review_fields, 1) > 0))
            OR EXISTS (SELECT 1 FROM waste_ticket_files wf
                        WHERE wf.request_id = ${wasteRequests.id}
                          AND wf.status IN ('unsupported', 'failed'))
            OR EXISTS (SELECT 1 FROM waste_ticket_pages wp
                        WHERE wp.request_id = ${wasteRequests.id} AND wp.status = 'failed')
            OR EXISTS (SELECT 1 FROM waste_ticket_blind_checks bc
                        JOIN waste_tickets wt2 ON wt2.id = bc.ticket_id
                       WHERE wt2.request_id = ${wasteRequests.id}
                         AND bc.status IN ('pending', 'mismatch'))
          )`
        : undefined,
      // Ищут по тексту, не помня, чья это была строка, — поэтому обе (ADR 0053).
      searchCondition(q.search, [
        wasteRequests.comment,
        wasteRequests.operatorComment,
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
      // Колонка «Комментарий» показывает обе стороны, но сортируется по строке площадки: ключ
      // сортировки у колонки один, а порядок склейки двух текстов ничего не значит (ADR 0053).
      comment: wasteRequests.comment,
      createdAt: wasteRequests.createdAt,
      // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили — им архив и открывают.
      deletedAt: wasteRequests.deletedAt,
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
    const [filesMap, vehiclesMap, badges] = await Promise.all([
      filesByRequestIds(rows.map((row) => row.id)),
      vehiclesByRequestIds(rows.map((row) => row.id)),
      // Значок разбора (Р24) — только с правом `ticketReview` и только для этой страницы. Без
      // права он не считается вовсе: по разбивке ⛔/⚠️ читается наличие расхождений, а это те же
      // сведения, что закрыты в карточке, — показанные в списке, они обошли бы её проверку.
      can(p, 'wasteRequests.ticketReview') ? ticketBadgesFor(rows) : EMPTY_BADGES,
    ]);
    return {
      items: rows.map((row) =>
        toDto(
          row,
          filesMap.get(row.id) ?? EMPTY_FILE_GROUPS,
          vehiclesMap.get(row.id) ?? [],
          badges.get(row.id) ?? null,
        ),
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
        wasteRequestVisibilityWhere(p, wasteRequests.objectId),
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
   * Группы присутствия на объекте (ADR 0054): что и чьё там стоит, сколько штук. Одна выборка
   * отвечает сразу на три вопроса формы — из чего выбирать контейнер для замены и снятия,
   * сколько максимум можно указать и кого звать на этот объект.
   *
   * Права те же, что у списка заявок: это сведения о площадке, а не отдельная сущность. Оператор
   * видит их наравне с остальными — свои контейнеры на объекте он вправе знать, и скрывать от
   * него чужие означало бы показывать неполную площадку тому, кто на неё выезжает.
   */
  r.get(
    '/present-groups',
    { ...auth, schema: { querystring: presentContainerGroupsQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      assertWasteObjectScope(p, req.query.objectId);
      return loadPresentGroups(req.query.objectId);
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
            wasteRequestVisibilityWhere(p, wasteRequests.objectId),
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
    assertWasteObjectScope(p, dto.objectId);
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
    assertWasteObjectScope(p, row.objectId);
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
    assertWasteObjectScope(p, body.objectId);
    // Исполнителя можно указать прямо в форме заявки, но это по-прежнему назначение оператора:
    // без отдельной проверки роль с правом на заявку (штаб) назначала бы его в обход
    // `PATCH /:id/operator`, где право спрашивают. Право требуется по факту присутствия поля,
    // а не по изменению значения: форма его не шлёт, если назначать нельзя.
    if (body.operatorCounterpartyId !== undefined) {
      assertCan(p, 'wasteRequests.assignOperator', ASSIGN_OPERATOR_DENIED);
    }
    // Подтверждённый вывоз чужого контейнера — своё событие истории, и пишется оно после
    // фиксации заявки: причина известна внутри транзакции, а номер заявки — только после неё.
    let mismatchReason = '';
    const created = await db.transaction(async (tx) => {
      // Оператор проверяется до расчёта: цена берётся из его прайса (ADR 0026), и считать её по
      // исполнителю, которого нельзя назначить, незачем.
      if (body.operatorCounterpartyId) {
        await assertOperatorAssignable(tx, body.operatorCounterpartyId, body.objectId);
      }
      const subject = await resolveSubject(tx, {
        requestType: body.requestType,
        objectId: body.objectId,
        containerTypeId: body.containerTypeId ?? null,
        containersCount: body.containersCount,
        containerOwnerCounterpartyId: body.containerOwnerCounterpartyId ?? null,
        wasteTypeId: body.wasteTypeId ?? null,
        volumeM3: body.volumeM3 ?? null,
        operatorCounterpartyId: body.operatorCounterpartyId ?? null,
      });
      // Вывозит тот, кто привёз (ADR 0054). Расхождение возможно уже здесь: исполнителя можно
      // указать прямо в форме заявки.
      mismatchReason = await assertContainerOwnerAllowed(tx, {
        requestType: body.requestType,
        operatorCounterpartyId: body.operatorCounterpartyId ?? null,
        containerOwnerCounterpartyId: subject.containerOwnerCounterpartyId,
        ownerMismatchReason: body.ownerMismatchReason,
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
          responsibleName: body.responsibleName,
          responsiblePhone: body.responsiblePhone,
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
    const dto = (await getRequestDto(created.id))!;
    await writeOwnerMismatchAudit(p.id, dto, mismatchReason);
    reply.code(201);
    return dto;
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
      assertWasteObjectScope(p, before.objectId);
      assertObjectRoleEditable(p, before.status, 'редактировать');
      if (body.objectId) assertWasteObjectScope(p, body.objectId);

      const rt = body.requestType ?? before.requestType;
      const objectId = body.objectId ?? before.objectId;
      const operatorCounterpartyId =
        body.operatorCounterpartyId !== undefined
          ? body.operatorCounterpartyId
          : before.operatorCounterpartyId;
      let mismatchReason = '';
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
          containersCount: body.containersCount ?? before.containersCount,
          containerOwnerCounterpartyId:
            body.containerOwnerCounterpartyId !== undefined
              ? body.containerOwnerCounterpartyId
              : before.containerOwnerCounterpartyId,
          wasteTypeId: body.wasteTypeId !== undefined ? body.wasteTypeId : before.wasteTypeId,
          volumeM3: body.volumeM3 !== undefined ? body.volumeM3 : before.volumeM3,
          operatorCounterpartyId,
          // Собственный вклад заявки в присутствие не должен мешать ей самой: снятие вычитает
          // свои единицы сразу, как только заведено.
          requestId: id,
        });
        mismatchReason = await assertContainerOwnerAllowed(tx, {
          requestType: rt,
          operatorCounterpartyId,
          containerOwnerCounterpartyId: subject.containerOwnerCounterpartyId,
          ownerMismatchReason: body.ownerMismatchReason,
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
            // Контакт нельзя оставить пустым даже у заявки старше миграции 0062: правка — тот
            // момент, когда ответственного есть у кого спросить.
            responsibleName: nextRequestContact(
              body.responsibleName,
              before.responsibleName,
              'responsibleName',
              'Укажите ответственного',
            ),
            responsiblePhone: nextRequestContact(
              body.responsiblePhone,
              before.responsiblePhone,
              'responsiblePhone',
              'Укажите контактный телефон',
            ),
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
        // Смена типа оставила бы у заявки факт, которого новому типу не полагается: контейнерная
        // операция не несёт вывезенного вовсе (ADR 0035), а мусор и металлолом меряются разными
        // величинами (ADR 0067) — заявка на лом с фактом в м³ была бы закрытием в чужих единицах.
        // Сравниваются именно единицы, а не «нужен ли факт»: между вывозами обе стороны отвечают
        // «нужен», а величины у них разные.
        if (before.completion && wasteFactUnit(rt) !== wasteFactUnit(before.requestType)) {
          throw err.badRequest(
            'У этого типа заявки предъявленное выполнение меряется иначе — сначала откатите его',
            { requestType: 'Сначала откатите выполнение' },
          );
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
      await writeOwnerMismatchAudit(p.id, after, mismatchReason);
      return after;
    },
  );

  // Назначение (или снятие) оператора вывоза — отдельно от общего PATCH: тот пересчитывает
  // предмет заявки целиком, а смена исполнителя касается только его и цены (ADR 0010).
  // Цена пересчитывается вместе с назначением: прайс у каждого оператора свой (ADR 0026), и
  // оставить снимок от прежнего исполнителя значило бы выставить счёт по чужому прайсу. Снятие
  // оператора возвращает цену «от» — минимальную среди операторов.
  r.patch(
    '/:id/operator',
    { ...canAssignOperator, schema: { params: idParams, body: assignWasteOperatorSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { operatorCounterpartyId, ownerMismatchReason, version } = req.body;
      const before = await getRequestDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      let mismatchReason = '';
      await db.transaction(async (tx) => {
        if (operatorCounterpartyId) {
          await assertOperatorAssignable(tx, operatorCounterpartyId, before.objectId);
        }
        // Вывозит тот, кто привёз (ADR 0054). Назначение — тот самый момент, когда расхождение
        // возникает: заявку заводит площадка, а исполнителя ей выбирает диспетчер, и до этого
        // спрашивать было не о чем.
        mismatchReason = await assertContainerOwnerAllowed(tx, {
          requestType: before.requestType,
          operatorCounterpartyId,
          containerOwnerCounterpartyId: before.containerOwnerCounterpartyId,
          ownerMismatchReason,
        });
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
      await writeOwnerMismatchAudit(p.id, after, mismatchReason);
      return after;
    },
  );

  /**
   * Примечание исполнителя (ADR 0053) — единственная точка записи строки оператора.
   *
   * Отдельной ручкой, а не полем общего PATCH: у оператора нет права на правку заявки
   * (ADR 0038), а сам PATCH пересчитывает предмет заявки и подбирает тариф — к примечанию это
   * отношения не имеет (та же причина, по которой отдельно живёт назначение оператора).
   *
   * Пишут его двое: сам исполнитель — в своих заявках, и тот, кто заявку ведёт (менеджер,
   * диспетчер): об «будем после 15:00» диспетчер чаще узнаёт звонком, чем из портала.
   */
  r.patch(
    '/:id/comment',
    {
      ...canOperatorComment,
      schema: { params: idParams, body: updateWasteOperatorCommentSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { operatorComment, version } = req.body;
      const before = await getRequestDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      // Своя заявка — для исполнителя; для менеджера и диспетчера обе проверки ничего не сужают.
      // Область спрашивается и по объекту: право и область выдаются порознь, и «право выдали, а
      // область не написана» означало бы доступ ко всем заявкам сразу.
      assertWasteObjectScope(p, before.objectId);
      assertOperatorScope(p, before.operatorCounterpartyId);
      if (!wasteOperatorCommentEditable(before.status)) {
        throw err.badRequest('Заявка закрыта — примечание исполнителя больше не меняют', {
          operatorComment: 'Заявка закрыта',
        });
      }
      const [updated] = await db
        .update(wasteRequests)
        .set({
          operatorComment,
          updatedBy: p.id,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(wasteRequests.id, before.id), eq(wasteRequests.version, version)))
        .returning({ id: wasteRequests.id });
      if (!updated) throw err.conflict();
      const after = (await getRequestDto(before.id))!;
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.operator_comment',
        entityType: 'waste_request',
        entityId: before.id,
        // Правка примечания — событие истории заявки наравне с правкой её полей (ADR 0012).
        metadata: { changes: diffWasteRequests(before, after) },
      });
      return after;
    },
  );

  r.patch(
    '/:id/status',
    { ...canChangeStatus, schema: { params: idParams, body: changeWasteRequestStatusSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { status, comment, completion, ticketFileIds, version } = req.body;
      // Состояние «до» берётся как DTO: по нему и проверки, и дифф факта для истории.
      const before = await getRequestDto(req.params.id);
      if (!before || before.deletedAt) throw err.notFound('Заявка не найдена');
      assertWasteObjectScope(p, before.objectId);
      assertOperatorScope(p, before.operatorCounterpartyId);
      if (before.status === status) return before;
      assertTransitionAllowed(p, before.status, status);
      // Возврат «В работе» → «Новая» стирает нажитое в работе (`transitionResetsWork`), и причина
      // ему нужна наравне с причиной отмены: без неё в истории осталась бы пара переходов, по
      // которой не понять, зачем стёрли факт и талоны. Спрашивает её сервер, а не схема тела:
      // схеме известен только целевой статус, а требование держится на паре «откуда → куда».
      const resetsWork = transitionResetsWork(before.status, status);
      if (resetsWork && !comment) {
        throw err.badRequest('Укажите причину возврата заявки в «Новую»', {
          comment: 'Укажите причину',
        });
      }
      // Чем меряется вывезенное у этой заявки: объёмом (мусор), весом (металлолом) или ничем
      // (контейнерные операции — они закрываются одним талоном).
      const factUnit = wasteFactUnit(before.requestType);
      if (completion && factUnit == null) {
        throw err.badRequest(FACT_NOT_APPLICABLE, {
          completion: 'Вывезенное предъявляют только заявки на вывоз',
        });
      }
      // Величину закрытия схема тела проверила на «ровно одна», но какая именно нужна, знает лишь
      // заявка: вес в заявке на мусор и объём в заявке на лом — это закрытие в чужих единицах, и
      // молча пересчитать одно в другое нечем.
      if (completion && factUnit != null) {
        const sent: WasteFactUnit = completion.weightTons != null ? 'weight_tons' : 'volume_m3';
        if (sent !== factUnit) {
          throw err.badRequest(FACT_UNIT_MISMATCH_MESSAGE, {
            completion: factUnit === 'weight_tons' ? 'Укажите вес, т' : 'Укажите объём, м³',
          });
        }
      }
      // «Выполнена» без предъявленного вывезенного — отметка о работе, про которую неизвестно,
      // сколько увезли. При повторном закрытии (после отката администратором) хватает уже
      // предъявленного: просить те же цифры второй раз незачем.
      if (status === 'done' && factUnit != null && !completion && !before.completion) {
        throw err.badRequest(
          factUnit === 'weight_tons'
            ? 'Укажите фактически вывезенный вес'
            : 'Укажите фактически вывезенный объём',
          { completion: factUnit === 'weight_tons' ? 'Укажите вес' : 'Укажите объём' },
        );
      }
      let saved: WasteRequestCompletionDto | null = null;
      // Сколько талонов снял возврат в «Новую» — считается там, где они отвязываются: после
      // транзакции их уже не по чему пересчитать.
      let ticketsUnlinked = 0;
      const closed = await db.transaction(async (tx) => {
        // Строка заявки берётся `FOR UPDATE` **первым** действием транзакции — до чтения талонов,
        // факта и вообще чего бы то ни было связанного. Это общий замок всего контура вывоза:
        // любая транзакция, меняющая талоны, страницы распознавания, файловые строки или статус
        // заявки, начинается именно с него (ADR 0114, решение 4; план — Р11).
        //
        // Без замка откат «В работе» → «Новая» проигрывает фоновой задаче распознавания. Задача
        // работает связкой «прочитал состояние → сходил в сеть → записал результат», и до этой
        // правки строка заявки запиралась здесь **последней**: талоны отвязывались и факт
        // удалялся раньше, чем `UPDATE waste_requests`. Всё окно между уборкой и сменой статуса
        // было открыто для писателей — «воркер увидел выполненную заявку с живой связью талона →
        // откат отвязал файлы и снёс факт → воркер вставил страницу и талон → откат дописал
        // статус `new`». На выходе заявка, выглядящая только что заведённой, но с бумагой,
        // которую никто не прикладывал, и с занятым чужим номером талона.
        //
        // Проверок «внутри транзакции» для этого мало: они читают состояние, но не удерживают
        // его, — а перепроверка под общим замком делает опоздавшую задачу no-op, в том числе уже
        // взятую в работу, поэтому отменять задачи при откате не нужно.
        //
        // Оптимистическую проверку версии ниже (`WHERE version = $version`) замок не заменяет и
        // не дублирует: та отвечает за конкурентную правку из интерфейса — «карточку открыли
        // вдвоём, один сохранил раньше» — и опирается на данные, прочитанные до транзакции. Замок
        // отвечает за писателей, которые версию не двигают вовсе: воркер распознавания сверяет
        // состояние (заявка выполнена и связь талона жива), а не версию, — правка выполненной
        // заявки поднимает `version`, и сверка по ней молча отменяла бы распознавание.
        await tx
          .select({ id: wasteRequests.id })
          .from(wasteRequests)
          .where(eq(wasteRequests.id, before.id))
          .for('update');
        // Закрытие заявки — это предъявление факта, и оно проводится тем же запросом, что и смена
        // статуса. Талон обязателен: «Выполнена» без бумаги о вывозе — отметка о работе, которую
        // нечем подтвердить (ADR 0020). Крепится он к самой заявке у любого типа — общим пулом
        // (ADR 0024): оператор отдаёт бумаги пачкой за всё закрытие.
        // Обязательность считается по состоянию заявки, а не по телу запроса: талон мог прийти
        // с прошлым закрытием, и требовать его второй раз значило бы просить ту же бумагу дважды.
        if (status === 'done') {
          if (completion) {
            const resolved = await resolveWasteCompletion(tx, before, completion, {
              id: p.id,
              name: p.fullName,
            });
            saved = resolved.dto;
            await saveWasteCompletion(
              tx,
              before.id,
              resolved.dto,
              resolved.wasteTariffId,
              completion.removedOn,
            );
          }
          await linkFiles(tx, before.id, ticketFileIds, p.id, true, 'ticket');
          if ((await countRequestTickets(tx, before.id)) === 0) {
            throw err.badRequest('Приложите талон — без него заявка не закрывается', {
              ticketFileIds: 'Приложите талон',
            });
          }
          // Приложенная бумага уходит на распознавание (ADR 0114, решение 4; план — Р11). Задача
          // ставится **по файлу** и **той же транзакцией**: страниц в этот момент не существует —
          // их заводит воркер после скачивания и растеризации, — а связь талона и задача на него
          // обязаны появиться вместе. Задача, записанная отдельным соединением, уехала бы в
          // очередь раньше коммита закрытия: воркер не нашёл бы ни выполненной заявки, ни связи,
          // а откат этой транзакции оставил бы её искать талон, которого никто не приложил.
          //
          // Только на файлы этого закрытия: талон, приложенный прошлым разом (заявку вернули в
          // работу и закрывают снова), уже разобран, и вторая задача перераспознавала бы
          // подтверждённую человеком бумагу — а перераспознавание это отдельная кнопка со своей
          // политикой (Р13). Версии заявки в задаче нет намеренно — сверка по ней молча отменяла
          // бы распознавание при любой правке выполненной заявки; воркер сверяет состояние.
          await enqueueTicketRecognition(tx, before.id, before.requestType, ticketFileIds);
        }
        // Возврат в «Новую» стирает работу той же транзакцией, что и меняет статус: «Новая» с
        // предъявленным фактом и талонами прошлого закрытия означала бы, что заявку с работы и не
        // снимали, а следующее закрытие обошлось бы чужими цифрами и чужой бумагой (ADR 0020,
        // ADR 0035). Заявка после сброса выглядит как только что заведённая.
        //
        // Стирается ровно нажитое в работе. Примечание исполнителя остаётся: его пишут и «Новой»
        // заявке (ADR 0053). Назначенный исполнитель — тоже: его ставят отдельным правом, и к
        // переводу в работу это отношения не имеет.
        if (resetsWork) {
          // Распознанное уходит вместе с талонами и той же транзакцией (Р22; ADR 0114, решение
          // 12): талоны заявки, её страницы, файловые строки обработки и принятия расхождений.
          // «Новая» заявка, за которой числится разобранный талон, держала бы чужой номер занятым
          // — область уникальности номера это перевозчик (Р17), — и следующая бумага с тем же
          // номером упёрлась бы в конфликт с закрытием, которого больше нет.
          //
          // ПОПЫТКИ распознавания при этом сохраняются: они принадлежат содержимому страницы, а
          // не заявке (заявки нет даже в их ключе), и служат кэшем — повторное закрытие тем же
          // листом, самый частый исход отката, не стоит ни копейки и не отправляет скан наружу
          // второй раз. Подробности порядка удаления — в сервисе.
          //
          // Идёт под тем же `FOR UPDATE`, что взят первым действием транзакции: уборка,
          // выполненная мимо общего замка, разошлась бы с фоновой задачей ровно так, как описано
          // выше. Отменять уже поставленные задачи не нужно — под замком они становятся no-op.
          await purgeRequestRecognition(tx, before.id);
          const tickets = await tx
            .select({ fileId: requestFiles.fileId })
            .from(requestFiles)
            .where(and(eq(requestFiles.requestId, before.id), eq(requestFiles.kind, 'ticket')));
          // Талоны именно отвязываются, а не удаляются на месте: файл уходит в отложенное
          // удаление общим порядком, и месяц его ещё можно достать, если откат был ошибкой.
          // Обычные вложения не трогаются — они предъявляют саму заявку, а не её выполнение.
          const ticketIds = tickets.map((t) => t.fileId);
          await unlinkFiles(tx, before.id, ticketIds);
          ticketsUnlinked = ticketIds.length;
          await tx
            .delete(wasteRequestCompletions)
            .where(eq(wasteRequestCompletions.requestId, before.id));
        }
        const [updated] = await tx
          .update(wasteRequests)
          .set({ status, updatedBy: p.id, version: before.version + 1, updatedAt: new Date() })
          .where(and(eq(wasteRequests.id, before.id), eq(wasteRequests.version, version)))
          .returning({ id: wasteRequests.id });
        if (!updated) throw err.conflict();
        await tx.insert(requestStatusHistory).values({
          requestId: before.id,
          fromStatus: before.status,
          toStatus: status,
          changedBy: p.id,
          comment,
        });
        return saved;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'waste_request.status',
        entityType: 'waste_request',
        entityId: before.id,
        metadata: {
          from: before.status,
          to: status,
          comment,
          // Талоны этого закрытия — по одному числу видно, чем подтверждён вывоз (ADR 0024:
          // список общий на заявку, поэтому и число одно).
          ticketsAdded: ticketFileIds.length,
          // Чего лишила заявку отмотка назад: по этим отметкам видно, было ли что стирать, даже
          // когда самих строк уже нет. У прочих переходов ключей нет вовсе — «снято ноль талонов,
          // факт не тронут» на «взята в работу» читалось бы как событие, которого не было.
          ...(resetsWork ? { ticketsUnlinked, factCleared: before.completion != null } : {}),
        },
      });
      // Факт — отдельное событие истории: «выполнена» и «вывезли столько-то на такую-то сумму»
      // отвечают на разные вопросы, и второе нужно предъявлять с составом изменений (ADR 0035).
      if (closed) {
        await writeAudit({
          actorUserId: p.id,
          action: 'waste_request.complete',
          entityType: 'waste_request',
          entityId: before.id,
          metadata: { changes: diffWasteCompletion(before.completion, closed) },
        });
      }
      // Снятый факт предъявляется тем же событием, что и предъявленный: в истории он читается
      // строками «48 м³ → —». Одной отметкой о возврате статуса тут не обойтись — иначе цифры
      // просто исчезли бы из карточки, ни разу не попав в историю.
      if (resetsWork && before.completion) {
        await writeAudit({
          actorUserId: p.id,
          action: 'waste_request.complete',
          entityType: 'waste_request',
          entityId: before.id,
          metadata: { changes: diffWasteCompletion(before.completion, null) },
        });
      }
      return (await getRequestDto(before.id))!;
    },
  );

  r.delete('/:id', { ...canDelete, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = req.params;
    const [existing] = await db.select().from(wasteRequests).where(eq(wasteRequests.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Заявка не найдена');
    assertWasteObjectScope(p, existing.objectId);
    assertObjectRoleEditable(p, existing.status, 'удалять');

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
      const p = requirePrincipal(req);
      // Строка берётся без условия по `deleted_at` намеренно: восстанавливают как раз удалённую, и
      // фильтр «только живые» отвечал бы 404 на единственную заявку, ради которой ручка заведена.
      const [existing] = await db
        .select()
        .from(wasteRequests)
        .where(eq(wasteRequests.id, req.params.id));
      if (!existing) throw err.notFound('Заявка не найдена');
      // Область — до разбора состояния, а не внутри ветки возврата: на живой заявке ручка отдаёт
      // её карточку целиком, и без проверки здесь `archive.restore` читал бы чужие заявки в обход
      // `wasteRequests.read`. Проверки те же, что у карточки (`GET /:id`), и обе работают по
      // реквизитам строки — удалённость на них не влияет.
      assertWasteObjectScope(p, existing.objectId);
      assertOperatorScope(p, existing.operatorCounterpartyId);
      if (existing.deletedAt) {
        await db
          .update(wasteRequests)
          .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
          .where(eq(wasteRequests.id, existing.id));
        await writeAudit({
          actorUserId: p.id,
          action: 'waste_request.restore',
          entityType: 'waste_request',
          entityId: existing.id,
        });
      }
      return (await getRequestDto(existing.id))!;
    },
  );

  /**
   * Удаление заявки насовсем (ADR 0070) — общая механика справочников (ADR 0060), право
   * `records.purge`, только из архива. Второй шаг после осознанного первого: пока заявка не
   * удалена, сносить нечего, и одного неверного клика для необратимого действия мало.
   *
   * Машины, талоны, история статусов и связи с файлами уходят каскадом — они существуют только
   * при заявке. Сами строки `files` каскад не трогает: их удаление вместе с заказом на снос
   * объекта в S3 повторяет то, что делает hard delete «Новой» заявки.
   */
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(wasteRequests).where(eq(wasteRequests.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      const linked = await tx
        .select({ id: files.id, objectKey: files.objectKey })
        .from(requestFiles)
        .innerJoin(files, eq(requestFiles.fileId, files.id))
        .where(eq(requestFiles.requestId, row.id));
      await tx.delete(wasteRequests).where(eq(wasteRequests.id, row.id));
      await hardDeleteFiles(tx, linked);
    },
    notFound: 'Заявка не найдена',
    stillLive: 'Заявка не в архиве — сначала удалите её',
    subject: 'заявку',
    audit: {
      action: 'waste_request.purge',
      entityType: 'waste_request',
      // Номер, площадка и статус — то, чем заявку называют: после удаления по entityId искать
      // уже нечего, а спрашивают «куда делась М-128».
      metadata: (row) => ({
        num: row.num,
        objectId: row.objectId,
        requestType: row.requestType,
        status: row.status,
      }),
    },
  });
}
