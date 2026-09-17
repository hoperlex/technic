import { eq } from 'drizzle-orm';
import {
  canShortenWorkPeriodByEdit,
  isApprovalChangeable,
  moscowDateKeyOf,
  movedRequestDateKey,
  movedRequestStartKey,
  vehicleRequestLeadTimeBlocker,
  type AssignmentIssueWarningsDto,
  type AssignmentPlanCancelDto,
  type AssignmentPlanIssueDto,
  type AssignmentUnlockDto,
  type CancelledAssignmentGroupDto,
  type Esm2Mode,
  type PeriodApplyInput,
  type PeriodCommand,
  type PeriodPreviewDto,
  type RequestCalendar,
  type RequestStatus,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import type { AuditEntry } from '../lib/audit';
import { err } from '../lib/errors';
import { canApproveRequest } from '../lib/access';
import type { Principal } from '../auth/principal';
import { specialEquipmentRequestDetails, vehicleRequests } from '../db/schema';
import type {
  AssignmentAuditContext,
  AssignmentAuthorizeContext,
  AssignmentCommandSpec,
  AssignmentCommandTx,
  AssignmentPaperContext,
  AssignmentPlanContext,
  AssignmentPlanned,
} from './assignment-command';
import type { AssignmentEffects, AssignmentExternalEffect } from './assignment-effects';
import { ensureAssignmentHistory, ensureCommandHistory } from './assignment-ensure';
import type { AssignmentTerm } from './assignment-history';
import {
  applyAssignmentMutations,
  type AssignmentChangeRecord,
  type AssignmentDenormalizationIntent,
  type AssignmentWriteMutation,
  type AssignmentWriteResult,
} from './assignment-write';
// Право коррекции — одно правило на все двери истории, и живёт оно у двери машиниста (волна 3.2):
// «`crew` требует `waybills.correct`, глубже тридцати дней — `correctBeyondLimit`». Своя копия
// разошлась бы с ней при первой же правке правила, а разъезжаются такие пары молча. Оттуда же
// отпечаток и требование операции: и то и другое одно на все двери истории.
import {
  authorizeCrewCommand,
  authorizeCrewRepeat,
  fingerprintOf,
  operationRequirementOf,
} from './assignment-crew';
// Расчёт изменения срока — общий на четыре применяющие ветви (Р18 плана
// `docs/vehicle-request-actual-end-date-plan.md`): гасимые группы, эффекты, бумага, разблокировки.
// Дверь срока с него и началась и осталась его первым вызывающим; решения по посчитанному —
// по-прежнему её, и ни одно из них в общий расчёт не переехало.
import {
  cancelGroupsShape,
  lastDayOf,
  shortenTermPlan,
  type TermCancelGroup,
} from './assignment-shorten-term';
import type { DateRangeSet, Esm2ExistingSheet, Esm2SheetPlan } from './esm2-plan';
import type { Esm2IssuePreparations, Esm2SyncResult } from './waybill-esm2';
// Шаг 12 у всех дверей истории один: режим решает, кто исполняет бумагу, а исход — с каким
// провенансом (§10, Р32). Порядок работ шага 12 у этой двери свой и остаётся у общего сервиса
// правки срока — сюда приходит только «что исполнять».
import type { AssignmentModeSnapshot } from './assignment-mode';
import {
  assertAssignmentIssueAcknowledgements,
  assignmentPaperExecution,
  paperFollowsHistory,
} from './assignment-paper';
import { afterWorkPeriodChanged } from './vehicle-request-period';
import type { LinearDaysSyncResult } from './vehicle-request-days';

/**
 * Правка срока работ — своя дверь (`docs/assignment-periods-plan.md`, Ж4, З5, Д2, Е3, Л1; §7, §8).
 *
 * ЗАЧЕМ ОНА ОТДЕЛЬНАЯ. Узкое тело «продлить до 31 августа» не легло бы в широкий `PATCH /:id`:
 * `updateVehicleRequestSchema` — строгий discriminated union с обязательными типом заявки, техникой,
 * заказчиком, контактами и файлами (З5), и продление пришлось бы оформлять полной правкой заказа.
 * Но главное не форма тела, а рукопожатия: сокращение способно **погасить группы истории** (Д2), и
 * человек обязан увидеть, какие, — то есть у правки срока появляется собственный предпросмотр,
 * собственный отпечаток последствий и собственный исход (Е3).
 *
 * ЧТО ЭТА ДВЕРЬ ДЕЛАЕТ:
 *
 * - пишет новый срок в `special_equipment_request_details` и зовёт **тот же** сервис последствий,
 *   каким сегодня пользуются широкая правка, досрочное завершение и недельная операция
 *   ([vehicle-request-period.ts](./vehicle-request-period.ts), `afterWorkPeriodChanged`): снятый
 *   запрос на отъезд, бэкстоп чужой двери (Р21, Р22), сверка ЭСМ-2 и план по дням линейного заказа.
 *   Вторая копия этих последствий разошлась бы с первой при первой же правке правила;
 * - **гасит группы, которые сокращение выносит за срок** (Д2): оставленная за новым концом срока
 *   vehicle-строка ожила бы при следующем продлении — без решения о ставках и занятости, в обход
 *   Р7. Гашение групповое (В2): вместе с границей уходит её driver-спутник;
 * - считает исход по Р32 и Е3: `max(исход правки срока, исход гашения каждой группы)`. Отсюда и
 *   права — при `crew` спрашивается `waybills.correct`, глубже тридцати дней `correctBeyondLimit`.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ И ПОЧЕМУ:
 *
 * - **якорей не принимает** (Р22): называть людей в бланки строгой отчётности — не дело правки
 *   срока, у неё право площадки `vehicleRequests.update`. Неполную историю ей называет бэкстоп, и
 *   отвечает он «сходите в окно смены машиниста», а не спрашивает имя;
 * - **назначение не трогает** (Р7, Р17): погасив хвостовую группу, дверь оставляет
 *   `vehicle_request_assignments` как есть, и хвост истории **законно** расходится с ним —
 *   разрешает это расхождение ремонт истории, а следующее продление его увидит (Р31). «Повторное
 *   продление не возвращает погашенную машину само» — §13 плана дословно;
 * - **широкий `PATCH /:id` не заменяет**: до cutover он по-прежнему принимает даты (И5), и
 *   поведение его не меняется ни на шаг. Эта дверь появляется рядом, портал переходит на неё, и
 *   только потом даты уходят из широкой схемы.
 *
 * ГДЕ ГРАНИЦА С КАРКАСОМ. Порядок транзакции, блокировки, отпечаток, строка журнала коррекций,
 * версия и аудит принадлежат [assignment-command.ts](./assignment-command.ts); запись истории —
 * [assignment-write.ts](./assignment-write.ts); проекции последствий —
 * [assignment-effects.ts](./assignment-effects.ts); последствия срока —
 * [vehicle-request-period.ts](./vehicle-request-period.ts).
 *
 * ГДЕ ГРАНИЦА С ОБЩИМ РАСЧЁТОМ СРОКА (Р18 плана `docs/vehicle-request-actual-end-date-plan.md`).
 * Всё, что зависит только от пары «прежний срок → новый срок», живёт в
 * [assignment-shorten-term.ts](./assignment-shorten-term.ts): гасимые группы и их отпечаток,
 * логические эффекты, область и план бумаги, разблокировки, план линейных дней. Тем же расчётом
 * будут считать себя дверь закрытия фактической датой и обе применяющие ветви досрочного
 * завершения — четыре ветви на один предмет, и четыре его копии разошлись бы молча.
 *
 * Здесь остаётся то, что **решает дверь**, а не считает срок: законна ли команда (сокращение
 * работающего заказа, пустая правка, заблаговременность, архив), чем считается её собственный исход
 * (`external`), что она обещает про денормализацию, снимает ли визу, из каких измерений складывает
 * свой отпечаток, чего требует рукопожатием, в каком порядке пишет шаг 11 и что делает с
 * замороженными днями линейного заказа на шаге 12. Ни одно из этих решений в общий расчёт не
 * переехало — иначе извлечение изменило бы поведение двери, которого оно менять не вправе.
 */

/** Имя двери в цели операции журнала (Р9) и в отпечатке предпросмотра — §7 называет его дословно. */
const DOOR = 'period';

// ── Что дверь посчитала ──

/**
 * Предметный план правки срока: всё, что посчитано до первой записи и дальше только читается.
 *
 * Один объект на предпросмотр и на исполнение (§8): предпросмотр обязан обещать ровно то, что
 * произойдёт, а вторая копия расчёта разошлась бы с первой на первом же новом правиле.
 */
export interface PeriodPlan {
  termBefore: AssignmentTerm;
  termAfter: AssignmentTerm;
  /**
   * Дни, которые команда открывает или закрывает, — симметрическая разность сроков (§8, таблица
   * областей). Это и есть бумажный эффект самой правки: строк истории у продления нет вовсе, а
   * недели появляются и исчезают.
   */
  termDiff: DateRangeSet;
  /**
   * Календарная дата правки (ADR 0101 §4, `movedRequestDateKey`): по ней спрашивается задний ход.
   * `null` — колонка срока изменилась, а календарь стоит на месте (снятая `date_to` при
   * однодневном сроке).
   */
  movedDate: string | null;
  mutations: AssignmentWriteMutation[];
  denormalization: AssignmentDenormalizationIntent;
  cancelGroups: TermCancelGroup[];
  /** Те же группы глазами окна: даты, шкалы, состав и имена машин (Д2). */
  cancelGroupsPreview: CancelledAssignmentGroupDto[];
  /** Отпечаток перечня погашаемых групп; `null` — гасить нечего, и подтверждать нечего. */
  cancelGroupsFingerprint: string | null;
  /** Область бумаги (Р11, §7): документное замыкание дневного эффекта команды. */
  paperScope: DateRangeSet;
  /** Аннулируемые и выписываемые листы — так, как их показывает окно. */
  preview: { cancel: AssignmentPlanCancelDto[]; issue: AssignmentPlanIssueDto[] };
  /** Предупреждения по каждому выпускаемому листу: по ним окно строит рукопожатия (Б4). */
  issues: AssignmentIssueWarningsDto[];
  /** Те же листы шагу 12 — снимком, который исполнение не пересчитывает (§7). */
  issuePreparations: Esm2IssuePreparations;
  requiredUnlocks: AssignmentUnlockDto[];
  /** Отпечаток множества разблокировок; `null` — исход не `crew`, разблокировок не спрашивают (Д4). */
  unlockFingerprint: string | null;
  esm2Mode: Esm2Mode;
  /** План листов на отрезках — предмет предпросмотра, отпечатка и шага 12 в режиме `history`. */
  sheetPlan: Esm2SheetPlan;
  /**
   * Действующие листы заявки и их напечатанные номера — прочитанные шагом 6 и один раз.
   *
   * Нужны шагу 12: исполнитель отрезкового плана называет сгоревшую бумагу номером, а прочитать
   * его после аннулирования уже поздно.
   */
  sheets: Esm2ExistingSheet[];
  sheetNumbers: Map<string, string>;
  /**
   * Восстановима ли история заявки. `false` — назначения у заказа нет вовсе (`no_assignment`), и
   * это **не отказ**: срок правят и у заявки без техники, у неё же нет и бумаги. Гасить и
   * материализовать в этом случае нечего, и шаг 11 не зовёт `ensureCommandHistory`.
   */
  historyPresent: boolean;
  /** Виза снимается этой правкой (ADR 0025): срок — суть заказа, а поставит её визирующий заново. */
  dropApproval: boolean;
  /**
   * Отпечаток последствий — он же ответ предпросмотра.
   *
   * Лежит в плане, потому что сверяет его **каркас** шагом 7, а считает дверь: умолчание каркаса
   * («непустая история команды») правку срока пропустило бы — у продления история пуста при
   * непустой бумаге, — и поэтому дверь объявляет `requiresPreview` (Р17). Своей сверки отпечатка
   * у неё больше нет, см. {@link assertPeriodHandshake}.
   */
  fingerprint: string;
}

/** Что дверь пронесла через шаг 12 в аудит и снимок операции. */
export interface PeriodPaper {
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  esm2: Esm2SyncResult;
  days: LinearDaysSyncResult;
}

// ── Расчёт (шаги 4–6 канона) ──

/**
 * Посчитать правку срока целиком: новый срок, гасимые группы, последствия, бумагу и отпечаток.
 *
 * Транзакция приходит читающей (`readOnlyTx` каркаса): до сверки отпечатка и авторизации команда
 * ничего не записывает (Р20). Отказы здесь предметные и потому здесь, а не в схеме: сокращает
 * команда срок или продлевает, задевает ли она прошлое и что при этом гаснет, видно только под
 * блокировкой.
 */
export async function planPeriodCommand(
  ctx: AssignmentPlanContext,
  input: PeriodCommand,
  actor: Principal,
): Promise<AssignmentPlanned<PeriodPlan>> {
  const { tx, request, asOf } = ctx;
  // Архивная заявка этой дверью не открывается: срок правят у живого заказа, а архивную сперва
  // восстанавливают своей ручкой (Ц3 отступление сделано для ремонта истории, а не для срока).
  if (request.deletedAt) throw err.notFound('Заявка не найдена');

  const termBefore = request.term;
  const termAfter = termAfterCommand(termBefore, input);
  assertPeriodChanged(termBefore, termAfter);
  // Каркас читает статус строкой (он ему безразличен), а правила заявки написаны на перечислении.
  // Приведение здесь одно на весь модуль: колонка объявлена тем же перечнем, и разойтись им негде.
  const status = request.status as RequestStatus;

  /*
   * Сокращать срок работающей заявки правкой нельзя (ADR 0044): для этого есть досрочное завершение
   * с визой руководителя строительства, и прямая правка обошла бы её в один шаг. Правило то же, что
   * у широкого маршрута, и оно обязано быть здесь: новая дверь не имеет права оказаться дорогой в
   * обход визы только потому, что тело у неё короче.
   */
  if (lastDayOf(termAfter) < lastDayOf(termBefore) && !canShortenWorkPeriodByEdit(status)) {
    throw err.unprocessable(
      'Срок работающей техники сокращают досрочным завершением — с визой руководителя строительства',
      { dateTo: 'Досрочное завершение' },
    );
  }

  const movedDate = movedRequestDateKey(calendarOf(termBefore), commandCalendar(input));
  const backdated = movedDate !== null && movedDate < asOf;
  /*
   * Заблаговременность (ADR 0104) — та же, что при заведении: правка, переносящая начало заказа,
   * назначает его заново, и заявитель не вправе назначить его ближе, чем завёл бы новую заявку.
   * Спрашивается **день заказа** (`movedRequestStartKey`), а не эффективная дата заднего хода: та
   * берёт в расчёт и конец срока, а сокращение технику ближе не придвигает.
   */
  const movedStart = movedRequestStartKey(calendarOf(termBefore), commandCalendar(input));
  const tooSoon =
    backdated || movedStart === null ? null : vehicleRequestLeadTimeBlocker(actor, movedStart);
  if (tooSoon) throw err.unprocessable(tooSoon, { dateFrom: 'Слишком рано' });

  /*
   * Исход самой правки срока (Е3) — и он остаётся здесь, а не в общем расчёте. Строки истории у
   * правки нет вовсе (календарь двигает колонка заявки), поэтому исход приносится в проекции
   * отдельным эффектом; чем именно он считается, знает только дверь: граница та же, что у
   * `backdateGuard`, — «сегодня и вперёд» обычная работа, раньше — операция с причиной, правом и
   * глубиной. У двери закрытия фактической датой этот эффект свой, и общий расчёт обязан принимать
   * его готовым, а не выводить из срока.
   */
  const external: AssignmentExternalEffect | null =
    movedDate === null ? null : { effectiveDate: movedDate, outcome: backdated ? 'crew' : 'none' };

  /*
   * Общий расчёт изменения срока (Р18) — всё, что зависит только от пары «прежний срок → новый»:
   * история, действующие листы, гасимые группы, эффекты, область и план бумаги, разблокировки.
   *
   * Отказа по невосстановимой истории он не делает, и это отличие двери срока от соседних по
   * существу: срок правят и у заявки, которой техника ещё не назначена, — у неё нет ни истории, ни
   * бумаги, и гасить тоже нечего. Соседним дверям без истории делать нечего вовсе, этой — есть.
   */
  const shorten = await shortenTermPlan(tx, {
    requestId: request.id,
    asOf,
    termBefore,
    termAfter,
    external,
    /*
     * Линейных дней дверь срока у расчёта не спрашивает — и это её прежнее поведение, а не пробел
     * (Р11, таблица политик). Обречённые дни она снимает шагом 12 (`syncLinearRouteDays` внутри
     * `afterWorkPeriodChanged`), а заморозку узнаёт **из-под блокировки рейса** и уже после записи
     * срока: замороженный день у неё предупреждение событием аудита и отказ только при коррекции.
     * Посчитай мы тот же план здесь, в нём лежал бы второй, более старый ответ про те же дни — и
     * первый же читатель принял бы его за основание отказа, которым он не является.
     */
    linearDays: null,
  });
  const { effects } = shorten;

  const approval = await readApproval(tx, request.id);
  const draft = {
    termBefore,
    termAfter,
    termDiff: shorten.termDiff,
    movedDate,
    mutations: shorten.cancelGroups.map((group) => group.target),
    /*
     * Обещание по денормализации (Р17) — двери, а не расчёта: это её слово ядру записи о том, что
     * станет с `vehicle_request_assignments`. Гашения нет — `keep`: правка срока назначения не
     * касается, и сдвинувшийся от неё хвост истории означал бы ошибку двери. Гашение есть —
     * `tail_release`: назначение и ставки не тронуты, а хвост истории **законно** разошёлся с ним,
     * потому что граница снята и вопрос «чем заявка закрыта после срока» снова открыт (Р30, Р31).
     */
    denormalization: (shorten.cancelGroups.length > 0
      ? { kind: 'tail_release' }
      : { kind: 'keep' }) as AssignmentDenormalizationIntent,
    cancelGroups: shorten.cancelGroups,
    cancelGroupsPreview: shorten.cancelGroupsPreview,
    cancelGroupsFingerprint: shorten.cancelGroupsFingerprint,
    paperScope: shorten.paperScope,
    preview: shorten.preview,
    issues: shorten.issues,
    issuePreparations: shorten.issuePreparations,
    requiredUnlocks: shorten.requiredUnlocks,
    unlockFingerprint: shorten.unlockFingerprint,
    esm2Mode: shorten.esm2Mode,
    sheetPlan: shorten.sheetPlan,
    sheets: shorten.sheets,
    sheetNumbers: shorten.sheetNumbers,
    historyPresent: shorten.historyPresent,
    /*
     * Виза руководителя строительства (ADR 0025): согласовано было то, что он видел, а срок —
     * это и есть суть заказа. Снимается она только там, где её можно поставить обратно (заявка
     * «Новая»), и не снимается правкой самого визирующего: он подтверждает изменение фактом правки.
     */
    dropApproval:
      approval.approved &&
      isApprovalChangeable(status) &&
      !canApproveRequest(actor, approval.customer),
  };

  const fingerprint = periodFingerprintOf(
    request.id,
    asOf,
    effects,
    draft,
    shorten.requiredUnlockIds,
  );
  return { effects, fingerprint, plan: { ...draft, fingerprint } };
}

// ── Новый срок и его границы ──

/** Срок после команды: не переданное поле означает «не трогали», `null` у `dateTo` — «сняли». */
export function termAfterCommand(before: AssignmentTerm, input: PeriodCommand): AssignmentTerm {
  return {
    dateFrom: input.dateFrom ?? before.dateFrom,
    dateTo: input.dateTo !== undefined ? input.dateTo : before.dateTo,
  };
}

/**
 * Команда обязана менять срок, и менять его в правильную сторону.
 *
 * Пустая правка отвергается по той же причине, по какой Р12 отвергает пустое изменение истории:
 * она подняла бы версию заявки, сожгла бы ключ операции и оставила бы в журнале строку без
 * предмета. «Тот же срок другими словами» (снятая `date_to` у однодневного заказа) пустой не
 * считается: колонка меняется, и следующая правка обязана видеть её новое значение.
 */
function assertPeriodChanged(before: AssignmentTerm, after: AssignmentTerm): void {
  if (after.dateTo && after.dateTo < after.dateFrom) {
    throw err.unprocessable('Дата окончания раньше даты начала', {
      dateTo: 'Раньше начала срока',
    });
  }
  if (after.dateFrom === before.dateFrom && after.dateTo === before.dateTo) {
    throw err.unprocessable(
      'Срок работ не изменился: правка срока обязана что-то менять — иначе она сожгла бы ключ операции и подняла версию заявки ни за чем',
      { dateFrom: 'Срок не изменился' },
    );
  }
}

/** Календарь заявки для правил заднего числа и заблаговременности (ADR 0101 §4). */
function calendarOf(term: AssignmentTerm): RequestCalendar {
  return { dateFrom: term.dateFrom, dateTo: term.dateTo };
}

/**
 * Тот же календарь из тела команды. Не переданное поле остаётся `undefined` — «не трогали», и
 * различать это с `null` обязательно: снятая дата окончания календарь двигает, непереданная нет.
 */
function commandCalendar(input: PeriodCommand): RequestCalendar {
  return { dateFrom: input.dateFrom, dateTo: input.dateTo };
}

// ── Рукопожатия (шаг 8) ──

/**
 * Что тело обязано подтвердить против **рассчитанного** плана (§8, Д2, Д4).
 *
 * Проверок здесь две — только **дополнительные** отпечатки двери. Общий отпечаток последствий
 * сверяет каркас шагом 7, и до Э4а дверь сверяла его вторым, своим, экземпляром той же проверки:
 * умолчание каркаса («непустая история команды») правку срока пропускало, потому что у продления
 * строк истории нет при сгорающих и выписываемых листах. Теперь дверь объявляет каркасу
 * `requiresPreview` (Р17) — тот же безусловный вопрос, тот же 409 и тот же текст, — а копия
 * проверки убрана: два места, отвечающих на один вопрос, рано или поздно ответили бы по-разному.
 *
 * Каждая из оставшихся закрывает свой способ сделать не то, что человек видел:
 *
 * 1. **перечень гасимых групп** (Д2) — сокращение без подтверждения отвечает 422 с перечнем, и
 *    `date_to` при этом не меняется. Лишнее подтверждение отвергается симметрично: тело, знающее
 *    про гашение, которого нет, посчитано по другому состоянию;
 * 2. **отпечаток разблокировок** (Д4) — присутствие поля определяется исходом, а не желанием
 *    клиента: лишний отпечаток это не «лишнее поле», а заявка на право сжечь чужие номера.
 */
export function assertPeriodHandshake(
  plan: PeriodPlan,
  input: PeriodApplyInput,
  /**
   * Режим чтения: им решается, требовать ли рукопожатия по листам (Б4).
   *
   * В `history` бумагу выпускает **этот** план, и предупреждения по каждому бланку человек
   * подтверждает сам; в `legacy` листы переписывает недельная сверка, у которой просителя нет
   * вовсе и которую неполный комплект документов не останавливает (ADR 0064). Присланное
   * подтверждение проверяется в обоих режимах.
   */
  mode: AssignmentModeSnapshot,
): void {
  assertAssignmentIssueAcknowledgements({
    issues: plan.issues,
    acknowledgements: input.acknowledgements,
    required: paperFollowsHistory(mode),
  });
  if (plan.cancelGroupsFingerprint === null) {
    if (input.cancelGroupsFingerprint !== undefined) {
      throw err.unprocessable(
        'Эта правка срока ничего не гасит в истории назначения — подтверждать нечего. Посмотрите последствия заново и повторите команду без подтверждения',
        { cancelGroupsFingerprint: 'Лишнее подтверждение' },
      );
    }
  } else if (input.cancelGroupsFingerprint !== plan.cancelGroupsFingerprint) {
    throw err.unprocessable(
      `Сокращение срока гасит решения о технике и машинисте, стоявшие за новым концом срока (${plan.cancelGroups
        .map((group) => group.rows[0]!.effectiveDate)
        .join(
          ', ',
        )}): решение уходит целиком — вместе с машиной снимается и назначенный на неё машинист. Подтвердите перечень — он показан в предпросмотре`,
      { cancelGroupsFingerprint: 'Нужно подтверждение' },
      { cancelGroups: plan.cancelGroupsPreview },
    );
  }
  if (plan.unlockFingerprint === null) {
    if (input.unlockFingerprint !== undefined) {
      throw err.unprocessable(
        'Эта правка срока прошлого не трогает — подтверждать разблокировку отработанных листов нечем',
        { unlockFingerprint: 'Лишнее подтверждение' },
      );
    }
    return;
  }
  if (input.unlockFingerprint !== plan.unlockFingerprint) {
    throw err.unprocessable(
      'Список отработанных листов, которые переоформит операция, изменился — посмотрите последствия заново',
      { unlockFingerprint: 'Подтверждение не совпало' },
      { requiredUnlocks: plan.requiredUnlocks },
    );
  }
}

// ── Отпечаток предпросмотра (Р20, Р32) ──

/**
 * Отпечаток последствий: **содержание**, а не идентификаторы (Р20).
 *
 * Входит сюда семантическая команда (каким станет срок), день расчёта, исход, все рассчитанные
 * последствия, состав гасимых групп и бумажный план. Не входят рукопожатия — версия, причина, ключ
 * операции и входные отпечатки: они появляются в теле **после** предпросмотра, и хеш всего боевого
 * тела не сошёлся бы никогда.
 *
 * Команда кладётся результатом, а не телом: «продлить до 31 августа» и «поставить срок 1 марта —
 * 31 августа» — одна и та же правка, и предпросмотр, показанный одной формулировкой, обязан
 * подойти второй.
 */
function periodFingerprintOf(
  requestId: string,
  asOf: string,
  effects: AssignmentEffects,
  plan: Omit<PeriodPlan, 'fingerprint'>,
  requiredUnlockIds: readonly string[],
): string {
  return fingerprintOf({
    door: DOOR,
    requestId,
    asOf,
    command: { dateFrom: plan.termAfter.dateFrom, dateTo: plan.termAfter.dateTo },
    outcome: effects.operationOutcome,
    effects: {
      ...effects.payload,
      mutations: effects.payload.mutations.map(({ changeId: _id, ...rest }) => rest),
    },
    termDiff: plan.termDiff,
    cancelGroups: cancelGroupsShape(plan.cancelGroups),
    requiredUnlockIds: [...requiredUnlockIds],
    plan: {
      cancel: plan.preview.cancel.map((sheet) => sheet.waybillId).sort(),
      issue: plan.preview.issue.map((i) => `${i.from}|${i.to}|${i.vehicleId}|${i.driverPersonId}`),
      /*
       * Правки периода — третьим ключом (Р5). Без него подмена «перевыпуск → правка» отпечатка не
       * меняет: у плана, сокращающего лист, обе половины выше пусты — номер не горит и новый не
       * выписывается, — и два плана, различающиеся ТОЛЬКО правками, дали бы один отпечаток.
       * Человек подтвердил бы одно обещание, а исполнилось бы другое.
       *
       * Берётся из самого плана листов, а не из предпросмотра: показ правок — забота следующего
       * этапа (`AssignmentPlanTrimDto`), а отпечаток обязан считаться уже сейчас — иначе окно
       * подтверждения останется дырявым на всё время, пока DTO не завели.
       */
      trim: plan.sheetPlan.trim.map((item) => `${item.waybillId}|${item.to}`).sort(),
    },
  });
}

// ── Спецификация команды для каркаса (§8) ──

/**
 * Спецификация правки срока для `runAssignmentCommand` — **один** источник на боевую ручку и на
 * тесты двери.
 *
 * Собрана здесь, а не в роут-модуле, по той же причине, по какой предпросмотр зовёт тот же колбэк
 * `plan`: место, где предметные места канона заполняются, должно быть одно.
 */
export function periodCommandSpec(params: {
  requestId: string;
  actor: Principal;
  input: PeriodApplyInput;
  asOf: string;
}): AssignmentCommandSpec<PeriodPlan, AssignmentWriteResult, PeriodPaper> {
  const { requestId, actor, input, asOf } = params;
  const reason = input.operation?.reason ?? PERIOD_SYNC_REASON;
  return {
    /*
     * Класс двери — `history` (§10), и он же стоит у сегодняшней правки срока в широком маршруте:
     * дверь читает историю ради бумаги, а с гашением ещё и пишет её. При откате она закрыта первой.
     */
    door: 'history',
    journalDoor: DOOR,
    requestId,
    actor: { id: actor.id },
    expectedVersion: input.version,
    body: input,
    operation: input.operation ?? null,
    previewFingerprint: input.previewFingerprint,
    /*
     * Предпросмотр эта дверь спрашивает **всегда** (Р17), и это не перестраховка, а условие
     * неизменности поведения: её собственное рукопожатие сверяло отпечаток безусловно — иначе
     * продление, у которого история пуста при непустой бумаге, проходило бы вовсе без
     * подтверждения. Признак, считающий непустоту чего бы то ни было, изменил бы дверь ровно там,
     * где перенос сверки в каркас обещает её сохранить.
     */
    requiresPreview: () => true,
    asOf,
    plan: (ctx) => planPeriodCommand(ctx, input, actor),
    handshake: (ctx) => assertPeriodHandshake(ctx.plan, input, ctx.mode),
    /*
     * Права спрашиваются по посчитанному исходу (Р32, Е3), а не по календарю и не по составу тела:
     * продление вперёд — обычная работа площадки под `vehicleRequests.update`, а та же дверь,
     * сдвинувшая начало срока в позапрошлую неделю или погасившая отработанную группу, спрашивает
     * `waybills.correct` и, глубже тридцати дней, `correctBeyondLimit`.
     */
    authorize: (ctx) => authorizePeriodCommand(actor, ctx),
    authorizeRepeat: (scope) => authorizeCrewRepeat(actor, scope),
    mutate: async (ctx) => {
      /*
       * Порядок внутри шага 11 значим целиком, и каждый его переход обоснован:
       *
       * 1. **материализация истории** — по **прежнему** сроку: расчёт шага 5 видел именно его, и
       *    цель гашения адресована строке, которую вписывает как раз этот вызов (Р20, Р26). Зови мы
       *    его после записи срока, бэкфилл восстановил бы историю по новому сроку — другую;
       * 2. **гашение групп** — по разрешённым целям, ядром записи и одной мутацией на группу;
       * 3. **новый срок** — после истории: `afterWorkPeriodChanged` читает заявку из базы, и срок к
       *    его вызову обязан быть уже записан;
       * 4. **пересчёт готовности** — Ж1: дверь, изменившая область валидности, обязана пересчитать
       *    блокеры и допустить переход в **обе** стороны. Продление делает изменяемыми дни, которые
       *    вчера лежали в заблокированном прошлом, сокращение — наоборот.
       */
      if (ctx.plan.historyPresent)
        await ensureCommandHistory(ctx.tx, { requestId, asOf: ctx.asOf });
      const write = await applyAssignmentMutations(ctx.tx, {
        requestId,
        actorUserId: actor.id,
        // Строки гаснут операцией журнала: «почему майская машина вдруг снята» отвечается ею.
        correctionId: ctx.operation?.id ?? null,
        mutations: ctx.plan.mutations,
        denormalization: ctx.plan.denormalization,
      });
      await writePeriod(ctx.tx, requestId, ctx.plan.termAfter);
      if (ctx.plan.dropApproval) await clearApproval(ctx.tx, requestId);
      await ensureAssignmentHistory(ctx.tx, { requestId, asOf: ctx.asOf });
      return { write, applied: write };
    },
    syncPaper: (ctx) =>
      syncPeriodPaper(ctx, {
        requestId,
        actorUserId: actor.id,
        reason,
        acknowledgements: input.acknowledgements,
      }),
    payload: (ctx) => ({
      door: DOOR,
      period: { before: ctx.plan.termBefore, after: ctx.plan.termAfter },
      movedDate: ctx.plan.movedDate,
      requiredUnlockIds: ctx.plan.requiredUnlocks.map((u) => u.waybillId),
      cancelledGroups: ctx.write.cancelledGroups,
      history: historySnapshotOf(ctx.write),
      esm2: ctx.paper.esm2,
      linearDays: ctx.paper.days,
    }),
    audit: (ctx) => periodAuditOf(ctx),
  };
}

/** Причина сверки у обычной правки: у операции журнала берётся её собственная. */
const PERIOD_SYNC_REASON = 'Срок работ изменён — путевые листы переоформлены';

/**
 * Шаг 9 — условная авторизация (Р32, Е3) плюс то, чего у соседних дверей нет: право снять визу.
 *
 * Коррекционная половина — общая с дверью машиниста (`authorizeCrewCommand`), и второй её редакции
 * здесь нет намеренно. Своё у правки срока одно: `vehicleRequests.update` спрошено стражем
 * маршрута безусловно, потому что нужно оно всегда, — и в снимок авторизации не попадает.
 */
function authorizePeriodCommand(
  actor: Principal,
  ctx: AssignmentAuthorizeContext<PeriodPlan>,
): WaybillCorrectionAuthorizationScope {
  return authorizeCrewCommand(actor, ctx.effects, ctx.asOf);
}

/** Новый срок — той же колонкой, какой его пишет широкая правка. */
async function writePeriod(
  tx: AssignmentCommandTx,
  requestId: string,
  term: AssignmentTerm,
): Promise<void> {
  await tx
    .update(specialEquipmentRequestDetails)
    .set({ dateFrom: term.dateFrom, dateTo: term.dateTo })
    .where(eq(specialEquipmentRequestDetails.requestId, requestId));
}

/** Снятие визы (ADR 0025): обе колонки разом — «согласовано» это пара, а не флаг. */
async function clearApproval(tx: AssignmentCommandTx, requestId: string): Promise<void> {
  await tx
    .update(vehicleRequests)
    .set({ approvedBy: null, approvedAt: null })
    .where(eq(vehicleRequests.id, requestId));
}

/**
 * Шаг 12 — последствия изменившегося срока, и **тем же сервисом**, каким их считают широкая правка,
 * досрочное завершение и недельная операция.
 *
 * Что он делает по порядку: снимает ожидающий визы запрос на отъезд (ADR 0044), спрашивает бэкстоп
 * чужой двери (Р21, Р22) и только потом сверяет бумагу и дни. Порядок принадлежит ему, а не этой
 * двери, и это правильно: бэкстоп обязан считаться по **уже записанному** сроку — Р31 велит
 * проверять весь вновь открываемый диапазон.
 *
 * Бэкстоп здесь остаётся `work_period`, то есть считает его сервис. Дверь его не перехватывает,
 * хотя предпросмотр у неё есть: якорей она по-прежнему не принимает (Р22), и вердикт про
 * неназванного машиниста адресован не ей, а окну смены машиниста. В режиме `legacy` это диагностика,
 * в `history` — 422, откатывающий транзакцию вместе с только что записанным сроком.
 *
 * Контекст коррекции передаётся ровно при исходе `crew` и вместе с серверным списком разблокировок:
 * без него продление в прошедшую неделю оставило бы заказ с новым сроком и без бумаги за уже
 * отработанные дни — сверка кончившуюся неделю не выписывает вовсе.
 *
 * **Кто исполняет бумагу, решает режим** (§10). В `legacy` её ведёт недельная сверка — та же, что и
 * у трёх соседних вызывающих этого сервиса. В `history` дверь передаёт сюда **готовый** отрезковый
 * план: он посчитан шагом 6, показан человеку и захеширован в отпечаток, а порядок работ шага 12
 * остаётся за сервисом. Пересчитывать план здесь нельзя — это было бы исполнением не того, что
 * подтверждено.
 */
async function syncPeriodPaper(
  ctx: AssignmentPaperContext<PeriodPlan, AssignmentWriteResult>,
  params: {
    requestId: string;
    actorUserId: string;
    reason: string;
    /** Рукопожатия, принятые шагом 8: ими лист помнит, под чем его подписали (Р21). */
    acknowledgements?: Readonly<Record<string, string>> | undefined;
  },
): Promise<PeriodPaper> {
  const correctionId = ctx.operation?.id ?? null;
  const unlockWaybillIds = ctx.plan.requiredUnlocks.map((u) => u.waybillId);
  const result = await afterWorkPeriodChanged(ctx.tx, {
    requestId: params.requestId,
    actor: { id: params.actorUserId },
    reason: params.reason,
    // Снятие запроса на отъезд молчаливое, как у широкой правки: правит один заказ один человек,
    // глядя на него. Недельная операция так поступать не вправе — там согласие спрашивают построчно.
    dropPendingEarlyEnd: true,
    backstop: 'work_period',
    /*
     * Направление правки — явно (Ю78). Умолчание двери «правка срока» — «открывает новые дни», и
     * для продления это верно. Сокращение же само гасит хвостовую группу и, спроси оно решение по
     * хвосту, получило бы вердикт о расхождении, которое только что и создало. Считается по
     * прочитанному под блокировкой сроку, а не по намерению тела: `dateTo` мог не измениться вовсе,
     * а начало — сдвинуться.
     */
    opensTerm: lastDayOf(ctx.plan.termAfter) > lastDayOf(ctx.plan.termBefore),
    ...(ctx.effects.needsCorrection && correctionId
      ? { correction: { id: correctionId, unlockWaybillIds } }
      : {}),
    ...(paperFollowsHistory(ctx.mode)
      ? {
          paper: {
            kind: 'plan' as const,
            ...assignmentPaperExecution({
              requestId: params.requestId,
              actor: { id: params.actorUserId },
              reason: params.reason,
              mode: ctx.mode,
              effects: ctx.effects,
              operationId: correctionId,
              sheetPlan: ctx.plan.sheetPlan,
              paperScope: ctx.plan.paperScope,
              sheets: ctx.plan.sheets,
              displayNumbers: ctx.plan.sheetNumbers,
              unlockWaybillIds,
              // Снимок бланка и предупреждения — посчитанные шагом 6 и подтверждённые человеком.
              issues: ctx.plan.issuePreparations,
              acknowledgements: params.acknowledgements,
            }),
          },
        }
      : {}),
  });
  /*
   * Дни линейного заказа, которых замороженный рейс не отдал (ADR 0100 §11, Р11). У обычной правки
   * это предупреждение — срок продлевают вперёд, и человек читает о дне событием аудита. У операции
   * задним числом это отказ: она утверждает, что прошедший день был другим, а бумага на него уже у
   * водителя. Граница и слова те же, что у широкой правки, — иначе одна и та же беда объяснялась бы
   * двумя способами.
   */
  if (ctx.effects.needsCorrection && result.days.frozen.length > 0) {
    throw err.unprocessable(
      `Дни заказа стоят в рейсах с выписанными листами (${result.days.frozen
        .map((day) => `${day.date} — ${day.routeNumber}`)
        .join(
          '; ',
        )}): сначала аннулируйте лист рейса, иначе правка срока разойдётся с выданной бумагой`,
      { dateFrom: 'День в замороженном рейсе' },
    );
  }
  return { earlyEndDropped: result.earlyEndDropped, esm2: result.esm2, days: result.days };
}

/** Снимок «было → стало» по истории (Р9): что погасло — значениями, а не ссылками. */
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
    cancelledGroups: write.cancelledGroups,
  };
}

/**
 * События ленты — **данными**: пишет их каркас и в транзакции (§8, шаг 13).
 *
 * Действие правки остаётся общим (`vehicle_request.update`) и с тем же перечнем изменённых полей:
 * человек, читающий историю заказа, спрашивает «когда подвинули срок», а не «какой дверью». Своё у
 * этой двери — соседние события: снятая виза и снятый запрос на отъезд объясняют, почему заявка
 * перестала быть согласованной и куда делся чужой запрос. Переписанную бумагу объясняет
 * `waybill.esm2_sync`, и пишет его единственный владелец — исполнитель плана шагом 12.
 */
function periodAuditOf(
  ctx: AssignmentAuditContext<PeriodPlan, AssignmentWriteResult, PeriodPaper>,
): AuditEntry[] {
  const { plan, paper } = ctx;
  const entries: AuditEntry[] = [
    {
      action: 'vehicle_request.update',
      metadata: {
        changes: [
          ...(plan.termAfter.dateFrom !== plan.termBefore.dateFrom
            ? [{ field: 'dateFrom', from: plan.termBefore.dateFrom, to: plan.termAfter.dateFrom }]
            : []),
          ...(plan.termAfter.dateTo !== plan.termBefore.dateTo
            ? [{ field: 'dateTo', from: plan.termBefore.dateTo, to: plan.termAfter.dateTo }]
            : []),
        ],
        door: DOOR,
        outcome: ctx.effects.operationOutcome,
        operationId: ctx.operation?.operationId ?? null,
        ...(ctx.operation ? { backdated: true, backdateReason: ctx.operation.reason } : {}),
        cancelledGroups: ctx.write.cancelledGroups,
      },
    },
  ];
  if (plan.dropApproval) {
    entries.push({
      action: 'vehicle_request.approval_revoke',
      metadata: { reason: 'edited' },
    });
  }
  if (paper.earlyEndDropped) {
    entries.push({
      action: 'vehicle_request.early_end_cancel',
      metadata: { reason: 'edited' },
    });
  }
  /*
   * Переписанной бумаги здесь нет намеренно: `waybill.esm2_sync` пишет единственный владелец
   * строгого события — исполнитель плана (`applyEsm2SyncPlanAndAudit`), той же транзакцией и
   * шагом раньше. Второе его написание здесь дало бы два события подряд об одной работе.
   */
  return entries;
}

// ── Предпросмотр (§7) ──

/**
 * Ответ предпросмотра: общий `AssignmentPreviewDto` плюс то, что есть только у этой двери (Д2).
 *
 * `requiredAnchors` и `requiredVehicleResolution` приходят пустыми, и это правда, а не заглушка:
 * якорей дверь не принимает вовсе (Р22), и показать их значило бы предложить окну заполнить поле,
 * которого в теле нет. Неполную историю называет бэкстоп на шаге 12 — своим отказом и своими
 * словами («назначьте машиниста в окне смены машиниста»), — и второй, приблизительный вердикт
 * рядом с ним разошёлся бы с настоящим ровно на гашениях, которых бэкстоп ещё не видит.
 *
 * Часы смен пусты по той же причине, что у команды машиниста: правка срока подписей не снимает и
 * часов не удаляет — она меняет **набор дней**, а не состав внутри них.
 */
export function periodPreviewDto(
  effects: AssignmentEffects,
  plan: PeriodPlan,
  fingerprint: string,
  asOf: string,
): PeriodPreviewDto {
  return {
    plan: plan.preview,
    requiredAnchors: [],
    requiredVehicleResolution: null,
    blockedShiftDays: [],
    clearedShiftDays: [],
    clearedShiftsFingerprint: null,
    requiredUnlocks: plan.requiredUnlocks,
    unlockFingerprint: plan.unlockFingerprint,
    // Предупреждения по каждому выпускаемому листу — посчитанные вместе с планом (§7): окно строит
    // по ним рукопожатия, а шаг 12 печатает ровно тот набор, который человек подтвердил.
    issues: plan.issues,
    operationRequirement: operationRequirementOf(effects),
    asOf,
    fingerprint,
    cancelGroups: plan.cancelGroupsPreview,
    cancelGroupsFingerprint: plan.cancelGroupsFingerprint,
  };
}

// ── Чтение, которого нет у общего расчёта ──

/**
 * Виза и заказчик заявки: ими решается, снимает ли правка согласование (ADR 0025).
 *
 * Единственное чтение, оставшееся в двери. Справочники бумаги и истории читает общий расчёт — они
 * нужны всем четырём ветвям, — а согласование не про срок вовсе: это правило о том, кто и что
 * подтверждал, и у двери закрытия фактической датой оно другое.
 */
async function readApproval(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<{
  approved: boolean;
  customer: { objectId: string | null; departmentId: string | null };
}> {
  const [row] = await tx
    .select({
      approvedAt: vehicleRequests.approvedAt,
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
    })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  return {
    approved: row.approvedAt !== null,
    customer: { objectId: row.objectId, departmentId: row.departmentId },
  };
}

// ── Мелочи ──

/** День расчёта — сегодня по МСК; тем же поясом границы считает портал (Р32). */
export function periodAsOf(): string {
  return moscowDateKeyOf(new Date());
}
