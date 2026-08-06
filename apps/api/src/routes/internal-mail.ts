import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../config';
import { err } from '../lib/errors';
import { createRun, dueSchedules, performRun } from '../services/mailings/run';

/**
 * Внутренние маршруты почты: ими планировщик из worker просит API выполнить рассылку (ADR 0075).
 *
 * Почему сборку письма делает API, а не сам worker: правила видимости и состав письма живут здесь —
 * в сервисах, работающих через drizzle и общие контракты. Worker подключён к базе голым `pg`;
 * повторять там область видимости значило бы завести второй экземпляр правил, где ошибка означает
 * чужие данные в письме. Вдобавок предпросмотр в админке и настоящая рассылка обязаны собирать
 * одно и то же письмо одним кодом.
 *
 * Доступ — по общему секрету, а не по учётной записи: у планировщика нет человека, от чьего имени
 * он действует. Наружу префикс `/internal` не проксируется (см. `deploy/nginx/technic.conf`), и это
 * второй рубеж: даже с утёкшим токеном постучаться можно только из внутренней сети.
 */

function assertInternalToken(req: FastifyRequest): void {
  const expected = config.mail.internalToken;
  // Пустой секрет не открывает дверь всем: он закрывает её совсем. Иначе портал, забывший
  // заполнить `INTERNAL_API_TOKEN`, пускал бы кого угодно с пустым заголовком.
  if (!expected) throw err.unauthorized('Внутренний доступ не настроен');
  const got = req.headers['x-internal-token'];
  if (typeof got !== 'string' || got !== expected) {
    throw err.unauthorized('Недействительный внутренний токен');
  }
}

export default async function internalMailRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Расписания, чьё время наступило: worker спрашивает их раз в минуту. */
  r.get('/schedules/due', async (req) => {
    assertInternalToken(req);
    const rows = await dueSchedules(new Date());
    return rows.map((row) => ({ id: row.id, plannedAt: row.plannedAt.toISOString() }));
  });

  /**
   * Завести запуск на назначенное время и сразу его выполнить.
   *
   * Два действия одним вызовом, потому что worker'у нечего делать между ними: он не умеет ни
   * собирать письма, ни решать, что делать с полупройденным запуском. `null` в ответе на создание
   * означает, что запуск уже создан кем-то другим, — и это нормальный исход, а не ошибка.
   */
  r.post(
    '/runs',
    {
      schema: {
        body: z.object({
          scheduleId: z.string().uuid(),
          plannedAt: z.string().datetime(),
          isManual: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      assertInternalToken(req);
      const runId = await createRun({
        scheduleId: req.body.scheduleId,
        plannedAt: new Date(req.body.plannedAt),
        ...(req.body.isManual === undefined ? {} : { isManual: req.body.isManual }),
      });
      if (!runId) return { created: false, runId: null, stats: null };
      const stats = await performRun(runId);
      return { created: true, runId, stats };
    },
  );
}
