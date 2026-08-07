import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  extendBlocker,
  formatVehicleRequestNumber,
  formatWeeklyRequestNumber,
  moscowDateKeyOf,
  newItemBlocker,
  orderEffectiveDateTo,
  sourceItemBlocker,
  weeklyWeekBlocker,
  weeklyWeekBounds,
  weeklyWeekLabel,
  type WeeklyApplyItemResultDto,
  type WeeklyApplyResultDto,
  type WeeklyRequestScope,
  type WeeklySourceOrder,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleRequestAssignments,
  vehicleRequestEarlyEndings,
  vehicleRequests,
  vehicleTypes,
  weeklyVehicleRequestHistory,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { extendSpecialEquipmentPeriod } from './vehicle-request-period';
import { createSpecialEquipmentRequest } from './vehicle-request-create';
import type { Esm2SyncResult } from './waybill-esm2';

/**
 * Применение недельной заявки (ADR 0085, план §8): виза той же транзакцией двигает сроки и
 * порождает заказы.
 *
 * Отдельного действия «применить» нет намеренно — оно создавало бы состояние «завизировано, но
 * ничего не произошло». Отсюда весь порядок работы этого файла: применение трогает **чужие
 * конкурентные сущности**, и одной блокировки шапки ему мало.
 *
 *   1. `FOR UPDATE` шапки, сверка версии и статуса `pending` (повторная виза не применяет дважды);
 *   2. `FOR UPDATE` затронутых заказов и их деталей **в порядке возрастания id** — две недельные
 *      заявки, взявшие пересекающиеся заказы, иначе встанут во взаимный клинч;
 *   3. предвалидация **всех** строк предикатами контрактов, до первой записи;
 *   4. не годна ни одна — 422 и полный откат: документа-основания без единого следствия не бывает;
 *   5. записи, снимки, статус, версия и событие истории.
 *
 * Бизнес-негодная строка помечается `skipped` с причиной и неделю не роняет; техническая ошибка
 * откатывает всё.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Итог применения плюс то, что нужно позвать после транзакции: аудит бумаги по каждому заказу. */
export interface WeeklyApplyOutcome {
  result: WeeklyApplyResultDto;
  /** Сверки ЭСМ-2 по заказам — уходят в `auditEsm2Sync` уже за пределами транзакции. */
  esm2: { requestId: string; sync: Esm2SyncResult }[];
}

/** Заказ под блокировкой: левая сторона всех предикатов плюс то, что нужно снимку и записи. */
interface LockedOrder extends WeeklySourceOrder {
  num: number;
  version: number;
  vehicleId: string | null;
  pendingEarlyEndDate: string | null;
}

/** Строка состава, прочитанная под блокировкой шапки. */
type ItemRow = typeof weeklyVehicleRequestItems.$inferSelect;

/** Решение по строке: что записать и что показать. */
interface Decision {
  item: ItemRow;
  /** Причина непригодности; `null` — строка применяется. */
  skipReason: string | null;
  order: LockedOrder | null;
}

/**
 * Позиция классификатора глазами `newItemBlocker`. Читается справочником — тем же, каким её
 * проверяет форма заказа: строка `new` не должна молча породить заказ на погашенный тип.
 */
async function loadClassification(
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
    // Активных категорий нет вовсе — значит, у типа их «нет» и для заказа: погашенная позиция
    // выбора не предлагает (тем же условием живёт `resolveClassification`).
    hasCategories: categories.some((c) => c.isActive),
    categoryIsActive: categoryId ? !!chosen?.isActive : null,
  };
}

/**
 * Заказы состава под блокировкой. Порядок обязателен и задаётся `ORDER BY id`: блокировка ложится
 * в порядке выдачи строк, и общий для всех недельных заявок порядок исключает взаимный клинч.
 *
 * Деталь срока блокируется отдельным запросом и после заказов: `date_to` живёт в ней, и читать её
 * без блокировки значило бы сверять `expected_date_to` со сроком, который правят прямо сейчас.
 */
async function lockOrders(tx: Tx, ids: string[]): Promise<Map<string, LockedOrder>> {
  const locked = new Map<string, LockedOrder>();
  if (ids.length === 0) return locked;

  const heads = await tx
    .select({
      id: vehicleRequests.id,
      num: vehicleRequests.num,
      objectId: vehicleRequests.objectId,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      version: vehicleRequests.version,
    })
    .from(vehicleRequests)
    .where(inArray(vehicleRequests.id, ids))
    .orderBy(asc(vehicleRequests.id))
    .for('update');

  const details = await tx
    .select({
      requestId: specialEquipmentRequestDetails.requestId,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
    })
    .from(specialEquipmentRequestDetails)
    .where(inArray(specialEquipmentRequestDetails.requestId, ids))
    .orderBy(asc(specialEquipmentRequestDetails.requestId))
    .for('update');
  const detailByRequest = new Map(details.map((d) => [d.requestId, d]));

  // Назначение и ожидающий отъезд читаются без блокировки: назначенную машину недельная заявка не
  // трогает (замена техники — отдельное решение со своей визой, ADR 0048), а запрос на отъезд
  // снимается по заказу, уже взятому `FOR UPDATE`.
  const assignments = await tx
    .select({
      requestId: vehicleRequestAssignments.requestId,
      vehicleId: vehicleRequestAssignments.vehicleId,
    })
    .from(vehicleRequestAssignments)
    .where(inArray(vehicleRequestAssignments.requestId, ids));
  const vehicleByRequest = new Map(assignments.map((a) => [a.requestId, a.vehicleId]));

  const earlyEnds = await tx
    .select({
      requestId: vehicleRequestEarlyEndings.requestId,
      newDateTo: vehicleRequestEarlyEndings.newDateTo,
    })
    .from(vehicleRequestEarlyEndings)
    .where(
      and(
        inArray(vehicleRequestEarlyEndings.requestId, ids),
        eq(vehicleRequestEarlyEndings.status, 'pending'),
      ),
    );
  const earlyEndByRequest = new Map(earlyEnds.map((e) => [e.requestId, e.newDateTo]));

  for (const head of heads) {
    const detail = detailByRequest.get(head.id);
    locked.set(head.id, {
      id: head.id,
      num: head.num,
      objectId: head.objectId,
      requestType: head.requestType,
      status: head.status,
      deletedAt: head.deletedAt ? head.deletedAt.toISOString() : null,
      // Заказа без детали срока у спецтехники не бывает; у грузоперевозки её нет вовсе, и такую
      // строку отбракует `sourceItemBlocker` по типу заявки — раньше, чем срок понадобится.
      dateFrom: detail?.dateFrom ?? '',
      dateTo: detail?.dateTo ?? null,
      hasAssignment: vehicleByRequest.has(head.id),
      version: head.version,
      vehicleId: vehicleByRequest.get(head.id) ?? null,
      pendingEarlyEndDate: earlyEndByRequest.get(head.id) ?? null,
    });
  }
  return locked;
}

/** Почему строка не применяется; `null` — применяется. Порядок проверок — от общего к частному. */
async function decide(
  tx: Tx,
  item: ItemRow,
  scope: WeeklyRequestScope,
  orders: Map<string, LockedOrder>,
): Promise<Decision> {
  if (item.kind === 'new') {
    const classification = await loadClassification(
      tx,
      item.vehicleTypeId!,
      item.vehicleCategoryId,
    );
    const blocker = newItemBlocker(
      {
        vehicleTypeId: item.vehicleTypeId!,
        vehicleCategoryId: item.vehicleCategoryId,
        dateFrom: item.dateFrom!,
        dateTo: item.dateTo!,
        responsibleName: item.responsibleName,
        responsiblePhone: item.responsiblePhone,
        deliveryNeeded: item.deliveryNeeded,
        deliveryFrom: item.deliveryFrom,
      },
      scope,
      classification,
    );
    return { item, skipReason: blocker, order: null };
  }

  const order = orders.get(item.sourceRequestId!);
  // Заказа нет в выборке — его снесли насовсем между сборкой и визой (`purge`, ADR 0070). Уборка
  // строк должна была снять эту строку и поднять версию шапки, но полагаться на это нельзя:
  // применение отвечает за то, что оно пишет.
  if (!order) return { item, skipReason: 'Заказ удалён из портала', order: null };

  const blocker =
    item.kind === 'extend'
      ? extendBlocker(order, scope, item.expectedDateTo, item.dateTo!)
      : sourceItemBlocker(order, scope, item.expectedDateTo);
  if (blocker) return { item, skipReason: blocker, order };

  // Молчаливого снятия ожидающего отъезда здесь не бывает (план Р15): в недельной заявке состав
  // предвыбран целиком, и снятие десятка чужих решений оптом — не то, на что подписывался
  // визирующий. Отъезд не мешает только строке «уезжает»: она с ним не спорит.
  if (item.kind === 'extend' && order.pendingEarlyEndDate && !item.earlyEndOverride) {
    return {
      item,
      skipReason: `На заказе ждёт визы досрочный отъезд ${order.pendingEarlyEndDate} — решите его или подтвердите продление в составе`,
      order,
    };
  }
  return { item, skipReason: null, order };
}

export async function applyWeeklyRequest(
  tx: Tx,
  params: { weeklyRequestId: string; expectedVersion: number; actor: { id: string } },
): Promise<WeeklyApplyOutcome> {
  const [header] = await tx
    .select({
      id: weeklyVehicleRequests.id,
      num: weeklyVehicleRequests.num,
      objectId: weeklyVehicleRequests.objectId,
      weekStart: weeklyVehicleRequests.weekStart,
      status: weeklyVehicleRequests.status,
      version: weeklyVehicleRequests.version,
    })
    .from(weeklyVehicleRequests)
    .where(eq(weeklyVehicleRequests.id, params.weeklyRequestId))
    .for('update');
  if (!header) throw err.notFound('Недельная заявка не найдена');
  // Версия сверяется здесь, а не в маршруте: согласуют ровно тот состав, который видел визирующий.
  if (header.version !== params.expectedVersion) throw err.conflict();
  if (header.status !== 'pending') {
    throw err.unprocessable(
      header.status === 'applied'
        ? 'Недельная заявка уже применена'
        : 'Применяется только заявка, поданная на визу',
    );
  }

  // Пятая точка проверки недели (план §8): черновик, заведённый в четверг на следующую неделю,
  // спокойно доживает до её понедельника, и без проверки здесь виза продлила бы сроки задним
  // числом относительно собственного правила портала.
  const today = moscowDateKeyOf(new Date());
  const weekBlocker = weeklyWeekBlocker(header.weekStart, today);
  if (weekBlocker) throw err.unprocessable(weekBlocker);

  const [object] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, header.objectId));
  const bounds = weeklyWeekBounds(header.weekStart);
  const scope: WeeklyRequestScope = {
    objectId: header.objectId,
    weekStart: bounds.from,
    weekEnd: bounds.to,
    objectIsActive: !!object?.isActive,
    today,
  };

  const items = await tx
    .select()
    .from(weeklyVehicleRequestItems)
    .where(eq(weeklyVehicleRequestItems.weeklyRequestId, header.id))
    .orderBy(asc(weeklyVehicleRequestItems.position));

  const sourceIds = [...new Set(items.map((i) => i.sourceRequestId).filter((v) => v !== null))];
  const orders = await lockOrders(tx, sourceIds);

  // Предвалидация **всех** строк до первой записи: бизнес-негодная строка не должна ронять неделю,
  // но и узнавать о ней после половины изменений нельзя.
  const decisions: Decision[] = [];
  for (const item of items) {
    decisions.push(await decide(tx, item, scope, orders));
  }

  const applicable = decisions.filter((d) => d.skipReason === null);
  if (applicable.length === 0) {
    // Причины считаются в памяти и уходят в ответ: транзакция откатывается целиком, `skipped` в
    // строках не сохраняется. Хранимый результат бывает только у применённой заявки — у
    // оставшейся на визе объяснять нечего, она вернётся сюда же после правки состава.
    const reasons = decisions.map((d) => d.skipReason).filter((r): r is string => !!r);
    throw err.unprocessable(
      `Ни одна строка ${formatWeeklyRequestNumber(header.num)} не применима: ${
        reasons.length > 0 ? reasons.join('; ') : 'состав пуст'
      }`,
    );
  }

  const appliedAt = new Date();
  const results: WeeklyApplyItemResultDto[] = [];
  const esm2: { requestId: string; sync: Esm2SyncResult }[] = [];
  const reason = `Недельная заявка ${formatWeeklyRequestNumber(header.num)} (${weeklyWeekLabel(header.weekStart)})`;

  for (const decision of decisions) {
    const { item, order } = decision;
    if (decision.skipReason !== null) {
      await tx
        .update(weeklyVehicleRequestItems)
        .set({ result: 'skipped', skipReason: decision.skipReason })
        .where(eq(weeklyVehicleRequestItems.id, item.id));
      results.push({
        itemId: item.id,
        kind: item.kind,
        result: 'skipped',
        requestId: order?.id ?? null,
        displayNumber: order ? formatVehicleRequestNumber(order.num) : null,
        previousDateTo: null,
        newDateTo: null,
        skipReason: decision.skipReason,
      });
      continue;
    }

    if (item.kind === 'extend') {
      const extended = await extendSpecialEquipmentPeriod(tx, {
        requestId: order!.id,
        // Версия берётся из только что прочитанного под блокировкой заказа, а не из строки
        // состава: после `FOR UPDATE` условная запись защищает от потерянного перечитывания, а не
        // от конкурента — тот уже ждёт на блокировке.
        expectedVersion: order!.version,
        newDateTo: item.dateTo!,
        actor: params.actor,
        reason: `${reason}: срок продлён`,
        dropPendingEarlyEnd: item.earlyEndOverride,
      });
      await tx
        .update(weeklyVehicleRequestItems)
        .set({
          result: 'extended',
          previousDateTo: extended.previousDateTo,
          appliedSourceVersion: order!.version,
          snapshotVehicleId: order!.vehicleId,
        })
        .where(eq(weeklyVehicleRequestItems.id, item.id));
      esm2.push({ requestId: order!.id, sync: extended.esm2 });
      results.push({
        itemId: item.id,
        kind: 'extend',
        result: 'extended',
        requestId: order!.id,
        displayNumber: formatVehicleRequestNumber(order!.num),
        previousDateTo: extended.previousDateTo,
        newDateTo: item.dateTo,
        skipReason: '',
      });
      continue;
    }

    if (item.kind === 'leave') {
      // С заказом не делается ничего: его срок кончится сам. Строка остаётся решением и задачей
      // диспетчеру оформить вывоз — снимок отвечает на вопрос «какая машина и до какого числа
      // стояла», который к ней придут задавать через месяц.
      const last = orderEffectiveDateTo(order!);
      await tx
        .update(weeklyVehicleRequestItems)
        .set({
          result: 'left',
          previousDateTo: last,
          appliedSourceVersion: order!.version,
          snapshotVehicleId: order!.vehicleId,
        })
        .where(eq(weeklyVehicleRequestItems.id, item.id));
      results.push({
        itemId: item.id,
        kind: 'leave',
        result: 'left',
        requestId: order!.id,
        displayNumber: formatVehicleRequestNumber(order!.num),
        previousDateTo: last,
        newDateTo: null,
        skipReason: '',
      });
      continue;
    }

    // `new`: обычный заказ спецтехники, уже завизированный визой недели (план Р8). Второй визы он
    // не спрашивает — но слететь она с него может позже, обычной правкой без права визы.
    const createdId = await createSpecialEquipmentRequest(tx, {
      objectId: header.objectId,
      vehicleTypeId: item.vehicleTypeId!,
      vehicleCategoryId: item.vehicleCategoryId,
      dateFrom: item.dateFrom!,
      dateTo: item.dateTo,
      responsibleName: item.responsibleName,
      responsiblePhone: item.responsiblePhone,
      comment: item.comment,
      createdBy: params.actor.id,
      approvedBy: params.actor.id,
      approvedAt: appliedAt,
    });
    const [created] = await tx
      .select({ num: vehicleRequests.num })
      .from(vehicleRequests)
      .where(eq(vehicleRequests.id, createdId));
    await tx
      .update(weeklyVehicleRequestItems)
      .set({ result: 'created', createdRequestId: createdId })
      .where(eq(weeklyVehicleRequestItems.id, item.id));
    results.push({
      itemId: item.id,
      kind: 'new',
      result: 'created',
      requestId: createdId,
      displayNumber: created ? formatVehicleRequestNumber(created.num) : null,
      previousDateTo: null,
      newDateTo: item.dateTo,
      skipReason: '',
    });
  }

  const skipped = results.filter((r) => r.result === 'skipped').length;
  const [bumped] = await tx
    .update(weeklyVehicleRequests)
    .set({
      status: 'applied',
      approvedBy: params.actor.id,
      approvedAt: appliedAt,
      appliedAt,
      updatedBy: params.actor.id,
      updatedAt: appliedAt,
      version: header.version + 1,
    })
    .where(
      and(
        eq(weeklyVehicleRequests.id, header.id),
        eq(weeklyVehicleRequests.version, header.version),
      ),
    )
    .returning({ id: weeklyVehicleRequests.id });
  if (!bumped) throw err.conflict();

  // История — той же транзакцией, а не только аудитом (план Р17): `writeAudit` намеренно не роняет
  // операцию при сбое, и тогда причина и сам факт перехода могли бы исчезнуть.
  await tx.insert(weeklyVehicleRequestHistory).values({
    weeklyRequestId: header.id,
    event: 'status',
    fromStatus: 'pending',
    toStatus: 'applied',
    changedBy: params.actor.id,
    payload: { applied: results.length - skipped, skipped, items: results },
  });

  return {
    result: {
      weeklyRequestId: header.id,
      status: 'applied',
      applied: results.length - skipped,
      skipped,
      items: results,
      esm2: esm2.map((e) => ({
        requestId: e.requestId,
        cancelled: e.sync.cancelled,
        issued: e.sync.issued.length,
      })),
    },
    esm2,
  };
}
