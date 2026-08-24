import {
  createMailTransport,
  type MailTransport,
  type MailTransportConfig,
} from './mail-transport';
import { RateLimiter } from './mail-rate';

/**
 * Почтовые каналы воркера (план `docs/office-equipment-mail-and-history-plan.md`, Р83–Р87).
 *
 * Транспорт был один на процесс, и второго отправителя выразить было нечем. Теперь у каждого канала
 * своё соединение и **свой** счётчик писем в минуту: у корпоративного сервера пределы не те, что у
 * транзакционного провайдера, и общий счётчик душил бы один канал ради другого.
 *
 * Перечня каналов здесь нет намеренно. Воркер по-прежнему не знает правил портала — он знает только
 * то, что нашёл в своём окружении: канал `default` из прежних `SMTP_*` и по каналу на каждый
 * встреченный префикс `MAIL_ACCOUNT_<КЛЮЧ>_*`. Реестр ключей живёт в контрактах, потому что на него
 * ссылается письмо; тащить контракты сюда ради двух строк значило бы отдать воркеру знание, от
 * которого его отделили нарочно.
 *
 * Канал берётся из письма (колонка `account`), а не выводится из вида письма: правило «такие письма
 * — таким каналом», зашитое сюда, разъехалось бы с тем, что API кладёт в тело и в `From`.
 */

export const DEFAULT_ACCOUNT = 'default';

/** Методы аутентификации SMTP; `CRAM-MD5` — «зашифрованный пароль» почтовых клиентов. */
const AUTH_METHODS = ['LOGIN', 'PLAIN', 'CRAM-MD5'];

/** Переменные канала: по ним же он и обнаруживается в окружении. */
const ACCOUNT_VARS = [
  'HOST',
  'PORT',
  'SECURE',
  'USER',
  'PASSWORD',
  'FROM',
  'REPLY_TO',
  'AUTH_METHOD',
  'MAX_PER_MINUTE',
] as const;

const ACCOUNT_ENV = new RegExp(`^MAIL_ACCOUNT_([A-Z0-9]+)_(${ACCOUNT_VARS.join('|')})$`);

export interface MailAccountRuntime {
  cfg: MailTransportConfig;
  transport: MailTransport;
  rate: RateLimiter;
}

type Log = (msg: string, meta: Record<string, unknown>) => void;

/** Ключи каналов, объявленных переменными `MAIL_ACCOUNT_*`, в порядке первого появления. */
function declaredAccounts(env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];
  for (const name of Object.keys(env)) {
    const match = ACCOUNT_ENV.exec(name);
    if (!match || !env[name]) continue;
    const key = match[1]!.toLowerCase();
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function authMethodOf(raw: string, account: string): string | undefined {
  if (!raw) return undefined;
  const found = AUTH_METHODS.find((m) => m === raw.toUpperCase());
  if (!found) {
    throw new Error(
      `Канал ${account}: неизвестный метод аутентификации «${raw}» (допустимы ${AUTH_METHODS.join(', ')})`,
    );
  }
  return found;
}

/**
 * Настройки канала из окружения. У основного канала префикса нет — он читается из прежних `SMTP_*`
 * и `MAIL_FROM`: переименовывать рабочие переменные ради единообразия нельзя, выкат не должен
 * требовать правки `prod.env`.
 */
function accountConfig(
  account: string,
  transport: 'log' | 'smtp',
  env: NodeJS.ProcessEnv,
): MailTransportConfig {
  const prefix = account === DEFAULT_ACCOUNT ? null : `MAIL_ACCOUNT_${account.toUpperCase()}`;
  const at = (name: (typeof ACCOUNT_VARS)[number]): string =>
    (prefix ? env[`${prefix}_${name}`] : undefined) ?? '';

  const raw = prefix
    ? {
        host: at('HOST'),
        port: at('PORT'),
        secure: at('SECURE'),
        user: at('USER'),
        password: at('PASSWORD'),
        from: at('FROM'),
        replyTo: at('REPLY_TO'),
        authMethod: at('AUTH_METHOD'),
      }
    : {
        host: env.SMTP_HOST ?? '',
        port: env.SMTP_PORT ?? '',
        secure: env.SMTP_SECURE ?? '',
        user: env.SMTP_USER ?? '',
        password: env.SMTP_PASSWORD ?? '',
        from: env.MAIL_FROM ?? '',
        replyTo: env.MAIL_REPLY_TO ?? '',
        authMethod: '',
      };

  const method = authMethodOf(raw.authMethod, account);
  const port = Number(raw.port || 587);
  // Умолчание защиты выводится из порта: 465 — implicit TLS, 587 — STARTTLS. Так настройка канала
  // из почтового клиента переносится в `env` без третьего вопроса к тому, кто её переносит.
  const secure = raw.secure ? raw.secure === 'true' : port === 465;
  const cfg: MailTransportConfig = {
    transport,
    host: raw.host,
    port,
    secure,
    user: raw.user,
    password: raw.password,
    from: raw.from,
    replyTo: raw.replyTo,
    ...(method ? { authMethod: method } : {}),
  };

  if (transport === 'smtp') {
    const missing = (['host', 'user', 'password', 'from'] as const).filter((k) => !cfg[k]);
    if (missing.length > 0) {
      const names = prefix
        ? missing.map((k) => `${prefix}_${k.toUpperCase()}`)
        : ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'];
      throw new Error(`Канал ${account} настроен наполовину — не заданы: ${names.join(', ')}`);
    }
    /**
     * Порт 465 работает только с implicit TLS, 587 — только со STARTTLS. Перепутанная пара не
     * ломается сразу: соединение виснет до таймаута, и выглядит это как «рассылка не работает» —
     * ночью, на первом письме. Поэтому отказ на старте.
     */
    if (port === 465 && !secure) {
      throw new Error(`Канал ${account}: порт 465 требует SECURE=true (TLS сразу, без STARTTLS)`);
    }
    if (port === 587 && secure) {
      throw new Error(`Канал ${account}: порт 587 требует SECURE=false (STARTTLS)`);
    }
  }
  return cfg;
}

/**
 * Поднимает все каналы окружения. Пустая карта означает, что почта выключена, — задачи отправки в
 * этом случае откладываются, а не падают.
 */
export function createMailAccounts(
  opts: {
    enabled: boolean;
    transport: 'log' | 'smtp';
    defaultMaxPerMinute: number;
    env?: NodeJS.ProcessEnv;
  },
  log: Log,
): Map<string, MailAccountRuntime> {
  const accounts = new Map<string, MailAccountRuntime>();
  if (!opts.enabled) return accounts;

  const env = opts.env ?? process.env;
  // Основной канал первым: письма без канала и письма прошлых выпусков уходят им.
  for (const account of [DEFAULT_ACCOUNT, ...declaredAccounts(env)]) {
    const cfg = accountConfig(account, opts.transport, env);
    const prefix = account === DEFAULT_ACCOUNT ? null : `MAIL_ACCOUNT_${account.toUpperCase()}`;
    const limit = Number(
      (prefix ? env[`${prefix}_MAX_PER_MINUTE`] : undefined) ?? opts.defaultMaxPerMinute,
    );
    accounts.set(account, {
      cfg,
      transport: createMailTransport(cfg, log),
      rate: new RateLimiter(limit),
    });

    // Без секретов: видно, куда и чем отправляем, — этого хватает, чтобы заметить чужой SMTP в проде.
    log('Почтовый канал worker', {
      account,
      transport: cfg.transport,
      host: cfg.host,
      port: cfg.port,
      from: cfg.from,
      authMethod: cfg.authMethod ?? 'по умолчанию',
      maxPerMinute: limit,
    });

    /**
     * Почтовые службы общего назначения (Яндекс, Mail.ru) отправляют письмо только от адреса самого
     * ящика: чужой `From` они отвергают ответом 550, и произойдёт это на первом же письме. Это
     * предупреждение, а не отказ старта: у транзакционных провайдеров отправка от произвольного
     * адреса подтверждённого домена — норма.
     */
    if (cfg.transport === 'smtp' && cfg.user && !cfg.from.includes(cfg.user)) {
      log('FROM канала не содержит адрес его SMTP-ящика: такие письма отвергают ответом 550', {
        account,
        from: cfg.from,
        user: cfg.user,
      });
    }
  }
  return accounts;
}
