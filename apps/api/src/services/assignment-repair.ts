import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  formatVehicleRequestNumber,
  shiftDateKey,
  waybillDisplayNumber,
  type AssignmentChangeTarget,
  type DriverState,
  type KnownFill,
  type MachinistAnchor,
  type RequiredAnchor,
  type RequiredVehicleResolution,
  type TailResolution,
  type VehicleOwnership,
} from '@technic/contracts';
import { createHash } from 'node:crypto';
import { vehicleRequestAssignments, vehicles, waybills, waybillSeries } from '../db/schema';
import { AppError, err } from '../lib/errors';
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
  esm2SheetPlan,
  normalizeRangeSet,
  rangeSetIntersects,
  rangesIntersect,
  type DateRangeSet,
  type Esm2ExistingSheet,
  type Esm2SheetPlan,
} from './esm2-plan';

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
 * ЧЕГО ЗДЕСЬ НЕТ. Записи: модуль считает и планирует, а пишет ядро (`assignment-write.ts`) под
 * каноном (`assignment-command.ts`). И бумаги: шаг 12 канона (`applyEsm2SyncPlanAndAudit`) пуст у
 * **всех** дверей этой волны, и наполнять его в одиночку нельзя — вместе с ним уходят шесть
 * внешних вызовов `auditEsm2Sync`. Поэтому план листов здесь **считается** (он нужен предпросмотру
 * и правилу «paper-free по расчёту, а не по статусу архива», Р29), но не исполняется.
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

/** Действующий лист заявки: сверке нужны границы и состав, человеку — номер. */
export interface RepairSheet extends Esm2ExistingSheet {
  displayNumber: string;
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

  return {
    changes,
    sheets,
    ownershipByVehicle,
    vehicleNames,
    vehicleTypes,
    assignmentVehicleId: assignment?.vehicleId ?? null,
    assignmentVehicleTypeId: assignment?.vehicleTypeId ?? null,
  };
}

/**
 * Действующие листы заявки — тем же условием, каким их отбирает сверка: основание и не
 * аннулирован. Вида бланка среди условий нет намеренно: `source_request_id` заполняется только у
 * ЭСМ-2, и лишнее условие означало бы второе определение того же отбора.
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
export function planRepair(input: RepairPlanInput): RepairPlan {
  const { context, term, asOf, request, body } = input;
  const plan: RepairPlan = {
    writeMutations: [],
    effectMutations: [],
    denormalization: { kind: 'keep' },
    assignmentUpdate: null,
    changesAfter: [],
    summary: { anchors: [], fills: [], cancelledFillGroup: null, tail: null },
  };

  const segments = assignmentSegments(context.changes, term);
  const mutable = mutableRangesOf(term, context.sheets, asOf);

  if (body.mode === 'cancel_fill') {
    planCancelFill(plan, context, body.target.changeGroupId);
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
      // Правка принятого решения: строка на этой дате уже есть (`unknown` бэкфилла), и якорь её
      // **заменяет**. Группу замена наследует — она правит решение, а не заводит своё.
      plan.writeMutations.push({
        kind: 'replace',
        // Логический ключ у строки, восстановленной расчётом (Р10): `id` она получит на шаге 11 —
        // раньше этой замены, но позже расчёта, который её называет.
        target: assignmentChangeTargetOf(existing),
        origin: 'machinist_change',
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
 * Заполнение отрезка известным человеком.
 *
 * Строк у заполнения две: `set` на `from` и граница `unknown` на `to + 1`, обе одной группой (Щ1).
 * Вторая пишется только тогда, когда за отрезком остаётся неизвестное: заполнили до конца
 * промежутка — там уже стоит следующее изменение, и вторая граница была бы мусором.
 *
 * ЗАПОЛНЕНИЕ НОРМАЛИЗУЕТ ОТРЕЗОК (Э1): все актуальные `unknown`-строки внутри `(from, to]` гаснут,
 * откуда бы они ни взялись. Без этого цикл «заполнил середину → отменил → заполнил заново, начиная
 * раньше» дал бы свёртку, где новый `set` перебит оставшейся границей: человек виден по 31 января
 * вместо 31 марта, и молча.
 *
 * ГРУППА У ЗАПОЛНЕНИЯ ВСЕГДА СВОЯ, И ЗАМЕНА ЕЁ НЕ НАСЛЕДУЕТ. Ю2 описывает отменяемую группу как
 * «ровно одна актуальная `known_fill` плюс не более одной `unknown_remainder`», а группа бэкфилла
 * этому описанию не отвечает — в ней лежит ещё и vehicle-строка перехода принадлежности. Поэтому
 * `set`, встающий на дату существующей строки, **заменяет** её (Щ2) и уходит в собственную группу,
 * названную ключом команды: замена правит чужое решение, но начинает своё. Спутник — граница
 * `unknown_remainder` — называет тот же ключ и ложится рядом.
 *
 * Заменой, а не парой `cancel` + `insert`: гашение групповое (В2), и левая граница дыры сплошь и
 * рядом приходится ровно на переход принадлежности, где `unknown` бэкфилла лежит в одной группе с
 * vehicle-строкой. Отмена унесла бы vehicle-границу заодно — то есть заполнение дыры стёрло бы
 * решение о машине.
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
    const group = `fill-${index}`;

    // 1. Дата `from`: строка, стоящая на ней, **заменяется** (Щ2), а не гасится, — и замена уходит
    //    в группу заполнения, а не в группу заменённой строки.
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

    // 2. Нормализация отрезка: всё, что осталось `unknown` внутри `(from, to]`, гаснет.
    for (const row of context.changes) {
      if (row.dimension !== 'driver' || row.supersededAt !== null) continue;
      if (row.driverState !== 'unknown') continue;
      if (row.effectiveDate <= fill.from || row.effectiveDate > fill.to) continue;
      assertCancellableAlone(context.changes, row);
      plan.writeMutations.push({ kind: 'cancel', target: assignmentChangeTargetOf(row) });
      plan.effectMutations.push({ kind: 'cancel', changeId: row.id });
    }

    // 3. Граница остатка: за отрезком неизвестное продолжается, и сказать об этом обязана строка.
    const boundary = shiftDateKey(fill.to, 1);
    if (boundary <= gap.to) {
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
 * Отмена заполнения (Э2, Ю2, Щ2, Э1).
 *
 * Отменяемую группу определяет **провенанс, а не состав**: ровно одна актуальная `known_fill` плюс
 * не более одной `unknown_remainder`. Иначе отмена превратила бы **известного** человека обратно в
 * `unknown` — молча, необратимо в одну команду и ровно в той подсистеме, где `unknown` означает
 * «мы не знаем».
 *
 * Правило самой отмены — развилка Э1 по состоянию **непосредственно слева** от `from`:
 *
 * - слева `unknown` — `set` гасится, и свёртка сама тянет дыру от прежней границы;
 * - слева не `unknown` — на дате `from` обязана остаться строка `unknown`: там `set` заменил
 *   исходную границу, а погашенное не оживает (Р3), и через пустую дату протянулось бы состояние,
 *   действовавшее **до** неё, — то есть отмена дописала бы историю, которой никто не заявлял.
 *
 * Вторая ветка пишет `unknown` с `origin = 'unknown_remainder'`: `unknown` внутри коррекции иначе не
 * представим — `CHECK` таблицы разрешает его либо бэкфиллу без операции, либо остатку с ней.
 */
function planCancelFill(plan: RepairPlan, context: RepairContext, changeGroupId: string): void {
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

  // Гасится вся группа разом: `set` и его граница рождены одним решением и снимаются вместе (В2).
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
  plan.summary.cancelledFillGroup = changeGroupId;
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
 */
export function repairPaperPlan(
  context: RepairContext,
  changesAfter: readonly AssignmentChangeRecord[],
  term: AssignmentTerm,
  asOf: string,
): Esm2SheetPlan {
  return esm2SheetPlan(assignmentSegments(changesAfter, term), term, context.sheets, {
    ownershipByVehicle: context.ownershipByVehicle,
    today: asOf,
  });
}

/** Пуст ли бумажный план: только это и означает «paper-free» (Р29). */
export function isPaperFree(plan: Esm2SheetPlan): boolean {
  return plan.cancel.length === 0 && plan.issue.length === 0;
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
