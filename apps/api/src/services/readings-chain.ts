import { and, asc, desc, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import {
  ENGINE_HOURS_JUMP_PER_DAY,
  jumpLimit,
  ODOMETER_JUMP_PER_DAY_KM,
  type ReadingAnomaly,
  type ReadingSourceKind,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  driverDailyReportHistory,
  driverDailyReports,
  driverDailyReportItems,
  vehicleReadingHistory,
  vehicleReadings,
  vehicleRoutes,
  vehicles,
  waybills,
  type DriverDailyReportRow,
  type VehicleReadingRow,
} from '../db/schema';
import { err } from '../lib/errors';

/**
 * Сериализация модуля показаний (ADR 0103, Р19/Р20/Р24): порядок блокировок, версии отчёта,
 * обе истории и перестройка цепочек счётчиков.
 *
 * Файл отделён от `readings.ts` не по размеру, а по предмету. Здесь нет ни одного правила
 * предметной области — только то, чем модуль защищается от самого себя: два водителя одной машины
 * ведут **разные отчёты**, и версия отчёта их не сериализует. Единственное, что стоит между
 * встречными операциями, — общий порядок блокировок, и он должен читаться в одном месте целиком,
 * а не собираться по вызовам из тысячи строк бизнес-логики.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Событие истории шапки и истории показания — перечисления БД, а не свободные строки. */
export type ReportEvent =
  | 'created'
  | 'submitted'
  | 'accepted'
  | 'reopened'
  | 'voided'
  | 'item_added'
  | 'item_removed'
  | 'shift_order_changed'
  | 'discrepancy_resolved';
export type ReadingEvent = 'created' | 'updated' | 'anomaly_confirmed' | 'chain_relinked';

/** Источник строки ожидания: рейс или недельный лист. Третьего не бывает (Р16). */
export interface SourceRef {
  kind: ReadingSourceKind;
  id: string;
}

/** Точка цепочки: машина, день и позиция смены — тот же ключ, что у строки ожидания (Р15). */
export interface ChainAnchor {
  vehicleId: string;
  reportDate: string;
  shiftOrder: number;
}

// ── Порядок блокировок (Р24) ──
//
// 1. машины → 2. отчёты → 3. источники (FOR SHARE) → 4. строки ожидания и показания.
//
// Брать разрешено суффикс — начиная с любого уровня и дальше вниз, — но никогда не подниматься
// обратно: очередь, взятая иначе хотя бы в одном месте, даёт взаимоблокировку ровно там, где её
// труднее всего воспроизвести. Каждая функция ниже сортирует идентификаторы сама: два вызова с
// одним набором машин обязаны взять их в одном порядке, как бы ни был перемешан массив у
// вызывающего.

function uniqueSorted(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))].sort();
}

/** Уровень 1. Машина — единица цепочки: её блокировка сериализует правку соседних смен. */
export async function lockVehicles(tx: Tx, vehicleIds: readonly string[]): Promise<void> {
  const ids = uniqueSorted(vehicleIds);
  if (ids.length === 0) return;
  await tx
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(inArray(vehicles.id, ids))
    .orderBy(asc(vehicles.id))
    .for('update');
}

/**
 * Уровень 2. Отчёты — целиком и разом: перестановка смен и перенос строки трогают отчёты **двух**
 * водителей, и брать их по одному значило бы дать двум встречным операциям взять их крест-накрест.
 */
export async function lockReports(
  tx: Tx,
  reportIds: readonly string[],
): Promise<Map<string, DriverDailyReportRow>> {
  const ids = uniqueSorted(reportIds);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(driverDailyReports)
    .where(inArray(driverDailyReports.id, ids))
    .orderBy(asc(driverDailyReports.id))
    .for('update');
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Уровень 3. Источники — `FOR SHARE`, а не `FOR UPDATE` (Р22): операции нужно, чтобы рейс или лист
 * не изменился до конца транзакции, а не право его менять. Правка рейса в это время подождёт, но
 * второй приёмке ждать нечего.
 *
 * Порядок между таблицами фиксирован — сначала рейсы, потом листы: внутри уровня две таблицы, и
 * без общего порядка они дают ту же встречную блокировку, что и уровни между собой.
 */
export async function lockSources(tx: Tx, refs: readonly SourceRef[]): Promise<void> {
  const routeIds = uniqueSorted(refs.filter((r) => r.kind === 'route').map((r) => r.id));
  const waybillIds = uniqueSorted(refs.filter((r) => r.kind === 'esm2').map((r) => r.id));
  if (routeIds.length > 0) {
    await tx
      .select({ id: vehicleRoutes.id })
      .from(vehicleRoutes)
      .where(inArray(vehicleRoutes.id, routeIds))
      .orderBy(asc(vehicleRoutes.id))
      .for('share');
  }
  if (waybillIds.length > 0) {
    await tx
      .select({ id: waybills.id })
      .from(waybills)
      .where(inArray(waybills.id, waybillIds))
      .orderBy(asc(waybills.id))
      .for('share');
  }
}

// Уровень 4 — строки ожидания и показания — читается в порядке `(vehicle_id, report_date,
// shift_order)`, то есть в порядке самой цепочки: им же идёт и перестройка соседей.

/**
 * Свободный хвост позиций машины за день (Р24): поздняя вставка не перенумеровывает ничего, потому
 * что молчаливый сдвиг позиций в уже принятом отчёте меняет чужие разности без ведома того, кто их
 * подтвердил. Считается под блокировкой машины — иначе две вставки возьмут один номер.
 */
export async function nextShiftOrder(tx: Tx, vehicleId: string, date: string): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${driverDailyReportItems.shiftOrder}), 0)::int + 1` })
    .from(driverDailyReportItems)
    .where(
      and(
        eq(driverDailyReportItems.vehicleId, vehicleId),
        eq(driverDailyReportItems.reportDate, date),
      ),
    );
  return row?.next ?? 1;
}

// ── Истории (Р19) ──
//
// Обе пишутся той же транзакцией, что и правка. `writeAudit` для этого не годится: он намеренно
// проглатывает сбой записи — учётное число изменилось бы без следа.

export async function writeReportEvent(
  tx: Tx,
  params: {
    reportId: string;
    event: ReportEvent;
    payload?: Record<string, unknown>;
    reason?: string;
    contentVersion: number;
    reportVersion: number;
    changedBy: string;
  },
): Promise<void> {
  await tx.insert(driverDailyReportHistory).values({
    reportId: params.reportId,
    event: params.event,
    payload: params.payload ?? {},
    reason: params.reason ?? '',
    contentVersion: params.contentVersion,
    reportVersion: params.reportVersion,
    changedBy: params.changedBy,
  });
}

export async function writeReadingEvent(
  tx: Tx,
  params: {
    readingId: string;
    event: ReadingEvent;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    reason?: string;
    version: number;
    changedBy: string;
  },
): Promise<void> {
  await tx.insert(vehicleReadingHistory).values({
    readingId: params.readingId,
    event: params.event,
    before: params.before ?? {},
    after: params.after ?? {},
    reason: params.reason ?? '',
    version: params.version,
    changedBy: params.changedBy,
  });
}

// ── Версии и состояния шапки (Р21, Р22) ──

/**
 * Что операция сделала с отчётом. Разделение на «содержимое» и «всё остальное» — не формальность:
 * `content_version` фиксирует приём (числа, состав, порядок смен), а `version` служит
 * оптимистической блокировкой и растёт даже там, где числа не менялись, — иначе приём подтверждал
 * бы разбор, которого в его снимке ещё не было.
 */
export interface ReportChange {
  /** Изменились числа, состав строк или порядок смен. */
  contentChanged: boolean;
  /** Перевод `draft → submitted`. */
  submit?: boolean;
  /** Приём: кто принял. */
  acceptedBy?: string;
  /** Строка вернулась в опустевший отчёт: `voided` поднимается обратно (Р17). */
  revive?: boolean;
  /** Из отчёта унесли последнюю строку (Р21а п. 8). */
  voidReport?: boolean;
  /** Ключ идемпотентности и отпечаток принятого тела (Р25). */
  idempotency?: { key: string; fingerprint: string };
}

export interface ReportChangeResult {
  row: DriverDailyReportRow;
  /**
   * События состояния, вытекшие из изменения. Пишет их вызывающий и **после** своих: в истории
   * «добавили строку, поэтому переоткрыли» читается в этом порядке, а не наоборот.
   */
  implicit: ReportEvent[];
}

/**
 * Единственное место, где меняется шапка отчёта. Матрица состояний живёт CHECK'ом в схеме, и
 * собрать её здесь по кусочкам («тут проставим `accepted_at`, там подвинем версию») означало бы
 * ловить нарушения инварианта отказом БД на проде.
 */
export async function applyReportChange(
  tx: Tx,
  report: DriverDailyReportRow,
  change: ReportChange,
  actorUserId: string,
): Promise<ReportChangeResult> {
  const now = new Date();
  const contentVersion = report.contentVersion + (change.contentChanged ? 1 : 0);
  const implicit: ReportEvent[] = [];

  let state = report.state;
  let submittedAt = report.submittedAt;
  let acceptedAt = report.acceptedAt;
  let acceptedBy = report.acceptedBy;
  let acceptedContentVersion = report.acceptedContentVersion;

  if (change.submit && state === 'draft') {
    state = 'submitted';
    submittedAt = now;
    implicit.push('submitted');
  }
  // Возврат строки поднимает отчёт ровно туда, откуда его унёс перенос: принимали — на повторный
  // приём, не принимали — в отправленные.
  if (change.revive && state === 'voided') {
    state = acceptedAt === null ? 'submitted' : 'needs_reacceptance';
    implicit.push('reopened');
  }
  if (change.voidReport) {
    // Аннулирование сильнее переоткрытия: в отчёте, из которого унесли последнюю строку, принимать
    // нечего, и «переоткрыт, затем аннулирован» одной операцией читалось бы как две.
    state = 'voided';
    implicit.push('voided');
  } else if (change.contentChanged && state === 'accepted') {
    // Правка принятого отчёта не «сбрасывает приём», а показывает, насколько принятое разошлось с
    // текущим: `accepted_*` остаются, и по паре версий видно, что именно.
    state = 'needs_reacceptance';
    implicit.push('reopened');
  }
  if (change.acceptedBy) {
    state = 'accepted';
    acceptedAt = now;
    acceptedBy = change.acceptedBy;
    acceptedContentVersion = contentVersion;
    implicit.push('accepted');
  }

  const [row] = await tx
    .update(driverDailyReports)
    .set({
      state,
      submittedAt,
      acceptedAt,
      acceptedBy,
      acceptedContentVersion,
      contentVersion,
      version: report.version + 1,
      submitIdempotencyKey: change.idempotency?.key ?? report.submitIdempotencyKey,
      submitFingerprint: change.idempotency?.fingerprint ?? report.submitFingerprint,
      updatedBy: actorUserId,
      updatedAt: now,
    })
    // Условие по версии поверх уже взятой `FOR UPDATE`: блокировку берут все операции модуля, но
    // цена ошибки здесь — потерянное обновление учётного числа, и второй замок дешевле разбора.
    .where(
      and(eq(driverDailyReports.id, report.id), eq(driverDailyReports.version, report.version)),
    )
    .returning();
  if (!row) throw err.conflict('Отчёт изменился, обновите страницу и повторите');
  return { row, implicit };
}

// ── Цепочки и аномалии (Р20, Р24) ──

/** Правка одного показания: только колонки цепочки, значения счётчиков она не трогает. */
type ReadingPatch = Partial<typeof vehicleReadings.$inferInsert>;

/** Счётчик со своими колонками, порогом и способом прочитать значение из строки. */
interface CounterSpec {
  readonly counter: 'odometer' | 'engineHours';
  readonly label: string;
  readonly perDay: number;
  valueOf(row: VehicleReadingRow): number | null;
  previousIdOf(row: VehicleReadingRow): string | null;
  anomalyOf(row: VehicleReadingRow): ReadingAnomaly | null;
  confirmedAtOf(row: VehicleReadingRow): Date | null;
  confirmedByOf(row: VehicleReadingRow): string | null;
  filled(): SQL;
  patch(link: CounterLink): ReadingPatch;
}

interface CounterLink {
  previousId: string | null;
  anomaly: ReadingAnomaly | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
}

/**
 * У одометра и моточасов свои предшественники: строка с одними моточасами не разрывает ряд
 * одометра. Поэтому счётчик — не пара колонок, а самостоятельная сущность со своим порогом.
 */
const COUNTERS: readonly CounterSpec[] = [
  {
    counter: 'odometer',
    label: 'одометр',
    perDay: ODOMETER_JUMP_PER_DAY_KM,
    valueOf: (row) => row.odometerKm,
    previousIdOf: (row) => row.previousOdometerId,
    anomalyOf: (row) => row.odometerAnomaly,
    confirmedAtOf: (row) => row.odometerAnomalyConfirmedAt,
    confirmedByOf: (row) => row.odometerAnomalyConfirmedBy,
    filled: () => isNotNull(vehicleReadings.odometerKm),
    patch: (link) => ({
      previousOdometerId: link.previousId,
      odometerAnomaly: link.anomaly,
      odometerAnomalyConfirmedBy: link.confirmedBy,
      odometerAnomalyConfirmedAt: link.confirmedAt,
    }),
  },
  {
    counter: 'engineHours',
    label: 'моточасы',
    perDay: ENGINE_HOURS_JUMP_PER_DAY,
    // numeric из pg приходит строкой: сравнение строк дало бы «9,5 больше 12».
    valueOf: (row) => (row.engineHours === null ? null : Number(row.engineHours)),
    previousIdOf: (row) => row.previousEngineHoursId,
    anomalyOf: (row) => row.engineHoursAnomaly,
    confirmedAtOf: (row) => row.engineHoursAnomalyConfirmedAt,
    confirmedByOf: (row) => row.engineHoursAnomalyConfirmedBy,
    filled: () => isNotNull(vehicleReadings.engineHours),
    patch: (link) => ({
      previousEngineHoursId: link.previousId,
      engineHoursAnomaly: link.anomaly,
      engineHoursAnomalyConfirmedBy: link.confirmedBy,
      engineHoursAnomalyConfirmedAt: link.confirmedAt,
    }),
  },
];

/** Разница дней между двумя `YYYY-MM-DD`: порог прироста масштабируется ею (Р20). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * Аномалия счётчика. Начала ряда здесь нет намеренно: «предшественника не было» — это состояние
 * (`previous_* IS NULL`), а не отклонение, иначе первое показание каждой машины навсегда осталось
 * бы расхождением и день по новой машине нельзя было бы принять.
 */
function computeAnomaly(
  previous: { value: number; date: string } | null,
  value: number,
  date: string,
  perDay: number,
): ReadingAnomaly | null {
  if (!previous) return null;
  if (value < previous.value) return 'counter_reset';
  // `max(1, d)` внутри `jumpLimit` существенно: у двух смен одного дня d = 0, и без нижней границы
  // любой прирост второй смены стал бы аномалией.
  if (value - previous.value > jumpLimit(perDay, daysBetween(previous.date, date))) {
    return 'implausible_jump';
  }
  return null;
}

/**
 * Предшественник счётчика — ближайшая предыдущая строка **той же машины** с `kind = 'values'`, у
 * которой этот счётчик заполнен, в порядке `(report_date, shift_order)`. Сравнение строчное
 * (`(a, b) < (c, d)`): порядок в цепочке лексикографический, и разложить его на два условия по
 * колонкам без ошибки в границе дня нельзя.
 */
async function findPredecessor(
  tx: Tx,
  at: ChainAnchor,
  spec: CounterSpec,
): Promise<{ id: string; value: number; date: string } | null> {
  const [row] = await tx
    .select()
    .from(vehicleReadings)
    .where(
      and(
        eq(vehicleReadings.vehicleId, at.vehicleId),
        eq(vehicleReadings.kind, 'values'),
        spec.filled(),
        sql`(${vehicleReadings.reportDate}, ${vehicleReadings.shiftOrder})
          < (${at.reportDate}::date, ${at.shiftOrder}::int)`,
      ),
    )
    .orderBy(desc(vehicleReadings.reportDate), desc(vehicleReadings.shiftOrder))
    .limit(1);
  if (!row) return null;
  const value = spec.valueOf(row);
  return value === null ? null : { id: row.id, value, date: row.reportDate };
}

/** Ближайшая следующая строка с этим счётчиком: её предшественник изменился вместе с якорем. */
async function findSuccessorId(tx: Tx, at: ChainAnchor, spec: CounterSpec): Promise<string | null> {
  const [row] = await tx
    .select({ id: vehicleReadings.id })
    .from(vehicleReadings)
    .where(
      and(
        eq(vehicleReadings.vehicleId, at.vehicleId),
        eq(vehicleReadings.kind, 'values'),
        spec.filled(),
        sql`(${vehicleReadings.reportDate}, ${vehicleReadings.shiftOrder})
          > (${at.reportDate}::date, ${at.shiftOrder}::int)`,
      ),
    )
    .orderBy(asc(vehicleReadings.reportDate), asc(vehicleReadings.shiftOrder))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Что известно операции о собственных правках. Подтверждение аномалии не переживает пересчёт
 * (Р20), и уцелеть оно вправе ровно в одном случае: тот же тип аномалии на **обоих концах того же
 * интервала**. Один лишь идентификатор предшественника этого не доказывает — его значение могли
 * поправить, и подтверждали тогда другую разность; поэтому операция и называет здесь показания,
 * чьи числа она тронула.
 */
export interface ChainRecomputeContext {
  actorUserId: string;
  /** Показания, у которых в этой транзакции изменилось значение счётчика. */
  changedValueIds: ReadonlySet<string>;
  /** Показания, тронутые операцией: их прежние преемники ищутся по обратной ссылке. */
  touchedReadingIds: ReadonlySet<string>;
  /** Только что созданные: связи — часть их создания, отдельным событием истории не идут. */
  createdReadingIds: ReadonlySet<string>;
  reason: string;
}

export function emptyChainContext(
  actorUserId: string,
  reason = '',
): ChainRecomputeContext & {
  changedValueIds: Set<string>;
  touchedReadingIds: Set<string>;
  createdReadingIds: Set<string>;
} {
  return {
    actorUserId,
    changedValueIds: new Set<string>(),
    touchedReadingIds: new Set<string>(),
    createdReadingIds: new Set<string>(),
    reason,
  };
}

/**
 * Перестройка соседей — по каждому счётчику отдельно и по объединению старых и новых соседей
 * (Р24). «Следующая строка по общему порядку» не годится дважды: она могла вовсе не содержать
 * нужного счётчика, а перестановка позиций меняет соседство сразу в двух местах ряда.
 *
 * Кандидаты берутся с запасом: пересчёт идемпотентен и молчалив, когда ничего не изменилось, —
 * лишний кандидат стоит одного запроса, пропущенный оставляет в учёте разность, посчитанную не с
 * тем предшественником.
 */
export async function relinkChains(
  tx: Tx,
  anchors: readonly ChainAnchor[],
  ctx: ChainRecomputeContext,
): Promise<void> {
  if (anchors.length === 0 && ctx.touchedReadingIds.size === 0) return;

  const candidates = new Set<string>(ctx.touchedReadingIds);
  const pointerIds = new Set<string>(ctx.touchedReadingIds);

  for (const anchor of anchors) {
    const [atAnchor] = await tx
      .select({ id: vehicleReadings.id })
      .from(vehicleReadings)
      .where(
        and(
          eq(vehicleReadings.vehicleId, anchor.vehicleId),
          eq(vehicleReadings.reportDate, anchor.reportDate),
          eq(vehicleReadings.shiftOrder, anchor.shiftOrder),
        ),
      );
    if (atAnchor) {
      candidates.add(atAnchor.id);
      pointerIds.add(atAnchor.id);
    }
    for (const spec of COUNTERS) {
      const successorId = await findSuccessorId(tx, anchor, spec);
      if (successorId) candidates.add(successorId);
    }
  }

  // Прежние преемники — те, кто ссылался на тронутую строку. Их находит только обратная ссылка:
  // после переноса строки в другой день и другую машину её прежнее место в ряду не вычисляется.
  const pointers = [...pointerIds];
  if (pointers.length > 0) {
    const previous = await tx
      .select({ id: vehicleReadings.id })
      .from(vehicleReadings)
      .where(
        or(
          inArray(vehicleReadings.previousOdometerId, pointers),
          inArray(vehicleReadings.previousEngineHoursId, pointers),
        ),
      );
    for (const row of previous) candidates.add(row.id);
  }

  if (candidates.size === 0) return;
  // Порядок уровня 4 общего протокола: `(vehicle_id, report_date, shift_order)`.
  const rows = await tx
    .select()
    .from(vehicleReadings)
    .where(inArray(vehicleReadings.id, [...candidates]))
    .orderBy(
      asc(vehicleReadings.vehicleId),
      asc(vehicleReadings.reportDate),
      asc(vehicleReadings.shiftOrder),
    );
  for (const row of rows) await recomputeReading(tx, row, ctx);
}

/** Пересчёт одной строки по обоим счётчикам: связь, аномалия и судьба подтверждения. */
async function recomputeReading(
  tx: Tx,
  row: VehicleReadingRow,
  ctx: ChainRecomputeContext,
): Promise<void> {
  let patch: ReadingPatch = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let changed = false;

  for (const spec of COUNTERS) {
    const value = spec.valueOf(row);
    const previous = value === null ? null : await findPredecessor(tx, row, spec);
    const anomaly =
      value === null || !previous
        ? null
        : computeAnomaly(previous, value, row.reportDate, spec.perDay);
    const previousId = previous?.id ?? null;

    // Оба конца интервала те же: тот же предшественник, чьё значение никто не правил, и та же
    // цифра в самой строке. Иначе подтверждённый `counter_reset` превратился бы в
    // `implausible_jump` и остался формально подтверждённым.
    const sameInterval =
      anomaly !== null &&
      anomaly === spec.anomalyOf(row) &&
      previousId === spec.previousIdOf(row) &&
      !ctx.changedValueIds.has(row.id) &&
      (previousId === null || !ctx.changedValueIds.has(previousId));
    const confirmedAt = spec.confirmedAtOf(row);
    const keepConfirmation = sameInterval && confirmedAt !== null;

    const linkChanged =
      previousId !== spec.previousIdOf(row) ||
      anomaly !== spec.anomalyOf(row) ||
      (confirmedAt !== null && !keepConfirmation);
    if (!linkChanged) continue;

    changed = true;
    before[spec.counter] = {
      previousId: spec.previousIdOf(row),
      anomaly: spec.anomalyOf(row),
      confirmed: confirmedAt !== null,
    };
    after[spec.counter] = { previousId, anomaly, confirmed: keepConfirmation };
    patch = {
      ...patch,
      ...spec.patch({
        previousId,
        anomaly,
        confirmedBy: keepConfirmation ? spec.confirmedByOf(row) : null,
        confirmedAt: keepConfirmation ? confirmedAt : null,
      }),
    };
  }

  if (!changed) return;
  const version = row.version + 1;
  await tx
    .update(vehicleReadings)
    .set({ ...patch, version, updatedBy: ctx.actorUserId, updatedAt: new Date() })
    .where(eq(vehicleReadings.id, row.id));
  // Перестройка цепочки меняет смысл разностей, и след ей нужен не меньше, чем правке числа.
  if (ctx.createdReadingIds.has(row.id)) return;
  await writeReadingEvent(tx, {
    readingId: row.id,
    event: 'chain_relinked',
    before,
    after,
    reason: ctx.reason,
    version,
    changedBy: ctx.actorUserId,
  });
}

/**
 * Подтверждение аномалии — по каждому счётчику своё: одометр мог быть сброшен, а моточасы
 * прыгнуть. Ставится **после** пересчёта: иначе перестройка цепочки той же транзакции сняла бы
 * только что поставленную подпись.
 */
export async function confirmAnomalies(
  tx: Tx,
  readingId: string,
  wanted: { odometer: boolean; engineHours: boolean },
  actorUserId: string,
): Promise<boolean> {
  const [row] = await tx.select().from(vehicleReadings).where(eq(vehicleReadings.id, readingId));
  if (!row) return false;
  let patch: ReadingPatch = {};
  const after: Record<string, unknown> = {};
  for (const spec of COUNTERS) {
    const ask = spec.counter === 'odometer' ? wanted.odometer : wanted.engineHours;
    // Подтверждать нечего там, где аномалии нет, и повторно — там, где подпись уже стоит.
    if (!ask || spec.anomalyOf(row) === null || spec.confirmedAtOf(row) !== null) continue;
    patch = {
      ...patch,
      ...spec.patch({
        previousId: spec.previousIdOf(row),
        anomaly: spec.anomalyOf(row),
        confirmedBy: actorUserId,
        confirmedAt: new Date(),
      }),
    };
    after[spec.counter] = { anomaly: spec.anomalyOf(row), confirmed: true };
  }
  if (Object.keys(patch).length === 0) return false;
  const version = row.version + 1;
  await tx
    .update(vehicleReadings)
    .set({ ...patch, version, updatedBy: actorUserId, updatedAt: new Date() })
    .where(eq(vehicleReadings.id, readingId));
  await writeReadingEvent(tx, {
    readingId,
    event: 'anomaly_confirmed',
    after,
    version,
    changedBy: actorUserId,
  });
  return true;
}

/** Есть ли у строки неподтверждённая аномалия — третье условие приёма (Р22). */
export function hasUnconfirmedAnomaly(row: VehicleReadingRow): boolean {
  return COUNTERS.some((spec) => spec.anomalyOf(row) !== null && spec.confirmedAtOf(row) === null);
}

/** Человеческое перечисление неподтверждённых аномалий строки — для списка причин отказа. */
export function unconfirmedAnomalyLabels(row: VehicleReadingRow): string[] {
  return COUNTERS.filter(
    (spec) => spec.anomalyOf(row) !== null && spec.confirmedAtOf(row) === null,
  ).map((spec) => spec.label);
}
