import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  type AnnulWeeklyRequestInput,
  type BackdateAccess,
  canAnnulWeeklyRequest,
  formatVehicleRequestNumber,
  formatWeeklyRequestNumber,
  isWeeklyRequestApplied,
  movedRequestDateKey,
  orderEffectiveDateTo,
  shiftDateKey,
  type WeeklyAnnulBlockerDto,
  type WeeklyAnnulCancelGroupDto,
  type WeeklyAnnulItemDto,
  type WeeklyAnnulPaperDto,
  type WeeklyAnnulPreviewDto,
  type WeeklyAnnulSheetDto,
  weeklyAnnulEffectiveDate,
  weeklyAnnulHeaderBlocker,
  weeklyAnnulNeedsSiteScope,
  weeklyItemHadEffect,
  WEEKLY_ANNUL_CORRECTION_REQUIRED_MESSAGE,
  waybillDisplayNumber,
  weeklyWeekLabel,
  type WeeklyReversalResultDto,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequests,
  vehicleRequestStatusHistory,
  waybills,
  waybillSeries,
  weeklyVehicleRequestHistory,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import type { Principal } from '../auth/principal';
import {
  applyAssignmentBackstop,
  evaluateAssignmentBackstop,
  type AssignmentBackstopVerdict,
} from './assignment-backstop';
import type { AssignmentCommandTx } from './assignment-command';
import { fingerprintOf } from './assignment-crew';
import { ensureAssignmentHistory, ensureCommandHistory } from './assignment-ensure';
import type { AssignmentTerm } from './assignment-history';
import {
  assertAssignmentIssueAcknowledgements,
  assignmentPaperExecution,
  paperFollowsHistory,
} from './assignment-paper';
import {
  cancelGroupsShape,
  shortenTermPlan,
  type ShortenTermPlan,
} from './assignment-shorten-term';
import { dropUnapprovedShiftsInRange } from './assignment-shifts';
import { requireOpenDoor, type AssignmentModeSnapshot } from './assignment-mode';
import { applyAssignmentMutations, type AssignmentDenormalizationIntent } from './assignment-write';
import { syncEsm2Waybills } from './waybill-esm2';
import { syncLinearRouteDays } from './vehicle-request-days';
import { afterWorkPeriodChanged } from './vehicle-request-period';
import { requestShiftRows } from './vehicle-request-shifts';
import { annulStates, type AnnulStateRow } from './weekly-request-annul-state';

/**
 * Reversal of an applied weekly request: the approval happened, its consequences are rolled back.
 * Two commands run this engine — annulment (ADR 0218), after which the week is final, and the
 * return for re-approval (ADR 0219, `weekly-request-return.ts`), after which the same week is
 * approved again. They share the plan, the blockers, the fingerprints and the reversal, and differ
 * only in rights, wording and what happens to the header and the rows (`WeeklyReversalSpec`).
 *
 * WHY A SEPARATE SERVICE AND NOT A CANON COMMAND. The canon `assignment-command.ts` handles one
 * order: its specification carries a `requestId`, one row lock, one fingerprint and one journal
 * operation. A week holds up to ten orders, each with its own shortening plan. So the composition
 * lives here — after the pattern of apply (`weekly-request-apply.ts`) — and the canon steps are
 * repeated per order by the same functions the early-end door executes them with.
 *
 * ORDER. A reversal touches foreign concurrent entities, and a header lock is not enough:
 *
 *   1. `requireOpenDoor('history')` — the **first query** of the transaction (otherwise a freeze
 *      slips past this transaction, and it past the freeze);
 *   2. `FOR UPDATE` of the header, version and status check;
 *   3. **all routes** of the affected orders, then the **order rows** — the literal order of ADR
 *      0050 item 12, the one the single-order canon door takes them in; opposite orders deadlock;
 *   4. prevalidation of **all** rows before the first write: one blocked row — 422 with the full
 *      list;
 *   5. writes, paper, status, version, history event.
 *
 * THERE ARE TWO BRANCHES, chosen by the effective date of the operation — the first removed day.
 * Not before today — the ordinary branch. Earlier — the correction branch: the past right, depth,
 * reason, idempotency key and a journal row, as for conducting an overdue week (ADR 0116).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/**
 * Кто читает план. Предпросмотр зовёт расчёт **вне транзакции** (ADR 0211 решение 1): блокировок
 * он не берёт, и транзакция ему не нужна — а боевая ручка приходит со своей, потому что ей нужны и
 * блокировки, и запись.
 */
type Reader = Tx | typeof db;

/** Шапка заявки, прочитанная под блокировкой: ровно то, что нужно разбору и записи. */
interface LockedHeader {
  id: string;
  num: number;
  objectId: string;
  weekStart: string;
  status: 'draft' | 'pending' | 'applied' | 'annulled' | 'cancelled';
  appliedAt: Date | null;
  version: number;
}

/** Строка состава под блокировкой — поля, которые читают разбор и запись. */
interface LockedItem {
  id: string;
  kind: 'extend' | 'new' | 'leave';
  result: 'pending' | 'extended' | 'created' | 'left' | 'skipped';
  position: number;
  dateTo: string | null;
  previousDateTo: string | null;
  sourceRequestId: string | null;
  createdRequestId: string | null;
  vehicleTypeName: string | null;
  sourceRequestNum: number | null;
  createdRequestNum: number | null;
}

/** Расчёт сокращения по одной строке `extend` — вместе со сроками, которыми его считали. */
interface ExtendPlan {
  item: LockedItem;
  requestId: string;
  requestNum: number;
  termBefore: AssignmentTerm;
  termAfter: AssignmentTerm;
  shorten: ShortenTermPlan;
  /** Неподтверждённые смены на снимаемых днях: их удалит исполнение. */
  droppedShiftDates: string[];
}

/** Что аннулирование сделает — посчитанное до первой записи и подтверждаемое отпечатком. */
export interface WeeklyAnnulPlan {
  header: LockedHeader;
  items: LockedItem[];
  states: Map<string, AnnulStateRow>;
  extend: ExtendPlan[];
  /** Строки `new`, порождённые заказы которых надо отменить. */
  cancelOrders: { item: LockedItem; requestId: string }[];
  blockers: WeeklyAnnulBlockerDto[];
  effectiveDate: string | null;
  backdated: boolean;
  requiresOperation: boolean;
  paper: WeeklyAnnulPaperDto;
  unlockable: WeeklyAnnulSheetDto[];
  cancelGroups: WeeklyAnnulCancelGroupDto[];
  cancelGroupsFingerprint: string | null;
  issues: { issueKey: number; codes: string[]; warningFingerprint: string }[];
  linearDays: { detachable: string[]; frozen: string[] };
  shifts: string[];
  pendingWeeks: string[];
  fingerprint: string;
  asOf: string;
}

/** Параметры расчёта: блокировки берёт только боевая ручка, предпросмотр читает снимок. */
export interface PlanWeeklyAnnulParams {
  weeklyId: string;
  asOf: string;
  /**
   * Брать ли `FOR UPDATE`. Предпросмотр читает **без** блокировок намеренно (ADR 0211 решение 1):
   * `FOR UPDATE` на время просмотра остановил бы работу диспетчеров ради вопроса «что будет,
   * если», а боевую ручку защищает отпечаток, а не блокировка.
   */
  locked: boolean;
  /** Листы, названные человеком к перевыписке; у предпросмотра пусто. */
  unlockWaybillIds?: readonly string[];
}

const ITEM_TITLE_FALLBACK = 'Техника';

/** Подпись строки — тем же текстом, что в чек-листе: «Экскаватор (продление)». */
function titleOf(item: LockedItem): string {
  const suffix = item.kind === 'extend' ? 'продление' : item.kind === 'new' ? 'новая' : 'уезжает';
  return `${item.vehicleTypeName ?? ITEM_TITLE_FALLBACK} (${suffix})`;
}

function orderIdOf(item: LockedItem): string | null {
  return item.sourceRequestId ?? item.createdRequestId;
}

function displayNumberOf(item: LockedItem): string | null {
  const num = item.sourceRequestNum ?? item.createdRequestNum;
  return num === null ? null : formatVehicleRequestNumber(num);
}

/**
 * Прочитать шапку и состав; под блокировкой — в каноническом порядке захвата.
 *
 * Рейсы берутся **раньше** строк заказов (ADR 0050 п. 12) и одним запросом на все заказы состава:
 * так же их берёт однозаказная дверь канона, и встречный порядок двух команд дал бы взаимный
 * клинч. Применение недели явных блокировок рейсов не берёт вовсе — они ложатся неявно правками
 * сверки дней, — поэтому клинч с ним возможен и разрешается повтором, а не порядком.
 */
async function lockPlanRows(
  tx: Reader,
  params: PlanWeeklyAnnulParams,
): Promise<{ header: LockedHeader; items: LockedItem[] }> {
  const headerQuery = tx
    .select({
      id: weeklyVehicleRequests.id,
      num: weeklyVehicleRequests.num,
      objectId: weeklyVehicleRequests.objectId,
      weekStart: weeklyVehicleRequests.weekStart,
      status: weeklyVehicleRequests.status,
      appliedAt: weeklyVehicleRequests.appliedAt,
      version: weeklyVehicleRequests.version,
    })
    .from(weeklyVehicleRequests)
    .where(eq(weeklyVehicleRequests.id, params.weeklyId));
  const [header] = params.locked ? await headerQuery.for('update') : await headerQuery;
  if (!header) throw err.notFound('Недельная заявка не найдена');

  const items = await tx
    .select({
      id: weeklyVehicleRequestItems.id,
      kind: weeklyVehicleRequestItems.kind,
      result: weeklyVehicleRequestItems.result,
      position: weeklyVehicleRequestItems.position,
      dateTo: weeklyVehicleRequestItems.dateTo,
      previousDateTo: weeklyVehicleRequestItems.previousDateTo,
      sourceRequestId: weeklyVehicleRequestItems.sourceRequestId,
      createdRequestId: weeklyVehicleRequestItems.createdRequestId,
      vehicleTypeName: sql<string | null>`null`,
      sourceRequestNum: sql<number | null>`null`,
      createdRequestNum: sql<number | null>`null`,
    })
    .from(weeklyVehicleRequestItems)
    .where(eq(weeklyVehicleRequestItems.weeklyRequestId, header.id))
    .orderBy(asc(weeklyVehicleRequestItems.position));

  // Номера заказов и подпись типа — отдельным чтением по собранным идентификаторам: `leftJoin`
  // размножил бы строку состава на каждый действующий лист заказа, а номер нужен ровно один.
  const orderIds = [...new Set(items.map(orderIdOf).filter((v): v is string => v !== null))];
  const nums = new Map<string, number>();
  if (orderIds.length > 0) {
    const rows = await tx
      .select({ id: vehicleRequests.id, num: vehicleRequests.num })
      .from(vehicleRequests)
      .where(inArray(vehicleRequests.id, orderIds));
    for (const row of rows) nums.set(row.id, row.num);
  }

  const enriched: LockedItem[] = items.map((item) => ({
    ...item,
    sourceRequestNum: item.sourceRequestId ? (nums.get(item.sourceRequestId) ?? null) : null,
    createdRequestNum: item.createdRequestId ? (nums.get(item.createdRequestId) ?? null) : null,
  }));

  if (params.locked && orderIds.length > 0) {
    // Рейсы — первыми и по возрастанию id (ADR 0050 п. 12), затем строки заказов тем же порядком.
    await tx.execute(sql`
      select r.id from vehicle_routes r
      where r.source_request_id = any(${sql.raw(`array['${orderIds.join("','")}']::uuid[]`)})
      order by r.id
      for update
    `);
    await tx
      .select({ id: vehicleRequests.id })
      .from(vehicleRequests)
      .where(inArray(vehicleRequests.id, orderIds))
      .orderBy(asc(vehicleRequests.id))
      .for('update');
  }

  return { header, items: enriched };
}

/**
 * Недели в работе по тем же заказам: после разворота их снимок `expected_date_to` разойдётся со
 * сроком, и при визе строки станут `skipped` («срок изменился после подачи»).
 *
 * Не блокировка, а предупреждение: чужой черновик не вправе запирать исправление ошибочной визы, а
 * узнать о нём человек обязан до нажатия, а не из чужой жалобы через неделю.
 */
async function loadPendingWeeks(
  tx: Reader,
  params: { weeklyId: string; orderIds: string[] },
): Promise<string[]> {
  if (params.orderIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ num: weeklyVehicleRequests.num })
    .from(weeklyVehicleRequestItems)
    .innerJoin(
      weeklyVehicleRequests,
      eq(weeklyVehicleRequestItems.weeklyRequestId, weeklyVehicleRequests.id),
    )
    .where(
      and(
        inArray(weeklyVehicleRequestItems.sourceRequestId, params.orderIds),
        inArray(weeklyVehicleRequests.status, ['draft', 'pending']),
        ne(weeklyVehicleRequests.id, params.weeklyId),
      ),
    )
    .orderBy(asc(weeklyVehicleRequests.num));
  return rows.map((row) => formatWeeklyRequestNumber(row.num));
}

/** Напечатанные номера названных листов — для окна и для отказа по чужому листу. */
async function loadSheetPreviews(
  tx: Reader,
  unlocks: { waybillId: string; requestId: string; requestNum: number }[],
): Promise<WeeklyAnnulSheetDto[]> {
  if (unlocks.length === 0) return [];
  const rows = await tx
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      issuedForDate: waybills.issuedForDate,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(
      inArray(
        waybills.id,
        unlocks.map((u) => u.waybillId),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const out: WeeklyAnnulSheetDto[] = [];
  for (const unlock of unlocks) {
    const row = byId.get(unlock.waybillId);
    if (!row) continue;
    out.push({
      waybillId: unlock.waybillId,
      requestId: unlock.requestId,
      displayNumber: formatVehicleRequestNumber(unlock.requestNum),
      number: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
      periodFrom: row.periodFrom ?? row.issuedForDate,
      periodTo: row.periodTo ?? row.issuedForDate,
    });
  }
  return out;
}

/**
 * Compute a reversal of the week in full — for annulment and for the return alike: what will be
 * reversed, what stands in the way and at what price.
 *
 * The transaction is a reading one for the preview and a writing one for the command — the plan
 * **writes nothing** in both cases (ADR 0211 decision 1): the first write comes only after the
 * fingerprint check and the authorization.
 */
export async function planWeeklyAnnul(
  tx: Reader,
  params: PlanWeeklyAnnulParams,
): Promise<WeeklyAnnulPlan> {
  const { header, items } = await lockPlanRows(tx, params);
  const headerBlocker = weeklyAnnulHeaderBlocker(header);

  // Неприменённую разбирать нечего: следствий у неё не было, и `applied_at` пуст по построению.
  if (!isWeeklyRequestApplied(header.status) || !header.appliedAt) {
    return {
      header,
      items,
      states: new Map(),
      extend: [],
      cancelOrders: [],
      blockers: [],
      effectiveDate: null,
      backdated: false,
      requiresOperation: false,
      paper: { cancel: 0, trim: 0, reissue: 0, trimmedTo: null },
      unlockable: [],
      cancelGroups: [],
      cancelGroupsFingerprint: null,
      issues: [],
      linearDays: { detachable: [], frozen: [] },
      shifts: [],
      pendingWeeks: [],
      fingerprint: fingerprintOf({ weeklyId: header.id, blocked: headerBlocker }),
      asOf: params.asOf,
    };
  }

  const states = new Map(
    (
      await annulStates(tx, {
        weeklyId: header.id,
        appliedAt: header.appliedAt,
        items: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          result: item.result,
          dateTo: item.dateTo,
          previousDateTo: item.previousDateTo,
          orderId: orderIdOf(item),
        })),
      })
    ).map((state) => [state.itemId, state] as const),
  );

  const blockers: WeeklyAnnulBlockerDto[] = [];
  const extend: ExtendPlan[] = [];
  const cancelOrders: { item: LockedItem; requestId: string }[] = [];
  const unlocks: { waybillId: string; requestId: string; requestNum: number }[] = [];
  const cancelGroups: WeeklyAnnulCancelGroupDto[] = [];
  const cancelGroupTargets: ShortenTermPlan['cancelGroups'] = [];
  const issues: { issueKey: number; codes: string[]; warningFingerprint: string }[] = [];
  const linearDetachable: string[] = [];
  const linearFrozen: string[] = [];
  const droppedShifts: string[] = [];
  const paper: WeeklyAnnulPaperDto = { cancel: 0, trim: 0, reissue: 0, trimmedTo: null };
  const named = new Set(params.unlockWaybillIds ?? []);

  for (const item of items) {
    const state = states.get(item.id);
    if (!state || state.state !== 'reversible') continue;

    if (state.reverse === 'cancel') {
      const requestId = item.createdRequestId;
      if (requestId) cancelOrders.push({ item, requestId });
      continue;
    }
    if (state.reverse !== 'shorten_to') continue;

    const requestId = item.sourceRequestId!;
    const previousDateTo = item.previousDateTo!;
    const [detail] = await tx
      .select({
        dateFrom: specialEquipmentRequestDetails.dateFrom,
        dateTo: specialEquipmentRequestDetails.dateTo,
      })
      .from(specialEquipmentRequestDetails)
      .where(eq(specialEquipmentRequestDetails.requestId, requestId));
    if (!detail) continue;

    const termBefore: AssignmentTerm = { dateFrom: detail.dateFrom, dateTo: detail.dateTo };
    const termAfter: AssignmentTerm = { dateFrom: detail.dateFrom, dateTo: previousDateTo };
    /*
     * Исход самой команды над сроком — внешним эффектом, тем же расчётом, что у двери досрочного
     * завершения: границу «сегодня и вперёд — обычная работа» считает `movedRequestDateKey`, а не
     * константа. Напиши мы здесь `outcome: 'none'`, утверждение о ветви проверяло бы само себя.
     */
    const movedDate = movedRequestDateKey(
      { dateFrom: termBefore.dateFrom, dateTo: termBefore.dateTo },
      { dateTo: termAfter.dateTo },
    );
    const shorten = await shortenTermPlan(tx as AssignmentCommandTx, {
      requestId,
      asOf: params.asOf,
      termBefore,
      termAfter,
      external:
        movedDate === null
          ? null
          : { effectiveDate: movedDate, outcome: movedDate < params.asOf ? 'crew' : 'none' },
      /*
       * Субъект допустимости дней — как у досрочного завершения: статус остаётся прежним и
       * настоящим («В работе»), заказ продолжает работать по укороченному сроку. Отработанные дни
       * не удерживаются: аннулирование снимает ровно те дни, которые добавила неделя.
       */
      linearDays: {
        eligibilitySubject: {
          requestType: 'special_equipment',
          isLinear: true,
          status: 'confirmed',
          deletedAt: null,
          dateFrom: termAfter.dateFrom,
          dateTo: termAfter.dateTo,
          // Принадлежность машины допустимость дней не решает — её читает `linearDaysBlocker`
          // только у арендной техники, у которой линейных дней не бывает вовсе. Расчёт сокращения
          // всё равно требует поле явно, и `null` здесь означает «не спрашиваем», а не «арендная».
          ownership: null,
        },
        retainCompletedDays: false,
      },
    });

    // Факты работы на снимаемых днях — то, что право прошлого не открывает (ADR 0218 решение 3).
    const removedFrom = shiftDateKey(previousDateTo, 1);
    const removedTo = orderEffectiveDateTo({
      dateFrom: termBefore.dateFrom,
      dateTo: termBefore.dateTo,
    });
    const shiftRows = await requestShiftRows(tx, requestId);
    const approvedDates = shiftRows
      .filter((row) => row.approved && row.date >= removedFrom && row.date <= removedTo)
      .map((row) => row.date);
    if (approvedDates.length > 0) {
      blockers.push({
        code: 'approved_shift',
        itemId: item.id,
        dates: approvedDates,
        message:
          `По заказу ${formatVehicleRequestNumber(item.sourceRequestNum ?? 0)} площадка уже ` +
          'подписала работу за снимаемые дни — эти дни закрывают фактической датой, а не ' +
          'разворотом недели',
      });
    }
    const unapprovedDates = shiftRows
      .filter((row) => !row.approved && row.date >= removedFrom && row.date <= removedTo)
      .map((row) => row.date);

    if (shorten.linearDays.frozen.length > 0) {
      blockers.push({
        code: 'frozen_day',
        itemId: item.id,
        dates: shorten.linearDays.frozen.map((day) => day.date),
        message:
          `По заказу ${formatVehicleRequestNumber(item.sourceRequestNum ?? 0)} на снимаемые дни ` +
          'выписан действующий путевой лист — он уже у водителя, и снять такой день ' +
          'разворотом недели нельзя',
      });
    }

    // Отработанные листы: названный перевыпишется, неназванный — отказ. Разблокировка адресная и
    // сама в стороны не растёт (ADR 0116 п. 11).
    const notNamed = shorten.requiredUnlockIds.filter((id) => !named.has(id));
    if (notNamed.length > 0) {
      blockers.push({
        code: 'locked_sheet',
        itemId: item.id,
        dates: [],
        message:
          `По заказу ${formatVehicleRequestNumber(item.sourceRequestNum ?? 0)} снимаемые дни ` +
          'закрыты отработанным листом ЭСМ-2 — отметьте его к перевыписке',
      });
    }
    for (const unlock of shorten.requiredUnlocks) {
      unlocks.push({
        waybillId: unlock.waybillId,
        requestId,
        requestNum: item.sourceRequestNum ?? 0,
      });
    }

    for (const group of shorten.cancelGroupsPreview) {
      // Дата вступления лежит в строках группы, а не в самой группе: гашение групповое, и у
      // решения о паре «машина + машинист» строк две, с одной и той же датой. Берётся первая по
      // порядку — он уже отсортирован расчётом.
      const effectiveDate = group.rows[0]?.effectiveDate ?? params.asOf;
      cancelGroups.push({
        effectiveDate,
        dimensions: [
          ...new Set(
            group.rows.map((row) => (row.dimension === 'vehicle' ? 'Машина' : 'Машинист')),
          ),
        ],
        title: `${formatVehicleRequestNumber(item.sourceRequestNum ?? 0)}: решение от ${effectiveDate}`,
      });
    }
    cancelGroupTargets.push(...shorten.cancelGroups);
    for (const issue of shorten.issues) {
      issues.push({
        // Ключ пересчитывается по порядку в ответе недели: у каждой строки состава свой план, и
        // `issueKey` расчёта нумерует листы внутри одного заказа — два заказа дали бы один ключ
        // дважды, и подпись человека ушла бы не к тому листу.
        issueKey: issues.length,
        // Виды замечаний, а не их текст (ADR 0211 решение 3): вид говорит, **что** не в порядке, и
        // молчит о том, у кого.
        codes: [...new Set(issue.warnings.map((warning) => warning.facts.code))],
        warningFingerprint: issue.warningFingerprint,
      });
    }
    paper.cancel += shorten.sheetPlan.cancel.length;
    paper.trim += shorten.sheetPlan.trim.length;
    paper.reissue += shorten.sheetPlan.issue.length;
    for (const trim of shorten.sheetPlan.trim) {
      if (!paper.trimmedTo || trim.to > paper.trimmedTo) paper.trimmedTo = trim.to;
    }
    linearDetachable.push(...shorten.linearDays.detachable.map((day) => day.date));
    linearFrozen.push(...shorten.linearDays.frozen.map((day) => day.date));
    droppedShifts.push(...unapprovedDates);

    extend.push({
      item,
      requestId,
      requestNum: item.sourceRequestNum ?? 0,
      termBefore,
      termAfter,
      shorten,
      droppedShiftDates: unapprovedDates,
    });
  }

  const effectiveDate = weeklyAnnulEffectiveDate(
    items.map((item) => {
      const state = states.get(item.id);
      return {
        reverse: state?.reverse ?? 'none',
        previousDateTo: item.previousDateTo,
      };
    }),
  );
  const backdated = effectiveDate !== null && effectiveDate < params.asOf;
  const requiresOperation = backdated || cancelGroupTargets.length > 0;

  const sourceIds = [
    ...new Set(items.map((item) => item.sourceRequestId).filter((v): v is string => v !== null)),
  ];
  const [unlockable, pendingWeeks] = await Promise.all([
    loadSheetPreviews(tx, unlocks),
    loadPendingWeeks(tx, { weeklyId: header.id, orderIds: sourceIds }),
  ]);

  const itemStates = items.map((item) => states.get(item.id));
  const cancelGroupsFingerprint =
    cancelGroupTargets.length > 0 ? fingerprintOf(cancelGroupsShape(cancelGroupTargets)) : null;

  return {
    header,
    items,
    states,
    extend,
    cancelOrders,
    blockers,
    effectiveDate,
    backdated,
    requiresOperation,
    paper,
    unlockable,
    cancelGroups,
    cancelGroupsFingerprint,
    issues,
    linearDays: { detachable: [...new Set(linearDetachable)], frozen: [...new Set(linearFrozen)] },
    shifts: [...new Set(droppedShifts)].sort(),
    pendingWeeks,
    /*
     * Отпечаток — по **содержанию** последствий (ADR 0211 решение 4): строки с их ходом, бумага,
     * гасимые группы, дни и смены. Между просмотром и нажатием это меняется, не тронув версию
     * заявки: по заказу выписали лист, появился черновик смены, неделя стала отработанной.
     */
    fingerprint: fingerprintOf({
      weeklyId: header.id,
      items: itemStates.map((state) => [
        state?.itemId,
        state?.state,
        state?.reverse,
        state?.shortenTo,
      ]),
      blockers: blockers.map((blocker) => [blocker.code, blocker.itemId, blocker.dates]),
      paper,
      unlockable: unlockable.map((sheet) => sheet.waybillId).sort(),
      cancelGroups: cancelGroupsFingerprint,
      linear: [...new Set(linearDetachable)].sort(),
      shifts: [...new Set(droppedShifts)].sort(),
      effectiveDate,
    }),
    asOf: params.asOf,
  };
}

/**
 * What differs between the two commands that run this engine — annulment (ADR 0218) and the
 * return for re-approval (ADR 0219). Everything else is shared on purpose: the plan, the blockers,
 * the fingerprints and the reversal itself. A second copy of any of them would let the window of
 * one command promise what the other executes.
 */
export interface WeeklyReversalSpec {
  /** Correction-journal kind: the journal must tell the two operations apart. */
  kind: 'weekly_annul' | 'weekly_return';
  /**
   * Header status after the command. A repeat by operation key does not run `apply`, so its answer
   * takes the status from here and the counters from the operation's payload in the journal.
   */
  resultStatus: WeeklyReversalResultDto['status'];
  auditAction: 'weekly_request.annul' | 'weekly_request.return';
  /** Whether the subject holds the right of this branch. */
  canRun: (subject: Principal, backdated: boolean) => boolean;
  /** Whether the right came with a site scope that must be asked as well. */
  needsSiteScope: (subject: Principal, backdated: boolean) => boolean;
  rightRefusal: (backdated: boolean) => string;
  /** Refusal outside the site scope; only a command whose right has a scope needs it. */
  scopeRefusal?: string;
  headerBlocker: (header: { status: LockedHeader['status'] }) => string | null;
  /** Lead of the refusal that lists blocked rows: "Аннулировать неделю нельзя". */
  refusalLead: string;
  /** Refusal for a week none of whose rows was ever applied. */
  nothingToReverse: string;
  correctionRequired: string;
  /**
   * The command's execution under the locks: it runs the shared reversal (`reverseWeeklyEffects`)
   * and then writes what is its own — the header, the rows and the history events.
   */
  apply: (tx: Tx, params: WeeklyReversalParams) => Promise<WeeklyReversalResultDto>;
}

/**
 * The preview answer — the same work by the same functions, without a single write.
 *
 * Access to the preview follows the card, not the command right (ADR 0116 item 12): whoever may
 * not run the command still has to understand why the button is unavailable. Hence `allowed` and
 * `blockedReason` in the body instead of a 403, and the reason is named in the order the command
 * would refuse: branch right, then site scope, depth, header and rows.
 */
export function weeklyReversalPreviewDto(
  plan: WeeklyAnnulPlan,
  spec: WeeklyReversalSpec,
  params: {
    subject: Principal;
    /** Whether the subject sees form numbers: a reversal right does not open the sheet journal. */
    canReadWaybills: boolean;
    /** Site scope — asked only where the right came with the site approval. */
    inSiteScope: boolean;
    correctionFloor: string | null;
    /** Depth verdict: `null` — no past, or the depth allows it. */
    depthRefusal: string | null;
  },
): WeeklyAnnulPreviewDto {
  const headerBlocker = spec.headerBlocker(plan.header);
  const hasRight = spec.canRun(params.subject, plan.backdated);
  const needsScope = spec.needsSiteScope(params.subject, plan.backdated);
  const blockedItems = plan.items.filter((item) => plan.states.get(item.id)?.state === 'blocked');
  /*
   * Rows that HAD consequences count, not only those still to be reversed (ADR 0218 decision 4).
   * A week whose trace was already removed row by row must still be closable: otherwise the document
   * stays applied forever, holds the "object + week" pair, and whoever started the manual cleanup
   * cannot finish it.
   */
  const hadEffects = plan.items.some((item) => weeklyItemHadEffect(item.result));

  const blockedReason = !hasRight
    ? spec.rightRefusal(plan.backdated)
    : needsScope && !params.inSiteScope
      ? (spec.scopeRefusal ?? spec.rightRefusal(plan.backdated))
      : (params.depthRefusal ??
        headerBlocker ??
        (blockedItems.length > 0
          ? `Строк, которые нельзя развернуть: ${blockedItems.length} — разберите их поштучно`
          : plan.blockers.length > 0
            ? plan.blockers[0]!.message
            : hadEffects
              ? null
              : spec.nothingToReverse));

  const dtoItems: WeeklyAnnulItemDto[] = plan.items.map((item) => {
    const state = plan.states.get(item.id);
    return {
      itemId: item.id,
      kind: item.kind,
      title: titleOf(item),
      requestId: orderIdOf(item),
      displayNumber: displayNumberOf(item),
      state: state?.state ?? 'reverted',
      reason: state?.reason ?? '',
      reverse: state?.reverse ?? 'none',
      shortenTo: state?.shortenTo ?? null,
      hadEffect: weeklyItemHadEffect(item.result),
    };
  });

  return {
    weeklyRequestId: plan.header.id,
    weekStart: plan.header.weekStart,
    weekLabel: weeklyWeekLabel(plan.header.weekStart),
    today: plan.asOf,
    effectiveDate: plan.effectiveDate,
    backdated: plan.backdated,
    requiresOperation: plan.requiresOperation,
    correctionFloor: params.correctionFloor,
    allowed: blockedReason === null,
    blockedReason,
    items: dtoItems,
    blockers: plan.blockers,
    paper: plan.paper,
    // Form numbers only for the journal holder (ADR 0211 decision 3): "is there anything to name"
    // is answered by the counter, and a reversal right does not open numbers of strict accounting.
    unlockable: params.canReadWaybills ? plan.unlockable : null,
    unlockableCount: plan.unlockable.length,
    cancelGroups: plan.cancelGroups,
    cancelGroupsFingerprint: plan.cancelGroupsFingerprint,
    issues: plan.issues,
    linearDays: plan.linearDays,
    shifts: plan.shifts,
    pendingWeeks: plan.pendingWeeks,
    fingerprint: plan.fingerprint,
    asOf: plan.asOf,
  };
}

/** Parameters of a reversal command, after the fingerprint and the authorization were checked. */
export interface WeeklyReversalParams {
  plan: WeeklyAnnulPlan;
  actor: Principal;
  reason: string;
  mode: AssignmentModeSnapshot;
  /** Correction-journal row; `null` — outcome `none`, nothing to explain. */
  correctionId: string | null;
  acknowledgements?: Readonly<Record<string, string>> | undefined;
  unlockWaybillIds: readonly string[];
}

/** What the reversal did to the orders — the common part of both command results. */
type WeeklyReversalEffects = Omit<
  WeeklyReversalResultDto,
  'weeklyRequestId' | 'status' | 'repeated'
>;

/**
 * Reverse every consequence of the applied week: terms back to the snapshots, created orders
 * cancelled, "leaving" decisions released by the header change of the caller.
 *
 * Called **after** the fingerprint check and the authorization, and under a journal operation when
 * the plan said `requiresOperation`. The mode gate, the locks and the fingerprint belong to the
 * caller: in the correction branch `runCorrection` stands between them, so this function opens no
 * transaction of its own. The header and the rows are the caller's too: annulment keeps the rows
 * with their results, the return resets or drops them (`WeeklyReversalSpec.apply`).
 */
export async function reverseWeeklyEffects(
  tx: Tx,
  params: WeeklyReversalParams & {
    /**
     * The command's journal kind; the backstop door bears the same name, so the refusal names the
     * command the person actually ran.
     */
    kind: WeeklyReversalSpec['kind'];
    /** "НЗ-12 (week) <what the command did>: reason" — goes to sheets and order histories. */
    baseReason: string;
  },
): Promise<WeeklyReversalEffects> {
  const { plan, actor, baseReason } = params;
  const now = new Date();

  /*
   * Backstop of the foreign door — as a preflight over all rows and before the first write: the
   * refusal must name ALL problematic orders, not the first one, because the week is fixed in one
   * pass. Catching it in the middle is useless: the earlier rows would already be rewritten.
   */
  const verdicts: AssignmentBackstopVerdict[] = [];
  for (const row of plan.extend) {
    const verdict = await evaluateAssignmentBackstop(tx, {
      door: params.kind,
      requestId: row.requestId,
      asOf: plan.asOf,
      // The reversal opens no days, it removes them, and tail decisions are not asked: cancelling
      // the tail group itself creates the very divergence they would be asked about.
      opensTerm: false,
    });
    if (verdict) verdicts.push(verdict);
  }
  await applyAssignmentBackstop(tx, {
    door: params.kind,
    actor,
    verdicts,
    reason: baseReason,
  });

  // Handshakes on the issued sheets — by the same shared rule as the history doors (B4).
  assertAssignmentIssueAcknowledgements({
    issues: plan.extend.flatMap((row) => row.shorten.issues),
    acknowledgements: params.acknowledgements,
    required: paperFollowsHistory(params.mode),
  });

  const shortened: WeeklyReversalEffects['shortened'] = [];
  let esm2Cancelled = 0;
  let esm2Issued = 0;

  for (const row of plan.extend) {
    const { shorten, requestId, termAfter } = row;
    const paperReason = `${baseReason} — срок возвращён к ${termAfter.dateTo}`;

    if (shorten.historyPresent) {
      await ensureCommandHistory(tx as AssignmentCommandTx, { requestId, asOf: plan.asOf });
    }
    // Assignment decisions inside the removed days are cancelled (ADR 0218 decision 6) — exactly
    // what shortening does at every other door. The operation link explains why the Saturday
    // vehicle suddenly disappeared.
    await applyAssignmentMutations(tx as AssignmentCommandTx, {
      requestId,
      actorUserId: actor.id,
      correctionId: params.correctionId,
      mutations: shorten.cancelGroups.map((group) => group.target),
      denormalization: (shorten.cancelGroups.length > 0
        ? { kind: 'tail_release' }
        : { kind: 'keep' }) as AssignmentDenormalizationIntent,
    });

    await tx
      .update(specialEquipmentRequestDetails)
      .set({ dateTo: termAfter.dateTo })
      .where(eq(specialEquipmentRequestDetails.requestId, requestId));
    const [bumped] = await tx
      .update(vehicleRequests)
      .set({ updatedBy: actor.id, updatedAt: now, version: sql`${vehicleRequests.version} + 1` })
      .where(eq(vehicleRequests.id, requestId))
      .returning({ id: vehicleRequests.id });
    if (!bumped) throw err.conflict();

    // Unconfirmed hours on the removed days — by range, not "all shifts of the order": signed days
    // block already in the plan, and `dropRequestShifts` would remove the worked past as well.
    if (row.droppedShiftDates.length > 0) {
      await dropUnapprovedShiftsInRange(tx, {
        requestId,
        range: {
          from: row.droppedShiftDates[0]!,
          to: row.droppedShiftDates[row.droppedShiftDates.length - 1]!,
        },
      });
    }
    // A door that changed the validity range of the history must recompute readiness blockers.
    await ensureAssignmentHistory(tx as AssignmentCommandTx, { requestId, asOf: plan.asOf });

    const doomed = [...shorten.linearDays.detachable, ...shorten.linearDays.frozen];
    const followsSheetPlan = paperFollowsHistory(params.mode);
    const unlocksOfRequest = shorten.requiredUnlockIds.filter((id) =>
      params.unlockWaybillIds.includes(id),
    );
    const result = await afterWorkPeriodChanged(tx, {
      requestId,
      actor: { id: actor.id },
      reason: paperReason,
      // A foreign early-departure request is never dropped by a reversal: a row with an undecided
      // request is blocked in the plan, and the module must not have a second, silent way to
      // cancel someone else's decision.
      dropPendingEarlyEnd: false,
      backstop: 'checked_by_caller',
      opensTerm: false,
      days: { kind: 'plan' as const, plan: doomed },
      ...(params.correctionId
        ? { correction: { id: params.correctionId, unlockWaybillIds: unlocksOfRequest } }
        : {}),
      ...(followsSheetPlan
        ? {
            paper: {
              kind: 'plan' as const,
              ...assignmentPaperExecution({
                requestId,
                actor: { id: actor.id },
                reason: paperReason,
                mode: params.mode,
                effects: shorten.effects,
                operationId: params.correctionId,
                sheetPlan: shorten.sheetPlan,
                paperScope: shorten.paperScope,
                sheets: shorten.sheets,
                displayNumbers: shorten.sheetNumbers,
                unlockWaybillIds: unlocksOfRequest,
                issues: shorten.issuePreparations,
                acknowledgements: params.acknowledgements,
              }),
            },
          }
        : {}),
    });
    esm2Cancelled += result.esm2.cancelled.length;
    esm2Issued += result.esm2.issued.length;
    shortened.push({
      requestId,
      displayNumber: formatVehicleRequestNumber(row.requestNum),
      dateTo: termAfter.dateTo!,
    });
  }

  /*
   * Created orders go to "Cancelled" (ADR 0218 decision 10).
   *
   * The steps repeat what the shared status handler does with such an order: a conditional status
   * write with the version, a history row with the reason and both reconciliations. There is no
   * separate `new → cancelled` branch in that handler — it is the shared path, where detaching,
   * resetting the freeze and dropping the early end are guarded by "the order was in work" — so
   * there was nothing to extract, and the door's PRIMITIVES are reproduced here, not its text: the
   * rule of what cancelling does lives in `syncEsm2Waybills` and `syncLinearRouteDays`, one for both
   * entries.
   *
   * Empty for a "New" order by construction and therefore not repeated: it has no assignment, fact
   * or shifts (the plan requires status `new`), the history backstop has nothing to ask — this
   * command issues no forms — and the linear snapshot is never set on an order that was not in work.
   */
  const cancelled: WeeklyReversalEffects['cancelled'] = [];
  for (const row of plan.cancelOrders) {
    const [updated] = await tx
      .update(vehicleRequests)
      .set({
        status: 'cancelled',
        updatedBy: actor.id,
        updatedAt: now,
        version: sql`${vehicleRequests.version} + 1`,
      })
      .where(and(eq(vehicleRequests.id, row.requestId), eq(vehicleRequests.status, 'new')))
      .returning({ id: vehicleRequests.id, status: vehicleRequests.status });
    // A mismatch is a conflict, not a silent skip: the status was read under the lock, and "no
    // longer New" means someone touched the order between the plan and the write.
    if (!updated) throw err.conflict();
    await tx.insert(vehicleRequestStatusHistory).values({
      vehicleRequestId: row.requestId,
      fromStatus: 'new',
      toStatus: 'cancelled',
      changedBy: actor.id,
      comment: baseReason,
    });
    const esm2 = await syncEsm2Waybills(tx, {
      requestId: row.requestId,
      actor: { id: actor.id },
      reason: baseReason,
      asOf: plan.asOf,
      ...(params.correctionId
        ? { correction: { id: params.correctionId, unlockWaybillIds: [] } }
        : {}),
    });
    esm2Cancelled += esm2.cancelled.length;
    esm2Issued += esm2.issued.length;
    await syncLinearRouteDays(tx, {
      requestId: row.requestId,
      actor: { id: actor.id },
      reason: baseReason,
    });
    cancelled.push({
      requestId: row.requestId,
      displayNumber: formatVehicleRequestNumber(row.item.createdRequestNum ?? 0),
    });
  }

  // "Leaving" decisions are released by the header itself: `loadLeftBy` selects applied weeks only,
  // and both reversals take the week out of `applied`. The counter is for the answer, so the person
  // sees them in the result.
  const released = plan.items.filter(
    (item) => plan.states.get(item.id)?.reverse === 'release_leave',
  ).length;

  return { shortened, cancelled, released, esm2: { cancelled: esm2Cancelled, issued: esm2Issued } };
}

/** The payload of the history event: what the reversal undid, readable a month later. */
export function weeklyReversalPayload(
  plan: WeeklyAnnulPlan,
  effects: WeeklyReversalEffects,
  correctionId: string | null,
): Record<string, unknown> {
  return {
    ...effects,
    shifts: plan.shifts,
    linearDays: plan.linearDays,
    cancelGroups: plan.cancelGroups,
    backdated: plan.backdated,
    effectiveDate: plan.effectiveDate,
    ...(correctionId ? { operationId: correctionId } : {}),
  };
}

/**
 * Annul the applied week: reverse its consequences, then the header goes to `annulled`.
 *
 * The rows keep their results and snapshots (ADR 0218 decision 9): they answer "what was decided
 * and what was undone", and the state of the document is told by the header.
 */
async function applyWeeklyAnnul(
  tx: Tx,
  params: WeeklyReversalParams,
): Promise<WeeklyReversalResultDto> {
  const { plan, actor } = params;
  const now = new Date();
  const weekLabel = weeklyWeekLabel(plan.header.weekStart);
  const weeklyNumber = formatWeeklyRequestNumber(plan.header.num);
  const effects = await reverseWeeklyEffects(tx, {
    ...params,
    kind: 'weekly_annul',
    baseReason: `Недельная заявка ${weeklyNumber} (${weekLabel}) аннулирована: ${params.reason}`,
  });

  const [bumpedHeader] = await tx
    .update(weeklyVehicleRequests)
    .set({
      status: 'annulled',
      annulledBy: actor.id,
      annulledAt: now,
      annulReason: params.reason,
      updatedBy: actor.id,
      updatedAt: now,
      version: plan.header.version + 1,
    })
    .where(
      and(
        eq(weeklyVehicleRequests.id, plan.header.id),
        eq(weeklyVehicleRequests.version, plan.header.version),
      ),
    )
    .returning({ id: weeklyVehicleRequests.id });
  if (!bumpedHeader) throw err.conflict();

  // History in the same transaction, not only the audit (ADR 0085 item 16): `writeAudit` does not
  // fail the operation on a write error by design, and the reversal itself could vanish.
  await tx.insert(weeklyVehicleRequestHistory).values({
    weeklyRequestId: plan.header.id,
    event: 'status',
    fromStatus: 'applied',
    toStatus: 'annulled',
    changedBy: actor.id,
    comment: params.reason,
    payload: weeklyReversalPayload(plan, effects, params.correctionId),
  });

  return { weeklyRequestId: plan.header.id, status: 'annulled', ...effects };
}

/**
 * The annulment command (ADR 0218 decision 7): the right depends on the branch. The correction
 * branch takes the past right only; the ordinary one takes either the site approval — in the site
 * scope — or the dispatcher's past right.
 */
export const WEEKLY_ANNUL_SPEC: WeeklyReversalSpec = {
  kind: 'weekly_annul',
  resultStatus: 'annulled',
  auditAction: 'weekly_request.annul',
  canRun: (subject, backdated) => canAnnulWeeklyRequest(subject, backdated),
  needsSiteScope: (subject, backdated) => weeklyAnnulNeedsSiteScope(subject, backdated),
  rightRefusal: (backdated) =>
    backdated
      ? 'Аннулировать неделю, чьи дни уже идут, может тот, у кого есть право коррекции задним числом'
      : 'Аннулировать применённую неделю может руководитель этой площадки или диспетчер',
  scopeRefusal: 'Недельную заявку аннулирует руководитель этой площадки',
  headerBlocker: weeklyAnnulHeaderBlocker,
  refusalLead: 'Аннулировать неделю нельзя',
  nothingToReverse: 'Закрывать нечего: ни одна строка этой недели не применилась',
  correctionRequired: WEEKLY_ANNUL_CORRECTION_REQUIRED_MESSAGE,
  apply: applyWeeklyAnnul,
};

/** Refusal without an operation key where one is required — the contract text of the command. */
export function assertReversalOperation(
  plan: WeeklyAnnulPlan,
  body: AnnulWeeklyRequestInput,
  message: string,
): void {
  if (plan.requiresOperation && !body.correction) {
    throw err.unprocessable(message, { correction: 'Нужен ключ операции' });
  }
}

/** Mode gate — the first query of the transaction, as for apply. */
export async function openReversalDoor(tx: Tx): Promise<AssignmentModeSnapshot> {
  return requireOpenDoor(tx as AssignmentCommandTx, 'history');
}

export type { BackdateAccess };
