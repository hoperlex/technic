import { and, eq, isNotNull } from 'drizzle-orm';
import {
  actsForCounterparty,
  completionEndBounds,
  moscowDateKeyOf,
  movedRequestDateKey,
  requestStatusLabels,
  shiftDaysOf,
  shiftRangeAfterActualEnd,
  type AssignmentShiftDay,
  type CompletionApplyInput,
  type CompletionFactInput,
  type CompletionPreviewDto,
  type LinearDayRef,
  type LinearDaySubject,
  type RequestStatus,
  type ShiftDayRange,
  type VehicleOwnership,
  type VehicleRequestCompletionDto,
  type VehicleWorkUnit,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { assertCan } from '../lib/access';
import type { AuditEntry } from '../lib/audit';
import { err } from '../lib/errors';
import {
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequestCompletions,
  vehicleRequests,
  vehicleRequestStatusHistory,
  vehicles,
} from '../db/schema';
import type {
  AssignmentApplyContext,
  AssignmentAuditContext,
  AssignmentAuthorizeContext,
  AssignmentCommandSpec,
  AssignmentCommandTx,
  AssignmentPaperContext,
  AssignmentPlanContext,
  AssignmentPlanned,
} from './assignment-command';
import {
  assignmentCommandEffects,
  type AssignmentEffects,
  type AssignmentExternalEffect,
} from './assignment-effects';
import { ensureAssignmentHistory, ensureCommandHistory } from './assignment-ensure';
import type { AssignmentTerm } from './assignment-history';
// Право коррекции — одно правило на все двери истории и живёт оно у двери машиниста: «`crew`
// требует `waybills.correct`, глубже тридцати дней — `correctBeyondLimit`». Отпечаток — та же
// функция хеширования, что у соседей: два отпечатка одного содержания обязаны совпадать. Требование
// операции — общая проекция исхода: спрашивает его окно у всех дверей одинаково.
import {
  authorizeCrewCommand,
  authorizeCrewRepeat,
  fingerprintOf,
  operationRequirementOf,
} from './assignment-crew';
import { assertAssignmentBackstop } from './assignment-backstop';
import type { AssignmentModeSnapshot } from './assignment-mode';
import {
  assertAssignmentIssueAcknowledgements,
  assignmentPaperExecution,
  paperFollowsHistory,
} from './assignment-paper';
// Общий расчёт изменения срока (Р18): гасимые группы, эффекты, бумага, разблокировки и — данными —
// план линейных дней. Дверь закрытия его второй вызывающий после двери срока.
import {
  cancelGroupsShape,
  lastDayOf,
  shortenTermPlan,
  type ShortenTermPlan,
} from './assignment-shorten-term';
import {
  dropUnapprovedShiftsInRange,
  readShiftDays,
  splitShiftDaysByRange,
} from './assignment-shifts';
// Факт выполнения — общий на обе закрывающие двери (ADR 0029): ставку берёт сервер, аренда без
// суммы не закрывается. Своя копия этих правил разошлась бы с первой молча и в деньгах.
import {
  resolveCompletion,
  saveCompletion,
  type CompletionRates,
} from './vehicle-request-completion';
import {
  applyAssignmentMutations,
  type AssignmentChangeRecord,
  type AssignmentDenormalizationIntent,
  type AssignmentWriteResult,
} from './assignment-write';
import { dateKeyRu } from './request-diff';
import {
  diffVehicleCompletion,
  earlyEndReasonChange,
  shiftsPendingChange,
} from './vehicle-request-diff';
import { linearDayRefOf, loadLinearRequest, type LinearDaysPlan } from './vehicle-request-days';
import { afterWorkPeriodChanged, clearPendingEarlyEnd } from './vehicle-request-period';
import type { Esm2SyncResult } from './waybill-esm2';

/**
 * Закрытие заказа спецтехники **фактической датой** — своя дверь канона
 * (`docs/vehicle-request-actual-end-date-plan.md`, Р1–Р3, Р10, Р11, Р16–Р18, Р22–Р28).
 *
 * ЗАЧЕМ ОНА ОТДЕЛЬНАЯ. Сегодня заказ закрывает общая статусная ручка, и срок она не трогает вовсе:
 * заявка уходит в «Выполнена» с воскресным `date_to`, а лист ЭСМ-2 продолжает утверждать, что
 * техника стояла на объекте всю неделю. Закрытие фактом — это уже не смена статуса: оно сокращает
 * срок, гасит решения истории за новым концом, переписывает бумагу, снимает часы за границей факта
 * и отцепляет дни линейного заказа. У такой операции обязаны быть предпросмотр с отпечатком,
 * множество разблокировок, условная авторизация со снимком требований, строка журнала коррекций и
 * — у коррекционной ветви — ключ идемпотентности. Всё это уже написано каноном
 * ([assignment-command.ts](./assignment-command.ts)) и проверено на четырёх дверях; копия внутри
 * барьерного `vehicle-requests.ts` была бы **второй** реализацией идемпотентности и заднего числа.
 *
 * ЧТО ЭТА ДВЕРЬ ДЕЛАЕТ (шагами канона):
 *
 * - считает новый срок по фактической дате и зовёт **общий** расчёт сокращения
 *   ([assignment-shorten-term.ts](./assignment-shorten-term.ts)) — тот же, которым считает себя
 *   дверь срока: гасимые группы, эффекты, область и план бумаги, разблокировки, план линейных дней;
 * - пишет статус `done`, строку истории статусов и **факт** вместе со снимком дат
 *   (`ended_on`, `previous_date_to`) — тем же порядком, каким его пишет статусная ручка;
 * - снимает заполненные без подписи часы **за границей факта** (Р10) и отцепляет дни линейного
 *   заказа, оказавшиеся за той же границей (Р11, Р27);
 * - повторяет всё, что делает сегодняшнее закрытие помимо статуса (Р24): снятый ожидающий визы
 *   запрос на отъезд со своим событием, событие факта `vehicle_request.complete`, отдельное
 *   событие линейной сверки и — **последним шагом** — снятие заморозки режима.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ И ПОЧЕМУ:
 *
 * - **не спрашивает визы** (Р4): досрочное завершение решает про будущее — «отпустить технику
 *   раньше», — а закрытие констатирует состоявшееся. Новых возможностей это не даёт: закрытие и
 *   сегодня снимает технику с заказа;
 * - **не трогает работу внутри факта** (Р10, Р27): часы отработанных дней предъявляются самим
 *   фактом выполнения, а рейс отработанного дня — след состоявшейся работы;
 * - **не открывает грузоперевозке**: каркас команд принимает только заказ спецтехники с непустым
 *   сроком, и расширять субъект ради заявки, у которой нет ни срока, ни бумаги, ни смен, эта волна
 *   не станет (Р3).
 *
 * ДВЕ ВЕТВИ, И ВЫБИРАЕТ ИХ СЕРВЕР (Р16). Арендодатель закрывает свой заказ **своим коридором**: даты
 * у него не спрашивают, срок остаётся плановым, бумага не трогается — у него и права на неё нет
 * (`waybills.read`), а предпросмотр называет номера бланков. Ветвь опознаётся по субъекту и
 * назначенной машине, а не по принадлежности техники: `assertLessorScope` пропускает администратора
 * и диспетчера без ограничений, и ветвь по одному лишь `ownership === 'rental'` отдала бы им обход
 * даты, предпросмотра и права на бумагу.
 *
 * ГДЕ ГРАНИЦА С КАРКАСОМ. Порядок транзакции, блокировки, сверка отпечатка (шаг 7), строка журнала,
 * версия и запись аудита принадлежат [assignment-command.ts](./assignment-command.ts); запись
 * истории — [assignment-write.ts](./assignment-write.ts); последствия срока —
 * [vehicle-request-period.ts](./vehicle-request-period.ts); бумага —
 * [assignment-paper.ts](./assignment-paper.ts).
 */

/** Имя двери в цели операции журнала (Р9) и в отпечатке предпросмотра. */
const DOOR = 'completion';

/**
 * Ветвь команды — решение сервера, а не тела (Р16, Р17, Р28).
 *
 * Именем, а не признаком «план пуст»: пустой план бывает и у обычного закрытия — заказ, закрываемый
 * ровно своим `date_to`, — и признай мы такую команду «пустой по построению», она прошла бы без
 * подтверждения, хотя человек последствия видел и мог увидеть устаревшие.
 */
export type CompletionBranch = 'actualEndDate' | 'paperlessLessorCompletion';

/** Причина сверки бумаги у этой двери: ею журнал бланков объясняет переписанные листы. */
const COMPLETION_SYNC_REASON = 'Заказ закрыт фактической датой — путевые листы переоформлены';

// ── Что дверь посчитала ──

/**
 * Предметный план закрытия: всё, что посчитано до первой записи и дальше только читается.
 *
 * Один объект на предпросмотр и на исполнение (§8 канона): предпросмотр обязан обещать ровно то,
 * что произойдёт, а вторая копия расчёта разошлась бы с первой на первом же новом правиле.
 */
export interface CompletionPlan {
  branch: CompletionBranch;
  /** Фактическая дата; `null` — арендодательская ветвь, у неё даты не спрашивают вовсе (Р16). */
  endedOn: string | null;
  /** Эффективный конец срока **до** команды — `coalesce(date_to, date_from)` (§4, снимок факта). */
  previousDateTo: string;
  termBefore: AssignmentTerm;
  /** Срок, каким его сделает команда; равен прежнему, когда закрывают ровно по концу срока. */
  termAfter: AssignmentTerm;
  /**
   * Факт, посчитанный общим разбором (`resolveCompletion`): ставка из назначения, сумма — от
   * клиента либо по ставке. Тот же объект и пишется, и уходит в событие: «было → стало» считается
   * по нему, а не по перечитанной строке.
   */
  fact: VehicleRequestCompletionDto;
  /**
   * Общий расчёт сокращения срока; `null` — арендодательская ветвь: она срока не двигает, и
   * спрашивать у расчёта нечего (Р16). Ни бумаги, ни гашений, ни разблокировок у неё нет **по
   * построению**, а не по случайности.
   */
  shorten: ShortenTermPlan | null;
  /** Диапазон снимаемых смен `(endedOn, previousDateTo]`; `null` — снимать нечего (Р10). */
  shiftRange: ShiftDayRange | null;
  /** Заполненные без подписи дни диапазона: их команда удалит после подтверждения отпечатка. */
  clearedShiftDays: AssignmentShiftDay[];
  /** Отпечаток снимаемых часов; `null` — снимать нечего, и подтверждать нечего. */
  clearedShiftsFingerprint: string | null;
  /**
   * Дни линейного заказа, которые новый срок выносит за границу (Р11, Р27). `frozen` здесь всегда
   * пуст: непустым он не доживает до этого места — команда отказывается целиком и **до первой
   * записи** (см. {@link planCompletionCommand}).
   */
  linearDays: LinearDaysPlan;
  /**
   * Дни факта, за которые объект так и не расписался (Р24). Считаются по **фактическому** периоду,
   * а не по «сегодня»: дни за границей факта к этому моменту сняты и в «не расписались» не входят.
   */
  shiftsPending: string[];
  /** Снимок заморозки режима: снимать её или нет, решает состояние **до** команды (Р24). */
  linearFrozen: boolean;
  /** Слово закрывающего: уходит в строку истории статусов и в событие перехода (паритет Р24). */
  comment: string;
  /** Отпечаток последствий — он же ответ предпросмотра; сверяет его каркас шагом 7 (Р17). */
  fingerprint: string;
}

/** Что дверь пронесла через шаг 11 в аудит и снимок операции. */
export interface CompletionApplied {
  write: AssignmentWriteResult;
  /** Факт **до** команды: у закрытия после отката он есть, и «было → стало» читается по нему. */
  factBefore: VehicleRequestCompletionDto | null;
  fact: VehicleRequestCompletionDto;
  /** Даты, часы за которые команда действительно удалила (Р10). */
  clearedShiftDates: string[];
}

/** Что дверь пронесла через шаг 12. */
export interface CompletionPaper {
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  esm2: Esm2SyncResult;
  /** Дни, снятые с рейсов, и дни, которых рейс не отдал (последних быть не должно, Р11). */
  detached: LinearDayRef[];
}

// ── Расчёт (шаги 4–6 канона) ──

/**
 * Посчитать закрытие целиком: ветвь, факт, новый срок, гасимые группы, бумагу, смены, дни и
 * отпечаток.
 *
 * Транзакция приходит читающей (`readOnlyTx` каркаса): до сверки отпечатка и авторизации команда
 * ничего не записывает (Р20). Отказы здесь предметные и потому здесь, а не в схеме: ветвь считает
 * сервер по субъекту и назначенной машине, а границы даты — по сроку, прочитанному под
 * блокировкой (Р28, вторая граница).
 *
 * ДВА ОТКАЗА СТОЯТ ИМЕННО В РАСЧЁТЕ, а не в рукопожатии, и это решение плана (Р10, Р11):
 * замороженный выданным листом день линейного заказа и подписанный объектом день за границей факта
 * делают команду невозможной **целиком**. Операция терминальна — второй сверки у закрытой заявки не
 * будет (аннулирование листа дней не пересобирает), — поэтому человек обязан узнать об этом ещё на
 * предпросмотре, а не после подтверждения. Отказ поэтому один на оба входа, и в нём перечислены
 * дни: сценарий «аннулируйте лист и закройте заказ заново» работает ровно потому, что второй заход
 * считает план заново.
 */
export async function planCompletionCommand(
  ctx: AssignmentPlanContext,
  input: CompletionCommandInput,
  actor: Principal,
): Promise<AssignmentPlanned<CompletionPlan>> {
  const { tx, request, asOf } = ctx;
  // Архивная заявка этой дверью не открывается: закрывают живой заказ, а архивную сперва
  // восстанавливают своей ручкой (отступление Ц3 сделано для ремонта истории, а не для закрытия).
  if (request.deletedAt) throw err.notFound('Заявка не найдена');
  const status = request.status as RequestStatus;
  // Закрывают работающий заказ. Правило то же, что у статусной ручки (коридор переходов), и оно
  // обязано быть здесь: тело коридора не знает, а дверь считает по строке под блокировкой.
  if (status !== 'confirmed') {
    throw err.unprocessable(
      `Закрывают фактом заявку в статусе «${requestStatusLabels.confirmed}» — эта в статусе «${requestStatusLabels[status] ?? status}»`,
    );
  }

  const subject = await readCompletionSubject(tx, request.id);
  const branch = completionBranchOf(actor, subject.lessorId);
  const termBefore = request.term;
  const previousDateTo = lastDayOf(termBefore);

  /*
   * Фактическая дата: обязательна у обычного закрытия, запрещена у арендодательского (Р16, Р28).
   * Обе половины — отказ двери, а не схемы: схема одна на обе ветви, а ветвь считается здесь.
   */
  const endedOn =
    branch === 'paperlessLessorCompletion'
      ? assertNoActualEndDate(input.completion)
      : requireActualEndDate(input.completion, { termBefore, previousDateTo, asOf });

  /*
   * Срок двигается только сокращением. Закрытие ровно по концу срока колонку не трогает вовсе, и
   * это не мелочь: у однодневного заказа `date_to` пуст (эффективный конец — `date_from`), и запись
   * туда фактической даты переписала бы «однодневный срок» в «срок с равными краями» ни за чем.
   */
  const termAfter: AssignmentTerm =
    endedOn !== null && endedOn < previousDateTo
      ? { dateFrom: termBefore.dateFrom, dateTo: endedOn }
      : termBefore;

  /*
   * Факт — общим разбором, тем же, каким его считает статусная ручка. Снимок дат приходит сюда
   * посчитанным (пара или ни одной): у арендодательской ветви дат нет вовсе, у обычного закрытия
   * `previousDateTo` — **эффективный** конец срока, а не сырая колонка.
   */
  const fact = resolveCompletion(
    subject.assignment,
    input.completion,
    { id: actor.id, name: actor.fullName },
    { endedOn, previousDateTo: endedOn === null ? null : previousDateTo },
  );

  /*
   * Арендодательская ветвь: ни срока, ни бумаги, ни истории. Последствия у неё пусты **по
   * построению** — общий расчёт не зовётся вовсе (Р16), — и каркасу отдаётся честный пустой набор
   * эффектов: исход `none`, журнала нет, отпечатка не спрашивают (`requiresPreview`).
   */
  if (branch === 'paperlessLessorCompletion') {
    const effects = assignmentCommandEffects({
      changes: [],
      term: termBefore,
      asOf,
      mutations: [],
    });
    const draft = {
      branch,
      endedOn,
      previousDateTo,
      termBefore,
      termAfter,
      fact,
      shorten: null,
      shiftRange: null,
      clearedShiftDays: [],
      clearedShiftsFingerprint: null,
      linearDays: { detachable: [], frozen: [] } as LinearDaysPlan,
      // Долг подписей у этой ветви считается **по сегодняшнему дню**: фактической даты у неё нет, и
      // граница остаётся той же, какой её знает статусная ручка (Р24).
      shiftsPending: await pendingShiftDates(
        tx,
        request.id,
        termBefore,
        minKey(previousDateTo, asOf),
      ),
      linearFrozen: subject.linearFrozen,
      comment: input.comment,
    };
    const fingerprint = completionFingerprintOf(request.id, asOf, effects, draft);
    return { effects, fingerprint, plan: { ...draft, fingerprint } };
  }

  /*
   * Общий расчёт изменения срока (Р18) — всё, что зависит только от пары «прежний срок → новый»:
   * история, действующие листы, гасимые группы, эффекты, область и план бумаги, разблокировки.
   *
   * Исход самой команды над сроком приносится **внешним эффектом**: строки истории у закрытия нет
   * вовсе (календарь двигает колонка заявки), и вывести его из мутаций нечем. Граница та же, что у
   * двери срока и у `backdateGuard`: «сегодня и вперёд» — обычная работа, раньше — операция с
   * причиной, правом и глубиной (Р8). Своих предикатов заднего числа у закрытия нет.
   */
  const movedDate = movedRequestDateKey(
    { dateFrom: termBefore.dateFrom, dateTo: termBefore.dateTo },
    { dateTo: termAfter.dateTo },
  );
  const external: AssignmentExternalEffect | null =
    movedDate === null
      ? null
      : { effectiveDate: movedDate, outcome: movedDate < asOf ? 'crew' : 'none' };

  /*
   * Субъект допустимости дней (Р11, Р27) — и статус в нём остаётся **прежним**. Подставь сюда
   * будущий `done`, и общий запрет `linearDaysBlocker` обрёк бы все дни заказа разом, включая
   * отработанные, — то есть решение В10 отменило бы само себя. Политика названа отдельным флагом,
   * который видно в вызове: дни внутри факта остаются в рейсах.
   */
  const linear = await loadLinearRequest(tx, request.id);
  const eligibilitySubject: LinearDaySubject = {
    requestType: subject.requestType,
    isLinear: linear?.isLinear ?? false,
    status: 'confirmed',
    deletedAt: null,
    dateFrom: termAfter.dateFrom,
    dateTo: termAfter.dateTo,
    ownership: subject.ownership,
  };

  const shorten = await shortenTermPlan(tx, {
    requestId: request.id,
    asOf,
    termBefore,
    termAfter,
    external,
    linearDays: { eligibilitySubject, retainCompletedDays: true },
  });
  const { effects } = shorten;

  /*
   * Замороженный выданным листом день — отказ, и отказ **до первой записи** (Р11, В5). У соседних
   * дверей он мягче: правка срока предупреждает событием аудита, досрочное завершение тоже —
   * заявка живёт дальше, и следующее действие по ней сверку повторит. У закрытия следующего
   * действия нет: заказ уходит в «Выполнена», а аннулирование листа дней не пересобирает
   * (`syncLinearRouteDays` после него никто не зовёт).
   */
  if (shorten.linearDays.frozen.length > 0) {
    const days = shorten.linearDays.frozen.map(linearDayRefOf);
    throw err.unprocessable(
      `Дни заказа после ${dateKeyRu(endedOn!)} стоят в рейсах с выписанными листами (${days
        .map((day) => `${dateKeyRu(day.date)} — ${day.routeNumber}`)
        .join(
          '; ',
        )}): аннулируйте лист рейса и закройте заказ заново — после закрытия снять эти дни будет нечем`,
      { endedOn: 'День в замороженном рейсе' },
      {
        linearDays: { detachable: shorten.linearDays.detachable.map(linearDayRefOf), frozen: days },
      },
    );
  }

  /*
   * Смены за границей факта (Р10). Читается **вся** заявка одним запросом, а диапазон отбирается уже
   * над прочитанным: второе чтение тех же строк ради второго вопроса дало бы две картины состояния
   * внутри одной транзакции. Диапазон считает контракт (`shiftRangeAfterActualEnd`) — окно обязано
   * назвать те же дни, что снимет сервер.
   */
  const shiftRange = shiftRangeAfterActualEnd(
    { dateFrom: termBefore.dateFrom, dateTo: termBefore.dateTo },
    endedOn!,
  );
  const shiftDays = await readShiftDays(tx, request.id);
  const split = splitShiftDaysByRange(shiftDays, shiftRange);
  if (split.blockedShiftDays.length > 0) {
    throw err.unprocessable(
      `За днями после ${dateKeyRu(endedOn!)} стоит подпись объекта (${split.blockedShiftDays
        .map((day) => dateKeyRu(day.date))
        .join(
          ', ',
        )}): подпись снимает только коррекция — снимите её и закройте заказ заново либо закройте его позднейшей датой`,
      { endedOn: 'Подписанные дни за границей факта' },
      { blockedShiftDays: split.blockedShiftDays },
    );
  }

  const approved = new Set(shiftDays.filter((day) => day.approved).map((day) => day.date));
  const draft = {
    branch,
    endedOn,
    previousDateTo,
    termBefore,
    termAfter,
    fact,
    shorten,
    shiftRange,
    clearedShiftDays: split.clearedShiftDays,
    clearedShiftsFingerprint:
      split.clearedShiftDays.length > 0
        ? fingerprintOf({ clearedShiftDays: split.clearedShiftDays })
        : null,
    linearDays: shorten.linearDays,
    // Долг подписей — по **фактическому** периоду (Р24): дни за его границей к моменту записи уже
    // сняты, и «не расписались» про них сказать нечего. Строится из дней срока, а не из строк смен:
    // день, за который смену не заводили вовсе, подписи тоже не имеет.
    shiftsPending: shiftDaysOf({ dateFrom: termBefore.dateFrom, dateTo: endedOn }).filter(
      (day) => !approved.has(day),
    ),
    linearFrozen: subject.linearFrozen,
    comment: input.comment,
  };

  const fingerprint = completionFingerprintOf(request.id, asOf, effects, draft);
  return { effects, fingerprint, plan: { ...draft, fingerprint } };
}

/** Тело, каким его видит расчёт: у предпросмотра и боевого вызова семантическая часть общая (Л1). */
export interface CompletionCommandInput {
  completion: CompletionFactInput;
  comment: string;
}

// ── Ветвь, дата и факт ──

/**
 * Арендодательская ветвь (Р16, Р28) — по субъекту и назначенной машине, а не по принадлежности
 * техники.
 *
 * Предикат тот же, что проверяет `assertCounterpartyScope`: субъект **действует за**
 * `vehicle_lessor` и его контрагент совпадает с арендодателем назначенной машины. Выбери мы ветвь
 * по одному лишь `ownership === 'rental'` — администратор и диспетчер, закрывающие арендный заказ,
 * получили бы обход фактической даты, предпросмотра и права на бумагу: `assertLessorScope`
 * пропускает их без ограничений.
 */
export function completionBranchOf(actor: Principal, lessorId: string | null): CompletionBranch {
  const paperless =
    actsForCounterparty(actor, 'vehicle_lessor') && actor.counterpartyId === lessorId;
  return paperless ? 'paperlessLessorCompletion' : 'actualEndDate';
}

/**
 * Фактическая дата обычного закрытия: обязательна и в границах (Р2, Р15).
 *
 * Границы считает контракт (`completionEndBounds`) — портал и сервер обязаны отвечать одинаково,
 * как у `earlyEndDateBounds`. Отказов три, и каждый называет свою причину:
 *
 * - **срок ещё не начался** — закрывать нечего: техника на объект не выходила, а закрытие фактом
 *   записало бы в отчёт смены за дни, которых не было. Такую заявку отменяют, а не закрывают;
 * - **факт позже утверждённого срока** — это продление (Р15): на новые дни нужна бумага, а её
 *   выписка задним числом и есть коррекция. Дверь называет правильный вход;
 * - **факт в будущем** — закрывают состоявшееся, а не предстоящее.
 */
function requireActualEndDate(
  fact: CompletionFactInput,
  params: { termBefore: AssignmentTerm; previousDateTo: string; asOf: string },
): string {
  const { termBefore, previousDateTo, asOf } = params;
  const bounds = completionEndBounds(
    { requestType: 'special_equipment', dateFrom: termBefore.dateFrom, dateTo: termBefore.dateTo },
    asOf,
  );
  if (!bounds) {
    throw err.unprocessable(
      'Заказ ещё не начинался — техника на объект не выходила; отмените заявку, а не закрывайте её',
      { endedOn: 'Заказ не начинался' },
    );
  }
  const endedOn = fact.endedOn;
  if (!endedOn) {
    throw err.unprocessable(
      'Укажите фактическую дату окончания работ — ею и закрывают заказ, и по ней приводится бумага',
      { endedOn: 'Укажите фактическую дату' },
    );
  }
  if (endedOn < bounds.min) {
    throw err.unprocessable(
      `Фактическая дата раньше начала работ (${dateKeyRu(bounds.min)}) — до неё техники на объекте не было`,
      { endedOn: 'Раньше начала срока' },
    );
  }
  if (endedOn > previousDateTo) {
    throw err.unprocessable(
      `Работали дольше утверждённого срока (по ${dateKeyRu(previousDateTo)}) — это продление, а не закрытие: продлите срок, и на новые дни выпишется бумага`,
      { endedOn: 'Позже утверждённого срока' },
    );
  }
  if (endedOn > bounds.max) {
    throw err.unprocessable(
      'Фактическая дата в будущем: закрывают состоявшуюся работу, а не предстоящую',
      { endedOn: 'Дата в будущем' },
    );
  }
  return endedOn;
}

/**
 * У арендодателя даты не спрашивают — и присланную отвергают, а не игнорируют молча (Р16, Р28).
 *
 * Текст отказа называет **причину, а не поле**: «уберите лишнее поле» читается как поломка портала,
 * а «у вас её не спрашивают» объясняет, почему заказ закрывается плановым сроком.
 */
function assertNoActualEndDate(fact: CompletionFactInput): null {
  if (fact.endedOn !== undefined) {
    throw err.unprocessable(
      'Фактическую дату окончания у этой заявки не спрашивают: арендодатель закрывает заказ плановым сроком, а срок и бумагу приводит сторона заказчика — уберите дату и повторите',
      { endedOn: 'Дату не спрашивают' },
    );
  }
  return null;
}

// ── Рукопожатия (шаг 8) ──

/**
 * Что тело обязано подтвердить против **рассчитанного** плана (Р17, Р28).
 *
 * Общий отпечаток последствий сверяет каркас шагом 7 — по признаку `requiresPreview`, который эта
 * дверь объявляет ветвью. Здесь остаются только **дополнительные** отпечатки и envelope журнала, и
 * каждая проверка закрывает свой способ сделать не то, что человек видел. Лишнее подтверждение
 * отвергается симметрично отсутствующему: тело, знающее про гашение, которого нет, посчитано по
 * другому состоянию.
 *
 * Арендодательская ветвь отвергает **всё разом**, включая `previewFingerprint`: подтверждать ей
 * нечего — план пуст по построению, — а каркас на шаге 7 её отпечатка не смотрит вовсе
 * (`requiresPreview` отвечает `false`), и молча принятое поле означало бы, что портал показал
 * человеку предпросмотр, которого у этой ветви нет.
 */
export function assertCompletionHandshake(
  plan: CompletionPlan,
  input: CompletionApplyInput,
  /** Режим чтения: им решается, требовать ли рукопожатия по листам (Б4, §10). */
  mode: AssignmentModeSnapshot,
): void {
  if (plan.branch === 'paperlessLessorCompletion') {
    const extra =
      input.previewFingerprint ??
      input.cancelGroupsFingerprint ??
      input.unlockFingerprint ??
      input.clearedShiftsFingerprint ??
      input.operation;
    if (extra !== undefined) {
      throw err.unprocessable(
        'Арендодатель закрывает заказ без предпросмотра: срок, бумага и часы у этой ветви не меняются — подтверждать нечего. Уберите подтверждения и повторите',
        { previewFingerprint: 'Подтверждать нечего' },
      );
    }
    return;
  }

  const shorten = plan.shorten!;
  if (shorten.cancelGroupsFingerprint === null) {
    if (input.cancelGroupsFingerprint !== undefined) {
      throw err.unprocessable(
        'Это закрытие ничего не гасит в истории назначения — подтверждать нечего. Посмотрите последствия заново и повторите команду без подтверждения',
        { cancelGroupsFingerprint: 'Лишнее подтверждение' },
      );
    }
  } else if (input.cancelGroupsFingerprint !== shorten.cancelGroupsFingerprint) {
    throw err.unprocessable(
      `Закрытие фактической датой гасит решения о технике и машинисте, стоявшие за фактическим концом срока (${shorten.cancelGroups
        .map((group) => dateKeyRu(group.rows[0]!.effectiveDate))
        .join(
          ', ',
        )}): решение уходит целиком — вместе с машиной снимается и назначенный на неё машинист. Подтвердите перечень — он показан в предпросмотре`,
      { cancelGroupsFingerprint: 'Нужно подтверждение' },
      { cancelGroups: shorten.cancelGroupsPreview },
    );
  }

  if (shorten.unlockFingerprint === null) {
    if (input.unlockFingerprint !== undefined) {
      throw err.unprocessable(
        'Это закрытие прошлого не трогает — подтверждать разблокировку отработанных листов нечем',
        { unlockFingerprint: 'Лишнее подтверждение' },
      );
    }
  } else if (input.unlockFingerprint !== shorten.unlockFingerprint) {
    throw err.unprocessable(
      'Список отработанных листов, которые переоформит операция, изменился — посмотрите последствия заново',
      { unlockFingerprint: 'Подтверждение не совпало' },
      { requiredUnlocks: shorten.requiredUnlocks },
    );
  }

  /*
   * Рукопожатия по листам (Б4). Требуются там, где бумагу выпускает этот план: в `legacy` её
   * переписывает недельная сверка, у которой просителя нет вовсе (ADR 0064). Присланное
   * подтверждение проверяется в обоих режимах — принять и молча не посмотреть хуже, чем не
   * спрашивать.
   */
  assertAssignmentIssueAcknowledgements({
    issues: shorten.issues,
    acknowledgements: input.acknowledgements,
    required: paperFollowsHistory(mode),
  });

  if (plan.clearedShiftsFingerprint === null) {
    if (input.clearedShiftsFingerprint !== undefined) {
      throw err.unprocessable(
        'За фактической датой у этого заказа нет заполненных часов — снимать нечего, и подтверждать тоже',
        { clearedShiftsFingerprint: 'Лишнее подтверждение' },
      );
    }
  } else if (input.clearedShiftsFingerprint !== plan.clearedShiftsFingerprint) {
    throw err.unprocessable(
      `Закрытие удалит часы за днями после фактической даты (${plan.clearedShiftDays
        .map((day) => dateKeyRu(day.date))
        .join(', ')}): подтвердите перечень — он показан в предпросмотре`,
      { clearedShiftsFingerprint: 'Нужно подтверждение' },
      { clearedShiftDays: plan.clearedShiftDays },
    );
  }

  /*
   * Envelope журнала — **целиком**, а не по половинкам (Р28): внутри присутствующего envelope и
   * ключ, и причина обязательны уже схемой, и половинчатый до двери не доживает. Здесь решается
   * другой вопрос — нужен ли он вообще. Лишний каркас терпит намеренно (у него envelope приезжает
   * от честного клиента, которому предпросмотр показал `crew` секунду назад), но у закрытия он
   * означает другое: человек подтверждает операцию журнала, которой не будет, — то есть смотрел на
   * другое состояние заявки. Отсутствующий каркас поймал бы и сам, на шаге 10; отказ здесь стоит
   * ради одинаковых слов у обеих половин правила.
   */
  const needsOperation = plan.shorten!.effects.needsOperation;
  if (needsOperation && !input.operation) {
    throw err.unprocessable(
      'Это закрытие задевает прошлое или гасит решения истории — укажите причину и ключ операции',
      { operation: 'Требуется причина операции' },
    );
  }
  if (!needsOperation && input.operation) {
    throw err.unprocessable(
      'Это закрытие — обычная работа: объяснять его операцией журнала нечем. Посмотрите последствия заново и повторите команду без причины',
      { operation: 'Лишняя причина операции' },
    );
  }
}

// ── Отпечаток предпросмотра (Р17) ──

/**
 * Отпечаток последствий: **содержание**, а не идентификаторы (Р20).
 *
 * Измерений у закрытия пять, и все пять входят сюда, потому что каркас сверяет отпечаток ровно один
 * раз (шаг 7): бумажный план вместе с правками периода, перечень гасимых групп, множество
 * разблокировок, снимаемые часы и **план линейных дней вместе с версиями рейсов**. Последнее — не
 * перестраховка: версия заявки от параллельной правки **рейса** не защищает вовсе, она растёт у
 * заявки, а трогают рейс.
 *
 * Ветвь входит в отпечаток отдельным полем: у арендодательской его не спрашивают, но посчитанный
 * по одному и тому же заказу отпечаток обеих ветвей обязан различаться — иначе подтверждение,
 * снятое одной, годилось бы другой.
 */
function completionFingerprintOf(
  requestId: string,
  asOf: string,
  effects: AssignmentEffects,
  plan: Omit<CompletionPlan, 'fingerprint'>,
): string {
  const shorten = plan.shorten;
  return fingerprintOf({
    door: DOOR,
    requestId,
    asOf,
    command: {
      branch: plan.branch,
      endedOn: plan.endedOn,
      dateFrom: plan.termAfter.dateFrom,
      dateTo: plan.termAfter.dateTo,
      workedUnit: plan.fact.workedUnit,
      workedAmount: plan.fact.workedAmount,
      totalCost: plan.fact.totalCost,
    },
    outcome: effects.operationOutcome,
    effects: {
      ...effects.payload,
      mutations: effects.payload.mutations.map(({ changeId: _id, ...rest }) => rest),
    },
    termDiff: shorten?.termDiff ?? [],
    cancelGroups: cancelGroupsShape(shorten?.cancelGroups ?? []),
    requiredUnlockIds: [...(shorten?.requiredUnlockIds ?? [])],
    plan: {
      cancel: (shorten?.preview.cancel ?? []).map((sheet) => sheet.waybillId).sort(),
      issue: (shorten?.preview.issue ?? []).map(
        (i) => `${i.from}|${i.to}|${i.vehicleId}|${i.driverPersonId}`,
      ),
      // Правки периода — третьим ключом: у плана, который лист сокращает, обе половины выше пусты
      // (номер не горит и новый не выписывается), и два плана, различающиеся только правками, дали
      // бы один отпечаток.
      trim: (shorten?.sheetPlan.trim ?? []).map((item) => `${item.waybillId}|${item.to}`).sort(),
    },
    clearedShiftDays: plan.clearedShiftDays,
    // Дни линейного заказа — пятое измерение (Р17): вместе с версиями рейсов, потому что
    // подтверждают изменение чужой строки, версия которой в заявке не отражается.
    linearDays: plan.linearDays.detachable.map(
      (item) => `${item.date}|${item.routeId}|${item.routeVersion}`,
    ),
  });
}

// ── Спецификация команды для каркаса (§8) ──

/**
 * Спецификация закрытия для `runAssignmentCommand` — **один** источник на боевую ручку и на тесты
 * двери. Собрана здесь, а не в роут-модуле, по той же причине, по какой предпросмотр зовёт тот же
 * колбэк `plan`: место, где предметные места канона заполняются, должно быть одно.
 */
export function completionCommandSpec(params: {
  requestId: string;
  actor: Principal;
  input: CompletionApplyInput;
  asOf: string;
}): AssignmentCommandSpec<CompletionPlan, CompletionApplied, CompletionPaper> {
  const { requestId, actor, input, asOf } = params;
  return {
    // Класс двери — `history` (§10): закрытие читает историю ради бумаги, а с гашением ещё и пишет
    // её. При откате модуля она закрыта первой, как и остальные двери истории.
    door: 'history',
    journalDoor: DOOR,
    requestId,
    actor: { id: actor.id },
    expectedVersion: input.version,
    body: input,
    operation: input.operation ?? null,
    previewFingerprint: input.previewFingerprint,
    /*
     * Предпросмотр обязателен у **любого** закрытия, кроме арендодательского (Р17). Признак,
     * считающий непустоту последствий, пропустил бы ровно тот случай, ради которого правило и
     * написано: заказ, закрываемый ровно своим `date_to`, где пусты все пять измерений, — а
     * человек последствия смотрел и мог смотреть вчерашние.
     */
    requiresPreview: (planned) => planned.plan.branch !== 'paperlessLessorCompletion',
    asOf,
    plan: (ctx) => planCompletionCommand(ctx, input, actor),
    handshake: (ctx) => assertCompletionHandshake(ctx.plan, input, ctx.mode),
    authorize: (ctx) => authorizeCompletionCommand(actor, ctx),
    /*
     * Повтор (Р9 п. 4) выходит на шаге 2 — мимо `plan` и мимо `authorize`, — поэтому право на
     * бумагу спрашивается здесь **безусловно** и своей проверкой (Р22). Ветвь на повторе не
     * считается вовсе: строка операции существует только у неарендодательского закрытия — у
     * арендодательской ветви исход `none`, журнала нет, и повтор по ключу сюда не доходит по
     * построению.
     */
    authorizeRepeat: (scope) => {
      assertCompletionPaperAccess(actor, 'actualEndDate');
      authorizeCrewRepeat(actor, scope);
    },
    mutate: (ctx) => applyCompletion(ctx, actor),
    syncPaper: (ctx) => syncCompletionPaper(ctx, actor, input.acknowledgements),
    payload: (ctx) => ({
      door: DOOR,
      branch: ctx.plan.branch,
      endedOn: ctx.plan.endedOn,
      previousDateTo: ctx.plan.previousDateTo,
      period: { before: ctx.plan.termBefore, after: ctx.plan.termAfter },
      requiredUnlockIds: (ctx.plan.shorten?.requiredUnlocks ?? []).map((u) => u.waybillId),
      cancelledGroups: ctx.write.cancelledGroups,
      history: historySnapshotOf(ctx.write),
      clearedShiftDays: ctx.applied.clearedShiftDates,
      esm2: ctx.paper.esm2,
      linearDays: ctx.paper.detached,
    }),
    audit: (ctx) => completionAuditOf(ctx),
  };
}

/**
 * Шаг 9 — условная авторизация (Р22).
 *
 * Порядок двух половин значим: сперва «можно ли смотреть бумагу» (`waybills.read`), потом «можно ли
 * править прошлое» (`waybills.correct` по посчитанному исходу). Обратный порядок отвечал бы
 * закрывающему, что ему не хватает права коррекции, — тому, у кого и на журнал листов права нет.
 *
 * Коррекционная половина — общая с дверью машиниста (`authorizeCrewCommand`), и второй её редакции
 * здесь нет намеренно: правило «`crew` требует `waybills.correct`, глубже тридцати дней —
 * `correctBeyondLimit`» одно на все двери истории.
 */
function authorizeCompletionCommand(
  actor: Principal,
  ctx: AssignmentAuthorizeContext<CompletionPlan>,
): WaybillCorrectionAuthorizationScope {
  assertCompletionPaperAccess(actor, ctx.plan.branch);
  return authorizeCrewCommand(actor, ctx.effects, ctx.asOf);
}

/**
 * Право на бумагу — условное, и спрашивает его **дверь**, а не страж маршрута (Р22).
 *
 * В реестре доступа это `effectConditionalPermissions`: страж получает только базовую половину
 * (`vehicleRequests.status`), а `waybills.read` добавляется по **эффекту** — «ветвь команды не
 * `paperlessLessorCompletion`». Иначе никак: ветвь считается под блокировкой, из тела её не видно,
 * а объявленное на маршруте право закрыло бы арендодателю его собственный коридор — права на листы
 * у него нет и не будет.
 *
 * Мест ровно три, и все три обязательны: предпросмотр (там номера бланков), боевая авторизация и
 * повтор по ключу — последний выходит на шаге 2 и до `authorize` не доходит.
 */
export function assertCompletionPaperAccess(actor: Principal, branch: CompletionBranch): void {
  if (branch === 'paperlessLessorCompletion') return;
  assertCan(
    actor,
    'waybills.read',
    'Закрытие фактической датой переоформляет путевые листы — для него нужен доступ к журналу бланков',
  );
}

// ── Шаг 11: предметные мутации ──

/**
 * Порядок внутри шага 11 значим целиком, и каждый переход обоснован (Р18, Р24):
 *
 * 1. **материализация истории** — по **прежнему** сроку: расчёт шага 5 видел именно его, и цель
 *    гашения адресована строке, которую вписывает как раз этот вызов. Зови мы его после записи
 *    срока, бэкфилл восстановил бы историю по новому сроку — другую;
 * 2. **гашение групп** — по разрешённым целям, ядром записи и одной мутацией на группу: оставленная
 *    за фактическим концом vehicle-строка ожила бы при следующем продлении после отката — без
 *    решения о ставках и занятости;
 * 3. **новый срок** — после истории: `afterWorkPeriodChanged` шага 12 читает заявку из базы, и срок
 *    к его вызову обязан быть уже записан;
 * 4. **статус и строка истории статусов** — «Выполнена» пишется здесь, а не сменой статуса снаружи:
 *    заявка не должна побыть закрытой без факта или закрытой с прежним сроком даже мгновение;
 * 5. **факт со снимком дат** — после статуса, как и у статусной ручки;
 * 6. **снятие часов за границей факта** — последним из записей по заявке (Р10): удалять их до
 *    отказов шагов 7–9 значило бы стирать работу, которую команда сейчас отвергнет;
 * 7. **пересчёт готовности истории** — дверь, изменившая область валидности, обязана пересчитать
 *    блокеры.
 *
 * Отцепление рейсов и снятие заморозки режима сюда не входят намеренно: они стоят шагом 12, после
 * бумаги, — и заморозка последней из всего (Р24).
 */
async function applyCompletion(
  ctx: AssignmentApplyContext<CompletionPlan>,
  actor: Principal,
): Promise<{ write: AssignmentWriteResult; applied: CompletionApplied }> {
  const { tx, plan, request } = ctx;
  const shorten = plan.shorten;

  if (shorten?.historyPresent) {
    await ensureCommandHistory(tx, { requestId: request.id, asOf: ctx.asOf });
  }
  const write = await applyAssignmentMutations(tx, {
    requestId: request.id,
    actorUserId: actor.id,
    // Строки гаснут операцией журнала: «почему субботняя машина вдруг снята» отвечается ею.
    correctionId: ctx.operation?.id ?? null,
    mutations: (shorten?.cancelGroups ?? []).map((group) => group.target),
    /*
     * Обещание по денормализации (Р17 плана периодов) — двери, а не расчёта. Гашения нет — `keep`:
     * закрытие назначения не касается. Гашение есть — `tail_release`: назначение и ставки не
     * тронуты, а хвост истории **законно** разошёлся с ним, потому что граница снята.
     */
    denormalization: ((shorten?.cancelGroups.length ?? 0) > 0
      ? { kind: 'tail_release' }
      : { kind: 'keep' }) as AssignmentDenormalizationIntent,
  });

  if (plan.termAfter.dateTo !== plan.termBefore.dateTo) {
    await tx
      .update(specialEquipmentRequestDetails)
      .set({ dateTo: plan.termAfter.dateTo })
      .where(eq(specialEquipmentRequestDetails.requestId, request.id));
  }

  /*
   * Статус — без версии: её поднимает шаг 14 каркаса, и второй инкремент дал бы `N → N+2` либо
   * конфликт на CAS. `updatedBy`/`updatedAt` там же, поэтому здесь только сама колонка.
   */
  await tx
    .update(vehicleRequests)
    .set({ status: 'done' })
    .where(eq(vehicleRequests.id, request.id));
  await tx.insert(vehicleRequestStatusHistory).values({
    vehicleRequestId: request.id,
    // Каркас читает статус строкой (ему он безразличен), а колонка объявлена перечислением. Оба
    // перечня — один и тот же тип базы, и разойтись им негде: приведение здесь единственное.
    fromStatus: request.status as RequestStatus,
    toStatus: 'done',
    changedBy: actor.id,
    comment: ctx.plan.comment,
  });

  const factBefore = await readCompletionRow(tx, request.id);
  await saveCompletion(tx, request.id, plan.fact);

  /*
   * Часы за границей факта. Исполнитель удаляет только неподписанные строки — подписанные
   * запрещены и ему, и двери (Р10), — а вернувшийся перечень сверяется с показанным человеку:
   * расхождение означает, что состояние между предпросмотром и командой изменилось, и молчаливого
   * «удалили не то» не остаётся.
   */
  let clearedShiftDates: string[] = [];
  if (plan.shiftRange && plan.clearedShiftDays.length > 0) {
    clearedShiftDates = await dropUnapprovedShiftsInRange(tx, {
      requestId: request.id,
      range: plan.shiftRange,
    });
    const promised = plan.clearedShiftDays.map((day) => day.date).sort();
    if (clearedShiftDates.join('|') !== promised.join('|')) {
      throw err.conflict(
        'Состав заполненных часов за фактической датой изменился, пока считался план, — посмотрите последствия заново',
        { code: 'assignment_preview_stale' },
      );
    }
  }

  if (shorten?.historyPresent) {
    await ensureAssignmentHistory(tx, { requestId: request.id, asOf: ctx.asOf });
  }
  return { write, applied: { write, factBefore, fact: plan.fact, clearedShiftDates } };
}

// ── Шаг 12: бумага, рейсы и заморозка ──

/**
 * Шаг 12 по порядку Р1: бумага → дни линейного заказа → **снятие заморозки режима последним**.
 *
 * Порядок заморозки — не деталь (Р24). Заявка дорабатывала по снимку режима, и уход из «В работе»
 * возвращает её справочнику; сними снимок раньше — обе сверки посчитали бы по режиму, в котором
 * заявка не работала, и крайняя неделя ЭСМ-2 не выписалась бы вовсе.
 *
 * Бумагу ведёт **общий сервис последствий срока** (`afterWorkPeriodChanged`) — тот же, которым
 * пользуются широкая правка, дверь срока и досрочное завершение: снятый запрос на отъезд, бэкстоп
 * и сверка листов стоят там в одном порядке, и вторая их редакция разошлась бы с первой при первой
 * же правке правила. Дни он не сверяет — их считает и снимает сама дверь (см. ниже).
 *
 * Арендодательская ветвь сюда доходит с пустыми руками: срока она не двигала, бумаги у неё нет.
 * Своего у неё ровно две работы — снятый запрос на отъезд (иначе он висел бы на закрытой заявке и
 * считался в сводке среза) и заморозка; обе она делает наравне с прочими (Р16).
 */
async function syncCompletionPaper(
  ctx: AssignmentPaperContext<CompletionPlan, CompletionApplied>,
  actor: Principal,
  /** Рукопожатия, принятые шагом 8: ими лист помнит, под чем его подписали (Р21). */
  acknowledgements?: Readonly<Record<string, string>> | undefined,
): Promise<CompletionPaper> {
  const { tx, plan, request } = ctx;

  if (plan.branch === 'paperlessLessorCompletion') {
    const earlyEndDropped = await clearPendingEarlyEnd(tx, request.id);
    await unfreezeLinearMode(tx, request.id, plan.linearFrozen);
    return { earlyEndDropped, esm2: { cancelled: [], issued: [], trimmed: [] }, detached: [] };
  }

  const shorten = plan.shorten!;
  const correctionId = ctx.operation?.id ?? null;
  const unlockWaybillIds = shorten.requiredUnlocks.map((u) => u.waybillId);
  /*
   * Бэкстоп чужой двери — своим именем и до бумаги. Считается по уже записанному сроку: пробелы
   * машиниста относятся к дням, которые команда задевает, а новых дней закрытие не открывает
   * (`opensTerm: false`) — спрашивать у него решение по хвосту нельзя, гашение хвостовой группы
   * само создаёт то расхождение, о котором его тут же и спросят.
   */
  await assertAssignmentBackstop(tx, {
    door: 'completion',
    requestId: request.id,
    actor: { id: actor.id },
    asOf: ctx.asOf,
    reason: COMPLETION_SYNC_REASON,
    opensTerm: false,
  });
  const result = await afterWorkPeriodChanged(tx, {
    requestId: request.id,
    actor: { id: actor.id },
    reason: COMPLETION_SYNC_REASON,
    // Снятие запроса на отъезд молчаливое, как у широкой правки: закрывает один заказ один человек,
    // глядя на него. Своё событие ему пишет шаг 13.
    dropPendingEarlyEnd: true,
    backstop: 'checked_by_caller',
    opensTerm: false,
    /*
     * Дни линейного заказа — **готовым планом**, а не сверкой: сверка читает заявку из базы, а
     * заявка к этому моменту уже «Выполнена», и общий запрет обрёк бы все дни заказа разом,
     * включая отработанные, — то есть вернул бы поведение, которое волна отменяет (Р27). План
     * посчитан до смены статуса, по укороченному сроку и с прежним статусом в субъекте
     * допустимости; заморозку исполнитель всё равно перечитает из-под блокировки рейса.
     */
    days: { kind: 'plan' as const, plan: plan.linearDays.detachable },
    ...(shorten.effects.needsCorrection && correctionId
      ? { correction: { id: correctionId, unlockWaybillIds } }
      : {}),
    ...(paperFollowsHistory(ctx.mode)
      ? {
          paper: {
            kind: 'plan' as const,
            ...assignmentPaperExecution({
              requestId: request.id,
              actor: { id: actor.id },
              reason: COMPLETION_SYNC_REASON,
              mode: ctx.mode,
              effects: shorten.effects,
              operationId: correctionId,
              sheetPlan: shorten.sheetPlan,
              paperScope: shorten.paperScope,
              sheets: shorten.sheets,
              displayNumbers: shorten.sheetNumbers,
              unlockWaybillIds,
              // Снимок бланка и предупреждения — посчитанные шагом 6 и подтверждённые человеком.
              issues: shorten.issuePreparations,
              acknowledgements,
            }),
          },
        }
      : {}),
  });

  /*
   * Замороженных дней в исполненном плане быть не должно: расчёт отказал бы командой целиком. Но
   * исполнитель перечитывает заморозку из-под блокировки рейса, и между предпросмотром и командой
   * лист успевают выписать. Появившийся `frozen` — отказ, а не предупреждение: команда терминальна,
   * и второй сверки у закрытой заявки не будет (аннулирование листа дней не пересобирает).
   */
  const days = result.days;
  if (days.frozen.length > 0) {
    throw err.unprocessable(
      `По рейсам дней ${days.frozen
        .map((day) => `${dateKeyRu(day.date)} — ${day.routeNumber}`)
        .join(
          '; ',
        )} выписан путевой лист — их только что заняли бумагой: аннулируйте лист и закройте заказ заново`,
      { endedOn: 'День в замороженном рейсе' },
    );
  }
  await unfreezeLinearMode(tx, request.id, plan.linearFrozen);
  return { earlyEndDropped: result.earlyEndDropped, esm2: result.esm2, detached: days.detached };
}

/**
 * Снятие заморозки режима (миграция 0137) — хвост шага 12 и последняя запись команды.
 *
 * Условие — про уход из работы, а не про мягкое удаление: архивная заявка остаётся «В работе», и
 * восстановление обязано вернуть её ровно такой, какой её спрятали.
 */
async function unfreezeLinearMode(
  tx: AssignmentCommandTx,
  requestId: string,
  frozen: boolean,
): Promise<void> {
  if (!frozen) return;
  await tx
    .update(vehicleRequests)
    .set({ isLinearFrozen: null, linearFrozenAt: null })
    .where(and(eq(vehicleRequests.id, requestId), isNotNull(vehicleRequests.isLinearFrozen)));
}

// ── Шаг 13: снимок операции и события ──

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
 * События ленты — **данными**: пишет их каркас и в транзакции (шаг 13).
 *
 * Перечень и имена — паритет со статусной ручкой (Р24), и каждое имя здесь контракт:
 *
 * - `vehicle_request.status` — сам переход. По нему история заявки собирает запись «Выполнена», а
 *   закрывающее событие среди прочих ищут по `metadata.to === 'done'`;
 * - `vehicle_request.complete` — **не** `.completion`: по этому имени карточка собирает вид записи,
 *   и переименование при переносе двери потеряло бы закрытие из истории, ничего не сломав. Долг
 *   подписей едет тем же событием: спорят о машиночасах через два месяца, и история обязана
 *   помнить, что подписи не было;
 * - `vehicle_request.early_end_cancel` — снятый запрос на отъезд своим событием, а не строкой
 *   внутри перехода: иначе по истории не понять, чем кончился запрос;
 * - `vehicle_request.days_sync` — линейная сверка отдельным событием и **только когда она что-то
 *   изменила**: у нелинейного закрытия записи в журнале не появляется вовсе.
 */
function completionAuditOf(
  ctx: AssignmentAuditContext<CompletionPlan, CompletionApplied, CompletionPaper>,
): AuditEntry[] {
  const { plan, applied, paper } = ctx;
  const entries: AuditEntry[] = [
    {
      action: 'vehicle_request.status',
      metadata: {
        from: ctx.request.status,
        to: 'done',
        comment: plan.comment,
        door: DOOR,
        branch: plan.branch,
        outcome: ctx.effects.operationOutcome,
        operationId: ctx.operation?.operationId ?? null,
        ...(ctx.operation ? { backdated: true, backdateReason: ctx.operation.reason } : {}),
        ...(ctx.write.cancelledGroups.length > 0
          ? { cancelledGroups: ctx.write.cancelledGroups }
          : {}),
        ...(paper.esm2.issued.length > 0 ? { esm2Issued: paper.esm2.issued } : {}),
        ...(paper.esm2.cancelled.length > 0 ? { esm2Cancelled: paper.esm2.cancelled } : {}),
      },
    },
    {
      action: 'vehicle_request.complete',
      metadata: {
        changes: [
          ...diffVehicleCompletion(applied.factBefore, applied.fact),
          /*
           * Дни без подписи — общим оформителем (`shiftsPendingChange`), а не своей строкой:
           * закрывающих дверей две, и разойдись у них формат — одно и то же событие выглядело бы
           * в истории по-разному в зависимости от того, каким окном закрыли заказ.
           */
          ...shiftsPendingChange(plan.shiftsPending),
        ],
      },
    },
  ];
  if (paper.earlyEndDropped) {
    entries.push({
      action: 'vehicle_request.early_end_cancel',
      metadata: {
        reason: 'closed',
        changes: earlyEndReasonChange(`Заявка переведена в «${requestStatusLabels.done}»`),
      },
    });
  }
  /*
   * Причина у линейной сверки — `status:<статус>`, та же, какой её знает статусная ручка: событие
   * читают глазами, и «closed» рядом со «status:done» у соседних заявок читалось бы как другая
   * работа. Пустая сверка события не пишет вовсе — молчаливая сверка событием не является.
   */
  if (paper.detached.length > 0) {
    entries.push({
      action: 'vehicle_request.days_sync',
      metadata: {
        reason: 'status:done',
        detached: paper.detached.map((day) => `${day.date} (${day.routeNumber})`),
        frozen: [],
      },
    });
  }
  return entries;
}

// ── Предпросмотр (§7) ──

/**
 * Ответ предпросмотра: общий `AssignmentPreviewDto` плюс то, что есть только у этой двери.
 *
 * Три поля приходят пустыми, и это правда, а не заглушка. `requiredAnchors` и
 * `requiredVehicleResolution` — якорей дверь не принимает вовсе, а неполную историю называет
 * бэкстоп своим отказом и своими словами. `blockedShiftDays` и `linearDays.frozen` — потому что
 * непустыми они до этого места не доживают: команда с подписанным днём за границей факта или с
 * замороженным днём отвергается целиком **в расчёте**, и человек читает перечень в тексте отказа,
 * а не в успешном ответе (Р10, Р11). Поля остаются формой ответа: они же — измерения отпечатка, и
 * ветвь, которая когда-нибудь научится их показывать, не будет менять контракт.
 */
export function completionPreviewDto(
  effects: AssignmentEffects,
  plan: CompletionPlan,
  fingerprint: string,
  asOf: string,
): CompletionPreviewDto {
  const shorten = plan.shorten;
  return {
    plan: shorten?.preview ?? { cancel: [], issue: [] },
    requiredAnchors: [],
    requiredVehicleResolution: null,
    blockedShiftDays: [],
    clearedShiftDays: plan.clearedShiftDays,
    clearedShiftsFingerprint: plan.clearedShiftsFingerprint,
    requiredUnlocks: shorten?.requiredUnlocks ?? [],
    unlockFingerprint: shorten?.unlockFingerprint ?? null,
    // Предупреждения по каждому выпускаемому листу — посчитанные вместе с планом (§7). Пусто у
    // заказа без бумаги: там и выписок нет.
    issues: shorten?.issues ?? [],
    operationRequirement: operationRequirementOf(effects),
    asOf,
    fingerprint,
    completion: {
      endedOn: plan.endedOn,
      previousDateTo: plan.previousDateTo,
      workedUnit: plan.fact.workedUnit,
      workedAmount: plan.fact.workedAmount,
      rate: plan.fact.rate,
      totalCost: plan.fact.totalCost,
    },
    cancelGroups: shorten?.cancelGroupsPreview ?? [],
    cancelGroupsFingerprint: shorten?.cancelGroupsFingerprint ?? null,
    linearDays: {
      detachable: plan.linearDays.detachable.map(linearDayRefOf),
      frozen: plan.linearDays.frozen.map(linearDayRefOf),
    },
  };
}

// ── Чтение, которого нет у общего расчёта ──

/**
 * Заявка глазами закрытия: назначенная машина со ставками, её принадлежность и арендодатель.
 *
 * Одним запросом и один раз: ставку берёт факт, арендодателя — предикат ветви (Р16), принадлежность
 * — и факт (аренда без суммы не закрывается), и субъект допустимости дней. Три отдельных чтения
 * тех же строк разошлись бы между собой внутри одной транзакции.
 */
interface CompletionSubject {
  requestType: 'special_equipment';
  /** Ставки и принадлежность назначенной машины; `null` — техники на заказе нет вовсе. */
  assignment: CompletionRates | null;
  ownership: VehicleOwnership | null;
  lessorId: string | null;
  /** Заморожен ли режим заявки снимком (миграция 0137): его снимает хвост шага 12. */
  linearFrozen: boolean;
}

async function readCompletionSubject(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<CompletionSubject> {
  const [row] = await tx
    .select({
      isLinearFrozen: vehicleRequests.isLinearFrozen,
      vehicleId: vehicleRequestAssignments.vehicleId,
      pricePerHour: vehicleRequestAssignments.pricePerHour,
      pricePerShift: vehicleRequestAssignments.pricePerShift,
      ownership: vehicles.ownership,
      lessorId: vehicles.lessorId,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  return {
    requestType: 'special_equipment',
    // «Назначения нет» — это отсутствие машины, а не отсутствие ставок: заявка, взятая в работу
    // своей техникой без цен, закрывается с прочерком в сумме и назначение при этом имеет.
    assignment:
      row.vehicleId && row.ownership
        ? {
            ownership: row.ownership,
            pricePerHour: numOrNull(row.pricePerHour),
            pricePerShift: numOrNull(row.pricePerShift),
          }
        : null,
    ownership: row.ownership,
    lessorId: row.lessorId,
    linearFrozen: row.isLinearFrozen !== null,
  };
}

/** Факт заявки, каким он записан сейчас: с ним и сравнивается «было → стало» в событии (Р23). */
async function readCompletionRow(
  tx: AssignmentCommandTx,
  requestId: string,
): Promise<VehicleRequestCompletionDto | null> {
  const [row] = await tx
    .select()
    .from(vehicleRequestCompletions)
    .where(eq(vehicleRequestCompletions.requestId, requestId));
  if (!row) return null;
  return {
    workedUnit: row.workedUnit as VehicleWorkUnit,
    workedAmount: Number(row.workedAmount),
    rate: numOrNull(row.rate),
    totalCost: numOrNull(row.totalCost),
    completedBy: row.completedBy,
    // Имя закрывшего событию не нужно: «было → стало» считается по отработанному и сумме, а
    // второй запрос за фамилией прежнего закрывшего стоил бы join ради поля, которое не сравнивают.
    completedByName: '',
    completedAt: row.completedAt.toISOString(),
    endedOn: row.endedOn,
    previousDateTo: row.previousDateTo,
  };
}

/**
 * Наступившие дни периода без подписи объекта — ими событие закрытия объясняет, что заказ закрыт
 * без приёмки (Р24).
 *
 * Читается таблица смен, а перечень строится из дней **периода**: день, за который смену не
 * заводили вовсе, подписи тоже не имеет, и молчание о нём было бы враньём в другую сторону.
 */
async function pendingShiftDates(
  tx: AssignmentCommandTx,
  requestId: string,
  term: AssignmentTerm,
  until: string,
): Promise<string[]> {
  // Граница раньше начала срока — наступивших дней нет вовсе: заказ, закрываемый в день начала
  // или раньше, никому не задолжал подписи.
  if (until < term.dateFrom) return [];
  const days = await readShiftDays(tx, requestId);
  const approved = new Set(days.filter((day) => day.approved).map((day) => day.date));
  return shiftDaysOf({ dateFrom: term.dateFrom, dateTo: until }).filter(
    (day) => !approved.has(day),
  );
}

/** Меньшая из двух календарных дат — сравнением ключей, как их сравнивает весь портал. */
function minKey(a: string, b: string): string {
  return a < b ? a : b;
}

/** `numeric` приезжает строкой: у ставок и сумм это единственный способ не потерять копейки. */
function numOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** День расчёта — сегодня по МСК; тем же поясом границы считает портал (Р2). */
export function completionAsOf(): string {
  return moscowDateKeyOf(new Date());
}
