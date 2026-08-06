import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { TIME_FORMAT_MESSAGE, TIME_PATTERN } from './time';

/**
 * Рассылки портала: пока — только отладочная отправка письма администратору.
 *
 * Зачем она нужна отдельно от предпросмотра: предпросмотр показывает письмо в браузере, а
 * проверить надо ровно то, чего браузер не показывает — как письмо доехало, что стало с темой в
 * заголовке, не рассыпалась ли вёрстка в почтовом клиенте и как оно выглядит на телефоне. Это
 * видно только в доставленном письме.
 */

/** Виды писем, которые умеет отправить отладка. Реестр общий: по нему портал строит список. */
export const MAIL_TEST_KINDS = [
  'driver_routes',
  'verify_email',
  'password_reset',
  'password_changed',
] as const;
export type MailTestKind = (typeof MAIL_TEST_KINDS)[number];

export const mailTestKindLabels: Record<MailTestKind, string> = {
  driver_routes: 'Задание водителю на рейсы',
  verify_email: 'Подтверждение адреса при регистрации',
  password_reset: 'Восстановление пароля',
  password_changed: 'Уведомление о смене пароля',
};

/**
 * Нужна ли виду письма дата, за которую собирается содержимое. У писем про доступ её нет — они
 * относятся к событию, а не к периоду; заданию водителю она нужна, и именно ею проверяют, что
 * рейсы конкретного дня печатаются так, как ожидалось.
 */
export const mailTestKindNeedsDate: Record<MailTestKind, boolean> = {
  driver_routes: true,
  verify_email: false,
  password_reset: false,
  password_changed: false,
};

/**
 * Нужен ли виду письма образец получателя — человек, чьё письмо собирается. У задания водителю это
 * водитель: письмо у каждого своё, и «проверить письмо» без выбора того, чьё именно, бессмысленно.
 * Уходит оно всё равно администратору.
 */
export const mailTestKindNeedsDriver: Record<MailTestKind, boolean> = {
  driver_routes: true,
  verify_email: false,
  password_reset: false,
  password_changed: false,
};

export const mailTestSchema = z
  .object({
    kind: z.enum(MAIL_TEST_KINDS),
    /**
     * Кому отправить. Только учётная запись с ролью администратора: тестовое письмо содержит
     * настоящие рабочие данные, и уходить оно может лишь тому, кто и так видит их все в портале.
     */
    toUserId: uuidSchema,
    /** Дата, за которую собирается содержимое; нужна не всем видам писем. */
    date: dateOnlySchema.optional(),
    /**
     * Чьё письмо собрать. Пусто — сервер возьмёт первого водителя, у которого на эту дату есть
     * рейсы: чаще всего проверяют «как вообще выглядит задание», а не письмо конкретного человека.
     */
    driverPersonId: uuidSchema.optional(),
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

export const MAILING_PERIODICITIES = ['daily', 'weekly'] as const;
export type MailingPeriodicity = (typeof MAILING_PERIODICITIES)[number];

export const mailingPeriodicityLabels: Record<MailingPeriodicity, string> = {
  daily: 'Ежедневно',
  weekly: 'Раз в неделю',
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

/**
 * Потолок окна рейсов в днях. Ограничение не физическое, а смысловое: задание водителю на месяц
 * вперёд — это уже не задание, а рейсы за него столько раз успеют переназначить.
 */
export const MAILING_WINDOW_MAX_DAYS = 30;

export interface MailingScheduleDto {
  id: string;
  type: MailingType;
  name: string;
  isEnabled: boolean;
  periodicity: MailingPeriodicity;
  /** Местное время отправки в часовом поясе портала, «ЧЧ:ММ». */
  sendAt: string;
  /** ISO-день недели у недельной рассылки; у ежедневной — `null`. */
  weekday: number | null;
  /** По каким дням недели выполняется ежедневная рассылка. */
  runWeekdays: number[];
  /** Окно рейсов задания водителю в днях от даты запуска; у прочих типов — `null`. */
  windowFromDays: number | null;
  windowToDays: number | null;
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
    periodicity: z.enum(MAILING_PERIODICITIES).optional().default('daily'),
    sendAt: z.string().trim().regex(TIME_PATTERN, TIME_FORMAT_MESSAGE),
    weekday: mailingWeekdaySchema.nullable().optional(),
    runWeekdays: z.array(mailingWeekdaySchema).optional().default([1, 2, 3, 4, 5, 6, 7]),
    windowFromDays: z
      .number()
      .int()
      .min(0, 'Окно рейсов считается в днях от дня рассылки')
      .max(MAILING_WINDOW_MAX_DAYS, `Окно рейсов не длиннее ${MAILING_WINDOW_MAX_DAYS} дней`)
      .nullable()
      .optional(),
    windowToDays: z
      .number()
      .int()
      .min(0, 'Окно рейсов считается в днях от дня рассылки')
      .max(MAILING_WINDOW_MAX_DAYS, `Окно рейсов не длиннее ${MAILING_WINDOW_MAX_DAYS} дней`)
      .nullable()
      .optional(),
    excludedRunDates: z.array(dateOnlySchema).optional().default([]),
    excludedRouteDates: z.array(dateOnlySchema).optional().default([]),
    excludedPersonIds: z.array(uuidSchema).optional().default([]),
  })
  .strict();

type MailingScheduleFields = z.infer<typeof mailingScheduleObject>;

/**
 * Правила применимости полей — те же, что стоят ограничениями на таблице `mailing_schedules`.
 * Проверяются на всём наборе сразу, а не по полю: применимость каждого из них определяется
 * соседним — днём недели распоряжается периодичность, окном дат — тип рассылки.
 */
function checkMailingSchedule(v: MailingScheduleFields, ctx: z.RefinementCtx): void {
  if (v.periodicity === 'weekly' && v.weekday == null) {
    ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Выберите день недели' });
  }
  if (v.periodicity === 'daily' && v.weekday != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['weekday'],
      message: 'День недели бывает только у недельной рассылки',
    });
  }
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

  // Окно дат — принадлежность задания водителю: у сводки период считается от даты запуска.
  if (v.type === 'driver_routes') {
    if (v.windowFromDays == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowFromDays'],
        message: 'Укажите, с какого дня брать рейсы',
      });
    }
    if (v.windowToDays == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowToDays'],
        message: 'Укажите, по какой день брать рейсы',
      });
    }
    if (v.windowFromDays != null && v.windowToDays != null && v.windowToDays < v.windowFromDays) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowToDays'],
        message: 'Конец окна рейсов раньше его начала',
      });
    }
  } else if (v.windowFromDays != null || v.windowToDays != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['windowFromDays'],
      message: 'Окно рейсов бывает только у задания водителям',
    });
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

export const MAILING_RUN_SORT_FIELDS = ['plannedAt', 'finishedAt', 'createdAt'] as const;

export const mailingRunListQuerySchema = baseListQuery(MAILING_RUN_SORT_FIELDS).extend({
  /** Без него история общая: у вкладки есть и такой вопрос — «что уходило вчера вообще». */
  scheduleId: uuidSchema.optional(),
});
export type MailingRunListQuery = z.infer<typeof mailingRunListQuerySchema>;
