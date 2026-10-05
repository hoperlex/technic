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
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestCorrections,
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
 * Аннулирование применённой недельной заявки (ADR 0218): виза была, следствия разворачиваются
 * обратно.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СЕРВИС, А НЕ КОМАНДА КАНОНА. Канон `assignment-command.ts` однозаказный — его
 * спецификация несёт `requestId`, одну блокировку строки, один отпечаток и одну операцию журнала. У
 * недели заказов до десяти, и каждый проходит свой расчёт сокращения. Поэтому композиция живёт
 * здесь — по образцу применения (`weekly-request-apply.ts`), — а шаги канона повторяются по каждому
 * заказу теми же функциями, которыми их исполняет дверь досрочного завершения.
 *
 * ПОРЯДОК. Применение трогает чужие конкурентные сущности, и одной блокировки шапки ему мало:
 *
 *   1. `requireOpenDoor('history')` — **первым запросом** транзакции (иначе заморозка проскочит
 *      мимо этой транзакции, а она — мимо заморозки);
 *   2. `FOR UPDATE` шапки, сверка версии и статуса;
 *   3. **все рейсы** затронутых заказов, затем **строки заказов** — буквальный порядок ADR 0050
 *      п. 12, тот же, которым берёт их однозаказная дверь канона; иначе встречные порядки дают
 *      взаимный клинч;
 *   4. предвалидация **всех** строк до первой записи: блокирована хотя бы одна — 422 с полным
 *      перечнем;
 *   5. записи, бумага, статус, версия, событие истории.
 *
 * ВЕТВЕЙ ДВЕ, и выбирает их эффективная дата операции — первый снимаемый день. Не раньше сегодня —
 * обычная ветвь. Раньше — ветвь коррекции: право прошлого, глубина, причина, ключ идемпотентности
 * и строка журнала, как у проведения просроченной недели (ADR 0116).
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
 * Посчитать аннулирование целиком: что развернётся, что помешает и какой ценой.
 *
 * Транзакция приходит читающей у предпросмотра и пишущей у команды — расчёт **ничего не пишет** в
 * обоих случаях (ADR 0211 решение 1): первая запись идёт только после сверки отпечатка и
 * авторизации.
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
          'аннулированием недели',
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
          'аннулированием нельзя',
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
 * Ответ предпросмотра — та же работа теми же функциями, но без единой правки.
 *
 * Доступ к предпросмотру — по чтению карточки, а не по праву команды (ADR 0116 п. 12): понять,
 * почему кнопка недоступна, должен и тот, кто аннулировать не вправе. Отсюда `allowed` и
 * `blockedReason` в теле вместо 403, и причина называется в том же порядке, в каком откажет
 * команда: право по ветви, потом шапка, потом строки.
 */
export function weeklyAnnulPreviewDto(
  plan: WeeklyAnnulPlan,
  params: {
    subject: Principal;
    /** Видит ли субъект номера бланков: право отката журнала листов не открывает. */
    canReadWaybills: boolean;
    /** Область площадки — спрашивается только там, где право пришло визой. */
    inSiteScope: boolean;
    correctionFloor: string | null;
    /** Вердикт глубины: `null` — прошлого нет либо глубина позволяет. */
    depthRefusal: string | null;
  },
): WeeklyAnnulPreviewDto {
  const headerBlocker = weeklyAnnulHeaderBlocker(plan.header);
  const hasRight = canAnnulWeeklyRequest(params.subject, plan.backdated);
  const needsScope = weeklyAnnulNeedsSiteScope(params.subject, plan.backdated);
  const blockedItems = plan.items.filter((item) => plan.states.get(item.id)?.state === 'blocked');
  /*
   * Считаются строки, у которых следствия **были**, а не только те, что ещё предстоит развернуть
   * (решение 4 ADR 0218). Неделя, след которой уже убрали поштучно, обязана закрываться: иначе
   * документ навсегда остаётся «Применённым», держит пару «объект + неделя», и человек, начавший
   * разбор руками, не может его закончить ничем.
   */
  const hadEffects = plan.items.some((item) => weeklyItemHadEffect(item.result));

  const blockedReason = !hasRight
    ? plan.backdated
      ? 'Аннулировать неделю, чьи дни уже идут, может тот, у кого есть право коррекции задним числом'
      : 'Аннулировать применённую неделю может руководитель этой площадки или диспетчер'
    : needsScope && !params.inSiteScope
      ? 'Недельную заявку аннулирует руководитель этой площадки'
      : (params.depthRefusal ??
        headerBlocker ??
        (blockedItems.length > 0
          ? `Строк, которые нельзя развернуть: ${blockedItems.length} — разберите их поштучно`
          : plan.blockers.length > 0
            ? plan.blockers[0]!.message
            : hadEffects
              ? null
              : 'Закрывать нечего: ни одна строка этой недели не применилась'));

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
    // Номера бланков — только держателю журнала (ADR 0211 решение 3): на вопрос «есть ли что
    // называть» отвечает счётчик, и право аннулирования номеров строгой отчётности не открывает.
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

/** Результат команды — им ручка отвечает, а портал обновляет карточку. */
export interface WeeklyAnnulResult {
  weeklyRequestId: string;
  status: 'annulled';
  shortened: { requestId: string; displayNumber: string; dateTo: string }[];
  cancelled: { requestId: string; displayNumber: string }[];
  released: number;
  esm2: { cancelled: number; issued: number };
}

/**
 * Исполнить аннулирование: обратный ход по каждой строке, затем шапка.
 *
 * Вызывается **после** сверки отпечатка и авторизации — и под операцией журнала, если расчёт
 * сказал `requiresOperation`. Гейт режима, блокировки и сверку отпечатка держит вызывающий: у
 * ветви коррекции между ними стоит `runCorrection`, и своей транзакции этот сервис не открывает.
 */
export async function applyWeeklyAnnul(
  tx: Tx,
  params: {
    plan: WeeklyAnnulPlan;
    actor: Principal;
    reason: string;
    mode: AssignmentModeSnapshot;
    /** Строка журнала коррекций; `null` — исход `none`, объяснять нечего. */
    correctionId: string | null;
    acknowledgements?: Readonly<Record<string, string>> | undefined;
    unlockWaybillIds: readonly string[];
  },
): Promise<WeeklyAnnulResult> {
  const { plan, actor } = params;
  const now = new Date();
  const weekLabel = weeklyWeekLabel(plan.header.weekStart);
  const weeklyNumber = formatWeeklyRequestNumber(plan.header.num);
  const baseReason = `Недельная заявка ${weeklyNumber} (${weekLabel}) аннулирована: ${params.reason}`;

  /*
   * Бэкстоп чужой двери — preflight'ом по всем строкам разом и до первой записи: отказ обязан
   * назвать **все** проблемные заказы, а не первый, — неделю чинят одним заходом. Ловить его из
   * середины бесполезно: к тому моменту предыдущие строки уже переписаны.
   */
  const verdicts: AssignmentBackstopVerdict[] = [];
  for (const row of plan.extend) {
    const verdict = await evaluateAssignmentBackstop(tx, {
      door: 'weekly_annul',
      requestId: row.requestId,
      asOf: plan.asOf,
      // Новых дней аннулирование не открывает — оно их снимает, — и решения по хвосту у него не
      // спрашивают: гашение хвостовой группы само создаёт то расхождение, о котором спросили бы.
      opensTerm: false,
    });
    if (verdict) verdicts.push(verdict);
  }
  await applyAssignmentBackstop(tx, {
    door: 'weekly_annul',
    actor,
    verdicts,
    reason: baseReason,
  });

  // Рукопожатия по выпускаемым листам — тем же общим правилом, что у дверей истории (Б4).
  assertAssignmentIssueAcknowledgements({
    issues: plan.extend.flatMap((row) => row.shorten.issues),
    acknowledgements: params.acknowledgements,
    required: paperFollowsHistory(params.mode),
  });

  const shortened: WeeklyAnnulResult['shortened'] = [];
  let esm2Cancelled = 0;
  let esm2Issued = 0;

  for (const row of plan.extend) {
    const { shorten, requestId, termAfter } = row;
    const paperReason = `${baseReason} — срок возвращён к ${termAfter.dateTo}`;

    if (shorten.historyPresent) {
      await ensureCommandHistory(tx as AssignmentCommandTx, { requestId, asOf: plan.asOf });
    }
    // Гасимые решения истории внутри снимаемых дней (ADR 0218 решение 6) — ровно то, что делает
    // сокращение у всех прочих дверей. Ссылка на операцию объясняет, почему субботняя машина
    // вдруг снята.
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

    // Неподтверждённые часы на снимаемых днях — диапазоном, а не «все смены заказа»: подписанные
    // дни блокируют ещё в расчёте, а `dropRequestShifts` снял бы и отработанное прошлое.
    if (row.droppedShiftDates.length > 0) {
      await dropUnapprovedShiftsInRange(tx, {
        requestId,
        range: {
          from: row.droppedShiftDates[0]!,
          to: row.droppedShiftDates[row.droppedShiftDates.length - 1]!,
        },
      });
    }
    // Дверь, изменившая область валидности истории, обязана пересчитать блокеры готовности.
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
      // Чужой запрос на досрочный отъезд аннулирование не снимает никогда: строка с нерешённым
      // запросом блокирована ещё в расчёте, и второго — молчаливого — способа отменить чужое
      // решение у модуля быть не должно.
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
   * Порождённые заказы — в «Отменена» (ADR 0218 решение 10).
   *
   * Шаги повторяют то, что делает с таким заказом общий обработчик статуса: условная запись
   * статуса с версией, строка истории с причиной и обе сверки. Отдельной ветви `new → cancelled`
   * в ручке нет — это общий путь, в котором отсоединение, сброс заморозки и снятие досрочного
   * заперты условием «заказ был в работе», — поэтому вынести «ту ветвь» было нечем, а
   * воспроизводятся здесь **примитивы двери**, а не её текст: правило «что делает отмена» живёт в
   * `syncEsm2Waybills` и `syncLinearRouteDays`, и они одни на оба входа.
   *
   * Что у «Новой» пусто по построению и потому не повторяется: назначения, факта и смен у неё нет
   * (расчёт требует статус `new`), бэкстоп истории ей нечего спросить — бланков эта команда не
   * рождает, — а снимок линейности у заказа, не бывшего в работе, не ставится.
   */
  const cancelled: WeeklyAnnulResult['cancelled'] = [];
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
    // Расхождение считается конфликтом, а не молчаливым пропуском: статус читался под
    // блокировкой, и «заказ уже не Новая» означает, что между расчётом и записью его тронули.
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

  // Решения «уезжает» снимаются самой шапкой: `loadLeftBy` отбирает только применённые недели,
  // поэтому по ним не делается ничего — счётчик нужен ответу, чтобы человек увидел их в итоге.
  const released = plan.items.filter(
    (item) => plan.states.get(item.id)?.reverse === 'release_leave',
  ).length;

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

  // История — той же транзакцией, а не только аудитом (ADR 0085 п. 16): `writeAudit` намеренно не
  // роняет операцию при сбое записи, и тогда сам факт разворота мог бы исчезнуть.
  await tx.insert(weeklyVehicleRequestHistory).values({
    weeklyRequestId: plan.header.id,
    event: 'status',
    fromStatus: 'applied',
    toStatus: 'annulled',
    changedBy: actor.id,
    comment: params.reason,
    payload: {
      shortened,
      cancelled,
      released,
      esm2: { cancelled: esm2Cancelled, issued: esm2Issued },
      shifts: plan.shifts,
      linearDays: plan.linearDays,
      cancelGroups: plan.cancelGroups,
      backdated: plan.backdated,
      effectiveDate: plan.effectiveDate,
      ...(params.correctionId ? { operationId: params.correctionId } : {}),
    },
  });

  // Какие заказы задела операция — многие-ко-многим: обратный вопрос «что делали с этой заявкой
  // задним числом» задаёт её карточка при каждом открытии.
  if (params.correctionId) {
    const touched = [
      ...new Set([
        ...plan.extend.map((row) => row.requestId),
        ...plan.cancelOrders.map((row) => row.requestId),
      ]),
    ];
    if (touched.length > 0) {
      await tx
        .insert(vehicleRequestCorrections)
        .values(touched.map((requestId) => ({ correctionId: params.correctionId!, requestId })))
        .onConflictDoNothing();
    }
  }

  return {
    weeklyRequestId: plan.header.id,
    status: 'annulled',
    shortened,
    cancelled,
    released,
    esm2: { cancelled: esm2Cancelled, issued: esm2Issued },
  };
}

/** Отказ без ключа операции там, где он нужен — текстом контрактов, одним на окно и на ручку. */
export function assertAnnulOperation(plan: WeeklyAnnulPlan, body: AnnulWeeklyRequestInput): void {
  if (plan.requiresOperation && !body.correction) {
    throw err.unprocessable(WEEKLY_ANNUL_CORRECTION_REQUIRED_MESSAGE, {
      correction: 'Нужен ключ операции',
    });
  }
}

/** Гейт режима — первым запросом транзакции, как у применения. */
export async function openAnnulDoor(tx: Tx): Promise<AssignmentModeSnapshot> {
  return requireOpenDoor(tx as AssignmentCommandTx, 'history');
}

export type { BackdateAccess };
