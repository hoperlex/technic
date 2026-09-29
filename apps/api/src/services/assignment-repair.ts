import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  esm2Mode,
  formatVehicleRequestNumber,
  shiftDateKey,
  waybillDisplayNumber,
  type AssignmentChangeTarget,
  type AssignmentIssueWarningsDto,
  type AssignmentPlanIssueDto,
  type DriverState,
  type Esm2Mode,
  type KnownFill,
  type MachinistAnchor,
  type RequiredAnchor,
  type RequiredVehicleResolution,
  type TailResolution,
  type VehicleOwnership,
} from '@technic/contracts';
import { createHash } from 'node:crypto';
import { requestIsLinearSql } from '../db/linear-mode';
import {
  vehicleRequestAssignmentChanges,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicles,
  vehicleTypes,
  waybills,
  waybillSeries,
} from '../db/schema';
import { AppError, err } from '../lib/errors';
import type { AssignmentCommandTx } from './assignment-command';
import type { AssignmentMutation } from './assignment-effects';
import { tailEffectiveDate } from './assignment-effects';
import { assignmentChangeTargetOf } from './assignment-ensure';
import {
  assignmentSegments,
  assignmentStateOn,
  type AssignmentRange,
  type AssignmentSegment,
  type AssignmentTerm,
} from './assignment-history';
// Предупреждения по выпускаемым листам — общим расчётом шага 6 (§7): шестого места, где решают,
// что такое пробел в документах машиниста, заводить нельзя.
import { assignmentPlanIssues } from './assignment-paper';
import type { AssignmentWriteTx } from './assignment-write';
import {
  readAssignmentChanges,
  type AssignmentChangeRecord,
  type AssignmentChangeValue,
  type AssignmentDenormalizationIntent,
  type AssignmentWriteMutation,
} from './assignment-write';
import {
  esm2PaperSegments,
  esm2RequestedSheetPlan,
  esm2SheetPlan,
  normalizeRangeSet,
  rangeSetIntersects,
  rangesIntersect,
  type DateRangeSet,
  type Esm2ExistingSheet,
  type Esm2SheetPlan,
} from './esm2-plan';
import type { Esm2IssuePreparations } from './waybill-esm2';

/**
 * Правила двери ремонта истории назначения
 * (`docs/assignment-periods-plan.md`, Р16, Р21, Р26–Р31; решения Ф1, Х1, Ц3, Ц4, Щ2, Э1–Э3, Ю2).
 *
 * ЧТО ЧИНИТ ЭТА ДВЕРЬ И ЧЕГО НЕ ЧИНИТ. У старых заказов история восстановлена бэкфиллом
 * приблизительно: где-то машинист неизвестен (`unknown`), где-то хвост истории разошёлся с
 * назначением. Работ отсюда ровно три, и все три названы Р29:
 *
 * - **`anchors`** — пробелы машиниста в изменяемой части (Р16): начала `portal`-отрезков, у
 *   которых человека нет. Их закрывает названный человеком якорь, и только он: портал фамилий не
 *   подставляет никогда (ADR 0083), потому что подставленная уезжает в бланк строгой отчётности
 *   настоящей;
 * - **`tailResolution`** — расхождение хвоста (Р31): машина, действующая на конце срока, не равна
 *   машине назначения. Оно не блокер (Р30), но запирает продление, и разрешений у него два;
 * - **`knownFills`** — заполнение `unknown` известным человеком на **заблокированных** днях (Ф1).
 *   Здесь оно реализовано целиком и целиком же закрыто отказом — см. ниже.
 *
 * Расхождение машины **внутри** срока дверь не чинит вовсе: Р30 перевела его из блокеров в
 * предупреждения, и решений по нему нет. Отмена дремлющей tail-группы сюда тоже не входит — она
 * идёт общей командой `cancel` (Р13, Р29), и `repairSchema` формы `cancel` не имеет.
 *
 * ПОЧЕМУ ГОТОВНОСТЬ СЧИТАЕТСЯ СРАВНЕНИЕМ МНОЖЕСТВ, А НЕ ПРОВЕРКОЙ ИНВАРИАНТА (Р27). Частичный
 * ремонт — нормальный исход: две независимые причины невалидности (июньский `unknown` и
 * сентябрьский `cleared` у собственного отрезка) иначе запирали бы друг друга, и починить их по
 * очереди было бы нельзя. Проверка всей свёртки отклонила бы такую команду из-за чужого блокера, а
 * проверка одного диапазона пропустила бы блокер, занесённый **за** его пределы наследованием
 * шкалы. Поэтому считается разность множеств `after \ before`, а единица сравнения — пара
 * `(день, вид)`: по одним дням второй дефект на уже плохом дне и подмена одной причины другой
 * сошли бы за частичный ремонт.
 *
 * ЗАПОЛНЕНИЕ ОТКРЫТО (Х1, Ф1; решение владельца от 24.08.2026). Там, где листа за эти дни не было
 * вовсе — а это обычный случай, `unknown` бэкфилл ставит именно туда, — сверка **выписывает
 * недостающие бланки задним числом**: расход строгой отчётности реальный, и бухгалтерия его
 * согласовала (§15 п. 16). Механический запрет ({@link KNOWN_FILLS_ENABLED}) остаётся на месте
 * выключенным рубильником: свернуть фичу обратно — снятие того же одного значения, а не выпутывание
 * условий из кода.
 *
 * WHAT IS NOT HERE. Writes: this module computes and plans, the write core
 * (`assignment-write.ts`) writes under the canon (`assignment-command.ts`). Paper is executed by
 * step 12 of the door ([vehicle-request-assignment-repair.ts](../routes/vehicle-request-assignment-repair.ts))
 * and only under `read_mode = history`: before the read switch the weekly sync owns the blanks, and
 * it knows one vehicle and one machinist per request — it would rewrite the repaired segments
 * against the repair.
 *
 * Two paper plans are computed, and the difference is one of meaning: the **probe** plan (no
 * unlocks) only names the worked-out sheets the operation must confirm by name (R11); the
 * **executable** plan (unlocks plus the permit for the past) is shown, fingerprinted, executed —
 * and judged for "paper-free" (R29). The probe cannot answer that last question: without the
 * permit it never issues a day that has already ended, so it called a fill of the locked past
 * paper-free while the executable plan minted blanks for it (ADR 0214).
 */

// ── Механический запрет заполнения (Х1, Ф1) ──

/**
 * Включено ли заполнение `unknown` известным человеком (`knownFills`).
 *
 * `true` с 24.08.2026: бухгалтерия ответила на §15 п. 16 — выписка новых номеров задним числом за
 * периоды, где бумаги не было, согласована. Один флаг, а не рассыпанные по коду условия: включение
 * фичи было одним решением, и свернуть её обратно можно тем же движением.
 */
export const KNOWN_FILLS_ENABLED = true;

export const BACKDATED_ISSUE_NOT_AUTHORIZED = 'backdated_issue_not_authorized';

export const BACKDATED_ISSUE_MESSAGE =
  'Выписка бланков задним числом не согласована: заполнение неизвестного прошлого пока закрыто';

/**
 * Отказ по `knownFills` — **до** всякого расчёта и одинаковый у предпросмотра и у боевой ручки.
 *
 * 409, а не 403 и не 422: право у просителя есть, тело верно, и повторить запрос после ответа
 * бухгалтерии он сможет тем же телом. Это состояние сервера, а не ошибка человека.
 */
export function assertKnownFillsAllowed(fills: readonly KnownFill[] | undefined): void {
  if (!fills || fills.length === 0) return;
  if (KNOWN_FILLS_ENABLED) return;
  throw err.conflict(BACKDATED_ISSUE_MESSAGE, { code: BACKDATED_ISSUE_NOT_AUTHORIZED });
}

// ── Контекст ремонта ──

/** A live sheet of the request: the sync needs its bounds and composition, a person its number. */
export interface RepairSheet extends Esm2ExistingSheet {
  displayNumber: string;
  /**
   * The journal operation that minted the sheet (`waybills.correction_id`); `null` — ordinary
   * work. It is the sheet's provenance: cancelling a known fill burns exactly the blanks that the
   * fill's own operation minted on its days (E2, ADR 0214), and a fill checks worked-out paper
   * against everything except those of an already cancelled fill (F1).
   */
  correctionId: string | null;
}

/**
 * Всё, от чего зависят расчёты двери, прочитанное **один раз** под блокировкой.
 *
 * Собрано в один объект не ради удобства: предпросмотр и боевая ручка обязаны считать по одним и
 * тем же входам (§8), а два независимых чтения одной истории расходятся ровно тогда, когда рядом
 * идёт чужая команда.
 */
export interface RepairContext {
  /** Актуальные строки истории до команды. */
  changes: AssignmentChangeRecord[];
  /** Действующие листы заявки — по ним считаются изменяемая часть и план бумаги. */
  sheets: RepairSheet[];
  /** Принадлежность каждой машины, встречающейся в истории и в назначении (Р4). */
  ownershipByVehicle: Map<string, VehicleOwnership>;
  /** Имена машин — ими предпросмотр называет человеку обе стороны расхождения хвоста. */
  vehicleNames: Map<string, string>;
  /**
   * Тип каждой машины: `history_wins` переводит назначение целиком, а `vehicle_type_id` — цель
   * составного FK назначения на технику, и оставить его прежним значило бы записать строку, где
   * машина одна, а тип от другой.
   */
  vehicleTypes: Map<string, string>;
  /** Машина денормализации; `null` — назначения у заявки нет. */
  assignmentVehicleId: string | null;
  assignmentVehicleTypeId: string | null;
  /**
   * Откуда берётся набор нужных листов — из разреза состава или из просьбы человека
   * (ADR 0100 §5). Считается {@link readRepairPaperMode} и только им.
   *
   * Лежит в контексте, а не спрашивается в момент расчёта, по той же причине, что и всё
   * остальное здесь: предпросмотр и боевая ручка считают план дважды каждый (пробный и
   * исполняемый), и четыре независимых чтения режима разошлись бы ровно тогда, когда рядом
   * идёт чужая команда.
   */
  paperMode: Esm2Mode;
  /**
   * Operations of known fills that were cancelled later (their `known_fill` row is superseded
   * as `cancelled`). A live blank minted by such an operation prints a withdrawn claim and does
   * not protect its days from a new fill (F1, ADR 0214) — otherwise "filled with the wrong
   * person → cancelled → filling with the right one" would hit the 422 of the wrong blank.
   *
   * Since ADR 0214 the cancel burns those blanks itself (E2); live ones remain only from cancels
   * made before it, and this set is what keeps them from locking the days for good.
   */
  retractedFillCorrectionIds: ReadonlySet<string>;
}

/**
 * Прочитать всё, что нужно двери.
 *
 * Принадлежность спрашивается и у машин истории, и у машины назначения: `assignment_wins` пишет
 * границу **машиной назначения**, а `esm2PaperSegments` без её принадлежности бросает — план
 * бумаги её не угадывает.
 */
export async function readRepairContext(
  tx: AssignmentWriteTx,
  requestId: string,
  /**
   * История, уже посчитанная вызывающим. Дверь берёт её у `planAssignmentHistory`: у заказа,
   * заведённого до модуля, строк в базе нет вовсе, и второе чтение той же таблицы вернуло бы
   * пустоту там, где расчёт уже восстановил историю по бумаге (§6, Р20).
   */
  history?: readonly AssignmentChangeRecord[],
): Promise<RepairContext> {
  const changes = history
    ? [...history]
    : await readAssignmentChanges(tx, requestId, { actualOnly: true });
  const sheets = await readRepairSheets(tx, requestId);
  const [assignment] = await tx
    .select({
      vehicleId: vehicleRequestAssignments.vehicleId,
      vehicleTypeId: vehicleRequestAssignments.vehicleTypeId,
    })
    .from(vehicleRequestAssignments)
    .where(eq(vehicleRequestAssignments.requestId, requestId));

  const ids = [
    ...new Set(
      [
        ...changes.flatMap((row) => (row.vehicleId ? [row.vehicleId] : [])),
        ...sheets.map((sheet) => sheet.vehicleId),
        ...(assignment?.vehicleId ? [assignment.vehicleId] : []),
      ].filter(Boolean),
    ),
  ];
  const ownershipByVehicle = new Map<string, VehicleOwnership>();
  const vehicleNames = new Map<string, string>();
  const vehicleTypes = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await tx
      .select({
        id: vehicles.id,
        ownership: vehicles.ownership,
        vehicleTypeId: vehicles.vehicleTypeId,
        registrationNumber: vehicles.registrationNumber,
        description: vehicles.description,
      })
      .from(vehicles)
      .where(inArray(vehicles.id, ids));
    for (const row of rows) {
      ownershipByVehicle.set(row.id, row.ownership);
      vehicleTypes.set(row.id, row.vehicleTypeId);
      vehicleNames.set(row.id, row.description || row.registrationNumber || row.id);
    }
  }

  // Superseded rows are not in `changes` (the door works on the actual history), so the cancelled
  // fills are read on their own: only their operations are needed, not their rows.
  const retracted = await tx
    .selectDistinct({ correctionId: vehicleRequestAssignmentChanges.correctionId })
    .from(vehicleRequestAssignmentChanges)
    .where(
      and(
        eq(vehicleRequestAssignmentChanges.requestId, requestId),
        eq(vehicleRequestAssignmentChanges.origin, 'known_fill'),
        eq(vehicleRequestAssignmentChanges.supersededKind, 'cancelled'),
      ),
    );

  return {
    changes,
    sheets,
    ownershipByVehicle,
    vehicleNames,
    vehicleTypes,
    retractedFillCorrectionIds: new Set(
      retracted.flatMap((row) => (row.correctionId ? [row.correctionId] : [])),
    ),
    assignmentVehicleId: assignment?.vehicleId ?? null,
    assignmentVehicleTypeId: assignment?.vehicleTypeId ?? null,
    paperMode: await readRepairPaperMode(
      tx,
      requestId,
      // Принадлежность — машины назначения, как её спрашивает и недельная сверка (`loadRequest`):
      // режим заявки считается по той единице, которой заказ ведут, а не по каждой из истории.
      assignment?.vehicleId ? (ownershipByVehicle.get(assignment.vehicleId) ?? null) : null,
    ),
  };
}

/**
 * Режим бумаги заказа глазами двери ремонта: `esm2Mode` контрактов при **гипотетическом
 * `deleted_at = null`**.
 *
 * ЗАЧЕМ ДВЕРИ ВООБЩЕ РЕЖИМ. Ожидания бумаги считаются из разных мест: в `auto` их задаёт разрез
 * состава — портал сам решает, сколько листов нужно заказу, — а в `on_demand` (линейный заказ,
 * ADR 0100 §5) решения такого у портала нет вовсе: недели называет человек при выписке, и
 * единственный след его просьбы — сами выписанные бланки. Ветку по режиму выбирает
 * {@link repairPaperPlan}, и тем же тройным выбором её выбирают сокращение срока
 * ([assignment-shorten-term.ts](assignment-shorten-term.ts)) и теневое сличение
 * ([assignment-shadow.ts](assignment-shadow.ts)).
 *
 * ПОЧЕМУ АРХИВ СНИМАЕТСЯ. Тот же самый гипотетический `deleted_at = null`, ради которого дверь
 * считает план архивной заявке (см. {@link repairPaperPlan}): мягкое удаление сверку не зовёт, и
 * «в архиве `esm2Mode` = none» ничего не говорит о бумаге. Спроси мы режим как есть, архивный
 * заказ получил бы `none` — и ремонт архивной заявки снова стал бы «бесплатным», то есть вернулась
 * бы ровно та дыра Р29, которую этот расчёт и закрывает.
 *
 * ПОЧЕМУ ЧТЕНИЕ СВОЁ, А НЕ `buildEsm2SyncPlan`. Соседние двери берут режим у неё, и правило это
 * одно на всех — здесь оно тоже не переписывается: решает по-прежнему `esm2Mode` контрактов, а
 * читаются лишь её входы. Отличается ровно один вход — архив, — и подать его недельной сборке
 * нечем: `deletedAt` она берёт из строки заявки и переопределения не принимает. Тем же приёмом и
 * по той же причине спрашивает свой режим теневое сличение (`freshPaperMode`), которому нужна
 * принудительная принадлежность.
 */
async function readRepairPaperMode(
  tx: AssignmentWriteTx,
  requestId: string,
  ownership: VehicleOwnership | null,
): Promise<Esm2Mode> {
  const [head] = await tx
    .select({
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      /*
       * Признак линейности — у **заказанного** типа и через снимок заявки, единственной на портал
       * формулой (`coalesce(is_linear_frozen, vehicle_types.is_linear)`): заявку могло застать
       * переключение признака (ADR 0107), и до конца работы она ведётся снимком. Живой признак
       * сменил бы режим на ходу — то есть посреди уже выписанной бумаги.
       */
      isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear),
    })
    .from(vehicleRequests)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
    .where(eq(vehicleRequests.id, requestId));
  // Заявки нет — сюда дверь не доходит: строку она уже прочла и держит блокировкой (шаг 0 канона).
  if (!head) throw err.notFound('Заявка не найдена');
  return esm2Mode({
    requestType: head.requestType,
    status: head.status,
    ownership,
    deletedAt: null,
    isLinear: head.isLinear,
  });
}

/**
 * The request's live sheets — by the same condition the sync uses: the source request and not
 * cancelled. The blank kind is deliberately not a condition: `source_request_id` is filled only
 * for ESM-2, and an extra condition would be a second definition of the same selection.
 */
async function readRepairSheets(tx: AssignmentWriteTx, requestId: string): Promise<RepairSheet[]> {
  const rows = await tx
    .select({
      id: waybills.id,
      periodFrom: waybills.periodFrom,
      periodTo: waybills.periodTo,
      vehicleId: waybills.vehicleId,
      driverPersonId: waybills.driverPersonId,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
      correctionId: waybills.correctionId,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(and(eq(waybills.sourceRequestId, requestId), ne(waybills.status, 'cancelled')))
    .orderBy(waybills.periodFrom, waybills.id);
  return rows.flatMap((row) =>
    row.periodFrom && row.periodTo
      ? [
          {
            id: row.id,
            periodFrom: row.periodFrom,
            periodTo: row.periodTo,
            vehicleId: row.vehicleId,
            driverPersonId: row.driverPersonId,
            displayNumber: waybillDisplayNumber(row.prefix, row.number, row.numberWidth),
            correctionId: row.correctionId,
          },
        ]
      : [],
  );
}

// ── Изменяемая часть (Р21) ──

/**
 * `mutable(команда) = отменяемые дни ∪ будущее`, подрезанное сроком.
 *
 * Третье слагаемое формулы Р21 — «исторический диапазон, открытый коррекцией этой команды» — сюда
 * не входит намеренно. Оно нужно там, где решают, что команде **разрешено** тронуть; здесь же
 * область служит мерой блокеров, а её обе половины сравнения (`before` и `after`) обязаны считаться
 * одинаково. Подмешай сюда открытый коррекцией диапазон — и `introduced` начал бы зависеть от
 * состава тела запроса, то есть отвечал бы на другой вопрос.
 *
 * Отменяемый день — день листа, который ещё можно аннулировать (`canCancelWaybill`, то есть
 * `periodTo >= asOf`). Считается по **дням** листа, а не по его неделе: разрез Р5 законно кладёт в
 * одну неделю два самостоятельных документа.
 */
export function mutableRangesOf(
  term: AssignmentTerm,
  sheets: readonly Esm2ExistingSheet[],
  asOf: string,
): DateRangeSet {
  const last = term.dateTo || term.dateFrom;
  if (!term.dateFrom || last < term.dateFrom) return [];
  const parts: AssignmentRange[] = [];
  if (last >= asOf) parts.push({ from: asOf > term.dateFrom ? asOf : term.dateFrom, to: last });
  for (const sheet of sheets) {
    if (sheet.periodTo < asOf) continue;
    const from = sheet.periodFrom > term.dateFrom ? sheet.periodFrom : term.dateFrom;
    const to = sheet.periodTo < last ? sheet.periodTo : last;
    if (to >= from) parts.push({ from, to });
  }
  return normalizeRangeSet(parts);
}

/** Пересечение отрезка с набором: обе половины ремонта меряются одной мерой. */
function intersectRanges(
  range: AssignmentRange,
  set: readonly AssignmentRange[],
): AssignmentRange[] {
  const out: AssignmentRange[] = [];
  for (const part of set) {
    const from = range.from > part.from ? range.from : part.from;
    const to = range.to < part.to ? range.to : part.to;
    if (from <= to) out.push({ from, to });
  }
  return out;
}

// ── Блокеры готовности (Р16, Р27, Р30) ──

/**
 * Вид блокера. Их два, и расхождения машины среди них нет (Р30): история и бумага в том случае
 * согласованы, расходится одна денормализация, и readiness к этому отношения не имеет.
 */
export type AssignmentBlockerKind = 'unknown' | 'cleared';

/** Пара «день + вид» — единица сравнения Р27, а не день и не отрезок. */
export interface AssignmentBlockerFact {
  date: string;
  kind: AssignmentBlockerKind;
}

/**
 * Блокеры истории на изменяемой части: `portal`-отрезок обязан иметь машиниста (Р16).
 *
 * Считается по **дням**, потому что по дням и сравнивается: «расширение блокера на соседние дни»
 * обязано дать новую пару, иначе частичный ремонт, раздвинувший дыру, прошёл бы за успешный. У
 * многолетней заявки таких пар тысячи — поэтому наружу они уходят не списком, а потоковым хешем
 * ({@link blockerFingerprintOf}) и интервалами для карточки ({@link blockedDaysOf}).
 *
 * Незаданная шкала (`driver === null`) считается видом `unknown`: и то и другое означает «портал о
 * машинисте этих дней ничего не утверждает», а третьего вида матрица Р27 не знает.
 */
export function blockerFactsOf(
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
  mutable: readonly AssignmentRange[],
): AssignmentBlockerFact[] {
  const facts: AssignmentBlockerFact[] = [];
  for (const segment of esm2PaperSegments(segments, term, ownershipByVehicle)) {
    if (segment.responsibility !== 'portal') continue;
    const kind = blockerKindOf(segment.driver);
    if (!kind) continue;
    for (const part of intersectRanges({ from: segment.from, to: segment.to }, mutable)) {
      for (let day = part.from; day <= part.to; day = shiftDateKey(day, 1)) {
        facts.push({ date: day, kind });
      }
    }
  }
  return facts;
}

function blockerKindOf(driver: DriverState | null): AssignmentBlockerKind | null {
  if (driver === null) return 'unknown';
  if (driver.state === 'set') return null;
  return driver.state;
}

/** Канонический ключ пары — им считаются и разность множеств, и отпечаток. */
const factKey = (fact: AssignmentBlockerFact): string => `${fact.date}|${fact.kind}`;

/**
 * Отпечаток множества блокеров (Р27): потоковый хеш канонически отсортированного списка.
 *
 * Хеш, а не список: у многолетней заявки пар тысячи, и таскать их в теле означало бы платить
 * мегабайтами за ответ на вопрос «то ли состояние вы чинили».
 */
export function blockerFingerprintOf(facts: readonly AssignmentBlockerFact[]): string {
  const hash = createHash('sha256');
  for (const key of [...new Set(facts.map(factKey))].sort()) hash.update(key).update('\n');
  return hash.digest('hex');
}

/** Блокеры, которых **не было** до команды: непустое множество — отказ, и ничего не записано. */
export function introducedBlockers(
  before: readonly AssignmentBlockerFact[],
  after: readonly AssignmentBlockerFact[],
): AssignmentBlockerFact[] {
  const seen = new Set(before.map(factKey));
  const out: AssignmentBlockerFact[] = [];
  const taken = new Set<string>();
  for (const fact of after) {
    const key = factKey(fact);
    if (seen.has(key) || taken.has(key)) continue;
    taken.add(key);
    out.push(fact);
  }
  return out.sort((a, b) => (factKey(a) < factKey(b) ? -1 : 1));
}

/**
 * A command of fills only must leave the blockers of mutable days exactly as it found them
 * (C4, ADR 0214).
 *
 * A fill addresses LOCKED days only; mutable days are repaired by anchors, and there is no second
 * way to name a person there (C4). So a fill-only command that changes the blocker set in any
 * direction has done something it has no right to: removing a blocker means the person it named
 * leaked into mutable days (the defect this guard backs up), adding one means it opened a hole.
 * R27 alone would not catch the leak — it refuses only INTRODUCED blockers, and a vanished one
 * reads to it as a successful partial repair.
 *
 * This is a backstop behind {@link fillNeedsRemainder}, not the rule itself: with the remainder
 * measured by the `unknown` segment the sets already coincide, and a refusal here means the fold
 * met rows it did not expect. Commands with anchors or a tail decision are not fill-only and are
 * judged by R27 as before.
 */
export function assertFillsKeepMutableBlockers(
  body: RepairPlanInput['body'] | { mode: 'inspect' },
  before: readonly AssignmentBlockerFact[],
  after: readonly AssignmentBlockerFact[],
): void {
  if (body.mode !== 'repair') return;
  if (!body.knownFills?.length || body.anchors?.length || body.tailResolution) return;
  if (blockerFingerprintOf(before) === blockerFingerprintOf(after)) return;
  const changed = normalizeRangeSet(
    [...introducedBlockers(before, after), ...introducedBlockers(after, before)].map((fact) => ({
      from: fact.date,
      to: fact.date,
    })),
  );
  throw new AppError(
    422,
    'known_fill_touches_mutable_days',
    'Заполнение прошлого изменило бы машиниста в днях, которые ещё правятся обычным путём: ' +
      changed
        .slice(0, 3)
        .map((range) => (range.from === range.to ? range.from : `${range.from} — ${range.to}`))
        .join(', ') +
      (changed.length > 3 ? ` и ещё ${changed.length - 3}` : '') +
      '. Заполните только отработанные дни, а машиниста на эти дни назовите отдельной операцией',
    { knownFills: 'Заполнение задевает изменяемые дни' },
    { changed },
  );
}

/** Дни блокеров интервалами — проекция для карточки и отчёта, а не единица сравнения. */
export function blockedDaysOf(facts: readonly AssignmentBlockerFact[]): DateRangeSet {
  return normalizeRangeSet(facts.map((fact) => ({ from: fact.date, to: fact.date })));
}

/**
 * Итог ремонта по Р27: `ready`, `materialized` или отказ.
 *
 * `materialized → materialized` разрешён намеренно и это решение, а не умолчание: чужие блокеры
 * команда не обязана ни чинить, ни ухудшать, и запрет частичного ремонта означал бы, что две
 * независимые дыры запирают друг друга навсегда.
 */
export function repairHistoryState(
  before: readonly AssignmentBlockerFact[],
  after: readonly AssignmentBlockerFact[],
): 'materialized' | 'ready' {
  const introduced = introducedBlockers(before, after);
  if (introduced.length > 0) {
    throw new AppError(
      422,
      'assignment_blockers_introduced',
      'Ремонт занёс бы в историю новые пробелы: ' +
        introduced
          .slice(0, 5)
          .map((fact) => `${fact.date} (${fact.kind === 'unknown' ? 'нет данных' : 'снят'})`)
          .join(', ') +
        (introduced.length > 5 ? ` и ещё ${introduced.length - 5}` : ''),
      undefined,
      { introduced },
    );
  }
  return after.length === 0 ? 'ready' : 'materialized';
}

// ── Пробелы машиниста и промежутки заполнения ──

/**
 * Границы, на которых свёртка осталась бы без человека (Р16), — их и только их примет `anchors`.
 *
 * Перечисляются **все** начала `portal`-отрезков без человека в изменяемой части, а не одни
 * переходы `lessor → portal`: бэкфилл создаёт `unknown` от `dateFrom` до первого листа, никакого
 * перехода из аренды там нет, а машинист всё равно неизвестен.
 */
export function requiredAnchorsOf(
  request: { id: string; num: number },
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
  mutable: readonly AssignmentRange[],
): RequiredAnchor[] {
  const anchors: RequiredAnchor[] = [];
  for (const segment of esm2PaperSegments(segments, term, ownershipByVehicle)) {
    if (segment.responsibility !== 'portal') continue;
    if (!blockerKindOf(segment.driver)) continue;
    const parts = intersectRanges({ from: segment.from, to: segment.to }, mutable);
    if (parts.length === 0) continue;
    anchors.push({
      requestId: request.id,
      requestNumber: formatVehicleRequestNumber(request.num),
      // Якорь ставится на начало **отрезка**, а не на начало его изменяемого куска: строка,
      // заведённая посреди отрезка, разрезала бы его надвое и оставила бы первую половину без
      // человека — то есть починила бы половину пробела, объявив вторую половину новой.
      effectiveDate: segment.from,
      from: segment.from,
      to: segment.to,
    });
  }
  return anchors;
}

/**
 * Промежутки `unknown` на **заблокированных** днях — единственный адрес заполнения (Ц4).
 *
 * На изменяемых днях `unknown` чинится обычным путём якорей: там бумага ещё отменяема, и выдумывать
 * второй способ назвать человека незачем. Отрезок тела обязан лежать внутри одного такого
 * промежутка целиком (чужая граница — 422), но покрывать его целиком не обязан: половину истории
 * восстанавливают сейчас, половину — когда найдут документы.
 */
export function fillableGapsOf(
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
  mutable: readonly AssignmentRange[],
): AssignmentRange[] {
  const gaps: AssignmentRange[] = [];
  for (const segment of esm2PaperSegments(segments, term, ownershipByVehicle)) {
    if (segment.responsibility !== 'portal') continue;
    if (blockerKindOf(segment.driver) !== 'unknown') continue;
    let rest: AssignmentRange[] = [{ from: segment.from, to: segment.to }];
    for (const part of mutable) {
      rest = rest.flatMap((range) => subtractRange(range, part));
    }
    gaps.push(...rest);
  }
  return normalizeRangeSet(gaps);
}

/** Отрезок минус отрезок: до двух кусков, перевёрнутые отбрасываются. */
function subtractRange(range: AssignmentRange, cut: AssignmentRange): AssignmentRange[] {
  if (!rangesIntersect(range, cut)) return [range];
  const out: AssignmentRange[] = [];
  if (range.from < cut.from) out.push({ from: range.from, to: shiftDateKey(cut.from, -1) });
  if (range.to > cut.to) out.push({ from: shiftDateKey(cut.to, 1), to: range.to });
  return out;
}

// ── Расхождение хвоста (Р31) ──

/**
 * `tailVehicleMismatch` — машина, **действующая на конце срока**, против машины назначения.
 *
 * Именно свёртка на `dateTo`, а не последняя строка истории (Б2): после сокращения срока последней
 * строкой может остаться машина, которая на конце срока уже не действует, и сравнение с ней
 * прозевало бы настоящее расхождение.
 */
export function tailMismatchOf(
  context: RepairContext,
  term: AssignmentTerm,
): RequiredVehicleResolution | null {
  const tail = assignmentStateOn(context.changes, term.dateTo || term.dateFrom).vehicle?.vehicleId;
  const assigned = context.assignmentVehicleId;
  if (!tail || !assigned || tail === assigned) return null;
  const name = (id: string) => context.vehicleNames.get(id) ?? id;
  return {
    tailVehicleId: tail,
    tailVehicleName: name(tail),
    assignmentVehicleId: assigned,
    assignmentVehicleName: name(assigned),
    since: tailEffectiveDate(term),
  };
}

/** Актуальная группа решения хвоста; `null` — решения ещё не принимали. */
export function tailResolutionGroupOf(
  changes: readonly AssignmentChangeRecord[],
  term: AssignmentTerm,
): AssignmentChangeRecord[] {
  const since = tailEffectiveDate(term);
  const anchor = changes.find(
    (row) =>
      row.origin === 'tail_resolution' &&
      row.dimension === 'vehicle' &&
      row.effectiveDate === since &&
      row.supersededAt === null,
  );
  if (!anchor) return [];
  return changes.filter(
    (row) => row.changeGroupId === anchor.changeGroupId && row.supersededAt === null,
  );
}

// ── План команды ──

/** Что дверь собирается сделать: мутации ядра, логические эффекты и намерение по Р17. */
export interface RepairPlan {
  writeMutations: AssignmentWriteMutation[];
  effectMutations: AssignmentMutation[];
  denormalization: AssignmentDenormalizationIntent;
  /**
   * Перевод назначения на машину истории (`history_wins`, Р31). `null` — назначение не трогается.
   * Полный путь остаётся у двери: Р17 требует именно его, а половинчатая запись «только машина»
   * разошлась бы со ставками.
   */
  assignmentUpdate: {
    vehicleId: string;
    vehicleTypeId: string;
    pricePerHour: number | null;
    pricePerShift: number | null;
    shiftHours: number | null;
  } | null;
  /** Гипотетическая история после команды — вход блокеров `after` и плана бумаги. */
  changesAfter: AssignmentChangeRecord[];
  /**
   * Sheets the paper plan may neither keep nor trim: the blanks a cancelled fill minted on its
   * own days (E2, ADR 0214). Empty for every other command.
   */
  distrustWaybillIds: string[];
  /** Что именно чинили: снимок операции и аудит собираются из этого, а не из тела. */
  summary: {
    anchors: { effectiveDate: string; driverPersonId: string }[];
    fills: { from: string; to: string; personId: string }[];
    cancelledFillGroup: string | null;
    tail: TailResolution['kind'] | null;
  };
}

export interface RepairPlanInput {
  context: RepairContext;
  term: AssignmentTerm;
  asOf: string;
  request: { id: string; num: number };
  /** Тело двери, уже разобранное схемой. */
  body:
    | {
        mode: 'repair';
        anchors?: readonly MachinistAnchor[] | undefined;
        knownFills?: readonly KnownFill[] | undefined;
        tailResolution?: TailResolution | undefined;
      }
    | { mode: 'cancel_fill'; target: { changeGroupId: string } };
}

/**
 * Разложить тело ремонта в мутации ядра — единственное место, где предметные правила двери
 * превращаются в записи.
 *
 * Порядок разделов здесь и есть порядок правил: якоря (Р16), заполнение (Э1, Щ1), отмена
 * заполнения (Щ2, Э1, Ю2), решение хвоста (Р31). Считается всё **до** первой записи: команда,
 * занёсшая новый блокер, обязана откатиться целиком (Р27), и узнать об этом после `INSERT` было бы
 * поздно.
 */
/**
 * План осмотра: ремонт, который ничего не чинит (подэтап 6a).
 *
 * Окно портала обязано сперва спросить, **что** чинить: какие `unknown`-промежутки заблокированы и
 * потому адресуются заполнением, а какие правятся якорями. Ответ считает сервер — он один знает
 * отменяемость бумаги, — и получить его иначе как расчётом двери нельзя.
 *
 * Отдельным планом, а не пустым телом ремонта: `planRepair` на пустом теле законно отвечает «чинить
 * нечего», и ослабить это ради осмотра значило бы разрешить боевой команде записать операцию без
 * предмета. Мутаций здесь нет вовсе, поэтому исход — `none`, и прав такой запрос требует ровно
 * столько, сколько чтение.
 */
export function inspectRepair(changes: readonly AssignmentChangeRecord[]): RepairPlan {
  return {
    writeMutations: [],
    effectMutations: [],
    denormalization: { kind: 'keep' },
    assignmentUpdate: null,
    changesAfter: [...changes],
    distrustWaybillIds: [],
    summary: { anchors: [], fills: [], cancelledFillGroup: null, tail: null },
  };
}

export function planRepair(input: RepairPlanInput): RepairPlan {
  const { context, term, asOf, request, body } = input;
  const plan: RepairPlan = {
    writeMutations: [],
    effectMutations: [],
    denormalization: { kind: 'keep' },
    assignmentUpdate: null,
    changesAfter: [],
    distrustWaybillIds: [],
    summary: { anchors: [], fills: [], cancelledFillGroup: null, tail: null },
  };

  const segments = assignmentSegments(context.changes, term);
  const mutable = mutableRangesOf(term, context.sheets, asOf);

  if (body.mode === 'cancel_fill') {
    planCancelFill(plan, context, term, body.target.changeGroupId);
  } else {
    planAnchors(plan, context, request, segments, term, mutable, body.anchors ?? []);
    planFills(plan, context, segments, term, mutable, body.knownFills ?? []);
    planTail(plan, context, term, body.tailResolution);
  }

  if (plan.writeMutations.length === 0 && plan.effectMutations.length === 0) {
    /*
     * Пустое тело отвергает схема; сюда команда доходит только тогда, когда всё названное ею уже
     * сделано — например, решение хвоста прислано второй раз. Отказ здесь, а не молчаливое
     * «выполнено»: журнал коррекций получил бы строку с причиной и без предмета (Р12).
     *
     * Названное перечисляется поимённо (Ю51): «названное уже сделано» человек прочитать не может —
     * он назвал разом и машиниста, и отрезок, и решение о конце срока, и какое из трёх портал
     * считает сделанным, из отказа не следует.
     */
    throw err.unprocessable(
      `Чинить нечего: ${namedRepairs(body)} — в истории заявки это уже стоит. Откройте карточку заявки заново: пробелы и границы там посчитаются по свежей истории`,
    );
  }

  plan.changesAfter = simulateChanges(context.changes, plan.writeMutations);
  return plan;
}

/**
 * Что тело ремонта назвало — словами человека, а не именами полей запроса (Ю51).
 *
 * Нужен одному отказу: «чинить нечего». Человек в окне называет разом якорь, отрезок и решение о
 * конце срока, и отказ без предмета читается как поломка портала — «я же вижу пробел, почему
 * нечего?». Даты берутся из тела, а не из плана: плана в этот момент нет вовсе — он пуст, и это
 * ровно то, о чём отказ.
 */
function namedRepairs(body: RepairPlanInput['body']): string {
  if (body.mode === 'cancel_fill') return 'отмена заполнения';
  const parts: string[] = [];
  const anchors = body.anchors ?? [];
  const fills = body.knownFills ?? [];
  if (anchors.length > 0) {
    parts.push(`машинист с ${anchors.map((anchor) => anchor.effectiveDate).join(', с ')}`);
  }
  if (fills.length > 0) {
    parts.push(`заполнение ${fills.map((fill) => `${fill.from} — ${fill.to}`).join(', ')}`);
  }
  if (body.tailResolution) parts.push('решение о машине после конца срока');
  return parts.length > 0 ? parts.join(', ') : 'названное телом запроса';
}

// ── Якоря (Р16) ──

function planAnchors(
  plan: RepairPlan,
  context: RepairContext,
  request: { id: string; num: number },
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  mutable: readonly AssignmentRange[],
  anchors: readonly MachinistAnchor[],
): void {
  if (anchors.length === 0) return;
  const allowed = new Set(
    requiredAnchorsOf(request, segments, term, context.ownershipByVehicle, mutable).map(
      (anchor) => anchor.effectiveDate,
    ),
  );
  for (const anchor of anchors) {
    if (!allowed.has(anchor.effectiveDate)) {
      throw err.unprocessable(
        `Якорь на ${anchor.effectiveDate} не нужен: предпросмотр этой границы не называл — посмотрите последствия заново`,
        { anchors: 'Дата не из списка предпросмотра' },
      );
    }
    const existing = actualOn(context.changes, 'driver', anchor.effectiveDate);
    const value: DriverState = { state: 'set', personId: anchor.driverPersonId };
    if (existing) {
      /*
       * A row already stands on this date (a backfill `unknown`, or the remainder of a fill), and
       * the anchor REPLACES it. A replacement normally inherits the group: it edits a decision
       * rather than starting one.
       *
       * The exception is a fill's remainder. Since a fill that reaches the end of the locked days
       * puts its remainder on the first mutable day, that is exactly where the next anchor lands
       * ("two operations", ADR 0214). Inheriting would add a `machinist_change` row to the fill
       * group, which then no longer matches Yu2 ("one `known_fill` plus at most one
       * `unknown_remainder`"): the fill could not be cancelled any more, and a plain cancel of the
       * group would take the fill along with the anchor. So the anchor starts its own group there.
       */
      plan.writeMutations.push({
        kind: 'replace',
        // Логический ключ у строки, восстановленной расчётом (Р10): `id` она получит на шаге 11 —
        // раньше этой замены, но позже расчёта, который её называет.
        target: assignmentChangeTargetOf(existing),
        origin: 'machinist_change',
        ...(existing.origin === 'unknown_remainder'
          ? { group: `anchor-${anchor.effectiveDate}` }
          : {}),
        value: { dimension: 'driver', driver: value },
      });
      plan.effectMutations.push({ kind: 'replace', changeId: existing.id });
    } else {
      plan.writeMutations.push({
        kind: 'insert',
        effectiveDate: anchor.effectiveDate,
        origin: 'machinist_change',
        value: { dimension: 'driver', driver: value },
      });
      plan.effectMutations.push({
        kind: 'insert',
        dimension: 'driver',
        effectiveDate: anchor.effectiveDate,
        // Независимый якорь остаётся `machinist_change` и получает свою одиночную группу (Г2):
        // в группу решения хвоста он не входит и вместе с ним не гаснет.
        origin: 'machinist_change',
      });
    }
    plan.summary.anchors.push({
      effectiveDate: anchor.effectiveDate,
      driverPersonId: anchor.driverPersonId,
    });
  }
}

// ── Заполнение `unknown` (Ф1, Щ1, Э1) ──

/**
 * A fill of a stretch of `unknown` with a known person.
 *
 * A fill has two rows: `set` on `from` and an `unknown` boundary on `to + 1`, both in one group
 * (Shch1). The second is written whenever the driver scale stays unknown past the stretch — see
 * {@link fillNeedsRemainder}: it is measured by the `unknown` SEGMENT, not by the fill address.
 *
 * A FILL NORMALIZES ITS STRETCH (E1): every actual `unknown` row inside `(from, to]` is cancelled,
 * wherever it came from. Without it the cycle "fill the middle → cancel → fill again starting
 * earlier" would leave a fold where the new `set` is cut short by a leftover boundary: the person
 * visible until 31 January instead of 31 March, silently.
 *
 * A FILL ALWAYS HAS ITS OWN GROUP AND A REPLACEMENT DOES NOT INHERIT IT. Yu2 describes the
 * cancellable group as "exactly one actual `known_fill` plus at most one `unknown_remainder`", and
 * a backfill group does not fit that — it also holds the vehicle row of an ownership turn. So a
 * `set` landing on the date of an existing row REPLACES it (Shch2) and goes into its own group,
 * named by the command key: the replacement edits someone else's decision but starts its own. The
 * remainder names the same key and lies next to it.
 *
 * A replacement, not a `cancel` + `insert` pair: cancellation is group-wide (V2), and the left edge
 * of a gap often falls exactly on an ownership turn where the backfill `unknown` shares a group
 * with the vehicle row. A cancel would take the vehicle boundary along — the fill would erase a
 * decision about the vehicle.
 *
 * A FILL DOES NOT RE-ISSUE WORKED-OUT PAPER (F1, ADR 0214): a live blank on the filled days must
 * print the same person and lie within the fill whole — see {@link assertFillMatchesSheets}.
 */
function planFills(
  plan: RepairPlan,
  context: RepairContext,
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  mutable: readonly AssignmentRange[],
  fills: readonly KnownFill[],
): void {
  if (fills.length === 0) return;
  const gaps = fillableGapsOf(segments, term, context.ownershipByVehicle, mutable);
  fills.forEach((fill, index) => {
    const gap = gaps.find((range) => range.from <= fill.from && fill.to <= range.to);
    if (!gap) {
      throw err.unprocessable(
        `Отрезок ${fill.from}–${fill.to} не лежит внутри промежутка без машиниста — посмотрите последствия заново`,
        { knownFills: 'Отрезок вне промежутка' },
      );
    }
    assertFillMatchesSheets(context, fill);
    const group = `fill-${index}`;

    // 1. The row standing on `from` is REPLACED (Shch2), not cancelled, and the replacement goes
    //    into the fill's group, not into the group of the replaced row.
    const value: AssignmentChangeValue = {
      dimension: 'driver',
      driver: { state: 'set', personId: fill.personId },
    };
    const head = actualOn(context.changes, 'driver', fill.from);
    if (head) {
      plan.writeMutations.push({
        kind: 'replace',
        target: assignmentChangeTargetOf(head),
        origin: 'known_fill',
        group,
        value,
      });
      plan.effectMutations.push({ kind: 'replace', changeId: head.id });
    } else {
      plan.writeMutations.push({
        kind: 'insert',
        effectiveDate: fill.from,
        origin: 'known_fill',
        group,
        value,
      });
      plan.effectMutations.push({
        kind: 'insert',
        dimension: 'driver',
        effectiveDate: fill.from,
        origin: 'known_fill',
      });
    }

    // 2. Normalization: every `unknown` still actual inside `(from, to]` is cancelled.
    for (const row of context.changes) {
      if (row.dimension !== 'driver' || row.supersededAt !== null) continue;
      if (row.driverState !== 'unknown') continue;
      if (row.effectiveDate <= fill.from || row.effectiveDate > fill.to) continue;
      assertCancellableAlone(context.changes, row);
      plan.writeMutations.push({ kind: 'cancel', target: assignmentChangeTargetOf(row) });
      plan.effectMutations.push({ kind: 'cancel', changeId: row.id });
    }

    // 3. The remainder boundary: past the stretch the driver stays unknown, and a row must say so.
    const boundary = shiftDateKey(fill.to, 1);
    if (fillNeedsRemainder(context.changes, term, fills, boundary)) {
      plan.writeMutations.push({
        kind: 'insert',
        effectiveDate: boundary,
        origin: 'unknown_remainder',
        group,
        value: { dimension: 'driver', driver: { state: 'unknown' } },
      });
      plan.effectMutations.push({
        kind: 'insert',
        dimension: 'driver',
        effectiveDate: boundary,
        origin: 'unknown_remainder',
      });
    }
    plan.summary.fills.push({ from: fill.from, to: fill.to, personId: fill.personId });
  });
}

/**
 * Whether a fill must close itself with an `unknown_remainder` on `boundary = to + 1` (Sh4, C4).
 *
 * The question is about the `unknown` segment of the driver scale, not about the fill address.
 * The fold carries a state until the next change, so a `set` with nothing after it runs on to the
 * end of the term — and a fill address ends where the LOCKED days end, which is not where the
 * `unknown` ends. The remainder used to be bounded by the address (`boundary <= gap.to`): a fill
 * "up to yesterday" wrote none, and the person it named leaked into today and the days ahead. The
 * mutable blocker vanished without an anchor, the history reported `ready`, and under `history`
 * blanks were minted forward for a person nobody had named on those days (ADR 0214).
 *
 * The boundary is written when all of these hold:
 * - it lies inside the term: past the end there is no day this command could borrow;
 * - no actual driver row stands on it, and no other fill of this command starts there: then the
 *   next change is already in place, and a second actual row on the same scale and date would
 *   break the partial UNIQUE;
 * - before the command the driver there is `unknown` or not set at all. Given the first two, this
 *   follows from the fill lying inside an `unknown` gap; it is checked anyway, because a `set`
 *   carried over from the far side would mean rows the fold does not expect, and a remainder must
 *   never overwrite a known person.
 *
 * On a mutable boundary the remainder keeps the day a blocker: the anchor for it is named by a
 * second operation, the way `requiredAnchors` asks after the fill ("two operations", ADR 0214).
 */
function fillNeedsRemainder(
  changes: readonly AssignmentChangeRecord[],
  term: AssignmentTerm,
  fills: readonly KnownFill[],
  boundary: string,
): boolean {
  if (boundary > (term.dateTo || term.dateFrom)) return false;
  if (actualOn(changes, 'driver', boundary)) return false;
  if (fills.some((other) => other.from === boundary)) return false;
  return blockerKindOf(assignmentStateOn(changes, boundary).driver) === 'unknown';
}

/**
 * A fill against the blanks already issued for its days (F1, decision of 29.09.2026, ADR 0214).
 *
 * A fill states who worked; it is not a crew correction. Where a live blank already covers the
 * filled days, two things are refused with the blank's number:
 *
 * - **the blank prints another person.** The fill would contradict a worked-out strict reporting
 *   document. Before this check the door asked to unlock the blank, burned it and re-issued only
 *   the filled days — the rest of its week was left with no blank at all, and nothing reported
 *   the orphaned days. Who worked is corrected by a crew correction ("Сменить машиниста" with a
 *   past date), which re-issues the whole blank under the journal; a fill does not;
 * - **a fill boundary falls strictly inside the blank**, even with the same person. The cut makes
 *   the blank match no wanted sheet, and the same burn-and-orphan follows. The fill must cover the
 *   blank whole — the blank itself names one person for all its days.
 *
 * The exception is a blank minted by a fill that was cancelled later
 * ({@link RepairContext.retractedFillCorrectionIds}): it prints a withdrawn claim, and protecting
 * its days would lock the cycle "filled with the wrong person → cancelled → filling again".
 * Since the cancel burns such blanks itself (E2), only blanks from cancels made before ADR 0214
 * can still be live.
 *
 * Days of a fill lie in the locked past by construction (a fill address is locked days only), so
 * every blank here is worked-out paper: no cancellable blank exists that the fill could rightly
 * re-issue.
 */
function assertFillMatchesSheets(context: RepairContext, fill: KnownFill): void {
  for (const sheet of context.sheets) {
    const period = { from: sheet.periodFrom, to: sheet.periodTo };
    if (!rangesIntersect(period, fill)) continue;
    if (sheet.correctionId && context.retractedFillCorrectionIds.has(sheet.correctionId)) continue;
    const details = {
      waybillId: sheet.id,
      displayNumber: sheet.displayNumber,
      periodFrom: sheet.periodFrom,
      periodTo: sheet.periodTo,
    };
    if (sheet.driverPersonId !== fill.personId) {
      throw new AppError(
        422,
        'known_fill_contradicts_sheet',
        `На дни заполнения ${fill.from} — ${fill.to} уже выдан лист № ${sheet.displayNumber} ` +
          `(${sheet.periodFrom} — ${sheet.periodTo}), и в нём напечатан другой машинист. ` +
          'Заполнение не переоформляет выданные бланки: если лист верен, заполните эти дни ' +
          'человеком из листа; если в листе ошибка — исправьте состав действием «Сменить ' +
          'машиниста» задним числом, и лист переоформится через журнал коррекций',
        { knownFills: `Расходится с листом № ${sheet.displayNumber}` },
        details,
      );
    }
    if (sheet.periodFrom < fill.from || sheet.periodTo > fill.to) {
      throw new AppError(
        422,
        'known_fill_cuts_sheet',
        `Заполнение ${fill.from} — ${fill.to} режет выданный лист № ${sheet.displayNumber} ` +
          `(${sheet.periodFrom} — ${sheet.periodTo}): заполнение не переоформляет бланки и ` +
          `обязано покрывать лист целиком. Расширьте заполнение до границ листа № ` +
          `${sheet.displayNumber}; если часть его дней в истории уже названа — исправьте состав ` +
          'действием «Сменить машиниста» задним числом',
        { knownFills: `Режет лист № ${sheet.displayNumber}` },
        details,
      );
    }
  }
}

/**
 * Cancellation of a known fill (E2, Yu2, Shch2, E1).
 *
 * The cancellable group is defined by PROVENANCE, not by composition: exactly one actual
 * `known_fill` plus at most one `unknown_remainder`. Otherwise a cancel would turn a KNOWN person
 * back into `unknown` — silently, irreversibly in one command, and in exactly the subsystem where
 * `unknown` means "we do not know".
 *
 * The rule of the cancel itself is the E1 fork on the state IMMEDIATELY to the left of `from`:
 *
 * - `unknown` on the left — the `set` is cancelled and the fold carries the gap on by itself;
 * - anything else on the left — an `unknown` row must remain on `from`: there the `set` replaced
 *   the original boundary, the cancelled does not come back to life (R3), and through an empty
 *   date the state in force BEFORE it would be carried on — the cancel would write history nobody
 *   claimed.
 *
 * The second branch writes `unknown` with `origin = 'unknown_remainder'`: inside a correction
 * `unknown` cannot be expressed otherwise — the table CHECK allows it either to the backfill with
 * no operation or to a remainder with one.
 *
 * THE FILL'S BLANKS BURN WITH IT (E2, ADR 0214). Sheets the fill's own operation minted on its days
 * are handed to the paper plan as distrusted — see {@link fillBlanksOf}.
 */
function planCancelFill(
  plan: RepairPlan,
  context: RepairContext,
  term: AssignmentTerm,
  changeGroupId: string,
): void {
  const members = context.changes.filter(
    (row) => row.changeGroupId === changeGroupId && row.supersededAt === null,
  );
  const fills = members.filter((row) => row.origin === 'known_fill');
  const remainders = members.filter((row) => row.origin === 'unknown_remainder');
  if (
    fills.length !== 1 ||
    remainders.length > 1 ||
    members.length !== fills.length + remainders.length
  ) {
    throw new AppError(
      422,
      'not_a_known_fill_group',
      'Эта группа заполнением не является — отменяйте её обычной отменой изменения',
    );
  }
  const head = fills[0]!;

  // The whole group goes at once: the `set` and its boundary were born of one decision (V2).
  plan.writeMutations.push({ kind: 'cancel', target: assignmentChangeTargetOf(head) });
  plan.effectMutations.push({ kind: 'cancel', changeId: head.id });

  const left = assignmentStateOn(context.changes, shiftDateKey(head.effectiveDate, -1)).driver;
  if (left?.state !== 'unknown') {
    plan.writeMutations.push({
      kind: 'insert',
      effectiveDate: head.effectiveDate,
      origin: 'unknown_remainder',
      value: { dimension: 'driver', driver: { state: 'unknown' } },
    });
    plan.effectMutations.push({
      kind: 'insert',
      dimension: 'driver',
      effectiveDate: head.effectiveDate,
      origin: 'unknown_remainder',
    });
  }
  plan.distrustWaybillIds = fillBlanksOf(context, term, head).map((sheet) => sheet.id);
  plan.summary.cancelledFillGroup = changeGroupId;
}

/**
 * The live blanks a fill minted: its own operation (`waybills.correction_id` equal to the fill
 * row's) and lying on its days (E2, ADR 0214).
 *
 * WHY BY PROVENANCE. After the cancel the filled days are `unknown` again, and an `unknown` day
 * matches any printed person (R19). That rule is right for blanks older than the history — they
 * say who worked, the history merely failed to record it. A blank minted by the fill says nothing
 * of its own: it prints the claim being withdrawn. Left to R19 it would survive the cancel, naming
 * a person the history no longer claims, whenever its period happened to coincide with a period
 * of the restored gap — which the first week of a gap always does.
 *
 * WHY ON ITS DAYS. One operation may carry more than the fill: anchors in the same command, or a
 * second fill of another person. Their blanks share the `correction_id` and must not burn with this
 * fill. The fill's days run from its `from` to the day before the next actual driver change (its
 * remainder, or whatever was written later), else to the end of the term — so blanks a leaking
 * fill minted forward before ADR 0214 are its blanks too.
 */
function fillBlanksOf(
  context: RepairContext,
  term: AssignmentTerm,
  head: AssignmentChangeRecord,
): RepairSheet[] {
  if (!head.correctionId) return [];
  const next = context.changes
    .filter(
      (row) =>
        row.dimension === 'driver' &&
        row.supersededAt === null &&
        row.effectiveDate > head.effectiveDate,
    )
    .map((row) => row.effectiveDate)
    .sort()[0];
  const days: AssignmentRange = {
    from: head.effectiveDate,
    to: next ? shiftDateKey(next, -1) : term.dateTo || term.dateFrom,
  };
  return context.sheets.filter(
    (sheet) =>
      sheet.correctionId === head.correctionId &&
      rangesIntersect(days, { from: sheet.periodFrom, to: sheet.periodTo }),
  );
}

// ── Решение хвоста (Р31) ──

function planTail(
  plan: RepairPlan,
  context: RepairContext,
  term: AssignmentTerm,
  resolution: TailResolution | undefined,
): void {
  if (!resolution) return;
  const since = tailEffectiveDate(term);
  const group = tailResolutionGroupOf(context.changes, term);

  if (resolution.kind === 'assignment_wins') {
    if (group.length > 0) {
      throw err.unprocessable(
        'Портал уже записал, что после конца срока за заявкой числится машина назначения. Переигрывают это решение выбором «работает машина истории» — им назначение переведут на машину, которую ведёт история',
      );
    }
    const mismatch = tailMismatchOf(context, term);
    if (!mismatch) {
      throw err.unprocessable(
        'История и назначение сходятся на конце срока — за заявкой числится одна и та же машина, и выбирать не из чего. Обновите карточку заявки: расхождение, которое вы видели, уже закрыто',
      );
    }
    // Значение границы — **машина назначения** и только она (Р24, исключение): любое другое
    // означало бы плановую смену машины за сроком, то есть обход Р7 со ставками и занятостью.
    const vehicleId = mismatch.assignmentVehicleId;
    plan.writeMutations.push({
      kind: 'insert',
      effectiveDate: since,
      origin: 'tail_resolution',
      group: 'tail',
      value: { dimension: 'vehicle', vehicleId },
    });
    plan.effectMutations.push({
      kind: 'insert',
      dimension: 'vehicle',
      effectiveDate: since,
      origin: 'tail_resolution',
    });
    // Спутник по Р16 рождается тем же решением и той же группой: погасив одну vehicle-границу,
    // отмена оставила бы «собственная машина без машиниста» либо чужого человека следующему
    // отрезку. Арендной машине спутник — `cleared`; собственной он не нужен, а нехватку человека
    // на новых днях покажет `requiredAnchors` после продления.
    if (context.ownershipByVehicle.get(vehicleId) === 'rental') {
      const driverOn = assignmentStateOn(context.changes, since).driver;
      if (driverOn === null || driverOn.state !== 'cleared') {
        plan.writeMutations.push({
          kind: 'insert',
          effectiveDate: since,
          origin: 'tail_resolution',
          group: 'tail',
          value: { dimension: 'driver', driver: { state: 'cleared' } },
        });
        plan.effectMutations.push({
          kind: 'insert',
          dimension: 'driver',
          effectiveDate: since,
          origin: 'tail_resolution',
        });
      }
    }
    // Р17, исключение 1: граница пишется значением текущего назначения, а само назначение и ставки
    // не трогаются — они уже его.
    plan.denormalization = { kind: 'tail_assignment_wins' };
    plan.summary.tail = 'assignment_wins';
    return;
  }

  // `history_wins`. Первичный выбор идёт обычной сменой техники (Р31); здесь живёт **переключение**
  // после `assignment_wins`: строки решения гасятся, назначение и ставки переводятся на машину
  // истории — одной транзакцией, без промежуточного «отменили, а назначение осталось прежним».
  if (group.length === 0) {
    throw err.unprocessable(
      'Портал ещё не записывал, какая машина числится за заявкой после конца срока, — переигрывать нечего. Первый раз машину истории выбирают обычной сменой техники заказа, а здесь только меняют уже принятое решение',
    );
  }
  const anchor = group.find((row) => row.dimension === 'vehicle')!;
  if (anchor.effectiveDate <= (term.dateTo || term.dateFrom)) {
    // Условие обратимости — пустой `inTermRange`, а не календарь (Р31): срок продлили, граница
    // ожила и описывает рабочие дни, и снимать её этой дверью уже нельзя.
    throw err.unprocessable(
      'Срок работ продлили, и запись о машине после конца срока попала внутрь срока — она описывает рабочие дни, и этой дверью уже не снимается. Снимайте её обычной отменой изменения в истории заявки',
    );
  }
  plan.writeMutations.push({ kind: 'cancel', target: assignmentChangeTargetOf(anchor) });
  plan.effectMutations.push({ kind: 'cancel', changeId: anchor.id });

  const afterCancel = simulateChanges(context.changes, plan.writeMutations);
  const tail = assignmentStateOn(afterCancel, term.dateTo || term.dateFrom).vehicle?.vehicleId;
  if (!tail) {
    throw err.unprocessable(
      'История не знает машины на конце срока: переводить назначение не на что',
    );
  }
  const ownership = context.ownershipByVehicle.get(tail);
  const pricePerHour = resolution.pricePerHour ?? null;
  const pricePerShift = resolution.pricePerShift ?? null;
  if (ownership === 'rental' && pricePerHour === null && pricePerShift === null) {
    throw err.badRequest('Укажите стоимость аренды — за час или за смену', {
      pricePerHour: 'Укажите стоимость',
    });
  }
  const vehicleTypeId = context.vehicleTypes.get(tail);
  if (!vehicleTypeId) {
    throw err.unprocessable('Машина истории не найдена в парке: переводить назначение не на что');
  }
  plan.assignmentUpdate = {
    vehicleId: tail,
    vehicleTypeId,
    pricePerHour,
    pricePerShift,
    shiftHours: resolution.shiftHours ?? null,
  };
  // Р17: назначение обязано показать хвост истории — ядро проверит это по живому состоянию.
  plan.denormalization = { kind: 'follow' };
  plan.summary.tail = 'history_wins';
}

// ── Гипотетическая история ──

/**
 * История после команды — **без единой записи**.
 *
 * Нужна дважды и в обеих ролях до записи: по ней считаются блокеры `after` (Р27 требует отказать
 * **ничего не записав**) и план бумаги предпросмотра (Р20 запрещает ему коммитить). Порядок тот же,
 * что у ядра: сначала гаснет всё, потом вставляется новое, — иначе перенос решения упёрся бы в
 * частичный UNIQUE там, где ядро проходит.
 */
export function simulateChanges(
  changes: readonly AssignmentChangeRecord[],
  mutations: readonly AssignmentWriteMutation[],
): AssignmentChangeRecord[] {
  const rows = changes.map((row) => ({ ...row }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, string>();
  const stamp = new Date();
  let seq = 0;

  const resolve = (target: AssignmentChangeTarget) => {
    const row =
      'changeId' in target
        ? byId.get(target.changeId)
        : rows.find(
            (r) =>
              r.dimension === target.dimension &&
              r.effectiveDate === target.effectiveDate &&
              r.supersededAt === null,
          );
    if (!row || row.supersededAt !== null) {
      throw err.unprocessable(
        'Изменение, которое вы правите, уже заменено или отменено — откройте историю заново',
      );
    }
    return row;
  };

  for (const mutation of mutations) {
    if (mutation.kind === 'insert') continue;
    const row = resolve(mutation.target);
    if (mutation.kind === 'replace') {
      row.supersededAt = stamp;
      row.supersededKind = 'replaced';
      continue;
    }
    for (const member of rows) {
      if (member.changeGroupId !== row.changeGroupId || member.supersededAt !== null) continue;
      member.supersededAt = stamp;
      member.supersededKind = 'cancelled';
    }
  }

  for (const mutation of mutations) {
    if (mutation.kind === 'cancel') continue;
    const replaced = mutation.kind === 'replace' ? resolveReplaced(rows, mutation.target) : null;
    const effectiveDate =
      mutation.kind === 'insert' ? mutation.effectiveDate : replaced!.effectiveDate;
    // Та же выдача группы, что у ядра (иначе гипотетическая история разошлась бы с записанной):
    // названная группа сильнее унаследованной, и только за ней — группа заменяемой строки.
    const key = mutation.group;
    const named =
      key === undefined
        ? null
        : (groups.get(key) ?? setGroup(groups, key, `sim-group-${(seq += 1)}`));
    const changeGroupId = named ?? replaced?.changeGroupId ?? `sim-group-${(seq += 1)}`;
    const value = mutation.value;
    rows.push({
      id: `sim-${(seq += 1)}`,
      requestId: rows[0]?.requestId ?? '',
      effectiveDate,
      dimension: value.dimension,
      vehicleId: value.dimension === 'vehicle' ? value.vehicleId : null,
      driverPersonId:
        value.dimension === 'driver' && value.driver.state === 'set' ? value.driver.personId : null,
      driverState: value.dimension === 'driver' ? value.driver.state : null,
      origin: mutation.origin,
      changeGroupId,
      correctionId: null,
      createdBy: null,
      createdAt: stamp,
      supersedesChangeId: replaced?.id ?? null,
      supersededAt: null,
      supersededKind: null,
    });
  }
  return rows;
}

/** Та же строка, что погасил первый проход: искать её заново по актуальным уже нельзя. */
function resolveReplaced(
  rows: readonly AssignmentChangeRecord[],
  target: AssignmentChangeTarget,
): AssignmentChangeRecord {
  const row =
    'changeId' in target
      ? rows.find((r) => r.id === target.changeId)
      : rows.find(
          (r) =>
            r.dimension === target.dimension &&
            r.effectiveDate === target.effectiveDate &&
            r.supersededKind === 'replaced',
        );
  if (!row) throw err.unprocessable('Изменение, которое вы правите, уже заменено или отменено');
  return row;
}

function setGroup(map: Map<string, string>, key: string, value: string): string {
  map.set(key, value);
  return value;
}

// ── План бумаги (Р29) ──

/**
 * План листов для **гипотетического `deleted_at = null`** и по реально существующим листам.
 *
 * Мягкое удаление сверку не зовёт, поэтому листы, выписанные до архивирования, остаются
 * действующими, и «в архиве `esm2Mode` = none» ничего не говорит о бумаге. Без этого расчёта
 * ремонт архивной заявки правил бы историю «бесплатно», restore снимал бы архив — и живая заявка
 * расходилась бы с действующим бланком, причём сверки могло не случиться ещё месяц.
 *
 * ВЕТКА ВЫБИРАЕТСЯ РЕЖИМОМ — тем же выбором, каким её выбирают сокращение срока
 * ([assignment-shorten-term.ts](assignment-shorten-term.ts)) и теневое сличение
 * ([assignment-shadow.ts](assignment-shadow.ts)), и по той же причине: «сколько бумаги нужно
 * заказу» у режимов спрашивается из разных мест, а «что делать с выданным листом» у них общее.
 *
 * Ветки `on_demand` здесь не было, и это была третья дверь того же класса (раздел 7 плана
 * `docs/vehicle-request-actual-end-date-plan.md`). Последствие у неё хуже, чем у двух прежних, и
 * вот почему. У линейного заказа машиниста не называют на заявке вовсе — его называют на каждый
 * лист отдельно (ADR 0100 §6), — и бэкфилл честно оставляет ему **одну** строку истории: машину с
 * начала срока и ни слова о человеке ([assignment-ensure.ts](assignment-ensure.ts), правило 1). А
 * отрезок без человека бумаги не ожидает (`wantedSheets`): ожиданий не оставалось ни на один день,
 * и план получался «погасить всё выписанное». То есть **сжечь номера строгой отчётности** за
 * недели, которые человек просил сам, — и не выписать взамен ничего, потому что выписывать не на
 * кого. Доходило это до бумаги при `read_mode = history`: шаг 12 двери исполняет ровно тот план,
 * который здесь посчитан.
 *
 * Ветвей две, а не три, и `none` среди них нет намеренно: у этой двери его не бывает по
 * построению — режим ей считается с гипотетическим `deleted_at = null`
 * ({@link readRepairPaperMode}), а прочие `none` (грузоперевозка, аренда, заявка не в работе)
 * попадают в ту же ветку разреза, в какой были и до починки. Заведи мы им пустой план, ремонт
 * архивной заявки снова стал бы «бесплатным» — тот самый Р29, ради которого архив здесь и
 * снимается.
 */
export function repairPaperPlan(
  context: RepairContext,
  changesAfter: readonly AssignmentChangeRecord[],
  term: AssignmentTerm,
  asOf: string,
  /**
   * The keys that lift the protection of the past (R11, R21). They only work together: unlocking
   * a worked-out sheet without permitting an ended segment would burn a number and issue nothing
   * in its place.
   *
   * Absent — the plan is the **probe**: it only yields the set of sheets the operation must name
   * (its `locked`). Present — the plan is **executable**: the preview shows it, the fingerprint
   * hashes it, step 12 executes it, and `isPaperFree` (R29) is asked of it. Asking the probe
   * whether a repair is paper-free is wrong: it cannot issue an ended day, so a fill of the locked
   * past looked paper-free while its executable plan minted blanks (ADR 0214).
   */
  unlock?: { waybillIds: readonly string[]; correction: boolean },
  /**
   * Sheets the plan may neither keep nor trim — the blanks of a fill being cancelled
   * ({@link RepairPlan.distrustWaybillIds}). Both plans get them: the probe so that its `locked`
   * is judged by the same plan, the executable one so that it burns them.
   *
   * Only the cut branch uses them. An `on_demand` request derives its wanted sheets FROM its
   * blanks (ADR 0100 §5), so a distrusted blank there would burn and come back as its own twin; a
   * fill mints nothing for it in the first place, its paper coming only from the requester.
   */
  distrustWaybillIds: readonly string[] = [],
): Esm2SheetPlan {
  const planContext = {
    ownershipByVehicle: context.ownershipByVehicle,
    today: asOf,
    ...(unlock ? { unlockWaybillIds: unlock.waybillIds } : {}),
    ...(unlock?.correction ? { correction: { allowed: true as const } } : {}),
  };
  return context.paperMode === 'on_demand'
    ? esm2RequestedSheetPlan(context.sheets, term, planContext)
    : esm2SheetPlan(assignmentSegments(changesAfter, term), term, context.sheets, {
        ...planContext,
        distrustWaybillIds,
      });
}

/**
 * Whether a paper plan is empty — the only meaning of "paper-free" (R29). Ask it of the
 * EXECUTABLE plan (see {@link repairPaperPlan}): the probe cannot issue an ended day and would
 * call a fill of the locked past paper-free.
 *
 * A period trim counts on a par with a cancel and an issue (R5): it changes an issued strict
 * reporting blank — the document's period, the snapshot it prints from and its version — and a
 * plan of one such trim "does not touch paper" in no sense. This is a gate: it decides whether an
 * archived request needs `restore`, and overlooking a trim would let an edit of a strict document
 * pass as paperless.
 */
export function isPaperFree(plan: Esm2SheetPlan): boolean {
  return plan.cancel.length === 0 && plan.issue.length === 0 && plan.trim.length === 0;
}

/**
 * Выпускаемые листы ремонта — так, как их видит окно, — и предупреждения по каждому из них
 * (§7, Б4, Р21).
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В МАРШРУТЕ. Ключ `issueKey` — это индекс в плане, отсортированном по
 * `(from, to, vehicleId, driverPersonId)`, и тем же каноном его считает исполнитель
 * ([esm2-plan.ts](./esm2-plan.ts), `esm2ScopedPlan`). Порядок выборки из базы каноном не является:
 * покажи дверь листы в порядке массива, человек подтвердил бы один лист, а выписался бы другой —
 * и увидеть это было бы не по чему, потому что оба набора на вид одинаковы.
 *
 * ПОЧЕМУ ПРЕДУПРЕЖДЕНИЯ СЧИТАЕТ НЕ ЭТА ФУНКЦИЯ. Их считает `assignmentPlanIssues` — общий вход
 * шага 6 у всех дверей ([assignment-paper.ts](./assignment-paper.ts)). Своя редакция правила «что
 * такое пробел в документах машиниста» здесь стала бы шестой, и разошлись бы они молча: набор
 * подтверждён один, напечатан другой.
 *
 * Имя машиниста не подставляется — как и прежде (ADR 0083): справочник людей читает предпросмотр
 * портала, а фамилия, подставленная сервером «по последнему листу», уезжает в бланк строгой
 * отчётности настоящей.
 */
export async function repairPlanIssues(
  tx: AssignmentCommandTx,
  params: {
    requestId: string;
    /** Исполняемый план бумаги — тот же, который увидит предпросмотр и исполнит шаг 12. */
    plan: Esm2SheetPlan;
    /** Имена машин: ими окно называет человеку выписываемый лист. */
    vehicleNames: ReadonlyMap<string, string>;
  },
): Promise<{
  issue: AssignmentPlanIssueDto[];
  issues: AssignmentIssueWarningsDto[];
  prepared: Esm2IssuePreparations;
}> {
  const issue = [...params.plan.issue]
    .sort((a, b) => {
      const left = `${a.from}|${a.to}|${a.vehicleId}|${a.driver.personId}`;
      const right = `${b.from}|${b.to}|${b.vehicleId}|${b.driver.personId}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((want, index) => ({
      issueKey: index,
      from: want.from,
      to: want.to,
      vehicleId: want.vehicleId,
      vehicleName: params.vehicleNames.get(want.vehicleId) ?? want.vehicleId,
      driverPersonId: want.driver.personId,
      driverName: '',
    }));
  const planIssues = await assignmentPlanIssues(tx, { requestId: params.requestId, issue });
  return { issue, issues: planIssues.issues, prepared: planIssues.prepared };
}

/**
 * Листы, которые команда обязана назвать поимённо, чтобы переоформить (Р11): отработанные и
 * пересекающие область бумаги.
 */
export function requiredUnlocksOf(
  context: RepairContext,
  plan: Esm2SheetPlan,
  paperScope: readonly AssignmentRange[],
): RepairSheet[] {
  const locked = new Set(plan.locked);
  return context.sheets.filter(
    (sheet) =>
      locked.has(sheet.id) &&
      rangeSetIntersects(paperScope, { from: sheet.periodFrom, to: sheet.periodTo }),
  );
}

// ── Мелочи ──

/** Актуальная строка шкалы на дату; `undefined` — её нет. */
function actualOn(
  changes: readonly AssignmentChangeRecord[],
  dimension: 'vehicle' | 'driver',
  effectiveDate: string,
): AssignmentChangeRecord | undefined {
  return changes.find(
    (row) =>
      row.dimension === dimension &&
      row.effectiveDate === effectiveDate &&
      row.supersededAt === null,
  );
}

/**
 * Страж **нормализации** отрезка, а не начала заполнения.
 *
 * На левой границе дыры строка теперь заменяется (Щ2), и составная группа бэкфилла ей больше не
 * помеха — vehicle-строка перехода принадлежности замену переживает. Но внутри `(from, to]`
 * лишние `unknown` именно **гасятся**, а гашение групповое (В2): попади туда строка чужого
 * составного решения, вместе с ней ушла бы и его vehicle-граница — молча.
 *
 * Нормативный бэкфилл такого не строит: составную группу он заводит только переходу
 * принадлежности, а переход режет отрезок и делает эту дату **началом** дыры, а не её серединой
 * (`fillableGapsOf` собирает промежутки по отрезкам свёртки). Страж остаётся ради данных, которые
 * нормативу не отвечают: молчаливая потеря решения о машине дороже понятного отказа.
 */
function assertCancellableAlone(
  changes: readonly AssignmentChangeRecord[],
  row: AssignmentChangeRecord,
): void {
  const others = changes.filter(
    (other) =>
      other.changeGroupId === row.changeGroupId &&
      other.supersededAt === null &&
      other.id !== row.id,
  );
  if (others.length === 0) return;
  throw err.unprocessable(
    `Внутри отрезка есть составное решение от ${row.effectiveDate} — заполните промежуток по частям, до этой даты и после неё`,
    { knownFills: 'Внутри отрезка составное решение' },
  );
}
