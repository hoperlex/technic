import { buildApp } from './app';
import { assertSigningKey, config } from './config';
import { closeDb, pingDb } from './db/client';
import { logger } from './logger';

async function main(): Promise<void> {
  assertSigningKey(config); // startup check: приватный ключ обязателен для api

  try {
    await pingDb();
  } catch (e) {
    logger.error({ err: e }, 'Не удалось подключиться к PostgreSQL при старте');
    throw e;
  }

  const app = await buildApp();
  await app.listen({ host: config.host, port: config.port });
  logger.info(`API слушает на ${config.host}:${config.port} (${config.env})`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Плавная остановка');
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
