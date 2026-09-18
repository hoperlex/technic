import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  mailLogQuerySchema,
  type MailLogItemDto,
  type MailLogMessageDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { mailMessages } from '../db/schema';
import { err } from '../lib/errors';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

/**
 * Журнал отправки писем (ADR 0199): очередь `mail_messages` глазами администратора.
 *
 * **Только чтение, и это граница ручки.** Ни повтора, ни правки, ни удаления строк здесь нет и не
 * будет: повторную отправку письма модуля делает кнопка в карточке заявки — она знает событие и
 * якорь дедупликации, а строка очереди про них помнит только ключ. Ручка «отправить это письмо ещё
 * раз» по строке журнала означала бы второй способ ставить письма, расходящийся с первым.
 *
 * **Отбор по каналу обязателен** (умолчание в схеме): `default` — это сотни заданий водителям за
 * день, `repair` — письма по заявкам оргтехники, и в общем списке вторые тонут в первых ровно
 * тогда, когда их ищут.
 *
 * **Право — `mailings.read`, то же, что у настроек рассылок.** Тело письма содержит рабочие данные
 * заявки (описание поломки, контакт ответственного, суммы), и отдавать его можно тому, кто и так
 * видит их в портале; отдельного права заводить не за что — раздел «Рассылки» целиком
 * административный. Область видимости у журнала своей нет: администратору видно всё, а
 * `mailings.read` никому, кроме него, не выдаётся.
 */

const idParams = z.object({ id: z.string().uuid() });

const sortCols = {
  createdAt: mailMessages.createdAt,
  toEmail: mailMessages.toEmail,
  status: mailMessages.status,
};

/** Строка списка: тела письма в ней нет намеренно — страница из пятисот тел весила бы мегабайты. */
function toItem(row: typeof mailMessages.$inferSelect): MailLogItemDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    kind: row.kind,
    toEmail: row.toEmail,
    subject: row.subject,
    status: row.status,
    sentAt: row.sentAt?.toISOString() ?? null,
    lastError: row.lastError,
    isTest: row.isTest,
  };
}

export default async function mailLogRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('mailings.read')] };

  r.get('/log', { ...guards, schema: { querystring: mailLogQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      eq(mailMessages.account, q.account),
      q.kind ? eq(mailMessages.kind, q.kind) : undefined,
      q.status ? eq(mailMessages.status, q.status) : undefined,
      q.from ? gte(mailMessages.createdAt, q.from) : undefined,
      q.to ? lte(mailMessages.createdAt, q.to) : undefined,
      /*
       * Поиск — по адресу и теме. Тело в поиск не входит: `LIKE` по нему прочитал бы всю очередь
       * целиком (тела измеряются килобайтами), а ищут по журналу не слова из письма, а адресата и
       * номер заявки — номер стоит в теме каждого письма модуля.
       */
      searchCondition(q.search, [mailMessages.toEmail, mailMessages.subject]),
    );
    const p = pageParams(q);
    const [rows, totalRow] = await Promise.all([
      db
        .select()
        .from(mailMessages)
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
        .limit(p.limit)
        .offset(p.offset),
      db.select({ c: count() }).from(mailMessages).where(where),
    ]);
    return {
      items: rows.map(toItem),
      total: Number(totalRow[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });

  /**
   * Письмо целиком. Отдельным запросом, а не полем списка: тело читают у одной строки — той, по
   * которой кликнули, — и тащить их все ради одной означало бы страницу в мегабайты.
   */
  r.get('/log/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, req.params.id));
    if (!row)
      throw err.notFound('Письмо не найдено — возможно, его уже вычистили по сроку хранения');
    const dto: MailLogMessageDto = {
      ...toItem(row),
      account: row.account,
      replyTo: row.replyTo,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      providerId: row.providerId,
      dedupeKey: row.dedupeKey,
      entityType: row.entityType,
      entityId: row.entityId,
    };
    return dto;
  });
}
