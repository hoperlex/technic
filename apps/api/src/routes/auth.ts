import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type CaptchaConfig,
  changePasswordSchema,
  EMAIL_VERIFICATION_ENABLED,
  isPermission,
  isPersonScopedRole,
  loginSchema,
  NEUTRAL_MAIL_RESPONSE,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  resendVerificationSchema,
  verifyEmailSchema,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { counterparties, persons, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../lib/cookies';
import { hashPassword, verifyPassword } from '../auth/password';
import { verifyCaptcha } from '../auth/captcha';
import { signAccessToken } from '../auth/tokens';
import {
  createRefreshSession,
  revokeAllForUser,
  revokeRefreshByToken,
  rotateRefreshSession,
} from '../auth/sessions';
import { loadPrincipal } from '../auth/principal';
import { requirePrincipal } from '../auth/plugin';
import { makeAuthUser } from '../auth/session-user';
import {
  constructionObjectIdsExpr,
  departmentIdsExpr,
  departmentObjectIdsExpr,
  grantCodesExpr,
  grantPermissionsExpr,
  systemAddonsOf,
} from '../services/user-scopes';
import { enabledFeatures } from '../services/feature-flags';
import { assertEmailFree, asEmailConflict } from '../services/user-email';
import { assertMailEnabled, queueMail } from '../services/mail';
import {
  consumeEmailToken,
  issueEmailToken,
  lastIssuedAt,
  revokeEmailTokens,
} from '../services/email-tokens';
import {
  PASSWORD_CHANGED_SUBJECT,
  passwordChangedContent,
  passwordResetContent,
  RESET_SUBJECT,
  VERIFY_SUBJECT,
  verifyEmailContent,
} from '../services/mail-auth';

/**
 * Учётка вместе с типом её контрагента: права портал считает по паре «роль + тип» (ADR 0038),
 * поэтому вход и смена пароля отдают тип так же, как его отдаёт `loadPrincipal`.
 *
 * Карточка человека здесь по той же причине: у роли `driver` от её живости зависит, пускать ли
 * учётку вовсе (ADR 0102, Р2), и вход обязан отвечать то же, что ответит `loadPrincipal`
 * следующему запросу.
 */
function userWithCounterpartyType() {
  return db
    .select({
      u: users,
      counterpartyType: counterparties.type,
      personDeletedAt: persons.deletedAt,
      constructionObjectIds: constructionObjectIdsExpr,
      departmentIds: departmentIdsExpr,
      departmentObjectIds: departmentObjectIdsExpr,
      // Наборы вместо надстроек (ADR 0106, шаг 1c) — тем же выражением, что у принципала: вход
      // обязан отвечать то же, что ответит `loadPrincipal` следующему запросу.
      grantCodes: grantCodesExpr,
      // Права наборов — тем же выражением и по той же причине, что коды. Спрашиваются с шага
      // «сервер отдаёт эффективные права» (§10.1 плана): пометки рядом с ролью отвечают только за
      // два системных набора, а собранный администратором набор виден **исключительно** здесь —
      // без этого столбца вход и смена пароля посчитали бы права по обрезанному субъекту и ответили
      // бы не то, что ответит `/auth/me` следующим запросом.
      grantPermissions: grantPermissionsExpr,
    })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id))
    .leftJoin(persons, eq(users.personId, persons.id));
}

/** Защита cookie-эндпоинтов от CSRF: проверка Origin (при single-origin + SameSite=Strict). */
function assertCookieOrigin(req: FastifyRequest): void {
  if (!config.isProd) return;
  const origin = req.headers.origin;
  if (!origin || origin !== config.publicOrigin) {
    throw err.forbidden('Недопустимый источник запроса');
  }
}

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/**
 * Регистрация ограничена жёстче входа: она создаёт запись и работу администратору, а живой
 * человек заводит учётку один раз. Пять попыток за десять минут с адреса — это про цену самой
 * операции, а не про перебор чего-либо: перебирать в капче больше нечего, челлендж целиком у
 * Яндекса.
 *
 * Второй смысл лимита — страховка на то время, когда SmartCaptcha недоступна. Серверная проверка
 * тогда идёт fail-open (план `docs/smart-captcha-plan.md`, §7): пропускает всех, потому что без
 * ответа сервиса бот от жертвы сбоя не отличается. В этом окне лимит остаётся единственным, что
 * стоит между роботом и очередью заявок администратора.
 */
const registerRateLimit = { rateLimit: { max: 5, timeWindow: '10 minutes' } };

/**
 * Ручку настройки спрашивают один раз на открытие формы — обновлять там больше нечего. 20/мин
 * оставлены с запасом: за сессию человек проходит через несколько форм (вход, регистрация,
 * «забыли пароль»), а кеш ответа портал сбрасывает на каждом сбое и спрашивает заново (§7).
 */
const captchaRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

/**
 * Ручки, каждый вызов которых отправляет письмо на названный адрес. Ограничение жёстче обычного и
 * стоит на IP: письмо уходит не тому, кто просит, а владельцу ящика — и превратить портал в
 * рассыльщик по чужим адресам не должно получаться даже с разгаданной капчей.
 */
const mailRequestRateLimit = { rateLimit: { max: 5, timeWindow: '10 minutes' } };

/**
 * Одно письмо на учётку за пять минут. Второй уровень поверх лимита по IP: без него хватило бы
 * менять адрес выхода, чтобы завалить письмами один ящик.
 */
const RESEND_COOLDOWN_MS = 5 * 60_000;

async function throttledByAccount(userId: string, purpose: 'verify_email' | 'password_reset') {
  const last = await lastIssuedAt(userId, purpose);
  return last !== null && Date.now() - last.getTime() < RESEND_COOLDOWN_MS;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ctx = (req: FastifyRequest) => ({
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  /**
   * Клиентский ключ виджета SmartCaptcha. Своего челленджа портал больше не выдаёт: картинку,
   * подпись и одноразовость заменил внешний сервис, и с нашей стороны от ручки остался один ключ.
   *
   * Ключ отдаётся рантайм-ручкой, а не вшивается в бандл веба (план §3) по двум причинам. Первая:
   * смена ключа не требует пересборки фронта — обе переменные серверные и живут в `prod.env`.
   * Вторая, важнее: «включена ли капча» становится ОДНИМ решением сервера, общим и для формы, и
   * для проверки. Со вшитым в сборку ключом эти два решения разъезжаются молча — веб рисует
   * виджет, которого сервер не проверяет, или отправляет пустой токен туда, где его требуют.
   *
   * Пустая строка из конфигурации превращается здесь в `null`: в контракте (`CaptchaConfig`)
   * `null` — единственный признак «капча выключена», и отличать его от «поля в ответе нет» портал
   * обязан.
   */
  r.get('/captcha', { config: captchaRateLimit }, async (): Promise<CaptchaConfig> => {
    return { clientKey: config.captcha.clientKey || null };
  });

  r.post(
    '/register',
    { schema: { body: registerSchema }, config: registerRateLimit },
    async (req, reply) => {
      const {
        email,
        lastName,
        firstName,
        middleName,
        phone,
        password,
        requestedRole,
        requestedObject,
        requestedCompany,
        requestedComment,
        captchaToken,
      } = req.body;
      // Капча проверяется до всего остального — иначе `/register` работал бы справочником
      // «есть ли такой адрес в портале»: 409 на занятый email отличим от успеха. Порядок — часть
      // решения (ADR 0034, п. 10), и переход на SmartCaptcha его не отменяет: проверка стала
      // сетевой, но осталась первой.
      await verifyCaptcha(captchaToken, req.ip);
      // Регистрация без письма бессмысленна: подтвердить адрес будет нечем, а активировать
      // неподтверждённую заявку портал не даст. Отказ до записи, а не после — чтобы не заводить
      // учётку, которой не выбраться из состояния «ждёт подтверждения». С выключенным
      // подтверждением (EMAIL_VERIFICATION_ENABLED) письма нет и требовать почту не за что.
      if (EMAIL_VERIFICATION_ENABLED) assertMailEnabled();
      // Хеш считается до транзакции: argon2 занимает сотни миллисекунд, и держать на нём открытую
      // транзакцию незачем.
      const passwordHash = await hashPassword(password);
      let created;
      try {
        created = await db.transaction(async (tx) => {
          // Архивная учётка адрес не занимает (ADR 0063): отказ по заявке иначе закрывал бы
          // человеку повторную регистрацию навсегда.
          await assertEmailFree(tx, email);
          const [row] = await tx
            .insert(users)
            .values({
              email,
              lastName,
              firstName,
              middleName,
              // Телефон — по желанию (ADR 0043): пусто, если человек его не оставил.
              phone,
              passwordHash,
              isActive: false,
              // Роль не назначается: пожелание — подсказка администратору, а не право (ADR 0034).
              requestedRole,
              requestedObject,
              requestedCompany,
              requestedComment,
              // Подтверждение выключено (EMAIL_VERIFICATION_ENABLED): заявка сразу считается
              // подтверждённой. Иначе её нечем было бы активировать — и через неделю её закрыл бы
              // срок хранения неподтверждённых.
              emailVerifiedAt: EMAIL_VERIFICATION_ENABLED ? null : new Date(),
            })
            .returning({ id: users.id });

          // Токен и письмо — той же транзакцией (ADR 0072): заявка без письма оставила бы человека
          // ждать подтверждения, которое не придёт, а письмо без заявки вело бы в никуда.
          if (EMAIL_VERIFICATION_ENABLED) {
            const { token, expiresAt } = await issueEmailToken(
              {
                userId: row!.id,
                purpose: 'verify_email',
                ttlSeconds: config.mail.verifyTtl,
                requestedIp: req.ip,
              },
              { tx },
            );
            await queueMail(
              {
                kind: 'verify_email',
                // Метка выпуска, а не токен: ключ виден в журнале и в диагностике.
                dedupeKey: `verify:${row!.id}:${expiresAt.getTime()}`,
                to: email,
                subject: VERIFY_SUBJECT,
                content: verifyEmailContent(token),
                userId: row!.id,
                entityType: 'user',
                entityId: row!.id,
              },
              { tx },
            );
          }
          return row!;
        });
      } catch (e) {
        throw asEmailConflict(e);
      }
      await writeAudit({
        actorUserId: created!.id,
        action: 'user.register',
        entityType: 'user',
        entityId: created!.id,
        metadata: { requestedRole },
      });
      reply.code(201);
      return {
        ok: true,
        message: EMAIL_VERIFICATION_ENABLED
          ? 'Регистрация принята. Подтвердите адрес по ссылке из письма — после этого администратор сможет выдать доступ.'
          : 'Заявка на доступ принята. Администратор рассмотрит её и выдаст доступ.',
      };
    },
  );

  /**
   * Подтверждение адреса. Только POST: переход по ссылке из письма ничего не меняет сам по себе —
   * почтовые клиенты и антивирусы предварительно открывают ссылки, и GET-подтверждение срабатывало
   * бы до того, как письмо увидел человек.
   */
  r.post(
    '/verify-email',
    { schema: { body: verifyEmailSchema }, config: authRateLimit },
    async (req) => {
      const consumed = await db.transaction(async (tx) => {
        const row = await consumeEmailToken(req.body.token, 'verify_email', { tx });
        if (!row) return null;
        await tx
          .update(users)
          .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(users.id, row.userId), isNull(users.deletedAt)));
        return row;
      });
      // Одинаковый отказ для несуществующей, просроченной и уже использованной ссылки: какая из
      // них «почти подошла», знать незачем.
      if (!consumed) {
        throw err.badRequest('Ссылка недействительна или устарела — запросите письмо заново');
      }
      await writeAudit({
        actorUserId: consumed.userId,
        action: 'auth.email_verified',
        entityType: 'user',
        entityId: consumed.userId,
      });
      return { ok: true, message: 'Адрес подтверждён. Дождитесь активации администратором.' };
    },
  );

  /**
   * Повторная отправка письма подтверждения. Ответ нейтральный: по нему нельзя узнать, есть ли
   * такая заявка, подтверждена ли она и существует ли адрес в портале вообще.
   */
  r.post(
    '/verify-email/resend',
    { schema: { body: resendVerificationSchema }, config: mailRequestRateLimit },
    async (req, reply) => {
      const { email, captchaToken } = req.body;
      // Капча — первой, до базы и до письма (ADR 0034, п. 10): без неё один запрос отправлял бы
      // письмо на любой названный адрес, а нейтральный ответ всё равно выдавал бы задержкой, есть
      // такая заявка или нет.
      await verifyCaptcha(captchaToken, req.ip);
      // Подтверждение выключено (EMAIL_VERIFICATION_ENABLED): слать нечего. Ответ прежний
      // нейтральный — ручка и так не различает «адреса нет» и «письмо ушло», и портал, где кнопки
      // уже не осталось, ничего нового по нему не узнает.
      if (!EMAIL_VERIFICATION_ENABLED) {
        reply.code(202);
        return { ok: true, message: NEUTRAL_MAIL_RESPONSE };
      }
      assertMailEnabled();

      const [user] = await db
        .select({ id: users.id, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)));

      // Письмо уходит только неподтверждённой живой заявке. Во всех остальных случаях — тот же
      // ответ и никакого письма: подтверждённому адресу второе подтверждение не нужно, а частые
      // запросы по одной учётке отсекает пятиминутный интервал.
      if (user && !user.verifiedAt && !(await throttledByAccount(user.id, 'verify_email'))) {
        await db.transaction(async (tx) => {
          const { token, expiresAt } = await issueEmailToken(
            {
              userId: user.id,
              purpose: 'verify_email',
              ttlSeconds: config.mail.verifyTtl,
              requestedIp: req.ip,
            },
            { tx },
          );
          await queueMail(
            {
              kind: 'verify_email',
              dedupeKey: `verify:${user.id}:${expiresAt.getTime()}`,
              to: email,
              subject: VERIFY_SUBJECT,
              content: verifyEmailContent(token),
              userId: user.id,
              entityType: 'user',
              entityId: user.id,
            },
            { tx },
          );
        });
      }

      reply.code(202);
      return { ok: true, message: NEUTRAL_MAIL_RESPONSE };
    },
  );

  /**
   * «Забыли пароль?» — запрос ссылки. Пароль не генерируется и письмом не отправляется: ссылка
   * подтверждает владение ящиком, а новый пароль человек задаёт сам на странице портала.
   */
  r.post(
    '/password-reset/request',
    { schema: { body: passwordResetRequestSchema }, config: mailRequestRateLimit },
    async (req, reply) => {
      const { email, captchaToken } = req.body;
      // И здесь капча первая, по той же причине: до неё портал названный адрес не ищет и письмо в
      // очередь не ставит.
      await verifyCaptcha(captchaToken, req.ip);
      assertMailEnabled();

      const [user] = await db
        .select({ id: users.id, isActive: users.isActive, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)));

      // Восстанавливать нечего у заявки, которой ещё не выдали доступ, и у неподтверждённого
      // адреса: там сценарий другой — подтверждение регистрации.
      const eligible = user && user.isActive && user.verifiedAt;
      if (eligible && !(await throttledByAccount(user.id, 'password_reset'))) {
        await db.transaction(async (tx) => {
          const { token, expiresAt } = await issueEmailToken(
            {
              userId: user.id,
              purpose: 'password_reset',
              ttlSeconds: config.mail.resetTtl,
              requestedIp: req.ip,
            },
            { tx },
          );
          await queueMail(
            {
              kind: 'password_reset',
              dedupeKey: `reset:${user.id}:${expiresAt.getTime()}`,
              to: email,
              subject: RESET_SUBJECT,
              content: passwordResetContent(token),
              userId: user.id,
              entityType: 'user',
              entityId: user.id,
            },
            { tx },
          );
        });
        // След в журнале о том, что ссылка действительно ушла. Без него администратор, разбирая
        // «мне ничего не приходило», видит только состоявшуюся смену пароля — и не может отличить
        // «письмо не запрашивали» от «запросили, но не дошло».
        //
        // Нейтральность ответа это не нарушает: запись появляется только там, где письмо
        // поставлено, а сам журнал внутренний и виден лишь администратору. Наружу по-прежнему
        // уходит один и тот же 202 любому адресу.
        await writeAudit({
          actorUserId: user.id,
          action: 'auth.password_reset_requested',
          entityType: 'user',
          entityId: user.id,
        });
      }

      // Один ответ на все случаи: иначе форма работала бы справочником «кто зарегистрирован».
      reply.code(202);
      return { ok: true, message: NEUTRAL_MAIL_RESPONSE };
    },
  );

  /** Новый пароль по ссылке из письма. */
  r.post(
    '/password-reset/confirm',
    { schema: { body: passwordResetConfirmSchema }, config: authRateLimit },
    async (req) => {
      const { token, newPassword } = req.body;
      const passwordHash = await hashPassword(newPassword);

      const changed = await db.transaction(async (tx) => {
        const row = await consumeEmailToken(token, 'password_reset', { tx });
        if (!row) return null;
        const [user] = await tx
          .select({ id: users.id, email: users.email, authVersion: users.authVersion })
          .from(users)
          .where(and(eq(users.id, row.userId), isNull(users.deletedAt), eq(users.isActive, true)));
        if (!user) return null;

        await tx
          .update(users)
          .set({
            passwordHash,
            // Смена пароля снимает и требование сменить его: человек это только что сделал.
            mustChangePassword: false,
            // Версия растёт — выданные access-токены перестают действовать сразу, не дожидаясь
            // истечения: если пароль меняют из-за угона, ждать четверть часа нечего.
            authVersion: user.authVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
        // Остальные живые ссылки сброса гасятся: письмо, запрошенное дважды, не должно давать
        // вторую попытку смены после того, как пароль уже сменили.
        await revokeEmailTokens(user.id, 'password_reset', { tx });
        return user;
      });

      if (!changed) {
        throw err.badRequest(
          'Ссылка недействительна или устарела — запросите восстановление заново',
        );
      }

      // Сессии отзываются после фиксации: refresh-сессии живут своей транзакцией, и откат
      // основной не должен оставлять учётку без них.
      await revokeAllForUser(changed.id);
      await writeAudit({
        actorUserId: changed.id,
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: changed.id,
      });
      // Уведомление о состоявшейся смене: если пароль восстановил не владелец, это единственный
      // сигнал, который до него дойдёт.
      await queueMail({
        kind: 'password_changed',
        dedupeKey: `password-changed:${changed.id}:${Date.now()}`,
        to: changed.email,
        subject: PASSWORD_CHANGED_SUBJECT,
        content: passwordChangedContent(),
        userId: changed.id,
        entityType: 'user',
        entityId: changed.id,
      });

      return { ok: true, message: 'Пароль изменён. Войдите с новым паролем.' };
    },
  );

  r.post('/login', { schema: { body: loginSchema }, config: authRateLimit }, async (req, reply) => {
    const { email, password } = req.body;
    // Ищется действующая учётка: с частичным индексом (ADR 0063) одинаковых адресов в таблице
    // бывает несколько — живой и сколько угодно архивных, — и без фильтра вход мог бы выхватить
    // архивную строку и отказать живому человеку.
    const [row] = await userWithCounterpartyType().where(
      and(eq(users.email, email), isNull(users.deletedAt)),
    );
    const u = row
      ? {
          ...row.u,
          counterpartyType: row.counterpartyType,
          personDeletedAt: row.personDeletedAt,
          constructionObjectIds: row.constructionObjectIds,
          departmentIds: row.departmentIds,
          departmentObjectIds: row.departmentObjectIds,
          // Пометки рядом с ролью — производная от кодов наборов, как и у принципала: собранный
          // администратором набор в это поле не попадает (`systemAddonsOf`).
          addons: systemAddonsOf(row.grantCodes),
          // Сами коды — как есть, вместе с собранными администратором: по ним портал опознаёт
          // профиль модуля, а не считает права.
          grantCodes: row.grantCodes,
          // Граница «база → код» — здесь же, где у принципала: право-сироту дальше не пускает
          // `isPermission`, и в субъект уходит уже отфильтрованный список.
          grantPermissions: row.grantPermissions.filter(isPermission),
        }
      : undefined;
    if (!u) throw err.invalidCredentials();
    const ok = await verifyPassword(u.passwordHash, password);
    if (!ok) throw err.invalidCredentials();
    if (!u.isActive) {
      throw err.inactive('Аккаунт не активирован — обратитесь к администратору');
    }
    // Уволенный водитель не входит (ADR 0102, Р2): карточку закрыли, а учётку не трогали. Отказ
    // стоит здесь, а не только в `loadPrincipal`: иначе вход отвечал бы успехом и токеном, после
    // которого любой запрос кабинета получает 401, — а человек читал бы это как поломку портала.
    if (isPersonScopedRole(u.role) && (!u.personId || u.personDeletedAt)) {
      throw err.inactive(
        'Учётная запись водителя закрыта вместе с карточкой работника — обратитесь к администратору',
      );
    }

    const accessToken = await signAccessToken({ sub: u.id, role: u.role, av: u.authVersion });
    const refresh = await createRefreshSession(u.id, ctx(req));
    setRefreshCookie(reply, refresh.token, refresh.expiresAt);
    await writeAudit({
      actorUserId: u.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: u.id,
    });
    return {
      accessToken,
      expiresIn: config.auth.accessTtl,
      user: makeAuthUser(u, await enabledFeatures(db)),
    };
  });

  r.post('/refresh', { config: authRateLimit }, async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (!raw) throw err.unauthorized('Отсутствует refresh-токен');
    let rotated;
    try {
      rotated = await rotateRefreshSession(raw, ctx(req));
    } catch (e) {
      clearRefreshCookie(reply);
      throw e;
    }
    const principal = await loadPrincipal(rotated.userId);
    if (!principal) {
      clearRefreshCookie(reply);
      throw err.unauthorized('Сессия недействительна');
    }
    setRefreshCookie(reply, rotated.token, rotated.expiresAt);
    const accessToken = await signAccessToken({
      sub: principal.id,
      role: principal.role,
      av: principal.authVersion,
    });
    return {
      accessToken,
      expiresIn: config.auth.accessTtl,
      user: makeAuthUser(principal, await enabledFeatures(db)),
    };
  });

  r.post('/logout', async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (raw) await revokeRefreshByToken(raw);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  r.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    return makeAuthUser(requirePrincipal(req), await enabledFeatures(db));
  });

  r.post(
    '/change-password',
    {
      preHandler: [app.authenticate],
      schema: { body: changePasswordSchema },
      config: authRateLimit,
    },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { currentPassword, newPassword } = req.body;
      const [row] = await userWithCounterpartyType().where(eq(users.id, principal.id));
      if (!row) throw err.unauthorized();
      const u = {
        ...row.u,
        counterpartyType: row.counterpartyType,
        constructionObjectIds: row.constructionObjectIds,
        departmentIds: row.departmentIds,
        departmentObjectIds: row.departmentObjectIds,
        addons: systemAddonsOf(row.grantCodes),
        grantCodes: row.grantCodes,
        grantPermissions: row.grantPermissions.filter(isPermission),
      };
      const ok = await verifyPassword(u.passwordHash, currentPassword);
      if (!ok)
        throw err.badRequest('Текущий пароль неверен', { currentPassword: 'Неверный пароль' });

      const passwordHash = await hashPassword(newPassword);
      const newAuthVersion = u.authVersion + 1;
      await db
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          authVersion: newAuthVersion,
          updatedAt: new Date(),
        })
        .where(eq(users.id, u.id));
      await revokeAllForUser(u.id);

      // выдаём свежие токены, чтобы пользователь остался в системе
      const accessToken = await signAccessToken({ sub: u.id, role: u.role, av: newAuthVersion });
      const refresh = await createRefreshSession(u.id, ctx(req));
      setRefreshCookie(reply, refresh.token, refresh.expiresAt);
      await writeAudit({
        actorUserId: u.id,
        action: 'auth.password_change',
        entityType: 'user',
        entityId: u.id,
      });
      // Уведомление о смене — не подтверждение операции, а сигнал владельцу ящика: пароль сменил
      // тот, кто знал текущий, и если это не хозяин учётки, узнать об этом он может только так.
      // Почта выключена — операция всё равно состоялась: смена пароля от письма не зависит.
      if (config.mail.enabled) {
        await queueMail({
          kind: 'password_changed',
          dedupeKey: `password-changed:${u.id}:${Date.now()}`,
          to: u.email,
          subject: PASSWORD_CHANGED_SUBJECT,
          content: passwordChangedContent(),
          userId: u.id,
          entityType: 'user',
          entityId: u.id,
        });
      }
      return {
        accessToken,
        expiresIn: config.auth.accessTtl,
        user: makeAuthUser({ ...u, mustChangePassword: false }, await enabledFeatures(db)),
      };
    },
  );
}
