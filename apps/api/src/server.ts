import { buildApp } from './app';
import { startCaptchaCanary, stopCaptchaCanary } from './auth/captcha';
import { assertSigningKey, config } from './config';
import { closeDb, pingDb } from './db/client';
import { assertMigrationsApplied } from './db/migration-check';
import { assertStockFrozenEmpty } from './db/stock-frozen';
import { logger } from './logger';

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

  // Canary SmartCaptcha (`docs/smart-captcha-plan.md` §7–§8): сразу после старта и дальше раз в
  // час. Шлёт заведомо мусорный токен и ждёт отказа — в ограниченном режиме (неактивный платёжный
  // аккаунт) сервис отвечает `ok` на всё, и портал остался бы без защиты при здоровых на вид
  // метриках. Без `await`: открытый порт не должен зависеть от доступности чужого сервиса, а
  // таймер внутри `unref()` и процесс не держит.
  startCaptchaCanary();

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
