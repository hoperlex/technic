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

export interface QueueMailInput {
  kind: MailKind;
  /**
   * Ключ бизнес-события, а не случайное значение: «письмо об этом уже составлено». Для рассылки —
   * `<kind>:<runId>:<получатель>`, для auth-письма — событие, его вызвавшее. Открытых токенов и
   * паролей здесь быть не должно: ключ виден в журнале и в диагностике.
   */
  dedupeKey: string;
  to: string;
  subject: string;
  content: MailContent;
  userId?: string | null;
  personId?: string | null;
  mailingRunId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Отладочная отправка администратору: мимо статистики запусков и мимо алертов. */
  isTest?: boolean;
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
 * Ставит письмо в очередь. Возвращает id строки журнала или `null`, если такое письмо уже было
 * составлено раньше: для вызывающего это не ошибка — работа уже сделана.
 */
export async function queueMail(
  input: QueueMailInput,
  opts: { tx?: Tx } = {},
): Promise<string | null> {
  assertMailEnabled();
  const { text, html } = renderMail(input.content);

  const insert = async (tx: Tx): Promise<string | null> => {
    const [row] = await tx
      .insert(mailMessages)
      .values({
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        toEmail: input.to,
        subject: input.subject,
        bodyText: text,
        bodyHtml: html,
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
