import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DEFAULT_MAIL_ACCOUNT,
  MAIL_ACCOUNTS,
  mailAccountEnvPrefix,
  type MailAccount,
} from '@technic/contracts';

const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.toLowerCase() === 'true'));

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  PUBLIC_ORIGIN: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATION_URL: z.string().optional(),
  PGSSLROOTCERT: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().min(1),
  JWT_KID: z.string().default('technic-1'),
  JWT_ISSUER: z.string().default('technic-portal'),
  JWT_AUDIENCE: z.string().default('technic-portal-web'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1_209_600),
  COOKIE_SECRET: z.string().min(16),
  CSRF_SECRET: z.string().min(16),
  ARGON_MEMORY_KIB: z.coerce.number().int().positive().default(19_456),
  ARGON_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON_PARALLELISM: z.coerce.number().int().positive().default(1),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('ru-central-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolFromEnv(false),
  S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  FILE_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(52_428_800),
  FILE_MAX_PER_REQUEST: z.coerce.number().int().positive().default(20),

  // Печать путевого листа (ADR 0041): бланк переводит в PDF LibreOffice, поставленный в образ.
  // Путь настраиваемый — на рабочей машине разработчика он может лежать не в PATH.
  SOFFICE_BIN: z.string().default('soffice'),
  SOFFICE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Почта (план `docs/mail-integration-plan.md`). Расписания, роли и состав рассылок сюда не
  // попадают: их меняет администратор во вкладке «Рассылки», и в `env` им делать нечего.
  MAIL_ENABLED: boolFromEnv(false),
  // `log` — разработка без внешней доставки: письмо составляется и остаётся в журнале.
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // true только для implicit TLS (порт 465); для 587 и 2525 соединение поднимается STARTTLS.
  SMTP_SECURE: boolFromEnv(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_REPLY_TO: z.string().optional(),
  // Потолок отправки: у транзакционных провайдеров есть лимит, и рассылка на несколько сотен
  // адресов иначе упирается в него и получает отказы пачкой.
  MAIL_MAX_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // IANA timezone времени рассылок и границ календарных периодов дайджеста.
  MAIL_SCHEDULER_TIMEZONE: z.string().default('Europe/Moscow'),
  MAIL_VERIFY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  MAIL_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  MAIL_REGISTRATION_EXPIRY_DAYS: z.coerce.number().int().positive().default(7),
  // Общий секрет worker → API для `/internal/*`: ни у планировщика рассылок, ни у автозакрытия
  // заявок нет человека, от чьего имени они действуют, поэтому и не JWT.
  INTERNAL_API_TOKEN: z.string().optional(),

  // Автозакрытие заявок оргтехники (план `docs/office-equipment-requests-rework-plan.md`, §7.3,
  // решение Н7): сколько созревших заявок портал закрывает за один прогон.
  //
  // Настройкой задан размер пачки, а не срок молчания: срок — правило цикла, одинаковое для всех
  // заявок (сутки, `SERVICE_AUTO_CLOSE_AFTER_HOURS`), а размер пачки — про нагрузку. В день выката
  // отбор увидит все заявки, стоявшие в «Решена» до него, и уменьшенное значение разбирает эту
  // очередь за несколько проходов вместо одного всплеска.
  SERVICE_REQUEST_AUTO_CLOSE_BATCH: z.coerce.number().int().positive().default(50),
  // Распознавание талонов вывоза (ADR 0114, план `docs/waste-ticket-ocr-plan.md`).
  //
  // Наружу портал ходит **только** через LLM-прокси заказчика: ключей провайдера у него нет и не
  // будет, а `AI_PROVIDER_MODE` решает, живой это транспорт или заглушка. `stub` — не «выключено»,
  // а «отвечает предсказуемым ответом»: так работают тесты и разработка без сети и без расхода.
  AI_PROVIDER_MODE: z.enum(['proxy', 'stub']).default('stub'),
  PROXY_LLM_BASE_URL: z.string().url().optional(),
  PROXY_LLM_TOKEN: z.string().optional(),
  // Флаг выдан заказчиком вместе с адресом; его точный смысл подтверждается оператором прокси
  // (Р6 плана) — портал только передаёт его дальше и не толкует.
  PROXY_LLM_ACK_NO_PROVIDER_POLICY: boolFromEnv(false),

  // Признак модуля отдельно от транспорта: прокси может быть настроен, а распознавание выключено —
  // например, пока не получены ответы по хранению сканов (В1).
  TICKET_OCR_ENABLED: boolFromEnv(false),
  // Слаг каталога OpenRouter. Заглушка `proxy` означает «модель выбирает прокси» и остаётся
  // безопасным значением по умолчанию: при варианте B заказчик называет слаг сам, но до первого
  // замера мы не знаем какой (этап 1 плана).
  TICKET_OCR_MODEL: z.string().default('proxy'),
  TICKET_OCR_ESCALATION_MODEL: z.string().optional(),
  // Потолок обращений к прокси. Своей очереди у прокси две — наша клиентская и общая на всех, —
  // и упираться в чужую ценой отказов незачем.
  TICKET_OCR_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),
  // Длинная сторона после ресайза. Значение по умолчанию — потолок разрешения моделей 4.7+;
  // уточняется замером, потому что за пиксели платят токенами.
  TICKET_OCR_MAX_EDGE_PX: z.coerce.number().int().positive().default(2576),
  // Страниц в файле (В7): бухгалтерия сканирует пачкой на МФУ, и разбирать одну страницу из пяти
  // значило бы отправлять остальные на ручной ввод.
  TICKET_OCR_MAX_PAGES: z.coerce.number().int().positive().default(5),
  // Таймаут вызова зажат с двух сторон: он обязан быть меньше дедлайна прокси (~190 с) и меньше
  // `idle_in_transaction_session_timeout`, потому что вызов идёт внутри открытой транзакции.
  TICKET_OCR_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Доля подтверждённых машинных талонов, уходящая на слепую перепроверку.
  TICKET_OCR_BLIND_CHECK_RATE: z.coerce.number().min(0).max(1).default(0.05),
  // Допуски сверки. Жёсткая — сумма талонов против факта закрытия: ноль означает «до кубометра»,
  // потому что за это платят. Мягкая — против заявленного: заявка это план, недогруз законен, и
  // замечание ставится только на перегруз. Дневной допуск нужен исторической дате, где фактической
  // даты вывоза нет вовсе и сверять приходится с плановой.
  TICKET_VOLUME_TOLERANCE: z.coerce.number().min(0).default(0),
  TICKET_VOLUME_PLAN_TOLERANCE: z.coerce.number().min(0).max(1).default(0.1),
  TICKET_DATE_TOLERANCE_DAYS: z.coerce.number().int().min(0).default(3),
  // Срок хранения **несвязанных** попыток распознавания: попытку, на которую ссылается живой
  // талон, уборка не трогает — это журнал цифры, а не мусор.
  TICKET_OCR_ATTEMPT_TTL_DAYS: z.coerce.number().int().positive().default(180),

  SENTRY_DSN: z.string().optional(),
});

/** Значения-заглушки, которые недопустимы в production. */
const PLACEHOLDER_RE = /CHANGE_ME/i;
const SECRET_KEYS = [
  'DATABASE_URL',
  'COOKIE_SECRET',
  'CSRF_SECRET',
  'S3_SECRET_ACCESS_KEY',
  'JWT_PRIVATE_KEY_PEM',
  'JWT_PUBLIC_KEY_PEM',
  'SMTP_PASSWORD',
  'INTERNAL_API_TOKEN',
  'PROXY_LLM_TOKEN',
] as const;

/** PEM может быть задан inline или путём к файлу. */
function resolvePem(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes('BEGIN')) return value.replace(/\\n/g, '\n');
  // иначе — путь к файлу
  return readFileSync(value, 'utf8');
}

function loadConfig() {
  const parsed = rawSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';

  // Startup checks (§25): в production запрещены placeholder-значения.
  if (isProd) {
    for (const key of SECRET_KEYS) {
      const val = env[key];
      if (val && PLACEHOLDER_RE.test(val)) {
        throw new Error(`Секрет ${key} содержит placeholder-значение — задайте реальное.`);
      }
    }
    if (!env.PGSSLROOTCERT) {
      throw new Error('PGSSLROOTCERT обязателен в production (TLS verify-full к PostgreSQL).');
    }
  }

  // Почта включается целиком или не включается вовсе: половина настройки хуже выключенной: портал
  // принял бы регистрацию, которую невозможно подтвердить, и молча не отправил бы задание рейса.
  // Поэтому проверка на старте, а не отказ первого письма через сутки после выкатки.
  if (env.MAIL_ENABLED && env.MAIL_TRANSPORT === 'smtp') {
    const missing = (
      [
        ['SMTP_HOST', env.SMTP_HOST],
        ['SMTP_USER', env.SMTP_USER],
        ['SMTP_PASSWORD', env.SMTP_PASSWORD],
        ['MAIL_FROM', env.MAIL_FROM],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(
        `MAIL_ENABLED=true с MAIL_TRANSPORT=smtp требует заполнить: ${missing.join(', ')}.`,
      );
    }
  }

  // Распознавание талонов с боевым транспортом требует адреса и токена прокси. Проверка стоит
  // здесь, а не при первом вызове: талон приезжает к закрытию заявки, и «не задан
  // PROXY_LLM_TOKEN» обнаружился бы вечером на закрытии, а не при выкате — ровно та же логика,
  // по которой почтовые каналы поднимаются на старте.
  if (env.TICKET_OCR_ENABLED && env.AI_PROVIDER_MODE === 'proxy') {
    const missing = (
      [
        ['PROXY_LLM_BASE_URL', env.PROXY_LLM_BASE_URL],
        ['PROXY_LLM_TOKEN', env.PROXY_LLM_TOKEN],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(
        `TICKET_OCR_ENABLED=true с AI_PROVIDER_MODE=proxy требует заполнить: ${missing.join(', ')}.`,
      );
    }
  }

  const sslCa = env.PGSSLROOTCERT ? readFileSync(env.PGSSLROOTCERT, 'utf8') : undefined;

  return {
    env: env.NODE_ENV,
    isProd,
    isDev: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    port: env.API_PORT,
    host: env.API_HOST,
    publicOrigin: env.PUBLIC_ORIGIN,
    logLevel: env.LOG_LEVEL,
    db: {
      url: env.DATABASE_URL,
      migrationUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
      sslCa,
      poolMax: env.DB_POOL_MAX,
    },
    auth: {
      privateKeyPem: resolvePem(env.JWT_PRIVATE_KEY_PEM),
      publicKeyPem: resolvePem(env.JWT_PUBLIC_KEY_PEM)!,
      kid: env.JWT_KID,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtl: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtl: env.REFRESH_TOKEN_TTL_SECONDS,
      cookieSecret: env.COOKIE_SECRET,
      csrfSecret: env.CSRF_SECRET,
      argon: {
        memoryCost: env.ARGON_MEMORY_KIB,
        timeCost: env.ARGON_TIME_COST,
        parallelism: env.ARGON_PARALLELISM,
      },
    },
    s3: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      uploadUrlTtl: env.S3_UPLOAD_URL_TTL_SECONDS,
      downloadUrlTtl: env.S3_DOWNLOAD_URL_TTL_SECONDS,
    },
    files: {
      maxSize: env.FILE_MAX_SIZE_BYTES,
      maxPerRequest: env.FILE_MAX_PER_REQUEST,
    },
    soffice: {
      bin: env.SOFFICE_BIN,
      timeoutMs: env.SOFFICE_TIMEOUT_MS,
    },
    mail: {
      enabled: env.MAIL_ENABLED,
      transport: env.MAIL_TRANSPORT,
      from: env.MAIL_FROM ?? '',
      replyTo: env.MAIL_REPLY_TO ?? '',
      maxPerMinute: env.MAIL_MAX_PER_MINUTE,
      timezone: env.MAIL_SCHEDULER_TIMEZONE,
      verifyTtl: env.MAIL_VERIFY_TTL_SECONDS,
      resetTtl: env.MAIL_RESET_TTL_SECONDS,
      registrationExpiryDays: env.MAIL_REGISTRATION_EXPIRY_DAYS,
      internalToken: env.INTERNAL_API_TOKEN ?? '',
      accounts: mailAccountsFromEnv(),
    },
    serviceRequests: {
      /** Размер пачки автозакрытия «Решена» → «Закрыта» за один прогон (Н7). */
      autoCloseBatch: env.SERVICE_REQUEST_AUTO_CLOSE_BATCH,
    },
    ticketOcr: {
      enabled: env.TICKET_OCR_ENABLED,
      mode: env.AI_PROVIDER_MODE,
      proxy: {
        baseUrl: env.PROXY_LLM_BASE_URL ?? '',
        token: env.PROXY_LLM_TOKEN ?? '',
        ackNoProviderPolicy: env.PROXY_LLM_ACK_NO_PROVIDER_POLICY,
      },
      model: env.TICKET_OCR_MODEL,
      escalationModel: env.TICKET_OCR_ESCALATION_MODEL ?? '',
      maxPerMinute: env.TICKET_OCR_MAX_PER_MINUTE,
      maxEdgePx: env.TICKET_OCR_MAX_EDGE_PX,
      maxPages: env.TICKET_OCR_MAX_PAGES,
      httpTimeoutMs: env.TICKET_OCR_HTTP_TIMEOUT_MS,
      blindCheckRate: env.TICKET_OCR_BLIND_CHECK_RATE,
      tolerances: {
        volumeM3: env.TICKET_VOLUME_TOLERANCE,
        volumePlanShare: env.TICKET_VOLUME_PLAN_TOLERANCE,
        dateDays: env.TICKET_DATE_TOLERANCE_DAYS,
      },
      attemptTtlDays: env.TICKET_OCR_ATTEMPT_TTL_DAYS,
    },
    sentryDsn: env.SENTRY_DSN,
  };
}

/**
 * Состояние почтовых каналов (план `docs/office-equipment-mail-and-history-plan.md`, Р83–Р89).
 *
 * Отправляет письма worker, и настройки каналов — его: `MAIL_ACCOUNT_<КЛЮЧ>_*` в общем `prod.env`.
 * API сюда лезет ровно за двумя вещами: настроен ли канал на этом сервере и от кого придёт письмо.
 * Первое нужно, чтобы отладочная отправка не предлагала канал, которого нет, — иначе письмо тихо
 * ляжет в очередь и будет ждать настройки; второе — чтобы в форме было видно отправителя.
 *
 * Читается напрямую из `process.env`, а не через схему конфигурации: эти переменные принадлежат
 * воркеру, и объявлять их обязательными для API значило бы требовать почтовые настройки от
 * процесса, который писем не отправляет. **Пароля здесь нет и быть не должно** — только признак и
 * адрес отправителя.
 */
function mailAccountsFromEnv(): Record<MailAccount, { configured: boolean; from: string }> {
  const read = (account: MailAccount): { configured: boolean; from: string } => {
    if (account === DEFAULT_MAIL_ACCOUNT) {
      const from = process.env.MAIL_FROM ?? '';
      return { configured: !!process.env.SMTP_HOST && !!from, from };
    }
    const prefix = mailAccountEnvPrefix(account);
    const from = (prefix ? process.env[`${prefix}_FROM`] : undefined) ?? '';
    const host = (prefix ? process.env[`${prefix}_HOST`] : undefined) ?? '';
    return { configured: !!host && !!from, from };
  };
  return Object.fromEntries(MAIL_ACCOUNTS.map((a) => [a, read(a)])) as Record<
    MailAccount,
    { configured: boolean; from: string }
  >;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config: AppConfig = loadConfig();

/** Проверка наличия приватного ключа (только для api, не для worker). */
export function assertSigningKey(cfg: AppConfig): asserts cfg is AppConfig & {
  auth: { privateKeyPem: string };
} {
  if (!cfg.auth.privateKeyPem) {
    throw new Error('JWT_PRIVATE_KEY_PEM обязателен для api-сервиса (подпись access-токенов).');
  }
}
