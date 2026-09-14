import { eq, and } from 'drizzle-orm';
import {
  correctionAuthorizationScopeSchema,
  moscowDateKeyOf,
  type AssignmentOperationOutcome,
  type OperationInput,
  type WaybillCorrectionAuthorizationScope,
} from '@technic/contracts';
import type { db as AppDb } from '../db/client';
import { specialEquipmentRequestDetails, vehicleRequests, waybillCorrections } from '../db/schema';
import { writeAuditTx, type AuditEntry } from '../lib/audit';
import { AppError, err } from '../lib/errors';
import type { AssignmentEffects } from './assignment-effects';
import type { AssignmentTerm } from './assignment-history';
import {
  ASSIGNMENT_MODE_FROZEN_CODE,
  readAssignmentMode,
  requireOpenDoor,
  type AssignmentDoorClass,
  type AssignmentModeSnapshot,
} from './assignment-mode';
import {
  isSerializationFailure,
  withAssignmentRetry,
  type AssignmentRetryPolicy,
} from './assignment-retry';
import {
  assertAssignmentDenormalization,
  type AssignmentWriteResult,
  type AssignmentWriteTx,
} from './assignment-write';
import {
  correctionFingerprint,
  findCorrection,
  insertCorrection,
  linkCorrectionRequests,
  sameCorrectionOrThrow,
  saveCorrectionPayload,
  type CorrectionKind,
  type CorrectionRecord,
} from './waybill-correction';
import { lockRequestRow, lockRoutesOfRequest } from './vehicle-routes';

/**
 * Каркас канонической транзакции команды истории назначения
 * (`docs/assignment-periods-plan.md`, §8 — четырнадцать шагов; Р9, Р17, Р20, Р26, Р32).
 *
 * ЗАЧЕМ ОН ВООБЩЕ. Порядок §8 — не рекомендация и не стиль: каждый его шаг стоит там, где стоит,
 * из-за конкретного разбора. Отпечаток сверяется **один раз** и **после** расчёта последствий —
 * иначе неполный список разблокировок дал бы 422 там, где правильный ответ 409 «посмотрите
 * последствия заново». Повторный поиск операции стоит **под блокировкой** — иначе второй запрос с
 * тем же ключом упрётся в погашенную цель и ответит 422 вместо прежнего результата. Версия заявки
 * поднимается **в одном месте** — иначе `N → N+2`. Аудит пишется **в транзакции** — иначе остаётся
 * нетранзакционное окно, в котором работа сделана, а события нет.
 *
 * Дверей истории пять, и каждая из них способна нарушить любое из этих правил молча. Поэтому
 * порядок выражен кодом: дверь не пишет транзакцию, а заполняет её предметные места. Скелет
 * гарантирует физически:
 *
 * - **не пропустить гейт и блокировку** — дверь не получает транзакции раньше, чем шаги 0–1
 *   исполнены: до этого её колбэков просто не зовут;
 * - **не посчитать последствия до блокировки** — расчёт живёт в колбэке `plan`, а он вызывается
 *   после блокировок; транзакция приходит в него **только на чтение** (`insert`/`update`/`delete`
 *   в этой фазе бросают, см. `readOnlyTx`);
 * - **не записать аудит вне транзакции** — колбэк `audit` возвращает **данные** события, а пишет
 *   их скелет через `writeAuditTx`. Дверь, у которой на руках нет функции записи, не может
 *   ошибиться порядком;
 * - **не разойтись с денормализацией** — Р17 проверяется скелетом в конце шага 11, по живому
 *   состоянию и обеим записям сразу (`assertAssignmentDenormalization`);
 * - **не поднять версию дважды и не забыть поднять** — шаг 14 принадлежит скелету целиком.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Предметных правил: якорей (Р16), целей (Р10), рукопожатий (Р11), сверки бумаги
 * (шаг 12) и состояний готовности (Р26). Их приносят двери — каркас лишь держит для них места в
 * правильном порядке. Шаг 12 двери занимают по-своему: команда машиниста и правка срока сверяют
 * бумагу, периодная коррекция снимает ещё и подписи по `approvalClearRange`, ремонт переоформляет
 * починенные отрезки. Кто именно исполняет бумагу, решает **режим чтения**, а не дверь
 * ([assignment-paper.ts](./assignment-paper.ts), §10): в `legacy` — недельная сверка, в `history` —
 * отрезковый план через `applyEsm2SyncPlanAndAudit`. Событие `waybill.esm2_sync` в обоих случаях
 * пишет один владелец и в транзакции; шести внешних вызовов `auditEsm2Sync` после транзакции
 * больше нет.
 *
 * СОЕДИНЕНИЕ ПРИХОДИТ АРГУМЕНТОМ (Ю23): `executor` — то немногое, что нужно от базы, `transaction`.
 * В отличие от `assignment-write.ts`, этот модуль **импортирует прикладной пул транзитивно** — через
 * `vehicle-routes` (блокировки) и `lib/audit`. Это осознанный размен: канонический порядок держится
 * не тем, что где-то написан, а тем, что обе половины блокировки берутся из одного места (ADR 0050
 * п. 12), и подменяемая «зависимость блокировок» позволила бы двери подсунуть заглушку. Ядро
 * записи, которое понадобится maintenance-скрипту этапа 4, от пула по-прежнему свободно.
 */

type Tx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/** Кто исполняет транзакцию команды. Ровно то, что от базы нужно, — и ничего больше (Ю23). */
export type AssignmentCommandExecutor = Pick<typeof AppDb, 'transaction'>;

/** Транзакция команды: та же, что у ядра записи, — иначе их пришлось бы приводить друг к другу. */
export type AssignmentCommandTx = Tx & AssignmentWriteTx;

/**
 * Уровень изоляции транзакций модуля — решение **Б5** плана
 * (`docs/assignment-periods-plan.md`, §14c Б5; §7 «Транзакции предпросмотра и исполнения
 * открываются в `REPEATABLE READ`»; измерения — [отчёт спайка](../../../../docs/assignment-periods-spike.md),
 * §4.3–4.4).
 *
 * ЧТО ЛОМАЕТСЯ БЕЗ НЕГО. Пул уровня изоляции не задаёт ([client.ts](../db/client.ts)), то есть
 * транзакция идёт в `READ COMMITTED`, а там снимок берёт **каждый запрос по отдельности**. Команда
 * истории читает десятками запросов: назначение, историю изменений, срок, листы недели, документы
 * человека, характеристики машины. Правка справочника, закоммиченная соседом между двумя такими
 * запросами, видна второму и не видна первому — и план собирается из состояния, которого целиком
 * не существовало ни в один момент времени. Цена ошибки здесь не «неудобство»: этим планом
 * выписывается бумага строгой отчётности, и в бланк уходит гибрид — машина из одного мира,
 * удостоверение машиниста из другого. Сломается это молча, бумагой, а не отказом.
 *
 * ПОЧЕМУ ИМЕННО СНИМОК, А НЕ БЛОКИРОВКИ И НЕ ОДИН ЗАПРОС. Заблокировать на время планирования всё,
 * что оно читает, — значит заблокировать половину справочников портала ради одной команды. Собрать
 * всё одним запросом — значит переписать шесть дверей в один CTE и потерять правила, которые в них
 * выражены. `REPEATABLE READ` даёт то же свойство даром: снимок берётся на первом запросе
 * транзакции и живёт до её конца, и все четырнадцать шагов §8 смотрят в один и тот же мир.
 *
 * ЧЕМ ЗА ЭТО ПЛАТИМ И ЧЕМ ПЛАТА ПОКРЫТА. Под конкурентной записью PostgreSQL законно отвечает
 * `40001`: транзакция, дождавшаяся чужой блокировки, узнаёт, что её снимок устарел. Это штатный
 * исход, а не поломка, и лечит его протокол повторов
 * ([assignment-retry.ts](./assignment-retry.ts), В4) — обёртка вокруг **обеих** транзакций ниже.
 * Без него та же правка превратила бы всякую очередь в пятисотку человеку. Порядок захвата §8
 * («сначала рейсы и строка заявки, потом всё остальное») делает эту плату дешёвой: проигравший
 * ловит `40001` на первом же запросе после блокировки и выбрасывает 2–3 мс планирования, а не всю
 * транзакцию целиком (§4.3 спайка).
 *
 * ЧЕГО ЭТОТ УРОВЕНЬ НЕ ДЕЛАЕТ. Он **не** превращает `23505` в `40001`: гонка двух чистых вставок по
 * частичному UNIQUE истории отвечает нарушением уникальности в любой изоляции — снимок к проверке
 * уникальности отношения не имеет, индекс смотрит на незакоммиченное. Поэтому `23505` по-прежнему
 * означает ровно то, что о нём говорит протокол повторов: писателя, который пришёл к истории мимо
 * блокировки строки заявки, то есть ошибку в двери. Ловить его повтором здесь было бы не защитой, а
 * глушителем единственного сигнала о ней.
 *
 * ЕЩЁ ОДНО, ЧТО СТАЛО НЕСУЩИМ. Каркас спасает от этого `23505` не блокировкой шага 1 самой по
 * себе, а **связкой шагов 1 и 14**: в `READ COMMITTED` дождавшийся `FOR UPDATE` перечитывал строку
 * свежим снимком, а в `REPEATABLE READ` снимок остаётся старым — взятая блокировка сама по себе не
 * показывает чужую работу. Проигравшую спасает то, что победившая **обновила** строку заявки шагом
 * 14: её `FOR UPDATE` кончается `40001` до всякой вставки. Перестань шаг 14 поднимать версию у
 * какой-нибудь двери — и эта дверь начнёт писать историю по снимку, в котором чужой строки нет.
 */
const SNAPSHOT_ISOLATION = { isolationLevel: 'repeatable read' } as const;

/**
 * То же для предпросмотра плюс запрет записи на уровне базы.
 *
 * `readOnlyTx` перехватывает `insert`/`update`/`delete`, но не `execute`, и гарантия там честно
 * названа структурной, а не полной. `READ ONLY` закрывает и её: предпросмотр не блокирует строк
 * (ни `FOR UPDATE`, ни `FOR SHARE` он не берёт намеренно — см. разбор у
 * {@link previewAssignmentCommand}) и ничего не пишет, поэтому запрет ему ничего не стоит, а
 * попытка записать сырым SQL упрётся в отказ PostgreSQL там же, где сделана.
 */
const PREVIEW_ISOLATION = { ...SNAPSHOT_ISOLATION, accessMode: 'read only' } as const;

// ── Заявка под блокировкой ──

/**
 * Заявка, перечитанная под `FOR UPDATE` (шаг 3), — общий вход всех дверей.
 *
 * Срок читается тут же: команда истории без него не считает ни одного диапазона (Р11, Р24), а
 * второе чтение той же пары дат в двери разошлось бы с первым ровно в тот момент, когда срок правят
 * рядом. Архивность (`deletedAt`) не отвергается скелетом: дверь ремонта адресуется идентификатором
 * и архивную заявку открывает намеренно (Ц3), а обычная команда откажет сама.
 */
export interface LockedVehicleRequest {
  id: string;
  num: number;
  status: string;
  version: number;
  deletedAt: Date | null;
  /** Срок работ заказа спецтехники. `dateTo = null` читается как однодневный срок (Р24). */
  term: AssignmentTerm;
  assignmentHistoryState: 'empty' | 'materialized' | 'ready';
  assignmentHistoryValidatedOn: string | null;
  assignmentHistoryDirty: boolean;
}

// ── Контексты фаз ──

interface AssignmentCommandBase {
  /** Транзакция команды. В фазе расчёта — только на чтение. */
  tx: AssignmentCommandTx;
  /** Снимок режима, прочитанный шагом 0 той же строкой: второй запрос дал бы другое значение. */
  mode: AssignmentModeSnapshot;
  request: LockedVehicleRequest;
  /** Календарный ключ дня расчёта — один на всю команду и на её предпросмотр (Р32). */
  asOf: string;
  actor: { id: string };
}

/**
 * Шаги 4–6: чтение истории, листов и смен, материализация, разрешение цели, план и исход.
 *
 * `tx` здесь — читающий: запись до сверки отпечатка и авторизации оставила бы в базе состояние,
 * которое сама же команда сейчас отвергнет (Р20). Это не пожелание в комментарии — `insert`,
 * `update`, `delete` и вложенная транзакция в этой фазе бросают.
 */
export type AssignmentPlanContext = AssignmentCommandBase;

/** Что дверь обязана вернуть из расчёта: последствия, отпечаток и свой предметный план. */
export interface AssignmentPlanned<TPlan> {
  /**
   * Последствия команды (Р11, Р32) — считаются **один раз** и дальше только читаются: из них
   * скелет берёт исход, вид операции, снимок диапазонов для `payload` и — у двери, не объявившей
   * `requiresPreview`, — решение, спрашивать ли отпечаток.
   */
  effects: AssignmentEffects;
  /**
   * Отпечаток последствий, посчитанный сервером (Р20): по содержанию — даты, шкалы, значения,
   * `origin`, исход и единый `asOf`, — а не по идентификаторам, которых у расчётной истории нет.
   */
  fingerprint: string;
  /** Предметный план двери: бумага, разблокировки, предупреждения, снимаемые часы. */
  plan: TPlan;
}

/** Шаги 7–9 видят посчитанное, но ещё ничего не записано. */
export interface AssignmentAuthorizeContext<TPlan> extends AssignmentCommandBase {
  effects: AssignmentEffects;
  plan: TPlan;
}

/** Шаги 11–13: транзакция полная, операция журнала уже есть (или её не потребовалось). */
export interface AssignmentApplyContext<TPlan> extends AssignmentAuthorizeContext<TPlan> {
  /** Строка журнала коррекций; `null` — исход `none`, объяснять нечего (Р32). */
  operation: CorrectionRecord | null;
}

/** Шаги 12–13 видят и то, что записали предметные мутации. */
export interface AssignmentPaperContext<TPlan, TApplied> extends AssignmentApplyContext<TPlan> {
  applied: TApplied;
  write: AssignmentWriteResult;
}

/** Шаг 13: снимок операции и события — по всему, что случилось. */
export interface AssignmentAuditContext<TPlan, TApplied, TPaper> extends AssignmentPaperContext<
  TPlan,
  TApplied
> {
  paper: TPaper;
}

/**
 * Результат шага 11: что записало ядро и что дверь хочет пронести дальше.
 *
 * `write` обязателен, а не «если писали»: через ядро проходит **любая** команда истории, включая
 * ту, которая строк не пишет вовсе (первичный `history_wins` — Р31 запрещает ему историю). Ядро в
 * этом случае вызывается с пустым списком мутаций и своим намерением по денормализации — и именно
 * это даёт скелету обещание Р17, которое он проверит.
 */
export interface AssignmentMutationResult<TApplied> {
  write: AssignmentWriteResult;
  applied: TApplied;
}

// ── Спецификация команды ──

export interface AssignmentCommandSpec<TPlan, TApplied, TPaper> {
  /**
   * Класс двери для гейта режима (§10). У команд истории он всегда `history`; поле оставлено
   * явным, потому что ремонт и решение хвоста придут сюда же, а класс — решение, а не следствие.
   */
  door: AssignmentDoorClass;
  /**
   * Имя двери в цели операции (Р9). Входит в отпечаток команды рядом с идентификатором заявки:
   * заявка живёт в URL, а не в теле, и без неё один автор прислал бы то же тело с тем же ключом на
   * **другую заявку** и получил бы чужой результат.
   */
  journalDoor: string;
  requestId: string;
  actor: { id: string };
  /** Версия заявки из тела — оптимистическая блокировка, как у всех её дверей. */
  expectedVersion: number;
  /** Тело запроса, каким его разобрала схема: идёт в отпечаток команды (Р9). */
  body: unknown;
  /**
   * Envelope журнала из тела; `null` — тело его не принесло. Нужен ли он, решает исход (Р32), а не
   * схема: спрашивать причину у плановой смены машиниста с понедельника значило бы спрашивать
   * объяснение у обычного рабочего дня.
   *
   * Лишний envelope при исходе `none` каркас **терпит** и журнала не заводит — в отличие от лишнего
   * `unlockFingerprint`, который Д4 велит отвергать. Причина в разнице цены: отпечаток разблокировок
   * это заявка клиента на право сжечь чужие номера, а envelope приезжает от честного клиента,
   * которому предпросмотр показал `crew` секунду назад. Настоящее расхождение с предпросмотром
   * поймает шаг 7 своим 409 — и объяснит его человеку понятнее, чем 422 «уберите поле».
   */
  operation: OperationInput | null;
  /** Отпечаток последствий из тела; спрашивается сервером, а не схемой (§7). */
  previewFingerprint?: string | undefined;
  /**
   * Нужен ли этой команде подтверждённый предпросмотр (Р17). Не задан — прежний критерий каркаса
   * (непустые `effects.mutations`), и поведение дверей, которые его не задали, не меняется ни на
   * шаг.
   *
   * Вопрос здесь именно такой — «нужен ли предпросмотр», а не «есть ли последствия». Второй
   * пропустил бы ровно те команды, ради которых признак и заведён: у правки срока история пуста
   * при непустой бумаге (листы сгорают и выписываются, а строк нет), а у закрытия фактической
   * датой бывают пусты все измерения разом — заказ закрывают ровно его `date_to`, — хотя
   * последствия человек видел и мог увидеть устаревшими.
   *
   * Считается по **рассчитанному** плану: до шага 6 ответа на этот вопрос не существует, а
   * спрашивать его у тела значило бы верить клиенту в том, обязан ли он подтверждать.
   */
  requiresPreview?(planned: AssignmentPlanned<TPlan>): boolean;
  /**
   * Рейсы, названные телом запроса, — берутся тем же проходом шага 1, а не отдельным захватом
   * после: иначе две встречные команды «переставить заявку из A в B» и «из B в A» взяли бы одну
   * пару в двух порядках.
   */
  extraRouteIds?: readonly string[];
  /** День расчёта; по умолчанию — сегодня по МСК. Аргументом — ради воспроизводимых тестов. */
  asOf?: string;
  /**
   * Своя политика повторов на `40001` (В4); не задана — умолчание портала из настроек
   * (`ASSIGNMENT_RETRY_*`, [assignment-retry.ts](./assignment-retry.ts)).
   *
   * Поле оставлено дверям не ради разнообразия: у служебных прогонов этапа 4 профиль конкуренции
   * свой и известен заранее, а тестам протокола нужны нулевая пауза и предсказуемый потолок —
   * иначе проверка повторов зависела бы от `prod.env` того, кто её запускает. Боевые двери его не
   * задают: одна настройка на портал и есть смысл настройки.
   */
  retry?: AssignmentRetryPolicy | undefined;

  /** Шаги 4–6. */
  plan(ctx: AssignmentPlanContext): Promise<AssignmentPlanned<TPlan>>;
  /**
   * Шаг 8 — рукопожатия против **рассчитанного** плана: envelope операции, отпечаток множества
   * разблокировок, подтверждения предупреждений, отпечаток снимаемых часов. Стоит после сверки
   * `previewFingerprint` (шаг 7) намеренно: устаревший предпросмотр обязан кончиться 409
   * «посмотрите заново», а не 422 «подтвердите то, чего вы не видели».
   */
  handshake?(ctx: AssignmentAuthorizeContext<TPlan>): Promise<void> | void;
  /**
   * Шаг 9 — условная авторизация (403) и снимок требований, при которых операцию разрешили (Р9).
   *
   * Возвращает `authorizationScope` всегда, даже при исходе `none`: скелет сохранит его только
   * вместе со строкой журнала, а дверь не должна знать, в каком случае снимок понадобится.
   * Пересчитать его на повторе нельзя — операция, бывшая моложе тридцати дней при первом вызове, к
   * повтору успевает состариться.
   */
  authorize(
    ctx: AssignmentAuthorizeContext<TPlan>,
  ): Promise<WaybillCorrectionAuthorizationScope> | WaybillCorrectionAuthorizationScope;
  /**
   * Повтор (Р9 п. 4): цель заново **не разрешается** и план не считается — первая попытка предмет
   * уже изменила, — но права субъекта перепроверяются по сохранённому снимку. Молча отдать прежний
   * результат тому, у кого право успели отобрать, — та же утечка, что выполнить операцию без права.
   */
  authorizeRepeat(scope: WaybillCorrectionAuthorizationScope): Promise<void> | void;
  /**
   * Шаг 11 — предметные мутации: история через ядро записи (`applyAssignmentMutations`) и, если
   * Р17 велит, назначение своим полным путём.
   *
   * Сюда же — и только сюда — ложится запись готовности истории (`assignment_history_state`,
   * Р26): состояние это вывод из проверенных последствий, и считать его до мутаций нечего, а после
   * шага 13 — поздно, снимок операции уже записан. Три двери, положившие его в три разных места,
   * дали бы три разных ответа на вопрос «когда заявка стала `ready`».
   */
  mutate(ctx: AssignmentApplyContext<TPlan>): Promise<AssignmentMutationResult<TApplied>>;
  /**
   * Шаг 12 — сверка бумаги по **рассчитанному** scoped-плану и всё, что за ней следует: перепривязка
   * суточных отчётов, `syncLinearRouteDays`, проверка `frozen`, снятие подписей по
   * `approvalClearRange`, удаление `clearableFilledDays`, постусловие по `paperScope`.
   *
   * Кто исполняет бумагу, решает **режим чтения** (§10), и решает это общий модуль
   * [assignment-paper.ts](./assignment-paper.ts): в `legacy` — недельная сверка, в `history` —
   * отрезковый план. Порядок внутри шага значим сам по себе: `frozen` у операции задним числом —
   * отказ, откатывающий транзакцию, и проверять его после снятия подписей значило бы откатывать
   * уже сделанную работу.
   */
  syncPaper?(ctx: AssignmentPaperContext<TPlan, TApplied>): Promise<TPaper>;
  /**
   * Шаг 13 — чем дополнить снимок операции. Диапазоны Р11 скелет кладёт сам: они одинаковы у всех
   * команд, и забытый снимок обнаружился бы через месяцы, когда объяснять операцию будет нечем.
   */
  payload?(ctx: AssignmentAuditContext<TPlan, TApplied, TPaper>): Record<string, unknown>;
  /**
   * Шаг 13 — события журнала портала. Возвращаются **данными**: пишет их скелет и в транзакции.
   * Дверь, у которой на руках нет функции записи, не может ошибиться порядком.
   */
  audit(ctx: AssignmentAuditContext<TPlan, TApplied, TPaper>): AuditEntry | AuditEntry[];
}

/** Чем кончилась команда. Ответ HTTP дверь пересобирает из текущего состояния, а не отсюда (Р9). */
export interface AssignmentCommandOutcome<TApplied, TPaper> {
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  operation: CorrectionRecord | null;
  /** `null` на повторе: предметных мутаций там не происходит вовсе. */
  applied: TApplied | null;
  paper: TPaper | null;
  effects: AssignmentEffects | null;
  /** Версия заявки после команды; на повторе — та, что стоит сейчас. */
  version: number;
}

/**
 * Провести команду по канону §8.
 *
 * Шаги и их владельцы:
 *
 * ```
 *  0  гейт режима (`requireOpenDoor`)                     — скелет
 *  1  рейсы заявки → строка заявки                        — скелет
 *  2  повторный поиск операции ПОД блокировкой            — скелет
 *  3  перечитать заявку, сверить версию                   — скелет
 *  4–6 история, листы, смены; материализация; цель; план  — дверь (`plan`), только на чтение
 *  7  сверка `previewFingerprint` (409) — ровно один раз  — скелет (критерий — `requiresPreview`)
 *  8  рукопожатия против рассчитанного плана (422)        — дверь (`handshake`)
 *  9  условная авторизация (403) и снимок требований      — дверь (`authorize`)
 * 10  INSERT waybill_corrections + authorizationScope     — скелет, если исход ≠ `none`
 * 11  предметные мутации + проверка Р17                   — дверь (`mutate`) и скелет
 * 12  сверка бумаги и всё, что за ней                     — дверь (`syncPaper`)
 * 13  payload, связь операции с заявкой, аудит            — скелет по данным двери
 * 14  инкремент версии — единственное место               — скелет
 * ```
 */
// ── Счётчик исходов команд (наблюдаемость, волна 4.2) ──

/**
 * Чем кончилась команда — с точки зрения того, кто смотрит на график, а не на код.
 *
 * - `ok` / `repeat` — работа сделана либо это честный повтор по ключу (Р9);
 * - `frozen` — дверь закрыта режимом (`assignment_mode_frozen`, 503). Ненулевое значение вне окна
 *   выката означает, что заморозку забыли снять: портал при этом работает, а команды истории
 *   молча отказывают;
 * - `conflict` — 409: устаревший предпросмотр или разошедшаяся версия. Норма в обычной работе,
 *   тревога — при всплеске: значит двое правят одну заявку;
 * - `refused` — 422: отказ по существу (нет машиниста, не подтверждены последствия);
 * - `forbidden` — 403;
 * - **`serialization`** — `40001`/`40P01` из PostgreSQL, дошедший до человека. Главное число этой
 *   метрики. Спайк (§4.3 отчёта) измерил закон: при `W` одновременных писателях по одной строке
 *   `k`-й проходит с `k`-й попытки, и общей строкой для портала является в том числе счётчик
 *   номеров бланков — один на весь портал. С появлением протокола повторов (В4) эта метка означает
 *   ровно **исчерпание потолка**: `503` с `Retry-After`, а не 500. Успешный повтор сюда не
 *   попадает вовсе — он кончился `ok`, — а виден отдельной метрикой повторов
 *   ([assignment-retry.ts](./assignment-retry.ts)). Потолок, который план велит держать настройкой,
 *   а не константой, подбирается по этой паре: ненулевые исчерпания при потолке `N` означают, что
 *   боевое `W` выше `N`;
 * - `error` — всё остальное, то есть 500.
 *
 * Предпросмотр ({@link previewAssignmentCommand}) здесь не считается: он ничего не меняет, и его
 * отказ — это разговор с человеком в окне, а не событие портала. Считай мы его, всплеск `refused`
 * означал бы то ли беду, то ли то, что кто-то пять раз подряд посмотрел последствия.
 */
export type AssignmentCommandOutcomeKind =
  'ok' | 'repeat' | 'frozen' | 'conflict' | 'refused' | 'forbidden' | 'serialization' | 'error';

/**
 * Метка предпросмотров в счётчике повторов. Не «дверь», а фаза: см. разбор у
 * {@link previewAssignmentCommand}.
 */
const PREVIEW_DOOR = 'preview';

/** Ключ — «дверь|исход»: две метки в одной строке, разбирается печатью метрики. */
const outcomes = new Map<string, number>();

function bumpOutcome(door: string, kind: AssignmentCommandOutcomeKind): void {
  const key = `${door}|${kind}`;
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}

/**
 * Исходы команд истории с момента старта процесса — в `/metrics`.
 *
 * Счётчик процессный, а не запрос в базу: успешная команда следа в отдельной таблице не оставляет
 * (её след — строка истории и событие журнала среди сотен тысяч чужих), а отказ не оставляет
 * вовсе — транзакция откатилась. Считать их можно только там, где они происходят.
 */
export function assignmentCommandCounters(): {
  door: string;
  outcome: AssignmentCommandOutcomeKind;
  count: number;
}[] {
  return [...outcomes.entries()]
    .map(([key, count]) => {
      const [door = '', outcome = 'error'] = key.split('|');
      return { door, outcome: outcome as AssignmentCommandOutcomeKind, count };
    })
    .sort((a, b) =>
      a.door === b.door ? (a.outcome < b.outcome ? -1 : 1) : a.door < b.door ? -1 : 1,
    );
}

/** Обнуление — только тестам: прогон не должен зависеть от порядка файлов. */
export function resetAssignmentCommandCounters(): void {
  outcomes.clear();
}

/**
 * Во что записать отказ. Порядок проверок — от частного к общему: код `AppError` точнее его
 * статуса, а статус точнее «что-то упало».
 */
function classifyFailure(error: unknown): AssignmentCommandOutcomeKind {
  /*
   * Конфликт сериализации спрашивается ПЕРВЫМ и общим предикатом протокола повторов
   * ([assignment-retry.ts](./assignment-retry.ts)), а не своим перечнем кодов.
   *
   * Первым — потому что исчерпание повторов приходит сюда уже завёрнутым в `AppError` 503, а
   * последняя ошибка PostgreSQL лежит у него в `cause`: спроси мы сначала статус, исчерпание
   * считалось бы обычной недоступностью сервиса и метка `serialization` замолчала бы ровно в тот
   * день, когда протокол начал сдаваться. Общим предикатом — потому что вторая копия тех же двух
   * кодов разошлась бы с первой молча, и счётчик врал бы о собственном протоколе.
   */
  if (isSerializationFailure(error)) return 'serialization';
  if (!(error instanceof AppError)) return 'error';
  if (error.code === ASSIGNMENT_MODE_FROZEN_CODE) return 'frozen';
  if (error.statusCode === 409) return 'conflict';
  if (error.statusCode === 403) return 'forbidden';
  if (error.statusCode === 422 || error.statusCode === 400) return 'refused';
  return 'error';
}

export async function runAssignmentCommand<TPlan, TApplied, TPaper = void>(
  executor: AssignmentCommandExecutor,
  spec: AssignmentCommandSpec<TPlan, TApplied, TPaper>,
): Promise<AssignmentCommandOutcome<TApplied, TPaper>> {
  const asOf = spec.asOf ?? moscowDateKeyOf(new Date());

  /*
   * Транзакция объявлена функцией, а зовётся ниже — внутри `try`. Две причины, и обе по делу:
   * исхода внутри колбэка ещё нет (откат случается уже после возврата, и счётчик, поднятый там,
   * считал бы успехом транзакцию, которая не закоммитилась), а синхронный бросок самого
   * `executor.transaction` — пул исчерпан, соединение оборвано — обязан попасть в метрику так же,
   * как отклонённое обещание. `async` превращает первый в второе.
   */
  const command = async (): Promise<AssignmentCommandOutcome<TApplied, TPaper>> =>
    /*
     * Изоляция задаётся вторым аргументом `transaction` (см. `SNAPSHOT_ISOLATION` в шапке) — и в
     * этом единственном месте она достаётся всем шести дверям сразу: снимок обязан быть один на всё
     * планирование, а не свой у каждого запроса (Б5).
     */
    executor.transaction(async (raw): Promise<AssignmentCommandOutcome<TApplied, TPaper>> => {
      const tx = raw as AssignmentCommandTx;

      // 0. Гейт режима — первым запросом транзакции (Ж3, З3): не ради значения, а чтобы freeze
      //    дождался этой транзакции, а она не проскочила мимо freeze.
      const mode = await requireOpenDoor(tx, spec.door);

      // 1. Канонический порядок захвата (ADR 0050 п. 12): сначала все рейсы заявки, потом её строка.
      //    `lockRequestsOfWaybill` здесь не зовётся намеренно — он вход операций от листа и блокирует
      //    заявки первыми, то есть переворачивает канон.
      await lockRoutesOfRequest(tx, spec.requestId, spec.extraRouteIds ?? []);
      await lockRequestRow(tx, spec.requestId);

      // 2. Повторный поиск операции — ДО проверки версии (иначе retry получит 409) и ПОД
      //    блокировкой: два запроса с одним ключом оба не находят операцию до коммита первого, и
      //    второй, начав планирование, упрётся в погашенную цель — 422 вместо прежнего результата.
      if (spec.operation) {
        const prior = await findCorrection(tx, spec.operation.operationId);
        if (prior) {
          sameCommandOrThrow(prior, spec);
          await spec.authorizeRepeat(await storedScope(tx, prior.id));
          const request = await lockedRequest(tx, spec.requestId);
          return {
            repeated: true,
            operation: prior,
            applied: null,
            paper: null,
            effects: null,
            version: request.version,
          };
        }
      }

      // 3. Заявка перечитывается под блокировкой — до неё любое прочитанное значение было догадкой.
      const request = await lockedRequest(tx, spec.requestId);
      if (request.version !== spec.expectedVersion) throw err.conflict();

      // 4–6. Предмет двери. Транзакция уходит туда читающей: записать историю раньше проверок значило
      //      бы оставить в базе состояние, которое сама же команда сейчас отвергнет (Р20).
      const planned = await spec.plan({
        tx: readOnlyTx(tx),
        mode,
        request,
        asOf,
        actor: spec.actor,
      });
      const { effects } = planned;
      if (effects.asOf !== asOf) {
        throw internal(
          'последствия посчитаны другим днём, чем идёт команда: `asOf` один на команду',
        );
      }

      const authCtx: AssignmentAuthorizeContext<TPlan> = {
        tx,
        mode,
        request,
        asOf,
        actor: spec.actor,
        effects,
        plan: planned.plan,
      };

      // 7. Отпечаток — ровно здесь и ровно один раз. Сверять и до, и после предметных проверок
      //    значило бы иметь два разных ответа на вопрос «то ли состояние видел человек».
      requireFingerprint(spec, planned);

      // 8. Рукопожатия — после отпечатка: устаревший предпросмотр это 409, а не 422.
      await spec.handshake?.(authCtx);

      // 9. Условная авторизация: до неё команда уже знает свой исход, но ещё ничего не записала.
      const scope = await spec.authorize(authCtx);

      // 10. Строка журнала — до предметных мутаций и под уже взятыми блокировками (Р9): порядок
      //     `prepare → INSERT` разводит клинч двух дверей с одним ключом операции.
      const operation = effects.needsOperation
        ? await insertOperation(tx, spec, effects.operationOutcome, scope)
        : null;

      // 11. Предметные мутации — и сразу проверка Р17 по живому состоянию: историю и назначение
      //     сверяет скелет, потому что «не забыть сверить» держалось бы дисциплиной пяти дверей.
      const applyCtx: AssignmentApplyContext<TPlan> = { ...authCtx, operation };
      const mutated = await spec.mutate(applyCtx);
      await assertAssignmentDenormalization(tx, mutated.write.denormalization);

      // 12. Бумага и всё, что за ней. Кто исполняет — решает режим чтения (§10), и решает это
      //     общий модуль, а не дверь. Дверь без бумажных последствий колбэка не даёт вовсе.
      const paperCtx: AssignmentPaperContext<TPlan, TApplied> = {
        ...applyCtx,
        applied: mutated.applied,
        write: mutated.write,
      };
      const paper = (await spec.syncPaper?.(paperCtx)) as TPaper;

      // 13. Снимок операции, связь с заявкой и аудит — всё в этой же транзакции.
      const auditCtx: AssignmentAuditContext<TPlan, TApplied, TPaper> = { ...paperCtx, paper };
      if (operation) {
        await saveCorrectionPayload(tx, operation.id, {
          effects: effects.payload,
          ...(spec.payload?.(auditCtx) ?? {}),
        });
        // «Что делали с этой заявкой задним числом» спрашивают со стороны заявки, и связь операции с
        // ней — единственный ответ.
        await linkCorrectionRequests(tx, operation.id, [spec.requestId]);
      }
      for (const entry of toEntries(spec.audit(auditCtx))) {
        await writeAuditTx(tx, {
          actorUserId: spec.actor.id,
          entityType: 'vehicle_request',
          entityId: spec.requestId,
          ...entry,
        });
      }

      // 14. Версия — единственное место, где она растёт. Поднимается **любым** новым успешным
      //     выполнением, включая исход `none`: для команды без ключа операции версия и есть
      //     единственная защита от повторного применения. С `REPEATABLE READ` (Б5) у шага
      //     появилась вторая работа: этот `UPDATE` и есть то, обо что соседняя команда получает
      //     `40001` на шаге 1, — блокировка без него оставила бы ей старый снимок.
      const version = await bumpVersion(tx, spec, request.version);

      return {
        repeated: false,
        operation,
        applied: mutated.applied,
        paper,
        effects,
        version,
      };
    }, SNAPSHOT_ISOLATION);

  try {
    /*
     * Повторы живут ЗДЕСЬ, снаружи транзакции, и это единственное место, где они возможны (В4).
     *
     * Повторяется `command` целиком — вместе с шагами 4–6, то есть вместе с планированием: план,
     * посчитанный на снимке, который PostgreSQL только что объявил устаревшим, применять повторно
     * нельзя ни при каких условиях. Пока мы стояли в очереди за строкой заявки, соседняя команда
     * могла сменить машину, погасить строку истории или выписать лист — и наш план описывает
     * состояние, которого больше нет. Повторное планирование видит новый снимок, и дальше исход
     * решается сам собой: состояние действительно изменилось — шаг 7 ответит 409 по отпечатку и
     * никакого повтора не будет (`withAssignmentRetry` ловит только `40001`/`40P01`); состояние то
     * же — команда пройдёт со второй попытки, и человек не узнает, что была первая.
     *
     * Обёртка снаружи, а не внутри транзакции, по той же причине, по какой сама транзакция
     * объявлена функцией: повторять нужно открытие транзакции, а не её тело — тело абортированной
     * транзакции уже не выполняется, её снимок не оживить, и каждое чтение обязано повториться в
     * новой.
     */
    const outcome = await withAssignmentRetry(spec.journalDoor, command, spec.retry);
    bumpOutcome(spec.journalDoor, outcome.repeated ? 'repeat' : 'ok');
    return outcome;
  } catch (error) {
    // Считаем и бросаем дальше: наблюдение не имеет права менять поведение двери, иначе первый же
    // сбой метрики стал бы сбоем портала.
    bumpOutcome(spec.journalDoor, classifyFailure(error));
    throw error;
  }
}

// ── Предпросмотр: те же шаги 4–6 и ни одной записи ──

/**
 * Что нужно предпросмотру. Форма — подмножество боевой спецификации, поэтому дверь передаёт сюда
 * **тот же объект**: расчёт обязан идти по тем входам, по которым его потом исполнит боевая ручка,
 * а вторая копия колбэка разошлась бы с первой на первом же новом поле.
 */
export interface AssignmentPreviewSpec<TPlan> {
  requestId: string;
  actor: { id: string };
  asOf?: string | undefined;
  /** Та же политика повторов, что у боевой команды; не задана — умолчание портала. */
  retry?: AssignmentRetryPolicy | undefined;
  plan(ctx: AssignmentPlanContext): Promise<AssignmentPlanned<TPlan>>;
}

export interface AssignmentPreviewOutcome<TPlan> extends AssignmentPlanned<TPlan> {
  request: LockedVehicleRequest;
  mode: AssignmentModeSnapshot;
  asOf: string;
}

/**
 * Предпросмотр команды — расчёт без единой записи (Р20).
 *
 * Отличий от боевого пути ровно три, и все три обоснованы:
 *
 * - **не пишет** — транзакция уходит в `plan` читающей, как и в бою, а после расчёта не происходит
 *   ничего. Предпросмотр вызывается дважды подряд (двухфазность Р16: сперва без якорей, ради
 *   `requiredAnchors`, потом с ними), и записывающий предпросмотр означал бы две записи на одно
 *   человеческое действие;
 * - **не блокирует заявку** — `FOR UPDATE` на время расчёта останавливал бы работу по заявке ради
 *   вопроса «что будет, если», а защищает боевую ручку не блокировка предпросмотра, а отпечаток:
 *   изменилось состояние — отпечаток разошёлся — 409;
 * - **не спрашивает гейт `FOR SHARE`** — режим читается без блокировки: закрытая на запись дверь
 *   по-прежнему показывает последствия, и это правильный порядок разговора с человеком («модуль
 *   закрыт» он услышит при попытке применить, а не вместо ответа на вопрос).
 *
 * Всё остальное — то же самое и тем же колбэком: `asOf`, срок, чтение истории и расчёт последствий.
 */
export async function previewAssignmentCommand<TPlan>(
  executor: AssignmentCommandExecutor,
  spec: AssignmentPreviewSpec<TPlan>,
): Promise<AssignmentPreviewOutcome<TPlan>> {
  const asOf = spec.asOf ?? moscowDateKeyOf(new Date());
  /*
   * Протокол повторов (В4) держит и предпросмотр: «в этой изоляции работают ВСЕ двери, зовущие
   * общий план», и расчёт, сорванный чужим коммитом, обязан пересчитаться, а не показать человеку
   * пятисотку в ответ на вопрос «что будет, если». Повторяется здесь ровно то же, что и в бою, —
   * транзакция вместе с расчётом.
   *
   * Метка счётчика у всех предпросмотров одна (`preview`), а не своя на каждую дверь: разбор у них
   * общий и цена ошибки другая. Повтор предпросмотра выбрасывает расчёт и ничего больше; повтор
   * боевой команды выбрасывает работу под блокировкой заявки. Смешать эти два числа в одной метке
   * значило бы смотреть на график, по которому не отличить дорогое от дешёвого.
   */
  return withAssignmentRetry(
    PREVIEW_DOOR,
    () =>
      /*
       * Снимок тот же, что у боевой команды (Б5), плюс `READ ONLY` (`PREVIEW_ISOLATION`): человеку
       * показывается то, что потом подтверждается отпечатком, и разойтись эти два расчёта не должны
       * из-за изоляции — иначе 409 «посмотрите последствия заново» начал бы приходить на состояние,
       * которое никто не менял.
       */
      executor.transaction(async (raw): Promise<AssignmentPreviewOutcome<TPlan>> => {
        const tx = raw as AssignmentCommandTx;
        const mode = await readAssignmentMode(tx);
        const request = await lockedRequest(tx, spec.requestId);
        const planned = await spec.plan({
          tx: readOnlyTx(tx),
          mode,
          request,
          asOf,
          actor: spec.actor,
        });
        if (planned.effects.asOf !== asOf) {
          throw internal('последствия посчитаны другим днём, чем идёт предпросмотр');
        }
        return { ...planned, request, mode, asOf };
      }, PREVIEW_ISOLATION),
    spec.retry,
  );
}

// ── Шаги, принадлежащие скелету ──

/** Заявка под блокировкой вместе со сроком: два запроса свёл бы в один join, но их и так два. */
async function lockedRequest(
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
  // История нужна заказу спецтехники; грузоперевозке она не нужна вовсе (Р20), и срока с рабочими
  // днями у неё нет — считать по ней диапазоны было бы нечем.
  if (row.requestType !== 'special_equipment' || row.dateFrom === null) {
    throw err.unprocessable('История назначения ведётся только у заказа спецтехники');
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

/**
 * Шаг 7. Нужен ли отпечаток, решает признак двери — а если она его не объявила, прежний критерий
 * каркаса (Р17).
 *
 * УМОЛЧАНИЕ. Отпечаток требуется у любой команды с **непустой историей** назначения
 * (`effects.mutations`) — включая ту, у которой бумажный план пуст (дремлющее изменение, Р24).
 * Так каркас жил, пока дверей было три, и для них ничего не меняется.
 *
 * ПОЧЕМУ УМОЛЧАНИЯ МАЛО. «Непустая история» и «человеку есть что подтверждать» — разные вещи. У
 * правки срока строк истории не бывает вовсе при непустой бумаге, и до этого этапа она обходила
 * критерий своим рукопожатием. Дверей с таким свойством скоро четыре (закрытие фактической датой
 * и обе применяющие ветви досрочного завершения), и четыре расходящиеся копии одной проверки
 * стоили бы дороже, чем признак в каркасе. Поэтому дверь объявляет `requiresPreview` и отвечает
 * им на вопрос «нужен ли предпросмотр», а не «есть ли последствия»: последний снова пропустил бы
 * закрытие ровно по `date_to`, у которого пусты все измерения, хотя предпросмотр человек смотрел
 * и мог смотреть вчерашний.
 *
 * Отсутствие отпечатка — это 409, а не 400: пуста команда или нет, видно только после расчёта под
 * блокировкой, и схема, потребовавшая его у всех, отвечала бы 400 там, где сервер обязан ответить
 * понятным «посмотрите последствия заново».
 *
 * Экспортирована ради чистого теста самого критерия: обе его ветви иначе доказывались бы только
 * сценами дверей — дорого и не для всякой ветви достижимо.
 */
export function requireFingerprint<TPlan>(
  /* Из всей спецификации шагу 7 видны ровно два поля: присланный отпечаток и признак двери. */
  spec: Pick<
    AssignmentCommandSpec<TPlan, unknown, unknown>,
    'previewFingerprint' | 'requiresPreview'
  >,
  planned: AssignmentPlanned<TPlan>,
): void {
  const needsFingerprint = spec.requiresPreview?.(planned) ?? planned.effects.mutations.length > 0;
  if (!needsFingerprint) return;
  if (spec.previewFingerprint !== planned.fingerprint) {
    throw err.conflict(
      'Последствия изменились с момента предпросмотра — посмотрите их заново и подтвердите',
      { code: 'assignment_preview_stale' },
    );
  }
}

/**
 * Шаг 10. Строка журнала — внутри транзакции команды и после блокировок.
 *
 * Пишет её **общий журнал коррекций** ([waybill-correction.ts](./waybill-correction.ts)), а не
 * этот файл: та же таблица, тот же отпечаток, та же проверка повтора, что у входов ADR 0101.
 * Каркасу принадлежит только порядок — блокировки, повторный поиск операции под ними, и лишь потом
 * `INSERT` (Р9, «протокол `prepare/lock`»): `runCorrection` вставляет строку **до** `perform`, а
 * предмет блокирует уже он сам, и две двери с одним ключом операции встают в клинч. Своя копия
 * `INSERT` здесь была бы вторым путём в одну таблицу — тем самым, из-за которого следующая колонка
 * появилась бы у команд истории и не появилась бы у остальных входов.
 *
 * Вид операции выводится из исхода и только из него (Р32): `crew` и `assignment_tail` — не синонимы
 * календаря, а два разных набора требований.
 */
async function insertOperation<TPlan, TApplied, TPaper>(
  tx: AssignmentCommandTx,
  spec: AssignmentCommandSpec<TPlan, TApplied, TPaper>,
  outcome: AssignmentOperationOutcome,
  scope: WaybillCorrectionAuthorizationScope,
): Promise<CorrectionRecord> {
  const envelope = spec.operation;
  if (!envelope) {
    // Исход спрашивает объяснение, а тело его не принесло. Схемой это не выражается — исход
    // считается под блокировкой (Р32), — поэтому отказ здесь и он машинно-читаемый.
    throw err.unprocessable('Операция требует причины и ключа: укажите их и повторите', {
      operation: 'Требуется причина операции',
    });
  }
  const kind = operationKindOf(outcome);
  return insertCorrection(tx, {
    operationId: envelope.operationId,
    fingerprint: commandFingerprint(spec, kind),
    kind,
    reason: envelope.reason,
    actorUserId: spec.actor.id,
    // Снимок передаётся всегда, а не «когда пригодится»: у обоих видов истории он обязателен по
    // CHECK таблицы, а пересчитать его на повторе нечем (Р9).
    authorizationScope: scope,
  });
}

/** Вид операции журнала выводится из исхода (Р32) и больше ниоткуда. */
function operationKindOf(outcome: AssignmentOperationOutcome): CorrectionKind {
  if (outcome === 'crew') return 'crew';
  if (outcome === 'assignment_tail') return 'assignment_tail';
  throw internal('операция без исхода: `none` журнала не заводит');
}

/**
 * Отпечаток команды для журнала (Р9): вид, **цель** и тело.
 *
 * Цель входит отдельным полем — `{ door, requestId }`, — потому что заявка живёт в URL, а не в
 * теле: без неё один автор прислал бы то же тело с тем же ключом на другую заявку и получил бы
 * чужой результат. Дверь в цели названа рядом с заявкой: у ремонта и у команды машиниста тела
 * бывают неотличимы, а исход разный.
 */
function commandFingerprint<TPlan, TApplied, TPaper>(
  spec: AssignmentCommandSpec<TPlan, TApplied, TPaper>,
  kind: CorrectionKind,
): string {
  return correctionFingerprint({
    kind,
    target: { door: spec.journalDoor, requestId: spec.requestId },
    body: spec.body,
  });
}

/**
 * Тот же ли это запрос (Р9). Проверяются оба признака: автор и отпечаток тела с целью.
 *
 * Отпечаток пересчитывается **по `prior.kind`**, а не по сегодняшнему исходу: исхода на повторе не
 * считают вовсе — предмет операции переписан ею самой.
 */
function sameCommandOrThrow<TPlan, TApplied, TPaper>(
  prior: CorrectionRecord & { fingerprint: string },
  spec: AssignmentCommandSpec<TPlan, TApplied, TPaper>,
): void {
  // Проверяет общий журнал: слова отказа «это не повтор» в портале одни на все входы, и вторая их
  // копия разошлась бы с первой ровно тогда, когда человек читает отказ.
  sameCorrectionOrThrow(prior, {
    actorUserId: spec.actor.id,
    fingerprint: commandFingerprint(spec, prior.kind),
  });
}

/**
 * Снимок требований сохранённой операции (Р9).
 *
 * Разбирается схемой, а не читается как есть: снимок пишется однажды и читается спустя недели, и
 * версия состава — единственное, что отличает «прав не хватает» от «формат снимка изменился».
 * Новый вид операции без снимка — внутренняя ошибка (её же держит CHECK таблицы), а не повод
 * пересчитать права по текущему состоянию: пересчёт и есть та дыра, ради которой снимок заведён.
 */
async function storedScope(
  tx: AssignmentCommandTx,
  correctionId: string,
): Promise<WaybillCorrectionAuthorizationScope> {
  const [row] = await tx
    .select({ scope: waybillCorrections.authorizationScope })
    .from(waybillCorrections)
    .where(eq(waybillCorrections.id, correctionId));
  const parsed = correctionAuthorizationScopeSchema.safeParse(row?.scope);
  if (!parsed.success) {
    throw internal('у операции истории нет снимка авторизации: повтор проверить нечем');
  }
  return parsed.data;
}

/**
 * Шаг 14. Инкремент версии — CAS по той же версии, что сверялась шагом 3.
 *
 * Единственное место: сегодня инкремент сидит внутри предметной мутации смены назначения, и через
 * неё же пойдут обычная смена машины и первичный `history_wins`. Оставить оба места — значит
 * получить `N → N+2` или конфликт на втором CAS.
 */
async function bumpVersion<TPlan, TApplied, TPaper>(
  tx: AssignmentCommandTx,
  spec: AssignmentCommandSpec<TPlan, TApplied, TPaper>,
  version: number,
): Promise<number> {
  const [row] = await tx
    .update(vehicleRequests)
    .set({ version: version + 1, updatedBy: spec.actor.id, updatedAt: new Date() })
    .where(and(eq(vehicleRequests.id, spec.requestId), eq(vehicleRequests.version, version)))
    .returning({ version: vehicleRequests.version });
  if (!row) throw err.conflict();
  return row.version;
}

// ── Читающая транзакция фазы расчёта ──

const WRITERS = new Set(['insert', 'update', 'delete', 'transaction']);

/**
 * Транзакция, которой нельзя писать.
 *
 * Прокси, а не сужение типа: план двери зовёт существующие сервисы (сверка, листы, смены), а они
 * объявлены на полной транзакции, и урезанный тип заставил бы приводить её обратно в каждом вызове
 * — то есть обходить правило первым же приведением. Прокси ловит попытку там, где она сделана, и
 * называет правило: до сверки отпечатка и авторизации команда ничего не записывает (Р20).
 *
 * `execute` не перехвачен намеренно: им читают сырым SQL то, чего drizzle не выражает (`FOR SHARE`,
 * оконные функции). Запретить его значило бы запретить половину расчётов; гарантия здесь —
 * структурная («писать нечем в обычном пути»), а не полная.
 */
export function readOnlyTx<T extends object>(tx: T): T {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITERS.has(prop)) {
        return () => {
          throw internal(
            `фаза расчёта ничего не записывает: \`${prop}\` до сверки отпечатка и авторизации`,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function toEntries(entries: AuditEntry | AuditEntry[]): AuditEntry[] {
  return Array.isArray(entries) ? entries : [entries];
}

/** Нарушение канона, а не запроса: такое состояние создаёт код двери, и читает отказ разработчик. */
function internal(message: string): AppError {
  return new AppError(500, 'assignment_command_invariant', `Команда истории: ${message}`);
}
