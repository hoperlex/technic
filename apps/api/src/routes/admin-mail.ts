import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  dateOnlySchema,
  MAIL_TEST_NOTE,
  MAIL_TEST_SUBJECT_PREFIX,
  type MailTestKind,
  mailTestSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { queueMail } from '../services/mail';
import type { MailContent } from '../services/mail-templates';
import { buildDriverRoutesMail, driversWithRoutes } from '../services/mailings/driver-routes';
import {
  PASSWORD_CHANGED_SUBJECT,
  passwordChangedContent,
  passwordResetContent,
  RESET_SUBJECT,
  VERIFY_SUBJECT,
  verifyEmailContent,
} from '../services/mail-auth';

/**
 * Рассылки: отладочная отправка письма администратору.
 *
 * Зачем отдельно от предпросмотра: предпросмотр показывает письмо в браузере, а проверить надо
 * ровно то, чего браузер не показывает, — доставку, тему в списке писем, вёрстку в почтовом
 * клиенте и вид на телефоне. Это видно только в доставленном письме, поэтому оно и отправляется
 * по-настоящему — но с пометкой и мимо статистики.
 */

/**
 * Значение вместо токена в тестовых письмах. Настоящую одноразовую ссылку на чужую учётку по
 * кнопке не выпускают: рабочая ссылка проверяется своим сценарием — регистрацией или
 * «Забыли пароль?» на собственной учётной записи.
 */
const FAKE_TOKEN = 'test-link-not-valid';

/**
 * Содержимое письма для отладки. Задание водителю собирается тем же кодом, что и настоящая
 * рассылка, — иначе проверка показывала бы не то письмо, которое потом уйдёт людям.
 */
async function contentFor(
  kind: MailTestKind,
  opts: { date?: string; driverPersonId?: string },
): Promise<{ subject: string; content: MailContent } | null> {
  switch (kind) {
    case 'verify_email':
      return { subject: VERIFY_SUBJECT, content: verifyEmailContent(FAKE_TOKEN) };
    case 'password_reset':
      return { subject: RESET_SUBJECT, content: passwordResetContent(FAKE_TOKEN) };
    case 'password_changed':
      return { subject: PASSWORD_CHANGED_SUBJECT, content: passwordChangedContent() };
    case 'driver_routes': {
      const date = opts.date!;
      const drivers = await driversWithRoutes(date, date);
      // Без явного выбора берётся первый водитель с рейсами: чаще проверяют «как вообще выглядит
      // задание», а не письмо конкретного человека.
      const driver = opts.driverPersonId
        ? drivers.find((d) => d.personId === opts.driverPersonId)
        : drivers[0];
      if (!driver) return null;
      const mail = await buildDriverRoutesMail({
        personId: driver.personId,
        driverName: driver.fullName,
        dateFrom: date,
        dateTo: date,
      });
      return mail ? { subject: mail.subject, content: mail.content } : null;
    }
  }
}

/** Тестовое письмо обязано читаться как тестовое: пометка в теме и приписка в теле. */
function markAsTest(subject: string, content: MailContent): { subject: string; body: MailContent } {
  return {
    subject: `${MAIL_TEST_SUBJECT_PREFIX} ${subject}`,
    body: { ...content, blocks: [...content.blocks, { kind: 'note', text: MAIL_TEST_NOTE }] },
  };
}

export default async function adminMailRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const readGuards = { preHandler: [app.authenticate, app.requirePermission('mailings.read')] };
  const manageGuards = { preHandler: [app.authenticate, app.requirePermission('mailings.manage')] };

  /**
   * Кому можно отправить тест. Отдельный маршрут, а не фильтр общего списка пользователей: список
   * учёток закрыт правом `users.manage`, а рассылками может заниматься другой человек — и ему
   * нужны не учётки, а адреса, куда допустимо слать проверочное письмо.
   */
  r.get('/test-recipients', readGuards, async () => {
    const rows = await db
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true), isNull(users.deletedAt)))
      .orderBy(asc(users.fullName));
    return rows;
  });

  /** Водители, у которых на дату есть рейсы: из них выбирается образец для проверки задания. */
  r.get(
    '/drivers-with-routes',
    { ...readGuards, schema: { querystring: z.object({ date: dateOnlySchema }) } },
    async (req) => driversWithRoutes(req.query.date, req.query.date),
  );

  r.post('/test', { ...manageGuards, schema: { body: mailTestSchema } }, async (req) => {
    const actor = requirePrincipal(req);
    const { kind, toUserId } = req.body;

    const [recipient] = await db
      .select({ id: users.id, email: users.email, role: users.role, isActive: users.isActive })
      .from(users)
      .where(and(eq(users.id, toUserId), isNull(users.deletedAt)));
    // Получатель проверяется на сервере, а не только выбором в списке: в теле письма настоящие
    // рабочие данные, и отправить его можно лишь тому, кто и так видит их все в портале.
    if (!recipient || recipient.role !== 'admin' || !recipient.isActive) {
      throw err.badRequest('Тестовое письмо отправляется только действующему администратору');
    }

    const built = await contentFor(kind, {
      ...(req.body.date ? { date: req.body.date } : {}),
      ...(req.body.driverPersonId ? { driverPersonId: req.body.driverPersonId } : {}),
    });
    // Пустое письмо не отправляется: молчаливый успех на дате без рейсов читался бы как «письмо
    // ушло», и человек ждал бы его в ящике.
    if (!built) {
      throw err.badRequest('За выбранную дату данных для письма нет — отправлять нечего');
    }
    const marked = markAsTest(built.subject, built.content);

    const id = await queueMail({
      kind,
      // Свой ключ на каждую отправку: один и тот же тест шлют сколько угодно раз, и настоящему
      // письму с тем же смыслом он мешать не должен.
      dedupeKey: `test:${kind}:${randomUUID()}`,
      to: recipient.email,
      subject: marked.subject,
      content: marked.body,
      userId: recipient.id,
      isTest: true,
    });

    await writeAudit({
      actorUserId: actor.id,
      action: 'mailing.test_sent',
      entityType: 'user',
      entityId: recipient.id,
      metadata: { kind, date: req.body.date ?? null },
    });

    return {
      ok: true,
      mailMessageId: id,
      message: `Письмо поставлено в очередь на ${recipient.email}`,
    };
  });
}
