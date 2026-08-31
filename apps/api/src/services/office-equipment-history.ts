import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  can,
  compareEquipmentHistory,
  cursorOfEvent,
  encodeEquipmentHistoryCursor,
  formatServiceRequestNumber,
  historySortRank,
  isAfterEquipmentHistoryCursor,
  moscowDateKeyOf,
  officeEquipmentTitle,
  type EquipmentHistoryCursor,
  type EquipmentHistoryEventDto,
  type EquipmentHistoryPageDto,
  type RequestChangeDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  auditLog,
  constructionObjects,
  counterparties,
  departments,
  officeEquipmentMovements,
  serviceRequestItems,
  serviceRequests,
  serviceRequestStatusHistory,
  users,
} from '../db/schema';
import { serviceRequestScopeWhere } from '../lib/access';
import type { Principal } from '../auth/principal';

/**
 * Лента истории единицы оргтехники (план `office-equipment-mail-and-history-plan.md`, Р75–Р79,
 * Р81).
 *
 * Шесть источников, один поток. Сшивать их в портале нельзя: у половины событий нет времени —
 * перемещение происходит датой, истечение гарантии тоже, — и порядок, посчитанный на клиенте,
 * разошёлся бы с порядком страницы. Поэтому и порядок, и курсор живут здесь, а контракты дают
 * обеим сторонам одно правило сравнения.
 *
 * Область у ремонтной части — **область заявок**, а не справочника: у ролей отдела это разные
 * области (справочник по владельцу техники, заявки по заказчику), и показать здесь заявку соседнего
 * отдела значило бы обойти модуль через справочник.
 */

const fromObjects = alias(constructionObjects, 'history_from_objects');
const toObjects = alias(constructionObjects, 'history_to_objects');
const toDepartments = alias(departments, 'history_to_departments');
const movers = alias(users, 'history_movers');
const actors = alias(users, 'history_actors');

/**
 * Ключевые шаги заявки: полный ход остаётся в её карточке (Р78).
 *
 * **`assigned` из перечня ушёл, и лента от этого потеряла шаг «назначена»** — честно, а не «просто
 * переименовалось». Статус снят (план упрощения цикла, Р1), и назначение переходом быть перестало:
 * состав исполнителей теперь меняют, оставаясь в том же статусе. Ключевые шаги лента читает из
 * `service_request_status_history`, то есть из ПЕРЕХОДОВ, — а значит события, которое перехода не
 * делает, здесь не будет вовсе. Оставь мы значение в перечне, оно ловило бы только исторические
 * строки «Новая → Назначена» и молча делило ленту на «до правки» и «после».
 *
 * Потерю приняли осознанно (§8 «Границы»): кто ведёт заявку, по-прежнему видно в самой заявке —
 * лента единицы отвечает на вопрос «что с аппаратом происходило», и распределение работы внутри
 * службы к нему не относится. Заводить ради одного шага второй источник — строки состава
 * исполнителей рядом с переходами — значило бы удвоить сборку страницы ради события, у которого нет
 * читателя.
 */
const KEY_STEPS: ServiceRequestStatus[] = ['in_work', 'accepted', 'cancelled'];

/** События карточки, которые лента показывает жизненным циклом (Р81). */
const LIFECYCLE_ACTIONS = [
  'officeEquipment.create',
  'officeEquipment.delete',
  'officeEquipment.restore',
] as const;

const LIFECYCLE_BY_ACTION: Record<string, 'created' | 'archived' | 'restored'> = {
  'officeEquipment.create': 'created',
  'officeEquipment.delete': 'archived',
  'officeEquipment.restore': 'restored',
};

/**
 * Сколько строк берётся из каждого источника за проход. Страница собирается слиянием, и предела
 * `pageSize + 1` на источник хватает: больше страницы из одного источника всё равно не попадёт, а
 * следующий заход начнётся с курсора.
 */
function sourceLimit(pageSize: number): number {
  return pageSize + 1;
}

/** Дата события из отметки времени: день считается по Москве — им лента и датируется. */
function dayOf(at: Date): string {
  return moscowDateKeyOf(at);
}

/** Полночь дня в UTC: время у вычисляемых событий должно быть одинаковым при каждой выборке (Р79). */
function utcMidnight(day: string): string {
  return `${day}T00:00:00.000Z`;
}

interface AuditMetadata {
  changes?: RequestChangeDto[];
  warrantyChange?: { from: string | null; until: string | null };
  clearedWarranties?: { itemId: string; name: string; warrantyUntil: string | null }[];
  grantedWarranties?: { itemId: string; name: string; warrantyUntil: string | null }[];
}

function metadataOf(value: unknown): AuditMetadata {
  return value && typeof value === 'object' ? (value as AuditMetadata) : {};
}

async function loadMovements(
  equipmentId: string,
  limit: number,
): Promise<EquipmentHistoryEventDto[]> {
  const rows = await db
    .select({
      m: officeEquipmentMovements,
      fromObject: { id: fromObjects.id, code: fromObjects.code, name: fromObjects.name },
      toObject: { id: toObjects.id, code: toObjects.code, name: toObjects.name },
      toDepartmentName: toDepartments.name,
      movedByName: movers.fullName,
      requestNum: serviceRequests.num,
    })
    .from(officeEquipmentMovements)
    .innerJoin(fromObjects, eq(officeEquipmentMovements.fromObjectId, fromObjects.id))
    .innerJoin(toObjects, eq(officeEquipmentMovements.toObjectId, toObjects.id))
    .leftJoin(toDepartments, eq(officeEquipmentMovements.toDepartmentId, toDepartments.id))
    .innerJoin(movers, eq(officeEquipmentMovements.movedBy, movers.id))
    .leftJoin(serviceRequests, eq(officeEquipmentMovements.serviceRequestId, serviceRequests.id))
    .where(eq(officeEquipmentMovements.equipmentId, equipmentId))
    .orderBy(desc(officeEquipmentMovements.movedOn), desc(officeEquipmentMovements.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    kind: 'movement',
    id: row.m.id,
    sortId: `movement:${row.m.id}`,
    occurredOn: row.m.movedOn,
    recordedAt: row.m.createdAt.toISOString(),
    actorName: row.movedByName,
    fromObject: row.fromObject,
    toObject: row.toObject,
    fromLocation: row.m.fromLocation,
    toLocation: row.m.toLocation,
    fromState: row.m.fromState,
    toState: row.m.toState,
    toDepartmentName: row.toDepartmentName,
    reason: row.m.reason,
    comment: row.m.comment,
    serviceRequestId: row.m.serviceRequestId,
    serviceRequestNum: row.requestNum,
  }));
}

/** Заявки в области смотрящего — основа и для шагов, и для гарантий ремонта. */
async function visibleRequests(p: Principal, equipmentId: string, limit: number) {
  return db
    .select({
      id: serviceRequests.id,
      num: serviceRequests.num,
      status: serviceRequests.status,
      description: serviceRequests.description,
      createdAt: serviceRequests.createdAt,
      completedAt: serviceRequests.completedAt,
      totalAmount: serviceRequests.finalTotalAmount,
      serviceName: counterparties.name,
      authorName: users.fullName,
    })
    .from(serviceRequests)
    .leftJoin(counterparties, eq(serviceRequests.serviceCounterpartyId, counterparties.id))
    .leftJoin(users, eq(serviceRequests.createdBy, users.id))
    .where(
      and(
        eq(serviceRequests.officeEquipmentId, equipmentId),
        isNull(serviceRequests.deletedAt),
        serviceRequestScopeWhere(
          p,
          serviceRequests.equipmentObjectId,
          serviceRequests.customerDepartmentId,
          serviceRequests.equipmentDepartmentId,
        ),
      ),
    )
    .orderBy(desc(serviceRequests.createdAt))
    .limit(limit);
}

type VisibleRequest = Awaited<ReturnType<typeof visibleRequests>>[number];

function requestEvents(rows: VisibleRequest[]): EquipmentHistoryEventDto[] {
  return rows.map((row) => ({
    kind: 'service_request',
    id: row.id,
    sortId: `service-request:${row.id}`,
    // Заявка датируется днём закрытия, а пока она идёт — днём заведения: лента отвечает «когда это
    // случилось», и незакрытая заявка случилась в день, когда её завели.
    occurredOn: dayOf(row.completedAt ?? row.createdAt),
    recordedAt: row.createdAt.toISOString(),
    actorName: row.authorName,
    requestId: row.id,
    displayNumber: formatServiceRequestNumber(row.num),
    status: row.status,
    serviceName: row.serviceName,
    totalAmount: row.totalAmount === null ? null : Number(row.totalAmount),
    description: row.description,
  }));
}

async function loadSteps(
  rows: VisibleRequest[],
  limit: number,
): Promise<EquipmentHistoryEventDto[]> {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const steps = await db
    .select({
      id: serviceRequestStatusHistory.id,
      requestId: serviceRequestStatusHistory.requestId,
      toStatus: serviceRequestStatusHistory.toStatus,
      comment: serviceRequestStatusHistory.comment,
      changedAt: serviceRequestStatusHistory.changedAt,
      actorName: users.fullName,
    })
    .from(serviceRequestStatusHistory)
    .leftJoin(users, eq(serviceRequestStatusHistory.changedBy, users.id))
    .where(
      and(
        inArray(serviceRequestStatusHistory.requestId, [...byId.keys()]),
        inArray(serviceRequestStatusHistory.toStatus, KEY_STEPS),
      ),
    )
    .orderBy(desc(serviceRequestStatusHistory.changedAt))
    .limit(limit);

  return steps.map((step) => ({
    kind: 'service_step',
    id: step.id,
    sortId: `service-step:${step.id}`,
    occurredOn: dayOf(step.changedAt),
    recordedAt: step.changedAt.toISOString(),
    actorName: step.actorName,
    requestId: step.requestId,
    displayNumber: formatServiceRequestNumber(byId.get(step.requestId)!.num),
    toStatus: step.toStatus,
    comment: step.comment,
  }));
}

/** Записи аудита самой карточки: правки и жизненный цикл. */
async function loadCardAudit(equipmentId: string, limit: number) {
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      actorName: actors.fullName,
    })
    .from(auditLog)
    .leftJoin(actors, eq(auditLog.actorUserId, actors.id))
    .where(
      and(
        eq(auditLog.entityType, 'officeEquipment'),
        eq(auditLog.entityId, equipmentId),
        inArray(auditLog.action, ['officeEquipment.update', ...LIFECYCLE_ACTIONS]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/** Аудит заявок этой техники: оттуда приходят выданные и снятые гарантии ремонта (Р77). */
async function loadRequestAudit(rows: VisibleRequest[], limit: number) {
  if (rows.length === 0) return [];
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityId: auditLog.entityId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      actorName: actors.fullName,
    })
    .from(auditLog)
    .leftJoin(actors, eq(auditLog.actorUserId, actors.id))
    .where(
      and(
        eq(auditLog.entityType, 'serviceRequest'),
        inArray(
          auditLog.entityId,
          rows.map((row) => row.id),
        ),
        inArray(auditLog.action, [
          'serviceRequest.complete',
          'serviceRequest.rework',
          'serviceRequest.status',
        ]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/**
 * Действующая гарантия поставщика: строка «истекла» появляется в ленте только тогда, когда день
 * уже прошёл. Своих записей это событие не создаёт — оно выводится из даты, и вторая точка правды
 * разошлась бы с первой же правкой карточки (Р77).
 */
function expiredWarrantyEvents(
  equipment: {
    id: string;
    name: string;
    inventoryNumber: string;
    serialNumber: string;
    warrantyUntil: string | null;
  },
  today: string,
): EquipmentHistoryEventDto[] {
  if (!equipment.warrantyUntil || equipment.warrantyUntil > today) return [];
  return [
    {
      kind: 'warranty',
      id: `warranty-expired:equipment:${equipment.id}`,
      sortId: `warranty-expired:equipment:${equipment.id}`,
      occurredOn: equipment.warrantyUntil,
      recordedAt: utcMidnight(equipment.warrantyUntil),
      actorName: null,
      source: 'equipment',
      action: 'expired',
      subject: officeEquipmentTitle(equipment),
      from: null,
      until: equipment.warrantyUntil,
      requestId: null,
      displayNumber: null,
    },
  ];
}

/** Истёкшие гарантии ремонтов — по действующим строкам смет выполненных позиций. */
async function loadExpiredItemWarranties(
  rows: VisibleRequest[],
  today: string,
): Promise<EquipmentHistoryEventDto[]> {
  if (rows.length === 0) return [];
  const items = await db
    .select({
      id: serviceRequestItems.id,
      requestId: serviceRequestItems.requestId,
      name: serviceRequestItems.name,
      warrantyUntil: serviceRequestItems.warrantyUntil,
    })
    .from(serviceRequestItems)
    .where(
      and(
        inArray(
          serviceRequestItems.requestId,
          rows.map((row) => row.id),
        ),
        lte(serviceRequestItems.warrantyUntil, today),
      ),
    );

  const byId = new Map(rows.map((row) => [row.id, row]));
  return items
    .filter((item) => item.warrantyUntil)
    .map((item) => ({
      kind: 'warranty',
      id: `warranty-expired:item:${item.id}`,
      sortId: `warranty-expired:item:${item.id}`,
      occurredOn: item.warrantyUntil!,
      recordedAt: utcMidnight(item.warrantyUntil!),
      actorName: null,
      source: 'item',
      action: 'expired',
      subject: item.name,
      from: null,
      until: item.warrantyUntil,
      requestId: item.requestId,
      displayNumber: formatServiceRequestNumber(byId.get(item.requestId)!.num),
    }));
}

/**
 * Собирает страницу ленты.
 *
 * Каждый источник читается своим запросом с пределом «страница плюс один», результаты сливаются
 * общим правилом порядка и режутся до размера страницы. `UNION ALL` в SQL не делается по той же
 * причине, что у реестра гарантий: источники разнородны — часть событий вовсе вычисляется, — а
 * объёмы на единицу измеряются десятками строк.
 */
export async function loadEquipmentHistoryPage(
  p: Principal,
  equipment: {
    id: string;
    name: string;
    inventoryNumber: string;
    serialNumber: string;
    warrantyUntil: string | null;
  },
  opts: { cursor: EquipmentHistoryCursor | null; pageSize: number },
): Promise<EquipmentHistoryPageDto> {
  const limit = sourceLimit(opts.pageSize);
  const today = moscowDateKeyOf(new Date());
  const serviceVisible = can(p, 'serviceRequests.read');

  const events: EquipmentHistoryEventDto[] = [];
  events.push(...(await loadMovements(equipment.id, limit)));
  events.push(...cardAuditEvents(await loadCardAudit(equipment.id, limit), equipment));
  events.push(...expiredWarrantyEvents(equipment, today));

  if (serviceVisible) {
    const requests = await visibleRequests(p, equipment.id, limit);
    events.push(...requestEvents(requests));
    events.push(...(await loadSteps(requests, limit)));
    events.push(...requestWarrantyEvents(await loadRequestAudit(requests, limit), requests));
    events.push(...(await loadExpiredItemWarranties(requests, today)));
  }

  // Курсор отсекает уже показанное тем же правилом, каким события сортируются: разойдись эти два
  // места — страница «после» вернула бы то, что человек уже видел, либо пропустила бы строку.
  const filtered = opts.cursor
    ? events.filter((event) => isAfterEquipmentHistoryCursor(event, opts.cursor!))
    : events;
  filtered.sort(compareEquipmentHistory);

  const page = filtered.slice(0, opts.pageSize);
  const hasMore = filtered.length > page.length;
  const last = page[page.length - 1];
  return {
    items: page,
    hasMore,
    nextCursor: hasMore && last ? encodeEquipmentHistoryCursor(cursorOfEvent(last)) : null,
    serviceVisible,
  };
}

/** Правки карточки и её жизненный цикл — из одного набора записей аудита. */
function cardAuditEvents(
  rows: Awaited<ReturnType<typeof loadCardAudit>>,
  equipment: { name: string; inventoryNumber: string; serialNumber: string },
): EquipmentHistoryEventDto[] {
  const events: EquipmentHistoryEventDto[] = [];
  for (const row of rows) {
    const day = dayOf(row.createdAt);
    const recordedAt = row.createdAt.toISOString();
    const lifecycle = LIFECYCLE_BY_ACTION[row.action];
    if (lifecycle) {
      events.push({
        kind: 'card_lifecycle',
        id: row.id,
        sortId: `card-lifecycle:${row.id}`,
        occurredOn: day,
        recordedAt,
        actorName: row.actorName,
        action: lifecycle,
      });
      continue;
    }

    const meta = metadataOf(row.metadata);
    // Записи, сделанные до появления диффа, деталей не несут — в ленте это «правка без
    // подробностей», и притворяться, что мы знаем больше, нечем.
    if (meta.changes && meta.changes.length > 0) {
      events.push({
        kind: 'card_change',
        id: row.id,
        sortId: `card-change:${row.id}`,
        occurredOn: day,
        recordedAt,
        actorName: row.actorName,
        changes: meta.changes,
      });
    }
    if (meta.warrantyChange) {
      const { from, until } = meta.warrantyChange;
      events.push({
        kind: 'warranty',
        id: `${row.id}:warranty`,
        sortId: `warranty-card:${row.id}`,
        occurredOn: day,
        recordedAt,
        actorName: row.actorName,
        source: 'equipment',
        action: until === null ? 'cleared' : from === null ? 'set' : 'moved',
        subject: officeEquipmentTitle(equipment),
        from,
        until,
        requestId: null,
        displayNumber: null,
      });
    }
  }
  return events;
}

/** Гарантии ремонта: выданные закрытием и снятые возвратом факта — снимками из аудита заявки. */
function requestWarrantyEvents(
  rows: Awaited<ReturnType<typeof loadRequestAudit>>,
  requests: VisibleRequest[],
): EquipmentHistoryEventDto[] {
  const byId = new Map(requests.map((row) => [row.id, row]));
  const events: EquipmentHistoryEventDto[] = [];
  for (const row of rows) {
    const request = row.entityId ? byId.get(row.entityId) : undefined;
    if (!request) continue;
    const meta = metadataOf(row.metadata);
    const day = dayOf(row.createdAt);
    const recordedAt = row.createdAt.toISOString();
    const displayNumber = formatServiceRequestNumber(request.num);

    for (const granted of meta.grantedWarranties ?? []) {
      events.push({
        kind: 'warranty',
        id: `${row.id}:${granted.itemId}`,
        sortId: `warranty-granted:${row.id}:${granted.itemId}`,
        occurredOn: day,
        recordedAt,
        actorName: row.actorName,
        source: 'item',
        action: 'set',
        subject: granted.name,
        from: null,
        until: granted.warrantyUntil,
        requestId: request.id,
        displayNumber,
      });
    }
    for (const cleared of meta.clearedWarranties ?? []) {
      events.push({
        kind: 'warranty',
        id: `${row.id}:${cleared.itemId}`,
        sortId: `warranty-cleared:${row.id}:${cleared.itemId}`,
        occurredOn: day,
        recordedAt,
        actorName: row.actorName,
        source: 'item',
        action: 'cleared',
        subject: cleared.name,
        from: cleared.warrantyUntil,
        until: null,
        requestId: request.id,
        displayNumber,
      });
    }
  }
  return events;
}

/**
 * Вся лента для выгрузки (Р80): тот же сборщик, та же область, но без курсора и с потолком.
 * Упёрлись в потолок — вызывающий обязан сказать об этом в файле, а не молча обрезать отчёт.
 */
export async function loadEquipmentHistoryAll(
  p: Principal,
  equipment: Parameters<typeof loadEquipmentHistoryPage>[1],
  limit: number,
): Promise<{ items: EquipmentHistoryEventDto[]; truncated: boolean }> {
  const page = await loadEquipmentHistoryPage(p, equipment, { cursor: null, pageSize: limit });
  return { items: page.items, truncated: page.hasMore };
}

/** Номер вида события — им курсор и упорядочивается; вынесено, чтобы не звать контракты дважды. */
export const historyRank = historySortRank;

/** Заглушка на случай пустых выборок: SQL-конструктор требует непустой массив. */
export const NO_ROWS = sql`false`;
