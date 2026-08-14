import { z } from 'zod';
import { emailSchema, optionalEmailSchema } from './email';

// ── Служебные адресаты писем модулей (план `office-equipment-mail-and-history-plan.md`, Р64–Р68) ──
//
// Ролевые сводки (ADR 0075, 0093) отвечают на вопрос «что у нас на эти дни» и уходят учётным
// записям портала по расписанию. Здесь — другое: письмо по событию на **служебный ящик**, за
// которым нет учётки и области видимости. Отдел ИТ читает почту, а не портал, и заявка, ждущая его
// визы, обязана дойти до него сама.
//
// Отсюда и форма настройки: не пара «ключ — значение» в общем словаре, а строка со смыслом —
// событие, адрес, включённость и правило обратного адреса. Ключ-значение через полгода
// превращается в двадцать строк без схемы и без ответа на вопрос, кто это включил.

/**
 * События, по которым уходит письмо. Реестр закрыт `Record` ниже: новое событие обязано ответить,
 * как оно называется в настройке и когда наступает, — иначе в списке появится строка, про которую
 * администратор не знает, что она шлёт.
 *
 * Оба события — про заявку на обслуживание оргтехники, и оба привязаны не к действию ручки, а к
 * **входу заявки в статус**: «Новая» бывает не только у только что заведённой заявки, но и у
 * вернувшейся откатом (ADR 0096, `SERVICE_ADMIN_ROLLBACKS`), и служба ИТ ждёт её в обоих случаях.
 */
export const MODULE_MAIL_EVENTS = [
  'service_request_waiting_it',
  'service_request_cancelled',
] as const;
export type ModuleMailEvent = (typeof MODULE_MAIL_EVENTS)[number];

export const moduleMailEventLabels: Record<ModuleMailEvent, string> = {
  service_request_waiting_it: 'Заявка на обслуживание ждёт визы ИТ',
  service_request_cancelled: 'Заявка на обслуживание отменена',
};

/** Когда именно наступает событие — подпись под строкой настройки, а не комментарий в коде. */
export const moduleMailEventHints: Record<ModuleMailEvent, string> = {
  service_request_waiting_it:
    'Заявка заведена или вернулась в «Новую» откатом. Заявку, завизированную самим ' +
    'согласующим, письмо не сопровождает: она в «Новой» не бывает.',
  service_request_cancelled: 'Заявку отменил заказчик или администратор — чтобы не выезжали зря.',
};

/**
 * Куда уйдёт ответ на письмо. Режим задаётся **на строке адресата**, а не один на портал: на новую
 * заявку отвечают заявителю, на отмену — тому, кто её отменил, а служебные письма замыкают на ящик
 * оператора.
 *
 * «Оператора площадки» в списке нет и быть не может: связи «оператор ↔ объект» в данных не
 * существует (план модуля, Р40), и выводить её из надстройки роли значило бы гадать.
 */
export const REPLY_TO_MODES = ['fixed', 'author', 'actor', 'portal'] as const;
export type ReplyToMode = (typeof REPLY_TO_MODES)[number];

export const replyToModeLabels: Record<ReplyToMode, string> = {
  fixed: 'На указанный адрес',
  author: 'Автору заявки',
  actor: 'Тому, кто вызвал событие',
  portal: 'На общий адрес портала',
};

export const replyToModeHints: Record<ReplyToMode, string> = {
  fixed: 'Один и тот же адрес для всех писем этой строки — например ящик оператора оргтехники.',
  author: 'Ответ уходит тому, кто завёл заявку: у службы вопросы обычно к нему.',
  actor: 'Отменившему заявку или нажавшему «Отправить ещё раз».',
  portal: 'Адрес из настроек сервера (MAIL_REPLY_TO). Отвечать по существу там некому.',
};

/** Режимы, которым адрес обязателен: без него у письма не будет обратного адреса вовсе. */
export function replyToModeNeedsEmail(mode: ReplyToMode): boolean {
  return mode === 'fixed';
}

/**
 * Режимы, которым адрес разрешён **запасным**: у автора заявки или у нажавшего кнопку почты может
 * не оказаться, и тогда ответ уходит сюда. У `portal` запасного адреса нет по определению — он сам
 * и есть последний рубеж отката.
 */
export function replyToModeAllowsEmail(mode: ReplyToMode): boolean {
  return mode !== 'portal';
}

const commentSchema = z.string().trim().max(500);

const recipientFields = {
  toEmail: emailSchema,
  isEnabled: z.boolean().optional().default(true),
  replyToMode: z.enum(REPLY_TO_MODES).optional().default('fixed'),
  /** Пусто — «не задан»; правило зависит от режима и проверяется ниже (то же держит CHECK в БД). */
  replyToEmail: optionalEmailSchema.optional().default(''),
  comment: commentSchema.optional().default(''),
};

/**
 * Правило пары «режим + адрес». Повторяет CHECK базы намеренно: ограничение — последняя защита от
 * кривой записи, но человеку оно ничего не объясняет, а указать поле в форме по имени ограничения
 * нельзя.
 */
function checkReplyTo(
  v: { replyToMode: ReplyToMode; replyToEmail: string },
  ctx: z.RefinementCtx,
): void {
  if (replyToModeNeedsEmail(v.replyToMode) && !v.replyToEmail) {
    ctx.addIssue({
      code: 'custom',
      message: 'Укажите адрес для ответов',
      path: ['replyToEmail'],
    });
  }
  if (!replyToModeAllowsEmail(v.replyToMode) && v.replyToEmail) {
    ctx.addIssue({
      code: 'custom',
      message: 'У общего адреса портала запасного адреса не бывает',
      path: ['replyToEmail'],
    });
  }
}

export const createModuleMailRecipientSchema = z
  .object({ event: z.enum(MODULE_MAIL_EVENTS), ...recipientFields })
  .superRefine(checkReplyTo);
export type CreateModuleMailRecipientInput = z.infer<typeof createModuleMailRecipientSchema>;
export type CreateModuleMailRecipientBody = z.input<typeof createModuleMailRecipientSchema>;

/**
 * Правка идёт целиком, и события в ней нет: строка — это пара «событие + адрес», и смена события
 * превращает её в другую строку. Переносить адрес с одного события на другое — значит завести
 * новую строку и выключить старую, чтобы в аудите осталось, что и когда перестало рассылаться.
 *
 * Умолчаний здесь нет, в отличие от заведения, и это не придирка к форме: `isEnabled` со
 * значением по умолчанию `true` означал бы, что запрос **без** этого поля включает выключенную
 * рассылку, а пропущенный `comment` стирает объяснение, ради которого её выключали. Правка целиком
 * обязана прийти целиком — недостающее поле это 400, а не догадка сервера.
 */
export const updateModuleMailRecipientSchema = z
  .object({
    toEmail: emailSchema,
    isEnabled: z.boolean(),
    replyToMode: z.enum(REPLY_TO_MODES),
    replyToEmail: optionalEmailSchema,
    comment: commentSchema,
    version: z.number().int().nonnegative(),
  })
  .superRefine(checkReplyTo);
export type UpdateModuleMailRecipientInput = z.infer<typeof updateModuleMailRecipientSchema>;
export type UpdateModuleMailRecipientBody = z.input<typeof updateModuleMailRecipientSchema>;

export interface ModuleMailRecipientDto {
  id: string;
  event: ModuleMailEvent;
  toEmail: string;
  isEnabled: boolean;
  replyToMode: ReplyToMode;
  /** Адрес для ответов: обязательный при `fixed`, запасной при `author`/`actor`, пустой при `portal`. */
  replyToEmail: string;
  comment: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Кто правил строку последним; `null` — учётки уже нет. Правка доставки не бывает ничьей. */
  updatedByName: string | null;
}

/**
 * Исход почтовой части операции. Продолжает `MAIL_OUTCOMES` (ADR 0087), и все значения, кроме
 * первого, означают одно: «операция удалась, письма нет». Заявка не должна падать из-за почтовой
 * настройки или из-за того, что тело письма не собралось.
 *
 * Исхода «адресаты не настроены» здесь нет: основной получатель известен и без настройки — это
 * ящик самого канала, а строки таблицы задают лишь копии (Р91). Молчание портала объясняется либо
 * выключенной почтой, либо ненастроенным каналом, и оба ответа — про `env`, а не про базу.
 *
 * `mail_failed` — не тихая ветка: он уходит в лог и в аудит **после** фиксации транзакции, потому
 * что аудит пишется мимо неё и при откате остался бы записью о событии, которого не было.
 */
export const MODULE_MAIL_OUTCOMES = [
  'queued',
  'mail_disabled',
  'channel_missing',
  'mail_failed',
] as const;
export type ModuleMailOutcome = (typeof MODULE_MAIL_OUTCOMES)[number];

export const moduleMailOutcomeLabels: Record<ModuleMailOutcome, string> = {
  queued: 'Письмо службе поставлено в очередь',
  mail_disabled: 'Отправка писем выключена — служба не оповещена',
  channel_missing: 'Почтовый канал службы не настроен — служба не оповещена',
  mail_failed: 'Письмо не собралось — сообщите администратору',
};
