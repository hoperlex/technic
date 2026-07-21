import { readFileSync } from 'node:fs';
import { z } from 'zod';

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

  MAIL_ENABLED: boolFromEnv(false),
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
    mailEnabled: env.MAIL_ENABLED,
    sentryDsn: env.SENTRY_DSN,
  };
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
