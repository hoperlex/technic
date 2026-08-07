import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type AuthUser,
  type CaptchaChallenge,
  changePasswordSchema,
  type CounterpartyType,
  EMAIL_VERIFICATION_ENABLED,
  loginSchema,
  NEUTRAL_MAIL_RESPONSE,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  resendVerificationSchema,
  type Role,
  verifyEmailSchema,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { counterparties, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../lib/cookies';
import { hashPassword, verifyPassword } from '../auth/password';
import { issueCaptcha, verifyCaptcha } from '../auth/captcha';
import { signAccessToken } from '../auth/tokens';
import {
  createRefreshSession,
  revokeAllForUser,
  revokeRefreshByToken,
  rotateRefreshSession,
} from '../auth/sessions';
import { loadPrincipal } from '../auth/principal';
import { requirePrincipal } from '../auth/plugin';
import {
  constructionObjectIdsExpr,
  departmentIdsExpr,
  departmentObjectIdsExpr,
} from '../services/user-scopes';
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

interface AuthUserSource {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  /** Объекты учётки (ADR 0039): по ним портал сужает фильтр объекта и подставляет его в форму. */
  constructionObjectIds: string[];
  /** Отделы учётки (ADR 0040): вторая ось области — вместо объектов, а не вместе с ними. */
  departmentIds: string[];
  /** Площадки отделов (ADR 0062): производная область роли отдела в модуле «Вывоз мусора». */
  departmentObjectIds: string[];
  /** Тип контрагента учётки (ADR 0038): вместе с ролью задаёт права — портал считает их сам. */
  counterpartyType: CounterpartyType | null;
}

function makeAuthUser(u: AuthUserSource): AuthUser {
  return {
    id: u.id,
    email: u.email,
    lastName: u.lastName,
    firstName: u.firstName,
    middleName: u.middleName,
    fullName: u.fullName,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    constructionObjectIds: u.constructionObjectIds,
    departmentIds: u.departmentIds,
    departmentObjectIds: u.departmentObjectIds,
    counterpartyType: u.counterpartyType,
  };
}

/**
 * Учётка вместе с типом её контрагента: права портал считает по паре «роль + тип» (ADR 0038),
 * поэтому вход и смена пароля отдают тип так же, как его отдаёт `loadPrincipal`.
 */
function userWithCounterpartyType() {
  return db
    .select({
      u: users,
      counterpartyType: counterparties.type,
      constructionObjectIds: constructionObjectIdsExpr,
      departmentIds: departmentIdsExpr,
      departmentObjectIds: departmentObjectIdsExpr,
    })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id));
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
 * человек заводит учётку один раз. Пять попыток за десять минут с адреса делают перебор кода
 * капчи (1 к 32 768 за попытку) бессмысленным.
 */
const registerRateLimit = { rateLimit: { max: 5, timeWindow: '10 minutes' } };

/** Выдача картинок щедрее: «обновить» нажимают несколько раз подряд, и это нормально. */
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

  r.get('/captcha', { config: captchaRateLimit }, async (): Promise<CaptchaChallenge> => {
    const { token, image, expiresIn } = issueCaptcha();
    return { token, image, expiresIn };
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
        captchaToken,
        captchaAnswer,
      } = req.body;
      // Капча проверяется до всего остального — иначе `/register` работал бы справочником
      // «есть ли такой адрес в портале»: 409 на занятый email отличим от успеха.
      verifyCaptcha(captchaToken, captchaAnswer);
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
      const { email, captchaToken, captchaAnswer } = req.body;
      verifyCaptcha(captchaToken, captchaAnswer);
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
      const { email, captchaToken, captchaAnswer } = req.body;
      verifyCaptcha(captchaToken, captchaAnswer);
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
          constructionObjectIds: row.constructionObjectIds,
          departmentIds: row.departmentIds,
          departmentObjectIds: row.departmentObjectIds,
        }
      : undefined;
    if (!u) throw err.invalidCredentials();
    const ok = await verifyPassword(u.passwordHash, password);
    if (!ok) throw err.invalidCredentials();
    if (!u.isActive) {
      throw err.inactive('Аккаунт не активирован — обратитесь к администратору');
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
    return { accessToken, expiresIn: config.auth.accessTtl, user: makeAuthUser(u) };
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
    return { accessToken, expiresIn: config.auth.accessTtl, user: makeAuthUser(principal) };
  });

  r.post('/logout', async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (raw) await revokeRefreshByToken(raw);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  r.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    return makeAuthUser(requirePrincipal(req));
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
        user: makeAuthUser({ ...u, mustChangePassword: false }),
      };
    },
  );
}
