import { z } from 'zod';
import { WASTE_TICKET_FIELDS, type WasteTicketField } from './waste-tickets';

// ── Аудит распознавания талонов (ADR 0137, миграция 0210) ──
//
// Здесь только формы ответов и параметров. Смысл каждого числа — в словаре метрик
// (`docs/waste-ticket-audit-plan.md`, §1), и всякое поле ниже ссылается на строку словаря: число
// без определения на экран не попадает, потому что доля, посчитанная неизвестно от чего, читается
// как знание.

/**
 * Исход наблюдения — первое человеческое РЕШЕНИЕ, адресованное машинному чтению (§1.2).
 *
 * `arbitrated` здесь нет намеренно: арбитраж слепой перепроверки — событие оценки, а не решения.
 * Разреши мы ему назначать исход, независимая проверка задним числом двигала бы долю исправлений,
 * то есть измерение меняло бы измеряемое.
 */
export const TICKET_OBSERVATION_OUTCOMES = [
  'corrected',
  'accepted',
  'resolved_dispute',
  'proposal_accepted',
  'dismissed',
  'superseded',
  'pending',
  'lost',
  'uninformative',
  'not_attributed',
] as const;

export type TicketObservationOutcome = (typeof TICKET_OBSERVATION_OUTCOMES)[number];

/** Период считается по времени НАБЛЮДЕНИЯ, не правки, и по московским суткам (§1.3). */
export const ticketAuditPeriodSchema = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'Начало периода позже конца', path: ['from'] });

export type TicketAuditPeriod = z.infer<typeof ticketAuditPeriodSchema>;

/**
 * Строка сводки по одному полю.
 *
 * Числитель и знаменатель раздельными полями, а не готовой долей: при десятках талонов доля
 * скачет на единицы процентов от одного исправления, и показывать её без знаменателя — значит
 * предлагать верить проценту, посчитанному по трём случаям.
 */
export interface TicketAuditFieldRow {
  field: WasteTicketField;
  /** Наблюдений всего по полю за период — знаменатель долей «не прочитано» и «спорных». */
  observations: number;
  /** Человек изменил прочитанное моделью значение. */
  corrected: number;
  /** Знаменатель доли исправлений: `corrected + accepted` (§1.4). Прочие исходы сюда не идут. */
  decided: number;
  /** Поле было спорным и пустым, человек назвал значение. Не исправление (§1.2). */
  resolvedDispute: number;
  /** Модель не прочитала поле; законная пустота (простой) сюда не входит. */
  unreadable: number;
  /**
   * Проходы каскада разошлись. `null` у вида работ и адреса: каскад их не сверяет вовсе, и ноль
   * означал бы «спора не было», а правда — «спор здесь не определён».
   */
  disputed: number | null;
}

/** Разложение наблюдений периода по исходам — то, что стоит над таблицей полей. */
export interface TicketAuditOutcomeCounts {
  total: number;
  /** Решено человеком: исправлено, принято как есть, разобран спор, принято предложение. */
  resolved: number;
  pending: number;
  superseded: number;
  dismissed: number;
  lost: number;
  /** Наблюдения предложений без полевого исхода: повторившие талон и поля отклонённого (§1.2.1). */
  outOfScope: number;
}

export interface TicketAuditSummaryDto {
  period: TicketAuditPeriod;
  /**
   * Дата первого наблюдения второй версии сбора. Всё, что собрано раньше, в метрики не идёт, и
   * экран обязан это сказать: отчёт начинается не с начала работы портала.
   */
  collectingSince: string | null;
  observations: TicketAuditOutcomeCounts;
  fields: readonly TicketAuditFieldRow[];
  /**
   * Предложения перераспознавания считаются ПРЕДЛОЖЕНИЯМИ, а не полями: отказ говорит лишь
   * «хотя бы одно из отличавшихся значений неприемлемо», и разложить его по пяти полям нельзя.
   */
  proposals: { accepted: number; rejected: number };
  /** Поле правили дважды и более: вторая правка — не вторая ошибка машины (§1.2). */
  repeatedEdits: number;
  /**
   * Доля наблюдений, чей исход неизвестен из-за удаления талона. Порог назван числом: выше 2 % за
   * 30 дней — повод вернуться к вопросу о событии подтверждения (§1.2).
   */
  lostShare: number;
}

/** Порог, выше которого сводка печатает предупреждение о потерянных исходах (§1.2). */
export const TICKET_AUDIT_LOST_WARNING_SHARE = 0.02;

/** Ниже этого числа наблюдений процент не печатается вовсе — печатается «данных недостаточно». */
export const TICKET_AUDIT_MIN_SAMPLE = 30;

/** Поля сводки в порядке бланка: обход обязан быть устойчивым, иначе строки прыгают. */
export const TICKET_AUDIT_FIELDS: readonly WasteTicketField[] = WASTE_TICKET_FIELDS;

/** Спор каскад сверяет только по трём полям — у остальных `disputed` не определён (§1.4). */
export const TICKET_AUDIT_DISPUTED_FIELDS: readonly WasteTicketField[] = [
  'number',
  'issuedOn',
  'volumeM3',
];

// ── Экран 2: сигналы по производственным когортам (§5.2) ──
//
// Название честное: A/B не проводится, конфигурации видят разный поток, и сравнивать их доли
// напрямую нельзя. Экран этого и не предлагает — он показывает, ЧТО происходит в каждой когорте,
// а вывод «модель X лучше модели Y» требует прогонки одной выборки обеими и здесь не делается.

/**
 * Когорта — конфигурация конвейера целиком, а не модель.
 *
 * Наблюдение, прочитанное обеими ступенями одинаково, и спорное не принадлежат одной модели:
 * приписать их любой из двух — значит выдумать число. Конфигурации же не пересекаются, и сумма по
 * ним равна целому, что и проверяется тестом.
 */
export interface TicketAuditCohortRow {
  /** Снимок фактической модели первого прохода; пусто — модель себя не назвала. */
  primaryModel: string;
  /** Фактическая модель второй ступени; `null` — эскалации в этой когорте не было. */
  escalationModel: string | null;
  promptVersion: number | null;
  preprocessingVersion: number | null;
  /** Разборов: групп по пять полей. По ним считается «сколько раз читали», а не по наблюдениям. */
  runs: number;
  observations: number;
  corrected: number;
  /** Знаменатель доли исправлений — тот же, что в сводке: `corrected + accepted`. */
  decided: number;
  unreadable: number;
}

/**
 * Каскад: что дала вторая ступень и чем кончились споры.
 *
 * Слова «арбитраж» здесь нет намеренно. Спорное поле нельзя подтвердить, не разобрав, разбор
 * ставит отметку правки, а выборка слепой перепроверки исключает правленые талоны — независимый
 * арбитр спора каскада не увидит никогда. Исходы поэтому названы операторскими: это полезный
 * сигнал, но не независимый, и звать его арбитражем значило бы приписать ему чужую силу.
 */
export interface TicketAuditCascade {
  /** Разборов, где отработала вторая ступень. */
  runsWithEscalation: number;
  /** Полей, пустых после первого прохода (в разборах с эскалацией). */
  emptyAfterPrimary: number;
  /** Из них заполненных вторым проходом. */
  filledBySecond: number;
  disputes: number;
  disputeOutcomes: {
    /** Оператор выбрал значение первого прохода. */
    primary: number;
    /** Оператор выбрал значение второго. */
    escalation: number;
    /** Оператор ввёл третье значение: ошиблись оба прохода. */
    third: number;
    unresolved: number;
  };
}

export interface TicketAuditCohortsDto {
  period: TicketAuditPeriod;
  cohorts: readonly TicketAuditCohortRow[];
  cascade: TicketAuditCascade;
}

// ── Экран 3: лента событий (§5.3) ──
//
// Показываются ВСЕ типы событий, а не одни правки. Для настройки промпта спор и непрочитанное поле
// говорят не меньше исправления, а отклонённое предложение — самый сильный отрицательный сигнал о
// новой модели. Лента, показывающая только правки, отвечала бы на вопрос «где человек работал», а
// не «что путает машина».

export const TICKET_AUDIT_EVENTS = [
  'recognized',
  'disputed',
  'edited',
  'proposal',
  'proposal_dismissed',
  'arbitrated',
  'dismissed',
] as const;

export type TicketAuditEvent = (typeof TICKET_AUDIT_EVENTS)[number];

/** Фильтры ленты. Пустой фильтр не сужает: «все поля» и «поле не выбрано» — одно и то же. */
export const ticketAuditEventsQuerySchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    field: z.enum(WASTE_TICKET_FIELDS).optional(),
    event: z.enum(TICKET_AUDIT_EVENTS).optional(),
    /** Фактическая модель наблюдения: сравнивать промпты имеет смысл внутри одной модели. */
    model: z.string().trim().min(1).max(200).optional(),
    promptVersion: z.coerce.number().int().min(0).max(9999).optional(),
    preprocessingVersion: z.coerce.number().int().min(0).max(9999).optional(),
    /** Поиск по номеру заявки: разбор начинается с «покажи вот эту бумагу». */
    requestNum: z.string().trim().min(1).max(64).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(10).max(200).default(50),
  })
  .strict();

export type TicketAuditEventsQuery = z.infer<typeof ticketAuditEventsQuerySchema>;

export interface TicketAuditEventRow {
  id: string;
  at: string;
  field: WasteTicketField;
  event: TicketAuditEvent;
  /** Значения как показаны человеку: «прочитано 3, верно 38» — это и есть материал для промпта. */
  oldValue: string | null;
  newValue: string | null;
  /** `null` у машинных событий и там, где учётку удалили: след теряется, событие остаётся. */
  actorName: string | null;
  /** Снимок фактической модели чтения; пусто — модель себя не назвала. */
  model: string;
  promptVersion: number | null;
  preprocessingVersion: number | null;
  requestId: string | null;
  requestNum: string | null;
  /**
   * Прочитала ли модель поле: `read`, `unreadable` или `not_applicable` (объём простоя). У
   * человеческих событий — `null`.
   *
   * Без него пустое машинное чтение в ленте неотличимо: «модель не смогла» и «графы на бланке нет»
   * выглядят одинаково пустой строкой, а это разные новости — первая про качество чтения, вторая
   * про бланк.
   */
  readState: 'read' | 'unreadable' | 'not_applicable' | null;
  /**
   * Куда смотреть человеку. Ссылка живёт, пока жив файл, — талон и заявку она переживает: разбор
   * ошибки без картинки бессмыслен. `null` означает «скан недоступен», и это состояние экрана, а
   * не молчание.
   */
  fileId: string | null;
  pageNo: number | null;
}

export interface TicketAuditEventsDto {
  rows: readonly TicketAuditEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Экран 5: точность среди неисправленных подтверждённых талонов (§3, §5.5) ──
//
// Показатель назван длинно намеренно. В слепую выборку попадают только машинные талоны, которых
// первый оператор не исправлял, — известные ошибки модели в неё не входят. Короткое имя
// «точность» читалось бы как общая точность потока и было бы неправдой.

export interface TicketAuditAccuracyField {
  field: 'number' | 'issuedOn' | 'volumeM3';
  /** Два независимых чтения совпали. Считается верным: слепое согласие — свидетельство. */
  matched: number;
  diverged: number;
  arbitrated: number;
  /** Итог арбитра совпал с машинным чтением. */
  machineRight: number;
  /** Итог совпал с чтением проверяющего. */
  checkerRight: number;
  /**
   * Итог не совпал ни с одним. Исход, которого нет, если считать спор выбором из двух: арбитр
   * присылает значения, а не выбор, поэтому «ошиблись оба» выразимо и обязано быть видно.
   */
  bothWrong: number;
}

export interface TicketAuditAccuracyDto {
  period: TicketAuditPeriod;
  issued: number;
  returned: number;
  waitingChecker: number;
  waitingArbitration: number;
  fields: readonly TicketAuditAccuracyField[];
}

/** Верных чтений по полю: совпадения плюс те расхождения, где арбитр признал правой машину. */
export function accuracyRight(row: TicketAuditAccuracyField): number {
  return row.matched + row.machineRight;
}

/** Знаменатель: совпадения плюс РАЗОБРАННЫЕ расхождения. Неразобранные не считаются никак. */
export function accuracyDenominator(row: TicketAuditAccuracyField): number {
  return row.matched + row.arbitrated;
}

/**
 * Доверительный интервал Уилсона.
 *
 * Считается здесь, а не на экране, чтобы у сервера, ленты выгрузки и портала он был один. Важно
 * помнить, что он меряет: только случайный разброс внутри этой смещённой выборки. Самого смещения
 * (в выборку не попадают талоны, которые исправляли) интервал не измеряет и измерить не может —
 * подпись об этом обязана стоять рядом с числом.
 */
export function wilsonInterval(k: number, n: number, z = 1.959964): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

// ── Экран 4: состояние подсистемы (§5.4) ──
//
// Единственный экран раздела, который живёт НЕ в когорте периода: очередь и состояние — снимок
// «сейчас», а попытки считаются по времени вызова фиксированным окном. Смешать их с наблюдениями
// значило бы сложить разные величины (§1.3).

export const TICKET_AUDIT_SUBSYSTEM_STATES = [
  'ok',
  'degraded',
  'disabled',
  'unconfigured',
] as const;
export type TicketAuditSubsystemState = (typeof TICKET_AUDIT_SUBSYSTEM_STATES)[number];

/** Окно, за которое считаются вызовы и отказы. Не период отчёта: цена вопроса — «как сейчас». */
export const TICKET_AUDIT_OPERATIONS_DAYS = 7;

export interface TicketAuditOperationsDto {
  state: TicketAuditSubsystemState;
  /** Момент ответа: без него экран состояния читается как «прямо сейчас» и врёт при вкладке, открытой со вчера. */
  generatedAt: string;
  /** Последний успешный вызов; `null` — успешных не было вовсе. */
  lastSuccessAt: string | null;
  /** Отказов за последний час: «сбоев не обнаружено» — это про час, а не про всё время. */
  failuresLastHour: number;
  window: {
    days: number;
    /** Вызовов прокси: строка попытки. Не «платных» — отказ до модели оплачен не будет, а строку создаст. */
    calls: number;
    failures: number;
    /** Разборов, не потребовавших вызова. */
    cacheHits: number;
    tokens: number;
    /** Отказы по парам «класс × область»: transient/subsystem и terminal/item — разные беды. */
    failureCodes: readonly { errorClass: string; errorScope: string; count: number }[];
  };
  queue: {
    waiting: number;
    running: number;
    failed: number;
    dead: number;
    /** Возраст старейшей ждущей задачи в минутах; `null` — очередь пуста. */
    oldestMinutes: number | null;
  };
  /** Заявок с приложенными талонами, ждущими разбора. */
  requestsAwaitingReview: number;
  /** Строк журнала наблюдений: срок хранения не задан, и размер обязан быть виден. */
  journalRows: number;
}
