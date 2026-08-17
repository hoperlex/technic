import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { DEFAULT_MAIL_ACCOUNT, MAIL_ACCOUNTS } from './mail-accounts';
import type { Role } from './enums';
import { type Permission, PERMISSIONS } from './permissions';
import { TIME_FORMAT_MESSAGE, TIME_PATTERN } from './time';

/**
 * Рассылки портала: пока — только отладочная отправка письма администратору.
 *
 * Зачем она нужна отдельно от предпросмотра: предпросмотр показывает письмо в браузере, а
 * проверить надо ровно то, чего браузер не показывает — как письмо доехало, что стало с темой в
 * заголовке, не рассыпалась ли вёрстка в почтовом клиенте и как оно выглядит на телефоне. Это
 * видно только в доставленном письме.
 */

/**
 * Окно данных: с какого дня относительно дня рассылки и на сколько дней.
 *
 * Начало и длительность, а не пара границ. Пара «от и до» позволяет записать «конец раньше начала»
 * — состояние, которое приходится проверять и в схеме, и в контракте, и в форме; длительностью оно
 * невыразимо. Конец считается: `to = from + days - 1`.
 *
 * Смотрит только вперёд: `0` — сегодняшний день, `1` — завтрашний. Потолки не физические, а
 * смысловые: задание водителю на месяц вперёд — это уже не задание, рейсы за такой срок успеют
 * переназначить.
 *
 * Стоит выше отладки намеренно: те же два числа спрашивает отладочная отправка — иначе «проверить
 * письмо» показывало бы не то письмо, которое уйдёт.
 */
export const MAILING_WINDOW_MAX_FROM = 30;
export const MAILING_WINDOW_MAX_DAYS = 31;

/**
 * Готовые варианты первого дня для формы. Числом их всё равно вводить можно — это подсказка, а не
 * закрытый список: «завтрашний» и «+3» покрывают почти все расписания, но не все.
 */
export const MAILING_WINDOW_PRESETS = [
  { value: 0, label: 'Сегодняшний день' },
  { value: 1, label: 'Завтрашний день' },
  { value: 2, label: 'Послезавтра (+2)' },
  { value: 3, label: '+3 дня' },
] as const;

/** Виды писем, которые умеет отправить отладка. Реестр общий: по нему портал строит список. */
export const MAIL_TEST_KINDS = [
  'driver_routes',
  'role_digest',
  'verify_email',
  'password_reset',
  'password_changed',
  'registration_rejected',
  'registration_approved',
  'account_created',
] as const;
export type MailTestKind = (typeof MAIL_TEST_KINDS)[number];

export const mailTestKindLabels: Record<MailTestKind, string> = {
  driver_routes: 'Задание водителю на рейсы',
  role_digest: 'Сводка по ролям',
  verify_email: 'Подтверждение адреса при регистрации',
  password_reset: 'Восстановление пароля',
  password_changed: 'Уведомление о смене пароля',
  registration_rejected: 'Отказ по заявке на регистрацию',
  registration_approved: 'Одобрение заявки на регистрацию',
  account_created: 'Учётная запись заведена администратором',
};

/**
 * Нужна ли виду письма дата, за которую собирается содержимое. У писем про доступ её нет — они
 * относятся к событию, а не к периоду; заданию водителю она нужна, и именно ею проверяют, что
 * рейсы конкретного дня печатаются так, как ожидалось. У сводки дата означает день рассылки:
 * период считается от неё так же, как у настоящего запуска расписания.
 */
export const mailTestKindNeedsDate: Record<MailTestKind, boolean> = {
  driver_routes: true,
  role_digest: true,
  verify_email: false,
  password_reset: false,
  password_changed: false,
  // Письма про решение по конкретной учётной записи. Периода у них нет по той же причине, что у
  // писем про доступ, а образца нет тем более: ни водителя, ни чужой области видимости в них не
  // участвует — весь текст известен из самого решения. Проверяются в отладке только вёрстка и
  // доставка, поэтому и в соседних картах у этих трёх видов `false`.
  registration_rejected: false,
  registration_approved: false,
  account_created: false,
};

/**
 * Нужен ли виду письма образец получателя — человек, чьё письмо собирается. У задания водителю это
 * водитель: письмо у каждого своё, и «проверить письмо» без выбора того, чьё именно, бессмысленно.
 * Уходит оно всё равно администратору.
 */
export const mailTestKindNeedsDriver: Record<MailTestKind, boolean> = {
  driver_routes: true,
  role_digest: false,
  verify_email: false,
  password_reset: false,
  password_changed: false,
  registration_rejected: false,
  registration_approved: false,
  account_created: false,
};

/**
 * Нужен ли виду письма образец-учётка — человек, чьими глазами собирается письмо. Отдельно от
 * образца-водителя, потому что это разные справочники: водитель — физлицо из `persons`, а сводку
 * собирает область видимости учётной записи.
 *
 * У сводки такой образец обязателен по смыслу: разделы под разными людьми возвращают разные строки,
 * и «показать сводку» вообще, ни под кем, нечего — под каждым она своя.
 */
export const mailTestKindNeedsSampleUser: Record<MailTestKind, boolean> = {
  driver_routes: false,
  role_digest: true,
  verify_email: false,
  password_reset: false,
  password_changed: false,
  registration_rejected: false,
  registration_approved: false,
  account_created: false,
};

export const mailTestSchema = z
  .object({
    kind: z.enum(MAIL_TEST_KINDS),
    /**
     * Каким каналом отправить (план `office-equipment-mail-and-history-plan.md`, Р89). Умолчание —
     * основной: им уходит всё, что портал рассылал до появления второго канала.
     *
     * Спрашивается именно здесь, потому что отладка — единственный способ проверить новый SMTP до
     * первого настоящего события: письмо уйдёт с его отправителя и через его сервер.
     */
    account: z.enum(MAIL_ACCOUNTS).optional().default(DEFAULT_MAIL_ACCOUNT),
    /**
     * Кому отправить. Только учётная запись с ролью администратора: тестовое письмо содержит
     * настоящие рабочие данные, и уходить оно может лишь тому, кто и так видит их все в портале.
     */
    toUserId: uuidSchema,
    /** День рассылки, от которого считается окно данных; нужен не всем видам писем. */
    date: dateOnlySchema.optional(),
    /**
     * Окно данных от этого дня — те же две настройки, что у расписания. Умолчание «сегодняшний, на
     * день» отвечает на вопрос «как вообще выглядит письмо»; проверить конкретную настройку можно,
     * повторив её здесь.
     */
    windowFromDays: z.number().int().min(0).max(MAILING_WINDOW_MAX_FROM).optional().default(0),
    windowDays: z.number().int().min(1).max(MAILING_WINDOW_MAX_DAYS).optional().default(1),
    /**
     * Чьё письмо собрать. Пусто — сервер возьмёт первого водителя, у которого на эту дату есть
     * рейсы: чаще всего проверяют «как вообще выглядит задание», а не письмо конкретного человека.
     */
    driverPersonId: uuidSchema.optional(),
    /**
     * Чьими глазами собрать сводку. Пусто — сервер возьмёт самого получателя: администратор видит
     * всё, и такая сводка отвечает на вопрос «как письмо выглядит вообще». Само письмо в любом
     * случае уходит получателю, а не образцу: показывать чужую область видимости — не рассылка.
     */
    sampleUserId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (mailTestKindNeedsDate[v.kind] && !v.date) {
      ctx.addIssue({ code: 'custom', message: 'Укажите дату', path: ['date'] });
    }
  });
export type MailTestInput = z.infer<typeof mailTestSchema>;
export type MailTestBody = z.input<typeof mailTestSchema>;

/** Пометка в теме: тестовое письмо не должно читаться как настоящее. */
export const MAIL_TEST_SUBJECT_PREFIX = '[ТЕСТ]';

/**
 * Приписка в теле. Ссылки в тестовых письмах намеренно нерабочие: выпускать настоящий одноразовый
 * токен на чужую учётную запись по кнопке нельзя — рабочая ссылка проверяется своим сценарием.
 */
export const MAIL_TEST_NOTE =
  'Письмо отправлено вручную для проверки вёрстки и доставки. Ссылки в нём недействительны.';

// ── Содержание ролевой сводки ──
//
// Сводка отвечает на вопрос «что оформлено на эти дни», и строки её собираются по действующим
// путевым листам, а не по заявкам: лист — признак того, что работа не только заказана, но и
// оформлена, а заявка без листа может ещё двадцать раз переехать.
//
// Таблиц ровно две, и делятся они по бланку, потому что по бланку расходится привязка листа: 4-П и
// форма № 3 висят на рейсе (перевозки), ЭСМ-2 — на заявке и неделе работы (техника на объектах).
// Реестра разделов, из которого администратор собирал письмо, больше нет — вместе с ним сняты
// девять разделов «что произошло за период».

/**
 * Чьи заявки показывать. Отдельная настройка, потому что вопрос «кому писать» и вопрос «про что
 * писать» — разные: одному и тому же диспетчеру нужна то вся площадка, то только его собственные
 * заявки.
 *
 * Ни одно значение не расширяет область видимости получателя (ADR 0078 п. 2): `all` — это «всё, что
 * человек и так видит в портале, за вычетом неотмеченного в расписании», а не «всё, что есть в
 * базе». Отмеченные площадки и отделы участвуют в данных только при `all` — этим он от `scope` и
 * отличается.
 */
export const DIGEST_REQUEST_SCOPES = ['author', 'scope', 'all'] as const;
export type DigestRequestScope = (typeof DIGEST_REQUEST_SCOPES)[number];

export const digestRequestScopeLabels: Record<DigestRequestScope, string> = {
  author: 'Только заявки получателя',
  scope: 'Заявки его площадок и отделов',
  all: 'Все площадки и отделы рассылки',
};

/**
 * Как задан набор у оси аудитории: «все и будущие» или перечень.
 *
 * Режим нужен именно потому, что отбор явный. Сохрани мы перечень всех отмеченных строк, заведённая
 * завтра площадка или принятый на работу штаб в рассылку не попали бы — их не было в списке, когда
 * его отмечали, — и проявилось бы это только ненаступившим письмом.
 */
export const AUDIENCE_MODES = ['all', 'selected'] as const;
export type AudienceMode = (typeof AUDIENCE_MODES)[number];

/**
 * Строк таблицы на один день окна; сверх лимита — счётчик и ссылка на экран с полным списком.
 * Потолок против письма, которое почтовый клиент обрежет на середине (Gmail — после ~102 КБ), а не
 * рабочее ограничение: дневная сводка крупной площадки в него укладывается.
 */
export const DIGEST_TABLE_ROW_LIMIT = 60;

// ── Расписания рассылок (ADR 0075) ──
//
// Настройки живут в БД, а не в `env`: время отправки, окно дат и исключения меняет администратор,
// а правка `env` — это перезапуск сервиса руками. Здесь то, что форма, API и планировщик обязаны
// понимать одинаково: перечни, границы значений и правила применимости полей.
//
// Ограничения БД повторены схемами намеренно. CHECK-ограничение — последняя защита от кривой
// записи, но человеку оно ничего не объясняет: отказ приходит именем ограничения, а не «выберите
// день недели», и указать поле в форме по нему нельзя.

export const MAILING_TYPES = ['driver_routes', 'role_digest'] as const;
export type MailingType = (typeof MAILING_TYPES)[number];

export const mailingTypeLabels: Record<MailingType, string> = {
  driver_routes: 'Задание водителям на рейсы',
  role_digest: 'Сводка по ролям',
};

export const MAILING_RUN_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export type MailingRunStatus = (typeof MAILING_RUN_STATUSES)[number];

export const mailingRunStatusLabels: Record<MailingRunStatus, string> = {
  pending: 'Запланирован',
  running: 'Выполняется',
  done: 'Выполнен',
  failed: 'Ошибка',
  skipped: 'Пропущен',
};

/**
 * Цвета пометок в истории запусков. «Пропущен» не красный: пропуск — это решение самого
 * расписания (праздник в исключениях, выключенная почта), а не сбой, и в списке его нельзя
 * путать с упавшей рассылкой, которую надо разбирать и повторять.
 */
export const mailingRunStatusColors: Record<MailingRunStatus, string> = {
  pending: 'default',
  running: 'blue',
  done: 'green',
  failed: 'red',
  skipped: 'gold',
};

/** ISO-день недели: 1 — понедельник, 7 — воскресенье. Тем же счётом живут БД и расчёт запуска. */
const WEEKDAY_MESSAGE = 'День недели — число от 1 (понедельник) до 7 (воскресенье)';
const mailingWeekdaySchema = z.number().int().min(1, WEEKDAY_MESSAGE).max(7, WEEKDAY_MESSAGE);

export interface MailingScheduleDto {
  id: string;
  type: MailingType;
  name: string;
  isEnabled: boolean;
  /** Местное время отправки в часовом поясе портала, «ЧЧ:ММ». */
  sendAt: string;
  /** По каким дням недели выполняется рассылка. Недельная — это набор из одного дня. */
  runWeekdays: number[];
  /** С какого дня относительно дня рассылки берутся данные: 0 — сегодняшний, 1 — завтрашний. */
  windowFromDays: number;
  /** Сколько дней в окне, считая первый. */
  windowDays: number;
  /** Когда сработает в следующий раз; `null` — выключено или срабатывать больше нечему. */
  nextRunAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Даты, в которые рассылка не уходит: праздники и остановки. */
  excludedRunDates: string[];
  /** Даты рейсов, которые в письмо не попадают. */
  excludedRouteDates: string[];
  /** Водители (`persons`), которым эта рассылка не адресуется. */
  excludedPersonIds: string[];
  /**
   * Права-адресаты сводки (ADR 0111, прежде — роли, ADR 0078).
   *
   * Это фильтр получателей, а не выдача прав: письмо уходит тем, у кого право **уже есть**, а что
   * человек в нём увидит, решает его собственная область видимости. Несколько прав означают «любое
   * из» — тем же объединением, каким работал набор ролей: аудитории складываются, а не пересекаются.
   *
   * Право, а не роль, потому что «кому нужна эта сводка» — вопрос о работе, а не о названии
   * должности (решение заказчика №3 от 17.08.2026, §11.1 плана реструктуризации прав). Считается
   * право эффективным: роль его даёт или назначенный набор (ADR 0106) — для адресации разницы нет.
   */
  permissions: Permission[];
  /** Чьи заявки показывать. */
  requestScope: DigestRequestScope;
  /** Печатать ли таблицу перевозок (листы 4-П и формы № 3). */
  showTrips: boolean;
  /** Печатать ли таблицу техники на объектах: недельные листы ЭСМ-2 и дни линейных заказов. */
  showOnsite: boolean;
  /** Как задан набор площадок и отделов рассылки; при `all` перечни пусты. */
  scopeMode: AudienceMode;
  objectIds: string[];
  departmentIds: string[];
  /** Как задан набор получателей; при `all` перечень пуст. */
  recipientMode: AudienceMode;
  recipientUserIds: string[];
}

export interface MailingRunDto {
  id: string;
  scheduleId: string;
  plannedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Границы данных запуска; у видов рассылки, считающих период от даты запуска, их нет. */
  periodStart: string | null;
  periodEnd: string | null;
  status: MailingRunStatus;
  /** Итоги: сколько писем составлено, сколько получателей пропущено и почему. */
  stats: Record<string, unknown>;
  error: string;
  /** Запуск «сейчас» из админки — в истории он отличается от расписанного. */
  isManual: boolean;
  createdAt: string;
}

const mailingScheduleObject = z
  .object({
    type: z.enum(MAILING_TYPES),
    name: z.string().trim().min(1, 'Укажите название рассылки').max(200),
    /** Новую рассылку заводят выключенной: сначала настраивают, потом включают. */
    isEnabled: z.boolean().optional().default(false),
    sendAt: z.string().trim().regex(TIME_PATTERN, TIME_FORMAT_MESSAGE),
    runWeekdays: z.array(mailingWeekdaySchema).optional().default([1, 2, 3, 4, 5, 6, 7]),
    windowFromDays: z
      .number()
      .int()
      .min(0, 'Окно считается в днях вперёд от дня рассылки')
      .max(MAILING_WINDOW_MAX_FROM, `Первый день окна не дальше ${MAILING_WINDOW_MAX_FROM} дней`),
    windowDays: z
      .number()
      .int()
      .min(1, 'В окне хотя бы один день')
      .max(MAILING_WINDOW_MAX_DAYS, `Окно не длиннее ${MAILING_WINDOW_MAX_DAYS} дней`),
    excludedRunDates: z.array(dateOnlySchema).optional().default([]),
    excludedRouteDates: z.array(dateOnlySchema).optional().default([]),
    excludedPersonIds: z.array(uuidSchema).optional().default([]),
    // Настройки сводки. Умолчание — пустой набор и «все»: у задания водителям их не бывает вовсе,
    // и требовать от формы присылать пустые массивы ради чужого типа рассылки незачем.
    permissions: z.array(z.enum(PERMISSIONS)).optional().default([]),
    requestScope: z.enum(DIGEST_REQUEST_SCOPES).optional().default('scope'),
    showTrips: z.boolean().optional().default(true),
    showOnsite: z.boolean().optional().default(true),
    scopeMode: z.enum(AUDIENCE_MODES).optional().default('all'),
    objectIds: z.array(uuidSchema).optional().default([]),
    departmentIds: z.array(uuidSchema).optional().default([]),
    recipientMode: z.enum(AUDIENCE_MODES).optional().default('all'),
    recipientUserIds: z.array(uuidSchema).optional().default([]),
  })
  .strict();

type MailingScheduleFields = z.infer<typeof mailingScheduleObject>;

/**
 * Правила применимости полей — те же, что стоят ограничениями на таблице `mailing_schedules`.
 * Проверяются на всём наборе сразу, а не по полю: применимость каждого из них определяется
 * соседним — набором аудитории распоряжается тип рассылки, перечнем — режим оси.
 */
function checkMailingSchedule(v: MailingScheduleFields, ctx: z.RefinementCtx): void {
  // Расписание, не выполняющееся никогда, выражается флагом «выключено», а не пустым набором дней.
  if (v.runWeekdays.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['runWeekdays'],
      message: 'Выберите хотя бы один день недели или выключите рассылку',
    });
  }
  if (new Set(v.runWeekdays).size !== v.runWeekdays.length) {
    ctx.addIssue({ code: 'custom', path: ['runWeekdays'], message: 'День недели указан дважды' });
  }

  // Аудитория и содержание — принадлежность сводки: получателей задания водителям задаёт не роль,
  // а наличие рейса в окне, и показывать ему нечего, кроме его же рейсов.
  if (v.type === 'role_digest') {
    // Расписание без прав не найдёт ни одного получателя, а без единой таблицы соберёт пустое
    // письмо, которое всё равно не отправится. И то и другое — рассылка, каждое утро работающая
    // вхолостую: выключить её флагом честнее, чем оставить включённой и ничего не делающей.
    if (v.permissions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: 'Выберите хотя бы одно право-адресат',
      });
    }
    if (!v.showTrips && !v.showOnsite) {
      ctx.addIssue({
        code: 'custom',
        path: ['showTrips'],
        message: 'Выберите хотя бы одну таблицу: перевозки или технику на объектах',
      });
    }
    // Перечень при режиме «перечисленные» пуст быть не может: это то же «никогда не выполняется»,
    // выраженное вторым способом. А при режиме «все» — не может быть непустым: сохранённый рядом с
    // «все» перечень однажды применили бы вместо него.
    if (v.scopeMode === 'selected' && v.objectIds.length === 0 && v.departmentIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['objectIds'],
        message: 'Отметьте хотя бы одну площадку или отдел',
      });
    }
    if (v.recipientMode === 'selected' && v.recipientUserIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['recipientUserIds'],
        message: 'Отметьте хотя бы одного получателя',
      });
    }
  } else {
    if (v.permissions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: 'Права-адресаты бывают только у сводки по ролям',
      });
    }
    if (v.recipientUserIds.length > 0 || v.objectIds.length > 0 || v.departmentIds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['recipientUserIds'],
        message: 'Аудитория настраивается только у сводки по ролям',
      });
    }
  }

  if (v.scopeMode === 'all' && (v.objectIds.length > 0 || v.departmentIds.length > 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['objectIds'],
      message: 'При отборе «все площадки и отделы» перечень не сохраняется',
    });
  }
  if (v.recipientMode === 'all' && v.recipientUserIds.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['recipientUserIds'],
      message: 'При отборе «все получатели» перечень не сохраняется',
    });
  }

  // Повтор в выборе из закрытого списка — сбой формы, а не «то же самое дважды», и отвергается
  // так же, как повтор дня недели. Молча схлопываются только наборы дат и карточек, где повтор
  // ничего не решает.
  if (new Set(v.permissions).size !== v.permissions.length) {
    ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'Право указано дважды' });
  }
}

export const createMailingScheduleSchema = mailingScheduleObject.superRefine(checkMailingSchedule);
export type CreateMailingScheduleInput = z.infer<typeof createMailingScheduleSchema>;
export type CreateMailingScheduleBody = z.input<typeof createMailingScheduleSchema>;

/**
 * Правка расписания приходит целиком, а не отдельными полями: применимость каждого поля решает
 * соседнее, и по одному присланному «день недели» не сказать, законен ли он. Наборы исключений —
 * той же причины: они заменяются целиком, а не по одной дате.
 */
export const updateMailingScheduleSchema = mailingScheduleObject
  .extend({ version: z.number().int().nonnegative() })
  .superRefine(checkMailingSchedule);
export type UpdateMailingScheduleInput = z.infer<typeof updateMailingScheduleSchema>;
export type UpdateMailingScheduleBody = z.input<typeof updateMailingScheduleSchema>;

/**
 * Кандидат в получатели сводки: кого зацепит расписание при таком наборе прав и областей.
 *
 * Считает сервер тем же отбором, каким рассылка выбирает адресатов, а не портал по выгруженному
 * справочнику учёток. Причина не в экономии запроса: правило «нет площадко-отдельной оси — фильтр
 * по площадкам не применяется» в общий список учёток не встроить, не сломав его для прочих
 * экранов, а цифра под формой обязана совпадать с тем, кого возьмёт планировщик. С переездом на
 * права (ADR 0111) причина стала ещё весомее: эффективное право учётки складывается из роли и
 * назначенных наборов, и по `UserDto` его не сосчитать вовсе.
 */
export interface MailingRecipientCandidateDto {
  userId: string;
  fullName: string;
  /** Роль учётки — подписью в строке: по ней видно, за что человек попал в отбор по праву. */
  role: Role;
  /** Площадки и отделы учётки одной строкой: по ней видно, за что человек попал в отбор. */
  scopeLabel: string;
  /**
   * Те же области идентификаторами. Нужны форме, чтобы у строки справочника стоял счётчик
   * «получателей: N»: список площадок ролями не сужается (иначе нечем было бы ограничить область
   * данных), и без счётчика по нему не видно, кого именно отметка задевает.
   */
  objectIds: string[];
  departmentIds: string[];
  /** Адрес не подтверждён — письмо такому человеку не уйдёт (ADR 0072), и это видно в форме. */
  emailVerified: boolean;
}

/** Список идентификаторов строкой через запятую — тем же приёмом, что фильтр действий в аудите. */
const idListSchema = z
  .string()
  .max(4000)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(uuidSchema).max(100));

export const mailingRecipientCandidatesQuerySchema = z
  .object({
    /** Права-адресаты: без них отбор пуст, и спрашивать нечего. */
    permissions: z
      .string()
      .max(4000)
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      )
      .pipe(z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length)),
    /** Отмеченные области; пусто — «все», и тогда ось в отборе не участвует. */
    objectIds: idListSchema.optional(),
    departmentIds: idListSchema.optional(),
    scopeMode: z.enum(AUDIENCE_MODES).optional().default('all'),
  })
  .strict();
export type MailingRecipientCandidatesQuery = z.infer<typeof mailingRecipientCandidatesQuerySchema>;

export const MAILING_RUN_SORT_FIELDS = ['plannedAt', 'finishedAt', 'createdAt'] as const;

export const mailingRunListQuerySchema = baseListQuery(MAILING_RUN_SORT_FIELDS).extend({
  /** Без него история общая: у вкладки есть и такой вопрос — «что уходило вчера вообще». */
  scheduleId: uuidSchema.optional(),
});
export type MailingRunListQuery = z.infer<typeof mailingRunListQuerySchema>;
