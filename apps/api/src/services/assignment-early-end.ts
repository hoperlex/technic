import { and, eq } from 'drizzle-orm';
import {
  earlyEndBlocker,
  earlyEndDateBounds,
  earlyEndDaysSaved,
  isAllowedEarlyEndDate,
  moscowDateKeyOf,
  movedRequestDateKey,
  type EarlyEndApprovalPreviewDto,
  type LinearDaySubject,
  type OperationRequirement,
  type RequestChangeDto,
  type RequestStatus,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import type { AuditEntry } from '../lib/audit';
import { AppError, err } from '../lib/errors';
import { specialEquipmentRequestDetails, vehicleRequestEarlyEndings } from '../db/schema';
import type { db as AppDb } from '../db/client';
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
import type { AssignmentEffects, AssignmentExternalEffect } from './assignment-effects';
import { ensureAssignmentHistory, ensureCommandHistory } from './assignment-ensure';
import type { AssignmentTerm } from './assignment-history';
import {
  applyAssignmentMutations,
  type AssignmentChangeRecord,
  type AssignmentDenormalizationIntent,
  type AssignmentWriteResult,
} from './assignment-write';
// Право коррекции и отпечаток — общие с дверью машиниста: правило «`crew` требует
// `waybills.correct`» одно на все двери истории, и своя копия разошлась бы с ним молча.
import { authorizeCrewCommand, authorizeCrewRepeat, fingerprintOf } from './assignment-crew';
// Расчёт сокращения срока — общий на четыре применяющие ветви (Р18): гасимые группы, эффекты,
// бумага, разблокировки и план линейных дней. Две ветви из этих четырёх живут здесь.
import { cancelGroupsShape, lastDayOf, shortenTermPlan } from './assignment-shorten-term';
import type { ShortenTermPlan } from './assignment-shorten-term';
import { assertAssignmentBackstop } from './assignment-backstop';
import type { AssignmentModeSnapshot } from './assignment-mode';
// Шаг 12 у всех дверей истории один: режим решает, кто исполняет бумагу (§10, Р32). Рукопожатие по
// листам (Б4) спрашивается тем же общим правилом — своей редакции у этой двери быть не должно.
import {
  assertAssignmentIssueAcknowledgements,
  assignmentPaperExecution,
  paperFollowsHistory,
} from './assignment-paper';
import { afterWorkPeriodChanged } from './vehicle-request-period';
import {
  linearDayRefOf,
  linearDaysSyncAudit,
  loadLinearRequest,
  type LinearDayPlanItem,
  type LinearDaysPlan,
  type LinearDaysSyncResult,
} from './vehicle-request-days';
import { diffVehicleEarlyEnd } from './vehicle-request-diff';
import { changeSet, dateKeyRu } from './request-diff';
import type { Esm2SyncResult } from './waybill-esm2';

/**
 * Досрочное завершение заказа спецтехники — **две применяющие ветви одной двери**
 * (`docs/vehicle-request-actual-end-date-plan.md`, Р19, Р26, Р28; ADR 0044).
 *
 * ЗАЧЕМ ЭТОТ МОДУЛЬ ПОЯВИЛСЯ. Обе применяющие ветви — запрос визирующего (`auto`) и виза по чужому
 * запросу — звали `syncEsm2Waybills` **напрямую**, то есть всегда недельную сверку, независимо от
 * режима чтения (§10). Пока это так, правка листа вместо перевыпуска (`trim`) в режиме `history` в
 * досрочное завершение не попадёт никогда, а решение В7 «правило `trim` — общее на все входы
 * сокращения» останется невыполненным. Перевод обеих ветвей на общий расчёт (`shortenTermPlan`) и
 * общий исполнитель последствий (`afterWorkPeriodChanged`) и есть предмет этого файла.
 *
 * ВЕТВЕЙ НА САМОМ ДЕЛЕ ТРИ, И СРОК ПРИМЕНЯЮТ ДВЕ (Р19):
 *
 * | ветвь                                   | что делает со сроком                 | где живёт           |
 * | --------------------------------------- | ------------------------------------- | ------------------- |
 * | запрос **без** визы (`auto = false`)    | ничего: заводит `pending`             | маршрут, вне канона |
 * | запрос визирующего (`auto = true`)      | применяет немедленно                  | здесь, ветвь `request`  |
 * | решение: виза (`approved = true`)       | применяет спустя часы или дни         | здесь, ветвь `decision` |
 * | решение: отказ (`approved = false`)     | ничего                                | маршрут, вне канона |
 *
 * Ветви, которая только заводит `pending`, канон не нужен вовсе: она не двигает срок, не трогает
 * бумагу и ничего не гасит — ей нечего показывать предпросмотром и нечего подтверждать отпечатком.
 * Отказ по той же причине остаётся прежним простым телом.
 *
 * ПОЧЕМУ У ДВУХ ВЕТВЕЙ РАЗНЫЕ ИМЕНА ДВЕРИ В ЖУРНАЛЕ. Между запросом и визой проходит время,
 * состояние меняется, а решение принимает **другой человек**: отпечаток, снятый чужими глазами и по
 * чужому состоянию, подтверждает не то. Имя двери входит в отпечаток, поэтому предпросмотр
 * заявителя визе не подойдёт физически — и это не проверка, а свойство расчёта (Р19).
 *
 * МОСТ ПРИЧИНЫ (Р19). Канон ждёт envelope журнала **до транзакции** (`spec.operation` собирается
 * там же, где тело), а причина визы лежит в строке `vehicle_request_early_endings` — «что
 * случилось на объекте». Поэтому маршрут визы читает строку **предварительным запросом**, кладёт её
 * причину в envelope, а {@link planEarlyEndCommand} под блокировкой **перечитывает строку и
 * сверяет** причину и дату со снимком: разошлось — 409 «запрос изменился, посмотрите последствия
 * заново», тем же кодом, что и устаревший отпечаток. Комментарий визирующего к причине не
 * приклеивается: оба поля по 2000 символов, envelope канона столько же, и склейка однажды упала бы
 * на схеме. Слово визирующего живёт там, где и жило, — в `decision_comment` и в событии визы.
 *
 * ЧЕГО У ЭТОЙ ДВЕРИ НЕТ И НЕ БУДЕТ — И ЭТО ДОКАЗАНО, А НЕ ВЫБРАНО (Р19):
 *
 * - **исход `crew`**: нижняя граница новой даты — сегодня (`earlyEndDateBounds.min = onDate`),
 *   значит сокращение не задевает ни одного отработанного дня. Отсюда же пустые разблокировки и
 *   ненужное никогда право `waybills.correct`. Нарушение этого инварианта — внутренняя ошибка
 *   двери, а не просьба к человеку «сделайте это диспетчером»: у диспетчера нет `vehicleRequests.approve`,
 *   а дверь срока сокращать работающий заказ запрещает — совет вёл бы в тупик;
 * - **снимаемые смены**: снимаемый диапазон `(newDateTo, previousDateTo]` целиком в будущем, а
 *   смену будущим днём не заполняют и не подписывают. Пустое множество, обёрнутое в отпечаток, —
 *   это поле, которое нечем заполнить и нечего подтверждать.
 *
 * ГДЕ ГРАНИЦА С КАРКАСОМ. Порядок транзакции, блокировки, повтор по ключу, сверка отпечатка, строка
 * журнала, версия и запись аудита принадлежат [assignment-command.ts](./assignment-command.ts);
 * запись истории — [assignment-write.ts](./assignment-write.ts); расчёт сокращения —
 * [assignment-shorten-term.ts](./assignment-shorten-term.ts); последствия срока —
 * [vehicle-request-period.ts](./vehicle-request-period.ts). Здесь остаётся то, что решает дверь:
 * законна ли команда, что она пишет в строку запроса, из чего складывает отпечаток, чего требует
 * рукопожатием и что показывает визирующему.
 */

/**
 * Имена дверей в цели операции журнала (Р9) и в отпечатке предпросмотра.
 *
 * Те же, которыми обе ветви уже зовут бэкстоп чужой двери: одно имя на одну работу, иначе журнал
 * коррекций и диагностика бэкстопа называли бы одно и то же действие по-разному.
 */
const DOORS = {
  request: 'early_end_request',
  decision: 'early_end_decision',
} as const;

/** Какая из двух применяющих ветвей идёт: у них разные тела, разные люди и разные отпечатки. */
export type EarlyEndBranch = keyof typeof DOORS;

/**
 * Строка запроса, прочитанная **до** транзакции, — материал envelope канона и предмет сверки под
 * блокировкой (мост причины, Р19).
 */
export interface EarlyEndPendingSnapshot {
  newDateTo: string;
  reason: string;
}

/** Тело команды, каким его видит расчёт: у предпросмотра и боевого вызова оно общее (Л1). */
export type EarlyEndCommand =
  | {
      branch: 'request';
      /** До какого числа просят сократить срок. */
      newDateTo: string;
      /** Причина запроса — она же причина операции журнала (Р19). */
      reason: string;
    }
  | {
      branch: 'decision';
      /**
       * Снимок строки запроса: по нему собран envelope, и с ним сверяется перечитанная строка.
       *
       * `null` — маршрут ожидающего запроса **не увидел**. Это не отказ маршрута, и в этом весь
       * смысл (Р19): решает расчёт под блокировкой, потому что повтор по ключу приходит на уже
       * завизированный запрос — строки `pending` там нет и быть не может, а прежний результат он
       * получить обязан.
       */
      snapshot: EarlyEndPendingSnapshot | null;
      /** Слово визирующего; в причину операции не превращается никогда. */
      comment: string;
    };

// ── Что дверь посчитала ──

/**
 * Предметный план досрочного завершения: всё, что посчитано до первой записи и дальше только
 * читается. Один объект на предпросмотр и на исполнение (§8): предпросмотр обязан обещать ровно то,
 * что произойдёт, а вторая копия расчёта разошлась бы с первой на первом же новом правиле.
 */
export interface EarlyEndPlan {
  branch: EarlyEndBranch;
  /** Новый последний день работ: у запроса из тела, у визы — из перечитанной строки запроса. */
  newDateTo: string;
  /** Эффективный конец срока **сейчас**: `coalesce(date_to, date_from)`. */
  previousDateTo: string;
  /** Причина запроса; она же уезжает в envelope журнала. */
  reason: string;
  /** Комментарий визирующего; у ветви запроса пуст — визы там не было, было согласие фактом. */
  comment: string;
  termBefore: AssignmentTerm;
  termAfter: AssignmentTerm;
  /** Общий расчёт сокращения (Р18): гасимые группы, эффекты, бумага, разблокировки, дни. */
  shorten: ShortenTermPlan;
  /** Дни линейного заказа за новым концом срока — те же, что в расчёте; вынесены ради читаемости. */
  linearDays: LinearDaysPlan;
  /** Сколько дней освобождается — число для окна визирующего. */
  daysSaved: number;
  /** Отпечаток последствий: считает дверь, сверяет каркас шагом 7 (Р17). */
  fingerprint: string;
}

/** Что дверь пронесла через шаг 12 в аудит и снимок операции. */
export interface EarlyEndPaper {
  esm2: Esm2SyncResult;
  /** Дни, снятые с рейсов, и дни, которых рейс не отдал: по нему выписан действующий лист. */
  days: LinearDaysSyncResult;
}

/** Кому нужна строка запроса до транзакции — маршруту визы и её предпросмотру. */
type Reader = AssignmentCommandTx | typeof AppDb;

/**
 * Ожидающий визы запрос — чтение **до** канонической транзакции (мост причины, Р19).
 *
 * Отдаёт только то, что едет в envelope и в сверку: причину и дату. Кто и когда просил, здесь не
 * нужно — за это отвечает сама строка и события истории.
 */
export async function readPendingEarlyEnd(
  reader: Reader,
  requestId: string,
): Promise<EarlyEndPendingSnapshot | null> {
  const [row] = await reader
    .select({
      newDateTo: vehicleRequestEarlyEndings.newDateTo,
      reason: vehicleRequestEarlyEndings.reason,
    })
    .from(vehicleRequestEarlyEndings)
    .where(
      and(
        eq(vehicleRequestEarlyEndings.requestId, requestId),
        eq(vehicleRequestEarlyEndings.status, 'pending'),
      ),
    );
  return row ?? null;
}

// ── Расчёт (шаги 4–6 канона) ──

/**
 * Посчитать досрочное завершение целиком: новый срок, гасимые группы, последствия, бумагу и дни.
 *
 * ПРЕДМЕТНЫЕ ПРОВЕРКИ ЖИВУТ ЗДЕСЬ, А НЕ ДО ТРАНЗАКЦИИ (Р19, блокер 2 пятого ревью). Раньше
 * `earlyEndBlocker`, границы даты и наличие `pending` спрашивались в маршруте — и после успешного
 * применения все три уже ложны: срок сокращён, запрос решён. Повтор по ключу получил бы 422 раньше,
 * чем шаг 2 канона нашёл бы прежнюю операцию и вернул её результат. До транзакции остаются только
 * область и право — они не зависят от того, применена ли команда.
 *
 * Транзакция приходит читающей (`readOnlyTx` каркаса): до сверки отпечатка и авторизации команда
 * ничего не записывает (Р20).
 */
export async function planEarlyEndCommand(
  ctx: AssignmentPlanContext,
  command: EarlyEndCommand,
): Promise<AssignmentPlanned<EarlyEndPlan>> {
  const { tx, request, asOf } = ctx;
  const termBefore = request.term;
  const previousDateTo = lastDayOf(termBefore);
  /*
   * Субъект правил — из строки под блокировкой, а не из DTO маршрута: между чтением карточки и
   * командой заявку успевают закрыть, поправить ей срок или просто дожить до запрошенного дня.
   * Тип здесь заведомо `special_equipment` (иначе каркас не отдал бы заявку вовсе), но
   * перечисляется явно: правило читается целиком, а не выводится из чужого инварианта.
   */
  const subject = {
    requestType: 'special_equipment' as const,
    status: request.status as RequestStatus,
    deletedAt: request.deletedAt ? request.deletedAt.toISOString() : null,
    dateFrom: termBefore.dateFrom,
    dateTo: termBefore.dateTo,
  };
  const blocker = earlyEndBlocker(subject, asOf);
  if (blocker) throw err.unprocessable(blocker);

  /*
   * Что именно применяем. У запроса это тело, у визы — **перечитанная строка**: снимок,
   * собранный до транзакции, к этому моменту мог устареть, а причина из него уже уехала в envelope
   * журнала. Расхождение — 409 тем же кодом, что и устаревший отпечаток: человек в обоих случаях
   * делает одно и то же — смотрит последствия заново.
   */
  const applied =
    command.branch === 'request'
      ? { newDateTo: command.newDateTo, reason: command.reason, comment: '' }
      : {
          ...(await requireSameRequest(tx, request.id, command.snapshot)),
          comment: command.comment,
        };

  if (!isAllowedEarlyEndDate(subject, asOf, applied.newDateTo)) {
    const bounds = earlyEndDateBounds(subject, asOf)!;
    throw command.branch === 'request'
      ? err.unprocessable(
          `Новая дата окончания — с ${dateKeyRu(bounds.min)} по ${dateKeyRu(bounds.max)}`,
          { newDateTo: 'Дата вне срока заявки' },
        )
      : err.unprocessable(
          `Запрошенная дата ${dateKeyRu(applied.newDateTo)} больше не годится: срок заявки изменился или день уже прошёл — нужен новый запрос`,
        );
  }

  const termAfter: AssignmentTerm = { dateFrom: termBefore.dateFrom, dateTo: applied.newDateTo };

  /*
   * Исход самой команды над сроком — внешним эффектом (Е3 плана периодов): строки истории у
   * сокращения нет вовсе (календарь двигает колонка заявки), и вывести исход из мутаций нечем.
   * Граница та же, что у двери срока и у `backdateGuard`. Своих предикатов заднего числа у этой
   * двери нет — и не нужно: её нижняя граница даты и так «сегодня».
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
   * Субъект допустимости дней (Р11): статус остаётся **прежним** и настоящим — досрочное завершение
   * заявку не закрывает, она продолжает работать по укороченному сроку. Политика `retainCompletedDays`
   * поэтому и не нужна: общий запрет `linearDaysBlocker` у работающей заявки молчит, и обречены
   * ровно дни за новым концом срока — то же множество, которое снимала прежняя сверка.
   */
  const linear = await loadLinearRequest(tx, request.id);
  const eligibilitySubject: LinearDaySubject = {
    requestType: subject.requestType,
    isLinear: linear?.isLinear ?? false,
    status: subject.status,
    deletedAt: null,
    dateFrom: termAfter.dateFrom,
    dateTo: termAfter.dateTo,
    ownership: linear?.ownership ?? null,
  };

  const shorten = await shortenTermPlan(tx, {
    requestId: request.id,
    asOf,
    termBefore,
    termAfter,
    external,
    linearDays: { eligibilitySubject, retainCompletedDays: false },
  });
  const { effects } = shorten;

  /*
   * Инварианты Р19 — здесь, а не в комментарии. Нарушение любого из них означает, что правило
   * «новая дата не раньше сегодня» перестало держаться, и тогда команда обязана упасть внутренней
   * ошибкой: тело, которым её можно было бы провести, у этой двери отсутствует по построению —
   * ни `unlockFingerprint`, ни `clearedShiftsFingerprint` схемы не принимают.
   */
  if (effects.operationOutcome === 'crew' || shorten.requiredUnlockIds.length > 0) {
    throw invariant(
      'сокращение задело отработанный лист: у досрочного завершения нижняя граница новой даты — сегодня, и исход `crew` недостижим',
    );
  }

  const draft = {
    branch: command.branch,
    newDateTo: applied.newDateTo,
    previousDateTo,
    reason: applied.reason,
    comment: applied.comment,
    termBefore,
    termAfter,
    shorten,
    linearDays: shorten.linearDays,
    daysSaved: earlyEndDaysSaved(previousDateTo, applied.newDateTo) ?? 0,
  };
  const fingerprint = earlyEndFingerprintOf(request.id, asOf, effects, draft);
  return { effects, fingerprint, plan: { ...draft, fingerprint } };
}

/**
 * Строка запроса под блокировкой — та же ли, по которой считали envelope (Р19).
 *
 * Блокировка здесь та же, что у всей команды: строку запроса правят только под `FOR UPDATE` самой
 * заявки (шаг 1 канона), поэтому отдельного `FOR UPDATE` на неё не нужно — нужен порядок, и он уже
 * взят. Сверяются оба поля: причина уехала в envelope журнала, а дата — это и есть то, что команда
 * применит.
 */
async function requireSameRequest(
  tx: AssignmentCommandTx,
  requestId: string,
  snapshot: EarlyEndPendingSnapshot | null,
): Promise<EarlyEndPendingSnapshot> {
  const row = await readPendingEarlyEnd(tx, requestId);
  if (!row) throw err.unprocessable('Запрос на досрочное завершение не найден');
  if (!snapshot || row.newDateTo !== snapshot.newDateTo || row.reason !== snapshot.reason) {
    throw err.conflict(
      'Запрос на досрочное завершение изменился: посмотрите последствия заново и повторите визу',
      { code: 'assignment_preview_stale' },
    );
  }
  return row;
}

// ── Рукопожатия (шаг 8) ──

/**
 * Что тело обязано подтвердить против **рассчитанного** плана (§8, Д2).
 *
 * Проверка здесь ровно одна — перечень гасимых групп. Общий отпечаток последствий сверяет каркас
 * шагом 7 (`requiresPreview`), разблокировок у этой двери не бывает вовсе, снимаемых часов тоже
 * (Р19), и полей под них нет в схемах: лишнее кончается 400, а не 422.
 *
 * Симметрия обязательна: тело, знающее про гашение, которого нет, посчитано по другому состоянию —
 * и молча пропущенное подтверждение означало бы, что человек подтвердил не то, что произойдёт.
 */
export function assertEarlyEndHandshake(
  mode: AssignmentModeSnapshot,
  plan: EarlyEndPlan,
  input: {
    cancelGroupsFingerprint?: string | undefined;
    /** Подписи по листам с непустыми предупреждениями: `issueKey` строкой → отпечаток набора. */
    acknowledgements?: Readonly<Record<string, string>> | undefined;
  },
): void {
  const expected = plan.shorten.cancelGroupsFingerprint;
  if (expected === null) {
    if (input.cancelGroupsFingerprint !== undefined) {
      throw err.unprocessable(
        'Это сокращение ничего не гасит в истории назначения — подтверждать нечего. Посмотрите последствия заново и повторите команду без подтверждения',
        { cancelGroupsFingerprint: 'Лишнее подтверждение' },
      );
    }
    // Ранний выход отсюда унёс бы вторую проверку целиком: гасить нечего — а бумага у такого
    // сокращения бывает, и подпись по ней спрашивается всё равно.
  } else if (input.cancelGroupsFingerprint !== expected) {
    throw err.unprocessable(
      `Сокращение срока гасит решения о технике и машинисте, стоявшие за новым концом срока (${plan.shorten.cancelGroups
        .map((group) => group.rows[0]!.effectiveDate)
        .join(
          ', ',
        )}): решение уходит целиком — вместе с машиной снимается и назначенный на неё машинист. Подтвердите перечень — он показан в предпросмотре`,
      { cancelGroupsFingerprint: 'Нужно подтверждение' },
    );
  }
  assertIssueHandshake(mode, plan, input);
}

/**
 * Рукопожатие по листам (Б4) — вторая и последняя проверка этой двери.
 *
 * Отдельной функцией, потому что порядок здесь смысловой: перечень гасимых групп отвечает на «что
 * уйдёт из истории», а подпись — на «что напечатают в бланке», и спрошенная первой она попросила бы
 * человека подтвердить бумагу решения, которого он ещё не видел.
 *
 * Требуется там, где бумагу выпускает **этот** план (`paperFollowsHistory`): в `legacy` листы
 * ведёт недельная сверка, у которой просителя нет вовсе, и неполный комплект документов её не
 * останавливает (ADR 0064). Присланное подтверждение проверяется в обоих режимах.
 *
 * Обычному сокращению подписывать нечего: лист не гаснет, а **правится** — период документа
 * становится короче, а напечатанный в нём человек и его документы остаются теми же. Подпись
 * спрашивается там, где отрезок за новым концом забирает у листа часть дней: документ уходит из
 * оборота целиком, а взамен выписывается новый — с теми пробелами, которые человек обязан увидеть.
 */
function assertIssueHandshake(
  mode: AssignmentModeSnapshot,
  plan: EarlyEndPlan,
  input: { acknowledgements?: Readonly<Record<string, string>> | undefined },
): void {
  assertAssignmentIssueAcknowledgements({
    issues: plan.shorten.issues,
    acknowledgements: input.acknowledgements,
    required: paperFollowsHistory(mode),
  });
}

// ── Отпечаток предпросмотра (Р20, Р32) ──

/**
 * Отпечаток последствий: **содержание**, а не идентификаторы (Р20).
 *
 * Имя двери здесь несёт работу, а не украшает ключ: у запроса визирующего и у визы оно разное,
 * и потому отпечаток, снятый заявителем, визе не подойдёт **физически** (Р19) — сверять «чей это
 * предпросмотр» отдельной проверкой не нужно.
 *
 * Не входят сюда рукопожатия — версия, ключ операции и сами отпечатки: они появляются в теле
 * **после** предпросмотра, и хеш всего боевого тела не сошёлся бы никогда.
 */
function earlyEndFingerprintOf(
  requestId: string,
  asOf: string,
  effects: AssignmentEffects,
  plan: Omit<EarlyEndPlan, 'fingerprint'>,
): string {
  return fingerprintOf({
    door: DOORS[plan.branch],
    requestId,
    asOf,
    command: { newDateTo: plan.newDateTo, previousDateTo: plan.previousDateTo },
    outcome: effects.operationOutcome,
    effects: {
      ...effects.payload,
      mutations: effects.payload.mutations.map(({ changeId: _id, ...rest }) => rest),
    },
    termDiff: plan.shorten.termDiff,
    cancelGroups: cancelGroupsShape(plan.shorten.cancelGroups),
    plan: {
      cancel: plan.shorten.preview.cancel.map((sheet) => sheet.waybillId).sort(),
      issue: plan.shorten.preview.issue.map(
        (i) => `${i.from}|${i.to}|${i.vehicleId}|${i.driverPersonId}`,
      ),
      /*
       * Правки периода — третьим ключом (Р5). Без него подмена «перевыпуск → правка» отпечатка не
       * меняет: у плана, который лист сокращает, обе половины выше пусты — номер не горит и новый
       * не выписывается, — и два плана, различающиеся только правками, дали бы один отпечаток.
       */
      trim: plan.shorten.sheetPlan.trim.map((item) => `${item.waybillId}|${item.to}`).sort(),
    },
    /*
     * Дни линейного заказа — вместе с версиями рейсов: подтверждается изменение **чужой** строки,
     * версия которой в заявке не отражается, и без неё отпечаток не заметил бы, что рейс успели
     * переписать между предпросмотром и командой.
     */
    linearDays: [...plan.linearDays.detachable, ...plan.linearDays.frozen]
      .map((item) => `${item.date}|${item.routeId}|${item.routeVersion}|${item.frozen ? 'f' : 'd'}`)
      .sort(),
  });
}

// ── Спецификация команды для каркаса (§8) ──

/**
 * Спецификация обеих применяющих ветвей — **один** источник на боевую ручку и на тесты.
 *
 * Собрана здесь, а не в роут-модуле, по той же причине, по какой предпросмотр зовёт тот же колбэк
 * `plan`: место, где предметные места канона заполняются, должно быть одно.
 */
export function earlyEndCommandSpec(params: {
  requestId: string;
  actor: Principal;
  command: EarlyEndCommand;
  /** Рукопожатия тела: необязательные поля apply-схемы (Р28). */
  handshake: {
    operationId?: string | undefined;
    previewFingerprint?: string | undefined;
    cancelGroupsFingerprint?: string | undefined;
    /** Подписи по выпускаемым листам с непустыми предупреждениями (Б4). */
    acknowledgements?: Readonly<Record<string, string>> | undefined;
  };
  /** Тело запроса целиком: им каркас отличает повтор по ключу от чужого ключа (Р9). */
  body: unknown;
  expectedVersion: number;
  asOf: string;
}): AssignmentCommandSpec<EarlyEndPlan, AssignmentWriteResult, EarlyEndPaper> {
  const { requestId, actor, command, handshake, asOf } = params;
  /*
   * Причина операции — из запроса, а не из тела команды (Р19). У ветви запроса она приезжает в том
   * же теле, у визы прочитана предварительным запросом; в обоих случаях это «что случилось на
   * объекте», и второго места, где пишут причину сокращения, портал не заводит.
   */
  /*
   * Пустая причина у визы без снимка до журнала не доезжает: расчёт откажет раньше — либо 422
   * «запрос не найден», либо 409 «запрос изменился», — а до шага 10 команда доходит только после
   * успешного расчёта. Писать сюда заглушку вроде «причина неизвестна» значило бы завести второй
   * источник причины, ровно тот, которого Р19 и не допускает.
   */
  const reason = command.branch === 'request' ? command.reason : (command.snapshot?.reason ?? '');
  return {
    // Класс двери — `history` (§10): сокращение читает историю ради бумаги, а с гашением и пишет её.
    door: 'history',
    journalDoor: DOORS[command.branch],
    requestId,
    actor: { id: actor.id },
    expectedVersion: params.expectedVersion,
    body: params.body,
    operation: handshake.operationId ? { operationId: handshake.operationId, reason } : null,
    previewFingerprint: handshake.previewFingerprint,
    /*
     * Предпросмотр спрашивается **всегда** (Р17): у сокращения строк истории может не быть вовсе
     * при непустой бумаге — листы сгорают, правятся и выписываются, — и умолчание каркаса
     * («непустая история») пропустило бы ровно те команды, ради которых отпечаток и заведён.
     */
    requiresPreview: () => true,
    asOf,
    plan: (ctx) => planEarlyEndCommand(ctx, command),
    handshake: (ctx) => assertEarlyEndHandshake(ctx.mode, ctx.plan, handshake),
    /*
     * Права по посчитанному исходу (Р32) — и вырасти им здесь не с чего: исход `crew` у этой двери
     * недостижим (инвариант проверен в расчёте), значит `waybills.correct` не спрашивается никогда,
     * а право на само действие спросил страж маршрута. Вызов остаётся общим с дверью машиниста
     * ради снимка авторизации: его формат один на все двери, и повтор по ключу читает именно его.
     */
    authorize: (ctx) => authorizeEarlyEndCommand(actor, ctx),
    authorizeRepeat: (scope) => authorizeCrewRepeat(actor, scope),
    mutate: (ctx) => applyEarlyEnd(ctx, actor, command.branch),
    syncPaper: (ctx) => syncEarlyEndPaper(ctx, actor, handshake.acknowledgements),
    payload: (ctx) => ({
      door: DOORS[ctx.plan.branch],
      branch: ctx.plan.branch,
      newDateTo: ctx.plan.newDateTo,
      previousDateTo: ctx.plan.previousDateTo,
      period: { before: ctx.plan.termBefore, after: ctx.plan.termAfter },
      cancelledGroups: ctx.write.cancelledGroups,
      history: historySnapshotOf(ctx.write),
      esm2: ctx.paper.esm2,
      linearDays: ctx.paper.days,
    }),
    audit: (ctx) => earlyEndAuditOf(ctx),
  };
}

/**
 * Шаг 9 — условная авторизация (Р32).
 *
 * Своей проверки прав у этой двери нет вовсе, и это решение, а не пробел (Р19, Р26): права ни одной
 * ветви не растут. `waybills.read` не спрашивается — предпросмотр обезличен именно ради этого, —
 * а `waybills.correct` не понадобится никогда: исход `crew` недостижим. Снимок авторизации всё
 * равно собирается общим правилом: его читает повтор по ключу, и своя форма снимка означала бы
 * вторую редакцию того же контракта.
 */
function authorizeEarlyEndCommand(
  actor: Principal,
  ctx: AssignmentAuthorizeContext<EarlyEndPlan>,
): WaybillCorrectionAuthorizationScope {
  return authorizeCrewCommand(actor, ctx.effects, ctx.asOf);
}

// ── Шаг 11: предметные мутации ──

/**
 * Порядок внутри шага 11 значим целиком, и каждый переход обоснован:
 *
 * 1. **материализация истории** — по **прежнему** сроку: расчёт шага 5 видел именно его, и цель
 *    гашения адресована строке, которую вписывает как раз этот вызов. Зови мы его после записи
 *    срока, бэкфилл восстановил бы историю по новому сроку — другую;
 * 2. **гашение групп** — ядром записи и одной мутацией на группу: оставленная за новым концом срока
 *    vehicle-строка ожила бы при следующем продлении, без решения о ставках и занятости;
 * 3. **строка запроса** — она и есть предмет обеих ветвей: у запроса визирующего заводится сразу
 *    согласованной, у визы получает решение и слово визирующего;
 * 4. **новый срок** — до шага 12: `afterWorkPeriodChanged` читает заявку из базы, и срок к его
 *    вызову обязан быть уже записан;
 * 5. **пересчёт готовности** — дверь, изменившая область валидности, обязана пересчитать блокеры.
 */
async function applyEarlyEnd(
  ctx: AssignmentApplyContext<EarlyEndPlan>,
  actor: Principal,
  branch: EarlyEndBranch,
): Promise<{ write: AssignmentWriteResult; applied: AssignmentWriteResult }> {
  const { tx, plan, request } = ctx;
  const now = new Date();

  if (plan.shorten.historyPresent) {
    await ensureCommandHistory(tx, { requestId: request.id, asOf: ctx.asOf });
  }
  const write = await applyAssignmentMutations(tx, {
    requestId: request.id,
    actorUserId: actor.id,
    // Строки гаснут операцией журнала: «почему субботняя машина вдруг снята» отвечается ею.
    correctionId: ctx.operation?.id ?? null,
    mutations: plan.shorten.cancelGroups.map((group) => group.target),
    /*
     * Обещание по денормализации (Р17 плана периодов) — двери, а не расчёта. Гашения нет — `keep`:
     * сокращение назначения не касается. Гашение есть — `tail_release`: назначение и ставки не
     * тронуты, а хвост истории **законно** разошёлся с ним, потому что граница снята.
     */
    denormalization: (plan.shorten.cancelGroups.length > 0
      ? { kind: 'tail_release' }
      : { kind: 'keep' }) as AssignmentDenormalizationIntent,
  });

  if (branch === 'request') {
    /*
     * Одна заявка — одна запись: повторный запрос переписывает прежний (ADR 0044). Цепочка при этом
     * не теряется — каждый запрос и каждое решение остаются событием истории. Своя виза не нужна
     * тому, кто её и ставит: запрос сразу записывается согласованным.
     */
    const values = {
      status: 'approved' as const,
      newDateTo: plan.newDateTo,
      previousDateTo: plan.previousDateTo,
      reason: plan.reason,
      requestedBy: actor.id,
      requestedAt: now,
      decidedBy: actor.id,
      decidedAt: now,
      decisionComment: '',
    };
    await tx
      .insert(vehicleRequestEarlyEndings)
      .values({ requestId: request.id, ...values })
      .onConflictDoUpdate({
        target: vehicleRequestEarlyEndings.requestId,
        set: { ...values, updatedAt: now },
      });
  } else {
    /*
     * Условие `pending` — второй замок, а не первый: наличие ожидающего запроса проверил расчёт под
     * той же блокировкой. Но строка, обновлённая «вообще», однажды переписала бы чужое решение,
     * поэтому обновление адресуется состоянию, а расхождение считается конфликтом.
     */
    const decided = await tx
      .update(vehicleRequestEarlyEndings)
      .set({
        status: 'approved',
        decidedBy: actor.id,
        decidedAt: now,
        decisionComment: plan.comment,
        updatedAt: now,
      })
      .where(
        and(
          eq(vehicleRequestEarlyEndings.requestId, request.id),
          eq(vehicleRequestEarlyEndings.status, 'pending'),
        ),
      )
      .returning({ requestId: vehicleRequestEarlyEndings.requestId });
    if (decided.length === 0) throw err.conflict();
  }

  /*
   * Согласованное сокращение срока (ADR 0044): новый последний день записывается прямо в заявку.
   * Отдельной пары «план/факт» у срока нет — в заявке одно время, то, о котором договорились, — а
   * расхождение с первоначальным читается историей.
   */
  await tx
    .update(specialEquipmentRequestDetails)
    .set({ dateTo: plan.termAfter.dateTo })
    .where(eq(specialEquipmentRequestDetails.requestId, request.id));

  await ensureAssignmentHistory(tx, { requestId: request.id, asOf: ctx.asOf });
  return { write, applied: write };
}

// ── Шаг 12: бумага, дни и бэкстоп ──

/**
 * Последствия сокращённого срока — **тем же сервисом**, каким их ведут правка срока, широкая
 * правка, недельная операция и дверь закрытия (Р19).
 *
 * Что здесь изменилось по сравнению с прежним кодом маршрутов и ради чего затевался этап: бумагу
 * исполняет не «всегда недельная сверка», а тот, кого назвал **режим чтения** (§10). В `legacy` это
 * по-прежнему `syncEsm2Waybills`, в `history` — отрезковый план, посчитанный шагом 6, показанный
 * человеку и захешированный в отпечаток. Пересчитывать его здесь нельзя: это было бы исполнением
 * не того, что подтверждено.
 *
 * Бэкстоп чужой двери (Р21, Р22) считается **этой** дверью и до бумаги: своим именем ветви — иначе
 * диагностика не отличила бы запрос от визы, — и по уже записанному сроку. Новых дней сокращение не
 * открывает, поэтому решения по хвосту у него не спрашивают: гашение хвостовой группы само создаёт
 * то расхождение, о котором его тут же и спросили бы.
 *
 * Дни линейного заказа передаются **готовым планом**, а не пересчитываются сверкой: план посчитан
 * до записи срока и вошёл в отпечаток. Отдаётся он целиком, вместе с замороженными: политика этой
 * двери — предупреждение, а не отказ (Р11), и исполнитель, перечитывающий заморозку из-под
 * блокировки рейса, честно скажет, чего рейс не отдал. Заказ живёт дальше, и следующее действие по
 * нему сверку повторит — в отличие от закрытия, у которого следующего действия нет.
 */
async function syncEarlyEndPaper(
  ctx: AssignmentPaperContext<EarlyEndPlan, AssignmentWriteResult>,
  actor: Principal,
  /** Рукопожатия, принятые шагом 8: ими лист помнит, под чем его подписали (Р21). */
  acknowledgements?: Readonly<Record<string, string>> | undefined,
): Promise<EarlyEndPaper> {
  const { tx, plan, request } = ctx;
  const reason = `Срок заявки сокращён до ${dateKeyRu(plan.newDateTo)}`;
  const paperReason = `${reason} — путевые листы переоформлены`;
  const correctionId = ctx.operation?.id ?? null;
  const unlockWaybillIds = plan.shorten.requiredUnlocks.map((u) => u.waybillId);

  await assertAssignmentBackstop(tx, {
    door: DOORS[plan.branch],
    requestId: request.id,
    actor: { id: actor.id },
    asOf: ctx.asOf,
    reason,
    opensTerm: false,
  });

  const doomed: LinearDayPlanItem[] = [...plan.linearDays.detachable, ...plan.linearDays.frozen];
  /*
   * КТО ИСПОЛНЯЕТ БУМАГУ — режим чтения, и только он.
   *
   * Оговорки «а у бумаги по требованию всё равно недельная сверка» здесь больше нет, и снята она
   * не смягчением правила, а починкой того, из-за чего стояла: общий расчёт сокращения не умел
   * планировать листы линейного заказа, отдавал пустой план, а пустой план ничего не правит —
   * выданный на неделю бланк остался бы стоять по дни, которых у заказа больше нет. Теперь расчёт
   * считает ожидания `on_demand` из уже выписанного, подрезанного сроком (`esm2RequestedSheets`,
   * ADR 0100 §5), — тем же правилом, каким их считает недельная сторона.
   *
   * Дверная заплатка была бы здесь второй редакцией правил `on_demand`, и чинить пришлось бы ещё
   * дважды: тем же расчётом ходят дверь срока и дверь закрытия фактической датой.
   */
  const followsSheetPlan = paperFollowsHistory(ctx.mode);
  const result = await afterWorkPeriodChanged(tx, {
    requestId: request.id,
    actor: { id: actor.id },
    reason: paperReason,
    /*
     * Ожидающий визы запрос эта дверь не снимает: он и есть её собственный предмет. Ветвь запроса
     * только что переписала строку своей — согласованной, — а виза решила прежнюю; снимать после
     * этого «ожидающие» означало бы стирать то, что сама же и записала.
     */
    dropPendingEarlyEnd: false,
    backstop: 'checked_by_caller',
    opensTerm: false,
    days: { kind: 'plan' as const, plan: doomed },
    ...(ctx.effects.needsCorrection && correctionId
      ? { correction: { id: correctionId, unlockWaybillIds } }
      : {}),
    ...(followsSheetPlan
      ? {
          paper: {
            kind: 'plan' as const,
            ...assignmentPaperExecution({
              requestId: request.id,
              actor: { id: actor.id },
              reason: paperReason,
              mode: ctx.mode,
              effects: ctx.effects,
              operationId: correctionId,
              sheetPlan: plan.shorten.sheetPlan,
              paperScope: plan.shorten.paperScope,
              sheets: plan.shorten.sheets,
              displayNumbers: plan.shorten.sheetNumbers,
              unlockWaybillIds,
              // Снимок бланка и предупреждения — посчитанные шагом 6 и подтверждённые человеком.
              issues: plan.shorten.issuePreparations,
              acknowledgements,
            }),
          },
        }
      : {}),
  });
  return { esm2: result.esm2, days: result.days };
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
 * События ленты — **данными**: пишет их каркас и в транзакции (§8, шаг 13).
 *
 * Имена и состав те же, что писали маршруты до переезда, и это не совпадение, а требование: историю
 * заказа читают глазами, и «кто согласовал сокращение» после переезда двери обязано отвечаться тем
 * же событием, что и до него.
 *
 * Своя виза у ветви запроса — **отдельным** событием с пометкой `auto`, как и при заведении заявки:
 * иначе на вопрос «кто согласовал сокращение» отвечало бы только текущее состояние строки.
 * Изменения при этом называют срок, а не весь состав заявки: он не менялся ничем, кроме срока.
 */
function earlyEndAuditOf(
  ctx: AssignmentAuditContext<EarlyEndPlan, AssignmentWriteResult, EarlyEndPaper>,
): AuditEntry[] {
  const { plan, paper } = ctx;
  const decision = {
    door: DOORS[plan.branch],
    outcome: ctx.effects.operationOutcome,
    operationId: ctx.operation?.operationId ?? null,
    ...(ctx.write.cancelledGroups.length > 0 ? { cancelledGroups: ctx.write.cancelledGroups } : {}),
    changes: termChanges(plan),
  };
  const entries: AuditEntry[] =
    plan.branch === 'request'
      ? [
          {
            action: 'vehicle_request.early_end_request',
            metadata: {
              newDateTo: plan.newDateTo,
              previousDateTo: plan.previousDateTo,
              changes: diffVehicleEarlyEnd({
                previousDateTo: plan.previousDateTo,
                newDateTo: plan.newDateTo,
                reason: plan.reason,
              }),
            },
          },
          { action: 'vehicle_request.early_end_approve', metadata: { auto: true, ...decision } },
        ]
      : [{ action: 'vehicle_request.early_end_approve', metadata: decision }];

  /*
   * Дни линейного заказа — тем же событием и с той же причиной (`early_end`), какими их писала
   * прежняя сверка: событие читают глазами, и другая причина рядом читалась бы как другая работа.
   * Пустая сверка события не пишет вовсе — молчаливая сверка событием не является.
   */
  const days = linearDaysSyncAudit({ reason: 'early_end', result: paper.days });
  if (days) entries.push(days);
  return entries;
}

/** Срок — парой «было → стало», тем же оформителем, каким его пишет обычная правка заявки. */
function termChanges(plan: EarlyEndPlan): RequestChangeDto[] {
  const diff = changeSet();
  diff.changed('dateTo', dateKeyRu(plan.previousDateTo), dateKeyRu(plan.newDateTo));
  return diff.changes;
}

// ── Предпросмотр (Р26) ──

/**
 * Обезличенный ответ предпросмотра: числа, даты и требования — и ничего, что называет бланк или
 * человека (Р26).
 *
 * Собирается **из плана**, а не вычитанием полей из общего `AssignmentPreviewDto`: новое поле
 * общего DTO в это тело не попадёт даже по забывчивости. Отпечаток при этом считается сервером по
 * **полному** плану — обезличивание это другая форма ответа, а не другой расчёт: подтверждается
 * положение дел, а не текст на экране.
 */
export function earlyEndApprovalPreviewDto(
  effects: AssignmentEffects,
  plan: EarlyEndPlan,
  fingerprint: string,
  asOf: string,
): EarlyEndApprovalPreviewDto {
  const trims = plan.shorten.sheetPlan.trim;
  return {
    newDateTo: plan.newDateTo,
    daysSaved: plan.daysSaved,
    paper: {
      trimmed: trims.length,
      cancelled: plan.shorten.preview.cancel.length,
      /*
       * По какое число сократят — одной датой: правки одного сокращения кончаются одним и тем же
       * днём, и перечень из одинаковых значений сказал бы человеку ровно то же самое, только
       * длиннее. `null` — правок нет вовсе.
       */
      trimmedTo: trims.reduce<string | null>(
        (latest, item) => (latest === null || item.to > latest ? item.to : latest),
        null,
      ),
    },
    linearDays: {
      detachable: plan.linearDays.detachable.map((item) => linearDayRefOf(item).date),
      frozen: plan.linearDays.frozen.map((item) => linearDayRefOf(item).date),
    },
    // Даты вступления в силу, а не состав: «что погаснет» визирующему объясняет число и день, а
    // машины и фамилии в них — это то, ради сокрытия чего заведено обезличивание.
    cancelGroups: plan.shorten.cancelGroups.map((group) => ({
      effectiveDate: group.rows[0]!.effectiveDate,
    })),
    /*
     * Предупреждения — видами и отпечатком, без текста и без того, у кого нашли пробел (Б4 и Р26
     * вместе).
     *
     * Подпись по каждому такому листу дверь **требует** там, где бумагу выпускает сам план, и
     * взять отпечаток человеку больше неоткуда: полного предпросмотра у этой двери нет вовсе.
     * Отдай мы здесь один отпечаток без вида замечания — человек подписывал бы вслепую; отдай
     * целиком `AssignmentIssueWarningsDto` — визирующий прочёл бы фамилию машиниста и номер его
     * удостоверения, то есть ровно то, ради сокрытия чего заведено обезличивание.
     */
    issues: plan.shorten.issues.map((issue) => ({
      issueKey: issue.issueKey,
      // Виды — множеством и по канону: один и тот же вид в наборе повторяется (у машиниста бывает
      // и СНИЛС, и удостоверение), а порядок в списке предупреждений человеку ничего не говорит.
      codes: [...new Set(issue.warnings.map((warning) => warning.facts.code))].sort(),
      warningFingerprint: issue.warningFingerprint,
    })),
    operationRequirement: operationRequirementOf(effects),
    asOf,
    fingerprint,
    cancelGroupsFingerprint: plan.shorten.cancelGroupsFingerprint,
  };
}

/**
 * Спрашивать ли ключ операции — решает исход (Р32). Проекция здесь **своя** — общую соседние двери
 * берут из `assignment-crew.ts` (`operationRequirementOf`), — и отличается она одним полем:
 * `reasonRequired: false`.
 *
 * В общем контракте `reasonRequired` буквально означает «окно показывает поле причины», а причина у
 * этой двери уже названа самим запросом — второго поля быть не должно. Это единственное место, где
 * проекция меняет смысл поля, и потому она написана здесь, а не выведена из умолчаний.
 *
 * `crew` в `kind` не попадает никогда: исход у этой двери недостижим (инвариант проверен расчётом),
 * и попытка собрать такое требование означала бы, что инвариант уже нарушен.
 */
function operationRequirementOf(effects: AssignmentEffects): OperationRequirement | null {
  if (!effects.needsOperation) return null;
  if (effects.operationOutcome === 'crew') {
    throw invariant('предпросмотр досрочного завершения получил исход `crew`');
  }
  return { kind: 'assignment_tail', reasonRequired: false, operationIdRequired: true };
}

// ── Мелочи ──

/**
 * Нарушенный инвариант двери — 500, а не 422: тела, которым человек мог бы это исправить, не
 * существует, и просить его о невозможном значило бы прятать дефект под видом отказа.
 */
function invariant(message: string): AppError {
  return new AppError(500, 'early_end_invariant', `Досрочное завершение: ${message}`);
}

/** День расчёта — сегодня по МСК; тем же поясом границы считает портал (Р32). */
export function earlyEndAsOf(): string {
  return moscowDateKeyOf(new Date());
}
