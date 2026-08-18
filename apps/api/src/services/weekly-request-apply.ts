import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  type BackdateAccess,
  extendBlocker,
  formatVehicleRequestNumber,
  formatWeeklyRequestNumber,
  moscowDateKeyOf,
  newItemBlocker,
  orderEffectiveDateTo,
  sourceItemBlocker,
  WEEKLY_SELECTABLE_WEEKS,
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
  vehicleRequestStatusHistory,
  vehicleRoutes,
  vehicleTypes,
  weeklyVehicleRequestHistory,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import { extendSpecialEquipmentPeriod } from './vehicle-request-period';
import { createSpecialEquipmentRequest } from './vehicle-request-create';
import { loadLeftBy } from './weekly-request-blockers';
import { esm2SheetsOfRequests, type Esm2SyncResult } from './waybill-esm2';

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

/**
 * Контекст проверенной операции коррекции (ADR 0101): им и только им применение соглашается
 * тронуть прошедшую неделю.
 *
 * Устроен как у сверки ЭСМ-2 (`syncEsm2Waybills`, параметр `correction`) и по той же причине:
 * признак приходит **от сервера**, который право `waybills.correct`, причину и границу глубины уже
 * спросил, а не из тела запроса — тело перечисляет намерение, а не разрешение. Собрать его внутри
 * сервиса нечем: субъекта здесь нет, и знать о нём применение не должно.
 */
export interface WeeklyApplyCorrection {
  /** Строка `waybill_corrections` этой операции: на неё сошлются оба листа каждого заказа. */
  id: string;
  /**
   * Что субъекту позволено задним числом — та же пара прав, которую читает `backdateGuard`.
   *
   * Передаётся целиком, а не сведёнными к «прошлое можно»: пятая точка проверки недели (§8 плана)
   * прогоняет тот же `weeklyWeekBlocker`, что и остальные четыре, и глубина обязана считаться под
   * блокировкой теми же флагами, какими её посчитал вердикт операции. Свести их к булеву значению
   * значило бы пропустить под блокировкой неделю, на которую вердикт ответил «слишком давно».
   */
  access: BackdateAccess;
  /**
   * Причина операции, как её написал человек. Уходит в аннулированные и выписанные листы (Р35
   * ADR 0101) и в историю порождённых заказов: разрыв нумерации бланков за прошедшую неделю и
   * заказ, заведённый задним числом, через месяцы не объясняются больше ничем.
   */
  reason: string;
  /**
   * Листы ЭСМ-2 отработанных недель, названные к перевыписке. Плоским списком на всю заявку —
   * разложить его по заказам умеет только тот, кто держит состав, то есть это применение.
   */
  unlockWaybillIds: readonly string[];
}

/**
 * Разложить названные листы по заказам состава и отказать на чужом.
 *
 * Принадлежность проверяет сервер, а не клиент (Р11 ADR 0101): список из тела — перечень
 * намерения, и лист чужой заявки в нём означал бы, что коррекция недели жжёт номер, к этой неделе
 * отношения не имеющий. Проверка стоит **до первой правки** и под теми же блокировками, что и
 * весь разбор состава.
 *
 * Названный лист заказа, чья строка потом окажется непригодной, отказом не считается: неделя из-за
 * одной выбывшей строки не падает (§8 плана), а причина выбывания и так показывается на самой
 * строке. Такой лист просто останется нетронутым — как если бы его не называли.
 */
async function splitUnlockedSheets(
  tx: Tx,
  sourceIds: string[],
  unlockWaybillIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byRequest = new Map<string, string[]>();
  if (unlockWaybillIds.length === 0) return byRequest;

  const sheets = await esm2SheetsOfRequests(tx, sourceIds);
  const owner = new Map(sheets.map((s) => [s.id, s.requestId]));
  const unknown = unlockWaybillIds.filter((id) => !owner.has(id));
  if (unknown.length > 0) {
    throw err.unprocessable(
      unknown.length === 1
        ? 'Названный лист не найден среди действующих ЭСМ-2 заказов этой недели — обновите карточку: его успели аннулировать либо он принадлежит другому заказу'
        : `Названные листы (${unknown.length}) не найдены среди действующих ЭСМ-2 заказов этой недели — обновите карточку: их успели аннулировать либо они принадлежат другим заказам`,
      { unlockWaybillIds: 'Лист не найден' },
    );
  }
  for (const id of unlockWaybillIds) {
    const requestId = owner.get(id)!;
    byRequest.set(requestId, [...(byRequest.get(requestId) ?? []), id]);
  }
  return byRequest;
}

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
async function lockOrders(
  tx: Tx,
  ids: string[],
  exceptWeeklyId: string,
): Promise<Map<string, LockedOrder>> {
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

  // Назначение, вывоз и ожидающий отъезд читаются без блокировки: ни одну из этих сущностей
  // недельная заявка не трогает — назначенную машину меняет отдельное решение со своей визой
  // (ADR 0048), рейс-перегон ведёт диспетчер, а запрос на отъезд снимается по заказу, уже взятому
  // `FOR UPDATE`. Читаются они здесь потому, что каждая из них делает строку негодной, и узнать об
  // этом надо **на применении**: между подачей и визой проходят часы, и вывоз вполне успевают
  // оформить.
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

  // Вывоз — рейс-перегон по заказу; на заказ он один (частичный
  // `vehicle_routes_source_request_unique`), поэтому одной строкой на заказ и читается.
  const pickups = await tx
    .select({
      requestId: vehicleRoutes.sourceRequestId,
      num: vehicleRoutes.num,
      routeDate: vehicleRoutes.routeDate,
    })
    .from(vehicleRoutes)
    .where(and(inArray(vehicleRoutes.sourceRequestId, ids), eq(vehicleRoutes.purpose, 'pickup')));
  const pickupByRequest = new Map(
    pickups
      .filter((r) => r.requestId !== null)
      .map((r) => [r.requestId!, { num: r.num, routeDate: r.routeDate }] as const),
  );

  // Чужое «уезжает» — правилом «последняя применённая неделя» одним на все точки (`loadLeftBy`):
  // применённых недель с решением об отъезде по одному заказу бывает несколько.
  const leftBy = await loadLeftBy(tx, ids, exceptWeeklyId);

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
      pickupRoute: pickupByRequest.get(head.id) ?? null,
      leftBy: leftBy.get(head.id) ?? null,
      pendingEarlyEndDate: earlyEndByRequest.get(head.id) ?? null,
      version: head.version,
      vehicleId: vehicleByRequest.get(head.id) ?? null,
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

  // Оформленный вывоз, чужое «уезжает» и ожидающий визы отъезд сидят внутри `sourceItemBlocker`, и
  // спрашиваются здесь ровно поэтому: между подачей и визой проходят часы, и вывоз, оформленный в
  // эти часы, обязан выбросить строку с той же причиной, которую площадка увидела бы при сборке.
  const blocker =
    item.kind === 'extend'
      ? extendBlocker(order, scope, item.expectedDateTo, item.dateTo!)
      : sourceItemBlocker(order, scope, item.expectedDateTo);
  return { item, skipReason: blocker, order };
}

export async function applyWeeklyRequest(
  tx: Tx,
  params: {
    weeklyRequestId: string;
    expectedVersion: number;
    actor: { id: string };
    /**
     * Проверенная операция коррекции; не передана — прошлое закрыто, и просроченная неделя сюда не
     * доходит вовсе (пятая точка проверки ниже).
     */
    correction?: WeeklyApplyCorrection;
  },
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
  //
  // Прошлое пропускается только с контекстом операции и ровно на его глубину: тем же правилом и
  // теми же флагами, какими вердикт операции разрешил её вообще. Без контекста правило прежнее —
  // просроченная неделя останавливается здесь, под блокировкой шапки, даже если четыре проверки до
  // неё кто-то обошёл.
  const today = moscowDateKeyOf(new Date());
  const weekBlocker = weeklyWeekBlocker(
    header.weekStart,
    today,
    WEEKLY_SELECTABLE_WEEKS,
    params.correction?.access,
  );
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
  const orders = await lockOrders(tx, sourceIds, header.id);
  // Названные листы раскладываются по заказам до первой правки: чужой номер обязан отбиться
  // отказом, а не сгореть где-то в середине проведения.
  const unlockByRequest = await splitUnlockedSheets(
    tx,
    sourceIds,
    params.correction?.unlockWaybillIds ?? [],
  );

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
        earlyEndDropped: false,
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
        // Причина операции дописывается к причине продления, а не заменяет её (Р35 ADR 0101): у
        // сгоревшего номера обязаны читаться оба ответа — каким документом двинулся срок и почему
        // это сделано задним числом. Одна из двух половин по отдельности объясняет ровно половину.
        reason: params.correction
          ? `${reason}: срок продлён задним числом — ${params.correction.reason}`
          : `${reason}: срок продлён`,
        // Чужой запрос на досрочный отъезд неделя не снимает никогда: единица с нерешённым
        // запросом в состав не идёт вовсе (`sourceItemBlocker`), и второго — молчаливого — способа
        // отменить чужое решение у модуля быть не должно. Умолчания у параметра нет намеренно
        // (`vehicle-request-period.ts`): ответ на этот вопрос даёт вызывающий, а не забывчивость.
        dropPendingEarlyEnd: false,
        // Контекст операции — иначе продление в прошедшую неделю оставило бы заказ с новым сроком
        // и без бумаги за отработанные дни: сверка кончившуюся неделю сама не выписывает (Р21
        // ADR 0101). Названные листы идут сюда уже разложенными по заказам.
        ...(params.correction
          ? {
              correction: {
                id: params.correction.id,
                unlockWaybillIds: unlockByRequest.get(order!.id) ?? [],
              },
            }
          : {}),
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
      // Молчаливая сверка записью не считается: у арендного заказа листов нет вовсе, и пустая
      // строка «аннулировано 0, выписано 0» читалась бы в ответе как расход бланков, которого
      // не было. Тем же правилом молчит `auditEsm2Sync` (ADR 0060 п. 3).
      if (extended.esm2.cancelled.length > 0 || extended.esm2.issued.length > 0) {
        esm2.push({ requestId: order!.id, sync: extended.esm2 });
      }
      results.push({
        itemId: item.id,
        kind: 'extend',
        result: 'extended',
        requestId: order!.id,
        displayNumber: formatVehicleRequestNumber(order!.num),
        previousDateTo: extended.previousDateTo,
        newDateTo: item.dateTo,
        skipReason: '',
        // Ответ общего сервиса, а не своё вычисление: здесь он всегда `false` — недельная заявка
        // чужих запросов на отъезд не снимает, — но пересказывать это константой значило бы
        // разойтись с сервисом молча, если правило когда-нибудь изменится в нём.
        earlyEndDropped: extended.earlyEndDropped,
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
        earlyEndDropped: false,
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
    /*
     * Заказ с датой начала в прошлом — законный исход проведения просроченной недели: техника на
     * площадке в те дни и правда стояла, а документа-основания у неё не было. Ни один предикат
     * такую дату не отбивает (`newItemBlocker` держит её внутри недели заявки, а сама неделя уже
     * проверена глубиной права), и это осознанно.
     *
     * Но прочесть по карточке «заказ на прошлую неделю, заведён сегодня» будет нечем: в истории
     * стоит один переход «— → Новая» без объяснения. Поэтому причина операции дописывается в его
     * комментарий — той же транзакцией, а не аудитом: `writeAudit` пишет отдельным соединением и
     * гасит ошибку, а объяснение задним числом обязано пережить сбой вместе с самим заказом
     * (ADR 0101 п. 8). У обычной недели комментарий не трогается: объяснять там нечего.
     */
    if (params.correction) {
      await tx
        .update(vehicleRequestStatusHistory)
        .set({ comment: `${reason}: заказ заведён задним числом — ${params.correction.reason}` })
        .where(eq(vehicleRequestStatusHistory.vehicleRequestId, createdId));
    }
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
      earlyEndDropped: false,
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
