import nodemailer from 'nodemailer';

/**
 * Транспорт писем: единственное место, которое знает про SMTP.
 *
 * Разговор с провайдером идёт по SMTP, а не по его HTTP API, намеренно: смена провайдера должна
 * быть правкой `env`, а не правкой кода. Тело письма транспорт не составляет — оно уже готово и
 * лежит в `mail_messages`: worker не знает ни прав, ни области видимости получателя.
 */

export interface OutgoingMail {
  to: string;
  /**
   * Обратный адрес именно этого письма; пусто (или поле отсутствует) — общий `MAIL_REPLY_TO` из
   * конфигурации. Своим он бывает у писем по событию: ответ на заявку, ждущую визы, должен уходить
   * заявителю, а не в ящик портала, где на него никто не ответит.
   */
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  readonly name: 'log' | 'smtp';
  /** Возвращает идентификатор письма у провайдера — по нему потом ищут письмо в его журнале. */
  send(mail: OutgoingMail): Promise<{ providerId: string }>;
  close(): Promise<void>;
}

export interface MailTransportConfig {
  transport: 'log' | 'smtp';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  replyTo: string;
  /**
   * Как представляться серверу: `CRAM-MD5` — «зашифрованный пароль» почтовых клиентов, `LOGIN` —
   * обычный пароль поверх TLS. Умолчание разбирает вызывающий: транспорту здесь выбирать нечего,
   * он передаёт метод библиотеке как есть.
   */
  authMethod?: string;
}

/**
 * Постоянный отказ SMTP: адрес не существует, домен не принимает почту, отправитель отвергнут.
 * Отделён от временного намеренно — повторять такое письмо бессмысленно, а пять повторов подряд по
 * несуществующему адресу портят репутацию отправителя у провайдера.
 */
export class PermanentMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMailError';
  }
}

/** Ответ SMTP 5xx — окончательный отказ; 4xx («попробуйте позже») остаётся поводом для повтора. */
function isPermanent(e: unknown): boolean {
  const code = (e as { responseCode?: number }).responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

export function createMailTransport(
  cfg: MailTransportConfig,
  log: (msg: string, meta: Record<string, unknown>) => void,
): MailTransport {
  // Разработка без внешней доставки: письмо составлено, лежит в журнале, в лог уходит адресат и
  // тема. Тело не логируется — в нём рабочие данные и ссылки восстановления доступа.
  if (cfg.transport === 'log') {
    return {
      name: 'log',
      async send(mail) {
        log('Письмо (transport=log, не отправлено)', { to: mail.to, subject: mail.subject });
        return { providerId: `log:${Date.now()}` };
      },
      async close() {},
    };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    // true только для implicit TLS (465); на 587 соединение поднимается STARTTLS.
    secure: cfg.secure,
    // Метод аутентификации задаёт канал: корпоративные серверы нередко требуют CRAM-MD5 — это то,
    // что почтовые клиенты называют «зашифрованным паролем». Пусто — библиотека выбирает сама.
    auth: {
      user: cfg.user,
      pass: cfg.password,
      ...(cfg.authMethod ? { method: cfg.authMethod } : {}),
    },
    // Одно соединение на несколько писем: провайдеры считают частые переподключения подозрительной
    // активностью, а рассылка идёт пачкой.
    pool: true,
    maxConnections: 1,
  });

  return {
    name: 'smtp',
    async send(mail) {
      try {
        // Обратный адрес письма побеждает общий: он выбран событием, а `cfg.replyTo` — умолчание
        // портала для писем, у которых своего адресата ответа нет.
        const replyTo = mail.replyTo || cfg.replyTo;
        const info = await transporter.sendMail({
          from: cfg.from,
          ...(replyTo ? { replyTo } : {}),
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          ...(mail.html ? { html: mail.html } : {}),
        });
        return { providerId: info.messageId ?? '' };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (isPermanent(e)) throw new PermanentMailError(message);
        throw e;
      }
    },
    async close() {
      transporter.close();
    },
  };
}
