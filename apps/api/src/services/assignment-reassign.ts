import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  canCancelWaybill,
  esm2SyncPlan,
  periodsOverlap,
  waybillDisplayNumber,
  type AssignmentPlanCancelDto,
  type AssignmentPlanIssueDto,
  type AssignmentPreviewDto,
  type AssignmentShiftDay,
  type AssignmentUnlockDto,
  type Esm2Mode,
  type Esm2Sheet,
  type OperationRequirement,
  type RequiredAnchor,
} from '@technic/contracts';
import { requestIsLinearSql } from '../db/linear-mode';
import {
  persons,
  specialEquipmentRequestDetails,
  vehicleModels,
  vehicleRequestShifts,
  vehicleRequests,
  vehicleTypes,
  vehicles,
  waybills,
  waybillSeries,
} from '../db/schema';
import { err } from '../lib/errors';
import { evaluateAssignmentBackstop } from './assignment-backstop';
import type {
  AssignmentCommandTx,
  AssignmentPlanContext,
  AssignmentPlanned,
  LockedVehicleRequest,
} from './assignment-command';
// Отпечаток считается тем же каноникализатором, что у остальных дверей модуля: своя копия
// «как хешируется содержание» разошлась бы с ними на первой же правке, а разъезжаются такие пары
// молча — окно показало бы одно, а боевая ручка сверила бы другое.
import { fingerprintOf } from './assignment-crew';
import { assignmentCommandEffects, type AssignmentEffects } from './assignment-effects';
import { historyIsAuthoritative, type AssignmentModeSnapshot } from './assignment-mode';
import { rangeSetIntersects, type DateRangeSet } from './esm2-plan';
import { buildEsm2SyncPlan, type Esm2SyncPlanInput } from './waybill-esm2';

/**
 * Предпросмотр и отпечаток **старой двери смены техники** — `PATCH /vehicle-requests/:id/assignment`
 * и её новая пара `POST /vehicle-requests/:id/assignment/preview`
 * (`docs/assignment-periods-plan.md`, §8 «новая ручка у старой двери», Р11, Р18, Р32; этап 3).
 *
 * ЗАЧЕМ ЭТОТ МОДУЛЬ. Волны 3.2 и 3.3 сделали три новые двери истории, а главный рабочий инструмент
 * диспетчера — окно «Сменить технику» — остался без предпросмотра вовсе. Из-за этого:
 *
 * - **блокировку по дням показывать нечем.** Р18 обещает, что портал возьмёт её из предпросмотра, а
 *   не из агрегата `VehicleRequestShiftsSummaryDto`, — но предпросмотра у двери не было;
 * - **последствия не подтверждаются.** Между просмотром и нажатием план меняется, не тронув заявку:
 *   лист аннулировали своей ручкой, объект подписал день, наступила полночь. `version` заявки ни
 *   одного из этих случаев не ловит (Р32), и защищает от них только отпечаток.
 *
 * ЧТО ЗДЕСЬ СЧИТАЕТСЯ, А ЧТО НЕТ. Здесь — **последствия и отпечаток**, то есть шаги 4–6 канона в их
 * расчётной половине. Записи нет ни одной: предпросмотр не коммитит (Р20), а боевая ручка
 * пользуется тем же расчётом только ради сверки отпечатка (шаг 7) и дальше идёт своим путём —
 * `resolveAssignment`, `saveAssignment`, `syncEsm2Waybills` — который волна 3 не переписывает.
 *
 * ПОЧЕМУ ИСТОРИЯ ЗДЕСЬ ПУСТАЯ (`changes: []`). Это не заглушка, а описание того, что дверь делает
 * **сегодня**. Разреза (Р6) у неё пока нет: `saveAssignment` переписывает назначение целиком, и
 * логический эффект команды — «эта машина с такой-то даты и до конца срока». Ровно это и даёт
 * `assignmentCommandEffects` на пустой истории, и ровно по этому диапазону работают проекции Р11.
 * Подставь мы сюда восстановленную историю, предпросмотр обещал бы отрезковые последствия, которых
 * дверь не производит, — а заодно и отказывал бы там, где историю восстановить нечем, то есть менял
 * бы поведение двери. Историю сюда принесёт этап 5 вместе с самим разрезом.
 *
 * ДВЕ ФОРМЫ ОДНОЙ КОМАНДЫ. Обычная смена техники и коррекция назначения задним числом (ADR 0101,
 * Р8) идут этой же дверью и отличаются блоком `correction`. Отличие для расчёта одно — **дата**:
 * у обычной это день расчёта (или начало срока, если он ещё не наступил), у коррекции — самая
 * ранняя из задетых ею (`planAssignmentCorrection`). Из даты дальше выводится всё: исторический ли
 * диапазон, нужна ли операция журнала (Р32), какие листы придётся разблокировать (Р11).
 */

/** Имя двери в отпечатке: у ремонта и у смены техники тела бывают похожи, а последствия разные. */
const DOOR = 'request-assignment';

/**
 * Происхождение будущей строки истории — то же, каким её пишет периодная коррекция: по составу
 * обе команды и есть «смена машины», а отличает их не `origin`, а `correction_id`.
 *
 * Строк эта дверь пока не пишет (dual-write придёт этапом 5), но происхождение входит в проекции
 * Р11 через `isOrdinaryVehicleChange`, и назвать его надо уже сейчас.
 */
const REASSIGN_ORIGIN = 'reassignment' as const;

/** Код 409 для устаревшего предпросмотра — тот же, что у команд истории. */
export const REASSIGN_PREVIEW_STALE = 'assignment_preview_stale';

/**
 * Код 409 для клиента, который отпечатка не шлёт вовсе, — после переключения чтения (И5, Ж5).
 *
 * Отдельный код, а не общий `version_conflict`: у портала на него свой разговор — «обновите
 * страницу», а не «данные изменились».
 */
export const REASSIGN_CLIENT_UPGRADE = 'client_upgrade_required';

// ── Вход ──

/** Коррекционная половина команды — то, что о ней уже посчитал вызывающий (ADR 0101, Р36). */
export interface ReassignCorrection {
  /**
   * Листы отработанных недель, названные телом. Порядок не значим — в отпечаток они уходят
   * отсортированными: перестановка тех же номеров не меняет ни одного последствия.
   */
  unlockWaybillIds: readonly string[];
  /**
   * Эффективная дата операции: самая ранняя из задетых — конец разблокированной недели, конец
   * прошедшей недели без листа либо день снимаемой подписи (§4 ADR 0101).
   *
   * Передаётся сюда готовой, а не считается заново: её уже посчитал `planAssignmentCorrection`, и
   * второй расчёт той же даты разошёлся бы с первым ровно тогда, когда правила правят.
   */
  effectiveDate: string;
}

/** Семантическая команда двери: что ставим и с какой даты. Ставки и рейс последствий не меняют. */
export interface ReassignCommand {
  vehicleId: string;
  /** Машинист, названный этим же запросом; не назван — сверка возьмёт его с прежнего листа. */
  driverPersonId?: string | undefined;
  /** Блок коррекции; его отсутствие и есть «обычная смена техники». */
  correction?: ReassignCorrection | undefined;
}

// ── Что посчитано ──

/** Предметный план двери: всё, что посчитано до первой записи и дальше только читается. */
export interface ReassignPlan {
  /** Режим ведения листов (`esm2Mode`): `none` — бумаги у заявки нет вовсе. */
  esm2Mode: Esm2Mode;
  /** Логическая дата команды — по ней считаются диапазоны Р11 и исход Р32. */
  effectiveDate: string;
  /** Область бумаги (Р11, §7): документное замыкание дневного диапазона. */
  paperScope: DateRangeSet;
  /** Что сгорит и что выпишется — так, как это увидит человек. */
  preview: { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] };
  /** Листы под разблокировку, названные **сервером** (Р11); тело подтверждает отпечаток, а не список. */
  requiredUnlocks: AssignmentUnlockDto[];
  /** Отпечаток серверного множества разблокировок; `null` — исход не `crew`, разблокировок не спрашивают. */
  unlockFingerprint: string | null;
  /** Пробелы машиниста, которыми дверь отказала бы в режиме `history` (Р16, Р22, фаза — Ж5). */
  requiredAnchors: RequiredAnchor[];
  /** Дни, из-за которых команда невозможна (Р18). */
  blockedShiftDays: AssignmentShiftDay[];
  /** Дни, у которых команда снимает подтверждение объекта (Р18, Ц2). */
  clearedShiftDays: AssignmentShiftDay[];
  /** Отпечаток `clearedShiftDays`; `null` — снимать нечего, и подтверждать нечего. */
  clearedShiftsFingerprint: string | null;
  /**
   * Состояние смен внутри `workBlockRange` — в отпечаток, а не в ответ (Р18, последний пункт).
   *
   * «Диапазон, посчитанный при предпросмотре, обязан устареть, если в нём появились часы»: объект
   * вносит их своей дверью и версии заявки не двигает, а команда переписывает как раз эти дни.
   * Человеку показывать это отдельным списком нечего — он и так видит оба множества, — а вот
   * подтверждение, выданное на другое состояние, обязано перестать годиться.
   */
  workBlockShiftDays: { date: string; hours: number; approved: boolean }[];
}

// ── Расчёт (шаги 4–6 канона в расчётной половине) ──

/**
 * Посчитать смену техники целиком: бумагу, разблокировки, смены, пробелы и отпечаток.
 *
 * Транзакция приходит читающей: у предпросмотра — из каркаса (`readOnlyTx`), у боевой ручки — уже
 * под взятыми блокировками, но **до** первой записи. Один и тот же колбэк на оба пути намеренно
 * (§8): вторая копия расчёта разошлась бы с первой, и окно начало бы обещать не то, что произойдёт.
 */
export async function planReassignCommand(
  ctx: AssignmentPlanContext,
  input: ReassignCommand,
): Promise<AssignmentPlanned<ReassignPlan>> {
  const { tx, request, asOf } = ctx;
  const term = request.term;
  if (request.deletedAt) throw err.notFound('Заявка не найдена');

  /*
   * Принадлежность **будущей** машины: ею считается режим бумаги. Заказ, который вели арендной
   * единицей, а продолжат своей, бумагу заводит там, где её не было вовсе, — и наоборот. Считай мы
   * режим по нынешнему назначению, предпросмотр показал бы пустой план ровно там, где сверка
   * выпишет полный комплект листов.
   */
  const [next] = await tx
    .select({ ownership: vehicles.ownership })
    .from(vehicles)
    .where(eq(vehicles.id, input.vehicleId));
  if (!next) throw err.unprocessable('Машина не найдена', { vehicleId: 'Машина не найдена' });

  // Вход сверки берётся у той же работы, которая его потом и исполнит (`syncEsm2Waybills`): своей
  // копии «что такое действующий лист заявки» здесь нет — разойдись эти два места, окно обещало бы
  // одно, а сверка делала бы другое.
  const base = await buildEsm2SyncPlan(tx, {
    requestId: request.id,
    driverPersonId: input.driverPersonId ?? null,
    ownership: next.ownership,
    asOf,
  });
  if (!base) throw err.notFound('Заявка не найдена');
  const sheets = base.input.existing;

  /*
   * Логическая дата команды (Р11, Р32).
   *
   * У обычной смены это день расчёта: машину меняют «с сегодня», прошлого она не касается и
   * коррекционных прав не требует. Срок, который ещё не начался, подтягивает дату к своему началу —
   * иначе диапазон эффекта оказался бы пустым у команды, которая переписывает весь срок.
   *
   * У коррекции дату называет её собственный план: она и есть глубина, которую спрашивает
   * `backdateGuard`, и она же делает диапазон историческим, то есть исход — `crew`.
   */
  const effectiveDate = input.correction
    ? input.correction.effectiveDate
    : asOf < term.dateFrom
      ? term.dateFrom
      : asOf;

  const effects = assignmentCommandEffects({
    // Истории здесь нет намеренно — см. шапку модуля: разреза у двери пока не существует, и её
    // логический эффект тянется от даты команды до конца срока.
    changes: [],
    term,
    asOf,
    mutations: [{ kind: 'insert', dimension: 'vehicle', effectiveDate, origin: REASSIGN_ORIGIN }],
    sheets,
    wanted: base.input.wanted,
  });

  const numbers = await readSheetNumbers(tx, request.id);
  /*
   * Разблокировки считает **сервер**, а тело их только подтверждает (Р11, Б3). Множество — это
   * действующие листы, которые пересекают область бумаги и которых обычная сверка не тронет:
   * их неделя отработана, и без разблокировки коррекция аннулировала бы номер без замены.
   *
   * Спрашивается оно только при исходе `crew`: у команды, которая прошлого не трогает, жечь нечего,
   * а непустой список при исходе `none` был бы заявкой на право сжечь чужие номера (Д4).
   */
  const requiredUnlockIds = effects.needsCorrection
    ? sheets
        .filter(
          (sheet) =>
            rangeSetIntersects(effects.paperScope, {
              from: sheet.periodFrom,
              to: sheet.periodTo,
            }) &&
            !canCancelWaybill({ issuedForDate: sheet.periodFrom, periodTo: sheet.periodTo }, asOf),
        )
        .map((sheet) => sheet.id)
        .sort()
    : [];

  /*
   * План, который дверь исполнит. Машина подменяется в уже собранном входе, а не читается из базы:
   * `syncEsm2Waybills` зовётся **после** `saveAssignment`, то есть видит уже новую единицу, и
   * предпросмотр обязан считать по тому же состоянию, иначе он показывал бы план прежней машины.
   */
  const planInput: Esm2SyncPlanInput = {
    ...base.input,
    vehicleId: input.vehicleId,
    ...(input.correction
      ? {
          unlockWaybillIds: input.correction.unlockWaybillIds,
          correction: { allowed: true as const },
        }
      : {}),
  };
  const sheetPlan = esm2SyncPlan(planInput);

  const preview = await previewPlanOf(tx, {
    plan: sheetPlan,
    sheets,
    numbers,
    mode: base.input.mode,
    vehicleId: input.vehicleId,
    driverPersonId: base.input.driverPersonId,
  });

  const shifts = await readShiftDays(tx, request.id);
  const approved = shifts.filter((row) => row.approved);
  const linear = await readIsLinear(tx, request.id);
  /*
   * Два множества смен (Р18, Ц2) — «из-за чего команда невозможна» и «что она обесценит». Это
   * разные вопросы, и одно множество отвечало бы на них одинаково неверно.
   *
   * Считаны они по **сегодняшнему** правилу двери, а не по будущему:
   *
   * - обычную смену техники запирает **любой** подписанный день заявки (`canReassignVehicle`), а не
   *   подписанный день диапазона. Диапазонный запрет — это Р18, и он меняется одновременно с
   *   разрезом Р6 и только вместе с ним (§15: ослабление существующей защиты подтверждает
   *   заказчик). Покажи предпросмотр диапазон, он обещал бы работу там, где дверь откажет;
   * - коррекция те же дни не запирает, а **снимает с них подпись** (`clearShiftApprovals`): часы
   *   остаются, но принять их объекту придётся заново — по машине, которая работала на самом деле.
   *   Часы показываются рядом с днём, чтобы цена подтверждения была видна, а не подразумевалась;
   * - у линейного заказа не снимается ничего (ADR 0100 §4): машина дня там — машина рейса, а
   *   назначение остаётся умолчанием, и подпись под часами дня правка умолчания не опровергает.
   *
   * Удаления заполненных без подписи часов (`clearableFilledDays`) сегодня не происходит вовсе, и
   * обещать его нельзя: оно приходит тем же решением §15, что и диапазонный запрет.
   */
  const blockedShiftDays = input.correction ? [] : approved.map(toShiftDay);
  const clearedShiftDays = input.correction && !linear ? approved.map(toShiftDay) : [];

  /*
   * Пробелы машиниста (Р16) — тем же расчётом, каким их считает бэкстоп чужих дверей: он и есть
   * то, чем эта дверь откажет после переключения чтения (Р22, фаза — Ж5). Считается без единой
   * записи: диагностику пишет сам бэкстоп в боевой транзакции, а предпросмотр не коммитит (Р20).
   */
  const verdict = await evaluateAssignmentBackstop(tx, {
    door: 'request_assignment',
    requestId: request.id,
    asOf,
  });

  const plan: ReassignPlan = {
    esm2Mode: base.input.mode,
    effectiveDate,
    paperScope: effects.paperScope,
    preview,
    requiredUnlocks: requiredUnlockIds.map((id) => {
      const sheet = sheets.find((s) => s.id === id);
      return {
        waybillId: id,
        displayNumber: numbers.get(id) ?? id,
        from: sheet?.periodFrom ?? '',
        to: sheet?.periodTo ?? '',
      };
    }),
    unlockFingerprint: effects.needsCorrection ? fingerprintOf({ requiredUnlockIds }) : null,
    requiredAnchors: verdict?.requiredAnchors ?? [],
    blockedShiftDays,
    clearedShiftDays,
    clearedShiftsFingerprint:
      clearedShiftDays.length > 0 ? fingerprintOf({ clearedShiftDays }) : null,
    workBlockShiftDays: shifts.filter((row) =>
      rangeSetIntersects(effects.workBlockRange, { from: row.date, to: row.date }),
    ),
  };

  return {
    effects,
    fingerprint: previewFingerprintOf(request.id, asOf, input, effects, plan),
    plan,
  };
}

// ── Отпечаток (Р20, Р32) ──

/**
 * Отпечаток последствий: **содержание**, а не идентификаторы (Р20).
 *
 * Что входит и почему:
 *
 * - **семантическая команда** — машина, машинист, дата и названные листы. Ставок, аренды и рейса
 *   здесь нет: они не меняют ни одного последствия, а войди они в отпечаток, окно получало бы 409
 *   после правки цены — то есть человек пересматривал бы последствия, которые не изменились;
 * - **посчитанные последствия** — план `cancel`/`issue`, исход, `asOf`, серверное множество
 *   разблокировок, пробелы машиниста и оба множества смен. Именно они и есть то, что человек видел;
 * - **имена не входят**: переименованная модель машины не меняет ни бумаги, ни прав, и обесценивать
 *   из-за неё подтверждение значило бы отвлекать человека на правку справочника.
 *
 * Рукопожатий (`unlockFingerprint`, версии, самого `previewFingerprint`) здесь нет по определению:
 * они появляются в теле **после** предпросмотра, и хеш всего боевого тела не сошёлся бы никогда.
 */
function previewFingerprintOf(
  requestId: string,
  asOf: string,
  input: ReassignCommand,
  effects: AssignmentEffects,
  plan: ReassignPlan,
): string {
  return fingerprintOf({
    door: DOOR,
    requestId,
    asOf,
    command: {
      vehicleId: input.vehicleId,
      driverPersonId: input.driverPersonId ?? null,
      effectiveDate: plan.effectiveDate,
      unlockWaybillIds: [...(input.correction?.unlockWaybillIds ?? [])].sort(),
    },
    outcome: effects.operationOutcome,
    effects: effects.payload,
    plan: {
      cancel: plan.preview.cancel.map((sheet) => sheet.waybillId).sort(),
      issue: plan.preview.issue.map((sheet) => ({
        from: sheet.from,
        to: sheet.to,
        vehicleId: sheet.vehicleId,
        driverPersonId: sheet.driverPersonId,
      })),
    },
    requiredUnlockIds: plan.requiredUnlocks.map((sheet) => sheet.waybillId).sort(),
    requiredAnchors: plan.requiredAnchors,
    blockedShiftDays: plan.blockedShiftDays,
    clearedShiftDays: plan.clearedShiftDays,
    workBlockShiftDays: plan.workBlockShiftDays,
  });
}

/**
 * Шаг 7 канона у старой двери — и **фазированный**, в отличие от команд истории (Ж5, И5).
 *
 * Разница не в строгости, а в том, что дверь старая: портал сегодня отпечатка не шлёт вовсе, окно
 * приедет волной 4a, а старые вкладки и кэш живут дольше выката. Потребуй ручка отпечаток сразу —
 * смена техники перестала бы работать у всех в момент деплоя, то есть выкат стал бы простоем.
 * Поэтому фаза задаётся **режимом чтения** — значением в управляющей строке, а не свойством
 * сборки, — и обе сборки понимают обе фазы:
 *
 * ```
 * read_mode = legacy   → отпечаток спрашивается только у того, кто его прислал; не прислал —
 *                        команда идёт по-старому и ведёт себя ровно как до этой волны
 * read_mode = history  → отпечаток обязателен: без предпросмотра команду исполнить безопасно
 *                        нельзя, и старый клиент получает 409 CLIENT_UPGRADE_REQUIRED
 * ```
 *
 * Прислал и не сошлось — 409 в **обеих** фазах: клиент, показавший человеку последствия, обязан
 * получить «посмотрите заново», а не молча выполненную другую работу. Это и есть та половина
 * защиты, которая включается сразу и ничего не ломает: сегодня её не запрашивает никто.
 */
export function assertReassignPreviewFingerprint(params: {
  mode: AssignmentModeSnapshot;
  effects: AssignmentEffects;
  /** Отпечаток, посчитанный сервером под блокировками. */
  computed: string;
  /** Отпечаток из тела; `undefined` — тело его не принесло. */
  supplied: string | undefined;
}): void {
  if (params.supplied === undefined) {
    if (!historyIsAuthoritative(params.mode)) return;
    // Пустых команд последствий у этой двери не бывает — она всегда переписывает назначение, — но
    // условие выписано так же, как у каркаса (Р24): «отпечаток требуется при любой непустой
    // команде последствий», и следующая форма команды не должна догадываться о правиле заново.
    if (params.effects.mutations.length === 0) return;
    throw err.conflict(
      'Смена техники теперь идёт через просмотр последствий: обновите страницу и повторите — окно покажет, какие листы ЭСМ-2 будут переоформлены',
      { code: REASSIGN_CLIENT_UPGRADE },
    );
  }
  if (params.supplied !== params.computed) {
    throw err.conflict(
      'Последствия изменились с момента предпросмотра — посмотрите их заново и подтвердите',
      { code: REASSIGN_PREVIEW_STALE },
    );
  }
}

// ── Предпросмотр (§7) ──

/**
 * Ответ предпросмотра — общий DTO модуля.
 *
 * `requiredVehicleResolution` пуст всегда: расхождение хвоста запирает **расширение срока** (Р31), а
 * смена техники новых дней не открывает — она это расхождение сама и создаёт.
 *
 * `issues` пуст в этой волне: предупреждения по каждому выпускаемому листу собирает отрезковый
 * исполнитель этапа 5, а недельная сверка их не считает вовсе. Пустой список честнее выдуманного:
 * рукопожатий по предупреждениям дверь и не спрашивает.
 */
export function reassignPreviewDto(
  effects: AssignmentEffects,
  plan: ReassignPlan,
  fingerprint: string,
  asOf: string,
): AssignmentPreviewDto {
  return {
    plan: plan.preview,
    requiredAnchors: plan.requiredAnchors,
    requiredVehicleResolution: null,
    blockedShiftDays: plan.blockedShiftDays,
    clearedShiftDays: plan.clearedShiftDays,
    clearedShiftsFingerprint: plan.clearedShiftsFingerprint,
    requiredUnlocks: plan.requiredUnlocks,
    unlockFingerprint: plan.unlockFingerprint,
    issues: [],
    operationRequirement: operationRequirementOf(effects),
    asOf,
    fingerprint,
  };
}

/** Нужна ли операция журнала и что для неё спросить (Р32); `null` — исход `none`. */
function operationRequirementOf(effects: AssignmentEffects): OperationRequirement | null {
  if (!effects.needsOperation) return null;
  return {
    kind: effects.operationOutcome === 'crew' ? 'crew' : 'assignment_tail',
    reasonRequired: true,
    operationIdRequired: true,
  };
}

// ── Заявка под блокировкой ──

/**
 * Заявка и её срок — вход расчёта на боевом пути.
 *
 * Своё чтение, а не `lockedRequest` каркаса, и причина предметная: тот отвечает 422 всему, что не
 * заказ спецтехники, — а через эту дверь ходит и грузоперевозка, у которой ни срока работ, ни
 * бумаги нет вовсе. Каркасное чтение сломало бы ей смену машины, то есть изменило бы поведение
 * двери там, где волна ничего менять не должна. Поэтому отказ здесь **свой**, и вызывающий зовёт
 * это чтение только тогда, когда отпечаток действительно в игре.
 *
 * Блокировки берёт вызывающий: строка заявки к этому моменту уже под `FOR UPDATE` его же
 * транзакции, и второй захват здесь ничего бы не добавил.
 */
export async function lockedReassignRequest(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<LockedVehicleRequest> {
  const [row] = await tx
    .select({
      id: vehicleRequests.id,
      num: vehicleRequests.num,
      requestType: vehicleRequests.requestType,
      status: vehicleRequests.status,
      version: vehicleRequests.version,
      deletedAt: vehicleRequests.deletedAt,
      state: vehicleRequests.assignmentHistoryState,
      validatedOn: vehicleRequests.assignmentHistoryValidatedOn,
      dirty: vehicleRequests.assignmentHistoryDirty,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
    })
    .from(vehicleRequests)
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  if (row.requestType !== 'special_equipment' || row.dateFrom === null) {
    throw err.unprocessable(
      'Последствия смены техники считаются только у заказа спецтехники: у грузоперевозки нет ни срока работ, ни недельных листов',
      { requestId: 'Не заказ спецтехники' },
    );
  }
  return {
    id: row.id,
    num: row.num,
    status: row.status,
    version: row.version,
    deletedAt: row.deletedAt,
    term: { dateFrom: row.dateFrom, dateTo: row.dateTo },
    assignmentHistoryState: row.state,
    assignmentHistoryValidatedOn: row.validatedOn,
    assignmentHistoryDirty: row.dirty,
  };
}

// ── Чтения ──

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

/** Дни работы заявки с часами и состоянием подписи — вход обоих множеств Р18. */
async function readShiftDays(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<{ date: string; hours: number; approved: boolean }[]> {
  const rows = await tx
    .select({
      date: vehicleRequestShifts.shiftDate,
      hours: vehicleRequestShifts.machineHours,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .where(eq(vehicleRequestShifts.requestId, requestId))
    .orderBy(vehicleRequestShifts.shiftDate);
  return rows.map((row) => ({
    date: row.date,
    hours: Number(row.hours),
    approved: row.approvedAt !== null,
  }));
}

function toShiftDay(row: { date: string; hours: number }): AssignmentShiftDay {
  return { date: row.date, hours: row.hours };
}

/** Режим заказа: подписи снимает только неделя стояния на площадке, но не линейный заказ. */
async function readIsLinear(tx: AssignmentCommandTx, requestId: string): Promise<boolean> {
  const [row] = await tx
    .select({
      isLinear: requestIsLinearSql(vehicleRequests.isLinearFrozen, vehicleTypes.isLinear),
    })
    .from(vehicleRequests)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicleRequests.vehicleTypeId))
    .where(eq(vehicleRequests.id, requestId));
  return row?.isLinear ?? false;
}

/**
 * План глазами окна: что сгорит и что выпишется, с составом каждого выпускаемого листа.
 *
 * Состав считается **тем же правилом, что и у сверки** (`syncEsm2Waybills`): человек — названный
 * запросом, иначе тот, кто стоял в сгоревшем листе этих дней; машина — новая, а в линейном
 * режиме та, что стояла в сгоревшем листе (номер второй единицы недели переписывать на первую
 * нельзя). Второй свод тех же правил разошёлся бы с первым, и окно обещало бы не тот бланк.
 *
 * `issueKey` — индекс в плане, отсортированном по `(from, to, vehicleId, driverPersonId)`:
 * сгенерированных идентификаторов у не выписанного листа нет, а ключ нужен уже сейчас.
 */
async function previewPlanOf(
  tx: AssignmentCommandTx,
  params: {
    plan: { cancel: string[]; issue: readonly { from: string; to: string }[] };
    sheets: readonly Esm2Sheet[];
    numbers: ReadonlyMap<string, string>;
    mode: Esm2Mode;
    vehicleId: string;
    driverPersonId: string | null;
  },
): Promise<{ cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] }> {
  const { plan, sheets, numbers, mode } = params;
  const burning = new Set(plan.cancel);
  /*
   * Сгорающие листы — списком, а не картой по понедельнику: предшественник ищется по **дням**, тем
   * же правилом, что и в самой сверке (ADR 0142). После месячного разреза лист «31.08–06.09» гаснет
   * ради двух документов, и второй из них по ключу недели остался бы без состава — окно обещало бы
   * бланк без машиниста, а сверка выписала бы его с машинистом сгоревшего листа.
   */
  const burnedSheets = sheets.filter((sheet) => burning.has(sheet.id));
  const burnedFor = (period: { from: string; to: string }): Esm2Sheet | undefined =>
    burnedSheets.find(
      (sheet) => sheet.periodFrom === period.from && sheet.periodTo === period.to,
    ) ??
    burnedSheets.find((sheet) =>
      periodsOverlap({ from: sheet.periodFrom, to: sheet.periodTo }, period),
    );

  const cancel = plan.cancel.map((id) => {
    const sheet = sheets.find((s) => s.id === id);
    return {
      waybillId: id,
      displayNumber: numbers.get(id) ?? id,
      from: sheet?.periodFrom ?? '',
      to: sheet?.periodTo ?? '',
    };
  });

  const wanted = plan.issue.map((period) => {
    const burned = burnedFor(period);
    return {
      from: period.from,
      to: period.to,
      vehicleId: (mode === 'on_demand' ? burned?.vehicleId : null) ?? params.vehicleId,
      driverPersonId: params.driverPersonId ?? burned?.driverPersonId ?? '',
    };
  });
  const names = await readNames(tx, wanted);

  const issue = [...wanted]
    .sort((a, b) =>
      `${a.from}|${a.to}|${a.vehicleId}|${a.driverPersonId}` <
      `${b.from}|${b.to}|${b.vehicleId}|${b.driverPersonId}`
        ? -1
        : 1,
    )
    .map((want, index) => ({
      issueKey: index,
      from: want.from,
      to: want.to,
      vehicleId: want.vehicleId,
      vehicleName: names.vehicles.get(want.vehicleId) ?? want.vehicleId,
      driverPersonId: want.driverPersonId,
      driverName: names.persons.get(want.driverPersonId) ?? want.driverPersonId,
    }));
  return { cancel, issue };
}

interface PreviewNames {
  vehicles: Map<string, string>;
  persons: Map<string, string>;
}

/** Имена машин и людей выпускаемых листов: идентификатор нужен команде, имя — человеку. */
async function readNames(
  tx: AssignmentCommandTx,
  wanted: readonly { vehicleId: string; driverPersonId: string }[],
): Promise<PreviewNames> {
  const vehicleIds = new Set(wanted.map((w) => w.vehicleId).filter(Boolean));
  const personIds = new Set(wanted.map((w) => w.driverPersonId).filter(Boolean));
  const names: PreviewNames = { vehicles: new Map(), persons: new Map() };
  if (vehicleIds.size > 0) {
    const rows = await tx
      .select({
        id: vehicles.id,
        registrationNumber: vehicles.registrationNumber,
        modelName: vehicleModels.name,
      })
      .from(vehicles)
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
      .where(inArray(vehicles.id, [...vehicleIds]));
    for (const row of rows) {
      names.vehicles.set(
        row.id,
        [row.modelName, row.registrationNumber].filter(Boolean).join(' · ') || row.id,
      );
    }
  }
  if (personIds.size > 0) {
    const rows = await tx
      .select({ id: persons.id, fullName: persons.fullName })
      .from(persons)
      .where(inArray(persons.id, [...personIds]));
    for (const row of rows) names.persons.set(row.id, row.fullName);
  }
  return names;
}
