import { buildApp } from './app';
import { startCaptchaCanary, stopCaptchaCanary } from './auth/captcha';
import { assertSigningKey, config } from './config';
import { watchPoolStall } from './db/bounded-pool';
import { closeDb, pingDb, pool } from './db/client';
import { assertMigrationsApplied } from './db/migration-check';
import { assertStockFrozenEmpty } from './db/stock-frozen';
import { armReadinessWatch, readinessStreak } from './lib/readiness-watch';
import { logger } from './logger';

/**
 * Three failed checks over at least a minute: with Docker's 30-second interval that is the third
 * check in a row. A managed cluster's failover takes seconds, so a streak this long means the
 * process, not the cluster, is what does not recover.
 */
const READINESS_LOST_FAILURES = 3;
const READINESS_LOST_SPAN_MS = 60_000;

/**
 * Exit so that Docker starts a fresh process (`restart: unless-stopped`). No graceful close: it
 * would wait for the very requests that are stuck.
 */
function exitForRestart(details: object, message: string): void {
  logger.fatal(details, message);
  process.exit(1);
}

async function main(): Promise<void> {
  assertSigningKey(config); // startup check: приватный ключ обязателен для api

  // Диагностика S3 (без секретов): позволяет заметить, что runtime использует не тот
  // bucket/endpoint (напр. `auto` вместо `technic-portal-files`). Ключи НЕ логируем.
  logger.info(
    {
      s3Endpoint: config.s3.endpoint,
      s3Region: config.s3.region,
      s3Bucket: config.s3.bucket,
      s3ForcePathStyle: config.s3.forcePathStyle,
      s3UploadTtl: config.s3.uploadUrlTtl,
    },
    'S3 конфигурация',
  );

  try {
    await pingDb();
  } catch (e) {
    logger.error({ err: e }, 'Не удалось подключиться к PostgreSQL при старте');
    throw e;
  }

  // Схема — до первого запроса: неприменённая миграция иначе выстрелит пятисоткой в середине
  // чужого действия, и человек прочитает это как поломку формы, а не как несобранную базу.
  await assertMigrationsApplied();

  // Пустота склада — до первого запроса и до сборки приложения (план чеков, Р24): заморозка при
  // непустых таблицах не ломает ничего заметного, она молча убирает записи с экрана, оставляя их в
  // базе. В проде это отказ старта, в деве — предупреждение (там таблицы не пусты от пробного
  // заведения). Барьер живёт до сноса склада и снимается вместе с ним.
  await assertStockFrozenEmpty();

  const app = await buildApp();
  await app.listen({ host: config.host, port: config.port });
  logger.info(`API слушает на ${config.host}:${config.port} (${config.env})`);

  // Armed after `listen`: a database that fails before the port opens is a failed start above.
  // Twice the query deadline, because that deadline frees stuck clients by itself.
  watchPoolStall(pool, {
    stallMs: 2 * config.db.queryTimeoutMs,
    onStall: (stall) =>
      exitForRestart(
        stall,
        'Пул PostgreSQL не выдаёт соединения: процесс завершается для перезапуска',
      ),
  });
  armReadinessWatch(
    readinessStreak({
      minFailures: READINESS_LOST_FAILURES,
      minSpanMs: READINESS_LOST_SPAN_MS,
      onLost: (streak) =>
        exitForRestart(
          streak,
          'Проверка готовности не проходит: процесс завершается для перезапуска',
        ),
    }),
  );

  // Canary SmartCaptcha (`docs/smart-captcha-plan.md` §7–§8): сразу после старта и дальше раз в
  // час. Шлёт заведомо мусорный токен и ждёт отказа — в ограниченном режиме (неактивный платёжный
  // аккаунт) сервис отвечает `ok` на всё, и портал остался бы без защиты при здоровых на вид
  // метриках. Без `await`: открытый порт не должен зависеть от доступности чужого сервиса, а
  // таймер внутри `unref()` и процесс не держит.
  startCaptchaCanary();
  // A paused captcha is an open door on three public forms; every start says so, so the pause
  // cannot quietly outlive the reason it was set for (ADR 0130, item 16).
  if (config.captcha.paused) {
    logger.warn(
      'SmartCaptcha выключена владельцем (SMARTCAPTCHA_DISABLED=true): публичные формы без капчи',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Плавная остановка');
    stopCaptchaCanary();
    try {
      await app.close();
      await closeDb();
    } catch (e) {
      logger.error({ err: e }, 'Ошибка при остановке');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error({ err: e }, 'Фатальная ошибка старта');
  process.exit(1);
});
