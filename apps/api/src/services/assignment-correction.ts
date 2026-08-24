import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  waybillDisplayNumber,
  type AccessSubject,
  type AssignmentClearedApprovalDto,
  type AssignmentCorrectionPreviewDto,
  type AssignmentVehicleCorrectionInput,
  type Esm2Period,
  type OperationRequirement,
  type VehicleOwnership,
} from '@technic/contracts';
import { err } from '../lib/errors';
import type { AuditEntry } from '../lib/audit';
import {
  users,
  vehicleRequestAssignments,
  vehicleRequestShifts,
  vehicles,
  waybills,
  waybillSeries,
} from '../db/schema';
import type {
  AssignmentApplyContext,
  AssignmentCommandSpec,
  AssignmentCommandTx,
  AssignmentPlanContext,
  AssignmentPlanned,
} from './assignment-command';
import {
  assignmentCommandEffects,
  type AssignmentEffects,
  type AssignmentMutation,
} from './assignment-effects';
import {
  assignmentChangeTargetOf,
  assignmentHistoryUnrestorableReason,
  ensureCommandHistory,
  planAssignmentHistory,
} from './assignment-ensure';
import { assignmentSegments } from './assignment-history';
import {
  applyAssignmentMutations,
  resolveChangeTarget,
  type AssignmentChangeRecord,
  type AssignmentDenormalizationIntent,
  type AssignmentWriteMutation,
  type AssignmentWriteResult,
} from './assignment-write';
// Право коррекции — одно правило на все двери истории, и живёт оно у двери машиниста (волна 3.2).
// Своя копия «`crew` требует `waybills.correct`, глубже тридцати дней — `correctBeyondLimit`»
// разошлась бы с ней при первой же правке правила, а разъезжаются такие пары молча.
import { authorizeCrewCommand, authorizeCrewRepeat, fingerprintOf } from './assignment-crew';
import { esm2SheetPlan, type DateRangeSet, type Esm2ExistingSheet } from './esm2-plan';
import { buildEsm2SyncPlan } from './waybill-esm2';
import { clearShiftApprovals, type ShiftApproval } from './vehicle-route-correction';

/**
 * Периодная коррекция — правка **прошлого решения о машине**, адресуемая целью
 * (`docs/assignment-periods-plan.md`, Р7, Р10–Р13, Р32; §8, волна 3.3).
 *
 * ЧТО ЭТА ДВЕРЬ ДЕЛАЕТ. До истории назначение было одно на весь срок, и «в марте работала другая
 * машина» выражалось единственным способом: переписать назначение целиком и переоформить всю
 * бумагу заявки, сняв заодно **все** её подписи ([vehicle-requests.ts](../routes/vehicle-requests.ts),
 * `approvedShiftsOfRequest`). С разрезом у заявки появляются отрезки, и правится один из них:
 *
 * - **цель называется явно** (Р10) — идентификатором изменения либо логическим ключом
 *   «шкала + дата». Второй адрес не удобство: у заявки, история которой ещё не материализована,
 *   `changeId` не существует вовсе, и исправить восстановленную из листов смену было бы нечем;
 * - **последствия считаются по диапазону цели** (Р11) — до следующего изменения той же шкалы, а не
 *   «на весь срок»;
 * - **подписи снимаются ровно в `approvalClearRange`** — единственной границе снятия. `paperRange`
 *   шире: он включает и смены машиниста, а фамилии машиниста в `vehicle_request_shifts` нет вовсе,
 *   и переподписывать часы объекту из-за смены человека не за что.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ И ПОЧЕМУ (границы — предметные, а не технические):
 *
 * - **шкалу `driver` не правит**: прошлое решение о человеке правит дверь машиниста той же датой
 *   (`kind: 'set'`, `assignment-crew.ts`) — там уже живут якоря Р16 и правила `cleared`. Вторая
 *   дорога к тому же решению означала бы два расходящихся набора правил и две строки журнала об
 *   одном событии;
 * - **хвост истории не двигает**: сменить машину, которой заявка закрыта **сейчас**, значит
 *   переписать назначение со ставками, арендой и рейсом — это окно смены техники (Р7, Р17). Цель,
 *   оказавшаяся последним активным vehicle-изменением, отвергается словами, а не молча правится;
 * - **принадлежность не меняет**: `own → rental` заводит бумагу там, где её не было (или наоборот),
 *   и требует `cleared`-спутника машинисту (Р16). Ставки и аренда — та же дверь смены техники;
 * - **бланки не переоформляет** (этап 3, дуальная запись с паритетом старой бумаги — Б1, В3):
 *   недельная сверка знает одну машину на заявку и переписала бы задетые недели **машиной
 *   назначения**, то есть ровно вопреки коррекции. Исполнителя отрезкового плана принесёт этап 5, а
 *   до тех пор команда, задевающая действующий лист, отвергается до единой записи и называет эти
 *   листы поимённо.
 *
 * ГДЕ ГРАНИЦА С КАРКАСОМ. Порядок транзакции, блокировки, отпечаток, **строка журнала коррекций**,
 * версия и аудит принадлежат `assignment-command.ts`; запись строк — `assignment-write.ts`;
 * проекции последствий — `assignment-effects.ts`; сама строка журнала пишется общим
 * `waybill-correction.ts`. Здесь только предметные правила коррекции.
 */

/** Имя двери в цели операции журнала (Р9) и в отпечатке предпросмотра. */
const DOOR = 'assignment-correction';

/**
 * Происхождение новой строки. `reassignment` — «обычная смена техники существующей дверью»: по
 * составу коррекция и есть смена машины, а отличает её от плановой не `origin`, а `correction_id`,
 * который ядро записи проставит из строки журнала.
 */
const CORRECTION_ORIGIN = 'reassignment' as const;

// ── Что дверь посчитала ──

/** Цель коррекции, разрешённая под блокировкой (Р10). */
export interface CorrectionTarget {
  changeId: string;
  effectiveDate: string;
  vehicleId: string;
  changeGroupId: string;
  origin: string;
}

/**
 * Предметный план коррекции: всё, что посчитано до первой записи и дальше только читается.
 *
 * Один объект на предпросмотр и на исполнение (§8): предпросмотр обязан обещать ровно то, что
 * произойдёт, а вторая копия расчёта разошлась бы с первой на первом же новом правиле.
 */
export interface VehicleCorrectionPlan {
  target: CorrectionTarget;
  /** Машина, стоявшая на этом отрезке, и та, которая работала на самом деле. */
  vehicleBefore: string;
  vehicleAfter: string;
  mutations: AssignmentWriteMutation[];
  /**
   * Обещание по денормализации (Р17) — всегда `keep`: коррекция правит прошлое, а «чем заявка
   * закрыта сейчас» не трогает. Сдвинувшийся от неё хвост означал бы ошибку двери, и ядро это
   * проверит по живому состоянию.
   */
  denormalization: AssignmentDenormalizationIntent;
  /** Область бумаги (Р11, §7): документное замыкание дневного диапазона. */
  paperScope: DateRangeSet;
  /**
   * Действующие листы, которых команда касается. В этой волне они не разблокируются, а **запирают**
   * команду (см. шапку модуля): предпросмотр их показывает, а боевая ручка отказывает рукопожатием
   * — иначе отказ звучал бы как «нельзя», без ответа на вопрос «что мешает».
   */
  blockingSheets: { waybillId: string; displayNumber: string; from: string; to: string }[];
  /** Отпечаток серверного множества разблокировок; `null` — разблокировок нет. */
  unlockFingerprint: string | null;
  /** Подписи, попавшие в `approvalClearRange`: ровно они и будут сняты шагом 12. */
  approvals: ShiftApproval[];
}

/** Что дверь пронесла через шаг 12 в аудит и снимок операции. */
export interface CorrectionPaper {
  /** Дни, с которых снята подпись объекта. */
  clearedApprovals: string[];
}

// ── Расчёт (шаги 4–6 канона) ──

/**
 * Посчитать коррекцию целиком: цель, значение, последствия, бумагу, подписи и отпечаток.
 *
 * Транзакция приходит читающей (`readOnlyTx` каркаса): до сверки отпечатка и авторизации команда
 * ничего не записывает (Р20). Все отказы здесь предметные и потому здесь, а не в схеме: историческая
 * команда или дремлющая, задевает ли она бумагу и подписи — видно только под блокировкой.
 */
export async function planVehicleCorrection(
  ctx: AssignmentPlanContext,
  input: AssignmentVehicleCorrectionInput,
): Promise<AssignmentPlanned<VehicleCorrectionPlan>> {
  const { tx, request, asOf } = ctx;
  const term = request.term;

  // Архивная заявка этой дверью не открывается: её историю чинит дверь ремонта, адресуясь
  // идентификатором намеренно (Ц3), а коррекция работает с живой заявкой и её бумагой.
  if (request.deletedAt) throw err.notFound('Заявка не найдена');
  /*
   * Шаг 5 канона в его расчётной половине (Р20): готовность истории **считается**, а не пишется.
   * Коррекция как раз и есть тот случай, ради которого §6 писался: «в марте работала другая
   * машина» правят на истории, восстановленной из листов, — и до этой волны такая заявка получала
   * отказ вместо работы. Записывает эти же строки шаг 11.
   */
  const history = await planAssignmentHistory(tx, { requestId: request.id, asOf });
  if (history.state === 'empty') {
    throw err.unprocessable(
      `История назначения этой заявки не восстановлена: ${assignmentHistoryUnrestorableReason(history.unrestorable)}`,
      { requestId: 'История не материализована' },
    );
  }

  const changes = history.changes;

  // Режим бумаги и действующие листы — у той работы, которая их и считает: своя копия «что такое
  // действующий лист заявки» разошлась бы со сверкой при первой же правке.
  const base = await buildEsm2SyncPlan(tx, { requestId: request.id, asOf });
  if (!base) throw err.notFound('Заявка не найдена');
  const esm2Mode = base.input.mode;
  const sheets: Esm2ExistingSheet[] = [...base.input.existing];
  if (esm2Mode === 'on_demand') {
    // Р14: у линейного заказа машина дня — машина рейса, а назначение остаётся умолчанием
    // (ADR 0100 §4). Правка умолчания задним числом не опровергает ни бумагу дня, ни подпись под
    // его часами, и делать вид, что опровергает, дверь не будет.
    throw err.unprocessable(
      'У линейного заказа машину дня задаёт рейс, а не назначение — правьте рейс и его лист, а не историю заявки',
      { requestId: 'Линейный заказ' },
    );
  }

  const target = targetOf(changes, input);
  const vehicleAfter = input.vehicleId;
  const ownershipByVehicle = await readOwnership(tx, request.id, changes, vehicleAfter);
  assertNewVehicle(changes, target, vehicleAfter, ownershipByVehicle);

  const mutations: AssignmentWriteMutation[] = [
    {
      kind: 'replace',
      // Логический ключ у строки, восстановленной расчётом: `id` она получит на шаге 11, и он
      // появится **до** этой замены, но узнать его в фазе расчёта неоткуда (Р10).
      target: assignmentChangeTargetOf({
        id: target.changeId,
        dimension: 'vehicle',
        effectiveDate: target.effectiveDate,
      }),
      value: { dimension: 'vehicle', vehicleId: vehicleAfter },
      origin: CORRECTION_ORIGIN,
    },
  ];
  const effectMutations: AssignmentMutation[] = [{ kind: 'replace', changeId: target.changeId }];

  // Гипотетическая история: та же строка, но с новой машиной. Замена шкалы и даты не меняет —
  // их держит составной FK цепочки (Р3), — поэтому подмены значения достаточно.
  const changesAfter = changes.map((row) =>
    row.id === target.changeId ? { ...row, vehicleId: vehicleAfter } : row,
  );
  const segmentsBefore = assignmentSegments(changes, term);
  const segmentsAfter = assignmentSegments(changesAfter, term);

  const planContextOf = (options: { scope?: DateRangeSet; correction?: boolean }) => ({
    ownershipByVehicle,
    today: asOf,
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.correction ? { correction: { allowed: true as const } } : {}),
  });
  /** Отрезки `wanted` до и после команды: замыкание области считается по обоим разрезам (§7). */
  const wanted: Esm2Period[] =
    esm2Mode === 'none'
      ? []
      : [
          ...esm2SheetPlan(segmentsBefore, term, [], planContextOf({})).wanted,
          ...esm2SheetPlan(segmentsAfter, term, [], planContextOf({})).wanted,
        ];

  const effects = assignmentCommandEffects({
    changes,
    term,
    asOf,
    mutations: effectMutations,
    sheets,
    wanted,
  });

  const paperScope = effects.paperScope;
  const numbers = await readSheetNumbers(tx, request.id);
  /*
   * Бумага, запирающая команду (паритет старой бумаги — Б1, В3). Недельная сверка — единственный
   * исполнитель бланков на этапе 3, а знает она одну машину на заявку: позвав её после коррекции
   * отрезка, мы получили бы недели, переписанные машиной **назначения**, то есть прямо
   * противоположные тому, что человек подтвердил.
   *
   * Считается здесь, а отвергается рукопожатием (шаг 8): предпросмотр обязан **показать**
   * человеку, что мешает, а не ответить отказом вместо плана. Тем же порядком устроен отказ двери
   * ремонта «нужен режим восстановления».
   */
  const blockingSheets = sheets
    .filter((sheet) => rangesOverlap(paperScope, sheet.periodFrom, sheet.periodTo))
    .map((sheet) => ({
      waybillId: sheet.id,
      displayNumber: numbers.get(sheet.id) ?? sheet.id,
      from: sheet.periodFrom,
      to: sheet.periodTo,
    }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const approvals = await approvalsInRange(
    tx,
    request.id,
    formatVehicleRequestNumber(request.num),
    effects.approvalClearRange,
  );

  const plan: VehicleCorrectionPlan = {
    target,
    vehicleBefore: target.vehicleId,
    vehicleAfter,
    mutations,
    denormalization: { kind: 'keep' },
    paperScope,
    blockingSheets,
    // Разблокировок у этой волны не бывает: команда, которой они понадобились бы, отвергается
    // рукопожатием. Поле остаётся, потому что рукопожатие Д4 симметрично — лишний отпечаток в теле
    // это заявка на право сжечь чужие номера, и терпеть её нельзя даже там, где сжигать нечего.
    unlockFingerprint: null,
    approvals,
  };

  return {
    effects,
    fingerprint: previewFingerprintOf(request.id, asOf, input, effects, plan),
    plan,
  };
}

// ── Цель и значение (Р10, Р12) ──

/**
 * Разрешить цель под блокировкой и проверить, что она этой двери (Р10).
 *
 * Отказы разные, потому что разные и поручения человеку: «правьте другой дверью» — не то же, что
 * «этой строки больше нет».
 */
function targetOf(
  changes: readonly AssignmentChangeRecord[],
  input: AssignmentVehicleCorrectionInput,
): CorrectionTarget {
  const row = resolveChangeTarget(changes, input.target);
  if (row.dimension !== 'vehicle' || !row.vehicleId) {
    throw err.unprocessable(
      'Эта дверь правит решение о машине. Прошлое решение о машинисте правит окно смены машиниста — той же датой',
      { target: 'Изменение не о машине' },
    );
  }
  /*
   * Хвост истории коррекцией не двигается (Р7, Р17). Последнее активное vehicle-изменение и есть
   * то, чем заявка закрыта сейчас: переписав его, дверь обязана была бы перевести и назначение — со
   * ставками, правилами аренды и рейсом, — а это полный путь окна смены техники. Половинчатая
   * запись «только история» разошлась бы со ставками, и поймали бы это счётом, а не порталом.
   */
  const tail = changes
    .filter((r) => r.dimension === 'vehicle' && r.supersededAt === null)
    .reduce<AssignmentChangeRecord | null>(
      (last, r) => (last === null || r.effectiveDate >= last.effectiveDate ? r : last),
      null,
    );
  if (tail && tail.id === row.id) {
    throw err.unprocessable(
      'Это последнее решение о машине — им заявка закрыта сейчас, и меняется оно окном смены техники: там правятся ставки, аренда и рейс',
      { target: 'Последнее решение о машине' },
    );
  }
  return {
    changeId: row.id,
    effectiveDate: row.effectiveDate,
    vehicleId: row.vehicleId,
    changeGroupId: row.changeGroupId,
    origin: row.origin,
  };
}

/**
 * Что можно поставить вместо прежней машины (Р12, Р7).
 *
 * Три отказа, и каждый закрывает свой способ получить молчаливо неверную историю:
 *
 * - **та же машина** — пустое изменение: команда ничего не утверждает, а номер операции сожгла бы;
 * - **машина, уже действовавшая до этой даты**, — тоже пустое: свёртка после такой «правки» не
 *   изменилась бы ни на день, а в истории осталась бы строка, объявляющая смену, которой не было.
 *   Проверяется свёрткой, а не соседней строкой: слева от цели может стоять любое число погашенных;
 * - **другая принадлежность** — правка не только машины: у собственной единицы есть бумага и
 *   обязательный машинист, у арендной нет ни того, ни другого (Р4, Р16).
 */
function assertNewVehicle(
  changes: readonly AssignmentChangeRecord[],
  target: CorrectionTarget,
  vehicleAfter: string,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
): void {
  if (vehicleAfter === target.vehicleId) {
    throw err.unprocessable(
      'Это та же машина, что стоит на отрезке сейчас: коррекция утверждает о прошлом что-то новое, а здесь утверждать нечего',
      { vehicleId: 'Машина не изменилась' },
    );
  }
  const before = previousVehicle(changes, target);
  if (before === vehicleAfter) {
    throw err.unprocessable(
      'До этой даты на заявке стояла та же машина — такая правка не меняет состав ни на один день. Отменить решение о смене машины коррекцией нельзя: ставки истории не хранятся, и машину возвращают новым решением',
      { vehicleId: 'Изменение стало бы пустым' },
    );
  }
  const ownershipBefore = ownershipByVehicle.get(target.vehicleId);
  const ownershipAfter = ownershipByVehicle.get(vehicleAfter);
  if (!ownershipAfter) {
    throw err.unprocessable('Машина не найдена в парке', { vehicleId: 'Машина не найдена' });
  }
  if (ownershipBefore && ownershipAfter !== ownershipBefore) {
    throw err.unprocessable(
      ownershipAfter === 'rental'
        ? 'Собственная единица меняется на арендную вместе со ставками, договором и снятием машиниста — это окно смены техники, а не коррекция отрезка'
        : 'Арендная единица меняется на собственную вместе со ставками и назначением машиниста — это окно смены техники, а не коррекция отрезка',
      { vehicleId: 'Другая принадлежность' },
    );
  }
}

/**
 * Машина, действовавшая **до** даты цели: последнее активное vehicle-изменение левее её.
 *
 * `null` — цель и есть первое решение о машине: слева от неё истории нет, и пустым такое изменение
 * не бывает.
 */
function previousVehicle(
  changes: readonly AssignmentChangeRecord[],
  target: CorrectionTarget,
): string | null {
  const left = changes
    .filter(
      (row) =>
        row.dimension === 'vehicle' &&
        row.supersededAt === null &&
        row.id !== target.changeId &&
        row.effectiveDate < target.effectiveDate,
    )
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1));
  return left.length > 0 ? (left[left.length - 1]!.vehicleId ?? null) : null;
}

// ── Подписи объекта (Р11) ──

/**
 * Подписи, попавшие в `approvalClearRange`, — и **только** в него.
 *
 * Сегодняшний код снимает все подписи заявки, обосновывая это тем, что «назначение у заявки одно на
 * весь срок»; после разреза это неправда: у мартовской коррекции нет права трогать апрельскую
 * подпись, потому что в апреле работала другая машина, и её часы объект принял по делу.
 *
 * Прежние `approvedBy`/`approvedAt` читаются вместе со строками: в таблице после снятия их не
 * останется, а в снимке операции они и есть ответ на «кто принял эти часы» через два месяца.
 */
async function approvalsInRange(
  tx: AssignmentCommandTx,
  requestId: string,
  displayNumber: string,
  ranges: DateRangeSet,
): Promise<ShiftApproval[]> {
  if (ranges.length === 0) return [];
  const rows = await tx
    .select({
      shiftDate: vehicleRequestShifts.shiftDate,
      approvedBy: vehicleRequestShifts.approvedBy,
      approvedByName: users.fullName,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .innerJoin(users, eq(users.id, vehicleRequestShifts.approvedBy))
    .where(
      and(
        eq(vehicleRequestShifts.requestId, requestId),
        isNotNull(vehicleRequestShifts.approvedAt),
      ),
    )
    .orderBy(vehicleRequestShifts.shiftDate);
  // Отбор диапазоном идёт здесь, а не в SQL: диапазонов у команды бывает несколько (Р11), и
  // собранное из них `OR` читалось бы хуже, чем то же условие на посчитанных проекциях. Дней у
  // заявки столько, сколько в её сроке, — счёт идёт на сотни.
  return rows.flatMap((row) =>
    row.approvedBy && row.approvedAt && dateInRanges(ranges, row.shiftDate)
      ? [
          {
            requestId,
            displayNumber,
            date: row.shiftDate,
            approvedBy: row.approvedBy,
            approvedByName: row.approvedByName,
            approvedAt: row.approvedAt.toISOString(),
          },
        ]
      : [],
  );
}

/**
 * Шаг 12: снять подписи — ровно те, что назвал расчёт.
 *
 * Список берётся из плана, а не перечитывается: между расчётом и этим местом стоят блокировки и
 * рукопожатие, и второе чтение сняло бы подпись, появившуюся уже после того, как человек
 * подтвердил последствия. Часы при этом остаются: их вносил объект, и коррекция машины их не
 * опровергает.
 */
export async function clearCorrectionApprovals(
  ctx: AssignmentApplyContext<VehicleCorrectionPlan>,
): Promise<CorrectionPaper> {
  await clearShiftApprovals(ctx.tx, ctx.plan.approvals);
  return { clearedApprovals: ctx.plan.approvals.map((approval) => approval.date) };
}

// ── Рукопожатия (шаг 8) ──

/**
 * Что тело обязано подтвердить против **рассчитанного** плана (§8, Д4).
 *
 * Проверок две. Первая — паритет старой бумаги: команда, задевающая действующий бланк, отвергается
 * здесь. Вторая — отпечаток разблокировок: присутствие поля определяется исходом, а не желанием
 * клиента, и лишний отпечаток это не «лишнее поле», а заявка на право сжечь чужие номера. В этой
 * волне он лишний всегда — команда, которой разблокировки понадобились бы, отвергается первой
 * проверкой.
 */
export function assertCorrectionHandshake(
  plan: VehicleCorrectionPlan,
  input: AssignmentVehicleCorrectionInput,
): void {
  /*
   * Паритет старой бумаги (Б1, В3): команда, задевающая действующий бланк, отвергается **до**
   * записи истории — иначе история разошлась бы с бумагой молча. Отказ называет листы поимённо и
   * говорит, чего у портала пока нет; снимется он вместе с исполнителем отрезкового плана (этап 5).
   *
   * Совета «аннулируйте номера и выпишите листы по требованию» здесь больше нет (Ю51): ручная
   * выписка ЭСМ-2 заведена **только** для линейной техники (`onDemandRefusal`), а линейный заказ
   * эта дверь отвергает выше. Совет был адресован ровно тем заказам, где он не работает.
   */
  if (plan.blockingSheets.length > 0) {
    throw err.unprocessable(
      `Коррекция задевает действующие листы ЭСМ-2 (№ ${plan.blockingSheets
        .map((sheet) => sheet.displayNumber)
        .join(
          ', № ',
        )}): переоформить их по отрезкам портал пока не умеет — недельная сверка знает одну машину на заявку и переписала бы эти недели машиной назначения, то есть ровно вопреки правке. Переоформление по отрезкам включится вместе с переключением чтения истории; до него правьте историю на днях, которых действующие листы не касаются`,
      { target: 'Задеты выписанные листы' },
      { blockingSheets: plan.blockingSheets },
    );
  }
  if (plan.unlockFingerprint === null) {
    if (input.unlockFingerprint !== undefined) {
      throw err.unprocessable(
        'Эта коррекция не переоформляет ни одного отработанного листа — подтверждать нечего. Посмотрите последствия заново и повторите команду без подтверждения',
        { unlockFingerprint: 'Лишнее подтверждение' },
      );
    }
    return;
  }
  if (input.unlockFingerprint !== plan.unlockFingerprint) {
    throw err.unprocessable(
      'Список отработанных листов, которые переоформит операция, изменился — посмотрите последствия заново',
      { unlockFingerprint: 'Подтверждение не совпало' },
      { requiredUnlocks: plan.blockingSheets },
    );
  }
}

// ── Отпечаток предпросмотра (Р20, Р32) ──

/**
 * Отпечаток последствий: **содержание**, а не идентификаторы (Р20).
 *
 * Цель входит сюда датой и шкалой, а не `changeId`: адресов у неё два (Р10), и один и тот же
 * предпросмотр, показанный порталу с идентификатором и повторённый логическим ключом, обязан дать
 * тот же отпечаток — иначе окно, прочитавшее историю до нажатия, получало бы 409 на ровном месте.
 *
 * Подписи входят днями: человек подтверждает не число снятых подписей, а конкретные сутки. Чужая
 * подпись, появившаяся между предпросмотром и командой, обязана дать 409, а не сняться молча.
 */
function previewFingerprintOf(
  requestId: string,
  asOf: string,
  input: AssignmentVehicleCorrectionInput,
  effects: AssignmentEffects,
  plan: VehicleCorrectionPlan,
): string {
  return fingerprintOf({
    door: DOOR,
    requestId,
    asOf,
    command: {
      dimension: 'vehicle',
      effectiveDate: plan.target.effectiveDate,
      vehicleBefore: plan.vehicleBefore,
      vehicleAfter: input.vehicleId,
    },
    outcome: effects.operationOutcome,
    effects: {
      ...effects.payload,
      mutations: effects.payload.mutations.map(({ changeId: _id, ...rest }) => rest),
    },
    clearedApprovals: plan.approvals.map((approval) => approval.date),
    blockingSheets: plan.blockingSheets.map((sheet) => sheet.waybillId).sort(),
  });
}

// ── Спецификация команды для каркаса (§8) ──

/** Кто исполняет команду: идентификатор для журнала и права — для условной авторизации (Р32). */
export type CorrectionActor = AccessSubject & { id: string };

/**
 * Спецификация периодной коррекции для `runAssignmentCommand` — **один** источник на боевую ручку и
 * на тесты двери.
 *
 * Собрана здесь, а не в роут-модуле, по той же причине, по какой предпросмотр зовёт тот же колбэк
 * `plan`: место, где предметные места канона заполняются, должно быть одно.
 */
export function vehicleCorrectionSpec(params: {
  requestId: string;
  actor: CorrectionActor;
  input: AssignmentVehicleCorrectionInput;
  asOf: string;
}): AssignmentCommandSpec<VehicleCorrectionPlan, AssignmentWriteResult, CorrectionPaper> {
  const { requestId, actor, input, asOf } = params;
  return {
    // Класс двери — `history` (§10): она пишет историю и снимает подписи, и откат режима обязан
    // закрывать её первой.
    door: 'history',
    journalDoor: DOOR,
    requestId,
    actor: { id: actor.id },
    expectedVersion: input.version,
    body: input,
    operation: input.operation ?? null,
    previewFingerprint: input.previewFingerprint,
    asOf,
    plan: (ctx) => planVehicleCorrection(ctx, input),
    handshake: (ctx) => assertCorrectionHandshake(ctx.plan, input),
    /*
     * Права спрашиваются по посчитанному исходу (Р32), а не по календарю и не по составу тела:
     * коррекция отрезка, целиком лежащего в будущем, — это правка принятого решения
     * (`assignment_tail`), и коррекционного права ей не нужно, а та же команда мартовской датой
     * переоформляет отработанные дни и спрашивает `waybills.correct`.
     */
    authorize: (ctx) => authorizeCrewCommand(actor, ctx.effects, ctx.asOf),
    authorizeRepeat: (scope) => authorizeCrewRepeat(actor, scope),
    mutate: async (ctx) => {
      /*
       * Шаг 11 открывается материализацией истории (Р20, Р26): расчёт шага 5 показал, во что она
       * превратится, — здесь эти строки ложатся в базу, и обязательно **до** замены, потому что
       * заменяется как раз одна из них. Той же операцией пишется готовность и снимается метка
       * загрязнения (К4).
       */
      await ensureCommandHistory(ctx.tx, { requestId, asOf: ctx.asOf });
      const write = await applyAssignmentMutations(ctx.tx, {
        requestId,
        actorUserId: actor.id,
        // Строка истории ссылается на операцию журнала: «почему в марте вдруг другая машина»
        // отвечается ею, а не догадкой по `origin`.
        correctionId: ctx.operation?.id ?? null,
        mutations: ctx.plan.mutations,
        denormalization: ctx.plan.denormalization,
      });
      return { write, applied: write };
    },
    syncPaper: (ctx) => clearCorrectionApprovals(ctx),
    payload: (ctx) => ({
      door: DOOR,
      target: {
        /*
         * Идентификатор берётся у **погашенной** строки, а не из плана: у истории, которую
         * материализовал этот же шаг 11, расчётная цель адресовалась логическим ключом, и её
         * `planned:`-ключ в снимке операции был бы ссылкой в никуда. Погашенная строка здесь ровно
         * одна — та самая цель.
         */
        changeId:
          ctx.write.superseded.find((row) => row.kind === 'replaced')?.row.id ??
          ctx.plan.target.changeId,
        dimension: 'vehicle',
        effectiveDate: ctx.plan.target.effectiveDate,
      },
      vehicle: { before: ctx.plan.vehicleBefore, after: ctx.plan.vehicleAfter },
      /*
       * Снятые подписи — целиком, с прежними `approvedBy`/`approvedAt`: в `vehicle_request_shifts`
       * их после снятия уже нет, а «кто принял 11,5 машиночаса за 12 марта» спрашивают через два
       * месяца — и ответить на это будет больше нечем.
       */
      clearedShiftApprovals: ctx.plan.approvals,
      history: historySnapshotOf(ctx.write),
    }),
    audit: (ctx) => auditOf(ctx.plan, ctx.effects, ctx.operation?.operationId ?? null, ctx.paper),
  };
}

/** Снимок «было → стало» по истории (Р9): что легло и что погасло, значениями, а не ссылками. */
function historySnapshotOf(write: AssignmentWriteResult): Record<string, unknown> {
  const value = (row: AssignmentChangeRecord) => ({
    effectiveDate: row.effectiveDate,
    dimension: row.dimension,
    vehicleId: row.vehicleId,
    driverPersonId: row.driverPersonId,
    driverState: row.driverState,
    origin: row.origin,
    changeGroupId: row.changeGroupId,
  });
  return {
    inserted: write.inserted.map(value),
    superseded: write.superseded.map((s) => ({ kind: s.kind, row: value(s.row) })),
  };
}

/**
 * Событие ленты — **данными**: пишет их каркас и в транзакции (§8, шаг 13).
 *
 * Действие своё, а не общее с назначением (`vehicle_request.assign`): то отвечает на «чем и почём
 * выполняют заявку **сейчас**», а это — на «что мы задним числом сказали о прошлом». Слитые в одно
 * действие, они дали бы ленту, в которой смена техники и правка истории читаются одинаково.
 * Журнал коррекций при этом остаётся местом, где лежит «почему»: лента отвечает «что и когда».
 */
function auditOf(
  plan: VehicleCorrectionPlan,
  effects: AssignmentEffects,
  operationId: string | null,
  paper: CorrectionPaper,
): AuditEntry {
  return {
    action: 'vehicle_request.assignment_correction',
    metadata: {
      target: { changeId: plan.target.changeId, effectiveDate: plan.target.effectiveDate },
      vehicleId: plan.vehicleAfter,
      previousVehicleId: plan.vehicleBefore,
      outcome: effects.operationOutcome,
      effectiveDate: effects.correctionEffectiveDate,
      approvalClearRange: effects.approvalClearRange,
      clearedShiftApprovals: paper.clearedApprovals,
      operationId,
    },
  };
}

// ── Предпросмотр (§7) ──

/**
 * Ответ предпросмотра: общий `AssignmentPreviewDto` плюс то, что есть только у этой двери.
 *
 * Бумажный план приходит пустым не «пока не сделали», а потому, что команда, которой он был бы
 * непустым, отвергается расчётом (см. шапку модуля): показывать человеку план, который дверь не
 * исполнит, значило бы обещать не то.
 */
export function correctionPreviewDto(
  effects: AssignmentEffects,
  plan: VehicleCorrectionPlan,
  fingerprint: string,
  asOf: string,
): AssignmentCorrectionPreviewDto {
  return {
    plan: { cancel: [], issue: [] },
    requiredAnchors: [],
    requiredVehicleResolution: null,
    blockedShiftDays: [],
    clearedShiftDays: [],
    clearedShiftsFingerprint: null,
    // Разблокировок у этой волны не бывает: команда, которой они понадобились бы, отвергается
    // рукопожатием. Пустой список здесь — правда о сегодняшнем исполнителе, а не заглушка.
    requiredUnlocks: [],
    unlockFingerprint: plan.unlockFingerprint,
    issues: [],
    operationRequirement: operationRequirementOf(effects),
    asOf,
    fingerprint,
    blockingSheets: plan.blockingSheets.map((sheet) => ({ ...sheet })),
    approvalClearRange: effects.approvalClearRange.map((range) => ({ ...range })),
    clearedApprovals: plan.approvals.map((approval): AssignmentClearedApprovalDto => ({
      date: approval.date,
      approvedByName: approval.approvedByName,
      approvedAt: approval.approvedAt,
    })),
  };
}

/** Спрашивать ли причину и ключ операции — решает исход (Р32), а не календарь. */
function operationRequirementOf(effects: AssignmentEffects): OperationRequirement | null {
  if (!effects.needsOperation) return null;
  return {
    kind: effects.operationOutcome === 'crew' ? 'crew' : 'assignment_tail',
    reasonRequired: true,
    operationIdRequired: true,
  };
}

// ── Чтение справочников ──

/**
 * Принадлежность машин разреза (Р4) вместе с той, которую предлагает команда.
 *
 * Карта обязана быть полной: машину, которой в ней нет, план бумаги не угадывает — молча приписать
 * её порталу значит выписать бланк на чужую единицу. Отсутствие новой машины в карте и есть ответ
 * «такой машины в парке нет».
 */
async function readOwnership(
  tx: AssignmentCommandTx,
  requestId: string,
  changes: readonly AssignmentChangeRecord[],
  vehicleAfter: string,
): Promise<Map<string, VehicleOwnership>> {
  const ids = new Set(
    changes.flatMap((row) => (row.dimension === 'vehicle' && row.vehicleId ? [row.vehicleId] : [])),
  );
  ids.add(vehicleAfter);
  const [assignment] = await tx
    .select({ vehicleId: vehicleRequestAssignments.vehicleId })
    .from(vehicleRequestAssignments)
    .where(eq(vehicleRequestAssignments.requestId, requestId));
  if (assignment) ids.add(assignment.vehicleId);
  const rows = await tx
    .select({ id: vehicles.id, ownership: vehicles.ownership, deletedAt: vehicles.deletedAt })
    .from(vehicles)
    .where(inArray(vehicles.id, [...ids]));
  // Удалённая единица в карту не попадает: назначить работу машине, которой в парке больше нет,
  // коррекция не вправе, а прежние машины отрезков читаются как есть — они уже отработали.
  return new Map(
    rows.flatMap((row) =>
      row.deletedAt && row.id === vehicleAfter ? [] : [[row.id, row.ownership] as const],
    ),
  );
}

/** Напечатанные номера действующих листов: ими окно называет человеку бумагу, о которой говорит. */
async function readSheetNumbers(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      id: waybills.id,
      number: waybills.number,
      prefix: waybillSeries.prefix,
      numberWidth: waybillSeries.numberWidth,
    })
    .from(waybills)
    .innerJoin(waybillSeries, eq(waybillSeries.id, waybills.seriesId))
    .where(and(eq(waybills.sourceRequestId, requestId), ne(waybills.status, 'cancelled')));
  return new Map(
    rows.map((row) => [row.id, waybillDisplayNumber(row.prefix, row.number, row.numberWidth)]),
  );
}

// ── Мелочи ──

/** День расчёта — сегодня по МСК; тем же поясом границы считает портал (Р32). */
export function correctionAsOf(): string {
  return moscowDateKeyOf(new Date());
}

/** Пересекается ли документ с областью: границы включительные с обеих сторон. */
function rangesOverlap(ranges: DateRangeSet, from: string, to: string): boolean {
  return ranges.some((range) => range.from <= to && from <= range.to);
}

/** Лежит ли день внутри области. */
function dateInRanges(ranges: DateRangeSet, date: string): boolean {
  return ranges.some((range) => range.from <= date && date <= range.to);
}
