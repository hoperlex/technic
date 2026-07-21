import { pino } from 'pino';
import { config } from './config';

/** Пути, маскируемые в логах (§20). */
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'token',
  'secretAccessKey',
  '*.password',
  '*.newPassword',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
];

export const logger = pino({
  level: config.logLevel,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  transport: config.isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});
