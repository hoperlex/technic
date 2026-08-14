import { DEFAULT_MAIL_ACCOUNT, type MailAccount } from '@technic/contracts';
import { db } from '../db/client';
import { mailMessages } from '../db/schema';
import { config } from '../config';
import { enqueueJob, JOB_SEND_EMAIL } from '../lib/jobs';
import { err } from '../lib/errors';
import { renderMail, type MailContent } from './mail-templates';

/**
 * Постановка письма в очередь (миграция 0097).
 *
 * Две записи одной транзакцией и в строго таком порядке: сначала строка журнала с дедупликацией по
 * `(kind, dedupe_key)`, и только если она вставилась — задача `send_email`. Обратный порядок дал бы
 * задачу без письма всякий раз, когда дедупликация сработала, и worker разбирал бы пустые задачи.
 *
 * Отсюда же берётся безопасность повтора: упавший запуск рассылки можно перезапустить целиком —
 * письма, уже составленные первым заходом, второй раз не вставятся и вторых задач не создадут.
 */

export type MailKind = (typeof mailMessages.kind.enumValues)[number];

/** Транзакция drizzle: письмо часто ставится вместе с тем, ради чего оно отправляется. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface MailFields {
  kind: MailKind;
  /**
   * Ключ бизнес-события, а не случайное значение: «письмо об этом уже составлено». Для рассылки —
   * `<kind>:<runId>:<получатель>`, для auth-письма — событие, его вызвавшее. Открытых токенов и
   * паролей здесь быть не должно: ключ виден в журнале и в диагностике.
   */
  dedupeKey: string;
  to: string;
  /**
   * Каким каналом отправлять. Пусто — основной канал портала: им уходит всё, что писалось до
   * появления второго, и им же — письма, которым отправитель безразличен (план, Р85).
   */
  account?: MailAccount;
  /**
   * Куда отвечать. Пусто — общий `MAIL_REPLY_TO`: у писем про доступ отвечать по существу некому,
   * а у письма по заявке адресат ответа зависит от события (план модуля, Р68).
   */
  replyTo?: string;
  subject: string;
  userId?: string | null;
  personId?: string | null;
  mailingRunId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Отладочная отправка администратору: мимо статистики запусков и мимо алертов. */
  isTest?: boolean;
}

export interface QueueMailInput extends MailFields {
  content: MailContent;
}

/** Готовое тело: вызывающий уже отрисовал письмо сам (см. `queuePreparedMail`). */
export interface PreparedMailInput extends MailFields {
  text: string;
  html: string;
}

/**
 * Почта выключена или не настроена. Проверяется до составления письма: операция, которой письмо
 * обязательно (регистрация, сброс пароля), должна отказать явно, а не завершиться успехом, после
 * которого человек ждёт письма, которого не будет.
 */
export function assertMailEnabled(): void {
  if (!config.mail.enabled) {
    throw err.unavailable('Отправка писем сейчас отключена — обратитесь к администратору');
  }
}

/**
 * Ставит **готовое** письмо в очередь: только две вставки, без проверки настроек и без рендера.
 *
 * Нужна там, где письмо составляется внутри чужой транзакции по данным, которых до неё не
 * существует: письму по заявке нужен её номер (`num` — identity), а ключу дедупликации — id строки
 * истории статуса, и оба появляются только после `INSERT`. Всё, что способно отказать по данным —
 * выборка адресатов и проверка `config.mail.enabled`, — вызывающий делает **до** транзакции и
 * отвечает мягким исходом, а сюда приходит уже отрисованный текст (план модуля, Р67).
 *
 * Возвращает id строки журнала или `null`, если такое письмо уже было составлено раньше: для
 * вызывающего это не ошибка — работа уже сделана.
 */
export async function queuePreparedMail(
  input: PreparedMailInput,
  opts: { tx?: Tx } = {},
): Promise<string | null> {
  const insert = async (tx: Tx): Promise<string | null> => {
    const [row] = await tx
      .insert(mailMessages)
      .values({
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        toEmail: input.to,
        account: input.account ?? DEFAULT_MAIL_ACCOUNT,
        replyTo: input.replyTo ?? '',
        subject: input.subject,
        bodyText: input.text,
        bodyHtml: input.html,
        userId: input.userId ?? null,
        personId: input.personId ?? null,
        mailingRunId: input.mailingRunId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        isTest: input.isTest ?? false,
      })
      .onConflictDoNothing({ target: [mailMessages.kind, mailMessages.dedupeKey] })
      .returning({ id: mailMessages.id });
    if (!row) return null;

    await enqueueJob(JOB_SEND_EMAIL, { mailMessageId: row.id }, { tx });
    return row.id;
  };

  // Своя транзакция нужна только тогда, когда письмо ставится само по себе: у постановки вместе с
  // бизнес-операцией транзакция уже открыта, и вкладывать в неё вторую нечем.
  return opts.tx ? insert(opts.tx) : db.transaction(insert);
}

/**
 * Ставит письмо в очередь, отрисовав его тело: обычный путь для писем, которым известно всё
 * заранее (подтверждение адреса, решение по заявке на регистрацию, сводка).
 */
export async function queueMail(
  input: QueueMailInput,
  opts: { tx?: Tx } = {},
): Promise<string | null> {
  assertMailEnabled();
  const { content, ...fields } = input;
  const { text, html } = renderMail(content);
  return queuePreparedMail({ ...fields, text, html }, opts);
}
