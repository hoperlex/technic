import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  dateOnlySchema,
  MAIL_ACCOUNTS,
  type MailAccountStatusDto,
  MAIL_TEST_NOTE,
  MAIL_TEST_SUBJECT_PREFIX,
  type MailTestKind,
  mailTestKindNeedsRequest,
  mailTestSchema,
  type Role,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { queueMail } from '../services/mail';
import {
  loadServiceLetterData,
  serviceLetterContent,
  type ServiceLetterData,
  type ServiceLetterExtra,
} from '../services/service-request-mail';
import type { MailContent } from '../services/mail-templates';
import { buildDriverRoutesMail, driversWithRoutes } from '../services/mailings/driver-routes';
import { buildRoleDigestMail } from '../services/mailings/role-digest';
import { windowOf } from '../services/mailings/schedule';
import {
  ACCOUNT_CREATED_SUBJECT,
  accountCreatedContent,
  PASSWORD_CHANGED_SUBJECT,
  passwordChangedContent,
  passwordResetContent,
  REGISTRATION_APPROVED_SUBJECT,
  REGISTRATION_REJECTED_SUBJECT,
  registrationApprovedContent,
  registrationRejectedContent,
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
 * Ответ заявителю в отладочном отказе. В настоящем письме этот абзац набирает администратор — и
 * ровно он в письме непредсказуем; образец взят такой же длины, как обычная причина отказа, чтобы
 * абзац лёг в письмо так же, как ляжет в жизни.
 */
const SAMPLE_REJECT_MESSAGE =
  'Учётная запись на этот адрес уже заведена — войдите под ней или воспользуйтесь восстановлением пароля.';

/**
 * Роль в отладочных письмах про учётную запись. Роль получателя сюда не годится: тест уходит только
 * администратору (маршрут иначе отказывает), и подпись всегда была бы одна и та же — самая короткая
 * из возможных. Взята самая длинная: подпись роли стоит в середине абзаца, и переносится он на ней.
 */
const SAMPLE_ROLE: Role = 'operator';

/**
 * Содержимое письма для отладки. Задание водителю собирается тем же кодом, что и настоящая
 * рассылка, — иначе проверка показывала бы не то письмо, которое потом уйдёт людям.
 */
/**
 * Чем дополнить образец, чтобы он показывал письмо целиком. У события переходов это «было → стало»,
 * у объёма работ — действие и ревизия, у документа и реплики — то, чего в строке заявки нет вовсе.
 * Значения показательные: образец проверяет вёрстку, а не данные конкретного дня.
 */
function sampleExtraFor(
  kind: MailTestKind,
  data: ServiceLetterData,
): ServiceLetterExtra | undefined {
  switch (kind) {
    case 'service_request_status_changed':
      return { fromStatus: 'in_work', comment: 'Ждём запчасть от поставщика' };
    case 'service_request_estimate':
      return { estimate: { revision: Math.max(1, data.num % 3), action: 'submit' } };
    case 'service_request_document':
      return { document: { kind: 'act', names: ['akt-2026-09.pdf'], total: 3 } };
    case 'service_request_comment':
      return {
        message: {
          authorName: 'Оператор оргтехники',
          addressees: 'Сервисному центру',
          body: 'Образец реплики: письмо показывает текст сообщения целиком.',
        },
      };
    default:
      return undefined;
  }
}

async function contentFor(
  kind: MailTestKind,
  opts: {
    date?: string;
    driverPersonId?: string;
    sampleUserId?: string;
    /** Заявка-образец для писем модуля «Орг.техника». */
    sampleRequestId?: string;
    /** Окно данных от дня рассылки — те же два числа, что у расписания (ADR 0093). */
    windowFromDays: number;
    windowDays: number;
  },
): Promise<{ subject: string; content: MailContent } | null> {
  switch (kind) {
    /**
     * Письма модуля «Орг.техника» собираются по РЕАЛЬНОЙ заявке и тем же кодом, что уходит людям
     * (план расширения почты, §5.13). Аудитория — `internal`: у администратора портал есть, и
     * образец должен показать письмо целиком, вместе со ссылкой; тела подрядчика и копии
     * проверяются контрактными тестами, а не отладочной отправкой на чужой ящик.
     */
    case 'service_request_waiting_it':
    case 'service_request_cancelled':
    case 'service_request_assigned':
    case 'service_request_status_changed':
    case 'service_request_estimate':
    case 'service_request_document':
    case 'service_request_comment': {
      if (!opts.sampleRequestId) return null;
      /**
       * Заявки может не быть — администратор вводит номер руками. Мягкий `null` вместо исключения:
       * ручка отвечает по нему понятным отказом формы, а 500 из сборки письма выглядел бы поломкой
       * портала там, где человек просто опечатался.
       */
      const data = await db
        .transaction((tx) => loadServiceLetterData(tx, opts.sampleRequestId!))
        .catch(() => null);
      if (!data) return null;
      /**
       * Сборка тела тоже бывает законно невозможной: письмо о назначении требует назначенных, и по
       * заявке без исполнителей падает намеренно (тем же кодом, что и в проде). Для отладки это не
       * поломка, а «возьмите другую заявку».
       */
      try {
        const letter = serviceLetterContent(kind, data, 'internal', sampleExtraFor(kind, data));
        return { subject: letter.subject, content: letter.content };
      } catch {
        return null;
      }
    }
    case 'verify_email':
      return { subject: VERIFY_SUBJECT, content: verifyEmailContent(FAKE_TOKEN) };
    case 'password_reset':
      return { subject: RESET_SUBJECT, content: passwordResetContent(FAKE_TOKEN) };
    case 'password_changed':
      return { subject: PASSWORD_CHANGED_SUBJECT, content: passwordChangedContent() };
    case 'registration_rejected':
      return {
        subject: REGISTRATION_REJECTED_SUBJECT,
        content: registrationRejectedContent(SAMPLE_REJECT_MESSAGE),
      };
    case 'registration_approved':
      return {
        subject: REGISTRATION_APPROVED_SUBJECT,
        content: registrationApprovedContent(SAMPLE_ROLE),
      };
    case 'account_created':
      return { subject: ACCOUNT_CREATED_SUBJECT, content: accountCreatedContent(SAMPLE_ROLE) };
    case 'driver_routes': {
      // Окно считается от выбранного дня тем же кодом, что у настоящего запуска: умолчание
      // «сегодняшний, на день» оставляет прежнее поведение отладки — рейсы ровно этой даты.
      const plannedAt = new Date(`${opts.date!}T12:00:00Z`);
      const window = windowOf(
        plannedAt,
        opts.windowFromDays,
        opts.windowDays,
        config.mail.timezone,
      );
      const drivers = await driversWithRoutes(window.from, window.to);
      // Без явного выбора берётся первый водитель с рейсами: чаще проверяют «как вообще выглядит
      // задание», а не письмо конкретного человека.
      const driver = opts.driverPersonId
        ? drivers.find((d) => d.personId === opts.driverPersonId)
        : drivers[0];
      if (!driver) return null;
      const mail = await buildDriverRoutesMail({
        personId: driver.personId,
        driverName: driver.fullName,
        dateFrom: window.from,
        dateTo: window.to,
      });
      return mail ? { subject: mail.subject, content: mail.content } : null;
    }
    case 'role_digest': {
      // Дата в форме — день рассылки, а не сам период: окно считается от неё тем же кодом, что у
      // настоящего запуска. Полдень по UTC берётся, чтобы часовой пояс портала не увёл выбранный
      // день на соседние сутки.
      const plannedAt = new Date(`${opts.date!}T12:00:00Z`);
      const window = windowOf(
        plannedAt,
        opts.windowFromDays,
        opts.windowDays,
        config.mail.timezone,
      );

      // Письмо собирается областью видимости образца, а не получателя: сводка у каждого своя, и
      // проверяют обычно именно чужую — «что увидит начальник участка». Без явного выбора образцом
      // становится сам получатель-администратор: это ответ на вопрос «как письмо выглядит вообще».
      //
      // Образец проверяется отдельно от сборки: у недействующей учётки области видимости нет вовсе,
      // и письмо получилось бы пустым — а пустое здесь означает «за эту дату ничего не произошло»,
      // то есть человек чинил бы не ту причину. Подтверждение адреса не требуется: образцу ничего
      // не отправляется, письмо уходит получателю.
      const [sample] = await db
        .select({ userId: users.id, fullName: users.fullName, email: users.email })
        .from(users)
        .where(
          and(eq(users.id, opts.sampleUserId!), eq(users.isActive, true), isNull(users.deletedAt)),
        );
      if (!sample) {
        throw err.badRequest('Учётная запись образца не найдена или недействующая');
      }

      const mail = await buildRoleDigestMail({
        recipient: sample,
        windowFrom: window.from,
        windowTo: window.to,
        // Обе таблицы и вся область образца: это отладка, и смотреть надо максимум возможного. Чем
        // ограничить состав настоящего письма, решает расписание, а не эта форма.
        showTrips: true,
        showOnsite: true,
        requestScope: 'scope',
        scopeMode: 'all',
        objectIds: [],
        departmentIds: [],
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

  /**
   * Учётные записи, чьими глазами можно посмотреть сводку. Список не зависит от даты, в отличие от
   * водителей: сводка собирается под любым действующим человеком, а «пусто» — это уже её ответ.
   *
   * Условие то же, что у настоящих получателей сводки (ADR 0078): действующая неархивная учётка с
   * подтверждённым адресом. Иначе в отладке проверялось бы письмо тому, кому оно всё равно не
   * уйдёт, и «у него пусто» ничего бы не значило.
   */
  r.get('/digest-sample-users', readGuards, async () => {
    const rows = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(
        and(eq(users.isActive, true), isNull(users.deletedAt), isNotNull(users.emailVerifiedAt)),
      )
      .orderBy(asc(users.fullName));
    return rows;
  });

  /** Водители, у которых на дату есть рейсы: из них выбирается образец для проверки задания. */
  r.get(
    '/drivers-with-routes',
    { ...readGuards, schema: { querystring: z.object({ date: dateOnlySchema }) } },
    async (req) => driversWithRoutes(req.query.date, req.query.date),
  );

  /**
   * Какие каналы настроены на этом сервере (Р89). Нужна отладке: канал, которого в `env` нет,
   * предлагать нельзя — письмо тихо легло бы в очередь и ждало настройки, а человек считал бы, что
   * проверил отправку.
   *
   * Секретов не отдаёт: только признак и адрес отправителя, по которому видно, от кого придёт
   * письмо.
   */
  r.get('/accounts', readGuards, async (): Promise<MailAccountStatusDto[]> => {
    return MAIL_ACCOUNTS.map((account) => ({
      account,
      configured: config.mail.accounts[account].configured,
      from: config.mail.accounts[account].from,
    }));
  });

  r.post('/test', { ...manageGuards, schema: { body: mailTestSchema } }, async (req) => {
    const actor = requirePrincipal(req);
    const { kind, toUserId, account } = req.body;

    // Канал должен быть настроен именно на сервере: иначе письмо ляжет в очередь и будет ждать
    // `env`, а отладка тем временем ответит «отправлено».
    if (!config.mail.accounts[account].configured) {
      throw err.badRequest('Этот почтовый канал не настроен на сервере', {
        account: 'Канал не настроен',
      });
    }

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
      // Образец по умолчанию — сам получатель: у администратора область видимости полная, и такая
      // сводка показывает письмо целиком, ничего не пряча.
      sampleUserId: req.body.sampleUserId ?? toUserId,
      ...(req.body.sampleRequestId ? { sampleRequestId: req.body.sampleRequestId } : {}),
      windowFromDays: req.body.windowFromDays,
      windowDays: req.body.windowDays,
    });
    // Пустое письмо не отправляется: молчаливый успех на дате без рейсов читался бы как «письмо
    // ушло», и человек ждал бы его в ящике.
    if (!built) {
      throw err.badRequest(
        mailTestKindNeedsRequest[kind]
          ? 'По этой заявке письмо не собирается — проверьте номер и состав заявки'
          : 'За выбранную дату данных для письма нет — отправлять нечего',
      );
    }
    const marked = markAsTest(built.subject, built.content);

    const id = await queueMail({
      kind,
      // Канал уходит в письмо: воркер по нему выберет транспорт и отправителя.
      account,
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
      // Образец пишется в журнал: письмо собрано чужой областью видимости, и след «кого именно
      // показали администратору» — часть ответа на вопрос, кто чьи данные видел.
      metadata: {
        kind,
        date: req.body.date ?? null,
        sampleUserId: req.body.sampleUserId ?? null,
        // Письмо модуля целиком состоит из данных конкретной заявки — какой именно, журнал обязан
        // помнить: «показали администратору чужие данные» разбирают по этой строке.
        sampleRequestId: req.body.sampleRequestId ?? null,
      },
    });

    return {
      ok: true,
      mailMessageId: id,
      message: `Письмо поставлено в очередь на ${recipient.email}`,
    };
  });
}
